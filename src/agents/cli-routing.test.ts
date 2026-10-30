import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InfinibotConfig } from "../config/config.js";
import { resolveAgentModelFallbacksOverride, resolveAgentModelPrimary } from "./agent-scope.js";
import {
  isCliProvider,
  resolveConfiguredModelRef,
  resolveDefaultModelForAgent,
} from "./model-selection.js";
import { runWithModelFallback } from "./model-fallback.js";
import { FailoverError } from "./failover-error.js";
import {
  DEFAULT_CLI_ROUTING_ORDER,
  resolveCliRoutingDecision,
  setCliRoutingBinResolver,
} from "./cli-routing.js";
import { describeAgentTurnFailure } from "./turn-failure.js";
import {
  classifyCliFailure,
  createCliStreamParser,
  describeCliFailure,
  isUnsupportedAccountMessage,
  pickDetailLine,
} from "./cli-runner/stream.js";
import {
  applyCliRoutingSet,
  cliRoutingAvailable,
  cliRoutingCoderIds,
  testCliProvider,
} from "../gateway/server-methods/cli-routing.js";
import { getCoderEntry } from "./coder-install/catalog.js";

vi.mock("./ollama-safety-net.js", () => ({
  getOllamaSafetyNetFallbacksAsync: vi.fn(async () => []),
  logOllamaSafetyNetExercised: vi.fn(),
}));

const installed = new Set<string>();
beforeEach(() => {
  installed.clear();
  installed.add("claude");
  installed.add("codex");
  setCliRoutingBinResolver((cmd) => (installed.has(cmd) ? `/usr/bin/${cmd}` : undefined));
});
afterEach(() => setCliRoutingBinResolver(undefined));

const apiCfg = (extra: Partial<InfinibotConfig> = {}): InfinibotConfig =>
  ({
    agents: {
      defaults: {
        model: { primary: "openai/gpt-5.5", fallbacks: ["anthropic/claude-sonnet-5-5"] },
      },
      list: [
        { id: "main", default: true },
        { id: "writer", model: "openai/gpt-5.5-mini" },
      ],
    },
    ...extra,
  }) as InfinibotConfig;

