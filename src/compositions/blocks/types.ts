/**
 * Block definition + style schema for the video editor.
 *
 * A `BlockDefinition` is the canonical "what is this block, what can be
 * customized, and what does it render" record. Both server (catalog +
 * persistence) and UI (palette + inspector) read the same shape so adding
 * a new block is a single-source change.
 */

// ── Style fields ────────────────────────────────────────────

/** A single user-editable style field on a block. */
export type BlockStyleField =
  | {
      id: string;
      label: string;
      kind: "color";
      group?: string;
      default: string;
      help?: string;
    }
  | {
      id: string;
      label: string;
      kind: "font";
      group?: string;
      default: string;
      /** Optional curated suggestions in addition to the freeform input. */
      suggestions?: string[];
      help?: string;
    }
  | {
      id: string;
      label: string;
      kind: "number";
      group?: string;
      default: number;
      min?: number;
      max?: number;
      step?: number;
      unit?: "px" | "em" | "%" | "deg" | "ms" | "x" | "";
      help?: string;
    }
  | {
      id: string;
      label: string;
      kind: "select";
      group?: string;
      default: string;
      options: Array<{ value: string; label: string }>;
      help?: string;
    }
  | {
      id: string;
      label: string;
      kind: "text";
      group?: string;
      default: string;
      multiline?: boolean;
      help?: string;
    }
  | {
      id: string;
      label: string;
      kind: "boolean";
      group?: string;
      default: boolean;
      help?: string;
    }
  | {
      id: string;
      label: string;
      kind: "shadow";
      group?: string;
      /** CSS shadow string, e.g. "0 8px 24px rgba(0,0,0,.4)". */
      default: string;
      help?: string;
    }
  | {
      id: string;
      label: string;
      kind: "gradient";
      group?: string;
      /** CSS gradient string, e.g. "linear-gradient(180deg, #000 0%, #fff 100%)". */
      default: string;
      help?: string;
    };

export type BlockStyleSchema = BlockStyleField[];

// ── Slots ───────────────────────────────────────────────────

/** Editable text/content fields like headline, subheadline. */
export interface BlockSlot {
  key: string;
  label: string;
  default: string;
  multiline?: boolean;
  /** Optional limit hint shown in UI (does not enforce on save). */
  maxChars?: number;
}

// ── Presets ─────────────────────────────────────────────────

/** A preset is a named bundle of style-field overrides. */
export interface BlockPreset {
  id: string;
  label: string;
  description?: string;
  /** Map of styleField.id → value. Partial — fields absent fall back to default. */
  values: Record<string, string | number | boolean>;
}

// ── Animation hooks ─────────────────────────────────────────

export type BlockAnimationKind =
  | "none"
  | "fade"
  | "slideUp"
  | "slideDown"
  | "slideLeft"
  | "slideRight"
  | "scale"
  | "blur"
  | "kinetic";

export interface BlockAnimationDefault {
  kind: BlockAnimationKind;
  durationSec: number;
}

// ── Block definition ────────────────────────────────────────

export interface BlockDefinition {
  /** Stable id; what BlockClipProps.blockId points at. */
  id: string;
  /** Short human label for the palette. */
  label: string;
  /** One-line description for the palette tooltip / template gallery. */
  description: string;
  /** Tags for filtering (e.g. ["title","intro","editorial"]). */
  tags: string[];
  /** Suggested aspect (informational; doesn't enforce). */
  aspect?: "16:9" | "9:16" | "1:1" | "any";
  /** Recommended duration in seconds for new placements. */
  defaultDurationSec: number;
  /** Slots for editable text content. */
  slots: BlockSlot[];
  /** Style fields editable on every instance. */
  styleSchema: BlockStyleSchema;
  /** Built-in preset bundles (Bold / Minimal / Editorial / etc.). */
  presets: BlockPreset[];
  /** Default animations for in/out — used when the user doesn't override. */
  defaultAnimateIn?: BlockAnimationDefault;
  defaultAnimateOut?: BlockAnimationDefault;
  /** Default placement on the canvas. */
  defaultPlacement?: { x: number; y: number; width: number; height: number };
  /** Built-in marker — true for the canonical catalog. User-added blocks set this false. */
  builtIn: boolean;
  /**
   * Optional raw HTML template with `{{slotKey}}` placeholders. When present,
   * the renderer (preview + Playwright export) substitutes slots and renders
   * this template instead of looking up a hardcoded block id. Lets the agent
   * author entirely new visual blocks without a code change.
   */
  template?: string;
  /** Per-block CSS, scoped to `.veblk-<id>` at mount. */
  css?: string;
  /** Lucide icon name for the palette (defaults to "sparkles" for custom blocks). */
  icon?: string;
  /** Created/updated wall-clock for user blocks. */
  createdAt?: number;
  updatedAt?: number;
}

// ── Templates ───────────────────────────────────────────────

/**
 * A saved composition template. References block defs by id. Persisted alongside
 * built-in presets so the UI can show both in the gallery.
 */
export interface CompositionTemplate {
  id: string;
  name: string;
  description?: string;
  thumbnail?: string;
  tags: string[];
  /** Composition-level fields (canvas, fps, bg). */
  composition: {
    name: string;
    widthPx: number;
    heightPx: number;
    fps: number;
    durationSec: number;
    bgColor: string;
  };
  /** Track stubs (id placeholders only — IDs are remapped on clone). */
  tracks: Array<{
    name: string;
    kind: string;
    sortOrder: number;
  }>;
  /** Clip seeds — IDs are remapped on clone, trackId references the index of `tracks`. */
  clips: Array<{
    trackIndex: number;
    kind: string;
    label?: string;
    startSec: number;
    durationSec: number;
    z: number;
    props: Record<string, unknown>;
  }>;
  builtIn: boolean;
  createdAt: number;
  updatedAt: number;
}

// ── Catalog file shape (persistence) ────────────────────────

export interface BlocksCatalogFile {
  version: 1;
  /** User-added blocks (built-ins are computed at runtime, not stored). */
  customBlocks: BlockDefinition[];
  /** User-saved templates. */
  templates: CompositionTemplate[];
}
