import fs from "node:fs";
import type { ServerResponse } from "node:http";
import path from "node:path";
import type { InfiniBotPluginApi, InfiniBotPluginService } from "infinibot/plugin-sdk";

import { charucoPdf, charucoSvg } from "./src/board.js";
import { PartScanJobRunner } from "./src/job-runner.js";
import { createPartScanHandlers } from "./src/rpc.js";
import { SAMPLE_DIMS, sampleGlb } from "./src/sample-glb.js";
import { PartScanStore } from "./src/store.js";
import { createPartScanTool } from "./src/tools.js";
import { readPartScanConfig } from "./src/types.js";

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function sendBuffer(res: ServerResponse, body: Buffer | string, contentType: string, filename?: string): void {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  const headers: Record<string, string | number> = {
    "content-type": contentType,
    "content-length": data.length,
    "cache-control": "private, max-age=60",
    "x-content-type-options": "nosniff",
  };
  if (filename) headers["content-disposition"] = `attachment; filename="${filename}"`;
  res.writeHead(200, headers);
  res.end(data);
}

export default function register(api: InfiniBotPluginApi): void {
  const config = readPartScanConfig(api.pluginConfig);
  const store = new PartScanStore(api.runtime.state.resolveStateDir());
  const runner = new PartScanJobRunner(store, api.resolvePath("worker/pipeline.py"));

  for (const [method, rpcHandler] of Object.entries(createPartScanHandlers({ store, runner, config }))) {
    api.registerGatewayMethod(method, rpcHandler);
  }
  api.registerTool(() => createPartScanTool(store, runner, config), {
    optional: true,
    name: "part_scan",
  });

  api.registerHttpRoute({
    path: "/plugins/part-scan/file",
    handler: (req, res) => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const id = url.searchParams.get("id") ?? "";
        const raw = url.searchParams.get("file");
        const file = raw === "preview.png" || raw === "dims.json" ? raw : "model.glb";
        const resolved = store.file(id, file);
        const type = file === "model.glb" ? "model/gltf-binary" : file === "preview.png" ? "image/png" : "application/json";
        const stat = fs.statSync(resolved);
        res.writeHead(200, {
          "content-type": type,
          "content-length": stat.size,
          "cache-control": "private, max-age=60",
          "content-disposition": file === "model.glb" ? `attachment; filename="${id}.glb"` : "inline",
          "x-content-type-options": "nosniff",
        });
        fs.createReadStream(resolved).pipe(res);
      } catch (error) {
        json(res, 404, { error: error instanceof Error ? error.message : String(error) });
      }
    },
  });

  api.registerHttpRoute({
    path: "/plugins/part-scan/sample.glb",
    handler: (_req, res) => sendBuffer(res, sampleGlb(), "model/gltf-binary", "part-scan-40x20x10mm.glb"),
  });
  api.registerHttpRoute({
    path: "/plugins/part-scan/board.svg",
    handler: (_req, res) => sendBuffer(res, charucoSvg(config), "image/svg+xml; charset=utf-8", "part-scan-charuco.svg"),
  });
  api.registerHttpRoute({
    path: "/plugins/part-scan/board.pdf",
    handler: (_req, res) => sendBuffer(res, charucoPdf(config), "application/pdf", "part-scan-charuco.pdf"),
  });

  const service: InfiniBotPluginService = {
    id: "part-scan-worker",
    start: () => {
      store.ensure();
      runner.recoverInterrupted();
      const fixtureDir = path.join(store.root, "fixtures");
      fs.mkdirSync(fixtureDir, { recursive: true });
      // Keep the expected fixture dimensions beside plugin data for support/diagnostics.
      const fixtureDims = path.join(fixtureDir, "40x20x10mm.dims.json");
      if (!fs.existsSync(fixtureDims)) fs.writeFileSync(fixtureDims, `${JSON.stringify(SAMPLE_DIMS, null, 2)}\n`);
    },
    stop: () => runner.stop(),
  };
  api.registerService(service);
}
