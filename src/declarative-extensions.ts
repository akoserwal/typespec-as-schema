// Declarative Extension Applicator
//
// Reads structured patch declarations from extension template instances
// and applies them generically to ResourceDef[].
//
// Extension templates live in TypeSpec (e.g. rbac-v1-extensions.tsp,
// service-extensions.tsp). This emitter code is extension-agnostic:
// it knows how to parse patch-rule syntax (boolRelations, permission,
// public, accumulate, addField, addAnnotation) but has zero knowledge
// of specific extension patterns like workspace_permission or view_metadata.

import type { Program, Model, Type } from "@typespec/compiler";
import { isTemplateInstance, navigateProgram } from "@typespec/compiler";
import type { ResourceDef, RelationDef, RelationBody, V1Extension, ExtensionTemplate } from "./lib.js";
import {
  findExtensionTemplate,
  findAllExtensionTemplates,
  getNamespaceFQN,
  isInstanceOf,
  parsePermissionExpr,
} from "./lib.js";

const DISCOVER_DEBUG =
  typeof process !== "undefined" &&
  process.env &&
  (process.env.DISCOVER_DEBUG === "1" ||
    process.env.TYPESPEC_DISCOVER_DEBUG === "1");

function discoverDebugWarn(message: string, err?: unknown): void {
  if (!DISCOVER_DEBUG) return;
  if (err !== undefined) {
    console.warn(`[typespec-as-schema discover] ${message}`, err);
  } else {
    console.warn(`[typespec-as-schema discover] ${message}`);
  }
}

// ─── Errors ───────────────────────────────────────────────────────────

export class ExtensionPatchError extends Error {
  constructor(
    message: string,
    readonly context?: Record<string, string>,
  ) {
    super(message);
    this.name = "ExtensionPatchError";
  }
}

function failPatch(
  strict: boolean,
  message: string,
  ctx?: Record<string, string>,
): void {
  if (!strict) return;
  throw new ExtensionPatchError(message, ctx);
}

// ─── Declarative Extension Instance ──────────────────────────────────

export interface DeclaredExtension {
  templateName: string;
  params: Record<string, string>;
  patchRules: PatchRule[];
}

interface PatchRule {
  target: string;       // "role" | "roleBinding" | "workspace" | "jsonSchema"
  patchType: string;    // "boolRelations" | "permission" | "public" | "accumulate" | "addField"
  rawValue: string;     // template with {app}, {res}, {verb}, {v2} placeholders
}

/**
 * Frozen copy of patch-rule properties on `Kessel.V1WorkspacePermission` in
 * `lib/kessel-extensions.tsp`. Keep aligned when that template changes.
 */
export const V1_WORKSPACE_PERMISSION_TEMPLATE_RULES: readonly PatchRule[] = [
  {
    target: "role",
    patchType: "boolRelations",
    rawValue: "{app}_any_any,{app}_{res}_any,{app}_any_{verb},{app}_{res}_{verb}",
  },
  {
    target: "role",
    patchType: "permission",
    rawValue:
      "{v2}=any_any_any | {app}_any_any | {app}_{res}_any | {app}_any_{verb} | {app}_{res}_{verb}",
  },
  {
    target: "roleBinding",
    patchType: "permission",
    rawValue: "{v2}=subject & granted->{v2}",
  },
  {
    target: "workspace",
    patchType: "permission",
    rawValue: "{v2}=binding->{v2} | parent->{v2}",
  },
  { target: "workspace", patchType: "public", rawValue: "{v2}" },
  {
    target: "workspace",
    patchType: "accumulate",
    rawValue: "view_metadata=or({v2}),when={verb}==read,public=true",
  },
];

/** Build declarative extension instances from V1 triples (for tests and tooling without a TypeSpec Program). */
export function declaredExtensionsFromV1Extensions(
  exts: V1Extension[],
): DeclaredExtension[] {
  return exts.map((ext) => ({
    templateName: "V1WorkspacePermission",
    params: {
      application: ext.application,
      resource: ext.resource,
      verb: ext.verb,
      v2Perm: ext.v2Perm,
    },
    patchRules: [...V1_WORKSPACE_PERMISSION_TEMPLATE_RULES],
  }));
}

// ─── Accumulate Rule ─────────────────────────────────────────────────

