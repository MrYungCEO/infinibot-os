import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import { handleSystemNotify } from "./runner.js";
import {
  __resetNotifyDedupe,
  type NotifyDeps,
} from "../desktop/backends/hyprland/overlay-notify.js";

class FakeChild extends EventEmitter {
  pid = 99;
  stderr = new EventEmitter();
  unref = vi.fn();
}

function deps(overrides: Partial<NotifyDeps> = {}): Partial<NotifyDeps> {
  const spawn = vi.fn((bin: string) => {
    const child = new FakeChild();
    queueMicrotask(() => {
      if (bin === "python3") child.stderr.emit("data", Buffer.from("notify-overlay ready\n"));
      else child.emit("spawn");
    });
    return child as unknown as ReturnType<NotifyDeps["spawn"]>;
  });
  return {
    spawn: spawn as unknown as NotifyDeps["spawn"],
    isHyprland: () => true,
    whichBin: (b) => (b === "notify-send" ? "/usr/bin/notify-send" : null),
    now: () => 1,
    scriptPath: () => __filename,
    ...overrides,
  };
}

afterEach(() => {
  __resetNotifyDedupe();
  vi.restoreAllMocks();
});

describe("handleSystemNotify (node-host command)", () => {
  it("renders an overlay for delivery=overlay on Hyprland", async () => {
    const res = await handleSystemNotify(
      { title: "Deploy", body: "ok", delivery: "overlay" },
      deps(),
    );
    expect(res).toMatchObject({ ok: true, delivery: "overlay", pid: 99 });
  });

  it("defaults delivery to auto (overlay on this node)", async () => {
    const res = await handleSystemNotify({ title: "hi" }, deps());
    expect(res.delivery).toBe("overlay");
  });

  it("normalizes an unknown priority/anchor instead of throwing", async () => {
    const res = await handleSystemNotify(
      { title: "hi", priority: "bogus", anchor: "nope", delivery: "overlay" },
      deps(),
    );
    expect(res.ok).toBe(true);
  });

  it("propagates the libnotify path for delivery=system", async () => {
    const res = await handleSystemNotify({ body: "toast", delivery: "system" }, deps());
    expect(res.delivery).toBe("system");
  });
});
