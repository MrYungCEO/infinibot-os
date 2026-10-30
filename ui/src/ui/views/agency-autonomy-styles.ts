/**
 * Styles for the delivery/autonomy split board.
 *
 * Additive to `AGENCY_SURFACE_STYLES` — every selector is scoped under `.agx`
 * and reuses that surface's tokens (`--agx-line`, `--agx-radius`, `--agx-dim`)
 * rather than restating colours, so the new board recolours with the theme
 * exactly like the panels it sits between. No raw hex anywhere: every value is
 * a `--g-*` token or a `color-mix()` on one.
 */

import { html } from "lit";

export const AGENCY_AUTONOMY_STYLES = html`
  <style>
    /* ── Mode switch ─────────────────────────────────────── */
    .agx .agx-ops-switch {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px;
      margin: 0;
      padding: 9px 12px;
      border: 1px solid var(--agx-line-soft);
      border-radius: var(--agx-radius);
      background: var(--agx-glass-raised);
      backdrop-filter: var(--agx-blur);
      -webkit-backdrop-filter: var(--agx-blur);
      box-shadow: var(--agx-hairline);
    }
    .agx .agx-ops-switch-title {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
      margin-right: auto;
    }
    .agx .agx-ops-switch-title b {
      color: var(--g-primary);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.16em;
      text-transform: uppercase;
    }
    .agx .agx-ops-switch-title span {
      color: var(--agx-dim);
      font-size: 10px;
      line-height: 1.45;
    }
    .agx .agx-seg {
      display: inline-flex;
      padding: 2px;
      border: 1px solid var(--agx-line);
      border-radius: 999px;
      background: color-mix(in srgb, var(--g-primary) 5%, transparent);
    }
    .agx .agx-seg button {
      appearance: none;
      border: 0;
      cursor: pointer;
      padding: 5px 13px;
      border-radius: 999px;
      background: transparent;
      color: var(--agx-dim);
      font-family: inherit;
      font-size: 9.5px;
      font-weight: 700;
      letter-spacing: 0.13em;
      text-transform: uppercase;
      transition: background 0.16s ease, color 0.16s ease;
    }
    .agx .agx-seg button:hover {
      color: var(--g-fg, #e8e8ee);
    }
    .agx .agx-seg button[aria-pressed="true"] {
      background: color-mix(in srgb, var(--g-primary) 22%, transparent);
      color: var(--g-primary);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.12);
    }
    .agx .agx-seg button:focus-visible {
      outline: 2px solid var(--g-primary);
      outline-offset: 2px;
    }

    /* ── Split layout ────────────────────────────────────── */
    .agx .agx-ops-split {
      display: grid;
      grid-template-columns: 1fr;
      gap: 10px;
      align-items: start;
      min-width: 0;
    }
    .agx .agx-ops-split.is-split {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    }
    /* Grid children must be allowed to shrink or the two horizontally
       scrolling boards push the page into a body-level sideways scroll. */
    .agx .agx-ops-split > * {
      min-width: 0;
    }
    @media (max-width: 1180px) {
      .agx .agx-ops-split.is-split {
        grid-template-columns: 1fr;
      }
    }

    /* ── Delivery toolbar ────────────────────────────────── */
    .agx .agx-dlv-tools {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-end;
      gap: 8px;
      margin: 10px 11px 0;
    }
    .agx .agx-dlv-tools .agx-form-field {
      min-width: 0;
      flex: 1 1 150px;
    }
    .agx .agx-toggle {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      border: 1px solid var(--agx-line-soft);
      border-radius: 999px;
      background: transparent;
      color: var(--agx-dim);
      font-family: inherit;
      font-size: 9.5px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      cursor: pointer;
      white-space: nowrap;
    }
    .agx .agx-toggle[aria-pressed="true"] {
      border-color: color-mix(in srgb, var(--g-primary) 50%, transparent);
      background: color-mix(in srgb, var(--g-primary) 12%, transparent);
      color: var(--g-primary);
    }
    .agx .agx-toggle:focus-visible {
      outline: 2px solid var(--g-primary);
      outline-offset: 2px;
    }

    /* ── Bulk bar ────────────────────────────────────────── */
    .agx .agx-bulk {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      margin: 9px 11px 0;
      padding: 8px 11px;
      border: 1px solid color-mix(in srgb, var(--g-primary) 45%, transparent);
      border-radius: var(--agx-radius-sm);
      background: color-mix(in srgb, var(--g-primary) 12%, transparent);
      color: var(--g-primary);
      font-size: 10.5px;
    }
    .agx .agx-bulk-spacer {
      margin-left: auto;
    }
    /* The shared .authorize button is full-width on a card; in a toolbar row
       that makes it wrap onto a line of its own. */
    .agx .agx-bulk .agx-btn,
    .agx .agx-routebar .agx-btn,
    .agx .agx-dropstrip .agx-btn {
      width: auto;
      flex: 0 0 auto;
    }

    /* ── Autonomy drop strip ─────────────────────────────── */
    .agx .agx-dropstrip {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      margin: 9px 11px 0;
      padding: 10px 12px;
      border: 1px dashed color-mix(in srgb, var(--g-primary) 40%, transparent);
      border-radius: var(--agx-radius-sm);
      background: color-mix(in srgb, var(--g-primary) 4%, transparent);
      color: var(--agx-dim);
      font-size: 10.5px;
      line-height: 1.45;
      transition: border-color 0.16s ease, background 0.16s ease, color 0.16s ease;
    }
    .agx .agx-dropstrip-glyph {
      flex: 0 0 auto;
      font-size: 15px;
      line-height: 1;
      color: color-mix(in srgb, var(--g-primary) 70%, transparent);
    }
    .agx .agx-dropstrip strong {
      color: var(--g-primary);
      font-weight: 600;
    }
    .agx .agx-dropstrip.is-over {
      border-style: solid;
      border-color: var(--g-primary);
      background: color-mix(in srgb, var(--g-primary) 18%, transparent);
      color: var(--g-primary);
    }

    /* ── Routing engine bar ──────────────────────────────── */
    .agx .agx-routebar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      margin: 9px 11px 0;
      padding: 8px 11px;
      border: 1px solid var(--g-info-border, color-mix(in srgb, var(--g-info) 35%, transparent));
      border-radius: var(--agx-radius-sm);
      background: color-mix(in srgb, var(--g-info) 8%, transparent);
      color: var(--agx-dim);
      font-size: 10.5px;
      line-height: 1.45;
    }
    .agx .agx-routebar.is-bad {
      border-color: var(--g-warning-border, color-mix(in srgb, var(--g-warning) 40%, transparent));
      background: var(--g-warning-soft, color-mix(in srgb, var(--g-warning) 10%, transparent));
    }
    .agx .agx-routebar-tag {
      flex: 0 0 auto;
      padding: 2px 8px;
      border: 1px solid var(--g-info-border, color-mix(in srgb, var(--g-info) 40%, transparent));
      border-radius: 999px;
      color: var(--g-info);
      font-size: 8.5px;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .agx .agx-routebar-copy {
      flex: 1 1 220px;
      min-width: 0;
    }
    .agx .agx-routebar-copy strong {
      color: var(--g-info);
      font-weight: 600;
    }
    .agx .agx-routebar-confirm {
      display: inline-flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      padding: 4px 8px;
      border: 1px solid var(--g-warning-border, color-mix(in srgb, var(--g-warning) 45%, transparent));
      border-radius: var(--agx-radius-sm);
      background: var(--g-warning-soft, color-mix(in srgb, var(--g-warning) 12%, transparent));
      color: var(--g-warning);
    }

    /* ── Delivery card ───────────────────────────────────── */
    .agx .agx-dlv-card {
      position: relative;
    }
    .agx .agx-dlv-card.is-selected {
      border-color: color-mix(in srgb, var(--g-primary) 60%, transparent);
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--g-primary) 40%, transparent),
        0 6px 18px rgba(0, 0, 0, 0.4);
    }
    .agx .agx-dlv-head {
      display: flex;
      align-items: flex-start;
      gap: 7px;
      min-width: 0;
    }
    .agx .agx-dlv-head input[type="checkbox"] {
      flex: 0 0 auto;
      margin: 2px 0 0;
      accent-color: var(--g-primary);
      width: 13px;
      height: 13px;
      cursor: pointer;
    }
    .agx .agx-dlv-head .agx-card-title {
      min-width: 0;
      flex: 1 1 auto;
    }

    /* ── Handoff dialog ──────────────────────────────────── */
    /*
     * The shared modal scrolls as one block, which puts the confirm button
     * below the fold on a dialog this tall — the one control the operator must
     * be able to reach deliberately. Pin the title and footer, scroll only the
     * body.
     */
    .agx .agx-modal.agx-handoff {
      display: flex;
      flex-direction: column;
      width: min(760px, 94vw);
      max-height: 88vh;
      overflow: hidden;
    }
    .agx .agx-handoff > h2,
    .agx .agx-handoff > .agx-modal-foot {
      flex: 0 0 auto;
    }
    .agx .agx-handoff > .agx-modal-body {
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
      /* The body is a grid inside a now-definite height. Without this its rows
         share out the shortfall and every scrollable block collapses to
         min-content — which flattened the task list to an empty strip. */
      align-content: start;
    }
    .agx .agx-handoff-list {
      display: flex;
      flex-direction: column;
      gap: 3px;
      max-height: 118px;
      overflow-y: auto;
      padding: 8px 10px;
      border: 1px solid var(--agx-line-soft);
      border-radius: var(--agx-radius-sm);
      background: color-mix(in srgb, var(--g-primary) 3%, transparent);
    }
    .agx .agx-handoff-list span {
      display: block;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--agx-dim);
      font-size: 10px;
    }
    .agx .agx-cands {
      display: flex;
      flex-direction: column;
      gap: 6px;
      max-height: 214px;
      overflow-y: auto;
      padding-right: 2px;
    }
    .agx .agx-cand {
      display: flex;
      align-items: flex-start;
      gap: 9px;
      min-width: 0;
      padding: 9px 11px;
      border: 1px solid var(--agx-line-soft);
      border-radius: var(--agx-radius-sm);
      background: color-mix(in srgb, var(--g-primary) 2.5%, transparent);
      cursor: pointer;
      transition: border-color 0.16s ease, background 0.16s ease;
    }
    .agx .agx-cand:hover {
      border-color: var(--agx-line);
    }
    .agx .agx-cand:focus-within {
      outline: 2px solid var(--g-primary);
      outline-offset: 2px;
    }
    .agx .agx-cand.is-picked {
      border-color: color-mix(in srgb, var(--g-primary) 60%, transparent);
      background: color-mix(in srgb, var(--g-primary) 10%, transparent);
    }
    .agx .agx-cand input[type="radio"] {
      flex: 0 0 auto;
      margin: 2px 0 0;
      accent-color: var(--g-primary);
    }
    .agx .agx-cand-body {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 0;
      flex: 1 1 auto;
    }
    .agx .agx-cand-name {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 6px;
      color: var(--g-fg, #e8e8ee);
      font-size: 11px;
    }
    .agx .agx-cand-name em {
      color: var(--agx-dim);
      font-style: normal;
      font-size: 10px;
    }
    .agx .agx-cand-why {
      color: var(--agx-dim);
      font-size: 9.5px;
      line-height: 1.4;
      overflow-wrap: anywhere;
    }
    .agx .agx-cand-rank {
      flex: 0 0 auto;
      align-self: center;
      padding: 2px 8px;
      border: 1px solid var(--agx-line);
      border-radius: 999px;
      color: var(--agx-dim);
      font-size: 9px;
      letter-spacing: 0.08em;
      white-space: nowrap;
    }
    .agx .agx-cand.is-top .agx-cand-rank {
      border-color: color-mix(in srgb, var(--g-success) 45%, transparent);
      background: var(--g-success-soft, transparent);
      color: var(--g-success);
    }

    /* Autonomy consequence chip — same vocabulary as the employee cards. */
    .agx .agx-autonomy {
      display: inline-flex;
      align-items: baseline;
      gap: 6px;
      padding: 1px 8px;
      border: 1px solid var(--g-neutral-border, var(--agx-line));
      border-radius: 999px;
      font-size: 8.5px;
      letter-spacing: 0.06em;
      white-space: nowrap;
    }
    .agx .agx-autonomy b {
      font-weight: 700;
      text-transform: uppercase;
    }
    .agx .agx-autonomy i {
      font-style: normal;
      opacity: 0.85;
      text-transform: none;
      letter-spacing: 0.02em;
    }
    .agx .agx-autonomy.neutral {
      color: var(--g-neutral, var(--agx-dim));
    }
    .agx .agx-autonomy.info {
      color: var(--g-info);
      border-color: var(--g-info-border, color-mix(in srgb, var(--g-info) 40%, transparent));
      background: var(--g-info-soft, transparent);
    }
    .agx .agx-autonomy.warning {
      color: var(--g-warning);
      border-color: var(--g-warning-border, color-mix(in srgb, var(--g-warning) 40%, transparent));
      background: var(--g-warning-soft, transparent);
    }
    .agx .agx-autonomy.danger {
      color: var(--g-danger);
      border-color: var(--g-danger-border, color-mix(in srgb, var(--g-danger) 40%, transparent));
      background: var(--g-danger-soft, transparent);
    }
    .agx .agx-autonomy.unknown {
      color: var(--agx-dim);
      border-style: dashed;
    }

    /* ── Routing preview ─────────────────────────────────── */
    .agx .agx-routing {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 9px 11px;
      border: 1px solid var(--agx-line-soft);
      border-radius: var(--agx-radius-sm);
      background: color-mix(in srgb, var(--g-info) 6%, transparent);
    }
    .agx .agx-routing-head {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 6px;
      color: var(--g-info);
      font-size: 9.5px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      font-weight: 700;
    }
    .agx .agx-routing-rows {
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-height: 150px;
      overflow-y: auto;
    }
    .agx .agx-routing-row {
      display: grid;
      grid-template-columns: minmax(0, 1.1fr) minmax(0, 0.7fr) minmax(0, 1.4fr);
      gap: 8px;
      color: var(--agx-dim);
      font-size: 9.5px;
      line-height: 1.4;
    }
    .agx .agx-routing-row > * {
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .agx .agx-routing-row b {
      color: var(--g-fg, #e8e8ee);
      font-weight: 500;
    }

    .agx .agx-progress {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--g-primary);
      font-size: 10px;
    }
    .agx .agx-progress-track {
      flex: 1 1 auto;
      height: 4px;
      min-width: 80px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--g-primary) 18%, transparent);
      overflow: hidden;
    }
    .agx .agx-progress-fill {
      height: 100%;
      border-radius: 999px;
      background: var(--g-primary);
      transition: width 0.2s ease;
    }
  </style>
`;