interface AccumulateRule {
  name: string;         // target relation name (e.g., "view_metadata")
  op: string;           // merge operator (e.g., "or")
  ref: string;          // per-instance ref template (e.g., "{v2}")
  condition?: {         // optional gate (e.g., {verb}==read)
    param: string;      // param placeholder (e.g., "{verb}")
    value: string;      // required value (e.g., "read")
  };
  isPublic?: boolean;
}

export function parseAccumulateRule(raw: string): AccumulateRule | null {
  // Format: "name=op(ref),when=condition,public=bool"
  // Example: "view_metadata=or({v2}),when={verb}==read,public=true"
  const parts = raw.split(",").map((p) => p.trim());
  if (parts.length === 0) return null;

  // First part: name=op(ref)
  const defMatch = parts[0].match(/^(\w+)=(\w+)\(([^)]+)\)$/);
  if (!defMatch) return null;

  const rule: AccumulateRule = {
    name: defMatch[1],
    op: defMatch[2],
    ref: defMatch[3],
  };

  for (let i = 1; i < parts.length; i++) {
    const kv = parts[i];
    if (kv.startsWith("when=")) {
      const cond = kv.slice(5); // e.g., "{verb}==read"
      const eqIdx = cond.indexOf("==");
      if (eqIdx !== -1) {
        rule.condition = {
          param: cond.slice(0, eqIdx),
          value: cond.slice(eqIdx + 2),
        };
      }
    } else if (kv.startsWith("public=")) {
      rule.isPublic = kv.slice(7) === "true";
    }
  }

  return rule;
}

// ─── JSON Schema Field Rule ──────────────────────────────────────────

export interface JsonSchemaFieldRule {
  fieldName: string;
  fieldType: string;
  format?: string;
  required: boolean;
  /** Present when emitted from V1WorkspacePermission: limits Unified JSON Schema targets. */
  application?: string;
  /** Template `resource` param (e.g. hosts); used with application to narrow the model. */
  resource?: string;
}

export function parseJsonSchemaFieldRule(raw: string): JsonSchemaFieldRule | null {
  // Format: "name=type:format,required=bool"
  // Example: "inventory_host_view_id=string:uuid,required=true"
  const parts = raw.split(",").map((p) => p.trim());
  if (parts.length === 0) return null;

  // First part: name=type[:format]
  const defMatch = parts[0].match(/^([\w{}]+)=([\w]+)(?::([\w]+))?$/);
  if (!defMatch) return null;

  const rule: JsonSchemaFieldRule = {
    fieldName: defMatch[1],
    fieldType: defMatch[2],
    format: defMatch[3],
    required: false,
  };

  for (let i = 1; i < parts.length; i++) {
    if (parts[i].startsWith("required=")) {
      rule.required = parts[i].slice(9) === "true";
    }
  }

  return rule;
}

// ─── Discovery ───────────────────────────────────────────────────────

function getStringValue(t: Type): string | undefined {
  if ("value" in t && typeof (t as any).value === "string") {
    return (t as any).value;
  }
  if (t.kind === "Scalar" && t.name) return t.name;
  return undefined;
}

const KNOWN_PARAM_NAMES = ["application", "resource", "verb", "v2Perm", "key", "value"] as const;
const PATCH_TARGETS = ["role", "roleBinding", "workspace", "jsonSchema", "metadata", "self"] as const;

/**
 * Read `{target}_{patchType}` default string rules from the compiled
 * `V1WorkspacePermission` template (source: `lib/kessel-extensions.tsp`).
 * Used by tests to ensure {@link V1_WORKSPACE_PERMISSION_TEMPLATE_RULES} stays aligned.
 */
export function readDefaultPatchRulesFromTemplate(program: Program): PatchRule[] {
  const template = findExtensionTemplate(program, "V1WorkspacePermission");
  if (!template) return [];

  const rules: PatchRule[] = [];
  for (const [name, prop] of template.properties) {
    if ((KNOWN_PARAM_NAMES as readonly string[]).includes(name)) continue;

    const separatorIdx = name.indexOf("_");
    if (separatorIdx === -1) continue;

    const target = name.slice(0, separatorIdx);
    const patchType = name.slice(separatorIdx + 1);

    if (!(PATCH_TARGETS as readonly string[]).includes(target)) continue;

    const value = getStringValue(prop.type);
    if (!value) continue;

    rules.push({ target, patchType, rawValue: value });
  }

  return rules;
}

