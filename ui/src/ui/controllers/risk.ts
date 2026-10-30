/**
 * Risk Register controller — module state + data loading + CRUD for the
 * Risk Register view (Object 7). Talks to the gateway `risk.*` RPCs via the
 * shared browser client. Kept separate from the view so the render layer stays
 * declarative (mirrors the controllers/views split used elsewhere in the UI).
 */

import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";

// ── Enums (kept in sync with src/risk/types.ts) ──
export const RISK_CATEGORIES = [
  "Financial",
  "Technical",
  "Delivery",
  "Client",
  "Security",
  "Privacy",
  "Legal",
  "Compliance",
  "IP",
  "Capacity",
  "Vendor",
  "Reputational",
  "Founder Dependency",
];
export const RISK_STATUSES = ["Open", "Monitoring", "Mitigated", "Closed"];
export const RISK_PRIORITIES = ["P0", "P1", "P2", "P3"];
export const MATRIX_SCALE = [1, 2, 3, 4, 5];
/** Score at/above which a risk is critical — mirrors CRITICAL_RISK_SCORE. */
export const CRITICAL_RISK_SCORE = 12;

// ── Types ──
export interface Risk {
  id: string;
  title: string;
  category: string;
  owner: string;
  supportingOwner?: string;
  ceoRequired?: boolean;
  status: string;
  priority: string;
  nextAction?: string;
  nextActionOwner?: string;
  nextActionDate?: string;
  clientId?: string;
  opportunityId?: string;
  projectId?: string;
  productId?: string;
  issueId?: string;
  decisionId?: string;
  probability: number;
  impact: number;
  riskScore: number;
  mitigation: string;
  nextReviewDate: string;
  riskLevel?: string;
  financialValue?: number;
  dataQuality?: string;
  authorityLevel?: string;
  createdAt: number;
  updatedAt: number;
}

export type RiskDraft = Partial<Risk>;

export interface RiskUIState {
  risks: Risk[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
  search: string;
  filterStatus: string;
  filterCategory: string;
  criticalOnly: boolean;
  modalOpen: boolean;
  draft: RiskDraft;
  editingId: string | null;
  saving: boolean;
}

export const state: RiskUIState = {
  risks: [],
  loading: false,
  loaded: false,
  error: null,
  search: "",
  filterStatus: "",
  filterCategory: "",
  criticalOnly: false,
  modalOpen: false,
  draft: {},
  editingId: null,
  saving: false,
};

export function rerender(app: AppViewState) {
  app.requestUpdate?.();
}

// ── Pure helpers (mirror src/risk/types.ts) ──
export function clampMatrix(v: number | undefined | null): number {
  const n = Math.round(Number(v ?? 1));
  if (!Number.isFinite(n)) return 1;
  return Math.min(5, Math.max(1, n));
}

export function computeScore(probability: number | undefined, impact: number | undefined): number {
  return clampMatrix(probability) * clampMatrix(impact);
}

export function riskBand(score: number): "Low" | "Medium" | "High" | "Critical" {
  if (score >= CRITICAL_RISK_SCORE) return "Critical";
  if (score >= 8) return "High";
  if (score >= 4) return "Medium";
  return "Low";
}

/** Colour for a 1–25 score band (heatmap cells + score chips). */
export function scoreColor(score: number): string {
  const band = riskBand(score);
  if (band === "Critical") return "#f87171";
  if (band === "High") return "#fb923c";
  if (band === "Medium") return "#fbbf24";
  return "#4ade80";
}

export function statusColor(st: string): string {
  switch (st) {
    case "Mitigated":
      return "#34d399";
    case "Closed":
      return "#71717a";
    case "Monitoring":
      return "#fbbf24";
    default:
      return "#f87171"; // Open
  }
}

/** Is the review overdue? Mirrors the store's §29 surfacing for the row badge. */
export function isReviewOverdue(r: Risk, now = Date.now()): boolean {
  if (r.status === "Closed") return false;
  if (!r.nextReviewDate) return false;
  return r.nextReviewDate < new Date(now).toISOString().slice(0, 10);
}

// ── Data ──
export async function loadRisks(app: AppViewState, client: GatewayBrowserClient) {
  state.loading = true;
  state.error = null;
  try {
    const res = (await client.request("risk.list", {
      query: state.search || undefined,
      status: state.filterStatus || undefined,
      category: state.filterCategory || undefined,
      criticalOnly: state.criticalOnly || undefined,
    })) as { risks?: Risk[] };
    state.risks = res?.risks ?? [];
    state.loaded = true;
  } catch (e) {
    state.error = String(e);
  } finally {
    state.loading = false;
    rerender(app);
  }
}

export function openCreate(app: AppViewState) {
  state.editingId = null;
  state.error = null;
  state.draft = {
    category: "Delivery",
    status: "Open",
    priority: "P2",
    probability: 3,
    impact: 3,
    owner: "",
    mitigation: "",
    nextReviewDate: "",
    dataQuality: "Unknown",
  };
  state.modalOpen = true;
  rerender(app);
}

export function openEdit(app: AppViewState, risk: Risk) {
  state.editingId = risk.id;
  state.error = null;
  state.draft = { ...risk };
  state.modalOpen = true;
  rerender(app);
}

export function closeModal(app: AppViewState) {
  state.modalOpen = false;
  state.draft = {};
  state.editingId = null;
  state.error = null;
  rerender(app);
}

export function set<K extends keyof RiskDraft>(app: AppViewState, key: K, value: RiskDraft[K]) {
  state.draft = { ...state.draft, [key]: value };
  rerender(app);
}

export async function saveRisk(app: AppViewState, client: GatewayBrowserClient) {
  if (!state.draft.title?.trim()) {
    state.error = "Risk Title is required";
    rerender(app);
    return;
  }
  if (!state.draft.owner?.trim()) {
    // §27: one accountable owner. Fail early with a clear message rather than
    // letting the server's assertSingleOwner throw an opaque error.
    state.error = "An accountable Owner is required (a risk without an owner is a wish).";
    rerender(app);
    return;
  }
  state.saving = true;
  state.error = null;
  rerender(app);
  try {
    // riskScore is computed server-side — never send it.
    const { riskScore: _drop, riskLevel: _drop2, ...payload } = state.draft;
    if (state.editingId) {
      await client.request("risk.update", { ...payload, id: state.editingId });
    } else {
      await client.request("risk.create", { ...payload });
    }
    state.modalOpen = false;
    state.draft = {};
    state.editingId = null;
    await loadRisks(app, client);
  } catch (e) {
    state.error = String(e);
  } finally {
    state.saving = false;
    rerender(app);
  }
}

export async function deleteRisk(app: AppViewState, client: GatewayBrowserClient, id: string) {
  try {
    await client.request("risk.delete", { id });
    if (state.editingId === id) closeModal(app);
    await loadRisks(app, client);
  } catch (e) {
    state.error = String(e);
    rerender(app);
  }
}
