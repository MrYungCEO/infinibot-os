import type { InfinibotConfig } from "../config/config.js";
import { isLocalModelBaseUrl, resolveModelBaseUrl } from "../secure-mode/policy.js";
import { isSecureSessionKey } from "../secure-mode/session-key.js";

/**
 * True when a turn runs on a model served from this machine (Ollama / vLLM on
 * loopback or a local interface) — or is any Secure Mode turn, which is
 * local-only by policy. Such turns get the longer local timeout and pause the
 * background OCR/vision queue that shares the GPU.
 */
export function isLocalModelTurn(params: {
  cfg?: InfinibotConfig;
  provider: string;
  sessionKey?: string | null;
  /** Resolved model endpoint, when known (wins over the provider config). */
  baseUrl?: string;
}): boolean {
  if (isSecureSessionKey(params.sessionKey)) return true;
  try {
    const base = resolveModelBaseUrl({
      provider: params.provider,
      baseUrl: params.baseUrl,
      cfg: params.cfg,
    });
    return base ? isLocalModelBaseUrl(base, params.cfg) : false;
  } catch {
    return false;
  }
}
