import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import {
  KNOWN_CLIENT_PIPELINE_STATUSES,
  clientPipelineStatusFromNotes,
  deriveLegacyClientStatus,
  isKnownClientPipelineStatus,
  normalizeClientPipelineStatus,
} from "./client-status.js";
import { AGENCY_DATABASE_SCHEMA_VERSION } from "./resilience.js";
import { AgencyOperationsStore } from "./store.js";
import { DEFAULT_AGENCY_ID } from "./types.js";

describe("client pipeline status normalisation", () => {
  it("case-folds and collapses whitespace onto one canonical key", () => {
    for (const messy of ["In progress", "IN PROGRESS", "  in   Progress  ", "in progress"]) {
      expect(normalizeClientPipelineStatus(messy)).toEqual({
        status: "in progress",
        label: "In progress",
      });
    }
  });

  it("treats blank, null and non-strings as Cold", () => {
    for (const blank of ["", "   ", null, undefined, 42, {}]) {
      expect(normalizeClientPipelineStatus(blank)).toEqual({ status: "cold", label: "Cold" });
    }
  });

  it("preserves an unrecognised status verbatim instead of dropping it", () => {
    expect(normalizeClientPipelineStatus("  Awaiting   Retainer ")).toEqual({
      status: "awaiting retainer",
      label: "Awaiting Retainer",
    });
    expect(isKnownClientPipelineStatus("Awaiting Retainer")).toBe(false);
    expect(isKnownClientPipelineStatus("in PROGRESS")).toBe(true);
    expect(KNOWN_CLIENT_PIPELINE_STATUSES).toContain("Cold");
  });
});

describe("legacy rollup derivation", () => {
  it("maps every known status to the owner's agreed bucket", () => {
    const expected: Record<string, string> = {
      "In progress": "active",
      Updating: "active",
      Won: "active",
      Active: "active",
      Completed: "inactive",
      Archived: "inactive",
      Lost: "inactive",
      Cancelled: "inactive",
      Inactive: "inactive",
      Cold: "prospect",
      Lead: "prospect",
      "": "prospect",
    };
    for (const [status, rollup] of Object.entries(expected)) {
      expect([status, deriveLegacyClientStatus(status)]).toEqual([status, rollup]);
    }
  });

  it("does not regress completed -> active", () => {
    // "Completed" once shared an alternation with "active" and inflated every
    // active-client figure in the agency.
    expect(deriveLegacyClientStatus("Completed")).toBe("inactive");
    expect(deriveLegacyClientStatus("completed")).toBe("inactive");
    // "inactive" contains the substring "active": ordering still matters.
    expect(deriveLegacyClientStatus("Inactive")).toBe("inactive");
  });

  it("buckets unknown statuses without losing them", () => {
    expect(deriveLegacyClientStatus("Enquiry")).toBe("prospect");
    expect(deriveLegacyClientStatus("Churned")).toBe("inactive");
    expect(deriveLegacyClientStatus("On retainer")).toBe("active");
  });
});

describe("recovering the status from the legacy notes blob", () => {
  it("reads Status/status/Stage/stage and falls back to Cold", () => {
    expect(clientPipelineStatusFromNotes(JSON.stringify({ Status: "Lead" })).label).toBe("Lead");
    expect(clientPipelineStatusFromNotes(JSON.stringify({ status: "won" })).label).toBe("Won");
    expect(clientPipelineStatusFromNotes(JSON.stringify({ Stage: "Updating" })).label).toBe(
      "Updating",
    );
    expect(clientPipelineStatusFromNotes(JSON.stringify({ stage: "Cold" })).label).toBe("Cold");
    expect(clientPipelineStatusFromNotes(JSON.stringify({ Name: "Acme" })).label).toBe("Cold");
    expect(clientPipelineStatusFromNotes("not json").label).toBe("Cold");
    expect(clientPipelineStatusFromNotes(null).label).toBe("Cold");
    expect(clientPipelineStatusFromNotes("[1,2]").label).toBe("Cold");
  });
});

