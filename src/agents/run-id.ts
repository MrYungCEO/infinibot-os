/**
 * Human-friendly run ID generation for claude_coder spawns.
 *
 * Format: coder-<short-slug>-<4-char base36>
 * Total length capped at 48 chars.
 */

const STOP_WORDS = new Set(["the", "a", "and", "for", "with", "to", "on", "from", "of", "in"]);

const MAX_TOKENS = 5;
// "coder-" (6) + slug + "-" (1) + 4-char id = slug must fit in 48 - 11 = 37
const MAX_SLUG_LEN = 37;

/**
 * Convert a free-text label into a URL/ID-safe slug of at most 5 dash-joined tokens.
 * Returns "" if the input is blank or produces only stop-words.
 */
export function makeCoderSlug(text: string): string {
  if (!text || !text.trim()) return "";
  const slug = text
    .toLowerCase()
    // Replace everything that isn't a letter, digit, space, or dash with a space.
    .replace(/[^a-z0-9 -]/g, " ")
    // Collapse runs of whitespace into a single dash.
    .replace(/\s+/g, "-")
    // Collapse consecutive dashes.
    .replace(/-{2,}/g, "-")
    // Trim leading/trailing dashes.
    .replace(/^-+|-+$/g, "");

  const tokens = slug.split("-").filter((t) => t.length > 0 && !STOP_WORDS.has(t));

  const limited = tokens.slice(0, MAX_TOKENS).join("-");

  if (limited.length > MAX_SLUG_LEN) {
    return limited.slice(0, MAX_SLUG_LEN).replace(/-+$/, "");
  }
  return limited;
}

/**
 * Build a human-friendly runId for a claude_coder spawn.
 *
 * Slug precedence: label → task → "untitled"
 * Collision check: pass `isActive` to retry up to 5 times on a hit.
 */
export function makeCoderRunId(
  label: string | undefined | null,
  task: string | undefined | null,
  isActive: (id: string) => boolean = () => false,
): string {
  let slug = makeCoderSlug(label ?? "");
  if (!slug) slug = makeCoderSlug(task ?? "");
  if (!slug) slug = "untitled";

  for (let attempt = 0; attempt < 5; attempt++) {
    const shortId = Math.random().toString(36).slice(2, 6);
    const runId = `coder-${slug}-${shortId}`;
    if (!isActive(runId)) return runId;
  }
  // Statistically unreachable; last-resort retry.
  return `coder-${slug}-${Math.random().toString(36).slice(2, 6)}`;
}
