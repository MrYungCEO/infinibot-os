/**
 * Element types, defaults, and validators for the Excalidraw canvas.
 *
 * Source of truth: @excalidraw/excalidraw element shape (we mirror the
 * fields the React canvas accepts via `updateScene({elements})`). We don't
 * import the @excalidraw types directly because this MCP server is a
 * separate process from the UI bundle and we want it dependency-light.
 *
 * Each element gets:
 *   - a stable `id` (operator-supplied or generated)
 *   - sane defaults for fill/stroke/opacity so a one-line `create_element`
 *     call produces something visible without the operator passing 12 fields
 *   - validation via Zod so a bad input from the agent surfaces as a
 *     readable error instead of silently corrupting the canvas state
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";

// ─── Element shape ────────────────────────────────────────────────────

export const ELEMENT_TYPES = [
  "rectangle",
  "ellipse",
  "diamond",
  "line",
  "arrow",
  "text",
  "freedraw",
  "image",
  "frame",
] as const;

export type ElementType = (typeof ELEMENT_TYPES)[number];

/** Subset of the Excalidraw element schema we let agents drive. We
 *  intentionally exclude internal versioning, seed, isDeleted, etc. — the
 *  React canvas re-derives those on `updateScene`. */
export const ElementSchema = z.object({
  id: z.string().optional(),
  type: z.enum(ELEMENT_TYPES),
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative().optional(),
  height: z.number().nonnegative().optional(),

  // Style
  strokeColor: z.string().optional(),
  backgroundColor: z.string().optional(),
  fillStyle: z.enum(["hachure", "cross-hatch", "solid", "zigzag", "dots"]).optional(),
  strokeWidth: z.number().positive().optional(),
  strokeStyle: z.enum(["solid", "dashed", "dotted"]).optional(),
  roughness: z.number().min(0).max(2).optional(),
  opacity: z.number().min(0).max(100).optional(),
  roundness: z.object({ type: z.number(), value: z.number().optional() }).nullable().optional(),

  // Text-specific
  text: z.string().optional(),
  fontSize: z.number().positive().optional(),
  fontFamily: z.number().int().optional(),
  textAlign: z.enum(["left", "center", "right"]).optional(),
  verticalAlign: z.enum(["top", "middle", "bottom"]).optional(),
  containerId: z.string().nullable().optional(),

  // Arrow / line points (relative to x/y)
  points: z.array(z.tuple([z.number(), z.number()])).optional(),
  startBinding: z
    .object({
      elementId: z.string(),
      focus: z.number().optional(),
      gap: z.number().optional(),
    })
    .nullable()
    .optional(),
  endBinding: z
    .object({
      elementId: z.string(),
      focus: z.number().optional(),
      gap: z.number().optional(),
    })
    .nullable()
    .optional(),
  startArrowhead: z.enum(["arrow", "bar", "dot", "triangle"]).nullable().optional(),
  endArrowhead: z.enum(["arrow", "bar", "dot", "triangle"]).nullable().optional(),

  // Freedraw
  pressures: z.array(z.number()).optional(),
  simulatePressure: z.boolean().optional(),

  // Image
  fileId: z.string().optional(),
  status: z.enum(["pending", "saved", "error"]).optional(),
  scale: z.tuple([z.number(), z.number()]).optional(),

  // Frame / grouping
  groupIds: z.array(z.string()).optional(),
  frameId: z.string().nullable().optional(),
  name: z.string().optional(),

  // Visibility / lifecycle
  locked: z.boolean().optional(),
  angle: z.number().optional(),

  // Excalidraw runtime fields. We don't expose these to the agent (they're
  // populated by `excalidrawRuntimeDefaults()` below) but the schema needs
  // to permit them so `applyPatch` round-trips don't strip them — Zod's
  // default mode strips unknown keys.
  isDeleted: z.boolean().optional(),
  boundElements: z.array(z.unknown()).nullable().optional(),
  link: z.string().nullable().optional(),
  seed: z.number().optional(),
  version: z.number().optional(),
  versionNonce: z.number().optional(),
  updated: z.number().optional(),
  customData: z.record(z.string(), z.unknown()).nullable().optional(),
  index: z.string().nullable().optional(),
});

export type CanvasElement = z.infer<typeof ElementSchema>;

