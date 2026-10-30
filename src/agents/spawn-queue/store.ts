/**
 * Spawn-queue persistence — append-only JSONL log next to the subagent
 * registry's `runs.json` (in STATE_DIR/subagents/spawn_queues.jsonl).
 *
 * One record is appended per state change (queue create, item upsert, queue
 * delete, item delete) so the file is a replayable journal. On load we replay
 * the journal — last write per id wins — then compact the file back to a
 * consolidated snapshot so it doesn't grow without bound across restarts.
 *
 * Mirrors the style of subagent-registry.store.ts but uses JSONL because the
 * spec asks for "one record per state change for replay".
 */

import fs from "node:fs";
import path from "node:path";

import { resolveStateDir } from "../../config/paths.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { QueueItem, SpawnQueue } from "./types.js";

const log = createSubsystemLogger("spawn-queue-store");

type JournalRecord =
  | { kind: "queue"; at: number; queue: SpawnQueue }
  | { kind: "item"; at: number; item: QueueItem }
  | { kind: "delete-queue"; at: number; name: string }
  | { kind: "delete-item"; at: number; id: string };

export interface QueueStoreSnapshot {
  queues: Map<string, SpawnQueue>;
  items: Map<string, QueueItem>;
}

/**
 * Append-only journal store. The default real store writes to disk; tests pass
 * an in-memory store (or `null`) to keep persistence out of the unit under test.
 */
export interface QueueStore {
  load(): QueueStoreSnapshot;
  putQueue(queue: SpawnQueue): void;
  putItem(item: QueueItem): void;
  deleteQueue(name: string): void;
  deleteItem(id: string): void;
}

export function resolveSpawnQueuePath(): string {
  return path.join(resolveStateDir(), "subagents", "spawn_queues.jsonl");
}

/** No-op store for tests that don't exercise persistence. */
export const NOOP_QUEUE_STORE: QueueStore = {
  load: () => ({ queues: new Map(), items: new Map() }),
  putQueue: () => {},
  putItem: () => {},
  deleteQueue: () => {},
  deleteItem: () => {},
};

export class JsonlQueueStore implements QueueStore {
  private readonly pathname: string;

  constructor(pathname: string = resolveSpawnQueuePath()) {
    this.pathname = pathname;
  }

  load(): QueueStoreSnapshot {
    const queues = new Map<string, SpawnQueue>();
    const items = new Map<string, QueueItem>();
    let raw: string;
    try {
      if (!fs.existsSync(this.pathname)) return { queues, items };
      raw = fs.readFileSync(this.pathname, "utf8");
    } catch (err) {
      log.warn("spawn-queue journal read failed", {
        err: err instanceof Error ? err.message : String(err),
      });
      return { queues, items };
    }

    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let rec: JournalRecord;
      try {
        rec = JSON.parse(trimmed) as JournalRecord;
      } catch {
        continue; // skip a torn line rather than dropping the whole journal
      }
      switch (rec.kind) {
        case "queue":
          if (rec.queue?.name) queues.set(rec.queue.name, rec.queue);
          break;
        case "item":
          if (rec.item?.id) items.set(rec.item.id, rec.item);
          break;
        case "delete-queue":
          queues.delete(rec.name);
          break;
        case "delete-item":
          items.delete(rec.id);
          break;
        default:
          break;
      }
    }

    // Compact the journal back to a consolidated snapshot so replay stays
    // bounded. Best-effort: a failure here just leaves the longer journal.
    try {
      this.compact(queues, items);
    } catch (err) {
      log.warn("spawn-queue journal compaction failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
    return { queues, items };
  }

  private compact(queues: Map<string, SpawnQueue>, items: Map<string, QueueItem>): void {
    const now = Date.now();
    const lines: string[] = [];
    for (const queue of queues.values()) {
      lines.push(JSON.stringify({ kind: "queue", at: now, queue } satisfies JournalRecord));
    }
    for (const item of items.values()) {
      lines.push(JSON.stringify({ kind: "item", at: now, item } satisfies JournalRecord));
    }
    this.writeAll(lines);
  }

  private writeAll(lines: string[]): void {
    const dir = path.dirname(this.pathname);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.pathname, lines.length ? `${lines.join("\n")}\n` : "", "utf8");
    fs.chmodSync(this.pathname, 0o600);
  }

  private append(rec: JournalRecord): void {
    try {
      const dir = path.dirname(this.pathname);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.appendFileSync(this.pathname, `${JSON.stringify(rec)}\n`, "utf8");
    } catch (err) {
      log.warn("spawn-queue journal append failed", {
        kind: rec.kind,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  putQueue(queue: SpawnQueue): void {
    this.append({ kind: "queue", at: Date.now(), queue });
  }

  putItem(item: QueueItem): void {
    this.append({ kind: "item", at: Date.now(), item });
  }

  deleteQueue(name: string): void {
    this.append({ kind: "delete-queue", at: Date.now(), name });
  }

  deleteItem(id: string): void {
    this.append({ kind: "delete-item", at: Date.now(), id });
  }
}
