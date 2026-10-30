/**
 * RPCs behind the setup steps "Connect your browser" and "Connect AI apps
 * (MCP)" (onboarding, Setup › Quick Start, /quickstart).
 *
 *   browser.connect.status  live pairing state for the "Connected ✓" badge
 *   browser.extension.test  open example.com in the paired Chrome, read the title
 *   mcp.clients.detect      which AI apps are installed / already have InfiniBot
 *   mcp.clients.add         one-click: back up + merge the infinibot server in
 *   mcp.clients.test        spawn the exact entry the apps use and call tools
 *
 * Nothing here returns or logs the gateway credential: client entries are
 * secret-free (mcp-stdio reads the credential from the InfiniBot config).
 */
import { spawn } from "node:child_process";

import { loadConfig } from "../../config/config.js";
import {
  isBrowserExtensionPaired,
  probeRelay,
  relayBaseUrl,
  waitForRelayConnection,
  withTimeout,
} from "../../browser/extension-connection.js";
import { getBrowserExtensionGovernance } from "../../browser/extension-governance.js";
import { chromeWebStoreUrl } from "../../browser/extension-assets.js";
import {
  addInfinibotToClient,
  buildMcpClientEntry,
  MCP_CLIENT_IDS,
  type McpClientId,
  type McpEntry,
  mcpClientDefs,
  mcpClientSnippet,
  mcpClientStatus,
} from "../../mcp/client-setup.js";
import { isSaasMode } from "../../saas/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

const log = createSubsystemLogger("setup").child("connect");

function gatewayWsUrl(): string {
  const cfg = loadConfig();
  const port = cfg.gateway?.port ?? (Number(process.env.INFINIBOT_GATEWAY_PORT) || 18789);
  const proto = cfg.gateway?.tls?.enabled === true ? "wss" : "ws";
  return `${proto}://127.0.0.1:${port}`;
}

function clientEntry(): McpEntry {
  return buildMcpClientEntry({ gatewayUrl: gatewayWsUrl() });
}

function isClientId(v: unknown): v is McpClientId {
  return typeof v === "string" && (MCP_CLIENT_IDS as readonly string[]).includes(v);
}

// ── browser ─────────────────────────────────────────────────────────────────

export async function browserConnectStatus(opts?: { waitMs?: number }) {
  const cfg = loadConfig();
  const cloud = isSaasMode();
  const relayUrl = relayBaseUrl(cfg);
  // Reconnect button: give a sleeping extension up to waitMs to come back.
  const waitMs = Math.min(Math.max(Number(opts?.waitMs) || 0, 0), 15_000);
  const probe = cloud
    ? null
    : waitMs > 0
      ? await waitForRelayConnection(relayUrl, { timeoutMs: waitMs })
      : await probeRelay(relayUrl, 1_200);
  const gov = getBrowserExtensionGovernance().status();
  return {
    cloud,
    relayUrl,
    relayReachable: probe?.reachable ?? false,
    connected: probe?.connected ?? false,
    paired: gov.profiles.length > 0,
    killSwitch: gov.killSwitch,
    connectedProfiles: probe?.profiles ?? [],
    pairedProfiles: gov.profiles.map((p) => ({
      id: p.id,
      name: p.name,
      lastSeenAt: p.lastSeenAt,
    })),
    webStoreUrl: chromeWebStoreUrl(),
    browserEnabled: cfg.browser?.enabled !== false,
    mainAgentUsesChrome:
      (process.env.INFINIBOT_BROWSER_MAIN_USES_EXTENSION ?? "on").toLowerCase() !== "off",
  };
}

