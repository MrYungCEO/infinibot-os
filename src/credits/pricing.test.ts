import { describe, expect, it } from "vitest";

import { priceUsd, loadPricingTable, listPricedModels } from "./pricing.js";

describe("credits pricing", () => {
  it("loads the pricing table without throwing and exposes known Claude families", () => {
    const table = loadPricingTable(true);
    expect(table.models["claude-opus-4-7"]).toBeDefined();
    expect(table.models["claude-sonnet-4-6"]).toBeDefined();
    expect(table.models["claude-haiku-4-5"]).toBeDefined();
    expect(listPricedModels().length).toBeGreaterThan(20);
  });

  it("prices a Claude Opus 4.7 call using the table", () => {
    const out = priceUsd(
      "claude-opus-4-7",
      { tokensIn: 1_000_000, tokensOut: 1_000_000 },
      "anthropic",
    );
    // 1M input × $15 + 1M output × $75 = $90
    expect(out.costUsd).toBeCloseTo(90, 5);
    expect(out.knownModel).toBe(true);
    expect(out.breakdown.inputUsd).toBeCloseTo(15, 5);
    expect(out.breakdown.outputUsd).toBeCloseTo(75, 5);
  });

  it("accounts for cache-read tokens at the discounted rate", () => {
    const out = priceUsd(
      "claude-sonnet-4-6",
      { tokensIn: 1_000_000, cacheReadTokens: 500_000, tokensOut: 0 },
      "anthropic",
    );
    // billable input = 1M - 500k = 500k @ $3/M = $1.5; cache read 500k @ $0.30/M = $0.15 → $1.65
    expect(out.costUsd).toBeCloseTo(1.65, 4);
    expect(out.breakdown.cacheReadUsd).toBeCloseTo(0.15, 4);
  });

  it("returns 0 cost and knownModel=true for ollama-local regardless of model", () => {
    const out = priceUsd("llama4:scout", { tokensIn: 999_999, tokensOut: 999_999 }, "ollama-local");
    expect(out.costUsd).toBe(0);
    expect(out.knownModel).toBe(true);
  });

  it("handles unknown models gracefully without throwing", () => {
    const out = priceUsd(
      "not-a-real-model",
      { tokensIn: 1000, tokensOut: 1000 },
      "totally-unknown",
    );
    expect(out.costUsd).toBe(0);
    expect(out.knownModel).toBe(false);
  });

  it("respects alias mappings", () => {
    const opus = priceUsd("claude-opus-latest", { tokensIn: 1_000_000, tokensOut: 0 }, "anthropic");
    expect(opus.knownModel).toBe(true);
    expect(opus.costUsd).toBeCloseTo(15, 5);
  });
});
