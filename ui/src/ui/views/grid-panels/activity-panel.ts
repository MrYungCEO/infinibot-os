/**
 * Grid-panel renderer for the Activity feed.
 *
 * Parity goal: this embedded panel is a *compact* version of the standalone
 * Activity page (`views/agent-activity.ts` → `renderAgentActivity`). Rather
 * than fork a second, simpler feed, it renders the EXACT same body the
 * standalone page uses — `renderAgentDashboard(...)` from
 * `views/agent-activity-dashboard.ts` — reading the same `agentActivityState`
 * store. That guarantees true parity in layout, item rendering, realtime
 * updates, and style. The only things trimmed to fit a bounded grid cell are
 * the advanced chrome (poll-interval picker, mesh feed, recently-finished feed,
 * sub-agent history panels); those stay one click away behind "FULL →".
 *
 * Shared building blocks are imported from the standalone view (header health
 * badge, error banner with retry, focused chat modal) instead of being
 * copy-pasted, so the two surfaces can never visually drift.
 *
 * The panel kicks off the activity-store polling via `ensureActivityPanelData`
 * on first render, listens for `infinibot:grid-panel-refresh` to force-reload,
 * and exposes its scroll container under `data-grid-scroll="<panelId>"` so
 * A4's ui_control bus can drive `grid:scroll_panel`.
 */

import { html, nothing, type TemplateResult } from "lit";
import type { GridPanel } from "../../controllers/masonry-grid";
import type { GatewayBrowserClient } from "../../gateway";
import type { AppViewState } from "../../app-view-state";
import { ensureActivityPanelData } from "../activity-panel";
import {
  loadAgentActivity,
  isClaudeCoder,
} from "../../controllers/agent-activity";
import {
  HUD,
  SESSION_TYPE_BADGES,
  getSessionType,
  renderHealthBadge,
  renderErrorBanner,
  renderChatModal,
} from "../agent-activity";
import { renderAgentDashboard } from "../agent-activity-dashboard";
import {
  mountSubagentDetailListener,
  openSubagentDetailModal,
} from "../../components/subagent-detail-modal";
import { t } from "../../i18n";
// Register the <subagent-activity-panel> custom element + reuse the SAME
// recently-completed singleton store the standalone page / dashboard use, so
// the two top feeds stay row-for-row identical and update in the same tick.
import "../../components/subagent-activity-panel";
import {
  loadRecentlyCompleted,
  subscribeRecentCompleted,
  getRecentlyCompletedTodayCount,
  renderRecentlyCompletedCardList,
} from "../recently-completed-feed";
import {
  ensurePanelWiring,
  findScrollElInPanel,
  panelLoading,
} from "./_shared";

const _initByPanel = new Map<string, boolean>();

