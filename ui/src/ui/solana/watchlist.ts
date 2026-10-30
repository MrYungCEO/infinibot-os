/**
 * One Solana watchlist for the whole control UI.
 *
 * Shared by the control-bar CHART panel (views/solana-chart.ts) and the
 * Solatrix plugin pages. Persists per profile in localStorage and, when the
 * Solatrix plugin is enabled, syncs with the plugin backend
 * (`solatrix.watchlist.get/set`) so agents and other devices see the same list.
 *
 * Migration: the chart panel's legacy saved coins (`infinibot-saved-coins`)
 * are folded in once. The legacy key is never deleted.
 */

import { getLastPicked } from "../profiles.js";

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const LEGACY_SAVED_COINS_KEY = "infinibot-saved-coins";
const STORE_PREFIX = "infinibot-solana-watchlist-v1";
const SOURCE_PREFIX = "infinibot-solana-chart-source-v1";
export const WATCHLIST_MAX = 100;

export type WatchItem = {
  mint: string;
  symbol: string;
  name: string;
  addedAt: number;
  imageUrl?: string;
};

export type WatchPrice = {
  priceUsd: number | null;
  change24h: number | null;
  marketCap?: number | null;
  /** Best-liquidity pair (DexScreener embeds resolve pairs, not always mints). */
  pairAddress?: string;
  updatedAt: number;
  source: "solatrix" | "dexscreener";
};

export type WatchlistSnapshot = {
  version: 1;
  items: WatchItem[];
  updatedAt: number;
  migratedLegacyAt?: number;
};

/** Legacy chart-panel shape (views/solana-chart.ts before the shared store). */
export type LegacySavedCoin = { address: string; name?: string; symbol?: string; addedAt?: number };

export type ChartSource = "solatrix" | "dexscreener";

/** Minimal storage + RPC seams so the store is unit-testable in node. */
export type KV = { getItem(k: string): string | null; setItem(k: string, v: string): void };
export type RpcClient = { request<T = unknown>(method: string, params?: unknown): Promise<T> };

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export function isMint(v: unknown): v is string {
  return typeof v === "string" && BASE58.test(v.trim());
}

function clean(v: unknown, max = 60): string {
  return typeof v === "string" ? v.replace(/[\u0000-\u001f]/g, "").trim().slice(0, max) : "";
}

export function normalizeItem(raw: unknown): WatchItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const mint = clean(r.mint ?? r.address, 64);
  if (!isMint(mint)) return null;
  const symbol = clean(r.symbol, 24) || (mint === SOL_MINT ? "SOL" : "");
  const name = clean(r.name, 80) || symbol || `${mint.slice(0, 4)}…${mint.slice(-4)}`;
  const addedAt = Number.isFinite(Number(r.addedAt)) && Number(r.addedAt) > 0 ? Number(r.addedAt) : Date.now();
  const imageUrl = typeof r.imageUrl === "string" && /^https:\/\//.test(r.imageUrl) ? r.imageUrl.slice(0, 400) : undefined;
  return { mint, symbol: symbol || name.slice(0, 12).toUpperCase(), name, addedAt, ...(imageUrl ? { imageUrl } : {}) };
}

/** De-duplicate by mint, keep first occurrence order, cap the list. */
export function dedupe(items: Array<WatchItem | null | undefined>): WatchItem[] {
  const seen = new Set<string>();
  const out: WatchItem[] = [];
  for (const it of items) {
    if (!it || seen.has(it.mint)) continue;
    seen.add(it.mint);
    out.push(it);
    if (out.length >= WATCHLIST_MAX) break;
  }
  return out;
}

/** Convert the chart panel's legacy saved coins without losing any entry. */
export function migrateLegacyCoins(raw: unknown): WatchItem[] {
  if (!Array.isArray(raw)) return [];
  return dedupe(raw.map((c) => normalizeItem(c)));
}

