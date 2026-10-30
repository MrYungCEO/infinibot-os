import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// No real DNS: private names are blocked, everything else "resolves".
vi.mock("../../infra/net/ssrf.js", () => {
  class SsrFBlockedError extends Error {}
  return {
    SsrFBlockedError,
    resolvePinnedHostname: vi.fn(async (host: string) => {
      if (/^(localhost|127\.|10\.|192\.168\.)/.test(host)) {
        throw new SsrFBlockedError(`Blocked hostname: ${host}`);
      }
      return { hostname: host, addresses: ["93.184.216.34"], lookup: () => {} };
    }),
    createPinnedDispatcher: vi.fn(() => ({})),
    closeDispatcher: vi.fn(async () => {}),
  };
});

// No real binaries: tests script what yt-dlp / gh "print".
const execFileMock = vi.fn();
vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

import {
  __resetBinaryCacheForTests,
  filterRelevant,
  keylessImageSearch,
  keylessWebSearch,
  parseBingHtml,
  parseBingImages,
  parseDuckDuckGoHtml,
  parseExaText,
  parseFeed,
  parseGithubTarget,
  parseJinaReader,
  vttToText,
} from "./web-reach-sources.js";
import {
  createGithubReadTool,
  createRssReadTool,
  createWebImageSearchTool,
  createWebReachTools,
  createWebReadTool,
  createYoutubeTranscriptTool,
  WEB_REACH_TOOL_NAMES,
} from "./web-reach.js";
import { createWebSearchTool } from "./web-search.js";
import { expandToolGroups } from "../tool-policy.js";

type FetchCall = { url: string; init?: RequestInit };

/** Route fetch by URL substring → Response factory; records every call. */
function stubFetch(routes: Array<[string | RegExp, () => Response]>) {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      for (const [match, make] of routes) {
        if (typeof match === "string" ? url.includes(match) : match.test(url)) return make();
      }
      return new Response("not found", { status: 404 });
    }),
  );
  return calls;
}

const text = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const EXA_TEXT = [
  "Title: Rust Programming Language\nURL: https://rust-lang.org/\nPublished: N/A\nAuthor: N/A\nHighlights:\nA language empowering everyone.",
  "Title: Rust Documentation\nURL: https://doc.rust-lang.org/\nPublished: 2026-01-02\nHighlights:\nThe Rust Bookshelf.",
].join("\n---\n");

const exaSse = (t = EXA_TEXT) =>
  text(
    `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: t }] } })}\n\n`,
    200,
    { "content-type": "text/event-stream" },
  );

const DDG_HTML = `
<div class="result results_links results_links_deep web-result ">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.rust-lang.org%2F&amp;rut=abc">Rust <b>Programming</b> Language</a></h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">A language empowering &amp; reliable.</a>
</div>
<div class="result results_links web-result result--ad">
  <a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad_provider=x">Ad</a>
</div>`;

const BING_HTML = `
<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&amp;&amp;p=1&amp;u=a1${Buffer.from("https://www.rust-lang.org/").toString("base64url")}&amp;ntb=1">Rust Programming Language</a></h2><p>Rust is fast.</p></li>
<li class="b_algo"><h2><a href="https://reddit.com/r/blooket">Blooket tier list</a></h2><p>Unrelated filler.</p></li>`;

