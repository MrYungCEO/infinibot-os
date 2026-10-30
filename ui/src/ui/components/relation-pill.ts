/**
 * Relation Pill — unified, glassmorphism-styled label for any cross-domain
 * link in the UI (a row referencing a business / project / database / kanban
 * task / contact / agent / workspace, etc.).
 *
 * Single source of truth so every list, card, and metadata strip across the
 * app — workspace, editor, kanban, notes, databases, focus, voice chat,
 * activity, etc. — surfaces relations the same way: HUD-tinted glass pill,
 * kind-coloured accent, optional status dot, optional click-through.
 *
 * Usage:
 *   import { renderRelationPill, ensureRelationPillStyles } from "../components/relation-pill";
 *   ensureRelationPillStyles();   // once per view, near top of render
 *   ${renderRelationPill({ kind: "business", id: biz.id, label: biz.name, onClick: () => navTo(biz) })}
 *
 * Or pull the standalone styles via `relationPillStyles` if your view
 * already injects its own <style> block (some views in this repo do that
 * via Lit's html``).
 */

import { html, type TemplateResult } from "lit";
import { icon, type IconName } from "../icons.js";

// ── Kinds ──────────────────────────────────────────────────────────

/**
 * Every cross-domain reference in InfiniBot maps to one of these kinds.
 * The pill colour, default icon, and accessibility label key off this.
 */
export type RelationKind =
  | "business"
  | "project"
  | "database"
  | "row"
  | "task"
  | "note"
  | "contact"
  | "client"
  | "lead"
  | "agent"
  | "workspace"
  | "session"
  | "composition"
  | "site"
  | "form"
  | "skill"
  | "url"
  | "file";

export interface RelationPillInput {
  kind: RelationKind;
  /** Unique id for the related entity (used for keyed lists / a11y). */
  id?: string;
  /** Display label — typically the entity's name. */
  label: string;
  /** Optional secondary line of context shown after a separator. */
  context?: string;
  /** Optional status — surfaces as a coloured dot before the label. */
  status?: "active" | "draft" | "paused" | "done" | "blocked" | "archived" | "pending";
  /** Override the icon for this pill — defaults from the kind. */
  iconName?: IconName;
  /** Hide the leading icon entirely. */
  hideIcon?: boolean;
  /** When set, pill renders as a button with this click handler. */
  onClick?: (e: Event) => void;
  /** When set + no onClick, pill renders as a link. */
  href?: string;
  /** Compact variant (smaller padding + 9px font). */
  compact?: boolean;
  /** Title attribute on the pill — falls back to "<kind> — <label>". */
  title?: string;
  /** Suppress the kind label prefix (just show name). */
  hideKindLabel?: boolean;
}

// ── Defaults per kind ─────────────────────────────────────────────

interface KindStyle {
  iconName: IconName;
  label: string;
  /** CSS custom-property values applied to --rp-tint / --rp-edge. */
  tint: string;
  edge: string;
  fg: string;
}

