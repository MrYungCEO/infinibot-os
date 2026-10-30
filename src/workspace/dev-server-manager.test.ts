import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkspaceDevServerManager } from "./dev-server-manager.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function setup() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ib-workspace-state-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "ib-workspace-app-"));
  roots.push(stateDir, project);
  fs.writeFileSync(path.join(project, "index.html"), "<h1>fixture</h1>");
  const live = new Set<string>();
  let ready = false;
  let now = 1_000;
  const manager = new WorkspaceDevServerManager({
    stateDir,
    idleTimeoutMs: 1_000,
    deps: {
      runTmux: vi.fn(async (args) => {
        live.add(args[args.indexOf("-s") + 1]!);
        return { stdout: "", stderr: "" };
      }),
      hasSession: vi.fn(async (id) => live.has(id)),
      killSession: vi.fn(async (id) => {
        live.delete(id);
      }),
      probePort: vi.fn(async () => ready),
      findPort: vi.fn(async () => 47891),
      now: () => now,
      schedule: vi.fn(() => 1),
      clearSchedule: vi.fn(),
    },
  });
  return {
    manager,
    project,
    live,
    setReady: (value: boolean) => {
      ready = value;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("WorkspaceDevServerManager", () => {
  it("starts, becomes ready, stops, and restarts a durable fake tmux process", async () => {
    const h = setup();
    const started = await h.manager.start({ directoryId: "project-1", projectPath: h.project });
    expect(started.record.status).toBe("starting");
    expect(started.record.port).toBe(47891);
    expect(h.live.has("workspace_project_1")).toBe(true);
    h.setReady(true);
    await h.manager.reconcile();
    expect(h.manager.get("project-1")?.status).toBe("ready");
    await h.manager.stop("project-1");
    expect(h.manager.get("project-1")?.status).toBe("stopped");
    h.setReady(false);
    const restarted = await h.manager.restart({ directoryId: "project-1", projectPath: h.project });
    expect(restarted.record.status).toBe("starting");
  });

  it("marks a crashed process with the last log excerpt", async () => {
    const h = setup();
    const { record } = await h.manager.start({ directoryId: "crash", projectPath: h.project });
    fs.appendFileSync(record.logPath, "fatal: Cannot find module 'vite'\n");
    h.live.clear();
    await h.manager.reconcile();
    expect(h.manager.get("crash")?.status).toBe("error");
    expect(h.manager.get("crash")?.error).toContain("Cannot find module");
  });

  it("idle-stops a ready server", async () => {
    const h = setup();
    await h.manager.start({ directoryId: "idle", projectPath: h.project });
    h.setReady(true);
    await h.manager.reconcile();
    h.advance(1_001);
    await h.manager.reconcile();
    expect(h.manager.get("idle")?.status).toBe("stopped");
    expect(h.manager.get("idle")?.error).toContain("idle timeout");
  });
});

function expoProject(): string {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "ib-workspace-expo-"));
  roots.push(project);
  fs.writeFileSync(
    path.join(project, "package.json"),
    JSON.stringify({ name: "expo-app", scripts: { start: "expo start" }, dependencies: { expo: "*" } }),
  );
  fs.mkdirSync(path.join(project, "node_modules"));
  return project;
}

function fakeHarness(opts: { findPort?: (preferred: number, exclude: ReadonlySet<number>) => Promise<number>; maxPortAttempts?: number; preferredPort?: number } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ib-workspace-state-"));
  roots.push(stateDir);
  const live = new Set<string>();
  const scripts: string[] = [];
  const manager = new WorkspaceDevServerManager({
    stateDir,
    maxPortAttempts: opts.maxPortAttempts,
    preferredPort: opts.preferredPort ? () => opts.preferredPort! : undefined,
    deps: {
      runTmux: vi.fn(async (args: string[]) => {
        live.add(args[args.indexOf("-s") + 1]!);
        scripts.push(args[args.length - 1]!);
        return { stdout: "", stderr: "" };
      }),
      hasSession: vi.fn(async (id: string) => live.has(id)),
      killSession: vi.fn(async (id: string) => {
        live.delete(id);
      }),
      probePort: vi.fn(async () => false),
      ...(opts.findPort ? { findPort: opts.findPort } : {}),
      now: () => 1_000,
      schedule: vi.fn(() => 1),
      clearSchedule: vi.fn(),
    },
  });
  return { manager, live, scripts };
}

