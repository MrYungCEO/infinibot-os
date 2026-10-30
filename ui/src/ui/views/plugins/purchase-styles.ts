/**
 * Plugins page — paid plugins (purchases.ts): badges, Recommended strip,
 * locked call-out, Purchases tab and the locked-page upsell. Uses the page's
 * --pp-* tokens so it follows light/dark; gold accents on black.
 */
import { css } from "lit";

export const PURCHASE_STYLES = css`
  .pu-ic { display: inline-grid; place-items: center; margin-right: 6px; color: var(--pp-accent); vertical-align: -2px; }

  .pm-cover .pu-cover-badges { position: absolute; left: 10px; bottom: 10px; z-index: 1; display: inline-flex; gap: 6px; flex-wrap: wrap; max-width: calc(100% - 20px); }
  .pm-dhero .pu-cover-badges { display: inline-flex; gap: 6px; }
  .pu-badge {
    display: inline-flex; align-items: center; gap: 4px; height: 20px; padding: 0 8px; border-radius: 999px;
    font-size: 10.5px; font-weight: 700; letter-spacing: 0.02em; white-space: nowrap;
    border: 1px solid transparent; backdrop-filter: blur(6px);
  }
  .pu-badge svg { width: 11px; height: 11px; }
  .pu-badge.b-paid {
    color: #0a0a0a; border-color: rgba(251, 191, 36, 0.6);
    background: linear-gradient(135deg, #fde68a, #fbbf24 55%, #d97706);
    box-shadow: 0 4px 14px -6px rgba(251, 191, 36, 0.7);
  }
  .pu-badge.b-owned { color: var(--pp-accent); border-color: color-mix(in srgb, var(--pp-accent) 45%, transparent); background: rgba(10, 10, 10, 0.72); }
  .pu-badge.b-new { color: #0a0a0a; background: #f5f5f4; }
  :host([data-mode="light"]) .pu-badge.b-owned { background: rgba(255, 255, 255, 0.85); color: #92400e; }

  .pu-note {
    display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
    margin: 10px 0; padding: 10px 14px; border-radius: 12px; font-size: 13px;
    border: 1px solid var(--pp-line-strong); background: var(--pp-card);
  }
  .pu-note.k-ok { border-color: color-mix(in srgb, var(--pp-accent) 45%, transparent); }
  .pu-note.k-error { border-color: color-mix(in srgb, var(--pp-danger, #f87171) 55%, transparent); color: var(--pp-danger, #fca5a5); }

  .pu-reco { position: relative; }
  .pu-reco .pm-section-title { display: inline-flex; align-items: center; }

  .pu-callout {
    display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 14px; align-items: center;
    margin: 0 0 16px; padding: 16px 18px; border-radius: 16px;
    border: 1px solid var(--pp-line-strong); background: var(--pp-card);
  }
  .pu-callout.k-paid {
    border-color: color-mix(in srgb, var(--pp-accent) 55%, transparent);
    background:
      radial-gradient(120% 140% at 0% 0%, color-mix(in srgb, var(--pp-accent) 16%, transparent), transparent 60%),
      var(--pp-card);
  }
  .pu-callout-ic {
    width: 38px; height: 38px; border-radius: 12px; display: grid; place-items: center; color: var(--pp-accent);
    border: 1px solid color-mix(in srgb, var(--pp-accent) 40%, transparent); background: rgba(10, 10, 10, 0.5);
  }
  .pu-callout-ic svg { width: 18px; height: 18px; }
  .pu-callout-main strong { display: block; font-size: 14px; color: var(--pp-fg); }
  .pu-callout-main p { margin: 3px 0 0; font-size: 12.5px; color: var(--pp-muted); line-height: 1.5; }
  .pu-callout-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
  .pu-callout-actions .pm-action { display: inline-flex; align-items: center; gap: 6px; text-decoration: none; }

  .pu-wrap { display: grid; gap: 18px; margin-top: 6px; }
  .pu-account {
    display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 16px; align-items: center;
    padding: 18px 20px; border-radius: 18px; border: 1px solid color-mix(in srgb, var(--pp-accent) 35%, var(--pp-line));
    background:
      radial-gradient(90% 160% at 100% 0%, color-mix(in srgb, var(--pp-accent) 12%, transparent), transparent 55%),
      var(--pp-card);
  }
  .pu-account-ic {
    width: 44px; height: 44px; border-radius: 14px; display: grid; place-items: center; color: #0a0a0a;
    background: linear-gradient(135deg, #fde68a, #fbbf24 55%, #d97706);
  }
  .pu-account-ic svg { width: 20px; height: 20px; }
  .pu-account-main h2 { margin: 0; font-size: 15px; color: var(--pp-fg); }
  .pu-account-main p { margin: 4px 0 0; font-size: 12.5px; color: var(--pp-muted); line-height: 1.5; }
  .pu-account-actions { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
  .pu-account-actions .pm-action { display: inline-flex; align-items: center; gap: 6px; }
  .pu-warn { color: var(--pp-warn); }

  .pu-list { display: grid; border: 1px solid var(--pp-line); border-radius: 14px; overflow: hidden; background: var(--pp-card); }
  .pu-row {
    display: grid; grid-template-columns: minmax(120px, 0.8fr) minmax(0, 2fr) auto 72px; gap: 12px; align-items: center;
    padding: 10px 14px; border-top: 1px solid var(--pp-line); min-height: 52px;
  }
  .pu-row:first-child { border-top: 0; }
  .pu-row-name { all: unset; cursor: pointer; font-weight: 600; font-size: 13.5px; color: var(--pp-fg); }
  .pu-row-name:hover, .pu-row-name:focus-visible { color: var(--pp-accent); }
  .pu-row-sub { font-size: 12px; color: var(--pp-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pu-row-act { justify-self: end; }
  .pu-fine { margin: 10px 2px 0; font-size: 12px; color: var(--pp-muted); }

  .pu-upsell {
    position: relative; overflow: hidden; max-width: 760px; margin: 40px auto; padding: 32px 28px; border-radius: 22px;
    border: 1px solid color-mix(in srgb, var(--pp-accent) 40%, var(--pp-line)); background: var(--pp-card);
  }
  .pu-upsell-glow { position: absolute; inset: -40% -20% auto auto; width: 70%; height: 120%; pointer-events: none;
    background: radial-gradient(closest-side, color-mix(in srgb, var(--pp-accent) 22%, transparent), transparent); }
  .pu-upsell h1 { position: relative; margin: 6px 0 6px; font-size: 26px; color: var(--pp-fg); }
  .pu-upsell-sub { position: relative; margin: 0 0 18px; color: var(--pp-muted); font-size: 14px; }

  @media (max-width: 720px) {
    .pu-callout, .pu-account { grid-template-columns: auto minmax(0, 1fr); }
    .pu-callout-actions, .pu-account-actions { grid-column: 1 / -1; justify-content: flex-start; align-items: stretch; flex-direction: row; flex-wrap: wrap; }
    .pu-callout-actions .pm-action, .pu-account-actions .pm-action { min-height: 44px; flex: 1 1 auto; justify-content: center; }
    .pu-row { grid-template-columns: minmax(0, 1fr) auto; }
    .pu-row-sub { display: none; }
    .pu-row-act { grid-column: 1 / -1; justify-self: stretch; }
    .pu-row-act .pm-action { width: 100%; min-height: 44px; }
  }
  .pu-badge.b-free { color: var(--pp-fg); border-color: var(--pp-line-strong); background: rgba(10, 10, 10, 0.72); }
  .pu-strip { margin: 0 0 14px; }
  .pu-callout-connect { grid-column: 1 / -1; display: grid; gap: 8px; margin-top: 6px; }
  .pu-callout-connect p { margin: 0; font-size: 12.5px; color: var(--pp-muted); }
`;
