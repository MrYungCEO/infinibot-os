import { describe, it, expect, beforeEach } from "vitest";
import { alreadySent, resetDedupForTests } from "./telegram-completions.js";

describe("telegram-completions dedup", () => {
  beforeEach(() => {
    resetDedupForTests();
  });

  it("returns false on first call and true on second call for same runId+phase", () => {
    expect(alreadySent("run-abc", "end")).toBe(false);
    expect(alreadySent("run-abc", "end")).toBe(true);
  });

  it("treats different phases of the same runId independently", () => {
    expect(alreadySent("run-abc", "start")).toBe(false);
    expect(alreadySent("run-abc", "end")).toBe(false);
    expect(alreadySent("run-abc", "error")).toBe(false);

    expect(alreadySent("run-abc", "start")).toBe(true);
    expect(alreadySent("run-abc", "end")).toBe(true);
    expect(alreadySent("run-abc", "error")).toBe(true);
  });

  it("treats different runIds independently", () => {
    expect(alreadySent("run-1", "end")).toBe(false);
    expect(alreadySent("run-2", "end")).toBe(false);
    expect(alreadySent("run-1", "end")).toBe(true);
    expect(alreadySent("run-2", "end")).toBe(true);
  });

  it("resets cleanly between tests", () => {
    alreadySent("run-xyz", "end");
    resetDedupForTests();
    expect(alreadySent("run-xyz", "end")).toBe(false);
  });
});
