import { describe, it, expect } from "vitest";
import {
  generateUnifiedJsonSchemas,
  type ResourceDef,
} from "../../src/lib.js";

describe("generateUnifiedJsonSchemas", () => {
  it("generates _id field for ExactlyOne assignable relation", () => {
    const resources: ResourceDef[] = [
      {
        name: "host",
        namespace: "inventory",
        relations: [
          { name: "workspace", body: { kind: "assignable", target: "rbac/workspace", cardinality: "ExactlyOne" } },
          { name: "view", body: { kind: "subref", name: "t_workspace", subname: "inventory_host_view" } },
        ],
      },
    ];

    const schemas = generateUnifiedJsonSchemas(resources);
    expect(schemas["inventory/host"]).toBeDefined();

    const schema = schemas["inventory/host"];
    expect(schema.$id).toBe("inventory/host");
    expect(schema.type).toBe("object");
    expect(schema.properties.workspace_id).toBeDefined();
    expect(schema.properties.workspace_id.type).toBe("string");
    expect(schema.properties.workspace_id.format).toBe("uuid");
    expect(schema.required).toContain("workspace_id");
  });

  it("does not generate _id field for AtMostOne cardinality", () => {
    const resources: ResourceDef[] = [
      {
        name: "workspace",
        namespace: "rbac",
        relations: [
          { name: "parent", body: { kind: "assignable", target: "rbac/workspace", cardinality: "AtMostOne" } },
        ],
      },
    ];

    const schemas = generateUnifiedJsonSchemas(resources);
    expect(schemas["rbac/workspace"]).toBeUndefined();
  });

  it("skips RBAC namespace resources", () => {
    const resources: ResourceDef[] = [
      {
        name: "role",
        namespace: "rbac",
        relations: [
          { name: "something", body: { kind: "assignable", target: "rbac/principal", cardinality: "ExactlyOne" } },
        ],
      },
    ];

    const schemas = generateUnifiedJsonSchemas(resources);
    expect(Object.keys(schemas)).toHaveLength(0);
  });

  it("skips resources with no ExactlyOne relations", () => {
    const resources: ResourceDef[] = [
      {
        name: "host",
        namespace: "inventory",
        relations: [
          { name: "workspace", body: { kind: "assignable", target: "rbac/workspace", cardinality: "Any" } },
          { name: "view", body: { kind: "ref", name: "t_workspace" } },
        ],
      },
    ];

    const schemas = generateUnifiedJsonSchemas(resources);
    expect(schemas["inventory/host"]).toBeUndefined();
  });

  it("includes source provenance in property", () => {
    const resources: ResourceDef[] = [
      {
        name: "host",
        namespace: "inventory",
        relations: [
          { name: "workspace", body: { kind: "assignable", target: "rbac/workspace", cardinality: "ExactlyOne" } },
        ],
      },
    ];

    const schemas = generateUnifiedJsonSchemas(resources);
    expect(schemas["inventory/host"].properties.workspace_id.source)
      .toBe("relation workspace: rbac/workspace [ExactlyOne]");
  });
});
