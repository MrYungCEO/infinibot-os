import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { requireNodeSqlite } from "../../memory/sqlite.js";
import {
  probeStores,
  probeVectorIndex,
  readPersona,
  recentToolsFromTranscripts,
  toMs,
  type ProbePaths,
} from "./probes.js";

let dir: string;
let paths: ProbePaths;

function db(file: string, sql: string) {
  const { DatabaseSync } = requireNodeSqlite();
  const d = new DatabaseSync(file);
  d.exec(sql);
  d.close();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kp-probes-"));
  paths = {
    stateDir: dir,
    legacyStateDir: path.join(dir, "legacy"),
    vaultDb: path.join(dir, "vault.db"),
  };
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("probeStores", () => {
  it("degrades every missing store to not-configured without throwing", () => {
    const s = probeStores(paths);
    for (const probe of Object.values(s)) {
      expect(probe.status).toBe("not-configured");
      expect(probe.count).toBeNull();
    }
  });

  it("counts kanban projects/tasks and attributes assigned tasks per agent", () => {
    db(
      path.join(dir, "kanban.db"),
      `CREATE TABLE projects (id TEXT, updatedAt TEXT);
       CREATE TABLE tasks (id TEXT, status TEXT, done INTEGER, assignedAgent TEXT, updatedAt TEXT);
       INSERT INTO projects VALUES ('p1', '2026-09-01T00:00:00Z'), ('p2', '2026-09-02T00:00:00Z');
       INSERT INTO tasks VALUES ('t1','todo',0,'Coder','2026-09-03T00:00:00Z'), ('t2','done',1,'coder',NULL), ('t3','todo',0,NULL,NULL);`,
    );
    const k = probeStores(paths).kanban;
    expect(k.status).toBe("ok");
    expect(k.count).toBe(2);
    expect(k.detail).toEqual({ projects: 2, tasks: 3, openTasks: 2 });
    expect(k.byAgent).toEqual({ coder: 2 });
    expect(k.lastUpdatedAt).toBe(Date.parse("2026-09-03T00:00:00Z"));
  });

  it("reads notes from the mapped role database, reports per source_agent, CRM roles", () => {
    db(
      path.join(dir, "databases.db"),
      `CREATE TABLE system_databases (role TEXT, database_id TEXT, updated_at INTEGER);
       CREATE TABLE databases (id TEXT, updated_at INTEGER);
       CREATE TABLE database_rows (id TEXT, database_id TEXT, updated_at INTEGER);
       CREATE TABLE reports (id TEXT, created_at INTEGER, source_agent TEXT);
       INSERT INTO system_databases VALUES ('notes','dbn',1), ('clients','dbc',1);
       INSERT INTO databases VALUES ('dbn', 1000), ('dbc', 2000);
       INSERT INTO database_rows VALUES ('r1','dbn',1700000000000), ('r2','dbn',1700000001000), ('r3','dbc',5);
       INSERT INTO reports VALUES ('a', 1700000000, 'cmo'), ('b', 1700000005, 'cmo'), ('c', 1700000009, NULL);`,
    );
    const s = probeStores(paths);
    expect(s.notes).toMatchObject({ status: "ok", count: 2, lastUpdatedAt: 1700000001000 });
    expect(s.databases).toMatchObject({
      status: "ok",
      count: 2,
      detail: { databases: 2, rows: 3 },
    });
    expect(s.crm).toMatchObject({ status: "ok", count: 1, detail: { clients: 1 } });
    // seconds → ms normalisation
    expect(s.reports).toMatchObject({
      status: "ok",
      count: 3,
      byAgent: { cmo: 2 },
      lastUpdatedAt: 1700000009000,
    });
  });

  it("falls back to legacy markdown notes when the notes role isn't mapped", () => {
    fs.mkdirSync(path.join(paths.legacyStateDir, "notes"), { recursive: true });
    fs.writeFileSync(path.join(paths.legacyStateDir, "notes", "a.md"), "# a");
    fs.writeFileSync(path.join(paths.legacyStateDir, "notes", "b.txt"), "skip");
    expect(probeStores(paths).notes).toMatchObject({ status: "ok", count: 1 });
  });

  it("reports an empty store as empty and a broken one as error", () => {
    db(
      path.join(dir, "directories.db"),
      `CREATE TABLE directories (id TEXT, agentId TEXT, active INTEGER, updatedAt TEXT);`,
    );
    fs.writeFileSync(path.join(dir, "content-intel.db"), "not a sqlite file");
    const s = probeStores(paths);
    expect(s.directories.status).toBe("empty");
    expect(s.contentIntel.status).toBe("error");
  });
});

describe("file probes", () => {
  it("parses persona fields from IDENTITY.md and ignores placeholders", () => {
    fs.writeFileSync(
      path.join(dir, "IDENTITY.md"),
      "# IDENTITY\n- **Name:** Nova\n- **Emoji:** 🜂 (alchemical fire)\n- **Avatar:** *(to be found)*\n- **Vibe:** *(to be decided)*\n",
    );
    expect(readPersona(dir)).toEqual({ name: "Nova", emoji: "🜂" });
    expect(readPersona(path.join(dir, "missing"))).toEqual({});
  });

  it("never takes the stock template's next-line hints as values", () => {
    // Exact shape of the IDENTITY.md template agent workspaces are seeded with.
    fs.writeFileSync(
      path.join(dir, "IDENTITY.md"),
      [
        "# IDENTITY.md - Who Am I?",
        "",
        "- **Name:**",
        "  *(pick something you like)*",
        "- **Creature:**",
        "  *(AI? robot? familiar? ghost in the machine? something weirder?)*",
        "- **Emoji:**",
        "  *(your signature — pick one that feels right)*",
        "",
      ].join("\n"),
    );
    expect(readPersona(dir)).toEqual({});
  });

  it("drops an emoji value that is prose, keeps a real glyph", () => {
    fs.writeFileSync(path.join(dir, "IDENTITY.md"), "- **Name:** Scout\n- **Emoji:** telescope\n");
    expect(readPersona(dir)).toEqual({ name: "Scout" });
    fs.writeFileSync(path.join(dir, "IDENTITY.md"), "- **Name:** Scout\n- **Emoji:** 🔭\n");
    expect(readPersona(dir)).toEqual({ name: "Scout", emoji: "🔭" });
  });

  it("counts tool calls from transcript tails without double counting results", () => {
    const f = path.join(dir, "s.jsonl");
    fs.writeFileSync(
      f,
      [
        JSON.stringify({
          message: { content: [{ type: "toolCall", id: "1", name: "notes", arguments: {} }] },
        }),
        JSON.stringify({ message: { role: "toolResult", toolName: "notes" } }),
        JSON.stringify({
          message: { content: [{ type: "tool_use", id: "x", name: "Bash", input: {} }] },
        }),
        JSON.stringify({ content: "🔧 Bash: ls" }),
      ].join("\n"),
    );
    expect(recentToolsFromTranscripts([f, path.join(dir, "gone.jsonl")])).toEqual([
      { name: "Bash", count: 2 },
      { name: "notes", count: 1 },
    ]);
  });

  it("summarises a vector index by source and reports a missing index", () => {
    const idx = path.join(dir, "main.sqlite");
    db(
      idx,
      `CREATE TABLE files (path TEXT, source TEXT);
       CREATE TABLE chunks (id TEXT, source TEXT, updated_at INTEGER);
       INSERT INTO files VALUES ('a','memory'), ('b','sessions');
       INSERT INTO chunks VALUES ('1','memory',10), ('2','memory',20), ('3','sessions',30);`,
    );
    const { DatabaseSync } = requireNodeSqlite();
    const open = (f: string) => {
      if (!fs.existsSync(f)) return null;
      const d = new DatabaseSync(f, { readOnly: true });
      return {
        get: (s: string, ...a: unknown[]) =>
          d.prepare(s).get(...(a as never[])) as Record<string, unknown>,
        all: (s: string, ...a: unknown[]) =>
          d.prepare(s).all(...(a as never[])) as Array<Record<string, unknown>>,
        close: () => d.close(),
      };
    };
    expect(probeVectorIndex(idx, open)).toMatchObject({
      status: "ok",
      files: 2,
      chunks: 3,
      sources: { memory: { files: 1, chunks: 2 }, sessions: { files: 1, chunks: 1 } },
    });
    expect(probeVectorIndex(path.join(dir, "nope.sqlite"), open).status).toBe("not-configured");
  });

  it("normalises timestamps", () => {
    expect(toMs(1700000000)).toBe(1700000000000);
    expect(toMs("1700000000000")).toBe(1700000000000);
    expect(toMs("2026-01-01T00:00:00Z")).toBe(Date.parse("2026-01-01T00:00:00Z"));
    expect(toMs(null)).toBeNull();
    expect(toMs("garbage")).toBeNull();
  });
});
