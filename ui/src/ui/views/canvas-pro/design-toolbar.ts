/**
 * Top design toolbar - tool picker (V/T/R/O/L/H + polygon/star/arrow/
 * freehand/image/frame), alignment + distribute ops, and per-tool
 * inspector slot for fill/stroke/font/etc.
 *
 * The toolbar emits *intents* via the handlers; the shell translates
 * them to Excalidraw API calls (`setActiveTool`, `updateScene`,
 * etc.) when the React canvas is mounted. Where Excalidraw's element
 * model doesn't natively support a tool (polygon-N-sides, star,
 * text-on-path, gradient fill, frame masking), the intent is recorded
 * but executes as the nearest native fallback; the sibling
 * mcp-excalidraw agent owns extending the engine and will resolve
 * these against the same intent enum below.
 */

import { html } from "lit";
import type { TemplateResult } from "lit";
import type { CanvasProAlignOp, CanvasProToolId } from "./types";

export type DesignToolbarHandlers = {
  activeTool: CanvasProToolId;
  onTool: (tool: CanvasProToolId) => void;
  onAlign: (op: CanvasProAlignOp) => void;
  onUndo: () => void;
  onRedo: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onGroup: () => void;
  onUngroup: () => void;
  onExport: () => void;
};

const TOOLS: { id: CanvasProToolId; label: string; key: string }[] = [
  { id: "select", label: "Select", key: "V" },
  { id: "hand", label: "Hand", key: "H" },
  { id: "text", label: "Text", key: "T" },
  { id: "rectangle", label: "Rect", key: "R" },
  { id: "ellipse", label: "Ellipse", key: "O" },
  { id: "polygon", label: "Polygon", key: "P" },
  { id: "star", label: "Star", key: "S" },
  { id: "arrow", label: "Arrow", key: "A" },
  { id: "line", label: "Line", key: "L" },
  { id: "freehand", label: "Draw", key: "D" },
  { id: "image", label: "Image", key: "I" },
  { id: "frame", label: "Frame", key: "F" },
];

const ALIGN_OPS: { op: CanvasProAlignOp; label: string }[] = [
  { op: "align-left", label: "⫷" },
  { op: "align-center-h", label: "⊟" },
  { op: "align-right", label: "⫸" },
  { op: "align-top", label: "⫯" },
  { op: "align-center-v", label: "⊞" },
  { op: "align-bottom", label: "⫰" },
  { op: "distribute-h", label: "↔" },
  { op: "distribute-v", label: "↕" },
];

export function renderDesignToolbar(h: DesignToolbarHandlers): TemplateResult {
  return html`
    <div class="cp-toolbar">
      <div class="cp-toolbar__group">
        ${TOOLS.map(
          (t) => html`
            <button
              class="cp-tool ${h.activeTool === t.id ? "is-active" : ""}"
              title="${t.label} (${t.key})"
              @click=${() => h.onTool(t.id)}
            >${t.label}</button>
          `
        )}
      </div>
      <div class="cp-toolbar__sep"></div>
      <div class="cp-toolbar__group">
        <button class="cp-tool" title="Undo (Cmd+Z)" @click=${h.onUndo}>↶</button>
        <button class="cp-tool" title="Redo (Cmd+Shift+Z)" @click=${h.onRedo}>↷</button>
        <button class="cp-tool" title="Duplicate (Cmd+D)" @click=${h.onDuplicate}>⧉</button>
        <button class="cp-tool" title="Delete" @click=${h.onDelete}>×</button>
        <button class="cp-tool" title="Group (Cmd+G)" @click=${h.onGroup}>⊟</button>
        <button class="cp-tool" title="Ungroup (Cmd+Shift+G)" @click=${h.onUngroup}>⊠</button>
      </div>
      <div class="cp-toolbar__sep"></div>
      <div class="cp-toolbar__group">
        ${ALIGN_OPS.map(
          (a) => html`
            <button class="cp-tool" title=${a.op} @click=${() => h.onAlign(a.op)}>${a.label}</button>
          `
        )}
      </div>
      <div class="cp-toolbar__spacer"></div>
      <div class="cp-toolbar__group">
        <button class="cp-tool cp-tool--primary" @click=${h.onExport}>Export</button>
      </div>
    </div>
  `;
}
