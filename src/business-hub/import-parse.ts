/**
 * Business hub imports — file parsing and column auto-mapping.
 *
 * Formats: CSV/TSV (RFC 4180, delimiter sniffed), XLSX (first sheet, via
 * jszip), vCard 2.1/3.0/4.0 and the Google Contacts / Outlook CSV exports
 * (handled by the CSV path + header synonyms). Output is always a header row
 * plus string rows, so the mapping UI treats every format the same way.
 */

import JSZip from "jszip";

export type ImportFormat = "csv" | "xlsx" | "vcard";

export type ParsedTable = { format: ImportFormat; headers: string[]; rows: string[][] };

export const MAX_IMPORT_ROWS = 50_000;

export function detectFormat(fileName: string, bytes: Uint8Array): ImportFormat {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".xlsx") || (bytes[0] === 0x50 && bytes[1] === 0x4b)) return "xlsx";
  if (lower.endsWith(".vcf") || lower.endsWith(".vcard")) return "vcard";
  const head = new TextDecoder().decode(bytes.slice(0, 200)).trimStart().toUpperCase();
  if (head.startsWith("BEGIN:VCARD")) return "vcard";
  return "csv";
}

export async function parseImportFile(fileName: string, bytes: Uint8Array): Promise<ParsedTable> {
  const format = detectFormat(fileName, bytes);
  if (format === "xlsx") return parseXlsx(bytes);
  const text = decodeText(bytes);
  if (format === "vcard") return parseVcards(text);
  return { format, ...parseCsv(text) };
}

function decodeText(bytes: Uint8Array): string {
  // UTF-16 exports (Outlook) carry a BOM; default to UTF-8.
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  return new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "");
}

// ── CSV ───────────────────────────────────────────────────────────────────────

function sniffDelimiter(text: string): string {
  const firstLine = text.slice(0, text.indexOf("\n") >= 0 ? text.indexOf("\n") : text.length);
  const counts = [",", ";", "\t", "|"].map((d) => [d, firstLine.split(d).length - 1] as const);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ",";
}

export function parseCsv(
  text: string,
  delimiter = sniffDelimiter(text),
): { headers: string[]; rows: string[][] } {
  const out: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === "") quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((c) => c.trim() !== "")) out.push(row);
      row = [];
      if (out.length > MAX_IMPORT_ROWS) break;
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== "")) out.push(row);
  const headers = (out.shift() ?? []).map((h, i) => h.trim() || `Column ${i + 1}`);
  return {
    headers: dedupeHeaders(headers),
    rows: out.map((r) => headers.map((_, i) => (r[i] ?? "").trim())),
  };
}

function dedupeHeaders(headers: string[]): string[] {
  const seen = new Map<string, number>();
  return headers.map((h) => {
    const n = (seen.get(h) ?? 0) + 1;
    seen.set(h, n);
    return n === 1 ? h : `${h} (${n})`;
  });
}

// ── XLSX ──────────────────────────────────────────────────────────────────────

function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

