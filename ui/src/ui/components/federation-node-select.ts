/**
 * Federation Node Select
 *
 * Custom popover dropdown for picking the federation device where a CLI /
 * agent / chat session should spawn. Built on `<details>` so the open state
 * is owned by the DOM itself — it survives Lit re-renders and frequent
 * polling-driven repaints that used to slam the previous native `<select>`
 * shut mid-interaction.
 *
 * Each row shows: status glyph, friendly name, "(this device)" badge,
 * hostname, and capability chips, so the operator can tell satellites
 * apart at a glance instead of seeing seven copies of "host" with no detail.
 */

import { html, nothing, type TemplateResult } from "lit";
import { nodeStatusFrom, nodeStatusGlyph } from "./node-status-style.js";

export interface FedNodeOption {
  id: string;
  name: string;
  isLocal?: boolean;
  online?: boolean;
  hostname?: string;
  capabilities?: string[];
}

export interface FederationNodeSelectArgs {
  value: string | null | undefined;
  nodes: FedNodeOption[];
  onChange: (nodeId: string) => void;
  compact?: boolean;
  label?: string;
  className?: string;
  disabled?: boolean;
  filter?: (node: FedNodeOption) => boolean;
  onlineOnly?: boolean;
}

const LOCAL_FALLBACK: FedNodeOption = {
  id: "local",
  name: "This Device",
  isLocal: true,
  online: true,
};

function nodeStatusColor(n: FedNodeOption): string {
  const s = nodeStatusFrom(n);
  if (s === "local") return "var(--g-primary, #f5a623)";
  if (s === "offline") return "#ef4444";
  return "#4ade80";
}

function nodeLabel(n: FedNodeOption): string {
  return n.name || n.id;
}

