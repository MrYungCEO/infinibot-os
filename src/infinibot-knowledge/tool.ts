/**
 * Agent tools: `infinibot_help` (product knowledge + live diagnosis +
 * navigation hint) and `infinibot_state` (the redacted live state).
 * Registered in src/agents/infinibot-tools.ts; reaches MCP clients through the
 * normal agent tool list.
 */

import { Type } from "@sinclair/typebox";

import { type AnyAgentTool, jsonResult } from "../agents/tools/common.js";
import { answerHelp } from "./help.js";
import { getInfinibotState, type InfinibotState } from "./live-state.js";
import { getKnowledgeBase } from "./runtime.js";
import { detectUiControlCaps, loadUiTargets, type UiControlCaps } from "./targets.js";

export type HelpToolOptions = {
  /** Live tool list of the agent (lazy: tools are assembled after this one). */
  tools?: () => Array<{ name: string; description?: string; parameters?: unknown }>;
};

function caps(opts: HelpToolOptions): UiControlCaps {
  const ui = opts.tools?.().find((t) => t.name === "ui_control");
  return detectUiControlCaps(ui?.parameters);
}

async function stateOrNull(): Promise<InfinibotState | null> {
  try {
    return await Promise.race([
      getInfinibotState(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 8_000).unref?.()),
    ]);
  } catch {
    return null;
  }
}

export function createInfinibotHelpTool(opts: HelpToolOptions = {}): AnyAgentTool {
  return {
    label: "InfiniBot help",
    name: "infinibot_help",
    description: [
      "Expert answers about InfiniBot ITSELF — every page, sub-tab, setting, plugin, setup flow and agent tool as it exists right now — combined with the user's LIVE state (which plugins are on, Solatrix agent access, setup checks, connected channels, coders, voice, cloud/local).",
      'Call it BEFORE answering any where/how/why question about InfiniBot ("where do I add an API key", "how do I connect Gmail", "enable Solatrix", "why can\'t you read my wallet", "turn on Telegram approvals") and whenever a tool says something is off or unavailable.',
      "Returns: diagnosis (facts — say them first), place.breadcrumb (the exact UI path — use it verbatim, never invent one), steps, navigate.call (the exact ui_control call that opens the place) and suggestedAction.",
      'For "navigate there" / "open it" pass the question plus `context` = your previous reply; then call ui_control with navigate.call immediately.',
    ].join(" "),
    parameters: Type.Object({
      question: Type.String({ description: "The user's question in their words." }),
      context: Type.Optional(
        Type.String({
          description:
            "Recent conversation (e.g. your previous reply) — resolves 'navigate there' / 'open it'.",
        }),
      ),
      includeState: Type.Optional(
        Type.Boolean({ description: "Include live state (default true)." }),
      ),
    }),
    execute: async (_id, args) => {
      const p = (args ?? {}) as { question?: string; context?: string; includeState?: boolean };
      const question = String(p.question ?? "").trim();
      if (!question) return jsonResult({ ok: false, error: "question is required" });
      const kb = getKnowledgeBase();
      const state = p.includeState === false ? null : await stateOrNull();
      const answer = answerHelp(
        { question, context: p.context },
        { kb, state, caps: caps(opts), registry: loadUiTargets(), tools: opts.tools?.() },
      );
      return jsonResult(answer);
    },
  };
}

export function createInfinibotStateTool(): AnyAgentTool {
  return {
    label: "InfiniBot state",
    name: "infinibot_state",
    description:
      "The user's LIVE InfiniBot state (redacted, cached 20s): deployment (cloud/local), plugins (enabled/loaded/errors), setup checks that aren't ready, model provider, connected channels, Telegram approvals, voice, installed coders, Solatrix agent access/permissions/wallet count/RPC, and the main agent's tool allowlist. Read-only; contains no secrets.",
    parameters: Type.Object({
      refresh: Type.Optional(Type.Boolean({ description: "Bypass the 20s cache." })),
    }),
    execute: async (_id, args) => {
      const refresh = Boolean((args as { refresh?: boolean } | undefined)?.refresh);
      try {
        return jsonResult({ ok: true, state: await getInfinibotState({ force: refresh }) });
      } catch (err) {
        return jsonResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}
