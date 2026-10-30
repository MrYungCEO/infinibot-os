import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AgencyOperationsStore } from "./store.js";
import { DEFAULT_AGENCY_ID } from "./types.js";

describe("agency operations replication", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeStore(name: string): { store: AgencyOperationsStore; path: string } {
    const dir = mkdtempSync(join(tmpdir(), `agency-replication-${name}-`));
    dirs.push(dir);
    const path = join(dir, "agency.db");
    return { store: new AgencyOperationsStore(path), path };
  }

  it("converges independent offline rows in both directions and survives restart", () => {
    const a = makeStore("a");
    const b = makeStore("b");
    a.store.createClient({ name: "Created offline on A" }, { agencyId: DEFAULT_AGENCY_ID });
    b.store.createClient({ name: "Created offline on B" }, { agencyId: DEFAULT_AGENCY_ID });

    const pushed = a.store.exportReplicationSnapshot(DEFAULT_AGENCY_ID, "node-a");
    const firstMerge = b.store.mergeReplicationSnapshot(pushed, "node-b");
    expect(firstMerge.inserted).toBeGreaterThan(0);

    const pulled = b.store.exportReplicationSnapshot(DEFAULT_AGENCY_ID, "node-b");
    a.store.mergeReplicationSnapshot(pulled, "node-a");
    expect(
      a.store
        .listClients(DEFAULT_AGENCY_ID)
        .map((client) => client.name)
        .sort(),
    ).toEqual(["Created offline on A", "Created offline on B"]);
    expect(
      b.store
        .listClients(DEFAULT_AGENCY_ID)
        .map((client) => client.name)
        .sort(),
    ).toEqual(["Created offline on A", "Created offline on B"]);

    const duplicate = a.store.mergeReplicationSnapshot(pulled, "node-a");
    expect(duplicate.inserted).toBe(0);
    expect(duplicate.updated).toBe(0);

    b.store.close();
    const reopened = new AgencyOperationsStore(b.path);
    expect(reopened.listClients(DEFAULT_AGENCY_ID)).toHaveLength(2);
    expect(reopened.getReplicationStatus(DEFAULT_AGENCY_ID, "node-b").lastSyncAt).not.toBeNull();
    reopened.close();
    a.store.close();
  });

  it("rejects cross-agency rows instead of leaking data across workspace boundaries", () => {
    const a = makeStore("scope-a");
    const b = makeStore("scope-b");
    const snapshot = a.store.exportReplicationSnapshot(DEFAULT_AGENCY_ID, "node-a");
    const clients = snapshot.tables.find((table) => table.name === "clients");
    clients?.rows.push({
      id: "foreign-client",
      agency_id: "another-agency",
      name: "Must not import",
      status: "active",
      created_at: Date.now(),
      updated_at: Date.now(),
    });

    b.store.mergeReplicationSnapshot(snapshot, "node-b");
    expect(
      b.store.listClients(DEFAULT_AGENCY_ID).some((client) => client.id === "foreign-client"),
    ).toBe(false);
    a.store.close();
    b.store.close();
  });

  it("propagates durable tombstones so stale peers cannot resurrect deleted work", () => {
    const a = makeStore("delete-a");
    const b = makeStore("delete-b");
    const project = a.store.createProject(DEFAULT_AGENCY_ID, { name: "Temporary project" });
    a.store.createTask(DEFAULT_AGENCY_ID, {
      projectId: project.id,
      title: "Temporary task",
      acceptanceCriteria: "Done",
    });
    const beforeDelete = a.store.exportReplicationSnapshot(DEFAULT_AGENCY_ID, "node-a");
    b.store.mergeReplicationSnapshot(beforeDelete, "node-b");
    expect(b.store.listProjects(DEFAULT_AGENCY_ID)).toHaveLength(1);
    expect(b.store.listTasks(DEFAULT_AGENCY_ID)).toHaveLength(1);

    a.store.deleteProject(DEFAULT_AGENCY_ID, project.id);
    b.store.mergeReplicationSnapshot(
      a.store.exportReplicationSnapshot(DEFAULT_AGENCY_ID, "node-a"),
      "node-b",
    );
    expect(b.store.listProjects(DEFAULT_AGENCY_ID)).toHaveLength(0);
    expect(b.store.listTasks(DEFAULT_AGENCY_ID)).toHaveLength(0);

    // A pre-delete snapshot arriving later must be ignored by the tombstone.
    b.store.mergeReplicationSnapshot(beforeDelete, "node-b");
    expect(b.store.listProjects(DEFAULT_AGENCY_ID)).toHaveLength(0);
    a.store.close();
    b.store.close();
  });

  it("does not rewrite or re-audit unchanged legacy entities", () => {
    const a = makeStore("legacy-idempotency");
    const input = {
      agencyId: DEFAULT_AGENCY_ID,
      sourceId: "legacy-client-1",
      sourceHash: "stable-source-hash",
      name: "Stable client",
      updatedAt: 1_750_000_000_000,
    };
    a.store.importLegacyClient(input, "migration");
    a.store.importLegacyClient(input, "migration");
    const events = a.store
      .listAgencyAuditEvents(DEFAULT_AGENCY_ID, { limit: 100 })
      .filter((event) => event.entityId.includes("legacy-client-1"));
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe("legacy_imported");
    a.store.close();
  });
});
