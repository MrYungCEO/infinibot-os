/**
 * Project spec panel — template picker, AI actions, and live to-do status.
 *
 * Sits directly under the spec block editor on a project page. Three jobs:
 *
 *  1. **Templates.** Apply a standardised spec, or save the current one as a
 *     reusable custom template. Merge is the default because it is the safe
 *     verb; replace is available but says on the button that in-flight to-dos
 *     survive it.
 *  2. **AI actions.** Draft / review / break-down requests, all routed to the
 *     employee whose role is Project Manager. When no such employee exists the
 *     panel shows a picker instead of guessing — a work item written against an
 *     invented id is worse than no work item.
 *  3. **To-do status.** Each dispatchable to-do with its assignee and where it
 *     has got to, so a checked box and a queued work item can be told apart.
 *
 * Rendered as a plain function (not a custom element) because the project page
 * in `views/kanban.ts` is a light-DOM Lit template — the same shape the block
 * editor beneath it already uses, so the glass tokens cascade in.
 */

import { html, nothing, type TemplateResult } from "lit";
import {
  applySpecTemplate,
  askProjectManager,
  clearSpecNotice,
  ensureSpecAgency,
  ensureSpecTemplates,
  findProjectManager,
  loadProjectSpec,
  projectSpecState,
  saveSpecAsTemplate,
  supportsSpecDispatch,
  dispatchTodo,
  type DispatchStatus,
  type PmAction,
  type SpecBlock,
} from "../controllers/project-spec";
import type { ApplyMode, SpecTemplate } from "../controllers/spec-templates";
import type { GatewayBrowserClient } from "../gateway";

export interface ProjectSpecPanelProps {
  project: { id: string; name?: string; description?: string; techStack?: string[] };
  client: GatewayBrowserClient | undefined;
  requestUpdate: (() => void) | undefined;
}

// ── Local UI state ───────────────────────────────────────────────────────
// Panel-only choices (which template is highlighted, what the operator typed
// into the "save as" box). Deliberately not in the controller: none of it
// survives a project switch and none of it is worth persisting.

let _selectedSlug = "web-build";
let _mode: ApplyMode = "merge";
let _saveName = "";
let _confirmingReplace = false;
/**
 * Which action is waiting on an assignee. `"dispatch"` is the per-to-do
 * "Send to AI" path: it is not a PM action, but it needs the same picker,
 * because quietly assigning a to-do to whichever employee happened to be
 * first in the list is how work ends up with the wrong person.
 */
let _pickerFor: PmAction | "dispatch" | null = null;
let _pickedWorkerId = "";
let _pickerBlockId: string | null = null;
let _bootedProjectId: string | null = null;

const STYLE_ID = "project-spec-panel-style";

function ensureStyles(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = PANEL_CSS;
  document.head.appendChild(style);
}

/**
 * Read the blocks the editor currently holds.
 *
 * The editor saves on a debounce, so its in-memory buffer can be ahead of the
 * gateway. Applying a template against the stored copy would silently discard
 * whatever the operator typed in the last half second.
 */
function liveBlocks(projectId: string): SpecBlock[] | undefined {
  if (typeof document === "undefined") return undefined;
  const host = specEditorHost(projectId);
  const handle = (host as unknown as { __blockEditor?: { getBlocks?: () => SpecBlock[] } })
    ?.__blockEditor;
  return typeof handle?.getBlocks === "function" ? handle.getBlocks() : undefined;
}

