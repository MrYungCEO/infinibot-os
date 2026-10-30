/**
 * Subscription CLI routing across every ingress + the "route all traffic"
 * switch (cliRouting.allTraffic) + where routing may run (local / fleet tenant
 * Machine / shared cloud gateway).
 *
 * Every ingress that runs a model turn goes through runWithModelFallback
 * (chat.send / webchat, channels, group chat, follow-ups, agent RPC = voice /
 * sub-agents / mobile / OpenAI HTTP, cron, heartbeats), so the per-ingress
 * table below drives it with each ingress's real session-key shape.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InfinibotConfig } from "../config/config.js";
import {
  isCliRoutingAllTraffic,
  resolveCliRoutingAvailability,
  resolveCliRoutingDecision,
  resolveForcedCliRoute,
  setCliRoutingBinResolver,
} from "./cli-routing.js";
import { applyCliRoutingSet, cliRoutingAvailable } from "./cli-routing-setup.js";
import { resolveRunCliRoute } from "./cli-routing-run.js";
import { runWithModelFallback } from "./model-fallback.js";
import { resolveDefaultModelForAgent } from "./model-selection.js";
import { resolveAgentModelPrimary } from "./agent-scope.js";
import { FailoverError } from "./failover-error.js";
import { voiceTurnRoutesToCli } from "../gateway/voice/voice-llm-turn.js";

vi.mock("./ollama-safety-net.js", () => ({
  getOllamaSafetyNetFallbacksAsync: vi.fn(async () => []),
  logOllamaSafetyNetExercised: vi.fn(),
}));

const installed = new Set<string>();
beforeEach(() => {
  installed.clear();
  installed.add("grok");
  installed.add("claude");
  setCliRoutingBinResolver((cmd) => (installed.has(cmd) ? `/usr/bin/${cmd}` : undefined));
});
afterEach(() => {
  setCliRoutingBinResolver(undefined);
  vi.unstubAllEnvs();
});

const cfgWith = (extra: Partial<InfinibotConfig> = {}): InfinibotConfig =>
  ({
    agents: {
      defaults: { model: { primary: "openai/gpt-5.5" } },
      list: [
        { id: "main", default: true },
        { id: "writer", model: "anthropic/claude-sonnet-5-5", cliRouting: false },
        { id: "local", model: "ollama/qwen3.8" },
      ],
    },
    ...extra,
  }) as InfinibotConfig;

/** "Route all traffic via Grok, then Claude". */
const allViaGrok = (extra: Partial<InfinibotConfig["cliRouting"]> = {}) =>
  cfgWith({
    cliRoutingEnabled: true,
    cliRouting: { providers: ["grok-cli", "claude-cli"], allTraffic: true, ...extra },
  });

describe("where routing may run", () => {
  it("local install: available", () => {
    expect(resolveCliRoutingAvailability({})).toEqual({ available: true, where: "local" });
  });

  it("fleet tenant Machine (own volume holds the CLIs + sign-ins): available", () => {
    expect(resolveCliRoutingAvailability({ SAAS_MODE: "1", FLEET_TENANT_ID: "t_1" })).toEqual({
      available: true,
      where: "tenant-machine",
    });
    expect(cliRoutingAvailable({ SAAS_MODE: "1", FLEET_TENANT_ID: "t_1" })).toBe(true);
  });

  it("shared multi-tenant cloud gateway: refused with a plain reason", () => {
    for (const env of [{ SAAS_MODE: "1" }, { CLOUD_MODE: "true" }]) {
      const a = resolveCliRoutingAvailability(env);
      expect(a.available).toBe(false);
      expect(a.where).toBe("shared-cloud");
      expect(a.reason).toMatch(/shared by several workspaces/);
      expect(a.reason).toMatch(/xAI API key/);
    }
  });

  it("a config copied onto a shared cloud gateway never routes", () => {
    vi.stubEnv("SAAS_MODE", "1");
    vi.stubEnv("FLEET_TENANT_ID", "");
    const cfg = allViaGrok();
    expect(resolveCliRoutingDecision({ cfg, agentId: "main" })).toBeNull();
    expect(resolveDefaultModelForAgent({ cfg, agentId: "main" })).toEqual({
      provider: "openai",
      model: "gpt-5.5",
    });
    expect(
      resolveRunCliRoute({
        cfg,
        provider: "openai",
        model: "gpt-5.5",
        sessionKey: "agent:main:main",
      }),
    ).toBeNull();
  });

  it("on a tenant Machine it routes like a local install", () => {
    vi.stubEnv("SAAS_MODE", "1");
    vi.stubEnv("FLEET_TENANT_ID", "t_1");
    expect(resolveAgentModelPrimary(allViaGrok(), "main")).toBe("grok-cli/default");
  });
});

