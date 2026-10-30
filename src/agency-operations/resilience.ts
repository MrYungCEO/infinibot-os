import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import Database from "better-sqlite3";

export const AGENCY_DATABASE_SCHEMA_VERSION = 16;

export type AgencyDatabaseSchemaStatus = {
  currentVersion: number;
  supportedVersion: number;
  migrationCount: number;
  upToDate: boolean;
  newerThanRuntime: boolean;
  lastMigratedAt: number | null;
};

export type AgencyDatabaseBackup = {
  id: string;
  createdAt: number;
  sizeBytes: number;
  sha256: string;
  schemaVersion: number;
  verified: boolean;
};

export type AgencyDatabaseHealth = {
  ok: boolean;
  integrity: "ok" | "failed" | "unavailable";
  schema: AgencyDatabaseSchemaStatus;
  backupCount: number;
  latestBackupAt: number | null;
  latestVerified: boolean;
  restorePending: boolean;
};

export type AgencyBackupRetentionPolicy = {
  maxCount: number;
  maxAgeDays: number;
};

type RestorePlan = {
  id: string;
  backupId: string;
  stagedPath: string;
  confirmation: string;
  expiresAt: number;
};

export type AgencyDatabaseResilienceOptions = {
  databasePath: string;
  backupDirectory?: string;
  now?: () => number;
  closeDatabaseUsers?: () => void;
};

const BACKUP_ID = /^agency-(\d{13})-([0-9a-f-]{36})$/i;
const DEFAULT_RETENTION: AgencyBackupRetentionPolicy = {
  maxCount: 14,
  maxAgeDays: 30,
};

function validatePolicy(
  policy: Partial<AgencyBackupRetentionPolicy> = {},
): AgencyBackupRetentionPolicy {
  const maxCount = Math.trunc(policy.maxCount ?? DEFAULT_RETENTION.maxCount);
  const maxAgeDays = Math.trunc(policy.maxAgeDays ?? DEFAULT_RETENTION.maxAgeDays);
  if (maxCount < 1 || maxCount > 365) {
    throw new Error("maxCount must be between 1 and 365");
  }
  if (maxAgeDays < 1 || maxAgeDays > 3650) {
    throw new Error("maxAgeDays must be between 1 and 3650");
  }
  return { maxCount, maxAgeDays };
}

function resolveBackupPath(directory: string, id: string): string {
  if (!BACKUP_ID.test(id) || basename(id) !== id) throw new Error("invalid backup id");
  return join(directory, `${id}.sqlite`);
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

function readSchemaStatus(db: Database.Database): AgencyDatabaseSchemaStatus {
  const exists = db
    .prepare(
      "SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
    )
    .pluck()
    .get() as number;
  if (!exists) {
    return {
      currentVersion: 0,
      supportedVersion: AGENCY_DATABASE_SCHEMA_VERSION,
      migrationCount: 0,
      upToDate: false,
      newerThanRuntime: false,
      lastMigratedAt: null,
    };
  }
  const row = db
    .prepare(
      "SELECT COALESCE(MAX(version),0) currentVersion, COUNT(*) migrationCount, MAX(applied_at) lastMigratedAt FROM schema_migrations",
    )
    .get() as {
    currentVersion: number;
    migrationCount: number;
    lastMigratedAt: number | null;
  };
  return {
    ...row,
    supportedVersion: AGENCY_DATABASE_SCHEMA_VERSION,
    upToDate: row.currentVersion === AGENCY_DATABASE_SCHEMA_VERSION,
    newerThanRuntime: row.currentVersion > AGENCY_DATABASE_SCHEMA_VERSION,
  };
}

function inspectDatabase(path: string): {
  verified: boolean;
  schema: AgencyDatabaseSchemaStatus;
} {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const integrity = db.pragma("integrity_check", { simple: true });
    return {
      verified: integrity === "ok",
      schema: readSchemaStatus(db),
    };
  } finally {
    db.close();
  }
}

