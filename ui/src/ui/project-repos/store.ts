/**
 * Project repos — shared client store.
 *
 * One cached map of projectId → attached git repo (projects.repo.status),
 * shared by every badge / picker / KG surface so the gateway is asked once,
 * not once per card. Refreshes on `projects.repo.changed` and on project
 * updates from `kanban.changed`, and at most every 30 s otherwise.
 */

import { awaitGatewayClient, type GatewayBrowserClient } from "../gateway-client";

export interface RepoCommit {
  sha: string;
  subject: string;
  at: number;
  author?: string;
}

export interface RepoInfo {
  path: string;
  root: string | null;
  isRepo: boolean;
  name: string;
  branch?: string;
  detached?: boolean;
  remote?: string;
  remoteSlug?: string;
  lastCommit?: RepoCommit;
  dirtyCount?: number;
  dirty?: boolean;
  upstream?: string;
  ahead?: number;
  behind?: number;
  worktree?: boolean;
  error?: string;
  checkedAt: number;
}

export interface ProjectRepo extends RepoInfo {
  projectId: string;
  projectName: string;
  source: "registry" | "projectDirectory" | "githubLocalPath";
  repoKey?: string;
  deploy?: {
    branch: string;
    worktreePath: string;
    target?: { kind: string; name?: string };
    source: "manual" | "auto";
    confidence?: number;
  };
  rev?: number;
  /** Background git inspection still running (just attached). */
  scanning?: boolean;
  /** Optimistic row — the save RPC has not answered yet. */
  pending?: boolean;
}

/** Timings of the last attach (click → card visible, save RPC round-trip). */
export interface AttachTiming {
  projectId: string;
  clickToVisibleMs: number;
  saveRpcMs?: number;
  ok?: boolean;
  at: number;
}

export interface BrowseEntry {
  name: string;
  path: string;
  isRepo: boolean;
  hidden: boolean;
  repo?: RepoInfo;
}

export interface BrowseResult {
  path: string;
  parent: string | null;
  isRepo: boolean;
  repo?: RepoInfo;
  entries: BrowseEntry[];
  truncated: boolean;
  roots: Array<{ label: string; path: string }>;
}

export interface RepoSuggestions {
  recent: RepoInfo[];
  development: RepoInfo[];
  root: string;
}

export const PROJECT_REPOS_CHANGED = "ib-project-repos-changed";

type Listener = () => void;

const state: {
  repos: Map<string, ProjectRepo>;
  loadedAt: number;
  inflight: Promise<Map<string, ProjectRepo>> | null;
  unsub: (() => void) | null;
  error: string | null;
} = { repos: new Map(), loadedAt: 0, inflight: null, unsub: null, error: null };

const listeners = new Set<Listener>();
const STALE_MS = 30_000;

function emit() {
  for (const l of listeners) {
    try {
      l();
    } catch {
      /* listener errors are not ours */
    }
  }
  window.dispatchEvent(new CustomEvent(PROJECT_REPOS_CHANGED));
}

export function onProjectReposChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getProjectRepo(projectId: string | null | undefined): ProjectRepo | null {
  if (!projectId) return null;
  return state.repos.get(projectId) ?? null;
}

export function listProjectRepos(): ProjectRepo[] {
  return [...state.repos.values()].sort((a, b) => a.projectName.localeCompare(b.projectName));
}

export function projectReposLoaded(): boolean {
  return state.loadedAt > 0;
}

function wireEvents(client: GatewayBrowserClient) {
  if (state.unsub) return;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const later = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void loadProjectRepos({ force: true }), 400);
  };
  state.unsub = client.subscribe((evt) => {
    // Other clients' attach/detach, our own "inspected" follow-up, fs hits.
    if (evt.event === "projects.repo.changed") later();
    else if (evt.event === "kanban:changed") {
      const p = evt.payload as { entity?: string } | undefined;
      if (!p || p.entity === "project") later();
    }
  });
}

/** Load (or reuse) the projectId → repo map. */
export async function loadProjectRepos(
  opts: { force?: boolean; fresh?: boolean } = {},
): Promise<Map<string, ProjectRepo>> {
  if (!opts.force && state.loadedAt && Date.now() - state.loadedAt < STALE_MS) return state.repos;
  if (state.inflight) return state.inflight;
  state.inflight = (async () => {
    try {
      const client = await awaitGatewayClient(15_000);
      wireEvents(client);
      const res = await client.request<{ repos: Record<string, ProjectRepo> }>(
        "projects.repo.status",
        opts.fresh ? { fresh: true } : {},
      );
      const next = new Map(Object.entries(res?.repos ?? {}));
      // A load that started before an optimistic attach must not wipe it.
      for (const [id, r] of state.repos) if (r.pending) next.set(id, r);
      for (const [id, at] of recentlyDetached) {
        if (Date.now() - at < 8000) next.delete(id);
        else recentlyDetached.delete(id);
      }
      state.repos = next;
      state.error = null;
    } catch (e) {
      state.error = e instanceof Error ? e.message : String(e);
    } finally {
      state.loadedAt = Date.now();
      state.inflight = null;
    }
    emit();
    return state.repos;
  })();
  return state.inflight;
}

