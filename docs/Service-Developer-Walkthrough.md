# Service Developer Walkthrough

How to work with the TypeSpec schema from a service team's perspective.

---

## Where Things Live

```
v2/typespec-as-schema/
├── lib/                          <- PLATFORM-OWNED (don't touch)
│   ├── kessel.tsp                   Core types: Assignable, Permission, BoolRelation, Cardinality
│   └── kessel-extensions.tsp        Extension templates: V1WorkspacePermission, ResourceAnnotation, ...
├── schema/                       <- SERVICE AUTHORS WORK HERE
│   ├── main.tsp                     Entrypoint -- one import line per service
│   ├── rbac.tsp                     RBAC core (platform-owned)
│   ├── hbi.tsp                      HBI service (service team owns)
│   ├── remediations.tsp             Remediations service (service team owns)
│   └── extensions/               <- SERVICE-OWNED extension logic (TypeScript)
│       ├── v1-workspace-permission.ts   V1 permission expansion handler
│       └── cascade-delete.ts            Cascade delete expansion handler
├── src/                          <- PLATFORM-OWNED (don't touch)
│   ├── types.ts                     Core interfaces
│   ├── utils.ts                     Shared helpers (bodyToZed, slotName, findResource, etc.)
│   ├── sdk.ts                       Extension SDK (primitives for schema mutation)
│   ├── parser.ts                    Permission expression parser
│   ├── registry.ts                  Extension template registry (names, params, namespaces)
│   ├── discover.ts                  AST walking: resource + extension instance discovery
│   ├── pipeline.ts                  Pipeline orchestration (compile → discover → expand → generate)
│   ├── generate.ts                  Output generators (SpiceDB, JSON Schema, metadata, IR)
│   ├── safety.ts                    Validation guards
│   ├── lib.ts                       Barrel module re-exporting all public API
│   └── spicedb-emitter.ts           CLI entry point
└── go-loader-example/            <- PLATFORM-OWNED
    └── schema/                      Go structs + embedded IR
```

Service teams work in `schema/` for alias declarations (`.tsp` files)
and in `schema/extensions/` for extension logic (`.ts` handler files).

The `schema/extensions/` directory contains TypeScript files that define
**how** each extension template is expanded into SpiceDB relations.
These handlers import primitives from `src/sdk.ts` (the platform SDK)
and are auto-discovered by the pipeline at runtime. 

### What service authors use

These are the building blocks available in `lib/kessel.tsp` and `lib/kessel-extensions.tsp`:

| TypeSpec construct | What it means | SpiceDB effect |
|---|---|---|
| `Assignable<Target, Cardinality>` | A relation that can be directly reported via API | `relation t_{name}: {target}` |
| `Permission<"expr">` | A computed permission derived from other relations | `permission {name} = {expr}` |
| `BoolRelation<Target>` | A boolean relation holding wildcards (`target:*`) | `relation t_{name}: {target}:*` |
| `V1WorkspacePermission<App, Res, Verb, V2>` | Maps a V1 app:resource:verb to a workspace permission | 7 mutations on Role, RoleBinding, Workspace |
| `CascadeDeletePolicy<ChildApp, ChildRes, ParentRel>` | Adds delete permission on child via parent relation | 1 mutation on child resource |
| `ResourceAnnotation<App, Res, Key, Val>` | Non-RBAC metadata (feature flags, retention, etc.) | None (IR metadata only) |

### Cardinality options

| Cardinality | Meaning | JSON Schema effect |
|---|---|---|
| `ExactlyOne` | Required, single value | `{name}_id` field, required |
| `AtMostOne` | Optional, single value | `{name}_id` field, optional |
| `AtLeastOne` | Required, one or more | Array, minItems: 1 |
| `Any` | Optional, zero or more | Array |
| `All` | Wildcard (e.g., `principal:*`) | N/A |

---

## Scenario 1: Adding a New Service

### The simplest case: permissions only

Some services (like Remediations) only need to register permissions on
workspaces. They don't define their own resource types.

**Create `schema/notifications.tsp`:**

