/**
 * Posting queue: designated times (honoured, tz, catch-up, held while
 * auto-posting is off, never blocked by a stuck head) and post-publish
 * verification (verifying → verified | unverified, permalink, evidence).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DroidDetection,
  DroidPublisher,
  DroidPublishInput,
  DroidPublishResult,
  DroidVerifyInput,
  DroidVerifyResult,
} from "./posting-droid.js";
import { captionKey, normalizeCaption } from "./posting-match.js";
import * as ops from "./posting-ops.js";
import {
  HELD_AUTO_OFF,
  PostingRunner,
  VERIFY_FIRST_DELAY_MS,
  VERIFY_MAX_ATTEMPTS,
  type RecentMedia,
} from "./posting-runner.js";
import {
  DEFAULT_SCHEDULE,
  designatedSlot,
  zonedToUtc,
  zonedParts,
  type PostingSchedule,
} from "./posting-schedule.js";
import { PostingStore } from "./posting-store.js";
import { getContentStudio, resetContentStudios, type ContentStudio } from "./studio.js";

const MIN = 60_000;
const HOUR = 3_600_000;

const tmpDirs: string[] = [];
afterEach(() => {
  resetContentStudios();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const at = (tz: string, y: number, mo: number, d: number, hh: number, mm = 0) =>
  zonedToUtc(y, mo, d, hh * 60 + mm, tz);

const sched = (over: Partial<PostingSchedule> = {}): PostingSchedule => ({
  ...DEFAULT_SCHEDULE,
  jitterMinutes: 0,
  ...over,
});

// ── Pure slot math ──────────────────────────────────────────────────────────

describe("designated slot math", () => {
  const tz = "Asia/Bangkok";
  const s = sched({
    mode: "interval",
    everyMinutes: 60,
    windowStart: "06:00",
    windowEnd: "21:00",
    timezone: tz,
    dailyCap: 10,
  });

  it("honours the exact designated time — no window, grid or jitter", () => {
    const now = at(tz, 2026, 10, 9, 19, 0);
    // 23:30 local is outside the 06–21 window: still honoured (the owner chose it).
    const want = at(tz, 2026, 10, 9, 23, 30);
    const slot = designatedSlot({
      schedule: { ...s, jitterMinutes: 30 },
      now,
      lastPostAt: null,
      postedAts: [],
      designatedAt: want,
    });
    expect(slot.at).toBe(want);
    expect(slot.reason).toBe("designated");
    expect(slot.lateByMs).toBe(0);
    const p = zonedParts(slot.at, tz);
    expect([p.h, p.mi]).toEqual([23, 30]);
  });

  it("is timezone-correct: 19:30 Bangkok is 12:30Z", () => {
    const want = at(tz, 2026, 10, 9, 19, 30);
    expect(new Date(want).toISOString()).toBe("2026-10-09T12:30:00.000Z");
    const slot = designatedSlot({
      schedule: s,
      now: want - 10 * MIN,
      lastPostAt: null,
      postedAts: [],
      designatedAt: want,
    });
    expect(new Date(slot.at).toISOString()).toBe("2026-10-09T12:30:00.000Z");
  });

  it("a missed time (downtime) is a catch-up: posts now and reports how late", () => {
    const want = at(tz, 2026, 10, 9, 9, 0);
    const now = want + 95 * MIN;
    const slot = designatedSlot({
      schedule: s,
      now,
      lastPostAt: null,
      postedAts: [],
      designatedAt: want,
    });
    expect(slot.at).toBe(now);
    expect(slot.reason).toBe("catch-up");
    expect(slot.lateByMs).toBe(95 * MIN);
  });

  it("only the hard limits push it: min interval after the last post, daily cap", () => {
    const want = at(tz, 2026, 10, 9, 12, 0);
    const last = want - 10 * MIN;
    const pushed = designatedSlot({
      schedule: s,
      now: want - HOUR,
      lastPostAt: last,
      postedAts: [last],
      designatedAt: want,
    });
    expect(pushed.at).toBe(last + 60 * MIN);
    expect(pushed.reason).toBe("min-interval");
    const full = Array.from({ length: 10 }, (_, i) => at(tz, 2026, 10, 9, 1 + i, 0));
    const capped = designatedSlot({
      schedule: s,
      now: want - HOUR,
      lastPostAt: full[9]!,
      postedAts: full,
      designatedAt: at(tz, 2026, 10, 9, 18, 0),
    });
    expect(capped.reason).toBe("daily-cap");
    expect(zonedParts(capped.at, tz).d).toBe(10);
  });
});

describe("caption matching", () => {
  it("keys on the first real words, ignoring hashtags, mentions and punctuation", () => {
    expect(captionKey("#viral #fyp\nNobody tells you THIS about short-form… 🔥\nmore")).toBe(
      "nobody tells you this about",
    );
    expect(normalizeCaption("brand.co Nobody tells you this… more")).toBe(
      "brand co nobody tells you this more",
    );
    expect(captionKey("#a #b")).toBe("");
  });
});

// ── Runner ───────────────────────────────────────────────────────────────────

const MP4 = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from("ftypmp42"),
  Buffer.alloc(0x18 - 12),
  Buffer.from([0, 0, 0, 8]),
  Buffer.from("mdat"),
]);

type Fake = DroidPublisher & {
  calls: DroidPublishInput[];
  verifies: DroidVerifyInput[];
  online: boolean;
  publishStatus: DroidPublishResult["status"];
  /** Captions containing this fail retryably (a stuck head). */
  failFor: string | null;
  verifyResult: (input: DroidVerifyInput) => DroidVerifyResult;
};

