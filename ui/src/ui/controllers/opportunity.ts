/**
 * Opportunities controller — data + view state for the Opportunity Pipeline
 * (Business Control Layer, Object 2). Talks to the gateway `opportunity.*` RPCs
 * through the shared browser client.
 *
 * Kept self-contained (module-level state, like the issues view) so it needs no
 * changes to the integration-owned app-view-state. The view imports this state
 * object and the action functions; every mutation calls `app.requestUpdate()`
 * to re-render.
 */

import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";

// ── Enums (kept in sync with src/opportunity/types.ts) ──
export const OPPORTUNITY_TYPES = [
  "New Client",
  "Expansion",
  "Partnership",
  "Pilot",
  "Licensing",
  "Custom Build",
  "Other",
] as const;

/** Ordered pipeline — the board renders one column per stage in this order. */
export const PIPELINE_STAGES = [
  "New",
  "Qualification",
  "Discovery",
  "Evaluation",
  "Proposal",
  "Negotiation",
  "Won",
  "Lost",
  "Hold",
] as const;

export const TERMINAL_STAGES = ["Won", "Lost", "Hold"] as const;

export const REVENUE_TYPES = ["One-Time", "Recurring", "Hybrid"] as const;

/** §26 — four-level priority. */
export const PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
export const PRIORITY_LABELS: Record<string, string> = {
  P0: "Critical",
  P1: "High",
  P2: "Normal",
  P3: "Low",
};

// ── Types ──
export interface Opportunity {
  id: string;
  name: string;
  owner: string;
  supportingOwner?: string;
  ceoRequired?: boolean;
  opportunityType: string;
  stage: string;
  status: string;
  priority: string;
  problemNeed: string;
  proposedSolution: string;
  estimatedValue: number;
  revenueType: string;
  opportunityScore: number;
  expectedCloseDate: string;
  nextAction?: string;
  nextActionOwner?: string;
  nextActionDate?: string;
  waitingFor: string;
  reviewDate: string;
  clientId?: string;
  productId?: string;
  projectId?: string;
  proposalLink: string;
  notes: string;
  dataQuality?: string;
  authorityLevel?: string;
  blocked?: boolean;
  blocker?: string;
  escalationRequired?: boolean;
  createdAt: number;
  updatedAt: number;
  // Derived (server-computed)
  needsAction?: boolean;
  stale?: boolean;
}

export type OpportunityDraft = Partial<Opportunity> & { migrated?: boolean };

