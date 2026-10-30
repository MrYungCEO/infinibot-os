/**
 * Research workspace — gateway calls.
 *
 * Built only on RPCs the gateway already serves, so the page works on a
 * running gateway without a restart:
 *   agent.tools.invoke  → `research` (run records), `report` (PDF + markitdown
 *                         copy + /reports + project association), `memory_search`
 *   research.gather     → free web source aggregator (Wikipedia, arXiv, HN, …)
 *   chat.send / chat.history / chat.abort / sessions.patch → the research agent
 *   reports.list / reports.get / reports.preview / reports.link / reports.unlink
 *   objrel.link / objrel.unlink / objrel.connections
 *   documents.search / notes.list / notes.create / kanban.* / cron.add
 */

import type { GatewayBrowserClient } from "../../gateway";
import type { LinkPlan, LinkTarget } from "./links";
import { planLink, planUnlink } from "./links";
import type { ProjectLike, ReportLike, ResearchDocLike, ResearchSourceRef } from "./model";

/** Marks cron jobs created by the research workspace. */
export const RESEARCH_CRON_TAG = "[research]";

/** Session the UI's own tool calls run under (keeps them off the main chat). */
export const UI_TOOL_SESSION = "agent:main:research-ui";

type AnyRec = Record<string, unknown>;

const rec = (v: unknown): AnyRec => (v && typeof v === "object" && !Array.isArray(v) ? (v as AnyRec) : {});
const arr = <T = unknown>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
/** Epoch ms from a number, numeric string or date string (the research store's frontmatter yields strings). */
export const toMs = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
    const d = Date.parse(v);
    if (Number.isFinite(d)) return d;
  }
  return undefined;
};

/** Unwrap an agent.tools.invoke result into the tool's JSON payload. */
export function toolPayload(res: unknown): AnyRec {
  const r = rec(rec(res).result ?? res);
  const details = rec(r.details);
  if (Object.keys(details).length) return details;
  const text = arr<AnyRec>(r.content).find((c) => c.type === "text")?.text;
  if (typeof text === "string") {
    try {
      return rec(JSON.parse(text));
    } catch {
      return { text };
    }
  }
  return r;
}

export class ResearchApi {
  constructor(private readonly client: GatewayBrowserClient) {}

