/**
 * Notion "Markdown & CSV" export (ZIP) → Documents importer.
 *
 * Export layout (per directory level):
 *   Title <32hex>.md          a page (`# Title` first line)
 *   Title <32hex>/            that page's children (sub-pages, databases, images)
 *   DB <32hex>.csv            a database (default view)
 *   DB <32hex>_all.csv        the same database, all rows (preferred when present)
 *   DB <32hex>/               the database's row pages (`# Row` + `Prop: value` lines)
 * Large exports wrap parts as inner `.zip` files; newer exports may omit the
 * 32-hex suffix, in which case ids fall back to the path (`zip:<path>`).
 *
 * Mapping and idempotency match the API importer: pages with children become
 * a folder (`folder:<id>`) holding the page doc first, databases become table
 * folders with an inferred schema, and nodes are keyed `{type:"notion", id}`
 * when the export carries the Notion id (`{type:"notion-zip", id:"zip:…"}`
 * otherwise).
 *
 * Safety: ZIP paths are only used as lookup keys (nothing is written to disk
 * from a ZIP path); `..` segments are dropped; entry count and total
 * uncompressed bytes are capped, measured while inflating.
 */

import path from "node:path";
import JSZip from "jszip";
import type { DocumentStore } from "../store.js";
import type { DocNode, DocPropertyColumn, DocPropertyValue, DocSource } from "../types.js";
import {
  IdAllocator,
  decideParent,
  emptyReport,
  errorMessage,
  extFromName,
  finalizeReport,
  isCancelled,
  normalizeNotionId,
  noteResolvedLink,
  noteUnresolvedLink,
  tally,
  throwIfCancelled,
  type NotionImportProgress,
  type NotionImportReport,
} from "./shared.js";

const DEFAULT_MAX_TOTAL_BYTES = 500 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 20_000;
const MAX_NESTED_ZIP_DEPTH = 3;
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".avif"]);

export interface NotionZipImportOptions {
  parentId: string | null;
  onProgress?: (p: NotionImportProgress) => void;
  /** Max total uncompressed bytes across all entries (default 500MB). */
  maxTotalBytes?: number;
  /** Max number of file entries, nested zips included (default 20k). */
  maxEntries?: number;
  /** Cancellation: checked per page; pages written so far stay. */
  signal?: AbortSignal;
  /** Called after each node is written (live tree refresh). */
  onWrite?: (nodeId: string) => void;
}

// ── Virtual file system over the (nested) zip ────────────────

interface ZipEntry {
  path: string;
  file: JSZip.JSZipObject;
}

/** Safety-limit violation: aborts the whole import (never recorded per item). */
export class ZipLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipLimitError";
  }
}

class ZipBudget {
  entries = 0;
  bytes = 0;
  constructor(
    readonly maxBytes: number,
    readonly maxEntries: number,
  ) {}

  addEntry(): void {
    if (++this.entries > this.maxEntries) {
      throw new ZipLimitError(`ZIP has too many entries (limit ${this.maxEntries})`);
    }
  }

  addBytes(n: number): void {
    this.bytes += n;
    if (this.bytes > this.maxBytes) {
      throw new ZipLimitError(`ZIP expands beyond ${this.maxBytes} bytes; refusing to import`);
    }
  }
}

/** Normalize a zip entry name to a safe relative POSIX path (null = reject). */
export function safeZipPath(name: string): string | null {
  const parts = name.replace(/\\/g, "/").split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (!p || p === ".") continue;
    if (p === "..") return null;
    out.push(p);
  }
  if (!out.length) return null;
  if (/^[a-z]:$/i.test(out[0]!)) return null; // drive letters
  return out.join("/");
}

/**
 * Inflate one entry while counting bytes against the budget. Streams so a
 * lying header (zip bomb) is stopped as soon as the budget is exceeded.
 */
function readEntry(file: JSZip.JSZipObject, budget: ZipBudget): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const stream = file.nodeStream("nodebuffer");
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      stream.pause();
      stream.removeAllListeners("data");
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    stream.on("data", (chunk: Buffer) => {
      if (settled) return;
      try {
        budget.addBytes(chunk.length);
        chunks.push(chunk);
      } catch (err) {
        fail(err);
      }
    });
    stream.on("error", fail);
    stream.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
  });
}

