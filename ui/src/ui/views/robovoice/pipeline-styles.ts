/**
 * Robovoice's location Pipeline page look, as plain CSS for <rv-pipeline-editor>.
 *
 * A translation of the Tailwind classes in Robovoice-Prod (ad6163b)
 *   frontend/components/dashboard/tabs/pipeline-tab.tsx   (PipelineTab, StageCard, StageMeters, PipelinePrice, Connector)
 *   frontend/components/dashboard/tabs/characters-tab.tsx (CharacterPipeline)
 *   frontend/components/dashboard/ui-kit.tsx              (Card, Select, PortalSelect, Toggle, Button, Pill, Slider)
 *   frontend/components/dashboard/settings-scope.tsx      (FieldMarker)
 *   frontend/components/dashboard/model-picker.tsx        (ModelCombo trigger + menu)
 *   frontend/components/billing/tier-badge.tsx            (TierBadge, IncludedBadge)
 *   frontend/components/location/scope-access-note.tsx
 *   frontend/styles/globals.css                           (dark tokens, .glass, .glass-overlay, .subpanel, .sticky-bar, .lift)
 *
 * Robovoice's dark-theme tokens live on :host as --rv-* custom properties, so
 * nothing leaks into (or is picked up from) InfiniBot's own black/gold tokens.
 * Fonts: Plus Jakarta Sans (UI) + JetBrains Mono (numbers), as Robovoice loads.
 */
import { css } from "lit";