// ─── Defaults ─────────────────────────────────────────────────────────
//
// Tuned for visibility on a dark theme (the InfiniBot whiteboard's
// background) and to match the connector-rectangle pattern in
// skills/excalidraw/SKILL.md. Operators rarely need to override these
// for a quick "draw me a flow chart" task.

const DEFAULT_STROKE_COLOR = "#1e1e1e";
const DEFAULT_BACKGROUND_COLOR = "transparent";
const DEFAULT_FILL_STYLE = "solid" as const;
const DEFAULT_STROKE_WIDTH = 2;
const DEFAULT_STROKE_STYLE = "solid" as const;
const DEFAULT_ROUGHNESS = 1;
const DEFAULT_OPACITY = 100;

const SHAPE_TYPES = new Set<ElementType>(["rectangle", "ellipse", "diamond"]);

function defaultsForType(type: ElementType): Partial<CanvasElement> {
  if (SHAPE_TYPES.has(type)) {
    return {
      strokeColor: DEFAULT_STROKE_COLOR,
      backgroundColor: DEFAULT_BACKGROUND_COLOR,
      fillStyle: DEFAULT_FILL_STYLE,
      strokeWidth: DEFAULT_STROKE_WIDTH,
      strokeStyle: DEFAULT_STROKE_STYLE,
      roughness: DEFAULT_ROUGHNESS,
      opacity: DEFAULT_OPACITY,
      width: 200,
      height: 100,
      angle: 0,
    };
  }
  if (type === "text") {
    return {
      strokeColor: DEFAULT_STROKE_COLOR,
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 1,
      strokeStyle: "solid",
      roughness: DEFAULT_ROUGHNESS,
      opacity: DEFAULT_OPACITY,
      fontSize: 20,
      fontFamily: 1, // 1 = Virgil (Excalidraw default hand-drawn)
      textAlign: "left",
      verticalAlign: "top",
      angle: 0,
    };
  }
  if (type === "arrow" || type === "line") {
    return {
      strokeColor: DEFAULT_STROKE_COLOR,
      backgroundColor: "transparent",
      fillStyle: DEFAULT_FILL_STYLE,
      strokeWidth: DEFAULT_STROKE_WIDTH,
      strokeStyle: DEFAULT_STROKE_STYLE,
      roughness: DEFAULT_ROUGHNESS,
      opacity: DEFAULT_OPACITY,
      points: [
        [0, 0],
        [100, 0],
      ],
      startArrowhead: type === "arrow" ? null : null,
      endArrowhead: type === "arrow" ? "arrow" : null,
      angle: 0,
    };
  }
  if (type === "freedraw") {
    return {
      strokeColor: DEFAULT_STROKE_COLOR,
      strokeWidth: DEFAULT_STROKE_WIDTH,
      strokeStyle: DEFAULT_STROKE_STYLE,
      roughness: 0,
      opacity: DEFAULT_OPACITY,
      simulatePressure: true,
      angle: 0,
    };
  }
  if (type === "image") {
    return {
      strokeColor: "transparent",
      backgroundColor: "transparent",
      fillStyle: "hachure",
      strokeWidth: 1,
      strokeStyle: "solid",
      roughness: 0,
      opacity: DEFAULT_OPACITY,
      width: 300,
      height: 200,
      scale: [1, 1],
      angle: 0,
    };
  }
  // frame
  return {
    strokeColor: "#bbbbbb",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "dashed",
    roughness: 0,
    opacity: DEFAULT_OPACITY,
    width: 600,
    height: 400,
    angle: 0,
  };
}

/**
 * Normalize an operator-supplied element: fill in missing fields with
 * sane defaults, generate an id if absent, validate the result. Throws
 * with a readable message if the input is malformed.
 */
// Fields the Excalidraw 0.18 React canvas dereferences without null-checking.
// If any of these are missing, the renderer throws (e.g. `el.groupIds.length`
// → "can't access property 'length', l.groupIds is undefined") and bricks the
// entire scene. Always fill with safe empties — operators don't need to
// know about these internals.
type ExcalidrawRuntimeRequired = {
  groupIds: string[];
  boundElements: null | unknown[];
  link: null | string;
  locked: boolean;
  isDeleted: boolean;
  roundness: null | { type: number };
  seed: number;
  version: number;
  versionNonce: number;
  updated: number;
  customData: null | Record<string, unknown>;
  index: null | string;
};

