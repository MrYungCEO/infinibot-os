/**
 * Shared chrome for client-facing documents (invoice, proposal).
 *
 * Same contract as the other templates in this folder: pure string templating,
 * no DOM, no deps, theme tokens inlined as CSS vars — so it renders identically
 * in the gateway (preview HTML) and in the standalone worker process (PDF).
 *
 * Layout notes, all of them learned from actually printing multi-page output
 * through the shared puppeteer renderer:
 *
 *  - Page margins come from `@page { margin }`. The renderer calls
 *    `page.pdf({ margin: 0 })`, and Chromium lets the CSS page box win, so this
 *    is the only mechanism that gives page 2+ a top margin. Padding on a
 *    wrapper div does not — it applies once, at the start of the flow.
 *  - The line-item table's `<thead>` is a `table-header-group`, so a long item
 *    list repeats its column headers on every page instead of orphaning them.
 *  - The totals stack and each row carry `break-inside: avoid`, so a total is
 *    never split from its label across a page boundary.
 *
 * Every interpolation goes through `esc`; see documents/html.ts for why.
 */

import type { Theme } from "../types.js";
import { esc, escProse, escUrl, joinHtml } from "../documents/html.js";
import { formatMoney, formatQuantity, lineTotalCents, sumCents } from "../documents/money.js";
import { statusPillCss, themeToCssVars } from "../themes/index.js";
import type {
  DocumentBrand,
  DocumentLineItem,
  DocumentParty,
  DocumentTotals,
} from "../documents/types.js";

/** Page geometry. A4 at 14mm sides is a conventional business-document measure. */
const PAGE_MARGIN = "16mm 14mm 18mm";

/**
 * Semantic status colours for the balance box.
 *
 * `ThemeTokens` has no danger/positive colour, but every theme already defines
 * `error` and `ok` status pills — so those are the theme's own answer to "what
 * colour is bad news here", and reusing them keeps a new theme from having to
 * know invoices exist.
 */
function semanticCssVars(theme: Theme): string {
  const pills = theme.tokens.statusPills ?? {};
  const danger = pills.error ?? pills.failed;
  const positive = pills.ok ?? pills.complete;
  return `:root {
  --danger-fg: ${danger?.fg ?? theme.tokens.text};
  --danger-bg: ${danger?.bg ?? theme.tokens.surfaceAlt};
  --positive-fg: ${positive?.fg ?? theme.tokens.text};
  --positive-bg: ${positive?.bg ?? theme.tokens.surface};
}`;
}

/**
 * Brand colours, emitted as a `:root` block *after* the theme's own, so
 * `branding_json` overrides win by cascade order without rebuilding the
 * theme's variable list.
 */
function brandCssVars(brand: DocumentBrand): string {
  const c = brand.colors;
  return `:root {
  --bg: ${c.bg};
  --surface: ${c.surface};
  --surface-alt: ${c.surfaceAlt};
  --border: ${c.border};
  --text: ${c.text};
  --text-muted: ${c.textMuted};
  --accent: ${c.accent};
  --accent-strong: ${c.accentStrong};
  --font-heading: ${c.fontHeading};
  --font-body: ${c.fontBody};
}`;
}

