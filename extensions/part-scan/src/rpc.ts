import type { GatewayRequestHandler } from "infinibot/plugin-sdk";

import { PartScanJobRunner } from "./job-runner.js";
import { PartScanStore } from "./store.js";
import type { PartScanConfig } from "./types.js";

type Params = Record<string, unknown>;

function record(value: unknown): Params {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Params) : {};
}

function scanId(params: unknown): string {
  const id = record(params).id;
  if (typeof id !== "string" || !id.trim()) throw new Error("scan id is required");
  return id.trim();
}

function handler(
  fn: (opts: Parameters<GatewayRequestHandler>[0]) => unknown | Promise<unknown>,
): GatewayRequestHandler {
  return async (opts) => {
    try {
      const payload = await fn(opts);
      opts.respond(true, payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const notFound = /not found/i.test(message);
      opts.respond(false, undefined, {
        code: notFound ? "NOT_FOUND" : "INVALID_PARAMS",
        message,
      });
    }
  };
}

export function createPartScanHandlers(runtime: {
  store: PartScanStore;
  runner: PartScanJobRunner;
  config: PartScanConfig;
}): Record<string, GatewayRequestHandler> {
  const { store, runner, config } = runtime;
  return {
    "partscan.create": handler(({ params }) => store.create(record(params).name)),
    "partscan.list": handler(() => ({ scans: store.list(), config })),
    "partscan.get": handler(({ params }) => {
      const id = scanId(params);
      return { scan: store.get(id), images: store.images(id), config };
    }),
    "partscan.delete": handler(({ params }) => {
      const id = scanId(params);
      try {
        runner.cancel(id);
      } catch {
        // A non-running scan needs no cancellation.
      }
      store.delete(id);
      return { deleted: true, id };
    }),
    "partscan.uploadImage": handler(({ params }) => {
      const p = record(params);
      const id = scanId(p);
      if (typeof p.base64 !== "string") throw new Error("base64 JPEG is required");
      return {
        image: store.uploadImage(id, {
          base64: p.base64,
          sequence: Number(p.sequence),
          turntableAngle: typeof p.turntableAngle === "number" ? p.turntableAngle : undefined,
          heightPass: typeof p.heightPass === "number" ? p.heightPass : undefined,
          sharpness: typeof p.sharpness === "number" ? p.sharpness : undefined,
        }),
        scan: store.get(id),
      };
    }),
    "partscan.start": handler((opts) => {
      const id = scanId(opts.params);
      const job = runner.start(id, config, (event) => {
        try {
          opts.context.broadcast("partscan.job.progress", event, { dropIfSlow: true });
        } catch {
          // Progress is still durable in job.json when the browser disconnects.
        }
      });
      return { scan: store.get(id), job };
    }),
    "partscan.status": handler(({ params }) => {
      const id = scanId(params);
      return { id, job: store.readJob(id), scan: store.get(id) };
    }),
    "partscan.cancel": handler(({ params }) => {
      const id = scanId(params);
      return { id, job: runner.cancel(id) };
    }),
    "partscan.fileUrl": handler(({ params }) => {
      const p = record(params);
      const id = scanId(p);
      const file = p.file === "preview.png" || p.file === "dims.json" ? p.file : "model.glb";
      store.file(id, file);
      return {
        url: `/plugins/part-scan/file?id=${encodeURIComponent(id)}&file=${encodeURIComponent(file)}`,
        file,
      };
    }),
  };
}
