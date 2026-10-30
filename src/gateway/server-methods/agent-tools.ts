/**
 * agent.tools.* — Unified gateway surface that exposes the moltbot agent tool
 * registry over JSON-RPC. The infinibot MCP server (src/mcp/server.ts) calls
 * these so external Claude Code / Claude Coder sessions drive the exact same
 * tool registry the internal agent uses.
 *
 * Every invocation is broadcast as an "agent" event so the activity panel and
 * activity-map pick up MCP-originated tool calls just like in-process agent runs.
 */

import { randomUUID } from "crypto";

import { createInfiniBotTools } from "../../agents/infinibot-tools.js";
import { dropEmptyToolSlots } from "../../plugins/core-tool-slots.js";
import {
  filterToolsByPolicy,
  resolveEffectiveToolPolicy,
  resolveGroupToolPolicy,
  resolveSubagentToolPolicy,
} from "../../agents/pi-tools.policy.js";
import {
  buildPluginToolGroups,
  collectExplicitAllowlist,
  expandPolicyWithPluginGroups,
  normalizeToolName,
  resolveToolProfilePolicy,
  stripPluginOnlyAllowlist,
} from "../../agents/tool-policy.js";
import { loadConfig } from "../../config/config.js";
import { resolveMainSessionKey } from "../../config/sessions.js";
import { resolveDefaultSessionStorePath } from "../../config/sessions/paths.js";
import { loadSessionStore, updateSessionStore } from "../../config/sessions/store.js";
import { mergeSessionEntry } from "../../config/sessions/types.js";
import { appendAssistantMessageToSessionTranscript } from "../../config/sessions/transcript.js";
import { MCP_ORCHESTRATOR_LINES } from "../../agents/mcp-orchestrator-prompt.js";
import { piggybackInboxOnToolResult } from "../../agents/subagent-inbox/service.js";
import { logWarn } from "../../logger.js";
import { getPluginToolMeta } from "../../plugins/tools.js";
import { isSubagentSessionKey } from "../../routing/session-key.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";

import type { GatewayRequestHandlers } from "./types.js";

