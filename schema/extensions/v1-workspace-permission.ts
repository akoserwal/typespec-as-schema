import type { ExtensionHandler, ExpansionResult } from "../../src/sdk.js";
import {
  addRelation,
  addBoolRelation,
  getRelation,
  replaceBody,
  ref,
  subref,
  or,
  and,
  resolveRBACScaffold,
  cloneResources,
  RBAC_RELATIONS,
} from "../../src/sdk.js";
import type { ResourceDef } from "../../src/types.js";

const VALID_VERBS = new Set(["read", "write", "create", "delete"]);

const handler: ExtensionHandler = {
  name: "V1WorkspacePermission",
  templateName: "V1WorkspacePermission",

  expand(baseResources: ResourceDef[], instances: Record<string, string>[]): ExpansionResult {
    const permissions = instances.filter(
      (p) => !!(p.application && p.resource && p.verb && p.v2Perm) && VALID_VERBS.has(p.verb),
    );

    const resources = cloneResources(baseResources);

    if (!resources.some((r) => r.name === "principal" && r.namespace === "rbac")) {
      resources.unshift({ name: "principal", namespace: "rbac", relations: [] });
    }

    const { scaffold, warnings } = resolveRBACScaffold(resources);
    if (!scaffold) return { resources, warnings };

    const { role, roleBinding, workspace } = scaffold;

    for (const perm of permissions) {
      const { application: app, resource: res, verb, v2Perm: v2 } = perm;

      addBoolRelation(role, `${app}_any_any`);
      addBoolRelation(role, `${app}_${res}_any`);
      addBoolRelation(role, `${app}_any_${verb}`);
      addBoolRelation(role, `${app}_${res}_${verb}`);

      addRelation(role, {
        name: v2,
        body: or(
          ref(RBAC_RELATIONS.globalWildcard),
          ref(`${app}_any_any`),
          ref(`${app}_${res}_any`),
          ref(`${app}_any_${verb}`),
          ref(`${app}_${res}_${verb}`),
        ),
      });

      addRelation(roleBinding, {
        name: v2,
        body: and(ref(RBAC_RELATIONS.subject), subref(RBAC_RELATIONS.granted, v2)),
      });

      addRelation(workspace, {
        name: v2,
        body: or(subref(RBAC_RELATIONS.binding, v2), subref(RBAC_RELATIONS.parent, v2)),
      });

      if (verb === "read") {
        const existing = getRelation(workspace, "view_metadata");
        if (existing) {
          replaceBody(workspace, "view_metadata", (body) => or(body, ref(v2)));
        } else {
          addRelation(workspace, { name: "view_metadata", body: ref(v2) });
        }
      }
    }

    return { resources, warnings };
  },
};

export default handler;
