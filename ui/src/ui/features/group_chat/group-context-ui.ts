/**
 * Group chat shared-context UI:
 *  - <ib-group-binding-chip>  header chip: bound repo · branch · remote status · project
 *  - <ib-group-activity>      per-message ledger of real tool results + "unverified" flags
 *  - <ib-group-binding-fields> repo / project / purpose inputs for the create & edit dialog
 */
import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../gateway";
import { icons } from "../../icons";
import { getProjectRepo, renderRepoDirButton } from "../../project-repos/index";
import { formatActivityLine, type ToolActivity } from "../../../../../src/shared/group-chat/activity.js";
import type { RepoInfo } from "../../../../../src/shared/group-chat/context.js";
import type { UnverifiedClaim } from "../../../../../src/shared/group-chat/truth-guard.js";
import type { GroupChatBinding } from "../../../../../src/shared/group-chat/types.js";

/**
 * The chat page's per-session context bar (directory + project, stored in
 * localStorage by views/chat-sessions.ts) as a group binding — the "owner's
 * current project" new groups default to.
 */
export function loadSessionContextBinding(sessionKey: string): GroupChatBinding | null {
  try {
    const raw = localStorage.getItem(`infinibot-session-context-${sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_")}`);
    if (!raw) return null;
    const ctx = JSON.parse(raw) as { directory?: string; projectId?: string | null; projectName?: string | null };
    const dir = typeof ctx.directory === "string" ? ctx.directory.trim() : "";
    const b: GroupChatBinding = {
      ...(dir.startsWith("/") ? { workdir: dir } : {}),
      ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
      ...(ctx.projectName ? { projectName: ctx.projectName } : {}),
    };
    return Object.keys(b).length ? b : null;
  } catch {
    return null;
  }
}

function baseName(p: string): string {
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}

/** One-line repo status: "main @ abc1234 · no remote". */
export function repoStatusLine(repo: RepoInfo | null | undefined): string {
  if (!repo) return "";
  if (!repo.exists) return "directory missing";
  if (!repo.isGitRepo) return "not a git repo";
  const remote = repo.remotes.length ? repo.remotes.map((r) => r.name).join(", ") : "no remote";
  return `${repo.branch ?? "?"}${repo.head ? ` @ ${repo.head}` : ""} · ${remote}`;
}

@customElement("ib-group-binding-chip")
export class GroupBindingChip extends LitElement {
  @property({ attribute: false }) binding: GroupChatBinding | null = null;
  @property({ attribute: false }) repo: RepoInfo | null = null;

  private edit() {
    this.dispatchEvent(new CustomEvent("edit-binding", { bubbles: true, composed: true }));
  }

