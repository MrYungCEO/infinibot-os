import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  broadcastCompletion,
  formatTelegram,
  setVerificationBroadcaster,
  VERIFICATION_EVENT,
} from "./notify.js";
import {
  createRecord,
  getRecord,
  markTerminal,
  resetVerificationStoreForTests,
  updateRecord,
} from "./store.js";

let dir: string;
const prev = process.env.INFINIBOT_STATE_DIR;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "vc-notify-"));
  process.env.INFINIBOT_STATE_DIR = dir;
  resetVerificationStoreForTests();
});
afterEach(() => {
  setVerificationBroadcaster(null);
  if (prev === undefined) delete process.env.INFINIBOT_STATE_DIR;
  else process.env.INFINIBOT_STATE_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

function terminal(state: "verified" | "stalled") {
  createRecord({
    runId: "r1",
    childSessionKey: "c",
    requesterSessionKey: "agent:main:mcp-x",
    label: "Fix <nav>",
    task: "t",
  });
  updateRecord("r1", (r) => {
    r.result = {
      status: "done",
      summary: "done & dusted",
      commits: [],
      files_changed: [],
      claims: [],
      checks_run: [],
      screenshots: [],
      open_issues: [],
    };
    r.review = {
      verdict: state === "verified" ? "VERIFIED" : "UNVERIFIED",
      reasons: state === "verified" ? [] : ["no RESULT block"],
      evidence: [{ kind: "command", ref: "pnpm test", status: "pass", detail: "re-run exit 0" }],
      visualFiles: [],
      visualSatisfied: true,
      screenshots: [],
      llm: null,
      changedFiles: [],
      commits: [],
      reviewedAt: Date.now(),
    };
  });
  const ev = markTerminal("r1", state)!;
  return { rec: getRecord("r1")!, ev };
}

describe("completion notifications", () => {
  it("Telegram: escaped HTML, reasons, evidence and Continue/Retry/Accept/Reject for non-verified runs", () => {
    const { rec } = terminal("stalled");
    const { text, buttons } = formatTelegram(rec);
    expect(text).toContain("Fix &lt;nav&gt;");
    expect(text).toContain("done &amp; dusted");
    expect(text).toContain("no RESULT block");
    expect(text).toContain("<code>pnpm test</code>");
    expect(buttons?.flat().map((b) => b.callback_data)).toEqual([
      `vc:continue:${rec.token}`,
      `vc:retry:${rec.token}`,
      `vc:accept:${rec.token}`,
      `vc:reject:${rec.token}`,
    ]);
    for (const b of buttons!.flat())
      expect(Buffer.byteLength(b.callback_data ?? "")).toBeLessThanOrEqual(64);
  });

  it("Telegram: an https opener becomes an Open URL button; an unroutable one a text line", () => {
    const { rec } = terminal("stalled");
    const withBtn = formatTelegram(rec, { webUrl: "https://box.ts.net/m/runs/r1" });
    expect(withBtn.buttons?.at(-1)).toEqual([
      { text: "🔗 Open", url: "https://box.ts.net/m/runs/r1" },
    ]);
    expect(withBtn.text).not.toContain("Open:");
    const withLine = formatTelegram(rec, { webUrl: "http://100.64.0.1:18789/m/runs/r1" });
    expect(withLine.text).toContain("Open: http://100.64.0.1:18789/m/runs/r1");
    expect(withLine.buttons?.flat().some((b) => b.url)).toBe(false);
  });

  it("Telegram: no buttons once verified; UI broadcast carries verdict + marks delivery", () => {
    const { rec, ev } = terminal("verified");
    expect(formatTelegram(rec).buttons).toBeUndefined();
    expect(formatTelegram(rec, { webUrl: "https://box.ts.net/m/runs/r1" }).buttons).toEqual([
      [{ text: "🔗 Open", url: "https://box.ts.net/m/runs/r1" }],
    ]);
    const sent: Array<{
      event: string;
      payload: { verdict: string; requesterSessionKey: string };
    }> = [];
    setVerificationBroadcaster((event, payload) => sent.push({ event, payload: payload as never }));
    broadcastCompletion(rec, ev);
    expect(sent[0].event).toBe(VERIFICATION_EVENT);
    expect(sent[0].payload).toMatchObject({
      verdict: "VERIFIED",
      requesterSessionKey: "agent:main:mcp-x",
    });
    expect(getRecord("r1")?.delivered?.ui).toBeGreaterThan(0);
  });

  it("a run reaches exactly one terminal state per round", () => {
    terminal("verified");
    expect(markTerminal("r1", "failed")).toBeNull();
    expect(getRecord("r1")?.state).toBe("verified");
  });
});
