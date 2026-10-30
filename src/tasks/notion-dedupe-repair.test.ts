import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { repairNotionDuplicates } from "./notion-dedupe-repair.js";
import { getKanbanStore } from "./store.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "notion-dedupe-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Build a kanban.db shaped like the live one after the 60s-duplicate bug. */
async function seed(): Promise<void> {
  const store = getKanbanStore(dir);
  await store.getProjects(); // init schema
  const db = new Database(join(dir, "kanban.db"));
  // The pre-fix DB had no unique identity index.
  db.exec("DROP INDEX IF EXISTS idx_tasks_notion_unique");
  const ins = db.prepare(
    `INSERT INTO tasks (id, projectId, title, description, status, notionId, createdAt, updatedAt)
     VALUES (?, 'p1', ?, ?, ?, ?, ?, ?)`,
  );
  const A = "3dcf4bdd-9bcf-8146-8b9e-ecb65514c880";
  // 50 copies of page A; copy a-7 is the "rich" one (description + content + an edge).
  for (let i = 0; i < 50; i++) {
    ins.run(
      `a-${i}`,
      "Page A",
      i === 7 ? "the real description" : null,
      "todo",
      A,
      1000 + i,
      2000 + i,
    );
  }
  // 3 copies of page B written with mixed id forms.
  ins.run("b-0", "Page B", null, "done", "3cef4bdd-9bcf-8148-9690-f76cab3a34b2", 1, 5);
  ins.run("b-1", "Page B", null, "done", "3cef4bdd9bcf81489690f76cab3a34b2", 2, 9);
  ins.run("b-2", "Page B", null, "done", "3cef4bdd-9bcf-8148-9690-f76cab3a34b2", 3, 7);
  // Unique pages and unlinked local tasks stay untouched.
  ins.run("c-0", "Page C", null, "todo", "3b6f4bdd-9bcf-8138-b2f6-ebfce80a27be", 1, 1);
  ins.run("local-1", "Local only", null, "todo", null, 1, 1);
  db.prepare(`INSERT INTO task_content_blocks (taskId, blocks, updatedAt) VALUES (?, ?, ?)`).run(
    "a-7",
    '[{"type":"p","text":"body"}]',
    5,
  );
  db.prepare(`INSERT INTO task_content_blocks (taskId, blocks, updatedAt) VALUES (?, ?, ?)`).run(
    "b-1",
    '[{"type":"p","text":"b body"}]',
    5,
  );
  db.close();
  const rel = new Database(join(dir, "object-relations.db"));
  rel.exec(`CREATE TABLE object_relations (id TEXT PRIMARY KEY, from_type TEXT, from_id TEXT, edge TEXT,
    to_type TEXT, to_id TEXT, created_at INTEGER, created_by TEXT DEFAULT '', meta TEXT DEFAULT '{}');
    CREATE UNIQUE INDEX idx_rel_unique ON object_relations(from_type, from_id, edge, to_type, to_id);`);
  rel
    .prepare(
      `INSERT INTO object_relations VALUES ('r1','project','p1','relates_to','task','a-7',1,'','{}')`,
    )
    .run();
  rel
    .prepare(
      `INSERT INTO object_relations VALUES ('r2','project','p1','relates_to','task','b-2',1,'','{}')`,
    )
    .run();
  // An edge on a copy that will be dropped must move to the keeper.
  rel
    .prepare(
      `INSERT INTO object_relations VALUES ('r3','client','c9','mentions','task','a-30',1,'','{}')`,
    )
    .run();
  rel.close();
}

function count(sql: string, ...args: unknown[]): number {
  const db = new Database(join(dir, "kanban.db"), { readonly: true });
  try {
    return (db.prepare(sql).get(...args) as { n: number }).n;
  } finally {
    db.close();
  }
}

