import { describe, expect, it } from "vitest";
import {
  keywordQueries,
  memoryNote,
  buildAskPrompt,
  buildResearchPrompt,
  decodeRunTags,
  embedRunMeta,
  encodeRunTags,
  filterLibrary,
  isResearchReport,
  isResearchSessionKey,
  isStale,
  itemFromResearchDoc,
  mergeLibrary,
  newRunId,
  newSince,
  parseResearchMarkdown,
  parseRunMeta,
  parseSourceLine,
  plainText,
  rankSources,
  relevance,
  RUN_STALL_MS,
  sessionKeyForRun,
  singleLine,
  STALE_AFTER_MS,
  stripRunMeta,
  suggestTopics,
  taskTitleFrom,
  titleFromQuestion,
  type ResearchItem,
} from "./model";

const NOW = 1_800_000_000_000;

describe("run ids + session keys", () => {
  it("makes store-safe ids and a research session key", () => {
    const id = newRunId(NOW, () => 0.5);
    expect(id).toMatch(/^rr-[a-z0-9]+-[a-z0-9]{5}$/);
    const key = sessionKeyForRun(id);
    expect(key).toBe(`agent:main:research-${id}`);
    expect(isResearchSessionKey(key)).toBe(true);
    expect(isResearchSessionKey("agent:main:main")).toBe(false);
    expect(isResearchSessionKey(undefined)).toBe(false);
  });
});

describe("run tags", () => {
  it("round-trips depth / sources / project / report / failed", () => {
    const tags = encodeRunTags(
      { depth: "deep", sourceMode: "both", projectId: "p-1", reportId: "rpt_9", failed: true },
      ["ai"],
    );
    expect(tags).toEqual(["research-run", "depth-deep", "src-both", "project-p-1", "report-rpt_9", "failed", "ai"]);
    const back = decodeRunTags(tags);
    expect(back).toMatchObject({ depth: "deep", sourceMode: "both", projectId: "p-1", reportId: "rpt_9", failed: true });
    expect(back.extra).toEqual(["ai"]);
  });

  it("ignores unknown depth values", () => {
    expect(decodeRunTags(["depth-huge", "src-moon"]).depth).toBeUndefined();
  });
});

describe("frontmatter-safe strings", () => {
  it("collapses newlines and quotes", () => {
    expect(singleLine('a\n"b"\n\nc')).toBe("a 'b' c");
    expect(singleLine("x".repeat(400), 10)).toHaveLength(10);
    expect(titleFromQuestion("what are humanoid robot prices?")).toBe("What are humanoid robot prices");
    expect(titleFromQuestion("   ")).toBe("Untitled research");
  });
});

