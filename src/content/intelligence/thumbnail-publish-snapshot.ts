/**
 * Publish backfilled reel thumbnails into the UI and patch the static snapshot.
 *
 * Two side effects:
 *  1. Copies every downloaded cover (`<stateDir>/content-intel-thumbs/*.jpg`)
 *     into `ui/public/content-intel-thumbs/` so the control UI serves them as
 *     stable static assets (no IG-CDN hotlinking — those og:image URLs expire).
 *  2. Adds a `thumbnail_url` field to each reel in
 *     `ui/public/content-intel-snapshot.json` (the baked fallback the UI reads
 *     when the gateway RPC is unavailable), mirroring the live RPC shape.
 *
 * Run after `thumbnail-backfill.ts`:
 *   node --import tsx src/content/intelligence/thumbnail-publish-snapshot.ts
 */

import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveStateDir } from "../../config/paths.js";
import { getContentIntelStore } from "./store.js";
import { getAllThumbnails } from "./thumbnail-store.js";

function repoRoot(): string {
  // src/content/intelligence/ -> ../../../
  return join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
}

function main(): void {
  const root = repoRoot();
  const snapshotPath = join(root, "ui", "public", "content-intel-snapshot.json");
  const publicThumbsDir = join(root, "ui", "public", "content-intel-thumbs");
  const srcThumbsDir = join(resolveStateDir(), "content-intel-thumbs");
  mkdirSync(publicThumbsDir, { recursive: true });

  const thumbs = getAllThumbnails();
  // Ensure store is loaded (validates DB) and report counts.
  getContentIntelStore();

  // 1. Copy downloaded covers into ui/public.
  let copied = 0;
  for (const [shortcode, row] of thumbs) {
    if (row.ok !== 1) continue;
    const src = row.local_path || join(srcThumbsDir, `${shortcode}.jpg`);
    if (!existsSync(src)) continue;
    try {
      copyFileSync(src, join(publicThumbsDir, `${shortcode}.jpg`));
      copied++;
    } catch {
      /* skip unreadable */
    }
  }

  // 2. Patch the snapshot JSON.
  const snap = JSON.parse(readFileSync(snapshotPath, "utf8")) as {
    reels: Array<{ shortcode: string; thumbnail_url?: string | null }>;
  };
  let withThumb = 0;
  for (const reel of snap.reels) {
    const row = thumbs.get(reel.shortcode);
    if (row && row.ok === 1) {
      const hasLocal = existsSync(join(publicThumbsDir, `${reel.shortcode}.jpg`));
      reel.thumbnail_url = hasLocal
        ? `/content-intel-thumbs/${reel.shortcode}.jpg`
        : (row.thumbnail_url ?? null);
      if (reel.thumbnail_url) withThumb++;
    } else {
      reel.thumbnail_url = null;
    }
  }
  writeFileSync(snapshotPath, JSON.stringify(snap, null, 1) + "\n");

  // eslint-disable-next-line no-console
  console.log(
    `published thumbnails: copied ${copied} into ui/public/content-intel-thumbs; ` +
      `snapshot reels with thumbnail_url: ${withThumb}/${snap.reels.length}`,
  );
}

main();
