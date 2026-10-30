import { randomUUID } from "node:crypto";
import { isLocalNodeId } from "../../federation/local-node.js";
import fs from "node:fs";

import { isGroupChatKey } from "../../shared/group-chat/keys.js";
import type { GroupChatMeta } from "../../shared/group-chat/types.js";

import { abortEmbeddedPiRun, waitForEmbeddedPiRunEnd } from "../../agents/pi-embedded.js";
import { resolveAgentConfig, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { buildSubagentSystemPrompt } from "../../agents/subagent-announce.js";
import {
  announceExternalSession,
  listExternalSessions,
  removeExternalSession,
  type AnnounceExternalSessionInput,
  type ExternalSessionCoderBackend,
  type ExternalSessionRecord,
  type ExternalSessionStatus,
} from "../../agents/external-session-registry.js";
import {
  registerSubagentRun,
  getSubagentRun,
  getSubagentRunBySessionKey,
} from "../../agents/subagent-registry.js";
import { getProgress, findProgressBySessionKey } from "../../agents/subagent-progress.js";
import { AGENT_LANE_SUBAGENT } from "../../agents/lanes.js";
import { callGateway } from "../../gateway/call.js";
import { stopSubagentsForRequester } from "../../auto-reply/reply/abort.js";
import { clearSessionQueues } from "../../auto-reply/reply/queue.js";
import { loadConfig } from "../../config/config.js";
import {
  loadSessionStore,
  loadSessionStoreReadonly,
  snapshotSessionOrigin,
  resolveMainSessionKey,
  type SessionEntry,
  updateSessionStore,
} from "../../config/sessions.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateSessionsCompactParams,
  validateSessionsDeleteParams,
  validateSessionsListParams,
  validateSessionsPatchParams,
  validateSessionsPreviewParams,
  validateSessionsResetParams,
  validateSessionsResolveParams,
} from "../protocol/index.js";
import {
  archiveFileOnDisk,
  listSessionsFromStore,
  loadCombinedSessionStoreForGateway,
  loadSessionEntry,
  readSessionPreviewItemsFromTranscript,
  resolveGatewaySessionStoreTarget,
  resolveSessionTranscriptCandidates,
  type SessionsPatchResult,
  type SessionsPreviewEntry,
  type SessionsPreviewResult,
} from "../session-utils.js";
import { applySessionsPatchToStore } from "../sessions-patch.js";
import { resolveSessionKeyFromResolveParams } from "../sessions-resolve.js";
import { getFederationHub } from "../../federation/hub.js";
import { forwardGatewayCall } from "../../federation/hub-forward.js";
import {
  registerRemoteSession,
  listRemoteSessions,
} from "../../federation/remote-session-registry.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";

// ── Pause flag registry — in-memory, intentionally ephemeral ─────────────────
const _pausedRunIds = new Set<string>();

export function isSessionPaused(runId: string): boolean {
  return _pausedRunIds.has(runId);
}

// ── Backend capability matrix ─────────────────────────────────────────────────
type SessionCapabilities = {
  pause: boolean;
  send: boolean;
  edit: boolean;
  fork: boolean;
};

function capabilitiesForBackend(backend: string | undefined): SessionCapabilities {
  switch (backend) {
    case "claude-code":
      return { pause: true, send: true, edit: true, fork: false };
    case "opencode":
      return { pause: false, send: false, edit: false, fork: false };
    case "codex":
      return { pause: false, send: false, edit: false, fork: false };
    default:
      // autonomy / unknown — assume agent-loop (can inject via system event)
      return { pause: true, send: true, edit: true, fork: false };
  }
}

const EXTERNAL_SESSION_STATUSES = new Set<ExternalSessionStatus>([
  "starting",
  "idle",
  "working",
  "blocked",
  "completed",
  "failed",
]);

const EXTERNAL_CODER_BACKENDS = new Set<ExternalSessionCoderBackend>([
  "claude-code",
  "opencode",
  "codex",
  "gemini",
  "grok",
]);

function isExternalSessionStatus(value: unknown): value is ExternalSessionStatus {
  return typeof value === "string" && EXTERNAL_SESSION_STATUSES.has(value as ExternalSessionStatus);
}

function isExternalCoderBackend(value: unknown): value is ExternalSessionCoderBackend {
  return (
    typeof value === "string" && EXTERNAL_CODER_BACKENDS.has(value as ExternalSessionCoderBackend)
  );
}

function readExternalSessionKey(params: Record<string, unknown>): string | null {
  const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey.trim() : "";
  return sessionKey || null;
}

function readExternalTtlSeconds(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(600, Math.max(1, Math.floor(value)));
}

function externalSessionMatchesList(
  record: ExternalSessionRecord,
  p: import("../protocol/index.js").SessionsListParams,
): boolean {
  const agentId = typeof p.agentId === "string" ? normalizeAgentId(p.agentId) : "";
  if (agentId && normalizeAgentId(record.agentId) !== agentId) return false;

  const label = typeof p.label === "string" ? p.label.trim() : "";
  if (label && record.label !== label) return false;

  if (typeof p.spawnedBy === "string" && p.spawnedBy.trim()) return false;

  const activeMinutes =
    typeof p.activeMinutes === "number" && Number.isFinite(p.activeMinutes)
      ? Math.max(1, Math.floor(p.activeMinutes))
      : undefined;
  if (activeMinutes !== undefined && record.lastHeartbeatMs < Date.now() - activeMinutes * 60_000) {
    return false;
  }

  const search = typeof p.search === "string" ? p.search.trim().toLowerCase() : "";
  if (search) {
    const fields = [record.label, record.sessionKey, record.agentId, record.currentTask];
    if (
      !fields.some((field) => typeof field === "string" && field.toLowerCase().includes(search))
    ) {
      return false;
    }
  }

  return true;
}

function appendExternalSessionsToList(
  result: ReturnType<typeof listSessionsFromStore>,
  p: import("../protocol/index.js").SessionsListParams,
): void {
  const existingKeys = new Set(result.sessions.map((session) => session.key));
  const externalRows = listExternalSessions()
    .filter((record) => !existingKeys.has(record.sessionKey))
    .filter((record) => externalSessionMatchesList(record, p))
    .map((record) => ({
      key: record.sessionKey,
      label: record.label,
      displayName: record.label,
      kind: "main",
      node: record.nodeId,
      nodeId: record.nodeId,
      active: record.status !== "completed" && record.status !== "failed",
      status: record.status,
      currentTask: record.currentTask,
      derivedTitle: record.label,
      agent: record.agentId,
      agentId: record.agentId,
      external: true,
      coderBackend: record.coderBackend,
      updatedAt: record.lastHeartbeatMs,
      lastMessagePreview: record.currentTask,
    }));

  if (externalRows.length === 0) return;

  const sessions = result.sessions as Array<Record<string, unknown>>;
  sessions.push(...externalRows);
  sessions.sort((a, b) => {
    const aUpdated = typeof a.updatedAt === "number" ? a.updatedAt : 0;
    const bUpdated = typeof b.updatedAt === "number" ? b.updatedAt : 0;
    return bUpdated - aUpdated;
  });

  if (typeof p.limit === "number" && Number.isFinite(p.limit)) {
    sessions.splice(Math.max(1, Math.floor(p.limit)));
  }
  result.count = result.sessions.length;
}

