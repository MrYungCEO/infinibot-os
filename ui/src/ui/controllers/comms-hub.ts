/**
 * Comms Hub controller — state + gateway actions for the unified inbox.
 *
 * Talks to the `comms.*` RPCs. Subscribes to the `comms:updated` broadcast for
 * live refresh. No dependency on the off-limits clients controller.
 */

import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";
import type { ChannelsState } from "./channels.types";
import {
  startWhatsAppLogin,
  startWhatsAppPairing,
  waitWhatsAppLogin,
  logoutWhatsApp,
} from "./channels";

export type CommsChannel = "email" | "whatsapp" | "telegram" | "discord" | "instagram";

export interface CommsChannelStatus {
  channel: CommsChannel;
  configured: boolean;
  enabled: boolean;
  accountId: string | null;
  setupNotes: string | null;
}

export interface CommsThread {
  threadKey: string;
  channel: CommsChannel;
  clientId: string | null;
  clientName: string | null;
  peerHandle: string;
  peerDisplayName: string | null;
  assignedAgentId: string | null;
  lastMessageAt: number;
  lastMessagePreview: string;
  lastDirection: "inbound" | "outbound";
  unreadCount: number;
  messageCount: number;
}

export interface CommsMessage {
  id: string;
  channel: CommsChannel;
  direction: "inbound" | "outbound";
  threadKey: string;
  clientId: string | null;
  peerHandle: string;
  peerDisplayName: string | null;
  text: string;
  status: string;
  sentByAgentId: string | null;
  autonomyDecision: { outcome: string; reason: string } | null;
  error: string | null;
  createdAt: number;
}

export type AssignmentFilter = "all" | "unassigned" | string; // string = agentId

// ── Channel setup (full catalog, via channels.status + config.patch) ──────────

export type ChannelSetupStatus =
  | "connected"
  | "disconnected"
  | "disabled"
  | "needs-setup"
  | "error";

export interface SetupChannelAccount {
  accountId: string;
  name: string | null;
  enabled: boolean;
  configured: boolean;
  connected: boolean;
  lastError: string | null;
}

/** A channel enumerated from the live `channels.status` catalog. */
export interface SetupChannel {
  id: string;
  label: string;
  detailLabel: string;
  systemImage: string | null;
  configured: boolean;
  enabled: boolean;
  status: ChannelSetupStatus;
  defaultAccountId: string;
  /** Human identity to show when connected (account name/id). */
  identity: string | null;
  lastError: string | null;
  accounts: SetupChannelAccount[];
  order: number;
}

export interface SetupToast {
  kind: "ok" | "error";
  message: string;
}

/** A single editable field in a channel's setup form. */
export interface ChannelField {
  key: string;
  label: string;
  type: "text" | "password" | "csv";
  placeholder?: string;
  help?: string;
  sensitive?: boolean;
}

export interface ChannelSetupSpec {
  fields: ChannelField[];
  /** Shown for link-by-QR / CLI-only channels that have no form fields. */
  note?: string;
}

/**
 * Per-channel setup field model, mirroring the config paths under
 * `channels.<id>.*` (see src/config/zod-schema.providers-core.ts and
 * src/commands/onboard-channels.ts). Channels not listed fall back to an
 * enable-only card with a docs/CLI note.
 */
