/**
 * Autonomy Dashboard View — Sleek Black & Gold Theme
 * Full ASOP integration with HUD-style design language.
 */

import { html, nothing, TemplateResult } from 'lit';
import { live } from 'lit/directives/live.js';
import { icons } from '../icons';
import {
  AutonomyDashboardState,
  QueuedTask,
  AuditEntry,
  ActivityEntry,
  TaskActivity,
  formatDuration,
  formatTimestamp,
  formatTimestampPrecise,
  formatTimeAgo,
  describePhase,
  getPriorityColor,
  getStatusColor,
  getOutcomeColor,
} from '../controllers/autonomy.js';
import type { KanbanProject, KanbanTask } from '../types';
import type { GatewayBrowserClient } from '../gateway';
import './autonomy-goals';
import './autonomy-phases';
import './autonomy-scheduled';
import { glassAgentsStyle, glassAurora, glassEmpty } from './glass-agents-shared';
import { AUTONOMY_GLASS_CSS } from './glass-autonomy.css';

// =============================================================================
// TYPES
// =============================================================================

interface ExtendedTask extends QueuedTask {
  /** 'goal' for goal-mode tasks (orchestrator + sub-agents). */
  kind?: string;
  autonomousStatus?: string;
  preflightComplete?: boolean;
  partnerContact?: {
    channel: string;
    lastContact?: number;
    pendingQuestions: string[];
  };
  context?: {
    projectId?: string;
    projectName?: string;
    isNewProject?: boolean;
  };
  brief?: {
    scope: string;
    successCriteria: string;
    requirements: { clarifications: string[] };
  };
}

interface ContinuousDaemonRow {
  runId: string;
  workflowId: string;
  workflowName?: string;
  paused: boolean;
  iterationCount: number;
  errorStreak: number;
  stopReason?: string;
}

interface ExtendedAutonomyState extends AutonomyDashboardState {
  selectedTaskId?: string;
  partnerMessages?: any[];
  kanbanAutonomousTasks?: ExtendedTask[];
  kanbanProjects?: KanbanProject[];
  kanbanTasks?: KanbanTask[];
  partnerChannel?: string | null;
  notificationsPending?: number;
  /** Live continuous workflow daemons — fed by the workflows controller. */
  liveDaemons?: ContinuousDaemonRow[];
  /** Telegram connectivity snapshot for the header status chip. */
  telegramStatus?: {
    configured: boolean;
    hasBotToken: boolean;
    hasChatId: boolean;
    chatIdMasked: string | null;
  };
  /** Last Telegram test/reconnect result surfaced to the operator. */
  telegramTestResult?: { ok: boolean; error?: string; description?: string };
}

interface AutonomyHandlers {
  /** Gateway client for the Goals view (goals.* RPCs + goal.* events). */
  client?: GatewayBrowserClient | null;
  onPause: () => void;
  onResume: () => void;
  onApprove: (taskId: string) => void;
  onCancel: (taskId: string) => void;
  onRefresh: () => void;
  onTabChange: (tab: AutonomyDashboardState['selectedTab']) => void;
  /** @deprecated header test button removed — Telegram chip has Test. */
  onTestNotification?: () => void;
  /** Send a real Telegram test message and surface the API result. */
  onTestTelegram?: () => void;
  /** Reload + re-apply Telegram config to the live notifier, then test it. */
  onReconnectTelegram?: () => void;
  onSelectTask?: (taskId: string | null) => void;
  onOpenCreateDialog?: () => void;
  onCloseCreateDialog?: () => void;
  onCreateDraftChange?: (
    patch: Partial<{
      title: string;
      description: string;
      priority: 'critical' | 'high' | 'normal' | 'low';
      requiresApproval: boolean;
      executionMode: 'gateway' | 'terminal';
      cli: 'claude' | 'opencode' | 'gemini' | 'grok';
      cwd: string;
      isGoal: boolean;
      goalText: string;
      backend: any;
    }>,
  ) => void;
  onSubmitCreate?: () => void;
  /** Load the configured default-backend (from gateway config) into state.
   *  Called when the settings tab opens. */
  onLoadDefaultBackend?: () => void;
  /** Persist a new default-backend to gateway config. */
  onSaveDefaultBackend?: (backend: any) => void;
  onQueueKanbanTask?: (task: KanbanTask, project?: KanbanProject) => void;
  onSyncToKanban?: (taskId: string) => void;
  onLinkToKanban?: (taskId: string, kanbanTaskId: string) => void;
  onOpenKanban?: () => void;
  onRefreshKanban?: () => void;
  onVerifyChain?: () => void;
  onAuditSearchChange?: (q: string) => void;
  onConfigureChannels?: () => void;
  onRetryNotifications?: () => void;
  /** Switch to the Terminals tab and focus the given PTY. Used by the
   *  detail panel's "Live Session" block when a task was spawned in
   *  terminal mode. */
  onOpenTerminal?: (terminalId: string) => void;
  /** Switch the chat view to the given session key. Used by the detail
   *  panel for gateway-mode tasks so the operator can read the builder
   *  or tester transcript inline. */
  onOpenSession?: (sessionKey: string) => void;
  /** Save pre-fire questionnaire answers (and optionally mark completed). */
  onSavePrefire?: (
    taskId: string,
    prefire: {
      successCriteria: string;
      testTargets: Array<{ description: string; url?: string; selector?: string; expect?: string }>;
      maxIterations: number;
      testerEnabled: boolean;
      builderAgentId?: string;
      testerAgentId?: string;
      notes?: string;
      completed: boolean;
    },
  ) => void;
  /** Start the closed loop on a task that has a completed pre-fire. */
  onStartLoop?: (taskId: string) => void;
  /** Ask the agent to draft a custom dynamic pre-fire form. */
  onGeneratePrefireForm?: (taskId: string) => void;
  /** Persist dynamic-form answers + re-run agent readiness check. */
  onSavePrefireForm?: (taskId: string, answers: Record<string, unknown>) => void;
  /** Operator override — mark the dynamic form ready without LLM verdict. */
  onMarkPrefireReady?: (taskId: string) => void;
  /** Stop a continuous workflow daemon by its parent runId. */
  onStopContinuous?: (runId: string) => void;
  /** Pause a continuous workflow daemon by its parent runId. */
  onPauseContinuous?: (runId: string) => void;
  /** Resume a paused continuous workflow daemon by its parent runId. */
  onResumeContinuous?: (runId: string) => void;
  /** Force-refresh the task activity log for a specific task. */
  onRefreshActivity?: (taskId: string) => void;
  /** Persist the prefireRequired flag for a task (true = form required, false = skip). */
  onSetPrefireRequired?: (taskId: string, required: boolean) => void;
}

// Module-level draft storage — survives Lit re-renders and autonomy-status polls.
const prefireFormDraftsByTaskId = new Map<string, Record<string, any>>();
const prefireLegacyDraftsByTaskId = new Map<string, any>();

export function clearPrefireDraft(taskId: string): void {
  prefireFormDraftsByTaskId.delete(taskId);
  prefireLegacyDraftsByTaskId.delete(taskId);
}

// =============================================================================
// MAIN DASHBOARD
// =============================================================================

export function renderAutonomyDashboard(
  state: AutonomyDashboardState,
  handlers: AutonomyHandlers
): TemplateResult {
  const extState = state as ExtendedAutonomyState;
  
  if (state.loading) {
    return html`
      <div class="auto-dashboard auto-v2 gt-scope ga-autonomy" aria-busy="true">
        ${glassAgentsStyle(AUTONOMY_GLASS_CSS)}
        ${glassAurora()}
        <div class="ga-auto-skel-hero">
          <div class="gt-skel ga-auto-skel-line" style="width:140px"></div>
          <div class="gt-skel ga-auto-skel-title"></div>
          <div class="gt-skel ga-auto-skel-line" style="width:min(420px, 90%)"></div>
        </div>
        <div class="gt-skel ga-auto-skel-tabs"></div>
        <div class="ga-auto-skel-grid">
          <div class="gt-skel"></div>
          <div class="gt-skel"></div>
        </div>
        <span class="sr-only" role="status">Initializing autonomous systems…</span>
      </div>
    `;
  }

  if (state.error) {
    return html`
      <div class="auto-dashboard auto-v2 gt-scope ga-autonomy">
        ${glassAgentsStyle(AUTONOMY_GLASS_CSS)}
        ${glassAurora()}
        <div class="ga-auto-state auto-error" role="alert">
          ${glassEmpty({
            icon: icons.alertCircle,
            title: "Autonomy is unreachable",
            sub: state.error,
            action: html`<button class="auto-btn gold" @click=${handlers.onRefresh}>${icons.refresh} Retry</button>`,
          })}
        </div>
      </div>
    `;
  }

  const isPaused = state.pauseState.isPaused;
  const tab = state.selectedTab;
  const section: 'goals' | 'phases' | 'scheduled' | 'tasks' | 'activity' | 'settings' =
    tab === 'goals' ? 'goals'
      : tab === 'phases' ? 'phases'
      : tab === 'scheduled' ? 'scheduled'
      : tab === 'audit' || tab === 'api' ? 'activity'
      : tab === 'settings' ? 'settings'
      : 'tasks';
  const taskCount = state.pendingTasks.length + (state.runningTask ? 1 : 0);
  const navItems: Array<{ id: typeof section; label: string; tab: AutonomyDashboardState['selectedTab']; icon: TemplateResult; badge?: number }> = [
    { id: 'goals', label: 'Goals', tab: 'goals', icon: icons.target },
    { id: 'phases', label: 'Phases', tab: 'phases', icon: icons.layers },
    { id: 'scheduled', label: 'Scheduled', tab: 'scheduled', icon: icons.calendar },
    { id: 'tasks', label: 'Tasks & approvals', tab: 'overview', icon: icons.kanban, badge: taskCount },
    { id: 'activity', label: 'Activity', tab: 'audit', icon: icons.activity },
    { id: 'settings', label: 'Settings', tab: 'settings', icon: icons.sliders },
  ];

  return html`
    <div class="auto-dashboard auto-v2 gt-scope ga-autonomy">
      ${glassAgentsStyle(AUTONOMY_GLASS_CSS)}
      ${glassAurora()}
      <header class="auto-v2-head ga-auto-hero" data-learn-id="autonomy-header">
        <div class="ga-auto-hero-copy">
          <span class="gt-eyebrow">Autonomous operations</span>
          <div class="auto-v2-title">
            <h1 class="gt-title">Autonomy</h1>
          </div>
          <p class="gt-sub">Goals, phased queues and scheduled reviews that keep working until every check passes.</p>
          <div class="ga-auto-status">
            <span class="gt-chip auto-v2-pill ${isPaused ? 'paused' : 'active'}" data-tone=${isPaused ? 'warn' : 'ok'}>
              <i class="gt-light" data-state=${isPaused ? 'warn' : 'ok'} ?data-pulse=${!isPaused}></i>${isPaused ? 'Paused' : 'Active'}
            </span>
            ${state.runningTask
              ? html`<span class="gt-chip auto-v2-pill running" data-tone="gold"><i class="gt-light" data-state="gold" data-pulse></i>Task executing</span>`
              : nothing}
            ${taskCount > 0
              ? html`<span class="gt-chip">${taskCount} in queue</span>`
              : nothing}
          </div>
        </div>
        <div class="auto-v2-actions">
          ${renderTelegramChip(extState, handlers)}
          <button class="auto-v2-btn icon" @click=${handlers.onRefresh} title="Refresh" aria-label="Refresh">${icons.refresh}</button>
          ${isPaused
            ? html`<button class="auto-v2-btn primary" data-learn-id="autonomy-pause" @click=${handlers.onResume} title="Resume autonomous task execution">${icons.play} Resume</button>`
            : html`<button class="auto-v2-btn" data-learn-id="autonomy-pause" @click=${handlers.onPause} title="Pause autonomous task execution">${icons.pause} Pause</button>`}
        </div>
      </header>

      <nav class="auto-v2-nav" role="tablist" aria-label="Autonomy sections" data-learn-id="autonomy-tabs">
        ${navItems.map((n) => html`
          <button
            role="tab"
            aria-selected=${section === n.id ? 'true' : 'false'}
            class="auto-v2-tab ${section === n.id ? 'on' : ''}"
            data-learn-id="autonomy-tab-${n.id}"
            @click=${() => handlers.onTabChange(n.tab)}
          >
            ${n.icon}${n.label}${n.badge ? html`<span class="auto-v2-badge">${n.badge}</span>` : nothing}
          </button>
        `)}
      </nav>

      ${section === 'goals' ? html`
        <autonomy-goals-view .client=${handlers.client ?? null} .connected=${Boolean(handlers.client)}></autonomy-goals-view>
      ` : nothing}

      ${section === 'phases' ? html`
        <autonomy-phases-view .client=${handlers.client ?? null} .connected=${Boolean(handlers.client)}></autonomy-phases-view>
      ` : nothing}

      ${section === 'scheduled' ? html`
        <autonomy-scheduled-view .client=${handlers.client ?? null} .connected=${Boolean(handlers.client)}></autonomy-scheduled-view>
      ` : nothing}

      ${section === 'tasks' ? html`
        <div class="auto-v2-subbar">
          <div class="auto-v2-subtabs gt-seg" role="tablist" aria-label="Tasks view">
            ${(['overview', 'projects'] as const).map((t) => html`
              <button role="tab" aria-selected=${tab === t ? 'true' : 'false'} class="auto-v2-subtab ${tab === t ? 'on' : ''}" @click=${() => handlers.onTabChange(t)}>
                ${t === 'overview' ? 'Overview' : 'Projects'}
                ${t === 'projects' && (extState.kanbanProjects?.length ?? 0) > 0 ? html`<span class="auto-v2-badge">${extState.kanbanProjects!.length}</span>` : nothing}
              </button>
            `)}
          </div>
          <button class="auto-v2-btn primary" data-learn-id="autonomy-new-task" @click=${() => handlers.onOpenCreateDialog?.()} title="Queue a build/test task with pre-fire approval">${icons.plus} New task</button>
        </div>
        <div class="auto-grid">
          <div class="auto-panel auto-queue-panel" data-learn-id="autonomy-task-queue">
            <div class="auto-panel-header">
              <span class="auto-panel-title">Task queue</span>
              <span class="auto-panel-count">${taskCount}</span>
            </div>
            <div class="auto-panel-body">
              ${(extState.liveDaemons?.length ?? 0) > 0 ? html`
                <div class="auto-queue-section">
                  <div class="auto-section-label gold">${icons.refresh} Continuous loops</div>
                  ${(extState.liveDaemons ?? []).map((d) => renderContinuousDaemonCard(d, handlers))}
                </div>
              ` : nothing}
              ${state.runningTask ? html`
                <div class="auto-queue-section">
                  <div class="auto-section-label gold"><i class="gt-light" data-state="gold" data-pulse></i>Executing</div>
                  ${renderTaskCard(
                    state.runningTask as ExtendedTask,
                    extState.selectedTaskId,
                    handlers,
                    true,
                    false,
                    extState.taskActivity?.[state.runningTask.id],
                  )}
                </div>
              ` : nothing}
              ${state.pendingTasks.length > 0 ? html`
                <div class="auto-queue-section">
                  <div class="auto-section-label">Pending</div>
                  ${state.pendingTasks.map(t => renderTaskCard(t as ExtendedTask, extState.selectedTaskId, handlers, false))}
                </div>
              ` : nothing}
              ${state.recentCompleted.length > 0 ? html`
                <div class="auto-queue-section">
                  <div class="auto-section-label muted">Recently completed</div>
                  ${state.recentCompleted.slice(0, 3).map(t => renderTaskCard(t as ExtendedTask, extState.selectedTaskId, handlers, false, true))}
                </div>
              ` : nothing}
              ${!state.runningTask && state.pendingTasks.length === 0 && state.recentCompleted.length === 0 ? html`
                ${glassEmpty({
                  icon: icons.kanban,
                  title: 'Queue is clear',
                  sub: 'Queue a build/test task, or pull one in from a kanban project.',
                  action: html`<button class="auto-btn small gold" @click=${() => handlers.onOpenCreateDialog?.()}>${icons.plus} New task</button>`,
                })}
              ` : nothing}
            </div>
          </div>
          <div class="auto-panel auto-main-panel">
            <div class="auto-panel-body">
              ${tab === 'projects' ? renderProjects(extState, handlers) : renderOverview(extState, handlers)}
            </div>
          </div>
          <div class="auto-panel auto-detail-panel" data-learn-id="autonomy-task-detail">
            <div class="auto-panel-header">
              <span class="auto-panel-title">Details</span>
            </div>
            <div class="auto-panel-body">
              ${renderDetailPanel(extState, handlers)}
            </div>
          </div>
        </div>
      ` : nothing}

      ${section === 'activity' ? html`
        <div class="auto-v2-activity" data-learn-id="autonomy-activity">
          <div class="auto-panel"><div class="auto-panel-header"><span class="auto-panel-title">Audit log</span></div><div class="auto-panel-body">${renderAudit(extState, handlers)}</div></div>
          <div class="auto-panel"><div class="auto-panel-header"><span class="auto-panel-title">API usage today · $${state.apiUsageToday.totalCost.toFixed(2)}</span></div><div class="auto-panel-body">${renderApi(extState)}</div></div>
        </div>
      ` : nothing}

      ${section === 'settings' ? html`
        <div class="auto-panel auto-v2-settings" data-learn-id="autonomy-settings"><div class="auto-panel-body">${renderSettings(extState, handlers)}</div></div>
      ` : nothing}

      ${state.showCreateDialog ? renderCreateDialog(extState, handlers) : nothing}
    </div>
  `;
}

