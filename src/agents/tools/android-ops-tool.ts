import { Type } from "@sinclair/typebox";

import { getAndroidOpsService, type DeviceAgentControlAction } from "../../android-ops/service.js";
import { stringEnum } from "../schema/typebox.js";
import { jsonResult, readNumberParam, readStringParam, type AnyAgentTool } from "./common.js";

const ANDROID_OPS_ACTIONS = [
  "status",
  "setup",
  "devices",
  "accounts",
  "media",
  "jobs",
  "audit",
  "refresh_fleet",
  "control",
] as const;

const DEVICE_CONTROL_ACTIONS = [
  "adb_connect",
  "adb_pair",
  "screenshot",
  "logs",
  "launch",
  "tap",
  "swipe",
  "text",
  "keyevent",
  "open_stream",
  "close_stream",
] as const;

function readOptionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  return typeof args[key] === "boolean" ? (args[key] as boolean) : undefined;
}

export function createAndroidOpsTool(): AnyAgentTool {
  return {
    label: "Android Ops",
    name: "android_ops",
    description: `Android Social Ops MCP controls for the connected-phone platform.
Use this for setup/status inspection, fleet refresh, list views, and audited handset control.
Handset control supports adb_connect, adb_pair, screenshot, logs, launch, tap, swipe, text, keyevent, open_stream, and close_stream.
It does not expose arbitrary adb shell/root, CAPTCHA bypass, security-checkpoint automation, or credential capture.
When the Droid Swarm plugin is enabled, its droid_swarm tool is the full surface (ui_dump, find_and_tap, wait_for, app install/stop, accounts, workflows, egress, email, approvals); prefer it.`,
    parameters: Type.Object({
      action: stringEnum(ANDROID_OPS_ACTIONS, { description: "Android Ops action to perform." }),
      actor: Type.Optional(Type.String({ description: "Audit actor. Defaults to agent:mcp." })),

      // control
      deviceId: Type.Optional(Type.String({ description: "Registered Android Ops device id." })),
      controlAction: Type.Optional(
        stringEnum(DEVICE_CONTROL_ACTIONS, { description: "Device control action." }),
      ),
      x: Type.Optional(Type.Number()),
      y: Type.Optional(Type.Number()),
      x1: Type.Optional(Type.Number()),
      y1: Type.Optional(Type.Number()),
      x2: Type.Optional(Type.Number()),
      y2: Type.Optional(Type.Number()),
      durationMs: Type.Optional(Type.Number()),
      text: Type.Optional(Type.String({ description: "Text to type. Not written to audit rows." })),
      keyevent: Type.Optional(Type.String({ description: "Android keyevent, e.g. KEYCODE_HOME." })),
      package: Type.Optional(Type.String({ description: "Android package id to launch." })),
      label: Type.Optional(Type.String({ description: "Screenshot/control label." })),
      sinceMs: Type.Optional(Type.Number({ description: "Log lookback window in milliseconds." })),
      sessionId: Type.Optional(Type.String({ description: "scrcpy/session id for close_stream." })),
      pairHostPort: Type.Optional(
        Type.String({ description: "Wireless debugging pairing host:port, e.g. 100.x.x.x:37123." }),
      ),
      pairingCode: Type.Optional(Type.String({ description: "Wireless debugging pairing code." })),

      // list/filter knobs
      limit: Type.Optional(Type.Number()),
      adopt: Type.Optional(
        Type.Boolean({ description: "refresh_fleet adopts newly seen adb devices." }),
      ),
    }),
    async execute(_toolCallId: string, args: Record<string, unknown>) {
      const action = readStringParam(args, "action", { required: true });
      const actor = readStringParam(args, "actor") ?? "agent:mcp";
      const service = await getAndroidOpsService();

      if (action === "status") {
        return jsonResult({
          dashboard: service.dashboard(),
          adapters: await service.adapterSnapshot(true),
          census: service.census(),
          ops: await service.opsStatus(),
        });
      }

      if (action === "setup") {
        return jsonResult(await service.setupStatus());
      }

      if (action === "devices") {
        const deviceId = readStringParam(args, "deviceId");
        return jsonResult({
          devices: service.store.listDevices(),
          loads: service.deviceLoads(),
          history: deviceId
            ? service.store.healthHistory(deviceId, readNumberParam(args, "limit") ?? 48)
            : null,
        });
      }

      if (action === "accounts") {
        return jsonResult({ accounts: service.listAccountsPublic() });
      }

      if (action === "media") {
        return jsonResult({
          media: service.store.listMedia(),
          jobs: service.store.listJobs({ limit: readNumberParam(args, "limit") ?? 300 }),
        });
      }

      if (action === "jobs") {
        return jsonResult({
          jobs: service.store.listJobs({ limit: readNumberParam(args, "limit") ?? 300 }),
        });
      }

      if (action === "audit") {
        return jsonResult({
          events: service.store.listAudit({ limit: readNumberParam(args, "limit") ?? 100 }),
        });
      }

      if (action === "refresh_fleet") {
        return jsonResult(
          await service.refreshFleet(actor, { adopt: readOptionalBoolean(args, "adopt") }),
        );
      }

      if (action === "control") {
        const deviceId = readStringParam(args, "deviceId", { required: true });
        const controlAction = readStringParam(args, "controlAction", {
          required: true,
          label: "controlAction",
        }) as DeviceAgentControlAction;
        if (!(DEVICE_CONTROL_ACTIONS as readonly string[]).includes(controlAction)) {
          throw new Error(`Unsupported controlAction: ${controlAction}`);
        }
        return jsonResult(
          await service.agentControlDevice(
            {
              deviceId,
              action: controlAction,
              x: readNumberParam(args, "x"),
              y: readNumberParam(args, "y"),
              x1: readNumberParam(args, "x1"),
              y1: readNumberParam(args, "y1"),
              x2: readNumberParam(args, "x2"),
              y2: readNumberParam(args, "y2"),
              durationMs: readNumberParam(args, "durationMs"),
              text: readStringParam(args, "text"),
              keyevent: readStringParam(args, "keyevent"),
              package: readStringParam(args, "package"),
              label: readStringParam(args, "label"),
              sinceMs: readNumberParam(args, "sinceMs"),
              sessionId: readStringParam(args, "sessionId"),
              pairHostPort: readStringParam(args, "pairHostPort"),
              pairingCode: readStringParam(args, "pairingCode"),
            },
            actor,
          ),
        );
      }

      throw new Error(`Unsupported android_ops action: ${action}`);
    },
  };
}
