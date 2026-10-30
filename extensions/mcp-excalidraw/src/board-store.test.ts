import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyPluginAutoEnable } from "../../../src/config/plugin-auto-enable.js";
import { WhiteboardStore } from "./board-store.js";

describe("WhiteboardStore", () => {
  it("copies legacy boards idempotently and preserves the source", async () => {
    const state = await mkdtemp(join(tmpdir(), "whiteboard-store-"));
    const legacy = join(state, "files", "whiteboards");
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, "roadmap.excalidraw"), JSON.stringify({ elements: [{ id: "old" }] }));
    const store = new WhiteboardStore(state);
    await store.initialize();
    await store.initialize();
    expect(await store.get("roadmap")).toEqual({ elements: [{ id: "old" }] });
    expect(JSON.parse(await readFile(join(legacy, "roadmap.excalidraw"), "utf8"))).toEqual({ elements: [{ id: "old" }] });
  });

  it("saves, renames and deletes boards under plugin-data", async () => {
    const state = await mkdtemp(join(tmpdir(), "whiteboard-store-"));
    const store = new WhiteboardStore(state);
    await store.save("first-board", { elements: [{ id: "one" }] });
    await store.rename("first-board", "renamed-board");
    expect((await store.list()).map((row) => row.id)).toEqual(["renamed-board"]);
    await store.remove("renamed-board");
    expect(await store.list()).toEqual([]);
  });

  it("preserves plugin data when Whiteboard is explicitly disabled", async () => {
    const state = await mkdtemp(join(tmpdir(), "whiteboard-store-disabled-"));
    const scene = {
      elements: [{ id: "persisted" }],
      appState: { viewBackgroundColor: "#111111" },
    };
    const store = new WhiteboardStore(state);
    await store.save("keep-me", scene);
    const before = await readFile(join(store.boardsDir, "keep-me.excalidraw"), "utf8");

    const disabled = applyPluginAutoEnable({
      config: { plugins: { entries: { whiteboard: { enabled: false } } } },
      env: { INFINIBOT_STATE_DIR: state },
    });
    expect(disabled.config.plugins?.entries?.whiteboard?.enabled).toBe(false);

    const reopened = new WhiteboardStore(state);
    expect(await reopened.get("keep-me")).toEqual(scene);
    expect(await readFile(join(reopened.boardsDir, "keep-me.excalidraw"), "utf8")).toBe(before);
  });
});
