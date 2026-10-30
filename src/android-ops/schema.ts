/**
 * Android Social Ops — SQLite schema.
 *
 * The plan specifies PostgreSQL for a production deployment; this
 * implementation uses the gateway's existing SQLite/better-sqlite3 convention
 * (same pattern as `ssh-devices` and `achievements`) so it runs with zero extra
 * infrastructure. The table shapes are deliberately Postgres-portable: integer
 * epoch millis, TEXT ids, JSON in TEXT columns, no SQLite-only types.
 */

export const ANDROID_OPS_SCHEMA = `
CREATE TABLE IF NOT EXISTS ao_devices (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  slot INTEGER NOT NULL,
  model TEXT NOT NULL,
  androidVersion TEXT NOT NULL,
  serial TEXT NOT NULL,
  androidId TEXT,
  status TEXT NOT NULL,
  batteryPct INTEGER NOT NULL DEFAULT 0,
  charging INTEGER NOT NULL DEFAULT 0,
  storageFreeMb INTEGER NOT NULL DEFAULT 0,
  storageTotalMb INTEGER NOT NULL DEFAULT 0,
  wifiSsid TEXT,
  wifiSignalDbm INTEGER,
  tailscaleIp TEXT,
  tailscaleUp INTEGER NOT NULL DEFAULT 0,
  adbState TEXT NOT NULL DEFAULT 'absent',
  scrcpyState TEXT NOT NULL DEFAULT 'unavailable',
  lastHeartbeatAt INTEGER,
  isSpare INTEGER NOT NULL DEFAULT 0,
  appVersion TEXT,
  updateChannel TEXT NOT NULL DEFAULT 'stable',
  notes TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ao_devices_slot ON ao_devices(slot);

CREATE TABLE IF NOT EXISTS ao_device_health (
  id TEXT PRIMARY KEY,
  deviceId TEXT NOT NULL,
  at INTEGER NOT NULL,
  batteryPct INTEGER NOT NULL,
  charging INTEGER NOT NULL DEFAULT 0,
  storageFreeMb INTEGER NOT NULL,
  wifiSignalDbm INTEGER,
  status TEXT NOT NULL,
  online INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ao_health_device_at ON ao_device_health(deviceId, at DESC);

CREATE TABLE IF NOT EXISTS ao_accounts (
  id TEXT PRIMARY KEY,
  handle TEXT NOT NULL,
  platform TEXT NOT NULL,
  displayName TEXT NOT NULL,
  deviceId TEXT,
  lifecycle TEXT NOT NULL,
  sessionHealth TEXT NOT NULL DEFAULT 'unknown',
  twoFactorEnabled INTEGER NOT NULL DEFAULT 0,
  twoFactorMethod TEXT NOT NULL DEFAULT 'none',
  recoveryEmail TEXT NOT NULL,
  recoveryCodesVaulted INTEGER NOT NULL DEFAULT 0,
  secretRef TEXT NOT NULL,
  lastPostAt INTEGER,
  recoveryNotes TEXT,
  provisionedAt INTEGER,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ao_accounts_device ON ao_accounts(deviceId);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ao_accounts_handle ON ao_accounts(platform, handle);

CREATE TABLE IF NOT EXISTS ao_media (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  storageKey TEXT NOT NULL,
  storageBackend TEXT NOT NULL,
  sizeBytes INTEGER NOT NULL DEFAULT 0,
  durationSec REAL,
  width INTEGER,
  height INTEGER,
  caption TEXT NOT NULL DEFAULT '',
  hashtags TEXT NOT NULL DEFAULT '[]',
  platforms TEXT NOT NULL DEFAULT '[]',
  targetAccountIds TEXT NOT NULL DEFAULT '[]',
  checksum TEXT,
  posterUrl TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ao_media_created ON ao_media(createdAt DESC);

CREATE TABLE IF NOT EXISTS ao_jobs (
  id TEXT PRIMARY KEY,
  mediaId TEXT NOT NULL,
  accountId TEXT NOT NULL,
  deviceId TEXT,
  platform TEXT NOT NULL,
  state TEXT NOT NULL,
  caption TEXT NOT NULL DEFAULT '',
  scheduledFor INTEGER NOT NULL,
  dispatchedAt INTEGER,
  preparedAt INTEGER,
  postedAt INTEGER,
  failedAt INTEGER,
  attempt INTEGER NOT NULL DEFAULT 1,
  maxAttempts INTEGER NOT NULL DEFAULT 3,
  nextRetryAt INTEGER,
  lastError TEXT,
  actionRequired TEXT,
  bundleRef TEXT,
  permalink TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ao_jobs_state ON ao_jobs(state, scheduledFor);
CREATE INDEX IF NOT EXISTS idx_ao_jobs_device ON ao_jobs(deviceId, scheduledFor);
CREATE INDEX IF NOT EXISTS idx_ao_jobs_account ON ao_jobs(accountId, scheduledFor DESC);

CREATE TABLE IF NOT EXISTS ao_audit (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  targetType TEXT NOT NULL,
  targetId TEXT NOT NULL,
  summary TEXT NOT NULL,
  meta TEXT
);
CREATE INDEX IF NOT EXISTS idx_ao_audit_at ON ao_audit(at DESC);
CREATE INDEX IF NOT EXISTS idx_ao_audit_target ON ao_audit(targetType, targetId, at DESC);

CREATE TABLE IF NOT EXISTS ao_inbox (
  id TEXT PRIMARY KEY,
  accountId TEXT NOT NULL,
  platform TEXT NOT NULL,
  kind TEXT NOT NULL,
  authorHandle TEXT NOT NULL,
  body TEXT NOT NULL,
  receivedAt INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  assignee TEXT,
  replyBody TEXT,
  repliedAt INTEGER,
  threadRef TEXT
);
CREATE INDEX IF NOT EXISTS idx_ao_inbox_status ON ao_inbox(status, receivedAt DESC);

CREATE TABLE IF NOT EXISTS ao_provisioning (
  id TEXT PRIMARY KEY,
  accountId TEXT NOT NULL,
  handle TEXT NOT NULL,
  platform TEXT NOT NULL,
  deviceId TEXT,
  state TEXT NOT NULL,
  steps TEXT NOT NULL DEFAULT '[]',
  startedAt INTEGER NOT NULL,
  completedAt INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ao_provisioning_state ON ao_provisioning(state, startedAt DESC);

CREATE TABLE IF NOT EXISTS ao_alerts (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  severity TEXT NOT NULL,
  kind TEXT NOT NULL,
  subjectType TEXT NOT NULL,
  subjectId TEXT NOT NULL,
  message TEXT NOT NULL,
  acknowledgedAt INTEGER,
  acknowledgedBy TEXT
);
CREATE INDEX IF NOT EXISTS idx_ao_alerts_open ON ao_alerts(acknowledgedAt, at DESC);

CREATE TABLE IF NOT EXISTS ao_backups (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  sizeBytes INTEGER NOT NULL DEFAULT 0,
  location TEXT NOT NULL,
  durationMs INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_ao_backups_at ON ao_backups(at DESC);
`;
