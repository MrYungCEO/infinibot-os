/**
 * Dev-mode pipeline simulator.
 *
 * With no rack attached, the ADB adapter honestly reports "no device" and the
 * live pipeline correctly refuses to move jobs. That would leave the operator
 * loop unusable on a laptop, so this module provides an explicitly-labelled
 * simulated execution path: same state machine, same guards, same audit trail —
 * only the *device outcome* is synthesised instead of read off a handset.
 *
 * Outcomes are deterministic per job id (hash-seeded, no `Math.random`) so a
 * demo rack behaves the same way twice and a test can assert on it. The mix is
 * intentionally imperfect — roughly one in eight attempts fails and one in
 * twelve raises a human checkpoint — because a pipeline that always succeeds
 * teaches an operator nothing about the states that matter.
 */

import type { ActionRequiredKind, PostJob } from "./types.js";

function hash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 0xffffffff;
}

export type SimulatedOutcome =
  | { kind: "advance" }
  | { kind: "fail"; error: string; bundleRef: string }
  | { kind: "escalate"; actionKind: ActionRequiredKind; message: string; bundleRef: string };

const FAILURES = [
  "Upload stalled mid-transfer — Wi-Fi dropped on the assigned handset.",
  "Media cache write failed: not enough free storage on the device.",
  "The app closed unexpectedly during the publish step.",
  "Publish timed out waiting for the platform to confirm the upload.",
];

const CHECKPOINTS: Array<{ kind: ActionRequiredKind; message: string }> = [
  {
    kind: "login_required",
    message:
      "The app session expired. Sign in on the assigned handset and re-trust the device, then resume this job.",
  },
  {
    kind: "security_challenge",
    message:
      "The platform raised a security check. An operator must review and respond on the device.",
  },
  {
    kind: "policy_prompt",
    message:
      "A policy/consent prompt is blocking the publish step and needs an accountable human decision.",
  },
  {
    kind: "two_factor",
    message:
      "A 2FA prompt appeared. Complete it with the vaulted authenticator under operator supervision.",
  },
];

/**
 * Decide what "the device" did for one step of one job.
 *
 * `step` participates in the seed so a job can succeed at DISPATCH and still
 * fail at PUBLISH — the interesting case for testing retries.
 */
export function simulateOutcome(
  job: PostJob,
  step: "dispatch" | "prepare" | "publish",
): SimulatedOutcome {
  const roll = hash(`${job.id}:${step}:${job.attempt}`);

  // Dispatch is cheap and rarely fails; the interesting failures are later.
  if (step === "dispatch") {
    return roll < 0.04
      ? {
          kind: "fail",
          error: "Handset did not acknowledge the job within the dispatch window.",
          bundleRef: `bundle://sim/${job.id}/dispatch`,
        }
      : { kind: "advance" };
  }

  if (roll < 0.085) {
    const error = FAILURES[Math.floor(hash(`${job.id}:err`) * FAILURES.length) % FAILURES.length];
    return { kind: "fail", error, bundleRef: `bundle://sim/${job.id}/${step}` };
  }

  if (roll < 0.085 + 0.075) {
    const pick =
      CHECKPOINTS[Math.floor(hash(`${job.id}:chk`) * CHECKPOINTS.length) % CHECKPOINTS.length];
    return {
      kind: "escalate",
      actionKind: pick.kind,
      message: pick.message,
      bundleRef: `bundle://sim/${job.id}/${step}`,
    };
  }

  return { kind: "advance" };
}

/** Plausible permalink for a simulated post — clearly marked as demo. */
export function simulatedPermalink(job: PostJob): string {
  return `https://example.com/${job.platform}/p/demo-${job.id.slice(-8)}`;
}
