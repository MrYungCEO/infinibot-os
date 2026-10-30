/**
 * System Issues / Improvement Log (K.I.S.) view.
 *
 * A Notion-style table of logged system issues + a full-field create/edit
 * modal. Self-contained module state; talks to the gateway `issues.*` RPCs via
 * the shared browser client. Glass G1 styling lives in ./work-glass/issues.css
 * (scoped under `.iss`).
 */

import { html, nothing } from "lit";
import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";
import { icon } from "../icons";
import { wgAurora, wgEmpty, wgHero, wgStat } from "./work-glass";
import "./work-glass/issues.css";

// ── Enums (kept in sync with src/issues/types.ts) ──
const ISSUE_TYPES = [
  "Bug",
  "Broken Function",
  "Automation Failure",
  "Agent Failure",
  "Data Issue",
  "Integration Issue",
  "Workflow Inefficiency",
  "Duplicate Work",
  "UX/Usability Issue",
  "Missing Feature",
  "Performance Issue",
  "Process Problem",
  "Improvement Opportunity",
];
const SEVERITIES = ["low", "medium", "high", "critical"];
const PRIORITIES = ["low", "medium", "high", "critical"];
const STATUSES = ["open", "triaged", "in_progress", "fixed", "verified", "wont_fix"];

const STATUS_LABEL: Record<string, string> = {
  open: "Open",
  triaged: "Triaged",
  in_progress: "In Progress",
  fixed: "Fixed",
  verified: "Verified",
  wont_fix: "Won't Fix",
};

// ── Types ──
interface IssueAttachment {
  id: string;
  issueId: string;
  name: string;
  path: string;
  mimeType: string;
  size: number;
  sha256: string;
  createdAt: number;
}

/** A screenshot staged in the create modal before the issue row exists. */
interface PendingUpload {
  name: string;
  mimeType: string;
  base64: string;
  dataUrl: string;
}

interface Issue {
  id: string;
  title: string;
  issueType: string;
  description: string;
  reportedBy: string;
  dateReported: string;
  relatedObject: string;
  relatedProject: string;
  relatedWorkflow: string;
  projectId?: string;
  frequency: string;
  businessImpact: string;
  timeWasted: string;
  severity: string;
  priority: string;
  temporaryWorkaround: string;
  rootCause: string;
  assignedOwner: string;
  status: string;
  proposedFix: string;
  targetFixDate: string;
  dateFixed: string;
  testedBy: string;
  resolutionNotes: string;
  recurring: boolean;
  automationCandidate: boolean;
  ceoInputRequired: boolean;
  createdAt: number;
  updatedAt: number;
  attachments?: IssueAttachment[];
}

type IssueDraft = Partial<Issue>;

