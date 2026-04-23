import {
  compile,
  NodeHost,
  navigateProgram,
  type Program,
  type Model,
  type Namespace,
  type Type,
  isTemplateInstance,
} from "@typespec/compiler";
import * as path from "path";

export interface RelationDef {
  name: string;
  body: RelationBody;
  isPublic?: boolean;
}

export type RelationBody =
  | { kind: "assignable"; target: string; cardinality: string }
  | { kind: "bool"; target: string }
  | { kind: "ref"; name: string }
  | { kind: "subref"; name: string; subname: string }
  | { kind: "or"; members: RelationBody[] }
  | { kind: "and"; members: RelationBody[] };

export interface ResourceDef {
  name: string;
  namespace: string;
  relations: RelationDef[];
}

export function getNamespaceFQN(ns: Namespace | undefined): string {
  if (!ns) return "";
  const parts: string[] = [];
  let current: Namespace | undefined = ns;
  while (current && current.name) {
    parts.unshift(current.name);
    current = current.namespace;
  }
  return parts.join(".");
}

export function camelToSnake(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

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
  // Template args may be wrapped in a Value object with a .type property
  if ("type" in t && (t as any).type?.kind === "EnumMember") {
    return (t as any).type.name;
  }
  return undefined;
}

export interface V1Extension {
  application: string;
  resource: string;
  verb: string;
  v2Perm: string;
}

/**
 * Discovers service resource models only. Extension template instances are
 * handled by `discoverExtensionDeclarations` in declarative-extensions.ts
 * (single source for IR metadata and patch application).
 */
