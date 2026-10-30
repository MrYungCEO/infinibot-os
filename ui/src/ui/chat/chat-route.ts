/**
 * Chat routing for the composer's Agent | CLI switch.
 *
 * A chat thread talks either to the gateway agent (the default) or to a coding
 * CLI (Claude Code / Codex / OpenCode / Gemini CLI / Grok Build) in a working folder. The
 * choice is per thread: saved in localStorage under the thread's session key
 * (and on the gateway via `chat.cli.mode` when it has that method), with a
 * "draft" slot for a chat that has not been created yet.
 *
 * Pure helpers here are unit-tested in chat-route.test.ts; the UI lives in
 * components/chat-mode-switcher.ts and views/webchat.ts.
 */

export type CliBackendId = "claude-code" | "codex" | "opencode" | "gemini" | "grok";

export const CLI_BACKENDS: readonly CliBackendId[] = ["claude-code", "codex", "opencode", "gemini", "grok"];

export const CLI_LABELS: Record<CliBackendId, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  gemini: "Gemini CLI",
  grok: "Grok Build",
};

export type ChatRoute =
  | { mode: "agent" }
  | { mode: "cli"; backend: CliBackendId; cwd?: string; model?: string };

export const AGENT_ROUTE: ChatRoute = { mode: "agent" };

/** Route id used for comparisons / badges: "agent" or the backend id. */
export type RouteId = "agent" | CliBackendId;

export function routeId(route: ChatRoute | null | undefined): RouteId {
  return route?.mode === "cli" ? route.backend : "agent";
}

export function normalizeBackend(raw: unknown): CliBackendId | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase().replace(/-cli$/, "");
  if (v === "claude" || v === "claude-code" || v === "claudecode" || v === "cc") return "claude-code";
  if (v === "codex") return "codex";
  if (v === "opencode" || v === "oc") return "opencode";
  if (v === "gemini") return "gemini";
  if (v === "grok" || v === "grok-build" || v === "grokbuild") return "grok";
  return null;
}

// ── persistence ──────────────────────────────────────────────────────────

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const ROUTE_PREFIX = "infinibot.chat.route.";
/** Slot for a chat that has no session key yet (the empty "New chat" composer). */
export const DRAFT_ROUTE_KEY = "__draft";
const RECENT_FOLDERS_KEY = "infinibot.chat.cli.recentFolders";
const LAST_CLI_KEY = "infinibot.chat.cli.last";

function store(): StorageLike | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export function parseRoute(raw: unknown): ChatRoute | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.mode === "agent") return { mode: "agent" };
  if (r.mode !== "cli") return null;
  const backend = normalizeBackend(r.backend);
  if (!backend) return null;
  const out: ChatRoute = { mode: "cli", backend };
  if (typeof r.cwd === "string" && r.cwd.trim()) out.cwd = r.cwd.trim();
  if (typeof r.model === "string" && r.model.trim()) out.model = r.model.trim();
  return out;
}

export function readRoute(threadKey: string | null, s: StorageLike | null = store()): ChatRoute {
  try {
    const raw = s?.getItem(ROUTE_PREFIX + (threadKey || DRAFT_ROUTE_KEY));
    return (raw && parseRoute(JSON.parse(raw))) || AGENT_ROUTE;
  } catch {
    return AGENT_ROUTE;
  }
}

export function writeRoute(threadKey: string | null, route: ChatRoute, s: StorageLike | null = store()): void {
  try {
    const key = ROUTE_PREFIX + (threadKey || DRAFT_ROUTE_KEY);
    if (route.mode === "agent") s?.removeItem(key);
    else s?.setItem(key, JSON.stringify(route));
    if (route.mode === "cli") s?.setItem(LAST_CLI_KEY, JSON.stringify(route));
  } catch {
    /* quota / private mode */
  }
}

/** The CLI the user picked most recently (what "CLI" in the segmented control switches to). */
export function readLastCli(s: StorageLike | null = store()): Extract<ChatRoute, { mode: "cli" }> | null {
  try {
    const raw = s?.getItem(LAST_CLI_KEY);
    const r = raw ? parseRoute(JSON.parse(raw)) : null;
    return r?.mode === "cli" ? r : null;
  } catch {
    return null;
  }
}

/** A new chat inherits the draft route; once created, the route moves to the thread's key. */
export function adoptDraftRoute(threadKey: string, s: StorageLike | null = store()): ChatRoute {
  const draft = readRoute(null, s);
  if (draft.mode === "cli") writeRoute(threadKey, draft, s);
  return draft;
}

