import { type RunOptions, run } from "@grammyjs/runner";
import type { InfinibotConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { resolveAgentMaxConcurrent } from "../config/agent-limits.js";
import { computeBackoff, sleepWithAbort } from "../infra/backoff.js";
import { formatErrorMessage } from "../infra/errors.js";
import { formatDurationMs } from "../infra/format-duration.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveTelegramAccount } from "./accounts.js";
import { resolveTelegramAllowedUpdates } from "./allowed-updates.js";
import { createTelegramBot } from "./bot.js";
import { isRecoverableTelegramNetworkError } from "./network-errors.js";
import { makeProxyFetch } from "./proxy.js";
import { readTelegramUpdateOffset, writeTelegramUpdateOffset } from "./update-offset-store.js";
import { startTelegramWebhook } from "./webhook.js";
import { markTelegramChannelLive } from "./setup/index.js";

export type MonitorTelegramOpts = {
  token?: string;
  accountId?: string;
  config?: InfinibotConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  useWebhook?: boolean;
  webhookPath?: string;
  webhookPort?: number;
  webhookSecret?: string;
  proxyFetch?: typeof fetch;
  webhookUrl?: string;
};

export function createTelegramRunnerOptions(cfg: InfinibotConfig): RunOptions<unknown> {
  return {
    sink: {
      concurrency: resolveAgentMaxConcurrent(cfg),
    },
    runner: {
      fetch: {
        // Match grammY defaults
        timeout: 30,
        // Request reactions without dropping default update types.
        allowed_updates: resolveTelegramAllowedUpdates(),
      },
      // Suppress grammY getUpdates stack traces; we log concise errors ourselves.
      silent: true,
      // Retry transient failures for a limited window before surfacing errors.
      maxRetryTime: 5 * 60 * 1000,
      retryInterval: "exponential",
    },
  };
}

const TELEGRAM_POLL_RESTART_POLICY = {
  initialMs: 2000,
  maxMs: 30_000,
  factor: 1.8,
  jitter: 0.25,
};

const isGetUpdatesConflict = (err: unknown) => {
  if (!err || typeof err !== "object") return false;
  const typed = err as {
    error_code?: number;
    errorCode?: number;
    description?: string;
    method?: string;
    message?: string;
  };
  const errorCode = typed.error_code ?? typed.errorCode;
  if (errorCode !== 409) return false;
  const haystack = [typed.method, typed.description, typed.message]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  return haystack.includes("getupdates");
};

export async function monitorTelegramProvider(opts: MonitorTelegramOpts = {}) {
  const cfg = opts.config ?? loadConfig();
  const account = resolveTelegramAccount({
    cfg,
    accountId: opts.accountId,
  });
  const token = opts.token?.trim() || account.token;
  if (!token) {
    throw new Error(
      `Telegram bot token missing for account "${account.accountId}" (set channels.telegram.accounts.${account.accountId}.botToken/tokenFile or TELEGRAM_BOT_TOKEN for default).`,
    );
  }

  const proxyFetch =
    opts.proxyFetch ??
    (account.config.proxy ? makeProxyFetch(account.config.proxy as string) : undefined);

  let lastUpdateId = await readTelegramUpdateOffset({
    accountId: account.accountId,
  });
  const persistUpdateId = async (updateId: number) => {
    if (lastUpdateId !== null && updateId <= lastUpdateId) return;
    lastUpdateId = updateId;
    try {
      await writeTelegramUpdateOffset({
        accountId: account.accountId,
        updateId,
      });
    } catch (err) {
      (opts.runtime?.error ?? console.error)(
        `telegram: failed to persist update offset: ${String(err)}`,
      );
    }
  };

  const bot = createTelegramBot({
    token,
    runtime: opts.runtime,
    proxyFetch,
    config: cfg,
    accountId: account.accountId,
    updateOffset: {
      lastUpdateId,
      onUpdateId: persistUpdateId,
    },
  });

  // Approval cards (src/approvals/telegram-approvals.ts) send + edit through
  // the running bot so they share its throttler / proxy settings.
  {
    const { registerApprovalTelegramApi } = await import("../approvals/telegram-approvals.js");
    const unregister = registerApprovalTelegramApi(account.accountId, bot.api);
    opts.abortSignal?.addEventListener("abort", unregister, { once: true });
  }

  // Guided setup: while this channel consumes the bot's updates, a setup session
  // for the same bot listens through the running bot instead of polling itself.
  const releaseLive = markTelegramChannelLive(token);
  opts.abortSignal?.addEventListener("abort", releaseLive, { once: true });

  if (opts.useWebhook) {
    await startTelegramWebhook({
      token,
      accountId: account.accountId,
      config: cfg,
      path: opts.webhookPath,
      // Hosted tenant Machines run the listener on loopback behind the edge
      // (deploy/fly/gateway/edge.mjs routes /telegram-webhook to it).
      port: opts.webhookPort ?? envPort(process.env.INFINIBOT_TELEGRAM_WEBHOOK_PORT),
      host: process.env.INFINIBOT_TELEGRAM_WEBHOOK_HOST?.trim() || undefined,
      secret: opts.webhookSecret,
      runtime: opts.runtime as RuntimeEnv,
      fetch: proxyFetch,
      abortSignal: opts.abortSignal,
      publicUrl: opts.webhookUrl,
    });
    return;
  }

  // Hosted tenant that moved from a wake plan (webhook) to an always-on plan
  // (polling): getUpdates 409s while the old webhook is still registered.
  if (process.env.FLEET_TENANT_ID?.trim()) {
    await bot.api.deleteWebhook().catch((err: unknown) => {
      (opts.runtime?.error ?? console.error)(
        `telegram: deleteWebhook before polling failed: ${String(err)}`,
      );
    });
  }

  // Use grammyjs/runner for concurrent update processing
  let restartAttempts = 0;

  while (!opts.abortSignal?.aborted) {
    const runner = run(bot, createTelegramRunnerOptions(cfg));
    const stopOnAbort = () => {
      if (opts.abortSignal?.aborted) {
        void runner.stop();
      }
    };
    opts.abortSignal?.addEventListener("abort", stopOnAbort, { once: true });
    try {
      // runner.task() returns a promise that resolves when the runner stops
      await runner.task();
      releaseLive();
      return;
    } catch (err) {
      if (opts.abortSignal?.aborted) {
        releaseLive();
        throw err;
      }
      const isConflict = isGetUpdatesConflict(err);
      const isRecoverable = isRecoverableTelegramNetworkError(err, { context: "polling" });
      if (!isConflict && !isRecoverable) {
        releaseLive();
        throw err;
      }
      restartAttempts += 1;
      const delayMs = computeBackoff(TELEGRAM_POLL_RESTART_POLICY, restartAttempts);
      const reason = isConflict ? "getUpdates conflict" : "network error";
      const errMsg = formatErrorMessage(err);
      (opts.runtime?.error ?? console.error)(
        `Telegram ${reason}: ${errMsg}; retrying in ${formatDurationMs(delayMs)}.`,
      );
      try {
        await sleepWithAbort(delayMs, opts.abortSignal);
      } catch (sleepErr) {
        if (opts.abortSignal?.aborted) return;
        throw sleepErr;
      }
    } finally {
      opts.abortSignal?.removeEventListener("abort", stopOnAbort);
    }
  }
}

function envPort(raw: string | undefined): number | undefined {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : undefined;
}
