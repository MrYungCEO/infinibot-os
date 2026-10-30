/**
 * Core setup checks for the "needs setup" registry (registry.ts).
 *
 * Only things that are OBJECTIVELY missing get `needs-setup` — the page can't
 * do its job until the user acts. "Nice to have" connections are `optional`
 * (the UI shows a quiet dismissible hint). Every check is cheap: config and
 * local stores only, no process spawns, no network. Stores are imported lazily
 * so this module stays light and cycle-free.
 */

import { loadConfig } from "../../config/config.js";
import { setCoreSetupChecks } from "./registry.js";
import type { SetupCheckDefinition, SetupCheckOutcome } from "./types.js";

const READY: SetupCheckOutcome = { state: "ready" };

function cfgOrEmpty(): ReturnType<typeof loadConfig> | Record<string, never> {
  try {
    return loadConfig();
  } catch {
    return {};
  }
}

function isLocalUrl(url: unknown): boolean {
  if (typeof url !== "string" || !url) return false;
  try {
    const host = new URL(url).hostname;
    return (
      host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local")
    );
  } catch {
    return false;
  }
}

// ── Model provider credentials (chat can't work without one) ───────────────

export type ModelCredentialFacts = {
  /** Known LLM provider ids with a stored profile or env key. */
  providersWithAuth: string[];
  /** A custom `models.providers.*` entry has a key or a local base URL. */
  customProvider: boolean;
  /** Primary model runs locally (ollama/…) and local providers are allowed. */
  localPrimary: boolean;
  /** Claude / Codex CLI sign-in found on disk. */
  cliLogin: boolean;
  /** Stored LLM profiles whose last event was an auth failure. */
  rejected: Array<{ provider: string; profileId: string }>;
  /** Stored LLM profiles overall. */
  storedProfiles: number;
};

export function modelCredentialOutcome(f: ModelCredentialFacts): SetupCheckOutcome {
  const working =
    f.providersWithAuth.length > 0 || f.customProvider || f.localPrimary || f.cliLogin;
  if (!working) {
    return {
      state: "needs-setup",
      reason: "No model provider key yet — chat and agents can't answer until you add one.",
    };
  }
  // Every stored key was rejected and nothing else (env, CLI, local) can stand in.
  const onlyStored = !f.customProvider && !f.localPrimary && !f.cliLogin;
  if (onlyStored && f.storedProfiles > 0 && f.rejected.length >= f.storedProfiles) {
    const provider = f.rejected[0]?.provider ?? "provider";
    return {
      state: "error",
      reason: `Your ${provider} key was rejected — replace it so chat can run.`,
      action: { label: "Fix API key", tab: "apikeys" },
    };
  }
  return READY;
}

async function gatherModelCredentialFacts(cloud: boolean): Promise<ModelCredentialFacts> {
  const [{ listModelProviders }, authProfiles, modelAuth] = await Promise.all([
    import("../../agents/known-providers.js"),
    import("../../agents/auth-profiles.js"),
    import("../../agents/model-auth.js"),
  ]);
  const cfg = cfgOrEmpty() as {
    models?: { providers?: Record<string, { apiKey?: string; baseUrl?: string } | undefined> };
    agents?: { defaults?: { model?: { primary?: string } | string } };
  };
  let store: import("../../agents/auth-profiles.js").AuthProfileStore | null = null;
  try {
    store = authProfiles.ensureAuthProfileStore(undefined, { allowKeychainPrompt: false });
  } catch {
    store = null;
  }
  const llmIds = listModelProviders().map((p) => p.id);
  const providersWithAuth: string[] = [];
  const rejected: ModelCredentialFacts["rejected"] = [];
  let storedProfiles = 0;
  for (const id of llmIds) {
    const profiles = store ? authProfiles.listProfilesForProvider(store, id) : [];
    const env = modelAuth.resolveEnvApiKey(id);
    if (profiles.length > 0 || env) providersWithAuth.push(id);
    if (env) continue; // an env key keeps the provider usable regardless of stored ones
    for (const profileId of profiles) {
      storedProfiles += 1;
      const stats = store?.usageStats?.[profileId];
      const authFails = stats?.failureCounts?.auth ?? 0;
      if (authFails > 0 && (stats?.lastFailureAt ?? 0) > (stats?.lastUsed ?? 0)) {
        rejected.push({ provider: id, profileId });
      }
    }
  }
  const customProvider = Object.values(cfg.models?.providers ?? {}).some(
    (p) => Boolean(p?.apiKey?.trim()) || (!cloud && isLocalUrl(p?.baseUrl)),
  );
  const modelCfg = cfg.agents?.defaults?.model;
  const primary = typeof modelCfg === "string" ? modelCfg : (modelCfg?.primary ?? "");
  const localPrimary = !cloud && /^(ollama|lmstudio|llamacpp|vllm)\//.test(primary);
  let cliLogin = false;
  if (!cloud) {
    try {
      const cli = await import("../../agents/cli-credentials.js");
      cliLogin =
        Boolean(
          cli.readClaudeCliCredentialsCached({ allowKeychainPrompt: false, ttlMs: 30_000 }),
        ) || Boolean(cli.readCodexCliCredentialsCached({ ttlMs: 30_000 }));
    } catch {
      cliLogin = false;
    }
  }
  return { providersWithAuth, customProvider, localPrimary, cliLogin, rejected, storedProfiles };
}

