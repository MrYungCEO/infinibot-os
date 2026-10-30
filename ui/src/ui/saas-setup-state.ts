/**
 * Render-state logic for workspace setup (pure: no DOM, no Lit).
 *
 * Two surfaces show the new-member quickstart:
 *   - the gateway gate (saas-onboarding-gate.ts): the member's private gateway
 *     answers saas.onboarding.status over the socket;
 *   - the cloud setup gate (cloud/cloud-setup.ts): a member whose plan has no
 *     private gateway is set up against the serverless account surface.
 *
 * Both must always show SOMETHING: a loading state while the status is in
 * flight, the steps when setup is required, and an error with Retry when the
 * status can't be read. Never an empty page. The decisions live here so they
 * can be tested without a browser.
 */

/** How long a status read may take before it is treated as failed. */
export const STATUS_TIMEOUT_MS = 15_000;

/**
 * Cap for the serverless account API. Longer than the socket cap: a brand-new
 * tenant's first call provisions it and can land on a cold Function.
 */
export const ACCOUNT_TIMEOUT_MS = 30_000;

export class SetupTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} didn't answer within ${Math.round(ms / 1000)}s.`);
    this.name = "SetupTimeoutError";
  }
}

/** Reject when `p` hasn't settled after `ms` (the page must never wait forever). */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new SetupTimeoutError(label, ms)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * True when the backend simply has no onboarding (a gateway that predates
 * it): the app renders as before. Anything else — a timeout, a dropped
 * request, a server error — is a failure the member can retry.
 */
export function isOnboardingUnsupported(err: unknown): boolean {
  const e = err as { code?: unknown; status?: unknown; message?: unknown } | null;
  const message = String(e?.message ?? err ?? "");
  if (/unknown method|method not found|not implemented/i.test(message)) return true;
  return e?.status === 501 || e?.code === "METHOD_NOT_FOUND";
}

export function describeSetupError(err: unknown): string {
  if (err instanceof SetupTimeoutError) return err.message;
  const message = String((err as Error)?.message ?? err ?? "").trim();
  if (!message || /failed to fetch|networkerror|load failed/i.test(message)) {
    return "Couldn't reach your workspace. Check your connection and try again.";
  }
  return message.length > 220 ? `${message.slice(0, 220)}…` : message;
}

// ── Gateway gate ────────────────────────────────────────────────────────────

export type GatePhase = "loading" | "required" | "error" | "done";

/** What the gateway gate shows for a status result (or failure). */
export function gatePhaseFor(result: { status?: { required?: boolean } | null; error?: unknown }): GatePhase {
  if (result.error !== undefined) return isOnboardingUnsupported(result.error) ? "done" : "error";
  return result.status?.required ? "required" : "done";
}

/** What the gateway gate does on one render pass. */
export type GateAction =
  /** Nothing to gate: the app (or its connect screen) renders. */
  | "app"
  /** Read the onboarding status over this client (boot screen meanwhile). */
  | "load"
  /** The socket was replaced mid-setup: keep the steps, talk to the new client. */
  | "rebind"
  /** Keep showing what the gate already has (steps, boot screen or error). */
  | "show";

/**
 * Once the gate knows setup is unfinished it owns the screen until setup is
 * done. A dropped socket (the Machine sleeping or restarting, a network blip)
 * must not swap the steps for the unconfigured app shell and back again.
 */
export function gateActionFor(s: {
  connected: boolean;
  hasClient: boolean;
  /** Phase of the gate in hand, or null before the first status read. */
  phase: GatePhase | null;
  /** The gate in hand was loaded over the current client. */
  sameClient: boolean;
  /** The last status read failed while the socket was down. */
  failedOffline?: boolean;
}): GateAction {
  const live = s.connected && s.hasClient;
  if (s.phase === null) return live ? "load" : "app";
  if (s.phase === "done") return live && !s.sameClient ? "load" : "app";
  if (!live) return "show";
  if (s.phase === "required") return s.sameClient ? "show" : "rebind";
  if (s.phase === "error") return s.failedOffline || !s.sameClient ? "load" : "show";
  return s.sameClient ? "show" : "load";
}

// ── Cloud setup gate (plans without a private gateway) ──────────────────────

/** Plans the fleet orchestrator never gives a private gateway (402 upgrade_required). */
const SERVERLESS_PLANS = new Set(["free"]);

export type CloudMe = {
  plan?: string | null;
  onboarded?: boolean;
  email?: string | null;
  /** GET /api/me: present + limited on hosted Free (30 free minutes a day on its own Machine). */
  dailyUsage?: { limited?: boolean } | null;
  /** GET /api/me: lowercase channel ids the plan leaves out (Free: telegram, slack); absent = none. */
  channelsExcluded?: string[] | null;
};

/** `channelsExcluded` from /api/me, defaulting to [] (older servers, paid plans). */
export function channelsExcludedOf(me: CloudMe | null | undefined): string[] {
  const raw = me?.channelsExcluded;
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((v): v is string => typeof v === "string").map((v) => v.trim().toLowerCase()).filter(Boolean))];
}

/** True when this member's setup must run on the serverless surface (no gateway will ever answer). */
export function isServerlessPlan(me: CloudMe | null | undefined): boolean {
  // Hosted Free (docs/saas/FREE_PLAN.md): the plan has a daily limit, so it has a
  // Machine for that hour; the gateway's own quickstart runs inside the app.
  if (me?.dailyUsage?.limited === true) return false;
  const plan = String(me?.plan ?? "").trim().toLowerCase();
  // An unknown/empty plan is treated as gateway-backed: the fleet flow then
  // shows its own waking / error states, so nothing is left blank either way.
  return SERVERLESS_PLANS.has(plan);
}

export type CloudSetupView =
  /** Account + status still loading: skeleton console. */
  | "loading"
  /** A read failed: message + Retry. */
  | "error"
  /** The quickstart steps. */
  | "steps"
  /** Setup done on a plan with no hosted workspace: what's saved + how to get one. */
  | "hosted-plans"
  /** A private gateway serves this member: hand over to the fleet connect flow. */
  | "workspace";

export type CloudSetupState = {
  loading: boolean;
  error: unknown;
  me: CloudMe | null;
  status: { required?: boolean } | null;
  /** The quickstart view chunk is in hand. */
  viewReady: boolean;
};

export function cloudSetupView(s: CloudSetupState): CloudSetupView {
  if (s.error !== null && s.error !== undefined) return "error";
  if (s.loading || !s.me) return "loading";
  if (!isServerlessPlan(s.me)) return "workspace";
  if (!s.status) return "loading";
  if (s.status.required) return s.viewReady ? "steps" : "loading";
  return "hosted-plans";
}
