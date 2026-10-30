/**
 * Voice routing switch — which brain answers the owner's voice calls.
 *
 *   mode "api"  (default) voice → InfiniBot voice agent → LLM, as before.
 *   mode "cli"  voice turns are typed into ONE selected CLI session (an open
 *               terminal or a running coder run) and its output is spoken
 *               back (voice-cli-turn.ts).
 *
 * The switch is decided GATEWAY-SIDE (runVoiceLlmTurn), so every voice
 * provider that calls the gateway's voice-LLM seam — Robovoice included —
 * follows it without any change on the provider side. Only calls whose caller
 * the provider authenticated as the owner are ever routed to a CLI session:
 * a public caller must never type into the owner's terminals.
 *
 * Persisted per user in `<stateDir>/voice/cli-route.json` (the per-profile
 * state dir; the UI mirrors it for instant paint).
 */

import fs from "node:fs";
import path from "node:path";

import { resolveStateDir } from "../../config/paths.js";

export type VoiceCliTargetKind = "terminal" | "coder";

export type VoiceCliTarget = {
  kind: VoiceCliTargetKind;
  /** Terminal id (terminal) — also set for a coder run that has a pane. */
  terminalId?: string;
  /** Sub-agent run id (coder). */
  runId?: string;
  /** "claude" | "codex" | "opencode" | "gemini" | "grok" | "aider" | "shell" … */
  cliType?: string;
  label: string;
  cwd?: string;
};

export type VoiceCliRoute = {
  mode: "api" | "cli";
  target?: VoiceCliTarget;
  updatedAt: string;
  /** Set when a dead session made the gateway fall back to the API LLM. */
  fallback?: { at: string; reason: string; target?: VoiceCliTarget };
  /**
   * The voice brain for "api" mode: a `provider/model` ref (API provider,
   * local model or subscription CLI provider such as `claude-cli/sonnet`).
   * Unset = the agent's own model. Kept across mode switches.
   */
  model?: string;
};

/** `provider/model` refs the voice brain accepts (model ids may contain "/" and ":"). */
const MODEL_REF = /^[a-z0-9][\w.-]*\/[\w.:@/+-]{1,180}$/i;

export function sanitizeVoiceModelRef(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim();
  return MODEL_REF.test(v) ? v : undefined;
}

const DEFAULT_ROUTE: VoiceCliRoute = { mode: "api", updatedAt: new Date(0).toISOString() };

let override: string | null = null;
let cache: { file: string; mtimeMs: number; route: VoiceCliRoute } | null = null;
const listeners = new Set<(r: VoiceCliRoute) => void>();

/** Tests / side gateways: put the file somewhere else. */
export function setVoiceCliRouteFileForTests(file: string | null): void {
  override = file;
  cache = null;
}

function routeFile(): string {
  if (override) return override;
  // Per-user state dir: each InfiniBot profile has its own routing choice.
  return path.join(resolveStateDir(), "voice", "cli-route.json");
}

function sanitizeTarget(raw: unknown): VoiceCliTarget | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const t = raw as Record<string, unknown>;
  const kind = t.kind === "coder" ? "coder" : t.kind === "terminal" ? "terminal" : null;
  if (!kind) return undefined;
  const str = (v: unknown, max = 300) =>
    typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;
  const terminalId = str(t.terminalId, 200);
  const runId = str(t.runId, 200);
  if (kind === "terminal" && !terminalId) return undefined;
  if (kind === "coder" && !runId) return undefined;
  return {
    kind,
    ...(terminalId ? { terminalId } : {}),
    ...(runId ? { runId } : {}),
    ...(str(t.cliType, 40) ? { cliType: str(t.cliType, 40) } : {}),
    label: str(t.label, 120) ?? terminalId ?? runId ?? "CLI session",
    ...(str(t.cwd, 500) ? { cwd: str(t.cwd, 500) } : {}),
  };
}

export function sanitizeVoiceCliRoute(raw: unknown): VoiceCliRoute {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_ROUTE };
  const r = raw as Record<string, unknown>;
  const target = sanitizeTarget(r.target);
  const mode = r.mode === "cli" && target ? "cli" : "api";
  const fb =
    r.fallback && typeof r.fallback === "object" ? (r.fallback as Record<string, unknown>) : null;
  const model = sanitizeVoiceModelRef(r.model);
  return {
    mode,
    ...(target ? { target } : {}),
    ...(model ? { model } : {}),
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : new Date().toISOString(),
    ...(fb && typeof fb.reason === "string"
      ? {
          fallback: {
            at: typeof fb.at === "string" ? fb.at : new Date().toISOString(),
            reason: fb.reason.slice(0, 300),
            ...(sanitizeTarget(fb.target) ? { target: sanitizeTarget(fb.target) } : {}),
          },
        }
      : {}),
  };
}

export function readVoiceCliRoute(): VoiceCliRoute {
  const file = routeFile();
  try {
    const st = fs.statSync(file);
    if (cache && cache.file === file && cache.mtimeMs === st.mtimeMs) return cache.route;
    const route = sanitizeVoiceCliRoute(JSON.parse(fs.readFileSync(file, "utf8")));
    cache = { file, mtimeMs: st.mtimeMs, route };
    return route;
  } catch {
    return { ...DEFAULT_ROUTE };
  }
}

export function writeVoiceCliRoute(
  next: Omit<VoiceCliRoute, "updatedAt" | "model"> & { updatedAt?: string; model?: string | null },
): VoiceCliRoute {
  // The voice brain model survives mode switches and fallbacks; null clears it.
  const model = next.model === undefined ? readVoiceCliRoute().model : (next.model ?? undefined);
  const route = sanitizeVoiceCliRoute({ ...next, model, updatedAt: new Date().toISOString() });
  const file = routeFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(route, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  cache = null;
  for (const cb of listeners) {
    try {
      cb(route);
    } catch {
      /* a listener's failure never blocks the switch */
    }
  }
  return route;
}

/** The session died / vanished: switch back to the API LLM and remember why. */
export function fallBackToApi(reason: string): VoiceCliRoute {
  const cur = readVoiceCliRoute();
  return writeVoiceCliRoute({
    mode: "api",
    target: cur.target,
    fallback: { at: new Date().toISOString(), reason, target: cur.target },
  });
}

export function onVoiceCliRouteChange(cb: (r: VoiceCliRoute) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** The routed target for THIS turn, or null (API LLM). Guests never route to a CLI. */
export function activeCliTarget(
  opts: { callerIsOwner: boolean },
  route = readVoiceCliRoute(),
): VoiceCliTarget | null {
  if (!opts.callerIsOwner) return null;
  if (route.mode !== "cli" || !route.target) return null;
  return route.target;
}

/** The owner's chosen voice brain model for API turns, or undefined (agent's model). */
export function activeVoiceModel(
  opts: { callerIsOwner: boolean },
  route = readVoiceCliRoute(),
): string | undefined {
  if (!opts.callerIsOwner) return undefined;
  return route.model;
}
