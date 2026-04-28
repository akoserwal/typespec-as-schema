import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import {
  compile,
  NodeHost,
  discoverResources,
  generateSpiceDB,
  generateMetadata,
  type ResourceDef,
  type V1Extension,
} from "../../src/lib.js";
import { discoverV1Permissions, expandV1Permissions } from "../../src/expand.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pocRoot = path.resolve(__dirname, "../..");
const mainTsp = path.resolve(pocRoot, "schema/main.tsp");
const goldenDir = path.resolve(pocRoot, "../../evaluation/golden-outputs");

// Shared state populated by beforeAll
let resources: ResourceDef[];
let extensions: V1Extension[];
let fullSchema: ResourceDef[];
let spicedbOutput: string;

beforeAll(async () => {
  const program = await compile(NodeHost, mainTsp, { noEmit: true });
  const discovered = discoverResources(program);
  resources = discovered.resources;
  extensions = discoverV1Permissions(program);
  fullSchema = expandV1Permissions(resources, extensions);
  spicedbOutput = generateSpiceDB(fullSchema);
}, 30_000);

// --- Helpers ---

interface DefinitionBlock {
  name: string;
  permissions: string[];
  relations: string[];
}

function parseZedDefinitions(zedText: string): Map<string, DefinitionBlock> {
  const blocks = new Map<string, DefinitionBlock>();
  const lines = zedText.split("\n");
  let current: DefinitionBlock | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("//") || line === "") continue;

    const defMatch = line.match(/^definition\s+(\S+)\s*\{/);
    if (defMatch) {
      current = { name: defMatch[1], permissions: [], relations: [] };
      blocks.set(defMatch[1], current);
      continue;
    }

    if (line === "}" || line === "{}") {
      if (line === "{}" && current) {
        // empty definition like `definition rbac/principal {}`
      }
      current = null;
      continue;
    }

    if (!current) continue;

    if (line.startsWith("permission ")) {
      current.permissions.push(line);
    } else if (line.startsWith("relation ")) {
      current.relations.push(line);
    }
  }

  return blocks;
}

const NAMESPACE_MAP: Record<string, string> = {
  "inventory/host": "hbi/host",
};

function normalizedName(name: string): string {
  return NAMESPACE_MAP[name] ?? name;
}

// --- Gate Tests ---