```typespec
// Notifications Service Schema
// Registers workspace permissions without defining resource types.

import "../lib/kessel.tsp";
import "../lib/kessel-extensions.tsp";
import "./rbac.tsp";

using Kessel;

namespace Notifications;

// Each alias triggers 7 mutations on Role, RoleBinding, and Workspace.
// No TypeScript code needed.

/** Maps notifications:notifications:read -> notifications_notification_view */
alias viewPermission = Kessel.V1WorkspacePermission<
  "notifications",
  "notifications",
  "read",
  "notifications_notification_view"
>;

/** Maps notifications:notifications:write -> notifications_notification_update */
alias updatePermission = Kessel.V1WorkspacePermission<
  "notifications",
  "notifications",
  "write",
  "notifications_notification_update"
>;
```

**Add one import to `schema/main.tsp`:**

```typespec
import "./notifications.tsp";
```

**Run:**

```bash
npx tsx src/spicedb-emitter.ts schema/main.tsp
```

**What happens automatically:**

The pipeline discovers the two `V1WorkspacePermission` aliases and
expands each into 7 mutations:

On **Role**:
- 4 bool relations for the hierarchy (`notifications_any_any`,
  `notifications_notifications_any`, `notifications_any_read`,
  `notifications_notifications_read`)
- 1 computed permission (`notifications_notification_view =
  any_any_any + notifications_any_any + ...`)

On **RoleBinding**:
- 1 intersection permission (`notifications_notification_view =
  subject & t_granted->notifications_notification_view`)

On **Workspace**:
- 1 union permission (`notifications_notification_view =
  t_binding->notifications_notification_view +
  t_parent->notifications_notification_view`)
- `view_metadata` automatically accumulates `notifications_notification_view`
  because its verb is `"read"`

Same pattern repeats for `_update` with `"write"` verb bools.

**Service author effort: 1 file, ~25 lines, zero TypeScript.**

---

### A service with resource types

If your service owns a resource (like HBI owns hosts), you define a
model in addition to the permission aliases.

**Create `schema/content-sources.tsp`:**

```typespec
import "@typespec/json-schema";
import "../lib/kessel.tsp";
import "../lib/kessel-extensions.tsp";
import "./rbac.tsp";

using JsonSchema;
using Kessel;

namespace ContentSources;

// ── Workspace permissions ────────────────────────────────────────────

alias templateView = Kessel.V1WorkspacePermission<
  "content_sources", "templates", "read", "content_sources_template_view"
>;
alias templateEdit = Kessel.V1WorkspacePermission<
  "content_sources", "templates", "write", "content_sources_template_edit"
>;

// ── Data model (emits as JSON Schema) ────────────────────────────────

@jsonSchema
model TemplateData {
  @maxLength(255) name?: string;
  @maxLength(1024) description?: string;
  @format("uri") repository_url?: string;
}

// ── Resource type ────────────────────────────────────────────────────

model Template {
  /** Every template belongs to exactly one workspace */
  workspace: Assignable<RBAC.Workspace, Cardinality.ExactlyOne>;

  /** Data fields with validation */
  data: TemplateData;

  /** View permission: resolves via workspace */
  view: Permission<"workspace.content_sources_template_view">;

  /** Edit permission: resolves via workspace */
  edit: Permission<"workspace.content_sources_template_edit">;
}

// ── Metadata annotations (IR only, not in SpiceDB) ──────────────────

alias templateRetention = Kessel.ResourceAnnotation<
  "content_sources", "template", "retention_days", "365"
>;
```

**Add to `schema/main.tsp`:**

```typespec
import "./content-sources.tsp";
```

**What gets generated:**

SpiceDB:
```
definition content_sources/template {
    permission workspace = t_workspace
    permission view = t_workspace->content_sources_template_view
    permission edit = t_workspace->content_sources_template_edit

    relation t_workspace: rbac/workspace
}
```

JSON Schema: `content_sources/template` with required `workspace_id`
(uuid format), because the workspace relation has cardinality `ExactlyOne`.

