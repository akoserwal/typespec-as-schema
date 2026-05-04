import * as fs from "fs";
import * as path from "path";
import { compile, NodeHost, type Program, type CompilerOptions } from "@typespec/compiler";
import type { ResourceDef, V1Extension, UnifiedJsonSchema, CascadeDeleteEntry, AnnotationEntry } from "./types.js";
import {
  discoverResources,
  discoverAnnotations,
  discoverInstances,
  type DiscoveryWarnings,
} from "./discover.js";
import { generateSpiceDB, generateUnifiedJsonSchemas } from "./generate.js";
import { EXTENSION_TEMPLATES } from "./registry.js";
import type { ExtensionHandler, ExpansionResult } from "./sdk.js";
import { cloneResources } from "./utils.js";
import {
  validateComplexityBudget,
  validatePreExpansionExpressions,
  validatePermissionExpressions,
  validateOutputSize,
  ExpansionTimeoutError,
  DEFAULT_LIMITS,
  type SafetyLimits,
  type ValidationDiagnostic,
} from "./safety.js";

export interface PipelineOptions {
  limits?: Partial<SafetyLimits>;
  /** When true, also runs the @typespec/json-schema emitter during compilation. */
  emitJsonSchema?: boolean;
  /** Output directory for emitters (defaults to tsp-output next to the main file). */
  outputDir?: string;
  /** Override the directory to scan for extension handler .ts files. */
  extensionsDir?: string;
}

export interface PipelineResult {
  resources: ResourceDef[];
  extensions: V1Extension[];
  annotations: Map<string, AnnotationEntry[]>;
  cascadePolicies: CascadeDeleteEntry[];
  fullSchema: ResourceDef[];
  spicedbOutput: string;
  unifiedJsonSchemas: Record<string, UnifiedJsonSchema>;
  diagnostics: ValidationDiagnostic[];
  warnings: string[];
}

// ─── Extension handler discovery ────────────────────────────────────