function colIndex(ref: string): number {
  const letters = ref.replace(/\d+/g, "");
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Excel serial date → ISO date (1900 date system). */
function excelDate(serial: number): string {
  const ms = Math.round((serial - 25569) * 86_400_000);
  return new Date(ms).toISOString().slice(0, 10);
}

export async function parseXlsx(bytes: Uint8Array): Promise<ParsedTable> {
  const zip = await JSZip.loadAsync(bytes);
  const shared: string[] = [];
  const sst = await zip.file("xl/sharedStrings.xml")?.async("string");
  if (sst) {
    for (const si of sst.match(/<si>[\s\S]*?<\/si>/g) ?? []) {
      shared.push(
        xmlUnescape(
          (si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) ?? [])
            .map((t) => t.replace(/<[^>]+>/g, ""))
            .join(""),
        ),
      );
    }
  }
  // Date-formatted cell styles (numFmtId 14–22 or custom formats with d/m/y).
  const dateStyles = new Set<number>();
  const styles = await zip.file("xl/styles.xml")?.async("string");
  if (styles) {
    const customDate = new Set<string>();
    for (const m of styles.matchAll(/<numFmt numFmtId="(\d+)" formatCode="([^"]*)"/g))
      if (/[dmy]/i.test(m[2]) && !/0\.0/.test(m[2])) customDate.add(m[1]);
    const xfs = styles.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? "";
    [...xfs.matchAll(/<xf [^>]*numFmtId="(\d+)"/g)].forEach((m, i) => {
      const id = Number(m[1]);
      if ((id >= 14 && id <= 22) || customDate.has(m[1])) dateStyles.add(i);
    });
  }
  const wb = (await zip.file("xl/workbook.xml")?.async("string")) ?? "";
  const rels = (await zip.file("xl/_rels/workbook.xml.rels")?.async("string")) ?? "";
  const firstRid = wb.match(/<sheet [^>]*r:id="([^"]+)"/)?.[1];
  const target = firstRid
    ? (rels.match(new RegExp(`Id="${firstRid}"[^>]*Target="([^"]+)"`))?.[1] ??
      rels.match(new RegExp(`Target="([^"]+)"[^>]*Id="${firstRid}"`))?.[1])
    : null;
  const path = target ? `xl/${target.replace(/^\/?xl\//, "")}` : "xl/worksheets/sheet1.xml";
  const sheet =
    (await zip.file(path)?.async("string")) ??
    (await zip.file("xl/worksheets/sheet1.xml")?.async("string"));
  if (!sheet) throw new Error("the workbook has no readable sheet");
  const table: string[][] = [];
  for (const rowXml of sheet.match(/<row[^>]*>[\s\S]*?<\/row>|<row[^>]*\/>/g) ?? []) {
    const cells: string[] = [];
    for (const c of rowXml.match(/<c [^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) ?? []) {
      const ref = c.match(/ r="([A-Z]+\d+)"/)?.[1];
      const t = c.match(/ t="([^"]+)"/)?.[1];
      const s = Number(c.match(/ s="(\d+)"/)?.[1] ?? -1);
      const v = c.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      let val = "";
      if (t === "s" && v !== undefined) val = shared[Number(v)] ?? "";
      else if (t === "inlineStr")
        val = xmlUnescape(
          (c.match(/<t[^>]*>([\s\S]*?)<\/t>/g) ?? [])
            .map((x) => x.replace(/<[^>]+>/g, ""))
            .join(""),
        );
      else if (t === "b") val = v === "1" ? "TRUE" : "FALSE";
      else if (v !== undefined) {
        val = xmlUnescape(v);
        if (dateStyles.has(s) && /^\d+(\.\d+)?$/.test(val)) val = excelDate(Number(val));
      }
      const idx = ref ? colIndex(ref) : cells.length;
      while (cells.length < idx) cells.push("");
      cells[idx] = val.trim();
    }
    if (cells.some((x) => x !== "")) table.push(cells);
    if (table.length > MAX_IMPORT_ROWS) break;
  }
  const headers = dedupeHeaders((table.shift() ?? []).map((h, i) => h || `Column ${i + 1}`));
  return { format: "xlsx", headers, rows: table.map((r) => headers.map((_, i) => r[i] ?? "")) };
}

// ── vCard ─────────────────────────────────────────────────────────────────────

const VCARD_HEADERS = [
  "Full name",
  "First name",
  "Last name",
  "Email",
  "Email 2",
  "Phone",
  "Phone 2",
  "Organization",
  "Title",
  "Website",
  "Street",
  "City",
  "Region",
  "Postal code",
  "Country",
  "Notes",
  "Categories",
  "Birthday",
];

