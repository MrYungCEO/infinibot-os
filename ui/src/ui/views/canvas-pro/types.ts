/**
 * Canvas Pro - state schema.
 *
 * Layered on top of the existing Excalidraw scene. The Excalidraw React
 * canvas remains the source of truth for the raw element geometry; this
 * store augments it with concepts Excalidraw doesn't natively model
 * (named/locked layers, multiple pages, brand kit, page-level bleed).
 *
 * Backwards-compat: when an old single-scene save (just `{ elements,
 * appState, files }`) is read, `migrateLegacyScene` wraps it as a
 * one-page document with no layer metadata.
 */

export const CANVAS_PRO_SCHEMA_VERSION = 1 as const;

export type LayerMeta = {
  /** Excalidraw element id (or group id). */
  id: string;
  name: string;
  locked: boolean;
  hidden: boolean;
  /** Logical group id; siblings share the same value. */
  groupId: string | null;
};

export type PageBleed = {
  /** Bleed in px on each edge, used for print export. 0 = no bleed. */
  top: number;
  right: number;
  bottom: number;
  left: number;
};

export type CanvasPage = {
  id: string;
  name: string;
  width: number;
  height: number;
  background: string;
  /** Excalidraw scene payload for this page. */
  scene: {
    elements: unknown[];
    appState?: Record<string, unknown>;
    files?: Record<string, unknown>;
  };
  /** Per-element overlay metadata, keyed by element id. */
  layers: Record<string, LayerMeta>;
  /** Ordered element ids for the layers panel (top→bottom). */
  layerOrder: string[];
  bleed: PageBleed;
};

export type BrandColorSwatch = {
  id: string;
  name: string;
  hex: string;
};

export type BrandFontPair = {
  id: string;
  name: string;
  heading: string;
  body: string;
};

export type BrandLogo = {
  id: string;
  name: string;
  /** Data URL or canvas-host relative path. */
  src: string;
};

export type BrandKit = {
  logos: BrandLogo[];
  colors: BrandColorSwatch[];
  fontPairs: BrandFontPair[];
  /** Brand template ids (resolved against the templates registry). */
  templateIds: string[];
};

export type CanvasProDocument = {
  schemaVersion: typeof CANVAS_PRO_SCHEMA_VERSION;
  id: string;
  name: string;
  pages: CanvasPage[];
  activePageId: string;
  brandKit: BrandKit;
  updatedAt: number;
};

export type CanvasProToolId =
  | "select"
  | "text"
  | "rectangle"
  | "ellipse"
  | "polygon"
  | "star"
  | "arrow"
  | "line"
  | "freehand"
  | "image"
  | "frame"
  | "hand";

export type CanvasProAlignOp =
  | "align-left"
  | "align-center-h"
  | "align-right"
  | "align-top"
  | "align-center-v"
  | "align-bottom"
  | "distribute-h"
  | "distribute-v";

export type CanvasProExportFormat = "png" | "jpg" | "svg" | "pdf";

export type CanvasProExportOptions = {
  format: CanvasProExportFormat;
  scope: "active-page" | "all-pages";
  bleed: boolean;
  cropMarks: boolean;
  scale: number;
};