// ── Email (Inbox) ──────────────────────────────────────────────────────────

export function inboxOutcome(accounts: number): SetupCheckOutcome {
  return accounts > 0
    ? READY
    : {
        state: "needs-setup",
        reason: "No email account connected — the inbox has nothing to show.",
      };
}

async function countEmailAccounts(): Promise<number> {
  const cfg = cfgOrEmpty() as {
    integrations?: {
      gmail?: { accounts?: unknown[] };
      calendar?: { refreshToken?: string; clientId?: string };
    };
  };
  let n = cfg.integrations?.gmail?.accounts?.length ?? 0;
  // The legacy single Gmail account lives under integrations.calendar.
  if (cfg.integrations?.calendar?.refreshToken && cfg.integrations.calendar.clientId) n += 1;
  if (n > 0) return n;
  try {
    const gmail = await import("../../agents/tools/gmail-tool.js");
    if (gmail.isGmailConfigured()) return 1;
  } catch {
    /* not loaded */
  }
  try {
    const { getEmailAccountsStore } = await import("../../services/email/accounts-store.js");
    return getEmailAccountsStore().list().length;
  } catch {
    return 0;
  }
}

// ── Channels ───────────────────────────────────────────────────────────────

const NON_CHANNEL_KEYS = new Set(["webchat", "web", "defaults"]);

export function channelsOutcome(channels: Record<string, unknown> | undefined): SetupCheckOutcome {
  const configured = Object.entries(channels ?? {}).some(([key, v]) => {
    if (NON_CHANNEL_KEYS.has(key) || !v || typeof v !== "object") return false;
    const c = v as { enabled?: unknown; token?: unknown; botToken?: unknown; accounts?: unknown };
    if (c.enabled === false) return false;
    return (
      c.enabled === true ||
      Boolean(c.token) ||
      Boolean(c.botToken) ||
      (Boolean(c.accounts) &&
        typeof c.accounts === "object" &&
        Object.keys(c.accounts as object).length > 0)
    );
  });
  // Web chat always works, so a messaging channel is optional.
  return configured
    ? READY
    : {
        state: "optional",
        reason:
          "No messaging channel yet — connect Telegram, WhatsApp, Discord or Slack to reach your agents on the go.",
      };
}

// ── Coders ─────────────────────────────────────────────────────────────────

export function codersOutcome(installed: number): SetupCheckOutcome {
  return installed > 0
    ? READY
    : {
        state: "needs-setup",
        reason: "No coding agent installed — code tasks have nothing to run on.",
      };
}

async function countInstalledCoders(): Promise<number | null> {
  const [{ CODER_CATALOG }, installer, bins, paths] = await Promise.all([
    import("../../agents/coder-install/catalog.js"),
    import("../../agents/coder-install/installer.js"),
    import("../../agents/coder-backend/bin-detect.js"),
    import("../../agents/coder-install/paths.js"),
  ]);
  // Installing isn't possible here (shared SaaS process): nothing to set up.
  if (!paths.coderInstallPolicy().allowed) return null;
  return CODER_CATALOG.filter((e) => Boolean(installer.managedBinPath(e) ?? bins.resolveBin(e.bin)))
    .length;
}

// ── Voice ──────────────────────────────────────────────────────────────────

