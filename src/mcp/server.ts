import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocket } from "ws";
import { randomUUID, timingSafeEqual } from "crypto";
import { createServer, type Server as HttpServer } from "http";
import { URL } from "url";

import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from "../infra/device-identity.js";
import {
  clearDeviceAuthToken,
  loadDeviceAuthToken,
  storeDeviceAuthToken,
} from "../infra/device-auth-store.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { buildDeviceAuthPayload } from "../gateway/device-auth.js";
import { createInfinibotAdapter, type InfinibotAdapterHandle } from "./infinibot-adapter.js";
import { MCP_ORCHESTRATOR_LINES } from "../agents/mcp-orchestrator-prompt.js";

/**
 * Relay a gateway `verification.completion` event to the connected MCP
 * client as (1) an MCP logging notification (any client that enabled
 * logging) and (2) a Claude Code channel notification (`claude --channels`).
 * Only events for runs THIS session spawned are relayed.
 */
export function formatCompletionPush(payload: Record<string, unknown>): {
  content: string;
  meta: Record<string, string>;
} {
  const state = String(payload.state ?? "");
  const verdict = String(payload.verdict ?? state.toUpperCase());
  const label = String(payload.label ?? payload.runId ?? "sub-agent");
  const reasons = Array.isArray(payload.reasons) ? (payload.reasons as unknown[]).map(String) : [];
  const summary = String(payload.summary ?? "");
  const verified = state === "verified" || state === "accepted";
  const lines = [
    `Sub-agent "${label}" finished: ${verdict} (${state}).`,
    summary ? `Summary (agent's own words): ${summary}` : "",
    !verified && reasons.length ? `Not verified because: ${reasons.slice(0, 4).join("; ")}` : "",
    verified
      ? "Verified against evidence — you may relay it as done."
      : "Do not relay its claims as facts. Call subagents_wait / subagents_events for details.",
    `runId: ${String(payload.runId ?? "")}`,
  ].filter(Boolean);
  return {
    content: lines.join("\n"),
    meta: {
      run_id: String(payload.runId ?? ""),
      state,
      verdict,
    },
  };
}

// InfiniBot Protocol Constants
const PROTOCOL_VERSION = 3;

export interface McpServerHandle {
  stop(): Promise<void>;
  readonly running: boolean;
  readonly port: number;
  readonly startedAt: number;
  readonly toolCount: number;
}

// Global singleton so gateway handlers can control the MCP server
let currentHandle: McpServerHandle | null = null;
let lastOptions: Parameters<typeof runMcpServer>[0] | null = null;

export function getMcpServerHandle(): McpServerHandle | null {
  return currentHandle;
}

export function getLastMcpOptions() {
  return lastOptions;
}

/** Strip credentials from a connect frame before it goes anywhere near a log. */
export function redactConnectFrame<T>(frame: T): T {
  const clone = JSON.parse(JSON.stringify(frame ?? null)) as {
    params?: { auth?: Record<string, unknown>; device?: Record<string, unknown> };
  } | null;
  const auth = clone?.params?.auth;
  if (auth && typeof auth === "object") {
    for (const key of Object.keys(auth)) {
      if (auth[key] !== undefined && auth[key] !== null && auth[key] !== "")
        auth[key] = "[redacted]";
    }
  }
  if (clone?.params?.device && typeof clone.params.device === "object") {
    if ("signature" in clone.params.device) clone.params.device.signature = "[redacted]";
  }
  return clone as T;
}

function httpBridgeAuthorized(req: import("http").IncomingMessage, secrets: string[]): boolean {
  const configured = secrets.filter(Boolean);
  if (configured.length === 0) return true;
  const raw = String(req.headers.authorization ?? "").trim();
  const bearer = raw.toLowerCase().startsWith("bearer ") ? raw.slice(7).trim() : "";
  if (!bearer) return false;
  const given = Buffer.from(bearer);
  return configured.some((secret) => {
    const want = Buffer.from(secret);
    return want.length === given.length && timingSafeEqual(want, given);
  });
}

