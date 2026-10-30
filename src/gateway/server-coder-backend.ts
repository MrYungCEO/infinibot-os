/**
 * HTTP handlers for the coder backend selection API.
 *
 * GET  /api/coder/backend           → { backend, capabilities, installed }
 * POST /api/coder/backend           → { backend } (body) → persists to config
 * GET  /api/coder/backends          → list all available backends with caps + install status
 * GET  /api/coder/mcp-status        → { entries: [{ backend, registered, path }] }
 * POST /api/coder/mcp-install       → { backend } → registers InfiniBot MCP in that CLI's config
 *
 * COORDINATION: opencode-swap — new file.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { loadConfig, writeConfigFile } from "../config/config.js";
import {
  getCoderBackend,
  createCoderBackend,
  getCoderBackendId,
} from "../agents/coder-backend/registry.js";
import {
  CODER_BACKEND_IDS,
  isCoderBackendId,
  type CoderBackendId,
} from "../agents/coder-backend/types.js";
import {
  registerInfinibotInClaudeCode,
  isInfinibotRegisteredInClaudeCode,
} from "../mcp/claude-code-register.js";
import {
  registerInfinibotInOpenCode,
  isInfinibotRegisteredInOpenCode,
} from "../agents/coder-backend/opencode.js";
import {
  registerInfinibotInCodex,
  isInfinibotRegisteredInCodex,
} from "../agents/coder-backend/codex.js";
import {
  registerInfinibotInGemini,
  isInfinibotRegisteredInGemini,
} from "../agents/coder-backend/gemini.js";
import {
  registerInfinibotInGrok,
  isInfinibotRegisteredInGrok,
} from "../agents/coder-backend/grok.js";
import { resolveGatewayAuth } from "./auth.js";

type GatewayAuthOpts = {
  gatewayUrl: string;
  gatewayToken?: string;
  gatewayPassword?: string;
};

function resolveGatewayAuthForRegister(): GatewayAuthOpts {
  const cfg = loadConfig() as {
    gateway?: {
      tls?: { enabled?: boolean };
      auth?: Parameters<typeof resolveGatewayAuth>[0]["authConfig"];
      tailscale?: { mode?: Parameters<typeof resolveGatewayAuth>[0]["tailscaleMode"] };
    };
  };
  const port = Number(process.env.INFINIBOT_GATEWAY_PORT) || 18789;
  const protocol = cfg.gateway?.tls?.enabled === true ? "wss" : "ws";
  const auth = resolveGatewayAuth({
    authConfig: cfg.gateway?.auth,
    env: process.env,
    tailscaleMode: cfg.gateway?.tailscale?.mode,
  });
  return {
    gatewayUrl: `${protocol}://127.0.0.1:${port}`,
    gatewayToken: auth.mode === "token" ? auth.token : undefined,
    gatewayPassword: auth.mode === "password" ? auth.password : undefined,
  };
}

function mcpStatusForBackend(id: CoderBackendId): { registered: boolean; path: string } {
  switch (id) {
    case "claude-code":
      return isInfinibotRegisteredInClaudeCode();
    case "opencode":
      return isInfinibotRegisteredInOpenCode();
    case "codex":
      return isInfinibotRegisteredInCodex();
    case "gemini":
      return isInfinibotRegisteredInGemini();
    case "grok":
      return isInfinibotRegisteredInGrok();
    default:
      return { registered: false, path: "" };
  }
}

function installMcpForBackend(
  id: CoderBackendId,
  opts: GatewayAuthOpts & { force?: boolean },
): { path: string; changed: boolean } {
  switch (id) {
    case "claude-code":
      return registerInfinibotInClaudeCode({ ...opts, force: opts.force });
    case "opencode":
      return registerInfinibotInOpenCode({ ...opts, force: opts.force });
    case "codex":
      return registerInfinibotInCodex({ ...opts, force: opts.force });
    case "gemini":
      return registerInfinibotInGemini({ ...opts, force: opts.force });
    case "grok":
      return registerInfinibotInGrok({ ...opts, force: opts.force });
    default:
      return { path: "", changed: false };
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk.toString();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

/**
 * Single source of truth for the backend list — used by both the HTTP route
 * and the `coder.backends.list` RPC. Adding a new backend means adding it
 * to the `entries` array here and to the registry factory.
 */
export async function listAllBackends(): Promise<
  Array<{
    id: CoderBackendId;
    displayName: string;
    description: string;
    /**
     * Shell command the user runs to authenticate this CLI agent in their own
     * terminal. InfiniBot never stores credentials for CLI backends — each one
     * owns its own auth — so the desktop wizard surfaces this verbatim instead
     * of a key field. Single source of truth for that login hint.
     */
    loginCommand: string;
    capabilities: ReturnType<ReturnType<typeof createCoderBackend>["getCapabilities"]>;
    install: Awaited<ReturnType<ReturnType<typeof createCoderBackend>["checkInstalled"]>>;
    mcp: { registered: boolean; path: string };
  }>