describe("routing decision", () => {
  it("is off by default: existing installs keep their models", () => {
    const cfg = apiCfg();
    expect(resolveDefaultModelForAgent({ cfg, agentId: "main" })).toEqual({
      provider: "openai",
      model: "gpt-5.5",
    });
    expect(resolveAgentModelPrimary(cfg, "writer")).toBe("openai/gpt-5.5-mini");
    expect(resolveCliRoutingDecision({ cfg, agentId: "main" })).toBeNull();
  });

  it("globally on: the first installed CLI is primary, the rest are fallbacks, no API models", () => {
    const cfg = apiCfg({ cliRoutingEnabled: true });
    expect(resolveDefaultModelForAgent({ cfg, agentId: "main" })).toEqual({
      provider: "claude-cli",
      model: "sonnet",
    });
    expect(resolveConfiguredModelRef({ cfg, defaultProvider: "x", defaultModel: "y" })).toEqual({
      provider: "claude-cli",
      model: "sonnet",
    });
    // gemini/grok/opencode are not installed → skipped.
    expect(resolveAgentModelFallbacksOverride(cfg, "main")).toEqual(["codex-cli/default"]);
    // Per-agent API models are routed too.
    expect(resolveAgentModelPrimary(cfg, "writer")).toBe("claude-cli/sonnet");
  });

  it("follows the configured order and per-provider models", () => {
    const cfg = apiCfg({
      cliRoutingEnabled: true,
      cliRouting: { providers: ["codex-cli", "claude-cli"], models: { "codex-cli": "gpt-5.5" } },
    });
    expect(resolveAgentModelPrimary(cfg, "main")).toBe("codex-cli/gpt-5.5");
    expect(resolveAgentModelFallbacksOverride(cfg, "main")).toEqual(["claude-cli/sonnet"]);
  });

  it("with nothing installed, still routes to the first choice so the error says what's missing", () => {
    installed.clear();
    const cfg = apiCfg({ cliRoutingEnabled: true });
    expect(resolveAgentModelPrimary(cfg, "main")).toBe("claude-cli/sonnet");
    expect(resolveAgentModelFallbacksOverride(cfg, "main")).toEqual([]);
  });

  it("per-agent override beats the global switch both ways", () => {
    const cfg = apiCfg({ cliRoutingEnabled: false });
    cfg.agents!.list = [{ id: "main", default: true, cliRouting: true }, { id: "writer" }];
    expect(resolveAgentModelPrimary(cfg, "main")).toBe("claude-cli/sonnet");
    expect(resolveCliRoutingDecision({ cfg, agentId: "writer" })).toBeNull();
    const on = apiCfg({ cliRoutingEnabled: true });
    on.agents!.list = [
      { id: "main", default: true },
      { id: "writer", cliRouting: false, model: "openai/x" },
    ];
    expect(resolveAgentModelPrimary(on, "writer")).toBe("openai/x");
    expect(resolveAgentModelPrimary(on, "main")).toBe("claude-cli/sonnet");
  });

  it("leaves agents on a local model alone", () => {
    const cfg = apiCfg({ cliRoutingEnabled: true });
    cfg.agents!.list = [{ id: "main", default: true, model: "ollama/qwen3.8" }];
    expect(resolveAgentModelPrimary(cfg, "main")).toBe("ollama/qwen3.8");
  });

  it("fallbackToApi appends the agent's own models after the CLIs", () => {
    const cfg = apiCfg({ cliRoutingEnabled: true, cliRouting: { fallbackToApi: true } });
    expect(resolveAgentModelFallbacksOverride(cfg, "main")).toEqual([
      "codex-cli/default",
      "openai/gpt-5.5",
      "anthropic/claude-sonnet-5-5",
    ]);
  });

  it("knows every routing provider as a CLI provider and maps it to a Setup › Coders entry", () => {
    for (const id of DEFAULT_CLI_ROUTING_ORDER) expect(isCliProvider(id)).toBe(true);
    for (const coderId of cliRoutingCoderIds()) expect(getCoderEntry(coderId)).toBeTruthy();
  });
});

describe("fallback across CLIs", () => {
  it("moves to the next CLI on a usage limit, even with a models allowlist", async () => {
    const cfg = apiCfg({ cliRoutingEnabled: true });
    cfg.agents!.defaults!.models = { "openai/gpt-5.5": {} };
    const tried: string[] = [];
    const res = await runWithModelFallback({
      cfg,
      provider: "claude-cli",
      model: "sonnet",
      fallbacksOverride: resolveAgentModelFallbacksOverride(cfg, "main"),
      run: async (provider, model) => {
        tried.push(`${provider}/${model}`);
        if (provider === "claude-cli") {
          throw new FailoverError("Claude Code has hit your plan's usage limit.", {
            reason: "rate_limit",
            provider,
            model,
          });
        }
        return "ok";
      },
    });
    expect(tried).toEqual(["claude-cli/sonnet", "codex-cli/default"]);
    expect(res.provider).toBe("codex-cli");
  });

  it("all CLIs failing gives one plain message and a subscription code", async () => {
    const cfg = apiCfg({ cliRoutingEnabled: true });
    const err = await runWithModelFallback({
      cfg,
      provider: "claude-cli",
      model: "sonnet",
      fallbacksOverride: ["codex-cli/default"],
      run: async (provider, model) => {
        throw new FailoverError(
          provider === "claude-cli"
            ? "Claude Code has hit your plan's usage limit."
            : "Codex CLI isn't signed in. Sign in from Setup › Coders, or run `codex login` in a terminal.",
          { reason: provider === "claude-cli" ? "rate_limit" : "auth", provider, model },
        );
      },
    }).catch((e) => e);
    const failure = describeAgentTurnFailure(err, { cfg });
    expect(failure.errorMessage).toBe(
      "Claude Code has hit your plan's usage limit. Codex CLI isn't signed in. Sign in from Setup › Coders, or run `codex login` in a terminal.",
    );
    expect(failure.errorMessage).not.toMatch(/All models failed|codex-cli\/default/);
    expect(failure.errorCode).toBe("subscription_signed_out");
    expect(failure.cliProvider).toBe("codex-cli");
  });
});