function patchRuleSortKey(r: PatchRule): string {
  return `${r.target}\0${r.patchType}\0${r.rawValue}`;
}

/** Stable-sort patch rules for equality comparisons. */
export function sortPatchRules(rules: readonly PatchRule[]): PatchRule[] {
  return [...rules].sort((a, b) =>
    patchRuleSortKey(a).localeCompare(patchRuleSortKey(b)),
  );
}

/** Extract params + patch rules from an extension template instance model. */
function declaredExtensionFromModel(model: Model, templateName: string): DeclaredExtension | null {
  const params: Record<string, string> = {};
  const patchRules: PatchRule[] = [];

  for (const [name, prop] of model.properties) {
    const value = getStringValue(prop.type);
    if (!value) continue;

    if ((KNOWN_PARAM_NAMES as readonly string[]).includes(name)) {
      params[name] = value;
      continue;
    }

    const separatorIdx = name.indexOf("_");
    if (separatorIdx === -1) continue;

    const target = name.slice(0, separatorIdx);
    const patchType = name.slice(separatorIdx + 1);

    if ((PATCH_TARGETS as readonly string[]).includes(target)) {
      patchRules.push({ target, patchType, rawValue: value });
    }
  }

  if (Object.keys(params).length === 0) {
    return null;
  }

  return { templateName, params, patchRules };
}

function pushDeclaredUnique(
  results: DeclaredExtension[],
  seen: Set<string>,
  decl: DeclaredExtension,
): void {
  const key = decl.params.v2Perm ?? JSON.stringify(decl.params);
  if (seen.has(key)) return;
  seen.add(key);
  results.push(decl);
}

/**
 * Generic discovery for all extension template instances in the program.
 * Finds instances via navigateProgram walk and top-level alias scan.
 * Dedupes by template name + params.
 */
export function discoverExtensionDeclarations(
  program: Program,
  templates?: ExtensionTemplate[],
): DeclaredExtension[] {
  const allTemplates = templates ?? findAllExtensionTemplates(program);
  if (allTemplates.length === 0) return [];

  const results: DeclaredExtension[] = [];
  const seen = new Set<string>();

  navigateProgram(program, {
    model(model: Model) {
      if (model.templateNode && !isTemplateInstance(model)) return;

      const modelNsFQN = getNamespaceFQN(model.namespace);
      if (modelNsFQN.endsWith("Kessel")) return;

      for (const tmpl of allTemplates) {
        if (!isInstanceOf(model, tmpl.model)) continue;
        const decl = declaredExtensionFromModel(model, tmpl.name);
        if (decl) pushDeclaredUnique(results, seen, decl);
        break;
      }
    },
  });

  for (const [, sourceFile] of program.sourceFiles) {
    for (const statement of sourceFile.statements) {
      if (!("value" in statement && "id" in statement)) continue;
      try {
        const aliasType = program.checker.getTypeForNode(statement);
        if (!aliasType || aliasType.kind !== "Model") continue;

        for (const tmpl of allTemplates) {
          if (!isInstanceOf(aliasType as Model, tmpl.model)) continue;
          const decl = declaredExtensionFromModel(aliasType as Model, tmpl.name);
          if (decl) pushDeclaredUnique(results, seen, decl);
          break;
        }
      } catch (err) {
        discoverDebugWarn("skipped source statement during alias scan", err);
      }
    }
  }

  return results;
}

/**
 * @deprecated Use discoverExtensionDeclarations(program) instead.
 * Kept for backward compatibility during migration.
 */
export function discoverV1WorkspacePermissionDeclarations(
  program: Program,
): DeclaredExtension[] {
  const template = findExtensionTemplate(program, "V1WorkspacePermission");
  if (!template) return [];
  return discoverExtensionDeclarations(program, [{ name: "V1WorkspacePermission", model: template }]);
}

/** Derive slim extension list for IR / metadata from unified declarations. */
export function v1ExtensionsFromDeclarations(
  declared: DeclaredExtension[],
): V1Extension[] {
  const out: V1Extension[] = [];
  for (const d of declared) {
    const { application, resource, verb, v2Perm } = d.params;
    if (application && resource && verb && v2Perm) {
      out.push({ application, resource, verb, v2Perm });
    }
  }
  return out;
}

// ─── Interpolation ───────────────────────────────────────────────────

const SHORTHAND_MAP: Record<string, string> = {
  app: "application",
  res: "resource",
  v2: "v2Perm",
};

