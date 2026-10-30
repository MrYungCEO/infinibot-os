import { describe, expect, it } from "vitest";

import type { ApprovalRecord } from "../../autonomy/approval-registry.js";
import type { CompletionRecord } from "../../verification/store.js";
import {
  decisionFromApproval,
  decisionFromBlockedTask,
  decisionFromCompletion,
} from "./owner-decisions.js";

describe("owner decision read model", () => {
  it("projects a pending approval with its run target and risk", () => {
    const decision = decisionFromApproval({
      id: "approval-1",
      title: "Deploy release",
      summary: "Deploy the verified build?",
      details: "Production deploy to tenant fleet",
      risk: "high",
      options: ["approve", "deny", "approve-with-note"],
      requester: { runId: "run-1", sessionKey: "agent:one", agentId: "coder" },
      createdAt: 10,
    } as ApprovalRecord);

    expect(decision).toMatchObject({
      id: "approval:approval-1",
      kind: "approval",
      risk: "high",
      allowText: true,
      target: { approvalId: "approval-1", runId: "run-1", sessionKey: "agent:one" },
    });
    expect(decision.choices.map((choice) => choice.action)).toEqual(["approve", "deny"]);
  });

  it("projects needs_input as a replyable decision using the open question", () => {
    const decision = decisionFromCompletion({
      runId: "run-input",
      childSessionKey: "agent:input",
      label: "Release agent",
      task: "Ship release",
      state: "needs_input",
      startedAt: 20,
      updatedAt: 30,
      result: {
        summary: "Waiting",
        open_issues: ["Which region should go first?", "Asia", "Europe"],
      },
    } as CompletionRecord);

    expect(decision).toMatchObject({
      id: "run:run-input",
      kind: "run_input",
      question: "Which region should go first?",
      allowText: true,
      target: { runId: "run-input", sessionKey: "agent:input" },
    });
    expect(decision.choices.map((choice) => choice.action)).toEqual(["Asia", "Europe"]);
  });

  it("projects owner-blocked runs and standalone blocked kanban tasks", () => {
    const run = decisionFromCompletion({
      runId: "run-owner",
      childSessionKey: "agent:owner",
      label: "Owner gate",
      task: "Choose rollout",
      state: "needs_owner",
      startedAt: 40,
      updatedAt: 50,
      result: { summary: "Two safe strategies remain", open_issues: [] },
    } as CompletionRecord);
    const task = decisionFromBlockedTask({
      id: "task-1",
      title: "Confirm migration window",
      description: "Owner must choose the maintenance window.",
      status: "review",
      autonomousStatus: "blocked",
      projectId: "project-1",
      createdAt: 60,
      updatedAt: 70,
    });

    expect(run.kind).toBe("run_owner");
    expect(run.choices.map((choice) => choice.action)).toEqual(["continue", "accept", "reject"]);
    expect(task).toMatchObject({
      id: "task:task-1",
      kind: "kanban_blocked",
      allowText: true,
      target: { taskId: "task-1", projectId: "project-1" },
    });
  });
});
