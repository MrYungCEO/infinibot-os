/**
 * In-memory canvas state owned by the MCP server.
 *
 * Why MCP-side state and not gateway-side: every tool call needs to read
 * the current scene to compute incremental updates (e.g. "delete by id"
 * needs to know the current set). Pushing every read across WS would be
 * round-trip-heavy. The gateway is the broadcaster, this is the source
 * of truth for "what does the agent think it just drew."
 *
 * Lifecycle:
 *   - State is in-memory only. Restarting the MCP server clears it.
 *   - Operators who want persistence can call `export_scene` to JSON and
 *     `import_scene` from JSON — same shape as Excalidraw's own export.
 *   - Every mutation calls `broadcastCanvasUpdate` so the UI stays in
 *     lockstep without polling.
 */
import type { CanvasElement } from "./elements.js";
import { applyPatch, normalizeBatch, normalizeElement, reconcileBindings } from "./elements.js";
import { broadcastCanvasClear, broadcastCanvasUpdate, broadcastCanvasView } from "./gateway-bridge.js";

let elements: CanvasElement[] = [];

function indexOfId(id: string): number {
  return elements.findIndex((e) => e.id === id);
}

/**
 * Fix up arrow ↔ shape back-references, then broadcast. Every mutation
 * goes through here so the canvas is never broadcast in an inconsistent
 * state (arrow bound to shape A but shape A's boundElements missing the
 * arrow ref — which breaks drag-tracking in Excalidraw).
 */
function broadcast(): void {
  reconcileBindings(elements);
  broadcastCanvasUpdate(elements);
}

const SHAPE_TYPES = new Set(["rectangle", "ellipse", "diamond"]);
const LABELABLE_TYPES = new Set(["rectangle", "ellipse", "diamond", "arrow", "line"]);

/** Find the text element bound as a label to the given container, if any. */
function findBoundLabel(containerId: string): CanvasElement | null {
  return elements.find((e) => e.type === "text" && e.containerId === containerId) ?? null;
}

/**
 * When a container's text/position/size changes, the label text element
 * needs to be re-positioned and (if text changed) re-typed. Excalidraw
 * itself only repositions on operator interaction, not on programmatic
 * updateScene, so we do it here to keep the agent's mental model honest:
 * "I moved the box, the label moved with it."
 */
function syncBoundLabel(container: CanvasElement, patch: Partial<CanvasElement>): void {
  if (!container.id) return;
  if (!LABELABLE_TYPES.has(container.type)) return;
  const label = findBoundLabel(container.id);
  if (!label) return;

  const labelPatch: Partial<CanvasElement> = {};

  // Text content propagation: shape.text patches don't render directly,
  // so the agent's `update_element(shapeId, {text: "..."})` would silently
  // no-op without this redirect.
  if (typeof patch.text === "string") {
    labelPatch.text = patch.text;
  }

  // Geometry follows the container.
  const movedOrResized =
    patch.x !== undefined ||
    patch.y !== undefined ||
    patch.width !== undefined ||
    patch.height !== undefined;
  if (movedOrResized) {
    const text = typeof labelPatch.text === "string" ? labelPatch.text : label.text ?? "";
    const fontSize = label.fontSize ?? (SHAPE_TYPES.has(container.type) ? 20 : 16);
    const textHeight = fontSize * 1.25;
    if (SHAPE_TYPES.has(container.type)) {
      const w = typeof container.width === "number" && container.width > 0 ? container.width : 200;
      const h = typeof container.height === "number" && container.height > 0 ? container.height : 100;
      const textWidth = Math.max(40, Math.min(w - 16, text.length * fontSize * 0.55));
      labelPatch.x = container.x + (w - textWidth) / 2;
      labelPatch.y = container.y + (h - textHeight) / 2;
      labelPatch.width = textWidth;
      labelPatch.height = textHeight;
    } else {
      // arrow / line — midpoint of bbox
      const w = typeof container.width === "number" ? container.width : 0;
      const h = typeof container.height === "number" ? container.height : 0;
      const textWidth = Math.max(40, text.length * fontSize * 0.55);
      labelPatch.x = container.x + w / 2 - textWidth / 2;
      labelPatch.y = container.y + h / 2 - textHeight / 2;
      labelPatch.width = textWidth;
      labelPatch.height = textHeight;
    }
  }

  if (Object.keys(labelPatch).length === 0) return;
  const idx = indexOfId(label.id!);
  if (idx >= 0) elements[idx] = applyPatch(elements[idx], labelPatch);
}

// ─── Read ─────────────────────────────────────────────────────────────

export function getAll(): CanvasElement[] {
  return elements.map((e) => ({ ...e }));
}

export function getById(id: string): CanvasElement | null {
  const found = elements.find((e) => e.id === id);
  return found ? { ...found } : null;
}