  render() {
    const b = this.binding;
    if (!b?.workdir && !b?.projectId && !b?.projectName) {
      return html`<button class="chip chip--empty" title="Bind a shared repo / project so members work in the same place" @click=${() => this.edit()}>
        ${icons.folder}<span>No shared repo</span>
      </button>`;
    }
    const noRemote = this.repo?.isGitRepo && this.repo.remotes.length === 0;
    const title = [
      b.workdir ? `Repo: ${b.workdir}` : "",
      this.repo ? `Git: ${repoStatusLine(this.repo)}` : "",
      b.projectName || b.projectId ? `Project: ${b.projectName ?? b.projectId}` : "",
      b.purpose ? `Purpose: ${b.purpose}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    return html`<button class="chip" title=${title} @click=${() => this.edit()}>
      ${b.workdir ? html`${icons.folder}<span class="path">${baseName(b.workdir)}</span>` : nothing}
      ${this.repo?.isGitRepo ? html`<span class="branch">${this.repo.branch ?? "?"}</span>` : nothing}
      ${noRemote ? html`<span class="warn">no remote</span>` : nothing}
      ${b.projectName || b.projectId ? html`<span class="proj">${b.projectName ?? b.projectId}</span>` : nothing}
    </button>`;
  }

  static styles = css`
    :host { display: inline-flex; min-width: 0; max-width: 100%; }
    .chip { display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 100%; min-height: 26px; padding: 2px 10px; border-radius: 999px; border: 1px solid var(--g-border, var(--border)); background: var(--g-surface, var(--card)); color: var(--text); font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap; overflow: hidden; }
    .chip:hover { border-color: var(--g-primary, var(--accent)); }
    .chip svg { width: 13px; height: 13px; flex: none; color: var(--g-primary, var(--accent)); }
    .chip--empty { color: var(--muted); border-style: dashed; }
    .path { font-family: var(--font-mono, ui-monospace, monospace); overflow: hidden; text-overflow: ellipsis; }
    .branch { color: var(--muted); }
    .branch::before { content: "⎇ "; }
    .warn { color: var(--warning, #e6a23c); font-weight: 600; }
    .proj { color: var(--muted); overflow: hidden; text-overflow: ellipsis; }
    .proj::before { content: "· "; }
    /* Phones: wrap inside the chip instead of truncating the project / path. */
    @media (max-width: 600px) {
      .chip { flex-wrap: wrap; white-space: normal; border-radius: 12px; row-gap: 2px; padding: 3px 10px; }
      .path, .proj { overflow-wrap: anywhere; }
    }
  `;
}

@customElement("ib-group-activity")
export class GroupActivity extends LitElement {
  @property({ attribute: false }) activity: ToolActivity[] = [];
  @property({ attribute: false }) unverified: UnverifiedClaim[] = [];

  render() {
    const acts = this.activity ?? [];
    const flags = this.unverified ?? [];
    if (!acts.length && !flags.length) return nothing;
    const failed = acts.filter((a) => !a.ok).length;
    return html`
      ${flags.length
        ? html`<div class="flags" role="note">
            <span class="badge">${icons.alertCircle}Unverified</span>
            <ul>${flags.map((f) => html`<li><q>${f.claim}</q> — ${f.reason}</li>`)}</ul>
          </div>`
        : nothing}
      ${acts.length
        ? html`<details>
            <summary>
              ${icons.terminal}<span>${acts.length} tool call${acts.length === 1 ? "" : "s"}</span>
              ${failed ? html`<span class="bad">${failed} failed</span>` : html`<span class="good">all ok</span>`}
              ${acts.some((a) => a.push) ? html`<span class=${acts.some((a) => a.push && !a.push.ok) ? "bad" : "good"}>${acts.some((a) => a.push && !a.push.ok) ? "push failed" : "pushed"}</span>` : nothing}
              ${acts.filter((a) => a.commit).map((a) => html`<code>${a.commit}</code>`)}
            </summary>
            <ul class="ledger">
              ${acts.map((a) => html`<li class=${a.ok ? "" : "fail"}>${formatActivityLine(a).replace(/^- /, "")}</li>`)}
            </ul>
          </details>`
        : nothing}
    `;
  }

  static styles = css`
    :host { display: block; margin-top: 6px; font-size: 12px; color: var(--muted); }
    .flags { display: flex; gap: 8px; align-items: flex-start; padding: 6px 10px; border-radius: 10px; border: 1px solid color-mix(in srgb, var(--warning, #e6a23c) 55%, transparent); background: color-mix(in srgb, var(--warning, #e6a23c) 10%, transparent); color: var(--text); margin-bottom: 6px; }
    .badge { display: inline-flex; align-items: center; gap: 4px; flex: none; font-weight: 700; color: var(--warning, #e6a23c); text-transform: uppercase; font-size: 10px; letter-spacing: 0.04em; padding-top: 2px; }
    .badge svg { width: 12px; height: 12px; }
    .flags ul { margin: 0; padding: 0; list-style: none; display: grid; gap: 2px; }
    details { border: 1px solid var(--g-border, var(--border)); border-radius: 10px; background: var(--g-surface, var(--card)); }
    summary { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 5px 10px; cursor: pointer; list-style: none; }
    summary::-webkit-details-marker { display: none; }
    summary svg { width: 13px; height: 13px; }
    .good { color: var(--ok, #3fb950); }
    .bad { color: var(--danger, #e5484d); font-weight: 600; }
    code { font-family: var(--font-mono, ui-monospace, monospace); font-size: 11px; }
    .ledger { margin: 0; padding: 4px 10px 8px 26px; display: grid; gap: 3px; font-family: var(--font-mono, ui-monospace, monospace); font-size: 11px; overflow-wrap: anywhere; color: var(--text); }
    .ledger .fail { color: var(--danger, #e5484d); }
  `;
}

type ProjectRow = { id: string; name: string; githubLocalPath?: string };

/** Repo / project / purpose inputs (create + edit dialog). Emits `binding-change`. */
@customElement("ib-group-binding-fields")
export class GroupBindingFields extends LitElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property({ attribute: false }) value: GroupChatBinding = {};
  @property({ attribute: false }) repo: RepoInfo | null = null;
  @state() private projects: ProjectRow[] = [];

  connectedCallback(): void {
    super.connectedCallback();
    void this.loadProjects();
  }

  private async loadProjects() {
    if (!this.client) return;
    try {
      const res = await this.client.request<unknown>("kanban.projects.list", {});
      const list = Array.isArray(res) ? res : Array.isArray((res as { projects?: unknown[] })?.projects) ? (res as { projects: unknown[] }).projects : [];
      this.projects = list
        .map((p) => p as { id?: unknown; name?: unknown; title?: unknown; githubLocalPath?: unknown })
        .filter((p) => typeof p.id === "string")
        .map((p) => ({
          id: String(p.id),
          name: String(p.name ?? p.title ?? p.id),
          ...(typeof p.githubLocalPath === "string" ? { githubLocalPath: p.githubLocalPath } : {}),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      this.projects = [];
    }
  }

  private emit(patch: Partial<GroupChatBinding>) {
    const next: GroupChatBinding = { ...this.value, ...patch };
    for (const k of Object.keys(next) as (keyof GroupChatBinding)[]) if (!next[k]) delete next[k];
    this.value = next;
    this.dispatchEvent(new CustomEvent<GroupChatBinding>("binding-change", { detail: next, bubbles: true, composed: true }));
  }

  private pickProject(id: string) {
    const p = this.projects.find((x) => x.id === id);
    this.emit({
      projectId: id || undefined,
      projectName: p?.name,
      ...(!this.value.workdir && (p?.githubLocalPath || getProjectRepo(id)?.root)
        ? { workdir: p?.githubLocalPath || getProjectRepo(id)?.root || undefined }
        : {}),
    });
  }

  render() {
    const v = this.value ?? {};
    const known = this.projects.some((p) => p.id === v.projectId);
    return html`
      <div class="bf">
        <span class="bf-title">${icons.folder}Shared workspace <em>— every member's tools run here</em></span>
        <label>
          <span>Repo / working directory</span>
          <span style="display:flex;gap:6px;align-items:center">
            <input class="bf-workdir" style="flex:1;min-width:0" placeholder="/home/you/code/project (absolute path)" .value=${v.workdir ?? ""} @change=${(e: Event) => this.emit({ workdir: (e.target as HTMLInputElement).value.trim() || undefined })} />
            ${renderRepoDirButton(
              (path, projectId) => {
                const p = projectId ? this.projects.find((x) => x.id === projectId) : undefined;
                this.emit({
                  workdir: path,
                  ...(p && !v.projectId ? { projectId: p.id, projectName: p.name } : {}),
                });
              },
              { title: "Shared repo for this group", label: "Project repos", initialPath: v.workdir || undefined },
            )}
          </span>
          ${this.repo && v.workdir === this.repo.path
            ? html`<small class=${this.repo.isGitRepo && this.repo.remotes.length ? "" : "warn"}>${repoStatusLine(this.repo)}</small>`
            : nothing}
        </label>
        <label>
          <span>Kanban project</span>
          <select class="bf-project" @change=${(e: Event) => this.pickProject((e.target as HTMLSelectElement).value)}>
            <option value="" ?selected=${!v.projectId}>None</option>
            ${v.projectId && !known ? html`<option value=${v.projectId} selected>${v.projectName ?? v.projectId}</option>` : nothing}
            ${this.projects.map((p) => html`<option value=${p.id} ?selected=${p.id === v.projectId}>${p.name}</option>`)}
          </select>
        </label>
        <label>
          <span>Purpose</span>
          <input class="bf-purpose" maxlength="1000" placeholder="What is this group working on? (optional)" .value=${v.purpose ?? ""} @change=${(e: Event) => this.emit({ purpose: (e.target as HTMLInputElement).value.trim() || undefined })} />
        </label>
      </div>
    `;
  }

  static styles = css`
    :host { display: block; }
    .bf { display: grid; gap: 8px; padding: 12px; border-radius: 12px; border: 1px solid var(--g-border, var(--border)); background: color-mix(in srgb, var(--g-primary, var(--accent)) 5%, transparent); }
    .bf-title { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 6px; font-size: 13px; color: var(--text); font-weight: 600; }
    .bf-title em { font-style: normal; font-weight: 400; color: var(--muted); }
    .bf-title svg { width: 15px; height: 15px; color: var(--g-primary, var(--accent)); }
    label { display: grid; gap: 4px; font-size: 12px; color: var(--muted); }
    input, select { font: inherit; font-size: 14px; color: var(--text); background: var(--g-surface, var(--card)); border: 1px solid var(--g-border, var(--border)); border-radius: 10px; padding: 8px 12px; min-height: 40px; box-sizing: border-box; width: 100%; }
    .bf-workdir { font-family: var(--font-mono, ui-monospace, monospace); font-size: 13px; }
    small { font-size: 12px; color: var(--muted); }
    small.warn { color: var(--warning, #e6a23c); }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "ib-group-binding-chip": GroupBindingChip;
    "ib-group-activity": GroupActivity;
    "ib-group-binding-fields": GroupBindingFields;
  }
}
