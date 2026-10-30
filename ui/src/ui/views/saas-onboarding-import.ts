/**
 * Cloud onboarding: "Import your notes" (Obsidian vault ZIP / Notion export
 * ZIP / Notion integration token).
 *
 * Runs on the member's private cloud machine (tenant gateway): uploads go to
 * /api/documents/upload (obsidian-zip / notion-zip) and token imports to
 * documents.notion.import — all background jobs, so this step never blocks
 * Continue. Imports keep running after onboarding; the job list here polls
 * documents.notion.jobs.list while anything is active, and every finished
 * import can be undone (documents.import.undo).
 *
 * Folder paths and git URLs are self-hosted only (a hosted machine can't see
 * the member's disk), so hosted onboarding offers the ZIP routes.
 */
import { html, nothing, type TemplateResult } from "lit";
import {
  DocumentsApi,
  isJobActive,
  type ImportJob,
  type NotionSearchResult,
} from "./documents/api";
import type { GatewayBrowserClient } from "../gateway";

export type ImportStepCtx = {
  client: GatewayBrowserClient;
  requestUpdate: () => void;
  header: (title: TemplateResult | string, sub: TemplateResult | string) => TemplateResult;
};

type ImportState = {
  src: "obsidian" | "notion";
  notionVia: "zip" | "token";
  tasks: boolean;
  token: string;
  query: string;
  results: NotionSearchResult[];
  picked: Set<string>;
  busy: boolean;
  error: string | null;
  jobs: ImportJob[] | null;
  timer: ReturnType<typeof setTimeout> | null;
  loaded: boolean;
};

const st: ImportState = {
  src: "obsidian",
  notionVia: "zip",
  tasks: false,
  token: "",
  query: "",
  results: [],
  picked: new Set(),
  busy: false,
  error: null,
  jobs: null,
  timer: null,
  loaded: false,
};

/** Test hook: start from a clean slate. */
export function resetImportStep(): void {
  if (st.timer) clearTimeout(st.timer);
  Object.assign(st, {
    src: "obsidian",
    notionVia: "zip",
    tasks: false,
    token: "",
    query: "",
    results: [],
    picked: new Set(),
    busy: false,
    error: null,
    jobs: null,
    timer: null,
    loaded: false,
  });
}

/** Stop polling when the member leaves the step (jobs keep running server-side). */
export function leaveImportStep(): void {
  if (st.timer) clearTimeout(st.timer);
  st.timer = null;
  st.loaded = false;
}

function api(ctx: ImportStepCtx): DocumentsApi {
  return new DocumentsApi(ctx.client as never);
}

async function refreshJobs(ctx: ImportStepCtx): Promise<void> {
  try {
    const { jobs } = await api(ctx).importJobs({ limit: 6 });
    st.jobs = jobs;
  } catch {
    st.jobs = st.jobs ?? [];
  }
  ctx.requestUpdate();
  if (st.timer) clearTimeout(st.timer);
  st.timer = (st.jobs ?? []).some((j) => isJobActive(j))
    ? setTimeout(() => void refreshJobs(ctx), 1500)
    : null;
}

async function start(ctx: ImportStepCtx, run: () => Promise<unknown>): Promise<void> {
  st.busy = true;
  st.error = null;
  ctx.requestUpdate();
  try {
    await run();
    await refreshJobs(ctx);
  } catch (err) {
    st.error = (err as Error).message || "Couldn't start the import";
  } finally {
    st.busy = false;
    ctx.requestUpdate();
  }
}

function pickZip(ctx: ImportStepCtx, mode: "obsidian-zip" | "notion-zip"): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".zip,application/zip";
  input.onchange = () => {
    const file = input.files?.[0];
    if (!file) return;
    void start(ctx, () =>
      api(ctx).upload(file, {
        parentId: null,
        name: file.name,
        mode,
        extra: mode === "obsidian-zip" && st.tasks ? { createTasks: "1" } : {},
      }),
    );
  };
  input.click();
}

async function search(ctx: ImportStepCtx): Promise<void> {
  st.busy = true;
  st.error = null;
  ctx.requestUpdate();
  try {
    st.results = (await api(ctx).notionSearch(st.query, st.token.trim() || undefined)).results;
  } catch (err) {
    st.error = (err as Error).message;
  } finally {
    st.busy = false;
    ctx.requestUpdate();
  }
}