/**
 * Merge a remote (plugin) list into the local one. The newer snapshot wins
 * the ORDER; entries only present on the other side are appended, so a
 * first sync never drops a coin from either side.
 */
export function mergeLists(local: WatchlistSnapshot, remote: { items: unknown[]; updatedAt?: number } | null): WatchlistSnapshot {
  if (!remote) return local;
  const remoteItems = dedupe(remote.items.map((i) => normalizeItem(i)));
  const remoteAt = Number(remote.updatedAt ?? 0);
  const [first, second] = remoteAt > local.updatedAt ? [remoteItems, local.items] : [local.items, remoteItems];
  return { ...local, items: dedupe([...first, ...second]), updatedAt: Math.max(local.updatedAt, remoteAt) };
}

/** Pure reorder helper: move `mint` to index `to` (clamped). */
export function moveItem(items: WatchItem[], mint: string, to: number): WatchItem[] {
  const from = items.findIndex((i) => i.mint === mint);
  if (from < 0) return items;
  const next = items.slice();
  const [it] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(next.length, to)), 0, it);
  return next;
}

function profileSuffix(): string {
  try {
    return getLastPicked() || "default";
  } catch {
    return "default";
  }
}

type Listener = () => void;

export class SolanaWatchlist {
  private snap: WatchlistSnapshot;
  private readonly priceMap = new Map<string, WatchPrice>();
  private readonly listeners = new Set<Listener>();
  private backend: RpcClient | null = null;
  private syncing: Promise<void> | null = null;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private priceTimer: ReturnType<typeof setInterval> | null = null;
  private priceUsers = 0;

  constructor(
    private readonly kv: KV | null = typeof localStorage !== "undefined" ? localStorage : null,
    private readonly keySuffix: () => string = profileSuffix,
    private readonly fetchImpl: typeof fetch | null = typeof fetch !== "undefined" ? fetch.bind(globalThis) : null,
  ) {
    this.snap = this.load();
  }

  private key(prefix: string) {
    return `${prefix}:${this.keySuffix()}`;
  }

