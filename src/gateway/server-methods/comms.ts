/**
 * Comms Hub — `comms.*` gateway RPC surface.
 *
 * A NEW server-methods module (does NOT edit agency-operations.ts). Register by
 * spreading `commsHandlers` into coreGatewayHandlers in server-methods.ts and
 * calling setCommsBroadcaster(broadcast) in server.impl.ts (mirrors clients.*).
 */

import { getAgencyOperationsStore } from "../../agency-operations/store.js";
import { DEFAULT_AGENCY_ID } from "../../agency-operations/types.js";
import { resolveStateDir } from "../../config/paths.js";
import { getAdapter, listAdapters } from "../../comms/adapters/index.js";
import { evaluateSend, rollingDayStart } from "../../comms/autonomy.js";
import {
  getClientCommsPrefs,
  resolveClientHandle,
  setClientCommsPrefs,
} from "../../comms/client-channel-prefs.js";
import { getCommsStore } from "../../comms/store.js";
import {
  type CommsChannel,
  type CommsThread,
  isCommsChannel,
} from "../../comms/types.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";

// ── Broadcaster ──────────────────────────────────────────────────────────────

type BroadcastFn = (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
let _broadcast: BroadcastFn | null = null;

export function setCommsBroadcaster(broadcast: BroadcastFn): void {
  _broadcast = broadcast;
}

function broadcast(payload: unknown): void {
  _broadcast?.("comms:updated", payload, { dropIfSlow: true });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function commsStore() {
  return getCommsStore(resolveStateDir());
}

function agencyStore() {
  return getAgencyOperationsStore(resolveStateDir());
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringParam(value: unknown, name: string): string {
  const v = optionalString(value);
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function resolveAgencyId(params: Record<string, unknown>): string {
  return optionalString(params.agencyId) ?? optionalString(params.businessId) ?? DEFAULT_AGENCY_ID;
}

function channelParam(value: unknown): CommsChannel {
  if (!isCommsChannel(value)) throw new Error(`invalid channel: ${String(value)}`);
  return value;
}

async function run<T>(opts: GatewayRequestHandlerOptions, fn: () => T | Promise<T>): Promise<void> {
  try {
    opts.respond(true, await fn());
  } catch (error) {
    opts.respond(false, { error: error instanceof Error ? error.message : String(error) });
  }
}

/** Enrich a thread rollup with the client's display name from the agency store. */
function enrichThreads(agencyId: string, threads: CommsThread[]): CommsThread[] {
  const s = agencyStore();
  const nameCache = new Map<string, string | null>();
  return threads.map((t) => {
    if (!t.clientId) return t;
    if (!nameCache.has(t.clientId)) {
      const c = s.getClient(t.clientId, agencyId);
      nameCache.set(t.clientId, c?.name ?? null);
    }
    return { ...t, clientName: nameCache.get(t.clientId) ?? null };
  });
}

// ── Handlers ─────────────────────────────────────────────────────────────────

export const commsHandlers: GatewayRequestHandlers = {
  /** Per-channel configured/enabled state for the UI. */
  "comms.channels.status": async (opts) =>
    run(opts, async () => {
      const channels = await Promise.all(listAdapters().map((a) => a.status()));
      return { channels };
    }),

  /** Thread rollup with optional assignment/channel filters. */
  "comms.threads.list": async (opts) =>
    run(opts, () => {
      const agencyId = resolveAgencyId(opts.params);
      const channel = isCommsChannel(opts.params.channel) ? opts.params.channel : undefined;
      // assignedAgentId: omit → all; null → unassigned; string → that agent
      const filter: { assignedAgentId?: string | null; channel?: CommsChannel } = { channel };
      if ("assignedAgentId" in opts.params) {
        filter.assignedAgentId =
          opts.params.assignedAgentId === null ? null : optionalString(opts.params.assignedAgentId) ?? null;
      }
      const threads = enrichThreads(agencyId, commsStore().listThreads(agencyId, filter));
      const pendingApprovals = commsStore().listPendingApprovals(agencyId).length;
      return { threads, pendingApprovals };
    }),

  /** All messages in a thread. Marks the thread read. */
  "comms.thread.get": async (opts) =>
    run(opts, () => {
      const threadKey =
        optionalString(opts.params.threadKey) ??
        (() => {
          const clientId = stringParam(opts.params.clientId, "clientId");
          const channel = channelParam(opts.params.channel);
          return `${clientId}:${channel}`;
        })();
      const s = commsStore();
      const messages = s.listThreadMessages(threadKey);
      s.markThreadRead(threadKey);
      broadcast({ action: "thread_read", threadKey });
      return {
        threadKey,
        messages,
        assignedAgentId: s.getThreadAssignment(threadKey),
      };
    }),

  /**
   * Send an outbound message. If `agentId` is provided the autonomy model is
   * enforced (fail-closed). Operator sends (no agentId) go out directly.
   */
  "comms.send": async (opts) =>
    run(opts, async () => {
      const agencyId = resolveAgencyId(opts.params);
      const channel = channelParam(opts.params.channel);
      const clientId = optionalString(opts.params.clientId) ?? null;
      const text = stringParam(opts.params.text, "text");
      const agentId = optionalString(opts.params.agentId) ?? null;
      const mediaUrls = Array.isArray(opts.params.mediaUrls)
        ? opts.params.mediaUrls.filter((u): u is string => typeof u === "string")
        : [];

      // Resolve the recipient handle: explicit → client preferred handle.
      const peerHandle =
        optionalString(opts.params.peerHandle) ??
        (clientId ? resolveClientHandle(clientId, agencyId, channel) : null);
      if (!peerHandle) {
        throw new Error(`No ${channel} handle for this client — set one in the client's channel handles`);
      }

      const s = commsStore();
      const threadKey = `${clientId ?? `anon:${peerHandle}`}:${channel}`;

      // ── Autonomy enforcement for agent-initiated sends ──
      let autonomyDecision = null as ReturnType<typeof evaluateSend> | null;
      if (agentId) {
        const permission = s.getPermission(agentId);
        const sendsToday = s.countAgentSendsSince(agentId, rollingDayStart());
        autonomyDecision = evaluateSend({ permission, channel, clientId, sendsToday });
        if (autonomyDecision.outcome === "deny") {
          throw new Error(`Send denied: ${autonomyDecision.reason}`);
        }
        if (autonomyDecision.outcome === "needs_approval") {
          const draft = s.recordMessage({
            channel,
            direction: "outbound",
            threadKey,
            clientId,
            agencyId,
            peerHandle,
            text,
            mediaUrls,
            status: "pending_approval",
            sentByAgentId: agentId,
            autonomyDecision,
          });
          broadcast({ action: "draft_pending", threadKey, messageId: draft.id });
          return { queued: false, pendingApproval: true, message: draft };
        }
      }

      // ── Actually send via the adapter ──
      const adapterStatus = await getAdapter(channel).status();
      if (!adapterStatus.configured) {
        throw new Error(`${channel} is not configured. ${adapterStatus.setupNotes ?? ""}`.trim());
      }

      const pending = s.recordMessage({
        channel,
        direction: "outbound",
        threadKey,
        clientId,
        agencyId,
        peerHandle,
        text,
        mediaUrls,
        status: "queued",
        sentByAgentId: agentId,
        autonomyDecision,
      });

      try {
        const result = await getAdapter(channel).send({
          channel,
          agencyId,
          clientId,
          peerHandle,
          text,
          mediaUrls,
          channelAccountId: adapterStatus.accountId,
        });
        const sent = s.updateMessage(pending.id, {
          status: "sent",
          channelMessageId: result.channelMessageId,
        });
        broadcast({ action: "sent", threadKey, messageId: pending.id });
        return { queued: true, pendingApproval: false, message: sent };
      } catch (error) {
        const failed = s.updateMessage(pending.id, {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
        broadcast({ action: "send_failed", threadKey, messageId: pending.id });
        return { queued: false, pendingApproval: false, message: failed, error: failed?.error };
      }
    }),

  /** Approve a pending_approval draft — actually sends it. */
  "comms.draft.approve": async (opts) =>
    run(opts, async () => {
      const s = commsStore();
      const id = stringParam(opts.params.messageId, "messageId");
      const draft = s.getMessage(id);
      if (!draft || draft.status !== "pending_approval") throw new Error("no pending draft with that id");

      const adapterStatus = await getAdapter(draft.channel).status();
      if (!adapterStatus.configured) {
        throw new Error(`${draft.channel} is not configured. ${adapterStatus.setupNotes ?? ""}`.trim());
      }
      try {
        const result = await getAdapter(draft.channel).send({
          channel: draft.channel,
          agencyId: draft.agencyId,
          clientId: draft.clientId,
          peerHandle: draft.peerHandle,
          text: draft.text,
          mediaUrls: draft.mediaUrls,
          channelAccountId: adapterStatus.accountId,
        });
        const sent = s.updateMessage(id, { status: "sent", channelMessageId: result.channelMessageId });
        broadcast({ action: "draft_approved", threadKey: draft.threadKey, messageId: id });
        return { message: sent };
      } catch (error) {
        const failed = s.updateMessage(id, {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
        return { message: failed, error: failed?.error };
      }
    }),

  /** Reject a pending_approval draft. */
  "comms.draft.reject": async (opts) =>
    run(opts, () => {
      const s = commsStore();
      const id = stringParam(opts.params.messageId, "messageId");
      const draft = s.getMessage(id);
      if (!draft || draft.status !== "pending_approval") throw new Error("no pending draft with that id");
      const rejected = s.updateMessage(id, { status: "draft" });
      broadcast({ action: "draft_rejected", threadKey: draft.threadKey, messageId: id });
      return { message: rejected };
    }),

  /**
   * Record a normalized inbound message. Used by tests and by the future
   * per-channel receive hooks (Telegram bot-handler, WhatsApp/Discord webhooks).
   * Accepts a raw channel payload; the adapter normalizes it.
   */
  "comms.ingest": async (opts) =>
    run(opts, () => {
      const channel = channelParam(opts.params.channel);
      const raw = opts.params.raw ?? opts.params;
      const normalized = getAdapter(channel).normalizeInbound(raw);
      if (!normalized) throw new Error("could not normalize inbound payload");
      const stored = commsStore().recordMessage({
        channel: normalized.channel,
        direction: "inbound",
        threadKey: normalized.threadKey,
        clientId: normalized.clientId,
        agencyId: normalized.agencyId,
        channelAccountId: normalized.channelAccountId,
        peerHandle: normalized.peerHandle,
        peerDisplayName: normalized.peerDisplayName,
        text: normalized.text,
        mediaUrls: normalized.mediaUrls,
        channelMessageId: normalized.channelMessageId,
        status: "received",
      });
      broadcast({ action: "inbound", threadKey: stored.threadKey, messageId: stored.id });
      return { message: stored };
    }),

  /** Assign a thread to an agent (or null to unassign). */
  "comms.thread.assign": async (opts) =>
    run(opts, () => {
      const threadKey = stringParam(opts.params.threadKey, "threadKey");
      const agentId = opts.params.agentId === null ? null : optionalString(opts.params.agentId) ?? null;
      commsStore().setThreadAssignment(threadKey, agentId);
      broadcast({ action: "assigned", threadKey, agentId });
      return { threadKey, agentId };
    }),

  // ── Client comms prefs (preferred channel + handles) ──

  "comms.prefs.get": async (opts) =>
    run(opts, () => {
      const agencyId = resolveAgencyId(opts.params);
      const clientId = stringParam(opts.params.clientId, "clientId");
      const prefs = getClientCommsPrefs(clientId, agencyId);
      if (!prefs) throw new Error("client not found");
      return { clientId, prefs };
    }),

  "comms.prefs.set": async (opts) =>
    run(opts, () => {
      const agencyId = resolveAgencyId(opts.params);
      const clientId = stringParam(opts.params.clientId, "clientId");
      const patch: Record<string, unknown> = {};
      if ("preferredChannel" in opts.params) {
        patch.preferredChannel = isCommsChannel(opts.params.preferredChannel)
          ? opts.params.preferredChannel
          : null;
      }
      if ("assignedAgentId" in opts.params) {
        patch.assignedAgentId = optionalString(opts.params.assignedAgentId) ?? null;
      }
      if (opts.params.handles && typeof opts.params.handles === "object") {
        patch.handles = opts.params.handles;
      }
      if (Array.isArray(opts.params.optOut)) {
        patch.optOut = opts.params.optOut.filter(isCommsChannel);
      }
      const prefs = setClientCommsPrefs(clientId, agencyId, patch as any);
      if (!prefs) throw new Error("client not found");
      broadcast({ action: "prefs_updated", clientId });
      return { clientId, prefs };
    }),

  // ── Agent communication permissions ──

  "comms.permissions.list": async (opts) =>
    run(opts, () => ({ permissions: commsStore().listPermissions() })),

  "comms.permissions.get": async (opts) =>
    run(opts, () => {
      const agentId = stringParam(opts.params.agentId, "agentId");
      return { permission: commsStore().getPermission(agentId) };
    }),

  "comms.permissions.set": async (opts) =>
    run(opts, () => {
      const agentId = stringParam(opts.params.agentId, "agentId");
      const channels = Array.isArray(opts.params.channels)
        ? opts.params.channels.filter(isCommsChannel)
        : undefined;
      const clientScope =
        opts.params.clientScope === "all"
          ? "all"
          : Array.isArray(opts.params.clientScope)
            ? opts.params.clientScope.filter((c): c is string => typeof c === "string")
            : undefined;
      const permission = commsStore().setPermission({
        agentId,
        enabled: typeof opts.params.enabled === "boolean" ? opts.params.enabled : undefined,
        autonomy:
          opts.params.autonomy === "suggest_only" ||
          opts.params.autonomy === "draft_for_approval" ||
          opts.params.autonomy === "full_auto"
            ? opts.params.autonomy
            : undefined,
        channels,
        clientScope,
        dailySendLimit:
          opts.params.dailySendLimit === null
            ? null
            : typeof opts.params.dailySendLimit === "number"
              ? opts.params.dailySendLimit
              : undefined,
      });
      broadcast({ action: "permission_updated", agentId });
      return { permission };
    }),
};
