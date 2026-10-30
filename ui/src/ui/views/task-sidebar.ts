/**
 * Task Sidebar — Persistent Real-Time Task List
 * Shows active tasks, progress, and real-time updates with alerts
 */

import { html, nothing } from "lit";
import "./work-glass/remaining.css";
import { icons } from "../icons";
import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";
import type { KanbanTask, TaskStatus } from "../types";

// ============================================================
// State
// ============================================================

interface TaskAlert {
  id: string;
  type: "completed" | "failed" | "started" | "blocked";
  taskTitle: string;
  timestamp: number;
  dismissed: boolean;
}

interface EditModalState {
  open: boolean;
  task: KanbanTask | null;
  prompt: string;
  sending: boolean;
  error: string | null;
}

let sidebarOpen = true;
let sidebarMinimized = false;
let cachedTasks: KanbanTask[] = [];
let previousTasks: Map<string, KanbanTask> = new Map();
let alerts: TaskAlert[] = [];
let lastPollTime = 0;
let pollIntervalId: number | null = null;
const POLL_INTERVAL = 5000; // 5 seconds

// Edit modal state
let editModal: EditModalState = {
  open: false,
  task: null,
  prompt: "",
  sending: false,
  error: null,
};

function openEditModal(task: KanbanTask, state: AppViewState) {
  editModal = {
    open: true,
    task,
    prompt: "",
    sending: false,
    error: null,
  };
  state.requestUpdate?.();
}

function closeEditModal(state: AppViewState) {
  editModal = {
    open: false,
    task: null,
    prompt: "",
    sending: false,
    error: null,
  };
  state.requestUpdate?.();
}

async function sendEditPrompt(client: GatewayBrowserClient | null | undefined, state: AppViewState) {
  if (!client || !editModal.task || !editModal.prompt.trim()) return;
  
  editModal.sending = true;
  editModal.error = null;
  state.requestUpdate?.();
  
  try {
    // Build the restart message with task context
    const taskContext = `
TASK CONTEXT:
- Title: ${editModal.task.title}
- Description: ${editModal.task.description || "No description"}
- Status: ${editModal.task.status}
- Priority: ${editModal.task.priority || "normal"}
${editModal.task.assignee ? `- Assignee: ${editModal.task.assignee}` : ""}

USER EDIT/FEEDBACK:
${editModal.prompt}

Please continue working on this task with the updated context above. Update the task status as needed.
`.trim();

    // Send to agent via sessions.spawn for isolated execution. (`sessions_spawn`
    // is the MCP tool name and was never served as an RPC.) The client rejects
    // on gateway errors, so a resolved call without `status: "accepted"` is the
    // only failure shape left to check.
    const res = await client.request<{ status?: string }>("sessions.spawn", {
      task: taskContext,
      label: `Edit: ${editModal.task.title.slice(0, 30)}`,
      agentId: editModal.task.assignee || "main",
    });

    if (res?.status !== "accepted") {
      throw new Error("Failed to restart task");
    }
    
    // Add alert
    addAlert("started", `Restarted: ${editModal.task.title}`);
    
    closeEditModal(state);
  } catch (err) {
    editModal.error = err instanceof Error ? err.message : "Failed to send";
    editModal.sending = false;
    state.requestUpdate?.();
  }
}

async function approveTask(task: KanbanTask, client: GatewayBrowserClient | null | undefined, state: AppViewState) {
  if (!client) return;
  try {
    // Mark task as done
    await client.request("kanban", {
      action: "update_task",
      task_id: task.id,
      status: "done",
    });
    
    addAlert("completed", task.title);
    
    // Refresh tasks
    await pollTasks(client, state);
  } catch (err) {
    console.error("Failed to approve task:", err);
  }
}

// ============================================================
// Task Polling
// ============================================================

async function pollTasks(client: GatewayBrowserClient | null | undefined, state: AppViewState) {
  if (!client) return;
  try {
    const res = await client.request<{ ok?: boolean; result?: { tasks?: KanbanTask[] } }>("kanban", {
      action: "list_tasks",
    });
    if (!res?.ok) return;
    
    const newTasks = res.result?.tasks ?? [];
    
    // Detect changes and generate alerts
    for (const task of newTasks) {
      const prev = previousTasks.get(task.id);
      
      if (!prev) {
        // New task appeared
        if (task.status === "in_progress") {
          addAlert("started", task.title);
        }
      } else if (prev.status !== task.status) {
        // Status changed
        if (task.status === "done" && prev.status === "in_progress") {
          addAlert("completed", task.title);
        } else if (task.status === "review" && prev.status === "in_progress") {
          addAlert("blocked", task.title);
        } else if (task.status === "in_progress" && prev.status !== "in_progress") {
          addAlert("started", task.title);
        }
      }
    }
    
    // Update cache
    cachedTasks = newTasks;
    previousTasks.clear();
    for (const task of newTasks) {
      previousTasks.set(task.id, { ...task });
    }
    
    lastPollTime = Date.now();
    state.requestUpdate?.();
  } catch (err) {
    console.error("Task polling error:", err);
  }
}

