/**
 * Design page — full open-design-style workspace.
 *
 * Layout: three columns (project list · chat · preview+files).
 * State stash on AppViewState under `__design`.
 *
 * Per-project flow:
 *   1. New project: discovery form (RULE 1) → save → create project.
 *   2. Existing project: chat box runs through claude_coder, artifacts
 *      land in the workspace, iframe shows index.html.
 *   3. Skill + Design System pickers in a top bar — change anytime.
 */

import { html, nothing, type TemplateResult } from "lit";
import type { AppViewState } from "../app-view-state";
import type { GatewayBrowserClient } from "../gateway";

// ── Types mirroring server ──────────────────────────────────

interface DesignBrief {
  surface: string;
  audience: string;
  tone: string;
  brandContext?: string;
  scale?: string;
  constraints?: string;
  fidelity?: "wireframe" | "polished" | "high-fidelity";
  speakerNotes?: boolean;
  animations?: boolean;
}

interface DesignProject {
  id: string;
  businessId: string;
  name: string;
  kind: "prototype" | "deck" | "doc" | "image" | "custom";
  brief: DesignBrief | null;
  activeSkillId: string | null;
  activeDesignSystemId: string | null;
  modelId: string;
  workspaceDir: string;
  lastActiveAt: number;
  createdAt: number;
  updatedAt: number;
}

interface DesignMessage {
  id: string;
  projectId: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  meta?: Record<string, unknown> | null;
  createdAt: number;
}

interface DesignArtifact {
  id: string;
  projectId: string;
  relativePath: string;
  name: string;
  kind: string;
  size: number;
  mime: string;
  isPreview: boolean;
  createdAt: number;
  updatedAt: number;
}

interface DesignSkill {
  id: string;
  name: string;
  description: string;
  od: {
    mode?: string;
    platform?: string;
    scenario?: string;
    featured?: boolean;
    fidelity?: string;
    designSystemRequires?: boolean;
  };
}

interface DesignSystem {
  id: string;
  name: string;
  description: string;
  tokens: { primary?: string; accent?: string; fontFamily?: string; background?: string };
}

interface ProjectRuntime {
  mode: "idle" | "running" | "error";
  runId: string | null;
  startedAt: number | null;
  lastError: string | null;
}

// ── UI state ──────────────────────────────────────────────

interface DesignUIState {
  projects: DesignProject[];
  skills: DesignSkill[];
  systems: DesignSystem[];
  currentProjectId: string | null;
  messages: Record<string, DesignMessage[]>;     // by projectId
  artifacts: Record<string, DesignArtifact[]>;
  runtime: Record<string, ProjectRuntime>;
  composer: string;
  showNewProjectModal: boolean;
  /** "create" = fresh workspace under ~/.infinibot. "load" = adopt an existing folder. */
  newProjectMode: "create" | "load";
  /** Path the user pasted / picked when in "load" mode. */
  newProjectFolder: string;
  /** Async state for the "✨ Auto-fill from folder" button. */
  autoFilling: boolean;
  autoFillError: string | null;
  /** AI-detected summary + tokens — shown as a card under the folder input. */
  autoFillResult: {
    summary: string;
    detectedColors: string[];
    detectedFonts: string[];
    scannedFiles: string[];
  } | null;
  /** In-modal folder navigator state (browser fallback when no Electron picker). */
  folderPicker: {
    open: boolean;
    loading: boolean;
    error: string | null;
    path: string;
    parent: string;
    atRoot: boolean;
    home: string;
    breadcrumb: Array<{ label: string; path: string }>;
    entries: Array<{ name: string; path: string; hidden: boolean }>;
    showHidden: boolean;
  };
  newProjectName: string;
  newProjectKind: DesignProject["kind"];
  newProjectBrief: DesignBrief;
  newProjectSkillId: string;
  newProjectSystemId: string;
  newProjectModelId: string;
  loaded: boolean;
  loading: boolean;
  sending: boolean;
  pollHandle: number | null;
}

function getDesignUI(state: AppViewState): DesignUIState {
  const s = state as unknown as { __design?: DesignUIState };
  if (!s.__design) {
    s.__design = {
      projects: [],
      skills: [],
      systems: [],
      currentProjectId: null,
      messages: {},
      artifacts: {},
      runtime: {},
      composer: "",
      showNewProjectModal: false,
      newProjectMode: "create",
      newProjectFolder: "",
      autoFilling: false,
      autoFillError: null,
      autoFillResult: null,
      folderPicker: {
        open: false,
        loading: false,
        error: null,
        path: "",
        parent: "",
        atRoot: false,
        home: "",
        breadcrumb: [],
        entries: [],
        showHidden: false,
      },
      newProjectName: "",
      newProjectKind: "prototype",
      newProjectBrief: { surface: "", audience: "", tone: "" },
      newProjectSkillId: "",
      newProjectSystemId: "",
      newProjectModelId: "anthropic:claude-sonnet-4-6",
      loaded: false,
      loading: false,
      sending: false,
      pollHandle: null,
    };
  }
  return s.__design!;
}

// ── Async loaders ────────────────────────────────────────

async function loadAll(state: AppViewState, client: GatewayBrowserClient): Promise<void> {
  const ui = getDesignUI(state);
  if (ui.loaded || ui.loading) return;
  ui.loading = true;
  try {
    // The design view is reachable directly from the URL (e.g. /design)
    // without first visiting /business, so the businessState may not be
    // hydrated yet. Lazy-load businesses once before we ask for project
    // lists — same controller the Business tab uses, idempotent + cheap.
    if (!state.businessState?.businesses?.length) {
      try {
        const { loadBusiness } = await import("../controllers/business.js");
        await loadBusiness(state, client);
      } catch (err) {
        console.warn("[design] loadBusiness failed:", err);
      }
    }
    // Forward an explicit businessId — if the user hasn't set one as
    // "active" in business.json yet, fall back to the first profile.
    // Keeps the project list working even before the user picks an
    // active business in the Business tab.
    const businessId =
      state.businessState?.activeBusinessId ??
      state.businessState?.businesses?.[0]?.id ??
      undefined;
    const [pl, sk, ds] = await Promise.all([
      client.request("design.projects.list", { businessId }) as Promise<{ projects: DesignProject[] }>,
      client.request("design.skills.list", {}) as Promise<{ skills: DesignSkill[] }>,
      client.request("design.designsystems.list", {}) as Promise<{ systems: DesignSystem[] }>,
    ]);
    ui.projects = pl.projects ?? [];
    ui.skills = sk.skills ?? [];
    ui.systems = ds.systems ?? [];
    ui.loaded = true;
    if (!ui.currentProjectId && ui.projects.length > 0) {
      openProject(state, client, ui.projects[0].id);
    } else {
      state.requestUpdate?.();
    }
  } catch (err) {
    console.error("[design] load failed:", err);
  } finally {
    ui.loading = false;
    state.requestUpdate?.();
  }
}

async function refreshProjects(state: AppViewState, client: GatewayBrowserClient): Promise<void> {
  const businessId =
    state.businessState?.activeBusinessId ??
    state.businessState?.businesses?.[0]?.id ??
    undefined;
  const res = (await client.request("design.projects.list", { businessId })) as { projects: DesignProject[] };
  const ui = getDesignUI(state);
  ui.projects = res.projects ?? [];
  state.requestUpdate?.();
}

async function refreshMessages(state: AppViewState, client: GatewayBrowserClient, projectId: string): Promise<void> {
  const res = (await client.request("design.messages.list", { projectId })) as { messages: DesignMessage[] };
  const ui = getDesignUI(state);
  ui.messages[projectId] = res.messages ?? [];
  state.requestUpdate?.();
}

async function refreshArtifacts(state: AppViewState, client: GatewayBrowserClient, projectId: string): Promise<void> {
  const res = (await client.request("design.artifacts.list", { projectId })) as { artifacts: DesignArtifact[] };
  const ui = getDesignUI(state);
  ui.artifacts[projectId] = res.artifacts ?? [];
  state.requestUpdate?.();
}

async function refreshRuntime(state: AppViewState, client: GatewayBrowserClient, projectId: string): Promise<void> {
  const res = (await client.request("design.runtime.get", { id: projectId })) as { runtime: ProjectRuntime };
  const ui = getDesignUI(state);
  ui.runtime[projectId] = res.runtime;
  state.requestUpdate?.();
}

function openProject(state: AppViewState, client: GatewayBrowserClient, projectId: string): void {
  const ui = getDesignUI(state);
  ui.currentProjectId = projectId;
  void refreshMessages(state, client, projectId);
  void refreshArtifacts(state, client, projectId);
  void refreshRuntime(state, client, projectId);
  startPolling(state, client);
}

function startPolling(state: AppViewState, client: GatewayBrowserClient): void {
  const ui = getDesignUI(state);
  if (ui.pollHandle != null) return;
  const tick = async () => {
    const projectId = getDesignUI(state).currentProjectId;
    if (!projectId) return;
    const rt = ui.runtime[projectId];
    if (rt && rt.mode === "running") {
      await Promise.all([
        refreshMessages(state, client, projectId),
        refreshArtifacts(state, client, projectId),
        refreshRuntime(state, client, projectId),
      ]);
    } else {
      await refreshRuntime(state, client, projectId);
    }
  };
  ui.pollHandle = window.setInterval(() => void tick(), 2500);
}

// ── Top-level render ─────────────────────────────────────

export function renderDesign(state: AppViewState, client: GatewayBrowserClient): TemplateResult {
  const ui = getDesignUI(state);
  if (!ui.loaded && !ui.loading) {
    void loadAll(state, client);
  }
  return html`
    ${designStyles()}
    <div class="des-page">
      <aside class="des-sidebar">
        <div class="des-sidebar-head">
          <h2>Designs</h2>
          <button class="des-btn des-btn--primary" @click=${() => openNewProjectModal(state)}>+ New</button>
        </div>
        ${ui.loading && ui.projects.length === 0
          ? html`<div class="des-empty">Loading…</div>`
          : ui.projects.length === 0
          ? html`<div class="des-empty">No designs yet. Click <strong>+ New</strong> to start.</div>`
          : html`<div class="des-project-list">${ui.projects.map((p) => renderProjectListItem(state, client, p))}</div>`}
      </aside>
      ${ui.currentProjectId ? renderProjectView(state, client) : renderProjectEmpty(state)}
      ${ui.showNewProjectModal ? renderNewProjectModal(state, client) : nothing}
    </div>
  `;
}

