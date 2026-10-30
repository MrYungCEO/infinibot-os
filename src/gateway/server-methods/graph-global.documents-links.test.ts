import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../business-agency/runtime.js", () => ({ isBusinessAgencyActive: () => false }));

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-doc-links-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("documents graph — property links and scale", () => {
  it("draws edges for doc: relation values and frontmatter links", async () => {
    const { DocumentStore } = await import("../../documents/store.js");
    const { buildSnapshot } = await import("./graph-global.js");
    const store = DocumentStore.at(path.join(dir, "documents"));
    const project = store.create({ kind: "doc", title: "Project Alpha" });
    const task = store.create({
      kind: "doc",
      title: "Task One",
      properties: { Project: [`doc:${project.id}`], Note: "plain" },
    });
    const note = store.create({
      kind: "doc",
      title: "Obsidian note",
      properties: { related: "[[Task One]]" },
    });
    const snap = await buildSnapshot({
      kinds: new Set(["note"]),
      maxRowsPerDatabase: 0,
      stateDir: dir,
    });
    const id = (docId: string) => snap.nodes.find((n) => n.meta?.documentId === docId)?.id;
    const has = (a: string, b: string) =>
      snap.edges.some((e) => e.source === id(a) && e.target === id(b) && e.rel === "links");
    expect(has(task.id, project.id)).toBe(true);
    expect(has(note.id, task.id)).toBe(true);
  });

  it("links 3,000 imported docs without quadratic lookups", async () => {
    const { DocumentStore } = await import("../../documents/store.js");
    const { buildSnapshot } = await import("./graph-global.js");
    const store = DocumentStore.at(path.join(dir, "documents"));
    const N = 3_000;
    const ids: string[] = [];
    await store.batch(() => {
      for (let i = 0; i < N; i++) {
        ids.push(store.create({ kind: "doc", id: `doc-${i}`, title: `Doc ${i}` }).id);
      }
      for (let i = 0; i < N; i++) {
        store.update({
          id: ids[i]!,
          body: `[next](doc:${ids[(i + 1) % N]}) [[Doc ${(i + 2) % N}]] [[Doc ${(i + 3) % N}]]`,
        });
      }
    });
    const t0 = Date.now();
    const snap = await buildSnapshot({
      kinds: new Set(["note"]),
      maxRowsPerDatabase: 0,
      stateDir: dir,
    });
    const ms = Date.now() - t0;
    const links = snap.edges.filter((e) => e.rel === "links").length;
    expect(links).toBe(N * 3);
    expect(ms).toBeLessThan(15_000);
  }, 60_000);
});