describe("library items", () => {
  const runDoc = (over: Record<string, unknown> = {}) => ({
    id: "rr-1",
    name: "Robot pricing",
    description: "What do humanoid robots cost?",
    category: "research-run",
    status: "active",
    tags: encodeRunTags({ depth: "quick", sourceMode: "web", projectId: "p1", reportId: "rpt_a" }),
    createdAt: NOW - 1000,
    updatedAt: NOW - 500,
    preview: '<!-- ib-research {"v":1} --> Summary text',
    ...over,
  });

  it("maps a completed run", () => {
    const it = itemFromResearchDoc(runDoc(), NOW);
    expect(it).toMatchObject({
      key: "run:rr-1",
      kind: "run",
      status: "complete",
      depth: "quick",
      sourceMode: "web",
      projectId: "p1",
      reportId: "rpt_a",
      preview: "Summary text",
      sessionKey: "agent:main:research-rr-1",
    });
  });

  it("running vs stalled vs failed", () => {
    expect(itemFromResearchDoc(runDoc({ status: "draft", updatedAt: NOW - 1000 }), NOW).status).toBe("running");
    expect(itemFromResearchDoc(runDoc({ status: "draft", updatedAt: NOW - RUN_STALL_MS - 1 }), NOW).status).toBe("failed");
    expect(itemFromResearchDoc(runDoc({ status: "review" }), NOW).status).toBe("failed");
  });

  it("plain research docs are complete docs", () => {
    const it = itemFromResearchDoc({ id: "d1", name: "Dossier", tags: ["x"], createdAt: 1, updatedAt: 2 }, NOW);
    expect(it.kind).toBe("doc");
    expect(it.status).toBe("complete");
    expect(it.tags).toEqual(["x"]);
  });

  it("classifies research reports and drops system noise", () => {
    expect(isResearchReport({ id: "1", kind: "oversight_event", category: "research", title: "Sub-agent failed — research" })).toBe(false);
    expect(isResearchReport({ id: "2", kind: "research_brief", category: "general", title: "x" })).toBe(true);
    expect(isResearchReport({ id: "3", kind: "manual_render", category: "general", title: "Big Robots — Company Dossier" })).toBe(true);
    expect(isResearchReport({ id: "4", kind: "manual_render", category: "general", title: "Invoice 42" })).toBe(false);
    expect(isResearchReport({ id: "5", kind: "manual_render", category: "general", title: "x", sourceSession: "agent:main:research-rr-1" })).toBe(true);
  });

  it("merges runs + reports, a run absorbs its own report", () => {
    const lib = mergeLibrary(
      [runDoc()],
      [
        { id: "rpt_a", kind: "research_brief", title: "Robot pricing", filePath: "/x.pdf", createdAt: NOW },
        { id: "rpt_b", kind: "competitive_analysis", title: "Competitors", createdAt: NOW - 10 },
        { id: "rpt_c", kind: "oversight_event", category: "research", title: "noise", createdAt: NOW },
      ],
      NOW,
    );
    // newest first; the run's own report (rpt_a) and the noise row are gone
    expect(lib.map((i) => i.key)).toEqual(["report:rpt_b", "run:rr-1"]);
    expect(lib[1].hasPdf).toBe(true);
  });
});

describe("filter / sort / stale / new", () => {
  const mk = (over: Partial<ResearchItem>): ResearchItem => ({
    key: over.key ?? "k",
    kind: "run",
    title: "t",
    status: "complete",
    createdAt: 0,
    updatedAt: 0,
    tags: [],
    ...over,
  });
  const items = [
    mk({ key: "a", title: "Robot pricing", updatedAt: 3, projectId: "p1" }),
    mk({ key: "b", title: "Zeta market", updatedAt: 1, status: "failed" }),
    mk({ key: "c", title: "Alpha voice", updatedAt: 2, kind: "report", question: "voice cloning laws" }),
  ];
  const names = (id: string) => (id === "p1" ? "RoboPark" : undefined);

  it("searches title, question and project name", () => {
    expect(filterLibrary(items, { query: "voice laws" }).map((i) => i.key)).toEqual(["c"]);
    expect(filterLibrary(items, { query: "robopark" }, names).map((i) => i.key)).toEqual(["a"]);
  });
  it("filters by status, kind, project", () => {
    expect(filterLibrary(items, { status: "failed" }).map((i) => i.key)).toEqual(["b"]);
    expect(filterLibrary(items, { kind: "report" }).map((i) => i.key)).toEqual(["c"]);
    expect(filterLibrary(items, { projectId: "none" }).map((i) => i.key)).toEqual(["b", "c"].sort((x, y) => (x === "c" ? -1 : 1)));
    expect(filterLibrary(items, { projectId: "p1" }).map((i) => i.key)).toEqual(["a"]);
  });
  it("sorts", () => {
    expect(filterLibrary(items, { sort: "oldest" }).map((i) => i.key)).toEqual(["b", "c", "a"]);
    expect(filterLibrary(items, { sort: "title" }).map((i) => i.key)).toEqual(["c", "a", "b"]);
    expect(filterLibrary(items, { sort: "project" }, names).map((i) => i.key)[0]).toBe("a");
  });
  it("flags stale + new since last visit", () => {
    expect(isStale(mk({ updatedAt: NOW - STALE_AFTER_MS - 1 }), NOW)).toBe(true);
    expect(isStale(mk({ updatedAt: NOW - 1 }), NOW)).toBe(false);
    expect(isStale(mk({ updatedAt: 0, status: "running" }), NOW)).toBe(false);
    expect(newSince(items, 1.5).map((i) => i.key)).toEqual(["a", "c"]);
    expect(newSince(items, null)).toEqual([]);
  });
});

