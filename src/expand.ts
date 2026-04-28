// V1 Permission Expansion
//
// Explicit expansion of V1WorkspacePermission declarations into SpiceDB
// relations on Role, RoleBinding, and Workspace. Also discovers
// ResourceAnnotation declarations for IR metadata.

import type { Program, Model, Type } from "@typespec/compiler";
import { navigateProgram, isTemplateInstance } from "@typespec/compiler";
import type { ResourceDef, RelationDef, RelationBody, V1Extension } from "./lib.js";
import { findExtensionTemplate, isInstanceOf, getNamespaceFQN } from "./lib.js";

// ─── Discovery ──────────────────────────────────────────────────────

function getStringValue(t: Type): string | undefined {
  if ("value" in t && typeof (t as any).value === "string") {
    return (t as any).value;
  }
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

function discoverInstances(
  program: Program,
  templateName: string,
  paramNames: string[],
): Record<string, string>[] {
  const template = findExtensionTemplate(program, templateName);
  if (!template) return [];

  const results: Record<string, string>[] = [];
  const seen = new Set<string>();

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

  for (const [, sourceFile] of program.sourceFiles) {
    for (const statement of sourceFile.statements) {
      if (!("value" in statement && "id" in statement)) continue;
      try {
        const aliasType = program.checker.getTypeForNode(statement);
        if (!aliasType || aliasType.kind !== "Model") continue;
        addUnique(aliasType as Model);
      } catch {
        // skip unresolvable statements
      }
    }
  }

  return results;
}

export function discoverV1Permissions(program: Program): V1Extension[] {
  return discoverInstances(program, "V1WorkspacePermission", [
    "application", "resource", "verb", "v2Perm",
  ]).filter(
    (p) => p.application && p.resource && p.verb && p.v2Perm,
  ) as V1Extension[];
}

export interface AnnotationEntry {
  key: string;
  value: string;
}

export function discoverAnnotations(
  program: Program,
): Map<string, AnnotationEntry[]> {
  const raw = discoverInstances(program, "ResourceAnnotation", [
    "application", "resource", "key", "value",
  ]);

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

// ─── Expansion ──────────────────────────────────────────────────────

function findResource(resources: ResourceDef[], ns: string, name: string): ResourceDef | undefined {
  return resources.find((r) => r.namespace === ns && r.name === name);
}

function addRelation(resource: ResourceDef, rel: RelationDef): void {
  resource.relations.push(rel);
}

function addBoolRelation(resource: ResourceDef, name: string, seen: Set<string>): void {
  if (seen.has(name)) return;
  seen.add(name);
  addRelation(resource, {
    name,
    body: { kind: "bool", target: "rbac/principal" },
  });
}

function ref(name: string): RelationBody {
  return { kind: "ref", name };
}

function subref(name: string, subname: string): RelationBody {
  return { kind: "subref", name: `t_${name}`, subname };
}

function or(...members: RelationBody[]): RelationBody {
  return { kind: "or", members };
}

function and(...members: RelationBody[]): RelationBody {
  return { kind: "and", members };
}

/**
 * Expands V1WorkspacePermission declarations into SpiceDB relations.
 * This is the core function — explicit, no string parsing, no interpolation.
 */
export function expandV1Permissions(
  baseResources: ResourceDef[],
  permissions: V1Extension[],
): ResourceDef[] {
  const resources = baseResources.map((r) => ({
    ...r,
    relations: [...r.relations],
  }));

  // Ensure rbac/principal exists
  if (!resources.some((r) => r.name === "principal" && r.namespace === "rbac")) {
    resources.unshift({ name: "principal", namespace: "rbac", relations: [] });
  }

  const role = findResource(resources, "rbac", "role");
  const roleBinding = findResource(resources, "rbac", "role_binding");
  const workspace = findResource(resources, "rbac", "workspace");

  if (!role || !roleBinding || !workspace) return resources;

  const addedBoolRelations = new Set<string>();
  // Seed with existing bool relations on role
  for (const rel of role.relations) {
    if (rel.body.kind === "bool") addedBoolRelations.add(rel.name);
  }

  const viewMetadataRefs: string[] = [];

  for (const perm of permissions) {
    const { application: app, resource: res, verb, v2Perm: v2 } = perm;

    // 1. Role: add 4 bool relations for the permission hierarchy
    addBoolRelation(role, `${app}_any_any`, addedBoolRelations);
    addBoolRelation(role, `${app}_${res}_any`, addedBoolRelations);
    addBoolRelation(role, `${app}_any_${verb}`, addedBoolRelations);
    addBoolRelation(role, `${app}_${res}_${verb}`, addedBoolRelations);

    // 2. Role: add computed permission as union of hierarchy
    addRelation(role, {
      name: v2,
      body: or(
        ref("any_any_any"),
        ref(`${app}_any_any`),
        ref(`${app}_${res}_any`),
        ref(`${app}_any_${verb}`),
        ref(`${app}_${res}_${verb}`),
      ),
    });

    // 3. RoleBinding: add intersection permission
    addRelation(roleBinding, {
      name: v2,
      body: and(ref("subject"), subref("granted", v2)),
    });

    // 4. Workspace: add union permission from bindings + parent
    addRelation(workspace, {
      name: v2,
      body: or(subref("binding", v2), subref("parent", v2)),
    });

    // 5. Accumulate read-verb permissions for view_metadata
    if (verb === "read") {
      viewMetadataRefs.push(v2);
    }
  }

  // Emit accumulated view_metadata
  if (viewMetadataRefs.length > 0) {
    addRelation(workspace, {
      name: "view_metadata",
      body: or(...viewMetadataRefs.map((r) => ref(r))),
    });
  }

  return resources;
}
