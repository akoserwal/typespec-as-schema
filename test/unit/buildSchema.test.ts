import { describe, it, expect } from "vitest";
import {
  type ResourceDef,
  type V1Extension,
  type RelationBody,
} from "../../src/lib.js";
import { expandV1Permissions } from "../../src/expand.js";

function makeBaseRbacResources(): ResourceDef[] {
  return [
    { name: "principal", namespace: "rbac", relations: [] },
    {
      name: "role",
      namespace: "rbac",
      relations: [
        { name: "any_any_any", body: { kind: "bool", target: "rbac/principal" } },
      ],
    },
    {
      name: "role_binding",
      namespace: "rbac",
      relations: [
        { name: "subject", body: { kind: "assignable", target: "rbac/principal", cardinality: "Any" } },
        { name: "granted", body: { kind: "assignable", target: "rbac/role", cardinality: "Any" } },
      ],
    },
    {
      name: "workspace",
      namespace: "rbac",
      relations: [
        { name: "parent", body: { kind: "assignable", target: "rbac/workspace", cardinality: "AtMostOne" } },
        { name: "binding", body: { kind: "assignable", target: "rbac/role_binding", cardinality: "Any" } },
      ],
    },
  ];
}

const inventoryViewExt: V1Extension = {
  application: "inventory",
  resource: "hosts",
  verb: "read",
  v2Perm: "inventory_host_view",
};

const inventoryUpdateExt: V1Extension = {
  application: "inventory",
  resource: "hosts",
  verb: "write",
  v2Perm: "inventory_host_update",
};

const remediationsViewExt: V1Extension = {
  application: "remediations",
  resource: "remediations",
  verb: "read",
  v2Perm: "remediations_remediation_view",
};

const remediationsUpdateExt: V1Extension = {
  application: "remediations",
  resource: "remediations",
  verb: "write",
  v2Perm: "remediations_remediation_update",
};

function findResource(resources: ResourceDef[], ns: string, name: string): ResourceDef | undefined {
  return resources.find((r) => r.namespace === ns && r.name === name);
}

function findRelation(resource: ResourceDef, name: string) {
  return resource.relations.find((r) => r.name === name);
}

