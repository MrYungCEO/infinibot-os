import { describe, expect, it } from "vitest";

import { answerHelp, type HelpEnv } from "./help.js";
import {
  collectInfinibotState,
  redactState,
  type InfinibotState,
  type LiveStateDeps,
} from "./live-state.js";
import { composeKnowledgeBase } from "./runtime.js";
import { detectUiControlCaps, navigateHintFor } from "./targets.js";

const kb = composeKnowledgeBase({ plugins: null });
const noRegistry = { available: false, source: null, targets: new Map() };
const oldUiControl = {
  properties: { action: { type: "string", enum: ["list_views", "dispatch", "get_state"] } },
};

function state(over: Partial<InfinibotState> = {}): InfinibotState {
  return {
    at: 0,
    deployment: "local",
    plugins: [
      { id: "solatrix", name: "Solatrix", enabled: true, status: "loaded" },
      { id: "discipline", name: "Discipline", enabled: false, status: "disabled" },
    ],
    setup: [],
    models: { primary: "ollama-cloud/gpt-oss:120b", fallbacks: 2, providerCheck: "ready" },
    channels: { configured: ["telegram"], telegram: { configured: true, ownerChat: true } },
    approvals: { telegram: { enabled: true } },
    voice: { configured: true },
    coders: [{ id: "claude", installed: true, signedIn: true, isDefault: true }],
    solatrix: {
      enabled: true,
      agentAccess: "off",
      frozen: null,
      consentAccepted: false,
      permissions: { executeSwaps: false, transferFunds: false },
      walletCount: 2,
      rpc: { source: "public", rateLimited: true },
      network: "mainnet-beta",
    },
    mainAgent: { toolsAllowlisted: true, hasInfinibotHelp: true, hasUiControl: true },
    unavailable: {},
    ...over,
  };
}

const env = (s: InfinibotState | null = state()): HelpEnv => ({
  kb,
  state: s,
  caps: detectUiControlCaps(oldUiControl),
  registry: noRegistry,
});

