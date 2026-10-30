/**
 * Discovery Docs — AI call wrapper.
 *
 * Uses pi-ai's `completeSimple` against whatever model id the template
 * specifies. Same auth path as TTS summary / image describe:
 *   resolveModel → getApiKeyForModel → completeSimple.
 *
 * Model id format: `"<provider>:<modelId>"` (e.g. `"anthropic:claude-sonnet-4-6"`).
 * Falls back to the agent's default model when the provider:model split fails.
 */

import { completeSimple, type AssistantMessage } from "@mariozechner/pi-ai";

import { loadConfig } from "../config/config.js";
import { getApiKeyForModel, requireApiKey } from "../agents/model-auth.js";
import { resolveModel } from "../agents/pi-embedded-runner/model.js";
import type { CampaignContext } from "../campaigns/types.js";

export interface GenerateOpts {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  temperature: number;
  maxTokens: number;
  /** ms — AbortController fires after this and the call rejects. */
  timeoutMs?: number;
  /**
   * Optional outreach-campaign context. Carries business + products +
   * audience + funnel + goal for the lead this doc is being generated
   * for, so the AI can produce on-brand, on-message output.
   *
   * TODO(campaigns): When set, fold campaign details into the system
   * prompt (or as a structured block prepended to the user prompt).
   * The plumbing is here; the prompt assembly belongs in
   * `src/discovery/prompt.ts` so token resolution stays in one place.
   */
  campaignContext?: CampaignContext;
}

export interface GenerateResult {
  text: string;
  modelId: string;
  finishReason?: string;
}

export async function generateDocument(opts: GenerateOpts): Promise<GenerateResult> {
  const [provider, modelName] = splitModelId(opts.model);
  if (!provider || !modelName) {
    throw new Error(`Invalid model id "${opts.model}" — expected "<provider>:<model>" form.`);
  }
  const cfg = loadConfig();
  const resolved = resolveModel(provider, modelName, undefined, cfg);
  if (!resolved.model) {
    throw new Error(resolved.error ?? `Unknown model: ${provider}/${modelName}`);
  }
  const apiKey = requireApiKey(await getApiKeyForModel({ model: resolved.model, cfg }), provider);

  const controller = new AbortController();
  const timer = opts.timeoutMs ? setTimeout(() => controller.abort(), opts.timeoutMs) : null;

  try {
    const res = (await completeSimple(
      resolved.model,
      {
        systemPrompt: opts.systemPrompt,
        messages: [
          {
            role: "user",
            content: opts.userPrompt,
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey,
        maxTokens: opts.maxTokens,
        temperature: opts.temperature,
        signal: controller.signal,
      },
    )) as AssistantMessage;

    const text = extractText(res);
    return {
      text,
      modelId: `${provider}:${modelName}`,
      finishReason: (res as unknown as { stop_reason?: string }).stop_reason,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function splitModelId(s: string): [string | null, string | null] {
  const idx = s.indexOf(":");
  if (idx <= 0) return [null, null];
  return [s.slice(0, idx).trim(), s.slice(idx + 1).trim()];
}

function extractText(msg: AssistantMessage): string {
  const parts: string[] = [];
  for (const block of msg.content) {
    // The AssistantMessage content union includes text blocks plus
    // tool calls and other variants — we only want text.
    if ((block as { type?: string }).type === "text") {
      const t = (block as { text?: string }).text;
      if (typeof t === "string") parts.push(t);
    }
  }
  return parts.join("\n").trim();
}
