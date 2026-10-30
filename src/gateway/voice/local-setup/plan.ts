/**
 * Pure decisions for the one-click local voice setup (no I/O — unit tested):
 *
 *   - which images to run (GPU vs CPU) and on which ports / volumes,
 *   - what to do per service: reuse a running one, start an existing
 *     container, or download + create,
 *   - how to get Docker running on this OS (or how to install it),
 *   - plain-language explanations for raw Docker errors,
 *   - download progress (MB, %, time left) from Docker's pull stream.
 */

import type { DockerProbe, HostOs, HostReport } from "./detect.js";

export type VoiceServiceId = "kokoro" | "speaches";

export const DEFAULT_PROJECT = "infinibot-voice";
export const DEFAULT_PORTS: Record<VoiceServiceId, number> = { kokoro: 8882, speaches: 8002 };

/** Containers the earlier docker-compose.voice.yaml created; reused, never duplicated. */
export const LEGACY_CONTAINERS: Record<VoiceServiceId, string> = {
  kokoro: "infinibot-kokoro",
  speaches: "infinibot-speaches",
};

export const IMAGES = {
  // Kokoro: the CPU build on every machine. It is fast enough for real-time
  // speech, needs no graphics card, and the GPU build ships an old PyTorch that
  // can't run on current (Blackwell) NVIDIA cards.
  kokoro: "ghcr.io/remsky/kokoro-fastapi-cpu:latest",
  speachesGpu: "ghcr.io/speaches-ai/speaches:latest-cuda-12.6.3",
  speachesCpu: "ghcr.io/speaches-ai/speaches:latest-cpu",
} as const;

/** Approximate download sizes (compressed), for the estimate before Docker reports real numbers. */
export const APPROX_DOWNLOAD_MB: Record<string, number> = {
  [IMAGES.kokoro]: 2600,
  [IMAGES.speachesGpu]: 4200,
  [IMAGES.speachesCpu]: 900,
};

export const STT_MODELS = {
  gpu: { id: "deepdml/faster-whisper-large-v3-turbo-ct2", approxMb: 1600 },
  cpu: { id: "Systran/faster-whisper-small", approxMb: 480 },
} as const;

export interface ServicePlan {
  id: VoiceServiceId;
  label: string;
  image: string;
  container: string;
  hostPort: number;
  containerPort: number;
  volume: string;
  mountPath: string;
  gpu: boolean;
  url: string;
  /** Speaches only: the Whisper model to download + use. */
  model?: string;
  modelApproxMb?: number;
}

export interface PlanOptions {
  project?: string;
  ports?: Partial<Record<VoiceServiceId, number>>;
  /** Force CPU images even with a GPU. */
  cpuOnly?: boolean;
  sttModel?: string;
}

/** True when containers can use the NVIDIA GPU here. */
export function gpuUsable(host: Pick<HostReport, "gpu" | "docker">): boolean {
  return host.gpu.nvidia && host.docker.gpuRuntime;
}

export function sanitizeProject(p: string | undefined): string {
  const s = (p ?? DEFAULT_PROJECT)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/^[-_]+/, "");
  return s || DEFAULT_PROJECT;
}

export function planServices(
  host: Pick<HostReport, "gpu" | "docker">,
  opts: PlanOptions = {},
): ServicePlan[] {
  const project = sanitizeProject(opts.project);
  const gpu = !opts.cpuOnly && gpuUsable(host);
  const stt = gpu ? STT_MODELS.gpu : STT_MODELS.cpu;
  const kPort = opts.ports?.kokoro ?? DEFAULT_PORTS.kokoro;
  const sPort = opts.ports?.speaches ?? DEFAULT_PORTS.speaches;
  return [
    {
      id: "speaches",
      label: "Speech-to-text",
      image: gpu ? IMAGES.speachesGpu : IMAGES.speachesCpu,
      container: `${project}-speaches`,
      hostPort: sPort,
      containerPort: 8000,
      volume: `${project}-speaches-cache`,
      mountPath: "/home/ubuntu/.cache/huggingface",
      gpu,
      url: `http://localhost:${sPort}`,
      model: opts.sttModel?.trim() || stt.id,
      modelApproxMb: opts.sttModel ? undefined : stt.approxMb,
    },
    {
      id: "kokoro",
      label: "Voices",
      image: IMAGES.kokoro,
      container: `${project}-kokoro`,
      hostPort: kPort,
      containerPort: 8880,
      volume: `${project}-kokoro-cache`,
      mountPath: "/app/voices",
      gpu: false,
      url: `http://localhost:${kPort}`,
    },
  ];
}

