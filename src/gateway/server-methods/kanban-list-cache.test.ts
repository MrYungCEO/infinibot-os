import { describe, expect, it, vi } from "vitest";
import { createListCache } from "./kanban-list-cache.js";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("kanban list cache (stale-while-revalidate)", () => {
  it("waits for the first (cold) fetch and dedupes concurrent callers", async () => {
    const cache = createListCache();
    const d = deferred<string[]>();
    const fetcher = vi.fn(async () => {
      const v = await d.promise;
      cache.set("tasks:all", v, 30_000);
      return v;
    });
    const a = cache.get("tasks:all", fetcher);
    const b = cache.get("tasks:all", fetcher);
    d.resolve(["t1"]);
    expect(await a).toEqual(["t1"]);
    expect(await b).toEqual(["t1"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("serves an aged-out entry immediately and refreshes in the background", async () => {
    let t = 0;
    const cache = createListCache({ now: () => t });
    cache.set("tasks:all", ["old"], 30_000);
    t = 60_000;
    const d = deferred<string[]>();
    const fetcher = vi.fn(async () => {
      const v = await d.promise;
      cache.set("tasks:all", v, 30_000);
      return v;
    });
    expect(await cache.get("tasks:all", fetcher)).toEqual(["old"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    d.resolve(["new"]);
    await d.promise;
    await Promise.resolve();
    expect(await cache.get("tasks:all", fetcher)).toEqual(["new"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("after a write, returns fresh data when the refresh is quick", async () => {
    const cache = createListCache({ dirtyWaitMs: 1_000 });
    cache.set("tasks:all", ["old"], 30_000);
    cache.invalidate("tasks:");
    expect(cache.getFresh("tasks:all")).toBeNull();
    const fetcher = async () => {
      cache.set("tasks:all", ["written"], 30_000);
      return ["written"];
    };
    expect(await cache.get("tasks:all", fetcher)).toEqual(["written"]);
  });

  it("after a write, falls back to the last good list when Notion is slow", async () => {
    vi.useFakeTimers();
    try {
      const cache = createListCache({ dirtyWaitMs: 4_000 });
      cache.set("projects:", ["p-old"], 30_000);
      cache.invalidate("projects:");
      const never = new Promise<string[]>(() => {});
      const res = cache.get("projects:", () => never);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(await res).toEqual(["p-old"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("invalidate(prefix) only marks matching keys; a failed refresh keeps stale data", async () => {
    let t = 0;
    const onBackgroundError = vi.fn();
    const cache = createListCache({ now: () => t, onBackgroundError });
    cache.set("tasks:all", ["t"], 30_000);
    cache.set("projects:", ["p"], 30_000);
    cache.invalidate("tasks:");
    expect(cache.getFresh("projects:")).toEqual(["p"]);
    expect(cache.getFresh("tasks:all")).toBeNull();
    t = 60_000;
    expect(await cache.get("projects:", () => Promise.reject(new Error("429")))).toEqual(["p"]);
    await vi.waitFor(() =>
      expect(onBackgroundError).toHaveBeenCalledWith("projects:", expect.any(Error)),
    );
  });

  it("a wedged in-flight refresh is abandoned after maxInflightMs; its late result is ignored", async () => {
    let t = 0;
    const cache = createListCache({ now: () => t, dirtyWaitMs: 0, maxInflightMs: 120_000 });
    cache.set("tasks:all", [{ id: "a", status: "todo" }], 30_000);
    cache.invalidate("tasks:");
    const hung = deferred<unknown>();
    let calls = 0;
    const hungFetcher = async () => {
      calls++;
      const v = await hung.promise;
      cache.set("tasks:all", v, 30_000);
      return v;
    };
    await cache.get("tasks:all", hungFetcher);
    await cache.get("tasks:all", hungFetcher); // still re-joins the same flight
    expect(calls).toBe(1);
    t = 121_000;
    const fresh = async () => {
      cache.set("tasks:all", [{ id: "a", status: "done" }], 30_000);
      return [{ id: "a", status: "done" }];
    };
    expect(await cache.get("tasks:all", fresh)).toEqual([{ id: "a", status: "done" }]);
    hung.resolve([{ id: "a", status: "todo" }]); // the dead fetch finally answers
    await hung.promise;
    await Promise.resolve();
    expect(cache.getFresh("tasks:all")).toEqual([{ id: "a", status: "done" }]);
  });

  it("overlay patches cached rows now and re-applies to rows fetched before the write", async () => {
    let t = 0;
    const cache = createListCache({ now: () => t, dirtyWaitMs: 0, overlayGraceMs: 1_000 });
    const pre = [
      { id: "3f9f4bdd-9bcf-8113", status: "todo", done: false },
      { id: "other", status: "todo", done: false },
    ];
    cache.set("tasks:all", pre, 30_000);
    cache.invalidate("tasks:"); // an earlier write — reads now refresh
    // A refresh starts (reads the pre-write rows) …
    const slow = deferred<typeof pre>();
    const p = cache.get("tasks:all", async () => {
      const v = await slow.promise;
      cache.set("tasks:all", v, 30_000);
      return v;
    });
    // … the write lands (id given without dashes, as Notion ids often are) …
    cache.overlay(["tasks:", "feed:tasks"], "3f9f4bdd9bcf8113", { status: "done", done: true });
    expect(await p).toEqual([
      { id: "3f9f4bdd-9bcf-8113", status: "done", done: true },
      { id: "other", status: "todo", done: false },
    ]);
    // … and the pre-write fetch lands afterwards: patched, and still dirty.
    slow.resolve(pre);
    await slow.promise;
    await Promise.resolve();
    expect(cache.getFresh("tasks:all")).toBeNull();
    const after = await cache.get("tasks:all", async () => {
      const v = [{ id: "3f9f4bdd-9bcf-8113", status: "todo", done: false }]; // index lag
      cache.set("tasks:all", v, 30_000);
      return v;
    });
    expect(after[0]).toMatchObject({ status: "done" });
    // Past the grace window, a post-write fetch is the source of truth again
    // (someone reopened it in Notion).
    t = 5_000;
    cache.invalidate("tasks:");
    const reopened = await cache.get("tasks:all", async () => {
      const v = [{ id: "3f9f4bdd-9bcf-8113", status: "todo", done: false }];
      cache.set("tasks:all", v, 30_000);
      return v;
    });
    expect(reopened[0]).toMatchObject({ status: "todo" });
  });
});