export function readRecentFolders(s: StorageLike | null = store()): string[] {
  try {
    const raw = s?.getItem(RECENT_FOLDERS_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").slice(0, 8) : [];
  } catch {
    return [];
  }
}

export function rememberFolder(folder: string, s: StorageLike | null = store()): string[] {
  const f = folder.trim();
  if (!f) return readRecentFolders(s);
  const next = [f, ...readRecentFolders(s).filter((x) => x !== f)].slice(0, 8);
  try {
    s?.setItem(RECENT_FOLDERS_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  return next;
}

// ── slash commands ───────────────────────────────────────────────────────

export type RouteCommand =
  | { kind: "cli"; backend: CliBackendId | null; cwd?: string }
  | { kind: "agent"; agentId?: string }
  | { kind: "cli-unknown"; name: string };

/**
 * `/cli codex [folder]`, `/cli` (last CLI), `/codex`, `/claude-code`, `/agent [id]`.
 * Returns null for anything else (it goes to the agent / CLI as typed).
 * `/claude` is left alone — it is the gateway's own Claude bridge command.
 */
export function parseRouteCommand(text: string): RouteCommand | null {
  const t = text.trim();
  const m = t.match(/^\/(cli|agent|codex|opencode|gemini|claude-code)(?:\s+([\s\S]*))?$/i);
  if (!m) return null;
  const cmd = m[1].toLowerCase();
  const rest = (m[2] ?? "").trim();
  if (cmd === "agent") return rest ? { kind: "agent", agentId: rest.split(/\s+/)[0] } : { kind: "agent" };
  if (cmd !== "cli") {
    return { kind: "cli", backend: normalizeBackend(cmd), ...(rest ? { cwd: rest } : {}) };
  }
  if (!rest) return { kind: "cli", backend: null };
  const [first, ...more] = rest.split(/\s+/);
  const backend = normalizeBackend(first);
  if (!backend) {
    // `/cli ~/proj` → the last CLI in that folder.
    if (/^[~/.]/.test(first)) return { kind: "cli", backend: null, cwd: rest };
    return { kind: "cli-unknown", name: first };
  }
  const cwd = more.join(" ").trim();
  return { kind: "cli", backend, ...(cwd ? { cwd } : {}) };
}

/** Slash-popup entries for the route commands. */
export const ROUTE_COMMAND_HINTS: ReadonlyArray<{ command: string; description: string }> = [
  { command: "/cli claude", description: "Chat with Claude Code in a folder" },
  { command: "/cli codex", description: "Chat with Codex in a folder" },
  { command: "/cli opencode", description: "Chat with OpenCode in a folder" },
  { command: "/cli gemini", description: "Chat with Gemini CLI in a folder" },
  { command: "/cli grok", description: "Chat with Grok Build in a folder" },
  { command: "/agent", description: "Back to the InfiniBot agent" },
];

// ── backend availability ─────────────────────────────────────────────────

export type BackendStatus = "ready" | "login" | "unavailable";

export type CliBackendInfo = {
  id: CliBackendId;
  label: string;
  status: BackendStatus;
  /** Why it isn't ready, in plain words. */
  detail?: string;
  version?: string;
  /** Model the CLI uses when none is picked. */
  defaultModel?: string;
  /** The gateway can't run this CLI from chat yet (needs the chat.cli update). */
  needsUpdate?: boolean;
};

/** cliRouting.status backend row (controllers/cli-routing.ts) → chat backend info. */
export function backendInfoFromRouting(row: {
  id: string;
  installed: boolean;
  auth?: string;
  ready?: boolean;
  version?: string;
  model?: string;
}): CliBackendInfo | null {
  const id = normalizeBackend(row.id);
  if (!id) return null;
  let status: BackendStatus;
  let detail: string | undefined;
  if (!row.installed) {
    status = "unavailable";
    detail = "Not installed";
  } else if (row.auth === "signed-out") {
    status = "login";
    detail = "Needs sign-in";
  } else {
    status = "ready";
  }
  return {
    id,
    label: CLI_LABELS[id],
    status,
    detail,
    version: row.version?.match(/\d+\.\d+(?:\.\d+)?/)?.[0],
    defaultModel: row.model && row.model !== "default" ? row.model : undefined,
  };
}

/**
 * Model suggestions per backend (free text is allowed too). Only stable names:
 * Claude Code's aliases and Gemini's published ids. Codex / OpenCode model
 * lists change with the account, so they take a typed name (empty = the CLI's
 * own default).
 */
export const CLI_MODEL_CHOICES: Record<CliBackendId, string[]> = {
  "claude-code": ["opus", "sonnet", "haiku"],
  codex: [],
  opencode: [],
  gemini: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"],
  grok: ["grok-build", "grok-4.6", "grok-code-fast-1"],
};

// ── thread rendering helpers ─────────────────────────────────────────────

/** `cli` meta the gateway stamps on CLI-mode messages (server-methods/chat-cli.ts). */
export function messageRoute(msg: unknown): RouteId {
  if (!msg || typeof msg !== "object") return "agent";
  const cli = (msg as { cli?: { backend?: unknown } }).cli;
  return normalizeBackend(cli?.backend) ?? "agent";
}

export function routeLabel(id: RouteId, agentLabel = "Agent"): string {
  return id === "agent" ? agentLabel : CLI_LABELS[id];
}

/**
 * Indexes of turns that start a new route, for the "Switched to Codex"
 * dividers. The first turn never gets one unless the thread opened in CLI mode.
 */
export function routeDividers(routes: RouteId[]): Array<{ index: number; to: RouteId }> {
  const out: Array<{ index: number; to: RouteId }> = [];
  routes.forEach((r, i) => {
    const prev = i === 0 ? "agent" : routes[i - 1];
    if (r !== prev) out.push({ index: i, to: r });
  });
  return out;
}

/**
 * Notices the gateway's `/claude` bridge replies with (the fallback CLI path
 * on gateways without chat.cli). Rendered as dividers, not chat bubbles.
 */
export function claudeBridgeNotice(text: string): "on" | "off" | null {
  const t = text.trim();
  if (/^\S*\s*Claude mode ON\b/.test(t)) return "on";
  if (/^\S*\s*Claude mode OFF\b/.test(t) || /^Claude mode is already off/.test(t)) return "off";
  return null;
}

/** Last path segment, for compact folder chips. */
export function folderName(p: string | undefined | null): string {
  if (!p) return "Home";
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || p;
}