function styleFor(kind: RelationKind): KindStyle {
  switch (kind) {
    case "business":
      return { iconName: "briefcase", label: "Biz",     tint: "212, 175, 55",   edge: "212, 175, 55",   fg: "#d4af37" };
    case "project":
      return { iconName: "layout",    label: "Project", tint: "139, 92, 246",   edge: "139, 92, 246",   fg: "#c4b5fd" };
    case "database":
      return { iconName: "database",  label: "DB",      tint: "16, 185, 129",   edge: "16, 185, 129",   fg: "#6ee7b7" };
    case "row":
      return { iconName: "layoutList",label: "Row",     tint: "94, 234, 212",   edge: "94, 234, 212",   fg: "#5eead4" };
    case "task":
      return { iconName: "check",     label: "Task",    tint: "59, 130, 246",   edge: "59, 130, 246",   fg: "#93c5fd" };
    case "note":
      return { iconName: "fileText",  label: "Note",    tint: "248, 200, 100",  edge: "248, 200, 100",  fg: "#fde68a" };
    case "contact":
      return { iconName: "person",    label: "Contact", tint: "236, 72, 153",   edge: "236, 72, 153",   fg: "#f9a8d4" };
    case "client":
      return { iconName: "users",     label: "Client",  tint: "212, 175, 55",   edge: "212, 175, 55",   fg: "#fcd34d" };
    case "lead":
      return { iconName: "search",    label: "Lead",    tint: "251, 146, 60",   edge: "251, 146, 60",   fg: "#fdba74" };
    case "agent":
      return { iconName: "brain",     label: "Agent",   tint: "168, 85, 247",   edge: "168, 85, 247",   fg: "#d8b4fe" };
    case "workspace":
      return { iconName: "folder",    label: "Wkspc",   tint: "14, 165, 233",   edge: "14, 165, 233",   fg: "#7dd3fc" };
    case "session":
      return { iconName: "messageSquare", label: "Session", tint: "99, 102, 241", edge: "99, 102, 241", fg: "#a5b4fc" };
    case "composition":
      return { iconName: "filmStrip", label: "Comp",    tint: "212, 175, 55",   edge: "212, 175, 55",   fg: "#fde68a" };
    case "site":
      return { iconName: "globe",     label: "Site",    tint: "34, 197, 94",    edge: "34, 197, 94",    fg: "#86efac" };
    case "form":
      return { iconName: "fileText",  label: "Form",    tint: "139, 92, 246",   edge: "139, 92, 246",   fg: "#c4b5fd" };
    case "skill":
      return { iconName: "zap",       label: "Skill",   tint: "234, 179, 8",    edge: "234, 179, 8",    fg: "#fde047" };
    case "url":
      return { iconName: "link",      label: "Link",    tint: "148, 163, 184",  edge: "148, 163, 184",  fg: "#cbd5e1" };
    case "file":
      return { iconName: "fileCode",  label: "File",    tint: "94, 234, 212",   edge: "94, 234, 212",   fg: "#5eead4" };
  }
}

// ── Status colour ─────────────────────────────────────────────────

const STATUS_COLOUR: Record<NonNullable<RelationPillInput["status"]>, string> = {
  active:   "#22c55e",
  pending:  "#fbbf24",
  draft:    "#94a3b8",
  paused:   "#f97316",
  done:     "#10b981",
  blocked:  "#ef4444",
  archived: "#6b7280",
};

// ── Render ────────────────────────────────────────────────────────

export function renderRelationPill(input: RelationPillInput): TemplateResult {
  const s = styleFor(input.kind);
  const ico = input.iconName ?? s.iconName;
  const titleAttr =
    input.title ??
    `${s.label} — ${input.label}${input.context ? ` · ${input.context}` : ""}`;

  // CSS custom properties drive the kind-specific tint without an
  // explosion of class variants. Set inline so the same pill class works
  // for every kind.
  const styleVars = `--rp-tint: ${s.tint}; --rp-edge: ${s.edge}; --rp-fg: ${s.fg};`;
  const sizeClass = input.compact ? "rp-pill--compact" : "";

  const inner = html`
    ${input.status
      ? html`<span class="rp-dot" style="background:${STATUS_COLOUR[input.status]}; box-shadow: 0 0 6px ${STATUS_COLOUR[input.status]};"></span>`
      : nothingDot()}
    ${input.hideIcon ? "" : html`<span class="rp-icon">${icon(ico)}</span>`}
    ${input.hideKindLabel ? "" : html`<span class="rp-kind">${s.label}</span>`}
    <span class="rp-label">${input.label}</span>
    ${input.context
      ? html`<span class="rp-sep">·</span><span class="rp-ctx">${input.context}</span>`
      : ""}
  `;

  if (input.onClick) {
    return html`
      <button
        class="rp-pill ${sizeClass}"
        style=${styleVars}
        title=${titleAttr}
        data-kind=${input.kind}
        data-id=${input.id ?? ""}
        @click=${(e: Event) => {
          e.stopPropagation();
          input.onClick?.(e);
        }}
      >${inner}</button>
    `;
  }
  if (input.href) {
    return html`
      <a
        class="rp-pill ${sizeClass}"
        style=${styleVars}
        title=${titleAttr}
        href=${input.href}
        data-kind=${input.kind}
        data-id=${input.id ?? ""}
      >${inner}</a>
    `;
  }
  return html`
    <span
      class="rp-pill ${sizeClass}"
      style=${styleVars}
      title=${titleAttr}
      data-kind=${input.kind}
      data-id=${input.id ?? ""}
    >${inner}</span>
  `;
}

