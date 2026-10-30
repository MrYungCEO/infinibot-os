import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

import { PartScanStore } from "./store.js";
import { CLOUD_RECONSTRUCTION_REFUSAL, type JobProgressEvent, type PartScanConfig, type ScanJob } from "./types.js";

type SpawnImpl = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

type ProgressListener = (event: JobProgressEvent) => void;

interface QueueEntry {
  scanId: string;
  config: PartScanConfig;
  listener?: ProgressListener;
}

const SETUP_HINT =
  "Build the worker with `docker build -t infinibot/part-scan-worker:cuda12.8 extensions/part-scan/worker`, " +
  "or install the local worker dependencies and set workerMode to local-cli.";

function clampProgress(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(fallback, Math.min(1, value))
    : fallback;
}

export class PartScanJobRunner {
  private readonly queue: QueueEntry[] = [];
  private current: QueueEntry | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private stopping = false;
  private idleResolvers: Array<() => void> = [];

  constructor(
    readonly store: PartScanStore,
    private readonly workerScript: string,
    private readonly spawnImpl: SpawnImpl = spawn,
    private readonly commandFactory?: (entry: QueueEntry) => { command: string; args: string[] },
  ) {}

  recoverInterrupted(): void {
    for (const scan of this.store.list()) {
      if (scan.job.status === "queued" || scan.job.status === "processing") {
        this.store.writeJob(scan.id, {
          status: "failed",
          stage: "interrupted",
          error: "The gateway restarted during reconstruction. Start the scan again to resume from the captured images.",
          finishedAt: Date.now(),
        });
      }
    }
  }

  start(scanId: string, config: PartScanConfig, listener?: ProgressListener): ScanJob {
    const scan = this.store.get(scanId);
    if (scan.imageCount < 3) throw new Error("capture at least 3 images before processing");
    if (this.current?.scanId === scanId || this.queue.some((item) => item.scanId === scanId)) {
      return this.store.readJob(scanId);
    }
    if (config.cloud) {
      const job = this.store.writeJob(scanId, {
        status: "failed",
        stage: "worker-unavailable",
        progress: 0,
        error: CLOUD_RECONSTRUCTION_REFUSAL,
        finishedAt: Date.now(),
      });
      listener?.({ scanId, job });
      return job;
    }
    if (config.workerMode === "off") {
      return this.failUnavailable(scanId, "worker mode is off", listener);
    }
    if (!this.commandFactory && config.workerMode === "local-cli" && !fs.existsSync(this.workerScript)) {
      return this.failUnavailable(scanId, `local worker script is missing: ${this.workerScript}`, listener);
    }
    const job = this.store.writeJob(scanId, {
      status: "queued",
      stage: "queued",
      progress: 0,
      error: null,
      logTail: [],
      startedAt: undefined,
      finishedAt: undefined,
    });
    this.queue.push({ scanId, config, listener });
    listener?.({ scanId, job });
    void this.pump();
    return job;
  }

