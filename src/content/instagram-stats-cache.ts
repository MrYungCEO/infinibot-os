// Open-source build stub: the real module is part of the hosted product (see docs/licensing/PRIVATE-SPLIT.md).
import type { InstagramPageStats } from "./pages-instagram-stats.js";

export function readCachedStats(
  _pageId: string,
): { stats: InstagramPageStats; savedAt: number } | null {
  return null;
}

export function writeCachedStats(_pageId: string, _stats: InstagramPageStats): void {}
