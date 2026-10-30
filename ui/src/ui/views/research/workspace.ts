/**
 * <infinibot-research-workspace> — the Research page.
 *
 *   Start research  → prompt + depth + scope + sources → research.gather and an
 *                     internal search, then the main agent on its own session
 *                     with live stages, tool steps and a streaming summary.
 *   Library         → every research run, research report and research doc,
 *                     with search / filters / sort and a detail view.
 *   Linking         → research is anchored on its canonical report; links to
 *                     projects, tasks, notes, documents and other research are
 *                     objrel edges, so they show on the project page and in the
 *                     knowledge graph. Manual picker + suggested links.
 *   Ask             → Q&A over internal knowledge with numbered citations and a
 *                     one-click web follow-up.
 *   Proactive       → suggested topics from active projects, stale research,
 *                     new since last visit, recurring research via cron.
 *
 * Light DOM (no shadow root) so the global glass tokens + work-glass kit apply.
 */

import { LitElement, html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../gateway";
import { icons } from "../../icons";
import { toSanitizedMarkdownHtml } from "../../markdown";
import "../work-glass/base.css";
import "./research.css";
import "../../components/people-chips";
import { ResearchApi, messageText } from "./api";
import {
  flattenConnections,
  neighborKeysFrom,
  suggestLinks,
  targetKey,
  type Candidate,
  type LinkTarget,
  type LinkTargetType,
  type ResearchLink,
  type Suggestion,
} from "./links";
import {
  DEPTHS,
  RUN_CATEGORY,
  RUN_STALL_MS,
  SOURCE_MODES,
  buildAskPrompt,
  buildResearchPrompt,
  embedRunMeta,
  encodeRunTags,
  filterLibrary,
  isStale,
  mergeLibrary,
  newRunId,
  newSince,
  parseResearchMarkdown,
  parseRunMeta,
  plainText,
  rankSources,
  relativeTime,
  sessionKeyForRun,
  singleLine,
  suggestTopics,
  taskTitleFrom,
  titleFromQuestion,
  hostOf,
  keywordQueries,
  memoryNote,
  type LibraryFilter,
  type ParsedResearch,
  type ProjectLike,
  type ReportLike,
  type ResearchDepth,
  type ResearchItem,
  type ResearchSourceMode,
  type ResearchSourceRef,
  type RunMeta,
} from "./model";

type AppLike = {
  basePath?: string;
  setTab?: (tab: never) => void;
  kanbanSelectedProjectId?: string | null;
  kanbanGalleryView?: boolean;
  requestUpdate?: () => void;
};

type Stage = "gather" | "internal" | "agent" | "writing" | "saving" | "done" | "failed";
const STAGES: Array<{ id: Exclude<Stage, "done" | "failed">; label: string }> = [
  { id: "gather", label: "Gathering web sources" },
  { id: "internal", label: "Searching internal knowledge" },
  { id: "agent", label: "Agent researching" },
  { id: "writing", label: "Writing summary" },
  { id: "saving", label: "Saving to Reports + linking" },
];

interface Step {
  id: string;
  name: string;
  detail: string;
  status: "run" | "ok" | "err";
}

interface RunProgress {
  docId: string;
  sessionKey: string;
  title: string;
  question: string;
  depth: ResearchDepth;
  sourceMode: ResearchSourceMode;
  projectId?: string;
  projectLabel?: string;
  topic?: string;
  startedAt: number;
  stage: Stage;
  webSources: ResearchSourceRef[];
  internalSources: ResearchSourceRef[];
  steps: Step[];
  stream: string;
  warnings: string[];
  error?: string;
  reportId?: string;
  followUpOf?: string;
  finalizing?: boolean;
}

interface DetailState {
  key: string;
  loading: boolean;
  error?: string;
  markdown: string;
  parsed: ParsedResearch | null;
  meta: RunMeta | null;
  report: Record<string, unknown> | null;
  markitdown?: string;
  links: ResearchLink[];
  linksLoading: boolean;
  suggestions: Suggestion[];
  suggesting: boolean;
  pdfUrl?: string;
  pdfLoading?: boolean;
  showMarkitdown?: boolean;
  busy: Record<string, boolean>;
  pickerOpen?: boolean;
  pickerQuery: string;
  pickerResults: Candidate[];
  pickerLoading?: boolean;
}

interface AskState {
  question: string;
  status: "idle" | "searching" | "answering" | "done" | "error";
  sources: ResearchSourceRef[];
  answer: string;
  error?: string;
  sessionKey?: string;
  memoryNote?: string;
}

const LAST_VISIT_KEY = "ib.research.lastVisit";
const ASK_SESSION_PREFIX = "agent:main:research-ask-";
const PER_SOURCE: Record<ResearchDepth, number> = { quick: 3, standard: 5, deep: 8 };
const TYPE_LABEL: Record<LinkTargetType, string> = {
  project: "Project",
  task: "Task",
  note: "Note",
  doc: "Document",
  report: "Research / report",
};
const TYPE_ICON: Record<LinkTargetType, TemplateResult> = {
  project: icons.folder,
  task: icons.checkCircle,
  note: icons.penLine,
  doc: icons.fileText,
  report: icons.book,
};
const SCHEDULES: Array<{ id: string; label: string; expr: string }> = [
  { id: "off", label: "Once", expr: "" },
  { id: "daily", label: "Daily", expr: "0 8 * * *" },
  { id: "weekly", label: "Weekly", expr: "0 8 * * 1" },
];

function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/^Error:\s*/, "");
}

function toolDetail(name: string, args: unknown): string {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const pick = a.query ?? a.url ?? a.q ?? a.id ?? a.action ?? "";
  return singleLine(String(pick), 90);
}

