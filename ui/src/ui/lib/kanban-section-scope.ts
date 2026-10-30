/**
 * Pure scoping logic for the embedded Kanban sections on the home Dashboard
 * (core, plugin off) and Business HQ (business-agency plugin on).
 *
 * - "all"      → the standard, full board: every project + every task.
 * - "business" → the business board: projects linked to a business
 *                (`KanbanProject.businessId`, optionally narrowed to the
 *                active business filter), their sub-projects, and the HQ
 *                object boards (Clients / Opportunities / CEO queue …) that
 *                Business HQ itself reads. Tasks follow their project.
 *
 * Business scoping belongs to the business-agency plugin, so the effective
 * scope collapses to "all" whenever the plugin is off — the section then shows
 * the core board instead of an empty business board.
 */

export type KanbanSectionScope = "all" | "business";

/** Sentinel the agency legacy migration stamps on projects it couldn't place. */
export const LEGACY_UNASSIGNED_BUSINESS_ID = "legacy-unassigned";

type ProjectLike = { id: string; businessId?: string | null; parentProjectId?: string | null };
type TaskLike = { projectId?: string | null; status?: string | null };

export function isRealBusinessId(id: string | null | undefined): id is string {
  return typeof id === "string" && id.trim().length > 0 && id !== LEGACY_UNASSIGNED_BUSINESS_ID;
}

/** Business scope only exists while the business-agency plugin is on. */
export function effectiveSectionScope(
  requested: KanbanSectionScope,
  businessPluginOn: boolean,
): KanbanSectionScope {
  return businessPluginOn && requested === "business" ? "business" : "all";
}

export interface BusinessBoardOptions {
  /** Active business filter (null = every business). */
  activeBusinessId?: string | null;
  /** Business HQ's object-board parent project (detected or configured). */
  hqParentProjectId?: string | null;
}

/** Ids of the projects that make up the business board. */
export function businessProjectIds<P extends ProjectLike>(
  projects: readonly P[],
  opts: BusinessBoardOptions = {},
): Set<string> {
  const active = isRealBusinessId(opts.activeBusinessId) ? opts.activeBusinessId : null;
  const ids = new Set<string>();
  for (const p of projects) {
    if (!isRealBusinessId(p.businessId)) continue;
    if (active && p.businessId !== active) continue;
    ids.add(p.id);
  }
  // HQ object boards are business by definition — unless a specific business
  // is selected, in which case only boards linked to it count.
  const hq = opts.hqParentProjectId;
  if (hq && !active && projects.some((p) => p.id === hq)) ids.add(hq);

  // Sub-projects inherit their parent's business (fixed point over the tree).
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of projects) {
      if (!ids.has(p.id) && p.parentProjectId && ids.has(p.parentProjectId)) {
        ids.add(p.id);
        grew = true;
      }
    }
  }
  return ids;
}

export function selectSectionBoard<P extends ProjectLike, T extends TaskLike>(
  projects: readonly P[],
  tasks: readonly T[],
  scope: KanbanSectionScope,
  opts: BusinessBoardOptions = {},
): { projects: P[]; tasks: T[] } {
  if (scope === "all") return { projects: [...projects], tasks: [...tasks] };
  const ids = businessProjectIds(projects, opts);
  return {
    projects: projects.filter((p) => ids.has(p.id)),
    tasks: tasks.filter((t) => !!t.projectId && ids.has(t.projectId)),
  };
}

/** Open (not done) task count — the number shown in the section header. */
export function openTaskCount(tasks: readonly TaskLike[]): number {
  let n = 0;
  for (const t of tasks) if (t.status !== "done") n++;
  return n;
}
