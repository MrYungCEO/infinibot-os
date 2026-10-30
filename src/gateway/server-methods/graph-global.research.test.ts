import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Research workspace → knowledge graph: research reports and reports bound to
 * an object through objrel must stay on the graph after they fall out of the
 * newest-120 report window (system reports arrive every few minutes).
 */
describe("knowledge graph keeps research + linked reports", () => {
  let stateDir: string;
  let prevStateDir: string | undefined;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ib-graph-research-"));
    prevStateDir = process.env.INFINIBOT_STATE_DIR;
    process.env.INFINIBOT_STATE_DIR = stateDir;

    const { getKanbanStore } = await import("../../tasks/store.js");
    await getKanbanStore(stateDir).createProject({ id: "p-robo", name: "RoboPark", status: "In progress" });

    const { getReportsStore } = await import("../../reports/store.js");
    const reports = getReportsStore(stateDir);
    ids.research = reports.createReport({ kind: "research_brief", title: "Humanoid vendor scan", category: "research" }).id;
    ids.linkedManual = reports.createReport({ kind: "manual_render", title: "Kickoff deck", category: "general" }).id;
    ids.noise = reports.createReport({ kind: "oversight_event", title: "Sub-agent failed", category: "research" }).id;
    ids.unlinkedOld = reports.createReport({ kind: "manual_render", title: "Old invoice", category: "general" }).id;
    for (let i = 0; i < 130; i++) reports.createReport({ kind: "daily_summary", title: `Daily ${i}`, category: "operations" });

    // Push the four reports far behind the newest-120 window.
    const db = new Database(path.join(stateDir, "databases.db"));
    const old = db.prepare("UPDATE reports SET created_at = ? WHERE id = ?");
    for (const id of [ids.research, ids.linkedManual, ids.noise, ids.unlinkedOld]) old.run(1_000, id);
    db.close();

    const { getRelationsStore } = await import("../../relations/store.js");
    const rels = getRelationsStore(stateDir);
    rels.create({ fromType: "report", fromId: ids.research, edge: "report_documents_project", toType: "project", toId: "p-robo" });
    rels.create({ fromType: "report", fromId: ids.linkedManual, edge: "relates_to", toType: "project", toId: "p-robo" });
    rels.create({ fromType: "report", fromId: ids.research, edge: "relates_to", toType: "report", toId: ids.linkedManual });
  });

  afterAll(() => {
    if (prevStateDir === undefined) delete process.env.INFINIBOT_STATE_DIR;
    else process.env.INFINIBOT_STATE_DIR = prevStateDir;
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("graphs old research + linked reports with their edges, never the noise", async () => {
    const { buildSnapshot } = await import("./graph-global.js");
    const snap = await buildSnapshot({
      kinds: new Set(["project", "report"] as never[]),
      maxRowsPerDatabase: 0,
      stateDir,
    });
    const nodeIds = new Set(snap.nodes.map((n) => n.id));
    expect(nodeIds.has(`report:${ids.research}`)).toBe(true);
    expect(nodeIds.has(`report:${ids.linkedManual}`)).toBe(true);
    expect(nodeIds.has(`report:${ids.noise}`)).toBe(false);
    expect(nodeIds.has(`report:${ids.unlinkedOld}`)).toBe(false);
    const edge = (a: string, b: string) => snap.edges.some((e) => e.source === a && e.target === b);
    expect(edge(`report:${ids.research}`, "project:p-robo")).toBe(true);
    expect(edge(`report:${ids.linkedManual}`, "project:p-robo")).toBe(true);
    expect(edge(`report:${ids.research}`, `report:${ids.linkedManual}`)).toBe(true);
  });
});