function renderProjectListItem(state: AppViewState, client: GatewayBrowserClient, p: DesignProject): TemplateResult {
  const ui = getDesignUI(state);
  const isActive = ui.currentProjectId === p.id;
  const rt = ui.runtime[p.id];
  const skillName = p.activeSkillId ? ui.skills.find((s) => s.id === p.activeSkillId)?.name ?? p.activeSkillId : "";
  return html`
    <button class="des-project-item ${isActive ? "is-active" : ""}" @click=${() => openProject(state, client, p.id)}>
      <div class="des-project-item__row">
        <strong>${p.name || "Untitled"}</strong>
        ${rt?.mode === "running" ? html`<span class="des-pulse"></span>` : nothing}
      </div>
      <div class="des-project-item__meta">
        <span class="des-chip">${p.kind}</span>
        ${skillName ? html`<span class="des-chip des-chip--muted">${skillName}</span>` : nothing}
        <span class="des-project-item__time">${new Date(p.lastActiveAt).toLocaleString()}</span>
      </div>
    </button>
  `;
}

function renderProjectEmpty(state: AppViewState): TemplateResult {
  const ui = getDesignUI(state);
  const featured = ui.skills.filter((s) => s.od.featured).slice(0, 6);
  return html`
    <main class="des-main des-main--empty">
      <div class="des-hero">
        <div class="des-hero__kicker">Design</div>
        <h1 class="des-hero__title">Design with the agent on your laptop.</h1>
        <p class="des-hero__lede">
          Pick a skill, a design system, and write a brief. Claude Coder generates a single-file HTML draft into a per-project
          workspace and renders it live below. Iterate in chat — refinements land back in <code>index.html</code>.
        </p>
        <div class="des-hero__actions">
          <button class="des-btn des-btn--primary des-btn--lg" @click=${() => openNewProjectModal(state)}>✦ Start a new design →</button>
          <span class="des-hero__or">or pick a featured skill to start from</span>
        </div>
        ${featured.length > 0 ? html`
          <div class="des-hero__skills">
            ${featured.map((s) => html`
              <button class="des-hero-skill" @click=${() => openNewProjectModalWithSkill(state, s.id)}>
                <div class="des-hero-skill__head">
                  <strong>${s.name}</strong>
                  <span class="des-star">★</span>
                </div>
                <div class="des-hero-skill__meta">
                  ${s.od.mode ? html`<span class="des-tag">${s.od.mode}</span>` : nothing}
                  ${s.od.scenario ? html`<span class="des-tag des-tag--muted">${s.od.scenario}</span>` : nothing}
                </div>
                <p class="des-hero-skill__desc">${truncate(s.description, 120)}</p>
              </button>
            `)}
          </div>
        ` : nothing}
      </div>
    </main>
  `;
}

function openNewProjectModalWithSkill(state: AppViewState, skillId: string): void {
  openNewProjectModal(state);
  const ui = getDesignUI(state);
  ui.newProjectSkillId = skillId;
  state.requestUpdate?.();
}

function renderProjectView(state: AppViewState, client: GatewayBrowserClient): TemplateResult {
  const ui = getDesignUI(state);
  const project = ui.projects.find((p) => p.id === ui.currentProjectId)!;
  if (!project) return html`<main class="des-main"><div class="des-empty">Project not found</div></main>`;
  const messages = ui.messages[project.id] ?? [];
  const artifacts = ui.artifacts[project.id] ?? [];
  const runtime = ui.runtime[project.id];
  const previewArtifact = artifacts.find((a) => a.isPreview) || artifacts.find((a) => a.relativePath === "index.html");
  return html`
    <main class="des-main">
      ${renderProjectToolbar(state, client, project, runtime)}
      <section class="des-workshop">
        <div class="des-chat-col">
          <div class="des-chat-log">
            ${messages.length === 0
              ? html`<div class="des-empty">No turns yet. Send a brief or fill the discovery form above.</div>`
              : messages.map((m) => renderMessage(m))}
            ${runtime?.mode === "running"
              ? html`<div class="des-msg des-msg--running">⏳ Agent is working — claude_coder run <code>${runtime.runId ?? ""}</code></div>`
              : nothing}
            ${runtime?.mode === "error"
              ? html`<div class="des-msg des-msg--error">⚠ ${runtime.lastError}</div>`
              : nothing}
          </div>
          <div class="des-composer">
            <textarea
              class="des-input des-input--composer"
              placeholder="Tell the agent what to do next…"
              .value=${ui.composer}
              @input=${(e: Event) => { ui.composer = (e.target as HTMLTextAreaElement).value; }}
              @keydown=${(e: KeyboardEvent) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void sendMessage(state, client);
                }
              }}
            ></textarea>
            <div class="des-composer-bar">
              <span class="des-help">⌘/Ctrl + Enter to send</span>
              <button
                class="des-btn des-btn--primary"
                ?disabled=${ui.sending || runtime?.mode === "running" || !ui.composer.trim()}
                @click=${() => void sendMessage(state, client)}
              >${ui.sending || runtime?.mode === "running" ? "Working…" : "Send"}</button>
            </div>
          </div>
        </div>
        <div class="des-preview-col">
          ${renderPreviewPane(project, previewArtifact)}
          ${renderArtifactsList(state, client, project, artifacts)}
        </div>
      </section>
    </main>
  `;
}

function renderProjectToolbar(state: AppViewState, client: GatewayBrowserClient, project: DesignProject, runtime?: ProjectRuntime): TemplateResult {
  const ui = getDesignUI(state);
  return html`
    <header class="des-toolbar">
      <div class="des-toolbar__title">
        <h2>${project.name}</h2>
        <span class="des-chip">${project.kind}</span>
        ${runtime?.mode === "running" ? html`<span class="des-chip des-chip--ok">running</span>` : nothing}
        ${runtime?.mode === "error" ? html`<span class="des-chip des-chip--err">error</span>` : nothing}
      </div>
      <div class="des-toolbar__controls">
        <label class="des-control">
          <span>Skill</span>
          <select class="des-input" .value=${project.activeSkillId ?? ""} @change=${(e: Event) => void updateProject(state, client, project.id, { activeSkillId: (e.target as HTMLSelectElement).value || null })}>
            <option value="">— none —</option>
            ${ui.skills.map((s) => html`<option value=${s.id}>${s.name}${s.od.featured ? " ★" : ""}</option>`)}
          </select>
        </label>
        <label class="des-control">
          <span>Design system</span>
          <select class="des-input" .value=${project.activeDesignSystemId ?? ""} @change=${(e: Event) => void updateProject(state, client, project.id, { activeDesignSystemId: (e.target as HTMLSelectElement).value || null })}>
            <option value="">— none —</option>
            ${ui.systems.map((s) => html`<option value=${s.id}>${s.name}</option>`)}
          </select>
        </label>
        <label class="des-control">
          <span>Model</span>
          <select class="des-input" .value=${project.modelId} @change=${(e: Event) => void updateProject(state, client, project.id, { modelId: (e.target as HTMLSelectElement).value })}>
            <option value="anthropic:claude-opus-4-7">Claude Opus 4.7</option>
            <option value="anthropic:claude-sonnet-4-6">Claude Sonnet 4.6</option>
            <option value="anthropic:claude-haiku-4-5">Claude Haiku 4.5</option>
          </select>
        </label>
        <button class="des-btn" title="Rescan workspace files" @click=${() => void rescanNow(state, client, project.id)}>↻ Rescan</button>
        <button class="des-btn" title="Rename this project" @click=${() => void renameProject(state, client, project.id)}>✎ Rename</button>
        <button class="des-btn" title="Duplicate as a new project" @click=${() => void duplicateProject(state, client, project.id)}>⎘ Duplicate</button>
        <button class="des-btn des-btn--danger-ghost" title="Delete this project (workspace folder is left on disk)" @click=${() => void deleteProject(state, client, project.id)}>Delete</button>
      </div>
    </header>
  `;
}

async function renameProject(state: AppViewState, client: GatewayBrowserClient, id: string): Promise<void> {
  const ui = getDesignUI(state);
  const current = ui.projects.find((p) => p.id === id);
  const next = prompt("New project name?", current?.name ?? "");
  if (!next || next.trim() === current?.name) return;
  await client.request("design.projects.update", { id, name: next.trim() });
  await refreshProjects(state, client);
}