async function collectEntries(
  data: Buffer | Uint8Array,
  prefix: string,
  depth: number,
  budget: ZipBudget,
  out: Map<string, ZipEntry>,
): Promise<void> {
  const zip = await JSZip.loadAsync(data);
  for (const [name, file] of Object.entries(zip.files)) {
    if (file.dir) continue;
    const rel = safeZipPath(name);
    if (!rel) continue;
    const base = rel.split("/").pop()!;
    if (rel.startsWith("__MACOSX/") || base.startsWith("._") || base === ".DS_Store") continue;
    budget.addEntry();
    const full = (prefix ? `${prefix}/${rel}` : rel).normalize("NFC");
    if (base.toLowerCase().endsWith(".zip") && depth < MAX_NESTED_ZIP_DEPTH) {
      const inner = await readEntry(file, budget);
      const dir = path.posix.dirname(full);
      await collectEntries(inner, dir === "." ? "" : dir, depth + 1, budget, out);
      continue;
    }
    out.set(full, { path: full, file });
  }
}

// ── Names, CSV, property inference ───────────────────────────

/** `Title <32hex>` → { title, id }; ids are optional in newer exports. */
export function parseExportName(base: string): { title: string; id: string | null } {
  const m = /^(.*?)\s*([0-9a-f]{32})$/i.exec(base);
  if (m && m[1]) return { title: m[1].trim(), id: m[2]!.toLowerCase() };
  return { title: base.trim(), id: null };
}

/** RFC 4180 CSV parser (quoted fields, escaped quotes, embedded newlines, BOM). */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const NUMBER_RE = /^-?\$?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?%?$/;
const PURE_DATE_RE = /^[A-Za-z]+ \d{1,2}, \d{4}$|^\d{4}-\d{2}-\d{2}$|^\d{1,2}\/\d{1,2}\/\d{4}$/;

function stripDateDecor(v: string): string {
  return v
    .replace(/^@/, "")
    .replace(/\s*\([A-Z]{2,5}\)$/, "")
    .trim();
}

function isDateLike(v: string): boolean {
  const first = stripDateDecor(v).split(" → ")[0]!.trim();
  if (!/\d{4}/.test(first)) return false;
  return Number.isFinite(Date.parse(first));
}

function isoDay(v: string): string {
  const d = new Date(v);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Infer a column type from its non-empty CSV values. */
export function inferColumnType(values: string[]): DocPropertyColumn["type"] {
  const vals = values.map((v) => v.trim()).filter(Boolean);
  if (!vals.length) return "text";
  if (vals.every((v) => v === "Yes" || v === "No")) return "checkbox";
  if (vals.every((v) => NUMBER_RE.test(v))) return "number";
  if (vals.every(isDateLike)) return "date";
  if (vals.every((v) => /^https?:\/\/\S+$/i.test(v))) return "url";
  if (vals.every((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))) return "email";
  return "text";
}

/** Convert a CSV cell to a property value for the inferred column type. */
export function csvCellValue(raw: string, type: DocPropertyColumn["type"]): DocPropertyValue {
  const v = raw.trim();
  if (type === "checkbox") return v === "Yes";
  if (!v) return null;
  if (type === "number") {
    const n = Number(v.replace(/[$,%]/g, ""));
    return Number.isFinite(n) ? n : v;
  }
  if (type === "date") {
    const s = stripDateDecor(v);
    const parts = s
      .split(" → ")
      .map((p) => (PURE_DATE_RE.test(p.trim()) ? isoDay(p.trim()) : p.trim()));
    return parts.join(" → ");
  }
  return v;
}

interface CsvTable {
  schema: DocPropertyColumn[];
  rows: Array<{ title: string; properties: Record<string, DocPropertyValue> }>;
}

export interface RelationRef {
  title: string;
  /** Export path (`Folder/Page%20<hex>.md`) or notion.so URL as written in the cell. */
  target: string;
}

const RELATION_TARGET_RE = /\(([^()\s]+?\.md|https?:\/\/[^()\s]+)\)/g;

/**
 * Parse a relation (or relation rollup) cell from a Notion CSV:
 * `Page A (Folder/Page%20A%20<hex>.md), Page B (https://www.notion.so/…<hex>)`.
 * Returns null unless the whole cell is made of such items.
 */
export function parseRelationCell(raw: string): RelationRef[] | null {
  const cell = raw.trim();
  if (!cell) return null;
  const out: RelationRef[] = [];
  let last = 0;
  RELATION_TARGET_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RELATION_TARGET_RE.exec(cell))) {
    const title = cell
      .slice(last, m.index)
      .replace(/^\s*,\s*/, "")
      .trim();
    if (!title) return null;
    out.push({ title, target: m[1]! });
    last = m.index + m[0].length;
  }
  if (!out.length || cell.slice(last).trim()) return null;
  return out;
}

