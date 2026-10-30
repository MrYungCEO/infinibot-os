/**
 * View model for "Set up voice for me" (<ib-local-voice-setup>): the gateway's
 * setup record (voice.local.status / voice.local.progress) → which card to show
 * and the plain-language words on it. Pure, so every state is unit-tested.
 */
import type { IconName } from "../icons.js";

export const LOCAL_VOICE_PROGRESS_EVENT = "voice.local.progress";
export const LOCAL_VOICE_WINDOW_EVENT = "ib:voice-local-progress";

export const DOCKER_EXPLAINER = "Docker is a free helper app that runs InfiniBot's voice engine on your computer.";

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

export type StepStatus = "pending" | "active" | "done" | "skipped" | "failed" | "waiting";

export interface InstallStep {
  icon: string;
  title: string;
  text: string;
  command?: string;
}

export type EngineKind = "native" | "docker";

export interface SetupState {
  phase: SetupPhase;
  /** Engine the run uses: built-in (default) or Docker (advanced / already there). */
  engine?: EngineKind | null;
  running: boolean;
  interrupted: boolean;
  project: string;
  host: {
    os: "linux" | "darwin" | "win32" | "other";
    osLabel: string;
    ramGb: number;
    diskFreeGb: number | null;
    gpu: { nvidia: boolean; name?: string };
    docker: { state: string; version?: string };
  } | null;
  steps: Array<{ id: string; label: string; status: StepStatus; detail?: string }>;
  docker: {
    startPlan?: { kind: string };
    countdownSec?: number;
    sudoCommand?: string;
    permissionFix?: { command: string; after: string };
    guide?: {
      title: string;
      intro: string;
      download: { label: string; url: string } | null;
      steps: InstallStep[];
      note?: string;
    };
    wslCommand?: string;
  };
  download: {
    images: Array<{ service: string; image: string; doneBytes: number; totalBytes: number; percent: number; status: string }>;
    doneBytes: number;
    totalBytes: number;
    percent: number;
    etaSec: number | null;
  } | null;
  services: Partial<Record<"kokoro" | "speaches", { url: string; healthy: boolean; reused: boolean; gpu: boolean; model?: string; container: string | null; backend?: "native" | "wasm" | null }>>;
  model: { id: string; approxMb?: number; elapsedSec: number; status: string } | null;
  test: { tts: boolean; stt: boolean; transcript?: string } | null;
  error: { title: string; message: string; action: string; code: string; details: string } | null;
  notes: string[];
  log: string[];
}

export type VoiceCard =
  | "unsupported"
  | "intro"
  | "progress"
  | "needs-docker"
  | "needs-permission"
  | "needs-sudo"
  | "done"
  | "failed";

export function cardFor(state: SetupState | null, supported: boolean): VoiceCard {
  if (!supported) return "unsupported";
  if (!state) return "intro";
  switch (state.phase) {
    case "idle":
    case "cancelled":
      return "intro";
    case "needs-docker":
    case "needs-permission":
    case "needs-sudo":
    case "done":
    case "failed":
      return state.phase;
    default:
      return state.running || state.interrupted ? "progress" : "intro";
  }
}

/** One headline per phase, in plain words. */
export function headline(state: SetupState): string {
  switch (state.phase) {
    case "checking":
      return "Checking your computer…";
    case "starting-docker":
      return "Starting Docker…";
    case "downloading":
      return "Downloading the voice engine…";
    case "starting":
      return "Starting voice…";
    case "model":
      return "Downloading the speech model…";
    case "wiring":
      return "Connecting InfiniBot…";
    case "testing":
      return "Testing your voice…";
    default:
      return state.interrupted ? "Picking up where you left off…" : "Setting up voice…";
  }
}

export function stepIcon(status: StepStatus): IconName {
  switch (status) {
    case "done":
      return "checkCircle";
    case "active":
      return "loader";
    case "failed":
      return "xCircle";
    case "waiting":
      return "alertCircle";
    case "skipped":
      return "check";
    default:
      return "circle";
  }
}

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 MB";
  const mb = n / (1024 * 1024);
  if (mb < 1024) return `${Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

export function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

/** "about 6 min left" / "less than a minute left" / "working out the time left". */
export function fmtEta(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec)) return "working out the time left";
  if (sec < 60) return "less than a minute left";
  const min = Math.round(sec / 60);
  if (min < 90) return `about ${min} min left`;
  return `about ${Math.round(min / 60)} h left`;
}

export function downloadLine(d: NonNullable<SetupState["download"]>): string {
  return `${fmtBytes(d.doneBytes)} of ${fmtBytes(d.totalBytes)} · ${d.percent}% · ${fmtEta(d.etaSec)}`;
}

export function imageLabel(service: string): string {
  return service === "speaches" ? "Speech-to-text engine" : service === "kokoro" ? "Voice engine" : service;
}

/** Intro card words for the engine we'd use. */
export function introCopy(
  engine: EngineKind,
  native: { approxMb: number; downloaded?: boolean } | null,
  diskFreeGb: number | null | undefined,
): { title: string; text: string; button: string; fine: string } {
  if (engine === "docker") {
    return {
      title: "Your voice runs in Docker on this computer",
      text: "We'll check InfiniBot's voice engine in Docker, start it if it's off, connect it and test it. Nothing gets replaced.",
      button: "Check and start my voice",
      fine: DOCKER_EXPLAINER,
    };
  }
  const size = native && native.approxMb > 0 ? fmtBytes(native.approxMb * 1024 * 1024) : null;
  const disk = typeof diskFreeGb === "number" ? ` You have ${Math.floor(diskFreeGb)} GB free.` : "";
  return {
    title: "Set up voice on this computer",
    text: size
      ? `We'll download InfiniBot's voice engine (about ${size}), start it and test it. It all stays on this computer.`
      : "The voice engine is already downloaded. We'll start it and test it.",
    button: "Set up voice for me",
    fine: `No extra apps and no admin password.${size ? ` Needs about ${size}.` : ""}${disk}`,
  };
}

/** Kept for the Docker estimate in the Advanced section. */
export function introLine(plan: Array<{ approxMb: number | null }> | null): string {
  const mb = (plan ?? []).reduce((n, p) => n + (p.approxMb ?? 0), 0);
  const size = mb > 0 ? ` (about ${fmtBytes(mb * 1024 * 1024)} the first time)` : "";
  return `We'll check your computer, get Docker ready, download the voice engine${size}, then test it. It all runs on this computer.`;
}

/** The status text while Docker is starting. */
export function dockerStartLine(state: SetupState): string {
  const left = state.docker.countdownSec;
  const desktop = state.docker.startPlan?.kind === "open-desktop";
  const what = desktop ? "Opening Docker Desktop" : "Starting Docker";
  return left !== undefined && left > 0 ? `${what}. This can take up to ${fmtDuration(left)}.` : `${what}…`;
}

/** Where the "sudo" command goes, per OS — one sentence. */
export function sudoLine(): string {
  return "Docker is installed but only an admin can start it. Open a terminal, paste this and enter your password:";
}

export function isActive(state: SetupState | null): boolean {
  return Boolean(state?.running);
}
