/**
 * Run artifact contract — the shared "what a coder run leaves behind" spec.
 *
 * Every coder spawn gets a run-scoped artifacts directory
 * (`~/.infinibot/agents/main/runs/<runId>/artifacts/`) created at spawn time,
 * and the child receives an ARTIFACTS contract block in its system prompt
 * telling it exactly what to write there:
 *
 *   report.md        — final human-readable summary of the work
 *   steps.json       — ordered [{ id, title, status: done|skipped|failed, note }]
 *   shots/<step>-<viewport>.png — screenshots (viewport: mobile | desktop)
 *   verification.md  — written by the independent verifier, NOT the run itself
 *
 * The contract is advisory for the child (runs that ignore it still finalize
 * normally) but load-bearing for the work-review emitter, which reads this
 * directory after finalize to build the review canvas + report. All readers
 * here are best-effort and never throw.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("agents/artifact-contract");

/** Canonical file names inside a run's artifacts dir. */
export const ARTIFACT_FILES = {
  report: "report.md",
  steps: "steps.json",
  verification: "verification.md",
  shotsDir: "shots",
} as const;

/** The two contract viewports every visual verification captures. */
export const ARTIFACT_VIEWPORTS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

export type ArtifactStepStatus = "done" | "skipped" | "failed";

export interface ArtifactStep {
  id: string;
  title: string;
  status: ArtifactStepStatus;
  note?: string;
}

export interface ArtifactShot {
  /** Bare filename, e.g. "01-login-desktop.png". */
  file: string;
  /** Absolute path on disk. */
  path: string;
  /** Step portion of the contract name (`<step>-<viewport>.png`). */
  step: string;
  /** Viewport portion, "" when the name doesn't follow the contract. */
  viewport: string;
}

export interface VerificationClaim {
  claim: string;
  status: "PASS" | "FAIL";
}

export interface VerificationSummary {
  /** Overall verdict; null when verification.md is absent or has no verdict. */
  verdict: "SHIP" | "DO-NOT-SHIP" | null;
  claims: VerificationClaim[];
}

export interface RunArtifacts {
  dir: string;
  /** Contents of report.md, "" when absent. */
  reportMd: string;
  steps: ArtifactStep[];
  stepsErrors: string[];
  shots: ArtifactShot[];
  /** Contents of verification.md, "" when absent. */
  verificationMd: string;
  verification: VerificationSummary;
}

/**
 * Resolve the contract artifacts dir for a run. Lives under the "main" agent
 * namespace per the contract spec; `baseDir` overrides the state dir for tests.
 */
export function resolveRunArtifactsDir(runId: string, baseDir?: string): string {
  return join(baseDir ?? resolveStateDir(), "agents", "main", "runs", runId, "artifacts");
}

/**
 * Create the artifacts dir (plus shots/) for a run. Returns the absolute path,
 * or null when creation failed — spawning must never break on artifact plumbing.
 */
