import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { FailoverError } from "../agents/failover-error.js";
import type { InfinibotConfig } from "../config/config.js";
import { acquireRuntimeForRun, LocalRuntimeError } from "./runtime.js";

/**
 * Agent run on a local model whose runtime shares the GPU (vLLM unit /
 * Ollama): make it ready first — swapping the GPU and streaming "Starting
 * vLLM…" status to the chat — and hold a lease so a swap can't evict it
 * mid-run. A start failure becomes a FailoverError so runWithModelFallback
 * moves on to the next candidate (in Secure Mode: the next local one).
 */
export async function withLocalRuntimeForRun<T>(
  params: {
    config?: InfinibotConfig;
    provider?: string;
    model?: string;
    runId: string;
    sessionKey?: string;
  },
  fn: () => Promise<T>,
): Promise<T> {
  const provider = (params.provider ?? DEFAULT_PROVIDER).trim() || DEFAULT_PROVIDER;
  const model = (params.model ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  let lease: Awaited<ReturnType<typeof acquireRuntimeForRun>> = null;
  try {
    lease = await acquireRuntimeForRun({
      cfg: params.config,
      provider,
      model,
      runId: params.runId,
      sessionKey: params.sessionKey,
    });
  } catch (err) {
    if (err instanceof LocalRuntimeError) {
      throw new FailoverError(err.message, {
        reason: "timeout",
        provider,
        model,
        code: err.code,
        cause: err,
      });
    }
    throw err;
  }
  try {
    return await fn();
  } finally {
    lease?.release();
  }
}
