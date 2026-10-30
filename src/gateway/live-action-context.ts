/**
 * Live Action Mode request context.
 *
 * The voice-chat UI sets `liveActionMode: true` on each /api/voice/chat/stream
 * POST when the sidebar is engaged. We need that signal to reach the agent's
 * tool-builder (deep inside the dispatch pipeline) so we can strip the
 * `browser` tool out of the agent's tool list and refuse browser-launch
 * shell commands.
 *
 * We can't use AsyncLocalStorage here because the dispatch chain crosses a
 * command-queue boundary in src/agents/pi-embedded-runner/run.ts — by the
 * time the tool-builder runs, the original async stack (and any ALS context
 * set at the HTTP-request boundary) is gone.
 *
 * Instead we keep a small in-memory Map keyed by sessionKey. The voice
 * stream writes the flag before dispatching; the tool-builder reads it
 * keyed off the agent's sessionKey. Each new voice turn overwrites the
 * entry, so the state is always the truth of the most recent turn — no
 * cleanup needed.
 */

import type { DocAgentType, DocAgentModalities } from "../agents/doc-agent-prompts.js";

const liveActionBySession = new Map<string, boolean>();

export function setLiveActionForSession(sessionKey: string | undefined, enabled: boolean): void {
  if (!sessionKey) return;
  if (enabled) liveActionBySession.set(sessionKey, true);
  else liveActionBySession.delete(sessionKey);
}

export function isLiveActionActive(sessionKey?: string): boolean {
  if (!sessionKey) return false;
  return liveActionBySession.get(sessionKey) === true;
}

/**
 * Grid context — when the user is operating from the multi-panel Grid view,
 * the voice UI ships the panel layout (ids, types, titles) on each POST so
 * the agent's preamble can address panels by id and dispatch grid:* verbs at
 * a specific target. Stored in a parallel session-keyed map so the
 * tool-builder / preamble can pick it up after the command-queue boundary.
 */
export interface GridPanelContext {
  panelId: string;
  type: string; // "voice" | "kanban" | "activity" | "session" | ...
  title: string;
  scope?: string; // e.g. projectId for kanban, databaseId for database
}

export interface GridContext {
  panelIds: string[];
  panels: GridPanelContext[];
  activeVoicePanelId?: string;
  injectionMode?: "default" | "grid" | "custom";
  customPrompt?: string;
}

const gridContextBySession = new Map<string, GridContext>();

export function setGridContextForSession(
  sessionKey: string | undefined,
  ctx: GridContext | null,
): void {
  if (!sessionKey) return;
  if (ctx) gridContextBySession.set(sessionKey, ctx);
  else gridContextBySession.delete(sessionKey);
}

export function getGridContextForSession(sessionKey?: string): GridContext | null {
  if (!sessionKey) return null;
  return gridContextBySession.get(sessionKey) ?? null;
}

// ── Doc-scoped live-action ─────────────────────────────────────────────
//
// When a `<doc-agent-panel>` opens a live-action stream we tag the
// session with a DocScope so the voice / observation routers can filter
// events down to the one document. The `filterEvent` helper is the
// canonical test: if the session has no docScope, everything passes
// (legacy / grid behavior); if it does, only events tagged with a
// matching docScope are forwarded.

export interface DocScope {
  docType: DocAgentType;
  documentId: string;
  title?: string;
}

const docScopeBySession = new Map<string, DocScope>();

export function setDocScopeForSession(
  sessionKey: string | undefined,
  scope: DocScope | null,
): void {
  if (!sessionKey) return;
  if (scope) docScopeBySession.set(sessionKey, scope);
  else docScopeBySession.delete(sessionKey);
}

export function getDocScopeForSession(sessionKey?: string): DocScope | null {
  if (!sessionKey) return null;
  return docScopeBySession.get(sessionKey) ?? null;
}

/**
 * Event shape coming off the UI's live-action stream. Each event carries
 * an optional `docScope` describing the document the user was in when the
 * event fired (or undefined for global / chrome-level events). The voice
 * router drops events whose docScope doesn't match a doc-scoped session.
 */
export interface LiveActionEvent {
  kind: string;
  ts?: number;
  docScope?: { docType: string; documentId: string };
  // Free-form payload; the router doesn't inspect it.
  [key: string]: unknown;
}

/**
 * True when `event` should be forwarded to a session whose docScope is
 * `scope`. If the session is not doc-scoped (`scope == null`), everything
 * passes — this preserves the existing grid / global behavior. If the
 * event has no docScope, it is a global UI event and is DROPPED for
 * doc-scoped sessions (the agent must stay focused on its document).
 */
export function filterEvent(scope: DocScope | null, event: LiveActionEvent): boolean {
  if (!scope) return true;
  if (!event || typeof event !== "object") return false;
  const ev = event.docScope;
  if (!ev || typeof ev !== "object") return false;
  return ev.docType === scope.docType && ev.documentId === scope.documentId;
}

// ── Per-session modality flags ─────────────────────────────────────────
//
// Set via `doc_agent.set_modalities`. The voice-stream / live-action
// routers consult these before accepting a stream — e.g. a brand_doc
// session has voice ON but liveActionObserve OFF by default, so the
// observation router refuses to attach.

const docModalitiesBySession = new Map<string, DocAgentModalities>();

export function setDocModalitiesForSession(
  sessionKey: string | undefined,
  modalities: DocAgentModalities | null,
): void {
  if (!sessionKey) return;
  if (modalities) docModalitiesBySession.set(sessionKey, modalities);
  else docModalitiesBySession.delete(sessionKey);
}

export function getDocModalitiesForSession(sessionKey?: string): DocAgentModalities | null {
  if (!sessionKey) return null;
  return docModalitiesBySession.get(sessionKey) ?? null;
}