describe("repairNotionDuplicates", () => {
  it("dry run reports the plan and writes nothing", async () => {
    await seed();
    const r = await repairNotionDuplicates({ stateDir: dir, dryRun: true });
    const t = r.tables.find((x) => x.table === "tasks")!;
    expect(t.rowsBefore).toBe(55);
    expect(t.groups).toBe(2);
    expect(t.duplicateRows).toBe(51);
    expect(t.rowsAfter).toBe(4);
    expect(t.topGroups[0]).toMatchObject({ rows: 50, keepId: "a-7" });
    // a-30 (dropped) has an edge that will move to a-7; b-1's content
    // blocks move onto b-2.
    expect(t.edgesOnDuplicateRows).toBe(1);
    expect(t.repointed.contentBlocks).toBe(1);
    expect(t.uniqueIndex).toBe("would-create");
    expect(r.backupDir).toBeNull();
    expect(count("SELECT COUNT(*) n FROM tasks")).toBe(55);
  });

  it("apply backs up, merges into the richest row, re-points links, and enforces the unique key", async () => {
    await seed();
    const r = await repairNotionDuplicates({ stateDir: dir, dryRun: false });
    const t = r.tables.find((x) => x.table === "tasks")!;
    expect(r.backupDir).toBeTruthy();
    expect(existsSync(join(r.backupDir!, "kanban.db"))).toBe(true);
    expect(existsSync(join(r.backupDir!, "object-relations.db"))).toBe(true);
    // Backup still has the pre-repair rows.
    const bk = new Database(join(r.backupDir!, "kanban.db"), { readonly: true });
    expect((bk.prepare("SELECT COUNT(*) n FROM tasks").get() as { n: number }).n).toBe(55);
    bk.close();

    expect(t.rowsAfter).toBe(4);
    expect(count("SELECT COUNT(*) n FROM tasks")).toBe(4);
    expect(
      count(
        "SELECT COUNT(*) n FROM tasks WHERE id = 'a-7' AND description = 'the real description'",
      ),
    ).toBe(1);
    expect(count("SELECT COUNT(*) n FROM task_content_blocks WHERE taskId = 'a-7'")).toBe(1);
    // B's keeper is b-2 (it carries a relation edge); it adopts b-1's content.
    expect(count("SELECT COUNT(*) n FROM tasks WHERE id = 'b-2'")).toBe(1);
    expect(count("SELECT COUNT(*) n FROM task_content_blocks WHERE taskId = 'b-2'")).toBe(1);
    const rel = new Database(join(dir, "object-relations.db"), { readonly: true });
    const edges = rel.prepare("SELECT to_id FROM object_relations ORDER BY id").all() as Array<{
      to_id: string;
    }>;
    rel.close();
    expect(edges.map((e) => e.to_id)).toEqual(["a-7", "b-2", "a-7"]);
    expect(count("SELECT COUNT(*) n FROM tasks WHERE id IN ('c-0','local-1')")).toBe(2);
    expect(t.uniqueIndex).toBe("created");
    expect(t.repointed.objectRelations).toBe(1);
    expect(t.duplicateEdgesMerged).toBe(0);

    // Idempotent: a second run finds nothing to do.
    const again = await repairNotionDuplicates({ stateDir: dir, dryRun: true });
    expect(again.tables.find((x) => x.table === "tasks")!.groups).toBe(0);

    // The unique key now blocks a duplicate insert outright.
    const db = new Database(join(dir, "kanban.db"));
    expect(() =>
      db
        .prepare(
          `INSERT INTO tasks (id, projectId, title, status, notionId, createdAt, updatedAt) VALUES ('dup','p1','x','todo',?,1,1)`,
        )
        .run("3b6f4bdd-9bcf-8138-b2f6-ebfce80a27be"),
    ).toThrow(/UNIQUE/);
    db.close();
  });

  it("no kanban.db → empty report", async () => {
    const r = await repairNotionDuplicates({ stateDir: dir, dryRun: true });
    expect(r.tables).toEqual([]);
  });
});
