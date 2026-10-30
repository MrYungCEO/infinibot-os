import { describe, expect, it } from "vitest";
import { formatRange, parseResearchResult } from "./secure-research";
import { normalizeSecureStatus, parseResearchEvent } from "./store";

describe("secure research UI helpers", () => {
  it("parses the secure_research tool output", () => {
    const r = parseResearchResult(
      JSON.stringify({
        id: "rs_1",
        status: "done",
        queriesSent: ["1924 German External Loan bond value"],
        estimates: [{ item: "bond", low: 80, high: 150, currency: "USD", sources: ["https://a.example/x"] }],
        sources: [{ n: 1, url: "https://a.example/x", title: "A" }],
        egressHosts: ["127.0.0.1", "a.example"],
        model: "ollama/q",
      }),
    );
    expect(r?.queriesSent).toEqual(["1924 German External Loan bond value"]);
    expect(r?.estimates?.[0].high).toBe(150);
    expect(parseResearchResult("not json")).toBeNull();
    expect(parseResearchResult(JSON.stringify({ id: "x" }))).toBeNull();
  });

  it("formats value ranges", () => {
    expect(formatRange({ item: "b", low: 80, high: 150, currency: "USD", sources: [] })).toBe("$80 – $150");
    expect(formatRange({ item: "b", low: 1200, high: 1200, currency: "EUR", sources: [] })).toBe("€1,200");
    expect(formatRange({ item: "b", low: null, high: null, currency: "USD", sources: [] })).toBe("Not enough data");
  });

  it("research events carry ids + status only", () => {
    expect(parseResearchEvent({ id: "rs_1", sessionKey: "agent:main:secure-x", status: "pending_approval", at: 5 })).toEqual({
      id: "rs_1",
      sessionKey: "agent:main:secure-x",
      status: "pending_approval",
      at: 5,
    });
    expect(parseResearchEvent({ status: "x" })).toBeNull();
  });

  it("keeps the research capability across status events that omit it", () => {
    const first = normalizeSecureStatus({
      enabled: true,
      unlocked: true,
      keyAccount: "a",
      research: { enabled: true, approval: "ask", searxngUrl: "http://127.0.0.1:8888", proxy: false },
    });
    expect(first?.research?.approval).toBe("ask");
    const next = normalizeSecureStatus({ enabled: true, unlocked: true, keyAccount: "a" }, first);
    expect(next?.research?.searxngUrl).toBe("http://127.0.0.1:8888");
  });
});
