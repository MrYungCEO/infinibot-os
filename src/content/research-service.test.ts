/**
 * research-service smoke test — node --test, no network.
 * Mocks globalThis.fetch for a few representative scenarios.
 */

import assert from "node:assert/strict";
import { test } from "vitest";

import { gatherResearch, bundleToPromptBlock } from "./research-service.js";

type FetchResult = { status?: number; body: string; contentType?: string };

function installFetchMock(
  routes: Array<{
    match: RegExp;
    result: FetchResult | (() => Promise<FetchResult> | FetchResult);
  }>,
) {
  const original = globalThis.fetch;
  (globalThis as any).fetch = async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input?.url || String(input);
    for (const r of routes) {
      if (r.match.test(url)) {
        const result = typeof r.result === "function" ? await r.result() : r.result;
        return new Response(result.body, {
          status: result.status ?? 200,
          headers: { "Content-Type": result.contentType || "application/json" },
        });
      }
    }
    return new Response("{}", { status: 404, headers: { "Content-Type": "application/json" } });
  };
  return () => {
    (globalThis as any).fetch = original;
  };
}

test("gatherResearch: empty query returns warning bundle", async () => {
  const b = await gatherResearch({ query: "" });
  assert.equal(b.sources.length, 0);
  assert.equal(b.facts.length, 0);
  assert.ok(b.warnings.length > 0);
  assert.match(b.warnings.join(" "), /empty query/);
});

test("gatherResearch: wikipedia hit produces a fact", async () => {
  const restore = installFetchMock([
    {
      match: /wikipedia\.org\/w\/api\.php/,
      result: {
        body: JSON.stringify({
          query: { search: [{ title: "Cats", snippet: "Cats are felines." }] },
        }),
      },
    },
    {
      match: /wikipedia\.org\/api\/rest_v1\/page\/summary/,
      result: {
        body: JSON.stringify({
          title: "Cats",
          extract: "Cats are small carnivorous mammals. They eat 47% more food than dogs.",
          content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Cats" } },
        }),
      },
    },
    // everything else returns empty/404 → fall through default
  ]);
  try {
    const b = await gatherResearch({
      query: "cats",
      sources: ["wikipedia"],
      timeoutMs: 3000,
      useBrowserRelay: false,
    });
    assert.ok(b.sources.length >= 1, "should have at least one source");
    assert.ok(b.facts.length >= 1, "should derive at least one fact");
    assert.equal(b.sources[0].kind, "wikipedia");
    // Stat extraction picked up "47%"
    assert.ok(b.stats.some((s) => s.value.includes("47%")));
  } finally {
    restore();
  }
});

test("gatherResearch: reddit returns empty list → warning, no throw", async () => {
  const restore = installFetchMock([
    {
      match: /reddit\.com\/search\.json/,
      result: { body: JSON.stringify({ data: { children: [] } }) },
    },
  ]);
  try {
    const b = await gatherResearch({
      query: "anything",
      sources: ["reddit"],
      timeoutMs: 2000,
      useBrowserRelay: false,
    });
    assert.equal(b.sources.length, 0);
    assert.ok(
      b.warnings.some((w) => w.includes("reddit")),
      "expected reddit warning",
    );
  } finally {
    restore();
  }
});

test("gatherResearch: hung fetch → total timeout warning, partial bundle", async () => {
  const restore = installFetchMock([
    {
      match: /.*/,
      result: () =>
        new Promise<FetchResult>(() => {
          /* never resolves — caller's AbortController will fire */
        }),
    },
  ]);
  try {
    const b = await gatherResearch({
      query: "hang",
      sources: ["wikipedia", "duckduckgo"],
      timeoutMs: 300,
      useBrowserRelay: false,
    });
    assert.ok(b.warnings.length > 0, "should have warnings");
    assert.ok(b.durationMs >= 0);
    assert.equal(b.facts.length, 0);
  } finally {
    restore();
  }
});

test("bundleToPromptBlock: renders markdown sections", () => {
  const md = bundleToPromptBlock({
    query: "test",
    generatedAt: Date.now(),
    durationMs: 10,
    facts: ["fact one"],
    stats: [],
    quotes: [],
    trends: ["trend one"],
    sources: [
      { kind: "wikipedia", title: "Test", url: "https://en.wikipedia.org/wiki/Test", snippet: "x" },
    ],
    warnings: [],
  });
  assert.match(md, /## RESEARCH BUNDLE/);
  assert.match(md, /\*\*Query:\*\* test/);
  assert.match(md, /### Key facts/);
  assert.match(md, /- fact one/);
  assert.match(md, /### Sources/);
  assert.match(md, /1\. Test —/);
});
