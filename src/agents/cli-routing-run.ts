/**
 * Per-run side of subscription CLI routing (cli-routing.ts): the "route all
 * traffic" decision for one model run. Its own module so runWithModelFallback
 * and the memory-flush gate share it without importing each other.
 */
import type { InfinibotConfig } from "../config/config.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { isSecureSessionKey } from "../secure-mode/session-key.js";
import { resolveDefaultAgentId } from "./agent-scope.js";
import { resolveForcedCliRoute } from "./cli-routing.js";
import { DEFAULT_PROVIDER } from "./defaults.js";
import { parseModelRef } from "./model-selection.js";

/**
 * "Route all traffic" (cliRouting.allTraffic): a run pinned to an API model
 * (sub-agent / cron / heartbeat model, voice brain, a chat's picked model)
 * moves onto the subscription CLIs. One place, so every ingress that runs a
 * model turn gets it. Secure Mode sessions are left to the secure planner.
 */
export function resolveRunCliRoute(params: {
  cfg: InfinibotConfig | undefined;
  provider: string;
  model: string;
  sessionKey?: string;
  fallbacksOverride?: string[];
  cliRouting?: false;
}): { provider: string; model: string; fallbacksOverride: string[] } | null {
  if (!params.cfg || params.cliRouting === false) return null;
  if (isSecureSessionKey(params.sessionKey)) return null;
  const agentId = params.sessionKey?.trim()
    ? resolveAgentIdFromSessionKey(params.sessionKey)
    : resolveDefaultAgentId(params.cfg);
  const decision = resolveForcedCliRoute({
    cfg: params.cfg,
    agentId,
    provider: params.provider,
    model: params.model,
    rawFallbacks: params.fallbacksOverride,
  });
  const primary = decision ? parseModelRef(decision.primary, DEFAULT_PROVIDER) : null;
  if (!decision || !primary) return null;
  return {
    provider: primary.provider,
    model: primary.model,
    fallbacksOverride: decision.fallbacks,
  };
}
