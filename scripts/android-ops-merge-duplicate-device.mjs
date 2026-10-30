#!/usr/bin/env node
/**
 * Android Ops — duplicate handset repair.
 *
 * A phone registered under a wireless-debugging serial (`host:port`, whose port
 * changes on every re-pair) used to insert a fresh row on each reconnect, so one
 * physical handset ends up recorded twice: an online row with real telemetry and
 * a stale offline row. Going forward `registerDevice` keys on a stable identity
 * (ANDROID_ID, else tailnet-IP + model) and reconnects update in place — but rows
 * created before that fix still need folding together. This does that safely:
 *
 *   1. Backs up android-ops.db (+ -wal/-shm) with the existing backup naming.
 *   2. Backfills the survivor's ANDROID_ID from an `androidId=` companion note.
 *   3. Merges each duplicate through the service API, so accounts, jobs and health
 *      history are re-pointed and the fold is audited — never a blind SQL DELETE.
 *
 * Usage:
 *   node scripts/android-ops-merge-duplicate-device.mjs [--dry-run]
 *   node scripts/android-ops-merge-duplicate-device.mjs --keep dev-01 --drop dev-02
 *
 * Honors INFINIBOT_STATE_DIR (defaults to ~/.infinibot), matching the gateway.
 */

import { existsSync, copyFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const dryRun = flag("--dry-run");
const explicitKeep = opt("--keep");
const explicitDrop = opt("--drop");

const stateDir = (process.env.INFINIBOT_STATE_DIR || join(homedir(), ".infinibot")).trim();
const dbPath = join(stateDir, "android-ops.db");

if (!existsSync(dbPath)) {
  console.error(`[merge] No android-ops.db at ${dbPath} (INFINIBOT_STATE_DIR=${stateDir}).`);
  process.exit(1);
}

// Resolve the COMPILED domain layer — the same dist the standalone dashboard
// loads. Rebuild the backend first if these are stale.
const distBase = pathToFileURL(join(process.cwd(), "dist", "android-ops")).href;
const { AndroidOpsStore } = await import(`${distBase}/store.js`);
const { AndroidOpsService } = await import(`${distBase}/service.js`);
const { androidIdFromNotes, sameStableIdentity } = await import(`${distBase}/setup.js`);
const { NullDeviceAdapter, NullStreamAdapter } = await import(`${distBase}/adapters/null-device.js`);
const { LocalStorageAdapter } = await import(`${distBase}/adapters/storage.js`);

// ── 1. Back up first, using the existing backup naming convention. ────────────
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = `${dbPath}.before-merge-${stamp}`;
if (!dryRun) {
  for (const suffix of ["", "-wal", "-shm"]) {
    const src = dbPath + suffix;
    if (existsSync(src)) copyFileSync(src, backupPath + suffix);
  }
  console.log(`[merge] Backed up ${dbPath} → ${backupPath}`);
} else {
  console.log(`[merge] (dry-run) would back up ${dbPath} → ${backupPath}`);
}

const store = new AndroidOpsStore(stateDir);
const service = new AndroidOpsService(store, {
  device: new NullDeviceAdapter(),
  stream: new NullStreamAdapter(),
  storage: new LocalStorageAdapter(join(stateDir, "android-ops-media")),
});

/** Prefer the row an operator would keep: online, most recent, lowest slot. */
function pickSurvivor(a, b) {
  const live = (d) => d.status === "online" || d.status === "degraded";
  if (live(a) !== live(b)) return live(a) ? a : b;
  const beat = (d) => d.lastHeartbeatAt ?? 0;
  if (beat(a) !== beat(b)) return beat(a) > beat(b) ? a : b;
  return a.slot <= b.slot ? a : b;
}

const before = store.listDevices();
console.log(`[merge] ${before.length} device row(s) before repair.`);

// ── 2. Determine the (keep, drop) pairs. ──────────────────────────────────────
const pairs = [];
if (explicitKeep && explicitDrop) {
  pairs.push({ keep: explicitKeep, drop: explicitDrop });
} else {
  // Auto-detect: group rows by stable identity, keep the healthiest per group.
  const remaining = [...before];
  while (remaining.length) {
    const head = remaining.shift();
    const dupes = remaining.filter((d) => sameStableIdentity(head, d));
    if (!dupes.length) continue;
    for (const d of dupes) remaining.splice(remaining.indexOf(d), 1);
    let survivor = head;
    for (const d of dupes) survivor = pickSurvivor(survivor, d);
    for (const d of [head, ...dupes]) {
      if (d.id !== survivor.id) pairs.push({ keep: survivor.id, drop: d.id });
    }
  }
}

if (!pairs.length) {
  console.log("[merge] No duplicate handsets found. Nothing to do.");
  store.close();
  process.exit(0);
}

// ── 3. Report what will move, backfill identity, then merge. ──────────────────
for (const { keep, drop } of pairs) {
  const keepRow = store.getDevice(keep);
  const dropRow = store.getDevice(drop);
  if (!keepRow || !dropRow) {
    console.error(`[merge] Skipping ${drop}→${keep}: one of the rows is missing.`);
    continue;
  }
  const dropAccounts = store.accountsOnDevice(drop);
  const dropJobs = store.listJobs({ limit: 5000 }).filter((j) => j.deviceId === drop);
  console.log(
    `[merge] ${drop} (${dropRow.serial}, ${dropRow.status}) → ${keep} (${keepRow.serial}, ${keepRow.status}); ` +
      `${dropAccounts.length} account(s), ${dropJobs.length} job(s) will be re-pointed.`,
  );

  // Carry the stable ANDROID_ID forward. On a pre-fix DB it lives in the notes
  // text, not the column — recover it so future reconnects key on it.
  const androidId =
    keepRow.androidId ??
    dropRow.androidId ??
    androidIdFromNotes(keepRow.notes) ??
    androidIdFromNotes(dropRow.notes) ??
    null;

  if (dryRun) {
    console.log(`[merge] (dry-run) would merge; survivor androidId=${androidId ?? "(none)"}`);
    continue;
  }

  if (androidId && !keepRow.androidId) {
    store.upsertDevice({ ...keepRow, androidId, updatedAt: Date.now() });
  }
  const result = service.mergeDevices(keep, drop, "operator:merge-script");
  console.log(
    `[merge] Merged. Survivor ${result.kept.id} serial=${result.kept.serial} ` +
      `androidId=${result.kept.androidId ?? "(none)"}; moved ${result.accountsMoved} account(s), ${result.jobsMoved} job(s).`,
  );
}

const after = store.listDevices();
console.log(`[merge] ${after.length} device row(s) after repair.`);
for (const d of after) {
  console.log(`  - ${d.id} slot ${d.slot} ${d.model} ${d.serial} [${d.status}] androidId=${d.androidId ?? "(none)"}`);
}
store.close();
console.log(dryRun ? "[merge] dry-run complete." : "[merge] Done.");