export function renderGridActivityPanel(
  panel: GridPanel,
  state: AppViewState,
  client: GatewayBrowserClient,
): TemplateResult {
  // First-render bootstrap: kick activity polling, wire events.
  if (!_initByPanel.get(panel.id)) {
    _initByPanel.set(panel.id, true);
    // Defer to microtask so the event-loop is unblocked and the DOM is mounted
    // (findScrollElInPanel needs the rendered scroll container).
    queueMicrotask(() => {
      void ensureActivityPanelData(state).then(() => state.requestUpdate?.());
      // Top "Completed tasks" feed reads the recently-completed singleton store.
      // Kick its load + WS subscription here so the section populates even if
      // the dashboard below hasn't initialised it yet (both share one store).
      if (client) {
        void loadRecentlyCompleted(client, () => state.requestUpdate?.());
        subscribeRecentCompleted(client);
      }
      ensurePanelWiring(panel.id, {
        onRefresh: () => {
          if (client) {
            void loadAgentActivity(state, client).then(() => state.requestUpdate?.());
          }
        },
        scrollEl: () => findScrollElInPanel(panel.id, document),
      });
    });
  }

  // Idempotent: wire the global "infinibot:subagent-open-detail" event so the
  // dashboard's running-agent cards open the shared detail modal even when the
  // standalone Activity page hasn't been mounted this session.
  if (client) mountSubagentDetailListener(client, () => state.requestUpdate?.());

  // Honor needsRefresh — fired by `refreshPanel()` from the controller. We
  // re-load and clear the flag so the next render is a no-op.
  if (panel.needsRefresh && client) {
    void loadAgentActivity(state, client).then(() => state.requestUpdate?.());
    panel.needsRefresh = false;
  }

  const as = state.agentActivityState;

  // Until the store exists / client is wired we can't render the dashboard.
  if (!as || !client) {
    return html`
      <div style="
        display:flex; flex-direction:column; height:100%; min-height:0; width:100%;
        background:${HUD.bg}; font-family:${HUD.mono};
      ">
        ${renderHeader(panel, state, client, 0, 0, 0, 0, 0)}
        <div
          data-grid-scroll=${panel.id}
          style="position:relative; flex:1; min-height:0; overflow:auto;"
        >
          ${panelLoading("Connecting activity feed…")}
        </div>
      </div>
    `;
  }

  const sessions = as.sessions;
  const activeCount = sessions.filter((s) => s.active).length;
  const nativeCount = sessions.filter((s) => getSessionType(s) === "native").length;
  const subCount = sessions.filter((s) => s.kind === "subagent").length;
  const coderCount = sessions.filter((s) => isClaudeCoder(s)).length;
  const externalCount = sessions.filter((s) => getSessionType(s) === "external").length;

  return html`
    <div style="
      display:flex; flex-direction:column;
      height:100%; min-height:0; width:100%;
      background:${HUD.bg};
      font-family:${HUD.mono};
    ">
      ${renderHeader(
        panel,
        state,
        client,
        activeCount,
        nativeCount,
        subCount,
        coderCount,
        externalCount,
      )}

      <!-- Error banner with retry (shared with the standalone page) -->
      ${as.error
        ? html`<div style="padding:8px 10px 0;">${renderErrorBanner(state, client, as)}</div>`
        : nothing}

      <!-- Scroll container — A4 finds this by data-grid-scroll. Holds the SAME
           dashboard body the standalone Activity page renders. -->
      <div
        data-grid-scroll=${panel.id}
        style="
          position:relative; flex:1; min-height:0;
          overflow:auto; padding:10px 12px;
          scrollbar-width: thin;
          scrollbar-color: color-mix(in srgb, var(--g-primary) 30%, transparent) transparent;
        "
      >
        <!-- ── Top feeds: Subagents → Completed tasks ──────────────
             Same components/store the standalone Activity page uses, so the
             two surfaces render row-for-row identically and update together. -->
        ${renderTopFeeds(state, client)}

        ${renderAgentDashboard({
          as,
          kanbanTasks: state.kanbanTasks ?? [],
          kanbanProjects: state.kanbanProjects ?? [],
          client,
          state,
          onNavigateToKanban: (projectId: string) => {
            state.kanbanSelectedProjectId = projectId;
            state.setTab?.("kanban" as never);
            state.requestUpdate?.();
          },
        })}
      </div>
    </div>

    <!-- Focused chat modal — shared with the standalone page. Rendered here so
         openChatModal() (triggered from shared card affordances) works while the
         grid view is active. Mounts only when a session is selected. -->
    ${as.modalKey ? renderChatModal(state, client, as) : nothing}

    <!-- Keyframes the shared renderers reference. The dashboard injects its own
         iad-* keyframes; these cover the hud-* set used by the header badge,
         error banner, and chat modal. -->
    <style>
      @keyframes hud-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
      @keyframes hud-fade { from { opacity: 0; } to { opacity: 1; } }
      @keyframes hud-slide { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
      @keyframes modal-slide-in { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
      @media (prefers-reduced-motion: reduce) {
        @keyframes modal-slide-in { from { opacity: 0; } to { opacity: 1; } }
        @keyframes hud-pulse { from { opacity: 1; } to { opacity: 1; } }
        @keyframes hud-fade { from { opacity: 1; } to { opacity: 1; } }
      }
    </style>
  `;
}

