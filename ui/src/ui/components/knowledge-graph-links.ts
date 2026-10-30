/**
 * Link styling for the knowledge graph: relation type → colour, width and
 * brightness, plus the "Connections" visibility mode (all / selected / none).
 *
 * Pure (no three, no DOM) so the mapping is unit-tested under node vitest.
 * Widths are screen pixels for the 3D ribbon layer; the 2D map reuses them.
 */

export type RelClass =
  | "hierarchy"
  | "tasks"
  | "client"
  | "relates"
  | "report"
  | "about"
  | "activity"
  | "inferred"
  | "other";

export interface RelStyle {
  cls: RelClass;
  label: string;
  color: string;
  /** Ribbon width in CSS px at full strength. */
  width: number;
  /** Base brightness 0..1 before focus/density. */
  alpha: number;
  /** Flow speed multiplier for the animated sheen (0 = still). */
  flow: number;
}

/** Legend order, strongest first. */
export const REL_STYLES: Record<RelClass, RelStyle> = {
  hierarchy: { cls: "hierarchy", label: "Parent → sub-project", color: "#f5c542", width: 3.6, alpha: 1, flow: 1 },
  tasks: { cls: "tasks", label: "Project → task", color: "#e8b04a", width: 2.4, alpha: 0.85, flow: 0.8 },
  client: { cls: "client", label: "Client / deal", color: "#ff9f43", width: 2.6, alpha: 0.9, flow: 0.7 },
  relates: { cls: "relates", label: "Relates to", color: "#5ee7ff", width: 1.9, alpha: 0.6, flow: 0.6 },
  report: { cls: "report", label: "Report", color: "#b48cff", width: 1.6, alpha: 0.62, flow: 0.5 },
  about: { cls: "about", label: "Note / mention", color: "#4fd1a5", width: 1.5, alpha: 0.6, flow: 0.5 },
  activity: { cls: "activity", label: "Agent activity", color: "#7cff6b", width: 1.7, alpha: 0.7, flow: 1.4 },
  inferred: { cls: "inferred", label: "Inferred", color: "#9aa4b8", width: 1.1, alpha: 0.38, flow: 0 },
  other: { cls: "other", label: "Other", color: "#a9bcd0", width: 1.3, alpha: 0.5, flow: 0.4 },
};

export const REL_LEGEND: RelClass[] = ["hierarchy", "tasks", "client", "relates", "report", "about", "activity"];

/** Classify a humanised relation label (graph-global `humaniseEdge`). */
export function relClassOf(rel: string, inferred = false): RelClass {
  if (inferred) return "inferred";
  const r = rel.toLowerCase().trim();
  if (r === "sub-project of" || r === "parent of" || r === "child of") return "hierarchy";
  if (r === "contains" || r === "has task" || r === "project has task" || r === "for project") return "tasks";
  if (r === "client of" || r === "for client" || r === "has opportunity" || r === "becomes project" || r.includes("opportunity")) return "client";
  if (r === "relates to" || r === "related" || r === "relates") return "relates";
  if (r.startsWith("report") || r === "reports on" || r.includes("documents")) return "report";
  if (r === "about" || r === "mentions" || r === "wrote" || r.includes("note")) return "about";
  if (r === "running" || r === "works on" || r === "spawned" || r.includes("agent")) return "activity";
  return "other";
}

export function linkStyle(rel: string, inferred = false): RelStyle {
  return REL_STYLES[relClassOf(rel, inferred)];
}

/**
 * Final ribbon width in px: relation width, scaled gently by the edge weight
 * (0.5–2 → ×0.85–×1.3) and thinned on very dense graphs so the hairball
 * stays legible. Always ≥ 0.8 px.
 */
export function linkWidth(style: RelStyle, weight = 1, density = 0): number {
  const w = Math.max(0.5, Math.min(2, Number.isFinite(weight) ? weight : 1));
  const wk = 0.85 + 0.3 * ((w - 0.5) / 1.5);
  const dk = 1 - 0.35 * Math.max(0, Math.min(1, density));
  return Math.max(0.8, style.width * wk * dk);
}

// ── Connections mode ────────────────────────────────────────────────

export type ConnectionsMode = "all" | "selected" | "none";
export const CONNECTIONS_MODES: Array<{ id: ConnectionsMode; label: string }> = [
  { id: "all", label: "All" },
  { id: "selected", label: "Selected" },
  { id: "none", label: "None" },
];

export interface LinkVisIn {
  mode: ConnectionsMode;
  /** Link touches the focused node. */
  focused: boolean;
  /** Focus exists (hover or selection). */
  hasFocus: boolean;
  /** Both endpoints are in the focus neighbourhood (neighbour↔neighbour). */
  inNeighbourhood: boolean;
  style: RelStyle;
  /** Endpoint emphasis (min of the two), 0..1. */
  emphasis: number;
  /** Link between two clusters/units. */
  cross: boolean;
  /** Mega-hub damping (1 = none). */
  hubDamp: number;
  density: number;
}

/**
 * Brightness of one link under the connections mode + focus. Focus+context:
 * the focused node's links go full, links among its neighbours stay readable,
 * everything else drops to a faint trace. Capped < 1 except for focus so the
 * additive glow never whites out.
 */
export function linkAlpha(v: LinkVisIn): number {
  if (v.mode === "none") return 0;
  if (v.focused) return 1;
  if (v.mode === "selected") return v.hasFocus && v.inNeighbourhood ? 0.35 : 0;
  if (v.hasFocus) return v.inNeighbourhood ? 0.32 : 0.05 * v.style.alpha;
  const cross = v.cross ? 0.75 : 1;
  const dens = 1 - 0.5 * Math.max(0, Math.min(1, v.density));
  return Math.min(0.9, v.style.alpha * cross * dens * v.hubDamp * (0.55 + 0.45 * v.emphasis));
}
