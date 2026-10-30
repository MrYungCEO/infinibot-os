/**
 * Android Social Ops — V1 seed rack.
 *
 * The launch target in the plan is 4 phones / 12 accounts (3 per handset), so
 * that is exactly what this seeds. It exists for two reasons:
 *
 *  1. A new install opens on a *working* command center rather than an empty
 *     shell, which is how an operator learns the model.
 *  2. It exercises every branch of the pipeline — a posted job, one in flight,
 *     one parked on a human checkpoint, one failed with a bundle and a pending
 *     retry — so the UI's states are real rather than theoretical.
 *
 * Everything here is clearly demo data: handles are `@demo.*`, secret refs
 * point at a `vault://android-ops/demo/...` namespace that holds nothing, and
 * the Ops surface labels the rack as seeded until real devices are registered.
 */

import type { AndroidOpsStore } from "./store.js";
import { buildProvisioningSteps } from "./provisioning.js";
import type {
  InboxItem,
  MediaAsset,
  PhoneDevice,
  Platform,
  PostJob,
  SocialAccount,
} from "./types.js";

const MIN = 60_000;
const HOUR = 60 * MIN;

interface DeviceSeed {
  label: string;
  slot: number;
  model: string;
  androidVersion: string;
  serial: string;
  battery: number;
  charging: boolean;
  freeMb: number;
  totalMb: number;
  ssid: string;
  rssi: number;
  ip: string;
  status: PhoneDevice["status"];
  spare?: boolean;
  channel?: PhoneDevice["updateChannel"];
  notes?: string;
}

const DEVICE_SEEDS: DeviceSeed[] = [
  {
    label: "Phone 01",
    slot: 1,
    model: "Pixel 4a",
    androidVersion: "13",
    serial: "9B021FFAZ00A01",
    battery: 87,
    charging: true,
    freeMb: 38_400,
    totalMb: 64_000,
    ssid: "OPS-5G",
    rssi: -46,
    ip: "100.64.20.11",
    status: "online",
  },
  {
    label: "Phone 02",
    slot: 2,
    model: "Galaxy A32",
    androidVersion: "12",
    serial: "R58N40XQ2ZB",
    battery: 74,
    charging: true,
    freeMb: 21_900,
    totalMb: 64_000,
    ssid: "OPS-5G",
    rssi: -58,
    ip: "100.64.20.12",
    status: "online",
  },
  {
    label: "Phone 03",
    slot: 3,
    model: "Moto G Power",
    androidVersion: "11",
    serial: "ZY22JKQ8T4",
    battery: 41,
    charging: false,
    freeMb: 9_100,
    totalMb: 32_000,
    ssid: "OPS-2G",
    rssi: -71,
    ip: "100.64.20.13",
    status: "degraded",
    channel: "staged",
    notes: "Weak Wi-Fi in slot 3 — candidate for the 2.4GHz uplink swap.",
  },
  {
    label: "Phone 04",
    slot: 4,
    model: "Pixel 4a",
    androidVersion: "13",
    serial: "9B021FFAZ00A04",
    battery: 92,
    charging: true,
    freeMb: 44_200,
    totalMb: 64_000,
    ssid: "OPS-5G",
    rssi: -44,
    ip: "100.64.20.14",
    status: "online",
  },
  {
    label: "Spare 01",
    slot: 5,
    model: "Galaxy A13",
    androidVersion: "12",
    serial: "R9WT30ABCDE",
    battery: 100,
    charging: true,
    freeMb: 52_000,
    totalMb: 64_000,
    ssid: "OPS-5G",
    rssi: -49,
    ip: "100.64.20.15",
    status: "spare",
    spare: true,
    channel: "held",
    notes: "Configured spare — imaged, signed out, held for a same-day swap.",
  },
];

interface AccountSeed {
  handle: string;
  platform: Platform;
  name: string;
  slot: number;
  twoFactor: SocialAccount["twoFactorMethod"];
  lifecycle?: SocialAccount["lifecycle"];
  session?: SocialAccount["sessionHealth"];
  notes?: string;
}