/**
 * Surface cross-node sub-agents tracked in the federation remote-session
 * registry into a `sessions.list` result.
 *
 * Root cause this fixes: when the master forwards `sessions.spawn` to a
 * satellite it records the run in `remote-session-registry` (carrying the
 * real `nodeId`), but `sessions.list` only ever read the LOCAL combined store
 * plus the SEPARATE `external-session-registry`. So federated sub-agents were
 * never returned with their origin `nodeId` — the world-map bridge then fell
 * back to `nodeId: LOCAL` and rendered them on the local island.
 *
 * We only emit active runs (pending/starting/running) that aren't already in
 * the result, and we stamp the canonical `nodeId` (matching the island id the
 * world map keys off of, derived from `federation.status` peers) plus the
 * display `node` name.
 */
function appendRemoteFederatedSessionsToList(
  result: ReturnType<typeof listSessionsFromStore>,
): void {
  const existingKeys = new Set(result.sessions.map((session) => session.key));
  const remoteRows = listRemoteSessions({
    status: ["pending", "starting", "running"],
  })
    .filter((record) => record.sessionKey && !existingKeys.has(record.sessionKey))
    .map((record) => ({
      key: record.sessionKey,
      label: record.label || record.task || record.sessionKey,
      displayName: record.label || record.task || record.sessionKey,
      kind: "subagent",
      node: record.nodeName || record.nodeId,
      nodeId: record.nodeId,
      remote: true,
      active: true,
      status: record.status,
      progress: typeof record.progress === "number" ? record.progress : 0,
      currentTask: record.task,
      derivedTitle: record.label || record.task,
      agent: record.agentId,
      agentId: record.agentId,
      updatedAt: record.startedAt ?? record.createdAt,
      lastMessagePreview: record.lastMessage || record.task,
    }));

  if (remoteRows.length === 0) return;

  const sessions = result.sessions as Array<Record<string, unknown>>;
  sessions.push(...remoteRows);
  result.count = result.sessions.length;
}

/**
 * Tell every chat surface (webchat, the chat sidebar, other tabs/devices) that a
 * session was renamed/pinned/reset/deleted so their lists stay in sync.
 */
function broadcastSessionsChanged(
  context: GatewayRequestContext | undefined,
  key: string,
  reason: string,
): void {
  try {
    context?.broadcast?.("sessions.changed", { key, reason }, { dropIfSlow: true });
  } catch {
    // Best-effort — the mutation already succeeded.
  }
}

