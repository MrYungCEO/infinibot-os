/**
 * Upload validation + text extraction for the documents workspace.
 *
 * Every uploaded original is stored as-is and never executed. Text is pulled
 * out into a markdown companion so search and agents can read it:
 *   - PDF            pdfjs-dist (via files/convert.ts), `pdftotext` fallback when installed
 *   - DOCX           word/document.xml via jszip (headings, lists, tables)
 *   - XLSX           sheets → GFM tables (capped)
 *   - PPTX           slide text, one section per slide
 *   - CSV/TSV/TXT/MD/code/JSON/YAML  files/convert.ts
 *   - HTML           tags stripped
 *   - ZIP            entry listing
 *   - Images         OCR via `tesseract` only when the binary is installed
 *   - Audio/video    no text (metadata only)
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { convertToMarkdown } from "../files/convert.js";
import { documentsLimits } from "./tenant-limits.js";

const execFileAsync = promisify(execFile);

/** Per-file upload cap: 200 MB self-hosted, 25 MB for SaaS tenants (tenant-limits.ts). */
export const DOCUMENTS_MAX_UPLOAD_BYTES = documentsLimits().maxUploadBytes;
/** Cap on extracted text kept per file. */
export const EXTRACT_MAX_CHARS = 2_000_000;
const TABLE_MAX_ROWS = 500;

const EXT_MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".ppt": "application/vnd.ms-powerpoint",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".odp": "application/vnd.oasis.opendocument.presentation",
  ".rtf": "application/rtf",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".json": "application/json",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".xml": "application/xml",
  ".html": "text/html",
  ".htm": "text/html",
  ".log": "text/plain",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".heic": "image/heic",
  ".avif": "image/avif",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
  ".opus": "audio/opus",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".zip": "application/zip",
  ".epub": "application/epub+zip",
};

const CODE_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".rb",
  ".php",
  ".java",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".swift",
  ".kt",
  ".sh",
  ".bash",
  ".zsh",
  ".sql",
  ".graphql",
  ".proto",
  ".toml",
  ".ini",
  ".css",
  ".scss",
  ".vue",
  ".svelte",
]);

/** Extensions that are refused outright (executables / installers / scripts run by the OS). */
const BLOCKED_EXTS = new Set([
  ".exe",
  ".dll",
  ".msi",
  ".bat",
  ".cmd",
  ".com",
  ".scr",
  ".pif",
  ".vbs",
  ".vbe",
  ".js.exe",
  ".jar",
  ".app",
  ".dmg",
  ".pkg",
  ".deb",
  ".rpm",
  ".apk",
  ".appimage",
  ".so",
  ".dylib",
  ".ps1",
  ".psm1",
  ".lnk",
  ".reg",
  ".hta",
  ".msc",
  ".cpl",
  ".gadget",
  ".wsf",
]);

/** Magic-number detected types that are refused regardless of extension. */
const BLOCKED_SNIFFED = new Set([
  "exe",
  "elf",
  "mach",
  "msi",
  "dmg",
  "deb",
  "rpm",
  "apk",
  "macho",
  "cab",
]);

export function mimeForExt(ext: string): string {
  return (
    EXT_MIME[ext.toLowerCase()] ??
    (CODE_EXTS.has(ext.toLowerCase()) ? "text/plain" : "application/octet-stream")
  );
}

export type UploadCategory =
  | "pdf"
  | "image"
  | "audio"
  | "video"
  | "text"
  | "office"
  | "archive"
  | "other";

export function categoryFor(ext: string, mime: string): UploadCategory {
  const e = ext.toLowerCase();
  if (e === ".pdf" || mime === "application/pdf") return "pdf";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (
    [
      ".docx",
      ".doc",
      ".xlsx",
      ".xls",
      ".pptx",
      ".ppt",
      ".odt",
      ".ods",
      ".odp",
      ".rtf",
      ".epub",
    ].includes(e)
  ) {
    return "office";
  }
  if (e === ".zip") return "archive";
  if (
    mime.startsWith("text/") ||
    CODE_EXTS.has(e) ||
    [".json", ".xml", ".yaml", ".yml"].includes(e)
  )
    return "text";
  return "other";
}

