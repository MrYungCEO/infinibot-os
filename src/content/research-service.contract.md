# research-service contract

> Stream B (script gen) integrates against THIS contract. Stream C implements it.
> If C changes any signature here, update Stream B in lockstep.

File: `src/content/research-service.ts`

## Exports

```ts
export interface ResearchSource {
  kind: "wikipedia" | "duckduckgo" | "reddit" | "hackernews" | "oembed"
      | "openlibrary" | "arxiv" | "github" | "trends" | "news" | "browser-relay" | "other";
  title: string;
  url: string;
  snippet: string;             // <= 500 chars
  publishedAt?: string;         // ISO if available
  score?: number;               // engagement / votes / relevance, source-defined
}

export interface ResearchStat {
  value: string;                // "47%", "$1.2B", "3 in 5"
  context: string;              // one-line context the stat appears in
  source: ResearchSource;       // which source it came from
}

export interface ResearchQuote {
  text: string;
  speaker?: string;
  source: ResearchSource;
}

export interface ResearchBundle {
  query: string;
  generatedAt: number;          // ms epoch
  durationMs: number;           // total time spent gathering
  facts: string[];              // 5–15 one-line factual statements
  stats: ResearchStat[];        // numbers worth citing
  quotes: ResearchQuote[];      // direct quotes worth using
  trends: string[];             // recent angles/headlines/zeitgeist
  sources: ResearchSource[];    // de-duped, ranked
  warnings: string[];           // partial-failure notes ("reddit timed out")
}

export interface ResearchOptions {
  /** topic / keyword / question — required */
  query: string;
  /** which sources to use; default = "auto" picks best for the query */
  sources?: Array<ResearchSource["kind"]> | "auto";
  /** hard ceiling on total time (ms); default 15000 */
  timeoutMs?: number;
  /** max results per source; default 5 */
  perSource?: number;
  /** include browser-relay scrape fallback when free APIs come back thin (default true) */
  useBrowserRelay?: boolean;
  /** ISO language tag for Wikipedia / News etc.; default "en" */
  language?: string;
  /** filter sources newer than N days when applicable */
  freshnessDays?: number;
}

/**
 * Gather research from free APIs + optional browser relay.
 * Always returns a bundle — partial failures land in `warnings`, never throws.
 */
export function gatherResearch(opts: ResearchOptions): Promise<ResearchBundle>;

/**
 * Convenience: render a bundle as a prompt-ready markdown block for LLM injection.
 * Used by Stream B in buildSystemPrompt() when research is requested.
 */
export function bundleToPromptBlock(bundle: ResearchBundle): string;
```

## Source rules (Stream C MUST follow)

- **Never require an API key for the default-on sources** (Wikipedia REST, DDG Instant Answer, Reddit JSON, HN Firebase, oEmbed endpoints, Open Library, arXiv).
- **Optional keyed sources** (NewsCatcher / Mediastack / Currents) are included only if the env var exists; never throw if missing.
- **Browser relay** uses the existing `mcp__infinibot__browser` MCP — implementation lives in `src/agents/tools/`; Stream C imports a helper, does not re-implement CDP.
- All HTTP calls go through a single `fetchWithTimeout(url, timeoutMs)` helper with `User-Agent: InfiniBot-Research/1.0 (+https://infinibot.app)`.
- Every result MUST have a real URL — synthetic facts without sources are dropped.
- De-dupe sources by hostname + path; keep highest-scored.

## Integration points

- **Stream B (`src/content/script-service.ts`)** calls `gatherResearch({ query })` when `opts.research === true`, then injects `bundleToPromptBlock(bundle)` into the system prompt before generation. The result echoes the `ResearchBundle` back to callers under `result.research`.
- **Gateway** exposes `research.gather` directly so non-script agents can call it.
- **MCP** exposes `infinibot_research` (already exists in the deferred-tools list) — wire it to `gatherResearch`.
