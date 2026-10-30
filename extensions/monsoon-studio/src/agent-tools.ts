import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "../../../src/agents/tools/common.js";
import { STUDIO_TOOLS, type StudioClient } from "./client.js";

/** Large render/project payloads are trimmed so a single tool result can't flood the context window. */
const MAX_RESULT_CHARS = 60_000;

export function createAgentTools(client: StudioClient): AnyAgentTool[] {
  return STUDIO_TOOLS.map((tool) => ({
    label: `Product Studio: ${tool.name.replace(/^studio_/, "").replace(/_/g, " ")}`,
    name: tool.name,
    description: `${tool.description} (Monsoon Product Studio; open the Product Studio page to see the result.)`,
    parameters: Type.Unsafe(tool.inputSchema),
    execute: async (_toolCallId, args) => {
      const result = await client.call(tool.name, (args ?? {}) as Record<string, unknown>);
      const json = JSON.stringify(result, null, 2) ?? "null";
      const text = json.length > MAX_RESULT_CHARS ? `${json.slice(0, MAX_RESULT_CHARS)}\n… (truncated ${json.length - MAX_RESULT_CHARS} chars; call studio_load_project for the full graph)` : json;
      return { content: [{ type: "text" as const, text }], details: { tool: tool.name } };
    },
  }));
}
