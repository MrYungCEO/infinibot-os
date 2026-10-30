/**
 * installCommandAccelerator(): a faster transport (the Droid Swarm plugin's
 * live scrcpy control socket) may take validated device commands, but the
 * allowlist/argument checks still run first, the audit row is still written,
 * and anything it declines (or throws on) falls through to the adapter.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DeviceCommand, DeviceCommandResult } from "./adapters/types.js";
import { NullStreamAdapter } from "./adapters/null-device.js";
import { LocalStorageAdapter } from "./adapters/storage.js";
import { AndroidOpsService } from "./service.js";
import { AndroidOpsStore } from "./store.js";

describe("AndroidOpsService.installCommandAccelerator", () => {
  let dir: string;
  let store: AndroidOpsStore;
  let service: AndroidOpsService;
  let adapterCalls: DeviceCommand[];
  let deviceId: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "android-ops-accel-"));
    store = new AndroidOpsStore(dir);
    adapterCalls = [];
    const device = {
      id: "stub",
      async runCommand(_serial: string, cmd: DeviceCommand): Promise<DeviceCommandResult> {
        adapterCalls.push(cmd);
        return {
          ok: true,
          command: cmd.command,
          stdout: "",
          stderr: "",
          durationMs: 200,
          reason: null,
        };
      },
      async connect() {
        return {
          ok: true,
          command: "connect",
          stdout: "",
          stderr: "",
          durationMs: 0,
          reason: null,
        };
      },
    };
    service = new AndroidOpsService(store, {
      device: device as never,
      stream: new NullStreamAdapter(),
      storage: new LocalStorageAdapter(join(dir, "media")),
    });
    deviceId = service.registerDevice(
      { label: "Phone 01", serial: "fake-01", model: "Pixel 8" },
      "operator:test",
    ).id;
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("routes accepted commands through the accelerator and still audits", async () => {
    const seen: { serial: string; cmd: DeviceCommand }[] = [];
    service.installCommandAccelerator(async (serial, cmd) => {
      seen.push({ serial, cmd });
      return {
        ok: true,
        command: cmd.command,
        stdout: "",
        stderr: "",
        durationMs: 3,
        reason: null,
      };
    });
    const out = await service.agentControlDevice(
      { deviceId, action: "tap", x: 10, y: 20 },
      "agent:test",
    );
    expect(out.ok).toBe(true);
    expect(seen).toEqual([
      { serial: "fake-01", cmd: { command: "ui.tap", args: { x: 10, y: 20 }, timeoutMs: 10_000 } },
    ]);
    expect(adapterCalls).toEqual([]);
    const audit = store.listAudit({ targetType: "device", targetId: deviceId, limit: 20 });
    expect(JSON.stringify(audit)).toContain("device.agent_control.tap");
  });

  it("falls through to the adapter when declined or failing, and validation still applies", async () => {
    let calls = 0;
    service.installCommandAccelerator(async (_serial, cmd) => {
      calls += 1;
      if (cmd.command === "ui.swipe") throw new Error("socket gone");
      return null;
    });
    await service.agentControlDevice(
      { deviceId, action: "keyevent", keyevent: "KEYCODE_HOME" },
      "agent:test",
    );
    await service.agentControlDevice(
      { deviceId, action: "swipe", x1: 1, y1: 2, x2: 3, y2: 4, durationMs: 200 },
      "agent:test",
    );
    expect(calls).toBe(2);
    expect(adapterCalls.map((c) => c.command)).toEqual(["ui.keyevent", "ui.swipe"]);
    await expect(
      service.agentControlDevice(
        { deviceId, action: "keyevent", keyevent: "rm -rf /" },
        "agent:test",
      ),
    ).rejects.toThrow(/keyevent/);
    expect(calls).toBe(2);
  });

  it("null restores the plain adapter", async () => {
    service.installCommandAccelerator(async () => ({
      ok: true,
      command: "x",
      stdout: "",
      stderr: "",
      durationMs: 1,
      reason: null,
    }));
    service.installCommandAccelerator(null);
    await service.agentControlDevice({ deviceId, action: "tap", x: 1, y: 1 }, "agent:test");
    expect(adapterCalls.map((c) => c.command)).toEqual(["ui.tap"]);
  });
});