// nothingDot — using `""` rather than `nothing` keeps the gap tidy when no
// status badge is rendered.
function nothingDot() {
  return "";
}

// ── Styles (one-time injection) ───────────────────────────────────

export const relationPillStyles = html`
  <style>
    .rp-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px 4px 8px;
      border-radius: 999px;
      font-family: var(--mono, "JetBrains Mono", monospace);
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.02em;
      line-height: 1.2;
      white-space: nowrap;
      text-decoration: none;
      cursor: default;
      user-select: none;
      color: var(--rp-fg, #e4e4e7);
      /* Multi-stop glassmorphism with depth gradient: a cool top-left
         highlight, a kind-tinted core, and a cooler bottom-right shadow.
         The two rgba(--rp-tint, …) stops carry the kind colour through. */
      background:
        linear-gradient(135deg,
          rgba(255, 255, 255, 0.08) 0%,
          rgba(var(--rp-tint, 212, 175, 55), 0.18) 35%,
          rgba(var(--rp-tint, 212, 175, 55), 0.10) 70%,
          rgba(0, 0, 0, 0.25) 100%);
      border: 1px solid rgba(var(--rp-edge, 212, 175, 55), 0.42);
      backdrop-filter: blur(8px) saturate(160%);
      -webkit-backdrop-filter: blur(8px) saturate(160%);
      box-shadow:
        0 1px 0 rgba(255, 255, 255, 0.06) inset,
        0 -1px 0 rgba(0, 0, 0, 0.25) inset,
        0 4px 12px rgba(0, 0, 0, 0.28),
        0 0 0 1px rgba(var(--rp-edge, 212, 175, 55), 0.08);
      transition: transform 0.15s ease, box-shadow 0.18s ease, border-color 0.18s ease;
    }
    button.rp-pill, a.rp-pill {
      cursor: pointer;
      border-style: solid;
    }
    button.rp-pill:hover, a.rp-pill:hover {
      transform: translateY(-1px);
      border-color: rgba(var(--rp-edge, 212, 175, 55), 0.75);
      box-shadow:
        0 1px 0 rgba(255, 255, 255, 0.1) inset,
        0 -1px 0 rgba(0, 0, 0, 0.3) inset,
        0 8px 22px rgba(0, 0, 0, 0.42),
        0 0 24px rgba(var(--rp-edge, 212, 175, 55), 0.32);
    }
    button.rp-pill:active, a.rp-pill:active {
      transform: translateY(0);
    }

    .rp-pill--compact {
      padding: 2px 8px 2px 6px;
      font-size: 9px;
      gap: 4px;
    }

    .rp-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 12px;
      height: 12px;
      color: rgba(var(--rp-edge, 212, 175, 55), 1);
      flex-shrink: 0;
    }
    .rp-icon svg {
      width: 12px; height: 12px;
      stroke: currentColor; fill: none;
      stroke-width: 2; stroke-linecap: round; stroke-linejoin: round;
    }
    .rp-pill--compact .rp-icon,
    .rp-pill--compact .rp-icon svg { width: 10px; height: 10px; }

    .rp-dot {
      display: inline-block;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    .rp-kind {
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: rgba(var(--rp-edge, 212, 175, 55), 1);
      opacity: 0.85;
    }
    .rp-pill--compact .rp-kind { font-size: 8px; }

    .rp-label {
      max-width: 220px;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .rp-sep {
      opacity: 0.45;
    }
    .rp-ctx {
      opacity: 0.7;
      font-weight: 500;
      max-width: 140px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  </style>
`;

// ── One-time injection helper ─────────────────────────────────────

let _stylesInjected = false;

/**
 * Drop the relation-pill stylesheet into the document head exactly once
 * per session. Useful for views that don't already render `relationPillStyles`
 * inside their Lit template.
 */