export const CHANNEL_SETUP_SPECS: Record<string, ChannelSetupSpec> = {
  telegram: {
    fields: [
      {
        key: "botToken",
        label: "Bot token",
        type: "password",
        sensitive: true,
        placeholder: "123456:ABC-DEF…",
        help: "Create a bot with @BotFather and paste its token.",
      },
      {
        key: "defaultChatId",
        label: "Default chat ID",
        type: "text",
        placeholder: "e.g. 123456789",
        help: "Optional — chat used for proactive sends.",
      },
      {
        key: "allowFrom",
        label: "Allow from",
        type: "csv",
        placeholder: "* or comma-separated user IDs",
        help: "Who may DM the bot. Use * for open (public) access.",
      },
    ],
  },
  discord: {
    fields: [
      {
        key: "token",
        label: "Bot token",
        type: "password",
        sensitive: true,
        placeholder: "Bot token from the Developer Portal",
        help: "Discord Developer Portal → your app → Bot → Reset/Copy Token.",
      },
    ],
  },
  slack: {
    fields: [
      {
        key: "botToken",
        label: "Bot token",
        type: "password",
        sensitive: true,
        placeholder: "xoxb-…",
        help: "Slack app → OAuth & Permissions → Bot User OAuth Token.",
      },
      {
        key: "appToken",
        label: "App token",
        type: "password",
        sensitive: true,
        placeholder: "xapp-…",
        help: "Socket Mode app-level token (Basic Information → App-Level Tokens).",
      },
    ],
    note: "Socket Mode. Create a Slack app, enable Socket Mode, then paste the bot + app tokens.",
  },
  googlechat: {
    fields: [
      {
        key: "serviceAccountFile",
        label: "Service account JSON path",
        type: "text",
        placeholder: "/path/to/service-account.json",
        help: "Path to the Google Cloud service-account key file for the Chat app.",
      },
      {
        key: "audience",
        label: "Audience",
        type: "text",
        placeholder: "App URL or project number",
        help: "Optional — HTTP verification audience for the Chat app webhook.",
      },
    ],
    note: "Google Workspace Chat app with an HTTP webhook. Configure the Chat API + service account in Google Cloud first.",
  },
  signal: {
    fields: [
      {
        key: "account",
        label: "Account (phone number)",
        type: "text",
        placeholder: "+15551234567",
        help: "The signal-cli registered/linked number for this account.",
      },
    ],
    note: "Requires signal-cli installed and the number registered or linked on this machine.",
  },
  whatsapp: {
    fields: [],
    note: "Link WhatsApp right here — enter your phone number for an 8-digit pairing code (recommended), or scan a QR. No terminal needed.",
  },
  imessage: {
    fields: [],
    note: "macOS only. Enable to use the local Messages database — grant the gateway Full Disk Access first.",
  },
};

export interface CommsState {
  loading: boolean;
  error: string | null;
  channels: CommsChannelStatus[];
  threads: CommsThread[];
  pendingApprovals: number;
  selectedThreadKey: string | null;
  messages: CommsMessage[];
  threadAssignedAgentId: string | null;
  // filters
  channelFilter: CommsChannel | "all";
  assignmentFilter: AssignmentFilter;
  // composer
  composeText: string;
  composeChannel: CommsChannel | null;
  sending: boolean;
  subscribed: boolean;
  // ── channel setup surface ──
  view: "inbox" | "channels";
  setupChannels: SetupChannel[];
  setupLoading: boolean;
  setupLoaded: boolean;
  configBaseHash: string | null;
  /** Non-sensitive current values keyed by `<channelId>.<field>` for prefill. */
  setupCurrent: Record<string, string>;
  /** Which channel ids already have a value stored for a sensitive field. */
  setupSensitiveSet: Record<string, boolean>;
  activeSetupChannelId: string | null;
  /** Editable form values for the open setup form, keyed by field key. */
  setupFields: Record<string, string>;
  setupSaving: boolean;
  /** Channel ids currently mutating (disconnect/toggle) — disables controls. */
  setupBusy: Record<string, boolean>;
  toast: SetupToast | null;
  // ── WhatsApp in-UI connect (QR-login) — reuses the channels.ts login flow ──
  waModalOpen: boolean;
  wa: ChannelsState;
}

/** Minimal ChannelsState the WhatsApp login helpers operate on. */
function createWhatsAppLoginState(): ChannelsState {
  return {
    client: null,
    connected: false,
    channelsLoading: false,
    channelsSnapshot: null,
    channelsError: null,
    channelsLastSuccess: null,
    whatsappLoginMessage: null,
    whatsappLoginQrDataUrl: null,
    whatsappLoginConnected: null,
    whatsappBusy: false,
    whatsappLoginMode: "pairing",
    whatsappPhoneNumber: "",
    whatsappPairingCode: null,
  };
}

