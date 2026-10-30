/**
 * Browser-specific error pattern classifier + healing queue writer.
 *
 * Matches errors from failed browser-automation agent runs against known
 * patterns and proposes targeted skill patches to the healing queue.
 * Conservative: only fires when a specific, recognizable error string is found.
 * False-positive healing pollutes the queue, so patterns are kept tight.
 */

import { existsSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

import { HEALING_QUEUE_PATH } from "../claude-code/skill-system.js";
import { addSkillActivity } from "./queue-store.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("agent").child("browser-healing");

// ── Error patterns ─────────────────────────────────────────────────────────────

export interface BrowserHealingPattern {
  /** Conservative regex — must match the exact error text. */
  regex: RegExp;
  /** Which skill gets the healing proposal. */
  skillName: string;
  /** Short human-readable description of what triggered this. */
  description: string;
  /** Proposed amendment note — appended to the healing entry for operator review. */
  proposedAmendment: string;
}

export const BROWSER_HEALING_PATTERNS: BrowserHealingPattern[] = [
  {
    regex:
      /selector\s+not\s+found|TimeoutError.*waiting\s+for\s+selector|Locator\..*timeout.*exceeded/i,
    skillName: "browser-selector-strategy",
    description: "Selector not found / timeout waiting for element",
    proposedAmendment:
      "The selector strategy failed. Consider: 1) Switch to ARIA role selector (getByRole). " +
      "2) Wait for hydration before querying. 3) Check if element is in shadow DOM. " +
      "4) Add a waitForLoadState('networkidle') before the selector.",
  },
  {
    regex:
      /Can't reach clawd browser control service|clawd.*unavailable|relay.*down|ECONNREFUSED.*21716/i,
    skillName: "browser-attach",
    description: "clawd browser relay unreachable",
    proposedAmendment:
      "The InfiniBot Browser Relay (clawd) was unreachable. " +
      "Update procedure: 1) Health-check curl http://localhost:21716/health. " +
      "2) If down, fall back to raw CDP at ws://127.0.0.1:18792/cdp (see browser-cdp-fallback skill). " +
      "3) Confirm the Chrome extension relay is installed via chrome://extensions.",
  },
  {
    regex:
      /net::ERR_(?:CONNECTION_REFUSED|NAME_NOT_RESOLVED|FAILED|CERT_AUTHORITY_INVALID|ABORTED)/i,
    skillName: "browser-error-classification",
    description: "Network error (net::ERR_*)",
    proposedAmendment:
      "A net::ERR_* network error was encountered. Add this pattern to the error catalog: " +
      "check if the server is running (ERR_CONNECTION_REFUSED), if the hostname resolves " +
      "(ERR_NAME_NOT_RESOLVED), or if TLS cert is invalid (ERR_CERT_AUTHORITY_INVALID). " +
      "For ERR_CERT_AUTHORITY_INVALID: launch Chrome with --ignore-certificate-errors.",
  },
  {
    regex: /"errors"\s*:\s*\[|"error"\s*:\s*\{.*"code"|200.*with.*error|status.*200.*error/i,
    skillName: "browser-response-body-capture",
    description: "HTTP 200 response contained errors array/object",
    proposedAmendment:
      "Encountered HTTP 200 with error payload. Pattern: always parse response body JSON and " +
      "check for body.errors[], body.error, or body.data === null. Do not assume HTTP 200 = success. " +
      "Add assertApiSuccess() helper to your code.",
  },
  {
    regex: /getUserMedia.*NotAllowedError|mediaDevices.*undefined|secure.?context.*required/i,
    skillName: "browser-error-classification",
    description: "getUserMedia / secure-context failure (HTTPS required)",
    proposedAmendment:
      "getUserMedia or a Web API requiring a secure context failed. " +
      "These APIs (getUserMedia, WebAuthn, Web Bluetooth, Clipboard) are only available " +
      "over HTTPS or localhost. For testing: navigate to the HTTPS version of the page, " +
      "or use page.context().grantPermissions() to pre-grant. " +
      "Check: await page.evaluate(() => window.isSecureContext).",
  },
  {
    regex: /Tab not found|Protocol error.*No such target|Target closed|target.*closed/i,
    skillName: "browser-attach",
    description: "Stale tab reference (tab closed or Chrome restarted)",
    proposedAmendment:
      "Tab ID became stale (tab was closed or Chrome restarted). " +
      "Never cache tab IDs across runs. Always re-list tabs via browser.tabs() before acting. " +
      "Find tab by URL/title pattern, not by saved ID.",
  },
  {
    regex: /Execution context was destroyed|most likely because of a navigation/i,
    skillName: "browser-error-classification",
    description: "Frame detached during execution (navigation occurred)",
    proposedAmendment:
      "Execution context destroyed by navigation. After any page.goto() or click that triggers " +
      "navigation, re-query all element handles — they are invalidated. " +
      "Pattern: await page.waitForNavigation(); then page.getByRole('button') again.",
  },
  {
    regex: /Access-Control-Allow-Origin|CORS policy|blocked by CORS/i,
    skillName: "browser-error-classification",
    description: "CORS blocked cross-origin request",
    proposedAmendment:
      "Cross-origin request blocked by CORS policy. " +
      "Use page.route() to intercept and proxy the request through Node.js " +
      "(not the browser), which is not subject to CORS. " +
      "Alternatively, CDP Fetch.enable with domain overrides can bypass CORS for testing.",
  },
];

// ── Queue entry ────────────────────────────────────────────────────────────────

interface BrowserHealingEntry {
  id: string;
  at: string;
  runId: string;
  agentId: string;
  skillName: string;
  proposedPatch: string;
  draftPath: string;
  task: string;
  exitCode: number;
  browserPattern: string;
}

function appendHealingEntry(entry: BrowserHealingEntry): void {
  try {
    const dir = dirname(HEALING_QUEUE_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(HEALING_QUEUE_PATH, JSON.stringify(entry) + "\n", "utf-8");
  } catch (err) {
    log.warn(`browser-healing: failed to append queue entry: ${err}`);
  }
}

// ── Main export ────────────────────────────────────────────────────────────────

export interface BrowserHealingParams {
  runId: string;
  agentId: string;
  task: string;
  exitCode: number;
  workdir: string;
  /** Combined stdout tail + stderr tail from the failed run. */
  errorText: string;
}

/**
 * Classify the error text against known browser failure patterns.
 * Returns the first matching pattern, or null if no browser-specific pattern matches.
 */
export function classifyBrowserError(errorText: string): BrowserHealingPattern | null {
  if (!errorText) return null;
  return BROWSER_HEALING_PATTERNS.find((p) => p.regex.test(errorText)) ?? null;
}

/**
 * If the error text matches a known browser pattern, append a healing proposal
 * to the HEALING_QUEUE_PATH for operator review.
 *
 * Called from the post-mortem path when a claude_coder run exits non-zero
 * and the generic post-mortem is insufficient or disabled.
 *
 * Conservative: if no pattern matches, returns false and does nothing.
 */
export function queueBrowserHealingIfNeeded(params: BrowserHealingParams): boolean {
  const match = classifyBrowserError(params.errorText);
  if (!match) return false;

  log.info(
    `browser-healing: matched pattern for skill "${match.skillName}" in run ${params.runId}`,
  );

  const id = randomUUID();
  const at = new Date().toISOString();

  // Write proposed patch file alongside skill dir
  const skillDir = join(homedir(), ".infinibot", "skills", "browser", match.skillName);
  const draftPath = join(skillDir, `${match.skillName}.SKILL.md.proposed`);
  const proposedPatch = [
    `# Proposed amendment for ${match.skillName}`,
    `# Trigger: ${match.description}`,
    `# Run: ${params.runId} | exitCode: ${params.exitCode}`,
    `# Task: ${params.task.slice(0, 200)}`,
    ``,
    match.proposedAmendment,
  ].join("\n");

  try {
    if (!existsSync(skillDir)) mkdirSync(skillDir, { recursive: true });
    writeFileSync(draftPath, proposedPatch, "utf-8");
    log.info(`browser-healing: wrote proposed patch → ${draftPath}`);
  } catch (err) {
    log.warn(`browser-healing: failed to write proposed patch: ${err}`);
  }

  const entry: BrowserHealingEntry = {
    id,
    at,
    runId: params.runId,
    agentId: params.agentId,
    skillName: match.skillName,
    proposedPatch,
    draftPath,
    task: params.task.slice(0, 200),
    exitCode: params.exitCode,
    browserPattern: match.description,
  };

  appendHealingEntry(entry);

  addSkillActivity({
    ts: Date.now(),
    type: "healing_queued",
    message: `Browser healing queued for "${match.skillName}": ${match.description}`,
    relatedId: id,
    relatedSlug: match.skillName,
  });

  log.info(`browser-healing: queued entry id=${id} skill="${match.skillName}"`);
  return true;
}
