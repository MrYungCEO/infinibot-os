// ============================================================
// Shared Grid Toolbar — auto-layout buttons + CSS
// ============================================================
//
// Provides the auto-layout button bar (Tile Horizontal, Tile Vertical, Tile
// Grid) shared by the masonry-grid view and the terminals view.  Centralising
// here means the two pages can never drift apart in appearance or behaviour.
//
// masonry-grid is a LitElement with shadow-DOM CSS; it keeps its own matching
// rules inline (using `css\`…\``) and imports only the render helper below.
//
// The terminals view uses light-DOM `<style>` injection; it imports both
// `GRID_TOOLBAR_CSS` (for the CSS string) and `renderAutoLayoutButtons`.

import { html, nothing, type TemplateResult } from "lit";
import { icons } from "../icons";

// ── Shared CSS string ─────────────────────────────────────────
//
// Matches the equivalent shadow-DOM rules inside masonry-grid.ts so both pages
// get pixel-identical styling.  Only the subset of rules that the terminals
// page actually needs is included; masonry-grid keeps its full ruleset.

export const GRID_TOOLBAR_CSS = `
  /* Toolbar bar */
  .grid-toolbar {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 48px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 12px;
    background:
      linear-gradient(180deg, rgba(0,0,0,0.55), rgba(0,0,0,0.4)),
      var(--g-glass-tint, transparent);
    backdrop-filter: blur(18px) saturate(160%);
    -webkit-backdrop-filter: blur(18px) saturate(160%);
    border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 15%, rgba(255,255,255,0.04));
    box-shadow: 0 6px 20px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.04);
    z-index: 10000;
    box-sizing: border-box;
  }

  /* Workspace below the toolbar */
  .grid-workspace {
    position: absolute;
    top: 48px;
    left: 0;
    right: 0;
    bottom: 0;
    overflow: hidden;
    background: transparent;
  }

  /* Controls inside the toolbar share these height / alignment defaults */
  .grid-toolbar > *,
  .grid-toolbar .toolbar-group > *,
  .grid-toolbar button,
  .grid-toolbar select,
  .grid-toolbar input {
    height: 36px;
    box-sizing: border-box;
    vertical-align: middle;
  }
  .grid-toolbar .toolbar-group {
    align-self: center;
  }

  /* Grouped buttons */
  .toolbar-group {
    display: flex;
    align-items: center;
    gap: 4px;
    height: 36px;
  }

  /* 1-px divider between toolbar groups */
  .toolbar-divider {
    width: 1px;
    height: 24px;
    background: linear-gradient(180deg, transparent, rgba(255,255,255,0.18), transparent);
    margin: 0 6px;
    align-self: center;
  }

  /* Spacer to push items to the right */
  .toolbar-spacer {
    flex: 1;
  }

  /* Square icon button */
  .toolbar-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 8px;
    background:
      linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.015)),
      var(--g-glass-tint, transparent);
    color: var(--c-text-2, #aab);
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s, color 0.15s, box-shadow 0.15s, transform 0.1s;
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset, 0 2px 8px rgba(0,0,0,0.25);
  }

  .toolbar-btn:hover {
    background:
      linear-gradient(180deg, rgba(255,255,255,0.1), rgba(255,255,255,0.04)),
      var(--g-glass-tint, transparent);
    border-color: color-mix(in srgb, var(--g-primary) 25%, rgba(255,255,255,0.1));
    color: #fff;
    transform: translateY(-1px);
    box-shadow: 0 1px 0 rgba(255,255,255,0.08) inset, 0 6px 18px rgba(0,0,0,0.4);
  }

  .toolbar-btn:active {
    transform: translateY(0);
  }

  .toolbar-btn.active {
    background:
      linear-gradient(180deg,
        color-mix(in srgb, var(--g-primary) 28%, transparent),
        color-mix(in srgb, var(--g-primary) 14%, transparent));
    border-color: color-mix(in srgb, var(--g-primary) 55%, transparent);
    color: var(--g-primary);
    box-shadow:
      0 0 0 1px color-mix(in srgb, var(--g-primary) 35%, transparent),
      0 4px 14px color-mix(in srgb, var(--g-primary) 25%, transparent),
      inset 0 1px 0 rgba(255,255,255,0.08);
  }

  .toolbar-btn svg {
    width: 20px;
    height: 20px;
    pointer-events: none;
  }

  /* Child elements in buttons must not block clicks */
  .toolbar-btn span {
    pointer-events: none;
  }

  /* Numbered workspace tabs — mirrors the /grid page .workspace-btn styling
     verbatim so the two pages stay pixel-identical (masonry-grid keeps the
     same rules inline in its shadow DOM; this is the light-DOM copy for the
     terminals view). */
  .workspace-tabs {
    gap: 4px;
  }

  .workspace-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 36px;
    height: 36px;
    padding: 0 10px;
    border: 1px solid color-mix(in srgb, var(--g-primary) 20%, rgba(255,255,255,0.05));
    border-radius: 8px;
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--g-primary) 8%, transparent), color-mix(in srgb, var(--g-primary) 3%, transparent)),
      var(--g-glass-tint, transparent);
    color: color-mix(in srgb, var(--g-primary) 65%, transparent);
    cursor: pointer;
    font-family: var(--mono, 'JetBrains Mono', monospace);
    font-size: 14px;
    font-weight: 700;
    transition: background 0.15s, border-color 0.15s, color 0.15s, box-shadow 0.15s, transform 0.1s;
    position: relative;
    gap: 4px;
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset, 0 2px 8px rgba(0,0,0,0.25);
  }

  .workspace-btn:hover {
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--g-primary) 18%, transparent), color-mix(in srgb, var(--g-primary) 8%, transparent)),
      var(--g-glass-tint, transparent);
    border-color: color-mix(in srgb, var(--g-primary) 45%, transparent);
    color: var(--g-primary);
    transform: translateY(-1px);
    box-shadow: 0 4px 14px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.08);
  }

  .workspace-btn.active {
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--g-primary) 30%, transparent), color-mix(in srgb, var(--g-primary) 16%, transparent));
    border-color: var(--g-primary);
    color: var(--g-primary);
    box-shadow:
      0 0 0 1px color-mix(in srgb, var(--g-primary) 45%, transparent),
      0 4px 14px color-mix(in srgb, var(--g-primary) 30%, transparent),
      inset 0 1px 0 rgba(255,255,255,0.1);
  }

  .workspace-btn.add {
    border-style: dashed;
    opacity: 0.65;
  }
  .workspace-btn.add:hover {
    opacity: 1;
  }
  .workspace-btn:disabled {
    opacity: 0.3;
    cursor: not-allowed;
    transform: none;
  }

  .workspace-num {
    font-size: 14px;
  }

  .workspace-count {
    font-size: 10px;
    padding: 1px 5px;
    background: color-mix(in srgb, var(--g-primary) 30%, transparent);
    border-radius: 4px;
    color: var(--g-primary);
  }

  .workspace-btn.active .workspace-count {
    background: rgba(0, 0, 0, 0.3);
  }

  /* Mobile: hide desktop toolbar items */
  @media (max-width: 768px) {
    .grid-toolbar {
      padding: 0 12px;
      gap: 8px;
    }
    .toolbar-group,
    .toolbar-divider,
    .toolbar-spacer {
      display: none !important;
    }
  }
`;

