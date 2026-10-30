/**
 * cliRouting.* RPCs on InfiniBot Cloud: a shared multi-tenant gateway refuses
 * to switch routing on / sign in / connect (one HOME = one sign-in for every
 * workspace) and says why; a fleet tenant Machine reports itself as such.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const { writeConfigFile } = vi.hoisted(() => ({ writeConfigFile: vi.fn(async () => {}) }));
vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => ({ cliRoutingEnabled: true, cliRouting: { allTraffic: true } }),
    readConfigFileSnapshot: async () => ({ raw: "{}" }),
    writeConfigFile,
  };
});

import { buildCliRoutingStatus, cliRoutingHandlers } from "./cli-routing.js";

type Res = { ok: boolean; payload?: unknown; error?: { code: string; message: string } };
async function call(method: string, params: unknown): Promise<Res> {
  let res: Res = { ok: false };
  await cliRoutingHandlers[method]!({
    params,
    respond: (ok: boolean, payload?: unknown, error?: { code: string; message: string }) => {
      res = { ok, payload, error };
    },
  } as never);
  return res;
}

afterEach(() => {
  vi.unstubAllEnvs();
  writeConfigFile.mockClear();
});

describe("cliRouting RPCs on a shared cloud gateway", () => {
  it("status: unavailable, with the reason, and not routing anything", async () => {
    vi.stubEnv("SAAS_MODE", "1");
    vi.stubEnv("FLEET_TENANT_ID", "");
    const st = await buildCliRoutingStatus({ cliRoutingEnabled: true } as never);
    expect(st.available).toBe(false);
    expect(st.where).toBe("shared-cloud");
    expect(st.unavailableReason).toMatch(/shared by several workspaces/);
    expect(st.agents.every((a) => !a.routed)).toBe(true);
  });

  it("set {enabled:true} / {allTraffic:true} is refused before touching config", async () => {
    vi.stubEnv("SAAS_MODE", "1");
    vi.stubEnv("FLEET_TENANT_ID", "");
    for (const params of [{ enabled: true }, { allTraffic: true }]) {
      const res = await call("cliRouting.set", params);
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe("UNAVAILABLE");
      expect(res.error?.message).toMatch(/xAI API key/);
    }
    expect(writeConfigFile).not.toHaveBeenCalled();
  });

  it("login and connect are refused with the same reason", async () => {
    vi.stubEnv("SAAS_MODE", "1");
    vi.stubEnv("FLEET_TENANT_ID", "");
    for (const method of ["cliRouting.login", "cliRouting.connect"]) {
      const res = await call(method, { provider: "grok-cli" });
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe("UNAVAILABLE");
    }
  });
});

describe("cliRouting RPCs on a fleet tenant Machine", () => {
  it("status: available on the workspace's own Machine", async () => {
    vi.stubEnv("SAAS_MODE", "1");
    vi.stubEnv("FLEET_TENANT_ID", "t_123");
    const st = await buildCliRoutingStatus({
      cliRoutingEnabled: true,
      cliRouting: { allTraffic: true },
    } as never);
    expect(st.available).toBe(true);
    expect(st.where).toBe("tenant-machine");
    expect(st.allTraffic).toBe(true);
    expect(st.unavailableReason).toBeUndefined();
    expect(st.backends.map((b) => b.id)).toContain("grok-cli");
  });
});