describe("infinibot_help answers", () => {
  it('"why can\'t you read my wallet" with plugin ON + agent access Off → diagnoses Agent access, not the plugin', () => {
    const a = answerHelp({ question: "why can't you read my wallet" }, env());
    const text = a.diagnosis.join(" ");
    expect(text).toMatch(/Solatrix plugin IS enabled/);
    expect(text).toMatch(/Agent access/);
    expect(text).not.toMatch(/plugin is DISABLED/);
    expect(a.place?.id).toBe("control:solatrix/agent-access/mode");
    expect(a.place?.breadcrumb).toBe(
      "Home › Plugins › Solatrix › Settings › Agent access & limits › Agent access mode",
    );
    expect(a.place?.route).toBe("/plugins?plugin=solatrix&ptab=settings");
    // ui_control has no navigate verb yet → closest existing page.
    expect(a.navigate?.call).toEqual({
      action: "dispatch",
      view: "nav",
      op: "switch_tab",
      args: { tab: "solatrix-settings" },
    });
    expect(a.navigate?.approximate).toBe(true);
    expect(a.navigate?.say).toBe("Opening Solatrix › Settings");
    expect(a.navigate?.thenLookFor).toMatch(/Agent Access panel/);
    expect(a.reminders.join(" ")).toMatch(/don't scroll\/find\/click/);
  });

  it('"enable solatrix" when the plugin is off → Home › Plugins › Solatrix', () => {
    const s = state({
      plugins: [{ id: "solatrix", name: "Solatrix", enabled: false, status: "disabled" }],
      solatrix: { enabled: false },
    });
    const a = answerHelp({ question: "enable solatrix" }, env(s));
    expect(a.diagnosis.join(" ")).toMatch(/Solatrix plugin is DISABLED/);
    expect(a.place?.id).toBe("plugin:solatrix");
    expect(a.place?.breadcrumb).toBe("Home › Plugins › Solatrix");
    expect(a.navigate?.call).toMatchObject({ op: "switch_tab", args: { tab: "plugins" } });
    expect(a.steps.join(" ")).toMatch(/Enable/);
  });

  it('"enable solatrix" when it is already on → says so and goes to Agent access', () => {
    const a = answerHelp({ question: "enable solatrix" }, env());
    expect(a.diagnosis.join(" ")).toMatch(/enabled and loaded/);
    expect(a.diagnosis.join(" ")).toMatch(/Agent access/);
    expect(a.place?.id).toBe("control:solatrix/agent-access/mode");
  });

  it('"where do I add an API key" → Settings › Keys & Usage', () => {
    const a = answerHelp({ question: "where do I add an API key" }, env());
    expect(a.place?.breadcrumb).toBe("Settings › Keys & Usage");
    expect(a.place?.route).toBe("/apikeys");
    expect(a.steps.join(" ")).toMatch(/Add credential/);
    expect(a.navigate?.call).toMatchObject({ args: { tab: "apikeys" } });
    expect(a.navigate?.approximate).toBe(false);
  });

  it('"how do I connect gmail" → Inbox › Manage accounts, with live email state', () => {
    const s = state({
      setup: [
        {
          id: "core.inbox",
          title: "Email account",
          state: "optional",
          reason: "No email account connected yet",
        },
      ],
    });
    const a = answerHelp({ question: "how do I connect gmail" }, env(s));
    expect(a.place?.breadcrumb).toBe("Chat & Voice › Inbox");
    expect(a.steps.join(" ")).toMatch(/Manage accounts/);
    expect(a.steps.join(" ")).toMatch(/Google consent/);
    expect(a.diagnosis.join(" ")).toMatch(/No email account/);
  });

  it('"install claude code" → Settings › Setup › Coders', () => {
    const a = answerHelp({ question: "install claude code" }, env());
    expect(a.place?.breadcrumb).toBe("Settings › Setup › Coders");
    expect(a.place?.route).toBe("/setup?view=coders");
    expect(a.navigate?.call).toMatchObject({ args: { tab: "coders" } });
    expect(a.diagnosis.join(" ")).toMatch(/claude \(signed in\) \[default\]/);
  });

  it('"turn on telegram approvals" → explains it\'s automatic once Telegram has an owner chat', () => {
    const a = answerHelp(
      { question: "turn on telegram approvals" },
      env(
        state({
          approvals: { telegram: { enabled: false, reason: "no Telegram channel connected" } },
          channels: { configured: [], telegram: { configured: false, ownerChat: false } },
        }),
      ),
    );
    expect(a.place?.breadcrumb).toBe("Settings › Channels");
    expect(a.steps.join(" ")).toMatch(/approvals\.telegram/);
    expect(a.diagnosis.join(" ")).toMatch(
      /Telegram approvals are OFF: no Telegram channel connected/,
    );
  });

  it('"what\'s the difference between cloud and local" → flow + current deployment', () => {
    const a = answerHelp({ question: "what's the difference between cloud and local" }, env());
    expect(a.place?.id).toBe("flow:cloud-vs-local");
    expect(a.summary).toMatch(/BYOK/);
    expect(a.diagnosis.join(" ")).toMatch(/running locally/);
  });

  it('"navigate there" resolves the place from context instead of asking', () => {
    const context =
      "The Solatrix plugin is enabled — its Agent access is Off. Change it in Home › Plugins › Solatrix › Settings › Agent access & limits › Agent access mode.";
    const a = answerHelp({ question: "navigate there", context }, env());
    expect(a.place?.id).toBe("control:solatrix/agent-access/mode");
    expect(a.navigate?.call).toMatchObject({
      op: "switch_tab",
      args: { tab: "solatrix-settings" },
    });
    expect(a.reminders.join(" ")).toMatch(/call ui_control with navigate.call now/);
  });

  it("uses ui_control navigate/highlight once that verb exists", () => {
    const caps = detectUiControlCaps({
      properties: { action: { enum: ["dispatch", "navigate", "highlight", "guide"] } },
    });
    const e = kb.byId.get("control:solatrix/agent-access/mode")!;
    const hint = navigateHintFor(e, { caps, registry: noRegistry });
    expect(hint?.call).toEqual({
      action: "navigate",
      args: { target: "control:solatrix/agent-access/mode" },
    });
    expect(hint?.highlight).toEqual({
      action: "highlight",
      args: { target: "control:solatrix/agent-access/mode" },
    });
  });

  it("works without live state (no diagnosis, still a place)", () => {
    const a = answerHelp({ question: "where do I add an API key" }, env(null));
    expect(a.stateAvailable).toBe(false);
    expect(a.place?.route).toBe("/apikeys");
  });
});

describe("live state", () => {
  const deps = (over: Partial<LiveStateDeps> = {}): LiveStateDeps => ({
    call: async (method) => {
      if (method === "solatrix.agent.status")
        return {
          mode: "off",
          frozen: null,
          consent: null,
          grants: { swaps: false, transfers: false },
          wallets: [{ address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", label: "Main" }],
          rpc: { source: "byok", host: "mainnet.helius-rpc.com", rateLimited: false },
          network: "mainnet-beta",
          platform: { fullAccessAllowed: true },
          pending: 0,
        };
      if (method === "coders.status")
        return {
          coders: [
            {
              id: "claude",
              installed: true,
              auth: "signed-in",
              isDefault: true,
              keys: ["ANTHROPIC_API_KEY"],
            },
          ],
        };
      if (method === "setup.status")
        return {
          checks: [
            { id: "core.models", title: "Model provider", state: "ready" },
            {
              id: "core.inbox",
              title: "Email account",
              state: "optional",
              reason: "No email yet",
              action: { label: "Connect email", tab: "inbox" },
            },
          ],
        };
      throw new Error(`unexpected ${method}`);
    },
    config: () => ({
      agents: {
        defaults: { model: { primary: "openai/gpt-5", fallbacks: ["x"] } },
        list: [{ id: "main", tools: { allow: ["ui_control", "solana_market"] } }],
      },
      channels: {
        telegram: {
          botToken: "123456:AAE-super-secret-token-value-abcdefghijklmnop",
          defaultChatId: "99887766",
          allowFrom: ["99887766"],
        },
      },
      models: { providers: { openai: { apiKey: "sk-live-abcdefghijklmnopqrstuvwxyz0123456789" } } },
    }),
    cloud: () => false,
    registryPlugins: () => [{ id: "solatrix", name: "Solatrix", enabled: true, status: "loaded" }],
    voiceConfigured: async () => false,
    telegramApprovals: async () => ({ enabled: true, chatId: "99887766" }),
    ...over,
  });

  it("assembles plugins, setup, solatrix, coders, channels, approvals", async () => {
    const s = await collectInfinibotState(deps());
    expect(s.solatrix).toMatchObject({
      enabled: true,
      agentAccess: "off",
      walletCount: 1,
      permissions: { executeSwaps: false },
    });
    expect(s.setup).toEqual([
      expect.objectContaining({ id: "core.inbox", fix: "Connect email (inbox)" }),
    ]);
    expect(s.coders).toEqual([{ id: "claude", installed: true, signedIn: true, isDefault: true }]);
    expect(s.channels.telegram).toEqual({ configured: true, ownerChat: true });
    expect(s.approvals.telegram.enabled).toBe(true);
    expect(s.mainAgent).toEqual({
      toolsAllowlisted: true,
      hasInfinibotHelp: false,
      hasUiControl: true,
    });
    expect(s.unavailable).toEqual({});
  });

  it("never leaks secrets, chat ids, wallet addresses or RPC hosts with keys", async () => {
    const text = JSON.stringify(await collectInfinibotState(deps()));
    for (const secret of [
      "super-secret",
      "sk-live",
      "99887766",
      "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
      "ANTHROPIC_API_KEY",
      "helius-rpc",
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it("a failing probe is reported, not thrown", async () => {
    const s = await collectInfinibotState(
      deps({
        call: async () => {
          throw new Error("gateway down");
        },
      }),
    );
    expect(s.unavailable.solatrix).toMatch(/gateway down/);
    expect(s.unavailable.coders).toMatch(/gateway down/);
    expect(s.plugins).toHaveLength(1);
  });

  it("redactState scrubs secret-shaped keys, values and URL credentials", () => {
    const r = redactState({
      apiKey: "x",
      nested: { token: "t", ok: "fine" },
      url: "https://rpc.example.com/?api-key=abc",
      jwt: "eyJhbGciOi.x.y",
    });
    expect(r).toEqual({
      apiKey: "[redacted]",
      nested: { token: "[redacted]", ok: "fine" },
      url: "https://rpc.example.com",
      jwt: "[redacted]",
    });
  });
});
