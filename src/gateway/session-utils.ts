import fs from "node:fs";
import path from "node:path";

import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { lookupContextTokens } from "../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import {
  resolveConfiguredModelRef,
  resolveDefaultModelForAgent,
} from "../agents/model-selection.js";
import { type InfinibotConfig, loadConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import {
  buildGroupDisplayName,
  canonicalizeMainSessionAlias,
  loadSessionStore,
  loadSessionStoreReadonly,
  resolveMainSessionKey,
  resolveStorePath,
  type SessionEntry,
  type SessionScope,
} from "../config/sessions.js";
import {
  DEFAULT_AGENT_ID,
  normalizeAgentId,
  normalizeMainKey,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { normalizeSessionDeliveryFields } from "../utils/delivery-context.js";
import { sanitizeIdentityEmoji } from "../shared/identity-emoji.js";
import { findRemoteSessionBySessionKey } from "../federation/remote-session-registry.js";
import {
  readFirstUserMessageFromTranscript,
  readLastMessagePreviewFromTranscript,
} from "./session-utils.fs.js";
import type {
  GatewayAgentRow,
  GatewaySessionRow,
  GatewaySessionsDefaults,
  SessionsListResult,
} from "./session-utils.types.js";

export {
  archiveFileOnDisk,
  capArrayByJsonBytes,
  readFirstUserMessageFromTranscript,
  readLastMessagePreviewFromTranscript,
  readSessionPreviewItemsFromTranscript,
  readSessionMessages,
  resolveSessionTranscriptCandidates,
} from "./session-utils.fs.js";
export type {
  GatewayAgentRow,
  GatewaySessionRow,
  GatewaySessionsDefaults,
  SessionsListResult,
  SessionsPatchResult,
  SessionsPreviewEntry,
  SessionsPreviewResult,
} from "./session-utils.types.js";

const DERIVED_TITLE_MAX_LEN = 60;
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

const AVATAR_DATA_RE = /^data:/i;
const AVATAR_HTTP_RE = /^https?:\/\//i;
const AVATAR_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const WINDOWS_ABS_RE = /^[a-zA-Z]:[\\/]/;

const AVATAR_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
};

function resolveAvatarMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return AVATAR_MIME_BY_EXT[ext] ?? "application/octet-stream";
}

function isWorkspaceRelativePath(value: string): boolean {
  if (!value) return false;
  if (value.startsWith("~")) return false;
  if (AVATAR_SCHEME_RE.test(value) && !WINDOWS_ABS_RE.test(value)) return false;
  return true;
}

function resolveIdentityAvatarUrl(
  cfg: InfinibotConfig,
  agentId: string,
  avatar: string | undefined,
): string | undefined {
  if (!avatar) return undefined;
  const trimmed = avatar.trim();
  if (!trimmed) return undefined;
  if (AVATAR_DATA_RE.test(trimmed) || AVATAR_HTTP_RE.test(trimmed)) return trimmed;
  if (!isWorkspaceRelativePath(trimmed)) return undefined;
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const workspaceRoot = path.resolve(workspaceDir);
  const resolved = path.resolve(workspaceRoot, trimmed);
  const relative = path.relative(workspaceRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isFile() || stat.size > AVATAR_MAX_BYTES) return undefined;
    const buffer = fs.readFileSync(resolved);
    const mime = resolveAvatarMime(resolved);
    return `data:${mime};base64,${buffer.toString("base64")}`;
  } catch {
    return undefined;
  }
}

function formatSessionIdPrefix(sessionId: string, updatedAt?: number | null): string {
  const prefix = sessionId.slice(0, 8);
  if (updatedAt && updatedAt > 0) {
    const d = new Date(updatedAt);
    const date = d.toISOString().slice(0, 10);
    return `${prefix} (${date})`;
  }
  return prefix;
}

function truncateTitle(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const cut = text.slice(0, maxLen - 1);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > maxLen * 0.6) return cut.slice(0, lastSpace) + "…";
  return cut + "…";
}