export const sessionsHandlers: GatewayRequestHandlers = {
  "sessions.list": ({ params, respond }) => {
    if (!validateSessionsListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid sessions.list params: ${formatValidationErrors(validateSessionsListParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as import("../protocol/index.js").SessionsListParams;
    const cfg = loadConfig();
    const { storePath, store } = loadCombinedSessionStoreForGateway(cfg);
    const result = listSessionsFromStore({
      cfg,
      storePath,
      store,
      opts: p,
    });

    // If includeFederated is requested, try to infer node info for remote sessions
    // from connected federation nodes (fallback when session store doesn't have it)
    let includedFederatedNodes = false;
    if (p.includeFederated === true) {
      try {
        const hub = getFederationHub();
        if (hub) {
          const connectedNodes = hub.getConnectedNodes();
          if (connectedNodes.length > 0) {
            // Build a map of node names for quick lookup
            const nodeMap = new Map<string, string>();
            for (const node of connectedNodes) {
              nodeMap.set(node.id, node.manifest.name || node.id);
            }

            // For sessions that have :remote: in key but no node info,
            // try to find the owning node from connected nodes
            for (const session of result.sessions) {
              if (session.key.includes(":remote:") && (!session.node || session.node === "local")) {
                // Session was spawned remotely but node info wasn't persisted
                // Check if any connected node matches (usually there's only one or two)
                // Default to first connected node as a fallback
                if (connectedNodes.length === 1) {
                  const node = connectedNodes[0];
                  // Stamp BOTH the display name (`node`) AND the canonical
                  // `nodeId` — the world-map bridge keys islands off `nodeId`
                  // (the federation peer id), so setting only `node` left the
                  // agent on the local island.
                  session.node = node.manifest.name || node.id;
                  session.nodeId = node.id;
                  session.remote = true;
                  includedFederatedNodes = true;
                } else if (connectedNodes.length > 1) {
                  // With multiple nodes we can't reliably attribute a bare
                  // `:remote:` session to a specific peer from the key alone.
                  // The authoritative attribution comes from the remote-session
                  // registry (see appendRemoteFederatedSessionsToList), so leave
                  // ambiguous local-store rows unattributed rather than guessing.
                  session.node = "federation";
                  session.remote = true;
                  includedFederatedNodes = true;
                }
              }
            }
          }
        }
      } catch (fedErr) {
        // Federation not available, continue with local results
        console.warn("Failed to infer federated sessions:", fedErr);
      }
    }

    appendExternalSessionsToList(result, p);

    // Surface cross-node sub-agents from the federation remote-session registry
    // so the world map (and any federated consumer) sees them on their origin
    // island instead of defaulting to local.
    if (p.includeFederated === true) {
      appendRemoteFederatedSessionsToList(result);
    }

    respond(true, { ...result, includedFederatedNodes }, undefined);
  },
  "sessions.announceExternal": ({ params, respond }) => {
    const sessionKey = readExternalSessionKey(params);
    if (!sessionKey) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "sessionKey is required"));
      return;
    }
    if (typeof params.label !== "string") {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "label is required"));
      return;
    }
    if (params.agentId !== undefined && typeof params.agentId !== "string") {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid agentId"));
      return;
    }
    if (params.nodeId !== undefined && typeof params.nodeId !== "string") {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid nodeId"));
      return;
    }
    if (params.status !== undefined && !isExternalSessionStatus(params.status)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid status"));
      return;
    }
    if (params.currentTask !== undefined && typeof params.currentTask !== "string") {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid currentTask"));
      return;
    }
    if (params.coderBackend !== undefined && !isExternalCoderBackend(params.coderBackend)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid coderBackend"));
      return;
    }
    const ttlSeconds = readExternalTtlSeconds(params.ttlSeconds);
    if (ttlSeconds === null) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid ttlSeconds"));
      return;
    }

    const label = params.label.trim() || sessionKey;
    const input: AnnounceExternalSessionInput = {
      sessionKey,
      label,
      agentId:
        typeof params.agentId === "string" && params.agentId.trim()
          ? normalizeAgentId(params.agentId)
          : "coder",
      nodeId:
        typeof params.nodeId === "string" && params.nodeId.trim() ? params.nodeId.trim() : "local",
      status: isExternalSessionStatus(params.status) ? params.status : "working",
      currentTask:
        typeof params.currentTask === "string" && params.currentTask.trim()
          ? params.currentTask.trim()
          : undefined,
      coderBackend: isExternalCoderBackend(params.coderBackend) ? params.coderBackend : undefined,
      ttlSeconds,
    };
    const record = announceExternalSession(input);
    respond(true, { ok: true, sessionKey: record.sessionKey, expiresAtMs: record.expiresAtMs });
  },
  "sessions.heartbeatExternal": ({ params, respond }) => {
    const sessionKey = readExternalSessionKey(params);
    if (!sessionKey) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "sessionKey is required"));
      return;
    }
    if (params.status !== undefined && !isExternalSessionStatus(params.status)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid status"));
      return;
    }
    if (params.currentTask !== undefined && typeof params.currentTask !== "string") {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid currentTask"));
      return;
    }

    const existing = listExternalSessions().find((record) => record.sessionKey === sessionKey);
    if (!existing) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "external session not found; call sessions.announceExternal first",
        ),
      );
      return;
    }

    const ttlSeconds = Math.ceil((existing.expiresAtMs - existing.lastHeartbeatMs) / 1000);
    const record = announceExternalSession({
      sessionKey: existing.sessionKey,
      label: existing.label,
      agentId: existing.agentId,
      nodeId: existing.nodeId,
      status: isExternalSessionStatus(params.status) ? params.status : existing.status,
      currentTask:
        typeof params.currentTask === "string"
          ? params.currentTask.trim() || undefined
          : existing.currentTask,
      coderBackend: existing.coderBackend,
      ttlSeconds,
    });
    respond(true, { ok: true, expiresAtMs: record.expiresAtMs });
  },
  "sessions.endExternal": ({ params, respond }) => {
    const sessionKey = readExternalSessionKey(params);
    if (!sessionKey) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "sessionKey is required"));
      return;
    }
    removeExternalSession(sessionKey);
    respond(true, { ok: true });
  },
  "sessions.preview": async ({ params, respond }) => {
    if (!validateSessionsPreviewParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid sessions.preview params: ${formatValidationErrors(
            validateSessionsPreviewParams.errors,
          )}`,
        ),
      );
      return;
    }
    const p = params as import("../protocol/index.js").SessionsPreviewParams;
    const keysRaw = Array.isArray(p.keys) ? p.keys : [];
    const keys = keysRaw
      .map((key) => String(key ?? "").trim())
      .filter(Boolean)
      .slice(0, 64);
    const limit =
      typeof p.limit === "number" && Number.isFinite(p.limit) ? Math.max(1, p.limit) : 12;
    const maxChars =
      typeof p.maxChars === "number" && Number.isFinite(p.maxChars)
        ? Math.max(20, p.maxChars)
        : 240;

    if (keys.length === 0) {
      respond(true, { ts: Date.now(), previews: [] } satisfies SessionsPreviewResult, undefined);
      return;
    }

    const cfg = loadConfig();
    const storeCache = new Map<string, Readonly<Record<string, SessionEntry>>>();
    const previews: SessionsPreviewEntry[] = [];

    for (const key of keys) {
      try {
        const target = resolveGatewaySessionStoreTarget({ cfg, key });
        const store =
          storeCache.get(target.storePath) ?? loadSessionStoreReadonly(target.storePath);
        storeCache.set(target.storePath, store);
        const entry =
          target.storeKeys.map((candidate) => store[candidate]).find(Boolean) ??
          store[target.canonicalKey];
        if (!entry?.sessionId) {
          previews.push({ key, status: "missing", items: [] });
          continue;
        }
        let items = readSessionPreviewItemsFromTranscript(
          entry.sessionId,
          target.storePath,
          entry.sessionFile,
          target.agentId,
          limit,
          maxChars,
        );

        // If no local items found, try federation
        if (items.length === 0) {
          items = await tryFederatedTranscriptPreview(key, entry.sessionId, limit, maxChars);
        }

        previews.push({
          key,
          status: items.length > 0 ? "ok" : "empty",
          items,
        });
      } catch {
        previews.push({ key, status: "error", items: [] });
      }
    }

    respond(true, { ts: Date.now(), previews } satisfies SessionsPreviewResult, undefined);
  },
  "sessions.resolve": ({ params, respond }) => {
    if (!validateSessionsResolveParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid sessions.resolve params: ${formatValidationErrors(validateSessionsResolveParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as import("../protocol/index.js").SessionsResolveParams;
    const cfg = loadConfig();

    const resolved = resolveSessionKeyFromResolveParams({ cfg, p });
    if (!resolved.ok) {
      respond(false, undefined, resolved.error);
      return;
    }
    respond(true, { ok: true, key: resolved.key }, undefined);
  },
  "sessions.patch": async ({ params, respond, context }) => {
    if (!validateSessionsPatchParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid sessions.patch params: ${formatValidationErrors(validateSessionsPatchParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as import("../protocol/index.js").SessionsPatchParams;
    const key = String(p.key ?? "").trim();
    if (!key) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "key required"));
      return;
    }

    const cfg = loadConfig();
    const target = resolveGatewaySessionStoreTarget({ cfg, key });
    const storePath = target.storePath;
    const applied = await updateSessionStore(storePath, async (store) => {
      const primaryKey = target.storeKeys[0] ?? key;
      const existingKey = target.storeKeys.find((candidate) => store[candidate]);
      if (existingKey && existingKey !== primaryKey && !store[primaryKey]) {
        store[primaryKey] = store[existingKey];
        delete store[existingKey];
      }
      return await applySessionsPatchToStore({
        cfg,
        store,
        storeKey: primaryKey,
        patch: p,
        loadGatewayModelCatalog: context.loadGatewayModelCatalog,
      });
    });
    if (!applied.ok) {
      respond(false, undefined, applied.error);
      return;
    }
    const result: SessionsPatchResult = {
      ok: true,
      path: storePath,
      key: target.canonicalKey,
      entry: applied.entry,
    };
    respond(true, result, undefined);
    broadcastSessionsChanged(context, target.canonicalKey, "patch");
  },
  "sessions.reset": async ({ params, respond, context }) => {
    if (!validateSessionsResetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid sessions.reset params: ${formatValidationErrors(validateSessionsResetParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as import("../protocol/index.js").SessionsResetParams;
    const key = String(p.key ?? "").trim();
    if (!key) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "key required"));
      return;
    }

    const cfg = loadConfig();
    const target = resolveGatewaySessionStoreTarget({ cfg, key });
    const storePath = target.storePath;
    const next = await updateSessionStore(storePath, (store) => {
      const primaryKey = target.storeKeys[0] ?? key;
      const existingKey = target.storeKeys.find((candidate) => store[candidate]);
      if (existingKey && existingKey !== primaryKey && !store[primaryKey]) {
        store[primaryKey] = store[existingKey];
        delete store[existingKey];
      }
      const entry = store[primaryKey];
      const now = Date.now();
      const nextEntry: SessionEntry = {
        sessionId: randomUUID(),
        updatedAt: now,
        systemSent: false,
        abortedLastRun: false,
        thinkingLevel: entry?.thinkingLevel,
        verboseLevel: entry?.verboseLevel,
        reasoningLevel: entry?.reasoningLevel,
        responseUsage: entry?.responseUsage,
        model: entry?.model,
        contextTokens: entry?.contextTokens,
        sendPolicy: entry?.sendPolicy,
        label: entry?.label,
        origin: snapshotSessionOrigin(entry),
        lastChannel: entry?.lastChannel,
        lastTo: entry?.lastTo,
        skillsSnapshot: entry?.skillsSnapshot,
        // Reset token counts to 0 on session reset (#1523)
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      };
      store[primaryKey] = nextEntry;
      return nextEntry;
    });
    respond(true, { ok: true, key: target.canonicalKey, entry: next }, undefined);
    broadcastSessionsChanged(context, target.canonicalKey, "reset");
  },
  "sessions.delete": async ({ params, respond, context }) => {
    if (!validateSessionsDeleteParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid sessions.delete params: ${formatValidationErrors(validateSessionsDeleteParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as import("../protocol/index.js").SessionsDeleteParams;
    const key = String(p.key ?? "").trim();
    if (!key) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "key required"));
      return;
    }

    const cfg = loadConfig();
    const mainKey = resolveMainSessionKey(cfg);
    const target = resolveGatewaySessionStoreTarget({ cfg, key });
    if (target.canonicalKey === mainKey) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `Cannot delete the main session (${mainKey}).`),
      );
      return;
    }

    const deleteTranscript = typeof p.deleteTranscript === "boolean" ? p.deleteTranscript : true;

    const storePath = target.storePath;
    const { entry } = loadSessionEntry(key);
    const sessionId = entry?.sessionId;
    const existed = Boolean(entry);
    const groupChatMeta = isGroupChatKey(key)
      ? ((entry as { groupChat?: GroupChatMeta } | undefined)?.groupChat ?? null)
      : null;
    const queueKeys = new Set<string>(target.storeKeys);
    queueKeys.add(target.canonicalKey);
    if (sessionId) queueKeys.add(sessionId);
    clearSessionQueues([...queueKeys]);
    stopSubagentsForRequester({ cfg, requesterSessionKey: target.canonicalKey });
    if (sessionId) {
      abortEmbeddedPiRun(sessionId);
      const ended = await waitForEmbeddedPiRunEnd(sessionId, 15_000);
      if (!ended) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            `Session ${key} is still active; try again in a moment.`,
          ),
        );
        return;
      }
    }
    await updateSessionStore(storePath, (store) => {
      const primaryKey = target.storeKeys[0] ?? key;
      const existingKey = target.storeKeys.find((candidate) => store[candidate]);
      if (existingKey && existingKey !== primaryKey && !store[primaryKey]) {
        store[primaryKey] = store[existingKey];
        delete store[existingKey];
      }
      if (store[primaryKey]) delete store[primaryKey];
    });

    const archived: string[] = [];
    if (deleteTranscript && sessionId) {
      for (const candidate of resolveSessionTranscriptCandidates(
        sessionId,
        storePath,
        entry?.sessionFile,
        target.agentId,
      )) {
        if (!fs.existsSync(candidate)) continue;
        try {
          archived.push(archiveFileOnDisk(candidate, "deleted"));
        } catch {
          // Best-effort.
        }
      }
    }

    respond(true, { ok: true, key: target.canonicalKey, deleted: existed, archived }, undefined);
    broadcastSessionsChanged(context, target.canonicalKey, "delete");
    if (groupChatMeta) {
      // Lazy: the group-chat module pulls in the agent pipeline.
      void import("./group-chat.js")
        .then((m) => m.cleanupDeletedGroupChat(target.canonicalKey, groupChatMeta, context))
        .catch(() => {});
    }
  },
  "sessions.compact": async ({ params, respond }) => {
    if (!validateSessionsCompactParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid sessions.compact params: ${formatValidationErrors(validateSessionsCompactParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as import("../protocol/index.js").SessionsCompactParams;
    const key = String(p.key ?? "").trim();
    if (!key) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "key required"));
      return;
    }

    const maxLines =
      typeof p.maxLines === "number" && Number.isFinite(p.maxLines)
        ? Math.max(1, Math.floor(p.maxLines))
        : 400;

    const cfg = loadConfig();
    const target = resolveGatewaySessionStoreTarget({ cfg, key });
    const storePath = target.storePath;
    // Lock + read in a short critical section; transcript work happens outside.
    const compactTarget = await updateSessionStore(storePath, (store) => {
      const primaryKey = target.storeKeys[0] ?? key;
      const existingKey = target.storeKeys.find((candidate) => store[candidate]);
      if (existingKey && existingKey !== primaryKey && !store[primaryKey]) {
        store[primaryKey] = store[existingKey];
        delete store[existingKey];
      }
      return { entry: store[primaryKey], primaryKey };
    });
    const entry = compactTarget.entry;
    const sessionId = entry?.sessionId;
    if (!sessionId) {
      respond(
        true,
        {
          ok: true,
          key: target.canonicalKey,
          compacted: false,
          reason: "no sessionId",
        },
        undefined,
      );
      return;
    }

    const filePath = resolveSessionTranscriptCandidates(
      sessionId,
      storePath,
      entry?.sessionFile,
      target.agentId,
    ).find((candidate) => fs.existsSync(candidate));
    if (!filePath) {
      respond(
        true,
        {
          ok: true,
          key: target.canonicalKey,
          compacted: false,
          reason: "no transcript",
        },
        undefined,
      );
      return;
    }

    const raw = fs.readFileSync(filePath, "utf-8");
    const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length <= maxLines) {
      respond(
        true,
        {
          ok: true,
          key: target.canonicalKey,
          compacted: false,
          kept: lines.length,
        },
        undefined,
      );
      return;
    }

    const archived = archiveFileOnDisk(filePath, "bak");
    const keptLines = lines.slice(-maxLines);
    fs.writeFileSync(filePath, `${keptLines.join("\n")}\n`, "utf-8");

    await updateSessionStore(storePath, (store) => {
      const entryKey = compactTarget.primaryKey;
      const entryToUpdate = store[entryKey];
      if (!entryToUpdate) return;
      delete entryToUpdate.inputTokens;
      delete entryToUpdate.outputTokens;
      delete entryToUpdate.totalTokens;
      entryToUpdate.updatedAt = Date.now();
    });

    respond(
      true,
      {
        ok: true,
        key: target.canonicalKey,
        compacted: true,
        archived,
        kept: keptLines.length,
      },
      undefined,
    );
  },

  // ── sessions.analyze — Pre-flight task analysis ──────────
  "sessions.analyze": async ({ params, respond }) => {
    const p = params as {
      task?: string;
      agentId?: string;
      projectContext?: string;
    };
    const task = (typeof p.task === "string" ? p.task : "").trim();
    if (!task) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "task is required"));
      return;
    }

    const cfg = loadConfig();
    const targetAgentId = normalizeAgentId(p.agentId) || "coder";
    const projectCtx = typeof p.projectContext === "string" ? p.projectContext.trim() : "";

    // Create a temporary session for analysis
    const analysisSessionKey = `analysis:${randomUUID()}`;

    const analysisPrompt = `You are a pre-flight task analyzer. Analyze the following task and determine if you have enough context and detail to execute it successfully.

${projectCtx ? `PROJECT CONTEXT:\n${projectCtx}\n\n` : ""}TASK:
${task}

Respond with ONLY valid JSON (no markdown fences, no extra text). Use this exact schema:
{
  "ready": true or false,
  "summary": "1-2 sentence analysis of what this task involves",
  "questions": [
    {
      "id": "q1",
      "label": "Your question to the user",
      "type": "text" | "textarea" | "select",
      "required": true or false,
      "placeholder": "hint text for the input",
      "options": ["only for select type"]
    }
  ],
  "suggestions": ["optional improvement suggestions for the task"]
}

Rules:
- If the task is clear, specific, and actionable → set ready: true, questions: []
- If you need clarification on tech stack, scope, requirements, files, or approach → set ready: false and list questions
- Keep questions focused and practical (max 5)
- Each question should have a clear id like "tech_stack", "scope", "target_files", etc.
- Use "textarea" for open-ended questions, "text" for short answers, "select" for choices
- Be concise in your analysis`;

    try {
      // Fire the agent call
      const analysisIdem = `analysis:${randomUUID()}`;
      const agentResponse = (await callGateway({
        method: "agent",
        params: {
          message: analysisPrompt,
          sessionKey: analysisSessionKey,
          idempotencyKey: analysisIdem,
          deliver: false,
          lane: AGENT_LANE_SUBAGENT,
          label: "Pre-flight Analysis",
          timeout: 60,
        },
        timeoutMs: 10_000,
      })) as { runId?: string };

      const runId = agentResponse?.runId;

      // Poll for the response (max 45 seconds)
      const pollStart = Date.now();
      const maxWaitMs = 45_000;
      const pollIntervalMs = 1_500;
      let analysisText = "";

      while (Date.now() - pollStart < maxWaitMs) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

        try {
          const previewResult = (await callGateway({
            method: "sessions.preview",
            params: { keys: [analysisSessionKey], limit: 5, maxChars: 4000 },
            timeoutMs: 5_000,
          })) as {
            previews?: Array<{
              key: string;
              status: string;
              items: Array<{ role: string; text: string }>;
            }>;
          };

          const preview = previewResult?.previews?.[0];
          if (preview?.status === "ok" && preview.items?.length) {
            // Find the assistant response
            const assistantMsg = preview.items.find((item) => item.role === "assistant");
            if (assistantMsg?.text) {
              analysisText = assistantMsg.text;
              break;
            }
          }
        } catch {
          // Keep polling
        }
      }

      // Clean up the temp session
      try {
        await callGateway({
          method: "sessions.delete",
          params: { key: analysisSessionKey },
          timeoutMs: 5_000,
        });
      } catch {
        // Ignore cleanup errors
      }

      if (!analysisText) {
        respond(
          true,
          {
            status: "timeout",
            ready: true,
            summary: "Analysis timed out — task appears actionable. Proceed with execution.",
            questions: [],
            suggestions: [],
          },
          undefined,
        );
        return;
      }

      // Parse the JSON response
      try {
        // Strip markdown fences if present
        let jsonStr = analysisText.trim();
        if (jsonStr.startsWith("```")) {
          jsonStr = jsonStr.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
        }
        const parsed = JSON.parse(jsonStr);
        respond(
          true,
          {
            status: "ok",
            ready: !!parsed.ready,
            summary: parsed.summary || "",
            questions: Array.isArray(parsed.questions) ? parsed.questions : [],
            suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
          },
          undefined,
        );
      } catch {
        // If parsing fails, treat the raw text as a summary
        respond(
          true,
          {
            status: "ok",
            ready: true,
            summary: analysisText.slice(0, 500),
            questions: [],
            suggestions: [],
          },
          undefined,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, `Analysis failed: ${msg}`));
    }
  },

  // ── sessions.spawn — Spawn a sub-agent from the UI ──────────
  "sessions.spawn": async ({ params, respond }) => {
    const p = params as {
      task?: string;
      agentId?: string;
      label?: string;
      model?: string;
      thinking?: string;
      runTimeoutSeconds?: number;
      /** When true, the run is treated as autonomous and must be gated. */
      autonomous?: boolean;
      /** Optional approval id from `autonomy.approval.request`. Required for
       *  autonomous runs whose criticality is critical. */
      approvalId?: string;
      /** Optional working dir override; used for the GitHub precheck. */
      cwd?: string;
      /**
       * Target federation node. The UI sends `node` (legacy from the spawn
       * dialog); the canonical name is `nodeId` (matches terminal.spawnAgent).
       * Both accepted. Empty / "local" / current node = spawn locally.
       */
      nodeId?: string;
      node?: string;
      /** Per-spawn CLI backend override (claude-code / opencode / codex).
       *  Threaded into the subagent registry so the resume path picks the
       *  right backend after a gateway restart. Used by autonomy goal-mode
       *  to honor `AutonomyBackend.kind`. */
      coderBackend?: "claude-code" | "opencode" | "codex" | "gemini" | "grok";
    };
    const task = (typeof p.task === "string" ? p.task : "").trim();
    if (!task) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "task is required"));
      return;
    }
    const cfg = loadConfig();

    // ── Cross-node forwarding ────────────────────────────────────────────
    // Master-only routing: when the caller picks a remote node, forward the
    // entire sessions.spawn call to that satellite's gateway via the proxy
    // pipe. The satellite registers its own subagent run locally; we record
    // the remote session here so the master's activity feed shows a node
    // badge (commit 2c846f6 reads `nodeId/nodeName/remote` off the record).
    const rawNodeId =
      (typeof p.nodeId === "string" ? p.nodeId.trim() : "") ||
      (typeof p.node === "string" ? p.node.trim() : "");
    const wantsRemote = !isLocalNodeId(rawNodeId);
    if (wantsRemote) {
      // forwardGatewayCall handles BOTH directions — master → satellite
      // (via hub) AND satellite → master (via the satellite's WS tunnel).
      // Without this, a satellite operator picking master in the spawn
      // dialog would silently land a local subagent on the satellite.
      const { nodeId: _dropNodeId, node: _dropNode, ...forwardParams } = p;
      const fwd = await forwardGatewayCall<{
        status?: string;
        childSessionKey?: string;
        runId?: string;
        executionMode?: string;
        terminalId?: string;
        error?: string;
      }>(rawNodeId, "sessions.spawn", forwardParams);
      if (fwd.success) {
        const remoteRunId = fwd.payload?.runId ?? "";
        const remoteSessionKey = fwd.payload?.childSessionKey ?? "";
        if (remoteRunId && remoteSessionKey) {
          try {
            registerRemoteSession({
              runId: remoteRunId,
              sessionKey: remoteSessionKey,
              nodeId: rawNodeId,
              agentId: normalizeAgentId(p.agentId) || "coder",
              task,
              label: typeof p.label === "string" ? p.label.trim() || undefined : undefined,
              cleanup: "keep",
              timeoutSeconds:
                typeof p.runTimeoutSeconds === "number" ? p.runTimeoutSeconds : undefined,
              model: typeof p.model === "string" ? p.model : undefined,
            });
          } catch {
            // Best-effort: registry tagging failure shouldn't block the spawn.
          }
        }
        respond(true, { ...fwd.payload, remote: true, nodeId: rawNodeId }, undefined);
        return;
      }
      // Surface genuine routing failures (target down, master unreachable,
      // remote error) — never silently land the sub-agent on the wrong node.
      // Only NOT_FEDERATED (standalone install, no hub/satellite — the one
      // "cannot route at all" code forwardGatewayCall emits) falls through to
      // a local spawn, same as terminal.spawnAgent and chat.send.
      if (fwd.code !== "NOT_FEDERATED") {
        respond(
          false,
          undefined,
          errorShape(
            (fwd.code ?? "FORWARD_FAILED") as never,
            fwd.error ?? `Failed to forward sessions.spawn to node ${rawNodeId}`,
          ),
        );
        return;
      }
    }
    const targetAgentId = normalizeAgentId(p.agentId) || "coder";
    const label = typeof p.label === "string" ? p.label.trim() : "";
    const childSessionKey = `agent:${targetAgentId}:subagent:${randomUUID()}`;
    const targetAgentConfig = resolveAgentConfig(cfg, targetAgentId);

    // ── Autonomous-mode guard ──────────────────────────
    // Autonomous runs must (a) have a GitHub-backed working dir and (b) if
    // the task is classified critical, carry an approved `approvalId`.
    if (p.autonomous === true) {
      try {
        const { execSync } = await import("node:child_process");
        const cwd =
          (typeof p.cwd === "string" && p.cwd) ||
          (await import("../../agents/agent-scope.js")).resolveAgentWorkspaceDir(
            cfg,
            targetAgentId,
          ) ||
          process.cwd();
        let remote = "";
        let dirtyFiles = 0;
        let onDefaultBranch = false;
        try {
          execSync(`git rev-parse --git-dir`, {
            cwd,
            encoding: "utf-8",
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
          });
          remote = execSync(`git remote get-url origin`, {
            cwd,
            encoding: "utf-8",
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
          })
            .toString()
            .trim();
          const branch = execSync(`git rev-parse --abbrev-ref HEAD`, {
            cwd,
            encoding: "utf-8",
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
          })
            .toString()
            .trim();
          const def =
            execSync(`git symbolic-ref refs/remotes/origin/HEAD`, {
              cwd,
              encoding: "utf-8",
              windowsHide: true,
              stdio: ["pipe", "pipe", "pipe"],
            })
              .toString()
              .trim()
              .split("/")
              .pop() ?? "main";
          onDefaultBranch = branch === def;
          const status = execSync(`git status --porcelain=v1`, {
            cwd,
            encoding: "utf-8",
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
          }).toString();
          dirtyFiles = status.split("\n").filter(Boolean).length;
        } catch {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              `Autonomous mode requires a git repository at ${cwd}. Initialise one and add a GitHub remote before starting.`,
            ),
          );
          return;
        }
        if (!/github\.com[:/]/i.test(remote)) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              remote
                ? `Autonomous mode requires a GitHub remote. Origin "${remote}" is not GitHub.`
                : `Autonomous mode requires a GitHub remote. Configure one with \`git remote add origin <github-url>\`.`,
            ),
          );
          return;
        }

        // If approvalId was supplied, verify it's approved.
        if (typeof p.approvalId === "string" && p.approvalId) {
          const { getApproval } = await import("../../autonomy/approval-registry.js");
          const rec = getApproval(p.approvalId);
          if (!rec || rec.status !== "approved") {
            respond(
              false,
              undefined,
              errorShape(
                ErrorCodes.INVALID_REQUEST,
                `Approval ${p.approvalId} is ${rec?.status ?? "unknown"}; cannot start.`,
              ),
            );
            return;
          }
        } else {
          // No approvalId — auto-classify and require approval if critical.
          const { classifyTask } = await import("../../autonomy/criticality.js");
          const classification = classifyTask({
            prompt: task,
            agentId: targetAgentId,
            autonomous: true,
            dirtyFiles,
            onDefaultBranch,
          });
          if (classification.requiresApproval) {
            respond(
              false,
              undefined,
              errorShape(
                ErrorCodes.INVALID_REQUEST,
                `Task classified ${classification.criticality}: ${classification.reasons.join("; ")}. Request approval via autonomy.approval.request and pass approvalId.`,
              ),
            );
            return;
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, `autonomous precheck failed: ${msg}`),
        );
        return;
      }
    }

    // ── Terminal-first path ──────────────────────────
    // A per-spawn `coderBackend` override (used by autonomy goal-mode with
    // backend = opencode/codex/gemini/grok) bypasses the agent's configured execution
    // mode and forces a terminal launch with the matching CLI. This is how
    // a single backend choice in the goal-create dialog actually drives
    // which CLI runs the sub-agent — without this, the worker always
    // ran whatever the agent config said.
    const backendCliOverride =
      p.coderBackend === "opencode" ||
      p.coderBackend === "codex" ||
      p.coderBackend === "gemini" ||
      p.coderBackend === "grok"
        ? p.coderBackend
        : undefined;
    const execution = backendCliOverride
      ? {
          mode: "terminal" as const,
          cli: backendCliOverride,
          autoClose: targetAgentConfig?.execution?.autoClose,
          autoCloseDelayMs: targetAgentConfig?.execution?.autoCloseDelayMs,
        }
      : targetAgentConfig?.execution;
    if (execution?.mode === "terminal" && execution?.cli) {
      const childRunId = randomUUID();
      const cwd = resolveAgentWorkspaceDir(cfg, targetAgentId);
      try {
        const spawnResult = (await callGateway({
          method: "terminal.spawnAgent",
          params: {
            cli: execution.cli,
            cwd,
            task,
            label: label || undefined,
            runId: childRunId,
            sessionKey: childSessionKey,
            agentId: targetAgentId,
            autoClose: execution.autoClose !== false,
            autoCloseDelayMs:
              typeof execution.autoCloseDelayMs === "number" ? execution.autoCloseDelayMs : 5000,
            options:
              typeof p.model === "string" && p.model.trim() ? { model: p.model.trim() } : undefined,
          },
          timeoutMs: 15_000,
        })) as { success: boolean; terminalId?: string; error?: string };

        if (spawnResult?.success) {
          registerSubagentRun({
            runId: childRunId,
            childSessionKey,
            requesterSessionKey: "main",
            requesterOrigin: undefined,
            requesterDisplayKey: "main",
            task,
            cleanup: "keep",
            label: label || undefined,
            runTimeoutSeconds: typeof p.runTimeoutSeconds === "number" ? p.runTimeoutSeconds : 0,
            // Persist the tmux-backed terminal id + agent so a gateway restart can
            // reattach to the still-running tmux session instead of abandoning the
            // run (tmux-aware recovery).
            terminalId: spawnResult.terminalId,
            agentId: targetAgentId,
          });
          respond(
            true,
            {
              status: "accepted",
              childSessionKey,
              runId: childRunId,
              executionMode: "terminal",
              terminalId: spawnResult.terminalId,
            },
            undefined,
          );
          return;
        }
        // Terminal spawn returned success:false — surface the error rather than
        // silently falling through to the agent-loop (which cannot drive CLI
        // tools). The caller gets a clear "binary not found / terminal error"
        // message instead of a phantom accepted+agent-loop session.
        const termErr = spawnResult?.error ?? `terminal.spawnAgent failed for cli=${execution.cli}`;
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, termErr));
        return;
      } catch (terminalErr) {
        // terminal.spawnAgent itself threw — surface as a proper error.
        const msg = terminalErr instanceof Error ? terminalErr.message : String(terminalErr);
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, `terminal.spawnAgent error: ${msg}`),
        );
        return;
      }
    }

    // ── Agent-loop path ──────────────────────────
    const childSystemPrompt = buildSubagentSystemPrompt({
      requesterSessionKey: "main",
      childSessionKey,
      label: label || undefined,
      task,
    });

    const childIdem = randomUUID();
    let childRunId: string = childIdem;
    try {
      const response = (await callGateway({
        method: "agent",
        params: {
          message: task,
          sessionKey: childSessionKey,
          idempotencyKey: childIdem,
          deliver: false,
          lane: AGENT_LANE_SUBAGENT,
          extraSystemPrompt: childSystemPrompt,
          thinking: typeof p.thinking === "string" ? p.thinking : undefined,
          // Treat 0 as "no override, use default" upstream — passing
          // literal 0 used to crash the agent handler's downstream
          // command parser, leaving the subagent stuck post-spawn with
          // no output. Anything > 0 is a real per-run override.
          timeout:
            typeof p.runTimeoutSeconds === "number" && p.runTimeoutSeconds > 0
              ? p.runTimeoutSeconds
              : undefined,
          label: label || undefined,
          spawnedBy: "main",
          // Forward the per-spawn CLI override into the agent loop. The
          // agent handler is responsible for honoring this (or ignoring
          // it for non-coder agents). Used by autonomy goal-mode so a
          // single backend choice drives both planner and worker.
          coderBackend: p.coderBackend,
        },
        timeoutMs: 10_000,
      })) as { runId?: string };
      if (typeof response?.runId === "string" && response.runId) {
        childRunId = response.runId;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, msg));
      return;
    }

    registerSubagentRun({
      runId: childRunId,
      childSessionKey,
      requesterSessionKey: "main",
      requesterOrigin: undefined,
      requesterDisplayKey: "main",
      task,
      cleanup: "keep",
      label: label || undefined,
      runTimeoutSeconds: typeof p.runTimeoutSeconds === "number" ? p.runTimeoutSeconds : 0,
    });

    respond(
      true,
      {
        status: "accepted",
        childSessionKey,
        runId: childRunId,
        executionMode: "agent-loop",
      },
      undefined,
    );
  },
  "sessions.search": async ({ params, respond }) => {
    const p = params as {
      query?: string;
      agentId?: string;
      limit?: number;
      reindex?: boolean;
    };
    const query = (p.query ?? "").trim();
    if (!query) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "query is required"));
      return;
    }
    try {
      const { ingestSessions, searchSessions } = await import("../../sessions/search-index.js");
      if (p.reindex !== false) {
        try {
          ingestSessions(p.agentId ? { agentId: p.agentId } : undefined);
        } catch {
          /* search still works against the previously-indexed corpus */
        }
      }
      const limit = typeof p.limit === "number" && Number.isFinite(p.limit) ? p.limit : undefined;
      const result = searchSessions({ query, agentId: p.agentId, limit });
      respond(true, result, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, (err as Error).message));
    }
  },

  // ── sessions.transcript — full transcript with cursor pagination ──────────
  "sessions.transcript": async ({ params, respond }) => {
    const p = params as {
      runId?: string;
      sessionKey?: string;
      /** Direct path to a JSONL transcript file (bypasses session-store lookup). */
      transcriptPath?: string;
      limit?: number;
      maxChars?: number;
    };

    const limit =
      typeof p.limit === "number" && Number.isFinite(p.limit)
        ? Math.max(1, Math.min(200, p.limit))
        : 100;
    const maxChars =
      typeof p.maxChars === "number" && Number.isFinite(p.maxChars)
        ? Math.max(20, p.maxChars)
        : 4000;

    // Fast path: caller supplied a direct transcript file path (from run.transcriptPath).
    if (typeof p.transcriptPath === "string" && p.transcriptPath.trim()) {
      try {
        const items = readSessionPreviewItemsFromTranscript(
          "",
          p.transcriptPath.trim(),
          p.transcriptPath.trim(),
          undefined,
          limit,
          maxChars,
        );
        respond(
          true,
          {
            ok: true,
            turns: items.map((item) => ({ role: item.role, text: item.text })),
            total: items.length,
            source: "direct",
          },
          undefined,
        );
        return;
      } catch {
        // Fall through to session-store lookup
      }
    }

    // Resolve sessionKey: either supplied directly or derived from runId.
    let sessionKey: string | undefined =
      typeof p.sessionKey === "string" ? p.sessionKey.trim() || undefined : undefined;

    const rawRunId = typeof p.runId === "string" ? p.runId.trim() : "";
    if (!sessionKey && rawRunId) {
      const run = getSubagentRun(rawRunId) ?? getSubagentRunBySessionKey(rawRunId);
      if (run) sessionKey = run.childSessionKey;
    }

    // Archived run fallback: the live registry may have swept the run, but the
    // history entry still carries childSessionKey (and optionally transcriptPath).
    if (!sessionKey && rawRunId) {
      try {
        const { getSubagentHistoryEntryByRunId } = await import("../../agents/subagent-history.js");
        const arc = getSubagentHistoryEntryByRunId(rawRunId);
        if (arc) {
          // Prefer direct transcript file if archived.
          if (arc.transcriptPath) {
            try {
              const items = readSessionPreviewItemsFromTranscript(
                "",
                arc.transcriptPath,
                arc.transcriptPath,
                undefined,
                limit,
                maxChars,
              );
              respond(
                true,
                {
                  ok: true,
                  turns: items.map((item) => ({ role: item.role, text: item.text })),
                  total: items.length,
                  source: "archive-direct",
                },
                undefined,
              );
              return;
            } catch {
              /* fall through to sessionKey lookup */
            }
          }
          sessionKey = arc.childSessionKey;
        }
      } catch {
        /* best-effort */
      }
    }

    // Transcript-index fallback: check the canonical JSONL index when the
    // history entry also lacks a transcript path (e.g. old runs pre-backfill).
    if (!sessionKey && rawRunId) {
      try {
        const { findTranscriptByRunId } =
          await import("../../agents/coder-runtime/transcript-index.js");
        const indexed = await findTranscriptByRunId(rawRunId);
        if (indexed?.transcriptPath) {
          try {
            const items = readSessionPreviewItemsFromTranscript(
              "",
              indexed.transcriptPath,
              indexed.transcriptPath,
              undefined,
              limit,
              maxChars,
            );
            respond(
              true,
              {
                ok: true,
                turns: items.map((item) => ({ role: item.role, text: item.text })),
                total: items.length,
                source: "index",
              },
              undefined,
            );
            return;
          } catch {
            /* fall through */
          }
          sessionKey = indexed.sessionKey;
        }
      } catch {
        /* best-effort */
      }
    }

    if (!sessionKey) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "runId or sessionKey is required"),
      );
      return;
    }

    try {
      const cfg = loadConfig();
      const target = resolveGatewaySessionStoreTarget({ cfg, key: sessionKey });
      const store = loadSessionStore(target.storePath);
      const entry =
        target.storeKeys.map((k) => store[k]).find(Boolean) ?? store[target.canonicalKey];

      if (!entry?.sessionId) {
        respond(true, { ok: true, turns: [], total: 0 }, undefined);
        return;
      }

      const agentId = target.agentId;
      const items = readSessionPreviewItemsFromTranscript(
        entry.sessionId,
        target.storePath,
        entry.sessionFile,
        agentId,
        limit,
        maxChars,
      );

      respond(
        true,
        {
          ok: true,
          turns: items.map((item) => ({
            role: item.role,
            text: item.text,
          })),
          total: items.length,
        },
        undefined,
      );
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, (err as Error).message));
    }
  },

  // ── sessions.send — inject user message into a running session ────────────
  "sessions.send": async ({ params, respond }) => {
    const p = params as {
      sessionKey?: string;
      runId?: string;
      message?: string;
      nodeId?: string;
      node?: string;
    };

    // Cross-node forwarding: if the session lives on a satellite, forward there.
    const rawNodeId =
      (typeof p.nodeId === "string" ? p.nodeId.trim() : "") ||
      (typeof p.node === "string" ? p.node.trim() : "");
    const wantsRemote = !isLocalNodeId(rawNodeId);
    if (wantsRemote) {
      // forwardGatewayCall handles BOTH directions: master → satellite
      // via the hub AND satellite → master via the satellite's WS tunnel.
      // The original cherry-pick used the master-only forwardGatewayCallToNode
      // which silently fell through to local on a satellite — same bug
      // pattern as the earlier sessions.spawn / terminal.spawnAgent fixes.
      const { nodeId: _dropNodeId, node: _dropNode, ...forwardParams } = p;
      const fwd = await forwardGatewayCall<{
        ok?: boolean;
        sessionKey?: string;
        error?: string;
      }>(rawNodeId, "sessions.send", forwardParams);
      if (fwd.success) {
        respond(true, { ...fwd.payload, remote: true, nodeId: rawNodeId }, undefined);
        return;
      }
      // NOT_FEDERATED → standalone install with no hub/satellite. Fall
      // through to local so we at least try (matches the spawn handler's
      // behaviour); every other routing failure surfaces.
      if (fwd.code !== "NOT_FEDERATED") {
        respond(
          false,
          undefined,
          errorShape(
            (fwd.code ?? "FORWARD_FAILED") as never,
            fwd.error ?? `Failed to forward sessions.send to node ${rawNodeId}`,
          ),
        );
        return;
      }
      // NOT_FEDERATED: fall through to local enqueue below.
    }

    let sessionKey = typeof p.sessionKey === "string" ? p.sessionKey.trim() : "";
    const message = typeof p.message === "string" ? p.message.trim() : "";

    if (!sessionKey && typeof p.runId === "string" && p.runId.trim()) {
      const run = getSubagentRun(p.runId.trim());
      if (run) sessionKey = run.childSessionKey;
      else {
        const byKey = getSubagentRunBySessionKey(p.runId.trim());
        if (byKey) sessionKey = byKey.childSessionKey;
      }
    }

    if (!sessionKey) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "sessionKey or runId is required"),
      );
      return;
    }
    if (!message) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "message is required"));
      return;
    }

    try {
      enqueueSystemEvent(`[USER INPUT]: ${message}`, {
        sessionKey,
        contextKey: "ui-compose",
      });
      respond(true, { ok: true, sessionKey }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, (err as Error).message));
    }
  },

  // ── sessions.pause — gracefully pause a running session ──────────────────
  "sessions.pause": ({ params, respond }) => {
    const p = params as { runId?: string; sessionKey?: string };
    const runId = typeof p.runId === "string" ? p.runId.trim() : "";
    const sessionKey = typeof p.sessionKey === "string" ? p.sessionKey.trim() : "";

    const resolvedRunId =
      runId ||
      (sessionKey
        ? (findProgressBySessionKey(sessionKey)?.runId ??
          getSubagentRunBySessionKey(sessionKey)?.runId ??
          "")
        : "");

    if (!resolvedRunId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "runId or sessionKey is required"),
      );
      return;
    }

    _pausedRunIds.add(resolvedRunId);
    respond(true, { ok: true, runId: resolvedRunId, paused: true }, undefined);
  },

  // ── sessions.resume — resume a paused session ─────────────────────────────
  "sessions.resume": ({ params, respond }) => {
    const p = params as { runId?: string; sessionKey?: string };
    const runId = typeof p.runId === "string" ? p.runId.trim() : "";
    const sessionKey = typeof p.sessionKey === "string" ? p.sessionKey.trim() : "";

    const resolvedRunId =
      runId ||
      (sessionKey
        ? (findProgressBySessionKey(sessionKey)?.runId ??
          getSubagentRunBySessionKey(sessionKey)?.runId ??
          "")
        : "");

    if (!resolvedRunId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "runId or sessionKey is required"),
      );
      return;
    }

    _pausedRunIds.delete(resolvedRunId);
    respond(true, { ok: true, runId: resolvedRunId, paused: false }, undefined);
  },

  // ── sessions.capabilities — what can the UI offer for this session ────────
  "sessions.capabilities": ({ params, respond }) => {
    const p = params as { runId?: string; sessionKey?: string };
    const runId = typeof p.runId === "string" ? p.runId.trim() : "";
    const sessionKey = typeof p.sessionKey === "string" ? p.sessionKey.trim() : "";

    let backend: string | undefined;
    if (runId) {
      backend = getSubagentRun(runId)?.coderBackend;
      if (!backend) backend = getProgress(runId)?.lastActivity?.coderBackend;
    }
    if (!backend && sessionKey) {
      backend = getSubagentRunBySessionKey(sessionKey)?.coderBackend;
      if (!backend) backend = findProgressBySessionKey(sessionKey)?.lastActivity?.coderBackend;
    }

    const supports = capabilitiesForBackend(backend);
    const paused = runId ? _pausedRunIds.has(runId) : false;

    respond(true, { ok: true, backend: backend ?? "unknown", supports, paused }, undefined);
  },

  // ── sessions.edit — append a correction turn (safe, no history rewrite) ───
  "sessions.edit": ({ params, respond }) => {
    const p = params as { sessionKey?: string; runId?: string; correctedText?: string };

    let sessionKey = typeof p.sessionKey === "string" ? p.sessionKey.trim() : "";
    const correctedText = typeof p.correctedText === "string" ? p.correctedText.trim() : "";

    if (!sessionKey && typeof p.runId === "string" && p.runId.trim()) {
      const run = getSubagentRun(p.runId.trim());
      if (run) sessionKey = run.childSessionKey;
    }

    if (!sessionKey) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "sessionKey or runId is required"),
      );
      return;
    }
    if (!correctedText) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "correctedText is required"),
      );
      return;
    }

    try {
      enqueueSystemEvent(
        `[USER EDIT — previous assistant response corrected to]: ${correctedText}`,
        { sessionKey, contextKey: "ui-edit" },
      );
      respond(true, { ok: true, sessionKey, appended: true }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, (err as Error).message));
    }
  },
};

