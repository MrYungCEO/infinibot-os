/**
 * Unified reattachable-session classifier.
 *
 * After a gateway restart the in-memory terminal map is empty until
 * `reconcileTmuxSessions()` (which deliberately SKIPS `spawn-*` agent
 * sessions) and subagent recovery repopulate it — so the reattach dropdowns,
 * which historically sourced only `terminal.list` (= in-memory terminals),
 * never showed the live cloud/codex agent panes and could race the CLI ones.
 *
 * This module turns the ground-truth list of LIVE tmux sessions (queried
 * directly, never the in-memory map) into a unified, UI-consumable list of
 * reattachable entries, each carrying the exact RPC + params needed to
 * reattach to that kind of session WITHOUT respawning the process.
 *
 * The classifier here is PURE (no I/O) so it is unit-testable; the gateway
 * handler resolves the live data and hands it in.
 */

/** What kind of session a live tmux pane is backing. */
export type ReattachableKind = "cloud" | "codex" | "cli" | "shell";

/** How the UI should reattach to a given entry. */
export interface ReattachDirective {
  /**
   * - `terminal.reattachSpawnAgent` — cloud/codex agent panes (`spawn-*`).
   *   Re-binds the exit listener + spawn metadata without re-invoking the CLI.
   * - `terminal.create` — CLI/shell panes. Idempotent: `createTerminal`
   *   returns early if the id is already live, and otherwise spawns a
   *   tmux `new-session -A` which ATTACHES to the surviving pane rather than
   *   starting a fresh shell. Never double-taps a pane already in memory.
   */
  method: "terminal.reattachSpawnAgent" | "terminal.create";
  params: Record<string, unknown>;
}

/** A single live, reattachable session surfaced to the reattach dropdowns. */
export interface ReattachableEntry {
  /** Terminal id (== tmux session id sans the `infinibot_` prefix). */
  id: string;
  /** Session key when known (agent session key / terminal session key). */
  sessionKey?: string;
  kind: ReattachableKind;
  /** Coder backend for agent panes: claude-code | opencode | codex | gemini. */
  backend?: string;
  /** Human label for the dropdown row. */
  label: string;
  /** Full subagent run id (cloud/codex only). */
  runId?: string;
  /** Target agent id (cloud/codex only). */
  agentId?: string;
  cwd: string;
  /** Always true — we only ever emit sessions we saw live in tmux. */
  live: true;
  /** Federation node id; undefined/"local" for the master. */
  nodeId?: string;
  /**
   * True when this is a `spawn-*` agent pane that THIS gateway instance cannot
   * prove it owns. Separate state directories now use separate tmux sockets,
   * but another gateway on the same state directory can still expose a pane in
   * `listLiveSessions()` that this process does not own.
   * Reattaching to one gives a pty client over someone else's run and — before
   * the destroy guard existed — closing it killed that run. Callers must not
   * offer foreign entries as reattachable.
   */
  foreign?: boolean;
  reattach: ReattachDirective;
}

/** Minimal subagent run shape the classifier cross-references. */
export interface SpawnRunLite {
  runId: string;
  terminalId?: string;
  agentId?: string;
  workdir?: string;
  label?: string;
  coderBackend?: "claude-code" | "opencode" | "codex" | "gemini" | "grok";
  childSessionKey?: string;
  task?: string;
}

/** Minimal live in-memory terminal shape (for CLI/shell enrichment). */
export interface LiveTermLite {
  cliType?: string;
  title?: string;
  cwd?: string;
  sessionKey?: string;
  isClaudeMode?: boolean;
}

/** Minimal persisted-session shape (for CLI/shell enrichment). */
export interface SavedTermLite {
  title?: string;
  cwd?: string;
  cliType?: string;
  isClaudeMode?: boolean;
}

