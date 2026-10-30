/**
 * Products (Object 5) — shared types.
 *
 * Tracks the products, platforms, services, modules, and solutions the company
 * is developing or selling (spec §9). It separates *actual products* from
 * one-off client work so the business can see what can be reused, improved,
 * sold repeatedly, or retired.
 *
 * The central discipline this object encodes is **Built ≠ Product**: something
 * can technically exist (`status`) without commercial validation
 * (`validationStage`). The two are stored independently and one is NEVER
 * derived from the other.
 *
 * NOTE: This module deliberately lives at `src/product/` (singular) with its own
 * `product.db`, distinct from any pre-existing `src/products/` role-bridge path.
 * It mirrors `src/issues/` exactly (typed-column SQLite, single shared store).
 */

import type { CommonObjectFields } from "../business-objects/common.js";

// ═══════════════════════════════════════════════════════════════════
// ENUMS (spec §9)
// ═══════════════════════════════════════════════════════════════════

/** Product Type — the kind of thing this product is. */
export const PRODUCT_TYPES = [
  "Core Platform",
  "Module",
  "Vertical Product",
  "Client Configuration",
  "Digital Product",
  "Service Offer",
  "Experimental Product",
] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];

/**
 * Product Status — the operational lifecycle of the product itself.
 * INDEPENDENT of `validationStage` (Built ≠ Product).
 */
export const PRODUCT_STATUSES = ["Active", "Development", "Hold", "Retired"] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

/**
 * Validation Stage — how far the product has progressed toward proven
 * commercial value. INDEPENDENT of `status`: a "Development" product can be at
 * "Idea", and a "Retired" one may have been "Repeat Sales".
 */
export const VALIDATION_STAGES = [
  "Idea",
  "Prototype",
  "Proof of Concept",
  "Pilot",
  "Paying Customer",
  "Repeat Sales",
  "Scaled",
  "Retired",
] as const;
export type ValidationStage = (typeof VALIDATION_STAGES)[number];

/** Revenue Model — how the product makes money. */
export const REVENUE_MODELS = [
  "Project Fee",
  "Subscription",
  "License",
  "Usage",
  "Hybrid",
] as const;
export type RevenueModel = (typeof REVENUE_MODELS)[number];

// ═══════════════════════════════════════════════════════════════════
// RECORD
// ═══════════════════════════════════════════════════════════════════

/**
 * A fully-materialized product record as stored + returned by the store.
 *
 * Extends the standardized `CommonObjectFields` (§25): `owner` is the accountable
 * **Product Owner** (commercial/product direction), `status` is the product
 * status (Active/Development/Hold/Retired), `priority` is P0–P3. Object-specific
 * product fields are added on top. Cross-object 🔗 links (Clients, Opportunities,
 * Projects, Decisions, Risks, Parent Product) live in the typed-edge relations
 * store (`src/relations`) — see `product_offered_in_opportunity`,
 * `project_delivers_product`, and `relates_to` — not as columns here.
 */
export interface Product extends CommonObjectFields {
  // ── Identification / classification ──
  /** Official working product name. */
  name: string;
  productType: ProductType | string;
  /** Active / Development / Hold / Retired. (inherited `status` field) */
  // status: ProductStatus | string;  ← provided by CommonObjectFields
  validationStage: ValidationStage | string;
  // ── Ownership (owner = Product Owner, from CommonObjectFields) ──
  /** Person accountable for technical architecture. */
  technicalOwner: string;
  // ── Commercial ──
  targetCustomer: string;
  problemSolved: string;
  valueProposition: string;
  revenueModel: RevenueModel | string;
  pricing: string;
  // ── Linkage (denormalized; authoritative graph is in src/relations) ──
  /** Core platform / product this one is built upon (relates_to, meta.role=parent). */
  parentProductId: string;
  // ── Planning ──
  roadmapLink: string;
  nextProductDecision: string;
  // ── Timestamps (Unix ms) ──
  createdAt: number;
  updatedAt: number;
}

/**
 * Fields accepted on create. `name` and a single accountable `owner` are the
 * hard requirements (§27 — a product without an owner is a wish). Everything
 * else defaults.
 */
export interface ProductCreateParams {
  name: string;
  /** Accountable Product Owner (exactly one — §27). */
  owner: string;
  productType?: string;
  status?: string;
  validationStage?: string;
  priority?: string;
  supportingOwner?: string;
  ceoRequired?: boolean;
  technicalOwner?: string;
  targetCustomer?: string;
  problemSolved?: string;
  valueProposition?: string;
  revenueModel?: string;
  pricing?: string;
  parentProductId?: string;
  roadmapLink?: string;
  nextProductDecision?: string;
  nextAction?: string;
  nextActionOwner?: string;
  nextActionDate?: string;
  clientId?: string;
  opportunityId?: string;
  projectId?: string;
  financialValue?: number;
  blocked?: boolean;
  blocker?: string;
  escalationRequired?: boolean;
  riskLevel?: string;
  dataQuality?: string;
  authorityLevel?: string;
  /** Optional idempotency key — a second create with the same id no-ops. */
  clientRequestId?: string;
}

/** Partial patch on update; `id` identifies the row. */
export interface ProductUpdateParams extends Partial<ProductCreateParams> {
  id: string;
}

export interface ProductSearchParams {
  query?: string;
  productType?: string;
  status?: string;
  validationStage?: string;
  revenueModel?: string;
  priority?: string;
  owner?: string;
  parentProductId?: string;
  /** Only return products updated after this Unix-ms timestamp. */
  since?: number;
  limit?: number;
}
