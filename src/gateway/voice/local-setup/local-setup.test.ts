import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  classifyDockerInfoError,
  probeDocker,
  type DetectDeps,
  type ExecResult,
  type HostReport,
} from "./detect.js";
import type { DockerOps } from "./docker-ops.js";
import { socketFromDockerHost, splitImage } from "./docker-ops.js";
import {
  DEFAULT_PROJECT,
  IMAGES,
  PullTracker,
  STT_MODELS,
  decideService,
  dockerStartPlan,
  friendlyError,
  installGuide,
  planServices,
  runArgs,
  type ExistingContainer,
} from "./plan.js";
import { LocalVoiceSetupRunner, setupStatePath, type RunnerDeps } from "./runner.js";

const ok = (stdout = ""): ExecResult => ({ ok: true, code: 0, stdout, stderr: "" });
const fail = (stderr = ""): ExecResult => ({ ok: false, code: 1, stdout: "", stderr });

function deps(over: Partial<DetectDeps> & { responses?: Record<string, ExecResult> }): DetectDeps {
  const responses = over.responses ?? {};
  return {
    exec: async (cmd, args) =>
      responses[`${cmd} ${args.join(" ")}`] ?? responses[`${cmd} ${args[0]}`] ?? fail("not found"),
    exists: () => false,
    platform: "linux",
    arch: "x64",
    env: {},
    homedir: "/home/u",
    totalMemBytes: 16 * 1024 ** 3,
    cpus: 8,
    diskFreeBytes: () => 100 * 1024 ** 3,
    readOsRelease: () => 'PRETTY_NAME="Ubuntu 24.04 LTS"',
    ...over,
  };
}

const INFO_RUNNING = JSON.stringify({
  ServerVersion: "27.1.0",
  Runtimes: { runc: {}, nvidia: {} },
  SecurityOptions: [],
});

describe("docker detection", () => {
  it("classifies daemon errors", () => {
    expect(
      classifyDockerInfoError(
        "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock",
      ),
    ).toBe("no-permission");
    expect(
      classifyDockerInfoError(
        "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
      ),
    ).toBe("stopped");
    expect(
      classifyDockerInfoError(
        "error during connect: open //./pipe/docker_engine: The system cannot find the file specified.",
      ),
    ).toBe("stopped");
  });

  it("missing: no CLI and no Docker Desktop", async () => {
    expect((await probeDocker(deps({}))).state).toBe("missing");
  });

  it("Docker Desktop installed without CLI on PATH counts as stopped (not missing)", async () => {
    const d = await probeDocker(
      deps({ platform: "darwin", exists: (p) => p === "/Applications/Docker.app" }),
    );
    expect(d.state).toBe("stopped");
    expect(d.desktopApp).toBe("/Applications/Docker.app");
  });

  it("finds the CLI outside PATH (packaged app on macOS)", async () => {
    const cli = "/Applications/Docker.app/Contents/Resources/bin/docker";
    const d = await probeDocker(
      deps({
        platform: "darwin",
        exists: (p) => p === cli || p === "/Applications/Docker.app",
        responses: {
          [`${cli} --version`]: ok("Docker version 27.1.0"),
          [`${cli} info --format {{json .}}`]: ok(INFO_RUNNING),
        },
      }),
    );
    expect(d).toMatchObject({ state: "running", cli });
  });

  it("stopped: CLI present, daemon down", async () => {
    const d = await probeDocker(
      deps({
        responses: {
          "docker --version": ok("Docker version 27.1.0, build x"),
          "docker info --format {{json .}}": fail(
            "Cannot connect to the Docker daemon. Is the docker daemon running?",
          ),
          "systemctl cat docker.service": ok("[Unit]"),
          "systemctl is-enabled docker.service": ok("disabled"),
        },
      }),
    );
    expect(d).toMatchObject({ state: "stopped", systemUnit: true, enabledAtBoot: false });
  });

  it("no-permission: user not in the docker group", async () => {
    const d = await probeDocker(
      deps({
        responses: {
          "docker --version": ok("Docker version 27"),
          "docker info --format {{json .}}": ok(
            JSON.stringify({
              ServerErrors: [
                "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock",
              ],
            }),
          ),
        },
      }),
    );
    expect(d.state).toBe("no-permission");
  });

  it("running with the NVIDIA runtime", async () => {
    const d = await probeDocker(
      deps({
        responses: {
          "docker --version": ok("Docker version 27"),
          "docker info --format {{json .}}": ok(INFO_RUNNING),
        },
      }),
    );
    expect(d).toMatchObject({ state: "running", gpuRuntime: true, version: "27.1.0" });
  });
});

