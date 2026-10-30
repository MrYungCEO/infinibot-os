/**
 * Conflict-free Replicated Data Types for Federation Sync
 *
 * CRDTs enable conflict-free state synchronization across distributed nodes
 * without requiring coordination. Each CRDT type has a merge operation that
 * is commutative, associative, and idempotent.
 */

// =============================================================================
// Last-Write-Wins Register
// =============================================================================

/**
 * LWW Register - stores a single value with timestamp-based conflict resolution.
 * When merging, the value with the highest timestamp wins. Ties are broken by nodeId.
 */
export class LWWRegister<T> {
  private _value: T;
  private _timestamp: number;
  private _nodeId: string;

  constructor(value: T, timestamp: number = 0, nodeId: string = "") {
    this._value = value;
    this._timestamp = timestamp;
    this._nodeId = nodeId;
  }

  /**
   * Set the value with a timestamp and node identifier.
   */
  set(value: T, timestamp: number, nodeId: string): void {
    // Only update if new timestamp is greater, or equal timestamp with greater nodeId
    if (
      timestamp > this._timestamp ||
      (timestamp === this._timestamp && nodeId > this._nodeId)
    ) {
      this._value = value;
      this._timestamp = timestamp;
      this._nodeId = nodeId;
    }
  }

  /**
   * Get the current value.
   */
  get(): T {
    return this._value;
  }

  /**
   * Get the timestamp of the current value.
   */
  get timestamp(): number {
    return this._timestamp;
  }

  /**
   * Get the node that last wrote the value.
   */
  get nodeId(): string {
    return this._nodeId;
  }

  /**
   * Merge another LWW register into this one.
   * The value with the highest (timestamp, nodeId) wins.
   */
  merge(other: LWWRegister<T>): void {
    this.set(other._value, other._timestamp, other._nodeId);
  }

  /**
   * Serialize to JSON.
   */
  toJSON(): { value: T; timestamp: number; nodeId: string } {
    return {
      value: this._value,
      timestamp: this._timestamp,
      nodeId: this._nodeId,
    };
  }

  /**
   * Create from JSON.
   */
  static fromJSON<T>(json: { value: T; timestamp: number; nodeId: string }): LWWRegister<T> {
    return new LWWRegister<T>(json.value, json.timestamp, json.nodeId);
  }
}

// =============================================================================
// G-Counter (Grow-only Counter)
// =============================================================================

/**
 * G-Counter - a counter that can only increment.
 * Each node has its own count, and the total is the sum of all counts.
 */
export class GCounter {
  private counts: Map<string, number> = new Map();

  constructor(initialCounts?: Map<string, number> | Record<string, number>) {
    if (initialCounts) {
      if (initialCounts instanceof Map) {
        this.counts = new Map(initialCounts);
      } else {
        this.counts = new Map(Object.entries(initialCounts));
      }
    }
  }

  /**
   * Increment the counter for a specific node.
   */
  increment(nodeId: string, amount: number = 1): void {
    if (amount < 0) {
      throw new Error("GCounter can only increment (amount must be >= 0)");
    }
    const current = this.counts.get(nodeId) ?? 0;
    this.counts.set(nodeId, current + amount);
  }

  /**
   * Get the total count across all nodes.
   */
  value(): number {
    let total = 0;
    for (const count of this.counts.values()) {
      total += count;
    }
    return total;
  }

  /**
   * Get the count for a specific node.
   */
  getNodeCount(nodeId: string): number {
    return this.counts.get(nodeId) ?? 0;
  }

  /**
   * Merge another G-Counter into this one.
   * Takes the maximum count for each node.
   */
  merge(other: GCounter): void {
    for (const [nodeId, count] of other.counts) {
      const current = this.counts.get(nodeId) ?? 0;
      this.counts.set(nodeId, Math.max(current, count));
    }
  }

  /**
   * Serialize to JSON.
   */
  toJSON(): Record<string, number> {
    return Object.fromEntries(this.counts);
  }

  /**
   * Create from JSON.
   */
  static fromJSON(json: Record<string, number>): GCounter {
    return new GCounter(json);
  }
}

// =============================================================================
// PN-Counter (Positive-Negative Counter)
// =============================================================================

/**
 * PN-Counter - a counter that can both increment and decrement.
 * Implemented as two G-Counters: one for increments, one for decrements.
 */
export class PNCounter {
  private positive: GCounter;
  private negative: GCounter;

  constructor() {
    this.positive = new GCounter();
    this.negative = new GCounter();
  }