// =============================================================================
// CREATE TASK DIALOG
// =============================================================================

/**
 * Goal-mode toggle + backend dropdown. The backend picker only appears
 * once the user opts into goal mode — it's irrelevant to legacy
 * build/test tasks. Backend choice is sent verbatim to
 * `autonomy:queue.add { backend }`; the server validates shape and falls
 * back to `config.autonomy.defaultBackend` then claude.
 */
function renderGoalModeSection(draft: any, handlers: AutonomyHandlers): TemplateResult {
  const isGoal = !!draft.isGoal;
  const backend = draft.backend ?? { kind: 'claude' };
  const backendKind: string = backend.kind ?? 'claude';
  return html`
    <div class="auto-field">
      <label class="auto-goal-toggle">
        <input
          type="checkbox"
          .checked=${isGoal}
          @change=${(e: Event) => handlers.onCreateDraftChange?.({ isGoal: (e.target as HTMLInputElement).checked } as any)}
        />
        <span>Goal mode <span class="auto-field-hint">· orchestrator + sub-agents</span></span>
      </label>
      <div class="auto-field-hint indent">
        Plans the goal, spawns dedicated sub-agents in parallel, and synthesizes results. Pick a backend below.
      </div>
    </div>
    ${isGoal
      ? html`
          <div class="auto-field">
            <span class="auto-field-label">BACKEND</span>
            <select
              class="auto-input"
              .value=${backendKind}
              @change=${(e: Event) => {
                const k = (e.target as HTMLSelectElement).value;
                const next =
                  k === 'gateway-agent'
                    ? { kind: 'gateway-agent', agentId: backend.agentId || 'coder' }
                    : { kind: k };
                handlers.onCreateDraftChange?.({ backend: next } as any);
              }}
            >
              <option value="claude">Claude Coder (default)</option>
              <option value="opencode">OpenCode</option>
              <option value="codex">Codex</option>
              <option value="grok">Grok Build</option>
              <option value="gateway-agent">Gateway Agent…</option>
            </select>
            ${backendKind === 'gateway-agent'
              ? html`
                  <input
                    class="auto-input"
                    placeholder="Agent ID (e.g. inspector, overseer, architect)"
                    .value=${backend.agentId ?? ''}
                    @input=${(e: Event) =>
                      handlers.onCreateDraftChange?.({
                        backend: {
                          kind: 'gateway-agent',
                          agentId: (e.target as HTMLInputElement).value,
                        },
                      } as any)}
                  />
                `
              : nothing}
            <div class="auto-field-hint">
              The backend drives both the planner LLM and the worker CLI. Leave on Claude unless this goal needs a specific backend.
            </div>
          </div>
        `
      : nothing}
  `;
}

function renderCreateDialog(state: ExtendedAutonomyState, handlers: AutonomyHandlers): TemplateResult {
  const draft =
    state.createDraft ?? {
      title: '',
      description: '',
      priority: 'normal' as const,
      requiresApproval: false,
      executionMode: 'gateway' as const,
      cli: 'claude' as const,
      cwd: '',
    };
  const canSubmit = !!draft.title.trim();
  const mode = draft.executionMode ?? 'gateway';
  const cli = draft.cli ?? 'claude';

  return html`
    <div class="auto-modal-backdrop" @click=${() => handlers.onCloseCreateDialog?.()}>
      <div class="auto-modal" role="dialog" aria-modal="true" aria-labelledby="auto-create-title" @click=${(e: Event) => e.stopPropagation()}>
        <div class="auto-modal-header">
          <div>
            <span class="gt-eyebrow">Queue</span>
            <span id="auto-create-title">New autonomous task</span>
          </div>
          <button class="auto-modal-close" aria-label="Close" @click=${() => handlers.onCloseCreateDialog?.()}>${icons.x}</button>
        </div>
        <div class="auto-modal-body">
          <label class="auto-field">
            <span class="auto-field-label">TITLE</span>
            <input
              class="auto-input"
              .value=${draft.title}
              placeholder="Short, action-oriented task title"
              @input=${(e: Event) => handlers.onCreateDraftChange?.({ title: (e.target as HTMLInputElement).value })}
            />
          </label>
          <label class="auto-field">
            <span class="auto-field-label">DESCRIPTION / BRIEF</span>
            <textarea
              class="auto-input auto-textarea"
              .value=${draft.description}
              placeholder="What needs to happen, success criteria, links, constraints..."
              @input=${(e: Event) => handlers.onCreateDraftChange?.({ description: (e.target as HTMLTextAreaElement).value })}
            ></textarea>
          </label>
          <div class="auto-field-row">
            <label class="auto-field">
              <span class="auto-field-label">PRIORITY</span>
              <select
                class="auto-input"
                .value=${draft.priority}
                @change=${(e: Event) => handlers.onCreateDraftChange?.({ priority: (e.target as HTMLSelectElement).value as any })}
              >
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
            </label>
            <label class="auto-field auto-field-check">
              <input
                type="checkbox"
                .checked=${draft.requiresApproval}
                @change=${(e: Event) => handlers.onCreateDraftChange?.({ requiresApproval: (e.target as HTMLInputElement).checked })}
              />
              <span>Requires my approval before run</span>
            </label>
          </div>

          <!-- Goal mode + backend picker -->
          ${renderGoalModeSection(draft, handlers)}

          <!-- Agent / execution mode -->
          <div class="auto-field">
            <span class="auto-field-label">AGENT MODE</span>
            <div class="auto-mode-toggle" role="radiogroup" aria-label="Agent mode">
              <button
                type="button"
                role="radio"
                aria-checked=${mode === 'gateway'}
                class="auto-mode-chip ${mode === 'gateway' ? 'active' : ''}"
                @click=${() => handlers.onCreateDraftChange?.({ executionMode: 'gateway' })}
              >
                <span class="auto-mode-chip-title">Gateway agent</span>
                <span class="auto-mode-chip-sub">Native sessions.spawn — fastest, no TUI</span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked=${mode === 'terminal'}
                class="auto-mode-chip ${mode === 'terminal' ? 'active' : ''}"
                @click=${() => handlers.onCreateDraftChange?.({ executionMode: 'terminal' })}
              >
                <span class="auto-mode-chip-title">CLI in terminal</span>
                <span class="auto-mode-chip-sub">Long-lived PTY — re-attach from card</span>
              </button>
            </div>
          </div>

          ${mode === 'terminal'
            ? html`
                <div class="auto-field-row">
                  <label class="auto-field">
                    <span class="auto-field-label">CLI</span>
                    <select
                      class="auto-input"
                      .value=${cli}
                      @change=${(e: Event) => handlers.onCreateDraftChange?.({ cli: (e.target as HTMLSelectElement).value as 'claude' | 'opencode' | 'gemini' | 'grok' })}
                    >
                      <option value="claude">Claude Code</option>
                      <option value="opencode">OpenCode</option>
                      <option value="gemini">Gemini</option>
                      <option value="grok">Grok Build</option>
                    </select>
                  </label>
                  <label class="auto-field">
                    <span class="auto-field-label">WORKING DIRECTORY</span>
                    <input
                      class="auto-input"
                      .value=${draft.cwd ?? ''}
                      placeholder="."
                      @input=${(e: Event) => handlers.onCreateDraftChange?.({ cwd: (e.target as HTMLInputElement).value })}
                    />
                  </label>
                </div>
                <div class="auto-field-hint">
                  Terminal persists after the task finishes — close it manually from the task card or the Terminals page.
                </div>
              `
            : nothing}
        </div>
        <div class="auto-modal-actions">
          <button class="auto-btn" @click=${() => handlers.onCloseCreateDialog?.()}>Cancel</button>
          <button
            class="auto-btn gold"
            ?disabled=${!canSubmit}
            @click=${() => handlers.onSubmitCreate?.()}
          >${icons.check} Queue task</button>
        </div>
      </div>
    </div>
  `;
}

// =============================================================================
// CONTINUOUS DAEMON CARD
// =============================================================================

function renderContinuousDaemonCard(
  d: ContinuousDaemonRow,
  handlers: AutonomyHandlers,
): TemplateResult {
  const label = d.workflowName ?? d.workflowId;
  return html`
    <div class="auto-task-card auto-daemon-card ${d.paused ? '' : 'running'}">
      <div class="auto-task-card-header">
        <div class="auto-task-card-title" title=${label}>
          ${icons.refresh} ${label}
        </div>
        <span class="gt-chip" data-tone=${d.paused ? 'warn' : 'gold'}>
          <i class="gt-light" data-state=${d.paused ? 'warn' : 'gold'} ?data-pulse=${!d.paused}></i>${d.paused ? 'Paused' : 'Looping'}
        </span>
      </div>
      <div class="auto-task-card-meta">
        Iter ${d.iterationCount}
        ${d.errorStreak > 0 ? html` · <span class="auto-daemon-fail">streak ${d.errorStreak} fail</span>` : nothing}
      </div>
      <div class="auto-task-card-actions">
        ${d.paused
          ? html`<button class="auto-btn small"
              @click=${() => handlers.onResumeContinuous?.(d.runId)}>${icons.play} Resume</button>`
          : html`<button class="auto-btn small"
              @click=${() => handlers.onPauseContinuous?.(d.runId)}>${icons.pause} Pause</button>`}
        <button class="auto-btn small warn"
          @click=${() => handlers.onStopContinuous?.(d.runId)}>${icons.stop} Stop</button>
      </div>
    </div>
  `;
}

// =============================================================================
// TASK CARD
// =============================================================================

function renderTaskCard(
  task: ExtendedTask,
  selectedId: string | undefined,
  handlers: AutonomyHandlers,
  isRunning: boolean,
  isCompleted: boolean = false,
  activity?: TaskActivity,
): TemplateResult {
  const isSelected = task.id === selectedId;
  const status = task.autonomousStatus || task.status;
  const iterations = (task as any).iterations as ExtendedTask['iterations'] | undefined;
  const currentIter = iterations && iterations.length > 0 ? iterations[iterations.length - 1] : undefined;
  const phase = describePhase(task.currentPhase);
  const agentId = currentIter?.buildAgentId;
  const lastTs = activity?.lastActivity ?? currentIter?.endedAt ?? currentIter?.startedAt ?? task.executedAt ?? task.createdAt;
  const showOversight = isRunning || !!iterations?.length;
  const runtimeMs = isRunning && task.executedAt ? Date.now() - task.executedAt : undefined;

  return html`
    <div
      class="auto-task-card ${isSelected ? 'selected' : ''} ${isRunning ? 'running' : ''} ${isCompleted ? 'completed' : ''}"
      role="button"
      tabindex="0"
      aria-pressed=${isSelected ? 'true' : 'false'}
      @click=${() => handlers.onSelectTask?.(isSelected ? null : task.id)}
      @keydown=${(e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handlers.onSelectTask?.(isSelected ? null : task.id);
        }
      }}
    >
      <div class="auto-task-header">
        <i
          class="gt-light auto-task-status ${status}"
          data-state=${isRunning ? 'gold' : isCompleted ? (status === 'failed' ? 'danger' : 'ok') : status === 'blocked' || status === 'pending_approval' ? 'warn' : 'idle'}
          ?data-pulse=${isRunning}
          aria-label=${status}
        ></i>
        <span class="auto-task-title">${task.title}</span>
      </div>
      <div class="auto-task-meta">
        <span class="auto-task-priority ${task.priority}">${task.priority.toUpperCase()}</span>
        ${task.projectName ? html`<span class="auto-task-project">${task.projectName}</span>` : nothing}
        ${runtimeMs != null ? html`<span class="auto-task-runtime">${formatDuration(runtimeMs)}</span>` : nothing}
        ${task.kind === 'goal' && (task as any).backend
          ? html`<span class="auto-backend-badge ${((task as any).backend.kind || 'claude').replace(/_/g, '-')}">${describeBackend((task as any).backend)}</span>`
          : task.kind === 'goal'
            ? html`<span class="auto-backend-badge">Claude (default)</span>`
            : nothing}
      </div>
      ${showOversight ? html`
        <div class="auto-task-oversight">
          <div class="auto-task-oversight-row">
            <span class="auto-task-oversight-label">PHASE</span>
            <span class="auto-task-oversight-value ${phase.tone}">${phase.label}</span>
          </div>
          ${agentId ? html`
            <div class="auto-task-oversight-row">
              <span class="auto-task-oversight-label">AGENT</span>
              <span class="auto-task-oversight-value">${agentId}</span>
            </div>
          ` : nothing}
          ${currentIter ? html`
            <div class="auto-task-oversight-row">
              <span class="auto-task-oversight-label">ITER</span>
              <span class="auto-task-oversight-value">${currentIter.number}${iterations && iterations.length > 1 ? ` / ${iterations.length}` : ''}</span>
            </div>
          ` : nothing}
          <div class="auto-task-oversight-row">
            <span class="auto-task-oversight-label">LAST</span>
            <span class="auto-task-oversight-value muted" title=${formatTimestampPrecise(lastTs)}>${formatTimeAgo(lastTs)}</span>
          </div>
        </div>
      ` : nothing}
    </div>
  `;
}