describe("plan", () => {
  const dockerRunning = { state: "running", gpuRuntime: true } as HostReport["docker"];
  it("GPU → CUDA speaches + large-v3-turbo; Kokoro always CPU", () => {
    const [stt, tts] = planServices({ gpu: { nvidia: true }, docker: dockerRunning });
    expect(stt).toMatchObject({
      image: IMAGES.speachesGpu,
      gpu: true,
      model: STT_MODELS.gpu.id,
      hostPort: 8002,
    });
    expect(tts).toMatchObject({
      image: IMAGES.kokoro,
      gpu: false,
      hostPort: 8882,
      container: "infinibot-voice-kokoro",
    });
    expect(runArgs(stt!, DEFAULT_PROJECT)).toContain("--gpus");
    expect(runArgs(stt!, DEFAULT_PROJECT)).toEqual(
      expect.arrayContaining([
        "--restart",
        "unless-stopped",
        "infinibot-voice-speaches-cache:/home/ubuntu/.cache/huggingface",
      ]),
    );
  });

  it("no GPU (or GPU without Docker support) → CPU images + small model", () => {
    for (const host of [
      { gpu: { nvidia: false }, docker: dockerRunning },
      { gpu: { nvidia: true }, docker: { ...dockerRunning, gpuRuntime: false } },
    ]) {
      const [stt] = planServices(host);
      expect(stt).toMatchObject({
        image: IMAGES.speachesCpu,
        gpu: false,
        model: STT_MODELS.cpu.id,
      });
      expect(runArgs(stt!, DEFAULT_PROJECT)).not.toContain("--gpus");
    }
  });

  it("separate project + ports for side installs", () => {
    const [stt, tts] = planServices(
      { gpu: { nvidia: false }, docker: dockerRunning },
      { project: "IB Voice E2E", ports: { kokoro: 18882, speaches: 18002 } },
    );
    expect(tts).toMatchObject({
      container: "ib-voice-e2e-kokoro",
      hostPort: 18882,
      url: "http://localhost:18882",
      volume: "ib-voice-e2e-kokoro-cache",
    });
    expect(stt?.hostPort).toBe(18002);
  });

  const plan = planServices({ gpu: { nvidia: false }, docker: dockerRunning })[1]!;
  const c = (status: string, labels: Record<string, string> = {}): ExistingContainer => ({
    name: "x",
    status,
    labels,
  });
  const none = { answering: false, ours: null, legacy: null, imagePresent: false, portBusy: false };

  it("reuses a service that already answers", () => {
    expect(
      decideService(
        plan,
        { ...none, answering: true, legacy: { ...c("running"), name: "infinibot-kokoro" } },
        DEFAULT_PROJECT,
      ),
    ).toEqual({
      kind: "reuse-running",
      container: "infinibot-kokoro",
    });
  });
  it("starts our stopped container instead of creating another", () => {
    expect(
      decideService(
        plan,
        {
          ...none,
          ours: {
            ...c("exited", { "ai.infinibot.voice.project": DEFAULT_PROJECT }),
            name: "infinibot-voice-kokoro",
          },
        },
        DEFAULT_PROJECT,
      ),
    ).toMatchObject({ kind: "start-existing", legacy: false });
  });
  it("starts the older compose container for the default install only", () => {
    const legacy = { ...c("exited"), name: "infinibot-kokoro" };
    expect(decideService(plan, { ...none, legacy }, DEFAULT_PROJECT)).toMatchObject({
      kind: "start-existing",
      legacy: true,
    });
    expect(decideService(plan, { ...none, legacy }, "side-project")).toEqual({
      kind: "create",
      pull: true,
    });
  });
  it("never adopts a same-named container that isn't ours", () => {
    expect(decideService(plan, { ...none, ours: c("running", {}) }, DEFAULT_PROJECT)).toEqual({
      kind: "conflict",
      reason: "name",
    });
  });
  it("skips the download when the image is already here; flags a taken port", () => {
    expect(decideService(plan, { ...none, imagePresent: true }, DEFAULT_PROJECT)).toEqual({
      kind: "create",
      pull: false,
    });
    expect(decideService(plan, { ...none, portBusy: true }, DEFAULT_PROJECT)).toEqual({
      kind: "conflict",
      reason: "port",
    });
  });

  it("starts Docker the right way per OS", () => {
    const base = {
      state: "stopped",
      desktopApp: null,
      systemUnit: false,
      userUnit: null,
    } as unknown as HostReport["docker"];
    expect(dockerStartPlan("win32", base).kind).toBe("open-desktop");
    expect(dockerStartPlan("darwin", base).kind).toBe("open-desktop");
    expect(dockerStartPlan("linux", { ...base, userUnit: "docker" })).toMatchObject({
      kind: "systemctl-user",
      command: "systemctl --user start docker",
    });
    expect(dockerStartPlan("linux", { ...base, systemUnit: true })).toMatchObject({
      kind: "systemctl-system",
      sudoCommand: "sudo systemctl enable --now docker",
    });
    expect(dockerStartPlan("linux", base).kind).toBe("manual");
  });

  it("install guide per OS", () => {
    expect(installGuide("win32", "x64").download?.url).toContain("win/main/amd64");
    expect(installGuide("darwin", "arm64").download?.url).toContain("mac/main/arm64");
    expect(installGuide("linux", "x64").steps[0]?.command).toBe(
      "curl -fsSL https://get.docker.com | sudo sh",
    );
    expect(installGuide("linux", "x64").intro).toMatch(/free helper app/);
  });

  it("plain-language errors", () => {
    expect(friendlyError("write /var/lib/docker/tmp: no space left on device").code).toBe("disk");
    expect(friendlyError("Bind for 0.0.0.0:8882 failed: port is already allocated").code).toBe(
      "port",
    );
    expect(friendlyError("Get https://ghcr.io/v2/: net/http: TLS handshake timeout").code).toBe(
      "network",
    );
    expect(friendlyError('could not select device driver "" with capabilities: [[gpu]]').code).toBe(
      "gpu",
    );
    expect(friendlyError("Cannot find package 'kokoro-js' imported from /x/server.js").code).toBe(
      "engine-missing",
    );
    expect(friendlyError("weird").code).toBe("unknown");
    expect(friendlyError("weird").message).not.toMatch(/weird/);
  });

  it("parses Docker endpoints + image refs", () => {
    expect(socketFromDockerHost("unix:///var/run/docker.sock")).toBe("/var/run/docker.sock");
    expect(socketFromDockerHost("npipe:////./pipe/docker_engine")).toBe(
      "\\\\.\\pipe\\docker_engine",
    );
    expect(socketFromDockerHost("tcp://1.2.3.4:2375")).toBeNull();
    expect(splitImage("ghcr.io/speaches-ai/speaches:latest-cpu")).toEqual({
      repo: "ghcr.io/speaches-ai/speaches",
      tag: "latest-cpu",
    });
    expect(splitImage("localhost:5000/x")).toEqual({ repo: "localhost:5000/x", tag: "latest" });
  });
});

