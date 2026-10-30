/**
 * File-to-Markdown conversion helpers for project attachments.
 *
 * Supports: PDF (text extraction via pdfjs-dist), DOCX (XML parse via unzip),
 * CSV (GFM table, capped at 200 rows), plain text / code (fenced block),
 * images (keep as-is with alt).
 *
 * Returns { markdown, attachments } where attachments is an array of
 * embedded binary assets (images extracted from PDFs, etc.).
 */

import * as path from "path";
import { createHash } from "crypto";

export interface ConvertResult {
  markdown: string;
  attachments: Array<{ name: string; mimeType: string; data: Buffer }>;
}

const TEXT_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".rst", ".text"]);
const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".go",
  ".rs",
  ".rb",
  ".php",
  ".java",
  ".c",
  ".cpp",
  ".h",
  ".cs",
  ".swift",
  ".kt",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".ps1",
  ".bat",
  ".sql",
  ".graphql",
  ".proto",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".env",
  ".json",
  ".xml",
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".vue",
  ".svelte",
]);
const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".bmp",
  ".ico",
  ".svg",
  ".heic",
]);

const CSV_MAX_ROWS = 200;

// ── Helpers ──────────────────────────────────────────────────────────

function ext(name: string): string {
  return path.extname(name).toLowerCase();
}

function sha256hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function detectLanguage(filename: string): string {
  const e = ext(filename);
  const MAP: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "tsx",
    ".js": "javascript",
    ".jsx": "jsx",
    ".py": "python",
    ".go": "go",
    ".rs": "rust",
    ".rb": "ruby",
    ".php": "php",
    ".java": "java",
    ".c": "c",
    ".cpp": "cpp",
    ".h": "c",
    ".cs": "csharp",
    ".swift": "swift",
    ".kt": "kotlin",
    ".sh": "bash",
    ".bash": "bash",
    ".zsh": "bash",
    ".ps1": "powershell",
    ".bat": "batch",
    ".sql": "sql",
    ".graphql": "graphql",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".toml": "toml",
    ".json": "json",
    ".xml": "xml",
    ".html": "html",
    ".htm": "html",
    ".css": "css",
    ".scss": "scss",
    ".sass": "sass",
    ".less": "less",
    ".vue": "vue",
    ".svelte": "svelte",
  };
  return MAP[e] ?? "";
}

// ── CSV → GFM table ──────────────────────────────────────────────────

function parseCSVLine(line: string): string[] {
  const cols: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuote = !inQuote;
      }
    } else if (ch === "," && !inQuote) {
      cols.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  cols.push(cur);
  return cols;
}

function csvToMarkdown(content: string): string {
  const lines = content.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return "_empty CSV_";

  const rows = lines.map(parseCSVLine);
  const header = rows[0];
  const body = rows.slice(1, 1 + CSV_MAX_ROWS);
  const truncated = rows.length > CSV_MAX_ROWS + 1;

  const sep = header.map(() => "---").join(" | ");
  const head = `| ${header.join(" | ")} |`;
  const bodyMd = body.map((r) => `| ${r.join(" | ")} |`).join("\n");
  let md = `${head}\n| ${sep} |\n${bodyMd}`;
  if (truncated) {
    md += `\n\n_Showing first ${CSV_MAX_ROWS} of ${rows.length - 1} rows._`;
  }
  return md;
}

// ── DOCX → text via XML extraction ───────────────────────────────────

async function docxToMarkdown(buffer: Buffer): Promise<string> {
  // DOCX is a ZIP containing word/document.xml
  // We use Node's built-in zlib + manual ZIP parsing via a tiny inline reader.
  // No external deps required.
  const { promisify } = await import("util");
  const { inflateRaw } = await import("zlib");
  const inflateRawAsync = promisify(inflateRaw);

  // Minimal ZIP parser: find the local file entry for word/document.xml
  let xmlContent: string | null = null;

  let offset = 0;
  while (offset < buffer.length - 4) {
    const sig = buffer.readUInt32LE(offset);
    if (sig !== 0x04034b50) break; // local file header signature

    const compression = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const filenameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);
    const filename = buffer.slice(offset + 30, offset + 30 + filenameLen).toString("utf8");
    const dataStart = offset + 30 + filenameLen + extraLen;
    const dataEnd = dataStart + compressedSize;

    if (filename === "word/document.xml") {
      const compressed = buffer.slice(dataStart, dataEnd);
      let xmlBuf: Buffer;
      if (compression === 0) {
        xmlBuf = compressed;
      } else if (compression === 8) {
        xmlBuf = await inflateRawAsync(compressed);
      } else {
        throw new Error(`Unsupported DOCX compression method: ${compression}`);
      }
      xmlContent = xmlBuf.toString("utf8");
      break;
    }

    offset = dataEnd;
  }

  if (!xmlContent) {
    return "_Could not extract DOCX content (no word/document.xml found)_";
  }

  // Strip XML tags and extract text runs.
  // Preserve paragraph breaks and heading structure as best-effort.
  const paragraphs: string[] = [];
  const paraRegex = /<w:p[ >][\s\S]*?<\/w:p>/g;
  const runRegex = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g;
  const styleRegex = /<w:pStyle w:val="([^"]+)"/;

  let match: RegExpExecArray | null;
  while ((match = paraRegex.exec(xmlContent)) !== null) {
    const para = match[0];
    const styleMatch = styleRegex.exec(para);
    const style = styleMatch ? styleMatch[1].toLowerCase() : "";

    let text = "";
    let runMatch: RegExpExecArray | null;
    while ((runMatch = runRegex.exec(para)) !== null) {
      text += runMatch[1];
    }
    text = text.trim();
    if (!text) continue;

    if (style === "heading1" || style === "title") {
      paragraphs.push(`# ${text}`);
    } else if (style === "heading2" || style === "subtitle") {
      paragraphs.push(`## ${text}`);
    } else if (style === "heading3") {
      paragraphs.push(`### ${text}`);
    } else {
      paragraphs.push(text);
    }
  }

  return paragraphs.join("\n\n") || "_Empty document_";
}

