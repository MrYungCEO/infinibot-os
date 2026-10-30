/**
 * People Network ("My Network") — shared types.
 *
 * The owner's relationship graph: the people they know (contacts), how those
 * people know each other and the owner (connections), what each connection is
 * worth (structured value), and which opportunities ride on them.
 *
 * - A **Contact** is one person in the network. It extends the standardized
 *   `CommonObjectFields` (§25) like every Business Control Layer object. A
 *   contact can point at an existing CRM Client (`clientId`, agency.db): the
 *   client is NOT copied — its name / channels / pipeline status are read live
 *   from the clients store and only network-specific fields live here.
 * - A **Connection** is an edge between two contacts, or between a contact and
 *   the owner (`ME_ID`). It carries the relationship type, strength 1-5,
 *   direction, the value list and the last touch date.
 * - Opportunities stay in `src/opportunity`; they are linked to contacts and
 *   connections through the shared typed-edge relations store (`src/relations`,
 *   edges `contact_involved_in_opportunity` / `connection_supports_opportunity`),
 *   and a contact linked to a client also sees that client's opportunities.
 */

import type { CommonObjectFields } from "../business-objects/common.js";

/** The owner's own node. Never stored as a contact row. */
export const ME_ID = "me";

// ═══════════════════════════════════════════════════════════════════
// ENUMS
// ═══════════════════════════════════════════════════════════════════

/** What kind of person this is to the owner (drives node colour). */
export const CONTACT_TYPES = [
  "client",
  "prospect",
  "partner",
  "investor",
  "advisor",
  "colleague",
  "vendor",
  "friend",
  "other",
] as const;
export type ContactType = (typeof CONTACT_TYPES)[number];

/** Relationship temperature of a contact. */
export const CONTACT_STATUSES = ["Active", "Warm", "Cold", "Dormant", "Archived"] as const;
export type ContactStatus = (typeof CONTACT_STATUSES)[number];

export const RELATIONSHIP_TYPES = [
  "introduced-by",
  "colleague",
  "partner",
  "investor",
  "client-of",
  "referral",
  "mentor",
  "friend",
  "vendor",
  "family",
  "other",
] as const;
export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

/**
 * Direction of a connection, read against its `fromId` → `toId`:
 * `mutual` (both ways), `forward` (from gives to / introduced to), `backward`.
 */
export const CONNECTION_DIRECTIONS = ["mutual", "forward", "backward"] as const;
export type ConnectionDirection = (typeof CONNECTION_DIRECTIONS)[number];

export const CONNECTION_STATUSES = ["Active", "Dormant", "Strained", "Ended"] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

/** What a connection gives the owner. */
export const VALUE_TYPES = [
  "intro-access",
  "revenue",
  "expertise",
  "capital",
  "distribution",
  "talent",
  "partnership",
  "influence",
  "support",
  "other",
] as const;
export type ValueType = (typeof VALUE_TYPES)[number];

/** Contact channels; every key optional. */
export interface ContactChannels {
  email?: string;
  phone?: string;
  linkedin?: string;
  x?: string;
  instagram?: string;
  telegram?: string;
  whatsapp?: string;
  website?: string;
  other?: string;
}
export const CHANNEL_KEYS = [
  "email",
  "phone",
  "linkedin",
  "x",
  "instagram",
  "telegram",
  "whatsapp",
  "website",
  "other",
] as const satisfies readonly (keyof ContactChannels)[];

/** One structured value item on a connection. */
export interface ConnectionValue {
  valueType: ValueType | string;
  /** Optional estimated dollar value (base currency units). */
  estimatedValue?: number;
  description: string;
}

// ═══════════════════════════════════════════════════════════════════
// RECORDS
// ═══════════════════════════════════════════════════════════════════

/** Live summary of the linked CRM client (read from agency.db, never stored). */
export interface LinkedClientSummary {
  id: string;
  name: string;
  pipelineStatus: string;
  email: string | null;
  phone: string | null;
}

export interface Contact extends CommonObjectFields {
  name: string;
  org: string;
  role: string;
  contactType: ContactType | string;
  tags: string[];
  channels: ContactChannels;
  notes: string;
  /** ISO date (YYYY-MM-DD) of the last touch with this person. */
  lastTouchDate: string;
  /** Optional link to a Business Hub contact row (hub.contacts). */
  hubContactId: string;
  /** Owner override of the computed warm score (0-100); null = use the formula. */
  warmOverride: number | null;
  createdAt: number;
  updatedAt: number;
  /** Derived on read when `clientId` is set and the client exists. */
  client?: LinkedClientSummary | null;
}

export interface Connection {
  id: string;
  fromId: string;
  toId: string;
  relationshipType: RelationshipType | string;
  /** 1 (weak) – 5 (strong). */
  strength: number;
  direction: ConnectionDirection | string;
  values: ConnectionValue[];
  /** ISO date (YYYY-MM-DD). */
  lastTouchDate: string;
  status: ConnectionStatus | string;
  notes: string;
  owner: string;
  createdAt: number;
  updatedAt: number;
}

