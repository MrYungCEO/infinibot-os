import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";

import type {
  ChannelId,
  ChannelOutboundAdapter,
  ChannelPlugin,
} from "../src/channels/plugins/types.js";
import type { InfinibotConfig } from "../src/config/config.js";
import type { OutboundSendDeps } from "../src/infra/outbound/deliver.js";
import type { PluginRegistry } from "../src/plugins/registry.js";
import { setActivePluginRegistry } from "../src/plugins/runtime.js";

const sandboxKey = Symbol.for("infinibot:vitest-worker-sandbox");
const sandboxProcess = process as typeof process & Record<PropertyKey, unknown>;
type SandboxRegistry = { roots: string[] };
let registry = sandboxProcess[sandboxKey] as SandboxRegistry | undefined;
if (!registry) {
  registry = { roots: [] };
  sandboxProcess[sandboxKey] = registry;
  process.once("exit", () => {
    for (const root of registry?.roots ?? []) {
      try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      } catch {
        // Best-effort cleanup after the worker has stopped all asynchronous work.
      }
    }
  });
}
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "infinibot-vitest-home-"));
registry.roots.push(testHome);
const testStateDir = path.join(testHome, ".infinibot");

process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
process.env.INFINIBOT_STATE_DIR = testStateDir;
process.env.MOLTBOT_STATE_DIR = testStateDir;
process.env.CLAWDBOT_STATE_DIR = testStateDir;
fs.mkdirSync(path.join(testStateDir, "agents", "main", "sessions"), { recursive: true });

// Bundled plugins are opt-in for tests. Left alone, any code path that reaches
// the plugin loader discovers the repo's extensions/ tree and loads the default
// memory plugin through jiti — which compiles the whole plugin SDK (most of
// src/) a second time inside the worker. That is minutes of CPU and >1.5 GB of
// heap on a cold CI runner, paid by whichever unrelated test gets there first.
// A test that is about a bundled plugin points this at the real tree itself
// with useBundledPlugins() from test/helpers/bundled-plugins.ts.
const emptyBundledPluginsDir = path.join(testHome, "bundled-plugins");
fs.mkdirSync(emptyBundledPluginsDir, { recursive: true });
process.env.INFINIBOT_BUNDLED_PLUGINS_DIR = emptyBundledPluginsDir;

// A developer's provider credentials must never influence unit-test behavior.
for (const key of [
  "ANTHROPIC_API_KEY",
  "ELEVENLABS_API_KEY",
  "INFINIBOT_GATEWAY_TOKEN",
  "LIVEKIT_API_KEY",
  "LIVEKIT_API_SECRET",
  "LOOPS_API_KEY",
  "NOTION_API_KEY",
  "OLLAMA_CLOUD_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "TELEGRAM_BOT_TOKEN",
] as const) {
  delete process.env[key];
}

if (process.platform === "win32") {
  const match = testHome.match(/^([A-Za-z]:)(.*)$/);
  if (match) {
    process.env.HOMEDRIVE = match[1];
    process.env.HOMEPATH = match[2] || "\\";
  }
}

// A few older colocated tests use Vitest lifecycle helpers as globals even
// though the repo does not enable `test.globals`. Expose only lifecycle hooks;
// assertions and mocks should stay explicitly imported in each test.
Object.assign(globalThis, {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
});

// ── Default channel registry ────────────────────────────────────────────────
// Channel ids, docks and native-command defaults are resolved through the
// active plugin registry. In a running gateway the plugin loader fills it; in a
// unit test nothing does, so "discord" / "slack" / "telegram" would not even
// normalize to a channel id. Every test therefore starts (and ends) with the
// core channels registered as inert stubs. A test that needs something else
// calls setActivePluginRegistry() itself — it is reset again afterwards.
const pickSendFn = (id: ChannelId, deps?: OutboundSendDeps) => {
  switch (id) {
    case "discord":
      return deps?.sendDiscord;
    case "slack":
      return deps?.sendSlack;
    case "telegram":
      return deps?.sendTelegram;
    case "whatsapp":
      return deps?.sendWhatsApp;
    case "signal":
      return deps?.sendSignal;
    case "imessage":
      return deps?.sendIMessage;
    default:
      return undefined;
  }
};

