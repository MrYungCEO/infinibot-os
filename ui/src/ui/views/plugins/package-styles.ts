/**
 * Plugins page — styles for package import, the permission review, the
 * Marketplace tab and update controls (packages.ts). Uses the page's own
 * --pp-* tokens so it follows light/dark.
 */

import { css } from "lit";

export const PACKAGE_STYLES = css`
  .pk-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin: 14px 0 10px; }
  .pk-tabs { display: inline-flex; gap: 2px; padding: 3px; border: 1px solid var(--pp-line-strong); border-radius: 999px; background: var(--pp-raised); }
  .pk-tabs button {
    display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 16px; border: 0; border-radius: 999px;
    background: transparent; color: var(--pp-muted); font-size: 13px; cursor: pointer;
  }
  .pk-tabs button:hover { color: var(--pp-fg); }
  .pk-tabs button[aria-selected="true"] { background: var(--pp-accent); color: #0a0a0a; font-weight: 600; }
  .pk-tabs button:focus-visible, .pk-import:focus-within { outline: 2px solid var(--pp-accent); outline-offset: 2px; }
  .pk-badge {
    min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px; display: inline-grid; place-items: center;
    font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums; background: var(--pp-ok); color: #052e16;
  }
  .pk-tabs button[aria-selected="true"] .pk-badge { background: #0a0a0a; color: var(--pp-accent); }
  .pk-bar-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .pk-bar-actions .pp-btn { display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 14px; border-radius: 999px; font-size: 12.5px; }
  .pk-quiet { background: transparent; }
  .pk-import { cursor: pointer; position: relative; }

  .pk-url { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1.4fr) auto; gap: 10px; align-items: end; padding: 12px; margin-bottom: 10px; border: 1px solid var(--pp-line); border-radius: 12px; background: var(--pp-card); }
  .pk-url .pp-btn { height: 36px; padding: 0 16px; border-radius: 999px; }
  .pk-field { display: grid; gap: 5px; font-size: 11.5px; color: var(--pp-muted); min-width: 0; }
  .pk-field .pp-input { width: 100%; max-width: 100%; height: 36px; font-size: 12.5px; }
  .pk-progress { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; font-size: 12.5px; color: var(--pp-muted); margin-bottom: 10px; }
  .pk-progress progress { flex: 1; min-width: 140px; height: 6px; accent-color: var(--pp-accent); }
  .pk-notice { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .pk-notice-actions { display: inline-flex; gap: 12px; }

  /* update chip on cards / rows */
  .pk-update-chip {
    display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600;
    white-space: nowrap; color: var(--pp-ok); border: 1px solid color-mix(in srgb, var(--pp-ok) 55%, transparent);
    background: color-mix(in srgb, var(--pp-ok) 12%, transparent);
  }
  .pm-cover .pk-update-chip { position: absolute; right: 10px; bottom: 10px; z-index: 1; background: rgba(5, 46, 22, 0.86); color: #86efac; border-color: rgba(134, 239, 172, 0.5); }

  /* marketplace */
  .pk-market-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
  .pk-market-head .pm-search { flex: 1 1 240px; }
  .pk-market-head .pp-btn { display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 14px; border-radius: 999px; font-size: 12.5px; }
  .pk-market-meta { font-size: 11.5px; color: var(--pp-muted); overflow-wrap: anywhere; }
  /* Marketplace cards are the Installed tab's .pm-card (card.ts); only the extras live here. */
  /* The plugin an "Install in InfiniBot" link pointed at. */
  .pm-card.pk-focus { outline: 2px solid var(--pp-accent, #d4af37); outline-offset: 2px; }
  .pk-price { flex: none; font-size: 12px; font-weight: 700; padding: 3px 9px; border-radius: 999px; border: 1px solid var(--pp-line-strong); color: var(--pp-fg); white-space: nowrap; }
  .pk-price.free { color: var(--pp-ok); border-color: color-mix(in srgb, var(--pp-ok) 45%, transparent); }
  .pk-price.paid { color: var(--pp-accent-text); border-color: color-mix(in srgb, var(--pp-accent) 55%, transparent); }
  /* On the cover / hero art (always dark): glass chip, like the tier pill. */
  .pm-cover .pk-price, .pm-dhero .pk-price {
    background: rgba(8, 8, 10, 0.72); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
  }
  .pm-cover .pk-price { position: absolute; right: 10px; bottom: 10px; z-index: 1; }
  .pm-cover .pk-price.paid, .pm-dhero .pk-price.paid { color: #fde68a; border-color: rgba(251, 191, 36, 0.5); }
  .pm-cover .pk-price.free, .pm-dhero .pk-price.free { color: #86efac; border-color: rgba(134, 239, 172, 0.45); }
  .pm-dhero .pk-price { font-size: 15px; padding: 6px 14px; }
  .pm-dhero .pk-installed { color: #4ade80; }
  .pk-verified { display: inline-grid; place-items: center; width: 14px; height: 14px; margin-left: 4px; border-radius: 50%; background: var(--pp-ok); color: #052e16; vertical-align: -2px; }
  .pk-inline-err { margin: 0; font-size: 12px; color: var(--pp-danger); }
  .pm-card-foot .pm-link, .pm-card .pk-card-dl { position: relative; z-index: 1; }
  .pm-card .pk-card-dl { align-self: flex-start; padding: 0; }
  .pk-installed { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 600; color: var(--pp-ok); white-space: nowrap; }
  :host([data-mode="light"]) .pm-card .pk-installed { color: #15803d; }
  .pk-empty { padding: 36px 16px; text-align: center; color: var(--pp-muted); border: 1px dashed var(--pp-line-strong); border-radius: 12px; }

  /* review modal */
  .pp-modal.pk-review { max-width: 580px; max-height: min(86vh, 760px); overflow: auto; }
  /* The decision buttons stay in view while the review scrolls. */
  .pp-modal.pk-review > .pp-actions {
    position: sticky; bottom: -18px; margin: 12px -18px -18px; padding: 12px 18px;
    background: var(--pp-card); border-top: 1px solid var(--pp-line);
  }
  .pk-review-sub { margin: 0 0 10px; font-size: 12.5px; color: var(--pp-muted); }
  .pk-review-sub b { color: var(--pp-strong); }
  .pk-h4 { margin: 14px 0 8px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--pp-muted); }
  .pk-perms { list-style: none; margin: 0 0 10px; padding: 0; display: grid; gap: 6px; }
  .pk-perm { padding: 9px 11px; border: 1px solid var(--pp-line); border-radius: 10px; background: var(--pp-raised); display: grid; gap: 5px; }
  .pk-perm.gated { border-color: color-mix(in srgb, var(--pp-warn) 50%, transparent); }
  .pk-perm-text { font-size: 13px; color: var(--pp-fg); line-height: 1.4; }
  .pk-perm-meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 11px; color: var(--pp-muted); }
  .pk-flag { padding: 1px 7px; border-radius: 999px; font-weight: 600; border: 1px solid transparent; }
  .pk-flag.new { color: var(--pp-accent-text); border-color: color-mix(in srgb, var(--pp-accent) 55%, transparent); }
  .pk-flag.gated { color: var(--pp-warn); border-color: color-mix(in srgb, var(--pp-warn) 55%, transparent); }
  .pk-details { margin: 8px 0; font-size: 12.5px; }
  .pk-details summary { cursor: pointer; color: var(--pp-muted); padding: 4px 0; }
  .pk-details summary:focus-visible { outline: 2px solid var(--pp-accent); outline-offset: 2px; }
  .pk-pre { margin: 6px 0 0; padding: 10px; max-height: 180px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; border: 1px solid var(--pp-line); border-radius: 8px; background: var(--pp-raised); }
  .pk-accept { display: flex; gap: 10px; align-items: flex-start; margin: 12px 0 6px; padding: 10px 12px; border: 1px solid var(--pp-line-strong); border-radius: 10px; font-size: 13px; cursor: pointer; }
  .pk-accept input, .pk-auto input { margin-top: 2px; width: 16px; height: 16px; accent-color: var(--pp-accent); flex: none; }

  /* versions section */
  .pk-changelog { margin: 12px 0; padding: 12px; border: 1px solid var(--pp-line); border-radius: 12px; background: var(--pp-raised); }
  .pk-changelog h4 { margin: 0 0 8px; font-size: 13px; color: var(--pp-strong); }
  .pk-change + .pk-change { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--pp-line); }
  .pk-change-head { display: flex; gap: 10px; align-items: baseline; font-size: 12.5px; }
  .pk-change p { margin: 4px 0 0; font-size: 12.5px; white-space: pre-wrap; overflow-wrap: anywhere; }
  .pk-auto { display: flex; gap: 10px; align-items: flex-start; margin: 12px 0; font-size: 12.5px; cursor: pointer; }

  /* drag & drop */
  .pk-drop { position: fixed; inset: 0; z-index: 60; display: grid; place-items: center; padding: 24px; background: rgba(0, 0, 0, 0.6); pointer-events: none; }
  .pk-drop-box { display: grid; justify-items: center; gap: 8px; padding: 36px 44px; text-align: center; border: 2px dashed var(--pp-accent); border-radius: 18px; background: var(--pp-card); color: var(--pp-strong); }
  .pk-drop-box span { font-size: 12.5px; color: var(--pp-muted); }
  .pk-drop-box svg { width: 28px; height: 28px; color: var(--pp-accent); }

  @media (max-width: 760px) {
    .pk-bar { align-items: stretch; }
    .pk-tabs { width: 100%; }
    .pk-tabs button { flex: 1; justify-content: center; }
    .pk-bar-actions { width: 100%; }
    .pk-bar-actions .pp-btn { flex: 1; justify-content: center; }
    .pk-url { grid-template-columns: 1fr; }
    .pp-modal.pk-review { padding: 14px; }
    .pp-modal.pk-review > .pp-actions { bottom: -14px; margin: 12px -14px -14px; padding: 10px 14px; }
  }
`;
