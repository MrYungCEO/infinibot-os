/**
 * Agent Mesh quick actions — shared by the 2D hover card (agency-world-viz)
 * and the 3D world's side panel (mesh-world-3d), so both views do exactly the
 * same thing for Details / Message / Stop / Task / plugin room.
 */
import type { MeshAgent } from "./activity-map";
import { inferBasePathFromPathname, pathForTab, type Tab } from "../../navigation";

type Requester = { request: (method: string, params?: unknown) => Promise<unknown> };

function requester(client: unknown): Requester["request"] | null {
  const c = client as Partial<Requester> | null | undefined;
  return c && typeof c.request === "function" ? c.request.bind(c) : null;
}

/** Open the global Agent Focus modal (app-render's window.openAgentFocus). */
export function openAgentDetails(agent: Partial<MeshAgent> & { sessionKey: string }): boolean {
  const open = (window as unknown as { openAgentFocus?: (t: unknown) => void }).openAgentFocus;
  if (typeof open !== "function") return false;
  open(agent);
  return true;
}

/** Message a run (subagents.message) or a session (chat.send). */
export async function sendAgentMessage(client: unknown, agent: MeshAgent, text: string): Promise<{ ok: boolean; error?: string }> {
  const req = requester(client);
  if (!req) return { ok: false, error: "Not connected" };
  const isSub = agent.sessionKey.includes(":subagent:") || Boolean(agent.runId);
  try {
    const res = (isSub && agent.runId
      ? await req("subagents.message", { runId: agent.runId, message: text })
      : await req("chat.send", { sessionKey: agent.sessionKey, message: text, idempotencyKey: `mesh-${Date.now().toString(36)}` })) as
      | { ok?: boolean; error?: string }
      | undefined;
    if (res && res.ok === false) return { ok: false, error: res.error || "Message not delivered" };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Stop a run (subagents.stop) or abort a session turn (agent.abort). */
export async function stopAgent(client: unknown, agent: MeshAgent): Promise<{ ok: boolean; error?: string }> {
  const req = requester(client);
  if (!req) return { ok: false, error: "Not connected" };
  try {
    if (agent.runId) await req("subagents.stop", { runId: agent.runId });
    else await req("agent.abort", { sessionKey: agent.sessionKey });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Navigate the app router to a tab (best effort in embeds / harnesses). */
export function navigateToTab(tab: string): void {
  try {
    const basePath = inferBasePathFromPathname(window.location.pathname);
    window.history.pushState({}, "", pathForTab(tab as Tab, basePath));
    window.dispatchEvent(new PopStateEvent("popstate"));
  } catch {
    /* navigation is best-effort */
  }
}

/** Open the kanban task linked to a run. */
export function openAgentTask(taskId: string): void {
  window.dispatchEvent(new CustomEvent("infinibot:kanban-open-task", { detail: { taskId } }));
  navigateToTab("projects");
}

/** True while the agent has in-flight work (Stop is meaningful) — same rule as agent-hover-extras. */
export function agentIsRunning(agent: Pick<MeshAgent, "status">): boolean {
  const s = String(agent.status || "idle").toLowerCase();
  return !["completed", "failed", "idle"].includes(s);
}
