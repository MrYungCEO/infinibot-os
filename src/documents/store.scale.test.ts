import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DocumentStore, extractLinkTargets } from "./store.js";

let tmp: string;
let root: string;
let store: DocumentStore;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "docstore-scale-"));
  root = path.join(tmp, "documents");
  store = new DocumentStore(root);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const indexOnDisk = (): Record<string, unknown> => {
  try {
    return (
      JSON.parse(fs.readFileSync(path.join(root, "index.json"), "utf-8")) as {
        nodes: Record<string, unknown>;
      }
    ).nodes;
  } catch {
    return {};
  }
};

describe("DocumentStore batch mode", () => {
  it("defers index writes inside batch() and flushes when it settles", async () => {
    store.create({ kind: "doc", title: "Before" });
    expect(Object.keys(indexOnDisk())).toHaveLength(1);
    await store.batch(async () => {
      for (let i = 0; i < 20; i++) store.create({ kind: "doc", title: `N${i}`, body: `b${i}` });
      // Reads see the pending writes; disk does not (yet).
      expect(store.all()).toHaveLength(21);
      expect(Object.keys(indexOnDisk())).toHaveLength(1);
      await new Promise((r) => setImmediate(r));
      expect(store.batching).toBe(true);
    });
    expect(store.batching).toBe(false);
    expect(Object.keys(indexOnDisk())).toHaveLength(21);
    // A fresh process (new instance) sees everything.
    expect(new DocumentStore(root).all()).toHaveLength(21);
  });

  it("flushes periodically during a long batch (every 250 writes)", async () => {
    await store.batch(async () => {
      for (let i = 0; i < 260; i++) store.create({ kind: "doc", title: `N${i}` });
      const onDisk = Object.keys(indexOnDisk()).length;
      expect(onDisk).toBeGreaterThanOrEqual(250);
      expect(onDisk).toBeLessThan(260);
    });
    expect(Object.keys(indexOnDisk())).toHaveLength(260);
  });

  it("writes from outside the batch's async context are persisted immediately", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const running = store.batch(async () => {
      store.create({ kind: "doc", title: "in-batch" });
      await gate;
    });
    // A user edit while an import runs: normal (immediate) semantics, and it
    // carries the pending batch writes with it.
    store.create({ kind: "doc", title: "user edit" });
    expect(Object.keys(indexOnDisk())).toHaveLength(2);
    release();
    await running;
    expect(Object.keys(indexOnDisk())).toHaveLength(2);
  });

  it("flushes even when the batch throws", async () => {
    await expect(
      store.batch(async () => {
        store.create({ kind: "doc", title: "kept" });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(Object.keys(indexOnDisk())).toHaveLength(1);
  });
});

describe("DocumentStore cached lookups", () => {
  it("findBySource stays correct across create, re-key, purge and external reloads", () => {
    const a = store.create({ kind: "doc", title: "A", source: { type: "obsidian", id: "v:a.md" } });
    expect(store.findBySource("obsidian", "v:a.md")?.id).toBe(a.id);
    expect(store.findBySource("obsidian", "v:missing.md")).toBeNull();
    store.update({ id: a.id, source: { type: "obsidian", id: "v:renamed.md" } });
    expect(store.findBySource("obsidian", "v:a.md")).toBeNull();
    expect(store.findBySource("obsidian", "v:renamed.md")?.id).toBe(a.id);
    store.softDelete(a.id);
    store.purge(a.id);
    expect(store.findBySource("obsidian", "v:renamed.md")).toBeNull();
    // Another process writes the index: the cache is rebuilt on reload.
    const other = new DocumentStore(root);
    const b = other.create({ kind: "doc", title: "B", source: { type: "notion", id: "x" } });
    // mtime granularity: force a visible change.
    const t = new Date(Date.now() + 5_000);
    fs.utimesSync(path.join(root, "index.json"), t, t);
    expect(store.findBySource("notion", "x")?.id).toBe(b.id);
  });

  it("upsertBySource does not rescan per call (5k upserts stay fast)", async () => {
    const t0 = Date.now();
    await store.batch(() => {
      for (let i = 0; i < 5_000; i++) {
        store.upsertBySource(
          { type: "obsidian", id: `v:${i}.md` },
          { kind: "doc", title: `Note ${i}`, body: `body ${i}` },
        );
      }
    });
    const created = Date.now() - t0;
    expect(store.all()).toHaveLength(5_000);
    const t1 = Date.now();
    await store.batch(() => {
      for (let i = 0; i < 5_000; i++) {
        const r = store.upsertBySource(
          { type: "obsidian", id: `v:${i}.md` },
          { kind: "doc", title: `Note ${i}`, body: `body ${i}` },
        );
        if (r.status !== "unchanged") throw new Error(`expected unchanged, got ${r.status}`);
      }
    });
    expect(store.all()).toHaveLength(5_000);
    // Generous bounds; the old O(n²) path took minutes here.
    expect(created).toBeLessThan(20_000);
    expect(Date.now() - t1).toBeLessThan(20_000);
  }, 60_000);

  it("resolveLink matches titles NFC-insensitively and sees renames", () => {
    const d = store.create({ kind: "doc", title: "Café" });
    expect(store.resolveLink("Café")?.id).toBe(d.id);
    expect(store.resolveLink("CAFÉ")?.id).toBe(d.id);
    store.update({ id: d.id, title: "Bistro" });
    expect(store.resolveLink("Café")).toBeNull();
    expect(store.resolveLink("bistro")?.id).toBe(d.id);
    store.softDelete(d.id);
    expect(store.resolveLink("Bistro")).toBeNull();
  });
});

describe("property links", () => {
  it("extractLinkTargets reads doc: refs and [[links]] in properties", () => {
    expect(
      extractLinkTargets("see [x](doc:abc-1) and [[Body Link]]", {
        Related: ["doc:row-2", "Unresolved title"],
        Parent: "doc:p-3",
        Up: "[[Frontmatter Link]]",
        n: 3,
        empty: null,
      }).sort(),
    ).toEqual(["Body Link", "Frontmatter Link", "id:abc-1", "id:p-3", "id:row-2"].sort());
  });

  it("backlinks include relation properties and update after edits", () => {
    const target = store.create({ kind: "doc", title: "Target" });
    const viaBody = store.create({
      kind: "doc",
      title: "Body",
      body: `[t](doc:${target.id})`,
    });
    const viaProp = store.create({
      kind: "doc",
      title: "Row",
      properties: { Related: [`doc:${target.id}`] },
    });
    expect(
      store
        .backlinks(target.id)
        .map((n) => n.id)
        .sort(),
    ).toEqual([viaBody.id, viaProp.id].sort());
    expect(store.outgoingLinks(viaProp.id).map((l) => l.node?.id)).toEqual([target.id]);
    store.update({ id: viaProp.id, properties: { Related: [] } });
    expect(store.backlinks(target.id).map((n) => n.id)).toEqual([viaBody.id]);
  });
});
