/**
 * Android Social Ops — SQLite persistence.
 *
 * Deliberately dumb: rows in, rows out, JSON columns marshalled at the edge.
 * All policy (state transitions, assignment, escalation, compliance) lives in
 * `job-state-machine.ts`, `assignment.ts` and `service.ts` so it stays testable
 * without a database.
 *
 * Mirrors the ssh-devices / achievements store pattern, including the
 * process-wide singleton accessor at the bottom.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { ANDROID_OPS_SCHEMA } from "./schema.js";
import type {
  AuditEvent,
  BackupRecord,
  DeviceHealthSample,
  InboxItem,
  MediaAsset,
  OpsAlert,
  PhoneDevice,
  PostJob,
  ProvisioningRun,
  SocialAccount,
} from "./types.js";

const log = createSubsystemLogger("android-ops");

const bool = (v: unknown): boolean => v === 1 || v === true;
const num = (v: unknown): number => (v === 1 || v === true ? 1 : 0);
const parseJson = <T>(raw: unknown, fallback: T): T => {
  if (typeof raw !== "string" || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

export class AndroidOpsStore {
  private db: Database.Database;
  /** The state dir this store actually opened — surfaced for diagnostics. */
  readonly stateDir: string;
  /** Absolute path of the SQLite file — surfaced for diagnostics. */
  readonly dbPath: string;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.stateDir = stateDir;
    this.dbPath = join(stateDir, "android-ops.db");
    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(ANDROID_OPS_SCHEMA);
    // `CREATE TABLE IF NOT EXISTS` never adds columns to a table that already
    // exists, so a database created before the stable-identity work has no
    // `androidId` column. Add it in place rather than forcing a reseed.
    this.ensureColumn("ao_devices", "androidId", "TEXT");
    // Profile copy and the two states an operator actually tracks during signup.
    this.ensureColumn("ao_accounts", "bio", "TEXT");
    this.ensureColumn("ao_accounts", "avatarRef", "TEXT");
    this.ensureColumn("ao_accounts", "signedUpAt", "INTEGER");
    this.ensureColumn("ao_accounts", "loggedInAt", "INTEGER");
    // Index created only after the column is guaranteed to exist — on an older
    // database the migration above adds it, so this must not run inside the
    // `CREATE TABLE IF NOT EXISTS` schema block.
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_ao_devices_androidId ON ao_devices(androidId)");
    log.info("android-ops store ready", {
      dbPath: this.dbPath,
      devices: this.count("ao_devices"),
      accounts: this.count("ao_accounts"),
      jobs: this.count("ao_jobs"),
    });
  }

  /** Add a column to an existing table when a prior schema version lacked it. */
  private ensureColumn(table: string, column: string, decl: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
    }
  }

  count(table: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    return row.n;
  }

  get raw(): Database.Database {
    return this.db;
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }

  // ── Devices ────────────────────────────────────────────────────────────────

  private toDevice = (r: Record<string, unknown>): PhoneDevice => ({
    id: r.id as string,
    label: r.label as string,
    slot: r.slot as number,
    model: r.model as string,
    androidVersion: r.androidVersion as string,
    serial: r.serial as string,
    androidId: (r.androidId as string) ?? null,
    status: r.status as PhoneDevice["status"],
    batteryPct: r.batteryPct as number,
    charging: bool(r.charging),
    storageFreeMb: r.storageFreeMb as number,
    storageTotalMb: r.storageTotalMb as number,
    wifiSsid: (r.wifiSsid as string) ?? null,
    wifiSignalDbm: (r.wifiSignalDbm as number) ?? null,
    tailscaleIp: (r.tailscaleIp as string) ?? null,
    tailscaleUp: bool(r.tailscaleUp),
    adbState: r.adbState as PhoneDevice["adbState"],
    scrcpyState: r.scrcpyState as PhoneDevice["scrcpyState"],
    lastHeartbeatAt: (r.lastHeartbeatAt as number) ?? null,
    isSpare: bool(r.isSpare),
    appVersion: (r.appVersion as string) ?? null,
    updateChannel: r.updateChannel as PhoneDevice["updateChannel"],
    notes: (r.notes as string) ?? null,
    createdAt: r.createdAt as number,
    updatedAt: r.updatedAt as number,
  });

  listDevices(): PhoneDevice[] {
    return (
      this.db.prepare("SELECT * FROM ao_devices ORDER BY slot ASC").all() as Record<
        string,
        unknown
      >[]
    ).map(this.toDevice);
  }

  getDevice(id: string): PhoneDevice | null {
    const row = this.db.prepare("SELECT * FROM ao_devices WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.toDevice(row) : null;
  }

  upsertDevice(device: PhoneDevice): PhoneDevice {
    this.db
      .prepare(
        `INSERT INTO ao_devices (id,label,slot,model,androidVersion,serial,androidId,status,batteryPct,charging,
           storageFreeMb,storageTotalMb,wifiSsid,wifiSignalDbm,tailscaleIp,tailscaleUp,adbState,scrcpyState,
           lastHeartbeatAt,isSpare,appVersion,updateChannel,notes,createdAt,updatedAt)
         VALUES (@id,@label,@slot,@model,@androidVersion,@serial,@androidId,@status,@batteryPct,@charging,
           @storageFreeMb,@storageTotalMb,@wifiSsid,@wifiSignalDbm,@tailscaleIp,@tailscaleUp,@adbState,@scrcpyState,
           @lastHeartbeatAt,@isSpare,@appVersion,@updateChannel,@notes,@createdAt,@updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           label=@label, slot=@slot, model=@model, androidVersion=@androidVersion, serial=@serial,
           androidId=@androidId, status=@status,
           batteryPct=@batteryPct, charging=@charging, storageFreeMb=@storageFreeMb, storageTotalMb=@storageTotalMb,
           wifiSsid=@wifiSsid, wifiSignalDbm=@wifiSignalDbm, tailscaleIp=@tailscaleIp, tailscaleUp=@tailscaleUp,
           adbState=@adbState, scrcpyState=@scrcpyState, lastHeartbeatAt=@lastHeartbeatAt, isSpare=@isSpare,
           appVersion=@appVersion, updateChannel=@updateChannel, notes=@notes, updatedAt=@updatedAt`,
      )
      .run({
        ...device,
        charging: num(device.charging),
        tailscaleUp: num(device.tailscaleUp),
        isSpare: num(device.isSpare),
      });
    return device;
  }

  /** Serials are the identity an adapter reports, so lookups by serial matter. */
  getDeviceBySerial(serial: string): PhoneDevice | null {
    const row = this.db.prepare("SELECT * FROM ao_devices WHERE serial = ?").get(serial) as
      | Record<string, unknown>
      | undefined;
    return row ? this.toDevice(row) : null;
  }

  /**
   * The stable per-install identity. Unlike a wireless-debugging serial (whose
   * port changes on every re-pair) this does not move, so it is the key a
   * reconnecting handset is matched on to avoid spawning a duplicate row.
   */
  getDeviceByAndroidId(androidId: string): PhoneDevice | null {
    const value = (androidId ?? "").trim();
    if (!value) return null;
    const row = this.db.prepare("SELECT * FROM ao_devices WHERE androidId = ?").get(value) as
      | Record<string, unknown>
      | undefined;
    return row ? this.toDevice(row) : null;
  }

  /**
   * Fold one device row into another: re-point every account and job that
   * references `fromId` at `toId`, move the health history, then drop the
   * duplicate row. Transactional — the merge either lands whole or not at all.
   * Callers pick which row survives; this only performs the fold.
   */
  mergeDeviceInto(fromId: string, toId: string): { accountsMoved: number; jobsMoved: number } {
    if (fromId === toId) throw new Error("Cannot merge a device into itself.");
    return this.db.transaction(() => {
      const accountsMoved = this.db
        .prepare("UPDATE ao_accounts SET deviceId = ?, updatedAt = ? WHERE deviceId = ?")
        .run(toId, Date.now(), fromId).changes;
      const jobsMoved = this.db
        .prepare("UPDATE ao_jobs SET deviceId = ?, updatedAt = ? WHERE deviceId = ?")
        .run(toId, Date.now(), fromId).changes;
      this.db
        .prepare("UPDATE ao_device_health SET deviceId = ? WHERE deviceId = ?")
        .run(toId, fromId);
      this.db.prepare("DELETE FROM ao_devices WHERE id = ?").run(fromId);
      return { accountsMoved, jobsMoved };
    })();
  }

  /**
   * Drop a handset and its health history. Callers are expected to have already
   * checked that nothing still points at it — the store does not cascade.
   */
  deleteDevice(id: string): boolean {
    return this.db.transaction(() => {
      this.db.prepare("DELETE FROM ao_device_health WHERE deviceId = ?").run(id);
      return this.db.prepare("DELETE FROM ao_devices WHERE id = ?").run(id).changes > 0;
    })();
  }

  recordHealth(sample: Omit<DeviceHealthSample, "id">): DeviceHealthSample {
    const row: DeviceHealthSample = { id: randomUUID(), ...sample };
    this.db
      .prepare(
        `INSERT INTO ao_device_health (id,deviceId,at,batteryPct,charging,storageFreeMb,wifiSignalDbm,status,online)
         VALUES (@id,@deviceId,@at,@batteryPct,@charging,@storageFreeMb,@wifiSignalDbm,@status,@online)`,
      )
      .run({ ...row, charging: num(row.charging), online: num(row.online) });
    return row;
  }

  healthHistory(deviceId: string, limit = 48): DeviceHealthSample[] {
    const rows = this.db
      .prepare("SELECT * FROM ao_device_health WHERE deviceId = ? ORDER BY at DESC LIMIT ?")
      .all(deviceId, limit) as Record<string, unknown>[];
    return rows
      .map((r) => ({
        id: r.id as string,
        deviceId: r.deviceId as string,
        at: r.at as number,
        batteryPct: r.batteryPct as number,
        charging: bool(r.charging),
        storageFreeMb: r.storageFreeMb as number,
        wifiSignalDbm: (r.wifiSignalDbm as number) ?? null,
        status: r.status as DeviceHealthSample["status"],
        online: bool(r.online),
      }))
      .reverse();
  }

  /** Trim health history so the table can't grow unbounded on a long-lived rack. */
  pruneHealth(olderThan: number): number {
    return this.db.prepare("DELETE FROM ao_device_health WHERE at < ?").run(olderThan).changes;
  }

  // ── Accounts ───────────────────────────────────────────────────────────────

  private toAccount = (r: Record<string, unknown>): SocialAccount => ({
    id: r.id as string,
    handle: r.handle as string,
    platform: r.platform as SocialAccount["platform"],
    displayName: r.displayName as string,
    deviceId: (r.deviceId as string) ?? null,
    lifecycle: r.lifecycle as SocialAccount["lifecycle"],
    sessionHealth: r.sessionHealth as SocialAccount["sessionHealth"],
    twoFactorEnabled: bool(r.twoFactorEnabled),
    twoFactorMethod: r.twoFactorMethod as SocialAccount["twoFactorMethod"],
    recoveryEmail: r.recoveryEmail as string,
    recoveryCodesVaulted: bool(r.recoveryCodesVaulted),
    secretRef: r.secretRef as string,
    lastPostAt: (r.lastPostAt as number) ?? null,
    recoveryNotes: (r.recoveryNotes as string) ?? null,
    provisionedAt: (r.provisionedAt as number) ?? null,
    bio: (r.bio as string) ?? null,
    avatarRef: (r.avatarRef as string) ?? null,
    signedUpAt: (r.signedUpAt as number) ?? null,
    loggedInAt: (r.loggedInAt as number) ?? null,
    createdAt: r.createdAt as number,
    updatedAt: r.updatedAt as number,
  });

  listAccounts(): SocialAccount[] {
    const rows = this.db
      .prepare("SELECT * FROM ao_accounts ORDER BY platform ASC, handle ASC")
      .all() as Record<string, unknown>[];
    return rows.map(this.toAccount);
  }

  getAccount(id: string): SocialAccount | null {
    const row = this.db.prepare("SELECT * FROM ao_accounts WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.toAccount(row) : null;
  }

  /** `(platform, handle)` is the natural key an import re-runs against. */
  getAccountByHandle(platform: string, handle: string): SocialAccount | null {
    const row = this.db
      .prepare("SELECT * FROM ao_accounts WHERE platform = ? AND handle = ?")
      .get(platform, handle) as Record<string, unknown> | undefined;
    return row ? this.toAccount(row) : null;
  }

  accountsOnDevice(deviceId: string): SocialAccount[] {
    const rows = this.db
      .prepare("SELECT * FROM ao_accounts WHERE deviceId = ? ORDER BY handle ASC")
      .all(deviceId) as Record<string, unknown>[];
    return rows.map(this.toAccount);
  }

  upsertAccount(account: SocialAccount): SocialAccount {
    this.db
      .prepare(
        `INSERT INTO ao_accounts (id,handle,platform,displayName,deviceId,lifecycle,sessionHealth,twoFactorEnabled,
           twoFactorMethod,recoveryEmail,recoveryCodesVaulted,secretRef,lastPostAt,recoveryNotes,provisionedAt,
           bio,avatarRef,signedUpAt,loggedInAt,createdAt,updatedAt)
         VALUES (@id,@handle,@platform,@displayName,@deviceId,@lifecycle,@sessionHealth,@twoFactorEnabled,
           @twoFactorMethod,@recoveryEmail,@recoveryCodesVaulted,@secretRef,@lastPostAt,@recoveryNotes,@provisionedAt,
           @bio,@avatarRef,@signedUpAt,@loggedInAt,@createdAt,@updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           handle=@handle, platform=@platform, displayName=@displayName, deviceId=@deviceId, lifecycle=@lifecycle,
           sessionHealth=@sessionHealth, twoFactorEnabled=@twoFactorEnabled, twoFactorMethod=@twoFactorMethod,
           recoveryEmail=@recoveryEmail, recoveryCodesVaulted=@recoveryCodesVaulted, secretRef=@secretRef,
           lastPostAt=@lastPostAt, recoveryNotes=@recoveryNotes, provisionedAt=@provisionedAt,
           bio=@bio, avatarRef=@avatarRef, signedUpAt=@signedUpAt, loggedInAt=@loggedInAt, updatedAt=@updatedAt`,
      )
      .run({
        ...account,
        twoFactorEnabled: num(account.twoFactorEnabled),
        recoveryCodesVaulted: num(account.recoveryCodesVaulted),
        bio: account.bio ?? null,
        avatarRef: account.avatarRef ?? null,
        signedUpAt: account.signedUpAt ?? null,
        loggedInAt: account.loggedInAt ?? null,
      });
    return account;
  }

  // ── Media ──────────────────────────────────────────────────────────────────

  private toMedia = (r: Record<string, unknown>): MediaAsset => ({
    id: r.id as string,
    title: r.title as string,
    kind: r.kind as MediaAsset["kind"],
    storageKey: r.storageKey as string,
    storageBackend: r.storageBackend as MediaAsset["storageBackend"],
    sizeBytes: r.sizeBytes as number,
    durationSec: (r.durationSec as number) ?? null,
    width: (r.width as number) ?? null,
    height: (r.height as number) ?? null,
    caption: (r.caption as string) ?? "",
    hashtags: parseJson<string[]>(r.hashtags, []),
    platforms: parseJson<MediaAsset["platforms"]>(r.platforms, []),
    targetAccountIds: parseJson<string[]>(r.targetAccountIds, []),
    checksum: (r.checksum as string) ?? null,
    posterUrl: (r.posterUrl as string) ?? null,
    createdAt: r.createdAt as number,
    updatedAt: r.updatedAt as number,
  });

  listMedia(): MediaAsset[] {
    const rows = this.db.prepare("SELECT * FROM ao_media ORDER BY createdAt DESC").all() as Record<
      string,
      unknown
    >[];
    return rows.map(this.toMedia);
  }

  getMedia(id: string): MediaAsset | null {
    const row = this.db.prepare("SELECT * FROM ao_media WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.toMedia(row) : null;
  }

  upsertMedia(media: MediaAsset): MediaAsset {
    this.db
      .prepare(
        `INSERT INTO ao_media (id,title,kind,storageKey,storageBackend,sizeBytes,durationSec,width,height,caption,
           hashtags,platforms,targetAccountIds,checksum,posterUrl,createdAt,updatedAt)
         VALUES (@id,@title,@kind,@storageKey,@storageBackend,@sizeBytes,@durationSec,@width,@height,@caption,
           @hashtags,@platforms,@targetAccountIds,@checksum,@posterUrl,@createdAt,@updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           title=@title, kind=@kind, storageKey=@storageKey, storageBackend=@storageBackend, sizeBytes=@sizeBytes,
           durationSec=@durationSec, width=@width, height=@height, caption=@caption, hashtags=@hashtags,
           platforms=@platforms, targetAccountIds=@targetAccountIds, checksum=@checksum, posterUrl=@posterUrl,
           updatedAt=@updatedAt`,
      )
      .run({
        ...media,
        hashtags: JSON.stringify(media.hashtags),
        platforms: JSON.stringify(media.platforms),
        targetAccountIds: JSON.stringify(media.targetAccountIds),
      });
    return media;
  }

  deleteMedia(id: string): boolean {
    return this.db.prepare("DELETE FROM ao_media WHERE id = ?").run(id).changes > 0;
  }

  // ── Jobs ───────────────────────────────────────────────────────────────────

  private toJob = (r: Record<string, unknown>): PostJob => ({
    id: r.id as string,
    mediaId: r.mediaId as string,
    accountId: r.accountId as string,
    deviceId: (r.deviceId as string) ?? null,
    platform: r.platform as PostJob["platform"],
    state: r.state as PostJob["state"],
    caption: (r.caption as string) ?? "",
    scheduledFor: r.scheduledFor as number,
    dispatchedAt: (r.dispatchedAt as number) ?? null,
    preparedAt: (r.preparedAt as number) ?? null,
    postedAt: (r.postedAt as number) ?? null,
    failedAt: (r.failedAt as number) ?? null,
    attempt: r.attempt as number,
    maxAttempts: r.maxAttempts as number,
    nextRetryAt: (r.nextRetryAt as number) ?? null,
    lastError: (r.lastError as string) ?? null,
    actionRequired: parseJson<PostJob["actionRequired"]>(r.actionRequired, null),
    bundleRef: (r.bundleRef as string) ?? null,
    permalink: (r.permalink as string) ?? null,
    createdAt: r.createdAt as number,
    updatedAt: r.updatedAt as number,
  });

  listJobs(
    opts: { states?: string[]; limit?: number; from?: number; to?: number } = {},
  ): PostJob[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (opts.states?.length) {
      clauses.push(`state IN (${opts.states.map(() => "?").join(",")})`);
      params.push(...opts.states);
    }
    if (opts.from !== undefined) {
      clauses.push("scheduledFor >= ?");
      params.push(opts.from);
    }
    if (opts.to !== undefined) {
      clauses.push("scheduledFor < ?");
      params.push(opts.to);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(opts.limit ?? 500);
    const rows = this.db
      .prepare(`SELECT * FROM ao_jobs ${where} ORDER BY scheduledFor ASC LIMIT ?`)
      .all(...params) as Record<string, unknown>[];
    return rows.map(this.toJob);
  }

  getJob(id: string): PostJob | null {
    const row = this.db.prepare("SELECT * FROM ao_jobs WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.toJob(row) : null;
  }

  upsertJob(job: PostJob): PostJob {
    this.db
      .prepare(
        `INSERT INTO ao_jobs (id,mediaId,accountId,deviceId,platform,state,caption,scheduledFor,dispatchedAt,
           preparedAt,postedAt,failedAt,attempt,maxAttempts,nextRetryAt,lastError,actionRequired,bundleRef,
           permalink,createdAt,updatedAt)
         VALUES (@id,@mediaId,@accountId,@deviceId,@platform,@state,@caption,@scheduledFor,@dispatchedAt,
           @preparedAt,@postedAt,@failedAt,@attempt,@maxAttempts,@nextRetryAt,@lastError,@actionRequired,@bundleRef,
           @permalink,@createdAt,@updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           mediaId=@mediaId, accountId=@accountId, deviceId=@deviceId, platform=@platform, state=@state,
           caption=@caption, scheduledFor=@scheduledFor, dispatchedAt=@dispatchedAt, preparedAt=@preparedAt,
           postedAt=@postedAt, failedAt=@failedAt, attempt=@attempt, maxAttempts=@maxAttempts,
           nextRetryAt=@nextRetryAt, lastError=@lastError, actionRequired=@actionRequired, bundleRef=@bundleRef,
           permalink=@permalink, updatedAt=@updatedAt`,
      )
      .run({
        ...job,
        actionRequired: job.actionRequired ? JSON.stringify(job.actionRequired) : null,
      });
    return job;
  }

  // ── Audit ──────────────────────────────────────────────────────────────────

  appendAudit(event: Omit<AuditEvent, "id">): AuditEvent {
    const row: AuditEvent = { id: randomUUID(), ...event };
    this.db
      .prepare(
        `INSERT INTO ao_audit (id,at,actor,action,targetType,targetId,summary,meta)
         VALUES (@id,@at,@actor,@action,@targetType,@targetId,@summary,@meta)`,
      )
      .run({ ...row, meta: row.meta ? JSON.stringify(row.meta) : null });
    return row;
  }

  listAudit(opts: { targetType?: string; targetId?: string; limit?: number } = {}): AuditEvent[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (opts.targetType) {
      clauses.push("targetType = ?");
      params.push(opts.targetType);
    }
    if (opts.targetId) {
      clauses.push("targetId = ?");
      params.push(opts.targetId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(opts.limit ?? 200);
    const rows = this.db
      .prepare(`SELECT * FROM ao_audit ${where} ORDER BY at DESC, rowid DESC LIMIT ?`)
      .all(...params) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      at: r.at as number,
      actor: r.actor as string,
      action: r.action as string,
      targetType: r.targetType as AuditEvent["targetType"],
      targetId: r.targetId as string,
      summary: r.summary as string,
      meta: parseJson<Record<string, unknown> | null>(r.meta, null),
    }));
  }

  // ── Inbox ──────────────────────────────────────────────────────────────────

  listInbox(status?: string): InboxItem[] {
    const rows = (
      status
        ? this.db
            .prepare("SELECT * FROM ao_inbox WHERE status = ? ORDER BY receivedAt DESC LIMIT 300")
            .all(status)
        : this.db.prepare("SELECT * FROM ao_inbox ORDER BY receivedAt DESC LIMIT 300").all()
    ) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      accountId: r.accountId as string,
      platform: r.platform as InboxItem["platform"],
      kind: r.kind as InboxItem["kind"],
      authorHandle: r.authorHandle as string,
      body: r.body as string,
      receivedAt: r.receivedAt as number,
      status: r.status as InboxItem["status"],
      assignee: (r.assignee as string) ?? null,
      replyBody: (r.replyBody as string) ?? null,
      repliedAt: (r.repliedAt as number) ?? null,
      threadRef: (r.threadRef as string) ?? null,
    }));
  }

  getInboxItem(id: string): InboxItem | null {
    return this.listInbox().find((i) => i.id === id) ?? null;
  }

  upsertInbox(item: InboxItem): InboxItem {
    this.db
      .prepare(
        `INSERT INTO ao_inbox (id,accountId,platform,kind,authorHandle,body,receivedAt,status,assignee,replyBody,
           repliedAt,threadRef)
         VALUES (@id,@accountId,@platform,@kind,@authorHandle,@body,@receivedAt,@status,@assignee,@replyBody,
           @repliedAt,@threadRef)
         ON CONFLICT(id) DO UPDATE SET
           status=@status, assignee=@assignee, replyBody=@replyBody, repliedAt=@repliedAt, threadRef=@threadRef`,
      )
      .run(item);
    return item;
  }

  // ── Provisioning ───────────────────────────────────────────────────────────

  listProvisioning(): ProvisioningRun[] {
    const rows = this.db
      .prepare("SELECT * FROM ao_provisioning ORDER BY startedAt DESC LIMIT 100")
      .all() as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      accountId: r.accountId as string,
      handle: r.handle as string,
      platform: r.platform as ProvisioningRun["platform"],
      deviceId: (r.deviceId as string) ?? null,
      state: r.state as ProvisioningRun["state"],
      steps: parseJson<ProvisioningRun["steps"]>(r.steps, []),
      startedAt: r.startedAt as number,
      completedAt: (r.completedAt as number) ?? null,
    }));
  }

  getProvisioning(id: string): ProvisioningRun | null {
    return this.listProvisioning().find((p) => p.id === id) ?? null;
  }

  upsertProvisioning(run: ProvisioningRun): ProvisioningRun {
    this.db
      .prepare(
        `INSERT INTO ao_provisioning (id,accountId,handle,platform,deviceId,state,steps,startedAt,completedAt)
         VALUES (@id,@accountId,@handle,@platform,@deviceId,@state,@steps,@startedAt,@completedAt)
         ON CONFLICT(id) DO UPDATE SET
           deviceId=@deviceId, state=@state, steps=@steps, completedAt=@completedAt`,
      )
      .run({ ...run, steps: JSON.stringify(run.steps) });
    return run;
  }

  // ── Alerts + backups ───────────────────────────────────────────────────────

  raiseAlert(alert: Omit<OpsAlert, "id">): OpsAlert {
    const row: OpsAlert = { id: randomUUID(), ...alert };
    this.db
      .prepare(
        `INSERT INTO ao_alerts (id,at,severity,kind,subjectType,subjectId,message,acknowledgedAt,acknowledgedBy)
         VALUES (@id,@at,@severity,@kind,@subjectType,@subjectId,@message,@acknowledgedAt,@acknowledgedBy)`,
      )
      .run(row);
    return row;
  }

  /** True when an unacknowledged alert of this kind already exists — avoids spam. */
  hasOpenAlert(kind: string, subjectId: string): boolean {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM ao_alerts WHERE kind = ? AND subjectId = ? AND acknowledgedAt IS NULL",
      )
      .get(kind, subjectId) as { n: number };
    return row.n > 0;
  }

  listAlerts(openOnly = false): OpsAlert[] {
    const sql = openOnly
      ? "SELECT * FROM ao_alerts WHERE acknowledgedAt IS NULL ORDER BY at DESC LIMIT 200"
      : "SELECT * FROM ao_alerts ORDER BY at DESC LIMIT 200";
    const rows = this.db.prepare(sql).all() as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      at: r.at as number,
      severity: r.severity as OpsAlert["severity"],
      kind: r.kind as string,
      subjectType: r.subjectType as OpsAlert["subjectType"],
      subjectId: r.subjectId as string,
      message: r.message as string,
      acknowledgedAt: (r.acknowledgedAt as number) ?? null,
      acknowledgedBy: (r.acknowledgedBy as string) ?? null,
    }));
  }

  acknowledgeAlert(id: string, by: string, at: number): boolean {
    return (
      this.db
        .prepare("UPDATE ao_alerts SET acknowledgedAt = ?, acknowledgedBy = ? WHERE id = ?")
        .run(at, by, id).changes > 0
    );
  }

  recordBackup(backup: Omit<BackupRecord, "id">): BackupRecord {
    const row: BackupRecord = { id: randomUUID(), ...backup };
    this.db
      .prepare(
        `INSERT INTO ao_backups (id,at,kind,status,sizeBytes,location,durationMs,error)
         VALUES (@id,@at,@kind,@status,@sizeBytes,@location,@durationMs,@error)`,
      )
      .run(row);
    return row;
  }

  listBackups(limit = 20): BackupRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM ao_backups ORDER BY at DESC LIMIT ?")
      .all(limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      at: r.at as number,
      kind: r.kind as BackupRecord["kind"],
      status: r.status as BackupRecord["status"],
      sizeBytes: r.sizeBytes as number,
      location: r.location as string,
      durationMs: r.durationMs as number,
      error: (r.error as string) ?? null,
    }));
  }

  /** Wipe every table — used by the reseed action. */
  resetAll(): void {
    const tables = [
      "ao_jobs",
      "ao_media",
      "ao_accounts",
      "ao_device_health",
      "ao_devices",
      "ao_inbox",
      "ao_provisioning",
      "ao_alerts",
      "ao_backups",
      "ao_audit",
    ];
    this.db.transaction(() => {
      for (const t of tables) this.db.prepare(`DELETE FROM ${t}`).run();
    })();
  }
}

/**
 * Read the device count out of an android-ops database file *without* opening
 * the live store — used only for the "you're pointed at an empty database while
 * the default one has devices" warning. Returns null when the file is absent or
 * unreadable, so a missing default DB is never mistaken for an empty one.
 */
export function peekDeviceCount(dbPath: string): number | null {
  if (!existsSync(dbPath)) return null;
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = db.prepare("SELECT COUNT(*) AS n FROM ao_devices").get() as { n: number };
    return row.n;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
  }
}

let singleton: AndroidOpsStore | null = null;

export function getAndroidOpsStore(): AndroidOpsStore {
  if (!singleton) singleton = new AndroidOpsStore(resolveStateDir());
  return singleton;
}

export function closeAndroidOpsStore(): void {
  singleton?.close();
  singleton = null;
}
