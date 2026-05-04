// Cascade Delete Policy Extension — SERVICE-OWNED
//
// This file is owned by the service team. It defines how
// CascadeDeletePolicy template instances are expanded into SpiceDB
// permissions that gate child-resource deletion on the parent's
// delete permission.
//
// To modify the cascade logic, edit this file directly. The platform
// SDK provides the primitives; this file controls the wiring.

import type { ExtensionHandler, ExpansionResult } from "../../src/sdk.js";
import {
  addRelation,
  hasRelation,
  ref,
  subref,
  or,
  and,
  resolveRBACScaffold,
  cloneResources,
  slotName,
  RBAC_RELATIONS,
} from "../../src/sdk.js";
import type { ResourceDef } from "../../src/types.js";

const handler: ExtensionHandler = {
  name: "CascadeDeletePolicy",
  templateName: "CascadeDeletePolicy",

  expand(baseResources: ResourceDef[], instances: Record<string, string>[]): ExpansionResult {
    const policies = instances.filter(
      (p) => !!(p.childApplication && p.childResource && p.parentRelation),
    );

    if (policies.length === 0) {
      return { resources: cloneResources(baseResources), warnings: [] };
    }

    const resources = cloneResources(baseResources);
    const warnings: string[] = [];

    const { scaffold } = resolveRBACScaffold(resources);
    if (scaffold) {
      const { role, roleBinding, workspace } = scaffold;

      if (!hasRelation(role, "delete")) {
        addRelation(role, {
          name: "delete",
          body: ref(RBAC_RELATIONS.globalWildcard),
        });
      }

      if (!hasRelation(roleBinding, "delete")) {
        addRelation(roleBinding, {
          name: "delete",
          body: and(ref(RBAC_RELATIONS.subject), subref(RBAC_RELATIONS.granted, "delete")),
        });
      }

      if (!hasRelation(workspace, "delete")) {
        addRelation(workspace, {
          name: "delete",
          body: or(subref(RBAC_RELATIONS.binding, "delete"), subref(RBAC_RELATIONS.parent, "delete")),
        });
      }
    }

    for (const policy of policies) {
      const nsPrefix = policy.childApplication.toLowerCase();
      const childName = policy.childResource.toLowerCase();
      const child = resources.find((r) => r.name === childName && r.namespace === nsPrefix);
      if (!child) continue;

      if (hasRelation(child, "delete")) continue;

      addRelation(child, {
        name: "delete",
        body: { kind: "subref", name: slotName(policy.parentRelation), subname: "delete" },
      });
    }

    return { resources, warnings };
  },
};

export default handler;
