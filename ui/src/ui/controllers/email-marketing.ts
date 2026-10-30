/**
 * Email Marketing controller — front-end state for the Loops.so dashboard.
 */
import type { GatewayBrowserClient } from "../gateway.js";
import type { AppViewState } from "../app-view-state.js";

export interface MailingList {
  id: string;
  name: string;
  isPublic: boolean;
  description?: string | null;
}

export interface CustomProperty {
  key: string;
  label: string;
  type: string;
}

export interface StoredGroup {
  id: string;
  name: string;
  description: string | null;
  source: "loops" | "crm-segment";
  filter: { table: "clients" | "leads"; where?: Record<string, string> } | null;
  memberCount: number;
  syncedAt: number;
}

export interface KpiSummary {
  windowMs: number;
  since: number;
  totals: Record<string, number>;
  byCampaign: Array<{
    campaignId: string;
    campaignName: string | null;
    sent: number;
    delivered: number;
    opened: number;
    clicked: number;
    bounced: number;
    unsubscribed: number;
    openRate: number;
    clickRate: number;
  }>;
  recent: Array<{ id: string; ts: number; event: string; email: string | null; campaignName: string | null }>;
}

export interface SyncLogEntry {
  id: number;
  ts: number;
  kind: string;
  action: string;
  target: string | null;
  success: boolean;
  message: string | null;
}

export interface EmailMarketingState {
  loading: boolean;
  status: { configured: boolean; connected?: boolean; teamName?: string; error?: string } | null;
  config: { hasApiKey: boolean; apiKeyTail: string | null; autoSyncMinutes: number; defaultUserGroup: string } | null;
  lists: MailingList[];
  groups: StoredGroup[];
  properties: CustomProperty[];
  kpi: KpiSummary | null;
  kpiDays: number;
  syncLog: SyncLogEntry[];
  syncing: boolean;
  syncResult: { attempted: number; upserted: number; failed: number } | null;
  error: string | null;
  activeTab: "overview" | "campaigns" | "groups" | "contacts" | "templates" | "log";
  composer: ComposerState | null;
}

export interface ComposerState {
  kind: "event" | "transactional";
  email: string;
  userId: string;
  eventName: string;
  transactionalId: string;
  dataVariables: string; // JSON text
  status: string | null;
  sending: boolean;
}

export function defaultEmailMarketingState(): EmailMarketingState {
  return {
    loading: false,
    status: null,
    config: null,
    lists: [],
    groups: [],
    properties: [],
    kpi: null,
    kpiDays: 7,
    syncLog: [],
    syncing: false,
    syncResult: null,
    error: null,
    activeTab: "overview",
    composer: null,
  };
}

function getOrInit(state: AppViewState): EmailMarketingState {
  if (!state.emailMarketingState) {
    state.emailMarketingState = defaultEmailMarketingState();
  }
  return state.emailMarketingState;
}

export async function loadEmailMarketing(state: AppViewState, client: GatewayBrowserClient): Promise<void> {
  const s = getOrInit(state);
  s.loading = true;
  s.error = null;
  state.requestUpdate?.();
  try {
    const [status, config, kpi, log] = await Promise.all([
      client.request("loops.status", {}) as Promise<EmailMarketingState["status"]>,
      client.request("loops.config.get", {}) as Promise<EmailMarketingState["config"]>,
      client.request("loops.kpi.summary", { days: s.kpiDays }) as Promise<KpiSummary>,
      client.request("loops.sync.log", { limit: 50 }) as Promise<{ entries: SyncLogEntry[] }>,
    ]);
    s.status = status;
    s.config = config;
    s.kpi = kpi;
    s.syncLog = log.entries;

    if (status?.configured && status?.connected) {
      // Each request is independent — if one fails (e.g. Loops's
      // customFields endpoint 404s for accounts with none configured)
      // we still want the rest of the dashboard to render.
      const [lists, groups, properties] = await Promise.all([
        client.request("loops.lists.list", {}).catch(() => ({ lists: [] })) as Promise<{ lists: MailingList[] }>,
        client.request("loops.groups.list", {}).catch(() => ({ groups: [] })) as Promise<{ groups: StoredGroup[] }>,
        client.request("loops.properties.list", {}).catch(() => ({ properties: [] })) as Promise<{ properties: CustomProperty[] }>,
      ]);
      s.lists = lists.lists ?? [];
      s.groups = groups.groups ?? [];
      s.properties = properties.properties ?? [];
    } else {
      s.lists = [];
      s.groups = [];
      s.properties = [];
    }
  } catch (e) {
    s.error = (e as Error).message;
  } finally {
    s.loading = false;
    state.requestUpdate?.();
  }
}

export function setActiveTab(state: AppViewState, tab: EmailMarketingState["activeTab"]): void {
  const s = getOrInit(state);
  s.activeTab = tab;
  state.requestUpdate?.();
}

