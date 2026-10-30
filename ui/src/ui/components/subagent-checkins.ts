/**
 * Subagent Check-ins — mid-run check-in feed for the agent focus modal.
 *
 * ADDITIVE / self-contained: this module owns its own state + WS subscription +
 * polling so it can be dropped into subagent-detail-modal.ts with a minimal
 * footprint (one TabId, one tab button, one render call, mount/unmount on
 * open/close). It deliberately does NOT touch ModalState so it stays out of the
 * way of the parallel focus-modal work (in-UI diff viewer, spec-vs-result).
 *
 * Data source:
 *   • initial + poll  → `subagents.checkpoints` RPC
 *   • live            → `subagent.checkpoint` WS event (new event KIND)
 *
 * Operator messages (in-flight messaging): the composer at the top sends a
 * message into the RUNNING agent via `subagents.message`; the timeline shows
 * each message's delivery trail (queued → delivered → acknowledged) from
 * `subagents.messages` + the live `subagent.message` WS event.
 *
 * Two gate modes (decided server-side at spawn):
 *   • soft (default)  — check-ins surface live; a "Drift suspected" banner shows
 *     when a check-in mentions an off-limits file or looks like scope creep.
 *   • strict (gated)  — the agent is PAUSED on each check-in; the operator must
 *     Approve / Redirect (with an edited next-step plan) / Stop via this panel.
 */

import { html, nothing, type TemplateResult } from "lit";
import type { GatewayBrowserClient, GatewayEventFrame } from "../gateway";

export type CheckinDecision = "approve" | "redirect" | "stop";

export interface Checkin {
  id: string;
  runId: string;
  sessionKey: string;
  summary: string;
  next: string;
  deviations: string[];
  ts: number;
  driftSuspected: boolean;
  driftReasons: string[];
  gated: boolean;
  pending: boolean;
  decision?: CheckinDecision;
  editedNext?: string;
  note?: string;
  decidedAt?: number;
}

export type OperatorMessageStatus = "queued" | "delivered" | "acknowledged" | "expired";

export interface OperatorMessage {
  id: string;
  text: string;
  from: string;
  createdAt: number;
  status: OperatorMessageStatus;
  deliveredAt?: number;
  deliveredVia?: string;
  ackedAt?: number;
  expiredNote?: string;
}

interface CheckinState {
  runId: string;
  client: GatewayBrowserClient;
  requestUpdate: () => void;
  checkpoints: Checkin[];
  loading: boolean;
  error: string | null;
  /** Badge basis: check-ins with ts > lastSeenTs are "new". */
  lastSeenTs: number;
  unsub: (() => void) | null;
  poll: ReturnType<typeof setInterval> | null;
  editDrafts: Map<string, string>;
  deciding: Set<string>;
  messages: OperatorMessage[];
  messageDraft: string;
  sending: boolean;
  sendResult: string | null;
}

let _state: CheckinState | null = null;

function reqRpc(client: GatewayBrowserClient, method: string, params?: unknown): Promise<unknown> {
  return (client as unknown as { request: (m: string, p?: unknown) => Promise<unknown> }).request(
    method,
    params,
  );
}

/** Begin tracking a run's check-ins: initial load + WS subscription + poll. */
export function mountCheckins(
  client: GatewayBrowserClient,
  runId: string,
  requestUpdate: () => void,
  opts?: { running?: boolean },
): void {
  unmountCheckins();
  _state = {
    runId,
    client,
    requestUpdate,
    checkpoints: [],
    loading: true,
    error: null,
    lastSeenTs: 0,
    unsub: null,
    poll: null,
    editDrafts: new Map(),
    deciding: new Set(),
    messages: [],
    messageDraft: "",
    sending: false,
    sendResult: null,
  };

  void loadCheckins();
  void loadOperatorMessages();

  // Live updates via the dedicated checkpoint event kind.
  // NOTE: call subscribe() as a method on `client` (not via a detached
  // reference) — GatewayBrowserClient.subscribe reads `this.eventSubscribers`,
  // so a bare `const sub = client.subscribe; sub(...)` invocation loses `this`
  // and throws "Cannot read properties of undefined (reading 'eventSubscribers')".
  const subClient = client as unknown as {
    subscribe?: (h: (e: GatewayEventFrame) => void) => () => void;
  };
  if (typeof subClient.subscribe === "function") {
    _state.unsub = subClient.subscribe((evt: GatewayEventFrame) => {
      if (!_state) return;
      if (evt.event === "subagent.message") {
        const m = evt.payload as { runId?: string };
        if (m?.runId !== _state.runId) return;
        void loadOperatorMessages();
        return;
      }
      if (evt.event !== "subagent.checkpoint") return;
      const p = evt.payload as Partial<Checkin> & { checkpointId?: string };
      if (!p || p.runId !== _state.runId) return;
      _applyCheckpointEvent(p);
      _state.requestUpdate();
    });
  }

  // Poll fallback while the run is live (WS can drop; this keeps the feed honest).
  if (opts?.running !== false) {
    _state.poll = setInterval(() => {
      void loadCheckins();
      void loadOperatorMessages();
    }, 6000);
    (_state.poll as { unref?: () => void }).unref?.();
  }
}

