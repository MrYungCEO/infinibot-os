/**
 * The real spawn tools refuse at the plan cap before any side effect.
 * (Allowed-path / local behaviour is covered by the existing sessions_spawn
 * suites, which run with SAAS_MODE unset.)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAgentConcurrencyGateForTests } from "./agent-concurrency-gate.js";
import { resetBuildQueueForTests } from "./build-queue.js";
import { setSubagentBroadcaster } from "./coder-runtime/subagent-broadcast.js";
import { addSubagentRunForTests, resetSubagentRegistryForTests } from "./subagent-registry.js";
import { createClaudeCoderTool } from "./tools/claude-coder-tool.js";
import { PLAN_LIMITS } from "./plan-limits.js";
import { createSessionsSpawnTool } from "./tools/sessions-spawn-tool.js";

const saved = { ...process.env };

function busyRun(i: number, extra: { coderBackend?: "claude-code" } = {}) {
  addSubagentRunForTests({
    runId: `busy-${i}`,
    childSessionKey: `agent:main:subagent:busy-${i}`,
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "already running",
    cleanup: "keep",
    createdAt: Date.now() - 1000,
    startedAt: Date.now() - 1000,
    ...extra,
  });
}
let queueDir: string;

beforeEach(() => {
  queueDir = fs.mkdtempSync(path.join(os.tmpdir(), "ibq-tools-"));
  process.env.SAAS_MODE = "1";
  process.env.FLEET_TENANT_PLAN = "starter";
  process.env.INFINIBOT_BUILD_QUEUE_DIR = queueDir;
  resetSubagentRegistryForTests();
  resetAgentConcurrencyGateForTests();
  resetBuildQueueForTests();
  // One CLI coder already running: starter's coder cap (PLAN_LIMITS: 1) is full,
  // its agent cap (4) is not.
  busyRun(0, { coderBackend: "claude-code" });
});

afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  resetSubagentRegistryForTests();
  fs.rmSync(queueDir, { recursive: true, force: true });
});

function details(result: unknown): Record<string, unknown> {
  const r = result as { details?: Record<string, unknown>; content?: Array<{ text?: string }> };
  return r.details ?? JSON.parse(r.content?.[0]?.text ?? "{}");
}

describe("spawn tools at the plan cap (SaaS mode)", () => {
  // claude_coder spawns a coder, so the lower coder cap trips first; sessions_spawn
  // is a native agent and hits the total agent cap.
  it.each([
    [
      "claude_coder",
      () => createClaudeCoderTool({ agentId: "main" }),
      "coders",
      PLAN_LIMITS.starter.coders,
    ],
    [
      "sessions_spawn",
      () => createSessionsSpawnTool({ agentSessionKey: "agent:main:main" }),
      "agents",
      PLAN_LIMITS.starter.agents,
    ],
  ] as const)(
    "%s returns AGENT_LIMIT and broadcasts plan.limit",
    async (_name, make, kind, limit) => {
      // Native agents fill the rest of the total cap for the sessions_spawn case.
      if (kind === "agents") for (let i = 1; i < limit; i++) busyRun(i);
      const broadcast = vi.fn();
      setSubagentBroadcaster(broadcast);
      const out = details(await make().execute("call-1", { task: "build the thing" }));
      expect(out).toMatchObject({
        status: "error",
        code: "AGENT_LIMIT",
        kind,
        plan: "starter",
        limit,
        used: limit,
        nextPlan: "pro",
        upgradeUrl: "/pricing",
      });
      expect(broadcast).toHaveBeenCalledWith(
        "plan.limit",
        expect.objectContaining({ code: "AGENT_LIMIT" }),
      );
      // the build queue got installed on the way (plan-sized)
      expect(fs.readFileSync(path.join(queueDir, "limit"), "utf8").trim()).toBe(
        String(PLAN_LIMITS.starter.builds),
      );
    },
  );
});
