import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  renderCaption,
  normalizeHashtags,
  mergeHashtags,
  clampCaption,
} from "./posting-caption.js";
import type {
  DroidDetection,
  DroidPublisher,
  DroidPublishInput,
  DroidPublishResult,
} from "./posting-droid.js";
import { PostingRunner, type PostingHost } from "./posting-runner.js";
import {
  DEFAULT_SCHEDULE,
  LIVE_MIN_INTERVAL_MINUTES,
  LIVE_MAX_POSTS_PER_DAY,
  effectiveIntervalMinutes,
  inWindow,
  localDayKey,
  nextSlot,
  normalizeSchedule,
  postBlockReason,
  upcomingSlots,
  zonedParts,
  zonedToUtc,
  type PostingSchedule,
} from "./posting-schedule.js";
import { PostingStore, QUEUE_TRANSITIONS } from "./posting-store.js";
import { getContentStudio, resetContentStudios, type ContentStudio } from "./studio.js";

const MIN = 60_000;
const HOUR = 3_600_000;

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-post-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  resetContentStudios();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const sched = (over: Partial<PostingSchedule> = {}): PostingSchedule => ({
  ...DEFAULT_SCHEDULE,
  jitterMinutes: 0,
  ...over,
});

/** Local wall time → UTC ms. */
const at = (tz: string, y: number, mo: number, d: number, hh: number, mm = 0) =>
  zonedToUtc(y, mo, d, hh * 60 + mm, tz);

const localHm = (ms: number, tz: string) => {
  const p = zonedParts(ms, tz);
  return `${String(p.h).padStart(2, "0")}:${String(p.mi).padStart(2, "0")}`;
};

// ── Scheduler math ─────────────────────────────────────────────────────────