const FNS_CSS = `
    .fns-root { position: relative; display: inline-block; }
    .fns-root[data-disabled="true"] { opacity: 0.55; pointer-events: none; }
    .fns-summary {
      list-style: none;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 5px 10px;
      background: linear-gradient(180deg, rgba(20,20,20,0.92), rgba(8,8,8,0.92));
      border: 1px solid color-mix(in srgb, var(--g-primary, #f5a623) 28%, transparent);
      border-radius: 6px;
      color: var(--g-fg, #eee);
      font: 600 12px/1 var(--mono, 'JetBrains Mono', 'SF Mono', monospace);
      cursor: pointer;
      min-width: 160px;
      box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset, 0 4px 14px rgba(0,0,0,0.35);
      transition: border-color 0.12s, background 0.12s, box-shadow 0.12s;
      user-select: none;
    }
    .fns-summary::-webkit-details-marker { display: none; }
    .fns-summary:hover {
      border-color: color-mix(in srgb, var(--g-primary, #f5a623) 50%, transparent);
      background: linear-gradient(180deg, rgba(28,28,28,0.95), rgba(12,12,12,0.95));
    }
    .fns-root[open] .fns-summary {
      border-color: var(--g-primary, #f5a623);
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--g-primary, #f5a623) 35%, transparent), 0 6px 18px rgba(0,0,0,0.45);
    }
    .fns-compact .fns-summary { padding: 3px 8px; font-size: 11px; min-width: 140px; }
    .fns-summary-dot {
      width: 8px; height: 8px; border-radius: 50%;
      box-shadow: 0 0 6px currentColor;
      flex-shrink: 0;
    }
    .fns-summary-name {
      flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      text-align: left;
    }
    .fns-summary-caret { opacity: 0.6; font-size: 10px; transition: transform 0.15s; }
    .fns-root[open] .fns-summary-caret { transform: rotate(180deg); }
    .fns-label {
      display: block; font: 600 10px/1 var(--mono, 'JetBrains Mono', monospace);
      letter-spacing: 0.08em; text-transform: uppercase;
      color: color-mix(in srgb, var(--g-primary, #f5a623) 75%, #999);
      margin-bottom: 4px;
    }

    .fns-pop {
      position: absolute;
      top: calc(100% + 6px);
      left: 0;
      z-index: 9999;
      min-width: 280px;
      max-width: 360px;
      max-height: 360px;
      overflow-y: auto;
      background: linear-gradient(180deg, rgba(14,14,14,0.98), rgba(6,6,6,0.98));
      border: 1px solid color-mix(in srgb, var(--g-primary, #f5a623) 35%, transparent);
      border-radius: 8px;
      padding: 6px;
      box-shadow: 0 14px 38px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.04) inset;
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
    }
    .fns-pop-header {
      padding: 6px 8px 8px 8px;
      font: 600 10px/1 var(--mono, 'JetBrains Mono', monospace);
      letter-spacing: 0.1em; text-transform: uppercase;
      color: color-mix(in srgb, var(--g-primary, #f5a623) 65%, #888);
      border-bottom: 1px solid rgba(255,255,255,0.05);
      margin-bottom: 4px;
      display: flex; justify-content: space-between; align-items: center;
    }
    .fns-pop-count { opacity: 0.7; }
    .fns-item {
      display: grid;
      grid-template-columns: 14px 1fr auto;
      align-items: start;
      gap: 8px;
      padding: 8px 10px;
      border-radius: 6px;
      cursor: pointer;
      background: transparent;
      border: 1px solid transparent;
      width: 100%;
      text-align: left;
      color: var(--g-fg, #eee);
      font-family: inherit;
      font-size: 12px;
    }
    .fns-item:hover {
      background: rgba(255,255,255,0.04);
      border-color: color-mix(in srgb, var(--g-primary, #f5a623) 20%, transparent);
    }
    .fns-item[aria-selected="true"] {
      background: color-mix(in srgb, var(--g-primary, #f5a623) 10%, transparent);
      border-color: color-mix(in srgb, var(--g-primary, #f5a623) 50%, transparent);
    }
    .fns-item-dot {
      width: 10px; height: 10px; border-radius: 50%;
      margin-top: 4px;
      box-shadow: 0 0 6px currentColor;
    }
    .fns-item-main { min-width: 0; }
    .fns-item-row {
      display: flex; align-items: center; gap: 6px;
      font-weight: 600; line-height: 1.2;
    }
    .fns-item-name {
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .fns-badge {
      font: 600 9px/1 var(--mono, monospace);
      letter-spacing: 0.08em; text-transform: uppercase;
      padding: 2px 5px; border-radius: 3px;
      background: color-mix(in srgb, var(--g-primary, #f5a623) 18%, transparent);
      color: color-mix(in srgb, var(--g-primary, #f5a623) 80%, white);
      border: 1px solid color-mix(in srgb, var(--g-primary, #f5a623) 35%, transparent);
    }
    .fns-badge.offline {
      background: rgba(239,68,68,0.12); color: #fca5a5;
      border-color: rgba(239,68,68,0.4);
    }
    .fns-item-meta {
      margin-top: 3px;
      font: 11px/1.3 var(--mono, monospace);
      color: color-mix(in srgb, #888 80%, transparent);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .fns-caps {
      display: flex; flex-wrap: wrap; gap: 3px; margin-top: 4px;
    }
    .fns-cap {
      font: 9px/1 var(--mono, monospace);
      letter-spacing: 0.05em;
      padding: 2px 5px; border-radius: 3px;
      background: rgba(255,255,255,0.05);
      color: #b9b9b9;
      border: 1px solid rgba(255,255,255,0.07);
    }
    .fns-item-check {
      align-self: center;
      color: var(--g-primary, #f5a623);
      font-size: 14px;
      font-weight: 700;
    }
    .fns-empty {
      padding: 14px; text-align: center;
      color: #888; font-size: 12px;
    }
  `;

/** Close any other open `<details>` dropdowns on document-level click outside. */
function ensureGlobalCloseHandler() {
  if (typeof document === "undefined") return;
  if ((window as any).__fnsCloseInstalled) return;
  (window as any).__fnsCloseInstalled = true;
  // Walk into shadow roots so dropdowns rendered inside Lit components close too.
  function allOpenDetails(): HTMLDetailsElement[] {
    const out: HTMLDetailsElement[] = [];
    const visit = (root: Document | ShadowRoot | Element) => {
      const found = (root as ParentNode).querySelectorAll?.("details.fns-root[open]");
      if (found) found.forEach((d) => out.push(d as HTMLDetailsElement));
      const walker = (root as Document).createTreeWalker
        ? (root as Document).createTreeWalker(root as any, NodeFilter.SHOW_ELEMENT)
        : null;
      if (walker) {
        let node: Node | null = walker.currentNode;
        while (node) {
          const sr = (node as Element).shadowRoot;
          if (sr) visit(sr);
          node = walker.nextNode();
        }
      }
    };
    visit(document);
    return out;
  }
  document.addEventListener("click", (e) => {
    const path = e.composedPath();
    allOpenDetails().forEach((det) => {
      if (path.includes(det)) return;
      det.open = false;
    });
  }, true);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    allOpenDetails().forEach((det) => { det.open = false; });
  });
}