export function createCommsState(): CommsState {
  return {
    loading: false,
    error: null,
    channels: [],
    threads: [],
    pendingApprovals: 0,
    selectedThreadKey: null,
    messages: [],
    threadAssignedAgentId: null,
    channelFilter: "all",
    assignmentFilter: "all",
    composeText: "",
    composeChannel: null,
    sending: false,
    subscribed: false,
    view: "inbox",
    setupChannels: [],
    setupLoading: false,
    setupLoaded: false,
    configBaseHash: null,
    setupCurrent: {},
    setupSensitiveSet: {},
    activeSetupChannelId: null,
    setupFields: {},
    setupSaving: false,
    setupBusy: {},
    toast: null,
    waModalOpen: false,
    wa: createWhatsAppLoginState(),
  };
}

function kick(state: AppViewState): void {
  state.requestUpdate?.();
}

// ── WhatsApp in-UI connect (QR login) ────────────────────────────────────────
// startWhatsAppLogin → renders a QR, waitWhatsAppLogin → polls until the phone
// scans it, logoutWhatsApp → unlinks. On connect we refresh channel status so
// the composer for WhatsApp threads enables. Reuses the SAME flow the Channels
// page + setup wizard use — no CLI step required.

/** Open the WhatsApp connect modal. Defaults to the reliable pairing-code
 *  (phone-number) method — the user enters their number and taps "Get code",
 *  so we do NOT auto-request anything on open. Switching to "Scan QR" mints a
 *  QR on demand. */
export function openWhatsAppConnect(
  cs: CommsState,
  client: GatewayBrowserClient,
  state: AppViewState,
): void {
  cs.wa.client = client;
  cs.wa.connected = true; // gate in the login helpers ("is the gateway reachable")
  cs.waModalOpen = true;
  cs.wa.whatsappLoginMode = cs.wa.whatsappLoginMode ?? "pairing";
  cs.wa.whatsappLoginMessage = null;
  kick(state);
}

/** Switch between the pairing-code and QR link methods. */
export function setWhatsAppLoginMode(
  cs: CommsState,
  state: AppViewState,
  mode: "pairing" | "qr",
): void {
  cs.wa.whatsappLoginMode = mode;
  cs.wa.whatsappLoginMessage = null;
  kick(state);
  // Switching to QR mints a code immediately (QR has a short TTL); pairing waits
  // for the user to enter a phone number first.
  if (mode === "qr" && !cs.wa.whatsappLoginQrDataUrl && cs.wa.client) {
    void startWhatsAppConnect(cs, cs.wa.client, state, false);
  }
}

/** Update the typed phone number. */
export function setWhatsAppPhoneNumber(
  cs: CommsState,
  state: AppViewState,
  value: string,
): void {
  cs.wa.whatsappPhoneNumber = value;
  kick(state);
}

/** Request an 8-digit pairing code for the entered phone number, then poll. */
export async function startWhatsAppPairingConnect(
  cs: CommsState,
  client: GatewayBrowserClient,
  state: AppViewState,
  force: boolean,
): Promise<void> {
  cs.wa.client = client;
  cs.wa.connected = true;
  await startWhatsAppPairing(cs.wa, cs.wa.whatsappPhoneNumber, force);
  kick(state);
  if (cs.waModalOpen && cs.wa.whatsappPairingCode && !cs.wa.whatsappLoginConnected) {
    void pollWhatsAppConnect(cs, client, state);
  }
}

/** Close the modal (does not unlink). */
export function closeWhatsAppConnect(cs: CommsState, state: AppViewState): void {
  cs.waModalOpen = false;
  kick(state);
}

/** Request (or refresh / re-link) the QR, then wait for the scan. */
export async function startWhatsAppConnect(
  cs: CommsState,
  client: GatewayBrowserClient,
  state: AppViewState,
  force: boolean,
): Promise<void> {
  cs.wa.client = client;
  cs.wa.connected = true;
  await startWhatsAppLogin(cs.wa, force);
  kick(state);
  // Auto-poll for the scan once a QR is on screen.
  if (cs.waModalOpen && cs.wa.whatsappLoginQrDataUrl && !cs.wa.whatsappLoginConnected) {
    void pollWhatsAppConnect(cs, client, state);
  }
}

