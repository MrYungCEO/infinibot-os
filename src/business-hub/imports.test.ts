import JSZip from "jszip";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getContact, listContacts, listCompanies, timeline, upsertContact } from "./contacts.js";
import { openHubDb } from "./db.js";
import { autoMap, parseCsv, parseVcards, parseXlsx } from "./import-parse.js";
import { commitImport, previewImport, revalidateImport, undoImport } from "./imports.js";
import { listDeals } from "./pipeline.js";

const enc = (s: string) => new TextEncoder().encode(s);
const tmp = () => mkdtempSync(join(tmpdir(), "hub-imp-"));

const GOOGLE_CSV = `Name,Given Name,Family Name,E-mail 1 - Value,Phone 1 - Value,Organization 1 - Name,Organization 1 - Title,Labels,Website 1 - Value
Ada Lovelace,Ada,Lovelace,ADA@analytical.example.com,(212) 555-0100,Analytical Engines,CEO,* myContacts ::: VIP,analytical.example.com
"Grace Hopper, PhD",Grace,Hopper,grace@navy.example.org,,US Navy,Admiral,* myContacts,
Bad Row,,,not-an-email,12,,,,
,,,,,,,,
Ada L,,,ada@analytical.example.com,,,,,`;

describe("parsers", () => {
  it("parses quoted CSV and sniffs semicolons", () => {
    const t = parseCsv('a;b\n"x;1";"he said ""hi"""\n');
    expect(t.headers).toEqual(["a", "b"]);
    expect(t.rows).toEqual([["x;1", 'he said "hi"']]);
  });

  it("auto-maps Google Contacts export headers", () => {
    const t = parseCsv(GOOGLE_CSV);
    const m = autoMap(t.headers, t.rows);
    expect(m["E-mail 1 - Value"]).toBe("email");
    expect(m["Phone 1 - Value"]).toBe("phone");
    expect(m["Given Name"]).toBe("firstName");
    expect(m["Family Name"]).toBe("lastName");
    expect(m["Organization 1 - Name"]).toBe("company");
    expect(m["Organization 1 - Title"]).toBe("title");
    expect(m.Labels).toBe("tags");
    expect(m["Website 1 - Value"]).toBe("website");
  });

  it("auto-maps unlabeled columns from their data", () => {
    const m = autoMap(
      ["Col A", "Col B"],
      [
        ["x@y.com", "+1 555 222 3333"],
        ["z@y.com", "555-111-2222"],
      ],
    );
    expect(m).toEqual({ "Col A": "email", "Col B": "phone" });
  });

  it("parses vCards incl. folding, QP and multiple emails", () => {
    const t = parseVcards(
      "BEGIN:VCARD\r\nVERSION:2.1\r\nN:Doe;Jane;;;\r\nFN:Jane Doe\r\nEMAIL;TYPE=work:jane@example.com\r\nEMAIL:j.doe@example.net\r\nTEL;CELL:+1 555 0100\r\nORG:Doe Co;Sales\r\nNOTE;ENCODING=QUOTED-PRINTABLE:Caf=C3=A9 owner\r\nCATEGORIES:VIP,Leads\r\nEND:VCARD\r\nBEGIN:VCARD\r\nVERSION:3.0\r\nFN:Long\r\n  Name\r\nEND:VCARD\r\n",
    );
    expect(t.rows[0].slice(0, 9)).toEqual([
      "Jane Doe",
      "Jane",
      "Doe",
      "jane@example.com",
      "j.doe@example.net",
      "+1 555 0100",
      "",
      "Doe Co",
      "",
    ]);
    expect(t.rows[0][15]).toBe("Café owner");
    expect(t.rows[1][0]).toBe("Long Name");
    expect(autoMap(t.headers, t.rows).Categories).toBe("tags");
  });

  it("parses the first XLSX sheet with shared + inline strings and dates", async () => {
    const zip = new JSZip();
    zip.file(
      "xl/workbook.xml",
      '<workbook><sheets><sheet name="Leads" sheetId="1" r:id="rId1"/></sheets></workbook>',
    );
    zip.file(
      "xl/_rels/workbook.xml.rels",
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    );
    zip.file(
      "xl/sharedStrings.xml",
      "<sst><si><t>Email</t></si><si><t>Company</t></si><si><t>Joined</t></si><si><t>a@b.co</t></si><si><r><t>Acme </t></r><r><t>&amp; Sons</t></r></si></sst>",
    );
    zip.file(
      "xl/styles.xml",
      '<styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>',
    );
    zip.file(
      "xl/worksheets/sheet1.xml",
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row><row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2" t="s"><v>4</v></c><c r="C2" s="1"><v>45200</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>c@d.co</t></is></c><c r="C3"><v>7</v></c></row></sheetData></worksheet>',
    );
    const t = await parseXlsx(await zip.generateAsync({ type: "uint8array" }));
    expect(t.headers).toEqual(["Email", "Company", "Joined"]);
    expect(t.rows).toEqual([
      ["a@b.co", "Acme & Sons", "2023-10-01"],
      ["c@d.co", "", "7"],
    ]);
  });
});

