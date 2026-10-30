import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DocumentStore } from "../store.js";
import type { DocNode } from "../types.js";
import {
  csvCellValue,
  importNotionZip,
  inferColumnType,
  parseCsv,
  parseExportName,
  safeZipPath,
} from "./zip-import.js";

const ROOT = "11111111111141118111111111111111";
const CHILD = "22222222222242228222222222222222";
const DB = "33333333333343338333333333333333";
const ROW1 = "44444444444444448444444444444444";
const ROW2 = "55555555555545558555555555555555";
const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const PDF = Buffer.from("%PDF-1.4\n%fake\n");

/** Build a Notion-style "Markdown & CSV" export: outer zip wrapping a part zip. */
async function buildExport(opts: { rootBody?: string } = {}): Promise<Buffer> {
  const rootDir = `Team Handbook ${ROOT}`;
  const dbBase = `${rootDir}/Roadmap ${DB}`;
  const part = new JSZip();
  part.file(
    `${rootDir}.md`,
    opts.rootBody ??
      [
        "# Team Handbook",
        "",
        `Intro with [Onboarding](${enc(`${rootDir}/Onboarding ${CHILD}.md`)}) and more.`,
        "",
        `![diagram.png](${enc(`${rootDir}/diagram.png`)})`,
        "",
        "<aside>",
        "💡 Remember this",
        "",
        "</aside>",
        "",
        `[Roadmap](${enc(`${dbBase}.csv`)})`,
        "",
        `[spec.pdf](${enc(`${rootDir}/spec.pdf`)})`,
        "",
        "```md",
        "[not rewritten](Onboarding.md)",
        "```",
        "",
      ].join("\n"),
  );
  part.file(
    `${rootDir}/Onboarding ${CHILD}.md`,
    `# Onboarding\n\nBack to [Team Handbook](${enc(`../Team Handbook ${ROOT}.md`)}).\n`,
  );
  part.file(`${rootDir}/diagram.png`, PNG);
  part.file(`${rootDir}/spec.pdf`, PDF);
  const header = "Name,Status,Done,Score,Due,Tags\n";
  const rows = [
    'Ship importer,Done,Yes,3,"September 1, 2026","eng, docs"\n',
    "Write tests,,No,1,2026-09-10,\n",
  ];
  part.file(`${dbBase}.csv`, `\uFEFF${header}${rows.join("")}`);
  part.file(`${dbBase}_all.csv`, `\uFEFF${header}${rows.join("")}Backlog item,Todo,No,,,\n`);
  part.file(
    `${dbBase}/Ship importer ${ROW1}.md`,
    "# Ship importer\n\nStatus: Done\nDone: Yes\nScore: 3\nDue: September 1, 2026\nTags: eng, docs\n\nImporter ships **today**\n",
  );
  part.file(
    `${dbBase}/Write tests ${ROW2}.md`,
    "# Write tests\n\nDone: No\nScore: 1\n\n- [x] cover zip\n",
  );
  const inner = await part.generateAsync({ type: "nodebuffer" });

  const outer = new JSZip();
  outer.file("Export-abc-Part-1.zip", inner);
  outer.file("Loose Notes.md", "# Loose Notes\n\nNo id in this export.\n");
  outer.file("__MACOSX/._junk", "x");
  return outer.generateAsync({ type: "nodebuffer" });
}

