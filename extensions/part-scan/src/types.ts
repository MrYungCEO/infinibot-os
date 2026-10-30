export type ScanStatus = "capturing" | "queued" | "processing" | "done" | "failed";
export type WorkerMode = "docker" | "local-cli" | "off";
export type ScanQuality = "fast" | "balanced" | "high";

export interface PartScanConfig {
  workerMode: WorkerMode;
  workerImage: string;
  gpu: boolean;
  markerSquareMm: number;
  markerDictionary: string;
  boardCols: number;
  boardRows: number;
  quality: ScanQuality;
  /**
   * InfiniBot Cloud workspace Machine: no GPU and no local programs, so the
   * reconstruction worker is always off (capture, boards and the viewer still work).
   */
  cloud?: boolean;
}

const on = (v: string | undefined) => /^(1|true|yes|on)$/i.test(v?.trim() ?? "");

/** A hosted InfiniBot Cloud workspace Machine (SAAS_MODE + FLEET_TENANT_ID). */
export function isCloudTenant(env: NodeJS.ProcessEnv = process.env): boolean {
  return on(env.SAAS_MODE) && Boolean(env.FLEET_TENANT_ID?.trim());
}

export const CLOUD_RECONSTRUCTION_REFUSAL =
  "3D reconstruction runs COLMAP + OpenMVS on a CUDA GPU worker, so it is available on self-hosted InfiniBot only. Capture sets, the calibration board and the viewer work here.";

export interface ScanJob {
  status: ScanStatus;
  stage: string;
  progress: number;
  logTail: string[];
  error: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
}

export interface ScanImage {
  sequence: number;
  file: string;
  turntableAngle?: number;
  heightPass?: number;
  sharpness?: number;
  bytes: number;
  capturedAt: number;
}

export interface ScanRecord {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  imageCount: number;
  job: ScanJob;
  modelReady: boolean;
  previewReady: boolean;
  dims?: PartDimensions;
}

export interface PartDimensions {
  bboxMm: { length: number; width: number; height: number };
  orientedBboxMm: { length: number; width: number; height: number };
  surfaceAreaMm2: number;
  volumeMm3: number | null;
  watertight: boolean;
  scaleSource: string;
  reprojectionErrorPx: number | null;
  scaleErrorMm: number | null;
}

export interface JobProgressEvent {
  scanId: string;
  job: ScanJob;
}

export const DEFAULT_PART_SCAN_CONFIG: PartScanConfig = {
  workerMode: "off",
  workerImage: "infinibot/part-scan-worker:cuda12.8",
  gpu: true,
  markerSquareMm: 20,
  markerDictionary: "DICT_5X5_100",
  boardCols: 5,
  boardRows: 7,
  quality: "balanced",
};

export function readPartScanConfig(
  raw: Record<string, unknown> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): PartScanConfig {
  const c = raw ?? {};
  const cloud = isCloudTenant(env);
  const workerMode =
    !cloud && (c.workerMode === "docker" || c.workerMode === "local-cli") ? c.workerMode : "off";
  const quality = c.quality === "fast" || c.quality === "high" ? c.quality : "balanced";
  const positive = (value: unknown, fallback: number, min: number, max: number) =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.min(max, Math.max(min, value))
      : fallback;
  return {
    workerMode,
    ...(cloud ? { cloud: true } : {}),
    workerImage:
      typeof c.workerImage === "string" && c.workerImage.trim()
        ? c.workerImage.trim()
        : DEFAULT_PART_SCAN_CONFIG.workerImage,
    gpu: c.gpu !== false,
    markerSquareMm: positive(c.markerSquareMm, 20, 1, 200),
    markerDictionary:
      typeof c.markerDictionary === "string" && /^DICT_[A-Z0-9_]+$/.test(c.markerDictionary)
        ? c.markerDictionary
        : DEFAULT_PART_SCAN_CONFIG.markerDictionary,
    boardCols: Math.round(positive(c.boardCols, 5, 2, 12)),
    boardRows: Math.round(positive(c.boardRows, 7, 2, 16)),
    quality,
  };
}
