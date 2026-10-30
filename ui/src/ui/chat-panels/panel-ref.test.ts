import { describe, expect, it } from "vitest";

import { extractPanelRef, extractPanelRefsFromMessage } from "./panel-ref";

const REF = {
  v: 1,
  panelId: "panel_1",
  kind: "project",
  query: { name: "Robovoice" },
  title: "Robovoice",
  display: "inline",
  summary: "Robovoice · 50%",
  count: 4,
  empty: false,
  error: null,
  link: { tab: "projects", path: "/projects/p1", label: "Open project" },
  refreshMs: 15000,
  ts: 1,
};

/** Exactly what the show_panel tool returns (jsonResult → pretty JSON text). */
const TOOL_TEXT = JSON.stringify({ chatPanel: REF, ok: true, summary: "x", text: "| long |".repeat(400) }, null, 2);

describe("extractPanelRef", () => {
  it("parses the show_panel tool result text", () => {
    expect(extractPanelRef(TOOL_TEXT)).toMatchObject({ kind: "project", panelId: "panel_1", query: { name: "Robovoice" } });
  });

  it("survives surfaces that truncate long tool output", () => {
    const truncated = `${TOOL_TEXT.slice(0, 900)}\n… (truncated)`;
    expect(extractPanelRef(truncated)?.kind).toBe("project");
  });

  it("accepts a parsed object (tool `details` or a broadcast payload)", () => {
    expect(extractPanelRef({ chatPanel: REF })?.panelId).toBe("panel_1");
    expect(extractPanelRef(REF)?.panelId).toBe("panel_1");
  });

  it("ignores ordinary tool output and malformed refs", () => {
    expect(extractPanelRef("done")).toBeNull();
    expect(extractPanelRef('{"ok":true}')).toBeNull();
    expect(extractPanelRef(JSON.stringify({ chatPanel: { v: 2, kind: "x" } }))).toBeNull();
    expect(extractPanelRef(JSON.stringify({ chatPanel: { v: 1 } }))).toBeNull();
    expect(extractPanelRef(undefined)).toBeNull();
  });

  it("normalises missing fields", () => {
    const r = extractPanelRef({ chatPanel: { v: 1, kind: "mesh" } });
    expect(r).toMatchObject({ kind: "mesh", title: "mesh", display: "inline", query: {}, error: null });
  });
});

describe("extractPanelRefsFromMessage", () => {
  it("toolResult message with text content blocks", () => {
    const msg = { role: "toolResult", toolCallId: "c1", toolName: "show_panel", content: [{ type: "text", text: TOOL_TEXT }] };
    expect(extractPanelRefsFromMessage(msg)).toHaveLength(1);
  });

  it("toolResult message with details only (deduped against content)", () => {
    const msg = { role: "toolResult", toolCallId: "c1", details: { chatPanel: REF }, content: [{ type: "text", text: TOOL_TEXT }] };
    expect(extractPanelRefsFromMessage(msg)).toHaveLength(1);
  });

  it("Anthropic-style tool_result blocks inside a user message", () => {
    const msg = {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "c1", content: [{ type: "text", text: TOOL_TEXT }] }],
    };
    expect(extractPanelRefsFromMessage(msg)[0]?.kind).toBe("project");
  });

  it("does not treat assistant prose mentioning chatPanel as a panel", () => {
    const msg = { role: "assistant", content: [{ type: "text", text: TOOL_TEXT }] };
    expect(extractPanelRefsFromMessage(msg)).toHaveLength(0);
  });
});