function interpolate(template: string, params: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const resolved = SHORTHAND_MAP[key] ?? key;
    return params[resolved] ?? params[key] ?? "";
  });
}

// ─── Target Resolution ──────────────────────────────────────────────

const V1_TARGET_MAP: Record<string, string> = {
  role: "rbac/role",
  roleBinding: "rbac/role_binding",
  workspace: "rbac/workspace",
};

function resolveTarget(target: string): string | null {
  if (target === "jsonSchema" || target === "metadata" || target === "self") return target;
  return V1_TARGET_MAP[target] ?? target;
}

// ─── Patch Rule Parsing ──────────────────────────────────────────────

function parseBoolRelations(value: string): RelationDef[] {
  return value.split(",").map((name) => ({
    name: name.trim(),
    body: { kind: "bool" as const, target: "rbac/principal" },
  }));
}

function parsePermissionRule(value: string): RelationDef | null {
  const eqIdx = value.indexOf("=");
  if (eqIdx === -1) return null;

  const name = value.slice(0, eqIdx);
  const bodyExpr = value.slice(eqIdx + 1);
  const body = parsePermissionExpr(bodyExpr);
  if (!body) return null;

  return { name, body };
}

// ─── Result Types ────────────────────────────────────────────────────

export interface AnnotationEntry {
  key: string;
  value: string;
}

interface DeclaredPatchResult {
  resources: ResourceDef[];
  jsonSchemaFields: JsonSchemaFieldRule[];
  annotations: Map<string, AnnotationEntry[]>;
}

export interface ApplyDeclaredPatchesOptions {
  /** When true (default), unparseable patch rules throw ExtensionPatchError. */
  strict?: boolean;
}

// ─── Annotation Rule ─────────────────────────────────────────────────

export interface AnnotationRule {
  key: string;
  value: string;
}

export function parseAnnotationRule(raw: string): AnnotationRule | null {
  const eqIdx = raw.indexOf("=");
  if (eqIdx === -1) return null;
  const key = raw.slice(0, eqIdx).trim();
  const value = raw.slice(eqIdx + 1).trim();
  if (!key) return null;
  return { key, value };
}

// ─── Application ─────────────────────────────────────────────────────

function getOrCreateList<K, V>(map: Map<K, V[]>, key: K): V[] {
  let list = map.get(key);
  if (!list) {
    list = [];
    map.set(key, list);
  }
  return list;
}

function extensionLabel(ext: DeclaredExtension): string {
  return ext.params.v2Perm ?? ext.params.key ?? ext.templateName ?? "?";
}

