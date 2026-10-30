/**
 * The local model that plans queries, reviews them and reads fetched pages
 * for a secure research run. It is picked with the same rules as a secure
 * chat run (local-models.ts) and its endpoint is re-checked for locality
 * before every call — secure content only ever goes to this machine.
 */

import type { InfinibotConfig } from "../../config/config.js";
import { parseModelRefLoose, resolveSecureDefaultModel, type ModelRef } from "../local-models.js";
import { checkSecureModelAsync, resolveModelBaseUrl, SecureModeBlockedError } from "../policy.js";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type LocalLlm = {
  /** "provider/model" (shown in the log and the result). */
  ref: string;
  complete(
    messages: ChatMessage[],
    opts?: { maxTokens?: number; signal?: AbortSignal },
  ): Promise<string>;
};

/** Pick the local research model: secureMode.research.model, else the secure default. */
export async function resolveResearchLlm(cfg: InfinibotConfig | undefined): Promise<LocalLlm> {
  let ref: ModelRef | null = parseModelRefLoose(cfg?.secureMode?.research?.model);
  if (!ref) {
    const pick = await resolveSecureDefaultModel({ cfg });
    if (!pick)
      throw new SecureModeBlockedError(
        "no local model is reachable for secure research. Start a local model server (e.g. Ollama) or set secureMode.defaultModel.",
      );
    ref = { provider: pick.provider, model: pick.model };
  }
  const baseUrl = resolveModelBaseUrl({ provider: ref.provider, cfg });
  const verdict = await checkSecureModelAsync({
    provider: ref.provider,
    modelId: ref.model,
    baseUrl,
    cfg,
  });
  if (!verdict.allowed || !baseUrl) {
    throw new SecureModeBlockedError(
      verdict.allowed
        ? `${ref.provider}/${ref.model} has no endpoint`
        : verdict.reason.replace(/^Blocked by Secure Mode: /, ""),
    );
  }
  return openAiCompatibleLlm({ provider: ref.provider, model: ref.model, baseUrl, cfg });
}

export function openAiCompatibleLlm(params: {
  provider: string;
  model: string;
  baseUrl: string;
  cfg?: InfinibotConfig;
  fetchImpl?: typeof fetch;
}): LocalLlm {
  const ref = `${params.provider}/${params.model}`;
  const doFetch = params.fetchImpl ?? fetch;
  const apiKey = params.cfg?.models?.providers?.[params.provider]?.apiKey;
  return {
    ref,
    async complete(messages, opts = {}) {
      // Re-check on every call: a DNS change must not turn a local endpoint remote.
      const verdict = await checkSecureModelAsync({
        provider: params.provider,
        modelId: params.model,
        baseUrl: params.baseUrl,
        cfg: params.cfg,
      });
      if (!verdict.allowed)
        throw new SecureModeBlockedError(verdict.reason.replace(/^Blocked by Secure Mode: /, ""));
      const res = await doFetch(`${params.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(typeof apiKey === "string" && apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: params.model,
          messages,
          temperature: 0.1,
          max_tokens: opts.maxTokens ?? 900,
          stream: false,
          // Qwen3.x / reasoning models: answer directly (Ollama + vLLM honour one of these).
          reasoning_effort: "none",
          chat_template_kwargs: { enable_thinking: false },
        }),
        signal: opts.signal
          ? AbortSignal.any([opts.signal, AbortSignal.timeout(180_000)])
          : AbortSignal.timeout(180_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`local model ${ref} answered ${res.status}: ${text.slice(0, 200)}`);
      }
      const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = json.choices?.[0]?.message?.content ?? "";
      return stripThinking(content);
    },
  };
}

export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

/** Pull the first JSON value (object or array) out of a model answer. */
export function parseJsonLoose<T = unknown>(text: string): T | null {
  const cleaned = stripThinking(text).replace(/^```(?:json)?\s*|\s*```$/gim, "");
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // fall through
  }
  for (const [open, close] of [
    ["{", "}"],
    ["[", "]"],
  ] as const) {
    const start = cleaned.indexOf(open);
    const end = cleaned.lastIndexOf(close);
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1)) as T;
      } catch {
        // try the other shape
      }
    }
  }
  return null;
}