  /**
   * Increment the counter.
   */
  increment(nodeId: string, amount: number = 1): void {
    this.positive.increment(nodeId, amount);
  }

  /**
   * Decrement the counter.
   */
  decrement(nodeId: string, amount: number = 1): void {
    this.negative.increment(nodeId, amount);
  }

  /**
   * Get the current value.
   */
  value(): number {
    return this.positive.value() - this.negative.value();
  }

  /**
   * Merge another PN-Counter into this one.
   */
  merge(other: PNCounter): void {
    this.positive.merge(other.positive);
    this.negative.merge(other.negative);
  }

  /**
   * Serialize to JSON.
   */
  toJSON(): { positive: Record<string, number>; negative: Record<string, number> } {
    return {
      positive: this.positive.toJSON(),
      negative: this.negative.toJSON(),
    };
  }

  /**
   * Create from JSON.
   */
  static fromJSON(json: {
    positive: Record<string, number>;
    negative: Record<string, number>;
  }): PNCounter {
    const counter = new PNCounter();
    counter.positive = GCounter.fromJSON(json.positive);
    counter.negative = GCounter.fromJSON(json.negative);
    return counter;
  }
}

// =============================================================================
// LWW-Element-Set
// =============================================================================

/**
 * Metadata for an element in an LWW set.
 */
interface LWWSetEntry {
  timestamp: number;
  nodeId: string;
}

/**
 * LWW-Element-Set - a set where adds and removes have timestamps.
 * An element is in the set if its add timestamp > remove timestamp.
 */
export class LWWSet<T extends string | number> {
  private addSet: Map<T, LWWSetEntry> = new Map();
  private removeSet: Map<T, LWWSetEntry> = new Map();

  constructor() {}

  /**
   * Add an element to the set.
   */
  add(element: T, timestamp: number, nodeId: string): void {
    const existing = this.addSet.get(element);
    if (
      !existing ||
      timestamp > existing.timestamp ||
      (timestamp === existing.timestamp && nodeId > existing.nodeId)
    ) {
      this.addSet.set(element, { timestamp, nodeId });
    }
  }

  /**
   * Remove an element from the set.
   */
  remove(element: T, timestamp: number, nodeId: string): void {
    const existing = this.removeSet.get(element);
    if (
      !existing ||
      timestamp > existing.timestamp ||
      (timestamp === existing.timestamp && nodeId > existing.nodeId)
    ) {
      this.removeSet.set(element, { timestamp, nodeId });
    }
  }

  /**
   * Check if an element is in the set.
   * Element is present if it was added after it was removed (or never removed).
   */
  has(element: T): boolean {
    const addEntry = this.addSet.get(element);
    if (!addEntry) return false;

    const removeEntry = this.removeSet.get(element);
    if (!removeEntry) return true;

    // Add wins if timestamp is greater, or equal timestamp with greater nodeId
    if (addEntry.timestamp > removeEntry.timestamp) return true;
    if (addEntry.timestamp < removeEntry.timestamp) return false;
    return addEntry.nodeId >= removeEntry.nodeId; // Bias toward add on tie
  }

  /**
   * Get all elements currently in the set.
   */
  elements(): T[] {
    const result: T[] = [];
    for (const element of this.addSet.keys()) {
      if (this.has(element)) {
        result.push(element);
      }
    }
    return result;
  }

  /**
   * Get the size of the set.
   */
  size(): number {
    return this.elements().length;
  }

  /**
   * Merge another LWW set into this one.
   */
  merge(other: LWWSet<T>): void {
    // Merge add sets
    for (const [element, entry] of other.addSet) {
      this.add(element, entry.timestamp, entry.nodeId);
    }
    // Merge remove sets
    for (const [element, entry] of other.removeSet) {
      this.remove(element, entry.timestamp, entry.nodeId);
    }
  }

  /**
   * Serialize to JSON.
   */
  toJSON(): {
    addSet: Array<[T, LWWSetEntry]>;
    removeSet: Array<[T, LWWSetEntry]>;
  } {
    return {
      addSet: Array.from(this.addSet.entries()),
      removeSet: Array.from(this.removeSet.entries()),
    };
  }

  /**
   * Create from JSON.
   */
  static fromJSON<T extends string | number>(json: {
    addSet: Array<[T, LWWSetEntry]>;
    removeSet: Array<[T, LWWSetEntry]>;
  }): LWWSet<T> {
    const set = new LWWSet<T>();
    for (const [element, entry] of json.addSet) {
      set.addSet.set(element, entry);
    }
    for (const [element, entry] of json.removeSet) {
      set.removeSet.set(element, entry);
    }
    return set;
  }
}