/** Poll the gateway until the phone scans the QR (or the modal closes). */
export async function pollWhatsAppConnect(
  cs: CommsState,
  client: GatewayBrowserClient,
  state: AppViewState,
): Promise<void> {
  while (cs.waModalOpen && !cs.wa.whatsappLoginConnected) {
    await waitWhatsAppLogin(cs.wa);
    kick(state);
    if (cs.wa.whatsappLoginConnected) {
      // Refresh channel status so the WhatsApp composer becomes enabled.
      await loadCommsChannels(cs, client, state);
      break;
    }
    if (!cs.waModalOpen) break;
    // web.login.wait returned without a scan (timeout) — QR may have expired.
    // Stop auto-looping; the user can hit Refresh QR.
    break;
  }
}

/** Manually trigger a wait-for-scan (the "I've scanned it" button). */
export async function waitWhatsAppConnect(
  cs: CommsState,
  client: GatewayBrowserClient,
  state: AppViewState,
): Promise<void> {
  cs.wa.client = client;
  cs.wa.connected = true;
  await waitWhatsAppLogin(cs.wa);
  kick(state);
  if (cs.wa.whatsappLoginConnected) await loadCommsChannels(cs, client, state);
}

/** Unlink the connected WhatsApp device. */
export async function disconnectWhatsApp(
  cs: CommsState,
  client: GatewayBrowserClient,
  state: AppViewState,
): Promise<void> {
  cs.wa.client = client;
  cs.wa.connected = true;
  await logoutWhatsApp(cs.wa);
  kick(state);
  await loadCommsChannels(cs, client, state);
}

export async function loadCommsChannels(
  cs: CommsState,
  client: GatewayBrowserClient,
  state: AppViewState,
): Promise<void> {
  try {
    const res = (await client.request("comms.channels.status")) as { channels: CommsChannelStatus[] };
    cs.channels = res.channels ?? [];
    kick(state);
  } catch (error) {
    cs.error = error instanceof Error ? error.message : String(error);
    kick(state);
  }
}

export async function loadCommsThreads(
  cs: CommsState,
  client: GatewayBrowserClient,
  state: AppViewState,
): Promise<void> {
  cs.loading = true;
  kick(state);
  try {
    const params: Record<string, unknown> = {};
    if (cs.channelFilter !== "all") params.channel = cs.channelFilter;
    if (cs.assignmentFilter === "unassigned") params.assignedAgentId = null;
    else if (cs.assignmentFilter !== "all") params.assignedAgentId = cs.assignmentFilter;
    const res = (await client.request("comms.threads.list", params)) as {
      threads: CommsThread[];
      pendingApprovals: number;
    };
    cs.threads = res.threads ?? [];
    cs.pendingApprovals = res.pendingApprovals ?? 0;
    cs.error = null;
  } catch (error) {
    cs.error = error instanceof Error ? error.message : String(error);
  } finally {
    cs.loading = false;
    kick(state);
  }
}

export async function openThread(
  cs: CommsState,
  client: GatewayBrowserClient,
  state: AppViewState,
  threadKey: string,
): Promise<void> {
  cs.selectedThreadKey = threadKey;
  const thread = cs.threads.find((t) => t.threadKey === threadKey);
  cs.composeChannel = thread?.channel ?? cs.composeChannel;
  kick(state);
  try {
    const res = (await client.request("comms.thread.get", { threadKey })) as {
      messages: CommsMessage[];
      assignedAgentId: string | null;
    };
    cs.messages = res.messages ?? [];
    cs.threadAssignedAgentId = res.assignedAgentId ?? null;
  } catch (error) {
    cs.error = error instanceof Error ? error.message : String(error);
  }
  kick(state);
}

