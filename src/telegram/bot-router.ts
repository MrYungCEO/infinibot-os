/**
 * TelegramBotRouter — per-agent Telegram bot multiplexer.
 *
 * At gateway startup this module reads `agents.list[].telegramBot` from the
 * live config.  For every agent that has a `botToken` configured it:
 *   1. Registers the token in the per-agent registry (so outbound replies use it).
 *   2. Builds a synthetic config that injects the account + binding so the
 *      existing grammy-based monitor routes inbound messages to the correct agent.
 *   3. Starts an independent long-poll loop via `monitorTelegramProvider`.
 *
 * The main Telegram account (channels.telegram.botToken) is managed separately by
 * the normal channel manager — this router only handles per-agent extras.
 *
 * AccountId convention: "agent-<agentId>" (e.g. agent "coder" → "agent-coder").
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import type { InfinibotConfig } from "../config/config.js";
import type { AgentConfig } from "../config/types.agents.js";
import type { RuntimeEnv } from "../runtime.js";
import { computeBackoff, sleepWithAbort } from "../infra/backoff.js";
import { monitorTelegramProvider } from "./monitor.js";
import { registerPerAgentBotToken } from "./per-agent-token-registry.js";

const log = createSubsystemLogger("telegram/bot-router");

/** Prefix applied to Telegram accountIds for per-agent bots. */
const ACCOUNT_PREFIX = "agent-";

function agentAccountId(agentId: string): string {
  return `${ACCOUNT_PREFIX}${agentId}`;
}

type AgentBotEntry = {
  agentId: string;
  accountId: string;
  botToken: string;
  botUsername?: string;
  allowFrom?: Array<string | number>;
};

function collectAgentBotEntries(cfg: InfinibotConfig): AgentBotEntry[] {
  const agents = cfg.agents?.list;
  if (!Array.isArray(agents)) return [];
  const entries: AgentBotEntry[] = [];
  for (const agent of agents) {
    if (!agent || typeof agent !== "object") continue;
    const a = agent as AgentConfig;
    const botToken = a.telegramBot?.botToken?.trim();
    if (!botToken) continue;
    entries.push({
      agentId: a.id,
      accountId: agentAccountId(a.id),
      botToken,
      botUsername: a.telegramBot?.botUsername?.trim() || undefined,
      allowFrom: a.telegramBot?.allowFrom,
    });
  }
  return entries;
}

/**
 * Build a synthetic InfinibotConfig that augments the real config with:
 *  - channels.telegram.accounts[accountId] = { botToken, allowFrom }
 *  - bindings entry: { match: {channel:"telegram", accountId}, agentId }
 *
 * The existing monitorTelegramProvider + resolveAgentRoute pipeline then routes
 * inbound messages to the correct agent without any code changes.
 */
function buildSyntheticConfig(baseCfg: InfinibotConfig, entry: AgentBotEntry): InfinibotConfig {
  const existingAccounts =
    (baseCfg.channels?.telegram as Record<string, unknown> | undefined)?.accounts ?? {};
  const existingBindings = Array.isArray(baseCfg.bindings) ? baseCfg.bindings : [];

  // Inherit main allowFrom if no per-agent override.
  const allowFrom =
    entry.allowFrom ??
    (baseCfg.channels?.telegram as { allowFrom?: Array<string | number> } | undefined)?.allowFrom;

  return {
    ...baseCfg,
    channels: {
      ...baseCfg.channels,
      telegram: {
        ...baseCfg.channels?.telegram,
        accounts: {
          ...(existingAccounts as Record<string, unknown>),
          [entry.accountId]: {
            botToken: entry.botToken,
            ...(allowFrom?.length ? { allowFrom } : {}),
          },
        },
      },
    },
    bindings: [
      ...existingBindings,
      {
        match: { channel: "telegram", accountId: entry.accountId },
        agentId: entry.agentId,
      },
    ],
  } as InfinibotConfig;
}

const RESTART_POLICY = {
  initialMs: 3_000,
  maxMs: 60_000,
  factor: 2,
  jitter: 0.2,
};

export class TelegramBotRouter {
  private aborts = new Map<string, AbortController>();
  private tasks = new Map<string, Promise<void>>();

  /** Starts a poll loop for each agent with a telegramBot.botToken configured. */
  start(params: { cfg: InfinibotConfig; runtime?: RuntimeEnv; abortSignal?: AbortSignal }): void {
    const entries = collectAgentBotEntries(params.cfg);
    if (entries.length === 0) {
      log.info?.("no per-agent telegram bots configured — router idle");
      return;
    }
    log.info?.(`starting ${entries.length} per-agent telegram bot(s)`);
    for (const entry of entries) {
      this.startEntry(entry, params);
    }
  }

  private startEntry(
    entry: AgentBotEntry,
    params: { cfg: InfinibotConfig; runtime?: RuntimeEnv; abortSignal?: AbortSignal },
  ): void {
    // Register token in the per-agent registry so outbound replies work.
    registerPerAgentBotToken(entry.accountId, entry.botToken, entry.botUsername);

    const abort = new AbortController();
    // Link to the parent abort signal if provided.
    const onParentAbort = () => abort.abort();
    params.abortSignal?.addEventListener("abort", onParentAbort, { once: true });
    this.aborts.set(entry.agentId, abort);

    const syntheticCfg = buildSyntheticConfig(params.cfg, entry);

    const task = this.runWithRestart(entry, syntheticCfg, params.runtime, abort.signal)
      .catch((err) => {
        log.error?.(`[${entry.agentId}] fatal error: ${String(err)}`);
      })
      .finally(() => {
        this.aborts.delete(entry.agentId);
        this.tasks.delete(entry.agentId);
        params.abortSignal?.removeEventListener("abort", onParentAbort);
      });

    this.tasks.set(entry.agentId, task);
    log.info?.(
      `[${entry.agentId}] bot @${entry.botUsername ?? "(unnamed)"} started (account: ${entry.accountId})`,
    );
  }

  private async runWithRestart(
    entry: AgentBotEntry,
    syntheticCfg: InfinibotConfig,
    runtime: RuntimeEnv | undefined,
    abortSignal: AbortSignal,
  ): Promise<void> {
    let attempts = 0;
    while (!abortSignal.aborted) {
      try {
        await monitorTelegramProvider({
          config: syntheticCfg,
          accountId: entry.accountId,
          runtime,
          abortSignal,
        });
        // Clean exit (abort signalled) — stop looping.
        break;
      } catch (err) {
        if (abortSignal.aborted) break;
        attempts++;
        const delay = computeBackoff(RESTART_POLICY, attempts);
        log.warn?.(
          `[${entry.agentId}] poll error (attempt ${attempts}): ${String(err)} — retry in ${delay}ms`,
        );
        await sleepWithAbort(delay, abortSignal);
      }
    }
  }

  /** Abort all per-agent bot loops. */
  stop(): void {
    for (const [agentId, abort] of this.aborts.entries()) {
      log.info?.(`[${agentId}] stopping`);
      abort.abort();
    }
    this.aborts.clear();
  }

  /** Wait for all loops to finish (use after stop()). */
  async waitStopped(): Promise<void> {
    await Promise.allSettled(this.tasks.values());
    this.tasks.clear();
  }
}

/** Singleton used by server-startup. */
export const telegramBotRouter = new TelegramBotRouter();
