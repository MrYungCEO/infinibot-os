/**
 * Where keyframes, contact sheets, moment thumbnails and the playback proxy
 * live, per lane:
 *
 *   normal — <stateDir>/video-analysis/frames/<frameKey>/<name>
 *   secure — sealed in the Secure Mode vault as "vframe-<frameKey>-<name>"
 *            (AES-256-GCM); plaintext only ever exists in tmpfs scratch.
 *
 * Frames are keyed by the video's sha256 prefix so a rename/move keeps them.
 */
import fs from "node:fs";
import path from "node:path";
import type { OcrLane } from "../../ocr/types.js";
import type { SecureVault } from "../../secure-mode/vault.js";

export interface FrameStore {
  readonly lane: OcrLane;
  available(): boolean;
  put(frameKey: string, name: string, data: Buffer): void;
  get(frameKey: string, name: string): Buffer | null;
  has(frameKey: string, name: string): boolean;
  removeAll(frameKey: string): void;
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,60}$/i;

function check(frameKey: string, name: string) {
  if (!/^[a-f0-9]{8,64}$/.test(frameKey)) throw new Error("bad frame key");
  if (!NAME.test(name)) throw new Error(`bad frame name "${name}"`);
}

export class NormalFrameStore implements FrameStore {
  readonly lane = "normal" as const;
  constructor(readonly root: string) {}
  available() {
    return true;
  }
  private file(frameKey: string, name: string) {
    check(frameKey, name);
    return path.join(this.root, frameKey, name);
  }
  put(frameKey: string, name: string, data: Buffer) {
    const f = this.file(frameKey, name);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, f);
  }
  get(frameKey: string, name: string) {
    try {
      return fs.readFileSync(this.file(frameKey, name));
    } catch {
      return null;
    }
  }
  has(frameKey: string, name: string) {
    return fs.existsSync(this.file(frameKey, name));
  }
  removeAll(frameKey: string) {
    check(frameKey, "x");
    fs.rmSync(path.join(this.root, frameKey), { recursive: true, force: true });
  }
}

export class SecureFrameStore implements FrameStore {
  readonly lane = "secure" as const;
  constructor(private readonly vault: () => SecureVault | null) {}
  private v() {
    const v = this.vault();
    if (!v) throw new Error("Secure Mode is locked");
    return v;
  }
  private store(frameKey: string, name: string) {
    check(frameKey, name);
    return `vframe-${frameKey}-${name}`;
  }
  available() {
    try {
      return this.vault() !== null;
    } catch {
      return false;
    }
  }
  put(frameKey: string, name: string, data: Buffer) {
    this.v().writeBuffer(this.store(frameKey, name), data);
  }
  get(frameKey: string, name: string) {
    return this.v().readBuffer(this.store(frameKey, name));
  }
  has(frameKey: string, name: string) {
    return this.v().has(this.store(frameKey, name));
  }
  removeAll(frameKey: string) {
    const v = this.v();
    for (const s of v.list(`vframe-${frameKey}-`)) v.remove(s);
  }
}

export function frameKeyFor(sha256: string): string {
  return sha256.slice(0, 24);
}

export function mimeForFrame(name: string): string {
  return name.endsWith(".mp4") ? "video/mp4" : "image/jpeg";
}
