/**
 * Global Client Detail modal.
 *
 * Same module-level-state pattern as project-detail-modal.ts. Client rows come
 * from the CRM (`clients.list`) as dynamic Notion-schema records:
 *   { id, data: Record<propName, value>, created_at, updated_at }
 * so field access is fuzzy — we scan `data` keys for name/status/tier/mrr/
 * tags/company rather than assuming a fixed shape. The canonical title comes
 * from the shared getClientName() helper the CRM view uses.
 */

import { html, nothing, type TemplateResult } from "lit";
import type { AppViewState } from "../../app-view-state.js";
import { getClientName } from "../../controllers/clients.js";
import {
  type ModalContext,
  avatarColor,
  initials,
  formatDate,
} from "./modal-service.js";

interface ClientRecord {
  id: string;
  data?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
  [k: string]: unknown;
}

// ── Module-level state ──────────────────────────────────────────────────────
let _open = false;
let _clientId: string | null = null;
let _client: ClientRecord | null = null;
let _schema: unknown = null;
let _projectCount = 0;
let _loading = false;
let _error: string | null = null;
let _ctx: ModalContext | null = null;

export function isClientDetailOpen(): boolean {
  return _open;
}

export function openClientDetailModal(clientId: string, ctx: ModalContext): void {
  _ctx = ctx;
  _clientId = clientId;
  _client = null;
  _schema = null;
  _projectCount = 0;
  _error = null;
  _loading = true;
  _open = true;
  ctx.rerender();
  void loadData(clientId);
}

export function closeClientDetailModal(): void {
  _open = false;
  _clientId = null;
  _client = null;
  _error = null;
  _ctx?.rerender();
}

async function loadData(clientId: string): Promise<void> {
  if (!_ctx) return;
  try {
    const res = (await _ctx.client.request("clients.list", { agencyId: null })) as
      | { clients?: ClientRecord[]; schema?: unknown }
      | undefined;
    const list = Array.isArray(res?.clients) ? res!.clients! : [];
    const record = list.find((c) => c.id === clientId) ?? null;
    if (!_open || _clientId !== clientId) return;
    _client = record;
    _schema = res?.schema ?? null;
    if (!record) _error = "Client not found";

    // Best-effort: count kanban projects linked to this client. Non-fatal.
    try {
      const projects =
        (await _ctx.client.request<Array<{ businessId?: string }>>("kanban.projects.list")) || [];
      _projectCount = projects.filter((p) => p.businessId === clientId).length;
    } catch {
      _projectCount = 0;
    }

    _loading = false;
    _ctx.rerender();
  } catch (err) {
    if (!_open || _clientId !== clientId) return;
    _error = err instanceof Error ? err.message : String(err);
    _loading = false;
    _ctx.rerender();
  }
}

// ── Fuzzy field access over the dynamic `data` bag ───────────────────────────
function findField(data: Record<string, unknown>, needles: string[]): unknown {
  for (const key of Object.keys(data)) {
    const norm = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    for (const n of needles) {
      if (norm.includes(n)) return data[key];
    }
  }
  return undefined;
}

function asText(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (Array.isArray(v)) return v.filter(Boolean).map(String).join(", ");
  return String(v);
}

function asTags(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter(Boolean).map(String);
  if (typeof v === "string" && v.trim()) return v.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  return [];
}