describe("route all traffic (cliRouting.allTraffic)", () => {
  it("needs the main switch too", () => {
    expect(isCliRoutingAllTraffic(cfgWith({ cliRouting: { allTraffic: true } }))).toBe(false);
    expect(isCliRoutingAllTraffic(allViaGrok())).toBe(true);
  });

  it("routes every agent: per-agent opt-outs and local-model agents included", () => {
    const cfg = allViaGrok();
    for (const id of ["main", "writer", "local"]) {
      expect(resolveAgentModelPrimary(cfg, id)).toBe("grok-cli/default");
    }
    // Without allTraffic the opt-out and the local model are kept.
    const normal = cfgWith({ cliRoutingEnabled: true, cliRouting: { providers: ["grok-cli"] } });
    expect(resolveAgentModelPrimary(normal, "writer")).toBe("anthropic/claude-sonnet-5-5");
    expect(resolveAgentModelPrimary(normal, "local")).toBe("ollama/qwen3.8");
    expect(resolveAgentModelPrimary(normal, "main")).toBe("grok-cli/default");
  });

  it("moves a run pinned to an API model onto the CLIs; a run already on a CLI keeps it", () => {
    const cfg = allViaGrok();
    expect(
      resolveForcedCliRoute({ cfg, agentId: "main", provider: "openai", model: "gpt-5.5-mini" }),
    ).toEqual({ primary: "grok-cli/default", fallbacks: ["claude-cli/sonnet"] });
    expect(
      resolveForcedCliRoute({ cfg, agentId: "main", provider: "claude-cli", model: "opus" }),
    ).toBeNull();
    expect(
      resolveForcedCliRoute({
        cfg: cfgWith({ cliRoutingEnabled: true }),
        agentId: "main",
        provider: "openai",
        model: "gpt-5.5-mini",
      }),
    ).toBeNull();
  });

  it("fallbackToApi keeps the pinned model as the last resort", () => {
    const cfg = allViaGrok({ fallbackToApi: true });
    expect(
      resolveForcedCliRoute({ cfg, agentId: "main", provider: "openai", model: "gpt-5.5-mini" }),
    ).toEqual({
      primary: "grok-cli/default",
      fallbacks: ["claude-cli/sonnet", "openai/gpt-5.5-mini"],
    });
  });

  it("cliRouting.set accepts allTraffic and validates it", () => {
    const next = applyCliRoutingSet({} as InfinibotConfig, { enabled: true, allTraffic: true });
    expect(next.cliRoutingEnabled).toBe(true);
    expect(next.cliRouting?.allTraffic).toBe(true);
    expect(() => applyCliRoutingSet({} as InfinibotConfig, { allTraffic: "yes" })).toThrow(
      /allTraffic must be a boolean/,
    );
  });
});

/** Session-key shape of every ingress that runs an agent turn. */
const INGRESS: Array<{ ingress: string; sessionKey: string | undefined }> = [
  { ingress: "web control UI / desktop Electron chat.send", sessionKey: "agent:main:main" },
  { ingress: "mobile app chat.send", sessionKey: "agent:main:mobile:dm:phone-1" },
  { ingress: "Telegram DM", sessionKey: "agent:main:telegram:dm:12345" },
  { ingress: "Discord channel", sessionKey: "agent:main:discord:channel:987" },
  { ingress: "Slack / other channel", sessionKey: "agent:main:slack:channel:c1" },
  {
    ingress: "voice turn (Robovoice / web voice)",
    sessionKey: "agent:main:voicecall:robovoice:c1",
  },
  { ingress: "group chat member", sessionKey: "agent:writer:groupchat:g1" },
  { ingress: "sub-agent (sessions_spawn)", sessionKey: "agent:main:subagent:3f1c" },
  { ingress: "cron isolated job", sessionKey: "agent:main:cron:daily-digest" },
  { ingress: "heartbeat", sessionKey: "agent:main:main" },
  { ingress: "federation / OpenAI HTTP (no session key)", sessionKey: undefined },
];