describe("download progress", () => {
  it("tracks MB, %, ETA and counts already-downloaded layers as done (resume)", () => {
    const t = new PullTracker("img", 1000);
    t.push({ id: "latest", status: "Pulling from x" }, 0);
    t.push({ id: "aaaaaaaaaaaa", status: "Already exists" }, 0);
    t.push({ id: "bbbbbbbbbbbb", status: "Pulling fs layer" }, 0);
    t.push(
      { id: "bbbbbbbbbbbb", status: "Downloading", progressDetail: { current: 100, total: 400 } },
      1000,
    );
    t.push(
      { id: "bbbbbbbbbbbb", status: "Downloading", progressDetail: { current: 300, total: 400 } },
      2000,
    );
    const s = t.snapshot();
    expect(s.layers).toBe(2);
    expect(s.layersDone).toBe(1);
    expect(s.totalBytes).toBe(400);
    expect(s.percent).toBe(75);
    expect(s.rate).toBeGreaterThan(0);
    expect(s.etaSec).toBeGreaterThan(0);
    t.push({ id: "bbbbbbbbbbbb", status: "Pull complete" }, 2500);
    // The config blob reports only "Download complete" — still 100 %.
    t.push({ id: "cccccccccccc", status: "Download complete", progressDetail: {} }, 2600);
    expect(t.snapshot().percent).toBe(100);
  });
});