const createStubOutbound = (
  id: ChannelId,
  deliveryMode: ChannelOutboundAdapter["deliveryMode"] = "direct",
): ChannelOutboundAdapter => ({
  deliveryMode,
  sendText: async ({ deps, to, text }) => {
    const send = pickSendFn(id, deps);
    if (send) {
      const result = await send(to, text, {});
      return { channel: id, ...result };
    }
    return { channel: id, messageId: "test" };
  },
  sendMedia: async ({ deps, to, text, mediaUrl }) => {
    const send = pickSendFn(id, deps);
    if (send) {
      const result = await send(to, text, { mediaUrl });
      return { channel: id, ...result };
    }
    return { channel: id, messageId: "test" };
  },
});

const createStubPlugin = (params: {
  id: ChannelId;
  label?: string;
  aliases?: string[];
  deliveryMode?: ChannelOutboundAdapter["deliveryMode"];
  preferSessionLookupForAnnounceTarget?: boolean;
}): ChannelPlugin => ({
  id: params.id,
  meta: {
    id: params.id,
    label: params.label ?? String(params.id),
    selectionLabel: params.label ?? String(params.id),
    docsPath: `/channels/${params.id}`,
    blurb: "test stub.",
    aliases: params.aliases,
    preferSessionLookupForAnnounceTarget: params.preferSessionLookupForAnnounceTarget,
  },
  capabilities: { chatTypes: ["direct", "group"] },
  config: {
    listAccountIds: (cfg: InfinibotConfig) => {
      const channels = cfg.channels as Record<string, unknown> | undefined;
      const entry = channels?.[params.id];
      if (!entry || typeof entry !== "object") return [];
      const accounts = (entry as { accounts?: Record<string, unknown> }).accounts;
      const ids = accounts ? Object.keys(accounts).filter(Boolean) : [];
      return ids.length > 0 ? ids : ["default"];
    },
    resolveAccount: (cfg: InfinibotConfig, accountId: string) => {
      const channels = cfg.channels as Record<string, unknown> | undefined;
      const entry = channels?.[params.id];
      if (!entry || typeof entry !== "object") return {};
      const accounts = (entry as { accounts?: Record<string, unknown> }).accounts;
      const match = accounts?.[accountId];
      return (match && typeof match === "object") || typeof match === "string" ? match : entry;
    },
    isConfigured: async (_account, cfg: InfinibotConfig) => {
      const channels = cfg.channels as Record<string, unknown> | undefined;
      return Boolean(channels?.[params.id]);
    },
  },
  outbound: createStubOutbound(params.id, params.deliveryMode),
});

const createDefaultRegistry = (): PluginRegistry => ({
  plugins: [],
  tools: [],
  hooks: [],
  typedHooks: [],
  channels: [
    {
      pluginId: "discord",
      plugin: createStubPlugin({ id: "discord", label: "Discord" }),
      source: "test",
    },
    {
      pluginId: "slack",
      plugin: createStubPlugin({ id: "slack", label: "Slack" }),
      source: "test",
    },
    {
      pluginId: "telegram",
      plugin: {
        ...createStubPlugin({ id: "telegram", label: "Telegram" }),
        status: {
          buildChannelSummary: async () => ({
            configured: false,
            tokenSource: process.env.TELEGRAM_BOT_TOKEN ? "env" : "none",
          }),
        },
      },
      source: "test",
    },
    {
      pluginId: "whatsapp",
      plugin: createStubPlugin({
        id: "whatsapp",
        label: "WhatsApp",
        deliveryMode: "gateway",
        preferSessionLookupForAnnounceTarget: true,
      }),
      source: "test",
    },
    {
      pluginId: "signal",
      plugin: createStubPlugin({ id: "signal", label: "Signal" }),
      source: "test",
    },
    {
      pluginId: "imessage",
      plugin: createStubPlugin({ id: "imessage", label: "iMessage", aliases: ["imsg"] }),
      source: "test",
    },
  ],
  providers: [],
  mediaProviders: [],
  gatewayHandlers: {},
  httpHandlers: [],
  httpRoutes: [],
  cliRegistrars: [],
  services: [],
  commands: [],
  panelKinds: [],
  diagnostics: [],
});

beforeEach(() => {
  setActivePluginRegistry(createDefaultRegistry());
});

afterEach(() => {
  setActivePluginRegistry(createDefaultRegistry());
});
