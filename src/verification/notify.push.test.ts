import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const emitNotification = vi.fn(async () => "n1");
vi.mock("../notifications/emit.js", () => ({
  emitNotification: (...a: unknown[]) => emitNotification(...(a as [])),
}));

import { pushCompletion } from "./notify.js";
import {
  createRecord,
  getRecord,
  markTerminal,
  reopenRecord,
  resetVerificationStoreForTests,
} from "./store.js";

let dir: string;
const prev = process.env.INFINIBOT_STATE_DIR;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "vc-push-"));
  process.env.INFINIBOT_STATE_DIR = dir;
  resetVerificationStoreForTests();
  emitNotification.mockClear();
});
afterEach(() => {
  if (prev === undefined) delete process.env.INFINIBOT_STATE_DIR;
  else process.env.INFINIBOT_STATE_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

describe("verification verdict push", () => {
  it("pushes once per terminal transition with a runs/<id> deep link", async () => {
    createRecord({
      runId: "p1",
      childSessionKey: "c",
      requesterSessionKey: "r",
      label: "Ship it",
      task: "t",
    });
    markTerminal("p1", "failed", { summary: "tests red" });
    expect(await pushCompletion(getRecord("p1")!)).toBe(true);
    expect(emitNotification).toHaveBeenCalledTimes(1);
    expect(emitNotification.mock.calls[0]).toEqual([
      expect.objectContaining({
        category: "agent.error",
        severity: "error",
        deepLink: "infinibot://runs/p1",
        sourceId: "p1",
      }),
    ]);
    // Replay of the same terminal event (restart / re-delivery) → no second push.
    expect(await pushCompletion(getRecord("p1")!)).toBe(false);
    expect(emitNotification).toHaveBeenCalledTimes(1);
  });

  it("an operator reopen + new verdict pushes again", async () => {
    createRecord({
      runId: "p2",
      childSessionKey: "c",
      requesterSessionKey: "r",
      label: "L",
      task: "t",
    });
    markTerminal("p2", "stalled");
    await pushCompletion(getRecord("p2")!);
    reopenRecord("p2");
    await new Promise((r) => setTimeout(r, 2));
    markTerminal("p2", "verified");
    expect(await pushCompletion(getRecord("p2")!)).toBe(true);
    expect(emitNotification.mock.calls[1]).toEqual([
      expect.objectContaining({ category: "agent.completed", severity: "success" }),
    ]);
  });
});
