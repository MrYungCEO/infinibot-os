import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import { __resetNotifyDedupe, deliverNotification, type NotifyDeps } from "./overlay-notify.js";

/** A fake ChildProcess that lets the test drive lifecycle events. */
class FakeChild extends EventEmitter {
  pid = 4242;
  stderr = new EventEmitter();
  unref = vi.fn();
  emitReady() {
    this.stderr.emit("data", Buffer.from("notify-overlay ready\n"));
  }
  emitInstallExit() {
    this.emit("exit", 2);
  }
  emitSpawn() {
    this.emit("spawn");
  }
}

function makeDeps(overrides: Partial<NotifyDeps> = {}): {
  deps: Partial<NotifyDeps>;
  spawn: ReturnType<typeof vi.fn>;
  children: FakeChild[];
} {
  const children: FakeChild[] = [];
  const spawn = vi.fn((bin: string) => {
    const child = new FakeChild();
    children.push(child);
    // Drive the relevant lifecycle on the next tick so the awaiting promise
    // gets a chance to attach its listeners first.
    queueMicrotask(() => {
      if (bin === "python3") child.emitReady();
      else child.emitSpawn(); // notify-send resolves on "spawn"
    });
    return child as unknown as ReturnType<NotifyDeps["spawn"]>;
  });
  const deps: Partial<NotifyDeps> = {
    spawn: spawn as unknown as NotifyDeps["spawn"],
    isHyprland: () => true,
    whichBin: (b) => (b === "notify-send" ? "/usr/bin/notify-send" : null),
    now: () => 1_000_000,
    scriptPath: () => __filename, // any existing file passes the fs.existsSync gate
    ...overrides,
  };
  return { deps, spawn, children };
}

afterEach(() => {
  __resetNotifyDedupe();
  vi.restoreAllMocks();
});

describe("deliverNotification dispatch", () => {
  it("rejects empty notifications", async () => {
    const { deps } = makeDeps();
    const res = await deliverNotification({ title: "  ", body: "" }, deps);
    expect(res).toMatchObject({ ok: false, delivery: "none", code: "INVALID_REQUEST" });
  });

  it("delivery=overlay spawns the layer-shell panel via python3", async () => {
    const { deps, spawn } = makeDeps();
    const res = await deliverNotification(
      { title: "Build done", body: "248 tests passed", delivery: "overlay" },
      deps,
    );
    expect(res).toMatchObject({ ok: true, delivery: "overlay", pid: 4242 });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][0]).toBe("python3");
    // Config is passed through the env var, not argv.
    const env = (spawn.mock.calls[0][2] as { env: Record<string, string> }).env;
    expect(JSON.parse(env.INFINIBOT_NOTIFY_JSON)).toMatchObject({
      title: "Build done",
      body: "248 tests passed",
      anchor: "top-right",
    });
  });

  it("delivery=system uses notify-send (libnotify)", async () => {
    const { deps, spawn } = makeDeps();
    const res = await deliverNotification({ title: "hi", delivery: "system" }, deps);
    expect(res).toMatchObject({ ok: true, delivery: "system" });
    expect(spawn.mock.calls[0][0]).toBe("/usr/bin/notify-send");
  });

  it("delivery=auto prefers overlay on a Hyprland device", async () => {
    const { deps, spawn } = makeDeps({ isHyprland: () => true });
    const res = await deliverNotification({ title: "hi", delivery: "auto" }, deps);
    expect(res.delivery).toBe("overlay");
    expect(spawn.mock.calls[0][0]).toBe("python3");
  });

  it("delivery=auto falls back to system off Hyprland", async () => {
    const { deps, spawn } = makeDeps({ isHyprland: () => false });
    const res = await deliverNotification({ title: "hi", delivery: "auto" }, deps);
    expect(res.delivery).toBe("system");
    expect(spawn.mock.calls[0][0]).toBe("/usr/bin/notify-send");
  });

  it("falls back to libnotify with an install hint when gtk-layer-shell is missing", async () => {
    const children: FakeChild[] = [];
    const spawn = vi.fn((bin: string) => {
      const child = new FakeChild();
      children.push(child);
      queueMicrotask(() => {
        if (bin === "python3")
          child.emitInstallExit(); // exit code 2
        else child.emitSpawn();
      });
      return child as unknown as ReturnType<NotifyDeps["spawn"]>;
    });
    const deps: Partial<NotifyDeps> = {
      spawn: spawn as unknown as NotifyDeps["spawn"],
      isHyprland: () => true,
      whichBin: (b) => (b === "notify-send" ? "/usr/bin/notify-send" : null),
      now: () => 1,
      scriptPath: () => __filename,
    };
    const res = await deliverNotification({ title: "hi", delivery: "overlay" }, deps);
    expect(res).toMatchObject({ ok: true, delivery: "system" });
    expect(res.hint).toContain("gtk-layer-shell");
    expect(spawn).toHaveBeenCalledTimes(2); // python3 (failed) then notify-send
  });

  it("returns a structured error when neither overlay nor libnotify is available", async () => {
    const spawn = vi.fn((bin: string) => {
      const child = new FakeChild();
      queueMicrotask(() => {
        if (bin === "python3") child.emitInstallExit();
      });
      return child as unknown as ReturnType<NotifyDeps["spawn"]>;
    });
    const deps: Partial<NotifyDeps> = {
      spawn: spawn as unknown as NotifyDeps["spawn"],
      isHyprland: () => true,
      whichBin: () => null, // no notify-send either
      now: () => 1,
      scriptPath: () => __filename,
    };
    const res = await deliverNotification({ title: "hi", delivery: "overlay" }, deps);
    expect(res.ok).toBe(false);
    expect(res.delivery).toBe("none");
    expect(res.hint).toContain("libnotify");
  });

  it("suppresses duplicates with the same idempotencyKey within 60s", async () => {
    let clock = 1_000_000;
    const { deps, spawn } = makeDeps({ now: () => clock });
    const first = await deliverNotification(
      { title: "dup", delivery: "overlay", idempotencyKey: "k1" },
      deps,
    );
    expect(first).toMatchObject({ ok: true, delivery: "overlay" });

    clock += 30_000; // within the 60s window
    const second = await deliverNotification(
      { title: "dup", delivery: "overlay", idempotencyKey: "k1" },
      deps,
    );
    expect(second).toMatchObject({ ok: true, delivery: "none", deduped: true });
    expect(spawn).toHaveBeenCalledTimes(1); // second never spawned

    clock += 31_000; // now >60s since first
    const third = await deliverNotification(
      { title: "dup", delivery: "overlay", idempotencyKey: "k1" },
      deps,
    );
    expect(third).toMatchObject({ ok: true, delivery: "overlay" });
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("maps priority to default auto-dismiss timing", async () => {
    const { deps, spawn } = makeDeps();
    await deliverNotification({ title: "x", delivery: "overlay", priority: "timeSensitive" }, deps);
    const env = (spawn.mock.calls[0][2] as { env: Record<string, string> }).env;
    expect(JSON.parse(env.INFINIBOT_NOTIFY_JSON).timeout_ms).toBe(20_000);
  });
});
