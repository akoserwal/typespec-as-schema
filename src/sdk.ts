// Extension SDK — platform primitives for service-owned extension logic.
//
// Service teams import these functions to build custom schema expansions.
// This is the API surface between the platform (pipeline, emitters) and
// service-owned extension handlers in schema/extensions/.

import type { ResourceDef, RelationDef, RelationBody, RBACScaffold } from "./types.js";
import { slotName, findResource } from "./utils.js";

export { slotName, findResource, cloneResources } from "./utils.js";


export interface ExpansionResult {
  resources: ResourceDef[];
  warnings: string[];
}

export interface ExtensionHandler {
  name: string;
  templateName: string;
  expand(resources: ResourceDef[], instances: Record<string, string>[]): ExpansionResult;
}

export function addRelation(resource: ResourceDef, rel: RelationDef): void {
  resource.relations.push(rel);
}

export function addBoolRelation(resource: ResourceDef, name: string): RelationDef {
  return getOrAddRelation(resource, name, () => ({
    name,
    body: { kind: "bool", target: "rbac/principal" },
  }));
}

export function getRelation(resource: ResourceDef, name: string): RelationDef | undefined {
  return resource.relations.find((r) => r.name === name);
}

export function hasRelation(resource: ResourceDef, name: string): boolean {
  return resource.relations.some((r) => r.name === name);
}

export type BodyMutator = (body: RelationBody) => RelationBody;

export function replaceBody(resource: ResourceDef, name: string, mutator: BodyMutator): boolean {
  const rel = resource.relations.find((r) => r.name === name);
  if (!rel) return false;
  rel.body = mutator(rel.body);
  return true;
}

export function getOrAddRelation(
  resource: ResourceDef,
  name: string,
  factory: () => RelationDef,
): RelationDef {
  const existing = resource.relations.find((r) => r.name === name);
  if (existing) return existing;
  const rel = factory();
  resource.relations.push(rel);
  return rel;
}

export function ref(name: string): RelationBody {
  return { kind: "ref", name };
}

/** Creates a sub-reference with automatic `t_` slot-name wrapping. */
export function subref(name: string, subname: string): RelationBody {
  return { kind: "subref", name: slotName(name), subname };
}

export function or(...members: RelationBody[]): RelationBody {
  return { kind: "or", members };
}

export function and(...members: RelationBody[]): RelationBody {
  return { kind: "and", members };
}

export interface ScaffoldResult {
  scaffold: RBACScaffold | null;
  warnings: string[];
}

export const RBAC_RELATIONS = {
  subject: "subject",
  granted: "granted",
  binding: "binding",
  parent: "parent",
  globalWildcard: "any_any_any",
} as const;

export function resolveRBACScaffold(resources: ResourceDef[]): ScaffoldResult {
  const role = findResource(resources, "rbac", "role");
  const roleBinding = findResource(resources, "rbac", "role_binding");
  const workspace = findResource(resources, "rbac", "workspace");

  if (!role || !roleBinding || !workspace) {
    const missing = [
      !role && "rbac/role",
      !roleBinding && "rbac/role_binding",
      !workspace && "rbac/workspace",
    ].filter(Boolean);
    return {
      scaffold: null,
      warnings: [
        `RBAC scaffold incomplete — missing ${missing.join(", ")}. V1 permission expansion skipped.`,
      ],
    };
  }

  return { scaffold: { role, roleBinding, workspace }, warnings: [] };
}