describe("import flow", () => {
  it("previews with a validation report, commits with dedupe + tags, and undoes", async () => {
    const db = openHubDb(":memory:");
    const dir = tmp();
    // An existing contact that the import should update (fill), not duplicate.
    const pre = upsertContact(db, {
      name: "Grace",
      email: "grace@navy.example.org",
      tags: ["existing"],
    })!.contact;
    const { batch, headers } = await previewImport(db, dir, {
      fileName: "google.csv",
      bytes: enc(GOOGLE_CSV),
      options: { tags: ["imported-oct"], createDeals: true },
    });
    expect(headers).toContain("E-mail 1 - Value");
    const r = batch.report!;
    expect(r.total).toBe(4);
    expect(r.errors).toBe(0); // "Bad Row" has a name, so it is valid with warnings
    expect(r.invalidEmails).toBe(1);
    expect(r.invalidPhones).toBe(1);
    expect(r.duplicatesInFile).toBe(1);
    expect(r.willUpdate).toBe(1);
    expect(r.willCreate).toBe(2);

    const done = commitImport(db, dir, batch.id);
    expect(done.status).toBe("committed");
    expect(done.created).toBe(2);
    expect(done.updated).toBe(1);
    expect(listContacts(db).total).toBe(3);
    const ada = listContacts(db, { search: "ada" }).contacts[0];
    expect(ada.email).toBe("ada@analytical.example.com");
    expect(ada.phoneE164).toBe("+12125550100");
    expect(ada.tags?.sort()).toEqual(["VIP", "imported-oct"]);
    expect(ada.companyName).toBe("Analytical Engines");
    const grace = getContact(db, pre.id)!;
    expect(grace.title).toBe("Admiral");
    expect(grace.tags?.sort()).toEqual(["existing", "imported-oct"]);
    expect(listDeals(db).total).toBe(3);
    expect(timeline(db, "contact", ada.id)[0]).toBeTruthy();

    const undone = undoImport(db, batch.id);
    expect(undone.undo).toEqual({ deleted: 2, restored: 1 });
    expect(listContacts(db).total).toBe(1);
    const back = getContact(db, pre.id)!;
    expect(back.title).toBeNull();
    expect(back.tags).toEqual(["existing"]);
    expect(listCompanies(db).total).toBe(0);
    expect(listDeals(db).total).toBe(0);
    expect(() => undoImport(db, batch.id)).toThrow(/undone/);
  });

  it("skip strategy leaves existing contacts untouched; mapping edits re-validate", async () => {
    const db = openHubDb(":memory:");
    const dir = tmp();
    upsertContact(db, { name: "Old", email: "x@example.com", title: "Keep" });
    const csv = "who,mail,job\nNew Name,x@example.com,Change\nOther,o@example.com,Dev\n";
    const { batch } = await previewImport(db, dir, { fileName: "l.csv", bytes: enc(csv) });
    expect(batch.mapping.who).toBe("custom:who");
    const re = revalidateImport(
      db,
      dir,
      batch.id,
      { who: "name", mail: "email", job: "title" },
      { strategy: "skip" },
    );
    expect(re.report?.willUpdate).toBe(1);
    const done = commitImport(db, dir, batch.id);
    expect(done).toMatchObject({ created: 1, skipped: 1 });
    expect(listContacts(db, { search: "x@example.com" }).contacts[0].title).toBe("Keep");
  });
});