// ─────────────────────────────────────────────────────────────
// Top feeds — Subagents → Completed tasks.
//
// Both reuse the EXACT building blocks the standalone Activity page uses:
//   • <subagent-activity-panel> (header-less here; we supply the section
//     header) — same poll/merge/WS pipeline, same card rows.
//   • renderRecentlyCompletedCompactList — the same `renderCompactRow` the
//     dashboard's "Recently Completed" feed renders, off the same singleton
//     store. So a subagent transition or a completed task updates this panel
//     and the standalone page in the same tick.
// ─────────────────────────────────────────────────────────────

function renderFeedSectionHeader(
  title: string,
  count: number,
  onSeeAll: () => void,
): TemplateResult {
  return html`
    <div style="
      display:flex; align-items:center; gap:8px;
      padding-bottom:8px; margin-bottom:8px;
      border-bottom:1px solid ${HUD.goldBorder};
    ">
      <span style="
        font-size:10px; font-weight:700; color:${HUD.gold};
        letter-spacing:0.15em; text-transform:uppercase;
      ">${title}</span>
      <span style="
        font-size:9px; padding:1px 7px; border-radius:3px;
        border:1px solid ${HUD.goldBorder}; color:${HUD.goldDim};
        letter-spacing:0.06em;
      ">${count}</span>
      <div style="flex:1;"></div>
      <button
        title="Open the full Activity page"
        @click=${onSeeAll}
        style="
          padding:1px 6px; background:transparent; border:none;
          color: color-mix(in srgb, var(--g-primary) 80%, #aaa);
          font-size:9px; cursor:pointer; font-family:${HUD.mono};
          letter-spacing:0.06em;
        "
      >${t("activity.grid.seeAll", undefined, "See all →")}</button>
    </div>
  `;
}

