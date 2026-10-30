/**
 * Infinibot MCP adapter — builds a Model Context Protocol Server whose tool
 * list is auto-derived from the moltbot agent tool registry, exposed over the
 * gateway via `agent.tools.list` / `agent.tools.invoke`.
 *
 * Every call is proxied back to the gateway which handles policy filtering
 * and emits "agent" broadcast events so the activity panel + activity-map
 * see MCP-originated tool calls.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "crypto";

export interface GatewayCall {
  (method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<unknown>;
}

/**
 * Tools that legitimately block (subagents_wait, long-polling
 * subagents_events, visual_verify) need a longer gateway-call timeout than
 * the default 60s, sized from their own timeout argument.
 */
export function toolCallTimeoutMs(tool: string, args: Record<string, unknown>): number | undefined {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  if (tool === "subagents_wait") return (Math.min(600, num(args.timeoutSec) ?? 50) + 30) * 1000;
  if (tool === "subagents_events") return (Math.min(300, num(args.waitSec) ?? 0) + 30) * 1000;
  if (tool === "visual_verify") return 11 * 60 * 1000;
  // Operator approvals block up to waitSec (≤600); report_checkpoint on a gated
  // run blocks until the operator decides (bounded by the approval expiry).
  if (tool === "request_approval" || tool === "wait_approval") {
    return (Math.min(600, num(args.waitSec) ?? 300) + 30) * 1000;
  }
  if (tool === "report_checkpoint") return 35 * 60 * 1000;
  if (
    tool === "claude_coder" ||
    tool === "codex_coder" ||
    tool === "opencode_coder" ||
    tool === "grok_coder"
  ) {
    return args.mode === "sync" ? ((num(args.timeoutMinutes) ?? 15) * 60 + 120) * 1000 : undefined;
  }
  return undefined;
}

export interface StaticToolHandler {
  (args: Record<string, unknown>): Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  }>;
}

export interface StaticTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: StaticToolHandler;
}

export interface AdapterOptions {
  callGateway: GatewayCall;
  /** Default session key used for tool invocations. */
  defaultSessionKey?: string;
  /** Friendly label for the activity feed (e.g. "Claude Code · host · pid 1234").
   *  Forwarded with each invoke so the gateway can auto-register a SessionEntry
   *  the first time it sees this MCP client. */
  defaultSessionLabel?: string;
  /** Stable run id that groups all tool calls from this MCP session. */
  runId?: string;
  /** Emitted as `source` in activity events so UI can differentiate MCP origin. */
  source?: string;
  /** Logger for diagnostic output. */
  log?: (level: "info" | "warn" | "error", msg: string, meta?: unknown) => void;
  /**
   * Extra tools to register alongside the agent registry (e.g. claude-bridge
   * progress/message/request-input). These are listed + called locally; they
   * do NOT go through agent.tools.invoke.
   */
  staticTools?: StaticTool[];
  /**
   * Server metadata for the MCP handshake. Defaults to infinibot/1.0.0.
   */
  serverInfo?: { name: string; version: string };
  /** MCP `instructions` sent in the initialize result (orchestrator role). */
  instructions?: string;
}

interface RemoteTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

interface ListToolsResponse {
  tools: RemoteTool[];
  sessionKey?: string;
}

interface InvokeToolResponse {
  ok?: boolean;
  toolCallId?: string;
  runId?: string;
  result?: unknown;
}

type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/**
 * Text plus any images an agent tool returned (a phone screenshot, a camera
 * snap), so an MCP client can see the picture instead of a MEDIA: path.
 */
export function coerceToolContent(value: unknown): McpContent[] {
  const text = coerceTextContent(value);
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray((value as { content?: unknown[] }).content)
  ) {
    return text;
  }
  const images = (value as { content: Array<Record<string, unknown>> }).content
    .filter(
      (c) =>
        c &&
        c.type === "image" &&
        typeof c.data === "string" &&
        c.data.length > 0 &&
        typeof c.mimeType === "string",
    )
    .map((c) => ({
      type: "image" as const,
      data: c.data as string,
      mimeType: c.mimeType as string,
    }));
  return images.length ? [...text, ...images] : text;
}

function coerceTextContent(value: unknown): Array<{ type: "text"; text: string }> {
  if (value === undefined || value === null) {
    return [{ type: "text", text: "" }];
  }
  if (typeof value === "string") {
    return [{ type: "text", text: value }];
  }
  // Agent tool results shape: { content: [{ type, text|...}], details }
  if (
    value &&
    typeof value === "object" &&
    Array.isArray((value as { content?: unknown[] }).content)
  ) {
    const content = (value as { content: Array<{ type?: string; text?: string }> }).content;
    const texts = content
      .filter((c) => c && (c.type === "text" || typeof c.text === "string"))
      .map((c) => (typeof c.text === "string" ? c.text : JSON.stringify(c)));
    if (texts.length > 0) return [{ type: "text", text: texts.join("\n") }];
  }
  try {
    return [{ type: "text", text: JSON.stringify(value, null, 2) }];
  } catch {
    return [{ type: "text", text: String(value) }];
  }
}