function addAlert(type: TaskAlert["type"], taskTitle: string) {
  const alert: TaskAlert = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type,
    taskTitle,
    timestamp: Date.now(),
    dismissed: false,
  };
  alerts.unshift(alert);
  
  // Auto-dismiss after 8 seconds
  setTimeout(() => {
    const idx = alerts.findIndex(a => a.id === alert.id);
    if (idx >= 0) {
      alerts[idx].dismissed = true;
    }
  }, 8000);
  
  // Keep only last 10 alerts
  if (alerts.length > 10) {
    alerts = alerts.slice(0, 10);
  }
}

function dismissAlert(id: string) {
  const idx = alerts.findIndex(a => a.id === id);
  if (idx >= 0) {
    alerts[idx].dismissed = true;
  }
}

function startPolling(client: GatewayBrowserClient | null | undefined, state: AppViewState) {
  if (pollIntervalId) return;
  if (!client) return;
  
  // Initial poll
  pollTasks(client, state);
  
  // Set up interval
  pollIntervalId = window.setInterval(() => {
    pollTasks(client, state);
  }, POLL_INTERVAL);
}

function stopPolling() {
  if (pollIntervalId) {
    clearInterval(pollIntervalId);
    pollIntervalId = null;
  }
}

// ============================================================
// Helpers
// ============================================================

function formatRelativeTime(ts: number): string {
  const ms = Date.now() - ts;
  if (ms < 60_000) return "now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function taskStatusIcon(status: TaskStatus): unknown {
  switch (status) {
    case "done": return icons.checkCircle;
    case "in_progress": return icons.refresh;
    case "review": return icons.eye;
    case "todo": return icons.layoutList;
    case "backlog": return icons.folder;
    default: return icons.circle;
  }
}

function taskStatusColor(status: TaskStatus): string {
  switch (status) {
    case "done": return "#22c55e";
    case "in_progress": return "#f59e0b";
    case "review": return "#a855f7";
    case "todo": return "#3b82f6";
    case "backlog": return "#6b7280";
    default: return "#71717a";
  }
}

function priorityDot(priority?: string): unknown {
  switch (priority) {
    case "critical": return html`<span style="color:#ef4444">${icons.circle}</span>`;
    case "high": return html`<span style="color:#f59e0b">${icons.circle}</span>`;
    case "medium": case "normal": return nothing;
    case "low": return html`<span style="color:#22c55e">${icons.circle}</span>`;
    default: return nothing;
  }
}

function alertIcon(type: TaskAlert["type"]): unknown {
  switch (type) {
    case "completed": return icons.checkCircle;
    case "failed": return icons.xCircle;
    case "started": return icons.play;
    case "blocked": return icons.alertCircle;
    default: return icons.tag;
  }
}

function alertColor(type: TaskAlert["type"]): string {
  switch (type) {
    case "completed": return "#22c55e";
    case "failed": return "#ef4444";
    case "started": return "#3b82f6";
    case "blocked": return "#f59e0b";
    default: return "#71717a";
  }
}

// ============================================================
// Progress Calculation
// ============================================================

function calculateProgress(tasks: KanbanTask[]): { total: number; completed: number; inProgress: number; percent: number } {
  const total = tasks.length;
  const completed = tasks.filter(t => t.status === "done").length;
  const inProgress = tasks.filter(t => t.status === "in_progress").length;
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
  return { total, completed, inProgress, percent };
}

// ============================================================
// Render
// ============================================================