export async function sendReply(
  cs: CommsState,
  client: GatewayBrowserClient,
  state: AppViewState,
): Promise<void> {
  const thread = cs.threads.find((t) => t.threadKey === cs.selectedThreadKey);
  if (!thread || !cs.composeText.trim() || !cs.composeChannel) return;
  cs.sending = true;
  kick(state);
  try {
    await client.request("comms.send", {
      channel: cs.composeChannel,
      clientId: thread.clientId,
      peerHandle: thread.peerHandle,
      text: cs.composeText.trim(),
    });
    cs.composeText = "";
    await openThread(cs, client, state, thread.threadKey);
    await loadCommsThreads(cs, client, state);
  } catch (error) {
    cs.error = error instanceof Error ? error.message : String(error);
  } finally {
    cs.sending = false;
    kick(state);
  }
}

export async function approveDraft(
  cs: CommsState,
  client: GatewayBrowserClient,
  state: AppViewState,
  messageId: string,
): Promise<void> {
  try {
    await client.request("comms.draft.approve", { messageId });
    if (cs.selectedThreadKey) await openThread(cs, client, state, cs.selectedThreadKey);
    await loadCommsThreads(cs, client, state);
  } catch (error) {
    cs.error = error instanceof Error ? error.message : String(error);
    kick(state);
  }
}

export async function rejectDraft(
  cs: CommsState,
  client: GatewayBrowserClient,
  state: AppViewState,
  messageId: string,
): Promise<void> {
  try {
    await client.request("comms.draft.reject", { messageId });
    if (cs.selectedThreadKey) await openThread(cs, client, state, cs.selectedThreadKey);
    await loadCommsThreads(cs, client, state);
  } catch (error) {
    cs.error = error instanceof Error ? error.message : String(error);
    kick(state);
  }
}

/** Subscribe once to the live comms:updated broadcast. */
export function subscribeComms(
  cs: CommsState,
  client: GatewayBrowserClient,
  state: AppViewState,
): void {
  if (cs.subscribed) return;
  cs.subscribed = true;
  client.subscribe((evt) => {
    if (evt?.event !== "comms:updated") return;
    void loadCommsThreads(cs, client, state);
    if (cs.selectedThreadKey) void openThread(cs, client, state, cs.selectedThreadKey);
  });
}

// ── Channel setup actions ─────────────────────────────────────────────────────

type RawAccountSnapshot = {
  accountId?: string;
  name?: string;
  enabled?: boolean;
  configured?: boolean;
  connected?: boolean;
  running?: boolean;
  lastError?: string | null;
  allowFrom?: Array<string | number>;
};

type ChannelsStatusPayload = {
  channelOrder?: string[];
  channelLabels?: Record<string, string>;
  channelDetailLabels?: Record<string, string>;
  channelSystemImages?: Record<string, string>;
  channelMeta?: Array<{ id: string; label: string; detailLabel?: string; systemImage?: string }>;
  channels?: Record<string, { configured?: boolean } | undefined>;
  channelAccounts?: Record<string, RawAccountSnapshot[] | undefined>;
  channelDefaultAccountId?: Record<string, string | undefined>;
};

function deriveStatus(configured: boolean, enabled: boolean, connected: boolean, err: string | null): ChannelSetupStatus {
  if (err) return "error";
  if (!configured) return "needs-setup";
  if (!enabled) return "disabled";
  return connected ? "connected" : "disconnected";
}