function csvToTable(text: string): CsvTable {
  const [header = [], ...data] = parseCsv(text);
  const seen = new Map<string, number>();
  const keys = header.map((h, i) => {
    const base = h.trim() || (i === 0 ? "Name" : `Column ${i + 1}`);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n > 1 ? `${base} (${n})` : base;
  });
  const schema: DocPropertyColumn[] = keys.map((key, i) => {
    if (i === 0) return { key, name: key, type: "title" };
    const values = data.map((r) => r[i] ?? "");
    let type = inferColumnType(values);
    // Relation (and relation-rollup) columns: every non-empty cell is a list
    // of `Title (link)` items. Linked at write time once every page has an id.
    if (
      type === "text" &&
      values.some((v) => v.trim()) &&
      values.every((v) => !v.trim() || parseRelationCell(v) !== null)
    ) {
      type = "relation";
    }
    return { key, name: key, type };
  });
  const rows = data.map((r) => {
    const properties: Record<string, DocPropertyValue> = {};
    schema.forEach((col, i) => {
      if (i > 0) properties[col.key] = csvCellValue(r[i] ?? "", col.type);
    });
    return { title: (r[0] ?? "").trim() || "Untitled", properties };
  });
  return { schema, rows };
}

// ── Markdown body post-processing ────────────────────────────

/** Split off the leading `# Title` line. */
function splitH1(md: string): { title: string | null; rest: string } {
  const text = md.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const m = /^\s*#\s+(.+?)\s*#*\s*(?:\n|$)/.exec(text);
  if (!m) return { title: null, rest: text };
  return { title: m[1]!.trim(), rest: text.slice(m[0].length) };
}

/**
 * Strip the `Prop: value` block Notion writes under a row's H1. Only keys in
 * `known` (the CSV columns) are stripped when provided.
 */
function stripRowProps(
  body: string,
  known: Set<string> | null,
): { props: Record<string, string>; rest: string } {
  const lines = body.split("\n");
  let i = 0;
  while (i < lines.length && !lines[i]!.trim()) i++;
  const props: Record<string, string> = {};
  const start = i;
  for (; i < lines.length; i++) {
    const m = /^([^:\n]{1,100}):\s?(.*)$/.exec(lines[i]!);
    if (!m) break;
    const key = m[1]!.trim();
    if (known ? !known.has(key) : /[#>*`[]/.test(key)) break;
    props[key] = m[2]!.trim();
  }
  if (i === start) return { props, rest: body };
  return { props, rest: lines.slice(i).join("\n") };
}

/** Notion exports callouts as `<aside>` blocks; turn them into dialect callouts. */
function asideToCallouts(md: string): string {
  return md.replace(/^<aside>\s*\n([\s\S]*?)\n?<\/aside>\s*$/gm, (_all, inner: string) => {
    const lines = inner.replace(/\s+$/, "").split("\n");
    return ["> [!NOTE]", ...lines.map((l) => (l.trim() ? `> ${l}` : ">"))].join("\n");
  });
}

type LinkRewriter = (
  target: string,
  isImage: boolean,
  label: string,
) => Promise<{ target: string; label?: string } | null>;

/** Rewrite `[label](target)` / `![alt](target)` links outside fenced code. */
async function rewriteLinks(md: string, rewrite: LinkRewriter): Promise<string> {
  let fence: string | null = null;
  const out: string[] = [];
  for (const line of md.split("\n")) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1]!;
      else if (f[1]!.startsWith(fence[0]!) && f[1]!.length >= fence.length) fence = null;
      out.push(line);
      continue;
    }
    out.push(fence ? line : await rewriteLine(line, rewrite));
  }
  return out.join("\n");
}

