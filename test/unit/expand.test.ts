import { describe, it, expect } from "vitest";
import {
  type ResourceDef,
  type RelationBody,
  findResource,
  slotName,
} from "../../src/lib.js";
import v1Handler from "../../schema/extensions/v1-workspace-permission.js";
import cascadeHandler from "../../schema/extensions/cascade-delete.js";

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

const inventoryViewInstance = {
  application: "inventory",
  resource: "hosts",
  verb: "read",
  v2Perm: "inventory_host_view",
};

const inventoryUpdateInstance = {
  application: "inventory",
  resource: "hosts",
  verb: "write",
  v2Perm: "inventory_host_update",
};

const remediationsViewInstance = {
  application: "remediations",
  resource: "remediations",
  verb: "read",
  v2Perm: "remediations_remediation_view",
};

const remediationsUpdateInstance = {
  application: "remediations",
  resource: "remediations",
  verb: "write",
  v2Perm: "remediations_remediation_update",
};

function findRelation(resource: ResourceDef, name: string) {
  return resource.relations.find((r) => r.name === name);
}

describe("V1 workspace permission expansion (handler)", () => {
  describe("Role wildcard relations", () => {
    it("adds four wildcard bool relations per extension to role", () => {
      const { resources: result } = v1Handler.expand(makeBaseRbacResources(), [inventoryViewInstance]);
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
      const { resources: result } = v1Handler.expand(makeBaseRbacResources(), [inventoryViewInstance]);
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
      const { resources: result } = v1Handler.expand(makeBaseRbacResources(), [inventoryViewInstance]);
      const role = findResource(result, "rbac", "role")!;
      const relNames = role.relations.map((r) => r.name);
      expect(relNames).not.toContain("inventory_all_all");
      expect(relNames).toContain("inventory_any_any");
    });
  });

  describe("RoleBinding intersection permissions", () => {
    it("adds intersection permission: subject & t_granted->v2Perm", () => {
      const { resources: result } = v1Handler.expand(makeBaseRbacResources(), [inventoryViewInstance]);
      const rb = findResource(result, "rbac", "role_binding")!;
      const perm = findRelation(rb, "inventory_host_view");
      expect(perm).toBeDefined();
      expect(perm!.body.kind).toBe("and");

      const members = (perm!.body as { members: RelationBody[] }).members;
      expect(members[0]).toEqual({ kind: "ref", name: "subject" });
      expect(members[1]).toEqual({ kind: "subref", name: slotName("granted"), subname: "inventory_host_view" });
    });
  });

  describe("Workspace union permissions", () => {
    it("adds union permission: t_binding->v2Perm + t_parent->v2Perm", () => {
      const { resources: result } = v1Handler.expand(makeBaseRbacResources(), [inventoryViewInstance]);
      const ws = findResource(result, "rbac", "workspace")!;
      const perm = findRelation(ws, "inventory_host_view");
      expect(perm).toBeDefined();
      expect(perm!.body.kind).toBe("or");

      const members = (perm!.body as { members: RelationBody[] }).members;
      expect(members[0]).toEqual({ kind: "subref", name: slotName("binding"), subname: "inventory_host_view" });
      expect(members[1]).toEqual({ kind: "subref", name: slotName("parent"), subname: "inventory_host_view" });
    });

    it("uses 'binding' naming, not 'user_grant'", () => {
      const { resources: result } = v1Handler.expand(makeBaseRbacResources(), [inventoryViewInstance]);
      const ws = findResource(result, "rbac", "workspace")!;
      const relNames = ws.relations.map((r) => r.name);
      expect(relNames).toContain("binding");
      expect(relNames).not.toContain("user_grant");
    });
  });

  describe("view_metadata accumulation", () => {
    it("generates view_metadata on workspace from read-verb extensions only", () => {
      const instances = [inventoryViewInstance, inventoryUpdateInstance, remediationsViewInstance, remediationsUpdateInstance];
      const { resources: result } = v1Handler.expand(makeBaseRbacResources(), instances);
      const ws = findResource(result, "rbac", "workspace")!;
      const viewMeta = findRelation(ws, "view_metadata");

      expect(viewMeta).toBeDefined();
      expect(viewMeta!.body.kind).toBe("or");

      const members = (viewMeta!.body as { members: RelationBody[] }).members;
      const names: string[] = [];
      function collectRefNames(body: RelationBody) {
        if (body.kind === "ref") names.push(body.name);
        if (body.kind === "or") for (const m of body.members) collectRefNames(m);
      }
      collectRefNames(viewMeta!.body);
      expect(names).toContain("inventory_host_view");
      expect(names).toContain("remediations_remediation_view");
      expect(names).not.toContain("inventory_host_update");
      expect(names).not.toContain("remediations_remediation_update");
    });

    it("does not generate view_metadata when no read-verb extensions exist", () => {
      const { resources: result } = v1Handler.expand(makeBaseRbacResources(), [inventoryUpdateInstance]);
      const ws = findResource(result, "rbac", "workspace")!;
      const viewMeta = findRelation(ws, "view_metadata");
      expect(viewMeta).toBeUndefined();
    });
  });

  describe("G4: Cooperative extensions — idempotency", () => {
    it("does not produce duplicate wildcard relations when extensions share an application", () => {
      const instances = [inventoryViewInstance, inventoryUpdateInstance];
      const { resources: result } = v1Handler.expand(makeBaseRbacResources(), instances);
      const role = findResource(result, "rbac", "role")!;

      const appAdminCount = role.relations.filter((r) => r.name === "inventory_any_any").length;
      expect(appAdminCount).toBe(1);

      const hostsAnyCount = role.relations.filter((r) => r.name === "inventory_hosts_any").length;
      expect(hostsAnyCount).toBe(1);
    });
  });

  describe("Multi-service expansion", () => {
    it("expands both inventory and remediations extensions onto RBAC types", () => {
      const instances = [inventoryViewInstance, inventoryUpdateInstance, remediationsViewInstance, remediationsUpdateInstance];
      const { resources: result } = v1Handler.expand(makeBaseRbacResources(), instances);

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
      const { resources: result } = v1Handler.expand(resources, []);
      expect(findResource(result, "rbac", "principal")).toBeDefined();
    });

    it("does not duplicate principal if already present", () => {
      const { resources: result } = v1Handler.expand(makeBaseRbacResources(), []);
      const principals = result.filter((r) => r.name === "principal" && r.namespace === "rbac");
      expect(principals.length).toBe(1);
    });
  });
});