function buildSetupChannels(payload: ChannelsStatusPayload): SetupChannel[] {
  const order = payload.channelOrder ?? (payload.channelMeta ?? []).map((m) => m.id);
  const metaById = new Map((payload.channelMeta ?? []).map((m) => [m.id, m]));
  const labels = payload.channelLabels ?? {};
  const detail = payload.channelDetailLabels ?? {};
  const images = payload.channelSystemImages ?? {};
  const out: SetupChannel[] = order.map((id, idx) => {
    const summary = payload.channels?.[id] ?? {};
    const accountsRaw = payload.channelAccounts?.[id] ?? [];
    const defaultAccountId = payload.channelDefaultAccountId?.[id] ?? accountsRaw[0]?.accountId ?? "default";
    const accounts: SetupChannelAccount[] = accountsRaw.map((a) => ({
      accountId: a.accountId ?? "default",
      name: a.name ?? null,
      enabled: a.enabled !== false,
      configured: Boolean(a.configured),
      connected: Boolean(a.connected || a.running),
      lastError: a.lastError ?? null,
    }));
    const def = accounts.find((a) => a.accountId === defaultAccountId) ?? accounts[0] ?? null;
    const configured = summary.configured ?? def?.configured ?? false;
    const enabled = def ? def.enabled : true;
    const connected = def?.connected ?? false;
    const lastError = def?.lastError ?? null;
    const identity = configured ? (def?.name ?? (def && def.accountId !== "default" ? def.accountId : null)) : null;
    return {
      id,
      label: metaById.get(id)?.label ?? labels[id] ?? id,
      detailLabel: metaById.get(id)?.detailLabel ?? detail[id] ?? "",
      systemImage: metaById.get(id)?.systemImage ?? images[id] ?? null,
      configured,
      enabled,
      status: deriveStatus(configured, enabled, connected, lastError),
      defaultAccountId,
      identity,
      lastError,
      accounts,
      order: idx,
    };
  });
  return out;
}

/** Load the full channel catalog + current config values (baseHash + prefills). */
export async function loadChannelCatalog(
  cs: CommsState,
  client: GatewayBrowserClient,
  state: AppViewState,
): Promise<void> {
  cs.setupLoading = true;
  kick(state);
  try {
    const payload = (await client.request("channels.status")) as ChannelsStatusPayload;
    cs.setupChannels = buildSetupChannels(payload);
    // Pull baseHash + non-sensitive current values for prefill.
    try {
      const snap = (await client.request("config.get")) as {
        hash?: string;
        config?: { channels?: Record<string, Record<string, unknown>> };
      };
      cs.configBaseHash = typeof snap.hash === "string" ? snap.hash : null;
      const channelsCfg = snap.config?.channels ?? {};
      const current: Record<string, string> = {};
      const sensitiveSet: Record<string, boolean> = {};
      for (const [id, spec] of Object.entries(CHANNEL_SETUP_SPECS)) {
        const cfg = channelsCfg[id] as Record<string, unknown> | undefined;
        if (!cfg) continue;
        for (const f of spec.fields) {
          const v = cfg[f.key];
          if (f.sensitive) {
            if (typeof v === "string" && v.trim()) sensitiveSet[`${id}.${f.key}`] = true;
            continue; // never mirror secrets into component state
          }
          if (Array.isArray(v)) current[`${id}.${f.key}`] = v.map((x) => String(x)).join(", ");
          else if (typeof v === "string" || typeof v === "number") current[`${id}.${f.key}`] = String(v);
        }
      }
      cs.setupCurrent = current;
      cs.setupSensitiveSet = sensitiveSet;
    } catch {
      // config.get is best-effort; the catalog still renders without prefills.
    }
    cs.setupLoaded = true;
    cs.error = null;
  } catch (error) {
    cs.error = error instanceof Error ? error.message : String(error);
  } finally {
    cs.setupLoading = false;
    kick(state);
  }
}

function showToast(cs: CommsState, state: AppViewState, kind: SetupToast["kind"], message: string): void {
  cs.toast = { kind, message };
  kick(state);
  const token = cs.toast;
  setTimeout(() => {
    if (cs.toast === token) {
      cs.toast = null;
      kick(state);
    }
  }, 4200);
}

export function openChannelSetup(cs: CommsState, state: AppViewState, channelId: string): void {
  cs.activeSetupChannelId = channelId;
  const spec = CHANNEL_SETUP_SPECS[channelId];
  const fields: Record<string, string> = {};
  if (spec) {
    for (const f of spec.fields) {
      if (f.sensitive) fields[f.key] = ""; // start blank; existing secret stays untouched unless typed
      else fields[f.key] = cs.setupCurrent[`${channelId}.${f.key}`] ?? "";
    }
  }
  cs.setupFields = fields;
  kick(state);
}

export function closeChannelSetup(cs: CommsState, state: AppViewState): void {
  cs.activeSetupChannelId = null;
  cs.setupFields = {}; // drop any typed secrets from memory
  kick(state);
}