export interface ValidatedUpload {
  name: string;
  ext: string;
  mime: string;
  category: UploadCategory;
}

/**
 * Validate an upload: size limit, blocked extensions, and magic-number sniffing
 * (an executable renamed to `.pdf` is refused; a declared type that disagrees
 * with the sniffed container is corrected to the sniffed one).
 */
export async function validateUpload(
  name: string,
  data: Buffer,
  declaredMime?: string,
): Promise<ValidatedUpload> {
  const cleanName =
    path
      .basename(name || "upload")
      .replace(/[\u0000-\u001f]/g, "")
      .slice(0, 200) || "upload";
  if (data.length === 0) throw new Error("Empty file");
  if (data.length > DOCUMENTS_MAX_UPLOAD_BYTES) {
    throw new Error(`File too large: ${data.length} bytes (limit ${DOCUMENTS_MAX_UPLOAD_BYTES})`);
  }
  let ext = path.extname(cleanName).toLowerCase();
  if (BLOCKED_EXTS.has(ext)) throw new Error(`File type ${ext} is not allowed`);
  let sniffed: { ext: string; mime: string } | undefined;
  try {
    const { fileTypeFromBuffer } = await import("file-type");
    sniffed = await fileTypeFromBuffer(data.subarray(0, 64 * 1024));
  } catch {
    sniffed = undefined;
  }
  if (sniffed && BLOCKED_SNIFFED.has(sniffed.ext)) {
    throw new Error("Executable content is not allowed");
  }
  if (
    data.subarray(0, 2).toString("latin1") === "MZ" ||
    data.subarray(0, 4).toString("latin1") === "\x7fELF"
  ) {
    throw new Error("Executable content is not allowed");
  }
  let mime = mimeForExt(ext);
  if (sniffed) {
    // OOXML/ODF/EPUB are zip containers; file-type may report plain "zip".
    const zipContainer = [".docx", ".xlsx", ".pptx", ".odt", ".ods", ".odp", ".epub"].includes(ext);
    const agrees =
      sniffed.mime === mime || (zipContainer && sniffed.ext === "zip") || sniffed.ext === "xml";
    if (!agrees) {
      // Trust the bytes over the name: a PNG renamed .pdf is served as a PNG.
      mime = sniffed.mime;
      if (!ext) ext = `.${sniffed.ext}`;
    }
  } else if (
    mime === "application/octet-stream" &&
    declaredMime &&
    /^(text|image|audio|video)\//.test(declaredMime)
  ) {
    mime = declaredMime;
  }
  return { name: cleanName, ext, mime, category: categoryFor(ext, mime) };
}

// ── Extraction ───────────────────────────────────────────────

export interface ExtractResult {
  markdown: string | null;
  status: "ok" | "none" | "error";
  error?: string;
}

async function loadZip(data: Buffer) {
  const JSZip = (await import("jszip")).default;
  return JSZip.loadAsync(data);
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function mdTable(rows: string[][]): string {
  if (!rows.length) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) => Array.from({ length: width }, (_, i) => cell(r[i] ?? ""));
  const [head, ...body] = rows;
  const lines = [`| ${pad(head!).join(" | ")} |`, `| ${Array(width).fill("---").join(" | ")} |`];
  for (const r of body.slice(0, TABLE_MAX_ROWS)) lines.push(`| ${pad(r).join(" | ")} |`);
  if (body.length > TABLE_MAX_ROWS)
    lines.push(`\n_Showing first ${TABLE_MAX_ROWS} of ${body.length} rows._`);
  return lines.join("\n");
}

