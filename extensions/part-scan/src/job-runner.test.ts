import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PartScanJobRunner } from "./job-runner.js";
import { PartScanStore } from "./store.js";
import { DEFAULT_PART_SCAN_CONFIG } from "./types.js";

const roots: string[] = [];
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "part-scan-runner-"));
  roots.push(root);
  const store = new PartScanStore(root);
  const scan = store.create("Fixture");
  for (let i = 0; i < 3; i++) store.uploadImage(scan.id, { base64: jpeg, sequence: i });
  return { root, store, scan };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("PartScanJobRunner", () => {
  it("streams JSON-line progress and persists a completed job with dimensions", async () => {
    const { store, scan } = setup();
    const runner = new PartScanJobRunner(store, "/unused", undefined, (entry) => {
      const dir = store.scanDir(entry.scanId);
      const script = [
        'console.log(JSON.stringify({stage:"features",progress:0.2}))',
        'console.log(JSON.stringify({stage:"mesh",progress:0.75,message:"meshing"}))',
        `require("fs").writeFileSync(${JSON.stringify(path.join(dir, "model.glb"))}, "glb")`,
        `require("fs").writeFileSync(${JSON.stringify(path.join(dir, "preview.png"))}, "png")`,
        `require("fs").writeFileSync(${JSON.stringify(path.join(dir, "dims.json"))}, JSON.stringify({orientedBboxMm:{length:40,width:20,height:10}}))`,
      ].join(";");
      return { command: process.execPath, args: ["-e", script] };
    });
    const stages: string[] = [];
    runner.start(scan.id, { ...DEFAULT_PART_SCAN_CONFIG, workerMode: "local-cli" }, (event) => stages.push(event.job.stage));
    await runner.waitForIdle();
    expect(store.readJob(scan.id)).toMatchObject({ status: "done", stage: "complete", progress: 1, error: null });
    expect(store.get(scan.id).dims?.orientedBboxMm).toEqual({ length: 40, width: 20, height: 10 });
    expect(stages).toContain("features");
    expect(stages).toContain("mesh");
  });

  it("runs one job at a time", async () => {
    const { store, scan: first } = setup();
    const second = store.create("Second");
    for (let i = 0; i < 3; i++) store.uploadImage(second.id, { base64: jpeg, sequence: i });
    const order: string[] = [];
    const runner = new PartScanJobRunner(store, "/unused", undefined, (entry) => {
      const dir = store.scanDir(entry.scanId);
      const script = [
        `console.log(${JSON.stringify(entry.scanId)})`,
        `require("fs").writeFileSync(${JSON.stringify(path.join(dir, "model.glb"))}, "glb")`,
        `require("fs").writeFileSync(${JSON.stringify(path.join(dir, "preview.png"))}, "png")`,
        `require("fs").writeFileSync(${JSON.stringify(path.join(dir, "dims.json"))}, "{}")`,
      ].join(";");
      order.push(`spawn:${entry.scanId}`);
      return { command: process.execPath, args: ["-e", script] };
    });
    const cfg = { ...DEFAULT_PART_SCAN_CONFIG, workerMode: "local-cli" as const };
    runner.start(first.id, cfg);
    runner.start(second.id, cfg);
    await runner.waitForIdle();
    expect(order).toEqual([`spawn:${first.id}`, `spawn:${second.id}`]);
  });

  it("fails clearly when the worker is disabled", () => {
    const { store, scan } = setup();
    const runner = new PartScanJobRunner(store, "/missing");
    const job = runner.start(scan.id, DEFAULT_PART_SCAN_CONFIG);
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/worker not installed/i);
    expect(job.error).toMatch(/docker build/);
  });
});
