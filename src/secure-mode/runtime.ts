/**
 * Secure Mode runtime: the single source of truth for whether the secure lane
 * is on (unlocked) or off (locked), plus the plumbing that keeps secure
 * session transcripts off disk.
 *
 * ON  = master key fetched from the OS keyring and held in memory; sealed
 *       transcripts are unsealed into a RAM-backed (tmpfs) directory so the
 *       normal session machinery can read/append them; a timer re-seals them.
 * OFF = every RAM transcript is sealed into the vault and wiped, the key is
 *       zeroed, and every secure RPC / run fails closed until turned on again.
 *
 * The on/off flag is persisted (plaintext, non-sensitive) at
 * <stateDir>/secure/state.json so the lane comes back the way the owner left
 * it after a gateway restart.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveStateDir } from "../config/paths.js";
import {
  type ExecFn,
  type MasterKeySource,
  keyringAccount,
  resolveMasterKey,
} from "./keyring.js";
import { SecureLaneStore } from "./lane-store.js";
import { SecureVault } from "./vault.js";

export interface SecureModeStatus {
  enabled: boolean;
  unlocked: boolean;
  keySource?: MasterKeySource;
  keyAccount: string;
  updatedAt: number;
  error?: string;
  counts?: ReturnType<SecureLaneStore["counts"]> & { sessions: number };
  seededAt?: number;
  ramDir?: string;
}

export class SecureModeLockedError extends Error {
  readonly code = "SECURE_MODE_LOCKED";
  constructor() {
    super("Secure Mode is off: the secure lane is locked. Turn Secure Mode on to use it.");
    this.name = "SecureModeLockedError";
  }
}

interface PersistedState {
  enabled: boolean;
  updatedAt: number;
}

type Listener = (status: SecureModeStatus) => void;

const TRANSCRIPT_STORE_PREFIX = "t-";

function safeTranscriptName(sessionId: string): string {
  return sessionId.replace(/[^a-z0-9._-]/gi, "_").slice(0, 110) || "session";
}

/** Find the filesystem type backing `dir` from /proc/mounts (Linux). */
export function mountFsType(dir: string): string | null {
  try {
    const mounts = fs.readFileSync("/proc/mounts", "utf8").split("\n");
    let best: { mp: string; type: string } | null = null;
    const target = path.resolve(dir);
    for (const line of mounts) {
      const [, mp, type] = line.split(" ");
      if (!mp || !type) continue;
      const mpPath = mp.replace(/\\040/g, " ");
      if (target === mpPath || target.startsWith(mpPath.endsWith("/") ? mpPath : `${mpPath}/`)) {
        if (!best || mpPath.length > best.mp.length) best = { mp: mpPath, type };
      }
    }
    return best?.type ?? null;
  } catch {
    return null;
  }
}

export interface SecureModeRuntimeOptions {
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  exec?: ExecFn;
  now?: () => number;
  /** Re-seal interval for live RAM transcripts (ms). 0 disables the timer. */
  sealIntervalMs?: number;
}

export class SecureModeRuntime {
  readonly stateDir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly exec?: ExecFn;
  private readonly now: () => number;
  private readonly sealIntervalMs: number;
  private key: Buffer | null = null;
  private keySource: MasterKeySource | undefined;
  private vault: SecureVault | null = null;
  private lane: SecureLaneStore | null = null;
  private persisted: PersistedState;
  private lastError: string | undefined;
  private listeners = new Set<Listener>();
  private sealTimer: NodeJS.Timeout | null = null;
  private sealedMtimes = new Map<string, number>();
  private transition: Promise<unknown> = Promise.resolve();

  constructor(opts: SecureModeRuntimeOptions) {
    this.stateDir = opts.stateDir;
    this.env = opts.env ?? process.env;
    this.exec = opts.exec;
    this.now = opts.now ?? Date.now;
    this.sealIntervalMs = opts.sealIntervalMs ?? 15_000;
    this.persisted = this.readPersisted();
  }

  get secureDir(): string {
    return path.join(this.stateDir, "secure");
  }

  get vaultDir(): string {
    return path.join(this.secureDir, "vault");
  }

  /** RAM-backed directory for live secure transcripts. */
  get ramDir(): string {
    const override = this.env.INFINIBOT_SECURE_RAM_DIR?.trim();
    if (override) return override;
    const base = this.env.XDG_RUNTIME_DIR?.trim() || "/dev/shm";
    return path.join(base, "infinibot-secure", keyringAccount(this.stateDir), "transcripts");
  }