describe("stream parsers", () => {
  const feed = (dialect: Parameters<typeof createCliStreamParser>[0], lines: object[]) => {
    const p = createCliStreamParser(dialect);
    for (const l of lines) p.push(JSON.stringify(l));
    p.push("not json");
    return p.state;
  };

  it("claude: deltas across a tool call become two paragraphs; tools recorded", () => {
    const s = feed("claude-stream-json", [
      { type: "system", subtype: "init", session_id: "S" },
      {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "Checking." } },
      },
      { type: "stream_event", event: { type: "content_block_stop" } },
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "mcp__infinibot__kanban" }] },
      },
      {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "3 tasks." } },
      },
      {
        type: "result",
        subtype: "success",
        result: "3 tasks.",
        usage: { input_tokens: 5, output_tokens: 4 },
      },
    ]);
    expect(s.text).toBe("Checking.\n\n3 tasks.");
    expect(s.sessionId).toBe("S");
    expect(s.tools).toEqual(["mcp__infinibot__kanban"]);
    expect(s.usage).toMatchObject({ input: 5, output: 4 });
  });

  it("claude: without partial messages, whole assistant blocks are used", () => {
    const s = feed("claude-stream-json", [
      { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } },
      { type: "result", subtype: "success", result: "hi" },
    ]);
    expect(s.text).toBe("hi");
  });

  it("codex: agent messages, mcp tool calls, thread id, failures", () => {
    const s = feed("codex-jsonl", [
      { type: "thread.started", thread_id: "T" },
      { type: "item.started", item: { type: "mcp_tool_call", tool: "memory_search" } },
      { type: "item.completed", item: { type: "agent_message", text: "found it" } },
      {
        type: "turn.completed",
        usage: { input_tokens: 10, cached_input_tokens: 8, output_tokens: 2 },
      },
    ]);
    expect(s).toMatchObject({ text: "found it", sessionId: "T", tools: ["memory_search"] });
    expect(s.usage).toMatchObject({ input: 10, cacheRead: 8, output: 2 });
    expect(feed("codex-jsonl", [{ type: "turn.failed", error: { message: "boom" } }]).error).toBe(
      "boom",
    );
  });

  it("gemini: init session id, assistant deltas, result error", () => {
    const s = feed("gemini-stream-json", [
      { type: "init", session_id: "G", model: "gemini-3" },
      { type: "message", role: "user", content: "hi" },
      { type: "message", role: "assistant", content: "Hel", delta: true },
      { type: "message", role: "assistant", content: "lo", delta: true },
      { type: "result", status: "success", stats: { input_tokens: 1, output_tokens: 1 } },
    ]);
    expect(s).toMatchObject({ text: "Hello", sessionId: "G" });
    expect(
      feed("gemini-stream-json", [
        { type: "result", status: "error", error: { message: "Quota exceeded" } },
      ]).error,
    ).toBe("Quota exceeded");
  });

  it("grok: text chunks, end carries the session id; signed-out error", () => {
    const s = feed("grok-streaming-json", [
      { type: "text", data: "Here's " },
      { type: "text", data: "a summary" },
      { type: "end", sessionId: "K", usage: { input_tokens: 3, output_tokens: 3 } },
    ]);
    expect(s).toMatchObject({ text: "Here's a summary", sessionId: "K" });
    const err = feed("grok-streaming-json", [
      {
        type: "error",
        message:
          "Not signed in. To authenticate without a browser, run:\n  grok login --device-code",
      },
    ]).error!;
    expect(classifyCliFailure(err)).toBe("auth");
  });

  it("opencode: text parts by id, session id, tokens", () => {
    const s = feed("opencode-json", [
      { type: "step_start", sessionID: "O", part: {} },
      { type: "text", sessionID: "O", part: { id: "p1", text: "Hi" } },
      { type: "text", sessionID: "O", part: { id: "p1", text: "Hi there" } },
      { type: "step_finish", part: { tokens: { input: 4, output: 2, cache: { read: 1 } } } },
    ]);
    expect(s).toMatchObject({ text: "Hi there", sessionId: "O" });
    expect(s.usage).toMatchObject({ input: 4, output: 2, cacheRead: 1 });
  });

  it("explains failures with the informative line, not CLI chatter", () => {
    expect(
      describeCliFailure({
        kind: classifyCliFailure(
          "Loaded cached credentials.\nThis account requires setting the GOOGLE_CLOUD_PROJECT env var.",
        ),
        label: "Gemini CLI",
        command: "gemini",
        detail:
          "Loaded cached credentials.\nThis account requires setting the GOOGLE_CLOUD_PROJECT env var.",
      }),
    ).toContain("needs a Google Cloud project");
    expect(
      describeCliFailure({
        kind: "unknown",
        label: "Gemini CLI",
        command: "gemini",
        detail: "Loaded cached credentials.\nSomething odd happened.",
      }),
    ).toBe("Gemini CLI failed: Something odd happened.");
    expect(
      describeCliFailure({
        kind: "auth",
        label: "Grok Build",
        command: "grok",
        detail: "Not signed in. To authenticate…",
      }),
    ).toBe(
      "Grok Build isn't signed in. Sign in from Setup › Coders, or run `grok login` in a terminal.",
    );
  });

  it("Gemini ineligible-tier stderr maps to a plain message, never a lone brace", () => {
    const stderr = [
      "Loaded cached credentials.",
      "Error authenticating: IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals. Learn more.",
      "    at setupUser (file:///x/gemini.js:1:1) {",
      "  ineligibleTiers: [",
      "    {",
      "      reasonCode: 'UNSUPPORTED_CLIENT',",
      "      reasonMessage: 'This client is no longer supported for Gemini Code Assist for individuals.',",
      "      tierId: 'free-tier'",
      "    }",
      "  ]",
      "}",
    ].join("\n");
    expect(pickDetailLine(stderr)).toBe(
      "This client is no longer supported for Gemini Code Assist for individuals.",
    );
    expect(pickDetailLine("a\nb: {\n  x: 1\n}")).not.toBe("}");
    expect(pickDetailLine("  ]\n}")).toBeUndefined();
    const kind = classifyCliFailure(stderr);
    expect(kind).toBe("unsupported_account");
    const message = describeCliFailure({
      kind,
      label: "Gemini CLI",
      command: "gemini",
      detail: stderr,
    });
    expect(message).toContain("Google no longer lets free Google accounts use Gemini CLI");
    expect(message).toContain("aistudio.google.com/apikey");
    expect(isUnsupportedAccountMessage(message)).toBe(true);
    const failure = describeAgentTurnFailure(
      new FailoverError(message, { reason: "auth", provider: "gemini-cli" }),
    );
    expect(failure.errorCode).toBe("subscription_unsupported");
    expect(failure.errorMessage).toBe(message);
  });

  it("maps the older GOOGLE_CLOUD_PROJECT error and untrusted-folder error to their own codes", () => {
    const old =
      "This account requires setting the GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID env var";
    expect(classifyCliFailure(old)).toBe("unsupported_account");
    const m = describeCliFailure({
      kind: "unsupported_account",
      label: "Gemini CLI",
      command: "gemini",
      detail: old,
    });
    expect(m).toContain("Google Cloud project");
    expect(isUnsupportedAccountMessage(m)).toBe(true);
    const t =
      "Gemini CLI is not running in a trusted directory. To proceed, either use --skip-trust";
    expect(classifyCliFailure(t)).toBe("untrusted_dir");
    const tm = describeCliFailure({
      kind: "untrusted_dir",
      label: "Gemini CLI",
      command: "gemini",
      detail: t,
    });
    expect(
      describeAgentTurnFailure(new FailoverError(tm, { reason: "unknown", provider: "gemini-cli" }))
        .errorCode,
    ).toBe("subscription_untrusted");
  });

  it("classifies CLI failure text", () => {
    expect(classifyCliFailure("You've hit your usage limit. Try again at 3:05 PM.")).toBe(
      "rate_limit",
    );
    expect(classifyCliFailure("Claude AI usage limit reached|1792171200")).toBe("rate_limit");
    expect(classifyCliFailure("Invalid API key · Please run /login")).toBe("auth");
    expect(classifyCliFailure("Error: 401 Unauthorized")).toBe("auth");
    expect(classifyCliFailure("spawn grok ENOENT")).toBe("not_installed");
    expect(classifyCliFailure("request timed out")).toBe("timeout");
    expect(classifyCliFailure("something odd")).toBe("unknown");
  });
});

