/**
 * Keeps every model picker showing the same session in step. A surface that
 * changes a session's model (sessions.patch) announces it; the others apply it
 * to their own copy of that session instead of waiting for a refetch.
 */

export const SESSION_MODEL_EVENT = "infinibot:session-model";

export type SessionModelChange = {
  sessionKey: string;
  /** "provider/model" override, or null = back to the agent default. */
  model: string | null;
  /** The surface that made the change (so it can ignore its own echo). */
  source?: unknown;
};

type Target = Pick<EventTarget, "addEventListener" | "removeEventListener" | "dispatchEvent">;

function defaultTarget(): Target | null {
  return typeof window === "undefined" ? null : window;
}

export function announceSessionModel(change: SessionModelChange, target: Target | null = defaultTarget()): void {
  if (!change.sessionKey) return;
  target?.dispatchEvent(new CustomEvent<SessionModelChange>(SESSION_MODEL_EVENT, { detail: change }));
}

/** Subscribe to model changes made elsewhere. Returns the unsubscribe function. */
export function onSessionModel(
  handler: (change: SessionModelChange) => void,
  opts: { ignoreSource?: unknown; target?: Target | null } = {},
): () => void {
  const target = opts.target === undefined ? defaultTarget() : opts.target;
  if (!target) return () => {};
  const listener = (e: Event) => {
    const d = (e as CustomEvent<SessionModelChange>).detail;
    if (!d || typeof d.sessionKey !== "string") return;
    if (opts.ignoreSource !== undefined && d.source === opts.ignoreSource) return;
    handler(d);
  };
  target.addEventListener(SESSION_MODEL_EVENT, listener);
  return () => target.removeEventListener(SESSION_MODEL_EVENT, listener);
}