async function rewriteLine(line: string, rewrite: LinkRewriter): Promise<string> {
  let out = "";
  let i = 0;
  while (i < line.length) {
    const open = line.indexOf("](", i);
    if (open < 0) break;
    // Find the matching `[` for this `](`.
    let depth = 0;
    let lb = -1;
    for (let j = open - 1; j >= i; j--) {
      const c = line[j];
      if (c === "]" && line[j - 1] !== "\\") depth++;
      else if (c === "[" && line[j - 1] !== "\\") {
        if (depth === 0) {
          lb = j;
          break;
        }
        depth--;
      }
    }
    // Find the closing `)` with balanced parentheses (or `<…>` targets).
    let end = -1;
    let k = open + 2;
    if (line[k] === "<") {
      end = line.indexOf(">)", k);
      if (end >= 0) end += 1;
    } else {
      let pd = 0;
      for (; k < line.length; k++) {
        const c = line[k];
        if (c === "(") pd++;
        else if (c === ")") {
          if (pd === 0) {
            end = k;
            break;
          }
          pd--;
        }
      }
    }
    if (lb < 0 || end < 0) {
      out += line.slice(i, open + 2);
      i = open + 2;
      continue;
    }
    const isImage = lb > 0 && line[lb - 1] === "!";
    const label = line.slice(lb + 1, open);
    let target = line.slice(open + 2, end).trim();
    let title = "";
    const t = /^(\S+)\s+("[^"]*")$/.exec(target);
    if (t && !target.startsWith("<")) {
      target = t[1]!;
      title = ` ${t[2]}`;
    }
    const bare = target.startsWith("<") && target.endsWith(">") ? target.slice(1, -1) : target;
    const next = await rewrite(bare, isImage, label);
    const start = isImage ? lb - 1 : lb;
    out += line.slice(i, start);
    if (next) {
      const tgt = /[\s()]/.test(next.target) ? `<${next.target}>` : next.target;
      out += `${isImage ? "!" : ""}[${next.label ?? label}](${tgt}${title})`;
    } else {
      out += line.slice(start, end + 1);
    }
    i = end + 1;
  }
  return out + line.slice(i);
}

// ── Import plan ──────────────────────────────────────────────

interface ZipPlan {
  kind: "page" | "database" | "dir";
  /** Path without extension (the pairing key with a same-named directory). */
  key: string;
  mdPath?: string;
  title: string;
  notionId: string | null;
  source: { type: DocSource["type"]; id: string };
  folderSource: { type: DocSource["type"]; id: string };
  children: ZipPlan[];
  asFolder: boolean;
  isRow: boolean;
  /**
   * Row pages: CSV column names to strip from the body's `Prop: value` block
   * (null = strip any prop-looking lines). Bodies are re-read in pass 2, so
   * the plan never holds page text.
   */
  rowKnown?: Set<string> | null;
  /** CSV-less rows created from the table alone have no body. */
  noBody?: boolean;
  properties?: Record<string, DocPropertyValue>;
  schema?: DocPropertyColumn[];
  docId?: string;
  folderId?: string;
  existingDoc: DocNode | null;
  existingFolder: DocNode | null;
}

function normTitle(t: string): string {
  return t.trim().replace(/\s+/g, " ").toLowerCase();
}

class ZipImporter {
  private readonly report = emptyReport();
  /** The report so far (an aborted run still has partial counts). */
  get partialReport(): NotionImportReport {
    return this.report;
  }
  private readonly entries = new Map<string, ZipEntry>();
  private readonly dirs = new Map<string, { files: string[]; subdirs: Set<string> }>();
  /** Directories with a page/database somewhere below them. */
  private readonly contentDirs = new Set<string>();
  /** Relation columns per database folder key. */
  private readonly relationCols = new Map<string, Set<string>>();
  /** `${dbKey}\0${title}` → row plan (relations to rows without an .md page). */
  private readonly rowsByDbTitle = new Map<string, ZipPlan>();
  private readonly budget: ZipBudget;
  private readonly ids: IdAllocator;
  /** md path / csv path → node id to link to. */
  private readonly linkByPath = new Map<string, string>();
  private readonly linkById = new Map<string, string>();
  private readonly assetByPath = new Map<string, string>();
  private readonly createdThisRun = new Set<string>();
  private readonly syncedAt = new Date().toISOString();
  private discovered = 0;
  private written = 0;
  private total = 0;

  constructor(
    private readonly store: DocumentStore,
    private readonly opts: NotionZipImportOptions,
  ) {
    this.budget = new ZipBudget(
      opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
      opts.maxEntries ?? DEFAULT_MAX_ENTRIES,
    );
    this.ids = new IdAllocator(store);
  }

  async run(zipBuffer: Buffer | Uint8Array): Promise<NotionImportReport> {
    await collectEntries(zipBuffer, "", 0, this.budget, this.entries);
    this.indexDirs();
    let rootDir = "";
    // Collapse wrapper directories (e.g. "Export-…/", "Private & Shared/")
    // that hold nothing but a single directory.
    for (;;) {
      const d = this.dirs.get(rootDir);
      if (!d || d.files.some((f) => /\.(md|csv)$/i.test(f)) || d.subdirs.size !== 1) break;
      const only = [...d.subdirs][0]!;
      if (this.isPairedDir(only)) break;
      rootDir = only;
    }
    const roots = await this.planDir(rootDir, false);
    for (const r of roots) this.assignIds(r);
    // Deferred index writes; flushed periodically and at the end.
    await this.store.batch(async () => {
      for (const r of roots) {
        const id = await this.write(r, this.opts.parentId);
        if (id) this.report.rootNodeIds.push(id);
      }
    });
    return this.report;
  }

