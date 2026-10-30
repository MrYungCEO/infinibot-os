import { css } from "lit";

/**
 * Canonical markdown prose styles shared across all InfiniBot surfaces.
 *
 * Usage in a Lit component:
 *   static styles = [markdownStyles, css`/* component extras *\/`];
 *
 * Scope by wrapping rendered output in an element with class="md-body":
 *   html`<div class="md-body">${unsafeHTML(toSanitizedMarkdownHtml(src))}</div>`
 */
export const markdownStyles = css`
  .md-body {
    color: var(--c-fg, #f5f5f4);
    font-size: 15px;
    line-height: 1.72;
  }

  /* ── Typography ───────────────────────────────────────────────────────────── */
  .md-body :first-child { margin-top: 0; }
  .md-body :last-child  { margin-bottom: 0; }

  .md-body p { margin: 0 0 0.8em; }

  .md-body h1,
  .md-body h2,
  .md-body h3,
  .md-body h4,
  .md-body h5,
  .md-body h6 {
    color: var(--c-fg, #f5f5f4);
    font-weight: 700;
    line-height: 1.3;
    letter-spacing: -0.01em;
    margin: 1.4em 0 0.45em;
  }
  .md-body h1 {
    font-size: 1.75em;
    border-bottom: 1px solid rgba(250, 204, 21, 0.18);
    padding-bottom: 0.3em;
  }
  .md-body h2 { font-size: 1.4em; }
  .md-body h3 { font-size: 1.15em; color: var(--c-accent, #facc15); }
  .md-body h4 {
    font-size: 1em;
    color: var(--c-fg-dim, rgba(245, 245, 244, 0.65));
    text-transform: uppercase;
    letter-spacing: 0.07em;
  }
  .md-body h5 { font-size: 0.95em; }
  .md-body h6 { font-size: 0.9em; color: var(--c-fg-dim, rgba(245, 245, 244, 0.65)); }

  /* ── Links ────────────────────────────────────────────────────────────────── */
  .md-body a {
    color: var(--c-accent, #facc15);
    text-decoration: underline;
    text-decoration-color: rgba(250, 204, 21, 0.35);
    text-underline-offset: 3px;
  }
  .md-body a:hover { text-decoration-color: var(--c-accent, #facc15); }

  /* Moltbot internal-page links get a chip appearance. */
  .md-body a[href^="moltbot://page/"] {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 1px 8px 1px 6px;
    border-radius: 6px;
    background: rgba(250, 204, 21, 0.1);
    border: 1px solid rgba(250, 204, 21, 0.22);
    color: var(--c-accent, #facc15);
    text-decoration: none;
    font-size: 0.93em;
  }
  .md-body a[href^="moltbot://page/"]::before {
    content: "↗";
    font-size: 0.82em;
    opacity: 0.7;
  }

  /* ── Code ─────────────────────────────────────────────────────────────────── */
  .md-body code {
    background: rgba(0, 0, 0, 0.4);
    padding: 2px 6px;
    border-radius: 5px;
    font-size: 0.87em;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    color: #fde68a;
  }
  .md-body pre {
    background: rgba(0, 0, 0, 0.5);
    border: 1px solid rgba(250, 204, 21, 0.18);
    padding: 12px 14px;
    border-radius: 10px;
    overflow: auto;
    margin: 1em 0;
    font-size: 0.87em;
    line-height: 1.55;
  }
  .md-body pre code {
    background: transparent;
    padding: 0;
    color: #e6e6e6;
  }

  /* ── kbd ──────────────────────────────────────────────────────────────────── */
  .md-body kbd {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.82em;
    padding: 2px 6px;
    border-radius: 5px;
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.18);
    box-shadow: 0 2px 0 rgba(0, 0, 0, 0.4);
    color: var(--c-fg, #f5f5f4);
  }

  /* ── Tables ───────────────────────────────────────────────────────────────── */
  .md-body .table-wrap {
    overflow-x: auto;
    margin: 1em 0;
    border-radius: 8px;
    border: 1px solid rgba(250, 204, 21, 0.12);
  }
  .md-body .table-wrap table,
  .md-body table {
    border-collapse: collapse;
    width: 100%;
    font-size: 0.93em;
  }
  .md-body th,
  .md-body td {
    border: 1px solid rgba(250, 204, 21, 0.14);
    padding: 8px 12px;
    text-align: left;
  }
  .md-body th {
    background: rgba(250, 204, 21, 0.07);
    font-weight: 600;
    white-space: nowrap;
  }
  .md-body tr:nth-child(even) td { background: rgba(255, 255, 255, 0.025); }

  /* ── Lists ────────────────────────────────────────────────────────────────── */
  .md-body ul,
  .md-body ol {
    padding-left: 24px;
    margin: 0.6em 0;
  }
  .md-body li { margin: 0.25em 0; }

  /* Task list checkboxes */
  .md-body li > input[type="checkbox"] {
    margin-right: 6px;
    accent-color: var(--c-accent, #facc15);
    vertical-align: middle;
  }

  /* ── Blockquotes ──────────────────────────────────────────────────────────── */
  .md-body blockquote {
    border-left: 3px solid var(--c-accent, #facc15);
    padding: 2px 14px;
    color: var(--c-fg-dim, rgba(245, 245, 244, 0.65));
    margin: 1em 0;
    background: rgba(250, 204, 21, 0.04);
    border-radius: 0 6px 6px 0;
  }

  /* ── Callout / admonition blocks ──────────────────────────────────────────── */
  .md-body .callout {
    border-radius: 8px;
    padding: 12px 16px;
    margin: 1em 0;
    border-left: 4px solid;
  }
  .md-body .callout-title {
    font-weight: 700;
    font-size: 0.92em;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 6px;
  }
  .md-body .callout-body > :first-child { margin-top: 0; }
  .md-body .callout-body > :last-child  { margin-bottom: 0; }

  .md-body .callout-note    { background: rgba(96, 165, 250, 0.08); border-color: #60a5fa; }
  .md-body .callout-tip     { background: rgba(52, 211, 153, 0.08); border-color: #34d399; }
  .md-body .callout-warning { background: rgba(251, 191, 36, 0.08); border-color: #fbbf24; }
  .md-body .callout-danger  { background: rgba(248, 113, 113, 0.08); border-color: #f87171; }

  .md-body .callout-note    .callout-title { color: #60a5fa; }
  .md-body .callout-tip     .callout-title { color: #34d399; }
  .md-body .callout-warning .callout-title { color: #fbbf24; }
  .md-body .callout-danger  .callout-title { color: #f87171; }

  /* ── Footnotes ────────────────────────────────────────────────────────────── */
  .md-body .footnotes {
    font-size: 0.85em;
    color: var(--c-fg-dim, rgba(245, 245, 244, 0.65));
    margin-top: 2em;
  }
  .md-body .footnotes ol { padding-left: 20px; }
  .md-body .footnote-ref { font-size: 0.8em; }
  .md-body .footnote-back { color: var(--c-accent, #facc15); text-decoration: none; margin-left: 4px; }

  /* ── Media ────────────────────────────────────────────────────────────────── */
  .md-body img {
    max-width: 100%;
    border-radius: 10px;
    display: block;
    margin: 14px 0;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  }
  .md-body video {
    max-width: 100%;
    border-radius: 10px;
    display: block;
    margin: 14px 0;
    background: #000;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  }

  /* ── Mermaid placeholder ──────────────────────────────────────────────────── */
  .md-body .mermaid-block {
    background: rgba(0, 0, 0, 0.25);
    border: 1px dashed rgba(250, 204, 21, 0.2);
    border-radius: 8px;
    overflow: hidden;
    margin: 1em 0;
  }
  .md-body .mermaid-placeholder {
    padding: 12px 16px;
    color: var(--c-fg-dim, rgba(245, 245, 244, 0.5));
    font-size: 0.88em;
    letter-spacing: 0.03em;
  }
  /* Hide the raw source once runtime JS renders the diagram. */
  .md-body .mermaid-block.mermaid-rendered .mermaid-source { display: none; }
  .md-body .mermaid-block.mermaid-rendered .mermaid-placeholder { display: none; }

  /* ── HR ───────────────────────────────────────────────────────────────────── */
  .md-body hr {
    border: none;
    border-top: 1px solid rgba(250, 204, 21, 0.15);
    margin: 2em 0;
  }

  /* ── mark / highlight ─────────────────────────────────────────────────────── */
  .md-body mark {
    background: rgba(250, 204, 21, 0.25);
    color: inherit;
    border-radius: 3px;
    padding: 0 2px;
  }

  /* ── Details / summary ────────────────────────────────────────────────────── */
  .md-body details {
    border: 1px solid rgba(250, 204, 21, 0.14);
    border-radius: 8px;
    padding: 8px 14px;
    margin: 1em 0;
  }
  .md-body summary { cursor: pointer; font-weight: 600; }
`;
