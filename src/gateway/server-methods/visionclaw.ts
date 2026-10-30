/**
 * VisionClaw integration — surfaces config + status for the web UI's
 * "Glasses" panel. The actual chat-completions endpoint already lives in
 * `openai-http.ts`; these RPCs just toggle it, manage the bearer token,
 * and provide a turnkey setup blob (LAN host, port, sample Secrets snippet)
 * the UI can render as a QR code or copy-paste.
 */

import { networkInterfaces, hostname } from "node:os";
import { randomBytes } from "node:crypto";

import type { GatewayRequestHandlers } from "./types.js";
import { loadConfig, writeConfigFile } from "../../config/config.js";
import type { InfinibotConfig } from "../../config/types.js";
import { listActivity, clearActivity } from "../visionclaw-activity.js";

interface VisionClawStatus {
  enabled: boolean;
  /** LAN-reachable host (e.g. `mac-mini.local` or `192.168.1.142`). */
  host: string;
  port: number;
  /** Bind mode currently in effect — "loopback" means the phone can't reach it. */
  bindMode: string;
  /** True when bind allows the phone to connect (anything but loopback). */
  reachableFromPhone: boolean;
  /** Token shown in masked form so we don't leak it from a remote viewer. */
  tokenMasked: string;
  /** Token length so the UI can show a "rotate" hint when missing. */
  tokenSet: boolean;
  /** True when GEMINI_API_KEY is set in env config (required by VisionClaw). */
  geminiKeySet: boolean;
  /** Masked Gemini key for quick visual confirmation. */
  geminiKeyMasked: string;
  /**
   * Default agent that answers `execute(task)`. VisionClaw can override
   * via the `model` field or `X-Infinibot-Agent` header.
   */
  defaultAgent: string;
  /**
   * Wizard step the UI should highlight next. Computed from the other
   * flags so the frontend doesn't have to repeat the logic.
   *   "enable"  → endpoint not on
   *   "gemini"  → no Gemini key set
   *   "pair"    → ready, needs phone
   *   "done"    → at least one successful chat-completions request seen
   */
  nextStep: "enable" | "gemini" | "pair" | "done";
  /** UNIX ms timestamp of the last successful chat-completions hit, or null. */
  lastSuccessAt: number | null;
}

function maskToken(token: string | undefined): string {
  if (!token || token.length < 8) return "—";
  return token.slice(0, 4) + "•".repeat(Math.max(4, token.length - 8)) + token.slice(-4);
}

function pickLanHost(): string {
  const ifaces = networkInterfaces();
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const iface of list) {
      if (iface.family !== "IPv4" || iface.internal) continue;
      // Prefer 192.168.* / 10.* / 172.16-31.*
      if (
        iface.address.startsWith("192.168.") ||
        iface.address.startsWith("10.") ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(iface.address)
      ) {
        return iface.address;
      }
    }
  }
  // Fall back to the Bonjour-style hostname.
  const h = hostname();
  return h.endsWith(".local") ? h : `${h}.local`;
}

function buildStatus(): VisionClawStatus {
  const cfg = loadConfig() as InfinibotConfig;
  const enabled = cfg.gateway?.http?.endpoints?.chatCompletions?.enabled === true;
  const bindMode = (cfg.gateway?.bind ?? "loopback") as string;
  const port = cfg.gateway?.port ?? 18789;
  const auth = cfg.gateway?.auth as
    | { mode?: string; token?: string; password?: string }
    | undefined;
  const token = auth?.token ?? auth?.password ?? "";
  const envVars = (cfg.env as { vars?: Record<string, string> } | undefined)?.vars ?? {};
  const geminiKey = envVars.GEMINI_API_KEY ?? "";
  const lastSuccess = listActivity().find((a) => a.ok);
  const lastSuccessAt = lastSuccess ? lastSuccess.ts : null;
  let nextStep: VisionClawStatus["nextStep"];
  if (!enabled) nextStep = "enable";
  else if (!geminiKey) nextStep = "gemini";
  else if (lastSuccessAt) nextStep = "done";
  else nextStep = "pair";
  return {
    enabled,
    host: pickLanHost(),
    port,
    bindMode,
    reachableFromPhone: bindMode !== "loopback",
    tokenMasked: maskToken(token),
    tokenSet: token.length > 0,
    geminiKeySet: geminiKey.length > 0,
    geminiKeyMasked: maskToken(geminiKey),
    defaultAgent: "visionclaw",
    nextStep,
    lastSuccessAt,
  };
}

function generateToken(): string {
  return "vc-" + randomBytes(24).toString("hex");
}

async function patchConfig(patch: (cfg: Record<string, unknown>) => void): Promise<void> {
  const cfg = loadConfig() as Record<string, unknown>;
  patch(cfg);
  await writeConfigFile(cfg as InfinibotConfig);
}