export function setKpiDays(state: AppViewState, client: GatewayBrowserClient, days: number): void {
  const s = getOrInit(state);
  s.kpiDays = Math.max(1, Math.min(90, days));
  state.requestUpdate?.();
  void (async () => {
    try {
      const kpi = (await client.request("loops.kpi.summary", { days: s.kpiDays })) as KpiSummary;
      s.kpi = kpi;
      state.requestUpdate?.();
    } catch {
      /* ignore */
    }
  })();
}

export async function syncCrm(state: AppViewState, client: GatewayBrowserClient): Promise<void> {
  const s = getOrInit(state);
  s.syncing = true;
  s.syncResult = null;
  s.error = null;
  state.requestUpdate?.();
  try {
    const res = (await client.request("loops.sync.crm", {})) as {
      attempted: number;
      upserted: number;
      failed: Array<{ email: string; error: string }>;
    };
    s.syncResult = { attempted: res.attempted, upserted: res.upserted, failed: res.failed.length };
    const log = (await client.request("loops.sync.log", { limit: 50 })) as { entries: SyncLogEntry[] };
    s.syncLog = log.entries;
  } catch (e) {
    s.error = (e as Error).message;
  } finally {
    s.syncing = false;
    state.requestUpdate?.();
  }
}

export async function deleteGroup(state: AppViewState, client: GatewayBrowserClient, id: string): Promise<void> {
  const s = getOrInit(state);
  if (!confirm(`Delete group "${id}"? This does not affect the Loops mailing list.`)) return;
  try {
    await client.request("loops.groups.delete", { id });
    s.groups = s.groups.filter((g) => g.id !== id);
    state.requestUpdate?.();
  } catch (e) {
    s.error = (e as Error).message;
    state.requestUpdate?.();
  }
}

export async function upsertGroup(
  state: AppViewState,
  client: GatewayBrowserClient,
  group: { id: string; name: string; description?: string; filter?: StoredGroup["filter"] },
): Promise<void> {
  try {
    await client.request("loops.groups.upsert", {
      id: group.id,
      name: group.name,
      description: group.description,
      source: "crm-segment",
      filter: group.filter,
      memberCount: 0,
    });
    const groups = (await client.request("loops.groups.list", {})) as { groups: StoredGroup[] };
    const s = getOrInit(state);
    s.groups = groups.groups ?? [];
    state.requestUpdate?.();
  } catch (e) {
    const s = getOrInit(state);
    s.error = (e as Error).message;
    state.requestUpdate?.();
  }
}

// ── Composer (one-off send testing) ──────────────────────────

export function openComposer(state: AppViewState, kind: "event" | "transactional"): void {
  const s = getOrInit(state);
  s.composer = {
    kind,
    email: "",
    userId: "",
    eventName: "",
    transactionalId: "",
    dataVariables: "{}",
    status: null,
    sending: false,
  };
  state.requestUpdate?.();
}

export function closeComposer(state: AppViewState): void {
  const s = getOrInit(state);
  s.composer = null;
  state.requestUpdate?.();
}

export function updateComposer(state: AppViewState, patch: Partial<ComposerState>): void {
  const s = getOrInit(state);
  if (!s.composer) return;
  Object.assign(s.composer, patch);
  state.requestUpdate?.();
}

export async function sendFromComposer(state: AppViewState, client: GatewayBrowserClient): Promise<void> {
  const s = getOrInit(state);
  if (!s.composer) return;
  const c = s.composer;
  c.sending = true;
  c.status = null;
  state.requestUpdate?.();
  try {
    let dataVariables: Record<string, unknown> | undefined;
    if (c.dataVariables.trim()) {
      try {
        dataVariables = JSON.parse(c.dataVariables);
      } catch {
        throw new Error("dataVariables must be valid JSON");
      }
    }
    if (c.kind === "event") {
      if (!c.email && !c.userId) throw new Error("Email or userId required");
      if (!c.eventName.trim()) throw new Error("eventName required");
      await client.request("loops.events.send", {
        email: c.email || undefined,
        userId: c.userId || undefined,
        eventName: c.eventName.trim(),
        eventProperties: dataVariables,
      });
      c.status = `Event "${c.eventName}" fired.`;
    } else {
      if (!c.email) throw new Error("Email required");
      if (!c.transactionalId.trim()) throw new Error("transactionalId required");
      await client.request("loops.transactional.send", {
        transactionalId: c.transactionalId.trim(),
        email: c.email,
        dataVariables,
        addToAudience: true,
      });
      c.status = `Transactional sent to ${c.email}.`;
    }
    const log = (await client.request("loops.sync.log", { limit: 50 })) as { entries: SyncLogEntry[] };
    s.syncLog = log.entries;
  } catch (e) {
    c.status = `Error: ${(e as Error).message}`;
  } finally {
    c.sending = false;
    state.requestUpdate?.();
  }
}