/** `docker run` arguments for a planned service (labels mark it as ours). */
export function runArgs(plan: ServicePlan, project: string): string[] {
  const args = [
    "run",
    "-d",
    "--name",
    plan.container,
    "--restart",
    "unless-stopped",
    "-p",
    `${plan.hostPort}:${plan.containerPort}`,
    "-v",
    `${plan.volume}:${plan.mountPath}`,
    "--label",
    `ai.infinibot.voice.project=${project}`,
    "--label",
    `ai.infinibot.voice.service=${plan.id}`,
    "--label",
    `com.docker.compose.project=${project}`,
    "--label",
    `com.docker.compose.service=${plan.id}`,
  ];
  if (plan.gpu) args.push("--gpus", "all");
  args.push(plan.image);
  return args;
}

// ── per-service decision ────────────────────────────────────────────────────

export interface ExistingContainer {
  name: string;
  status: string; // running | exited | created | restarting | paused | dead
  labels: Record<string, string>;
  restartPolicy?: string;
}

export interface ServiceFacts {
  /** The service already answers on its planned port. */
  answering: boolean;
  /** Our container (project-named) if it exists. */
  ours: ExistingContainer | null;
  /** The older compose container (only considered for the default project). */
  legacy: ExistingContainer | null;
  imagePresent: boolean;
  /** Something else holds the planned port. */
  portBusy: boolean;
}

export type ServiceAction =
  | { kind: "reuse-running"; container: string | null }
  | { kind: "start-existing"; container: string; legacy: boolean }
  | { kind: "create"; pull: boolean }
  | { kind: "conflict"; reason: "port" | "name" };

export function decideService(plan: ServicePlan, f: ServiceFacts, project: string): ServiceAction {
  if (f.answering) {
    const running = [f.ours, f.legacy].find((c) => c && c.status === "running");
    return { kind: "reuse-running", container: running?.name ?? null };
  }
  if (f.ours) {
    if (f.ours.labels["ai.infinibot.voice.project"] !== project)
      return { kind: "conflict", reason: "name" };
    return { kind: "start-existing", container: f.ours.name, legacy: false };
  }
  if (f.legacy && project === DEFAULT_PROJECT) {
    return { kind: "start-existing", container: f.legacy.name, legacy: true };
  }
  if (f.portBusy) return { kind: "conflict", reason: "port" };
  return { kind: "create", pull: !f.imagePresent };
}

// ── getting Docker running ─────────────────────────────────────────────────

export type DockerStartPlan =
  | { kind: "systemctl-user"; unit: "docker" | "docker-desktop"; command: string }
  | { kind: "systemctl-system"; command: string; sudoCommand: string }
  | { kind: "open-desktop"; app: string | null }
  | { kind: "manual"; sudoCommand: string };

export function dockerStartPlan(osId: HostOs, d: DockerProbe): DockerStartPlan {
  if (osId === "darwin" || osId === "win32") return { kind: "open-desktop", app: d.desktopApp };
  if (d.userUnit)
    return {
      kind: "systemctl-user",
      unit: d.userUnit,
      command: `systemctl --user start ${d.userUnit}`,
    };
  if (d.systemUnit) {
    return {
      kind: "systemctl-system",
      command: "systemctl start docker",
      sudoCommand: "sudo systemctl enable --now docker",
    };
  }
  return { kind: "manual", sudoCommand: "sudo service docker start" };
}

/** Fix for "your user may not use Docker" (Linux docker group). */
export const PERMISSION_FIX = {
  command: "sudo usermod -aG docker $USER",
  after: "Then log out and back in (or restart the computer) so it takes effect.",
};

export interface InstallStep {
  icon: string;
  title: string;
  text: string;
  command?: string;
  link?: { label: string; url: string };
}

export interface InstallGuide {
  os: HostOs;
  title: string;
  intro: string;
  download: { label: string; url: string } | null;
  steps: InstallStep[];
  note?: string;
}