> {
  const entries: Array<{ id: CoderBackendId; description: string; loginCommand: string }> = [
    {
      id: "claude-code",
      description:
        "Anthropic's official coding agent. Authenticate with a Claude/Anthropic account.",
      loginCommand: "claude login",
    },
    {
      id: "opencode",
      description:
        "Open-source coding agent supporting 75+ providers — Anthropic, OpenAI, Google, local models, and more.",
      loginCommand: "opencode auth login",
    },
    {
      id: "codex",
      description: "OpenAI's Codex CLI. Runs against gpt-* models via your OpenAI account.",
      loginCommand: "codex login",
    },
    {
      id: "gemini",
      description:
        "Google's official Gemini CLI. Needs a Gemini API key or a paid Google plan (free Google accounts are rejected).",
      loginCommand: "gemini auth login",
    },
    {
      id: "grok",
      description:
        "xAI's Grok Build CLI. Runs grok-* models on your SuperGrok / X Premium+ sign-in or an xAI API key.",
      loginCommand: "grok login --device-auth",
    },
  ];

  const statuses = await Promise.all(entries.map((e) => createCoderBackend(e.id).checkInstalled()));

  return entries.map((entry, i) => {
    const backend = createCoderBackend(entry.id);
    const caps = backend.getCapabilities();
    const mcp = mcpStatusForBackend(entry.id);
    return {
      id: entry.id,
      displayName: caps.displayName,
      description: entry.description,
      loginCommand: entry.loginCommand,
      capabilities: caps,
      install: statuses[i],
      mcp: { registered: mcp.registered, path: mcp.path },
    };
  });
}

export async function handleCoderBackendRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = req.url?.split("?")[0] ?? "";

  // GET /api/coder/backends — list all available backends
  if (req.method === "GET" && url === "/api/coder/backends") {
    sendJson(res, 200, { backends: await listAllBackends() });
    return true;
  }

  // GET /api/coder/backend — current backend + capabilities
  if (req.method === "GET" && url === "/api/coder/backend") {
    const activeId = getCoderBackendId();
    const backend = getCoderBackend();
    const [caps, installStatus] = await Promise.all([
      Promise.resolve(backend.getCapabilities()),
      backend.checkInstalled(),
    ]);
    sendJson(res, 200, {
      backend: activeId,
      capabilities: caps,
      installed: installStatus.installed,
      version: installStatus.version,
      installHint: installStatus.installHint,
    });
    return true;
  }

  // GET /api/coder/mcp-status — per-backend InfiniBot MCP registration state
  if (req.method === "GET" && url === "/api/coder/mcp-status") {
    const ids: readonly CoderBackendId[] = CODER_BACKEND_IDS;
    sendJson(res, 200, {
      entries: ids.map((id) => {
        const s = mcpStatusForBackend(id);
        return { backend: id, registered: s.registered, path: s.path };
      }),
    });
    return true;
  }

  // POST /api/coder/mcp-install — write the InfiniBot MCP entry to the named
  // backend's global config. Body: { backend, force? }. Idempotent: re-running
  // is safe and returns changed=false when the entry already matches.
  if (req.method === "POST" && url === "/api/coder/mcp-install") {
    const body = (await readJsonBody(req)) as Record<string, unknown>;
    const requested = body.backend as string | undefined;
    const force = body.force === true;
    if (!isCoderBackendId(requested)) {
      sendJson(res, 400, {
        error: `Invalid backend "${requested}". Must be one of: ${CODER_BACKEND_IDS.join(", ")}.`,
      });
      return true;
    }
    try {
      const opts = resolveGatewayAuthForRegister();
      const result = installMcpForBackend(requested as CoderBackendId, { ...opts, force });
      sendJson(res, 200, {
        backend: requested,
        path: result.path,
        changed: result.changed,
        registered: true,
      });
    } catch (err) {
      sendJson(res, 500, {
        error: `Failed to install InfiniBot MCP for ${requested}: ${(err as Error).message}`,
      });
    }
    return true;
  }

  // POST /api/coder/test-spawn — verify the active backend binary is callable
  if (req.method === "POST" && url === "/api/coder/test-spawn") {
    const backend = getCoderBackend();
    const activeId = getCoderBackendId();
    try {
      const status = await backend.checkInstalled();
      if (!status.installed) {
        sendJson(res, 200, {
          ok: false,
          message: `${activeId} is not installed.`,
          error: `Not installed. ${status.installHint ?? ""}`.trim(),
        });
        return true;
      }
      sendJson(res, 200, {
        ok: true,
        message: `${backend.getCapabilities().displayName} ${status.version ? `v${status.version}` : "binary"} is installed and ready.`,
      });
    } catch (err) {
      sendJson(res, 200, {
        ok: false,
        error: (err as Error).message,
      });
    }
    return true;
  }

  // POST /api/coder/backend — switch active backend
  if (req.method === "POST" && url === "/api/coder/backend") {
    const body = (await readJsonBody(req)) as Record<string, unknown>;
    const requested = body.backend as string | undefined;

    if (!isCoderBackendId(requested)) {
      sendJson(res, 400, {
        error: `Invalid backend "${requested}". Must be one of: ${CODER_BACKEND_IDS.join(", ")}.`,
      });
      return true;
    }

    const backendId = requested as CoderBackendId;

    // If switching to a non-default backend, check it's installed first.
    if (backendId !== "claude-code") {
      const status = await createCoderBackend(backendId).checkInstalled();
      if (!status.installed) {
        sendJson(res, 422, {
          error: `${backendId} is not installed.`,
          installHint: status.installHint,
        });
        return true;
      }
    }

    // Persist to config.
    const current = loadConfig() as Record<string, unknown>;
    const coder = (
      typeof current.coder === "object" && current.coder !== null ? current.coder : {}
    ) as Record<string, unknown>;
    const next = { ...current, coder: { ...coder, backend: backendId } };

    try {
      await writeConfigFile(next as Parameters<typeof writeConfigFile>[0]);
    } catch (err) {
      sendJson(res, 500, { error: `Failed to save config: ${(err as Error).message}` });
      return true;
    }

    sendJson(res, 200, { backend: backendId });
    return true;
  }

  return false;
}
