/**
 * Decisions controller — data layer for the CEO decision queue (Object 6).
 *
 * Holds the view's module state and wraps the gateway `decision.*` RPCs so the
 * view stays purely presentational. Mirrors the shape of the other object
 * controllers but stays intentionally thin (the Decision store is authoritative
 * server-side; this is just load/save/delete + local UI state).
 */

import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";

// ── Enums (kept in sync with src/decision/types.ts) ──
export const DECISION_TYPES = [
  "Technical",
  "Product",
  "Strategic",
  "Financial",
  "Client",
  "Pricing",
  "Partnership",
  "Operational",
  "Legal",
  "Resource",
];

export const DECISION_STATUSES = [
  "Preparing",
  "Ready for Decision",
  "CEO Review",
  "Decided",
  "Deferred",
  "Cancelled",
];

/** The two statuses that place a decision on the CEO Queue. */
export const CEO_QUEUE_STATUSES = ["Ready for Decision", "CEO Review"];

export const PRIORITIES = ["P0", "P1", "P2", "P3"];
export const PRIORITY_LABELS: Record<string, string> = {
  P0: "Critical",
  P1: "High",
  P2: "Normal",
  P3: "Low",
};

// ── Types ──
export interface Decision {
  id: string;
  title: string;
  decisionType: string;
  status: string;
  owner: string;
  supportingOwner?: string;
  ceoRequired?: boolean;
  requestedBy: string;
  clientId?: string;
  opportunityId?: string;
  projectId?: string;
  productId?: string;
  issueId?: string;
  decisionRequired: string;
  options: string;
  recommendation: string;
  decisionDeadline: string;
  priority: string;
  finalDecision: string;
  decisionDate: string;
  rationale: string;
  dataQuality?: string;
  authorityLevel?: string;
  lastUpdated?: number;
  createdAt: number;
  updatedAt: number;
}

export type DecisionDraft = Partial<Decision>;

export interface DecisionsUIState {
  decisions: Decision[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
  search: string;
  filterStatus: string;
  filterType: string;
  /** When true, the view shows the CEO-Queue subset (queued statuses). */
  ceoQueueOnly: boolean;
  modalOpen: boolean;
  draft: DecisionDraft;
  editingId: string | null;
  saving: boolean;
}

export const decisionState: DecisionsUIState = {
  decisions: [],
  loading: false,
  loaded: false,
  error: null,
  search: "",
  filterStatus: "",
  filterType: "",
  ceoQueueOnly: false,
  modalOpen: false,
  draft: {},
  editingId: null,
  saving: false,
};

function rerender(app: AppViewState) {
  app.requestUpdate?.();
}

/** Rank for client-side sorting: P0 → 0 (most urgent). */
export function priorityRank(p: string | undefined): number {
  switch (String(p ?? "").toUpperCase()) {
    case "P0":
      return 0;
    case "P1":
      return 1;
    case "P2":
      return 2;
    case "P3":
      return 3;
    default:
      return 4;
  }
}

// ── Data ──
export async function loadDecisions(app: AppViewState, client: GatewayBrowserClient) {
  decisionState.loading = true;
  decisionState.error = null;
  try {
    if (decisionState.ceoQueueOnly) {
      const res = (await client.request("decision.ceoQueue", {})) as { decisions?: Decision[] };
      decisionState.decisions = res?.decisions ?? [];
    } else {
      const res = (await client.request("decision.list", {
        query: decisionState.search || undefined,
        status: decisionState.filterStatus || undefined,
        decisionType: decisionState.filterType || undefined,
      })) as { decisions?: Decision[] };
      decisionState.decisions = res?.decisions ?? [];
    }
    decisionState.loaded = true;
  } catch (e) {
    decisionState.error = String(e);
  } finally {
    decisionState.loading = false;
    rerender(app);
  }
}

export async function saveDecision(
  app: AppViewState,
  client: GatewayBrowserClient,
): Promise<boolean> {
  decisionState.saving = true;
  decisionState.error = null;
  const payload = { ...decisionState.draft };
  try {
    if (decisionState.editingId) {
      await client.request("decision.update", { ...payload, id: decisionState.editingId });
    } else {
      await client.request("decision.create", { ...payload });
    }
    decisionState.modalOpen = false;
    decisionState.draft = {};
    decisionState.editingId = null;
    await loadDecisions(app, client);
    return true;
  } catch (e) {
    decisionState.error = String(e);
    return false;
  } finally {
    decisionState.saving = false;
    rerender(app);
  }
}

export async function deleteDecision(
  app: AppViewState,
  client: GatewayBrowserClient,
  id: string,
) {
  try {
    await client.request("decision.delete", { id });
    await loadDecisions(app, client);
  } catch (e) {
    decisionState.error = String(e);
    rerender(app);
  }
}

export function openCreate(app: AppViewState) {
  decisionState.editingId = null;
  decisionState.error = null;
  decisionState.draft = {
    decisionType: "Strategic",
    status: "Preparing",
    priority: "P2",
    dataQuality: "Unknown",
    authorityLevel: "L1",
    decisionDeadline: "",
  };
  decisionState.modalOpen = true;
  rerender(app);
}

export function openEdit(app: AppViewState, decision: Decision) {
  decisionState.editingId = decision.id;
  decisionState.error = null;
  decisionState.draft = { ...decision };
  decisionState.modalOpen = true;
  rerender(app);
}

export function closeModal(app: AppViewState) {
  decisionState.modalOpen = false;
  decisionState.draft = {};
  decisionState.editingId = null;
  decisionState.error = null;
  rerender(app);
}