export function renderTaskSidebar(state: AppViewState, client: GatewayBrowserClient | null | undefined) {
  // Debug: log render
  console.log("[TaskSidebar] Rendering, client:", !!client, "sidebarOpen:", sidebarOpen);
  
  // If no client, show minimal toggle
  if (!client) {
    console.log("[TaskSidebar] No client, showing disconnected toggle");
    return html`
      <button class="tsb-toggle tsb-toggle--closed tsb-toggle--disconnected" title="Task Sidebar (Disconnected)">
        <span class="tsb-toggle__icon">${icons.layoutList}</span>
        <span class="tsb-toggle__offline">${icons.alertCircle}</span>
      </button>
      ${taskSidebarStyles()}
    `;
  }
  
  // Start polling when rendered
  startPolling(client, state);
  
  // Filter to active/recent tasks
  const activeTasks = cachedTasks.filter(t => 
    t.status === "in_progress" || t.status === "review"
  );
  const recentDone = cachedTasks
    .filter(t => t.status === "done")
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, 3);
  const todoTasks = cachedTasks
    .filter(t => t.status === "todo")
    .sort((a, b) => {
      const priOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, normal: 2, low: 3 };
      return (priOrder[a.priority || "normal"] ?? 2) - (priOrder[b.priority || "normal"] ?? 2);
    })
    .slice(0, 5);
  
  const progress = calculateProgress(cachedTasks);
  const activeAlerts = alerts.filter(a => !a.dismissed);
  
  if (!sidebarOpen) {
    return html`
      <button class="tsb-toggle tsb-toggle--closed" @click=${() => { sidebarOpen = true; state.requestUpdate?.(); }} title="Open Task Sidebar">
        <span class="tsb-toggle__icon">${icons.layoutList}</span>
        ${activeTasks.length > 0 ? html`<span class="tsb-toggle__badge">${activeTasks.length}</span>` : nothing}
      </button>
      ${renderFloatingAlerts(activeAlerts, state)}
      ${taskSidebarStyles()}
    `;
  }
  
  return html`
    <aside class="tsb ${sidebarMinimized ? 'tsb--minimized' : ''}">
      <!-- Header -->
      <header class="tsb-header">
        <div class="tsb-header__left">
          <span class="tsb-header__icon">${icons.layoutList}</span>
          <span class="tsb-header__title">Tasks</span>
          <span class="tsb-header__count">${progress.inProgress} active</span>
        </div>
        <div class="tsb-header__actions">
          <button class="tsb-header__btn" @click=${() => { sidebarMinimized = !sidebarMinimized; state.requestUpdate?.(); }} title="${sidebarMinimized ? 'Expand' : 'Minimize'}">
            ${sidebarMinimized ? icons.chevronDown : icons.chevronRight}
          </button>
          <button class="tsb-header__btn" @click=${() => { sidebarOpen = false; state.requestUpdate?.(); }} title="Close sidebar">${icons.x}</button>
        </div>
      </header>
      
      ${!sidebarMinimized ? html`
        <!-- Alerts -->
        ${activeAlerts.length > 0 ? html`
          <div class="tsb-alerts">
            ${activeAlerts.map(alert => html`
              <div class="tsb-alert" style="border-left-color: ${alertColor(alert.type)}">
                <span class="tsb-alert__icon">${alertIcon(alert.type)}</span>
                <div class="tsb-alert__content">
                  <div class="tsb-alert__title">${alert.taskTitle}</div>
                  <div class="tsb-alert__time">${formatRelativeTime(alert.timestamp)}</div>
                </div>
                <button class="tsb-alert__dismiss" @click=${() => { dismissAlert(alert.id); state.requestUpdate?.(); }}>${icons.x}</button>
              </div>
            `)}
          </div>
        ` : nothing}
        
        <!-- Overall Progress -->
        <div class="tsb-progress">
          <div class="tsb-progress__header">
            <span class="tsb-progress__label">Overall Progress</span>
            <span class="tsb-progress__value">${progress.completed}/${progress.total}</span>
          </div>
          <div class="tsb-progress__bar">
            <div class="tsb-progress__fill" style="width: ${progress.percent}%"></div>
          </div>
          <div class="tsb-progress__percent">${progress.percent}%</div>
        </div>
        
        <!-- Active Tasks -->
        ${activeTasks.length > 0 ? html`
          <section class="tsb-section">
            <h3 class="tsb-section__title">
              <span class="tsb-section__icon">${icons.refresh}</span>
              In Progress
              <span class="tsb-section__count">${activeTasks.length}</span>
            </h3>
            <div class="tsb-tasks">
              ${activeTasks.map(task => renderTaskCard(task, client, state))}
            </div>
          </section>
        ` : nothing}
        
        <!-- Up Next -->
        ${todoTasks.length > 0 ? html`
          <section class="tsb-section">
            <h3 class="tsb-section__title">
              <span class="tsb-section__icon">${icons.layoutList}</span>
              Up Next
            </h3>
            <div class="tsb-tasks tsb-tasks--compact">
              ${todoTasks.map(task => renderTaskCardCompact(task, state))}
            </div>
          </section>
        ` : nothing}
        
        <!-- Recently Completed -->
        ${recentDone.length > 0 ? html`
          <section class="tsb-section tsb-section--faded">
            <h3 class="tsb-section__title">
              <span class="tsb-section__icon">${icons.checkCircle}</span>
              Recently Done
            </h3>
            <div class="tsb-tasks tsb-tasks--compact">
              ${recentDone.map(task => renderTaskCardCompact(task, state))}
            </div>
          </section>
        ` : nothing}
        
        <!-- Footer -->
        <footer class="tsb-footer">
          <span class="tsb-footer__poll">Updated ${formatRelativeTime(lastPollTime)}</span>
          <button class="tsb-footer__refresh" @click=${() => pollTasks(client, state)} title="Refresh now">${icons.refresh}</button>
        </footer>
      ` : nothing}
    </aside>
    ${renderEditModal(client, state)}
    ${taskSidebarStyles()}
  `;
}

function renderTaskCard(task: KanbanTask, client: GatewayBrowserClient, state: AppViewState) {
  const statusColor = taskStatusColor(task.status);
  const isReview = task.status === "review";
  const isInProgress = task.status === "in_progress";
  
  return html`
    <div class="tsb-task ${isReview ? 'tsb-task--blocked' : ''}">
      <div class="tsb-task__header">
        <span class="tsb-task__status" style="color: ${statusColor}">${taskStatusIcon(task.status)}</span>
        <span class="tsb-task__title" @click=${() => {
          state.setTab("projects" as any);
          state.requestUpdate?.();
        }}>${priorityDot(task.priority)} ${task.title}</span>
      </div>
      ${task.description ? html`
        <div class="tsb-task__desc">${task.description.slice(0, 60)}${task.description.length > 60 ? '…' : ''}</div>
      ` : nothing}
      <div class="tsb-task__meta">
        ${task.assignee ? html`<span class="tsb-task__assignee">${icons.person} ${task.assignee}</span>` : nothing}
        <span class="tsb-task__time">${formatRelativeTime(task.updatedAt || task.createdAt)}</span>
      </div>
      
      <!-- Action Buttons -->
      <div class="tsb-task__actions">
        <button 
          class="tsb-task__btn tsb-task__btn--edit" 
          @click=${(e: Event) => { e.stopPropagation(); openEditModal(task, state); }}
          title="Edit task - restart with new context"
        >
          ${icons.penLine} Edit
        </button>
        <button 
          class="tsb-task__btn tsb-task__btn--approve" 
          @click=${(e: Event) => { e.stopPropagation(); approveTask(task, client, state); }}
          title="Mark as done"
        >
          ${icons.checkCircle} Approve
        </button>
      </div>
      
      ${isInProgress ? html`<div class="tsb-task__pulse"></div>` : nothing}
    </div>
  `;
}

