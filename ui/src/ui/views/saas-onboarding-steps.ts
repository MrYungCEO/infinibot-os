/**
 * Quickstart step list + resume logic (pure: no DOM, no Lit).
 *
 * Which steps a member walks depends on the backend behind the quickstart:
 *   - a tenant gateway serves channels / integrations (it returns `connectors`);
 *   - the serverless account surface (Netlify Functions, no private gateway)
 *     can't run them, so those steps stay in the list but LOCKED: shown as
 *     "available on hosted plans" and always skippable, never hidden and
 *     never blocking;
 *   - an older gateway that predates them simply has four steps;
 *   - "Import your notes" (Obsidian / Notion) needs the documents store on a
 *     private machine: offered on gateway backends, locked on serverless.
 *
 * Progress survives a refresh: the current step and the assistant-name draft
 * are kept per member in localStorage (and, on the serverless backend, in the
 * tenant's onboarding row), so a reload resumes where the member left off.
 */

export type StepKey =
  | "identity"
  | "keys"
  | "channels"
  | "connect"
  | "business"
  | "import"
  | "voice"
  | "finish";
export type StepDef = {
  key: StepKey;
  label: string;
  hint: string;
  /** Needs a private gateway this plan doesn't have: informational, skippable. */
  locked?: boolean;
};

export const ALL_STEPS: readonly StepDef[] = [
  { key: "identity", label: "Identity", hint: "Name your assistant" },
  { key: "keys", label: "Model keys", hint: "Bring your own key" },
  { key: "channels", label: "Channels", hint: "Where you chat" },
  { key: "connect", label: "Integrations", hint: "Tools and MCP" },
  { key: "business", label: "Business", hint: "Context and brand" },
  { key: "import", label: "Import notes", hint: "Obsidian or Notion" },
  { key: "voice", label: "Voice", hint: "Optional cloud voice" },
  { key: "finish", label: "Activate", hint: "Review and unlock" },
];

/** The slice of the onboarding status the step list depends on. */
export type StepStatus = {
  connectors?: unknown;
  businessIndustries?: unknown;
  /** Import routes the gateway serves ("obsidian-zip", "notion-zip", …). */
  imports?: unknown;
  /** "netlify-functions" on the serverless account surface. */
  backend?: string;
  stepData?: Record<string, unknown> | null;
};

export function isServerlessBackend(status: StepStatus): boolean {
  return status.backend === "netlify-functions";
}

function hasConnectors(status: StepStatus): boolean {
  return Array.isArray(status.connectors) && status.connectors.length > 0;
}

/** Steps this backend can show, in order. Never empty: identity, keys and finish always exist. */
export function stepsFor(status: StepStatus): StepDef[] {
  const serverless = isServerlessBackend(status);
  const out: StepDef[] = [];
  for (const step of ALL_STEPS) {
    if (step.key === "import") {
      // Imports land in Documents on the member's private machine; the
      // serverless surface has no documents store, so it's a hosted-plan step.
      if (Array.isArray(status.imports) && status.imports.length) out.push(step);
      else if (serverless) out.push({ ...step, hint: "Hosted plans", locked: true });
      continue;
    }
    if (step.key === "channels" || step.key === "connect") {
      if (hasConnectors(status)) out.push(step);
      else if (serverless) out.push({ ...step, hint: "Hosted plans", locked: true });
      continue;
    }
    if (step.key === "business" && !Array.isArray(status.businessIndustries)) continue;
    out.push(step);
  }
  return out;
}

// ── Resume ─────────────────────────────────────────────────────────────────

export type ResumePoint = { at: StepKey; name?: string };

const RESUME_PREFIX = "infinibot.saasOnboarding.v1:";
const STEP_KEYS = new Set<string>(ALL_STEPS.map((s) => s.key));

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function parseResume(raw: unknown): ResumePoint | null {
  const v = raw as { at?: unknown; name?: unknown } | null;
  if (!v || typeof v !== "object" || typeof v.at !== "string" || !STEP_KEYS.has(v.at)) return null;
  return { at: v.at as StepKey, ...(typeof v.name === "string" ? { name: v.name.slice(0, 50) } : {}) };
}

/** Per-member key: two accounts on one browser never share progress. */
export function resumeStorageKey(member: string | null | undefined): string {
  return `${RESUME_PREFIX}${(member ?? "").trim().toLowerCase() || "anon"}`;
}

export function loadResume(storage: StorageLike | null | undefined, member: string | null | undefined): ResumePoint | null {
  try {
    const raw = storage?.getItem(resumeStorageKey(member));
    return raw ? parseResume(JSON.parse(raw)) : null;
  } catch {
    return null; // storage blocked or corrupt: start from the top
  }
}

export function saveResume(storage: StorageLike | null | undefined, member: string | null | undefined, point: ResumePoint): void {
  try {
    storage?.setItem(resumeStorageKey(member), JSON.stringify(point));
  } catch {
    /* storage unavailable: progress just won't survive a reload */
  }
}

export function clearResume(storage: StorageLike | null | undefined, member: string | null | undefined): void {
  try {
    storage?.removeItem(resumeStorageKey(member));
  } catch {
    /* nothing to clear */
  }
}

/** Progress the serverless backend kept in the tenant's onboarding row. */
export function serverResume(status: StepStatus): ResumePoint | null {
  return parseResume(status.stepData?.progress);
}

/**
 * Index to open the quickstart at. Never past what the member may reach:
 * the keys step gates everything after it until a chat provider is connected,
 * and "finish" is only ever reached by walking there.
 */
export function resumeStepIndex(
  steps: readonly StepDef[],
  saved: ResumePoint | null,
  opts: { hasChatProvider: boolean },
): number {
  if (!saved) return 0;
  let i = steps.findIndex((s) => s.key === saved.at);
  if (i < 0) return 0; // the saved step isn't offered by this backend
  const keys = steps.findIndex((s) => s.key === "keys");
  if (keys >= 0 && i > keys && !opts.hasChatProvider) i = keys;
  return Math.max(0, Math.min(i, steps.length - 1));
}
