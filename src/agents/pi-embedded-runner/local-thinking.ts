import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import { streamSimple } from "@mariozechner/pi-ai";

/**
 * Thinking "off" on a local reasoning model (Qwen3.x on Ollama / vLLM) still
 * reasons by default: one secure-chat turn spent 9k hidden tokens (~5 min on a
 * shared GPU) before answering. pi-ai only sends reasoning params when thinking
 * is ON, so when it is off we add the endpoint's explicit "don't think" switch:
 *   Ollama (OpenAI compat): reasoning_effort "none"
 *   vLLM: chat_template_kwargs.enable_thinking = false
 * Returns the wrapped streamFn, or undefined when nothing applies.
 */
export function wrapStreamFnThinkingOff(params: {
  streamFn?: StreamFn;
  provider: string;
  baseUrl?: string;
  thinkLevel?: string;
  local: boolean;
}): StreamFn | undefined {
  if (!params.local) return undefined;
  if (params.thinkLevel && params.thinkLevel !== "off") return undefined;
  const provider = params.provider.trim().toLowerCase();
  const base = params.baseUrl ?? "";
  const kind =
    provider === "ollama" || /:11434(\/|$)/.test(base)
      ? "ollama"
      : provider.startsWith("vllm")
        ? "vllm"
        : null;
  if (!kind) return undefined;
  const underlying = params.streamFn ?? streamSimple;
  return (model, context, options) =>
    underlying(model as Model<Api>, context, {
      ...options,
      onPayload: (payload: unknown) => {
        if (payload && typeof payload === "object") {
          const p = payload as Record<string, unknown>;
          if (kind === "ollama") {
            if (p.reasoning_effort === undefined) p.reasoning_effort = "none";
          } else {
            const kwargs = (p.chat_template_kwargs ?? {}) as Record<string, unknown>;
            if (kwargs.enable_thinking === undefined) {
              p.chat_template_kwargs = { ...kwargs, enable_thinking: false };
            }
          }
        }
        options?.onPayload?.(payload);
      },
    });
}
