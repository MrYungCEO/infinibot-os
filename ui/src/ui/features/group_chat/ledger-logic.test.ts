import { describe, expect, it } from "vitest";
import { toDisplayMessages } from "./logic";

describe("group chat ledger in display messages", () => {
  it("carries the activity ledger and unverified flags onto agent + status messages", () => {
    const activity = [{ tool: "exec", summary: "git push origin main", ok: false, exitCode: 128, push: { ok: false } }];
    const unverified = [{ kind: "push", claim: "Pushed.", reason: "the git push FAILED" }];
    const msgs = toDisplayMessages([
      { role: "assistant", content: [{ type: "text", text: "Pushed." }], timestamp: 1, groupChat: { messageId: "a", kind: "agent", agentId: "coder", activity, unverified } },
      { role: "assistant", content: [{ type: "text", text: "Run update" }], timestamp: 2, groupChat: { messageId: "b", kind: "status", activity } },
      { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 3, groupChat: { messageId: "c", kind: "agent", agentId: "qa" } },
    ]);
    expect(msgs[0]).toMatchObject({ kind: "agent", activity, unverified });
    expect(msgs[1]).toMatchObject({ kind: "status", activity });
    expect(msgs[2].activity).toBeUndefined();
    expect(msgs[2].unverified).toBeUndefined();
  });
});
