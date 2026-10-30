/**
 * Shared visual language for the Agency Topology and Daily Operations surfaces.
 *
 * Deliberately the InfiCode aesthetic — near-black plate, gold accent routed
 * through `var(--g-primary)`, monospace, box-drawn dense panels — so the agency
 * screens read as part of the same product instead of the separate palette the
 * older agency pages drifted into. Every colour is derived from a `--g-*` token
 * or `color-mix()` on one, so the pages recolour with the rest of the app.
 */

import { html } from "lit";

export const AGENCY_SURFACE_STYLES = html`
  <style>
    .agx {
      --agx-mono: "JetBrains Mono", "Fira Code", "SF Mono", ui-monospace, monospace;
      --agx-line: color-mix(in srgb, var(--g-primary) 24%, transparent);
      --agx-line-soft: color-mix(in srgb, var(--g-primary) 12%, transparent);
      --agx-dim: var(--g-muted, #8b8b96);
      --agx-plate: color-mix(in srgb, var(--g-primary) 4%, var(--g-bg, #050505));

      /* Glass surface language, inherited from the app theme rather than
         re-invented here. These pages previously drew every panel as a
         hairline rectangle with square corners, which read as a flat terminal
         next to the rest of the product. Panels are now translucent plates
         that blur what sits behind them, with the theme's own radius and
         elevation. */
      --agx-radius: var(--g-radius-lg, 18px);
      --agx-radius-sm: var(--g-radius-sm, 8px);
      --agx-glass: linear-gradient(
        160deg,
        color-mix(in srgb, var(--g-primary) 5%, rgba(255, 255, 255, 0.05)) 0%,
        color-mix(in srgb, var(--g-primary) 2%, rgba(255, 255, 255, 0.02)) 55%,
        rgba(255, 255, 255, 0.015) 100%
      );
      --agx-glass-raised: linear-gradient(
        160deg,
        color-mix(in srgb, var(--g-primary) 9%, rgba(255, 255, 255, 0.07)) 0%,
        color-mix(in srgb, var(--g-primary) 3%, rgba(255, 255, 255, 0.03)) 100%
      );
      --agx-blur: var(--g-blur, blur(14px) saturate(160%));
      /* Layered elevation rather than one flat drop shadow: a tight contact
         shadow plants the plate, a wide soft shadow gives it altitude, and the
         inset pair reads as light from above / a recessed bottom edge. This is
         what separates "rounded rectangle" from "sheet of glass". */
      --agx-elevation: 0 1px 3px rgba(0, 0, 0, 0.28), var(--g-shadow, 0 12px 40px rgba(0, 0, 0, 0.35)),
        0 28px 72px rgba(0, 0, 0, 0.32);
      --agx-hairline: inset 0 1px 0 var(--g-edge-light, rgba(255, 255, 255, 0.1)),
        inset 0 -1px 0 var(--g-edge-shadow, rgba(0, 0, 0, 0.4));
      display: flex;
      flex-direction: column;
      gap: 10px;
      min-height: 0;
      height: 100%;
      padding: 12px 16px 14px;
      box-sizing: border-box;
      /* Deliberately not an opaque plate. The panels below use backdrop-filter,
         and blurring a flat fill produces exactly the flat fill back — the
         single biggest reason these pages read as a terminal rather than as
         glass. Two faint blooms give the frost something to refract. */
      background:
        radial-gradient(
          ellipse 95% 55% at 12% -8%,
          color-mix(in srgb, var(--g-primary) 9%, transparent),
          transparent 62%
        ),
        radial-gradient(
          ellipse 70% 50% at 98% 104%,
          color-mix(in srgb, var(--g-accent, var(--g-primary)) 7%, transparent),
          transparent 60%
        );
      color: var(--g-fg, #d5d5dc);
      font-family: var(--agx-mono);
      font-size: 12px;
      line-height: 1.45;
      overflow: auto;
      scrollbar-width: thin;
    }
    .agx::-webkit-scrollbar {
      width: 10px;
    }
    .agx::-webkit-scrollbar-thumb {
      border-radius: 999px;
      border: 3px solid transparent;
      background-clip: content-box;
      background-color: color-mix(in srgb, var(--g-primary) 30%, transparent);
    }
    .agx *,
    .agx *::before,
    .agx *::after {
      box-sizing: border-box;
    }

    /* ── Header ───────────────────────────────────────────── */
    .agx-head {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-end;
      gap: 10px;
      padding-bottom: 6px;
      border-bottom: 1px solid var(--agx-line);
    }
    /* Type scale. The surface was previously near-uniform 10–12px uppercase
       monospace, which gave every string the same weight and flattened the
       page. There are now four distinct steps: display (page title), heading
       (panel title), body (row title) and caption (meta / labels). */
    .agx-head h1 {
      margin: 0;
      font-size: 21px;
      font-weight: 700;
      letter-spacing: 0.13em;
      text-transform: uppercase;
      line-height: 1.15;
      background: linear-gradient(
        100deg,
        var(--g-primary) 0%,
        color-mix(in srgb, var(--g-primary) 55%, #ffffff) 46%,
        var(--g-primary) 100%
      );
      -webkit-background-clip: text;
      background-clip: text;
      -webkit-text-fill-color: transparent;
      color: var(--g-primary);
    }
    .agx-sub {
      margin-top: 4px;
      color: var(--agx-dim);
      font-size: 11.5px;
      line-height: 1.45;
      max-width: 120ch;
    }
    .agx-head-tools {
      margin-left: auto;
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
    }
    .agx-stamp {
      color: var(--agx-dim);
      font-size: 10px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    /* ── Controls ─────────────────────────────────────────── */
    .agx-btn {
      font: inherit;
      font-size: 11px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      padding: 6px 13px;
      color: var(--g-primary);
      background: var(--agx-glass-raised);
      border: 1px solid var(--agx-line);
      border-radius: 999px;
      backdrop-filter: var(--agx-blur);
      -webkit-backdrop-filter: var(--agx-blur);
      box-shadow: var(--agx-hairline);
      cursor: pointer;
      transition: background 0.15s ease, border-color 0.15s ease, transform 0.12s ease,
        box-shadow 0.15s ease;
    }
    .agx-btn:hover:not(:disabled) {
      border-color: var(--g-primary);
      background: color-mix(in srgb, var(--g-primary) 18%, transparent);
      box-shadow: 0 6px 18px -8px color-mix(in srgb, var(--g-primary) 55%, transparent),
        var(--agx-hairline);
    }
    .agx-btn:active:not(:disabled) {
      transform: translateY(1px);
    }
    .agx-btn:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    .agx-btn.is-on {
      background: color-mix(in srgb, var(--g-primary) 22%, transparent);
      border-color: var(--g-primary);
      color: var(--g-fg, #f4f4f5);
    }
    .agx-btn.ghost {
      color: var(--agx-dim);
      background: transparent;
    }
    /* The one call-to-action per empty state / composer. Filled, not outlined,
       so "the next thing to do" is unambiguous. */
    .agx-btn.primary {
      color: color-mix(in srgb, var(--g-bg, #050505) 88%, #000);
      background: linear-gradient(
        135deg,
        color-mix(in srgb, var(--g-primary) 92%, #fff) 0%,
        var(--g-primary) 100%
      );
      border-color: transparent;
      font-weight: 700;
      box-shadow: 0 8px 22px -10px color-mix(in srgb, var(--g-primary) 80%, transparent),
        inset 0 1px 0 rgba(255, 255, 255, 0.35);
    }
    .agx-btn.primary:hover:not(:disabled) {
      background: color-mix(in srgb, var(--g-primary) 88%, #fff);
      box-shadow: 0 12px 30px -10px color-mix(in srgb, var(--g-primary) 85%, transparent),
        inset 0 1px 0 rgba(255, 255, 255, 0.45);
    }
    .agx-btn.ok {
      color: var(--g-success);
      border-color: var(--g-success-border, color-mix(in srgb, var(--g-success) 40%, transparent));
      background: var(--g-success-soft, transparent);
    }
    .agx-btn.ok:hover:not(:disabled) {
      border-color: var(--g-success);
      background: color-mix(in srgb, var(--g-success) 22%, transparent);
      box-shadow: 0 6px 18px -8px color-mix(in srgb, var(--g-success) 55%, transparent);
    }
    .agx-btn.danger {
      color: var(--g-danger);
      border-color: var(--g-danger-border, color-mix(in srgb, var(--g-danger) 40%, transparent));
      background: var(--g-danger-soft, transparent);
    }
    .agx-btn.danger:hover:not(:disabled) {
      border-color: var(--g-danger);
      background: color-mix(in srgb, var(--g-danger) 22%, transparent);
      box-shadow: 0 6px 18px -8px color-mix(in srgb, var(--g-danger) 55%, transparent);
    }
    .agx :is(button, select, a, [tabindex]):focus-visible {
      outline: 2px solid var(--g-primary);
      outline-offset: 2px;
    }
    .agx-select {
      font: inherit;
      font-size: 11px;
      padding: 6px 10px;
      color: var(--g-fg, #e5e5ea);
      background: var(--agx-glass-raised);
      border: 1px solid var(--agx-line);
      border-radius: var(--agx-radius-sm);
    }
    .agx-field {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .agx-field label {
      color: var(--agx-dim);
      font-size: 10px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    .agx-toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      padding: 7px 13px;
      border: 1px solid var(--agx-line-soft);
      border-radius: var(--agx-radius);
      background: var(--agx-glass);
      backdrop-filter: var(--agx-blur);
      -webkit-backdrop-filter: var(--agx-blur);
      box-shadow: var(--agx-hairline);
    }
    .agx-scope-note {
      color: var(--agx-dim);
      font-size: 11px;
    }
    .agx-scope-note strong {
      color: var(--g-primary);
      font-weight: 600;
    }

    /* ── Panels ───────────────────────────────────────────── */
    .agx-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 10px;
      align-items: start;
    }
    /* Grid and flex children default to min-width:auto, i.e. min-content. A
       long unbreakable string — "Dev — Back End Developer / Automation
       Specialist" — therefore forces its track wider than 1fr and pushes the
       whole row past the viewport, which is what clipped the right-hand panel
       instead of ellipsing inside it. */
    .agx-grid > * {
      min-width: 0;
    }
    .agx-panel {
      position: relative;
      display: flex;
      flex-direction: column;
      min-height: 0;
      /* Clip the head's tint to the rounded corners, which would otherwise
         paint square again over them. Note: never use backticks in comments
         inside this template literal — they terminate it. */
      overflow: hidden;
      isolation: isolate;
      border: 1px solid var(--agx-line-soft);
      border-radius: var(--agx-radius);
      background: var(--agx-glass);
      backdrop-filter: var(--agx-blur);
      -webkit-backdrop-filter: var(--agx-blur);
      box-shadow: var(--agx-elevation), var(--agx-hairline);
      transition: border-color 0.18s ease, box-shadow 0.18s ease, transform 0.22s ease;
    }
    /* Specular glare arc just outside the top edge. Screen-blended so it reads
       as reflected light on the plate rather than a painted-on white band. */
    .agx-panel::before {
      content: "";
      position: absolute;
      inset: 0;
      z-index: 0;
      pointer-events: none;
      border-radius: inherit;
      background: radial-gradient(
        ellipse 62% 42% at 50% -12%,
        var(--g-edge-light, rgba(255, 255, 255, 0.16)),
        transparent 58%
      );
      mix-blend-mode: screen;
      opacity: 0.75;
    }
    .agx-panel > * {
      position: relative;
      z-index: 1;
    }
    .agx-panel:hover {
      border-color: var(--agx-line);
      box-shadow: var(--agx-elevation), var(--agx-hairline),
        0 0 0 1px color-mix(in srgb, var(--g-primary) 16%, transparent);
    }
    .agx-panel-head {
      display: flex;
      align-items: center;
      gap: 8px;
      flex: none;
      padding: 10px 14px;
      border-bottom: 1px solid var(--agx-line-soft);
      background: var(--agx-glass-raised);
      color: var(--g-primary);
      font-size: 11px;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      font-weight: 700;
    }
    /* Status dot, borrowed from the app's own hud-title, so a panel header
       reads as a titled instrument rather than another line of caps. */
    .agx-panel-head::before {
      content: "";
      flex: none;
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: var(--g-primary);
      box-shadow: 0 0 9px var(--g-primary);
    }
    .agx-panel-head .agx-count {
      margin-left: auto;
      flex: none;
      padding: 2px 9px;
      border: 1px solid var(--agx-line-soft);
      border-radius: 999px;
      background: color-mix(in srgb, var(--g-primary) 6%, transparent);
      color: var(--agx-dim);
      font-size: 9.5px;
      letter-spacing: 0.06em;
      text-transform: none;
      font-weight: 500;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    /* Panel-level actions sit in the header, so the panel that describes a
       thing is also the panel that creates it. */
    .agx-panel-head .agx-panel-act {
      margin-left: auto;
      flex: none;
    }
    .agx-panel-head .agx-count + .agx-panel-act {
      margin-left: 0;
    }
    .agx-panel-body {
      padding: 10px 11px 11px;
      overflow: auto;
      /* A bare 46vh is not a height cap when the shell renders zoomed: the
         viewport unit resolves against the unzoomed viewport, so 46vh came out
         at ~590px and the panel never actually capped. The px term is what
         does the work. */
      max-height: min(46vh, 420px);
    }
    .agx-panel-body::-webkit-scrollbar {
      width: 6px;
      height: 6px;
    }
    .agx-panel-body::-webkit-scrollbar-thumb {
      background: color-mix(in srgb, var(--g-primary) 24%, transparent);
    }

    /* ── Rows ─────────────────────────────────────────────── */
    .agx-row {
      display: flex;
      align-items: baseline;
      gap: 9px;
      width: 100%;
      text-align: left;
      padding: 7px 8px;
      border: 1px solid transparent;
      border-bottom: 1px solid var(--agx-line-soft);
      border-radius: var(--agx-radius-sm);
      background: transparent;
      color: inherit;
      font: inherit;
      transition: background 0.15s ease, border-color 0.15s ease;
    }
    .agx-row:last-child {
      border-bottom-color: transparent;
    }
    /* Rows that carry their own controls need them on a second line on narrow
       panels, and vertically centred rather than baseline-aligned. */
    .agx-row.has-actions {
      align-items: center;
      flex-wrap: wrap;
      row-gap: 6px;
    }
    .agx-row-actions {
      flex: none;
      display: flex;
      align-items: center;
      gap: 5px;
      margin-left: auto;
    }
    button.agx-row {
      cursor: pointer;
    }
    button.agx-row:hover {
      border-color: var(--agx-line);
      background: color-mix(in srgb, var(--g-primary) 7%, transparent);
    }
    .agx-row.is-selected {
      border-color: var(--g-primary);
      background: color-mix(in srgb, var(--g-primary) 14%, transparent);
    }
    .agx-row-main {
      flex: 1;
      min-width: 0;
    }
    /* These are authored as <span>. text-overflow only applies to a block
       container, so without display:block the ellipsis silently never
       rendered and long worker titles were hard-clipped by the panel edge
       instead. */
    .agx-row-title {
      display: block;
      max-width: 100%;
      color: var(--g-fg, #e8e8ee);
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.01em;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .agx-row-meta {
      display: block;
      max-width: 100%;
      margin-top: 2px;
      color: var(--agx-dim);
      font-size: 10px;
      letter-spacing: 0.02em;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .agx-row-main {
      display: block;
    }
    .agx-indent {
      padding-left: 18px;
    }
    .agx-indent-2 {
      padding-left: 36px;
    }

    /* ── Tags / KPIs ──────────────────────────────────────── */
    .agx-tag {
      flex: none;
      padding: 2px 9px;
      border: 1px solid var(--agx-line);
      border-radius: 999px;
      font-size: 9.5px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--agx-dim);
      white-space: nowrap;
    }
    .agx-tag.gold {
      color: var(--g-primary);
      border-color: color-mix(in srgb, var(--g-primary) 45%, transparent);
    }
    .agx-tag.warn {
      color: var(--g-warning, #f5b942);
      border-color: color-mix(in srgb, var(--g-warning, #f5b942) 45%, transparent);
    }
    .agx-tag.crit {
      color: var(--g-danger, #f0616d);
      border-color: color-mix(in srgb, var(--g-danger, #f0616d) 50%, transparent);
    }
    .agx-tag.ok {
      color: var(--g-success, #4ade80);
      border-color: color-mix(in srgb, var(--g-success, #4ade80) 40%, transparent);
    }
    .agx-kpis {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 8px;
    }
    .agx-kpi {
      position: relative;
      min-width: 0;
      overflow: hidden;
      isolation: isolate;
      border: 1px solid var(--agx-line-soft);
      border-radius: var(--agx-radius);
      background: var(--agx-glass);
      backdrop-filter: var(--agx-blur);
      -webkit-backdrop-filter: var(--agx-blur);
      box-shadow: var(--agx-elevation), var(--agx-hairline);
      padding: 10px 14px 11px;
      transition: transform 0.22s cubic-bezier(0.2, 0.8, 0.2, 1), border-color 0.2s ease;
    }
    .agx-kpi::before {
      content: "";
      position: absolute;
      inset: 0;
      z-index: -1;
      pointer-events: none;
      background: radial-gradient(
        ellipse 70% 50% at 50% -20%,
        var(--g-edge-light, rgba(255, 255, 255, 0.14)),
        transparent 60%
      );
      mix-blend-mode: screen;
    }
    .agx-kpi:hover {
      transform: translateY(-2px);
      border-color: var(--agx-line);
    }
    .agx-kpi-label {
      color: var(--agx-dim);
      font-size: 9.5px;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      font-weight: 600;
    }
    .agx-kpi-value {
      margin-top: 2px;
      font-size: 23px;
      font-weight: 700;
      line-height: 1.1;
      letter-spacing: -0.01em;
      font-variant-numeric: tabular-nums;
      background: linear-gradient(
        150deg,
        color-mix(in srgb, var(--g-primary) 40%, #ffffff) 0%,
        var(--g-primary) 62%
      );
      -webkit-background-clip: text;
      background-clip: text;
      -webkit-text-fill-color: transparent;
      color: var(--g-primary);
      overflow-wrap: anywhere;
    }
    /* A zero is information, not an achievement — dim it so a real number in a
       neighbouring tile is the thing the eye lands on. */
    .agx-kpi.is-zero .agx-kpi-value {
      background: none;
      -webkit-text-fill-color: currentColor;
      color: color-mix(in srgb, var(--g-fg, #e8e8ee) 42%, transparent);
    }
    .agx-kpi-context {
      margin-top: 2px;
      color: var(--agx-dim);
      font-size: 10px;
      line-height: 1.4;
    }
    /* Compact variant for the delivery metric strip, where five tiles share one
       row inside a panel rather than standing alone on the page. */
    .agx-kpis.compact {
      grid-template-columns: repeat(auto-fit, minmax(104px, 1fr));
      gap: 7px;
    }
    .agx-kpis.compact .agx-kpi {
      padding: 8px 10px 9px;
      box-shadow: var(--agx-hairline);
    }
    .agx-kpis.compact .agx-kpi-value {
      font-size: 19px;
    }
    .agx-kpis.compact .agx-kpi-label {
      font-size: 9px;
      letter-spacing: 0.12em;
    }
    .agx-kpi.tone-crit .agx-kpi-value {
      background: none;
      -webkit-text-fill-color: currentColor;
      color: var(--g-danger);
    }
    .agx-kpi.tone-warn .agx-kpi-value {
      background: none;
      -webkit-text-fill-color: currentColor;
      color: var(--g-warning);
    }

    /* ── States ───────────────────────────────────────────── */
    .agx-banner {
      border: 1px solid color-mix(in srgb, var(--g-danger, #f0616d) 45%, transparent);
      border-radius: var(--agx-radius);
      background: color-mix(in srgb, var(--g-danger, #f0616d) 10%, transparent);
      backdrop-filter: var(--agx-blur);
      -webkit-backdrop-filter: var(--agx-blur);
      box-shadow: var(--agx-hairline);
      color: var(--g-danger, #f0616d);
      padding: 10px 13px;
      font-size: 11px;
    }
    .agx-banner ul {
      margin: 5px 0 0;
      padding-left: 16px;
    }
    /*
     * The empty state is the *normal* state of a young agency: with no work
     * items every panel on this page renders one. Left as a dashed grey box it
     * makes a working product look broken, so it is composed instead — a ringed
     * glyph, a sentence-case headline, one line of explanation and exactly one
     * button that does the thing being described.
     */
    .agx-empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 7px;
      min-height: 100%;
      padding: 12px 16px;
      border: 1px solid var(--agx-line-soft);
      border-radius: var(--agx-radius);
      background: radial-gradient(
          ellipse 120% 90% at 50% 0%,
          color-mix(in srgb, var(--g-primary) 6%, transparent),
          transparent 70%
        ),
        rgba(255, 255, 255, 0.012);
      color: var(--agx-dim);
      font-size: 11px;
      line-height: 1.5;
      text-align: center;
    }
    .agx-empty-glyph {
      flex: none;
      display: grid;
      place-items: center;
      width: 30px;
      height: 30px;
      border-radius: 50%;
      border: 1px solid color-mix(in srgb, var(--g-primary) 34%, transparent);
      background: color-mix(in srgb, var(--g-primary) 9%, transparent);
      box-shadow: 0 0 0 6px color-mix(in srgb, var(--g-primary) 5%, transparent),
        inset 0 1px 0 rgba(255, 255, 255, 0.16);
      color: var(--g-primary);
      font-size: 15px;
      line-height: 1;
    }
    .agx-empty strong {
      display: block;
      margin-bottom: 3px;
      color: var(--g-fg, #e8e8ee);
      font-weight: 700;
      letter-spacing: 0.02em;
      text-transform: none;
      font-size: 12.5px;
    }
    .agx-empty span {
      display: block;
      max-width: 46ch;
    }
    .agx-empty .agx-btn {
      margin-top: 3px;
    }
    /* Inline variant for the board, which sits under seven columns and would
       look absurd centred in a full-width plate. */
    .agx-empty.inline {
      flex-direction: row;
      align-items: center;
      justify-content: flex-start;
      text-align: left;
      min-height: 0;
      padding: 12px 16px;
      gap: 14px;
    }
    .agx-empty.inline .agx-empty-copy {
      min-width: 0;
      flex: 1;
    }
    .agx-empty.inline span {
      max-width: 82ch;
    }
    .agx-empty-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 7px;
      justify-content: center;
    }
    .agx-empty.inline .agx-empty-actions {
      justify-content: flex-start;
      flex: none;
    }
    .agx-skel {
      display: grid;
      gap: 8px;
    }
    .agx-skel-bar {
      height: 12px;
      border-radius: 2px;
      background: linear-gradient(
        90deg,
        color-mix(in srgb, var(--g-primary) 6%, transparent) 0%,
        color-mix(in srgb, var(--g-primary) 20%, transparent) 50%,
        color-mix(in srgb, var(--g-primary) 6%, transparent) 100%
      );
      background-size: 220% 100%;
      animation: agx-shimmer 1.4s linear infinite;
    }
    .agx-skel-bar.tall {
      height: 120px;
    }
    @keyframes agx-shimmer {
      from {
        background-position: 120% 0;
      }
      to {
        background-position: -120% 0;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .agx-skel-bar {
        animation: none;
      }
    }
    .agx-sr {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
      white-space: nowrap;
      border: 0;
    }

    /* ── Live work board (kanban) ─────────────────────────── */
    /*
     * The board is the authorisation surface for autonomous work, so the
     * staged column is deliberately the loudest thing on it and every card
     * carries a keyboard-reachable stage control — drag is an accelerator, not
     * the only route.
     */
    /*
     * .agx is a scrolling flex column, so a panel this tall would otherwise
     * be shrunk below its content and paint over the panels beneath it —
     * swallowing clicks on the cards' own controls.
     */
    .agx-panel.agx-board-panel {
      flex: 0 0 auto;
    }
    .agx-board-note {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 6px;
      margin: 10px 11px 0;
      padding: 8px 11px;
      border: 1px solid var(--agx-line-soft);
      border-radius: var(--agx-radius-sm);
      background: color-mix(in srgb, var(--g-primary) 5%, transparent);
      color: var(--agx-dim);
      font-size: 10.5px;
      line-height: 1.5;
    }
    .agx-board-note strong {
      color: var(--g-primary);
      font-weight: 600;
    }
    .agx-board-note.warn {
      border-color: var(--g-warning-border, color-mix(in srgb, var(--g-warning) 40%, transparent));
      background: var(--g-warning-soft, color-mix(in srgb, var(--g-warning) 12%, transparent));
      color: var(--g-warning);
    }
    .agx-board-note.warn strong {
      color: var(--g-warning);
    }
    .agx-board {
      display: grid;
      grid-auto-flow: column;
      grid-auto-columns: minmax(182px, 1fr);
      gap: 9px;
      margin: 10px 11px 11px;
      padding: 10px;
      overflow-x: auto;
      align-items: stretch;
      border: 1px solid var(--agx-line-soft);
      border-radius: var(--agx-radius);
      background: linear-gradient(
        180deg,
        rgba(0, 0, 0, 0.24) 0%,
        color-mix(in srgb, var(--g-primary) 3%, rgba(0, 0, 0, 0.14)) 100%
      );
      box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.4);
    }
    .agx-board::-webkit-scrollbar {
      height: 8px;
    }
    .agx-board::-webkit-scrollbar-thumb {
      border-radius: 999px;
      background: color-mix(in srgb, var(--g-primary) 26%, transparent);
    }
    .agx-col {
      display: flex;
      flex-direction: column;
      min-width: 0;
      border: 1px solid var(--agx-line-soft);
      border-radius: var(--agx-radius-sm);
      background: color-mix(in srgb, var(--g-primary) 2.5%, rgba(255, 255, 255, 0.02));
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05);
      transition: border-color 0.16s ease, background 0.16s ease, box-shadow 0.16s ease;
    }
    .agx-col.is-gate {
      border-color: color-mix(in srgb, var(--g-primary) 55%, transparent);
      background: color-mix(in srgb, var(--g-primary) 8%, transparent);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08),
        0 0 0 1px color-mix(in srgb, var(--g-primary) 16%, transparent),
        0 10px 30px -14px color-mix(in srgb, var(--g-primary) 60%, transparent);
    }
    .agx-col.is-dropzone {
      border-color: var(--g-primary);
      background: color-mix(in srgb, var(--g-primary) 16%, transparent);
    }
    .agx-col-head {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 7px 9px;
      border-bottom: 1px solid var(--agx-line-soft);
      color: var(--agx-dim);
      font-size: 9.5px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      font-weight: 700;
    }
    .agx-col.is-gate .agx-col-head {
      color: var(--g-primary);
    }
    .agx-col-head .agx-col-n {
      margin-left: auto;
      font-weight: 400;
      letter-spacing: 0.04em;
    }
    .agx-col-hint {
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      padding: 5px 9px 6px;
      color: var(--agx-dim);
      font-size: 9.5px;
      line-height: 1.4;
      border-bottom: 1px solid var(--agx-line-soft);
    }
    .agx-col-body {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 7px;
      min-height: 58px;
      max-height: min(52vh, 320px);
      overflow-y: auto;
    }
    .agx-col-body::-webkit-scrollbar {
      width: 6px;
    }
    .agx-col-body::-webkit-scrollbar-thumb {
      background: color-mix(in srgb, var(--g-primary) 24%, transparent);
    }
    .agx-col-empty {
      display: grid;
      place-items: center;
      min-height: 34px;
      padding: 5px 4px;
      border: 1px dashed color-mix(in srgb, var(--g-primary) 14%, transparent);
      border-radius: var(--agx-radius-sm);
      color: var(--agx-dim);
      font-size: 9px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      opacity: 0.6;
    }
    /*
     * Empty board: the seven lifecycle hints are worth their space once there
     * is work to read them against, but with zero cards they are seven
     * paragraphs of instructions crowding out the half of the page that can
     * actually be acted on. The lanes, their order and the highlighted staging
     * gate all stay; only the prose collapses, and it stays on every column's
     * aria-label for assistive tech.
     */
    .agx-board.is-empty .agx-col-hint {
      display: none;
    }
    .agx-board.is-empty .agx-col-body {
      min-height: 0;
      padding: 6px;
    }
    .agx-board.is-empty .agx-col-empty {
      min-height: 26px;
      font-size: 8.5px;
    }
    .agx-card {
      display: flex;
      flex-direction: column;
      gap: 5px;
      padding: 8px 9px;
      border: 1px solid var(--agx-line-soft);
      border-left: 2px solid var(--g-neutral-border, var(--agx-line));
      border-radius: var(--agx-radius-sm);
      background: linear-gradient(
        160deg,
        color-mix(in srgb, var(--g-primary) 7%, rgba(255, 255, 255, 0.05)) 0%,
        rgba(255, 255, 255, 0.02) 100%
      );
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.06);
      transition: transform 0.16s ease, box-shadow 0.16s ease, border-color 0.16s ease;
    }
    .agx-card:hover {
      border-color: var(--agx-line);
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.08);
    }
    .agx-card:focus-visible {
      outline: 2px solid var(--g-primary);
      outline-offset: 2px;
    }
    .agx-card.is-busy {
      opacity: 0.55;
    }
    .agx-card.is-dragging {
      opacity: 0.4;
      border-style: dashed;
    }
    .agx-card.p-urgent {
      border-left-color: var(--g-danger);
    }
    .agx-card.p-high {
      border-left-color: var(--g-warning);
    }
    .agx-card.p-normal {
      border-left-color: var(--g-info-border, var(--g-info));
    }
    .agx-card-title {
      color: var(--g-fg, #e8e8ee);
      font-size: 11px;
      line-height: 1.3;
      overflow-wrap: anywhere;
    }
    .agx-card-meta {
      color: var(--agx-dim);
      font-size: 9.5px;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }
    .agx-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 3px;
    }
    .agx-chip {
      padding: 1px 7px;
      border: 1px solid var(--g-neutral-border, var(--agx-line));
      border-radius: 999px;
      font-size: 8.5px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--g-neutral, var(--agx-dim));
      white-space: nowrap;
    }
    .agx-chip.gold {
      color: var(--g-primary);
      border-color: color-mix(in srgb, var(--g-primary) 45%, transparent);
    }
    .agx-chip.ok {
      color: var(--g-success);
      border-color: var(--g-success-border, color-mix(in srgb, var(--g-success) 40%, transparent));
      background: var(--g-success-soft, transparent);
    }
    .agx-chip.warn {
      color: var(--g-warning);
      border-color: var(--g-warning-border, color-mix(in srgb, var(--g-warning) 40%, transparent));
      background: var(--g-warning-soft, transparent);
    }
    .agx-chip.crit {
      color: var(--g-danger);
      border-color: var(--g-danger-border, color-mix(in srgb, var(--g-danger) 40%, transparent));
      background: var(--g-danger-soft, transparent);
    }
    .agx-chip.info {
      color: var(--g-info);
      border-color: var(--g-info-border, color-mix(in srgb, var(--g-info) 40%, transparent));
      background: var(--g-info-soft, transparent);
    }
    .agx-card-blocked {
      display: block;
      padding: 4px 7px;
      border-radius: var(--agx-radius-sm);
      border: 1px solid var(--g-warning-border, color-mix(in srgb, var(--g-warning) 40%, transparent));
      background: var(--g-warning-soft, transparent);
      color: var(--g-warning);
      font-size: 9.5px;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }
    .agx-card-actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 4px;
      margin-top: 1px;
    }
    .agx-card-actions .agx-select {
      flex: 1;
      min-width: 0;
      font-size: 9.5px;
      padding: 3px 5px;
    }
    .agx-btn.tiny {
      font-size: 9.5px;
      padding: 3px 6px;
    }
    .agx-btn.authorize {
      width: 100%;
      white-space: normal;
      line-height: 1.25;
      text-align: center;
      color: var(--g-bg, #050505);
      background: var(--g-primary);
      border-color: var(--g-primary);
      font-weight: 700;
    }
    .agx-btn.authorize:hover:not(:disabled) {
      background: color-mix(in srgb, var(--g-primary) 82%, #fff);
    }

    /* ── Live status animation ────────────────────────────── */
    /*
     * The board has to be readable at a glance: queued cards are calm, RUNNING
     * cards breathe and carry a shimmer so it is obvious an agent is executing,
     * completed cards settle in with a check. All CSS transform/opacity only —
     * no layout thrash — and every animation is disabled under
     * prefers-reduced-motion at the foot of this block.
     */
    .agx-card {
      /* New cards (including one that just moved to a new column) settle in. */
      animation: agx-card-enter 0.32s cubic-bezier(0.2, 0.8, 0.2, 1) both;
    }
    .agx-card.st-in_progress {
      border-left-color: var(--g-primary);
      border-color: color-mix(in srgb, var(--g-primary) 34%, transparent);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.06),
        0 0 0 1px color-mix(in srgb, var(--g-primary) 18%, transparent);
      animation: agx-card-enter 0.32s cubic-bezier(0.2, 0.8, 0.2, 1) both,
        agx-breathe 2.6s ease-in-out 0.32s infinite;
    }
    .agx-card.st-completed {
      border-left-color: var(--g-success, #4ade80);
    }
    .agx-card.st-escalated {
      border-left-color: var(--g-danger, #f0616d);
    }
    .agx-card.st-accepted {
      border-left-color: var(--g-primary);
    }
    /* Pulsing "live" dot used on running cards and in the modal. */
    .agx-live-dot {
      display: inline-block;
      width: 7px;
      height: 7px;
      margin-right: 5px;
      vertical-align: middle;
      border-radius: 50%;
      background: var(--g-primary);
      box-shadow: 0 0 0 0 color-mix(in srgb, var(--g-primary) 70%, transparent);
      animation: agx-ping 1.7s cubic-bezier(0.35, 0, 0.25, 1) infinite;
    }
    .agx-done-tick {
      display: inline-block;
      margin-right: 5px;
      color: var(--g-success, #4ade80);
      font-weight: 700;
      animation: agx-pop 0.4s cubic-bezier(0.2, 1.4, 0.4, 1) both;
    }
    /* Indeterminate progress shimmer, shown while an agent is executing. */
    .agx-run-shimmer {
      display: block;
      height: 3px;
      border-radius: 999px;
      overflow: hidden;
      background: color-mix(in srgb, var(--g-primary) 12%, transparent);
    }
    .agx-run-shimmer.wide {
      height: 4px;
    }
    .agx-run-shimmer > span {
      display: block;
      width: 40%;
      height: 100%;
      border-radius: 999px;
      background: linear-gradient(
        90deg,
        transparent,
        var(--g-primary),
        color-mix(in srgb, var(--g-primary) 40%, #fff),
        var(--g-primary),
        transparent
      );
      animation: agx-slide 1.25s ease-in-out infinite;
    }
    .agx-chip.run {
      color: var(--g-primary);
      border-color: color-mix(in srgb, var(--g-primary) 55%, transparent);
      background: color-mix(in srgb, var(--g-primary) 10%, transparent);
    }
    @keyframes agx-card-enter {
      from {
        opacity: 0;
        transform: translateY(6px) scale(0.985);
      }
      to {
        opacity: 1;
        transform: none;
      }
    }
    @keyframes agx-breathe {
      0%,
      100% {
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.06),
          0 0 0 1px color-mix(in srgb, var(--g-primary) 16%, transparent);
      }
      50% {
        box-shadow: 0 2px 12px rgba(0, 0, 0, 0.34), inset 0 1px 0 rgba(255, 255, 255, 0.08),
          0 0 0 1px color-mix(in srgb, var(--g-primary) 42%, transparent),
          0 0 18px -4px color-mix(in srgb, var(--g-primary) 55%, transparent);
      }
    }
    @keyframes agx-ping {
      0% {
        box-shadow: 0 0 0 0 color-mix(in srgb, var(--g-primary) 65%, transparent);
      }
      70% {
        box-shadow: 0 0 0 6px color-mix(in srgb, var(--g-primary) 0%, transparent);
      }
      100% {
        box-shadow: 0 0 0 0 color-mix(in srgb, var(--g-primary) 0%, transparent);
      }
    }
    @keyframes agx-pop {
      from {
        transform: scale(0.4);
        opacity: 0;
      }
      to {
        transform: scale(1);
        opacity: 1;
      }
    }
    @keyframes agx-slide {
      0% {
        transform: translateX(-110%);
      }
      100% {
        transform: translateX(310%);
      }
    }

    /* ── Assign band (drag delivery → employee / column) ──── */
    .aops-assign-band {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1.35fr);
      gap: 12px;
      margin-bottom: 12px;
    }
    @media (max-width: 900px) {
      .aops-assign-band {
        grid-template-columns: 1fr;
      }
    }
    .aops-assign-band .agx-panel-body {
      max-height: 260px;
    }
    .agx-assign-rail {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .agx-assign-rail .agx-card {
      cursor: grab;
    }
    .agx-assign-rail .agx-card:active {
      cursor: grabbing;
    }
    .agx-emp-targets {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
      gap: 8px;
    }
    .agx-emp-target {
      display: flex;
      flex-direction: column;
      gap: 3px;
      padding: 9px 10px;
      border: 1px dashed color-mix(in srgb, var(--g-primary) 26%, transparent);
      border-radius: var(--agx-radius-sm);
      background: color-mix(in srgb, var(--g-primary) 3%, rgba(255, 255, 255, 0.015));
      transition: border-color 0.16s ease, background 0.16s ease, transform 0.16s ease;
    }
    .agx-emp-target.is-over {
      border-style: solid;
      border-color: var(--g-primary);
      background: color-mix(in srgb, var(--g-primary) 16%, transparent);
      transform: translateY(-2px);
    }
    .agx-emp-target .agx-emp-name {
      color: var(--g-fg, #e8e8ee);
      font-size: 11px;
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .agx-emp-target .agx-emp-meta {
      color: var(--agx-dim);
      font-size: 9.5px;
      line-height: 1.35;
    }
    .agx-emp-target .agx-emp-load {
      margin-top: 3px;
      height: 3px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--g-primary) 12%, transparent);
      overflow: hidden;
    }
    .agx-emp-target .agx-emp-load > span {
      display: block;
      height: 100%;
      border-radius: 999px;
      background: var(--g-primary);
    }
    .agx-assign-hint {
      margin: 0 0 8px;
      color: var(--agx-dim);
      font-size: 10.5px;
      line-height: 1.5;
    }
    .agx-assign-hint strong {
      color: var(--g-primary);
      font-weight: 600;
    }

    /* ── Run result / deliverable (full-expansion modal) ──── */
    .agx-result {
      display: grid;
      gap: 9px;
      padding: 11px 12px;
      border: 1px solid var(--agx-line-soft);
      border-radius: var(--agx-radius-sm);
      background: color-mix(in srgb, var(--g-primary) 3%, rgba(0, 0, 0, 0.22));
    }
    .agx-result.is-live {
      border-color: color-mix(in srgb, var(--g-primary) 40%, transparent);
    }
    .agx-result.is-done {
      border-color: color-mix(in srgb, var(--g-success, #4ade80) 34%, transparent);
    }
    .agx-result-head {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .agx-result-title {
      color: var(--g-fg, #e8e8ee);
      font-size: 11.5px;
      font-weight: 700;
      letter-spacing: 0.02em;
    }
    .agx-result-head .agx-tag {
      margin-left: auto;
    }
    .agx-result-facts {
      display: flex;
      flex-wrap: wrap;
      gap: 5px 12px;
      align-items: center;
      color: var(--agx-dim);
      font-size: 10px;
    }
    .agx-result-facts code {
      color: var(--g-primary);
    }
    .agx-result-block {
      display: grid;
      gap: 4px;
    }
    .agx-result-label {
      color: var(--agx-dim);
      font-size: 9px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      font-weight: 600;
    }
    .agx-result-output {
      margin: 0;
      max-height: 260px;
      overflow: auto;
      padding: 9px 11px;
      border: 1px solid var(--agx-line-soft);
      border-radius: var(--agx-radius-sm);
      background: rgba(0, 0, 0, 0.34);
      color: var(--g-fg, #d8d8de);
      font-family: var(--agx-mono);
      font-size: 10.5px;
      line-height: 1.5;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .agx-result-output.err {
      color: var(--g-danger, #f0616d);
      border-color: color-mix(in srgb, var(--g-danger, #f0616d) 34%, transparent);
    }
    .agx-timeline-mini {
      display: grid;
      gap: 4px;
    }
    .agx-tl-row {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 10px;
    }
    .agx-tl-dot {
      flex: none;
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: color-mix(in srgb, var(--g-primary) 55%, transparent);
    }
    .agx-tl-dot.ok {
      background: var(--g-success, #4ade80);
    }
    .agx-tl-dot.warn {
      background: var(--g-warning, #f5b942);
    }
    .agx-tl-dot.crit {
      background: var(--g-danger, #f0616d);
    }
    .agx-tl-dot.run {
      background: var(--g-primary);
      animation: agx-ping 1.7s cubic-bezier(0.35, 0, 0.25, 1) infinite;
    }
    .agx-tl-label {
      color: var(--g-fg, #e8e8ee);
    }
    .agx-tl-time {
      margin-left: auto;
      color: var(--agx-dim);
    }
    @media (prefers-reduced-motion: reduce) {
      .agx-card,
      .agx-card.st-in_progress,
      .agx-live-dot,
      .agx-done-tick,
      .agx-tl-dot.run,
      .agx-run-shimmer > span {
        animation: none !important;
      }
    }

    /* ── Authorisation prompt ─────────────────────────────── */
    .agx-modal-scrim {
      position: fixed;
      inset: 0;
      /* Above the app chrome (topbar/sidebar) so the dim actually reads as a
         modal state rather than a floating panel. */
      z-index: 9500;
      display: grid;
      place-items: center;
      padding: 16px;
      background: rgba(0, 0, 0, 0.76);
    }
    .agx-modal {
      width: min(540px, 100%);
      max-height: 84vh;
      overflow: auto;
      border: 1px solid color-mix(in srgb, var(--g-primary) 40%, transparent);
      border-radius: var(--agx-radius);
      background: linear-gradient(
          160deg,
          color-mix(in srgb, var(--g-primary) 7%, rgba(255, 255, 255, 0.05)) 0%,
          rgba(255, 255, 255, 0.02) 60%
        ),
        color-mix(in srgb, var(--g-bg, #050505) 88%, #000);
      backdrop-filter: var(--g-blur-heavy, var(--agx-blur));
      -webkit-backdrop-filter: var(--g-blur-heavy, var(--agx-blur));
      box-shadow: 0 40px 110px rgba(0, 0, 0, 0.7),
        0 0 0 1px color-mix(in srgb, var(--g-primary) 12%, transparent),
        inset 0 1px 0 rgba(255, 255, 255, 0.12);
      font-family: var(--agx-mono);
      font-size: 11px;
      color: var(--g-fg, #d5d5dc);
    }
    .agx-modal h2 {
      margin: 0;
      padding: 12px 15px;
      border-bottom: 1px solid var(--agx-line);
      background: color-mix(in srgb, var(--g-primary) 10%, transparent);
      color: var(--g-primary);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.16em;
      text-transform: uppercase;
    }
    .agx-modal-body {
      display: grid;
      gap: 10px;
      padding: 14px 15px;
      line-height: 1.55;
    }
    .agx-modal-body dl {
      margin: 0;
      display: grid;
      grid-template-columns: minmax(104px, auto) 1fr;
      gap: 4px 10px;
    }
    .agx-modal-body dt {
      color: var(--agx-dim);
      font-size: 9.5px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    .agx-modal-body dd {
      margin: 0;
      overflow-wrap: anywhere;
    }
    .agx-modal-foot {
      display: flex;
      gap: 7px;
      justify-content: flex-end;
      padding: 11px 15px 13px;
      border-top: 1px solid var(--agx-line);
      background: rgba(0, 0, 0, 0.18);
    }
    .agx-note {
      padding: 8px 10px;
      border: 1px solid var(--g-info-border, color-mix(in srgb, var(--g-info) 40%, transparent));
      border-radius: var(--agx-radius-sm);
      background: var(--g-info-soft, transparent);
      color: var(--g-info);
      font-size: 10px;
      line-height: 1.45;
    }
    .agx-note.warn {
      border-color: var(--g-warning-border, color-mix(in srgb, var(--g-warning) 40%, transparent));
      background: var(--g-warning-soft, transparent);
      color: var(--g-warning);
    }
    .agx-note.ok {
      border-color: var(--g-success-border, color-mix(in srgb, var(--g-success) 40%, transparent));
      background: var(--g-success-soft, transparent);
      color: var(--g-success);
    }

    /* ── Composer form controls ───────────────────────────── */
    /*
     * Used by the create dialogs (work item, responsibility, review, shift).
     * Every one of them is one gateway RPC, so the form is deliberately short:
     * the required fields, sensible defaults for the rest.
     */
    .agx-form {
      display: grid;
      gap: 11px;
    }
    .agx-form-row {
      display: grid;
      gap: 11px;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    }
    .agx-form-row > * {
      min-width: 0;
    }
    .agx-form-field {
      display: grid;
      gap: 5px;
      min-width: 0;
    }
    .agx-form-field > label {
      color: var(--agx-dim);
      font-size: 9.5px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      font-weight: 600;
    }
    .agx-input,
    .agx-textarea {
      font: inherit;
      font-size: 12px;
      width: 100%;
      min-width: 0;
      padding: 8px 11px;
      color: var(--g-fg, #e8e8ee);
      background: rgba(0, 0, 0, 0.28);
      border: 1px solid var(--agx-line-soft);
      border-radius: var(--agx-radius-sm);
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }
    .agx-textarea {
      resize: vertical;
      min-height: 62px;
      line-height: 1.5;
    }
    .agx-input::placeholder,
    .agx-textarea::placeholder {
      color: color-mix(in srgb, var(--g-fg, #e8e8ee) 32%, transparent);
    }
    .agx-input:focus,
    .agx-textarea:focus,
    .agx-select:focus {
      outline: none;
      border-color: color-mix(in srgb, var(--g-primary) 60%, transparent);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--g-primary) 14%, transparent);
    }
    .agx-form .agx-select {
      width: 100%;
      font-size: 12px;
      padding: 8px 10px;
      background: rgba(0, 0, 0, 0.28);
    }
    .agx-form-hint {
      color: var(--agx-dim);
      font-size: 10px;
      line-height: 1.5;
    }
    .agx-daypick {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
    }
    .agx-daypick button {
      font: inherit;
      font-size: 10px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      padding: 5px 9px;
      min-width: 38px;
      color: var(--agx-dim);
      background: rgba(0, 0, 0, 0.28);
      border: 1px solid var(--agx-line-soft);
      border-radius: 999px;
      cursor: pointer;
    }
    .agx-daypick button[aria-pressed="true"] {
      color: var(--g-primary);
      border-color: color-mix(in srgb, var(--g-primary) 55%, transparent);
      background: color-mix(in srgb, var(--g-primary) 16%, transparent);
    }

    /* ── Action feedback ──────────────────────────────────── */
    .agx-notice {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 9px 13px;
      border: 1px solid var(--g-success-border, color-mix(in srgb, var(--g-success) 40%, transparent));
      border-radius: var(--agx-radius);
      background: var(--g-success-soft, transparent);
      backdrop-filter: var(--agx-blur);
      -webkit-backdrop-filter: var(--agx-blur);
      color: var(--g-success);
      font-size: 11px;
      line-height: 1.45;
    }
    .agx-notice .agx-btn {
      margin-left: auto;
      flex: none;
    }
    /* Armed approve/reject: the row swaps to a commit prompt so an irreversible
       decision always costs two deliberate clicks. */
    .agx-confirm {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 7px;
      width: 100%;
      margin-top: 7px;
      padding: 8px 10px;
      border: 1px solid color-mix(in srgb, var(--g-primary) 40%, transparent);
      border-radius: var(--agx-radius-sm);
      background: color-mix(in srgb, var(--g-primary) 9%, transparent);
      color: var(--g-fg, #e8e8ee);
      font-size: 10.5px;
    }
    .agx-confirm .agx-confirm-actions {
      margin-left: auto;
      display: flex;
      gap: 6px;
    }

    /* ── Daily Operations layout ──────────────────────────── */
    /*
     * The lower half used to be an auto-fit track of five panels of wildly
     * different natural heights, which left one panel sliced at the fold and a
     * third of the page empty. It is now an explicit two-row composition:
     * the two decision panels lead, the workforce roster spans both rows
     * because it is the longest list, and every panel in a row is the same
     * height with its own scroll — so a row always ends on a clean edge.
     */
    .agx-grid-daily {
      display: grid;
      gap: 12px;
      align-items: stretch;
      grid-template-columns: minmax(0, 1fr);
      /* Absorbs whatever height the rows above leave, so the page ends on the
         viewport edge instead of leaving a third of it empty while the panels
         above scroll internally. It never shrinks below a legible floor — past
         that the surface itself scrolls. */
      flex: 1 1 auto;
    }
    .agx-grid-daily > * {
      min-width: 0;
      min-height: 0;
    }
    .agx-grid-daily .agx-panel-body {
      flex: 1 1 auto;
      min-height: 0;
      max-height: none;
    }
    @media (min-width: 780px) {
      .agx-grid-daily {
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
        grid-template-rows: repeat(3, minmax(0, 1fr));
        grid-template-areas:
          "approvals reviews"
          "responsibilities delivery"
          "workforce workforce";
        min-height: 654px;
      }
    }
    @media (min-width: 1180px) {
      .agx-grid-daily {
        grid-template-columns: minmax(0, 1.08fr) minmax(0, 1fr) minmax(0, 1fr);
        grid-template-rows: minmax(0, 1fr) minmax(0, 1fr);
        grid-template-areas:
          "approvals reviews workforce"
          "responsibilities delivery workforce";
        /* Two rows tall enough that the panel with the largest empty state still
           fits without its last line being clipped — the row height, not the
           copy, is what has to give. */
        min-height: 436px;
      }
    }
    .agx-area-approvals {
      grid-area: approvals;
    }
    .agx-area-reviews {
      grid-area: reviews;
    }
    .agx-area-responsibilities {
      grid-area: responsibilities;
    }
    .agx-area-delivery {
      grid-area: delivery;
    }
    .agx-area-workforce {
      grid-area: workforce;
    }

    /* ── Topology graph ───────────────────────────────────── */
    .agx-stage {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(260px, 320px);
      gap: 10px;
      min-height: 0;
    }
    .agx-graph-frame {
      position: relative;
      border: 1px solid var(--agx-line);
      background: color-mix(in srgb, var(--g-primary) 3%, #040404);
      height: 620px;
      overflow: hidden;
    }
    /*
     * In-flow, not absolutely positioned: SystemsGraph sets
     * container.style.position = "relative" when it mounts its tooltip, which
     * would silently drop an inset:0 and let the box grow to the SVG height.
     */
    .agx-graph-canvas {
      width: 100%;
      height: 100%;
    }
    .agx-graph-note {
      position: absolute;
      left: 9px;
      bottom: 9px;
      right: 9px;
      pointer-events: none;
      color: var(--agx-dim);
      font-size: 10px;
    }
    .agx-legend {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      padding: 6px 9px;
      border-top: 1px solid var(--agx-line-soft);
      color: var(--agx-dim);
      font-size: 10px;
    }
    .agx-legend span {
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }
    .agx-swatch {
      width: 9px;
      height: 9px;
      display: inline-block;
      border: 1px solid rgba(0, 0, 0, 0.5);
    }
    .agx-detail dl {
      margin: 0;
      display: grid;
      grid-template-columns: minmax(90px, auto) 1fr;
      gap: 4px 10px;
    }
    .agx-detail dt {
      color: var(--agx-dim);
      font-size: 10px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .agx-detail dd {
      margin: 0;
      color: var(--g-fg, #e8e8ee);
      overflow-wrap: anywhere;
    }

    @media (max-width: 1080px) {
      .agx-stage {
        grid-template-columns: minmax(0, 1fr);
      }
      .agx-graph-frame {
        min-height: 420px;
      }
    }
  </style>
`;