function urlsIn(value: unknown, max = 8): string[] {
  const s = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const out = new Set<string>();
  for (const m of s.matchAll(/https?:\/\/[^\s"'<>\\)\]]+/g)) {
    out.add(m[0].replace(/[.,;]+$/, ""));
    if (out.size >= max) break;
  }
  return [...out];
}

@customElement("infinibot-research-workspace")
export class ResearchWorkspace extends LitElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property({ attribute: false }) app: AppLike | null = null;
  @property({ type: Boolean }) connected = false;

  @state() private loading = true;
  @state() private loadError: string | null = null;
  @state() private items: ResearchItem[] = [];
  @state() private projects: ProjectLike[] = [];
  @state() private reports: ReportLike[] = [];
  @state() private filter: LibraryFilter = { status: "all", kind: "all", projectId: "all", sort: "recent" };
  @state() private runs: RunProgress[] = [];
  @state() private detail: DetailState | null = null;
  @state() private ask: AskState = { question: "", status: "idle", sources: [], answer: "" };
  @state() private compose = {
    question: "",
    depth: "quick" as ResearchDepth,
    sourceMode: "both" as ResearchSourceMode,
    projectId: "",
    topic: "",
    schedule: "off",
    starting: false,
    error: "",
  };
  @state() private schedules: Array<{ id: string; name: string; expr?: string; nextRunAtMs?: number; enabled: boolean }> = [];
  @state() private toast: { text: string; kind: "ok" | "err"; action?: { label: string; run: () => void } } | null = null;
  @state() private mobileTab: "library" | "ask" | "ideas" = "library";

  private api: ResearchApi | null = null;
  private unsub: (() => void) | null = null;
  private lastVisit: number | null = null;
  private toastTimer: number | undefined;
  private pickerTimer: number | undefined;
  private loadedFor: GatewayBrowserClient | null = null;

  protected createRenderRoot(): HTMLElement {
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    try {
      const raw = localStorage.getItem(LAST_VISIT_KEY);
      this.lastVisit = raw ? Number(raw) || null : null;
    } catch {
      this.lastVisit = null;
    }
    this.applyUrlParams();
    // Keeps the elapsed time on live runs ticking between gateway events.
    let tick = 0;
    this.ticker = window.setInterval(() => {
      if (this.runs.some((r) => r.stage !== "done" && r.stage !== "failed")) this.requestUpdate();
      if (++tick % 6 === 0) void this.watchdog();
    }, 1000);
  }
  private ticker: number | undefined;

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.clearInterval(this.ticker);
    this.unsub?.();
    this.unsub = null;
    this.loadedFor = null;
    try {
      localStorage.setItem(LAST_VISIT_KEY, String(Date.now()));
    } catch {
      /* private mode */
    }
    if (this.detail?.pdfUrl) URL.revokeObjectURL(this.detail.pdfUrl);
  }

  protected updated(changed: PropertyValues): void {
    if ((changed.has("client") || changed.has("connected")) && this.client && this.loadedFor !== this.client) {
      this.loadedFor = this.client;
      this.api = new ResearchApi(this.client);
      this.unsub?.();
      this.unsub = this.client.subscribe((evt) => this.onGatewayEvent(evt));
      void this.loadAll();
    }
  }

  /** `/research?project=<id>&q=<question>&open=<key>` deep links. */
  private applyUrlParams(): void {
    try {
      const p = new URLSearchParams(window.location.search);
      const project = p.get("project");
      const q = p.get("q");
      if (project) {
        // Arriving from a project page: scope new research to it and show its research.
        this.compose = { ...this.compose, projectId: project };
        this.filter = { ...this.filter, projectId: project };
      }
      if (q) this.compose = { ...this.compose, question: q };
      const open = p.get("open");
      if (open) this.pendingOpen = open;
    } catch {
      /* no window */
    }
  }
  private pendingOpen: string | null = null;

  // ── loading ─────────────────────────────────────────────────────

  private async loadAll(): Promise<void> {
    if (!this.api) return;
    this.loading = !this.items.length;
    this.loadError = null;
    const [docs, reports, projects, schedules] = await Promise.allSettled([
      this.api.listResearchDocs(),
      this.api.listResearchReports(),
      this.api.projects(),
      this.api.listResearchSchedules(),
    ]);
    if (projects.status === "fulfilled") this.projects = projects.value;
    if (schedules.status === "fulfilled") this.schedules = schedules.value;
    if (reports.status === "fulfilled") this.reports = reports.value;
    if (docs.status === "rejected" && reports.status === "rejected") {
      this.loadError = `Could not load research: ${errText(docs.reason)}`;
    }
    this.items = mergeLibrary(
      docs.status === "fulfilled" ? docs.value : [],
      reports.status === "fulfilled" ? reports.value : [],
    );
    this.loading = false;
    void this.reconcileRuns();
    if (this.pendingOpen) {
      const key = this.pendingOpen;
      this.pendingOpen = null;
      const it = this.items.find((i) => i.key === key || i.reportId === key || i.docId === key);
      if (it) void this.openDetail(it);
    }
  }

  /** Runs that finished while nobody was watching get finalized from the transcript. */
  private async reconcileRuns(): Promise<void> {
    if (!this.api) return;
    const pending = this.items.filter(
      (i) => i.kind === "run" && i.status === "running" && !this.runs.some((r) => r.docId === i.docId),
    );
    for (const it of pending.slice(0, 5)) {
      const text = await this.api.lastAssistantText(it.sessionKey!).catch(() => null);
      const doc = await this.api.getResearchDoc(it.docId!);
      const meta = doc ? parseRunMeta(doc.body).meta : null;
      const run: RunProgress = {
        docId: it.docId!,
        sessionKey: it.sessionKey!,
        title: it.title,
        question: meta?.question ?? it.question ?? it.title,
        depth: meta?.depth ?? it.depth ?? "quick",
        sourceMode: meta?.sourceMode ?? it.sourceMode ?? "both",
        projectId: meta?.projectId ?? it.projectId,
        projectLabel: this.projectName(meta?.projectId ?? it.projectId),
        topic: meta?.topic,
        startedAt: meta?.startedAt ?? it.createdAt,
        stage: text ? "saving" : "agent",
        webSources: meta?.sources?.filter((s) => s.kind !== "internal") ?? [],
        internalSources: meta?.sources?.filter((s) => s.kind === "internal") ?? [],
        steps: [],
        stream: text ?? "",
        warnings: [],
        followUpOf: meta?.followUpOf,
      };
      this.runs = [...this.runs, run];
      if (text) void this.finalize(run, text);
    }
  }

  private projectName(id: string | undefined): string | undefined {
    if (!id) return undefined;
    return this.projects.find((p) => p.id === id)?.name;
  }

  private flash(text: string, kind: "ok" | "err" = "ok", action?: { label: string; run: () => void }): void {
    this.toast = { text, kind, action };
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => (this.toast = null), kind === "err" ? 9000 : 6000);
  }

  // ── gateway events ──────────────────────────────────────────────

  private onGatewayEvent(evt: GatewayEventFrame): void {
    if (evt.event !== "chat" && evt.event !== "agent") return;
    const p = (evt.payload ?? {}) as Record<string, unknown>;
    const key = typeof p.sessionKey === "string" ? p.sessionKey : "";
    if (!key) return;
    if (this.ask.sessionKey === key) {
      this.onAskEvent(evt.event, p);
      return;
    }
    const run = this.runs.find((r) => r.sessionKey === key);
    if (!run) return;
    if (evt.event === "chat") this.onRunChat(run, p);
    else this.onRunAgent(run, p);
  }

  private patchRun(run: RunProgress, patch: Partial<RunProgress>): RunProgress {
    const next = { ...run, ...patch };
    this.runs = this.runs.map((r) => (r.docId === run.docId ? next : r));
    return next;
  }

  private onRunChat(run: RunProgress, p: Record<string, unknown>): void {
    const st = p.state;
    if (st === "delta") {
      const text = messageText(p.message);
      if (text && text.length >= run.stream.length) this.patchRun(run, { stream: text, stage: "writing" });
    } else if (st === "final") {
      const text = messageText(p.message) || run.stream;
      void this.finalize(this.patchRun(run, { stream: text }), text);
    } else if (st === "error" || st === "aborted") {
      void this.failRun(run, st === "aborted" ? "Stopped." : String(p.errorMessage ?? "The agent run failed."));
    }
  }

  private onRunAgent(run: RunProgress, p: Record<string, unknown>): void {
    const data = (p.data ?? {}) as Record<string, unknown>;
    const stream = p.stream;
    if (stream !== "tool" && stream !== "tool_status") return;
    const id = String(data.toolCallId ?? `${data.name}-${run.steps.length}`);
    const name = String(data.name ?? "tool");
    const phase = String(data.phase ?? "");
    if (phase === "start") {
      if (run.steps.some((s) => s.id === id)) return;
      this.patchRun(run, {
        stage: run.stage === "writing" ? "writing" : "agent",
        steps: [...run.steps, { id, name, detail: toolDetail(name, data.args ?? data.arguments), status: "run" as const }].slice(-40),
      });
    } else if (phase === "result" || phase === "end") {
      const isErr = data.isError === true || !!data.error;
      const found =
        /search|read|fetch/.test(name) && !isErr
          ? urlsIn(data.result)
              .filter((u) => !run.webSources.some((s) => s.url === u))
              .map((u) => ({ title: hostOf(u), url: u, kind: "agent" }))
          : [];
      this.patchRun(run, {
        steps: run.steps.map((s): Step => (s.id === id ? { ...s, status: isErr ? "err" : "ok" } : s)),
        webSources: found.length ? [...run.webSources, ...found].slice(0, 40) : run.webSources,
      });
    }
  }

  // ── start research ──────────────────────────────────────────────

  private async startResearch(opts?: {
    question?: string;
    depth?: ResearchDepth;
    sourceMode?: ResearchSourceMode;
    projectId?: string;
    topic?: string;
    followUpOf?: string;
    followUpContext?: string;
  }): Promise<void> {
    if (!this.api) return;
    const question = (opts?.question ?? this.compose.question).trim();
    if (question.length < 4) {
      this.compose = { ...this.compose, error: "Describe what you want researched (a few words at least)." };
      return;
    }
    const depth = opts?.depth ?? this.compose.depth;
    const sourceMode = opts?.sourceMode ?? this.compose.sourceMode;
    const projectId = (opts?.projectId ?? this.compose.projectId) || undefined;
    const topic = ((opts?.topic ?? this.compose.topic) || "").trim() || undefined;
    const projectLabel = this.projectName(projectId);
    const schedule = opts ? "off" : this.compose.schedule;
    this.compose = { ...this.compose, starting: true, error: "" };

    const docId = newRunId();
    const sessionKey = sessionKeyForRun(docId);
    const title = titleFromQuestion(question);
    const meta: RunMeta = {
      v: 1,
      question,
      depth,
      sourceMode,
      projectId,
      topic,
      startedAt: Date.now(),
      followUpOf: opts?.followUpOf,
    };
    try {
      await this.api.saveResearchDoc("create", {
        id: docId,
        name: title,
        description: singleLine(question),
        category: RUN_CATEGORY,
        status: "draft",
        topic: projectLabel ?? topic,
        tags: encodeRunTags({ depth, sourceMode, projectId }),
        body: embedRunMeta(meta, `# ${title}\n\n_Research in progress…_`),
      });
    } catch (e) {
      this.compose = { ...this.compose, starting: false, error: `Could not start: ${errText(e)}` };
      return;
    }
    if (schedule !== "off") void this.scheduleRecurring(question, schedule, projectId);
    let run: RunProgress = {
      docId,
      sessionKey,
      title,
      question,
      depth,
      sourceMode,
      projectId,
      projectLabel,
      topic,
      startedAt: meta.startedAt,
      stage: sourceMode === "internal" ? "internal" : "gather",
      webSources: [],
      internalSources: [],
      steps: [],
      stream: "",
      warnings: [],
      followUpOf: opts?.followUpOf,
    };
    this.runs = [run, ...this.runs];
    this.compose = { ...this.compose, starting: false, question: opts ? this.compose.question : "" };
    void this.loadAll();

    // 1) web sources (free aggregator) — shown as they arrive
    if (sourceMode !== "internal") {
      try {
        const g = await this.api.gatherWeb(question, PER_SOURCE[depth]);
        run = this.patchRun(run, { webSources: g.sources.slice(0, 16), warnings: g.warnings });
      } catch (e) {
        run = this.patchRun(run, { warnings: [...run.warnings, `web gather: ${errText(e)}`] });
      }
    }
    // 2) internal knowledge
    if (sourceMode !== "web") {
      run = this.patchRun(run, { stage: "internal" });
      const internal = await this.internalSources(`${question} ${projectLabel ?? ""}`, depth === "deep" ? 10 : 6, docId);
      run = this.patchRun(run, { internalSources: internal.sources, warnings: [...run.warnings, ...internal.notes] });
    }
    // 3) the agent
    run = this.patchRun(run, { stage: "agent" });
    const prompt = buildResearchPrompt({
      question,
      depth,
      sourceMode,
      projectLabel,
      projectId,
      topic,
      webSources: run.webSources.slice(0, 12),
      internalSources: run.internalSources,
      followUpContext: opts?.followUpContext,
    });
    try {
      await this.api.prepareSession(sessionKey, `Research · ${singleLine(title, 40)} · ${docId.slice(-5)}`);
      await this.api.saveResearchDoc("update", {
        id: docId,
        body: embedRunMeta({ ...meta, sources: [...run.webSources, ...run.internalSources].slice(0, 30) }, `# ${title}\n\n_Research in progress…_`),
      });
      await this.api.send(sessionKey, prompt, docId);
    } catch (e) {
      await this.failRun(run, `Could not start the research agent: ${errText(e)}`);
    }
  }

  /** Ranked internal sources for a query: documents, notes, prior research, memory. */
  private async internalSources(
    query: string,
    limit: number,
    excludeDocId?: string,
  ): Promise<{ sources: ResearchSourceRef[]; notes: string[] }> {
    const api = this.api!;
    const notes: string[] = [];
    // Documents/notes match literally: search the whole question AND its key terms.
    const terms = keywordQueries(query, 3);
    const docQueries = [query, ...terms];
    const [docsAll, ntsAll, mem] = await Promise.all([
      Promise.allSettled(docQueries.map((dq) => api.searchDocuments(dq, 6))),
      Promise.allSettled(terms.map((t) => api.searchNotes(t, 6))),
      api.memory(query).catch((e) => ({ hits: [] as ResearchSourceRef[], disabled: errText(e) })),
    ]);
    const docs = {
      status: docsAll.some((r) => r.status === "fulfilled") ? ("fulfilled" as const) : ("rejected" as const),
      value: docsAll.flatMap((r) => (r.status === "fulfilled" ? r.value : [])),
      reason: docsAll.find((r): r is PromiseRejectedResult => r.status === "rejected")?.reason,
    };
    const nts = { status: "fulfilled" as const, value: ntsAll.flatMap((r) => (r.status === "fulfilled" ? r.value : [])) };
    const cands: Array<ResearchSourceRef & { body?: string }> = [];
    if (docs.status === "fulfilled") {
      for (const d of docs.value) {
        if (cands.some((c) => c.ref?.id === d.id)) continue;
        cands.push({
          title: d.title,
          kind: "internal",
          snippet: d.snippet,
          ref: d.isNoteMirror ? { type: "note", id: d.id } : { type: "doc", id: d.id },
        });
      }
    } else notes.push(`documents: ${errText(docs.reason)}`);
    if (nts.status === "fulfilled") {
      for (const n of nts.value) {
        if (cands.some((c) => c.ref?.id === n.id)) continue;
        cands.push({ title: n.title, kind: "internal", snippet: n.snippet, body: n.body, ref: { type: "note", id: n.id } });
      }
    }
    for (const it of this.items) {
      if ((!it.reportId && !it.docId) || (excludeDocId && it.docId === excludeDocId)) continue;
      if (it.kind === "run" && it.status !== "complete") continue;
      cands.push({
        title: it.title,
        kind: "internal",
        snippet: it.preview ? singleLine(it.preview, 240) : it.question,
        ref: it.reportId ? { type: "report", id: it.reportId } : { type: "research", id: it.docId! },
      });
    }
    for (const p of this.projects) {
      cands.push({ title: `Project: ${p.name}`, kind: "internal", snippet: p.description?.slice(0, 240), ref: { type: "project", id: p.id } });
    }
    if (mem.disabled) notes.push(`memory: ${memoryNote(mem.disabled)}`);
    cands.push(...mem.hits);
    return { sources: rankSources(query, cands, limit, 0.2), notes };
  }

  private async finalize(run: RunProgress, text: string): Promise<void> {
    if (!this.api || run.finalizing) return;
    if (!text.trim()) {
      const fromHistory = await this.api.lastAssistantText(run.sessionKey).catch(() => null);
      if (!fromHistory) {
        // A bare final can land before the transcript is written: keep the run
        // live and let the watchdog read the reply; only a long silence fails it.
        if (Date.now() - run.startedAt > RUN_STALL_MS) await this.failRun(run, "The agent finished without a reply.");
        return;
      }
      text = fromHistory;
    }
    run = this.patchRun(run, { stage: "saving", finalizing: true, stream: text });
    const parsed = parseResearchMarkdown(text);
    const title = singleLine(parsed.title || run.title, 120);
    const sources = parsed.sources.length ? parsed.sources : [...run.webSources, ...run.internalSources];
    let reportId: string | undefined;
    let saveError: string | undefined;
    try {
      reportId = await this.api.fileReport({
        title,
        markdown: parsed.markdown,
        subtitle: singleLine(run.question, 200),
        projectId: run.projectId,
      });
    } catch (e) {
      saveError = errText(e);
    }
    const meta: RunMeta = {
      v: 1,
      question: run.question,
      depth: run.depth,
      sourceMode: run.sourceMode,
      projectId: run.projectId,
      topic: run.topic,
      startedAt: run.startedAt,
      finishedAt: Date.now(),
      sources: sources.slice(0, 40),
      followUpOf: run.followUpOf,
      ...(saveError ? { error: `PDF/report: ${saveError}` } : {}),
    };
    try {
      await this.api.saveResearchDoc("update", {
        id: run.docId,
        name: title,
        status: "active",
        tags: encodeRunTags({ depth: run.depth, sourceMode: run.sourceMode, projectId: run.projectId, reportId }),
        sources: sources.map((s) => s.url).filter((u): u is string => !!u).slice(0, 30),
        body: embedRunMeta(meta, parsed.markdown),
      });
    } catch (e) {
      saveError = saveError ?? errText(e);
    }
    // Research-of-research: a follow-up links back to what it followed.
    if (reportId && run.followUpOf) {
      const prev = this.items.find((i) => i.key === run.followUpOf);
      if (prev?.reportId) {
        await this.api.link(reportId, { type: "report", id: prev.reportId, label: prev.title }).catch(() => undefined);
      }
    }
    this.patchRun(run, { stage: "done", reportId, finalizing: false, error: saveError });
    await this.loadAll();
    const item = this.items.find((i) => i.docId === run.docId);
    this.flash(
      saveError ? `Research finished, but saving the report failed: ${saveError}` : `Research saved to Reports${run.projectLabel ? ` and linked to ${run.projectLabel}` : ""}.`,
      saveError ? "err" : "ok",
      item ? { label: "Open", run: () => void this.openDetail(item) } : undefined,
    );
    window.setTimeout(() => {
      this.runs = this.runs.filter((r) => r.docId !== run.docId || r.stage !== "done");
    }, 12_000);
  }

  private async failRun(run: RunProgress, message: string): Promise<void> {
    this.patchRun(run, { stage: "failed", error: message });
    try {
      await this.api?.saveResearchDoc("update", {
        id: run.docId,
        status: "review",
        tags: encodeRunTags({ depth: run.depth, sourceMode: run.sourceMode, projectId: run.projectId, failed: true }),
        body: embedRunMeta(
          { v: 1, question: run.question, depth: run.depth, sourceMode: run.sourceMode, projectId: run.projectId, startedAt: run.startedAt, finishedAt: Date.now(), error: message },
          `# ${run.title}\n\nThis research did not complete: ${message}`,
        ),
      });
    } catch {
      /* keep the in-memory failure visible */
    }
    void this.loadAll();
  }

  private async stopRun(run: RunProgress): Promise<void> {
    await this.api?.abort(run.sessionKey);
    await this.failRun(run, "Stopped by you.");
  }

  private async scheduleRecurring(question: string, scheduleId: string, projectId?: string): Promise<void> {
    const sched = SCHEDULES.find((s) => s.id === scheduleId);
    if (!sched?.expr || !this.api) return;
    const label = this.projectName(projectId);
    const message = [
      buildResearchPrompt({ question, depth: "standard", sourceMode: "both", projectLabel: label, projectId }).replace(
        /Do NOT create reports[^\n]*\n/,
        "",
      ),
      "",
      `WHEN DONE: call the report tool with action "render", category "research", kind "research_brief", title = your # title${projectId ? `, projectId "${projectId}"` : ""}, and markdown = your full reply. That files it in the Research library.`,
    ].join("\n");
    try {
      await this.api.scheduleRecurring({ name: `Research · ${singleLine(titleFromQuestion(question), 60)}`, expr: sched.expr, message });
      this.schedules = await this.api.listResearchSchedules();
      this.flash(`${sched.label} research scheduled.`);
    } catch (e) {
      this.flash(`Could not schedule: ${errText(e)}`, "err");
    }
  }

  // ── detail ──────────────────────────────────────────────────────

  private async openDetail(item: ResearchItem): Promise<void> {
    if (!this.api) return;
    if (this.detail?.pdfUrl) URL.revokeObjectURL(this.detail.pdfUrl);
    this.detail = {
      key: item.key,
      loading: true,
      markdown: "",
      parsed: null,
      meta: null,
      report: null,
      links: [],
      linksLoading: !!item.reportId,
      suggestions: [],
      suggesting: false,
      busy: {},
      pickerQuery: "",
      pickerResults: [],
    };
    this.scrollToTop();
    try {
      let markdown = "";
      let meta: RunMeta | null = null;
      if (item.docId) {
        const doc = await this.api.getResearchDoc(item.docId);
        if (doc) {
          const parsed = parseRunMeta(doc.body);
          meta = parsed.meta;
          markdown = parsed.markdown;
        }
      }
      let report: Record<string, unknown> | null = null;
      if (item.reportId) report = await this.api.getReport(item.reportId);
      const markitdown = typeof report?.markdownBody === "string" ? (report.markdownBody as string) : undefined;
      if (!markdown.trim()) markdown = payloadToMarkdown(report) || markitdown || item.preview || "";
      const parsed = parseResearchMarkdown(markdown);
      if (meta?.sources?.length && !parsed.sources.length) parsed.sources = meta.sources;
      this.detail = { ...this.detail!, loading: false, markdown, parsed, meta, report, markitdown };
    } catch (e) {
      this.detail = { ...this.detail!, loading: false, error: errText(e) };
    }
    void this.loadLinks(item);
  }

  private currentItem(): ResearchItem | undefined {
    return this.detail ? this.items.find((i) => i.key === this.detail!.key) : undefined;
  }

  private async loadLinks(item: ResearchItem): Promise<void> {
    if (!this.api || !this.detail) return;
    let links: ResearchLink[] = [];
    if (item.reportId) {
      try {
        // Project names come from the board list: the relation resolver can't
        // name projects that live only in the local-first role tables.
        links = flattenConnections(await this.api.connections("report", item.reportId)).map((l) =>
          l.type === "project" ? { ...l, label: this.projectName(l.id) ?? l.label } : l,
        );
      } catch {
        links = [];
      }
    }
    if (this.detail?.key !== item.key) return;
    this.detail = { ...this.detail, links, linksLoading: false, suggesting: true };
    // Suggestions: projects + prior research + matching notes/docs + scope tasks,
    // boosted by what the already-linked objects connect to.
    const d = this.detail;
    const text = [item.title, item.question, d.parsed?.summary, ...(d.parsed?.findings ?? [])].filter(Boolean).join(" ");
    const cands: Candidate[] = [];
    for (const p of this.projects) if (!p.archived) cands.push({ type: "project", id: p.id, label: p.name, text: p.description?.slice(0, 300) });
    for (const it of this.items) {
      if (it.reportId && it.key !== item.key) cands.push({ type: "report", id: it.reportId, label: it.title, text: it.preview?.slice(0, 300) });
    }
    const q = plainText(item.title).split(/\s+/).slice(0, 5).join(" ");
    const [docs, nts] = await Promise.allSettled([this.api.searchDocuments(q, 8), this.api.searchNotes(q, 8)]);
    if (docs.status === "fulfilled") {
      for (const h of docs.value) cands.push({ type: h.isNoteMirror ? "note" : "doc", id: h.id, label: h.title, text: h.snippet });
    }
    if (nts.status === "fulfilled") {
      for (const n of nts.value) if (!cands.some((c) => c.id === n.id)) cands.push({ type: "note", id: n.id, label: n.title, text: n.body?.slice(0, 400) });
    }
    const scopeProjects = [item.projectId, ...links.filter((l) => l.type === "project").map((l) => l.id)].filter(
      (x): x is string => !!x,
    );
    for (const pid of [...new Set(scopeProjects)].slice(0, 2)) {
      const tasks = await this.api.tasksFor(pid).catch(() => []);
      for (const t of tasks.slice(0, 200)) cands.push({ type: "task", id: t.id, label: t.title, text: t.description?.slice(0, 200) });
    }
    const neighborResults = await Promise.all(
      links
        .filter((l) => l.type === "project")
        .slice(0, 3)
        .map((l) => this.api!.connections("project", l.id).catch(() => null)),
    );
    const suggestions = suggestLinks({
      researchText: text,
      candidates: cands,
      linked: new Set(links.map(targetKey)),
      neighborKeys: neighborKeysFrom(neighborResults.filter(Boolean)),
      scopeProjectId: item.projectId,
      limit: 8,
    });
    if (this.detail?.key !== item.key) return;
    this.detail = { ...this.detail, suggestions, suggesting: false };
  }

  private setBusy(key: string, on: boolean): void {
    if (!this.detail) return;
    this.detail = { ...this.detail, busy: { ...this.detail.busy, [key]: on } };
  }

  /** Research without a report (older docs, failed render) gets one first. */
  private async ensureReport(item: ResearchItem): Promise<string | null> {
    if (item.reportId) return item.reportId;
    if (!this.api || !this.detail) return null;
    this.setBusy("file", true);
    try {
      const markdown = this.detail.markdown || `# ${item.title}`;
      const reportId = await this.api.fileReport({
        title: singleLine(this.detail.parsed?.title || item.title, 120),
        markdown,
        subtitle: item.question ? singleLine(item.question, 200) : undefined,
        projectId: item.projectId,
      });
      if (item.docId && item.kind === "run") {
        await this.api.saveResearchDoc("update", {
          id: item.docId,
          status: "active",
          tags: encodeRunTags({ depth: item.depth, sourceMode: item.sourceMode, projectId: item.projectId, reportId }),
        });
      }
      await this.loadAll();
      const fresh = this.items.find((i) => i.key === item.key || i.reportId === reportId);
      if (fresh && this.detail) this.detail = { ...this.detail, key: fresh.key };
      this.flash("Saved to Reports (PDF + markdown copy).");
      return reportId;
    } catch (e) {
      this.flash(`Could not save to Reports: ${errText(e)}`, "err");
      return null;
    } finally {
      this.setBusy("file", false);
    }
  }

  private async addLink(target: LinkTarget): Promise<void> {
    const item = this.currentItem();
    if (!item || !this.api) return;
    const reportId = await this.ensureReport(item);
    if (!reportId) return;
    const busyKey = `link:${targetKey(target)}`;
    this.setBusy(busyKey, true);
    try {
      await this.api.link(reportId, target);
      // Linking a project to a run that had no scope records it as the run's
      // project, so the library's project filter / counts and refreshes see it.
      if (target.type === "project" && item.kind === "run" && item.docId && !item.projectId) {
        await this.api
          .saveResearchDoc("update", {
            id: item.docId,
            topic: target.label,
            tags: encodeRunTags({ depth: item.depth, sourceMode: item.sourceMode, projectId: target.id, reportId }),
          })
          .then(() => this.loadAll())
          .catch(() => undefined);
      }
      this.flash(`Linked to ${TYPE_LABEL[target.type].toLowerCase()} “${singleLine(target.label, 50)}”.`);
      const fresh = this.items.find((i) => i.reportId === reportId) ?? item;
      await this.loadLinks({ ...fresh, reportId });
    } catch (e) {
      this.flash(`Link failed: ${errText(e)}`, "err");
    } finally {
      this.setBusy(busyKey, false);
    }
  }

  private async removeLink(link: ResearchLink): Promise<void> {
    const item = this.currentItem();
    if (!item?.reportId || !this.api) return;
    try {
      await this.api.unlink(item.reportId, link);
      await this.loadLinks(item);
    } catch (e) {
      this.flash(`Unlink failed: ${errText(e)}`, "err");
    }
  }

  private primaryProjectId(item: ResearchItem): string | undefined {
    return item.projectId ?? this.detail?.links.find((l) => l.type === "project")?.id;
  }

  private async findingToTask(text: string, idx: string): Promise<void> {
    const item = this.currentItem();
    if (!item || !this.api) return;
    this.setBusy(`task:${idx}`, true);
    try {
      const projectId = this.primaryProjectId(item);
      const title = taskTitleFrom(text);
      const taskId = await this.api.createTask({
        title,
        description: `${plainText(text)}\n\nFrom research: ${item.title}${item.reportId ? ` (report ${item.reportId})` : ""}`,
        projectId,
      });
      const reportId = item.reportId ?? (await this.ensureReport(item));
      if (taskId && reportId) await this.api.link(reportId, { type: "task", id: taskId, label: title }).catch(() => undefined);
      this.flash(`Task created${projectId ? ` in ${this.projectName(projectId) ?? "the project"}` : ""}: ${singleLine(title, 60)}`);
      void this.loadLinks({ ...item, reportId: reportId ?? undefined });
    } catch (e) {
      this.flash(`Could not create the task: ${errText(e)}`, "err");
    } finally {
      this.setBusy(`task:${idx}`, false);
    }
  }

  private async allActionsToTasks(): Promise<void> {
    const acts = this.detail?.parsed?.actions ?? [];
    for (let i = 0; i < acts.length; i++) await this.findingToTask(acts[i], `a${i}`);
  }

  private async saveAsNote(): Promise<void> {
    const item = this.currentItem();
    if (!item || !this.api || !this.detail) return;
    this.setBusy("note", true);
    try {
      const title = `Research: ${singleLine(item.title, 100)}`;
      const noteId = await this.api.createNote({ title, body: this.detail.markdown, projectId: this.primaryProjectId(item), tags: ["research"] });
      const reportId = item.reportId ?? (await this.ensureReport(item));
      if (noteId && reportId) await this.api.link(reportId, { type: "note", id: noteId, label: title }).catch(() => undefined);
      this.flash("Saved as a note and linked.", "ok", noteId ? { label: "Open note", run: () => this.go(`/notes/${noteId}`) } : undefined);
      void this.loadLinks({ ...item, reportId: reportId ?? undefined });
    } catch (e) {
      this.flash(`Could not save the note: ${errText(e)}`, "err");
    } finally {
      this.setBusy("note", false);
    }
  }

  private async postProjectUpdate(): Promise<void> {
    const item = this.currentItem();
    if (!item || !this.api || !this.detail) return;
    const projectId = this.primaryProjectId(item);
    if (!projectId) {
      this.flash("Link a project first — the update is posted on that project's page.", "err");
      return;
    }
    this.setBusy("update", true);
    try {
      const p = this.detail.parsed;
      const content = [
        `**Research update:** ${item.title}`,
        p?.summary ? `\n${p.summary}` : "",
        p?.findings.length ? `\n**Key findings**\n${p.findings.slice(0, 6).map((f) => `- ${f}`).join("\n")}` : "",
        p?.actions.length ? `\n**Next steps**\n${p.actions.slice(0, 5).map((f) => `- ${f}`).join("\n")}` : "",
        item.reportId ? `\nFull report: /reports (${item.reportId})` : "",
      ].join("\n");
      await this.api.postProjectUpdate(projectId, `Research: ${singleLine(item.title, 80)}`, content);
      const reportId = item.reportId ?? (await this.ensureReport(item));
      if (reportId && !this.detail.links.some((l) => l.type === "project" && l.id === projectId)) {
        await this.api.link(reportId, { type: "project", id: projectId, label: this.projectName(projectId) ?? projectId }).catch(() => undefined);
      }
      this.flash(`Update posted to ${this.projectName(projectId) ?? "the project"}.`, "ok", {
        label: "Open project",
        run: () => this.openProject(projectId),
      });
      void this.loadLinks({ ...item, reportId: reportId ?? undefined });
    } catch (e) {
      this.flash(`Could not post the update: ${errText(e)}`, "err");
    } finally {
      this.setBusy("update", false);
    }
  }

  private async openPdf(): Promise<void> {
    const item = this.currentItem();
    if (!item?.reportId || !this.api || !this.detail) return;
    this.detail = { ...this.detail, pdfLoading: true };
    try {
      const url = await this.api.reportPdfUrl(item.reportId);
      if (this.detail) this.detail = { ...this.detail, pdfUrl: url, pdfLoading: false };
    } catch (e) {
      if (this.detail) this.detail = { ...this.detail, pdfLoading: false };
      this.flash(errText(e), "err");
    }
  }

  private refreshResearch(item: ResearchItem): void {
    void this.startResearch({
      question: this.detail?.meta?.question ?? item.question ?? item.title,
      depth: item.depth ?? "standard",
      sourceMode: item.sourceMode ?? "both",
      projectId: item.projectId,
      followUpOf: item.key,
      followUpContext: this.detail?.parsed?.summary ? `Previous research (${relativeTime(item.updatedAt)}): ${this.detail.parsed.summary}` : undefined,
    });
    this.closeDetail();
    this.flash("Refreshing — the new run is linked to this one.");
  }

  private closeDetail(): void {
    if (this.detail?.pdfUrl) URL.revokeObjectURL(this.detail.pdfUrl);
    this.detail = null;
  }

  private async runPicker(query: string): Promise<void> {
    if (!this.detail || !this.api) return;
    const q = query.trim().toLowerCase();
    const item = this.currentItem();
    const linked = new Set(this.detail.links.map(targetKey));
    const out: Candidate[] = [];
    const match = (s: string) => !q || s.toLowerCase().includes(q);
    for (const p of this.projects) if (!p.archived && match(p.name)) out.push({ type: "project", id: p.id, label: p.name, sub: p.status });
    for (const it of this.items) {
      if (it.reportId && it.key !== item?.key && match(it.title)) out.push({ type: "report", id: it.reportId, label: it.title, sub: relativeTime(it.updatedAt) });
    }
    if (q.length >= 2) {
      this.detail = { ...this.detail, pickerLoading: true };
      const [docs, nts] = await Promise.allSettled([this.api.searchDocuments(q, 10), this.api.searchNotes(q, 10)]);
      if (docs.status === "fulfilled") for (const h of docs.value) out.push({ type: h.isNoteMirror ? "note" : "doc", id: h.id, label: h.title, sub: h.path });
      if (nts.status === "fulfilled") for (const n of nts.value) if (!out.some((o) => o.id === n.id)) out.push({ type: "note", id: n.id, label: n.title });
      const pid = item ? this.primaryProjectId(item) : undefined;
      if (pid) {
        const tasks = await this.api.tasksFor(pid).catch(() => []);
        for (const t of tasks) if (match(t.title)) out.push({ type: "task", id: t.id, label: t.title, sub: t.status });
      }
    }
    if (!this.detail || this.detail.pickerQuery !== query) return;
    this.detail = {
      ...this.detail,
      pickerLoading: false,
      pickerResults: out.filter((c) => !linked.has(targetKey(c))).slice(0, 30),
    };
  }

  // ── ask your knowledge ──────────────────────────────────────────

  private async askKnowledge(): Promise<void> {
    if (!this.api) return;
    const question = this.ask.question.trim();
    if (question.length < 3) return;
    this.ask = { question, status: "searching", sources: [], answer: "" };
    const internal = await this.internalSources(question, 8);
    const sessionKey = `${ASK_SESSION_PREFIX}${Date.now().toString(36)}`;
    this.ask = {
      ...this.ask,
      sources: internal.sources,
      memoryNote: internal.notes.find((n) => n.startsWith("memory:"))?.slice(8),
      status: "answering",
      sessionKey,
    };
    this.askStartedAt = Date.now();
    try {
      await this.api.prepareSession(sessionKey, `Ask · ${singleLine(question, 40)} · ${sessionKey.slice(-5)}`);
      await this.api.send(sessionKey, buildAskPrompt(question, internal.sources), sessionKey);
    } catch (e) {
      this.ask = { ...this.ask, status: "error", error: errText(e) };
    }
  }

  private onAskEvent(event: string, p: Record<string, unknown>): void {
    if (event !== "chat") return;
    if (p.state === "delta") {
      const t = messageText(p.message);
      if (t.length >= this.ask.answer.length) this.ask = { ...this.ask, answer: t };
    } else if (p.state === "final") {
      const text = messageText(p.message) || this.ask.answer;
      if (text.trim()) this.ask = { ...this.ask, answer: text, status: "done" };
      else void this.pollAsk(); // some providers send a bare final: read the transcript
    } else if (p.state === "error" || p.state === "aborted") {
      this.ask = { ...this.ask, status: "error", error: String(p.errorMessage ?? "The agent could not answer.") };
    }
  }

  /** Read the ask answer from the transcript (bare final event / missed events). */
  private async pollAsk(): Promise<void> {
    const key = this.ask.sessionKey;
    if (!this.api || !key) return;
    const text = await this.api.lastAssistantText(key).catch(() => null);
    if (this.ask.sessionKey !== key) return;
    if (text) this.ask = { ...this.ask, answer: text, status: "done" };
  }

  /**
   * Safety net for missed gateway events (reconnects, bare finals): every few
   * seconds, finished-but-unfinalized runs and asks are read from the transcript.
   */
  private async watchdog(): Promise<void> {
    if (!this.api) return;
    const now = Date.now();
    if (this.ask.status === "answering" && this.ask.sessionKey && now - this.askStartedAt > 8_000) await this.pollAsk();
    for (const run of this.runs) {
      if ((run.stage !== "agent" && run.stage !== "writing") || run.finalizing || now - run.startedAt < 15_000) continue;
      const text = await this.api.lastAssistantText(run.sessionKey).catch(() => null);
      const cur = this.runs.find((r) => r.docId === run.docId);
      if (text && cur && !cur.finalizing && (cur.stage === "agent" || cur.stage === "writing")) void this.finalize(cur, text);
    }
  }
  private askStartedAt = 0;

  private researchFurther(): void {
    const q = this.ask.question;
    void this.startResearch({
      question: q,
      depth: "standard",
      sourceMode: "both",
      projectId: this.compose.projectId || undefined,
      followUpContext: this.ask.answer ? `Internal answer so far: ${plainText(this.ask.answer).slice(0, 1200)}` : undefined,
    });
    this.flash("Web follow-up started.");
    this.scrollToTop();
  }

  private async askToNote(): Promise<void> {
    if (!this.api || !this.ask.answer) return;
    try {
      const sources = this.ask.sources.map((s, i) => `- [${i + 1}] ${s.title}${s.ref ? ` (${s.ref.type} ${s.ref.id})` : ""}`).join("\n");
      const id = await this.api.createNote({
        title: `Q: ${singleLine(this.ask.question, 100)}`,
        body: `# ${this.ask.question}\n\n${this.ask.answer}\n\n## Internal sources\n${sources}`,
        tags: ["research", "ask"],
      });
      this.flash("Answer saved as a note.", "ok", id ? { label: "Open", run: () => this.go(`/notes/${id}`) } : undefined);
    } catch (e) {
      this.flash(`Could not save: ${errText(e)}`, "err");
    }
  }

  // ── navigation ──────────────────────────────────────────────────

  private go(route: string): void {
    const base = (this.app?.basePath ?? "").replace(/\/+$/, "");
    window.history.pushState({}, "", `${base}${route}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }

  private openProject(id: string): void {
    const app = this.app;
    if (app) {
      app.kanbanSelectedProjectId = id;
      app.kanbanGalleryView = false;
    }
    if (app?.setTab) app.setTab("projects" as never);
    else this.go("/projects");
  }

  private openSource(s: ResearchSourceRef): void {
    if (s.url) {
      window.open(s.url, "_blank", "noopener");
      return;
    }
    const ref = s.ref;
    if (!ref) return;
    if (ref.type === "project") this.openProject(ref.id);
    else if (ref.type === "note") this.go(`/notes/${ref.id}`);
    else if (ref.type === "doc") this.go(`/documents/${ref.id}`);
    else if (ref.type === "report" || ref.type === "research") {
      const it = this.items.find((i) => i.reportId === ref.id || i.docId === ref.id);
      if (it) void this.openDetail(it);
      else if (this.app?.setTab) this.app.setTab("reports" as never);
    }
  }

  private openLink(l: ResearchLink): void {
    if (l.type === "project") this.openProject(l.id);
    else if (l.type === "note") this.go(`/notes/${l.id}`);
    else if (l.type === "doc") this.go(`/documents/${l.id}`);
    else if (l.type === "task") this.go(`/tasks/${l.id}`);
    else if (l.type === "report") {
      const it = this.items.find((i) => i.reportId === l.id);
      if (it) void this.openDetail(it);
      else if (this.app?.setTab) this.app.setTab("reports" as never);
    }
  }

  private scrollToTop(): void {
    this.updateComplete.then(() => this.querySelector(".rs-scroll")?.scrollTo({ top: 0, behavior: "smooth" }));
  }

  // ── render ──────────────────────────────────────────────────────

  render(): TemplateResult {
    if (!this.client) {
      return html`<div class="wg-page rs-page"><div class="rs-scroll">${this.renderEmpty("Not connected", "Connect to the gateway to use Research.")}</div></div>`;
    }
    return html`
      <div class="wg-page rs-page">
        <div class="wg-aurora"></div>
        <div class="rs-scroll">
          ${this.detail ? this.renderDetail() : this.renderHome()}
        </div>
        ${this.toast
          ? html`<div class="rs-toast rs-toast--${this.toast.kind}" role="status">
              <span>${this.toast.text}</span>
              ${this.toast.action
                ? html`<button class="rs-btn rs-btn--ghost rs-btn--sm" @click=${() => { this.toast?.action?.run(); this.toast = null; }}>${this.toast.action.label}</button>`
                : nothing}
              <button class="rs-icon-btn" aria-label="Dismiss" @click=${() => (this.toast = null)}>${icons.x}</button>
            </div>`
          : nothing}
      </div>
    `;
  }

  private renderEmpty(title: string, body: unknown, action?: unknown): TemplateResult {
    return html`<div class="wg-empty">
      <div class="wg-empty__icon">${icons.search}</div>
      <div class="wg-empty__title">${title}</div>
      <div class="wg-empty__body">${body}</div>
      ${action ?? nothing}
    </div>`;
  }

  private renderHome(): TemplateResult {
    const all = this.items;
    const running = this.runs.filter((r) => r.stage !== "done" && r.stage !== "failed").length;
    const linked = all.filter((i) => i.projectId).length;
    const stale = all.filter((i) => isStale(i)).length;
    return html`
      <header class="wg-hero rs-hero">
        <div class="wg-hero__text">
          <div class="wg-eyebrow">Research</div>
          <h1 class="wg-title">Research <span class="wg-gold">workspace</span></h1>
          <p class="wg-sub">Ask a question, let an agent research the web and what InfiniBot already knows, and file the result as a linked report on your projects, notes, tasks and knowledge graph.</p>
        </div>
        <div class="wg-hero__actions">
          <button class="rs-btn rs-btn--ghost" @click=${() => void this.loadAll()} ?disabled=${this.loading}>${icons.refresh} Refresh</button>
          <button class="rs-btn rs-btn--ghost" @click=${() => this.app?.setTab?.("reports" as never)}>${icons.fileText} All reports</button>
        </div>
      </header>
      <div class="wg-stats rs-stats">
        ${this.stat("Research", this.loading ? "…" : String(all.length), "runs, reports and docs")}
        ${this.stat("Running", String(running), running ? "live below" : "idle")}
        ${this.stat("On projects", this.loading ? "…" : String(linked), "scoped to a project")}
        ${this.stat("Needs refresh", this.loading ? "…" : String(stale), "older than 30 days")}
      </div>
      ${this.renderComposer()}
      ${this.runs.length ? html`<section class="rs-runs" aria-label="Running research">${this.runs.map((r) => this.renderRun(r))}</section>` : nothing}
      <nav class="rs-mtabs" aria-label="Research sections">
        ${(["library", "ask", "ideas"] as const).map(
          (t) => html`<button class=${this.mobileTab === t ? "is-on" : ""} @click=${() => (this.mobileTab = t)}>
            ${t === "library" ? "Library" : t === "ask" ? "Ask" : "Ideas"}
          </button>`,
        )}
      </nav>
      <div class="rs-grid" data-mtab=${this.mobileTab}>
        <section class="rs-col rs-col--main">${this.renderLibrary()}</section>
        <aside class="rs-col rs-col--side">
          <div class="rs-side-ask">${this.renderAsk()}</div>
          <div class="rs-side-ideas">${this.renderProactive()}</div>
        </aside>
      </div>
    `;
  }

  private stat(label: string, value: string, hint: string): TemplateResult {
    return html`<div class="wg-card wg-stat"><div class="wg-stat__label">${label}</div><div class="wg-stat__value">${value}</div><div class="wg-stat__hint">${hint}</div></div>`;
  }

  private renderComposer(): TemplateResult {
    const c = this.compose;
    const projects = [...this.projects].filter((p) => !p.archived).sort((a, b) => a.name.localeCompare(b.name));
    return html`
      <section class="wg-surface rs-compose" aria-label="Start research">
        <div class="rs-compose__head">
          <span class="rs-compose__icon">${icons.sparkles}</span>
          <div>
            <div class="rs-h2">Start research</div>
            <div class="rs-muted">Runs through the real research agent. Live progress below, result saved to Reports automatically.</div>
          </div>
        </div>
        <textarea
          class="rs-input rs-textarea"
          rows="3"
          placeholder="What should we find out? e.g. “Which humanoid robot vendors could supply RoboPark in 2026, and at what price?”"
          .value=${c.question}
          @input=${(e: Event) => (this.compose = { ...this.compose, question: (e.target as HTMLTextAreaElement).value, error: "" })}
          @keydown=${(e: KeyboardEvent) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void this.startResearch();
          }}
        ></textarea>
        <div class="rs-compose__row">
          <div class="rs-field">
            <span class="rs-label">Depth</span>
            <div class="rs-seg" role="radiogroup" aria-label="Depth">
              ${DEPTHS.map(
                (d) => html`<button role="radio" aria-checked=${c.depth === d.id} class=${c.depth === d.id ? "is-on" : ""} title=${d.hint} @click=${() => (this.compose = { ...this.compose, depth: d.id })}>${d.label}</button>`,
              )}
            </div>
          </div>
          <div class="rs-field">
            <span class="rs-label">Sources</span>
            <div class="rs-seg" role="radiogroup" aria-label="Sources">
              ${SOURCE_MODES.map(
                (s) => html`<button role="radio" aria-checked=${c.sourceMode === s.id} class=${c.sourceMode === s.id ? "is-on" : ""} @click=${() => (this.compose = { ...this.compose, sourceMode: s.id })}>${s.label}</button>`,
              )}
            </div>
          </div>
          <label class="rs-field">
            <span class="rs-label">Project</span>
            <select class="rs-input rs-select" .value=${c.projectId} @change=${(e: Event) => (this.compose = { ...this.compose, projectId: (e.target as HTMLSelectElement).value })}>
              <option value="">No project</option>
              ${projects.map((p) => html`<option value=${p.id} ?selected=${p.id === c.projectId}>${p.name}</option>`)}
            </select>
          </label>
          <label class="rs-field">
            <span class="rs-label">Topic</span>
            <input class="rs-input" placeholder="optional" .value=${c.topic} @input=${(e: Event) => (this.compose = { ...this.compose, topic: (e.target as HTMLInputElement).value })} />
          </label>
          <label class="rs-field">
            <span class="rs-label">Repeat</span>
            <select class="rs-input rs-select" .value=${c.schedule} @change=${(e: Event) => (this.compose = { ...this.compose, schedule: (e.target as HTMLSelectElement).value })}>
              ${SCHEDULES.map((s) => html`<option value=${s.id} ?selected=${s.id === c.schedule}>${s.label}</option>`)}
            </select>
          </label>
        </div>
        <div class="rs-compose__foot">
          ${c.error ? html`<span class="rs-error" role="alert">${icons.alertCircle} ${c.error}</span>` : html`<span class="rs-muted">${DEPTHS.find((d) => d.id === c.depth)?.hint} · Ctrl/⌘ + Enter</span>`}
          <button class="rs-btn rs-btn--primary" ?disabled=${c.starting || !this.connected} @click=${() => void this.startResearch()}>
            ${c.starting ? html`<span class="rs-spin"></span> Starting…` : html`${icons.search} Start research`}
          </button>
        </div>
      </section>
    `;
  }

  private renderRun(r: RunProgress): TemplateResult {
    const order = STAGES.map((s) => s.id);
    const curIdx = r.stage === "done" ? order.length : r.stage === "failed" ? -1 : order.indexOf(r.stage as (typeof order)[number]);
    const skip = (id: string) => (id === "gather" && r.sourceMode === "internal") || (id === "internal" && r.sourceMode === "web");
    const sources = [...r.webSources, ...r.internalSources];
    const elapsed = Math.max(0, Math.round((Date.now() - r.startedAt) / 1000));
    return html`
      <article class="wg-surface rs-run rs-run--${r.stage}" aria-live="polite">
        <header class="rs-run__head">
          <div class="rs-run__title">
            ${r.stage === "done" ? html`<span class="rs-dot rs-dot--ok"></span>` : r.stage === "failed" ? html`<span class="rs-dot rs-dot--err"></span>` : html`<span class="rs-spin"></span>`}
            <div>
              <div class="rs-h3">${r.title}</div>
              <div class="rs-muted">${r.depth} · ${SOURCE_MODES.find((s) => s.id === r.sourceMode)?.label}${r.projectLabel ? html` · ${icons.folder} ${r.projectLabel}` : nothing} · ${elapsed < 120 ? `${elapsed}s` : `${Math.round(elapsed / 60)}m`}</div>
            </div>
          </div>
          <div class="rs-run__actions">
            ${r.stage === "done"
              ? html`<button class="rs-btn rs-btn--sm" @click=${() => { const it = this.items.find((i) => i.docId === r.docId); if (it) void this.openDetail(it); }}>Open</button>`
              : r.stage === "failed"
                ? html`<button class="rs-btn rs-btn--sm rs-btn--ghost" @click=${() => (this.runs = this.runs.filter((x) => x.docId !== r.docId))}>Dismiss</button>`
                : html`<button class="rs-btn rs-btn--sm rs-btn--ghost" @click=${() => void this.stopRun(r)}>${icons.stop} Stop</button>`}
          </div>
        </header>
        <ol class="rs-stages">
          ${STAGES.map((s, i) => {
            const state = skip(s.id) ? "skip" : r.stage === "failed" ? (i <= Math.max(0, order.indexOf("agent")) ? "err" : "todo") : i < curIdx ? "ok" : i === curIdx ? "run" : "todo";
            return html`<li class="rs-stage rs-stage--${state}"><span class="rs-stage__dot"></span><span>${s.label}</span></li>`;
          })}
        </ol>
        ${r.error ? html`<div class="rs-error" role="alert">${icons.alertCircle} ${r.error}</div>` : nothing}
        <div class="rs-run__body">
          <div class="rs-run__col">
            <div class="rs-label">Sources found <span class="rs-count">${sources.length}</span></div>
            ${sources.length
              ? html`<ul class="rs-chips">${sources.slice(0, 18).map((s) => html`<li><button class="rs-chip" title=${s.snippet ?? s.title} @click=${() => this.openSource(s)}>${s.url ? icons.globe : icons.database}<span>${singleLine(s.url ? `${hostOf(s.url)} · ${s.title}` : s.title, 60)}</span></button></li>`)}</ul>`
              : html`<div class="rs-muted">${r.stage === "gather" || r.stage === "internal" ? "Searching…" : "No pre-gathered sources — the agent searches on its own."}</div>`}
            ${r.steps.length
              ? html`<div class="rs-label rs-mt">Agent steps</div>
                  <ul class="rs-steps">${r.steps.slice(-8).map((s) => html`<li class="rs-step rs-step--${s.status}">${s.status === "run" ? html`<span class="rs-spin rs-spin--xs"></span>` : s.status === "ok" ? icons.check : icons.x}<code>${s.name}</code><span>${s.detail}</span></li>`)}</ul>`
              : nothing}
            ${r.warnings.length ? html`<details class="rs-warn"><summary>${r.warnings.length} source note${r.warnings.length === 1 ? "" : "s"}</summary><ul>${r.warnings.map((w) => html`<li>${w}</li>`)}</ul></details>` : nothing}
          </div>
          <div class="rs-run__col rs-run__stream">
            <div class="rs-label">Live summary</div>
            ${r.stream
              ? html`<div class="rs-md rs-md--stream">${unsafeHTML(toSanitizedMarkdownHtml(r.stream))}</div>`
              : html`<div class="rs-skel-lines"><div class="wg-skel"></div><div class="wg-skel"></div><div class="wg-skel" style="width:60%"></div></div>`}
          </div>
        </div>
      </article>
    `;
  }

  private renderLibrary(): TemplateResult {
    const f = this.filter;
    const list = filterLibrary(this.items, f, (id) => this.projectName(id));
    const usedProjects = [
      ...new Set([...this.items.map((i) => i.projectId), f.projectId && f.projectId !== "all" && f.projectId !== "none" ? f.projectId : undefined].filter((x): x is string => !!x)),
    ];
    return html`
      <section class="wg-surface rs-panel" aria-label="Research library">
        <header class="rs-panel__head">
          <div class="rs-h2">${icons.book} Library</div>
          <span class="rs-muted">${list.length} of ${this.items.length}</span>
        </header>
        <div class="rs-filters">
          <label class="rs-search">
            ${icons.search}
            <input class="rs-input" placeholder="Search research, questions, projects…" .value=${f.query ?? ""} @input=${(e: Event) => (this.filter = { ...this.filter, query: (e.target as HTMLInputElement).value })} />
          </label>
          <select class="rs-input rs-select" aria-label="Status" .value=${f.status ?? "all"} @change=${(e: Event) => (this.filter = { ...this.filter, status: (e.target as HTMLSelectElement).value as LibraryFilter["status"] })}>
            <option value="all">Any status</option><option value="complete">Complete</option><option value="running">Running</option><option value="failed">Failed</option>
          </select>
          <select class="rs-input rs-select" aria-label="Type" .value=${f.kind ?? "all"} @change=${(e: Event) => (this.filter = { ...this.filter, kind: (e.target as HTMLSelectElement).value as LibraryFilter["kind"] })}>
            <option value="all">All types</option><option value="run">Research runs</option><option value="report">Reports</option><option value="doc">Documents</option>
          </select>
          <select class="rs-input rs-select" aria-label="Project" .value=${f.projectId ?? "all"} @change=${(e: Event) => (this.filter = { ...this.filter, projectId: (e.target as HTMLSelectElement).value })}>
            <option value="all">Any project</option><option value="none">No project</option>
            ${usedProjects.map((id) => html`<option value=${id}>${this.projectName(id) ?? id}</option>`)}
          </select>
          <select class="rs-input rs-select" aria-label="Sort" .value=${f.sort ?? "recent"} @change=${(e: Event) => (this.filter = { ...this.filter, sort: (e.target as HTMLSelectElement).value as LibraryFilter["sort"] })}>
            <option value="recent">Newest</option><option value="oldest">Oldest</option><option value="title">Title A–Z</option><option value="project">By project</option>
          </select>
        </div>
        ${this.loadError ? html`<div class="rs-error" role="alert">${icons.alertCircle} ${this.loadError} <button class="rs-btn rs-btn--sm" @click=${() => void this.loadAll()}>Retry</button></div>` : nothing}
        ${this.loading
          ? html`<div class="rs-list">${[0, 1, 2, 3].map(() => html`<div class="wg-card rs-item rs-item--skel"><div class="wg-skel" style="height:14px;width:55%"></div><div class="wg-skel" style="height:10px;width:85%;margin-top:10px"></div></div>`)}</div>`
          : list.length
            ? html`<ul class="rs-list">${list.slice(0, 200).map((it) => this.renderItem(it))}</ul>`
            : this.items.length
              ? this.renderEmpty("No matches", "Try a different search or clear the filters.", html`<button class="rs-btn rs-btn--sm" @click=${() => (this.filter = { status: "all", kind: "all", projectId: "all", sort: "recent" })}>Clear filters</button>`)
              : this.renderEmpty("No research yet", "Start your first research above — it lands here, in Reports, on its project and in the knowledge graph.")}
      </section>
    `;
  }

  private renderItem(it: ResearchItem): TemplateResult {
    const isNew = !!this.lastVisit && it.updatedAt > this.lastVisit;
    const stale = isStale(it);
    const project = this.projectName(it.projectId);
    return html`<li>
      <button class="wg-card wg-card--interactive rs-item" @click=${() => void this.openDetail(it)}>
        <div class="rs-item__top">
          <span class="rs-kind rs-kind--${it.kind}">${it.kind === "run" ? icons.search : it.kind === "report" ? icons.fileText : icons.book}${it.kind === "run" ? "Research" : it.kind === "report" ? "Report" : "Doc"}</span>
          <span class="rs-item__title">${it.title}</span>
          <span class="rs-status rs-status--${it.status}">${it.status}</span>
        </div>
        ${it.preview || it.question ? html`<div class="rs-item__preview">${singleLine(plainText(it.preview || it.question || ""), 200)}</div>` : nothing}
        <div class="rs-item__meta">
          <span>${icons.clock} ${relativeTime(it.updatedAt)}</span>
          ${project ? html`<span>${icons.folder} ${project}</span>` : nothing}
          ${it.depth ? html`<span>${it.depth}</span>` : nothing}
          ${it.hasPdf ? html`<span>${icons.fileText} PDF</span>` : nothing}
          ${isNew ? html`<span class="rs-badge rs-badge--new">new</span>` : nothing}
          ${stale ? html`<span class="rs-badge rs-badge--stale">stale</span>` : nothing}
        </div>
      </button>
    </li>`;
  }

  private renderAsk(): TemplateResult {
    const a = this.ask;
    const busy = a.status === "searching" || a.status === "answering";
    return html`
      <section class="wg-surface rs-panel rs-ask" aria-label="Ask your knowledge">
        <header class="rs-panel__head">
          <div class="rs-h2">${icons.brain} Ask your knowledge</div>
        </header>
        <p class="rs-muted">Answers from your documents, notes, reports, projects and past research, with citations.</p>
        <form class="rs-ask__form" @submit=${(e: Event) => { e.preventDefault(); void this.askKnowledge(); }}>
          <input class="rs-input" placeholder="e.g. What did we agree with ED-ROM about maintenance?" .value=${a.question} @input=${(e: Event) => (this.ask = { ...this.ask, question: (e.target as HTMLInputElement).value })} />
          <button class="rs-btn rs-btn--primary" type="submit" ?disabled=${busy || a.question.trim().length < 3}>${busy ? html`<span class="rs-spin"></span>` : icons.send}<span class="rs-hide-sm">Ask</span></button>
        </form>
        ${a.status === "idle"
          ? nothing
          : html`
              ${a.status === "searching" ? html`<div class="rs-muted"><span class="rs-spin rs-spin--xs"></span> Searching internal knowledge…</div>` : nothing}
              ${a.answer
                ? html`<div class="rs-md rs-answer">${unsafeHTML(toSanitizedMarkdownHtml(a.answer))}</div>`
                : a.status === "answering"
                  ? html`<div class="rs-skel-lines"><div class="wg-skel"></div><div class="wg-skel" style="width:70%"></div></div>`
                  : nothing}
              ${a.status === "error" ? html`<div class="rs-error" role="alert">${icons.alertCircle} ${a.error}</div>` : nothing}
              ${a.sources.length
                ? html`<div class="rs-label rs-mt">Internal sources</div>
                    <ol class="rs-cites">${a.sources.map((s, i) => html`<li><button class="rs-cite" @click=${() => this.openSource(s)}><span class="rs-cite__n">${i + 1}</span><span class="rs-cite__t">${s.title}</span><span class="rs-cite__k">${s.ref?.type ?? s.kind}</span></button></li>`)}</ol>`
                : a.status !== "searching"
                  ? html`<div class="rs-muted rs-mt">No internal sources matched.</div>`
                  : nothing}
              ${a.memoryNote ? html`<div class="rs-muted rs-small">${a.memoryNote}</div>` : nothing}
              ${a.status === "done" || a.status === "error"
                ? html`<div class="rs-row rs-mt">
                    <button class="rs-btn rs-btn--sm" @click=${() => this.researchFurther()}>${icons.globe} Research this further</button>
                    ${a.answer ? html`<button class="rs-btn rs-btn--sm rs-btn--ghost" @click=${() => void this.askToNote()}>${icons.penLine} Save as note</button>` : nothing}
                  </div>`
                : nothing}
            `}
      </section>
    `;
  }

  private renderProactive(): TemplateResult {
    const topics = suggestTopics(this.projects, this.items);
    const stale = this.items.filter((i) => isStale(i)).slice(0, 4);
    const fresh = newSince(this.items, this.lastVisit).slice(0, 5);
    return html`
      <section class="wg-surface rs-panel" aria-label="Suggestions">
        <header class="rs-panel__head"><div class="rs-h2">${icons.lightbulb} For you</div></header>
        ${fresh.length
          ? html`<div class="rs-label">New since your last visit</div>
              <ul class="rs-mini">${fresh.map((it) => html`<li><button class="rs-mini__btn" title=${it.title} @click=${() => void this.openDetail(it)}>${icons.sparkles}<span>${it.title}</span><em>${relativeTime(it.updatedAt)}</em></button></li>`)}</ul>`
          : nothing}
        <div class="rs-label rs-mt">Suggested research</div>
        ${this.loading
          ? html`<div class="wg-skel" style="height:44px"></div>`
          : topics.length
            ? html`<ul class="rs-ideas">${topics.map(
                (t) => html`<li class="wg-card rs-idea">
                  <div class="rs-idea__p">${icons.folder} ${t.projectName}<em>${t.reason}</em></div>
                  <div class="rs-idea__q">${t.question}</div>
                  <button class="rs-btn rs-btn--sm" @click=${() => { this.compose = { ...this.compose, question: t.question, projectId: t.projectId, error: "" }; this.scrollToTop(); }}>Use this</button>
                </li>`,
              )}</ul>`
            : html`<div class="rs-muted">Every active project has recent research.</div>`}
        <div class="rs-label rs-mt">Needs a refresh</div>
        ${stale.length
          ? html`<ul class="rs-mini">${stale.map((it) => html`<li><button class="rs-mini__btn" title=${it.title} @click=${() => void this.openDetail(it)}>${icons.clockRotate}<span>${it.title}</span><em>${relativeTime(it.updatedAt)}</em></button></li>`)}</ul>`
          : html`<div class="rs-muted">Nothing older than 30 days.</div>`}
        <div class="rs-label rs-mt">Recurring research</div>
        ${this.schedules.length
          ? html`<ul class="rs-mini">${this.schedules.map(
              (s) => html`<li class="rs-sched" title=${s.name}>${icons.calendar}<span>${s.name.replace(/^Research · /, "")}</span><em>${s.expr === "0 8 * * 1" ? "weekly" : s.expr === "0 8 * * *" ? "daily" : s.expr}</em>
                <button class="rs-icon-btn" aria-label="Remove schedule" @click=${async () => { await this.api?.removeSchedule(s.id).catch(() => undefined); this.schedules = this.schedules.filter((x) => x.id !== s.id); }}>${icons.trash}</button></li>`,
            )}</ul>`
          : html`<div class="rs-muted">Pick “Daily” or “Weekly” under Repeat to keep a topic fresh automatically.</div>`}
      </section>
    `;
  }

  private renderDetail(): TemplateResult {
    const d = this.detail!;
    const item = this.currentItem();
    const p = d.parsed;
    const projectId = item ? this.primaryProjectId(item) : undefined;
    const project = this.projectName(projectId);
    return html`
      <div class="rs-detail">
        <div class="rs-detail__bar">
          <button class="rs-btn rs-btn--ghost rs-btn--sm" @click=${() => this.closeDetail()}>${icons.arrowLeft} Library</button>
          <div class="rs-row rs-wrap">
            ${item?.reportId
              ? html`<button class="rs-btn rs-btn--sm rs-btn--ghost" ?disabled=${d.pdfLoading} @click=${() => void this.openPdf()}>${d.pdfLoading ? html`<span class="rs-spin rs-spin--xs"></span>` : icons.fileText} PDF</button>`
              : item
                ? html`<button class="rs-btn rs-btn--sm" ?disabled=${d.busy.file} @click=${() => void this.ensureReport(item)}>${d.busy.file ? html`<span class="rs-spin rs-spin--xs"></span>` : icons.save} Save to Reports</button>`
                : nothing}
            ${item ? html`<button class="rs-btn rs-btn--sm rs-btn--ghost" @click=${() => this.refreshResearch(item)}>${icons.refresh} Refresh research</button>` : nothing}
            <button class="rs-btn rs-btn--sm rs-btn--ghost" @click=${() => this.app?.setTab?.("knowledge-graph" as never)}>${icons.network} Graph</button>
          </div>
        </div>
        ${d.loading
          ? html`<div class="wg-surface rs-panel"><div class="wg-skel" style="height:22px;width:50%"></div><div class="rs-skel-lines rs-mt"><div class="wg-skel"></div><div class="wg-skel"></div><div class="wg-skel" style="width:70%"></div></div></div>`
          : d.error
            ? html`<div class="wg-surface rs-panel">${this.renderEmpty("Could not open this research", d.error, html`<button class="rs-btn rs-btn--sm" @click=${() => item && void this.openDetail(item)}>Retry</button>`)}</div>`
            : html`
                <header class="wg-surface rs-panel rs-detail__head">
                  <div class="rs-row rs-wrap">
                    <span class="rs-kind rs-kind--${item?.kind ?? "report"}">${item?.kind === "run" ? "Research run" : item?.kind === "doc" ? "Research doc" : "Report"}</span>
                    ${item ? html`<span class="rs-status rs-status--${item.status}">${item.status}</span>` : nothing}
                    ${item?.depth ? html`<span class="rs-tag">${item.depth}</span>` : nothing}
                    ${item?.sourceMode ? html`<span class="rs-tag">${SOURCE_MODES.find((s) => s.id === item.sourceMode)?.label}</span>` : nothing}
                    ${item && isStale(item) ? html`<span class="rs-badge rs-badge--stale">stale</span>` : nothing}
                  </div>
                  <h1 class="wg-title rs-detail__title">${p?.title || item?.title}</h1>
                  ${d.meta?.question || item?.question ? html`<p class="wg-sub">${d.meta?.question || item?.question}</p>` : nothing}
                  <div class="rs-item__meta">
                    <span>${icons.clock} ${item ? relativeTime(item.updatedAt) : ""}</span>
                    ${project && projectId ? html`<button class="rs-linklike" @click=${() => this.openProject(projectId)}>${icons.folder} ${project}</button>` : nothing}
                    ${item?.reportId ? html`<span title=${item.reportId}>${icons.fileText} in Reports</span>` : html`<span>not in Reports yet</span>`}
                  </div>
                  ${item?.reportId
                    ? html`<ib-people-chips style="margin-top:8px" .client=${this.client} objectType="report" objectId=${item.reportId}></ib-people-chips>`
                    : nothing}
                  ${d.meta?.error ? html`<div class="rs-error">${icons.alertCircle} ${d.meta.error}</div>` : nothing}
                </header>
                ${d.pdfUrl
                  ? html`<section class="wg-surface rs-panel rs-pdf">
                      <header class="rs-panel__head"><div class="rs-h2">${icons.fileText} PDF</div>
                        <div class="rs-row"><a class="rs-btn rs-btn--sm rs-btn--ghost" href=${d.pdfUrl} target="_blank" rel="noopener">${icons.externalLink} Open</a>
                        <button class="rs-icon-btn" aria-label="Close PDF" @click=${() => { URL.revokeObjectURL(d.pdfUrl!); this.detail = this.detail && { ...this.detail, pdfUrl: undefined }; }}>${icons.x}</button></div></header>
                      <iframe title="Research PDF" src=${d.pdfUrl}></iframe>
                    </section>`
                  : nothing}
                <div class="rs-detail__grid">
                  <div class="rs-col">
                    ${p?.summary ? html`<section class="wg-surface rs-panel"><div class="rs-h2">Summary</div><div class="rs-md">${unsafeHTML(toSanitizedMarkdownHtml(p.summary))}</div></section>` : nothing}
                    ${this.renderListSection("Key findings", p?.findings ?? [], "f", "Make task")}
                    ${p?.actions.length
                      ? html`<section class="wg-surface rs-panel">
                          <header class="rs-panel__head"><div class="rs-h2">Action items</div>
                            <button class="rs-btn rs-btn--sm" @click=${() => void this.allActionsToTasks()}>${icons.plus} All → tasks</button></header>
                          ${this.renderBullets(p.actions, "a", "Make task")}
                        </section>`
                      : nothing}
                    ${p?.openQuestions.length ? html`<section class="wg-surface rs-panel"><div class="rs-h2">Open questions</div><ul class="rs-bullets">${p.openQuestions.map((q) => html`<li><span class="rs-md rs-md--inline">${unsafeHTML(toSanitizedMarkdownHtml(q))}</span></li>`)}</ul></section>` : nothing}
                    <section class="wg-surface rs-panel">
                      <header class="rs-panel__head"><div class="rs-h2">Sources <span class="rs-count">${p?.sources.length ?? 0}</span></div></header>
                      ${p?.sources.length
                        ? html`<ol class="rs-sources">${p.sources.map(
                            (s) => html`<li>
                              ${s.url
                                ? html`<a href=${s.url} target="_blank" rel="noopener noreferrer">${s.title}</a><span class="rs-muted"> · ${hostOf(s.url)}</span>`
                                : html`<button class="rs-linklike" @click=${() => this.openSource(s)}>${s.title}</button>`}
                              ${s.snippet ? html`<div class="rs-muted rs-small">${singleLine(s.snippet, 200)}</div>` : nothing}
                            </li>`,
                          )}</ol>`
                        : html`<div class="rs-muted">No cited sources in this research.</div>`}
                    </section>
                    <section class="wg-surface rs-panel">
                      <header class="rs-panel__head"><div class="rs-h2">Full report</div>
                        ${d.markitdown ? html`<button class="rs-btn rs-btn--sm rs-btn--ghost" @click=${() => (this.detail = this.detail && { ...this.detail, showMarkitdown: !this.detail.showMarkitdown })}>${d.showMarkitdown ? "Rendered" : "Markitdown copy"}</button>` : nothing}</header>
                      ${d.showMarkitdown && d.markitdown
                        ? html`<pre class="rs-pre">${d.markitdown}</pre>`
                        : d.markdown
                          ? html`<div class="rs-md">${unsafeHTML(toSanitizedMarkdownHtml(d.markdown))}</div>`
                          : html`<div class="rs-muted">No body.</div>`}
                    </section>
                  </div>
                  <div class="rs-col rs-col--side">
                    ${this.renderLinks(item)}
                    <section class="wg-surface rs-panel">
                      <div class="rs-h2">Turn into work</div>
                      <div class="rs-stack rs-mt">
                        <button class="rs-btn" ?disabled=${d.busy.note} @click=${() => void this.saveAsNote()}>${d.busy.note ? html`<span class="rs-spin rs-spin--xs"></span>` : icons.penLine} Save as note</button>
                        <button class="rs-btn" ?disabled=${d.busy.update} @click=${() => void this.postProjectUpdate()}>${d.busy.update ? html`<span class="rs-spin rs-spin--xs"></span>` : icons.folder} Post update to project</button>
                        <button class="rs-btn" ?disabled=${!p?.actions.length} @click=${() => void this.allActionsToTasks()}>${icons.checkCircle} Action items → tasks</button>
                      </div>
                      <p class="rs-muted rs-small rs-mt">Tasks go to ${item && this.primaryProjectId(item) ? `“${this.projectName(this.primaryProjectId(item)) ?? "the linked project"}”` : "the board (no project linked)"} and are linked back to this research.</p>
                    </section>
                  </div>
                </div>
              `}
      </div>
    `;
  }

  private renderListSection(title: string, list: string[], key: string, action: string): TemplateResult | typeof nothing {
    if (!list.length) return nothing;
    return html`<section class="wg-surface rs-panel"><div class="rs-h2">${title}</div>${this.renderBullets(list, key, action)}</section>`;
  }

  private renderBullets(list: string[], key: string, action: string): TemplateResult {
    const d = this.detail!;
    return html`<ul class="rs-bullets">${list.map((f, i) => {
      const bk = `task:${key}${i}`;
      return html`<li>
        <span class="rs-md rs-md--inline">${unsafeHTML(toSanitizedMarkdownHtml(f))}</span>
        <button class="rs-btn rs-btn--xs rs-btn--ghost" title="Create a kanban task from this" ?disabled=${d.busy[bk]} @click=${() => void this.findingToTask(f, `${key}${i}`)}>${d.busy[bk] ? html`<span class="rs-spin rs-spin--xs"></span>` : icons.plus}<span class="rs-hide-sm">${action}</span></button>
      </li>`;
    })}</ul>`;
  }

  private renderLinks(item: ResearchItem | undefined): TemplateResult {
    const d = this.detail!;
    const groups = new Map<LinkTargetType, ResearchLink[]>();
    for (const l of d.links) groups.set(l.type, [...(groups.get(l.type) ?? []), l]);
    return html`
      <section class="wg-surface rs-panel rs-links" aria-label="Links">
        <header class="rs-panel__head">
          <div class="rs-h2">${icons.link} Linked to <span class="rs-count">${d.links.length}</span></div>
          <button class="rs-btn rs-btn--sm" @click=${() => {
            this.detail = this.detail && { ...this.detail, pickerOpen: !d.pickerOpen, pickerQuery: "", pickerResults: [] };
            if (!d.pickerOpen) void this.runPicker("");
          }}>${icons.plus} Link</button>
        </header>
        ${!item?.reportId ? html`<p class="rs-muted rs-small">Links attach to the saved report. Linking saves it to Reports first.</p>` : nothing}
        ${d.pickerOpen
          ? html`<div class="rs-picker">
              <label class="rs-search">${icons.search}<input class="rs-input" autofocus placeholder="Projects, notes, documents, tasks, research…" .value=${d.pickerQuery}
                @input=${(e: Event) => {
                  const q = (e.target as HTMLInputElement).value;
                  this.detail = { ...this.detail!, pickerQuery: q };
                  window.clearTimeout(this.pickerTimer);
                  this.pickerTimer = window.setTimeout(() => void this.runPicker(q), 220);
                }} /></label>
              ${d.pickerLoading ? html`<div class="rs-muted rs-small"><span class="rs-spin rs-spin--xs"></span> Searching…</div>` : nothing}
              <ul class="rs-pick-list">${d.pickerResults.map(
                (c) => html`<li><button class="rs-pick" ?disabled=${d.busy[`link:${targetKey(c)}`]} @click=${() => void this.addLink(c)}>${TYPE_ICON[c.type]}<span class="rs-pick__t"><span>${c.label}</span></span><span class="rs-pick__k">${TYPE_LABEL[c.type]}</span></button></li>`,
              )}</ul>
              ${!d.pickerLoading && !d.pickerResults.length ? html`<div class="rs-muted rs-small">${d.pickerQuery.length < 2 ? "Type to search notes, documents and tasks." : "Nothing found."}</div>` : nothing}
            </div>`
          : nothing}
        ${d.linksLoading
          ? html`<div class="wg-skel" style="height:36px"></div>`
          : d.links.length
            ? html`${[...groups.entries()].map(
                ([type, ls]) => html`<div class="rs-label rs-mt">${TYPE_LABEL[type]}${ls.length > 1 ? "s" : ""}</div>
                  <ul class="rs-linked">${ls.map(
                    (l) => html`<li><button class="rs-linked__open" @click=${() => this.openLink(l)}>${TYPE_ICON[l.type]}<span>${l.label}</span>${l.direction === "in" ? html`<em title="Linked from the other side">↩</em>` : nothing}</button>
                      <button class="rs-icon-btn" aria-label="Unlink ${l.label}" @click=${() => void this.removeLink(l)}>${icons.x}</button></li>`,
                  )}</ul>`,
              )}`
            : html`<div class="rs-muted rs-small rs-mt">Not linked yet. Links show on the project page (Reports + Relations) and as edges in the knowledge graph.</div>`}
        <div class="rs-label rs-mt">Suggested links</div>
        ${d.suggesting
          ? html`<div class="rs-muted rs-small"><span class="rs-spin rs-spin--xs"></span> Finding related projects, notes and tasks…</div>`
          : d.suggestions.length
            ? html`<ul class="rs-suggest">${d.suggestions.map(
                (s) => html`<li><button class="rs-pick" ?disabled=${d.busy[`link:${targetKey(s)}`]} @click=${() => void this.addLink(s)}>${TYPE_ICON[s.type]}<span class="rs-pick__t"><span>${s.label}</span><small>${s.reason}</small></span><span class="rs-pick__k">${icons.plus}</span></button></li>`,
              )}</ul>`
            : html`<div class="rs-muted rs-small">No strong matches.</div>`}
      </section>
    `;
  }
}

/** Rebuild markdown from a stored report payload (title + sections). */
function payloadToMarkdown(report: Record<string, unknown> | null): string {
  const payload = (report?.config as Record<string, unknown> | undefined)?.payload as
    | { title?: string; subtitle?: string; sections?: Array<Record<string, unknown>> }
    | undefined;
  if (!payload?.sections?.length) return "";
  const out: string[] = [`# ${payload.title ?? report?.title ?? ""}`];
  if (payload.subtitle) out.push("", payload.subtitle);
  for (const s of payload.sections) {
    out.push("", `## ${String(s.heading ?? "")}`);
    if (typeof s.body === "string") out.push("", s.body);
    if (Array.isArray(s.bullets)) out.push("", ...s.bullets.map((b) => `- ${String(b)}`));
  }
  return out.join("\n");
}

declare global {
  interface HTMLElementTagNameMap {
    "infinibot-research-workspace": ResearchWorkspace;
  }
}