export function deriveSessionTitle(
  entry: SessionEntry | undefined,
  firstUserMessage?: string | null,
): string | undefined {
  if (!entry) return undefined;

  if (entry.displayName?.trim()) {
    return entry.displayName.trim();
  }

  if (entry.subject?.trim()) {
    return entry.subject.trim();
  }

  if (firstUserMessage?.trim()) {
    const normalized = firstUserMessage.replace(/\s+/g, " ").trim();
    return truncateTitle(normalized, DERIVED_TITLE_MAX_LEN);
  }

  if (entry.sessionId) {
    return formatSessionIdPrefix(entry.sessionId, entry.updatedAt);
  }

  return undefined;
}

export function loadSessionEntry(sessionKey: string) {
  const cfg = loadConfig();
  const sessionCfg = cfg.session;
  const canonicalKey = resolveSessionStoreKey({ cfg, sessionKey });
  const agentId = resolveSessionStoreAgentId(cfg, canonicalKey);
  const storePath = resolveStorePath(sessionCfg?.store, { agentId });
  const store = loadSessionStore(storePath);
  const entry = store[canonicalKey];
  return { cfg, storePath, store, entry, canonicalKey };
}

/**
 * Like {@link loadSessionEntry} but without copying the store: the entry is a
 * frozen view of the shared cache. For hot read-only paths (per agent event).
 */
export function loadSessionEntryReadonly(sessionKey: string) {
  const cfg = loadConfig();
  const canonicalKey = resolveSessionStoreKey({ cfg, sessionKey });
  const agentId = resolveSessionStoreAgentId(cfg, canonicalKey);
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  const entry = loadSessionStoreReadonly(storePath)[canonicalKey];
  return { cfg, storePath, entry, canonicalKey };
}

export function classifySessionKey(key: string, entry?: SessionEntry): GatewaySessionRow["kind"] {
  if (key === "global") return "global";
  if (key === "unknown") return "unknown";
  if (entry?.chatType === "group" || entry?.chatType === "channel") {
    return "group";
  }
  if (key.includes(":group:") || key.includes(":channel:")) {
    return "group";
  }
  return "direct";
}

export function parseGroupKey(
  key: string,
): { channel?: string; kind?: "group" | "channel"; id?: string } | null {
  const agentParsed = parseAgentSessionKey(key);
  const rawKey = agentParsed?.rest ?? key;
  const parts = rawKey.split(":").filter(Boolean);
  if (parts.length >= 3) {
    const [channel, kind, ...rest] = parts;
    if (kind === "group" || kind === "channel") {
      const id = rest.join(":");
      return { channel, kind, id };
    }
  }
  return null;
}

function isStorePathTemplate(store?: string): boolean {
  return typeof store === "string" && store.includes("{agentId}");
}