function jobRow(ctx: ImportStepCtx, j: ImportJob): TemplateResult {
  const active = isJobActive(j);
  const p = j.progress;
  const pct = p.total > 0 ? Math.min(100, Math.round((p.done / p.total) * 100)) : active ? 6 : 100;
  const kind =
    j.kind === "obsidian"
      ? "Obsidian"
      : j.kind === "notion-zip"
        ? "Notion ZIP"
        : j.kind === "map"
          ? "Mapping"
          : "Notion";
  const d = (j.details ?? {}) as {
    notes?: number;
    links?: { resolved?: number };
    tasks?: { created?: number };
  };
  const state = j.undoneAt
    ? "Undone"
    : active
      ? "Importing…"
      : j.status === "done"
        ? "Done"
        : j.status === "failed"
          ? "Failed"
          : "Cancelled";
  return html`<div class="sob-imp-job ${j.status}" data-testid="so-import-job">
    <div class="sob-imp-job__head"><span class="sob-tag">${kind}</span><b>${j.label}</b><span class="sob-hint">${state}</span></div>
    <div class="sob-imp-bar"><span style="width:${pct}%"></span></div>
    <p class="sob-hint">
      ${j.report.created} new · ${j.report.updated} updated · ${j.report.unchanged} unchanged
      ${j.kind === "obsidian" && !active ? ` · ${d.notes ?? 0} notes · ${d.links?.resolved ?? 0} links${d.tasks ? ` · ${d.tasks.created ?? 0} tasks` : ""}` : ""}
      ${j.errorCount ? ` · ${j.errorCount} errors` : ""}
    </p>
    ${j.status === "failed" && j.error ? html`<p class="sob-hint sob-imp-err">${j.error}</p>` : nothing}
    ${
      !active && (j.undoable ?? 0) > 0 && !j.undoneAt
        ? html`<button
          class="sob-link"
          @click=${async () => {
            if (
              !confirm(
                "Undo this import? Imported notes go to Trash and tasks it created are removed.",
              )
            )
              return;
            try {
              await api(ctx).undoImport(j.id);
            } catch (err) {
              st.error = (err as Error).message;
            }
            await refreshJobs(ctx);
          }}
        >
          Undo this import
        </button>`
        : nothing
    }
  </div>`;
}

