import { describe, it, expect, beforeAll } from "vitest";
import { generateIR, IR_VERSION } from "../../src/lib.js";
import cascadeHandler from "../../schema/extensions/cascade-delete.js";
import { compilePipeline, type PipelineResult } from "../helpers/pipeline.js";

let pipeline: PipelineResult;

beforeAll(async () => {
  pipeline = await compilePipeline();
}, 30_000);

describe("V1 permission discovery", () => {
  it("discovers 4 V1WorkspacePermission instances from schema/main.tsp", () => {
    expect(pipeline.extensions).toHaveLength(4);
  });

  it("extracts correct v2Perm from each instance", () => {
    const perms = pipeline.extensions.map((e) => e.v2Perm).sort();
    expect(perms).toEqual([
      "inventory_host_update",
      "inventory_host_view",
      "remediations_remediation_update",
      "remediations_remediation_view",
    ]);
  });

  it("extracts correct application names", () => {
    const apps = new Set(pipeline.extensions.map((e) => e.application));
    expect(apps.has("inventory")).toBe(true);
    expect(apps.has("remediations")).toBe(true);
  });
});

// ─── Semantic model tests ────────────────────────────────────────────

describe("Expansion: enriched model semantics", () => {
  it("role gets bool relations for each extension's hierarchy levels", () => {
    const role = pipeline.fullSchema.find((r) => r.name === "role" && r.namespace === "rbac")!;
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
    const ws = pipeline.fullSchema.find((r) => r.name === "workspace" && r.namespace === "rbac")!;
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
    const hostSchema = pipeline.unifiedJsonSchemas["inventory/host"];
    expect(hostSchema).toBeDefined();
    expect(hostSchema.properties["inventory_host_view_id"]).toBeUndefined();
    expect(hostSchema.properties["inventory_host_update_id"]).toBeUndefined();
  });

  it("relation-derived workspace_id is still present from ExactlyOne assignable", () => {
    const hostSchema = pipeline.unifiedJsonSchemas["inventory/host"];
    expect(hostSchema.properties["workspace_id"]).toBeDefined();
    expect(hostSchema.required).toContain("workspace_id");
  });
});

// ─── Annotation Discovery Tests ─────────────────────────────────────

describe("Annotation discovery", () => {
  it("discovers ResourceAnnotation instances from hbi.tsp", () => {
    expect(pipeline.annotations.size).toBeGreaterThan(0);
  });

  it("groups annotations by resource key", () => {
    const hostAnnotations = pipeline.annotations.get("inventory/host");
    expect(hostAnnotations).toBeDefined();
    expect(hostAnnotations!.length).toBeGreaterThanOrEqual(2);
  });

  it("extracts feature_flag annotation with correct value", () => {
    const hostAnnotations = pipeline.annotations.get("inventory/host")!;
    const featureFlag = hostAnnotations.find((a) => a.key === "feature_flag");
    expect(featureFlag).toBeDefined();
    expect(featureFlag!.value).toBe("staleness_v2");
  });

  it("extracts retention_days annotation with correct value", () => {
    const hostAnnotations = pipeline.annotations.get("inventory/host")!;
    const retention = hostAnnotations.find((a) => a.key === "retention_days");
    expect(retention).toBeDefined();
    expect(retention!.value).toBe("90");
  });

  it("annotations do not affect SpiceDB output", () => {
    expect(pipeline.spicedbOutput).not.toContain("feature_flag");
    expect(pipeline.spicedbOutput).not.toContain("retention_days");
    expect(pipeline.spicedbOutput).not.toContain("staleness_v2");
  });
});

// ─── IR Annotation Tests ────────────────────────────────────────────

