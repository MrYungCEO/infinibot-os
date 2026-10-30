/**
 * Script-agent loop integration test — no real LLM, no network.
 *
 * Injects a scripted MessagesClient via setAnthropicFactoryForTests and a fetch
 * mock for the research tool, seeds one viral exemplar, then asserts the agent:
 *   - calls viralExamples.search at least once
 *   - calls web.search at least once (researchDepth: standard)
 *   - returns a banned-filler-clean script that parses to scenes
 *   - produces an inspectable trace
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, test } from "vitest";

import {
  runScriptAgent,
  setAnthropicFactoryForTests,
  type MessagesClient,
} from "./script-agent.js";
import { getViralExamplesStore } from "../../content/viral-examples-store.js";

let tmpDir: string;
let prevStateDir: string | undefined;
let prevKey: string | undefined;
let originalFetch: typeof globalThis.fetch;

const CLEAN_SCRIPT = `[SCENE 1: Hook]
VISUAL: Stopwatch hitting 3 seconds.
VOICEOVER: You lose 90% of viewers in the first 3 seconds.
DURATION: 4

[SCENE 2: Proof]
VISUAL: Analytics graph spiking to 12000.
VOICEOVER: This single hook took my Reel from 200 to 12000 views.
DURATION: 5

[SCENE 3: Payoff]
VISUAL: End card reading Follow for part 2.
VOICEOVER: Follow for the exact three-line hook template.
DURATION: 4`;

/** Scripted provider: turn 1 researches, turn 2 drafts, turn 3 returns. */
function scriptedClient(): MessagesClient {
  let turn = 0;
  return {
    messages: {
      create: async () => {
        turn += 1;
        if (turn === 1) {
          return {
            content: [
              { type: "text", text: "Researching the angle and pulling an exemplar." },
              {
                type: "tool_use",
                id: "t1",
                name: "web_search",
                input: { query: "short form hooks 2026" },
              },
              {
                type: "tool_use",
                id: "t2",
                name: "viralExamples_search",
                input: { query: "hooks", platform: "instagram" },
              },
            ],
          };
        }
        if (turn === 2) {
          return {
            content: [
              { type: "tool_use", id: "t3", name: "script_draft", input: { script: CLEAN_SCRIPT } },
            ],
          };
        }
        return { content: [{ type: "text", text: CLEAN_SCRIPT }] };
      },
    },
  };
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "script-agent-test-"));
  prevStateDir = process.env.INFINIBOT_STATE_DIR;
  prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.INFINIBOT_STATE_DIR = tmpDir;
  process.env.ANTHROPIC_API_KEY = "test-key";

  // Seed one exemplar so viralExamples.search returns something.
  getViralExamplesStore(tmpDir).upsert({
    title: "3-second hook breakdown",
    platform: "instagram",
    hook: "You lose 90% of viewers in 3 seconds",
    transcript:
      "[SCENE 1: Hook]\nVISUAL: stopwatch\nVOICEOVER: You lose 90% of viewers in 3 seconds.\nDURATION: 3",
    tags: ["hooks", "retention", "shortform"],
  });

  // Fast fetch mock so gatherResearch resolves without network.
  originalFetch = globalThis.fetch;
  (globalThis as unknown as { fetch: unknown }).fetch = async () =>
    new Response(JSON.stringify({ items: [], RelatedTopics: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  setAnthropicFactoryForTests(() => scriptedClient());
});

afterAll(() => {
  setAnthropicFactoryForTests(null);
  globalThis.fetch = originalFetch;
  if (prevStateDir === undefined) delete process.env.INFINIBOT_STATE_DIR;
  else process.env.INFINIBOT_STATE_DIR = prevStateDir;
  if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = prevKey;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

test("agent loop researches, anchors on an exemplar, and returns a clean script", async () => {
  const traceEntries: string[] = [];
  const result = await runScriptAgent(
    {
      prompt: "Make a Reel about why hooks decide retention",
      platform: "instagram",
      researchDepth: "standard",
    },
    { onTrace: (e) => traceEntries.push(`${e.type}:${e.tool ?? ""}`) },
  );

  assert.equal(result.success, true, result.error);
  assert.ok(
    result.script && result.script.includes("[SCENE 1"),
    "expected a scene-formatted script",
  );
  assert.ok(result.scenes && result.scenes.length >= 3);

  // Acceptance: at least one exemplar lookup and one web search.
  const toolCalls = result.trace.filter((t) => t.type === "tool_call").map((t) => t.tool);
  assert.ok(toolCalls.includes("viralExamples_search"), "agent must call viralExamples.search");
  assert.ok(toolCalls.includes("web_search"), "agent must call web.search at standard depth");

  // Acceptance: banned-filler lint clean.
  assert.ok(result.lint, "expected a final lint result");
  assert.equal(result.lint!.violations.filter((v) => v.severity === "error").length, 0);

  // Trace streamed and exemplar recorded.
  assert.ok(traceEntries.length > 0, "onTrace should have streamed entries");
  assert.ok(result.exemplarsUsed && result.exemplarsUsed.length >= 1);
});

test("missing Anthropic key reports no_provider so callers can fall back", async () => {
  setAnthropicFactoryForTests(null);
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const r = await runScriptAgent({ prompt: "x", researchDepth: "shallow" });
    assert.equal(r.success, false);
    assert.equal(r.stopReason, "no_provider");
  } finally {
    process.env.ANTHROPIC_API_KEY = saved;
    setAnthropicFactoryForTests(() => scriptedClient());
  }
});
