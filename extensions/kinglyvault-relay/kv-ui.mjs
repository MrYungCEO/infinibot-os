// Agent E: InfiniBot drives the KinglyVault page the member has open.
//
// The relay only carries browser → device requests, so each open KV tab starts
// one long-lived `ui.session` request. This hub streams page commands and panels
// down it as request events; the tab answers each command with a `ui.result`
// request. The tab enforces the safety rules (allow-list, human-only controls,
// Stop): they live with the member, not with the agent. Everything here only
// routes messages.

import { randomBytes } from 'node:crypto';

export const COMMAND_OPS = ['navigate', 'highlight', 'click', 'type', 'scroll', 'select_tab', 'open_modal', 'close_modal', 'read_state', 'clear', 'say'];
export const PANEL_KINDS = ['markdown', 'table', 'chart', 'form', 'html', 'image', 'output'];
const SESSION_MS = 29 * 60_000; // KV's ui.session maxRunMs is 30 min; the tab re-attaches
const COMMAND_TIMEOUT_MS = 15_000;
const PANEL_MAX_CHARS = 44_000;
const CLOSED = new Set([401, 404, 409, 410]);

const newId = () => randomBytes(9).toString('base64url');

export class UiHub {
  constructor({ commandTimeoutMs = COMMAND_TIMEOUT_MS, sessionMs = SESSION_MS } = {}) {
    this.tabs = new Map(); // tabId → { tabId, emit, route, title, lastSeenAt, done }
    this.pending = new Map(); // cmdId → { resolve, tabId }
    this.commandTimeoutMs = commandTimeoutMs;
    this.sessionMs = sessionMs;
    this.unbindGateway = null;
  }

