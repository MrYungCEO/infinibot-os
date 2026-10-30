import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { classifyExit } from "./classifier.js";
import { RESULT_CLOSE, RESULT_OPEN } from "./contract.js";
import { digestTranscript } from "./transcript.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const W5 = readFileSync(path.join(here, "__fixtures__", "w5-premature-exit.stdout.log"), "utf8");

function claudeStream(texts: string[], opts: { tasksAtResult?: number } = {}): string {
  const lines: string[] = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "sess-1" }),
  ];
  for (const t of texts) {
    lines.push(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: t }] },
        session_id: "sess-1",
      }),
    );
  }
  if (opts.tasksAtResult) {
    lines.push(
      JSON.stringify({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: Array.from({ length: opts.tasksAtResult }, (_, i) => ({
          task_id: `b${i}`,
          description: `npx vitest ${i}`,
          status: "running",
        })),
      }),
    );
  }
  lines.push(
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: texts[texts.length - 1],
      session_id: "sess-1",
    }),
  );
  return `${lines.join("\n")}\n`;
}

describe("digestTranscript", () => {
  it("extracts the W5 failure: final 'I'll wait for the notification.' with background tasks still running", () => {
    const d = digestTranscript(W5);
    expect(d.finalText).toBe("I'll wait for the notification.");
    expect(d.sawResultEvent).toBe(true);
    expect(d.sessionId).toBe("2b44e53c-57f8-41da-84c5-08766ec03e55");
    expect(d.pendingBackgroundTasks.length).toBeGreaterThanOrEqual(2);
    expect(d.pendingBackgroundTasks.map((t) => t.description).join(" ")).toMatch(
      /vitest|pnpm build/,
    );
    expect(d.killedAfterResult.length).toBeGreaterThanOrEqual(2);
  });

  it("reads codex exec --json agent messages + thread id", () => {
    const raw = [
      { type: "thread.started", thread_id: "th-9" },
      { type: "item.completed", item: { type: "agent_message", text: "hello" } },
      { type: "item.completed", item: { type: "command_execution", command: "ls" } },
      { type: "item.completed", item: { type: "agent_message", text: "final" } },
      { type: "turn.completed" },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n");
    const d = digestTranscript(raw);
    expect(d.sessionId).toBe("th-9");
    expect(d.finalText).toBe("final");
    expect(d.assistantTexts).toEqual(["hello", "final"]);
  });

  it("reads opencode text parts + sessionID and plain text output", () => {
    const oc = [
      { type: "step_start", sessionID: "ses_1" },
      { type: "text", sessionID: "ses_1", part: { text: "done here" } },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n");
    expect(digestTranscript(oc)).toMatchObject({ sessionId: "ses_1", finalText: "done here" });
    expect(digestTranscript("plain output\nline 2").finalText).toBe("plain output\nline 2");
  });
});

describe("classifyExit", () => {
  it("classifies the real W5 run as PREMATURE (not success) despite exit 0", () => {
    const c = classifyExit({ exitCode: 0, digest: digestTranscript(W5) });
    expect(c.kind).toBe("premature");
    expect(c.reasons.join(" ")).toMatch(/background task/);
    expect(c.reasons.join(" ")).toMatch(/no RESULT block/);
  });

  it("complete when a RESULT block says done and nothing is pending", () => {
    const text = `All done.\n${RESULT_OPEN}\n{"status":"done","summary":"ok"}\n${RESULT_CLOSE}`;
    const c = classifyExit({ exitCode: 0, digest: digestTranscript(claudeStream([text])) });
    expect(c.kind).toBe("complete");
    expect(c.result?.summary).toBe("ok");
  });

  it("a done RESULT with background tasks still running is still premature", () => {
    const text = `${RESULT_OPEN}{"status":"done","summary":"ok"}${RESULT_CLOSE}`;
    const c = classifyExit({
      exitCode: 0,
      digest: digestTranscript(claudeStream([text], { tasksAtResult: 1 })),
    });
    expect(c.kind).toBe("premature");
  });

  it("blocked / needs_input come straight from the RESULT", () => {
    const b = `${RESULT_OPEN}{"status":"blocked","summary":"no creds","open_issues":["missing key"]}${RESULT_CLOSE}`;
    expect(classifyExit({ exitCode: 0, digest: digestTranscript(claudeStream([b])) }).kind).toBe(
      "blocked",
    );
  });

  it("waiting language without a RESULT is premature; neutral text is no_result", () => {
    for (const last of [
      "Next I'll run the tests.",
      "Let me check the build output.",
      "The build is still running in the background.",
    ]) {
      expect(
        classifyExit({ exitCode: 0, digest: digestTranscript(claudeStream([last])) }).kind,
      ).toBe("premature");
    }
    expect(
      classifyExit({
        exitCode: 0,
        digest: digestTranscript(claudeStream(["Implemented the change."])),
      }).kind,
    ).toBe("no_result");
  });

  it("non-zero exit or kill without a RESULT is failed", () => {
    expect(
      classifyExit({ exitCode: 1, digest: digestTranscript(claudeStream(["boom"])) }).kind,
    ).toBe("failed");
    expect(classifyExit({ exitCode: null, killed: true, digest: digestTranscript("") }).kind).toBe(
      "failed",
    );
  });

  it("extracts the provider's reason from a failed Codex JSONL run", () => {
    const providerMessage =
      "The 'codex' model is not supported when using Codex with a ChatGPT account.";
    const extraText = `${JSON.stringify({
      type: "error",
      error: { message: JSON.stringify({ error: { message: providerMessage } }) },
    })}\n`;
    const c = classifyExit({ exitCode: 1, digest: digestTranscript(""), extraText });
    expect(c.kind).toBe("failed");
    expect(c.reasons[0]).toContain(providerMessage);
    expect(c.reasons).toContain("the process exited with code 1");
  });

  it("reports an unavailable durable workdir instead of claiming the CLI is missing", () => {
    const c = classifyExit({
      exitCode: 127,
      digest: digestTranscript(""),
      extraText: "Coder working directory is unavailable: C:\\Users\\Admin\\clawd",
    });
    expect(c.reasons[0]).toContain("working directory is unavailable");
    expect(c.reasons.join(" ")).not.toContain("CLI isn't installed");
  });
});
