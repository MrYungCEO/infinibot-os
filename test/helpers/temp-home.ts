import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type EnvValue = string | undefined | ((home: string) => string | undefined);
type EnvSnapshot = {
  home: string | undefined;
  userProfile: string | undefined;
  homeDrive: string | undefined;
  homePath: string | undefined;
  stateDir: string | undefined;
  moltbotStateDir: string | undefined;
  clawdbotStateDir: string | undefined;
};

function snapshotEnv(): EnvSnapshot {
  return {
    home: process.env.HOME,
    userProfile: process.env.USERPROFILE,
    homeDrive: process.env.HOMEDRIVE,
    homePath: process.env.HOMEPATH,
    stateDir: process.env.INFINIBOT_STATE_DIR,
    moltbotStateDir: process.env.MOLTBOT_STATE_DIR,
    clawdbotStateDir: process.env.CLAWDBOT_STATE_DIR,
  };
}

function restoreKey(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function restoreEnv(snapshot: EnvSnapshot) {
  restoreKey("HOME", snapshot.home);
  restoreKey("USERPROFILE", snapshot.userProfile);
  restoreKey("HOMEDRIVE", snapshot.homeDrive);
  restoreKey("HOMEPATH", snapshot.homePath);
  restoreKey("INFINIBOT_STATE_DIR", snapshot.stateDir);
  restoreKey("MOLTBOT_STATE_DIR", snapshot.moltbotStateDir);
  restoreKey("CLAWDBOT_STATE_DIR", snapshot.clawdbotStateDir);
}

function setTempHome(base: string) {
  process.env.HOME = base;
  process.env.USERPROFILE = base;
  process.env.INFINIBOT_STATE_DIR = path.join(base, ".infinibot");
  process.env.MOLTBOT_STATE_DIR = process.env.INFINIBOT_STATE_DIR;
  process.env.CLAWDBOT_STATE_DIR = process.env.INFINIBOT_STATE_DIR;
  if (process.platform !== "win32") return;
  const match = base.match(/^([A-Za-z]:)(.*)$/);
  if (!match) return;
  process.env.HOMEDRIVE = match[1];
  process.env.HOMEPATH = match[2] || "\\";
}

export async function withTempHome<T>(
  fn: (home: string) => Promise<T>,
  opts: { env?: Record<string, EnvValue>; prefix?: string } = {},
): Promise<T> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), opts.prefix ?? "infinibot-test-home-"));
  const snapshot = snapshotEnv();
  const envSnapshot = Object.fromEntries(
    Object.keys(opts.env ?? {}).map((key) => [key, process.env[key]]),
  );
  for (const key of Object.keys(opts.env ?? {})) {
    if (["HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"].includes(key)) {
      throw new Error(`withTempHome: use built-in home env (got ${key})`);
    }
  }
  setTempHome(base);
  await fs.mkdir(path.join(base, ".infinibot", "agents", "main", "sessions"), { recursive: true });
  for (const [key, raw] of Object.entries(opts.env ?? {})) {
    const value = typeof raw === "function" ? raw(base) : raw;
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn(base);
  } finally {
    for (const [key, value] of Object.entries(envSnapshot)) restoreKey(key, value);
    restoreEnv(snapshot);
    try {
      await fs.rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch {
      // Best-effort cleanup only; a locked file must not hide the test result.
    }
  }
}
