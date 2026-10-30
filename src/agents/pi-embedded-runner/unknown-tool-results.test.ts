import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";

import { installUnknownToolRewrite, rewriteUnknownToolResults } from "./unknown-tool-results.js";

const unknown = {
  role: "toolResult",
  toolCallId: "c1",
  toolName: "write_file",
  content: [{ type: "text", text: "Tool write_file not found" }],
  isError: true,
  timestamp: 1,
} as unknown as AgentMessage;

describe("unknown tool results", () => {
  it("rewrites 'Tool x not found' into an availability message", () => {
    const out = rewriteUnknownToolResults([unknown], () => ["read", "notes"]);
    const text = (out[0] as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toContain("That action (write_file) isn't available here.");
    expect(text).toContain("read, notes");
    expect(text).not.toContain("Tool write_file not found");
    // original transcript message untouched
    expect((unknown as { content: Array<{ text: string }> }).content[0].text).toBe(
      "Tool write_file not found",
    );
  });

  it("leaves other tool errors and messages alone", () => {
    const other = { ...unknown, content: [{ type: "text", text: "ENOENT: no such file" }] } as AgentMessage;
    const msgs = [other];
    expect(rewriteUnknownToolResults(msgs, () => [])).toBe(msgs);
  });

  it("chains onto an existing transformContext", async () => {
    const agent = {
      transformContext: async (m: AgentMessage[]) => m,
      state: { tools: [{ name: "exec" }] },
    };
    installUnknownToolRewrite(agent);
    const out = await agent.transformContext([unknown]);
    expect((out[0] as { content: Array<{ text: string }> }).content[0].text).toContain("exec");
  });
});