describe("posting schedule", () => {
  it("round-trips local wall time in a DST timezone", () => {
    const tz = "America/New_York";
    // Winter (EST, UTC-5) and summer (EDT, UTC-4).
    expect(new Date(at(tz, 2026, 1, 15, 9)).toISOString()).toBe("2026-01-15T14:00:00.000Z");
    expect(new Date(at(tz, 2026, 7, 15, 9)).toISOString()).toBe("2026-07-15T13:00:00.000Z");
    expect(localHm(at(tz, 2026, 3, 8, 12), tz)).toBe("12:00"); // DST change day
  });

  it("interval mode: first post now when inside the window, then every N", () => {
    const tz = "Europe/London";
    const s = sched({ mode: "interval", everyMinutes: 180, timezone: tz, dailyCap: 10 });
    const now = at(tz, 2026, 10, 6, 10, 30);
    expect(nextSlot({ schedule: s, now, lastPostAt: null, postedAts: [], seed: "a" }).at).toBe(now);
    const last = at(tz, 2026, 10, 6, 10, 0);
    const slot = nextSlot({ schedule: s, now, lastPostAt: last, postedAts: [last], seed: "a" });
    expect(slot.at).toBe(last + 180 * MIN);
    expect(slot.reason).toBe("min-interval");
  });

  it("before the window waits for it to open; after it rolls to the next day", () => {
    const tz = "Asia/Bangkok";
    const s = sched({
      mode: "interval",
      everyMinutes: 120,
      windowStart: "09:00",
      windowEnd: "21:00",
      timezone: tz,
    });
    const early = nextSlot({
      schedule: s,
      now: at(tz, 2026, 10, 6, 6, 15),
      lastPostAt: null,
      postedAts: [],
      seed: "x",
    });
    expect(early.at).toBe(at(tz, 2026, 10, 6, 9, 0));
    expect(early.reason).toBe("window-open");
    const late = nextSlot({
      schedule: s,
      now: at(tz, 2026, 10, 6, 22, 0),
      lastPostAt: null,
      postedAts: [],
      seed: "x",
    });
    expect(late.at).toBe(at(tz, 2026, 10, 7, 9, 0));
  });

  it("supports windows that wrap midnight", () => {
    const tz = "UTC";
    const s = sched({
      mode: "interval",
      everyMinutes: 60,
      windowStart: "22:00",
      windowEnd: "02:00",
      timezone: tz,
    });
    expect(inWindow(at(tz, 2026, 10, 6, 23, 30), s)).toBe(true);
    expect(inWindow(at(tz, 2026, 10, 7, 1, 30), s)).toBe(true);
    expect(inWindow(at(tz, 2026, 10, 7, 12, 0), s)).toBe(false);
    const slot = nextSlot({
      schedule: s,
      now: at(tz, 2026, 10, 7, 1, 30),
      lastPostAt: null,
      postedAts: [],
      seed: "w",
    });
    expect(slot.at).toBe(at(tz, 2026, 10, 7, 1, 30));
    const after = nextSlot({
      schedule: s,
      now: at(tz, 2026, 10, 7, 3, 0),
      lastPostAt: null,
      postedAts: [],
      seed: "w",
    });
    expect(after.at).toBe(at(tz, 2026, 10, 7, 22, 0));
  });

  it("daily mode spreads X posts evenly across the window", () => {
    const tz = "America/Los_Angeles";
    const s = sched({
      mode: "daily",
      postsPerDay: 3,
      dailyCap: 3,
      windowStart: "09:00",
      windowEnd: "21:00",
      timezone: tz,
    });
    expect(effectiveIntervalMinutes(s)).toBe(240);
    const slots = upcomingSlots(
      { schedule: s, now: at(tz, 2026, 10, 6, 8, 0), lastPostAt: null, postedAts: [] },
      ["a", "b", "c", "d"],
    ).map((x) => `${localDayKey(x.at, tz)} ${localHm(x.at, tz)}`);
    expect(slots).toEqual([
      "2026-10-06 09:00",
      "2026-10-06 13:00",
      "2026-10-06 17:00",
      "2026-10-07 09:00",
    ]);
  });

  it("enforces the daily cap in the page's timezone", () => {
    const tz = "Asia/Tokyo";
    const s = sched({
      mode: "interval",
      everyMinutes: 60,
      dailyCap: 2,
      windowStart: "00:00",
      windowEnd: "00:00",
      timezone: tz,
    });
    const p1 = at(tz, 2026, 10, 6, 10);
    const p2 = at(tz, 2026, 10, 6, 11);
    const now = at(tz, 2026, 10, 6, 13);
    const slot = nextSlot({ schedule: s, now, lastPostAt: p2, postedAts: [p1, p2], seed: "c" });
    expect(slot.reason).toBe("daily-cap");
    expect(localDayKey(slot.at, tz)).toBe("2026-10-07");
    expect(localHm(slot.at, tz)).toBe("00:00");
    expect(postBlockReason({ schedule: s, now, lastPostAt: p2, postedAts: [p1, p2] })).toMatch(
      /daily cap/,
    );
  });

  it("jitter stays within ±M, is deterministic per seed, and never breaks min interval or window", () => {
    const tz = "UTC";
    const s = sched({
      mode: "interval",
      everyMinutes: 120,
      jitterMinutes: 20,
      windowStart: "09:00",
      windowEnd: "21:00",
      timezone: tz,
      dailyCap: 10,
    });
    const last = at(tz, 2026, 10, 6, 10, 0);
    const now = at(tz, 2026, 10, 6, 10, 5);
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const slot = nextSlot({
        schedule: s,
        now,
        lastPostAt: last,
        postedAts: [last],
        seed: `e${i}`,
      });
      expect(slot.at).toBeGreaterThanOrEqual(last + 120 * MIN); // never before min interval
      expect(slot.at).toBeLessThanOrEqual(last + 140 * MIN);
      expect((slot.at - last) % MIN).toBe(0);
      seen.add(slot.at);
    }
    expect(seen.size).toBeGreaterThan(5);
    const a = nextSlot({ schedule: s, now, lastPostAt: last, postedAts: [last], seed: "same" }).at;
    const b = nextSlot({ schedule: s, now, lastPostAt: last, postedAts: [last], seed: "same" }).at;
    expect(a).toBe(b);
    // Clamped to the window close.
    const endLast = at(tz, 2026, 10, 6, 18, 55);
    const near = nextSlot({
      schedule: { ...s, everyMinutes: 120 },
      now: endLast,
      lastPostAt: endLast,
      postedAts: [endLast],
      seed: "z",
    });
    expect(near.at === at(tz, 2026, 10, 7, 9, 0) || near.at <= at(tz, 2026, 10, 6, 20, 59)).toBe(
      true,
    );
  });

  it("floors live posting at the platform minimum and caps per day; dry run may go faster", () => {
    const live = normalizeSchedule(
      { mode: "interval", everyMinutes: 2, dailyCap: 500 },
      DEFAULT_SCHEDULE,
      false,
    );
    expect(live.everyMinutes).toBe(LIVE_MIN_INTERVAL_MINUTES);
    expect(live.dailyCap).toBe(LIVE_MAX_POSTS_PER_DAY);
    const dry = normalizeSchedule({ mode: "interval", everyMinutes: 2 }, DEFAULT_SCHEDULE, true);
    expect(dry.everyMinutes).toBe(2);
    expect(normalizeSchedule({ timezone: "Not/AZone" }).timezone).toBe("UTC");
    expect(normalizeSchedule({ windowStart: "25:00" }).windowStart).toBe("09:00");
  });
});

