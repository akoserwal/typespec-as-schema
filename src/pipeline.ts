// Single expansion pipeline: declarative extension patches → enriched ResourceDef[].

import type { Program } from "@typespec/compiler";
import type { ResourceDef, JsonSchemaExtraField } from "./lib.js";
import {
  discoverExtensionDeclarations,
  applyDeclaredPatches,
  type ApplyDeclaredPatchesOptions,
  type AnnotationEntry,
  type DeclaredExtension,
} from "./declarative-extensions.js";

export interface ExpandedSchema {
  fullSchema: ResourceDef[];
  jsonSchemaFields: JsonSchemaExtraField[];
  annotations: Map<string, AnnotationEntry[]>;
  declared: DeclaredExtension[];
}

export function expandSchemaWithExtensions(
  program: Program,
  resources: ResourceDef[],
  patchOptions?: ApplyDeclaredPatchesOptions,
): ExpandedSchema {
  const declared = discoverExtensionDeclarations(program);
  const { resources: fullSchema, jsonSchemaFields, annotations } = applyDeclaredPatches(
    resources,
    declared,
    patchOptions,
  );
  return { fullSchema, jsonSchemaFields, annotations, declared };
}
