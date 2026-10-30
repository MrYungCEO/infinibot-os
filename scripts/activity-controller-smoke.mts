#!/usr/bin/env node
/**
 * Smoke for the hardened /activity controller.
 *
 * The controller assumes a browser (window, document, localStorage) so
 * this script stubs the minimum surface those touchpoints need before
 * importing. We then exercise the pieces that have actual logic:
 *
 *   1. Event dedup by `seq`
 *   2. Orphan-event quarantine when session is unknown
 *   3. Orphan replay after the session arrives via poll
 *   4. Auto-reopen of `completedViaEvent` on a new tool event
 *   5. `forceCompleteSession` flips terminal state locally
 *   6. `startActivityPolling` is idempotent (no leaked timers/listeners)
 *   7. `stopActivityPolling` cleans up everything
 *   8. Mesh messages age-cap drops entries beyond 6h
 *
 * Run: node --import tsx scripts/activity-controller-smoke.mts
 */

// ── Browser stubs ─────────────────────────────────────────────
//
// Must be in place BEFORE we import the controller module — top-level
// code reaches for `localStorage` etc. when it loads.

const memStore = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => memStore.get(k) ?? null,
  setItem: (k: string, v: string) => void memStore.set(k, v),
  removeItem: (k: string) => void memStore.delete(k),
};

let intervalSeq = 0;
const intervals = new Map<number, ReturnType<typeof setInterval>>();
(globalThis as any).window = {
  setInterval: (fn: () => void, ms: number) => {
    const id = ++intervalSeq;
    intervals.set(id, setInterval(fn, ms));
    return id;
  },
  clearInterval: (id: number) => {
    const h = intervals.get(id);
    if (h) clearInterval(h);
    intervals.delete(id);
  },
};

const docListeners = new Map<string, Array<() => void>>();
(globalThis as any).document = {
  visibilityState: "visible",
  addEventListener: (kind: string, fn: () => void) => {
    if (!docListeners.has(kind)) docListeners.set(kind, []);
    docListeners.get(kind)!.push(fn);
  },
  removeEventListener: (kind: string, fn: () => void) => {
    const arr = docListeners.get(kind);
    if (!arr) return;
    const idx = arr.indexOf(fn);
    if (idx >= 0) arr.splice(idx, 1);
  },
};

// Stub `confirm` (used by some flows we don't exercise here but the
// global is touched on import in some builds).
(globalThis as any).confirm = () => true;

// ── Import controller (after stubs) ───────────────────────────

const ctrl = await import(
  "../ui/src/ui/controllers/agent-activity.ts"
);
type AgentActivityState = Awaited<
  ReturnType<typeof ctrl.createInitialActivityState>
>;

function ok(label: string) { console.log(`✓ ${label}`); }
function fail(label: string, detail?: unknown): never {
  console.error(`✗ ${label}`);
  if (detail !== undefined) console.error("  detail:", detail);
  process.exit(1);
}

// ── Minimal AppViewState + gateway client stub ────────────────

interface FakeState {
  agentActivityState: ReturnType<typeof ctrl.createInitialActivityState>;
  requestUpdate: () => void;
}
function makeState(): FakeState {
  return {
    agentActivityState: ctrl.createInitialActivityState(),
    requestUpdate: () => {},
  };
}

type Handler = (e: { event: string; payload?: unknown }) => void;

function makeClient(opts: {
  sessions?: Array<Record<string, unknown>>;
  failNext?: boolean;
  meshMessages?: Array<Record<string, unknown>>;
} = {}) {
  let unsubCount = 0;
  const handlers: Handler[] = [];
  const requestLog: Array<{ method: string; params: unknown }> = [];
  return {
    requests: requestLog,
    request: async (method: string, params: unknown) => {
      requestLog.push({ method, params });
      if (opts.failNext) {
        opts.failNext = false;
        throw new Error("simulated gateway failure");
      }
      if (method === "sessions.list") {
        return { sessions: opts.sessions ?? [] };
      }
      if (method === "sessions.preview") {
        return { previews: [] };
      }
      if (method === "federation.mesh.messages") {
        return { success: true, messages: opts.meshMessages ?? [] };
      }
      return {};
    },
    subscribe: (handler: Handler) => {
      handlers.push(handler);
      return () => { unsubCount++; };
    },
    _emit: (evt: { event: string; payload?: unknown }) => {
      for (const h of handlers) h(evt);
    },
    _unsubCount: () => unsubCount,
  };
}

// Helper — build a session row in the shape sessions.list returns.
function row(key: string, label: string, agentId = "main") {
  return {
    key,
    agentId,
    label,
    displayName: label,
    updatedAt: Date.now(),
    sessionId: key,
  };
}

