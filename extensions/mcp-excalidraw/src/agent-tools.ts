import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "../../../src/agents/tools/common.js";
import { TOOLS } from "./tools.js";

export function createAgentTools(): AnyAgentTool[] {
  return TOOLS.map((tool) => ({
    label: `Whiteboard: ${tool.name.replace(/_/g, " ")}`,
    name: `excalidraw_${tool.name}`,
    description: tool.description,
    parameters: Type.Unsafe(tool.inputSchema),
    execute: async (_toolCallId, args) => {
      const result = tool.handler((args ?? {}) as Record<string, unknown>) as { content: Array<{ type: "text"; text: string }> };
      return { content: result.content, details: {} };
    },
  }));
}
