import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadSessionStore, updateSessionStore } from "./store.js";

describe("session store lock", () => {
  let dir: string | null = null;

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("queues in-process writers instead of timing them out", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-store-lock-"));
    const storePath = path.join(dir, "sessions.json");
    fs.writeFileSync(storePath, "{}");

    // 120 writers × ~100ms each ≈ 12s total — longer than the 10s file-lock
    // timeout, so polling writers would give up without the in-process queue.
    const writers = Array.from({ length: 120 }, (_, i) =>
      updateSessionStore(storePath, async (store) => {
        await new Promise((r) => setTimeout(r, 100));
        store[`agent:main:test-${i}`] = { sessionId: `s-${i}`, updatedAt: Date.now() } as never;
      }),
    );
    await Promise.all(writers);

    const store = loadSessionStore(storePath, { skipCache: true });
    expect(Object.keys(store)).toHaveLength(120);
    expect(fs.existsSync(`${storePath}.lock`)).toBe(false);
  }, 30_000);
});