describe("V1 workspace permission expansion (expandV1Permissions)", () => {
  describe("Role wildcard relations", () => {
    it("adds four wildcard bool relations per extension to role", () => {
      const result = expandV1Permissions(makeBaseRbacResources(), [inventoryViewExt]);
      const role = findResource(result, "rbac", "role")!;

      const wildcards = ["inventory_any_any", "inventory_hosts_any", "inventory_any_read", "inventory_hosts_read"];
      for (const wc of wildcards) {
        const rel = findRelation(role, wc);
        expect(rel, `missing wildcard relation ${wc}`).toBeDefined();
        expect(rel!.body.kind).toBe("bool");
        expect((rel!.body as { target: string }).target).toBe("rbac/principal");
      }
    });

    it("adds computed v2 permission on role ORing wildcards and any_any_any", () => {
      const result = expandV1Permissions(makeBaseRbacResources(), [inventoryViewExt]);
      const role = findResource(result, "rbac", "role")!;
      const perm = findRelation(role, "inventory_host_view");
      expect(perm).toBeDefined();
      expect(perm!.body.kind).toBe("or");

      const members = (perm!.body as { members: RelationBody[] }).members;
      const names = members.map((m) => (m as { name: string }).name);
      expect(names).toContain("any_any_any");
      expect(names).toContain("inventory_any_any");
      expect(names).toContain("inventory_hosts_any");
      expect(names).toContain("inventory_any_read");
      expect(names).toContain("inventory_hosts_read");
    });

    it("uses 'any' naming for wildcards, not 'all'", () => {
      const result = expandV1Permissions(makeBaseRbacResources(), [inventoryViewExt]);
      const role = findResource(result, "rbac", "role")!;
      const relNames = role.relations.map((r) => r.name);
      expect(relNames).not.toContain("inventory_all_all");
      expect(relNames).toContain("inventory_any_any");
    });
  });

  describe("RoleBinding intersection permissions", () => {
    it("adds intersection permission: subject & t_granted->v2Perm", () => {
      const result = expandV1Permissions(makeBaseRbacResources(), [inventoryViewExt]);
      const rb = findResource(result, "rbac", "role_binding")!;
      const perm = findRelation(rb, "inventory_host_view");
      expect(perm).toBeDefined();
      expect(perm!.body.kind).toBe("and");

      const members = (perm!.body as { members: RelationBody[] }).members;
      expect(members[0]).toEqual({ kind: "ref", name: "subject" });
      expect(members[1]).toEqual({ kind: "subref", name: "t_granted", subname: "inventory_host_view" });
    });
  });

  describe("Workspace union permissions", () => {
    it("adds union permission: t_binding->v2Perm + t_parent->v2Perm", () => {
      const result = expandV1Permissions(makeBaseRbacResources(), [inventoryViewExt]);
      const ws = findResource(result, "rbac", "workspace")!;
      const perm = findRelation(ws, "inventory_host_view");
      expect(perm).toBeDefined();
      expect(perm!.body.kind).toBe("or");

      const members = (perm!.body as { members: RelationBody[] }).members;
      expect(members[0]).toEqual({ kind: "subref", name: "t_binding", subname: "inventory_host_view" });
      expect(members[1]).toEqual({ kind: "subref", name: "t_parent", subname: "inventory_host_view" });
    });

    it("uses 'binding' naming, not 'user_grant'", () => {
      const result = expandV1Permissions(makeBaseRbacResources(), [inventoryViewExt]);
      const ws = findResource(result, "rbac", "workspace")!;
      const relNames = ws.relations.map((r) => r.name);
      expect(relNames).toContain("binding");
      expect(relNames).not.toContain("user_grant");
    });
  });

  describe("view_metadata accumulation", () => {
    it("generates view_metadata on workspace from read-verb extensions only", () => {
      const extensions = [inventoryViewExt, inventoryUpdateExt, remediationsViewExt, remediationsUpdateExt];
      const result = expandV1Permissions(makeBaseRbacResources(), extensions);
      const ws = findResource(result, "rbac", "workspace")!;
      const viewMeta = findRelation(ws, "view_metadata");

      expect(viewMeta).toBeDefined();
      expect(viewMeta!.body.kind).toBe("or");

      const members = (viewMeta!.body as { members: RelationBody[] }).members;
      const names = members.map((m) => (m as { name: string }).name);
      expect(names).toContain("inventory_host_view");
      expect(names).toContain("remediations_remediation_view");
      expect(names).not.toContain("inventory_host_update");
      expect(names).not.toContain("remediations_remediation_update");
    });

    it("does not generate view_metadata when no read-verb extensions exist", () => {
      const result = expandV1Permissions(makeBaseRbacResources(), [inventoryUpdateExt]);
      const ws = findResource(result, "rbac", "workspace")!;
      const viewMeta = findRelation(ws, "view_metadata");
      expect(viewMeta).toBeUndefined();
    });
  });

  describe("G4: Cooperative extensions — idempotency", () => {
    it("does not produce duplicate wildcard relations when extensions share an application", () => {
      const extensions = [inventoryViewExt, inventoryUpdateExt];
      const result = expandV1Permissions(makeBaseRbacResources(), extensions);
      const role = findResource(result, "rbac", "role")!;

      const appAdminCount = role.relations.filter((r) => r.name === "inventory_any_any").length;
      expect(appAdminCount).toBe(1);

      const hostsAnyCount = role.relations.filter((r) => r.name === "inventory_hosts_any").length;
      expect(hostsAnyCount).toBe(1);
    });
  });

  describe("Multi-service expansion", () => {
    it("expands both inventory and remediations extensions onto RBAC types", () => {
      const extensions = [inventoryViewExt, inventoryUpdateExt, remediationsViewExt, remediationsUpdateExt];
      const result = expandV1Permissions(makeBaseRbacResources(), extensions);

      const role = findResource(result, "rbac", "role")!;
      expect(findRelation(role, "inventory_host_view")).toBeDefined();
      expect(findRelation(role, "inventory_host_update")).toBeDefined();
      expect(findRelation(role, "remediations_remediation_view")).toBeDefined();
      expect(findRelation(role, "remediations_remediation_update")).toBeDefined();

      const rb = findResource(result, "rbac", "role_binding")!;
      expect(findRelation(rb, "inventory_host_view")).toBeDefined();
      expect(findRelation(rb, "remediations_remediation_view")).toBeDefined();

      const ws = findResource(result, "rbac", "workspace")!;
      expect(findRelation(ws, "inventory_host_view")).toBeDefined();
      expect(findRelation(ws, "remediations_remediation_view")).toBeDefined();
      expect(findRelation(ws, "view_metadata")).toBeDefined();
    });
  });

  describe("Principal auto-creation", () => {
    it("auto-creates rbac/principal if not in input resources", () => {
      const resources: ResourceDef[] = [
        {
          name: "role",
          namespace: "rbac",
          relations: [
            { name: "any_any_any", body: { kind: "bool", target: "rbac/principal" } },
          ],
        },
      ];
      const result = expandV1Permissions(resources, []);
      expect(findResource(result, "rbac", "principal")).toBeDefined();
    });

    it("does not duplicate principal if already present", () => {
      const result = expandV1Permissions(makeBaseRbacResources(), []);
      const principals = result.filter((r) => r.name === "principal" && r.namespace === "rbac");
      expect(principals.length).toBe(1);
    });
  });
});