beforeEach(() => {
  execFileMock.mockReset();
  __resetBinaryCacheForTests();
  delete process.env.BRAVE_API_KEY;
  delete process.env.PERPLEXITY_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.SEARXNG_URL;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parsers", () => {
  it("parses Jina Reader envelopes", () => {
    const parsed = parseJinaReader(
      "Title: Example Domain\n\nURL Source: https://example.com/\n\nPublished Time: Fri, 02 Oct 2026\n\nMarkdown Content:\n# Hello\n\nBody.",
    );
    expect(parsed).toEqual({
      title: "Example Domain",
      url: "https://example.com/",
      published: "Fri, 02 Oct 2026",
      text: "# Hello\n\nBody.",
    });
  });

  it("parses Exa MCP text blocks", () => {
    const results = parseExaText(EXA_TEXT);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      title: "Rust Programming Language",
      url: "https://rust-lang.org/",
      description: "A language empowering everyone.",
      siteName: "rust-lang.org",
    });
    expect(results[0]?.published).toBeUndefined();
    expect(results[1]?.published).toBe("2026-01-02");
  });

  it("unwraps DuckDuckGo redirect links and skips ads", () => {
    const results = parseDuckDuckGoHtml(DDG_HTML);
    expect(results).toEqual([
      {
        title: "Rust Programming Language",
        url: "https://www.rust-lang.org/",
        description: "A language empowering & reliable.",
        siteName: "www.rust-lang.org",
      },
    ]);
  });

  it("decodes Bing ck/a links and drops off-topic filler", () => {
    const results = parseBingHtml(BING_HTML);
    expect(results[0]?.url).toBe("https://www.rust-lang.org/");
    expect(filterRelevant("rust programming language", results).map((r) => r.title)).toEqual([
      "Rust Programming Language",
    ]);
  });

  it("needs at least half the query terms, so one shared common word is not enough", () => {
    const results = [
      {
        title: "Agent - Definition",
        url: "https://www.merriam-webster.com/dictionary/agent",
        description: "",
      },
      {
        title: "Panniantong/Agent-Reach",
        url: "https://github.com/Panniantong/Agent-Reach",
        description: "",
      },
    ];
    expect(filterRelevant("agent-reach Panniantong github", results).map((r) => r.url)).toEqual([
      "https://github.com/Panniantong/Agent-Reach",
    ]);
  });

  it("parses Bing Images metadata", () => {
    const m = JSON.stringify({
      murl: "https://img.example.com/dog.jpg",
      turl: "https://tse.mm.bing.net/th?id=1",
      purl: "https://example.com/dogs",
      t: "Golden <b>retriever</b>",
    }).replace(/"/g, "&quot;");
    expect(parseBingImages(`<a class="iusc" m="${m}">`)).toEqual([
      {
        url: "https://img.example.com/dog.jpg",
        source: "bing",
        thumbnailUrl: "https://tse.mm.bing.net/th?id=1",
        sourcePage: "https://example.com/dogs",
        title: "Golden retriever",
      },
    ]);
  });

  it("parses RSS and Atom feeds", () => {
    const rss = parseFeed(
      `<rss><channel><title>News</title><item><title><![CDATA[First & best]]></title><link>https://n.example/1</link><pubDate>Mon, 01 Jan 2026</pubDate><description>&lt;p&gt;Hi&lt;/p&gt;</description></item></channel></rss>`,
    );
    expect(rss.title).toBe("News");
    expect(rss.items[0]).toMatchObject({
      title: "First & best",
      link: "https://n.example/1",
      published: "Mon, 01 Jan 2026",
    });
    const atom = parseFeed(
      `<feed xmlns="http://www.w3.org/2005/Atom"><title>Blog</title><entry><title>Post</title><link rel="alternate" href="https://b.example/p"/><updated>2026-02-02</updated><summary>S</summary></entry></feed>`,
    );
    expect(atom).toEqual({
      title: "Blog",
      items: [
        { title: "Post", link: "https://b.example/p", published: "2026-02-02", summary: "S" },
      ],
    });
  });

  it("parses GitHub targets", () => {
    expect(parseGithubTarget("Panniantong/agent-reach")).toEqual({
      kind: "repo",
      owner: "Panniantong",
      repo: "agent-reach",
    });
    expect(parseGithubTarget("https://github.com/o/r/blob/main/src/a.ts")).toEqual({
      kind: "file",
      owner: "o",
      repo: "r",
      path: "src/a.ts",
      ref: "main",
    });
    expect(parseGithubTarget("https://github.com/o/r/pull/42")).toEqual({
      kind: "issue",
      owner: "o",
      repo: "r",
      number: 42,
    });
    expect(parseGithubTarget("o/r#7")).toMatchObject({ kind: "issue", number: 7 });
    expect(parseGithubTarget("https://gitlab.com/o/r")).toBeNull();
  });

  it("flattens WebVTT auto-captions", () => {
    const vtt =
      "WEBVTT\nKind: captions\nLanguage: en\n\n00:00:00.000 --> 00:00:01.000\nhello <00:00:00.500><c>world</c>\n\n00:00:01.000 --> 00:00:02.000\nhello world\nnext line\n";
    expect(vttToText(vtt)).toBe("hello world\nnext line");
  });
});