/** One tracked change (status, strength, type, next action, links). */
export interface NetworkHistoryEntry {
  id: string;
  objectType: "contact" | "connection" | "opportunity";
  objectId: string;
  field: string;
  from: string;
  to: string;
  actor: string;
  at: number;
}

export interface ContactCreateParams {
  name?: string;
  org?: string;
  role?: string;
  contactType?: string;
  tags?: string[] | string;
  channels?: ContactChannels;
  notes?: string;
  status?: string;
  owner?: string;
  priority?: string;
  nextAction?: string;
  nextActionOwner?: string;
  nextActionDate?: string;
  lastTouchDate?: string;
  clientId?: string;
  hubContactId?: string;
  /** 0-100 to pin the warm score; null / "" clears the override. */
  warmOverride?: number | string | null;
  dataQuality?: string;
  authorityLevel?: string;
  clientRequestId?: string;
}
export interface ContactUpdateParams extends ContactCreateParams {
  id: string;
}

export interface ContactListParams {
  query?: string;
  contactType?: string;
  tag?: string;
  status?: string;
  clientId?: string;
  limit?: number;
}

export interface ConnectionCreateParams {
  fromId: string;
  toId: string;
  relationshipType?: string;
  strength?: number;
  direction?: string;
  values?: ConnectionValue[];
  lastTouchDate?: string;
  status?: string;
  notes?: string;
  owner?: string;
  clientRequestId?: string;
}
export interface ConnectionUpdateParams extends Partial<ConnectionCreateParams> {
  id: string;
}

// ═══════════════════════════════════════════════════════════════════
// GRAPH / CONTEXT SHAPES
// ═══════════════════════════════════════════════════════════════════

/** Compact opportunity view used by the graph, panel and AI context. */
export interface NetworkOpportunity {
  id: string;
  name: string;
  stage: string;
  open: boolean;
  estimatedValue: number;
  nextAction: string;
  nextActionDate: string;
  owner: string;
  /** How it is tied in: "contact" (direct), "client" (via the linked client), "connection". */
  via: "contact" | "client" | "connection";
  /** The contact / connection id it is tied to. */
  viaId: string;
  role?: string;
}

export interface NetworkNode {
  id: string;
  kind: "me" | "contact";
  name: string;
  org: string;
  role: string;
  contactType: string;
  status: string;
  tags: string[];
  clientId: string;
  isClient: boolean;
  client?: LinkedClientSummary | null;
  /** Sum of `$` value over this node's connections. */
  relationshipValue: number;
  /** Sum of estimated value over its open opportunities. */
  pipelineValue: number;
  openOpportunities: number;
  totalOpportunities: number;
  degree: number;
  lastTouchDate: string;
  /** Days since the last touch (contact or any of its connections); null if never. */
  staleDays: number | null;
  nextAction: string;
  nextActionDate: string;
  valueTypes: string[];
  /** Warm score 0-100 (override when set) — drives the ring layout. */
  warmScore: number;
  /** The formula's score, even when overridden. */
  warmComputed: number;
  warmOverridden: boolean;
  /** Ring band: inner | active | warmable | dormant. */
  warmBand: string;
  /** Points per factor (recency, strength, frequency, opportunities, reciprocity, links). */
  warmBreakdown: Record<string, number>;
  /** Warming / cooling vs the score ~a week ago (set by the service from history). */
  warmTrend: "warming" | "cooling" | "steady" | "new";
  warmDelta: number | null;
  /** Workspace objects linked to the person (projects, notes, tasks…). */
  linkedObjects: number;
}

export interface NetworkEdge {
  id: string;
  from: string;
  to: string;
  relationshipType: string;
  strength: number;
  direction: string;
  status: string;
  values: ConnectionValue[];
  valueTotal: number;
  lastTouchDate: string;
  openOpportunities: number;
}

export interface NetworkGraph {
  me: { id: string; label: string };
  nodes: NetworkNode[];
  edges: NetworkEdge[];
  opportunities: NetworkOpportunity[];
  stats: {
    contacts: number;
    clients: number;
    connections: number;
    openOpportunities: number;
    pipelineValue: number;
    relationshipValue: number;
    stale: number;
    /** Average warm score across contacts (0 when empty). */
    avgWarm: number;
    /** Contacts per ring band. */
    bands: Record<string, number>;
  };
  /** Clients with open opportunities that are not in the network yet. */
  suggestedClients: Array<{ id: string; name: string; openOpportunities: number }>;
}

export interface NetworkPath {
  found: boolean;
  /** Node ids from `me` (or the requested start) to the target. */
  nodeIds: string[];
  edgeIds: string[];
  /** Human readable, e.g. "You → Ana (colleague, 5) → Ben (introduced-by, 3)". */
  description: string;
  /** Weakest link strength along the path (0 when not found). */
  minStrength: number;
}