/** Open example.com in the paired Chrome, read the title, close the tab. */
export async function runBrowserExtensionTest(): Promise<{
  ok: boolean;
  title?: string;
  url?: string;
  ms: number;
  error?: string;
}> {
  const started = Date.now();
  const { openRelayProfile } = await import("../../browser/agent/runtime.js");
  let page: import("playwright-core").Page | null = null;
  try {
    const handle = await withTimeout(openRelayProfile(), 15_000, "connecting to Chrome");
    page = await withTimeout(handle.context.newPage(), 10_000, "opening a tab");
    await page.goto("https://example.com/", { waitUntil: "domcontentloaded", timeout: 15_000 });
    const title = await withTimeout(page.title(), 5_000, "reading the title");
    return { ok: true, title, url: page.url(), ms: Date.now() - started };
  } catch (err) {
    return {
      ok: false,
      ms: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

// ── MCP test: speak MCP to the exact entry the apps run ─────────────────────

type McpTestCall = { tool: string; ok: boolean; ms: number; summary: string };

export async function runMcpEntryTest(
  entry: McpEntry,
  opts?: { timeoutMs?: number; browser?: boolean },
): Promise<{
  ok: boolean;
  toolCount: number;
  hasBrowser: boolean;
  calls: McpTestCall[];
  error?: string;
}> {
  const timeoutMs = opts?.timeoutMs ?? 45_000;
  const child = spawn(entry.command, entry.args, {
    env: { ...process.env, ...entry.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  let nextId = 1;
  const waiting = new Map<number, (msg: Record<string, unknown>) => void>();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        const id = typeof msg.id === "number" ? msg.id : undefined;
        if (id !== undefined) waiting.get(id)?.(msg);
      } catch {
        /* non-JSON noise */
      }
    }
  });
  child.stderr.on("data", () => {
    /* drain; never surfaced (may echo env-derived detail) */
  });
  const exited = new Promise<never>((_, reject) =>
    child.on("exit", (code) => reject(new Error(`MCP server exited (code ${code ?? "?"})`))),
  );
  const rpc = (method: string, params: unknown, ms = 20_000) =>
    withTimeout(
      Promise.race([
        new Promise<Record<string, unknown>>((resolve) => {
          const id = nextId++;
          waiting.set(id, resolve);
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        }),
        exited,
      ]),
      ms,
      `MCP ${method}`,
    );
  const calls: McpTestCall[] = [];
  const run = async () => {
    const init = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "infinibot-setup-test", version: "1" },
    });
    if (init.error) throw new Error(`initialize failed: ${JSON.stringify(init.error)}`);
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    const listed = await rpc("tools/list", {});
    const tools = ((listed.result as { tools?: Array<{ name: string }> })?.tools ?? []).map(
      (t) => t.name,
    );
    const call = async (
      tool: string,
      args: Record<string, unknown>,
      summarize: (text: string) => string,
    ) => {
      const t0 = Date.now();
      const res = await rpc("tools/call", { name: tool, arguments: args }, 40_000);
      const result = res.result as
        | { isError?: boolean; content?: Array<{ text?: string }> }
        | undefined;
      const text = (result?.content ?? []).map((c) => c.text ?? "").join("\n");
      const ok = !res.error && result?.isError !== true;
      calls.push({
        tool,
        ok,
        ms: Date.now() - t0,
        summary: ok ? summarize(text) : firstLine(text || JSON.stringify(res.error ?? "")),
      });
    };
    const statusTool = ["session_status", "infinibot_state", "infinibot_help"].find((t) =>
      tools.includes(t),
    );
    if (statusTool) await call(statusTool, {}, () => "answered");
    const hasBrowser = tools.includes("browser");
    if (hasBrowser && opts?.browser) {
      await call("browser", { action: "tabs", profile: "chrome" }, (text) => {
        const n = (text.match(/^\s*[-*\d]/gm) ?? []).length;
        return n
          ? `paired Chrome answered (${n} tab line${n === 1 ? "" : "s"})`
          : "paired Chrome answered";
      });
    }
    return { tools, hasBrowser };
  };
  try {
    const { tools, hasBrowser } = await withTimeout(run(), timeoutMs, "MCP test");
    return {
      ok: calls.length > 0 && calls.every((c) => c.ok),
      toolCount: tools.length,
      hasBrowser,
      calls,
    };
  } catch (err) {
    return {
      ok: false,
      toolCount: 0,
      hasBrowser: false,
      calls,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    child.kill();
  }
}

function firstLine(text: string): string {
  return text.split("\n")[0]!.slice(0, 200);
}

// ── handlers ────────────────────────────────────────────────────────────────

export const setupConnectHandlers: GatewayRequestHandlers = {
  "browser.connect.status": async ({ params, respond }) => {
    try {
      respond(true, await browserConnectStatus({ waitMs: Number(params?.waitMs) || 0 }));
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "browser.extension.test": async ({ respond }) => {
    if (isSaasMode()) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "On InfiniBot Cloud the browser runs through a linked computer; run the test there.",
        ),
      );
      return;
    }
    respond(true, await runBrowserExtensionTest());
  },

  "mcp.clients.detect": async ({ respond }) => {
    try {
      const entry = clientEntry();
      const defs = mcpClientDefs();
      const clients = defs.map((d) => mcpClientStatus(d, entry));
      const snippets: Record<string, string> = { generic: mcpClientSnippet("generic", entry) };
      for (const d of defs) snippets[d.id] = mcpClientSnippet(d.id, entry);
      respond(true, {
        cloud: isSaasMode(),
        gatewayUrl: gatewayWsUrl(),
        entry,
        clients,
        snippets,
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "mcp.clients.add": async ({ params, respond }) => {
    if (isSaasMode()) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "Add InfiniBot MCP from InfiniBot on your own computer.",
        ),
      );
      return;
    }
    const raw = Array.isArray(params?.ids) ? params.ids : [params?.id];
    const ids = raw.filter(isClientId);
    if (ids.length === 0) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "ids: pick at least one app"),
      );
      return;
    }
    const entry = clientEntry();
    const defs = new Map(mcpClientDefs().map((d) => [d.id, d]));
    const results = ids.map((id) => {
      const def = defs.get(id)!;
      try {
        const r = addInfinibotToClient(def, entry);
        log.info(`MCP entry ${r.changed ? "written" : "already current"} for ${def.name}`, {
          path: r.configPath,
          backup: r.backupPath,
        });
        return { ...r, ok: true as const, after: def.after };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`MCP entry not written for ${def.name}: ${message}`);
        return { id, configPath: def.configPath, ok: false as const, error: message };
      }
    });
    respond(true, { results });
  },

  "mcp.clients.test": async ({ params, respond }) => {
    if (isSaasMode()) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Not available on InfiniBot Cloud."),
      );
      return;
    }
    const browser = params?.browser !== false && isBrowserExtensionPaired();
    respond(true, await runMcpEntryTest(clientEntry(), { browser }));
  },
};

export const SETUP_CONNECT_METHODS = Object.keys(setupConnectHandlers);