let lastAttachTiming: AttachTiming | null = null;

export function getLastAttachTiming(): AttachTiming | null {
  return lastAttachTiming;
}

/** One entry per attach (updated in place as the paint and the RPC land). */
function recordTiming(t: AttachTiming) {
  lastAttachTiming = t;
  const w = window as unknown as { __ibRepoAttachTiming?: AttachTiming[] };
  const list = (w.__ibRepoAttachTiming ?? []).filter((x) => !(x.at === t.at && x.projectId === t.projectId));
  w.__ibRepoAttachTiming = [...list.slice(-19), t];
}

/** Small bottom toast for background failures (attach rollback, etc.). */
export function showRepoToast(message: string, kind: "error" | "ok" = "error"): void {
  const el = document.createElement("div");
  el.setAttribute("role", "status");
  el.setAttribute("data-repo-toast", kind);
  el.textContent = message;
  el.style.cssText = `position:fixed;left:50%;bottom:calc(24px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);z-index:2147483000;max-width:min(560px,calc(100vw - 32px));padding:10px 16px;border-radius:12px;font:13px/1.4 system-ui,sans-serif;color:${kind === "error" ? "#ffd7d0" : "#f3e7c1"};background:${kind === "error" ? "rgba(70,18,14,0.95)" : "rgba(24,20,10,0.95)"};border:1px solid ${kind === "error" ? "rgba(255,120,100,0.5)" : "rgba(212,175,55,0.5)"};box-shadow:0 10px 40px rgba(0,0,0,0.5)`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

/**
 * Attach a repo. Optimistic: the card shows the repo immediately (scanning),
 * the save RPC runs after, and only a failed save rolls back (with a toast).
 * `preview` lets the caller pass what it already knows (picker selection).
 */
export async function attachProjectRepo(
  projectId: string,
  path: string,
  opts: { projectName?: string; preview?: RepoInfo | null } = {},
): Promise<ProjectRepo> {
  const t0 = performance.now();
  recentlyDetached.delete(projectId);
  const prev = state.repos.get(projectId) ?? null;
  const name = path.split("/").filter(Boolean).pop() || path;
  const optimistic: ProjectRepo = {
    ...(opts.preview && opts.preview.isRepo ? opts.preview : {}),
    path,
    root: opts.preview?.root ?? path,
    isRepo: true,
    name: opts.preview?.name ?? name,
    checkedAt: Date.now(),
    projectId,
    projectName: opts.projectName ?? prev?.projectName ?? "",
    source: "registry",
    deploy: prev?.root === path ? prev?.deploy : undefined,
    scanning: true,
    pending: true,
  };
  state.repos.set(projectId, optimistic);
  emit();
  const timing: AttachTiming = { projectId, clickToVisibleMs: 0, at: Date.now() };
  // Measured after the next paint, so it is what the owner actually sees.
  requestAnimationFrame(() => {
    timing.clickToVisibleMs = Math.round(performance.now() - t0);
    recordTiming(timing);
  });
  const tRpc = performance.now();
  try {
    const client = await awaitGatewayClient();
    const res = await client.request<{ repo: ProjectRepo }>("projects.repo.attach", {
      projectId,
      path,
      projectName: opts.projectName,
    });
    timing.saveRpcMs = Math.round(performance.now() - tRpc);
    timing.ok = true;
    recordTiming(timing);
    // Keep any richer optimistic fields (branch/remote) until the inspection lands.
    const merged: ProjectRepo = { ...optimistic, ...res.repo, pending: false };
    state.repos.set(projectId, merged);
    emit();
    return merged;
  } catch (e) {
    timing.saveRpcMs = Math.round(performance.now() - tRpc);
    timing.ok = false;
    recordTiming(timing);
    if (prev) state.repos.set(projectId, prev);
    else state.repos.delete(projectId);
    emit();
    const msg = e instanceof Error ? e.message : String(e);
    showRepoToast(`Could not attach the repo: ${msg}`);
    throw e;
  }
}

/** Detach — optimistic too; a failed save restores the badge. */
const recentlyDetached = new Map<string, number>();

export async function detachProjectRepo(projectId: string): Promise<void> {
  const prev = state.repos.get(projectId) ?? null;
  state.repos.delete(projectId);
  recentlyDetached.set(projectId, Date.now());
  emit();
  try {
    const client = await awaitGatewayClient();
    await client.request("projects.repo.detach", { projectId, projectName: prev?.projectName });
  } catch (e) {
    recentlyDetached.delete(projectId);
    if (prev) state.repos.set(projectId, prev);
    emit();
    showRepoToast(`Could not detach the repo: ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  }
}

// Folder listings / suggestions are cached so the picker opens instantly;
// a background refresh keeps them current (stale-while-revalidate).
const browseCache = new Map<string, { at: number; value: BrowseResult }>();
let suggestionsCache: { at: number; value: RepoSuggestions } | null = null;
let suggestionsInflight: Promise<RepoSuggestions> | null = null;
const LIST_TTL_MS = 30_000;

export function cachedBrowse(path?: string): BrowseResult | null {
  return browseCache.get(path ?? "")?.value ?? null;
}

export function cachedRepoSuggestions(): RepoSuggestions | null {
  return suggestionsCache?.value ?? null;
}

export async function browseRepoDirs(path?: string, showHidden = false): Promise<BrowseResult> {
  const key = `${path ?? ""}${showHidden ? "\0h" : ""}`;
  const hit = browseCache.get(key);
  if (hit && Date.now() - hit.at < LIST_TTL_MS) return hit.value;
  const client = await awaitGatewayClient();
  const value = await client.request<BrowseResult>("projects.repo.browse", { path, showHidden });
  browseCache.set(key, { at: Date.now(), value });
  if (value.path !== path) browseCache.set(`${value.path}${showHidden ? "\0h" : ""}`, { at: Date.now(), value });
  if (browseCache.size > 80) browseCache.delete(browseCache.keys().next().value as string);
  return value;
}

export async function loadRepoSuggestions(opts: { force?: boolean } = {}): Promise<RepoSuggestions> {
  if (!opts.force && suggestionsCache && Date.now() - suggestionsCache.at < LIST_TTL_MS) {
    return suggestionsCache.value;
  }
  if (suggestionsInflight) return suggestionsInflight;
  suggestionsInflight = (async () => {
    try {
      const client = await awaitGatewayClient();
      const value = await client.request<RepoSuggestions>("projects.repo.suggestions", {});
      suggestionsCache = { at: Date.now(), value };
      return value;
    } finally {
      suggestionsInflight = null;
    }
  })();
  return suggestionsInflight;
}

/** Warm the picker caches (call on hover / page load). */
export function prefetchRepoPicker(): void {
  void loadRepoSuggestions().catch(() => undefined);
}

// ── Formatting helpers (shared by badge + picker) ─────────────────────

export function repoDisplayName(r: Pick<RepoInfo, "name" | "remoteSlug">): string {
  return r.remoteSlug ? r.remoteSlug.split("/")[1] || r.name : r.name;
}

export function relTime(ms: number | undefined): string {
  if (!ms) return "";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86_400 * 30) return `${Math.floor(s / 86_400)}d ago`;
  return new Date(ms).toLocaleDateString();
}

/** "main · 3 changed · ↑2 ↓1" */
export function repoStatusSummary(r: RepoInfo): string {
  const parts: string[] = [];
  if (r.branch) parts.push(r.detached ? `detached @ ${r.branch}` : r.branch);
  parts.push(r.dirty ? `${r.dirtyCount ?? "?"} changed` : "clean");
  if (r.ahead) parts.push(`↑${r.ahead}`);
  if (r.behind) parts.push(`↓${r.behind}`);
  return parts.join(" · ");
}

export function repoTooltip(r: RepoInfo): string {
  return [
    r.root ?? r.path,
    repoStatusSummary(r),
    r.remote ? `remote: ${r.remote}` : "no remote",
    r.upstream ? `upstream: ${r.upstream}` : "",
    r.lastCommit ? `last: ${r.lastCommit.subject} (${relTime(r.lastCommit.at)})` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Label for a native <option>/<select> project entry: "Name  ⎇ repo" when
 * the project has a repo (options cannot hold elements, so it is text).
 */
export function projectOptionLabel(name: string, projectId: string | null | undefined): string {
  const r = getProjectRepo(projectId);
  return r ? `${name}  ⎇ ${repoDisplayName(r)}` : name;
}
