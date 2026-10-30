import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InfinibotConfig } from "../config/config.js";

const completeSimple = vi.fn();
vi.mock("@mariozechner/pi-ai", () => ({
  completeSimple: (...a: unknown[]) => completeSimple(...a),
}));
const resolveModel = vi.fn();
vi.mock("../agents/pi-embedded-runner/model.js", () => ({
  resolveModel: (...a: unknown[]) => resolveModel(...a),
}));
const getApiKeyForModel = vi.fn();
vi.mock("../agents/model-auth.js", () => ({
  getApiKeyForModel: (...a: unknown[]) => getApiKeyForModel(...a),
}));

import { evaluateCriterion, evaluateGoal } from "./goal-judge.js";
import {
  callApiJudge,
  resetJudgeCachesForTests,
  resolveJudgeCandidates,
  runJudgeChain,
  type JudgeCandidate,
} from "./judge-models.js";

// The owner's real shape: no Anthropic key, ollama-cloud reasoning default.
const OWNER_CFG = {
  agents: {
    defaults: {
      model: {
        primary: "ollama-cloud/gpt-oss:120b",
        fallbacks: ["ollama-cloud/gpt-oss:20b", "ollama/gemma4:31b"],
      },
    },
  },
  models: {
    providers: {
      openrouter: { models: [{ id: "deepseek/deepseek-v4-flash" }] },
      "vllm-local": { models: [{ id: "qwen3" }] },
    },
  },
} as unknown as InfinibotConfig;

const labels = (cs: JudgeCandidate[]) =>
  cs.map((c) => (c.kind === "api" ? `${c.provider}/${c.model}` : `cli:${c.backend}`));