Metadata:
```json
{
  "content_sources": {
    "permissions": ["content_sources_template_view", "content_sources_template_edit"],
    "resources": ["template"]
  }
}
```

IR annotations:
```json
{
  "content_sources/template": {
    "retention_days": "365"
  }
}
```

**Service author effort: 1 file, ~45 lines, zero TypeScript.**

---

## Scenario 2: Adding New Types to an Existing Service

Adding a new resource type to a service that already exists.

### Example: adding a Group resource to HBI

Groups contain hosts and need their own permissions.

**Edit `schema/hbi.tsp` -- add after the existing Host model:**

```typespec
// ── Group permissions ────────────────────────────────────────────────

alias groupViewPermission = Kessel.V1WorkspacePermission<
  "inventory", "groups", "read", "inventory_group_view"
>;
alias groupUpdatePermission = Kessel.V1WorkspacePermission<
  "inventory", "groups", "write", "inventory_group_update"
>;

// ── Group data model ─────────────────────────────────────────────────

@jsonSchema
model GroupData {
  @maxLength(255) display_name?: string;
  @maxLength(1024) description?: string;
}

// ── Group resource type ──────────────────────────────────────────────

model Group {
  /** Every group belongs to exactly one workspace */
  workspace: Assignable<RBAC.Workspace, Cardinality.ExactlyOne>;

  /** A group contains zero or more hosts */
  hosts: Assignable<Host, Cardinality.Any>;

  /** Data fields */
  data: GroupData;

  /** View permission */
  view: Permission<"workspace.inventory_group_view">;

  /** Update permission */
  update: Permission<"workspace.inventory_group_update">;
}
```

No changes to `main.tsp` -- it already imports `hbi.tsp`.

**What gets generated for the new type:**

SpiceDB:
```
definition inventory/group {
    permission workspace = t_workspace
    permission hosts = t_hosts
    permission view = t_workspace->inventory_group_view
    permission update = t_workspace->inventory_group_update

    relation t_workspace: rbac/workspace
    relation t_hosts: inventory/host
}
```

The `hosts` relation uses `Cardinality.Any`, so it creates a SpiceDB
relation (tuples can be written) but no JSON Schema field (no `_id`
field is generated for `Any` cardinality -- only `ExactlyOne` produces
a required `_id` field).

Metadata updates `inventory` to include `"group"` in resources and both
new permissions in the permissions list.

**Service author effort: ~25 lines added to existing file, zero TypeScript.**

---

### Example: adding data fields to an existing resource

If a resource already exists and you need to add validation fields:

**Edit the existing `HostData` model in `schema/hbi.tsp`:**

```typespec
@jsonSchema
model HostData {
  @format("uuid") subscription_manager_id?: string;
  satellite_id?: string | SatelliteNumericId;
  @format("uuid") insights_id?: string;
  @maxLength(255) ansible_host?: string;

  // New fields:
  @maxLength(255) display_name?: string;      // <- add
  @format("date-time") last_seen?: string;    // <- add
}
```

The `?` suffix makes a field optional. Without it, the field would be
required in the JSON Schema. Data fields are emitted by the built-in
`@typespec/json-schema` emitter and do not affect SpiceDB output.

---

## Scenario 3: Adding New Kinds of Extensions

> **Note:** The extensions described below (`ContingentPermission`, `ExposeHostPermission`) are **not yet implemented** — this section shows the pattern for adding them.

