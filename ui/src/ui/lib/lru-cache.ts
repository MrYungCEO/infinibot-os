/**
 * Generic bounded LRU cache backed by insertion-ordered Map.
 *
 * Eviction policy: least-recently-used (read OR write counts as use).
 * onEvict is called on capacity-driven eviction AND on explicit delete/clear
 * so callers can release resources like blob URLs.
 */
export class LRUCache<K, V> {
  private readonly _map = new Map<K, V>();

  constructor(
    public readonly maxSize: number,
    private readonly onEvict?: (key: K, value: V) => void,
  ) {
    if (maxSize < 1) throw new RangeError("LRUCache maxSize must be >= 1");
  }

  get(key: K): V | undefined {
    if (!this._map.has(key)) return undefined;
    const value = this._map.get(key) as V;
    // Bump to most-recent slot by re-inserting at tail.
    this._map.delete(key);
    this._map.set(key, value);
    return value;
  }

  set(key: K, value: V): this {
    if (this._map.has(key)) {
      // Re-insert at tail to refresh recency.
      this._map.delete(key);
    } else if (this._map.size >= this.maxSize) {
      // Evict oldest (first/head) entry.
      const oldestKey = this._map.keys().next().value as K;
      const oldestVal = this._map.get(oldestKey) as V;
      this._map.delete(oldestKey);
      this.onEvict?.(oldestKey, oldestVal);
    }
    this._map.set(key, value);
    return this;
  }

  /** Explicitly remove an entry. Calls onEvict so resources are released. */
  delete(key: K): boolean {
    if (!this._map.has(key)) return false;
    const val = this._map.get(key) as V;
    this._map.delete(key);
    this.onEvict?.(key, val);
    return true;
  }

  /** Remove all entries, calling onEvict for each. */
  clear(): void {
    if (this.onEvict) {
      for (const [k, v] of this._map) this.onEvict(k, v);
    }
    this._map.clear();
  }

  has(key: K): boolean {
    return this._map.has(key);
  }

  /** Peek without affecting recency order. */
  peek(key: K): V | undefined {
    return this._map.get(key);
  }

  get size(): number {
    return this._map.size;
  }

  keys(): IterableIterator<K> {
    return this._map.keys();
  }

  values(): IterableIterator<V> {
    return this._map.values();
  }

  entries(): IterableIterator<[K, V]> {
    return this._map.entries();
  }

  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this._map[Symbol.iterator]();
  }
}
