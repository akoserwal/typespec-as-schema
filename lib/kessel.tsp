// Kessel Schema Library
// Core types for expressing Kessel resource schemas in TypeSpec.
// Data fields use native TypeSpec types (→ JSONSchema via built-in emitter).
// Relations use typed wrappers (→ SpiceDB/Zed via custom emitter).

namespace Kessel;

// ─── Cardinality ─────────────────────────────────────────────────────

enum Cardinality {
  AtMostOne,
  ExactlyOne,
  AtLeastOne,
  Any,
}

// ─── Relation Types ──────────────────────────────────────────────────
// These are marker models used as property types to describe
// Zanzibar-style authorization relations on resource types.

/** An assignable relation — can be directly reported via the Inventory API */
@doc("Assignable relation to {target}")
model Assignable<Target, Card extends Cardinality> {
  @doc("target")
  __target: Target;

  @doc("cardinality")
  __cardinality: Card;
}

/** A computed permission — derived from set operations, not directly assignable */
model Permission<Expr extends string> {
  @doc("expression")
  __expr: Expr;
}

/** Boolean relation — can hold wildcard references (target:*) */
model BoolRelation<Target> {
  @doc("boolean assignable to target type wildcard")
  __target: Target;
}
