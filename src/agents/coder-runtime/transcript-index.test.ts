/**
 * Tests for the canonical transcript index.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  indexTranscript,
  findTranscriptByRunId,
  finalizeTranscriptIndex,
} from "./transcript-index.js";

let tmpDir: string;
const origHome = process.env.HOME;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ibtest-tidx-"));
  process.env.HOME = tmpDir;
});

afterEach(async () => {
  process.env.HOME = origHome;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("transcript-index", () => {
  it("indexTranscript then findTranscriptByRunId returns the entry", async () => {
    const runId = "run-abc123";
    const transcriptPath = "/tmp/abc123.jsonl";
    await indexTranscript({
      runId,
      sessionKey: "sk-abc",
      agentId: "agent-1",
      label: "test run",
      spawnedAt: 1000,
      transcriptPath,
    });

    const found = await findTranscriptByRunId(runId);
    expect(found).not.toBeNull();
    expect(found!.runId).toBe(runId);
    expect(found!.transcriptPath).toBe(transcriptPath);
    expect(found!.spawnedAt).toBe(1000);
  });

  it("findTranscriptByRunId returns null when no entry exists", async () => {
    const found = await findTranscriptByRunId("nonexistent-run");
    expect(found).toBeNull();
  });

  it("finalizeTranscriptIndex appends a finishedAt entry and it becomes the latest", async () => {
    const runId = "run-def456";
    const tp = "/tmp/def456.jsonl";
    await indexTranscript({
      runId,
      sessionKey: "sk-def",
      agentId: "a",
      label: "r",
      spawnedAt: 1000,
      transcriptPath: tp,
    });
    await finalizeTranscriptIndex(runId, tp, "sk-def", "a", "r", 1000, 2000);

    const found = await findTranscriptByRunId(runId);
    expect(found!.finishedAt).toBe(2000);
  });

  it("latest entry wins when duplicate runIds exist", async () => {
    const runId = "run-ghi789";
    const tp1 = "/tmp/v1.jsonl";
    const tp2 = "/tmp/v2.jsonl";
    await indexTranscript({
      runId,
      sessionKey: "sk",
      agentId: "a",
      label: "",
      spawnedAt: 100,
      transcriptPath: tp1,
    });
    await indexTranscript({
      runId,
      sessionKey: "sk",
      agentId: "a",
      label: "",
      spawnedAt: 200,
      transcriptPath: tp2,
    });

    const found = await findTranscriptByRunId(runId);
    expect(found!.transcriptPath).toBe(tp2);
  });
});