async function duplicateProject(state: AppViewState, client: GatewayBrowserClient, id: string): Promise<void> {
  const ui = getDesignUI(state);
  const src = ui.projects.find((p) => p.id === id);
  if (!src) return;
  const newName = prompt("Name for the duplicate?", `${src.name} (copy)`);
  if (!newName) return;
  try {
    const res = (await client.request("design.projects.create", {
      // Reuse the source project's business id so duplicate lands in
      // the same workspace — even if the UI's activeBusinessId drifted.
      businessId: src.businessId,
      name: newName.trim(),
      kind: src.kind,
      brief: src.brief,
      activeSkillId: src.activeSkillId,
      activeDesignSystemId: src.activeDesignSystemId,
      modelId: src.modelId,
    })) as { project: DesignProject };
    await refreshProjects(state, client);
    openProject(state, client, res.project.id);
  } catch (err) {
    alert(`Duplicate failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function renderMessage(m: DesignMessage): TemplateResult {
  return html`
    <div class="des-msg des-msg--${m.role}">
      <div class="des-msg__head"><strong>${m.role}</strong><span class="des-msg__time">${new Date(m.createdAt).toLocaleString()}</span></div>
      <pre class="des-msg__body">${m.content}</pre>
    </div>
  `;
}

function renderPreviewPane(project: DesignProject, artifact: DesignArtifact | undefined): TemplateResult {
  if (!artifact) {
    return html`
      <div class="des-preview-frame">
        ${browserChrome(`${project.id}`, "no-preview", () => {})}
        <div class="des-preview des-preview--empty">
          <div class="des-empty-art">▢</div>
          <h3>Nothing rendered yet</h3>
          <p>The agent's first <code>index.html</code> will appear here. Send a brief from the chat below to kick it off.</p>
        </div>
      </div>`;
  }
  const url = `/api/design/preview/${project.id}/${encodeURI(artifact.relativePath)}`;
  let body: TemplateResult;
  if (artifact.kind === "image") {
    body = html`<img src=${url} alt=${artifact.name} />`;
  } else if (artifact.kind === "pdf") {
    body = html`<embed src=${url} type="application/pdf" />`;
  } else {
    body = html`<iframe
      title="design preview"
      src=${url}
      sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
    ></iframe>`;
  }
  return html`
    <div class="des-preview-frame">
      ${browserChrome(project.id, artifact.relativePath, () => {})}
      <div class="des-preview">${body}</div>
    </div>
  `;
}

function browserChrome(projectId: string, currentPath: string, _onReload: () => void): TemplateResult {
  return html`
    <div class="des-chrome">
      <div class="des-chrome__lights">
        <span class="des-chrome__light des-chrome__light--red"></span>
        <span class="des-chrome__light des-chrome__light--yellow"></span>
        <span class="des-chrome__light des-chrome__light--green"></span>
      </div>
      <div class="des-chrome__url">${currentPath === "no-preview" ? "—" : currentPath}</div>
      <button class="des-chrome__action" title="Open in new tab"
        @click=${() => {
          if (currentPath === "no-preview") return;
          window.open(`/api/design/preview/${projectId}/${encodeURI(currentPath)}`, "_blank", "noopener");
        }}>↗</button>
    </div>
  `;
}

function renderArtifactsList(state: AppViewState, client: GatewayBrowserClient, project: DesignProject, artifacts: DesignArtifact[]): TemplateResult {
  return html`
    <div class="des-files">
      <header class="des-files__head">
        <h3>Files <span class="des-files__count">${artifacts.length}</span></h3>
      </header>
      <div class="des-files__list">
        ${artifacts.length === 0
          ? html`<div class="des-empty des-empty--sm">No files yet. The agent's outputs land here.</div>`
          : artifacts.map((a) => html`
            <div class="des-file-row ${a.isPreview ? "is-preview" : ""}">
              <span class="des-file-row__icon">${iconForKind(a.kind)}</span>
              <div class="des-file-row__main">
                <div class="des-file-row__name" title=${a.relativePath}>${a.name}</div>
                <div class="des-file-row__path">${a.relativePath !== a.name ? a.relativePath : ""}</div>
              </div>
              <span class="des-file-row__size">${formatBytes(a.size)}</span>
              <div class="des-file-row__actions">
                <a class="des-icon-action" title="Open in new tab" href=${`/api/design/preview/${project.id}/${encodeURI(a.relativePath)}`} target="_blank" rel="noopener">↗</a>
                ${a.isPreview ? html`<span class="des-chip des-chip--ok">preview</span>` :
                  html`<button class="des-icon-action" title="Set as preview" @click=${() => void setPreview(state, client, project.id, a.id)}>◉</button>`}
              </div>
            </div>
          `)}
      </div>
    </div>
  `;
}

function iconForKind(kind: string): string {
  switch (kind) {
    case "html": return "🌐";
    case "css": return "🎨";
    case "js": return "⚡";
    case "json": return "{ }";
    case "md": return "📝";
    case "image": return "🖼";
    case "pdf": return "📑";
    case "zip": return "📦";
    case "pptx": return "🪟";
    default: return "📄";
  }
}

// ── New project modal ───────────────────────────────────

function renderNewProjectModal(state: AppViewState, client: GatewayBrowserClient): TemplateResult {
  const ui = getDesignUI(state);
  const isLoad = ui.newProjectMode === "load";
  const valid = isLoad
    ? Boolean(ui.newProjectName.trim() && ui.newProjectFolder.trim())
    : Boolean(ui.newProjectName.trim() && ui.newProjectBrief.surface.trim());
  return html`
    <div class="des-modal-backdrop" @click=${() => closeNewProjectModal(state)}>
      <div class="des-modal" @click=${(e: Event) => e.stopPropagation()}>
        <header class="des-modal__head">
          <div>
            <div class="des-modal__kicker">New project</div>
            <h2 class="des-modal__title">${isLoad ? "Adopt an existing folder" : "Start a fresh design"}</h2>
          </div>
          <button class="des-icon-btn" @click=${() => closeNewProjectModal(state)} title="Close">✕</button>
        </header>
        <div class="des-modal__body">

          <!-- Mode toggle -->
          <div class="des-segmented">
            <button
              class="des-segmented__btn ${ui.newProjectMode === "create" ? "is-active" : ""}"
              @click=${() => { ui.newProjectMode = "create"; state.requestUpdate?.(); }}
            >
              <span class="des-segmented__icon">✦</span>
              <span class="des-segmented__label">Create fresh</span>
              <span class="des-segmented__sub">workspace under ~/.infinibot</span>
            </button>
            <button
              class="des-segmented__btn ${ui.newProjectMode === "load" ? "is-active" : ""}"
              @click=${() => { ui.newProjectMode = "load"; state.requestUpdate?.(); }}
            >
              <span class="des-segmented__icon">📁</span>
              <span class="des-segmented__label">Load folder</span>
              <span class="des-segmented__sub">adopt a directory on disk</span>
            </button>
          </div>

          <!-- Section 1: Basics -->
          ${section("01", "Basics", "Name it. We'll use that everywhere.", html`
            <div class="des-modern-grid">
              <div class="des-field des-field--full">
                ${field({
                  label: "Project name",
                  required: true,
                  child: html`<input
                    class="des-modern-input"
                    .value=${ui.newProjectName}
                    @input=${(e: Event) => { ui.newProjectName = (e.target as HTMLInputElement).value; state.requestUpdate?.(); }}
                    placeholder="Tech-blog landing"
                    autocomplete="off"
                  />`,
                })}
              </div>
              <div class="des-field">
                ${field({
                  label: "Kind",
                  child: kindPicker(ui.newProjectKind, (k) => { ui.newProjectKind = k; state.requestUpdate?.(); }),
                })}
              </div>
              <div class="des-field">
                ${field({
                  label: "Fidelity",
                  child: fidelityPicker(ui.newProjectBrief.fidelity ?? "polished", (f) => { ui.newProjectBrief.fidelity = f; state.requestUpdate?.(); }),
                })}
              </div>
            </div>
          `)}

          <!-- Section 2: Folder (load mode only) -->
          ${isLoad ? section("02", "Folder", "Claude Coder spawns in this directory.", renderLoadFolderSection(state, client)) : nothing}
          ${ui.folderPicker.open ? renderFolderPickerDialog(state, client) : nothing}

          <!-- Section 3: Brief -->
          ${section(isLoad ? "03" : "02", "Brief", isLoad ? "Optional — fill in what you want the agent to focus on." : "Required — answer these so the agent doesn't open with a question form.", html`
            <div class="des-modern-grid">
              <div class="des-field des-field--full">
                ${field({
                  label: "Surface",
                  required: !isLoad,
                  helper: "What format / surface are we designing for?",
                  child: html`<input
                    class="des-modern-input"
                    .value=${ui.newProjectBrief.surface}
                    @input=${(e: Event) => { ui.newProjectBrief.surface = (e.target as HTMLInputElement).value; state.requestUpdate?.(); }}
                    placeholder="Landing page · 3-card carousel · 10-slide deck"
                  />`,
                })}
              </div>
              <div class="des-field">
                ${field({
                  label: "Audience",
                  child: html`<input
                    class="des-modern-input"
                    .value=${ui.newProjectBrief.audience}
                    @input=${(e: Event) => { ui.newProjectBrief.audience = (e.target as HTMLInputElement).value; state.requestUpdate?.(); }}
                    placeholder="Series-A founders · Engineers"
                  />`,
                })}
              </div>
              <div class="des-field">
                ${field({
                  label: "Tone",
                  child: html`<input
                    class="des-modern-input"
                    .value=${ui.newProjectBrief.tone}
                    @input=${(e: Event) => { ui.newProjectBrief.tone = (e.target as HTMLInputElement).value; state.requestUpdate?.(); }}
                    placeholder="Editorial · playful · corporate"
                  />`,
                })}
              </div>
              <div class="des-field des-field--full">
                ${field({
                  label: "Brand context",
                  helper: "Existing assets, inspirations, voice notes the agent should consider.",
                  child: html`<textarea
                    class="des-modern-input des-modern-input--textarea"
                    rows="3"
                    .value=${ui.newProjectBrief.brandContext ?? ""}
                    @input=${(e: Event) => { ui.newProjectBrief.brandContext = (e.target as HTMLTextAreaElement).value; state.requestUpdate?.(); }}
                    placeholder="Our brand is warm minimal. Reference: Notion's marketing site. Avoid stock photography."
                  ></textarea>`,
                })}
              </div>
              <div class="des-field">
                ${field({
                  label: "Scale",
                  helper: "How big is it?",
                  child: html`<input
                    class="des-modern-input"
                    .value=${ui.newProjectBrief.scale ?? ""}
                    @input=${(e: Event) => { ui.newProjectBrief.scale = (e.target as HTMLInputElement).value; state.requestUpdate?.(); }}
                    placeholder="Hero + 3 sections + footer"
                  />`,
                })}
              </div>
              <div class="des-field">
                ${field({
                  label: "Constraints",
                  child: html`<input
                    class="des-modern-input"
                    .value=${ui.newProjectBrief.constraints ?? ""}
                    @input=${(e: Event) => { ui.newProjectBrief.constraints = (e.target as HTMLInputElement).value; state.requestUpdate?.(); }}
                    placeholder="Single HTML file · no JS frameworks"
                  />`,
                })}
              </div>
            </div>
          `)}

          <!-- Section 4: Skill picker (visual cards) -->
          ${section(isLoad ? "04" : "03", "Pick a skill", "Each skill is a SKILL.md folder the agent reads as scripture. Featured ★ skills are the most polished.", html`
            <div class="des-card-grid">
              ${skillCard(state, "", "— No skill —", "Agent picks freely from the brief.", null)}
              ${ui.skills.map((s) => skillCard(state, s.id, s.name, s.description, s))}
            </div>
          `)}

          <!-- Section 5: Design system picker (color swatches) -->
          ${section(isLoad ? "05" : "04", "Pick a design system", "DESIGN.md systems lock in color, typography, motion, and voice. Toggle off to let the agent freestyle.", html`
            <div class="des-card-grid des-card-grid--systems">
              ${systemCard(state, "", "— No system —", "Agent freestyles within the brief.", null)}
              ${ui.systems.map((s) => systemCard(state, s.id, s.name, s.description, s))}
            </div>
          `)}

        </div>
        <footer class="des-modal__foot">
          <button class="des-btn des-btn--ghost" @click=${() => closeNewProjectModal(state)}>Cancel</button>
          <button class="des-btn des-btn--primary" ?disabled=${!valid} @click=${() => void createProject(state, client)}>
            ${isLoad ? "Adopt folder" : "Create + send brief"} →
          </button>
        </footer>
      </div>
    </div>
  `;
}

// ── Small composable helpers ───────────────────────────

function section(num: string, title: string, helper: string, body: TemplateResult): TemplateResult {
  return html`
    <section class="des-section">
      <header class="des-section__head">
        <span class="des-section__num">${num}</span>
        <div>
          <h3 class="des-section__title">${title}</h3>
          <p class="des-section__helper">${helper}</p>
        </div>
      </header>
      <div class="des-section__body">${body}</div>
    </section>
  `;
}

function field(opts: { label: string; required?: boolean; helper?: string; child: TemplateResult }): TemplateResult {
  return html`
    <label class="des-modern-field">
      <span class="des-modern-field__label">
        ${opts.label}${opts.required ? html`<span class="des-modern-field__req">*</span>` : nothing}
      </span>
      ${opts.child}
      ${opts.helper ? html`<span class="des-modern-field__helper">${opts.helper}</span>` : nothing}
    </label>
  `;
}

function kindPicker(value: DesignProject["kind"], onPick: (v: DesignProject["kind"]) => void): TemplateResult {
  const opts: Array<{ id: DesignProject["kind"]; label: string; emoji: string }> = [
    { id: "prototype", label: "Prototype", emoji: "🎨" },
    { id: "deck", label: "Deck", emoji: "🪟" },
    { id: "doc", label: "Doc", emoji: "📄" },
    { id: "image", label: "Image", emoji: "🖼️" },
    { id: "custom", label: "Custom", emoji: "✨" },
  ];
  return html`
    <div class="des-chip-row">
      ${opts.map((o) => html`
        <button class="des-chip-btn ${value === o.id ? "is-active" : ""}" @click=${() => onPick(o.id)}>
          <span class="des-chip-btn__icon">${o.emoji}</span>
          <span class="des-chip-btn__label">${o.label}</span>
        </button>
      `)}
    </div>
  `;
}

function fidelityPicker(value: string, onPick: (v: DesignBrief["fidelity"]) => void): TemplateResult {
  const opts: Array<{ id: NonNullable<DesignBrief["fidelity"]>; label: string }> = [
    { id: "wireframe", label: "Wireframe" },
    { id: "polished", label: "Polished" },
    { id: "high-fidelity", label: "Hi-fi" },
  ];
  return html`
    <div class="des-chip-row">
      ${opts.map((o) => html`
        <button class="des-chip-btn ${value === o.id ? "is-active" : ""}" @click=${() => onPick(o.id)}>
          <span class="des-chip-btn__label">${o.label}</span>
        </button>
      `)}
    </div>
  `;
}

function skillCard(state: AppViewState, id: string, name: string, description: string, skill: DesignSkill | null): TemplateResult {
  const ui = getDesignUI(state);
  const isActive = ui.newProjectSkillId === id;
  return html`
    <button
      class="des-pick-card ${isActive ? "is-active" : ""}"
      @click=${() => { ui.newProjectSkillId = id; state.requestUpdate?.(); }}
    >
      <div class="des-pick-card__head">
        <strong>${name}</strong>
        ${skill?.od.featured ? html`<span class="des-star" title="Featured">★</span>` : nothing}
        ${isActive ? html`<span class="des-pick-card__dot"></span>` : nothing}
      </div>
      ${skill ? html`
        <div class="des-pick-card__meta">
          ${skill.od.mode ? html`<span class="des-tag">${skill.od.mode}</span>` : nothing}
          ${skill.od.platform ? html`<span class="des-tag des-tag--muted">${skill.od.platform}</span>` : nothing}
          ${skill.od.scenario ? html`<span class="des-tag des-tag--muted">${skill.od.scenario}</span>` : nothing}
        </div>
      ` : nothing}
      <p class="des-pick-card__desc">${truncate(description, 140)}</p>
    </button>
  `;
}

function systemCard(state: AppViewState, id: string, name: string, description: string, system: DesignSystem | null): TemplateResult {
  const ui = getDesignUI(state);
  const isActive = ui.newProjectSystemId === id;
  const primary = system?.tokens.primary ?? "#888";
  const accent = system?.tokens.accent ?? "#444";
  const bg = system?.tokens.background ?? "#1a1a1a";
  return html`
    <button
      class="des-pick-card des-pick-card--system ${isActive ? "is-active" : ""}"
      @click=${() => { ui.newProjectSystemId = id; state.requestUpdate?.(); }}
    >
      <div class="des-pick-card__head">
        <strong>${name}</strong>
        ${isActive ? html`<span class="des-pick-card__dot"></span>` : nothing}
      </div>
      ${system ? html`
        <div class="des-swatch-strip" title="Brand palette">
          <span class="des-swatch" style="background:${primary};"></span>
          <span class="des-swatch" style="background:${accent};"></span>
          <span class="des-swatch" style="background:${bg};"></span>
        </div>
      ` : nothing}
      <p class="des-pick-card__desc">${truncate(description, 140)}</p>
    </button>
  `;
}

function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function renderLoadFolderSection(state: AppViewState, client: GatewayBrowserClient): TemplateResult {
  const ui = getDesignUI(state);
  const electronApi = (window as unknown as { electronAPI?: { pickFolder?: (opts?: unknown) => Promise<{ canceled: boolean; path: string | null }> } }).electronAPI;
  const hasNativePicker = typeof electronApi?.pickFolder === "function";
  const canFill = ui.newProjectFolder.trim().length > 0 && !ui.autoFilling;
  // Browse handler: Electron native dialog when available, otherwise open
  // the in-modal navigator. Both end up writing `ui.newProjectFolder`.
  const handleBrowse = async () => {
    if (hasNativePicker) {
      const res = await electronApi!.pickFolder!({ title: "Pick a design folder" });
      if (!res.canceled && res.path) applyFolderPick(state, res.path);
      return;
    }
    void openFolderPicker(state, client);
  };
  return html`
    <div class="des-folder-pick">
      ${field({
        label: "Folder path",
        required: true,
        helper: "Claude Coder spawns here. Existing files (index.html, assets/, …) populate the workspace + iframe preview immediately.",
        child: html`
          <div class="des-folder-pick__row">
            <input
              class="des-modern-input"
              style="font-family: ui-monospace, SFMono-Regular, monospace;"
              placeholder="/absolute/path/to/your/design-folder"
              .value=${ui.newProjectFolder}
              @input=${(e: Event) => {
                ui.newProjectFolder = (e.target as HTMLInputElement).value;
                ui.autoFillResult = null;
                ui.autoFillError = null;
                state.requestUpdate?.();
              }}
            />
            <button class="des-btn" @click=${() => void handleBrowse()}>📁 Browse…</button>
          </div>
        `,
      })}

      <!-- AI fill row -->
      <div class="des-autofill-row">
        <button
          class="des-btn des-btn--primary des-btn--ai"
          ?disabled=${!canFill}
          @click=${() => void runAutoFill(state, client)}
        >
          ${ui.autoFilling
            ? html`<span class="des-spinner"></span> Scanning folder + asking AI…`
            : html`<span>✨</span> Auto-fill from folder`}
        </button>
        <span class="des-autofill-row__help">Scans top files, scrapes colors + fonts, asks the AI to populate the brief and pick a skill + design system that match.</span>
      </div>

      ${ui.autoFillError
        ? html`<div class="des-banner des-banner--err">⚠ ${ui.autoFillError}</div>`
        : nothing}

      ${ui.autoFillResult
        ? renderAutoFillResultCard(state, ui.autoFillResult)
        : nothing}
    </div>
  `;
}

function renderAutoFillResultCard(state: AppViewState, result: NonNullable<DesignUIState["autoFillResult"]>): TemplateResult {
  const ui = getDesignUI(state);
  const skill = ui.skills.find((s) => s.id === ui.newProjectSkillId);
  const system = ui.systems.find((s) => s.id === ui.newProjectSystemId);
  return html`
    <div class="des-autofill-result">
      <div class="des-autofill-result__head">
        <span class="des-autofill-result__badge">AI</span>
        <strong>What the agent found</strong>
      </div>
      <p class="des-autofill-result__summary">${result.summary}</p>
      <div class="des-autofill-result__suggestions">
        <div class="des-autofill-result__suggestion">
          <span class="des-autofill-result__suggestion-label">Suggested skill</span>
          ${skill
            ? html`<span class="des-tag">${skill.name}</span>`
            : html`<span class="des-tag des-tag--muted">none chosen</span>`}
        </div>
        <div class="des-autofill-result__suggestion">
          <span class="des-autofill-result__suggestion-label">Suggested system</span>
          ${system
            ? html`
              <span class="des-tag">${system.name}</span>
              <span class="des-swatch-strip" style="margin-left:6px;">
                ${system.tokens.primary ? html`<span class="des-swatch" style="width:14px;height:14px;background:${system.tokens.primary};"></span>` : nothing}
                ${system.tokens.accent ? html`<span class="des-swatch" style="width:14px;height:14px;background:${system.tokens.accent};"></span>` : nothing}
                ${system.tokens.background ? html`<span class="des-swatch" style="width:14px;height:14px;background:${system.tokens.background};"></span>` : nothing}
              </span>`
            : html`<span class="des-tag des-tag--muted">none chosen</span>`}
        </div>
      </div>
      ${result.detectedColors.length > 0 || result.detectedFonts.length > 0
        ? html`
          <div class="des-autofill-result__tokens">
            ${result.detectedColors.length > 0 ? html`
              <div class="des-autofill-result__token-row">
                <span class="des-autofill-result__token-label">Detected colors:</span>
                ${result.detectedColors.slice(0, 12).map((c) => html`
                  <span class="des-detected-color" title=${c} style="background:${c};"></span>
                `)}
              </div>
            ` : nothing}
            ${result.detectedFonts.length > 0 ? html`
              <div class="des-autofill-result__token-row">
                <span class="des-autofill-result__token-label">Detected fonts:</span>
                ${result.detectedFonts.slice(0, 4).map((f) => html`<span class="des-tag des-tag--muted">${f}</span>`)}
              </div>
            ` : nothing}
          </div>
        `
        : nothing}
      <div class="des-autofill-result__files">
        <span class="des-autofill-result__token-label">Scanned ${result.scannedFiles.length} file${result.scannedFiles.length === 1 ? "" : "s"}:</span>
        ${result.scannedFiles.slice(0, 8).map((f) => html`<code class="des-autofill-result__file">${f}</code>`)}
        ${result.scannedFiles.length > 8 ? html`<span class="des-help">+${result.scannedFiles.length - 8} more</span>` : nothing}
      </div>
    </div>
  `;
}

function renderFolderPickerDialog(state: AppViewState, client: GatewayBrowserClient): TemplateResult {
  const ui = getDesignUI(state);
  const fp = ui.folderPicker;
  return html`
    <div class="des-fp-overlay" @click=${() => closeFolderPicker(state)}>
      <div class="des-fp" @click=${(e: Event) => e.stopPropagation()}>
        <header class="des-fp__head">
          <div>
            <div class="des-modal__kicker">Browse</div>
            <h3 class="des-fp__title">Pick a folder</h3>
          </div>
          <button class="des-icon-btn" @click=${() => closeFolderPicker(state)} title="Close">✕</button>
        </header>

        <div class="des-fp__toolbar">
          <button class="des-icon-btn" title="Up one level" ?disabled=${fp.atRoot} @click=${() => void navigateFolder(state, client, fp.parent)}>↑</button>
          <button class="des-icon-btn" title="Home" @click=${() => void navigateFolder(state, client, fp.home)}>🏠</button>
          <div class="des-fp__breadcrumb">
            ${fp.breadcrumb.map((p, i) => html`
              ${i > 0 ? html`<span class="des-fp__sep">/</span>` : nothing}
              <button class="des-fp__crumb" @click=${() => void navigateFolder(state, client, p.path)}>${p.label || "/"}</button>
            `)}
          </div>
          <label class="des-fp__hidden-toggle">
            <input
              type="checkbox"
              .checked=${fp.showHidden}
              @change=${(e: Event) => {
                fp.showHidden = (e.target as HTMLInputElement).checked;
                void navigateFolder(state, client, fp.path);
              }}
            />
            <span>Show hidden</span>
          </label>
        </div>

        <div class="des-fp__path-edit">
          <input
            class="des-modern-input"
            style="font-family: ui-monospace, SFMono-Regular, monospace;"
            .value=${fp.path}
            placeholder="/path/to/dir"
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === "Enter") {
                const v = (e.target as HTMLInputElement).value.trim();
                void navigateFolder(state, client, v);
              }
            }}
          />
        </div>

        <div class="des-fp__body">
          ${fp.loading
            ? html`<div class="des-empty">Loading…</div>`
            : fp.error
            ? html`<div class="des-banner des-banner--err">⚠ ${fp.error}</div>`
            : fp.entries.length === 0
            ? html`<div class="des-empty">No subdirectories here.</div>`
            : html`
              <ul class="des-fp__list">
                ${fp.entries.map((e) => html`
                  <li>
                    <button class="des-fp__entry ${e.hidden ? "is-hidden" : ""}" @dblclick=${() => void navigateFolder(state, client, e.path)} @click=${() => void navigateFolder(state, client, e.path)}>
                      <span class="des-fp__entry-icon">📁</span>
                      <span class="des-fp__entry-name">${e.name}</span>
                      ${e.hidden ? html`<span class="des-tag des-tag--muted">hidden</span>` : nothing}
                    </button>
                  </li>
                `)}
              </ul>
            `}
        </div>

        <footer class="des-fp__foot">
          <span class="des-fp__current">Current: <code>${fp.path || "—"}</code></span>
          <div style="flex:1;"></div>
          <button class="des-btn des-btn--ghost" @click=${() => closeFolderPicker(state)}>Cancel</button>
          <button class="des-btn des-btn--primary" ?disabled=${!fp.path} @click=${() => {
            applyFolderPick(state, fp.path);
            closeFolderPicker(state);
          }}>Use this folder →</button>
        </footer>
      </div>
    </div>
  `;
}

async function openFolderPicker(state: AppViewState, client: GatewayBrowserClient): Promise<void> {
  const ui = getDesignUI(state);
  ui.folderPicker.open = true;
  ui.folderPicker.error = null;
  state.requestUpdate?.();
  // Start at the current input path if it points somewhere; otherwise home.
  const seed = ui.newProjectFolder.trim() || "";
  await navigateFolder(state, client, seed);
}

function closeFolderPicker(state: AppViewState): void {
  const ui = getDesignUI(state);
  ui.folderPicker.open = false;
  state.requestUpdate?.();
}

async function navigateFolder(state: AppViewState, client: GatewayBrowserClient, path: string): Promise<void> {
  const ui = getDesignUI(state);
  ui.folderPicker.loading = true;
  ui.folderPicker.error = null;
  state.requestUpdate?.();
  try {
    const res = (await client.request("design.fs.listDir", {
      path,
      showHidden: ui.folderPicker.showHidden,
    })) as {
      path: string;
      parent: string;
      atRoot: boolean;
      home: string;
      breadcrumb: Array<{ label: string; path: string }>;
      entries: Array<{ name: string; path: string; hidden: boolean }>;
    };
    ui.folderPicker.path = res.path;
    ui.folderPicker.parent = res.parent;
    ui.folderPicker.atRoot = res.atRoot;
    ui.folderPicker.home = res.home;
    ui.folderPicker.breadcrumb = res.breadcrumb;
    ui.folderPicker.entries = res.entries;
  } catch (err) {
    ui.folderPicker.error = err instanceof Error ? err.message : String(err);
  } finally {
    ui.folderPicker.loading = false;
    state.requestUpdate?.();
  }
}

function applyFolderPick(state: AppViewState, path: string): void {
  const ui = getDesignUI(state);
  ui.newProjectFolder = path;
  ui.autoFillResult = null;
  ui.autoFillError = null;
  if (!ui.newProjectName.trim()) {
    ui.newProjectName = path.split(/[\\/]/).filter(Boolean).pop() ?? "Loaded folder";
  }
  state.requestUpdate?.();
}

async function runAutoFill(state: AppViewState, client: GatewayBrowserClient): Promise<void> {
  const ui = getDesignUI(state);
  if (!ui.newProjectFolder.trim()) return;
  ui.autoFilling = true;
  ui.autoFillError = null;
  ui.autoFillResult = null;
  state.requestUpdate?.();
  try {
    const res = (await client.request("design.autoFill", {
      workspaceDir: ui.newProjectFolder.trim(),
      modelId: ui.newProjectModelId,
    })) as {
      name: string;
      kind: DesignProject["kind"];
      brief: DesignBrief;
      suggestedSkillId: string | null;
      suggestedSystemId: string | null;
      summary: string;
      detectedTokens: { colors: string[]; fonts: string[] };
      scannedFiles: string[];
    };
    // Apply directly into the modal fields — user can still edit before submitting.
    if (res.name && !ui.newProjectName.trim()) ui.newProjectName = res.name;
    ui.newProjectKind = res.kind;
    ui.newProjectBrief = {
      surface: res.brief.surface || ui.newProjectBrief.surface,
      audience: res.brief.audience || ui.newProjectBrief.audience,
      tone: res.brief.tone || ui.newProjectBrief.tone,
      brandContext: res.brief.brandContext || ui.newProjectBrief.brandContext,
      scale: res.brief.scale || ui.newProjectBrief.scale,
      constraints: res.brief.constraints || ui.newProjectBrief.constraints,
      fidelity: res.brief.fidelity || ui.newProjectBrief.fidelity,
    };
    if (res.suggestedSkillId) ui.newProjectSkillId = res.suggestedSkillId;
    if (res.suggestedSystemId) ui.newProjectSystemId = res.suggestedSystemId;
    ui.autoFillResult = {
      summary: res.summary,
      detectedColors: res.detectedTokens.colors,
      detectedFonts: res.detectedTokens.fonts,
      scannedFiles: res.scannedFiles,
    };
  } catch (err) {
    ui.autoFillError = err instanceof Error ? err.message : String(err);
  } finally {
    ui.autoFilling = false;
    state.requestUpdate?.();
  }
}

function openNewProjectModal(state: AppViewState): void {
  const ui = getDesignUI(state);
  ui.showNewProjectModal = true;
  ui.newProjectMode = "create";
  ui.newProjectFolder = "";
  ui.autoFilling = false;
  ui.autoFillError = null;
  ui.autoFillResult = null;
  ui.newProjectName = "";
  ui.newProjectBrief = { surface: "", audience: "", tone: "" };
  ui.newProjectSkillId = ui.skills.find((s) => s.od.featured)?.id ?? ui.skills[0]?.id ?? "";
  ui.newProjectSystemId = ui.systems[0]?.id ?? "";
  state.requestUpdate?.();
}

function closeNewProjectModal(state: AppViewState): void {
  getDesignUI(state).showNewProjectModal = false;
  state.requestUpdate?.();
}

async function createProject(state: AppViewState, client: GatewayBrowserClient): Promise<void> {
  const ui = getDesignUI(state);
  const isLoad = ui.newProjectMode === "load";
  // Forward the active business id explicitly — server falls back to
  // business.json's activeBusinessId, but that's empty until the user
  // picks one in the Business tab. If neither side has it, fail with a
  // clearer "set up a business first" message instead of the generic
  // backend INVALID_REQUEST.
  const businessId =
    state.businessState?.activeBusinessId ??
    state.businessState?.businesses?.[0]?.id ??
    null;
  if (!businessId) {
    alert("No business profile yet. Open the Business tab → create one → set it active, then come back here.");
    return;
  }
  try {
    const reqParams: Record<string, unknown> = {
      businessId,
      name: ui.newProjectName.trim(),
      kind: ui.newProjectKind,
      // In load mode the brief is optional — only send populated fields
      // so the server-side prompt doesn't render empty placeholders.
      brief: isBriefBlank(ui.newProjectBrief) ? null : ui.newProjectBrief,
      activeSkillId: ui.newProjectSkillId || null,
      activeDesignSystemId: ui.newProjectSystemId || null,
      modelId: ui.newProjectModelId,
    };
    if (isLoad) reqParams.workspaceDir = ui.newProjectFolder.trim();
    const res = (await client.request("design.projects.create", reqParams)) as {
      project: DesignProject;
      adoptedExisting?: boolean;
      artifactCount?: number;
    };
    closeNewProjectModal(state);
    await refreshProjects(state, client);
    openProject(state, client, res.project.id);
    // Auto-kick depending on mode.
    if (isLoad) {
      // Adopted an existing folder: tell the agent there's already content
      // and let it audit before doing anything destructive.
      ui.composer =
        `Loaded existing folder for "${res.project.name}" at \`${res.project.workspaceDir}\`. ` +
        `${res.artifactCount ?? 0} files already present.\n\n` +
        `First, audit what's here (read the top-level files, identify the entry point, summarize structure in 3-5 bullets). ` +
        `Don't write anything yet — wait for my next instruction once you've read the lay of the land.`;
    } else if (res.project.brief) {
      const b = res.project.brief;
      ui.composer =
        `Build the first draft for "${res.project.name}". ` +
        `Surface: ${b.surface}. Audience: ${b.audience}. Tone: ${b.tone}.` +
        (b.brandContext ? ` Brand context: ${b.brandContext}.` : "") +
        ` Get a visible draft to index.html quickly so I can iterate.`;
    }
    state.requestUpdate?.();
  } catch (err) {
    alert(`Create failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function isBriefBlank(b: DesignBrief): boolean {
  return !b.surface.trim() && !b.audience.trim() && !b.tone.trim() && !b.brandContext?.trim() && !b.scale?.trim() && !b.constraints?.trim();
}

async function updateProject(
  state: AppViewState,
  client: GatewayBrowserClient,
  id: string,
  patch: Partial<DesignProject>,
): Promise<void> {
  await client.request("design.projects.update", { id, ...patch });
  await refreshProjects(state, client);
}

async function deleteProject(state: AppViewState, client: GatewayBrowserClient, id: string): Promise<void> {
  const ui = getDesignUI(state);
  const project = ui.projects.find((p) => p.id === id);
  if (!confirm(`Delete "${project?.name ?? id}"? The workspace folder is left on disk so you can recover.`)) return;
  await client.request("design.projects.delete", { id });
  if (ui.currentProjectId === id) ui.currentProjectId = null;
  await refreshProjects(state, client);
}

async function sendMessage(state: AppViewState, client: GatewayBrowserClient): Promise<void> {
  const ui = getDesignUI(state);
  const projectId = ui.currentProjectId;
  const content = ui.composer.trim();
  if (!projectId || !content) return;
  ui.sending = true;
  state.requestUpdate?.();
  try {
    await client.request("design.messages.send", { projectId, content });
    ui.composer = "";
    await refreshMessages(state, client, projectId);
    await refreshRuntime(state, client, projectId);
  } catch (err) {
    alert(`Send failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    ui.sending = false;
    state.requestUpdate?.();
  }
}

