import { afterEach, describe, expect, it, vi } from "vitest";
import { getCommandLaneConcurrency, setCommandLaneConcurrency } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";
import {
  evaluateAgentSpawn,
  fitSubagentLane,
  gateAgentSpawn,
  resetAgentConcurrencyGateForTests,
  resolveTenantPlan,
  type GateDeps,
} from "./agent-concurrency-gate.js";
import { resolvePlanLimits } from "./plan-limits.js";
import type { SubagentRunRecord } from "./subagent-registry.js";

function run(id: string, extra: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId: id,
    childSessionKey: `agent:main:subagent:${id}`,
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "t",
    cleanup: "keep",
    createdAt: 1_000,
    startedAt: 1_000,
    ...extra,
  };
}

function deps(plan: string, runs: SubagentRunRecord[], extra: Partial<GateDeps> = {}): GateDeps {
  return {
    saas: true,
    env: { FLEET_TENANT_PLAN: plan },
    runs: () => runs,
    broadcast: null,
    now: 10_000,
    skipBuildQueue: true,
    skipLaneFit: true,
    ...extra,
  };
}

afterEach(() => resetAgentConcurrencyGateForTests());

const PRO_AGENTS = resolvePlanLimits("pro").agents!;
const STARTER_AGENTS = resolvePlanLimits("starter").agents!;
const many = (n: number, prefix = "r", extra: Partial<SubagentRunRecord> = {}) =>
  Array.from({ length: n }, (_, i) => run(`${prefix}${i}`, extra));

describe("evaluateAgentSpawn", () => {
  it("allows under the limit and blocks at it", () => {
    const limits = resolvePlanLimits("pro");
    expect(evaluateAgentSpawn({ saas: true, limits, used: PRO_AGENTS - 1 })).toEqual({
      allowed: true,
    });
    const blocked = evaluateAgentSpawn({ saas: true, limits, used: PRO_AGENTS });
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) {
      expect(blocked.error).toMatchObject({
        code: "AGENT_LIMIT",
        kind: "agents",
        limit: PRO_AGENTS,
        plan: "pro",
        used: PRO_AGENTS,
        nextPlan: "business",
        upgradeUrl: "/pricing",
      });
    }
  });

  it("never gates outside SaaS mode or on unlimited plans", () => {
    const starter = resolvePlanLimits("starter");
    expect(evaluateAgentSpawn({ saas: false, limits: starter, used: 99 }).allowed).toBe(true);
    const owner = resolvePlanLimits("ceo");
    expect(evaluateAgentSpawn({ saas: true, limits: owner, used: 99 }).allowed).toBe(true);
    expect(evaluateAgentSpawn({ saas: true, limits: null, used: 99 }).allowed).toBe(true);
  });
});