export function ensureRelationPillStyles(): void {
  if (_stylesInjected) return;
  if (typeof document === "undefined") return;
  const styleEl = document.createElement("style");
  styleEl.id = "infinibot-relation-pill-styles";
  styleEl.textContent = `
    .rp-pill {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 4px 10px 4px 8px; border-radius: 999px;
      font-family: var(--mono, "JetBrains Mono", monospace);
      font-size: 11px; font-weight: 600; letter-spacing: 0.02em;
      line-height: 1.2; white-space: nowrap; text-decoration: none;
      cursor: default; user-select: none;
      color: var(--rp-fg, #e4e4e7);
      background: linear-gradient(135deg,
        rgba(255,255,255,0.08) 0%,
        rgba(var(--rp-tint,212,175,55),0.18) 35%,
        rgba(var(--rp-tint,212,175,55),0.10) 70%,
        rgba(0,0,0,0.25) 100%);
      border: 1px solid rgba(var(--rp-edge,212,175,55),0.42);
      backdrop-filter: blur(8px) saturate(160%);
      -webkit-backdrop-filter: blur(8px) saturate(160%);
      box-shadow:
        0 1px 0 rgba(255,255,255,0.06) inset,
        0 -1px 0 rgba(0,0,0,0.25) inset,
        0 4px 12px rgba(0,0,0,0.28),
        0 0 0 1px rgba(var(--rp-edge,212,175,55),0.08);
      transition: transform 0.15s ease, box-shadow 0.18s ease, border-color 0.18s ease;
    }
    button.rp-pill, a.rp-pill { cursor: pointer; }
    button.rp-pill:hover, a.rp-pill:hover {
      transform: translateY(-1px);
      border-color: rgba(var(--rp-edge,212,175,55),0.75);
      box-shadow:
        0 1px 0 rgba(255,255,255,0.1) inset,
        0 -1px 0 rgba(0,0,0,0.3) inset,
        0 8px 22px rgba(0,0,0,0.42),
        0 0 24px rgba(var(--rp-edge,212,175,55),0.32);
    }
    button.rp-pill:active, a.rp-pill:active { transform: translateY(0); }
    .rp-pill--compact { padding: 2px 8px 2px 6px; font-size: 9px; gap: 4px; }
    .rp-icon { display:inline-flex;align-items:center;justify-content:center;width:12px;height:12px;color:rgba(var(--rp-edge,212,175,55),1);flex-shrink:0; }
    .rp-icon svg { width:12px;height:12px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round; }
    .rp-pill--compact .rp-icon, .rp-pill--compact .rp-icon svg { width:10px;height:10px; }
    .rp-dot { display:inline-block;width:6px;height:6px;border-radius:50%;flex-shrink:0; }
    .rp-kind { font-size:9px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(var(--rp-edge,212,175,55),1);opacity:0.85; }
    .rp-pill--compact .rp-kind { font-size:8px; }
    .rp-label { max-width:220px;overflow:hidden;text-overflow:ellipsis; }
    .rp-sep { opacity:0.45; }
    .rp-ctx { opacity:0.7;font-weight:500;max-width:140px;overflow:hidden;text-overflow:ellipsis; }
  `;
  document.head.appendChild(styleEl);
  _stylesInjected = true;
}

// ── Bulk renderer ─────────────────────────────────────────────────

/**
 * Render a strip of relation pills with consistent spacing — drop into
 * any list / card / detail panel that surfaces several relations at once.
 *
 *   ${renderRelationPillStrip(rows.map(r => ({ kind: "row", id: r.id, label: r.title })))}
 */
export function renderRelationPillStrip(
  pills: RelationPillInput[],
  opts: { wrap?: boolean; gap?: number; compact?: boolean; emptyHint?: string } = {},
): TemplateResult {
  if (pills.length === 0 && opts.emptyHint) {
    return html`<span style="font-size:11px;color:rgba(228,228,231,0.45)">${opts.emptyHint}</span>`;
  }
  const style = `
    display: flex;
    flex-wrap: ${opts.wrap === false ? "nowrap" : "wrap"};
    gap: ${opts.gap ?? 6}px;
    align-items: center;
  `;
  return html`
    <div style=${style}>
      ${pills.map((p) => renderRelationPill(opts.compact ? { ...p, compact: true } : p))}
    </div>
  `;
}
