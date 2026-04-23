import { describe, it, expect } from "vitest";
import {
  parseAccumulateRule,
  parseAnnotationRule,
  parseJsonSchemaFieldRule,
} from "../../src/declarative-extensions.js";

describe("parseAccumulateRule", () => {
  it("parses a full accumulate rule with when and public", () => {
    const rule = parseAccumulateRule("view_metadata=or({v2}),when={verb}==read,public=true");
    expect(rule).not.toBeNull();
    expect(rule!.name).toBe("view_metadata");
    expect(rule!.op).toBe("or");
    expect(rule!.ref).toBe("{v2}");
    expect(rule!.condition).toEqual({ param: "{verb}", value: "read" });
    expect(rule!.isPublic).toBe(true);
  });

  it("parses a rule without when condition", () => {
    const rule = parseAccumulateRule("all_perms=or({v2}),public=false");
    expect(rule).not.toBeNull();
    expect(rule!.name).toBe("all_perms");
    expect(rule!.op).toBe("or");
    expect(rule!.ref).toBe("{v2}");
    expect(rule!.condition).toBeUndefined();
    expect(rule!.isPublic).toBe(false);
  });

  it("parses a minimal rule (name + op + ref only)", () => {
    const rule = parseAccumulateRule("things=and({v2})");
    expect(rule).not.toBeNull();
    expect(rule!.name).toBe("things");
    expect(rule!.op).toBe("and");
    expect(rule!.ref).toBe("{v2}");
    expect(rule!.condition).toBeUndefined();
    expect(rule!.isPublic).toBeUndefined();
  });

  it("returns null for malformed input", () => {
    expect(parseAccumulateRule("")).toBeNull();
    expect(parseAccumulateRule("no_equals_sign")).toBeNull();
    expect(parseAccumulateRule("bad=noparens")).toBeNull();
  });
});

describe("parseJsonSchemaFieldRule", () => {
  it("parses a field rule with type, format, and required", () => {
    const rule = parseJsonSchemaFieldRule("my_field_id=string:uuid,required=true");
    expect(rule).not.toBeNull();
    expect(rule!.fieldName).toBe("my_field_id");
    expect(rule!.fieldType).toBe("string");
    expect(rule!.format).toBe("uuid");
    expect(rule!.required).toBe(true);
  });

  it("parses a field rule without format", () => {
    const rule = parseJsonSchemaFieldRule("count=integer,required=false");
    expect(rule).not.toBeNull();
    expect(rule!.fieldName).toBe("count");
    expect(rule!.fieldType).toBe("integer");
    expect(rule!.format).toBeUndefined();
    expect(rule!.required).toBe(false);
  });

  it("parses a field rule without required (defaults to false)", () => {
    const rule = parseJsonSchemaFieldRule("label=string");
    expect(rule).not.toBeNull();
    expect(rule!.fieldName).toBe("label");
    expect(rule!.fieldType).toBe("string");
    expect(rule!.required).toBe(false);
  });

  it("handles interpolated field names with braces", () => {
    const rule = parseJsonSchemaFieldRule("{v2}_id=string:uuid,required=true");
    expect(rule).not.toBeNull();
    expect(rule!.fieldName).toBe("{v2}_id");
  });

  it("returns null for malformed input", () => {
    expect(parseJsonSchemaFieldRule("")).toBeNull();
    expect(parseJsonSchemaFieldRule("no_type")).toBeNull();
  });
});

describe("parseAnnotationRule", () => {
  it("parses a key=value annotation", () => {
    const rule = parseAnnotationRule("feature_flag=staleness_v2");
    expect(rule).not.toBeNull();
    expect(rule!.key).toBe("feature_flag");
    expect(rule!.value).toBe("staleness_v2");
  });

  it("parses a numeric value", () => {
    const rule = parseAnnotationRule("retention_days=90");
    expect(rule).not.toBeNull();
    expect(rule!.key).toBe("retention_days");
    expect(rule!.value).toBe("90");
  });

  it("returns null for empty string", () => {
    expect(parseAnnotationRule("")).toBeNull();
  });

  it("returns null for string without equals", () => {
    expect(parseAnnotationRule("no_value")).toBeNull();
  });

  it("returns null when key is empty", () => {
    expect(parseAnnotationRule("=value")).toBeNull();
  });
});
