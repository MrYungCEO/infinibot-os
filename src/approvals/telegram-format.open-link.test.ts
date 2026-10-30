import { describe, expect, it } from "vitest";
import type { ApprovalRecord } from "../autonomy/approval-registry.js";
import { buildCardKeyboard, formatApprovalCard, formatDigest } from "./telegram-format.js";

const rec = (id: string, status = "pending"): ApprovalRecord =>
  ({
    id,
    source: "tool",
    requester: { agentId: "main", sessionKey: null, runId: null, label: null },
    title: `Do ${id}`,
    summary: "",
    details: "",
    risk: "medium",
    options: ["approve", "deny"],
    createdAt: 0,
    expiresAt: 60_000,
    status,
    decidedVia: null,
  }) as unknown as ApprovalRecord;

describe("approval Telegram Open link", () => {
  const https = "https://box.ts.net/m/approvals/a1";
  it("card: Open URL row after the callback rows", () => {
    const kb = buildCardKeyboard(rec("a1"), { webUrl: https });
    expect(kb.at(-1)).toEqual([{ text: "🔗 Open", url: https }]);
    expect(
      kb
        .slice(0, -1)
        .flat()
        .every((b) => "callback_data" in b),
    ).toBe(true);
    expect(formatApprovalCard(rec("a1"), { now: 0, webUrl: https })).not.toContain("Open:");
    expect(buildCardKeyboard(rec("a1"))).toHaveLength(2);
  });
  it("card: unroutable URL → escaped text line, no button", () => {
    const url = "http://100.64.0.1:18789/m/approvals/a1?x=1&y=2";
    expect(buildCardKeyboard(rec("a1"), { webUrl: url })).toHaveLength(2);
    expect(formatApprovalCard(rec("a1"), { now: 0, webUrl: url })).toContain(
      "Open: http://100.64.0.1:18789/m/approvals/a1?x=1&amp;y=2",
    );
  });
  it("digest: one Open row while anything is pending", () => {
    const list = "https://box.ts.net/m/approvals";
    const d = formatDigest([rec("a1"), rec("a2")], { now: 0, webUrl: list });
    expect(d.keyboard.at(-1)).toEqual([{ text: "🔗 Open", url: list }]);
    const done = formatDigest([rec("a1", "approved"), rec("a2", "denied")], {
      now: 0,
      webUrl: list,
    });
    expect(done.keyboard).toEqual([]);
  });
});
