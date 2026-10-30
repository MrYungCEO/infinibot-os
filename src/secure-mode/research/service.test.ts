import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { InfinibotConfig } from "../../config/config.js";
import { SecureVault } from "../vault.js";
import { ResearchApprovalError, ResearchApprovals, SECURE_RESEARCH_EVENT } from "./approvals.js";
import type { FetchResult } from "./fetcher.js";
import type { ChatMessage, LocalLlm } from "./local-llm.js";
import { SecureResearchService } from "./service.js";
import { RESEARCH_LOG_STORE, ResearchStore } from "./store.js";

const MARKER_GOAL = "Hans Müller bond A1070 PLAINTEXT-MARKER-91c2";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function vault(): SecureVault {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ib-sr-"));
  dirs.push(d);
  return new SecureVault(randomBytes(32), d);
}

function grep(dir: string, needle: string): string[] {
  return (fs.readdirSync(dir) as string[])
    .map((f) => path.join(dir, f))
    .filter((p) => fs.readFileSync(p).includes(Buffer.from(needle)));
}

/** A scripted local model: plan → review → per-page extract → synthesis. */
function fakeLlm(
  opts: { review?: "ok" | "fail"; plan?: string[] } = {},
): LocalLlm & { prompts: ChatMessage[][] } {
  const prompts: ChatMessage[][] = [];
  return {
    ref: "ollama/test-local",
    prompts,
    async complete(messages) {
      prompts.push(messages);
      const sys = messages[0].content;
      if (sys.includes("You plan PUBLIC web searches"))
        return JSON.stringify({
          queries: opts.plan ?? [
            "1924 German External Loan bond value serial A1070 Hans Müller",
            "1935 1000 Reichsmark bond market value",
          ],
        });
      if (sys.includes("You check search queries")) {
        if (opts.review === "fail") throw new Error("model offline");
        return JSON.stringify({ flagged: [] });
      }
      if (sys.includes("extract ONLY prices"))
        return JSON.stringify({
          relevant: true,
          facts: [
            { item: "1924 German External Loan bond", price: 120, currency: "USD", kind: "sold" },
          ],
        });
      return JSON.stringify({
        summary: "Typical sold prices are $80–$150 [1].",
        estimates: [
          {
            item: "1924 German External Loan $1,000 bond",
            low: 80,
            high: 150,
            currency: "USD",
            confidence: "medium",
            sources: [1, 9],
          },
          { item: "1935 1000 Reichsmark bond", low: 20, high: 60, currency: "USD", sources: [2] },
        ],
      });
    },
  };
}

function fakeFetcher(calls: Array<{ url: string; purpose: string }>) {
  return {
    proxyKind: "none" as const,
    async get(url: string, purpose: "search" | "page"): Promise<FetchResult> {
      calls.push({ url, purpose });
      const body =
        purpose === "search"
          ? JSON.stringify({
              results: [
                { url: "https://www.spink.com/lot/1", title: "Spink lot", content: "sold $120" },
                { url: "https://api.openai.com/v1/x", title: "should be skipped" },
                { url: "https://www.scripoworld.com/germany-1924", title: "Scripoworld" },
              ],
            })
          : `<html><body><article><h1>Lot</h1><p>${"1924 German External Loan bond sold for $120. ".repeat(10)}</p></article></body></html>`;
      return {
        url,
        finalUrl: url,
        status: 200,
        contentType: purpose === "search" ? "application/json" : "text/html",
        body,
        bytes: body.length,
        truncated: false,
      };
    },
  };
}

function cfg(
  research: NonNullable<NonNullable<InfinibotConfig["secureMode"]>["research"]> = {},
): InfinibotConfig {
  return {
    secureMode: { research: { searxngUrl: "http://127.0.0.1:8888", ...research } },
  } as InfinibotConfig;
}