export function unmountCheckins(): void {
  if (!_state) return;
  try {
    _state.unsub?.();
  } catch {
    /* ignore */
  }
  if (_state.poll) clearInterval(_state.poll);
  _state = null;
}

function _applyCheckpointEvent(p: Partial<Checkin> & { checkpointId?: string }): void {
  if (!_state) return;
  const id = p.id ?? p.checkpointId;
  if (!id) return;
  const existing = _state.checkpoints.find((c) => c.id === id);
  const merged: Checkin = {
    id,
    runId: _state.runId,
    sessionKey: p.sessionKey ?? existing?.sessionKey ?? "",
    summary: p.summary ?? existing?.summary ?? "",
    next: p.next ?? existing?.next ?? "",
    deviations: p.deviations ?? existing?.deviations ?? [],
    ts: p.ts ?? existing?.ts ?? Date.now(),
    driftSuspected: p.driftSuspected ?? existing?.driftSuspected ?? false,
    driftReasons: p.driftReasons ?? existing?.driftReasons ?? [],
    gated: p.gated ?? existing?.gated ?? false,
    pending: p.pending ?? false,
    decision: p.decision ?? existing?.decision,
    editedNext: p.editedNext ?? existing?.editedNext,
    note: p.note ?? existing?.note,
    decidedAt: p.decidedAt ?? existing?.decidedAt,
  };
  if (existing) {
    Object.assign(existing, merged);
  } else {
    _state.checkpoints.push(merged);
    _state.checkpoints.sort((a, b) => a.ts - b.ts);
  }
}

export async function loadCheckins(): Promise<void> {
  if (!_state) return;
  const { client, runId } = _state;
  try {
    const r = (await reqRpc(client, "subagents.checkpoints", { runId })) as {
      ok?: boolean;
      checkpoints?: Checkin[];
      error?: string;
    };
    if (!_state || _state.runId !== runId) return;
    if (r?.ok && Array.isArray(r.checkpoints)) {
      // Preserve any locally-known fields; replace wholesale otherwise.
      _state.checkpoints = r.checkpoints
        .slice()
        .sort((a, b) => a.ts - b.ts);
      _state.error = null;
    } else if (r && r.ok === false) {
      _state.error = r.error ?? "Failed to load check-ins";
    }
  } catch (e) {
    if (_state) _state.error = e instanceof Error ? e.message : String(e);
  } finally {
    if (_state) _state.loading = false;
    _state?.requestUpdate();
  }
}

export async function loadOperatorMessages(): Promise<void> {
  if (!_state) return;
  const { client, runId } = _state;
  try {
    const r = (await reqRpc(client, "subagents.messages", { runId })) as {
      ok?: boolean;
      messages?: OperatorMessage[];
    };
    if (!_state || _state.runId !== runId) return;
    if (r?.ok && Array.isArray(r.messages)) _state.messages = r.messages;
  } catch {
    /* older gateway without the RPC — the composer still reports send errors */
  } finally {
    _state?.requestUpdate();
  }
}

