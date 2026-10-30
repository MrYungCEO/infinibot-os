import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// license.ts reads `window` at module load; the UI suite also runs under plain
// node (`--browser.enabled=false`), so give it a minimal window first.
const win: Record<string, unknown> = {};
let lic: typeof import("./license");

beforeAll(async () => {
  vi.stubGlobal("window", win);
  lic = await import("./license");
});

afterEach(() => {
  delete win.__INFINIBOT_SAAS_MODE__;
  delete win.__infinibotGatewayClient;
  delete win.license;
  delete win.open;
});

describe("self-hosted (gateway not in SaaS mode)", () => {
  it("disables gating and grants every feature", () => {
    expect(lic.isLicenseGatingEnabled()).toBe(false);
    for (const f of lic.ALL_FEATURES) expect(lic.hasFeature(null, f)).toBe(true);
    // Even a stale free-tier state (e.g. an old localStorage cache) is ignored.
    expect(lic.hasFeature(lic.FREE_DEFAULT_STATE, "infinibot_voice_pack")).toBe(true);
    expect(lic.getLicenseState().source).toBe("self-hosted");
  });

  it("resolves state without calling the gateway or the Electron bridge", async () => {
    const call = vi.fn();
    const getPlan = vi.fn();
    win.__infinibotGatewayClient = { call };
    win.license = { getPlan };
    const state = await lic.loadLicenseState();
    expect(state.source).toBe("self-hosted");
    expect(state.features).toEqual(lic.ALL_FEATURES);
    expect(call).not.toHaveBeenCalled();
    expect(getPlan).not.toHaveBeenCalled();
  });

  it("never opens KinglyVault checkout", () => {
    const open = vi.fn();
    const openUpgrade = vi.fn();
    win.open = open;
    win.license = { openUpgrade };
    lic.openUpgrade("ceo");
    expect(open).not.toHaveBeenCalled();
    expect(openUpgrade).not.toHaveBeenCalled();
  });
});

describe("hosted SaaS mode", () => {
  it("keeps plan gating: free tier lacks paid features", async () => {
    win.__INFINIBOT_SAAS_MODE__ = true;
    expect(lic.isLicenseGatingEnabled()).toBe(true);
    expect(lic.hasFeature(null, "infinibot_voice_pack")).toBe(false);
    expect(lic.hasFeature(null, "task_manager")).toBe(true);
    expect(lic.hasFeature(lic.FREE_DEFAULT_STATE, "agent_builder")).toBe(false);
  });

  it("reads the plan from the gateway license.state RPC", async () => {
    win.__INFINIBOT_SAAS_MODE__ = true;
    const call = vi.fn(async () => ({ plan: "ceo", features: ["agent_builder"] }));
    const state = await lic.loadLicenseState({ call });
    expect(call).toHaveBeenCalledWith("license.state", {});
    expect(state).toMatchObject({ plan: "ceo", source: "rpc" });
    expect(lic.hasFeature(state, "agent_builder")).toBe(true);
    expect(lic.hasFeature(state, "offline_only_mode")).toBe(false);
  });

  it("opens KinglyVault checkout for upgrades", () => {
    win.__INFINIBOT_SAAS_MODE__ = true;
    const open = vi.fn();
    win.open = open;
    lic.openUpgrade("ceo");
    expect(open).toHaveBeenCalledTimes(1);
    expect(String(open.mock.calls[0][0])).toContain("/checkout?plan=ceo");
  });
});
