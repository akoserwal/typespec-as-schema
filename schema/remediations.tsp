// Remediations Service Schema
// Permissions-only service: registers permissions on workspace without
// defining any resource types. Demonstrates a service that only needs
// authorization extensions, not data schemas.

import "../lib/kessel.tsp";
import "../lib/rbac-v1-extensions.tsp";
import "./rbac.tsp";

using Kessel;

namespace Remediations;

// ─── Extension Applications ──────────────────────────────────────────

/** Maps remediations:remediations:read → remediations_remediation_view on workspace */
alias remediationViewPermission = Kessel.V1WorkspacePermission<
  "remediations",
  "remediations",
  "read",
  "remediations_remediation_view"
>;

/** Maps remediations:remediations:write → remediations_remediation_update on workspace */
alias remediationUpdatePermission = Kessel.V1WorkspacePermission<
  "remediations",
  "remediations",
  "write",
  "remediations_remediation_update"
>;
