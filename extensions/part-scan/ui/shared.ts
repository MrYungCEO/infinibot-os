import { css, html, svg, type TemplateResult } from "lit";

export type PartScanClient = {
  request<T = unknown>(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<T>;
  subscribe?(handler: (event: { event: string; payload?: unknown }) => void): () => void;
};

export interface Dimensions {
  bboxMm: { length: number; width: number; height: number };
  orientedBboxMm: { length: number; width: number; height: number };
  surfaceAreaMm2: number;
  volumeMm3: number | null;
  watertight: boolean;
  scaleSource: string;
  reprojectionErrorPx: number | null;
  scaleErrorMm: number | null;
}

export interface Job {
  status: "capturing" | "queued" | "processing" | "done" | "failed";
  stage: string;
  progress: number;
  logTail: string[];
  error: string | null;
}

export interface Scan {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  imageCount: number;
  job: Job;
  modelReady: boolean;
  previewReady: boolean;
  dims?: Dimensions;
}

export interface ScanImage {
  sequence: number;
  file: string;
  turntableAngle?: number;
  heightPass?: number;
  sharpness?: number;
}

export interface Config {
  workerMode: "docker" | "local-cli" | "off";
  markerSquareMm: number;
  markerDictionary: string;
  boardCols: number;
  boardRows: number;
  quality: "fast" | "balanced" | "high";
}

const ICONS: Record<string, string> = {
  scan: "M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M7 12h10",
  camera: "M4 7h3l2-2h6l2 2h3v12H4zM12 10a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  cube: "M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9",
  download: "M12 3v12M7 10l5 5 5-5M4 21h16",
  play: "M8 5l11 7-11 7z",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13",
  plus: "M12 5v14M5 12h14",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7",
  close: "M6 6l12 12M18 6L6 18",
  focus: "M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4",
};

export function icon(name: string, size = 16): TemplateResult {
  return html`<svg width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    ${svg`<path d=${ICONS[name] ?? ICONS.scan}></path>`}
  </svg>`;
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
  return String(error);
}

export function withGatewayToken(url: string): string {
  if (typeof location === "undefined") return url;
  const token = new URLSearchParams(location.search).get("token");
  if (!token) return url;
  const out = new URL(url, location.origin);
  out.searchParams.set("token", token);
  return `${out.pathname}${out.search}`;
}

export const pageStyles = css`
  :host { display:block; color:var(--text); font-family:var(--font-body); container-type:inline-size; }
  * { box-sizing:border-box; }
  button, select, input { font:inherit; }
  button { color:inherit; }
  .page { max-width:1320px; margin:0 auto; padding:20px 20px 56px; display:flex; flex-direction:column; gap:16px; }
  .head, .row { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .head { justify-content:space-between; align-items:flex-end; }
  .eyebrow { color:var(--accent); text-transform:uppercase; letter-spacing:.12em; font-size:10px; font-weight:700; }
  h1 { margin:3px 0 0; font-size:clamp(25px,3vw,38px); color:var(--text-strong); line-height:1; }
  h2, h3, p { margin:0; }
  .lede { color:var(--muted); margin-top:8px; max-width:720px; font-size:13px; }
  .card { background:color-mix(in srgb,var(--surface, #15171c) 82%,transparent); border:1px solid var(--border); border-radius:16px; box-shadow:var(--shadow-sm); }
  .btn { border:1px solid var(--border); background:var(--surface-2); border-radius:9px; padding:8px 12px; display:inline-flex; align-items:center; gap:7px; cursor:pointer; min-height:36px; }
  .btn:hover { border-color:color-mix(in srgb,var(--accent) 52%,var(--border)); }
  .btn.primary { background:var(--accent); border-color:var(--accent); color:var(--accent-contrast,#080808); font-weight:700; }
  .btn.ghost { background:transparent; }
  .btn.danger { color:var(--danger,#f87171); }
  .btn:disabled { opacity:.45; cursor:not-allowed; }
  .muted { color:var(--muted); }
  .small { font-size:12px; }
  .spacer { flex:1; }
  .chip { display:inline-flex; align-items:center; gap:5px; padding:4px 8px; border-radius:999px; border:1px solid var(--border); color:var(--muted); font-size:11px; }
  .error { padding:10px 12px; border:1px solid color-mix(in srgb,var(--danger,#f87171) 50%,transparent); background:color-mix(in srgb,var(--danger,#f87171) 10%,transparent); color:var(--danger,#f87171); border-radius:10px; font-size:12px; }
  .empty { padding:28px; text-align:center; color:var(--muted); border:1px dashed var(--border); border-radius:12px; }
  select, input { color:var(--text); background:var(--surface-2); border:1px solid var(--border); border-radius:8px; min-height:36px; padding:7px 9px; }
  @container (max-width:600px) { .page{padding:14px 12px 40px}.head>.row{width:100%}.head .btn{flex:1;justify-content:center} }
`;
