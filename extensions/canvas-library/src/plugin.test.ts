import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { convertToCanvas, parseCanvasSource } from "../../../src/canvas-host/canvas-convert.js";
import { SavedCanvasStore } from "../../../src/canvas-host/saved-canvases.js";
import { parseManifestV2 } from "../../../src/plugins/manifest-v2.js";
import type { ReportRecord } from "../../../src/reports/types.js";
import register from "../index.js";
import { EXAMPLE_CANVASES } from "./examples.js";
import { CHANGED_EVENT, createCanvasLibraryHandlers } from "./rpc.js";
import { createCanvasLibraryTool } from "./tool.js";

const manifest = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "infinibot.plugin.json"), "utf-8"),
) as Record<string, unknown>;

const PAYLOAD = {
  title: "t",
  nodes: [{ id: "a", kind: "text" as const, x: 0, y: 0, w: 400, h2: "A", body: "b" }],
  scenes: [{ id: "s1", focusNodeId: "a", narration: { ttsText: "hello" } }],
};

const REPORT = {
  id: "r1",
  title: "Q3 review",
  markdownBody: "# Q3 review\n\n## Revenue\n\n- 120 deals\n- 40% margin\n\n## Next\n\nShip it.",
  markdownPath: null,
  config: {},
} as unknown as ReportRecord;

let dir: string;
let store: SavedCanvasStore;
let broadcasts: Array<[string, unknown]>;

const runtime = () => ({
  store: async () => store,
  parseSource: async (raw: unknown) => parseCanvasSource(raw),
  convert: async (src: Parameters<typeof convertToCanvas>[0]) =>
    convertToCanvas(src, { getReport: (id) => (id === "r1" ? REPORT : null) }),
  bakeNarration: async (p: typeof PAYLOAD) => ({
    ...p,
    scenes: p.scenes.map((s) => ({ ...s, narration: { ...s.narration, audioUrl: `/a/${s.id}.mp3` } })),
  }),
  sharePath: (id: string) => `/canvas/${id}`,
});

async function call(method: string, params: Record<string, unknown> = {}) {
  const handlers = createCanvasLibraryHandlers(runtime() as never);
  let out: { ok: boolean; payload?: any; error?: any } = { ok: false };
  await handlers[method]!({
    req: {} as never,
    params,
    client: null,
    isWebchatConnect: () => false,
    respond: (ok, payload, error) => {
      out = { ok, payload, error };
    },
    context: { broadcast: (e: string, p: unknown) => broadcasts.push([e, p]) } as never,
  });
  return out;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "canvas-lib-"));
  store = new SavedCanvasStore(dir);
  broadcasts = [];
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("canvas-library manifest", () => {
  it("parses as v2 with a gated page, namespaced RPCs and a listing", () => {
    const res = parseManifestV2("canvas-library", manifest);
    expect(res.ok, res.ok ? "" : res.error).toBe(true);
    if (!res.ok) return;
    expect(res.fields.license).toBe("FSL-1.1-ALv2");
    expect(res.fields.appearance?.monogram).toBe("HC");
    expect(res.fields.contributes.pages).toEqual([
      expect.objectContaining({ tab: "canvas", route: "/canvas", builtin: "canvas-library" }),
    ]);
    for (const r of res.fields.contributes.rpc) expect(r.method.startsWith("canvas-library.")).toBe(true);
    expect(res.fields.contributes.tools).toEqual(["canvas_library"]);
    const listing = manifest.listing as { cover: string; screenshots: { src: string }[] };
    for (const f of [listing.cover, ...listing.screenshots.map((s) => s.src)]) {
      expect(readFileSync(join(import.meta.dirname, "..", f)).length).toBeGreaterThan(100);
    }
  });

  it("registers exactly the declared RPCs and tool", () => {
    const methods: string[] = [];
    const tools: string[] = [];
    register({
      registerGatewayMethod: (m: string) => methods.push(m),
      registerTool: (_f: unknown, o: { name: string }) => tools.push(o.name),
    } as never);
    const declared = (manifest.contributes as { rpc: { method: string }[] }).rpc.map((r) => r.method);
    expect(methods.sort()).toEqual([...declared].sort());
    expect(tools).toEqual(["canvas_library"]);
  });
});

