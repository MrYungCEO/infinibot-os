import { describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async (p: Record<string, unknown>) => ({ ok: true, echoed: p }));
vi.mock("../../gateway/server-methods/ui-control.js", () => ({
  invokeUIControlAction: (p: Record<string, unknown>) => invoke(p),
}));

const { createUIControlTool } = await import("./ui-control-tool.js");

describe("ui_control tool — guide actions", () => {
  it("advertises navigate/highlight/guide/clear_highlight/find_targets in its schema", () => {
    const tool = createUIControlTool();
    const actions = JSON.stringify(
      (tool.parameters as { properties: { action: unknown } }).properties.action,
    );
    for (const a of [
      "navigate",
      "highlight",
      "guide",
      "clear_highlight",
      "back",
      "open_panel",
      "open_modal",
      "find_targets",
      "list_targets",
    ]) {
      expect(actions).toContain(`"${a}"`);
    }
    expect(tool.description).toContain("control:solatrix/agent-access/mode");
  });

  it("passes the agent's own session key (and ignores a spoofed one)", async () => {
    const tool = createUIControlTool({ agentSessionKey: "agent:main:main" });
    await tool.execute!(
      "t1",
      { action: "highlight", target: "page:apikeys", sessionKey: "agent:evil:x" } as never,
      undefined as never,
      undefined as never,
    );
    expect(invoke).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "highlight",
        target: "page:apikeys",
        sessionKey: "agent:main:main",
      }),
    );
  });

  it("clear_highlight clears the overlay-card highlight AND the live element highlight", async () => {
    const tool = createUIControlTool({ agentSessionKey: "agent:main:main" });
    const res = (await tool.execute!(
      "t2",
      { action: "clear_highlight" } as never,
      undefined as never,
      undefined as never,
    )) as { details?: Record<string, unknown> };
    expect(invoke).toHaveBeenLastCalledWith(expect.objectContaining({ action: "clear_highlight" }));
    expect(JSON.stringify(res)).toContain("overlayCleared");
  });
});
