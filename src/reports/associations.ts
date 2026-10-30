/**
 * Report ↔ business-object associations.
 *
 * A rendered report (src/reports) is an *artifact about* something: a client
 * QBR, an opportunity brief, a project status. Before this, that link lived
 * only in the title text, so "show me everything we've produced for this
 * client" was unanswerable.
 *
 * The binding is stored in the typed-edge relations layer (src/relations), not
 * as a column on the reports table:
 *
 *   report --report_documents_client-->       client
 *   report --report_documents_opportunity-->  opportunity
 *   report --report_documents_project-->      project
 *
 * `from` is always the report, so `linksFrom("report", id)` answers "what does
 * this report cover?" and `linksTo("client", id)` answers "which reports cover
 * this client?" — and the report node shows up in `objrel.graph` alongside the
 * rest of the business graph for free.
 *
 * Keeping it in objrel means the reports store stays independent of the
 * business objects (and vice versa): neither schema changes, and a new
 * associatable object type is one entry in the map below.
 */

import { getRelationsStore } from "../relations/store.js";
import type { ObjectRelation } from "../relations/types.js";
import { getReportsStore } from "./store.js";
import { toReportWire, type ReportWire } from "./helpers/wire.js";

/** Object types a report may be associated with. */
export const REPORT_TARGET_TYPES = ["client", "opportunity", "project"] as const;
export type ReportTargetType = (typeof REPORT_TARGET_TYPES)[number];

/** The typed edge used for each target type. */
export const REPORT_EDGE_BY_TARGET: Record<ReportTargetType, string> = {
  client: "report_documents_client",
  opportunity: "report_documents_opportunity",
  project: "report_documents_project",
};

/** The edge for a target type, or null when the type isn't associatable. */
export function edgeForTarget(targetType: string): string | null {
  return REPORT_EDGE_BY_TARGET[targetType as ReportTargetType] ?? null;
}

export function isReportTargetType(t: string): t is ReportTargetType {
  return (REPORT_TARGET_TYPES as readonly string[]).includes(t);
}

/** One association, flattened for the wire. */
export interface ReportObjectAssociation {
  /** objrel row id — pass to `reports.unlink` for an exact removal. */
  relationId: string;
  reportId: string;
  targetType: string;
  targetId: string;
  edge: string;
  createdAt: number;
  createdBy: string;
}

function toAssociation(r: ObjectRelation): ReportObjectAssociation {
  return {
    relationId: r.id,
    reportId: r.fromId,
    targetType: r.toType,
    targetId: r.toId,
    edge: r.edge,
    createdAt: r.createdAt,
    createdBy: r.createdBy,
  };
}

/**
 * Associate a report with a business object. Idempotent — the underlying store
 * de-dupes on the (from, edge, to) identity, so re-linking returns the existing
 * edge instead of a duplicate.
 *
 * Throws when the target type isn't associatable or the report doesn't exist;
 * a dangling edge to a report id that was never registered is worse than a
 * clear error at link time.
 */
export function linkReport(params: {
  reportId: string;
  targetType: string;
  targetId: string;
  createdBy?: string;
  meta?: Record<string, unknown>;
}): ReportObjectAssociation {
  const edge = edgeForTarget(params.targetType);
  if (!edge) {
    throw new Error(
      `targetType must be one of ${REPORT_TARGET_TYPES.join(", ")} (got "${params.targetType}")`,
    );
  }
  if (!params.reportId) throw new Error("reportId is required");
  if (!params.targetId) throw new Error("targetId is required");
  if (!getReportsStore().getReport(params.reportId)) {
    throw new Error(`report "${params.reportId}" not found`);
  }
  const rel = getRelationsStore().create({
    fromType: "report",
    fromId: params.reportId,
    edge,
    toType: params.targetType,
    toId: params.targetId,
    createdBy: params.createdBy || "system",
    meta: params.meta ?? {},
  });
  return toAssociation(rel);
}

/**
 * Remove associations. With `targetType`+`targetId` it removes that one edge;
 * with only `reportId` it removes every association the report has.
 * Returns the number of edges deleted.
 */