export function discoverResources(program: Program): {
  resources: ResourceDef[];
} {
  const resources: ResourceDef[] = [];
  const seenResources = new Set<string>();

  const extensionTemplates = findAllExtensionTemplates(program);

  navigateProgram(program, {
    model(model: Model) {
      if (model.templateNode && !isTemplateInstance(model)) return;

      const modelNsFQN = getNamespaceFQN(model.namespace);
      if (modelNsFQN.endsWith("Kessel")) return;

      if (extensionTemplates.some((t) => isInstanceOf(model, t.model))) {
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

  return { resources };
}

export interface ExtensionTemplate {
  name: string;
  model: Model;
}

/** Find a single extension template by name in the Kessel namespace. */
export function findExtensionTemplate(program: Program, templateName: string): Model | null {
  const globalNs = program.getGlobalNamespaceType();
  function search(ns: Namespace): Model | null {
    for (const [, model] of ns.models) {
      if (model.name === templateName) return model;
    }
    for (const [, childNs] of ns.namespaces) {
      const found = search(childNs);
      if (found) return found;
    }
    return null;
  }
  return search(globalNs);
}

/** @deprecated Use findExtensionTemplate(program, "V1WorkspacePermission") instead. */
export function findV1PermissionTemplate(program: Program): Model | null {
  return findExtensionTemplate(program, "V1WorkspacePermission");
}

const PATCH_TARGET_NAMES = ["role", "roleBinding", "workspace", "jsonSchema", "metadata", "self"] as const;

/**
 * Discover all extension templates in the Kessel namespace.
 * A model qualifies if it lives under Kessel and has properties matching
 * the `{target}_{patchType}` convention.
 */
export function findAllExtensionTemplates(program: Program): ExtensionTemplate[] {
  const results: ExtensionTemplate[] = [];
  const globalNs = program.getGlobalNamespaceType();

  function search(ns: Namespace): void {
    if (!getNamespaceFQN(ns).endsWith("Kessel") && ns.name !== "Kessel") {
      for (const [, childNs] of ns.namespaces) {
        search(childNs);
      }
      return;
    }

    for (const [, model] of ns.models) {
      if (hasExtensionShapedProperties(model)) {
        results.push({ name: model.name, model });
      }
    }
    for (const [, childNs] of ns.namespaces) {
      search(childNs);
    }
  }

  search(globalNs);
  return results;
}

function hasExtensionShapedProperties(model: Model): boolean {
  for (const [name] of model.properties) {
    const sepIdx = name.indexOf("_");
    if (sepIdx === -1) continue;
    const target = name.slice(0, sepIdx);
    if ((PATCH_TARGET_NAMES as readonly string[]).includes(target)) {
      return true;
    }
  }
  return false;
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
          expr = String((exprType as any).value);
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

function resolveTargetName(t: Type | undefined): string {
  if (!t) return "unknown";
  if (t.kind === "Model") {
    const ns = getNamespaceFQN(t.namespace)?.toLowerCase() || "";
    return ns ? `${ns}/${camelToSnake(t.name)}` : camelToSnake(t.name);
  }
  return "unknown";
}

export function parsePermissionExpr(expr: string): RelationBody | null {
  if (!expr) return null;

  if (expr.includes(".") && !expr.includes(" ")) {
    const [name, subname] = expr.split(".");
    return { kind: "subref", name: `t_${name}`, subname };
  }

  if (expr.includes(" | ") || expr.includes(" + ")) {
    const sep = expr.includes(" | ") ? " | " : " + ";
    const members = expr.split(sep).map((m) => m.trim());
    return {
      kind: "or",
      members: members.map((m) => {
        if (m.includes("->")) {
          const [name, subname] = m.split("->");
          return { kind: "subref" as const, name: `t_${name}`, subname };
        }
        return { kind: "ref" as const, name: m };
      }),
    };
  }

  if (expr.includes(" & ")) {
    const members = expr.split(" & ").map((m) => m.trim());
    return {
      kind: "and",
      members: members.map((m) => {
        if (m.includes("->")) {
          const [name, subname] = m.split("->");
          return { kind: "subref" as const, name: `t_${name}`, subname };
        }
        return { kind: "ref" as const, name: m };
      }),
    };
  }

  return { kind: "ref", name: expr };
}

export function bodyToZed(body: RelationBody): string {
  switch (body.kind) {
    case "assignable":
      return `${body.target}`;
    case "bool":
      return `${body.target}:*`;
    case "ref":
      return body.name;
    case "subref":
      return `${body.name}->${body.subname}`;
    case "or":
      return body.members.map(bodyToZed).join(" + ");
    case "and": {
      const inner = body.members.map(bodyToZed).join(" & ");
      return `(${inner})`;
    }
  }
}

function isAssignable(body: RelationBody): boolean {
  return body.kind === "assignable" || body.kind === "bool";
}

export function generateSpiceDB(resources: ResourceDef[]): string {
  const lines: string[] = [];

  for (const res of resources) {
    lines.push(`definition ${res.namespace}/${res.name} {`);

    const assignables = res.relations.filter((r) => isAssignable(r.body));
    const computed = res.relations.filter((r) => !isAssignable(r.body));

    const permLines: string[] = [];
    const relLines: string[] = [];

    for (const rel of assignables) {
      const tName = `t_${rel.name}`;
      relLines.push(`    relation ${tName}: ${bodyToZed(rel.body)}`);
      permLines.push(`    permission ${rel.name} = ${tName}`);
    }

    for (const perm of computed) {
      permLines.push(`    permission ${perm.name} = ${bodyToZed(perm.body)}`);
    }

    for (const p of permLines) lines.push(p);
    if (permLines.length > 0 && relLines.length > 0) lines.push("");
    for (const r of relLines) lines.push(r);

    lines.push("}");
    lines.push("");
  }

  return lines.join("\n");
}

export interface UnifiedJsonSchema {
  $schema: string;
  $id: string;
  type: string;
  properties: Record<string, { type: string; format?: string; source?: string }>;
  required: string[];
}

export interface JsonSchemaExtraField {
  fieldName: string;
  fieldType: string;
  format?: string;
  required: boolean;
  /** When set, only attach to resources in this namespace (lowercase). Omit = all non-rbac (legacy). */
  application?: string;
  /** Template `resource` param; narrows when several models share a namespace. */
  resource?: string;
}

/**
 * Match TypeSpec model name (e.g. Host) to V1WorkspacePermission `resource` (e.g. hosts).
 */
export function extensionResourceMatchesModel(
  modelName: string,
  resourceSlug: string | undefined,
): boolean {
  if (resourceSlug == null || resourceSlug === "") return true;
  const m = modelName.toLowerCase();
  const s = resourceSlug.toLowerCase();
  if (m === s) return true;
  if (s.length > 1 && s.endsWith("s") && m === s.slice(0, -1)) return true;
  if (m.length > 1 && m.endsWith("s") && s === m.slice(0, -1)) return true;
  return false;
}

export function generateUnifiedJsonSchemas(
  resources: ResourceDef[],
  extraFields?: JsonSchemaExtraField[],
): Record<string, UnifiedJsonSchema> {
  const schemas: Record<string, UnifiedJsonSchema> = {};

  for (const res of resources) {
    if (res.namespace === "rbac") continue;

    const schema: UnifiedJsonSchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: `${res.namespace}/${res.name}`,
      type: "object",
      properties: {},
      required: [],
    };

    let hasContent = false;

    for (const rel of res.relations) {
      if (
        rel.body.kind === "assignable" &&
        rel.body.cardinality === "ExactlyOne"
      ) {
        const idField = `${rel.name}_id`;
        schema.properties[idField] = {
          type: "string",
          format: "uuid",
          source: `relation ${rel.name}: ${rel.body.target} [ExactlyOne]`,
        };
        schema.required.push(idField);
        hasContent = true;
      }
    }

    if (extraFields) {
      for (const field of extraFields) {
        if (
          field.application != null &&
          field.application !== res.namespace
        ) {
          continue;
        }
        if (!extensionResourceMatchesModel(res.name, field.resource)) {
          continue;
        }
        if (schema.properties[field.fieldName] != null) {
          throw new Error(
            `Unified JSON Schema: duplicate property "${field.fieldName}" on ${res.namespace}/${res.name}`,
          );
        }
        const prop: { type: string; format?: string; source?: string } = {
          type: field.fieldType,
          source: "extension-declared",
        };
        if (field.format) prop.format = field.format;
        schema.properties[field.fieldName] = prop;
        if (field.required) schema.required.push(field.fieldName);
        hasContent = true;
      }
    }

    if (hasContent) {
      schemas[`${res.namespace}/${res.name}`] = schema;
    }
  }

  return schemas;
}

interface ServiceMetadata {
  permissions: string[];
  resources: string[];
}

export function generateMetadata(
  resources: ResourceDef[],
  extensions: V1Extension[]
): Record<string, ServiceMetadata> {
  const metadata: Record<string, ServiceMetadata> = {};

  for (const ext of extensions) {
    if (!metadata[ext.application]) {
      metadata[ext.application] = { permissions: [], resources: [] };
    }
    metadata[ext.application].permissions.push(ext.v2Perm);
  }

  for (const res of resources) {
    if (res.namespace === "rbac") continue;
    const ns = res.namespace.split("/").pop() || res.namespace;
    if (!metadata[ns]) {
      metadata[ns] = { permissions: [], resources: [] };
    }
    metadata[ns].resources.push(res.name);
  }

  return metadata;
}

interface IntermediateRepresentation {
  version: string;
  generatedAt: string;
  source: string;
  resources: ResourceDef[];
  extensions: V1Extension[];
  spicedb: string;
  metadata: Record<string, ServiceMetadata>;
  jsonSchemas: Record<string, UnifiedJsonSchema>;
  annotations?: Record<string, Record<string, string>>;
}

export function generateIR(
  mainFile: string,
  fullSchema: ResourceDef[],
  extensions: V1Extension[],
  jsonSchemaFields: JsonSchemaExtraField[] = [],
  annotations?: Map<string, { key: string; value: string }[]>,
): IntermediateRepresentation {
  const ir: IntermediateRepresentation = {
    version: "1.2.0",
    generatedAt: new Date().toISOString(),
    source: mainFile,
    resources: fullSchema,
    extensions,
    spicedb: generateSpiceDB(fullSchema),
    metadata: generateMetadata(fullSchema, extensions),
    jsonSchemas: generateUnifiedJsonSchemas(fullSchema, jsonSchemaFields),
  };

  if (annotations && annotations.size > 0) {
    const out: Record<string, Record<string, string>> = {};
    for (const [resourceKey, entries] of annotations) {
      const obj: Record<string, string> = {};
      for (const e of entries) {
        obj[e.key] = e.value;
      }
      out[resourceKey] = obj;
    }
    ir.annotations = out;
  }

  return ir;
}

export { compile, NodeHost, path };
