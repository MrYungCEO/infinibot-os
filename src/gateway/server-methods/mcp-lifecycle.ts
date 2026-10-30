import { redactMcpEntry } from "../../mcp/client-setup.js";
import { getMcpServerHandle, getLastMcpOptions, runMcpServer } from "../../mcp/server.js";
import {
  registerInfinibotInClaudeCode,
  unregisterInfinibotFromClaudeCode,
  buildInfinibotEntry,
} from "../../mcp/claude-code-register.js";
import {
  detectLanAddress,
  detectTailscaleAddress,
  detectTailscaleHost,
} from "../../mobile/expo-runner.js";
import { findTailscaleBinary } from "../../infra/tailscale.js";
import { loadConfig } from "../../config/config.js";
import type { GatewayRequestHandlers } from "./types.js";

/** Reachability classification surfaced as the coloured status dots in the UI. */
type Reach = "ok" | "warn" | "down";

/** Parse the WS gateway port out of a `ws://host:port` URL, defaulting sanely. */
function parseGatewayPort(url: string | undefined, fallback: number): number {
  if (url) {
    try {
      const parsed = new URL(url);
      if (parsed.port) return Number(parsed.port);
    } catch {
      /* malformed — fall through to the fallback */
    }
  }
  return fallback;
}

export const mcpLifecycleHandlers: GatewayRequestHandlers = {
  "mcp.status": async ({ respond }) => {
    try {
      const handle = getMcpServerHandle();
      respond(true, {
        running: handle?.running ?? false,
        port: handle?.port ?? 0,
        uptime: handle?.running ? Date.now() - handle.startedAt : 0,
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "mcp.start": async ({ respond }) => {
    try {
      const existing = getMcpServerHandle();
      if (existing?.running) {
        respond(true, { already: true, running: true, port: existing.port });
        return;
      }

      const opts = getLastMcpOptions();
      if (!opts) {
        respond(false, undefined, {
          code: "INTERNAL_ERROR",
          message: "No MCP options available — server was never started",
        });
        return;
      }

      const handle = await runMcpServer(opts);
      respond(true, { running: handle.running, port: handle.port });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "mcp.stop": async ({ respond }) => {
    try {
      const handle = getMcpServerHandle();
      if (!handle?.running) {
        respond(true, { already: true, running: false });
        return;
      }
      await handle.stop();
      respond(true, { running: false });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "mcp.restart": async ({ respond }) => {
    try {
      const handle = getMcpServerHandle();
      if (handle?.running) {
        await handle.stop();
      }

      const opts = getLastMcpOptions();
      if (!opts) {
        respond(false, undefined, {
          code: "INTERNAL_ERROR",
          message: "No MCP options available — server was never started",
        });
        return;
      }

      const newHandle = await runMcpServer(opts);
      respond(true, { running: newHandle.running, port: newHandle.port });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Connection info for the Quick Install panel: the gateway port, the host
   * candidates for each scope (Local / LAN / Tailscale), the exact stdio
   * bridge command external clients should spawn, and the auth posture.
   *
   * This is the single canonical info source — it reuses the same helpers the
   * gateway and mobile flows already use (`buildInfinibotEntry`,
   * `detect*Address`, config). The UI must NOT re-derive any of this.
   */
  "mcp.connectInfo": async ({ respond }) => {
    try {
      const cfg = loadConfig();
      const opts = getLastMcpOptions();
      const gatewayPort = parseGatewayPort(
        opts?.gatewayUrl,
        cfg.gateway?.port ?? (Number(process.env.INFINIBOT_GATEWAY_PORT) || 18789),
      );

      const lan = detectLanAddress();
      const tsHost = await detectTailscaleHost();
      const tsIp = detectTailscaleAddress();
      const tsBinary = await findTailscaleBinary();
      const tailscaleHost = tsHost ?? tsIp;

      // The exact stdio entry external clients should spawn — built the
      // same way `mcp.claudeCode.register` writes it, so snippets match.
      const localUrl = `ws://127.0.0.1:${gatewayPort}`;
      const entry = buildInfinibotEntry({
        gatewayUrl: opts?.gatewayUrl ?? localUrl,
        gatewayToken: opts?.gatewayToken,
        gatewayPassword: opts?.gatewayPassword,
        defaultSessionKey: opts?.defaultSessionKey,
      });
      const args = Array.isArray(entry.args) ? (entry.args as string[]) : [];

      // Auth posture. Token mode is preferred; password mode is legacy.
      const auth = cfg.gateway?.auth;
      const token = auth?.token?.trim() || opts?.gatewayToken?.trim() || "";
      const password = auth?.password?.trim() || opts?.gatewayPassword?.trim() || "";
      const mode: "token" | "password" | "none" = token ? "token" : password ? "password" : "none";
      const hasSecret = Boolean(token || password);

      // Bind posture decides whether the LAN scope is actually reachable.
      const bind = cfg.gateway?.bind ?? "auto";
      const lanExposed = bind !== "loopback";

      const reach: { local: Reach; lan: Reach; tailscale: Reach } = {
        // We're answering this very call over the gateway, so local is up.
        local: "ok",
        lan: lan ? (lanExposed ? "ok" : "warn") : "down",
        tailscale: tailscaleHost ? (tsBinary ? "ok" : "warn") : "down",
      };

      respond(true, {
        gatewayPort,
        bind,
        httpBridgePort: getMcpServerHandle()?.port ?? 0,
        stdio: {
          command: String(entry.command ?? process.execPath),
          entry: args[0] ?? "",
          urlEnv: "MOLTBOT_GATEWAY_URL",
          tokenEnv: "MOLTBOT_GATEWAY_TOKEN",
          passwordEnv: "MOLTBOT_GATEWAY_PASSWORD",
        },
        hosts: {
          local: "127.0.0.1",
          lan,
          tailscale: tailscaleHost,
        },
        tailscale: {
          cliPresent: Boolean(tsBinary),
          hostname: tsHost,
          ip: tsIp,
        },
        auth: { mode, required: hasSecret, hasSecret },
        reach,
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "mcp.claudeCode.register": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const opts = getLastMcpOptions();
      const gatewayUrl =
        (typeof p.gatewayUrl === "string" && p.gatewayUrl) ||
        opts?.gatewayUrl ||
        "ws://127.0.0.1:18789";
      const gatewayToken =
        (typeof p.gatewayToken === "string" && p.gatewayToken) || opts?.gatewayToken || undefined;
      const gatewayPassword =
        (typeof p.gatewayPassword === "string" && p.gatewayPassword) ||
        opts?.gatewayPassword ||
        undefined;
      const defaultSessionKey =
        (typeof p.defaultSessionKey === "string" && p.defaultSessionKey) ||
        opts?.defaultSessionKey ||
        undefined;
      const force = p.force === true;
      const configPath =
        typeof p.configPath === "string" && p.configPath ? p.configPath : undefined;
      const result = registerInfinibotInClaudeCode({
        gatewayUrl,
        gatewayToken,
        gatewayPassword,
        defaultSessionKey,
        force,
        configPath,
      });
      // Never echo the gateway credential back over RPC.
      respond(true, { ...result, entry: redactMcpEntry(result.entry) });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "mcp.claudeCode.unregister": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const configPath =
        typeof p.configPath === "string" && p.configPath ? p.configPath : undefined;
      respond(true, unregisterInfinibotFromClaudeCode({ configPath }));
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
};