  cancel(scanId: string): ScanJob {
    const queued = this.queue.findIndex((item) => item.scanId === scanId);
    if (queued >= 0) {
      const [entry] = this.queue.splice(queued, 1);
      return this.finishCancelled(entry);
    }
    if (this.current?.scanId === scanId && this.child) {
      const job = this.store.writeJob(scanId, {
        stage: "cancelling",
        error: "Cancellation requested",
      });
      this.emit(this.current, job);
      const child = this.child;
      child.kill("SIGTERM");
      const pid = child.pid;
      const timer = setTimeout(() => {
        if (this.child?.pid === pid) child.kill("SIGKILL");
      }, 5_000);
      timer.unref?.();
      return job;
    }
    throw new Error("scan is not queued or processing");
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const entry of this.queue.splice(0)) this.finishCancelled(entry);
    if (this.current && this.child) this.child.kill("SIGTERM");
    await this.waitForIdle();
  }

  waitForIdle(): Promise<void> {
    if (!this.current && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleResolvers.push(resolve));
  }

  private failUnavailable(scanId: string, reason: string, listener?: ProgressListener): ScanJob {
    const job = this.store.writeJob(scanId, {
      status: "failed",
      stage: "worker-unavailable",
      progress: 0,
      error: `worker not installed: ${reason}. ${SETUP_HINT}`,
      finishedAt: Date.now(),
    });
    listener?.({ scanId, job });
    return job;
  }

  private finishCancelled(entry: QueueEntry): ScanJob {
    const job = this.store.writeJob(entry.scanId, {
      status: "failed",
      stage: "cancelled",
      error: "Cancelled by user",
      finishedAt: Date.now(),
    });
    this.emit(entry, job);
    return job;
  }

  private emit(entry: QueueEntry, job: ScanJob): void {
    try {
      entry.listener?.({ scanId: entry.scanId, job });
    } catch {
      // A disconnected browser must not stop the worker.
    }
  }

  private command(entry: QueueEntry): { command: string; args: string[] } {
    if (this.commandFactory) return this.commandFactory(entry);
    const scanDir = this.store.scanDir(entry.scanId);
    const cfg = entry.config;
    const pipelineArgs = [
      "--scan-dir", cfg.workerMode === "docker" ? "/scan" : scanDir,
      "--marker-square-mm", String(cfg.markerSquareMm),
      "--marker-dictionary", cfg.markerDictionary,
      "--board-cols", String(cfg.boardCols),
      "--board-rows", String(cfg.boardRows),
      "--quality", cfg.quality,
    ];
    if (cfg.workerMode === "local-cli") {
      return { command: "python3", args: [this.workerScript, ...pipelineArgs] };
    }
    const args = ["run", "--rm"];
    if (cfg.gpu) args.push("--gpus", "all");
    args.push(
      "-v", `${scanDir}:/scan`,
      // The worker image's ENTRYPOINT is `python3 /opt/part-scan/pipeline.py`.
      cfg.workerImage,
      ...pipelineArgs,
    );
    return { command: "docker", args };
  }

  private appendLog(entry: QueueEntry, line: string): ScanJob {
    const current = this.store.readJob(entry.scanId);
    return this.store.writeJob(entry.scanId, {
      logTail: [...current.logTail, line.slice(0, 1_000)],
    });
  }

  private handleStdout(entry: QueueEntry, line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const msg = JSON.parse(trimmed) as { stage?: unknown; progress?: unknown; message?: unknown };
      if (typeof msg.stage === "string") {
        const current = this.store.readJob(entry.scanId);
        const job = this.store.writeJob(entry.scanId, {
          stage: msg.stage.slice(0, 80),
          progress: clampProgress(msg.progress, current.progress),
          logTail:
            typeof msg.message === "string"
              ? [...current.logTail, msg.message.slice(0, 1_000)]
              : current.logTail,
        });
        this.emit(entry, job);
        return;
      }
    } catch {
      // Non-JSON worker output is still useful in the persisted tail.
    }
    const job = this.appendLog(entry, trimmed);
    this.emit(entry, job);
  }

  private async pump(): Promise<void> {
    if (this.current || this.stopping) return;
    const entry = this.queue.shift();
    if (!entry) {
      this.resolveIdle();
      return;
    }
    this.current = entry;
    const processing = this.store.writeJob(entry.scanId, {
      status: "processing",
      stage: "starting-worker",
      progress: 0.01,
      error: null,
      startedAt: Date.now(),
    });
    this.emit(entry, processing);
    const command = this.command(entry);

    let settled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null, spawnError?: Error) => {
      if (settled) return;
      settled = true;
      const current = this.store.readJob(entry.scanId);
      const cancelled = current.stage === "cancelling" || signal === "SIGTERM" || signal === "SIGKILL";
      let job: ScanJob;
      if (cancelled) {
        job = this.finishCancelled(entry);
      } else if (spawnError || code !== 0) {
        const tail = current.logTail.join("\n");
        const unavailable =
          spawnError && "code" in spawnError && (spawnError as NodeJS.ErrnoException).code === "ENOENT" ||
          /not found|unable to find image|cannot connect to the docker daemon/i.test(tail);
        const detail = spawnError?.message ?? (tail.split("\n").slice(-3).join(" · ") || `worker exited ${code}`);
        job = this.store.writeJob(entry.scanId, {
          status: "failed",
          stage: unavailable ? "worker-unavailable" : "failed",
          error: unavailable
            ? `worker not installed: ${detail}. ${SETUP_HINT}`
            : `Reconstruction failed: ${detail}`,
          finishedAt: Date.now(),
        });
        this.emit(entry, job);
      } else {
        const dir = this.store.scanDir(entry.scanId);
        const missing = ["model.glb", "dims.json", "preview.png"].filter(
          (name) => !fs.existsSync(path.join(dir, name)),
        );
        if (missing.length) {
          job = this.store.writeJob(entry.scanId, {
            status: "failed",
            stage: "output-validation",
            error: `Worker finished without required output: ${missing.join(", ")}`,
            finishedAt: Date.now(),
          });
        } else {
          job = this.store.writeJob(entry.scanId, {
            status: "done",
            stage: "complete",
            progress: 1,
            error: null,
            finishedAt: Date.now(),
          });
        }
        this.emit(entry, job);
      }
      this.child = null;
      this.current = null;
      void this.pump();
    };

    try {
      this.child = this.spawnImpl(command.command, command.args, {
        cwd: this.store.scanDir(entry.scanId),
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
      });
      readline.createInterface({ input: this.child.stdout }).on("line", (line) => this.handleStdout(entry, line));
      readline.createInterface({ input: this.child.stderr }).on("line", (line) => {
        const job = this.appendLog(entry, line.trim());
        this.emit(entry, job);
      });
      this.child.once("error", (error) => finish(null, null, error));
      this.child.once("close", (code, signal) => finish(code, signal));
    } catch (error) {
      finish(null, null, error instanceof Error ? error : new Error(String(error)));
    }
  }

  private resolveIdle(): void {
    for (const resolve of this.idleResolvers.splice(0)) resolve();
  }
}

export const jobRunnerMessages = { SETUP_HINT };