  private readPersisted(): PersistedState {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.secureDir, "state.json"), "utf8"));
      return { enabled: raw?.enabled === true, updatedAt: Number(raw?.updatedAt) || 0 };
    } catch {
      return { enabled: false, updatedAt: 0 };
    }
  }

  private writePersisted(enabled: boolean): void {
    this.persisted = { enabled, updatedAt: this.now() };
    fs.mkdirSync(this.secureDir, { recursive: true, mode: 0o700 });
    const file = path.join(this.secureDir, "state.json");
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.persisted), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  isUnlocked(): boolean {
    return this.key !== null && this.vault !== null;
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const s = this.status();
    for (const l of this.listeners) {
      try {
        l(s);
      } catch {
        // listeners must not break the toggle
      }
    }
  }

  status(): SecureModeStatus {
    const base: SecureModeStatus = {
      enabled: this.persisted.enabled,
      unlocked: this.isUnlocked(),
      keySource: this.keySource,
      keyAccount: keyringAccount(this.stateDir),
      updatedAt: this.persisted.updatedAt,
      ...(this.lastError ? { error: this.lastError } : {}),
    };
    if (this.lane && this.vault) {
      try {
        base.counts = {
          ...this.lane.counts(),
          sessions: this.vault.list(TRANSCRIPT_STORE_PREFIX).length,
        };
        base.seededAt = this.lane.graphMeta().seededAt;
        base.ramDir = this.ramDir;
      } catch (err) {
        base.error = err instanceof Error ? err.message : String(err);
      }
    }
    return base;
  }

  /** Restore the persisted on/off state at gateway start. */
  async init(): Promise<SecureModeStatus> {
    if (this.persisted.enabled && !this.isUnlocked()) {
      try {
        await this.unlock();
      } catch (err) {
        // Stay enabled-but-locked: secure runs keep failing closed and the
        // UI shows the error, rather than silently flipping the lane off.
        this.lastError = err instanceof Error ? err.message : String(err);
      }
    }
    return this.status();
  }

  async setEnabled(enabled: boolean): Promise<SecureModeStatus> {
    const run = this.transition.then(async () => {
      if (enabled) {
        await this.unlock();
        this.writePersisted(true);
      } else {
        this.lock();
        this.writePersisted(false);
      }
      this.lastError = undefined;
    });
    this.transition = run.catch(() => {});
    await run;
    this.emit();
    return this.status();
  }

  private ensureRamDir(): string {
    const dir = this.ramDir;
    if (!this.env.INFINIBOT_SECURE_RAM_DIR) {
      const type = mountFsType(path.dirname(path.dirname(path.dirname(dir))));
      if (type !== "tmpfs" && type !== "ramfs") {
        throw new Error(
          `Secure Mode keeps live transcripts in RAM, but ${path.dirname(
            path.dirname(path.dirname(dir)),
          )} is ${type ?? "unknown"} (not tmpfs). Set XDG_RUNTIME_DIR to a tmpfs mount.`,
        );
      }
    }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!this.env.INFINIBOT_SECURE_RAM_DIR) {
      // <runtime>/infinibot-secure/<account>/transcripts — all three are ours.
      fs.chmodSync(path.dirname(path.dirname(dir)), 0o700);
      fs.chmodSync(path.dirname(dir), 0o700);
    }
    fs.chmodSync(dir, 0o700);
    return dir;
  }

  private async unlock(): Promise<void> {
    if (this.isUnlocked()) return;
    const resolved = await resolveMasterKey({ stateDir: this.stateDir, env: this.env, exec: this.exec });
    const vault = new SecureVault(resolved.key, this.vaultDir);
    // Prove the key opens existing data before declaring the lane open.
    for (const store of ["kanban", "graph", "docs-index"]) {
      if (vault.has(store)) vault.readBuffer(store)?.fill(0);
    }
    this.ensureRamDir();
    this.key = resolved.key;
    this.keySource = resolved.source;
    this.vault = vault;
    this.lane = new SecureLaneStore(vault, this.now);
    this.unsealTranscripts();
    if (this.sealIntervalMs > 0) {
      this.sealTimer = setInterval(() => {
        try {
          this.sealTranscripts();
        } catch {
          // next tick retries
        }
      }, this.sealIntervalMs);
      this.sealTimer.unref?.();
    }
  }

  private lock(): void {
    if (this.sealTimer) clearInterval(this.sealTimer);
    this.sealTimer = null;
    if (this.vault) {
      this.sealTranscripts();
      this.wipeRamDir();
    }
    this.key?.fill(0);
    this.key = null;
    this.vault = null;
    this.lane = null;
    this.keySource = undefined;
    this.sealedMtimes.clear();
  }

  /** Seal + wipe without changing the persisted flag (gateway shutdown). */
  shutdown(): void {
    this.lock();
  }

  requireLane(): SecureLaneStore {
    if (!this.lane) throw new SecureModeLockedError();
    return this.lane;
  }

  requireVault(): SecureVault {
    if (!this.vault) throw new SecureModeLockedError();
    return this.vault;
  }

  /** Where a secure session's live transcript lives (RAM). */
  transcriptPath(sessionId: string): string {
    return path.join(this.ramDir, `${safeTranscriptName(sessionId)}.jsonl`);
  }

  isRamTranscriptPath(file: string | undefined): boolean {
    if (!file) return false;
    const dir = path.resolve(this.ramDir);
    return path.resolve(file).startsWith(`${dir}${path.sep}`);
  }

  /** Copy every RAM transcript into the vault (only when changed). */
  sealTranscripts(): number {
    const vault = this.vault;
    if (!vault) return 0;
    const dir = this.ramDir;
    if (!fs.existsSync(dir)) return 0;
    let sealed = 0;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const file = path.join(dir, f);
      let st: fs.Stats;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      const mtime = st.mtimeMs;
      if (this.sealedMtimes.get(f) === mtime) continue;
      const buf = fs.readFileSync(file);
      try {
        vault.writeBuffer(`${TRANSCRIPT_STORE_PREFIX}${f.slice(0, -".jsonl".length)}`, buf);
      } finally {
        buf.fill(0);
      }
      this.sealedMtimes.set(f, mtime);
      sealed += 1;
    }
    return sealed;
  }

  /**
   * Restore sealed transcripts into RAM. A RAM copy that already exists is
   * newer than the vault (it survived a crash without a reboot), so it wins
   * and is sealed instead.
   */
  unsealTranscripts(): number {
    const vault = this.vault;
    if (!vault) return 0;
    const dir = this.ensureRamDir();
    let restored = 0;
    for (const store of vault.list(TRANSCRIPT_STORE_PREFIX)) {
      const name = `${store.slice(TRANSCRIPT_STORE_PREFIX.length)}.jsonl`;
      const file = path.join(dir, name);
      if (fs.existsSync(file)) continue;
      const buf = vault.readBuffer(store);
      if (!buf) continue;
      try {
        fs.writeFileSync(file, buf, { mode: 0o600 });
      } finally {
        buf.fill(0);
      }
      this.sealedMtimes.set(name, fs.statSync(file).mtimeMs);
      restored += 1;
    }
    this.sealTranscripts();
    return restored;
  }

  private wipeRamDir(): void {
    const dir = this.ramDir;
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      const file = path.join(dir, f);
      try {
        const st = fs.statSync(file);
        if (st.isFile()) {
          // tmpfs: overwrite is best-effort hygiene before unlink.
          fs.writeFileSync(file, Buffer.alloc(Math.min(st.size, 16 * 1024 * 1024)));
        }
        fs.rmSync(file, { force: true, recursive: true });
      } catch {
        // keep going; lock must not half-fail
      }
    }
  }
}

const runtimes = new Map<string, SecureModeRuntime>();
let override: SecureModeRuntime | null = null;

/** One runtime per state dir (per active user on multi-user installs). */
export function getSecureModeRuntime(): SecureModeRuntime {
  if (override) return override;
  const stateDir = resolveStateDir(process.env, os.homedir);
  let rt = runtimes.get(stateDir);
  if (!rt) {
    rt = new SecureModeRuntime({ stateDir });
    runtimes.set(stateDir, rt);
  }
  return rt;
}

export function allSecureModeRuntimes(): SecureModeRuntime[] {
  return override ? [override] : [...runtimes.values()];
}

/** Tests only. */
export function setSecureModeRuntimeForTests(rt: SecureModeRuntime | null): void {
  override = rt;
}
