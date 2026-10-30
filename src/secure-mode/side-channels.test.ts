/**
 * Side channels found by the Secure Mode e2e: places outside the agent run
 * that used to copy a secure reply into plaintext (notification history /
 * push, skill trajectories, the agent delivery log).
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { captureCompletion } from "../agents/skills/cumulative/index.js";
import { emitNotification, setNotificationBroadcaster } from "../notifications/emit.js";
import { getNotificationHistoryStore, resetNotificationHistoryStore } from "../notifications/history-store.js";

const MARK = "SIDECHANNEL-MARKER-93d1";
const SECURE = "agent:main:secure-side1";
let dir: string;
const broadcasts: unknown[] = [];

beforeEach(() => {
  dir = path.join(tmpdir(), `ib-secure-side-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(dir, { recursive: true });
  resetNotificationHistoryStore();
  broadcasts.length = 0;
  setNotificationBroadcaster((event, payload) => broadcasts.push({ event, payload }));
});
afterEach(() => {
  resetNotificationHistoryStore();
  setNotificationBroadcaster(() => {});
  rmSync(dir, { recursive: true, force: true });
});

function filesContaining(root: string, needle: string): string[] {
  return (readdirSync(root, { recursive: true }) as string[])
    .map((f) => path.join(root, f))
    .filter((p) => statSync(p).isFile() && readFileSync(p).includes(Buffer.from(needle)));
}

describe("secure notifications", () => {
  it("redacts a secure session's reply from history and the broadcast", async () => {
    const id = await emitNotification({
      category: "chat.mentions",
      title: "✦ Infinibot",
      body: `the secret answer ${MARK}`,
      source: "agent",
      sourceId: SECURE,
      data: { type: "chat", sessionKey: SECURE, runId: "r1", preview: MARK },
      summary: MARK,
      displayTitle: MARK,
      stateDir: dir,
    });
    const row = getNotificationHistoryStore(dir).get(id)!;
    expect(row.title).toBe("Secure Mode");
    expect(JSON.stringify(row)).not.toContain(MARK);
    expect(JSON.stringify(broadcasts)).not.toContain(MARK);
    expect(filesContaining(dir, MARK)).toEqual([]);
  });

  it("leaves normal notifications alone", async () => {
    const id = await emitNotification({
      category: "chat.mentions",
      title: "Hi",
      body: MARK,
      sourceId: "agent:main:main",
      data: { sessionKey: "agent:main:main" },
      stateDir: dir,
    });
    expect(getNotificationHistoryStore(dir).get(id)!.body).toBe(MARK);
  });
});

describe("secure skill trajectories", () => {
  it("never persists a secure run as a trajectory", async () => {
    const res = await captureCompletion({
      trajectory: {
        source: { agentId: "main", sessionKey: SECURE },
        taskPrompt: MARK,
        steps: [],
        finalAnswer: MARK,
        outcome: { errored: false, reportedSuccess: true },
      } as never,
      config: { enabled: true, dir, trajectoriesDir: dir, skillsDir: dir } as never,
    });
    expect(res.skill).toBeUndefined();
    expect(filesContaining(dir, MARK)).toEqual([]);
  });
});
