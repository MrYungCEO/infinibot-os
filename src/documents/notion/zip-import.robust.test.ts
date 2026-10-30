import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DocumentStore } from "../store.js";
import type { DocNode } from "../types.js";
import { importNotionZip, parseRelationCell } from "./zip-import.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001", "hex");
const hex = (n: number) => `${"a".repeat(8)}${n.toString(16).padStart(24, "0")}`;
const enc = (s: string) => encodeURIComponent(s).replace(/%2F/g, "/");

const ROOT = hex(1);
const CHILD = hex(2);
const PROJ = hex(3);
const TASKS = hex(4);
const ALPHA = hex(5);
const BETA = hex(6);
const T1 = hex(7);
const T2 = hex(8);
const GONE = hex(9);
const MISSING = hex(10);
const LONG = hex(11);
const longTitle = `🚀 ${"Ünïcødé 长标题 עברית ".repeat(14)}end`;

function exportFiles(childBody = "Child body."): Record<string, string | Buffer> {
  const R = `Root ${ROOT}`;
  return {
    [`${R}.md`]: [
      "# Root",
      "",
      `See [Child](${enc(`${R}/Child ${CHILD}.md`)}) and [Tasks](${enc(`${R}/Tasks ${TASKS}.csv`)}).`,
      `Mention by URL: [Alpha](https://www.notion.so/Alpha-${ALPHA}).`,
      `![pic](${enc(`${R}/pic é 1.png`)})`,
    ].join("\n"),
    [`${R}/Child ${CHILD}.md`]: [
      "# Child",
      "",
      childBody,
      `Back to [Root](../${enc(`${R}.md`)}); broken [gone](${enc(`Missing ${MISSING}.md`)}).`,
      `Same picture: ![p](${enc("pic é 1.png")})`,
    ].join("\n"),
    [`${R}/pic é 1.png`]: PNG,
    [`${R}/${longTitle} ${LONG}.md`]: `# ${longTitle}\n\nLong-named page → [Child](${enc(`Child ${CHILD}.md`)})`,
    [`${R}/Projects ${PROJ}.csv`]: [
      "Name,Status,Tasks",
      `Alpha,Active,"Task 1 (${enc(`Tasks ${TASKS}/Task 1 ${T1}.md`)}), Task 2 (${enc(`Tasks ${TASKS}/Task 2 ${T2}.md`)})"`,
      "Beta,Done,",
    ].join("\n"),
    [`${R}/Projects ${PROJ}/Alpha ${ALPHA}.md`]: [
      "# Alpha",
      "",
      "Status: Active",
      `Tasks: Task 1 (${enc(`../Tasks ${TASKS}/Task 1 ${T1}.md`)})`,
      "",
      `Alpha body links [Task 1](${enc(`../Tasks ${TASKS}/Task 1 ${T1}.md`)}).`,
    ].join("\n"),
    [`${R}/Projects ${PROJ}/Beta ${BETA}.md`]: "# Beta\n\nStatus: Done\n\nBeta body.",
    [`${R}/Tasks ${TASKS}.csv`]: [
      "Name,Project,Done",
      `Task 1,Alpha (${enc(`Projects ${PROJ}/Alpha ${ALPHA}.md`)}),Yes`,
      `Task 2,"Alpha (${enc(`Projects ${PROJ}/Alpha ${ALPHA}.md`)}), Beta (https://www.notion.so/Beta-${BETA})",No`,
      `Task 3,Gone (${enc(`Projects ${PROJ}/Gone ${GONE}.md`)}),No`,
    ].join("\n"),
    [`${R}/Tasks ${TASKS}/Task 1 ${T1}.md`]: "# Task 1\n\nProject: Alpha\nDone: Yes\n\nDo it.",
    [`${R}/Tasks ${TASKS}/Task 2 ${T2}.md`]: "# Task 2\n\nProject: Alpha\nDone: No\n\nLater.",
  };
}

async function zipOf(files: Record<string, string | Buffer>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [p, d] of Object.entries(files)) zip.file(`Export-123/${p}`, d);
  return zip.generateAsync({ type: "nodebuffer" });
}