export const pipelineStyles = css`
  :host {
    /* globals.css :root */
    --rv-indigo: var(--glass-gold, var(--g-primary, #e8b84d));
    --rv-background: var(--glass-base, #080704);
    --rv-foreground: var(--glass-fg, #f4efe5);
    --rv-card: var(--glass-3, #14110b);
    --rv-primary: var(--glass-gold, var(--g-primary, #e8b84d));
    --rv-muted-foreground: var(--glass-fg-2, #b6aa94);
    --rv-border: var(--glass-stroke, rgba(255, 255, 255, 0.1));
    --rv-ring: var(--glass-focus-ring, color-mix(in srgb, var(--rv-primary) 62%, transparent));
    --rv-glass-fill: rgba(255, 255, 255, 0.055);
    --rv-glass-fill-overlay: rgba(255, 255, 255, 0.13);
    --rv-glass-edge: rgba(255, 255, 255, 0.1);
    --rv-glass-edge-overlay: rgba(255, 255, 255, 0.22);
    --rv-glass-sheen: inset 0 1px 0 0 rgba(255, 255, 255, 0.12);
    --rv-glass-sheen-strong: inset 0 1px 0 0 rgba(255, 255, 255, 0.2);
    --rv-elev-1: 0 1px 2px rgba(0, 0, 0, 0.4), 0 8px 20px -12px rgba(0, 0, 0, 0.8);
    --rv-elev-2: 0 2px 4px rgba(0, 0, 0, 0.4), 0 16px 36px -18px rgba(0, 0, 0, 0.85), 0 0 0 1px rgba(99, 102, 241, 0.04);
    --rv-elev-3: 0 4px 8px rgba(0, 0, 0, 0.45), 0 32px 64px -24px rgba(0, 0, 0, 0.9), 0 0 80px -30px rgba(99, 102, 241, 0.35);
    --rv-press: 150ms;
    --rv-ease: cubic-bezier(0.16, 1, 0.3, 1);
    --rv-gold-lit: #f0dca8;
    --rv-font-sans: "Plus Jakarta Sans", -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    --rv-font-mono: "JetBrains Mono", "SF Mono", ui-monospace, monospace;

    display: block;
    position: relative;
    isolation: isolate;
    padding: 20px;
    border-radius: var(--glass-radius-lg, 20px);
    border: 1px solid var(--glass-stroke, rgba(255, 255, 255, 0.06));
    color: var(--rv-foreground);
    color-scheme: dark;
    font-family: var(--rv-font-sans);
    font-size: 14px;
    line-height: 1.5;
    letter-spacing: -0.011em;
    font-feature-settings: "ss01", "cv11";
    -webkit-font-smoothing: antialiased;
    /* Business-hub-compatible black/gold aurora and tenant wash. */
    background:
      radial-gradient(120% 420px at 50% 0%, color-mix(in srgb, var(--rv-primary) 24%, transparent) 0%, transparent 70%),
      radial-gradient(60% 900px at 0% 0%, color-mix(in srgb, var(--rv-primary) 18%, transparent), transparent 68%),
      radial-gradient(55% 900px at 100% 100%, color-mix(in srgb, var(--glass-gold-hi, #ffe29a) 12%, transparent), transparent 68%),
      radial-gradient(50% 800px at 55% 55%, color-mix(in srgb, var(--rv-primary) 8%, transparent), transparent 70%),
      var(--rv-background);
  }
  *, *::before, *::after { box-sizing: border-box; }
  h2, h3, h4, p { margin: 0; }
  h2, h3 { letter-spacing: -0.025em; }
  button, select, input { font-family: inherit; letter-spacing: inherit; font-feature-settings: inherit; }
  :where(a, button, input, select, [tabindex]):focus-visible { outline: 2px solid var(--rv-ring); outline-offset: 2px; }
  ::selection { background: color-mix(in srgb, var(--rv-primary) 35%, transparent); }
  .tnum { font-family: var(--rv-font-mono); font-variant-numeric: tabular-nums; font-feature-settings: "tnum"; }
  .mono { font-family: var(--rv-font-mono); }
  .fg { color: var(--rv-foreground); }
  .fg80 { color: color-mix(in srgb, var(--rv-foreground) 80%, transparent); }
  .fg70 { color: color-mix(in srgb, var(--rv-foreground) 70%, transparent); }
  .muted { color: var(--rv-muted-foreground); }

  /* page: grid gap-3 (access note + tab) › tab: space-y-4 */
  .wrap { display: grid; gap: 12px; container-type: inline-size; }
  .tab { display: flex; flex-direction: column; gap: 16px; min-width: 0; }

  /* ScopeAccessNote */
  .access {
    border-radius: 12px; border: 1px solid rgba(217, 178, 90, 0.3); background: rgba(217, 178, 90, 0.07);
    padding: 10px 14px; font-size: 12px; line-height: 1.625; color: var(--rv-muted-foreground);
  }
  .access[data-access="edit"] { border-color: rgba(74, 222, 128, 0.28); background: rgba(74, 222, 128, 0.06); }

  /* .sticky-bar flex items-center justify-between gap-3 rounded-xl px-4 py-2.5 */
  .sticky-bar {
    position: sticky; top: 0; z-index: 40;
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    border-radius: 12px; padding: 10px 16px;
    background: rgba(14, 13, 28, 0.9);
    -webkit-backdrop-filter: blur(20px) saturate(165%); backdrop-filter: blur(20px) saturate(165%);
    border: 1px solid rgba(255, 255, 255, 0.09);
    box-shadow: var(--rv-elev-2), var(--rv-glass-sheen);
  }
  .bar-text { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 12px; line-height: 16px; color: var(--rv-muted-foreground); }
  .bar-text b { color: var(--rv-foreground); font-weight: 500; }
  .bar-actions { display: flex; align-items: center; gap: 8px; }
  .ok { font-size: 12px; line-height: 16px; color: #6ee7b7; }
  .err { font-size: 12px; line-height: 16px; color: #fca5a5; }

  /* Button */
  .btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    border-radius: 12px; border: 0; font-weight: 600; cursor: pointer; white-space: nowrap;
    padding: 6px 12px; font-size: 12px; line-height: 16px;
    transition: transform var(--rv-press) var(--rv-ease), filter var(--rv-press) var(--rv-ease), background-color var(--rv-press) var(--rv-ease),
      border-color var(--rv-press) var(--rv-ease), box-shadow var(--rv-press) var(--rv-ease);
  }
  .btn:active { transform: scale(0.97); }
  .btn:disabled { pointer-events: none; opacity: 0.4; }
  .btn.primary {
    color: #fff; border: 1px solid rgba(165, 180, 252, 0.25);
    background: linear-gradient(160deg, #6366f1 0%, #4f46e5 58%, #4338ca 100%);
    box-shadow: inset 0 1px 0 0 rgba(255, 255, 255, 0.24), 0 8px 22px -10px rgba(99, 102, 241, 0.85);
  }
  .btn.primary:hover { filter: brightness(1.09); }
  .btn.ghost { background: transparent; color: var(--rv-muted-foreground); }
  .btn.ghost:hover { background: rgba(255, 255, 255, 0.06); color: var(--rv-foreground); }
  .btn.outline {
    border: 1px solid rgba(255, 255, 255, 0.12); background: rgba(255, 255, 255, 0.045); color: var(--rv-foreground);
    box-shadow: inset 0 1px 0 0 rgba(255, 255, 255, 0.09);
  }
  .btn.outline:hover { border-color: rgba(99, 102, 241, 0.45); background: rgba(99, 102, 241, 0.12); }

  /* .glass + Card (GlassCard: relative overflow-hidden rounded-2xl p-5) */
  .glass {
    background: linear-gradient(160deg, var(--rv-glass-fill) 0%, color-mix(in srgb, var(--rv-glass-fill) 36%, transparent) 100%);
    -webkit-backdrop-filter: blur(18px) saturate(155%); backdrop-filter: blur(18px) saturate(155%);
    border: 1px solid var(--rv-glass-edge);
    box-shadow: var(--rv-elev-1), var(--rv-glass-sheen);
  }
  .card { position: relative; border-radius: 16px; padding: 20px; }
  .card.p4 { padding: 16px; }
  .card.scope { z-index: 30; }
  .card h3 { font-size: 14px; line-height: 20px; font-weight: 600; color: var(--rv-foreground); }
  .card h2, .presets h2 { font-size: 13px; line-height: 1.5; font-weight: 600; letter-spacing: -0.025em; color: var(--rv-foreground); }
  p.help { margin-top: 4px; font-size: 12px; line-height: 1.625; color: var(--rv-muted-foreground); }
  p.help.t2 { margin-top: 2px; }
  .row-between { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 16px; }
  .subpanel {
    background: rgba(0, 0, 0, 0.24); border: 1px solid rgba(255, 255, 255, 0.07);
    box-shadow: inset 0 1px 3px 0 rgba(0, 0, 0, 0.4), inset 0 1px 0 0 rgba(255, 255, 255, 0.045);
  }

  /* captions */
  .cap { display: block; margin-bottom: 6px; font-size: 11px; font-weight: 600; letter-spacing: 0.07em; text-transform: uppercase; color: var(--rv-muted-foreground); }
  .micro { display: block; font-size: 9px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: var(--rv-muted-foreground); }
  .helper { font-size: 11px; line-height: 1.625; color: color-mix(in srgb, var(--rv-muted-foreground) 70%, transparent); }

  /* "Configure pipeline for:" card: flex flex-wrap items-center gap-3 */
  .scope-row { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
  .scope-row .cap { margin: 0; }
  .scope-pick { position: relative; min-width: 220px; flex: 1 1 0; }
  @container (min-width: 720px) { .scope-pick { flex: none; max-width: 320px; } }

  /* Select / TextInput (inputBase) */
  .sel { position: relative; min-width: 0; }
  .sel > svg, .trigger > svg.chev { width: 16px; height: 16px; color: var(--rv-muted-foreground); pointer-events: none; }
  .sel > svg { position: absolute; top: 50%; right: 12px; transform: translateY(-50%); }
  select, input[type="text"], input[type="search"], .trigger {
    width: 100%; border-radius: 12px; border: 1px solid rgba(255, 255, 255, 0.1); background: rgba(0, 0, 0, 0.25);
    padding: 10px 12px; font-size: 14px; line-height: 1.42857; color: var(--rv-foreground);
    box-shadow: inset 0 1px 3px 0 rgba(0, 0, 0, 0.45); outline: none;
    transition: border-color 200ms, box-shadow 200ms, background-color 200ms;
  }
  select { cursor: pointer; appearance: none; -webkit-appearance: none; padding-right: 36px; text-overflow: ellipsis; }
  select option { background: #12112a; color: var(--rv-foreground); }
  input::placeholder { color: color-mix(in srgb, var(--rv-muted-foreground) 50%, transparent); }
  select:hover, input[type="text"]:hover, input[type="search"]:hover, .trigger:hover { border-color: rgba(255, 255, 255, 0.16); }
  select:focus, input[type="text"]:focus, input[type="search"]:focus {
    border-color: rgba(99, 102, 241, 0.6); background: rgba(0, 0, 0, 0.35);
    box-shadow: inset 0 1px 3px 0 rgba(0, 0, 0, 0.45), 0 0 0 3px rgba(99, 102, 241, 0.18);
  }
  select:disabled { cursor: not-allowed; opacity: 0.6; }
  .locked { opacity: 0.75; }

  /* ModelCombo / PortalSelect trigger */
  .trigger { display: flex; align-items: center; gap: 8px; text-align: left; cursor: pointer; }
  .trigger:focus { border-color: rgba(99, 102, 241, 0.6); }
  .trigger:disabled { cursor: not-allowed; opacity: 0.4; }
  .trigger .lbl { min-width: 0; flex: 1 1 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .trigger .lbl.id { font-family: var(--rv-font-mono); font-size: 12px; }
  .trigger .lbl.empty { color: color-mix(in srgb, var(--rv-muted-foreground) 60%, transparent); }
  .trigger .named { min-width: 0; flex: 1 1 0; }
  .trigger .named b { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 600; color: var(--rv-foreground); }
  .trigger .named i { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-style: normal; font-family: var(--rv-font-mono); font-size: 10px; color: var(--rv-muted-foreground); }
  .badge-unavail {
    flex-shrink: 0; border-radius: 6px; border: 1px solid rgba(232, 184, 75, 0.45); background: rgba(232, 184, 75, 0.12);
    padding: 2px 6px; font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: #f0dca8;
  }
  .alert { margin-top: 4px; padding: 0 2px; font-size: 11px; line-height: 1.625; color: #f0dca8; }

  /* open menu: .glass-overlay, in the top layer (popover) anchored under its trigger */
  .menu {
    position: fixed; inset: auto; margin: 0; top: calc(anchor(bottom) + 6px); left: anchor(left);
    width: max(anchor-size(width), 260px); max-width: calc(100vw - 16px); max-height: 340px;
    position-try-fallbacks: flip-block;
    flex-direction: column; border-radius: 12px; padding: 8px; color: var(--rv-foreground);
    font-family: var(--rv-font-sans); letter-spacing: -0.011em;
    background: linear-gradient(160deg, var(--rv-glass-fill-overlay) 0%, color-mix(in srgb, var(--rv-card) 72%, transparent) 100%);
    -webkit-backdrop-filter: blur(32px) saturate(180%); backdrop-filter: blur(32px) saturate(180%);
    border: 1px solid var(--rv-glass-edge-overlay);
    box-shadow: 0 24px 60px -20px rgba(0, 0, 0, 0.9);
  }
  .menu:popover-open { display: flex; }
  .menu.scope-menu { padding: 6px; gap: 2px; overflow-y: auto; }
  .menu input[type="search"] { margin-bottom: 8px; padding-top: 6px; padding-bottom: 6px; font-size: 12px; line-height: 1.33333; }
  .menu .rows { min-height: 0; flex: 1 1 auto; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
  .menu .rows::-webkit-scrollbar, .menu.scope-menu::-webkit-scrollbar { width: 6px; }
  .menu .rows::-webkit-scrollbar-thumb, .menu.scope-menu::-webkit-scrollbar-thumb { background: rgba(129, 140, 248, 0.28); border-radius: 99px; }
  .menu button { border: 0; background: transparent; color: inherit; cursor: pointer; text-align: left; width: 100%; border-radius: 8px; transition: background-color 150ms; }
  .menu button:hover { background: rgba(255, 255, 255, 0.06); }
  .menu button.on { background: rgba(99, 102, 241, 0.15); }
  .menu .inherit { padding: 6px 10px; font-size: 12px; line-height: 16px; font-weight: 500; color: var(--rv-muted-foreground); }
  .menu .inherit.on { color: #c7d2fe; }
  .menu .opt { padding: 6px 10px; display: block; }
  .menu .opt .n { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; line-height: 16px; font-weight: 500; color: var(--rv-foreground); }
  .menu .opt .i { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--rv-font-mono); font-size: 10px; color: var(--rv-muted-foreground); }
  .menu .opt .p { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; font-weight: 500; color: rgba(240, 220, 168, 0.8); }
  .menu .none { padding: 6px 10px; font-size: 12px; line-height: 16px; color: var(--rv-muted-foreground); }
  .menu .sopt { display: flex; align-items: center; gap: 8px; padding: 6px 10px; }
  .menu .sopt:hover { background: rgba(255, 255, 255, 0.07); }
  .menu .sopt > span { min-width: 0; flex: 1 1 0; }
  .menu .sopt .n { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; color: var(--rv-foreground); }
  .menu .sopt .h { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10.5px; color: var(--rv-muted-foreground); }
  .menu .sopt svg { width: 14px; height: 14px; flex-shrink: 0; color: var(--rv-primary); }

  /* stage cards: flex flex-col items-stretch gap-3 lg:flex-row */
  .stages { display: flex; flex-direction: column; align-items: stretch; gap: 12px; }
  .connector { display: none; flex-shrink: 0; align-items: center; align-self: stretch; padding: 64px 0; }
  @container (min-width: 720px) { .stages { flex-direction: row; } .connector { display: flex; } }
  .stage {
    position: relative; min-width: 0; flex: 1 1 0; border-radius: 16px; padding: 16px;
    transition: transform var(--rv-press) var(--rv-ease), box-shadow 260ms var(--rv-ease), border-color 260ms var(--rv-ease);
  }
  .stage:hover { transform: translate3d(0, -2px, 0); border-color: rgba(129, 140, 248, 0.34); }
  .stage:has(.menu:popover-open) { transform: none; }
  .stage-head { margin-bottom: 12px; display: flex; align-items: center; justify-content: space-between; }
  .num { display: flex; width: 24px; height: 24px; align-items: center; justify-content: center; border-radius: 999px; font-size: 11px; font-weight: 700; }
  .stage h3 { font-size: 14px; line-height: 20px; font-weight: 600; color: var(--rv-foreground); }
  .model { margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--rv-font-mono); font-size: 11px; color: var(--rv-muted-foreground); }
  .extra { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: color-mix(in srgb, var(--rv-muted-foreground) 70%, transparent); }
  .body { margin-top: 12px; border-top: 1px solid rgba(255, 255, 255, 0.06); padding-top: 12px; }
  .stack2 { display: flex; flex-direction: column; gap: 8px; }
  .cap-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }

  /* Pill */
  .pill {
    display: inline-flex; align-items: center; gap: 4px; border-radius: 999px; border: 1px solid rgba(255, 255, 255, 0.1);
    padding: 2px 8px; font-size: 10px; font-weight: 600; letter-spacing: 0.025em; white-space: nowrap;
    background: rgba(255, 255, 255, 0.06); color: var(--rv-foreground);
    box-shadow: inset 0 1px 0 0 rgba(255, 255, 255, 0.07);
  }
  .pill.muted { border-color: rgba(255, 255, 255, 0.08); background: transparent; color: var(--rv-muted-foreground); }
  .pill.primary { border-color: rgba(99, 102, 241, 0.4); background: rgba(99, 102, 241, 0.15); color: #c7d2fe; }
  .pill.gold { border-color: rgba(217, 178, 90, 0.4); background: rgba(217, 178, 90, 0.12); color: #f0dca8; }

  /* TierBadge / IncludedBadge */
  .tier-badge {
    display: inline-flex; align-items: center; gap: 4px; border-radius: 999px; border: 1px solid; padding: 2px 8px;
    font-size: 10.5px; font-weight: 600; white-space: nowrap; font-variant-numeric: tabular-nums;
  }
  .tier-badge::before { content: ""; width: 6px; height: 6px; border-radius: 999px; background: currentColor; }
  .tier-badge span { opacity: 0.8; }
  .tier-badge.standard { border-color: rgba(45, 212, 191, 0.35); background: rgba(45, 212, 191, 0.1); color: #5eead4; }
  .tier-badge.premium { border-color: rgba(129, 140, 248, 0.4); background: rgba(129, 140, 248, 0.12); color: #c7d2fe; }
  .tier-badge.expressive { border-color: rgba(227, 185, 92, 0.45); background: rgba(227, 185, 92, 0.12); color: #f3d48a; }
  .included {
    display: inline-flex; align-items: center; gap: 4px; border-radius: 999px; border: 1px solid rgba(255, 255, 255, 0.1);
    background: rgba(255, 255, 255, 0.04); padding: 2px 8px; font-size: 10.5px; font-weight: 600; white-space: nowrap; color: rgba(255, 255, 255, 0.6);
  }

  /* StageMeters: grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-1.5 */
  .meters { margin-top: 12px; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr); gap: 6px; }
  .meter { border-radius: 12px; padding: 8px 10px; min-width: 0; }
  .meter.price {
    border: 1px solid rgba(217, 178, 90, 0.38);
    background: linear-gradient(150deg, rgba(217, 178, 90, 0.2) 0%, rgba(217, 178, 90, 0.06) 55%, rgba(0, 0, 0, 0.24) 100%);
    box-shadow: inset 0 1px 0 0 rgba(255, 255, 255, 0.12), 0 10px 26px -18px rgba(217, 178, 90, 0.9);
  }
  .meter .r1 { display: flex; height: 14px; align-items: center; justify-content: space-between; gap: 4px; }
  .meter .r2 { display: flex; height: 24px; align-items: flex-end; line-height: 1; }
  .meter .r3 { display: flex; height: 14px; align-items: center; font-size: 9px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .meter.speed .r2 span { font-size: 18px; line-height: 1; font-weight: 600; }
  .meter.speed .r3 { letter-spacing: 0.05em; text-transform: uppercase; color: color-mix(in srgb, var(--rv-muted-foreground) 60%, transparent); }
  .meter.price .micro { color: rgba(240, 220, 168, 0.72); }
  .meter.price .tier { font-size: 9px; font-weight: 600; letter-spacing: 0.025em; text-transform: uppercase; color: #f3d48a; }
  .meter.price .big { display: inline-flex; align-items: baseline; line-height: 1; font-weight: 600; color: var(--rv-gold-lit); text-shadow: 0 0 20px rgba(217, 178, 90, 0.45); }
  .meter.price .big .v { font-size: 22px; line-height: 1; letter-spacing: -0.025em; }
  .meter.price .big .unit { margin-left: 4px; font-size: 10px; line-height: 1; opacity: 0.7; }
  .meter.price .r3 { font-weight: 500; color: rgba(240, 220, 168, 0.66); }

  /* FieldMarker */
  .marker { margin: 4px 0 0; display: flex; min-height: 16px; align-items: center; gap: 6px; font-size: 10px; line-height: 1; color: color-mix(in srgb, var(--rv-muted-foreground) 60%, transparent); flex-wrap: wrap; }
  .marker.end { justify-content: flex-end; }
  .over {
    border-radius: 999px; border: 1px solid rgba(217, 178, 90, 0.5); padding: 2px 6px; font-weight: 600; letter-spacing: 0.025em;
    text-transform: uppercase; color: #f0dca8; background: rgba(217, 178, 90, 0.12);
  }
  .orglevel { color: color-mix(in srgb, var(--rv-muted-foreground) 70%, transparent); }
  .pending { color: #f0b543; }
  .linkish { border: 0; background: none; padding: 0; font-size: inherit; line-height: inherit; color: var(--rv-muted-foreground); text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
  .linkish:hover { color: var(--rv-foreground); }
  a.ext { color: #c7d2fe; text-decoration: underline; text-underline-offset: 2px; }
  a.ext:hover { color: #fff; }

  /* ProviderNotice */
  .notice { margin-top: 8px; border-radius: 8px; border: 1px solid rgba(248, 113, 113, 0.35); background: rgba(248, 113, 113, 0.08); padding: 8px 12px; font-size: 11px; line-height: 1.625; color: #fca5a5; }
  .ib { margin-top: 4px; display: flex; align-items: center; gap: 6px; font-size: 10px; color: #7ee2a8; }

  /* Pause billing when idle */
  .idle-text { min-width: 0; flex: 1 1 288px; }
  .idle-pick { width: 100%; max-width: 16rem; }

  /* Language routing: space-y-3 rows */
  .toggles { margin-top: 16px; display: flex; flex-direction: column; gap: 12px; }
  .toggle-row { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; column-gap: 16px; row-gap: 8px; }
  .toggle-row .txt { min-width: 0; flex: 1 1 240px; }
  .toggle-row .t { font-size: 13px; font-weight: 500; color: var(--rv-foreground); }
  .toggle-row p { margin-top: 2px; font-size: 11.5px; line-height: 1.625; color: var(--rv-muted-foreground); }
  .toggle-row .ctl { flex-shrink: 0; }

  /* Toggle */
  .switch { position: relative; display: flex; flex-shrink: 0; align-items: center; gap: 10px; border-radius: 999px; cursor: pointer; font-size: 14px; line-height: 20px; color: var(--rv-foreground); white-space: nowrap; }
  .switch input { position: absolute; opacity: 0; width: 1px; height: 1px; margin: 0; }
  .switch .track { position: relative; flex-shrink: 0; width: 40px; height: 24px; border-radius: 999px; background: rgba(255, 255, 255, 0.07); box-shadow: inset 0 1px 3px 0 rgba(0, 0, 0, 0.55); transition: background 200ms, box-shadow 200ms; }
  .switch .track::after { content: ""; position: absolute; top: 2px; left: 2px; width: 20px; height: 20px; border-radius: 999px; background: #fff; box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.5); transition: transform var(--rv-press); }
  .switch input:checked + .track { background: linear-gradient(160deg, #818cf8, #4f46e5); box-shadow: inset 0 1px 0 0 rgba(255, 255, 255, 0.28), 0 0 14px -2px rgba(99, 102, 241, 0.8); }
  .switch input:checked + .track::after { transform: translateX(16px); }
  .switch input:focus-visible + .track { outline: 2px solid var(--rv-ring); outline-offset: 2px; }
  .switch input:disabled + .track { opacity: 0.75; cursor: not-allowed; }

  /* Default language map */
  .map-row { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 12px; }
  .map-row .txt { min-width: 0; flex: 1 1 0; }
  .map-row .head { display: flex; align-items: center; gap: 8px; }
  .map-row .org { text-align: right; }
  .map-row .org .marker { justify-content: flex-end; }

  /* PipelinePrice */
  .bill-text { min-width: 240px; flex: 1 1 0; }
  .micro.gold { color: rgba(240, 220, 168, 0.72); }
  .bill-row { margin-top: 4px; display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; }
  .bill { font-size: 30px; line-height: 1; font-weight: 700; color: var(--rv-gold-lit); text-shadow: 0 0 24px rgba(217, 178, 90, 0.4); }
  .bill-unit { font-size: 14px; line-height: 20px; font-weight: 500; color: var(--rv-foreground); }
  .bill-help { margin-top: 6px; max-width: 36rem; font-size: 12px; line-height: 1.625; color: var(--rv-muted-foreground); }
  .tiers { display: flex; flex-wrap: wrap; gap: 8px; }
  .tier-chip { border-radius: 12px; border: 1px solid rgba(255, 255, 255, 0.1); background: rgba(255, 255, 255, 0.03); padding: 8px 12px; }
  .tier-chip.on { border-color: rgba(227, 185, 92, 0.45); background: rgba(227, 185, 92, 0.1); }
  .tier-chip .sub { margin-top: 4px; font-size: 10px; color: var(--rv-muted-foreground); }

  /* KPI grid: grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6 */
  .kpis { display: grid; gap: 12px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  @container (min-width: 560px) { .kpis { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
  @container (min-width: 720px) { .kpis { grid-template-columns: repeat(6, minmax(0, 1fr)); } }
  .kpi { border-radius: 12px; padding: 12px; min-width: 0; }
  .kpi .l { font-size: 10px; letter-spacing: 0.05em; text-transform: uppercase; color: var(--rv-muted-foreground); }
  .kpi .v { margin-top: 4px; font-family: var(--rv-font-mono); font-size: 20px; line-height: 28px; font-weight: 600; }

  /* Presets */
  .presets { padding-top: 4px; }
  .presets .head { margin-bottom: 8px; padding: 0 4px; }

  /* CharacterPipeline */
  .agent-box { border-radius: 12px; border: 1px solid rgba(255, 255, 255, 0.1); background: rgba(0, 0, 0, 0.2); padding: 16px; }
  .agent-box .title { margin-bottom: 16px; }
  .agent-box .title h3 { font-size: 13px; line-height: 1.5; font-weight: 600; letter-spacing: -0.025em; color: var(--rv-foreground); }
  .agent-rows { display: flex; flex-direction: column; gap: 12px; }
  .agent-row { display: grid; grid-template-columns: 1fr; gap: 8px; }
  .agent-row .fields { display: grid; gap: 8px; grid-template-columns: minmax(0, 1fr); }
  @container (min-width: 560px) {
    .agent-row { grid-template-columns: 86px minmax(0, 1fr); align-items: start; }
    .agent-row .fields { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  .agent-row .fields > div { min-width: 0; }
  .chip { display: flex; align-items: center; gap: 6px; padding-top: 8px; }
  .chip .s { border-radius: 8px; padding: 4px 8px; font-size: 10px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; }
  .effective { margin-top: 12px; font-size: 11px; line-height: 1.625; color: var(--rv-muted-foreground); }
  .effective code { font-family: var(--rv-font-mono); font-size: 11px; color: var(--rv-foreground); }
  .check { margin-top: 8px; display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--rv-foreground); }
  .check input { margin: 0; width: 13px; height: 13px; accent-color: var(--rv-primary); }
  .check .m { color: var(--rv-muted-foreground); }
  .small { margin: 4px 0 0 24px; font-size: 10px; line-height: 1.625; color: var(--rv-muted-foreground); }
  .amber { color: rgba(251, 191, 36, 0.8); }
  .lang-box { margin-top: 16px; border-radius: 12px; border: 1px solid rgba(255, 255, 255, 0.1); background: rgba(0, 0, 0, 0.2); padding: 12px; }
  .lang-box .head { margin-bottom: 6px; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 12px; line-height: 16px; font-weight: 600; color: var(--rv-foreground); }
  .lang-box p { margin-bottom: 12px; font-size: 11px; line-height: 1.625; color: var(--rv-muted-foreground); }

  /* Advanced — location overrides (InfiniBot extra; Robovoice kit: SectionTitle, Slider, Toggle) */
  details.adv > summary { cursor: pointer; list-style: none; display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
  details.adv > summary::-webkit-details-marker { display: none; }
  details.adv[open] > summary { margin-bottom: 16px; }
  .adv-grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr)); }
  .adv-sec { border-radius: 12px; padding: 12px; }
  .adv-sec h4 { font-size: 13px; font-weight: 600; letter-spacing: -0.025em; color: var(--rv-foreground); }
  .adv-sec .sub { margin-top: 2px; margin-bottom: 8px; font-size: 12px; line-height: 1.625; color: var(--rv-muted-foreground); }
  .adv-field { padding: 10px 0; border-top: 1px solid rgba(255, 255, 255, 0.06); }
  .adv-field .lab { margin-bottom: 6px; display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  .adv-field .lab .cap { margin: 0; }
  .adv-field .lab .h { font-family: var(--rv-font-mono); font-size: 12px; font-variant-numeric: tabular-nums; color: var(--rv-foreground); }
  input[type="range"] {
    width: 100%; height: 8px; margin: 6px 0; cursor: pointer; appearance: none; -webkit-appearance: none; border-radius: 999px; outline: none;
    background: linear-gradient(to right, #6366f1 0%, #818cf8 var(--pct, 0%), rgba(255, 255, 255, 0.08) var(--pct, 0%));
    box-shadow: inset 0 1px 2px 0 rgba(0, 0, 0, 0.6);
  }
  input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none; appearance: none; width: 16px; height: 16px; border-radius: 999px;
    background: linear-gradient(160deg, #a5b4fc, #6366f1);
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.25), 0 2px 8px 0 rgba(99, 102, 241, 0.65);
  }
  input[type="range"]::-moz-range-thumb { width: 16px; height: 16px; border: 0; border-radius: 999px; background: var(--rv-primary); }
  input[type="range"]:disabled { opacity: 0.6; cursor: not-allowed; }

  /* PanelSkeleton / PanelError */
  .skel-wrap { display: grid; gap: 12px; }
  .skel-row { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 1fr)); }
  .skel { border-radius: 16px; border: 1px solid rgba(255, 255, 255, 0.06); background: linear-gradient(90deg, rgba(255, 255, 255, 0.03) 0%, rgba(255, 255, 255, 0.08) 50%, rgba(255, 255, 255, 0.03) 100%); background-size: 200% 100%; animation: skel 1.4s ease-in-out infinite; }
  @keyframes skel { 0% { background-position: 100% 0; } 100% { background-position: -100% 0; } }

  /* G8 material and controls override the legacy violet kit without changing DOM. */
  :is(.glass, .card, .stage, .sticky-bar, .agent-box, .lang-box, .adv-sec, .kpi) {
    border-color: var(--glass-stroke, var(--rv-border));
    background: var(--glass-sheen, linear-gradient(180deg, rgba(255,255,255,.08), transparent 36%)), var(--glass-2, var(--rv-glass-fill));
    box-shadow: var(--glass-specular, inset 0 1px 0 rgba(255,255,255,.08)), var(--glass-elev-2, var(--rv-elev-2));
  }
  .btn:not(.ghost):not(.outline) {
    color: var(--glass-ink, #171006);
    border-color: var(--glass-gold-hi, var(--rv-primary));
    background: var(--glass-gold-fill, linear-gradient(135deg, var(--glass-gold-hi, #ffe29a), var(--rv-primary), var(--glass-gold-deep, #9d6809)));
    box-shadow: inset 0 1px 0 rgba(255,255,255,.4), 0 10px 28px color-mix(in srgb, var(--rv-primary) 20%, transparent);
  }
  :is(select, input[type="text"], input[type="search"], .trigger):focus {
    border-color: var(--rv-primary);
    box-shadow: var(--glass-focus-ring, 0 0 0 3px color-mix(in srgb, var(--rv-primary) 24%, transparent));
  }
  input[type="range"] { background: linear-gradient(to right, var(--rv-primary) 0%, var(--glass-gold-hi, #ffe29a) var(--pct, 0%), rgba(255,255,255,.08) var(--pct, 0%)); }
  input[type="range"]::-webkit-slider-thumb { background: linear-gradient(160deg, var(--glass-gold-hi, #ffe29a), var(--rv-primary)); }
  :host-context([data-theme="light"]) { color-scheme: light; }
  @media (prefers-reduced-transparency: reduce) {
    :host, :is(.glass, .card, .stage, .sticky-bar, .agent-box, .lang-box, .adv-sec, .kpi) { backdrop-filter: none; background: var(--glass-solid, var(--rv-background)); }
  }

  @media (prefers-reduced-motion: reduce) {
    .skel { animation: none; }
    .stage, .btn, .switch .track, .switch .track::after { transition: none; }
    .stage:hover { transform: none; }
  }
  @media (max-width: 640px) {
    :host { padding: 12px; }
    .sticky-bar { position: static; flex-wrap: wrap; }
    .bar-text { flex-wrap: wrap; }
    button, select, input[type="text"], input[type="search"] { min-height: 44px; }
  }
`;
