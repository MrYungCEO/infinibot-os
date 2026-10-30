/**
 * Plugin-contributed chat panel kinds through the core: resolver (per-result
 * refreshMs), the in-process caller (real reason from payload errors) and the
 * show_panel tool (accepts + advertises plugin kinds).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayTool = vi.fn();
vi.mock("../agents/tools/gateway.js", () => ({
  callGatewayTool: (...a: unknown[]) => callGatewayTool(...a),
}));

import { createShowPanelTool } from "../agents/tools/show-panel-tool.js";
import { localPanelCaller } from "../gateway/server-methods/chat-panel.js";
import type { PluginRegistry } from "../plugins/registry.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { allPanelKindDefs, describePanelKinds, isPanelKind, resolvePanel } from "./resolve.js";
import type { PanelKindDef } from "./types.js";

const JOB: PanelKindDef = {
  id: "demo.job",
  title: "Demo job",
  description: "A demo job card",
  queryHelp: "query: {jobId}",
  refreshMs: 3000,
  methods: ["demo.job.get"],
  async resolve(q, call) {
    const job = (await call("demo.job.get", { jobId: q.jobId })) as { done: boolean };
    return {
      data: job,
      summary: job.done ? "done" : "running",
      count: 1,
      empty: false,
      refreshMs: job.done ? 0 : undefined,
    };
  },
  toText: () => "job",
  link: () => ({ tab: "demo", label: "Open" }),
};

let previous: PluginRegistry | null = null;

beforeEach(() => {
  previous = getActivePluginRegistry();
  setActivePluginRegistry({
    panelKinds: [{ pluginId: "demo", def: JOB, source: "test" }],
    gatewayHandlers: {},
  } as unknown as PluginRegistry);
  callGatewayTool.mockReset();
});

afterEach(() => {
  if (previous) setActivePluginRegistry(previous);
});

describe("plugin panel kinds", () => {
  it("are known kinds and appear in the tool description", () => {
    expect(isPanelKind("demo.job")).toBe(true);
    expect(allPanelKindDefs().map((k) => k.id)).toContain("demo.job");
    expect(describePanelKinds()).toContain("demo.job — A demo job card");
  });

  it("a result may override refreshMs (0 stops polling once a job is finished)", async () => {
    const running = await resolvePanel("demo.job", { jobId: "1" }, async () => ({ done: false }));
    expect(running.refreshMs).toBe(3000);
    const done = await resolvePanel("demo.job", { jobId: "1" }, async () => ({ done: true }));
    expect(done.refreshMs).toBe(0);
  });

  it("the in-process caller keeps a plugin's real reason when it is in the payload", async () => {
    const call = localPanelCaller(
      {} as never,
      async () => ({
        "demo.job.get": ({ respond }) =>
          respond(false, { error: "FlyPic said no (request_id r1)" }),
      }),
      new Set(["demo.job.get"]),
    );
    await expect(call("demo.job.get", {})).rejects.toThrow("FlyPic said no (request_id r1)");
  });

  it("show_panel accepts a loaded plugin's kind and lists it in its schema", async () => {
    callGatewayTool.mockResolvedValue({
      title: "Demo job",
      summary: "running",
      count: 1,
      ref: { v: 1, panelId: "p", kind: "demo.job" },
    });
    const tool = createShowPanelTool();
    const kinds = (
      tool.parameters as {
        properties: { kind: { enum?: string[]; anyOf?: Array<{ const: string }> } };
      }
    ).properties.kind;
    const listed = kinds.enum ?? kinds.anyOf?.map((k) => k.const) ?? [];
    expect(listed).toContain("demo.job");
    const res = (await tool.execute("c1", { kind: "demo.job", query: { jobId: "1" } })) as {
      content: Array<{ text: string }>;
    };
    const out = JSON.parse(res.content[0]!.text) as Record<string, unknown>;
    expect(out).toMatchObject({ ok: true, kind: "demo.job" });
    expect(callGatewayTool).toHaveBeenCalledWith(
      "chat.panel.show",
      expect.anything(),
      expect.objectContaining({ kind: "demo.job" }),
    );
    const bad = JSON.parse(
      ((await tool.execute("c2", { kind: "other.kind" })) as { content: Array<{ text: string }> })
        .content[0]!.text,
    );
    expect(bad).toMatchObject({
      ok: false,
      validKinds: expect.arrayContaining(["mesh", "demo.job"]),
    });
  });
});