describe("run meta embedding", () => {
  it("round-trips through the body and strips from previews", () => {
    const body = embedRunMeta(
      { v: 1, question: "a -- b", depth: "quick", sourceMode: "web", startedAt: 5, sources: [{ title: "t", kind: "web", url: "https://x.io" }] },
      "# Title\n\nBody",
    );
    expect(body).not.toMatch(/a -- b/); // `--` escaped inside the comment
    const { meta, markdown } = parseRunMeta(body);
    expect(meta?.question).toBe("a -- b");
    expect(meta?.sources?.[0].url).toBe("https://x.io");
    expect(markdown.trim()).toBe("# Title\n\nBody");
    expect(stripRunMeta(body)).toBe("# Title\n\nBody");
    expect(parseRunMeta("plain").meta).toBeNull();
  });
});

describe("parsing the agent's markdown", () => {
  const md = `# Humanoid robot pricing

## Summary
Prices dropped sharply in 2026. Entry units now cost under $20k.

## Key findings
- Unitree G1 starts at $16k [1]
- Figure targets fleet leasing
  for warehouses [2]

## Action items
1. Get a quote from Unitree for RoboPark.
2. **Compare** leasing vs buying.

## Open questions
- Service costs?

## Sources
- [1] [Unitree G1](https://www.unitree.com/g1) — product page
- [2] Figure news https://figure.ai/news.
- Internal: report rpt_abc123 — RoboPark overview
`;
  it("splits sections, joins continuation lines, extracts sources", () => {
    const p = parseResearchMarkdown(md);
    expect(p.title).toBe("Humanoid robot pricing");
    expect(p.summary).toMatch(/^Prices dropped/);
    expect(p.findings).toEqual(["Unitree G1 starts at $16k [1]", "Figure targets fleet leasing for warehouses [2]"]);
    expect(p.actions).toHaveLength(2);
    expect(p.openQuestions).toEqual(["Service costs?"]);
    expect(p.sources).toEqual([
      { title: "Unitree G1", url: "https://www.unitree.com/g1", kind: "web", snippet: "product page" },
      { title: "Figure news", url: "https://figure.ai/news", kind: "web" },
      { title: "Internal: report rpt_abc123 — RoboPark overview", kind: "internal", ref: { type: "report", id: "rpt_abc123" } },
    ]);
  });
  it("falls back to the first paragraph when there is no Summary heading", () => {
    expect(parseResearchMarkdown("Short answer here.\n\nMore.").summary).toBe("Short answer here.");
  });
  it("parses a bare url source line", () => {
    expect(parseSourceLine("https://a.com/x")).toEqual({ title: "a.com", url: "https://a.com/x", kind: "web" });
  });
  it("strips markdown headings from previews", () => {
    expect(plainText("# Big Robot Pattaya — Dossier\n\n## Summary text")).toBe("Big Robot Pattaya — Dossier Summary text");
  });
  it("turns a finding into a clean task title", () => {
    expect(taskTitleFrom("**Compare** leasing vs [buying](https://x.io) [2]. Then more.")).toBe("Compare leasing vs buying.");
    expect(taskTitleFrom("Action: x".padEnd(300, "y")).length).toBeLessThanOrEqual(110);
  });
});

