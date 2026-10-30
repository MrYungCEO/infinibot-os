/**
 * AI current-state summary generation for kanban projects.
 *
 * Synthesizes a concise "where does this project actually stand right now"
 * briefing from the project-management data we already have — status, task
 * board breakdown, progress, cash-flow, and the operator-authored project
 * body/spec — using the user's configured LLM (via the shared `runLLM`
 * helper). The PM-agent persona lives in the system prompt.
 *
 * Two entry points feed the same reconciliation path:
 *  - `generateProjectSummary` — regenerate from scratch (Refresh button / cron).
 *  - `reviseProjectSummary` — fold an operator dump (typed OR transcribed from a
 *    quick voice call) into the current state, closing the gap between reality
 *    and what's logged.
 */
import { createHash } from "node:crypto";
import { runLLM } from "../services/email/llm-analysis.js";
import { getProject, listProjects, listTasks } from "../databases/kanban-store-ops.js";
import { getKanbanStore } from "../tasks/store.js";
import { type Block, blocksToMarkdown } from "../content/blocks-markdown.js";
import { readAttachmentMarkdown } from "../files/attachment-markdown.js";
import { listAllSubagentRuns } from "../agents/subagent-registry.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  getProjectSummary,
  saveProjectSummary,
  type ProjectSummaryRecord,
  type ProjectSummaryRevision,
} from "./store.js";

const log = createSubsystemLogger("project-summary");

const PM_SYSTEM_PROMPT = `You are the Project Manager for an autonomous agency. You write the "Current State" briefing that sits at the top of a project's page — the single source of truth an operator glances at to know exactly where the project stands right now.

Write in clean markdown. Be concrete and honest — surface risk and drift, do not cheerlead. Structure the summary as:

**Current state** — 2-4 sentence plain-language read on where the project actually is.
**Progress** — a short bulleted list of what's done / in-flight / blocked, grounded in the task board.
**Risks & gaps** — anything stalled, overdue, unstaffed, or contradicting the stated scope. Omit the section if genuinely none.
**Next actions** — 2-4 concrete next steps.

Keep it tight (under ~250 words). Do not invent facts not present in the data. If the data is thin, say so plainly rather than padding.`;

function isInProgressStatus(status: string | undefined): boolean {
  const s = (status ?? "").toLowerCase().replace(/[\s_-]+/g, "");
  return s === "inprogress" || s === "active" || s === "doing";
}

/** Read the operator-authored project body markdown, best-effort. */
function readProjectBodyMarkdown(projectId: string): string {
  try {
    const stored = getKanbanStore().getProjectContentBlocks(projectId);
    const blocks = Array.isArray(stored.blocks) ? (stored.blocks as Block[]) : [];
    return blocksToMarkdown(blocks).trim();
  } catch {
    return "";
  }
}

// ── Enrichment caps (keep the PM prompt bounded) ──────────────────────────
const OPEN_TASK_CAP = 40;
const TASK_DESC_CHARS = 280;
const NOTE_CAP = 20;
const NOTE_CHARS = 500;
const ATTACHMENT_MD_TOTAL_CAP = 12_000;
const ATTACHMENT_LIST_CAP = 40;
const AGENT_RUN_CAP = 8;