export function voiceOutcome(configured: boolean): SetupCheckOutcome {
  return configured
    ? READY
    : {
        state: "needs-setup",
        reason: "Voice isn't set up — pick speech-to-text and text-to-speech providers.",
      };
}

// ── Calendar (Schedule) ────────────────────────────────────────────────────

export function calendarOutcome(connected: boolean): SetupCheckOutcome {
  // Scheduled jobs work without a calendar, so connecting one is optional.
  return connected
    ? READY
    : {
        state: "optional",
        reason: "No calendar connected — link Google Calendar or Calendly to see events here.",
      };
}

async function calendarConnected(): Promise<boolean> {
  const cfg = cfgOrEmpty() as {
    integrations?: {
      calendar?: { clientId?: string; clientSecret?: string; refreshToken?: string };
    };
  };
  const c = cfg.integrations?.calendar;
  if (c?.clientId && c.clientSecret && c.refreshToken) return true;
  try {
    const { getCalendlyStatus } = await import("../../calendar/calendly.js");
    return (await getCalendlyStatus()).connected;
  } catch {
    return false;
  }
}

// ── Mobile ─────────────────────────────────────────────────────────────────

const MOBILE_PLATFORMS = /^(mobile|ios|ipados|android)/i;

export function mobileOutcome(pairedPhones: number): SetupCheckOutcome {
  return pairedPhones > 0
    ? READY
    : { state: "optional", reason: "No phone paired — install the app and scan the pairing code." };
}

async function countPairedPhones(): Promise<number> {
  try {
    const { listDevicePairing } = await import("../../infra/device-pairing.js");
    const { paired } = await listDevicePairing();
    return paired.filter((d) =>
      MOBILE_PLATFORMS.test(String((d as { platform?: string }).platform ?? "")),
    ).length;
  } catch {
    return 0;
  }
}

// ── registry ───────────────────────────────────────────────────────────────

export function coreSetupChecks(): SetupCheckDefinition[] {
  return [
    {
      id: "core.models",
      title: "Model provider",
      tabs: ["apikeys", "webchat"],
      priority: 100,
      action: { label: "Add an API key", tab: "apikeys" },
      evaluate: async (ctx) => modelCredentialOutcome(await gatherModelCredentialFacts(ctx.cloud)),
    },
    {
      id: "core.inbox",
      title: "Email account",
      tabs: ["inbox"],
      priority: 40,
      action: { label: "Connect email", tab: "inbox" },
      evaluate: async () => inboxOutcome(await countEmailAccounts()),
    },
    {
      id: "core.coders",
      title: "Coding agent",
      tabs: ["coders"],
      priority: 30,
      action: { label: "Install a coder", tab: "setup", view: "coders" },
      evaluate: async () => {
        const n = await countInstalledCoders();
        return n === null ? READY : codersOutcome(n);
      },
    },
    {
      id: "core.voice",
      title: "Voice",
      tabs: ["voice"],
      priority: 20,
      // voice.json isn't tenant-scoped; hosted voice is platform-managed.
      localOnly: true,
      action: { label: "Set up voice", tab: "setup", section: "voice" },
      evaluate: async () => {
        const { isVoiceConfigured } = await import("../voice/config.js");
        return voiceOutcome(isVoiceConfigured());
      },
    },
    {
      id: "core.channels",
      title: "Messaging channel",
      tabs: ["channels"],
      priority: 10,
      action: { label: "Connect a channel", tab: "channels" },
      evaluate: () =>
        channelsOutcome((cfgOrEmpty() as { channels?: Record<string, unknown> }).channels),
    },
    {
      id: "core.calendar",
      title: "Calendar",
      tabs: ["schedule"],
      priority: 5,
      action: { label: "Connect a calendar", tab: "schedule" },
      evaluate: async () => calendarOutcome(await calendarConnected()),
    },
    {
      id: "core.mobile",
      title: "Mobile app",
      tabs: ["mobile"],
      priority: 1,
      localOnly: true,
      action: { label: "Pair a phone", tab: "mobile" },
      evaluate: async () => mobileOutcome(await countPairedPhones()),
    },
  ];
}

let installed = false;

export function installCoreSetupChecks(): void {
  if (installed) return;
  installed = true;
  setCoreSetupChecks(coreSetupChecks);
}
