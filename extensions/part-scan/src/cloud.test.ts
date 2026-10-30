import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PartScanJobRunner } from "./job-runner.js";
import { PartScanStore } from "./store.js";
import { DEFAULT_PART_SCAN_CONFIG, isCloudTenant, readPartScanConfig } from "./types.js";

const CLOUD = { SAAS_MODE: "1", FLEET_TENANT_ID: "t-1" } as NodeJS.ProcessEnv;
const roots: string[] = [];
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "part-scan-cloud-"));
  roots.push(root);
  const store = new PartScanStore(root);
  const scan = store.create("Fixture");
  for (let i = 0; i < 3; i++) store.uploadImage(scan.id, { base64: jpeg, sequence: i });
  return { store, scan };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("part-scan on InfiniBot Cloud", () => {
  it("detects a workspace Machine only with SAAS_MODE + FLEET_TENANT_ID", () => {
    expect(isCloudTenant(CLOUD)).toBe(true);
    expect(isCloudTenant({ SAAS_MODE: "1" })).toBe(false);
    expect(isCloudTenant({})).toBe(false);
  });

  it("forces the reconstruction worker off whatever the config says (no local exec)", () => {
    for (const workerMode of ["docker", "local-cli"]) {
      expect(readPartScanConfig({ workerMode }, CLOUD)).toMatchObject({ workerMode: "off", cloud: true });
      expect(readPartScanConfig({ workerMode }, {})).toMatchObject({ workerMode });
    }
  });

  it("start() records the self-hosted-only reason instead of spawning", () => {
    const { store, scan } = setup();
    const runner = new PartScanJobRunner(store, "/missing", () => {
      throw new Error("must not spawn");
    });
    const job = runner.start(scan.id, readPartScanConfig({ workerMode: "docker" }, CLOUD));
    expect(job).toMatchObject({ status: "failed", stage: "worker-unavailable" });
    expect(job.error).toMatch(/self-hosted InfiniBot only/);
    expect(job.error).not.toMatch(/docker build/);
  });

  it("docker mode passes only pipeline args (the image ENTRYPOINT runs pipeline.py)", () => {
    const { store, scan } = setup();
    const runner = new PartScanJobRunner(store, "/unused");
    const cmd = (runner as unknown as { command(e: unknown): { command: string; args: string[] } }).command({
      scanId: scan.id,
      config: { ...DEFAULT_PART_SCAN_CONFIG, workerMode: "docker" },
    });
    expect(cmd.command).toBe("docker");
    const image = cmd.args.indexOf(DEFAULT_PART_SCAN_CONFIG.workerImage);
    expect(cmd.args[image + 1]).toBe("--scan-dir");
    expect(cmd.args).not.toContain("/opt/part-scan/pipeline.py");
  });
});