const DOCUMENT_CSS = `
  @page { size: A4; margin: ${PAGE_MARGIN}; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: var(--font-body);
    font-size: 10.5pt;
    line-height: 1.5;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  /* ── Letterhead ────────────────────────────────────────────── */
  .doc-head {
    display: flex; justify-content: space-between; align-items: flex-start;
    gap: 24px; padding-bottom: 16px; border-bottom: 2px solid var(--accent);
  }
  .brand { display: flex; gap: 14px; align-items: flex-start; min-width: 0; }
  .brand-mark {
    width: 46px; height: 46px; flex: 0 0 46px; border-radius: 8px;
    background: var(--accent); color: var(--bg);
    font-family: var(--font-heading); font-weight: 700; font-size: 17px;
    display: flex; align-items: center; justify-content: center; letter-spacing: 1px;
  }
  .brand-logo { width: 46px; height: 46px; flex: 0 0 46px; object-fit: contain; }
  .brand-text { min-width: 0; }
  .brand-name {
    font-family: var(--font-heading); font-size: 15pt; font-weight: 700;
    line-height: 1.2; word-break: break-word;
  }
  .brand-tagline { color: var(--text-muted); font-size: 9pt; margin-top: 2px; word-break: break-word; }
  .brand-contact { color: var(--text-muted); font-size: 8pt; margin-top: 6px; line-height: 1.38; }
  .brand-contact div { word-break: break-word; }

  .doc-title { text-align: right; flex: 0 0 auto; max-width: 46%; }
  .doc-kind {
    font-family: var(--font-heading); text-transform: uppercase; letter-spacing: 4px;
    font-size: 15pt; color: var(--accent); font-weight: 700;
  }
  .doc-number { font-family: var(--font-heading); font-size: 11pt; margin-top: 3px; word-break: break-all; }
  .doc-status { margin-top: 8px; }

  .pill {
    font-family: var(--font-heading); font-size: 8pt; letter-spacing: 1.4px;
    text-transform: uppercase; padding: 3px 11px; border-radius: 11px;
    font-weight: 700; display: inline-block;
  }
  .pill-default { color: var(--text); background: var(--surface-alt); }

  /* ── Meta + party blocks ───────────────────────────────────── */
  .doc-meta {
    display: flex; flex-wrap: wrap; gap: 0; margin-top: 16px;
    border: 1px solid var(--border); border-radius: 6px; overflow: hidden;
    break-inside: avoid;
  }
  /* flex-basis auto (not 0) so a longer value such as "Valid for 21 more days"
     takes the room it needs instead of wrapping while a "USD" cell sits half
     empty beside it. */
  .doc-meta .cell {
    flex: 1 1 auto; min-width: 96px; padding: 8px 12px; background: var(--surface);
    border-right: 1px solid var(--border);
  }
  .doc-meta .cell:last-child { border-right: 0; }
  .doc-meta .label {
    font-family: var(--font-heading); font-size: 7.5pt; letter-spacing: 1.4px;
    text-transform: uppercase; color: var(--text-muted);
  }
  .doc-meta .value { font-size: 10pt; margin-top: 2px; word-break: break-word; }
  .doc-meta .value.accent { color: var(--accent-strong); font-weight: 600; }

  .parties { display: flex; gap: 22px; margin-top: 16px; break-inside: avoid; }
  .party { flex: 1 1 0; min-width: 0; }
  /* A lone "Billed to" block reads as a block, not a full-width band. */
  .parties.single .party { flex: 0 1 64%; }
  .party h3 {
    font-family: var(--font-heading); font-size: 7.5pt; letter-spacing: 1.6px;
    text-transform: uppercase; color: var(--text-muted);
    margin: 0 0 5px; padding-bottom: 4px; border-bottom: 1px solid var(--border);
  }
  .party .who { font-size: 11pt; font-weight: 600; word-break: break-word; line-height: 1.3; }
  .party .legal { color: var(--text-muted); font-size: 9pt; word-break: break-word; }
  .party .line { font-size: 9pt; line-height: 1.4; color: var(--text-muted); word-break: break-word; }

  /* ── Sections ──────────────────────────────────────────────── */
  section { margin-top: 16px; }
  /* Short sections (project lists, acceptance terms) should not straddle a
     page break; the line-item section is deliberately left breakable. */
  section.keep { break-inside: avoid; }
  h2 {
    font-family: var(--font-heading); font-size: 10pt; letter-spacing: 1.4px;
    text-transform: uppercase; color: var(--accent-strong);
    border-bottom: 1px solid var(--border); padding-bottom: 6px; margin: 0 0 10px;
    /* Never orphan a heading at the foot of a page. */
    break-after: avoid;
  }
  /* Document lead: the proposal's own title, set as a title rather than as
     another uppercase section rule. */
  .doc-lead { margin-top: 22px; break-inside: avoid; }
  .doc-lead h1 {
    font-family: var(--font-heading); font-size: 16pt; font-weight: 700;
    margin: 0 0 8px; line-height: 1.25; color: var(--text); word-break: break-word;
  }
  .doc-lead .summary { font-size: 11pt; line-height: 1.55; color: var(--text); }
  p { margin: 0 0 9px; }
  ul { margin: 0 0 10px; padding-left: 17px; }
  li { margin: 3px 0; }
  li::marker { color: var(--accent); }

  /* ── Line items ────────────────────────────────────────────── */
  table.items { width: 100%; border-collapse: collapse; font-size: 9.5pt; }
  /* Repeats the column headers on every page of a long item list. */
  table.items thead { display: table-header-group; }
  table.items tr { break-inside: avoid; page-break-inside: avoid; }
  table.items th {
    text-align: left; font-family: var(--font-heading); font-size: 7.5pt;
    letter-spacing: 1.3px; text-transform: uppercase; color: var(--accent-strong);
    border-bottom: 1.5px solid var(--accent); padding: 7px 9px; background: var(--surface);
  }
  table.items td {
    padding: 7px 9px; border-bottom: 1px solid var(--border); vertical-align: top;
  }
  table.items tbody tr:nth-child(even) td { background: var(--surface); }
  table.items .num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  table.items .desc { word-break: break-word; }
  table.items .desc .detail { color: var(--text-muted); font-size: 8.5pt; margin-top: 2px; }
  .cadence {
    font-family: var(--font-heading); font-size: 7pt; letter-spacing: 1px;
    text-transform: uppercase; color: var(--accent-strong);
    border: 1px solid var(--border); border-radius: 8px; padding: 1px 6px;
    margin-left: 6px; white-space: nowrap;
  }

  /* ── Totals ────────────────────────────────────────────────── */
  .totals-wrap { display: flex; justify-content: flex-end; margin-top: 14px; break-inside: avoid; }
  .totals { width: 300px; max-width: 100%; }
  /* The area to the left of the totals stack is otherwise dead space on every
     invoice. Pairing the payment block with the totals uses it, and keeps a
     typical invoice on one page instead of spilling a near-empty second. */
  .settle { display: flex; gap: 22px; align-items: flex-start; margin-top: 14px; break-inside: avoid; }
  .settle .settle-aside { flex: 1 1 0; min-width: 0; }
  .settle .settle-aside .callout { margin-top: 0; }
  .settle .totals-wrap { flex: 0 0 300px; margin-top: 0; }
  .totals .row {
    display: flex; justify-content: space-between; gap: 12px;
    padding: 4px 0; font-size: 10pt; break-inside: avoid;
  }
  .totals .row .k { color: var(--text-muted); }
  .totals .row .v { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .totals .rule { border-top: 1px solid var(--border); margin: 4px 0; }
  .totals .row.grand {
    border-top: 1.5px solid var(--accent); margin-top: 4px; padding-top: 8px;
    font-family: var(--font-heading); font-size: 12pt; font-weight: 700;
  }
  .totals .row.grand .k { color: var(--text); }
  .totals .row.grand .v { color: var(--accent-strong); }
  .totals .row.due {
    background: var(--surface-alt); border: 1px solid var(--accent);
    border-radius: 6px; margin-top: 9px; padding: 9px 12px;
    font-family: var(--font-heading); font-size: 12pt; font-weight: 700;
  }
  .totals .row.due .k { color: var(--text); }
  .totals .row.due .v { color: var(--accent-strong); }
  .totals .row.settled {
    background: var(--surface); border: 1px solid var(--border);
  }
  /* An overdue balance should not look the same as a balance that is merely
     outstanding — the theme's own error/ok pill colours carry the signal. */
  .totals .row.due.danger {
    background: var(--danger-bg); border-color: var(--danger-fg);
  }
  .totals .row.due.danger .k, .totals .row.due.danger .v { color: var(--danger-fg); }
  .totals .row.due.positive {
    background: var(--positive-bg); border-color: var(--positive-fg);
  }
  .totals .row.due.positive .k, .totals .row.due.positive .v { color: var(--positive-fg); }

  /* ── Callouts / notes / footer ─────────────────────────────── */
  .callout {
    margin-top: 14px; padding: 11px 13px; background: var(--surface);
    border: 1px solid var(--border); border-left: 3px solid var(--accent);
    border-radius: 6px; break-inside: avoid;
  }
  .callout .k {
    font-family: var(--font-heading); font-size: 7.5pt; letter-spacing: 1.4px;
    text-transform: uppercase; color: var(--text-muted); margin-bottom: 4px;
  }
  .callout .v { font-size: 9.5pt; word-break: break-word; }
  .pay-link {
    display: inline-block; margin-top: 9px; padding: 8px 18px; border-radius: 6px;
    background: var(--accent); color: var(--bg); text-decoration: none;
    font-family: var(--font-heading); font-size: 9pt; font-weight: 700;
    letter-spacing: 1px; text-transform: uppercase;
  }
  .pay-link.placeholder {
    background: transparent; color: var(--text-muted);
    border: 1px dashed var(--border);
  }
  .sign-grid { display: flex; gap: 26px; margin-top: 14px; break-inside: avoid; }
  .sign { flex: 1 1 0; min-width: 0; }
  .sign .rule { border-bottom: 1px solid var(--text-muted); height: 34px; }
  .sign .who {
    font-family: var(--font-heading); font-size: 8pt; letter-spacing: 1px;
    text-transform: uppercase; color: var(--text-muted); margin-top: 5px;
    word-break: break-word;
  }
  footer.doc-foot {
    margin-top: 22px; padding-top: 10px; border-top: 1px solid var(--border);
    font-family: var(--font-heading); font-size: 7.5pt; color: var(--text-muted);
    display: flex; justify-content: space-between; gap: 16px;
    break-inside: avoid; word-break: break-word;
  }
`;

