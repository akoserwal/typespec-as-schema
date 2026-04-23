// RBAC V1 Extension Library
// Declarative extension template for V1 workspace permission migration.
// The RBAC team defines the patch rules here as structured string properties.
// The generic emitter reads these rules and applies patches to the model
// without any extension-specific code.
//
// Keep in sync: `V1WorkspacePermission` patch properties are mirrored for tests
// in `src/declarative-extensions.ts` as `V1_WORKSPACE_PERMISSION_TEMPLATE_RULES`.
// CI: `test/unit/template-rules-drift.test.ts` compares this template to that array.
//
// Patch-rule property naming convention:
//   {target}_{patchType}
//
//   target:    role | roleBinding | workspace | jsonSchema
//   patchType: boolRelations | permission | public | accumulate
//
// Patch-rule syntax:
//   boolRelations:  comma-separated names to add as BoolRelation<Principal>
//   permission:     name=body  (body uses | for union, & for intersect, -> for subreference)
//   public:         comma-separated permission names to mark as public
//   accumulate:     name=op(ref),when=condition,public=bool
//                   Collects refs across all extension instances, merges with op.
//                   "when" gates on a param equality check ({param}==value).
//
// Placeholders: {app}, {res}, {verb}, {v2} are interpolated from the template params.

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

  // On rbac/role: add bool relations for the permission hierarchy
  role_boolRelations: "{app}_any_any,{app}_{res}_any,{app}_any_{verb},{app}_{res}_{verb}";

  // On rbac/role: add computed permission as union of bool hierarchy
  role_permission: "{v2}=any_any_any | {app}_any_any | {app}_{res}_any | {app}_any_{verb} | {app}_{res}_{verb}";

  // On rbac/role_binding: add intersect permission
  roleBinding_permission: "{v2}=subject & granted->{v2}";

  // On rbac/workspace: add union permission from bindings + parent
  workspace_permission: "{v2}=binding->{v2} | parent->{v2}";

  // Mark workspace permission as public
  workspace_public: "{v2}";

  // Accumulate read-verb permissions into workspace.view_metadata (OR)
  workspace_accumulate: "view_metadata=or({v2}),when={verb}==read,public=true";

}