  private indexDirs(): void {
    const ensure = (d: string) => {
      let e = this.dirs.get(d);
      if (!e) {
        e = { files: [], subdirs: new Set() };
        this.dirs.set(d, e);
      }
      return e;
    };
    ensure("");
    for (const p of this.entries.keys()) {
      const dir = path.posix.dirname(p) === "." ? "" : path.posix.dirname(p);
      ensure(dir).files.push(p);
      if (/\.(md|csv)$/i.test(p)) {
        for (let d = dir; d && !this.contentDirs.has(d); ) {
          this.contentDirs.add(d);
          const up = path.posix.dirname(d);
          d = up === "." ? "" : up;
        }
      }
      let cur = dir;
      while (cur) {
        const parent = path.posix.dirname(cur) === "." ? "" : path.posix.dirname(cur);
        ensure(parent).subdirs.add(cur);
        cur = parent;
      }
    }
  }

  /** A directory paired with a same-named page .md or database .csv. */
  private isPairedDir(dir: string): boolean {
    return (
      this.entries.has(`${dir}.md`) ||
      this.entries.has(`${dir}.csv`) ||
      this.entries.has(`${dir}_all.csv`)
    );
  }

  private hasContent(dir: string): boolean {
    return this.contentDirs.has(dir);
  }

  private async readText(p: string): Promise<string> {
    const e = this.entries.get(p);
    if (!e) return "";
    return (await readEntry(e.file, this.budget)).toString("utf-8");
  }

  /** Record a per-item failure; safety-limit violations abort the import. */
  private fail(id: string, err: unknown): void {
    if (err instanceof ZipLimitError || isCancelled(err)) throw err;
    this.report.errors.push({ id, error: errorMessage(err) });
  }

  private progress(title: string) {
    throwIfCancelled(this.opts.signal);
    this.opts.onProgress?.({ phase: "discover", done: ++this.discovered, title });
  }

  // ── Pass 1: plan ──────────────────────────────────────────

  /** Plan the md/csv items (and unpaired content dirs) directly inside `dir`. */
  private async planDir(dir: string, rowsOf: false | CsvTable | null): Promise<ZipPlan[]> {
    const listing = this.dirs.get(dir);
    if (!listing) return [];
    const out: ZipPlan[] = [];
    const files = [...listing.files].sort();
    // Databases: prefer `<key>_all.csv` over `<key>.csv`.
    const dbKeys = new Map<string, string>();
    for (const f of files) {
      if (!/\.csv$/i.test(f)) continue;
      const key = f.replace(/(_all)?\.csv$/i, "");
      if (!dbKeys.has(key) || /_all\.csv$/i.test(f)) dbKeys.set(key, f);
    }
    const rowPlans: ZipPlan[] = [];
    for (const f of files) {
      if (!/\.md$/i.test(f)) continue;
      try {
        const plan = await this.planPage(f, rowsOf !== false);
        if (plan) (rowsOf !== false ? rowPlans : out).push(plan);
      } catch (err) {
        this.fail(f, err);
      }
    }
    if (rowsOf !== false) out.push(...(await this.matchRows(dir, rowPlans, rowsOf)));
    for (const [key, csvPath] of dbKeys) {
      try {
        out.push(await this.planDatabase(key, csvPath));
      } catch (err) {
        this.fail(csvPath, err);
      }
    }
    for (const sub of [...listing.subdirs].sort()) {
      if (this.isPairedDir(sub) || !this.hasContent(sub)) continue;
      const base = path.posix.basename(sub);
      const { title, id } = parseExportName(base);
      const plan = this.emptyPlan("dir", sub, title, id);
      plan.children = await this.planDir(sub, false);
      plan.asFolder = true;
      if (plan.children.length) out.push(plan);
    }
    return out;
  }

  private emptyPlan(kind: ZipPlan["kind"], key: string, title: string, id: string | null): ZipPlan {
    return {
      kind,
      key,
      title: title || "Untitled",
      notionId: id,
      source: id
        ? { type: "notion", id }
        : { type: "notion-zip", id: kind === "database" ? `zip:db:${key}` : `zip:${key}` },
      folderSource: id
        ? { type: "notion", id: kind === "database" ? id : `folder:${id}` }
        : { type: "notion-zip", id: kind === "database" ? `zip:db:${key}` : `zip:dir:${key}` },
      children: [],
      asFolder: kind !== "page",
      isRow: false,
      existingDoc: null,
      existingFolder: null,
    };
  }

