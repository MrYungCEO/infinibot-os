/**
 * Self-heal registry: detect / heal / budget + failure classification.
 * // COORDINATION: orch-self-heal
 */

import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("./audit.js", () => ({ logAudit: vi.fn() }));

import {
  classifyFailure,
  attemptHeal,
  getHealers,
  __setHealersForTest,
  type Healer,
} from "./self-heal.js";
import type { QueuedTask } from "./types.js";

function makeTask(): QueuedTask {
  return {
    id: "task_heal",
    createdAt: Date.now(),
    priority: "normal",
    status: "running",
    title: "heal me",
    description: "",
    hardwareIntensive: false,
    requiresApproval: false,
    auditIds: [],
  };
}

afterEach(() => {
  __setHealersForTest(null);
  vi.clearAllMocks();
});

// ─── Concrete healer detection ──────────────────────────────────────────────

describe("default healer detection", () => {
  const healers = getHealers();
  const ctx = (errorText: string) => ({ error: new Error(errorText), errorText });

  it("brave-search-key detects missing_brave_api_key", () => {
    const h = healers.find((x) => x.id === "brave-search-key")!;
    expect(h.detect(ctx("search failed: missing_brave_api_key"))).toBe(true);
    expect(h.detect(ctx("totally unrelated error"))).toBe(false);
  });

  it("embeddings-auth detects the prescribed auth-store error", () => {
    const h = healers.find((x) => x.id === "embeddings-auth")!;
    const real =
      'No API key found for provider "openai". Auth store: /home/u/.infinibot/agents/x/agent/auth-profiles.json (agentDir: /home/u/.infinibot/agents/x/agent). copy auth-profiles.json from the main agentDir.';
    expect(h.detect(ctx(real))).toBe(true);
    // The provider message alone (without the auth-store prescription) is not ours.
    expect(h.detect(ctx('No API key found for provider "openai"'))).toBe(false);
  });

  it("browser-relay-clawd-down detects clawd / tab-not-found / 404", () => {
    const h = healers.find((x) => x.id === "browser-relay-clawd-down")!;
    expect(h.detect(ctx("Can't reach the clawd browser control service"))).toBe(true);
    expect(h.detect(ctx("tab not found"))).toBe(true);
    expect(h.detect(ctx("request failed HTTP 404"))).toBe(true);
  });
});

// ─── classifyFailure ────────────────────────────────────────────────────────

describe("classifyFailure", () => {
  it("classifies a matched-healer failure as infra", () => {
    const c = classifyFailure({
      error: new Error("missing_brave_api_key"),
      errorText: "missing_brave_api_key",
    });
    expect(c.kind).toBe("infra");
    expect(c.healer?.id).toBe("brave-search-key");
  });

  it("classifies a transient network error as infra (no healer)", () => {
    const c = classifyFailure({
      error: new Error("read ECONNRESET"),
      errorText: "read ECONNRESET",
    });
    expect(c.kind).toBe("infra");
    expect(c.transient).toBe(true);
    expect(c.healer).toBeUndefined();
  });

  it("classifies an unknown/genuine error as a task failure", () => {
    const c = classifyFailure({
      error: new Error("tester says the button is the wrong color"),
      errorText: "tester says the button is the wrong color",
    });
    expect(c.kind).toBe("task");
  });
});

// ─── attemptHeal budget + persistence ───────────────────────────────────────

describe("attemptHeal budget", () => {
  it("enforces a per-healer attempt budget and reports unhealable when exhausted", async () => {
    const heal = vi.fn().mockResolvedValue({ healed: false, action: "tried", retryable: false });
    const fake: Healer = {
      id: "always-fails",
      description: "test",
      maxAttempts: 2,
      detect: (c) => /boom/.test(c.errorText),
      heal,
    };
    __setHealersForTest([fake]);
    const task = makeTask();

    const r1 = await attemptHeal({ error: new Error("boom"), errorText: "boom", task });
    expect(r1.matched).toBe(true);
    expect(r1.unhealable).toBe(false);

    const r2 = await attemptHeal({ error: new Error("boom"), errorText: "boom", task });
    // Second failed attempt hits the budget (2/2) → unhealable.
    expect(r2.unhealable).toBe(true);

    const r3 = await attemptHeal({ error: new Error("boom"), errorText: "boom", task });
    // Budget already spent — the healer shouldn't even be invoked a 3rd time.
    expect(r3.unhealable).toBe(true);
    expect(heal).toHaveBeenCalledTimes(2);

    // Budget bookkeeping is persisted on the task so it survives a restart.
    expect(task.healState?.budgetUsed["always-fails"]).toBe(2);
    expect(task.healState?.attempts.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it("a successful heal reports healed + retryable", async () => {
    const fake: Healer = {
      id: "fixer",
      description: "test",
      detect: (c) => /fixme/.test(c.errorText),
      heal: async () => ({ healed: true, action: "fixed it", retryable: true }),
    };
    __setHealersForTest([fake]);
    const task = makeTask();
    const r = await attemptHeal({ error: new Error("fixme"), errorText: "fixme", task });
    expect(r.healed).toBe(true);
    expect(r.retryable).toBe(true);
    expect(r.unhealable).toBe(false);
  });

  it("no healer + transient error → retryable, not unhealable", async () => {
    __setHealersForTest([]);
    const task = makeTask();
    const r = await attemptHeal({
      error: new Error("read ECONNRESET"),
      errorText: "read ECONNRESET",
      task,
    });
    expect(r.matched).toBe(false);
    expect(r.retryable).toBe(true);
    expect(r.unhealable).toBe(false);
  });

  it("no healer + non-transient error → unhealable", async () => {
    __setHealersForTest([]);
    const task = makeTask();
    const r = await attemptHeal({
      error: new Error("some logic bug"),
      errorText: "some logic bug",
      task,
    });
    expect(r.matched).toBe(false);
    expect(r.retryable).toBe(false);
    expect(r.unhealable).toBe(true);
  });
});