export async function runMcpServer(options: {
  gatewayUrl?: string; // e.g. ws://127.0.0.1:18789
  gatewayToken?: string;
  gatewayPassword?: string;
  defaultSessionKey?: string;
  /** Friendly label for the activity feed. Forwarded with each tool call so
   *  the gateway can auto-register a SessionEntry the first time it sees us. */
  defaultSessionLabel?: string;
  verbose?: boolean;
  httpPort?: number; // If set, runs an HTTP bridge on this port
  /** Bind address for the HTTP bridge (default 127.0.0.1). */
  httpHost?: string;
  rejectUnauthorized?: boolean; // Set to false to allow self-signed certs
  /** Override the MCP "source" tag that flows into activity events. */
  source?: string;
}): Promise<McpServerHandle> {
  lastOptions = options;
  const url = options.gatewayUrl || "ws://127.0.0.1:18789";
  const token = options.gatewayToken || "";
  const password = options.gatewayPassword || "";
  const source = options.source ?? "mcp";
  const role = "operator";
  const scopes = ["operator.admin"];
  const clientId = GATEWAY_CLIENT_NAMES.MCP;
  const clientMode = GATEWAY_CLIENT_MODES.BACKEND;
  const deviceIdentity = loadOrCreateDeviceIdentity();

  // Raw WS frame dumps are opt-in on top of verbose: they carry session
  // content, and the connect frame carries the gateway credential.
  const traceFrames =
    Boolean(options.verbose) &&
    ["1", "true", "yes"].includes((process.env.INFINIBOT_MCP_TRACE_FRAMES ?? "").toLowerCase());
  const logInfo = (msg: string, meta?: unknown) => {
    if (options.verbose) console.error(`[mcp] ${msg}`, meta ?? "");
  };
  const logError = (msg: string, meta?: unknown) => console.error(`[mcp] ${msg}`, meta ?? "");

  logInfo(`Connecting to ${url}`);

  let ws: WebSocket | null = null;
  const requestMap = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void }>();
  let isConnected = false;
  let stopped = false;
  let connectPromise: Promise<void> | null = null;
  let connectNonce: string | null = null;
  let sendQueuedConnect: (() => void) | null = null;
  // Set once the MCP Server exists; relays completion events to the client.
  let completionPush: ((payload: Record<string, unknown>) => void) | null = null;

  const rejectPendingRequests = (err: Error) => {
    for (const [id, pending] of requestMap) {
      requestMap.delete(id);
      pending.reject(err);
    }
  };

  const buildConnectFrame = (id: string) => {
    const storedToken = loadDeviceAuthToken({ deviceId: deviceIdentity.deviceId, role })?.token;
    const authToken = storedToken ?? (token || undefined);
    const signedAtMs = Date.now();
    const nonce = connectNonce ?? undefined;
    const payload = buildDeviceAuthPayload({
      deviceId: deviceIdentity.deviceId,
      clientId,
      clientMode,
      role,
      scopes,
      signedAtMs,
      token: authToken ?? null,
      nonce,
    });
    return {
      type: "req",
      id,
      method: "connect",
      params: {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: {
          id: clientId,
          version: "1.0.0",
          platform: "node",
          mode: clientMode,
        },
        caps: [],
        auth:
          authToken || password ? { token: authToken, password: password || undefined } : undefined,
        role,
        scopes,
        device: {
          id: deviceIdentity.deviceId,
          publicKey: publicKeyRawBase64UrlFromPem(deviceIdentity.publicKeyPem),
          signature: signDevicePayload(deviceIdentity.privateKeyPem, payload),
          signedAt: signedAtMs,
          nonce,
        },
      },
    };
  };

  const connectToGateway = async () => {
    let attempts = 0;
    const maxAttempts = 10;

    while (attempts < maxAttempts) {
      attempts++;
      if (stopped) throw new Error("MCP server stopped");
      try {
        logInfo(`Connection attempt ${attempts}/${maxAttempts}`);

        if (ws && ws.readyState !== WebSocket.CLOSED) {
          ws.terminate();
        }

        const socket = new WebSocket(url, {
          rejectUnauthorized: options.rejectUnauthorized,
        });
        ws = socket;

        socket.on("message", (data) => {
          if (ws !== socket) return;
          const text = data.toString();
          if (traceFrames) console.error(`[mcp] IN: ${text.slice(0, 200)}`);
          try {
            const msg = JSON.parse(text);
            if (msg.type === "event" && msg.event === "verification.completion") {
              const payload = (msg.payload ?? {}) as Record<string, unknown>;
              const ev = (payload.event ?? {}) as { type?: string };
              if (
                ev.type === "run.terminal" &&
                (!options.defaultSessionKey ||
                  payload.requesterSessionKey === options.defaultSessionKey)
              ) {
                completionPush?.(payload);
              }
              return;
            }
            if (msg.type === "event" && msg.event === "connect.challenge") {
              const nonce =
                msg.payload && typeof msg.payload.nonce === "string" ? msg.payload.nonce : null;
              if (nonce) {
                connectNonce = nonce;
                sendQueuedConnect?.();
              }
              return;
            }
            if (
              msg.type === "hello-ok" ||
              (msg.type === "res" && msg.payload?.type === "hello-ok")
            ) {
              isConnected = true;
              logInfo("Handshake successful");
            }
            if (msg.type === "res" && msg.id) {
              const pending = requestMap.get(msg.id);
              if (pending) {
                requestMap.delete(msg.id);
                if (msg.ok) pending.resolve(msg.payload);
                else pending.reject(new Error(msg.error?.message || "Request failed"));
              }
            }
          } catch (err) {
            logInfo("WS message parse error", err);
          }
        });

        socket.on("error", (err) => {
          logInfo(`WS socket error: ${err.message}`);
        });

        socket.on("close", (code, reason) => {
          if (ws !== socket) return;
          logInfo(`WS closed: ${code} ${reason}`);
          isConnected = false;
          ws = null;
          rejectPendingRequests(new Error(`Gateway connection closed (${code})`));
        });

        await new Promise<void>((resolve, reject) => {
          const handshakeTimeout = 8000;
          let connectId: string | undefined;
          let settled = false;
          const settle = (err?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            clearInterval(checkInterval);
            if (connectTimer) clearTimeout(connectTimer);
            if (sendQueuedConnect === sendConnect) sendQueuedConnect = null;
            if (connectId) requestMap.delete(connectId);
            if (err) reject(err);
            else resolve();
          };
          const timeout = setTimeout(
            () => settle(new Error(`Handshake timeout after ${handshakeTimeout}ms`)),
            handshakeTimeout,
          );

          let connectTimer: NodeJS.Timeout | null = null;
          const sendConnect = () => {
            if (connectId) return;
            if (connectTimer) {
              clearTimeout(connectTimer);
              connectTimer = null;
            }
            connectId = randomUUID();
            requestMap.set(connectId, {
              resolve: (helloOk) => {
                const authInfo =
                  helloOk && typeof helloOk === "object"
                    ? (
                        helloOk as {
                          auth?: { deviceToken?: string; role?: string; scopes?: string[] };
                        }
                      ).auth
                    : undefined;
                if (authInfo?.deviceToken) {
                  storeDeviceAuthToken({
                    deviceId: deviceIdentity.deviceId,
                    role: authInfo.role ?? role,
                    token: authInfo.deviceToken,
                    scopes: authInfo.scopes ?? [],
                  });
                }
                isConnected = true;
                settle();
              },
              reject: (err) => {
                if (token) {
                  clearDeviceAuthToken({ deviceId: deviceIdentity.deviceId, role });
                }
                settle(err);
              },
            });
            const payload = buildConnectFrame(connectId);
            if (traceFrames)
              console.error(`[mcp] OUT: ${JSON.stringify(redactConnectFrame(payload))}`);
            socket.send(JSON.stringify(payload));
          };
          sendQueuedConnect = sendConnect;

          socket.once("open", () => {
            connectTimer = setTimeout(sendConnect, 750);
          });

          const checkInterval = setInterval(() => {
            if (isConnected) {
              settle();
            }
          }, 100);

          socket.once("error", (err) => {
            settle(err);
          });
        });

        return; // Success
      } catch (err) {
        if (ws) {
          ws.terminate();
          ws = null;
        }
        isConnected = false;
        if (attempts === maxAttempts) throw err;
        logInfo(`Connection failed, retrying: ${err}`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  };

  const ensureGatewayConnected = async () => {
    if (stopped) throw new Error("MCP server stopped");
    if (isConnected && ws?.readyState === WebSocket.OPEN) return;
    connectPromise ??= connectToGateway().finally(() => {
      connectPromise = null;
    });
    await connectPromise;
  };

  await ensureGatewayConnected();

  // JSON-RPC helper used by the infinibot adapter to reach the gateway.
  const callGateway = async (
    method: string,
    params: unknown = {},
    callOpts?: { timeoutMs?: number },
  ): Promise<unknown> => {
    await ensureGatewayConnected();
    const socket = ws;
    if (!isConnected || !socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Not connected to gateway");
    }
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timeout = setTimeout(() => {
        if (requestMap.has(id)) {
          requestMap.delete(id);
          reject(new Error(`Timeout calling method: ${method}`));
        }
      }, callOpts?.timeoutMs ?? 60_000);
      requestMap.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });
      try {
        socket.send(JSON.stringify({ type: "req", id, method, params }));
      } catch (err) {
        requestMap.delete(id);
        clearTimeout(timeout);
        isConnected = false;
        reject(err);
      }
    });
  };

  // Pre-fetch tools exposed by external MCP servers running under this
  // gateway (e.g. excalidraw, notion). Without this, Claude Code only
  // sees the agent registry plus the generic `mcp` tool, and has to
  // call mcp.invoke({mcp:"excalidraw",tool:"create_batch",...}) to draw.
  // Surfacing each external MCP tool directly as <mcp>_<tool> lets
  // Claude pick them just like any other tool.
  const externalStaticTools = await (async () => {
    try {
      const list = (await callGateway("mcp.tools.list", {
        sessionKey: options.defaultSessionKey,
      })) as {
        tools?: Array<{ mcp?: string; name?: string; description?: string; inputSchema?: unknown }>;
      };
      const tools = Array.isArray(list?.tools) ? list.tools : [];
      return tools
        .filter((t) => typeof t?.mcp === "string" && typeof t?.name === "string")
        .map((t) => {
          const mcp = t.mcp!;
          const tool = t.name!;
          const flatName = `${mcp}_${tool}`;
          const desc = t.description?.trim() || `${tool} (via ${mcp} MCP)`;
          const inputSchema = (
            t.inputSchema && typeof t.inputSchema === "object"
              ? t.inputSchema
              : { type: "object", properties: {} }
          ) as Record<string, unknown>;
          return {
            name: flatName,
            description: `[${mcp}] ${desc}`,
            inputSchema,
            handler: async (args: Record<string, unknown>) => {
              try {
                const result = (await callGateway("mcp.tools.invoke", {
                  mcp,
                  tool,
                  args,
                })) as { content?: Array<{ type?: string; text?: string }> } | unknown;
                const content =
                  result &&
                  typeof result === "object" &&
                  Array.isArray((result as { content?: unknown[] }).content)
                    ? (result as { content: Array<{ type?: string; text?: string }> }).content.map(
                        (c) => ({
                          type: "text" as const,
                          text: typeof c.text === "string" ? c.text : JSON.stringify(c),
                        }),
                      )
                    : [{ type: "text" as const, text: JSON.stringify(result, null, 2) }];
                return { content };
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return {
                  content: [
                    { type: "text" as const, text: `Error invoking ${mcp}.${tool}: ${msg}` },
                  ],
                  isError: true,
                };
              }
            },
          };
        });
    } catch (err) {
      // Gateway might not have any external MCPs running — that's
      // fine, the adapter still gets the agent-registry tools.
      logInfo("external MCP discovery skipped", err instanceof Error ? err.message : String(err));
      return [];
    }
  })();

  if (externalStaticTools.length > 0) {
    const byMcp = new Map<string, number>();
    for (const t of externalStaticTools) {
      const mcpName = t.name.split("_")[0];
      byMcp.set(mcpName, (byMcp.get(mcpName) ?? 0) + 1);
    }
    const summary = [...byMcp.entries()].map(([m, n]) => `${m}:${n}`).join(", ");
    logInfo(`exposing ${externalStaticTools.length} tools from external MCPs (${summary})`);
  }

  // Build the MCP server by auto-deriving tools from the gateway's registry.
  const adapter: InfinibotAdapterHandle = await createInfinibotAdapter({
    callGateway,
    defaultSessionKey: options.defaultSessionKey,
    defaultSessionLabel: options.defaultSessionLabel,
    source,
    staticTools: externalStaticTools,
    instructions: MCP_ORCHESTRATOR_LINES.join("\n"),
    log: (level, msg, meta) => {
      if (level === "error") logError(msg, meta);
      else logInfo(msg, meta);
    },
  });
  const server = adapter.server;
  completionPush = (payload) => {
    const { content, meta } = formatCompletionPush(payload);
    const verified = meta.state === "verified" || meta.state === "accepted";
    void server
      .sendLoggingMessage({
        level: verified ? "info" : "warning",
        logger: "infinibot.completion",
        data: { ...payload, message: content },
      })
      .catch(() => {});
    void server
      .notification({ method: "notifications/claude/channel", params: { content, meta } })
      .catch(() => {});
  };
  logInfo(
    `Registered ${adapter.toolCount} tools from agent registry (+ ${externalStaticTools.length} external MCP tools)`,
  );

  // Optional HTTP bridge — thin REST wrapper over the same gateway calls, kept
  // for backwards compatibility with callers that scraped /mcp/* endpoints.
  let httpServer: HttpServer | null = null;
  const httpPort = options.httpPort || 0;

  if (options.httpPort) {
    // Loopback-only, no CORS, and the gateway credential as a Bearer token:
    // /mcp/invoke runs any agent tool, so it gets the same bar as the gateway.
    httpServer = createServer(async (req, res) => {
      if (req.headers.origin || !httpBridgeAuthorized(req, [token, password])) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const reqUrl = new URL(req.url || "/", `http://localhost:${options.httpPort}`);
      const pathname = reqUrl.pathname;
      try {
        if (pathname === "/mcp/tools" && req.method === "GET") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify(
              (await callGateway("agent.tools.list", {
                sessionKey: options.defaultSessionKey,
              })) ?? { tools: [] },
            ),
          );
          return;
        }
        if (pathname === "/mcp/invoke" && req.method === "POST") {
          let body = "";
          for await (const chunk of req) body += chunk;
          const data = body ? JSON.parse(body) : {};
          const result = await callGateway("agent.tools.invoke", {
            tool: data.tool,
            args: data.args ?? {},
            action: data.action,
            sessionKey: data.sessionKey ?? options.defaultSessionKey,
            source,
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
          return;
        }
        // Back-compat paths kept so any downstream scrape still works.
        if (pathname === "/mcp/projects" && req.method === "GET") {
          const projects = await callGateway("kanban.projects.list", {});
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(projects));
          return;
        }
        if (pathname === "/mcp/tasks" && req.method === "GET") {
          const projectId = reqUrl.searchParams.get("projectId") || undefined;
          const status = reqUrl.searchParams.get("status") || undefined;
          const assignee = reqUrl.searchParams.get("assigned_to") || undefined;
          const tasks = (await callGateway("kanban.tasks.list", { projectId })) as any[];
          let filtered = tasks ?? [];
          if (status) filtered = filtered.filter((t: any) => t.status === status);
          if (assignee) filtered = filtered.filter((t: any) => (t.assignee || "") === assignee);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(filtered));
          return;
        }
        res.writeHead(404);
        res.end("Not Found");
      } catch (err: any) {
        logError(`[mcp-http] ${err?.message ?? err}`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err?.message ?? String(err) }));
      }
    });

    httpServer.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        logError(
          `Port ${options.httpPort} already in use — skipping HTTP bridge (will retry on next restart)`,
        );
      } else {
        logError(`HTTP bridge error: ${err.message}`);
      }
    });
    httpServer.listen(options.httpPort, options.httpHost ?? "127.0.0.1", () => {
      logError(`HTTP bridge running on port ${options.httpPort}`);
    });
  }

  // Connect stdio transport unless running HTTP-only (sidecar mode).
  if (!options.httpPort) {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logInfo("MCP server running on stdio");
  }

  const startedAt = Date.now();
  let _running = true;

  const handle: McpServerHandle = {
    get running() {
      return _running;
    },
    get port() {
      return httpPort;
    },
    get startedAt() {
      return startedAt;
    },
    get toolCount() {
      return adapter.toolCount;
    },
    async stop() {
      _running = false;
      stopped = true;
      connectPromise = null;
      rejectPendingRequests(new Error("MCP server stopped"));
      if (httpServer) {
        await new Promise<void>((resolve) => {
          httpServer!.close(() => resolve());
        });
        httpServer = null;
      }
      if (ws) {
        ws.terminate();
        ws = null;
      }
      isConnected = false;
      if (currentHandle === handle) {
        currentHandle = null;
      }
    },
  };

  currentHandle = handle;
  return handle;
}