describe("canvas-library RPCs", () => {
  it("starts empty — nothing is auto-seeded", async () => {
    const res = await call("canvas-library.list");
    expect(res.payload).toEqual({ entries: [], total: 0 });
  });

  it("save → list (without payload) → get → tags → delete", async () => {
    const saved = await call("canvas-library.save", { title: " Deck ", payload: PAYLOAD, tags: ["x", "x", "y"] });
    expect(saved.ok).toBe(true);
    const id = saved.payload.entry.id as string;
    expect(broadcasts).toEqual([[CHANGED_EVENT, { action: "saved", id }]]);

    const list = await call("canvas-library.list");
    expect(list.payload.total).toBe(1);
    expect(list.payload.entries[0]).toMatchObject({ id, title: "Deck", sceneCount: 1, nodeCount: 1, tags: ["x", "y"] });
    expect(list.payload.entries[0].payload).toBeUndefined();

    expect((await call("canvas-library.get", { id })).payload.entry.payload.nodes).toHaveLength(1);
    expect((await call("canvas-library.tags")).payload.tags).toEqual(["x", "y"]);
    expect((await call("canvas-library.delete", { id })).ok).toBe(true);
    expect((await call("canvas-library.get", { id })).error.code).toBe("NOT_FOUND");
  });

  it("validates input", async () => {
    expect((await call("canvas-library.save", { title: "t", payload: { nodes: [] } })).error.code).toBe("INVALID_PARAMS");
    expect((await call("canvas-library.get", {})).error.code).toBe("INVALID_PARAMS");
    expect((await call("canvas-library.fromSource", { source: "nope" })).error.code).toBe("INVALID_PARAMS");
    expect((await call("canvas-library.fromSource", { source: "report", reportId: "zz" })).error.code).toBe("NOT_FOUND");
  });

  it("tag filter works (json_each)", async () => {
    await call("canvas-library.save", { title: "a", payload: PAYLOAD, tags: ["work-review"] });
    await call("canvas-library.save", { title: "b", payload: PAYLOAD, tags: ["other"] });
    const res = await call("canvas-library.list", { tag: "work-review" });
    expect(res.payload.entries.map((e: { title: string }) => e.title)).toEqual(["a"]);
    expect(res.payload.total).toBe(1);
  });

  it("builds a canvas from a report and files it", async () => {
    const res = await call("canvas-library.fromSource", { source: "report", reportId: "r1", tags: ["q3"] });
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    expect(res.payload.mediaKind).toBe("report-walkthrough");
    expect(res.payload.entry.title).toBe("Q3 review");
    expect(res.payload.entry.tags).toEqual(["report", "q3"]);
    expect(res.payload.entry.payload.scenes.length).toBeGreaterThanOrEqual(2);
  });

  it("bakes narration into the payload and manifest", async () => {
    const id = (await call("canvas-library.save", { title: "n", payload: PAYLOAD })).payload.entry.id;
    const res = await call("canvas-library.bake", { id });
    expect(res.payload.manifest).toEqual({ s1: "/a/s1.mp3" });
    expect(store.get(id)?.bakedAudioManifest).toEqual({ s1: "/a/s1.mp3" });
  });

  it("loads the neutral examples once (idempotent)", async () => {
    const first = await call("canvas-library.examples.load");
    expect(first.payload.added).toHaveLength(EXAMPLE_CANVASES.length);
    const again = await call("canvas-library.examples.load");
    expect(again.payload).toEqual({ added: [], alreadyPresent: EXAMPLE_CANVASES.length });
    for (const ex of EXAMPLE_CANVASES) {
      expect(ex.tags).toContain("example");
      expect(JSON.stringify(ex.payload)).not.toMatch(/moat|10×|InfiniBot AI-OS/i);
    }
  });
});

describe("canvas_library tool", () => {
  const run = (args: Record<string, unknown>) =>
    createCanvasLibraryTool(runtime() as never).execute("c1", args as never) as Promise<{
      details: any;
    }>;

  it("saves, lists with share paths, builds from a report and markdown", async () => {
    const saved = (await run({ action: "save", title: "T", payload: PAYLOAD, tags: ["a"] })).details;
    expect(saved.sharePath).toBe(`/canvas/${saved.id}`);
    const fromReport = (await run({ action: "from_report", reportId: "r1" })).details;
    expect(fromReport.mediaKind).toBe("report-walkthrough");
    const fromMd = (await run({ action: "from_markdown", markdown: "# Plan\n\n## One\n\nx\n\n## Two\n\ny" })).details;
    expect(fromMd.title).toBe("Plan");
    const list = (await run({ action: "list" })).details;
    expect(list.total).toBe(3);
    expect((await run({ action: "get", id: saved.id })).details.payload.nodes).toHaveLength(1);
    expect((await run({ action: "delete", id: saved.id })).details.ok).toBe(true);
  });
});