function renderTaskCardCompact(task: KanbanTask, state: AppViewState) {
  return html`
    <div class="tsb-task tsb-task--compact" @click=${() => {
      state.setTab("projects" as any);
      state.requestUpdate?.();
    }}>
      <span class="tsb-task__status" style="color: ${taskStatusColor(task.status)}">${taskStatusIcon(task.status)}</span>
      <span class="tsb-task__title">${priorityDot(task.priority)} ${task.title}</span>
    </div>
  `;
}

function renderFloatingAlerts(alerts: TaskAlert[], state: AppViewState) {
  if (alerts.length === 0) return nothing;
  
  return html`
    <div class="tsb-floating-alerts">
      ${alerts.map(alert => html`
        <div class="tsb-floating-alert" style="border-left-color: ${alertColor(alert.type)}">
          <span class="tsb-floating-alert__icon">${alertIcon(alert.type)}</span>
          <span class="tsb-floating-alert__text">${alert.taskTitle}</span>
          <button class="tsb-floating-alert__dismiss" @click=${() => { dismissAlert(alert.id); state.requestUpdate?.(); }}>${icons.x}</button>
        </div>
      `)}
    </div>
  `;
}

function renderEditModal(client: GatewayBrowserClient, state: AppViewState) {
  if (!editModal.open || !editModal.task) return nothing;
  
  const task = editModal.task;
  
  return html`
    <div class="tsb-modal-backdrop" @click=${() => closeEditModal(state)}>
      <div class="tsb-modal" @click=${(e: Event) => e.stopPropagation()}>
        <header class="tsb-modal__header">
          <h3 class="tsb-modal__title">${icons.penLine} Edit Task</h3>
          <button class="tsb-modal__close" @click=${() => closeEditModal(state)}>${icons.x}</button>
        </header>
        
        <div class="tsb-modal__body">
          <!-- Task Info -->
          <div class="tsb-modal__task-info">
            <div class="tsb-modal__task-title">${task.title}</div>
            ${task.description ? html`
              <div class="tsb-modal__task-desc">${task.description}</div>
            ` : nothing}
            <div class="tsb-modal__task-meta">
              <span class="tsb-modal__task-status" style="color: ${taskStatusColor(task.status)}">
                ${taskStatusIcon(task.status)} ${task.status.replace("_", " ")}
              </span>
              ${task.assignee ? html`<span class="tsb-modal__task-assignee">${icons.person} ${task.assignee}</span>` : nothing}
            </div>
          </div>
          
          <!-- Prompt Input -->
          <div class="tsb-modal__prompt-section">
            <label class="tsb-modal__label">Add Context / Feedback</label>
            <textarea 
              class="tsb-modal__textarea"
              placeholder="Enter additional context, corrections, or instructions to restart the task with..."
              rows="5"
              .value=${editModal.prompt}
              @input=${(e: Event) => { editModal.prompt = (e.target as HTMLTextAreaElement).value; state.requestUpdate?.(); }}
              ?disabled=${editModal.sending}
            ></textarea>
            <div class="tsb-modal__hint">
              This will spawn a new sub-agent session with your feedback, continuing work on this task.
            </div>
          </div>
          
          ${editModal.error ? html`
            <div class="tsb-modal__error">${editModal.error}</div>
          ` : nothing}
        </div>
        
        <footer class="tsb-modal__footer">
          <button 
            class="tsb-modal__btn tsb-modal__btn--cancel" 
            @click=${() => closeEditModal(state)}
            ?disabled=${editModal.sending}
          >
            Cancel
          </button>
          <button 
            class="tsb-modal__btn tsb-modal__btn--send"
            @click=${() => sendEditPrompt(client, state)}
            ?disabled=${!editModal.prompt.trim() || editModal.sending}
          >
            ${editModal.sending ? "Sending..." : html`${icons.play} Restart Task`}
          </button>
        </footer>
      </div>
    </div>
  `;
}

// ============================================================
// Styles
// ============================================================