export function createAgencyDatabaseResilience(options: AgencyDatabaseResilienceOptions) {
  const databasePath = options.databasePath;
  const backupDirectory = options.backupDirectory ?? join(dirname(databasePath), "backups");
  const stagingDirectory = join(backupDirectory, ".restore-staging");
  const now = options.now ?? Date.now;
  const restorePlans = new Map<string, RestorePlan>();

  async function describeBackup(id: string): Promise<AgencyDatabaseBackup> {
    const path = resolveBackupPath(backupDirectory, id);
    const details = await stat(path);
    let verified = false;
    let schemaVersion = 0;
    try {
      const inspection = inspectDatabase(path);
      verified = inspection.verified;
      schemaVersion = inspection.schema.currentVersion;
    } catch {
      // Corrupt snapshots stay visible in listings and report unverified.
    }
    const timestamp = Number(BACKUP_ID.exec(id)?.[1] ?? details.mtimeMs);
    return {
      id,
      createdAt: timestamp,
      sizeBytes: details.size,
      sha256: await sha256(path),
      schemaVersion,
      verified,
    };
  }

  async function listBackups(): Promise<AgencyDatabaseBackup[]> {
    await mkdir(backupDirectory, { recursive: true });
    const entries = await readdir(backupDirectory, { withFileTypes: true });
    const ids = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".sqlite"))
      .map((entry) => entry.name.slice(0, -".sqlite".length))
      .filter((id) => BACKUP_ID.test(id));
    const backups = await Promise.all(ids.map((id) => describeBackup(id).catch(() => null)));
    return backups
      .filter((backup): backup is AgencyDatabaseBackup => backup !== null)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async function createBackup(): Promise<AgencyDatabaseBackup> {
    await mkdir(backupDirectory, { recursive: true });
    const id = `agency-${now()}-${randomUUID()}`;
    const destination = resolveBackupPath(backupDirectory, id);
    const temporary = `${destination}.partial`;
    const source = new Database(databasePath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      await source.backup(temporary);
    } finally {
      source.close();
    }
    const inspection = inspectDatabase(temporary);
    if (!inspection.verified) {
      await rm(temporary, { force: true });
      throw new Error("backup integrity verification failed");
    }
    await rename(temporary, destination);
    return describeBackup(id);
  }

  async function ensureBackup(maxAgeHours = 24): Promise<{
    created: boolean;
    backup: AgencyDatabaseBackup;
  }> {
    if (!Number.isFinite(maxAgeHours) || maxAgeHours < 1 || maxAgeHours > 8760) {
      throw new Error("maxAgeHours must be between 1 and 8760");
    }
    const latest = (await listBackups())[0];
    if (latest?.verified && now() - latest.createdAt < maxAgeHours * 3_600_000) {
      return { created: false, backup: latest };
    }
    return { created: true, backup: await createBackup() };
  }

  async function verifyBackup(id: string): Promise<AgencyDatabaseBackup> {
    return describeBackup(id);
  }

  async function pruneBackups(
    policyInput: Partial<AgencyBackupRetentionPolicy> = {},
  ): Promise<{ removedIds: string[]; retained: number; policy: AgencyBackupRetentionPolicy }> {
    const policy = validatePolicy(policyInput);
    const backups = await listBackups();
    const cutoff = now() - policy.maxAgeDays * 86_400_000;
    const removedIds: string[] = [];
    for (const [index, backup] of backups.entries()) {
      // Retention must never leave the operator with zero recovery points.
      if (index === 0) continue;
      if (index < policy.maxCount && backup.createdAt >= cutoff) continue;
      await rm(resolveBackupPath(backupDirectory, backup.id), { force: true });
      removedIds.push(backup.id);
    }
    return { removedIds, retained: backups.length - removedIds.length, policy };
  }

  async function getSchemaStatus(): Promise<AgencyDatabaseSchemaStatus> {
    const db = new Database(databasePath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      return readSchemaStatus(db);
    } finally {
      db.close();
    }
  }

  async function getHealth(): Promise<AgencyDatabaseHealth> {
    let integrity: AgencyDatabaseHealth["integrity"] = "unavailable";
    let schema: AgencyDatabaseSchemaStatus = {
      currentVersion: 0,
      supportedVersion: AGENCY_DATABASE_SCHEMA_VERSION,
      migrationCount: 0,
      upToDate: false,
      newerThanRuntime: false,
      lastMigratedAt: null,
    };
    try {
      const inspection = inspectDatabase(databasePath);
      integrity = inspection.verified ? "ok" : "failed";
      schema = inspection.schema;
    } catch {
      // Health responses intentionally avoid leaking filesystem/error details.
    }
    const backups = await listBackups();
    return {
      ok: integrity === "ok" && schema.upToDate,
      integrity,
      schema,
      backupCount: backups.length,
      latestBackupAt: backups[0]?.createdAt ?? null,
      latestVerified: backups[0]?.verified ?? false,
      restorePending: restorePlans.size > 0,
    };
  }

  async function prepareRestore(
    backupId: string,
    ttlMs = 10 * 60_000,
  ): Promise<{
    restoreId: string;
    backup: AgencyDatabaseBackup;
    confirmation: string;
    expiresAt: number;
  }> {
    if (!Number.isFinite(ttlMs) || ttlMs < 60_000 || ttlMs > 3_600_000) {
      throw new Error("restore ttl must be between 1 and 60 minutes");
    }
    const backup = await verifyBackup(backupId);
    if (!backup.verified) throw new Error("backup integrity verification failed");
    if (backup.schemaVersion > AGENCY_DATABASE_SCHEMA_VERSION) {
      throw new Error("backup schema is newer than this runtime");
    }
    await mkdir(stagingDirectory, { recursive: true });
    const restoreId = randomUUID();
    const stagedPath = join(stagingDirectory, `${restoreId}.sqlite`);
    await copyFile(resolveBackupPath(backupDirectory, backupId), stagedPath);
    if (!inspectDatabase(stagedPath).verified) {
      await rm(stagedPath, { force: true });
      throw new Error("staged restore integrity verification failed");
    }
    const confirmation = `RESTORE ${backupId}`;
    const expiresAt = now() + ttlMs;
    restorePlans.set(restoreId, {
      id: restoreId,
      backupId,
      stagedPath,
      confirmation,
      expiresAt,
    });
    return { restoreId, backup, confirmation, expiresAt };
  }

  async function cancelRestore(restoreId: string): Promise<{ cancelled: boolean }> {
    const plan = restorePlans.get(restoreId);
    if (!plan) return { cancelled: false };
    restorePlans.delete(restoreId);
    await rm(plan.stagedPath, { force: true });
    return { cancelled: true };
  }

  async function activateRestore(
    restoreId: string,
    confirmation: string,
  ): Promise<{ restoredBackupId: string; safetyBackup: AgencyDatabaseBackup }> {
    const plan = restorePlans.get(restoreId);
    if (!plan) throw new Error("restore plan not found");
    if (plan.expiresAt < now()) {
      await cancelRestore(restoreId);
      throw new Error("restore plan expired");
    }
    if (confirmation !== plan.confirmation) {
      throw new Error("restore confirmation did not match");
    }
    if (!inspectDatabase(plan.stagedPath).verified) {
      throw new Error("staged restore integrity verification failed");
    }

    const safetyBackup = await createBackup();
    options.closeDatabaseUsers?.();
    const replacement = `${databasePath}.restore-${restoreId}`;
    const displaced = `${databasePath}.pre-restore-${now()}`;
    await copyFile(plan.stagedPath, replacement);
    try {
      await rename(databasePath, displaced);
      await rename(replacement, databasePath);
      await rm(displaced, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    } catch (error) {
      await rm(replacement, { force: true });
      try {
        await rename(displaced, databasePath);
      } catch {
        // The safety backup remains available for operator recovery.
      }
      throw error;
    }
    restorePlans.delete(restoreId);
    await rm(plan.stagedPath, { force: true });
    return { restoredBackupId: plan.backupId, safetyBackup };
  }

  return {
    createBackup,
    ensureBackup,
    listBackups,
    verifyBackup,
    pruneBackups,
    getSchemaStatus,
    getHealth,
    prepareRestore,
    cancelRestore,
    activateRestore,
  };
}

export type AgencyDatabaseResilience = ReturnType<typeof createAgencyDatabaseResilience>;