export function installGuide(osId: HostOs, arch: string): InstallGuide {
  const intro = "Docker is a free helper app that runs InfiniBot's voice engine on your computer.";
  if (osId === "win32") {
    const url =
      arch === "arm64"
        ? "https://desktop.docker.com/win/main/arm64/Docker%20Desktop%20Installer.exe"
        : "https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe";
    return {
      os: osId,
      title: "Install Docker Desktop for Windows",
      intro,
      download: { label: "Download Docker Desktop", url },
      steps: [
        {
          icon: "download",
          title: "Download",
          text: "Click the button above. The installer is about 600 MB.",
        },
        {
          icon: "settings",
          title: "Install",
          text: "Open the file and keep “Use WSL 2” ticked. Restart the computer if it asks.",
        },
        {
          icon: "play",
          title: "Open Docker Desktop once",
          text: "Accept the terms. You can skip signing in.",
        },
        {
          icon: "refresh",
          title: "Come back here",
          text: "Press “I've installed it”. We'll do the rest.",
        },
      ],
      note: "If Windows says WSL needs an update, open PowerShell and run the command below, then try again.",
    };
  }
  if (osId === "darwin") {
    const apple = arch === "arm64";
    return {
      os: osId,
      title: "Install Docker Desktop for Mac",
      intro,
      download: {
        label: apple ? "Download for Apple chip" : "Download for Intel Mac",
        url: apple
          ? "https://desktop.docker.com/mac/main/arm64/Docker.dmg"
          : "https://desktop.docker.com/mac/main/amd64/Docker.dmg",
      },
      steps: [
        {
          icon: "download",
          title: "Download",
          text: "Click the button above. The file is about 600 MB.",
        },
        { icon: "folder", title: "Install", text: "Open it and drag Docker into Applications." },
        {
          icon: "play",
          title: "Open Docker once",
          text: "Start it from Applications and accept the terms. You can skip signing in.",
        },
        {
          icon: "refresh",
          title: "Come back here",
          text: "Press “I've installed it”. We'll do the rest.",
        },
      ],
    };
  }
  return {
    os: osId,
    title: "Install Docker on Linux",
    intro,
    download: {
      label: "Step-by-step for your Linux",
      url: "https://docs.docker.com/engine/install/",
    },
    steps: [
      {
        icon: "terminal",
        title: "Install with one command",
        text: "Open a terminal, paste this and press Enter. It asks for your password.",
        command: "curl -fsSL https://get.docker.com | sudo sh",
      },
      {
        icon: "users",
        title: "Let your user use Docker",
        text: "Paste this too, then log out and back in.",
        command: PERMISSION_FIX.command,
      },
      {
        icon: "refresh",
        title: "Come back here",
        text: "Press “I've installed it”. We'll do the rest.",
      },
    ],
  };
}

export const WSL_UPDATE_COMMAND = "wsl --update";

// ── plain-language errors ──────────────────────────────────────────────────

export interface FriendlyError {
  title: string;
  message: string;
  /** The one thing to do next. */
  action: string;
  code: string;
}

export function friendlyError(raw: string): FriendlyError {
  const s = raw.toLowerCase();
  const f = (code: string, title: string, message: string, action: string): FriendlyError => ({
    code,
    title,
    message,
    action,
  });
  if (
    /initialization routine failed|dll_init_failed|vcruntime140|msvcp140|no access to memory location|specified module could not be found|specified procedure could not be found/.test(
      s,
    )
  ) {
    return f(
      "vcredist",
      "Voice couldn't start on this PC",
      "A Windows component the voice engine needs (the Microsoft Visual C++ Redistributable) is missing or out of date.",
      "Install the latest Microsoft Visual C++ Redistributable from aka.ms/vs/17/release/vc_redist.x64.exe, restart InfiniBot, then press Try again.",
    );
  }
  if (
    /cannot find (package|module)[^\n]*(kokoro-js|transformers|onnxruntime)|err_module_not_found|onnxruntime_binding/.test(
      s,
    )
  ) {
    return f(
      "engine-missing",
      "The voice engine is missing from this install",
      "Part of InfiniBot's built-in voice engine didn't install on this computer.",
      "Update or reinstall InfiniBot, then press Try again. Or use the Docker engine under Advanced.",
    );
  }
  if (/no space left|not enough space|disk quota/.test(s)) {
    return f(
      "disk",
      "Your computer is out of space",
      "The voice engine needs about 10 GB free to download.",
      "Free up some disk space, then press Try again.",
    );
  }
  if (/port is already allocated|address already in use|bind: /.test(s)) {
    return f(
      "port",
      "Another app is using the voice port",
      "Something else on this computer is already using the port the voice engine needs.",
      "Close the other app or press Try again to pick a free port.",
    );
  }
  if (/toomanyrequests|rate limit/.test(s)) {
    return f(
      "ratelimit",
      "The download server asked us to slow down",
      "Too many downloads in a short time.",
      "Wait about 10 minutes, then press Try again.",
    );
  }
  if (
    /tls handshake|i\/o timeout|dial tcp|no such host|network is unreachable|connection reset|eof|timeout exceeded|temporary failure in name resolution/.test(
      s,
    )
  ) {
    return f(
      "network",
      "The download was interrupted",
      "We couldn't reach the download server. Your internet may have dropped.",
      "Check your internet, then press Try again. It continues where it stopped.",
    );
  }
  if (
    /could not select device driver|nvidia-container|unknown or invalid runtime name: nvidia/.test(
      s,
    )
  ) {
    return f(
      "gpu",
      "Docker can't use your graphics card yet",
      "Your NVIDIA card needs a small Docker add-on.",
      "Press Try again to use the processor instead (a little slower).",
    );
  }
  if (/permission denied/.test(s) && /docker/.test(s)) {
    return f(
      "permission",
      "Your user isn't allowed to use Docker yet",
      "Docker is installed, but your user can't talk to it.",
      "Run the command shown, log out and back in, then press Try again.",
    );
  }
  if (
    /cannot connect to the docker daemon|is the docker daemon running|docker_engine|docker desktop is not running/.test(
      s,
    )
  ) {
    return f(
      "docker-stopped",
      "Docker stopped",
      "Docker isn't running right now.",
      "Press Try again and we'll start it.",
    );
  }
  if (/manifest unknown|not found: manifest|pull access denied/.test(s)) {
    return f(
      "image",
      "The voice engine download isn't available",
      "The download server didn't have the file we asked for.",
      "Press Try again. If it keeps happening, use Cloud voice for now.",
    );
  }
  if (/did not answer|health|timed out/.test(s)) {
    return f(
      "health",
      "The voice engine didn't start in time",
      "It downloaded, but didn't answer when we checked.",
      "Press Try again. The second start is usually quicker.",
    );
  }
  return f(
    "unknown",
    "Voice setup didn't finish",
    "Something unexpected stopped the setup.",
    "Press Try again. Open “Show details” if you want to see what happened.",
  );
}