// =============================================================================
// OVERVIEW TAB
// =============================================================================

function renderOverview(state: ExtendedAutonomyState, handlers: AutonomyHandlers): TemplateResult {
  return html`
    <div class="auto-overview">
      <!-- Stats Row -->
      <div class="auto-stats-row">
        <div class="auto-stat-card">
          <div class="auto-stat-icon gold">${icons.clock}</div>
          <div class="auto-stat-content">
            <div class="auto-stat-value">${state.queueStats.pending}</div>
            <div class="auto-stat-label">PENDING</div>
          </div>
        </div>
        <div class="auto-stat-card">
          <div class="auto-stat-icon green">${icons.checkCircle}</div>
          <div class="auto-stat-content">
            <div class="auto-stat-value">${state.queueStats.completed}</div>
            <div class="auto-stat-label">COMPLETED</div>
          </div>
        </div>
        <div class="auto-stat-card">
          <div class="auto-stat-icon red">${icons.xCircle}</div>
          <div class="auto-stat-content">
            <div class="auto-stat-value">${state.queueStats.failed}</div>
            <div class="auto-stat-label">FAILED</div>
          </div>
        </div>
        <div class="auto-stat-card">
          <div class="auto-stat-icon">${icons.shield}</div>
          <div class="auto-stat-content">
            <div class="auto-stat-value">${state.auditStats.totalEntries}</div>
            <div class="auto-stat-label">AUDIT</div>
          </div>
        </div>
        <div class="auto-stat-card">
          <div class="auto-stat-icon gold">${icons.dollarSign}</div>
          <div class="auto-stat-content">
            <div class="auto-stat-value">$${state.apiUsageToday.totalCost.toFixed(2)}</div>
            <div class="auto-stat-label">API COST</div>
          </div>
        </div>
      </div>

      <!-- Current Task -->
      <div class="auto-section">
        <div class="auto-section-header">Current task</div>
        ${state.runningTask ? html`
          <div class="auto-current-task">
            <div class="auto-current-title">${state.runningTask.title}</div>
            <div class="auto-current-meta">
              <span class="auto-tag ${state.runningTask.priority}">${state.runningTask.priority}</span>
              <span class="auto-duration">${formatDuration(Date.now() - (state.runningTask.executedAt || state.runningTask.createdAt))}</span>
            </div>
            ${state.runningTask.description ? html`
              <div class="auto-current-desc">${state.runningTask.description}</div>
            ` : nothing}
          </div>
        ` : html`
          <div class="auto-empty-section">
            <span>No task currently executing</span>
          </div>
        `}
      </div>

      <!-- System Status -->
      <div class="auto-section">
        <div class="auto-section-header">System status</div>
        ${state.activityState ? html`
          <div class="auto-system-grid">
            <div class="auto-system-item">
              <span class="auto-system-label">USER</span>
              <span class="auto-system-value ${state.activityState.isUserActive ? 'active' : 'idle'}">
                <i class="gt-light" data-state=${state.activityState.isUserActive ? 'ok' : 'warn'}></i>${state.activityState.isUserActive ? 'Active' : 'Idle'}
              </span>
            </div>
            <div class="auto-system-item">
              <span class="auto-system-label">CPU</span>
              <div class="auto-progress">
                <div class="auto-progress-fill" style="width: ${state.activityState.cpuUsagePercent}%"></div>
              </div>
              <span class="auto-system-percent">${state.activityState.cpuUsagePercent.toFixed(0)}%</span>
            </div>
            <div class="auto-system-item">
              <span class="auto-system-label">RAM</span>
              <div class="auto-progress">
                <div class="auto-progress-fill" style="width: ${state.activityState.memoryUsagePercent}%"></div>
              </div>
              <span class="auto-system-percent">${state.activityState.memoryUsagePercent.toFixed(0)}%</span>
            </div>
          </div>
        ` : html`
          <div class="auto-empty-section">
            <span>System data unavailable</span>
          </div>
        `}
      </div>

      <!-- ASOP Checklist (real data) -->
      ${renderPreflightChecklist(state)}
    </div>
  `;
}

function renderPreflightChecklist(state: ExtendedAutonomyState): TemplateResult {
  const target = state.selectedTaskId
    ? [...state.pendingTasks, state.runningTask, ...state.recentCompleted].find(t => t?.id === state.selectedTaskId) as ExtendedTask | undefined
    : (state.runningTask as ExtendedTask | undefined) ?? (state.pendingTasks[0] as ExtendedTask | undefined);

  if (!target) {
    return html`
      <div class="auto-section">
        <div class="auto-section-header">ASOP pre-flight</div>
        <div class="auto-empty-section">Select a task to inspect its pre-flight state</div>
      </div>
    `;
  }

  const checks: Array<{ ok: boolean; label: string }> = [
    { ok: !!target.context?.projectId || !!target.context?.projectName, label: 'Context attached' },
    { ok: !!target.description && target.description.length > 5, label: 'Requirements gathered' },
    { ok: !!target.brief?.successCriteria || !!target.brief?.scope, label: 'Success criteria defined' },
    { ok: !!target.partnerContact?.channel, label: 'Partner contact configured' },
    { ok: (target.brief?.requirements?.clarifications?.length ?? 0) === 0, label: 'No open clarifications' },
    { ok: !!target.preflightComplete || target.status === 'approved' || target.status === 'running', label: 'Approval / start cleared' },
  ];

  return html`
    <div class="auto-section">
      <div class="auto-section-header">ASOP pre-flight · ${target.title}</div>
      <div class="auto-checklist">
        ${checks.map(c => html`
          <div class="auto-check-item">
            <span class="auto-check ${c.ok ? 'gold' : 'pending'}">${c.ok ? '✓' : '○'}</span>
            <span class="${c.ok ? '' : 'dim'}">${c.label}</span>
          </div>
        `)}
      </div>
    </div>
  `;
}


// =============================================================================
// PROJECTS TAB (kanban + Notion integration)
// =============================================================================

function renderProjects(state: ExtendedAutonomyState, handlers: AutonomyHandlers): TemplateResult {
  const projects = state.kanbanProjects ?? [];
  const tasks = state.kanbanTasks ?? [];
  const queuedKanbanIds = new Set(
    [...state.pendingTasks, state.runningTask, ...state.recentCompleted]
      .filter(Boolean)
      .map(t => (t as any).kanbanTaskId)
      .filter(Boolean)
  );

  if (projects.length === 0) {
    return html`
      <div class="auto-projects-empty">
        ${glassEmpty({
          icon: icons.folder,
          title: 'No kanban projects loaded',
          sub: 'Projects sync from Notion. Refresh, or open Projects to set them up.',
          action: html`<div class="ga-auto-empty-actions">
            <button class="auto-btn" @click=${() => handlers.onRefreshKanban?.()}>${icons.refresh} Refresh kanban</button>
            <button class="auto-btn gold" @click=${() => handlers.onOpenKanban?.()}>Open Projects ${icons.arrowRight}</button>
          </div>`,
        })}
      </div>
    `;
  }

  const projectsRanked = [...projects].sort((a, b) => {
    const pri = (p?: string) => p === 'Immediate' ? 0 : p === 'High' ? 1 : p === 'Medium' ? 2 : 3;
    return pri(a.priority) - pri(b.priority);
  });

  return html`
    <div class="auto-projects">
      <div class="auto-projects-toolbar">
        <span class="auto-projects-summary">${projects.length} project${projects.length === 1 ? '' : 's'} · ${tasks.length} task${tasks.length === 1 ? '' : 's'} from Notion</span>
        <div class="auto-detail-btns" style="margin-top:0">
          <button class="auto-btn small" @click=${() => handlers.onRefreshKanban?.()}>${icons.refresh} Sync from Notion</button>
          <button class="auto-btn small" @click=${() => handlers.onOpenKanban?.()}>Full board ${icons.arrowRight}</button>
        </div>
      </div>

      ${projectsRanked.map(proj => {
        const projTasks = tasks.filter(t => t.projectId === proj.id);
        const eligible = projTasks.filter(t =>
          t.autonomous === true ||
          (t.priorityLevel === 'Immediate' || t.priorityLevel === 'High') ||
          (t.priority === 'critical' || t.priority === 'high')
        );
        const open = projTasks.filter(t => t.status !== 'done').length;

        return html`
          <div class="auto-project-card">
            <div class="auto-project-head">
              <div class="auto-project-name">
                ${proj.customIcon ? html`<span aria-hidden="true">${proj.customIcon}</span>` : nothing}${proj.name}
                ${proj.priority ? html`<span class="auto-tag ${proj.priority === 'Immediate' ? 'critical' : proj.priority === 'High' ? 'high' : 'normal'}">${proj.priority}</span>` : nothing}
              </div>
              <div class="auto-project-stats">
                <span>${open} open</span>
                <span>·</span>
                <span class="${eligible.length > 0 ? 'gold' : ''}">${eligible.length} eligible</span>
              </div>
            </div>
            ${proj.description ? html`<div class="auto-project-desc">${proj.description}</div>` : nothing}
            ${eligible.length === 0 ? html`
              <div class="auto-project-empty">No autonomy-eligible tasks (High/Immediate or autonomous-flagged)</div>
            ` : html`
              <div class="auto-project-tasks">
                ${eligible.slice(0, 8).map(t => {
                  const alreadyQueued = queuedKanbanIds.has(t.id) || queuedKanbanIds.has(t.notionId ?? '');
                  return html`
                    <div class="auto-project-task">
                      <div class="auto-project-task-info">
                        <span class="auto-project-task-title">${t.title}</span>
                        <span class="auto-project-task-meta">
                          ${t.priorityLevel ? html`<span class="auto-tag ${t.priorityLevel === 'Immediate' ? 'critical' : t.priorityLevel === 'High' ? 'high' : 'normal'}">${t.priorityLevel}</span>` : nothing}
                          <span class="auto-tag time">${t.status.replace(/_/g, ' ')}</span>
                          ${t.notionId ? html`<span class="auto-tag project">Notion</span>` : nothing}
                        </span>
                      </div>
                      ${alreadyQueued
                        ? html`<span class="auto-tag queued"><i class="gt-light" data-state="gold"></i>Queued</span>`
                        : html`<button class="auto-btn small gold" @click=${() => handlers.onQueueKanbanTask?.(t, proj)}>${icons.play} Queue</button>`
                      }
                    </div>
                  `;
                })}
                ${eligible.length > 8 ? html`<div class="auto-project-more">+ ${eligible.length - 8} more · open in board</div>` : nothing}
              </div>
            `}
          </div>
        `;
      })}
    </div>
  `;
}

// =============================================================================
// AUDIT TAB
// =============================================================================

function renderAudit(state: ExtendedAutonomyState, handlers: AutonomyHandlers): TemplateResult {
  const q = (state.auditSearch ?? '').trim().toLowerCase();
  const filtered = q
    ? state.recentAudit.filter(e =>
        (e.description ?? '').toLowerCase().includes(q) ||
        (e.actionType ?? '').toLowerCase().includes(q) ||
        (e.target ?? '').toLowerCase().includes(q) ||
        (e.outcome ?? '').toLowerCase().includes(q))
    : state.recentAudit;
  const verifyResult = state.chainVerifyResult;

  return html`
    <div class="auto-audit">
      <div class="auto-audit-header">
        <span class="auto-chain-status ${state.chainValid ? 'valid' : 'invalid'}">
          <i class="gt-light" data-state=${state.chainValid ? 'ok' : 'danger'} ?data-pulse=${!state.chainValid}></i>${state.chainValid ? 'Chain valid' : 'Chain broken'}
        </span>
        ${state.auditStats.cageInterferences > 0 ? html`
          <span class="auto-cage-alert">${icons.alert} ${state.auditStats.cageInterferences} interference(s)</span>
        ` : nothing}
        <button class="auto-btn small" @click=${() => handlers.onVerifyChain?.()}>${icons.shield} Verify chain</button>
        ${verifyResult ? html`
          <span class="auto-tag ${verifyResult.valid ? 'ok' : 'critical'}">
            ${verifyResult.valid ? 'verified ✓' : `broken @ ${verifyResult.brokenAt ?? 'unknown'}`}
          </span>
        ` : nothing}
      </div>
      <div class="auto-audit-toolbar">
        <input
          class="auto-input auto-audit-search"
          placeholder="Search audit (description, action, target, outcome)..."
          .value=${state.auditSearch ?? ''}
          @input=${(e: Event) => handlers.onAuditSearchChange?.((e.target as HTMLInputElement).value)}
        />
        <span class="auto-audit-count">${filtered.length} / ${state.recentAudit.length}</span>
      </div>
      <div class="auto-audit-list">
        ${filtered.length === 0 ? glassEmpty(
          state.recentAudit.length === 0
            ? { icon: icons.scrollText, title: 'No audit entries yet', sub: 'Every autonomous action is written to a hash-chained log and shows up here.' }
            : { icon: icons.search, title: 'No matches', sub: 'Try a different word — search covers description, action, target and outcome.' },
        ) : filtered.map(entry => html`
          <div class="auto-audit-entry ${entry.actionType === 'cage_interference_detected' ? 'cage' : ''}">
            <span class="auto-audit-time">${formatTimestamp(entry.timestamp)}</span>
            <span class="auto-audit-type">${entry.actionType}</span>
            <span class="auto-audit-desc">${entry.description}</span>
            <span class="auto-audit-outcome ${entry.outcome}">${entry.outcome}</span>
          </div>
        `)}
      </div>
    </div>
  `;
}

// =============================================================================
// API TAB
// =============================================================================

// =============================================================================
// SETTINGS TAB — default backend + future autonomy prefs
// =============================================================================