export function renderImportStep(ctx: ImportStepCtx): TemplateResult {
  if (!st.loaded) {
    st.loaded = true;
    void refreshJobs(ctx);
  }
  const seg = <T extends string>(value: T, options: Array<[T, string]>, set: (v: T) => void) =>
    html`<div class="sob-seg" role="radiogroup">
      ${options.map(
        ([v, label]) => html`<button
          type="button"
          role="radio"
          aria-checked=${value === v}
          class="sob-seg__opt ${value === v ? "is-selected" : ""}"
          data-testid=${`so-import-${v}`}
          @click=${() => {
            set(v);
            ctx.requestUpdate();
          }}
        >
          <span class="sob-seg__dot"></span>${label}
        </button>`,
      )}
    </div>`;
  return html`
    ${ctx.header(
      html`
        Import your notes <span class="sob-tag">Optional</span>
      `,
      "Bring your Obsidian vault or Notion workspace along. Notes land in Documents with their links, tags and attachments, and your agents can use them right away. Imports run in the background — continue whenever you like.",
    )}
    <style>
      .sob-imp { display: grid; gap: 16px; }
      .sob-imp-panel { display: grid; gap: 12px; padding: 18px 20px; border-radius: 14px; border: 1px solid var(--sob-line-2); background: rgba(255, 255, 255, 0.02); }
      .sob-imp-check { display: flex; gap: 10px; align-items: center; font-size: 14px; color: var(--sob-fg-2); }
      .sob-imp-list { display: grid; gap: 6px; max-height: 220px; overflow: auto; }
      .sob-imp-item { display: flex; gap: 10px; align-items: center; font-size: 14px; color: var(--sob-fg-2); }
      .sob-imp-job { display: grid; gap: 6px; padding: 12px 0; border-top: 1px solid var(--sob-line); }
      .sob-imp-job__head { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; overflow-wrap: anywhere; }
      .sob-imp-bar { height: 4px; border-radius: 99px; background: rgba(255, 255, 255, 0.06); overflow: hidden; }
      .sob-imp-bar span { display: block; height: 100%; background: var(--sob-gold); box-shadow: 0 0 10px var(--sob-gold); transition: width 0.4s; }
      .sob-imp-err { color: #f87171; }
      .sob-imp-job .sob-link { justify-self: start; }
      .sob-imp code { font-family: var(--sob-mono); font-size: 12px; white-space: nowrap; }
    </style>
    <div class="sob-imp" data-testid="so-import">
      ${seg(
        st.src,
        [
          ["obsidian", "Obsidian"],
          ["notion", "Notion"],
        ],
        (v) => (st.src = v),
      )}
      ${
        st.src === "obsidian"
          ? html`<div class="sob-imp-panel">
            <p class="sob-hint">
              Zip your vault folder (right-click → Compress) and upload the <code>.zip</code>.
              <code>[[wikilinks]]</code>, embeds, frontmatter, <code>#tags</code>, attachments and daily notes all come
              across. Upload a newer ZIP later to re-sync — nothing duplicates.
            </p>
            <label class="sob-imp-check">
              <input type="checkbox" .checked=${st.tasks} @change=${(e: Event) => (st.tasks = (e.target as HTMLInputElement).checked)} />
              <span>Also turn <code>- [ ]</code> checklists into kanban tasks</span>
            </label>
            <div>
              <button class="sob-btn sob-btn--primary" data-testid="so-import-obsidian-zip" ?disabled=${st.busy} @click=${() => pickZip(ctx, "obsidian-zip")}>
                Upload vault ZIP
              </button>
            </div>
          </div>`
          : html`<div class="sob-imp-panel">
            ${seg(
              st.notionVia,
              [
                ["zip", "Export ZIP"],
                ["token", "Integration token"],
              ],
              (v) => (st.notionVia = v),
            )}
            ${
              st.notionVia === "zip"
                ? html`<p class="sob-hint">In Notion: <b>Settings → Export → Markdown &amp; CSV</b> (include subpages), then upload the <code>.zip</code>. Databases become tables you can turn into projects, tasks or clients later.</p>
                  <div>
                    <button class="sob-btn sob-btn--primary" ?disabled=${st.busy} @click=${() => pickZip(ctx, "notion-zip")}>Upload Notion ZIP</button>
                  </div>`
                : html`<label class="sob-field">
                    <span class="sob-label">Internal integration token</span>
                    <input class="sob-input sob-input--mono" type="password" autocomplete="off" placeholder="ntn_… / secret_…" .value=${st.token}
                      @input=${(e: Event) => (st.token = (e.target as HTMLInputElement).value)} />
                  </label>
                  <div class="sob-keyrow">
                    <input class="sob-input" placeholder="Search pages & databases" .value=${st.query}
                      @input=${(e: Event) => (st.query = (e.target as HTMLInputElement).value)}
                      @keydown=${(e: KeyboardEvent) => e.key === "Enter" && search(ctx)} />
                    <button class="sob-btn" ?disabled=${st.busy} @click=${() => search(ctx)}>Search</button>
                  </div>
                  <div class="sob-imp-list">
                    ${st.results.map(
                      (r) => html`<label class="sob-imp-item">
                        <input type="checkbox" .checked=${st.picked.has(r.id)} @change=${(
                          e: Event,
                        ) => {
                          if ((e.target as HTMLInputElement).checked) st.picked.add(r.id);
                          else st.picked.delete(r.id);
                          ctx.requestUpdate();
                        }} />
                        ${r.icon || (r.type === "database" ? "🗃️" : "📄")} ${r.title || "Untitled"}
                        <span class="sob-tag">${r.type}</span>
                      </label>`,
                    )}
                  </div>
                  <div>
                    <button class="sob-btn sob-btn--primary" ?disabled=${st.busy || !st.picked.size}
                      @click=${() =>
                        start(ctx, () =>
                          api(ctx).notionImport([...st.picked], null, {
                            token: st.token.trim() || undefined,
                            label: `${st.picked.size} Notion item${st.picked.size === 1 ? "" : "s"}`,
                          }),
                        )}>
                      Import ${st.picked.size || ""} selected
                    </button>
                  </div>`
            }
          </div>`
      }
      ${st.error ? html`<p class="sob-hint sob-imp-err" role="alert">${st.error}</p>` : nothing}
      ${
        st.jobs?.length
          ? html`<div class="sob-imp-panel" data-testid="so-import-jobs">
            <span class="sob-label">Your imports</span>
            ${st.jobs.map((j) => jobRow(ctx, j))}
            <p class="sob-hint">These keep running on your cloud machine after setup. Find everything under Documents.</p>
          </div>`
          : nothing
      }
    </div>
  `;
}
