import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearSessionStoreCacheForTest,
  loadSessionStore,
  loadSessionStoreReadonly,
} from "./store.js";

describe("session store read-only snapshot", () => {
  let dir = "";
  let storePath = "";

  beforeEach(() => {
    clearSessionStoreCacheForTest();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ib-store-ro-"));
    storePath = path.join(dir, "sessions.json");
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        "agent:main:main": {
          sessionId: "s1",
          updatedAt: 1,
          skillsSnapshot: { big: "x".repeat(1000) },
        },
      }),
    );
  });

  afterEach(() => {
    clearSessionStoreCacheForTest();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("shares one frozen snapshot across read-only calls (no per-read copy)", () => {
    const a = loadSessionStoreReadonly(storePath);
    const b = loadSessionStoreReadonly(storePath);
    expect(a).toBe(b);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a["agent:main:main"])).toBe(true);
    expect(() => {
      (a as Record<string, unknown>)["agent:main:x"] = {};
    }).toThrow(TypeError);
  });

  it("gives mutable callers a private copy that cannot corrupt the snapshot", () => {
    const ro = loadSessionStoreReadonly(storePath);
    const rw = loadSessionStore(storePath);
    expect(rw).not.toBe(ro);
    expect(Object.isFrozen(rw)).toBe(false);
    rw["agent:main:main"]!.updatedAt = 99;
    expect(loadSessionStoreReadonly(storePath)["agent:main:main"]?.updatedAt).toBe(1);
    expect(loadSessionStore(storePath)["agent:main:main"]?.updatedAt).toBe(1);
  });

  it("reloads after the file changes on disk", () => {
    const first = loadSessionStoreReadonly(storePath);
    fs.writeFileSync(
      storePath,
      JSON.stringify({ "agent:main:main": { sessionId: "s2", updatedAt: 2 } }),
    );
    const future = new Date(Date.now() + 5_000);
    fs.utimesSync(storePath, future, future);
    const second = loadSessionStoreReadonly(storePath);
    expect(second).not.toBe(first);
    expect(second["agent:main:main"]?.sessionId).toBe("s2");
  });
});
