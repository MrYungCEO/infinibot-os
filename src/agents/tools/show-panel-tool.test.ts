import { beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayTool = vi.fn();
vi.mock("../../logging/subsystem.js", () => {
  const l = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => l };
  return { createSubsystemLogger: () => l };
});
let failNext: Error | null = null;
vi.mock("./gateway.js", () => ({
  callGatewayTool: async (...a: unknown[]) => {
    if (failNext) {
      const e = failNext;
      failNext = null;
      throw e;
    }
    return callGatewayTool(...a);
  },
}));

import { createShowPanelTool, isUiChannel } from "./show-panel-tool.js";

function parse(res: { content: Array<{ text?: string }> }) {
  return JSON.parse(res.content[0].text ?? "{}") as Record<string, unknown>;
}

const REF = {
  v: 1,
  panelId: "p1",
  kind: "project",
  query: { id: "x" },
  title: "X",
  display: "inline",
};

describe("show_panel tool", () => {
  beforeEach(() => callGatewayTool.mockReset());

  it("rejects unknown kinds without calling the gateway", async () => {
    const tool = createShowPanelTool();
    const out = parse(await tool.execute("c1", { kind: "weather" }));
    expect(out.ok).toBe(false);
    expect(out.validKinds).toContain("mesh");
    expect(callGatewayTool).not.toHaveBeenCalled();
  });

  it("calls chat.panel.show, maps id shorthand, puts the panel ref FIRST", async () => {
    callGatewayTool.mockResolvedValue({
      title: "X",
      summary: "X · 50%",
      count: 4,
      text: "**X**",
      ref: REF,
    });
    const tool = createShowPanelTool({ agentSessionKey: "agent:main:main" });
    const res = await tool.execute("c1", { kind: "project", id: "x", display: "modal" });
    expect(callGatewayTool).toHaveBeenCalledWith(
      "chat.panel.show",
      expect.anything(),
      expect.objectContaining({
        kind: "project",
        query: { id: "x" },
        display: "modal",
        sourceSession: "agent:main:main",
      }),
    );
    const text = res.content[0].text as string;
    expect(text.indexOf('"chatPanel"')).toBeLessThan(text.indexOf('"summary"'));
    const out = parse(res);
    expect(out.ok).toBe(true);
    expect(out.text).toBe("**X**");
  });

  it("non-UI channel: no ref, never pops a modal, tells the model to reply with text", async () => {
    callGatewayTool.mockResolvedValue({ summary: "s", text: "| a |", ref: REF });
    const tool = createShowPanelTool({ agentChannel: "telegram" as never });
    const out = parse(await tool.execute("c1", { kind: "business", display: "modal" }));
    expect(callGatewayTool.mock.calls[0][2]).toMatchObject({ display: "inline" });
    expect(out.chatPanel).toBeUndefined();
    expect(out.shown).toBe(false);
    expect(out.text).toBe("| a |");
    expect(String(out.note)).toMatch(/reply with `text`/);
  });

  it("relays a resolver error honestly (keeps the ref so the UI shows the error card)", async () => {
    callGatewayTool.mockResolvedValue({
      error: 'No project matches "zz"',
      summary: "Could not load",
      ref: REF,
    });
    const out = parse(await createShowPanelTool().execute("c1", { kind: "project", id: "zz" }));
    expect(out.ok).toBe(false);
    expect(out.error).toContain("zz");
    expect(out.chatPanel).toBeTruthy();
  });

  it("gateway unreachable → ok:false, no throw", async () => {
    // Plain function (not a vi.fn impl): vitest 4's spy settled-result
    // tracking reports a rejected mock promise as unhandled.
    failNext = new Error("ECONNREFUSED");
    const out = parse(await createShowPanelTool().execute("c1", { kind: "mesh" }));
    expect(out.ok).toBe(false);
    expect(out.error).toBe("ECONNREFUSED");
  });

  it("isUiChannel", () => {
    expect(isUiChannel(undefined)).toBe(true);
    expect(isUiChannel("webchat")).toBe(true);
    expect(isUiChannel("telegram")).toBe(false);
  });
});
