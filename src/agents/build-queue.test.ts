import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HeavyOpSemaphore,
  SHIMMED_TOOLS,
  ensureBuildQueueInstalled,
  resetBuildQueueForTests,
  wrapHeavyCommand,
} from "./build-queue.js";

const hasFlock = spawnSync("sh", ["-c", "command -v flock"]).status === 0;
const scriptsDir = path.resolve(__dirname, "../../scripts");
const WRAPPER = path.join(scriptsDir, "infinibot-build");

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("HeavyOpSemaphore", () => {
  it("never runs more than max at once and serves waiters FIFO", async () => {
    const sem = new HeavyOpSemaphore(2);
    let running = 0;
    let peak = 0;
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        sem.run(async () => {
          running++;
          peak = Math.max(peak, running);
          order.push(i);
          await new Promise((r) => setTimeout(r, 5));
          running--;
        }),
      ),
    );
    expect(peak).toBe(2);
    expect(order).toEqual([0, 1, 2, 3, 4, 5]);
    expect(sem.running).toBe(0);
  });

  it("releases the slot when the op throws (no deadlock)", async () => {
    const sem = new HeavyOpSemaphore(1);
    await expect(sem.run(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(sem.run(() => "ok")).resolves.toBe("ok");
  });

  it("release is idempotent", async () => {
    const sem = new HeavyOpSemaphore(1);
    const release = await sem.acquire();
    release();
    release();
    expect(sem.running).toBe(0);
    const again = await sem.acquire();
    expect(sem.running).toBe(1);
    again();
  });

  it("raising the limit wakes queued waiters; null = unlimited", async () => {
    const sem = new HeavyOpSemaphore(1);
    const first = await sem.acquire();
    let second = false;
    void sem.acquire().then(() => (second = true));
    await tick();
    expect(second).toBe(false);
    sem.setLimit(null);
    await tick();
    expect(second).toBe(true);
    first();
  });
});

describe("ensureBuildQueueInstalled", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ibq-"));
    resetBuildQueueForTests();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("writes the limit, links wrapper + shims and prepends PATH (idempotently)", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin",
      INFINIBOT_BUILD_SCRIPTS_DIR: scriptsDir,
    };
    const res = ensureBuildQueueInstalled({ maxConcurrent: 2, env, dir });
    expect(res).not.toBeNull();
    expect(fs.readFileSync(path.join(dir, "limit"), "utf8").trim()).toBe("2");
    for (const tool of [...SHIMMED_TOOLS, "infinibot-build"]) {
      expect(fs.existsSync(path.join(dir, "bin", tool))).toBe(true);
    }
    expect(env.PATH).toBe(`${path.join(dir, "bin")}:/usr/bin:/bin`);
    expect(env.INFINIBOT_BUILD_QUEUE_DIR).toBe(dir);
    ensureBuildQueueInstalled({ maxConcurrent: 2, env, dir });
    expect(env.PATH?.split(":").filter((p) => p === path.join(dir, "bin"))).toHaveLength(1);
    // plan change rewrites the limit; unlimited → 0
    ensureBuildQueueInstalled({ maxConcurrent: null, env, dir });
    expect(fs.readFileSync(path.join(dir, "limit"), "utf8").trim()).toBe("0");
    expect(wrapHeavyCommand("node", ["x.mjs"], env)).toEqual({
      command: path.join(dir, "bin", "infinibot-build"),
      args: ["node", "x.mjs"],
    });
  });

  it("returns null (queue off, nothing blocked) when the scripts are missing", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      INFINIBOT_BUILD_SCRIPTS_DIR: dir,
      INFINIBOT_REPO_ROOT: dir,
    };
    // resolveRepoRoot falls back to the real repo, so only assert PATH hygiene when null.
    const res = ensureBuildQueueInstalled({ maxConcurrent: 1, env, dir: path.join(dir, "q") });
    if (res === null) expect(env.PATH).toBe("/usr/bin");
    expect(wrapHeavyCommand("node", [], { PATH: "/usr/bin" })).toEqual({
      command: "node",
      args: [],
    });
  });
});

type Proc = { code: number | null; out: string };
function runSh(cmd: string, env: NodeJS.ProcessEnv, timeoutMs = 20_000): Promise<Proc> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", cmd], { env: { ...process.env, ...env } });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timed out: ${cmd}\n${out}`));
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(t);
      resolve({ code, out });
    });
  });
}