// ── Caption templates ──────────────────────────────────────────────────────

describe("caption template", () => {
  it("renders every variable and drops lines whose variables are all empty", () => {
    const r = renderCaption(
      "{hook}\n\n{title} — {series} ep {episode}\n{cta}\n\n{hashtags}\nPosted {date} by {handle} on {page}",
      {
        title: "3x reach",
        hook: "Stop scrolling.",
        series: "Growth Diaries",
        episode: 4,
        cta: "",
        hashtags: ["growth", "#Reels", "growth"],
        date: Date.UTC(2026, 9, 6, 12),
        timezone: "UTC",
        handle: "@brand.co",
        page: "Brand",
      },
    );
    expect(r.text).toBe(
      "Stop scrolling.\n\n3x reach — Growth Diaries ep 4\n\n#growth #Reels\nPosted Oct 6, 2026 by @brand.co on Brand",
    );
    expect(r.hashtagCount).toBe(2);
    expect(r.warnings).toEqual([]);
  });

  it("keeps unknown variables visible and warns; {{ }} escapes braces", () => {
    const r = renderCaption("{titel} {{literal}}", { title: "x" });
    expect(r.text).toBe("{titel} {literal}");
    expect(r.unknownVariables).toEqual(["titel"]);
    expect(r.warnings.join(" ")).toMatch(/unknown variables/);
  });

  it("normalizes, merges and clamps hashtags to the platform limit", () => {
    expect(normalizeHashtags("#a, b  #c #a")).toEqual(["#a", "#b", "#c"]);
    expect(mergeHashtags(["x"], "#y x")).toEqual(["#x", "#y"]);
    const many = Array.from({ length: 35 }, (_, i) => `#t${i}`).join(" ");
    const r = renderCaption("{hashtags}", { hashtags: many });
    expect(r.warnings.join(" ")).toMatch(/35 hashtags/);
    expect((clampCaption(r.text).match(/#/g) ?? []).length).toBe(30);
    expect(clampCaption("a".repeat(3000)).length).toBe(2200);
  });
});

// ── Store + state machine ──────────────────────────────────────────────────

const MP4 = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from("ftypmp42"),
  Buffer.alloc(0x18 - 12),
  Buffer.alloc(64, 1),
]);

async function video(studio: ContentStudio, name: string) {
  const m = await studio.media.saveBuffer({
    buffer: MP4,
    filename: `${name}.mp4`,
    contentType: "video/mp4",
    source: "upload",
    caption: name,
  });
  expect(m.kind).toBe("video");
  return m.id;
}

describe("posting queue state machine", () => {
  let studio: ContentStudio;
  let store: PostingStore;
  beforeEach(() => {
    studio = getContentStudio(tmp());
    store = new PostingStore(studio.store.db);
  });

  it("enqueues in order, reorders densely and refuses illegal transitions", async () => {
    const a = store.enqueue("pg", { mediaId: await video(studio, "a"), title: "A" });
    const b = store.enqueue("pg", { mediaId: await video(studio, "b"), title: "B" });
    const c = store.enqueue("pg", { mediaId: await video(studio, "c"), title: "C", index: 0 });
    expect(store.listQueue("pg").map((e) => e.title)).toEqual(["C", "A", "B"]);
    store.reorder("pg", [b.id, a.id]);
    expect(store.listQueue("pg").map((e) => [e.title, e.position])).toEqual([
      ["B", 0],
      ["A", 1],
      ["C", 2],
    ]);

    store.transition(a.id, "scheduled", { scheduledAt: 1 });
    store.transition(a.id, "posting");
    store.transition(a.id, "posted", { postedAt: 2 });
    expect(() => store.transition(a.id, "queued")).toThrow(/cannot move a posted entry to queued/);
    expect(() => store.transition(c.id, "posted")).toThrow(/cannot move a queued entry to posted/);
    expect(QUEUE_TRANSITIONS.posted).toEqual([]);
    expect(() => store.enqueue("pg", { mediaId: "x", platform: "myspace" })).toThrow(/platform/);
  });

  it("persists the Trial reel flag (Instagram only), editable while pending", async () => {
    const dir = tmp();
    const s1 = getContentStudio(dir);
    const st = new PostingStore(s1.store.db);
    const ig = st.enqueue("pg", { mediaId: await video(s1, "t"), title: "T", trialReel: true });
    const tt = st.enqueue("pg", {
      mediaId: await video(s1, "u"),
      title: "U",
      platform: "tiktok",
      trialReel: true,
    });
    const plain = st.enqueue("pg", { mediaId: await video(s1, "v"), title: "V" });
    expect([ig.trialReel, tt.trialReel, plain.trialReel]).toEqual([true, false, false]);
    expect(st.history("pg").some((h) => /\(trial reel\)/.test(h.message))).toBe(true);
    // Survives a reopen from disk.
    resetContentStudios();
    const s2 = getContentStudio(dir);
    const st2 = new PostingStore(s2.store.db);
    expect(st2.getEntry(ig.id)!.trialReel).toBe(true);
    expect(st2.getEntry(plain.id)!.trialReel).toBe(false);
    // Editable while pending; other fields untouched; TikTok stays off.
    expect(st2.updateEntry(ig.id, { trialReel: false })).toMatchObject({
      trialReel: false,
      title: "T",
    });
    expect(st2.updateEntry(plain.id, { trialReel: true }).trialReel).toBe(true);
    expect(st2.updateEntry(plain.id, { title: "V2" }).trialReel).toBe(true); // kept when not patched
    expect(st2.updateEntry(tt.id, { trialReel: true }).trialReel).toBe(false);
    expect(st2.history("pg").filter((h) => h.event === "trial_reel")).toHaveLength(2);
    // A failed entry can be edited (retry without trial); a posting one cannot.
    st2.transition(plain.id, "posting");
    expect(() => st2.updateEntry(plain.id, { trialReel: false })).toThrow(/posting/);
    st2.transition(plain.id, "failed", { lastError: "trial_unavailable: …" });
    expect(st2.updateEntry(plain.id, { trialReel: false }).trialReel).toBe(false);
  });

  it("re-binding a page switches auto-posting off and enabling requires a binding", () => {
    expect(() => store.updateConfig("pg", { enabled: true })).toThrow(/bind a device/);
    store.updateConfig("pg", {
      deviceId: "d1",
      bindings: [{ platform: "instagram", handle: "@Brand.Co" }],
      enabled: true,
    });
    expect(store.getConfig("pg").bindings[0]!.handle).toBe("brand.co");
    expect(store.getConfig("pg").enabled).toBe(true);
    const res = store.updateConfig("pg", {
      bindings: [{ platform: "instagram", handle: "other" }],
    });
    expect(res.bindingChanged).toBe(true);
    expect(res.config.enabled).toBe(false);
    // Defaults are the safe ones.
    expect(store.getConfig("fresh").requireApproval).toBe(true);
    expect(store.getConfig("fresh").dryRun).toBe(true);
  });
});

// ── Runner (scheduler → Droid Swarm) ───────────────────────────────────────

type FakeDroid = DroidPublisher & {
  calls: DroidPublishInput[];
  detects: string[];
  active: string;
  online: boolean;
  /** sessionHealth the phone reports on the next detection. */
  health: "ok" | "logged_out" | "challenge" | "app_missing" | "error";
  /** Cached detection the device list carries (null = never detected). */
  cached: DroidDetection | null;
  /** The phone's Instagram has no Trial reel switch. */
  noTrial?: boolean;
};

function fakeDroid(active = "brand.co"): FakeDroid {
  const detection = (): DroidDetection => ({
    platform: "instagram",
    deviceId: "dev1",
    sessionHealth: d.health,
    loggedIn: d.health === "ok",
    activeHandle: d.health === "ok" ? d.active : null,
    accounts: d.health === "ok" ? [d.active] : [],
    postCount: 1,
    switcherSupported: true,
    detectedAt: Date.now(),
    error: d.health === "ok" ? null : `phone says ${d.health}`,
    challenge: d.health === "challenge" ? "Allow app access?" : null,
  });
  const d: FakeDroid = {
    calls: [],
    detects: [],
    active,
    online: true,
    health: "ok",
    cached: null,
    available: () => true,
    devices: async () => ({
      ok: true,
      status: "ok",
      devices: [
        {
          id: "dev1",
          label: "Phone 01",
          model: null,
          status: d.online ? "online" : "offline",
          adbState: d.online ? "device" : "absent",
          online: d.online,
          lastHeartbeatAt: null,
          presence: {
            connection: d.online ? "connected" : "not_connected",
            online: d.online,
            adbState: d.online ? "device" : "absent",
            lastSeenAt: null,
            heartbeatAgeMs: null,
            checkedAt: 0,
            summary: d.online ? "Connected over USB" : "Not connected — last seen 3 days ago",
            fix: d.online ? [] : ["Plug the phone in by USB and unlock it."],
            screen: null,
          },
          accounts: [],
          detected: d.cached ? { instagram: d.cached } : {},
        },
      ],
    }),
    detect: async (input) => {
      d.detects.push(input.platform);
      if (!d.online)
        return {
          ok: false,
          status: "offline",
          reason: "Phone 01 is offline",
          detection: null,
          steps: [],
        };
      const det = detection();
      d.cached = det;
      return {
        ok: det.sessionHealth === "ok",
        status: "ok",
        reason: det.error,
        detection: det,
        steps: [],
      };
    },
    publish: async (input): Promise<DroidPublishResult> => {
      d.calls.push(input);
      const common = {
        dryRun: input.dryRun,
        switched: false,
        postUrl: null,
        warnings: [],
        steps: [],
      };
      if (!d.online)
        return {
          ...common,
          ok: false,
          status: "offline",
          retryable: true,
          reason: "offline",
          activeHandle: null,
          postRef: null,
        };
      if (input.trialReel && d.noTrial)
        return {
          ...common,
          ok: false,
          status: "trial_unavailable",
          retryable: false,
          reason: "the Trial reel switch was not found on the share screen — nothing was posted",
          activeHandle: input.handle,
          postRef: null,
        };
      if (d.active !== input.handle) {
        return {
          ...common,
          ok: false,
          status: "wrong_account",
          retryable: false,
          reason: `wrong account: @${d.active}`,
          activeHandle: d.active,
          postRef: null,
        };
      }
      return {
        ...common,
        ok: true,
        status: input.dryRun ? "dry_run_complete" : "posted",
        retryable: false,
        reason: null,
        activeHandle: d.active,
        postRef: "posts:1",
      };
    },
  };
  return d;
}

function fakeApprovals() {
  const recs = new Map<
    string,
    { id: string; status: "pending" | "approved" | "denied" | "redirected"; decidedBy?: string }
  >();
  let n = 0;
  return {
    recs,
    create: (input: { title: string }) => {
      const rec = { id: `ap${++n}`, status: "pending" as const, title: input.title };
      recs.set(rec.id, rec);
      return rec;
    },
    get: (id: string) => recs.get(id) ?? null,
  };
}

describe("posting runner", () => {
  let dir: string;
  let studio: ContentStudio;
  let clock: number;
  let droid: FakeDroid;
  let alerts: Array<{ title: string; body: string }>;
  let approvals: ReturnType<typeof fakeApprovals>;
  const tz = "UTC";

  function makeRunner(s = studio) {
    const host: PostingHost = {
      approvals,
      alertOwner: (a) => {
        alerts.push(a);
      },
    };
    return new PostingRunner({
      studio: s,
      posting: new PostingStore(s.store.db, () => clock),
      droid,
      host,
      page: (id) => (id === "pg" ? { id, name: "Brand" } : null),
      now: () => clock,
    });
  }

  beforeEach(() => {
    dir = tmp();
    studio = getContentStudio(dir);
    clock = at(tz, 2026, 10, 6, 10, 0);
    droid = fakeDroid();
    alerts = [];
    approvals = fakeApprovals();
  });

  async function setup(
    runner: PostingRunner,
    opts: { requireApproval?: boolean; everyMinutes?: number } = {},
  ) {
    runner.posting.updateConfig("pg", {
      deviceId: "dev1",
      deviceLabel: "Phone 01",
      bindings: [{ platform: "instagram", handle: "brand.co" }],
      schedule: {
        mode: "interval",
        everyMinutes: opts.everyMinutes ?? 2,
        jitterMinutes: 0,
        windowStart: "00:00",
        windowEnd: "00:00",
        timezone: tz,
        dailyCap: 50,
      },
      requireApproval: opts.requireApproval ?? false,
      dryRun: true,
      template: "{hook}\n{title}\n{hashtags}",
      defaultHashtags: ["brand"],
      enabled: true,
    });
    const ids = [];
    for (const t of ["One", "Two", "Three"]) {
      ids.push(
        runner.posting.enqueue("pg", {
          mediaId: await video(studio, t),
          title: t,
          hook: `${t} hook`,
        }).id,
      );
    }
    return ids;
  }

  /** Tick repeatedly, advancing the fake clock. */
  async function run(runner: PostingRunner, minutes: number) {
    for (let i = 0; i < minutes * 4; i++) {
      await runner.tick();
      clock += 15_000;
    }
  }

  it("posts the queue in order, spaced by the interval, through the full droid hand-off", async () => {
    const runner = makeRunner();
    await setup(runner);
    await run(runner, 7);
    expect(droid.calls.map((c) => c.caption.split("\n")[1])).toEqual(["One", "Two", "Three"]);
    expect(droid.calls[0]!.caption).toBe("One hook\nOne\n#brand");
    expect(
      droid.calls.every((c) => c.dryRun && c.deviceId === "dev1" && c.handle === "brand.co"),
    ).toBe(true);
    expect(droid.calls.every((c) => fs.existsSync(c.videoPath))).toBe(true);
    const q = runner.posting.listQueue("pg");
    expect(q.map((e) => e.status)).toEqual(["posted", "posted", "posted"]);
    expect(q.every((e) => e.dryRun === true)).toBe(true);
    const times = q.map((e) => e.postedAt!);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(2 * MIN - 1000);
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(2 * MIN - 1000);
    expect(runner.posting.history("pg").some((h) => h.event === "dry_run")).toBe(true);
  });

  it("refuses the wrong account: no retry, entry failed, owner alerted", async () => {
    droid.active = "someone.else";
    const runner = makeRunner();
    const [first] = await setup(runner);
    await run(runner, 3);
    // The fresh on-phone detection already shows the wrong account, so the
    // publisher is never even asked; nothing is retried and the page stops.
    expect(droid.calls).toHaveLength(0);
    expect(droid.detects).toEqual(["instagram"]);
    expect(runner.posting.getConfig("pg").enabled).toBe(false);
    const e = runner.posting.getEntry(first!)!;
    expect(e.status).toBe("failed");
    expect(e.lastError).toMatch(
      /not verified: @brand\.co is not logged in on the phone \(found @someone\.else\)/,
    );
    expect(alerts[0]!.title).toMatch(/wrong account/);
    expect(runner.posting.history("pg").some((h) => h.event === "wrong_account")).toBe(true);
    expect(runner.posting.getConfig("pg").bindings[0]!.verification).toBe("mismatch");
  });

  it("the phone's own wrong-account refusal still stops the page (stale cache)", async () => {
    const runner = makeRunner();
    const [first] = await setup(runner);
    // A fresh, healthy cached detection says @brand.co; the phone then
    // switched under us — the publisher's on-screen check refuses.
    droid.cached = {
      ...(await droid.detect({ deviceId: "dev1", platform: "instagram", actor: "t" })).detection!,
      detectedAt: clock,
    };
    droid.detects = [];
    droid.active = "someone.else";
    await run(runner, 3);
    expect(droid.detects).toEqual([]); // cache was fresh
    expect(droid.calls).toHaveLength(1);
    expect(runner.posting.getEntry(first!)!.lastError).toMatch(/wrong account/);
    expect(runner.posting.getConfig("pg").enabled).toBe(false);
  });

  it("an offline phone defers the post with how to fix it — no attempt counted, no publish", async () => {
    droid.online = false;
    const runner = makeRunner();
    const [first] = await setup(runner);
    await run(runner, 3);
    expect(droid.calls).toHaveLength(0);
    expect(droid.detects).toHaveLength(0);
    const e = runner.posting.getEntry(first!)!;
    expect(e.status).toBe("scheduled");
    expect(e.attempts).toBe(0);
    expect(e.lastError).toMatch(
      /Phone 01 is offline — Not connected — last seen 3 days ago\. Fix: Plug the phone in/,
    );
    expect(e.scheduledAt! - clock).toBeGreaterThan(5 * MIN);
    // one history line, not one per tick
    expect(runner.posting.history("pg").filter((h) => h.event === "deferred")).toHaveLength(1);
    expect(runner.posting.getConfig("pg").enabled).toBe(true);
    // back online → posts
    droid.online = true;
    clock += 11 * MIN;
    await run(runner, 1);
    expect(droid.calls).toHaveLength(1);
  });

  for (const [health, kind] of [
    ["logged_out", /logged out on the phone/],
    ["challenge", /security checkpoint is on the phone \(“Allow app access\?”\)/],
    ["app_missing", /not installed on the phone/],
  ] as const) {
    it(`refuses before posting when the phone reports ${health}, and stops the page`, async () => {
      droid.health = health;
      const runner = makeRunner();
      const [first] = await setup(runner);
      await run(runner, 2);
      expect(droid.calls).toHaveLength(0);
      const e = runner.posting.getEntry(first!)!;
      expect(e.status).toBe("failed");
      expect(e.lastError).toMatch(kind);
      expect(runner.posting.getConfig("pg").enabled).toBe(false);
      expect(runner.posting.getConfig("pg").bindings[0]!.verification).toBe(health);
    });
  }

  it("post now refuses offline / unverified with a clear reason and leaves the entry alone", async () => {
    const runner = makeRunner();
    const [a] = await setup(runner);
    runner.posting.updateConfig("pg", { enabled: false });
    droid.online = false;
    let r = await runner.postNow(a!);
    expect(r.reason).toMatch(/offline/);
    expect(runner.posting.getEntry(a!)!.status).toBe("queued");
    droid.online = true;
    droid.health = "challenge";
    r = await runner.postNow(a!);
    expect(r.reason).toMatch(/not verified: a security checkpoint/);
    expect(runner.posting.getEntry(a!)!.status).toBe("queued");
    expect(droid.calls).toHaveLength(0);
  });

  it("re-detects only when the cached detection is stale (30 min)", async () => {
    const runner = makeRunner();
    await setup(runner, { everyMinutes: 2 });
    await run(runner, 1);
    expect(droid.detects).toHaveLength(1);
    droid.cached!.detectedAt = clock; // fresh
    await run(runner, 3);
    expect(droid.calls.length).toBeGreaterThanOrEqual(2);
    expect(droid.detects).toHaveLength(1);
    droid.cached!.detectedAt = clock - 31 * MIN; // stale
    await run(runner, 3);
    expect(droid.detects).toHaveLength(2);
  });

  it("approval mode waits for the owner, then posts; a denial fails the entry", async () => {
    const runner = makeRunner();
    const [first, second] = await setup(runner, { requireApproval: true });
    await run(runner, 5);
    expect(droid.calls).toHaveLength(0);
    expect(runner.posting.getEntry(first!)!.status).toBe("awaiting_approval");
    expect(approvals.recs.size).toBe(1); // only the head asks; nothing else jumps the queue
    const ap = runner.posting.getEntry(first!)!.approvalId!;
    approvals.recs.get(ap)!.status = "approved";
    await run(runner, 1);
    expect(droid.calls).toHaveLength(1);
    expect(droid.calls[0]!.authorization).toMatch(new RegExp(`^approval:${ap}`));
    expect(runner.posting.getEntry(first!)!.status).toBe("posted");
    await run(runner, 3);
    const ap2 = runner.posting.getEntry(second!)!.approvalId!;
    expect(runner.posting.getEntry(second!)!.status).toBe("awaiting_approval");
    approvals.recs.get(ap2)!.status = "denied";
    await run(runner, 1);
    expect(runner.posting.getEntry(second!)!.status).toBe("failed");
    expect(droid.calls).toHaveLength(1);
  });

  it("retries retryable failures with backoff and gives up after maxAttempts", async () => {
    const runner = makeRunner();
    const [first] = await setup(runner);
    let n = 0;
    droid.publish = async (input) => {
      n++;
      droid.calls.push(input);
      return {
        ok: false,
        status: "failed",
        retryable: true,
        reason: "composer did not appear",
        dryRun: true,
        activeHandle: "brand.co",
        switched: false,
        postUrl: null,
        postRef: null,
        warnings: [],
        steps: [],
      };
    };
    await run(runner, 0.25); // one tick: slot + first attempt (a due slot posts on the tick that sets it)
    let e = runner.posting.getEntry(first!)!;
    expect(e.status).toBe("scheduled");
    expect(e.attempts).toBe(1);
    expect(e.scheduledAt! - clock).toBeGreaterThan(0);
    await run(runner, 5);
    e = runner.posting.getEntry(first!)!;
    expect(
      droid.calls.filter((c) => c.requestId.startsWith(first!)).map((c) => c.requestId),
    ).toEqual([`${first}-a1`, `${first}-a2`, `${first}-a3`]);
    expect(n).toBeGreaterThanOrEqual(3);
    expect(e.status).toBe("failed");
    expect(e.attempts).toBe(3);
    expect(alerts[0]!.body).toMatch(/"One"/);
    // A plain failure does not stop the page (only wrong account / logout / checkpoint do).
    expect(runner.posting.getConfig("pg").enabled).toBe(true);
  });

  it("passes trialReel to Droid Swarm; a missing Trial switch fails the entry (no silent regular reel), retry without trial posts", async () => {
    droid.noTrial = true;
    const runner = makeRunner();
    const [first, second] = await setup(runner);
    runner.posting.updateEntry(first!, { trialReel: true });
    await run(runner, 1);
    expect(droid.calls[0]!.caption).toContain("One");
    expect(droid.calls[0]!.trialReel).toBe(true);
    expect(droid.calls.filter((c) => c.caption.includes("One"))).toHaveLength(1);
    const failed = runner.posting.getEntry(first!)!;
    expect(failed.status).toBe("failed");
    expect(failed.attempts).toBe(1); // not retried on its own
    expect(failed.lastError).toMatch(
      /^trial_unavailable: .*nothing was posted.*Turn off "Trial reel"/,
    );
    expect(alerts[0]!.title).toMatch(/Trial reel unavailable/);
    expect(runner.posting.history("pg").some((h) => h.event === "trial_unavailable")).toBe(true);
    // A missing option is not a phone/account problem: the page keeps posting.
    expect(runner.posting.getConfig("pg").enabled).toBe(true);
    await run(runner, 3);
    expect(runner.posting.getEntry(second!)!.status).toBe("posted");
    expect(droid.calls.find((c) => c.caption.includes("Two"))!.trialReel).toBe(false);
    // Owner turns trial off and retries: posted as a regular reel.
    runner.posting.updateEntry(first!, { trialReel: false });
    runner.posting.transition(first!, "queued", {
      attempts: 0,
      lastError: null,
      scheduledAt: null,
    });
    await run(runner, 8);
    expect(runner.posting.getEntry(first!)!.status).toBe("posted");
    expect(droid.calls.filter((c) => c.caption.includes("One")).map((c) => c.trialReel)).toEqual([
      true,
      false,
    ]);
  });

  it("survives a restart: the queue persists and an interrupted post is failed, not re-posted", async () => {
    const runner = makeRunner();
    const [first, second] = await setup(runner);
    runner.posting.transition(first!, "scheduled", { scheduledAt: clock });
    runner.posting.transition(first!, "posting", { attempts: 1 });
    // "Crash": drop every cached store, reopen from disk.
    resetContentStudios();
    const reopened = getContentStudio(dir);
    const runner2 = makeRunner(reopened);
    expect(runner2.posting.listQueue("pg").map((e) => e.title)).toEqual(["One", "Two", "Three"]);
    expect(runner2.posting.getConfig("pg").enabled).toBe(true);
    expect(runner2.recoverAfterRestart()).toBe(1);
    expect(runner2.posting.getEntry(first!)!.status).toBe("failed");
    expect(runner2.posting.getEntry(first!)!.lastError).toMatch(/restart/);
    studio = reopened;
    await run(runner2, 3);
    expect(droid.calls.map((c) => c.caption.split("\n")[1])).toEqual(["Two", "Three"]);
    expect(runner2.posting.getEntry(second!)!.status).toBe("posted");
  });

  it("pause / skip / retry / remove", async () => {
    const runner = makeRunner();
    const [a, b, c] = await setup(runner);
    runner.posting.updateConfig("pg", { enabled: false });
    runner.posting.transition(a!, "paused");
    runner.posting.transition(b!, "skipped");
    runner.posting.updateConfig("pg", { enabled: true });
    await run(runner, 1);
    expect(droid.calls.map((x) => x.caption.split("\n")[1])).toEqual(["Three"]);
    runner.posting.transition(a!, "queued");
    await run(runner, 3);
    expect(droid.calls.map((x) => x.caption.split("\n")[1])).toEqual(["Three", "One"]);
    expect(runner.posting.remove(b!)).toEqual({ removed: b });
    expect(runner.posting.listQueue("pg").map((e) => e.position)).toEqual([0, 1]);
    expect(runner.posting.getEntry(c!)!.status).toBe("posted");
  });

  it("post now honours the min interval and the approval mode", async () => {
    const runner = makeRunner();
    const [a, b] = await setup(runner, { everyMinutes: 60 });
    runner.posting.updateConfig("pg", { enabled: false });
    expect((await runner.postNow(a!)).status).toBe("posted");
    const blocked = await runner.postNow(b!);
    expect(blocked.reason).toMatch(/min interval/);
    clock += 61 * MIN;
    runner.posting.updateConfig("pg", { requireApproval: true });
    const r = await runner.postNow(b!);
    expect(r.status).toBe("awaiting_approval");
    expect(droid.calls).toHaveLength(1);
  });

  it("previews the upcoming schedule", async () => {
    const runner = makeRunner();
    await setup(runner, { everyMinutes: 30 });
    const p = runner.preview("pg");
    expect(p.upcoming).toHaveLength(3);
    expect(p.upcoming[1]!.at - p.upcoming[0]!.at).toBe(30 * MIN);
    expect(p.next!.at).toBe(clock);
    void HOUR;
  });
});