export interface ClassifyContext {
  /** Live tmux terminal ids (from `TmuxBackend.listLiveSessions()`). */
  liveIds: string[];
  /** All known subagent runs (from `listAllSubagentRuns()`). */
  runs: SpawnRunLite[];
  /** In-memory terminals keyed by id (from `terminalManager`). */
  memTerminals: Map<string, LiveTermLite>;
  /** Persisted sessions keyed by id. */
  savedSessions: Map<string, SavedTermLite>;
  /** Best-effort cwd per id (from `TmuxBackend.getSessionCwd`) — fallback only. */
  cwdFallback: Map<string, string>;
  /** Federation node id to stamp on every entry (undefined for local). */
  nodeId?: string;
  /**
   * Sanitized `spawn-*` terminal ids this instance can prove it owns (its own
   * registry runs, its own durable run dirs, its own persisted sessions).
   * Any live spawn pane outside this set belongs to another instance sharing
   * the tmux socket and is flagged `foreign`.
   *
   * Omit to disable the ownership check entirely (every pane counts as ours).
   */
  ownedSpawnIds?: Set<string>;
}

const AGENT_CLI_TYPES = new Set(["claude", "opencode", "gemini", "codex", "grok", "ollama"]);

/**
 * tmux session names disallow `.`/`:`/`-`; `tmuxSessionName()` replaces every
 * non-`[A-Za-z0-9_]` char with `_`. Mirror that here so we can compare a live
 * (sanitized) id against a registry-stored (original) terminal id.
 */
export function sanitizeTerminalId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, "_");
}

/** True for either the original (`spawn-…`) or sanitized (`spawn_…`) form. */
export function isSpawnSessionId(id: string): boolean {
  return /^spawn[-_]/.test(id);
}

/**
 * Parse a spawn-agent terminal id into its parts. A spawn terminal is created
 * as `spawn-<runId8>-<epochMs>`, but by the time it comes back from
 * `listLiveSessions()` the enclosing tmux session name has been sanitized
 * (hyphens → underscores), so the SAME pane surfaces as `spawn_<runId8>_<epochMs>`.
 * We accept both separators. `runId.slice(0,8)` never contains a hyphen (uuids
 * hyphenate at index 8), so the prefix is unambiguous.
 */
export function parseSpawnTerminalId(
  id: string,
): { runIdPrefix: string; startedAtMs?: number } | null {
  const m = /^spawn[-_]([0-9a-zA-Z]+)[-_](\d+)$/.exec(id);
  if (m) return { runIdPrefix: m[1], startedAtMs: Number(m[2]) };
  // Still recognise a malformed spawn-* id so it's classified as an agent
  // pane rather than misfiled as a shell.
  if (isSpawnSessionId(id)) {
    const rest = id.slice("spawn-".length);
    const prefix = rest.split(/[-_]/)[0] || rest;
    return { runIdPrefix: prefix };
  }
  return null;
}

/** Map a coder backend to the agent-pane kind. Codex gets its own bucket. */
export function backendToKind(backend?: string): "cloud" | "codex" {
  return backend === "codex" ? "codex" : "cloud";
}

/** Pretty backend label for dropdown rows. */
function backendLabel(backend?: string): string {
  switch (backend) {
    case "claude-code":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "opencode":
      return "OpenCode";
    case "gemini":
      return "Gemini";
    case "grok":
      return "Grok Build";
    default:
      return "Cloud agent";
  }
}

/**
 * Find the subagent run backing a spawn terminal id. Prefers an exact
 * `terminalId` match (unambiguous), then falls back to matching the 8-char
 * runId prefix embedded in the terminal id. Returns undefined when the
 * registry hasn't recovered yet.
 */
function matchRunForSpawn(
  id: string,
  runIdPrefix: string,
  runs: SpawnRunLite[],
): SpawnRunLite | undefined {
  // `id` is the sanitized live id; registry terminalIds are the originals, so
  // compare after sanitizing both sides.
  const exact = runs.find((r) => r.terminalId && sanitizeTerminalId(r.terminalId) === id);
  if (exact) return exact;
  return runs.find((r) => r.runId.slice(0, 8) === runIdPrefix || r.runId.startsWith(runIdPrefix));
}