describe("keyless search chain", () => {
  it("returns Exa results first", async () => {
    const calls = stubFetch([["mcp.exa.ai", () => exaSse()]]);
    const out = await keylessWebSearch({ query: "rust", count: 5, timeoutMs: 1000 });
    expect(out.provider).toBe("exa");
    expect(out.results).toHaveLength(2);
    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0]?.init?.body as string) as Record<string, any>;
    expect(body.method).toBe("tools/call");
    expect(body.params.name).toBe("web_search_exa");
    expect(body.params.arguments).toMatchObject({ query: "rust", numResults: 5 });
    // keyless: no auth header of any kind
    expect(JSON.stringify(calls[0]?.init?.headers)).not.toMatch(/authorization|api[-_]?key/i);
  });

  it("retries Exa once before falling through", async () => {
    let exaCalls = 0;
    stubFetch([
      [
        "mcp.exa.ai",
        () => {
          exaCalls += 1;
          return exaCalls === 1 ? text("busy", 503) : exaSse();
        },
      ],
    ]);
    const out = await keylessWebSearch({ query: "rust", count: 5, timeoutMs: 1000 });
    expect(out.provider).toBe("exa");
    expect(exaCalls).toBe(2);
  });

  it("falls through Exa → DuckDuckGo (blocked) → Bing", async () => {
    stubFetch([
      ["mcp.exa.ai", () => text("upstream down", 503)],
      ["html.duckduckgo.com", () => text("challenge", 202)],
      ["bing.com/search", () => text(BING_HTML)],
    ]);
    const out = await keylessWebSearch({ query: "rust programming", count: 5, timeoutMs: 1000 });
    expect(out.provider).toBe("bing");
    expect(out.results.map((r) => r.url)).toEqual(["https://www.rust-lang.org/"]);
    expect(out.attempts.map((a) => a.source)).toEqual(["exa", "duckduckgo-html", "bing"]);
    expect(out.attempts[1]?.error).toMatch(/202/);
  });

  it("reports every attempt when all sources are empty", async () => {
    stubFetch([]);
    const out = await keylessWebSearch({ query: "x", count: 3, timeoutMs: 1000 });
    expect(out.provider).toBe("none");
    expect(out.attempts).toHaveLength(4);
  });

  it("web_search defaults to the keyless chain with no keys configured", async () => {
    stubFetch([["mcp.exa.ai", () => exaSse()]]);
    const tool = createWebSearchTool();
    expect(tool?.description).toMatch(/no API key/);
    const result = await tool?.execute("c1", { query: "rust lang keyless test" });
    expect(result?.details).toMatchObject({ provider: "exa", count: 2 });
  });
});

describe("web_read", () => {
  it("reads through Jina Reader with no key", async () => {
    const calls = stubFetch([
      [
        "r.jina.ai",
        () =>
          text(
            "Title: Example\n\nURL Source: https://example.com/\n\nMarkdown Content:\nHello world",
          ),
      ],
    ]);
    const result = await createWebReadTool().execute("c1", { url: "https://example.com/jina" });
    expect(calls[0]?.url).toBe("https://r.jina.ai/https://example.com/jina");
    expect(result.details).toMatchObject({
      extractor: "jina-reader",
      title: "Example",
      text: "Hello world",
    });
  });

  it("falls back to a direct fetch when Jina fails", async () => {
    stubFetch([
      ["r.jina.ai", () => text("rate limited", 429)],
      [
        "example.org/fallback",
        () =>
          text(
            "<html><head><title>Direct</title></head><body><article><p>Direct body text here.</p></article></body></html>",
            200,
            {
              "content-type": "text/html",
            },
          ),
      ],
    ]);
    const result = await createWebReadTool().execute("c1", { url: "https://example.org/fallback" });
    const details = result.details as Record<string, unknown>;
    expect(details.extractor).toMatch(/^direct-/);
    expect(String(details.text)).toContain("Direct body text");
    expect(details.attempts).toEqual([expect.objectContaining({ source: "jina-reader" })]);
  });

  it("refuses private hosts before contacting Jina", async () => {
    const calls = stubFetch([]);
    await expect(
      createWebReadTool().execute("c1", { url: "http://localhost:18789/secret" }),
    ).rejects.toThrow(/Blocked/);
    expect(calls).toHaveLength(0);
  });
});

