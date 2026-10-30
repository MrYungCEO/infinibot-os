/**
 * Runs the built-in voice engine (server.ts) as a child of the gateway:
 * starts it with the gateway, restarts it when it crashes (with backoff), and
 * stops it with the gateway. A crash in native ONNX code can never take the
 * gateway down with it.
 *
 * Works the same from the npm install and the packaged desktop app: the child
 * is `process.execPath` (Electron runs it as Node via ELECTRON_RUN_AS_NODE),
 * and onnxruntime's N-API binaries load from node_modules outside the asar.
 *
 * One engine at a time: before a spawn the old child must be gone, and an
 * engine left on the port by an earlier gateway (identified by its /health)
 * is stopped. If the native ONNX runtime can't load or crashes the engine
 * before it is ready, the engine is started again on the WebAssembly runtime.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { BackendPref, OnnxBackend } from "./backend.js";

export type EngineStatus = "stopped" | "starting" | "running" | "crashed";

export interface EngineConfig {
  port: number;
  modelsDir: string;
  sttRepo: string;
  host?: string;
  device?: "auto" | "cpu";
  /** ONNX runtime: auto = native, WebAssembly when native can't run. */
  backend?: BackendPref;
}

export interface EngineState {
  status: EngineStatus;
  pid: number | null;
  url: string | null;
  restarts: number;
  lastError: string | null;
  startedAt: number | null;
  readyAt: number | null;
  sttDevice: string | null;
  /** Runtime the engine runs on (null until it reports). */
  backend: OnnxBackend | null;
  /** Plain reason for the backend, safe for the UI. */
  backendReason: string | null;
}

const MAX_CRASHES = 5;
const CRASH_WINDOW_MS = 2 * 60_000;
/** A child that reported a fatal load error but is still alive after this is killed. */
const STUCK_EXIT_MS = 3000;

/** What /health answers when the process on the port is one of our engines. */
export function isOurEngineHealth(j: unknown): j is { pid: number } {
  if (!j || typeof j !== "object") return false;
  const o = j as Record<string, unknown>;
  if (typeof o.pid !== "number" || o.pid <= 0) return false;
  // "engine" marker since 2026.10.19; older engines: the same field set without it.
  return o.engine === "infinibot-voice" || ("tts" in o && "stt" in o && "sttModel" in o);
}

export interface PortDeps {
  fetchFn: typeof fetch;
  kill: (pid: number) => void;
  sleep: (ms: number) => Promise<void>;
}

