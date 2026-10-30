export type ExternalSessionStatus =
  | "starting"
  | "idle"
  | "working"
  | "blocked"
  | "completed"
  | "failed";

export type ExternalSessionCoderBackend = "claude-code" | "opencode" | "codex" | "gemini" | "grok";

export type ExternalSessionRecord = {
  sessionKey: string;
  agentId: string;
  label: string;
  nodeId: string;
  status: ExternalSessionStatus;
  currentTask?: string;
  coderBackend?: ExternalSessionCoderBackend;
  lastHeartbeatMs: number;
  expiresAtMs: number;
};

export type AnnounceExternalSessionInput = {
  sessionKey: string;
  agentId?: string;
  label: string;
  nodeId?: string;
  status?: ExternalSessionStatus;
  currentTask?: string;
  coderBackend?: ExternalSessionCoderBackend;
  ttlSeconds?: number;
};

const DEFAULT_TTL_SECONDS = 90;
const MAX_TTL_SECONDS = 600;
const MAX_RECORDS = 64;
const SWEEP_INTERVAL_MS = 15_000;

const externalSessions = new Map<string, ExternalSessionRecord>();
let sweeper: NodeJS.Timeout | null = null;

function clampTtlSeconds(ttlSeconds: number | undefined): number {
  if (typeof ttlSeconds !== "number" || !Number.isFinite(ttlSeconds)) {
    return DEFAULT_TTL_SECONDS;
  }
  return Math.min(MAX_TTL_SECONDS, Math.max(1, Math.floor(ttlSeconds)));
}

function dropExpired(now = Date.now()): void {
  for (const [sessionKey, record] of externalSessions) {
    if (record.expiresAtMs <= now) {
      externalSessions.delete(sessionKey);
    }
  }
}

function evictOldestIfNeeded(): void {
  while (externalSessions.size > MAX_RECORDS) {
    let oldestKey: string | null = null;
    let oldestHeartbeat = Number.POSITIVE_INFINITY;
    for (const [sessionKey, record] of externalSessions) {
      if (record.lastHeartbeatMs < oldestHeartbeat) {
        oldestKey = sessionKey;
        oldestHeartbeat = record.lastHeartbeatMs;
      }
    }
    if (!oldestKey) return;
    externalSessions.delete(oldestKey);
  }
}

function ensureSweeperStarted(): void {
  if (sweeper) return;
  sweeper = setInterval(() => {
    dropExpired();
    if (externalSessions.size === 0 && sweeper) {
      clearInterval(sweeper);
      sweeper = null;
    }
  }, SWEEP_INTERVAL_MS);
  sweeper.unref?.();
}

export function announceExternalSession(
  input: AnnounceExternalSessionInput,
): ExternalSessionRecord {
  const now = Date.now();
  const ttlSeconds = clampTtlSeconds(input.ttlSeconds);
  const record: ExternalSessionRecord = {
    sessionKey: input.sessionKey,
    agentId: input.agentId ?? "coder",
    label: input.label,
    nodeId: input.nodeId ?? "local",
    status: input.status ?? "working",
    currentTask: input.currentTask,
    coderBackend: input.coderBackend,
    lastHeartbeatMs: now,
    expiresAtMs: now + ttlSeconds * 1000,
  };

  dropExpired(now);
  externalSessions.set(record.sessionKey, record);
  evictOldestIfNeeded();
  ensureSweeperStarted();
  return { ...record };
}

export function removeExternalSession(sessionKey: string): boolean {
  return externalSessions.delete(sessionKey);
}

export function listExternalSessions(): ExternalSessionRecord[] {
  dropExpired();
  return Array.from(externalSessions.values())
    .sort((a, b) => b.lastHeartbeatMs - a.lastHeartbeatMs)
    .map((record) => ({ ...record }));
}