function taskSidebarStyles() {
  return html`
    <style>
      /* ═══ Task Sidebar Container ═══ */
      .tsb {
        position: fixed;
        top: 60px;
        right: 0;
        width: 320px;
        height: calc(100vh - 60px);
        background: rgba(10, 10, 12, 0.98);
        border-left: 3px solid var(--g-primary); /* DEBUG: bright gold border */
        display: flex;
        flex-direction: column;
        z-index: 10001; /* Above CRT overlay (9999) and grid toolbar (10000) */
        backdrop-filter: blur(12px);
        box-shadow: -4px 0 24px rgba(0, 0, 0, 0.5), -2px 0 8px color-mix(in srgb, var(--g-primary) 10%, transparent), 0 0 20px color-mix(in srgb, var(--g-primary) 30%, transparent); /* DEBUG: glow */
        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        overflow: hidden;
      }
      .tsb--minimized {
        height: auto;
      }
      
      /* ═══ Toggle Button (when closed) ═══ */
      .tsb-toggle {
        position: fixed;
        top: 70px;
        right: 16px;
        width: 52px;
        height: 52px;
        background: rgba(10, 10, 12, 0.95);
        border: 2px solid color-mix(in srgb, var(--g-primary) 40%, transparent);
        border-radius: 12px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        z-index: 10001; /* Above CRT overlay (9999) and grid toolbar (10000) */
        transition: all 0.2s ease;
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5), 0 0 10px color-mix(in srgb, var(--g-primary) 15%, transparent);
      }
      .tsb-toggle:hover {
        background: color-mix(in srgb, var(--g-primary) 10%, transparent);
        border-color: color-mix(in srgb, var(--g-primary) 40%, transparent);
        transform: scale(1.05);
      }
      .tsb-toggle--disconnected {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .tsb-toggle__icon {
        font-size: 1.4rem;
      }
      .tsb-toggle__offline {
        position: absolute;
        bottom: -2px;
        right: -2px;
        font-size: 0.7rem;
      }
      .tsb-toggle__badge {
        position: absolute;
        top: -4px;
        right: -4px;
        min-width: 18px;
        height: 18px;
        background: #f59e0b;
        color: #000;
        font-size: 10px;
        font-weight: 700;
        border-radius: 9px;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0 4px;
        animation: tsb-badge-pulse 2s ease-in-out infinite;
      }
      @keyframes tsb-badge-pulse {
        0%, 100% { transform: scale(1); }
        50% { transform: scale(1.1); }
      }
      
      /* ═══ Header ═══ */
      .tsb-header {
        padding: 14px 16px;
        background: color-mix(in srgb, var(--g-primary) 3%, transparent);
        border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 10%, transparent);
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-shrink: 0;
      }
      .tsb-header__left {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .tsb-header__icon {
        font-size: 1.1rem;
      }
      .tsb-header__title {
        font-family: var(--mono, 'JetBrains Mono', monospace);
        font-size: 13px;
        font-weight: 700;
        color: #fff;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .tsb-header__count {
        font-family: var(--mono, 'JetBrains Mono', monospace);
        font-size: 10px;
        color: #f59e0b;
        background: rgba(245, 158, 11, 0.15);
        padding: 2px 8px;
        border-radius: 10px;
        border: 1px solid rgba(245, 158, 11, 0.2);
      }
      .tsb-header__actions {
        display: flex;
        gap: 4px;
      }
      .tsb-header__btn {
        width: 24px;
        height: 24px;
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 4px;
        color: #888;
        font-size: 10px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.15s;
      }
      .tsb-header__btn:hover {
        background: color-mix(in srgb, var(--g-primary) 10%, transparent);
        color: var(--g-primary);
        border-color: color-mix(in srgb, var(--g-primary) 20%, transparent);
      }
      
      /* ═══ Alerts ═══ */
      .tsb-alerts {
        padding: 10px 12px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.04);
        max-height: 150px;
        overflow-y: auto;
      }
      .tsb-alert {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 12px;
        background: rgba(255, 255, 255, 0.03);
        border-radius: 8px;
        border-left: 3px solid;
        animation: tsb-alert-in 0.3s ease;
      }
      @keyframes tsb-alert-in {
        from { opacity: 0; transform: translateX(20px); }
        to { opacity: 1; transform: translateX(0); }
      }
      .tsb-alert__icon {
        font-size: 1rem;
        flex-shrink: 0;
      }
      .tsb-alert__content {
        flex: 1;
        min-width: 0;
      }
      .tsb-alert__title {
        font-size: 12px;
        color: #e4e4e7;
        font-weight: 500;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .tsb-alert__time {
        font-size: 10px;
        color: #52525b;
      }
      .tsb-alert__dismiss {
        width: 18px;
        height: 18px;
        background: none;
        border: none;
        color: #52525b;
        font-size: 10px;
        cursor: pointer;
        border-radius: 3px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.15s;
        flex-shrink: 0;
      }
      .tsb-alert__dismiss:hover {
        background: rgba(255, 255, 255, 0.1);
        color: #fff;
      }
      
      /* ═══ Progress Bar ═══ */
      .tsb-progress {
        padding: 14px 16px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      }
      .tsb-progress__header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 8px;
      }
      .tsb-progress__label {
        font-family: var(--mono, 'JetBrains Mono', monospace);
        font-size: 9px;
        font-weight: 600;
        color: #71717a;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .tsb-progress__value {
        font-family: var(--mono, 'JetBrains Mono', monospace);
        font-size: 11px;
        color: #a1a1aa;
      }
      .tsb-progress__bar {
        height: 6px;
        background: rgba(255, 255, 255, 0.06);
        border-radius: 3px;
        overflow: hidden;
        margin-bottom: 6px;
      }
      .tsb-progress__fill {
        height: 100%;
        background: linear-gradient(90deg, #f59e0b, #22c55e);
        border-radius: 3px;
        transition: width 0.5s cubic-bezier(0.4, 0, 0.2, 1);
      }
      .tsb-progress__percent {
        font-family: var(--mono, 'JetBrains Mono', monospace);
        font-size: 18px;
        font-weight: 700;
        color: var(--g-primary);
        text-align: center;
      }
      
      /* ═══ Sections ═══ */
      .tsb-section {
        padding: 12px 16px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.03);
      }
      .tsb-section--faded {
        opacity: 0.6;
      }
      .tsb-section__title {
        display: flex;
        align-items: center;
        gap: 6px;
        font-family: var(--mono, 'JetBrains Mono', monospace);
        font-size: 10px;
        font-weight: 700;
        color: #a1a1aa;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        margin: 0 0 10px 0;
      }
      .tsb-section__icon {
        font-size: 0.9rem;
      }
      .tsb-section__count {
        font-size: 9px;
        color: #f59e0b;
        background: rgba(245, 158, 11, 0.1);
        padding: 1px 6px;
        border-radius: 8px;
        margin-left: auto;
      }
      
      /* ═══ Tasks List ═══ */
      .tsb-tasks {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .tsb-tasks--compact {
        gap: 4px;
      }
      
      /* ═══ Task Card ═══ */
      .tsb-task {
        padding: 10px 12px;
        background: rgba(255, 255, 255, 0.03);
        border: 1px solid rgba(255, 255, 255, 0.05);
        border-radius: 8px;
        cursor: pointer;
        transition: all 0.2s ease;
        position: relative;
        overflow: hidden;
      }
      .tsb-task:hover {
        background: color-mix(in srgb, var(--g-primary) 5%, transparent);
        border-color: color-mix(in srgb, var(--g-primary) 15%, transparent);
        transform: translateX(-4px);
      }
      .tsb-task--blocked {
        border-left: 3px solid #f59e0b;
        animation: tsb-task-blocked 2s ease-in-out infinite;
      }
      @keyframes tsb-task-blocked {
        0%, 100% { box-shadow: inset 0 0 0 rgba(245, 158, 11, 0); }
        50% { box-shadow: inset 0 0 20px rgba(245, 158, 11, 0.05); }
      }
      .tsb-task--compact {
        padding: 6px 10px;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .tsb-task__header {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        margin-bottom: 6px;
      }
      .tsb-task__status {
        font-size: 0.9rem;
        flex-shrink: 0;
      }
      .tsb-task__title {
        font-size: 12px;
        font-weight: 500;
        color: #e4e4e7;
        line-height: 1.3;
        flex: 1;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .tsb-task--compact .tsb-task__title {
        font-size: 11px;
      }
      .tsb-task__desc {
        font-size: 10px;
        color: #71717a;
        line-height: 1.4;
        margin-bottom: 6px;
        padding-left: 24px;
      }
      .tsb-task__meta {
        display: flex;
        align-items: center;
        gap: 10px;
        padding-left: 24px;
      }
      .tsb-task__assignee {
        font-size: 10px;
        color: #52525b;
      }
      .tsb-task__time {
        font-size: 9px;
        color: #3f3f46;
        margin-left: auto;
      }
      .tsb-task__pulse {
        position: absolute;
        top: 8px;
        right: 8px;
        width: 6px;
        height: 6px;
        background: #f59e0b;
        border-radius: 50%;
        animation: tsb-pulse 1.5s ease-in-out infinite;
      }
      @keyframes tsb-pulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.5; transform: scale(1.3); }
      }
      
      /* ═══ Task Action Buttons ═══ */
      .tsb-task__actions {
        display: flex;
        gap: 6px;
        margin-top: 8px;
        padding-top: 8px;
        border-top: 1px solid rgba(255, 255, 255, 0.04);
      }
      .tsb-task__btn {
        flex: 1;
        padding: 6px 10px;
        border-radius: 6px;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.2s ease;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
        border: 1px solid;
      }
      .tsb-task__btn--edit {
        background: rgba(59, 130, 246, 0.1);
        border-color: rgba(59, 130, 246, 0.25);
        color: #60a5fa;
      }
      .tsb-task__btn--edit:hover {
        background: rgba(59, 130, 246, 0.2);
        border-color: rgba(59, 130, 246, 0.4);
        transform: translateY(-1px);
      }
      .tsb-task__btn--approve {
        background: rgba(34, 197, 94, 0.1);
        border-color: rgba(34, 197, 94, 0.25);
        color: #4ade80;
      }
      .tsb-task__btn--approve:hover {
        background: rgba(34, 197, 94, 0.2);
        border-color: rgba(34, 197, 94, 0.4);
        transform: translateY(-1px);
      }
      
      /* ═══ Edit Modal ═══ */
      .tsb-modal-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.7);
        backdrop-filter: blur(4px);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10002; /* Above sidebar */
        animation: tsb-fade-in 0.15s ease;
      }
      @keyframes tsb-fade-in {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      .tsb-modal {
        width: 480px;
        max-width: 90vw;
        max-height: 85vh;
        background: rgba(18, 18, 20, 0.98);
        border: 1px solid color-mix(in srgb, var(--g-primary) 20%, transparent);
        border-radius: 14px;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        box-shadow: 0 0 60px rgba(0, 0, 0, 0.5), 0 0 20px color-mix(in srgb, var(--g-primary) 5%, transparent);
        animation: tsb-modal-in 0.2s ease;
      }
      @keyframes tsb-modal-in {
        from { opacity: 0; transform: scale(0.95) translateY(10px); }
        to { opacity: 1; transform: scale(1) translateY(0); }
      }
      .tsb-modal__header {
        padding: 16px 20px;
        background: color-mix(in srgb, var(--g-primary) 3%, transparent);
        border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 10%, transparent);
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .tsb-modal__title {
        margin: 0;
        font-size: 15px;
        font-weight: 700;
        color: var(--g-primary);
      }
      .tsb-modal__close {
        width: 28px;
        height: 28px;
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 6px;
        color: #888;
        font-size: 12px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.15s;
      }
      .tsb-modal__close:hover {
        background: rgba(255, 255, 255, 0.1);
        color: #fff;
      }
      .tsb-modal__body {
        padding: 20px;
        display: flex;
        flex-direction: column;
        gap: 16px;
        overflow-y: auto;
        flex: 1;
      }
      .tsb-modal__task-info {
        background: rgba(0, 0, 0, 0.3);
        border: 1px solid rgba(255, 255, 255, 0.06);
        border-radius: 10px;
        padding: 14px 16px;
      }
      .tsb-modal__task-title {
        font-size: 14px;
        font-weight: 600;
        color: #e4e4e7;
        margin-bottom: 6px;
      }
      .tsb-modal__task-desc {
        font-size: 12px;
        color: #71717a;
        line-height: 1.5;
        margin-bottom: 10px;
      }
      .tsb-modal__task-meta {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .tsb-modal__task-status {
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
      }
      .tsb-modal__task-assignee {
        font-size: 11px;
        color: #52525b;
      }
      .tsb-modal__prompt-section {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .tsb-modal__label {
        font-size: 11px;
        font-weight: 700;
        color: #a1a1aa;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .tsb-modal__textarea {
        background: rgba(0, 0, 0, 0.4);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 8px;
        padding: 12px 14px;
        color: #fff;
        font-size: 13px;
        font-family: inherit;
        line-height: 1.5;
        resize: vertical;
        min-height: 100px;
        outline: none;
        transition: border-color 0.2s;
      }
      .tsb-modal__textarea:focus {
        border-color: rgba(59, 130, 246, 0.5);
      }
      .tsb-modal__textarea::placeholder {
        color: #52525b;
      }
      .tsb-modal__textarea:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .tsb-modal__hint {
        font-size: 10px;
        color: #52525b;
        line-height: 1.4;
      }
      .tsb-modal__error {
        background: rgba(239, 68, 68, 0.1);
        border: 1px solid rgba(239, 68, 68, 0.2);
        border-radius: 6px;
        padding: 10px 12px;
        color: #ef4444;
        font-size: 12px;
      }
      .tsb-modal__footer {
        padding: 14px 20px;
        background: rgba(0, 0, 0, 0.2);
        border-top: 1px solid rgba(255, 255, 255, 0.05);
        display: flex;
        justify-content: flex-end;
        gap: 10px;
      }
      .tsb-modal__btn {
        padding: 10px 18px;
        border-radius: 8px;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.2s;
        border: 1px solid;
      }
      .tsb-modal__btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .tsb-modal__btn--cancel {
        background: rgba(255, 255, 255, 0.05);
        border-color: rgba(255, 255, 255, 0.1);
        color: #a1a1aa;
      }
      .tsb-modal__btn--cancel:hover:not(:disabled) {
        background: rgba(255, 255, 255, 0.1);
        color: #fff;
      }
      .tsb-modal__btn--send {
        background: rgba(59, 130, 246, 0.15);
        border-color: rgba(59, 130, 246, 0.3);
        color: #60a5fa;
      }
      .tsb-modal__btn--send:hover:not(:disabled) {
        background: rgba(59, 130, 246, 0.25);
        border-color: rgba(59, 130, 246, 0.5);
        box-shadow: 0 0 16px rgba(59, 130, 246, 0.2);
      }
      
      /* ═══ Footer ═══ */
      .tsb-footer {
        margin-top: auto;
        padding: 10px 16px;
        background: rgba(0, 0, 0, 0.2);
        border-top: 1px solid rgba(255, 255, 255, 0.04);
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .tsb-footer__poll {
        font-size: 9px;
        color: #3f3f46;
      }
      .tsb-footer__refresh {
        width: 24px;
        height: 24px;
        background: rgba(255, 255, 255, 0.03);
        border: 1px solid rgba(255, 255, 255, 0.06);
        border-radius: 4px;
        color: #52525b;
        font-size: 12px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.15s;
      }
      .tsb-footer__refresh:hover {
        background: color-mix(in srgb, var(--g-primary) 10%, transparent);
        color: var(--g-primary);
        border-color: color-mix(in srgb, var(--g-primary) 20%, transparent);
      }
      
      /* ═══ Floating Alerts (when sidebar closed) ═══ */
      .tsb-floating-alerts {
        position: fixed;
        top: 130px;
        right: 16px;
        width: 280px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        z-index: 10001; /* Above CRT overlay (9999) */
      }
      .tsb-floating-alert {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 12px 14px;
        background: rgba(10, 10, 12, 0.95);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 10px;
        border-left: 3px solid;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
        backdrop-filter: blur(12px);
        animation: tsb-float-in 0.3s ease;
      }
      @keyframes tsb-float-in {
        from { opacity: 0; transform: translateX(30px); }
        to { opacity: 1; transform: translateX(0); }
      }
      .tsb-floating-alert__icon {
        font-size: 1.1rem;
        flex-shrink: 0;
      }
      .tsb-floating-alert__text {
        flex: 1;
        font-size: 12px;
        color: #e4e4e7;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .tsb-floating-alert__dismiss {
        width: 20px;
        height: 20px;
        background: none;
        border: none;
        color: #52525b;
        font-size: 11px;
        cursor: pointer;
        border-radius: 3px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.15s;
        flex-shrink: 0;
      }
      .tsb-floating-alert__dismiss:hover {
        background: rgba(255, 255, 255, 0.1);
        color: #fff;
      }
      
      /* ═══ Responsive ═══ */
      @media (max-width: 768px) {
        .tsb {
          width: 280px;
        }
        .tsb-floating-alerts {
          width: 240px;
          right: 8px;
        }
      }

      /* Glass G1 final contract. This lives after the mature sidecar styles so
         dark, light and accessibility modes all win without changing behavior. */
      .tsb,
      .tsb-toggle,
      .tsb-modal,
      .tsb-floating-alert {
        color: var(--glass-fg);
        background: var(--glass-sheen), var(--glass-4);
        border-color: var(--glass-stroke-gold);
        box-shadow: var(--glass-elev-4);
        font-family: var(--glass-font, var(--font-ui, -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif));
        backdrop-filter: var(--glass-blur-lg);
        -webkit-backdrop-filter: var(--glass-blur-lg);
      }
      .tsb {
        border-left-width: 1px;
      }
      .tsb-header,
      .tsb-progress,
      .tsb-footer,
      .tsb-modal__header,
      .tsb-modal__footer {
        background: var(--glass-gold-a06);
        border-color: var(--glass-stroke);
      }
      .tsb-alerts,
      .tsb-section,
      .tsb-task__actions {
        border-color: var(--glass-stroke);
      }
      .tsb-task,
      .tsb-alert,
      .tsb-modal__task-info {
        color: var(--glass-fg);
        background: var(--glass-3);
        border-color: var(--glass-stroke);
      }
      .tsb-task:hover {
        color: var(--glass-fg);
        background: var(--glass-hover);
        border-color: var(--glass-stroke-gold);
        box-shadow: var(--glass-glow-soft);
      }
      .tsb-header__title,
      .tsb-alert__title,
      .tsb-task__title,
      .tsb-modal__task-title,
      .tsb-floating-alert__text {
        color: var(--glass-fg);
      }
      .tsb-progress__value,
      .tsb-section__title,
      .tsb-task__desc,
      .tsb-modal__task-desc,
      .tsb-modal__label {
        color: var(--glass-fg-2);
      }
      .tsb-alert__time,
      .tsb-progress__label,
      .tsb-task__assignee,
      .tsb-task__time,
      .tsb-modal__task-assignee,
      .tsb-modal__hint,
      .tsb-footer__poll {
        color: var(--glass-fg-3);
      }
      .tsb-header__count,
      .tsb-section__count,
      .tsb-progress__percent {
        color: var(--glass-gold);
        background: var(--glass-gold-a10);
        border-color: var(--glass-stroke-gold);
      }
      .tsb-progress__bar {
        background: color-mix(in srgb, var(--glass-base) 55%, transparent);
      }
      .tsb-progress__fill {
        background: var(--glass-gold-fill);
      }
      .tsb-header__btn,
      .tsb-footer__refresh,
      .tsb-modal__close,
      .tsb-modal__btn,
      .tsb-task__btn,
      .tsb-modal__textarea {
        color: var(--glass-fg-2);
        background: var(--glass-hover);
        border-color: var(--glass-stroke-strong);
      }
      .tsb-header__btn:hover,
      .tsb-footer__refresh:hover,
      .tsb-modal__close:hover,
      .tsb-modal__btn--cancel:hover:not(:disabled) {
        color: var(--glass-gold);
        background: var(--glass-gold-a10);
        border-color: var(--glass-stroke-gold);
      }
      .tsb-modal__textarea {
        color: var(--glass-fg);
        background: color-mix(in srgb, var(--glass-base) 55%, transparent);
      }
      .tsb-modal__textarea::placeholder {
        color: var(--glass-fg-4);
      }
      .tsb-modal__btn--send {
        color: var(--glass-ink);
        background: var(--glass-gold-fill);
        border-color: var(--glass-stroke-gold);
      }
      .tsb-modal-backdrop {
        background: color-mix(in srgb, var(--glass-base) 62%, transparent);
      }
      .tsb :is(button, textarea):focus-visible,
      .tsb-toggle:focus-visible,
      .tsb-modal :is(button, textarea):focus-visible,
      .tsb-floating-alert button:focus-visible {
        outline: none;
        box-shadow: var(--glass-focus-ring);
      }
      @media (max-width: 520px) {
        .tsb {
          right: 8px;
          width: calc(100vw - 16px);
        }
        .tsb-modal {
          width: calc(100vw - 24px);
          max-width: none;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .tsb,
        .tsb *,
        .tsb-toggle,
        .tsb-modal,
        .tsb-modal *,
        .tsb-floating-alert,
        .tsb-floating-alert * {
          animation: none !important;
          transition: none !important;
        }
        .tsb-task:hover,
        .tsb-toggle:hover,
        .tsb-task__btn:hover {
          transform: none;
        }
      }
      @media (prefers-reduced-transparency: reduce) {
        .tsb,
        .tsb-toggle,
        .tsb-modal,
        .tsb-floating-alert {
          background: var(--glass-solid);
          backdrop-filter: none;
          -webkit-backdrop-filter: none;
        }
        .tsb-modal-backdrop {
          backdrop-filter: none;
          -webkit-backdrop-filter: none;
        }
      }
    </style>
  `;
}

// Export cleanup function
export function cleanupTaskSidebar() {
  stopPolling();
}