export function renderFederationNodeSelect(
  args: FederationNodeSelectArgs,
): TemplateResult {
  ensureGlobalCloseHandler();

  const { value, onChange, compact, label = "Device", className, disabled, filter, onlineOnly } = args;

  let filtered = args.nodes;
  if (filter || onlineOnly) {
    filtered = args.nodes.filter((n) => {
      if (n.id === value) return true;
      if (onlineOnly && nodeStatusFrom(n) === "offline") return false;
      return filter ? filter(n) : true;
    });
  }
  const list = filtered.length > 0 ? filtered : [LOCAL_FALLBACK];
  const selectedId = value ?? "local";
  const selected = list.find((n) => n.id === selectedId) ?? LOCAL_FALLBACK;
  const onlineCount = list.filter((n) => nodeStatusFrom(n) !== "offline").length;

  const summaryDotColor = nodeStatusColor(selected);
  const wrapperClass = ["fns-root", compact ? "fns-compact" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");

  return html`
    <style data-fns-style>${FNS_CSS}</style>
    <details
      class="${wrapperClass}"
      data-disabled="${disabled ? "true" : "false"}"
    >
      ${label && !compact ? html`<span class="fns-label">${label}</span>` : nothing}
      <summary
        class="fns-summary"
        title=${selected.hostname ? `${nodeLabel(selected)} · ${selected.hostname}` : nodeLabel(selected)}
        @click=${(e: Event) => {
          if (disabled) { e.preventDefault(); return; }
          e.stopPropagation();
        }}
      >
        <span class="fns-summary-dot" style="background:${summaryDotColor};color:${summaryDotColor};"></span>
        <span class="fns-summary-name">${nodeStatusGlyph(selected)} ${nodeLabel(selected)}${selected.isLocal ? " · local" : ""}</span>
        <span class="fns-summary-caret">▾</span>
      </summary>
      <div class="fns-pop" @click=${(e: Event) => e.stopPropagation()}>
        <div class="fns-pop-header">
          <span>${label || "Federation Device"}</span>
          <span class="fns-pop-count">${onlineCount}/${list.length} online</span>
        </div>
        ${list.length === 0
          ? html`<div class="fns-empty">No federation devices available</div>`
          : list.map((n) => {
              const isSelected = n.id === selectedId;
              const status = nodeStatusFrom(n);
              const isOffline = status === "offline";
              const dotColor = nodeStatusColor(n);
              return html`
                <button
                  type="button"
                  class="fns-item"
                  aria-selected="${isSelected ? "true" : "false"}"
                  @click=${(e: Event) => {
                    e.stopPropagation();
                    onChange(n.id || "local");
                    const det = (e.currentTarget as HTMLElement).closest("details") as HTMLDetailsElement | null;
                    if (det) det.open = false;
                  }}
                >
                  <span class="fns-item-dot" style="background:${dotColor};color:${dotColor};"></span>
                  <div class="fns-item-main">
                    <div class="fns-item-row">
                      <span class="fns-item-name">${nodeLabel(n)}</span>
                      ${n.isLocal ? html`<span class="fns-badge">Local</span>` : nothing}
                      ${isOffline ? html`<span class="fns-badge offline">Offline</span>` : nothing}
                    </div>
                    ${n.hostname && n.hostname !== n.name ? html`
                      <div class="fns-item-meta">${n.hostname}</div>
                    ` : (n.id !== n.name && n.id !== "local") ? html`
                      <div class="fns-item-meta">${n.id}</div>
                    ` : nothing}
                    ${n.capabilities && n.capabilities.length > 0 ? html`
                      <div class="fns-caps">
                        ${n.capabilities.slice(0, 6).map((c) => html`<span class="fns-cap">${c}</span>`)}
                      </div>
                    ` : nothing}
                  </div>
                  ${isSelected ? html`<span class="fns-item-check">✓</span>` : nothing}
                </button>
              `;
            })}
      </div>
    </details>
  `;
}