/** Full `<style>` body for a document: theme vars, brand overrides, layout, pills. */
export function documentCss(brand: DocumentBrand, theme: Theme): string {
  return [
    themeToCssVars(theme.tokens),
    semanticCssVars(theme),
    // Brand overrides come last of the variable blocks so they win by cascade
    // order without us rebuilding the theme's variable list.
    brandCssVars(brand),
    DOCUMENT_CSS,
    statusPillCss(theme.tokens),
  ].join("\n");
}

/**
 * Wrap body markup in a standalone HTML document. `fragment` mode returns just
 * the scoped style + markup, for the in-app preview pane.
 */
export function documentShell(args: {
  title: string;
  brand: DocumentBrand;
  theme: Theme;
  body: string;
  fragment?: boolean;
}): string {
  const css = documentCss(args.brand, args.theme);
  if (args.fragment) {
    return `<style>${css}</style>\n<div class="infinibot-document">${args.body}</div>`;
  }
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${esc(args.title)}</title>
  <style>${css}</style>
</head>
<body>
${args.body}
</body>
</html>`;
}

/** Status pill markup. `pillKey` maps a document status onto the theme's pill vocabulary. */
export function pillHtml(label: string, pillKey: string): string {
  const key = pillKey.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return `<span class="pill pill-${esc(key || "default")}">${esc(label)}</span>`;
}

/** Letterhead: brand block on the left, document identity on the right. */
export function letterheadHtml(args: {
  brand: DocumentBrand;
  kindLabel: string;
  number: string;
  statusLabel: string;
  statusPill: string;
}): string {
  const { brand } = args;
  // `logoDataUri` is only ever set by `embeddableLogo`, which admits nothing
  // but a base64 `data:image/*` URI — so `escUrl` is the right escaper here.
  const mark = brand.logoDataUri
    ? `<img class="brand-logo" src="${escUrl(brand.logoDataUri)}" alt="" />`
    : `<div class="brand-mark">${esc(brand.monogram)}</div>`;
  const contact = joinHtml([
    ...brand.addressLines.map((line) => `<div>${esc(line)}</div>`),
    brand.email ? `<div>${esc(brand.email)}</div>` : "",
    brand.phone ? `<div>${esc(brand.phone)}</div>` : "",
    brand.website ? `<div>${esc(brand.website)}</div>` : "",
  ]);
  return `<header class="doc-head">
  <div class="brand">
    ${mark}
    <div class="brand-text">
      <div class="brand-name">${esc(brand.name)}</div>
      ${brand.tagline ? `<div class="brand-tagline">${esc(brand.tagline)}</div>` : ""}
      ${contact ? `<div class="brand-contact">${contact}</div>` : ""}
    </div>
  </div>
  <div class="doc-title">
    <div class="doc-kind">${esc(args.kindLabel)}</div>
    <div class="doc-number">${esc(args.number)}</div>
    <div class="doc-status">${pillHtml(args.statusLabel, args.statusPill)}</div>
  </div>
</header>`;
}

/** Horizontal meta strip (dates, reference, currency). Empty cells are dropped. */
export function metaStripHtml(
  cells: Array<{ label: string; value: string; accent?: boolean } | null>,
): string {
  const html = cells
    .filter((cell): cell is { label: string; value: string; accent?: boolean } => !!cell)
    .map(
      (cell) =>
        `<div class="cell"><div class="label">${esc(cell.label)}</div><div class="value${
          cell.accent ? " accent" : ""
        }">${esc(cell.value)}</div></div>`,
    )
    .join("");
  return html ? `<div class="doc-meta">${html}</div>` : "";
}

function partyHtml(heading: string, party: DocumentParty): string {
  const lines = joinHtml([
    party.attention ? `<div class="line">Attn: ${esc(party.attention)}</div>` : "",
    ...(party.addressLines ?? []).map((line) => `<div class="line">${esc(line)}</div>`),
    party.email ? `<div class="line">${esc(party.email)}</div>` : "",
    party.phone ? `<div class="line">${esc(party.phone)}</div>` : "",
  ]);
  return `<div class="party">
    <h3>${esc(heading)}</h3>
    <div class="who">${esc(party.name)}</div>
    ${party.legalName ? `<div class="legal">${esc(party.legalName)}</div>` : ""}
    ${lines}
  </div>`;
}

/** Side-by-side "Billed to" / "From" blocks. */
export function partiesHtml(blocks: Array<{ heading: string; party: DocumentParty }>): string {
  const single = blocks.length === 1 ? " single" : "";
  return `<div class="parties${single}">${blocks
    .map((b) => partyHtml(b.heading, b.party))
    .join("")}</div>`;
}

const CADENCE_LABELS: Record<string, string> = {
  monthly: "Monthly",
  quarterly: "Quarterly",
  annual: "Annual",
};

/** Whole-cent total for a line: the stored value if present, else computed once. */
export function resolveLineTotal(item: DocumentLineItem): number {
  return typeof item.totalCents === "number" && Number.isFinite(item.totalCents)
    ? Math.trunc(item.totalCents)
    : lineTotalCents(item.quantity, item.unitPriceCents);
}

/** Sum of resolved line totals — the value the subtotal row must agree with. */
export function lineItemsSubtotal(items: readonly DocumentLineItem[]): number {
  return sumCents(items.map(resolveLineTotal));
}

export function lineItemsTableHtml(
  items: readonly DocumentLineItem[],
  currency: string,
  descriptionHeading = "Description",
): string {
  if (!items.length) {
    return `<table class="items"><thead><tr>
      <th class="desc">${esc(descriptionHeading)}</th>
      <th class="num">Qty</th><th class="num">Unit</th><th class="num">Amount</th>
    </tr></thead><tbody>
      <tr><td class="desc" colspan="4">No line items.</td></tr>
    </tbody></table>`;
  }
  const rows = items
    .map((item) => {
      const cadence =
        item.cadence && item.cadence !== "one_time" && CADENCE_LABELS[item.cadence]
          ? `<span class="cadence">${esc(CADENCE_LABELS[item.cadence])}</span>`
          : "";
      const detail = item.detail ? `<div class="detail">${esc(item.detail)}</div>` : "";
      return `<tr>
      <td class="desc">${esc(item.description)}${cadence}${detail}</td>
      <td class="num">${esc(formatQuantity(item.quantity))}</td>
      <td class="num">${esc(formatMoney(item.unitPriceCents, currency))}</td>
      <td class="num">${esc(formatMoney(resolveLineTotal(item), currency))}</td>
    </tr>`;
    })
    .join("");
  return `<table class="items">
  <thead><tr>
    <th class="desc">${esc(descriptionHeading)}</th>
    <th class="num">Qty</th><th class="num">Unit</th><th class="num">Amount</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table>`;
}

export interface TotalsRow {
  label: string;
  value: string;
  /** `grand` = document total; `due` = highlighted balance box. */
  variant?: "plain" | "grand" | "due" | "settled";
  /** Semantic emphasis for a `due`/`settled` box (overdue vs paid). */
  tone?: "danger" | "positive";
}

export function totalsHtml(rows: readonly TotalsRow[]): string {
  const body = rows
    .map((row) => {
      const variant =
        row.variant === "grand"
          ? " grand"
          : row.variant === "due"
            ? " due"
            : row.variant === "settled"
              ? " due settled"
              : "";
      const tone = row.tone ? ` ${row.tone}` : "";
      const cls = `${variant}${variant ? tone : ""}`;
      return `<div class="row${cls}"><span class="k">${esc(row.label)}</span><span class="v">${esc(
        row.value,
      )}</span></div>`;
    })
    .join("");
  return `<div class="totals-wrap"><div class="totals">${body}</div></div>`;
}

/**
 * Standard totals stack shared by both document kinds.
 *
 * The Subtotal row is suppressed when there is neither tax nor a discount:
 * printing "Subtotal $31,437.50 / Total $31,437.50" twice over is noise, and it
 * makes a reader hunt for the difference that isn't there.
 *
 * `grandLabel` lets the proposal say "Total investment" instead of stacking a
 * second identical row underneath its total.
 */
export function standardTotalsRows(
  totals: DocumentTotals,
  currency: string,
  options: { grandLabel?: string; grandVariant?: TotalsRow["variant"] } = {},
): TotalsRow[] {
  const rows: TotalsRow[] = [];
  const hasAdjustments = !!totals.discountCents || !!totals.taxCents;
  if (hasAdjustments) {
    rows.push({ label: "Subtotal", value: formatMoney(totals.subtotalCents, currency) });
  }
  if (totals.discountCents) {
    rows.push({
      label: "Discount",
      value: `-${formatMoney(Math.abs(totals.discountCents), currency)}`,
    });
  }
  if (totals.taxCents) {
    rows.push({ label: totals.taxLabel || "Tax", value: formatMoney(totals.taxCents, currency) });
  }
  rows.push({
    label: options.grandLabel ?? "Total",
    value: formatMoney(totals.totalCents, currency),
    variant: options.grandVariant ?? "grand",
  });
  return rows;
}

/**
 * Totals stack with an optional block beside it (the invoice's payment
 * callout). Falls back to a plain right-aligned totals stack when there is
 * nothing to put in the gap.
 */
export function settlementHtml(rows: readonly TotalsRow[], aside: string): string {
  if (!aside) return totalsHtml(rows);
  return `<div class="settle">
    <div class="settle-aside">${aside}</div>
    ${totalsHtml(rows)}
  </div>`;
}

/** Bordered note block ("Notes", "Payment terms", ...). */
export function calloutHtml(label: string, body: string, extra = ""): string {
  const content = escProse(body);
  if (!content && !extra) return "";
  return `<div class="callout">
    <div class="k">${esc(label)}</div>
    <div class="v">${content}</div>
    ${extra}
  </div>`;
}

export function footerHtml(brand: DocumentBrand, right: string): string {
  const left = brand.footerNote ? `${brand.name} · ${brand.footerNote}` : brand.name;
  return `<footer class="doc-foot"><span>${esc(left)}</span><span>${esc(right)}</span></footer>`;
}
