// Service Annotation Template
// Service schemas declare ResourceAnnotation aliases to attach metadata.
// Annotations flow into the IR for downstream consumers (feature flags, etc.)
// They do not affect SpiceDB output.
//
// Usage:
//   alias hostFlag = Kessel.ResourceAnnotation<
//     "inventory", "host", "feature_flag", "staleness_v2"
//   >;

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
}