  private load(): WatchlistSnapshot {
    const empty: WatchlistSnapshot = { version: 1, items: [], updatedAt: 0 };
    let snap = empty;
    try {
      const raw = this.kv?.getItem(this.key(STORE_PREFIX));
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<WatchlistSnapshot>;
        snap = { version: 1, items: dedupe((parsed.items ?? []).map((i) => normalizeItem(i))), updatedAt: Number(parsed.updatedAt) || 0, migratedLegacyAt: parsed.migratedLegacyAt };
      }
    } catch {
      snap = empty;
    }
    if (!snap.migratedLegacyAt) {
      // One-time fold-in of the chart panel's saved coins (legacy key kept).
      let legacy: WatchItem[] = [];
      try {
        const raw = this.kv?.getItem(LEGACY_SAVED_COINS_KEY);
        legacy = raw ? migrateLegacyCoins(JSON.parse(raw)) : [];
      } catch {
        legacy = [];
      }
      const items = dedupe([...snap.items, ...legacy]);
      snap = { ...snap, items: items.length ? items : [normalizeItem({ mint: SOL_MINT, symbol: "SOL", name: "Solana" })!], migratedLegacyAt: Date.now(), updatedAt: snap.updatedAt || (legacy.length ? Date.now() : 0) };
      this.persist(snap);
    }
    return snap;
  }

  private persist(snap: WatchlistSnapshot) {
    try {
      this.kv?.setItem(this.key(STORE_PREFIX), JSON.stringify(snap));
    } catch {
      /* quota / private mode */
    }
  }

  /** Reload after a profile switch. */
  reload() {
    this.snap = this.load();
    this.emit();
  }

  items(): readonly WatchItem[] {
    return this.snap.items;
  }
  snapshot(): WatchlistSnapshot {
    return this.snap;
  }
  has(mint: string) {
    return this.snap.items.some((i) => i.mint === mint);
  }
  price(mint: string): WatchPrice | undefined {
    return this.priceMap.get(mint);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    for (const fn of [...this.listeners]) {
      try {
        fn();
      } catch {
        /* listener errors never break the store */
      }
    }
  }

  private commit(items: WatchItem[]) {
    this.snap = { ...this.snap, items: dedupe(items), updatedAt: Date.now() };
    this.persist(this.snap);
    this.emit();
    this.schedulePush();
  }

  add(input: Partial<WatchItem> & { mint?: string; address?: string }): WatchItem {
    const item = normalizeItem(input);
    if (!item) throw new Error("Enter a valid Solana token mint address");
    if (this.has(item.mint)) {
      // Refresh metadata (e.g. symbol learned later) without moving it.
      this.commit(this.snap.items.map((i) => (i.mint === item.mint ? { ...i, symbol: input.symbol ? item.symbol : i.symbol, name: input.name ? item.name : i.name } : i)));
      return this.snap.items.find((i) => i.mint === item.mint)!;
    }
    if (this.snap.items.length >= WATCHLIST_MAX) throw new Error(`Watchlist is full (${WATCHLIST_MAX})`);
    this.commit([...this.snap.items, item]);
    void this.refreshPrices([item.mint]);
    return item;
  }
  remove(mint: string) {
    if (!this.has(mint)) return;
    this.commit(this.snap.items.filter((i) => i.mint !== mint));
  }
  move(mint: string, to: number) {
    this.commit(moveItem(this.snap.items, mint, to));
  }

  // ── plugin backend sync ───────────────────────────────────────────────

  /** Attach (or detach with null) the Solatrix backend; merges once on attach. */
  setBackend(client: RpcClient | null): Promise<void> {
    if (client === this.backend) return this.syncing ?? Promise.resolve();
    this.backend = client;
    if (!client) return Promise.resolve();
    this.syncing = (async () => {
      try {
        const remote = await client.request<{ items: unknown[]; updatedAt?: number }>("solatrix.watchlist.get", {});
        const merged = mergeLists(this.snap, remote);
        const changed = JSON.stringify(merged.items) !== JSON.stringify(this.snap.items);
        this.snap = merged;
        this.persist(merged);
        if (changed) this.emit();
        // Push whenever the server is missing anything we have.
        const remoteMints = new Set((remote?.items ?? []).map((i) => normalizeItem(i)?.mint));
        if (merged.items.some((i) => !remoteMints.has(i.mint)) || merged.items.length !== remoteMints.size) await this.push();
      } catch {
        /* plugin disabled / older plugin: stay local */
      } finally {
        this.syncing = null;
      }
    })();
    return this.syncing;
  }
  private schedulePush() {
    if (!this.backend) return;
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => void this.push(), 400);
  }
  private async push() {
    const client = this.backend;
    if (!client) return;
    try {
      await client.request("solatrix.watchlist.set", { items: this.snap.items, updatedAt: this.snap.updatedAt });
    } catch {
      /* offline: local copy stays authoritative until the next sync */
    }
  }

  // ── live prices ───────────────────────────────────────────────────────

  /** Start polling prices while at least one view is showing them. */
  watchPrices(intervalMs = 20_000): () => void {
    this.priceUsers++;
    if (!this.priceTimer) {
      void this.refreshPrices();
      this.priceTimer = setInterval(() => void this.refreshPrices(), intervalMs);
    }
    return () => {
      this.priceUsers = Math.max(0, this.priceUsers - 1);
      if (!this.priceUsers && this.priceTimer) {
        clearInterval(this.priceTimer);
        this.priceTimer = null;
      }
    };
  }

  async refreshPrices(mints = this.snap.items.map((i) => i.mint)): Promise<void> {
    const list = mints.filter(isMint).slice(0, 30);
    if (!list.length) return;
    let got = false;
    let updated = false;
    if (this.backend) {
      try {
        // Live public quotes (honours the plugin's marketData setting); older plugins only have market.prices.
        const rows = await this.backend
          .request<Array<Record<string, unknown> | null>>("solatrix.market.quotes", { mints: list })
          .catch(() => this.backend!.request<Array<Record<string, unknown> | null>>("solatrix.market.prices", { mints: list }));
        for (const r of rows ?? []) {
          if (!r || typeof r.mint !== "string") continue;
          this.priceMap.set(r.mint, { priceUsd: num(r.priceUsd), change24h: num(r.change24h), marketCap: num(r.marketCap), ...(typeof r.pairAddress === "string" ? { pairAddress: r.pairAddress } : {}), updatedAt: Date.now(), source: "solatrix" });
          updated = true;
          this.learnSymbol(r.mint, r.symbol, r.name, r.imageUrl);
        }
        got = true;
      } catch {
        got = false;
      }
    }
    if (!got && this.fetchImpl) {
      // Plugin off: public DexScreener token endpoint (read-only, no key).
      try {
        const res = await this.fetchImpl(`https://api.dexscreener.com/tokens/v1/solana/${list.join(",")}`, { headers: { accept: "application/json" } });
        const pairs = (await res.json()) as Array<Record<string, any>>;
        const best = new Map<string, Record<string, any>>();
        for (const p of Array.isArray(pairs) ? pairs : []) {
          const mint = p?.baseToken?.address;
          if (typeof mint !== "string") continue;
          const prev = best.get(mint);
          if (!prev || Number(p?.liquidity?.usd ?? 0) > Number(prev?.liquidity?.usd ?? 0)) best.set(mint, p);
        }
        for (const [mint, p] of best) {
          this.priceMap.set(mint, { priceUsd: num(p.priceUsd), change24h: num(p?.priceChange?.h24), marketCap: num(p.marketCap ?? p.fdv), ...(typeof p.pairAddress === "string" ? { pairAddress: p.pairAddress } : {}), updatedAt: Date.now(), source: "dexscreener" });
          updated = true;
          this.learnSymbol(mint, p?.baseToken?.symbol, p?.baseToken?.name, p?.info?.imageUrl);
        }
      } catch {
        /* offline */
      }
    }
    if (updated) this.emit();
  }

  private learnSymbol(mint: string, symbol: unknown, name: unknown, imageUrl: unknown) {
    const it = this.snap.items.find((i) => i.mint === mint);
    if (!it) return;
    const sym = clean(symbol, 24);
    const nm = clean(name, 80);
    const img = typeof imageUrl === "string" && /^https:\/\//.test(imageUrl) ? imageUrl : undefined;
    // Only replace names we made up (a shortened mint) — never a name the user typed, never with a fixture placeholder.
    const looksPlaceholder = !it.symbol || it.name.includes("…");
    if (sym === "TOKEN") return;
    if ((sym && looksPlaceholder && sym !== it.symbol) || (img && !it.imageUrl)) {
      this.snap = { ...this.snap, items: this.snap.items.map((i) => (i.mint === mint ? { ...i, symbol: sym && looksPlaceholder ? sym : i.symbol, name: nm && i.name.includes("…") ? nm : i.name, ...(img ? { imageUrl: img } : {}) } : i)) };
      this.persist(this.snap);
    }
  }

  // ── chart source preference (per profile) ─────────────────────────────

  chartSource(): ChartSource {
    try {
      return this.kv?.getItem(this.key(SOURCE_PREFIX)) === "solatrix" ? "solatrix" : "dexscreener";
    } catch {
      return "dexscreener";
    }
  }
  setChartSource(src: ChartSource) {
    try {
      this.kv?.setItem(this.key(SOURCE_PREFIX), src);
    } catch {
      /* ignore */
    }
    this.emit();
  }
}

function num(v: unknown): number | null {
  const n = Number(v);
  return v === null || v === undefined || v === "" || !Number.isFinite(n) ? null : n;
}

/** The app-wide instance. */
export const solanaWatchlist = new SolanaWatchlist();
