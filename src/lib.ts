// Barrel module — re-exports all public API for backward compatibility.

export { IR_VERSION } from "./types.js";
export type {
  KesselVerb,
  RelationDef,
  RelationBody,
  ResourceDef,
  V1Extension,
  UnifiedJsonSchema,
  ServiceMetadata,
  IntermediateRepresentation,
  CascadeDeleteEntry,
  AnnotationEntry,
  RBACScaffold,
} from "./types.js";

export {
  getNamespaceFQN,
  camelToSnake,
  bodyToZed,
  slotName,
  flattenAnnotations,
  findResource,
  cloneResources,
  isAssignable,
} from "./utils.js";

export { parsePermissionExpr } from "./parser.js";

export {
  findExtensionTemplate,
  isInstanceOf,
  discoverResources,
  discoverV1Permissions,
  discoverAnnotations,
  discoverCascadeDeletePolicies,
  discoverInstances,
  VALID_VERBS,
} from "./discover.js";
export type { DiscoveryWarnings, DiscoveryStats, DiscoverInstancesResult } from "./discover.js";

export {
  addRelation,
  addBoolRelation,
  getRelation,
  replaceBody,
  getOrAddRelation,
  hasRelation,
  ref,
  subref,
  or,
  and,
  resolveRBACScaffold,
  RBAC_RELATIONS,
} from "./sdk.js";
export type { ScaffoldResult, ExpansionResult, ExtensionHandler, BodyMutator } from "./sdk.js";

export {
  generateSpiceDB,
  generateUnifiedJsonSchemas,
  generateMetadata,
  generateIR,
} from "./generate.js";

export { EXTENSION_TEMPLATES, type ExtensionTemplateDef } from "./registry.js";

export { compilePipeline, type PipelineResult, type PipelineOptions } from "./pipeline.js";

export { compile, NodeHost } from "@typespec/compiler";