  private async planPage(mdPath: string, isRow: boolean): Promise<ZipPlan | null> {
    const key = mdPath.replace(/\.md$/i, "");
    const parsed = parseExportName(path.posix.basename(key));
    const { title } = splitH1(await this.readText(mdPath));
    const plan = this.emptyPlan("page", key, title || parsed.title, parsed.id);
    plan.mdPath = mdPath;
    plan.isRow = isRow;
    this.progress(plan.title);
    if (this.dirs.has(key)) plan.children = await this.planDir(key, false);
    plan.asFolder = plan.children.length > 0;
    return plan;
  }

  private async planDatabase(key: string, csvPath: string): Promise<ZipPlan> {
    const parsed = parseExportName(path.posix.basename(key));
    const plan = this.emptyPlan("database", key, parsed.title, parsed.id);
    this.progress(plan.title);
    const table = csvToTable(await this.readText(csvPath));
    plan.schema = table.schema;
    const rel = table.schema.filter((c) => c.type === "relation").map((c) => c.key);
    if (rel.length) this.relationCols.set(key, new Set(rel));
    plan.children = await this.planDir(key, table);
    return plan;
  }

  /**
   * Attach CSV row properties to row pages (matched by title, in order) and
   * create body-less docs for CSV rows that had no .md file.
   */
  private async matchRows(
    dbKey: string,
    rowPlans: ZipPlan[],
    table: CsvTable | null,
  ): Promise<ZipPlan[]> {
    const known = table ? new Set(table.schema.map((c) => c.key)) : null;
    const queue = new Map<string, number[]>();
    table?.rows.forEach((r, i) => {
      const k = normTitle(r.title);
      queue.set(k, [...(queue.get(k) ?? []), i]);
    });
    const used = new Set<number>();
    for (const plan of rowPlans) {
      plan.rowKnown = known;
      const idx = queue.get(normTitle(plan.title))?.shift();
      if (idx !== undefined && table) {
        used.add(idx);
        plan.properties = table.rows[idx]!.properties;
      } else {
        const { rest } = splitH1(await this.readText(plan.mdPath!));
        plan.properties = stripRowProps(rest, known).props;
      }
    }
    const extra: ZipPlan[] = [];
    const seen = new Map<string, number>();
    table?.rows.forEach((r, i) => {
      if (used.has(i)) return;
      const n = (seen.get(r.title) ?? 0) + 1;
      seen.set(r.title, n);
      const key = `${dbKey}/${r.title}${n > 1 ? `#${n}` : ""}`;
      const plan = this.emptyPlan("page", key, r.title, null);
      plan.isRow = true;
      plan.noBody = true;
      plan.properties = r.properties;
      extra.push(plan);
    });
    const all = [...rowPlans, ...extra];
    for (const plan of all) {
      const k = `${dbKey}\u0000${normTitle(plan.title)}`;
      if (!this.rowsByDbTitle.has(k)) this.rowsByDbTitle.set(k, plan);
    }
    return all;
  }

  // ── Id assignment ─────────────────────────────────────────

  private assignIds(plan: ZipPlan): void {
    this.total += 1;
    if (plan.kind === "page") {
      const d = this.ids.allocate(plan.source, plan.title);
      plan.docId = d.id;
      plan.existingDoc = d.existing;
      if (plan.mdPath) this.linkByPath.set(plan.mdPath, d.id);
      if (plan.notionId) this.linkById.set(plan.notionId, d.id);
    }
    if (plan.asFolder) {
      const f = this.ids.allocate(plan.folderSource, plan.title);
      plan.folderId = f.id;
      plan.existingFolder = f.existing;
      if (plan.kind === "database") {
        for (const suffix of [".csv", "_all.csv"])
          this.linkByPath.set(`${plan.key}${suffix}`, f.id);
        if (plan.notionId) this.linkById.set(plan.notionId, f.id);
      }
    }
    for (const c of plan.children) this.assignIds(c);
  }

  // ── Pass 2: write ─────────────────────────────────────────

  private resolveNotionId(id: string | null): string | null {
    if (!id) return null;
    const mapped = this.linkById.get(id);
    if (mapped) return mapped;
    const prior = this.store.findBySource("notion", id);
    return prior && !prior.deletedAt ? prior.id : null;
  }

  private async assetFor(p: string): Promise<string | null> {
    const cached = this.assetByPath.get(p);
    if (cached) return cached;
    const e = this.entries.get(p);
    if (!e) return null;
    const data = await readEntry(e.file, this.budget);
    const url = this.store.addAsset(data, extFromName(p) || ".bin");
    this.assetByPath.set(p, url);
    return url;
  }