async function waitForPending(a: ResearchApprovals) {
  for (let i = 0; i < 200; i++) {
    const p = a.list();
    if (p.length) return p[0];
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("no pending approval");
}

describe("secure research — approval gating", () => {
  it("ask mode: nothing leaves the machine until the owner approves; approved queries are sanitized", async () => {
    const v = vault();
    const approvals = new ResearchApprovals();
    const events: Array<{ event: string; payload: { status: string } }> = [];
    approvals.setBroadcaster((event, payload) =>
      events.push({ event, payload: payload as { status: string } }),
    );
    const calls: Array<{ url: string; purpose: string }> = [];
    const svc = new SecureResearchService(cfg(), {
      llm: fakeLlm(),
      fetcher: fakeFetcher(calls),
      store: new ResearchStore(v),
      approvals,
      vaultTerms: () => [],
    });
    const run = svc.run({ goal: MARKER_GOAL, sessionKey: "agent:main:secure-abc" });
    const pending = await waitForPending(approvals);
    expect(calls).toEqual([]); // gated: zero network calls while pending
    expect(pending.sessionKey).toBe("agent:main:secure-abc");
    expect(pending.queries).toEqual([
      "1924 German External Loan bond value",
      "1935 1000 Reichsmark bond market value",
    ]);
    expect(JSON.stringify(pending.queries)).not.toMatch(/Hans|Müller|A1070/);
    // WS events carry ids + status only
    const ev = events.find((e) => e.payload.status === "pending_approval");
    expect(ev?.event).toBe(SECURE_RESEARCH_EVENT);
    expect(JSON.stringify(ev)).not.toMatch(/German|Reichsmark|Hans/);

    approvals.resolve(pending.id, "approve");
    const res = await run;
    expect(res.status).toBe("done");
    expect(res.queriesSent).toEqual(pending.queries);
    // only SearXNG + public pages; the cloud-LLM result was never fetched
    expect(
      calls
        .filter((c) => c.purpose === "search")
        .every((c) => c.url.startsWith("http://127.0.0.1:8888/search?")),
    ).toBe(true);
    expect(calls.some((c) => c.url.includes("openai"))).toBe(false);
    for (const c of calls)
      expect(decodeURIComponent(c.url)).not.toMatch(/Hans|Müller|A1070|MARKER/);
    // estimates cite only sources that were read
    expect(res.estimates?.[0]).toMatchObject({
      low: 80,
      high: 150,
      currency: "USD",
      sources: ["https://www.spink.com/lot/1"],
    });
    expect(res.sources.map((s) => s.url)).toContain("https://www.spink.com/lot/1");
    expect(res.model).toBe("ollama/test-local");
  });

  it("deny: zero egress and the record says nothing was sent", async () => {
    const approvals = new ResearchApprovals();
    const calls: Array<{ url: string; purpose: string }> = [];
    const svc = new SecureResearchService(cfg(), {
      llm: fakeLlm(),
      fetcher: fakeFetcher(calls),
      store: new ResearchStore(vault()),
      approvals,
      vaultTerms: () => [],
    });
    const run = svc.run({ goal: "value my bonds" });
    approvals.resolve((await waitForPending(approvals)).id, "deny");
    const res = await run;
    expect(res.status).toBe("denied");
    expect(res.queriesSent).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("timeout: expires without sending", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const approvals = new ResearchApprovals();
      const calls: Array<{ url: string; purpose: string }> = [];
      const svc = new SecureResearchService(cfg({ approvalTimeoutSec: 30 }), {
        llm: fakeLlm(),
        fetcher: fakeFetcher(calls),
        store: new ResearchStore(vault()),
        approvals,
        vaultTerms: () => [],
      });
      const run = svc.run({ goal: "value my bonds" });
      for (let i = 0; i < 50 && !approvals.list().length; i++) await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(31_000);
      const res = await run;
      expect(res.status).toBe("expired");
      expect(calls).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("edits are re-sanitized: an edit that adds personal data is refused with the sanitized text", async () => {
    const approvals = new ResearchApprovals();
    const svc = new SecureResearchService(cfg(), {
      llm: fakeLlm(),
      fetcher: fakeFetcher([]),
      store: new ResearchStore(vault()),
      approvals,
      vaultTerms: () => ["Weber Family Trust"],
    });
    const run = svc.run({ goal: "value my bonds" });
    const p = await waitForPending(approvals);
    let err: unknown;
    try {
      approvals.resolve(p.id, "approve", ["Weber Family Trust 1924 bond value serial A1070"]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ResearchApprovalError);
    expect((err as ResearchApprovalError).details?.sanitized).toEqual([
      { query: "1924 bond value", ok: true, removed: ["sensitive", "serial"] },
    ]);
    // still pending; a clean edit goes through verbatim
    const d = approvals.resolve(p.id, "approve", ["1924 bond value"]);
    expect(d).toMatchObject({ decision: "approve", queries: ["1924 bond value"], edited: true });
    const res = await run;
    expect(res.queriesSent).toEqual(["1924 bond value"]);
  });

  it("auto-sanitized: sends without waiting when the rules and the local review pass, still logged", async () => {
    const v = vault();
    const approvals = new ResearchApprovals();
    const calls: Array<{ url: string; purpose: string }> = [];
    const svc = new SecureResearchService(cfg({ approval: "auto-sanitized" }), {
      llm: fakeLlm(),
      fetcher: fakeFetcher(calls),
      store: new ResearchStore(v),
      approvals,
      vaultTerms: () => [],
    });
    const res = await svc.run({ goal: "value my bonds", sessionKey: "agent:main:secure-x" });
    expect(res.status).toBe("done");
    expect(res.approvalMode).toBe("auto-sanitized");
    const log = new ResearchStore(v).list();
    expect(log[0].queries.every((q) => typeof q.sentAt === "number")).toBe(true);
    expect(new ResearchStore(v).get(res.id)?.decidedBy).toBe("auto-sanitized");
  });

  it("auto-sanitized falls back to ask when the local review is unavailable", async () => {
    const approvals = new ResearchApprovals();
    const calls: Array<{ url: string; purpose: string }> = [];
    const svc = new SecureResearchService(cfg({ approval: "auto-sanitized" }), {
      llm: fakeLlm({ review: "fail" }),
      fetcher: fakeFetcher(calls),
      store: new ResearchStore(vault()),
      approvals,
      vaultTerms: () => [],
    });
    const run = svc.run({ goal: "value my bonds" });
    const p = await waitForPending(approvals);
    expect(calls).toEqual([]);
    approvals.resolve(p.id, "deny");
    expect((await run).status).toBe("denied");
  });

  it("blocks (and sends nothing) when no generic query survives", async () => {
    const approvals = new ResearchApprovals();
    const calls: Array<{ url: string; purpose: string }> = [];
    const svc = new SecureResearchService(cfg(), {
      llm: fakeLlm({ plan: ["Hans Müller A1070", "hans@example.de"] }),
      fetcher: fakeFetcher(calls),
      store: new ResearchStore(vault()),
      approvals,
      vaultTerms: () => [],
    });
    const res = await svc.run({ goal: "value it" });
    expect(res.status).toBe("blocked");
    expect(calls).toEqual([]);
    expect(approvals.list()).toEqual([]);
  });

  it("vault people/clients and identifying OCR entities are stripped from planned queries", async () => {
    const approvals = new ResearchApprovals();
    const svc = new SecureResearchService(cfg(), {
      llm: fakeLlm({
        plan: ["Lindqvist estate 1935 1000 Reichsmark bond value", "1924 bond value XZ-4471"],
      }),
      fetcher: fakeFetcher([]),
      store: new ResearchStore(vault()),
      approvals,
      vaultTerms: () => ["Lindqvist estate"],
      fileContext: () => [
        {
          id: "s_1",
          name: "bond-scan.png",
          text: "German bond",
          entities: ["Serial: XZ-4471", "German External Loan"],
        },
      ],
    });
    const run = svc.run({ goal: "value", fileIds: ["s_1"] });
    const p = await waitForPending(approvals);
    expect(p.queries).toEqual(["1935 1000 Reichsmark bond value", "1924 bond value"]);
    approvals.resolve(p.id, "deny");
    await run;
  });
});

describe("secure research — sources", () => {
  it("a bot-walled page (HTTP 403) is not read as content; snippets become sources without extra egress", async () => {
    const calls: Array<{ url: string; purpose: string }> = [];
    const llm = fakeLlm();
    const fetcher = {
      proxyKind: "none" as const,
      async get(url: string, purpose: "search" | "page"): Promise<FetchResult> {
        calls.push({ url, purpose });
        const body =
          purpose === "search"
            ? JSON.stringify({
                results: [
                  {
                    url: "https://www.ebay.com/itm/1",
                    title: "eBay",
                    content: "1924 bond sold $180",
                  },
                  { url: "https://www.example.org/a", title: "A", content: "x" },
                  {
                    url: "https://www.example.org/b",
                    title: "B",
                    content: "1935 1000 RM bond $45 sold",
                  },
                ],
              })
            : "<html><body>Access Denied - pardon our interruption</body></html>";
        return {
          url,
          finalUrl: url,
          status: purpose === "search" ? 200 : 403,
          contentType: "text/html",
          body,
          bytes: body.length,
          truncated: false,
        };
      },
    };
    const svc = new SecureResearchService(cfg({ approval: "auto-sanitized", pagesPerQuery: 2 }), {
      llm,
      fetcher,
      store: new ResearchStore(vault()),
      approvals: new ResearchApprovals(),
      vaultTerms: () => [],
    });
    const res = await svc.run({ goal: "value", queries: ["1924 bond value"] });
    expect(res.status).toBe("done");
    // no page text from a 403 reached the extract step
    expect(llm.prompts.some((p) => p[0].content.includes("extract ONLY prices"))).toBe(false);
    // pages fall back to their snippets; the 3rd result is a snippet-only source; no extra GET for it
    expect(res.sources.map((s) => [s.url, s.kind])).toEqual([
      ["https://www.ebay.com/itm/1", "snippet"],
      ["https://www.example.org/a", "snippet"],
      ["https://www.example.org/b", "snippet"],
    ]);
    expect(calls.filter((c) => c.purpose === "page").map((c) => c.url)).toEqual([
      "https://www.ebay.com/itm/1",
      "https://www.example.org/a",
    ]);
    const synth = llm.prompts.find((p) => p[0].content.includes("valuation summary"));
    expect(synth?.[1].content).toContain("1935 1000 RM bond $45 sold");
  });
});

describe("secure research — encrypted query log", () => {
  it("stores the log, sources and goal only in the vault (no plaintext on disk)", async () => {
    const v = vault();
    const approvals = new ResearchApprovals();
    const svc = new SecureResearchService(cfg({ approval: "auto-sanitized" }), {
      llm: fakeLlm(),
      fetcher: fakeFetcher([]),
      store: new ResearchStore(v),
      approvals,
      vaultTerms: () => [],
    });
    const res = await svc.run({
      goal: MARKER_GOAL,
      sessionKey: "agent:main:secure-log",
      fileIds: [],
    });
    expect(res.status).toBe("done");
    // decrypts back
    const store = new ResearchStore(v);
    const rec = store.get(res.id);
    expect(rec?.goal).toBe(MARKER_GOAL);
    expect(rec?.queries.map((q) => q.query)).toEqual(res.queriesSent);
    expect(store.list({ sessionKey: "agent:main:secure-log" })).toHaveLength(1);
    expect(v.has(RESEARCH_LOG_STORE)).toBe(true);
    // ciphertext only: neither the secure goal nor the outbound queries / source URLs are readable on disk
    for (const needle of [
      "PLAINTEXT-MARKER-91c2",
      "Reichsmark",
      "spink.com",
      "agent:main:secure-log",
    ]) {
      expect(grep(v.dir, needle), needle).toEqual([]);
    }
    for (const f of fs.readdirSync(v.dir))
      expect(fs.statSync(path.join(v.dir, f)).mode & 0o077).toBe(0);
    // another master key cannot read it
    const other = new SecureVault(randomBytes(32), v.dir);
    expect(() => new ResearchStore(other).list()).toThrow();
  });
});