function trimText(s: string, n: number): string {
  const t = (s ?? "").trim().replace(/\s+/g, " ");
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/**
 * A stable, CHEAP signature of everything the summary is derived from — task
 * count/statuses, project-body hash, notes hash, the attachment sha list, and
 * cash-flow. Deliberately excludes attachment markdown CONTENT (reading/
 * converting every file is expensive) so the staleness check stays cheap. Used
 * by the store as `inputHash`; the RPC recomputes it to detect drift without
 * calling the LLM.
 */
export function computeProjectInputHash(projectId: string): string | null {
  const project = getProject(projectId);
  if (!project) return null;
  const store = getKanbanStore();

  const tasks = listTasks({ projectId });
  const taskSig = tasks
    .map((t) => `${t.id}:${String(t.status ?? "").toLowerCase()}:${t.updatedAt ?? 0}`)
    .sort()
    .join("|");

  const body = readProjectBodyMarkdown(projectId);

  let notes: { updatedAt?: number; id?: string }[] = [];
  let attachments: { sha256?: string; id?: string; markdownPath?: string }[] = [];
  try {
    notes = store.getProjectNotes(projectId);
  } catch {
    /* best-effort */
  }
  try {
    attachments = store.getProjectAttachments(projectId);
  } catch {
    /* best-effort */
  }
  const noteSig = notes.map((n) => `${n.id}:${n.updatedAt ?? 0}`).sort().join("|");
  const attSig = attachments
    .map((a) => `${a.sha256 || a.id}:${a.markdownPath ? 1 : 0}`)
    .sort()
    .join("|");

  const cashSig = `${project.pendingPay ?? 0}:${project.pendingPayDate ?? ""}:${project.paidAmount ?? 0}:${project.paidAmountDate ?? ""}`;

  const payload = JSON.stringify({
    status: project.status ?? "",
    priority: project.priority ?? "",
    taskCount: tasks.length,
    taskSig,
    bodyHash: createHash("sha256").update(body).digest("hex"),
    noteSig,
    attSig,
    cashSig,
  });
  return createHash("sha256").update(payload).digest("hex");
}

/** Recent agent-run outcomes tied to this project (best-effort; live registry). */
function gatherAgentRunOutcomes(projectId: string, taskIds: Set<string>): string {
  let runs: ReturnType<typeof listAllSubagentRuns> = [];
  try {
    runs = listAllSubagentRuns();
  } catch {
    return "";
  }
  const relevant = runs
    .filter(
      (r) =>
        (r as any).projectId === projectId ||
        (r.kanbanTaskId != null && taskIds.has(r.kanbanTaskId)),
    )
    .sort((a, b) => (b.endedAt ?? b.startedAt ?? b.createdAt ?? 0) - (a.endedAt ?? a.startedAt ?? a.createdAt ?? 0))
    .slice(0, AGENT_RUN_CAP);
  if (relevant.length === 0) return "";
  return relevant
    .map((r) => {
      const status = r.outcome?.status ?? (r.endedAt ? "ended" : r.startedAt ? "running" : "queued");
      const when = r.endedAt ? new Date(r.endedAt).toISOString().slice(0, 10) : "";
      const err = r.outcome?.error ? ` — ${trimText(r.outcome.error, 120)}` : "";
      return `- [${status}]${when ? ` ${when}` : ""} ${trimText(r.label || r.task, 140)}${err}`;
    })
    .join("\n");
}

/**
 * Assemble the project-management context block handed to the model, drawing
 * from ALL available project data: meta, the task board WITH descriptions,
 * project notes, uploaded attachments AND their extracted markdown, recent
 * agent-run outcomes, the operator-authored body/spec, and cash-flow.
 */
export async function gatherProjectContext(
  projectId: string,
): Promise<{ header: string; body: string } | null> {
  const project = getProject(projectId);
  if (!project) return null;
  const store = getKanbanStore();

  const tasks = listTasks({ projectId });
  const taskIds = new Set(tasks.map((t) => t.id));
  const byStatus = new Map<string, number>();
  for (const t of tasks) {
    const key = String(t.status ?? "unknown").toLowerCase();
    byStatus.set(key, (byStatus.get(key) ?? 0) + 1);
  }
  const statusLine = [...byStatus.entries()].map(([k, n]) => `${k}: ${n}`).join(", ") || "no tasks";

  const openTasks = tasks
    .filter((t) => String(t.status).toLowerCase() !== "done")
    .slice(0, OPEN_TASK_CAP)
    .map((t) => {
      const head = `- [${t.status}] ${t.title}${t.assignee ? ` (@${t.assignee})` : ""}${t.dueDate ? ` — due ${t.dueDate}` : ""}`;
      const desc = trimText(t.description ?? "", TASK_DESC_CHARS);
      return desc ? `${head}\n  ${desc}` : head;
    })
    .join("\n");
  const recentDone = tasks
    .filter((t) => String(t.status).toLowerCase() === "done")
    .sort((a, b) => (b.completedAt ?? b.updatedAt ?? 0) - (a.completedAt ?? a.updatedAt ?? 0))
    .slice(0, 12)
    .map((t) => `- ${t.title}`)
    .join("\n");

  const body = readProjectBodyMarkdown(projectId);

  // ── Project notes ──────────────────────────────────────────────────────
  let notesBlock = "";
  try {
    const notes = store.getProjectNotes(projectId).slice(0, NOTE_CAP);
    if (notes.length) {
      notesBlock = notes
        .map((n) => {
          const title = n.title?.trim() ? `**${n.title.trim()}**` : "";
          const content = trimText(n.content ?? "", NOTE_CHARS);
          const pin = n.pinned ? "📌 " : "";
          return `- ${pin}${title}${title && content ? ": " : ""}${content}`.trim();
        })
        .filter(Boolean)
        .join("\n");
    }
  } catch (err) {
    log.warn(`could not read notes for ${projectId}: ${String(err)}`);
  }

  // ── Attachments + extracted markdown (shared read/convert path) ─────────
  let attachmentListBlock = "";
  let attachmentMdBlock = "";
  try {
    const attachments = store.getProjectAttachments(projectId).slice(0, ATTACHMENT_LIST_CAP);
    if (attachments.length) {
      attachmentListBlock = attachments
        .map((a) => `- ${a.name}${a.mimeType ? ` (${a.mimeType})` : ""}`)
        .join("\n");
      let budget = ATTACHMENT_MD_TOTAL_CAP;
      const chunks: string[] = [];
      for (const a of attachments) {
        if (budget <= 200) break;
        try {
          const md = await readAttachmentMarkdown(a, { cap: budget });
          const text = md.markdown.trim();
          if (text) {
            const slice = text.slice(0, budget);
            budget -= slice.length;
            chunks.push(`### ${a.name}\n${slice}`);
          }
        } catch {
          /* best-effort per file */
        }
      }
      attachmentMdBlock = chunks.join("\n\n");
    }
  } catch (err) {
    log.warn(`could not read attachments for ${projectId}: ${String(err)}`);
  }

  // ── Recent agent-run outcomes ──────────────────────────────────────────
  const agentRuns = gatherAgentRunOutcomes(projectId, taskIds);

  const cashFlow: string[] = [];
  if (typeof project.pendingPay === "number" && project.pendingPay > 0) {
    cashFlow.push(`pending: $${project.pendingPay}${project.pendingPayDate ? ` (${project.pendingPayDate})` : ""}`);
  }
  if (typeof project.paidAmount === "number" && project.paidAmount > 0) {
    cashFlow.push(`paid: $${project.paidAmount}${project.paidAmountDate ? ` (${project.paidAmountDate})` : ""}`);
  }

  const header = `${project.name} (status: ${project.status ?? "unknown"})`;
  const parts: string[] = [
    `# Project: ${project.name}`,
    `Status: ${project.status ?? "unknown"}${project.priority ? ` · Priority: ${project.priority}` : ""}`,
    project.description ? `Description: ${project.description}` : "",
    cashFlow.length ? `Cash-flow: ${cashFlow.join("; ")}` : "",
    ``,
    `## Task board (${tasks.length} total — ${statusLine})`,
    openTasks ? `### Open / in-flight\n${openTasks}` : "No open tasks.",
    recentDone ? `### Recently completed\n${recentDone}` : "",
    ``,
    notesBlock ? `## Project notes\n${notesBlock}` : "",
    agentRuns ? `## Recent agent-run outcomes\n${agentRuns}` : "",
    attachmentListBlock ? `## Attachments\n${attachmentListBlock}` : "",
    attachmentMdBlock ? `## Attachment contents (extracted)\n${attachmentMdBlock}` : "",
    ``,
    body ? `## Operator-authored project body / spec\n${body.slice(0, 8000)}` : "## Project body\n(empty)",
  ];
  return { header, body: parts.filter(Boolean).join("\n") };
}

async function synthesize(
  context: { header: string; body: string },
  extraDirective?: string,
): Promise<{ text: string; model: string }> {
  const userPrompt = extraDirective
    ? `${extraDirective}\n\n---\nPROJECT DATA:\n${context.body}`
    : context.body;
  const result = await runLLM({
    systemPrompt: PM_SYSTEM_PROMPT,
    userPrompt,
    maxTokens: 900,
    temperature: 0.3,
  });
  return { text: result.text.trim(), model: `${result.provider}:${result.model}` };
}

/**
 * (Re)generate a project's current-state summary from its live PM data and
 * persist it. Returns the saved record. `source` distinguishes cron vs manual.
 */
export async function generateProjectSummary(
  projectId: string,
  source: "cron" | "manual" = "manual",
): Promise<ProjectSummaryRecord> {
  const context = await gatherProjectContext(projectId);
  if (!context) throw new Error(`project not found: ${projectId}`);
  const { text, model } = await synthesize(context);
  const prev = await getProjectSummary(projectId);
  return saveProjectSummary({
    projectId,
    markdown: text,
    generatedAt: Date.now(),
    model,
    source,
    inputHash: computeProjectInputHash(projectId) ?? undefined,
    revisions: prev?.revisions ?? [],
  });
}

/**
 * Fold an operator "dump" (typed or transcribed from a quick voice call) into
 * the project's current state. The PM agent reconciles the real-world change
 * against the existing summary + logged data and rewrites the current-state
 * briefing. Appends the raw dump to the revision log for traceability.
 */
export async function reviseProjectSummary(
  projectId: string,
  input: string,
  source: "text" | "voice" = "text",
): Promise<ProjectSummaryRecord> {
  const context = await gatherProjectContext(projectId);
  if (!context) throw new Error(`project not found: ${projectId}`);
  const prev = await getProjectSummary(projectId);
  const directive = `The operator just reported a real-world update to this project that may not yet be reflected in the logged data below. Reconcile it: fold the update into the current-state briefing, correcting or extending scope, status and next-actions as needed. If the update contradicts the logged data, trust the operator's report and note the discrepancy.

OPERATOR UPDATE (${source}):
"""
${input.trim()}
"""

${prev?.markdown ? `EXISTING CURRENT-STATE SUMMARY (rewrite this):\n"""\n${prev.markdown}\n"""` : ""}`;
  const { text, model } = await synthesize(context, directive);
  const revision: ProjectSummaryRevision = { at: Date.now(), source, input: input.trim().slice(0, 4000) };
  return saveProjectSummary({
    projectId,
    markdown: text,
    generatedAt: Date.now(),
    model,
    source: "revision",
    inputHash: computeProjectInputHash(projectId) ?? undefined,
    revisions: [...(prev?.revisions ?? []), revision],
  });
}

/**
 * Daily cron entry point: regenerate summaries for every in-progress project.
 * Best-effort and serial — a single project's failure never aborts the sweep.
 * Returns the count of projects successfully refreshed.
 */
export async function regenerateInProgressSummaries(): Promise<{ refreshed: number; total: number }> {
  let projects: { id: string; status: string }[] = [];
  try {
    projects = listProjects().filter((p) => isInProgressStatus(p.status) && !p.archived);
  } catch (err) {
    log.warn(`could not list projects for daily summary sweep: ${String(err)}`);
    return { refreshed: 0, total: 0 };
  }
  let refreshed = 0;
  for (const p of projects) {
    try {
      await generateProjectSummary(p.id, "cron");
      refreshed++;
    } catch (err) {
      log.warn(`daily summary failed for project ${p.id}: ${String(err)}`);
    }
  }
  if (projects.length > 0) {
    log.info(`daily project-summary sweep: refreshed ${refreshed}/${projects.length} in-progress projects`);
  }
  return { refreshed, total: projects.length };
}
