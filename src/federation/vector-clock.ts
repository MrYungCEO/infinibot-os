/**
 * Vector Clock for Federation Sync
 *
 * Vector clocks track causality across distributed nodes.
 * They allow us to determine:
 * - If event A happened before event B (causally ordered)
 * - If events are concurrent (no causal relationship)
 */

// =============================================================================
// Vector Clock
// =============================================================================

/**
 * Vector Clock implementation for tracking causality across federation nodes.
 */
export class VectorClock {
  private clock: Map<string, number> = new Map();

  constructor(initial?: Map<string, number> | Record<string, number>) {
    if (initial) {
      if (initial instanceof Map) {
        this.clock = new Map(initial);
      } else {
        this.clock = new Map(Object.entries(initial));
      }
    }
  }

  /**
   * Increment the clock for a specific node.
   * Call this before sending a message or recording an event.
   */
  increment(nodeId: string): void {
    const current = this.clock.get(nodeId) ?? 0;
    this.clock.set(nodeId, current + 1);
  }

  /**
   * Get the clock value for a specific node.
   */
  get(nodeId: string): number {
    return this.clock.get(nodeId) ?? 0;
  }

  /**
   * Set the clock value for a specific node.
   */
  set(nodeId: string, value: number): void {
    this.clock.set(nodeId, value);
  }

  /**
   * Get all node IDs in the clock.
   */
  nodes(): string[] {
    return Array.from(this.clock.keys());
  }

  /**
   * Merge another vector clock into this one.
   * Takes the maximum value for each node.
   * Call this when receiving a message.
   */
  merge(other: VectorClock): void {
    for (const [nodeId, value] of other.clock) {
      const current = this.clock.get(nodeId) ?? 0;
      this.clock.set(nodeId, Math.max(current, value));
    }
  }

  /**
   * Create a copy of this clock.
   */
  copy(): VectorClock {
    return new VectorClock(new Map(this.clock));
  }

  // ===========================================================================
  // Comparison Operations
  // ===========================================================================

  /**
   * Check if this clock happens before another clock.
   * A happens-before B if all of A's values are <= B's values,
   * and at least one is strictly less.
   */
  happensBefore(other: VectorClock): boolean {
    let strictlyLess = false;
    const allNodes = new Set([...this.clock.keys(), ...other.clock.keys()]);

    for (const nodeId of allNodes) {
      const thisValue = this.clock.get(nodeId) ?? 0;
      const otherValue = other.clock.get(nodeId) ?? 0;

      if (thisValue > otherValue) {
        // This is greater in at least one dimension
        return false;
      }
      if (thisValue < otherValue) {
        strictlyLess = true;
      }
    }

    return strictlyLess;
  }

  /**
   * Check if this clock happens after another clock.
   */
  happensAfter(other: VectorClock): boolean {
    return other.happensBefore(this);
  }

  /**
   * Check if this clock is concurrent with another clock.
   * Clocks are concurrent if neither happens before the other.
   */
  concurrent(other: VectorClock): boolean {
    return !this.happensBefore(other) && !other.happensBefore(this);
  }

  /**
   * Check if this clock is identical to another clock.
   */
  equals(other: VectorClock): boolean {
    const allNodes = new Set([...this.clock.keys(), ...other.clock.keys()]);
    for (const nodeId of allNodes) {
      if ((this.clock.get(nodeId) ?? 0) !== (other.clock.get(nodeId) ?? 0)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Compare this clock with another.
   * Returns:
   * - "before" if this happens before other
   * - "after" if this happens after other
   * - "concurrent" if neither
   * - "equal" if identical
   */
  compare(other: VectorClock): "before" | "after" | "concurrent" | "equal" {
    if (this.equals(other)) return "equal";
    if (this.happensBefore(other)) return "before";
    if (this.happensAfter(other)) return "after";
    return "concurrent";
  }

  // ===========================================================================
  // Serialization
  // ===========================================================================

  /**
   * Serialize to a plain object.
   */
  toJSON(): Record<string, number> {
    return Object.fromEntries(this.clock);
  }

  /**
   * Create from a plain object.
   */
  static fromJSON(json: Record<string, number>): VectorClock {
    return new VectorClock(json);
  }

  /**
   * Create a human-readable string representation.
   */
  toString(): string {
    const entries = Array.from(this.clock.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}:${v}`)
      .join(", ");
    return `VectorClock{${entries}}`;
  }
}

// =============================================================================
// Versioned Value
// =============================================================================

/**
 * A value with an associated vector clock for versioning.
 */
export interface VersionedValue<T> {
  value: T;
  clock: Record<string, number>;
  nodeId: string;
  timestamp: number;
}

/**
 * Create a versioned value.
 */
export function createVersionedValue<T>(
  value: T,
  clock: VectorClock,
  nodeId: string
): VersionedValue<T> {
  return {
    value,
    clock: clock.toJSON(),
    nodeId,
    timestamp: Date.now(),
  };
}

/**
 * Compare two versioned values using their vector clocks.
 */
export function compareVersionedValues<T>(
  a: VersionedValue<T>,
  b: VersionedValue<T>
): "a-wins" | "b-wins" | "concurrent" {
  const clockA = VectorClock.fromJSON(a.clock);
  const clockB = VectorClock.fromJSON(b.clock);

  const comparison = clockA.compare(clockB);

  switch (comparison) {
    case "before":
      return "b-wins";
    case "after":
    case "equal":
      return "a-wins";
    case "concurrent":
      // For concurrent updates, use timestamp + nodeId as tiebreaker
      if (a.timestamp !== b.timestamp) {
        return a.timestamp > b.timestamp ? "a-wins" : "b-wins";
      }
      return a.nodeId > b.nodeId ? "a-wins" : "b-wins";
  }
}

// =============================================================================
// Causal History
// =============================================================================

/**
 * Tracks causal history of operations for a resource.
 */
export class CausalHistory {
  private history: Map<string, VectorClock> = new Map();

  /**
   * Record an operation's vector clock.
   */
  record(operationId: string, clock: VectorClock): void {
    this.history.set(operationId, clock.copy());
  }

  /**
   * Check if an operation has been seen.
   */
  hasSeen(operationId: string): boolean {
    return this.history.has(operationId);
  }

  /**
   * Get the clock for an operation.
   */
  getClock(operationId: string): VectorClock | undefined {
    return this.history.get(operationId);
  }

  /**
   * Check if a new operation (with its clock) is causally ready.
   * An operation is ready if all its dependencies have been applied.
   */
  isReady(operationClock: VectorClock, localClock: VectorClock): boolean {
    // The operation is ready if the local clock has seen all events
    // that the operation depends on (all values in operationClock - 1
    // should be <= corresponding values in localClock)
    return operationClock.happensBefore(localClock) || operationClock.equals(localClock);
  }

  /**
   * Clear history older than a given clock.
   */
  compact(threshold: VectorClock): void {
    for (const [opId, clock] of this.history) {
      if (clock.happensBefore(threshold)) {
        this.history.delete(opId);
      }
    }
  }

  /**
   * Get the number of operations in history.
   */
  size(): number {
    return this.history.size;
  }
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Create a new vector clock with an initial tick for a node.
 */
export function createVectorClock(nodeId: string): VectorClock {
  const clock = new VectorClock();
  clock.increment(nodeId);
  return clock;
}

/**
 * Merge multiple vector clocks into a new clock.
 */
export function mergeVectorClocks(...clocks: VectorClock[]): VectorClock {
  const merged = new VectorClock();
  for (const clock of clocks) {
    merged.merge(clock);
  }
  return merged;
}
