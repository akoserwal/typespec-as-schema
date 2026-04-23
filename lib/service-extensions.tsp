// Service Extension Library
// Declarative extension templates for service-level metadata and annotations.
// Unlike RBAC extensions, these do not affect the SpiceDB schema — they add
// metadata to the IR that downstream consumers (Go runtime, dashboards, etc.)
// can interpret.
//
// Patch-rule property naming convention:
//   {target}_{patchType}
//
//   target:    metadata
//   patchType: addAnnotation
//
// Patch-rule syntax:
//   addAnnotation:  key=value
//                   Adds a key-value annotation to the IR for the specified resource.
//
// Placeholders: all param names are available as {paramName} in patch rules.

import "./kessel.tsp";

namespace Kessel;

model ResourceAnnotation<
  Application extends string,
  Resource extends string,
  Key extends string,
  Value extends string
> {
  application: Application;
  resource: Resource;
  key: Key;
  value: Value;

  metadata_addAnnotation: "{key}={value}";
}
