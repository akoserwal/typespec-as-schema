// RBAC V1 Extension Template
// Service schemas declare V1WorkspacePermission aliases to register permissions.
// The emitter discovers these aliases and expands them into SpiceDB relations
// on Role, RoleBinding, and Workspace.
//
// Usage (in a service schema):
//   alias viewPermission = Kessel.V1WorkspacePermission<
//     "inventory", "hosts", "read", "inventory_host_view"
//   >;

import "./kessel.tsp";

namespace Kessel;

model V1WorkspacePermission<
  App extends string,
  Res extends string,
  Verb extends string,
  V2 extends string
> {
  application: App;
  resource: Res;
  verb: Verb;
  v2Perm: V2;
}
