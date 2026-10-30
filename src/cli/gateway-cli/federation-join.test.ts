import { describe, expect, it, vi } from "vitest";

import { mergeInviteIntoConfig, runJoinCommand } from "./federation-join.js";
import { encodeInvite, type FederationInvite } from "../../federation/invite.js";
import type { SatelliteToken } from "../../federation/security.js";
import type { InfinibotConfig } from "../../config/config.js";

function buildInvite(): FederationInvite {
  const token: SatelliteToken = {
    satelliteId: "node_xyz",
    issuedAt: 1,
    expiresAt: Date.now() + 60_000,
    signature: "f".repeat(64),
    permissions: { level: "full", allowedOperations: ["session.spawn"] },
  };
  return {
    v: 1,
    masterUrl: "https://master.example",
    iss: "master.example",
    label: "test-sat",
    satelliteIdHint: "node_xyz",
    satelliteToken: token,
    expiresAt: Date.now() + 60_000,
  };
}

describe("mergeInviteIntoConfig", () => {
  it("sets federation keys and preserves unrelated config", () => {
    const cur: InfinibotConfig = {
      // unrelated key kept verbatim
      gateway: { port: 18789 },
      federation: { mode: "standalone" },
    } as unknown as InfinibotConfig;
    const inv = buildInvite();
    const { next, changedKeys } = mergeInviteIntoConfig(cur, inv);
    expect(next.federation?.mode).toBe("satellite");
    expect(next.federation?.enabled).toBe(true);
    expect(next.federation?.masterUrl).toBe("wss://master.example/federation");
    expect(next.federation?.nodeId).toBe("node_xyz");
    expect(next.federation?.label).toBe("test-sat");
    expect(next.federation?.authToken).toEqual(inv.satelliteToken);
    expect(next.gateway?.port).toBe(18789); // preserved
    expect(changedKeys).toContain("federation.mode");
    expect(changedKeys).toContain("federation.authToken");
  });

  it("adopts satelliteName as nodeName and never inherits the master label", () => {
    const cur: InfinibotConfig = {
      federation: { mode: "standalone", nodeName: "old-name" },
    } as unknown as InfinibotConfig;
    const inv = { ...buildInvite(), satelliteName: "CEO laptop 5050" };
    const { next } = mergeInviteIntoConfig(cur, inv);
    expect(next.federation?.nodeName).toBe("CEO laptop 5050");
    // label still carries the hub name for the confirmation prompt …
    expect(next.federation?.label).toBe("test-sat");
    // … but must NOT leak into the satellite's own display name.
    expect(next.federation?.nodeName).not.toBe("test-sat");
  });

  it("keeps the satellite's existing name when the invite has no satelliteName (back-compat)", () => {
    const cur: InfinibotConfig = {
      federation: { mode: "standalone", nodeName: "existing-sat" },
    } as unknown as InfinibotConfig;
    const inv = buildInvite(); // no satelliteName
    const { next } = mergeInviteIntoConfig(cur, inv);
    expect(next.federation?.nodeName).toBe("existing-sat");
  });
});

describe("runJoinCommand", () => {
  it("persists config and does NOT restart when --config-only", async () => {
    const inv = buildInvite();
    const encoded = encodeInvite(inv);
    const writeFn = vi.fn(async () => {});
    const restartFn = vi.fn(async () => {});
    const loadFn = vi.fn(() => ({}) as InfinibotConfig);

    const res = await runJoinCommand({
      encoded,
      yes: true,
      configOnly: true,
      loadConfigFn: loadFn,
      writeConfigFn: writeFn,
      restartGateway: restartFn,
      log: () => {},
      error: () => {},
    });

    expect(writeFn).toHaveBeenCalledTimes(1);
    expect(restartFn).not.toHaveBeenCalled();
    expect(res.restarted).toBe(false);
    expect(res.config.federation?.masterUrl).toBe("wss://master.example/federation");
  });

  it("calls restart by default when --yes and not --config-only", async () => {
    const inv = buildInvite();
    const encoded = encodeInvite(inv);
    const writeFn = vi.fn(async () => {});
    const restartFn = vi.fn(async () => {});
    const loadFn = vi.fn(() => ({}) as InfinibotConfig);

    const res = await runJoinCommand({
      encoded,
      yes: true,
      loadConfigFn: loadFn,
      writeConfigFn: writeFn,
      restartGateway: restartFn,
      log: () => {},
      error: () => {},
    });

    expect(restartFn).toHaveBeenCalledTimes(1);
    expect(res.restarted).toBe(true);
  });

  it("refuses without --yes on non-TTY", async () => {
    const inv = buildInvite();
    const encoded = encodeInvite(inv);
    await expect(
      runJoinCommand({
        encoded,
        yes: false,
        stdinIsTTY: false,
        loadConfigFn: () => ({}) as InfinibotConfig,
        writeConfigFn: async () => {},
        restartGateway: async () => {},
        log: () => {},
        error: () => {},
      }),
    ).rejects.toThrow(/non-tty/);
  });
});