async function rescanNow(state: AppViewState, client: GatewayBrowserClient, projectId: string): Promise<void> {
  await client.request("design.artifacts.rescan", { projectId });
  await refreshArtifacts(state, client, projectId);
}

async function setPreview(state: AppViewState, client: GatewayBrowserClient, projectId: string, artifactId: string): Promise<void> {
  await client.request("design.artifacts.setPreview", { projectId, artifactId });
  await refreshArtifacts(state, client, projectId);
}

// ── Helpers ──────────────────────────────────────────────

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

// ── Styles ──────────────────────────────────────────────

function designStyles(): TemplateResult {
  return html`<style>
    .des-page { display: grid; grid-template-columns: 280px 1fr; height: 100%; overflow: hidden; color: #ddd; }
    .des-sidebar { border-right: 1px solid rgba(255,255,255,0.06); display: flex; flex-direction: column; }
    .des-sidebar-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; border-bottom: 1px solid rgba(255,255,255,0.06); }
    .des-sidebar-head h2 { margin: 0; font-size: 13px; letter-spacing: 0.1em; text-transform: uppercase; color: #a78bfa; }
    .des-project-list { flex: 1; overflow-y: auto; padding: 6px; display: flex; flex-direction: column; gap: 2px; }
    .des-project-item { width: 100%; text-align: left; padding: 10px 12px; background: transparent; border: 0; border-radius: 6px; color: #ddd; font: inherit; cursor: pointer; }
    .des-project-item:hover { background: rgba(255,255,255,0.04); }
    .des-project-item.is-active { background: rgba(167,139,250,0.12); color: #c4b5fd; }
    .des-project-item__row { display: flex; gap: 8px; align-items: center; font-size: 13px; }
    .des-project-item__meta { display: flex; gap: 6px; align-items: center; margin-top: 4px; font-size: 10px; color: #71717a; flex-wrap: wrap; }
    .des-project-item__time { margin-left: auto; }
    .des-pulse { width: 8px; height: 8px; border-radius: 50%; background: #22c55e; animation: des-pulse 1.4s ease-in-out infinite; }
    @keyframes des-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

    .des-main { display: flex; flex-direction: column; min-width: 0; }
    .des-main--empty { align-items: center; justify-content: center; padding: 40px; }
    .des-empty-card { max-width: 540px; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.06); border-radius: 10px; padding: 28px; }
    .des-empty-card h2 { margin-top: 0; }
    .des-empty-card p { color: #a1a1aa; font-size: 13px; line-height: 1.55; }
    .des-empty-card code { background: rgba(255,255,255,0.05); padding: 1px 6px; border-radius: 3px; font-size: 11px; }

    .des-toolbar { display: flex; align-items: center; gap: 16px; padding: 12px 18px; border-bottom: 1px solid rgba(255,255,255,0.06); flex-wrap: wrap; }
    .des-toolbar__title { display: flex; gap: 8px; align-items: center; }
    .des-toolbar__title h2 { margin: 0; font-size: 16px; }
    .des-toolbar__controls { display: flex; gap: 10px; margin-left: auto; flex-wrap: wrap; align-items: end; }
    .des-control { display: flex; flex-direction: column; gap: 2px; font-size: 10px; color: #71717a; }
    .des-control > span { font-size: 9px; letter-spacing: 0.06em; text-transform: uppercase; }

    .des-workshop { flex: 1; display: grid; grid-template-columns: minmax(360px, 1fr) minmax(420px, 1.2fr); min-height: 0; }
    .des-chat-col { display: flex; flex-direction: column; border-right: 1px solid rgba(255,255,255,0.06); min-height: 0; }
    .des-chat-log { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
    .des-msg { background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05); border-radius: 8px; padding: 10px 12px; }
    .des-msg--user { background: rgba(167,139,250,0.06); border-color: rgba(167,139,250,0.2); }
    .des-msg--assistant { background: rgba(34,211,238,0.04); border-color: rgba(34,211,238,0.18); }
    .des-msg--system { background: rgba(245,158,11,0.06); border-color: rgba(245,158,11,0.2); }
    .des-msg--running { background: rgba(167,139,250,0.04); color: #c4b5fd; font-size: 12px; padding: 8px 12px; }
    .des-msg--error { background: rgba(239,68,68,0.06); border-color: rgba(239,68,68,0.2); color: #f87171; font-size: 12px; }
    .des-msg__head { display: flex; gap: 6px; align-items: center; font-size: 10px; color: #71717a; margin-bottom: 4px; letter-spacing: 0.04em; text-transform: uppercase; }
    .des-msg__time { margin-left: auto; text-transform: none; letter-spacing: 0; }
    .des-msg__body { margin: 0; font-family: inherit; font-size: 12px; line-height: 1.55; color: #d4d4d8; white-space: pre-wrap; word-wrap: break-word; max-height: 360px; overflow-y: auto; }

    .des-composer { border-top: 1px solid rgba(255,255,255,0.06); padding: 12px 16px; display: flex; flex-direction: column; gap: 8px; }
    .des-composer-bar { display: flex; justify-content: space-between; align-items: center; }
    .des-input--composer { min-height: 80px; font-family: inherit; font-size: 13px; line-height: 1.5; }

    .des-preview-col { display: flex; flex-direction: column; min-height: 0; }
    .des-preview { flex: 1; background: #fff; min-height: 320px; }
    .des-preview iframe, .des-preview embed { width: 100%; height: 100%; border: 0; }
    .des-preview img { width: 100%; height: 100%; object-fit: contain; }
    .des-preview--empty { display: flex; align-items: center; justify-content: center; color: #71717a; background: rgba(255,255,255,0.02); font-size: 12px; padding: 24px; text-align: center; }
    .des-preview--empty code { background: rgba(255,255,255,0.05); padding: 1px 6px; border-radius: 3px; font-size: 11px; }

    .des-files { border-top: 1px solid rgba(255,255,255,0.06); max-height: 240px; overflow-y: auto; }
    .des-files__head { padding: 8px 14px; border-bottom: 1px solid rgba(255,255,255,0.04); }
    .des-files__head h3 { margin: 0; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: #a78bfa; }
    .des-file-row { display: flex; gap: 8px; align-items: center; padding: 6px 14px; font-size: 11px; border-bottom: 1px solid rgba(255,255,255,0.02); }
    .des-file-row.is-preview { background: rgba(34,211,238,0.04); }
    .des-file-row__name { flex: 1; font-family: ui-monospace, SFMono-Regular, monospace; color: #d4d4d8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .des-file-row__size { color: #71717a; font-size: 10px; }

    /* ── Modal shell ──────────────────────────────────── */
    .des-modal-backdrop {
      position: fixed; inset: 0;
      background: rgba(0,0,0,0.68);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      display: flex; align-items: center; justify-content: center;
      z-index: 1000;
      padding: 24px;
      animation: des-fade-in .15s ease-out;
    }
    @keyframes des-fade-in { from { opacity: 0; } to { opacity: 1; } }
    .des-modal {
      width: min(860px, 100%);
      max-height: calc(100vh - 48px);
      background:
        radial-gradient(at 0% 0%, rgba(167,139,250,0.08) 0%, transparent 50%),
        radial-gradient(at 100% 100%, rgba(34,211,238,0.06) 0%, transparent 50%),
        #0a0a0d;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 14px;
      display: flex; flex-direction: column; overflow: hidden;
      box-shadow: 0 30px 60px -20px rgba(0,0,0,0.8), 0 0 0 1px rgba(167,139,250,0.04);
      animation: des-slide-up .25s cubic-bezier(0.2, 0.9, 0.3, 1);
    }
    @keyframes des-slide-up { from { transform: translateY(12px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
    .des-modal__head {
      padding: 18px 24px;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      display: flex; justify-content: space-between; align-items: flex-start;
    }
    .des-modal__kicker {
      font-size: 9px; letter-spacing: 0.16em; text-transform: uppercase;
      color: #a78bfa; margin-bottom: 4px; font-weight: 600;
    }
    .des-modal__title { margin: 0; font-size: 20px; line-height: 1.2; color: #fff; font-weight: 600; letter-spacing: -0.01em; }
    .des-icon-btn {
      width: 32px; height: 32px;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 8px;
      color: #a1a1aa;
      cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center;
      transition: background .15s, color .15s, border-color .15s;
    }
    .des-icon-btn:hover { background: rgba(255,255,255,0.08); color: #fff; border-color: rgba(255,255,255,0.16); }

    .des-modal__body { flex: 1; overflow-y: auto; padding: 22px 24px 12px; }
    .des-modal__foot {
      padding: 16px 24px;
      border-top: 1px solid rgba(255,255,255,0.06);
      display: flex; justify-content: flex-end; gap: 10px;
      background: rgba(0,0,0,0.3);
    }

    /* ── Segmented toggle ───────────────────────────── */
    .des-segmented {
      display: grid; grid-template-columns: 1fr 1fr;
      gap: 8px;
      padding: 6px;
      background: rgba(255,255,255,0.02);
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 12px;
      margin-bottom: 24px;
    }
    .des-segmented__btn {
      display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
      padding: 12px 14px;
      background: transparent; border: 1px solid transparent;
      border-radius: 8px;
      color: #a1a1aa;
      font: inherit; cursor: pointer;
      text-align: left;
      transition: all .15s ease;
      position: relative;
    }
    .des-segmented__btn:hover { color: #ddd; background: rgba(255,255,255,0.02); }
    .des-segmented__btn.is-active {
      background: linear-gradient(135deg, rgba(167,139,250,0.18), rgba(34,211,238,0.08));
      color: #fff;
      border-color: rgba(167,139,250,0.32);
      box-shadow: 0 4px 18px -4px rgba(167,139,250,0.4);
    }
    .des-segmented__icon { font-size: 16px; }
    .des-segmented__label { font-size: 13px; font-weight: 600; }
    .des-segmented__sub { font-size: 10px; color: #71717a; letter-spacing: 0.02em; }
    .des-segmented__btn.is-active .des-segmented__sub { color: rgba(255,255,255,0.6); }

    /* ── Sections ───────────────────────────────────── */
    .des-section { margin-bottom: 28px; }
    .des-section__head {
      display: flex; gap: 14px; align-items: flex-start;
      padding-bottom: 10px;
      margin-bottom: 14px;
      border-bottom: 1px dashed rgba(255,255,255,0.06);
    }
    .des-section__num {
      flex: none;
      display: inline-flex; align-items: center; justify-content: center;
      width: 32px; height: 32px;
      background: rgba(167,139,250,0.12);
      border: 1px solid rgba(167,139,250,0.24);
      border-radius: 8px;
      color: #c4b5fd;
      font-size: 11px; font-weight: 700;
      letter-spacing: 0.05em;
      font-feature-settings: "tnum";
    }
    .des-section__title { margin: 0 0 2px; font-size: 14px; color: #fff; font-weight: 600; }
    .des-section__helper { margin: 0; font-size: 12px; color: #71717a; line-height: 1.4; }

    /* ── Modern inputs ──────────────────────────────── */
    .des-modern-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    .des-field { display: flex; flex-direction: column; }
    .des-field--full { grid-column: 1 / -1; }
    .des-modern-field { display: flex; flex-direction: column; gap: 6px; }
    .des-modern-field__label {
      font-size: 11px; font-weight: 600; color: #d4d4d8;
      display: inline-flex; gap: 3px; align-items: center;
      letter-spacing: 0.01em;
    }
    .des-modern-field__req { color: #f87171; font-weight: 700; }
    .des-modern-field__helper { font-size: 10px; color: #71717a; line-height: 1.45; margin-top: 2px; }
    .des-modern-input {
      width: 100%;
      padding: 10px 14px;
      background: rgba(0,0,0,0.4);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 8px;
      color: #fff;
      font: inherit; font-size: 13px;
      transition: border-color .15s, background .15s, box-shadow .15s;
      box-sizing: border-box;
    }
    .des-modern-input::placeholder { color: rgba(255,255,255,0.25); }
    .des-modern-input:hover { border-color: rgba(255,255,255,0.14); background: rgba(0,0,0,0.5); }
    .des-modern-input:focus {
      outline: none;
      border-color: #a78bfa;
      background: rgba(0,0,0,0.55);
      box-shadow: 0 0 0 3px rgba(167,139,250,0.18);
    }
    .des-modern-input--textarea { resize: vertical; min-height: 60px; line-height: 1.55; font-family: inherit; }

    /* ── Chip-style pickers (kind / fidelity) ──────── */
    .des-chip-row { display: flex; gap: 6px; flex-wrap: wrap; }
    .des-chip-btn {
      padding: 8px 12px;
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 999px;
      color: #a1a1aa;
      font: inherit; font-size: 12px;
      cursor: pointer;
      display: inline-flex; gap: 5px; align-items: center;
      transition: all .15s;
    }
    .des-chip-btn:hover { color: #fff; border-color: rgba(255,255,255,0.16); }
    .des-chip-btn.is-active {
      background: rgba(167,139,250,0.18);
      border-color: rgba(167,139,250,0.42);
      color: #fff;
      box-shadow: 0 4px 12px -4px rgba(167,139,250,0.32);
    }
    .des-chip-btn__icon { font-size: 13px; }
    .des-chip-btn__label { font-weight: 500; }

    /* ── Card-grid picker (skills + systems) ───────── */
    .des-card-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: 10px;
    }
    .des-pick-card {
      text-align: left;
      padding: 14px;
      background: rgba(255,255,255,0.02);
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 10px;
      color: #ddd;
      font: inherit;
      cursor: pointer;
      transition: all .18s ease;
      position: relative;
      display: flex; flex-direction: column; gap: 8px;
    }
    .des-pick-card:hover {
      background: rgba(255,255,255,0.04);
      border-color: rgba(255,255,255,0.14);
      transform: translateY(-1px);
    }
    .des-pick-card.is-active {
      background: linear-gradient(135deg, rgba(167,139,250,0.14), rgba(34,211,238,0.05));
      border-color: rgba(167,139,250,0.5);
      box-shadow: 0 8px 20px -8px rgba(167,139,250,0.4);
    }
    .des-pick-card__head {
      display: flex; align-items: center; gap: 8px;
      font-size: 13px;
    }
    .des-pick-card__head strong { color: #fff; font-weight: 600; }
    .des-pick-card__dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: #a78bfa;
      box-shadow: 0 0 8px rgba(167,139,250,0.6);
      margin-left: auto;
    }
    .des-star { color: #fbbf24; font-size: 11px; }
    .des-pick-card__meta { display: flex; gap: 4px; flex-wrap: wrap; }
    .des-pick-card__desc {
      margin: 0;
      font-size: 11px;
      color: #a1a1aa;
      line-height: 1.5;
    }
    .des-tag {
      font-size: 9px;
      padding: 2px 7px;
      border-radius: 999px;
      background: rgba(167,139,250,0.14);
      color: #c4b5fd;
      letter-spacing: 0.04em;
    }
    .des-tag--muted { background: rgba(255,255,255,0.04); color: #71717a; }
    .des-swatch-strip { display: flex; gap: 4px; align-items: center; }
    .des-swatch {
      width: 24px; height: 24px;
      border-radius: 6px;
      border: 1px solid rgba(255,255,255,0.08);
      box-shadow: inset 0 0 0 1px rgba(0,0,0,0.4);
    }

    /* ── Folder pick block ─────────────────────────── */
    .des-folder-pick {
      padding: 0;
      display: flex; flex-direction: column; gap: 14px;
    }
    .des-folder-pick__row { display: flex; gap: 8px; align-items: center; }
    .des-folder-pick__row .des-modern-input { flex: 1; font-family: ui-monospace, SFMono-Regular, monospace; }

    /* ── Auto-fill row + result card ──────────────── */
    .des-autofill-row {
      display: flex; gap: 12px; align-items: center; flex-wrap: wrap;
      padding: 12px 14px;
      background: linear-gradient(135deg, rgba(167,139,250,0.06), rgba(34,211,238,0.04));
      border: 1px solid rgba(167,139,250,0.18);
      border-radius: 10px;
    }
    .des-autofill-row__help { font-size: 11px; color: #a1a1aa; line-height: 1.45; flex: 1; min-width: 200px; }
    .des-btn--ai {
      display: inline-flex; gap: 6px; align-items: center;
      background: linear-gradient(135deg, rgba(167,139,250,0.22), rgba(34,211,238,0.18));
      border-color: rgba(167,139,250,0.4);
      color: #fff;
      font-weight: 600;
      box-shadow: 0 6px 18px -8px rgba(167,139,250,0.5);
    }
    .des-btn--ai:hover:not(:disabled) { background: linear-gradient(135deg, rgba(167,139,250,0.32), rgba(34,211,238,0.24)); border-color: rgba(167,139,250,0.6); }
    .des-spinner {
      display: inline-block;
      width: 12px; height: 12px;
      border: 2px solid rgba(255,255,255,0.2);
      border-top-color: #fff;
      border-radius: 50%;
      animation: des-spin .8s linear infinite;
    }
    @keyframes des-spin { to { transform: rotate(360deg); } }

    .des-autofill-result {
      padding: 14px 16px;
      background: rgba(0,0,0,0.32);
      border: 1px solid rgba(167,139,250,0.24);
      border-radius: 10px;
      display: flex; flex-direction: column; gap: 12px;
      animation: des-slide-up .25s cubic-bezier(0.2, 0.9, 0.3, 1);
    }
    .des-autofill-result__head { display: flex; gap: 8px; align-items: center; font-size: 12px; color: #ddd; }
    .des-autofill-result__badge {
      font-size: 9px; padding: 2px 7px;
      background: linear-gradient(135deg, #a78bfa, #22d3ee);
      color: #0a0a0d;
      border-radius: 4px;
      font-weight: 700;
      letter-spacing: 0.05em;
    }
    .des-autofill-result__summary { margin: 0; font-size: 12px; color: #d4d4d8; line-height: 1.55; font-style: italic; }
    .des-autofill-result__suggestions { display: flex; gap: 18px; flex-wrap: wrap; padding-top: 8px; border-top: 1px dashed rgba(255,255,255,0.06); }
    .des-autofill-result__suggestion { display: flex; align-items: center; gap: 6px; font-size: 11px; }
    .des-autofill-result__suggestion-label { color: #71717a; }
    .des-autofill-result__tokens { display: flex; flex-direction: column; gap: 6px; padding-top: 8px; border-top: 1px dashed rgba(255,255,255,0.06); }
    .des-autofill-result__token-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    .des-autofill-result__token-label { font-size: 10px; color: #71717a; letter-spacing: 0.04em; }
    .des-detected-color {
      width: 18px; height: 18px;
      border-radius: 4px;
      border: 1px solid rgba(255,255,255,0.1);
      cursor: help;
    }
    .des-autofill-result__files { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; padding-top: 8px; border-top: 1px dashed rgba(255,255,255,0.06); }
    .des-autofill-result__file {
      font-size: 10px;
      padding: 2px 6px;
      background: rgba(255,255,255,0.04);
      border-radius: 3px;
      color: #c4b5fd;
      font-family: ui-monospace, SFMono-Regular, monospace;
    }
    .des-banner { padding: 8px 12px; border-radius: 6px; font-size: 11px; }
    .des-banner--err { background: rgba(239,68,68,0.08); color: #f87171; border: 1px solid rgba(239,68,68,0.2); }

    /* ── In-modal folder navigator ────────────────── */
    .des-fp-overlay {
      position: fixed; inset: 0;
      background: rgba(0,0,0,0.5);
      backdrop-filter: blur(4px);
      display: flex; align-items: center; justify-content: center;
      z-index: 1100;
      padding: 24px;
      animation: des-fade-in .15s ease-out;
    }
    .des-fp {
      width: min(680px, 100%);
      max-height: calc(100vh - 48px);
      background:
        radial-gradient(at 0% 0%, rgba(167,139,250,0.08) 0%, transparent 50%),
        #0a0a0d;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 12px;
      display: flex; flex-direction: column; overflow: hidden;
      box-shadow: 0 30px 60px -20px rgba(0,0,0,0.8);
      animation: des-slide-up .2s cubic-bezier(0.2, 0.9, 0.3, 1);
    }
    .des-fp__head {
      padding: 14px 18px;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      display: flex; justify-content: space-between; align-items: flex-start;
    }
    .des-fp__title { margin: 0; font-size: 16px; color: #fff; font-weight: 600; letter-spacing: -0.01em; }
    .des-fp__toolbar {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 14px;
      border-bottom: 1px solid rgba(255,255,255,0.04);
    }
    .des-fp__breadcrumb {
      flex: 1;
      display: flex; align-items: center; gap: 2px;
      overflow-x: auto;
      padding: 2px 4px;
      background: rgba(0,0,0,0.32);
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 6px;
      min-height: 28px;
    }
    .des-fp__breadcrumb::-webkit-scrollbar { height: 4px; }
    .des-fp__crumb {
      padding: 3px 7px;
      background: transparent; border: 0; color: #c4b5fd;
      font: inherit; font-size: 11px;
      font-family: ui-monospace, SFMono-Regular, monospace;
      cursor: pointer;
      border-radius: 3px;
      white-space: nowrap;
    }
    .des-fp__crumb:hover { background: rgba(167,139,250,0.12); color: #fff; }
    .des-fp__sep { color: #52525b; font-size: 10px; padding: 0 1px; }
    .des-fp__hidden-toggle {
      display: inline-flex; gap: 4px; align-items: center;
      font-size: 10px; color: #a1a1aa;
      cursor: pointer;
      padding: 2px 6px;
      border-radius: 4px;
      transition: background .12s;
    }
    .des-fp__hidden-toggle:hover { background: rgba(255,255,255,0.04); }

    .des-fp__path-edit { padding: 10px 14px; border-bottom: 1px solid rgba(255,255,255,0.04); }
    .des-fp__body {
      flex: 1;
      overflow-y: auto;
      padding: 8px 14px;
      max-height: 360px;
      min-height: 200px;
    }
    .des-fp__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
    .des-fp__entry {
      display: flex; align-items: center; gap: 10px;
      width: 100%;
      padding: 8px 10px;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 6px;
      color: #ddd; font: inherit; font-size: 12px;
      cursor: pointer;
      text-align: left;
      transition: background .1s, border-color .1s, color .1s;
    }
    .des-fp__entry:hover { background: rgba(167,139,250,0.08); border-color: rgba(167,139,250,0.18); color: #fff; }
    .des-fp__entry.is-hidden { opacity: 0.55; }
    .des-fp__entry-icon { font-size: 13px; flex: none; }
    .des-fp__entry-name { flex: 1; font-family: ui-monospace, SFMono-Regular, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .des-fp__foot {
      padding: 12px 16px;
      border-top: 1px solid rgba(255,255,255,0.06);
      display: flex; gap: 10px; align-items: center;
      background: rgba(0,0,0,0.3);
    }
    .des-fp__current {
      font-size: 11px;
      color: #a1a1aa;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      flex: 0 1 auto;
      min-width: 0;
    }
    .des-fp__current code {
      background: rgba(255,255,255,0.05);
      padding: 1px 6px;
      border-radius: 3px;
      font-size: 10px;
      color: #c4b5fd;
    }

    .des-grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .des-grid-2__full { grid-column: 1 / -1; }
    .des-block { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: #a1a1aa; }
    .des-input { padding: 7px 10px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; color: #ddd; font: inherit; font-size: 12px; }
    .des-input:focus { outline: none; border-color: #a78bfa; box-shadow: 0 0 0 2px rgba(167,139,250,0.15); }

    .des-btn { padding: 6px 12px; border-radius: 6px; font: inherit; font-size: 11px; cursor: pointer; border: 1px solid rgba(255,255,255,0.08); background: transparent; color: #ddd; }
    .des-btn:hover:not(:disabled) { border-color: #a78bfa; color: #c4b5fd; }
    .des-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .des-btn--primary { background: rgba(167,139,250,0.14); border-color: rgba(167,139,250,0.4); color: #c4b5fd; }
    .des-btn--primary:hover:not(:disabled) { background: rgba(167,139,250,0.22); }
    .des-btn--ghost { background: transparent; }
    .des-btn--danger-ghost { color: #f87171; border-color: rgba(248,113,113,0.2); }
    .des-btn--danger-ghost:hover:not(:disabled) { background: rgba(248,113,113,0.08); }
    .des-btn--xs { padding: 3px 8px; font-size: 10px; }

    .des-chip { font-size: 9px; padding: 2px 7px; border-radius: 999px; background: rgba(255,255,255,0.05); color: #a1a1aa; letter-spacing: 0.04em; }
    .des-chip--ok { background: rgba(34,197,94,0.12); color: #22c55e; }
    .des-chip--err { background: rgba(239,68,68,0.12); color: #f87171; }
    .des-chip--muted { background: rgba(255,255,255,0.03); color: #71717a; }
    .des-empty { padding: 18px; color: #71717a; text-align: center; font-size: 12px; }
    .des-empty--sm { padding: 10px; }
    .des-help { font-size: 11px; color: #71717a; }
    .des-link { color: #a78bfa; text-decoration: none; font-size: 10px; }

    /* ── Hero (empty state) ────────────────────────── */
    .des-hero { max-width: 760px; padding: 40px 32px; }
    .des-hero__kicker { font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; color: #a78bfa; font-weight: 700; margin-bottom: 12px; }
    .des-hero__title { margin: 0 0 14px; font-size: 38px; line-height: 1.1; color: #fff; letter-spacing: -0.02em; font-weight: 600; }
    .des-hero__lede { margin: 0 0 28px; font-size: 15px; line-height: 1.65; color: #a1a1aa; max-width: 560px; }
    .des-hero__lede code { background: rgba(255,255,255,0.05); padding: 1px 6px; border-radius: 3px; font-size: 12px; color: #c4b5fd; }
    .des-hero__actions { display: flex; gap: 18px; align-items: center; margin-bottom: 36px; flex-wrap: wrap; }
    .des-hero__or { font-size: 12px; color: #71717a; }
    .des-btn--lg { padding: 12px 22px; font-size: 14px; border-radius: 10px; }
    .des-hero__skills {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: 12px;
    }
    .des-hero-skill {
      text-align: left;
      padding: 14px 16px;
      background: rgba(255,255,255,0.02);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 10px;
      color: #ddd;
      font: inherit;
      cursor: pointer;
      transition: all .18s ease;
      display: flex; flex-direction: column; gap: 8px;
    }
    .des-hero-skill:hover {
      background: rgba(167,139,250,0.06);
      border-color: rgba(167,139,250,0.32);
      transform: translateY(-2px);
      box-shadow: 0 12px 24px -10px rgba(167,139,250,0.32);
    }
    .des-hero-skill__head { display: flex; align-items: center; gap: 6px; font-size: 14px; }
    .des-hero-skill__head strong { color: #fff; font-weight: 600; }
    .des-hero-skill__meta { display: flex; gap: 4px; flex-wrap: wrap; }
    .des-hero-skill__desc { margin: 0; font-size: 11px; color: #a1a1aa; line-height: 1.55; }

    /* ── Browser-chrome iframe ─────────────────────── */
    .des-preview-frame { flex: 1; display: flex; flex-direction: column; min-height: 320px; background: #fff; }
    .des-chrome {
      display: flex; align-items: center; gap: 10px;
      padding: 8px 12px;
      background: #1f1f24;
      border-bottom: 1px solid rgba(0,0,0,0.3);
      color: #a1a1aa;
      font-size: 11px;
      flex: none;
    }
    .des-chrome__lights { display: flex; gap: 6px; }
    .des-chrome__light { width: 12px; height: 12px; border-radius: 50%; }
    .des-chrome__light--red { background: #ff5f57; }
    .des-chrome__light--yellow { background: #ffbd2e; }
    .des-chrome__light--green { background: #28c941; }
    .des-chrome__url {
      flex: 1;
      padding: 4px 10px;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 6px;
      font-family: ui-monospace, SFMono-Regular, monospace;
      color: #c4b5fd;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .des-chrome__action {
      width: 28px; height: 24px;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 4px;
      color: #ddd;
      cursor: pointer;
      font-size: 12px;
    }
    .des-chrome__action:hover { background: rgba(255,255,255,0.08); }
    .des-preview {
      flex: 1;
      min-height: 320px;
      background: #fff;
    }
    .des-preview iframe, .des-preview embed { width: 100%; height: 100%; border: 0; display: block; }
    .des-preview img { width: 100%; height: 100%; object-fit: contain; display: block; }
    .des-preview--empty {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      color: #71717a; background: rgba(255,255,255,0.02);
      padding: 40px; text-align: center; gap: 8px;
    }
    .des-preview--empty h3 { margin: 0; font-size: 16px; color: #ddd; font-weight: 600; }
    .des-preview--empty p { margin: 0; font-size: 12px; max-width: 360px; line-height: 1.55; }
    .des-empty-art { font-size: 56px; color: rgba(255,255,255,0.16); line-height: 1; margin-bottom: 8px; }

    /* ── Modernized file rows ─────────────────────── */
    .des-files__head { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-bottom: 1px solid rgba(255,255,255,0.04); }
    .des-files__head h3 { margin: 0; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: #a78bfa; }
    .des-files__count { color: #71717a; font-size: 10px; margin-left: 6px; font-weight: 400; }
    .des-file-row {
      display: flex; gap: 10px; align-items: center;
      padding: 8px 14px;
      border-bottom: 1px solid rgba(255,255,255,0.02);
      transition: background .12s;
    }
    .des-file-row:hover { background: rgba(255,255,255,0.02); }
    .des-file-row.is-preview { background: linear-gradient(90deg, rgba(34,211,238,0.06), transparent); }
    .des-file-row__icon { font-size: 14px; flex: none; width: 20px; text-align: center; }
    .des-file-row__main { flex: 1; min-width: 0; }
    .des-file-row__name { font-size: 12px; color: #ddd; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, SFMono-Regular, monospace; }
    .des-file-row__path { font-size: 10px; color: #52525b; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .des-file-row__size { font-size: 10px; color: #71717a; flex: none; min-width: 50px; text-align: right; }
    .des-file-row__actions { display: flex; gap: 4px; align-items: center; flex: none; }
    .des-icon-action {
      width: 24px; height: 24px;
      display: inline-flex; align-items: center; justify-content: center;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 5px;
      color: #a1a1aa;
      cursor: pointer; text-decoration: none;
      font-size: 12px;
      transition: all .12s;
    }
    .des-icon-action:hover { background: rgba(167,139,250,0.12); color: #c4b5fd; border-color: rgba(167,139,250,0.3); }
  </style>`;
}
