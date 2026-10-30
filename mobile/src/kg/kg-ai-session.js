/**
 * AI drawer session logic (no UI): the web <kg-ai-drawer>'s flow —
 * doc_agent.spawn on the selection, chat.send with the opening prompt, the
 * reply streamed from `chat` events, chat.history as the fallback.
 */
import * as core from './generated/kg-core';
import { extractText } from '../chat/session-sync';

const { aiPrompt } = core;

export const INTENT_LABEL = {
  chat: 'Chat',
  summarize: 'Summarize',
  related: 'Find related',
  consolidate: 'Consolidation plan',
  cluster: 'Auto-group',
};

export function hashIds(ids) {
  let h = 0x811c9dc5;
  for (const id of [...ids].sort()) {
    for (let i = 0; i < id.length; i++) {
      h ^= id.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  }
  return (h >>> 0).toString(36);
}

function newKey() {
  return `kgai-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Session logic (no UI) — exported for tests. `api` = { request, subscribe(event, fn) → off }.
 */
export function createAiSession(api, onChange) {
  const s = { req: null, sessionKey: null, systemPrompt: '', messages: [], streaming: null, busy: false, error: null };
  let off = null;
  const emit = () => onChange?.({ ...s, messages: [...s.messages] });
  const subscribe = () => {
    if (off || typeof api.subscribe !== 'function') return;
    off = api.subscribe('chat', (p) => {
      if (!p || p.sessionKey !== s.sessionKey) return;
      if (p.state === 'delta') {
        const t = extractText(p.message) ?? '';
        if (t && (!s.streaming || t.length >= s.streaming.length)) s.streaming = t;
      } else if (p.state === 'final') {
        const t = extractText(p.message) ?? s.streaming ?? '';
        s.streaming = null;
        s.busy = false;
        if (t) s.messages.push({ role: 'assistant', text: t });
        else void reloadHistory();
      } else if (p.state === 'aborted') {
        s.streaming = null;
        s.busy = false;
      } else if (p.state === 'error') {
        s.streaming = null;
        s.busy = false;
        s.error = String(p.errorMessage ?? 'The agent hit an error.');
      } else return;
      emit();
    });
  };
  const reloadHistory = async () => {
    if (!s.sessionKey) return;
    try {
      const hist = await api.request('chat.history', { sessionKey: s.sessionKey, limit: 50 });
      const last = [...(hist?.messages ?? [])].reverse().find((m) => m.role === 'assistant');
      const t = last ? (extractText(last) ?? '') : '';
      if (t) {
        s.messages.push({ role: 'assistant', text: t });
        emit();
      }
    } catch {
      /* the user can still open the session in Chat */
    }
  };
  const send = async (text, label) => {
    if (!s.sessionKey || !String(text).trim()) return;
    const first = !s.messages.some((m) => m.role === 'user');
    const message = first && s.systemPrompt ? `[INSTRUCTIONS — read once, then respond to my message]\n\n${s.systemPrompt}\n\n---\n\nMy message: ${text}` : text;
    s.messages.push({ role: 'user', text, label });
    s.busy = true;
    s.error = null;
    s.streaming = null;
    emit();
    try {
      await api.request('chat.send', { sessionKey: s.sessionKey, message, deliver: false, idempotencyKey: newKey() });
    } catch (err) {
      s.busy = false;
      s.error = err instanceof Error ? err.message : String(err);
      emit();
    }
  };
  return {
    state: s,
    async start(req) {
      const same = s.req && hashIds(s.req.nodeIds) === hashIds(req.nodeIds) && s.sessionKey;
      s.req = req;
      s.error = null;
      if (!same) {
        s.sessionKey = null;
        s.messages = [];
        s.streaming = null;
      }
      emit();
      subscribe();
      try {
        if (!s.sessionKey) {
          const res = await api.request('doc_agent.spawn', {
            docType: 'generic',
            documentId: `knowledge-graph-${hashIds(req.nodeIds)}`,
            title: `Knowledge graph · ${req.title}`,
            content: req.context,
            extra: 'Scope: items selected in the InfiniBot knowledge graph. Use your tools to read or update them when asked.',
          });
          if (!res?.sessionKey) throw new Error("The gateway didn't return a session.");
          s.sessionKey = res.sessionKey;
          s.systemPrompt = res.systemPrompt ?? '';
        }
        if (req.intent !== 'chat' || s.messages.length === 0) {
          await send(aiPrompt(req.intent, req.context, req.count), `${INTENT_LABEL[req.intent]} · ${req.title}`);
        }
      } catch (err) {
        s.busy = false;
        s.error = err instanceof Error ? err.message : String(err);
        emit();
      }
    },
    send,
    quick(intent) {
      if (!s.req) return;
      void send(aiPrompt(intent, s.req.context, s.req.count), `${INTENT_LABEL[intent]} · ${s.req.title}`);
    },
    async abort() {
      if (!s.sessionKey) return;
      try {
        await api.request('chat.abort', { sessionKey: s.sessionKey });
      } catch {
        /* already done */
      }
      s.busy = false;
      s.streaming = null;
      emit();
    },
    dispose() {
      off?.();
      off = null;
    },
  };
}