function listExistingAgentIdsFromDisk(): string[] {
  const root = resolveStateDir();
  const agentsDir = path.join(root, "agents");
  try {
    const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => normalizeAgentId(entry.name))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function listConfiguredAgentIds(cfg: InfinibotConfig): string[] {
  // Always include the hardcoded fallback agent id ("main") that subsystems
  // like claude-code-watcher and the gateway's auto-MCP registration write to
  // when no agent context is supplied. Without this, those sessions land in
  // /agents/main/sessions/sessions.json but the activity page only reads the
  // stores for agents in cfg.agents.list — so Claude Code sessions never
  // show up on Activity.
  const hardcodedDefaultId = normalizeAgentId(DEFAULT_AGENT_ID);
  const agents = cfg.agents?.list ?? [];
  if (agents.length > 0) {
    const ids = new Set<string>();
    for (const entry of agents) {
      if (entry?.id) ids.add(normalizeAgentId(entry.id));
    }
    const defaultId = normalizeAgentId(resolveDefaultAgentId(cfg));
    ids.add(defaultId);
    ids.add(hardcodedDefaultId);
    const sorted = Array.from(ids).filter(Boolean);
    sorted.sort((a, b) => a.localeCompare(b));
    return sorted.includes(defaultId)
      ? [defaultId, ...sorted.filter((id) => id !== defaultId)]
      : sorted;
  }

  const ids = new Set<string>();
  const defaultId = normalizeAgentId(resolveDefaultAgentId(cfg));
  ids.add(defaultId);
  ids.add(hardcodedDefaultId);
  for (const id of listExistingAgentIdsFromDisk()) ids.add(id);
  const sorted = Array.from(ids).filter(Boolean);
  sorted.sort((a, b) => a.localeCompare(b));
  if (sorted.includes(defaultId)) {
    return [defaultId, ...sorted.filter((id) => id !== defaultId)];
  }
  return sorted;
}

export function listAgentsForGateway(cfg: InfinibotConfig): {
  defaultId: string;
  mainKey: string;
  scope: SessionScope;
  agents: GatewayAgentRow[];
} {
  const defaultId = normalizeAgentId(resolveDefaultAgentId(cfg));
  const mainKey = normalizeMainKey(cfg.session?.mainKey);
  const scope = cfg.session?.scope ?? "per-sender";
  const configuredById = new Map<
    string,
    { name?: string; identity?: GatewayAgentRow["identity"] }
  >();
  for (const entry of cfg.agents?.list ?? []) {
    if (!entry?.id) continue;
    const identity = entry.identity
      ? {
          name: entry.identity.name?.trim() || undefined,
          theme: entry.identity.theme?.trim() || undefined,
          emoji: sanitizeIdentityEmoji(entry.identity.emoji, { allowShortcode: true }),
          avatar: entry.identity.avatar?.trim() || undefined,
          avatarUrl: resolveIdentityAvatarUrl(
            cfg,
            normalizeAgentId(entry.id),
            entry.identity.avatar?.trim(),
          ),
        }
      : undefined;
    configuredById.set(normalizeAgentId(entry.id), {
      name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : undefined,
      identity,
    });
  }
  const explicitIds = new Set(
    (cfg.agents?.list ?? [])
      .map((entry) => (entry?.id ? normalizeAgentId(entry.id) : ""))
      .filter(Boolean),
  );
  const allowedIds = explicitIds.size > 0 ? new Set([...explicitIds, defaultId]) : null;
  let agentIds = listConfiguredAgentIds(cfg).filter((id) =>
    allowedIds ? allowedIds.has(id) : true,
  );
  if (mainKey && !agentIds.includes(mainKey)) {
    agentIds = [...agentIds, mainKey];
  }
  const agents = agentIds.map((id) => {
    const meta = configuredById.get(id);
    const modelRef = resolveDefaultModelForAgent({ cfg, agentId: id });
    return {
      id,
      name: meta?.name,
      model: modelRef.model ? `${modelRef.provider}/${modelRef.model}` : undefined,
      identity: meta?.identity,
    };
  });
  return { defaultId, mainKey, scope, agents };
}

function canonicalizeSessionKeyForAgent(agentId: string, key: string): string {
  if (key === "global" || key === "unknown") return key;
  if (key.startsWith("agent:")) return key;
  return `agent:${normalizeAgentId(agentId)}:${key}`;
}

function resolveDefaultStoreAgentId(cfg: InfinibotConfig): string {
  return normalizeAgentId(resolveDefaultAgentId(cfg));
}

export function resolveSessionStoreKey(params: {
  cfg: InfinibotConfig;
  sessionKey: string;
}): string {
  const raw = params.sessionKey.trim();
  if (!raw) return raw;
  if (raw === "global" || raw === "unknown") return raw;

  const parsed = parseAgentSessionKey(raw);
  if (parsed) {
    const agentId = normalizeAgentId(parsed.agentId);
    const canonical = canonicalizeMainSessionAlias({
      cfg: params.cfg,
      agentId,
      sessionKey: raw,
    });
    if (canonical !== raw) return canonical;
    return raw;
  }

  const rawMainKey = normalizeMainKey(params.cfg.session?.mainKey);
  if (raw === "main" || raw === rawMainKey) {
    return resolveMainSessionKey(params.cfg);
  }
  const agentId = resolveDefaultStoreAgentId(params.cfg);
  return canonicalizeSessionKeyForAgent(agentId, raw);
}

function resolveSessionStoreAgentId(cfg: InfinibotConfig, canonicalKey: string): string {
  if (canonicalKey === "global" || canonicalKey === "unknown") {
    return resolveDefaultStoreAgentId(cfg);
  }
  const parsed = parseAgentSessionKey(canonicalKey);
  if (parsed?.agentId) return normalizeAgentId(parsed.agentId);
  return resolveDefaultStoreAgentId(cfg);
}

function canonicalizeSpawnedByForAgent(agentId: string, spawnedBy?: string): string | undefined {
  const raw = spawnedBy?.trim();
  if (!raw) return undefined;
  if (raw === "global" || raw === "unknown") return raw;
  if (raw.startsWith("agent:")) return raw;
  return `agent:${normalizeAgentId(agentId)}:${raw}`;
}

export function resolveGatewaySessionStoreTarget(params: { cfg: InfinibotConfig; key: string }): {
  agentId: string;
  storePath: string;
  canonicalKey: string;
  storeKeys: string[];
} {
  const key = params.key.trim();
  const canonicalKey = resolveSessionStoreKey({
    cfg: params.cfg,
    sessionKey: key,
  });
  const agentId = resolveSessionStoreAgentId(params.cfg, canonicalKey);
  const storeConfig = params.cfg.session?.store;
  const storePath = resolveStorePath(storeConfig, { agentId });

  if (canonicalKey === "global" || canonicalKey === "unknown") {
    const storeKeys = key && key !== canonicalKey ? [canonicalKey, key] : [key];
    return { agentId, storePath, canonicalKey, storeKeys };
  }

  const storeKeys = new Set<string>();
  storeKeys.add(canonicalKey);
  if (key && key !== canonicalKey) storeKeys.add(key);
  return {
    agentId,
    storePath,
    canonicalKey,
    storeKeys: Array.from(storeKeys),
  };
}

// Merge with existing entry based on latest timestamp to ensure data consistency and avoid overwriting with less complete data.
function mergeSessionEntryIntoCombined(params: {
  combined: Record<string, SessionEntry>;
  entry: SessionEntry;
  agentId: string;
  canonicalKey: string;
}) {
  const { combined, entry, agentId, canonicalKey } = params;
  const existing = combined[canonicalKey];

  if (existing && (existing.updatedAt ?? 0) > (entry.updatedAt ?? 0)) {
    combined[canonicalKey] = {
      ...entry,
      ...existing,
      spawnedBy: canonicalizeSpawnedByForAgent(agentId, existing.spawnedBy ?? entry.spawnedBy),
    };
  } else {
    combined[canonicalKey] = {
      ...existing,
      ...entry,
      spawnedBy: canonicalizeSpawnedByForAgent(agentId, entry.spawnedBy ?? existing?.spawnedBy),
    };
  }
}

type CombinedStoreSource = {
  agentId: string;
  snapshot: Readonly<Record<string, SessionEntry>>;
};

/**
 * Single-slot memo of the last combined store. The per-agent snapshots are the
 * frozen, shared cache objects from loadSessionStoreReadonly, so identical
 * references mean nothing changed on disk — and the (thousands of) merged
 * entry copies can be reused instead of rebuilt on every sessions.list poll.
 */
let combinedStoreMemo:
  | { storePath: string; sources: CombinedStoreSource[]; store: Record<string, SessionEntry> }
  | undefined;

function buildCombinedStore(
  storePath: string,
  sources: CombinedStoreSource[],
): Record<string, SessionEntry> {
  const memo = combinedStoreMemo;
  if (
    memo &&
    memo.storePath === storePath &&
    memo.sources.length === sources.length &&
    memo.sources.every(
      (src, i) => src.agentId === sources[i]?.agentId && src.snapshot === sources[i]?.snapshot,
    )
  ) {
    return memo.store;
  }
  const combined: Record<string, SessionEntry> = {};
  for (const { agentId, snapshot } of sources) {
    for (const [key, entry] of Object.entries(snapshot)) {
      const canonicalKey = canonicalizeSessionKeyForAgent(agentId, key);
      mergeSessionEntryIntoCombined({
        combined,
        entry,
        agentId,
        canonicalKey,
      });
    }
  }
  // Only memoize real (frozen) cache snapshots; then freeze the result too so
  // a shared copy can't be mutated by one caller under another.
  if (sources.every((src) => Object.isFrozen(src.snapshot))) {
    for (const entry of Object.values(combined)) Object.freeze(entry);
    Object.freeze(combined);
    combinedStoreMemo = { storePath, sources, store: combined };
  }
  return combined;
}

/** Test hook. */
export function clearCombinedSessionStoreMemoForTest(): void {
  combinedStoreMemo = undefined;
}

/**
 * All agents' session stores merged under canonical keys. Read-only: the
 * result (and its entries) may be a shared, frozen object.
 */
export function loadCombinedSessionStoreForGateway(cfg: InfinibotConfig): {
  storePath: string;
  store: Record<string, SessionEntry>;
} {
  const storeConfig = cfg.session?.store;
  if (storeConfig && !isStorePathTemplate(storeConfig)) {
    const storePath = resolveStorePath(storeConfig);
    const defaultAgentId = normalizeAgentId(resolveDefaultAgentId(cfg));
    const snapshot = loadSessionStoreReadonly(storePath);
    return {
      storePath,
      store: buildCombinedStore(storePath, [{ agentId: defaultAgentId, snapshot }]),
    };
  }

  const agentIds = listConfiguredAgentIds(cfg);
  const sources: CombinedStoreSource[] = agentIds.map((agentId) => ({
    agentId,
    snapshot: loadSessionStoreReadonly(resolveStorePath(storeConfig, { agentId })),
  }));
  const storePath =
    typeof storeConfig === "string" && storeConfig.trim() ? storeConfig.trim() : "(multiple)";
  return { storePath, store: buildCombinedStore(storePath, sources) };
}

export function getSessionDefaults(cfg: InfinibotConfig): GatewaySessionsDefaults {
  const resolved = resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const contextTokens =
    cfg.agents?.defaults?.contextTokens ??
    lookupContextTokens(resolved.model) ??
    DEFAULT_CONTEXT_TOKENS;
  return {
    modelProvider: resolved.provider ?? null,
    model: resolved.model ?? null,
    contextTokens: contextTokens ?? null,
  };
}

export function resolveSessionModelRef(
  cfg: InfinibotConfig,
  entry?: SessionEntry,
  agentId?: string,
): { provider: string; model: string } {
  const resolved = agentId
    ? resolveDefaultModelForAgent({ cfg, agentId })
    : resolveConfiguredModelRef({
        cfg,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: DEFAULT_MODEL,
      });
  let provider = resolved.provider;
  let model = resolved.model;
  const storedModelOverride = entry?.modelOverride?.trim();
  if (storedModelOverride) {
    provider = entry?.providerOverride?.trim() || provider;
    model = storedModelOverride;
  }
  return { provider, model };
}

export function listSessionsFromStore(params: {
  cfg: InfinibotConfig;
  storePath: string;
  store: Record<string, SessionEntry>;
  opts: import("./protocol/index.js").SessionsListParams;
}): SessionsListResult {
  const { cfg, storePath, store, opts } = params;
  const now = Date.now();

  const includeGlobal = opts.includeGlobal === true;
  const includeUnknown = opts.includeUnknown === true;
  const includeDerivedTitles = opts.includeDerivedTitles === true;
  const includeLastMessage = opts.includeLastMessage === true;
  const spawnedBy = typeof opts.spawnedBy === "string" ? opts.spawnedBy : "";
  const label = typeof opts.label === "string" ? opts.label.trim() : "";
  const agentId = typeof opts.agentId === "string" ? normalizeAgentId(opts.agentId) : "";
  const search = typeof opts.search === "string" ? opts.search.trim().toLowerCase() : "";
  const sessionPrefixes = Array.isArray(opts.sessionPrefixes)
    ? opts.sessionPrefixes.filter((p): p is string => typeof p === "string" && p.length > 0)
    : [];
  const activeMinutes =
    typeof opts.activeMinutes === "number" && Number.isFinite(opts.activeMinutes)
      ? Math.max(1, Math.floor(opts.activeMinutes))
      : undefined;

  const matching = Object.entries(store)
    .filter(([key]) => {
      if (!includeGlobal && key === "global") return false;
      if (!includeUnknown && key === "unknown") return false;
      if (agentId) {
        if (key === "global" || key === "unknown") return false;
        const parsed = parseAgentSessionKey(key);
        if (!parsed) return false;
        return normalizeAgentId(parsed.agentId) === agentId;
      }
      return true;
    })
    .filter(([key, entry]) => {
      if (!spawnedBy) return true;
      if (key === "unknown" || key === "global") return false;
      return entry?.spawnedBy === spawnedBy;
    })
    .filter(([, entry]) => {
      if (!label) return true;
      return entry?.label === label;
    })
    .filter(([key]) => {
      if (sessionPrefixes.length === 0) return true;
      const rest = parseAgentSessionKey(key)?.rest;
      return Boolean(rest && sessionPrefixes.some((p) => rest.startsWith(p)));
    });

  const buildRow = ([key, entry]: [string, SessionEntry]) => {
    const updatedAt = entry?.updatedAt ?? null;
    const input = entry?.inputTokens ?? 0;
    const output = entry?.outputTokens ?? 0;
    const total = entry?.totalTokens ?? input + output;
    const parsed = parseGroupKey(key);
    const channel = entry?.channel ?? parsed?.channel;
    const subject = entry?.subject;
    const groupChannel = entry?.groupChannel;
    const space = entry?.space;
    const id = parsed?.id;
    const origin = entry?.origin;
    const originLabel = origin?.label;
    const displayName =
      entry?.displayName ??
      (channel
        ? buildGroupDisplayName({
            provider: channel,
            subject,
            groupChannel,
            space,
            id,
            key,
          })
        : undefined) ??
      entry?.label ??
      originLabel;
    const deliveryFields = normalizeSessionDeliveryFields(entry);
    // Resolve the effective model (considering session overrides)
    const resolvedModel = resolveSessionModelRef(cfg, entry, parseAgentSessionKey(key)?.agentId);
    // Check if this session is running on a remote node
    // Priority: 1) in-memory registry, 2) persisted session entry, 3) key pattern detection
    const remoteInfo = findRemoteSessionBySessionKey(key);
    // Detect remote sessions from key pattern (contains :remote: segment)
    const keyIndicatesRemote = key.includes(":remote:");
    const node = remoteInfo
      ? remoteInfo.nodeName || remoteInfo.nodeId
      : entry?.federationNode || (keyIndicatesRemote ? "federation" : "local");
    const remote = remoteInfo ? true : (entry?.federationRemote ?? keyIndicatesRemote);
    return {
      key,
      entry,
      kind: classifySessionKey(key, entry),
      label: entry?.label,
      pinned: entry?.pinned === true ? true : undefined,
      displayName,
      channel,
      subject,
      groupChannel,
      space,
      chatType: entry?.chatType,
      origin,
      coderBackend: entry?.coderBackend,
      updatedAt,
      sessionId: entry?.sessionId,
      systemSent: entry?.systemSent,
      abortedLastRun: entry?.abortedLastRun,
      thinkingLevel: entry?.thinkingLevel,
      verboseLevel: entry?.verboseLevel,
      reasoningLevel: entry?.reasoningLevel,
      elevatedLevel: entry?.elevatedLevel,
      sendPolicy: entry?.sendPolicy,
      inputTokens: entry?.inputTokens,
      outputTokens: entry?.outputTokens,
      totalTokens: total,
      responseUsage: entry?.responseUsage,
      modelProvider: resolvedModel.provider,
      model: `${resolvedModel.provider}/${resolvedModel.model}`,
      modelOverridden: Boolean(entry?.modelOverride?.trim()),
      contextTokens: entry?.contextTokens,
      deliveryContext: deliveryFields.deliveryContext,
      lastChannel: deliveryFields.lastChannel ?? entry?.lastChannel,
      lastTo: deliveryFields.lastTo ?? entry?.lastTo,
      lastAccountId: deliveryFields.lastAccountId ?? entry?.lastAccountId,
      node,
      remote,
    };
  };
  const byUpdatedDesc = (a: number | null | undefined, b: number | null | undefined) =>
    (b ?? 0) - (a ?? 0);

  // First-user-message titles are read lazily and cached so a title search and
  // the page's derivedTitle share one transcript read per session.
  const derivedTitleCache = new Map<string, string | undefined>();
  const derivedTitleFor = (entry: SessionEntry | undefined): string | undefined => {
    if (!entry?.sessionId) return undefined;
    if (derivedTitleCache.has(entry.sessionId)) return derivedTitleCache.get(entry.sessionId);
    const firstUserMsg = readFirstUserMessageFromTranscript(
      entry.sessionId,
      storePath,
      entry.sessionFile,
    );
    const title = deriveSessionTitle(entry, firstUserMsg);
    derivedTitleCache.set(entry.sessionId, title);
    return title;
  };

  const offset =
    typeof opts.offset === "number" && Number.isFinite(opts.offset)
      ? Math.max(0, Math.floor(opts.offset))
      : 0;
  const limit =
    typeof opts.limit === "number" && Number.isFinite(opts.limit)
      ? Math.max(1, Math.floor(opts.limit))
      : undefined;
  const cutoff = activeMinutes !== undefined ? now - activeMinutes * 60_000 : undefined;

  let sessions: ReturnType<typeof buildRow>[];
  let total: number;
  if (search) {
    // Search matches derived fields (display name, title), so build every row.
    sessions = matching.map(buildRow).sort((a, b) => byUpdatedDesc(a.updatedAt, b.updatedAt));
    sessions = sessions.filter((s) => {
      const fields = [s.displayName, s.label, s.subject, s.sessionId, s.key];
      if (fields.some((f) => typeof f === "string" && f.toLowerCase().includes(search)))
        return true;
      // With titles requested, search what the user actually sees as the title.
      return (
        includeDerivedTitles && (derivedTitleFor(s.entry)?.toLowerCase().includes(search) ?? false)
      );
    });
    if (cutoff !== undefined) sessions = sessions.filter((s) => (s.updatedAt ?? 0) >= cutoff);
    total = sessions.length;
    if (offset > 0) sessions = sessions.slice(offset);
    if (limit !== undefined) sessions = sessions.slice(0, limit);
  } else {
    // Sort/filter/page on the raw entries and only build rows for the page:
    // the store holds thousands of sessions and the UI polls for ~30-50.
    let page = matching.sort((a, b) => byUpdatedDesc(a[1]?.updatedAt, b[1]?.updatedAt));
    if (cutoff !== undefined) page = page.filter(([, e]) => (e?.updatedAt ?? 0) >= cutoff);
    total = page.length;
    if (offset > 0) page = page.slice(offset);
    if (limit !== undefined) page = page.slice(0, limit);
    sessions = page.map(buildRow);
  }
  const hasMore = offset + sessions.length < total;

  const finalSessions: GatewaySessionRow[] = sessions.map((s) => {
    const { entry, ...rest } = s;
    let derivedTitle: string | undefined;
    let lastMessagePreview: string | undefined;
    if (entry?.sessionId) {
      if (includeDerivedTitles) derivedTitle = derivedTitleFor(entry);
      if (includeLastMessage) {
        const lastMsg = readLastMessagePreviewFromTranscript(
          entry.sessionId,
          storePath,
          entry.sessionFile,
        );
        if (lastMsg) lastMessagePreview = lastMsg;
      }
    }
    const transcriptPath =
      entry?.sessionFile ?? (entry?.sessionId ? `${entry.sessionId}.jsonl` : undefined);
    return {
      ...rest,
      derivedTitle,
      lastMessagePreview,
      transcriptPath,
    } satisfies GatewaySessionRow;
  });

  return {
    ts: now,
    path: storePath,
    count: finalSessions.length,
    total,
    hasMore,
    defaults: getSessionDefaults(cfg),
    sessions: finalSessions,
  };
}
