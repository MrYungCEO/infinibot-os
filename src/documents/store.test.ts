import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DocumentStore, extractWikiTargets } from "./store.js";

let dir: string;
let store: DocumentStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ib-docs-store-"));
  store = new DocumentStore(dir);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("DocumentStore folders", () => {
  it("creates nested folders + docs and resolves breadcrumbs", () => {
    const a = store.create({ kind: "folder", title: "Clients" });
    const b = store.create({ kind: "folder", title: "Acme", parentId: a.id });
    const d = store.create({
      kind: "doc",
      title: "Kickoff",
      parentId: b.id,
      body: "# Kickoff\nhello",
    });
    expect(store.pathOf(d.id).map((n) => n.title)).toEqual(["Clients", "Acme", "Kickoff"]);
    expect(store.children(b.id).map((n) => n.id)).toEqual([d.id]);
    expect(store.getBody(d.id)).toBe("# Kickoff\nhello");
    expect(d.preview).toContain("Kickoff hello");
  });

  it("refuses docs as parents and folder-into-itself moves", () => {
    const a = store.create({ kind: "folder", title: "A" });
    const b = store.create({ kind: "folder", title: "B", parentId: a.id });
    const d = store.create({ kind: "doc", title: "D" });
    expect(() => store.create({ kind: "doc", title: "x", parentId: d.id })).toThrow(/not a folder/);
    expect(() => store.move(a.id, b.id)).toThrow(/into itself/);
    expect(() => store.move(a.id, a.id)).toThrow(/into itself/);
  });

  it("moves with index re-numbering siblings", () => {
    const f = store.create({ kind: "folder", title: "F" });
    const d1 = store.create({ kind: "doc", title: "one", parentId: f.id });
    const d2 = store.create({ kind: "doc", title: "two", parentId: f.id });
    const d3 = store.create({ kind: "doc", title: "three" });
    store.move(d3.id, f.id, 0);
    expect(store.children(f.id).map((n) => n.title)).toEqual(["three", "one", "two"]);
    store.move(d1.id, f.id, 2);
    expect(store.children(f.id).map((n) => n.id)).toEqual([d3.id, d2.id, d1.id]);
  });

  it("soft-deletes subtrees, restores, and purges only from trash", () => {
    const f = store.create({ kind: "folder", title: "F" });
    const d = store.create({ kind: "doc", title: "inner", parentId: f.id, body: "x" });
    store.softDelete(f.id);
    expect(store.tree().map((n) => n.id)).not.toContain(d.id);
    expect(store.trash().map((n) => n.id)).toEqual([f.id]);
    expect(store.search("inner")).toHaveLength(0);
    store.restore(f.id);
    expect(store.tree().map((n) => n.id)).toContain(d.id);
    expect(() => store.purge(d.id)).toThrow(/trashed/);
    store.softDelete(f.id);
    expect(store.purge(f.id)).toBe(2);
    expect(store.getNode(d.id)).toBeNull();
    expect(fs.existsSync(path.join(dir, "docs", `${d.id}.md`))).toBe(false);
  });

  it("restoring a child whose parent is trashed lifts it to root", () => {
    const f = store.create({ kind: "folder", title: "F" });
    const d = store.create({ kind: "doc", title: "inner", parentId: f.id });
    store.softDelete(d.id);
    store.softDelete(f.id);
    store.restore(d.id);
    expect(store.getNode(d.id)!.parentId).toBeNull();
    expect(store.tree().map((n) => n.id)).toContain(d.id);
  });

  it("persists across re-open (new instance reads index.json)", () => {
    const d = store.create({ kind: "doc", title: "Persist", body: "b" });
    const again = new DocumentStore(dir);
    expect(again.getNode(d.id)!.title).toBe("Persist");
    expect(again.getBody(d.id)).toBe("b");
  });
});