export async function docxToMarkdown(data: Buffer): Promise<string> {
  const zip = await loadZip(data);
  const xml = await zip.file("word/document.xml")?.async("string");
  if (!xml) return "";
  const out: string[] = [];
  const bodyXml = xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g, (tbl) => {
    const rows = [...tbl.matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)].map((tr) =>
      [...tr[0].matchAll(/<w:tc[ >][\s\S]*?<\/w:tc>/g)].map((tc) =>
        decodeXml(
          [...tc[0].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]).join(""),
        ),
      ),
    );
    return `<w:p><w:r><w:t>\u0000TABLE${Buffer.from(JSON.stringify(rows)).toString("base64")}</w:t></w:r></w:p>`;
  });
  for (const pm of bodyXml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)) {
    const para = pm[0];
    const text = decodeXml(
      [...para.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g)]
        .map((m) => (m[0].startsWith("<w:tab") ? "\t" : m[0].startsWith("<w:br") ? "\n" : m[1]))
        .join(""),
    ).trim();
    if (!text) continue;
    if (text.startsWith("\u0000TABLE")) {
      out.push(mdTable(JSON.parse(Buffer.from(text.slice(6), "base64").toString())));
      continue;
    }
    const style = /<w:pStyle w:val="([^"]+)"/.exec(para)?.[1]?.toLowerCase() ?? "";
    const heading = /^(?:heading|berschrift|titre)\s*(\d)$/.exec(style.replace(/\s+/g, " "));
    if (style === "title") out.push(`# ${text}`);
    else if (heading) out.push(`${"#".repeat(Math.min(6, Number(heading[1])))} ${text}`);
    else if (/<w:numPr>/.test(para) || /list/.test(style)) {
      const lvl = Number(/<w:ilvl w:val="(\d+)"/.exec(para)?.[1] ?? 0);
      out.push(`${"  ".repeat(lvl)}- ${text}`);
    } else out.push(text);
  }
  // Join list items tightly, everything else as paragraphs.
  return out
    .map((l, i) =>
      i > 0 && /^\s*- /.test(l) && /^\s*- /.test(out[i - 1]!) ? `\n${l}` : `\n\n${l}`,
    )
    .join("")
    .trim();
}