  /** Page markdown after the H1 (and, for rows, after the `Prop: value` block). */
  private async pageBody(plan: ZipPlan): Promise<string> {
    if (plan.noBody || !plan.mdPath) return "";
    const { rest } = splitH1(await this.readText(plan.mdPath));
    return plan.isRow ? stripRowProps(rest, plan.rowKnown ?? null).rest : rest;
  }

  private async renderBody(plan: ZipPlan): Promise<string> {
    const dir = plan.mdPath ? path.posix.dirname(plan.mdPath) : "";
    const from = plan.mdPath ?? plan.key;
    const body = asideToCallouts((await this.pageBody(plan)).replace(/^\s*\n/, ""));
    const rewritten = await rewriteLinks(body, async (target, isImage, label) => {
      const hit = await this.rewriteTarget(dir, target, isImage, label);
      if (hit?.target.startsWith("doc:")) noteResolvedLink(this.report);
      else if (!hit && this.isPageLink(target)) noteUnresolvedLink(this.report, from, target);
      return hit;
    });
    const trimmed = rewritten.trim();
    return trimmed ? `${trimmed}\n` : "";
  }

  /** A link that should point at a page/database (counted in link stats). */
  private isPageLink(target: string): boolean {
    if (/^https?:\/\/(www\.)?notion\.(so|site)\//i.test(target)) return true;
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return false;
    return /\.(md|csv)$/i.test(target.split(/[?#]/)[0] ?? "");
  }

  private async rewriteTarget(
    dir: string,
    target: string,
    isImage: boolean,
    label: string,
  ): Promise<{ target: string; label?: string } | null> {
    {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
        if (/^https?:\/\/(www\.)?notion\.(so|site)\//i.test(target)) {
          const doc = this.resolveNotionId(normalizeNotionId(target));
          return doc ? { target: `doc:${doc}` } : null;
        }
        return null;
      }
      if (target.startsWith("#") || target.startsWith("/")) return null;
      let decoded = target.split(/[?#]/)[0] ?? target;
      try {
        decoded = decodeURIComponent(decoded);
      } catch {
        /* keep raw */
      }
      decoded = decoded.normalize("NFC");
      const resolved = path.posix.normalize(path.posix.join(dir || ".", decoded));
      if (resolved.startsWith("..")) return null;
      const linked = this.linkByPath.get(resolved);
      if (linked) return { target: `doc:${linked}` };
      if (/\.(md|csv)$/i.test(resolved)) {
        const id = parseExportName(
          path.posix.basename(resolved).replace(/(_all)?\.(md|csv)$/i, ""),
        ).id;
        const doc = this.resolveNotionId(id);
        return doc ? { target: `doc:${doc}` } : null;
      }
      if (!this.entries.has(resolved)) return null;
      const url = await this.assetFor(resolved);
      if (!url) return null;
      const ext = extFromName(resolved);
      const attach = !isImage && !IMAGE_EXTS.has(ext) && !label.startsWith("📎");
      return { target: url, label: attach ? `📎 ${label}` : label };
    }
  }

  /**
   * Relation cells → `doc:<id>` for targets in this export (or imported
   * before); unresolvable items keep their title text.
   */
  private linkRelations(plan: ZipPlan, dbKey: string | null): Record<string, DocPropertyValue> {
    const props = plan.properties ?? {};
    const cols = dbKey ? this.relationCols.get(dbKey) : undefined;
    if (!cols) return props;
    const csvDir = path.posix.dirname(dbKey!) === "." ? "" : path.posix.dirname(dbKey!);
    const out: Record<string, DocPropertyValue> = { ...props };
    for (const key of cols) {
      const raw = props[key];
      if (typeof raw !== "string" || !raw.trim()) continue;
      const refs = parseRelationCell(raw);
      if (!refs) continue;
      out[key] = refs.map((r) => {
        const id = this.resolveRelationTarget(csvDir, r.target, r.title);
        if (id) {
          noteResolvedLink(this.report);
          return `doc:${id}`;
        }
        noteUnresolvedLink(this.report, plan.mdPath ?? plan.key, r.title);
        return r.title;
      });
    }
    return out;
  }

  private resolveRelationTarget(csvDir: string, target: string, title: string): string | null {
    if (/^https?:/i.test(target)) return this.resolveNotionId(normalizeNotionId(target));
    let decoded = target;
    try {
      decoded = decodeURIComponent(target);
    } catch {
      /* keep raw */
    }
    decoded = decoded.normalize("NFC");
    for (const base of [csvDir, ""]) {
      const p = path.posix.normalize(path.posix.join(base || ".", decoded));
      const hit = !p.startsWith("..") ? this.linkByPath.get(p) : undefined;
      if (hit) return hit;
    }
    const id = parseExportName(path.posix.basename(decoded).replace(/\.md$/i, "")).id;
    const byId = this.resolveNotionId(id);
    if (byId) return byId;
    // A row exported only as a CSV line (no page file): match by title in its database.
    const p = path.posix.normalize(path.posix.join(csvDir || ".", decoded));
    const dbDir = path.posix.dirname(p) === "." ? "" : path.posix.dirname(p);
    return this.rowsByDbTitle.get(`${dbDir}\u0000${normTitle(title)}`)?.docId ?? null;
  }

  private writeProgress(title: string) {
    throwIfCancelled(this.opts.signal);
    this.opts.onProgress?.({ phase: "write", done: ++this.written, total: this.total, title });
  }

  private upsertFolder(plan: ZipPlan, parentId: string | null): DocNode | null {
    const placement = decideParent(this.store, plan.existingFolder, parentId, this.createdThisRun);
    const res = this.store.upsertBySource(
      { ...plan.folderSource, syncedAt: this.syncedAt },
      {
        kind: "folder",
        id: plan.folderId,
        title: plan.title,
        parentId: placement.parentId,
        ...(plan.kind === "database"
          ? { schema: plan.schema, view: { mode: "table" as const } }
          : {}),
      },
      { reparent: placement.reparent },
    );
    tally(this.report, res.status);
    if (res.status === "created") this.createdThisRun.add(res.node.id);
    if (res.status !== "skipped") this.opts.onWrite?.(res.node.id);
    return res.status === "skipped" ? null : res.node;
  }

  private async writeDoc(
    plan: ZipPlan,
    parentId: string | null,
    dbKey: string | null = null,
  ): Promise<DocNode | null> {
    const placement = decideParent(this.store, plan.existingDoc, parentId, this.createdThisRun);
    const body = await this.renderBody(plan);
    const properties = plan.isRow ? this.linkRelations(plan, dbKey) : undefined;
    const res = this.store.upsertBySource(
      { ...plan.source, syncedAt: this.syncedAt },
      {
        kind: "doc",
        id: plan.docId,
        title: plan.title,
        parentId: placement.parentId,
        body,
        properties,
      },
      { reparent: placement.reparent },
    );
    tally(this.report, res.status);
    if (res.status === "created") this.createdThisRun.add(res.node.id);
    if (
      plan.asFolder &&
      parentId &&
      (res.status === "created" || placement.reparent) &&
      res.node.parentId === parentId
    ) {
      this.store.move(res.node.id, parentId, 0);
    }
    if (res.status !== "skipped") this.opts.onWrite?.(res.node.id);
    return res.status === "skipped" ? null : res.node;
  }

  private async write(
    plan: ZipPlan,
    parentId: string | null,
    dbKey: string | null = null,
  ): Promise<string | null> {
    this.writeProgress(plan.title);
    try {
      if (plan.kind === "page" && !plan.asFolder) {
        const doc = await this.writeDoc(plan, parentId, plan.isRow ? dbKey : null);
        return doc?.id ?? null;
      }
      const folder = this.upsertFolder(plan, parentId);
      if (!folder) return null;
      if (plan.kind === "page") await this.writeDoc(plan, folder.id, plan.isRow ? dbKey : null);
      const childDb = plan.kind === "database" ? plan.key : null;
      for (const child of plan.children) await this.write(child, folder.id, childDb);
      return folder.id;
    } catch (err) {
      this.fail(plan.notionId ?? plan.key, err);
      return null;
    }
  }
}

/**
 * Import a Notion "Markdown & CSV" export ZIP into the document store.
 * Throws on unreadable archives or when safety limits are exceeded; per-item
 * failures are collected in `report.errors`.
 */
export async function importNotionZip(
  store: DocumentStore,
  zipBuffer: Buffer | Uint8Array,
  opts: NotionZipImportOptions,
): Promise<NotionImportReport> {
  if (opts.parentId) {
    const parent = store.getNode(opts.parentId);
    if (!parent || parent.kind !== "folder") {
      throw new Error(`Parent folder "${opts.parentId}" not found`);
    }
  }
  const importer = new ZipImporter(store, opts);
  try {
    return finalizeReport(await importer.run(zipBuffer));
  } catch (err) {
    finalizeReport(importer.partialReport);
    throw err;
  }
}