function fakeDroid(): Fake {
  const det = (): DroidDetection => ({
    platform: "instagram",
    deviceId: "dev1",
    sessionHealth: "ok",
    loggedIn: true,
    activeHandle: "brand.co",
    accounts: ["brand.co"],
    postCount: 3,
    switcherSupported: true,
    detectedAt: Date.now(),
    error: null,
    challenge: null,
  });
  const f: Fake = {
    calls: [],
    verifies: [],
    online: true,
    publishStatus: "posted",
    failFor: null,
    verifyResult: (input) => ({
      ok: true,
      status: "verified",
      reason: null,
      permalink: "https://www.instagram.com/reel/DPx1AbCdEfG/",
      captionMatched: true,
      seenCaption: input.caption.split("\n")[0]!,
      activeHandle: "brand.co",
      steps: [
        { step: "open_newest_post", ok: true, at: 1 },
        { step: "caption_match", ok: true, at: 2 },
        {
          step: "read_permalink",
          ok: true,
          detail: "https://www.instagram.com/reel/DPx1AbCdEfG/",
          at: 3,
        },
      ],
      evidence: [
        {
          tag: "verify_post",
          screenshot: "/tmp/verify-post.png",
          foreground: null,
          visible: [],
          at: 3,
        },
      ],
    }),
    available: () => true,
    devices: async () => ({
      ok: true,
      status: "ok",
      devices: [
        {
          id: "dev1",
          label: "Phone 01",
          model: null,
          status: f.online ? "online" : "offline",
          adbState: f.online ? "device" : "absent",
          online: f.online,
          lastHeartbeatAt: null,
          presence: {
            connection: f.online ? "connected" : "not_connected",
            online: f.online,
            adbState: f.online ? "device" : "absent",
            lastSeenAt: null,
            heartbeatAgeMs: null,
            checkedAt: 0,
            summary: f.online ? "Connected" : "Not connected",
            fix: f.online ? [] : ["Plug the phone in."],
            screen: null,
          },
          accounts: [],
          detected: { instagram: det() },
        },
      ],
    }),
    detect: async () => ({ ok: true, status: "ok", reason: null, detection: det(), steps: [] }),
    publish: async (input) => {
      f.calls.push(input);
      const status = !f.online
        ? "offline"
        : f.failFor && input.caption.includes(f.failFor)
          ? "failed"
          : f.publishStatus;
      return {
        ok: status === "posted" || status === "dry_run_complete",
        status,
        retryable: status !== "posted",
        reason: status === "posted" ? null : status,
        dryRun: input.dryRun,
        activeHandle: "brand.co",
        switched: false,
        postUrl: null,
        postRef: "posts:4",
        warnings: [],
        steps: [],
      };
    },
    verifyPost: async (input) => {
      f.verifies.push(input);
      return f.verifyResult(input);
    },
  };
  return f;
}