function renderSettings(state: ExtendedAutonomyState, handlers: AutonomyHandlers): TemplateResult {
  // Lazy-trigger a fetch when the user opens the tab without a cached value.
  // (Caller wires this into the onTabChange handler ideally; this fallback
  // makes the tab self-loading.)
  if (!state.defaultBackend && handlers.onLoadDefaultBackend) {
    queueMicrotask(() => handlers.onLoadDefaultBackend!());
  }
  const backend = state.defaultBackend ?? { kind: 'claude' };
  const backendKind: string = (backend as any).kind ?? 'claude';
  const agentId: string = (backend as any).agentId ?? '';

  const choose = (next: any) => handlers.onSaveDefaultBackend?.(next);

  return html`
    <div class="auto-settings">
      <div class="auto-settings-card">
        <div class="auto-settings-card-title">Default backend</div>
        <div class="auto-settings-card-desc">
          Every new goal uses this backend unless the create dialog overrides it.
          Drives both the planner LLM and the worker CLI.
        </div>
        <div class="auto-settings-options">
          ${(['claude', 'opencode', 'codex', 'grok', 'gateway-agent'] as const).map(
            (k) => html`
              <button
                class="auto-settings-chip ${backendKind === k ? 'active' : ''}"
                @click=${() =>
                  choose(
                    k === 'gateway-agent'
                      ? { kind: 'gateway-agent', agentId: agentId || 'coder' }
                      : { kind: k },
                  )}
              >
                <div class="auto-settings-chip-title">
                  ${k === 'claude'
                    ? 'Claude Coder'
                    : k === 'opencode'
                      ? 'OpenCode'
                      : k === 'codex'
                        ? 'Codex'
                        : k === 'grok'
                          ? 'Grok Build'
                          : 'Gateway Agent'}
                </div>
                <div class="auto-settings-chip-sub">
                  ${k === 'claude'
                    ? 'Anthropic SDK + Claude Code CLI'
                    : k === 'opencode'
                      ? 'OpenCode-hosted Claude + OpenCode CLI'
                      : k === 'codex'
                        ? 'OpenAI Codex + Codex CLI'
                        : k === 'grok'
                          ? 'xAI Grok + Grok Build CLI'
                          : 'Operator-defined agent'}
                </div>
              </button>
            `,
          )}
        </div>
        ${backendKind === 'gateway-agent'
          ? html`
              <label class="auto-field" style="margin-top: 14px; max-width: 420px;">
                <span class="auto-field-label">AGENT ID</span>
                <input
                  class="auto-input"
                  placeholder="e.g. inspector, overseer, architect"
                  .value=${agentId}
                  @change=${(e: Event) =>
                    choose({
                      kind: 'gateway-agent',
                      agentId: (e.target as HTMLInputElement).value,
                    })}
                />
              </label>
            `
          : nothing}
        <div class="auto-settings-current">
          Current: <strong>${describeBackend(backend)}</strong>
        </div>
      </div>
    </div>
  `;
}

function describeBackend(b: any): string {
  if (!b || !b.kind) return 'Claude Coder';
  if (b.kind === 'claude') return 'Claude Coder' + (b.profileId ? ` (${b.profileId})` : '');
  if (b.kind === 'opencode') return 'OpenCode';
  if (b.kind === 'codex') return 'Codex';
  if (b.kind === 'grok') return 'Grok Build';
  if (b.kind === 'gateway-agent') return `Gateway Agent: ${b.agentId || '?'}`;
  return String(b.kind);
}

function renderApi(state: ExtendedAutonomyState): TemplateResult {
  const { apiUsageToday } = state;
  
  return html`
    <div class="auto-api">
      <div class="auto-api-stats">
        <div class="auto-api-stat">
          <div class="auto-api-value">${apiUsageToday.totalCalls}</div>
          <div class="auto-api-label">CALLS</div>
        </div>
        <div class="auto-api-stat">
          <div class="auto-api-value">${(apiUsageToday.totalTokens / 1000).toFixed(1)}K</div>
          <div class="auto-api-label">TOKENS</div>
        </div>
        <div class="auto-api-stat">
          <div class="auto-api-value">$${apiUsageToday.totalCost.toFixed(4)}</div>
          <div class="auto-api-label">COST</div>
        </div>
        <div class="auto-api-stat">
          <div class="auto-api-value">${apiUsageToday.autonomousPercent.toFixed(0)}%</div>
          <div class="auto-api-label">AUTO</div>
        </div>
      </div>
      
      <div class="auto-section">
        <div class="auto-section-header">Usage breakdown</div>
        <div class="auto-usage-bar">
          <div class="auto-usage-fill auto" style="width: ${apiUsageToday.autonomousPercent}%"></div>
        </div>
        <div class="auto-usage-legend">
          <span class="auto-legend-item auto">Autonomous · ${apiUsageToday.autonomousCalls}</span>
          <span class="auto-legend-item interactive">Interactive · ${apiUsageToday.totalCalls - apiUsageToday.autonomousCalls}</span>
        </div>
      </div>
    </div>
  `;
}

// =============================================================================
// DETAIL PANEL
// =============================================================================

function renderDetailPanel(state: ExtendedAutonomyState, handlers: AutonomyHandlers): TemplateResult {
  const selectedTask = state.selectedTaskId 
    ? [...state.pendingTasks, state.runningTask, ...state.recentCompleted].find(t => t?.id === state.selectedTaskId) as ExtendedTask | undefined
    : state.runningTask as ExtendedTask | undefined;
  
  if (!selectedTask) {
    return html`
      <div class="auto-detail-empty">
        ${glassEmpty({
          icon: icons.eye,
          title: 'Select a task',
          sub: 'Pick a task in the queue to see its brief, oversight, live session and pre-fire answers.',
        })}
      </div>
    `;
  }
  
  const status = selectedTask.autonomousStatus || selectedTask.status;
  
  return html`
    <div class="auto-detail">
      <div class="auto-detail-title">${selectedTask.title}</div>
      <div class="auto-detail-status ${status}">${status.replace(/_/g, ' ').toUpperCase()}</div>
      
      ${selectedTask.description ? html`
        <div class="auto-detail-section">
          <div class="auto-detail-label">DESCRIPTION</div>
          <div class="auto-detail-text">${selectedTask.description}</div>
        </div>
      ` : nothing}
      
      ${selectedTask.context?.projectName ? html`
        <div class="auto-detail-section">
          <div class="auto-detail-label">PROJECT</div>
          <div class="auto-detail-text">${selectedTask.context.projectName}</div>
        </div>
      ` : nothing}

      ${selectedTask.brief ? html`
        <div class="auto-detail-section">
          <div class="auto-detail-label">SCOPE</div>
          <div class="auto-detail-text">${selectedTask.brief.scope}</div>
        </div>
        <div class="auto-detail-section">
          <div class="auto-detail-label">SUCCESS CRITERIA</div>
          <div class="auto-detail-text">${selectedTask.brief.successCriteria}</div>
        </div>
      ` : nothing}

      ${(selectedTask as any).kanbanTaskId
        ? html`
          <div class="auto-detail-section">
            <div class="auto-detail-label">KANBAN / NOTION</div>
            <div class="auto-detail-text">Linked task <code>${(selectedTask as any).kanbanTaskId}</code></div>
            <div class="auto-detail-btns">
              <button class="auto-btn small gold" @click=${() => handlers.onSyncToKanban?.(selectedTask.id)}>${icons.refresh} Sync to Kanban</button>
              <button class="auto-btn small" @click=${() => handlers.onOpenKanban?.()}>Open in Projects ${icons.arrowRight}</button>
            </div>
          </div>
        `
        : html`
          <div class="auto-detail-section">
            <div class="auto-detail-label">KANBAN / NOTION</div>
            <div class="auto-detail-text auto-detail-muted">Not linked to any kanban task.</div>
            <div class="auto-detail-btns">
              <button class="auto-btn small" @click=${() => handlers.onLinkToKanban?.(selectedTask.id, '')}>${icons.plus} Create kanban entry</button>
              <button class="auto-btn small" @click=${() => handlers.onOpenKanban?.()}>Open Projects ${icons.arrowRight}</button>
            </div>
          </div>
        `}

      ${selectedTask.partnerContact?.channel
        ? html`
          <div class="auto-detail-section">
            <div class="auto-detail-label">CONTACT</div>
            <div class="auto-detail-text">${selectedTask.partnerContact.channel}</div>
            ${(selectedTask.partnerContact.pendingQuestions?.length ?? 0) > 0 ? html`
              <div class="auto-detail-text auto-detail-warn" style="margin-top:6px;">
                ${selectedTask.partnerContact.pendingQuestions.length} pending question(s)
              </div>
            ` : nothing}
          </div>
        `
        : html`
          <div class="auto-detail-section">
            <div class="auto-detail-label">CONTACT</div>
            <div class="auto-detail-text auto-detail-muted">No partner channel configured for this task.</div>
            <div class="auto-detail-btns">
              <button class="auto-btn small" @click=${() => handlers.onConfigureChannels?.()}>${icons.settings} Configure channels</button>
            </div>
          </div>
        `}

      ${renderTaskOversight(selectedTask, state.taskActivity?.[selectedTask.id])}
      ${renderLiveSessionPanel(selectedTask, handlers)}
      ${renderActivityLog(selectedTask, state.taskActivity?.[selectedTask.id], handlers)}
      ${renderPrefirePanel(selectedTask, handlers)}
      ${renderIterationHistory(selectedTask)}

      ${['pending', 'pending_approval', 'blocked'].includes(status) ? html`
        <div class="auto-detail-actions">
          <button class="auto-btn gold full" @click=${() => handlers.onApprove(selectedTask.id)}>${icons.check} Approve</button>
          <button class="auto-btn danger full" @click=${() => handlers.onCancel(selectedTask.id)}>${icons.x} Cancel task</button>
        </div>
      ` : nothing}
    </div>
  `;
}

// =============================================================================
// TELEGRAM CONNECTIVITY — status chip + Test / Reconnect affordance
// =============================================================================

function renderTelegramChip(
  state: ExtendedAutonomyState,
  handlers: AutonomyHandlers,
): TemplateResult {
  const tg = state.telegramStatus;
  const result = state.telegramTestResult;
  const connected = tg?.configured ?? false;
  // Last test outcome refines the light: green when a real send succeeded, red
  // on a surfaced API error, amber when configured-but-untested.
  const light = result ? (result.ok ? 'ok' : 'danger') : connected ? 'warn' : 'idle';
  const label = !connected
    ? 'Telegram: not configured'
    : result
      ? result.ok
        ? `Telegram: connected${tg?.chatIdMasked ? ` (${tg.chatIdMasked})` : ''}`
        : `Telegram: ${result.description || result.error || 'connection failed'}`
      : `Telegram: configured${tg?.chatIdMasked ? ` (${tg.chatIdMasked})` : ''}`;
  return html`
    <div class="auto-telegram-chip" title=${label}>
      <i class="gt-light" data-state=${light} ?data-pulse=${result?.ok === true}></i>
      <span class="auto-telegram-label">${label}</span>
      <button
        class="auto-btn icon"
        title="Send a Telegram test message"
        aria-label="Send a Telegram test message"
        @click=${() => handlers.onTestTelegram?.()}
      >${icons.send}</button>
      <button
        class="auto-btn icon"
        title="Reload config + reconnect Telegram"
        aria-label="Reload config and reconnect Telegram"
        @click=${() => handlers.onReconnectTelegram?.()}
      >${icons.clockRotate}</button>
    </div>
  `;
}

// =============================================================================
// TASK OVERSIGHT — at-a-glance "who is doing what, when"
// =============================================================================

function renderTaskOversight(task: any, activity?: TaskActivity): TemplateResult {
  const iterations = task?.iterations as any[] | undefined;
  const currentIter = iterations && iterations.length > 0 ? iterations[iterations.length - 1] : undefined;
  const phase = describePhase(task?.currentPhase);
  const startedAt = task?.executedAt ?? task?.createdAt;
  const runtimeMs = task?.completedAt ? task.completedAt - startedAt : task?.executedAt ? Date.now() - task.executedAt : 0;
  const lastTs = activity?.lastActivity ?? currentIter?.endedAt ?? currentIter?.startedAt ?? startedAt;
  const iterCount = iterations?.length ?? 0;
  const passes = iterations?.filter((it) => it?.testerVerdict?.pass === true).length ?? 0;
  const fails = iterations?.filter((it) => it?.testerVerdict?.pass === false).length ?? 0;

  return html`
    <div class="auto-detail-section">
      <div class="auto-detail-label">OVERSIGHT</div>
      <div class="auto-oversight-grid">
        <div class="auto-oversight-cell">
          <div class="auto-oversight-cell-label">PHASE</div>
          <div class="auto-oversight-cell-value ${phase.tone}">${phase.label}</div>
        </div>
        <div class="auto-oversight-cell">
          <div class="auto-oversight-cell-label">AGENT</div>
          <div class="auto-oversight-cell-value">${currentIter?.buildAgentId ?? '—'}</div>
        </div>
        <div class="auto-oversight-cell">
          <div class="auto-oversight-cell-label">ITERATION</div>
          <div class="auto-oversight-cell-value">${iterCount > 0 ? `${currentIter?.number ?? iterCount}` : '—'}</div>
        </div>
        <div class="auto-oversight-cell">
          <div class="auto-oversight-cell-label">PASS / FAIL</div>
          <div class="auto-oversight-cell-value">
            <span class="gold">${passes}</span>
            <span class="muted"> · </span>
            <span class="${fails > 0 ? 'danger' : 'muted'}">${fails}</span>
          </div>
        </div>
        <div class="auto-oversight-cell">
          <div class="auto-oversight-cell-label">RUNTIME</div>
          <div class="auto-oversight-cell-value">${runtimeMs > 0 ? formatDuration(runtimeMs) : '—'}</div>
        </div>
        <div class="auto-oversight-cell">
          <div class="auto-oversight-cell-label">LAST ACTIVITY</div>
          <div class="auto-oversight-cell-value muted" title=${formatTimestampPrecise(lastTs)}>${formatTimeAgo(lastTs)}</div>
        </div>
      </div>
      ${currentIter?.buildSessionKey ? html`
        <div class="auto-oversight-session">
          <span class="auto-detail-hint">Builder session</span>
          <code class="auto-session-key">${currentIter.buildSessionKey}</code>
        </div>
      ` : nothing}
      ${currentIter?.testerSessionKey ? html`
        <div class="auto-oversight-session">
          <span class="auto-detail-hint">Tester session</span>
          <code class="auto-session-key">${currentIter.testerSessionKey}</code>
        </div>
      ` : nothing}
    </div>
  `;
}

// =============================================================================
// LIVE SESSION PANEL — re-attach to the iteration's running agent
// =============================================================================

/**
 * Render a card that lets the operator re-open the live session backing the
 * task's most recent iteration. Two flavours:
 *   - Terminal mode: shows the PTY id + "Open terminal" button that switches
 *     to the Terminals tab with that session active. The xterm directive
 *     replays the gateway-side scrollback so the full history is intact.
 *   - Gateway mode: shows the builder + (optional) tester session keys with
 *     "Open session" buttons that switch the chat view to that key.
 *
 * Falls back to a hint when no iteration has spawned yet — keeps the layout
 * stable as the task progresses through pre-fire → run.
 */
