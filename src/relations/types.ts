/**
 * Generic relations layer — shared types.
 *
 * Phase 1 "Business Control Layer" is built around *connected business objects*
 * rather than folders (spec §4/§14): an object is created once and referenced
 * throughout the system. This layer is the single, typed edge store that binds
 * the ten core objects (Clients, Opportunities, Projects, Tasks, Products,
 * Decisions, Risks, Financial Commitments, People, System Issues) together.
 *
 * Every object-builder agent writes/reads its cross-object links through this
 * one store so "create once, reference throughout" holds across the system.
 */

/**
 * The ten core Phase 1 business-object types, plus `person` for People/Resources.
 * `fromType` / `toType` are stored as free text so an object agent can introduce
 * a new type without a schema migration, but this enum is the canonical set and
 * the value agents should use.
 */
export const OBJECT_TYPES = [
  "client",
  "opportunity",
  "project",
  "task",
  "product",
  "decision",
  "risk",
  "commitment", // Financial Commitments (spec Object 8)
  "person", // People / Resources (spec Object 9)
  "issue", // System Issues / Improvement Log (spec Object 10)
  // Not one of the ten core objects: a *rendered artifact* (src/reports) that
  // documents one of them. Reports live in their own store (reports.db, PDFs at
  // ~/.infinibot/reports/rpt_<id>.pdf) and are bound to business objects only
  // through this edge layer, so the report system stays independent.
  "report",
  // Pre-client pipeline objects. Not part of the ten core objects either: a
  // lead lives in its own store (scraped leads in src/services/lead-generation,
  // funnel-captured leads in src/funnels) and only becomes a client on
  // conversion. Modelling the origin as an edge is what lets a client profile
  // answer "where did this come from?" without either store learning about the
  // other.
  "lead",
  "funnel",
  // Ideas (src/ideas): captured before they are work. An idea links to the
  // task / project / document it was promoted into (or is about), so the
  // graph shows where work came from.
  "idea",
  // A Documents page / note (notes.* and documents.* ids).
  "note",
  // People Network (src/network): a person in the owner's network and an
  // edge between two of them. Opportunities ride on both.
  "contact",
  "connection",
  // Further linkable workspace objects (People Network cross-object links):
  // a Documents-workspace doc node (documents.* id), a workspace file (its
  // Files-page path, relative to the files root), an autonomy goal run, and a
  // synced calendar event (`<source>:<eventId>`).
  "document",
  "file",
  "goal",
  "event",
] as const;
export type ObjectType = (typeof OBJECT_TYPES)[number];

/**
 * Typed edges covering every relationship named in the spec's "How the 10
 * objects connect" flow (§14), plus a generic `relates_to` escape hatch for
 * links that don't (yet) have a dedicated edge. Direction is meaningful:
 * `from` is the subject, `to` is the object of the verb.
 *
 *   client   --client_has_opportunity-->        opportunity
 *   opportunity --opportunity_becomes_project--> project
 *   project  --project_has_task-->              task
 *   project  --project_delivers_product-->      product
 *   product  --product_offered_in_opportunity--> opportunity
 *   decision --decision_guides_task-->          task
 *   risk     --risk_impacts_task-->             task
 *   commitment --commitment_funds_project-->    project
 *   task     --task_assigned_to_person-->       person
 *   issue    --issue_relates_task-->            task
 *   report   --report_documents_client-->       client
 *   report   --report_documents_opportunity-->  opportunity
 *   report   --report_documents_project-->      project
 *   lead     --lead_becomes_client-->           client
 *   funnel   --funnel_captured_lead-->          lead
 *   idea     --idea_becomes_task-->             task
 *   idea     --idea_becomes_project-->          project
 *   idea     --idea_becomes_note-->             note
 *   idea     --idea_about_project-->            project
 *   contact  --contact_involved_in_opportunity--> opportunity
 *   connection --connection_supports_opportunity--> opportunity
 *   contact  --contact_linked_to-->              any object (project, note, file, …)
 *   connection --connection_linked_to-->         any object
 */
export const RELATION_EDGES = [
  "client_has_opportunity",
  "opportunity_becomes_project",
  "project_has_task",
  "project_delivers_product",
  "product_offered_in_opportunity",
  "decision_guides_task",
  "risk_impacts_task",
  "commitment_funds_project",
  "task_assigned_to_person",
  "issue_relates_task",
  // Report associations: a rendered report documents a business object. `from`
  // is always the report so `linksFrom("report", id)` yields everything one
  // report covers, and `linksTo("client", id)` yields a client's reports.
  "report_documents_client",
  "report_documents_opportunity",
  "report_documents_project",
  // Pre-client origin: a lead converts into a client, and a funnel captured
  // the lead. `from` is the upstream object so `linksTo("client", id)` yields
  // the client's origin and `linksFrom("funnel", id)` yields what it produced.
  "lead_becomes_client",
  "funnel_captured_lead",
  // Ideas: promotion targets (from = the idea) and plain "about" links.
  "idea_becomes_task",
  "idea_becomes_project",
  "idea_becomes_note",
  "idea_about_project",
  // People Network: who is involved in a deal, and which relationship carries
  // it (the warm intro). `from` is the network object; meta.role is free text.
  "contact_involved_in_opportunity",
  "connection_supports_opportunity",
  // People Network cross-object links: a person (or a relationship) tied to
  // any other workspace object. `from` is always the network object so
  // `linksFrom("contact", id)` = "what is this person linked to" and
  // `linksTo(type, id)` filtered to contact/connection = "who is on this".
  // Opportunities keep their dedicated edges above.
  "contact_linked_to",
  "connection_linked_to",
  "relates_to",
] as const;
export type RelationEdge = (typeof RELATION_EDGES)[number];

/** A fully-materialized relation row as stored + returned by the store. */
export interface ObjectRelation {
  id: string;
  fromType: ObjectType | string;
  fromId: string;
  edge: RelationEdge | string;
  toType: ObjectType | string;
  toId: string;
  /** Unix ms. */
  createdAt: number;
  /** Who/what created the link (agent id, user, or "system"). */
  createdBy: string;
  /** Free-form structured metadata (label, weight, note, ...). */
  meta: Record<string, unknown>;
}

/** Fields accepted when creating a link. */
export interface RelationCreateParams {
  fromType: string;
  fromId: string;
  edge: string;
  toType: string;
  toId: string;
  createdBy?: string;
  meta?: Record<string, unknown>;
  /** Optional idempotency key — a second create with the same id no-ops. */
  clientRequestId?: string;
}

/** Match used to unlink by identity when no row id is known. */
export interface RelationMatch {
  fromType?: string;
  fromId?: string;
  edge?: string;
  toType?: string;
  toId?: string;
}

/** Filter used by list(). Any subset narrows the result. */
export interface RelationQuery {
  fromType?: string;
  fromId?: string;
  edge?: string;
  toType?: string;
  toId?: string;
  since?: number;
  limit?: number;
}

/** A node in a connected-neighborhood graph. */
export interface RelationNode {
  type: string;
  id: string;
}

/**
 * The connected neighborhood around a root object: every object reachable from
 * it by following edges in either direction, plus the edges that connect them.
 */
export interface RelationGraph {
  root: RelationNode;
  nodes: RelationNode[];
  edges: ObjectRelation[];
}
