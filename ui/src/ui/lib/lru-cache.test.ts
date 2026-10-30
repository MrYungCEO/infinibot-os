import { describe, expect, it, vi } from "vitest";
import { LRUCache } from "./lru-cache";

describe("LRUCache", () => {
  it("stores and retrieves values", () => {
    const c = new LRUCache<string, number>(3);
    c.set("a", 1);
    c.set("b", 2);
    expect(c.get("a")).toBe(1);
    expect(c.get("b")).toBe(2);
    expect(c.size).toBe(2);
  });

  it("returns undefined for missing keys", () => {
    const c = new LRUCache<string, number>(3);
    expect(c.get("nope")).toBeUndefined();
  });

  it("evicts the oldest entry when at capacity", () => {
    const c = new LRUCache<string, number>(3);
    c.set("a", 1);
    c.set("b", 2);
    c.set("c", 3);
    c.set("d", 4); // "a" should be evicted
    expect(c.has("a")).toBe(false);
    expect(c.get("b")).toBe(2);
    expect(c.get("c")).toBe(3);
    expect(c.get("d")).toBe(4);
    expect(c.size).toBe(3);
  });

  it("promotes recently-read entries so they are not evicted first", () => {
    const c = new LRUCache<string, number>(3);
    c.set("a", 1);
    c.set("b", 2);
    c.set("c", 3);
    c.get("a"); // access "a" → it becomes most-recent; "b" is now oldest
    c.set("d", 4); // should evict "b", not "a"
    expect(c.has("b")).toBe(false);
    expect(c.has("a")).toBe(true);
    expect(c.has("c")).toBe(true);
    expect(c.has("d")).toBe(true);
  });

  it("promotes recently-written entries so they are not evicted first", () => {
    const c = new LRUCache<string, number>(3);
    c.set("a", 1);
    c.set("b", 2);
    c.set("c", 3);
    c.set("a", 10); // overwrite "a" → bumps it to most-recent; "b" is now oldest
    c.set("d", 4);  // should evict "b"
    expect(c.has("b")).toBe(false);
    expect(c.get("a")).toBe(10);
  });

  it("calls onEvict with correct key/value on capacity eviction", () => {
    const evicted: Array<[string, number]> = [];
    const c = new LRUCache<string, number>(2, (k, v) => evicted.push([k, v]));
    c.set("a", 1);
    c.set("b", 2);
    c.set("c", 3); // evicts "a"
    expect(evicted).toEqual([["a", 1]]);
  });

  it("calls onEvict on explicit delete", () => {
    const onEvict = vi.fn();
    const c = new LRUCache<string, string>(5, onEvict);
    c.set("x", "bloburl");
    c.delete("x");
    expect(onEvict).toHaveBeenCalledWith("x", "bloburl");
    expect(c.has("x")).toBe(false);
  });

  it("calls onEvict for every entry on clear()", () => {
    const keys: string[] = [];
    const c = new LRUCache<string, number>(10, (k) => keys.push(k));
    c.set("a", 1);
    c.set("b", 2);
    c.set("c", 3);
    c.clear();
    expect(keys.sort()).toEqual(["a", "b", "c"]);
    expect(c.size).toBe(0);
  });

  it("delete returns false for non-existent key", () => {
    const c = new LRUCache<string, number>(3);
    expect(c.delete("missing")).toBe(false);
  });

  it("peek does not affect LRU order", () => {
    const c = new LRUCache<string, number>(2);
    c.set("a", 1);
    c.set("b", 2);
    c.peek("a"); // peek — should NOT promote "a"
    c.set("c", 3); // should still evict "a" (oldest)
    expect(c.has("a")).toBe(false);
    expect(c.has("b")).toBe(true);
    expect(c.has("c")).toBe(true);
  });

  it("maintains correct size after mixed operations", () => {
    const c = new LRUCache<number, string>(4);
    for (let i = 0; i < 4; i++) c.set(i, `v${i}`);
    expect(c.size).toBe(4);
    c.delete(1);
    expect(c.size).toBe(3);
    c.set(10, "new");
    expect(c.size).toBe(4);
    c.set(11, "overflow"); // evicts oldest of remaining
    expect(c.size).toBe(4);
  });

  it("throws RangeError for maxSize < 1", () => {
    expect(() => new LRUCache(0)).toThrow(RangeError);
    expect(() => new LRUCache(-1)).toThrow(RangeError);
  });
});