describe("IR generation with annotations", () => {
  it("includes annotations in IR output", () => {
    const ir = generateIR("test.tsp", pipeline.fullSchema, pipeline.extensions, pipeline.annotations);
    expect(ir.annotations).toBeDefined();
    expect(ir.annotations!["inventory/host"]).toBeDefined();
  });

  it("IR annotations contain correct key-value pairs", () => {
    const ir = generateIR("test.tsp", pipeline.fullSchema, pipeline.extensions, pipeline.annotations);
    const hostAnnotations = ir.annotations!["inventory/host"];
    expect(hostAnnotations["feature_flag"]).toBe("staleness_v2");
    expect(hostAnnotations["retention_days"]).toBe("90");
  });

  it("IR version matches IR_VERSION constant", () => {
    const ir = generateIR("test.tsp", pipeline.fullSchema, pipeline.extensions, pipeline.annotations);
    expect(ir.version).toBe(IR_VERSION);
  });

  it("IR omits annotations field when no annotations exist", () => {
    const ir = generateIR("test.tsp", pipeline.fullSchema, pipeline.extensions);
    expect(ir.annotations).toBeUndefined();
  });

  it("IR contains all expected top-level fields", () => {
    const ir = generateIR("test.tsp", pipeline.fullSchema, pipeline.extensions, pipeline.annotations);
    expect(ir.generatedAt).toBeDefined();
    expect(ir.source).toBe("schema/test.tsp");
    expect(ir.resources.length).toBeGreaterThan(0);
    expect(ir.extensions.length).toBeGreaterThan(0);
    expect(ir.spicedb).toContain("definition rbac/");
    expect(ir.metadata).toBeDefined();
    expect(ir.jsonSchemas).toBeDefined();
  });
});

// ─── CascadeDeletePolicy Tests ──────────────────────────────────────

describe("CascadeDeletePolicy discovery and expansion", () => {
  it("discovers at least one CascadeDeletePolicy from hbi.tsp", () => {
    expect(pipeline.cascadePolicies.length).toBeGreaterThanOrEqual(1);
  });

  it("discovers the host cascade delete policy with correct params", () => {
    const hostPolicy = pipeline.cascadePolicies.find(
      (p) => p.childApplication === "inventory" && p.childResource === "host",
    );
    expect(hostPolicy).toBeDefined();
    expect(hostPolicy!.parentRelation).toBe("workspace");
  });

  it("adds a delete permission to inventory/host in SpiceDB output", () => {
    expect(pipeline.spicedbOutput).toContain("permission delete = t_workspace->delete");
  });

  it("delete permission appears on the host resource def", () => {
    const host = pipeline.fullSchema.find((r) => r.name === "host" && r.namespace === "inventory");
    expect(host).toBeDefined();
    const deletePerm = host!.relations.find((r) => r.name === "delete");
    expect(deletePerm).toBeDefined();
    expect(deletePerm!.body.kind).toBe("subref");
  });

  it("does not duplicate delete if called twice", () => {
    const instances = pipeline.cascadePolicies.map((p) => ({
      childApplication: p.childApplication,
      childResource: p.childResource,
      parentRelation: p.parentRelation,
    }));
    const { resources: doubleExpanded } = cascadeHandler.expand(pipeline.fullSchema, instances);
    const host = doubleExpanded.find((r) => r.name === "host" && r.namespace === "inventory")!;
    const deleteCount = host.relations.filter((r) => r.name === "delete").length;
    expect(deleteCount).toBe(1);
  });

  it("adds delete permission to rbac/workspace in SpiceDB output", () => {
    expect(pipeline.spicedbOutput).toContain("permission delete = t_binding->delete + t_parent->delete");
  });

  it("adds delete permission to rbac/role_binding in SpiceDB output", () => {
    expect(pipeline.spicedbOutput).toContain("permission delete = (subject & t_granted->delete)");
  });

  it("adds delete permission to rbac/role in SpiceDB output", () => {
    expect(pipeline.spicedbOutput).toContain("permission delete = any_any_any");
  });

  it("produces zero validation diagnostics for the expanded schema", () => {
    expect(pipeline.diagnostics).toEqual([]);
  });
});

// ─── Discovery Health Tests ─────────────────────────────────────────

describe("Discovery health", () => {
  it("does not contain unexpected skipped-alias warnings", () => {
    const skippedWarnings = pipeline.warnings.filter((w) => w.startsWith("Skipped statement"));
    expect(skippedWarnings).toEqual([]);
  });

  it("does not report alias resolution failures", () => {
    const resolutionWarnings = pipeline.warnings.filter((w) => w.includes("Alias resolution:"));
    expect(resolutionWarnings).toEqual([]);
  });
});
