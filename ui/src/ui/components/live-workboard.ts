/**
 * Live Workboard — the delivery ⇄ autonomy split board, packaged for reuse.
 *
 * The board that lives on Daily Operations (the full projects kanban on the
 * left, the autonomous work board on the right, the handoff bridge between
 * them) is not specific to that page. This module wraps it in a single
 * `renderLiveWorkboard(host, client)` call so the exact same surface — same data
 * source (`kanban.projects.list` / `kanban.tasks.list`, the full project
 * database), same drag-to-assign, same detail modals — can be dropped into any
 * view that carries an app host.
 *
 * It composes rather than reimplements: the autonomy half is the Daily board's
 * own `renderBoard`, and the delivery half + mode switch + handoff dialog come
 * from `renderAutonomyCommand`. The surface styles are emitted here so the board
 * looks right wherever it is embedded, even on a page that does not otherwise
 * pull them in.
 */

import { html, nothing, type TemplateResult } from "lit";

import type { GatewayBrowserClient } from "../gateway";
import { renderBoard } from "../views/agency-daily";
import { renderAutonomyCommand } from "../views/agency-autonomy-board";
import { AGENCY_SURFACE_STYLES } from "../views/agency-surface-styles";
import {
  ensureAgencyDailyState,
  loadAgencyDaily,
  subscribeAgencyWorkUpdates,
  type AgencyDailyHost,
} from "../controllers/agency-daily";
import type { AgencyAutonomyHost } from "../controllers/agency-autonomy-board";

export interface LiveWorkboardOptions {
  /**
   * Include the autonomous work board half. Default `true` (full split). Set
   * `false` to embed only the delivery kanban + handoff bridge — the compact
   * form intended for a section beneath another page's primary content.
   */
  autonomy?: boolean;
  /** Optional heading rendered above the board. */
  title?: string;
}

/** The host needs both controllers' state bags; the app element carries both. */
export type LiveWorkboardHost = AgencyDailyHost & AgencyAutonomyHost;

/**
 * Renders the live workboard into any host. Idempotent and self-loading: it
 * ensures the Daily state exists, subscribes to `agency.work.updated`, and
 * kicks off the first load if nothing has loaded yet — so a caller only has to
 * drop the one call in and the board hydrates itself from live system data.
 */
export function renderLiveWorkboard(
  host: LiveWorkboardHost,
  client: GatewayBrowserClient,
  options: LiveWorkboardOptions = {},
): TemplateResult {
  const state = ensureAgencyDailyState(host);
  // The autonomy half reads the Daily work-item feed; keep it live and loaded.
  subscribeAgencyWorkUpdates(host, client);
  if (!state.lastLoadedAt && !state.loading) {
    queueMicrotask(() => void loadAgencyDaily(host, client));
  }

  const autonomyHalf =
    options.autonomy === false
      ? () => html`${nothing}`
      : () => renderBoard(host, state, client);

  return html`
    ${AGENCY_SURFACE_STYLES}
    <section class="agx agx-live-workboard">
      ${options.title
        ? html`<header class="agx-head">
            <div><h1>${options.title}</h1></div>
          </header>`
        : nothing}
      ${renderAutonomyCommand(host, client, autonomyHalf)}
    </section>
  `;
}