This section uses the real production KSL from
[rbac-config](https://github.com/RedHatInsights/rbac-config/blob/master/configs/prod/schemas/src/)
to show how new extension types work.

### Background: the production extension landscape

The production `rbac-config` repository has four extension types:

| KSL extension | Purpose | Used by |
|---|---|---|
| `add_v1_based_permission` | Maps V1 app:resource:verb to workspace permission | All services |
| `add_contingent_permission` | Intersects two existing workspace perms | advisor, patch, vulnerability, malware, ros |
| `expose_host_permission` | Passes workspace perm through to host | advisor, patch, ros |
| `add_unified_permission` | V1/V2 share same name | rbac (internal) |

Our POC currently implements the first one (`V1WorkspacePermission`).
Here is how to add the other two that matter for service teams.

### How extensions work: the ownership model

Every extension has three layers across the platform/service boundary:

```
  PLATFORM TEAM (lib/ + src/)            SERVICE AUTHORS (schema/)
  ────────────────────────────          ──────────────────────────
  1. Template in kessel-extensions.tsp   Write alias declarations:
     (parameter shape, no logic)
  2. Registry entry in registry.ts       alias foo = Kessel.Template<
     (template name, params, namespace)    "param1", "param2"
  3. SDK primitives in sdk.ts            >;
     (addRelation, getRelation,
      replaceBody, getOrAddRelation,     Zero computation.
      ref, or, and, subref, ...)         Only type declarations.

                                         Handler in schema/extensions/:
                                         (expansion logic using SDK
                                          primitives, auto-discovered
                                          by the pipeline)
```

Adding a new extension type requires:
- **Platform**: template (`.tsp`) + registry entry (one line)
- **Service**: handler file in `schema/extensions/` using SDK primitives

The pipeline auto-discovers handlers from `schema/extensions/` and runs
them in filename sort order. No manual wiring in `pipeline.ts` is needed.

---

### Extension: `ContingentPermission`

#### What it does

Creates a workspace permission that is the **intersection** of two
existing permissions. From the production KSL:

```ksl
extension add_contingent_permission(first, second, contingent) {
    type platform  { relation `${contingent}`: `${first}` and `${second}` }
    type tenant    { relation `${contingent}`: `${first}` and `${second}` }
    type workspace { relation `${contingent}`: `${first}` and `${second}` }
}
```

"You need **both** `first` AND `second` to have `contingent`."

#### Why it exists

Services like advisor and patch have host-scoped data. Their permissions
require two conditions: (1) the user has the service-specific permission
AND (2) the user can view hosts in HBI. The `_assigned` permission
covers condition 1. The contingent permission intersects it with
`inventory_host_view` to enforce both conditions at the workspace level.

#### Implementation

Two parts: a platform template + registry entry, and a service-owned handler.

**`lib/kessel-extensions.tsp`** -- add the template (platform-owned):

```typespec
/**
 * Creates a workspace permission requiring BOTH of two existing permissions.
 * Produces: workspace.{contingent} = {first} AND {second}
 *
 * Example: advisor_results_view = inventory_host_view AND advisor_results_view_assigned
 */
model ContingentPermission<
  First extends string,
  Second extends string,
  Contingent extends string
> {
  first: First;
  second: Second;
  contingent: Contingent;
}
```

**`src/registry.ts`** -- register the template (platform-owned):

```typescript
export const EXTENSION_TEMPLATES: readonly ExtensionTemplateDef[] = [
  { templateName: "V1WorkspacePermission", paramNames: ["application", "resource", "verb", "v2Perm"], namespace: "Kessel" },
  { templateName: "ResourceAnnotation",    paramNames: ["application", "resource", "key", "value"], namespace: "Kessel" },
  { templateName: "CascadeDeletePolicy",   paramNames: ["childApplication", "childResource", "parentRelation"], namespace: "Kessel" },
  { templateName: "ContingentPermission",  paramNames: ["first", "second", "contingent"], namespace: "Kessel" },  // <- add
];
```

**`schema/extensions/contingent-permission.ts`** -- handler file (service-owned):

The handler uses SDK primitives from `src/sdk.ts`. The pipeline
auto-discovers it from `schema/extensions/` -- no wiring needed.

```typescript
import type { ExtensionHandler, ExpansionResult } from "../../src/sdk.js";
import {
  addRelation, and, ref, resolveRBACScaffold, cloneResources,
} from "../../src/sdk.js";

const handler: ExtensionHandler = {
  name: "ContingentPermission",
  templateName: "ContingentPermission",

  expand(baseResources, instances) {
    const policies = instances.filter(
      (p) => !!(p.first && p.second && p.contingent),
    );

    const resources = cloneResources(baseResources);
    const { scaffold, warnings } = resolveRBACScaffold(resources);
    if (!scaffold) return { resources, warnings };

    for (const ext of policies) {
      addRelation(scaffold.workspace, {
        name: ext.contingent,
        body: and(ref(ext.first), ref(ext.second)),
      });
    }

    return { resources, warnings };
  },
};

export default handler;
```



#### What service authors write

```typespec
alias resultsViewContingent = Kessel.ContingentPermission<
  "inventory_host_view",
  "advisor_recommendation_results_view_assigned",
  "advisor_recommendation_results_view"
>;
```

One alias line. Zero computation.

**SpiceDB output on workspace:**
```
permission advisor_recommendation_results_view = (inventory_host_view & advisor_recommendation_results_view_assigned)
```

---

### Extension: `ExposeHostPermission`

#### What it does

Passes a workspace-level permission through to `hbi/host`, gated by
host view access. From the production KSL
([hbi.ksl#L22](https://github.com/RedHatInsights/rbac-config/blob/master/configs/prod/schemas/src/hbi.ksl#L22)):

```ksl
public extension expose_host_permission(v2_perm, host_perm) {
    type host {
        public relation `${host_perm}`: view and workspace.`${v2_perm}`
    }
}
```

"Add a permission to `hbi/host` that requires **both** being able to
view the host (`view`) **AND** having the workspace-level permission
(`workspace.{v2_perm}`)."

#### Why it exists

Services like advisor, patch, and ros have data that lives per-host.
When checking permissions, you need to verify the user can see that
*specific* host, not just any host in the workspace. This extension
exposes the workspace permission on the host itself, intersected with
host view access.

#### How it's used in production

The production KSL uses a 3-step pattern. Here is the advisor example
([advisor.ksl](https://github.com/RedHatInsights/rbac-config/blob/master/configs/prod/schemas/src/advisor.ksl)):

```ksl
// Step 1: Create the "_assigned" permission on workspace (V1 mapping)
@rbac.add_v1_based_permission(
  app:'advisor', resource:'recommendation_results', verb:'read',
  v2_perm:'advisor_recommendation_results_view_assigned'
);

// Step 2: Intersect with host visibility at the workspace level
@rbac.add_contingent_permission(
  first: 'inventory_host_view',
  second: 'advisor_recommendation_results_view_assigned',
  contingent: 'advisor_recommendation_results_view'
);

// Step 3: Pass through to the host
@hbi.expose_host_permission(
  v2_perm: 'advisor_recommendation_results_view',
  host_perm: 'advisor_recommendation_results_view'
);
```

The same 3-step pattern is used by
[patch.ksl](https://github.com/RedHatInsights/rbac-config/blob/master/configs/prod/schemas/src/patch.ksl)
and [ros.ksl](https://github.com/RedHatInsights/rbac-config/blob/master/configs/prod/schemas/src/ros.ksl).

#### Implementation

Same pattern: platform template + registry entry, service-owned handler.

**`lib/kessel-extensions.tsp`** -- add the template (platform-owned):

```typespec
/**
 * Exposes a workspace permission through hbi/host.
 * The resulting permission requires BOTH host view access
 * AND the workspace permission.
 *
 * Produces: host.{hostPerm} = view AND workspace.{v2Perm}
 */
model ExposeHostPermission<
  V2Perm extends string,
  HostPerm extends string
> {
  v2Perm: V2Perm;
  hostPerm: HostPerm;
}
```

**`src/registry.ts`** -- add to the registry (platform-owned):

```typescript
export const EXTENSION_TEMPLATES: readonly ExtensionTemplateDef[] = [
  // ... existing entries ...
  { templateName: "ContingentPermission",  paramNames: ["first", "second", "contingent"], namespace: "Kessel" },
  { templateName: "ExposeHostPermission",  paramNames: ["v2Perm", "hostPerm"], namespace: "Kessel" },  // <- add
];
```

**`schema/extensions/expose-host-permission.ts`** -- handler file (service-owned):

```typescript
import type { ExtensionHandler, ExpansionResult } from "../../src/sdk.js";
import {
  addRelation, and, ref, subref, findResource, cloneResources,
} from "../../src/sdk.js";

const handler: ExtensionHandler = {
  name: "ExposeHostPermission",
  templateName: "ExposeHostPermission",

  expand(baseResources, instances) {
    const policies = instances.filter(
      (p) => !!(p.v2Perm && p.hostPerm),
    );

    const resources = cloneResources(baseResources);
    const warnings: string[] = [];
    const host = findResource(resources, "inventory", "host");
    if (!host) {
      warnings.push("inventory/host not found -- ExposeHostPermission skipped.");
      return { resources, warnings };
    }

    for (const ext of policies) {
      addRelation(host, {
        name: ext.hostPerm,
        body: and(ref("view"), subref("workspace", ext.v2Perm)),
      });
    }

    return { resources, warnings };
  },
};

export default handler;
```

#### What service authors write

```typespec
alias exposeResultsView = Kessel.ExposeHostPermission<
  "advisor_recommendation_results_view",
  "advisor_recommendation_results_view"
>;
```

One alias line. Zero computation.

**SpiceDB output on host:**
```
permission advisor_recommendation_results_view = (view & t_workspace->advisor_recommendation_results_view)
```

---

### Full example: advisor.tsp (matching production KSL)

Here is what a complete advisor service file looks like, using all three
extension types. This matches the production
[advisor.ksl](https://github.com/RedHatInsights/rbac-config/blob/master/configs/prod/schemas/src/advisor.ksl):

```typespec
import "../lib/kessel.tsp";
import "../lib/kessel-extensions.tsp";
import "./rbac.tsp";
import "./hbi.tsp";

using Kessel;

namespace Advisor;

// ── Workspace-only permissions ───────────────────────────────────────

alias disableRecsView = Kessel.V1WorkspacePermission<
  "advisor", "disable_recommendations", "read",
  "advisor_disable_recommendations_view"
>;
alias disableRecsEdit = Kessel.V1WorkspacePermission<
  "advisor", "disable_recommendations", "write",
  "advisor_disable_recommendations_edit"
>;

alias weeklyEmailView = Kessel.V1WorkspacePermission<
  "advisor", "weekly_email", "read",
  "advisor_weekly_email_view"
>;

alias weeklyReportView = Kessel.V1WorkspacePermission<
  "advisor", "weekly_report", "read",
  "advisor_weekly_report_view"
>;

alias weeklyAutoSubView = Kessel.V1WorkspacePermission<
  "advisor", "weekly_report_auto_subscribe", "read",
  "advisor_weekly_report_auto_subscribe_view"
>;
alias weeklyAutoSubEdit = Kessel.V1WorkspacePermission<
  "advisor", "weekly_report_auto_subscribe", "write",
  "advisor_weekly_report_auto_subscribe_edit"
>;

alias exportsView = Kessel.V1WorkspacePermission<
  "advisor", "exports", "read",
  "advisor_exports_view"
>;

// ── Host-contingent permission: recommendation results (view) ────────
// 3-step pattern: V1 mapping -> contingent intersection -> expose on host

alias resultsViewAssigned = Kessel.V1WorkspacePermission<
  "advisor", "recommendation_results", "read",
  "advisor_recommendation_results_view_assigned"
>;

alias resultsViewContingent = Kessel.ContingentPermission<
  "inventory_host_view",
  "advisor_recommendation_results_view_assigned",
  "advisor_recommendation_results_view"
>;

alias exposeResultsView = Kessel.ExposeHostPermission<
  "advisor_recommendation_results_view",
  "advisor_recommendation_results_view"
>;

// ── Host-contingent permission: recommendation results (edit) ────────

alias resultsEditAssigned = Kessel.V1WorkspacePermission<
  "advisor", "recommendation_results", "write",
  "advisor_recommendation_results_edit_assigned"
>;

alias resultsEditContingent = Kessel.ContingentPermission<
  "inventory_host_view",
  "advisor_recommendation_results_edit_assigned",
  "advisor_recommendation_results_edit"
>;

alias exposeResultsEdit = Kessel.ExposeHostPermission<
  "advisor_recommendation_results_edit",
  "advisor_recommendation_results_edit"
>;
```

**What this produces in SpiceDB:**

```
// On rbac/role:
permission advisor_recommendation_results_view_assigned = any_any_any + advisor_any_any + ...
permission advisor_recommendation_results_edit_assigned = any_any_any + advisor_any_any + ...

// On rbac/role_binding:
permission advisor_recommendation_results_view_assigned = (subject & t_granted->...)
permission advisor_recommendation_results_edit_assigned = (subject & t_granted->...)

// On rbac/workspace:
permission advisor_recommendation_results_view_assigned = t_binding->... + t_parent->...
permission advisor_recommendation_results_edit_assigned = t_binding->... + t_parent->...
permission advisor_recommendation_results_view = (inventory_host_view & advisor_recommendation_results_view_assigned)
permission advisor_recommendation_results_edit = (inventory_host_view & advisor_recommendation_results_edit_assigned)

// On inventory/host:
permission advisor_recommendation_results_view = (view & t_workspace->advisor_recommendation_results_view)
permission advisor_recommendation_results_edit = (view & t_workspace->advisor_recommendation_results_edit)
```

---

## Pipeline Ordering

Extension handlers run in **filename sort order** within
`schema/extensions/`. Later handlers can reference permissions created
by earlier ones:

```
schema/extensions/
├── cascade-delete.ts               runs 1st (c...)
├── contingent-permission.ts        runs 2nd (c... -- after cascade)
├── expose-host-permission.ts       runs 3rd (e...)
└── v1-workspace-permission.ts      runs 4th (v...)
```

If ordering matters (e.g., `ContingentPermission` needs workspace
permissions created by `V1WorkspacePermission`), use numeric prefixes:

```
schema/extensions/
├── 01-v1-workspace-permission.ts   runs 1st -- creates workspace perms
├── 02-cascade-delete.ts            runs 2nd -- adds delete permissions
├── 03-contingent-permission.ts     runs 3rd -- intersects workspace perms (needs step 1)
└── 04-expose-host-permission.ts    runs 4th -- references workspace perms on host (needs step 3)
```

The `view_metadata` accumulation happens inside the V1 handler itself
(incrementally via `replaceBody`) rather than as a separate pipeline step.

---

## Extension Complexity Budget

| Extension type | Template params | Mutations per use | Complexity |
|---|---|---|---|
| `V1WorkspacePermission` | 4 | 7 (4 role bools + role perm + rb perm + ws perm) | O(N) |
| `CascadeDeletePolicy` | 3 | 1 (child resource delete permission) | O(N) |
| `ContingentPermission` | 3 | 1 (workspace intersection) | O(N) |
| `ExposeHostPermission` | 2 | 1 (host intersection) | O(N) |
| `ResourceAnnotation` | 4 | 0 (metadata only, no SpiceDB effect) | O(N) |

For any combination of extensions, total work is bounded and linear.
Service authors never write computation -- only type alias declarations.

---

## Summary: What Each Role Does

| Task | Who | Files touched | Lines | TypeScript? |
|---|---|---|---|---|
| New permissions-only service | Service team | 1 new `.tsp` + 1 import in `main.tsp` | ~25 | No |
| New resource type | Service team | Edit existing `.tsp` | ~20-30 | No |
| New data fields on existing type | Service team | Edit `*Data` model | ~5 | No |
| Attach metadata annotation | Service team | 1 alias line | ~5 | No |
| Use existing extension template | Service team | 1 alias line | ~5 | No |
| **New extension template** | Platform + service | Template + registry entry + handler file | ~40 | Yes |

The last row is the only case requiring TypeScript. It involves:

- **Platform team**: template in `lib/kessel-extensions.tsp` + registry
  entry in `src/registry.ts` (defines the parameter shape)
- **Service team**: handler file in `schema/extensions/` (defines the
  expansion logic using SDK primitives from `src/sdk.ts`)

For all other tasks, service authors write zero TypeScript -- only
`.tsp` alias declarations.
