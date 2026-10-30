/**
 * Work-allocation oversight controller.
 *
 * The Work-allocation tab of Agency Operations is a live mission-control board.
 * The autonomy Kanban, per-item execution detail, approvals and capacity all
 * come from the Daily-Operations state (`agencyDailyState`) — this controller
 * does NOT duplicate that; it drives the shared state and layers two things on
 * top that oversight needs and Daily Ops does not surface as a list:
 *
 *   1. open escalations (`agency.ops.escalations.list`), and
 *   2. a live subscription that repaints THIS tab on `agency.work.updated`
 *      (Daily Ops guards its own refetch to its own tab, so a second, tab-aware
 *      subscription is required here rather than reusing that singleton).
 *
 * Everything else the tab shows is read straight off `agencyDailyState` and
 * `agencyOperationsState`, so there is one source of truth for the board.
 */

import type { GatewayBrowserClient } from "../gateway";
import { attempt, errorMessage, resolveAgency, unwrap } from "./agency-common";
import {
  WORK_ITEM_EVENT,
  ensureAgencyDailyState,
  loadAgencyDaily,
  type AgencyDailyHost,
} from "./agency-daily";

/**
 * One open escalation. The gateway RPC is owned by the backend and may predate
 * this build, so every field past `id`/`title` is optional and read
 * defensively — the panel degrades to a title rather than throwing.
 */
export interface AgencyEscalation {
  id: string;
  title: string;
  workItemId: string | null;
  workerId: string | null;
  workerName: string | null;
  reason: string | null;
  risk: string | null;
  level: number | null;
  createdAt: number | null;
}

export interface AgencyOversightState {
  loading: boolean;
  loadedAt: number | null;
  escalations: AgencyEscalation[];
  /** RPCs this controller (not the daily loader) could not reach. */
  failed: string[];
  /** Set by the `agency.work.updated` broadcast so the board shows it is live. */
  liveAt: number | null;
  /** True when the escalations RPC is absent from this gateway build. */
  escalationsUnavailable: boolean;
}

/**
 * The oversight tab hangs off the same app host as the daily board and the
 * operations surface, so it can read all three states from one object.
 */
export interface AgencyOversightHost extends AgencyDailyHost {
  agencyOversightState?: AgencyOversightState | null;
  agencyOperationsState?: { activeSection?: string } | null;
}

export function createAgencyOversightState(): AgencyOversightState {
  return {
    loading: false,
    loadedAt: null,
    escalations: [],
    failed: [],
    liveAt: null,
    escalationsUnavailable: false,
  };
}

export function ensureAgencyOversightState(host: AgencyOversightHost): AgencyOversightState {
  if (!host.agencyOversightState) host.agencyOversightState = createAgencyOversightState();
  return host.agencyOversightState;
}

function notify(host: AgencyOversightHost): void {
  host.requestUpdate?.();
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * Normalises whatever the escalations RPC returns into a stable row shape.
 * Accepts the two common envelope keys (`escalations` / `items`) and reads each
 * field under a few plausible names so a schema drift on the backend degrades
 * gracefully instead of blanking the panel.
 */
function normaliseEscalations(result: unknown): AgencyEscalation[] {
  const escalations = unwrap<Record<string, unknown>[]>(result, "escalations", []);
  const rows = escalations.length
    ? escalations
    : unwrap<Record<string, unknown>[]>(result, "items", []);
  const list = Array.isArray(rows) ? rows : [];
  return list
    .map((row, index) => {
      const id = str(row.id) ?? str(row.escalationId) ?? String(index);
      const title =
        str(row.title) ??
        str(row.workItemTitle) ??
        str(row.summary) ??
        str(row.reason) ??
        "Escalation";
      return {
        id,
        title,
        workItemId: str(row.workItemId) ?? str(row.entityId),
        workerId: str(row.workerId),
        workerName: str(row.workerName) ?? str(row.assignee),
        reason: str(row.reason) ?? str(row.detail) ?? str(row.note),
        risk: str(row.risk) ?? str(row.severity),
        level: num(row.level) ?? num(row.escalationLevel),
        createdAt: num(row.createdAt) ?? num(row.raisedAt) ?? num(row.updatedAt),
      } satisfies AgencyEscalation;
    })
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

/**
 * Loads (or refreshes) the oversight tab. Kicks the shared daily board load —
 * background once it has data — and fetches open escalations. A missing
 * escalations RPC is not an error the operator can act on, so it is recorded as
 * "unavailable" rather than pushed onto the failure banner.
 */
export async function loadAgencyOversight(
  host: AgencyOversightHost,
  client: GatewayBrowserClient,
): Promise<void> {
  const state = ensureAgencyOversightState(host);
  const daily = ensureAgencyDailyState(host);
  state.loading = true;
  notify(host);

  // The board is the daily state; drive it rather than re-fetching work items.
  void loadAgencyDaily(host, client, { background: daily.lastLoadedAt !== null });

  const failures: string[] = [];
  try {
    const { agencyId } = await resolveAgency(client, failures);
    if (agencyId) {
      const result = await attempt(client, failures, "agency.ops.escalations.list", { agencyId });
      if (result) {
        state.escalations = normaliseEscalations(result);
        state.escalationsUnavailable = false;
      } else {
        // `attempt` swallowed a method-not-found or transport error; the entry
        // is already in `failures`. Fall back to escalated work items so the
        // panel is never empty when the board clearly has escalations.
        state.escalationsUnavailable = true;
      }
    }
  } catch (error) {
    failures.push(`agency.ops.escalations.list — ${errorMessage(error)}`);
  } finally {
    state.failed = failures;
    state.loadedAt = Date.now();
    state.loading = false;
    notify(host);
  }
}

// ── Live updates ───────────────────────────────────────────────────────────

let unsubscribe: (() => void) | null = null;
let refetchTimer: number | null = null;

/**
 * Subscribes to `agency.work.updated` for the oversight tab. Independent of the
 * Daily-Ops subscription (which is scoped to its own tab) so this board repaints
 * live while the operator is on Work allocation. Idempotent.
 */
export function subscribeAgencyOversight(
  host: AgencyOversightHost,
  client: GatewayBrowserClient,
): void {
  if (unsubscribe) return;
  unsubscribe = client.subscribe((event) => {
    if (event.event !== WORK_ITEM_EVENT) return;
    const state = host.agencyOversightState;
    if (!state) return;
    const payload = (event.payload ?? {}) as { agencyId?: string };
    const daily = host.agencyDailyState;
    if (payload.agencyId && daily?.agencyId && payload.agencyId !== daily.agencyId) return;
    state.liveAt = Date.now();
    // Only refetch while the operator is actually looking at this tab.
    if (host.agencyOperationsState?.activeSection !== "allocation") return;
    if (refetchTimer !== null) return;
    refetchTimer = window.setTimeout(() => {
      refetchTimer = null;
      void loadAgencyOversight(host, client);
    }, 400);
  });
}