function renderTopFeeds(
  state: AppViewState,
  client: GatewayBrowserClient,
): TemplateResult {
  const as = state.agentActivityState;
  const openActivity = () => {
    state.setTab?.("activity" as never);
    state.requestUpdate?.();
  };

  // Subagents: live count of running sub-agent sessions from the shared store.
  const subRunning = as
    ? as.sessions.filter((s) => s.kind === "subagent" && s.active).length
    : 0;
  const completedToday = getRecentlyCompletedTodayCount();

  const liveSessions = as
    ? new Map(as.sessions.map((s) => [s.key, s]))
    : new Map();

  // In the grid activity panel a completed-task click should mirror what
  // clicking a subagent card does in the Subagents section: open the focus
  // modal in-place. The standalone /activity page still navigates to kanban
  // — this only changes behaviour for the embedded grid panel.
  // Synthetic sentinels emitted by the shared empty-state CTA (e.g. "__spawn__"
  // or "__project__") carry no real task; they fall through to the full
  // Activity page or stay on the kanban tab as before.
  const onNavigateCompleted = (taskId: string, projectId: string | null) => {
    if (taskId === "__project__") {
      if (projectId) state.kanbanSelectedProjectId = projectId;
      state.setTab?.("kanban" as never);
      state.requestUpdate?.();
      return;
    }
    if (taskId.startsWith("__")) {
      openActivity();
      state.requestUpdate?.();
      return;
    }
    if (!client) return;
    openSubagentDetailModal({
      client,
      requestUpdate: () => state.requestUpdate?.(),
      kanbanTaskId: taskId,
    });
  };

  return html`
    <div style="display:flex; flex-direction:column; gap:16px; margin-bottom:16px;">
      <!-- ── Subagents ─────────────────────────────────────────── -->
      <div>
        ${renderFeedSectionHeader(
          t("activity.grid.subagents", undefined, "Subagents"),
          subRunning,
          openActivity,
        )}
        <subagent-activity-panel
          .gateway=${client}
          .hideHeader=${true}
          .pollIntervalMs=${3000}
          .limit=${5}
          .liveSessions=${liveSessions}
        ></subagent-activity-panel>
      </div>

      <!-- ── Completed tasks — card list matching the full Activity page ── -->
      <div>
        ${renderFeedSectionHeader(
          t("activity.grid.completedTasks", undefined, "Completed tasks"),
          completedToday,
          openActivity,
        )}
        ${renderRecentlyCompletedCardList(5, onNavigateCompleted)}
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────
// Compact header — a condensed mirror of the standalone page's
// header bar: title + LIVE pill, session-type counts, health
// badge, SYNC, and a FULL → affordance into the full Activity page.
// ─────────────────────────────────────────────────────────────

function renderHeader(
  _panel: GridPanel,
  state: AppViewState,
  client: GatewayBrowserClient | null,
  activeCount: number,
  nativeCount: number,
  subCount: number,
  coderCount: number,
  externalCount: number,
): TemplateResult {
  const as = state.agentActivityState;
  const total = as?.sessions.length ?? 0;

  return html`
    <div style="
      flex-shrink:0;
      display:flex; flex-direction:column; gap:6px;
      padding:8px 12px;
      border-bottom:1px solid ${HUD.goldBorder};
      background:${HUD.bgCard};
    ">
      <!-- Row 1: title + counts + health -->
      <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
        <span style="
          font-size:10px; font-weight:700; color:${HUD.gold};
          letter-spacing:0.15em; text-transform:uppercase;
        ">AGENT ACTIVITY</span>
        ${activeCount > 0 ? html`
          <span style="
            border:1px solid ${HUD.active}; color:${HUD.active};
            font-size:8px; padding:1px 6px; letter-spacing:0.1em;
            font-weight:600; animation: hud-pulse 2s infinite;
          ">${activeCount} LIVE</span>
        ` : nothing}
        ${as ? renderHealthBadge(as) : nothing}
      </div>

      <!-- Row 2: session-type counts (mirrors the standalone breakdown) -->
      <div style="
        display:flex; align-items:center; gap:8px; flex-wrap:wrap;
        font-size:9px; color:${HUD.textDim}; letter-spacing:0.05em;
      ">
        <span>${total} SESSION${total !== 1 ? "S" : ""}</span>
        <span style="color:${SESSION_TYPE_BADGES.native.color};">${SESSION_TYPE_BADGES.native.icon} ${nativeCount}</span>
        <span style="color:${SESSION_TYPE_BADGES.subagent.color};">${SESSION_TYPE_BADGES.subagent.icon} ${subCount}</span>
        ${coderCount > 0 ? html`
          <span
            title="Toggle filter to coder runs"
            style="color:${SESSION_TYPE_BADGES.coder.color}; cursor:pointer; text-decoration:${as?.showCoderOnly ? "underline" : "underline dotted"};"
            @click=${() => { if (as) { as.showCoderOnly = !as.showCoderOnly; state.requestUpdate?.(); } }}
          >${SESSION_TYPE_BADGES.coder.icon} ${coderCount}${as?.showCoderOnly ? " ◉" : ""}</span>
        ` : nothing}
        ${externalCount > 0 ? html`
          <span style="color:${SESSION_TYPE_BADGES.external.color};">${SESSION_TYPE_BADGES.external.icon} ${externalCount}</span>
        ` : nothing}

        <div style="flex:1;"></div>

        <button
          title="Refresh activity"
          ?disabled=${as?.loading}
          @click=${async () => {
            if (client && as) {
              await loadAgentActivity(state, client);
              state.requestUpdate?.();
            }
          }}
          style="
            padding:2px 8px; background:transparent;
            border:1px solid ${HUD.goldBorder}; color:${HUD.goldDim};
            font-size:9px; cursor:pointer; font-family:${HUD.mono};
            letter-spacing:0.08em;
          "
        >${as?.loading ? "…" : "↻"} SYNC</button>

        <button
          title="Open the full Activity page"
          @click=${() => {
            state.setTab?.("activity" as never);
            state.requestUpdate?.();
          }}
          style="
            padding:2px 8px; background:transparent;
            border:1px solid color-mix(in srgb, var(--g-primary) 25%, transparent);
            color: color-mix(in srgb, var(--g-primary) 80%, #aaa);
            font-size:9px; cursor:pointer; font-family:${HUD.mono};
            letter-spacing:0.08em;
          "
        >FULL →</button>
      </div>
    </div>
  `;
}
