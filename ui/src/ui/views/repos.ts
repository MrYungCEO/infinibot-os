/**
 * Work › Projects › Repos & deploy (/repos → /projects?view=repos).
 *
 *  - every registered repo with its deploy branch card and health totals
 *  - ?repo=<key>: the branch-health dashboard — every local/remote branch,
 *    worktree and stash grouped Safe / Review / Active / Protected, with
 *    filters, search, totals and reclaimable disk
 *  - "Clean up safe branches": dry-run preview → confirm → manifest → run,
 *    and Restore from any past manifest
 *  - first-time setup (ib-repo-setup) when nothing is registered yet
 */

import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { icons } from "../icons";
import "../project-repos/deploy-card";
import "../project-repos/setup-wizard";
import { openReposPage } from "../project-repos/deploy-card";
import { BRANCH_ICON } from "../project-repos/repo-picker";
import {
  GROUP_META,
  MERGED_LABEL,
  fmtBytes,
  onRepoEvents,
  pathParts,
  reposApi,
  type BranchRow,
  type CleanupManifest,
  type CleanupPlan,
  type HealthGroup,
  type HealthReport,
  type ManifestSummary,
  type RepoSummary,
  type ScanJobInfo,
  type StashRow,
  type WorktreeRow,
} from "../project-repos/health-store";
import { relTime, showRepoToast } from "../project-repos/store";

type Kind = "branches" | "remote" | "worktrees" | "stashes";
const GROUPS: HealthGroup[] = ["safe", "review", "active", "protected"];
const PAGE = 150;

/** A path that wraps only after "/". */
function pathView(p: string | undefined) {
  return html`${pathParts(p).map((seg) => html`<span style="white-space:nowrap">${seg}</span><wbr />`)}`;
}

function urlParam(name: string): string | null {
  return new URLSearchParams(window.location.search).get(name);
}

function setUrlParam(name: string, value: string | null) {
  const url = new URL(window.location.href);
  if (value) url.searchParams.set(name, value);
  else url.searchParams.delete(name);
  window.history.replaceState({}, "", url.toString());
}

