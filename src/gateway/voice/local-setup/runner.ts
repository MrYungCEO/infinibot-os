/**
 * One-click local voice setup — the job behind "Set up voice for me".
 *
 *   check → docker → download → start → wire → test → done
 *
 * State is persisted to <stateDir>/voice/local-setup.json after every change,
 * so closing the app mid-download leaves an `interrupted` record the UI resumes
 * from (Docker keeps finished image layers; the next pull starts where it
 * stopped). Every step is idempotent: running containers are reused, stopped
 * ones restarted, nothing is ever created twice, and only containers named in
 * the plan are touched.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { resolveStateDir } from "../../../config/paths.js";
import { detectHost, realDetectDeps, type DetectDeps, type HostReport } from "./detect.js";
import { DockerOps, portBusy, startDocker } from "./docker-ops.js";
import { downloadFile, measure, type FileSize } from "../native-engine/fetch-models.js";
import { wordErrorRate } from "../native-engine/wer.js";
import {
  ENGINE_DEFAULT_PORT,
  KOKORO_MODEL,
  modelsDir,
  whisperModel,
  whisperSizeFrom,
  type ModelFile,
} from "../native-engine/models.js";
import {
  getVoiceEngine,
  type EngineConfig,
  type VoiceEngineSupervisor,
} from "../native-engine/supervisor.js";
import {
  APPROX_DOWNLOAD_MB,
  DEFAULT_PORTS,
  DEFAULT_PROJECT,
  LEGACY_CONTAINERS,
  PERMISSION_FIX,
  PullTracker,
  WSL_UPDATE_COMMAND,
  decideService,
  dockerStartPlan,
  friendlyError,
  installGuide,
  planServices,
  runArgs,
  sanitizeProject,
  type DockerStartPlan,
  type FriendlyError,
  type InstallGuide,
  type PullProgress,
  type ServiceAction,
  type ServicePlan,
  type VoiceServiceId,
} from "./plan.js";

/** Spoken by the setup self-test; speech-to-text must hear these words back. */
const SELF_TEST_SENTENCE = "Hello! Your voice is ready.";

export type SetupPhase =
  | "idle"
  | "checking"
  | "needs-docker"
  | "needs-permission"
  | "needs-sudo"
  | "starting-docker"
  | "downloading"
  | "starting"
  | "model"
  | "wiring"
  | "testing"
  | "done"
  | "failed"
  | "cancelled";

export type StepId = "check" | "docker" | "download" | "start" | "wire" | "test";
export type StepStatus = "pending" | "active" | "done" | "skipped" | "failed" | "waiting";

export const STEP_LABELS: Record<StepId, string> = {
  check: "Checking your computer",
  docker: "Getting Docker ready",
  download: "Downloading the voice engine",
  start: "Starting voice",
  wire: "Connecting InfiniBot",
  test: "Testing your voice",
};
const STEP_ORDER: StepId[] = ["check", "docker", "download", "start", "wire", "test"];

/** Phases that mean "a job was in flight" — found on disk without a job = interrupted. */
const ACTIVE_PHASES = new Set<SetupPhase>([
  "checking",
  "starting-docker",
  "downloading",
  "starting",
  "model",
  "wiring",
  "testing",
]);

export type VoiceEngineKind = "native" | "docker";

export interface SetupOptions {
  /** "native" = built-in engine (default, no Docker); "docker" = GPU engine in Docker (advanced). */
  engine?: VoiceEngineKind;
  project?: string;
  ports?: Partial<Record<VoiceServiceId, number>>;
  cpuOnly?: boolean;
  sttModel?: string;
  /** Write voice.json / infinibot.json (default true). */
  wire?: boolean;
}

export interface ServiceRecord {
  container: string | null;
  url: string;
  port: number;
  image: string;
  action: ServiceAction["kind"] | "native" | null;
  healthy: boolean;
  reused: boolean;
  gpu: boolean;
  model?: string;
  /** Built-in engine only: ONNX runtime in use (wasm = compatibility mode, slower). */
  backend?: "native" | "wasm" | null;
}

export interface ImageProgress extends PullProgress {
  service: VoiceServiceId;
  status: "waiting" | "downloading" | "done" | "skipped";
}

export interface SetupState {
  version: 1;
  phase: SetupPhase;
  running: boolean;
  interrupted: boolean;
  startedAt: number | null;
  updatedAt: number;
  finishedAt: number | null;
  project: string;
  /** Engine this run uses (decided after checking the computer). */
  engine: VoiceEngineKind | null;
  /** Built-in engine launch settings (the gateway starts it from these on boot). */
  nativeEngine: EngineConfig | null;
  opts: SetupOptions;
  host: HostReport | null;
  steps: Array<{ id: StepId; label: string; status: StepStatus; detail?: string }>;
  docker: {
    startPlan?: DockerStartPlan;
    countdownSec?: number;
    sudoCommand?: string;
    permissionFix?: { command: string; after: string };
    guide?: InstallGuide;
    wslCommand?: string;
  };
  download: {
    images: ImageProgress[];
    doneBytes: number;
    totalBytes: number;
    percent: number;
    etaSec: number | null;
  } | null;
  services: Partial<Record<VoiceServiceId, ServiceRecord>>;
  model: {
    id: string;
    approxMb?: number;
    elapsedSec: number;
    status: "waiting" | "downloading" | "done";
  } | null;
  test: { tts: boolean; ttsBytes?: number; stt: boolean; transcript?: string } | null;
  error: (FriendlyError & { details: string }) | null;
  notes: string[];
  log: string[];
}