export function applyDeclaredPatches(
  resources: ResourceDef[],
  extensions: DeclaredExtension[],
  options?: ApplyDeclaredPatchesOptions,
): DeclaredPatchResult {
  const strict = options?.strict !== false;

  const extraRelations = new Map<string, RelationDef[]>();
  const publicPerms = new Map<string, Set<string>>();
  const addedBoolPerms = new Set<string>();
  const accumulators = new Map<string, { rule: AccumulateRule; refs: string[] }>();
  const jsonSchemaFields: JsonSchemaFieldRule[] = [];
  const annotations = new Map<string, AnnotationEntry[]>();

  // ── Pass 1: Collect per-instance patches and accumulator contributions ──

  for (const ext of extensions) {
    for (const rule of ext.patchRules) {
      const value = interpolate(rule.rawValue, ext.params);
      const resolved = resolveTarget(rule.target);
      if (!resolved) continue;

      if (rule.patchType === "boolRelations") {
        const targetKey = resolved;
        const list = getOrCreateList(extraRelations, targetKey);
        for (const rel of parseBoolRelations(value)) {
          if (!addedBoolPerms.has(rel.name)) {
            addedBoolPerms.add(rel.name);
            list.push(rel);
          }
        }
      } else if (rule.patchType === "permission") {
        const rel = parsePermissionRule(value);
        if (!rel) {
          failPatch(
            strict,
            `Invalid permission patch rule for extension ${extensionLabel(ext)} (${rule.target}): ${JSON.stringify(value)}`,
            { extension: extensionLabel(ext), target: rule.target, raw: value },
          );
          continue;
        }

        const targetKey = resolved;
        const pubSet = publicPerms.get(targetKey);
        if (pubSet?.has(rel.name)) {
          rel.isPublic = true;
        }
        getOrCreateList(extraRelations, targetKey).push(rel);
      } else if (rule.patchType === "public") {
        const targetKey = resolved;
        if (!publicPerms.has(targetKey)) publicPerms.set(targetKey, new Set());
        publicPerms.get(targetKey)!.add(value);
      } else if (rule.patchType === "accumulate") {
        const parsed = parseAccumulateRule(rule.rawValue);
        if (!parsed) {
          failPatch(
            strict,
            `Invalid accumulate patch rule for extension ${extensionLabel(ext)} (${rule.target}): ${JSON.stringify(rule.rawValue)}`,
            { extension: extensionLabel(ext), target: rule.target, raw: rule.rawValue },
          );
          continue;
        }

        const key = `${resolved}/${parsed.name}`;
        if (!accumulators.has(key)) {
          accumulators.set(key, { rule: parsed, refs: [] });
        }

        const acc = accumulators.get(key)!;
        const ref = interpolate(parsed.ref, ext.params);

        if (parsed.condition) {
          const paramValue = interpolate(parsed.condition.param, ext.params);
          if (paramValue === parsed.condition.value) {
            acc.refs.push(ref);
          }
        } else {
          acc.refs.push(ref);
        }
      } else if (resolved === "jsonSchema" && rule.patchType === "addField") {
        const parsed = parseJsonSchemaFieldRule(value);
        if (!parsed) {
          failPatch(
            strict,
            `Invalid jsonSchema_addField rule for extension ${extensionLabel(ext)}: ${JSON.stringify(value)}`,
            { extension: extensionLabel(ext), raw: value },
          );
          continue;
        }
        const application = ext.params.application?.trim();
        if (!application) {
          failPatch(
            strict,
            `Extension ${extensionLabel(ext)} missing application param (required for jsonSchema_addField)`,
            { extension: extensionLabel(ext) },
          );
          continue;
        }
        const resource = ext.params.resource?.trim();
        jsonSchemaFields.push({
          ...parsed,
          application,
          ...(resource ? { resource } : {}),
        });
      } else if (resolved === "metadata" && rule.patchType === "addAnnotation") {
        const parsed = parseAnnotationRule(value);
        if (!parsed) {
          failPatch(
            strict,
            `Invalid metadata_addAnnotation rule for extension ${extensionLabel(ext)}: ${JSON.stringify(value)}`,
            { extension: extensionLabel(ext), raw: value },
          );
          continue;
        }
        const ns = ext.params.application?.trim();
        const res = ext.params.resource?.trim();
        if (ns && res) {
          const key = `${ns}/${res}`;
          getOrCreateList(annotations, key).push(parsed);
        }
      }
    }
  }

  // Apply public flag retroactively to already-collected relations
  for (const [targetKey, pubSet] of publicPerms) {
    const rels = extraRelations.get(targetKey);
    if (!rels) continue;
    for (const rel of rels) {
      if (pubSet.has(rel.name)) {
        rel.isPublic = true;
      }
    }
  }

  // ── Pass 2: Emit accumulated relations ──

  for (const [key, { rule, refs }] of accumulators) {
    if (refs.length === 0) continue;

    const slashIdx = key.lastIndexOf("/");
    const targetKey = key.slice(0, slashIdx);
    let body: RelationBody;

    if (rule.op === "or") {
      body = {
        kind: "or",
        members: refs.map((r) => ({ kind: "ref" as const, name: r })),
      };
    } else if (rule.op === "and") {
      body = {
        kind: "and",
        members: refs.map((r) => ({ kind: "ref" as const, name: r })),
      };
    } else {
      continue;
    }

    const rel: RelationDef = { name: rule.name, body, isPublic: rule.isPublic };
    getOrCreateList(extraRelations, targetKey).push(rel);
  }

  // ── Build enriched resources ──

  const result: ResourceDef[] = [];
  for (const res of resources) {
    const merged = { ...res, relations: [...res.relations] };
    const key = `${res.namespace}/${res.name}`;
    const extra = extraRelations.get(key);
    if (extra) {
      merged.relations.push(...extra);
    }
    result.push(merged);
  }

  if (!result.some((r) => r.name === "principal" && r.namespace === "rbac")) {
    result.unshift({ name: "principal", namespace: "rbac", relations: [] });
  }

  return { resources: result, jsonSchemaFields, annotations };
}