function classifyOne(id: string, ctx: ClassifyContext): ReattachableEntry {
  const spawn = parseSpawnTerminalId(id);
  if (spawn) {
    // ── Cloud / Codex agent pane ────────────────────────────────────────
    const run = matchRunForSpawn(id, spawn.runIdPrefix, ctx.runs);
    const backend = run?.coderBackend;
    const kind = backendToKind(backend);
    // runId: prefer the real run id; fall back to the id-embedded prefix so a
    // pre-recovery registry still yields a reattachable (terminalId + runId).
    const runId = run?.runId ?? spawn.runIdPrefix;
    const agentId = run?.agentId ?? run?.childSessionKey?.split(":")[1] ?? "agent";
    const cwd = run?.workdir ?? ctx.cwdFallback.get(id) ?? ".";
    // Emit the CANONICAL terminal id — the original `spawn-…` from the registry
    // when we matched a run, else the sanitized live id. Using the registry's id
    // means reattach keys the in-memory map / spawn-meta the same way boot
    // recovery does, so `terminal.reattachSpawnAgent`'s guard fires instead of
    // double-attaching a second node-pty client to the same pane. Both forms
    // sanitize to the same tmux session name, so either still resolves the pane.
    const canonicalId = run?.terminalId ?? id;
    // Ownership: a pane we matched to one of our own runs is ours by
    // construction; otherwise consult the caller-supplied owned-id set. With no
    // set supplied the check is disabled (every pane counts as ours).
    const foreign = run
      ? false
      : ctx.ownedSpawnIds
        ? !ctx.ownedSpawnIds.has(sanitizeTerminalId(canonicalId))
        : false;
    const taskHint = run?.task ? ` · ${run.task.slice(0, 40)}` : "";
    const label = run?.label
      ? `${backendLabel(backend)} · ${run.label}`
      : `${backendLabel(backend)}${taskHint || ` · ${spawn.runIdPrefix}`}`;
    return {
      id: canonicalId,
      sessionKey: run?.childSessionKey,
      kind,
      backend: backend ?? "unknown",
      label,
      runId,
      agentId,
      cwd,
      live: true,
      nodeId: ctx.nodeId,
      ...(foreign ? { foreign: true as const } : {}),
      reattach: {
        method: "terminal.reattachSpawnAgent",
        params: {
          terminalId: canonicalId,
          runId,
          sessionKey: run?.childSessionKey ?? "",
          agentId,
          label: run?.label,
          cwd,
        },
      },
    };
  }

  // ── CLI / shell pane ──────────────────────────────────────────────────
  const mem = ctx.memTerminals.get(id);
  const saved = ctx.savedSessions.get(id);
  const cliType = (mem?.cliType ?? saved?.cliType ?? "").toLowerCase();
  const isClaude = mem?.isClaudeMode ?? saved?.isClaudeMode ?? cliType === "claude";
  const isAgentCli = isClaude || AGENT_CLI_TYPES.has(cliType);
  const kind: ReattachableKind = isAgentCli ? "cli" : "shell";
  const cwd = mem?.cwd ?? saved?.cwd ?? ctx.cwdFallback.get(id) ?? ".";
  const title = mem?.title ?? saved?.title;
  const label =
    title ||
    (isAgentCli
      ? `${cliType ? cliType.toUpperCase() : "CLI"} · ${id.slice(0, 8)}`
      : `Shell · ${id.slice(0, 8)}`);
  return {
    id,
    sessionKey: mem?.sessionKey,
    kind,
    backend: isAgentCli && cliType ? cliType : undefined,
    label,
    cwd,
    live: true,
    nodeId: ctx.nodeId,
    reattach: {
      method: "terminal.create",
      params: {
        id,
        cwd,
        ...(title ? { title } : {}),
        ...(cliType ? { cliType } : {}),
      },
    },
  };
}

/**
 * Classify every live tmux session into a unified reattachable entry. Pure:
 * all live data is supplied via {@link ClassifyContext}.
 *
 * Entries flagged `foreign` (another instance's agent pane — see
 * {@link ReattachableEntry.foreign}) are still returned so callers can report
 * on them; use {@link splitForeignEntries} to get the offerable subset.
 */
export function classifyReattachable(ctx: ClassifyContext): ReattachableEntry[] {
  return ctx.liveIds.map((id) => classifyOne(id, ctx));
}

/** Split classified entries into the ones we may offer and the foreign ones. */
export function splitForeignEntries(entries: ReattachableEntry[]): {
  entries: ReattachableEntry[];
  foreign: ReattachableEntry[];
} {
  const own: ReattachableEntry[] = [];
  const foreign: ReattachableEntry[] = [];
  for (const e of entries) (e.foreign ? foreign : own).push(e);
  return { entries: own, foreign };
}
