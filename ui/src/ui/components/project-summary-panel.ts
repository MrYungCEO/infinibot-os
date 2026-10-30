/**
 * AI Current-State Summary + revision/communication panel for the project page.
 *
 * Rendered inside the kanban project detail "content" tab (see kanban.ts). It
 * shows the PM-agent-synthesized current-state briefing, with:
 *   - a "Refresh summary" button      → project-summary.generate
 *   - a text "dump" box + Apply       → project-summary.revise (source: text)
 *   - a "Quick voice call" button     → reuses the EXISTING <voice-chat> stack
 *                                        via the infinibot:project-voice-call
 *                                        event handled in app-render.ts; the
 *                                        spoken dump is reconciled by the PM
 *                                        agent into the same summary path.
 *
 * Written as a function-component (module-level state + props.requestUpdate),
 * matching project-spec-panel.ts so it composes into the same detail panel
 * without a separate custom-element registration.
 */
import { html, nothing, type TemplateResult } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { toSanitizedMarkdownHtml } from "../markdown";
import type { GatewayBrowserClient } from "../gateway";

export interface ProjectSummaryPanelProps {
  project: { id: string; name?: string };
  client: GatewayBrowserClient | undefined;
  requestUpdate: (() => void) | undefined;
}

interface SummaryRecord {
  projectId: string;
  markdown: string;
  generatedAt: number;
  model: string;
  source: string;
  inputHash?: string;
  revisions: { at: number; source: string; input: string }[];
}

// ── Module-level UI state (per-open-project; not persisted) ────────────────
let _loadedProjectId: string | null = null;
let _summary: SummaryRecord | null = null;
let _loading = false;
let _generating = false;
let _revising = false;
let _dumpText = "";
let _error: string | null = null;
/** True when the loaded summary is missing or stale (data changed / >24h old). */
let _stale = false;
/** True while a BACKGROUND (non-blocking) auto-generation is running. */
let _autoGenerating = false;
/** Per-projectId guard so re-renders / concurrent loads never double-generate. */
const _autoGenInFlight = new Set<string>();

function fmtTime(ts: number): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return "";
  }
}

async function loadSummary(props: ProjectSummaryPanelProps): Promise<void> {
  const { project, client, requestUpdate } = props;
  if (!client) return;
  _loading = true;
  _error = null;
  requestUpdate?.();
  try {
    const res = await client.request("project-summary.get", { projectId: project.id });
    _summary = (res?.summary as SummaryRecord | null) ?? null;
    _stale = Boolean(res?.stale);
  } catch (e) {
    _error = String(e);
  } finally {
    _loading = false;
    requestUpdate?.();
  }
  // AUTO-GENERATE ON LOAD: if there's no summary yet OR the cached one is stale,
  // regenerate in the BACKGROUND (non-blocking). The cached summary — if any —
  // stays on screen with a subtle "updating…" indicator until the fresh result
  // swaps in. Fresh/unchanged projects skip this entirely (no LLM call).
  maybeAutoGenerate(props);
}

/** Kick a background regeneration when the summary is missing or stale. */
function maybeAutoGenerate(props: ProjectSummaryPanelProps): void {
  const { project, client } = props;
  if (!client) return;
  if (!_stale && _summary) return; // fresh cache — serve as-is, no LLM call
  if (_autoGenInFlight.has(project.id)) return; // dedupe concurrent generations
  void backgroundGenerate(props);
}

async function backgroundGenerate(props: ProjectSummaryPanelProps): Promise<void> {
  const { project, client, requestUpdate } = props;
  if (!client || _autoGenInFlight.has(project.id)) return;
  _autoGenInFlight.add(project.id);
  _autoGenerating = true;
  requestUpdate?.();
  try {
    const res = await client.request("project-summary.generate", { projectId: project.id });
    // Only apply if the operator is still viewing the same project.
    if (_loadedProjectId === project.id) {
      _summary = (res?.summary as SummaryRecord | null) ?? _summary;
      _stale = false;
      _error = null;
    }
  } catch (e) {
    if (_loadedProjectId === project.id) _error = String(e);
  } finally {
    _autoGenInFlight.delete(project.id);
    if (_loadedProjectId === project.id) _autoGenerating = false;
    requestUpdate?.();
  }
}

