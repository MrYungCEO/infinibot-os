import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { AgencyOperationsStore } from "./store.js";
import { AGENCY_DATABASE_SCHEMA_VERSION } from "./resilience.js";
import { DEFAULT_AGENCY_ID } from "./types.js";
import { classifyDrift, externalLinkId, hashAgencyEntity } from "./external-links.js";

describe("agency external links (migration 8)", () => {
  let dir: string;
  let path: string;
  let store: AgencyOperationsStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agency-external-"));
    path = join(dir, "agency.db");
    store = new AgencyOperationsStore(path);
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      /* already closed by the test */
    }
    rmSync(dir, { recursive: true, force: true });
  });

  /** Read-only peek at the file while the store still owns the connection. */
  function inspect<T>(fn: (db: Database.Database) => T): T {
    const db = new Database(path, { readonly: true });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }

  it("applies migration 8 and stays at the runtime schema version", () => {
    expect(AGENCY_DATABASE_SCHEMA_VERSION).toBeGreaterThanOrEqual(8);
    const state = inspect((db) => ({
      version: db.prepare("SELECT MAX(version) FROM schema_migrations").pluck().get() as number,
      tables: (
        db.prepare("SELECT name FROM sqlite_master WHERE type='table'").pluck().all() as string[]
      ).sort(),
      indexes: db
        .prepare("SELECT name FROM sqlite_master WHERE type='index'")
        .pluck()
        .all() as string[],
    }));
    expect(state.version).toBe(AGENCY_DATABASE_SCHEMA_VERSION);
    expect(state.tables).toContain("external_entity_links");
    expect(state.tables).toContain("external_provider_bindings");
    expect(state.indexes).toEqual(
      expect.arrayContaining([
        "external_entity_links_entity",
        "external_entity_links_remote",
        "external_entity_links_state",
        "agency_projects_client",
        "invoices_client",
        "clients_agency_scope",
      ]),
    );
  });

  it("re-applies migration 8 cleanly over a populated version-7 database", () => {
    // Populate first, then roll the schema back to 7 so the re-run happens
    // against real rows the way it will on the production 8.6 MB file.
    const client = store.createClient({ name: "Acme" }, { agencyId: DEFAULT_AGENCY_ID });
    const project = store.createProject(
      DEFAULT_AGENCY_ID,
      { name: "Rebuild", clientId: client.id },
      "tester",
    );
    store.close();

    const raw = new Database(path);
    raw.exec(`
      DROP TABLE external_entity_links;
      DROP TABLE external_provider_bindings;
      DROP INDEX agency_projects_client;
      DROP INDEX invoices_client;
      DROP INDEX engagements_client;
      DROP INDEX contacts_client;
      DROP INDEX opportunities_client;
      DROP INDEX agency_tasks_project;
      DROP INDEX clients_agency_scope;
      -- Roll back to 7, which means every later migration replays. They must
      -- all be safe over populated rows, not just the newest one.
      DELETE FROM schema_migrations WHERE version>=8;
    `);
    raw.close();

    store = new AgencyOperationsStore(path);
    expect(
      inspect((db) => db.prepare("SELECT MAX(version) FROM schema_migrations").pluck().get()),
    ).toBe(AGENCY_DATABASE_SCHEMA_VERSION);
    // Data survived the upgrade and the relation walk works on it.
    expect(
      store.getClientRelations(DEFAULT_AGENCY_ID, client.id).projects.map((p) => p.id),
    ).toEqual([project.id]);

    // Running the constructor again must not duplicate anything.
    store.close();
    store = new AgencyOperationsStore(path);
    expect(
      inspect((db) =>
        db.prepare("SELECT COUNT(*) FROM schema_migrations WHERE version=8").pluck().get(),
      ),
    ).toBe(1);
  });

  it("round-trips a link and finds it from either side", () => {
    const client = store.createClient({ name: "Globex" }, { agencyId: DEFAULT_AGENCY_ID });
    const { link, changed } = store.recordExternalLink({
      agencyId: DEFAULT_AGENCY_ID,
      provider: "notion",
      entityType: "client",
      entityId: client.id,
      externalId: "page-1",
      externalDatabaseId: "db-1",
      externalUrl: "https://notion.so/page-1",
      localHash: hashAgencyEntity("client", client as unknown as Record<string, unknown>),
      remoteHash: "remote-hash-1",
    });
    expect(changed).toBe(true);
    expect(link.id).toBe(externalLinkId(DEFAULT_AGENCY_ID, "notion", "client", client.id));
    expect(link.syncState).toBe("in_sync");

    expect(store.getExternalLink(DEFAULT_AGENCY_ID, "notion", "client", client.id)).toEqual(link);
    expect(store.findExternalLinkByExternalId(DEFAULT_AGENCY_ID, "notion", "page-1")).toEqual(link);
    expect(
      store.listExternalLinks(DEFAULT_AGENCY_ID, { provider: "notion", entityType: "client" }),
    ).toEqual([link]);
  });

  it("writes nothing when an unchanged record is re-recorded", () => {
    const client = store.createClient({ name: "Initech" }, { agencyId: DEFAULT_AGENCY_ID });
    const args = {
      agencyId: DEFAULT_AGENCY_ID,
      provider: "notion",
      entityType: "client" as const,
      entityId: client.id,
      externalId: "page-2",
      externalDatabaseId: "db-1",
      localHash: hashAgencyEntity("client", client as unknown as Record<string, unknown>),
      remoteHash: "remote-hash-2",
      lastSyncedAt: 1_700_000_000_000,
    };
    store.recordExternalLink(args);
    const before = inspect((db) => ({
      link: db.prepare("SELECT * FROM external_entity_links").get(),
      audits: db.prepare("SELECT COUNT(*) FROM audit_events").pluck().get() as number,
    }));

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = store.recordExternalLink({ ...args, lastSyncedAt: Date.now() });
      expect(result.changed).toBe(false);
    }

    const after = inspect((db) => ({
      link: db.prepare("SELECT * FROM external_entity_links").get(),
      audits: db.prepare("SELECT COUNT(*) FROM audit_events").pluck().get() as number,
    }));
    // Byte-identical row (last_synced_at and updated_at included) and not a
    // single extra audit event — a no-op sync must cost nothing.
    expect(after.link).toEqual(before.link);
    expect(after.audits).toBe(before.audits);
  });

  it("binding upserts are idempotent and repointing drops stale links", () => {
    const client = store.createClient({ name: "Umbrella" }, { agencyId: DEFAULT_AGENCY_ID });
    const first = store.upsertExternalBinding({
      agencyId: DEFAULT_AGENCY_ID,
      provider: "notion",
      entityType: "client",
      externalDatabaseId: "db-1",
      externalDatabaseName: "Clients",
    });
    expect(first.changed).toBe(true);
    expect(
      store.upsertExternalBinding({
        agencyId: DEFAULT_AGENCY_ID,
        provider: "notion",
        entityType: "client",
        externalDatabaseId: "db-1",
        externalDatabaseName: "Clients",
      }).changed,
    ).toBe(false);

    store.recordExternalLink({
      agencyId: DEFAULT_AGENCY_ID,
      provider: "notion",
      entityType: "client",
      entityId: client.id,
      externalId: "page-3",
      externalDatabaseId: "db-1",
      localHash: "a",
      remoteHash: "b",
    });
    store.upsertExternalBinding({
      agencyId: DEFAULT_AGENCY_ID,
      provider: "notion",
      entityType: "client",
      externalDatabaseId: "db-2",
    });
    expect(store.listExternalLinks(DEFAULT_AGENCY_ID, { provider: "notion" })).toEqual([]);

    const removed = store.removeExternalBinding(DEFAULT_AGENCY_ID, "notion", "client");
    expect(removed.removed).toBe(true);
    expect(store.getExternalBinding(DEFAULT_AGENCY_ID, "notion", "client")).toBeNull();
  });

  it("distinguishes local drift, remote drift and conflict", () => {
    const client = store.createClient({ name: "Stark" }, { agencyId: DEFAULT_AGENCY_ID });
    const localHash = hashAgencyEntity("client", client as unknown as Record<string, unknown>);
    store.recordExternalLink({
      agencyId: DEFAULT_AGENCY_ID,
      provider: "notion",
      entityType: "client",
      entityId: client.id,
      externalId: "page-4",
      localHash,
      remoteHash: "remote-v1",
    });

    // Nothing moved.
    expect(
      store.evaluateExternalDrift(DEFAULT_AGENCY_ID, "notion", "client", client.id, {
        remoteHash: "remote-v1",
      }).state,
    ).toBe("in_sync");

    // Remote moved only — the flag the audit asked for.
    const remoteAhead = store.evaluateExternalDrift(
      DEFAULT_AGENCY_ID,
      "notion",
      "client",
      client.id,
      { remoteHash: "remote-v2" },
    );
    expect(remoteAhead.remoteChanged).toBe(true);
    expect(remoteAhead.localChanged).toBe(false);
    expect(remoteAhead.state).toBe("remote_ahead");

    // Local moved only. The hash is recomputed from the live row, so an edit
    // through any other RPC surfaces here without a sync run first.
    store.updateClient(client.id, { notes: "renegotiating" }, { agencyId: DEFAULT_AGENCY_ID });
    const localAhead = store.evaluateExternalDrift(
      DEFAULT_AGENCY_ID,
      "notion",
      "client",
      client.id,
      { remoteHash: "remote-v1" },
    );
    expect(localAhead.localChanged).toBe(true);
    expect(localAhead.state).toBe("local_ahead");

    // Both moved.
    expect(
      store.evaluateExternalDrift(DEFAULT_AGENCY_ID, "notion", "client", client.id, {
        remoteHash: "remote-v2",
      }).state,
    ).toBe("conflict");
  });

  it("classifyDrift treats an unlinked entity as needing a push", () => {
    expect(classifyDrift(null, { localHash: "x" })).toEqual({
      localChanged: true,
      remoteChanged: true,
      state: "local_ahead",
    });
  });

  it("hashes are stable across key order and ignore updatedAt churn", () => {
    const base = { name: "Wayne", status: "active", billingEmail: null, notes: null };
    expect(hashAgencyEntity("client", base)).toBe(
      hashAgencyEntity("client", {
        notes: null,
        billingEmail: null,
        status: "active",
        name: "Wayne",
      }),
    );
    expect(hashAgencyEntity("client", { ...base, updatedAt: 1 })).toBe(
      hashAgencyEntity("client", { ...base, updatedAt: 2 }),
    );
  });

  it("reports the relation graph and its integrity", () => {
    const client = store.createClient({ name: "Cyberdyne" }, { agencyId: DEFAULT_AGENCY_ID });
    const project = store.createProject(
      DEFAULT_AGENCY_ID,
      { name: "T-800", clientId: client.id, budgetCents: 500_000 },
      "tester",
    );
    const task = store.createTask(
      DEFAULT_AGENCY_ID,
      { projectId: project.id, title: "Chassis", acceptanceCriteria: "walks" },
      "tester",
    );
    const invoice = store.createInvoice(
      { clientId: client.id, number: "INV-1", subtotalCents: 100_000 },
      { agencyId: DEFAULT_AGENCY_ID },
    );

    const relations = store.getClientRelations(DEFAULT_AGENCY_ID, client.id);
    expect(relations.projects.map((entry) => entry.id)).toEqual([project.id]);
    expect(relations.tasks.map((entry) => entry.id)).toEqual([task.id]);
    expect(relations.invoices.map((entry) => entry.id)).toEqual([invoice.id]);
    expect(relations.totals).toMatchObject({
      projects: 1,
      openProjects: 1,
      tasks: 1,
      openTasks: 1,
      invoices: 1,
      invoicedCents: 100_000,
      outstandingCents: 100_000,
    });

    const reverse = store.getProjectRelations(DEFAULT_AGENCY_ID, project.id);
    expect(reverse.client?.id).toBe(client.id);
    expect(reverse.tasks.map((entry) => entry.id)).toEqual([task.id]);

    expect(store.checkRelationIntegrity(DEFAULT_AGENCY_ID)).toMatchObject({
      ok: true,
      orphanProjects: [],
      crossAgencyProjects: [],
      orphanTasks: [],
      orphanInvoices: [],
      danglingExternalLinks: [],
      foreignKeyViolations: 0,
    });
  });

  it("enforces referential integrity when relinking a project to a client", () => {
    const client = store.createClient({ name: "Tyrell" }, { agencyId: DEFAULT_AGENCY_ID });
    const project = store.createProject(DEFAULT_AGENCY_ID, { name: "Nexus" }, "tester");
    expect(project.clientId).toBeNull();
    expect(
      store.setProjectClient(DEFAULT_AGENCY_ID, project.id, client.id, "tester").clientId,
    ).toBe(client.id);
    // Relinking to the same client is a no-op, not another audit row.
    const audits = inspect(
      (db) =>
        db
          .prepare("SELECT COUNT(*) FROM audit_events WHERE action='client_linked'")
          .pluck()
          .get() as number,
    );
    store.setProjectClient(DEFAULT_AGENCY_ID, project.id, client.id, "tester");
    expect(
      inspect(
        (db) =>
          db
            .prepare("SELECT COUNT(*) FROM audit_events WHERE action='client_linked'")
            .pluck()
            .get() as number,
      ),
    ).toBe(audits);
    expect(() => store.setProjectClient(DEFAULT_AGENCY_ID, project.id, "nope", "tester")).toThrow(
      /client not found/,
    );
  });

  it("flags a link whose local entity was deleted underneath it", () => {
    const project = store.createProject(DEFAULT_AGENCY_ID, { name: "Ghost" }, "tester");
    store.recordExternalLink({
      agencyId: DEFAULT_AGENCY_ID,
      provider: "notion",
      entityType: "project",
      entityId: project.id,
      externalId: "page-5",
      localHash: "a",
      remoteHash: "b",
    });
    store.deleteProject(DEFAULT_AGENCY_ID, project.id, "tester");
    const report = store.checkRelationIntegrity(DEFAULT_AGENCY_ID);
    expect(report.ok).toBe(false);
    expect(report.danglingExternalLinks).toHaveLength(1);
  });

  it("replicates links so a peer node does not duplicate remote records", () => {
    const other = mkdtempSync(join(tmpdir(), "agency-external-peer-"));
    const peer = new AgencyOperationsStore(join(other, "agency.db"));
    try {
      const client = store.createClient({ name: "Soylent" }, { agencyId: DEFAULT_AGENCY_ID });
      store.recordExternalLink({
        agencyId: DEFAULT_AGENCY_ID,
        provider: "notion",
        entityType: "client",
        entityId: client.id,
        externalId: "page-6",
        externalDatabaseId: "db-1",
        localHash: "a",
        remoteHash: "b",
      });
      store.upsertExternalBinding({
        agencyId: DEFAULT_AGENCY_ID,
        provider: "notion",
        entityType: "client",
        externalDatabaseId: "db-1",
      });

      peer.mergeReplicationSnapshot(
        store.exportReplicationSnapshot(DEFAULT_AGENCY_ID, "node-a"),
        "node-b",
      );
      expect(
        peer.findExternalLinkByExternalId(DEFAULT_AGENCY_ID, "notion", "page-6")?.entityId,
      ).toBe(client.id);
      expect(
        peer.getExternalBinding(DEFAULT_AGENCY_ID, "notion", "client")?.externalDatabaseId,
      ).toBe("db-1");

      // Converged: a second merge changes nothing, so the digests match.
      const merged = peer.mergeReplicationSnapshot(
        store.exportReplicationSnapshot(DEFAULT_AGENCY_ID, "node-a"),
        "node-b",
      );
      expect(merged.updated).toBe(0);
      expect(merged.conflicts).toBe(0);
    } finally {
      peer.close();
      rmSync(other, { recursive: true, force: true });
    }
  });
});
