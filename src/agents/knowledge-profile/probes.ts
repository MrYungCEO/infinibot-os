/**
 * Read-only probes over the EXISTING knowledge stores. Every probe opens its
 * store read-only (never through the store singletons, which create tables /
 * seed rows), answers with cheap COUNT/MAX queries, and degrades to a status
 * instead of throwing when the store is missing or unreadable.
 *
 * Paths mirror what each gateway handler uses today:
 *   - stateDir       → resolveStateDir()/INFINIBOT_STATE_DIR (kanban, databases,
 *                      reports, directories, content-intel)
 *   - legacyStateDir → INFINIBOT_STATE_DIR ?? "state" (notes, research, Notion)
 *   - vaultDb        → INFINIBOT_ROOT/state/vault/vault.db
 */

import fs from "node:fs";
import path from "node:path";

import { requireNodeSqlite } from "../../memory/sqlite.js";
import type { SourceStatus } from "./types.js";
import { sanitizeIdentityEmoji } from "../../shared/identity-emoji.js";
import { isIdentityPlaceholder } from "../identity-file.js";

export interface ReadonlyDb {
  get(sql: string, ...args: unknown[]): Record<string, unknown> | undefined;
  all(sql: string, ...args: unknown[]): Array<Record<string, unknown>>;
  close(): void;
}

export type OpenDb = (file: string) => ReadonlyDb | null;

export interface ProbePaths {
  stateDir: string;
  legacyStateDir: string;
  vaultDb: string;
}

export interface CountProbe {
  status: SourceStatus;
  count: number | null;
  detail?: Record<string, number>;
  lastUpdatedAt: number | null;
  /** agentId → items attributed to that agent. */
  byAgent?: Record<string, number>;
  note?: string;
}

export interface StoreSnapshot {
  notes: CountProbe;
  kanban: CountProbe;
  databases: CountProbe;
  notion: CountProbe;
  crm: CountProbe;
  reports: CountProbe;
  directories: CountProbe;
  contentIntel: CountProbe;
  research: CountProbe;
  vault: CountProbe;
}

/** node:sqlite read-only opener (the gateway runs Node 22+). */
export function defaultOpenDb(file: string): ReadonlyDb | null {
  if (!fs.existsSync(file)) return null;
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(file, { readOnly: true });
  return {
    get: (sql, ...args) =>
      db.prepare(sql).get(...(args as never[])) as Record<string, unknown> | undefined,
    all: (sql, ...args) =>
      db.prepare(sql).all(...(args as never[])) as Array<Record<string, unknown>>,
    close: () => db.close(),
  };
}

/** Epoch-ms from a number (s or ms) or a date string. */
export function toMs(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number" || (typeof v === "string" && /^\d+(\.\d+)?$/.test(v))) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
  }
  const parsed = Date.parse(String(v));
  return Number.isFinite(parsed) ? parsed : null;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

const missing = (note: string): CountProbe => ({
  status: "not-configured",
  count: null,
  lastUpdatedAt: null,
  note,
});

const failed = (e: unknown): CountProbe => ({
  status: "error",
  count: null,
  lastUpdatedAt: null,
  note: e instanceof Error ? e.message : String(e),
});

