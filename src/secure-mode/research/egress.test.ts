import { afterEach, describe, expect, it } from "vitest";

import { HostLocalityChecker, setHostLocalityCheckerForTests } from "../host-locality.js";
import {
  CLOUD_LLM_SEARCH_DENY,
  checkEgress,
  checkEgressStatic,
  isDeniedLlmHost,
  isPublicAddress,
  SecureEgressError,
} from "./egress.js";
import { GENERIC_USER_AGENT, SecureFetcher, type EgressEvent } from "./fetcher.js";

const endpoints = { searxngUrl: "http://127.0.0.1:8888" };
const publicResolver = async () => ["93.184.216.34"];

afterEach(() => setHostLocalityCheckerForTests(null));

describe("secure research egress policy — no cloud LLM / AI search endpoints", () => {
  it.each([
    "https://api.openai.com/v1/chat/completions",
    "https://chatgpt.com/",
    "https://api.anthropic.com/v1/messages",
    "https://api.perplexity.ai/chat/completions",
    "https://www.perplexity.ai/search?q=x",
    "https://api.search.brave.com/res/v1/web/search?q=x",
    "https://search.brave.com/search?q=x&summary=1",
    "https://generativelanguage.googleapis.com/v1beta/models",
    "https://gemini.google.com/app",
    "https://api.exa.ai/search",
    "https://api.tavily.com/search",
    "https://google.serper.dev/search",
    "https://serpapi.com/search",
    "https://api.you.com/search",
    "https://api.bing.microsoft.com/v7.0/search",
    "https://kagi.com/api/v0/search",
    "https://openrouter.ai/api/v1/chat/completions",
    "https://api.groq.com/openai/v1/chat/completions",
    "https://ollama.com/api/chat",
    "https://duckduckgo.com/duckchat/v1/chat",
  ])("refuses %s for both search and page fetches", (url) => {
    for (const purpose of ["search", "page"] as const) {
      const v = checkEgressStatic(url, purpose, endpoints);
      expect(v.allowed).toBe(false);
    }
    expect(checkEgressStatic(url, "page", endpoints)).toMatchObject({
      reason: expect.stringMatching(/cloud LLM|AI search|search API/),
    });
  });

  it("deny list covers subdomains but not lookalikes", () => {
    expect(isDeniedLlmHost("eu.api.openai.com")).toBe(true);
    expect(isDeniedLlmHost("notopenai.com")).toBe(false);
    expect(isDeniedLlmHost("duckduckgo.com", "/html/")).toBe(false);
    expect(isDeniedLlmHost("duckduckgo.com", "/duckchat/v1")).toBe(true);
    expect(CLOUD_LLM_SEARCH_DENY.length).toBeGreaterThan(30);
  });

  it("search requests may only go to the configured SearXNG origin", () => {
    expect(
      checkEgressStatic("http://127.0.0.1:8888/search?q=x&format=json", "search", endpoints)
        .allowed,
    ).toBe(true);
    expect(
      checkEgressStatic("https://www.google.com/search?q=x", "search", endpoints).allowed,
    ).toBe(false);
    expect(checkEgressStatic("http://127.0.0.1:9999/search?q=x", "search", endpoints).allowed).toBe(
      false,
    );
  });

  it("refuses a SearXNG that is not on this machine", async () => {
    setHostLocalityCheckerForTests(
      new HostLocalityChecker({
        lookup: async () => ["8.8.8.8"],
        interfaces: () => ({}),
        hostname: () => "testhost",
      }),
    );
    const v = await checkEgress("http://searx.example.org/search?q=x", "search", {
      searxngUrl: "http://searx.example.org",
    });
    expect(v.allowed).toBe(false);
  });

  it("page fetches: public http(s) only — no loopback, LAN, tailnet, link-local, metadata, odd ports", async () => {
    for (const url of [
      "http://127.0.0.1:18789/",
      "http://localhost/",
      "http://10.0.0.5/",
      "http://192.168.1.1/",
      "http://172.17.0.1:8010/v1",
      "http://100.64.0.1:18889/",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]/",
      "http://[fd7a:115c:a1e0::1]/",
      "ftp://example.com/x",
      "file:///etc/passwd",
      "http://user:pw@example.com/",
      "http://example.com:22/",
      "http://127.0.0.1:8888/search?q=x",
    ]) {
      const v = await checkEgress(url, "page", endpoints, { resolver: publicResolver });
      expect(v.allowed, url).toBe(false);
    }
    expect(
      (
        await checkEgress("https://www.spink.com/lot/1", "page", endpoints, {
          resolver: publicResolver,
        })
      ).allowed,
    ).toBe(true);
  });

  it("page fetches: a public name that resolves to a private address is refused (DNS rebinding)", async () => {
    const v = await checkEgress("https://evil.example.com/", "page", endpoints, {
      resolver: async () => ["93.184.216.34", "127.0.0.1"],
    });
    expect(v.allowed).toBe(false);
    expect(isPublicAddress("::ffff:10.0.0.1")).toBe(false);
    expect(isPublicAddress("1.1.1.1")).toBe(true);
  });
});

