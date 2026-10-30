import { Type } from "@sinclair/typebox";
import { jsonResult, readStringParam, stringEnum } from "infinibot/plugin-sdk";
import type { AnyAgentTool } from "../../../src/agents/tools/common.js";

import { PartScanJobRunner } from "./job-runner.js";
import { PartScanStore } from "./store.js";
import type { PartScanConfig } from "./types.js";

const ACTIONS = ["list", "get", "start", "status", "open_viewer"] as const;

export function createPartScanTool(
  store: PartScanStore,
  runner: PartScanJobRunner,
  config: PartScanConfig,
): AnyAgentTool {
  return {
    label: "Part Scan",
    name: "part_scan",
    description:
      "Manage camera photogrammetry scans. Actions: list scans; get scan metadata and dimensions; " +
      "start reconstruction after images are captured; check status; or open_viewer to return the native viewer route.",
    parameters: Type.Object({
      action: stringEnum(ACTIONS),
      id: Type.Optional(Type.String({ description: "Scan id (required except for list)." })),
    }),
    execute: async (_callId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      if (action === "list") return jsonResult({ scans: store.list() });
      const id = readStringParam(params, "id", { required: true });
      if (action === "get") return jsonResult({ scan: store.get(id), images: store.images(id) });
      if (action === "status") return jsonResult({ id, job: store.readJob(id) });
      if (action === "start") return jsonResult({ id, job: runner.start(id, config) });
      if (action === "open_viewer") {
        const scan = store.get(id);
        if (!scan.modelReady) throw new Error("part_scan: model is not ready");
        return jsonResult({ id, route: `/part-scan?scan=${encodeURIComponent(id)}&viewer=1` });
      }
      throw new Error(`part_scan: unknown action '${action}'`);
    },
  };
}
