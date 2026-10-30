import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { loadSessionStore, saveSessionStore } from "../config/sessions.js";
import {
  isTopLevelTranscript,
  startClaudeCodeWatcher,
  type ClaudeCodeWatcherHandle,
} from "./claude-code-watcher.js";

/** Wait until predicate becomes true or timeout. */
async function waitFor<T>(check: () => T | undefined, timeoutMs = 4000): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = check();
    if (value !== undefined && value !== null && value !== false) return value as T;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`waitFor timeout after ${timeoutMs}ms`);
}

function buildLine(obj: Record<string, unknown>): string {
  return JSON.stringify(obj) + "\n";
}

describe("startClaudeCodeWatcher", () => {
  let tmpDir: string;
  let projectsDir: string;
  let storePath: string;
  let handle: ClaudeCodeWatcherHandle | null = null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "infinibot-cc-watcher-test-"));
    projectsDir = path.join(tmpDir, "projects");
    storePath = path.join(tmpDir, "sessions.json");
    fs.mkdirSync(projectsDir, { recursive: true });
  });

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = null;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("upserts a session entry when a fresh transcript appears", async () => {
    const projectDir = path.join(projectsDir, "C--Users-Admin-Desktop-CLAWDBOT-moltbot");
    fs.mkdirSync(projectDir, { recursive: true });
    const sessionId = "11111111-1111-1111-1111-111111111111";
    const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);

    fs.writeFileSync(
      transcriptPath,
      buildLine({
        type: "user",
        message: { role: "user", content: "hello" },
        cwd: "C:\\Users\\Developer\\Projects\\infinibot",
        gitBranch: "MASTER",
        version: "2.1.123",
        sessionId,
      }),
    );

    handle = startClaudeCodeWatcher({
      projectsDir,
      storePath,
      processAll: true,
      flushDebounceMs: 500,
    });
    await handle.ready();

    const entry = await waitFor(() => {
      const store = loadSessionStore(storePath, { skipCache: true });
      const found = store[`claude-code:${sessionId}`];
      return found?.sessionId ? found : undefined;
    });

    expect(entry.sessionId).toBe(sessionId);
    expect(entry.sessionFile).toBe(transcriptPath);
    // The label is the last segment of the transcript's cwd, whatever the
    // separator style of the machine that wrote it.
    expect(entry.label).toBe("infinibot");
    expect(entry.displayName).toContain("Claude Code");
    expect(entry.displayName).toContain("infinibot");
    expect(entry.displayName).toContain("@MASTER");
    expect(entry.channel).toBe("claude-code");
  });

  test("captures the latest assistant model + token usage from the tail", async () => {
    const projectDir = path.join(projectsDir, "proj-1");
    fs.mkdirSync(projectDir, { recursive: true });
    const sessionId = "22222222-2222-2222-2222-222222222222";
    const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);

    handle = startClaudeCodeWatcher({
      projectsDir,
      storePath,
      processAll: true,
      flushDebounceMs: 500,
    });

    fs.writeFileSync(
      transcriptPath,
      [
        buildLine({
          type: "user",
          message: { role: "user", content: "hi" },
          cwd: "/tmp/proj-1",
          sessionId,
        }),
        buildLine({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
            model: "claude-opus-4-7",
            usage: { input_tokens: 100, output_tokens: 50 },
          },
          sessionId,
        }),
      ].join(""),
    );

    const entry = await waitFor(() => {
      const store = loadSessionStore(storePath, { skipCache: true });
      const found = store[`claude-code:${sessionId}`];
      return found?.model ? found : undefined;
    });

    expect(entry.model).toBe("claude-opus-4-7");
    expect(entry.inputTokens).toBe(100);
    expect(entry.outputTokens).toBe(50);
    expect(entry.totalTokens).toBe(150);
  });

  test("updates the entry on append (change event)", async () => {
    const projectDir = path.join(projectsDir, "proj-2");
    fs.mkdirSync(projectDir, { recursive: true });
    const sessionId = "33333333-3333-3333-3333-333333333333";
    const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);

    fs.writeFileSync(
      transcriptPath,
      buildLine({
        type: "user",
        message: { role: "user", content: "first" },
        cwd: "/tmp/proj-2",
        sessionId,
      }),
    );

    handle = startClaudeCodeWatcher({
      projectsDir,
      storePath,
      processAll: true,
      flushDebounceMs: 500,
    });

    const initial = await waitFor(() => {
      const store = loadSessionStore(storePath, { skipCache: true });
      return store[`claude-code:${sessionId}`];
    });
    expect(initial.sessionId).toBe(sessionId);
    const initialUpdatedAt = initial.updatedAt;

    // Append an assistant turn with usage
    await new Promise((r) => setTimeout(r, 50));
    fs.appendFileSync(
      transcriptPath,
      buildLine({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "answer" }],
          model: "claude-sonnet-4-6",
          usage: { input_tokens: 200, output_tokens: 75 },
        },
        sessionId,
      }),
    );

    const updated = await waitFor(() => {
      const store = loadSessionStore(storePath, { skipCache: true });
      const found = store[`claude-code:${sessionId}`];
      return found?.model === "claude-sonnet-4-6" ? found : undefined;
    });

    expect(updated.outputTokens).toBe(75);
    expect(updated.updatedAt).toBeGreaterThanOrEqual(initialUpdatedAt);
  });

  test("ignores stale transcripts on startup when freshness filter is on", async () => {
    const projectDir = path.join(projectsDir, "proj-stale");
    fs.mkdirSync(projectDir, { recursive: true });
    const sessionId = "44444444-4444-4444-4444-444444444444";
    const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);

    fs.writeFileSync(
      transcriptPath,
      buildLine({
        type: "user",
        message: { role: "user", content: "ancient" },
        cwd: "/tmp/proj-stale",
        sessionId,
      }),
    );

    // Backdate to 30 days ago.
    const ancient = Date.now() - 30 * 24 * 60 * 60 * 1000;
    fs.utimesSync(transcriptPath, new Date(ancient), new Date(ancient));

    handle = startClaudeCodeWatcher({ projectsDir, storePath, flushDebounceMs: 500 });

    // Give it time — should NOT appear.
    await new Promise((r) => setTimeout(r, 800));
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store[`claude-code:${sessionId}`]).toBeUndefined();
  });

  test("does nothing when projects dir is empty", async () => {
    handle = startClaudeCodeWatcher({
      projectsDir,
      storePath,
      processAll: true,
      flushDebounceMs: 500,
    });
    await new Promise((r) => setTimeout(r, 200));
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(Object.keys(store)).toHaveLength(0);
    expect(handle.size()).toBe(0);
  });

  test("ignores subagent transcripts nested under a session directory", async () => {
    const projectDir = path.join(projectsDir, "proj-sub");
    const sessionId = "55555555-5555-5555-5555-555555555555";
    const subagentDir = path.join(projectDir, sessionId, "subagents");
    fs.mkdirSync(subagentDir, { recursive: true });

    // Top-level transcript — should be picked up.
    const topPath = path.join(projectDir, `${sessionId}.jsonl`);
    fs.writeFileSync(
      topPath,
      buildLine({
        type: "user",
        message: { role: "user", content: "parent" },
        cwd: "/tmp/proj-sub",
        sessionId,
      }),
    );

    // Subagent transcript — should be ignored.
    const subagentId = "agent-deadbeefcafebabe1";
    const subagentPath = path.join(subagentDir, `${subagentId}.jsonl`);
    fs.writeFileSync(
      subagentPath,
      buildLine({
        type: "user",
        message: { role: "user", content: "child" },
        cwd: "/tmp/proj-sub",
        sessionId: subagentId,
      }),
    );

    handle = startClaudeCodeWatcher({
      projectsDir,
      storePath,
      processAll: true,
      flushDebounceMs: 500,
    });
    await handle.ready();

    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store[`claude-code:${sessionId}`]).toBeDefined();
    expect(store[`claude-code:${subagentId}`]).toBeUndefined();
  });

  test("batches multiple add events into a single store flush", async () => {
    const projectDir = path.join(projectsDir, "proj-many");
    fs.mkdirSync(projectDir, { recursive: true });

    const ids = Array.from({ length: 5 }, (_, i) => `${i}aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`);
    for (const sessionId of ids) {
      fs.writeFileSync(
        path.join(projectDir, `${sessionId}.jsonl`),
        buildLine({
          type: "user",
          message: { role: "user", content: "x" },
          cwd: "/tmp/proj-many",
          sessionId,
        }),
      );
    }

    handle = startClaudeCodeWatcher({
      projectsDir,
      storePath,
      processAll: true,
      flushDebounceMs: 500,
    });
    await handle.ready();

    const store = loadSessionStore(storePath, { skipCache: true });
    for (const sessionId of ids) {
      expect(store[`claude-code:${sessionId}`]).toBeDefined();
    }
    // No left-over pending writes after ready resolves.
    expect(handle.size()).toBe(0);
  });

  test("prunes existing claude-code rows whose sessionFile is missing or under subagents/", async () => {
    const projectDir = path.join(projectsDir, "proj-prune");
    fs.mkdirSync(projectDir, { recursive: true });

    // Pre-seed the store with three rows BEFORE starting the watcher:
    //   - aaa: sessionFile points to a file that doesn't exist on disk
    //   - bbb: sessionFile points to a subagent path
    //   - ccc: sessionFile points to a real top-level transcript
    const goodSessionId = "ccccccc1-cccc-cccc-cccc-cccccccccccc";
    const goodPath = path.join(projectDir, `${goodSessionId}.jsonl`);
    fs.writeFileSync(
      goodPath,
      buildLine({
        type: "user",
        message: { role: "user", content: "ok" },
        cwd: "/tmp/proj-prune",
        sessionId: goodSessionId,
      }),
    );

    const subagentDir = path.join(projectDir, "parent-uuid", "subagents");
    fs.mkdirSync(subagentDir, { recursive: true });
    const subagentPath = path.join(subagentDir, "agent-xyz.jsonl");
    fs.writeFileSync(subagentPath, "");

    await saveSessionStore(storePath, {
      "claude-code:aaaaaa": {
        sessionId: "aaaaaa",
        sessionFile: path.join(projectDir, "missing.jsonl"),
        updatedAt: Date.now(),
      },
      "claude-code:bbbbbb": {
        sessionId: "bbbbbb",
        sessionFile: subagentPath,
        updatedAt: Date.now(),
      },
      "claude-code:ccccccc1-cccc-cccc-cccc-cccccccccccc": {
        sessionId: goodSessionId,
        sessionFile: goodPath,
        updatedAt: Date.now(),
      },
    });

    handle = startClaudeCodeWatcher({
      projectsDir,
      storePath,
      processAll: true,
      flushDebounceMs: 500,
    });
    await handle.ready();

    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store["claude-code:aaaaaa"]).toBeUndefined();
    expect(store["claude-code:bbbbbb"]).toBeUndefined();
    expect(store[`claude-code:${goodSessionId}`]).toBeDefined();
  });
});

describe("isTopLevelTranscript", () => {
  const projectsDir = path.join(os.tmpdir(), "fake-projects");

  test("accepts <projectsDir>/<dir>/<file>.jsonl", () => {
    expect(
      isTopLevelTranscript(path.join(projectsDir, "C--Users-Admin", "abc.jsonl"), projectsDir),
    ).toBe(true);
  });

  test("rejects subagent paths", () => {
    expect(
      isTopLevelTranscript(
        path.join(projectsDir, "C--Users-Admin", "session", "subagents", "agent-x.jsonl"),
        projectsDir,
      ),
    ).toBe(false);
  });

  test("rejects non-.jsonl files", () => {
    expect(
      isTopLevelTranscript(path.join(projectsDir, "C--Users-Admin", "abc.meta.json"), projectsDir),
    ).toBe(false);
  });

  test("rejects files outside the projects dir", () => {
    expect(isTopLevelTranscript(path.join(os.tmpdir(), "elsewhere.jsonl"), projectsDir)).toBe(
      false,
    );
  });

  test("rejects files at the projects-dir root (no subfolder)", () => {
    expect(isTopLevelTranscript(path.join(projectsDir, "stray.jsonl"), projectsDir)).toBe(false);
  });
});