/** Ensure the panel state is bound to the currently-open project. */
function ensureLoaded(props: ProjectSummaryPanelProps): void {
  if (_loadedProjectId === props.project.id) return;
  _loadedProjectId = props.project.id;
  _summary = null;
  _dumpText = "";
  _error = null;
  _stale = false;
  _autoGenerating = false;
  void loadSummary(props);
}

/** Manual "Refresh summary" — force a regeneration, ignoring the cache. */
async function onGenerate(props: ProjectSummaryPanelProps): Promise<void> {
  const { project, client, requestUpdate } = props;
  if (!client || _generating) return;
  _generating = true;
  _autoGenInFlight.add(project.id); // block a concurrent background auto-gen
  _error = null;
  requestUpdate?.();
  try {
    const res = await client.request("project-summary.generate", { projectId: project.id });
    _summary = (res?.summary as SummaryRecord | null) ?? _summary;
    _stale = false;
  } catch (e) {
    _error = String(e);
  } finally {
    _generating = false;
    _autoGenInFlight.delete(project.id);
    requestUpdate?.();
  }
}

async function onApplyDump(props: ProjectSummaryPanelProps): Promise<void> {
  const { project, client, requestUpdate } = props;
  const text = _dumpText.trim();
  if (!client || _revising || !text) return;
  _revising = true;
  _error = null;
  requestUpdate?.();
  try {
    const res = await client.request("project-summary.revise", {
      projectId: project.id,
      text,
      source: "text",
    });
    _summary = (res?.summary as SummaryRecord | null) ?? _summary;
    _dumpText = "";
  } catch (e) {
    _error = String(e);
  } finally {
    _revising = false;
    requestUpdate?.();
  }
}

/**
 * Launch the existing voice-call UI scoped to this project. app-render.ts
 * listens for this event, seeds the session with a reconciliation preamble and
 * enables Live Action mode on the persistent <voice-chat> element — no new
 * voice stack is created here.
 */
function onQuickVoiceCall(props: ProjectSummaryPanelProps): void {
  try {
    window.dispatchEvent(
      new CustomEvent("infinibot:project-voice-call", {
        detail: { projectId: props.project.id, projectName: props.project.name ?? props.project.id },
      }),
    );
  } catch {
    /* noop */
  }
}

