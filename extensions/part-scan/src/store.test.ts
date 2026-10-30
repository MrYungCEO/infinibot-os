import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PartScanStore } from "./store.js";

const roots: string[] = [];
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");

function makeStore(): PartScanStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "part-scan-store-"));
  roots.push(root);
  return new PartScanStore(root);
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("PartScanStore", () => {
  it("creates the required plugin-data scan layout", () => {
    const store = makeStore();
    const scan = store.create("Impeller");
    const dir = store.scanDir(scan.id);
    expect(dir).toContain(path.join("plugin-data", "part-scan", "scans"));
    expect(fs.statSync(path.join(dir, "images")).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(dir, "job.json"))).toBe(true);
    expect(scan.job).toMatchObject({ status: "capturing", stage: "capture", progress: 0 });
  });

  it("persists JPEG sequence metadata and replaces a repeated sequence", () => {
    const store = makeStore();
    const scan = store.create("Gear");
    store.uploadImage(scan.id, { base64: jpeg, sequence: 1, turntableAngle: 10, heightPass: 0, sharpness: 90 });
    store.uploadImage(scan.id, { base64: jpeg, sequence: 1, turntableAngle: 20, heightPass: 1, sharpness: 120 });
    expect(store.images(scan.id)).toHaveLength(1);
    expect(store.images(scan.id)[0]).toMatchObject({ turntableAngle: 20, heightPass: 1, sharpness: 120 });
    expect(store.get(scan.id).imageCount).toBe(1);
  });

  it("rejects path traversal ids and non-JPEG payloads", () => {
    const store = makeStore();
    const scan = store.create();
    expect(() => store.get("../../other")).toThrow(/invalid scan id/);
    expect(() => store.uploadImage(scan.id, { base64: Buffer.from("hello").toString("base64"), sequence: 0 })).toThrow(/JPEG/);
  });

  it("lists newest first and deletes only the selected scan", () => {
    const store = makeStore();
    const a = store.create("A");
    const b = store.create("B");
    expect(store.list().map((s) => s.id)).toEqual([b.id, a.id]);
    store.delete(a.id);
    expect(store.list().map((s) => s.id)).toEqual([b.id]);
  });
});
