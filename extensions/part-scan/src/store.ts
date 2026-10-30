import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { PartDimensions, ScanImage, ScanJob, ScanRecord } from "./types.js";

const ID_RE = /^[a-z0-9][a-z0-9-]{5,80}$/;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

interface ScanMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

function atomicJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function safeName(name: unknown): string {
  const value = typeof name === "string" ? name.trim().replace(/\s+/g, " ") : "";
  return value.slice(0, 120) || `Part scan ${new Date().toLocaleDateString()}`;
}

export class PartScanStore {
  readonly root: string;
  readonly scansDir: string;
  private lastCreatedAt = 0;

  constructor(stateDir: string) {
    this.root = path.join(stateDir, "plugin-data", "part-scan");
    this.scansDir = path.join(this.root, "scans");
  }

  ensure(): void {
    fs.mkdirSync(this.scansDir, { recursive: true, mode: 0o700 });
  }

  scanDir(id: string): string {
    if (!ID_RE.test(id)) throw new Error("invalid scan id");
    return path.join(this.scansDir, id);
  }

  create(name?: unknown): ScanRecord {
    this.ensure();
    const now = Math.max(Date.now(), this.lastCreatedAt + 1);
    this.lastCreatedAt = now;
    const id = `scan-${now.toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
    const dir = this.scanDir(id);
    fs.mkdirSync(path.join(dir, "images"), { recursive: true, mode: 0o700 });
    const meta: ScanMeta = { id, name: safeName(name), createdAt: now, updatedAt: now };
    const job: ScanJob = {
      status: "capturing",
      stage: "capture",
      progress: 0,
      logTail: [],
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    atomicJson(path.join(dir, "scan.json"), meta);
    atomicJson(path.join(dir, "images.json"), []);
    atomicJson(path.join(dir, "job.json"), job);
    return this.get(id);
  }

  list(): ScanRecord[] {
    if (!fs.existsSync(this.scansDir)) return [];
    return fs
      .readdirSync(this.scansDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && ID_RE.test(entry.name))
      .map((entry) => {
        try {
          return this.get(entry.name);
        } catch {
          return null;
        }
      })
      .filter((record): record is ScanRecord => Boolean(record))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): ScanRecord {
    const dir = this.scanDir(id);
    const meta = readJson<ScanMeta>(path.join(dir, "scan.json"));
    if (!meta) throw new Error(`scan not found: ${id}`);
    const images = this.images(id);
    const job = this.readJob(id);
    return {
      ...meta,
      imageCount: images.length,
      job,
      modelReady: fs.existsSync(path.join(dir, "model.glb")),
      previewReady: fs.existsSync(path.join(dir, "preview.png")),
      dims: readJson<PartDimensions>(path.join(dir, "dims.json")),
    };
  }

  delete(id: string): void {
    const dir = this.scanDir(id);
    if (!fs.existsSync(path.join(dir, "scan.json"))) throw new Error(`scan not found: ${id}`);
    fs.rmSync(dir, { recursive: true, force: false });
  }

  images(id: string): ScanImage[] {
    return readJson<ScanImage[]>(path.join(this.scanDir(id), "images.json")) ?? [];
  }

  uploadImage(
    id: string,
    input: {
      base64: string;
      sequence: number;
      turntableAngle?: number;
      heightPass?: number;
      sharpness?: number;
    },
  ): ScanImage {
    const dir = this.scanDir(id);
    const meta = readJson<ScanMeta>(path.join(dir, "scan.json"));
    if (!meta) throw new Error(`scan not found: ${id}`);
    if (!Number.isInteger(input.sequence) || input.sequence < 0 || input.sequence > 99_999) {
      throw new Error("sequence must be an integer between 0 and 99999");
    }
    const clean = input.base64.replace(/^data:image\/jpe?g;base64,/i, "").replace(/\s/g, "");
    if (!clean || !/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) throw new Error("expected base64 JPEG data");
    const data = Buffer.from(clean, "base64");
    if (data.length < 4 || data.length > MAX_IMAGE_BYTES) throw new Error("JPEG size is invalid");
    if (data[0] !== 0xff || data[1] !== 0xd8 || data[data.length - 2] !== 0xff || data[data.length - 1] !== 0xd9) {
      throw new Error("image is not a complete JPEG");
    }
    const file = `${String(input.sequence).padStart(4, "0")}.jpg`;
    const imagePath = path.join(dir, "images", file);
    fs.writeFileSync(imagePath, data, { mode: 0o600 });
    const next: ScanImage = {
      sequence: input.sequence,
      file,
      turntableAngle:
        typeof input.turntableAngle === "number" && Number.isFinite(input.turntableAngle)
          ? ((input.turntableAngle % 360) + 360) % 360
          : undefined,
      heightPass:
        Number.isInteger(input.heightPass) && (input.heightPass ?? -1) >= 0 && (input.heightPass ?? 4) <= 2
          ? input.heightPass
          : undefined,
      sharpness:
        typeof input.sharpness === "number" && Number.isFinite(input.sharpness) ? input.sharpness : undefined,
      bytes: data.length,
      capturedAt: Date.now(),
    };
    const images = this.images(id).filter((item) => item.sequence !== input.sequence);
    images.push(next);
    images.sort((a, b) => a.sequence - b.sequence);
    atomicJson(path.join(dir, "images.json"), images);
    atomicJson(path.join(dir, "scan.json"), { ...meta, updatedAt: Date.now() });
    return next;
  }

  readJob(id: string): ScanJob {
    const job = readJson<ScanJob>(path.join(this.scanDir(id), "job.json"));
    if (!job) throw new Error(`job not found: ${id}`);
    return job;
  }

  writeJob(id: string, patch: Partial<ScanJob>): ScanJob {
    const dir = this.scanDir(id);
    const current = this.readJob(id);
    const next: ScanJob = {
      ...current,
      ...patch,
      progress: Math.max(0, Math.min(1, patch.progress ?? current.progress)),
      logTail: (patch.logTail ?? current.logTail).slice(-80),
      updatedAt: Date.now(),
    };
    atomicJson(path.join(dir, "job.json"), next);
    const meta = readJson<ScanMeta>(path.join(dir, "scan.json"));
    if (meta) atomicJson(path.join(dir, "scan.json"), { ...meta, updatedAt: next.updatedAt });
    return next;
  }

  file(id: string, name: "model.glb" | "preview.png" | "dims.json"): string {
    const file = path.join(this.scanDir(id), name);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`${name} not found`);
    return file;
  }
}

export const storeInternals = { ID_RE, MAX_IMAGE_BYTES };
