import { beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayMock = vi.fn();

vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

import { createInfinibotTerminalTool } from "./infinibot-terminal-tool.js";

describe("infinibot_terminal tool", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
  });

  it("spawns Codex through the MCP terminal tool with search enabled", async () => {
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "terminal.spawnAgent") {
        return { success: true, terminalId: "term-codex-1" };
      }
      return {};
    });

    const tool = createInfinibotTerminalTool();
    const result = await tool.execute("call-1", {
      action: "spawn-coder",
      cli: "codex",
      cwd: "/repo",
      task: "Find the latest AI news.",
      label: "AI news",
      search: true,
    });

    expect(result.details).toMatchObject({
      ok: true,
      terminalId: "term-codex-1",
      cli: "codex",
      cwd: "/repo",
    });
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    const call = callGatewayMock.mock.calls[0]?.[0] as {
      method?: string;
      params?: {
        cli?: string;
        task?: string;
        options?: { extraFlags?: string[] };
      };
    };
    expect(call.method).toBe("terminal.spawnAgent");
    expect(call.params).toMatchObject({
      cli: "codex",
      task: "Find the latest AI news.",
      options: { extraFlags: ["--search"] },
    });
  });

  it("rejects search for non-Codex terminal spawns", async () => {
    const tool = createInfinibotTerminalTool();
    const result = await tool.execute("call-2", {
      action: "spawn-coder",
      cli: "claude",
      task: "hello",
      search: true,
    });

    expect(result.details).toMatchObject({
      ok: false,
      error: "search=true is only supported for cli=codex",
    });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("schema enum for cli includes codex and ollama for spawn-coder", () => {
    const tool = createInfinibotTerminalTool();
    const schema = JSON.parse(JSON.stringify(tool.parameters));
    const cliProp = schema.properties?.cli;
    expect(cliProp).toBeDefined();
    const enumValues = cliProp.enum;
    expect(enumValues).toBeDefined();
    expect(enumValues).toContain("codex");
    expect(enumValues).toContain("ollama");
    expect(enumValues).toEqual(["claude", "opencode", "gemini", "codex", "ollama"]);
  });
});
