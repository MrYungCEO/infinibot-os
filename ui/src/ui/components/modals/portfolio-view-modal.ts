/**
 * Global Portfolio modal — a wide grid of project cards with status / type
 * filters. Clicking a card opens the Project Detail modal (stacked above this
 * one). Module-level-state pattern (see project-detail-modal.ts).
 *
 * `openPortfolioModal(ctx, filter?)` — the optional `filter` pre-selects a
 * status chip (e.g. "In progress").
 */

import { html, nothing, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { AppViewState } from "../../app-view-state.js";
import type { KanbanProject } from "../../types.js";
import {
  type ModalContext,
  projectStatusColor,
  priorityColor,
} from "./modal-service.js";
import { openProjectDetailModal } from "./project-detail-modal.js";

// ── Module-level state ──────────────────────────────────────────────────────
let _open = false;
let _projects: KanbanProject[] = [];
let _loading = false;
let _error: string | null = null;
let _statusFilter: string | null = null;
let _typeFilter: string | null = null;
let _ctx: ModalContext | null = null;

export function isPortfolioOpen(): boolean {
  return _open;
}

export function openPortfolioModal(ctx: ModalContext, filter?: string): void {
  _ctx = ctx;
  _projects = [];
  _error = null;
  _statusFilter = filter ?? null;
  _typeFilter = null;
  _loading = true;
  _open = true;
  ctx.rerender();
  void loadData();
}

export function closePortfolioModal(): void {
  _open = false;
  _projects = [];
  _error = null;
  _ctx?.rerender();
}

async function loadData(): Promise<void> {
  if (!_ctx) return;
  try {
    const projects =
      (await _ctx.client.request<KanbanProject[]>("kanban.projects.list")) || [];
    if (!_open) return;
    _projects = projects;
    _loading = false;
    _ctx.rerender();
  } catch (err) {
    if (!_open) return;
    _error = err instanceof Error ? err.message : String(err);
    _loading = false;
    _ctx.rerender();
  }
}

function uniqueStatuses(): string[] {
  const set = new Set<string>();
  for (const p of _projects) if (p.status) set.add(p.status);
  return [...set];
}
function uniqueTypes(): string[] {
  const set = new Set<string>();
  for (const p of _projects) for (const t of p.type ?? []) set.add(t);
  return [...set];
}

function visibleProjects(): KanbanProject[] {
  return _projects.filter((p) => {
    if (_statusFilter && p.status !== _statusFilter) return false;
    if (_typeFilter && !(p.type ?? []).includes(_typeFilter)) return false;
    return true;
  });
}

function setStatusFilter(v: string | null): void {
  _statusFilter = _statusFilter === v ? null : v;
  _ctx?.rerender();
}
function setTypeFilter(v: string | null): void {
  _typeFilter = _typeFilter === v ? null : v;
  _ctx?.rerender();
}

// ── Render ──────────────────────────────────────────────────────────────────
export function renderPortfolioModal(
  _state: AppViewState,
): TemplateResult | typeof nothing {
  if (!_open) return nothing;

  const statuses = uniqueStatuses();
  const types = uniqueTypes();
  const visible = visibleProjects();

  return html`
    <div
      class="um-overlay"
      role="presentation"
      @click=${(e: MouseEvent) => {
        if (e.target === e.currentTarget) closePortfolioModal();
      }}
    >
      <div class="um-modal um-modal--wide" role="dialog" aria-modal="true" aria-label="Project portfolio">
        <span class="um-glow" aria-hidden="true"></span>

        <header class="um-header">
          <div class="um-header-main">
            <div class="um-eyebrow"><span class="um-eyebrow-dot"></span><span>InfiniBot · Portfolio</span></div>
            <h2 class="um-title">Projects ${visible.length ? html`<span class="um-progress-pct" style="font-size:14px">(${visible.length})</span>` : nothing}</h2>
          </div>
          <button class="um-close" aria-label="Close" @click=${() => closePortfolioModal()}>×</button>
        </header>

        <div class="um-body">
          ${_loading
            ? html`<div class="um-state"><div class="um-spinner"></div>Loading projects…</div>`
            : _error
              ? html`<div class="um-state um-state--error">${_error}</div>`
              : html`
                  ${statuses.length || types.length
                    ? html`<div class="um-filters">
                        ${statuses.length
                          ? html`<div class="um-filter-group">
                              <button class="um-filter-chip ${_statusFilter === null ? "is-active" : ""}" @click=${() => setStatusFilter(null)}>All</button>
                              ${statuses.map(
                                (s) => html`<button class="um-filter-chip ${_statusFilter === s ? "is-active" : ""}" @click=${() => setStatusFilter(s)}>${s}</button>`,
                              )}
                            </div>`
                          : nothing}
                        ${types.length
                          ? html`<div class="um-filter-group">
                              ${types.map(
                                (ty) => html`<button class="um-filter-chip ${_typeFilter === ty ? "is-active" : ""}" @click=${() => setTypeFilter(ty)}>${ty}</button>`,
                              )}
                            </div>`
                          : nothing}
                      </div>`
                    : nothing}

                  ${visible.length === 0
                    ? html`<div class="um-state">No projects match these filters.</div>`
                    : html`<div class="um-grid">
                        ${repeat(visible, (p) => p.id, (p) => renderCard(p))}
                      </div>`}
                `}
        </div>

        <footer class="um-footer">
          <span class="um-footer-spacer"></span>
          <button class="um-btn um-btn--secondary" @click=${() => closePortfolioModal()}>Close</button>
        </footer>
      </div>
    </div>
  `;
}

function renderCard(p: KanbanProject): TemplateResult {
  const status = p.status ?? "Not started";
  const statusCol = projectStatusColor(status);
  const progress = Math.max(0, Math.min(100, Math.round(p.progress ?? 0)));
  return html`
    <div
      class="um-card"
      role="button"
      tabindex="0"
      @click=${() => openCard(p.id)}
      @keydown=${(e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openCard(p.id);
        }
      }}
    >
      <div class="um-card-top">
        <span class="um-card-name">${p.name}</span>
        ${p.priority
          ? html`<span class="um-badge" style="color:${priorityColor(p.priority)}; font-size:9px; padding:2px 6px"><span class="um-badge-dot"></span></span>`
          : nothing}
      </div>
      ${p.description ? html`<div class="um-card-desc">${p.description}</div>` : nothing}
      <div class="um-progress" style="margin-top:2px">
        <div class="um-progress-fill" style="width:${progress}%"></div>
      </div>
      <div class="um-card-foot">
        <span class="um-badge" style="color:${statusCol}; font-size:10px; padding:2px 8px"><span class="um-badge-dot"></span>${status}</span>
        <span class="um-progress-pct" style="font-size:11px">${progress}%</span>
      </div>
    </div>
  `;
}

function openCard(projectId: string): void {
  if (!_ctx) return;
  openProjectDetailModal(projectId, _ctx);
}
