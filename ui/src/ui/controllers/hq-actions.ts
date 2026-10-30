/**
 * Business HQ — action executor + dashboard UI state.
 *
 * Runs the plans built by `hq-model.ts#planAction`:
 *   1. apply the optimistic patch to the live arrays the dashboard renders
 *      (state.kanbanTasks or the HQ object stores) and re-render at once;
 *   2. run the RPC steps in order (a step may use the previous step's result,
 *      e.g. the id of a task it just created);
 *   3. on any failure, restore the exact arrays captured before step 1 and
 *      surface the error — the UI never shows a write that didn't happen.
 *
 * Real-time refresh is the gateway's job: kanban writes broadcast
 * `kanban:changed`, which reloads the board while the dashboard is open; the
 * object stores are re-listed here after an object write.
 */
import type { KanbanTask } from "../types";
import { extractText } from "../chat/message-extract";
import { hqObjectsState, loadHqObjects, noteHqObjectWrite, type HqObjectsState } from "./business-hq-objects";
import { beginPendingTaskWrite } from "./kanban-pending-writes";
import { dayKey, type ActionPlan, type HqKind, type HqMetricKey, type ProgressEvent } from "./hq-model";

export interface RpcClient {
  request(method: string, params?: unknown): Promise<unknown>;
}

export interface HqHost {
  kanbanTasks: KanbanTask[];
  requestUpdate?: () => void;
}

// ── Optimistic apply / rollback ──────────────────────────────────────────────

type ObjKey = "decisions" | "ceoDecisions" | "risks" | "commitments" | "opportunities" | "clients";
const OBJ_KEYS: Record<Exclude<HqKind, "task" | "project">, ObjKey[]> = {
  decision: ["decisions", "ceoDecisions"],
  risk: ["risks"],
  commitment: ["commitments"],
  opportunity: ["opportunities"],
  client: ["clients"],
};

interface Snapshot {
  /** The task row as it was before the optimistic patch (rolled back alone). */
  task?: KanbanTask;
  objects?: Partial<Record<ObjKey, unknown[]>>;
}

function applyOptimistic(host: HqHost, objects: HqObjectsState, plan: ActionPlan): Snapshot {
  const o = plan.optimistic;
  if (!o) return {};
  if (o.kind === "task") {
    const before = host.kanbanTasks.find((t) => t.id === o.id);
    host.kanbanTasks = host.kanbanTasks.map((t) => (t.id === o.id ? ({ ...t, ...o.patch } as KanbanTask) : t));
    return before ? { task: before } : {};
  }
  if (o.kind === "project") return {};
  const snap: Snapshot = { objects: {} };
  for (const key of OBJ_KEYS[o.kind]) {
    const arr = objects[key] as Array<{ id: string }>;
    snap.objects![key] = arr;
    (objects as unknown as Record<string, unknown>)[key] = arr.map((x) => (x.id === o.id ? { ...x, ...o.patch } : x));
  }
  return snap;
}

function rollback(host: HqHost, objects: HqObjectsState, snap: Snapshot): void {
  // Only the written row: the board may have reloaded since the snapshot.
  const prev = snap.task;
  if (prev) host.kanbanTasks = host.kanbanTasks.map((t) => (t.id === prev.id ? prev : t));
  for (const [key, arr] of Object.entries(snap.objects ?? {})) {
    (objects as unknown as Record<string, unknown>)[key] = arr;
  }
}

export interface RunResult {
  ok: boolean;
  error?: string;
  results: unknown[];
}

/** Execute a plan with optimistic UI and rollback. Pure enough to unit-test with fakes. */
export async function runPlan(
  host: HqHost,
  client: RpcClient,
  plan: ActionPlan,
  objects: HqObjectsState = hqObjectsState,
): Promise<RunResult> {
  const snap = applyOptimistic(host, objects, plan);
  // Pending from the start: a board reload while the request is in flight
  // (another write's kanban:changed, bulk actions) re-applies it.
  const o0 = plan.optimistic;
  const undoPending = o0?.kind === "task" ? beginPendingTaskWrite(o0.id, o0.patch) : null;
  host.requestUpdate?.();
  // An object-store list already in flight read the pre-write rows — make it re-list.
  const objectWrite = plan.steps.some((s) => OBJECT_METHOD.test(s.method));
  if (objectWrite) noteHqObjectWrite();
  const results: unknown[] = [];
  let prev: unknown = null;
  try {
    for (const step of plan.steps) {
      const params = typeof step.params === "function" ? step.params(prev) : step.params;
      prev = await client.request(step.method, params);
      // Older gateways answer ok with `notionSyncFailed` when Notion refused the
      // write: the board reads Notion, so the change would silently revert.
      if ((prev as { notionSyncFailed?: unknown } | null)?.notionSyncFailed === true) {
        throw new Error("Notion didn't save the change — try again");
      }
      results.push(prev);
    }
    if (objectWrite) noteHqObjectWrite();
    return { ok: true, results };
  } catch (err) {
    undoPending?.();
    rollback(host, objects, snap);
    host.requestUpdate?.();
    return { ok: false, error: err instanceof Error ? err.message : String(err), results };
  }
}

