// Discovery — all AST walking and template instance enumeration.
//
// Resource discovery (service models) and extension instance discovery
// (V1WorkspacePermission, ResourceAnnotation, CascadeDeletePolicy) live here.
// Expansion logic (RBAC mutations) lives in expand.ts.

import {
  navigateProgram,
  isTemplateInstance,
  type Program,
  type Model,
  type Namespace,
  type Type,
} from "@typespec/compiler";
import type { RelationDef, ResourceDef, V1Extension, KesselVerb, CascadeDeleteEntry, AnnotationEntry } from "./types.js";
import { getNamespaceFQN, camelToSnake } from "./utils.js";
import { parsePermissionExpr } from "./parser.js";
import { EXTENSION_TEMPLATES, type ExtensionTemplateDef } from "./registry.js";

// ─── Type helpers ────────────────────────────────────────────────────

function isKesselType(model: Model, expectedName: string): boolean {
  return model.name === expectedName && getNamespaceFQN(model.namespace).endsWith("Kessel");
}

function getTemplateArg(model: Model, index: number): Type | undefined {
  if (!isTemplateInstance(model)) return undefined;
  return model.templateMapper?.args?.[index] as Type | undefined;
}

function getEnumMemberName(t: Type | undefined): string | undefined {
  if (!t) return undefined;
  if (t.kind === "EnumMember") return t.name;
  if (hasTypeProperty(t) && t.type.kind === "EnumMember") {
    return t.type.name;
  }
  return undefined;
}

function hasTypeProperty(t: Type): t is Type & { type: Type } {
  if (!("type" in t)) return false;
  const val = (t as unknown as Record<string, unknown>)["type"];
  return typeof val === "object" && val !== null;
}

function resolveTargetName(t: Type | undefined): string {
  if (!t) return "unknown";
  if (t.kind === "Model") {
    const ns = getNamespaceFQN(t.namespace)?.toLowerCase() || "";
    return ns ? `${ns}/${camelToSnake(t.name)}` : camelToSnake(t.name);
  }
  return "unknown";
}

// ─── String value extraction (for template instance params) ──────────

function hasStringValue(t: Type): t is Type & { value: string } {
  return "value" in t && typeof (t as unknown as Record<string, unknown>).value === "string";
}

function getStringValue(t: Type): string | undefined {
  if (hasStringValue(t)) return t.value;
  if (t.kind === "Scalar" && t.name) return t.name;
  return undefined;
}

function extractParams(model: Model, names: string[]): Record<string, string> {
  const params: Record<string, string> = {};
  for (const name of names) {
    const prop = model.properties.get(name);
    if (prop) {
      const value = getStringValue(prop.type);
      if (value) params[name] = value;
    }
  }
  return params;
}

// ─── Extension template lookup ───────────────────────────────────────

/** Find an extension template by name, optionally scoped to a namespace suffix. */
export function findExtensionTemplate(
  program: Program,
  templateName: string,
  namespace?: string,
): Model | null {
  const globalNs = program.getGlobalNamespaceType();
  function search(ns: Namespace): Model | null {
    for (const [, model] of ns.models) {
      if (model.name === templateName &&
          (!namespace || getNamespaceFQN(ns).endsWith(namespace))) {
        return model;
      }
    }
    for (const [, childNs] of ns.namespaces) {
      const found = search(childNs);
      if (found) return found;
    }
    return null;
  }
  return search(globalNs);
}

export function isInstanceOf(model: Model, template: Model): boolean {
  if (!isTemplateInstance(model)) return false;
  if (model.sourceModel === template) return true;
  if (model.templateNode === template.node) return true;
  if (
    model.name === template.name &&
    getNamespaceFQN(model.namespace) === getNamespaceFQN(template.namespace)
  ) {
    return true;
  }
  return false;
}

// ─── Extension instance discovery ────────────────────────────────────

export interface DiscoverInstancesResult {
  results: Record<string, string>[];
  skipped: string[];
  aliasesAttempted: number;
  aliasesResolved: number;
}