function sanitizeToolName(name: string): string {
  // Claude Code enforces /^[a-zA-Z0-9_-]+$/ for MCP tool names.
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  return cleaned.length ? cleaned : "tool";
}

function sanitizeInputSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object", properties: {} };
  }
  const obj = schema as Record<string, unknown>;
  if (obj.type !== "object") {
    return { type: "object", properties: {}, ...obj };
  }
  const out: Record<string, unknown> = { ...obj };
  if (!out.properties || typeof out.properties !== "object") {
    out.properties = {};
  }
  return out;
}

export interface InfinibotAdapterHandle {
  /** The underlying MCP server instance — connect a transport to it. */
  server: Server;
  /** Force a fresh fetch of tool metadata from the gateway. */
  refresh: () => Promise<void>;
  /** Number of tools currently registered. */
  readonly toolCount: number;
}

export async function createInfinibotAdapter(
  opts: AdapterOptions,
): Promise<InfinibotAdapterHandle> {
  const log = opts.log ?? (() => {});
  const runId = opts.runId ?? randomUUID();
  const source = opts.source ?? "mcp";

  const server = new Server(opts.serverInfo ?? { name: "infinibot", version: "1.0.0" }, {
    capabilities: {
      tools: { listChanged: true },
      // Completion pushes: MCP logging messages for any client, plus the
      // Claude Code channel capability (`claude --channels`), see
      // docs/principles/VERIFIED-COMPLETION.md.
      logging: {},
      experimental: { "claude/channel": {} },
    },
    ...(opts.instructions ? { instructions: opts.instructions } : {}),
  });

  let tools: RemoteTool[] = [];
  const staticTools = opts.staticTools ?? [];
  const staticByName = new Map<string, StaticTool>(staticTools.map((t) => [t.name, t]));

  async function fetchTools(): Promise<void> {
    const res = (await opts.callGateway("agent.tools.list", {
      sessionKey: opts.defaultSessionKey,
      sessionLabel: opts.defaultSessionLabel,
      runId,
      source,
    })) as ListToolsResponse;
    tools = Array.isArray(res?.tools) ? res.tools : [];
    log(
      "info",
      `[infinibot-adapter] fetched ${tools.length} tools from gateway (+${staticTools.length} static)`,
      { first: tools.slice(0, 5).map((t) => t.name) },
    );
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      await fetchTools();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log("warn", `[infinibot-adapter] tool refresh failed: ${msg}`);
    }
    const agent = tools.map((t) => ({
      name: sanitizeToolName(t.name),
      description: t.description ?? t.name,
      inputSchema: sanitizeInputSchema(t.inputSchema),
    }));
    const statics = staticTools.map((t) => ({
      name: sanitizeToolName(t.name),
      description: t.description,
      inputSchema: sanitizeInputSchema(t.inputSchema),
    }));
    // Static tools win on name collisions — they're bridge-specific.
    const seen = new Set<string>();
    const out: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> =
      [];
    for (const t of [...statics, ...agent]) {
      if (seen.has(t.name)) continue;
      seen.add(t.name);
      out.push(t);
    }
    return { tools: out };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const requested = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;

    // Static (bridge-specific) tool handling wins first.
    const staticMatch =
      staticByName.get(requested) ||
      staticTools.find((t) => sanitizeToolName(t.name) === requested);
    if (staticMatch) {
      try {
        return await staticMatch.handler(args);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("warn", `[infinibot-adapter] static tool ${staticMatch.name} failed: ${msg}`);
        return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
      }
    }

    // Agent registry tool — reverse lookup since list uses sanitized names.
    const match =
      tools.find((t) => t.name === requested) ||
      tools.find((t) => sanitizeToolName(t.name) === requested);
    if (!match) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${requested}` }],
        isError: true,
      };
    }
    try {
      const res = (await opts.callGateway(
        "agent.tools.invoke",
        {
          tool: match.name,
          args,
          sessionKey: opts.defaultSessionKey,
          sessionLabel: opts.defaultSessionLabel,
          runId,
          source,
        },
        { timeoutMs: toolCallTimeoutMs(match.name, args) },
      )) as InvokeToolResponse;
      return {
        content: coerceToolContent(res?.result),
        isError: false,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log("warn", `[infinibot-adapter] tool ${match.name} failed: ${msg}`);
      return {
        content: [{ type: "text", text: `Error: ${msg}` }],
        isError: true,
      };
    }
  });

  await fetchTools();

  return {
    server,
    refresh: fetchTools,
    get toolCount() {
      return tools.length;
    },
  };
}
