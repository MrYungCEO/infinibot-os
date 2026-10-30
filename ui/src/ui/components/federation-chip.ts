/**
 * Federation device multi-select + compact chip display.
 *
 * Two exports:
 *   renderFederationNodeMultiSelect — editable chip strip with "Add device" dropdown
 *   renderFederationNodeChips      — read-only chip strip (for cards / list rows)
 *
 * Both share the same depth-glass chip style and use `nodeStatusGlyph` from
 * node-status-style.ts so every surface agrees on what online/offline looks like.
 */

import { html, nothing, type TemplateResult } from "lit";
import { nodeStatusFrom, nodeStatusGlyph, NODE_STATUS_COLORS } from "./node-status-style.js";
import type { FedNodeOption } from "./federation-node-select.js";

export type { FedNodeOption };

export interface FederationNodeMultiSelectArgs {
  /** Currently-selected node IDs. */
  value: string[];
  /** Available nodes. */
  nodes: FedNodeOption[];
  /** Fires with the full updated list when the selection changes. */
  onChange: (nodeIds: string[]) => void;
  /** Label shown above the picker. Defaults to "Devices". */
  label?: string;
  /** Disable all interactions. */
  disabled?: boolean;
}

function chipStyle(n: FedNodeOption): string {
  const status = nodeStatusFrom(n);
  const color = NODE_STATUS_COLORS[status];
  return `
    display:inline-flex; align-items:center; gap:4px;
    padding:2px 8px 2px 6px; border-radius:12px;
    background:color-mix(in srgb, ${color} 12%, rgba(0,0,0,0.35));
    border:1px solid color-mix(in srgb, ${color} 30%, transparent);
    font-size:11px; color:${color}; white-space:nowrap;
    backdrop-filter:blur(4px);
  `.trim().replace(/\s+/g, " ");
}

function glyphFor(n: FedNodeOption): string {
  return nodeStatusGlyph(n);
}

function nameFor(n: FedNodeOption): string {
  const status = nodeStatusFrom(n);
  if (status === "local") return `${n.name} (this device)`;
  if (status === "offline") return `${n.name} — offline`;
  return n.name;
}

/**
 * Editable multi-select: chips with × removers + an "Add device" native
 * `<select>`. Using a native select avoids z-index / popover fights and
 * works identically in every kanban view / modal.
 */
export function renderFederationNodeMultiSelect(
  args: FederationNodeMultiSelectArgs,
): TemplateResult {
  const { value, nodes, onChange, label = "Devices", disabled } = args;
  const selected = new Set(value);
  const available = nodes.filter((n) => !selected.has(n.id));

  const remove = (id: string) => {
    const next = value.filter((v) => v !== id);
    onChange(next);
  };

  const add = (id: string) => {
    if (!id || selected.has(id)) return;
    onChange([...value, id]);
  };

  const chips: TemplateResult[] = value.map((id) => {
    const node = nodes.find((n) => n.id === id) ?? { id, name: id, online: true };
    return html`
      <span style="${chipStyle(node as FedNodeOption)}" title="${nameFor(node as FedNodeOption)}">
        <span>${glyphFor(node as FedNodeOption)}</span>
        <span>${node.name}</span>
        ${!disabled ? html`
          <button
            @click=${(e: Event) => { e.stopPropagation(); remove(id); }}
            style="background:none;border:none;color:inherit;cursor:pointer;padding:0;margin-left:2px;line-height:1;font-size:10px;opacity:0.7;"
            aria-label="Remove ${node.name}"
          >×</button>
        ` : nothing}
      </span>
    `;
  });

  return html`
    <div style="display:flex;flex-direction:column;gap:6px;">
      ${label ? html`
        <label style="font-size:11px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;color:var(--g-muted,#888);">
          ${label}
        </label>
      ` : nothing}
      <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;min-height:26px;">
        ${chips}
        ${!disabled && (available.length > 0 || value.length === 0) ? html`
          <select
            ?disabled=${disabled}
            @change=${(e: Event) => {
              const sel = e.target as HTMLSelectElement;
              add(sel.value);
              sel.value = "";
            }}
            style="
              background:rgba(0,0,0,0.35);
              color:var(--g-muted,#888);
              border:1px solid rgba(255,255,255,0.1);
              border-radius:6px;
              padding:2px 6px;
              font-size:11px;
              font-family:inherit;
              cursor:pointer;
            "
          >
            <option value="">+ Add device</option>
            ${available.map((n) => html`
              <option value="${n.id}">${glyphFor(n)} ${nameFor(n)}</option>
            `)}
          </select>
        ` : nothing}
        ${value.length === 0 ? html`
          <span style="font-size:11px;color:var(--g-muted,#666);font-style:italic;">No devices</span>
        ` : nothing}
      </div>
    </div>
  `;
}

/**
 * Read-only compact chip strip for cards and list rows.
 * Shows up to `maxVisible` chips then a "+N more" overflow badge.
 */
export function renderFederationNodeChips(
  nodeIds: string[] | undefined,
  nodes: FedNodeOption[],
  maxVisible = 3,
): TemplateResult {
  if (!nodeIds?.length) return html``;
  const visible = nodeIds.slice(0, maxVisible);
  const overflow = nodeIds.length - maxVisible;
  return html`
    <div style="display:flex;flex-wrap:wrap;gap:4px;align-items:center;">
      ${visible.map((id) => {
        const node = nodes.find((n) => n.id === id) ?? { id, name: id, online: true };
        return html`
          <span style="${chipStyle(node as FedNodeOption)}" title="${nameFor(node as FedNodeOption)}">
            <span>${glyphFor(node as FedNodeOption)}</span>
            <span>${node.name}</span>
          </span>
        `;
      })}
      ${overflow > 0 ? html`
        <span style="
          display:inline-flex;align-items:center;
          padding:2px 6px;border-radius:12px;
          background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);
          font-size:10px;color:var(--g-muted,#888);
        ">+${overflow}</span>
      ` : nothing}
    </div>
  `;
}
