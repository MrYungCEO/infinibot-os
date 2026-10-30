/**
 * Plugins marketplace styles — browse grid, cards, store-listing detail page.
 *
 * Built on the Plugins page token layer (styles.ts: --pp-*), which only reads
 * core tokens the palette applier never rewrites (--card, --card-foreground,
 * --border, --muted*, --ok/--warn/--danger). The host carries
 * `data-mode="light|dark"` (set from <html data-theme>) so light mode pins its
 * own readable text colours even while the app-wide palette bug writes
 * dark-theme --text/--bg on :root. Cover art and the detail hero are dark in
 * both themes by design (gold-on-black product art), with fixed light text.
 */

import { css } from "lit";

export const MARKET_STYLES = css`
  :host {
    padding: 20px 24px 48px;
    --pp-accent: var(--g-primary, var(--accent, #fbbf24));
    --pm-radius: 14px;
    --pm-radius-sm: 10px;
    --pm-ease: var(--ease-out, cubic-bezier(0.16, 1, 0.3, 1));
    --pm-glass: color-mix(in srgb, var(--pp-card) 86%, transparent);
    --pm-shadow: 0 18px 40px -22px rgba(0, 0, 0, 0.7);
    --pm-accent-soft: color-mix(in srgb, var(--pp-accent) 12%, transparent);
    --pm-accent-line: color-mix(in srgb, var(--pp-accent) 45%, transparent);
    --pm-risk-high: var(--pp-danger);
    --pm-risk-medium: var(--pp-warn);
    --pm-risk-low: var(--pp-ok);
    --pm-info: var(--info, #3b82f6);
  }
  :host([data-mode="light"]) {
    --pp-fg: var(--card-foreground, #18181b);
    --pp-strong: var(--text-strong, #18181b);
    --pp-muted: var(--muted-strong, #52525b);
    --pp-card: var(--card, #ffffff);
    --pp-raised: #f7f7f5;
    --pp-hover: #f2f1ee;
    --pp-line: var(--border, #e4e4e7);
    --pp-line-strong: var(--border-strong, #d4d4d8);
    --pp-accent-text: color-mix(in srgb, var(--pp-accent) 48%, #000);
    --pm-glass: color-mix(in srgb, #ffffff 88%, transparent);
    --pm-shadow: 0 16px 36px -22px rgba(24, 24, 27, 0.35);
    --pm-risk-high: #b91c1c;
    --pm-risk-medium: #a16207;
    --pm-risk-low: #15803d;
    --pm-info: #1d4ed8;
  }

  .pm-page { max-width: 1680px; margin: 0 auto; }
  .pp-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; flex: none; }
  :focus-visible { outline: 2px solid var(--pp-accent); outline-offset: 2px; }

  /* ── hero ── */
  .pm-kv-link { margin: 0 0 18px; min-width: 0; }
  .pm-hero {
    position: relative; overflow: hidden; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 24px; align-items: end;
    padding: 28px 28px 24px; border: 1px solid var(--pp-line); border-radius: 18px; margin-bottom: 16px;
    background:
      radial-gradient(120% 140% at 100% 0%, color-mix(in srgb, var(--pp-accent) 14%, transparent) 0%, transparent 55%),
      linear-gradient(180deg, color-mix(in srgb, var(--pp-accent) 4%, var(--pp-card)), var(--pp-card));
  }
  .pm-hero-glow {
    position: absolute; inset: -40% -10% auto auto; width: 420px; height: 420px; pointer-events: none;
    background: radial-gradient(closest-side, color-mix(in srgb, var(--pp-accent) 18%, transparent), transparent);
    filter: blur(8px);
  }
  .pm-hero-text { position: relative; min-width: 0; }
  .pm-eyebrow { margin: 0 0 6px; font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--pp-accent-text); font-weight: 600; }
  .pm-hero-title { margin: 0; font-family: var(--font-display, inherit); font-size: clamp(26px, 3.2vw, 36px); line-height: 1.1; letter-spacing: -0.02em; color: var(--pp-strong); font-weight: 700; }
  .pm-hero-sub { margin: 8px 0 0; max-width: 62ch; font-size: 13px; line-height: 1.6; color: var(--pp-muted); }
  .pm-hero-stats { position: relative; display: flex; gap: 8px; margin: 0; }
  .pm-hero-stats div { min-width: 92px; padding: 10px 14px; border: 1px solid var(--pp-line); border-radius: var(--pm-radius-sm); background: var(--pm-glass); }
  .pm-hero-stats dt { font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--pp-muted); }
  .pm-hero-stats dd { margin: 2px 0 0; font-size: 22px; font-weight: 700; color: var(--pp-strong); font-variant-numeric: tabular-nums; }

  /* ── toolbar ── */
  .pm-toolbar {
    position: sticky; top: var(--pm-stick-top, 0px); z-index: 6; margin: 0 -4px 18px; padding: 10px 4px;
    background: var(--pm-glass); backdrop-filter: blur(12px) saturate(140%); -webkit-backdrop-filter: blur(12px) saturate(140%);
    border-bottom: 1px solid var(--pp-line);
  }
  .pm-toolbar-row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
  .pm-toolbar-end { display: flex; gap: 8px; align-items: center; margin-left: auto; }
  .pm-search {
    flex: 1 1 280px; min-width: 200px; display: flex; align-items: center; gap: 8px; height: 38px; padding: 0 12px;
    border: 1px solid var(--pp-line-strong); border-radius: 999px; background: var(--pp-raised); color: var(--pp-muted);
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }
  .pm-search:focus-within { border-color: var(--pp-accent); box-shadow: 0 0 0 3px var(--pm-accent-soft); }
  .pm-search input { flex: 1; min-width: 0; border: none; background: none; outline: none; color: var(--pp-fg); font: inherit; font-size: 13px; }
  .pm-search input::placeholder { color: var(--pp-muted); opacity: 0.85; }
  .pm-seg { display: inline-flex; padding: 3px; gap: 2px; border: 1px solid var(--pp-line-strong); border-radius: 999px; background: var(--pp-raised); }
  .pm-seg button {
    display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 12px; border: none; border-radius: 999px;
    background: none; color: var(--pp-muted); font-size: 12px; cursor: pointer; white-space: nowrap;
  }
  .pm-seg button:hover { color: var(--pp-fg); }
  .pm-seg button[aria-checked="true"] { background: var(--pp-accent); color: #0a0a0a; font-weight: 600; }
  .pm-seg-n { font-size: 10.5px; opacity: 0.75; font-variant-numeric: tabular-nums; }
  .pm-sort select {
    height: 38px; padding: 0 30px 0 12px; border: 1px solid var(--pp-line-strong); border-radius: 999px; background: var(--pp-raised);
    color: var(--pp-fg); font: inherit; font-size: 12px; cursor: pointer; appearance: none;
    background-image: linear-gradient(45deg, transparent 50%, currentColor 50%), linear-gradient(135deg, currentColor 50%, transparent 50%);
    background-position: calc(100% - 16px) 17px, calc(100% - 11px) 17px; background-size: 5px 5px; background-repeat: no-repeat;
  }
  .pm-layout { display: inline-flex; border: 1px solid var(--pp-line-strong); border-radius: 999px; padding: 3px; background: var(--pp-raised); }
  .pm-layout button { width: 32px; height: 30px; display: grid; place-items: center; border: none; border-radius: 999px; background: none; color: var(--pp-muted); cursor: pointer; }
  .pm-layout button[aria-pressed="true"] { background: var(--pm-accent-soft); color: var(--pp-accent-text); }
  .pm-chips-row { display: flex; flex-wrap: wrap; gap: 8px 16px; margin-top: 10px; align-items: center; }
  .pm-chipset { display: flex; flex-wrap: wrap; gap: 6px; }
  .pm-fchip {
    display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 12px; border-radius: 999px; cursor: pointer;
    border: 1px solid var(--pp-line); background: transparent; color: var(--pp-muted); font-size: 12px; white-space: nowrap;
    transition: border-color 0.15s ease, color 0.15s ease, background 0.15s ease;
  }
  .pm-fchip:hover { color: var(--pp-fg); border-color: var(--pp-line-strong); }
  .pm-fchip[aria-pressed="true"] { color: var(--pp-accent-text); border-color: var(--pm-accent-line); background: var(--pm-accent-soft); font-weight: 600; }

  /* ── sections + grid ── */
  .pm-section { margin: 0 0 30px; }
  .pm-section-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
  .pm-section-title { margin: 0; font-size: 17px; font-weight: 700; color: var(--pp-strong); letter-spacing: -0.01em; display: flex; align-items: center; gap: 8px; }
  .pm-section-blurb { margin: 3px 0 0; font-size: 12.5px; color: var(--pp-muted); }
  .pm-count { font-size: 11px; font-weight: 600; color: var(--pp-muted); padding: 1px 8px; border: 1px solid var(--pp-line); border-radius: 999px; }
  .pm-link { border: none; background: none; color: var(--pp-accent-text); font-size: 12px; cursor: pointer; padding: 4px 0; }
  .pm-link:hover { text-decoration: underline; }
  .pm-results-meta { font-size: 12px; color: var(--pp-muted); margin: 0 0 10px; }
  .pm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(262px, 1fr)); gap: 16px; }

  /* ── card ── */
  .pm-card {
    position: relative; display: flex; flex-direction: column; min-width: 0; overflow: hidden;
    border: 1px solid var(--pp-line); border-radius: var(--pm-radius); background: var(--pp-card);
    transition: transform 0.22s var(--pm-ease), border-color 0.22s ease, box-shadow 0.22s ease;
  }
  .pm-card:hover { transform: translateY(-3px); border-color: var(--pm-accent-line); box-shadow: var(--pm-shadow), 0 0 0 1px var(--pm-accent-soft); }
  .pm-card:focus-within { border-color: var(--pm-accent-line); }
  .pm-card:has(.pm-stretch:focus-visible) { outline: 2px solid var(--pp-accent); outline-offset: 2px; }
  .pm-cover { position: relative; aspect-ratio: 16 / 9; background: #0b0b0d; overflow: hidden; }
  .pm-cover img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform 0.5s var(--pm-ease); }
  .pm-card:hover .pm-cover img { transform: scale(1.035); }
  .pm-cover::after { content: ""; position: absolute; inset: auto 0 0 0; height: 40%; background: linear-gradient(180deg, transparent, rgba(0, 0, 0, 0.35)); pointer-events: none; }
  .pm-tier {
    display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase;
    padding: 3px 8px; border-radius: 999px; white-space: nowrap;
    border: 1px solid var(--pp-line-strong); color: var(--pp-muted);
  }
  .pm-tier-glyph svg { width: 11px; height: 11px; }
  .pm-tier.t-first-party { color: var(--pp-accent-text); border-color: var(--pm-accent-line); background: var(--pm-accent-soft); }
  .pm-tier.t-verified { color: var(--pm-info); border-color: color-mix(in srgb, var(--pm-info) 45%, transparent); }
  .pm-cover .pm-tier, .pm-dhero .pm-tier {
    position: absolute; top: 10px; left: 10px; z-index: 1; background: rgba(8, 8, 10, 0.72); color: #e7e5e4; border-color: rgba(255, 255, 255, 0.16);
    backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
  }
  .pm-cover .pm-tier.t-first-party, .pm-dhero .pm-tier.t-first-party { color: #fde68a; border-color: rgba(251, 191, 36, 0.45); }
  .pm-dhero .pm-tier { position: static; }
  .pm-card-body { display: flex; flex-direction: column; gap: 10px; padding: 0 14px 14px; flex: 1; }
  .pm-card-head { display: flex; gap: 10px; align-items: flex-start; position: relative; }
  .pm-card-head > .pm-icon { margin-top: -22px; }
  .pm-card-title { min-width: 0; padding-top: 8px; }
  .pm-name { margin: 0; font-size: 15px; font-weight: 700; line-height: 1.25; color: var(--pp-strong); }
  .pm-stretch { all: unset; cursor: pointer; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
  .pm-stretch::after { content: ""; position: absolute; inset: 0; z-index: 0; }
  .pm-byline { font-size: 12px; color: var(--pp-muted); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pm-desc { margin: 0; font-size: 13px; line-height: 1.55; color: var(--pp-fg); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; min-height: calc(13px * 1.55 * 2); }
  .pm-tags { display: flex; flex-wrap: wrap; gap: 5px; }
  .pm-tags.lg { margin-top: 14px; }
  .pm-chip { font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--pp-line); color: var(--pp-muted); background: var(--pp-raised); white-space: nowrap; }
  .pm-chip.cat { color: var(--pp-fg); border-color: var(--pp-line-strong); }
  .pm-card-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: auto; padding-top: 10px; border-top: 1px solid var(--pp-line); }
  .pm-card-foot .pm-action { position: relative; z-index: 1; }
  .pm-foot-actions { display: inline-flex; align-items: center; gap: 6px; }
  .pm-tour { position: relative; z-index: 1; display: inline-flex; align-items: center; gap: 5px; min-height: 32px; padding: 0 10px; border-radius: 9px; font: inherit; font-size: 12px; font-weight: 600; cursor: pointer;
    color: var(--g-primary, #d4af37); background: color-mix(in srgb, var(--g-primary, #d4af37) 10%, transparent); border: 1px solid color-mix(in srgb, var(--g-primary, #d4af37) 45%, transparent); white-space: nowrap; }
  .pm-tour:hover, .pm-tour:focus-visible { background: color-mix(in srgb, var(--g-primary, #d4af37) 20%, transparent); outline: none; }
  .pm-tour.lg { min-height: 40px; padding: 0 14px; font-size: 13px; }
  @media (max-width: 420px) { .pm-tour span { display: none; } .pm-tour { padding: 0 9px; } }

  /* ── icon tile ── */
  .pm-icon {
    flex: none; display: grid; place-items: center; overflow: hidden; font-weight: 800; letter-spacing: 0.02em;
    color: color-mix(in srgb, var(--plugin-accent, var(--pp-accent)) 55%, var(--pp-strong));
    background: linear-gradient(145deg, color-mix(in srgb, var(--plugin-accent, var(--pp-accent)) 22%, var(--pp-card)), var(--pp-card));
    border: 1px solid color-mix(in srgb, var(--plugin-accent, var(--pp-accent)) 45%, transparent);
    box-shadow: 0 0 0 3px var(--pp-card);
  }
  .pm-icon.has-img { background: #0b0b0d; }
  .pm-icon img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .pm-icon.sm { width: 32px; height: 32px; border-radius: 9px; font-size: 11px; box-shadow: none; }
  .pm-icon.md { width: 46px; height: 46px; border-radius: 12px; font-size: 14px; }
  .pm-icon.lg { width: 64px; height: 64px; border-radius: 16px; font-size: 19px; }
  .pm-icon.xl { width: 88px; height: 88px; border-radius: 22px; font-size: 26px; box-shadow: 0 10px 30px -10px rgba(0, 0, 0, 0.8); }
  .pm-dhero .pm-icon:not(.has-img) { color: #fde68a; background: linear-gradient(145deg, rgba(251, 191, 36, 0.28), rgba(12, 12, 14, 0.92)); border-color: rgba(251, 191, 36, 0.5); }

  /* ── status + actions ── */
  .pm-status { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: var(--pp-muted); white-space: nowrap; }
  .pm-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; flex: none; }
  .pm-status.s-on { color: var(--pp-ok); }
  :host([data-mode="light"]) .pm-status.s-on { color: #15803d; }
  .pm-status.s-setup, .pm-status.s-degraded, .pm-status.s-applying { color: var(--pp-warn); }
  .pm-status.s-locked, .pm-status.s-soon, .pm-status.s-selfhost { color: var(--pp-muted, #a1a1aa); }
  .pm-status.s-locked .pm-dot { background: var(--pp-warn); }
  .pm-cloud-note { display: flex; gap: 10px; align-items: flex-start; padding: 12px 14px; margin: 0 0 16px; border-radius: 12px; border: 1px solid color-mix(in srgb, var(--pp-warn) 45%, transparent); background: color-mix(in srgb, var(--pp-warn) 10%, transparent); font-size: 13px; line-height: 1.5; }
  .pm-cloud-note strong { display: block; margin-bottom: 2px; }
  .pm-cloud-note[data-cloud-partial] { border-color: color-mix(in srgb, var(--pp-accent, var(--pp-warn)) 40%, transparent); background: color-mix(in srgb, var(--pp-accent, var(--pp-warn)) 7%, transparent); }
  .pm-cloud-features { margin: 4px 0 0; padding-left: 18px; }
  .pm-cloud-features li { margin: 2px 0; }
  .pm-plan-lock { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 11px; border-radius: 999px; cursor: pointer; white-space: nowrap; font: 600 11.5px/1 inherit; font-family: inherit; color: #1a1408; border: 1px solid rgba(232, 184, 75, 0.7); background: linear-gradient(180deg, #f1cd6f, #d9a436); box-shadow: 0 4px 14px rgba(232, 184, 75, 0.2); }
  .pm-plan-lock:hover { filter: brightness(1.06); }
  .pm-plan-lock:focus-visible { outline: 2px solid #f1cd6f; outline-offset: 2px; }
  .pm-plan-lock svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
  :host([data-mode="light"]) .pm-status.s-setup, :host([data-mode="light"]) .pm-status.s-degraded, :host([data-mode="light"]) .pm-status.s-applying { color: #a16207; }
  .pm-status.s-error { color: var(--pp-danger); }
  :host([data-mode="light"]) .pm-status.s-error { color: #b91c1c; }
  .pm-status.s-update { color: var(--pm-info); }
  .pm-status.s-applying .pm-dot { animation: pm-pulse 1.1s ease-in-out infinite; }
  @keyframes pm-pulse { 50% { opacity: 0.3; } }
  .pm-action {
    height: 30px; padding: 0 14px; border-radius: 999px; font-size: 12px; font-weight: 600; cursor: pointer; white-space: nowrap;
    border: 1px solid var(--pp-line-strong); background: var(--pp-raised); color: var(--pp-fg);
    transition: background 0.15s ease, border-color 0.15s ease, transform 0.15s ease;
  }
  .pm-action:hover { border-color: var(--pp-accent); }
  .pm-action:active { transform: scale(0.97); }
  .pm-action.primary { background: var(--pp-accent); border-color: var(--pp-accent); color: #0a0a0a; }
  .pm-action.primary:hover { filter: brightness(1.08); }
  .pm-action.lg { height: 38px; padding: 0 20px; font-size: 13px; }

  /* ── installed shelf ── */
  .pm-shelf { display: flex; gap: 10px; overflow-x: auto; padding: 2px 2px 8px; scroll-snap-type: x proximity; scrollbar-width: thin; }
  .pm-tile {
    position: relative; flex: 0 0 214px; scroll-snap-align: start; display: flex; gap: 10px; align-items: center; padding: 10px 12px;
    border: 1px solid var(--pp-line); border-radius: var(--pm-radius-sm); background: var(--pp-card); transition: border-color 0.15s ease;
  }
  .pm-tile:hover { border-color: var(--pm-accent-line); }
  .pm-tile-main { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .pm-tile-name { all: unset; cursor: pointer; font-size: 13px; font-weight: 600; color: var(--pp-strong); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pm-tile-name::after { content: ""; position: absolute; inset: 0; }
  .pm-tile-name:focus-visible { outline: none; }
  .pm-tile:has(.pm-tile-name:focus-visible) { outline: 2px solid var(--pp-accent); outline-offset: 2px; }

  /* ── compact list ── */
  .pm-list { border: 1px solid var(--pp-line); border-radius: var(--pm-radius); overflow: hidden; background: var(--pp-card); }
  .pm-row { display: grid; grid-template-columns: 32px minmax(0, 1fr) auto 76px 124px auto; gap: 12px; align-items: center; padding: 10px 14px; border-top: 1px solid var(--pp-line); }
  .pm-row:first-child { border-top: none; }
  .pm-row:hover { background: var(--pp-hover); }
  .pm-row-main { min-width: 0; }
  .pm-row-name { all: unset; cursor: pointer; font-size: 13px; font-weight: 600; color: var(--pp-strong); }
  .pm-row-name:hover { text-decoration: underline; }
  .pm-row-name:focus-visible { outline: 2px solid var(--pp-accent); outline-offset: 2px; }
  .pm-row-sub { font-size: 11.5px; color: var(--pp-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pm-row-ver { font-size: 11.5px; color: var(--pp-muted); font-variant-numeric: tabular-nums; }

  /* ── skeleton + empty ── */
  .pm-skel .pm-cover { background: var(--pp-raised); }
  .pm-skel .pm-card-body { padding-top: 16px; }
  .sk { height: 11px; border-radius: 6px; margin: 6px 0; background: linear-gradient(90deg, var(--pp-raised) 0%, var(--pp-hover) 50%, var(--pp-raised) 100%); background-size: 200% 100%; animation: pm-shimmer 1.4s linear infinite; }
  .sk.w40 { width: 40%; } .sk.w60 { width: 60%; } .sk.w90 { width: 90%; }
  @keyframes pm-shimmer { to { background-position: -200% 0; } }
  .pm-empty { text-align: center; padding: 56px 20px; border: 1px dashed var(--pp-line-strong); border-radius: var(--pm-radius); background: var(--pp-card); }
  .pm-empty h3 { margin: 12px 0 6px; font-size: 16px; color: var(--pp-strong); }
  .pm-empty p { margin: 0 auto 16px; max-width: 46ch; font-size: 13px; line-height: 1.55; color: var(--pp-muted); }
  .pm-empty-art { display: inline-grid; place-items: center; width: 56px; height: 56px; border-radius: 16px; color: var(--pp-accent-text); background: var(--pm-accent-soft); border: 1px solid var(--pm-accent-line); }
  .pm-empty-art svg { width: 26px; height: 26px; }

  /* ── detail hero ── */
  .pm-detail { min-width: 0; }
  .pm-dhero { position: relative; overflow: hidden; border-radius: 18px; border: 1px solid var(--pp-line); background: #0b0b0d; min-height: 300px; display: flex; flex-direction: column; justify-content: flex-end; color: #f4f4f5; }
  .pm-dhero-cover { position: absolute; inset: 0; }
  .pm-dhero-cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .pm-dhero-shade { position: absolute; inset: 0; background: linear-gradient(180deg, rgba(6, 6, 8, 0.1) 0%, rgba(6, 6, 8, 0.55) 45%, rgba(6, 6, 8, 0.94) 100%); }
  .pm-back {
    position: absolute; top: 14px; left: 14px; z-index: 2; display: inline-flex; align-items: center; gap: 4px; height: 32px; padding: 0 12px 0 8px;
    border-radius: 999px; border: 1px solid rgba(255, 255, 255, 0.18); background: rgba(8, 8, 10, 0.6); color: #f4f4f5; font-size: 12px; cursor: pointer;
    backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
  }
  .pm-back:hover { border-color: rgba(251, 191, 36, 0.6); }
  .pm-detail-missing .pm-back { position: static; margin-bottom: 14px; color: var(--pp-fg); background: var(--pp-raised); border-color: var(--pp-line-strong); }
  .pm-dhero-body { position: relative; z-index: 1; display: flex; gap: 20px; align-items: flex-end; padding: 96px 26px 24px; }
  .pm-dhero-text { flex: 1; min-width: 0; }
  .pm-dhero-kicker { font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; color: #fcd34d; font-weight: 600; }
  .pm-dname { margin: 4px 0 0; font-family: var(--font-display, inherit); font-size: clamp(24px, 3vw, 34px); font-weight: 800; letter-spacing: -0.02em; line-height: 1.1; color: #ffffff; }
  .pm-dtagline { margin: 6px 0 0; font-size: 14px; line-height: 1.5; color: #d4d4d8; max-width: 70ch; }
  .pm-dmeta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; margin-top: 12px; font-size: 12px; color: #d4d4d8; }
  .pm-dhero .pm-status.s-on { color: #4ade80; }
  .pm-dhero .pm-status.s-off { color: #d4d4d8; }
  .pm-dhero .pm-status.s-setup, .pm-dhero .pm-status.s-applying, .pm-dhero .pm-status.s-degraded { color: #fcd34d; }
  .pm-dhero .pm-status.s-error { color: #fca5a5; }
  .pm-dactions { display: flex; flex-direction: column; align-items: flex-end; gap: 10px; }
  .pm-onoff { display: inline-flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 999px; background: rgba(8, 8, 10, 0.55); border: 1px solid rgba(255, 255, 255, 0.14); }
  .pm-switch-label { font-size: 12px; font-weight: 600; color: #f4f4f5; min-width: 26px; }
  .pm-dhero .pp-switch { border-color: rgba(255, 255, 255, 0.3); background: rgba(255, 255, 255, 0.08); }
  .pm-dhero .pp-switch::after { background: #d4d4d8; }
  .pm-dhero .pp-switch[aria-checked="true"] { background: rgba(251, 191, 36, 0.35); border-color: #fbbf24; }
  .pm-dhero .pp-switch[aria-checked="true"]::after { background: #fbbf24; }
  .pm-dnote { margin: 12px 0 0; }
  .pm-enable-cta { display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; margin-top: 12px; padding: 12px 16px; border-radius: var(--pm-radius-sm); border: 1px solid var(--pm-accent-line); background: var(--pm-accent-soft); font-size: 13px; }
  /* ── KinglyVault CEO plan (Included badge, Unlock with Vault, member downloads link) ── */
  .pm-vault-badge {
    display: inline-flex; align-items: center; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; white-space: nowrap;
    color: var(--pp-accent-text, var(--pp-accent)); border: 1px solid var(--pm-accent-line); background: var(--pm-accent-soft);
  }
  /* The hero sits on cover art (always dark), in light mode too. */
  .pm-dhero .pm-vault-badge { color: #fde68a; border-color: rgba(251, 191, 36, 0.5); background: rgba(8, 8, 10, 0.6); }
  a.pm-action, a.pp-btn { display: inline-flex; align-items: center; justify-content: center; text-decoration: none; box-sizing: border-box; }
  .pm-card-foot .pm-vault-unlock { position: relative; z-index: 1; }
  .pm-card-foot:has(.pm-vault-unlock) { flex-wrap: wrap; }
  .pm-card-foot:has(.pm-vault-unlock) .pm-foot-actions { flex-wrap: wrap; justify-content: flex-end; margin-left: auto; }
  .pm-action.pm-buy-secondary { position: relative; z-index: 1; background: transparent; }
  .pm-enable-actions { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  a.pm-link.pm-vault-dl { position: relative; z-index: 1; font-size: 12px; text-decoration: underline; text-underline-offset: 3px; white-space: nowrap; }

  /* ── detail nav + layout ── */
  .pm-dnav {
    position: sticky; top: var(--pm-stick-top, 0px); z-index: 6; display: flex; gap: 2px; overflow-x: auto; scrollbar-width: none; margin: 14px 0 0; padding: 0 4px;
    background: var(--pm-glass); backdrop-filter: blur(12px) saturate(140%); -webkit-backdrop-filter: blur(12px) saturate(140%);
    border-bottom: 1px solid var(--pp-line);
  }
  .pm-dnav::-webkit-scrollbar { display: none; }
  .pm-dnav-link {
    display: inline-flex; align-items: center; gap: 6px; padding: 12px 12px 10px; font-size: 12.5px; color: var(--pp-muted); text-decoration: none; white-space: nowrap;
    border-bottom: 2px solid transparent; transition: color 0.15s ease, border-color 0.15s ease;
  }
  .pm-dnav-link:hover { color: var(--pp-fg); }
  .pm-dnav-link[aria-current="true"] { color: var(--pp-strong); border-bottom-color: var(--pp-accent); font-weight: 600; }
  .pm-dnav-link:focus-visible { outline-offset: -2px; }
  .pm-dnav-badge { font-size: 10px; padding: 0 6px; border-radius: 999px; background: var(--pp-raised); border: 1px solid var(--pp-line); color: var(--pp-muted); font-variant-numeric: tabular-nums; }
  .pm-dgrid { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 28px; align-items: start; }
  .pm-dside { position: sticky; top: 60px; margin-top: 22px; padding: 16px; border: 1px solid var(--pp-line); border-radius: var(--pm-radius); background: var(--pp-card); }
  .pm-side-h { margin: 0 0 10px; font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--pp-muted); }
  .pm-facts { margin: 0; display: flex; flex-direction: column; }
  .pm-facts > div { display: grid; grid-template-columns: 104px minmax(0, 1fr); gap: 8px; padding: 8px 0; border-top: 1px solid var(--pp-line); font-size: 12px; }
  .pm-facts > div:first-child { border-top: none; padding-top: 0; }
  .pm-facts dt { color: var(--pp-muted); }
  .pm-facts dd { margin: 0; color: var(--pp-fg); overflow-wrap: anywhere; display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; }
  .pm-ok { color: var(--pp-ok); display: inline-flex; }
  :host([data-mode="light"]) .pm-ok { color: #15803d; }
  .pm-bad, .pm-warn-text { color: var(--pp-warn); display: inline-flex; }
  :host([data-mode="light"]) .pm-bad, :host([data-mode="light"]) .pm-warn-text { color: #a16207; }
  .pm-ext { display: inline-flex; align-items: center; gap: 3px; color: var(--pp-accent-text); text-decoration: none; }
  .pm-ext:hover { text-decoration: underline; }
  .pm-ext-ic svg { width: 12px; height: 12px; }

  .pm-dsec { padding: 26px 0 8px; border-top: 1px solid var(--pp-line); outline: none; }
  .pm-dsec:first-child { border-top: none; }
  .pm-dsec-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 14px; }
  .pm-dsec-title { margin: 0; font-size: 17px; font-weight: 700; color: var(--pp-strong); letter-spacing: -0.01em; }
  .pm-lead { margin: 0 0 14px; font-size: 12.5px; line-height: 1.6; color: var(--pp-muted); max-width: 80ch; }
  .pm-dloading { padding: 24px 0; max-width: 640px; }

  /* ── gallery + prose ── */
  .pm-gallery { display: flex; gap: 12px; overflow-x: auto; padding: 2px 2px 10px; margin-bottom: 18px; scroll-snap-type: x mandatory; scrollbar-width: thin; }
  .pm-shot { flex: 0 0 min(440px, 78%); margin: 0; scroll-snap-align: start; }
  .pm-shot-btn { display: block; width: 100%; padding: 0; border: 1px solid var(--pp-line); border-radius: var(--pm-radius-sm); overflow: hidden; background: #0b0b0d; cursor: zoom-in; aspect-ratio: 16 / 10; }
  .pm-shot-btn img { width: 100%; height: 100%; object-fit: cover; object-position: top left; display: block; transition: transform 0.4s var(--pm-ease); }
  .pm-shot-btn:hover img { transform: scale(1.02); }
  .pm-shot figcaption { margin-top: 6px; font-size: 11.5px; color: var(--pp-muted); }
  .pm-prose { font-size: 13.5px; line-height: 1.7; color: var(--pp-fg); max-width: 76ch; }
  .pm-prose h1, .pm-prose h2, .pm-prose h3 { color: var(--pp-strong); line-height: 1.3; margin: 18px 0 6px; }
  .pm-prose h1 { font-size: 18px; } .pm-prose h2 { font-size: 16px; } .pm-prose h3 { font-size: 14px; }
  .pm-prose > :first-child { margin-top: 0; }
  .pm-prose p { margin: 0 0 10px; }
  .pm-prose ul, .pm-prose ol { margin: 0 0 10px; padding-left: 20px; }
  .pm-prose li { margin: 3px 0; }
  .pm-prose li::marker { color: var(--pp-accent-text); }
  .pm-prose strong { color: var(--pp-strong); }
  .pm-prose a { color: var(--pp-accent-text); }
  .pm-prose blockquote { margin: 12px 0; padding: 10px 14px; border-left: 3px solid var(--pp-accent); border-radius: 0 var(--pm-radius-sm) var(--pm-radius-sm) 0; background: var(--pm-accent-soft); color: var(--pp-fg); }
  .pm-prose blockquote p { margin: 0; }
  .pm-prose code { font-family: var(--mono, monospace); font-size: 12px; padding: 1px 5px; border-radius: 5px; background: var(--pp-raised); border: 1px solid var(--pp-line); }
  .pm-inline-setting { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 16px; padding: 12px 14px; border: 1px solid var(--pp-line); border-radius: var(--pm-radius-sm); background: var(--pp-raised); max-width: 720px; }
  .pm-set-title { font-size: 13px; font-weight: 600; color: var(--pp-strong); }
  .pm-sub { margin-top: 18px; }

  /* ── what it adds ── */
  .pm-group-h { margin: 16px 0 8px; font-size: 12px; font-weight: 600; color: var(--pp-muted); display: flex; align-items: center; gap: 8px; }
  .pm-group-h:first-child { margin-top: 0; }
  .pm-contrib-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 8px; }
  .pm-contrib { display: grid; grid-template-columns: 34px minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 11px 12px; border: 1px solid var(--pp-line); border-radius: var(--pm-radius-sm); background: var(--pp-card); transition: border-color 0.15s ease, opacity 0.15s ease; }
  .pm-contrib:hover { border-color: var(--pp-line-strong); }
  .pm-contrib.off { opacity: 0.72; }
  .pm-contrib-ic { width: 34px; height: 34px; border-radius: 9px; display: grid; place-items: center; font-size: 15px; color: var(--pp-accent-text); background: var(--pm-accent-soft); border: 1px solid var(--pm-accent-line); }
  .pm-contrib-title { font-size: 12.5px; font-weight: 600; color: var(--pp-strong); overflow-wrap: anywhere; }
  .pm-contrib-detail { font-size: 11.5px; color: var(--pp-muted); margin-top: 1px; overflow-wrap: anywhere; }
  .pm-contrib-meta { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; margin-top: 4px; font-size: 11px; color: var(--pp-muted); }

  /* ── permissions ── */
  .pm-perm-sum { display: flex; flex-wrap: wrap; gap: 8px 18px; align-items: center; margin-bottom: 10px; font-size: 13px; color: var(--pp-fg); }
  .pm-perm-sum b { color: var(--pp-strong); font-size: 16px; }
  .pm-perms { display: flex; flex-direction: column; border: 1px solid var(--pp-line); border-radius: var(--pm-radius); overflow: hidden; background: var(--pp-card); }
  .pm-perm { display: grid; grid-template-columns: 92px minmax(0, 1fr) auto; gap: 14px; align-items: center; padding: 14px 16px; border-top: 1px solid var(--pp-line); }
  .pm-perm:first-child { border-top: none; }
  .pm-perm.revoked { background: color-mix(in srgb, var(--pp-warn) 5%, transparent); }
  .pm-perm.default-off { background: color-mix(in srgb, var(--pp-muted) 5%, transparent); }
  .pm-perm-title { font-size: 13.5px; font-weight: 600; color: var(--pp-strong); overflow-wrap: anywhere; }
  .pm-perm-explain { font-size: 12px; line-height: 1.5; color: var(--pp-fg); margin-top: 2px; }
  .pm-perm-meta { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 6px; font-size: 11.5px; color: var(--pp-muted); align-items: center; }
  .pm-risk { justify-self: start; display: inline-flex; align-items: center; font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; padding: 3px 8px; border-radius: 6px; white-space: nowrap; border: 1px solid; }
  .pm-risk.r-high { color: var(--pm-risk-high); border-color: color-mix(in srgb, var(--pm-risk-high) 50%, transparent); background: color-mix(in srgb, var(--pm-risk-high) 10%, transparent); }
  .pm-risk.r-medium { color: var(--pm-risk-medium); border-color: color-mix(in srgb, var(--pm-risk-medium) 50%, transparent); background: color-mix(in srgb, var(--pm-risk-medium) 10%, transparent); }
  .pm-risk.r-low { color: var(--pm-risk-low); border-color: color-mix(in srgb, var(--pm-risk-low) 50%, transparent); background: color-mix(in srgb, var(--pm-risk-low) 10%, transparent); }

  /* ── settings form + save bar ── */
  .pm-form { max-width: 720px; display: flex; flex-direction: column; gap: 2px; }
  .pm-form .pp-field { margin-bottom: 14px; }
  .pm-form .pp-input, .pm-form .pp-select { max-width: 100%; height: 36px; border-radius: var(--pm-radius-sm); border-color: var(--pp-line-strong); font-size: 12.5px; }
  .pm-form textarea.pp-input { height: auto; }
  .pp-toggle-row { flex-direction: row !important; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 14px; border: 1px solid var(--pp-line); border-radius: var(--pm-radius-sm); background: var(--pp-card); }
  .pp-toggle-row.is-changed, .pp-field.is-changed .pp-input, .pp-field.is-changed .pp-select { border-color: var(--pm-accent-line); }
  .pp-toggle-text { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .pp-changed { color: var(--pp-accent-text); font-size: 9px; vertical-align: middle; margin-left: 4px; }
  .pp-secret { display: flex; gap: 8px; align-items: center; }
  .pp-secret .pp-input { flex: 1; }
  .pp-secret-state { flex: none; font-size: 10.5px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; padding: 4px 9px; border-radius: 999px; border: 1px solid var(--pp-line-strong); color: var(--pp-muted); }
  .pp-secret-state.set { color: var(--pp-ok); border-color: color-mix(in srgb, var(--pp-ok) 45%, transparent); }
  :host([data-mode="light"]) .pp-secret-state.set { color: #15803d; }
  .pp-secret-state.new { color: var(--pp-accent-text); border-color: var(--pm-accent-line); }
  .pp-fieldset { border: 1px solid var(--pp-line); border-radius: var(--pm-radius-sm); padding: 12px 14px; }
  .pm-savebar {
    position: sticky; bottom: 12px; z-index: 7; display: flex; align-items: center; justify-content: space-between; gap: 14px; margin: 18px 0 0; padding: 12px 14px 12px 18px;
    border-radius: var(--pm-radius); border: 1px solid var(--pm-accent-line); background: var(--pm-glass);
    backdrop-filter: blur(14px) saturate(150%); -webkit-backdrop-filter: blur(14px) saturate(150%);
    box-shadow: 0 18px 50px -18px rgba(0, 0, 0, 0.6), 0 0 0 1px var(--pm-accent-soft);
    animation: pm-rise 0.25s var(--pm-ease);
  }
  @keyframes pm-rise { from { transform: translateY(10px); opacity: 0; } }
  .pm-savebar-text { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; min-width: 0; font-size: 12.5px; }
  .pm-savebar-text b { color: var(--pp-strong); }
  .pm-savebar-keys { font-family: var(--mono, monospace); font-size: 11px; color: var(--pp-muted); max-width: 42ch; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pm-savebar-warn { display: inline-flex; align-items: center; gap: 5px; color: var(--pp-warn); font-weight: 600; }
  :host([data-mode="light"]) .pm-savebar-warn { color: #a16207; }
  .pm-savebar-warn svg { width: 14px; height: 14px; }
  .pm-savebar-actions { display: flex; gap: 8px; flex: none; }
  .pm-savebar .pp-btn { height: 34px; padding: 0 16px; border-radius: 999px; }

  /* ── lightbox ── */
  .pm-lb { position: fixed; inset: 0; z-index: 60; display: grid; grid-template-columns: 64px minmax(0, 1fr) 64px; align-items: center; background: rgba(4, 4, 6, 0.9); padding: 24px 8px; animation: pm-fade 0.18s ease; }
  @keyframes pm-fade { from { opacity: 0; } }
  .pm-lb-fig { grid-column: 2; margin: 0; display: flex; flex-direction: column; align-items: center; gap: 10px; min-width: 0; }
  .pm-lb-fig img { max-width: 100%; max-height: calc(100vh - 120px); border-radius: 10px; border: 1px solid rgba(255, 255, 255, 0.12); box-shadow: 0 30px 80px rgba(0, 0, 0, 0.6); }
  .pm-lb-fig figcaption { color: #e4e4e7; font-size: 13px; display: flex; gap: 14px; align-items: center; }
  .pm-lb-count { color: #a1a1aa; font-variant-numeric: tabular-nums; }
  .pm-lb-close, .pm-lb-nav { width: 44px; height: 44px; display: grid; place-items: center; border-radius: 999px; border: 1px solid rgba(255, 255, 255, 0.2); background: rgba(20, 20, 24, 0.8); color: #f4f4f5; cursor: pointer; }
  .pm-lb-close:hover, .pm-lb-nav:hover { border-color: #fbbf24; }
  .pm-lb-close { position: absolute; top: 16px; right: 16px; }
  .pm-lb-nav.prev { grid-column: 1; justify-self: center; }
  .pm-lb-nav.next { grid-column: 3; justify-self: center; }
  .pm-lb-close svg, .pm-lb-nav svg { width: 20px; height: 20px; }

  /* Older section bodies reuse the core form bits: widen them for the listing page. */
  .pm-dsec .pp-rows, .pm-dsec .pp-logs { border-radius: var(--pm-radius-sm); }
  .pm-dsec .pp-kv { font-size: 12.5px; }
  .pm-dsec .pp-btn { border-radius: 999px; padding: 7px 14px; }
  .pm-danger-zone { border: 1px solid color-mix(in srgb, var(--pp-danger) 40%, transparent); border-radius: var(--pm-radius); padding: 16px; background: color-mix(in srgb, var(--pp-danger) 4%, transparent); }

  @media (max-width: 1100px) {
    .pm-dgrid { grid-template-columns: minmax(0, 1fr); gap: 0; }
    .pm-dside { position: static; order: -1; margin-top: 16px; }
    .pm-facts { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); column-gap: 18px; }
    .pm-facts > div:first-child { padding-top: 8px; border-top: 1px solid var(--pp-line); }
  }
  @media (max-width: 760px) {
    :host { padding: 10px 10px 32px; }
    .pm-hero { grid-template-columns: 1fr; padding: 20px 16px 16px; gap: 14px; border-radius: 14px; }
    .pm-hero-stats div { flex: 1; min-width: 0; padding: 8px 10px; }
    .pm-hero-stats dd { font-size: 18px; }
    .pm-toolbar { margin: 0 -10px 14px; padding: 10px; }
    .pm-search { flex-basis: 100%; }
    .pm-seg { order: 2; width: 100%; overflow-x: auto; scrollbar-width: none; }
    .pm-seg button { flex: 1; justify-content: center; padding: 0 8px; }
    .pm-toolbar-end { margin-left: 0; order: 1; width: 100%; justify-content: space-between; }
    .pm-sort { flex: 1; }
    .pm-sort select { width: 100%; }
    .pm-chips-row { flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; margin-right: -10px; padding-right: 10px; }
    .pm-chipset { flex-wrap: nowrap; }
    /* Horizontal scrollers: fade the trailing edge so it reads as "more →". */
    .pm-chips-row, .pm-shelf, .pm-dnav {
      -webkit-mask-image: linear-gradient(90deg, #000 0, #000 calc(100% - 28px), transparent);
      mask-image: linear-gradient(90deg, #000 0, #000 calc(100% - 28px), transparent);
    }
    .pm-grid { grid-template-columns: 1fr; gap: 12px; }
    .pm-row { grid-template-columns: 32px minmax(0, 1fr) auto; }
    .pm-row .pm-status, .pm-hide-sm { display: none; }
    .pm-dhero { min-height: 0; border-radius: 14px; }
    .pm-dhero-shade { background: linear-gradient(180deg, rgba(6, 6, 8, 0.3) 0%, rgba(6, 6, 8, 0.82) 38%, rgba(6, 6, 8, 0.96) 100%); }
    .pm-dhero-body { flex-direction: column; align-items: stretch; gap: 12px; padding: 76px 16px 16px; }
    .pm-dhero-body .pm-icon.xl { width: 64px; height: 64px; border-radius: 16px; font-size: 20px; }
    .pm-dactions { flex-direction: row; align-items: center; justify-content: space-between; }
    .pm-dactions .pm-action.lg { flex: 1; }
    .pm-dnav { margin: 10px -10px 0; padding: 0 6px; }
    .pm-dsec { padding-top: 20px; }
    .pm-perm { grid-template-columns: minmax(0, 1fr) auto; gap: 8px 12px; padding: 12px; }
    .pm-perm .pm-risk { grid-column: 1 / -1; }
    .pm-contrib-grid { grid-template-columns: 1fr; }
    .pm-savebar { flex-direction: column; align-items: stretch; gap: 10px; bottom: 8px; padding: 12px; }
    .pm-savebar-keys { max-width: 100%; }
    .pm-savebar-actions .pp-btn { flex: 1; }
    .pm-lb { grid-template-columns: 1fr; grid-template-rows: 1fr auto; padding: 60px 8px 16px; }
    .pm-lb-fig { grid-column: 1; }
    .pm-lb-nav.prev, .pm-lb-nav.next { grid-row: 2; grid-column: 1; }
    .pm-lb-nav.prev { justify-self: start; margin-left: 20%; }
    .pm-lb-nav.next { justify-self: end; margin-right: 20%; }
    .pm-shot { flex-basis: 86%; }
    .pm-facts { grid-template-columns: 1fr; }
    .pm-facts > div { grid-template-columns: 96px minmax(0, 1fr); }
    .pp-app-grid { grid-template-columns: 1fr; }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation: none !important; transition: none !important; }
    .pm-card:hover { transform: none; }
    .pm-card:hover .pm-cover img, .pm-shot-btn:hover img { transform: none; }
  }
`;