export function renderProjectSummaryPanel(props: ProjectSummaryPanelProps): TemplateResult {
  ensureLoaded(props);
  const s = _summary;
  const busy = _loading || _generating;
  // Show the synth placeholder for a manual refresh, or for a background
  // auto-generation when there's no cached summary to display yet.
  const synthesizing = _generating || (_autoGenerating && !s?.markdown);

  const body = synthesizing
    ? html`<div class="ps-empty ps-busy">Synthesizing current state…</div>`
    : s?.markdown
      ? html`<div class="ps-md md-body">${unsafeHTML(toSanitizedMarkdownHtml(s.markdown))}</div>`
      : _loading
        ? html`<div class="ps-empty">Loading…</div>`
        : html`<div class="ps-empty">No AI summary yet. It's being generated automatically — or click <strong>Refresh summary</strong> to synthesize the current state now.</div>`;

  // Subtle "updating…" chip: cached summary is on screen while a fresh one
  // regenerates in the background.
  const updatingChip =
    _autoGenerating && s?.markdown
      ? html`<span class="ps-updating"><span class="dot"></span> updating…</span>`
      : nothing;

  const meta = s
    ? html`<span class="ps-meta">Updated ${fmtTime(s.generatedAt)} · ${s.model}${s.source === "revision" ? " · from dump" : s.source === "cron" ? " · auto (daily)" : ""}</span>`
    : nothing;

  return html`
    <style>
      .ps-summary-card {
        margin-top: 6px;
        border: 1px solid var(--panel-edge, rgba(212, 175, 55, 0.22));
        border-radius: 14px;
        background: linear-gradient(160deg, rgba(20, 18, 10, 0.55), rgba(10, 10, 12, 0.35));
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        padding: 14px 16px;
      }
      .ps-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
      .ps-head-title { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 13px; letter-spacing: 0.02em; color: var(--gold, #d4af37); }
      .ps-head-title .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--gold, #d4af37); box-shadow: 0 0 8px rgba(212,175,55,0.7); }
      .ps-meta { font-size: 10px; color: #8a8577; }
      .ps-actions { display: flex; gap: 8px; flex-wrap: wrap; }
      .ps-btn {
        font-size: 11px; font-weight: 600; padding: 5px 11px; border-radius: 9px; cursor: pointer;
        border: 1px solid rgba(212,175,55,0.35); color: #f3e4b3; background: rgba(212,175,55,0.08);
        transition: background 0.15s, border-color 0.15s;
      }
      .ps-btn:hover:not(:disabled) { background: rgba(212,175,55,0.18); border-color: rgba(212,175,55,0.6); }
      .ps-btn:disabled { opacity: 0.5; cursor: default; }
      .ps-btn-voice { border-color: rgba(120,200,255,0.4); color: #cfe9ff; background: rgba(80,160,255,0.08); }
      .ps-btn-voice:hover:not(:disabled) { background: rgba(80,160,255,0.18); border-color: rgba(120,200,255,0.7); }
      .ps-md { font-size: 12.5px; line-height: 1.55; color: #e8e4d8; }
      .ps-md h1, .ps-md h2, .ps-md h3, .ps-md strong { color: #f2e9cf; }
      .ps-empty { font-size: 12px; color: #9a958a; padding: 8px 2px; }
      .ps-busy { color: var(--gold, #d4af37); }
      .ps-revise { margin-top: 12px; border-top: 1px dashed rgba(212,175,55,0.18); padding-top: 12px; }
      .ps-revise-label { font-size: 11px; font-weight: 600; color: #c9c2af; margin-bottom: 6px; display: flex; align-items: center; gap: 6px; }
      .ps-textarea {
        width: 100%; box-sizing: border-box; min-height: 62px; resize: vertical;
        font-size: 12px; line-height: 1.5; color: #ece7da; padding: 8px 10px; border-radius: 9px;
        background: rgba(0,0,0,0.35); border: 1px solid rgba(212,175,55,0.2); font-family: inherit;
      }
      .ps-textarea:focus { outline: none; border-color: rgba(212,175,55,0.55); }
      .ps-revise-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
      .ps-hint { font-size: 10px; color: #7f7a6d; }
      .ps-err { font-size: 11px; color: #f0a0a0; margin-top: 6px; }
      .ps-err-retry { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
      .ps-updating {
        display: inline-flex; align-items: center; gap: 5px; margin-left: 8px;
        font-size: 10px; font-weight: 500; letter-spacing: 0; color: #cbb46a;
        opacity: 0.85; text-transform: none;
      }
      .ps-updating .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--gold, #d4af37); animation: ps-pulse 1.1s ease-in-out infinite; }
      @keyframes ps-pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
    </style>
    <div class="ps-summary-card">
      <div class="ps-head">
        <div class="ps-head-title"><span class="dot"></span> AI Current-State Summary ${updatingChip}</div>
        <div class="ps-actions">
          <button class="ps-btn" ?disabled=${busy || !props.client} @click=${() => void onGenerate(props)}>
            ${_generating ? "Refreshing…" : "↻ Refresh summary"}
          </button>
        </div>
      </div>
      ${meta}
      ${body}
      ${
        _error && !_revising
          ? html`<div class="ps-err ps-err-retry">
              <span>⚠ ${_error}</span>
              <button
                class="ps-btn"
                ?disabled=${busy || !props.client}
                @click=${() => void onGenerate(props)}
              >Retry</button>
            </div>`
          : nothing
      }

      <div class="ps-revise">
        <div class="ps-revise-label">Revise / communicate current state</div>
        <textarea
          class="ps-textarea"
          placeholder="Dump real-world changes that aren't logged yet — scope shifts, blockers, client updates. The project manager folds it into the summary above."
          .value=${_dumpText}
          @input=${(e: Event) => { _dumpText = (e.target as HTMLTextAreaElement).value; }}
        ></textarea>
        <div class="ps-revise-row">
          <span class="ps-hint">Text dump updates the spec & current state · Voice call reconciles hands-free</span>
          <div class="ps-actions">
            <button
              class="ps-btn ps-btn-voice"
              ?disabled=${!props.client}
              title="Quick voice call — dump changes by talking; reuses the voice-chat stack"
              @click=${() => onQuickVoiceCall(props)}
            >🎙 Quick voice call</button>
            <button
              class="ps-btn"
              ?disabled=${_revising || !_dumpText.trim() || !props.client}
              @click=${() => void onApplyDump(props)}
            >${_revising ? "Applying…" : "Apply update"}</button>
          </div>
        </div>
        ${_error && _revising ? html`<div class="ps-err">${_error}</div>` : nothing}
      </div>
    </div>
  `;
}