export function discoverInstances(
  program: Program,
  def: ExtensionTemplateDef,
): DiscoverInstancesResult {
  const { templateName, paramNames, namespace } = def;
  const template = findExtensionTemplate(program, templateName, namespace);
  if (!template) return { results: [], skipped: [], aliasesAttempted: 0, aliasesResolved: 0 };

  const results: Record<string, string>[] = [];
  const seen = new Set<string>();
  const skipped: string[] = [];

  function addUnique(model: Model): void {
    if (!isInstanceOf(model, template!)) return;
    const params = extractParams(model, paramNames);
    if (Object.keys(params).length === 0) return;
    const key = JSON.stringify(params);
    if (seen.has(key)) return;
    seen.add(key);
    results.push(params);
  }

  navigateProgram(program, {
    model(model: Model) {
      if (model.templateNode && !isTemplateInstance(model)) return;
      if (getNamespaceFQN(model.namespace).endsWith("Kessel")) return;
      addUnique(model);
    },
  });

  let aliasesAttempted = 0;
  let aliasesResolved = 0;

  for (const [, sourceFile] of program.sourceFiles) {
    for (const statement of sourceFile.statements) {
      if (!("value" in statement && "id" in statement)) continue;
      aliasesAttempted++;
      try {
        const aliasType = program.checker.getTypeForNode(statement);
        if (!aliasType || aliasType.kind !== "Model") continue;
        aliasesResolved++;
        addUnique(aliasType as Model);
      } catch (e: unknown) {
        // Best-effort: swallow TypeSpec compiler resolution errors (e.g. "cannot resolve",
        // "not found") so discovery continues for other statements. The regex is fragile —
        // if @typespec/compiler changes error wording, this will re-throw instead of skipping.
        // That's the safe direction: unexpected errors surface rather than hide.
        if (e instanceof Error && /cannot|not found|resolve/i.test(e.message)) {
          skipped.push(`Skipped statement in ${templateName} discovery: ${e.message}`);
          continue;
        }
        throw e;
      }
    }
  }

  return { results, skipped, aliasesAttempted, aliasesResolved };
}

function getTemplate(name: string): ExtensionTemplateDef {
  const def = EXTENSION_TEMPLATES.find(t => t.templateName === name);
  if (!def) throw new Error(`Unknown extension template: ${name}`);
  return def;
}

export const VALID_VERBS = new Set<KesselVerb>(["read", "write", "create", "delete"]);

function isKesselVerb(v: string): v is KesselVerb {
  return VALID_VERBS.has(v as KesselVerb);
}

export interface DiscoveryStats {
  aliasesAttempted: number;
  aliasesResolved: number;
  resourcesFound: number;
  extensionsFound: number;
}

export interface DiscoveryWarnings {
  skipped: string[];
  stats: DiscoveryStats;
}

export function discoverV1Permissions(program: Program, warnings?: DiscoveryWarnings): V1Extension[] {
  const def = getTemplate("V1WorkspacePermission");
  const { results, skipped, aliasesAttempted, aliasesResolved } = discoverInstances(program, def);
  if (warnings) {
    warnings.skipped.push(...skipped);
    warnings.stats.aliasesAttempted += aliasesAttempted;
    warnings.stats.aliasesResolved += aliasesResolved;
  }
  const extensions = results
    .filter(
      (p) => !!(p.application && p.resource && p.verb && p.v2Perm) && isKesselVerb(p.verb),
    )
    .map((p) => ({
      application: p.application,
      resource: p.resource,
      verb: p.verb as KesselVerb,
      v2Perm: p.v2Perm,
    }));
  if (warnings) warnings.stats.extensionsFound += extensions.length;
  return extensions;
}

export function discoverAnnotations(
  program: Program,
  warnings?: DiscoveryWarnings,
): Map<string, AnnotationEntry[]> {
  const def = getTemplate("ResourceAnnotation");
  const { results: raw, skipped, aliasesAttempted, aliasesResolved } = discoverInstances(program, def);
  if (warnings) {
    warnings.skipped.push(...skipped);
    warnings.stats.aliasesAttempted += aliasesAttempted;
    warnings.stats.aliasesResolved += aliasesResolved;
  }

  const annotations = new Map<string, AnnotationEntry[]>();
  for (const params of raw) {
    if (!params.application || !params.resource || !params.key) continue;
    const resourceKey = `${params.application}/${params.resource}`;
    let list = annotations.get(resourceKey);
    if (!list) {
      list = [];
      annotations.set(resourceKey, list);
    }
    list.push({ key: params.key, value: params.value ?? "" });
  }
  return annotations;
}

