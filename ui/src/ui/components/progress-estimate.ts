import type { AgentSession } from "../controllers/agent-activity";

export function estimateProgress(session: AgentSession): { phase: string; pct: number } | null {
  if (session.completedViaEvent) {
    if (session.completionState === "error") return { phase: "ERROR", pct: 100 };
    return { phase: "COMPLETE", pct: 100 };
  }

  if (!session.active && session.steps.length > 0) {
    if (session.kind === "subagent") {
      const staleMins = session.updatedAt ? (Date.now() - session.updatedAt) / 60000 : 999;
      if (staleMins < 15) {
        return { phase: "WORKING", pct: Math.min(20 + session.steps.length * 3, 90) };
      }
    }
    return { phase: "COMPLETE", pct: 100 };
  }

  if (!session.active) return null;

  const tools = session.steps.filter((s) => s.type === "tool_call").length;
  const last = session.steps[session.steps.length - 1];
  if (session.steps.length === 0) return { phase: "STARTING", pct: 5 };
  if (last?.type === "thinking") return { phase: "THINKING", pct: Math.min(30 + tools * 5, 80) };
  if (last?.type === "tool_call") return { phase: last.content?.toUpperCase() || "WORKING", pct: Math.min(20 + tools * 8, 90) };
  if (last?.type === "tool_result") return { phase: "PROCESSING", pct: Math.min(25 + tools * 8, 90) };
  return { phase: "WORKING", pct: Math.min(10 + session.steps.length * 3, 85) };
}
