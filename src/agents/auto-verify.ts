/**
 * Auto-verify stage — adversarial post-run verification of a coder spawn.
 *
 * When a coder run is spawned with `verify:true` (or its task text contains
 * "Acceptance:"), run finalize auto-spawns ONE verifier agent on the same
 * backend. The verifier gets the original task text + the run's artifacts dir
 * and is instructed to adversarially check every acceptance criterion, writing
 * `verification.md` (per-claim PASS/FAIL table + overall SHIP / DO-NOT-SHIP)
 * into the artifacts dir. The work-review emitter then reads that file.
 *
 * Recursion guard — verifier runs must NEVER trigger auto-verify themselves.
 * Two independent layers enforce this:
 *   1. Structural: the verifier is spawned DIRECTLY via the coder backend
 *      (`spawnBackground`), never through the coder MCP tool, so it has no
 *      finalize hook and no verify option of its own.
 *   2. Explicit: a per-runId single-flight set + an on-disk marker
 *      (`verifier.json` in the artifacts dir) cap spawns at one per run even
 *      across duplicate finalize events.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { ARTIFACT_FILES } from "./artifacts/contract.js";
import { createCoderBackend } from "./coder-backend/registry.js";
import type { CLIAgentConfig, CoderBackendId } from "./coder-backend/types.js";

const log = createSubsystemLogger("agents/auto-verify");

/** Hard cap on the verifier child's runtime. */
export const VERIFIER_TIMEOUT_MINUTES = 30;

/** Matches the auto-on trigger in task briefs ("Acceptance: ..."). */
const ACCEPTANCE_RE = /\bacceptance\s*:/i;

/**
 * Decide whether a spawn should get the auto-verify stage.
 * Explicit `verify:false` always wins; explicit `verify:true` always wins;
 * otherwise auto-on when the task text contains "Acceptance:".
 */
export function shouldAutoVerify(opts: { verifyParam?: boolean; task: string }): boolean {
  if (opts.verifyParam === false) return false;
  if (opts.verifyParam === true) return true;
  return ACCEPTANCE_RE.test(opts.task);
}

/** In-memory single-flight: runIds that already spawned (or are spawning) a verifier. */
const verifierSpawned = new Set<string>();

/** Test helper — reset the single-flight memory. */
export function __resetAutoVerifyForTests(): void {
  verifierSpawned.clear();
}

/** The prompt handed to the verifier child. */
export function buildVerifierPrompt(opts: { task: string; artifactsDir: string }): string {
  const verificationPath = join(opts.artifactsDir, ARTIFACT_FILES.verification);
  return `You are an ADVERSARIAL VERIFIER. Another agent just finished the task below. Your job is to try to REFUTE its claims of completion, not to fix anything.

=== ORIGINAL TASK (verbatim) ===
${opts.task}
=== END ORIGINAL TASK ===

The run's artifacts directory is:
    ${opts.artifactsDir}
It may contain report.md (the agent's summary), steps.json (its step log), and shots/ (screenshots). Read them, but do NOT trust them — independently check the actual state of the workspace (files, builds, tests, git diff) against every acceptance criterion in the task. If the task lists explicit "Acceptance:" criteria, check each one; otherwise derive the concrete claims the task implies.

RULES:
- Verify by direct evidence (run builds/tests, read files, inspect output). A claim without evidence is a FAIL.
- Do NOT modify any project files. Your ONLY write is the verification report below.
- Be skeptical: default to FAIL when uncertain.

When done, write your report to EXACTLY this path:
    ${verificationPath}

Format (markdown):
1. A GFM table with one row per acceptance claim: | Claim | Result | Evidence | — Result is exactly PASS or FAIL.
2. A final line with the overall verdict: exactly \`SHIP\` (all claims pass) or \`DO-NOT-SHIP\` (any fail or unverifiable).

Write the file even if everything fails — an absent report is treated as unverified.`;
}

// ── Spawn plumbing ────────────────────────────────────────────────────────────

export interface VerifierSpawnHandle {
  /** Resolves when the verifier child exits (any outcome). */
  finalPromise: Promise<unknown>;
  pid?: number;
  kill?: (signal?: NodeJS.Signals) => void;
}

export type VerifierSpawnFn = (args: {
  runId: string;
  prompt: string;
  backendId: CoderBackendId;
  workdir: string;
}) => VerifierSpawnHandle;