async function loadExtensionHandlers(extensionsDir: string): Promise<ExtensionHandler[]> {
  if (!fs.existsSync(extensionsDir)) return [];

  const files = fs.readdirSync(extensionsDir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts") && !f.endsWith(".test.ts"))
    .sort();

  const handlers: ExtensionHandler[] = [];

  for (const file of files) {
    const fullPath = path.resolve(extensionsDir, file);
    try {
      const mod = await import(fullPath);
      const handler: ExtensionHandler | undefined = mod.default ?? mod.handler;
      if (handler && typeof handler.expand === "function" && handler.templateName) {
        handlers.push(handler);
      }
    } catch {
      // Skip files that fail to load — they may be non-handler utilities
    }
  }

  return handlers;
}

// ─── Pipeline ───────────────────────────────────────────────────────

/**
 * Compiles a TypeSpec schema and runs the full discovery/validation/expansion
 * pipeline. This is the single source of truth for the pipeline — both the CLI
 * and tests call this function.
 *
 * Extension handlers are auto-discovered from schema/extensions/ (relative to
 * the main .tsp file) and executed in sorted filename order.
 */
export async function compilePipeline(
  mainFile: string,
  options?: PipelineOptions,
): Promise<PipelineResult> {
  const limits: SafetyLimits = { ...DEFAULT_LIMITS, ...options?.limits };

  const compilerOpts: CompilerOptions = { noEmit: true };
  if (options?.emitJsonSchema) {
    compilerOpts.noEmit = false;
    compilerOpts.emit = ["@typespec/json-schema"];
    if (options.outputDir) {
      compilerOpts.outputDir = options.outputDir;
    }
  }

  const program: Program = await compile(NodeHost, mainFile, compilerOpts);
  const hasErrors = program.diagnostics.some((d) => d.severity === "error");
  if (hasErrors) {
    const msgs = program.diagnostics.filter((d) => d.severity === "error").map((d) => d.message);
    throw new Error(`Compilation failed:\n${msgs.join("\n")}`);
  }

  const warnings: string[] = [];
  const discoveryWarnings: DiscoveryWarnings = {
    skipped: [],
    stats: { aliasesAttempted: 0, aliasesResolved: 0, resourcesFound: 0, extensionsFound: 0 },
  };

  const { resources } = discoverResources(program);
  discoveryWarnings.stats.resourcesFound = resources.length;

  // Annotations are platform-owned metadata — always discovered by the platform.
  const annotations = discoverAnnotations(program, discoveryWarnings);

  // Discover extension handlers from schema/extensions/
  const schemaDir = path.dirname(path.resolve(mainFile));
  const extensionsDir = options?.extensionsDir ?? path.resolve(schemaDir, "extensions");
  const handlers = await loadExtensionHandlers(extensionsDir);

  let fullSchema: ResourceDef[];
  let extensions: V1Extension[] = [];
  let cascadePolicies: CascadeDeleteEntry[] = [];

  // Handler-based expansion: discover all instances first, validate,
  // then expand each handler in sequence.
  const handlerWork: {
    handler: ExtensionHandler;
    instances: Record<string, string>[];
  }[] = [];

  for (const handler of handlers) {
    const templateDef = EXTENSION_TEMPLATES.find(
      (t) => t.templateName === handler.templateName,
    );
    if (!templateDef) {
      warnings.push(
        `Extension handler "${handler.name}" references unknown template "${handler.templateName}" — skipped.`,
      );
      continue;
    }

    const { results: instances, skipped, aliasesAttempted, aliasesResolved } =
      discoverInstances(program, templateDef);

    discoveryWarnings.skipped.push(...skipped);
    discoveryWarnings.stats.aliasesAttempted += aliasesAttempted;
    discoveryWarnings.stats.aliasesResolved += aliasesResolved;
    discoveryWarnings.stats.extensionsFound += instances.length;

    handlerWork.push({ handler, instances });

    if (handler.templateName === "V1WorkspacePermission") {
      extensions = instances
        .filter((p) => !!(p.application && p.resource && p.verb && p.v2Perm))
        .map((p) => ({
          application: p.application,
          resource: p.resource,
          verb: p.verb as V1Extension["verb"],
          v2Perm: p.v2Perm,
        }));
    } else if (handler.templateName === "CascadeDeletePolicy") {
      cascadePolicies = instances
        .filter((p) => !!(p.childApplication && p.childResource && p.parentRelation))
        .map((p) => ({
          childApplication: p.childApplication,
          childResource: p.childResource,
          parentRelation: p.parentRelation,
        }));
    }
  }

  const knownNamespaces = new Set(resources.map((r) => r.namespace));
  for (const perm of extensions) {
    if (!knownNamespaces.has(perm.application)) {
      warnings.push(`extension application "${perm.application}" has no matching resource namespace`);
    }
  }

  validateComplexityBudget(extensions, limits);

  let running = cloneResources(resources);
  for (const { handler, instances } of handlerWork) {
    const expansionStart = performance.now();
    const { resources: expanded, warnings: handlerWarnings } = handler.expand(running, instances);
    const expansionElapsed = performance.now() - expansionStart;

    if (expansionElapsed > limits.expansionTimeoutMs) {
      throw new ExpansionTimeoutError(Math.round(expansionElapsed), limits.expansionTimeoutMs);
    }

    running = expanded;
    warnings.push(...handlerWarnings);
  }

  fullSchema = running;

  warnings.push(...discoveryWarnings.skipped);
  const { stats } = discoveryWarnings;
  if (discoveryWarnings.skipped.length > 0) {
    warnings.push(
      `Alias resolution: ${stats.aliasesResolved}/${stats.aliasesAttempted} resolved, ` +
      `${stats.aliasesAttempted - stats.aliasesResolved} skipped`,
    );
  }

  const preExpansionDiags = validatePreExpansionExpressions(resources);
  if (preExpansionDiags.length > 0) {
    for (const d of preExpansionDiags) {
      warnings.push(`Pre-expansion: ${d.resource}.${d.relation}: ${d.message}`);
    }
  }

  const diagnostics = validatePermissionExpressions(fullSchema);
  const spicedbOutput = generateSpiceDB(fullSchema);

  const outputSizeResult = validateOutputSize(spicedbOutput, limits);
  if (outputSizeResult.warning) {
    warnings.push(outputSizeResult.warning);
  }

  const unifiedJsonSchemas = generateUnifiedJsonSchemas(fullSchema);

  return {
    resources,
    extensions,
    annotations,
    cascadePolicies,
    fullSchema,
    spicedbOutput,
    unifiedJsonSchemas,
    diagnostics,
    warnings,
  };
}
