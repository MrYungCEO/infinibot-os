/**
 * Templates registry. Resolves template JSON shipped under
 * `extensions/mcp-excalidraw/templates/<category>/<slug>.json`.
 *
 * At build time Vite globs them as raw JSON; at runtime we expose a flat
 * list grouped by category. Template payload is an Excalidraw scene
 * (`{ elements, files?, appState? }`) plus optional `width`/`height`/
 * `background` for a target page size.
 */

export type TemplateCategory =
  | "social"
  | "story"
  | "ebook"
  | "workbook"
  | "planner"
  | "invoice"
  | "lead-magnet"
  | "worksheet"
  | "course-thumbnail";

export const TEMPLATE_CATEGORIES: { id: TemplateCategory; label: string }[] = [
  { id: "social", label: "Social" },
  { id: "story", label: "Story" },
  { id: "ebook", label: "Ebook page" },
  { id: "workbook", label: "Workbook" },
  { id: "planner", label: "Planner" },
  { id: "invoice", label: "Invoice" },
  { id: "lead-magnet", label: "Lead magnet" },
  { id: "worksheet", label: "Worksheet" },
  { id: "course-thumbnail", label: "Course thumbnail" },
];

export type CanvasTemplate = {
  id: string;
  category: TemplateCategory;
  name: string;
  width: number;
  height: number;
  background: string;
  scene: {
    elements: unknown[];
    appState?: Record<string, unknown>;
    files?: Record<string, unknown>;
  };
};

// Vite's `import.meta.glob` would normally bundle these. We keep an
// import path resolver loose because the templates dir lives outside
// this package - the build pipeline (or a future asset copy step) is
// expected to expose them under `/canvas-templates/` at runtime.
// Falls back to an inlined seed list if the fetch path is unavailable
// (e.g. unit tests).
let cache: CanvasTemplate[] | null = null;

export async function loadTemplates(): Promise<CanvasTemplate[]> {
  if (cache) return cache;
  try {
    const res = await fetch("/canvas-templates/index.json", { cache: "no-store" });
    if (res.ok) {
      const list = (await res.json()) as CanvasTemplate[];
      cache = list;
      return list;
    }
  } catch {
    /* fall through to inline seed */
  }
  cache = INLINE_SEED;
  return cache;
}

export function clearTemplatesCache(): void {
  cache = null;
}

/**
 * Inline minimal seed - guarantees the templates panel never renders an
 * empty list even before the asset copy step is wired. Each entry is a
 * single labelled rectangle on a sized canvas. The richer JSON files
 * under `extensions/mcp-excalidraw/templates/` supersede these once the
 * static asset path is live.
 */
const INLINE_SEED: CanvasTemplate[] = [
  seedTemplate("social", "Square post", 1080, 1080, "#fafafa", "Your headline here"),
  seedTemplate("story", "Story 9:16", 1080, 1920, "#1a1a1a", "Swipe up"),
  seedTemplate("ebook", "Ebook page", 1240, 1754, "#ffffff", "Chapter title"),
  seedTemplate("workbook", "Workbook page", 1240, 1754, "#fffaf0", "Exercise 1"),
  seedTemplate("planner", "Daily planner", 1240, 1754, "#f5f5fa", "Today"),
  seedTemplate("invoice", "Invoice A4", 1240, 1754, "#ffffff", "INVOICE"),
  seedTemplate("lead-magnet", "Lead magnet cover", 1080, 1350, "#0b0b14", "Free guide"),
  seedTemplate("worksheet", "Worksheet", 1240, 1754, "#ffffff", "Worksheet"),
  seedTemplate("course-thumbnail", "Course thumbnail", 1280, 720, "#111827", "Course title"),
];

function seedTemplate(
  category: TemplateCategory,
  name: string,
  width: number,
  height: number,
  background: string,
  text: string
): CanvasTemplate {
  return {
    id: `seed-${category}`,
    category,
    name,
    width,
    height,
    background,
    scene: {
      elements: [
        {
          id: `seed-${category}-t`,
          type: "text",
          x: width * 0.1,
          y: height * 0.45,
          width: width * 0.8,
          height: 80,
          text,
          fontSize: 48,
          fontFamily: 1,
          textAlign: "center",
          strokeColor: background === "#ffffff" || background === "#fafafa" ? "#000" : "#fff",
        },
      ],
    },
  };
}