let tmp: string;
let store: DocumentStore;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "notion-zip-robust-"));
  store = new DocumentStore(path.join(tmp, "documents"));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const node = (id: string): DocNode => {
  const n = store.findBySource("notion", id);
  if (!n) throw new Error(`no node ${id}`);
  return n;
};
const dupKeys = () => {
  const seen = new Map<string, number>();
  for (const n of store.all()) {
    if (!n.source?.id) continue;
    const k = `${n.source.type}:${n.source.id}`;
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  return [...seen].filter(([, c]) => c > 1);
};

describe("parseRelationCell", () => {
  it("parses path and URL relation lists, rejects plain text", () => {
    // Titles may contain commas: everything before a link belongs to its title.
    expect(parseRelationCell("A (x/A%20abc.md), B, C (https://www.notion.so/C-1)")).toEqual([
      { title: "A", target: "x/A%20abc.md" },
      { title: "B, C", target: "https://www.notion.so/C-1" },
    ]);
    expect(parseRelationCell("A, x (y/A.md)")).toEqual([{ title: "A, x", target: "y/A.md" }]);
    expect(parseRelationCell("A (x/A%20abc.md), B (https://www.notion.so/B-123)")).toEqual([
      { title: "A", target: "x/A%20abc.md" },
      { title: "B", target: "https://www.notion.so/B-123" },
    ]);
    expect(parseRelationCell("just text")).toBeNull();
    expect(parseRelationCell("")).toBeNull();
  });
});

describe("Notion ZIP import — relations, links, attachments", () => {
  it("turns relation cells into doc: references and counts link resolution", async () => {
    const report = await importNotionZip(store, await zipOf(exportFiles()), { parentId: null });
    expect(report.errors).toEqual([]);
    const alpha = node(ALPHA);
    const beta = node(BETA);
    const t1 = node(T1);
    const t2 = node(T2);
    expect(alpha.properties?.Tasks).toEqual([`doc:${t1.id}`, `doc:${t2.id}`]);
    expect(t1.properties?.Project).toEqual([`doc:${alpha.id}`]);
    expect(t2.properties?.Project).toEqual([`doc:${alpha.id}`, `doc:${beta.id}`]);
    const t3 = store.all().find((n) => n.title === "Task 3")!;
    expect(t3.properties?.Project).toEqual(["Gone"]); // not in the export → text
    expect(t1.properties?.Done).toBe(true);
    // Schema marks relation columns.
    const tasksDb = node(TASKS);
    expect(tasksDb.schema?.find((c) => c.key === "Project")?.type).toBe("relation");
    expect(node(PROJ).schema?.find((c) => c.key === "Tasks")?.type).toBe("relation");
    // Relations and body links show up as backlinks.
    expect(
      store
        .backlinks(alpha.id)
        .map((n) => n.title)
        .sort(),
    ).toEqual(["Root", "Task 1", "Task 2"]);
    expect(
      store
        .backlinks(t1.id)
        .map((n) => n.title)
        .sort(),
    ).toEqual(["Alpha"]);
    // Link stats: the missing page link + the "Gone" relation are unresolved.
    expect(report.links?.unresolved).toBe(2);
    expect(report.links?.unresolvedSample?.map((u) => u.target).sort()).toEqual(
      [`Gone`, enc(`Missing ${MISSING}.md`)].sort(),
    );
    expect(report.summary).toMatchObject({ failed: 0, links: { unresolved: 2 } });
    expect(report.summary!.links.rate).toBeGreaterThan(0.8);
  });

  it("links pages, copies a shared image once, and survives a >255-byte emoji/CJK/RTL title", async () => {
    await importNotionZip(store, await zipOf(exportFiles()), { parentId: null });
    const root = node(ROOT);
    const child = node(CHILD);
    const rootBody = store.getBody(root.id);
    expect(rootBody).toContain(`[Child](doc:${child.id})`);
    expect(rootBody).toContain(`[Tasks](doc:${node(TASKS).id})`);
    expect(rootBody).toContain(`[Alpha](doc:${node(ALPHA).id})`);
    const childBody = store.getBody(child.id);
    expect(childBody).toContain(`[Root](doc:${root.id})`);
    const img = /!\[[^\]]*\]\((\/api\/documents\/assets\/[a-f0-9]{24}\.png)\)/;
    expect(rootBody.match(img)![1]).toBe(childBody.match(img)![1]);
    expect(fs.readdirSync(path.join(store.root, "assets"))).toHaveLength(1);
    const long = node(LONG);
    expect(long.title).toBe(longTitle);
    expect(store.getBody(long.id)).toContain(`(doc:${child.id})`);
    for (const f of fs.readdirSync(path.join(store.root, "docs"))) {
      expect(Buffer.byteLength(f)).toBeLessThan(80);
    }
  });

  it("re-import is idempotent; an edited page updates in place", async () => {
    const first = await importNotionZip(store, await zipOf(exportFiles()), { parentId: null });
    const count = store.all().length;
    expect(first.created).toBe(count);
    const second = await importNotionZip(store, await zipOf(exportFiles()), { parentId: null });
    expect(second).toMatchObject({ created: 0, updated: 0, unchanged: count });
    const third = await importNotionZip(store, await zipOf(exportFiles("EDITED body")), {
      parentId: null,
    });
    expect(third).toMatchObject({ created: 0, updated: 1, unchanged: count - 1 });
    expect(store.getBody(node(CHILD).id)).toContain("EDITED body");
    expect(store.all()).toHaveLength(count);
    expect(dupKeys()).toEqual([]);
  });

  it("an aborted import re-run to completion has no duplicates", async () => {
    const zip = await zipOf(exportFiles());
    const ctl = new AbortController();
    let writes = 0;
    await expect(
      importNotionZip(store, zip, {
        parentId: null,
        signal: ctl.signal,
        onWrite: () => {
          if (++writes === 5) ctl.abort();
        },
      }),
    ).rejects.toThrow();
    const fresh = new DocumentStore(store.root);
    const report = await importNotionZip(fresh, zip, { parentId: null });
    expect(report.errors).toEqual([]);
    store = fresh;
    expect(dupKeys()).toEqual([]);
    const full = new DocumentStore(path.join(tmp, "documents-clean"));
    await importNotionZip(full, zip, { parentId: null });
    expect(store.all()).toHaveLength(full.all().length);
  });
});