export function query(opts: {
  type?: string;
  groupId?: string;
  containerId?: string;
  textContains?: string;
}): CanvasElement[] {
  return elements.filter((e) => {
    if (opts.type && e.type !== opts.type) return false;
    if (opts.groupId && !(e.groupIds ?? []).includes(opts.groupId)) return false;
    if (opts.containerId && e.containerId !== opts.containerId) return false;
    if (opts.textContains) {
      const haystack = (e.text ?? "") + " " + (e.name ?? "");
      if (!haystack.toLowerCase().includes(opts.textContains.toLowerCase())) return false;
    }
    return true;
  });
}

// ─── Create ───────────────────────────────────────────────────────────

export function createOne(input: unknown): CanvasElement {
  // Route through normalizeBatch so shape-with-text gets expanded into
  // shape + bound text the same way create_batch does. We return the
  // primary element (the shape) so the agent sees the id it can target
  // for follow-up updates; the bound text element is stored too but not
  // surfaced to the operator unless they query for it.
  const expanded = normalizeBatch([input]);
  const primary = expanded[0];
  for (const el of expanded) {
    const existing = indexOfId(el.id!);
    if (existing >= 0) elements[existing] = el;
    else elements.push(el);
  }
  broadcast();
  return primary;
}

/**
 * Draw a labeled arrow between two existing elements, computing the
 * geometry from each element's current bounding box. Agents call this
 * instead of hand-rolling create_element({type:"arrow", points:[...],
 * startBinding:..., endBinding:...}) — which is the #1 source of
 * "the arrow doesn't follow when I drag the box" complaints.
 */
export function createConnection(opts: {
  fromId: string;
  toId: string;
  label?: string;
  strokeStyle?: "solid" | "dashed" | "dotted";
  strokeColor?: string;
  endArrowhead?: "arrow" | "bar" | "dot" | "triangle" | null;
  startArrowhead?: "arrow" | "bar" | "dot" | "triangle" | null;
}): CanvasElement {
  const from = elements.find((e) => e.id === opts.fromId);
  const to = elements.find((e) => e.id === opts.toId);
  if (!from) throw new Error(`fromId not found: ${opts.fromId}`);
  if (!to) throw new Error(`toId not found: ${opts.toId}`);
  const fx = from.x + (from.width ?? 0) / 2;
  const fy = from.y + (from.height ?? 0) / 2;
  const tx = to.x + (to.width ?? 0) / 2;
  const ty = to.y + (to.height ?? 0) / 2;
  const input = {
    type: "arrow",
    x: fx,
    y: fy,
    width: tx - fx,
    height: ty - fy,
    points: [
      [0, 0],
      [tx - fx, ty - fy],
    ],
    startBinding: { elementId: opts.fromId, focus: 0, gap: 4 },
    endBinding: { elementId: opts.toId, focus: 0, gap: 4 },
    startArrowhead: opts.startArrowhead ?? null,
    endArrowhead: opts.endArrowhead === undefined ? "arrow" : opts.endArrowhead,
    strokeColor: opts.strokeColor ?? "#3b3b3b",
    strokeStyle: opts.strokeStyle ?? "solid",
    strokeWidth: 2,
    roughness: 0,
    text: opts.label,
  };
  // Route through createOne so the label expansion + back-ref
  // reconciliation runs.
  return createOne(input);
}

export function createMany(input: unknown): CanvasElement[] {
  const arr = Array.isArray(input) ? input : [];
  const normalized = normalizeBatch(arr);
  for (const el of normalized) {
    const existing = indexOfId(el.id!);
    if (existing >= 0) elements[existing] = el;
    else elements.push(el);
  }
  broadcast();
  return normalized;
}

// ─── Update ───────────────────────────────────────────────────────────

/**
 * Strip `text` from a patch destined for a labelable container — the
 * label lives in a bound text element, not on the container itself.
 * Keep the original patch for label-sync (so syncBoundLabel sees the
 * intended text), but apply a cleaned version to the container.
 */
function patchForContainer(
  existing: CanvasElement,
  patch: Partial<CanvasElement>,
): Partial<CanvasElement> {
  if (!LABELABLE_TYPES.has(existing.type)) return patch;
  if (!("text" in patch)) return patch;
  const cleaned = { ...patch };
  delete (cleaned as { text?: unknown }).text;
  return cleaned;
}

export function updateOne(id: string, patch: Partial<CanvasElement>): CanvasElement {
  const idx = indexOfId(id);
  if (idx < 0) throw new Error(`element not found: ${id}`);
  const existing = elements[idx];
  const containerPatch = patchForContainer(existing, patch);
  const next = applyPatch(existing, containerPatch);
  elements[idx] = next;
  syncBoundLabel(next, patch);
  broadcast();
  return next;
}