function specEditorHost(projectId: string): HTMLElement | null {
  const escaped = projectId.replace(/["\\]/g, "\\$&");
  return document.querySelector<HTMLElement>(`[data-project-spec-editor="${escaped}"]`);
}

/** Push freshly-applied blocks into the mounted editor so the page matches disk. */
function pushBlocks(projectId: string, blocks: SpecBlock[]): void {
  const handle = (
    specEditorHost(projectId) as unknown as {
      __blockEditor?: { applyBlocks?: (b: SpecBlock[]) => void };
    } | null
  )?.__blockEditor;
  handle?.applyBlocks?.(blocks);
}

const STATUS_TONE: Record<DispatchStatus, string> = {
  queued: "warning",
  accepted: "info",
  in_progress: "info",
  review: "warning",
  completed: "success",
  waiting: "neutral",
  cancelled: "danger",
  escalated: "danger",
};

const STATUS_LABEL: Record<DispatchStatus, string> = {
  queued: "Queued",
  accepted: "Accepted",
  in_progress: "In progress",
  review: "In review",
  completed: "Completed",
  waiting: "Waiting",
  cancelled: "Cancelled",
  escalated: "Escalated",
};

function boot(props: ProjectSpecPanelProps): void {
  const { client, project, requestUpdate } = props;
  if (!client || !requestUpdate) return;
  if (_bootedProjectId === project.id) return;
  _bootedProjectId = project.id;
  _confirmingReplace = false;
  _pickerFor = null;
  _saveName = "";
  const host = { requestUpdate };
  void (async () => {
    const agencyId = await ensureSpecAgency(host, client);
    await loadProjectSpec(host, client, { projectId: project.id, ...project }, agencyId);
    // Seeding writes the starter template straight to the store; the editor
    // mounted above may have already loaded the (then empty) document, so
    // hand it the seeded blocks rather than leaving the page blank.
    if (projectSpecState().seeded) pushBlocks(project.id, projectSpecState().blocks);
    await ensureSpecTemplates(host, client);
  })();
}

export function renderProjectSpecPanel(props: ProjectSpecPanelProps): TemplateResult | typeof nothing {
  const { client, project, requestUpdate } = props;
  if (!client || !requestUpdate) return nothing;
  ensureStyles();
  boot(props);

  const state = projectSpecState();
  const host = { requestUpdate };
  const canDispatch = supportsSpecDispatch(client) && Boolean(state.agencyId);
  const pm = findProjectManager(state.employees);
  const templates = state.templates;
  const selected =
    templates.find((template) => template.slug === _selectedSlug) ?? templates[0] ?? null;

  return html`
    <div class="spec-panel" role="region" aria-label="Project spec tools">
      ${renderNotice(state.error, state.message, () => {
        clearSpecNotice(host);
        requestUpdate();
      })}
      ${renderTemplates(props, templates, selected, state.templatesLoading)}
      ${renderAiActions(props, pm, canDispatch)}
      ${renderTodos(props, pm, canDispatch)}
    </div>
  `;
}

function renderNotice(
  error: string | null,
  message: string | null,
  dismiss: () => void,
): TemplateResult | typeof nothing {
  if (!error && !message) return nothing;
  return html`
    <div class="spec-notice ${error ? "is-error" : "is-ok"}" role="status" aria-live="polite">
      <span>${error ?? message}</span>
      <button type="button" class="spec-notice-x" aria-label="Dismiss message" @click=${dismiss}>
        ×
      </button>
    </div>
  `;
}

function renderTemplates(
  props: ProjectSpecPanelProps,
  templates: SpecTemplate[],
  selected: SpecTemplate | null,
  loading: boolean,
): TemplateResult {
  const { client, project, requestUpdate } = props;
  const state = projectSpecState();
  const host = { requestUpdate: requestUpdate! };
  const busy = state.busyAction?.startsWith("template:") ?? false;
  const inFlight = state.todos.filter((todo) => todo.workItemId || todo.checked).length;

  const apply = (mode: ApplyMode) => {
    if (!selected || !client) return;
    if (mode === "replace" && !_confirmingReplace) {
      _confirmingReplace = true;
      requestUpdate!();
      return;
    }
    _confirmingReplace = false;
    _mode = mode;
    void applySpecTemplate(host, client, {
      projectId: project.id,
      template: selected,
      mode,
      context: { name: project.name, description: project.description, techStack: project.techStack },
      currentBlocks: liveBlocks(project.id),
      onApplied: (blocks) => pushBlocks(project.id, blocks),
    });
  };

  return html`
    <section class="spec-card" aria-labelledby="spec-tpl-h">
      <div class="spec-card-head">
        <h4 id="spec-tpl-h">Template</h4>
        <span class="spec-hint">${loading ? "loading…" : `${templates.length} available`}</span>
      </div>

      <div class="spec-row">
        <label class="spec-label" for="spec-tpl-select">Start from</label>
        <select
          id="spec-tpl-select"
          class="spec-select"
          .value=${selected?.slug ?? ""}
          @change=${(e: Event) => {
            _selectedSlug = (e.target as HTMLSelectElement).value;
            _confirmingReplace = false;
            requestUpdate!();
          }}
        >
          ${templates.map(
            (template) => html`
              <option value=${template.slug} ?selected=${template.slug === selected?.slug}>
                ${template.name}${template.source === "custom" ? " (custom)" : ""}
              </option>
            `,
          )}
        </select>
      </div>
      ${selected ? html`<p class="spec-tpl-desc">${selected.description}</p>` : nothing}

      <div class="spec-actions">
        <button
          type="button"
          class="spec-btn spec-btn-primary"
          ?disabled=${busy || !selected}
          @click=${() => apply("merge")}
        >
          ${busy && _mode === "merge" ? "Applying…" : "Merge into spec"}
        </button>
        <button
          type="button"
          class="spec-btn ${_confirmingReplace ? "spec-btn-danger" : ""}"
          ?disabled=${busy || !selected}
          @click=${() => apply("replace")}
        >
          ${_confirmingReplace ? "Confirm replace" : "Replace"}
        </button>
        ${_confirmingReplace
          ? html`<button
              type="button"
              class="spec-btn spec-btn-ghost"
              @click=${() => {
                _confirmingReplace = false;
                requestUpdate!();
              }}
            >
              Cancel
            </button>`
          : nothing}
      </div>
      <p class="spec-fineprint">
        Merge adds only what is missing and keeps your text. Replace swaps the
        document${inFlight
          ? html` — the ${inFlight} checked or dispatched to-do${inFlight === 1 ? "" : "s"} are
            carried over either way.`
          : html`, and still carries over any checked or dispatched to-dos.`}
      </p>

      <div class="spec-row spec-row-save">
        <label class="spec-label" for="spec-tpl-name">Save this spec as</label>
        <input
          id="spec-tpl-name"
          class="spec-input"
          type="text"
          placeholder="e.g. Shopify launch"
          .value=${_saveName}
          @input=${(e: Event) => {
            _saveName = (e.target as HTMLInputElement).value;
          }}
        />
        <button
          type="button"
          class="spec-btn"
          ?disabled=${busy}
          @click=${() => {
            if (!client) return;
            void saveSpecAsTemplate(host, client, {
              name: _saveName,
              blocks: liveBlocks(project.id) ?? state.blocks,
            }).then((ok) => {
              if (ok) {
                _saveName = "";
                requestUpdate!();
              }
            });
          }}
        >
          Save as template
        </button>
      </div>
    </section>
  `;
}

function renderAiActions(
  props: ProjectSpecPanelProps,
  pm: { id: string; name: string } | null,
  canDispatch: boolean,
): TemplateResult {
  const { client, project, requestUpdate } = props;
  const state = projectSpecState();
  const host = { requestUpdate: requestUpdate! };

  const run = (action: PmAction, workerId: string) => {
    if (!client || !state.agencyId) return;
    void askProjectManager(host, client, {
      agencyId: state.agencyId,
      projectId: project.id,
      projectName: project.name ?? "this project",
      action,
      workerId,
      blocks: liveBlocks(project.id) ?? state.blocks,
    });
  };

  const start = (action: PmAction) => {
    if (pm) {
      run(action, pm.id);
      return;
    }
    _pickerFor = action;
    _pickerBlockId = null;
    requestUpdate!();
  };

  const busy = (action: PmAction) => state.busyAction === `pm:${action}`;

  return html`
    <section class="spec-card" aria-labelledby="spec-ai-h">
      <div class="spec-card-head">
        <h4 id="spec-ai-h">Ask the Project Manager</h4>
        <span class="spec-hint">
          ${pm ? `→ ${pm.name}` : canDispatch ? "no PM on staff" : "workforce unavailable"}
        </span>
      </div>
      <div class="spec-actions">
        <button
          type="button"
          class="spec-btn spec-btn-primary"
          ?disabled=${!canDispatch || Boolean(state.busyAction)}
          @click=${() => start("draft")}
        >
          ${busy("draft") ? "Queueing…" : "Draft this spec"}
        </button>
        <button
          type="button"
          class="spec-btn"
          ?disabled=${!canDispatch || Boolean(state.busyAction)}
          @click=${() => start("review")}
        >
          ${busy("review") ? "Queueing…" : "Review / refine"}
        </button>
      </div>
      ${(_pickerFor === "draft" || _pickerFor === "review") && !pm
        ? renderPicker(props, run)
        : nothing}
      <p class="spec-fineprint">
        ${canDispatch
          ? "Requests enter the workforce as queued — a human still starts the work."
          : "Connect an agency with an active workforce to route spec work to an employee."}
      </p>
    </section>
  `;
}

/**
 * Assignee picker, shown only when no employee holds a Project Manager role.
 * Every option is an id the gateway returned, so there is no path here that
 * writes a work item against an id we made up.
 */
function renderPicker(
  props: ProjectSpecPanelProps,
  run: (action: PmAction, workerId: string) => void,
): TemplateResult {
  const { requestUpdate, project } = props;
  const state = projectSpecState();
  const action = _pickerFor!;
  if (state.employees.length === 0) {
    return html`<p class="spec-fineprint spec-warn">
      No employees are listed for this agency, so there is nobody to route to.
    </p>`;
  }
  return html`
    <div class="spec-picker" role="group" aria-label="Choose who to send this to">
      <label class="spec-label" for="spec-pm-pick">Send to</label>
      <select
        id="spec-pm-pick"
        class="spec-select"
        @change=${(e: Event) => {
          _pickedWorkerId = (e.target as HTMLSelectElement).value;
        }}
      >
        <option value="">Choose an employee…</option>
        ${state.employees.map(
          (employee) => html`
            <option value=${employee.id}>
              ${employee.name}${employee.role ? ` — ${employee.role}` : ""}
            </option>
          `,
        )}
      </select>
      <button
        type="button"
        class="spec-btn spec-btn-primary"
        ?disabled=${!_pickedWorkerId}
        @click=${() => {
          if (!_pickedWorkerId) return;
          const blockId = _pickerBlockId;
          const worker = _pickedWorkerId;
          _pickerFor = null;
          _pickerBlockId = null;
          const todo = blockId ? state.todos.find((t) => t.blockId === blockId) : undefined;
          if (action === "dispatch" && blockId) {
            void sendTodo(props, worker, blockId, todo?.text ?? "");
          } else if (action === "breakdown" && blockId) {
            void askProjectManagerForBlock(props, worker, blockId, todo?.text ?? "");
          } else if (action !== "dispatch") {
            run(action, worker);
          }
          requestUpdate!();
        }}
      >
        Send
      </button>
      <button
        type="button"
        class="spec-btn spec-btn-ghost"
        @click=${() => {
          _pickerFor = null;
          _pickerBlockId = null;
          requestUpdate!();
        }}
      >
        Cancel
      </button>
      <span class="spec-hint">for “${project.name ?? "this project"}”</span>
    </div>
  `;
}

/** Hand one to-do to a named employee. Always an id the gateway returned. */
function sendTodo(
  props: ProjectSpecPanelProps,
  workerId: string,
  blockId: string,
  text: string,
): Promise<boolean> {
  const { client, project, requestUpdate } = props;
  const state = projectSpecState();
  if (!client || !state.agencyId) return Promise.resolve(false);
  return dispatchTodo({ requestUpdate: requestUpdate! }, client, {
    agencyId: state.agencyId,
    projectId: project.id,
    projectName: project.name ?? "this project",
    blockId,
    title: text,
    workerId,
  });
}

function askProjectManagerForBlock(
  props: ProjectSpecPanelProps,
  workerId: string,
  blockId: string,
  blockText: string,
): Promise<boolean> {
  const { client, project, requestUpdate } = props;
  const state = projectSpecState();
  if (!client || !state.agencyId) return Promise.resolve(false);
  return askProjectManager(
    { requestUpdate: requestUpdate! },
    client,
    {
      agencyId: state.agencyId,
      projectId: project.id,
      projectName: project.name ?? "this project",
      action: "breakdown",
      workerId,
      blocks: liveBlocks(project.id) ?? state.blocks,
      blockId,
      blockText,
    },
  );
}

function renderTodos(
  props: ProjectSpecPanelProps,
  pm: { id: string; name: string } | null,
  canDispatch: boolean,
): TemplateResult {
  const { project, requestUpdate } = props;
  const state = projectSpecState();
  const todos = state.todos;

  return html`
    <section class="spec-card" aria-labelledby="spec-todo-h">
      <div class="spec-card-head">
        <h4 id="spec-todo-h">To-do</h4>
        <span class="spec-hint">${todos.length} item${todos.length === 1 ? "" : "s"}</span>
      </div>
      ${todos.length === 0
        ? html`<p class="spec-fineprint">
            Add a to-do block to the spec above and it becomes dispatchable here.
          </p>`
        : html`
            <ul class="spec-todos" aria-label="Spec to-dos and their dispatch status">
              ${todos.map((todo) => {
                const dispatching = state.dispatchingBlockId === todo.blockId;
                const breakingDown = state.busyAction === `pm:breakdown:${todo.blockId}`;
                const tone = todo.status ? STATUS_TONE[todo.status] : "neutral";
                return html`
                  <li class="spec-todo">
                    <span class="spec-todo-box" aria-hidden="true">${todo.checked ? "☑" : "☐"}</span>
                    <span class="spec-todo-text ${todo.checked ? "is-done" : ""}">${todo.text}</span>
                    ${todo.status
                      ? html`<span
                          class="spec-chip"
                          data-tone=${tone}
                          aria-label=${`Status: ${STATUS_LABEL[todo.status]}${
                            todo.workerName ? `, assigned to ${todo.workerName}` : ""
                          }`}
                        >
                          ${STATUS_LABEL[todo.status]}${todo.workerName
                            ? html` · ${todo.workerName}`
                            : nothing}
                        </span>`
                      : html`<span class="spec-chip" data-tone="idle">Not sent</span>`}
                    <span class="spec-todo-actions">
                      <button
                        type="button"
                        class="spec-btn spec-btn-sm"
                        ?disabled=${!canDispatch || Boolean(state.busyAction) || Boolean(state.dispatchingBlockId) || Boolean(todo.workItemId)}
                        aria-label=${`Send "${todo.text}" to an AI employee`}
                        @click=${() => {
                          if (pm) {
                            void sendTodo(props, pm.id, todo.blockId, todo.text);
                            return;
                          }
                          _pickerFor = "dispatch";
                          _pickerBlockId = todo.blockId;
                          requestUpdate!();
                        }}
                      >
                        ${dispatching ? "Sending…" : todo.workItemId ? "Sent" : "Send to AI"}
                      </button>
                      <button
                        type="button"
                        class="spec-btn spec-btn-sm spec-btn-ghost"
                        ?disabled=${!canDispatch || Boolean(state.busyAction)}
                        aria-label=${`Ask the Project Manager to break down "${todo.text}"`}
                        @click=${() => {
                          if (pm) {
                            void askProjectManagerForBlock(props, pm.id, todo.blockId, todo.text);
                            return;
                          }
                          _pickerFor = "breakdown";
                          _pickerBlockId = todo.blockId;
                          requestUpdate!();
                        }}
                      >
                        ${breakingDown ? "Queueing…" : "Break down"}
                      </button>
                    </span>
                  </li>
                `;
              })}
            </ul>
          `}
      ${(_pickerFor === "breakdown" || _pickerFor === "dispatch") && !pm
        ? renderPicker(props, () => undefined)
        : nothing}
    </section>
  `;
}

const PANEL_CSS = `
.spec-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 14px;
}
.spec-card {
  background: var(--g-surface, rgba(255,255,255,0.04));
  border: 1px solid var(--g-border, rgba(251,191,36,0.14));
  border-radius: var(--g-radius, 12px);
  padding: 12px 14px;
}
.spec-card-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}
.spec-card-head h4 {
  margin: 0;
  font-size: 0.82rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--g-primary, #fbbf24);
}
.spec-hint { font-size: 0.72rem; color: rgba(255,255,255,0.45); }
.spec-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.spec-row-save { margin-top: 12px; }
.spec-label { font-size: 0.75rem; color: rgba(255,255,255,0.6); }
.spec-select,
.spec-input {
  background: rgba(0,0,0,0.35);
  border: 1px solid var(--g-border, rgba(251,191,36,0.14));
  border-radius: var(--g-radius-sm, 8px);
  color: inherit;
  font: inherit;
  font-size: 0.82rem;
  padding: 5px 8px;
}
.spec-input { flex: 1 1 160px; min-width: 120px; }
.spec-select:focus-visible,
.spec-input:focus-visible,
.spec-btn:focus-visible,
.spec-notice-x:focus-visible {
  outline: 2px solid var(--g-primary, #fbbf24);
  outline-offset: 2px;
}
.spec-tpl-desc {
  margin: 8px 0 0;
  font-size: 0.78rem;
  color: rgba(255,255,255,0.55);
}
.spec-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 10px;
}
.spec-btn {
  background: var(--g-surface-strong, rgba(255,255,255,0.08));
  border: 1px solid var(--g-border, rgba(251,191,36,0.14));
  border-radius: var(--g-radius-sm, 8px);
  color: inherit;
  font: inherit;
  font-size: 0.78rem;
  padding: 6px 12px;
  cursor: pointer;
  transition: background 140ms ease, border-color 140ms ease;
}
.spec-btn:hover:not(:disabled) {
  background: var(--g-surface-hover, rgba(255,255,255,0.12));
  border-color: var(--g-border-strong, rgba(251,191,36,0.3));
}
.spec-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.spec-btn-sm { padding: 3px 9px; font-size: 0.72rem; }
.spec-btn-primary {
  background: color-mix(in srgb, var(--g-primary, #fbbf24) 16%, transparent);
  border-color: var(--g-border-strong, rgba(251,191,36,0.3));
  color: var(--g-primary, #fbbf24);
}
.spec-btn-danger {
  background: var(--g-danger-soft, rgba(239,68,68,0.12));
  border-color: var(--g-danger-border, rgba(239,68,68,0.4));
  color: var(--g-danger, #ef4444);
}
.spec-btn-ghost { background: transparent; }
.spec-fineprint {
  margin: 10px 0 0;
  font-size: 0.72rem;
  line-height: 1.5;
  color: rgba(255,255,255,0.42);
}
.spec-warn { color: var(--g-warning, #f59e0b); }
.spec-picker {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--g-border, rgba(251,191,36,0.14));
}
.spec-notice {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  font-size: 0.78rem;
  padding: 8px 10px;
  border-radius: var(--g-radius-sm, 8px);
  border: 1px solid var(--g-border, rgba(251,191,36,0.14));
}
.spec-notice.is-ok {
  background: var(--g-success-soft, rgba(34,197,94,0.12));
  border-color: var(--g-success-border, rgba(34,197,94,0.4));
}
.spec-notice.is-error {
  background: var(--g-danger-soft, rgba(239,68,68,0.12));
  border-color: var(--g-danger-border, rgba(239,68,68,0.4));
}
.spec-notice span { flex: 1; }
.spec-notice-x {
  background: none;
  border: none;
  color: inherit;
  cursor: pointer;
  font-size: 1rem;
  line-height: 1;
  padding: 0 2px;
}
.spec-todos { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.spec-todo {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 0.82rem;
  padding: 5px 6px;
  border-radius: var(--g-radius-sm, 8px);
}
.spec-todo:hover { background: rgba(255,255,255,0.03); }
.spec-todo-box { color: rgba(255,255,255,0.5); }
.spec-todo-text { flex: 1 1 180px; min-width: 120px; }
.spec-todo-text.is-done { color: rgba(255,255,255,0.42); text-decoration: line-through; }
.spec-todo-actions { display: flex; gap: 6px; }
.spec-chip {
  font-size: 0.68rem;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--g-neutral-border, rgba(148,163,184,0.4));
  background: var(--g-neutral-soft, rgba(148,163,184,0.12));
  color: var(--g-neutral, #94a3b8);
  white-space: nowrap;
}
.spec-chip[data-tone="success"] {
  border-color: var(--g-success-border, rgba(34,197,94,0.4));
  background: var(--g-success-soft, rgba(34,197,94,0.12));
  color: var(--g-success, #22c55e);
}
.spec-chip[data-tone="warning"] {
  border-color: var(--g-warning-border, rgba(245,158,11,0.4));
  background: var(--g-warning-soft, rgba(245,158,11,0.12));
  color: var(--g-warning, #f59e0b);
}
.spec-chip[data-tone="danger"] {
  border-color: var(--g-danger-border, rgba(239,68,68,0.4));
  background: var(--g-danger-soft, rgba(239,68,68,0.12));
  color: var(--g-danger, #ef4444);
}
.spec-chip[data-tone="info"] {
  border-color: var(--g-info-border, rgba(56,189,248,0.4));
  background: var(--g-info-soft, rgba(56,189,248,0.12));
  color: var(--g-info, #38bdf8);
}
.spec-chip[data-tone="idle"] { opacity: 0.65; }
`;

/** Test/navigation hook — drop panel-local state when the project changes. */
export function resetProjectSpecPanel(): void {
  _selectedSlug = "web-build";
  _mode = "merge";
  _saveName = "";
  _confirmingReplace = false;
  _pickerFor = null;
  _pickedWorkerId = "";
  _pickerBlockId = null;
  _bootedProjectId = null;
}
