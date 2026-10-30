/**
 * MCP exposure follows main's tool policy: external MCP clients list tools via
 * agent.tools.list, which resolves to the main session and filters the full
 * registry (core + plugin tools) through agents.list[main].tools.allow.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { InfinibotConfig } from "../../config/config.js";
import { FLYPIC_TOOLS, seedStandardAgents } from "../../agents/standard-roster.js";

let config: InfinibotConfig = {} as InfinibotConfig;
const WHITEBOARD_TOOLS = ["excalidraw_get_scene", "excalidraw_create_element"] as const;
const PLUGIN_TOOLS = new Set<string>([...FLYPIC_TOOLS, ...WHITEBOARD_TOOLS]);
const fakeTool = (name: string) => ({
  name,
  description: name,
  parameters: { type: "object", properties: {} },
  execute: async () => ({}),
});

vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  loadConfig: () => config,
}));
vi.mock("../../agents/infinibot-tools.js", () => ({
  createInfiniBotTools: () =>
    [
      "kanban",
      "show_panel",
      "ui_control",
      "exec_shell_unlisted",
      ...FLYPIC_TOOLS,
      ...WHITEBOARD_TOOLS,
    ].map(fakeTool),
}));
vi.mock("../../plugins/tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/tools.js")>()),
  getPluginToolMeta: (tool: { name: string }) =>
    PLUGIN_TOOLS.has(tool.name)
      ? {
          pluginId: WHITEBOARD_TOOLS.includes(tool.name as (typeof WHITEBOARD_TOOLS)[number])
            ? "whiteboard"
            : "flypic",
          optional: false,
        }
      : undefined,
}));

import { agentToolsHandlers } from "./agent-tools.js";

async function listTools(): Promise<string[]> {
  return await new Promise((resolve, reject) => {
    void agentToolsHandlers["agent.tools.list"]!({
      params: {},
      respond: (ok: boolean, payload?: unknown, error?: { message: string }) =>
        ok
          ? resolve(
              ((payload as { tools: Array<{ name: string }> }).tools ?? []).map((t) => t.name),
            )
          : reject(new Error(error?.message)),
      context: {},
    } as never);
  });
}

describe("agent.tools.list (MCP) follows main's allowlist", () => {
  beforeEach(() => {
    config = {} as InfinibotConfig;
  });

  it("exposes the FlyPic tools once main's roster allows them", async () => {
    config = seedStandardAgents({} as InfinibotConfig);
    const names = await listTools();
    expect(names).toEqual(expect.arrayContaining([...FLYPIC_TOOLS, "kanban", "show_panel"]));
    expect(names).not.toContain("exec_shell_unlisted");
  });

  it("drops them when main's allowlist does not name them", async () => {
    config = {
      agents: { list: [{ id: "main", default: true, tools: { allow: ["kanban", "show_panel"] } }] },
    } as unknown as InfinibotConfig;
    const names = await listTools();
    expect(names).toEqual(expect.arrayContaining(["kanban", "show_panel"]));
    for (const t of FLYPIC_TOOLS) expect(names).not.toContain(t);
  });

  it("expands main's whiteboard plugin allow entry to excalidraw tools", async () => {
    config = seedStandardAgents({} as InfinibotConfig);
    const names = await listTools();
    expect(names).toEqual(expect.arrayContaining(["ui_control", ...WHITEBOARD_TOOLS]));
  });
});
