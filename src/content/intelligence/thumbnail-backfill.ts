/**
 * Content Intelligence — reel thumbnail backfill.
 *
 * Every reel has only a shortcode + Instagram URL, no cover image. This script
 * walks all reels and resolves a cover thumbnail by scraping the `og:image`
 * meta tag from each reel's public Instagram URL (reusing the proven
 * {@link fetchOgMetadata}). It optionally mirrors the image bytes to disk so the
 * UI doesn't hotlink the IG CDN (those URLs expire), and caches results in the
 * dedicated `reel_thumbnails` table so re-runs skip already-resolved reels.
 *
 * IG aggressively rate-limits scraping, so we use a small concurrency limit and
 * a polite per-request delay. If most reels fail, the summary makes that loud
 * (so we can switch to a local-video/ffmpeg cover-frame strategy instead).
 *
 * Run:  npx tsx src/content/intelligence/thumbnail-backfill.ts [--no-download] [--force] [--limit N]
 */

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveStateDir } from "../../config/paths.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getContentIntelStore } from "./store.js";
import { fetchOgMetadata } from "./og-fetch.js";
import {
  ensureThumbnailTable,
  getThumbnail,
  setThumbnail,
  countOkThumbnails,
} from "./thumbnail-store.js";

const log = createSubsystemLogger("content-intel-thumb-backfill");

const CONCURRENCY = 3; // be gentle — IG rate-limits aggressively
const DELAY_MS = 1_200; // polite delay between requests (per worker)

export interface BackfillOptions {
  /** Download the image bytes to disk and record local_path. Default true. */
  download?: boolean;
  /** Re-fetch reels that already have an ok thumbnail. Default false. */
  force?: boolean;
  /** Cap how many reels to process (for a smoke test). Default: all. */
  limit?: number;
}

export interface BackfillSummary {
  total: number;
  attempted: number;
  resolved: number; // got a real og:image URL
  downloaded: number; // bytes saved to disk
  skipped: number; // already had an ok thumbnail (cache hit)
  failed: number; // attempted but no image
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function thumbsDir(): string {
  const dir = join(resolveStateDir(), "content-intel-thumbs");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Download image bytes; returns the local path on success, null otherwise. */
async function downloadImage(imageUrl: string, shortcode: string): Promise<string | null> {
  const dest = join(thumbsDir(), `${shortcode}.jpg`);
  if (existsSync(dest)) return dest;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    let res: Response;
    try {
      res = await fetch(imageUrl, { redirect: "follow", signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!/image\//i.test(ct)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength < 256) return null; // too small to be a real cover
    writeFileSync(dest, buf);
    return dest;
  } catch (e) {
    log.debug("thumb download failed", {
      shortcode,
      err: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

export async function runThumbnailBackfill(opts: BackfillOptions = {}): Promise<BackfillSummary> {
  const download = opts.download !== false;
  const force = opts.force === true;
  const store = getContentIntelStore();
  ensureThumbnailTable();

  const runId = randomUUID();
  store.insertRun({
    id: runId,
    kind: "thumbnail-backfill",
    started_at: Date.now(),
    finished_at: null,
    status: "running",
    details: JSON.stringify({ download, force }),
    reel_count: 0,
  });

  let reels = store.listReels(2000);
  if (typeof opts.limit === "number" && opts.limit > 0) reels = reels.slice(0, opts.limit);

  const summary: BackfillSummary = {
    total: reels.length,
    attempted: 0,
    resolved: 0,
    downloaded: 0,
    skipped: 0,
    failed: 0,
  };

  // Filter out cache hits up front (unless --force).
  const queue = reels.filter((r) => {
    if (force) return true;
    const existing = getThumbnail(r.shortcode);
    if (existing && existing.ok === 1) {
      summary.skipped++;
      return false;
    }
    return true;
  });

  log.info("thumbnail backfill starting", {
    total: summary.total,
    queued: queue.length,
    skipped: summary.skipped,
    download,
  });

  let cursor = 0;
  async function worker(workerId: number): Promise<void> {
    while (cursor < queue.length) {
      const reel = queue[cursor++];
      summary.attempted++;
      try {
        const og = await fetchOgMetadata(reel.url);
        const imageUrl = og.image ?? null;
        let localPath: string | null = null;
        if (imageUrl) {
          summary.resolved++;
          if (download) {
            localPath = await downloadImage(imageUrl, reel.shortcode);
            if (localPath) summary.downloaded++;
          }
        } else {
          summary.failed++;
        }
        setThumbnail({
          shortcode: reel.shortcode,
          thumbnail_url: imageUrl,
          local_path: localPath,
          fetched_at: Date.now(),
          ok: imageUrl ? 1 : 0,
        });
      } catch (e) {
        summary.failed++;
        log.debug("thumb fetch error", {
          shortcode: reel.shortcode,
          err: e instanceof Error ? e.message : String(e),
        });
        setThumbnail({
          shortcode: reel.shortcode,
          thumbnail_url: null,
          local_path: null,
          fetched_at: Date.now(),
          ok: 0,
        });
      }
      if ((summary.attempted & 15) === 0) {
        log.info("thumbnail backfill progress", {
          attempted: summary.attempted,
          resolved: summary.resolved,
          failed: summary.failed,
        });
      }
      await sleep(DELAY_MS);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, (_, i) => worker(i)),
  );

  store.updateRun(runId, {
    finished_at: Date.now(),
    status: "done",
    reel_count: summary.attempted,
    details: JSON.stringify(summary),
  });

  log.info("thumbnail backfill done", { ...summary, okTotal: countOkThumbnails() });
  return summary;
}

// ── CLI entrypoint ────────────────────────────────────────────────
const isMain = (() => {
  try {
    return (
      typeof process !== "undefined" &&
      Array.isArray(process.argv) &&
      /thumbnail-backfill\.(ts|js)$/.test(process.argv[1] ?? "")
    );
  } catch {
    return false;
  }
})();

if (isMain) {
  const argv = process.argv.slice(2);
  const limitArg = argv.indexOf("--limit");
  const opts: BackfillOptions = {
    download: !argv.includes("--no-download"),
    force: argv.includes("--force"),
    limit: limitArg >= 0 ? Number(argv[limitArg + 1]) : undefined,
  };
  runThumbnailBackfill(opts)
    .then((s) => {
      const okTotal = countOkThumbnails();
      // eslint-disable-next-line no-console
      console.log(
        `\n=== thumbnail backfill ===\n` +
          `total reels:   ${s.total}\n` +
          `attempted:     ${s.attempted}\n` +
          `resolved url:  ${s.resolved}\n` +
          `downloaded:    ${s.downloaded}\n` +
          `cache-skipped: ${s.skipped}\n` +
          `failed:        ${s.failed}\n` +
          `ok in store:   ${okTotal} / ${s.total}\n` +
          `success rate:  ${((okTotal / Math.max(1, s.total)) * 100).toFixed(1)}%`,
      );
      process.exit(0);
    })
    .catch((e) => {
      // eslint-disable-next-line no-console
      console.error("thumbnail backfill crashed:", e);
      process.exit(1);
    });
}
