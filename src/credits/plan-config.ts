/**
 * Per-provider plan configuration store.
 *
 * Persists which plan the user is on per provider, plus the optional
 * credentials a plan-usage puller needs (Admin API key / org id / OAuth token)
 * and manual budget/cap overrides. Lives at `~/.infinibot/provider-plans.json`.
 *
 * Why a sibling file instead of `infinibot.json`: the top-level config zod
 * schema is `.strict()` (unknown keys fail validation on write), and we want to
 * keep Admin secrets out of the validated/backed-up main config. This mirrors
 * the existing `subscriptions.json` / `pricing-overrides.json` pattern and is
 * multi-user safe via `STATE_DIR` (which honors `resolveStateDir()` namespacing).
 *
 * See docs/research/provider-plans.md for the credential model.
 */
import fs from "node:fs";
import path from "node:path";

import { resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getPlanDef, isPlanProvider } from "./plans/index.js";

const log = createSubsystemLogger("credits").child("plan-config");

export interface ProviderPlanConfig {
  provider: string;
  /** Plan id from the registry (e.g. "api", "pro", "max"). */
  plan: string;
  /**
   * Plan-detection mode. When true (the default), the plan reported by the
   * provider's CLI/credential cache wins and `plan` tracks it automatically.
   * When false the user has manually pinned `plan` and CLI detection must NOT
   * override it (we only surface "CLI says X — use detected?" as a suggestion).
   */
  auto?: boolean;
  /** Credential for the plan-usage puller (Admin key for anthropic/openai). */
  apiKey?: string;
  orgId?: string;
  oauthToken?: string;
  /** Manual overrides — when set, drive the progress-bar denominator. */
  monthlyBudgetUsd?: number;
  monthlyTokenCap?: number;
  updatedAt: number;
}

type PlanConfigFile = { providers: Record<string, ProviderPlanConfig> };

function planConfigPath(): string {
  return path.join(resolveStateDir(), "provider-plans.json");
}

function readFile(): PlanConfigFile {
  const p = planConfigPath();
  if (!fs.existsSync(p)) return { providers: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as Partial<PlanConfigFile>;
    const providers = raw.providers && typeof raw.providers === "object" ? raw.providers : {};
    return { providers: providers as Record<string, ProviderPlanConfig> };
  } catch (e) {
    log.warn("failed to read provider-plans.json — treating as empty", { err: String(e) });
    return { providers: {} };
  }
}

function writeFile(file: PlanConfigFile): void {
  const p = planConfigPath();
  fs.mkdirSync(resolveStateDir(), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, p);
}

export function listProviderPlanConfigs(): ProviderPlanConfig[] {
  return Object.values(readFile().providers);
}

export function getProviderPlanConfig(provider: string): ProviderPlanConfig | undefined {
  return readFile().providers[provider];
}

export interface UpsertProviderPlanInput {
  provider: string;
  plan?: string;
  /** Lock (false) or release (true) plan to CLI auto-detection. */
  auto?: boolean;
  apiKey?: string;
  orgId?: string;
  oauthToken?: string;
  monthlyBudgetUsd?: number;
  monthlyTokenCap?: number;
}

/**
 * Insert or update one provider's plan config. Undefined fields are left
 * untouched (so the UI can save the plan without resending secrets); pass an
 * empty string to explicitly clear a credential.
 */
export function upsertProviderPlanConfig(input: UpsertProviderPlanInput): ProviderPlanConfig {
  if (!input.provider || !isPlanProvider(input.provider)) {
    throw new Error(`Unknown plan provider: ${input.provider}`);
  }
  const file = readFile();
  const prev = file.providers[input.provider];
  const planId = input.plan ?? prev?.plan ?? getPlanDef(input.provider, undefined)?.id ?? "api";
  // Resolve auto-detect mode: explicit flag wins; otherwise picking a plan by
  // hand pins it (auto=false); otherwise keep prior mode, defaulting to auto.
  const auto =
    input.auto !== undefined ? input.auto : input.plan !== undefined ? false : (prev?.auto ?? true);
  const next: ProviderPlanConfig = {
    provider: input.provider,
    plan: planId,
    auto,
    apiKey: input.apiKey !== undefined ? emptyToUndef(input.apiKey) : prev?.apiKey,
    orgId: input.orgId !== undefined ? emptyToUndef(input.orgId) : prev?.orgId,
    oauthToken: input.oauthToken !== undefined ? emptyToUndef(input.oauthToken) : prev?.oauthToken,
    monthlyBudgetUsd:
      input.monthlyBudgetUsd !== undefined
        ? numOrUndef(input.monthlyBudgetUsd)
        : prev?.monthlyBudgetUsd,
    monthlyTokenCap:
      input.monthlyTokenCap !== undefined
        ? numOrUndef(input.monthlyTokenCap)
        : prev?.monthlyTokenCap,
    updatedAt: Date.now(),
  };
  file.providers[input.provider] = next;
  writeFile(file);
  return next;
}

export function deleteProviderPlanConfig(provider: string): void {
  const file = readFile();
  if (file.providers[provider]) {
    delete file.providers[provider];
    writeFile(file);
  }
}

/** A redacted view safe to return over RPC (no raw secrets). */
export function redactPlanConfig(cfg: ProviderPlanConfig): Omit<
  ProviderPlanConfig,
  "apiKey" | "oauthToken"
> & {
  hasApiKey: boolean;
  hasOauthToken: boolean;
} {
  const { apiKey, oauthToken, ...rest } = cfg;
  return { ...rest, hasApiKey: Boolean(apiKey), hasOauthToken: Boolean(oauthToken) };
}

function emptyToUndef(s: string): string | undefined {
  const t = s.trim();
  return t === "" ? undefined : t;
}

function numOrUndef(n: number): number | undefined {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined;
}
