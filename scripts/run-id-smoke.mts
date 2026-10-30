#!/usr/bin/env node
/**
 * Smoke test for the coder run-id slug generator.
 * Run: node --import tsx scripts/run-id-smoke.mts
 */

import { makeCoderSlug, makeCoderRunId } from "../src/agents/run-id.ts";

function ok(label: string) { console.log(`✓ ${label}`); }
function fail(label: string, detail?: unknown): never {
  console.error(`✗ ${label}`);
  if (detail !== undefined) console.error("  detail:", detail);
  process.exit(1);
}

// 1. Spec example: label with colon, dash, and mixed case
{
  const runId = makeCoderRunId("Voice mode: TTS-friendly injection prompt", undefined);
  if (!runId.startsWith("coder-voice-mode-tts-friendly-injection-")) {
    fail("spec label slug prefix", runId);
  }
  const shortId = runId.slice("coder-voice-mode-tts-friendly-injection-".length);
  if (shortId.length !== 4) fail("short-id must be 4 chars", shortId);
  ok("spec label → correct slug prefix + 4-char short-id");
}

// 2. Filler word removal and fallback from missing label to task
{
  const runId = makeCoderRunId(undefined, "Fix the timeline scrubber bug");
  if (!runId.startsWith("coder-fix-timeline-scrubber-bug-")) {
    fail("task fallback + filler removal", runId);
  }
  ok("missing label falls back to task; filler words stripped");
}

// 3. 5-token cap (input has 8 non-stop tokens)
{
  const slug = makeCoderSlug("build redesign deploy test validate migrate release archive");
  const parts = slug.split("-");
  if (parts.length !== 5) fail("5-token cap", { parts, slug });
  ok("slug capped at 5 tokens");
}

// 4. Empty label AND empty task → falls back to untitled
{
  const runId = makeCoderRunId("", "");
  if (!runId.startsWith("coder-untitled-")) {
    fail("double-empty fallback to untitled", runId);
  }
  ok("empty label + empty task → coder-untitled-<id>");
}

// 5. Total length ≤ 48 chars even with a very long label
{
  const longLabel = "superlongwordone superlongwordtwo superlongwordthree superlongwordfour superlongwordfive";
  const runId = makeCoderRunId(longLabel, undefined);
  if (runId.length > 48) fail("length cap", { len: runId.length, runId });
  ok("runId total length capped at 48 chars");
}

// 6. Same label → different runIds (randomness in short-id)
{
  const ids = new Set<string>();
  for (let i = 0; i < 20; i++) {
    ids.add(makeCoderRunId("Build the dashboard", undefined));
  }
  if (ids.size < 2) fail("short-id randomness", [...ids]);
  ok("same label produces distinct runIds across spawns");
}

console.log("\nOK — run-id slug helper verified");
process.exit(0);