describe("prompts", () => {
  it("encodes depth budget, scope, sources and the output contract", () => {
    const p = buildResearchPrompt({
      question: "Robot prices",
      depth: "deep",
      sourceMode: "both",
      projectLabel: "RoboPark",
      projectId: "p1",
      webSources: [{ title: "Wiki", url: "https://w.org", kind: "wikipedia", snippet: "s" }],
      internalSources: [{ title: "Overview", kind: "internal", ref: { type: "report", id: "rpt_1" } }],
    });
    expect(p).toContain("DEEP");
    expect(p).toContain("at most 10 searches");
    expect(p).toContain('project "RoboPark" (id p1)');
    expect(p).toContain("[1] Wiki (https://w.org) — s");
    expect(p).toContain("[2] Overview (report:rpt_1)");
    expect(p).toContain("## Key findings");
    expect(p).toContain("Do NOT create reports");
  });
  it("internal-only never asks for web search", () => {
    const p = buildResearchPrompt({ question: "q", depth: "quick", sourceMode: "internal" });
    expect(p).toContain("do NOT search the web");
    expect(p).not.toContain("use web_search");
  });
  it("ask prompt cites numbered internal sources", () => {
    const p = buildAskPrompt("Who is our client?", [{ title: "Note A", kind: "internal", ref: { type: "note", id: "n1" } }]);
    expect(p).toContain("[1] Note A (note:n1)");
    expect(p).toContain("ONLY the internal");
    expect(buildAskPrompt("q", [])).toContain("(none found)");
  });
});

describe("relevance + ranking", () => {
  it("scores title hits above body hits", () => {
    expect(relevance("humanoid robot pricing", "Humanoid robot pricing 2026")).toBe(1);
    expect(relevance("humanoid robot pricing", "Other", "humanoid robot pricing")).toBe(0.5);
    expect(relevance("the and of", "anything")).toBe(0);
  });
  it("a long question still finds a short exact name; plurals fold", () => {
    const long = "best practices for keeping animatronic theme park robots reliable maintenance schedules spare parts RoboPark";
    expect(relevance(long, "Project: RoboPark")).toBeGreaterThanOrEqual(0.2);
    expect(relevance("robots", "Robot vendors")).toBe(1);
  });
  it("ranks and drops weak matches", () => {
    const r = rankSources("robot pricing", [
      { title: "Cooking", kind: "internal" },
      { title: "Robot pricing sheet", kind: "internal" },
      { title: "Fleet", kind: "internal", body: "robot leasing" },
    ]);
    expect(r.map((x) => x.title)).toEqual(["Robot pricing sheet", "Fleet"]);
  });
});

describe("suggested topics", () => {
  it("suggests active projects without recent research", () => {
    const projects = [
      { id: "p1", name: "RoboPark", description: "client retainer", status: "In Progress", updatedAt: 5 },
      { id: "p2", name: "Old", status: "Done", updatedAt: 9 },
      { id: "p3", name: "Fresh", status: "In Progress", updatedAt: 3 },
      { id: "p4", name: "Archived", status: "In Progress", archived: true },
    ];
    const items = [{ key: "a", kind: "run", title: "x", status: "complete", createdAt: 0, updatedAt: NOW - 1000, projectId: "p3", tags: [] }] as ResearchItem[];
    const s = suggestTopics(projects, items, NOW);
    expect(s.map((x) => x.projectId)).toEqual(["p1"]);
    expect(s[0].reason).toBe("Never researched");
    expect(s[0].question).toContain("RoboPark");
  });
});

describe("keyword queries for literal-match stores", () => {
  it("puts names first and drops question filler", () => {
    expect(keywordQueries("What is our maintenance agreement with ED-ROM for RoboPark?")).toEqual(["ED-ROM", "RoboPark", "maintenance"]);
    expect(keywordQueries("best practices for keeping robots reliable", 2)).toEqual(["reliable", "robots"]);
    expect(keywordQueries("")).toEqual([]);
  });
  it("never shows a raw provider error for memory search", () => {
    expect(memoryNote("No API key found for provider 'openai'. Auth store: /tmp/x")).not.toContain("/tmp");
    expect(memoryNote("socket hang up")).toMatch(/unavailable/);
  });
});
