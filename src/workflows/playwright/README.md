# `src/workflows/playwright/` — Reusable Playwright Lead Scraper

## Overview

`scrape-leads.ts` is the **single compiled module** that handles all
Playwright browser automation for lead scraping. It is never regenerated at
runtime — every workflow run loads the same compiled `.js` file.

The LLM's only job is to supply parameters (`source`, `query`, `maxResults`).
The actual browser code lives here, not in the workflow body.

## Setup

Playwright uses your already-installed Chrome/Chromium. No bundled browser is
included:

```bash
# Verify Chrome is detected (Linux):
which google-chrome chromium chromium-browser

# Or set the path explicitly:
export PLAYWRIGHT_CHROMIUM_PATH=/usr/bin/google-chrome
```

You do **not** need to run `playwright install`. If you want a Playwright-managed
Chromium instead of your system Chrome:

```bash
npx playwright install chromium
# Then: PLAYWRIGHT_CHROMIUM_PATH=$(npx playwright run-server --help 2>&1 | grep -o '/.*chromium.*') ...
```

## Public API

```typescript
import { scrapeLeads, SCRAPE_LEADS_MODULE_PATH } from "./scrape-leads.js";

const output = await scrapeLeads(
  {
    source: "google_maps",     // "google_maps" | "instagram_search" | "directory_site"
    query: "coffee shops NYC", // search text or URL (directory_site)
    maxResults: 20,            // default 50
    headless: true,            // default true; never false in production
    storageStatePath: undefined, // path to Playwright storageState JSON (IG only)
    filters: {},               // source-specific key/value filters
  },
  {
    signal: controller.signal, // optional AbortSignal for cancellation
    log: (line) => console.log(line), // optional progress emitter
  },
);

// output.leads      — ScrapedLead[]
// output.truncated  — boolean: true if maxResults was hit before exhausting listings
// output.totalSeen  — number: total listing elements visited (including failed ones)
// output.durationMs — number: wall-clock time for the full scrape
```

Each run also logs:

```
[lead-scrape] module=/path/to/dist/workflows/playwright/scrape-leads.js
```

Running the same workflow twice will log the **same path** — confirming that
no per-run code generation occurred.

## Sources

| Source | Query format | Auth required | Notes |
|--------|-------------|---------------|-------|
| `google_maps` | Search keywords | None | Respects Maps rate limits; keep `maxResults ≤ 50` |
| `instagram_search` | `@handle` or `#hashtag` | `storageStatePath` (Playwright storageState JSON) | Scrapes profile bio / top post authors |
| `directory_site` | Full URL | None | Extracts JSON-LD structured data; falls back to meta tags |

## Extending with a New Source

1. Add the new value to the `LeadSource` union in `scrape-leads.ts`:

```typescript
export type LeadSource = "google_maps" | "instagram_search" | "directory_site" | "yelp";
```

2. Add a handler function:

```typescript
async function scrapeYelp(
  page: Page,
  input: ScrapeLeadsInput,
  opts: { maxResults: number; emit: (line: string) => void; signal?: AbortSignal },
): Promise<ScrapeLeadsOutput> {
  // ... navigate, extract, return
}
```

3. Add a `case` to the `switch` in `scrapeLeads()`:

```typescript
case "yelp":
  Object.assign(result, await scrapeYelp(page, input, { maxResults, emit, signal: ctx.signal }));
  break;
```

4. Update `LEAD_SOURCES` in `src/agents/tools/lead-scrape-tool.ts`:

```typescript
const LEAD_SOURCES = ["google_maps", "instagram_search", "directory_site", "yelp"] as const;
```

**The workflow markdown (`state/workflows/scrape-maps-leads.md`) requires no
changes.** The tool schema regenerates from the TypeScript source at build time.

## Workflow seed

`lead-scrape-workflow.seed.md` is the canonical source for the
`scrape-maps-leads` workflow. Because `state/workflows/` is gitignored,
install the seed via the gateway on first setup:

```bash
# One-time install — copies seed into the state workflow store
node -e "
  import('./dist/workflows/store.js').then(({ WorkflowStore }) => {
    const fs = require('fs');
    const YAML = require('yaml');
    const raw = fs.readFileSync('src/workflows/playwright/lead-scrape-workflow.seed.md', 'utf-8');
    // The WorkflowStore.create() call will parse the frontmatter automatically
    // when you use workflows.run from the UI; this seed file is the authoritative source.
    console.log('See src/workflows/playwright/lead-scrape-workflow.seed.md');
  });
"
# Or simply copy it to the state workflows directory:
cp src/workflows/playwright/lead-scrape-workflow.seed.md \
   \"\$(cat /proc/1/environ 2>/dev/null | tr '\\0' '\\n' | grep INFINIBOT_STATE_DIR | cut -d= -f2 || echo state)/workflows/scrape-maps-leads.md\"
```

## Smoke test

```bash
npx tsx scripts/lead-scrape-smoke.mts
```

Tests module exports, identity stability, and (if Chrome is present) runs a
`data:` URL fixture through the `directory_site` handler to verify JSON-LD
extraction without any external network requests.

## Architecture notes

- Uses `playwright-core` (already a dep) — not the full `playwright` package.
- Executable resolution: calls `findChromeExecutable*` from
  `src/browser/chrome.executables.ts`, same logic as the browser tool.
- Cancellation: `ctx.signal?.aborted` is checked at the top of each scroll
  iteration; browser is force-closed on abort.
- Rate limiting: each scroll waits 1.8 s before fetching the next batch;
  captcha detection bails immediately with `truncated: true`.
- CRM persistence: handled by the MCP tool (`lead-scrape-tool.ts`), not this
  module. This module returns raw leads; the tool persists them.