describe("migration 9: first-class pipeline status", () => {
  let dir: string;
  let path: string;
  let store: AgencyOperationsStore;

  const inspect = <T>(read: (db: Database.Database) => T): T => {
    const db = new Database(path, { readonly: true });
    try {
      return read(db);
    } finally {
      db.close();
    }
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agency-client-status-"));
    path = join(dir, "agency.db");
    store = new AgencyOperationsStore(path);
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      // already closed by the test
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("adds the column and the grouping index and lands on the runtime version", () => {
    const state = inspect((db) => ({
      version: db.prepare("SELECT MAX(version) FROM schema_migrations").pluck().get() as number,
      columns: (db.prepare("PRAGMA table_info(clients)").all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
      indexes: db
        .prepare("SELECT name FROM sqlite_master WHERE type='index'")
        .pluck()
        .all() as string[],
    }));
    expect(state.version).toBe(AGENCY_DATABASE_SCHEMA_VERSION);
    // Migration 9 (first-class pipeline status) must remain applied; the
    // runtime version only ever advances past it as later migrations land.
    expect(AGENCY_DATABASE_SCHEMA_VERSION).toBeGreaterThanOrEqual(9);
    expect(state.columns).toContain("pipeline_status");
    expect(state.columns).toContain("pipeline_status_label");
    expect(state.indexes).toContain("clients_agency_pipeline_status");
  });

  it("backfills from the notes blob with blank counting as Cold, and is idempotent", () => {
    // Build a version-8 shaped table with rows whose real status survives only
    // inside `notes`, exactly like the owner's 8.6 MB production database.
    store.close();
    const raw = new Database(path);
    const seed = (id: string, status: string | null, rollup: string) => {
      raw
        .prepare(
          `INSERT INTO clients (id,agency_id,name,legal_name,status,owner_id,billing_email,notes,created_at,updated_at)
           VALUES (?,?,?,NULL,?,NULL,NULL,?,1,1)`,
        )
        .run(
          id,
          DEFAULT_AGENCY_ID,
          id,
          rollup,
          status === null ? JSON.stringify({ Name: id }) : JSON.stringify({ Status: status }),
        );
    };
    // Everything from 9 up has to come off: migrations are gated on
    // MAX(version), so leaving a later row behind would skip 9 entirely.
    raw.exec("DELETE FROM schema_migrations WHERE version>=9");
    raw.exec("DROP INDEX IF EXISTS clients_agency_pipeline_status");
    // The columns cannot be dropped without a rebuild; clearing them proves
    // the backfill, not the ALTER, is what populates the values.
    raw.exec("UPDATE clients SET pipeline_status='', pipeline_status_label=''");
    seed("blank-1", null, "prospect");
    seed("cold-1", "Cold", "prospect");
    seed("lead-1", "  lead ", "prospect");
    seed("live-1", "In Progress", "prospect");
    seed("done-1", "Completed", "active");
    seed("odd-1", "Enquiry", "active");
    raw.exec("UPDATE clients SET pipeline_status='', pipeline_status_label=''");
    raw.close();

    store = new AgencyOperationsStore(path);
    const byId = new Map(store.listClients(DEFAULT_AGENCY_ID).map((client) => [client.id, client]));
    expect(byId.get("blank-1")).toMatchObject({
      pipelineStatus: "cold",
      pipelineStatusLabel: "Cold",
      status: "prospect",
    });
    expect(byId.get("lead-1")).toMatchObject({
      pipelineStatus: "lead",
      pipelineStatusLabel: "Lead",
      status: "prospect",
    });
    expect(byId.get("live-1")).toMatchObject({
      pipelineStatus: "in progress",
      pipelineStatusLabel: "In progress",
      status: "active",
    });
    // The stale rollup written by the old build is corrected in the same pass.
    expect(byId.get("done-1")).toMatchObject({
      pipelineStatus: "completed",
      pipelineStatusLabel: "Completed",
      status: "inactive",
    });
    expect(byId.get("odd-1")).toMatchObject({
      pipelineStatus: "enquiry",
      pipelineStatusLabel: "Enquiry",
      status: "prospect",
    });

    // Re-running the constructor over the populated database changes nothing
    // and does not record migration 9 twice.
    const snapshot = inspect((db) => db.prepare("SELECT * FROM clients ORDER BY id").all());
    store.close();
    store = new AgencyOperationsStore(path);
    expect(inspect((db) => db.prepare("SELECT * FROM clients ORDER BY id").all())).toEqual(
      snapshot,
    );
    expect(
      inspect((db) =>
        db.prepare("SELECT COUNT(*) FROM schema_migrations WHERE version=9").pluck().get(),
      ),
    ).toBe(1);
  });

  it("filters and groups clients by their real status", () => {
    store.createClient({ name: "Alpha", pipelineStatus: "Cold" }, { agencyId: DEFAULT_AGENCY_ID });
    store.createClient({ name: "Beta" }, { agencyId: DEFAULT_AGENCY_ID });
    store.createClient(
      { name: "Gamma", pipelineStatus: "in PROGRESS" },
      { agencyId: DEFAULT_AGENCY_ID },
    );
    store.createClient({ name: "Delta", pipelineStatus: "Lead" }, { agencyId: DEFAULT_AGENCY_ID });

    // A client created with no status is Cold, not a fourth unnamed bucket.
    expect(
      store.listClients(DEFAULT_AGENCY_ID, { pipelineStatus: "cold" }).map((c) => c.name),
    ).toEqual(["Alpha", "Beta"]);
    // Filtering is case-insensitive and accepts a list.
    expect(
      store
        .listClients(DEFAULT_AGENCY_ID, { pipelineStatus: ["IN PROGRESS", "Lead"] })
        .map((c) => c.name),
    ).toEqual(["Delta", "Gamma"]);
    // The legacy rollup filter still works for existing consumers.
    expect(store.listClients(DEFAULT_AGENCY_ID, { status: "active" }).map((c) => c.name)).toEqual([
      "Gamma",
    ]);

    expect(store.listClientPipelineStatusCounts(DEFAULT_AGENCY_ID)).toEqual([
      { status: "cold", label: "Cold", rollup: "prospect", count: 2 },
      { status: "in progress", label: "In progress", rollup: "active", count: 1 },
      { status: "lead", label: "Lead", rollup: "prospect", count: 1 },
    ]);
  });

  it("keeps the rollup derived when the pipeline status is updated", () => {
    const client = store.createClient({ name: "Acme" }, { agencyId: DEFAULT_AGENCY_ID });
    expect(client.status).toBe("prospect");
    const updated = store.updateClient(
      client.id,
      { pipelineStatus: "Completed" },
      { agencyId: DEFAULT_AGENCY_ID },
    );
    expect(updated).toMatchObject({
      pipelineStatus: "completed",
      pipelineStatusLabel: "Completed",
      status: "inactive",
    });
    // An unknown status is stored, never rejected.
    const exotic = store.updateClient(
      client.id,
      { pipelineStatus: "Pending Deposit" },
      { agencyId: DEFAULT_AGENCY_ID },
    );
    expect(exotic).toMatchObject({
      pipelineStatus: "pending deposit",
      pipelineStatusLabel: "Pending Deposit",
      status: "prospect",
    });
  });
});

describe("legacy import applies status changes without write amplification", () => {
  let dir: string;
  let path: string;
  let store: AgencyOperationsStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agency-client-status-import-"));
    path = join(dir, "agency.db");
    store = new AgencyOperationsStore(path);
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      // already closed
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const auditCount = () =>
    store
      .listAgencyAuditEvents(DEFAULT_AGENCY_ID, { limit: 500 })
      .filter((event) => event.entityId.includes("legacy-client-1")).length;

  it("writes nothing when a genuinely unchanged record is re-imported", () => {
    const input = {
      agencyId: DEFAULT_AGENCY_ID,
      sourceId: "legacy-client-1",
      sourceHash: "stable-source-hash",
      name: "Stable client",
      pipelineStatus: "In progress",
      updatedAt: 1_750_000_000_000,
    };
    const first = store.importLegacyClient(input, "migration");
    const digest = store.exportReplicationSnapshot(DEFAULT_AGENCY_ID, "node-a").digest;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(store.importLegacyClient(input, "migration")).toEqual(first);
    }
    // Byte-identical replication payload and not one extra audit row: the
    // write-amplification bug that once grew this database to 633 MB.
    expect(store.exportReplicationSnapshot(DEFAULT_AGENCY_ID, "node-a").digest).toBe(digest);
    expect(auditCount()).toBe(1);
  });

  it("applies a corrected status on re-import even when the source hash is unchanged", () => {
    const base = {
      agencyId: DEFAULT_AGENCY_ID,
      sourceId: "legacy-client-1",
      sourceHash: "stable-source-hash",
      name: "Stable client",
      updatedAt: 1_750_000_000_000,
    };
    // Simulate the pre-fix state: same source record, wrong interpretation.
    store.importLegacyClient({ ...base, pipelineStatus: "Cold" }, "migration");
    expect(store.getClient(`legacy-client:${DEFAULT_AGENCY_ID}:legacy-client-1`)).toMatchObject({
      pipelineStatus: "cold",
      status: "prospect",
    });

    const repaired = store.importLegacyClient(
      { ...base, pipelineStatus: "Completed" },
      "migration",
    );
    expect(repaired).toMatchObject({
      pipelineStatus: "completed",
      pipelineStatusLabel: "Completed",
      status: "inactive",
    });
    expect(auditCount()).toBe(2);

    // ...and the repair itself is a one-off: the next pass writes nothing.
    const digest = store.exportReplicationSnapshot(DEFAULT_AGENCY_ID, "node-a").digest;
    store.importLegacyClient({ ...base, pipelineStatus: "Completed" }, "migration");
    expect(store.exportReplicationSnapshot(DEFAULT_AGENCY_ID, "node-a").digest).toBe(digest);
    expect(auditCount()).toBe(2);
  });
});
