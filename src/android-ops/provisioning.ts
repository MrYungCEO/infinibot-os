/**
 * Account provisioning workflow (§5).
 *
 * The automation boundary is the entire point of this file. Administrative
 * work — creating the internal record, generating a password *reference*,
 * attaching a durable recovery mailbox, picking the least-loaded handset,
 * navigating to the normal signup flow — is automated. Everything a platform
 * puts in front of a human to establish that a human is present stays a
 * checkpoint an operator must clear on the device.
 *
 * `mode` on each step is what the UI renders as the AUTOMATED / SUPERVISED /
 * HUMAN badge, and `advanceProvisioning` refuses to auto-complete a `human`
 * step — that guard is the compliance boundary in executable form.
 */

import { randomUUID } from "node:crypto";
import { ComplianceViolationError, assertHumanCheckpoint } from "./compliance.js";
import type { ProvisioningRun, ProvisioningStep, StepStatus } from "./types.js";

/**
 * The canonical checklist. Ordered; `mode` decides who may complete each step.
 */
export function buildProvisioningSteps(): ProvisioningStep[] {
  const step = (
    key: string,
    label: string,
    mode: ProvisioningStep["mode"],
    note: string | null = null,
  ): ProvisioningStep => ({ key, label, mode, status: "pending", note, completedAt: null });

  return [
    step("record", "Create internal account record", "automated"),
    step(
      "password",
      "Generate unique password into the vault",
      "automated",
      "A high-entropy password is generated straight into the secrets vault. The value is never returned to the dashboard or stored in this database — only its reference.",
    ),
    step(
      "recovery_email",
      "Create durable recovery mailbox",
      "automated",
      "Provisioned on domain-controlled email infrastructure you own. Disposable or third-party throwaway addresses are not used.",
    ),
    step("device", "Assign least-loaded phone", "automated"),
    step(
      "signup",
      "Open the platform's normal signup flow",
      "supervised",
      "Navigates to the standard, public signup screen on the assigned handset. No alternate or undocumented entry points.",
    ),
    step(
      "verification",
      "Email / SMS verification and any human-verification challenge",
      "human",
      "Completed by an operator on the device. This system does not solve, bypass or outsource verification challenges.",
    ),
    step("profile", "Configure profile assets", "supervised"),
    step(
      "two_factor",
      "Enable 2FA and vault the recovery codes",
      "supervised",
      "An operator enables authenticator-based 2FA; recovery codes are written directly to the vault and are not displayed in the dashboard by default.",
    ),
    step("health_check", "Post-provisioning health check", "automated"),
  ];
}

export interface StartProvisioningInput {
  handle: string;
  platform: ProvisioningRun["platform"];
  deviceId: string | null;
  now: number;
  accountId?: string;
  /** Real recovery address, when a domain with catch-all is configured. */
  recoveryEmail?: string | null;
  /** Set once a password has genuinely been encrypted into the secret store. */
  vaultedSecretRef?: string | null;
}

export function startProvisioningRun(input: StartProvisioningInput): ProvisioningRun {
  const steps = buildProvisioningSteps();
  // Only mark a step done when the work behind it actually happened. This block
  // used to flip "record", "password" and "recovery_email" to done the instant a
  // run started, so the board showed a vaulted password and a provisioned
  // mailbox for an account that had neither — the account row itself was not
  // written until the run completed.
  const markDone = (key: string) => {
    const step = steps.find((s) => s.key === key)!;
    step.status = "done";
    step.completedAt = input.now;
    return step;
  };
  const markPending = (key: string, note: string) => {
    const step = steps.find((s) => s.key === key)!;
    step.status = "pending";
    step.note = note;
    return step;
  };

  // The account row IS written at start by the caller, so this one is true.
  markDone("record");

  // A password is only "vaulted" once storage actually holds it.
  if (input.vaultedSecretRef) {
    const step = markDone("password");
    step.note = `Generated and encrypted into the secret store as ${input.vaultedSecretRef}. The value never enters this database, an RPC payload or the dashboard.`;
  } else {
    markPending(
      "password",
      "The secret store could not be written, so nothing was vaulted. Store the password yourself and clear this step — the console keeps only the reference, never the value.",
    );
  }

  // Catch-all on a domain you own makes <handle>@<domain> a real mailbox the
  // moment it is addressed; without a configured domain there is nothing to claim.
  if (input.recoveryEmail) {
    const step = markDone("recovery_email");
    step.note = `Recovery mail routes to ${input.recoveryEmail} via catch-all on a domain you control.`;
  } else {
    markPending(
      "recovery_email",
      "No recovery domain configured. Set one under Email with catch-all forwarding, or create the mailbox yourself and mark this done.",
    );
  }
  const deviceStep = steps.find((s) => s.key === "device")!;
  if (input.deviceId) {
    deviceStep.status = "done";
    deviceStep.completedAt = input.now;
  } else {
    deviceStep.status = "blocked";
    deviceStep.note = "No eligible handset — every phone is at capacity, offline or reserved.";
  }

  return {
    id: `prov-${randomUUID().slice(0, 8)}`,
    accountId: input.accountId ?? `acct-${randomUUID().slice(0, 8)}`,
    handle: input.handle,
    platform: input.platform,
    deviceId: input.deviceId,
    state: input.deviceId ? "running" : "waiting_operator",
    steps,
    startedAt: input.now,
    completedAt: null,
  };
}

export interface AdvanceStepInput {
  stepKey: string;
  status: StepStatus;
  actor: string;
  now: number;
  note?: string;
}

/**
 * Move one step. A `human` step may only be completed by a named operator —
 * an automated actor gets a {@link ComplianceViolationError}, which the RPC
 * layer surfaces as a refusal rather than a generic 500.
 */
export function advanceProvisioning(
  run: ProvisioningRun,
  input: AdvanceStepInput,
): ProvisioningRun {
  const steps = run.steps.map((s) => ({ ...s }));
  const step = steps.find((s) => s.key === input.stepKey);
  if (!step) throw new Error(`Unknown provisioning step "${input.stepKey}"`);

  if (step.mode === "human" && input.status === "done") {
    assertHumanCheckpoint(input.actor);
  }
  if (step.mode === "supervised" && input.status === "done" && !input.actor?.trim()) {
    throw new ComplianceViolationError(
      "unsupervised_step",
      `"${step.label}" is a supervised step and needs an accountable operator.`,
    );
  }

  step.status = input.status;
  step.note = input.note ?? step.note;
  step.completedAt = input.status === "done" ? input.now : null;

  const allDone = steps.every((s) => s.status === "done" || s.status === "skipped");
  const blocked = steps.some((s) => s.status === "blocked");
  const awaitingHuman = steps.some(
    (s) => s.mode === "human" && s.status !== "done" && s.status !== "skipped",
  );

  const state: ProvisioningRun["state"] = allDone
    ? "completed"
    : blocked || awaitingHuman
      ? "waiting_operator"
      : "running";

  return {
    ...run,
    steps,
    state,
    completedAt: state === "completed" ? input.now : null,
  };
}

/** The next thing a person actually has to do — drives the ACTION REQUIRED list. */
export function nextOperatorAction(run: ProvisioningRun): ProvisioningStep | null {
  return (
    run.steps.find((s) => s.status === "blocked") ??
    run.steps.find((s) => s.mode === "human" && s.status === "pending") ??
    null
  );
}
