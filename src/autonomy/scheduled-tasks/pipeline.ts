/**
 * The approval pipeline as a pure state machine. The service applies side
 * effects (goal runs, deploy commands, notifications) based on the returned
 * `effect`; this module only decides whether a transition is legal.
 */

import type { ApprovalPolicy, DecisionAction, ItemStage } from "./types.js";

export type SystemEvent = "wake" | "build_ok" | "build_fail" | "deploy_ok" | "deploy_fail";

export type PipelineEffect =
  | "none"
  | "start_build"
  | "retry_build"
  | "continue_build"
  | "cancel_build"
  | "start_deploy"
  | "retry_deploy"
  | "notify_suggested"
  | "notify_ready"
  | "notify_build_failed"
  | "notify_deploy_failed"
  | "final_report";

export interface Transition {
  to: ItemStage;
  effect: PipelineEffect;
}

export class PipelineError extends Error {}

type Input = DecisionAction | SystemEvent;

/** Owner-facing labels for the stages (UI + Telegram). */
export const STAGE_LABEL: Record<ItemStage, string> = {
  suggested: "Suggested",
  snoozed: "Snoozed",
  rejected: "Rejected",
  approved: "Approved",
  building: "Building",
  build_failed: "Build failed",
  awaiting_deploy: "Verified · awaiting deploy approval",
  deploy_rejected: "Deploy rejected",
  deploying: "Deploying",
  deploy_failed: "Deploy failed",
  deployed: "Deployed",
};

/**
 * Next stage for `input` in `stage`, or a {@link PipelineError}. `hasInstruction`
 * guards actions that need text (modify / continue).
 */
export function transition(
  stage: ItemStage,
  input: Input,
  policy: ApprovalPolicy,
  opts: { hasInstruction?: boolean } = {},
): Transition {
  const needText = () => {
    if (!opts.hasInstruction) throw new PipelineError(`${input} needs an instruction`);
  };
  const approved = (): Transition =>
    policy.autoContinueOnApprove
      ? { to: "building", effect: "start_build" }
      : { to: "approved", effect: "none" };

  switch (stage) {
    case "suggested":
    case "snoozed":
      if (input === "approve") return approved();
      if (input === "modify") {
        needText();
        return approved();
      }
      if (input === "reject") return { to: "rejected", effect: "none" };
      if (input === "snooze") return { to: "snoozed", effect: "none" };
      if (input === "wake" && stage === "snoozed")
        return { to: "suggested", effect: "notify_suggested" };
      break;
    case "approved":
      if (input === "start") return { to: "building", effect: "start_build" };
      if (input === "modify") {
        needText();
        return { to: "approved", effect: "none" };
      }
      if (input === "reject") return { to: "rejected", effect: "none" };
      break;
    case "building":
      if (input === "build_ok")
        return policy.requireDeployApproval
          ? { to: "awaiting_deploy", effect: "notify_ready" }
          : { to: "deploying", effect: "start_deploy" };
      if (input === "build_fail") return { to: "build_failed", effect: "notify_build_failed" };
      if (input === "continue") {
        needText();
        return { to: "building", effect: "continue_build" };
      }
      if (input === "reject") return { to: "rejected", effect: "cancel_build" };
      break;
    case "build_failed":
      if (input === "retry") return { to: "building", effect: "retry_build" };
      if (input === "continue") {
        needText();
        return { to: "building", effect: "continue_build" };
      }
      if (input === "reject") return { to: "rejected", effect: "none" };
      break;
    case "awaiting_deploy":
      if (input === "approve_deploy") return { to: "deploying", effect: "start_deploy" };
      if (input === "reject_deploy" || input === "reject")
        return { to: "deploy_rejected", effect: "final_report" };
      if (input === "continue") {
        needText();
        return { to: "building", effect: "continue_build" };
      }
      break;
    case "deploying":
      if (input === "deploy_ok") return { to: "deployed", effect: "final_report" };
      if (input === "deploy_fail") return { to: "deploy_failed", effect: "notify_deploy_failed" };
      break;
    case "deploy_failed":
      if (input === "retry" || input === "approve_deploy")
        return { to: "deploying", effect: "retry_deploy" };
      if (input === "continue") {
        needText();
        return { to: "building", effect: "continue_build" };
      }
      if (input === "reject_deploy" || input === "reject")
        return { to: "deploy_rejected", effect: "final_report" };
      break;
    case "rejected":
    case "deploy_rejected":
    case "deployed":
      break;
  }
  throw new PipelineError(`cannot ${input} an item that is ${STAGE_LABEL[stage].toLowerCase()}`);
}

/** Owner actions offered for a stage (UI buttons + Telegram keyboards). */
export function actionsFor(stage: ItemStage, policy: ApprovalPolicy): DecisionAction[] {
  const all: DecisionAction[] = [
    "approve",
    "modify",
    "reject",
    "snooze",
    "start",
    "approve_deploy",
    "reject_deploy",
    "retry",
    "continue",
  ];
  return all.filter((a) => {
    try {
      transition(stage, a, policy, { hasInstruction: true });
      // "reject" is shown as "reject_deploy" once the build is verified.
      if (a === "reject" && (stage === "awaiting_deploy" || stage === "deploy_failed"))
        return false;
      if (a === "modify" && stage === "approved") return false;
      return true;
    } catch {
      return false;
    }
  });
}
