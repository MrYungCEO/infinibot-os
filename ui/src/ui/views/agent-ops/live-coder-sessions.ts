/**
 * Live Coder Sessions → World-Map agents
 * ──────────────────────────────────────
 * Ad-hoc coder sub-agents spawned via the InfiniBot `claude_coder` MCP tool /
 * gateway coder spawn run as CLI processes (Claude Code / Codex / OpenCode /
 * Gemini) in their own session. They are NOT in the subagent progress registry
 * that `subagents.list` reads (that store is only populated by native Task()
 * sub-agents + explicit checkpoints), and they carry a `claude-code:<uuid>`
 * (kind `direct`) session key that the `AgencyDataBridge` subagent filter
 * intentionally skips. Result: a live coder never gets a world-map sprite.
 *
 * This module is the missing producer. It reads the ONE gateway surface that
 * DOES track live coder CLIs — `sessions.list` with an `activeMinutes`
 * recency window — filters to the coder-CLI channels, and normalizes each into
 * a `MeshAgent` stamped with `coderBackend` so the iso engine renders it with
 * the distinct backend ninja sprite + logo badge (see resolveAgentSpriteSlot),
 * clearly setting coders apart from roster employees.
 *
 * Liveness / removal is recency-driven: a coder that finishes stops bumping its
 * session `updatedAt` and drops out of the `activeMinutes` window, so the
 * bridge's diff-based reconcile emits `agent.complete` for it and the sprite
 * fades. A very-recently-active coder reads as `working` (running); one that has
 * gone quiet inside the window reads as `idle` (winding down → greyed), giving a
 * live status without any new gateway RPC or event topic.
 *
 * Pure data-plane: no Pixi, no engine, no renderer fork. Additive by design —
 * it only ever emits coder-CLI keys, which never collide with the roster /
 * native-subagent keys the bridge already manages.
 */

import type { GatewayBrowserClient } from "../../gateway";
import type { MeshAgent } from "./activity-map";

/** How far back a session's last activity may be and still count as a live
 *  coder. A running coder streams tool/message activity well inside this, so
 *  it stays put; a finished one ages out (→ removed) within roughly this
 *  window + the bridge's 10s reconcile tick. */
export const CODER_ACTIVE_WINDOW_MIN = 6;

/** Under this age (ms) a coder is actively "running"; above it (but still in
 *  the window) it's gone quiet and renders idle/greyed. */
const RUNNING_FRESH_MS = 100_000;

const LOCAL = "local";

/** CLI backends we treat as coder sub-agents on the map. */
type CoderBackend = NonNullable<MeshAgent["coderBackend"]>;

const CHANNEL_TO_BACKEND: Record<string, CoderBackend> = {
  "claude-code": "claude-code",
  "claude-coder": "claude-code",
  codex: "codex",
  opencode: "opencode",
  gemini: "gemini",
  grok: "grok",
};

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" && v ? v : fallback;
}

/**
 * Resolve the coder backend for a raw `sessions.list` row, or null when the
 * row is not a coder CLI (voice terminal, webchat World Manager, plain shell,
 * native sub-agent, …). Checks the explicit channel/origin surface first, then
 * falls back to the session-key namespace (`agent:main:<channel>:<id>`).
 */
export function coderBackendFromSessionRow(row: any): CoderBackend | null {
  const channel = asString(row?.channel).toLowerCase();
  if (CHANNEL_TO_BACKEND[channel]) return CHANNEL_TO_BACKEND[channel];

  const surface = asString(row?.origin?.surface).toLowerCase();
  if (CHANNEL_TO_BACKEND[surface]) return CHANNEL_TO_BACKEND[surface];

  const key = asString(row?.key || row?.sessionKey).toLowerCase();
  const m = key.match(/:(claude-code|claude-coder|codex|opencode|gemini|grok):/);
  if (m && CHANNEL_TO_BACKEND[m[1]]) return CHANNEL_TO_BACKEND[m[1]];

  return null;
}