export function setupStatePath(stateDir = resolveStateDir()): string {
  return path.join(stateDir, "voice", "local-setup.json");
}

/** The built-in engine needs no Docker step. */
export function stepsFor(engine: VoiceEngineKind | null): StepId[] {
  return engine === "native" ? STEP_ORDER.filter((s) => s !== "docker") : STEP_ORDER;
}

function freshSteps(engine: VoiceEngineKind | null = null): SetupState["steps"] {
  return stepsFor(engine).map((id) => ({
    id,
    label: STEP_LABELS[id],
    status: "pending" as StepStatus,
  }));
}

export function emptyState(): SetupState {
  return {
    version: 1,
    phase: "idle",
    running: false,
    interrupted: false,
    startedAt: null,
    updatedAt: Date.now(),
    finishedAt: null,
    project: DEFAULT_PROJECT,
    engine: null,
    nativeEngine: null,
    opts: {},
    host: null,
    steps: freshSteps(),
    docker: {},
    download: null,
    services: {},
    model: null,
    test: null,
    error: null,
    notes: [],
    log: [],
  };
}

export function readSetupState(file = setupStatePath()): SetupState | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as SetupState;
    return raw && raw.version === 1 ? raw : null;
  } catch {
    return null;
  }
}

/** Effects the runner needs — swapped out in unit tests. */
export interface RunnerDeps {
  stateDir: string;
  detect: () => Promise<HostReport>;
  detectDeps: DetectDeps;
  ops: (cli: string) => DockerOps;
  portBusy: (port: number) => Promise<boolean>;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  wireConfig: (s: { kokoroUrl: string; speachesUrl: string; sttModel?: string }) => Promise<void>;
  now: () => number;
  /** Seconds to wait for the engine after starting Docker. */
  dockerWaitSec: { desktop: number; systemd: number };
  healthTimeoutMs: number;
  /** The built-in engine's process supervisor. */
  engine: () => Pick<
    VoiceEngineSupervisor,
    "start" | "waitReady" | "isRunning" | "recentLog" | "state"
  >;
  measureModels: (files: ModelFile[], dir: string) => Promise<FileSize[]>;
  downloadModel: (
    file: ModelFile,
    dir: string,
    onBytes: (n: number) => void,
    signal?: AbortSignal,
  ) => Promise<void>;
  /** Voice already set up on this computer before (keeps the owner's Docker voice). */
  existingEngine: () => Promise<VoiceEngineKind | null>;
}

export function realRunnerDeps(stateDir = resolveStateDir()): RunnerDeps {
  const detectDeps = realDetectDeps(stateDir);
  return {
    stateDir,
    detectDeps,
    detect: () => detectHost(detectDeps, stateDir),
    ops: (cli) => new DockerOps(cli, detectDeps.exec),
    portBusy,
    fetch: globalThis.fetch.bind(globalThis),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    wireConfig: async (s) => (await import("./wire.js")).wireLocalVoiceConfig(s),
    now: () => Date.now(),
    dockerWaitSec: { desktop: 150, systemd: 45 },
    healthTimeoutMs: 240_000,
    engine: getVoiceEngine,
    measureModels: (files, dir) => measure(files, dir),
    downloadModel: (file, dir, onBytes, signal) => downloadFile(file, dir, onBytes, { signal }),
    existingEngine: async () => {
      const { loadVoiceConfig } = await import("../config.js");
      return loadVoiceConfig()?.mode === "docker" ? "docker" : null;
    },
  };
}

/** On-disk size (GB) each image needs once unpacked, for the space check. */
const DISK_GB: Record<string, number> = {
  "ghcr.io/remsky/kokoro-fastapi-cpu:latest": 5.2,
  "ghcr.io/speaches-ai/speaches:latest-cuda-12.6.3": 8.6,
  "ghcr.io/speaches-ai/speaches:latest-cpu": 2.2,
};

class Halt extends Error {
  constructor(readonly phase: SetupPhase) {
    super(phase);
  }
}

export class LocalVoiceSetupRunner {
  private state: SetupState;
  private job: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private listeners = new Set<(s: SetupState) => void>();
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private lastEmit = 0;

  constructor(private deps: RunnerDeps) {
    const saved = readSetupState(setupStatePath(deps.stateDir));
    this.state = saved ?? emptyState();
    this.state.running = false;
    // A record left mid-run by a closed app / restarted gateway.
    this.state.interrupted = ACTIVE_PHASES.has(this.state.phase);
  }

