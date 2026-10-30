/**
 * Agent resolution, per-backend model mapping and CLI availability for queue
 * phases. Pure helpers + a cached probe; no spawning here.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { QueueCliBackend } from "./types.js";

export const QUEUE_CLI_BACKENDS: readonly QueueCliBackend[] = [
  "claude-code",
  "codex",
  "opencode",
  "gemini",
  "grok",
];

export const DEFAULT_QUEUE_AGENT = "claude-code";

const ALIASES: Record<string, QueueCliBackend> = {
  "claude-code": "claude-code",
  claude: "claude-code",
  claudecode: "claude-code",
  cc: "claude-code",
  codex: "codex",
  "codex-cli": "codex",
  opencode: "opencode",
  "open-code": "opencode",
  gemini: "gemini",
  "gemini-cli": "gemini",
  grok: "grok",
  "grok-cli": "grok",
  "grok-build": "grok",
};

export type ResolvedAgent =
  | { kind: "cli"; backend: QueueCliBackend; label: string }
  | { kind: "agent"; agentId: string; label: string };

/** "claude" / "cc" / "codex" / "gemini-cli" → CLI backend; anything else → gateway agent id. */
export function resolveAgent(raw: string | undefined | null): ResolvedAgent {
  const v = (raw ?? "").trim();
  if (!v) return { kind: "cli", backend: DEFAULT_QUEUE_AGENT, label: DEFAULT_QUEUE_AGENT };
  const cli = ALIASES[v.toLowerCase()];
  if (cli) return { kind: "cli", backend: cli, label: cli };
  const id = v.replace(/^agent:/, "");
  return { kind: "agent", agentId: id, label: `agent:${id}` };
}

type Vendor = "anthropic" | "openai" | "google" | "xai" | null;

function vendorOf(model: string): Vendor {
  const m = model.toLowerCase();
  if (/^(claude|opus|sonnet|haiku)\b/.test(m) || m.includes("claude")) return "anthropic";
  if (/^(gpt|o[1-9]|codex|chatgpt)/.test(m)) return "openai";
  if (/^gemini/.test(m)) return "google";
  if (/^grok/.test(m)) return "xai";
  return null;
}

const BACKEND_VENDOR: Record<QueueCliBackend, Vendor | "any"> = {
  "claude-code": "anthropic",
  codex: "openai",
  gemini: "google",
  opencode: "any",
  grok: "xai",
};

/**
 * Map a phase model to what the backend's CLI accepts.
 *  - "" / "default" → backend default (undefined).
 *  - claude-code / codex / gemini take a bare name: a "provider/" prefix is
 *    stripped; a model from another vendor is dropped (backend default) with a note.
 *  - opencode takes "provider/name": a bare known-vendor name gets the prefix;
 *    the backend's own resolver handles availability fallback.
 */
export function mapModelForBackend(
  backend: QueueCliBackend,
  model: string | undefined | null,
): { model: string | undefined; note?: string } {
  const raw = (model ?? "").trim();
  if (!raw || raw.toLowerCase() === "default") return { model: undefined };
  const slash = raw.indexOf("/");
  const provider = slash > 0 ? raw.slice(0, slash).toLowerCase() : null;
  const name = slash > 0 ? raw.slice(slash + 1) : raw;
  const vendor: Vendor =
    provider === "anthropic"
      ? "anthropic"
      : provider === "openai"
        ? "openai"
        : provider === "google" || provider === "gemini"
          ? "google"
          : provider === "xai" || provider === "grok" || provider === "grok-cli"
            ? "xai"
            : vendorOf(name);
  const want = BACKEND_VENDOR[backend];
  if (want === "any") {
    if (provider) return { model: raw };
    if (vendor) return { model: `${vendor}/${name}` };
    return { model: raw };
  }
  if (
    provider &&
    !["anthropic", "openai", "google", "gemini", "xai", "grok", "grok-cli"].includes(provider)
  ) {
    return {
      model: undefined,
      note: `model "${raw}" is routed through ${provider}; ${backend} can't use it — using the ${backend} default`,
    };
  }
  if (vendor && vendor !== want) {
    return {
      model: undefined,
      note: `model "${raw}" is not a ${want} model; ${backend} runs its default model instead`,
    };
  }
  return { model: name };
}

// ── availability ────────────────────────────────────────────────────────────

export type BackendAuthState = "ok" | "auth-required" | "not-installed" | "unknown";

export interface BackendAvailability {
  id: QueueCliBackend;
  installed: boolean;
  authState: BackendAuthState;
  available: boolean;
  version?: string;
  binPath?: string;
  reason?: string;
  fix?: string;
  checkedAt: number;
}