async function _sendOperatorMessage(): Promise<void> {
  if (!_state || _state.sending) return;
  const text = _state.messageDraft.trim();
  if (!text) return;
  const { client, runId } = _state;
  _state.sending = true;
  _state.sendResult = null;
  _state.requestUpdate();
  try {
    const r = (await reqRpc(client, "subagents.message", { runId, message: text })) as {
      ok?: boolean;
      status?: string;
      messageId?: string;
      expectedDelivery?: string;
      error?: string;
    };
    if (!_state) return;
    if (r?.ok) {
      _state.messageDraft = "";
      _state.sendResult = `Sent (${r.status}) — ${r.expectedDelivery ?? "the agent sees it at its next tool call"}.`;
    } else {
      _state.sendResult = `Not delivered: ${r?.status ?? "error"}${r?.error ? ` — ${r.error}` : ""}`;
    }
  } catch (e) {
    if (_state) _state.sendResult = `Send failed: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    if (_state) _state.sending = false;
    void loadOperatorMessages();
  }
}

/** Count of check-ins newer than the last time the tab was viewed. */
export function checkinsUnseenCount(runId: string): number {
  if (!_state || _state.runId !== runId) return 0;
  return (
    _state.checkpoints.filter((c) => c.ts > _state!.lastSeenTs).length +
    _state.messages.filter((m) => (m.ackedAt ?? m.deliveredAt ?? 0) > _state!.lastSeenTs).length
  );
}

/** True when a gated check-in is awaiting an operator decision. */
export function checkinsHasPending(runId: string): boolean {
  if (!_state || _state.runId !== runId) return false;
  return _state.checkpoints.some((c) => c.pending);
}

/** Mark the feed as seen (called when the Check-ins tab is opened). */
export function markCheckinsSeen(runId: string): void {
  if (!_state || _state.runId !== runId) return;
  _state.lastSeenTs = Date.now();
}

async function _decide(
  checkpointId: string,
  decision: CheckinDecision,
): Promise<void> {
  if (!_state) return;
  const cp = _state.checkpoints.find((c) => c.id === checkpointId);
  if (!cp || !cp.pending) return;
  const { client, runId } = _state;
  _state.deciding.add(checkpointId);
  _state.requestUpdate();
  const editedNext =
    decision === "redirect" ? _state.editDrafts.get(checkpointId)?.trim() || cp.next : undefined;
  try {
    const r = (await reqRpc(client, "subagents.checkpointDecision", {
      runId,
      checkpointId,
      decision,
      editedNext,
    })) as { ok?: boolean; error?: string };
    if (r?.ok) {
      // Optimistic local update; the WS echo will confirm.
      cp.pending = false;
      cp.decision = decision;
      if (editedNext) cp.editedNext = editedNext;
      cp.decidedAt = Date.now();
    } else {
      _state.error = r?.error ?? "Decision failed";
    }
  } catch (e) {
    if (_state) _state.error = e instanceof Error ? e.message : String(e);
  } finally {
    _state?.deciding.delete(checkpointId);
    _state?.requestUpdate();
  }
}

function _timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 5_000) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1_000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function _fmtClock(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

/** Render the Check-ins tab body for the given run. */
export function renderCheckinsTab(runId: string): TemplateResult {
  if (!_state || _state.runId !== runId) {
    return html`${checkinStyles()}<div class="sac-empty">No check-in data.</div>`;
  }
  const s = _state;
  const cps = s.checkpoints;
  const driftCount = cps.filter((c) => c.driftSuspected).length;
  const pending = cps.find((c) => c.pending);

  return html`
    ${checkinStyles()}
    <div class="sac-wrap">
      <div class="sac-head">
        <span class="sac-head-title">Check-ins</span>
        <span class="sac-head-sub">${cps.length} recorded${driftCount ? ` · ${driftCount} flagged` : ""}</span>
      </div>

      ${driftCount > 0 ? html`
        <div class="sac-drift-banner" role="alert">
          <span class="sac-drift-icon">⚠</span>
          <div class="sac-drift-body">
            <div class="sac-drift-title">Drift suspected</div>
            <div class="sac-drift-text">
              ${driftCount === 1 ? "A check-in" : `${driftCount} check-ins`} flagged a possible
              deviation from the brief (off-limits file or scope creep). Review below — you can
              intervene via the Live Session tab at any time.
            </div>
          </div>
        </div>
      ` : nothing}

      ${pending ? html`
        <div class="sac-pause-banner">
          <span class="sac-pause-dot"></span>
          Agent is PAUSED awaiting your decision on the latest check-in.
        </div>
      ` : nothing}

      ${renderOperatorMessages(s)}

      ${s.loading && cps.length === 0 ? html`
        <div class="sac-skel"></div>
        <div class="sac-skel" style="width:70%"></div>
      ` : nothing}

      ${!s.loading && cps.length === 0 ? html`
        <div class="sac-empty">
          No check-ins yet. Long-running agents emit one every ~10–15 minutes or every ~10 file
          edits, stating what they finished and what's next.
        </div>
      ` : nothing}

      ${s.error ? html`<div class="sac-error">${s.error}</div>` : nothing}

      <div class="sac-list">
        ${cps.slice().reverse().map((c) => renderCheckinRow(c, s))}
      </div>
    </div>
  `;
}

const MSG_STATUS_LABEL: Record<OperatorMessageStatus, string> = {
  queued: "QUEUED",
  delivered: "DELIVERED",
  acknowledged: "ACKNOWLEDGED",
  expired: "NOT DELIVERED",
};

function renderOperatorMessages(s: CheckinState): TemplateResult {
  const msgs = s.messages.slice().reverse();
  return html`
    <div class="sac-msg-box">
      <label class="sac-gate-label" for="sac-msg-input">Message the running agent</label>
      <textarea
        id="sac-msg-input"
        class="sac-gate-edit"
        rows="2"
        placeholder="e.g. Also add a unit test for the parser"
        .value=${s.messageDraft}
        @input=${(e: Event) => {
          s.messageDraft = (e.target as HTMLTextAreaElement).value;
          s.requestUpdate(); // enable/disable Send as the draft changes
        }}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void _sendOperatorMessage();
        }}
      ></textarea>
      <div class="sac-gate-actions">
        <button
          class="sac-btn sac-btn-redirect"
          ?disabled=${s.sending || !s.messageDraft.trim()}
          @click=${() => void _sendOperatorMessage()}
        >${s.sending ? "Sending…" : "Send"}</button>
        ${s.sendResult ? html`<span class="sac-msg-result">${s.sendResult}</span>` : nothing}
      </div>
    </div>
    ${msgs.length
      ? html`<div class="sac-list">
          ${msgs.map(
            (m) => html`
              <div class="sac-row sac-row-msg">
                <div class="sac-row-head">
                  <span class="sac-ts" title="${new Date(m.createdAt).toLocaleString()}"
                    >${_fmtClock(m.createdAt)} · ${_timeAgo(m.createdAt)}</span
                  >
                  <span class="sac-chip sac-chip-msg">OPERATOR</span>
                  <span class="sac-chip sac-msg-${m.status}">${MSG_STATUS_LABEL[m.status]}</span>
                </div>
                <div class="sac-text">${m.text}</div>
                <div class="sac-msg-trail">
                  ${m.deliveredAt
                    ? html`<span>Delivered ${_fmtClock(m.deliveredAt)} via ${m.deliveredVia ?? "?"}</span>`
                    : nothing}
                  ${m.ackedAt ? html`<span>· Acknowledged ${_fmtClock(m.ackedAt)}</span>` : nothing}
                  ${m.status === "queued"
                    ? html`<span>Waiting for the agent's next tool call…</span>`
                    : nothing}
                  ${m.status === "expired"
                    ? html`<span>${m.expiredNote ?? "Run ended before delivery"}</span>`
                    : nothing}
                </div>
              </div>
            `,
          )}
        </div>`
      : nothing}
  `;
}

function renderCheckinRow(c: Checkin, s: CheckinState): TemplateResult {
  const deciding = s.deciding.has(c.id);
  return html`
    <div class="sac-row${c.driftSuspected ? " sac-row-drift" : ""}${c.pending ? " sac-row-pending" : ""}">
      <div class="sac-row-head">
        <span class="sac-ts" title="${new Date(c.ts).toLocaleString()}">${_fmtClock(c.ts)} · ${_timeAgo(c.ts)}</span>
        ${c.gated ? html`<span class="sac-chip sac-chip-gate">GATED</span>` : nothing}
        ${c.driftSuspected ? html`<span class="sac-chip sac-chip-drift">DRIFT?</span>` : nothing}
        ${c.decision ? html`<span class="sac-chip sac-chip-decision sac-decision-${c.decision}">${c.decision.toUpperCase()}</span>` : nothing}
      </div>

      <div class="sac-line">
        <span class="sac-kicker">Just finished</span>
        <span class="sac-text">${c.summary || "—"}</span>
      </div>
      <div class="sac-line">
        <span class="sac-kicker sac-kicker-next">Doing next</span>
        <span class="sac-text">${c.editedNext && c.decision === "redirect" ? c.editedNext : c.next || "—"}</span>
      </div>

      ${c.deviations.length ? html`
        <div class="sac-devs">
          ${c.deviations.map((d) => html`<span class="sac-dev-chip" title="Flagged deviation">${d}</span>`)}
        </div>
      ` : nothing}

      ${c.driftSuspected && c.driftReasons.length ? html`
        <div class="sac-drift-reasons">
          ${c.driftReasons.map((r) => html`<span class="sac-reason">${r}</span>`)}
        </div>
      ` : nothing}

      ${c.pending ? html`
        <div class="sac-gate">
          <label class="sac-gate-label">Edit the next-step plan (for Redirect):</label>
          <textarea
            class="sac-gate-edit"
            .value=${s.editDrafts.get(c.id) ?? c.next}
            @input=${(e: Event) => {
              s.editDrafts.set(c.id, (e.target as HTMLTextAreaElement).value);
            }}
            rows="3"
          ></textarea>
          <div class="sac-gate-actions">
            <button
              class="sac-btn sac-btn-approve"
              ?disabled=${deciding}
              @click=${() => void _decide(c.id, "approve")}
            >${deciding ? "…" : "Approve"}</button>
            <button
              class="sac-btn sac-btn-redirect"
              ?disabled=${deciding}
              @click=${() => void _decide(c.id, "redirect")}
            >Redirect</button>
            <button
              class="sac-btn sac-btn-stop"
              ?disabled=${deciding}
              @click=${() => void _decide(c.id, "stop")}
            >Stop</button>
          </div>
        </div>
      ` : nothing}

      ${c.note ? html`<div class="sac-note">${c.note}</div>` : nothing}
    </div>
  `;
}

let _stylesInjected = false;
function checkinStyles(): TemplateResult | typeof nothing {
  // Lit dedupes identical <style> within a render, but we only need it once per
  // tab render anyway. Returning it every render is harmless (scoped to modal).
  void _stylesInjected;
  return html`
    <style>
      .sac-wrap { display:flex; flex-direction:column; gap:12px; padding:4px 2px 24px; }
      .sac-head { display:flex; align-items:baseline; gap:10px; }
      .sac-head-title { font-size:15px; font-weight:700; color:var(--g-fg,#f5f5f4); }
      .sac-head-sub { font-size:12px; color:var(--g-fg-dim,rgba(245,245,244,0.6)); }
      .sac-drift-banner {
        display:flex; gap:10px; align-items:flex-start; padding:10px 12px; border-radius:10px;
        background:rgba(245,158,11,0.12); border:1px solid rgba(245,158,11,0.4);
      }
      .sac-drift-icon { color:#f59e0b; font-size:16px; line-height:1.3; }
      .sac-drift-title { font-weight:700; color:#f59e0b; font-size:13px; }
      .sac-drift-text { font-size:12px; color:var(--g-fg-dim,rgba(245,245,244,0.8)); margin-top:2px; }
      .sac-pause-banner {
        display:flex; align-items:center; gap:8px; padding:8px 12px; border-radius:10px;
        background:rgba(239,68,68,0.12); border:1px solid rgba(239,68,68,0.45);
        color:#fca5a5; font-size:12px; font-weight:600;
      }
      .sac-pause-dot { width:8px; height:8px; border-radius:50%; background:#ef4444; animation:sac-pulse 1.4s infinite; }
      @keyframes sac-pulse { 0%,100%{opacity:1;} 50%{opacity:0.3;} }
      .sac-list { display:flex; flex-direction:column; gap:10px; }
      .sac-row {
        border:1px solid var(--g-border,rgba(245,245,244,0.1)); border-radius:10px;
        padding:10px 12px; background:var(--g-bg-2,rgba(255,255,255,0.02));
      }
      .sac-row-drift { border-color:rgba(245,158,11,0.4); }
      .sac-row-pending { border-color:rgba(239,68,68,0.5); box-shadow:0 0 0 1px rgba(239,68,68,0.25); }
      .sac-row-head { display:flex; align-items:center; gap:8px; margin-bottom:8px; flex-wrap:wrap; }
      .sac-ts { font-size:11px; color:var(--g-fg-dim,rgba(245,245,244,0.55)); font-variant-numeric:tabular-nums; }
      .sac-chip { font-size:10px; font-weight:700; padding:1px 6px; border-radius:5px; letter-spacing:0.3px; }
      .sac-chip-gate { background:rgba(99,102,241,0.18); color:#a5b4fc; }
      .sac-chip-drift { background:rgba(245,158,11,0.18); color:#fbbf24; }
      .sac-chip-decision { }
      .sac-decision-approve { background:rgba(34,197,94,0.18); color:#4ade80; }
      .sac-decision-redirect { background:rgba(59,130,246,0.18); color:#60a5fa; }
      .sac-decision-stop { background:rgba(239,68,68,0.18); color:#f87171; }
      .sac-line { display:flex; gap:8px; margin:3px 0; align-items:baseline; }
      .sac-kicker {
        font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:0.4px;
        color:#4ade80; min-width:78px; flex-shrink:0; padding-top:1px;
      }
      .sac-kicker-next { color:#60a5fa; }
      .sac-text { font-size:13px; color:var(--g-fg,#f5f5f4); line-height:1.45; white-space:pre-wrap; }
      .sac-devs { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
      .sac-dev-chip {
        font-size:11px; padding:2px 8px; border-radius:6px;
        background:rgba(245,158,11,0.12); border:1px solid rgba(245,158,11,0.35); color:#fbbf24;
      }
      .sac-drift-reasons { display:flex; flex-direction:column; gap:3px; margin-top:6px; }
      .sac-reason { font-size:11px; color:#fbbf24; }
      .sac-gate { margin-top:10px; padding-top:10px; border-top:1px dashed var(--g-border,rgba(245,245,244,0.12)); }
      .sac-gate-label { font-size:11px; color:var(--g-fg-dim,rgba(245,245,244,0.6)); display:block; margin-bottom:4px; }
      .sac-gate-edit {
        width:100%; box-sizing:border-box; resize:vertical; font-size:12px; line-height:1.4;
        padding:6px 8px; border-radius:8px; background:var(--g-bg,rgba(0,0,0,0.25));
        border:1px solid var(--g-border,rgba(245,245,244,0.15)); color:var(--g-fg,#f5f5f4);
        font-family:inherit;
      }
      .sac-gate-actions { display:flex; gap:8px; margin-top:8px; }
      .sac-btn {
        font-size:12px; font-weight:600; padding:6px 14px; border-radius:8px; cursor:pointer;
        border:1px solid transparent; color:#fff;
      }
      .sac-btn:disabled { opacity:0.5; cursor:default; }
      .sac-btn-approve { background:#16a34a; }
      .sac-btn-redirect { background:#2563eb; }
      .sac-btn-stop { background:#dc2626; }
      .sac-note {
        margin-top:8px; font-size:11px; font-style:italic;
        color:var(--g-fg-dim,rgba(245,245,244,0.6));
      }
      .sac-msg-box { display:flex; flex-direction:column; gap:4px; }
      .sac-msg-result { font-size:11px; color:var(--g-fg-dim,rgba(245,245,244,0.7)); align-self:center; }
      .sac-row-msg { border-color:rgba(212,175,55,0.35); }
      .sac-chip-msg { background:rgba(212,175,55,0.16); color:#e9c46a; }
      .sac-msg-queued { background:rgba(148,163,184,0.18); color:#cbd5e1; }
      .sac-msg-delivered { background:rgba(59,130,246,0.18); color:#60a5fa; }
      .sac-msg-acknowledged { background:rgba(34,197,94,0.18); color:#4ade80; }
      .sac-msg-expired { background:rgba(239,68,68,0.18); color:#f87171; }
      .sac-msg-trail { display:flex; gap:6px; flex-wrap:wrap; margin-top:6px; font-size:11px; color:var(--g-fg-dim,rgba(245,245,244,0.6)); }
      .sac-empty { font-size:13px; color:var(--g-fg-dim,rgba(245,245,244,0.6)); padding:18px 4px; line-height:1.5; }
      .sac-error { font-size:12px; color:#f87171; }
      .sac-skel { height:48px; border-radius:10px; background:linear-gradient(90deg,rgba(255,255,255,0.04),rgba(255,255,255,0.08),rgba(255,255,255,0.04)); background-size:200% 100%; animation:sac-shimmer 1.4s infinite; }
      @keyframes sac-shimmer { 0%{background-position:200% 0;} 100%{background-position:-200% 0;} }
    </style>
  `;
}
