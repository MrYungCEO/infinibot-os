import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { InfinibotConfig } from "../config/config.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store.js";
import {
  clearCombinedSessionStoreMemoForTest,
  listSessionsFromStore,
  loadCombinedSessionStoreForGateway,
} from "./session-utils.js";

describe("combined session store memo", () => {
  let dir = "";
  let storePath = "";
  let cfg: InfinibotConfig;

  beforeEach(() => {
    clearSessionStoreCacheForTest();
    clearCombinedSessionStoreMemoForTest();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ib-combined-"));
    storePath = path.join(dir, "sessions.json");
    const store: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++)
      store[`agent:main:webchat-${i}`] = { sessionId: `s${i}`, updatedAt: i };
    fs.writeFileSync(storePath, JSON.stringify(store));
    cfg = { session: { store: storePath } } as InfinibotConfig;
  });

  afterEach(() => {
    clearSessionStoreCacheForTest();
    clearCombinedSessionStoreMemoForTest();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reuses the merged store while the file is unchanged (no per-poll rebuild)", () => {
    const a = loadCombinedSessionStoreForGateway(cfg).store;
    const b = loadCombinedSessionStoreForGateway(cfg).store;
    expect(b).toBe(a);
    expect(Object.isFrozen(a)).toBe(true);
    // Consumers still work on the frozen view.
    const res = listSessionsFromStore({ cfg, storePath, store: a, opts: { limit: 5 } });
    expect(res.sessions.map((s) => s.key)).toEqual([
      "agent:main:webchat-49",
      "agent:main:webchat-48",
      "agent:main:webchat-47",
      "agent:main:webchat-46",
      "agent:main:webchat-45",
    ]);
    expect(res.total).toBe(50);
    expect(res.hasMore).toBe(true);
  });

  it("rebuilds after the store file changes", () => {
    const a = loadCombinedSessionStoreForGateway(cfg).store;
    fs.writeFileSync(
      storePath,
      JSON.stringify({ "agent:main:webchat-x": { sessionId: "x", updatedAt: 1 } }),
    );
    const future = new Date(Date.now() + 5_000);
    fs.utimesSync(storePath, future, future);
    const b = loadCombinedSessionStoreForGateway(cfg).store;
    expect(b).not.toBe(a);
    expect(Object.keys(b)).toEqual(["agent:main:webchat-x"]);
  });
});