// ── PDF → markdown via pdfjs-dist ────────────────────────────────────

async function pdfToMarkdown(buffer: Buffer): Promise<string> {
  // Lazy-import to avoid loading pdfjs-dist when not needed.
  const { getDocument } = (await import("pdfjs-dist/legacy/build/pdf.mjs").catch(() => {
    throw new Error("pdfjs-dist is required for PDF conversion");
  })) as any;

  const pdf = await getDocument({ data: new Uint8Array(buffer), disableWorker: true }).promise;
  const parts: string[] = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item: any) => ("str" in item ? String(item.str) : ""))
      .filter(Boolean)
      .join(" ")
      .trim();
    if (pageText) {
      if (pdf.numPages > 1) {
        parts.push(`## Page ${pageNum}\n\n${pageText}`);
      } else {
        parts.push(pageText);
      }
    }
  }

  return parts.join("\n\n") || "_No extractable text in PDF_";
}

// ── Public API ───────────────────────────────────────────────────────

export type AcceptedMimeType =
  | "application/pdf"
  | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  | "text/plain"
  | "text/markdown"
  | "text/csv"
  | "application/json"
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "image/gif"
  | "image/heic"
  | "image/svg+xml"
  | string;

/** File types we accept for upload. */
export const ACCEPTED_MIME_TYPES = new Set<string>([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "text/plain",
  "text/markdown",
  "text/x-markdown",
  "text/csv",
  "application/csv",
  "text/tab-separated-values",
  "application/json",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/svg+xml",
  "application/octet-stream", // fallback; check extension too
]);

export const ACCEPTED_EXTENSIONS = new Set<string>([
  ".pdf",
  ".docx",
  ".doc",
  ".txt",
  ".md",
  ".markdown",
  ".rst",
  ".csv",
  ".tsv",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".xml",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".heic",
  ".svg",
  ".bmp",
  ...CODE_EXTENSIONS,
]);

export const MAX_FILE_BYTES = parseInt(
  process.env.INFINIBOT_ATTACHMENT_MAX_BYTES ?? "52428800",
  10,
); // 50 MB

export function isAcceptedFile(filename: string, mimeType?: string): boolean {
  const e = ext(filename);
  if (ACCEPTED_EXTENSIONS.has(e)) return true;
  if (mimeType && ACCEPTED_MIME_TYPES.has(mimeType)) return true;
  return false;
}

/**
 * Convert a file buffer to Markdown.
 *
 * For images, returns a Markdown image reference (caller must serve the file).
 * For PDFs and DOCX, extracts text and structures it.
 * For CSV, builds a GFM table.
 * For text/code, wraps in a fenced block.
 */
export async function convertToMarkdown(
  filename: string,
  buffer: Buffer,
  mimeType?: string,
  servedPath?: string,
): Promise<ConvertResult> {
  const e = ext(filename);
  const mime = (mimeType ?? "").toLowerCase();

  // Images
  if (IMAGE_EXTENSIONS.has(e) || mime.startsWith("image/")) {
    const alt = path.basename(filename, e);
    const imgSrc = servedPath ?? filename;
    return {
      markdown: `![${alt}](${imgSrc})`,
      attachments: [],
    };
  }

  // PDF
  if (e === ".pdf" || mime === "application/pdf") {
    const text = await pdfToMarkdown(buffer);
    return { markdown: text, attachments: [] };
  }

  // DOCX
  if (
    e === ".docx" ||
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    const text = await docxToMarkdown(buffer);
    return { markdown: text, attachments: [] };
  }

  // CSV / TSV
  if (e === ".csv" || e === ".tsv" || mime === "text/csv" || mime === "text/tab-separated-values") {
    const content = buffer.toString("utf8");
    const delimiter = e === ".tsv" || mime === "text/tab-separated-values" ? "\t" : ",";
    const md = csvToMarkdown(delimiter === "\t" ? content.replace(/\t/g, ",") : content);
    return { markdown: md, attachments: [] };
  }

  // Plain text / markdown
  if (
    TEXT_EXTENSIONS.has(e) ||
    mime.startsWith("text/markdown") ||
    mime.startsWith("text/x-markdown")
  ) {
    return { markdown: buffer.toString("utf8"), attachments: [] };
  }

  // Code / other text
  if (CODE_EXTENSIONS.has(e) || mime.startsWith("text/")) {
    const lang = detectLanguage(filename);
    const code = buffer.toString("utf8");
    return {
      markdown: lang ? `\`\`\`${lang}\n${code}\n\`\`\`` : `\`\`\`\n${code}\n\`\`\``,
      attachments: [],
    };
  }

  // JSON / YAML / TOML — treat as structured text
  if ([".json", ".yaml", ".yml", ".toml"].includes(e)) {
    const lang = e.slice(1);
    return {
      markdown: `\`\`\`${lang}\n${buffer.toString("utf8")}\n\`\`\``,
      attachments: [],
    };
  }

  // Unknown: return a placeholder
  return {
    markdown: `_Binary file: ${filename} (${buffer.length} bytes, sha256: ${sha256hex(buffer).slice(0, 16)}…)_`,
    attachments: [],
  };
}