// ── Dashboard UI state (module-level, one dashboard per window) ─────────────

export interface HqToast {
  id: number;
  msg: string;
  tone: "ok" | "err" | "info";
  undo?: () => void;
}

export interface HqProgressData {
  settings: { dailyTarget: number; parentProjectId: string | null; snoozes: Record<string, number> };
  events: ProgressEvent[];
  snapshots: Record<string, { first: { at: number; metrics: Record<string, number> }; last: { at: number; metrics: Record<string, number> } }>;
}

export const hqUi = {
  toast: null as HqToast | null,
  /** Item id currently being written (disables its buttons). */
  busy: new Set<string>(),
  /** Last completion (drives the celebration animation). */
  celebrate: null as { id: string; at: number } | null,
  progress: null as HqProgressData | null,
  /** true when the gateway doesn't serve hq.* yet (pre-restart). */
  progressUnavailable: false,
  progressLoading: false,
  lastKanbanLoadAt: 0,
  agents: [] as Array<{ id: string; name: string }>,
  agentsLoaded: false,
};

let toastSeq = 0;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

export function showToast(host: HqHost, msg: string, tone: HqToast["tone"] = "ok", undo?: () => void): void {
  hqUi.toast = { id: ++toastSeq, msg, tone, undo };
  host.requestUpdate?.();
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    hqUi.toast = null;
    host.requestUpdate?.();
  }, undo ? 7000 : 4000);
}

export function dismissToast(host: HqHost): void {
  hqUi.toast = null;
  host.requestUpdate?.();
}

const OBJECT_METHOD = /^(decision|risk|commitment|opportunity|clients)\./;

/**
 * Run an action from the UI: busy flag, optimistic write, toast, progress
 * refresh and (for object stores) a re-list so derived fields like `stale`
 * are recomputed by the server.
 */
export async function performAction(
  host: HqHost,
  client: RpcClient,
  itemId: string,
  plan: ActionPlan,
  opts: { undo?: () => void; onDone?: (r: RunResult) => void } = {},
): Promise<RunResult> {
  hqUi.busy.add(itemId);
  const res = await runPlan(host, client, plan);
  hqUi.busy.delete(itemId);
  if (res.ok) {
    if (plan.completes) hqUi.celebrate = { id: itemId, at: Date.now() };
    showToast(host, plan.success, "ok", opts.undo);
    void loadHqProgress(host, client);
    if (plan.steps.some((s) => OBJECT_METHOD.test(s.method))) {
      void loadHqObjects(host as never, client as never);
    }
  } else {
    showToast(host, `Couldn't save — ${res.error ?? "unknown error"}. Nothing was changed.`, "err");
  }
  opts.onDone?.(res);
  host.requestUpdate?.();
  return res;
}

// ── Progress + settings ──────────────────────────────────────────────────────

export async function loadHqProgress(host: HqHost, client: RpcClient): Promise<void> {
  if (hqUi.progressLoading) return;
  hqUi.progressLoading = true;
  try {
    hqUi.progress = (await client.request("hq.progress.get", {})) as HqProgressData;
    hqUi.progressUnavailable = false;
  } catch (err) {
    // Pre-restart gateway: the dashboard stays fully actionable, only the
    // persisted progress strip explains itself.
    if (/unknown method|not found|method/i.test(String(err))) hqUi.progressUnavailable = true;
  } finally {
    hqUi.progressLoading = false;
    host.requestUpdate?.();
  }
}

let lastSnapshotSig = "";
let lastSnapshotAt = 0;