export function ensureRunArtifactsDir(runId: string, baseDir?: string): string | null {
  try {
    const dir = resolveRunArtifactsDir(runId, baseDir);
    mkdirSync(join(dir, ARTIFACT_FILES.shotsDir), { recursive: true });
    return dir;
  } catch (err) {
    log.warn("failed to create run artifacts dir", {
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * The ARTIFACTS contract block injected into every coder spawn's system prompt.
 * Keep the wording in sync with what the work-review emitter actually reads.
 */
export function buildArtifactContractBlock(artifactsDir: string): string {
  return `## ARTIFACTS contract (write these as you work)

Your run has a dedicated artifacts directory:

    ${artifactsDir}

Write the following there — the operator's automated work-review reads exactly these paths:

1. \`${artifactsDir}/report.md\` — your final summary of what you did (markdown).
2. \`${artifactsDir}/steps.json\` — an ORDERED JSON array of the steps you performed:
   \`[{ "id": "01-setup", "title": "Install deps", "status": "done" }]\`
   Allowed \`status\` values: \`done\` | \`skipped\` | \`failed\`. Optional \`note\` string per step.
   Update it as you go, not just at the end.
3. \`${artifactsDir}/${ARTIFACT_FILES.shotsDir}/<step>-<viewport>.png\` — screenshots proving visual work.
   Naming is STRICT: \`<step>\` matches a steps.json id, \`<viewport>\` is \`mobile\` (375x812) or \`desktop\` (1440x900).
   Example: \`02-dashboard-desktop.png\`.
4. Do NOT write \`verification.md\` — that file is reserved for the independent verifier.

For screenshots, use the shared harness instead of writing your own puppeteer script:

    node scripts/visual-verify.mjs --url <url> --step <step-id> --out "${artifactsDir}/${ARTIFACT_FILES.shotsDir}"

It captures both contract viewports with contract naming. Optional flags:
\`--viewport mobile|desktop\` (default both), \`--wait-selector <css>\`, \`--wait-ms <n>\`,
\`--clerk-token <t>\` / env \`CLERK_TESTING_TOKEN\` for Clerk-gated pages (also handles Turnstile in testing mode).

Ignoring this contract does not fail your run, but following it gets your work an automated
visual review the operator actually sees. Prefer following it.`;
}

/** Coerce one raw steps.json entry into an ArtifactStep, or return an error string. */
function coerceStep(raw: unknown, index: number): ArtifactStep | string {
  if (!raw || typeof raw !== "object") return `entry ${index}: not an object`;
  const obj = raw as Record<string, unknown>;
  const id = typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : "";
  const title = typeof obj.title === "string" && obj.title.trim() ? obj.title.trim() : "";
  if (!id && !title) return `entry ${index}: missing both id and title`;
  const rawStatus = typeof obj.status === "string" ? obj.status.toLowerCase().trim() : "";
  const status: ArtifactStepStatus =
    rawStatus === "done" || rawStatus === "skipped" || rawStatus === "failed"
      ? (rawStatus as ArtifactStepStatus)
      : "done";
  const step: ArtifactStep = {
    id: id || `step-${index + 1}`,
    title: title || id,
    status,
  };
  if (typeof obj.note === "string" && obj.note.trim()) step.note = obj.note.trim();
  return step;
}

/**
 * Parse a steps.json body. Tolerant: accepts a bare array or `{ steps: [...] }`,
 * coerces unknown statuses to "done", and skips (but reports) invalid entries.
 */
export function parseStepsJson(raw: string): { steps: ArtifactStep[]; errors: string[] } {
  const errors: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { steps: [], errors: [`invalid JSON: ${err instanceof Error ? err.message : err}`] };
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { steps?: unknown }).steps)
      ? ((parsed as { steps: unknown[] }).steps as unknown[])
      : null;
  if (!list) return { steps: [], errors: ["expected an array or { steps: [...] }"] };

  const steps: ArtifactStep[] = [];
  list.forEach((entry, i) => {
    const result = coerceStep(entry, i);
    if (typeof result === "string") errors.push(result);
    else steps.push(result);
  });
  return { steps, errors };
}

/**
 * Extract the overall verdict + per-claim PASS/FAIL rows from a verification.md.
 * DO-NOT-SHIP is checked before SHIP (the former contains the latter).
 */
export function parseVerificationMd(md: string): VerificationSummary {
  const verdict: VerificationSummary["verdict"] = /\bDO[\s_-]?NOT[\s_-]?SHIP\b/i.test(md)
    ? "DO-NOT-SHIP"
    : /\bSHIP\b/.test(md)
      ? "SHIP"
      : null;

  const claims: VerificationClaim[] = [];
  for (const line of md.split("\n")) {
    // GFM table row containing a PASS or FAIL cell.
    if (!/^\s*\|.*\|\s*$/.test(line)) continue;
    const cells = line
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((c) => c.trim());
    if (cells.length < 2) continue;
    const statusCell = cells.find((c) => /^(✅\s*)?PASS$|^(❌\s*)?FAIL$/i.test(c));
    if (!statusCell) continue;
    const claimCell = cells.find((c) => c !== statusCell && c.length > 2 && !/^[-: ]+$/.test(c));
    if (!claimCell) continue;
    claims.push({
      claim: claimCell,
      status: /FAIL/i.test(statusCell) ? "FAIL" : "PASS",
    });
  }
  return { verdict, claims };
}

/** Parse a contract shot filename into its step/viewport parts. */
export function parseShotName(file: string): { step: string; viewport: string } {
  const m = /^(.+)-(mobile|desktop)\.png$/i.exec(file);
  if (m) return { step: m[1], viewport: m[2].toLowerCase() };
  return { step: file.replace(/\.png$/i, ""), viewport: "" };
}

/**
 * Read everything the contract defines from a run's artifacts dir.
 * Best-effort: missing files come back empty, never throws.
 */
export function readRunArtifacts(dir: string): RunArtifacts {
  const readText = (name: string): string => {
    try {
      return readFileSync(join(dir, name), "utf8");
    } catch {
      return "";
    }
  };

  const reportMd = readText(ARTIFACT_FILES.report);
  const stepsRaw = readText(ARTIFACT_FILES.steps);
  const { steps, errors: stepsErrors } = stepsRaw
    ? parseStepsJson(stepsRaw)
    : { steps: [], errors: [] };
  const verificationMd = readText(ARTIFACT_FILES.verification);
  const verification = verificationMd
    ? parseVerificationMd(verificationMd)
    : { verdict: null, claims: [] };

  let shots: ArtifactShot[] = [];
  try {
    const shotsDir = join(dir, ARTIFACT_FILES.shotsDir);
    if (existsSync(shotsDir)) {
      shots = readdirSync(shotsDir)
        .filter((f) => f.toLowerCase().endsWith(".png"))
        .sort()
        .map((file) => ({ file, path: join(shotsDir, file), ...parseShotName(file) }));
    }
  } catch {
    /* best-effort */
  }

  return { dir, reportMd, steps, stepsErrors, shots, verificationMd, verification };
}