describe("CascadeDeletePolicy expansion (handler)", () => {
  function makeHostWithRbac(): ResourceDef[] {
    return [
      ...makeBaseRbacResources(),
      {
        name: "host",
        namespace: "inventory",
        relations: [
          { name: "workspace", body: { kind: "assignable", target: "rbac/workspace", cardinality: "ExactlyOne" } },
          { name: "view", body: { kind: "subref", name: slotName("workspace"), subname: "inventory_host_view" } },
        ],
      },
    ];
  }

  function makeHostResourceOnly(): ResourceDef[] {
    return [
      {
        name: "host",
        namespace: "inventory",
        relations: [
          { name: "workspace", body: { kind: "assignable", target: "rbac/workspace", cardinality: "ExactlyOne" } },
          { name: "view", body: { kind: "subref", name: slotName("workspace"), subname: "inventory_host_view" } },
        ],
      },
    ];
  }

  const defaultInstances = [
    { childApplication: "inventory", childResource: "host", parentRelation: "workspace" },
  ];

  it("adds delete permission to matching child resource", () => {
    const { resources: result } = cascadeHandler.expand(makeHostWithRbac(), defaultInstances);
    const host = result.find((r) => r.name === "host" && r.namespace === "inventory")!;
    const deletePerm = host.relations.find((r) => r.name === "delete");
    expect(deletePerm).toBeDefined();
    expect(deletePerm!.body).toEqual({
      kind: "subref",
      name: slotName("workspace"),
      subname: "delete",
    });
  });

  it("adds delete permission to rbac/role referencing global wildcard", () => {
    const { resources: result } = cascadeHandler.expand(makeHostWithRbac(), defaultInstances);
    const role = findResource(result, "rbac", "role")!;
    const deletePerm = findRelation(role, "delete");
    expect(deletePerm).toBeDefined();
    expect(deletePerm!.body).toEqual({ kind: "ref", name: "any_any_any" });
  });

  it("adds delete permission to rbac/role_binding as intersection", () => {
    const { resources: result } = cascadeHandler.expand(makeHostWithRbac(), defaultInstances);
    const rb = findResource(result, "rbac", "role_binding")!;
    const deletePerm = findRelation(rb, "delete");
    expect(deletePerm).toBeDefined();
    expect(deletePerm!.body.kind).toBe("and");
    const members = (deletePerm!.body as { members: RelationBody[] }).members;
    expect(members[0]).toEqual({ kind: "ref", name: "subject" });
    expect(members[1]).toEqual({ kind: "subref", name: slotName("granted"), subname: "delete" });
  });

  it("adds delete permission to rbac/workspace as union", () => {
    const { resources: result } = cascadeHandler.expand(makeHostWithRbac(), defaultInstances);
    const ws = findResource(result, "rbac", "workspace")!;
    const deletePerm = findRelation(ws, "delete");
    expect(deletePerm).toBeDefined();
    expect(deletePerm!.body.kind).toBe("or");
    const members = (deletePerm!.body as { members: RelationBody[] }).members;
    expect(members[0]).toEqual({ kind: "subref", name: slotName("binding"), subname: "delete" });
    expect(members[1]).toEqual({ kind: "subref", name: slotName("parent"), subname: "delete" });
  });

  it("does not modify resources when child resource is not found", () => {
    const instances = [
      { childApplication: "nonexistent", childResource: "widget", parentRelation: "workspace" },
    ];
    const { resources: result } = cascadeHandler.expand(makeHostWithRbac(), instances);
    const host = result.find((r) => r.name === "host")!;
    expect(host.relations.some((r) => r.name === "delete")).toBe(false);
  });

  it("skips if child already has a delete permission", () => {
    const resources = makeHostWithRbac();
    const host = resources.find((r) => r.name === "host")!;
    host.relations.push({
      name: "delete",
      body: { kind: "ref", name: "existing_delete" },
    });
    const { resources: result } = cascadeHandler.expand(resources, defaultInstances);
    const resultHost = result.find((r) => r.name === "host")!;
    const deletePerms = resultHost.relations.filter((r) => r.name === "delete");
    expect(deletePerms.length).toBe(1);
    expect(deletePerms[0].body.kind).toBe("ref");
  });

  it("handles empty policies array", () => {
    const original = makeHostWithRbac();
    const { resources: result } = cascadeHandler.expand(original, []);
    expect(result.length).toBe(original.length);
    const ws = findResource(result, "rbac", "workspace")!;
    expect(findRelation(ws, "delete")).toBeUndefined();
  });

  it("does not mutate the input array", () => {
    const original = makeHostWithRbac();
    const originalRelCounts = original.map((r) => r.relations.length);
    cascadeHandler.expand(original, defaultInstances);
    for (let i = 0; i < original.length; i++) {
      expect(original[i].relations.length).toBe(originalRelCounts[i]);
    }
  });

  it("matches case-insensitively on application and resource", () => {
    const instances = [
      { childApplication: "INVENTORY", childResource: "HOST", parentRelation: "workspace" },
    ];
    const { resources: result } = cascadeHandler.expand(makeHostWithRbac(), instances);
    const host = result.find((r) => r.name === "host")!;
    expect(host.relations.some((r) => r.name === "delete")).toBe(true);
  });

  it("is idempotent — calling twice does not duplicate delete on RBAC types", () => {
    const { resources: first } = cascadeHandler.expand(makeHostWithRbac(), defaultInstances);
    const { resources: second } = cascadeHandler.expand(first, defaultInstances);
    for (const name of ["role", "role_binding", "workspace"] as const) {
      const res = findResource(second, "rbac", name)!;
      const deleteCount = res.relations.filter((r) => r.name === "delete").length;
      expect(deleteCount, `rbac/${name} should have exactly one delete`).toBe(1);
    }
    const host = second.find((r) => r.name === "host")!;
    expect(host.relations.filter((r) => r.name === "delete").length).toBe(1);
  });

  it("still adds delete to child when RBAC scaffold is missing", () => {
    const { resources: result } = cascadeHandler.expand(makeHostResourceOnly(), defaultInstances);
    const host = result.find((r) => r.name === "host")!;
    expect(host.relations.some((r) => r.name === "delete")).toBe(true);
  });
});