// ── 1. Event dedup by seq ─────────────────────────────────────
{
  const state = makeState() as any;
  // Seed with a known session so events aren't orphaned.
  state.agentActivityState.sessions.push({
    key: "agent:main:abc",
    agentId: "main",
    agentName: "🔥 Infini (Main)",
    kind: "main",
    active: true,
    updatedAt: Date.now(),
    steps: [],
    expanded: false,
    loadingHistory: false,
    previewLoaded: false,
  });

  const evt = {
    sessionKey: "agent:main:abc",
    stream: "tool",
    seq: 5,
    ts: Date.now(),
    data: { phase: "start", name: "Read", arguments: { file: "x.ts" } },
  };
  // dispatch via the internal export — but handleLiveAgentEvent isn't
  // exported. Use the subscribe handler path: build a tiny client +
  // start polling so the subscription is wired.
  const client = makeClient({ sessions: [] });
  ctrl.startActivityPolling(state, client as any);
  client._emit({ event: "agent", payload: evt });
  client._emit({ event: "agent", payload: evt }); // duplicate seq
  client._emit({ event: "agent", payload: { ...evt, seq: 4 } }); // out-of-order seq

  const s = state.agentActivityState.sessions.find((x: any) => x.key === "agent:main:abc");
  if (s.steps.length !== 1) {
    fail(`expected 1 step after dedup, got ${s.steps.length}`, s.steps);
  }
  ctrl.stopActivityPolling(state);
  ok("event dedup: duplicate seq + lower seq dropped");
}

// ── 2. Orphan quarantine ──────────────────────────────────────
{
  const state = makeState() as any;
  const client = makeClient({ sessions: [] });
  ctrl.startActivityPolling(state, client as any);

  client._emit({
    event: "agent",
    payload: {
      sessionKey: "agent:unknown:99",
      stream: "tool",
      seq: 1,
      data: { phase: "start", name: "Bash" },
    },
  });

  const q = state.agentActivityState.orphanedEvents;
  if (q.length !== 1) fail(`expected 1 orphaned event, got ${q.length}`);
  // No ghost session created.
  if (state.agentActivityState.sessions.some((s: any) => s.key === "agent:unknown:99")) {
    fail("orphan event created a ghost session (should be quarantined instead)");
  }
  ctrl.stopActivityPolling(state);
  ok("orphan event quarantined, no ghost session created");
}

// ── 3. Orphan replay on next poll ─────────────────────────────
{
  const state = makeState() as any;
  const sessions = [row("agent:main:replay", "Replay test")];
  const client = makeClient({ sessions });
  ctrl.startActivityPolling(state, client as any);
  // Wait for the initial loadAgentActivity to flush before injecting.
  await new Promise((r) => setTimeout(r, 20));

  // Queue an orphan event for a session not yet known.
  client._emit({
    event: "agent",
    payload: {
      sessionKey: "agent:main:will-arrive",
      stream: "tool",
      seq: 1,
      data: { phase: "start", name: "Read" },
    },
  });
  if (state.agentActivityState.orphanedEvents.length !== 1) {
    fail("orphan not queued in step 3 setup");
  }

  // Now make that session appear in the next poll, then call
  // loadAgentActivity manually.
  sessions.push(row("agent:main:will-arrive", "Late session"));
  await ctrl.loadAgentActivity(state, client as any, { silent: true });
  // Allow the followup loadPreviewsForSessions() microtasks to settle.
  await new Promise((r) => setTimeout(r, 10));

  const target = state.agentActivityState.sessions.find(
    (s: any) => s.key === "agent:main:will-arrive",
  );
  if (!target) fail("late session didn't make it into sessions[]");
  if (target.steps.length !== 1) {
    fail(`orphan didn't replay; got ${target.steps.length} steps`, target.steps);
  }
  if (state.agentActivityState.orphanedEvents.length !== 0) {
    fail("orphanedEvents queue should be empty after successful drain");
  }
  ctrl.stopActivityPolling(state);
  ok("orphan event replays into session on next poll, queue empties");
}

// ── 4. Auto-reopen completedViaEvent on new tool event ────────
{
  const state = makeState() as any;
  state.agentActivityState.sessions.push({
    key: "agent:main:reopen",
    agentId: "main",
    agentName: "main",
    kind: "main",
    active: false,
    completedViaEvent: true,
    completionState: "done",
    updatedAt: Date.now(),
    steps: [],
    expanded: false,
    loadingHistory: false,
    previewLoaded: false,
  });
  const client = makeClient();
  ctrl.startActivityPolling(state, client as any);

  client._emit({
    event: "agent",
    payload: {
      sessionKey: "agent:main:reopen",
      stream: "tool",
      seq: 10,
      data: { phase: "start", name: "Edit" },
    },
  });

  const s = state.agentActivityState.sessions.find(
    (x: any) => x.key === "agent:main:reopen",
  );
  if (s.completedViaEvent) fail("session should have been re-opened");
  if (!s.active) fail("session should be marked active again");
  ctrl.stopActivityPolling(state);
  ok("new tool event clears stale completedViaEvent + reactivates session");
}

