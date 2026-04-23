import { describe, it, expect, beforeAll } from "vitest";
import * as path from "path";
import { fileURLToPath } from "url";
import { compileAndDiscover } from "../../src/compile-and-discover.js";
import {
  generateSpiceDB,
  generateUnifiedJsonSchemas,
  type ResourceDef,
  type UnifiedJsonSchema,
  type V1Extension,
} from "../../src/lib.js";
import {
  discoverV1WorkspacePermissionDeclarations,
  discoverExtensionDeclarations,
  v1ExtensionsFromDeclarations,
  type DeclaredExtension,
  type AnnotationEntry,
} from "../../src/declarative-extensions.js";
import { expandSchemaWithExtensions } from "../../src/pipeline.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pocRoot = path.resolve(__dirname, "../..");
const mainTsp = path.resolve(pocRoot, "schema/main.tsp");

let fullSchema: ResourceDef[];
let spicedbOutput: string;
let declaredExtensions: DeclaredExtension[];
let allDeclared: DeclaredExtension[];
let annotations: Map<string, AnnotationEntry[]>;
let unifiedJsonSchemas: Record<string, UnifiedJsonSchema>;
let resources: ResourceDef[];
let extensions: V1Extension[];

beforeAll(async () => {
  const discovered = await compileAndDiscover(mainTsp);
  resources = discovered.resources;
  extensions = discovered.extensions;
  declaredExtensions = discoverV1WorkspacePermissionDeclarations(
    discovered.program,
  );
  allDeclared = discoverExtensionDeclarations(discovered.program);
  const expanded = expandSchemaWithExtensions(discovered.program, resources);
  fullSchema = expanded.fullSchema;
  annotations = expanded.annotations;
  spicedbOutput = generateSpiceDB(fullSchema);
  unifiedJsonSchemas = generateUnifiedJsonSchemas(fullSchema, expanded.jsonSchemaFields);
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

describe("Declarative extension discovery", () => {
  it("IR extensions match declarations derived from the same program", () => {
    const fromDeclared = v1ExtensionsFromDeclarations(declaredExtensions)
      .slice()
      .sort((a, b) => a.v2Perm.localeCompare(b.v2Perm));
    const fromCompile = extensions
      .slice()
      .sort((a, b) => a.v2Perm.localeCompare(b.v2Perm));
    expect(fromDeclared).toEqual(fromCompile);
  });

  it("discovers 4 V1WorkspacePermission instances from schema/main.tsp", () => {
    expect(declaredExtensions).toHaveLength(4);
  });

  it("extracts correct parameters from each instance", () => {
    const perms = declaredExtensions.map((e) => e.params.v2Perm).sort();
    expect(perms).toEqual([
      "inventory_host_update",
      "inventory_host_view",
      "remediations_remediation_update",
      "remediations_remediation_view",
    ]);
  });

  it("each instance has 6 patch rules (role, roleBinding, workspace)", () => {
    for (const ext of declaredExtensions) {
      expect(ext.patchRules.length).toBe(6);
    }
  });

  it("patch rules cover role, roleBinding, and workspace targets", () => {
    for (const ext of declaredExtensions) {
      const targets = new Set(ext.patchRules.map((r) => r.target));
      expect(targets.has("role")).toBe(true);
      expect(targets.has("roleBinding")).toBe(true);
      expect(targets.has("workspace")).toBe(true);
    }
  });

  it("workspace accumulate rule encodes view_metadata", () => {
    for (const ext of declaredExtensions) {
      const accRule = ext.patchRules.find(
        (r) => r.target === "workspace" && r.patchType === "accumulate",
      );
      expect(accRule).toBeDefined();
      expect(accRule!.rawValue).toContain("view_metadata=or({v2})");
      expect(accRule!.rawValue).toContain("when={verb}==read");
    }
  });
});

// ─── SpiceDB smoke ───────────────────────────────────────────────────

describe("Declarative pipeline: SpiceDB output", () => {
  it("rbac/workspace view_metadata ORs read-verb permissions", () => {
    const defs = parseZedDefinitions(spicedbOutput);
    const vm = defs.get("rbac/workspace")!.permissions.find((p) => p.includes("view_metadata"))!;
    expect(vm).toContain("inventory_host_view");
    expect(vm).toContain("remediations_remediation_view");
  });
});

// ─── Semantic model tests ────────────────────────────────────────────

describe("Declarative extension: enriched model semantics", () => {
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

  it("workspace permissions are marked public", () => {
    const ws = fullSchema.find((r) => r.name === "workspace" && r.namespace === "rbac")!;
    const invView = ws.relations.find((r) => r.name === "inventory_host_view");
    expect(invView?.isPublic).toBe(true);

    const viewMeta = ws.relations.find((r) => r.name === "view_metadata");
    expect(viewMeta?.isPublic).toBe(true);
  });

  it("view_metadata only accumulates read-verb extensions (via generic accumulate)", () => {
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

describe("Declarative extension: Unified JSON Schema", () => {
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

// ─── Generic discovery tests ─────────────────────────────────────────

describe("Generic extension discovery", () => {
  it("discovers both V1WorkspacePermission and ResourceAnnotation instances", () => {
    const templateNames = new Set(allDeclared.map((d) => d.templateName));
    expect(templateNames.has("V1WorkspacePermission")).toBe(true);
    expect(templateNames.has("ResourceAnnotation")).toBe(true);
  });

  it("discovers 4 V1 + 2 annotation instances = 6 total", () => {
    expect(allDeclared).toHaveLength(6);
  });

  it("each declared extension carries its templateName", () => {
    for (const d of allDeclared) {
      expect(d.templateName).toBeTruthy();
    }
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