  onChange(fn: (s: SetupState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  isRunning(): boolean {
    return this.job !== null;
  }

  status(): SetupState {
    return structuredClone(this.state);
  }

  /** Start (or resume) the setup. Returns at once; progress via onChange/status. */
  start(opts: SetupOptions = {}): SetupState {
    if (this.job) return this.status();
    const resume = this.state.interrupted || this.state.phase !== "done";
    const prev = this.state;
    const project = sanitizeProject(opts.project ?? (resume ? prev.project : undefined));
    this.state = {
      ...emptyState(),
      project,
      opts: { ...(resume ? prev.opts : {}), ...opts, project },
      engine: opts.engine ?? (resume ? prev.opts.engine : undefined) ?? null,
      nativeEngine: prev.nativeEngine,
      // Keep finished downloads visible on resume.
      download: resume ? prev.download : null,
      startedAt: this.deps.now(),
      running: true,
      steps: freshSteps(opts.engine ?? (resume ? prev.opts.engine : undefined) ?? null),
      log: resume ? prev.log.slice(-60) : [],
    };
    this.abort = new AbortController();
    this.job = this.run()
      .catch((err: unknown) => {
        if (err instanceof Halt) return;
        const raw = err instanceof Error ? err.message : String(err);
        this.logLine(`error: ${raw}`);
        if (this.abort?.signal.aborted) {
          this.update({ phase: "cancelled" });
          return;
        }
        this.failActive();
        this.update({
          phase: "failed",
          error: { ...friendlyError(raw), details: this.state.log.slice(-40).join("\n") },
        });
      })
      .finally(() => {
        this.job = null;
        this.abort = null;
        this.update({ running: false, finishedAt: this.deps.now() });
        this.flush();
      });
    this.flush();
    return this.status();
  }

  cancel(): SetupState {
    this.abort?.abort();
    return this.status();
  }

  /** Wait for the current job (tests / `wait: true`). */
  async settle(): Promise<SetupState> {
    if (this.job) await this.job;
    return this.status();
  }

  // ── job ──────────────────────────────────────────────────────────────────

  private async run(): Promise<void> {
    // 1. Checking your computer
    this.step("check", "active");
    this.update({ phase: "checking" });
    let host = await this.deps.detect();
    this.update({ host });
    this.logLine(
      `host: ${host.osLabel} ${host.arch}, ${host.ramGb} GB RAM, ${host.diskFreeGb ?? "?"} GB free, GPU ${host.gpu.nvidia ? host.gpu.name : "none"}, docker ${host.docker.state}${host.docker.version ? ` ${host.docker.version}` : ""}`,
    );
    this.step("check", "done", hostSummary(host));
    if (host.ramGb && host.ramGb < 6)
      this.note("This computer has little memory. Voice may feel slow while other apps are open.");

    const engine = await this.chooseEngine(host);
    if (engine !== this.state.engine || this.state.steps.length !== stepsFor(engine).length) {
      const check = this.state.steps.find((x) => x.id === "check");
      this.state.steps = freshSteps(engine).map((x) => (x.id === "check" && check ? check : x));
    }
    this.update({ engine, opts: { ...this.state.opts, engine } });
    this.logLine(`engine: ${engine}`);
    if (engine === "native") return this.runNative(host);

    // 2. Docker
    this.step("docker", "active");
    host = await this.ensureDocker(host);
    this.step("docker", "done", `Docker ${host.docker.version ?? ""} is running`.trim());
    this.bootNotes(host);
    const ops = this.deps.ops(host.docker.cli ?? "docker");

    // 3. Plan + per-service decisions (reuse before anything new).
    const project = this.state.project;
    const plans = planServices(host, this.state.opts);
    const defaults = !this.state.opts.ports && project === DEFAULT_PROJECT;
    const decided: Array<{ plan: ServicePlan; action: ServiceAction }> = [];
    for (const plan of plans) {
      const answering = defaults ? await this.serviceAnswers(plan) : false;
      const ours = await ops.inspectContainer(plan.container);
      const legacy = defaults ? await ops.inspectContainer(LEGACY_CONTAINERS[plan.id]) : null;
      const imagePresent = await ops.imagePresent(plan.image);
      let busy = !answering && !ours && !legacy ? await this.deps.portBusy(plan.hostPort) : false;
      if (busy && !this.state.opts.ports?.[plan.id]) {
        // Default port taken by something else: move to the next free one.
        for (let p = plan.hostPort + 1; p < plan.hostPort + 40; p++) {
          if (!(await this.deps.portBusy(p))) {
            this.logLine(`${plan.id}: port ${plan.hostPort} in use, using ${p}`);
            plan.hostPort = p;
            plan.url = `http://localhost:${p}`;
            busy = false;
            break;
          }
        }
      }
      const action = decideService(
        plan,
        { answering, ours, legacy, imagePresent, portBusy: busy },
        project,
      );
      this.logLine(
        `${plan.id}: ${action.kind}${"container" in action && action.container ? ` (${action.container})` : ""}`,
      );
      if (action.kind === "conflict") {
        throw new Error(
          action.reason === "port"
            ? `port is already allocated: ${plan.hostPort}`
            : `container name ${plan.container} belongs to something else`,
        );
      }
      decided.push({ plan, action });
      this.state.services[plan.id] = {
        container:
          action.kind === "reuse-running"
            ? action.container
            : action.kind === "start-existing"
              ? action.container
              : plan.container,
        url: plan.url,
        port: plan.hostPort,
        image: plan.image,
        action: action.kind,
        healthy: action.kind === "reuse-running",
        reused: action.kind !== "create",
        gpu: plan.gpu,
        model: plan.model,
      };
    }
    this.update({});

    // 4. Downloads
    const toPull = decided.filter((d) => d.action.kind === "create" && d.action.pull);
    this.checkDisk(
      host,
      toPull.map((d) => d.plan),
    );
    if (toPull.length === 0) {
      this.step("download", "skipped", "Already on this computer");
      this.update({ download: null });
    } else {
      this.step("download", "active");
      this.update({ phase: "downloading" });
      await this.pullAll(
        ops,
        toPull.map((d) => d.plan),
      );
      this.step("download", "done");
    }

    // 5. Start + health + speech model
    this.step("start", "active");
    this.update({ phase: "starting" });
    for (const { plan, action } of decided) {
      if (action.kind === "create") {
        this.logLine(`docker ${runArgs(plan, project).join(" ")}`);
        let r = await ops.run(runArgs(plan, project));
        if (!r.ok && plan.gpu && /could not select device driver|nvidia/i.test(r.error)) {
          // Docker can't reach the GPU after all: fall back to the CPU build.
          this.logLine(`gpu run failed (${r.error}); retrying on CPU`);
          this.note(
            "Docker couldn't use your graphics card, so speech-to-text runs on the processor.",
          );
          await ops.remove([plan.container], []);
          const cpu = planServices(
            { gpu: { nvidia: false }, docker: host.docker },
            { ...this.state.opts, project },
          ).find((p) => p.id === plan.id)!;
          Object.assign(plan, {
            image: cpu.image,
            gpu: false,
            model: this.state.opts.sttModel || cpu.model,
            modelApproxMb: cpu.modelApproxMb,
          });
          if (!(await ops.imagePresent(plan.image))) await this.pullAll(ops, [plan]);
          r = await ops.run(runArgs(plan, project));
          Object.assign(this.state.services[plan.id]!, {
            image: plan.image,
            gpu: false,
            model: plan.model,
          });
        }
        if (!r.ok) throw new Error(r.error || `could not start ${plan.container}`);
      } else if (action.kind === "start-existing") {
        const r = await ops.start(action.container);
        if (!r.ok) throw new Error(r.error || `could not start ${action.container}`);
        // Our own container: make sure it survives a reboot. Legacy compose ones already do.
        if (!action.legacy) await ops.ensureRestartPolicy(action.container);
      }
    }
    for (const { plan } of decided) await this.waitHealthy(plan);
    const stt = decided.find((d) => d.plan.id === "speaches")?.plan;
    if (stt?.model) await this.ensureSttModel(stt);
    this.step("start", "done", "Speech-to-text and voices are running");

    // 6. Wire InfiniBot to the engines
    this.step("wire", "active");
    this.update({ phase: "wiring" });
    const kokoro = this.state.services.kokoro!;
    const speaches = this.state.services.speaches!;
    if (this.state.opts.wire !== false) {
      await this.deps.wireConfig({
        kokoroUrl: kokoro.url,
        speachesUrl: speaches.url,
        sttModel: speaches.model,
      });
    }
    this.step("wire", "done", "InfiniBot now uses the voice on this computer");

    // 7. Hear it speak + understand it
    this.step("test", "active");
    this.update({ phase: "testing" });
    const test = await this.selfTest(kokoro.url, speaches.url, speaches.model);
    this.update({ test });
    if (!test.tts) throw new Error("voice test: the voice engine did not return audio (health)");
    if (!test.stt)
      this.note(
        "Speech-to-text answered, but it didn't hear our test sentence correctly. Try the mic test below.",
      );
    this.step("test", "done", test.transcript ? `Heard: “${test.transcript}”` : undefined);
    this.update({ phase: "done", interrupted: false });
  }

  /**
   * Which engine: what the caller asked for → what this computer already uses
   * (the Docker voice an owner set up earlier is kept, never replaced) → the
   * built-in engine.
   */
  private async chooseEngine(host: HostReport): Promise<VoiceEngineKind> {
    if (this.state.opts.engine) return this.state.opts.engine;
    if ((await this.deps.existingEngine()) === "docker") return "docker";
    if (host.docker.state === "running" && host.docker.cli) {
      const ops = this.deps.ops(host.docker.cli);
      for (const name of [LEGACY_CONTAINERS.kokoro, `${DEFAULT_PROJECT}-kokoro`]) {
        if (await ops.inspectContainer(name)) return "docker";
      }
    }
    return "native";
  }

  /** Built-in engine: download models → start the engine → wire → test. No Docker, no admin rights. */
  private async runNative(host: HostReport): Promise<void> {
    const dir = modelsDir(this.deps.stateDir);
    const size = whisperSizeFrom(this.state.opts.sttModel, host.ramGb);
    const sets = [whisperModel(size), KOKORO_MODEL];
    const engine = this.deps.engine();

    // Port: keep ours if the engine already runs there, else the first free one.
    let port =
      this.state.opts.ports?.kokoro ??
      this.state.opts.ports?.speaches ??
      this.state.nativeEngine?.port ??
      ENGINE_DEFAULT_PORT;
    const ownsPort = engine.isRunning() && engine.state.url?.endsWith(`:${port}`);
    if (!ownsPort && (await this.deps.portBusy(port))) {
      const from = port;
      for (let p = port + 1; p < port + 40; p++) {
        if (!(await this.deps.portBusy(p))) {
          port = p;
          break;
        }
      }
      if (port === from) throw new Error(`port is already allocated: ${from}`);
      this.logLine(`engine: port ${from} in use, using ${port}`);
    }

    // Download (resumable) with MB / % / time left.
    this.step("download", "active");
    this.update({ phase: "downloading" });
    const sizes = await Promise.all(sets.map((set) => this.deps.measureModels(set.files, dir)));
    const need = sizes.flat().reduce((n, f) => n + (f.done ? 0 : f.total - f.have), 0);
    const freeBytes = host.diskFreeGb === null ? null : host.diskFreeGb * 1024 ** 3;
    this.logLine(
      `models: ${sets.map((x) => x.repo).join(", ")}; need ${(need / 1024 ** 2).toFixed(0)} MB, ${host.diskFreeGb ?? "?"} GB free`,
    );
    if (freeBytes !== null && need + 300 * 1024 ** 2 > freeBytes) {
      throw new Error(
        `no space left: need about ${Math.ceil(need / 1024 ** 2) + 300} MB, ${host.diskFreeGb} GB free`,
      );
    }
    if (need === 0) {
      this.step("download", "skipped", "Already on this computer");
    } else {
      this.step(
        "download",
        "active",
        `About ${fmtMb(need)} \u00b7 ${host.diskFreeGb === null ? "" : `${Math.floor(host.diskFreeGb)} GB free`}`.replace(
          / \u00b7 $/,
          "",
        ),
      );
      await this.downloadNative(
        sets.map((set, i) => ({ set, sizes: sizes[i]! })),
        dir,
      );
      this.step("download", "done", `${fmtMb(need)} downloaded`);
    }

    // Start the engine (supervised child process) and wait for it to load.
    this.step("start", "active", "Loading the voice engine");
    this.update({ phase: "starting" });
    const cfg: EngineConfig = {
      port,
      modelsDir: dir,
      sttRepo: sets[0]!.repo,
      device: this.state.opts.cpuOnly ? "cpu" : "auto",
    };
    engine.start(cfg);
    const ok = await engine.waitReady(this.deps.healthTimeoutMs);
    for (const line of engine.recentLog().slice(-6)) this.logLine(line);
    if (!ok)
      throw new Error(
        `voice engine did not answer at ${engine.state.url} (health timed out): ${engine.state.lastError ?? ""}`,
      );
    const url = engine.state.url!;
    const gpu = engine.state.sttDevice === "cuda" || !!engine.state.sttDevice?.startsWith("dml");
    const backend = engine.state.backend;
    const rec = (id: VoiceServiceId, model?: string): ServiceRecord => ({
      container: null,
      url,
      port,
      image: id === "kokoro" ? KOKORO_MODEL.repo : sets[0]!.repo,
      action: "native",
      healthy: true,
      reused: need === 0,
      gpu: id === "speaches" ? gpu : false,
      model,
      backend,
    });
    this.state.services = { speaches: rec("speaches", sets[0]!.repo), kokoro: rec("kokoro") };
    this.update({ nativeEngine: cfg });
    this.logLine(
      `voice engine runtime: ${backend ?? "unknown"} (${engine.state.backendReason ?? ""})`,
    );
    if (backend === "wasm")
      this.note(
        "Voice runs in compatibility mode on this computer, so replies take a little longer. Installing the latest Microsoft Visual C++ Redistributable (aka.ms/vs/17/release/vc_redist.x64.exe) and restarting InfiniBot can turn on the faster engine.",
      );
    this.step(
      "start",
      "done",
      backend === "wasm"
        ? "Built-in voice engine is running in compatibility mode"
        : `Built-in voice engine is running${gpu ? " on your graphics card" : ""}`,
    );

    // Wire + test (same as Docker).
    this.step("wire", "active");
    this.update({ phase: "wiring" });
    if (this.state.opts.wire !== false)
      await this.deps.wireConfig({ kokoroUrl: url, speachesUrl: url, sttModel: sets[0]!.repo });
    this.step("wire", "done", "InfiniBot now uses the voice on this computer");

    this.step("test", "active");
    this.update({ phase: "testing" });
    const test = await this.selfTest(url, url, sets[0]!.repo);
    this.update({ test });
    if (!test.tts) throw new Error("voice test: the voice engine did not return audio (health)");
    if (!test.stt)
      this.note(
        "Speech-to-text answered, but it didn't hear our test sentence correctly. Try the mic test below.",
      );
    this.step(
      "test",
      "done",
      test.transcript ? `Heard: \u201c${test.transcript}\u201d` : undefined,
    );
    this.update({ phase: "done", interrupted: false });
  }

  private async downloadNative(
    items: Array<{ set: { id: string; repo: string }; sizes: FileSize[] }>,
    dir: string,
  ): Promise<void> {
    const images: ImageProgress[] = items.map(({ set, sizes }) => {
      const totalBytes = sizes.reduce((n, f) => n + f.total, 0);
      const doneBytes = sizes.reduce((n, f) => n + (f.done ? f.total : 0), 0);
      return {
        service: set.id === "kokoro" ? "kokoro" : "speaches",
        image: set.repo,
        doneBytes,
        totalBytes,
        percent: totalBytes ? Math.floor((doneBytes / totalBytes) * 100) : 0,
        layersDone: sizes.filter((f) => f.done).length,
        layers: sizes.length,
        rate: 0,
        etaSec: null,
        status: sizes.every((f) => f.done) ? "done" : "waiting",
      };
    });
    const samples: Array<{ t: number; bytes: number }> = [];
    const recompute = () => {
      const doneBytes = images.reduce((n, i) => n + i.doneBytes, 0);
      const totalBytes = images.reduce((n, i) => n + i.totalBytes, 0);
      const now = this.deps.now();
      samples.push({ t: now, bytes: doneBytes });
      while (samples.length > 2 && now - samples[0]!.t > 8000) samples.shift();
      const a = samples[0]!;
      const rate = now > a.t ? ((doneBytes - a.bytes) * 1000) / (now - a.t) : 0;
      const percent = totalBytes ? Math.min(100, Math.floor((doneBytes / totalBytes) * 100)) : 0;
      this.update({
        download: {
          images: images.map((i) => ({ ...i })),
          doneBytes,
          totalBytes,
          percent,
          etaSec: rate > 0 ? Math.ceil((totalBytes - doneBytes) / rate) : null,
        },
      });
    };
    recompute();
    for (let i = 0; i < items.length; i++) {
      const img = images[i]!;
      if (img.status === "done") continue;
      img.status = "downloading";
      for (const f of items[i]!.sizes) {
        if (f.done) continue;
        this.logLine(
          `download ${f.file.repo}/${f.file.file}${f.have ? ` (resuming at ${fmtMb(f.have)})` : ""}`,
        );
        let got = 0;
        await this.deps.downloadModel(
          f.file,
          dir,
          (n) => {
            got += n;
            img.doneBytes += n;
            img.percent = img.totalBytes
              ? Math.min(100, Math.floor((img.doneBytes / img.totalBytes) * 100))
              : 0;
            recompute();
          },
          this.abort?.signal,
        );
        // Server sizes can differ slightly from the estimate: settle on what landed.
        img.doneBytes += Math.max(0, f.total - got);
      }
      img.doneBytes = img.totalBytes;
      img.percent = 100;
      img.status = "done";
      recompute();
    }
  }

  private async ensureDocker(host: HostReport): Promise<HostReport> {
    const d = host.docker;
    if (d.state === "running") return host;
    if (d.state === "missing") {
      this.step("docker", "waiting", "Docker isn't installed yet");
      this.update({
        phase: "needs-docker",
        docker: {
          guide: installGuide(host.os, host.arch),
          wslCommand: host.os === "win32" ? WSL_UPDATE_COMMAND : undefined,
        },
      });
      throw new Halt("needs-docker");
    }
    if (d.state === "no-permission") {
      this.step("docker", "waiting", "Your user can't use Docker yet");
      this.update({ phase: "needs-permission", docker: { permissionFix: PERMISSION_FIX } });
      this.logLine(d.detail ?? "");
      throw new Halt("needs-permission");
    }
    // Stopped → start it.
    const plan = dockerStartPlan(host.os, d);
    this.update({ phase: "starting-docker", docker: { startPlan: plan } });
    this.logLine(`starting docker via ${plan.kind}`);
    const res = await startDocker(host.os, plan, this.deps.detectDeps.exec);
    if (res.detail) this.logLine(res.detail.trim());
    if (res.result === "needs-sudo") {
      const sudoCommand =
        plan.kind === "systemctl-system" || plan.kind === "manual"
          ? plan.sudoCommand
          : "sudo systemctl start docker";
      this.step("docker", "waiting", "Docker needs your password to start");
      this.update({ phase: "needs-sudo", docker: { startPlan: plan, sudoCommand } });
      throw new Halt("needs-sudo");
    }
    if (res.result === "failed")
      throw new Error(`Cannot connect to the Docker daemon: ${res.detail || "start failed"}`);
    const total =
      plan.kind === "open-desktop"
        ? this.deps.dockerWaitSec.desktop
        : this.deps.dockerWaitSec.systemd;
    const t0 = this.deps.now();
    for (;;) {
      const left = Math.max(0, total - Math.round((this.deps.now() - t0) / 1000));
      this.update({ docker: { ...this.state.docker, countdownSec: left } });
      const next = await this.deps.detect();
      if (next.docker.state === "running") {
        this.update({ host: next, docker: { ...this.state.docker, countdownSec: 0 } });
        return next;
      }
      if (next.docker.state === "no-permission") return this.ensureDocker(next);
      if (left <= 0)
        throw new Error(
          "Docker desktop is not running: the engine did not answer in time (timed out)",
        );
      if (this.abort?.signal.aborted) throw new Error("cancelled");
      await this.deps.sleep(2000);
    }
  }

  private bootNotes(host: HostReport): void {
    if (
      host.os === "linux" &&
      host.docker.systemUnit &&
      host.docker.enabledAtBoot === false &&
      !host.docker.userUnit
    ) {
      this.note(
        "Docker isn't set to start with your computer. Run “sudo systemctl enable docker” once so voice is ready after a restart.",
      );
    }
    if (host.os !== "linux") {
      this.note(
        "In Docker Desktop settings, turn on “Start Docker Desktop when you sign in” so voice is ready after a restart.",
      );
    }
  }

  private checkDisk(host: HostReport, plans: ServicePlan[]): void {
    if (host.diskFreeGb === null || plans.length === 0) return;
    const need = plans.reduce((n, p) => n + (DISK_GB[p.image] ?? 5), 0) + 2;
    this.logLine(`disk: need ~${need.toFixed(1)} GB, ${host.diskFreeGb} GB free`);
    if (host.diskFreeGb < need)
      throw new Error(
        `no space left: need about ${Math.ceil(need)} GB, ${host.diskFreeGb} GB free`,
      );
  }

  private async pullAll(ops: DockerOps, plans: ServicePlan[]): Promise<void> {
    const prior = new Map((this.state.download?.images ?? []).map((i) => [i.image, i]));
    const trackers = plans.map(
      (p) => new PullTracker(p.image, (APPROX_DOWNLOAD_MB[p.image] ?? 1000) * 1024 * 1024),
    );
    const images: ImageProgress[] = plans.map((p, i) => ({
      ...(prior.get(p.image) ?? trackers[i]!.snapshot()),
      service: p.id,
      status: "waiting",
    }));
    const recompute = () => {
      const doneBytes = images.reduce((n, i) => n + i.doneBytes, 0);
      const totalBytes = images.reduce((n, i) => n + i.totalBytes, 0);
      const rate = images.reduce((n, i) => n + (i.status === "downloading" ? i.rate : 0), 0);
      const percent = totalBytes ? Math.min(100, Math.floor((doneBytes / totalBytes) * 100)) : 0;
      const etaSec = rate > 0 ? Math.ceil((totalBytes - doneBytes) / rate) : null;
      this.update({
        download: { images: images.map((i) => ({ ...i })), doneBytes, totalBytes, percent, etaSec },
      });
    };
    recompute();
    for (let i = 0; i < plans.length; i++) {
      const plan = plans[i]!;
      const tracker = trackers[i]!;
      images[i]!.status = "downloading";
      this.logLine(`pull ${plan.image}`);
      await ops.pull(
        plan.image,
        (ev) => {
          tracker.push(ev, this.deps.now());
          Object.assign(images[i]!, tracker.snapshot(), { status: "downloading" });
          recompute();
        },
        this.abort?.signal,
      );
      const snap = tracker.snapshot();
      Object.assign(images[i]!, snap, {
        doneBytes: snap.totalBytes,
        percent: 100,
        etaSec: 0,
        status: "done",
      });
      recompute();
    }
  }

  private async serviceAnswers(plan: ServicePlan): Promise<boolean> {
    const probe = plan.id === "kokoro" ? `${plan.url}/v1/audio/voices` : `${plan.url}/health`;
    try {
      const r = await this.deps.fetch(probe, { signal: AbortSignal.timeout(3000) });
      return r.ok;
    } catch {
      return false;
    }
  }

  private async waitHealthy(plan: ServicePlan): Promise<void> {
    const deadline = this.deps.now() + this.deps.healthTimeoutMs;
    this.step("start", "active", `Waiting for ${plan.label.toLowerCase()} to answer`);
    while (this.deps.now() < deadline) {
      if (this.abort?.signal.aborted) throw new Error("cancelled");
      if (await this.serviceAnswers(plan)) {
        this.state.services[plan.id]!.healthy = true;
        this.logLine(`${plan.id}: healthy at ${plan.url}`);
        this.update({});
        return;
      }
      await this.deps.sleep(2000);
    }
    throw new Error(`${plan.label} did not answer at ${plan.url} (health timed out)`);
  }

  private async ensureSttModel(plan: ServicePlan): Promise<void> {
    const id = plan.model!;
    const have = async () => {
      try {
        const r = await this.deps.fetch(`${plan.url}/v1/models`, {
          signal: AbortSignal.timeout(5000),
        });
        const j = (await r.json()) as { data?: Array<{ id?: string }> };
        return (j.data ?? []).some((m) => m.id === id);
      } catch {
        return false;
      }
    };
    if (await have()) {
      this.update({ model: { id, approxMb: plan.modelApproxMb, elapsedSec: 0, status: "done" } });
      return;
    }
    this.update({
      phase: "model",
      model: { id, approxMb: plan.modelApproxMb, elapsedSec: 0, status: "downloading" },
    });
    this.step("start", "active", "Downloading the speech model");
    this.logLine(`speaches: downloading model ${id}`);
    const t0 = this.deps.now();
    const tick = setInterval(() => {
      if (this.state.model)
        this.update({
          model: { ...this.state.model, elapsedSec: Math.round((this.deps.now() - t0) / 1000) },
        });
    }, 1000);
    try {
      const r = await this.deps.fetch(`${plan.url}/v1/models/${id}`, {
        method: "POST",
        signal: this.abort
          ? AbortSignal.any([this.abort.signal, AbortSignal.timeout(45 * 60_000)])
          : AbortSignal.timeout(45 * 60_000),
      });
      if (!r.ok && !(await have()))
        throw new Error(
          `speech model download failed: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`,
        );
    } finally {
      clearInterval(tick);
    }
    this.update({
      model: {
        id,
        approxMb: plan.modelApproxMb,
        elapsedSec: Math.round((this.deps.now() - t0) / 1000),
        status: "done",
      },
    });
  }

  /** Make Kokoro say a sentence, then have Speaches transcribe that audio. */
  private async selfTest(
    kokoroUrl: string,
    speachesUrl: string,
    model?: string,
  ): Promise<NonNullable<SetupState["test"]>> {
    let wav: ArrayBuffer | null = null;
    try {
      const r = await this.deps.fetch(`${kokoroUrl}/v1/audio/speech`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "kokoro",
          input: SELF_TEST_SENTENCE,
          voice: "af_heart",
          response_format: "wav",
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (r.ok) wav = await r.arrayBuffer();
      else this.logLine(`tts test: HTTP ${r.status}`);
    } catch (e) {
      this.logLine(`tts test: ${String(e)}`);
    }
    const tts = !!wav && wav.byteLength > 2000;
    this.logLine(`tts test: ${wav?.byteLength ?? 0} bytes`);
    if (!tts) return { tts: false, stt: false };
    let transcript = "";
    try {
      const fd = new FormData();
      fd.append("file", new Blob([wav!], { type: "audio/wav" }), "test.wav");
      if (model) fd.append("model", model);
      const r = await this.deps.fetch(`${speachesUrl}/v1/audio/transcriptions`, {
        method: "POST",
        body: fd,
        signal: AbortSignal.timeout(120_000),
      });
      const j = (await r.json().catch(() => ({}))) as { text?: string };
      transcript = (j.text ?? "").trim();
      this.logLine(`stt test: HTTP ${r.status} "${transcript}"`);
    } catch (e) {
      this.logLine(`stt test: ${String(e)}`);
    }
    return {
      tts: true,
      ttsBytes: wav!.byteLength,
      // The words must come back, not just "some text" (garbage used to pass).
      stt: transcript.length > 0 && wordErrorRate(SELF_TEST_SENTENCE, transcript).wer <= 0.5,
      transcript: transcript || undefined,
    };
  }

  // ── state plumbing ──────────────────────────────────────────────────────

  private step(id: StepId, status: StepStatus, detail?: string): void {
    this.state.steps = this.state.steps.map((s) => (s.id === id ? { ...s, status, detail } : s));
    this.update({});
  }

  private failActive(): void {
    this.state.steps = this.state.steps.map((s) =>
      s.status === "active" ? { ...s, status: "failed" } : s,
    );
  }

  private note(text: string): void {
    if (!this.state.notes.includes(text)) this.state.notes.push(text);
  }

  private logLine(line: string): void {
    if (!line) return;
    this.state.log.push(`[${new Date(this.deps.now()).toISOString().slice(11, 19)}] ${line}`);
    if (this.state.log.length > 200) this.state.log.splice(0, this.state.log.length - 200);
  }

  private update(patch: Partial<SetupState>): void {
    this.state = { ...this.state, ...patch, updatedAt: this.deps.now() };
    this.persist();
    this.scheduleEmit();
  }

  private persist(): void {
    try {
      const file = setupStatePath(this.deps.stateDir);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
      fs.renameSync(tmp, file);
    } catch {
      /* best effort: progress still streams */
    }
  }

  private scheduleEmit(): void {
    const since = Date.now() - this.lastEmit;
    if (since >= 250) {
      this.flush();
      return;
    }
    if (!this.emitTimer) this.emitTimer = setTimeout(() => this.flush(), 250 - since);
  }

  private flush(): void {
    if (this.emitTimer) {
      clearTimeout(this.emitTimer);
      this.emitTimer = null;
    }
    this.lastEmit = Date.now();
    const snap = this.status();
    for (const fn of this.listeners) {
      try {
        fn(snap);
      } catch {
        /* a listener never breaks the job */
      }
    }
  }
}

function fmtMb(bytes: number): string {
  const mb = bytes / 1024 ** 2;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.max(1, Math.round(mb))} MB`;
}

function hostSummary(h: HostReport): string {
  const gpu = h.gpu.nvidia
    ? (h.gpu.name ?? "NVIDIA graphics")
    : "no NVIDIA graphics card (uses the processor)";
  const disk = h.diskFreeGb !== null ? `, ${Math.floor(h.diskFreeGb)} GB free` : "";
  return `${h.osLabel}, ${Math.round(h.ramGb)} GB memory${disk}, ${gpu}`;
}

// ── process singleton ──────────────────────────────────────────────────────

let singleton: LocalVoiceSetupRunner | null = null;
export function getLocalVoiceSetup(): LocalVoiceSetupRunner {
  singleton ??= new LocalVoiceSetupRunner(realRunnerDeps());
  return singleton;
}
/** True while a setup job runs here (the Kokoro bootstrap stays out of its way). */
export function isLocalVoiceSetupRunning(): boolean {
  return singleton?.isRunning() ?? false;
}
export function __setLocalVoiceSetupForTests(r: LocalVoiceSetupRunner | null): void {
  singleton = r;
}

export { DEFAULT_PORTS };