const pageStyles = css`
  :host {
    display: block;
    color: var(--text, #ece6d6);
    --gold: #d4af37;
    --gold-soft: rgba(212, 175, 55, 0.14);
    --line: rgba(212, 175, 55, 0.22);
    font-size: 13px;
  }
  .wrap {
    max-width: 1280px;
    margin: 0 auto;
    padding: 18px 20px 80px;
    box-sizing: border-box;
  }
  header.top {
    display: flex;
    align-items: flex-end;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 16px;
  }
  h1 {
    margin: 0;
    font-size: 22px;
    font-weight: 650;
    letter-spacing: 0.01em;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  h1 svg {
    width: 22px;
    height: 22px;
    color: var(--gold);
  }
  .sub {
    color: var(--muted, #a59d86);
    margin-top: 4px;
    max-width: 680px;
    line-height: 1.45;
  }
  .grow {
    flex: 1;
  }
  button {
    font: inherit;
    cursor: pointer;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 8px 13px;
    min-height: 36px;
    border-radius: 10px;
    border: 1px solid var(--line);
    background: rgba(212, 175, 55, 0.07);
    color: #f0dc9a;
    font-size: 12.5px;
    white-space: nowrap;
  }
  .btn:hover {
    background: rgba(212, 175, 55, 0.15);
  }
  .btn.primary {
    background: linear-gradient(180deg, #e8c766, #c29a2e);
    color: #1a1406;
    border-color: #e8c766;
    font-weight: 650;
  }
  .btn.danger {
    background: linear-gradient(180deg, #d46a4a, #a43f25);
    border-color: #e07b5b;
    color: #fff3ee;
    font-weight: 650;
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .btn.ghost {
    background: transparent;
    border-color: transparent;
    color: var(--muted, #b3aa90);
  }
  svg {
    width: 15px;
    height: 15px;
  }
  .toggle {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: var(--muted, #b3aa90);
    font-size: 12.5px;
    cursor: pointer;
    user-select: none;
  }
  .switch {
    width: 34px;
    height: 20px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.12);
    position: relative;
    transition: background 0.2s;
    flex: none;
  }
  .switch::after {
    content: "";
    position: absolute;
    top: 3px;
    left: 3px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: #ddd;
    transition: transform 0.2s;
  }
  .switch.on {
    background: #b8932c;
  }
  .switch.on::after {
    transform: translateX(14px);
    background: #fff7dc;
  }
  .repos {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 560px), 1fr));
    gap: 16px;
    align-items: start;
  }
  .repo {
    align-content: start;
    border-radius: 16px;
    border: 1px solid var(--line);
    background: linear-gradient(170deg, rgba(22, 19, 12, 0.94), rgba(10, 10, 9, 0.96));
    padding: 16px;
    display: grid;
    gap: 14px;
    min-width: 0;
  }
  .repo h2 {
    margin: 0;
    font-size: 17px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .repo h2 svg {
    color: var(--gold);
  }
  .mono {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 12px;
  }
  .muted {
    color: var(--muted, #9a937f);
  }
  .tiles {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 8px;
  }
  .tile {
    all: unset;
    box-sizing: border-box;
    cursor: pointer;
    border-radius: 12px;
    padding: 10px 12px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.025);
    display: grid;
    gap: 2px;
    min-width: 0;
  }
  .tile:hover,
  .tile.on {
    border-color: rgba(212, 175, 55, 0.55);
    background: rgba(212, 175, 55, 0.08);
  }
  .tile b {
    font-size: 22px;
    font-weight: 650;
    line-height: 1.1;
  }
  .tile span {
    font-size: 11.5px;
    color: var(--muted, #a59d86);
    line-height: 1.3;
  }
  .tile small {
    font-size: 10.5px;
    color: var(--muted, #8d856f);
    line-height: 1.3;
  }
  .tile.safe b {
    color: #8fe3bb;
  }
  .tile.review b {
    color: #f5c46b;
  }
  .tile.active b {
    color: #8cc8ff;
  }
  .tile.protected b {
    color: #f0d27a;
  }
  .tile.stash b {
    color: #d9b6ff;
  }
  .reclaim {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .gauge {
    flex: 1;
    min-width: 140px;
    height: 8px;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.06);
    overflow: hidden;
    display: flex;
  }
  .gauge i {
    display: block;
    height: 100%;
  }
  .toolbar {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    align-items: center;
    margin: 16px 0 10px;
    position: sticky;
    top: 0;
    z-index: 2;
    padding: 8px 0;
    background: linear-gradient(180deg, rgba(8, 8, 7, 0.96), rgba(8, 8, 7, 0.86));
    backdrop-filter: blur(6px);
  }
  .seg {
    display: inline-flex;
    border: 1px solid var(--line);
    border-radius: 10px;
    overflow: hidden;
  }
  .seg button {
    all: unset;
    cursor: pointer;
    padding: 7px 11px;
    font-size: 12.5px;
    color: #cfc5a8;
    white-space: nowrap;
  }
  .seg button.on {
    background: var(--gold-soft);
    color: #f6e3a1;
  }
  .chip {
    all: unset;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border-radius: 999px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    font-size: 12px;
    color: #cfc5a8;
    white-space: nowrap;
  }
  .chip.on {
    border-color: rgba(212, 175, 55, 0.6);
    background: var(--gold-soft);
    color: #f6e3a1;
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex: none;
  }
  .dot.safe {
    background: #5ad19a;
  }
  .dot.review {
    background: #f5b041;
  }
  .dot.active {
    background: #5aa9ff;
  }
  .dot.protected {
    background: #d4af37;
  }
  .search {
    flex: 1 1 200px;
    min-width: 160px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 10px;
    border-radius: 10px;
    border: 1px solid var(--line);
    background: rgba(0, 0, 0, 0.4);
  }
  .search input {
    all: unset;
    flex: 1;
    min-width: 0;
    padding: 8px 0;
    font-size: 13px;
    color: #f2ead2;
  }
  .rows {
    display: grid;
    gap: 6px;
  }
  .row {
    display: grid;
    grid-template-columns: 112px minmax(0, 2.2fr) minmax(0, 1.4fr) minmax(0, 1.2fr) minmax(0, 1.6fr);
    gap: 12px;
    align-items: center;
    padding: 10px 12px;
    border-radius: 12px;
    border: 1px solid rgba(255, 255, 255, 0.06);
    background: rgba(255, 255, 255, 0.02);
    min-width: 0;
  }
  .row:hover {
    border-color: rgba(212, 175, 55, 0.3);
  }
  .row .name {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 12.5px;
    color: #f2e6c2;
    overflow-wrap: anywhere;
  }
  .row .why {
    color: var(--muted, #a59d86);
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  .gbadge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11.5px;
    padding: 3px 8px;
    border-radius: 999px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    white-space: nowrap;
  }
  .gbadge.safe {
    color: #8fe3bb;
    border-color: rgba(90, 209, 154, 0.4);
  }
  .gbadge.review {
    color: #f5c46b;
    border-color: rgba(245, 176, 65, 0.45);
  }
  .gbadge.active {
    color: #8cc8ff;
    border-color: rgba(90, 169, 255, 0.4);
  }
  .gbadge.protected {
    color: #f0d27a;
    border-color: rgba(212, 175, 55, 0.45);
  }
  .tag {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    padding: 1px 7px;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.05);
    color: #d6ccb0;
    white-space: nowrap;
  }
  .tag.warn {
    background: rgba(245, 176, 65, 0.12);
    color: #f5c46b;
  }
  .tag.ok {
    background: rgba(90, 209, 154, 0.1);
    color: #8fe3bb;
  }
  .tag a {
    color: inherit;
  }
  .tags {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
    margin-top: 4px;
  }
  .warnbox {
    border-radius: 12px;
    border: 1px solid rgba(245, 176, 65, 0.35);
    background: rgba(245, 176, 65, 0.06);
    padding: 10px 12px;
    color: #f5d08a;
    font-size: 12.5px;
    display: grid;
    gap: 4px;
  }
  .empty {
    padding: 28px;
    text-align: center;
    color: var(--muted, #a59d86);
    border: 1px dashed var(--line);
    border-radius: 14px;
  }
  .scanbar {
    height: 3px;
    border-radius: 3px;
    background: rgba(255, 255, 255, 0.06);
    overflow: hidden;
  }
  .scanbar i {
    display: block;
    height: 100%;
    background: linear-gradient(90deg, #8a6d1f, #f0cf68);
    transition: width 0.4s;
  }
  .modal-back {
    position: fixed;
    inset: 0;
    z-index: 1000;
    background: rgba(0, 0, 0, 0.62);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
  }
  .modal {
    width: min(760px, 100%);
    max-height: min(86vh, 900px);
    display: flex;
    flex-direction: column;
    border-radius: 16px;
    border: 1px solid rgba(212, 175, 55, 0.4);
    background: linear-gradient(170deg, #17140c, #0b0a08);
    box-shadow: 0 30px 80px rgba(0, 0, 0, 0.6);
    overflow: hidden;
  }
  .modal header {
    padding: 16px 18px 10px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  }
  .modal h3 {
    margin: 0;
    font-size: 17px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .modal .body {
    padding: 12px 18px;
    overflow: auto;
    display: grid;
    gap: 8px;
  }
  .modal footer {
    padding: 12px 18px;
    border-top: 1px solid rgba(255, 255, 255, 0.06);
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    flex-wrap: wrap;
  }
  .item {
    display: grid;
    grid-template-columns: 22px minmax(0, 1fr) auto;
    gap: 8px;
    align-items: start;
    padding: 8px 10px;
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.025);
  }
  .item svg {
    color: var(--gold);
    margin-top: 1px;
  }
  details summary {
    cursor: pointer;
    color: #d8cfb5;
    margin: 6px 0;
  }
  .hist {
    display: grid;
    gap: 6px;
  }
  .hist .h {
    display: flex;
    gap: 10px;
    align-items: center;
    flex-wrap: wrap;
    padding: 8px 10px;
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.025);
  }
  .dash-head {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 16px;
    align-items: start;
  }
  .panel {
    border-radius: 16px;
    border: 1px solid var(--line);
    background: linear-gradient(170deg, rgba(22, 19, 12, 0.94), rgba(10, 10, 9, 0.96));
    padding: 16px;
    display: grid;
    gap: 12px;
    min-width: 0;
  }
  .back {
    all: unset;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: #cfc5a8;
    font-size: 12.5px;
    margin-bottom: 8px;
  }
  @media (max-width: 900px) {
    .dash-head {
      grid-template-columns: minmax(0, 1fr);
    }
    .row {
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 6px 10px;
    }
    .row > .c-group {
      grid-column: 2;
      grid-row: 1;
    }
    .row > .c-name {
      grid-column: 1;
      grid-row: 1;
    }
    .row > .c-merge,
    .row > .c-when,
    .row > .c-wt {
      grid-column: 1 / -1;
    }
  }
  @media (max-width: 560px) {
    .wrap {
      padding: 12px 12px 90px;
    }
    h1 {
      font-size: 19px;
    }
    .tiles {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
    .tile b {
      font-size: 18px;
    }
    .toolbar {
      position: static;
    }
    .seg {
      width: 100%;
    }
    .seg button {
      flex: 1;
      text-align: center;
      padding: 8px 4px;
    }
    .btn {
      min-height: 40px;
    }
    .modal-back {
      align-items: flex-end;
      padding: 0;
    }
    .modal {
      border-radius: 16px 16px 0 0;
      max-height: 92vh;
    }
  }
`;

