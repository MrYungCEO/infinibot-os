/**
 * Extra rows for the Agent Mesh hover card (agency-world-viz): role/lineage,
 * last-activity age, attempt/round, verdict, latest review message,
 * files/commits and the kanban link. Pure — the viz renders the result.
 *
 * Inputs are the mesh agent, its neighbours (for parent/children), and the
 * review feed's thread summary / latest message / completion record for the
 * agent's run (all optional: older gateways simply leave rows blank).
 */

import type { MeshAgent } from "./activity-map";
import type { CompletionRecordLite } from "../../lib/review-mesh/completed";
import { VERDICT_TEXT, VERDICT_TONE, completedVerdictOf, isTerminalState } from "../../lib/review-mesh/completed";
import { KIND_LABEL, TONE_CSS, needsOwner, packetTone, verdictLabel, verdictTone } from "../../lib/review-mesh/model";
import type { ReviewMessage, ReviewThreadSummary } from "../../lib/review-mesh/types";

export interface HoverExtras {
  role: string;
  activityAge: string;
  attemptRound: string;
  verdict: string;
  verdictColor: string;
  latest: { kind: string; title: string; color: string } | null;
  files: string;
  commits: string;
  parent: string | null;
  children: number;
  kanbanTaskId: string | null;
  isSubagent: boolean;
  running: boolean;
}

export function ageLabel(ts: number | undefined, now: number): string {
  if (!ts || !Number.isFinite(ts)) return "";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

export function roleOf(agent: Pick<MeshAgent, "sessionKey" | "agentId" | "coderBackend" | "isBuild">): { role: string; isSubagent: boolean } {
  const key = agent.sessionKey || "";
  const isSubagent = key.includes(":subagent:") || Boolean(agent.isBuild);
  if (agent.coderBackend || agent.isBuild) return { role: "Coder sub-agent", isSubagent: true };
  if (isSubagent) return { role: "Sub-agent", isSubagent };
  if (key.endsWith(":main")) return { role: `${agent.agentId || "Agent"} · main session`, isSubagent: false };
  return { role: "Agent session", isSubagent: false };
}

export function buildHoverExtras(
  agent: MeshAgent,
  ctx: {
    now: number;
    agents?: Iterable<MeshAgent>;
    thread?: { summary: ReviewThreadSummary; messages: ReviewMessage[] } | null;
    record?: CompletionRecordLite | null;
  },
): HoverExtras {
  const { now } = ctx;
  const { role, isSubagent } = roleOf(agent);
  const all = ctx.agents ? [...ctx.agents] : [];
  const parentAgent = agent.parent ? all.find((a) => a.sessionKey === agent.parent) : undefined;
  const parent = agent.parent ? parentAgent?.label || agent.parent.split(":").slice(0, 2).join(":") : null;
  const children = all.filter((a) => a.parent === agent.sessionKey).length || agent.children?.length || 0;

  const t = ctx.thread ?? null;
  const rec = ctx.record ?? null;
  const last = t?.messages.length ? t.messages[t.messages.length - 1] : null;
  const attempts = Array.isArray(rec?.attempts) ? rec!.attempts!.length : 0;
  const rounds = t?.summary.rounds ?? 0;
  const attemptRound = attempts || rounds ? `${attempts ? `A${attempts}` : "A1"}${rounds ? ` · R${rounds}` : ""}` : "—";

  let verdict = "—";
  let verdictColor = TONE_CSS.slate;
  if (t?.summary.verdict) {
    verdict = verdictLabel(t.summary.verdict);
    verdictColor = TONE_CSS[verdictTone(t.summary.verdict)];
  } else if (rec && isTerminalState(rec.state)) {
    const v = completedVerdictOf(rec);
    verdict = VERDICT_TEXT[v];
    verdictColor = TONE_CSS[VERDICT_TONE[v]];
  } else if (t && needsOwner(t.summary)) {
    verdict = "Owner decision";
    verdictColor = TONE_CSS.magenta;
  } else if (t) {
    verdict = "In review";
    verdictColor = TONE_CSS.gold;
  }

  const filesN = Math.max(agent.filesTouchedCount ?? 0, rec?.result?.files_changed?.length ?? 0, rec?.review?.changedFiles?.length ?? 0);
  const commitsN = new Set([...(rec?.result?.commits ?? []), ...(rec?.review?.commits ?? [])]).size;
  const lastAt = agent.lastActivityAt ?? agent.lastActivity?.at ?? agent.lastUpdateAt;
  const status = String(agent.status || "").toLowerCase();

  return {
    role,
    activityAge: ageLabel(typeof lastAt === "number" ? lastAt : undefined, now),
    attemptRound,
    verdict,
    verdictColor,
    latest: last
      ? {
          kind: last.kind === "verdict" && last.verdict ? verdictLabel(last.verdict) : KIND_LABEL[last.kind] ?? last.kind,
          title: last.title,
          color: TONE_CSS[packetTone(last)],
        }
      : null,
    files: agent.filesTouchedCount != null || rec ? String(filesN) : "—",
    commits: rec ? String(commitsN) : "—",
    parent,
    children,
    kanbanTaskId: agent.kanbanTaskId ?? null,
    isSubagent,
    running: !["completed", "failed", "idle"].includes(status),
  };
}
