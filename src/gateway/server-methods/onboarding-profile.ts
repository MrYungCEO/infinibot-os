/**
 * Use-case profile RPCs — what the owner said they use InfiniBot for during
 * first-run onboarding, plus the courses / plugins / agents it recommended.
 *
 *   onboarding.profile.get  → { profile | null }
 *   onboarding.profile.set  { profile } → { profile }
 *
 * Stored as one small JSON file in the state dir
 * (`<stateDir>/onboarding/profile.json`) so every browser, the mobile app
 * and agents read the same answer. The control UI keeps a localStorage copy
 * and works without these methods (older gateway), so nothing here is on the
 * critical path.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import type { GatewayRequestHandlers } from "./types.js";

const MAX_BYTES = 16_000;
const LIST_MAX = 40;

export type OnboardingProfile = {
  useCases: string[];
  courses: string[];
  plugins: string[];
  agents: string[];
  dashboard?: string;
  localModels?: boolean;
  secureMode?: boolean;
  voice?: "local" | "cloud" | "later";
  updatedAt: number;
  completedAt?: number | null;
};

export function profilePath(stateDir: string = resolveStateDir()): string {
  return path.join(stateDir, "onboarding", "profile.json");
}

const ID = /^[a-z0-9][a-z0-9._:-]{0,63}$/i;

function ids(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((x): x is string => typeof x === "string" && ID.test(x)))].slice(0, LIST_MAX);
}

/** Validate + normalise untrusted input. Returns null when it isn't a profile at all. */
export function sanitizeProfile(raw: unknown, now = Date.now()): OnboardingProfile | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  const voice = v.voice === "local" || v.voice === "cloud" || v.voice === "later" ? v.voice : undefined;
  return {
    useCases: ids(v.useCases),
    courses: ids(v.courses),
    plugins: ids(v.plugins),
    agents: ids(v.agents),
    ...(typeof v.dashboard === "string" && ID.test(v.dashboard) ? { dashboard: v.dashboard } : {}),
    ...(typeof v.localModels === "boolean" ? { localModels: v.localModels } : {}),
    ...(typeof v.secureMode === "boolean" ? { secureMode: v.secureMode } : {}),
    ...(voice ? { voice } : {}),
    updatedAt: typeof v.updatedAt === "number" && Number.isFinite(v.updatedAt) ? v.updatedAt : now,
    completedAt: typeof v.completedAt === "number" && Number.isFinite(v.completedAt) ? v.completedAt : null,
  };
}

export function readProfile(stateDir?: string): OnboardingProfile | null {
  try {
    return sanitizeProfile(JSON.parse(fs.readFileSync(profilePath(stateDir), "utf8")));
  } catch {
    return null;
  }
}

export function writeProfile(profile: OnboardingProfile, stateDir?: string): void {
  const file = profilePath(stateDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export const ONBOARDING_PROFILE_READ_METHODS = ["onboarding.profile.get"] as const;
export const ONBOARDING_PROFILE_WRITE_METHODS = ["onboarding.profile.set"] as const;

export const onboardingProfileHandlers: GatewayRequestHandlers = {
  "onboarding.profile.get": ({ respond }) => {
    respond(true, { profile: readProfile() });
  },

  "onboarding.profile.set": ({ params, respond }) => {
    const raw = (params as { profile?: unknown } | undefined)?.profile;
    if (JSON.stringify(raw ?? null).length > MAX_BYTES) {
      respond(false, undefined, { code: "INVALID_PARAMS", message: "profile too large" });
      return;
    }
    const profile = sanitizeProfile(raw);
    if (!profile) {
      respond(false, undefined, { code: "INVALID_PARAMS", message: "expected { profile: { useCases: [...] } }" });
      return;
    }
    try {
      writeProfile(profile);
      respond(true, { profile });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },
};