// ── 5. forceCompleteSession ───────────────────────────────────
{
  const state = makeState() as any;
  state.agentActivityState.sessions.push({
    key: "agent:main:stuck",
    agentId: "main",
    agentName: "main",
    kind: "main",
    active: true,
    updatedAt: Date.now() - 999999,
    steps: [],
    expanded: false,
    loadingHistory: false,
    previewLoaded: false,
  });
  ctrl.forceCompleteSession(state, "agent:main:stuck");
  const s = state.agentActivityState.sessions[0];
  if (s.active) fail("active should be false after force-complete");
  if (!s.completedViaEvent) fail("completedViaEvent should be true");
  if (s.completionState !== "done") fail("completionState should be 'done'");
  ok("forceCompleteSession flips terminal state locally");
}

// ── 6. startActivityPolling idempotent ────────────────────────
{
  const state = makeState() as any;
  const client = makeClient();
  ctrl.startActivityPolling(state, client as any);
  const firstId = state.agentActivityState.pollIntervalId;
  ctrl.startActivityPolling(state, client as any); // call again
  const secondId = state.agentActivityState.pollIntervalId;
  if (firstId === secondId) {
    fail("second start should have torn down the first and started fresh");
  }
  // Only one interval should be live now.
  if (intervals.size !== 1) fail(`expected 1 live interval, have ${intervals.size}`);
  ctrl.stopActivityPolling(state);
  if (intervals.size !== 0) fail("stopActivityPolling didn't drain intervals");
  ok("startActivityPolling is idempotent; stop drains intervals");
}

// ── 7. visibilitychange pauses + resumes polling ──────────────
{
  const state = makeState() as any;
  const client = makeClient();
  ctrl.startActivityPolling(state, client as any);
  if (state.agentActivityState.paused) fail("should not start paused when document is visible");
  if (state.agentActivityState.pollIntervalId === null) fail("interval should be live");

  // Flip to hidden + fire listener
  (globalThis as any).document.visibilityState = "hidden";
  for (const fn of docListeners.get("visibilitychange") ?? []) fn();
  if (!state.agentActivityState.paused) fail("should be paused after hidden");
  if (state.agentActivityState.pollIntervalId !== null) {
    fail("interval should have been cleared on pause");
  }

  // Flip back to visible
  (globalThis as any).document.visibilityState = "visible";
  for (const fn of docListeners.get("visibilitychange") ?? []) fn();
  if (state.agentActivityState.paused) fail("should no longer be paused after visible");
  if (state.agentActivityState.pollIntervalId === null) {
    fail("interval should have restarted on resume");
  }
  ctrl.stopActivityPolling(state);
  ok("visibilitychange pauses then resumes interval cleanly");
}

// ── 8. consecutiveFailures + retry ────────────────────────────
{
  const state = makeState() as any;
  const client = makeClient({ failNext: true });
  await ctrl.loadAgentActivity(state, client as any, { silent: true });
  if (state.agentActivityState.consecutiveFailures !== 1) {
    fail(`expected 1 failure, got ${state.agentActivityState.consecutiveFailures}`);
  }
  if (!state.agentActivityState.error) fail("error should be set");
  if (!state.agentActivityState.lastErrorAt) fail("lastErrorAt should be set");
  // Now succeed.
  await ctrl.loadAgentActivity(state, client as any, { silent: true });
  if (state.agentActivityState.consecutiveFailures !== 0) {
    fail("consecutiveFailures should reset to 0 on success");
  }
  if (state.agentActivityState.error) fail("error should clear on success");
  if (!state.agentActivityState.lastSuccessAt) fail("lastSuccessAt should be set");
  ok("failures increment, then reset on success; error clears");
}

// ── 9. Mesh age cap drops entries older than 6h ───────────────
{
  const state = makeState() as any;
  const sixHoursAgo = Date.now() - 7 * 60 * 60 * 1000; // 7h — over the cap
  const recent = Date.now() - 60_000; // 1 min — well under the cap
  const client = makeClient({
    meshMessages: [
      { id: "old", timestamp: sixHoursAgo, from: "a", to: "b", type: "broadcast", payload: {}, delivered: true, read: false },
      { id: "new", timestamp: recent, from: "a", to: "b", type: "broadcast", payload: {}, delivered: true, read: false },
    ],
  });
  await ctrl.loadAgentActivity(state, client as any, { silent: true });
  const msgs = state.agentActivityState.meshMessages;
  if (msgs.length !== 1) fail(`expected 1 mesh message after age cap, got ${msgs.length}`);
  if (msgs[0].id !== "new") fail(`expected 'new' message to survive, got '${msgs[0].id}'`);
  ok("mesh messages age-capped (entries older than 6h dropped)");
}

console.log("\nOK — /activity controller hardening verified");
