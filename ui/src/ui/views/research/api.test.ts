import { describe, expect, it } from "vitest";
import { finalAssistantText, messageText, toMs, toolPayload } from "./api";

describe("api helpers", () => {
  it("reads epoch ms from numbers, numeric strings (research frontmatter) and dates", () => {
    expect(toMs(1791892145373)).toBe(1791892145373);
    expect(toMs("1791892145373")).toBe(1791892145373);
    expect(toMs("2026-10-13T00:00:00Z")).toBe(Date.parse("2026-10-13T00:00:00Z"));
    expect(toMs("")).toBeUndefined();
    expect(toMs(undefined)).toBeUndefined();
  });
  it("unwraps agent.tools.invoke results (details first, then JSON text)", () => {
    expect(toolPayload({ result: { details: { status: "ok", n: 1 } } })).toEqual({ status: "ok", n: 1 });
    expect(toolPayload({ result: { content: [{ type: "text", text: '{"id":"rpt_1"}' }] } })).toEqual({ id: "rpt_1" });
    expect(toolPayload({ result: { content: [{ type: "text", text: "plain" }] } })).toEqual({ text: "plain" });
  });
  it("extracts chat message text from strings and content blocks", () => {
    expect(messageText({ content: "hi" })).toBe("hi");
    expect(messageText({ content: [{ type: "text", text: "a" }, { type: "tool_use" }, { type: "text", text: "b" }] })).toBe("a\nb");
    expect(messageText(null)).toBe("");
  });
});

describe("finalAssistantText", () => {
  const user = { role: "user", content: [{ type: "text", text: "q" }] };
  const calling = { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "I'll search" }, { type: "toolCall" }] };
  const tool = { role: "toolResult", content: [{ type: "text", text: "{}" }] };
  const done = { role: "assistant", stopReason: "stop", content: [{ type: "thinking" }, { type: "text", text: "# Answer" }] };
  it("returns the answer only when the newest message is a finished assistant turn", () => {
    expect(finalAssistantText([user, calling, tool, done])).toBe("# Answer");
    expect(finalAssistantText([user, calling, tool])).toBeNull(); // still working
    expect(finalAssistantText([user, calling])).toBeNull();
    expect(finalAssistantText([user])).toBeNull();
    expect(finalAssistantText([])).toBeNull();
  });
});