function withDb(
  openDb: OpenDb,
  file: string,
  what: string,
  fn: (db: ReadonlyDb) => CountProbe,
): CountProbe {
  let db: ReadonlyDb | null = null;
  try {
    db = openDb(file);
    if (!db) return missing(`${what} store not found (${file})`);
    return fn(db);
  } catch (e) {
    return failed(e);
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

function tableExists(db: ReadonlyDb, table: string): boolean {
  return !!db.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", table);
}

function finish(p: CountProbe): CountProbe {
  if (p.status === "ok" && (p.count ?? 0) === 0) return { ...p, status: "empty" };
  return p;
}

function groupCounts(rows: Array<Record<string, unknown>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const key = typeof r.k === "string" ? r.k.trim().toLowerCase() : "";
    if (key) out[key] = (out[key] ?? 0) + num(r.c);
  }
  return out;
}

function roleDatabaseId(db: ReadonlyDb, role: string): string | null {
  if (!tableExists(db, "system_databases")) return null;
  const row = db.get("SELECT database_id FROM system_databases WHERE role = ?", role);
  return typeof row?.database_id === "string" ? row.database_id : null;
}

function dirStats(
  dir: string,
  filter: (name: string) => boolean,
): { count: number; latest: number | null } {
  let count = 0;
  let latest: number | null = null;
  for (const name of fs.readdirSync(dir)) {
    if (!filter(name)) continue;
    count++;
    try {
      const m = fs.statSync(path.join(dir, name)).mtimeMs;
      if (latest === null || m > latest) latest = m;
    } catch {}
  }
  return { count, latest };
}

export function probeNotes(paths: ProbePaths, openDb: OpenDb): CountProbe {
  // Notes are role-resolved: when the "notes" system role is mapped to a
  // database (the live setup), rows live in databases.db; else legacy *.md.
  const dbFile = path.join(paths.stateDir, "databases.db");
  try {
    const db = openDb(dbFile);
    if (db) {
      try {
        const id = roleDatabaseId(db, "notes");
        if (id) {
          const r = db.get(
            "SELECT COUNT(*) c, MAX(updated_at) u FROM database_rows WHERE database_id = ?",
            id,
          );
          return finish({
            status: "ok",
            count: num(r?.c),
            lastUpdatedAt: toMs(r?.u),
            note: "Notes role → database rows",
          });
        }
      } finally {
        db.close();
      }
    }
  } catch (e) {
    return failed(e);
  }
  const dir = path.join(paths.legacyStateDir, "notes");
  if (!fs.existsSync(dir)) return missing("No notes store");
  try {
    const s = dirStats(dir, (n) => n.endsWith(".md"));
    return finish({
      status: "ok",
      count: s.count,
      lastUpdatedAt: s.latest,
      note: "Markdown notes",
    });
  } catch (e) {
    return failed(e);
  }
}

export function probeKanban(paths: ProbePaths, openDb: OpenDb): CountProbe {
  return withDb(openDb, path.join(paths.stateDir, "kanban.db"), "Kanban", (db) => {
    const projects = num(db.get("SELECT COUNT(*) c FROM projects")?.c);
    const t = db.get(
      "SELECT COUNT(*) c, MAX(updatedAt) u, SUM(CASE WHEN done = 1 OR status = 'done' THEN 0 ELSE 1 END) o FROM tasks",
    );
    const byAgent = groupCounts(
      db.all(
        "SELECT assignedAgent k, COUNT(*) c FROM tasks WHERE assignedAgent IS NOT NULL AND assignedAgent != '' GROUP BY assignedAgent",
      ),
    );
    const p = db.get("SELECT MAX(updatedAt) u FROM projects");
    const last = Math.max(toMs(t?.u) ?? 0, toMs(p?.u) ?? 0) || null;
    return finish({
      status: "ok",
      count: projects,
      detail: { projects, tasks: num(t?.c), openTasks: num(t?.o) },
      lastUpdatedAt: last,
      byAgent,
    });
  });
}

export function probeDatabases(paths: ProbePaths, openDb: OpenDb): CountProbe {
  return withDb(openDb, path.join(paths.stateDir, "databases.db"), "Databases", (db) => {
    const d = db.get("SELECT COUNT(*) c, MAX(updated_at) u FROM databases");
    const r = db.get("SELECT COUNT(*) c, MAX(updated_at) u FROM database_rows");
    const last = Math.max(toMs(d?.u) ?? 0, toMs(r?.u) ?? 0) || null;
    return finish({
      status: "ok",
      count: num(d?.c),
      detail: { databases: num(d?.c), rows: num(r?.c) },
      lastUpdatedAt: last,
    });
  });
}

export function probeCrm(paths: ProbePaths, openDb: OpenDb): CountProbe {
  return withDb(openDb, path.join(paths.stateDir, "databases.db"), "CRM", (db) => {
    const detail: Record<string, number> = {};
    let last: number | null = null;
    let mapped = 0;
    for (const role of ["clients", "leads", "products"]) {
      const id = roleDatabaseId(db, role);
      if (!id) continue;
      mapped++;
      const r = db.get(
        "SELECT COUNT(*) c, MAX(updated_at) u FROM database_rows WHERE database_id = ?",
        id,
      );
      detail[role] = num(r?.c);
      const u = toMs(r?.u);
      if (u && (!last || u > last)) last = u;
    }
    if (!mapped) return missing("No CRM roles mapped");
    const total = Object.values(detail).reduce((a, b) => a + b, 0);
    return finish({ status: "ok", count: total, detail, lastUpdatedAt: last });
  });
}

export function probeReports(paths: ProbePaths, openDb: OpenDb): CountProbe {
  return withDb(openDb, path.join(paths.stateDir, "databases.db"), "Reports", (db) => {
    if (!tableExists(db, "reports")) return missing("Reports table not created yet");
    const r = db.get("SELECT COUNT(*) c, MAX(created_at) u FROM reports");
    const byAgent = groupCounts(
      db.all(
        "SELECT source_agent k, COUNT(*) c FROM reports WHERE source_agent IS NOT NULL AND source_agent != '' GROUP BY source_agent",
      ),
    );
    return finish({ status: "ok", count: num(r?.c), lastUpdatedAt: toMs(r?.u), byAgent });
  });
}

export function probeDirectories(paths: ProbePaths, openDb: OpenDb): CountProbe {
  return withDb(openDb, path.join(paths.stateDir, "directories.db"), "Directories", (db) => {
    const r = db.get(
      "SELECT COUNT(*) c, MAX(updatedAt) u FROM directories WHERE active = 1 OR active IS NULL",
    );
    const byAgent = groupCounts(
      db.all(
        "SELECT agentId k, COUNT(*) c FROM directories WHERE agentId IS NOT NULL AND agentId != '' AND (active = 1 OR active IS NULL) GROUP BY agentId",
      ),
    );
    return finish({ status: "ok", count: num(r?.c), lastUpdatedAt: toMs(r?.u), byAgent });
  });
}

export function probeContentIntel(paths: ProbePaths, openDb: OpenDb): CountProbe {
  return withDb(openDb, path.join(paths.stateDir, "content-intel.db"), "Content intel", (db) => {
    const r = db.get(
      "SELECT COUNT(*) c, SUM(has_transcript) t, SUM(has_score) s, MAX(updated_at) u FROM reels",
    );
    return finish({
      status: "ok",
      count: num(r?.c),
      detail: { reels: num(r?.c), transcribed: num(r?.t), scored: num(r?.s) },
      lastUpdatedAt: toMs(r?.u),
    });
  });
}

export function probeResearch(paths: ProbePaths, openDb: OpenDb): CountProbe {
  return withDb(openDb, path.join(paths.legacyStateDir, "research.db"), "Research", (db) => {
    const topics = num(db.get("SELECT COUNT(*) c FROM topics")?.c);
    const a = db.get("SELECT COUNT(*) c, MAX(fetchedAt) u FROM articles");
    const watch = tableExists(db, "watchlist")
      ? num(db.get("SELECT COUNT(*) c FROM watchlist")?.c)
      : 0;
    return finish({
      status: "ok",
      count: num(a?.c),
      detail: { topics, articles: num(a?.c), watchlist: watch },
      lastUpdatedAt: toMs(a?.u),
    });
  });
}

export function probeVault(paths: ProbePaths, openDb: OpenDb): CountProbe {
  return withDb(openDb, paths.vaultDb, "Vault", (db) => {
    const courses = tableExists(db, "vault_courses")
      ? num(db.get("SELECT COUNT(*) c FROM vault_courses")?.c)
      : 0;
    const members = tableExists(db, "vault_members")
      ? num(db.get("SELECT COUNT(*) c FROM vault_members")?.c)
      : 0;
    const lessons = tableExists(db, "vault_lessons")
      ? num(db.get("SELECT COUNT(*) c FROM vault_lessons")?.c)
      : 0;
    let last: number | null = null;
    try {
      last = toMs(db.get("SELECT MAX(updated_at) u FROM vault_courses")?.u);
    } catch {}
    return finish({
      status: "ok",
      count: courses + members,
      detail: { courses, members, lessons },
      lastUpdatedAt: last,
    });
  });
}

export function probeNotion(paths: ProbePaths): CountProbe {
  const file = path.join(paths.legacyStateDir, "notion-databases.json");
  if (!fs.existsSync(file)) return missing("Notion not connected");
  try {
    const st = fs.statSync(file);
    if (st.size > 8 * 1024 * 1024)
      return {
        status: "ok",
        count: null,
        lastUpdatedAt: st.mtimeMs,
        note: "file too large to count",
      };
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { databases?: unknown[] };
    const count = Array.isArray(raw.databases) ? raw.databases.length : 0;
    return finish({ status: "ok", count, lastUpdatedAt: st.mtimeMs });
  } catch (e) {
    return failed(e);
  }
}

export function probeStores(paths: ProbePaths, openDb: OpenDb = defaultOpenDb): StoreSnapshot {
  return {
    notes: probeNotes(paths, openDb),
    kanban: probeKanban(paths, openDb),
    databases: probeDatabases(paths, openDb),
    notion: probeNotion(paths),
    crm: probeCrm(paths, openDb),
    reports: probeReports(paths, openDb),
    directories: probeDirectories(paths, openDb),
    contentIntel: probeContentIntel(paths, openDb),
    research: probeResearch(paths, openDb),
    vault: probeVault(paths, openDb),
  };
}

// ── Per-agent file probes ────────────────────────────────────────────

export const IDENTITY_FILE_NAMES = [
  "SOUL.md",
  "USER.md",
  "AGENTS.md",
  "IDENTITY.md",
  "MEMORY.md",
  "TOOLS.md",
  "HEARTBEAT.md",
] as const;

/** Parse "- **Name:** Nova" style fields from the head of IDENTITY.md (≤4 KB). */
export function readPersona(workspace: string): Record<string, string> {
  const file = path.join(workspace, "IDENTITY.md");
  const out: Record<string, string> = {};
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, 4096, 0);
    const text = buf.subarray(0, n).toString("utf8");
    // Value must be on the SAME line as the label ([ \t], not \s — the stock
    // template puts its "(pick one…)" hint on the next line, which \s used to
    // swallow as the value).
    const re =
      /^[ \t>*-]*\*{0,2}(Name|Emoji|Creature|Vibe|Theme)\*{0,2}[ \t]*:[ \t]*\*{0,2}[ \t]*(.+)$/gim;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const key = m[1].toLowerCase();
      const value = m[2].replace(/\*+/g, "").trim();
      if (!value || out[key]) continue;
      // Template hints: "(to be …)", fully parenthesised prompts, known placeholders.
      if (/^\(?to be/i.test(value.replace(/^[(*]+/, ""))) continue;
      if (/^\(.*\)$/.test(value) || isIdentityPlaceholder(value)) continue;
      out[key] = value;
    }
    if (out.emoji) {
      const emoji = sanitizeIdentityEmoji(out.emoji.split(/\s+\(/)[0].trim());
      if (emoji) out.emoji = emoji;
      else delete out.emoji;
    }
  } catch {
    // missing IDENTITY.md → no persona
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  return out;
}

export function statFile(file: string): { exists: boolean; size: number; mtimeMs: number | null } {
  try {
    const st = fs.statSync(file);
    return { exists: st.isFile(), size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return { exists: false, size: 0, mtimeMs: null };
  }
}

export function dailyMemoryStats(workspace: string): { count: number; latest: number | null } {
  const dir = path.join(workspace, "memory");
  try {
    return dirStats(dir, (n) => n.endsWith(".md"));
  } catch {
    return { count: 0, latest: null };
  }
}

/** Vector index DB (memory_search): counts by source, read-only. */
export function probeVectorIndex(
  storePath: string,
  openDb: OpenDb,
): {
  status: SourceStatus;
  files: number;
  chunks: number;
  sources: Record<string, { files: number; chunks: number }>;
  lastIndexedAt: number | null;
  error?: string;
} {
  const empty = {
    files: 0,
    chunks: 0,
    sources: {} as Record<string, { files: number; chunks: number }>,
    lastIndexedAt: null,
  };
  let db: ReadonlyDb | null = null;
  try {
    db = openDb(storePath);
    if (!db) return { status: "not-configured", ...empty, error: "index not built yet" };
    const sources: Record<string, { files: number; chunks: number }> = {};
    let files = 0;
    let chunks = 0;
    if (tableExists(db, "files")) {
      for (const r of db.all("SELECT source k, COUNT(*) c FROM files GROUP BY source")) {
        const k = String(r.k ?? "memory");
        sources[k] = { files: num(r.c), chunks: 0 };
        files += num(r.c);
      }
    }
    let last: number | null = null;
    if (tableExists(db, "chunks")) {
      for (const r of db.all(
        "SELECT source k, COUNT(*) c, MAX(updated_at) u FROM chunks GROUP BY source",
      )) {
        const k = String(r.k ?? "memory");
        sources[k] = { files: sources[k]?.files ?? 0, chunks: num(r.c) };
        chunks += num(r.c);
        const u = toMs(r.u);
        if (u && (!last || u > last)) last = u;
      }
    }
    return {
      status: chunks + files > 0 ? "ok" : "empty",
      files,
      chunks,
      sources,
      lastIndexedAt: last,
    };
  } catch (e) {
    return { status: "error", ...empty, error: e instanceof Error ? e.message : String(e) };
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

/**
 * Tool names used recently, from the TAIL of an agent's most recent session
 * transcripts (bounded: ≤ maxFiles × maxBytes). Recognises the pi transcript
 * `"type":"toolCall"…"name":"x"` records (not the matching toolResult, which
 * would double count), Claude Code `"type":"tool_use"` blocks and the CLI
 * stream "🔧 Name:" lines.
 */
export function recentToolsFromTranscripts(
  files: string[],
  opts: { maxFiles?: number; maxBytes?: number } = {},
): Array<{ name: string; count: number }> {
  const maxBytes = opts.maxBytes ?? 256 * 1024;
  const counts = new Map<string, number>();
  const bump = (n: string) => counts.set(n, (counts.get(n) ?? 0) + 1);
  for (const file of files.slice(0, opts.maxFiles ?? 4)) {
    let fd: number | null = null;
    try {
      const size = fs.statSync(file).size;
      const len = Math.min(size, maxBytes);
      fd = fs.openSync(file, "r");
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      const text = buf.toString("utf8");
      for (const m of text.matchAll(/"type":"toolCall"[^{}]*?"name":"([A-Za-z0-9_.-]+)"/g))
        bump(m[1]);
      for (const m of text.matchAll(/"type":"tool_use","id":"[^"]*","name":"([A-Za-z0-9_.-]+)"/g))
        bump(m[1]);
      for (const m of text.matchAll(/🔧 ([A-Za-z][A-Za-z0-9_.-]*):/g)) bump(m[1]);
    } catch {
      // unreadable / rotated transcript — skip
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);
}
