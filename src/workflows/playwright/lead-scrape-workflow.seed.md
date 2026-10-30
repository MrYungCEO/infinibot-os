---
id: scrape-maps-leads
name: Scrape Leads (Playwright)
description: "Scrape leads from Google Maps, Instagram, or a directory URL using the reusable lead_scrape Playwright module. One tool call per run — no browser automation in the workflow body."
tags:
  - leads
  - scraping
  - crm
  - google-maps
  - playwright
author: main
createdAt: ""
updatedAt: 2026-05-25T00:00:00.000Z
agent: main
timeoutSeconds: 300
requires:
  - kind: tool
    name: lead_scrape
    reason: Playwright-based scraping module. Fails hard if the tool is not registered.
inputs:
  - name: source
    label: Source
    description: "Where to scrape: google_maps searches Google Maps, instagram_search scrapes a profile or hashtag (requires storageStatePath), directory_site navigates directly to a URL."
    type: select
    required: true
    default: google_maps
    options:
      - value: google_maps
        label: Google Maps
      - value: instagram_search
        label: Instagram
      - value: directory_site
        label: Directory / URL
  - name: query
    label: Query
    description: "Search text for google_maps (e.g. 'coworking space Bangkok') or instagram_search (e.g. '@handle' or '#hashtag'), or a full URL for directory_site."
    type: string
    required: true
    placeholder: coworking space Bangkok
  - name: maxResults
    label: Max results
    description: Stop scraping once this many leads are collected per run. Keep ≤50 for Maps ToS compliance.
    type: number
    required: false
    default: 20
    min: 1
    max: 200
  - name: business_id
    label: Business ID (optional)
    description: Route scraped leads under a specific business. Leave blank to use the active business.
    type: string
    required: false
    default: ""
---
# Scrape Leads (Playwright)

Scrape leads using the reusable `lead_scrape` tool, which delegates to the
compiled Playwright module at `src/workflows/playwright/scrape-leads.ts`.
**Do not write any browser automation here** — the tool handles all of it.

## Input validation

Before calling the tool, check:

1. `{{source}}` must be one of `google_maps`, `instagram_search`, `directory_site`.
2. `{{query}}` must not be blank.
3. For `instagram_search`, the user must have provided `storageStatePath` in the workflow
   inputs or as a previous note. If missing, stop and ask for it.

If any check fails, reply immediately with a clear error. Do not call the tool.

## Step 1 — Scrape

Call `lead_scrape` **exactly once** with the validated inputs:

```
lead_scrape {
  "source":     "{{source}}",
  "query":      "{{query}}",
  "maxResults": {{maxResults}}
}
```

Add `"business_id": "{{business_id}}"` only when `{{business_id}}` is non-empty.

The tool returns:
```json
{
  "status": "ok",
  "leads": [...],
  "totalSeen": N,
  "truncated": false,
  "leadsInserted": N,
  "businessId": "...",
  "moduleUsed": "/path/to/scrape-leads.js"
}
```

Log the `moduleUsed` path — it confirms the same compiled module is reused per run.

## Step 2 — Kanban note

After the tool returns, write a brief activity note to the kanban:

```
kanban {
  "action": "add_card",
  "title": "Lead scrape: {{query}} ({{source}})",
  "body": "Scraped {{leadsInserted}} leads via lead_scrape. Source: {{source}}. Query: {{query}}. Truncated: {{truncated}}.",
  "column": "Done"
}
```

## Step 3 — Report

Summarise in one line:

> Scraped N leads for `{{query}}` via `{{source}}`; N inserted into CRM.

If `truncated` is true, add: "> More results available — re-run with a higher `maxResults` or narrower query."

## Notes

- The workflow calls `lead_scrape` **once per execution**. Never loop or retry in the workflow body.
- For Google Maps: keep `maxResults` ≤ 50 to stay within Maps ToS.
- For Instagram: the `storageStatePath` must point to a Playwright `storageState` JSON
  exported from a logged-in session (e.g. `browser.storageState({ path: "ig-auth.json" })`).
- `lead_scrape` auto-persists results to the active business's CRM; you do not need a
  separate `databases.create_rows` or `clients.add_clients` call.
- To add a new scraping source, extend `src/workflows/playwright/scrape-leads.ts` —
  this workflow markdown stays untouched.
