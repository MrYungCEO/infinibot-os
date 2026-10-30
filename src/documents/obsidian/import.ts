/**
 * Obsidian vault → Documents importer.
 *
 * Mapping:
 *   vault root            → a folder `<vault name>` ({type:"obsidian", id:"<vault>:/"})
 *   vault folders         → folders ("<vault>:dir:<path>")  — collections
 *   notes (*.md)          → docs ("<vault>:<path>"), frontmatter → properties,
 *                           frontmatter tags + inline #tags → tags,
 *                           daily notes (YYYY-MM-DD.md) → `date` property + "daily-note" tag
 *   [[wikilinks]]         → `[label](doc:<id>)` (Obsidian resolution: path, then
 *                           shortest basename match, then alias); unresolved
 *                           links stay as `[[…]]` text
 *   ![[note]] embeds      → a link to the embedded note
 *   ![[image.png]]        → content-addressed asset `![image](/api/documents/assets/…)`
 *   other attachments     → file nodes (text extracted for search/agents)
 *   - [ ] tasks           → returned as `tasks` (the job turns them into kanban
 *                           tasks when the user opted in)
 *
 * Idempotency: nodes are keyed by vault + path; `source.hash` (sha256 of the
 * raw note) lets a re-sync skip unchanged notes. Notes removed from the vault
 * are reported (`missing`) but never deleted.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import type { DocumentStore } from "../store.js";
import type { DocNode, DocPropertyValue, DocSource } from "../types.js";
import {
  IdAllocator,
  decideParent,
  emptyLinkStats,
  emptyReport,
  errorMessage,
  finalizeReport,
  isCancelled,
  noteResolvedLink,
  noteUnresolvedLink,
  tally,
  throwIfCancelled,
  type ImportLinkStats,
  type NotionImportReport,
} from "../notion/shared.js";
import {
  IMAGE_EXTS,
  dailyNoteDate,
  frontmatterAliases,
  frontmatterProperties,
  frontmatterTags,
  parseFrontmatter,
  parseInlineTags,
  parseLocalMdLinks,
  parseTasks,
  parseWikiLinks,
  stripTitleHeading,
  type ObsidianTask,
} from "./parse.js";
import type { VaultFile } from "./vault-source.js";

export interface ObsidianImportProgress {
  phase: "discover" | "write";
  done: number;
  total: number;
  title?: string;
}

export interface ObsidianTaskRef {
  /** Stable key: vault + note path + task text hash. */
  key: string;
  text: string;
  done: boolean;
  due: string | null;
  tags: string[];
  notePath: string;
  docId: string;
}

export interface ObsidianImportReport extends NotionImportReport {
  notes: number;
  folders: number;
  attachments: number;
  assets: number;
  links: ImportLinkStats;
  dailyNotes: number;
  tasks: ObsidianTaskRef[];
  /** Notes imported earlier from this vault that are no longer in it. */
  missing: number;
}

export interface ObsidianImportOptions {
  /** Stable vault identity (dedupe key prefix). */
  vaultKey: string;
  vaultName: string;
  parentId: string | null;
  /** Re-render every note even when its hash is unchanged. */
  force?: boolean;
  signal?: AbortSignal;
  onProgress?: (p: ObsidianImportProgress) => void;
  onWrite?: (nodeId: string) => void;
  /** Text extraction for non-markdown attachments (injected; tests skip it). */
  extractAttachment?: (
    name: string,
    data: Buffer,
  ) => Promise<{
    mime: string;
    markdown: string | null;
    status: "ok" | "none" | "error";
    error?: string;
  } | null>;
  syncRun?: string;
}

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Stable vault key from its origin (folder path, git URL, or zip name). */
export function vaultKeyFor(origin: string): string {
  return sha256(origin.trim().toLowerCase()).slice(0, 12);
}

function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

function baseNoExt(p: string): string {
  const b = p.slice(p.lastIndexOf("/") + 1);
  return b.replace(/\.md$/i, "");
}

function mdLabel(s: string): string {
  return s.replace(/[[\]]/g, "");
}