function excalidrawRuntimeDefaults(): ExcalidrawRuntimeRequired {
  // `seed`/`versionNonce` need to be deterministic per-element but unique
  // across elements (Excalidraw uses them for hashing/dirty checks).
  // Use crypto-random ints so we never collide.
  const rand = () => Math.floor(Math.random() * 2 ** 31);
  return {
    groupIds: [],
    boundElements: null,
    link: null,
    locked: false,
    isDeleted: false,
    roundness: null,
    seed: rand(),
    version: 1,
    versionNonce: rand(),
    updated: Date.now(),
    customData: null,
    index: null,
  };
}

function rand(): number {
  return Math.floor(Math.random() * 2 ** 31);
}

export function normalizeElement(input: unknown): CanvasElement {
  const parsed = ElementSchema.parse(input);
  const defaults = defaultsForType(parsed.type);
  const runtime = excalidrawRuntimeDefaults();
  const merged: CanvasElement = {
    ...runtime,
    ...defaults,
    ...parsed,
    id: parsed.id || `${parsed.type}-${randomUUID().slice(0, 8)}`,
  };
  // Required-by-Excalidraw fields that don't have a sensible "absent"
  // representation — fill last so user overrides win when present.
  if (merged.width === undefined) merged.width = 0;
  if (merged.height === undefined) merged.height = 0;
  if (merged.angle === undefined) merged.angle = 0;
  // Defensive: make sure groupIds is an array even if a buggy patch path
  // upstream somehow blew it away. The crash this prevents is the worst
  // class of failure — Excalidraw goes blank for the rest of the session.
  if (!Array.isArray((merged as unknown as ExcalidrawRuntimeRequired).groupIds)) {
    (merged as unknown as ExcalidrawRuntimeRequired).groupIds = [];
  }
  return merged;
}

export function normalizeBatch(input: unknown[]): CanvasElement[] {
  if (!Array.isArray(input)) throw new Error("expected an array of elements");
  const out: CanvasElement[] = [];
  for (let idx = 0; idx < input.length; idx++) {
    try {
      const el = normalizeElement(input[idx]);
      const expanded = expandWithText(el);
      out.push(...expanded);
    } catch (err) {
      throw new Error(`element[${idx}]: ${(err as Error).message}`);
    }
  }
  return out;
}

const SHAPE_WITH_TEXT_TYPES = new Set<ElementType>(["rectangle", "ellipse", "diamond"]);
const LABELABLE_TYPES = new Set<ElementType>(["rectangle", "ellipse", "diamond", "arrow", "line"]);

/**
 * Excalidraw renders labels via a separate `text` element bound to the
 * container — passing `text` on a `rectangle` or `arrow` is silently
 * ignored by the canvas otherwise. Agents call
 *   create_element({type:"rectangle", text:"X"})
 *   create_element({type:"arrow", text:"calls"})
 * and naturally expect the label to render. Honor that by splitting the
 * container into two elements: the container (no text), and a text child
 * with `containerId` pointing at it. The container's `boundElements`
 * lists the child so Excalidraw treats the text as label-bound (centered,
 * lifecycle follows the parent).
 *
 * Handles shapes (rectangle/ellipse/diamond) and arrows/lines uniformly.
 */
