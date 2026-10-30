/**
 * Standalone delivery shims that run INSIDE the coder CLI process and drain the
 * run's inbox (store.ts layout) at tool boundaries:
 *
 *   • Claude Code — a hook command wired via `--settings`:
 *       PostToolUse → `hookSpecificOutput.additionalContext` (injected mid-turn,
 *                     right after the tool result, before the next model step)
 *       Stop        → `{decision:"block", reason}` (a message that lands while
 *                     the agent is wrapping up keeps it going instead of being lost)
 *   • OpenCode — a plugin (`tool.execute.after`) that appends the messages to
 *     the tool output the model sees next.
 *
 * They are emitted as plain dependency-free ESM files under
 * `<stateDir>/subagents/inbox/_bin/` at spawn time (not shipped as build
 * assets: vendored non-TS files are easy to lose from dist, and a file on disk
 * keeps working for a tmux-durable child after the gateway that wrote it has
 * restarted or been rebuilt).
 *
 * The claim/format logic mirrors store.ts exactly. Every failure path exits
 * silently — a broken inbox must never break the agent's tool loop.
 */

import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { inboxRootDir } from "./store.js";

/** Shared runtime (claim + format) embedded in both shims. */
const SHARED_RUNTIME = String.raw`
import fs from "node:fs";
import path from "node:path";

function readJsonl(file) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return []; }
  const out = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch {}
  }
  return out;
}

function pending(dir) {
  const msgs = readJsonl(path.join(dir, "messages.jsonl"));
  const done = new Set();
  for (const ev of readJsonl(path.join(dir, "events.jsonl"))) {
    if (ev && (ev.type === "delivered" || ev.type === "acked" || ev.type === "expired")) done.add(ev.id);
  }
  return msgs.filter((m) => m && typeof m.id === "string" && !done.has(m.id))
    .sort((a, b) => a.createdAt - b.createdAt);
}

function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function withLock(dir, fn) {
  const lock = path.join(dir, ".lock");
  const deadline = Date.now() + 3000;
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch {
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 10000) { fs.rmSync(lock, { recursive: true, force: true }); continue; }
      } catch { continue; }
      if (Date.now() > deadline) return [];
      sleep(25);
    }
  }
  try { return fn(); } finally { try { fs.rmSync(lock, { recursive: true, force: true }); } catch {} }
}

export function claim(dir, via) {
  if (!dir || !fs.existsSync(path.join(dir, "messages.jsonl"))) return [];
  return withLock(dir, () => {
    const now = Date.now();
    const got = pending(dir);
    for (const m of got) {
      fs.appendFileSync(path.join(dir, "events.jsonl"), JSON.stringify({ id: m.id, type: "delivered", at: now, via }) + "\n");
    }
    return got;
  });
}

export function format(messages) {
  if (messages.length === 0) return "";
  const blocks = messages.map((m) =>
    "[OPERATOR MESSAGE id=" + m.id + " from=" + m.from + " sent=" + new Date(m.createdAt).toISOString() + "]\n" + m.text + "\n[/OPERATOR MESSAGE]");
  return [
    ...blocks,
    "The " + (messages.length === 1 ? "message above is" : "messages above are") + " live input from your operator, sent while you are working. " +
      "Treat it as an authoritative amendment to your task and act on it now — it overrides any conflicting part of the original brief. " +
      'Confirm receipt by writing the token ACK followed by the message id in your next reply (or call the subagent_inbox tool with action "ack").',
  ].join("\n\n");
}
`;

/** Claude Code hook: `node claude-inbox-hook.mjs <PostToolUse|Stop> <inboxDir>`. */
export const CLAUDE_INBOX_HOOK_SOURCE = `// InfiniBot in-flight operator inbox — Claude Code hook (GENERATED, do not edit)
${SHARED_RUNTIME}
const [event, dir] = process.argv.slice(2);
let settled = false;
function run() {
  if (settled) return;
  settled = true;
  try {
    const got = claim(dir, "claude-hook:" + event);
    if (got.length === 0) return;
    const text = format(got);
    const out = event === "Stop"
      ? { decision: "block", reason: text }
      : { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
    process.stdout.write(JSON.stringify(out));
  } catch {}
}
// Drain the hook input (Claude pipes JSON on stdin) before answering; never hang on it.
process.stdin.on("data", () => {});
process.stdin.on("end", run);
process.stdin.on("error", run);
setTimeout(run, 1500).unref();
`;

/** OpenCode plugin: reads the inbox dir from INFINIBOT_SUBAGENT_INBOX_DIR. */
export const OPENCODE_INBOX_PLUGIN_SOURCE = `// InfiniBot in-flight operator inbox — OpenCode plugin (GENERATED, do not edit)
${SHARED_RUNTIME}
export const InfinibotOperatorInbox = async () => ({
  "tool.execute.after": async (_input, output) => {
    try {
      const got = claim(process.env.INFINIBOT_SUBAGENT_INBOX_DIR, "opencode-plugin");
      if (got.length === 0) return;
      const prev = output && output.output != null ? String(output.output) : "";
      output.output = prev + "\\n\\n" + format(got);
    } catch {}
  },
});
`;

function binDir(): string {
  return path.join(inboxRootDir(), "_bin");
}

/** Write `source` to `name` under _bin/ when missing or stale; returns the path. */
function ensureScript(name: string, source: string): string {
  const dir = binDir();
  const file = path.join(dir, name);
  const want = crypto.createHash("sha1").update(source).digest("hex");
  try {
    if (existsSync(file)) {
      const have = crypto.createHash("sha1").update(readFileSync(file)).digest("hex");
      if (have === want) return file;
    }
  } catch {
    /* rewrite below */
  }
  mkdirSync(dir, { recursive: true });
  // Write-then-rename would be nicer, but a concurrent identical write is harmless.
  writeFileSync(file, source, { encoding: "utf8", mode: 0o644 });
  return file;
}

export function ensureClaudeInboxHookScript(): string {
  return ensureScript("claude-inbox-hook.mjs", CLAUDE_INBOX_HOOK_SOURCE);
}

export function ensureOpencodeInboxPlugin(): string {
  return ensureScript("opencode-inbox-plugin.mjs", OPENCODE_INBOX_PLUGIN_SOURCE);
}
