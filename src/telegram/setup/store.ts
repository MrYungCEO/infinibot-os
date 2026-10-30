/**
 * Where a finished guided setup is saved.
 *
 * Local / self-hosted (and the SaaS operator): the gateway config,
 * `channels.telegram`. A hosted member workspace must never write the shared
 * gateway config; the cloud build registers a tenant-owned store with
 * registerTelegramSetupStore(), and until one is registered a member tenant
 * gets no store at all (the setup refuses to save).
 */
import type { InfinibotConfig } from "../../config/config.js";
import { loadConfig, writeConfigFile } from "../../config/config.js";
import { DEFAULT_USER_ID, getCurrentUserId } from "../../config/paths.js";
import { isSaasMode } from "../../saas/config.js";
import { resolveTelegramToken } from "../token.js";
import { ensureAuthProfileStore, saveAuthProfileStore } from "../../agents/auth-profiles.js";
import { clearAuthProfileEnv } from "../../agents/auth-profiles/env-export.js";
import { applyTelegramSetupToConfig, type TelegramSetupFill } from "./config-fill.js";

export interface TelegramSetupSaved {
  token: string | null;
  tokenSource: string;
  owners: string[];
  defaultChatId: string | null;
  groups: string[];
  /** Webhook mode (hosted wake-on-message Machines) instead of long-polling. */
  webhook: boolean;
}

export interface TelegramSetupStore {
  kind: "config" | "tenant";
  /**
   * Saving here drives this gateway's Telegram channel (start / stop it).
   * False for a member workspace on a shared gateway: its bot is saved for its
   * own hosted Machine and the operator's channel must never be touched.
   */
  controlsChannel: boolean;
  /** Shown on the summary card when the saved bot isn't run by this gateway. */
  note?: string;
  read(): TelegramSetupSaved;
  apply(fill: TelegramSetupFill): Promise<void>;
  /** Forget the token (the channel is stopped by the caller). */
  clear(): Promise<void>;
}

export function summarizeTelegramSection(
  cfg: InfinibotConfig,
): Omit<TelegramSetupSaved, "token" | "tokenSource"> {
  const tg = cfg.channels?.telegram;
  return {
    owners: (tg?.allowFrom ?? []).map((v) => String(v).trim()).filter((v) => v && v !== "*"),
    defaultChatId: tg?.defaultChatId?.toString().trim() || null,
    groups: Object.keys(tg?.groups ?? {}).filter((k) => k !== "*"),
    webhook: Boolean(tg?.webhookUrl),
  };
}

/**
 * The gateway mirrors `channels.telegram.botToken` into the auth-profile store at
 * boot and exports it as TELEGRAM_BOT_TOKEN (auth-profiles/migrate-from-config,
 * env-export). Keep that copy in step: a new token replaces it, a disconnect
 * removes it. Otherwise the old bot would come back from the mirror.
 * An operator-set TELEGRAM_BOT_TOKEN (shell / service unit) is left alone.
 */
function syncMirroredToken(next: string | null): void {
  try {
    const store = ensureAuthProfileStore();
    const ids = Object.entries(store.profiles ?? {})
      .filter(([, p]) => p?.provider === "telegram")
      .map(([id]) => id);
    if (ids.length === 0) return;
    const mirrored = ids
      .map((id) => store.profiles[id] as { token?: string; key?: string })
      .map((p) => p.token ?? p.key)
      .filter(Boolean);
    const envWasMirror = mirrored.includes(process.env.TELEGRAM_BOT_TOKEN);
    for (const id of ids) {
      if (next) {
        const profile = store.profiles[id] as { type?: string; token?: string; key?: string };
        if (profile.type === "token") profile.token = next;
        else profile.key = next;
      } else {
        delete store.profiles[id];
      }
    }
    saveAuthProfileStore(store);
    if (envWasMirror) {
      if (next) process.env.TELEGRAM_BOT_TOKEN = next;
      else clearAuthProfileEnv("telegram", store);
    }
  } catch {
    // No auth-profile store here: nothing mirrored, nothing to sync.
  }
}

export const configTelegramSetupStore: TelegramSetupStore = {
  kind: "config",
  controlsChannel: true,
  read() {
    const cfg = loadConfig();
    const resolved = resolveTelegramToken(cfg);
    return {
      token: resolved.token || null,
      tokenSource: resolved.source,
      ...summarizeTelegramSection(cfg),
    };
  },
  async apply(fill) {
    await writeConfigFile(applyTelegramSetupToConfig(loadConfig(), fill));
    if (fill.token) syncMirroredToken(fill.token);
  },
  async clear() {
    const cfg = loadConfig();
    const tg = { ...cfg.channels?.telegram };
    delete tg.botToken;
    delete tg.tokenFile;
    tg.enabled = false;
    await writeConfigFile({ ...cfg, channels: { ...cfg.channels, telegram: tg } });
    syncMirroredToken(null);
  },
};

type StoreResolver = () => TelegramSetupStore | null | undefined;
let tenantResolver: StoreResolver | null = null;

/** Cloud build: provide the tenant-owned store for the current request scope. */
export function registerTelegramSetupStore(resolver: StoreResolver | null): void {
  tenantResolver = resolver;
}

export function isMemberTenantScope(): boolean {
  if (!isSaasMode()) return false;
  const id = getCurrentUserId();
  return Boolean(id) && id !== DEFAULT_USER_ID;
}

/** The store for the current request scope, or null when saving isn't allowed here. */
export function resolveTelegramSetupStore(): TelegramSetupStore | null {
  const tenant = tenantResolver?.();
  if (tenant) return tenant;
  if (isMemberTenantScope()) return null;
  return configTelegramSetupStore;
}

/** Session scope key: one per tenant namespace (a single "default" off SaaS). */
export function telegramSetupScope(): string {
  return getCurrentUserId() || DEFAULT_USER_ID;
}