describe("G1: Authorization Completeness", () => {
  it("produces definition blocks for all four RBAC types", () => {
    expect(spicedbOutput).toContain("definition rbac/principal {");
    expect(spicedbOutput).toContain("definition rbac/role {");
    expect(spicedbOutput).toContain("definition rbac/role_binding {");
    expect(spicedbOutput).toContain("definition rbac/workspace {");
  });

  it("contains relation declarations with type references", () => {
    expect(spicedbOutput).toMatch(/relation\s+t_\w+:\s+rbac\/\w+/);
  });

  it("contains permission declarations using union (+)", () => {
    expect(spicedbOutput).toMatch(/permission\s+\w+\s*=\s*.*\+/);
  });

  it("contains permission declarations using intersection (&)", () => {
    expect(spicedbOutput).toMatch(/permission\s+\w+\s*=\s*\(.*&/);
  });

  it("contains permission declarations using arrow (->)", () => {
    expect(spicedbOutput).toMatch(/permission\s+\w+\s*=\s*.*->/);
  });
});

describe("G2: Data Field Support", () => {
  it("discovers at least one resource and extension", () => {
    expect(resources.length).toBeGreaterThanOrEqual(1);
    expect(extensions.length).toBeGreaterThanOrEqual(1);
  });

  it("HBI host resource is discovered", () => {
    const host = resources.find((r) => r.name === "host");
    expect(host).toBeDefined();
  });
});

describe("G4: Cooperative Extensions", () => {
  it("extensions add permissions to role, role_binding, and workspace", () => {
    const role = fullSchema.find((r) => r.name === "role" && r.namespace === "rbac");
    const rb = fullSchema.find((r) => r.name === "role_binding" && r.namespace === "rbac");
    const ws = fullSchema.find((r) => r.name === "workspace" && r.namespace === "rbac");

    expect(role!.relations.some((r) => r.name === "inventory_host_view")).toBe(true);
    expect(rb!.relations.some((r) => r.name === "inventory_host_view")).toBe(true);
    expect(ws!.relations.some((r) => r.name === "inventory_host_view")).toBe(true);
  });

  it("extensions are invoked from HBI/Remediations, not inlined in RBAC", () => {
    expect(extensions.some((e) => e.application === "inventory")).toBe(true);
    expect(extensions.some((e) => e.application === "remediations")).toBe(true);
  });

  it("no duplicate permission names on role for same extension", () => {
    const role = fullSchema.find((r) => r.name === "role" && r.namespace === "rbac")!;
    const names = role.relations.map((r) => r.name);
    const wildcardCounts = new Map<string, number>();
    for (const n of names) {
      wildcardCounts.set(n, (wildcardCounts.get(n) || 0) + 1);
    }
    for (const [name, count] of wildcardCounts) {
      if (name.includes("_any_") || name === "any_any_any") {
        expect(count, `duplicate wildcard: ${name}`).toBe(1);
      }
    }
  });
});

describe("G5: Cross-Namespace Composition", () => {
  it("HBI host references rbac/workspace in SpiceDB output", () => {
    expect(spicedbOutput).toContain("relation t_workspace: rbac/workspace");
  });

  it("host permissions arrow into workspace permissions", () => {
    expect(spicedbOutput).toContain("t_workspace->inventory_host_view");
    expect(spicedbOutput).toContain("t_workspace->inventory_host_update");
  });
});

// --- M1: Feature Coverage ---

describe("M1: Feature Coverage", () => {
  it("RBAC core types: principal, role, role_binding, workspace", () => {
    const rbacNames = fullSchema
      .filter((r) => r.namespace === "rbac")
      .map((r) => r.name)
      .sort();
    expect(rbacNames).toEqual(expect.arrayContaining(["principal", "role", "role_binding", "workspace"]));
  });

  it("HBI host with workspace relation and view/update permissions", () => {
    const host = fullSchema.find((r) => r.name === "host");
    expect(host).toBeDefined();
    expect(host!.relations.some((r) => r.name === "workspace")).toBe(true);
    expect(host!.relations.some((r) => r.name === "view")).toBe(true);
    expect(host!.relations.some((r) => r.name === "update")).toBe(true);
  });

  it("remediations is permissions-only — no definition in SpiceDB output", () => {
    expect(spicedbOutput).not.toMatch(/definition\s+remediations\//);
  });

  it("namespace separation — RBAC and HBI in separate definitions", () => {
    const defs = parseZedDefinitions(spicedbOutput);
    const namespaces = new Set([...defs.keys()].map((k) => k.split("/")[0]));
    expect(namespaces.has("rbac")).toBe(true);
    expect(namespaces.has("inventory")).toBe(true);
  });

  it("V1WorkspacePermission extension mechanism discovers extensions from aliases", () => {
    expect(extensions.length).toBeGreaterThanOrEqual(4);
    expect(extensions.some((e) => e.v2Perm === "inventory_host_view")).toBe(true);
    expect(extensions.some((e) => e.v2Perm === "inventory_host_update")).toBe(true);
    expect(extensions.some((e) => e.v2Perm === "remediations_remediation_view")).toBe(true);
    expect(extensions.some((e) => e.v2Perm === "remediations_remediation_update")).toBe(true);
  });

  it("any_any_any wildcard naming", () => {
    expect(spicedbOutput).toContain("any_any_any");
    expect(spicedbOutput).not.toContain("all_all_all");
  });

  it("binding workspace relation (not user_grant)", () => {
    expect(spicedbOutput).toContain("t_binding");
    expect(spicedbOutput).not.toContain("t_user_grant");
  });

  it("t_ prefix on all assignable relations", () => {
    const defs = parseZedDefinitions(spicedbOutput);
    for (const [, block] of defs) {
      for (const rel of block.relations) {
        const match = rel.match(/relation\s+(t_\w+)/);
        expect(match, `relation without t_ prefix: ${rel}`).toBeTruthy();
      }
    }
  });

  it("view_metadata accumulation on workspace", () => {
    const ws = fullSchema.find((r) => r.name === "workspace" && r.namespace === "rbac")!;
    const viewMeta = ws.relations.find((r) => r.name === "view_metadata");
    expect(viewMeta).toBeDefined();
    expect(spicedbOutput).toMatch(/permission view_metadata\s*=/);
  });

  it("cross-namespace composition — HBI imports RBAC workspace", () => {
    expect(spicedbOutput).toContain("relation t_workspace: rbac/workspace");
  });

  it("metadata output lists permissions and resources per service", () => {
    const metadata = generateMetadata(resources, extensions);
    expect(metadata.inventory).toBeDefined();
    expect(metadata.inventory.permissions).toContain("inventory_host_view");
    expect(metadata.remediations).toBeDefined();
    expect(metadata.remediations.resources).toEqual([]);
  });
});

// --- M4: Output Correctness (SpiceDB) ---

describe("M4: SpiceDB Output Correctness vs Golden Reference", () => {
  let goldenDefs: Map<string, DefinitionBlock>;
  let emitterDefs: Map<string, DefinitionBlock>;

  beforeAll(() => {
    const goldenPath = path.join(goldenDir, "spicedb-reference.zed");
    const goldenText = fs.readFileSync(goldenPath, "utf-8");
    goldenDefs = parseZedDefinitions(goldenText);
    emitterDefs = parseZedDefinitions(spicedbOutput);
  });

  it("emitter produces the same number of definitions as the golden reference", () => {
    expect(emitterDefs.size).toBe(goldenDefs.size);
  });

  it("every golden definition exists in emitter output (with namespace normalization)", () => {
    for (const [goldenName] of goldenDefs) {
      const lookupName = goldenName;
      const reverseLookup = Object.entries(NAMESPACE_MAP).find(([, v]) => v === goldenName)?.[0];
      const found = emitterDefs.has(lookupName) || (reverseLookup && emitterDefs.has(reverseLookup));
      expect(found, `missing definition: ${goldenName}`).toBe(true);
    }
  });

  it("rbac/principal is empty in both", () => {
    const goldenPrincipal = goldenDefs.get("rbac/principal")!;
    const emitterPrincipal = emitterDefs.get("rbac/principal")!;
    expect(goldenPrincipal.permissions).toHaveLength(0);
    expect(goldenPrincipal.relations).toHaveLength(0);
    expect(emitterPrincipal.permissions).toHaveLength(0);
    expect(emitterPrincipal.relations).toHaveLength(0);
  });

  it("rbac/role has the same permission count", () => {
    const golden = goldenDefs.get("rbac/role")!;
    const emitter = emitterDefs.get("rbac/role")!;
    expect(emitter.permissions.length).toBe(golden.permissions.length);
  });

  it("rbac/role has the same relation count (13 wildcards + any_any_any)", () => {
    const golden = goldenDefs.get("rbac/role")!;
    const emitter = emitterDefs.get("rbac/role")!;
    expect(emitter.relations.length).toBe(golden.relations.length);
  });

  it("rbac/role_binding has the same permission set", () => {
    const golden = goldenDefs.get("rbac/role_binding")!;
    const emitter = emitterDefs.get("rbac/role_binding")!;

    const goldenPerms = golden.permissions.map((p) => p.trim()).sort();
    const emitterPerms = emitter.permissions.map((p) => p.trim()).sort();
    expect(emitterPerms).toEqual(goldenPerms);
  });

  it("rbac/workspace has view_metadata permission", () => {
    const emitter = emitterDefs.get("rbac/workspace")!;
    const hasViewMeta = emitter.permissions.some((p) => p.includes("view_metadata"));
    expect(hasViewMeta).toBe(true);
  });

  it("rbac/workspace view_metadata ORs the two read-verb permissions", () => {
    const emitter = emitterDefs.get("rbac/workspace")!;
    const viewMetaLine = emitter.permissions.find((p) => p.includes("view_metadata"))!;
    expect(viewMetaLine).toContain("inventory_host_view");
    expect(viewMetaLine).toContain("remediations_remediation_view");
  });

  it("rbac/workspace has the same permission count as golden reference", () => {
    const golden = goldenDefs.get("rbac/workspace")!;
    const emitter = emitterDefs.get("rbac/workspace")!;
    expect(emitter.permissions.length).toBe(golden.permissions.length);
  });

  it("rbac/workspace has the same relation count as golden reference", () => {
    const golden = goldenDefs.get("rbac/workspace")!;
    const emitter = emitterDefs.get("rbac/workspace")!;
    expect(emitter.relations.length).toBe(golden.relations.length);
  });

  it("host definition (inventory/host or hbi/host) matches structurally", () => {
    const emitterHost = emitterDefs.get("inventory/host");
    const goldenHost = goldenDefs.get("hbi/host");

    expect(emitterHost).toBeDefined();
    expect(goldenHost).toBeDefined();

    expect(emitterHost!.permissions.length).toBe(goldenHost!.permissions.length);
    expect(emitterHost!.relations.length).toBe(goldenHost!.relations.length);

    const emitterPermsSorted = emitterHost!.permissions.map((p) => p.trim()).sort();
    const goldenPermsSorted = goldenHost!.permissions.map((p) => p.trim()).sort();
    expect(emitterPermsSorted).toEqual(goldenPermsSorted);
  });

  it("no remediations/* definition in either output", () => {
    for (const [name] of goldenDefs) {
      expect(name).not.toMatch(/^remediations\//);
    }
    for (const [name] of emitterDefs) {
      expect(name).not.toMatch(/^remediations\//);
    }
  });
});

// --- M4: Output Correctness (Metadata) ---

describe("M4: Metadata Output Correctness", () => {
  it("matches expected benchmark metadata", () => {
    const metadata = generateMetadata(resources, extensions);

    expect(metadata.inventory).toBeDefined();
    expect(metadata.inventory.permissions).toEqual(
      expect.arrayContaining(["inventory_host_view", "inventory_host_update"])
    );
    expect(metadata.inventory.resources).toContain("host");

    expect(metadata.remediations).toBeDefined();
    expect(metadata.remediations.permissions).toEqual(
      expect.arrayContaining(["remediations_remediation_view", "remediations_remediation_update"])
    );
    expect(metadata.remediations.resources).toEqual([]);
  });
});

// --- Structural detail tests ---

describe("SpiceDB structural conventions", () => {
  it("every relation uses t_ prefix", () => {
    const lines = spicedbOutput.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("relation ")) {
        expect(trimmed).toMatch(/^relation t_/);
      }
    }
  });

  it("every assignable relation has a matching permission wrapper", () => {
    const defs = parseZedDefinitions(spicedbOutput);
    for (const [, block] of defs) {
      for (const rel of block.relations) {
        const relName = rel.match(/relation (t_\w+)/)?.[1];
        if (!relName) continue;
        const permName = relName.replace(/^t_/, "");
        const hasPerm = block.permissions.some((p) => p.includes(`permission ${permName}`));
        expect(hasPerm, `relation ${relName} has no matching permission ${permName}`).toBe(true);
      }
    }
  });
});
