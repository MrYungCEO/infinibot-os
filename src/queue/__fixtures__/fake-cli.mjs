#!/usr/bin/env node
// Fake coding CLI for queue runner integration tests. One script, installed
// as claude / codex / opencode / gemini (symlinks); behaviour is read from
// `<cwd>/.fake-cli.json` and every invocation is logged to
// `<cwd>/.fake-cli-calls.jsonl`, so tests can assert launch args
// (--resume / exec resume / --session / -r, --model, system prompt).
//
// Modes (per backend, optionally a list consumed one per invocation):
//   success   → RESULT done
//   premature → no RESULT ("I'll wait for the build…"); resumes then succeed
//   fail      → exit 1, no RESULT
//   hang      → sleeps forever, spawning a grandchild sleeper (tree-kill check)
//   crash     → killed by SIGKILL mid-run (exit 137)
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

// Large prompts arrive via files, like the real CLIs read them: opencode
// `instructions` paths and claude `--append-system-prompt-file`.
function promptFiles() {
  const paths = [];
  const i = args.indexOf("--append-system-prompt-file");
  if (i >= 0 && args[i + 1]) paths.push(args[i + 1]);
  try {
    const cfg = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? "{}");
    for (const p of cfg.instructions ?? []) if (path.isAbsolute(p)) paths.push(p);
  } catch {
    /* not JSON */
  }
  return paths
    .map((p) => {
      try {
        return fs.readFileSync(p, "utf8");
      } catch {
        return "";
      }
    })
    .join("\n");
}

const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const backend = name === "claude" ? "claude-code" : name;
const cwd = process.cwd();

if (args[0] === "--version" || args[0] === "-v") {
  console.log(`${name} 9.9.9-fake`);
  process.exit(0);
}
if (name === "opencode" && args[0] === "models") process.exit(0);
if (name === "claude" && args[0] === "mcp") process.exit(0);
if (name === "codex" && (args[0] === "mcp" || args[0] === "login")) process.exit(0);

const cfgPath = path.join(cwd, ".fake-cli.json");
const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, "utf8")) : {};
const counterPath = path.join(cwd, `.fake-cli-${backend}.count`);
const n = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, "utf8")) : 0;
fs.writeFileSync(counterPath, String(n + 1));
let mode = cfg[backend] ?? "success";
if (Array.isArray(mode)) mode = mode[Math.min(n, mode.length - 1)];

const flag = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};
let resume = null;
if (backend === "claude-code") resume = flag("--resume") ?? null;
if (backend === "opencode") resume = flag("--session") ?? null;
if (backend === "gemini") resume = flag("-r") ?? null;
if (backend === "codex") {
  const i = args.indexOf("resume");
  resume = i >= 0 ? args[i + 1] : null;
}
const model = flag("--model") ?? flag("-m") ?? null;
const session = resume ?? `${backend}-${randomUUID().slice(0, 8)}`;
fs.appendFileSync(
  path.join(cwd, ".fake-cli-calls.jsonl"),
  JSON.stringify({
    backend,
    n,
    mode,
    resume,
    model,
    session,
    pid: process.pid,
    argv: args,
    contract: /Verified completion/.test(
      args.join(" ") + (process.env.OPENCODE_CONFIG_CONTENT ?? "") + promptFiles(),
    ),
    promptTail: args[args.length - 1]?.slice(-400),
  }) + "\n",
);

const RESULT = (summary) =>
  `Work finished.\n<<<RESULT\n${JSON.stringify({ status: "done", summary, commits: [], files_changed: [], claims: [], checks_run: [], screenshots: [], open_issues: [] })}\nRESULT>>>`;

function emit(text) {
  switch (backend) {
    case "claude-code":
      console.log(JSON.stringify({ type: "system", subtype: "init", session_id: session }));
      console.log(
        JSON.stringify({
          type: "assistant",
          session_id: session,
          message: { content: [{ type: "text", text }] },
        }),
      );
      console.log(
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: text,
          session_id: session,
        }),
      );
      break;
    case "codex":
      console.log(JSON.stringify({ type: "thread.started", thread_id: session }));
      console.log(
        JSON.stringify({ type: "item.completed", item: { id: "i1", type: "agent_message", text } }),
      );
      console.log(JSON.stringify({ type: "turn.completed", usage: {} }));
      break;
    case "opencode":
      console.log(JSON.stringify({ type: "step_start", sessionID: session }));
      console.log(JSON.stringify({ type: "text", sessionID: session, part: { text } }));
      console.log(JSON.stringify({ type: "step_finish", sessionID: session }));
      break;
    case "gemini":
      console.log(JSON.stringify({ session_id: session, response: text, stats: {} }));
      break;
  }
}

if (mode === "hang") {
  // Early session event so the runner learns the session id, then hang with a grandchild.
  if (backend === "claude-code")
    console.log(JSON.stringify({ type: "system", subtype: "init", session_id: session }));
  if (backend === "codex")
    console.log(JSON.stringify({ type: "thread.started", thread_id: session }));
  if (backend === "opencode")
    console.log(JSON.stringify({ type: "step_start", sessionID: session }));
  const child = spawn("sleep", ["600"], { stdio: "ignore" });
  fs.appendFileSync(path.join(cwd, ".fake-cli-grandchildren"), `${child.pid}\n`);
  setInterval(() => {}, 1 << 30);
} else if (mode === "crash") {
  emit("working on it");
  setTimeout(() => process.kill(process.pid, "SIGKILL"), 50);
} else if (mode === "unauth") {
  console.error("ERROR codex_api: failed to connect to websocket: HTTP error: 401 Unauthorized");
  console.log(
    JSON.stringify({
      type: "error",
      message:
        "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header",
    }),
  );
  process.exit(1);
} else if (mode === "fail") {
  // Real CLIs report their session before failing.
  if (backend === "claude-code")
    console.log(JSON.stringify({ type: "system", subtype: "init", session_id: session }));
  if (backend === "codex")
    console.log(JSON.stringify({ type: "thread.started", thread_id: session }));
  if (backend === "opencode")
    console.log(JSON.stringify({ type: "step_start", sessionID: session }));
  console.error("fatal: something broke");
  process.exit(1);
} else if (mode === "premature" && !resume) {
  emit("Started the build in the background. I'll wait for the build to finish and then report.");
  process.exit(0);
} else if (mode === "slow") {
  setTimeout(
    () => {
      emit(RESULT(`${backend} completed the phase slowly`));
      process.exit(0);
    },
    Number(cfg.slowMs ?? 3000),
  );
} else {
  if (cfg.touch)
    fs.writeFileSync(
      path.join(cwd, cfg.touch.replace("{backend}", backend)),
      `made by ${backend}\n`,
    );
  emit(RESULT(`${backend} completed the phase${resume ? " (resumed)" : ""}`));
  process.exit(0);
}