function renderLiveSessionPanel(task: any, handlers: AutonomyHandlers): TemplateResult {
  const iterations = task?.iterations as any[] | undefined;
  const currentIter = iterations && iterations.length > 0 ? iterations[iterations.length - 1] : undefined;
  if (!currentIter) {
    return html`
      <div class="auto-detail-section">
        <div class="auto-detail-label">LIVE SESSION</div>
        <div class="auto-detail-hint">
          No session yet — pre-fire must complete before the first iteration starts.
        </div>
      </div>
    `;
  }

  const buildTermId: string | undefined = currentIter.buildTerminalId;
  const testerTermId: string | undefined = currentIter.testerTerminalId;
  const buildSessionKey: string | undefined = currentIter.buildSessionKey;
  const testerSessionKey: string | undefined = currentIter.testerSessionKey;
  const isTerminalMode = !!buildTermId || !!testerTermId;

  return html`
    <div class="auto-detail-section">
      <div class="auto-detail-label">LIVE SESSION</div>
      ${isTerminalMode
        ? html`
            <div class="auto-detail-text">
              Running inside a long-lived PTY — open the Terminals tab to attach. Full scrollback is preserved.
            </div>
            ${buildTermId
              ? html`
                  <div class="auto-session-row">
                    <span class="auto-detail-hint">Builder</span>
                    <code class="auto-session-key">${buildTermId}</code>
                    <button
                      class="auto-btn small gold"
                      @click=${() => handlers.onOpenTerminal?.(buildTermId)}
                      title="Switch to the Terminals tab and focus this PTY"
                    >
                      Open terminal ${icons.arrowRight}
                    </button>
                  </div>
                `
              : nothing}
            ${testerTermId
              ? html`
                  <div class="auto-session-row">
                    <span class="auto-detail-hint">Tester</span>
                    <code class="auto-session-key">${testerTermId}</code>
                    <button
                      class="auto-btn small"
                      @click=${() => handlers.onOpenTerminal?.(testerTermId)}
                    >
                      Open terminal ${icons.arrowRight}
                    </button>
                  </div>
                `
              : nothing}
          `
        : html`
            <div class="auto-detail-text">
              Running as a native gateway agent — open the chat view to follow the live transcript.
            </div>
            ${buildSessionKey
              ? html`
                  <div class="auto-session-row">
                    <span class="auto-detail-hint">Builder</span>
                    <code class="auto-session-key">${buildSessionKey}</code>
                    <button
                      class="auto-btn small gold"
                      @click=${() => handlers.onOpenSession?.(buildSessionKey)}
                      title="Switch the chat view to this session"
                    >
                      Open session ${icons.arrowRight}
                    </button>
                  </div>
                `
              : nothing}
            ${testerSessionKey
              ? html`
                  <div class="auto-session-row">
                    <span class="auto-detail-hint">Tester</span>
                    <code class="auto-session-key">${testerSessionKey}</code>
                    <button
                      class="auto-btn small"
                      @click=${() => handlers.onOpenSession?.(testerSessionKey)}
                    >
                      Open session ${icons.arrowRight}
                    </button>
                  </div>
                `
              : nothing}
          `}
    </div>
  `;
}

// =============================================================================
// ACTIVITY LOG — chronological feed of audit + iteration events for one task
// =============================================================================

function renderActivityLog(
  task: any,
  activity: TaskActivity | undefined,
  handlers: AutonomyHandlers,
): TemplateResult {
  const entries = activity?.entries ?? [];
  const isLoading = activity?.loading === true;
  const error = activity?.error;
  const loadedAt = activity?.loadedAt;

  return html`
    <div class="auto-detail-section auto-activity-section">
      <div class="auto-activity-header">
        <div class="auto-detail-label">ACTIVITY LOG</div>
        <div class="auto-activity-header-meta">
          ${loadedAt ? html`<span class="auto-detail-hint" title=${formatTimestampPrecise(loadedAt)}>updated ${formatTimeAgo(loadedAt)}</span>` : nothing}
          <button class="auto-btn small icon" title="Refresh log" aria-label="Refresh activity log" @click=${() => handlers.onRefreshActivity?.(task.id)}>${icons.refresh}</button>
        </div>
      </div>
      ${error ? html`<div class="auto-outcome error">${error}</div>` : nothing}
      ${isLoading && entries.length === 0 ? html`
        <div class="gt-skel ga-skel-row" style="height:40px" aria-busy="true" aria-label="Loading activity"></div>
        <div class="gt-skel ga-skel-row" style="height:40px"></div>
      ` : entries.length === 0 ? html`
        <div class="auto-detail-hint">No activity recorded yet. Events appear here as the orchestrator runs.</div>
      ` : html`
        <div class="auto-activity-feed">
          ${[...entries].reverse().map((e) => renderActivityEntry(e))}
        </div>
      `}
    </div>
  `;
}

function renderActivityEntry(entry: ActivityEntry): TemplateResult {
  const tone =
    entry.outcome === 'failure' ? 'danger' :
    entry.outcome === 'blocked' ? 'warn' :
    entry.outcome === 'pending' ? 'muted' :
    entry.outcome === 'success' ? 'success' : 'muted';
  const icon =
    entry.kind === 'iteration_start' ? '◉' :
    entry.kind === 'iteration_build_done' ? '⚙' :
    entry.kind === 'iteration_test_done' ? '✓' :
    entry.kind === 'iteration_assess' ? '◆' :
    entry.kind === 'iteration_max_reached' ? '⊘' :
    entry.kind === 'queued' ? '◇' :
    entry.kind === 'started' ? '▶' :
    entry.kind === 'completed' ? '✓' :
    entry.kind === 'failed' ? '✕' :
    entry.kind === 'cancelled' ? '◼' :
    entry.kind === 'prefire_blocked' ? '⚠' :
    entry.kind === 'prefire_completed' ? '✓' :
    entry.kind === 'notification' ? '🔔' : '·';
  const reasons = (entry.meta?.reasons as string[] | undefined) ?? [];
  const evidence = (entry.meta?.evidence as string[] | undefined) ?? [];
  const fixHints = (entry.meta?.fixHints as string[] | undefined) ?? [];

  return html`
    <div class="auto-activity-entry ${tone}">
      <div class="auto-activity-row">
        <span class="auto-activity-icon ${tone}">${icon}</span>
        <span class="auto-activity-time" title=${formatTimestampPrecise(entry.timestamp)}>${formatTimestampPrecise(entry.timestamp)}</span>
        <span class="auto-activity-title">${entry.title}</span>
        ${entry.outcome ? html`<span class="auto-activity-outcome ${tone}">${entry.outcome.toUpperCase()}</span>` : nothing}
      </div>
      <div class="auto-activity-meta">
        ${entry.iteration != null ? html`<span class="auto-tag">iter ${entry.iteration}</span>` : nothing}
        ${entry.phase ? html`<span class="auto-tag">${entry.phase}</span>` : nothing}
        ${entry.agentId ? html`<span class="auto-tag">${entry.agentId}</span>` : nothing}
        ${entry.runId ? html`<span class="auto-tag mono">run ${entry.runId.slice(0, 8)}</span>` : nothing}
      </div>
      ${entry.detail ? html`<div class="auto-activity-detail">${entry.detail}</div>` : nothing}
      ${reasons.length > 0 ? html`
        <ul class="auto-activity-list">
          ${reasons.map((r) => html`<li>${r}</li>`)}
        </ul>
      ` : nothing}
      ${fixHints.length > 0 ? html`
        <div class="auto-activity-sublabel">FIX HINTS</div>
        <ul class="auto-activity-list">
          ${fixHints.map((r) => html`<li>${r}</li>`)}
        </ul>
      ` : nothing}
      ${evidence.length > 0 ? html`
        <div class="auto-activity-sublabel">EVIDENCE</div>
        <ul class="auto-activity-list">
          ${evidence.map((r) => html`<li class="mono">${r}</li>`)}
        </ul>
      ` : nothing}
    </div>
  `;
}

// =============================================================================
// PRE-FIRE QUESTIONNAIRE + ITERATION HISTORY (closed-loop tester)
// =============================================================================

function renderPrefirePanel(selectedTask: any, handlers: AutonomyHandlers): TemplateResult {
  const prefireRequired = selectedTask?.context?.prefireRequired !== false;

  const toggleRow = html`
    <div class="auto-detail-section auto-prefire-toggle">
      <label class="auto-prefire-check">
        <input type="checkbox"
          style="width:16px; height:16px; cursor:pointer; flex-shrink:0;"
          .checked=${live(prefireRequired)}
          @change=${(e: Event) => {
            handlers.onSetPrefireRequired?.(selectedTask.id, (e.target as HTMLInputElement).checked);
          }} />
        <span>Require pre-fire questionnaire</span>
        ${prefireRequired
          ? nothing
          : html`<span class="auto-prefire-skipped">SKIPPED</span>`}
      </label>
      ${prefireRequired ? nothing : html`
        <div class="auto-detail-btns" style="align-items:center;">
          <span class="auto-detail-hint">Task can start without completing the form.</span>
          <button class="auto-btn small gold"
            @click=${() => handlers.onStartLoop?.(selectedTask.id)}>${icons.play} Start loop</button>
        </div>
      `}
    </div>
  `;

  const form = selectedTask?.context?.prefireForm ?? null;
  const subPanel = form
    ? renderPrefireDynamicPanel(selectedTask, form, handlers)
    : (!selectedTask?.context?.prefire && handlers.onGeneratePrefireForm)
      ? renderPrefireGeneratePrompt(selectedTask, handlers)
      : renderPrefireLegacyPanel(selectedTask, handlers);

  if (!prefireRequired) {
    return html`
      ${toggleRow}
      <div class="auto-prefire-dim" aria-disabled="true">
        ${subPanel}
      </div>
    `;
  }

  return html`${toggleRow}${subPanel}`;
}

function renderPrefireGeneratePrompt(selectedTask: any, handlers: AutonomyHandlers): TemplateResult {
  const generating = !!(selectedTask as any)._prefireGenerating;
  return html`
    <div class="auto-detail-section">
      <div class="auto-detail-label">PRE-FIRE QUESTIONNAIRE</div>
      <div class="auto-detail-text auto-detail-muted" style="margin-bottom:10px;">
        The agent will analyze this task, decide what it needs to know, and draft a custom questionnaire.
        You can answer here or via Telegram with <code>/prefire ${selectedTask?.id}</code>.
      </div>
      <button class="auto-btn small gold"
        ?disabled=${generating}
        @click=${() => {
          (selectedTask as any)._prefireGenerating = true;
          handlers.onGeneratePrefireForm?.(selectedTask.id);
        }}>
        ${generating ? 'Generating…' : html`${icons.sparkles} Generate questionnaire`}
      </button>
    </div>
  `;
}

function renderPrefireDynamicPanel(
  selectedTask: any,
  form: any,
  handlers: AutonomyHandlers,
): TemplateResult {
  const taskId = selectedTask.id as string;
  if (!prefireFormDraftsByTaskId.has(taskId)) {
    prefireFormDraftsByTaskId.set(taskId, { ...(form.answers ?? {}) });
  }
  const draft = prefireFormDraftsByTaskId.get(taskId)!;
  // Reconcile server-pushed answers (e.g. via Telegram) for keys not yet locally touched.
  for (const key of Object.keys(form.answers ?? {})) {
    if (!(key in draft)) draft[key] = form.answers[key];
  }

  const setAnswer = (id: string, value: any) => {
    draft[id] = value;
  };

  const onSave = (alsoMarkReady: boolean) => {
    handlers.onSavePrefireForm?.(selectedTask.id, { ...draft });
    if (alsoMarkReady) handlers.onMarkPrefireReady?.(selectedTask.id);
  };

  const renderField = (field: any) => {
    const value = draft[field.id];
    const onInput = (e: Event) => setAnswer(field.id, (e.target as HTMLInputElement).value);
    const onCheck = (e: Event) => setAnswer(field.id, (e.target as HTMLInputElement).checked);
    const onMulti = (e: Event) => {
      const select = e.target as HTMLSelectElement;
      const picks = Array.from(select.selectedOptions).map((o) => o.value);
      setAnswer(field.id, picks);
    };
    const help = field.help ? html`<div class="auto-detail-hint" style="margin-top:3px;">${field.help}</div>` : nothing;
    const labelLine = html`<div style="font-weight:600; font-size:12.5px;">
      ${field.label}${field.required ? html`<span class="auto-field-req">*</span>` : nothing}
    </div>`;

    switch (field.type) {
      case 'textarea':
        return html`
          <label class="auto-detail-text" style="display:block; margin-top:8px;">
            ${labelLine}
            <textarea class="auto-input" style="width:100%; min-height:60px; margin-top:4px;"
              placeholder=${field.placeholder ?? ''}
              .value=${live(value ?? '')}
              @input=${onInput}></textarea>
            ${help}
          </label>`;
      case 'number':
        return html`
          <label class="auto-detail-text" style="display:block; margin-top:8px;">
            ${labelLine}
            <input class="auto-input" type="number" style="width:160px; margin-top:4px;"
              .value=${live(value == null ? '' : String(value))}
              @input=${(e: Event) => setAnswer(field.id, Number((e.target as HTMLInputElement).value))} />
            ${help}
          </label>`;
      case 'boolean':
        return html`
          <label class="auto-detail-text" style="display:flex; gap:6px; align-items:center; margin-top:8px;">
            <input type="checkbox" .checked=${live(!!value)} @change=${onCheck} />
            ${labelLine}
            ${help}
          </label>`;
      case 'select':
        return html`
          <label class="auto-detail-text" style="display:block; margin-top:8px;">
            ${labelLine}
            <select class="auto-input" style="margin-top:4px;" .value=${live(value ?? '')}
              @change=${(e: Event) => setAnswer(field.id, (e.target as HTMLSelectElement).value)}>
              <option value="">— pick —</option>
              ${(field.options ?? []).map((o: string) => html`<option value=${o} ?selected=${value === o}>${o}</option>`)}
            </select>
            ${help}
          </label>`;
      case 'multiselect': {
        const picks: string[] = Array.isArray(value) ? value : [];
        return html`
          <label class="auto-detail-text" style="display:block; margin-top:8px;">
            ${labelLine}
            <select class="auto-input" multiple size="${Math.min(6, (field.options?.length ?? 3))}"
              style="margin-top:4px; min-height:80px;"
              @change=${onMulti}>
              ${(field.options ?? []).map((o: string) => html`<option value=${o} ?selected=${picks.includes(o)}>${o}</option>`)}
            </select>
            ${help}
          </label>`;
      }
      default:
        return html`
          <label class="auto-detail-text" style="display:block; margin-top:8px;">
            ${labelLine}
            <input class="auto-input" style="width:100%; margin-top:4px;"
              placeholder=${field.placeholder ?? ''}
              .value=${live(value ?? '')}
              @input=${onInput} />
            ${help}
          </label>`;
    }
  };

  const ready = !!form.agentReady;
  return html`
    <div class="auto-detail-section">
      <div class="auto-detail-label">
        PRE-FIRE QUESTIONNAIRE
        ${ready
          ? html`<span class="auto-tag ok"><i class="gt-light" data-state="ok"></i>Agent ready</span>`
          : html`<span class="auto-tag warn">${form.readyReason ?? 'Awaiting answers'}</span>`}
      </div>
      ${form.summary ? html`
        <div class="auto-detail-text auto-detail-muted" style="margin-bottom:8px; white-space:pre-wrap;">
          ${form.summary}
        </div>
      ` : nothing}
      <div class="auto-detail-text auto-detail-muted" style="margin-bottom:8px;">
        Answer here or reply via Telegram: <code>/prefire ${selectedTask.id}</code>
      </div>

      <div style="display:flex; flex-direction:column;">
        ${(form.fields ?? []).map(renderField)}
      </div>

      <div class="auto-detail-btns" style="margin-top:12px;">
        <button class="auto-btn small" @click=${() => onSave(false)}>${icons.save} Save answers</button>
        <button class="auto-btn small gold" @click=${() => onSave(true)}>${icons.check} Save &amp; mark ready</button>
        <button class="auto-btn small"
          @click=${() => {
            (selectedTask as any)._prefireGenerating = true;
            handlers.onGeneratePrefireForm?.(selectedTask.id);
          }}>${icons.refresh} Regenerate</button>
        ${ready
          ? html`<button class="auto-btn small gold" @click=${() => handlers.onStartLoop?.(selectedTask.id)}>${icons.play} Start loop</button>`
          : nothing}
      </div>
    </div>
  `;
}