type AnyTool = {
  name: string;
  description?: string;
  label?: string;
  parameters?: unknown;
  execute?: (
    toolCallId: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<unknown>;
};

interface BuildContextParams {
  sessionKeyRaw?: string;
  messageChannel?: string;
  accountId?: string;
}

function buildTools(params: BuildContextParams): {
  sessionKey: string;
  tools: AnyTool[];
} {
  const cfg = loadConfig();
  const sessionKey =
    !params.sessionKeyRaw || params.sessionKeyRaw === "main"
      ? resolveMainSessionKey(cfg)
      : params.sessionKeyRaw;

  const messageChannel = params.messageChannel
    ? normalizeMessageChannel(params.messageChannel)
    : null;
  const accountId = params.accountId?.trim() || undefined;

  const {
    agentId,
    globalPolicy,
    globalProviderPolicy,
    agentPolicy,
    agentProviderPolicy,
    profile,
    providerProfile,
    profileAlsoAllow,
    providerProfileAlsoAllow,
  } = resolveEffectiveToolPolicy({ config: cfg, sessionKey });
  const profilePolicy = resolveToolProfilePolicy(profile);
  const providerProfilePolicy = resolveToolProfilePolicy(providerProfile);

  const mergeAlsoAllow = (policy: typeof profilePolicy, alsoAllow?: string[]) => {
    if (!policy?.allow || !Array.isArray(alsoAllow) || alsoAllow.length === 0) return policy;
    return { ...policy, allow: Array.from(new Set([...policy.allow, ...alsoAllow])) };
  };

  const profilePolicyWithAlsoAllow = mergeAlsoAllow(profilePolicy, profileAlsoAllow);
  const providerProfilePolicyWithAlsoAllow = mergeAlsoAllow(
    providerProfilePolicy,
    providerProfileAlsoAllow,
  );
  const groupPolicy = resolveGroupToolPolicy({
    config: cfg,
    sessionKey,
    messageProvider: (messageChannel ?? undefined) as GatewayMessageChannel | undefined,
    accountId: accountId ?? null,
  });
  const subagentPolicy = isSubagentSessionKey(sessionKey)
    ? resolveSubagentToolPolicy(cfg)
    : undefined;

  // Empty plugin tool slots (plugin off) are dropped — core-tool-slots.ts.
  const allTools = dropEmptyToolSlots(
    createInfiniBotTools({
      agentSessionKey: sessionKey,
      agentChannel: (messageChannel ?? undefined) as GatewayMessageChannel | undefined,
      agentAccountId: accountId,
      config: cfg,
      pluginToolAllowlist: collectExplicitAllowlist([
        profilePolicy,
        providerProfilePolicy,
        globalPolicy,
        globalProviderPolicy,
        agentPolicy,
        agentProviderPolicy,
        groupPolicy,
        subagentPolicy,
      ]),
    }),
  ) as unknown as AnyTool[];

  const coreToolNames = new Set(
    allTools
      .filter((tool) => !getPluginToolMeta(tool as any))
      .map((tool) => normalizeToolName(tool.name))
      .filter(Boolean),
  );
  const pluginGroups = buildPluginToolGroups({
    tools: allTools as any,
    toolMeta: (tool) => getPluginToolMeta(tool as any),
  });
  const resolvePolicy = (policy: typeof profilePolicy, label: string) => {
    const resolved = stripPluginOnlyAllowlist(policy, pluginGroups, coreToolNames);
    if (resolved.unknownAllowlist.length > 0) {
      logWarn(
        `agent-tools: ${label} allowlist contains unknown entries (${resolved.unknownAllowlist.join(", ")}).`,
      );
    }
    return expandPolicyWithPluginGroups(resolved.policy, pluginGroups);
  };
  const steps = [
    resolvePolicy(
      profilePolicyWithAlsoAllow,
      profile ? `tools.profile (${profile})` : "tools.profile",
    ),
    resolvePolicy(
      providerProfilePolicyWithAlsoAllow,
      providerProfile
        ? `tools.byProvider.profile (${providerProfile})`
        : "tools.byProvider.profile",
    ),
    resolvePolicy(globalPolicy, "tools.allow"),
    resolvePolicy(globalProviderPolicy, "tools.byProvider.allow"),
    resolvePolicy(agentPolicy, agentId ? `agents.${agentId}.tools.allow` : "agent tools.allow"),
    resolvePolicy(
      agentProviderPolicy,
      agentId ? `agents.${agentId}.tools.byProvider.allow` : "agent tools.byProvider.allow",
    ),
    resolvePolicy(groupPolicy, "group tools.allow"),
    subagentPolicy ? expandPolicyWithPluginGroups(subagentPolicy, pluginGroups) : null,
  ];
  let filtered = allTools as any;
  for (const p of steps) {
    if (p) filtered = filterToolsByPolicy(filtered, p);
  }
  return { sessionKey, tools: filtered as AnyTool[] };
}

function toJsonSerializable(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return value;
  if (Array.isArray(value)) return value.map(toJsonSerializable);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = toJsonSerializable(v);
    }
    return out;
  }
  return undefined;
}

/**
 * Build a one-line, human-readable summary of tool arguments for the activity
 * feed. Picks the most-informative-looking field (path, target, query, name,
 * url) and trims long strings — the goal is "you can see what the agent is
 * doing at a glance", not full reproducibility.
 */
function summarizeToolArgs(args: Record<string, unknown>): string {
  if (!args || typeof args !== "object") return "";
  const candidateKeys = [
    "path",
    "file",
    "filename",
    "filePath",
    "target",
    "to",
    "destination",
    "query",
    "search",
    "q",
    "name",
    "tool",
    "command",
    "cmd",
    "url",
    "message",
    "text",
  ];
  for (const key of candidateKeys) {
    const v = (args as Record<string, unknown>)[key];
    if (typeof v === "string" && v.trim()) {
      const trimmed = v.trim().replace(/\s+/g, " ");
      return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
    }
  }
  // Fallback: show the first scalar value of any field
  for (const v of Object.values(args)) {
    if (typeof v === "string" && v.trim()) {
      const trimmed = v.trim().replace(/\s+/g, " ");
      return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
    }
    if (typeof v === "number" || typeof v === "boolean") return String(v);
  }
  return "";
}