// ── download progress ──────────────────────────────────────────────────────

export interface PullEvent {
  id?: string;
  status?: string;
  progressDetail?: { current?: number; total?: number };
  error?: string;
}

export interface PullProgress {
  image: string;
  doneBytes: number;
  totalBytes: number;
  percent: number;
  layersDone: number;
  layers: number;
  /** Bytes/sec over the recent window. */
  rate: number;
  etaSec: number | null;
}

/**
 * Folds Docker's pull stream into one MB / % / time-left figure. Layers that
 * already exist (a resumed download) count as complete, so a restarted pull
 * picks up where it stopped instead of starting at 0 %.
 */
export class PullTracker {
  private layers = new Map<string, { current: number; total: number; done: boolean }>();
  private samples: Array<{ t: number; bytes: number }> = [];
  constructor(
    readonly image: string,
    private approxBytes: number,
  ) {}

  push(ev: PullEvent, now = Date.now()): void {
    const id = ev.id;
    const status = (ev.status ?? "").toLowerCase();
    // Layer events carry a hex id; "Pulling from …" (id = tag) and digest lines don't.
    if (!id || !/^[0-9a-f]{12,}$/i.test(id)) return;
    const l = this.layers.get(id) ?? { current: 0, total: 0, done: false };
    if (status.startsWith("downloading") && ev.progressDetail) {
      l.current = ev.progressDetail.current ?? l.current;
      l.total = ev.progressDetail.total ?? l.total;
    } else if (
      status.startsWith("verifying") ||
      status.startsWith("download complete") ||
      status.startsWith("extracting")
    ) {
      if (l.total) l.current = l.total;
    }
    // The image config blob only ever reports "Download complete" (no bytes, no "Pull complete").
    const configBlob = status.startsWith("download complete") && !l.total;
    if (configBlob || status.startsWith("pull complete") || status.startsWith("already exists")) {
      l.done = true;
      if (l.total) l.current = l.total;
    }
    this.layers.set(id, l);
    this.samples.push({ t: now, bytes: this.downloadedBytes() });
    while (this.samples.length > 2 && now - this.samples[0]!.t > 8000) this.samples.shift();
  }

  private downloadedBytes(): number {
    let n = 0;
    for (const l of this.layers.values()) n += l.current;
    return n;
  }

  snapshot(): PullProgress {
    const all = [...this.layers.values()];
    const known = all.reduce((n, l) => n + l.total, 0);
    const unknownPending = all.some((l) => !l.done && !l.total);
    const totalBytes = unknownPending
      ? Math.max(known, this.approxBytes)
      : known || this.approxBytes;
    const doneBytes = this.downloadedBytes();
    const layersDone = all.filter((l) => l.done).length;
    const allDone = all.length > 0 && layersDone === all.length;
    let percent = allDone
      ? 100
      : totalBytes > 0
        ? Math.min(99, Math.floor((doneBytes / totalBytes) * 100))
        : 0;
    // CLI fallback streams no byte counts: go by finished layers instead.
    if (!allDone && known === 0 && all.length > 0)
      percent = Math.floor((layersDone / all.length) * 99);
    let rate = 0;
    if (this.samples.length >= 2) {
      const a = this.samples[0]!;
      const b = this.samples[this.samples.length - 1]!;
      if (b.t > a.t) rate = Math.max(0, ((b.bytes - a.bytes) * 1000) / (b.t - a.t));
    }
    const etaSec = allDone ? 0 : rate > 0 ? Math.ceil((totalBytes - doneBytes) / rate) : null;
    return {
      image: this.image,
      doneBytes,
      totalBytes,
      percent,
      layersDone,
      layers: all.length,
      rate,
      etaSec,
    };
  }
}