const INSTALL_FIX: Record<QueueCliBackend, string> = {
  "claude-code":
    "Install Claude Code: npm i -g @anthropic-ai/claude-code (or the native installer), then run `claude` once to log in.",
  codex: "Install Codex CLI: npm i -g @openai/codex, then run `codex login`.",
  opencode:
    "Install OpenCode: curl -fsSL https://opencode.ai/install | bash (or npm i -g opencode-ai), then run `opencode auth login`.",
  gemini:
    "Install Gemini CLI: npm i -g @google/gemini-cli, then run `gemini` once to log in (or set GEMINI_API_KEY).",
  grok: "Install Grok Build from Setup › Coders (or curl -fsSL https://x.ai/cli/install.sh | bash), then run `grok login --device-auth`.",
};

export const LOGIN_FIX: Record<QueueCliBackend, string> = {
  "claude-code":
    "Run `claude` in a terminal on the gateway host and log in (or set ANTHROPIC_API_KEY for the gateway).",
  codex: "Run `codex login` on the gateway host (or set OPENAI_API_KEY for the gateway).",
  opencode: "Run `opencode auth login` on the gateway host.",
  gemini: "Run `gemini` once on the gateway host to log in (or set GEMINI_API_KEY).",
  grok: "Run `grok login --device-auth` on the gateway host (or sign in from Setup › Coders).",
};

export interface AvailabilityProbe {
  (backend: QueueCliBackend): Promise<BackendAvailability>;
}

/** Real probe: `checkInstalled()` of the coder backend + the credential caches. */
export async function probeBackendAvailability(
  backend: QueueCliBackend,
): Promise<BackendAvailability> {
  const checkedAt = Date.now();
  let installed = false;
  let version: string | undefined;
  let binPath: string | undefined;
  try {
    const { createCoderBackend } = await import("../agents/coder-backend/registry.js");
    const st = await createCoderBackend(backend).checkInstalled();
    installed = st.installed;
    version = st.version;
    binPath = st.binPath;
  } catch {
    installed = false;
  }
  if (!installed) {
    return {
      id: backend,
      installed: false,
      authState: "not-installed",
      available: false,
      reason: `${backend} CLI is not installed on the gateway host`,
      fix: INSTALL_FIX[backend],
      checkedAt,
    };
  }
  const authState = authStateFor(backend);
  const available = authState !== "auth-required";
  return {
    id: backend,
    installed: true,
    authState,
    available,
    version,
    binPath,
    ...(available
      ? {}
      : { reason: `${backend} CLI is installed but not logged in`, fix: LOGIN_FIX[backend] }),
    checkedAt,
  };
}

/** Credential-cache auth check (fast, no network, no CLI spawn). */
export function authStateFor(backend: QueueCliBackend, home = homedir()): BackendAuthState {
  const env = process.env;
  const has = (...p: string[]) => existsSync(join(home, ...p));
  switch (backend) {
    case "claude-code":
      if (env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN) return "ok";
      return has(".claude", ".credentials.json") ? "ok" : "auth-required";
    case "codex":
      if (env.OPENAI_API_KEY || env.CODEX_API_KEY) return "ok";
      return has(".codex", "auth.json") ? "ok" : "auth-required";
    case "gemini":
      if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY || env.GOOGLE_GENAI_USE_VERTEXAI) return "ok";
      return has(".gemini", "oauth_creds.json") ? "ok" : "auth-required";
    case "grok": {
      if (env.XAI_API_KEY) return "ok";
      const grokHome = env.GROK_HOME || join(home, ".grok");
      return existsSync(join(grokHome, "auth.json")) ? "ok" : "auth-required";
    }
    case "opencode": {
      const xdg = env.XDG_DATA_HOME || join(home, ".local", "share");
      if (existsSync(join(xdg, "opencode", "auth.json"))) return "ok";
      // OpenCode can also run on provider env keys / local models — can't tell.
      return "unknown";
    }
  }
}

/** Cached availability (TTL) so the dispatcher doesn't probe every tick. */
export function createAvailabilityCache(
  probe: AvailabilityProbe = probeBackendAvailability,
  ttlMs = 5 * 60_000,
): {
  get: (backend: QueueCliBackend, refresh?: boolean) => Promise<BackendAvailability>;
  all: (refresh?: boolean) => Promise<BackendAvailability[]>;
  invalidate: () => void;
} {
  const cache = new Map<QueueCliBackend, BackendAvailability>();
  const get = async (backend: QueueCliBackend, refresh = false) => {
    const hit = cache.get(backend);
    // Unavailable results expire faster so a fresh login is picked up quickly.
    const ttl = hit?.available ? ttlMs : Math.min(ttlMs, 30_000);
    if (!refresh && hit && Date.now() - hit.checkedAt < ttl) return hit;
    const res = await probe(backend);
    cache.set(backend, res);
    return res;
  };
  return {
    get,
    all: async (refresh = false) => Promise.all(QUEUE_CLI_BACKENDS.map((b) => get(b, refresh))),
    invalidate: () => cache.clear(),
  };
}