function renderPrefireLegacyPanel(selectedTask: any, handlers: AutonomyHandlers): TemplateResult {
  const prefire = selectedTask?.context?.prefire ?? null;
  const successCriteria = prefire?.successCriteria ?? '';
  const targets: Array<{ description?: string; url?: string; selector?: string; expect?: string }> =
    Array.isArray(prefire?.testTargets) && prefire.testTargets.length > 0
      ? prefire.testTargets
      : [{ description: '' }];
  const maxIterations = typeof prefire?.maxIterations === 'number' ? prefire.maxIterations : 5;
  const testerEnabled = prefire?.testerEnabled !== false;
  const completed = !!prefire?.completed;
  const notes = prefire?.notes ?? '';

  const taskId = selectedTask.id as string;
  if (!prefireLegacyDraftsByTaskId.has(taskId)) {
    prefireLegacyDraftsByTaskId.set(taskId, {
      successCriteria,
      testTargets: targets.map((t) => ({ ...t })),
      maxIterations,
      testerEnabled,
      notes,
    });
  }
  const draft = prefireLegacyDraftsByTaskId.get(taskId)!;

  const setField = (field: string, value: unknown) => {
    (draft as any)[field] = value;
  };

  const onSave = (markCompleted: boolean) => {
    handlers.onSavePrefire?.(selectedTask.id, {
      successCriteria: draft.successCriteria.trim(),
      testTargets: (draft.testTargets as any[])
        .map((t) => ({
          description: (t.description ?? '').trim(),
          url: t.url?.trim() || undefined,
          selector: t.selector?.trim() || undefined,
          expect: t.expect?.trim() || undefined,
        }))
        .filter((t) => t.description),
      maxIterations: Math.max(1, Math.min(20, Number(draft.maxIterations) || 5)),
      testerEnabled: !!draft.testerEnabled,
      notes: (draft.notes ?? '').trim() || undefined,
      completed: markCompleted,
    });
  };

  return html`
    <div class="auto-detail-section">
      <div class="auto-detail-label">
        PRE-FIRE QUESTIONNAIRE
        ${completed
          ? html`<span class="auto-tag ok"><i class="gt-light" data-state="ok"></i>Ready</span>`
          : html`<span class="auto-tag warn">Pending</span>`}
      </div>
      <div class="auto-detail-text auto-detail-muted" style="margin-bottom:8px;">
        Closed-loop tester needs these answers before the build/test loop can run.
      </div>

      <div style="display:flex; flex-direction:column; gap:8px;">
        <label class="auto-detail-text">Success criteria
          <textarea
            class="auto-input"
            style="width:100%; min-height:60px; margin-top:4px;"
            placeholder="What does 'done' look like? Tester verifies against this."
            .value=${live(draft.successCriteria)}
            @input=${(e: Event) => setField('successCriteria', (e.target as HTMLTextAreaElement).value)}
          ></textarea>
        </label>

        <div>
          <div class="auto-detail-text">Test targets (Playwright will visit each)</div>
          ${(draft.testTargets as any[]).map((t, idx) => html`
            <div class="auto-target-card">
              <input
                class="auto-input"
                placeholder="Description (required)"
                .value=${live(t.description ?? '')}
                @input=${(e: Event) => { t.description = (e.target as HTMLInputElement).value; }}
              />
              <input
                class="auto-input"
                placeholder="URL (optional)"
                .value=${live(t.url ?? '')}
                @input=${(e: Event) => { t.url = (e.target as HTMLInputElement).value; }}
              />
              <input
                class="auto-input"
                placeholder="Selector (optional)"
                .value=${live(t.selector ?? '')}
                @input=${(e: Event) => { t.selector = (e.target as HTMLInputElement).value; }}
              />
              <input
                class="auto-input"
                placeholder="Expectation (optional)"
                .value=${live(t.expect ?? '')}
                @input=${(e: Event) => { t.expect = (e.target as HTMLInputElement).value; }}
              />
              ${(draft.testTargets as any[]).length > 1
                ? html`<button class="auto-btn small danger" @click=${() => { (draft.testTargets as any[]).splice(idx, 1); }}>${icons.minus} Remove</button>`
                : nothing}
            </div>
          `)}
          <button class="auto-btn small" style="margin-top:6px;" @click=${() => { (draft.testTargets as any[]).push({ description: '' }); }}>${icons.plus} Add target</button>
        </div>

        <div style="display:flex; gap:8px 14px; align-items:center; flex-wrap:wrap;">
          <label class="auto-detail-text" style="display:flex; gap:6px; align-items:center;">
            Max iterations
            <input
              type="number"
              min="1"
              max="20"
              class="auto-input"
              style="width:70px;"
              .value=${live(String(draft.maxIterations))}
              @input=${(e: Event) => setField('maxIterations', Number((e.target as HTMLInputElement).value))}
            />
          </label>
          <label class="auto-detail-text" style="display:flex; gap:6px; align-items:center;">
            <input
              type="checkbox"
              .checked=${!!draft.testerEnabled}
              @change=${(e: Event) => setField('testerEnabled', (e.target as HTMLInputElement).checked)}
            />
            Run tester (Playwright MCP)
          </label>
        </div>

        <label class="auto-detail-text">Notes for the loop (optional)
          <textarea
            class="auto-input"
            style="width:100%; min-height:40px; margin-top:4px;"
            placeholder="Anything the builder + tester should keep in mind"
            .value=${live(draft.notes)}
            @input=${(e: Event) => setField('notes', (e.target as HTMLTextAreaElement).value)}
          ></textarea>
        </label>

        <div class="auto-detail-btns" style="margin-top:2px;">
          <button class="auto-btn small" @click=${() => onSave(false)}>${icons.save} Save draft</button>
          <button class="auto-btn small gold" @click=${() => onSave(true)}>${icons.check} Mark complete</button>
          ${completed
            ? html`<button class="auto-btn small gold" @click=${() => handlers.onStartLoop?.(selectedTask.id)}>${icons.play} Start loop</button>`
            : nothing}
        </div>
      </div>
    </div>
  `;
}

function renderIterationHistory(selectedTask: any): TemplateResult {
  const iterations: any[] = Array.isArray(selectedTask?.iterations) ? selectedTask.iterations : [];
  if (iterations.length === 0) return html``;

  return html`
    <div class="auto-detail-section">
      <div class="auto-detail-label">
        ITERATION HISTORY
        ${selectedTask.currentPhase
          ? html`<span class="auto-tag">${String(selectedTask.currentPhase)}</span>`
          : nothing}
      </div>
      ${iterations.map((it: any) => {
        const pass = it.testerVerdict?.pass === true;
        const fail = it.testerVerdict && !pass;
        const tagClass = pass ? 'ok' : fail ? 'fail' : 'pending';
        const tagText = pass ? 'PASS' : fail ? 'FAIL' : (it.buildOutcome ?? 'running').toUpperCase();
        return html`
          <div class="auto-iter-card">
            <div class="auto-iter-head">
              <strong>Iteration ${it.number}</strong>
              <span class="auto-tag ${tagClass}">${tagText}</span>
            </div>
            ${it.testerVerdict?.summary
              ? html`<div class="auto-detail-text" style="margin-top:4px;">${it.testerVerdict.summary}</div>`
              : it.buildSummary
                ? html`<div class="auto-detail-text auto-detail-muted" style="margin-top:4px;">Builder: ${String(it.buildSummary).slice(0, 240)}${String(it.buildSummary).length > 240 ? '…' : ''}</div>`
                : nothing}
            ${Array.isArray(it.testerVerdict?.reasons) && it.testerVerdict.reasons.length > 0
              ? html`
                <details>
                  <summary class="auto-detail-text">Reasons (${it.testerVerdict.reasons.length})</summary>
                  <ul>
                    ${it.testerVerdict.reasons.map((r: string) => html`<li class="auto-detail-text">${r}</li>`)}
                  </ul>
                </details>`
              : nothing}
            ${Array.isArray(it.fixHints) && it.fixHints.length > 0 && fail
              ? html`
                <details>
                  <summary class="auto-detail-text auto-detail-warn">Fix hints (${it.fixHints.length})</summary>
                  <ul>
                    ${it.fixHints.map((h: string) => html`<li class="auto-detail-text">${h}</li>`)}
                  </ul>
                </details>`
              : nothing}
          </div>
        `;
      })}
    </div>
  `;
}

// =============================================================================
// STYLES — SLEEK BLACK & GOLD THEME
// =============================================================================

