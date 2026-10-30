/**
 * Guided Telegram setup: the process-wide session manager and the two hooks the
 * running channel calls (markTelegramChannelLive / offerTelegramSetupUpdate).
 */
import { loadConfig } from "../../config/config.js";
import { createGrammySetupApi } from "./bot-api.js";
import { TelegramSetupManager } from "./sessions.js";

let manager: TelegramSetupManager | null = null;

function createApi(token: string) {
  let tg: { proxy?: string; network?: unknown } | undefined;
  try {
    tg = loadConfig().channels?.telegram;
  } catch {
    tg = undefined;
  }
  return createGrammySetupApi(token, { proxy: tg?.proxy, network: tg?.network as never });
}

export function getTelegramSetupManager(): TelegramSetupManager {
  if (!manager) manager = new TelegramSetupManager({ createApi });
  return manager;
}

/** getMe for a saved token (the summary card's bot name). */
export function lookupTelegramBot(token: string) {
  return createApi(token).getMe();
}

/** Tests only. */
export function setTelegramSetupManagerForTest(next: TelegramSetupManager | null): void {
  manager?.dispose();
  manager = next;
}

/** The channel is consuming updates for `token`; call the result when it stops. */
export function markTelegramChannelLive(token: string): () => void {
  return getTelegramSetupManager().markLive(token);
}

/** True when a waiting setup session claimed this update (don't process it further). */
export function offerTelegramSetupUpdate(token: string, update: unknown): boolean {
  return manager ? manager.offerUpdate(token, update) : false;
}

export * from "./sessions.js";
export * from "./errors.js";
export * from "./token-format.js";
export * from "./start-code.js";
export * from "./config-fill.js";
export type { SetupBotApi, SetupBotApiFactory, SetupBotInfo } from "./bot-api.js";
