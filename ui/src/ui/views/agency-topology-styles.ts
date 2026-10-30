/**
 * Topology-specific styling, layered on top of `AGENCY_SURFACE_STYLES`.
 *
 * Kept out of the shared agency stylesheet because none of it is shared: it is
 * the map frame, the always-visible encoding legend, and the summary the detail
 * panel shows when nothing is selected. Same InfiCode language as the rest —
 * near-black plate, `var(--g-primary)` gold, monospace — and every colour is a
 * `--g-*` token or a `color-mix()` on one, so the page recolours with the app.
 */

import { html } from "lit";

export const AGENCY_TOPOLOGY_STYLES = html`
  <style>
    /* ── Stage ────────────────────────────────────────────── */
    /*
     * The detail column is narrower than it was and the map takes the width
     * back: the map is the surface, the panel is the annotation.
     */
    /*
     * The stage claims the height left over after the header, toolbar and
     * legend, and the map frame claims what is left inside the panel. Fixed
     * pixel heights were the reason the legend fell off the bottom of the page
     * at 1366×768 — this way the map shrinks instead of the explanation.
     */
    .agx .agx-stage {
      grid-template-columns: minmax(0, 1fr) minmax(232px, 268px);
      align-items: stretch;
      flex: 1 1 auto;
      min-height: 340px;
    }
    .agx .agx-stage > .agx-panel {
      height: 100%;
    }
    .agx .agx-panel-head,
    .agx .agt-legend {
      flex: 0 0 auto;
    }
    .agx .agx-graph-frame {
      flex: 1 1 auto;
      height: auto;
      min-height: 240px;
    }
    .agx .agt-detail .agx-panel-body {
      flex: 1 1 auto;
      max-height: none;
    }

    /* ── Toolbar extras ───────────────────────────────────── */
    .agx .agt-input {
      font: inherit;
      font-size: 11px;
      width: 168px;
      padding: 5px 8px;
      color: var(--g-fg, #e5e5ea);
      background: var(--agx-plate);
      border: 1px solid var(--agx-line);
      border-radius: 2px;
    }
    .agx .agt-input::placeholder {
      color: color-mix(in srgb, var(--agx-dim) 80%, transparent);
    }
    .agx .agt-input:focus-visible {
      outline: 2px solid var(--g-primary);
      outline-offset: 1px;
    }
    .agx .agt-hitcount {
      color: var(--g-primary);
      font-size: 10px;
      letter-spacing: 0.06em;
    }
    .agx .agt-hitcount.none {
      color: var(--g-warning);
    }
    .agx .agt-focus-bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      padding: 5px 9px;
      border: 1px solid var(--g-info-border, color-mix(in srgb, var(--g-info) 40%, transparent));
      background: var(--g-info-soft, transparent);
      color: var(--g-info);
      font-size: 10.5px;
    }

    /* ── Legend ───────────────────────────────────────────── */
    /*
     * The legend is the key to three simultaneous encodings (shape = entity,
     * colour = health, size = weight), so it is a laid-out block that always
     * fits rather than a single line that gets clipped at the frame edge.
     */
    .agx .agt-legend {
      flex: 0 0 auto;
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 2px 18px;
      padding: 5px 9px 6px;
      border-bottom: 1px solid var(--agx-line-soft);
      background: color-mix(in srgb, var(--g-primary) 3%, transparent);
    }
    .agx .agt-legend-group {
      display: flex;
      align-items: baseline;
      flex-wrap: wrap;
      gap: 2px 8px;
      min-width: 0;
    }
    .agx .agt-legend-title {
      color: var(--g-primary);
      font-size: 9px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    .agx .agt-legend-items {
      display: flex;
      flex-wrap: wrap;
      gap: 2px 9px;
    }
    .agx .agt-legend-item {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      color: var(--agx-dim);
      font-size: 9.5px;
      white-space: nowrap;
    }
    .agx .agt-legend-item svg {
      flex: none;
      display: block;
    }
    .agx .agt-legend-note {
      color: var(--agx-dim);
      font-size: 9px;
      opacity: 0.85;
    }
    /* Reclaim vertical space for the map itself — every pixel spent on the
       page header is a pixel the org chart does not get. */
    .agx .agx-head {
      padding-bottom: 5px;
    }
    .agx .agx-sub {
      margin-top: 1px;
    }

    /* ── Detail panel ─────────────────────────────────────── */
    /*
     * The panel is only ~265px wide and every value in it (client names, MRR,
     * role titles) is user data of unbounded length, so the column is pinned
     * shut and long strings ellipsise or wrap rather than pushing a horizontal
     * scrollbar and clipping the numbers at the frame edge.
     */
    .agx .agt-detail .agx-panel-body {
      overflow-x: hidden;
    }
    .agx .agt-summary,
    .agx .agt-stat,
    .agx .agt-link {
      min-width: 0;
      max-width: 100%;
    }
    .agx .agt-stat-context,
    .agx .agt-stat-value {
      overflow-wrap: anywhere;
    }
    .agx .agt-summary {
      display: grid;
      gap: 7px;
    }
    .agx .agt-stat {
      display: grid;
      gap: 1px;
      padding: 6px 7px;
      border: 1px solid var(--agx-line-soft);
      border-left: 2px solid var(--agx-line);
      background: color-mix(in srgb, var(--g-primary) 3%, transparent);
    }
    .agx .agt-stat.ok {
      border-left-color: var(--g-success);
    }
    .agx .agt-stat.warn {
      border-left-color: var(--g-warning);
    }
    .agx .agt-stat.info {
      border-left-color: var(--g-info);
    }
    .agx .agt-stat-label {
      color: var(--agx-dim);
      font-size: 9px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    .agx .agt-stat-value {
      color: var(--g-fg, #eaeaf0);
      font-size: 15px;
      font-weight: 600;
      line-height: 1.25;
    }
    .agx .agt-stat-context {
      color: var(--agx-dim);
      font-size: 9.5px;
      line-height: 1.35;
    }
    .agx .agt-subhead {
      margin-top: 4px;
      color: var(--g-primary);
      font-size: 9px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
    }
    .agx .agt-link {
      display: flex;
      align-items: baseline;
      gap: 6px;
      width: 100%;
      padding: 4px 5px;
      text-align: left;
      font: inherit;
      font-size: 10.5px;
      color: var(--g-fg, #e2e2e8);
      background: transparent;
      border: 1px solid transparent;
      border-bottom: 1px solid var(--agx-line-soft);
      cursor: pointer;
    }
    .agx .agt-link:hover {
      border-color: var(--agx-line);
      background: color-mix(in srgb, var(--g-primary) 8%, transparent);
    }
    .agx .agt-link .agt-link-meta {
      margin-left: auto;
      color: var(--agx-dim);
      font-size: 9px;
      white-space: nowrap;
    }
    .agx .agt-link-text {
      /* min-width:0 is what actually lets a flex child ellipsise. */
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .agx .agt-meter {
      position: relative;
      height: 5px;
      margin-top: 3px;
      background: color-mix(in srgb, var(--g-neutral) 22%, transparent);
      border-radius: 2px;
      overflow: hidden;
    }
    .agx .agt-meter > i {
      position: absolute;
      inset: 0 auto 0 0;
      display: block;
      background: var(--g-success);
    }
    .agx .agt-meter.warn > i {
      background: var(--g-warning);
    }
    .agx .agt-meter.crit > i {
      background: var(--g-danger);
    }
    /* The panel is narrow; a fixed term column keeps label/value on one line
       instead of stacking every row into two. */
    .agx .agt-detail dl {
      grid-template-columns: 88px minmax(0, 1fr);
      gap: 3px 8px;
    }
    .agx .agt-detail dt {
      font-size: 9px;
      line-height: 1.5;
    }
    .agx .agt-detail dd {
      font-size: 10.5px;
      line-height: 1.35;
    }
    .agx .agt-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      margin-bottom: 8px;
    }

    @media (max-width: 1080px) {
      .agx .agx-stage {
        grid-template-columns: minmax(0, 1fr);
      }
    }
  </style>
`;