export const autonomyStyles = `
/* === DASHBOARD LAYOUT === */
.auto-dashboard {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: transparent;
  color: var(--text, #e4e4e7);
  font-family: var(--font-body, 'JetBrains Mono', monospace);
  overflow: hidden;
}

.auto-aurora {
  position: absolute;
  inset: -10%;
  pointer-events: none;
  z-index: 0;
  background:
    radial-gradient(900px 600px at 10% 0%, color-mix(in srgb, var(--g-primary) 9%, transparent) 0%, transparent 70%),
    radial-gradient(700px 500px at 100% 100%, color-mix(in srgb, var(--g-primary) 6%, transparent) 0%, transparent 75%),
    radial-gradient(600px 400px at 60% 40%, color-mix(in srgb, #f59e0b 4%, transparent) 0%, transparent 70%);
  filter: blur(40px);
  opacity: 0.95;
}

.auto-dashboard > *:not(.auto-aurora) {
  position: relative;
  z-index: 1;
}

.auto-grid {
  display: grid;
  grid-template-columns: 280px 1fr 320px;
  flex: 1;
  min-height: 0;
  gap: 14px;
  padding: 14px;
  background: transparent;
}

/* === HEADER === */
.auto-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 20px;
  margin: 14px 14px 0 14px;
  border-radius: 12px;
  background:
    linear-gradient(180deg,
      color-mix(in srgb, var(--g-primary) 6%, transparent) 0%,
      color-mix(in srgb, var(--g-primary) 2%, transparent) 100%),
    rgba(10, 10, 18, 0.45);
  backdrop-filter: blur(22px) saturate(160%);
  -webkit-backdrop-filter: blur(22px) saturate(160%);
  border: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
  flex-shrink: 0;
}

.auto-header-left {
  display: flex;
  align-items: center;
  gap: 20px;
}

.auto-logo {
  display: flex;
  align-items: center;
  gap: 10px;
}

.auto-logo-icon {
  color: var(--accent, var(--g-primary));
  font-size: 1.25rem;
  text-shadow: 0 0 10px var(--accent-glow, color-mix(in srgb, var(--g-primary) 30%, transparent));
}

.auto-logo-text {
  font-size: 0.85rem;
  font-weight: 600;
  letter-spacing: 0.15em;
  color: var(--text-strong, #ffffff);
}

.auto-status-row {
  display: flex;
  gap: 8px;
}

.auto-status-pill {
  padding: 4px 12px;
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.1em;
  border-radius: 2px;
  border: 1px solid;
}

.auto-status-pill.active {
  background: rgba(34, 197, 94, 0.15);
  border-color: rgba(34, 197, 94, 0.4);
  color: #22c55e;
}

.auto-status-pill.paused {
  background: rgba(245, 158, 11, 0.15);
  border-color: rgba(245, 158, 11, 0.4);
  color: #f59e0b;
}

.auto-status-pill.queue {
  background: rgba(59, 130, 246, 0.15);
  border-color: rgba(59, 130, 246, 0.4);
  color: #3b82f6;
}

.auto-status-pill.running {
  background: color-mix(in srgb, var(--g-primary) 15%, transparent);
  border-color: color-mix(in srgb, var(--g-primary) 40%, transparent);
  color: var(--accent, var(--g-primary));
  animation: pulse-gold 2s infinite;
}

@keyframes pulse-gold {
  0%, 100% { opacity: 1; box-shadow: 0 0 5px color-mix(in srgb, var(--g-primary) 20%, transparent); }
  50% { opacity: 0.7; box-shadow: 0 0 15px color-mix(in srgb, var(--g-primary) 40%, transparent); }
}

.auto-header-right {
  display: flex;
  align-items: center;
  gap: 24px;
}

.auto-metrics {
  display: flex;
  gap: 24px;
}

.auto-metric {
  text-align: center;
}

.auto-metric-value {
  font-size: 1.1rem;
  font-weight: 600;
  color: var(--accent, var(--g-primary));
}

.auto-metric-label {
  font-size: 0.6rem;
  color: var(--muted, #a1a1aa);
  letter-spacing: 0.1em;
}

.auto-actions {
  display: flex;
  gap: 8px;
}

/* === BUTTONS === */
.auto-btn {
  padding: 8px 16px;
  font-size: 0.75rem;
  font-weight: 600;
  font-family: inherit;
  letter-spacing: 0.05em;
  border: 1px solid color-mix(in srgb, var(--g-primary) 18%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--g-primary) 6%, transparent);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  color: var(--text, #e4e4e7);
  cursor: pointer;
  transition: all 0.15s;
}

.auto-btn:hover {
  border-color: var(--accent, var(--g-primary));
  box-shadow: 0 0 10px color-mix(in srgb, var(--g-primary) 10%, transparent);
}

.auto-btn.icon {
  padding: 8px 10px;
}

.auto-btn.gold {
  background: linear-gradient(180deg, var(--accent, var(--g-primary)), var(--accent-2, var(--g-primary)));
  border-color: var(--accent, var(--g-primary));
  color: #000;
}

.auto-btn.gold:hover {
  box-shadow: 0 0 20px color-mix(in srgb, var(--g-primary) 30%, transparent);
}

.auto-btn.warn {
  background: rgba(245, 158, 11, 0.2);
  border-color: #f59e0b;
  color: #f59e0b;
}

.auto-btn.danger {
  background: rgba(239, 68, 68, 0.2);
  border-color: #ef4444;
  color: #ef4444;
}

.auto-btn.small {
  padding: 4px 10px;
  font-size: 0.65rem;
}

.auto-btn.full {
  width: 100%;
}

/* === PANELS === */
.auto-panel {
  background:
    linear-gradient(180deg,
      color-mix(in srgb, var(--g-primary) 5%, transparent) 0%,
      color-mix(in srgb, var(--g-primary) 2%, transparent) 100%),
    rgba(10, 10, 18, 0.42);
  backdrop-filter: blur(22px) saturate(150%);
  -webkit-backdrop-filter: blur(22px) saturate(150%);
  border: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
}

.auto-panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
  flex-shrink: 0;
}

.auto-panel-title {
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.15em;
  color: var(--muted, #a1a1aa);
}

.auto-panel-count {
  font-size: 0.7rem;
  color: var(--accent, var(--g-primary));
}

.auto-panel-body {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
}

/* === TABS === */
.auto-tabs {
  display: flex;
  border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
  flex-shrink: 0;
}

.auto-tab {
  flex: 1;
  padding: 10px 16px;
  font-size: 0.7rem;
  font-weight: 600;
  font-family: inherit;
  letter-spacing: 0.1em;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--muted, #a1a1aa);
  cursor: pointer;
  transition: all 0.15s;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

.auto-tab:hover {
  color: var(--text, #e4e4e7);
}

.auto-tab.active {
  color: var(--accent, var(--g-primary));
  border-bottom-color: var(--accent, var(--g-primary));
}

.auto-tab-badge {
  background: var(--accent, var(--g-primary));
  color: #000;
  font-size: 0.6rem;
  padding: 2px 6px;
  border-radius: 2px;
}

/* === TASK CARDS === */
.auto-queue-section {
  margin-bottom: 16px;
}

.auto-section-label {
  font-size: 0.65rem;
  font-weight: 600;
  letter-spacing: 0.1em;
  color: var(--muted, #a1a1aa);
  margin-bottom: 8px;
  padding: 4px 8px;
  background: color-mix(in srgb, var(--g-primary) 3%, transparent);
  border: 1px solid color-mix(in srgb, var(--g-primary) 10%, transparent);
  border-radius: 6px;
}

.auto-section-label.gold {
  color: var(--accent, var(--g-primary));
  background: color-mix(in srgb, var(--g-primary) 10%, transparent);
}

.auto-section-label.muted {
  color: var(--muted-strong, #71717a);
}

.auto-task-card {
  padding: 10px 12px;
  margin-bottom: 6px;
  background: color-mix(in srgb, var(--g-primary) 4%, transparent);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
  border-left: 3px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.15s;
}

.auto-task-card:hover {
  border-color: color-mix(in srgb, var(--g-primary) 32%, transparent);
}

.auto-task-card.selected {
  border-left-color: var(--accent, var(--g-primary));
  background: color-mix(in srgb, var(--g-primary) 5%, transparent);
}

.auto-task-card.running {
  border-left-color: var(--accent, var(--g-primary));
  box-shadow: 0 0 10px color-mix(in srgb, var(--g-primary) 10%, transparent);
}

.auto-task-card.completed {
  opacity: 0.6;
}

.auto-task-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.auto-task-status {
  font-size: 0.9rem;
}

.auto-task-status.running { color: var(--accent, var(--g-primary)); }
.auto-task-status.completed { color: var(--ok, #22c55e); }

.auto-task-title {
  font-size: 0.8rem;
  font-weight: 500;
  color: var(--text, #e4e4e7);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.auto-task-meta {
  display: flex;
  gap: 8px;
  font-size: 0.65rem;
}

.auto-task-priority {
  color: var(--muted, #a1a1aa);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.auto-task-priority.critical { color: #ef4444; }
.auto-task-priority.high { color: #f97316; }
.auto-task-priority.medium { color: var(--accent, var(--g-primary)); }
.auto-task-priority.normal { color: var(--accent, var(--g-primary)); }

.auto-task-project {
  color: var(--muted-strong, #71717a);
}

/* === OVERVIEW === */
.auto-overview {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.auto-stats-row {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 12px;
}

.auto-stat-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px;
  background: color-mix(in srgb, var(--g-primary) 5%, transparent);
  backdrop-filter: blur(14px) saturate(140%);
  -webkit-backdrop-filter: blur(14px) saturate(140%);
  border: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
  border-radius: 10px;
}

.auto-stat-icon {
  font-size: 1.5rem;
  color: var(--muted, #a1a1aa);
}

.auto-stat-icon.gold { color: var(--accent, var(--g-primary)); }
.auto-stat-icon.green { color: var(--ok, #22c55e); }
.auto-stat-icon.red { color: #ef4444; }

.auto-stat-value {
  font-size: 1.25rem;
  font-weight: 600;
  color: var(--text-strong, #ffffff);
}

.auto-stat-label {
  font-size: 0.6rem;
  color: var(--muted, #a1a1aa);
  letter-spacing: 0.1em;
}

.auto-section {
  background: color-mix(in srgb, var(--g-primary) 4%, transparent);
  backdrop-filter: blur(14px) saturate(140%);
  -webkit-backdrop-filter: blur(14px) saturate(140%);
  border: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
  border-radius: 10px;
  overflow: hidden;
}

.auto-section-header {
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.1em;
  color: var(--muted, #a1a1aa);
  padding: 10px 14px;
  border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
}

.auto-current-task {
  padding: 14px;
}

.auto-current-title {
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--text-strong, #ffffff);
  margin-bottom: 8px;
}

.auto-current-meta {
  display: flex;
  gap: 12px;
  margin-bottom: 8px;
}

.auto-tag {
  font-size: 0.65rem;
  padding: 2px 8px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.05);
  color: var(--muted, #a1a1aa);
}

.auto-tag.critical { background: rgba(239, 68, 68, 0.2); color: #ef4444; }
.auto-tag.high { background: rgba(249, 115, 22, 0.2); color: #f97316; }
.auto-tag.medium, .auto-tag.normal { background: color-mix(in srgb, var(--g-primary) 15%, transparent); color: var(--accent, var(--g-primary)); }
.auto-tag.project { background: rgba(59, 130, 246, 0.15); color: #3b82f6; }

.auto-duration {
  font-size: 0.75rem;
  color: var(--muted, #a1a1aa);
}

.auto-current-desc {
  font-size: 0.8rem;
  color: var(--muted, #a1a1aa);
  line-height: 1.5;
}

.auto-empty-section {
  padding: 24px;
  text-align: center;
  color: var(--muted-strong, #71717a);
  font-size: 0.8rem;
}

.auto-system-grid {
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.auto-system-item {
  display: grid;
  grid-template-columns: 50px 1fr 40px;
  align-items: center;
  gap: 12px;
}

.auto-system-label {
  font-size: 0.65rem;
  color: var(--muted, #a1a1aa);
  letter-spacing: 0.05em;
}

.auto-system-value {
  font-size: 0.75rem;
}

.auto-system-value.active { color: var(--ok, #22c55e); }
.auto-system-value.idle { color: var(--warn, #f59e0b); }

.auto-progress {
  height: 6px;
  background: color-mix(in srgb, #000 35%, transparent);
  border: 1px solid color-mix(in srgb, var(--g-primary) 12%, transparent);
  border-radius: 6px;
  overflow: hidden;
}

.auto-progress-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--accent, var(--g-primary)), var(--accent-2, var(--g-primary)));
  transition: width 0.3s;
}

.auto-system-percent {
  font-size: 0.7rem;
  color: var(--muted, #a1a1aa);
  text-align: right;
}

.auto-checklist {
  padding: 14px;
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
}

.auto-check-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.75rem;
  color: var(--muted, #a1a1aa);
}

.auto-check {
  font-size: 0.8rem;
}

.auto-check.gold {
  color: var(--accent, var(--g-primary));
}

.auto-check.pending {
  color: color-mix(in srgb, var(--g-primary) 40%, var(--muted, #a1a1aa));
}

.auto-check-item .dim {
  color: var(--muted-strong, #71717a);
}

/* === QUEUE LIST === */
.auto-queue-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.auto-queue-group {
  background: color-mix(in srgb, var(--g-primary) 4%, transparent);
  backdrop-filter: blur(12px) saturate(140%);
  -webkit-backdrop-filter: blur(12px) saturate(140%);
  border: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
  border-radius: 10px;
}

.auto-queue-group-header {
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.1em;
  color: var(--muted, #a1a1aa);
  padding: 10px 14px;
  border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
}

.auto-queue-group-header.gold {
  color: var(--accent, var(--g-primary));
}

.auto-queue-group-header.muted {
  color: var(--muted-strong, #71717a);
}

.auto-queue-item {
  padding: 14px;
  border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
}

.auto-queue-item:last-child {
  border-bottom: none;
}

.auto-queue-item-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}

.auto-queue-item-title {
  font-size: 0.85rem;
  font-weight: 500;
  color: var(--text, #e4e4e7);
}

.auto-queue-item-status {
  font-size: 0.6rem;
  letter-spacing: 0.05em;
  color: var(--muted, #a1a1aa);
}

.auto-queue-item-desc {
  font-size: 0.8rem;
  color: var(--muted, #a1a1aa);
  margin-bottom: 8px;
  line-height: 1.4;
}

.auto-queue-item-meta {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.auto-queue-item-actions {
  display: flex;
  gap: 8px;
  padding-top: 10px;
  border-top: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
}

.auto-outcome {
  padding: 8px 12px;
  border-radius: 2px;
  font-size: 0.8rem;
  margin-top: 8px;
}

.auto-outcome.success {
  background: rgba(34, 197, 94, 0.1);
  border: 1px solid rgba(34, 197, 94, 0.3);
  color: #22c55e;
}

.auto-outcome.error {
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.3);
  color: #ef4444;
}

/* === AUDIT === */
.auto-audit {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.auto-audit-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.auto-chain-status {
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.1em;
  padding: 6px 12px;
  border-radius: 2px;
}

.auto-chain-status.valid {
  background: rgba(34, 197, 94, 0.1);
  border: 1px solid rgba(34, 197, 94, 0.3);
  color: #22c55e;
}

.auto-chain-status.invalid {
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.3);
  color: #ef4444;
}

.auto-cage-alert {
  font-size: 0.7rem;
  font-weight: 600;
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.3);
  color: #ef4444;
  padding: 6px 12px;
  border-radius: 2px;
}

.auto-audit-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.auto-audit-entry {
  display: grid;
  grid-template-columns: 60px 1fr 100px 80px;
  gap: 12px;
  padding: 10px 12px;
  background: color-mix(in srgb, var(--g-primary) 3%, transparent);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
  border-radius: 8px;
  font-size: 0.75rem;
  align-items: center;
}

.auto-audit-entry.cage {
  border-left: 3px solid #ef4444;
}

.auto-audit-time {
  color: var(--muted-strong, #71717a);
}

.auto-audit-type {
  color: var(--accent, var(--g-primary));
}

.auto-audit-desc {
  color: var(--muted, #a1a1aa);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.auto-audit-outcome {
  text-align: right;
}

.auto-audit-outcome.success { color: #22c55e; }
.auto-audit-outcome.failure { color: #ef4444; }
.auto-audit-outcome.pending { color: #f59e0b; }

/* === API === */
.auto-api {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.auto-api-stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}

.auto-api-stat {
  text-align: center;
  padding: 20px;
  background: color-mix(in srgb, var(--g-primary) 5%, transparent);
  backdrop-filter: blur(14px) saturate(140%);
  -webkit-backdrop-filter: blur(14px) saturate(140%);
  border: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
  border-radius: 10px;
}

.auto-api-value {
  font-size: 1.5rem;
  font-weight: 600;
  color: var(--accent, var(--g-primary));
}

.auto-api-label {
  font-size: 0.6rem;
  color: var(--muted, #a1a1aa);
  letter-spacing: 0.1em;
  margin-top: 4px;
}

.auto-usage-bar {
  height: 20px;
  background: color-mix(in srgb, #000 35%, transparent);
  border: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
  border-radius: 8px;
  overflow: hidden;
  margin-top: 12px;
}

.auto-usage-fill.auto {
  height: 100%;
  background: linear-gradient(90deg, var(--accent, var(--g-primary)), var(--accent-2, var(--g-primary)));
}

.auto-usage-legend {
  display: flex;
  justify-content: space-between;
  margin-top: 8px;
  font-size: 0.75rem;
}

.auto-legend-item.auto { color: var(--accent, var(--g-primary)); }
.auto-legend-item.interactive { color: var(--muted, #a1a1aa); }

/* === DETAIL PANEL === */
.auto-detail-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--muted-strong, #71717a);
  gap: 8px;
}

.auto-detail-empty-icon {
  font-size: 2rem;
  opacity: 0.3;
}

.auto-detail {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.auto-detail-title {
  font-size: 1rem;
  font-weight: 600;
  color: var(--text-strong, #ffffff);
}

.auto-detail-status {
  display: inline-block;
  font-size: 0.65rem;
  font-weight: 600;
  letter-spacing: 0.1em;
  padding: 4px 10px;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 2px;
  color: var(--muted, #a1a1aa);
}

.auto-detail-status.in_progress, .auto-detail-status.running {
  background: color-mix(in srgb, var(--g-primary) 15%, transparent);
  color: var(--accent, var(--g-primary));
}

.auto-detail-status.completed, .auto-detail-status.complete {
  background: rgba(34, 197, 94, 0.15);
  color: #22c55e;
}

.auto-detail-status.blocked, .auto-detail-status.failed {
  background: rgba(239, 68, 68, 0.15);
  color: #ef4444;
}

.auto-detail-section {
  padding: 12px;
  background: color-mix(in srgb, var(--g-primary) 4%, transparent);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
  border-radius: 8px;
}

.auto-detail-label {
  font-size: 0.6rem;
  font-weight: 600;
  letter-spacing: 0.1em;
  color: var(--muted-strong, #71717a);
  margin-bottom: 6px;
}

.auto-detail-text {
  font-size: 0.85rem;
  color: var(--text, #e4e4e7);
  line-height: 1.5;
}

.auto-detail-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
  padding-top: 16px;
  border-top: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
}

/* === EMPTY STATES === */
.auto-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  color: var(--muted-strong, #71717a);
  gap: 8px;
}

.auto-empty-icon {
  font-size: 2rem;
  opacity: 0.3;
}

/* === LOADING / ERROR === */
.auto-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 16px;
  color: var(--muted, #a1a1aa);
}

.auto-spinner {
  width: 32px;
  height: 32px;
  border: 2px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
  border-top-color: var(--accent, var(--g-primary));
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.auto-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 12px;
  color: var(--muted, #a1a1aa);
}

.auto-error-icon {
  font-size: 2rem;
  color: #ef4444;
}

.auto-error-text {
  font-size: 0.85rem;
}

/* === PROJECTS TAB === */
.auto-projects {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.auto-projects-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  background: color-mix(in srgb, var(--g-primary) 4%, transparent);
  border: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
  border-radius: 8px;
  font-size: 0.72rem;
  color: var(--muted, #a1a1aa);
  letter-spacing: 0.06em;
}

.auto-projects-summary { color: var(--muted, #a1a1aa); }

.auto-project-card {
  padding: 14px;
  background: color-mix(in srgb, var(--g-primary) 4%, transparent);
  backdrop-filter: blur(14px) saturate(140%);
  -webkit-backdrop-filter: blur(14px) saturate(140%);
  border: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.auto-project-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}

.auto-project-name {
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--text-strong, #ffffff);
  display: flex;
  align-items: center;
  gap: 8px;
}

.auto-project-stats {
  font-size: 0.7rem;
  color: var(--muted, #a1a1aa);
  display: flex;
  gap: 6px;
}

.auto-project-stats .gold { color: var(--accent, var(--g-primary)); }

.auto-project-desc {
  font-size: 0.78rem;
  color: var(--muted, #a1a1aa);
  line-height: 1.45;
}

.auto-project-empty {
  font-size: 0.72rem;
  color: var(--muted-strong, #71717a);
  font-style: italic;
}

.auto-project-tasks {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 4px;
}

.auto-project-task {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 8px 10px;
  background: color-mix(in srgb, var(--g-primary) 3%, transparent);
  border: 1px solid color-mix(in srgb, var(--g-primary) 12%, transparent);
  border-radius: 6px;
}

.auto-project-task-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.auto-project-task-title {
  font-size: 0.82rem;
  color: var(--text, #e4e4e7);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.auto-project-task-meta {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.auto-project-more {
  font-size: 0.7rem;
  color: var(--muted-strong, #71717a);
  text-align: center;
  padding-top: 4px;
}

.auto-projects-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 50px 20px;
  gap: 8px;
  color: var(--muted, #a1a1aa);
  text-align: center;
}

.auto-empty-hint {
  font-size: 0.72rem;
  color: var(--muted-strong, #71717a);
  max-width: 360px;
}

/* === AUDIT TOOLBAR === */
.auto-audit-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 2px;
}

.auto-audit-search {
  flex: 1;
}

.auto-audit-count {
  font-size: 0.7rem;
  color: var(--muted-strong, #71717a);
  letter-spacing: 0.06em;
}

/* === MODAL === */
.auto-modal-backdrop {
  position: absolute;
  inset: 0;
  z-index: 100;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 30px;
}

.auto-modal {
  width: min(560px, 100%);
  background:
    linear-gradient(180deg,
      color-mix(in srgb, var(--g-primary) 7%, transparent) 0%,
      color-mix(in srgb, var(--g-primary) 3%, transparent) 100%),
    rgba(10, 10, 18, 0.7);
  backdrop-filter: blur(28px) saturate(160%);
  -webkit-backdrop-filter: blur(28px) saturate(160%);
  border: 1px solid color-mix(in srgb, var(--g-primary) 22%, transparent);
  border-radius: 14px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.auto-modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px 18px;
  border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
  font-size: 0.78rem;
  font-weight: 600;
  letter-spacing: 0.12em;
  color: var(--accent, var(--g-primary));
}

.auto-modal-close {
  background: none;
  border: none;
  color: var(--muted, #a1a1aa);
  cursor: pointer;
  font-size: 1.05rem;
  padding: 2px 6px;
}

.auto-modal-close:hover { color: var(--text-strong, #ffffff); }

.auto-modal-body {
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.auto-modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 18px 18px;
}

.auto-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.auto-field-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.auto-field-label {
  font-size: 0.62rem;
  font-weight: 600;
  letter-spacing: 0.12em;
  color: var(--muted-strong, #71717a);
}

.auto-field-check {
  flex-direction: row;
  align-items: center;
  gap: 8px;
  font-size: 0.78rem;
  color: var(--muted, #a1a1aa);
}

.auto-input {
  font-family: inherit;
  font-size: 0.82rem;
  color: var(--text, #e4e4e7);
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--g-primary) 18%, transparent);
  background: color-mix(in srgb, #000 30%, transparent);
  outline: none;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.auto-input:focus {
  border-color: color-mix(in srgb, var(--g-primary) 50%, transparent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--g-primary) 18%, transparent);
}

.auto-textarea {
  min-height: 96px;
  resize: vertical;
  font-family: inherit;
  line-height: 1.5;
}

/* === RESPONSIVE === */
@media (max-width: 1200px) {
  .auto-grid {
    grid-template-columns: 250px 1fr 260px;
  }
  
  .auto-stats-row {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 900px) {
  .auto-grid {
    grid-template-columns: 1fr;
  }
  
  .auto-queue-panel, .auto-detail-panel {
    display: none;
  }
  
  .auto-header {
    flex-direction: column;
    gap: 12px;
  }
}

/* ── Task oversight strip on the queue card ────────────────────────── */
.auto-task-oversight {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid rgba(255, 215, 0, 0.10);
}
.auto-task-oversight-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
  font-size: 10px;
  letter-spacing: 0.04em;
}
.auto-task-oversight-label {
  color: var(--muted-strong, #71717a);
  text-transform: uppercase;
  font-weight: 600;
}
.auto-task-oversight-value {
  color: var(--text, #f5f5f5);
  font-weight: 600;
}
.auto-task-oversight-value.gold { color: var(--g-primary, #ffd700); }
.auto-task-oversight-value.green { color: #22c55e; }
.auto-task-oversight-value.red { color: #ef4444; }
.auto-task-oversight-value.muted { color: var(--muted-strong, #71717a); font-weight: 500; }
.auto-task-runtime {
  font-size: 10px;
  color: var(--muted-strong, #71717a);
  margin-left: auto;
}

/* ── Detail-panel oversight grid (6 cells) ─────────────────────────── */
.auto-oversight-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin-top: 4px;
}
.auto-oversight-cell {
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 215, 0, 0.10);
  border-radius: 6px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.auto-oversight-cell-label {
  font-size: 10px;
  letter-spacing: 0.06em;
  color: var(--muted-strong, #71717a);
  font-weight: 600;
}
.auto-oversight-cell-value {
  font-size: 13px;
  font-weight: 600;
  color: var(--text, #f5f5f5);
}
.auto-oversight-cell-value.gold { color: var(--g-primary, #ffd700); }
.auto-oversight-cell-value.green { color: #22c55e; }
.auto-oversight-cell-value.red { color: #ef4444; }
.auto-oversight-cell-value.muted { color: var(--muted-strong, #71717a); }
.auto-oversight-cell-value .gold { color: var(--g-primary, #ffd700); }
.auto-oversight-cell-value .muted { color: var(--muted-strong, #71717a); }
.auto-oversight-cell-value .danger { color: #ef4444; }
.auto-oversight-session {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.auto-session-key {
  font-family: var(--font-mono, ui-monospace, Menlo, monospace);
  font-size: 10px;
  color: var(--muted-strong, #71717a);
  overflow-wrap: anywhere;
}

/* ── Activity log feed ─────────────────────────────────────────────── */
.auto-activity-section {
  display: flex;
  flex-direction: column;
}
.auto-activity-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.auto-activity-header-meta {
  display: flex;
  align-items: center;
  gap: 6px;
}
.auto-activity-feed {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 360px;
  overflow-y: auto;
  margin-top: 8px;
  padding-right: 4px;
}
.auto-activity-feed::-webkit-scrollbar { width: 6px; }
.auto-activity-feed::-webkit-scrollbar-thumb {
  background: rgba(255, 215, 0, 0.15);
  border-radius: 4px;
}
.auto-activity-entry {
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 215, 0, 0.08);
  border-left: 3px solid var(--muted-strong, #71717a);
  border-radius: 4px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.auto-activity-entry.success { border-left-color: #22c55e; }
.auto-activity-entry.danger { border-left-color: #ef4444; }
.auto-activity-entry.warn { border-left-color: #f59e0b; }
.auto-activity-entry.muted { border-left-color: var(--muted-strong, #71717a); }
.auto-activity-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}
.auto-activity-icon {
  font-size: 12px;
  width: 12px;
  text-align: center;
}
.auto-activity-icon.success { color: #22c55e; }
.auto-activity-icon.danger { color: #ef4444; }
.auto-activity-icon.warn { color: #f59e0b; }
.auto-activity-icon.muted { color: var(--muted-strong, #71717a); }
.auto-activity-time {
  font-family: var(--font-mono, ui-monospace, Menlo, monospace);
  font-size: 10px;
  color: var(--muted-strong, #71717a);
  white-space: nowrap;
}
.auto-activity-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text, #f5f5f5);
  text-transform: capitalize;
  flex: 1;
  min-width: 0;
}
.auto-activity-outcome {
  font-size: 9px;
  letter-spacing: 0.06em;
  padding: 1px 6px;
  border-radius: 3px;
  font-weight: 700;
  background: rgba(255, 255, 255, 0.04);
}
.auto-activity-outcome.success { color: #22c55e; background: rgba(34, 197, 94, 0.10); }
.auto-activity-outcome.danger { color: #ef4444; background: rgba(239, 68, 68, 0.10); }
.auto-activity-outcome.warn { color: #f59e0b; background: rgba(245, 158, 11, 0.10); }
.auto-activity-outcome.muted { color: var(--muted-strong, #71717a); }
.auto-activity-meta {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  margin-top: 2px;
}
.auto-activity-meta .auto-tag {
  font-size: 9px;
  padding: 1px 6px;
  letter-spacing: 0.04em;
}
.auto-activity-meta .auto-tag.mono {
  font-family: var(--font-mono, ui-monospace, Menlo, monospace);
}
.auto-activity-detail {
  font-size: 11px;
  color: var(--text, #f5f5f5);
  opacity: 0.85;
  margin-top: 2px;
  white-space: pre-wrap;
  word-break: break-word;
}
.auto-activity-sublabel {
  font-size: 9px;
  letter-spacing: 0.08em;
  color: var(--muted-strong, #71717a);
  font-weight: 600;
  margin-top: 4px;
}
.auto-activity-list {
  list-style: none;
  margin: 2px 0 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.auto-activity-list li {
  font-size: 11px;
  color: var(--text, #f5f5f5);
  opacity: 0.8;
  padding-left: 12px;
  position: relative;
}
.auto-activity-list li::before {
  content: '·';
  position: absolute;
  left: 4px;
  color: var(--g-primary, #ffd700);
}
.auto-activity-list li.mono {
  font-family: var(--font-mono, ui-monospace, Menlo, monospace);
  word-break: break-all;
}

/* ── v2 shell (Goals-first layout). InfiniBot tokens only. ─────────── */
.auto-dashboard.auto-v2 {
  overflow: auto;
  padding: 16px 20px 24px;
  gap: 14px;
  font-family: var(--font-body, inherit);
}
.auto-dashboard.auto-v2 > * {
  flex-shrink: 0;
}
.auto-v2-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.auto-v2-title {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.auto-v2-title h1 {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--text-strong, var(--text));
  font-family: var(--font-display, inherit);
}
.auto-v2-pill {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 9px;
  border-radius: var(--radius-full, 999px);
  border: 1px solid currentColor;
}
.auto-v2-pill.active { color: var(--ok); }
.auto-v2-pill.paused { color: var(--warn); }
.auto-v2-pill.running { color: var(--info, var(--accent)); }
.auto-v2-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.auto-v2-btn {
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  min-height: 36px;
  padding: 6px 14px;
  border-radius: var(--radius-md, 8px);
  border: 1px solid var(--border-strong, var(--border));
  background: var(--panel, transparent);
  color: var(--text);
  cursor: pointer;
}
.auto-v2-btn:hover { border-color: var(--accent); }
.auto-v2-btn.icon { width: 36px; padding: 0; }
.auto-v2-btn.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-foreground);
}
.auto-v2-nav {
  display: flex;
  gap: 2px;
  border-bottom: 1px solid var(--border);
  overflow-x: auto;
  scrollbar-width: none;
}
.auto-v2-tab {
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--muted);
  padding: 10px 12px;
  min-height: 40px;
  cursor: pointer;
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.auto-v2-tab:hover { color: var(--text); }
.auto-v2-tab.on {
  color: var(--text-strong, var(--text));
  border-bottom-color: var(--accent);
}
.auto-v2-tab:focus-visible, .auto-v2-subtab:focus-visible, .auto-v2-btn:focus-visible {
  outline: 2px solid var(--focus, var(--accent));
  outline-offset: 2px;
}
.auto-v2-badge {
  font-size: 10.5px;
  font-weight: 600;
  min-width: 18px;
  padding: 0 5px;
  border-radius: var(--radius-full, 999px);
  background: var(--accent-subtle, var(--bg-hover));
  color: var(--text);
  text-align: center;
}
.auto-v2-subbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}
.auto-v2-subtabs { display: flex; gap: 4px; }
.auto-v2-subtab {
  font: inherit;
  font-size: 12px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--muted);
  padding: 5px 10px;
  min-height: 32px;
  border-radius: var(--radius-full, 999px);
  cursor: pointer;
  display: inline-flex;
  gap: 6px;
  align-items: center;
}
.auto-v2-subtab.on {
  color: var(--text);
  border-color: var(--border-strong, var(--border));
  background: var(--bg-hover);
}
.auto-v2 .auto-grid {
  padding: 0;
  flex: none;
  min-height: 520px;
}
.auto-v2-activity {
  display: grid;
  grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
  gap: 14px;
}
.auto-v2-settings { max-width: 880px; }
@media (max-width: 900px) {
  .auto-dashboard.auto-v2 { padding: 12px 12px 20px; }
  .auto-v2 .auto-queue-panel, .auto-v2 .auto-detail-panel { display: flex; }
  .auto-v2 .auto-grid { min-height: 0; }
  .auto-v2-activity { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 480px) {
  .auto-v2-title h1 { font-size: 18px; }
  .auto-v2-head { align-items: flex-start; }
  .auto-v2-actions { width: 100%; }
  .auto-v2-actions .auto-telegram-chip { flex: 1; min-width: 0; }
}
`;

// =============================================================================
// STYLE INJECTION
// =============================================================================

let autonomyStylesInjected = false;

export function injectAutonomyStyles(): void {
  if (autonomyStylesInjected) return;
  autonomyStylesInjected = true;
  
  const style = document.createElement('style');
  style.id = 'autonomy-dashboard-styles';
  style.textContent = autonomyStyles;
  document.head.appendChild(style);
}
