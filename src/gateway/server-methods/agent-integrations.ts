/**
 * Agent integration RPCs — per-agent Telegram bot token management.
 *
 * The raw token is never written to config: it's encrypted into the agent
 * secret store and the agent config only keeps a `telegramBotTokenRef` pointer.
 * The default/fallback coder backend fields are plain config and go through the
 * normal config.patch path from the UI — they need no dedicated handler here.
 */

import { loadConfig, writeConfigFile } from "../../config/config.js";
import type { InfinibotConfig } from "../../config/config.js";
import type { AgentConfig } from "../../config/types.agents.js";
import {
  agentSecretRef,
  deleteAgentSecret,
  hasAgentSecret,
  setAgentSecret,
  TELEGRAM_BOT_TOKEN_KEY,
} from "../../agents/agent-secret-store.js";
import {
  globalCoderBackendId,
  resolveAgentTelegramToken,
} from "../../agents/agent-integration-config.js";
import { CODER_BACKEND_IDS, type CoderBackendId } from "../../agents/coder-backend/types.js";
import { dayPlannerTelegramTarget } from "../../infra/day-planner-seam.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { sendMessageTelegram } from "../../telegram/send.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { GatewayRequestHandlers } from "./types.js";

const log = createSubsystemLogger("agent-integrations");

function readAgentId(params: Record<string, unknown>): string {
  const raw = typeof params.agentId === "string" ? params.agentId.trim() : "";
  if (!raw) throw new Error("agentId is required");
  return normalizeAgentId(raw);
}

/** Apply a mutation to an agent's config entry, creating it when absent. */
async function patchAgentEntry(
  agentId: string,
  mutate: (entry: AgentConfig) => AgentConfig,
): Promise<void> {
  const cfg = loadConfig();
  const list = Array.isArray(cfg.agents?.list) ? [...(cfg.agents?.list ?? [])] : [];
  const index = list.findIndex((entry) => entry && normalizeAgentId(entry.id) === agentId);
  const base: AgentConfig = index >= 0 ? list[index] : { id: agentId };
  const next = mutate({ ...base });
  if (index >= 0) list[index] = next;
  else list.push(next);
  const nextConfig: InfinibotConfig = {
    ...cfg,
    agents: { ...cfg.agents, list },
  };
  await writeConfigFile(nextConfig);
}

/** Resolve the chat id to send a test message to. */
function resolveTestChatId(cfg: InfinibotConfig, explicit?: string): string {
  const fromParam = explicit?.trim();
  if (fromParam) return fromParam;
  const fromConfig = cfg.channels?.telegram?.defaultChatId?.trim();
  if (fromConfig) return fromConfig;
  // Discipline plugin (when enabled) keeps a notification chat id too.
  const fromDiscipline = dayPlannerTelegramTarget()?.chatId?.trim();
  if (fromDiscipline) return fromDiscipline;
  return "";
}