function decodeQp(s: string): string {
  const bytes: number[] = [];
  const raw = s.replace(/=\r?\n/g, "");
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "=" && /^[0-9A-F]{2}$/i.test(raw.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(raw.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(raw.charCodeAt(i));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function vUnescape(s: string): string {
  return s.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
}

export function parseVcards(text: string): ParsedTable {
  // Unfold continuation lines (RFC 6350 §3.2) — QP soft breaks handled in decodeQp.
  const unfolded = text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
  const rows: string[][] = [];
  for (const block of unfolded.split(/BEGIN:VCARD/i).slice(1)) {
    const rec: Record<string, string[]> = {};
    for (const line of block.split("\n")) {
      const m = line.match(/^(?:item\d+\.)?([A-Za-z-]+)((?:;[^:]*)?):(.*)$/);
      if (!m) continue;
      const key = m[1].toUpperCase();
      if (key === "END") break;
      let value = m[3];
      if (/ENCODING=QUOTED-PRINTABLE/i.test(m[2])) value = decodeQp(value);
      (rec[key] ??= []).push(value);
    }
    const n = (rec.N?.[0] ?? "").split(";").map(vUnescape);
    const adr = (rec.ADR?.[0] ?? "").split(";").map(vUnescape);
    const clean = (v: string | undefined) =>
      vUnescape((v ?? "").replace(/^(mailto|tel):/i, "")).trim();
    rows.push([
      clean(rec.FN?.[0]) || [n[1], n[0]].filter(Boolean).join(" "),
      n[1] ?? "",
      n[0] ?? "",
      clean(rec.EMAIL?.[0]),
      clean(rec.EMAIL?.[1]),
      clean(rec.TEL?.[0]),
      clean(rec.TEL?.[1]),
      clean(rec.ORG?.[0]?.split(";")[0]),
      clean(rec.TITLE?.[0]),
      clean(rec.URL?.[0]),
      adr[2] ?? "",
      adr[3] ?? "",
      adr[4] ?? "",
      adr[5] ?? "",
      adr[6] ?? "",
      clean(rec.NOTE?.[0]),
      clean(rec.CATEGORIES?.[0]),
      clean(rec.BDAY?.[0]),
    ]);
    if (rows.length > MAX_IMPORT_ROWS) break;
  }
  return { format: "vcard", headers: VCARD_HEADERS, rows };
}

// ── Column auto-mapping ───────────────────────────────────────────────────────

/** Hub fields a column can map to (plus `custom:<key>` and `ignore`). */
export const IMPORT_FIELDS = [
  "name",
  "firstName",
  "lastName",
  "email",
  "email2",
  "phone",
  "phone2",
  "title",
  "company",
  "website",
  "industry",
  "address",
  "city",
  "region",
  "postalCode",
  "country",
  "tags",
  "notes",
  "lifecycle",
  "score",
  "linkedin",
  "instagram",
  "facebook",
  "twitter",
  "dealValue",
  "dealStage",
  "source",
  "optIn",
  "createdAt",
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];
export type ColumnMapping = Record<string, ImportField | `custom:${string}` | "ignore">;

const SYNONYMS: Array<[ImportField, RegExp]> = [
  ["email2", /^(e-?mail ?2( - value)?|secondary e-?mail|other e-?mail|email address 2)$/],
  [
    "email",
    /^(e-?mail( address)?|e-?mail ?1( - value)?|primary e-?mail|work e-?mail|business e-?mail|mail|courriel|correo)$/,
  ],
  ["phone2", /^(phone ?2( - value)?|mobile phone|other phone|home phone)$/],
  [
    "phone",
    /^(phone( number)?|phone ?1( - value)?|tel(ephone)?|mobile|cell( phone)?|business phone|primary phone|whatsapp|telefono|téléphone)$/,
  ],
  ["firstName", /^(first ?name|given ?name|forename|first|prénom|nombre)$/],
  ["lastName", /^(last ?name|surname|family ?name|last|nom|apellido)$/],
  [
    "name",
    /^(full ?name|name|contact( name)?|display ?name|customer( name)?|lead( name)?|client( name)?)$/,
  ],
  [
    "company",
    /^(company( name)?|organi[sz]ation( name| 1 - name)?|business( name)?|account( name)?|employer|firm|org)$/,
  ],
  ["title", /^((job )?title|position|role|organi[sz]ation 1 - title|job)$/],
  ["website", /^(website|web ?site|url|domain|homepage|web|website 1 - value|company website)$/],
  ["industry", /^(industry|category|sector|vertical|niche)$/],
  ["address", /^(address|street( address)?|address 1 - street|mailing street|address line 1)$/],
  ["city", /^(city|town|address 1 - city|locality|mailing city)$/],
  ["region", /^(state|region|province|county|address 1 - region|mailing state)$/],
  ["postalCode", /^(zip( ?code)?|postal ?code|postcode|address 1 - postal code)$/],
  ["country", /^(country|nation|address 1 - country|mailing country)$/],
  ["tags", /^(tags?|labels?|groups?|group membership|categories|segments?|lists?)$/],
  ["notes", /^(notes?|comments?|description|remarks)$/],
  ["lifecycle", /^(lifecycle( stage)?|status|lead status|type)$/],
  ["score", /^((lead )?score|rating)$/],
  ["linkedin", /^(linkedin( url| profile)?)$/],
  ["instagram", /^(instagram( handle)?)$/],
  ["facebook", /^(facebook( url)?)$/],
  ["twitter", /^(twitter|x( handle)?)$/],
  ["dealValue", /^(deal value|value|amount|revenue|deal amount|estimated value|ltv)$/],
  ["dealStage", /^(stage|deal stage|pipeline stage)$/],
  ["source", /^(source|lead source|origin|channel|utm source)$/],
  [
    "optIn",
    /^(opt[ -]?in|subscribed|consent|marketing consent|accepts marketing|email marketing)$/,
  ],
  ["createdAt", /^(created( at| date)?|date added|signup date|joined)$/],
];

/** Guess a mapping from headers, and from the data when a header is unhelpful. */
export function autoMap(headers: string[], sample: string[][]): ColumnMapping {
  const mapping: ColumnMapping = {};
  const used = new Set<string>();
  headers.forEach((h, i) => {
    const key = h.toLowerCase().replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
    let field: ImportField | null = null;
    for (const [f, re] of SYNONYMS) {
      if (re.test(key) && !used.has(f)) {
        field = f;
        break;
      }
    }
    if (!field) {
      const values = sample
        .map((r) => r[i] ?? "")
        .filter(Boolean)
        .slice(0, 20);
      const share = (re: RegExp) =>
        values.length ? values.filter((v) => re.test(v)).length / values.length : 0;
      if (!used.has("email") && share(/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i) > 0.6) field = "email";
      else if (!used.has("phone") && share(/^\+?[\d\s().-]{7,20}$/) > 0.6) field = "phone";
      else if (!used.has("website") && share(/^(https?:\/\/)?[\w-]+(\.[\w-]+)+(\/\S*)?$/i) > 0.6)
        field = "website";
    }
    if (field) {
      used.add(field);
      mapping[h] = field;
    } else {
      mapping[h] = sample.some((r) => (r[i] ?? "").trim())
        ? `custom:${h
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "_")
            .replace(/^_|_$/g, "")}`
        : "ignore";
    }
  });
  return mapping;
}