describe("importNotionZip", () => {
  let dir: string;
  let store: DocumentStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "notion-zip-"));
    store = DocumentStore.at(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const bySource = (id: string, type: "notion" | "notion-zip" = "notion"): DocNode => {
    const node = store.findBySource(type, id);
    if (!node) throw new Error(`no node for ${type}:${id}`);
    return node;
  };

  it("maps an export (nested zip, child page, database csv + rows, assets) to the tree", async () => {
    const parent = store.create({ kind: "folder", title: "Imports" });
    const progress: string[] = [];
    const report = await importNotionZip(store, await buildExport(), {
      parentId: parent.id,
      onProgress: (p) => progress.push(p.phase),
    });
    expect(report.errors).toEqual([]);
    // folder:root, root doc, child doc, db folder, 3 rows, loose notes doc
    expect(report).toMatchObject({ created: 8, updated: 0, unchanged: 0, skipped: 0 });
    expect(progress).toContain("discover");
    expect(progress).toContain("write");

    const rootFolder = bySource(`folder:${ROOT}`);
    const rootDoc = bySource(ROOT);
    const child = bySource(CHILD);
    const db = bySource(DB);
    const loose = bySource("zip:Loose Notes", "notion-zip");
    expect(report.rootNodeIds.sort()).toEqual([rootFolder.id, loose.id].sort());
    expect(rootFolder).toMatchObject({
      kind: "folder",
      title: "Team Handbook",
      parentId: parent.id,
    });
    expect(rootDoc).toMatchObject({ kind: "doc", title: "Team Handbook", parentId: rootFolder.id });
    expect(child).toMatchObject({ kind: "doc", title: "Onboarding", parentId: rootFolder.id });
    expect(db).toMatchObject({
      kind: "folder",
      title: "Roadmap",
      parentId: rootFolder.id,
      view: { mode: "table" },
    });
    expect(loose).toMatchObject({ kind: "doc", title: "Loose Notes", parentId: parent.id });
    expect(store.children(rootFolder.id).filter((c) => c.kind === "doc")[0]!.id).toBe(rootDoc.id);

    // Schema inferred from the CSV (the _all.csv variant, which has the extra row).
    expect(db.schema?.map((c) => `${c.key}:${c.type}`)).toEqual([
      "Name:title",
      "Status:text",
      "Done:checkbox",
      "Score:number",
      "Due:date",
      "Tags:text",
    ]);
    const rows = store.children(db.id);
    expect(rows.map((r) => r.title).sort()).toEqual([
      "Backlog item",
      "Ship importer",
      "Write tests",
    ]);
    const row1 = bySource(ROW1);
    expect(row1.properties).toEqual({
      Status: "Done",
      Done: true,
      Score: 3,
      Due: "2026-09-01",
      Tags: "eng, docs",
    });
    // H1 and the `Prop: value` block are stripped from the body.
    expect(store.getBody(row1.id)).toBe("Importer ships **today**\n");
    expect(store.getBody(bySource(ROW2).id)).toBe("- [x] cover zip\n");
    expect(bySource(ROW2).properties).toMatchObject({ Done: false, Score: 1, Status: null });
    const backlog = bySource(`zip:Team Handbook ${ROOT}/Roadmap ${DB}/Backlog item`, "notion-zip");
    expect(backlog.properties).toMatchObject({ Status: "Todo", Done: false, Score: null });

    const body = store.getBody(rootDoc.id);
    expect(body.startsWith("# ")).toBe(false);
    expect(body).toContain(`[Onboarding](doc:${child.id})`);
    expect(body).toContain(`[Roadmap](doc:${db.id})`);
    const img = /!\[diagram\.png\]\((\/api\/documents\/assets\/[a-f0-9]{24}\.png)\)/.exec(body);
    expect(img).not.toBeNull();
    expect(fs.readFileSync(store.assetPath(img![1]!.split("/").pop()!)!)).toEqual(PNG);
    expect(body).toMatch(/\[📎 spec\.pdf\]\(\/api\/documents\/assets\/[a-f0-9]{24}\.pdf\)/);
    expect(body).toContain("> [!NOTE]\n> 💡 Remember this");
    expect(body).toContain("```md\n[not rewritten](Onboarding.md)\n```");
    expect(store.getBody(child.id)).toBe(`Back to [Team Handbook](doc:${rootDoc.id}).\n`);
  });

  it("is idempotent: re-importing the same export changes nothing", async () => {
    const zip = await buildExport();
    await importNotionZip(store, zip, { parentId: null });
    const before = store.all().length;
    const report = await importNotionZip(store, zip, { parentId: null });
    expect(report.errors).toEqual([]);
    expect(report).toMatchObject({ created: 0, updated: 0, unchanged: 8 });
    expect(store.all().length).toBe(before);
  });

  it("updates changed bodies in place", async () => {
    await importNotionZip(store, await buildExport(), { parentId: null });
    const report = await importNotionZip(
      store,
      await buildExport({ rootBody: "# Team Handbook (v2)\n\nRewritten.\n" }),
      { parentId: null },
    );
    // The page folder and the page doc both take the new title.
    expect(report).toMatchObject({ created: 0, updated: 2 });
    expect(bySource(`folder:${ROOT}`).title).toBe("Team Handbook (v2)");
    const rootDoc = bySource(ROOT);
    expect(rootDoc.title).toBe("Team Handbook (v2)");
    expect(store.getBody(rootDoc.id)).toBe("Rewritten.\n");
  });

  it("converges with nodes imported through the API (same notion id key)", async () => {
    const existing = store.create({
      kind: "doc",
      title: "Onboarding",
      body: "old api body",
      source: { type: "notion", id: CHILD, remoteEditedAt: "2026-09-01T10:00:00.000Z" },
    });
    await importNotionZip(store, await buildExport(), { parentId: null });
    const matches = store.all().filter((n) => n.source?.id === CHILD);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.id).toBe(existing.id);
    expect(store.getBody(existing.id)).toContain("Back to [Team Handbook]");
  });

  it("enforces zip-bomb limits", async () => {
    const zip = await buildExport();
    await expect(importNotionZip(store, zip, { parentId: null, maxEntries: 3 })).rejects.toThrow(
      /too many entries/,
    );
    const big = new JSZip();
    big.file("Big.md", "# Big\n\n" + "a".repeat(200_000));
    const bomb = await big.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    await expect(
      importNotionZip(store, bomb, { parentId: null, maxTotalBytes: 50_000 }),
    ).rejects.toThrow(/expands beyond/);
    expect(store.all()).toHaveLength(0);
  });

  it("ignores traversal paths", async () => {
    const z = new JSZip();
    z.file("ok.md", "# OK\n\n[escape](../../etc/passwd)\n");
    const report = await importNotionZip(store, await z.generateAsync({ type: "nodebuffer" }), {
      parentId: null,
    });
    expect(report.created).toBe(1);
    const doc = bySource("zip:ok", "notion-zip");
    expect(store.getBody(doc.id)).toBe("[escape](../../etc/passwd)\n");
  });
});