/** 12 accounts, 3 per active handset — the §11 launch density. */
const ACCOUNT_SEEDS: AccountSeed[] = [
  {
    handle: "demo.northstudio",
    platform: "instagram",
    name: "North Studio",
    slot: 1,
    twoFactor: "authenticator",
  },
  {
    handle: "demo.northstudio",
    platform: "tiktok",
    name: "North Studio",
    slot: 1,
    twoFactor: "authenticator",
  },
  {
    handle: "demo.northclips",
    platform: "youtube",
    name: "North Clips",
    slot: 1,
    twoFactor: "authenticator",
  },
  {
    handle: "demo.harborgoods",
    platform: "instagram",
    name: "Harbor Goods",
    slot: 2,
    twoFactor: "authenticator",
  },
  {
    handle: "demo.harborgoods",
    platform: "tiktok",
    name: "Harbor Goods",
    slot: 2,
    twoFactor: "sms",
    session: "stale",
    notes: "SMS 2FA — migrate to an authenticator app at the next maintenance window.",
  },
  {
    handle: "demo.harborgoods",
    platform: "threads",
    name: "Harbor Goods",
    slot: 2,
    twoFactor: "authenticator",
  },
  {
    handle: "demo.atlasfit",
    platform: "instagram",
    name: "Atlas Fit",
    slot: 3,
    twoFactor: "authenticator",
    lifecycle: "action_required",
    session: "logged_out",
    notes:
      "Session expired after the app update. Operator must sign in on Phone 03 and re-trust the device.",
  },
  {
    handle: "demo.atlasfit",
    platform: "tiktok",
    name: "Atlas Fit",
    slot: 3,
    twoFactor: "authenticator",
  },
  {
    handle: "demo.atlasfit",
    platform: "x",
    name: "Atlas Fit",
    slot: 3,
    twoFactor: "authenticator",
  },
  {
    handle: "demo.verdantco",
    platform: "instagram",
    name: "Verdant Co",
    slot: 4,
    twoFactor: "authenticator",
  },
  {
    handle: "demo.verdantco",
    platform: "facebook",
    name: "Verdant Co",
    slot: 4,
    twoFactor: "authenticator",
  },
  {
    handle: "demo.verdantco",
    platform: "youtube",
    name: "Verdant Co",
    slot: 4,
    twoFactor: "authenticator",
  },
];

const MEDIA_SEEDS: Array<Omit<MediaAsset, "id" | "createdAt" | "updatedAt" | "storageBackend">> = [
  {
    title: "Workshop B-roll — bench pour",
    kind: "video",
    storageKey: "demo/workshop-bench-pour.mp4",
    sizeBytes: 42_118_400,
    durationSec: 28,
    width: 1080,
    height: 1920,
    caption: "Slow pour, sharp edges. New drop lands Friday.",
    hashtags: ["#workshop", "#madebyhand", "#smallbatch"],
    platforms: ["instagram", "tiktok"],
    targetAccountIds: [],
    checksum: null,
    posterUrl: null,
  },
  {
    title: "Harbor Goods — restock carousel",
    kind: "carousel",
    storageKey: "demo/harbor-restock.zip",
    sizeBytes: 18_744_320,
    durationSec: null,
    width: 1080,
    height: 1350,
    caption: "Restocked: the canvas roll-top in three colourways.",
    hashtags: ["#restock", "#everydaycarry"],
    platforms: ["instagram", "threads", "facebook"],
    targetAccountIds: [],
    checksum: null,
    posterUrl: null,
  },
  {
    title: "Atlas Fit — 30s form breakdown",
    kind: "video",
    storageKey: "demo/atlas-form-breakdown.mp4",
    sizeBytes: 55_296_000,
    durationSec: 31,
    width: 1080,
    height: 1920,
    caption: "Three cues that fix a collapsing hinge.",
    hashtags: ["#formcheck", "#strength"],
    platforms: ["instagram", "tiktok", "youtube"],
    targetAccountIds: [],
    checksum: null,
    posterUrl: null,
  },
  {
    title: "Verdant Co — greenhouse morning",
    kind: "image",
    storageKey: "demo/verdant-greenhouse.jpg",
    sizeBytes: 3_355_443,
    durationSec: null,
    width: 1440,
    height: 1800,
    caption: "6:40am. Everything still wet.",
    hashtags: ["#greenhouse", "#growers"],
    platforms: ["instagram", "facebook"],
    targetAccountIds: [],
    checksum: null,
    posterUrl: null,
  },
  {
    title: "North Studio — process teaser",
    kind: "video",
    storageKey: "demo/north-process-teaser.mp4",
    sizeBytes: 31_457_280,
    durationSec: 19,
    width: 1080,
    height: 1920,
    caption: "Ten hours in ninety seconds. Full cut on the channel.",
    hashtags: ["#process", "#studio"],
    platforms: ["instagram", "tiktok", "youtube"],
    targetAccountIds: [],
    checksum: null,
    posterUrl: null,
  },
];

