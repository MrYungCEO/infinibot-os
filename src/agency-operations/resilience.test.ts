import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AGENCY_DATABASE_SCHEMA_VERSION, createAgencyDatabaseResilience } from "./resilience.js";
import { AgencyOperationsStore } from "./store.js";

describe("agency database resilience", () => {
  let directory: string;
  let databasePath: string;
  let backupDirectory: string;
  let clock: number;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "agency-resilience-"));
    databasePath = join(directory, "agency.db");
    backupDirectory = join(directory, "backups");
    clock = 1_750_000_000_000;
    const store = new AgencyOperationsStore(databasePath);
    store.close();
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function service(closeDatabaseUsers = vi.fn()) {
    return createAgencyDatabaseResilience({
      databasePath,
      backupDirectory,
      now: () => clock,
      closeDatabaseUsers,
    });
  }

  it("creates a consistent verified backup and exposes no filesystem path", async () => {
    const resilience = service();
    const backup = await resilience.createBackup();

    expect(backup).toMatchObject({
      verified: true,
      schemaVersion: AGENCY_DATABASE_SCHEMA_VERSION,
      createdAt: clock,
    });
    expect(backup.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(backup).not.toHaveProperty("path");
    await expect(resilience.listBackups()).resolves.toEqual([backup]);
    await expect(resilience.getHealth()).resolves.toMatchObject({
      ok: true,
      integrity: "ok",
      backupCount: 1,
      latestVerified: true,
      schema: {
        currentVersion: AGENCY_DATABASE_SCHEMA_VERSION,
        supportedVersion: AGENCY_DATABASE_SCHEMA_VERSION,
        upToDate: true,
      },
    });
  });

  it("ensures a fresh backup without duplicating it until the interval elapses", async () => {
    const resilience = service();
    const first = await resilience.ensureBackup(24);
    const second = await resilience.ensureBackup(24);
    clock += 25 * 3_600_000;
    const third = await resilience.ensureBackup(24);

    expect(first.created).toBe(true);
    expect(second).toMatchObject({ created: false, backup: { id: first.backup.id } });
    expect(third.created).toBe(true);
    expect(third.backup.id).not.toBe(first.backup.id);
  });

  it("applies count and age retention only when explicitly requested", async () => {
    const resilience = service();
    const old = await resilience.createBackup();
    clock += 10 * 86_400_000;
    const middle = await resilience.createBackup();
    clock += 10 * 86_400_000;
    const newest = await resilience.createBackup();

    const result = await resilience.pruneBackups({ maxCount: 2, maxAgeDays: 15 });
    expect(result.removedIds).toContain(old.id);
    expect(result.removedIds).not.toContain(middle.id);
    expect(result.removedIds).not.toContain(newest.id);
    await expect(resilience.listBackups()).resolves.toHaveLength(2);
  });

  it("never prunes the final recovery point even when it exceeds age retention", async () => {
    const resilience = service();
    const only = await resilience.createBackup();
    clock += 365 * 86_400_000;

    await expect(resilience.pruneBackups({ maxCount: 1, maxAgeDays: 1 })).resolves.toMatchObject({
      removedIds: [],
      retained: 1,
    });
    await expect(resilience.listBackups()).resolves.toMatchObject([{ id: only.id }]);
  });

  it("reports formal schema migration status including newer runtimes", async () => {
    const db = new Database(databasePath);
    db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(99, clock);
    db.close();

    await expect(service().getSchemaStatus()).resolves.toMatchObject({
      currentVersion: 99,
      supportedVersion: AGENCY_DATABASE_SCHEMA_VERSION,
      upToDate: false,
      newerThanRuntime: true,
    });
  });

  it("stages restore without changing live data and requires exact confirmation", async () => {
    const closeDatabaseUsers = vi.fn();
    const resilience = service(closeDatabaseUsers);
    const backup = await resilience.createBackup();

    const changed = new AgencyOperationsStore(databasePath);
    changed.createAgency({
      id: "post-backup-agency",
      name: "Post backup",
      slug: "post-backup",
      ownerUserId: "owner",
    });
    changed.close();

    const plan = await resilience.prepareRestore(backup.id);
    const liveBefore = new Database(databasePath, { readonly: true });
    expect(
      liveBefore
        .prepare("SELECT COUNT(*) FROM agencies WHERE id='post-backup-agency'")
        .pluck()
        .get(),
    ).toBe(1);
    liveBefore.close();

    await expect(
      resilience.activateRestore(plan.restoreId, "RESTORE something-else"),
    ).rejects.toThrow("confirmation");
    expect(closeDatabaseUsers).not.toHaveBeenCalled();

    const result = await resilience.activateRestore(plan.restoreId, plan.confirmation);
    expect(result.restoredBackupId).toBe(backup.id);
    expect(result.safetyBackup.verified).toBe(true);
    expect(closeDatabaseUsers).toHaveBeenCalledOnce();

    const restored = new Database(databasePath, { readonly: true });
    expect(
      restored.prepare("SELECT COUNT(*) FROM agencies WHERE id='post-backup-agency'").pluck().get(),
    ).toBe(0);
    restored.close();
  });

  it("rejects tampered backups during verification and restore preparation", async () => {
    const resilience = service();
    const backup = await resilience.createBackup();
    const path = join(backupDirectory, `${backup.id}.sqlite`);
    const original = await readFile(path);
    await writeFile(path, Buffer.from("not-a-sqlite-database"));

    await expect(resilience.verifyBackup(backup.id)).resolves.toMatchObject({
      id: backup.id,
      verified: false,
      schemaVersion: 0,
    });
    await expect(resilience.prepareRestore(backup.id)).rejects.toThrow();

    await writeFile(path, original);
  });

  it("rejects path traversal backup identifiers", async () => {
    await expect(service().verifyBackup("../agency-0000000000000-bad")).rejects.toThrow(
      "invalid backup id",
    );
  });
});