// ── runner state machine ──────────────────────────────────────────────────

function host(docker: Partial<HostReport["docker"]>, gpu = false): HostReport {
  return {
    os: "linux",
    osLabel: "Ubuntu",
    arch: "x64",
    cpus: 8,
    ramGb: 16,
    diskFreeGb: 100,
    gpu: { nvidia: gpu },
    docker: {
      state: "running",
      cli: "docker",
      desktopApp: null,
      systemUnit: true,
      userUnit: null,
      enabledAtBoot: true,
      gpuRuntime: gpu,
      rootless: false,
      ...docker,
    },
    checkedAt: 0,
  };
}

class FakeOps {
  containers = new Map<string, ExistingContainer>();
  images = new Set<string>();
  calls: string[] = [];
  healthy = new Set<number>();
  async inspectContainer(n: string) {
    return this.containers.get(n) ?? null;
  }
  async imagePresent(i: string) {
    return this.images.has(i);
  }
  async pull(
    i: string,
    on: (e: {
      id: string;
      status: string;
      progressDetail?: { current: number; total: number };
    }) => void,
  ) {
    this.calls.push(`pull ${i}`);
    on({ id: "cccccccccccc", status: "Downloading", progressDetail: { current: 50, total: 100 } });
    on({ id: "cccccccccccc", status: "Pull complete" });
    this.images.add(i);
  }
  async run(args: string[]) {
    const name = args[args.indexOf("--name") + 1]!;
    this.calls.push(`run ${name}`);
    const port = Number(args[args.indexOf("-p") + 1]!.split(":")[0]);
    this.healthy.add(port);
    this.containers.set(name, {
      name,
      status: "running",
      labels: {
        "ai.infinibot.voice.project": args
          .find((a) => a.startsWith("ai.infinibot.voice.project="))!
          .split("=")[1]!,
      },
    });
    return { ok: true, error: "" };
  }
  async start(n: string) {
    this.calls.push(`start ${n}`);
    return { ok: true, error: "" };
  }
  async ensureRestartPolicy(n: string) {
    this.calls.push(`update ${n}`);
  }
  async remove() {}
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ib-vls-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function runnerDeps(
  hosts: HostReport[],
  ops: FakeOps,
  extra: Partial<RunnerDeps> = {},
): RunnerDeps & { wired: unknown[] } {
  let i = 0;
  const wired: unknown[] = [];
  const execResponses: Record<string, ExecResult> = {};
  return {
    wired,
    stateDir: dir,
    detect: async () => hosts[Math.min(i++, hosts.length - 1)]!,
    detectDeps: deps({ responses: execResponses }),
    ops: () => ops as unknown as DockerOps,
    portBusy: async () => false,
    fetch: (async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url));
      const port = Number(u.port);
      if (!ops.healthy.has(port)) throw new Error("ECONNREFUSED");
      if (u.pathname === "/v1/audio/speech") return new Response(new Uint8Array(5000));
      if (u.pathname === "/v1/audio/transcriptions")
        return Response.json({ text: "Hello! Your voice is ready." });
      if (u.pathname === "/v1/models" && init?.method !== "POST")
        return Response.json({ data: [] });
      return new Response("ok");
    }) as typeof fetch,
    sleep: async () => undefined,
    wireConfig: async (s) => void wired.push(s),
    now: () => Date.now(),
    dockerWaitSec: { desktop: 5, systemd: 5 },
    healthTimeoutMs: 50,
    // The Docker tests below: this computer already uses Docker voice.
    existingEngine: async () => "docker",
    engine: () => new FakeEngine(ops) as never,
    measureModels: async (files) =>
      files.map((file) => ({ file, total: 1000, have: 0, done: false })),
    downloadModel: async (_f, _d, onBytes) => onBytes(1000),
    ...extra,
  };
}

