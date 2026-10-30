/**
 * Project-scoped Knowledge Graph — the client half of
 * graph.global.snapshot({ projectId, hops }) (src/gateway/server-methods/
 * graph-project-scope.ts does the cutting on the gateway).
 *
 * Deep link: /knowledge-graph?project=<id>[&hops=N]  (/knowledge?project=…
 * aliases it) — what the project page's "Knowledge Graph" button opens and
 * what agents can open through ui_control.
 */

export const SCOPE_HOP_CHOICES = [1, 2, 3, 4] as const;
export const DEFAULT_SCOPE_HOPS = 2;

export type ProjectScope = { id: string; name: string | null; hops: number };

/** The gateway's `scope` block (see ProjectScopeInfo on the server). */
export type ProjectScopeInfo = {
  projectId: string;
  projectNodeId: string;
  label: string | null;
  found: boolean;
  hops: number;
  totalNodes: number;
  totalEdges: number;
  hubs: string[];
  capped: number;
  secureExcluded: number;
};

export function clampScopeHops(raw: unknown): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_SCOPE_HOPS;
  return Math.max(0, Math.min(4, Math.floor(n)));
}

/** `?project=<id>&hops=N` → scope; null when the URL isn't project-scoped. */
export function readProjectScope(search: string): ProjectScope | null {
  let sp: URLSearchParams;
  try {
    sp = new URLSearchParams(search);
  } catch {
    return null;
  }
  const raw = (sp.get("project") ?? "").trim();
  if (!raw) return null;
  const id = raw.replace(/^project:/, "").slice(0, 200);
  return { id, name: sp.get("projectName")?.slice(0, 120) || null, hops: clampScopeHops(sp.get("hops")) };
}

/** The deep-link route (no base path) for one project's graph. */
export function projectGraphRoute(projectId: string, opts: { name?: string | null; hops?: number } = {}): string {
  const sp = new URLSearchParams({ project: projectId });
  if (opts.name) sp.set("projectName", opts.name.slice(0, 120));
  if (opts.hops != null && opts.hops !== DEFAULT_SCOPE_HOPS) sp.set("hops", String(clampScopeHops(opts.hops)));
  return `/knowledge-graph?${sp.toString()}`;
}

/** RPC params that scope a snapshot request. */
export function scopeRequestParams(scope: ProjectScope | null): Record<string, unknown> {
  return scope ? { projectId: scope.id, hops: scope.hops } : {};
}

/** Read the `scope` block off a raw snapshot payload (sanitizeSnapshot drops it). */
export function scopeInfoOf(raw: unknown): ProjectScopeInfo | null {
  const s = raw && typeof raw === "object" ? (raw as { scope?: unknown }).scope : null;
  if (!s || typeof s !== "object") return null;
  const o = s as Record<string, unknown>;
  if (typeof o.projectNodeId !== "string") return null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    projectId: String(o.projectId ?? ""),
    projectNodeId: o.projectNodeId,
    label: typeof o.label === "string" ? o.label : null,
    found: o.found === true,
    hops: clampScopeHops(o.hops),
    totalNodes: num(o.totalNodes),
    totalEdges: num(o.totalEdges),
    hubs: Array.isArray(o.hubs) ? o.hubs.filter((h): h is string => typeof h === "string") : [],
    capped: num(o.capped),
    secureExcluded: num(o.secureExcluded),
  };
}

/** "12 of 840 nodes" — the scope chip's count line. */
export function scopeCountText(info: ProjectScopeInfo | null, shown: number): string {
  if (!info) return `${shown} node${shown === 1 ? "" : "s"}`;
  return `${shown.toLocaleString()} of ${info.totalNodes.toLocaleString()} nodes`;
}

/** Few connections → show the empty-state card (the project alone, or one link). */
export function scopeIsSparse(info: ProjectScopeInfo | null, shown: number): boolean {
  return !!info && (!info.found || shown <= 2);
}

/** Navigate the SPA to a project's graph (push + popstate, like deep links). */
export function openProjectGraph(projectId: string, opts: { name?: string | null; hops?: number; basePath?: string } = {}): void {
  if (typeof window === "undefined" || !projectId) return;
  const base = (opts.basePath ?? "").replace(/\/+$/, "");
  window.history.pushState({}, "", `${base}${projectGraphRoute(projectId, opts)}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/** Rewrite the current URL's scope params without a navigation (hops change / Show all). */
export function replaceScopeInUrl(scope: ProjectScope | null): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (scope) {
    url.searchParams.set("project", scope.id);
    if (scope.hops !== DEFAULT_SCOPE_HOPS) url.searchParams.set("hops", String(scope.hops));
    else url.searchParams.delete("hops");
  } else {
    url.searchParams.delete("project");
    url.searchParams.delete("hops");
    url.searchParams.delete("projectName");
  }
  window.history.replaceState(window.history.state, "", url.toString());
}