// ── Render ──────────────────────────────────────────────────────────────────
export function renderClientDetailModal(
  _state: AppViewState,
): TemplateResult | typeof nothing {
  if (!_open) return nothing;

  const c = _client;
  const name = c ? getClientName(c as never, _schema as never) : _loading ? "Loading…" : "Client";
  const data = (c?.data ?? {}) as Record<string, unknown>;

  const status = asText(findField(data, ["status", "stage", "pipeline"]));
  const tier = asText(findField(data, ["tier", "plan", "package"]));
  const mrr = asText(findField(data, ["mrr", "revenue", "value", "amount"]));
  const company = asText(findField(data, ["company", "organization", "org", "business"]));
  const email = asText(findField(data, ["email"]));
  const phone = asText(findField(data, ["phone", "mobile", "tel"]));
  const tags = asTags(findField(data, ["tag", "label", "category"]));

  return html`
    <div
      class="um-overlay"
      role="presentation"
      @click=${(e: MouseEvent) => {
        if (e.target === e.currentTarget) closeClientDetailModal();
      }}
    >
      <div class="um-modal" role="dialog" aria-modal="true" aria-label="Client details" style="max-width:560px">
        <span class="um-glow" aria-hidden="true"></span>

        <header class="um-header">
          <span class="um-avatar" style="background:${avatarColor(name)}; width:52px; height:52px; font-size:18px">
            ${initials(name)}
          </span>
          <div class="um-header-main">
            <div class="um-eyebrow"><span class="um-eyebrow-dot"></span><span>InfiniBot · Client</span></div>
            <h2 class="um-title">${name}</h2>
            ${company ? html`<div class="um-meta-label" style="margin-top:4px">${company}</div>` : nothing}
          </div>
          <button class="um-close" aria-label="Close" @click=${() => closeClientDetailModal()}>×</button>
        </header>

        <div class="um-body">
          ${_loading
            ? html`<div class="um-state"><div class="um-spinner"></div>Loading client…</div>`
            : _error
              ? html`<div class="um-state um-state--error">${_error}</div>`
              : html`
                  ${status || tier
                    ? html`<div class="um-chips">
                        ${status ? html`<span class="um-badge" style="color:#3b82f6"><span class="um-badge-dot"></span>${status}</span>` : nothing}
                        ${tier ? html`<span class="um-badge" style="color:#eab308"><span class="um-badge-dot"></span>${tier}</span>` : nothing}
                      </div>`
                    : nothing}

                  <div class="um-section">
                    <div class="um-meta">
                      ${mrr ? html`<div class="um-meta-field"><span class="um-meta-label">MRR</span><span class="um-meta-value">${/^\d/.test(mrr) ? "$" : ""}${mrr}</span></div>` : nothing}
                      <div class="um-meta-field"><span class="um-meta-label">Active Projects</span><span class="um-meta-value">${_projectCount}</span></div>
                      ${email ? html`<div class="um-meta-field"><span class="um-meta-label">Email</span><span class="um-meta-value">${email}</span></div>` : nothing}
                      ${phone ? html`<div class="um-meta-field"><span class="um-meta-label">Phone</span><span class="um-meta-value">${phone}</span></div>` : nothing}
                      <div class="um-meta-field"><span class="um-meta-label">Added</span><span class="um-meta-value">${formatDate(c?.created_at)}</span></div>
                    </div>
                  </div>

                  ${tags.length
                    ? html`<div class="um-section">
                        <div class="um-section-title">Tags</div>
                        <div class="um-chips">${tags.map((t) => html`<span class="um-chip">${t}</span>`)}</div>
                      </div>`
                    : nothing}
                `}
        </div>

        <footer class="um-footer">
          <button class="um-btn um-btn--secondary" ?disabled=${!c} @click=${() => viewProjects(_state)}>
            View Projects
          </button>
          <span class="um-footer-spacer"></span>
          <button class="um-btn um-btn--ghost" @click=${() => editClient(_state)}>Edit</button>
          <button class="um-btn um-btn--secondary" @click=${() => closeClientDetailModal()}>Close</button>
        </footer>
      </div>
    </div>
  `;
}

function viewProjects(state: AppViewState): void {
  // Jump to the projects board; the client link filter is applied there.
  try {
    state.setTab?.("projects" as never);
  } catch {
    /* noop */
  }
  closeClientDetailModal();
}

function editClient(state: AppViewState): void {
  // Route to the Clients CRM view where the full edit surface lives.
  try {
    state.setTab?.("clients" as never);
  } catch {
    /* noop */
  }
  closeClientDetailModal();
}
