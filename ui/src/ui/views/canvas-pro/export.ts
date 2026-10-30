/**
 * Export hook. PNG/JPG/SVG are produced from the Excalidraw API
 * (`exportToCanvas`, `exportToSvg`). PDF is delegated to the sibling
 * canvas-pdf engine via the `canvasPdf` global hook; this module only
 * shapes the input.
 *
 * The sibling agent owns wiring `window.canvasPdf.export`. Until it
 * lands, the PDF call rejects with a clear "PDF engine not mounted"
 * error and the shell surfaces it in the UI.
 */

import type { CanvasPage, CanvasProDocument, CanvasProExportOptions } from "./types";

// whiteboard.ts already declares `ExcalidrawLib: any` on Window; we
// read it loosely. canvasPdf is the sibling PDF engine's export hook.
declare global {
  interface Window {
    canvasPdf?: {
      export: (
        pages: CanvasPage[],
        options: CanvasProExportOptions
      ) => Promise<Blob>;
    };
  }
}

type ExcalidrawExportFn = (opts: {
  elements: unknown[];
  appState?: Record<string, unknown>;
  files?: Record<string, unknown>;
}) => Promise<HTMLCanvasElement>;
type ExcalidrawExportSvgFn = (opts: {
  elements: unknown[];
  appState?: Record<string, unknown>;
  files?: Record<string, unknown>;
}) => Promise<SVGSVGElement>;

function excalidrawCanvasExporter(): ExcalidrawExportFn | undefined {
  return (window as unknown as { ExcalidrawLib?: { exportToCanvas?: ExcalidrawExportFn } })
    .ExcalidrawLib?.exportToCanvas;
}
function excalidrawSvgExporter(): ExcalidrawExportSvgFn | undefined {
  return (window as unknown as { ExcalidrawLib?: { exportToSvg?: ExcalidrawExportSvgFn } })
    .ExcalidrawLib?.exportToSvg;
}

function pagesForScope(doc: CanvasProDocument, scope: CanvasProExportOptions["scope"]): CanvasPage[] {
  if (scope === "all-pages") return doc.pages;
  const active = doc.pages.find((p) => p.id === doc.activePageId) ?? doc.pages[0];
  return [active];
}

export async function exportDocument(
  doc: CanvasProDocument,
  options: CanvasProExportOptions
): Promise<Blob> {
  const pages = pagesForScope(doc, options.scope);

  if (options.format === "pdf") {
    if (!window.canvasPdf?.export) {
      throw new Error("PDF engine not mounted (window.canvasPdf.export missing)");
    }
    return await window.canvasPdf.export(pages, options);
  }

  if (options.format === "svg") {
    return await exportSvg(pages, options);
  }

  // png / jpg
  return await exportRaster(pages, options);
}

async function exportSvg(pages: CanvasPage[], options: CanvasProExportOptions): Promise<Blob> {
  const exportToSvg = excalidrawSvgExporter();
  if (!exportToSvg) throw new Error("Excalidraw not loaded");
  // Multi-page SVG: stack vertically separated by 16px.
  const svgs: SVGSVGElement[] = [];
  for (const p of pages) {
    const svg = await exportToSvg({
      elements: p.scene.elements,
      appState: { ...(p.scene.appState ?? {}), exportBackground: true, viewBackgroundColor: p.background },
      files: p.scene.files,
    });
    svgs.push(svg);
  }
  if (svgs.length === 1) {
    const txt = new XMLSerializer().serializeToString(svgs[0]);
    return new Blob([decorateForPrint(txt, options, pages[0])], { type: "image/svg+xml" });
  }
  // Combine into one tall SVG.
  const totalH = pages.reduce((s, p) => s + p.height + 16, 0);
  const maxW = pages.reduce((w, p) => Math.max(w, p.width), 0);
  const wrapped =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${maxW}" height="${totalH}" viewBox="0 0 ${maxW} ${totalH}">` +
    pages
      .map((p, i) => {
        const y = pages.slice(0, i).reduce((s, q) => s + q.height + 16, 0);
        const inner = new XMLSerializer().serializeToString(svgs[i]);
        return `<g transform="translate(0 ${y})">${inner}</g>`;
      })
      .join("") +
    `</svg>`;
  return new Blob([wrapped], { type: "image/svg+xml" });
}

async function exportRaster(pages: CanvasPage[], options: CanvasProExportOptions): Promise<Blob> {
  const exportToCanvas = excalidrawCanvasExporter();
  if (!exportToCanvas) throw new Error("Excalidraw not loaded");
  const mime = options.format === "jpg" ? "image/jpeg" : "image/png";
  const canvases: HTMLCanvasElement[] = [];
  for (const p of pages) {
    const cnv = await exportToCanvas({
      elements: p.scene.elements,
      appState: { ...(p.scene.appState ?? {}), exportBackground: true, viewBackgroundColor: p.background },
      files: p.scene.files,
    });
    canvases.push(cnv);
  }
  if (canvases.length === 1) {
    return await canvasToBlob(applyPrintMarks(canvases[0], pages[0], options), mime);
  }
  // Compose vertically.
  const totalH = canvases.reduce((s, c) => s + c.height + 16, 0);
  const maxW = canvases.reduce((w, c) => Math.max(w, c.width), 0);
  const composite = document.createElement("canvas");
  composite.width = maxW;
  composite.height = totalH;
  const ctx = composite.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");
  let y = 0;
  for (let i = 0; i < canvases.length; i++) {
    const c = canvases[i];
    const decorated = applyPrintMarks(c, pages[i], options);
    ctx.drawImage(decorated, 0, y);
    y += decorated.height + 16;
  }
  return await canvasToBlob(composite, mime);
}

function applyPrintMarks(
  src: HTMLCanvasElement,
  _page: CanvasPage,
  options: CanvasProExportOptions
): HTMLCanvasElement {
  if (!options.cropMarks) return src;
  const pad = 24;
  const out = document.createElement("canvas");
  out.width = src.width + pad * 2;
  out.height = src.height + pad * 2;
  const ctx = out.getContext("2d");
  if (!ctx) return src;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(src, pad, pad);
  ctx.strokeStyle = "#000";
  ctx.lineWidth = 1;
  const m = 16;
  // Four corners.
  const corners: [number, number][] = [
    [pad, pad],
    [pad + src.width, pad],
    [pad, pad + src.height],
    [pad + src.width, pad + src.height],
  ];
  for (const [x, y] of corners) {
    ctx.beginPath();
    ctx.moveTo(x - m, y);
    ctx.lineTo(x + m, y);
    ctx.moveTo(x, y - m);
    ctx.lineTo(x, y + m);
    ctx.stroke();
  }
  return out;
}

function decorateForPrint(svgText: string, options: CanvasProExportOptions, _page: CanvasPage): string {
  if (!options.cropMarks) return svgText;
  // Lightweight: append a marker comment so downstream tooling can detect.
  return `<!-- crop-marks:on -->${svgText}`;
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("canvas.toBlob returned null"));
        return;
      }
      resolve(blob);
    }, mime);
  });
}

export function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
