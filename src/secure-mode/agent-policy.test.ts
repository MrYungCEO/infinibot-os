import { describe, expect, it } from "vitest";
import type { InfinibotConfig } from "../config/config.js";
import { isSecureOnlyAgent, secureOnlyBlockReason } from "./agent-policy.js";

const cfg = {
  agents: {
    list: [
      { id: "main", default: true },
      { id: "vault-keeper", secureOnly: true },
      { id: "Ledger", secureOnly: false },
    ],
  },
} as unknown as InfinibotConfig;

describe("secure-mode agent policy (agents.list[].secureOnly)", () => {
  it("reads the flag per agent, case-insensitively", () => {
    expect(isSecureOnlyAgent(cfg, "vault-keeper")).toBe(true);
    expect(isSecureOnlyAgent(cfg, "VAULT-KEEPER")).toBe(true);
    expect(isSecureOnlyAgent(cfg, "ledger")).toBe(false);
    expect(isSecureOnlyAgent(cfg, "main")).toBe(false);
    expect(isSecureOnlyAgent(cfg, "missing")).toBe(false);
    expect(isSecureOnlyAgent(undefined, "vault-keeper")).toBe(false);
  });

  it("refuses normal-lane session keys for a secureOnly agent", () => {
    expect(secureOnlyBlockReason(cfg, "agent:vault-keeper:main")).toMatch(
      /always run in Secure Mode/,
    );
    expect(secureOnlyBlockReason(cfg, "agent:vault-keeper:subagent:abc")).toMatch(/vault-keeper/);
    expect(secureOnlyBlockReason(cfg, "agent:vault-keeper:groupchat-xyz")).not.toBeNull();
  });

  it("lets secure-lane keys through (the lane's own checks apply)", () => {
    expect(secureOnlyBlockReason(cfg, "agent:vault-keeper:secure-lq2x-abc123")).toBeNull();
    expect(secureOnlyBlockReason(cfg, "agent:vault-keeper:groupchat-sec-1")).toBeNull();
    expect(secureOnlyBlockReason(cfg, "agent:vault-keeper:gcmember-sec-1")).toBeNull();
  });

  it("never blocks other agents or missing keys", () => {
    expect(secureOnlyBlockReason(cfg, "agent:main:main")).toBeNull();
    expect(secureOnlyBlockReason(cfg, "agent:ledger:main")).toBeNull();
    expect(secureOnlyBlockReason(cfg, undefined)).toBeNull();
    expect(secureOnlyBlockReason(undefined, "agent:vault-keeper:main")).toBeNull();
  });

  it("resolves bare keys to the default agent", () => {
    const onlyDefault = {
      agents: { list: [{ id: "main", default: true, secureOnly: true }] },
    } as unknown as InfinibotConfig;
    expect(secureOnlyBlockReason(onlyDefault, "main")).toMatch(/"main"/);
  });
});
