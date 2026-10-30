/**
 * Bridging /clients (the legacy CRM) to the agency operating system.
 *
 * `/clients` reads `business.clients.*` — business.json plus the Notion mirror.
 * Invoicing, revenue, projects, tasks and the real pipeline status all live in
 * `agency.db` behind `agency.ops.*`. The two stores are already bridged by
 * `legacy_entity_mappings`, but nothing in the CRM detail modal ever crossed
 * over, so the owner had a client record with no money on it.
 *
 * This module resolves one legacy client to its agency counterpart and loads
 * just enough agency state for the existing invoicing modules to run. It does
 * **not** re-implement any of it: the composer, the money arithmetic, the
 * payment controls and the per-client revenue rollup all come from
 * `controllers/agency-invoicing.ts`.
 *
 * Three rules shape it.
 *
 * **The resolve is evidence-based, not string-built.** The deterministic id
 * `legacy-client:<agencyId>:<legacyId>` is only ever *looked up* in the real
 * `agency.ops.clients.list` result — it is never assumed to exist. When the
 * CRM has been re-imported from Notion the legacy ids no longer match the ids
 * the mapping table was built from, so a case-folded name match is the second
 * pass. Which pass matched is reported to the operator, and an ambiguous name
 * says so rather than silently picking a row.
 *
 * **A client with no agency counterpart says so.** It is offered a create,
 * never a panel of zeros that reads as "this client has never been billed".
 *
 * **A call this gateway build does not serve is named.** Every failure lands in
 * the link's own `failedCalls` as well as the shared agency banner.
 */

import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";
// Types only. `controllers/clients.ts` imports `ClientAgencyLink` back from
// here, so a runtime edge in either direction would be an import cycle; the
// display name is passed in by the caller instead of reached for.
import type { ClientsState, DynamicClientRecord } from "./clients";
import {
  ensureAgencyOperationsState,
  type AgencyClient,
  type AgencyOperationsState,
  type AgencyProjectSummary,
  type AgencyTaskSummary,
} from "./agency-operations";
import { closeClientRevenue, loadClientRevenue } from "./agency-invoicing";

/** The one RPC without which none of this tab can exist. */
export const AGENCY_CLIENTS_METHOD = "agency.ops.clients.list";

export type AgencyLinkPhase = "idle" | "loading" | "ready" | "unsupported" | "error";

export interface ClientAgencyLink {
  /** Legacy record this link was resolved for; guards stale renders. */
  legacyClientId: string | null;
  phase: AgencyLinkPhase;
  /** Fatal reason the link could not be resolved at all. */
  error: string | null;
  /** Named RPCs that failed while loading. Never swallowed. */
  failedCalls: string[];
  agencyId: string | null;
  /** `null` once `phase === "ready"` means: genuinely no counterpart. */
  agencyClientId: string | null;
  matchedBy: "record-link" | "name" | null;
  /** >1 when several agency clients share the legacy name. */
  nameCandidates: number;
  creating: boolean;
  createError: string | null;
  createNotice: string | null;
}