/**
 * Heuristic from MCP-supplied label → coder backend name, so the activity
 * feed / isometric map can show the right provider logo for third-party AIs
 * connecting in (Claude Desktop, Codex CLI, OpenCode, Cursor, …). Matches the
 * `coderBackend` union on SessionEntry; falls back to undefined for unknown
 * clients (still rendered, just without a backend-specific badge).
 */
function inferCoderBackendFromLabel(
  label: string | undefined,
): "claude-code" | "opencode" | "codex" | "gemini" | "grok" | undefined {
  if (!label) return undefined;
  const s = label.toLowerCase();
  if (s.includes("opencode")) return "opencode";
  if (s.includes("codex")) return "codex";
  if (s.includes("claude")) return "claude-code";
  if (s.includes("gemini")) return "gemini";
  if (s.includes("grok")) return "grok";
  return undefined;
}

/**
 * Friendly surface tag for the SessionEntry.origin block — drives the label
 * the activity feed shows beside the orchestrator. Defaults to claude-code so
 * existing installs are unaffected when the MCP client doesn't self-identify.
 */
function inferSurfaceFromLabel(label: string | undefined): string {
  if (!label) return "claude-code";
  const s = label.toLowerCase();
  if (s.includes("opencode")) return "opencode";
  if (s.includes("codex")) return "codex";
  if (s.includes("cursor")) return "cursor";
  if (s.includes("desktop")) return "claude-desktop";
  if (s.includes("claude")) return "claude-code";
  return "mcp";
}

/**
 * One-line orchestrator-role marker dropped into the session transcript the
 * first time an MCP client touches a session. Two reasons it exists:
 *   1. `sessions.preview` reads from the transcript to populate the activity
 *      feed, so this surfaces the new session immediately as an orchestrator
 *      row instead of as an empty card.
 *   2. Any later agent loop the gateway spins up for this session reads the
 *      transcript on resume, so the role marker is visible to the model too —
 *      same effect as the voice-orchestrator preamble for the voice path.
 */
const ORCHESTRATOR_TRANSCRIPT_MARKER =
  "🎛 InfiniBot MCP orchestrator session. " + MCP_ORCHESTRATOR_LINES[1];

