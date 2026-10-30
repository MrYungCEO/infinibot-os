/**
 * Per-lane persistence for the OCR pipeline.
 *
 * normal lane — registry JSON at <stateDir>/ocr/registry.json; sidecars next to
 *   each file in a hidden `.ocr/` folder (<name>.ocr.json + <name>.ocr.md),
 *   falling back to <stateDir>/ocr/sidecars/ when the folder is read-only.
 * secure lane — everything (registry, file bytes, sidecars) is sealed in the
 *   Secure Mode vault (AES-256-GCM). Nothing touches plaintext disk except a
 *   short-lived tmpfs copy while an engine reads the bytes.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SecureVault } from "../secure-mode/vault.js";
import type { OcrEntry, OcrLane, OcrSidecar } from "./types.js";

export const SIDECAR_DIR = ".ocr";

export interface OcrLaneStore {
  readonly lane: OcrLane;
  /** False while the secure lane is locked. */
  available(): boolean;
  loadRegistry(): Record<string, OcrEntry>;
  saveRegistry(reg: Record<string, OcrEntry>): void;
  readSidecar(entry: OcrEntry): OcrSidecar | null;
  writeSidecar(entry: OcrEntry, sc: OcrSidecar): OcrEntry;
  removeSidecar(entry: OcrEntry): void;
  /** A readable path to the file bytes; call the returned cleanup when done. */
  materialize(entry: OcrEntry): Promise<{ path: string; cleanup: () => void }>;
  readBytes(entry: OcrEntry): Buffer | null;
}