describe("web_image_search", () => {
  it("fills results across sources and de-duplicates", async () => {
    const m = (u: string) => `m="${JSON.stringify({ murl: u, t: "dog" }).replace(/"/g, "&quot;")}"`;
    stubFetch([
      [
        "bing.com/images/async",
        () =>
          text(`<a ${m("https://a.example/1.jpg")}></a><a ${m("https://a.example/1.jpg")}></a>`),
      ],
      ["duckduckgo.com/?q=", () => text("no token here")],
      [
        "api.openverse.org",
        () =>
          json({
            results: [
              {
                url: "https://live.staticflickr.com/2.jpg",
                title: "Dog",
                width: 600,
                height: 900,
                license: "by",
                license_version: "2.0",
                foreign_landing_url: "https://flickr.com/p/2",
              },
            ],
          }),
      ],
    ]);
    const result = await createWebImageSearchTool().execute("c1", {
      query: "golden retriever keyless",
      count: 3,
    });
    const details = result.details as {
      providers: string[];
      results: Array<Record<string, unknown>>;
    };
    expect(details.providers).toEqual(["bing", "openverse"]);
    expect(details.results.map((r) => r.url)).toEqual([
      "https://a.example/1.jpg",
      "https://live.staticflickr.com/2.jpg",
    ]);
    expect(details.results[1]).toMatchObject({
      license: "cc-by 2.0",
      sourcePage: "https://flickr.com/p/2",
    });
  });

  it("ranks the requested orientation first", async () => {
    const out = await keylessImageSearch({
      query: "q",
      count: 5,
      timeoutMs: 1000,
      safe: true,
      sources: [
        {
          id: "fake",
          run: async () => [
            { url: "https://x.example/wide.jpg", width: 1600, height: 900, source: "fake" },
            { url: "https://x.example/tall.jpg", width: 900, height: 1600, source: "fake" },
            { url: "https://lookaside.instagram.com/x.jpg", source: "fake" },
          ],
        },
      ],
    });
    // unusable hosts are dropped
    expect(out.results.map((r) => r.url)).toEqual([
      "https://x.example/wide.jpg",
      "https://x.example/tall.jpg",
    ]);
  });
});

describe("youtube_transcript", () => {
  it("degrades with a clear message when yt-dlp is missing", async () => {
    execFileMock.mockImplementation((_bin, _args, _opts, cb) =>
      cb(Object.assign(new Error("spawn yt-dlp ENOENT"), { code: "ENOENT" }), "", ""),
    );
    const result = await createYoutubeTranscriptTool().execute("c1", {
      url: "https://www.youtube.com/watch?v=abc",
    });
    expect(result.details).toMatchObject({ error: "transcript_unavailable" });
    expect(String((result.details as { message: string }).message)).toMatch(
      /yt-dlp is not installed/,
    );
  });

  it("returns the flattened subtitles yt-dlp writes", async () => {
    execFileMock.mockImplementation(
      (_bin: string, args: string[], opts: { cwd?: string }, cb: (...a: unknown[]) => void) => {
        if (args[0] === "--version") return cb(null, "2026.09.01\n", "");
        fs.writeFileSync(
          path.join(opts.cwd!, "abc.en.vtt"),
          "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhi there\n",
        );
        cb(null, "My Video\n", "");
      },
    );
    const result = await createYoutubeTranscriptTool().execute("c1", {
      url: "https://youtu.be/abc",
    });
    expect(result.details).toMatchObject({
      title: "My Video",
      language: "en",
      extractor: "yt-dlp",
      text: "hi there",
    });
  });
});

