/**
 * Service-level tests: notes migration + live mirror + write-back, uploads with
 * type sniffing + text extraction, and the agent `notes` tool document actions.
 * Everything runs against a temp INFINIBOT_STATE_DIR (legacy file notes mode).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let stateDir: string;
const prevEnv = process.env.INFINIBOT_STATE_DIR;

beforeAll(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ib-docs-svc-"));
  process.env.INFINIBOT_STATE_DIR = stateDir;
});
afterAll(() => {
  if (prevEnv === undefined) delete process.env.INFINIBOT_STATE_DIR;
  else process.env.INFINIBOT_STATE_DIR = prevEnv;
  fs.rmSync(stateDir, { recursive: true, force: true });
});

/** Minimal single-page PDF with a text run (valid xref offsets). */
function makePdf(text: string): Buffer {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    null,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = `BT /F1 18 Tf 20 100 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

async function makeDocx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file(
    "word/document.xml",
    `<w:document><w:body>
      <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Quarterly Plan</w:t></w:r></w:p>
      <w:p><w:r><w:t>Revenue &amp; growth</w:t></w:r></w:p>
      <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>First bullet</w:t></w:r></w:p>
      <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Region</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Sales</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:p><w:r><w:t>APAC</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>42</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    </w:body></w:document>`,
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

async function makeXlsx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "xl/workbook.xml",
    `<workbook><sheets><sheet name="Leads" sheetId="1"/></sheets></workbook>`,
  );
  zip.file(
    "xl/sharedStrings.xml",
    `<sst><si><t>Name</t></si><si><t>Score</t></si><si><t>Ada | Co</t></si></sst>`,
  );
  zip.file(
    "xl/worksheets/sheet1.xml",
    `<worksheet><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
      <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>97</v></c></row>
    </sheetData></worksheet>`,
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

async function makePptx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "ppt/slides/slide1.xml",
    `<p:sld><a:p><a:r><a:t>Launch deck</a:t></a:r></a:p><a:p><a:r><a:t>Ship it</a:t></a:r></a:p></p:sld>`,
  );
  zip.file("ppt/slides/slide2.xml", `<p:sld><a:p><a:r><a:t>Metrics</a:t></a:r></a:p></p:sld>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("notes → documents migration + mirror", () => {
  it("migrates existing notes non-destructively with a backup, then mirrors changes both ways", async () => {
    // Fresh installs map the "notes" system role to a database, so notes live
    // in database rows — exercise the same path the live gateway uses.
    const bridge = await import("../databases/system-role-bridge.js");
    expect(bridge.getRoleMode("notes").mode).toBe("database");
    const tick = () => new Promise((r) => setTimeout(r, 5));
    const alphaRow = bridge.upsertRowForRole("notes", {
      title: "Alpha",
      body: "alpha body",
      values: { category: "Ideas" } as never,
    })!;
    const betaRow = bridge.upsertRowForRole("notes", { title: "Beta", body: "beta body" })!;

    const svc = await import("./service.js");
    const store = svc.documentsStore(); // first open → migration
    const folder = store.findBySource("note", "__notes_folder__")!;
    expect(folder.kind).toBe("folder");
    const alpha = store.findBySource("note", alphaRow.id)!;
    expect(alpha.parentId).toBe(folder.id);
    expect(store.getBody(alpha.id)).toBe("alpha body");
    expect(alpha.properties?.Category).toBe("Ideas");
    const backups = fs.readdirSync(path.join(store.root, "backups"));
    expect(backups.some((f) => f.startsWith("notes-premigration"))).toBe(true);
    // Notes are untouched.
    expect(bridge.getRowForRole("notes", alphaRow.id)!.body).toBe("alpha body");

    // Idempotent re-run.
    const { migrateNotesIntoDocuments } = await import("./notes-bridge.js");
    const again = migrateNotesIntoDocuments(store);
    expect(again.created).toBe(0);
    expect(store.all().filter((n) => n.source?.type === "note" && n.kind === "doc")).toHaveLength(
      2,
    );

    // Legacy note write (agent notes tool / RPC) → mirrored into the doc.
    const { broadcastNotesChanged } = await import("../notes/notes-events.js");
    await tick();
    bridge.upsertRowForRole("notes", { id: betaRow.id, body: "beta edited upstream" });
    broadcastNotesChanged({ op: "update", id: betaRow.id });
    const beta = store.findBySource("note", betaRow.id)!;
    expect(store.getBody(beta.id)).toBe("beta edited upstream");

    const gammaRow = bridge.upsertRowForRole("notes", { title: "Gamma", body: "new note" })!;
    broadcastNotesChanged({ op: "create", id: gammaRow.id });
    expect(store.findBySource("note", gammaRow.id)).toBeTruthy();

    // Workspace edit → written back to the note, without echo.
    await tick();
    svc.updateDoc({ id: alpha.id, body: "edited in documents", title: "Alpha 2" });
    const alphaNow = bridge.getRowForRole("notes", alphaRow.id)!;
    expect(alphaNow.body).toBe("edited in documents");
    expect(alphaNow.title).toBe("Alpha 2");
    expect(store.getNode(alpha.id)!.source!.remoteEditedAt).toBe(
      new Date(alphaNow.updatedAt).toISOString(),
    );

    // Legacy delete → doc goes to trash (restorable), not purged.
    bridge.deleteRowForRole("notes", gammaRow.id);
    broadcastNotesChanged({ op: "delete", id: gammaRow.id });
    expect(store.findBySource("note", gammaRow.id)!.deletedAt).toBeTruthy();
  });

  it("also migrates file-based notes when no notes database is mapped", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ib-docs-legacy-"));
    const { NoteStore } = await import("../notes/store.js");
    new NoteStore(dir).create({ id: "legacy-one", name: "Legacy One", body: "from files" });
    const bridge = await import("./notes-bridge.js");
    const roleBridge = await import("../databases/system-role-bridge.js");
    const prev = process.env.INFINIBOT_STATE_DIR;
    process.env.INFINIBOT_STATE_DIR = dir;
    const spy = vi
      .spyOn(roleBridge, "getRoleMode")
      .mockReturnValue({ mode: "legacy", databaseId: null });
    try {
      const { DocumentStore } = await import("./store.js");
      const store = DocumentStore.at(path.join(dir, "documents"));
      const r = bridge.migrateNotesIntoDocuments(store);
      expect(r.mode).toBe("legacy");
      expect(r.created).toBe(1);
      expect(store.getBody(store.findBySource("note", "legacy-one")!.id)).toBe("from files");
    } finally {
      spy.mockRestore();
      process.env.INFINIBOT_STATE_DIR = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("uploads + text extraction", () => {
  it("extracts PDF, DOCX, XLSX, PPTX, CSV and turns .md into an editable doc", async () => {
    const svc = await import("./service.js");
    const store = svc.documentsStore();
    const folder = svc.createDoc({ kind: "folder", title: "Uploads" });

    const pdf = await svc.uploadFile({
      parentId: folder.id,
      name: "hello.pdf",
      data: makePdf("Hello Documents PDF"),
    });
    expect(pdf.kind).toBe("file");
    expect(pdf.file!.mime).toBe("application/pdf");
    expect(pdf.file!.extractStatus).toBe("ok");
    expect(store.getExtracted(pdf.id)).toContain("Hello Documents PDF");
    expect(store.originalPath(pdf.id)).toMatch(/original\.pdf$/);

    const docx = await svc.uploadFile({
      parentId: folder.id,
      name: "plan.docx",
      data: await makeDocx(),
    });
    const docxText = store.getExtracted(docx.id);
    expect(docxText).toContain("# Quarterly Plan");
    expect(docxText).toContain("Revenue & growth");
    expect(docxText).toContain("- First bullet");
    expect(docxText).toContain("| APAC | 42 |");

    const xlsx = await svc.uploadFile({
      parentId: folder.id,
      name: "leads.xlsx",
      data: await makeXlsx(),
    });
    const xlsxText = store.getExtracted(xlsx.id);
    expect(xlsxText).toContain("## Leads");
    expect(xlsxText).toContain("| Ada \\| Co | 97 |");

    const pptx = await svc.uploadFile({
      parentId: folder.id,
      name: "deck.pptx",
      data: await makePptx(),
    });
    expect(store.getExtracted(pptx.id)).toContain("## Slide 1: Launch deck");
    expect(store.getExtracted(pptx.id)).toContain("- Ship it");

    const csv = await svc.uploadFile({
      parentId: folder.id,
      name: "t.csv",
      data: Buffer.from("a,b\n1,2\n"),
    });
    expect(store.getExtracted(csv.id)).toContain("| 1 | 2 |");

    const md = await svc.uploadFile({
      parentId: folder.id,
      name: "Readme.md",
      data: Buffer.from("# Hi\n\ntext"),
    });
    expect(md.kind).toBe("doc");
    expect(md.title).toBe("Readme");
    expect(store.getBody(md.id)).toBe("# Hi\n\ntext");

    const mp3 = await svc.uploadFile({
      parentId: folder.id,
      name: "voice.mp3",
      data: Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0, 1, 2, 3]),
    });
    expect(mp3.file!.mime).toBe("audio/mpeg");
    expect(mp3.file!.extractStatus).toBe("none");

    expect(store.search("growth")[0]!.id).toBe(docx.id);
  });

  it("rejects executables (by extension and by magic bytes) and trusts bytes over names", async () => {
    const svc = await import("./service.js");
    await expect(
      svc.uploadFile({ name: "setup.exe", data: Buffer.from("MZ....") }),
    ).rejects.toThrow(/not allowed/);
    await expect(
      svc.uploadFile({ name: "invoice.pdf", data: Buffer.from("MZ\x90\x00binary") }),
    ).rejects.toThrow(/Executable/);
    await expect(svc.uploadFile({ name: "empty.txt", data: Buffer.alloc(0) })).rejects.toThrow(
      /Empty/,
    );
    const png = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489",
      "hex",
    );
    const disguised = await svc.uploadFile({ name: "notes.pdf", data: png });
    expect(disguised.file!.mime).toBe("image/png");
  });

  it("blocks uploads from a local path when hosted", async () => {
    const svc = await import("./service.js");
    const tmp = path.join(stateDir, "local.txt");
    fs.writeFileSync(tmp, "local file");
    const node = await svc.uploadFromPath({ path: tmp });
    expect(node.kind).toBe("doc");
    process.env.SAAS_MODE = "1";
    try {
      await expect(svc.uploadFromPath({ path: tmp })).rejects.toThrow(/hosted/);
    } finally {
      delete process.env.SAAS_MODE;
    }
  });
});

describe("notes tool — document actions", () => {
  it("drives the workspace end to end through the agent tool", async () => {
    const { createNotesTool } = await import("../agents/tools/notes-tool.js");
    const tool = createNotesTool({ agentId: "tester" });
    const call = async (args: Record<string, unknown>) => {
      const res = (await tool.execute("t", args as never)) as {
        details?: unknown;
        content?: Array<{ text?: string }>;
      };
      const text = res.content?.[0]?.text ?? JSON.stringify(res.details);
      return JSON.parse(text) as Record<string, any>;
    };

    const folder = await call({ action: "create_folder", title: "Agent Research" });
    expect(folder.status).toBe("ok");
    const fid = folder.node.id as string;
    const doc = await call({
      action: "create_doc",
      title: "Findings",
      body: "# Findings\n\nsee [[Roadmap]]",
      parentId: fid,
    });
    expect(doc.path).toBe("Agent Research / Findings");
    const did = doc.node.id as string;
    await call({ action: "append_doc", id: did, body: "- more evidence" });
    await call({ action: "create_doc", title: "Roadmap", body: "plan" });
    const read = await call({ action: "read", id: did });
    expect(read.markdown).toContain("- more evidence");

    const roadmapId = (await call({ action: "doc_search", query: "roadmap" })).hits.find(
      (h: any) => h.title === "Roadmap",
    ).id;
    const back = await call({ action: "read", id: roadmapId });
    expect(back.backlinks.map((b: any) => b.id)).toContain(did);

    const tree = await call({ action: "tree" });
    expect(tree.outline).toContain("📁 Agent Research");
    expect(tree.outline).toMatch(/\n?\s+📄 Findings/);

    await call({ action: "update_doc", id: did, properties: JSON.stringify({ Status: "Done" }) });
    const folderRead = await call({ action: "read", id: fid });
    expect(folderRead.children[0].properties.Status).toBe("Done");

    await call({ action: "move_doc", id: did });
    expect((await call({ action: "read", id: did })).path).toBe("Findings");
    await call({ action: "delete_doc", id: did });
    expect((await call({ action: "doc_search", query: "evidence" })).count).toBe(0);
    await call({ action: "restore_doc", id: did });
    expect((await call({ action: "doc_search", query: "evidence" })).count).toBe(1);
    const hist = await call({ action: "doc_history", id: did });
    expect(hist.revisions.length).toBeGreaterThan(0);

    // Legacy note actions still work alongside.
    const legacy = await call({ action: "create", name: "Legacy note", body: "still works" });
    expect(legacy.status).toBe("ok");
  });

  it("parses Notion ids from raw ids and URLs", async () => {
    const { parseNotionIds } = await import("../agents/tools/documents-actions.js");
    expect(
      parseNotionIds(
        "https://www.notion.so/team/Roadmap-0123456789abcdef0123456789abcdef?pvs=4, 01234567-89ab-cdef-0123-456789abcdee",
      ),
    ).toEqual(["0123456789abcdef0123456789abcdef", "0123456789abcdef0123456789abcdee"]);
  });
});