/** Stand-in for the built-in engine's process supervisor. */
class FakeEngine {
  started: unknown[] = [];
  state = { url: null as string | null, sttDevice: "cpu", lastError: null as string | null };
  constructor(
    private ops: FakeOps,
    private loads = true,
  ) {}
  start(cfg: { port: number }) {
    this.started.push(cfg);
    this.state.url = `http://127.0.0.1:${cfg.port}`;
    if (this.loads) this.ops.healthy.add(cfg.port);
  }
  async waitReady() {
    if (!this.loads) this.state.lastError = "engine could not load its models";
    return this.loads;
  }
  isRunning() {
    return this.started.length > 0;
  }
  recentLog() {
    return ["[voice-engine] kokoro ready in 400 ms"];
  }
}

describe("setup runner", () => {
  it("docker missing → waits on the install guide, nothing started", async () => {
    const ops = new FakeOps();
    const r = new LocalVoiceSetupRunner(runnerDeps([host({ state: "missing", cli: null })], ops));
    r.start();
    const s = await r.settle();
    expect(s.phase).toBe("needs-docker");
    expect(s.running).toBe(false);
    expect(s.docker.guide?.title).toMatch(/Linux/);
    expect(s.steps.find((x) => x.id === "docker")?.status).toBe("waiting");
    expect(ops.calls).toEqual([]);
  });

  it("no permission → shows the docker-group fix", async () => {
    const r = new LocalVoiceSetupRunner(
      runnerDeps([host({ state: "no-permission" })], new FakeOps()),
    );
    r.start();
    const s = await r.settle();
    expect(s.phase).toBe("needs-permission");
    expect(s.docker.permissionFix?.command).toBe("sudo usermod -aG docker $USER");
  });

  it("stopped + systemctl needs a password → one sudo command to copy", async () => {
    const d = runnerDeps([host({ state: "stopped" })], new FakeOps());
    d.detectDeps = deps({
      responses: {
        "systemctl start --no-ask-password docker": fail("Interactive authentication required."),
      },
    });
    const r = new LocalVoiceSetupRunner(d);
    r.start();
    const s = await r.settle();
    expect(s.phase).toBe("needs-sudo");
    expect(s.docker.sudoCommand).toBe("sudo systemctl enable --now docker");
  });

  it("stopped → starts Docker → downloads → creates → wires → tests (no GPU)", async () => {
    const ops = new FakeOps();
    const d = runnerDeps([host({ state: "stopped" }), host({ state: "running" })], ops);
    d.detectDeps = deps({ responses: { "systemctl start --no-ask-password docker": ok() } });
    const r = new LocalVoiceSetupRunner(d);
    r.start({ project: "t1", ports: { kokoro: 28882, speaches: 28002 } });
    const s = await r.settle();
    expect(s.error).toBeNull();
    expect(s.phase).toBe("done");
    expect(ops.calls).toEqual([
      `pull ${IMAGES.speachesCpu}`,
      `pull ${IMAGES.kokoro}`,
      "run t1-speaches",
      "run t1-kokoro",
    ]);
    expect(s.download?.percent).toBe(100);
    expect(s.services.speaches).toMatchObject({
      url: "http://localhost:28002",
      model: STT_MODELS.cpu.id,
      gpu: false,
      healthy: true,
    });
    expect(d.wired).toEqual([
      {
        kokoroUrl: "http://localhost:28882",
        speachesUrl: "http://localhost:28002",
        sttModel: STT_MODELS.cpu.id,
      },
    ]);
    expect(s.test).toMatchObject({ tts: true, stt: true });
    expect(s.steps.every((x) => x.status === "done")).toBe(true);
  });

  it("GPU host uses the CUDA image with --gpus", async () => {
    const ops = new FakeOps();
    const r = new LocalVoiceSetupRunner(runnerDeps([host({}, true)], ops));
    r.start({ project: "t2", ports: { kokoro: 28883, speaches: 28003 } });
    const s = await r.settle();
    expect(s.phase).toBe("done");
    expect(ops.calls[0]).toBe(`pull ${IMAGES.speachesGpu}`);
    expect(s.services.speaches?.gpu).toBe(true);
  });

  it("reuses what's already running (owner's kokoro on :8882) and never duplicates it", async () => {
    const ops = new FakeOps();
    ops.healthy.add(8882).add(8002);
    ops.containers.set("infinibot-kokoro", {
      name: "infinibot-kokoro",
      status: "running",
      labels: {},
    });
    ops.containers.set("infinibot-speaches", {
      name: "infinibot-speaches",
      status: "running",
      labels: {},
    });
    const r = new LocalVoiceSetupRunner(runnerDeps([host({})], ops));
    r.start();
    const s = await r.settle();
    expect(s.phase).toBe("done");
    expect(ops.calls).toEqual([]);
    expect(s.services.kokoro).toMatchObject({
      action: "reuse-running",
      container: "infinibot-kokoro",
      reused: true,
    });
    expect(s.steps.find((x) => x.id === "download")?.status).toBe("skipped");
  });

  it("restarts a stopped existing container instead of creating another", async () => {
    const ops = new FakeOps();
    ops.images.add(IMAGES.kokoro).add(IMAGES.speachesCpu);
    ops.containers.set("t3-kokoro", {
      name: "t3-kokoro",
      status: "exited",
      labels: { "ai.infinibot.voice.project": "t3" },
    });
    ops.start = async (n: string) => {
      ops.calls.push(`start ${n}`);
      ops.healthy.add(28884);
      return { ok: true, error: "" };
    };
    const r = new LocalVoiceSetupRunner(runnerDeps([host({})], ops));
    r.start({ project: "t3", ports: { kokoro: 28884, speaches: 28004 } });
    const s = await r.settle();
    expect(s.phase).toBe("done");
    expect(ops.calls).toEqual(["run t3-speaches", "start t3-kokoro", "update t3-kokoro"]);
  });

  it("resumes after the app was closed mid-download", async () => {
    // A record left mid-download by a previous process.
    const file = setupStatePath(dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const first = new LocalVoiceSetupRunner(runnerDeps([host({})], new FakeOps()));
    fs.writeFileSync(
      file,
      JSON.stringify({
        ...first.status(),
        phase: "downloading",
        project: "t4",
        opts: { project: "t4", ports: { kokoro: 28885, speaches: 28005 } },
      }),
    );
    const ops = new FakeOps();
    ops.images.add(IMAGES.speachesCpu); // finished before the app closed
    const r = new LocalVoiceSetupRunner(runnerDeps([host({})], ops));
    expect(r.status().interrupted).toBe(true);
    r.start();
    const s = await r.settle();
    expect(s.phase).toBe("done");
    expect(s.interrupted).toBe(false);
    expect(s.services.kokoro?.url).toBe("http://localhost:28885");
    expect(ops.calls.filter((c) => c.startsWith("pull"))).toEqual([`pull ${IMAGES.kokoro}`]);
  });

  it("failure → plain reason + details, never a raw error as the title", async () => {
    const ops = new FakeOps();
    ops.pull = async () => {
      throw new Error("write /var/lib/docker: no space left on device");
    };
    const r = new LocalVoiceSetupRunner(runnerDeps([host({})], ops));
    r.start({ project: "t5", ports: { kokoro: 28886, speaches: 28006 } });
    const s = await r.settle();
    expect(s.phase).toBe("failed");
    expect(s.error).toMatchObject({ code: "disk", title: "Your computer is out of space" });
    expect(s.error?.details).toMatch(/no space left/);
    expect(s.steps.find((x) => x.id === "download")?.status).toBe("failed");
  });

  it("refuses to start when the disk is too small", async () => {
    const h = host({});
    h.diskFreeGb = 3;
    const r = new LocalVoiceSetupRunner(runnerDeps([h], new FakeOps()));
    r.start({ project: "t6", ports: { kokoro: 28887, speaches: 28007 } });
    const s = await r.settle();
    expect(s.error?.code).toBe("disk");
  });
});

describe("built-in voice engine (no Docker)", () => {
  const nativeDeps = (ops: FakeOps, extra: Partial<RunnerDeps> = {}) =>
    runnerDeps([host({ state: "missing", cli: null })], ops, {
      existingEngine: async () => null,
      ...extra,
    });

  it("is the default: downloads models, starts the engine, wires, tests — Docker never needed", async () => {
    const ops = new FakeOps();
    const engine = new FakeEngine(ops);
    const downloaded: string[] = [];
    const d = nativeDeps(ops, {
      engine: () => engine as never,
      downloadModel: async (f, _d, onBytes) => {
        downloaded.push(`${f.repo}/${f.file}`);
        onBytes(1000);
      },
    });
    const r = new LocalVoiceSetupRunner(d);
    r.start();
    const s = await r.settle();
    expect(s.error).toBeNull();
    expect(s.phase).toBe("done");
    expect(s.engine).toBe("native");
    expect(s.steps.map((x) => x.id)).toEqual(["check", "download", "start", "wire", "test"]);
    expect(downloaded).toContain("onnx-community/Kokoro-82M-v1.0-ONNX/onnx/model_quantized.onnx");
    // 16 GB RAM → the "small" Whisper model.
    expect(downloaded).toContain("onnx-community/whisper-small/onnx/encoder_model_quantized.onnx");
    expect(engine.started).toEqual([
      expect.objectContaining({ port: 8886, sttRepo: "onnx-community/whisper-small" }),
    ]);
    expect(d.wired).toEqual([
      {
        kokoroUrl: "http://127.0.0.1:8886",
        speachesUrl: "http://127.0.0.1:8886",
        sttModel: "onnx-community/whisper-small",
      },
    ]);
    expect(s.nativeEngine).toMatchObject({ port: 8886 });
    expect(s.download?.percent).toBe(100);
    expect(s.test).toMatchObject({ tts: true, stt: true });
    expect(ops.calls).toEqual([]);
  });

  it("picks the smaller speech model on low-memory computers", async () => {
    const ops = new FakeOps();
    const engine = new FakeEngine(ops);
    const h = host({ state: "missing", cli: null });
    h.ramGb = 8;
    const r = new LocalVoiceSetupRunner({
      ...nativeDeps(ops, { engine: () => engine as never }),
      detect: async () => h,
    });
    r.start();
    await r.settle();
    expect(engine.started).toEqual([
      expect.objectContaining({ sttRepo: "onnx-community/whisper-base" }),
    ]);
  });

  it("resumes a half-finished model download and skips finished files", async () => {
    const ops = new FakeOps();
    const calls: string[] = [];
    const r = new LocalVoiceSetupRunner(
      nativeDeps(ops, {
        measureModels: async (files) =>
          files.map((file) => ({
            file,
            total: 1000,
            have: file.file.endsWith(".onnx") ? 400 : 1000,
            done: !file.file.endsWith(".onnx"),
          })),
        downloadModel: async (f, _d, onBytes) => {
          calls.push(f.file);
          onBytes(1000); // 400 already on disk + 600 new
        },
      }),
    );
    r.start();
    const s = await r.settle();
    expect(s.phase).toBe("done");
    expect(calls.every((c) => c.endsWith(".onnx"))).toBe(true);
    expect(s.download?.percent).toBe(100);
  });

  it("already downloaded → no download, just start", async () => {
    const ops = new FakeOps();
    const r = new LocalVoiceSetupRunner(
      nativeDeps(ops, {
        measureModels: async (files) =>
          files.map((file) => ({ file, total: 1000, have: 1000, done: true })),
      }),
    );
    r.start();
    const s = await r.settle();
    expect(s.steps.find((x) => x.id === "download")).toMatchObject({ status: "skipped" });
    expect(s.phase).toBe("done");
  });

  it("keeps an existing Docker voice (the owner's kokoro) instead of switching to built-in", async () => {
    const ops = new FakeOps();
    ops.healthy.add(8882).add(8002);
    const engine = new FakeEngine(ops);
    const r = new LocalVoiceSetupRunner(
      runnerDeps([host({})], ops, {
        existingEngine: async () => "docker",
        engine: () => engine as never,
      }),
    );
    r.start();
    const s = await r.settle();
    expect(s.engine).toBe("docker");
    expect(engine.started).toEqual([]);
    expect(s.services.kokoro?.action).toBe("reuse-running");
  });

  it("an old compose container on this computer also means Docker voice", async () => {
    const ops = new FakeOps();
    ops.containers.set("infinibot-kokoro", {
      name: "infinibot-kokoro",
      status: "exited",
      labels: {},
    });
    ops.start = async (n: string) => {
      ops.calls.push(`start ${n}`);
      ops.healthy.add(8882);
      return { ok: true, error: "" };
    };
    ops.healthy.add(8002);
    const r = new LocalVoiceSetupRunner(
      runnerDeps([host({})], ops, { existingEngine: async () => null }),
    );
    r.start();
    const s = await r.settle();
    expect(s.engine).toBe("docker");
    expect(ops.calls).toContain("start infinibot-kokoro");
  });

  it("explicit engine=native wins (Advanced choice) and moves off a taken port", async () => {
    const ops = new FakeOps();
    const engine = new FakeEngine(ops);
    const r = new LocalVoiceSetupRunner(
      nativeDeps(ops, {
        engine: () => engine as never,
        existingEngine: async () => "docker",
        portBusy: async (p) => p === 8886,
      }),
    );
    r.start({ engine: "native" });
    const s = await r.settle();
    expect(s.engine).toBe("native");
    expect(engine.started).toEqual([expect.objectContaining({ port: 8887 })]);
  });

  it("engine that can't load → plain failure with the engine log in details", async () => {
    const ops = new FakeOps();
    const r = new LocalVoiceSetupRunner(
      nativeDeps(ops, { engine: () => new FakeEngine(ops, false) as never }),
    );
    r.start();
    const s = await r.settle();
    expect(s.phase).toBe("failed");
    expect(s.error?.code).toBe("health");
    expect(s.error?.details).toMatch(/kokoro ready|could not load/);
  });

  it("not enough disk for the models → disk message before downloading", async () => {
    const ops = new FakeOps();
    const h = host({ state: "missing", cli: null });
    h.diskFreeGb = 0.1;
    const r = new LocalVoiceSetupRunner({
      ...nativeDeps(ops, {
        measureModels: async (files) =>
          files.map((file) => ({ file, total: 100 * 1024 ** 2, have: 0, done: false })),
      }),
      detect: async () => h,
    });
    r.start();
    const s = await r.settle();
    expect(s.error?.code).toBe("disk");
  });
});