// ── Module state ──
interface IssuesUIState {
  issues: Issue[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
  search: string;
  filterStatus: string;
  filterSeverity: string;
  modalOpen: boolean;
  draft: IssueDraft;
  editingId: string | null;
  saving: boolean;
  /** Attachments of the issue currently open in the modal (edit mode). */
  attachments: IssueAttachment[];
  /** Screenshots staged in create mode, uploaded after the issue is created. */
  pendingUploads: PendingUpload[];
  uploading: boolean;
}

// Lazy image cache: relative files path → object/data URL for <img src>.
const imageCache = new Map<string, string>();
const imageInflight = new Set<string>();

const state: IssuesUIState = {
  issues: [],
  loading: false,
  loaded: false,
  error: null,
  search: "",
  filterStatus: "",
  filterSeverity: "",
  modalOpen: false,
  draft: {},
  editingId: null,
  saving: false,
  attachments: [],
  pendingUploads: [],
  uploading: false,
};

function rerender(app: AppViewState) {
  app.requestUpdate?.();
}

// ── Data ──
async function loadIssues(app: AppViewState, client: GatewayBrowserClient) {
  state.loading = true;
  state.error = null;
  try {
    const res = (await client.request("issues.list", {
      query: state.search || undefined,
      status: state.filterStatus || undefined,
      severity: state.filterSeverity || undefined,
    })) as { issues?: Issue[] };
    state.issues = res?.issues ?? [];
    state.loaded = true;
  } catch (e) {
    state.error = String(e);
  } finally {
    state.loading = false;
    rerender(app);
  }
}

function openCreate(app: AppViewState) {
  state.editingId = null;
  state.error = null;
  state.draft = {
    issueType: "Bug",
    severity: "medium",
    priority: "medium",
    status: "open",
    dateReported: new Date().toISOString().slice(0, 10),
    recurring: false,
    automationCandidate: false,
    ceoInputRequired: false,
  };
  state.attachments = [];
  state.pendingUploads = [];
  state.modalOpen = true;
  rerender(app);
}

function openEdit(app: AppViewState, issue: Issue) {
  state.editingId = issue.id;
  state.error = null;
  state.draft = { ...issue };
  state.attachments = issue.attachments ?? [];
  state.pendingUploads = [];
  state.modalOpen = true;
  rerender(app);
}

function closeModal(app: AppViewState) {
  state.modalOpen = false;
  state.draft = {};
  state.editingId = null;
  state.attachments = [];
  state.pendingUploads = [];
  state.error = null;
  rerender(app);
}

// ── Image loading (lazy, via files.download → data URL) ──
function ensureImage(app: AppViewState, client: GatewayBrowserClient, path: string) {
  if (!path || imageCache.has(path) || imageInflight.has(path)) return;
  imageInflight.add(path);
  void (async () => {
    try {
      const res = (await client.request("files.download", { path })) as {
        content?: string;
        type?: string;
      };
      if (res?.content) {
        const mime = mimeFromPath(path);
        imageCache.set(path, `data:${mime};base64,${res.content}`);
        rerender(app);
      }
    } catch {
      /* leave uncached; the tile just shows a placeholder */
    } finally {
      imageInflight.delete(path);
    }
  })();
}

function mimeFromPath(path: string): string {
  const ext = (path.split(".").pop() || "").toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  if (ext === "svg") return "image/svg+xml";
  return "image/png";
}

function firstImage(iss: Issue): IssueAttachment | undefined {
  return (iss.attachments ?? []).find(
    (a) => a.mimeType?.startsWith("image/") || /\.(png|jpe?g|gif|webp|svg)$/i.test(a.name || ""),
  );
}

function readFileAsBase64(file: File): Promise<{ base64: string; dataUrl: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const base64 = dataUrl.includes(",") ? dataUrl.slice(dataUrl.indexOf(",") + 1) : dataUrl;
      resolve({ base64, dataUrl });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// Accept a set of images: upload immediately in edit mode, else stage them.
async function addImageFiles(
  app: AppViewState,
  client: GatewayBrowserClient,
  files: File[],
) {
  const images = files.filter((f) => f.type.startsWith("image/"));
  if (images.length === 0) return;
  state.uploading = true;
  state.error = null;
  rerender(app);
  try {
    for (const file of images) {
      const { base64, dataUrl } = await readFileAsBase64(file);
      if (state.editingId) {
        const att = (await client.request("issues.attach", {
          issueId: state.editingId,
          name: file.name || "screenshot.png",
          content: base64,
          mimeType: file.type || "image/png",
        })) as IssueAttachment;
        if (att?.id) {
          imageCache.set(att.path, dataUrl);
          if (!state.attachments.some((a) => a.id === att.id)) state.attachments = [...state.attachments, att];
        }
      } else {
        state.pendingUploads = [
          ...state.pendingUploads,
          { name: file.name || "screenshot.png", mimeType: file.type || "image/png", base64, dataUrl },
        ];
      }
    }
  } catch (e) {
    state.error = `Upload failed: ${String(e)}`;
  } finally {
    state.uploading = false;
    rerender(app);
  }
}

async function removeAttachment(app: AppViewState, client: GatewayBrowserClient, id: string) {
  try {
    await client.request("issues.attachment.delete", { id });
    state.attachments = state.attachments.filter((a) => a.id !== id);
  } catch (e) {
    state.error = String(e);
  }
  rerender(app);
}

function removePending(app: AppViewState, index: number) {
  state.pendingUploads = state.pendingUploads.filter((_, i) => i !== index);
  rerender(app);
}

async function saveIssue(app: AppViewState, client: GatewayBrowserClient) {
  if (!state.draft.title?.trim()) {
    state.error = "Title is required";
    rerender(app);
    return;
  }
  state.saving = true;
  state.error = null;
  rerender(app);
  try {
    // `attachments` is a read-only projection, not a create/update param — strip it.
    const { attachments: _drop, ...payload } = state.draft;
    let issueId = state.editingId;
    if (state.editingId) {
      await client.request("issues.update", { ...payload, id: state.editingId });
    } else {
      const created = (await client.request("issues.create", { ...payload })) as Issue;
      issueId = created?.id ?? null;
      // Flush any screenshots staged before the issue existed.
      if (issueId && state.pendingUploads.length > 0) {
        for (const up of state.pendingUploads) {
          try {
            await client.request("issues.attach", {
              issueId,
              name: up.name,
              content: up.base64,
              mimeType: up.mimeType,
            });
          } catch (upErr) {
            state.error = `Issue saved, but a screenshot failed to upload: ${String(upErr)}`;
          }
        }
      }
    }
    state.modalOpen = false;
    state.draft = {};
    state.editingId = null;
    state.pendingUploads = [];
    state.attachments = [];
    await loadIssues(app, client);
  } catch (e) {
    state.error = String(e);
  } finally {
    state.saving = false;
    rerender(app);
  }
}

async function deleteIssue(app: AppViewState, client: GatewayBrowserClient, id: string) {
  try {
    await client.request("issues.delete", { id });
    if (state.editingId === id) closeModal(app);
    await loadIssues(app, client);
  } catch (e) {
    state.error = String(e);
    rerender(app);
  }
}

// ── Field setter ──
function set<K extends keyof IssueDraft>(app: AppViewState, key: K, value: IssueDraft[K]) {
  state.draft = { ...state.draft, [key]: value };
  rerender(app);
}

// ── Small render helpers ──
// Severity / status colours live in ./work-glass/issues.css, keyed off
// `data-sev` / `data-status` so they follow the light theme.

function textField(
  app: AppViewState,
  label: string,
  key: keyof IssueDraft,
  opts: { area?: boolean; type?: string; placeholder?: string } = {},
) {
  const val = (state.draft[key] as string) ?? "";
  return html`
    <label class="iss-field">
      <span class="iss-label">${label}</span>
      ${opts.area
        ? html`<textarea
            class="g-input"
            rows="3"
            placeholder=${opts.placeholder ?? ""}
            .value=${val}
            @input=${(e: Event) => set(app, key, (e.target as HTMLTextAreaElement).value)}
          ></textarea>`
        : html`<input
            class="g-input"
            type=${opts.type ?? "text"}
            placeholder=${opts.placeholder ?? ""}
            .value=${val}
            @input=${(e: Event) => set(app, key, (e.target as HTMLInputElement).value)}
          />`}
    </label>
  `;
}

function selectField(app: AppViewState, label: string, key: keyof IssueDraft, options: string[]) {
  const val = (state.draft[key] as string) ?? "";
  return html`
    <label class="iss-field">
      <span class="iss-label">${label}</span>
      <select
        class="g-input"
        .value=${val}
        @change=${(e: Event) => set(app, key, (e.target as HTMLSelectElement).value)}
      >
        ${options.map((o) => html`<option value=${o} ?selected=${o === val}>${STATUS_LABEL[o] ?? o}</option>`)}
      </select>
    </label>
  `;
}

function checkField(app: AppViewState, label: string, key: keyof IssueDraft) {
  const val = Boolean(state.draft[key]);
  return html`
    <label class="iss-check ${val ? "is-on" : ""}">
      <input
        type="checkbox"
        .checked=${val}
        @change=${(e: Event) => set(app, key, (e.target as HTMLInputElement).checked)}
      />
      ${label}
    </label>
  `;
}

const sevLabel = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : "—");

// ── Screenshots block (inside the modal) ──
function renderScreenshots(app: AppViewState, client: GatewayBrowserClient) {
  const tile = (src: string | undefined, label: string, onRemove: () => void) => html`
    <div class="iss-shot">
      ${src
        ? html`<img src=${src} title=${label} alt=${label} />`
        : html`<div class="iss-shot__ph wg-skel"></div>`}
      <button
        class="iss-shot__x"
        @click=${(e: Event) => { e.stopPropagation(); onRemove(); }}
        title="Remove"
        aria-label="Remove screenshot"
      >×</button>
    </div>
  `;

  // Existing (persisted) attachments load lazily via files.download.
  const existing = state.attachments.map((a) => {
    ensureImage(app, client, a.path);
    return tile(imageCache.get(a.path), a.name, () => void removeAttachment(app, client, a.id));
  });
  const pending = state.pendingUploads.map((p, i) =>
    tile(p.dataUrl, p.name, () => removePending(app, i)),
  );

  const inputId = "issue-screenshot-input";
  return html`
    <div class="iss-span iss-shots">
      <div class="iss-shots__bar">
        <label for=${inputId} class="iss-drop">
          ${icon("camera")} ${state.uploading ? "Uploading…" : "Add screenshot"}
        </label>
        <input
          id=${inputId}
          type="file"
          accept="image/*"
          multiple
          style="display:none;"
          @change=${(e: Event) => {
            const input = e.target as HTMLInputElement;
            const files = input.files ? Array.from(input.files) : [];
            void addImageFiles(app, client, files);
            input.value = "";
          }}
        />
        <span class="iss-hint">or paste an image <kbd class="g-kbd">Ctrl/Cmd+V</kbd></span>
      </div>
      ${existing.length || pending.length
        ? html`<div class="iss-shots__grid">${existing}${pending}</div>`
        : nothing}
    </div>
  `;
}

// ── Modal ──
function renderModal(app: AppViewState, client: GatewayBrowserClient) {
  if (!state.modalOpen) return nothing;
  const isEdit = Boolean(state.editingId);
  const section = (title: string) => html`<div class="iss-span iss-section">${title}</div>`;
  return html`
    <div
      class="iss-overlay"
      @click=${(e: Event) => {
        if (e.target === e.currentTarget) closeModal(app);
      }}
      @paste=${(e: ClipboardEvent) => {
        const items = e.clipboardData?.items;
        if (!items) return;
        const files: File[] = [];
        for (const it of Array.from(items)) {
          if (it.kind === "file" && it.type.startsWith("image/")) {
            const f = it.getAsFile();
            if (f) files.push(f);
          }
        }
        if (files.length) {
          e.preventDefault();
          void addImageFiles(app, client, files);
        }
      }}
    >
      <div class="wg-page iss-modal" role="dialog" aria-modal="true" aria-label=${isEdit ? "Edit issue" : "Log new issue"}>
        <div class="iss-modal__head">
          <div>
            <div class="wg-eyebrow">${isEdit ? "Issue" : "New issue"}</div>
            <div class="iss-modal__title">${isEdit ? html`Edit <span class="wg-gold-text">issue</span>` : html`Log new <span class="wg-gold-text">issue</span>`}</div>
          </div>
          <button class="g-btn g-btn--ghost g-btn--icon" aria-label="Close" @click=${() => closeModal(app)}>${icon("x")}</button>
        </div>

        <div class="iss-modal__body">
          ${section("Identification")}
          ${textField(app, "Title *", "title", { placeholder: "Short summary of the problem" })}
          ${selectField(app, "Issue Type", "issueType", ISSUE_TYPES)}
          <div class="iss-span">${textField(app, "Description", "description", { area: true, placeholder: "What is broken / inefficient?" })}</div>
          ${textField(app, "Reported By", "reportedBy")}
          ${textField(app, "Date Reported", "dateReported", { type: "date" })}

          ${section("Context")}
          ${textField(app, "Related Object", "relatedObject")}
          ${textField(app, "Related Project", "relatedProject")}
          ${textField(app, "Related Workflow", "relatedWorkflow")}
          ${textField(app, "Kanban Project ID", "projectId", { placeholder: "optional — link to a project" })}

          ${section("Impact")}
          ${textField(app, "Frequency", "frequency", { placeholder: "e.g. daily, every run" })}
          ${textField(app, "Time Wasted", "timeWasted", { placeholder: "e.g. 30 min/day" })}
          <div class="iss-span">${textField(app, "Business Impact", "businessImpact", { area: true })}</div>
          ${selectField(app, "Severity", "severity", SEVERITIES)}
          ${selectField(app, "Priority", "priority", PRIORITIES)}

          ${section("Diagnosis")}
          <div class="iss-span">${textField(app, "Temporary Workaround", "temporaryWorkaround", { area: true })}</div>
          <div class="iss-span">${textField(app, "Root Cause", "rootCause", { area: true })}</div>
          ${textField(app, "Assigned Owner", "assignedOwner")}
          ${selectField(app, "Status", "status", STATUSES)}

          ${section("Resolution")}
          <div class="iss-span">${textField(app, "Proposed Fix", "proposedFix", { area: true })}</div>
          ${textField(app, "Target Fix Date", "targetFixDate", { type: "date" })}
          ${textField(app, "Date Fixed", "dateFixed", { type: "date" })}
          ${textField(app, "Tested By", "testedBy")}
          <div class="iss-span">${textField(app, "Resolution Notes", "resolutionNotes", { area: true })}</div>

          ${section("Flags")}
          <div class="iss-span iss-flags">
            ${checkField(app, "Recurring?", "recurring")}
            ${checkField(app, "Automation Candidate?", "automationCandidate")}
            ${checkField(app, "CEO Input Required?", "ceoInputRequired")}
          </div>

          ${section("Screenshots")}
          ${renderScreenshots(app, client)}
        </div>

        ${state.error
          ? html`<div class="iss-alert iss-alert--modal" role="alert">${state.error}</div>`
          : nothing}

        <div class="iss-modal__foot">
          <div>
            ${isEdit
              ? html`<button
                  class="g-btn iss-btn-danger"
                  @click=${() => deleteIssue(app, client, state.editingId!)}
                >${icon("trash")} Delete</button>`
              : nothing}
          </div>
          <div class="iss-modal__foot-actions">
            <button class="g-btn" @click=${() => closeModal(app)}>Cancel</button>
            <button
              class="g-btn g-btn--primary"
              ?disabled=${state.saving}
              @click=${() => saveIssue(app, client)}
            >${icon("check")} ${state.saving ? "Saving…" : isEdit ? "Save Changes" : "Log Issue"}</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

// ── Main render ──
export function renderIssues(app: AppViewState, client: GatewayBrowserClient) {
  if (!state.loaded && !state.loading) {
    void loadIssues(app, client);
  }

  const list = state.issues;
  const activeCount = list.filter((i) => i.status === "open" || i.status === "triaged" || i.status === "in_progress").length;
  const criticalCount = list.filter((i) => i.severity === "critical" && i.status !== "fixed" && i.status !== "verified" && i.status !== "wont_fix").length;
  const resolvedCount = list.filter((i) => i.status === "fixed" || i.status === "verified").length;
  const ceoCount = list.filter((i) => i.ceoInputRequired).length;

  return html`
    <div class="wg-page iss">
      ${wgAurora()}
      ${wgHero({
        eyebrow: "Operations · Improvement log",
        title: html`System <span class="wg-gold">issues</span>`,
        sub: "Capture bugs, broken functions, automation failures, workflow friction and improvement opportunities.",
        actions: html`<button class="g-btn g-btn--primary" @click=${() => openCreate(app)}>${icon("plus")} Log Issue</button>`,
      })}

      ${state.loaded && list.length > 0
        ? html`<div class="wg-stats">
            ${wgStat("Active", activeCount, "open · triaged · in progress")}
            ${wgStat("Critical", html`<span class=${criticalCount ? "iss-stat-bad" : ""}>${criticalCount}</span>`, "unresolved")}
            ${wgStat("Resolved", resolvedCount, "fixed or verified")}
            ${wgStat("Needs CEO", ceoCount, "input required")}
          </div>`
        : nothing}

      <!-- Filters -->
      <div class="wg-surface iss-filters">
        <label class="iss-search">
          <span class="iss-search__icon" aria-hidden="true">${icon("search")}</span>
          <input
            class="g-input"
            aria-label="Search issues"
            placeholder="Search title / description / root cause…"
            .value=${state.search}
            @input=${(e: Event) => {
              state.search = (e.target as HTMLInputElement).value;
            }}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === "Enter") void loadIssues(app, client);
            }}
          />
        </label>
        <div class="iss-seg" role="group" aria-label="Filter by status">
          <button class="iss-seg__btn ${state.filterStatus === "" ? "is-active" : ""}" aria-pressed=${state.filterStatus === ""} @click=${() => { state.filterStatus = ""; void loadIssues(app, client); }}>All</button>
          ${STATUSES.map(
            (st) => html`<button
              class="iss-seg__btn ${state.filterStatus === st ? "is-active" : ""}"
              data-status=${st}
              aria-pressed=${state.filterStatus === st}
              @click=${() => {
                state.filterStatus = st;
                void loadIssues(app, client);
              }}
            ><i class="iss-dot"></i>${STATUS_LABEL[st]}</button>`,
          )}
        </div>
      </div>

      ${state.error && !state.modalOpen
        ? html`<div class="iss-alert" role="alert">${state.error}</div>`
        : nothing}

      <!-- Table -->
      <div class="wg-surface iss-table" role="table" aria-label="Issues">
        <div class="iss-thead" role="row">
          <div role="columnheader">Title</div><div role="columnheader">Type</div><div role="columnheader">Severity</div><div role="columnheader">Priority</div><div role="columnheader">Status</div><div role="columnheader">Owner</div>
        </div>
        ${state.loading && !state.loaded
          ? html`${[0, 1, 2, 3].map(() => html`<div class="iss-row iss-row--skel"><div class="wg-skel" style="height:12px;width:70%"></div><div class="wg-skel" style="height:10px;width:60%"></div><div class="wg-skel" style="height:10px;width:50%"></div><div class="wg-skel" style="height:10px;width:50%"></div><div class="wg-skel" style="height:18px;width:70%"></div><div class="wg-skel" style="height:10px;width:50%"></div></div>`)}`
          : list.length === 0
            ? wgEmpty({
                icon: icon("bug"),
                title: state.search || state.filterStatus ? "No matching issues" : "No issues logged yet",
                body: state.search || state.filterStatus
                  ? "Try a different search or status filter."
                  : "Log the first bug, broken flow or improvement idea so it gets triaged and fixed.",
                action: state.search || state.filterStatus
                  ? nothing
                  : html`<button class="g-btn g-btn--primary g-btn--sm" @click=${() => openCreate(app)}>${icon("plus")} Log Issue</button>`,
              })
            : list.map(
                (iss) => html`
                  <div
                    class="iss-row ${state.loading ? "is-stale" : ""}"
                    role="row"
                    tabindex="0"
                    @click=${() => openEdit(app, iss)}
                    @keydown=${(e: KeyboardEvent) => {
                      if (e.key === "Enter") openEdit(app, iss);
                    }}
                  >
                    <div class="iss-title" role="cell">
                      ${(() => {
                        const img = firstImage(iss);
                        if (!img) return nothing;
                        ensureImage(app, client, img.path);
                        const src = imageCache.get(img.path);
                        return html`<span class="iss-thumb">${src
                          ? html`<img src=${src} title=${img.name} alt="" />`
                          : nothing}</span>`;
                      })()}
                      <span class="iss-title__text">${iss.title || "(untitled)"}</span>
                      ${iss.ceoInputRequired ? html`<span class="iss-ceo" title="CEO input required">${icon("starFilled")}</span>` : nothing}
                    </div>
                    <div class="iss-type" role="cell">${iss.issueType || "—"}</div>
                    <div role="cell"><span class="iss-sev" data-sev=${iss.severity}><i class="iss-dot"></i>${sevLabel(iss.severity)}</span></div>
                    <div class="iss-prio" role="cell" data-sev=${iss.priority}><span class="iss-prio__bars" aria-hidden="true"><i></i><i></i><i></i><i></i></span>${sevLabel(iss.priority)}</div>
                    <div role="cell">
                      <span class="iss-status" data-status=${iss.status}><i class="iss-dot"></i>${STATUS_LABEL[iss.status] ?? iss.status ?? "—"}</span>
                    </div>
                    <div class="iss-owner" role="cell">${iss.assignedOwner
                      ? html`<span class="iss-avatar" aria-hidden="true">${iss.assignedOwner.trim().charAt(0).toUpperCase()}</span>${iss.assignedOwner}`
                      : html`<span class="iss-muted">Unassigned</span>`}</div>
                  </div>
                `,
              )}
      </div>
    </div>
    ${renderModal(app, client)}
  `;
}
