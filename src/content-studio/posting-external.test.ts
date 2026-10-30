/**
 * Posting queue seams used by Droid Swarm's FlyPic link: in-process external
 * videos (Buffer, never JSON), dedupe by source id, the targets list FlyPic's
 * account picker shows, and compact lookups for status mirroring.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DroidPublisher } from "./posting-droid.js";
import { enqueueVideo, listTargets, lookupEntries } from "./posting-ops.js";
import { PostingRunner } from "./posting-runner.js";
import { PostingStore } from "./posting-store.js";
import { getContentStudio, resetContentStudios } from "./studio.js";

const MP4 = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from("ftypmp42"),
  Buffer.alloc(12),
  Buffer.alloc(2048, 7),
]);

const droid: DroidPublisher = {
  available: () => true,
  devices: async () => ({ ok: true, status: "ok", devices: [] }),
  detect: async () => ({
    ok: false,
    status: "offline",
    reason: "test",
    detection: null,
    steps: [],
  }),
  publish: async () => {
    throw new Error("no publishing in this test");
  },
};

let dir: string;
let runner: PostingRunner;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-ext-"));
  const studio = getContentStudio(dir);
  runner = new PostingRunner({
    studio,
    posting: new PostingStore(studio.store.db),
    droid,
    host: {},
    page: (id) =>
      id === "pg" || id === "pg2"
        ? { id, name: id === "pg" ? "Brand Reels" : "Side", handle: null }
        : null,
  });
  runner.posting.updateConfig("pg", {
    deviceId: "dev1",
    deviceLabel: "Phone 01",
    bindings: [
      { platform: "instagram", handle: "brand.co" },
      { platform: "tiktok", handle: "brand.tt" },
    ],
  });
});

afterEach(() => {
  runner.stop();
  resetContentStudios();
  fs.rmSync(dir, { recursive: true, force: true });
});

const external = (id: string, buffer: unknown = MP4) => ({
  kind: "flypic",
  id,
  buffer,
  filename: `flypic-${id}.mp4`,
  contentType: "video/mp4",
});

describe("external (in-process) videos", () => {
  it("queues a Buffer video tagged with its source, with trial reel + designated time", async () => {
    const res = await enqueueVideo(runner, {
      pageId: "pg",
      platform: "instagram",
      title: "Neon city",
      captionOverride: "Neon city at night\n\n#flypic",
      trialReel: true,
      postAt: "2026-12-01T10:00:00Z",
      external: external("item_1"),
    });
    expect(res.entries).toHaveLength(1);
    const e = res.entries[0]!;
    expect(e.sourceKind).toBe("flypic");
    expect(e.sourceId).toBe("item_1");
    expect(e.trialReel).toBe(true);
    expect(e.captionOverride).toContain("#flypic");
    expect(e.designatedAt).toBe(Date.parse("2026-12-01T10:00:00Z"));
    expect(e.media?.kind).toBe("video");
  });

  it("re-delivery of the same source id returns the existing entry (no second post)", async () => {
    const a = await enqueueVideo(runner, {
      pageId: "pg",
      platform: "instagram",
      external: external("item_2"),
    });
    const b = await enqueueVideo(runner, {
      pageId: "pg",
      platform: "instagram",
      external: external("item_2"),
    });
    expect((b as { deduped?: boolean }).deduped).toBe(true);
    expect(b.entries[0]!.id).toBe(a.entries[0]!.id);
    expect(runner.posting.listQueue("pg")).toHaveLength(1);
  });

  it("a buffer that arrived as JSON (array / base64 string) is ignored — RPC clients cannot use this path", async () => {
    await expect(
      enqueueVideo(runner, {
        pageId: "pg",
        platform: "instagram",
        external: external("item_3", Array.from(MP4)),
      }),
    ).rejects.toThrow(/give a video/);
    await expect(
      enqueueVideo(runner, {
        pageId: "pg",
        platform: "instagram",
        external: external("item_3", MP4.toString("base64")),
      }),
    ).rejects.toThrow(/give a video/);
  });

  it("an external item targets exactly one platform", async () => {
    await expect(
      enqueueVideo(runner, {
        pageId: "pg",
        platforms: ["instagram", "tiktok"],
        external: external("item_4"),
      }),
    ).rejects.toThrow(/exactly one platform/);
  });

  it("tiktok entries never carry the trial flag", async () => {
    const res = await enqueueVideo(runner, {
      pageId: "pg",
      platform: "tiktok",
      trialReel: true,
      external: external("item_5"),
    });
    expect(res.entries[0]!.trialReel).toBe(false);
  });
});

describe("targets + lookup", () => {
  it("lists one target per bound account with trial-reel capability for Instagram only", () => {
    const { targets } = listTargets(runner);
    expect(targets.map((t) => t.id).sort()).toEqual(["pg:instagram", "pg:tiktok"]);
    const ig = targets.find((t) => t.platform === "instagram")!;
    expect(ig).toMatchObject({
      pageName: "Brand Reels",
      handle: "brand.co",
      deviceLabel: "Phone 01",
      autoPosting: false,
    });
    expect(ig.capabilities.trialReel).toBe(true);
    expect(ig.capabilities.image).toBe(false);
    expect(targets.find((t) => t.platform === "tiktok")!.capabilities.trialReel).toBe(false);
    // no credentials or tokens in a target
    expect(JSON.stringify(targets)).not.toMatch(/password|token|secret/i);
  });

  it("pages without a bound phone are not targets", () => {
    runner.posting.updateConfig("pg2", { bindings: [{ platform: "instagram", handle: "x" }] });
    expect(listTargets(runner).targets.some((t) => t.pageId === "pg2")).toBe(false);
  });

  it("looks entries up by source ids and by entry ids", async () => {
    const a = await enqueueVideo(runner, {
      pageId: "pg",
      platform: "instagram",
      external: external("item_6"),
    });
    const bySource = lookupEntries(runner, { sourceKind: "flypic", sourceIds: ["item_6", "nope"] });
    expect(bySource.entries.map((e) => e.id)).toEqual([a.entries[0]!.id]);
    const byId = lookupEntries(runner, { entryIds: [a.entries[0]!.id] });
    expect(byId.entries[0]).toMatchObject({
      status: "queued",
      sourceKind: "flypic",
      sourceId: "item_6",
      platform: "instagram",
    });
  });
});