describe("DocumentStore search, links, history", () => {
  it("searches titles, bodies, properties and extracted file text", () => {
    store.create({ kind: "doc", title: "Pricing plan", body: "Pro tier is $29" });
    store.create({
      kind: "doc",
      title: "Other",
      body: "mentions pricing twice: pricing",
      properties: { Status: "Draft" },
    });
    const f = store.addFile({
      name: "report.pdf",
      data: Buffer.from("%PDF-1.4"),
      mime: "application/pdf",
    });
    store.setExtracted(f.id, "Quarterly revenue grew 40%", "ok");
    const hits = store.search("pricing");
    expect(hits[0]!.title).toBe("Pricing plan");
    expect(hits).toHaveLength(2);
    expect(store.search("revenue")[0]!.id).toBe(f.id);
    expect(store.search("draft")[0]!.title).toBe("Other");
    expect(store.search("pro tier")[0]!.snippet).toContain("Pro tier");
  });

  it("scopes search to a folder subtree", () => {
    const f = store.create({ kind: "folder", title: "F" });
    store.create({ kind: "doc", title: "in", parentId: f.id, body: "needle" });
    store.create({ kind: "doc", title: "out", body: "needle" });
    expect(store.search("needle", { parentId: f.id }).map((h) => h.title)).toEqual(["in"]);
  });

  it("resolves [[wiki links]] and doc: links into backlinks", () => {
    const target = store.create({ kind: "doc", title: "Roadmap", body: "" });
    const a = store.create({ kind: "doc", title: "A", body: "see [[Roadmap]] and [[Missing]]" });
    const b = store.create({ kind: "doc", title: "B", body: `see [it](doc:${target.id})` });
    store.create({ kind: "doc", title: "C", body: "see [[roadmap|the plan]]" });
    expect(extractWikiTargets("[[X|y]] [[ Z ]]")).toEqual(["X", "Z"]);
    const back = store
      .backlinks(target.id)
      .map((n) => n.title)
      .sort();
    expect(back).toEqual(["A", "B", "C"]);
    expect(store.outgoingLinks(a.id).find((l) => l.target === "Missing")!.node).toBeNull();
    expect(b.id).toBeTruthy();
  });

  it("snapshots history on change and restores revisions", () => {
    const d = store.create({ kind: "doc", title: "H", body: "v1" });
    store.update({ id: d.id, body: "v2" });
    store.update({ id: d.id, body: "v3" }); // coalesced inside the 5-min window
    store.update({ id: d.id, body: "v4", snapshot: true });
    const revs = store.history(d.id);
    expect(revs).toHaveLength(2);
    const oldest = revs[revs.length - 1]!;
    expect(store.revision(d.id, oldest.rev)!.body).toBe("v1");
    store.restoreRevision(d.id, oldest.rev);
    expect(store.getBody(d.id)).toBe("v1");
    expect(store.history(d.id)).toHaveLength(3);
  });

  it("upsertBySource is idempotent and keeps user filing", () => {
    const f = store.create({ kind: "folder", title: "Mine" });
    const src = { type: "notion" as const, id: "abc" };
    const r1 = store.upsertBySource(src, { kind: "doc", title: "T", body: "one" });
    expect(r1.status).toBe("created");
    expect(store.upsertBySource(src, { kind: "doc", title: "T", body: "one" }).status).toBe(
      "unchanged",
    );
    store.move(r1.node.id, f.id);
    const r3 = store.upsertBySource(src, { kind: "doc", title: "T2", body: "two", parentId: null });
    expect(r3.status).toBe("updated");
    expect(store.getNode(r1.node.id)!.parentId).toBe(f.id);
    expect(store.getBody(r1.node.id)).toBe("two");
    store.softDelete(r1.node.id);
    expect(store.upsertBySource(src, { kind: "doc", title: "T", body: "3" }).status).toBe(
      "skipped",
    );
    expect(store.all().filter((n) => n.source?.id === "abc")).toHaveLength(1);
  });

  it("stores content-addressed assets with a safe name check", () => {
    const url = store.addAsset(Buffer.from("png-bytes"), "png");
    expect(url).toMatch(/^\/api\/documents\/assets\/[a-f0-9]{24}\.png$/);
    const name = url.split("/").pop()!;
    expect(store.assetPath(name)).toBeTruthy();
    expect(store.assetPath("../index.json")).toBeNull();
    expect(store.addAsset(Buffer.from("png-bytes"), ".png")).toBe(url);
  });
});
