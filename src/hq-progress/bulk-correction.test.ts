import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_HQ_BULK_CORRECTION_FILE,
  HQ_BULK_CORRECTION_DIRNAME,
  HQ_BULK_CORRECTION_ENV,
  applyHqBulkCorrectionFile,
  parseHqBulkCorrectionIds,
  resolveHqBulkCorrectionFiles,
  runHqBulkCorrectionMigration,
} from "./bulk-correction.js";
import { HqProgressStore, isCountedHqEvent } from "./store.js";

const FIXTURE = join(
  import.meta.dirname,
  "test-fixtures",
  "tasks-bulk-complete-backup.sample.json",
);
const ID = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

function seeded() {
  const dir = mkdtempSync(join(tmpdir(), "hq-bulk-"));
  const file = join(dir, "hq-progress.json");
  const store = new HqProgressStore(file);
  // 3 ids from the backup + 2 real completions.
  for (const id of [ID(1), ID(2), ID(3), "real-1", "real-2"]) {
    store.record({ kind: "task.done", objectId: id, title: id, source: "kanban" });
  }
  return { dir, file, store };
}

const counted = (file: string) =>
  (JSON.parse(readFileSync(file, "utf8")).events as Array<{ bulk?: boolean; objectId: string }>)
    .filter(isCountedHqEvent)
    .map((e) => e.objectId);

describe("hq-progress bulk correction", () => {
  it("parses the backup shape (rows with id/notionId) and other shapes", () => {
    const ids = parseHqBulkCorrectionIds(JSON.parse(readFileSync(FIXTURE, "utf8")));
    expect([...(ids ?? [])].sort()).toEqual([ID(1), ID(2), ID(3)]);
    expect(parseHqBulkCorrectionIds(["a", "b"])?.size).toBe(2);
    expect(parseHqBulkCorrectionIds({ ids: ["a"] })?.size).toBe(1);
    expect(parseHqBulkCorrectionIds({ tasks: [{ taskId: "a" }] })?.size).toBe(1);
    expect(parseHqBulkCorrectionIds({ nope: 1 })).toBeNull();
    expect(parseHqBulkCorrectionIds([])).toBeNull();
    expect(parseHqBulkCorrectionIds("x")).toBeNull();
  });

  it("marks the listed ids as bulk, never deletes, and is idempotent", () => {
    const { file, store } = seeded();
    const first = applyHqBulkCorrectionFile(store, FIXTURE);
    expect(first).toMatchObject({ status: "applied", ids: 3, matched: 3, marked: 3 });
    expect(JSON.parse(readFileSync(file, "utf8")).events).toHaveLength(5);
    expect(counted(file)).toEqual(["real-1", "real-2"]);

    // Same store, and a fresh process reading the file: both no-op.
    expect(applyHqBulkCorrectionFile(store, FIXTURE).status).toBe("already-applied");
    const fresh = new HqProgressStore(file);
    expect(applyHqBulkCorrectionFile(fresh, FIXTURE)).toMatchObject({
      status: "already-applied",
      marked: 0,
    });
    // An identical copy elsewhere shares the id-set key → no double application.
    const copy = join(mkdtempSync(join(tmpdir(), "hq-bulk-copy-")), "copy.json");
    copyFileSync(FIXTURE, copy);
    expect(applyHqBulkCorrectionFile(fresh, copy).status).toBe("already-applied");
    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    expect(Object.keys(onDisk.corrections)).toHaveLength(1);
    expect(Object.values(onDisk.corrections)[0]).toMatchObject({ file: FIXTURE, marked: 3 });
  });

  it("missing file is a no-op", () => {
    const { file, store } = seeded();
    const before = readFileSync(file, "utf8");
    expect(applyHqBulkCorrectionFile(store, join(tmpdir(), "does-not-exist-hq.json")).status).toBe(
      "missing",
    );
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("malformed file is a no-op", () => {
    const { dir, file, store } = seeded();
    const before = readFileSync(file, "utf8");
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{ not json");
    expect(applyHqBulkCorrectionFile(store, bad).status).toBe("malformed");
    writeFileSync(bad, JSON.stringify({ hello: "world" }));
    expect(applyHqBulkCorrectionFile(store, bad).status).toBe("malformed");
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("does not create a progress log that doesn't exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "hq-bulk-empty-"));
    const store = new HqProgressStore(join(dir, "hq-progress.json"));
    expect(applyHqBulkCorrectionFile(store, FIXTURE).status).toBe("no-progress-log");
  });

  it("resolves candidate files from env or defaults + <stateDir>/hq-bulk-corrections", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "hq-bulk-state-"));
    mkdirSync(join(stateDir, HQ_BULK_CORRECTION_DIRNAME));
    writeFileSync(join(stateDir, HQ_BULK_CORRECTION_DIRNAME, "b.json"), "[]");
    writeFileSync(join(stateDir, HQ_BULK_CORRECTION_DIRNAME, "notes.txt"), "");
    expect(resolveHqBulkCorrectionFiles({ env: {}, stateDir })).toEqual([
      DEFAULT_HQ_BULK_CORRECTION_FILE,
      join(stateDir, HQ_BULK_CORRECTION_DIRNAME, "b.json"),
    ]);
    expect(
      resolveHqBulkCorrectionFiles({
        env: { [HQ_BULK_CORRECTION_ENV]: ["/x/a.json", "/x/b.json"].join(delimiter) },
        stateDir,
      }),
    ).toEqual(["/x/a.json", "/x/b.json"]);
    expect(resolveHqBulkCorrectionFiles({ env: { [HQ_BULK_CORRECTION_ENV]: "off" }, stateDir })).toEqual(
      [],
    );
  });

  it("runHqBulkCorrectionMigration applies env-configured files and never throws", () => {
    const { file, store } = seeded();
    const res = runHqBulkCorrectionMigration({
      env: { [HQ_BULK_CORRECTION_ENV]: [FIXTURE, "/nope/missing.json"].join(delimiter) },
      store,
    });
    expect(res.map((r) => r.status)).toEqual(["applied", "missing"]);
    expect(counted(file)).toEqual(["real-1", "real-2"]);
  });
});
