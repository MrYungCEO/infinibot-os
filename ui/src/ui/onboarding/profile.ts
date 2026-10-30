/**
 * Use-case profile + onboarding progress persistence.
 *
 * Two layers, so nothing is lost when one is missing:
 *   - localStorage (always): instant, survives reloads and gateway restarts
 *     (enabling a plugin or saving config restarts the gateway mid-wizard);
 *   - the gateway (`onboarding.profile.get` / `.set`, src/gateway/server-methods/
 *     onboarding-profile.ts): shared by every browser and readable by agents.
 *     An older gateway without the RPC is fine: the local copy is used.
 */
import { normalizeUseCases, type UseCaseId } from "./use-cases";

export const PROFILE_KEY = "infinibot.onboarding.profile.v1";
export const PROGRESS_KEY = "infinibot.onboarding.progress.v1";

export interface UseCaseProfile {
  useCases: UseCaseId[];
  /** Courses recommended at the end of onboarding (Learn shows these first). */
  courses: string[];
  /** Plugins the user chose to turn on (paid ones are never auto-enabled). */
  plugins: string[];
  agents: string[];
  dashboard?: string;
  /** Local-only choices that cloud onboarding does not have. */
  localModels?: boolean;
  secureMode?: boolean;
  voice?: "local" | "cloud" | "later";
  updatedAt: number;
  completedAt?: number | null;
}

export type StepId =
  | "usecases"
  | "model"
  | "channels"
  | "voice"
  | "phone"
  | "browser"
  | "aiapps"
  | "kinglyvault"
  | "privacy"
  | "recommend"
  | "finish";

export interface OnboardingProgress {
  step: StepId;
  done: StepId[];
  skipped: StepId[];
  /** Set once the user finishes (or dismisses) onboarding. */
  finishedAt?: number | null;
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const STEP_SET = new Set<StepId>(["usecases", "model", "channels", "voice", "phone", "browser", "aiapps", "kinglyvault", "privacy", "recommend", "finish"]);

function store(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function strList(v: unknown, max = 40): string[] {
  return Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && x.length < 80))].slice(0, max) : [];
}

/** Validate anything that claims to be a profile (local JSON or gateway reply). */
export function parseProfile(raw: unknown): UseCaseProfile | null {
  const v = raw as Record<string, unknown> | null;
  if (!v || typeof v !== "object") return null;
  const voice = v.voice === "local" || v.voice === "cloud" || v.voice === "later" ? v.voice : undefined;
  return {
    useCases: normalizeUseCases(strList(v.useCases)),
    courses: strList(v.courses),
    plugins: strList(v.plugins),
    agents: strList(v.agents),
    ...(typeof v.dashboard === "string" ? { dashboard: v.dashboard } : {}),
    ...(typeof v.localModels === "boolean" ? { localModels: v.localModels } : {}),
    ...(typeof v.secureMode === "boolean" ? { secureMode: v.secureMode } : {}),
    ...(voice ? { voice } : {}),
    updatedAt: typeof v.updatedAt === "number" ? v.updatedAt : 0,
    completedAt: typeof v.completedAt === "number" ? v.completedAt : null,
  };
}

export function parseProgress(raw: unknown): OnboardingProgress | null {
  const v = raw as Record<string, unknown> | null;
  if (!v || typeof v !== "object" || typeof v.step !== "string" || !STEP_SET.has(v.step as StepId)) return null;
  const steps = (x: unknown) => strList(x).filter((s): s is StepId => STEP_SET.has(s as StepId));
  return {
    step: v.step as StepId,
    done: steps(v.done),
    skipped: steps(v.skipped),
    finishedAt: typeof v.finishedAt === "number" ? v.finishedAt : null,
  };
}

function readJson(key: string, s: StorageLike | null = store()): unknown {
  try {
    const raw = s?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown, s: StorageLike | null = store()): void {
  try {
    s?.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: progress just won't survive a reload */
  }
}

export function loadLocalProfile(s?: StorageLike | null): UseCaseProfile | null {
  return parseProfile(readJson(PROFILE_KEY, s ?? store()));
}

export function saveLocalProfile(p: UseCaseProfile, s?: StorageLike | null): void {
  writeJson(PROFILE_KEY, p, s ?? store());
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(PROFILE_EVENT, { detail: p }));
  }
}

export function loadProgress(s?: StorageLike | null): OnboardingProgress | null {
  return parseProgress(readJson(PROGRESS_KEY, s ?? store()));
}

export function saveProgress(p: OnboardingProgress, s?: StorageLike | null): void {
  writeJson(PROGRESS_KEY, p, s ?? store());
}

export function clearProgress(s?: StorageLike | null): void {
  try {
    (s ?? store())?.removeItem(PROGRESS_KEY);
  } catch {
    /* nothing to clear */
  }
}

const AUTO_OPENED_KEY = "infinibot.onboarding.autoOpened";

/** True once per browser for a new install that never touched onboarding. */
export function shouldAutoOpenOnboarding(s: StorageLike | null = store()): boolean {
  if (!s) return false;
  try {
    return !s.getItem(AUTO_OPENED_KEY) && !s.getItem(PROGRESS_KEY) && !s.getItem(PROFILE_KEY);
  } catch {
    return false;
  }
}

export function markOnboardingAutoOpened(s: StorageLike | null = store()): void {
  try {
    s?.setItem(AUTO_OPENED_KEY, String(Date.now()));
  } catch {
    /* storage blocked: it just won't auto-open */
  }
}

/** Fired on window whenever the profile changes (Learn re-ranks on it). */
export const PROFILE_EVENT = "infinibot:usecase-profile";

/** Picked use cases, from the local copy (sync; for render-time personalisation). */
export function currentUseCases(): UseCaseId[] {
  return loadLocalProfile()?.useCases ?? [];
}

type Rpc = { request: (method: string, params?: unknown) => Promise<unknown> };

/** Newest of the local and gateway copies; the local copy is refreshed from the gateway. */
export async function syncProfile(client: Rpc | null | undefined): Promise<UseCaseProfile | null> {
  const local = loadLocalProfile();
  if (!client) return local;
  try {
    const res = (await client.request("onboarding.profile.get", {})) as { profile?: unknown } | null;
    const remote = parseProfile(res?.profile);
    if (remote && (!local || remote.updatedAt > local.updatedAt)) {
      saveLocalProfile(remote);
      return remote;
    }
    if (local && (!remote || local.updatedAt > remote.updatedAt)) {
      void pushProfile(client, local);
    }
  } catch {
    /* older gateway without the RPC: local copy only */
  }
  return local;
}

/** Save locally, then best-effort to the gateway. Never throws. */
export async function persistProfile(client: Rpc | null | undefined, p: UseCaseProfile): Promise<boolean> {
  saveLocalProfile(p);
  return client ? pushProfile(client, p) : false;
}

async function pushProfile(client: Rpc, p: UseCaseProfile): Promise<boolean> {
  try {
    await client.request("onboarding.profile.set", { profile: p });
    return true;
  } catch {
    return false;
  }
}