describe("gateAgentSpawn", () => {
  it("local (non-SaaS) mode: never gated, never looks anything up", async () => {
    const lookup = vi.fn();
    const runs = vi.fn(() => [run("a"), run("b")]);
    const out = await gateAgentSpawn({
      saas: false,
      env: { FLEET_TENANT_PLAN: "starter" },
      lookup,
      runs,
    });
    expect(out).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
    expect(runs).not.toHaveBeenCalled();
  });

  it("SaaS gateway not attributable to one tenant: not gated", async () => {
    const out = await gateAgentSpawn({ ...deps("", [run("a")]), env: {} });
    expect(out).toBeNull();
  });

  it("allows a spawn under the plan limit", async () => {
    expect(await gateAgentSpawn(deps("pro", [run("a"), run("b")]))).toBeNull();
  });

  it("blocks at the limit with AGENT_LIMIT and broadcasts plan.limit", async () => {
    const broadcast = vi.fn();
    const out = await gateAgentSpawn(deps("pro", many(PRO_AGENTS), { broadcast }));
    expect(out).toMatchObject({
      code: "AGENT_LIMIT",
      limit: PRO_AGENTS,
      plan: "pro",
      used: PRO_AGENTS,
      upgradeUrl: "/pricing",
    });
    expect(broadcast).toHaveBeenCalledWith("plan.limit", out);
  });

  it("finished / failed / interrupted runs free their slot", async () => {
    const runs = [
      run("done", { endedAt: 5_000 }),
      run("failed", { outcome: { status: "error" } as SubagentRunRecord["outcome"] }),
      run("interrupted", { interruptedAt: 5_000 }),
    ];
    expect(await gateAgentSpawn(deps("starter", runs))).toBeNull();
  });

  it("counts a spawn that registered but has not started yet", async () => {
    const runs = many(STARTER_AGENTS - 1);
    runs.push(run("pending", { startedAt: undefined }));
    const out = await gateAgentSpawn(deps("starter", runs));
    expect(out?.code).toBe("AGENT_LIMIT");
  });

  it("owner plan is never gated", async () => {
    expect(await gateAgentSpawn(deps("ceo", many(50)))).toBeNull();
  });

  it("two spawns racing in the same tick cannot both take the last slot", async () => {
    const runs = many(STARTER_AGENTS - 1);
    const [a, b] = await Promise.all([
      gateAgentSpawn(deps("starter", runs)),
      gateAgentSpawn(deps("starter", runs)),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it("a reservation is consumed once its run registers (no double count)", async () => {
    const runs = many(PRO_AGENTS - 3, "old", { createdAt: 1_000 });
    expect(await gateAgentSpawn(deps("pro", runs, { now: 10_000 }))).toBeNull();
    runs.push(run("first", { createdAt: 10_001 }));
    // each reservation is consumed by its run → the last three slots fill one by one.
    expect(await gateAgentSpawn(deps("pro", runs, { now: 10_002 }))).toBeNull();
    runs.push(run("second", { createdAt: 10_003 }));
    expect(await gateAgentSpawn(deps("pro", runs, { now: 10_004 }))).toBeNull();
    runs.push(run("third", { createdAt: 10_005 }));
    expect((await gateAgentSpawn(deps("pro", runs, { now: 10_006 })))?.used).toBe(PRO_AGENTS);
  });

  it("a reservation whose spawn never registered expires", async () => {
    const runs = many(STARTER_AGENTS - 1);
    expect(await gateAgentSpawn(deps("starter", runs, { now: 10_000 }))).toBeNull();
    expect(await gateAgentSpawn(deps("starter", runs, { now: 10_001 }))).not.toBeNull();
    expect(await gateAgentSpawn(deps("starter", runs, { now: 50_000 }))).toBeNull();
  });
});

describe("coder cap (CLI coders are a subset of the agent cap)", () => {
  const coder = (id: string, extra: Partial<SubagentRunRecord> = {}) =>
    run(id, { coderBackend: "claude-code", ...extra });

  it("evaluateAgentSpawn: a coder spawn at the coder cap is refused with kind coders", () => {
    const limits = { plan: "pro" as const, agents: 5, coders: 2, builds: 1 };
    expect(
      evaluateAgentSpawn({ saas: true, limits, used: 2, kind: "agent", codersUsed: 2 }),
    ).toEqual({
      allowed: true,
    });
    const blocked = evaluateAgentSpawn({
      saas: true,
      limits,
      used: 2,
      kind: "coder",
      codersUsed: 2,
    });
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) {
      expect(blocked.error).toMatchObject({
        kind: "coders",
        limit: 2,
        used: 2,
        nextPlan: "business",
      });
      expect(blocked.error.message).toMatch(/^Coder limit reached: 2\/2 coders/);
    }
  });

  it("evaluateAgentSpawn: the total agent cap is checked before the coder cap", () => {
    const limits = { plan: "pro" as const, agents: 2, coders: 1, builds: 1 };
    const blocked = evaluateAgentSpawn({
      saas: true,
      limits,
      used: 2,
      kind: "coder",
      codersUsed: 1,
    });
    expect(!blocked.allowed && blocked.error.kind).toBe("agents");
  });

  it("gate: native agents still fit while every coder slot is busy", async () => {
    const { coders, agents } = resolvePlanLimits("pro");
    const runs = Array.from({ length: coders! }, (_, i) => coder(`c${i}`));
    expect((await gateAgentSpawn(deps("pro", runs, { kind: "coder" })))?.kind).toBe("coders");
    expect(await gateAgentSpawn(deps("pro", runs, { kind: "agent" }))).toBeNull();
    expect(runs.length).toBeLessThan(agents!);
  });

  it("gate: durable tmux coder runs count as coders even without coderBackend", async () => {
    const { coders } = resolvePlanLimits("pro");
    const runs = Array.from({ length: coders! }, (_, i) =>
      run(`d${i}`, { durableSpawn: "tmux-coder" }),
    );
    expect((await gateAgentSpawn(deps("pro", runs, { kind: "coder" })))?.kind).toBe("coders");
  });

  it("gate: two coder spawns racing for the last coder slot cannot both win", async () => {
    const { coders } = resolvePlanLimits("pro");
    const runs = Array.from({ length: coders! - 1 }, (_, i) => coder(`c${i}`));
    const [a, b] = await Promise.all([
      gateAgentSpawn(deps("pro", runs, { kind: "coder" })),
      gateAgentSpawn(deps("pro", runs, { kind: "coder" })),
    ]);
    expect([a, b].filter(Boolean).map((e) => e?.kind)).toEqual(["coders"]);
  });

  it("gate: a native-agent reservation does not use up a coder slot", async () => {
    const { coders } = resolvePlanLimits("pro");
    const runs = Array.from({ length: coders! - 1 }, (_, i) => coder(`c${i}`));
    expect(await gateAgentSpawn(deps("pro", runs, { kind: "agent" }))).toBeNull();
    expect(await gateAgentSpawn(deps("pro", runs, { kind: "coder" }))).toBeNull();
  });
});

describe("fitSubagentLane", () => {
  afterEach(() => setCommandLaneConcurrency(CommandLane.Subagent, 8));

  it("widens the sub-agent lane to the plan's agent cap so paid slots never queue", async () => {
    setCommandLaneConcurrency(CommandLane.Subagent, 8);
    const { agents } = resolvePlanLimits("scale");
    await gateAgentSpawn(deps("scale", [], { skipLaneFit: false }));
    expect(getCommandLaneConcurrency(CommandLane.Subagent)).toBe(Math.max(8, agents!));
  });

  it("never narrows the lane, and leaves it alone for unlimited plans", () => {
    setCommandLaneConcurrency(CommandLane.Subagent, 50);
    fitSubagentLane(4);
    expect(getCommandLaneConcurrency(CommandLane.Subagent)).toBe(50);
    fitSubagentLane(null);
    expect(getCommandLaneConcurrency(CommandLane.Subagent)).toBe(50);
  });
});

describe("resolveTenantPlan", () => {
  it("FLEET_TENANT_PLAN overrides the lookup", async () => {
    const lookup = vi.fn();
    expect(
      await resolveTenantPlan({ FLEET_TENANT_PLAN: "scale", FLEET_TENANT_ID: "t" }, lookup),
    ).toBe("scale");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("reads tenants.plan for FLEET_TENANT_ID and caches it", async () => {
    const lookup = vi.fn(async () => "business");
    const env = { FLEET_TENANT_ID: "t1" };
    expect(await resolveTenantPlan(env, lookup, 1_000)).toBe("business");
    expect(await resolveTenantPlan(env, lookup, 30_000)).toBe("business");
    expect(lookup).toHaveBeenCalledTimes(1);
    await resolveTenantPlan(env, lookup, 1_000 + 61_000);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("keeps the last known plan through a lookup failure; default with none", async () => {
    const env = { FLEET_TENANT_ID: "t2" };
    expect(
      await resolveTenantPlan(
        env,
        async () => {
          throw new Error("neon down");
        },
        1_000,
      ),
    ).toBe("");
    await resolveTenantPlan(env, async () => "scale", 2_000);
    expect(
      await resolveTenantPlan(
        env,
        async () => {
          throw new Error("neon down");
        },
        200_000,
      ),
    ).toBe("scale");
  });
});