beforeEach(() => {
  resetJudgeCachesForTests();
  completeSimple.mockReset();
  resolveModel.mockReset();
  getApiKeyForModel.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("resolveJudgeCandidates", () => {
  it("uses the agent default model first when no judge is configured, anthropic only as a keyed fallback, CLIs last", () => {
    const l = labels(resolveJudgeCandidates(OWNER_CFG, {}));
    expect(l.slice(0, 3)).toEqual([
      "ollama-cloud/gpt-oss:120b",
      "ollama-cloud/gpt-oss:20b",
      "ollama/gemma4:31b",
    ]);
    expect(l).toContain("openrouter/deepseek/deepseek-v4-flash");
    expect(l.indexOf("anthropic/claude-haiku-4-5")).toBeGreaterThan(
      l.indexOf("openrouter/deepseek/deepseek-v4-flash"),
    );
    expect(l.slice(-3)).toEqual(["cli:claude-code", "cli:codex", "cli:opencode"]);
  });

  it("env override, then verification.judgeModel + fallbacks, lead the chain", () => {
    const cfg = {
      ...OWNER_CFG,
      verification: {
        judgeModel: "openrouter/x-ai/grok-4-fast",
        judgeFallbacks: ["openai/gpt-4.1"],
      },
    } as unknown as InfinibotConfig;
    const l = labels(
      resolveJudgeCandidates(cfg, { ANTHROPIC_GOAL_JUDGE_MODEL: "claude-sonnet-5" }),
    );
    expect(l.slice(0, 4)).toEqual([
      "anthropic/claude-sonnet-5",
      "openrouter/x-ai/grok-4-fast",
      "openai/gpt-4.1",
      "ollama-cloud/gpt-oss:120b",
    ]);
  });
});

describe("runJudgeChain", () => {
  const cands: JudgeCandidate[] = [
    { kind: "api", provider: "anthropic", model: "claude-haiku-4-5", source: "env" },
    { kind: "api", provider: "ollama-cloud", model: "gpt-oss:120b", source: "agent-default" },
    { kind: "cli", backend: "claude-code", source: "cli" },
  ];

  it("no Anthropic key → falls through to the configured provider and records why", async () => {
    const res = await runJudgeChain(
      { system: "s", prompt: "p" },
      {
        candidates: cands,
        callApi: async (c) => {
          if (c.provider === "anthropic")
            throw new Error('No API key found for provider "anthropic".');
          return '{"verdict":"supported"}';
        },
        cliAvailable: () => false,
      },
    );
    expect(res.judge).toBe("ollama-cloud/gpt-oss:120b");
    expect(res.text).toContain("supported");
    expect(res.failures).toEqual([
      { judge: "anthropic/claude-haiku-4-5", error: 'No API key found for provider "anthropic".' },
    ]);
  });

  it("an unusable answer is rejected and the next judge (CLI) answers", async () => {
    const res = await runJudgeChain(
      { system: "s", prompt: "p", accept: (t) => t.startsWith("{") },
      {
        candidates: cands,
        callApi: async () => "I think it is fine",
        callCli: async () => '{"ok":true}',
        cliAvailable: () => true,
      },
    );
    expect(res.judge).toBe("cli:claude-code");
    expect(res.failures.map((f) => f.error)).toEqual([
      expect.stringContaining("unusable answer"),
      expect.stringContaining("unusable answer"),
    ]);
  });

  it("nothing answers → empty text with every failure (never a pass)", async () => {
    const res = await runJudgeChain(
      { system: "s", prompt: "p" },
      {
        candidates: cands,
        callApi: async () => {
          throw new Error("boom");
        },
        callCli: async () => {
          throw new Error("CLI planner timed out after 180000ms");
        },
        cliAvailable: () => true,
      },
    );
    expect(res.text).toBe("");
    expect(res.judge).toBeNull();
    expect(res.failures).toHaveLength(3);
  });

  it("image judging skips non-claude CLIs", async () => {
    const seen: string[] = [];
    await runJudgeChain(
      { system: "s", prompt: "p", imagePaths: ["/tmp/x.png"] },
      {
        candidates: [
          { kind: "cli", backend: "codex", source: "cli" },
          { kind: "cli", backend: "claude-code", source: "cli" },
        ],
        callCli: async (c) => {
          seen.push(c.backend);
          return "{}";
        },
        cliAvailable: () => true,
      },
    );
    expect(seen).toEqual(["claude-code"]);
  });
});

describe("callApiJudge — reasoning models", () => {
  const model = {
    id: "gpt-oss:120b",
    provider: "ollama-cloud",
    reasoning: true,
    input: ["text"],
  };
  beforeEach(() => {
    resolveModel.mockReturnValue({ model, authStorage: { setRuntimeApiKey: () => {} } });
    getApiKeyForModel.mockResolvedValue({ apiKey: "k", mode: "api-key", source: "profile" });
  });

  it("raises the budget, asks for low reasoning, and retries once when the answer is empty", async () => {
    completeSimple
      .mockResolvedValueOnce({
        content: [{ type: "thinking", thinking: "x".repeat(900) }],
        stopReason: "length",
      })
      .mockResolvedValueOnce({
        content: [
          { type: "thinking", thinking: "…" },
          { type: "text", text: '{"pass":true,"rationale":"ok"}' },
        ],
        stopReason: "stop",
      });
    const text = await callApiJudge(
      { kind: "api", provider: "ollama-cloud", model: "gpt-oss:120b", source: "t" },
      { system: "s", prompt: "p", maxTokens: 400, timeoutMs: 5000 },
    );
    expect(text).toBe('{"pass":true,"rationale":"ok"}');
    expect(completeSimple).toHaveBeenCalledTimes(2);
    const first = completeSimple.mock.calls[0][2] as { maxTokens: number; reasoning?: string };
    const second = completeSimple.mock.calls[1][2] as { maxTokens: number };
    expect(first.maxTokens).toBeGreaterThanOrEqual(4096);
    expect(first.reasoning).toBe("low");
    expect(second.maxTokens).toBe(Math.min(first.maxTokens * 4, 16_000));
  });

  it("surfaces provider errors instead of returning empty text", async () => {
    completeSimple.mockResolvedValue({
      content: [],
      stopReason: "error",
      errorMessage: "401 unauthorized",
    });
    await expect(
      callApiJudge(
        { kind: "api", provider: "ollama-cloud", model: "gpt-oss:120b", source: "t" },
        { system: "s", prompt: "p", timeoutMs: 5000 },
      ),
    ).rejects.toThrow("401 unauthorized");
  });

  it("no key → throws a 'No API key' error (cached as a config failure)", async () => {
    getApiKeyForModel.mockResolvedValue({ apiKey: undefined, mode: "api-key", source: "none" });
    await expect(
      callApiJudge(
        { kind: "api", provider: "anthropic", model: "claude-haiku-4-5", source: "t" },
        { system: "s", prompt: "p", timeoutMs: 5000 },
      ),
    ).rejects.toThrow(/No API key/);
  });
});

describe("goal-judge uses the same chain", () => {
  const deps = {
    candidates: [
      { kind: "api", provider: "anthropic", model: "claude-haiku-4-5", source: "x" },
      { kind: "api", provider: "openrouter", model: "deepseek/deepseek-v4-flash", source: "y" },
    ] as JudgeCandidate[],
    callApi: async (c: Extract<JudgeCandidate, { kind: "api" }>) => {
      if (c.provider === "anthropic") throw new Error('No API key found for provider "anthropic"');
      return c.model.includes("deepseek") ? '{"pass":true,"rationale":"diff shows it"}' : "";
    },
    cliAvailable: () => false,
  };

  it("evaluateCriterion passes via the configured provider when Anthropic has no key", async () => {
    const v = await evaluateCriterion(
      { goalText: "g", criterion: "c", agentOutput: "o", diff: "d" },
      deps,
    );
    expect(v).toEqual({ pass: true, rationale: "diff shows it" });
  });

  it("evaluateGoal gets a verdict from the configured provider", async () => {
    const v = await evaluateGoal(
      { goalText: "g", conversationTail: [{ role: "assistant", content: "done" }] },
      {
        ...deps,
        callApi: async (c) => {
          if (c.provider === "anthropic") throw new Error("No API key");
          return '{"done":true,"rationale":"deliverables produced","blocked":false}';
        },
      },
    );
    expect(v.done).toBe(true);
    expect(v.rationale).toBe("deliverables produced");
  });

  it("evaluateCriterion reports WHY the judge was unavailable", async () => {
    const v = await evaluateCriterion(
      { goalText: "g", criterion: "c", agentOutput: "o" },
      {
        candidates: deps.candidates,
        callApi: async () => {
          throw new Error("No API key");
        },
        cliAvailable: () => false,
      },
    );
    expect(v.pass).toBe(false);
    expect(v.unavailable).toBe(true);
    expect(v.rationale).toContain("anthropic/claude-haiku-4-5: No API key");
  });
});
