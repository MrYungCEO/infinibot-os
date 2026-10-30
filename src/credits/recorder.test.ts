import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  recordCredit,
  recordFromAnthropicResponse,
  recordFromOllamaResponse,
  recordFromOpencodeJSON,
  recordFromCodexJSON,
  recordLegacyApiUsage,
} from "./recorder.js";
import { CreditStore, closeCreditStore, initCreditLedger } from "./store.js";
import { summary, invalidateAggregatorCache } from "./aggregator.js";

let tmpDir: string;
let previousStateDir: string | undefined;
let store: CreditStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "credits-test-"));
  // recordCredit() writes to the ledger of the ACTIVE state dir, so the state
  // dir itself must be per-test — a ledger opened at a custom dbPath is a
  // different store, and the shared one would accumulate rows across tests.
  previousStateDir = process.env.INFINIBOT_STATE_DIR;
  process.env.INFINIBOT_STATE_DIR = tmpDir;
  closeCreditStore();
  store = initCreditLedger();
  invalidateAggregatorCache();
});

afterEach(() => {
  closeCreditStore();
  if (previousStateDir === undefined) delete process.env.INFINIBOT_STATE_DIR;
  else process.env.INFINIBOT_STATE_DIR = previousStateDir;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("credits recorder", () => {
  it("records a direct Anthropic-shaped response", () => {
    const entry = recordFromAnthropicResponse(
      {
        id: "msg_abc",
        model: "claude-sonnet-4-6",
        usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 100 },
      },
      { sessionKey: "test:session:1", agentBackend: "direct-api" },
    );
    expect(entry).not.toBeNull();
    expect(entry?.provider).toBe("anthropic");
    expect(entry?.tokensIn).toBe(1000);
    expect(entry?.tokensOut).toBe(200);
    expect(entry?.cacheReadTokens).toBe(100);
    expect(entry?.requestId).toBe("msg_abc");
    expect(entry?.costUsd).toBeGreaterThan(0);

    const sum = summary({ period: "day" });
    expect(sum.totalRequests).toBe(1);
    expect(sum.totalTokensIn).toBe(1000);
    expect(sum.byProvider[0].provider).toBe("anthropic");
  });

  it("records an Ollama local call at zero cost", () => {
    const entry = recordFromOllamaResponse(
      { model: "llama3.2", prompt_eval_count: 500, eval_count: 1500 },
      { sessionKey: "test:session:2", isCloud: false },
    );
    expect(entry).not.toBeNull();
    expect(entry?.costUsd).toBe(0);
    expect(entry?.agentBackend).toBe("ollama-local");
    expect(entry?.tokensIn).toBe(500);
    expect(entry?.tokensOut).toBe(1500);
  });

  it("never throws if usage is missing", () => {
    expect(() => recordFromAnthropicResponse({ id: "x", model: "y" }, {})).not.toThrow();
    expect(() => recordFromOllamaResponse(null, {})).not.toThrow();
  });

  it("aggregates across sessions and exposes byBackend breakdown", () => {
    recordCredit({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      agentBackend: "claude-code",
      usage: { tokensIn: 100, tokensOut: 50 },
      sessionKey: "alice",
    });
    recordCredit({
      provider: "openai",
      model: "gpt-4o-mini",
      agentBackend: "codex",
      usage: { tokensIn: 200, tokensOut: 80 },
      sessionKey: "bob",
    });
    invalidateAggregatorCache();
    const sum = summary({ period: "day" });
    expect(sum.totalRequests).toBe(2);
    expect(sum.byBackend.map((b) => b.agentBackend).sort()).toEqual(["claude-code", "codex"]);
    expect(sum.bySession.map((s) => s.sessionKey).sort()).toEqual(["alice", "bob"]);
  });

  // ── opencode CLI transcript ─────────────────────────────────
  // Real fixtures captured from opencode 1.17.4 (current) and the pre-1.16
  // shape (legacy). Both must record so the world-map breakdown isn't empty.

  it("records current opencode step_finish events (1.17.x shape)", () => {
    // Captured verbatim from `opencode run --format json` on 1.17.4.
    const ev = {
      type: "step_finish",
      sessionID: "ses_140442559ffed87GrdJgS0Jqbc",
      part: {
        type: "step-finish",
        reason: "stop",
        tokens: {
          total: 89718,
          input: 4,
          output: 4,
          reasoning: 0,
          cache: { write: 89710, read: 0 },
        },
        cost: 0.0897292,
      },
    };
    const entry = recordFromOpencodeJSON(ev, { agentBackend: "opencode", sessionKey: "oc:1" });
    expect(entry).not.toBeNull();
    expect(entry?.agentBackend).toBe("opencode");
    expect(entry?.tokensIn).toBe(4);
    expect(entry?.tokensOut).toBe(4);
    expect(entry?.cacheWriteTokens).toBe(89710);
    expect(entry?.cacheReadTokens).toBe(0);
    // CLI-reported cost is used directly rather than re-priced.
    expect(entry?.costUsd).toBeCloseTo(0.0897292, 6);
  });

  it("records legacy opencode usage shape", () => {
    const entry = recordFromOpencodeJSON(
      {
        model: "claude-sonnet-4-6",
        provider: "anthropic",
        usage: { input: 1000, output: 200, cacheRead: 50, cacheWrite: 10 },
      },
      { agentBackend: "opencode", sessionKey: "oc:2" },
    );
    expect(entry).not.toBeNull();
    expect(entry?.tokensIn).toBe(1000);
    expect(entry?.tokensOut).toBe(200);
    expect(entry?.cacheReadTokens).toBe(50);
    expect(entry?.cacheWriteTokens).toBe(10);
    expect(entry?.provider).toBe("anthropic");
  });

  it("ignores opencode events with no usage (step_start/text)", () => {
    expect(recordFromOpencodeJSON({ type: "step_start", part: {} }, {})).toBeNull();
    expect(recordFromOpencodeJSON({ type: "text", text: "hello" }, {})).toBeNull();
    expect(recordFromOpencodeJSON(null, {})).toBeNull();
  });

  // ── codex CLI transcript ────────────────────────────────────

  it("records current codex turn.completed events (0.137 shape)", () => {
    // Captured verbatim from `codex exec --json` on codex-cli 0.137.0.
    const ev = {
      type: "turn.completed",
      usage: {
        input_tokens: 11929,
        cached_input_tokens: 4992,
        output_tokens: 5,
        reasoning_output_tokens: 0,
      },
    };
    const entry = recordFromCodexJSON(ev, {
      agentBackend: "codex",
      sessionKey: "cx:1",
      model: "gpt-5-codex",
    });
    expect(entry).not.toBeNull();
    expect(entry?.agentBackend).toBe("codex");
    expect(entry?.provider).toBe("openai");
    expect(entry?.tokensIn).toBe(11929);
    expect(entry?.tokensOut).toBe(5);
    expect(entry?.cacheReadTokens).toBe(4992);
    expect(entry?.model).toBe("gpt-5-codex");
  });

  it("does not double-count codex reasoning tokens (already inside output_tokens)", () => {
    // Responses-API semantics: output_tokens INCLUDES reasoning_output_tokens.
    // Captured from a real "say hello" turn: output=41 of which 34 was reasoning.
    const entry = recordFromCodexJSON(
      {
        type: "turn.completed",
        usage: {
          input_tokens: 11857,
          output_tokens: 41,
          reasoning_output_tokens: 34,
          cached_input_tokens: 1920,
        },
      },
      { agentBackend: "codex" },
    );
    expect(entry?.tokensOut).toBe(41); // NOT 41 + 34 = 75
    expect(entry?.tokensIn).toBe(11857);
    expect(entry?.cacheReadTokens).toBe(1920);
  });

  it("falls back to summing when a legacy shape reports output exclusive of reasoning", () => {
    // Defensive path: output < reasoning is physically impossible if inclusive,
    // so treat the two as additive to avoid under-counting.
    const entry = recordFromCodexJSON(
      {
        type: "turn.completed",
        usage: { input_tokens: 100, output_tokens: 20, reasoning_output_tokens: 80 },
      },
      { agentBackend: "codex" },
    );
    expect(entry?.tokensOut).toBe(100);
  });

  it("records legacy codex token_count events", () => {
    const entry = recordFromCodexJSON(
      {
        type: "token_count",
        info: { input_tokens: 300, output_tokens: 40, cached_input_tokens: 12, model: "gpt-4o" },
      },
      { agentBackend: "codex" },
    );
    expect(entry).not.toBeNull();
    expect(entry?.tokensIn).toBe(300);
    expect(entry?.tokensOut).toBe(40);
    expect(entry?.cacheReadTokens).toBe(12);
    expect(entry?.model).toBe("gpt-4o");
  });

  it("ignores non-usage codex events", () => {
    expect(recordFromCodexJSON({ type: "thread.started", thread_id: "x" }, {})).toBeNull();
    expect(recordFromCodexJSON({ type: "turn.started" }, {})).toBeNull();
    expect(
      recordFromCodexJSON(
        { type: "item.completed", item: { type: "agent_message", text: "hi" } },
        {},
      ),
    ).toBeNull();
    expect(recordFromCodexJSON(null, {})).toBeNull();
  });

  it("both CLI backends record with their agent_backend tag", () => {
    const oc = recordFromOpencodeJSON(
      { type: "step_finish", part: { tokens: { input: 10, output: 5 }, cost: 0.01 } },
      { agentBackend: "opencode", sessionKey: "s" },
    );
    const cx = recordFromCodexJSON(
      { type: "turn.completed", usage: { input_tokens: 20, output_tokens: 8 } },
      { agentBackend: "codex", sessionKey: "s", model: "gpt-5-codex" },
    );
    expect([oc?.agentBackend, cx?.agentBackend].sort()).toEqual(["codex", "opencode"]);
    // Both persist to the ledger under their backend tag (what the world-map reads).
    const rows = store.recent(100);
    const backends = new Set(rows.map((r) => r.agentBackend));
    expect(backends.has("opencode")).toBe(true);
    expect(backends.has("codex")).toBe(true);
  });

  it("preserves legacy api-monitor cost overrides", () => {
    const entry = recordLegacyApiUsage("anthropic", "claude-opus-4-7", 100, 50, 12.34, {
      sessionKey: "leg:1",
      autonomous: true,
    });
    expect(entry?.costUsd).toBe(12.34);
    expect(entry?.autonomous).toBe(true);
  });
});
