import type { AnyAgentTool } from "./pi-tools.types.js";

function abortError(): Error {
  const err = new Error("Aborted");
  err.name = "AbortError";
  return err;
}

function throwAbortError(): never {
  throw abortError();
}

export function combineAbortSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  if (!a && !b) return undefined;
  if (a && !b) return a;
  if (b && !a) return b;
  if (a?.aborted) return a;
  if (b?.aborted) return b;
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([a as AbortSignal, b as AbortSignal]);
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  a?.addEventListener("abort", onAbort, { once: true });
  b?.addEventListener("abort", onAbort, { once: true });
  return controller.signal;
}

/**
 * Settle with `work`, or reject with an AbortError the moment `signal` aborts.
 * Most tools never look at their signal, so forwarding it alone left an
 * aborted run awaiting a tool that might never return (the run stayed
 * wedged until the 20-min turn timeout, holding the session lane + lock).
 */
export function raceAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) {
    void work.catch(() => {});
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      void work.catch(() => {});
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

export function wrapToolWithAbortSignal(
  tool: AnyAgentTool,
  abortSignal?: AbortSignal,
): AnyAgentTool {
  if (!abortSignal) return tool;
  const execute = tool.execute;
  if (!execute) return tool;
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const combined = combineAbortSignals(signal, abortSignal);
      if (combined?.aborted) throwAbortError();
      return await raceAbort(
        Promise.resolve().then(() => execute(toolCallId, params, combined, onUpdate)),
        combined,
      );
    },
  };
}