/** Record today's metrics (first call of the day becomes the baseline). Throttled. */
export async function snapshotMetrics(client: RpcClient, metrics: Record<HqMetricKey, number>, now = Date.now()): Promise<void> {
  if (hqUi.progressUnavailable) return;
  const sig = JSON.stringify(metrics);
  if (sig === lastSnapshotSig && now - lastSnapshotAt < 10 * 60_000) return;
  lastSnapshotSig = sig;
  lastSnapshotAt = now;
  try {
    const pair = (await client.request("hq.progress.snapshot", { day: dayKey(now), metrics })) as HqProgressData["snapshots"][string];
    if (hqUi.progress && pair) hqUi.progress.snapshots = { ...hqUi.progress.snapshots, [dayKey(now)]: pair };
  } catch {
    /* non-fatal */
  }
}

export async function saveHqSettings(
  host: HqHost,
  client: RpcClient,
  patch: { dailyTarget?: number; parentProjectId?: string | null },
): Promise<boolean> {
  try {
    const res = (await client.request("hq.settings.set", patch)) as { settings: HqProgressData["settings"] };
    if (hqUi.progress) hqUi.progress.settings = res.settings;
    else hqUi.progress = { settings: res.settings, events: [], snapshots: {} };
    showToast(host, "Dashboard settings saved");
    return true;
  } catch (err) {
    showToast(host, `Couldn't save settings — ${err instanceof Error ? err.message : String(err)}`, "err");
    return false;
  }
}

// ── Agents (assign / hand-off targets) ───────────────────────────────────────

export async function ensureAgents(host: HqHost, client: RpcClient): Promise<void> {
  if (hqUi.agentsLoaded) return;
  hqUi.agentsLoaded = true;
  try {
    const res = (await client.request("agents.list", {})) as { agents?: Array<Record<string, unknown>> } | undefined;
    hqUi.agents = (res?.agents ?? [])
      .map((a) => ({
        id: String(a.id ?? a.agentId ?? ""),
        name: String((a.identity as { name?: string } | undefined)?.name ?? a.name ?? a.id ?? ""),
      }))
      .filter((a) => a.id);
  } catch {
    hqUi.agents = [];
  }
  host.requestUpdate?.();
}

// ── Linked goal runs ─────────────────────────────────────────────────────────

export interface GoalSummary {
  id: string;
  title: string;
  status: string;
  createdAt: number;
  checksPassing?: number;
  checksTotal?: number;
}
let goalsCache: { at: number; goals: GoalSummary[] } | null = null;

export async function listGoals(client: RpcClient, force = false): Promise<GoalSummary[]> {
  if (!force && goalsCache && Date.now() - goalsCache.at < 30_000) return goalsCache.goals;
  try {
    const res = (await client.request("goals.list", { limit: 200 })) as { goals?: GoalSummary[] };
    goalsCache = { at: Date.now(), goals: res?.goals ?? [] };
  } catch {
    goalsCache = { at: Date.now(), goals: [] };
  }
  return goalsCache.goals;
}

export function invalidateGoals(): void {
  goalsCache = null;
}

// ── Ask an agent (recommendation / subtasks / drafts) ────────────────────────

/**
 * One-shot question to a gateway agent: chat.send on a dedicated session,
 * wait for the run, read the assistant's reply from history. Uses its own
 * session so it never lands in the owner's main chat.
 */
export async function askAgent(
  client: RpcClient,
  prompt: string,
  opts: { sessionKey?: string; timeoutMs?: number } = {},
): Promise<string> {
  const sessionKey = opts.sessionKey ?? "agent:main:hq-advisor";
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const idem = `hq-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const sent = (await client.request("chat.send", {
    sessionKey,
    message: prompt,
    deliver: false,
    idempotencyKey: idem,
  })) as { runId?: string; reply?: string; text?: string } | undefined;
  const inline = sent?.reply ?? sent?.text;
  if (inline) return inline;
  const runId = sent?.runId ?? idem;
  const waited = (await client.request("agent.wait", { runId, timeoutMs })) as { status?: string; error?: string } | undefined;
  if (waited?.status === "timeout") throw new Error("The agent didn't answer in time — try again.");
  if (waited?.status === "error") throw new Error(waited.error || "The agent run failed.");
  const hist = (await client.request("chat.history", { sessionKey, limit: 6 })) as { messages?: unknown[] } | undefined;
  const msgs = hist?.messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i] as { role?: string };
    if (m?.role === "assistant") {
      const text = extractText(m)?.trim();
      if (text) return text;
    }
  }
  throw new Error("The agent returned an empty answer.");
}
