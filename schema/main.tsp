// Schema Unification Entrypoint
// Imports all service schemas for unified compilation.
// A custom emitter would walk the full type graph to produce:
//   1. SpiceDB/Zed schema (from relation types)
//   2. JSONSchema (from data models, via built-in emitter)
//   3. Intermediate representation (for Kessel Inventory API)
//
// Extension templates (V1WorkspacePermission + patch rules) live in ../lib/rbac-v1-extensions.tsp
// (platform vocabulary; service schemas import the same).

import "../lib/rbac-v1-extensions.tsp";
import "../lib/service-extensions.tsp";
import "./rbac.tsp";
import "./hbi.tsp";
import "./remediations.tsp";