describe("every ingress goes through the routing decision", () => {
  for (const { ingress, sessionKey } of INGRESS) {
    it(`${ingress}: a pinned API model runs on the CLI chain under allTraffic`, async () => {
      const tried: string[] = [];
      const res = await runWithModelFallback({
        cfg: allViaGrok(),
        provider: "openai",
        model: "gpt-5.5-mini",
        sessionKey,
        fallbacksOverride: [],
        run: async (provider, model) => {
          tried.push(`${provider}/${model}`);
          if (provider === "grok-cli") {
            throw new FailoverError("Grok hit its usage limit", { reason: "rate_limit" });
          }
          return "ok";
        },
      });
      // Grok first, Claude Code as the CLI fallback; the pinned API model never runs.
      expect(tried).toEqual(["grok-cli/default", "claude-cli/sonnet"]);
      expect(res.provider).toBe("claude-cli");
      expect(tried.some((t) => t.startsWith("openai/"))).toBe(false);
    });
  }

  it("Secure Mode sessions are never moved onto a cloud CLI", () => {
    expect(
      resolveRunCliRoute({
        cfg: allViaGrok(),
        provider: "ollama",
        model: "qwen3.8",
        sessionKey: "agent:main:secure-main",
      }),
    ).toBeNull();
  });

  it("an internal run can opt out (cliRouting: false)", async () => {
    const seen: string[] = [];
    await runWithModelFallback({
      cfg: allViaGrok(),
      provider: "openai",
      model: "gpt-5.5-mini",
      sessionKey: "agent:main:main",
      fallbacksOverride: [],
      cliRouting: false,
      run: async (p, m) => {
        seen.push(`${p}/${m}`);
        return "ok";
      },
    });
    expect(seen).toEqual(["openai/gpt-5.5-mini"]);
  });

  it("routing off: pinned runs are untouched", async () => {
    const seen: string[] = [];
    await runWithModelFallback({
      cfg: cfgWith(),
      provider: "openai",
      model: "gpt-5.5-mini",
      sessionKey: "agent:main:telegram:dm:1",
      fallbacksOverride: [],
      run: async (p, m) => {
        seen.push(`${p}/${m}`);
        return "ok";
      },
    });
    expect(seen).toEqual(["openai/gpt-5.5-mini"]);
  });
});

describe("voice turns skip the direct-API fast step when routed", () => {
  it("allTraffic: always the agent (CLI) path, even with an API voice brain", async () => {
    const cfg = allViaGrok();
    expect(await voiceTurnRoutesToCli({ agentId: "main" }, cfg)).toBe(true);
    expect(
      await voiceTurnRoutesToCli({ agentId: "main", primaryModel: "openai/gpt-5.5" }, cfg),
    ).toBe(true);
  });

  it("routing on: routed agent → CLI; an explicit API voice brain keeps the fast step", async () => {
    const cfg = cfgWith({ cliRoutingEnabled: true, cliRouting: { providers: ["grok-cli"] } });
    expect(await voiceTurnRoutesToCli({ agentId: "main" }, cfg)).toBe(true);
    expect(
      await voiceTurnRoutesToCli({ agentId: "main", primaryModel: "openai/gpt-5.5" }, cfg),
    ).toBe(false);
    expect(await voiceTurnRoutesToCli({ agentId: "writer" }, cfg)).toBe(false);
  });

  it("routing off: fast step as before", async () => {
    expect(await voiceTurnRoutesToCli({ agentId: "main" }, cfgWith())).toBe(false);
  });
});

describe("per-agent opt-out stays off the CLIs", () => {
  it("cliRouting: false agent failing on its API model never falls back onto the default agent's CLI", async () => {
    const cfg = cfgWith({ cliRoutingEnabled: true, cliRouting: { providers: ["grok-cli"] } });
    const tried: string[] = [];
    await runWithModelFallback({
      cfg,
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      sessionKey: "agent:writer:main",
      run: async (provider, model) => {
        tried.push(`${provider}/${model}`);
        throw new FailoverError("no API key", { reason: "auth" });
      },
    }).catch(() => undefined);
    expect(tried[0]).toBe("anthropic/claude-sonnet-5-5");
    expect(tried.some((t) => t.startsWith("grok-cli/"))).toBe(false);
  });
});