describe("posting runner: designated times + verification", () => {
  const tz = "Asia/Bangkok";
  let studio: ContentStudio;
  let clock: number;
  let droid: Fake;
  let alerts: Array<{ title: string; body: string }>;
  let recent: RecentMedia[] | null;

  function makeRunner(opts: { api?: boolean } = {}) {
    return new PostingRunner({
      studio,
      posting: new PostingStore(studio.store.db, () => clock),
      droid,
      host: { alertOwner: (a) => void alerts.push(a) },
      page: (id) => (id === "pg" ? { id, name: "Brand" } : null),
      recentMedia: opts.api ? async () => recent : undefined,
      now: () => clock,
    });
  }

  async function video(name: string) {
    const m = await studio.media.saveBuffer({
      buffer: MP4,
      filename: `${name}.mp4`,
      contentType: "video/mp4",
      source: "upload",
      caption: name,
    });
    return m.id;
  }

  async function setup(
    runner: PostingRunner,
    over: { enabled?: boolean; dryRun?: boolean; everyMinutes?: number } = {},
  ) {
    runner.posting.updateConfig("pg", {
      deviceId: "dev1",
      deviceLabel: "Phone 01",
      bindings: [{ platform: "instagram", handle: "brand.co" }],
      schedule: {
        mode: "interval",
        everyMinutes: over.everyMinutes ?? 60,
        jitterMinutes: 0,
        windowStart: "06:00",
        windowEnd: "21:00",
        timezone: tz,
        dailyCap: 10,
      },
      requireApproval: false,
      dryRun: over.dryRun ?? false,
      template: "{hook}\n{title}\n{hashtags}",
      enabled: over.enabled ?? true,
    });
  }

  async function enqueue(runner: PostingRunner, title: string) {
    return runner.posting.enqueue("pg", {
      mediaId: await video(title),
      title,
      hook: `${title} hook line`,
    });
  }

  async function run(runner: PostingRunner, minutes: number) {
    for (let i = 0; i < minutes * 4; i++) {
      await runner.tick();
      clock += 15_000;
    }
  }

  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-post-sv-"));
    tmpDirs.push(dir);
    studio = getContentStudio(dir);
    clock = at(tz, 2026, 10, 9, 18, 0);
    droid = fakeDroid();
    alerts = [];
    recent = null;
  });

  it("posts a designated entry within a tick of its time, even out of queue order", async () => {
    const runner = makeRunner();
    await setup(runner);
    const a = await enqueue(runner, "Cadence");
    const b = await enqueue(runner, "Pinned");
    // Cadence head posts first (now); pinned is 19:30 local.
    const want = at(tz, 2026, 10, 9, 19, 30);
    runner.posting.setDesignatedAt(b.id, want);
    await run(runner, 100);
    const posted = runner.posting.getEntry(b.id)!;
    expect(posted.status).toBe("posted");
    expect(posted.postedAt! - want).toBeGreaterThanOrEqual(0);
    expect(posted.postedAt! - want).toBeLessThanOrEqual(15_000);
    expect(posted.lateByMs).toBeNull();
    expect(runner.posting.getEntry(a.id)!.status).toBe("posted");
  });

  it("a failed / backing-off head never blocks a due designated entry", async () => {
    const runner = makeRunner();
    await setup(runner);
    droid.failFor = "Broken";
    const head = await enqueue(runner, "Broken");
    const pinned = await enqueue(runner, "Pinned");
    const want = clock + 3 * MIN;
    runner.posting.setDesignatedAt(pinned.id, want);
    await run(runner, 0.25); // head attempt 1 fails → backoff (head stays first in the queue)
    expect(runner.posting.getEntry(head.id)!).toMatchObject({ status: "scheduled", attempts: 1 });
    await run(runner, 3.5);
    const p = runner.posting.getEntry(pinned.id)!;
    expect(p.status).toBe("posted");
    expect(p.postedAt! - want).toBeLessThanOrEqual(15_000);
    // …and a head that failed for good is skipped over entirely.
    expect(["scheduled", "failed"]).toContain(runner.posting.getEntry(head.id)!.status);
  });

  it("auto-posting off: nothing posts, the entry and preview say why; on re-enable it posts late with a note", async () => {
    const runner = makeRunner();
    await setup(runner, { enabled: false });
    const e = await enqueue(runner, "Pinned");
    runner.posting.setDesignatedAt(e.id, clock + 5 * MIN);
    expect(runner.preview("pg").held).toMatch(/Auto-posting is off/);
    await run(runner, 10);
    expect(droid.calls).toHaveLength(0);
    let cur = runner.posting.getEntry(e.id)!;
    expect(cur.lastError).toBe(HELD_AUTO_OFF);
    expect(runner.nextRun(cur)).toMatchObject({ tone: "held" });
    expect(runner.posting.history("pg").filter((h) => h.event === "held")).toHaveLength(1);
    // Owner switches it on 2h later → catch-up, marked late.
    clock += 2 * HOUR;
    runner.posting.updateConfig("pg", { enabled: true });
    await run(runner, 0.25);
    cur = runner.posting.getEntry(e.id)!;
    expect(cur.status).toBe("posted");
    expect(cur.lateByMs!).toBeGreaterThan(2 * HOUR);
    const h = runner.posting.history("pg").map((x) => x.event);
    expect(h).toContain("late");
  });

  it("an offline phone delays a designated post with the reason and the next attempt, then catches up", async () => {
    const runner = makeRunner();
    await setup(runner);
    const e = await enqueue(runner, "Pinned");
    const want = clock + 2 * MIN;
    runner.posting.setDesignatedAt(e.id, want);
    droid.online = false;
    await run(runner, 3);
    const cur = runner.posting.getEntry(e.id)!;
    expect(cur.status).toBe("scheduled");
    expect(cur.lastError).toMatch(/offline/);
    expect(cur.scheduledAt!).toBeGreaterThan(clock);
    const nr = runner.nextRun(cur)!;
    expect(nr.tone).toBe("wait");
    expect(nr.reason).toMatch(/^delayed: .*offline/);
    expect(nr.at).toBe(cur.scheduledAt);
    droid.online = true;
    await run(runner, 11);
    const done = runner.posting.getEntry(e.id)!;
    expect(done.status).toBe("posted");
    expect(done.lateByMs!).toBeGreaterThan(5 * MIN);
  });

  it("min interval delays a designated post visibly (delayed: …) rather than silently", async () => {
    const runner = makeRunner();
    await setup(runner);
    await enqueue(runner, "First");
    await run(runner, 0.25); // posts now
    const e = await enqueue(runner, "Pinned");
    runner.posting.setDesignatedAt(e.id, clock + 10 * MIN);
    await run(runner, 0.25);
    const cur = runner.posting.getEntry(e.id)!;
    expect(cur.status).toBe("scheduled");
    expect(cur.lastError).toMatch(/^delayed: minimum interval/);
    expect(runner.nextRun(cur)!.reason).toMatch(/delayed: minimum interval/);
  });

  it("verification: posted → verifying → verified with permalink + evidence (phone)", async () => {
    const runner = makeRunner();
    await setup(runner);
    const e = await enqueue(runner, "Clip");
    await run(runner, 0.25);
    let cur = runner.posting.getEntry(e.id)!;
    expect(cur.status).toBe("posted");
    expect(cur.verifyStatus).toBe("verifying");
    expect(cur.permalink).toBeNull();
    await run(runner, VERIFY_FIRST_DELAY_MS / MIN + 0.5);
    cur = runner.posting.getEntry(e.id)!;
    expect(cur.verifyStatus).toBe("verified");
    expect(cur.permalink).toBe("https://www.instagram.com/reel/DPx1AbCdEfG/");
    expect(cur.verifyEvidence!.sources).toEqual(["device"]);
    expect(cur.verifyEvidence!.screenshots).toEqual(["/tmp/verify-post.png"]);
    expect(cur.verifyEvidence!.steps.some((s) => s.includes("caption_match"))).toBe(true);
    expect(droid.verifies[0]!.caption).toBe("Clip hook line\nClip");
    expect(
      runner.posting
        .history("pg")
        .some((h) => h.event === "verified" && h.message.includes("/reel/DPx1AbCdEfG/")),
    ).toBe(true);
  });

  it("verification never claims verified without a caption match: not_found → unverified + alert", async () => {
    const runner = makeRunner();
    await setup(runner);
    droid.verifyResult = () => ({
      ok: false,
      status: "not_found",
      reason: 'the newest post\'s caption does not match ("old video")',
      permalink: null,
      captionMatched: false,
      seenCaption: "old video",
      activeHandle: "brand.co",
      steps: [{ step: "caption_match", ok: false, at: 1 }],
    });
    const e = await enqueue(runner, "Clip");
    await run(runner, 60); // all attempts
    const cur = runner.posting.getEntry(e.id)!;
    expect(cur.verifyStatus).toBe("unverified");
    expect(cur.verifyAttempts).toBe(VERIFY_MAX_ATTEMPTS);
    expect(cur.verifyNote).toMatch(/caption does not match/);
    expect(alerts.some((a) => /not verified/.test(a.title))).toBe(true);
    // Re-verify (owner button) succeeds once the phone shows it.
    droid.verifyResult = fakeDroid().verifyResult;
    const again = await runner.verifyNow(e.id);
    expect(again.verifyStatus).toBe("verified");
    expect(again.permalink).toMatch(/instagram\.com\/reel\//);
  });

  it("busy / offline phone keeps verifying and retries instead of failing", async () => {
    const runner = makeRunner();
    await setup(runner);
    let n = 0;
    droid.verifyResult = (input) =>
      ++n === 1
        ? {
            ok: false,
            status: "busy",
            reason: "device is busy",
            permalink: null,
            captionMatched: false,
            seenCaption: null,
            activeHandle: null,
            steps: [],
          }
        : fakeDroid().verifyResult(input);
    const e = await enqueue(runner, "Clip");
    await run(runner, 1.25);
    let cur = runner.posting.getEntry(e.id)!;
    expect(cur.verifyStatus).toBe("verifying");
    expect(cur.verifyNote).toMatch(/busy/);
    await run(runner, 3);
    cur = runner.posting.getEntry(e.id)!;
    expect(cur.verifyStatus).toBe("verified");
  });

  it("Instagram API match verifies (no phone time) and supplies the canonical permalink", async () => {
    const runner = makeRunner({ api: true });
    await setup(runner);
    const e = await enqueue(runner, "Clip");
    await run(runner, 0.25);
    recent = [
      {
        permalink: "https://www.instagram.com/reel/OLDoldOLD1/",
        caption: "Older video",
        timestamp: clock - 5 * HOUR,
      },
      {
        permalink: "https://www.instagram.com/reel/NEWnew1234/",
        caption: "Clip hook line\nClip\n#x",
        timestamp: clock + 10_000,
      },
    ];
    await run(runner, VERIFY_FIRST_DELAY_MS / MIN + 0.5);
    const cur = runner.posting.getEntry(e.id)!;
    expect(cur.verifyStatus).toBe("verified");
    expect(cur.permalink).toBe("https://www.instagram.com/reel/NEWnew1234/");
    expect(cur.verifyEvidence!.sources).toEqual(["instagram_api"]);
    expect(droid.verifies).toHaveLength(0);
  });

  it("dry runs are never verified (nothing was published)", async () => {
    const runner = makeRunner();
    await setup(runner, { dryRun: true });
    droid.publishStatus = "dry_run_complete";
    const e = await enqueue(runner, "Clip");
    await run(runner, 3);
    const cur = runner.posting.getEntry(e.id)!;
    expect(cur.status).toBe("posted");
    expect(cur.verifyStatus).toBeNull();
    await expect(runner.verifyNow(e.id)).rejects.toThrow(/dry run/);
  });

  it("the run columns are added to an existing v2 database without a schema step", () => {
    const db = studio.store.db;
    new PostingStore(db);
    const cols = (
      db.prepare("PRAGMA table_info(cs_post_queue)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining(["designated_at", "verify_status", "permalink", "verify_evidence"]),
    );
    // Idempotent.
    expect(() => new PostingStore(db)).not.toThrow();
  });

  // ── The Auto-posting switch (owner report 2026-10-11) ────────────────────

  it("switching Auto-posting on releases held entries and posts on the next tick — no restart, no interval wait", async () => {
    const runner = makeRunner();
    await setup(runner, { enabled: false, dryRun: true });
    const cadence = await enqueue(runner, "Cadence");
    const pinned = await enqueue(runner, "Pinned");
    runner.posting.setDesignatedAt(pinned.id, clock + 2 * MIN);
    await run(runner, 5); // pinned comes due while off → held
    expect(droid.calls).toHaveLength(0);
    expect(runner.posting.getEntry(pinned.id)!.lastError).toBe(HELD_AUTO_OFF);
    expect(runner.nextRun(runner.posting.getEntry(cadence.id)!)).toMatchObject({
      tone: "held",
      reason: expect.stringMatching(/auto-posting is off/),
    });

    // The UI's toggle → the configure RPC (same code path).
    const res = await ops.configurePosting(runner, { pageId: "pg", enabled: true, actor: "ui:operator" });
    expect(res.config.enabled).toBe(true);
    expect(res.released).toBe(2);
    // Persisted: a fresh store on the same DB (what the 15 s timer reads) sees it.
    expect(new PostingStore(studio.store.db, () => clock).getConfig("pg").enabled).toBe(true);
    expect(runner.posting.getEntry(pinned.id)!.lastError).toBeNull();
    expect(runner.posting.history("pg").map((h) => h.event)).toContain("released");

    // The kicked tick posts without the test calling tick() — dry run only.
    await vi.waitFor(() => expect(droid.calls.length).toBeGreaterThan(0));
    expect(droid.calls.every((c) => c.dryRun)).toBe(true);
    const st = ops.getPosting(runner, { pageId: "pg" });
    expect(st.autoPosting).toEqual({ enabled: true, canEnable: true, blocker: null });
    expect(st.preview.held).toBeNull();
    for (const e of st.queue.filter((q) => q.status === "queued" || q.status === "scheduled")) {
      expect(e.nextRun?.tone).not.toBe("held");
    }
  });

  it("a page with no account bound says so (not 'auto-posting is off'), and approval-off alone never starts posting", async () => {
    const runner = makeRunner();
    // The live page: phone chosen, no account, approval + dry run switched off.
    runner.posting.updateConfig("pg", {
      deviceId: "dev1",
      deviceLabel: "Phone 01",
      bindings: [],
      schedule: { mode: "interval", everyMinutes: 60, jitterMinutes: 0, windowStart: "06:00", windowEnd: "21:00", timezone: tz },
    });
    const e = await enqueue(runner, "Waiting");
    await ops.configurePosting(runner, { pageId: "pg", requireApproval: false });
    await ops.configurePosting(runner, { pageId: "pg", dryRun: false });
    await run(runner, 5);
    expect(droid.calls).toHaveLength(0);

    const st = ops.getPosting(runner, { pageId: "pg" });
    expect(st.config).toMatchObject({ enabled: false, requireApproval: false, dryRun: false });
    expect(st.autoPosting.canEnable).toBe(false);
    expect(st.autoPosting.blocker?.kind).toBe("unbound");
    expect(st.preview.held).toMatch(/No account is bound/);
    expect(runner.nextRun(runner.posting.getEntry(e.id)!)!.reason).toMatch(/no account is bound/);
    expect(runner.nextRun(runner.posting.getEntry(e.id)!)!.reason).not.toMatch(/auto-posting is off/);
    await expect(ops.configurePosting(runner, { pageId: "pg", enabled: true })).rejects.toThrow(
      /bind a device and at least one account/,
    );

    // Bind + switch on (dry run for the test) → released and posted right away.
    await ops.configurePosting(runner, {
      pageId: "pg",
      bindings: [{ platform: "instagram", handle: "brand.co" }],
      dryRun: true,
    });
    const on = await ops.configurePosting(runner, { pageId: "pg", enabled: true });
    expect(on.released).toBe(1);
    await vi.waitFor(() => expect(droid.calls).toHaveLength(1));
    expect(droid.calls[0]!.dryRun).toBe(true);
  });

  it("switching Auto-posting off holds again; config changes that keep it off release nothing", async () => {
    const runner = makeRunner();
    await setup(runner, { enabled: true, dryRun: true });
    const off = await ops.configurePosting(runner, { pageId: "pg", enabled: false });
    expect(off.released).toBe(0);
    await enqueue(runner, "Later");
    expect((await ops.configurePosting(runner, { pageId: "pg", requireApproval: true })).released).toBe(0);
    await run(runner, 3);
    expect(droid.calls).toHaveLength(0);
    expect(ops.getPosting(runner, { pageId: "pg" }).autoPosting.blocker?.kind).toBe("off");
  });
});