function ensurePath<T extends Record<string, unknown>>(
  obj: T,
  ...keys: string[]
): Record<string, unknown> {
  let cur: Record<string, unknown> = obj;
  for (const k of keys) {
    if (typeof cur[k] !== "object" || cur[k] === null) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  return cur;
}

export const visionClawHandlers: GatewayRequestHandlers = {
  /** Read current state — used by the UI to render the Glasses panel. */
  "visionclaw.status": async ({ respond }) => {
    try {
      respond(true, buildStatus());
    } catch (err) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },

  /**
   * Turn on the chat-completions endpoint, flip bind to "lan" if it's
   * currently loopback (so the phone can reach it), and mint a bearer
   * token if one isn't already set. One-click pairing.
   */
  "visionclaw.enable": async ({ respond }) => {
    try {
      let mintedToken: string | null = null;
      await patchConfig((cfg) => {
        const gateway = ensurePath(cfg, "gateway");
        const http = ensurePath(gateway, "http");
        const endpoints = ensurePath(http, "endpoints");
        const cc = ensurePath(endpoints, "chatCompletions");
        cc.enabled = true;
        // Flip to LAN if currently loopback — the phone can't reach 127.0.0.1.
        if (!gateway.bind || gateway.bind === "loopback") gateway.bind = "lan";
        const auth = ensurePath(gateway, "auth");
        if (typeof auth.token !== "string" || (auth.token as string).length === 0) {
          mintedToken = generateToken();
          auth.token = mintedToken;
          if (typeof auth.mode !== "string") auth.mode = "token";
        }
      });
      respond(true, {
        ...buildStatus(),
        mintedToken, // surfaced once when freshly generated; null otherwise
        requiresRestart: true,
      });
    } catch (err) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },

  /** Disable the endpoint without touching auth/bind. */
  "visionclaw.disable": async ({ respond }) => {
    try {
      await patchConfig((cfg) => {
        const gateway = ensurePath(cfg, "gateway");
        const http = ensurePath(gateway, "http");
        const endpoints = ensurePath(http, "endpoints");
        const cc = ensurePath(endpoints, "chatCompletions");
        cc.enabled = false;
      });
      respond(true, { ...buildStatus(), requiresRestart: true });
    } catch (err) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },

  /** Mint a fresh token; previous token immediately invalid on next restart. */
  "visionclaw.rotateToken": async ({ respond }) => {
    try {
      const token = generateToken();
      await patchConfig((cfg) => {
        const gateway = ensurePath(cfg, "gateway");
        const auth = ensurePath(gateway, "auth");
        auth.token = token;
        if (typeof auth.mode !== "string") auth.mode = "token";
      });
      respond(true, {
        ...buildStatus(),
        mintedToken: token,
        requiresRestart: true,
      });
    } catch (err) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },

  /**
   * Save (or clear) the Gemini API key in the config's env vars block.
   * Required for VisionClaw — the iOS/Android app uses this key to
   * authenticate with Gemini Live before routing tool calls to us.
   * Pass an empty string to clear.
   */
  "visionclaw.setGeminiKey": async ({ params, respond }) => {
    try {
      const key = typeof params?.key === "string" ? params.key.trim() : "";
      await patchConfig((cfg) => {
        const env = ensurePath(cfg, "env");
        const vars = ensurePath(env, "vars");
        if (key) vars.GEMINI_API_KEY = key;
        else delete vars.GEMINI_API_KEY;
      });
      respond(true, buildStatus());
    } catch (err) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },

  /** Recent /v1/chat/completions hits — drives the live activity feed. */
  "visionclaw.activity": async ({ respond }) => {
    try {
      respond(true, { entries: listActivity() });
    } catch (err) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },

  /** Wipe the activity ring buffer (for the "clear log" button). */
  "visionclaw.clearActivity": async ({ respond }) => {
    try {
      clearActivity();
      respond(true, { cleared: true });
    } catch (err) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },

  /**
   * Live smoke test against the local /v1/chat/completions endpoint with
   * the configured token. Verifies the wire is up before flashing the
   * phone with a real Secrets blob.
   */
  "visionclaw.test": async ({ respond }) => {
    try {
      const cfg = loadConfig() as InfinibotConfig;
      const port = cfg.gateway?.port ?? 18789;
      const auth = cfg.gateway?.auth as { token?: string; password?: string } | undefined;
      const token = auth?.token ?? auth?.password ?? "";
      if (!token) {
        respond(false, undefined, {
          code: "BAD_REQUEST",
          message: "No auth token or password configured",
        });
        return;
      }
      // Always hit loopback for the self-test — the LAN bind must include 127.0.0.1.
      const url = `http://127.0.0.1:${port}/v1/chat/completions`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          model: "visionclaw",
          messages: [{ role: "user", content: "Self-test from gateway. Reply OK." }],
        }),
      });
      const body = await res.text();
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        /* keep raw */
      }
      respond(true, {
        status: res.status,
        ok: res.ok,
        body: parsed ?? body.slice(0, 800),
      });
    } catch (err) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },
};
