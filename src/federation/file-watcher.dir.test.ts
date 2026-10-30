import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MemoryFileWatcher } from "./file-watcher.js";

let dir = "";
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("MemoryFileWatcher directory events", () => {
  it("ignores a directory change instead of throwing EISDIR (which crashed satellites)", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "fw-dir-"));
    await mkdir(path.join(dir, "state"));
    const watcher = new MemoryFileWatcher({ workspace: dir });
    const changes: unknown[] = [];
    watcher.on("change" as never, (e: unknown) => changes.push(e));
    const run = (
      watcher as unknown as {
        processFileChange: (rel: string, full: string, ev: string) => Promise<void>;
      }
    ).processFileChange.bind(watcher);
    await expect(run("state", path.join(dir, "state"), "rename")).resolves.toBeUndefined();
    expect(changes).toHaveLength(0);
  });
});