export async function xlsxToMarkdown(data: Buffer): Promise<string> {
  const zip = await loadZip(data);
  const sharedXml = (await zip.file("xl/sharedStrings.xml")?.async("string")) ?? "";
  const shared = [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    decodeXml([...m[1]!.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")),
  );
  const wb = (await zip.file("xl/workbook.xml")?.async("string")) ?? "";
  const names = [...wb.matchAll(/<sheet [^>]*name="([^"]+)"/g)].map((m) => decodeXml(m[1]!));
  const sheetFiles = Object.keys(zip.files)
    .filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
  const parts: string[] = [];
  for (const [i, f] of sheetFiles.entries()) {
    const xml = (await zip.file(f)!.async("string")) ?? "";
    const rows: string[][] = [];
    for (const rm of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const row: string[] = [];
      for (const cm of rm[1]!.matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cm[1]!;
        const ref = /r="([A-Z]+)\d+"/.exec(attrs)?.[1];
        const col = ref ? colIndex(ref) : row.length;
        const inner = cm[2] ?? "";
        const t = /t="(\w+)"/.exec(attrs)?.[1];
        let v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "";
        if (t === "s") v = shared[Number(v)] ?? "";
        else if (t === "inlineStr")
          v = [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join("");
        row[col] = decodeXml(v);
      }
      rows.push(Array.from(row, (x) => x ?? ""));
      if (rows.length > TABLE_MAX_ROWS + 1) break;
    }
    if (!rows.length) continue;
    parts.push(`## ${names[i] ?? `Sheet ${i + 1}`}\n\n${mdTable(rows)}`);
  }
  return parts.join("\n\n");
}

function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export async function pptxToMarkdown(data: Buffer): Promise<string> {
  const zip = await loadZip(data);
  const slides = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
  const parts: string[] = [];
  for (const [i, f] of slides.entries()) {
    const xml = await zip.file(f)!.async("string");
    const paras = [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)]
      .map((p) =>
        decodeXml([...p[1]!.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((t) => t[1]).join("")).trim(),
      )
      .filter(Boolean);
    const notesFile = f.replace("slides/slide", "notesSlides/notesSlide");
    const notesXml = (await zip.file(notesFile)?.async("string")) ?? "";
    const notes = [...notesXml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
      .map((t) => decodeXml(t[1]!))
      .join(" ")
      .trim();
    const [title, ...rest] = paras;
    parts.push(
      `## Slide ${i + 1}${title ? `: ${title}` : ""}\n\n${rest.map((p) => `- ${p}`).join("\n")}${notes ? `\n\n> Notes: ${notes}` : ""}`.trim(),
    );
  }
  return parts.join("\n\n");
}

async function zipListing(data: Buffer): Promise<string> {
  const zip = await loadZip(data);
  const entries = Object.values(zip.files).filter((f) => !f.dir);
  const lines = entries.slice(0, 2000).map((f) => `- ${f.name}`);
  return `**Archive contents** (${entries.length} files)\n\n${lines.join("\n")}${entries.length > 2000 ? "\n- …" : ""}`;
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h\d|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

let tesseractAvailable: boolean | null = null;
async function hasBinary(name: string): Promise<boolean> {
  try {
    await execFileAsync("which", [name], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

async function withTempFile<T>(
  data: Buffer,
  ext: string,
  fn: (p: string) => Promise<T>,
): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ib-doc-"));
  const p = path.join(dir, `in${ext}`);
  fs.writeFileSync(p, data);
  try {
    return await fn(p);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function ocrImage(data: Buffer, ext: string): Promise<string | null> {
  if (tesseractAvailable === null) tesseractAvailable = await hasBinary("tesseract");
  if (!tesseractAvailable) return null;
  return withTempFile(data, ext, async (p) => {
    const { stdout } = await execFileAsync("tesseract", [p, "-", "--psm", "3"], {
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.trim();
  });
}

async function pdfText(data: Buffer, name: string): Promise<string> {
  let md = "";
  try {
    md = (await convertToMarkdown(name, data, "application/pdf")).markdown;
  } catch {
    md = "";
  }
  if (md && !md.startsWith("_No extractable text")) return md;
  if (await hasBinary("pdftotext")) {
    try {
      return await withTempFile(data, ".pdf", async (p) => {
        const { stdout } = await execFileAsync("pdftotext", ["-layout", p, "-"], {
          timeout: 60_000,
          maxBuffer: 64 * 1024 * 1024,
        });
        return stdout.trim();
      });
    } catch {
      /* fall through */
    }
  }
  return md;
}

/** Extract searchable markdown from an uploaded file. Never throws. */
export async function extractText(v: ValidatedUpload, data: Buffer): Promise<ExtractResult> {
  try {
    let md: string | null = null;
    const e = v.ext;
    switch (v.category) {
      case "pdf":
        md = await pdfText(data, v.name);
        break;
      case "office":
        if (e === ".docx") md = await docxToMarkdown(data);
        else if (e === ".xlsx") md = await xlsxToMarkdown(data);
        else if (e === ".pptx") md = await pptxToMarkdown(data);
        else md = null;
        break;
      case "archive":
        md = await zipListing(data);
        break;
      case "image":
        md = v.mime === "image/svg+xml" ? null : await ocrImage(data, e);
        break;
      case "text":
        if (e === ".html" || e === ".htm") md = htmlToText(data.toString("utf8"));
        else md = (await convertToMarkdown(v.name, data, v.mime)).markdown;
        break;
      default:
        md = null;
    }
    if (md == null || !md.trim()) return { markdown: null, status: "none" };
    return { markdown: md.slice(0, EXTRACT_MAX_CHARS), status: "ok" };
  } catch (err) {
    return { markdown: null, status: "error", error: String((err as Error)?.message ?? err) };
  }
}
