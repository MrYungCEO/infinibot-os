import { describe, expect, it, vi } from "vitest";
import { LEGACY_SAVED_COINS_KEY, SOL_MINT, SolanaWatchlist, mergeLists, migrateLegacyCoins, moveItem, normalizeItem, type KV } from "./watchlist.js";

const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const JUP = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const WIF = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";

function memKV(init: Record<string, string> = {}): KV & { data: Record<string, string> } {
  const data = { ...init };
  return { data, getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = v; } };
}
const make = (kv: KV, fetchImpl: typeof fetch | null = null) => new SolanaWatchlist(kv, () => "p1", fetchImpl);

describe("watchlist migration", () => {
  it("converts every legacy saved coin and keeps the legacy key", () => {
    const legacy = [
      { address: SOL_MINT, name: "SOL", symbol: "SOL", addedAt: 1 },
      { address: BONK, name: "Bonk", addedAt: 2 },
      { address: BONK, name: "dupe" },
      { address: "not-a-mint", name: "junk" },
    ];
    const kv = memKV({ [LEGACY_SAVED_COINS_KEY]: JSON.stringify(legacy) });
    const w = make(kv);
    expect(w.items().map((i) => i.mint)).toEqual([SOL_MINT, BONK]);
    expect(w.items()[1].name).toBe("Bonk");
    expect(kv.data[LEGACY_SAVED_COINS_KEY]).toBe(JSON.stringify(legacy));
    // Second load does not re-import (a coin removed later must stay removed).
    w.remove(BONK);
    expect(make(kv).items().map((i) => i.mint)).toEqual([SOL_MINT]);
  });

  it("seeds SOL when there is nothing to migrate", () => {
    expect(make(memKV()).items().map((i) => i.mint)).toEqual([SOL_MINT]);
  });

  it("migrateLegacyCoins ignores garbage", () => {
    expect(migrateLegacyCoins(null)).toEqual([]);
    expect(migrateLegacyCoins([{ address: JUP }]).map((i) => i.mint)).toEqual([JUP]);
  });

  it("keeps lists per profile", () => {
    const kv = memKV();
    const a = new SolanaWatchlist(kv, () => "alice", null);
    a.add({ mint: BONK, symbol: "BONK" });
    const b = new SolanaWatchlist(kv, () => "bob", null);
    expect(b.has(BONK)).toBe(false);
    expect(new SolanaWatchlist(kv, () => "alice", null).has(BONK)).toBe(true);
  });
});

describe("watchlist edits", () => {
  it("adds, rejects invalid mints, removes and reorders", () => {
    const w = make(memKV());
    w.add({ mint: BONK, symbol: "BONK" });
    w.add({ mint: JUP, symbol: "JUP" });
    expect(() => w.add({ mint: "nope" })).toThrow(/valid Solana/);
    w.move(JUP, 0);
    expect(w.items().map((i) => i.symbol)).toEqual(["JUP", "SOL", "BONK"]);
    w.remove(SOL_MINT);
    expect(w.items().map((i) => i.symbol)).toEqual(["JUP", "BONK"]);
  });

  it("moveItem clamps", () => {
    const items = [SOL_MINT, BONK, JUP].map((m) => normalizeItem({ mint: m })!);
    expect(moveItem(items, SOL_MINT, 99).map((i) => i.mint)).toEqual([BONK, JUP, SOL_MINT]);
    expect(moveItem(items, "x", 0)).toBe(items);
  });

  it("notifies subscribers", () => {
    const w = make(memKV());
    const fn = vi.fn();
    const off = w.subscribe(fn);
    w.add({ mint: WIF });
    off();
    w.remove(WIF);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("plugin sync", () => {
  it("merges without dropping either side and pushes the union", async () => {
    const w = make(memKV());
    w.add({ mint: BONK, symbol: "BONK" });
    const calls: Array<[string, any]> = [];
    const client = {
      request: async (method: string, params?: any) => {
        calls.push([method, params]);
        if (method === "solatrix.watchlist.get") return { items: [{ mint: JUP, symbol: "JUP" }], updatedAt: 1 } as any;
        return { ok: true } as any;
      },
    };
    await w.setBackend(client);
    expect(w.items().map((i) => i.mint)).toEqual([SOL_MINT, BONK, JUP]);
    const set = calls.find(([m]) => m === "solatrix.watchlist.set");
    expect(set?.[1].items.map((i: any) => i.mint)).toEqual([SOL_MINT, BONK, JUP]);
  });

  it("mergeLists: newer remote wins order", () => {
    const local = { version: 1 as const, items: [SOL_MINT, BONK].map((m) => normalizeItem({ mint: m })!), updatedAt: 10 };
    const merged = mergeLists(local, { items: [{ mint: BONK }, { mint: JUP }], updatedAt: 20 });
    expect(merged.items.map((i) => i.mint)).toEqual([BONK, JUP, SOL_MINT]);
  });

  it("stays local when the plugin is unavailable", async () => {
    const w = make(memKV());
    await w.setBackend({ request: async () => { throw new Error("unknown method"); } });
    expect(w.items().length).toBe(1);
  });
});

describe("prices + source", () => {
  it("falls back to DexScreener when the plugin is off", async () => {
    const fetchImpl = vi.fn(async () => ({ json: async () => [{ baseToken: { address: SOL_MINT, symbol: "SOL" }, priceUsd: "150.5", priceChange: { h24: 2 }, liquidity: { usd: 5 } }] })) as unknown as typeof fetch;
    const w = make(memKV(), fetchImpl);
    await w.refreshPrices();
    expect(w.price(SOL_MINT)).toMatchObject({ priceUsd: 150.5, change24h: 2, source: "dexscreener" });
  });

  it("remembers the chart source per profile, default DexScreener", () => {
    const kv = memKV();
    const w = make(kv);
    expect(w.chartSource()).toBe("dexscreener");
    w.setChartSource("solatrix");
    expect(make(kv).chartSource()).toBe("solatrix");
    expect(new SolanaWatchlist(kv, () => "other", null).chartSource()).toBe("dexscreener");
  });
});

describe("plugin quotes", () => {
  it("prefers solatrix.market.quotes and never overwrites a real symbol with a fixture placeholder", async () => {
    const w = make(memKV());
    w.add({ mint: BONK, symbol: "BONK", name: "Bonk" });
    const calls: string[] = [];
    await w.setBackend({
      request: async (method: string) => {
        calls.push(method);
        if (method === "solatrix.watchlist.get") return { items: [], updatedAt: 0 } as any;
        if (method === "solatrix.market.quotes") return [{ mint: BONK, symbol: "TOKEN", name: "Fixture token", priceUsd: 0.0000039, change24h: 11 }] as any;
        return {} as any;
      },
    });
    await w.refreshPrices();
    expect(calls).toContain("solatrix.market.quotes");
    expect(calls).not.toContain("solatrix.market.prices");
    expect(w.items().find((i) => i.mint === BONK)?.symbol).toBe("BONK");
    expect(w.price(BONK)?.priceUsd).toBe(0.0000039);
  });
});