  /** Runs for the life of a ui.session request. Resolves when the tab is gone or the session ages out. */
  attach({ tabId, route, title }, emit) {
    this.detach(tabId);
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.detach(tabId), this.sessionMs);
      timer.unref?.();
      this.tabs.set(tabId, {
        tabId,
        emit,
        route: route || null,
        title: title || null,
        lastSeenAt: Date.now(),
        done: (why) => {
          clearTimeout(timer);
          resolve({ detached: true, why });
        },
      });
      void emit([{ type: 'kv.ui.ready', data: { tabId } }]);
    });
  }

  detach(tabId, why = 'replaced') {
    const t = this.tabs.get(tabId);
    if (!t) return;
    this.tabs.delete(tabId);
    t.done(why);
    for (const [id, p] of this.pending) {
      if (p.tabId === tabId) {
        this.pending.delete(id);
        p.resolve({ ok: false, retry: true, error: 'The KinglyVault tab closed.' });
      }
    }
  }

  /** A ui.result from a tab: a command's answer, or a presence update (cmdId "presence"). */
  receive({ tabId, cmdId, ok, result, error }) {
    const t = this.tabs.get(tabId);
    if (t) {
      t.lastSeenAt = Date.now();
      if (cmdId === 'presence') {
        t.route = result?.route ?? t.route;
        t.title = result?.title ?? t.title;
        if (result?.closing) this.detach(tabId, 'closed');
        return { received: true };
      }
    }
    const p = this.pending.get(cmdId);
    if (!p || p.tabId !== tabId) return { received: false };
    this.pending.delete(cmdId);
    p.resolve({ ok: ok === true, ...(result && typeof result === 'object' ? result : {}), ...(error ? { error } : {}) });
    return { received: true };
  }

  /** Newest active tab first (the one the member touched last). */
  orderedTabs() {
    return [...this.tabs.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  status() {
    return { tabOpen: this.tabs.size > 0, tabs: this.orderedTabs().map((t) => ({ route: t.route, title: t.title })) };
  }

  async deliver(tab, events) {
    const status = await tab.emit(events);
    if (CLOSED.has(status)) {
      this.detach(tab.tabId, 'closed');
      return false;
    }
    return true;
  }

  async commandOn(tab, op, args) {
    const cmdId = newId();
    const answer = new Promise((resolve) => {
      const timer = setTimeout(() => {
        // A tab that went quiet re-attaches when it sees it was forgotten (presence).
        if (!this.pending.delete(cmdId)) return;
        this.detach(tab.tabId, 'silent');
        resolve({ ok: false, retry: true, error: 'The KinglyVault tab did not answer.' });
      }, this.commandTimeoutMs);
      timer.unref?.();
      this.pending.set(cmdId, {
        tabId: tab.tabId,
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
      });
    });
    if (!(await this.deliver(tab, [{ type: 'kv.ui', data: { cmdId, op, args } }]))) {
      this.pending.delete(cmdId);
      return { ok: false, retry: true, error: 'The KinglyVault tab closed.' };
    }
    return answer;
  }

  /** Sends one page command to the member's active tab, falling back to their other tabs. */
  async command(op, args = {}) {
    if (!COMMAND_OPS.includes(op)) return { ok: false, error: `Unknown page action ${op}.` };
    let last = null;
    for (const tab of this.orderedTabs()) {
      const res = await this.commandOn(tab, op, args);
      if (!res.retry) return res;
      last = res;
    }
    const { retry: _retry, ...out } = last ?? { ok: false, error: 'No KinglyVault tab is open. Ask the member to open KinglyVault.' };
    return out;
  }

  async pushPanel(panel) {
    if (panel.close !== true && !PANEL_KINDS.includes(panel.kind) && !panel.forwarded) return { ok: false, error: `kind must be one of ${PANEL_KINDS.join(', ')}.` };
    const id = panel.id || `panel_${newId()}`;
    const data = { ...panel, id };
    if (JSON.stringify(data).length > PANEL_MAX_CHARS) return { ok: false, error: `That panel is too large (max ${PANEL_MAX_CHARS} characters). Trim it.` };
    for (const tab of this.orderedTabs()) {
      if (await this.deliver(tab, [{ type: 'kv.panel', data }])) return { ok: true, panelId: id };
    }
    return { ok: false, error: 'No KinglyVault tab is open. Ask the member to open KinglyVault.' };
  }

  /** Forwards show_panel panels from this link's KV sessions into the open tab. */
  bindGateway(gw, connectionId) {
    if (this.unbindGateway) return;
    const prefix = `:kv-${String(connectionId || 'kv').slice(0, 8)}`;
    this.unbindGateway = gw.on((evt) => {
      if (evt.event !== 'chat.panel.show') return;
      const p = evt.payload || {};
      if (typeof p.sourceSession !== 'string' || !p.sourceSession.includes(prefix)) return;
      void gw
        .request('chat.panel.resolve', { kind: p.kind, query: p.query || {}, ...(p.title ? { title: p.title } : {}) })
        .catch(() => null)
        .then((r) => this.pushPanel(forwardedPanel(p, r)));
    });
  }

  /** kv_ui, the agent tool. */
  async tool(params) {
    const action = String(params.action || '');
    if (action === 'status') return { ok: true, ...this.status() };
    if (action === 'show_panel') {
      const { action: _a, ...panel } = params;
      return this.pushPanel(panel);
    }
    if (action === 'close_panel') return this.pushPanel({ id: params.id, close: true });
    const { action: _a, ...args } = params;
    return this.command(action, args);
  }
}

/** What KV renders for an InfiniBot show_panel card: rows for tables, the markdown fallback for the rest. */
export function forwardedPanel(p, resolved) {
  const data = resolved?.data ?? p.initial;
  const isTable = p.kind === 'table' || p.kind === 'agents' || p.kind === 'clients' || p.kind === 'opportunities';
  const rows = isTable && data && typeof data === 'object' ? data : undefined;
  const fit = rows && JSON.stringify(rows).length < 24_000 ? rows : undefined;
  return {
    id: p.panelId,
    forwarded: true,
    kind: p.kind,
    query: p.query || {},
    title: resolved?.title || p.title || p.kind,
    summary: p.summary || resolved?.summary || '',
    text: String(resolved?.text || '').slice(0, 16_000),
    ...(fit ? { data: fit } : {}),
    error: p.error ?? resolved?.error ?? null,
  };
}

export const uiHub = new UiHub();
