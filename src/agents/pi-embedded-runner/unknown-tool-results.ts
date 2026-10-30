/**
 * When the model calls a tool it doesn't have, pi-agent-core answers with a
 * bare "Tool write_file not found" error result. Models then retry the same
 * imaginary tool or claim they did the work. Rewrite that result (in the
 * context sent to the model — the transcript keeps the original) into a clear
 * "that action isn't available here" plus the tools it can actually use.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";

import { humanizeUnknownTool, parseUnknownToolError } from "../provider-error-messages.js";

type TextPart = { type: "text"; text: string };

export function rewriteUnknownToolResults(
  messages: AgentMessage[],
  availableToolNames: () => string[],
): AgentMessage[] {
  let names: string[] | undefined;
  let changed = false;
  const out = messages.map((msg) => {
    const m = msg as { role?: string; isError?: boolean; content?: unknown };
    if (m.role !== "toolResult" || !m.isError || !Array.isArray(m.content)) return msg;
    const first = m.content[0] as TextPart | undefined;
    if (m.content.length !== 1 || first?.type !== "text") return msg;
    const toolName = parseUnknownToolError(first.text);
    if (!toolName) return msg;
    names ??= availableToolNames();
    const h = humanizeUnknownTool(toolName, names);
    changed = true;
    return {
      ...msg,
      content: [
        {
          type: "text",
          text: `${h.message} The tool "${toolName}" does not exist in this session — do not call it again and do not claim its effect happened. ${h.resolution}`,
        },
      ],
    } as AgentMessage;
  });
  return changed ? out : messages;
}

/** Wrap an Agent's transformContext with the unknown-tool rewrite. */
export function installUnknownToolRewrite(agent: {
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  state: { tools?: Array<{ name: string }> };
}): void {
  const prior = agent.transformContext;
  agent.transformContext = async (messages, signal) => {
    const base = prior ? await prior(messages, signal) : messages;
    return rewriteUnknownToolResults(base, () => (agent.state.tools ?? []).map((t) => t.name));
  };
}