/**
 * Populate an empty store with the V1 rack. Idempotent by construction: the
 * caller checks for existing devices first, and `force` wipes before seeding.
 */
export function seedAndroidOps(
  store: AndroidOpsStore,
  opts: { now?: number; force?: boolean; storageBackend?: MediaAsset["storageBackend"] } = {},
): { devices: number; accounts: number; media: number; jobs: number } {
  const now = opts.now ?? Date.now();
  if (opts.force) store.resetAll();

  // Devices ------------------------------------------------------------------
  const deviceIdBySlot = new Map<number, string>();
  for (const seed of DEVICE_SEEDS) {
    const id = `dev-${String(seed.slot).padStart(2, "0")}`;
    deviceIdBySlot.set(seed.slot, id);
    store.upsertDevice({
      id,
      label: seed.label,
      slot: seed.slot,
      model: seed.model,
      androidVersion: seed.androidVersion,
      serial: seed.serial,
      androidId: null,
      status: seed.status,
      batteryPct: seed.battery,
      charging: seed.charging,
      storageFreeMb: seed.freeMb,
      storageTotalMb: seed.totalMb,
      wifiSsid: seed.ssid,
      wifiSignalDbm: seed.rssi,
      tailscaleIp: seed.ip,
      tailscaleUp: seed.status !== "offline",
      // Seeded devices are not physically attached; the adapter probe is what
      // flips these to a real state.
      adbState: "absent",
      scrcpyState: "unavailable",
      lastHeartbeatAt: now - 2 * MIN,
      isSpare: Boolean(seed.spare),
      appVersion: "agent 1.0.0",
      updateChannel: seed.channel ?? "stable",
      notes: seed.notes ?? null,
      createdAt: now,
      updatedAt: now,
    });

    // A day of hourly health history so the sparklines have something true.
    for (let h = 24; h >= 0; h--) {
      const drift = Math.round(Math.sin(h / 3) * 6);
      store.recordHealth({
        deviceId: id,
        at: now - h * HOUR,
        batteryPct: Math.max(5, Math.min(100, seed.battery + drift)),
        charging: seed.charging,
        storageFreeMb: seed.freeMb - h * 12,
        wifiSignalDbm: seed.rssi + (h % 5) - 2,
        status: seed.status,
        online: seed.status !== "offline",
      });
    }
  }

  // Accounts -----------------------------------------------------------------
  const accountIds: string[] = [];
  ACCOUNT_SEEDS.forEach((seed, index) => {
    const id = `acct-${String(index + 1).padStart(2, "0")}`;
    accountIds.push(id);
    store.upsertAccount({
      id,
      handle: seed.handle,
      platform: seed.platform,
      displayName: seed.name,
      deviceId: deviceIdBySlot.get(seed.slot) ?? null,
      lifecycle: seed.lifecycle ?? "active",
      sessionHealth: seed.session ?? "healthy",
      twoFactorEnabled: seed.twoFactor !== "none",
      twoFactorMethod: seed.twoFactor,
      // Domain-controlled mailbox, per §5's "avoid disposable recovery".
      recoveryEmail: `${seed.handle.replace(/\./g, "-")}-${seed.platform}@recovery.example-ops.com`,
      recoveryCodesVaulted: seed.twoFactor === "authenticator",
      secretRef: `vault://android-ops/demo/${seed.platform}/${seed.handle}`,
      lastPostAt: now - (index + 1) * 3 * HOUR,
      recoveryNotes: seed.notes ?? null,
      provisionedAt: now - 30 * 24 * HOUR,
      bio: null,
      avatarRef: null,
      signedUpAt: null,
      loggedInAt: null,
      createdAt: now,
      updatedAt: now,
    });
  });

  // Media --------------------------------------------------------------------
  const mediaIds: string[] = [];
  MEDIA_SEEDS.forEach((seed, index) => {
    const id = `media-${String(index + 1).padStart(2, "0")}`;
    mediaIds.push(id);
    store.upsertMedia({
      ...seed,
      id,
      storageBackend: opts.storageBackend ?? "local",
      createdAt: now - (index + 1) * 6 * HOUR,
      updatedAt: now - (index + 1) * 6 * HOUR,
    });
  });

  // Jobs — one per pipeline state so the operator sees the whole machine ------
  const account = (i: number) => store.getAccount(accountIds[i])!;
  const jobs: PostJob[] = [];

  // Ids are positional, not random: a seeded rack must be byte-for-byte
  // reproducible so the simulator's per-job outcomes are stable across runs.
  let jobSeq = 0;
  const mkJob = (
    over: Partial<PostJob> & { accountIndex: number; mediaIndex: number },
  ): PostJob => {
    const acct = account(over.accountIndex);
    const base: PostJob = {
      id: `job-seed-${String(++jobSeq).padStart(2, "0")}`,
      mediaId: mediaIds[over.mediaIndex],
      accountId: acct.id,
      deviceId: acct.deviceId,
      platform: acct.platform,
      state: "SCHEDULED",
      caption: store.getMedia(mediaIds[over.mediaIndex])?.caption ?? "",
      scheduledFor: now + HOUR,
      dispatchedAt: null,
      preparedAt: null,
      postedAt: null,
      failedAt: null,
      attempt: 1,
      maxAttempts: 3,
      nextRetryAt: null,
      lastError: null,
      actionRequired: null,
      bundleRef: null,
      permalink: null,
      createdAt: now - 2 * HOUR,
      updatedAt: now,
    };
    return { ...base, ...over } as PostJob;
  };

  jobs.push(
    mkJob({
      accountIndex: 0,
      mediaIndex: 4,
      state: "POSTED",
      scheduledFor: now - 5 * HOUR,
      dispatchedAt: now - 5 * HOUR + 30_000,
      preparedAt: now - 5 * HOUR + 90_000,
      postedAt: now - 5 * HOUR + 150_000,
      permalink: "https://example.com/p/demo-north-teaser",
    }),
    mkJob({
      accountIndex: 3,
      mediaIndex: 1,
      state: "POSTED",
      scheduledFor: now - 3 * HOUR,
      dispatchedAt: now - 3 * HOUR + 20_000,
      preparedAt: now - 3 * HOUR + 70_000,
      postedAt: now - 3 * HOUR + 140_000,
      permalink: "https://example.com/p/demo-harbor-restock",
    }),
    mkJob({
      accountIndex: 1,
      mediaIndex: 0,
      state: "PREPARED",
      scheduledFor: now - 4 * MIN,
      dispatchedAt: now - 6 * MIN,
      preparedAt: now - 90_000,
    }),
    mkJob({
      accountIndex: 9,
      mediaIndex: 3,
      state: "DISPATCHED",
      scheduledFor: now - 2 * MIN,
      dispatchedAt: now - 60_000,
    }),
    mkJob({
      accountIndex: 6,
      mediaIndex: 2,
      state: "ACTION_REQUIRED",
      scheduledFor: now - 40 * MIN,
      dispatchedAt: now - 39 * MIN,
      actionRequired: {
        kind: "login_required",
        message:
          "Instagram signed the session out on Phone 03 after the app update. Sign in on the device and re-trust it, then resume this job.",
        raisedAt: now - 38 * MIN,
      },
      bundleRef: "bundle://demo/atlasfit-login-prompt",
    }),
    mkJob({
      accountIndex: 4,
      mediaIndex: 1,
      state: "FAILED",
      scheduledFor: now - 70 * MIN,
      dispatchedAt: now - 69 * MIN,
      preparedAt: now - 68 * MIN,
      failedAt: now - 66 * MIN,
      attempt: 1,
      lastError: "Upload stalled at 61% — Wi-Fi dropped on Phone 02 mid-transfer.",
      nextRetryAt: now + 4 * MIN,
      bundleRef: "bundle://demo/harbor-upload-stall",
    }),
    mkJob({ accountIndex: 7, mediaIndex: 2, state: "SCHEDULED", scheduledFor: now + 45 * MIN }),
    mkJob({ accountIndex: 10, mediaIndex: 3, state: "SCHEDULED", scheduledFor: now + 2 * HOUR }),
    mkJob({ accountIndex: 2, mediaIndex: 4, state: "SCHEDULED", scheduledFor: now + 5 * HOUR }),
    mkJob({ accountIndex: 11, mediaIndex: 3, state: "SCHEDULED", scheduledFor: now + 26 * HOUR }),
    mkJob({ accountIndex: 8, mediaIndex: 2, state: "SCHEDULED", scheduledFor: now + 30 * HOUR }),
    mkJob({ accountIndex: 5, mediaIndex: 1, state: "DRAFT", scheduledFor: now + 50 * HOUR }),
  );

  for (const job of jobs) store.upsertJob(job);

  // Inbox --------------------------------------------------------------------
  const inbox: Array<Omit<InboxItem, "id">> = [
    {
      accountId: accountIds[0],
      platform: "instagram",
      kind: "comment",
      authorHandle: "@quietmakes",
      body: "What resin is that? Been looking for something that cures this clear.",
      receivedAt: now - 25 * MIN,
      status: "new",
      assignee: null,
      replyBody: null,
      repliedAt: null,
      threadRef: "c/8812",
    },
    {
      accountId: accountIds[3],
      platform: "instagram",
      kind: "dm",
      authorHandle: "@bramwell.co",
      body: "Do you ship the roll-top to Canada? Couldn't tell from the listing.",
      receivedAt: now - 55 * MIN,
      status: "assigned",
      assignee: "operator:demo",
      replyBody: null,
      repliedAt: null,
      threadRef: "d/4410",
    },
    {
      accountId: accountIds[7],
      platform: "tiktok",
      kind: "comment",
      authorHandle: "@liftwithmara",
      body: "The third cue finally made it click for me. Thank you.",
      receivedAt: now - 2 * HOUR,
      status: "replied",
      assignee: "operator:demo",
      replyBody: "That's the one that gets everybody. Glad it landed.",
      repliedAt: now - 100 * MIN,
      threadRef: "c/2291",
    },
    {
      accountId: accountIds[9],
      platform: "instagram",
      kind: "mention",
      authorHandle: "@fernandfen",
      body: "Tagged you in our greenhouse tour — hope that's alright!",
      receivedAt: now - 4 * HOUR,
      status: "archived",
      assignee: null,
      replyBody: null,
      repliedAt: null,
      threadRef: "m/771",
    },
  ];
  inbox.forEach((item, i) =>
    store.upsertInbox({ id: `inbox-seed-${String(i + 1).padStart(2, "0")}`, ...item }),
  );

  // A provisioning run parked on its human checkpoint -------------------------
  const steps = buildProvisioningSteps();
  const captchaIndex = steps.findIndex((s) => s.key === "verification");
  steps.forEach((step, i) => {
    if (i < captchaIndex) {
      step.status = "done";
      step.completedAt = now - (captchaIndex - i) * 4 * MIN;
    }
  });
  steps[captchaIndex].status = "blocked";
  steps[captchaIndex].note =
    "Platform is showing a human-verification challenge on Phone 04. An operator must complete it on the device.";
  store.upsertProvisioning({
    id: "prov-seed-01",
    accountId: "acct-pending-01",
    handle: "demo.verdantco.shop",
    platform: "tiktok",
    deviceId: deviceIdBySlot.get(4) ?? null,
    state: "waiting_operator",
    steps,
    startedAt: now - 26 * MIN,
    completedAt: null,
  });

  // Ops history --------------------------------------------------------------
  store.recordBackup({
    at: now - 9 * HOUR,
    kind: "database",
    status: "ok",
    sizeBytes: 4_194_304,
    location: "backups/android-ops-nightly.sqlite",
    durationMs: 1840,
    error: null,
  });
  store.recordBackup({
    at: now - 9 * HOUR,
    kind: "media_metadata",
    status: "ok",
    sizeBytes: 262_144,
    location: "backups/android-ops-media-manifest.json",
    durationMs: 310,
    error: null,
  });

  store.appendAudit({
    at: now - 26 * MIN,
    actor: "system",
    action: "seed.rack",
    targetType: "system",
    targetId: "android-ops",
    summary: `Seeded the V1 demo rack — ${DEVICE_SEEDS.length} handsets, ${ACCOUNT_SEEDS.length} accounts.`,
    meta: { demo: true },
  });

  return {
    devices: DEVICE_SEEDS.length,
    accounts: ACCOUNT_SEEDS.length,
    media: MEDIA_SEEDS.length,
    jobs: jobs.length,
  };
}