/**
 * Build a compact, human-friendly label from a coder session row.
 * `derivedTitle` looks like "Claude Code • InfiniBot-fresh • @feat/foo"; we
 * strip the leading backend name (the sprite badge already conveys it) and
 * keep the workdir + branch. Falls back to the plain label / key tail.
 */
function friendlyCoderLabel(row: any): string {
  const derived = asString(row?.derivedTitle);
  if (derived) {
    const parts = derived
      .split("•")
      .map((s) => s.trim())
      .filter(Boolean);
    // Drop a leading "Claude Code" / "Codex" / … segment.
    if (parts.length > 1 && /^(claude code|codex|opencode|gemini|grok build)/i.test(parts[0])) {
      parts.shift();
    }
    const joined = parts.join(" ").trim();
    if (joined) return joined.length > 48 ? joined.slice(0, 47) + "…" : joined;
  }
  const label = asString(row?.label);
  if (label) return label;
  const key = asString(row?.key || row?.sessionKey);
  const tail = key.split(":").pop() || key;
  return tail.slice(0, 12) || "coder";
}

/**
 * Some claude-code sessions are not coder sub-agents at all (the always-on
 * voice/World-Manager agent, webchat surfaces). Exclude the ones we can
 * confidently identify so the map shows spawned coders, not the ambient agent.
 */
function isExcludedSurface(row: any): boolean {
  const key = asString(row?.key || row?.sessionKey).toLowerCase();
  if (key.includes("world-terminal") || key.includes("terminal-voice")) return true;
  const origin = asString(row?.origin?.surface).toLowerCase();
  if (origin === "webchat") return true;
  const derived = asString(row?.derivedTitle).toLowerCase();
  if (derived.startsWith("you are the world manager")) return true;
  return false;
}

/**
 * Map a batch of raw `sessions.list` rows into live-coder MeshAgents.
 * `now` is injected for deterministic recency classification/testing.
 */
export function mapLiveCoderAgents(rows: any[], now: number): MeshAgent[] {
  const out: MeshAgent[] = [];
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    if (isExcludedSurface(row)) continue;
    const backend = coderBackendFromSessionRow(row);
    if (!backend) continue;
    const key = asString(row?.key || row?.sessionKey);
    if (!key) continue;

    const updatedAt = Number(row?.updatedAt ?? row?.lastActivityAt ?? 0) || 0;
    const quiet = updatedAt > 0 && now - updatedAt > RUNNING_FRESH_MS;

    out.push({
      sessionKey: key,
      agentId: `coder:${key.split(":").pop() || key}`,
      label: friendlyCoderLabel(row),
      nodeId: asString(row?.node || row?.nodeId, LOCAL) || LOCAL,
      // Fresh → running (working); gone quiet within the window → winding down.
      status: quiet ? "idle" : "working",
      progress: 0,
      currentTask: asString(row?.derivedTitle) || undefined,
      coderBackend: backend,
    });
  }
  return out;
}

/**
 * Fetch the current set of live coder-CLI sub-agents as MeshAgents. Uses the
 * `activeMinutes` recency window so completed coders self-expire. Never throws
 * — a failed/absent RPC degrades to "no coders" rather than breaking the map.
 */
export async function fetchLiveCoderAgents(
  client: GatewayBrowserClient,
  opts: { windowMin?: number; limit?: number; now?: number } = {},
): Promise<MeshAgent[]> {
  const windowMin = opts.windowMin ?? CODER_ACTIVE_WINDOW_MIN;
  const limit = opts.limit ?? 60;
  try {
    const res = await client.request<any>("sessions.list", {
      activeMinutes: windowMin,
      includeDerivedTitles: true,
      limit,
    });
    const rows: any[] = res?.sessions || res?.rows || [];
    return mapLiveCoderAgents(rows, opts.now ?? Date.now());
  } catch {
    return [];
  }
}