/** Deterministic fake: first port >= preferred that is not excluded. */
const walkingFindPort = async (preferred: number, exclude: ReadonlySet<number>) => {
  let port = preferred;
  while (exclude.has(port)) port++;
  return port;
};

describe("WorkspaceDevServerManager ports", () => {
  it("never assumes the framework default is free: skips a bound port", async () => {
    // Occupy a port the way `tailscale serve` holds 8081: on a specific
    // address, so a loopback-only probe would wrongly call it free.
    const holder = net.createServer();
    const specific = await new Promise<boolean>((resolve) => {
      holder.once("error", () => resolve(false));
      holder.listen(0, "127.0.0.2", () => resolve(true));
    });
    if (!specific) await new Promise<void>((resolve) => holder.listen(0, "0.0.0.0", () => resolve()));
    const occupied = (holder.address() as net.AddressInfo).port;
    try {
      const h = fakeHarness({ preferredPort: occupied });
      const { record, detection } = await h.manager.start({
        directoryId: "expo",
        projectPath: expoProject(),
      });
      expect(detection.kind).toBe("expo-web");
      expect(record.port).not.toBe(occupied);
      expect(record.port).toBeGreaterThan(occupied);
      expect(record.command).toContain(`--port ${record.port}`);
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
  });

  it("builds the Expo web command with --port and CI=1, never --non-interactive", async () => {
    const h = fakeHarness({ findPort: walkingFindPort, preferredPort: 48081 });
    const { record } = await h.manager.start({ directoryId: "expo", projectPath: expoProject() });
    expect(record.command).toBe("npm run start -- --web --port 48081");
    expect(record.command).not.toContain("--non-interactive");
    expect(h.scripts[0]).toContain("CI='1'");
    expect(h.scripts[0]).not.toContain("--non-interactive");
  });

  it("skips ports already allocated to other workspace runtimes", async () => {
    const h = fakeHarness({ findPort: walkingFindPort, preferredPort: 48100 });
    const a = await h.manager.start({ directoryId: "a", projectPath: expoProject() });
    const b = await h.manager.start({ directoryId: "b", projectPath: expoProject() });
    expect(a.record.port).toBe(48100);
    expect(b.record.port).toBe(48101);
  });

  it("relaunches on a new port when the dev server reports a port conflict", async () => {
    const h = fakeHarness({ findPort: walkingFindPort, preferredPort: 48200 });
    const { record } = await h.manager.start({ directoryId: "expo", projectPath: expoProject() });
    expect(record.port).toBe(48200);
    fs.appendFileSync(record.logPath, "Port 48200 is being used by another process\n");
    h.live.clear(); // Expo exits after reporting the conflict
    await h.manager.reconcile();
    const next = h.manager.get("expo")!;
    expect(next.status).toBe("starting");
    expect(next.port).toBe(48201);
    expect(next.portAttempts).toEqual([48200, 48201]);
    expect(next.command).toContain("--port 48201");
    expect(h.scripts).toHaveLength(2);
    const log = fs.readFileSync(next.logPath, "utf8");
    expect(log).toContain("port 48200 is in use");
    expect(log).toContain("attempt 2/4");
    // The old conflict line must not re-trigger a retry for the new attempt.
    await h.manager.reconcile();
    expect(h.manager.get("expo")!.port).toBe(48201);
  });

  it("gives up after the bounded number of port attempts", async () => {
    const h = fakeHarness({ findPort: walkingFindPort, preferredPort: 48300, maxPortAttempts: 3 });
    await h.manager.start({ directoryId: "expo", projectPath: expoProject() });
    for (let i = 0; i < 3; i++) {
      const current = h.manager.get("expo")!;
      fs.appendFileSync(current.logPath, `Error: listen EADDRINUSE: address already in use :::${current.port}\n`);
      await h.manager.reconcile();
    }
    const final = h.manager.get("expo")!;
    expect(final.status).toBe("error");
    expect(final.error).toContain("tried 48300, 48301, 48302");
    expect(h.scripts).toHaveLength(3);
  });
});
