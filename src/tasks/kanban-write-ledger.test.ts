import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLedgerPusher, createWriteLedger } from "./kanban-write-ledger.js";

type Row = { id: string; notionId?: string; status: string; done: boolean; updatedAt?: number };
const T0 = Date.UTC(2026, 9, 14, 9, 0, 30);

function clock(start = T0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("kanban write ledger (version-guarded merge)", () => {
  it("versions increase per write and fields merge per task", () => {
    const c = clock();
    const l = createWriteLedger({ now: c.now });
    const a = l.record("task-1", { status: "in_progress", done: false })!;
    const b = l.record("task-1", { title: "x" })!;
    expect(b.version).toBeGreaterThan(a.version);
    expect(b.fields).toEqual({ status: "in_progress", done: false, title: "x" });
  });

  it("an unpushed write beats any source read; matching ids ignore dashes/case", () => {
    const c = clock();
    const l = createWriteLedger({ now: c.now });
    l.record("3BCF4BDD-9BCF-81E0", { status: "done", done: true });
    const rows: Row[] = [{ id: "3bcf4bdd9bcf81e0", status: "todo", done: false }];
    const { rows: out } = l.apply(rows);
    expect(out[0]).toMatchObject({ status: "done", done: true, syncPending: true });
    expect(l.size()).toBe(1);
  });

  it("retires once the source agrees after the push — and only from a source read", () => {
    const c = clock();
    const l = createWriteLedger({ now: c.now });
    const e = l.record("t", { status: "done", done: true })!;
    l.markPushed("t", e.version);
    const agreeing: Row[] = [{ id: "t", status: "done", done: true }];
    l.apply(agreeing, { fromSource: false });
    expect(l.size()).toBe(1); // a cache serve never retires
    l.apply(agreeing);
    expect(l.size()).toBe(0);
  });

  it("a pushed write keeps winning over a lagging source; a later-minute remote edit wins", () => {
    const c = clock();
    const l = createWriteLedger({ now: c.now });
    const e = l.record("t", { status: "done", done: true })!;
    l.markPushed("t", e.version);
    // Same-minute edit stamp = our own push (Notion truncates to the minute).
    const lagging: Row[] = [{ id: "t", status: "todo", done: false, updatedAt: T0 - 30_000 }];
    expect(l.apply(lagging).rows[0].status).toBe("done");
    const remote: Row[] = [{ id: "t", status: "in_progress", done: false, updatedAt: T0 + 60_000 }];
    const r = l.apply(remote);
    expect(r.rows[0].status).toBe("in_progress");
    expect(r.remoteNewer).toEqual(["t"]);
    expect(l.size()).toBe(0);
  });

  it("a push for an older version doesn't mark a newer write as synced", () => {
    const c = clock();
    const l = createWriteLedger({ now: c.now });
    const v1 = l.record("t", { status: "done" })!.version;
    l.record("t", { status: "todo" });
    l.markPushed("t", v1);
    expect(l.pending().map((p) => p.id)).toEqual(["t"]);
  });

  it("pushed entries expire after settleMs; pending ones survive restarts", () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-"));
    const path = join(dir, "kanban", "write-ledger.json");
    const c = clock();
    const l = createWriteLedger({ now: c.now, persistPath: path, settleMs: 60_000 });
    const pushed = l.record("a", { status: "done" })!;
    l.markPushed("a", pushed.version);
    l.record("b", { status: "review" });
    l.flush();
    const reloaded = createWriteLedger({ now: c.now, persistPath: path, settleMs: 60_000 });
    expect(reloaded.size()).toBe(2);
    expect(reloaded.record("c", { status: "todo" })!.version).toBeGreaterThan(pushed.version);
    c.advance(61_000);
    expect(
      reloaded
        .pending()
        .map((p) => p.id)
        .sort(),
    ).toEqual(["b", "c"]);
    expect(reloaded.get("a")).toBeUndefined();
  });
});

describe("ledger sync flag", () => {
  it("a cached row merged before the push loses its syncPending flag once pushed", () => {
    const l = createWriteLedger();
    const e = l.record("t", { status: "review", done: false })!;
    const cached = l.apply([{ id: "t", status: "done", done: true } as Row], {
      fromSource: false,
    }).rows;
    expect(cached[0]).toMatchObject({ status: "review", syncPending: true });
    l.markPushed("t", e.version);
    expect(l.apply(cached, { fromSource: false }).rows[0]).toMatchObject({
      status: "review",
      syncPending: false,
    });
    const lagging = l.apply([{ id: "t", status: "done", done: true } as Row], {
      fromSource: false,
    }).rows;
    expect(lagging[0]).toMatchObject({ status: "review", syncPending: false });
  });
});

describe("ledger delete tombstones", () => {
  it("drops the row from any list (cached or source) and ignores late writes", () => {
    const l = createWriteLedger();
    l.tombstone("3bcf4bdd-9bcf-81e0");
    const rows: Row[] = [
      { id: "3bcf4bdd9bcf81e0", status: "todo", done: false },
      { id: "keep", status: "todo", done: false },
    ];
    expect(l.apply(rows).rows.map((r) => r.id)).toEqual(["keep"]);
    expect(l.apply(rows, { fromSource: false }).rows.map((r) => r.id)).toEqual(["keep"]);
    expect(l.record("3bcf4bdd-9bcf-81e0", { status: "done" })).toBeNull();
    expect(l.apply(rows).rows.map((r) => r.id)).toEqual(["keep"]);
    expect(l.pending()).toEqual([]);
  });
});

describe("ledger pusher", () => {
  it("retries a failed push with backoff and pushes the newest version", async () => {
    const l = createWriteLedger();
    const pushed: unknown[] = [];
    let fail = true;
    const p = createLedgerPusher(
      l,
      async (e) => {
        if (fail) throw new Error("Notion API 429: slow down");
        pushed.push(e.fields.status);
      },
      { delays: [5] },
    );
    l.record("t", { status: "done" });
    await p.kick("t");
    expect(l.get("t")?.attempts).toBe(1);
    fail = false;
    l.record("t", { status: "review" }); // newer write while waiting to retry
    await new Promise((r) => setTimeout(r, 20));
    await p.idle();
    expect(pushed).toEqual(["review"]);
    expect(l.pending()).toEqual([]);
    p.stop();
  });

  it("a write that lands during an in-flight push is pushed right after it", async () => {
    const l = createWriteLedger();
    const seen: unknown[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const p = createLedgerPusher(l, async (e) => {
      seen.push(e.fields.status);
      if (seen.length === 1) await gate;
    });
    l.record("t", { status: "in_progress" });
    const first = p.kick("t");
    await new Promise((r) => setTimeout(r, 0));
    l.record("t", { status: "done" });
    const second = p.kick("t");
    release();
    await Promise.all([first, second]);
    await p.idle();
    expect(seen).toEqual(["in_progress", "done"]);
    expect(l.pending()).toEqual([]);
  });
});