/**
 * Try to fetch session transcript preview from federation if not available locally
 */
async function tryFederatedTranscriptPreview(
  sessionKey: string,
  sessionId: string,
  limit: number,
  maxChars: number,
): Promise<Array<{ role: "user" | "assistant" | "tool" | "system" | "other"; text: string }>> {
  try {
    // Import transcript sync manager
    const { getTranscriptSyncManager } = await import("../../federation/transcript-sync.js");
    const syncManager = getTranscriptSyncManager();

    if (!syncManager) {
      return []; // No federation support
    }

    // Parse session key to determine owning node
    // Session keys follow format: agent:agentType:nodeType:nodeId
    // or sessionId format with embedded node info
    const parts = sessionKey.split(":");
    let ownerNodeId = null;

    if (parts.length >= 4) {
      ownerNodeId = parts[3]; // Extract node ID from session key
    } else {
      // Try to extract from sessionId or use a default federation discovery approach
      // For now, we'll need to query all nodes or use a registry
      // This is a simplified implementation
      return [];
    }

    if (!ownerNodeId) {
      return [];
    }

    // Request transcript from owning node
    const result = await syncManager.requestTranscript({
      sessionKey,
      ownerNodeId,
      limit,
      timeoutMs: 5000,
    });

    // Convert federation messages to preview format
    const items: Array<{ role: "user" | "assistant" | "tool" | "system" | "other"; text: string }> =
      [];
    for (const message of result.messages.slice(-limit)) {
      let text = message.content || "";
      if (text.length > maxChars) {
        text = text.slice(0, maxChars - 3) + "...";
      }
      const role = (
        ["user", "assistant", "tool", "system"].includes(message.role) ? message.role : "other"
      ) as "user" | "assistant" | "tool" | "system" | "other";
      items.push({
        role,
        text,
      });
    }

    return items;
  } catch (error) {
    // Log error but don't fail the request
    console.error("Federated transcript lookup failed:", error);
    return [];
  }
}
