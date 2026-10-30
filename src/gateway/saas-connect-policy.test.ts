import { describe, expect, it } from "vitest";

import { saasConnectAllowedWithoutClerk } from "./saas-connect-policy.js";

const base = { role: "operator", authOk: true, isLocalDirect: false };

describe("SaaS operator connect policy", () => {
  it("a Clerk session is always enough", () => {
    expect(saasConnectAllowedWithoutClerk({ ...base, authMethod: "clerk" })).toBe(true);
  });

  it("the gateway's own loopback clients keep shared-token/password auth", () => {
    for (const authMethod of ["token", "password"]) {
      expect(saasConnectAllowedWithoutClerk({ ...base, authMethod, isLocalDirect: true })).toBe(
        true,
      );
    }
  });

  it("a shared token through the edge (forwarded, not local-direct) is refused", () => {
    expect(saasConnectAllowedWithoutClerk({ ...base, authMethod: "token" })).toBe(false);
    expect(saasConnectAllowedWithoutClerk({ ...base, authMethod: "password" })).toBe(false);
  });

  it("device tokens, invites and Tailscale never grant tenant access, even from loopback", () => {
    for (const authMethod of ["device-token", "invite-token", "tailscale", undefined]) {
      expect(saasConnectAllowedWithoutClerk({ ...base, authMethod, isLocalDirect: true })).toBe(
        false,
      );
    }
  });

  it("backend nodes may use the shared secret; failed auth stays failed", () => {
    expect(saasConnectAllowedWithoutClerk({ ...base, role: "node", authMethod: "token" })).toBe(
      true,
    );
    expect(saasConnectAllowedWithoutClerk({ ...base, authOk: false, authMethod: "clerk" })).toBe(
      false,
    );
  });
});