export function discoverCascadeDeletePolicies(
  program: Program,
  warnings?: DiscoveryWarnings,
): CascadeDeleteEntry[] {
  const def = getTemplate("CascadeDeletePolicy");
  const { results, skipped, aliasesAttempted, aliasesResolved } = discoverInstances(program, def);
  if (warnings) {
    warnings.skipped.push(...skipped);
    warnings.stats.aliasesAttempted += aliasesAttempted;
    warnings.stats.aliasesResolved += aliasesResolved;
  }
  return results.filter(
    (p): p is Record<string, string> & CascadeDeleteEntry =>
      !!(p.childApplication && p.childResource && p.parentRelation),
  );
}

// ─── Resource discovery ─────────────────────────────────────────────

function modelToResource(
  model: Model,
  nsPrefix: string
): ResourceDef | null {
  const relations: RelationDef[] = [];
  let hasRelations = false;

  for (const [name, prop] of model.properties) {
    if (name === "data") continue;

    const propType = prop.type;
    if (propType.kind !== "Model") continue;

    if (isKesselType(propType, "Assignable")) {
      hasRelations = true;
      const targetArg = getTemplateArg(propType, 0);
      const cardArg = getTemplateArg(propType, 1);
      const target = resolveTargetName(targetArg);
      const cardinality = getEnumMemberName(cardArg) ?? "Any";
      relations.push({
        name,
        body: { kind: "assignable", target, cardinality },
      });
    } else if (isKesselType(propType, "BoolRelation")) {
      hasRelations = true;
      const targetArg = getTemplateArg(propType, 0);
      const target = resolveTargetName(targetArg);
      relations.push({
        name,
        body: { kind: "bool", target },
      });
    } else if (isKesselType(propType, "Permission")) {
      hasRelations = true;
      const exprProp = propType.properties.get("__expr");
      let expr = "";
      if (exprProp) {
        const exprType = exprProp.type;
        if (exprType.kind === "Scalar" && exprType.name) {
          expr = exprType.name;
        } else if ("value" in exprType) {
          expr = String((exprType as unknown as Record<string, unknown>).value);
        }
      }
      const parsed = parsePermissionExpr(expr);
      if (parsed) {
        relations.push({ name, body: parsed });
      }
    }
  }

  if (!hasRelations) return null;

  const nsName = nsPrefix.toLowerCase().replace(/\./g, "/");
  return {
    name: camelToSnake(model.name),
    namespace: nsName || getNamespaceFQN(model.namespace)?.toLowerCase() || "unknown",
    relations,
  };
}

export function discoverResources(program: Program): {
  resources: ResourceDef[];
} {
  const resources: ResourceDef[] = [];
  const seenResources = new Set<string>();

  const extensionTemplates = EXTENSION_TEMPLATES
    .map((def) => findExtensionTemplate(program, def.templateName, def.namespace))
    .filter((m): m is Model => m !== null);

  navigateProgram(program, {
    model(model: Model) {
      if (model.templateNode && !isTemplateInstance(model)) return;

      const modelNsFQN = getNamespaceFQN(model.namespace);
      if (modelNsFQN.endsWith("Kessel")) return;

      if (extensionTemplates.some((t) => isInstanceOf(model, t))) {
        return;
      }

      if (model.name.endsWith("Data")) return;
      if (!model.name || model.name === "") return;

      const nsPrefix = modelNsFQN;
      const key = `${nsPrefix}/${model.name}`;
      if (seenResources.has(key)) return;

      const resource = modelToResource(model, nsPrefix);
      if (resource) {
        seenResources.add(key);
        resources.push(resource);
      }
    },
  });

  resources.sort((a, b) => {
    const ns = a.namespace.localeCompare(b.namespace);
    return ns !== 0 ? ns : a.name.localeCompare(b.name);
  });

  return { resources };
}