/** Default spawner — direct backend spawn, never through the coder MCP tool. */
function defaultSpawnVerifier(args: {
  runId: string;
  prompt: string;
  backendId: CoderBackendId;
  workdir: string;
}): VerifierSpawnHandle {
  const cliCommand = args.backendId === "claude-code" ? "claude" : args.backendId;
  const env = { INFINIBOT_VERIFIER_FOR_RUN: args.runId };
  const config: CLIAgentConfig = {
    id: `${args.runId}-verify`,
    name: "auto-verifier",
    type: "cli",
    cliCommand,
    autoApprove: true,
    timeoutMinutes: VERIFIER_TIMEOUT_MINUTES,
    enabledMCPs: [],
    env,
  };
  return createCoderBackend(args.backendId).spawnBackground(config, args.prompt, args.workdir, {
    runId: `${args.runId}-verify`,
    env,
  });
}

export interface AutoVerifyResult {
  spawned: boolean;
  /** True when the verifier ran to completion inside the timeout. */
  completed: boolean;
  reason?: string;
}

const VERIFIER_MARKER = "verifier.json";

function markerPath(artifactsDir: string): string {
  return join(artifactsDir, VERIFIER_MARKER);
}

/** True when a verifier was already spawned for this run (memory OR disk marker). */
export function verifierAlreadySpawned(runId: string, artifactsDir: string): boolean {
  if (verifierSpawned.has(runId)) return true;
  try {
    if (existsSync(markerPath(artifactsDir))) {
      const raw = JSON.parse(readFileSync(markerPath(artifactsDir), "utf8")) as {
        runId?: string;
      };
      return raw?.runId === runId;
    }
  } catch {
    /* unreadable marker → treat as spawned to stay conservative */
    return true;
  }
  return false;
}

/**
 * Spawn the single verifier for a finalized run and wait for it (bounded by
 * VERIFIER_TIMEOUT_MINUTES). Never throws; never spawns twice for one runId.
 */
export async function maybeSpawnAutoVerifier(
  params: {
    runId: string;
    task: string;
    backendId: CoderBackendId;
    workdir: string;
    artifactsDir: string;
    verifyEnabled: boolean;
  },
  deps: { spawn?: VerifierSpawnFn; timeoutMs?: number } = {},
): Promise<AutoVerifyResult> {
  const { runId, artifactsDir } = params;
  if (!params.verifyEnabled) {
    return { spawned: false, completed: false, reason: "verify not enabled for this run" };
  }
  if (!artifactsDir) {
    return { spawned: false, completed: false, reason: "no artifacts dir" };
  }
  if (verifierAlreadySpawned(runId, artifactsDir)) {
    log.info("auto-verify: verifier already spawned for run, skipping", { runId });
    return { spawned: false, completed: false, reason: "verifier already spawned (cap: 1/run)" };
  }
  verifierSpawned.add(runId);

  try {
    writeFileSync(
      markerPath(artifactsDir),
      JSON.stringify({ runId, spawnedAt: Date.now(), backend: params.backendId }, null, 2),
    );
  } catch {
    /* marker is best-effort; the in-memory set still guards this process */
  }

  const spawn = deps.spawn ?? defaultSpawnVerifier;
  const timeoutMs = deps.timeoutMs ?? VERIFIER_TIMEOUT_MINUTES * 60_000;
  const prompt = buildVerifierPrompt({ task: params.task, artifactsDir });

  let handle: VerifierSpawnHandle;
  try {
    handle = spawn({ runId, prompt, backendId: params.backendId, workdir: params.workdir });
  } catch (err) {
    const reason = `verifier spawn failed: ${err instanceof Error ? err.message : err}`;
    log.warn("auto-verify: spawn failed", { runId, reason });
    return { spawned: false, completed: false, reason };
  }

  log.info("auto-verify: verifier spawned", {
    runId,
    backend: params.backendId,
    pid: handle.pid,
  });

  const completed = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      log.warn("auto-verify: verifier timed out — killing", { runId, timeoutMs });
      try {
        handle.kill?.("SIGKILL");
      } catch {
        /* already dead */
      }
      resolve(false);
    }, timeoutMs);
    if (typeof timer === "object" && timer && "unref" in timer) {
      (timer as { unref?: () => void }).unref?.();
    }
    handle.finalPromise.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(true); // child errored, but the wait is over — verification.md may still exist
      },
    );
  });

  return {
    spawned: true,
    completed,
    reason: completed ? undefined : `verifier exceeded ${Math.round(timeoutMs / 60_000)}m timeout`,
  };
}