export function setSetupField(cs: CommsState, state: AppViewState, key: string, value: string): void {
  cs.setupFields = { ...cs.setupFields, [key]: value };
  kick(state);
}

/** Persist a channel's setup form via config.patch (channels.<id> merge patch). */
export async function saveChannelSetup(
  cs: CommsState,
  client: GatewayBrowserClient,
  state: AppViewState,
): Promise<void> {
  const id = cs.activeSetupChannelId;
  if (!id || cs.setupSaving) return;
  const spec = CHANNEL_SETUP_SPECS[id];
  const patch: Record<string, unknown> = { enabled: true };
  if (spec) {
    for (const f of spec.fields) {
      const raw = cs.setupFields[f.key];
      if (raw === undefined) continue;
      const trimmed = raw.trim();
      if (f.type === "csv") {
        const arr = trimmed ? trimmed.split(",").map((s) => s.trim()).filter(Boolean) : [];
        if (arr.length) patch[f.key] = arr;
      } else if (f.sensitive) {
        if (trimmed) patch[f.key] = trimmed; // only overwrite when a new value is typed
      } else if (trimmed) {
        patch[f.key] = trimmed;
      }
    }
  }
  cs.setupSaving = true;
  kick(state);
  try {
    await client.request("config.patch", {
      raw: JSON.stringify({ channels: { [id]: patch } }),
      baseHash: cs.configBaseHash,
      note: `comms: configure ${id}`,
    });
    // Wipe secrets from memory, close, and refresh from the server.
    cs.setupFields = {};
    cs.activeSetupChannelId = null;
    showToast(cs, state, "ok", `${id} saved — applying config…`);
    await loadChannelCatalog(cs, client, state);
  } catch (error) {
    showToast(cs, state, "error", error instanceof Error ? error.message : String(error));
  } finally {
    cs.setupSaving = false;
    kick(state);
  }
}

/** Enable or disable a channel (channels.<id>.enabled) via config.patch. */
export async function toggleChannelEnabled(
  cs: CommsState,
  client: GatewayBrowserClient,
  state: AppViewState,
  channelId: string,
  enabled: boolean,
): Promise<void> {
  if (cs.setupBusy[channelId]) return;
  cs.setupBusy = { ...cs.setupBusy, [channelId]: true };
  // Optimistic flip.
  cs.setupChannels = cs.setupChannels.map((c) =>
    c.id === channelId
      ? { ...c, enabled, status: deriveStatus(c.configured, enabled, c.status === "connected", c.lastError) }
      : c,
  );
  kick(state);
  try {
    await client.request("config.patch", {
      raw: JSON.stringify({ channels: { [channelId]: { enabled } } }),
      baseHash: cs.configBaseHash,
      note: `comms: ${enabled ? "enable" : "disable"} ${channelId}`,
    });
    showToast(cs, state, "ok", `${channelId} ${enabled ? "enabled" : "disabled"} — applying…`);
    await loadChannelCatalog(cs, client, state);
  } catch (error) {
    showToast(cs, state, "error", error instanceof Error ? error.message : String(error));
    await loadChannelCatalog(cs, client, state); // reconcile the optimistic flip
  } finally {
    cs.setupBusy = { ...cs.setupBusy, [channelId]: false };
    kick(state);
  }
}

/** Disconnect / log out a channel account (channels.logout — no restart). */
export async function disconnectChannel(
  cs: CommsState,
  client: GatewayBrowserClient,
  state: AppViewState,
  channelId: string,
  accountId: string,
): Promise<void> {
  if (cs.setupBusy[channelId]) return;
  cs.setupBusy = { ...cs.setupBusy, [channelId]: true };
  kick(state);
  try {
    await client.request("channels.logout", { channel: channelId, accountId });
    showToast(cs, state, "ok", `${channelId} disconnected`);
    await loadChannelCatalog(cs, client, state);
  } catch (error) {
    showToast(cs, state, "error", error instanceof Error ? error.message : String(error));
  } finally {
    cs.setupBusy = { ...cs.setupBusy, [channelId]: false };
    kick(state);
  }
}