/** Shared leading folder segments of two folder paths ("" = vault root). */
function sharedDirDepth(a: string, b: string): number {
  if (!a || !b) return 0;
  const pa = a.split("/");
  const pb = b.split("/");
  let i = 0;
  while (i < pa.length && i < pb.length && pa[i] === pb[i]) i++;
  return i;
}

/**
 * Pick among several notes matching the same link text the way Obsidian
 * does for an ambiguous bare link: a note in the linking note's own folder,
 * else the one sharing the longest folder prefix with it, else the shortest
 * path (then alphabetical, for determinism).
 */
export function pickClosest(candidates: string[], fromPath: string): string | null {
  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0]!;
  const fromDir = dirOf(fromPath);
  let best: string | null = null;
  let bestScore = -1;
  for (const c of candidates) {
    const d = dirOf(c);
    const score = d === fromDir ? 1_000_000 : sharedDirDepth(d, fromDir);
    if (
      score > bestScore ||
      (score === bestScore &&
        best !== null &&
        (c.length < best.length || (c.length === best.length && c.localeCompare(best) < 0)))
    ) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

function nfc(s: string): string {
  return s.normalize("NFC");
}

/**
 * Obsidian-style resolver for link targets inside a vault. Paths and link
 * targets are compared NFC-normalized and case-insensitively (macOS vaults
 * store names decomposed).
 */
export class VaultResolver {
  private readonly byPath = new Map<string, string>(); // lower path (with ext) → path
  private readonly byBase = new Map<string, string[]>(); // lower base (no .md) → paths
  private readonly byAlias = new Map<string, string[]>(); // lower alias → note paths

  constructor(paths: string[]) {
    for (const raw of paths) {
      const p = nfc(raw);
      this.byPath.set(p.toLowerCase(), p);
      const base = (
        p.endsWith(".md") ? baseNoExt(p) : p.slice(p.lastIndexOf("/") + 1)
      ).toLowerCase();
      const list = this.byBase.get(base) ?? [];
      list.push(p);
      this.byBase.set(base, list);
    }
    for (const list of this.byBase.values())
      list.sort((a, b) => a.length - b.length || a.localeCompare(b));
  }

  addAlias(alias: string, notePath: string): void {
    const k = nfc(alias).trim().toLowerCase();
    if (!k) return;
    const list = this.byAlias.get(k) ?? [];
    if (!list.includes(notePath)) list.push(notePath);
    this.byAlias.set(k, list);
  }

  /** Resolve `target` (as written in a link) from the note at `fromPath`. */
  resolve(target: string, fromPath: string): string | null {
    let t = target.trim();
    try {
      t = decodeURIComponent(t);
    } catch {
      /* keep raw */
    }
    t = nfc(t).replace(/\\/g, "/").replace(/^\.\//, "");
    if (!t) return null;
    const from = nfc(fromPath);
    const candidates: string[] = [];
    // Relative to the linking note's folder, then vault-absolute.
    const rel = path.posix.normalize(path.posix.join(dirOf(from), t));
    for (const c of [rel, t.replace(/^\//, "")]) {
      if (c.startsWith("..")) continue;
      candidates.push(c, `${c}.md`);
    }
    for (const c of candidates) {
      const hit = this.byPath.get(c.toLowerCase());
      if (hit) return hit;
    }
    const lower = t.toLowerCase();
    if (!t.includes("/")) {
      const base = lower.replace(/\.md$/i, "");
      const list = this.byBase.get(base);
      if (list?.length) return pickClosest(list, from);
    } else {
      // Partial path ("Folder/Note") anywhere in the vault.
      const suffix = `/${lower.replace(/\.md$/i, "")}`;
      const base = suffix.slice(suffix.lastIndexOf("/") + 1);
      const hits = (this.byBase.get(base) ?? []).filter((real) =>
        real.toLowerCase().replace(/\.md$/i, "").endsWith(suffix),
      );
      if (hits.length) return pickClosest(hits, from);
    }
    const aliased = this.byAlias.get(lower);
    return aliased?.length ? pickClosest(aliased, from) : null;
  }
}

export async function importObsidianVault(
  store: DocumentStore,
  files: VaultFile[],
  opts: ObsidianImportOptions,
): Promise<ObsidianImportReport> {
  const report: ObsidianImportReport = {
    ...emptyReport(),
    notes: 0,
    folders: 0,
    attachments: 0,
    assets: 0,
    links: emptyLinkStats(),
    dailyNotes: 0,
    tasks: [],
    missing: 0,
  };
  // Index writes are deferred and flushed periodically (5k notes would
  // otherwise rewrite index.json 5k+ times). Partial state on a crash is fine:
  // a re-run converges by source key.
  try {
    await store.batch(() => runVaultImport(store, files, opts, report));
  } finally {
    finalizeReport(report);
  }
  return report;
}

async function runVaultImport(
  store: DocumentStore,
  rawFiles: VaultFile[],
  opts: ObsidianImportOptions,
  report: ObsidianImportReport,
): Promise<void> {
  const vk = opts.vaultKey;
  const src = (id: string, extra: Partial<DocSource> = {}): DocSource & { id: string } => ({
    type: "obsidian",
    id: `${vk}:${id}`,
    syncedAt: new Date().toISOString(),
    ...(opts.syncRun ? { syncRun: opts.syncRun } : {}),
    ...extra,
  });

  // NFC paths everywhere (macOS vaults are NFD). Nodes imported earlier under
  // a decomposed key are re-keyed in place instead of duplicated.
  const files: VaultFile[] = [];
  const seenPaths = new Set<string>();
  for (const f of rawFiles) {
    const p = nfc(f.path);
    if (seenPaths.has(p)) continue;
    seenPaths.add(p);
    if (p !== f.path) {
      const legacy = store.findBySource("obsidian", `${vk}:${f.path}`);
      if (legacy && !store.findBySource("obsidian", `${vk}:${p}`)) {
        store.update({ id: legacy.id, source: { ...legacy.source!, id: `${vk}:${p}` } });
      }
    }
    files.push(p === f.path ? f : { path: p, size: f.size, read: () => f.read() });
  }

  const notes = files.filter((f) => /\.md$/i.test(f.path));
  const others = files.filter((f) => !/\.md$/i.test(f.path) && !/\.canvas$/i.test(f.path));
  const resolver = new VaultResolver(files.map((f) => f.path));
  const total = notes.length;

  // ── Pass 1: hash, frontmatter, aliases, tasks; allocate ids ─────────
  // Only small derived data is kept per note; bodies are re-read in pass 2 so
  // memory stays flat for large vaults.
  opts.onProgress?.({ phase: "discover", done: 0, total });
  const alloc = new IdAllocator(store);
  const createdThisRun = new Set<string>();
  type Parsed = {
    file: VaultFile;
    hash: string;
    tasks: ObsidianTask[];
    id: string;
    existing: DocNode | null;
  };
  const parsed: Parsed[] = [];
  for (const f of notes) {
    throwIfCancelled(opts.signal);
    try {
      const buf = await f.read();
      const fm = parseFrontmatter(buf.toString("utf8"));
      const title = baseNoExt(f.path);
      const { id, existing } = alloc.allocate({ type: "obsidian", id: `${vk}:${f.path}` }, title);
      for (const a of frontmatterAliases(fm.data)) resolver.addAlias(a, f.path);
      parsed.push({
        file: f,
        hash: sha256(buf),
        tasks: parseTasks(fm.body),
        id,
        existing,
      });
    } catch (err) {
      if (isCancelled(err)) throw err;
      report.errors.push({ id: f.path, title: f.path, error: errorMessage(err) });
    }
  }
  const noteIdByPath = new Map(parsed.map((p) => [p.file.path, p.id]));

  // ── Folders (collections) ──────────────────────────────────────────
  const root = store.upsertBySource(src("/"), {
    kind: "folder",
    title: opts.vaultName || "Obsidian vault",
    parentId: opts.parentId,
    icon: "🗃️",
  });
  if (root.status === "created") createdThisRun.add(root.node.id);
  tally(report, root.status);
  report.rootNodeIds.push(root.node.id);
  opts.onWrite?.(root.node.id);
  const folderIds = new Map<string, string>([["", root.node.id]]);
  const ensureFolder = (dir: string): string => {
    if (folderIds.has(dir)) return folderIds.get(dir)!;
    const parent = ensureFolder(dirOf(dir));
    const title = dir.slice(dir.lastIndexOf("/") + 1);
    const existing = store.findBySource("obsidian", `${vk}:dir:${dir}`);
    const placement = decideParent(store, existing, parent, createdThisRun);
    const r = store.upsertBySource(
      src(`dir:${dir}`),
      { kind: "folder", title, parentId: placement.parentId },
      { reparent: placement.reparent },
    );
    if (r.status === "created") {
      createdThisRun.add(r.node.id);
      report.folders += 1;
    }
    tally(report, r.status);
    folderIds.set(dir, r.node.id);
    opts.onWrite?.(r.node.id);
    return r.node.id;
  };

  // ── Attachments ─────────────────────────────────────────────────────
  const otherByPath = new Map(others.map((f) => [f.path, f]));
  const assetUrl = new Map<string, string>();
  const fileNodeId = new Map<string, string>();
  const failedAttachments = new Set<string>();
  const importAttachment = async (
    p: string,
  ): Promise<{ kind: "asset"; url: string } | { kind: "file"; id: string } | null> => {
    const f = otherByPath.get(p);
    if (!f || failedAttachments.has(p)) return null;
    try {
      return await importAttachmentOnce(p, f);
    } catch (err) {
      if (isCancelled(err)) throw err;
      // One unreadable attachment must not fail every note that links to it.
      failedAttachments.add(p);
      report.errors.push({ id: p, title: p, error: errorMessage(err) });
      return null;
    }
  };
  const importAttachmentOnce = async (
    p: string,
    f: VaultFile,
  ): Promise<{ kind: "asset"; url: string } | { kind: "file"; id: string } | null> => {
    const ext = path.posix.extname(p).toLowerCase();
    if (IMAGE_EXTS.has(ext)) {
      if (!assetUrl.has(p)) {
        assetUrl.set(p, store.addAsset(await f.read(), ext));
        report.assets += 1;
      }
      return { kind: "asset", url: assetUrl.get(p)! };
    }
    if (fileNodeId.has(p)) return { kind: "file", id: fileNodeId.get(p)! };
    const data = await f.read();
    const hash = sha256(data);
    const existing = store.findBySource("obsidian", `${vk}:${p}`);
    if (existing && !existing.deletedAt && existing.file?.sha256 === hash) {
      ensureFolder(dirOf(p)); // keeps the folder accounted for on re-sync
      fileNodeId.set(p, existing.id);
      tally(report, "unchanged");
      return { kind: "file", id: existing.id };
    }
    if (existing?.deletedAt) {
      tally(report, "skipped");
      return null;
    }
    const name = p.slice(p.lastIndexOf("/") + 1);
    const ex = opts.extractAttachment ? await opts.extractAttachment(name, data) : null;
    if (existing) {
      // Content changed: retire the old node (to Trash, restorable) and add the
      // new version under the same source key.
      store.update({
        id: existing.id,
        source: { ...existing.source!, id: `${existing.source!.id}#replaced-${Date.now()}` },
      });
      store.softDelete(existing.id);
    }
    // A stable id (slug + source tail) so a crashed run's re-try overwrites
    // its own half-written file dir instead of leaving an orphan.
    const stableId = existing
      ? undefined
      : alloc.allocate({ type: "obsidian", id: `${vk}:${p}` }, name).id;
    const node = store.addFile({
      parentId: ensureFolder(dirOf(p)),
      name,
      data,
      mime: ex?.mime ?? "application/octet-stream",
      source: src(p, { hash }),
      ...(stableId ? { id: stableId } : {}),
    });
    if (ex) store.setExtracted(node.id, ex.markdown, ex.status, ex.error);
    else store.setExtracted(node.id, null, "none");
    fileNodeId.set(p, node.id);
    report.attachments += 1;
    tally(report, existing ? "updated" : "created");
    opts.onWrite?.(node.id);
    return { kind: "file", id: node.id };
  };

  // ── Pass 2: write notes ────────────────────────────────────────────
  let done = 0;
  for (const p of parsed) {
    throwIfCancelled(opts.signal);
    const notePath = p.file.path;
    const title = baseNoExt(notePath);
    opts.onProgress?.({ phase: "write", done, total, title });
    try {
      const folderId = ensureFolder(dirOf(notePath));
      report.notes += 1;
      const day = dailyNoteDate(title);
      if (day) report.dailyNotes += 1;
      // Tasks (collected even when the note itself is unchanged).
      for (const t of p.tasks) {
        report.tasks.push({
          key: `obsidian:${vk}:${notePath}#${sha256(t.text).slice(0, 12)}`,
          text: t.text,
          done: t.done,
          due: t.due,
          tags: t.tags,
          notePath,
          docId: p.id,
        });
      }
      // Unchanged note: skip — unless it still carries unresolved [[links]]
      // that a note added since might now satisfy.
      if (
        !opts.force &&
        p.existing &&
        !p.existing.deletedAt &&
        p.existing.source?.hash === p.hash &&
        !hasWikiLinks(store.getBody(p.existing.id))
      ) {
        tally(report, "unchanged");
        done += 1;
        continue;
      }
      if (p.existing?.deletedAt) {
        tally(report, "skipped");
        done += 1;
        continue;
      }
      // Re-read (pass 1 kept only the hash); a note edited mid-import is
      // imported as it is now.
      const buf = await p.file.read();
      const hash = sha256(buf);
      const { data, body: noteBody } = parseFrontmatter(buf.toString("utf8"));
      const tags = new Set([...frontmatterTags(data), ...parseInlineTags(noteBody)]);
      if (day) tags.add("daily-note");
      const ctx: RewriteCtx = { resolver, noteIdByPath, importAttachment, report };
      const body = await rewriteBody(stripTitleHeading(noteBody, title), notePath, ctx);
      const properties = {
        ...rewritePropertyLinks(frontmatterProperties(data), notePath, ctx),
        ...(day ? { date: day } : {}),
        obsidianPath: notePath,
      };
      const placement = decideParent(store, p.existing, folderId, createdThisRun);
      const r = store.upsertBySource(
        src(notePath, { hash }),
        {
          kind: "doc",
          id: p.id,
          title,
          parentId: placement.parentId,
          body,
          tags: [...tags],
          properties,
        },
        { reparent: placement.reparent },
      );
      // Unchanged body/props but new hash (e.g. whitespace) — record the hash.
      if (r.status === "unchanged" && r.node.source?.hash !== hash) {
        store.update({ id: r.node.id, source: { ...r.node.source!, hash } });
      }
      tally(report, r.status);
      opts.onWrite?.(r.node.id);
    } catch (err) {
      if (isCancelled(err)) throw err;
      report.errors.push({ id: notePath, title, error: errorMessage(err) });
    }
    done += 1;
  }
  // Attachments nobody linked to (PDFs etc. dropped into the vault) still
  // belong to the collection. Unreferenced images are skipped (they are almost
  // always pasted-image leftovers).
  for (const f of others) {
    throwIfCancelled(opts.signal);
    if (assetUrl.has(f.path) || fileNodeId.has(f.path)) continue;
    if (IMAGE_EXTS.has(path.posix.extname(f.path).toLowerCase())) continue;
    await importAttachment(f.path);
  }
  // Re-sync: notes imported before that are gone from the vault.
  const present = new Set(files.map((f) => `${vk}:${f.path}`));
  for (const n of store.all()) {
    if (
      n.source?.type === "obsidian" &&
      n.kind !== "folder" &&
      n.source.id?.startsWith(`${vk}:`) &&
      !n.deletedAt &&
      !present.has(n.source.id)
    ) {
      report.missing += 1;
    }
  }
  opts.onProgress?.({ phase: "write", done: total, total });
}

interface RewriteCtx {
  resolver: VaultResolver;
  noteIdByPath: Map<string, string>;
  importAttachment: (
    p: string,
  ) => Promise<{ kind: "asset"; url: string } | { kind: "file"; id: string } | null>;
  report: ObsidianImportReport;
}

const WHOLE_WIKILINK_RE = /^\[\[([^\]\n]+)\]\]$/;

/** A stored body still holding `[[links]]` outside code (i.e. unresolved at last import). */
function hasWikiLinks(body: string): boolean {
  return body.includes("[[") && parseWikiLinks(body).some((l) => l.target);
}

/**
 * Frontmatter values that are a single `[[wikilink]]` (Obsidian "link"
 * properties, e.g. `related: "[[Other note]]"` or a list of them) become
 * `doc:<id>` references, so the graph and backlinks see them. Unresolvable
 * ones keep their text.
 */
export function rewritePropertyLinks(
  props: Record<string, DocPropertyValue>,
  fromPath: string,
  ctx: Pick<RewriteCtx, "resolver" | "noteIdByPath" | "report">,
): Record<string, DocPropertyValue> {
  const one = (v: string): string => {
    const m = WHOLE_WIKILINK_RE.exec(v.trim());
    if (!m) return v;
    const target = m[1]!.split("|")[0]!.split("#")[0]!.trim();
    if (!target) return v;
    const hit = ctx.resolver.resolve(target, fromPath);
    const id = hit ? ctx.noteIdByPath.get(hit) : undefined;
    if (id) {
      noteResolvedLink(ctx.report);
      return `doc:${id}`;
    }
    noteUnresolvedLink(ctx.report, fromPath, target);
    return v;
  };
  const out: Record<string, DocPropertyValue> = {};
  for (const [k, v] of Object.entries(props)) {
    if (typeof v === "string") out[k] = one(v);
    else if (Array.isArray(v)) out[k] = v.map(one);
    else out[k] = v;
  }
  return out;
}

/** Rewrite wikilinks, embeds and relative links in a note body. */
export async function rewriteBody(
  body: string,
  fromPath: string,
  ctx: RewriteCtx,
): Promise<string> {
  type Edit = { start: number; end: number; text: string };
  const edits: Edit[] = [];
  const linkTo = async (target: string, label: string, embed: boolean): Promise<string | null> => {
    const hit = ctx.resolver.resolve(target, fromPath);
    if (!hit) return null;
    const noteId = ctx.noteIdByPath.get(hit);
    if (noteId) {
      noteResolvedLink(ctx.report);
      return embed
        ? `> ↪ Embedded note: [${mdLabel(label)}](doc:${noteId})`
        : `[${mdLabel(label)}](doc:${noteId})`;
    }
    const att = await ctx.importAttachment(hit);
    if (!att) return null;
    noteResolvedLink(ctx.report);
    if (att.kind === "asset") return `${embed ? "!" : ""}[${mdLabel(label)}](${att.url})`;
    return `[${mdLabel(label)}](doc:${att.id})`;
  };
  for (const l of parseWikiLinks(body)) {
    const fallbackLabel =
      l.alias ?? (l.fragment && !l.target ? l.fragment : (l.target.split("/").pop() ?? l.target));
    if (!l.target) continue; // same-note heading link
    // `![[img.png|300]]` uses the pipe for size, not a label.
    const label =
      l.embed && l.alias && /^\d+(x\d+)?$/.test(l.alias)
        ? l.target.split("/").pop()!
        : fallbackLabel;
    const text = await linkTo(l.target, label, l.embed);
    if (text) edits.push({ start: l.start, end: l.end, text });
    else noteUnresolvedLink(ctx.report, fromPath, l.target);
  }
  for (const l of parseLocalMdLinks(body)) {
    if (edits.some((e) => l.start < e.end && l.end > e.start)) continue;
    const href = l.href.split("#")[0]!;
    if (!href) continue;
    const text = await linkTo(href, l.label || href.split("/").pop()!, l.embed);
    if (text)
      edits.push({ start: l.start, end: l.end, text: text.replace(/^> ↪ Embedded note: /, "") });
    else if (/\.md$/i.test(href)) noteUnresolvedLink(ctx.report, fromPath, href);
  }
  edits.sort((a, b) => b.start - a.start);
  let out = body;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out.replace(/^\s+/, "");
}