export function unlinkReport(params: {
  relationId?: string;
  reportId?: string;
  targetType?: string;
  targetId?: string;
}): number {
  const store = getRelationsStore();
  if (params.relationId) return store.delete(params.relationId) ? 1 : 0;
  if (!params.reportId) throw new Error("provide relationId, or reportId (+ optional target)");

  if (params.targetType && params.targetId) {
    const edge = edgeForTarget(params.targetType);
    if (!edge) throw new Error(`targetType must be one of ${REPORT_TARGET_TYPES.join(", ")}`);
    return store.deleteMatch({
      fromType: "report",
      fromId: params.reportId,
      edge,
      toType: params.targetType,
      toId: params.targetId,
    });
  }
  // All associations for this report — only the report_documents_* edges, so an
  // unrelated `relates_to` link someone added by hand survives.
  let deleted = 0;
  for (const edge of Object.values(REPORT_EDGE_BY_TARGET)) {
    deleted += store.deleteMatch({ fromType: "report", fromId: params.reportId, edge });
  }
  return deleted;
}

/** Every object a given report is associated with. */
export function associationsForReport(reportId: string): ReportObjectAssociation[] {
  if (!reportId) return [];
  const edges = new Set(Object.values(REPORT_EDGE_BY_TARGET));
  return getRelationsStore()
    .linksFrom("report", reportId)
    .filter((r) => edges.has(r.edge))
    .map(toAssociation)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Every report associated with one business object, newest first.
 *
 * This is the join the detail views need: objrel gives the report ids, the
 * reports store gives the rows. Edges whose report row has since been deleted
 * are skipped (and reported via `missing`) rather than surfacing as blank
 * entries — reports can be deleted independently of their edges.
 */
export function reportsForObject(
  targetType: string,
  targetId: string,
  opts: { limit?: number } = {},
): { reports: ReportWire[]; associations: ReportObjectAssociation[]; missing: string[] } {
  const edge = edgeForTarget(targetType);
  if (!edge) {
    throw new Error(`type must be one of ${REPORT_TARGET_TYPES.join(", ")} (got "${targetType}")`);
  }
  if (!targetId) throw new Error("id is required");

  const relStore = getRelationsStore();
  const reportStore = getReportsStore();
  const rels = relStore
    .linksTo(targetType, targetId)
    .filter((r) => r.edge === edge && r.fromType === "report")
    .sort((a, b) => b.createdAt - a.createdAt);

  const limit = typeof opts.limit === "number" && opts.limit > 0 ? opts.limit : rels.length;

  const reports: ReportWire[] = [];
  const associations: ReportObjectAssociation[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const rel of rels) {
    if (reports.length >= limit) break;
    if (seen.has(rel.fromId)) continue;
    seen.add(rel.fromId);
    const wire = toReportWire(reportStore.getReport(rel.fromId));
    if (!wire) {
      missing.push(rel.fromId);
      continue;
    }
    reports.push(wire);
    associations.push(toAssociation(rel));
  }
  return { reports, associations, missing };
}

/** The optional association targets any report-producing call may carry. */
export interface ReportAssociationTargets {
  clientId?: string;
  opportunityId?: string;
  projectId?: string;
}

/** True when at least one target id is present. */
export function hasAssociationTargets(t: ReportAssociationTargets | undefined): boolean {
  return !!(t && (t.clientId || t.opportunityId || t.projectId));
}

/** Read `{clientId, opportunityId, projectId}` out of a loose params bag. */
export function readAssociationTargets(
  params: Record<string, unknown> | null | undefined,
): ReportAssociationTargets {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  return {
    clientId: str(params?.clientId),
    opportunityId: str(params?.opportunityId),
    projectId: str(params?.projectId),
  };
}

/**
 * Auto-associate a freshly-generated report with whichever targets were passed.
 *
 * Best-effort by design: a report that renders but fails to link must still be
 * returned to the caller, so failures are collected and reported rather than
 * thrown. Call this everywhere a report id first comes into existence
 * (`reports.render`, `reports.sendToTelegram`, `reports.generate`).
 */
export function autoLinkReport(
  reportId: string,
  targets: ReportAssociationTargets,
  createdBy = "system",
): { linked: ReportObjectAssociation[]; errors: string[] } {
  const linked: ReportObjectAssociation[] = [];
  const errors: string[] = [];
  if (!reportId) return { linked, errors };

  const pairs: Array<[ReportTargetType, string | undefined]> = [
    ["client", targets.clientId],
    ["opportunity", targets.opportunityId],
    ["project", targets.projectId],
  ];
  for (const [targetType, targetId] of pairs) {
    if (!targetId) continue;
    try {
      linked.push(linkReport({ reportId, targetType, targetId, createdBy }));
    } catch (e) {
      errors.push(`${targetType}:${targetId} — ${String(e)}`);
    }
  }
  return { linked, errors };
}