// ── Auto-layout button group ──────────────────────────────────

export interface AutoLayoutHandlers {
  onTileHorizontal: () => void;
  onTileVertical: () => void;
  onTileGrid: () => void;
}

/**
 * Render the three auto-layout tile buttons (Horizontal / Vertical / Grid)
 * as a `.toolbar-group`.  Used by both the masonry-grid view and the terminals
 * view so the two pages share identical markup and behaviour.
 */
export function renderAutoLayoutButtons(handlers: AutoLayoutHandlers): TemplateResult {
  return html`
    <div class="toolbar-group">
      <button class="toolbar-btn" title="Tile Horizontally" @click=${handlers.onTileHorizontal}>
        ${icons.columns}
      </button>
      <button class="toolbar-btn" title="Tile Vertically" @click=${handlers.onTileVertical}>
        ${icons.rows}
      </button>
      <button class="toolbar-btn" title="Tile Grid" @click=${handlers.onTileGrid}>
        ${icons.gridFour}
      </button>
    </div>
  `;
}

// ── Numbered workspace tabs ───────────────────────────────────

export interface WorkspaceTabsProps {
  /** How many numbered workspaces exist (>= 1). */
  count: number;
  /** Currently active workspace (1-based). */
  active: number;
  /** Item count to badge on workspace `n` (0 = no badge). */
  countFor: (n: number) => number;
  /** Switch to workspace `n`. */
  onSwitch: (n: number) => void;
  /** Optional "+" button to add a workspace manually. */
  onAdd?: () => void;
  /** When false, the "+" button is disabled. */
  canAdd?: boolean;
}

/**
 * Render the numbered workspace tab strip ("1", "2", "3", …) as a
 * `.toolbar-group`.  Mirrors the /grid page's inline workspace buttons so the
 * terminals view gets the same look and behaviour without duplicating the
 * markup or CSS.  Tabs are created lazily by the caller; this just renders
 * `count` numbered buttons plus an optional "+" to add another.
 */
export function renderWorkspaceTabs(p: WorkspaceTabsProps): TemplateResult {
  const nums = Array.from({ length: Math.max(1, p.count) }, (_, i) => i + 1);
  return html`
    <div class="toolbar-group workspace-tabs">
      ${nums.map((n) => {
        const c = p.countFor(n);
        return html`
          <button
            class="workspace-btn ${n === p.active ? "active" : ""}"
            title="Workspace ${n}${c > 0 ? ` · ${c} terminal${c === 1 ? "" : "s"}` : ""}"
            @click=${() => p.onSwitch(n)}
          >
            <span class="workspace-num">${n}</span>
            ${c > 0 ? html`<span class="workspace-count">${c}</span>` : nothing}
          </button>
        `;
      })}
      ${p.onAdd
        ? html`
            <button
              class="workspace-btn add"
              ?disabled=${p.canAdd === false}
              title="New workspace"
              @click=${() => p.onAdd?.()}
            >
              +
            </button>
          `
        : nothing}
    </div>
  `;
}
