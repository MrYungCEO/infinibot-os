import { describe, expect, it } from "vitest";

import { redactConnectFrame } from "./server.js";

describe("redactConnectFrame", () => {
  it("never lets the gateway credential reach a log line", () => {
    const frame = {
      type: "req",
      id: "1",
      method: "connect",
      params: {
        auth: { password: "audit-pass-123", token: "tok-abc" },
        device: { id: "d1", signature: "sig", publicKey: "pk" },
        client: { id: "mcp" },
      },
    };
    const out = JSON.stringify(redactConnectFrame(frame));
    expect(out).not.toContain("audit-pass-123");
    expect(out).not.toContain("tok-abc");
    expect(out).not.toContain('"sig"');
    expect(out).toContain('"mcp"');
    // original untouched
    expect(frame.params.auth.password).toBe("audit-pass-123");
  });
});
