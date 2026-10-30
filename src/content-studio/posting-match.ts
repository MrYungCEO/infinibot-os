/**
 * Caption matching for post verification — the same rules the Droid Swarm
 * publisher applies on the phone (extensions/droid-swarm/src/publisher/
 * verify-post.ts), used here against the platform API's media list.
 */

/** Lowercase letters/digits/spaces only — what survives adb typing + app rendering. */
export function normalizeCaption(text: string): string {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[#@][\p{L}\p{N}_.]+/gu, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Opening words of the first line with real words (hashtags/mentions dropped). */
export function captionKey(caption: string, chars = 28): string {
  for (const line of caption.split("\n")) {
    const n = normalizeCaption(line);
    if (n.length >= 4) return n.slice(0, chars).trim();
  }
  return "";
}
