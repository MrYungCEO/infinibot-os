import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Exercises scripts/infinibot-watchdog (the bash supervisor installed at
 * ~/.local/bin/infinibot-watchdog) against a dummy gateway that reproduces the
 * real process chain:
 *
 *   run-node.mjs wrapper (does NOT forward signals)
 *     -> entry (forwards signals to its child)
 *       -> listener (holds the port, exits ~300ms after SIGTERM)
 *
 * Regression: SIGHUP used to TERM only the wrapper, orphaning the listener,
 * which the loop then "adopted" — a second SIGHUP was needed, the exit was
 * logged as a crash, and every log line was written twice.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const scriptPath = path.join(repoRoot, "scripts", "infinibot-watchdog");

const hasTools = (() => {
  if (process.platform !== "linux") return false;
  try {
    execFileSync("sh", ["-c", "command -v lsof && command -v setsid"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const DUMMY_RUN_NODE = `
import { spawn } from "node:child_process";
import net from "node:net";
const role = process.argv[2];
const self = new URL(import.meta.url).pathname;
if (role === "gateway") {
  // Like the old scripts/run-node.mjs: no signal forwarding.
  const c = spawn(process.execPath, [self, "entry"], { stdio: "inherit" });
  c.on("exit", (code) => process.exit(code ?? 1));
} else if (role === "entry") {
  const c = spawn(process.execPath, [self, "listener"], { stdio: "inherit" });
  for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(s, () => c.kill(s));
  c.on("exit", (code) => process.exit(code ?? 1));
} else {
  const srv = net.createServer().listen(Number(process.env.INFINIBOT_GATEWAY_PORT), "127.0.0.1");
  process.on("SIGTERM", () => setTimeout(() => { srv.close(); process.exit(0); }, 300));
  setInterval(() => {}, 1000);
}
`;

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

function listenerPid(port: number): number | null {
  try {
    const out = execFileSync("lsof", ["-nP", "-ti", `TCP:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
    }).trim();
    const pid = Number(out.split("\n")[0]);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor<T>(fn: () => T | null | false, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("timed out");
}

describe.skipIf(!hasTools)("scripts/infinibot-watchdog", () => {
  let dir = "";
  let wd: ChildProcess | null = null;

  afterEach(async () => {
    if (wd && wd.exitCode === null) {
      wd.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 1500));
      if (wd.exitCode === null) wd.kill("SIGKILL");
    }
    wd = null;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("restarts the real listener exactly once per SIGHUP, without crash entries or duplicate log lines", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ib-watchdog-"));
    const gwDir = path.join(dir, "gw");
    const home = path.join(dir, "home");
    fs.mkdirSync(path.join(gwDir, "scripts"), { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(gwDir, "scripts", "run-node.mjs"), DUMMY_RUN_NODE);
    const port = await freePort();
    const logFile = path.join(home, "watchdog.log");
    // Mimic systemd's StandardOutput=append:<watchdog.log>.
    const out = fs.openSync(logFile, "a");
    wd = spawn("bash", [scriptPath], {
      env: {
        ...process.env,
        INFINIBOT_GATEWAY_DIR: gwDir,
        INFINIBOT_GATEWAY_PORT: String(port),
        INFINIBOT_WATCHDOG_HOME: home,
        INFINIBOT_WATCHDOG_RESTART_DELAY: "1",
        INFINIBOT_WATCHDOG_AI_RECOVERY: "0",
      },
      stdio: ["ignore", out, out],
      detached: true,
    });
    fs.closeSync(out);

    const first = await waitFor(() => listenerPid(port), 15_000);
    // Listener runs in its own process group, not the watchdog's.
    const pgid = execFileSync("ps", ["-o", "pgid=", "-p", String(first)], {
      encoding: "utf8",
    }).trim();
    expect(Number(pgid)).not.toBe(wd.pid);

    wd.kill("SIGHUP");
    const second = await waitFor(() => {
      const p = listenerPid(port);
      return p && p !== first ? p : null;
    }, 20_000);
    expect(alive(first)).toBe(false);

    // Stays on the new listener: no extra restart, no adoption dance.
    await new Promise((r) => setTimeout(r, 3000));
    expect(listenerPid(port)).toBe(second);

    const log = fs.readFileSync(logFile, "utf8");
    const lines = log.trim().split("\n");
    expect(new Set(lines).size).toBe(lines.length); // nothing printed twice
    expect(lines.filter((l) => l.includes("SIGHUP received"))).toHaveLength(1);
    expect(lines.filter((l) => l.includes("Gateway started"))).toHaveLength(2);
    expect(log).not.toMatch(/crash\(es\)/);
    expect(log).not.toMatch(/Adopting existing gateway/);

    // SIGTERM stops the whole gateway group.
    wd.kill("SIGTERM");
    await waitFor(() => wd?.exitCode !== null || wd?.signalCode !== null, 20_000);
    await waitFor(() => listenerPid(port) === null && !alive(second), 10_000);
  }, 90_000);

  it("respawns after a real crash and counts it once", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ib-watchdog-"));
    const gwDir = path.join(dir, "gw");
    const home = path.join(dir, "home");
    fs.mkdirSync(path.join(gwDir, "scripts"), { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(gwDir, "scripts", "run-node.mjs"), DUMMY_RUN_NODE);
    const port = await freePort();
    const logFile = path.join(home, "watchdog.log");
    wd = spawn("bash", [scriptPath], {
      env: {
        ...process.env,
        INFINIBOT_GATEWAY_DIR: gwDir,
        INFINIBOT_GATEWAY_PORT: String(port),
        INFINIBOT_WATCHDOG_HOME: home,
        INFINIBOT_WATCHDOG_RESTART_DELAY: "1",
        INFINIBOT_WATCHDOG_AI_RECOVERY: "0",
      },
      stdio: "ignore",
      detached: true,
    });
    const first = await waitFor(() => listenerPid(port), 15_000);
    process.kill(first, "SIGKILL");
    const second = await waitFor(() => {
      const p = listenerPid(port);
      return p && p !== first ? p : null;
    }, 20_000);
    expect(second).toBeGreaterThan(0);
    const log = fs.readFileSync(logFile, "utf8");
    expect(log.match(/crash\(es\) in last/g)).toHaveLength(1);
    expect(log.match(/Gateway started/g)).toHaveLength(2);
  }, 60_000);
});
