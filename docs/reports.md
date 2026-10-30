# InfiniBot Reports — the one PDF path

Every PDF InfiniBot produces — agent status overviews, security plans, weekly
digests, incident write-ups, anything — goes through **one** module:
`src/reports`. It owns the black-and-gold template, the puppeteer renderer, and
the Telegram delivery sink. **Do not** shell out to `pandoc`, `wkhtmltopdf`, or
`weasyprint`, and do not hand-roll a puppeteer PDF script. That ad-hoc drift is
exactly why a 6h status report once went out in default pandoc styling instead
of the house template.

## How to generate a PDF (the only way)

Build a structured `ReportPayload` and render it. Optionally deliver it to
Telegram in the same call.

```ts
import {
  renderReport,
  sendReportToTelegram,
  buildAgentStatusPayload,
} from "../reports/index.js";

// 1. Build a payload (use a builder when one fits, else construct it inline).
const payload = buildAgentStatusPayload({
  windowHours: 6,
  executiveSummary: "…",
  agents: [{ id: "coder-…", label: "…", status: "running", project: "Mesh" }],
  outstandingDecisions: ["PR #24 needs review"],
  nextSteps: ["Restart gateway"],
});

// 2a. Just get the bytes:
const pdf: Buffer = await renderReport(payload);              // -> Buffer
await renderReport(payload, { savePath: "/tmp/out.pdf" });   // also writes file

// 2b. …or render + deliver to Telegram:
const res = await sendReportToTelegram(payload, {
  caption: "InfiniBot — 6h agent activity (standardized template)",
});
// res = { ok, messageId, chatId, filePath, bytes }
```

## Payload shape

`ReportPayload` (full types in `src/reports/types.ts`):

```ts
interface ReportPayload {
  title: string;                 // big document title
  subtitle?: string;             // one line under the title
  eyebrow?: string;              // small uppercase label (default "InfiniBot · Report")
  generatedAt?: number;          // unix ms (default: render time)
  metrics?: { label: string; value: string | number }[]; // header meta-grid
  sections: ReportSection[];     // body, in order
  footer?: string;               // right-side footer note
  theme?: string;                // default "black-gold"
}

interface ReportSection {
  heading: string;               // gold section header
  count?: number;                // small badge next to heading
  body?: string;                 // paragraphs (blank-line split; "- " => bullets)
  bullets?: string[];            // explicit bullet list
  table?: { columns: string[]; rows: (string|number)[][]; pillColumns?: number[] };
  code?: string;                 // monospace pre block (IDs, diffs, logs)
}
```

`pillColumns` renders the given table columns as status pills (matched against
the theme's pill palette: `ok / ready / sent / complete / running / queued /
rendering / error / failed / timeout / interrupted`).

## Builders (common kinds)

`src/reports/builders.ts` ships payload builders so recurring report shapes
aren't re-derived at each call site:

- `buildAgentStatusPayload(input)` — N-hour agent status overview.
- `buildSecurityPlanPayload(input)` — security plan / audit.
- `buildWeeklyDigestPayload(input)` — weekly strategic digest.

Add a builder here whenever a shape recurs.

## Palette (black & gold)

Defined in `src/reports/themes/black-gold.ts`:

| token        | value     |
|--------------|-----------|
| background   | `#0a0a0a` |
| surface      | `#141414` |
| accent (gold)| `#d4af37` |
| accent-strong| `#b8860b` |
| text         | `#e8e2d0` |

Headings use JetBrains Mono (operational-console feel); body uses Inter.

## Gateway RPCs

- `reports.render` `({ payload, register?, base64? })` → `{ filePath, bytes, id?, base64? }`
- `reports.sendToTelegram` `({ payload, caption?, chatId?, kind? })` → `{ ok, messageId, filePath, id? }`
- (existing) `reports.generate / list / get / preview / resend / delete` — the
  kind-based, worker-rendered path with persistence + scheduling.

> **Restart required:** `reports.render` and `reports.sendToTelegram` are new
> gateway methods — restart the gateway before they are served.

## Architecture notes

- `template.ts` — payload → standalone black-gold HTML (pure strings, no deps).
- `render.ts` — `renderReport()` / `sendReportToTelegram()` (the public API).
- `renderer.ts` — HTML → PDF via puppeteer-core + system Chrome (lazy import).
- `sinks/telegram.ts` — `sendDocument` upload using `channels.telegram` config.
- `helpers/external-pdf.ts` — `ingestExternalPdf()` registers an already-rendered
  PDF as a first-class `/reports` row (used to backfill out-of-band PDFs).
- The kind-based worker path (`worker/`, `kinds/`, `store.ts`) renders in a
  **separate process** so a puppeteer crash can't destabilize the gateway. The
  two inline RPCs above trade that isolation for synchronous bytes; the renderer
  still lazily imports puppeteer and always closes the browser in a `finally`.

## Flagged (not migrated)

- `src/discovery/actions.ts` → `generate_pdf` renders funnel / lead-magnet
  content from arbitrary user markdown via wkhtmltopdf. It is a **different
  domain** (customer-facing lead magnets, not InfiniBot house reports) — the
  black-gold report template would be the wrong look for it, so it is
  intentionally left alone. If a future need arises to give it house styling,
  route it through `renderReport()` with a dedicated theme.

## Parity context — categorized markdown corpus (mesh plan)

The mesh plan wants every generated document auto-saved, **categorized**, and
made available to all agents as plain markdown ("parity context"). That is now
built into the save path — no extra call required.

### What happens on save

Every document that lands in `/reports` (the worker's kind path, `reports.render`,
`reports.sendToTelegram`, and any direct `ingestExternalPdf()` call) is, on save:

1. **Categorized** into a small closed taxonomy (`helpers/categorize.ts`):
   `operations · insights · finance · security · agent-output · research · general`.
   The category is inferred from kind → title keywords → source agent, or you can
   pass an explicit `category`. (`reports.kind` is unchanged — it stays the *report
   type*; `category` is the higher-level bucket the corpus is sliced by.)
2. **Converted to markdown** via Microsoft's
   [markitdown](https://github.com/microsoft/markitdown) (`helpers/markitdown.ts`):
   the artifact (pdf/docx/pptx/html/…) is converted and the markdown is stored
   both in the row (`markdown_body`) and as a sibling `~/.infinibot/reports/<id>.md`.
   Conversion is best-effort and runs in the background — if markitdown is not
   installed the report still saves, just without the markdown copy.

New `reports` columns (migration `0002-report-parity.ts`, idempotent):
`category, source_agent, source_session, original_format, markdown_path, markdown_body`.

### markitdown install (once, on the gateway host)

```
pipx install markitdown            # or: pip install 'markitdown[all]'
```

The wrapper looks for a `markitdown` binary on PATH, then `python3 -m markitdown`.
On this host it is installed in an isolated venv at
`~/.infinibot/tools/markitdown-venv` with a shim at `~/.local/bin/markitdown`.

### How a sub-agent pulls parity context

RPC (gateway):

```
reports.context ({ category?, sourceAgent?, since?, limit?, maxChars?, perReportChars? })
  -> { context, reports[], omitted, totalChars }
```

`context` is a single, size-bounded markdown document (one `##` section per
report, newest first) ready to drop into a system prompt or first message. In
process:

```ts
import { getReportContext } from "../reports/index.js";
const { context } = getReportContext({ category: "operations", maxChars: 40_000 });
```

> **Restart required:** `reports.context` is a new gateway method — restart the
> gateway before it is served. The new columns are added automatically on the
> next store open (gateway or worker boot); existing rows gain markdown only when
> re-rendered.
