/**
 * SaaS new-member onboarding gate.
 *
 * After Clerk sign-in + gateway connect, ask the gateway (once per connection)
 * whether this member's workspace still needs onboarding. While we don't know
 * yet, show the terminal boot screen so the empty app never flashes; when it's
 * required, render the quickstart instead of the app shell.
 *
 * The screen is never left empty or waiting forever: the status read is capped
 * (STATUS_TIMEOUT_MS) and a failed read shows an error with Retry. Only a
 * gateway that has no onboarding at all (unknown method) fails OPEN to the app.
 * Once setup is known to be unfinished the steps stay up through a dropped
 * socket (gateActionFor in saas-setup-state.ts): they are never swapped for the
 * unconfigured app shell while the gateway sleeps, restarts or reconnects.
 *
 * No-op outside SaaS mode — the local setup wizard is untouched.
 */
import type { TemplateResult } from "lit";
import type { AppViewState } from "./app-view-state";
import type { GatewayBrowserClient } from "./gateway";
import { lazySaasOnboarding } from "./lazy-views";
import { loadAssistantIdentity } from "./controllers/assistant-identity";
import { isSaasMode, onSaasSessionEnd } from "./saas-clerk";
import {
  describeSetupError,
  gateActionFor,
  gatePhaseFor,
  STATUS_TIMEOUT_MS,
  withTimeout,
  type GatePhase,
} from "./saas-setup-state";
import { renderSaasBootScreen, renderSaasSetupNotice } from "./saas-terminal-ambient";
import type { OnboardingStatus } from "./views/saas-onboarding";

type OnboardingModule = typeof import("./views/saas-onboarding");

type Gate = {
  client: GatewayBrowserClient;
  phase: GatePhase;
  status?: OnboardingStatus;
  /** Why the status couldn't be read (phase "error"). */
  error?: string;
  /** The read failed while the socket was down: read again once it is back. */
  failedOffline?: boolean;
  email?: string | null;
  /** Quickstart chunk, fetched during boot so the console follows the boot screen directly. */
  mod?: OnboardingModule;
};

let gate: Gate | null = null;
let sessionEndHooked = false;

/**
 * Host-provided replacement for this gate. The hosted cloud build owns
 * onboarding in its serverless account surface, so it swaps in a gate that
 * only makes sure the gateway side of the workspace is provisioned.
 */
type GateOverride = (state: AppViewState) => TemplateResult | null;
let override: GateOverride | null = null;
export function setSaasOnboardingGateOverride(fn: GateOverride | null): void {
  override = fn;
}

/** New members see the boot sequence at least this long; everyone else is never delayed. */
const BOOT_MIN_MS = 1100;

/** Read the workspace's onboarding status into `current` (also the Retry action). */
async function loadGate(current: Gate, state: AppViewState): Promise<void> {
  const { client } = current;
  const started = performance.now();
  current.phase = "loading";
  current.error = undefined;
  current.failedOffline = false;
  try {
    const [status, me] = await withTimeout(
      Promise.all([
        client.request<OnboardingStatus>("saas.onboarding.status", {}),
        client.request<{ email?: string | null }>("saas.me", {}).catch(() => null),
      ]),
      STATUS_TIMEOUT_MS,
      "Your workspace",
    );
    current.status = status;
    current.email = me?.email ?? null;
    if (status?.required) {
      // A failed chunk fetch falls back to the lazy loader below.
      current.mod = await import("./views/saas-onboarding").catch(() => undefined);
      const hold = BOOT_MIN_MS - (performance.now() - started);
      if (hold > 0) await new Promise((r) => setTimeout(r, hold));
    }
    current.phase = gatePhaseFor({ status });
  } catch (err) {
    current.phase = gatePhaseFor({ error: err });
    if (current.phase === "error") {
      current.error = describeSetupError(err);
      current.failedOffline = !state.connected;
      console.warn("[saas] onboarding status failed; offering a retry", err);
    } else {
      console.warn("[saas] this gateway has no onboarding; showing the app", err);
    }
  }
  if (gate === current) state.requestUpdate?.();
}

export function renderSaasOnboardingGate(state: AppViewState): TemplateResult | null {
  if (!isSaasMode()) return null;
  if (override) return override(state);
  if (!sessionEndHooked) {
    // The gate outlives a dropped socket, so it must not outlive the session.
    sessionEndHooked = true;
    onSaasSessionEnd(() => {
      gate = null;
    });
  }
  const client = state.client;
  const action = gateActionFor({
    connected: Boolean(state.connected),
    hasClient: Boolean(client),
    phase: gate?.phase ?? null,
    sameClient: Boolean(gate && client && gate.client === client),
    failedOffline: gate?.failedOffline,
  });
  if (action === "app" || !client) return null;
  if (action === "load") {
    const current: Gate = { client, phase: "loading" };
    gate = current;
    void loadGate(current, state);
  } else if (action === "rebind" && gate) {
    // Same member, new socket: the steps (and what was typed) stay on screen.
    gate.client = client;
  }
  if (!gate) return null;

  if (gate.phase === "done") return null;
  // Keep other overlays (proactive popups, upgrade nags…) off the setup screen.
  if (document.body) document.body.dataset.authRoute = "1";
  const current = gate;
  if (current.phase === "error") {
    return renderSaasSetupNotice({
      testid: "saas-onboarding-error",
      title: "Couldn't load your setup",
      detail: current.error ?? "Your workspace didn't answer.",
      actions: [
        {
          label: "Try again",
          primary: true,
          testid: "saas-onboarding-retry",
          onClick: () => {
            void loadGate(current, state);
            state.requestUpdate?.();
          },
        },
        {
          label: "Open workspace anyway",
          testid: "saas-onboarding-skip",
          onClick: () => {
            current.phase = "done";
            state.requestUpdate?.();
          },
        },
      ],
    });
  }
  if (current.phase === "loading" || !current.status) return renderSaasBootScreen();

  const requestUpdate = () => state.requestUpdate?.();
  const render = (m: OnboardingModule) =>
    m.renderSaasOnboarding({
      client: current.client,
      status: current.status!,
      email: current.email,
      requestUpdate,
      onDone: () => {
        current.phase = "done";
        m.resetSaasOnboarding();
        // Pick up the new assistant name/avatar right away.
        void loadAssistantIdentity(state).then(requestUpdate);
        requestUpdate();
      },
    });
  if (current.mod) return render(current.mod);
  return lazySaasOnboarding(render, requestUpdate) as TemplateResult;
}