// =============================================================================
// LWW-Map (Last-Write-Wins Map)
// =============================================================================

/**
 * LWW-Map - a map where each key has an LWW register as its value.
 * Useful for syncing objects/records across nodes.
 */
export class LWWMap<K extends string, V> {
  private entries: Map<K, LWWRegister<V | null>> = new Map();
  private tombstones: Set<K> = new Set();

  constructor() {}

  /**
   * Set a key-value pair.
   */
  set(key: K, value: V, timestamp: number, nodeId: string): void {
    let register = this.entries.get(key);
    if (!register) {
      register = new LWWRegister<V | null>(null, 0, "");
      this.entries.set(key, register);
    }
    register.set(value, timestamp, nodeId);
    // If setting a value, remove from tombstones if the timestamp is newer
    if (timestamp >= (this.getTombstoneTime(key) ?? 0)) {
      this.tombstones.delete(key);
    }
  }

  /**
   * Delete a key.
   */
  delete(key: K, timestamp: number, nodeId: string): void {
    let register = this.entries.get(key);
    if (!register) {
      register = new LWWRegister<V | null>(null, 0, "");
      this.entries.set(key, register);
    }
    register.set(null, timestamp, nodeId);
    this.tombstones.add(key);
  }

  private getTombstoneTime(key: K): number | undefined {
    const register = this.entries.get(key);
    if (register && register.get() === null) {
      return register.timestamp;
    }
    return undefined;
  }

  /**
   * Get a value by key.
   */
  get(key: K): V | undefined {
    const register = this.entries.get(key);
    if (!register) return undefined;
    const value = register.get();
    if (value === null) return undefined;
    return value;
  }

  /**
   * Check if a key exists.
   */
  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  /**
   * Get all keys.
   */
  keys(): K[] {
    const result: K[] = [];
    for (const [key, register] of this.entries) {
      if (register.get() !== null) {
        result.push(key);
      }
    }
    return result;
  }

  /**
   * Get all entries as an object.
   */
  toObject(): Record<K, V> {
    const result: Record<K, V> = {} as Record<K, V>;
    for (const [key, register] of this.entries) {
      const value = register.get();
      if (value !== null) {
        result[key] = value;
      }
    }
    return result;
  }

  /**
   * Merge another LWW map into this one.
   */
  merge(other: LWWMap<K, V>): void {
    for (const [key, otherRegister] of other.entries) {
      let register = this.entries.get(key);
      if (!register) {
        register = new LWWRegister<V | null>(null, 0, "");
        this.entries.set(key, register);
      }
      register.merge(otherRegister);
      // Update tombstone status
      if (register.get() === null) {
        this.tombstones.add(key);
      } else {
        this.tombstones.delete(key);
      }
    }
  }

  /**
   * Serialize to JSON.
   */
  toJSON(): { entries: Array<[K, { value: V | null; timestamp: number; nodeId: string }]> } {
    return {
      entries: Array.from(this.entries.entries()).map(([k, v]) => [k, v.toJSON()]),
    };
  }

  /**
   * Create from JSON.
   */
  static fromJSON<K extends string, V>(json: {
    entries: Array<[K, { value: V | null; timestamp: number; nodeId: string }]>;
  }): LWWMap<K, V> {
    const map = new LWWMap<K, V>();
    for (const [key, registerJson] of json.entries) {
      const register = LWWRegister.fromJSON<V | null>(registerJson);
      map.entries.set(key, register);
      if (register.get() === null) {
        map.tombstones.add(key);
      }
    }
    return map;
  }
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Generate a monotonic timestamp with sub-millisecond precision.
 * Uses high-resolution time when available.
 */
let lastTimestamp = 0;
let counter = 0;

export function generateTimestamp(): number {
  const now = Date.now();
  if (now === lastTimestamp) {
    counter++;
  } else {
    lastTimestamp = now;
    counter = 0;
  }
  // Combine milliseconds with counter for sub-ms ordering
  return now * 1000 + counter;
}

/**
 * Compare two timestamps with nodeId tiebreaker.
 * Returns: -1 if a < b, 0 if equal, 1 if a > b
 */
export function compareTimestamps(
  aTimestamp: number,
  aNodeId: string,
  bTimestamp: number,
  bNodeId: string
): number {
  if (aTimestamp !== bTimestamp) {
    return aTimestamp < bTimestamp ? -1 : 1;
  }
  if (aNodeId !== bNodeId) {
    return aNodeId < bNodeId ? -1 : 1;
  }
  return 0;
}