describe("youtube_transcript partial failure", () => {
  it("keeps the downloaded track when another subtitle track errors", async () => {
    execFileMock.mockImplementation(
      (_bin: string, args: string[], opts: { cwd?: string }, cb: (...a: unknown[]) => void) => {
        if (args[0] === "--version") return cb(null, "2026.09.01\n", "");
        expect(args).toContain("en,en-orig");
        fs.writeFileSync(
          path.join(opts.cwd!, "v.en.vtt"),
          "WEBVTT\n\n00:00.000 --> 00:01.000\nkept\n",
        );
        cb(Object.assign(new Error("exit 1"), { code: 1 }), "", "ERROR: HTTP Error 429");
      },
    );
    const result = await createYoutubeTranscriptTool().execute("c1", { url: "https://youtu.be/v" });
    expect(result.details).toMatchObject({ language: "en", text: "kept" });
  });
});

describe("github_read", () => {
  it("uses the anonymous REST API when gh is missing", async () => {
    execFileMock.mockImplementation((_bin, _args, _opts, cb) =>
      cb(Object.assign(new Error("ENOENT"), { code: "ENOENT" }), "", ""),
    );
    const calls = stubFetch([
      ["/repos/o/r/readme", () => text("# Readme")],
      [
        "api.github.com/repos/o/r",
        () =>
          json({ full_name: "o/r", description: "d", stargazers_count: 5, default_branch: "main" }),
      ],
    ]);
    const result = await createGithubReadTool().execute("c1", { target: "o/r" });
    expect(result.details).toMatchObject({
      kind: "repo",
      repo: "o/r",
      stars: 5,
      readme: "# Readme",
      via: "rest",
    });
    expect(
      calls.every((c) => !JSON.stringify(c.init?.headers ?? {}).includes("Authorization")),
    ).toBe(true);
  });

  it("prefers gh api when installed", async () => {
    execFileMock.mockImplementation(
      (_bin: string, args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
        if (args[0] === "--version") return cb(null, "gh version 2", "");
        const apiPath = args[args.length - 1];
        if (apiPath === "repos/o/r/issues/3") {
          return cb(
            null,
            JSON.stringify({ title: "Bug", state: "open", user: { login: "u" }, body: "b" }),
            "",
          );
        }
        return cb(null, JSON.stringify([{ user: { login: "v" }, body: "c1" }]), "");
      },
    );
    const calls = stubFetch([]);
    const result = await createGithubReadTool().execute("c1", { target: "o/r#3" });
    expect(result.details).toMatchObject({
      kind: "issue",
      title: "Bug",
      author: "u",
      comments: [expect.objectContaining({ author: "v", body: "c1" })],
    });
    expect(calls).toHaveLength(0);
  });
});

describe("rss_read", () => {
  it("returns feed items", async () => {
    stubFetch([
      [
        "feeds.example.com",
        () =>
          text(
            "<rss><channel><title>F</title><item><title>A</title><link>https://e.example/a</link></item><item><title>B</title></item></channel></rss>",
          ),
      ],
    ]);
    const result = await createRssReadTool().execute("c1", {
      url: "https://feeds.example.com/rss",
      limit: 1,
    });
    expect(result.details).toMatchObject({
      title: "F",
      count: 1,
      items: [{ title: "A", link: "https://e.example/a" }],
    });
  });
});

describe("registration", () => {
  it("creates every web-reach tool with no config", () => {
    expect(createWebReachTools().map((t) => t.name)).toEqual([...WEB_REACH_TOOL_NAMES]);
  });

  it("the bare 'web' allowlist entry used by roster agents expands to the web tools", () => {
    const expanded = expandToolGroups(["web"]);
    for (const name of ["web_search", "web_fetch", ...WEB_REACH_TOOL_NAMES]) {
      expect(expanded).toContain(name);
    }
    expect(expandToolGroups(["group:web"])).toEqual(expanded);
  });
});
