import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  invalidateAggregatorCache,
  summary,
  timeseries,
  topConsumers,
  budgetStatuses,
  checkSpawnGuard,
} from "./aggregator.js";
import { recordCredit } from "./recorder.js";
import { closeCreditStore, initCreditLedger, getCreditStore } from "./store.js";

let tmpDir: string;
let previousStateDir: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "credits-agg-test-"));
  // recordCredit() writes to the ledger of the ACTIVE state dir, so the state
  // dir itself must be per-test — a ledger opened at a custom dbPath is a
  // different store, and the shared one would accumulate rows across tests.
  previousStateDir = process.env.INFINIBOT_STATE_DIR;
  process.env.INFINIBOT_STATE_DIR = tmpDir;
  closeCreditStore();
  initCreditLedger();
  invalidateAggregatorCache();
});

afterEach(() => {
  closeCreditStore();
  if (previousStateDir === undefined) delete process.env.INFINIBOT_STATE_DIR;
  else process.env.INFINIBOT_STATE_DIR = previousStateDir;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("credits aggregator", () => {
  it("returns zeroed summary on an empty ledger", () => {
    const sum = summary({ period: "day" });
    expect(sum.totalRequests).toBe(0);
    expect(sum.totalCostUsd).toBe(0);
    expect(sum.byProvider).toEqual([]);
  });

  it("buckets timeseries data correctly", () => {
    const baseNow = Date.now();
    for (let i = 0; i < 5; i++) {
      recordCredit({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        agentBackend: "direct-api",
        usage: { tokensIn: 100, tokensOut: 50 },
      });
    }
    invalidateAggregatorCache();
    const ts = timeseries({
      bucket: "day",
      range: { start: baseNow - 2 * 86_400_000, end: baseNow + 86_400_000 },
      groupBy: "agent_backend",
    });
    expect(ts.length).toBeGreaterThan(0);
    const total = ts.reduce(
      (acc, p) => acc + Object.values(p.series).reduce((s, v) => s + v.requests, 0),
      0,
    );
    expect(total).toBe(5);
  });

  it("topConsumers returns rows in descending USD order", () => {
    recordCredit({
      provider: "anthropic",
      model: "claude-opus-4-7",
      usage: { tokensIn: 100, tokensOut: 100 },
    });
    recordCredit({
      provider: "openai",
      model: "gpt-4o-mini",
      usage: { tokensIn: 100, tokensOut: 100 },
    });
    invalidateAggregatorCache();
    const top = topConsumers({ axis: "provider", period: "day" });
    expect(top.length).toBeGreaterThanOrEqual(2);
    expect(top[0].costUsd).toBeGreaterThanOrEqual(top[top.length - 1].costUsd);
  });

  it("budgetStatuses returns spending state for configured budgets", () => {
    const store = getCreditStore();
    store.upsertBudget({
      id: "b1",
      name: "Anthropic monthly",
      scopeAxis: "provider",
      scopeValue: "anthropic",
      monthlyLimitUsd: 1.0,
      warnThresholdPct: 50,
      hardThresholdPct: 90,
      blockOnHard: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    recordCredit({
      provider: "anthropic",
      model: "claude-opus-4-7",
      usage: { tokensIn: 50_000, tokensOut: 0 },
    });
    invalidateAggregatorCache();
    const statuses = budgetStatuses();
    expect(statuses).toHaveLength(1);
    expect(statuses[0].currentSpendUsd).toBeGreaterThan(0);

    // Push spend over the hard threshold.
    recordCredit({
      provider: "anthropic",
      model: "claude-opus-4-7",
      usage: { tokensIn: 5_000_000, tokensOut: 1_000_000 },
    });
    invalidateAggregatorCache();
    const guard = checkSpawnGuard({ provider: "anthropic" });
    expect(guard).not.toBeNull();
    expect(guard?.state === "hard" || guard?.state === "exceeded").toBe(true);
  });
});
