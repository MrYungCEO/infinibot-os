/**
 * Public types for the InfiniBot canvas PDF engine.
 *
 * The canvas treats every page as an ordered list of CanvasElements.
 * PDF import → CanvasPage[]; PDF export ← CanvasPage[].
 */

export type PdfFieldKind =
  | "text"
  | "multilineText"
  | "password"
  | "checkbox"
  | "radio"
  | "dropdown"
  | "combo"
  | "signature"
  | "date"
  | "number";

export type PdfAlignment = "left" | "center" | "right";

export type PdfPermissions = {
  printing?: "highResolution" | "lowResolution" | false;
  modifying?: boolean;
  copying?: boolean;
  annotating?: boolean;
  fillingForms?: boolean;
  contentAccessibility?: boolean;
  documentAssembly?: boolean;
};

export type PdfFieldSpec = {
  kind: PdfFieldKind;
  name: string;
  pageIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  defaultValue?: string | boolean | number;
  required?: boolean;
  readOnly?: boolean;
  fontSize?: number;
  alignment?: PdfAlignment;
  /** Regex validation, stored as string for serialization. */
  validation?: string;
  /** Options for radio/dropdown/combo. */
  options?: string[];
  /** Radio groups share the same `name`; the chosen export value is `exportValue`. */
  exportValue?: string;
  placeholder?: string;
};

export type RGB = { r: number; g: number; b: number };

export type CanvasElementBase = {
  id: string;
  pageIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  opacity?: number;
};

export type CanvasTextElement = CanvasElementBase & {
  kind: "text";
  text: string;
  fontFamily?: string;
  fontSize: number;
  color?: RGB;
  bold?: boolean;
  italic?: boolean;
  alignment?: PdfAlignment;
  /**
   * If the text was imported from an existing PDF, this holds the original
   * baseline + transform so we can preserve placement on re-export.
   */
  source?: { kind: "pdf-import"; baseline?: number };
};

export type CanvasShapeElement = CanvasElementBase & {
  kind: "shape";
  shape: "rect" | "ellipse" | "line";
  fill?: RGB;
  stroke?: RGB;
  strokeWidth?: number;
  /** For shape: "line" only. */
  x2?: number;
  y2?: number;
};

export type CanvasImageElement = CanvasElementBase & {
  kind: "image";
  /** Base64 (no data: prefix) or remote URL. */
  data: string;
  mime: "image/png" | "image/jpeg";
};

export type CanvasPdfFieldElement = CanvasElementBase & {
  kind: "pdf-field";
  field: PdfFieldSpec;
};

/** Imported PDFs render their original page as a raster image behind text/edits. */
export type CanvasBackgroundElement = CanvasElementBase & {
  kind: "background";
  data: string; // base64 PNG
  mime: "image/png";
};

export type CanvasElement =
  | CanvasTextElement
  | CanvasShapeElement
  | CanvasImageElement
  | CanvasPdfFieldElement
  | CanvasBackgroundElement;

export type CanvasPage = {
  /** Stable ID per page. */
  id: string;
  /** Width/height in PDF points (1pt = 1/72 in). */
  width: number;
  height: number;
  /** Display ordering of elements; index 0 is bottom of z-stack. */
  elements: CanvasElement[];
  /** Original PDF metadata when imported. */
  source?: {
    kind: "pdf-import";
    originalPageIndex: number;
  };
};

export type PdfExportMetadata = {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string[];
  /** If set, embed PDF/A-compliant metadata where possible. */
  pdfA?: boolean;
};

export type PdfProtectOptions = {
  password?: string;
  ownerPassword?: string;
  permissions?: PdfPermissions;
};

export type PdfExportOptions = {
  fillable?: boolean;
  embedFonts?: boolean;
  bleedMm?: number;
  cropMarks?: boolean;
  metadata?: PdfExportMetadata;
  protect?: PdfProtectOptions;
};

export type PdfImportResult = {
  pages: CanvasPage[];
};