describe("cliRouting.set config writer", () => {
  it("toggles, orders, sets models and per-agent overrides (tri-state)", () => {
    let cfg = applyCliRoutingSet({} as InfinibotConfig, {
      enabled: true,
      providers: ["codex-cli", "claude-cli", "codex-cli"],
      models: { "claude-cli": "opus" },
      fallbackToApi: true,
      tools: false,
    });
    expect(cfg.cliRoutingEnabled).toBe(true);
    expect(cfg.cliRouting).toEqual({
      providers: ["codex-cli", "claude-cli"],
      models: { "claude-cli": "opus" },
      fallbackToApi: true,
      tools: false,
    });
    cfg = applyCliRoutingSet(cfg, { agentId: "writer", agentEnabled: false });
    expect(cfg.agents?.list).toEqual([{ id: "writer", cliRouting: false }]);
    cfg = applyCliRoutingSet(cfg, { agentId: "writer", agentEnabled: null });
    expect(cfg.agents?.list).toEqual([{ id: "writer" }]);
    cfg = applyCliRoutingSet(cfg, { models: { "claude-cli": "" } });
    expect(cfg.cliRouting?.models).toEqual({});
  });

  it("rejects unknown providers and bad types", () => {
    expect(() => applyCliRoutingSet({} as InfinibotConfig, { providers: ["grokbot"] })).toThrow(
      /Unknown CLI provider: grokbot/,
    );
    expect(() => applyCliRoutingSet({} as InfinibotConfig, { enabled: "yes" })).toThrow();
    expect(() =>
      applyCliRoutingSet({} as InfinibotConfig, { agentId: "x", agentEnabled: 1 }),
    ).toThrow();
  });

  it("is unavailable on hosted cloud", () => {
    expect(cliRoutingAvailable({ CLOUD_MODE: "1" })).toBe(false);
    expect(cliRoutingAvailable({})).toBe(true);
  });
});

describe("connect test turn", () => {
  it("returns the reply on success, and a plain coded message on failure", async () => {
    const ok = await testCliProvider({} as InfinibotConfig, "claude-cli", (async (p: {
      config?: InfinibotConfig;
      prompt: string;
    }) => {
      // The test turn never hands the CLI InfiniBot tools (fast + cheap).
      expect(p.config?.cliRouting?.tools).toBe(false);
      return { payloads: [{ text: "Ready" }], meta: { durationMs: 1 } };
    }) as never);
    expect(ok).toMatchObject({ ok: true, reply: "Ready" });
    const bad = await testCliProvider({} as InfinibotConfig, "claude-cli", (async () => {
      throw new FailoverError(
        "Claude Code isn't signed in. Sign in from Setup › Coders, or run `claude login` in a terminal.",
        {
          reason: "auth",
          provider: "claude-cli",
          model: "sonnet",
        },
      );
    }) as never);
    expect(bad).toMatchObject({ ok: false, code: "subscription_signed_out" });
  });
});
