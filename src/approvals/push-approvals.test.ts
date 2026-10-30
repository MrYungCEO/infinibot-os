import { describe, expect, it, vi } from "vitest";
import type { ApprovalRecord } from "../autonomy/approval-registry.js";
import { approvalNotification, handleApprovalPushEvent } from "./push-approvals.js";

const rec = (over: Partial<ApprovalRecord> = {}): ApprovalRecord =>
  ({
    id: "apv_1",
    source: "tool",
    requester: { agentId: "main", sessionKey: null, runId: null, label: null },
    title: "Send invoice",
    summary: "Email the invoice to ACME",
    details: "",
    risk: "high",
    options: ["approve", "deny"],
    createdAt: 1,
    expiresAt: 2,
    status: "pending",
    ...over,
  }) as unknown as ApprovalRecord;

describe("approval push", () => {
  it("deep-links to approvals/<id> with an input_required category", () => {
    const n = approvalNotification(rec());
    expect(n).toMatchObject({
      category: "agent.input_required",
      severity: "error",
      deepLink: "infinibot://approvals/apv_1",
      sourceId: "apv_1",
      body: "Email the invoice to ACME",
    });
    expect(approvalNotification(rec({ risk: "low" })).severity).toBe("warn");
  });

  it("pushes only live requests", async () => {
    const emit = vi.fn(async () => "id");
    await handleApprovalPushEvent({ type: "requested", record: rec() }, emit);
    await handleApprovalPushEvent(
      { type: "resolved", record: rec({ status: "approved" } as never) },
      emit,
    );
    await handleApprovalPushEvent(
      { type: "requested", record: rec({ status: "denied" } as never) },
      emit,
    );
    expect(emit).toHaveBeenCalledTimes(1);
  });
});