export function createClientAgencyLink(): ClientAgencyLink {
  return {
    legacyClientId: null,
    phase: "idle",
    error: null,
    failedCalls: [],
    agencyId: null,
    agencyClientId: null,
    matchedBy: null,
    nameCandidates: 0,
    creating: false,
    createError: null,
    createNotice: null,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Case-folded, whitespace-collapsed name key.
 *
 * Mirrors how the migration wrote agency client names out of the same legacy
 * titles, so " Lu  Sanda Couture " and "Lu Sanda Couture" are one client.
 */
function nameKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/** The billing email a legacy record carries, if any of the usual keys hold one. */
export function legacyBillingEmail(record: DynamicClientRecord): string | null {
  const data = record.data ?? {};
  for (const key of Object.keys(data)) {
    if (!/e-?mail/i.test(key)) continue;
    const value = data[key];
    if (typeof value === "string" && value.includes("@")) return value.trim();
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Focused agency bootstrap
 * ------------------------------------------------------------------ */

/**
 * How long a loaded agency slice is reused before it is refetched.
 *
 * `loadAgencyOperations` fires twenty-odd RPCs; opening a CRM record must not.
 * Only the five collections the invoicing modules actually read are fetched
 * here, and only when they are stale.
 */
const AGENCY_SLICE_TTL_MS = 60_000;
const sliceLoadedAt = new Map<string, number>();

function unwrap<T>(response: unknown, key: string, fallback: T): T {
  if (!response || typeof response !== "object") return fallback;
  const value = (response as Record<string, unknown>)[key];
  return value === undefined || value === null ? fallback : (value as T);
}

async function attempt(
  client: GatewayBrowserClient,
  failures: string[],
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  try {
    return await client.request(method, params);
  } catch (error) {
    const entry = `${method} — ${message(error)}`;
    if (!failures.includes(entry)) failures.push(entry);
    return null;
  }
}

/**
 * Chooses the agency for this CRM.
 *
 * The agency id and the business id are the same value for a migrated
 * workspace, so the active business is tried first and only falls back to the
 * owned agency when it is not one.
 */
function pickAgencyId(state: AppViewState, aops: AgencyOperationsState): string | null {
  const activeBusinessId = state.businessState?.activeBusinessId ?? null;
  const has = (id: string | null) => Boolean(id) && aops.agencies.some((a) => a.id === id);
  if (has(activeBusinessId)) return activeBusinessId;
  if (has(aops.selectedAgencyId)) return aops.selectedAgencyId;
  return aops.agencies.find((a) => a.role === "owner")?.id ?? aops.agencies[0]?.id ?? null;
}

/**
 * Loads the clients, projects, tasks, invoices and revenue currency the
 * invoicing surfaces read. Every call is fault-isolated and records its own
 * failure, so a partial load is visible rather than looking like empty data.
 */
async function loadAgencySlice(
  aops: AgencyOperationsState,
  client: GatewayBrowserClient,
  agencyId: string,
  failures: string[],
  force: boolean,
): Promise<void> {
  const loadedAt = sliceLoadedAt.get(agencyId) ?? 0;
  const fresh = Date.now() - loadedAt < AGENCY_SLICE_TTL_MS && aops.clients.length > 0;
  if (fresh && !force) return;

  const [clientsResult, projectsResult, tasksResult, invoicesResult, revenueResult] =
    await Promise.all([
      attempt(client, failures, AGENCY_CLIENTS_METHOD, { agencyId }),
      attempt(client, failures, "agency.ops.projects.list", { agencyId }),
      attempt(client, failures, "agency.ops.tasks.list", { agencyId }),
      attempt(client, failures, "agency.ops.invoices.list", { agencyId }),
      attempt(client, failures, "agency.ops.revenue.summary", { agencyId }),
    ]);

  // A failed call keeps whatever was already loaded. Overwriting with [] would
  // turn an outage into "this agency has no clients".
  if (clientsResult) aops.clients = unwrap(clientsResult, "clients", aops.clients);
  if (projectsResult) aops.projects = unwrap(projectsResult, "projects", aops.projects);
  if (tasksResult) aops.tasks = unwrap(tasksResult, "tasks", aops.tasks);
  if (invoicesResult) aops.invoices = unwrap(invoicesResult, "invoices", aops.invoices);
  if (revenueResult) {
    aops.revenue = unwrap(revenueResult, "revenue", aops.revenue);
    aops.revenueEntries = unwrap(revenueResult, "entries", aops.revenueEntries);
    aops.clientRevenueProfiles = unwrap(revenueResult, "clientProfiles", aops.clientRevenueProfiles);
  }
  if (clientsResult) sliceLoadedAt.set(agencyId, Date.now());
}

/* ------------------------------------------------------------------ *
 * Resolve
 * ------------------------------------------------------------------ */

export interface AgencyClientMatch {
  client: AgencyClient | null;
  matchedBy: "record-link" | "name" | null;
  /** Number of agency clients carrying the same name. */
  nameCandidates: number;
}

/**
 * Resolves a legacy client id + name to the agency client row.
 *
 * Pass 1 looks the deterministic mapping id up in the real list — present only
 * when the CRM ids still match the ones the migration keyed on. Pass 2 folds
 * the name. Ties are broken by the row carrying actual activity, then by the
 * most recently updated, and the tie count is returned so the UI can admit the
 * ambiguity instead of hiding it.
 */
export function resolveAgencyClient(
  clients: readonly AgencyClient[],
  agencyId: string,
  legacyClientId: string,
  legacyName: string,
): AgencyClientMatch {
  const linked = clients.find((entry) => entry.id === `legacy-client:${agencyId}:${legacyClientId}`);
  if (linked) return { client: linked, matchedBy: "record-link", nameCandidates: 1 };

  const key = nameKey(legacyName);
  if (!key) return { client: null, matchedBy: null, nameCandidates: 0 };
  const candidates = clients.filter((entry) => nameKey(entry.name ?? "") === key);
  if (candidates.length === 0) return { client: null, matchedBy: null, nameCandidates: 0 };
  const best = [...candidates].sort((a, b) => {
    const activity = (entry: AgencyClient) =>
      (entry.invoiceCount ?? 0) + (entry.projectCount ?? 0) + (entry.outstandingCents ?? 0 ? 1 : 0);
    return activity(b) - activity(a) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  })[0];
  return { client: best, matchedBy: "name", nameCandidates: candidates.length };
}

/* ------------------------------------------------------------------ *
 * Entry points
 * ------------------------------------------------------------------ */

function linkState(cs: ClientsState): ClientAgencyLink {
  cs.agencyLink ??= createClientAgencyLink();
  return cs.agencyLink;
}

/**
 * Resolves the open CRM record against the agency store and loads its invoice
 * history. Safe to call repeatedly — it no-ops while already loading for the
 * same record unless `force` is set.
 *
 * `legacyName` is the display name the CRM already derived from the Notion
 * title property; deriving it again here would mean importing the CRM
 * controller and creating an import cycle.
 */
export async function loadClientAgencyLink(
  state: AppViewState,
  client: GatewayBrowserClient,
  legacyName: string,
  options: { force?: boolean } = {},
): Promise<void> {
  const cs = state.businessState?._clientsState;
  const record = cs?.detailClient;
  if (!cs || !record) return;
  const link = linkState(cs);
  if (
    !options.force &&
    link.legacyClientId === record.id &&
    (link.phase === "loading" || link.phase === "ready")
  ) {
    return;
  }

  const aops = ensureAgencyOperationsState(state);
  Object.assign(link, createClientAgencyLink(), {
    legacyClientId: record.id,
    phase: "loading" as AgencyLinkPhase,
  });
  state.requestUpdate?.();

  if (!client.supports(AGENCY_CLIENTS_METHOD)) {
    link.phase = "unsupported";
    state.requestUpdate?.();
    return;
  }

  const failures: string[] = [];
  try {
    if (aops.agencies.length === 0) {
      const agenciesResult = await attempt(client, failures, "agency.ops.agencies.list", {});
      aops.agencies = unwrap(agenciesResult, "agencies", aops.agencies);
    }
    const agencyId = pickAgencyId(state, aops);
    if (!agencyId) {
      link.phase = "error";
      link.failedCalls = failures;
      link.error =
        failures.length > 0
          ? "The agency directory could not be read, so this client cannot be matched."
          : "No agency workspace exists yet, so there is nothing to bill this client from.";
      state.requestUpdate?.();
      return;
    }
    aops.selectedAgencyId = agencyId;
    link.agencyId = agencyId;

    await loadAgencySlice(aops, client, agencyId, failures, options.force === true);
    // The record can be closed or swapped while the slice loads.
    if (cs.detailClient?.id !== record.id) return;

    const match = resolveAgencyClient(aops.clients, agencyId, record.id, legacyName);
    link.agencyClientId = match.client?.id ?? null;
    link.matchedBy = match.matchedBy;
    link.nameCandidates = match.nameCandidates;
    link.failedCalls = failures;
    link.phase = "ready";
    state.requestUpdate?.();

    if (match.client) {
      // Reuses the invoicing controller's own rollup so the money on this tab
      // and the money on Agency Operations come from one implementation.
      await loadClientRevenue(state, client, match.client.id);
    } else {
      closeClientRevenue(state);
    }
  } catch (error) {
    link.phase = "error";
    link.error = message(error);
    link.failedCalls = failures;
  } finally {
    state.requestUpdate?.();
  }
}

/** Drops the per-client revenue detail when the CRM modal closes. */
export function resetClientAgencyLink(state: AppViewState): void {
  const cs = state.businessState?._clientsState;
  if (!cs) return;
  cs.agencyLink = createClientAgencyLink();
  closeClientRevenue(state);
}

/**
 * Creates the missing agency counterpart for the open CRM record.
 *
 * The new row carries the legacy name and billing email so the name-fold
 * resolve above picks it up immediately afterwards.
 */
export async function createAgencyCounterpart(
  state: AppViewState,
  client: GatewayBrowserClient,
  legacyName: string,
): Promise<void> {
  const cs = state.businessState?._clientsState;
  const record = cs?.detailClient;
  if (!cs || !record) return;
  const link = linkState(cs);
  if (link.creating || !link.agencyId) return;
  const method = "agency.ops.clients.create";
  if (!client.supports(method)) {
    link.createError = `This gateway build does not serve ${method}.`;
    state.requestUpdate?.();
    return;
  }
  const name = legacyName.trim();
  if (!name) {
    link.createError = "Give this client a name before creating its agency record.";
    state.requestUpdate?.();
    return;
  }

  link.creating = true;
  link.createError = null;
  link.createNotice = null;
  state.requestUpdate?.();
  try {
    await client.request(method, {
      agencyId: link.agencyId,
      name,
      billingEmail: legacyBillingEmail(record) ?? undefined,
      pipelineStatus: "Lead",
    });
    link.createNotice = `Created an agency record for ${name}.`;
    await loadClientAgencyLink(state, client, legacyName, { force: true });
  } catch (error) {
    link.createError = `${method} — ${message(error)}`;
  } finally {
    link.creating = false;
    state.requestUpdate?.();
  }
}

/* ------------------------------------------------------------------ *
 * Selectors
 * ------------------------------------------------------------------ */

export function agencyClientRecord(
  aops: AgencyOperationsState,
  link: ClientAgencyLink,
): AgencyClient | null {
  if (!link.agencyClientId) return null;
  return aops.clients.find((entry) => entry.id === link.agencyClientId) ?? null;
}

export function agencyProjectsForClient(
  aops: AgencyOperationsState,
  agencyClientId: string,
): AgencyProjectSummary[] {
  return aops.projects.filter((project) => project.clientId === agencyClientId);
}

export function agencyTasksForProjects(
  aops: AgencyOperationsState,
  projects: readonly AgencyProjectSummary[],
): AgencyTaskSummary[] {
  const ids = new Set(projects.map((project) => project.id));
  return aops.tasks.filter((task) => ids.has(task.projectId));
}