const defaultPortDeps: PortDeps = {
  fetchFn: (...a) => fetch(...a),
  kill: (pid) => process.kill(pid),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/**
 * Make sure nothing but `ownPid` serves the engine port. A stray engine
 * (earlier gateway, retry, crash mid-exit) is stopped. Returns "foreign" when
 * another program owns the port.
 */
export async function claimEnginePort(
  url: string,
  ownPid: number | null,
  deps: PortDeps = defaultPortDeps,
): Promise<"free" | "foreign"> {
  const probe = async (): Promise<unknown> => {
    try {
      const r = await deps.fetchFn(`${url}/health`, { signal: AbortSignal.timeout(1500) });
      return await r.json().catch(() => ({ notJson: true }));
    } catch {
      return null; // nothing listening
    }
  };
  let j = await probe();
  if (j === null) return "free";
  if (!isOurEngineHealth(j)) return "foreign";
  if (j.pid === ownPid) return "free";
  try {
    deps.kill(j.pid);
  } catch {
    /* already gone */
  }
  for (let i = 0; i < 20; i++) {
    await deps.sleep(250);
    j = await probe();
    if (j === null) return "free";
  }
  return isOurEngineHealth(j) ? "free" : "foreign";
}

/**
 * After the child `exit`: run again on the WebAssembly runtime? Yes when the
 * native runtime was in use, the user didn't pin it, and the engine died
 * before it was ever ready (DLL load failure or a crash inside native code).
 */
export function shouldFallBackToWasm(o: {
  pref: BackendPref;
  backend: OnnxBackend | null;
  everReady: boolean;
  stopping: boolean;
  loadFailed: boolean;
  exitCode: number | null;
}): boolean {
  if (o.stopping || o.everReady || o.pref !== "auto") return false;
  if (o.backend === "wasm") return false;
  return o.loadFailed || o.exitCode !== 0;
}

function serverEntry(): { cmd: string; args: string[] } {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const js = path.join(here, "server.js");
  if (fs.existsSync(js)) return { cmd: process.execPath, args: [js] };
  // Running from source (tests / tsx dev): load the TypeScript through tsx.
  return { cmd: process.execPath, args: ["--import", "tsx", path.join(here, "server.ts")] };
}

export class VoiceEngineSupervisor {
  private child: ChildProcess | null = null;
  private cfg: EngineConfig | null = null;
  private crashes: number[] = [];
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;
  private logTail: string[] = [];
  /** Backend for the next spawn: the configured one until a native failure. */
  private effectiveBackend: BackendPref = "auto";
  private launching: Promise<void> = Promise.resolve();
  private stuckTimer: ReturnType<typeof setTimeout> | null = null;
  readonly state: EngineState = {
    status: "stopped",
    pid: null,
    url: null,
    restarts: 0,
    lastError: null,
    startedAt: null,
    readyAt: null,
    sttDevice: null,
    backend: null,
    backendReason: null,
  };

  constructor(
    private log: (line: string) => void = (l) => console.log(`[VOICE-ENGINE] ${l}`),
    private portDeps: PortDeps = defaultPortDeps,
    /** Tests: run this script instead of server.js. */
    private entry: (() => { cmd: string; args: string[] }) | null = null,
  ) {
    process.once("exit", () => this.kill());
  }

  recentLog(): string[] {
    return this.logTail.slice(-40);
  }

  isRunning(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  /** Start (or keep) the engine with this config. Idempotent; never two engines at once. */
  start(cfg: EngineConfig): void {
    const same = this.cfg && JSON.stringify(this.cfg) === JSON.stringify(cfg);
    this.cfg = cfg;
    this.stopping = false;
    if (same && (this.isRunning() || this.state.status === "starting")) return;
    if (!same) this.effectiveBackend = cfg.backend ?? "auto";
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.crashes = [];
    this.queueLaunch();
  }

  /** Serialise launches: each waits for the previous child to be gone. */
  private queueLaunch(): void {
    const host = this.cfg!.host ?? "127.0.0.1";
    this.state.status = "starting";
    this.state.url = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${this.cfg!.port}`;
    this.state.lastError = null;
    this.launching = this.launching
      .then(() => this.launch())
      .catch((err: unknown) => {
        this.state.status = "crashed";
        this.state.lastError = String((err as Error)?.message ?? err);
        this.log(`engine could not start: ${this.state.lastError}`);
      });
  }

  private async launch(): Promise<void> {
    await this.killAndWait();
    if (this.stopping || !this.cfg) return;
    const claim = await claimEnginePort(this.state.url!, null, this.portDeps);
    if (claim === "foreign") {
      throw new Error(`address already in use: port ${this.cfg.port} is used by another program`);
    }
    if (this.stopping || !this.cfg) return;
    this.spawnChild();
  }

  private killAndWait(timeoutMs = 5000): Promise<void> {
    const c = this.child;
    if (!c || c.exitCode !== null || c.signalCode !== null) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(t);
        resolve();
      };
      const t = setTimeout(() => {
        try {
          c.kill("SIGKILL");
        } catch {
          /* gone */
        }
        resolve();
      }, timeoutMs);
      c.once("exit", done);
      try {
        c.kill();
      } catch {
        done();
      }
    });
  }

  private spawnChild(): void {
    const cfg = this.cfg!;
    const { cmd, args } = (this.entry ?? serverEntry)();
    const host = cfg.host ?? "127.0.0.1";
    const argv = [
      ...args,
      "--port",
      String(cfg.port),
      "--host",
      host,
      "--models",
      cfg.modelsDir,
      "--stt",
      cfg.sttRepo,
      "--device",
      cfg.device ?? "auto",
      "--backend",
      this.effectiveBackend,
    ];
    this.state.status = "starting";
    this.state.url = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${cfg.port}`;
    this.state.startedAt = Date.now();
    this.state.readyAt = null;
    this.state.lastError = null;
    this.state.backend = null;
    this.state.backendReason = null;
    let everReady = false;
    let loadFailed = false;
    const child = spawn(cmd, argv, {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    });
    this.child = child;
    this.state.pid = child.pid ?? null;
    const pump = (d: Buffer) => {
      for (const line of String(d).split(/\r?\n/)) {
        if (!line.trim()) continue;
        // Raw native-runtime errors (DLL paths…) go to the gateway log only.
        if (line.startsWith("[voice-engine] native onnxruntime unavailable:")) {
          this.log(line.replace(/^\[voice-engine\]\s*/, ""));
          continue;
        }
        this.logTail.push(line);
        if (this.logTail.length > 200) this.logTail.splice(0, 100);
        if (/voice-engine\]|error|fail/i.test(line))
          this.log(line.replace(/^\[voice-engine\]\s*/, ""));
      }
    };
    child.stdout?.on("data", pump);
    child.stderr?.on("data", pump);
    child.on(
      "message",
      (m: {
        type?: string;
        error?: string;
        sttDevice?: string;
        backend?: OnnxBackend;
        backendReason?: string;
      }) => {
        if (this.child !== child) return;
        if (m?.type === "ready") {
          everReady = true;
          this.state.status = "running";
          this.state.readyAt = Date.now();
          this.state.sttDevice = m.sttDevice ?? null;
          this.state.backend = m.backend ?? null;
          this.state.backendReason = m.backendReason ?? null;
          this.log(`engine ready on the ${m.backend ?? "?"} runtime (${m.backendReason ?? ""})`);
        } else if (m?.type === "error") {
          loadFailed = true;
          this.state.lastError = m.error ?? "engine failed to load";
          // A child stuck in exit after a native failure would keep the port: end it.
          if (this.stuckTimer) clearTimeout(this.stuckTimer);
          this.stuckTimer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              this.log("engine did not exit after its load error — stopping it");
              try {
                child.kill("SIGKILL");
              } catch {
                /* gone */
              }
            }
          }, STUCK_EXIT_MS);
          this.stuckTimer.unref?.();
        }
      },
    );
    child.on("error", (err) => {
      this.state.lastError = String(err);
    });
    child.on("exit", (code, signal) => {
      // A child replaced by start() with a new config: its exit is expected.
      if (this.child !== child) return;
      this.child = null;
      this.state.pid = null;
      if (this.stuckTimer) clearTimeout(this.stuckTimer);
      this.stuckTimer = null;
      if (this.stopping) {
        this.state.status = "stopped";
        return;
      }
      if (
        shouldFallBackToWasm({
          pref: this.effectiveBackend,
          backend: this.state.backend,
          everReady,
          stopping: this.stopping,
          loadFailed,
          exitCode: code,
        })
      ) {
        this.effectiveBackend = "wasm";
        this.log(
          `the fast native engine can't run on this computer (${signal ?? code}); starting the compatibility engine`,
        );
        this.queueLaunch();
        return;
      }
      const why = `exited (${signal ?? code})`;
      this.state.lastError = this.state.lastError ?? why;
      this.log(`engine ${why}`);
      this.scheduleRestart(code === 3);
    });
  }

  private scheduleRestart(loadFailure: boolean): void {
    const now = Date.now();
    this.crashes = this.crashes.filter((t) => now - t < CRASH_WINDOW_MS);
    this.crashes.push(now);
    if (loadFailure || this.crashes.length > MAX_CRASHES) {
      this.state.status = "crashed";
      this.log(
        loadFailure
          ? "engine could not load its models — not restarting"
          : "engine keeps crashing — giving up until the next start",
      );
      return;
    }
    const delay = Math.min(30_000, 1000 * 2 ** (this.crashes.length - 1));
    this.state.status = "starting";
    this.state.restarts++;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopping && this.cfg) this.queueLaunch();
    }, delay);
    this.restartTimer.unref?.();
  }

  /** Wait for /health to answer ok (models loaded). */
  async waitReady(timeoutMs = 180_000, fetchFn: typeof fetch = fetch): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.state.status === "crashed") return false;
      // The child said "ready" over IPC: that's our engine, no need to ask the port.
      if (this.state.status === "running" && this.state.readyAt !== null && this.isRunning())
        return true;
      const url = this.state.url;
      if (url) {
        try {
          const r = await fetchFn(`${url}/health`, { signal: AbortSignal.timeout(3000) });
          if (r.ok) {
            const j = (await r.json().catch(() => ({}))) as {
              sttDevice?: string;
              backend?: OnnxBackend;
              backendReason?: string;
            };
            // No pid comparison here: the pid an engine reports can differ from
            // child.pid (seen under Wine). Strays are stopped before every spawn
            // (claimEnginePort), so whatever answers ok on the port is ours.
            this.state.status = "running";
            this.state.readyAt ??= Date.now();
            this.state.sttDevice = j.sttDevice ?? this.state.sttDevice;
            this.state.backend = j.backend ?? this.state.backend;
            this.state.backendReason = j.backendReason ?? this.state.backendReason;
            return true;
          }
        } catch {
          /* not listening yet */
        }
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
  }

  stop(): void {
    this.stopping = true;
    if (this.stuckTimer) clearTimeout(this.stuckTimer);
    this.stuckTimer = null;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.kill();
    this.state.status = "stopped";
  }

  private kill(): void {
    const c = this.child;
    if (!c || c.exitCode !== null) return;
    try {
      c.kill();
    } catch {
      /* gone */
    }
  }
}

let singleton: VoiceEngineSupervisor | null = null;
export function getVoiceEngine(): VoiceEngineSupervisor {
  singleton ??= new VoiceEngineSupervisor();
  return singleton;
}
