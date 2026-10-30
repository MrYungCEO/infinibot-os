/**
 * Guard: the deprecated repo-local state-dir fallback must not spread.
 *
 * `process.env.INFINIBOT_STATE_DIR || "state"` resolves to `<cwd>/state` — a
 * directory that changes with the process's launch directory and that nothing
 * else in the install reads. Data written there is invisible to every other
 * component.
 *
 * This is not theoretical. Payment provider credentials saved from the income
 * settings landed in `<cwd>/state/business/income.json`, while
 * `resolveWhopCredentials()` read `~/.infinibot/business/income.json`. Every
 * Whop payment link failed with "API key not configured" no matter how many
 * times the key was entered correctly, because the writer and the reader were
 * looking at different directories.
 *
 * New code must use `resolveStateDir()` from `src/config/paths.ts`.
 *
 * When migrating one of the remaining offenders, read the legacy path as a
 * fallback *before* writing to the canonical one — see `legacyStorePath()` in
 * `gateway/server-methods/business-income.ts` — so that an install which
 * already has data under `<cwd>/state` does not appear to lose it.
 *
 * The ceiling below pins the known debt. Driving it down is the goal; any
 * change that pushes it up fails this test.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Known count of files still using the deprecated fallback, measured when this
 * guard was added. Lower this number as files are migrated — never raise it.
 */
const KNOWN_OFFENDER_CEILING = 55;

const LEGACY_PATTERNS = [
  /INFINIBOT_STATE_DIR\s*(\|\||\?\?)\s*"state"/,
  /MOLTBOT_STATE_DIR\s*(\|\||\?\?)\s*"state"/,
  /INFINIBOT_STATE_DIR\s*(\|\||\?\?)\s*resolve\(process\.cwd\(\),\s*"state"\)/,
];

/**
 * Files that must name the legacy root on purpose — they exist to read data
 * OUT of `<cwd>/state`, never to write new data there:
 *  - paths.ts: `stateFilePathWithLegacyMigration` copies legacy data forward.
 *  - the plugin migrations look for a pre-plugin install's legacy stores.
 *  - the knowledge-profile probe reports on the stores the legacy handlers use.
 *  - revenue accounts migrate the old cwd-relative income.json forward.
 *  - the posting service/ops read the content pages + series stores, which
 *    still live in the legacy root (same reason as content-studio/runtime.ts).
 */
const LEGACY_READERS = new Set([
  "src/config/paths.ts",
  "src/business-agency/migration.ts",
  "src/content-studio/runtime.ts",
  "src/agents/knowledge-profile/runtime.ts",
  "src/business-hub/revenue/accounts.ts",
  "src/content-studio/posting-ops.ts",
  "src/content-studio/posting-service.ts",
]);

/** Drop comments so prose that merely quotes the pattern is not counted as a use. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (entry.endsWith(".ts") && !entry.includes(".test.")) {
      out.push(full.replace(/\\/g, "/"));
    }
  }
  return out;
}

describe("state dir hygiene", () => {
  it("does not grow the repo-local state-dir fallback debt", () => {
    const offenders = walk("src")
      .filter((file) => !LEGACY_READERS.has(file))
      .filter((file) => {
        const code = stripComments(readFileSync(file, "utf8"));
        return LEGACY_PATTERNS.some((pattern) => pattern.test(code));
      });
    expect(
      offenders.length,
      `${offenders.length} files use the deprecated <cwd>/state fallback (ceiling ` +
        `${KNOWN_OFFENDER_CEILING}). Use resolveStateDir() from src/config/paths.ts — ` +
        "data written to <cwd>/state is invisible to the rest of the install.\n" +
        offenders.join("\n"),
    ).toBeLessThanOrEqual(KNOWN_OFFENDER_CEILING);
  });
});
