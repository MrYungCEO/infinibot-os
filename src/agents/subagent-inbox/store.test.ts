import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureClaudeInboxHookScript, ensureOpencodeInboxPlugin } from "./hook-scripts.js";
import { prepareClaudeInboxSettings, prepareOpencodeInboxPlugin } from "./launch.js";
import {
  ackInboxMessages,
  claimPendingInboxMessages,
  enqueueInboxMessage,
  expireQueuedInboxMessages,
  extractInboxAckIds,
  formatInboxMessages,
  inboxDirForRun,
  listInboxRunIds,
  readInbox,
} from "./store.js";

let stateDir: string;
const prevState = process.env.INFINIBOT_STATE_DIR;

beforeEach(() => {
  stateDir = mkdtempSync(path.join(os.tmpdir(), "ib-inbox-"));
  process.env.INFINIBOT_STATE_DIR = stateDir;
});
afterEach(() => {
  if (prevState === undefined) delete process.env.INFINIBOT_STATE_DIR;
  else process.env.INFINIBOT_STATE_DIR = prevState;
  rmSync(stateDir, { recursive: true, force: true });
});

function runHook(event: string, dir: string, stdin = "{}") {
  const script = ensureClaudeInboxHookScript();
  const r = spawnSync(process.execPath, [script, event, dir], { input: stdin, encoding: "utf8" });
  return { code: r.status, out: r.stdout.trim() };
}

describe("subagent inbox store", () => {
  it("persists under the state dir and folds queued → delivered → acknowledged", () => {
    const m = enqueueInboxMessage({ runId: "run-1", text: "also add tests", from: "op" });
    expect(inboxDirForRun("run-1").startsWith(stateDir)).toBe(true);
    expect(readInbox("run-1")).toMatchObject([{ id: m.id, status: "queued" }]);

    const claimed = claimPendingInboxMessages("run-1", "mcp-piggyback");
    expect(claimed.map((c) => c.id)).toEqual([m.id]);
    expect(readInbox("run-1")[0]).toMatchObject({
      status: "delivered",
      deliveredVia: "mcp-piggyback",
    });
    // Claimed exactly once.
    expect(claimPendingInboxMessages("run-1", "inbox-tool")).toEqual([]);

    expect(ackInboxMessages("run-1", [m.id, "im_unknown000"], "agent-output")).toEqual([m.id]);
    expect(readInbox("run-1")[0]!.status).toBe("acknowledged");
    expect(listInboxRunIds()).toContain("run-1");
  });

  it("expires only still-queued messages", () => {
    const a = enqueueInboxMessage({ runId: "run-2", text: "a", from: "op" });
    claimPendingInboxMessages("run-2", "inbox-tool");
    const b = enqueueInboxMessage({ runId: "run-2", text: "b", from: "op" });
    expect(expireQueuedInboxMessages("run-2", "ended")).toEqual([b.id]);
    const byId = Object.fromEntries(readInbox("run-2").map((m) => [m.id, m.status]));
    expect(byId).toEqual({ [a.id]: "delivered", [b.id]: "expired" });
  });

  it("formatted delivery never self-acknowledges, and ACK tokens are extracted", () => {
    const m = enqueueInboxMessage({ runId: "run-3", text: "stop after step 2", from: "op" });
    const text = formatInboxMessages([m]);
    expect(text).toContain(`[OPERATOR MESSAGE id=${m.id}`);
    expect(text).toContain("stop after step 2");
    expect(extractInboxAckIds(text)).toEqual([]);
    // Raw stream-json line with an escaped newline before the token.
    const line = JSON.stringify({ type: "assistant", text: `done.\nACK ${m.id}` });
    expect(extractInboxAckIds(line)).toEqual([m.id]);
    expect(extractInboxAckIds(`ACK: ${m.id} and ACK ${m.id}`)).toEqual([m.id, m.id]);
  });
});