describe("SecureFetcher — hardened client", () => {
  type Call = { url: string; headers: Record<string, string>; dispatcher: unknown };

  function fakeRequest(
    responses: Record<string, { status: number; headers?: Record<string, string>; body?: string }>,
    calls: Call[],
  ) {
    return (async (url: URL, opts: { headers: Record<string, string>; dispatcher?: unknown }) => {
      calls.push({ url: url.toString(), headers: opts.headers, dispatcher: opts.dispatcher });
      const r = responses[url.toString()] ?? { status: 404, body: "" };
      const buf = Buffer.from(r.body ?? "");
      return {
        statusCode: r.status,
        headers: { "content-type": "text/html", ...r.headers },
        body: {
          async *[Symbol.asyncIterator]() {
            yield buf;
          },
          dump: async () => undefined,
          destroy: () => undefined,
        },
      };
    }) as never;
  }

  it("sends a generic UA and no cookie / referer / authorization", async () => {
    const calls: Call[] = [];
    const f = new SecureFetcher({
      endpoints,
      resolver: publicResolver,
      requestImpl: fakeRequest(
        { "https://www.example.com/a": { status: 200, body: "<p>hi</p>" } },
        calls,
      ),
    });
    const res = await f.get("https://www.example.com/a", "page");
    expect(res.body).toBe("<p>hi</p>");
    const h = Object.fromEntries(
      Object.entries(calls[0].headers).map(([k, v]) => [k.toLowerCase(), v]),
    );
    expect(h["user-agent"]).toBe(GENERIC_USER_AGENT);
    expect(h["user-agent"]).not.toMatch(/infinibot|node|undici/i);
    for (const k of ["cookie", "referer", "authorization", "dnt", "x-forwarded-for"])
      expect(h[k]).toBeUndefined();
  });

  it("re-checks every redirect hop and refuses a redirect to a cloud LLM or private host", async () => {
    const events: EgressEvent[] = [];
    const calls: Call[] = [];
    const f = new SecureFetcher({
      endpoints,
      resolver: publicResolver,
      onEgress: (e) => events.push(e),
      requestImpl: fakeRequest(
        {
          "https://www.example.com/r1": {
            status: 302,
            headers: { location: "https://api.openai.com/v1/x" },
          },
          "https://www.example.com/r2": {
            status: 301,
            headers: { location: "http://127.0.0.1:18789/" },
          },
        },
        calls,
      ),
    });
    await expect(f.get("https://www.example.com/r1", "page")).rejects.toBeInstanceOf(
      SecureEgressError,
    );
    await expect(f.get("https://www.example.com/r2", "page")).rejects.toBeInstanceOf(
      SecureEgressError,
    );
    expect(calls.map((c) => new URL(c.url).hostname)).toEqual([
      "www.example.com",
      "www.example.com",
    ]);
    expect(events.filter((e) => e.blocked).map((e) => e.host)).toEqual([
      "api.openai.com",
      "127.0.0.1",
    ]);
  });

  it("caps the body size and refuses binary content", async () => {
    const calls: Call[] = [];
    const f = new SecureFetcher({
      endpoints,
      resolver: publicResolver,
      maxBytes: 10,
      requestImpl: fakeRequest(
        {
          "https://www.example.com/big": { status: 200, body: "x".repeat(100) },
          "https://www.example.com/bin": {
            status: 200,
            headers: { "content-type": "application/octet-stream" },
            body: "zz",
          },
        },
        calls,
      ),
    });
    const big = await f.get("https://www.example.com/big", "page");
    expect(big.bytes).toBe(10);
    expect(big.truncated).toBe(true);
    await expect(f.get("https://www.example.com/bin", "page")).rejects.toThrow(
      /unsupported content type/,
    );
  });

  it("uses the proxy for page fetches only and validates the proxy URL", async () => {
    const calls: Call[] = [];
    const f = new SecureFetcher({
      endpoints,
      proxy: "socks5h://127.0.0.1:9050",
      resolver: async () => {
        throw new Error("must not resolve locally behind a proxy");
      },
      requestImpl: fakeRequest({ "https://www.example.com/a": { status: 200, body: "ok" } }, calls),
    });
    expect(f.proxyKind).toBe("socks5");
    await f.get("https://www.example.com/a", "page");
    expect(calls[0].dispatcher?.constructor?.name).toMatch(/Socks5ProxyAgent/);
    expect(() => new SecureFetcher({ endpoints, proxy: "tor://x" })).toThrow(SecureEgressError);
  });
});