// Auto-register a SessionEntry the first time we see an MCP-originated call
// for a sessionKey that isn't in the store yet. Called from both agent.tools.list
// (so connection alone makes the client visible) and agent.tools.invoke (covers
// any client that skips the list call). Idempotent + race-safe.
//
// Returns true if a new entry was created (so the caller can fire a "session
// spawn" broadcast for the activity feed / isometric map); returns false if
// the session was already registered.
async function autoRegisterMcpSession(
  resolvedSession: string,
  sessionLabel: string | undefined,
): Promise<boolean> {
  try {
    const storePath = resolveDefaultSessionStorePath();
    const existing = loadSessionStore(storePath, { skipCache: true })[resolvedSession];
    if (existing) return false;
    let created = false;
    const coderBackend = inferCoderBackendFromLabel(sessionLabel);
    const surface = inferSurfaceFromLabel(sessionLabel);
    await updateSessionStore(storePath, (store) => {
      if (store[resolvedSession]) return; // race-safe re-check
      const baseLabel = sessionLabel || `MCP · ${resolvedSession.slice(-12)}`;
      const label = baseLabel;
      // 🎛 prefix flags the row as an orchestrator in the activity feed so a
      // human scanning the list can spot 3rd-party AI sessions at a glance,
      // independent of the visual badge the isometric map renders separately.
      const displayName = baseLabel.startsWith("🎛") ? baseLabel : `🎛 ${baseLabel}`;
      store[resolvedSession] = mergeSessionEntry(undefined, {
        updatedAt: Date.now(),
        label,
        displayName,
        channel: "mcp",
        coderBackend,
        origin: {
          label: "InfiniBot MCP",
          provider: "mcp",
          surface,
        },
      });
      created = true;
    });
    if (created) {
      // Seed the transcript so sessions.preview returns an orchestrator marker
      // immediately and so any future in-process agent run for this session
      // inherits the role context (same effect as the voice-orchestrator
      // preamble for the voice/grid live-action paths).
      try {
        await appendAssistantMessageToSessionTranscript({
          sessionKey: resolvedSession,
          text: ORCHESTRATOR_TRANSCRIPT_MARKER,
        });
      } catch {
        /* non-fatal — broadcast still informs live listeners */
      }
    }
    return created;
  } catch (e) {
    logWarn(
      `agent-tools: failed to auto-register MCP session (${resolvedSession}): ${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
}

export const agentToolsHandlers: GatewayRequestHandlers = {
  "agent.tools.list": async ({ params, respond, context }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const sessionKey = typeof p.sessionKey === "string" ? p.sessionKey : undefined;
      const sessionLabel = typeof p.sessionLabel === "string" ? p.sessionLabel : undefined;
      const messageChannel = typeof p.messageChannel === "string" ? p.messageChannel : undefined;
      const accountId = typeof p.accountId === "string" ? p.accountId : undefined;
      const source = typeof p.source === "string" ? p.source : undefined;
      const { tools, sessionKey: resolved } = buildTools({
        sessionKeyRaw: sessionKey,
        messageChannel,
        accountId,
      });
      const out = tools.map((t) => ({
        name: t.name,
        description: t.description ?? t.label ?? t.name,
        inputSchema: (toJsonSerializable(t.parameters) as Record<string, unknown>) ?? {
          type: "object",
          properties: {},
        },
      }));
      if (source === "mcp") {
        const created = await autoRegisterMcpSession(resolved, sessionLabel);
        if (created) {
          // Connection-time broadcast: agent.tools.list is the first call most
          // MCP clients make, so this is usually the moment the third-party AI
          // becomes visible on the isometric map.
          try {
            (context as { broadcast?: (channel: string, payload: unknown) => void }).broadcast?.(
              "agent",
              {
                runId: resolved,
                sessionKey: resolved,
                source: "mcp",
                stream: "session",
                ts: Date.now(),
                seq: 0,
                data: {
                  phase: "spawn",
                  role: "orchestrator",
                  origin: "mcp",
                  surface: inferSurfaceFromLabel(sessionLabel),
                  coderBackend: inferCoderBackendFromLabel(sessionLabel),
                  label: sessionLabel || `MCP · ${resolved.slice(-12)}`,
                },
              },
            );
          } catch {
            /* non-fatal */
          }
        }
      }
      respond(true, { tools: out, sessionKey: resolved });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "agent.tools.invoke": async ({ params, respond, context }) => {
    const p = (params ?? {}) as Record<string, unknown>;
    const toolName = typeof p.tool === "string" ? p.tool.trim() : "";
    if (!toolName) {
      respond(false, undefined, { code: "BAD_REQUEST", message: "tool name required" });
      return;
    }
    const args = (
      p.args && typeof p.args === "object" && !Array.isArray(p.args)
        ? (p.args as Record<string, unknown>)
        : {}
    ) as Record<string, unknown>;
    const action = typeof p.action === "string" ? p.action.trim() : undefined;
    const sessionKey = typeof p.sessionKey === "string" ? p.sessionKey : undefined;
    const sessionLabel = typeof p.sessionLabel === "string" ? p.sessionLabel : undefined;
    const messageChannel = typeof p.messageChannel === "string" ? p.messageChannel : undefined;
    const accountId = typeof p.accountId === "string" ? p.accountId : undefined;
    const providedRunId = typeof p.runId === "string" ? p.runId : undefined;
    const source = typeof p.source === "string" ? p.source : "mcp";

    const { tools, sessionKey: resolvedSession } = buildTools({
      sessionKeyRaw: sessionKey,
      messageChannel,
      accountId,
    });
    const tool = tools.find((t) => t.name === toolName);
    if (!tool || typeof tool.execute !== "function") {
      respond(false, undefined, {
        code: "NOT_FOUND",
        message: `Tool not available: ${toolName}`,
      });
      return;
    }

    // Fold `action` into args when the tool schema supports it — matches the
    // /tools/invoke HTTP endpoint behavior.
    const schema =
      (tool.parameters as { properties?: Record<string, unknown> } | undefined) ?? null;
    const toolArgs =
      action && schema?.properties && "action" in schema.properties && args.action === undefined
        ? { ...args, action }
        : args;

    const runId = providedRunId || randomUUID();
    const toolCallId = `${source}-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const startTs = Date.now();

    const basePayload = {
      runId,
      sessionKey: resolvedSession,
      source,
    };

    if (source === "mcp") {
      const created = await autoRegisterMcpSession(resolvedSession, sessionLabel);
      if (created) {
        try {
          context.broadcast("agent", {
            ...basePayload,
            stream: "session",
            ts: startTs,
            seq: 0,
            data: {
              phase: "spawn",
              role: "orchestrator",
              origin: "mcp",
              surface: inferSurfaceFromLabel(sessionLabel),
              coderBackend: inferCoderBackendFromLabel(sessionLabel),
              label: sessionLabel || `MCP · ${resolvedSession.slice(-12)}`,
            },
          });
        } catch {
          /* non-fatal */
        }
      }
    }

    try {
      context.broadcast("agent", {
        ...basePayload,
        stream: "tool",
        ts: startTs,
        seq: 0,
        data: {
          toolCallId,
          name: toolName,
          arguments: toolArgs,
          phase: "start",
        },
      });
    } catch {
      /* non-fatal */
    }

    let result: unknown = null;
    let errorMessage: string | null = null;
    try {
      result = await tool.execute!(toolCallId, toolArgs);
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
    }
    // In-flight operator inbox (universal fallback): when the caller is a CLI
    // coder sub-agent, append any queued operator messages to this tool result
    // so every backend — including Codex/Gemini, which have no in-CLI hook —
    // sees them at its next infinibot MCP call. No-op for everyone else.
    if (!errorMessage && source === "mcp") {
      result = piggybackInboxOnToolResult(resolvedSession, result);
    }
    const endTs = Date.now();

    try {
      context.broadcast("agent", {
        ...basePayload,
        stream: "tool",
        ts: endTs,
        seq: 1,
        data: {
          toolCallId,
          name: toolName,
          phase: "end",
          durationMs: endTs - startTs,
          result: errorMessage ? undefined : toJsonSerializable(result),
          error: errorMessage ?? undefined,
        },
      });
    } catch {
      /* non-fatal */
    }

    // Mirror MCP-originated tool calls into the session transcript so the
    // activity feed (sessions.preview) surfaces them as live items. Only
    // mirror for `source === "mcp"` because in-process agent runs already
    // write their own transcript via the agent loop — duplicating would
    // double-count tokens / preview lines.
    if (source === "mcp") {
      try {
        const argsSummary = summarizeToolArgs(toolArgs);
        const summary = errorMessage
          ? `🛠 ${toolName}${argsSummary ? ` ${argsSummary}` : ""} — error: ${errorMessage}`
          : `🛠 ${toolName}${argsSummary ? ` ${argsSummary}` : ""} (${endTs - startTs}ms)`;
        await appendAssistantMessageToSessionTranscript({
          sessionKey: resolvedSession,
          text: summary,
        });
      } catch (e) {
        // Non-fatal — the broadcast above already informed live listeners.
        // Likely cause: SessionEntry doesn't exist yet (session was never
        // registered). Logged at warn so it's discoverable but not noisy.
        const msg = e instanceof Error ? e.message : String(e);
        logWarn(
          `agent-tools: failed to mirror MCP tool call into transcript (sessionKey=${resolvedSession}, tool=${toolName}): ${msg}`,
        );
      }
    }

    if (errorMessage) {
      respond(false, undefined, { code: "TOOL_ERROR", message: errorMessage });
      return;
    }

    respond(true, {
      ok: true,
      toolCallId,
      runId,
      sessionKey: resolvedSession,
      result: toJsonSerializable(result),
    });
  },
};
