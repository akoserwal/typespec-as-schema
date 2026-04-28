import { describe, it, expect, beforeAll } from "vitest";
import * as path from "path";
import { fileURLToPath } from "url";
import {
  compile,
  NodeHost,
  discoverResources,
  generateSpiceDB,
  generateUnifiedJsonSchemas,
  type ResourceDef,
  type UnifiedJsonSchema,
  type V1Extension,
} from "../../src/lib.js";
import {
  discoverV1Permissions,
  discoverAnnotations,
  expandV1Permissions,
  type AnnotationEntry,
} from "../../src/expand.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pocRoot = path.resolve(__dirname, "../..");
const mainTsp = path.resolve(pocRoot, "schema/main.tsp");

let fullSchema: ResourceDef[];
let spicedbOutput: string;
let annotations: Map<string, AnnotationEntry[]>;
let unifiedJsonSchemas: Record<string, UnifiedJsonSchema>;
let resources: ResourceDef[];
let extensions: V1Extension[];

beforeAll(async () => {
  const program = await compile(NodeHost, mainTsp, { noEmit: true });
  resources = discoverResources(program).resources;
  extensions = discoverV1Permissions(program);
  annotations = discoverAnnotations(program);
  fullSchema = expandV1Permissions(resources, extensions);
  spicedbOutput = generateSpiceDB(fullSchema);
  unifiedJsonSchemas = generateUnifiedJsonSchemas(fullSchema);
}, 30_000);

// ─── Helpers ─────────────────────────────────────────────────────────

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

// ─── Discovery Tests ─────────────────────────────────────────────────

describe("V1 permission discovery", () => {
  it("discovers 4 V1WorkspacePermission instances from schema/main.tsp", () => {
    expect(extensions).toHaveLength(4);
  });

  it("extracts correct v2Perm from each instance", () => {
    const perms = extensions.map((e) => e.v2Perm).sort();
    expect(perms).toEqual([
      "inventory_host_update",
      "inventory_host_view",
      "remediations_remediation_update",
      "remediations_remediation_view",
    ]);
  });

  it("extracts correct application names", () => {
    const apps = new Set(extensions.map((e) => e.application));
    expect(apps.has("inventory")).toBe(true);
    expect(apps.has("remediations")).toBe(true);
  });
});

// ─── SpiceDB smoke ───────────────────────────────────────────────────

describe("Expansion pipeline: SpiceDB output", () => {
  it("rbac/workspace view_metadata ORs read-verb permissions", () => {
    const defs = parseZedDefinitions(spicedbOutput);
    const vm = defs.get("rbac/workspace")!.permissions.find((p) => p.includes("view_metadata"))!;
    expect(vm).toContain("inventory_host_view");
    expect(vm).toContain("remediations_remediation_view");
  });
});

// ─── Semantic model tests ────────────────────────────────────────────

describe("Expansion: enriched model semantics", () => {
  it("role gets bool relations for each extension's hierarchy levels", () => {
    const role = fullSchema.find((r) => r.name === "role" && r.namespace === "rbac")!;
    const boolNames = role.relations
      .filter((r) => r.body.kind === "bool")
      .map((r) => r.name);

    expect(boolNames).toContain("inventory_any_any");
    expect(boolNames).toContain("inventory_hosts_any");
    expect(boolNames).toContain("inventory_any_read");
    expect(boolNames).toContain("inventory_hosts_read");
    expect(boolNames).toContain("inventory_any_write");
    expect(boolNames).toContain("inventory_hosts_write");
  });

  it("view_metadata only accumulates read-verb extensions", () => {
    const ws = fullSchema.find((r) => r.name === "workspace" && r.namespace === "rbac")!;
    const viewMeta = ws.relations.find((r) => r.name === "view_metadata")!;

    expect(viewMeta.body.kind).toBe("or");
    if (viewMeta.body.kind === "or") {
      const memberNames = viewMeta.body.members
        .filter((m): m is { kind: "ref"; name: string } => m.kind === "ref")
        .map((m) => m.name)
        .sort();
      expect(memberNames).toEqual([
        "inventory_host_view",
        "remediations_remediation_view",
      ]);
    }
  });
});

// ─── Unified JSON Schema tests ───────────────────────────────────────

describe("Expansion: Unified JSON Schema", () => {
  it("V1 extensions do not add _id fields for computed permissions", () => {
    const hostSchema = unifiedJsonSchemas["inventory/host"];
    expect(hostSchema).toBeDefined();
    expect(hostSchema.properties["inventory_host_view_id"]).toBeUndefined();
    expect(hostSchema.properties["inventory_host_update_id"]).toBeUndefined();
  });

  it("relation-derived workspace_id is still present from ExactlyOne assignable", () => {
    const hostSchema = unifiedJsonSchemas["inventory/host"];
    expect(hostSchema.properties["workspace_id"]).toBeDefined();
    expect(hostSchema.required).toContain("workspace_id");
  });
});

// ─── ResourceAnnotation tests ────────────────────────────────────────

describe("ResourceAnnotation extensions", () => {
  it("annotations are collected for inventory/host", () => {
    expect(annotations.has("inventory/host")).toBe(true);
  });

  it("inventory/host has feature_flag and retention_days annotations", () => {
    const entries = annotations.get("inventory/host")!;
    const keys = entries.map((e) => e.key).sort();
    expect(keys).toEqual(["feature_flag", "retention_days"]);
  });

  it("feature_flag annotation has correct value", () => {
    const entries = annotations.get("inventory/host")!;
    const flag = entries.find((e) => e.key === "feature_flag");
    expect(flag).toBeDefined();
    expect(flag!.value).toBe("staleness_v2");
  });

  it("retention_days annotation has correct value", () => {
    const entries = annotations.get("inventory/host")!;
    const ret = entries.find((e) => e.key === "retention_days");
    expect(ret).toBeDefined();
    expect(ret!.value).toBe("90");
  });

  it("annotations do not affect SpiceDB output", () => {
    expect(spicedbOutput).not.toContain("feature_flag");
    expect(spicedbOutput).not.toContain("retention_days");
    expect(spicedbOutput).not.toContain("staleness_v2");
  });

  it("V1WorkspacePermission extensions still work unchanged", () => {
    const role = fullSchema.find((r) => r.name === "role" && r.namespace === "rbac")!;
    expect(role.relations.some((r) => r.name === "inventory_host_view")).toBe(true);
    expect(role.relations.some((r) => r.name === "inventory_host_update")).toBe(true);
  });
});