@customElement("ib-repos-page")
export class ReposPage extends LitElement {
  static styles = pageStyles;

  @state() private repos: RepoSummary[] = [];
  @state() private projects: Record<string, string[]> = {};
  @state() private daily = false;
  @state() private loaded = false;
  @state() private error = "";
  @state() private repoKey: string | null = urlParam("repo");
  @state() private showSetup = urlParam("setup") === "1";
  @state() private report: HealthReport | null = null;
  @state() private scanning: ScanJobInfo | null = null;
  @state() private kind: Kind = "branches";
  @state() private groups = new Set<HealthGroup>();
  @state() private query = "";
  @state() private limit = PAGE;
  @state() private plan: CleanupPlan | null = null;
  @state() private planLoading = false;
  @state() private remotePicks = new Set<string>();
  @state() private running = false;
  @state() private result: CleanupManifest | null = null;
  @state() private manifests: ManifestSummary[] = [];
  @state() private setupDismissed = false;

  private off: (() => void) | null = null;
  private onPop = () => {
    const k = urlParam("repo");
    if (k !== this.repoKey) {
      this.repoKey = k;
      this.report = null;
      void this.loadRepo();
    }
    this.showSetup = urlParam("setup") === "1";
  };

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("popstate", this.onPop);
    void this.loadList();
    if (this.repoKey) void this.loadRepo();
    void onRepoEvents((event, p) => {
      if (event === "projects.repo.health.progress" && p.repoKey === this.repoKey) {
        this.scanning = { key: String(p.repoKey), startedAt: 0, phase: String(p.phase), done: Number(p.done), total: Number(p.total) };
      } else if (event === "projects.repo.health.changed") {
        if (p.repoKey === this.repoKey) {
          if (p.scanning) this.scanning = this.scanning ?? { key: String(p.repoKey), startedAt: Date.now(), phase: "starting", done: 0, total: 0 };
          else {
            this.scanning = null;
            void this.loadRepo(true);
          }
        }
        void this.loadList();
      } else if (event === "projects.repo.changed") {
        void this.loadList();
      }
    }).then((off) => {
      if (this.isConnected) this.off = off;
      else off();
    });
  }

  disconnectedCallback(): void {
    window.removeEventListener("popstate", this.onPop);
    this.off?.();
    this.off = null;
    super.disconnectedCallback();
  }

  private async loadList() {
    try {
      const res = await reposApi.list();
      this.repos = res.repos;
      this.projects = res.projects;
      this.daily = res.scan.daily;
      this.setupDismissed = Boolean(res.setup?.dismissedAt || res.setup?.completedAt);
      this.error = "";
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.loaded = true;
    }
  }

  private async loadRepo(quiet = false) {
    if (!this.repoKey) return;
    try {
      const res = await reposApi.healthGet({ repoKey: this.repoKey });
      this.report = res.report;
      this.scanning = res.scanning;
      if (!res.report && !res.scanning && !quiet) void this.scan();
      void reposApi.manifests({ repoKey: this.repoKey }).then((m) => (this.manifests = m.manifests)).catch(() => undefined);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
  }

  private async scan() {
    if (!this.repoKey) return;
    this.scanning = { key: this.repoKey, startedAt: Date.now(), phase: "starting", done: 0, total: 0 };
    try {
      await reposApi.healthScan({ repoKey: this.repoKey });
    } catch (e) {
      this.scanning = null;
      showRepoToast(e instanceof Error ? e.message : String(e));
    }
  }

  private openRepo(key: string | null) {
    this.repoKey = key;
    this.report = null;
    this.groups = new Set();
    this.query = "";
    this.limit = PAGE;
    setUrlParam("repo", key);
    if (key) void this.loadRepo();
    window.scrollTo?.({ top: 0 });
  }

  private async toggleDaily() {
    const next = !this.daily;
    this.daily = next;
    try {
      await reposApi.scheduleSet(next);
      showRepoToast(next ? "Daily scan on — it only reports, it never deletes" : "Daily scan off", "ok");
    } catch (e) {
      this.daily = !next;
      showRepoToast(e instanceof Error ? e.message : String(e));
    }
  }

  private async preview() {
    if (!this.repoKey) return;
    this.planLoading = true;
    this.result = null;
    this.plan = null;
    try {
      const res = await reposApi.cleanupPreview({ repoKey: this.repoKey }, [...this.remotePicks]);
      this.plan = res.plan;
    } catch (e) {
      showRepoToast(e instanceof Error ? e.message : String(e));
    } finally {
      this.planLoading = false;
    }
  }

  private async execute() {
    if (!this.plan) return;
    this.running = true;
    try {
      const res = await reposApi.cleanupExecute(this.plan.planId);
      this.result = res.manifest;
      this.plan = null;
      void this.loadRepo(true);
    } catch (e) {
      showRepoToast(e instanceof Error ? e.message : String(e));
    } finally {
      this.running = false;
    }
  }

  private async restore(id: string) {
    if (!this.repoKey) return;
    this.running = true;
    try {
      const res = await reposApi.restore({ repoKey: this.repoKey }, id);
      const ok = res.manifest.restoreLog?.filter((l) => l.ok).length ?? 0;
      showRepoToast(`Restored ${ok} item${ok === 1 ? "" : "s"} from ${id}`, "ok");
      this.result = null;
      void this.loadRepo(true);
    } catch (e) {
      showRepoToast(e instanceof Error ? e.message : String(e));
    } finally {
      this.running = false;
    }
  }

  // ── Rendering ──────────────────────────────────────────────────────

  private renderTiles(t: NonNullable<RepoSummary["lastHealth"]>["totals"], interactive: boolean) {
    const tile = (cls: string, n: number, label: string, group?: HealthGroup, kind?: Kind, sub?: string) => html`<button
      class="tile ${cls} ${group && this.groups.has(group) ? "on" : ""}"
      data-tile=${cls}
      ?disabled=${!interactive}
      @click=${() => {
        if (!interactive) return;
        if (kind) this.kind = kind;
        if (group) {
          const g = new Set(this.groups);
          if (g.has(group)) g.delete(group);
          else g.add(group);
          this.groups = g;
        }
      }}
    >
      <b>${n}</b><span>${label}</span>${sub ? html`<small>${sub}</small>` : nothing}
    </button>`;
    return html`<div class="tiles">
      ${tile("safe", t.safe + t.worktreesSafe, "Safe to delete", "safe", undefined, `${t.safe} branches · ${t.worktreesSafe} folders`)}
      ${tile("review", t.review, "Review", "review", "branches", `${t.uniqueWork} with unique work`)}
      ${tile("active", t.active, "Active", "active", "branches")}
      ${tile("protected", t.protected, "Protected", "protected", "branches")}
      ${tile("stash", t.stashes, "Stashes", undefined, "stashes")}
    </div>`;
  }

  private renderList(): TemplateResult {
    const setupOpen = this.showSetup || (this.loaded && this.repos.length === 0 && !this.setupDismissed);
    return html`
      <header class="top">
        <div>
          <h1>${icons.rocket} Repos & deploy</h1>
          <div class="sub">
            Where each repo deploys from, and which branches and worktrees are merged and safe to delete. Nothing is deleted
            without a preview and your confirmation, and every cleanup can be restored.
          </div>
        </div>
        <span class="grow"></span>
        <label class="toggle" title="Scan every repo once a day and send a notification. It never deletes anything.">
          <span class="switch ${this.daily ? "on" : ""}" role="switch" aria-checked=${this.daily ? "true" : "false"} tabindex="0"
            @click=${() => this.toggleDaily()}
            @keydown=${(e: KeyboardEvent) => (e.key === " " || e.key === "Enter") && this.toggleDaily()}></span>
          Daily scan (report only)
        </label>
        <button class="btn primary" data-add-repo @click=${() => {
          this.showSetup = true;
          setUrlParam("setup", "1");
        }}>${icons.plus}<span>Add a repo</span></button>
      </header>
      ${this.error ? html`<div class="warnbox">${this.error}</div>` : nothing}
      ${setupOpen
        ? html`<ib-repo-setup
            style="margin-bottom:18px"
            @setup-close=${() => {
              this.showSetup = false;
              this.setupDismissed = true;
              setUrlParam("setup", null);
              void this.loadList();
            }}
            @setup-open-repo=${(e: CustomEvent<string>) => {
              this.showSetup = false;
              setUrlParam("setup", null);
              this.openRepo(e.detail);
            }}
          ></ib-repo-setup>`
        : nothing}
      ${!this.loaded
        ? html`<div class="empty">Loading repos…</div>`
        : this.repos.length === 0
          ? setupOpen
            ? nothing
            : html`<div class="empty">No repos yet. Attach one to a project, or use <b>Add a repo</b>.</div>`
          : html`<div class="repos">${this.repos.map((r) => this.renderRepoCard(r))}</div>`}
    `;
  }

  private renderRepoCard(r: RepoSummary) {
    const t = r.lastHealth?.totals;
    const projects = this.projects[r.key] ?? [];
    return html`<section class="repo" data-repo-card=${r.name}>
      <div style="display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap">
        <div style="min-width:0;flex:1">
          <h2>${icons.folder}<span>${r.name}</span></h2>
          <div class="mono muted" style="margin-top:3px">${pathView(r.root)}</div>
          ${projects.length ? html`<div class="tags">${projects.map((p) => html`<span class="tag">${icons.kanban}${p}</span>`)}</div>` : nothing}
        </div>
        <button class="btn" data-open-health=${r.name} @click=${() => this.openRepo(r.key)}>${icons.activity}<span>Branch health</span></button>
      </div>
      <ib-repo-deploy-card .repoKey=${r.key}></ib-repo-deploy-card>
      ${t
        ? html`${this.renderTiles(t, false)}
            <div class="reclaim muted">
              <span>${icons.trash}</span>
              <span>Cleanup would reclaim <b style="color:#f0dc9a">${fmtBytes(t.reclaimBytes)}</b></span>
              <span>· scanned ${relTime(r.lastHealth?.at)}</span>
            </div>`
        : r.scanning
          ? html`<div class="muted">Scanning…</div>`
          : html`<div class="muted">Not scanned yet — open Branch health.</div>`}
    </section>`;
  }

  private queryHit(...vals: Array<string | undefined>) {
    const q = this.query.trim().toLowerCase();
    return !q || vals.some((v) => v?.toLowerCase().includes(q));
  }

  private renderBranch(b: BranchRow, report: HealthReport) {
    const wts = b.worktreePaths.map((p) => report.worktrees.find((w) => w.path === p)).filter(Boolean) as WorktreeRow[];
    const merged = b.mergedBy ? MERGED_LABEL[b.mergedBy] : b.mergedBy === null ? `${b.uniqueCommits ?? "?"} unique` : "unknown";
    return html`<div class="row" data-branch=${b.name} data-group=${b.group}>
      <div class="c-group"><span class="gbadge ${b.group}"><span class="dot ${b.group}"></span>${GROUP_META[b.group].label}</span></div>
      <div class="c-name">
        <div class="name">${b.name}</div>
        <div class="why">${b.reasons.join(" · ")}</div>
      </div>
      <div class="c-merge">
        <div class="tags" style="margin:0">
          <span class="tag ${b.mergedBy ? "ok" : b.mergedBy === null ? "warn" : ""}">${merged}</span>
          ${b.inOriginDeploy
            ? html`<span class="tag warn" title="Merged into origin's deploy branch, but the deploy folder has not pulled it">${icons.download}merged on origin · not pulled</span>`
            : b.uniqueWork
              ? html`<span class="tag warn" title="Work found nowhere in the deploy branch">${icons.alertCircle}unique work</span>`
              : nothing}
          ${b.pr
            ? html`<span class="tag ${b.pr.state === "MERGED" ? "ok" : ""}"
                ><a href=${b.pr.url ?? "#"} target="_blank" rel="noopener">PR #${b.pr.number} ${b.pr.state.toLowerCase()}${b.pr.baseRefName ? ` → ${b.pr.baseRefName}` : ""}</a></span
              >`
            : nothing}
        </div>
      </div>
      <div class="c-when">
        <div>${b.ahead ?? "?"} ahead · ${b.behind ?? "?"} behind</div>
        <div class="muted">${relTime(b.lastCommitAt)}${b.author ? ` · ${b.author}` : ""}</div>
      </div>
      <div class="c-wt">
        ${wts.length
          ? wts.map(
              (w) => html`<div class="mono">${pathView(w.path)}</div>
                <div class="tags" style="margin-top:2px">
                  <span class="tag ${w.dirty ? "warn" : "ok"}">${w.dirty ? `${w.dirtyCount} uncommitted` : "clean"}</span>
                  ${w.sizeBytes ? html`<span class="tag">${fmtBytes(w.sizeBytes)}</span>` : nothing}
                  ${w.activeBy.length ? html`<span class="tag" title=${w.activeBy.join("\n")}>${icons.activity}in use</span>` : nothing}
                </div>`,
            )
          : html`<span class="muted">${b.kind === "remote" ? "remote" : "no worktree"}</span>`}
      </div>
    </div>`;
  }

  private renderWorktree(w: WorktreeRow) {
    return html`<div class="row" data-worktree=${w.path} data-group=${w.group}>
      <div class="c-group"><span class="gbadge ${w.group}"><span class="dot ${w.group}"></span>${GROUP_META[w.group].label}</span></div>
      <div class="c-name">
        <div class="name">${pathView(w.path)}</div>
        <div class="why">${w.reasons.join(" · ")}</div>
      </div>
      <div class="c-merge"><span class="tag">${BRANCH_ICON}${w.branch ?? `detached ${w.head.slice(0, 8)}`}</span>${w.main ? html` <span class="tag">main folder</span>` : nothing}</div>
      <div class="c-when">
        <div>${w.sizeBytes ? fmtBytes(w.sizeBytes) : html`<span class="muted">size —</span>`}</div>
        <div class="muted">${w.lastActivityAt ? `touched ${relTime(w.lastActivityAt)}` : ""}</div>
      </div>
      <div class="c-wt">
        <div class="tags" style="margin:0">
          <span class="tag ${w.dirty ? "warn" : "ok"}">${w.dirty ? `${w.dirtyCount} uncommitted` : "clean"}</span>
          ${w.activeBy.slice(0, 2).map((a) => html`<span class="tag">${a}</span>`)}
        </div>
        ${w.dirtySample?.length ? html`<div class="mono muted" style="margin-top:3px;overflow-wrap:anywhere">${w.dirtySample.slice(0, 3).join("  ")}</div>` : nothing}
      </div>
    </div>`;
  }

  private renderStash(s: StashRow) {
    return html`<div class="row" data-stash=${s.ref}>
      <div class="c-group"><span class="gbadge review"><span class="dot review"></span>Review</span></div>
      <div class="c-name"><div class="name">${s.ref}</div><div class="why">${s.message}</div></div>
      <div class="c-merge"><span class="tag ${s.inDeploy ? "ok" : "warn"}">${s.inDeploy ? "changes already in deploy" : "may hold unique work"}</span></div>
      <div class="c-when"><div>${s.files} file${s.files === 1 ? "" : "s"}</div><div class="muted">${relTime(s.at)}</div></div>
      <div class="c-wt muted">${s.branch ? `on ${s.branch}` : ""} · never deleted by cleanup</div>
    </div>`;
  }

  private renderDashboard(): TemplateResult {
    const repo = this.repos.find((r) => r.key === this.repoKey);
    const rp = this.report;
    const t = rp?.totals;
    const prog = this.scanning && this.scanning.total ? Math.round((this.scanning.done / this.scanning.total) * 100) : this.scanning ? 8 : 0;

    let body: TemplateResult | typeof nothing = nothing;
    let shown = 0;
    let total = 0;
    if (rp) {
      const g = this.groups;
      const inGroup = (x: { group: HealthGroup }) => g.size === 0 || g.has(x.group);
      if (this.kind === "branches" || this.kind === "remote") {
        const list = rp.branches.filter(
          (b) => (this.kind === "branches" ? b.kind === "local" : b.kind === "remote") && inGroup(b) && this.queryHit(b.name, b.subject, b.author, ...b.worktreePaths),
        );
        const order = { review: 0, safe: 1, active: 2, protected: 3 } as const;
        list.sort((a, b) => order[a.group] - order[b.group] || b.lastCommitAt - a.lastCommitAt);
        total = list.length;
        const page = list.slice(0, this.limit);
        shown = page.length;
        body = html`${page.map((b) => this.renderBranch(b, rp))}`;
      } else if (this.kind === "worktrees") {
        const list = rp.worktrees.filter((w) => inGroup(w) && this.queryHit(w.path, w.branch));
        total = list.length;
        shown = list.length;
        body = html`${list.map((w) => this.renderWorktree(w))}`;
      } else {
        const list = rp.stashes.filter((s) => this.queryHit(s.message, s.branch, s.ref));
        total = list.length;
        shown = list.length;
        body = html`${list.map((s) => this.renderStash(s))}`;
      }
    }
    const safeCount = t ? t.safe + t.worktreesSafe : 0;
    return html`
      <button class="back" @click=${() => this.openRepo(null)}>${icons.arrowLeft} All repos</button>
      <header class="top">
        <div style="min-width:0">
          <h1>${icons.activity} ${repo?.name ?? rp?.name ?? "Repo"} <span class="muted" style="font-size:14px;font-weight:400">branch health</span></h1>
          <div class="sub mono">${pathView(repo?.root ?? rp?.root ?? "")}</div>
        </div>
        <span class="grow"></span>
        <button class="btn" data-scan ?disabled=${Boolean(this.scanning)} @click=${() => this.scan()}>${icons.refresh}<span>${this.scanning ? "Scanning…" : "Scan now"}</span></button>
        <button class="btn primary" data-cleanup ?disabled=${!rp || this.planLoading || Boolean(this.scanning)} @click=${() => this.preview()}>
          ${icons.trash}<span>${this.planLoading ? "Preparing preview…" : `Clean up safe branches${safeCount ? ` (${safeCount})` : ""}`}</span>
        </button>
      </header>
      ${this.scanning
        ? html`<div class="scanbar" title="${this.scanning.phase} ${this.scanning.done}/${this.scanning.total}"><i style="width:${prog}%"></i></div>`
        : nothing}
      <div class="dash-head" style="margin-top:12px">
        <ib-repo-deploy-card inPage .repoKey=${this.repoKey ?? undefined}
          @deploy-changed=${() => void this.scan()}></ib-repo-deploy-card>
        <div class="panel">
          ${t
            ? html`${this.renderTiles(t, true)}
                <div class="reclaim">
                  <span class="muted">Disk cleanup would reclaim</span>
                  <b style="color:#f0dc9a" data-reclaim>${fmtBytes(t.reclaimBytes)}</b>
                  <span class="gauge" aria-hidden="true">
                    ${GROUPS.map((g) => {
                      const n = g === "safe" ? t.safe : t[g];
                      const pct = t.branches ? (n / t.branches) * 100 : 0;
                      const color = { safe: "#5ad19a", review: "#f5b041", active: "#5aa9ff", protected: "#d4af37" }[g];
                      return html`<i style="width:${pct}%;background:${color}"></i>`;
                    })}
                  </span>
                </div>
                <div class="muted" style="font-size:12px">
                  ${t.branches} local · ${t.remoteBranches} remote (${t.remoteSafe} safe, only deleted when you tick them) · ${t.worktrees} worktrees ·
                  compared with <span class="mono">${rp?.deployBranch ?? rp?.defaultBranch ?? "—"}</span>
                  ${rp?.comparedAgainst === "default" ? html` <b style="color:#f5c46b">(no deploy branch yet — using the default branch)</b>` : nothing}
                  · ${rp?.gh.authed ? `GitHub: ${rp.gh.prs} PRs` : "GitHub not connected"}
                  · scanned ${relTime(rp?.scannedAt)} in ${((rp?.durationMs ?? 0) / 1000).toFixed(1)}s
                </div>`
            : html`<div class="muted">${this.scanning ? "First scan running — this takes a few seconds per hundred branches." : "No scan yet."}</div>`}
          ${rp?.warnings.length ? html`<div class="warnbox">${rp.warnings.map((w) => html`<div>${w}</div>`)}</div>` : nothing}
          ${t && t.stashes
            ? html`<div class="warnbox" data-stash-warning>
                <div><b>${t.stashes} stash${t.stashes === 1 ? "" : "es"}</b> can hide work. They are listed under Stashes and never deleted by cleanup.</div>
              </div>`
            : nothing}
        </div>
      </div>
      ${rp
        ? html`<div class="toolbar">
              <div class="seg" role="tablist">
                ${(
                  [
                    ["branches", `Branches ${t?.branches ?? ""}`],
                    ["remote", `Remote ${t?.remoteBranches ?? ""}`],
                    ["worktrees", `Worktrees ${t?.worktrees ?? ""}`],
                    ["stashes", `Stashes ${t?.stashes ?? ""}`],
                  ] as Array<[Kind, string]>
                ).map(
                  ([k, label]) => html`<button role="tab" class=${this.kind === k ? "on" : ""} data-kind=${k} @click=${() => {
                    this.kind = k;
                    this.limit = PAGE;
                  }}>${label}</button>`,
                )}
              </div>
              ${this.kind !== "stashes"
                ? GROUPS.map(
                    (g) => html`<button class="chip ${this.groups.has(g) ? "on" : ""}" data-group-chip=${g} title=${GROUP_META[g].hint} @click=${() => {
                      const s = new Set(this.groups);
                      if (s.has(g)) s.delete(g);
                      else s.add(g);
                      this.groups = s;
                    }}><span class="dot ${g}"></span>${GROUP_META[g].label}</button>`,
                  )
                : nothing}
              <label class="search">${icons.search}<input type="search" placeholder="Search branches, folders, authors" .value=${this.query}
                @input=${(e: Event) => {
                  this.query = (e.target as HTMLInputElement).value;
                  this.limit = PAGE;
                }} /></label>
            </div>
            <div class="muted" style="margin-bottom:8px;font-size:12px">Showing ${shown} of ${total}</div>
            <div class="rows" data-rows>${total ? body : html`<div class="empty">Nothing matches.</div>`}</div>
            ${shown < total ? html`<div style="text-align:center;margin-top:12px"><button class="btn" @click=${() => (this.limit += PAGE)}>Show ${Math.min(PAGE, total - shown)} more</button></div>` : nothing}
            ${this.renderHistory()}`
        : nothing}
      ${this.plan ? this.renderPlan(this.plan, rp) : nothing}
      ${this.result ? this.renderResult(this.result) : nothing}
    `;
  }

  private renderHistory() {
    if (!this.manifests.length) return nothing;
    return html`<div class="panel" style="margin-top:18px" data-history>
      <div style="display:flex;align-items:center;gap:8px"><span style="color:var(--gold)">${icons.clockRotate}</span><b>Past cleanups</b><span class="muted">— restore puts branches back at the same commit</span></div>
      <div class="hist">
        ${this.manifests.map(
          (m) => html`<div class="h">
            <span class="mono">${m.id}</span>
            <span class="muted">${m.deleted} removed · ${relTime(m.createdAt)}</span>
            ${m.restoredAt ? html`<span class="tag ok">restored ${relTime(m.restoredAt)}</span>` : nothing}
            <span class="grow"></span>
            <button class="btn" data-restore=${m.id} ?disabled=${this.running} @click=${() => this.restore(m.id)}>${icons.clockRotate}<span>Restore</span></button>
          </div>`,
        )}
      </div>
    </div>`;
  }

  private renderPlan(plan: CleanupPlan, rp: HealthReport | null) {
    const wts = plan.items.filter((i) => i.type === "worktree");
    const brs = plan.items.filter((i) => i.type === "branch");
    const remotes = plan.items.filter((i) => i.type === "remote-branch");
    const safeRemotes = (rp?.branches ?? []).filter((b) => b.kind === "remote" && b.group === "safe");
    return html`<div class="modal-back" @click=${() => (this.plan = null)}>
      <div class="modal" role="dialog" aria-modal="true" data-cleanup-preview @click=${(e: Event) => e.stopPropagation()}>
        <header>
          <h3>${icons.shieldCheck} Dry run — nothing has been deleted</h3>
          <div class="muted" style="margin-top:6px">
            ${plan.items.length} item${plan.items.length === 1 ? "" : "s"} would be removed, reclaiming <b style="color:#f0dc9a">${fmtBytes(plan.reclaimBytes)}</b>.
            A restore manifest is written first, so you can put everything back.
          </div>
        </header>
        <div class="body">
          ${plan.items.length === 0 ? html`<div class="empty">Nothing is safe to delete right now.</div>` : nothing}
          ${wts.length ? html`<b>Worktrees (${wts.length})</b>` : nothing}
          ${wts.map((i) => html`<div class="item" data-plan-item=${i.name}>${icons.folderMinus}<div><div class="mono">${pathView(i.name)}</div><div class="muted">${i.branch ?? "detached"} · ${i.reasons[0] ?? ""}</div></div><span class="muted">${fmtBytes(i.sizeBytes)}</span></div>`)}
          ${brs.length ? html`<b>Local branches (${brs.length})</b>` : nothing}
          ${brs.map((i) => html`<div class="item" data-plan-item=${i.name}>${icons.trash}<div><div class="mono">${pathView(i.name)}</div><div class="muted">${i.reasons[0] ?? ""}</div></div><span class="mono muted">${i.sha.slice(0, 8)}</span></div>`)}
          ${remotes.length ? html`<b>Remote branches you ticked (${remotes.length})</b>` : nothing}
          ${remotes.map((i) => html`<div class="item">${icons.globe}<div class="mono">${i.name}</div><span class="mono muted">${i.sha.slice(0, 8)}</span></div>`)}
          ${safeRemotes.length
            ? html`<details>
                <summary>Also delete merged remote branches on GitHub? (${safeRemotes.length} safe, off by default)</summary>
                ${safeRemotes.map(
                  (b) => html`<label class="item" style="cursor:pointer">
                    <input type="checkbox" .checked=${this.remotePicks.has(b.name)} @change=${(e: Event) => {
                      const s = new Set(this.remotePicks);
                      if ((e.target as HTMLInputElement).checked) s.add(b.name);
                      else s.delete(b.name);
                      this.remotePicks = s;
                    }} />
                    <span class="mono">${b.name}</span><span class="muted">${b.reasons[0] ?? ""}</span>
                  </label>`,
                )}
                <button class="btn" style="margin-top:6px" @click=${() => this.preview()}>${icons.refresh}<span>Update preview</span></button>
              </details>`
            : nothing}
          <details>
            <summary>Kept (${plan.skipped.length}) — and why</summary>
            ${plan.skipped.slice(0, 300).map((s) => html`<div class="item">${icons.lock}<div><div class="mono">${pathView(s.name)}</div><div class="muted">${s.reason}</div></div><span></span></div>`)}
          </details>
        </div>
        <footer>
          <button class="btn ghost" @click=${() => (this.plan = null)}>Cancel</button>
          <button class="btn danger" data-confirm-cleanup ?disabled=${this.running || plan.items.length === 0} @click=${() => this.execute()}>
            ${icons.trash}<span>${this.running ? "Cleaning up…" : `Delete ${plan.items.length} item${plan.items.length === 1 ? "" : "s"}`}</span>
          </button>
        </footer>
      </div>
    </div>`;
  }

  private renderResult(m: CleanupManifest) {
    const deleted = m.entries.filter((e) => e.status === "deleted");
    const other = m.entries.filter((e) => e.status !== "deleted");
    return html`<div class="modal-back" @click=${() => (this.result = null)}>
      <div class="modal" role="dialog" aria-modal="true" data-cleanup-result @click=${(e: Event) => e.stopPropagation()}>
        <header>
          <h3>${icons.checkCircle} Cleaned up ${deleted.length} item${deleted.length === 1 ? "" : "s"}</h3>
          <div class="muted" style="margin-top:6px">Restore manifest <span class="mono">${m.id}</span> — ${m.note}</div>
        </header>
        <div class="body">
          ${deleted.map((e) => html`<div class="item">${icons.check}<div class="mono">${pathView(e.name)}</div><span class="mono muted">${e.sha.slice(0, 8)}</span></div>`)}
          ${other.length ? html`<b>Not removed (${other.length})</b>` : nothing}
          ${other.map((e) => html`<div class="item">${icons.alertCircle}<div><div class="mono">${pathView(e.name)}</div><div class="muted">${e.status}: ${e.error ?? ""}</div></div><span></span></div>`)}
        </div>
        <footer>
          <button class="btn" data-restore-now ?disabled=${this.running} @click=${() => this.restore(m.id)}>${icons.clockRotate}<span>Restore</span></button>
          <button class="btn primary" @click=${() => (this.result = null)}>Done</button>
        </footer>
      </div>
    </div>`;
  }

  render() {
    return html`<div class="wrap">${this.repoKey ? this.renderDashboard() : this.renderList()}</div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ib-repos-page": ReposPage;
  }
}

export function renderRepos() {
  return html`<ib-repos-page></ib-repos-page>`;
}

export { openReposPage };