describe("Claude Code hook script (real process)", () => {
  it("PostToolUse injects additionalContext once and records delivery", () => {
    const m = enqueueInboxMessage({ runId: "run-h", text: "write BANANA", from: "op" });
    const dir = inboxDirForRun("run-h");
    const first = runHook("PostToolUse", dir, JSON.stringify({ hook_event_name: "PostToolUse" }));
    expect(first.code).toBe(0);
    const parsed = JSON.parse(first.out);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(parsed.hookSpecificOutput.additionalContext).toBe(formatInboxMessages([m]));
    expect(readInbox("run-h")[0]).toMatchObject({
      status: "delivered",
      deliveredVia: "claude-hook:PostToolUse",
    });
    // Nothing pending → silent success, so the agent loop is untouched.
    expect(runHook("PostToolUse", dir)).toEqual({ code: 0, out: "" });
  });

  it("Stop blocks the stop with the pending message as the reason", () => {
    const m = enqueueInboxMessage({ runId: "run-s", text: "one more thing", from: "op" });
    const r = runHook("Stop", inboxDirForRun("run-s"));
    expect(JSON.parse(r.out)).toEqual({ decision: "block", reason: formatInboxMessages([m]) });
    expect(runHook("Stop", inboxDirForRun("run-s")).out).toBe("");
  });

  it("is a silent no-op for a missing inbox dir", () => {
    expect(runHook("PostToolUse", path.join(stateDir, "nope"))).toEqual({ code: 0, out: "" });
  });

  it("launch wiring writes --settings with PostToolUse + Stop hooks for the run", () => {
    const file = prepareClaudeInboxSettings("run-l")!;
    const settings = JSON.parse(readFileSync(file, "utf8"));
    const post = settings.hooks.PostToolUse[0].hooks[0].command as string;
    expect(post).toContain("claude-inbox-hook.mjs");
    expect(post).toContain("PostToolUse");
    expect(post).toContain(inboxDirForRun("run-l"));
    expect(settings.hooks.Stop[0].hooks[0].command).toContain("Stop");
    expect(prepareClaudeInboxSettings(undefined)).toBeNull();
    process.env.INFINIBOT_SUBAGENT_INBOX = "0";
    try {
      expect(prepareClaudeInboxSettings("run-l")).toBeNull();
    } finally {
      delete process.env.INFINIBOT_SUBAGENT_INBOX;
    }
  });
});

describe("OpenCode plugin (real module)", () => {
  it("appends pending messages to the next tool output", async () => {
    const wiring = prepareOpencodeInboxPlugin("run-o")!;
    expect(wiring.pluginUrl).toBe(pathToFileURL(ensureOpencodeInboxPlugin()).href);
    const m = enqueueInboxMessage({ runId: "run-o", text: "switch to plan B", from: "op" });
    const prevDir = process.env.INFINIBOT_SUBAGENT_INBOX_DIR;
    process.env.INFINIBOT_SUBAGENT_INBOX_DIR = wiring.env.INFINIBOT_SUBAGENT_INBOX_DIR;
    try {
      const mod = await import(`${wiring.pluginUrl}?t=${Date.now()}`);
      const hooks = await mod.InfinibotOperatorInbox({});
      const output = { output: "ls result" };
      await hooks["tool.execute.after"]({ tool: "bash" }, output);
      expect(output.output).toBe(`ls result\n\n${formatInboxMessages([m])}`);
      const again = { output: "x" };
      await hooks["tool.execute.after"]({ tool: "bash" }, again);
      expect(again.output).toBe("x");
      expect(readInbox("run-o")[0]!.deliveredVia).toBe("opencode-plugin");
    } finally {
      if (prevDir === undefined) delete process.env.INFINIBOT_SUBAGENT_INBOX_DIR;
      else process.env.INFINIBOT_SUBAGENT_INBOX_DIR = prevDir;
    }
  });
});