export interface OpportunityUIState {
  opportunities: Opportunity[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
  search: string;
  filterType: string;
  modalOpen: boolean;
  draft: OpportunityDraft;
  editingId: string | null;
  saving: boolean;
  /** Card being dragged (id) + the stage currently hovered, for the board DnD. */
  dragId: string | null;
  dragOverStage: string | null;
  /** Won-conversion prompt (§24): the opportunity awaiting a project decision. */
  convertFor: Opportunity | null;
  convertProjectId: string;
  converting: boolean;
  /**
   * Focus page (Notion-style full detail view). When set, the view renders
   * `renderOpportunityFocus` for this id instead of the pipeline board. Kept
   * here rather than in the view so deep-links / back-navigation can drive it.
   */
  focusId: string | null;
}

export function createInitialOpportunityState(): OpportunityUIState {
  return {
    opportunities: [],
    loading: false,
    loaded: false,
    error: null,
    search: "",
    filterType: "",
    modalOpen: false,
    draft: {},
    editingId: null,
    saving: false,
    dragId: null,
    dragOverStage: null,
    convertFor: null,
    convertProjectId: "",
    converting: false,
    focusId: null,
  };
}

/** Module-level singleton state (self-contained, mirrors the issues view). */
export const opportunityState: OpportunityUIState = createInitialOpportunityState();

function rerender(app: AppViewState) {
  app.requestUpdate?.();
}

// ── Load ──
export async function loadOpportunities(app: AppViewState, client: GatewayBrowserClient) {
  opportunityState.loading = true;
  opportunityState.error = null;
  try {
    const res = (await client.request("opportunity.list", {
      query: opportunityState.search || undefined,
      opportunityType: opportunityState.filterType || undefined,
    })) as { opportunities?: Opportunity[] };
    opportunityState.opportunities = res?.opportunities ?? [];
    opportunityState.loaded = true;
  } catch (e) {
    opportunityState.error = String(e);
  } finally {
    opportunityState.loading = false;
    rerender(app);
  }
}

// ── Modal lifecycle ──
export function openCreate(app: AppViewState) {
  opportunityState.editingId = null;
  opportunityState.error = null;
  opportunityState.draft = {
    opportunityType: "New Client",
    stage: "New",
    priority: "P2",
    revenueType: "One-Time",
    estimatedValue: 0,
    opportunityScore: 0,
    dataQuality: "Unknown",
  };
  opportunityState.modalOpen = true;
  rerender(app);
}

export function openEdit(app: AppViewState, opp: Opportunity) {
  opportunityState.editingId = opp.id;
  opportunityState.error = null;
  opportunityState.draft = { ...opp };
  opportunityState.modalOpen = true;
  rerender(app);
}

/** Open the full-page focus view for one opportunity. */
export function openFocus(app: AppViewState, id: string) {
  opportunityState.focusId = id;
  opportunityState.error = null;
  rerender(app);
}

/** Return from the focus view to the pipeline board. */
export function closeFocus(app: AppViewState) {
  opportunityState.focusId = null;
  rerender(app);
}

/** The focused opportunity, or null when the board is showing. */
export function focusedOpportunity(): Opportunity | null {
  if (!opportunityState.focusId) return null;
  return opportunityState.opportunities.find((o) => o.id === opportunityState.focusId) ?? null;
}

export function closeModal(app: AppViewState) {
  opportunityState.modalOpen = false;
  opportunityState.draft = {};
  opportunityState.editingId = null;
  opportunityState.error = null;
  rerender(app);
}

export function setDraft<K extends keyof OpportunityDraft>(
  app: AppViewState,
  key: K,
  value: OpportunityDraft[K],
) {
  opportunityState.draft = { ...opportunityState.draft, [key]: value };
  rerender(app);
}

// ── Save / delete ──
export async function saveOpportunity(app: AppViewState, client: GatewayBrowserClient) {
  const d = opportunityState.draft;
  if (!d.name?.trim()) {
    opportunityState.error = "Opportunity Name is required";
    rerender(app);
    return;
  }
  if (!d.owner?.trim()) {
    // §27 — one accountable owner. Surface it before the server round-trip.
    opportunityState.error = "An accountable Owner is required (an opportunity without one is a wish).";
    rerender(app);
    return;
  }
  opportunityState.saving = true;
  opportunityState.error = null;
  rerender(app);
  try {
    // Strip derived/read-only projections before writing.
    const { needsAction: _n, stale: _s, createdAt: _c, updatedAt: _u, ...payload } = d as Opportunity;
    if (opportunityState.editingId) {
      await client.request("opportunity.update", { ...payload, id: opportunityState.editingId });
    } else {
      await client.request("opportunity.create", { ...payload });
    }
    opportunityState.modalOpen = false;
    opportunityState.draft = {};
    opportunityState.editingId = null;
    await loadOpportunities(app, client);
  } catch (e) {
    opportunityState.error = String(e);
  } finally {
    opportunityState.saving = false;
    rerender(app);
  }
}

export async function deleteOpportunity(app: AppViewState, client: GatewayBrowserClient, id: string) {
  try {
    await client.request("opportunity.delete", { id });
    if (opportunityState.editingId === id) closeModal(app);
    await loadOpportunities(app, client);
  } catch (e) {
    opportunityState.error = String(e);
    rerender(app);
  }
}

/**
 * Move an opportunity to a new stage (board drag-drop or card control).
 * Transitioning INTO Won opens the §24 human-gated "Create Project?" prompt
 * rather than silently converting.
 */
export async function moveStage(
  app: AppViewState,
  client: GatewayBrowserClient,
  opp: Opportunity,
  stage: string,
) {
  if (opp.stage === stage) return;
  const prevStage = opp.stage;
  opp.stage = stage; // optimistic
  rerender(app);
  try {
    await client.request("opportunity.update", { id: opp.id, stage });
    if (prevStage !== "Won" && stage === "Won") {
      opportunityState.convertFor = opp;
      opportunityState.convertProjectId = "";
    }
    await loadOpportunities(app, client);
  } catch (e) {
    opp.stage = prevStage; // revert
    opportunityState.error = String(e);
    rerender(app);
  }
}

// ── §24 human-gated conversion ──
export function dismissConvert(app: AppViewState) {
  opportunityState.convertFor = null;
  opportunityState.convertProjectId = "";
  rerender(app);
}

export async function convertToProject(app: AppViewState, client: GatewayBrowserClient) {
  const opp = opportunityState.convertFor;
  const projectId = opportunityState.convertProjectId.trim();
  if (!opp || !projectId) return;
  opportunityState.converting = true;
  rerender(app);
  try {
    await client.request("opportunity.convert", { id: opp.id, projectId });
    opportunityState.convertFor = null;
    opportunityState.convertProjectId = "";
    await loadOpportunities(app, client);
  } catch (e) {
    opportunityState.error = String(e);
  } finally {
    opportunityState.converting = false;
    rerender(app);
  }
}

// ── Derived helpers for the view ──
export function opportunitiesByStage(): Record<string, Opportunity[]> {
  const out: Record<string, Opportunity[]> = {};
  for (const s of PIPELINE_STAGES) out[s] = [];
  for (const o of opportunityState.opportunities) {
    (out[o.stage] ?? (out[o.stage] = [])).push(o);
  }
  return out;
}

export function stageValue(list: Opportunity[]): number {
  return list.reduce((sum, o) => sum + (Number(o.estimatedValue) || 0), 0);
}
