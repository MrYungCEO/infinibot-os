import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { getKanbanStore } from "../tasks/store.js";
import { resetWorkforceStore } from "../workforce/index.js";
import {
  LEGACY_UNASSIGNED_AGENCY_ID,
  migrateLegacyBusinessesToAgencies,
} from "./legacy-migration.js";
import { AgencyOperationsStore } from "./store.js";

describe("legacy business migration", () => {
  let dir: string | null = null;

  afterEach(() => {
    if (!dir) return;
    try {
      getKanbanStore(dir).close();
    } catch {
      // best effort
    }
    try {
      // Clear the singleton rather than only closing it: the next test would
      // otherwise be handed this closed instance, still pinned to the removed
      // temp directory.
      resetWorkforceStore();
    } catch {
      // best effort
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // The databases-store singleton can retain its Windows file handle
      // until the test process exits. The directory is in the OS temp tree.
    }
    dir = null;
  });

  it("preserves business ids, imports relationships, quarantines unscoped work, and is idempotent", async () => {
    dir = mkdtempSync(join(tmpdir(), "agency-legacy-migration-"));
    writeFileSync(
      join(dir, "business.json"),
      JSON.stringify({
        businesses: [
          {
            id: "biz-old",
            name: "Existing Studio",
            industry: "Web design",
            context: "Keep this context",
            clients: [
              {
                id: "client-old",
                data: {
                  Name: "Acme",
                  Email: "ops@acme.test",
                  Status: "In progress",
                  Custom: "preserved",
                },
                created_at: "2025-01-01T00:00:00.000Z",
                updated_at: "2025-02-01T00:00:00.000Z",
              },
            ],
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2025-02-01T00:00:00.000Z",
          },
        ],
        activeBusinessId: "biz-old",
      }),
      "utf8",
    );

    const kanban = getKanbanStore(dir);
    const scoped = await kanban.createProject({ id: "project-scoped", name: "Client site" });
    kanban.setProjectMeta(scoped.id, { businessId: "biz-old" });
    const unassigned = await kanban.createProject({ id: "project-loose", name: "Loose work" });
    await kanban.createTask({
      projectId: scoped.id,
      title: "Design homepage",
      status: "in_progress",
      description: "Legacy task body",
    });

    const dbPath = join(dir, "agency-operations", "agency.db");
    const store = new AgencyOperationsStore(dbPath);
    const first = await migrateLegacyBusinessesToAgencies({
      stateDir: dir,
      actorId: "owner-1",
      operationsStore: store,
    });

    expect(store.getAgency("biz-old")?.name).toBe("Existing Studio");
    expect(store.getAgencyProfile("biz-old")?.context).toBe("Keep this context");
    expect(store.listClients("biz-old")).toMatchObject([
      { name: "Acme", status: "active", billingEmail: "ops@acme.test" },
    ]);
    expect(store.listProjects("biz-old")).toHaveLength(1);
    expect(store.listTasks("biz-old")).toHaveLength(1);
    expect(store.getAgency(LEGACY_UNASSIGNED_AGENCY_ID)).not.toBeNull();
    expect(kanban.getProjectMeta(unassigned.id)?.businessId).toBe(LEGACY_UNASSIGNED_AGENCY_ID);
    // Fresh Kanban stores may contain a seeded unassigned project in addition
    // to the explicit fixture; every such project must be quarantined.
    expect(first.projectsQuarantined).toBeGreaterThanOrEqual(1);

    await migrateLegacyBusinessesToAgencies({
      stateDir: dir,
      actorId: "owner-1",
      operationsStore: store,
    });
    expect(store.listClients("biz-old")).toHaveLength(1);
    expect(store.listProjects("biz-old")).toHaveLength(1);
    expect(store.listTasks("biz-old")).toHaveLength(1);

    const intruder = await migrateLegacyBusinessesToAgencies({
      stateDir: dir,
      actorId: "shared-user",
      operationsStore: store,
    });
    expect(
      store.listAgencyMembers("biz-old").some((member) => member.userId === "shared-user"),
    ).toBe(false);
    expect(intruder.warnings.some((warning) => warning.includes("another identity"))).toBe(true);
    store.close();
  });

  it("does not count finished clients as active", async () => {
    // Regression: "Completed" was in the same alternation as "active", so a
    // finished engagement kept inflating the active-client count everywhere
    // (dashboard KPI, topology scope). An owner with 2 live jobs saw 9.
    dir = mkdtempSync(join(tmpdir(), "agency-legacy-client-status-"));
    const client = (id: string, status: string) => ({ id, data: { Name: id, Status: status } });
    writeFileSync(
      join(dir, "business.json"),
      JSON.stringify({
        businesses: [
          {
            id: "biz-status",
            name: "Status Studio",
            clients: [
              client("live-1", "In progress"),
              client("live-2", "Updating"),
              client("done-1", "Completed"),
              client("done-2", "completed"),
              client("gone-1", "Archived"),
              client("new-1", "Enquiry"),
              client("cold-1", "Cold"),
              // No Status key at all: the owner's decision is that blank
              // counts as Cold rather than a fourth, unnamed bucket.
              { id: "blank-1", data: { Name: "blank-1" } },
            ],
          },
        ],
      }),
      "utf8",
    );

    const store = new AgencyOperationsStore(join(dir, "agency-operations", "agency.db"));
    await migrateLegacyBusinessesToAgencies({
      stateDir: dir,
      actorId: "owner-1",
      operationsStore: store,
    });

    const byStatus = (status: string) =>
      store
        .listClients("biz-status")
        .filter((c) => c.status === status)
        .map((c) => c.name)
        .sort();

    expect(byStatus("active")).toEqual(["live-1", "live-2"]);
    expect(byStatus("inactive")).toEqual(["done-1", "done-2", "gone-1"]);
    expect(byStatus("prospect")).toEqual(["blank-1", "cold-1", "new-1"]);

    // The rollup is only a rollup: the real status is stored, indexed and
    // groupable, so /clients and Agency Operations can finally agree.
    expect(
      Object.fromEntries(
        store.listClients("biz-status").map((c) => [c.name, c.pipelineStatusLabel]),
      ),
    ).toEqual({
      "live-1": "In progress",
      "live-2": "Updating",
      "done-1": "Completed",
      "done-2": "Completed",
      "gone-1": "Archived",
      // Unrecognised, and preserved verbatim rather than dropped.
      "new-1": "Enquiry",
      "cold-1": "Cold",
      "blank-1": "Cold",
    });
    expect(store.listClientPipelineStatusCounts("biz-status")).toEqual([
      { status: "cold", label: "Cold", rollup: "prospect", count: 2 },
      { status: "completed", label: "Completed", rollup: "inactive", count: 2 },
      { status: "archived", label: "Archived", rollup: "inactive", count: 1 },
      { status: "enquiry", label: "Enquiry", rollup: "prospect", count: 1 },
      { status: "in progress", label: "In progress", rollup: "active", count: 1 },
      { status: "updating", label: "Updating", rollup: "active", count: 1 },
    ]);
    store.close();
  });

  it("skips re-importing an unchanged business.json but still honours force", async () => {
    dir = mkdtempSync(join(tmpdir(), "agency-legacy-migration-skip-"));
    writeFileSync(
      join(dir, "business.json"),
      JSON.stringify({
        businesses: [
          {
            id: "biz-skip",
            name: "Repeat Studio",
            clients: [{ id: "client-a", data: { Name: "Acme" } }],
          },
        ],
      }),
      "utf8",
    );

    const dbPath = join(dir, "agency-operations", "agency.db");
    const store = new AgencyOperationsStore(dbPath);
    const options = { stateDir: dir, actorId: "owner-1", operationsStore: store };

    const first = await migrateLegacyBusinessesToAgencies(options);
    expect(first.clientsImported).toBe(1);
    const runsAfterFirst = store.listLegacyMigrationRuns().length;

    // agency.ops.agencies.list migrates on every call. An unchanged source has
    // to short-circuit, otherwise each page load re-walks every entity and
    // writes a fresh audit row per record.
    const second = await migrateLegacyBusinessesToAgencies(options);
    expect(second).toEqual(first);
    expect(store.listLegacyMigrationRuns()).toHaveLength(runsAfterFirst);

    const forced = await migrateLegacyBusinessesToAgencies({ ...options, force: true });
    expect(forced.clientsImported).toBe(1);
    expect(store.listLegacyMigrationRuns().length).toBeGreaterThan(runsAfterFirst);

    // A changed source must be picked up again without force.
    writeFileSync(
      join(dir, "business.json"),
      JSON.stringify({
        businesses: [
          {
            id: "biz-skip",
            name: "Repeat Studio",
            clients: [
              { id: "client-a", data: { Name: "Acme" } },
              { id: "client-b", data: { Name: "Globex" } },
            ],
          },
        ],
      }),
      "utf8",
    );
    const third = await migrateLegacyBusinessesToAgencies(options);
    expect(third.clientsImported).toBe(2);
    expect(store.listClients("biz-skip")).toHaveLength(2);
    store.close();
  });
});
