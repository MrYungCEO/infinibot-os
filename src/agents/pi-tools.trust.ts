/**
 * Origin-aware tool hardening, applied once per turn after the regular
 * profile / allow / deny filtering in createInfiniBotCodingTools.
 *
 * Trust comes from src/routing/sender-trust.ts. Operator and owner turns keep
 * today's behavior; untrusted turns lose the dangerous defaults:
 *
 * | tool                   | untrusted-content (hooks) | untrusted-sender (non-owner) |
 * |------------------------|---------------------------|------------------------------|
 * | claude/opencode/codex  | autoApprove forced off    | removed by default profile   |
 * | exec (no sandbox)      | deny / ask (exec tool)    | removed by default profile   |
 * | gateway config writes  | refused                   | removed by default profile   |
 * | everything else        | unchanged                 | `tools.trust.untrustedTools` |
 *
 * web_fetch / web_search / web-reach tool output is wrapped with the untrusted-content markers
 * on every turn, owner included — a web page is never the operator.
 */

import type { InfinibotConfig } from "../config/config.js";
import type { TurnTrust } from "../routing/sender-trust.js";
import { isWrappedExternalContent, wrapExternalContent } from "../security/external-content.js";
import { resolveCoderAutoApprovePolicy } from "./coder-backend/approval-policy.js";
import { filterToolsByPolicy } from "./pi-tools.policy.js";
import type { AnyAgentTool } from "./pi-tools.types.js";
import type { SandboxToolPolicy } from "./sandbox.js";
import { normalizeToolName } from "./tool-policy.js";

/**
 * Default tool set for non-owner channel senders. Plain replies need no tools
 * (the reply pipeline delivers them), so this only adds web lookups. Left out
 * on purpose: host/file tools, sessions_* (sessions_send / sessions_spawn would
 * hand the request to a trusted session), memory (the owner's other
 * conversations), `message` (sending as the owner to arbitrary contacts),
 * `image` (reads local paths), config and coder tools. Widen via
 * tools.trust.untrustedTools.
 */
export const DEFAULT_UNTRUSTED_SENDER_TOOLS: SandboxToolPolicy = {
  allow: ["session_status", "web_search", "web_fetch", "web_read", "web_image_search", "rss_read"],
  deny: [],
};

const CODER_TOOL_NAMES = new Set([
  "claude_coder",
  "opencode_coder",
  "codex_coder",
  "grok_coder",
  "queue_run",
]);
const WEB_CONTENT_TOOL_NAMES = new Set([
  "web_fetch",
  "web_search",
  "web_read",
  "web_image_search",
  "youtube_transcript",
  "github_read",
  "rss_read",
]);
const GATEWAY_MUTATING_ACTIONS = new Set(["config.apply", "config.patch", "update.run", "restart"]);

export function resolveUntrustedSenderToolPolicy(cfg?: InfinibotConfig): SandboxToolPolicy {
  const configured = cfg?.tools?.trust?.untrustedTools;
  if (!configured || (!configured.allow && !configured.deny)) return DEFAULT_UNTRUSTED_SENDER_TOOLS;
  return {
    allow: Array.isArray(configured.allow)
      ? configured.allow
      : DEFAULT_UNTRUSTED_SENDER_TOOLS.allow,
    deny: Array.isArray(configured.deny) ? configured.deny : [],
  };
}

type ExecuteFn = (...args: unknown[]) => Promise<unknown>;

function wrapExecute(
  tool: AnyAgentTool,
  wrap: (orig: ExecuteFn, toolCallId: unknown, args: unknown, rest: unknown[]) => Promise<unknown>,
): AnyAgentTool {
  const orig = (tool as { execute?: ExecuteFn }).execute;
  if (typeof orig !== "function") return tool;
  return {
    ...tool,
    execute: ((toolCallId: unknown, args: unknown, ...rest: unknown[]) =>
      wrap(orig.bind(tool), toolCallId, args, rest)) as AnyAgentTool["execute"],
  };
}

function wrapResultText(result: unknown, wrapText: (text: string) => string): unknown {
  if (!result || typeof result !== "object") return result;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return result;
  return {
    ...(result as object),
    content: content.map((item) => {
      if (
        item &&
        typeof item === "object" &&
        (item as { type?: unknown }).type === "text" &&
        typeof (item as { text?: unknown }).text === "string"
      ) {
        const text = (item as { text: string }).text;
        return isWrappedExternalContent(text) ? item : { ...item, text: wrapText(text) };
      }
      return item;
    }),
  };
}

/** Wrap a tool so every text result is marked as untrusted external content. */
export function wrapToolResultAsExternal(
  tool: AnyAgentTool,
  source: Parameters<typeof wrapExternalContent>[1]["source"],
): AnyAgentTool {
  return wrapExecute(tool, async (orig, toolCallId, args, rest) => {
    const result = await orig(toolCallId, args, ...rest);
    const a = (args ?? {}) as { url?: unknown; query?: unknown };
    const sender =
      typeof a.url === "string" ? a.url : typeof a.query === "string" ? `search: ${a.query}` : "";
    return wrapResultText(result, (text) =>
      wrapExternalContent(text, { source, sender: sender || undefined, includeWarning: false }),
    );
  });
}

export function applyTurnTrustToTools(params: {
  tools: AnyAgentTool[];
  trust: TurnTrust;
  config?: InfinibotConfig;
}): AnyAgentTool[] {
  const { trust, config } = params;
  let tools = params.tools;

  if (trust.level === "untrusted-sender") {
    tools = filterToolsByPolicy(tools, resolveUntrustedSenderToolPolicy(config));
  }

  const coderPolicy = resolveCoderAutoApprovePolicy(config);
  return tools.map((tool) => {
    const name = normalizeToolName(tool.name ?? "");

    if (WEB_CONTENT_TOOL_NAMES.has(name)) {
      return wrapToolResultAsExternal(tool, "web");
    }
    if (trust.trusted) return tool;

    if (CODER_TOOL_NAMES.has(name) && coderPolicy !== "always") {
      return wrapExecute(tool, (orig, toolCallId, args, rest) =>
        orig(toolCallId, { ...(args as object), autoApprove: false }, ...rest),
      );
    }
    if (name === "gateway") {
      return wrapExecute(tool, async (orig, toolCallId, args, rest) => {
        const action = (args as { action?: unknown } | null)?.action;
        if (typeof action === "string" && GATEWAY_MUTATING_ACTIONS.has(action)) {
          throw new Error(
            `gateway ${action} refused: this turn is untrusted (${trust.reason}). Only the operator can change or restart the gateway.`,
          );
        }
        return orig(toolCallId, args, ...rest);
      });
    }
    return tool;
  });
}
