import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PartScanJobRunner } from "./job-runner.js";
import { createPartScanHandlers } from "./rpc.js";
import { PartScanStore } from "./store.js";
import { DEFAULT_PART_SCAN_CONFIG } from "./types.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("partscan RPCs", () => {
  it("covers create/list/get/start/status and validates file URLs", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "part-scan-rpc-"));
    roots.push(root);
    const store = new PartScanStore(root);
    const runner = new PartScanJobRunner(store, "/missing");
    const handlers = createPartScanHandlers({ store, runner, config: DEFAULT_PART_SCAN_CONFIG });
    const broadcasts: unknown[] = [];
    async function call(method: string, params: Record<string, unknown> = {}) {
      let result: { ok: boolean; payload?: any; error?: any } = { ok: false };
      await handlers[method]!({
        req: {} as never,
        params,
        client: null,
        isWebchatConnect: () => false,
        respond: (ok, payload, error) => (result = { ok, payload, error }),
        context: { broadcast: (_event: string, payload: unknown) => broadcasts.push(payload) } as never,
      });
      return result;
    }
    const created = await call("partscan.create", { name: "Bracket" });
    const id = created.payload.id as string;
    const listed = (await call("partscan.list")).payload;
    expect(listed.scans).toHaveLength(1);
    expect(listed.config).toMatchObject({
      workerMode: "off",
      quality: "balanced",
      markerSquareMm: 20,
      markerDictionary: "DICT_5X5_100",
      boardCols: 5,
      boardRows: 7,
    });
    expect((await call("partscan.get", { id })).payload.scan.name).toBe("Bracket");
    expect((await call("partscan.start", { id })).error.message).toMatch(/at least 3 images/);
    expect((await call("partscan.status", { id })).payload.job.status).toBe("capturing");
    expect((await call("partscan.fileUrl", { id })).error.code).toBe("NOT_FOUND");
    expect(Object.keys(handlers).every((name) => name.startsWith("partscan."))).toBe(true);
  });
});