function atomicWrite(file: string, data: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export function sidecarMarkdown(sc: OcrSidecar): string {
  const lines = [`# ${sc.name}`, ""];
  const meta = [
    `- OCR status: ${sc.complete ? "done" : "partial"}`,
    `- Pages: ${sc.pageCount}`,
    sc.confidence !== null ? `- OCR confidence: ${sc.confidence}` : null,
    sc.engines.ocr ? `- OCR engine: ${sc.engines.ocr}` : null,
    sc.engines.vl ? `- Vision model: ${sc.engines.vl}` : null,
    sc.source.projectId ? `- Project: ${sc.source.projectId}` : null,
    sc.source.sessionKey ? `- Session: ${sc.source.sessionKey}` : null,
    `- Updated: ${new Date(sc.updatedAt).toISOString()}`,
  ].filter(Boolean) as string[];
  lines.push(...meta, "");
  if (sc.description)
    lines.push("## Description (local vision model)", "", sc.description.trim(), "");
  lines.push("## Extracted text", "", sc.markdown.trim() || "_(no text found)_", "");
  for (const a of sc.analyses ?? []) {
    lines.push(
      `## Analysis: ${a.analyzer}${a.agentId ? ` (${a.agentId})` : ""}`,
      "",
      a.summary.trim(),
      "",
    );
    for (const f of a.findings ?? []) lines.push(`- ${f.title}${f.detail ? `: ${f.detail}` : ""}`);
    if (a.findings?.length) lines.push("");
  }
  return lines.join("\n");
}

export class NormalLaneStore implements OcrLaneStore {
  readonly lane = "normal" as const;
  private cache: Record<string, OcrEntry> | null = null;
  constructor(readonly ocrDir: string) {}

  get registryFile() {
    return path.join(this.ocrDir, "registry.json");
  }

  available() {
    return true;
  }

  loadRegistry(): Record<string, OcrEntry> {
    if (this.cache) return this.cache;
    try {
      const raw = JSON.parse(fs.readFileSync(this.registryFile, "utf8")) as {
        entries?: Record<string, OcrEntry>;
      };
      this.cache = raw.entries ?? {};
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  saveRegistry(reg: Record<string, OcrEntry>) {
    this.cache = reg;
    atomicWrite(this.registryFile, JSON.stringify({ version: 1, entries: reg }));
  }

  private preferredSidecar(entry: OcrEntry): string {
    if (entry.path) {
      return path.join(
        path.dirname(entry.path),
        SIDECAR_DIR,
        `${path.basename(entry.path)}.ocr.json`,
      );
    }
    return path.join(this.ocrDir, "sidecars", `${entry.id}.ocr.json`);
  }

  readSidecar(entry: OcrEntry): OcrSidecar | null {
    for (const file of [entry.sidecarPath, this.preferredSidecar(entry)]) {
      if (!file) continue;
      try {
        return JSON.parse(fs.readFileSync(file, "utf8")) as OcrSidecar;
      } catch {
        /* next */
      }
    }
    return null;
  }

  writeSidecar(entry: OcrEntry, sc: OcrSidecar): OcrEntry {
    const targets = [
      this.preferredSidecar(entry),
      path.join(this.ocrDir, "sidecars", `${entry.id}.ocr.json`),
    ];
    let lastErr: unknown;
    for (const file of targets) {
      try {
        atomicWrite(file, JSON.stringify(sc, null, 1));
        atomicWrite(file.replace(/\.json$/, ".md"), sidecarMarkdown(sc));
        return { ...entry, sidecarPath: file };
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  removeSidecar(entry: OcrEntry) {
    for (const file of [entry.sidecarPath, this.preferredSidecar(entry)]) {
      if (!file) continue;
      fs.rmSync(file, { force: true });
      fs.rmSync(file.replace(/\.json$/, ".md"), { force: true });
      // Drop an emptied .ocr folder.
      try {
        const dir = path.dirname(file);
        if (path.basename(dir) === SIDECAR_DIR && fs.readdirSync(dir).length === 0)
          fs.rmdirSync(dir);
      } catch {
        /* ignore */
      }
    }
  }

  async materialize(entry: OcrEntry) {
    if (!entry.path || !fs.existsSync(entry.path))
      throw new Error(`file is gone: ${entry.path ?? entry.name}`);
    return { path: entry.path, cleanup: () => {} };
  }

  readBytes(entry: OcrEntry): Buffer | null {
    try {
      return entry.path ? fs.readFileSync(entry.path) : null;
    } catch {
      return null;
    }
  }
}

/** tmpfs dir for decrypted secure bytes (never the regular disk when avoidable). */
export function secureScratchDir(env: NodeJS.ProcessEnv = process.env): string {
  const base =
    env.INFINIBOT_SECURE_RAM_DIR?.trim() ||
    env.XDG_RUNTIME_DIR?.trim() ||
    (fs.existsSync("/dev/shm") ? "/dev/shm" : os.tmpdir());
  return path.join(base, "infinibot-secure-ocr");
}

export class SecureLaneOcrStore implements OcrLaneStore {
  readonly lane = "secure" as const;
  constructor(
    private readonly vault: () => SecureVault | null,
    private readonly scratch = secureScratchDir(),
  ) {}

  private v(): SecureVault {
    const vault = this.vault();
    if (!vault) throw new Error("Secure Mode is locked");
    return vault;
  }

  available() {
    try {
      return this.vault() !== null;
    } catch {
      return false;
    }
  }

  loadRegistry(): Record<string, OcrEntry> {
    return (
      this.v().readJson<{ entries?: Record<string, OcrEntry> }>("ocr-registry", {}).entries ?? {}
    );
  }

  saveRegistry(reg: Record<string, OcrEntry>) {
    this.v().writeJson("ocr-registry", { version: 1, entries: reg });
  }

  readSidecar(entry: OcrEntry): OcrSidecar | null {
    return this.v().readJson<OcrSidecar | null>(`ocr-sidecar-${entry.id}`, null);
  }

  writeSidecar(entry: OcrEntry, sc: OcrSidecar): OcrEntry {
    this.v().writeJson(`ocr-sidecar-${entry.id}`, sc);
    return entry;
  }

  removeSidecar(entry: OcrEntry) {
    this.v().remove(`ocr-sidecar-${entry.id}`);
  }

  putBytes(id: string, data: Buffer) {
    this.v().writeBuffer(`ocr-file-${id}`, data);
  }

  removeBytes(id: string) {
    this.v().remove(`ocr-file-${id}`);
  }

  readBytes(entry: OcrEntry): Buffer | null {
    return this.v().readBuffer(`ocr-file-${entry.id}`);
  }

  async materialize(entry: OcrEntry) {
    const data = this.readBytes(entry);
    if (!data) throw new Error("secure file bytes are missing from the vault");
    fs.mkdirSync(this.scratch, { recursive: true, mode: 0o700 });
    const dir = fs.mkdtempSync(path.join(this.scratch, "j-"));
    const file = path.join(dir, `in${entry.ext}`);
    fs.writeFileSync(file, data, { mode: 0o600 });
    data.fill(0);
    return {
      path: file,
      cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
    };
  }
}