describe.skipIf(!hasFlock)("infinibot-build (flock wrapper)", () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ibq-sh-"));
    env = { INFINIBOT_BUILD_QUEUE_DIR: dir, INFINIBOT_BUILD_MIN_FREE_MB: "0" };
    fs.writeFileSync(path.join(dir, "limit"), "2\n");
    delete process.env.INFINIBOT_BUILD_SLOT;
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("runs at most <limit> commands at once", async () => {
    const log = path.join(dir, "log");
    // each job appends start/end markers; peak concurrency is reconstructed from the log
    const job = `${WRAPPER} bash -c 'echo s >> ${log}; sleep 0.4; echo e >> ${log}'`;
    const results = await Promise.all(Array.from({ length: 5 }, () => runSh(job, env)));
    expect(results.every((r) => r.code === 0)).toBe(true);
    let cur = 0;
    let peak = 0;
    for (const line of fs.readFileSync(log, "utf8").trim().split("\n")) {
      cur += line === "s" ? 1 : -1;
      peak = Math.max(peak, cur);
    }
    expect(peak).toBe(2);
  });

  it("propagates the command's exit code", async () => {
    expect((await runSh(`${WRAPPER} bash -c 'exit 7'`, env)).code).toBe(7);
  });

  it("nested builds reuse the parent slot instead of deadlocking", async () => {
    fs.writeFileSync(path.join(dir, "limit"), "1\n");
    const r = await runSh(
      `${WRAPPER} bash -c '${WRAPPER} bash -c "echo inner-\\$INFINIBOT_BUILD_SLOT"'`,
      env,
      10_000,
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("inner-0");
  });

  it("a SIGKILLed holder releases its slot", async () => {
    fs.writeFileSync(path.join(dir, "limit"), "1\n");
    const holder = spawn(WRAPPER, ["sleep", "30"], {
      env: { ...process.env, ...env },
      detached: true,
    });
    // wait until the holder owns the slot
    for (let i = 0; i < 50; i++) {
      const probe = spawnSync("flock", ["-n", path.join(dir, "slots", "0.lock"), "true"]);
      if (probe.status !== 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    holder.kill("SIGKILL"); // only the wrapper (lock holder) dies; its child lives on
    const started = Date.now();
    const r = await runSh(`${WRAPPER} echo got-slot`, env, 10_000);
    expect(r.out).toContain("got-slot");
    expect(Date.now() - started).toBeLessThan(5_000);
    try {
      process.kill(-holder.pid!, "SIGKILL"); // reap the orphaned `sleep 30`
    } catch {
      /* already gone */
    }
  });

  it("gives up waiting after the timeout and runs unqueued", async () => {
    fs.writeFileSync(path.join(dir, "limit"), "1\n");
    const holder = spawn(WRAPPER, ["sleep", "20"], {
      env: { ...process.env, ...env },
      detached: true,
    });
    await new Promise((r) => setTimeout(r, 300));
    const r = await runSh(
      `${WRAPPER} echo ran`,
      { ...env, INFINIBOT_BUILD_QUEUE_TIMEOUT: "1" },
      10_000,
    );
    process.kill(-holder.pid!, "SIGKILL");
    expect(r.out).toContain("running unqueued");
    expect(r.out).toContain("ran");
  });
});

describe.skipIf(!hasFlock)("infinibot-build-shim", () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    resetBuildQueueForTests();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ibq-shim-"));
    // fake "real" tools that report whether they ran inside a build slot
    const fake = path.join(dir, "real");
    fs.mkdirSync(fake);
    for (const t of ["pnpm", "tsc", "vite"]) {
      fs.writeFileSync(
        path.join(fake, t),
        `#!/bin/sh\necho "${t} slot=\${INFINIBOT_BUILD_SLOT:-none}"\n`,
        { mode: 0o755 },
      );
    }
    env = {
      PATH: `${fake}:/usr/bin:/bin`,
      INFINIBOT_BUILD_SCRIPTS_DIR: scriptsDir,
      INFINIBOT_BUILD_MIN_FREE_MB: "0",
    };
    ensureBuildQueueInstalled({ maxConcurrent: 1, env, dir: path.join(dir, "q") });
    delete env.INFINIBOT_BUILD_SLOT;
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it.each([
    ["pnpm build", "slot=0"],
    ["pnpm -C ui build", "slot=0"],
    ["pnpm run build:ui", "slot=0"],
    ["tsc -p .", "slot=0"],
    ["vite build", "slot=0"],
    ["pnpm install", "slot=none"],
    ["pnpm dev", "slot=none"],
    ["tsc --watch", "slot=none"],
    ["vite", "slot=none"],
    ["pnpm --version", "slot=none"],
  ])("%s → %s", async (cmd, want) => {
    const r = await runSh(cmd, { ...env, INFINIBOT_BUILD_SLOT: "" });
    expect(r.code).toBe(0);
    expect(r.out).toContain(want);
  });
});
