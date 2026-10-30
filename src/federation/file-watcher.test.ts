import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryFileWatcher } from "./file-watcher.js";

type Internals = {
  processFileChange: (rel: string, full: string, ev: string) => Promise<void>;
  handleFileEvent: (rel: string, full: string, ev: string) => void;
};

describe("MemoryFileWatcher", () => {
  it("ignores a directory change instead of throwing EISDIR", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "fw-"));
    fs.mkdirSync(path.join(ws, "memory"));
    const watcher = new MemoryFileWatcher({ workspace: ws, debounceMs: 1 });
    const seen: unknown[] = [];
    watcher.on("file:changed", (e) => seen.push(e));
    await expect(
      (watcher as unknown as Internals).processFileChange(
        "memory",
        path.join(ws, "memory"),
        "rename",
      ),
    ).resolves.toBeUndefined();
    expect(seen).toEqual([]);
  });

  it("never turns a processing failure into an unhandled rejection when nobody listens for errors", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "fw-"));
    const watcher = new MemoryFileWatcher({ workspace: ws, debounceMs: 1 });
    (watcher as unknown as Internals).processFileChange = async () => {
      throw new Error("boom");
    };
    const rejections: unknown[] = [];
    const onRejection = (r: unknown) => rejections.push(r);
    process.on("unhandledRejection", onRejection);
    try {
      (watcher as unknown as Internals).handleFileEvent(
        "SOUL.md",
        path.join(ws, "SOUL.md"),
        "change",
      );
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      process.off("unhandledRejection", onRejection);
    }
    expect(rejections).toEqual([]);
  });
});
