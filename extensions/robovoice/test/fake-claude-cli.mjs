#!/usr/bin/env node
/**
 * Fake Claude Code CLI for the voice-pipeline e2e: `claude -p <msg> --output-format
 * stream-json …` → init (session id), text deltas, closing result. Appends its argv
 * to $FAKE_CLI_LOG so the e2e can check the untrusted-caller flags.
 */
import fs from "node:fs";
const args = process.argv.slice(2);
if (process.env.FAKE_CLI_LOG) fs.appendFileSync(process.env.FAKE_CLI_LOG, JSON.stringify(args) + "\n");
const msg = args[args.indexOf("-p") + 1] ?? "";
const resume = args.includes("--resume") ? args[args.indexOf("--resume") + 1] : null;
const sid = resume ?? `fake-sess-${process.pid}`;
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
out({ type: "system", subtype: "init", session_id: sid });
const reply = `Claude CLI here${resume ? " again" : ""}. You said: ${msg}`;
for (const w of reply.split(/(?<= )/)) {
  out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: w } } });
  await new Promise((r) => setTimeout(r, 10));
}
out({ type: "result", result: reply, session_id: sid });