  private req<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    return this.client.request<T>(method, params ?? {}, timeoutMs ? { timeoutMs } : undefined);
  }

  async tool(tool: string, args: AnyRec, timeoutMs = 60_000): Promise<AnyRec> {
    const res = await this.req("agent.tools.invoke", { tool, args, sessionKey: UI_TOOL_SESSION, source: "ui" }, timeoutMs);
    const out = toolPayload(res);
    if (out.status === "error" || out.ok === false) {
      throw new Error(String(out.error ?? out.message ?? `${tool} failed`));
    }
    return out;
  }

  // ── research run records (research-docs store) ──────────────────
  async listResearchDocs(): Promise<ResearchDocLike[]> {
    const out = await this.tool("research", { action: "list", limit: 1000 });
    return arr<AnyRec>(out.research).map((r) => ({
      id: String(r.id),
      name: String(r.name ?? r.id),
      description: str(r.description),
      tags: arr<string>(r.tags),
      category: str(r.category),
      status: str(r.researchStatus) ?? str(r.status),
      topic: str(r.topic),
      preview: str(r.preview),
      createdAt: toMs(r.createdAt),
      updatedAt: toMs(r.updatedAt),
    }));
  }

  async getResearchDoc(id: string): Promise<(ResearchDocLike & { body: string; sources?: string[] }) | null> {
    try {
      const out = await this.tool("research", { action: "get", id });
      const r = rec(out.research);
      if (!r.id) return null;
      return {
        id: String(r.id),
        name: String(r.name ?? r.id),
        description: str(r.description),
        tags: arr<string>(r.tags),
        category: str(r.category),
        status: str(r.status),
        topic: str(r.topic),
        body: typeof r.body === "string" ? r.body : "",
        sources: arr<string>(r.sources),
        createdAt: toMs(r.createdAt),
        updatedAt: toMs(r.updatedAt),
      };
    } catch {
      return null;
    }
  }

  async saveResearchDoc(
    mode: "create" | "update",
    doc: { id: string; name?: string; body?: string; description?: string; tags?: string[]; category?: string; status?: string; topic?: string; sources?: string[] },
  ): Promise<void> {
    await this.tool("research", {
      action: mode,
      id: doc.id,
      ...(doc.name ? { name: doc.name } : {}),
      ...(doc.body != null ? { body: doc.body } : {}),
      ...(doc.description ? { description: doc.description } : {}),
      ...(doc.tags ? { tags: doc.tags.join(",") } : {}),
      ...(doc.category ? { category: doc.category } : {}),
      ...(doc.status ? { status: doc.status } : {}),
      ...(doc.topic ? { topic: doc.topic } : {}),
      // sources are comma-split by the tool → URLs only, no commas
      ...(doc.sources?.length ? { sources: doc.sources.map((s) => s.replace(/,/g, "%2C")).join(",") } : {}),
    });
  }

  async deleteResearchDoc(id: string): Promise<void> {
    await this.tool("research", { action: "delete", id });
  }

  // ── reports ─────────────────────────────────────────────────────
  async listResearchReports(): Promise<ReportLike[]> {
    const calls = await Promise.allSettled([
      this.req<AnyRec>("reports.list", { category: "research", limit: 300 }),
      this.req<AnyRec>("reports.list", { kind: "research_brief", limit: 300 }),
      this.req<AnyRec>("reports.list", { kind: "competitive_analysis", limit: 100 }),
      this.req<AnyRec>("reports.list", { limit: 500 }),
    ]);
    const byId = new Map<string, ReportLike>();
    for (const c of calls) {
      if (c.status !== "fulfilled") continue;
      for (const r of arr<ReportLike>(rec(c.value).reports)) if (r?.id) byId.set(r.id, r);
    }
    if (calls.every((c) => c.status === "rejected")) {
      throw (calls[0] as PromiseRejectedResult).reason;
    }
    return [...byId.values()];
  }

  async getReport(id: string): Promise<AnyRec | null> {
    try {
      return rec(rec(await this.req("reports.get", { id })).report);
    } catch {
      return null;
    }
  }

  async reportPdfUrl(id: string): Promise<string> {
    const res = rec(await this.req("reports.preview", { id, base64: true }, 60_000));
    const b64 = str(res.base64);
    if (!b64) throw new Error("This report has no rendered PDF yet.");
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  }

  /** Render the canonical black-gold PDF + markitdown copy; returns the report id. */
  async fileReport(input: { title: string; markdown: string; subtitle?: string; projectId?: string }): Promise<string> {
    const out = await this.tool(
      "report",
      {
        action: "render",
        title: input.title,
        markdown: input.markdown,
        subtitle: input.subtitle,
        eyebrow: "InfiniBot · Research",
        footer: "Research workspace",
        category: "research",
        kind: "research_brief",
        ...(input.projectId ? { projectId: input.projectId } : {}),
      },
      180_000,
    );
    const id = str(out.id);
    if (!id) throw new Error("Report rendered but was not registered (no id returned).");
    return id;
  }

  // ── links ───────────────────────────────────────────────────────
  private async runPlan(plan: LinkPlan): Promise<unknown> {
    return this.req(plan.method, plan.params);
  }
  link(reportId: string, target: LinkTarget): Promise<unknown> {
    return this.runPlan(planLink(reportId, target));
  }
  unlink(reportId: string, target: Pick<LinkTarget, "type" | "id">): Promise<unknown> {
    return this.runPlan(planUnlink(reportId, target));
  }
  async connections(type: string, id: string): Promise<unknown> {
    return this.req("objrel.connections", { type, id, inferOrigins: false });
  }

  // ── knowledge sources ───────────────────────────────────────────
  async projects(): Promise<ProjectLike[]> {
    const res = await this.req<unknown>("kanban.projects.list", {});
    const list = Array.isArray(res) ? res : arr(rec(res).projects ?? rec(res).items);
    return list
      .map((p) => rec(p))
      .filter((p) => p.id)
      .map((p) => ({
        id: String(p.id),
        name: String(p.name ?? p.title ?? p.id),
        description: str(p.description),
        status: str(p.status) ?? str(p.notionStatus),
        archived: p.archived === true,
        updatedAt: toMs(p.updatedAt),
      }));
  }

  async tasksFor(projectId: string): Promise<Array<{ id: string; title: string; status?: string; description?: string }>> {
    const res = await this.req<unknown>("kanban.tasks.list", { projectId });
    const list = Array.isArray(res) ? res : arr(rec(res).tasks);
    return list
      .map((t) => rec(t))
      .filter((t) => t.id && (!t.projectId || t.projectId === projectId))
      .map((t) => ({ id: String(t.id), title: String(t.title ?? t.id), status: str(t.status), description: str(t.description) }));
  }

  async searchDocuments(query: string, limit = 12): Promise<Array<{ id: string; title: string; snippet?: string; path?: string; isNoteMirror: boolean }>> {
    if (!query.trim()) return [];
    const res = rec(await this.req("documents.search", { query, limit }));
    return arr<AnyRec>(res.hits)
      .filter((h) => h.kind !== "folder")
      .map((h) => ({
        id: String(h.id),
        title: String(h.title ?? h.id),
        snippet: str(h.snippet),
        path: str(h.path),
        // Notes mirrored into Documents keep the note's row id and live under the Notes folder.
        isNoteMirror: /^notes-/.test(String(h.parentId ?? "")) || String(h.path ?? "").startsWith("Notes /"),
      }));
  }

  async searchNotes(query: string, limit = 12): Promise<Array<{ id: string; title: string; snippet?: string; body?: string }>> {
    const res = rec(await this.req("notes.list", query.trim() ? { query } : {}));
    return arr<AnyRec>(res.notes ?? res.items)
      .slice(0, limit)
      .map((n) => ({
        id: String(n.id),
        title: String(n.name ?? n.title ?? n.id),
        snippet: str(n.description) ?? str(n.preview),
        body: typeof n.body === "string" ? n.body.slice(0, 1500) : undefined,
      }));
  }

  /** memory_search — returns [] (with a reason) when the memory index is off. */
  async memory(query: string): Promise<{ hits: ResearchSourceRef[]; disabled?: string }> {
    try {
      const out = await this.tool("memory_search", { query, maxResults: 6 }, 30_000);
      if (out.disabled) return { hits: [], disabled: String(out.error ?? "memory index unavailable").split("\n")[0] };
      return {
        hits: arr<AnyRec>(out.results).map((r) => ({
          title: String(r.path ?? r.title ?? r.id ?? "memory"),
          kind: "internal",
          snippet: str(r.snippet) ?? str(r.text),
          ref: { type: "memory", id: String(r.id ?? r.path ?? "") },
        })),
      };
    } catch (e) {
      return { hits: [], disabled: String(e instanceof Error ? e.message : e) };
    }
  }

  async gatherWeb(query: string, perSource: number): Promise<{ sources: ResearchSourceRef[]; warnings: string[] }> {
    const res = rec(await this.req("research.gather", { query, perSource, timeoutMs: 20_000, useBrowserRelay: false }, 45_000));
    const bundle = rec(res.bundle);
    return {
      sources: arr<AnyRec>(bundle.sources).map((s) => ({
        title: String(s.title ?? s.url ?? "source"),
        url: str(s.url),
        kind: String(s.kind ?? "web"),
        snippet: str(s.snippet),
      })),
      warnings: arr<string>(bundle.warnings),
    };
  }

  // ── the research agent (chat session) ───────────────────────────
  async prepareSession(sessionKey: string, label: string): Promise<void> {
    // Full tool events (search queries, pages read) for the live progress view.
    await this.req("sessions.patch", { key: sessionKey, verboseLevel: "on", label }).catch(() => undefined);
  }

  async send(sessionKey: string, message: string, idempotencyKey: string): Promise<void> {
    await this.req("chat.send", { sessionKey, message, deliver: false, idempotencyKey }, 30_000);
  }

  async abort(sessionKey: string): Promise<void> {
    await this.req("chat.abort", { sessionKey }).catch(() => undefined);
  }

  /** The run's final answer, or null while the agent is still working (or never replied). */
  async lastAssistantText(sessionKey: string): Promise<string | null> {
    const res = rec(await this.req("chat.history", { sessionKey, limit: 50 }));
    return finalAssistantText(arr<AnyRec>(res.messages));
  }

  // ── turning findings into work ──────────────────────────────────
  async createNote(input: { title: string; body: string; projectId?: string; tags?: string[] }): Promise<string | undefined> {
    const res = rec(
      await this.req("notes.create", {
        name: input.title,
        body: input.body,
        tags: input.tags ?? ["research"],
        category: "research",
        ...(input.projectId ? { projectId: input.projectId } : {}),
      }),
    );
    return str(res.id) ?? str(rec(res.note).id);
  }

  async createTask(input: { title: string; description: string; projectId?: string }): Promise<string | undefined> {
    const res = rec(
      await this.req("kanban.tasks.create", {
        title: input.title,
        description: input.description,
        status: "todo",
        priority: "medium",
        ...(input.projectId ? { projectId: input.projectId } : {}),
      }),
    );
    return str(res.id) ?? str(rec(res.task).id);
  }

  async postProjectUpdate(projectId: string, title: string, content: string): Promise<void> {
    await this.req("kanban.projects.content.createNote", { projectId, title, content, pinned: false });
  }

  async scheduleRecurring(input: { name: string; expr: string; message: string }): Promise<string | undefined> {
    const res = rec(
      await this.req("cron.add", {
        name: input.name,
        agentId: "main",
        enabled: true,
        // cron.add is schema-strict (no free-form category) — the description
        // prefix is how the workspace finds its own jobs again.
        description: `${RESEARCH_CRON_TAG} ${input.message.slice(0, 160)}`,
        schedule: { kind: "cron", expr: input.expr },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: input.message, timeoutSeconds: 1800 },
      }),
    );
    return str(res.id);
  }

  async listResearchSchedules(): Promise<Array<{ id: string; name: string; expr?: string; nextRunAtMs?: number; enabled: boolean }>> {
    const res = rec(await this.req("cron.list", { includeDisabled: true }));
    return arr<AnyRec>(res.jobs)
      .filter((j) => String(j.description ?? "").startsWith(RESEARCH_CRON_TAG))
      .map((j) => ({
        id: String(j.id),
        name: String(j.name ?? j.id),
        expr: str(rec(j.schedule).expr),
        nextRunAtMs: typeof rec(j.state).nextRunAtMs === "number" ? (rec(j.state).nextRunAtMs as number) : undefined,
        enabled: j.enabled !== false,
      }));
  }

  async removeSchedule(id: string): Promise<void> {
    await this.req("cron.remove", { id });
  }
}

/**
 * Final reply of a finished turn: the NEWEST message must be an assistant
 * message that ended normally (no tool calls). Anything else — a tool result,
 * an assistant turn that is calling tools, the user's prompt — means the agent
 * is still working, so no partial "I'll search…" text is mistaken for the answer.
 */
export function finalAssistantText(messages: ReadonlyArray<Record<string, unknown>>): string | null {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") return null;
  const blocks = Array.isArray(last.content) ? (last.content as AnyRec[]) : [];
  if (last.stopReason === "toolUse" || blocks.some((b) => b.type === "toolCall" || b.type === "tool_use")) return null;
  const text = messageText(last);
  return text.trim() ? text : null;
}

/** Text of a chat message (string content or content blocks). */
export function messageText(message: unknown): string {
  const m = rec(message);
  if (typeof m.content === "string") return m.content;
  if (typeof m.text === "string") return m.text;
  return arr<AnyRec>(m.content)
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}
