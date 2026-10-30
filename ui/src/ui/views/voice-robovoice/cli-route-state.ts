/**
 * Voice → CLI session routing — pure state for <voice-cli-route-control>
 * (no DOM, no gateway: tested in node).
 *
 * The gateway owns the switch (voice.cliRoute.*, src/gateway/voice/
 * voice-cli-route.ts): "api" = voice → InfiniBot voice agent → LLM; "cli" =
 * the owner's voice turns are typed into the selected CLI session and its
 * output is spoken. The page mirrors the last answer in localStorage so the
 * control paints the right state before the first RPC returns.
 */

import type { VoiceCliSelection } from "../../components/terminal-stream-source.js";

export type CliTarget = {
  kind: "terminal" | "coder";
  terminalId?: string;
  runId?: string;
  cliType?: string;
  label: string;
  cwd?: string;
};

export type CliRoute = {
  mode: "api" | "cli";
  target?: CliTarget;
  updatedAt: string;
  fallback?: { at: string; reason: string; target?: CliTarget };
  /** Voice brain model for API turns (`provider/model`); unset = the agent's model. */
  model?: string;
};

export type CliRoutePayload = {
  route: CliRoute;
  /** null = unknown (host not reachable). */
  alive: boolean | null;
  approval?: { question: string; at: number };
  lastTurn?: { at: number; utterance: string; reply: string; firstSpokenMs: number | null; totalMs: number; path: string };
};

export type OpenSession = {
  kind: "terminal" | "coder";
  id: string;
  terminalId?: string;
  runId?: string;
  label: string;
  cliType: string;
  cwd: string;
  status: "live" | "running" | "detached";
  needsAttach?: boolean;
  createdAt?: string;
  lastActiveAt?: string;
  task?: string;
};

export type InstalledCli = { id: string; name: string; bin: string; path: string; coderBackend?: boolean; managed: boolean };

export type CliCatalogue = {
  open: OpenSession[];
  installed: InstalledCli[];
  missing: string[];
  runtime: "local" | "tenant-container";
  unavailableReason?: string;
};

export const CLI_ROUTE_STORAGE_KEY = "infinibot.voice.cliRoute";

type Store = Pick<Storage, "getItem" | "setItem">;

function browserStore(): Store | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Last route the gateway reported (instant first paint); "api" when unknown. */
export function loadCachedRoute(store: Store | null = browserStore()): CliRoute {
  try {
    const raw = store?.getItem(CLI_ROUTE_STORAGE_KEY);
    const v = raw ? (JSON.parse(raw) as CliRoute) : null;
    if (v && (v.mode === "api" || v.mode === "cli")) return v.mode === "cli" && !v.target ? { ...v, mode: "api" } : v;
  } catch {
    /* fall through */
  }
  return { mode: "api", updatedAt: new Date(0).toISOString() };
}

export function saveCachedRoute(route: CliRoute, store: Store | null = browserStore()): void {
  try {
    store?.setItem(CLI_ROUTE_STORAGE_KEY, JSON.stringify(route));
  } catch {
    /* private mode */
  }
}

const NAMES: Record<string, string> = {
  claude: "Claude Code",
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  gemini: "Gemini",
  aider: "Aider",
  qwen: "Qwen Code",
  goose: "Goose",
  "cursor-agent": "Cursor Agent",
  amp: "Amp",
  crush: "Crush",
  ollama: "Ollama",
  shell: "Shell",
};

export function cliName(cliType: string | undefined): string {
  return NAMES[(cliType ?? "").toLowerCase()] ?? (cliType || "Shell");
}

/** "~/Desktop/Development/app" → "…/Development/app" (fits a row). */
export function shortCwd(cwd: string | undefined, max = 34): string {
  if (!cwd) return "";
  const home = cwd.replace(/^\/home\/[^/]+|^\/Users\/[^/]+/, "~");
  if (home.length <= max) return home;
  const parts = home.split("/");
  let out = parts[parts.length - 1];
  for (let i = parts.length - 2; i >= 0; i--) {
    const next = `${parts[i]}/${out}`;
    if (next.length + 2 > max) break;
    out = next;
  }
  return `…/${out}`;
}

export function targetOf(s: OpenSession): CliTarget {
  return {
    kind: s.kind,
    ...(s.terminalId ? { terminalId: s.terminalId } : {}),
    ...(s.runId ? { runId: s.runId } : {}),
    cliType: s.cliType,
    label: s.label,
    ...(s.cwd ? { cwd: s.cwd } : {}),
  };
}

export function sameTarget(a: CliTarget | undefined, b: CliTarget | undefined): boolean {
  if (!a || !b || a.kind !== b.kind) return false;
  return a.kind === "coder" ? a.runId === b.runId : a.terminalId === b.terminalId;
}

export function isSelected(route: CliRoute, s: OpenSession): boolean {
  return route.mode === "cli" && sameTarget(route.target, targetOf(s));
}

/** What the control says about the route, for the chip and its tooltip. */
export function routeSummary(p: Pick<CliRoutePayload, "route" | "alive" | "approval">): {
  mode: "api" | "cli";
  label: string;
  detail: string;
  tone: "api" | "live" | "warn" | "dead";
} {
  const r = p.route;
  if (r.mode !== "cli" || !r.target) {
    const fb = r.fallback;
    return {
      mode: "api",
      label: "API LLM",
      detail: fb ? `Back on the API LLM: ${fb.reason}` : "Voice → InfiniBot voice agent → LLM",
      tone: fb ? "warn" : "api",
    };
  }
  const who = `${cliName(r.target.cliType)} · ${r.target.label}`;
  if (p.alive === false) return { mode: "cli", label: r.target.label, detail: `${who} is not running — the next turn falls back to the API LLM`, tone: "dead" };
  if (p.approval) return { mode: "cli", label: r.target.label, detail: `Waiting for your yes / no: ${p.approval.question}`, tone: "warn" };
  return {
    mode: "cli",
    label: r.target.label,
    detail: `Voice turns go to ${who}${r.target.cwd ? ` in ${shortCwd(r.target.cwd, 60)}` : ""}`,
    tone: "live",
  };
}

/** Which pane <voice-terminal-stream> follows: the routed session while CLI routing is on. */
export function streamSelectionFor(route: CliRoute): VoiceCliSelection {
  if (route.mode !== "cli" || !route.target) return { isCliMode: false, backend: null, terminalId: null };
  const t = route.target;
  const backend = t.cliType === "claude" ? "claude-code" : (t.cliType ?? null);
  const terminalId = t.terminalId ?? (t.runId ? `spawn-${t.runId}` : null);
  return { isCliMode: true, backend, terminalId };
}

/** Open sessions, routed one first, then running coders, then by recency. */
export function sortOpenSessions(list: OpenSession[], route: CliRoute): OpenSession[] {
  const rank = (s: OpenSession) => (isSelected(route, s) ? 0 : s.kind === "coder" ? 1 : s.status === "live" ? 2 : 3);
  const time = (s: OpenSession) => Date.parse(s.lastActiveAt ?? s.createdAt ?? "") || 0;
  return [...list].sort((a, b) => rank(a) - rank(b) || time(b) - time(a));
}