describe("zip helpers", () => {
  it("normalizes zip paths and rejects traversal", () => {
    expect(safeZipPath("a/./b\\c.md")).toBe("a/b/c.md");
    expect(safeZipPath("../evil.md")).toBeNull();
    expect(safeZipPath("a/../../evil.md")).toBeNull();
    expect(safeZipPath("/abs/x.md")).toBe("abs/x.md");
    expect(safeZipPath("C:/x.md")).toBeNull();
  });

  it("parses export names with and without ids", () => {
    expect(parseExportName(`My Page ${ROOT}`)).toEqual({ title: "My Page", id: ROOT });
    expect(parseExportName("My Page")).toEqual({ title: "My Page", id: null });
  });

  it("parses RFC 4180 CSV", () => {
    expect(parseCsv('\uFEFFa,b\r\n"x, y","say ""hi""\nthere"\r\n\r\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"\nthere'],
    ]);
  });

  it("infers column types and converts cells", () => {
    expect(inferColumnType(["Yes", "No", ""])).toBe("checkbox");
    expect(inferColumnType(["1", "2.5", "1,000"])).toBe("number");
    expect(inferColumnType(["January 5, 2024", "2024-02-01", "@March 3, 2024 3:00 PM (UTC)"])).toBe(
      "date",
    );
    expect(inferColumnType(["https://a.b", "http://c.d/e"])).toBe("url");
    expect(inferColumnType(["a@b.co"])).toBe("email");
    expect(inferColumnType(["hello", "3"])).toBe("text");
    expect(inferColumnType([])).toBe("text");
    expect(csvCellValue("1,000", "number")).toBe(1000);
    expect(csvCellValue("Yes", "checkbox")).toBe(true);
    expect(csvCellValue("", "text")).toBeNull();
    expect(csvCellValue("January 5, 2024 → January 7, 2024", "date")).toBe(
      "2024-01-05 → 2024-01-07",
    );
    expect(csvCellValue("January 5, 2024 3:00 PM", "date")).toBe("January 5, 2024 3:00 PM");
  });
});