export function updateMany(updates: Array<{ id: string; patch: Partial<CanvasElement> }>): CanvasElement[] {
  const out: CanvasElement[] = [];
  for (const u of updates) {
    const idx = indexOfId(u.id);
    if (idx < 0) continue;
    const existing = elements[idx];
    const containerPatch = patchForContainer(existing, u.patch);
    elements[idx] = applyPatch(existing, containerPatch);
    syncBoundLabel(elements[idx], u.patch);
    out.push(elements[idx]);
  }
  if (out.length > 0) broadcast();
  return out;
}

// ─── Delete ───────────────────────────────────────────────────────────

export function deleteIds(ids: string[]): { deleted: string[] } {
  const set = new Set(ids);
  // Cascade: deleting a container also deletes any text element bound to
  // it as a label. Without this the canvas keeps orphan labels floating
  // over empty space after the agent removes a node.
  for (const el of elements) {
    if (el.type === "text" && el.containerId && set.has(el.containerId)) {
      set.add(el.id!);
    }
  }
  const before = elements.length;
  elements = elements.filter((e) => !set.has(e.id!));
  // `deleted` reports every id the caller asked for; cascaded label ids
  // are implementation detail and not surfaced.
  const deleted = ids.filter((id) => !elements.some((e) => e.id === id));
  if (elements.length !== before) broadcast();
  return { deleted };
}

export function clearAll(): void {
  elements = [];
  // Single broadcast; canvas.clear is the authoritative reset signal and
  // the UI already treats it as a scene wipe. A trailing canvas.update
  // with [] is redundant and races with the clear on slow links.
  broadcastCanvasClear();
}

// ─── Arrange ──────────────────────────────────────────────────────────
// Excalidraw's z-order is the order of the elements array — index 0 is
// drawn first (back), last index is drawn last (front).

export function bringToFront(ids: string[]): void {
  const set = new Set(ids);
  const moved = elements.filter((e) => set.has(e.id!));
  elements = elements.filter((e) => !set.has(e.id!)).concat(moved);
  if (moved.length > 0) broadcast();
}

export function sendToBack(ids: string[]): void {
  const set = new Set(ids);
  const moved = elements.filter((e) => set.has(e.id!));
  elements = moved.concat(elements.filter((e) => !set.has(e.id!)));
  if (moved.length > 0) broadcast();
}

export function bringForward(ids: string[]): void {
  const set = new Set(ids);
  // Walk from end so swaps don't cascade. Each selected element moves up
  // one slot if its neighbor isn't also selected.
  for (let i = elements.length - 2; i >= 0; i--) {
    if (set.has(elements[i].id!) && !set.has(elements[i + 1].id!)) {
      [elements[i], elements[i + 1]] = [elements[i + 1], elements[i]];
    }
  }
  if (set.size > 0) broadcast();
}

export function sendBackward(ids: string[]): void {
  const set = new Set(ids);
  for (let i = 1; i < elements.length; i++) {
    if (set.has(elements[i].id!) && !set.has(elements[i - 1].id!)) {
      [elements[i], elements[i - 1]] = [elements[i - 1], elements[i]];
    }
  }
  if (set.size > 0) broadcast();
}

export function group(ids: string[]): { groupId: string } {
  const groupId = `group-${Math.random().toString(36).slice(2, 10)}`;
  for (const e of elements) {
    if (ids.includes(e.id!)) {
      e.groupIds = Array.from(new Set([...(e.groupIds ?? []), groupId]));
    }
  }
  broadcast();
  return { groupId };
}

export function ungroup(groupId: string): { affected: string[] } {
  const affected: string[] = [];
  for (const e of elements) {
    if ((e.groupIds ?? []).includes(groupId)) {
      e.groupIds = (e.groupIds ?? []).filter((g) => g !== groupId);
      affected.push(e.id!);
    }
  }
  if (affected.length > 0) broadcast();
  return { affected };
}

// ─── View ─────────────────────────────────────────────────────────────

export function fitToContent(): void {
  broadcastCanvasView({ fitToContent: true });
}

export function scrollTo(elementId: string): void {
  broadcastCanvasView({ scrollToElementId: elementId });
}

export function setZoom(zoom: number): void {
  broadcastCanvasView({ zoom });
}

// ─── Import / export ──────────────────────────────────────────────────

export function exportScene(): { type: "excalidraw"; version: 2; source: string; elements: CanvasElement[] } {
  // Shape mirrors Excalidraw's File > Save As JSON output so operators
  // can load this directly via the Excalidraw native importer.
  return {
    type: "excalidraw",
    version: 2,
    source: "infinibot-mcp-excalidraw",
    elements: getAll(),
  };
}

export function importScene(scene: unknown): { count: number } {
  const obj = (scene && typeof scene === "object" ? scene : {}) as { elements?: unknown };
  if (!Array.isArray(obj.elements)) {
    throw new Error("invalid scene: missing `elements` array");
  }
  const normalized = normalizeBatch(obj.elements);
  elements = normalized;
  broadcast();
  return { count: normalized.length };
}