export function expandWithText(el: CanvasElement): CanvasElement[] {
  if (!LABELABLE_TYPES.has(el.type)) return [el];
  const text = el.text;
  if (typeof text !== "string" || text.length === 0) return [el];

  const container: CanvasElement = { ...el };
  delete (container as { text?: string }).text;

  const textId = `text-${randomUUID().slice(0, 8)}`;
  const fontSize = el.fontSize ?? (el.type === "arrow" || el.type === "line" ? 16 : 20);
  // Geometry differs for shapes (use width/height bbox) vs arrows (use
  // span between endpoints, centered on the midpoint).
  let x: number;
  let y: number;
  let textWidth: number;
  const textHeight = fontSize * 1.25;
  if (SHAPE_WITH_TEXT_TYPES.has(el.type)) {
    const width = typeof el.width === "number" && el.width > 0 ? el.width : 200;
    const height = typeof el.height === "number" && el.height > 0 ? el.height : 100;
    textWidth = Math.max(40, Math.min(width - 16, text.length * fontSize * 0.55));
    x = el.x + (width - textWidth) / 2;
    y = el.y + (height - textHeight) / 2;
  } else {
    // Arrow / line: place label at midpoint of bbox. Excalidraw will
    // re-measure on mount; this just avoids a one-frame layout pop.
    const width = typeof el.width === "number" ? el.width : 100;
    const height = typeof el.height === "number" ? el.height : 0;
    textWidth = Math.max(40, text.length * fontSize * 0.55);
    x = el.x + width / 2 - textWidth / 2;
    y = el.y + height / 2 - textHeight / 2;
  }

  const runtime = excalidrawRuntimeDefaults();
  const textEl: CanvasElement = {
    ...runtime,
    id: textId,
    type: "text",
    x,
    y,
    width: textWidth,
    height: textHeight,
    text,
    fontSize,
    fontFamily: el.fontFamily ?? 1,
    textAlign: el.textAlign ?? "center",
    verticalAlign: el.verticalAlign ?? "middle",
    strokeColor: el.strokeColor ?? "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: el.roughness ?? 1,
    opacity: el.opacity ?? 100,
    angle: 0,
    containerId: el.id ?? null,
  };

  const existingBound = Array.isArray(container.boundElements) ? container.boundElements : [];
  container.boundElements = [...existingBound, { type: "text", id: textId }];

  return [container, textEl];
}

/**
 * Patch an existing element with the supplied delta. Validates the
 * combined shape so a partial update can't put the canvas in an
 * impossible state (e.g. text element without a `text` field).
 *
 * Always bumps `version`, regenerates `versionNonce`, and refreshes
 * `updated` — Excalidraw uses these for dirty detection and undo
 * tracking. A patch that doesn't bump the version is treated as a no-op
 * by the canvas reconciler, which surfaces as "I called update_element
 * and nothing changed."
 */
export function applyPatch(existing: CanvasElement, patch: Partial<CanvasElement>): CanvasElement {
  const merged = {
    ...existing,
    ...patch,
    id: existing.id,
    version: (existing.version ?? 1) + 1,
    versionNonce: rand(),
    updated: Date.now(),
  };
  return ElementSchema.parse(merged) as CanvasElement;
}

/**
 * Reconcile arrow ↔ shape bindings across the full element set.
 *
 * Every arrow with `startBinding`/`endBinding` must have a matching
 * back-reference in the target shape's `boundElements`, otherwise
 * Excalidraw renders the arrow as a free-floating segment that doesn't
 * track when the shape is dragged. Agents constantly create arrows with
 * bindings but forget the back-ref — the MCP server is the right layer
 * to enforce it.
 *
 * Returns the mutated array so callers can wholesale-replace state.
 */
export function reconcileBindings(elements: CanvasElement[]): CanvasElement[] {
  const byId = new Map<string, CanvasElement>();
  for (const el of elements) {
    if (el.id) byId.set(el.id, el);
  }

  // First pass: collect the set of arrows each shape SHOULD reference.
  const shouldRef = new Map<string, Set<string>>(); // shapeId → arrowIds
  for (const el of elements) {
    if (el.type !== "arrow" && el.type !== "line") continue;
    const sId = el.startBinding?.elementId;
    const eId = el.endBinding?.elementId;
    if (sId && byId.has(sId)) {
      if (!shouldRef.has(sId)) shouldRef.set(sId, new Set());
      shouldRef.get(sId)!.add(el.id!);
    }
    if (eId && byId.has(eId)) {
      if (!shouldRef.has(eId)) shouldRef.set(eId, new Set());
      shouldRef.get(eId)!.add(el.id!);
    }
  }

  // Second pass: merge desired arrow back-refs into each shape's
  // `boundElements`, preserving existing text-label refs and dropping
  // stale arrow refs that no longer exist on the canvas.
  for (const el of elements) {
    const wanted = shouldRef.get(el.id ?? "") ?? new Set<string>();
    const existing = Array.isArray(el.boundElements) ? (el.boundElements as Array<{ type?: string; id?: string }>) : [];
    const keptNonArrow = existing.filter((b) => b?.type !== "arrow");
    // Preserve only arrow refs whose arrow still exists AND still binds to this shape
    const keptArrows = Array.from(wanted).map((id) => ({ type: "arrow" as const, id }));
    const merged = [...keptNonArrow, ...keptArrows];
    el.boundElements = merged.length > 0 ? merged : null;
  }

  return elements;
}