export const agentIntegrationHandlers: GatewayRequestHandlers = {
  /** Encrypt + store an agent's Telegram bot token; save a ref on its config. */
  "agents.telegramToken.set": async ({ params, respond }) => {
    try {
      const agentId = readAgentId(params);
      const token = typeof params.token === "string" ? params.token.trim() : "";
      if (!token) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "token is required" });
        return;
      }
      const ref = agentSecretRef(agentId, TELEGRAM_BOT_TOKEN_KEY);
      setAgentSecret(ref, token);
      await patchAgentEntry(agentId, (entry) => ({ ...entry, telegramBotTokenRef: ref }));
      log.info("stored agent telegram token", { agentId });
      respond(true, { ref, isSet: true });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: (err as Error).message });
    }
  },

  /** Delete an agent's stored token and remove the config ref. */
  "agents.telegramToken.clear": async ({ params, respond }) => {
    try {
      const agentId = readAgentId(params);
      const ref = agentSecretRef(agentId, TELEGRAM_BOT_TOKEN_KEY);
      deleteAgentSecret(ref);
      await patchAgentEntry(agentId, (entry) => {
        const next = { ...entry };
        delete next.telegramBotTokenRef;
        return next;
      });
      log.info("cleared agent telegram token", { agentId });
      respond(true, { isSet: false });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: (err as Error).message });
    }
  },

  /** Report whether an agent has its own token set (without exposing it). */
  "agents.telegramToken.status": async ({ params, respond }) => {
    try {
      const agentId = readAgentId(params);
      const ref = agentSecretRef(agentId, TELEGRAM_BOT_TOKEN_KEY);
      const cfg = loadConfig();
      const resolved = resolveAgentTelegramToken(cfg, agentId);
      respond(true, {
        isSet: hasAgentSecret(ref),
        // Whether a token would resolve at all (agent or global) — drives UI hints.
        hasEffectiveToken: resolved.source !== "none",
        source: resolved.source,
      });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: (err as Error).message });
    }
  },

  /** Send a test Telegram message using the agent's token (or global fallback). */
  "agents.telegramToken.test": async ({ params, respond }) => {
    try {
      const agentId = readAgentId(params);
      const cfg = loadConfig();
      const { token, source } = resolveAgentTelegramToken(cfg, agentId);
      if (!token) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "No token resolves for this agent (set an agent token or a global one).",
        });
        return;
      }
      const chatId = resolveTestChatId(
        cfg,
        typeof params.chatId === "string" ? params.chatId : undefined,
      );
      if (!chatId) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message:
            "No chat id configured. Set channels.telegram.defaultChatId or pass chatId, or enable Telegram in the discipline settings.",
        });
        return;
      }
      const text = `✅ InfiniBot test — agent \`${agentId}\` (token source: ${source}).`;
      const res = await sendMessageTelegram(chatId, text, { token, textMode: "markdown" });
      log.info("sent agent telegram test", { agentId, source, chatId });
      respond(true, { ok: true, source, chatId, messageId: res.messageId });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: (err as Error).message });
    }
  },

  /**
   * Snapshot of an agent's integration settings for the UI: backend overrides,
   * the global default backend, and whether a per-agent Telegram token is set
   * (the raw token is never returned).
   */
  "agents.integrations.get": async ({ params, respond }) => {
    try {
      const agentId = readAgentId(params);
      const cfg = loadConfig();
      const entry = cfg.agents?.list?.find((e) => e && normalizeAgentId(e.id) === agentId);
      const ref = agentSecretRef(agentId, TELEGRAM_BOT_TOKEN_KEY);
      const resolved = resolveAgentTelegramToken(cfg, agentId);
      respond(true, {
        defaultCoderBackend: entry?.defaultCoderBackend ?? null,
        fallbackCoderBackend: entry?.fallbackCoderBackend ?? null,
        globalCoderBackend: globalCoderBackendId(cfg),
        telegramTokenSet: hasAgentSecret(ref),
        telegramTokenSource: resolved.source,
      });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: (err as Error).message });
    }
  },

  /**
   * Persist an agent's default/fallback coder backend. Pass null/empty for a
   * field to clear it (revert to the global default / no fallback).
   */
  "agents.backends.set": async ({ params, respond }) => {
    try {
      const agentId = readAgentId(params);
      const valid: ReadonlyArray<CoderBackendId> = CODER_BACKEND_IDS;
      const parse = (key: string): CoderBackendId | null | undefined => {
        if (!(key in params)) return undefined; // absent → leave unchanged
        const raw = params[key];
        if (raw === null || raw === "") return null; // explicit clear
        if (typeof raw === "string" && (valid as readonly string[]).includes(raw)) {
          return raw as CoderBackendId;
        }
        throw new Error(`invalid ${key}: ${String(raw)}`);
      };
      const nextDefault = parse("defaultCoderBackend");
      const nextFallback = parse("fallbackCoderBackend");
      await patchAgentEntry(agentId, (entry) => {
        const next = { ...entry };
        if (nextDefault !== undefined) {
          if (nextDefault === null) delete next.defaultCoderBackend;
          else next.defaultCoderBackend = nextDefault;
        }
        if (nextFallback !== undefined) {
          if (nextFallback === null) delete next.fallbackCoderBackend;
          else next.fallbackCoderBackend = nextFallback;
        }
        return next;
      });
      log.info("updated agent coder backends", { agentId, nextDefault, nextFallback });
      respond(true, {
        defaultCoderBackend: nextDefault ?? null,
        fallbackCoderBackend: nextFallback ?? null,
      });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: (err as Error).message });
    }
  },
};
