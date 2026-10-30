/**
 * Step list + gating for the local `infinibot quickstart` wizard (pure: no
 * DOM, no Lit). The view is views/local-setup.ts.
 *
 * Two paths share the first step ("How will this install run?"):
 *   - standalone: this machine is its own InfiniBot. Bring a model key, then
 *     optional channels and voice (Robovoice).
 *   - satellite: join an existing master. The master supplies the models, so
 *     there are no key steps: find the master, pair with an invite, test the
 *     link, choose what to share.
 * Billing / plans don't exist locally, so there's no such step.
 */
import type { ConsoleStep } from "../onboarding/console-chrome";

export type InstallMode = "standalone" | "satellite";

export type LocalStepKey =
  | "mode"
  | "keys"
  | "channels"
  | "voice"
  | "master"
  | "pair"
  | "share"
  | "finish";

export type LocalStep = ConsoleStep & { key: LocalStepKey; optional?: boolean };

const MODE: LocalStep = { key: "mode", label: "Install", hint: "How it will run" };
const FINISH: LocalStep = { key: "finish", label: "Activate", hint: "Review and finish" };

export const STANDALONE_STEPS: readonly LocalStep[] = [
  MODE,
  { key: "keys", label: "Model keys", hint: "Bring your own key" },
  { key: "channels", label: "Channels", hint: "Where you chat", optional: true },
  { key: "voice", label: "Voice", hint: "Robovoice, optional", optional: true },
  FINISH,
];

export const SATELLITE_STEPS: readonly LocalStep[] = [
  MODE,
  { key: "master", label: "Master", hint: "Find your InfiniBot" },
  { key: "pair", label: "Pair", hint: "Invite and link test" },
  { key: "share", label: "Share", hint: "What it may use here" },
  FINISH,
];

export function stepsForMode(mode: InstallMode): readonly LocalStep[] {
  return mode === "satellite" ? SATELLITE_STEPS : STANDALONE_STEPS;
}

/** The slice of wizard state the gates read. */
export type GateState = {
  mode: InstallMode;
  /** A chat-capable provider (or local Ollama) is connected. */
  hasModel: boolean;
  /** Master address typed or picked. */
  masterUrl: string;
  /** The last connection test against the master succeeded. */
  linkVerified: boolean;
  /** The satellite block is written. */
  satelliteSaved: boolean;
};

/** May the user move past this step? */
export function canContinue(key: LocalStepKey, g: GateState): boolean {
  switch (key) {
    case "keys":
      return g.hasModel;
    case "master":
      return g.masterUrl.trim().length > 0;
    case "pair":
      return g.linkVerified;
    case "share":
      return g.satelliteSaved || g.linkVerified;
    default:
      return true;
  }
}

/** Footer note explaining why Continue is disabled (null when it isn't). */
export function blockedNote(key: LocalStepKey, g: GateState): string | null {
  if (canContinue(key, g)) return null;
  switch (key) {
    case "keys":
      return "Connect at least one model provider to continue.";
    case "master":
      return "Enter or pick your master's address.";
    case "pair":
      return "Test the link to your master to continue.";
    default:
      return null;
  }
}

/** Can Finish run? Standalone needs a model; a satellite needs a verified, saved link. */
export function canFinish(g: GateState): boolean {
  return g.mode === "satellite" ? g.linkVerified || g.satelliteSaved : g.hasModel;
}

// ── Resume ─────────────────────────────────────────────────────────────────

export type LocalResume = { mode: InstallMode; at: LocalStepKey };

const RESUME_KEY = "infinibot.localSetup.v1";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function loadLocalResume(storage: StorageLike | null | undefined): LocalResume | null {
  try {
    const raw = storage?.getItem(RESUME_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<LocalResume>;
    if (v.mode !== "standalone" && v.mode !== "satellite") return null;
    if (!stepsForMode(v.mode).some((s) => s.key === v.at)) return null;
    return { mode: v.mode, at: v.at as LocalStepKey };
  } catch {
    return null;
  }
}

export function saveLocalResume(storage: StorageLike | null | undefined, point: LocalResume): void {
  try {
    storage?.setItem(RESUME_KEY, JSON.stringify(point));
  } catch {
    /* storage blocked: progress just won't survive a reload */
  }
}

export function clearLocalResume(storage: StorageLike | null | undefined): void {
  try {
    storage?.removeItem(RESUME_KEY);
  } catch {
    /* nothing to clear */
  }
}

/** Index to reopen at, never past a gate that isn't satisfied, never at "finish". */
export function resumeIndex(steps: readonly LocalStep[], saved: LocalResume | null, g: GateState): number {
  if (!saved) return 0;
  const target = steps.findIndex((s) => s.key === saved.at);
  if (target < 0) return 0;
  let i = 0;
  while (i < target && i < steps.length - 2 && canContinue(steps[i].key, g)) i++;
  return i;
}
