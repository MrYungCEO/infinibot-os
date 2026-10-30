import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ib-browser-profiles-"));

type Store = typeof import("./profile-store.js");
type Cookies = typeof import("./session-cookies.js");
type Runtime = typeof import("./runtime.js");
let store: Store;
let cookies: Cookies;
let runtime: Runtime;

beforeAll(async () => {
  vi.resetModules();
  process.env.INFINIBOT_STATE_DIR = stateDir;
  store = await import("./profile-store.js");
  cookies = await import("./session-cookies.js");
  runtime = await import("./runtime.js");
});

afterAll(() => {
  store.wipeSecureProfile();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("profile names and locations", () => {
  it("maps what models pass to profile names", () => {
    expect(store.normalizeAgentProfileName(undefined)).toBe("default");
    expect(store.normalizeAgentProfileName(" Default ")).toBe("default");
    expect(store.normalizeAgentProfileName("infini")).toBe("default");
    expect(store.normalizeAgentProfileName("relay")).toBe("chrome");
    expect(store.normalizeAgentProfileName("Work Account")).toBe("work-account");
    expect(() => store.normalizeAgentProfileName("../etc")).toThrow(/Invalid browser profile name/);
  });

  it("stores new profiles under <state>/browser/profiles and keeps legacy dirs", () => {
    expect(store.userDataDirForManagedProfile("work")).toBe(
      path.join(stateDir, "browser", "profiles", "work", "user-data"),
    );
    expect(store.userDataDirForManagedProfile("clawd")).toBe(
      path.join(stateDir, "browser", "clawd", "user-data"),
    );
    fs.mkdirSync(path.join(stateDir, "browser", "old", "user-data"), { recursive: true });
    expect(store.userDataDirForManagedProfile("old")).toBe(
      path.join(stateDir, "browser", "old", "user-data"),
    );
  });

  it("keeps the secure profile on tmpfs, outside the state dir", () => {
    const dir = store.userDataDirForManagedProfile("secure");
    expect(dir.startsWith(stateDir)).toBe(false);
    if (fs.existsSync("/dev/shm")) expect(dir.startsWith("/dev/shm/")).toBe(true);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "Cookies"), "x");
    store.wipeSecureProfile();
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("lists stored profiles", () => {
    fs.mkdirSync(path.join(stateDir, "browser", "profiles", "work", "user-data"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(stateDir, "browser", "profiles", "Bad Name"), { recursive: true });
    expect(store.listStoredProfileNames()).toEqual(["work"]);
    const info = store.describeStoredProfile("work", "work");
    expect(info.exists).toBe(true);
    expect(info.ephemeral).toBe(false);
  });
});

describe("profile lock", () => {
  it("takes, re-takes and releases its own lock", () => {
    const dir = store.userDataDirForManagedProfile("locktest");
    fs.mkdirSync(dir, { recursive: true });
    const lock = store.acquireProfileLock(dir, { cdpPort: 18850 });
    expect(lock.pid).toBe(process.pid);
    expect(store.readProfileLock(dir)?.cdpPort).toBe(18850);
    expect(() => store.acquireProfileLock(dir)).not.toThrow();
    store.releaseProfileLock(dir);
    expect(store.readProfileLock(dir)).toBeNull();
  });

  it("refuses a profile another live process holds", async () => {
    const dir = store.userDataDirForManagedProfile("busy");
    fs.mkdirSync(dir, { recursive: true });
    const other = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 20000)"]);
    try {
      store.acquireProfileLock(dir, { pid: other.pid! });
      expect(() => store.acquireProfileLock(dir)).toThrow(/in use by another InfiniBot process/);
      expect(store.describeStoredProfile("busy", "busy").lockedByOther).toBe(true);
      // Releasing someone else's lock is a no-op.
      store.releaseProfileLock(dir);
      expect(store.readProfileLock(dir)?.pid).toBe(other.pid);
    } finally {
      other.kill("SIGKILL");
    }
  });

  it("takes over a stale lock and clears Chrome's stale SingletonLock", () => {
    const dir = store.userDataDirForManagedProfile("stale");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(path.dirname(dir), "infinibot-profile.lock"),
      JSON.stringify({ pid: 999_999_9, stateDir, startedAt: "x" }),
    );
    fs.symlinkSync(`${os.hostname()}-9999998`, path.join(dir, "SingletonLock"));
    store.acquireProfileLock(dir);
    expect(store.readProfileLock(dir)?.pid).toBe(process.pid);
    expect(fs.existsSync(path.join(dir, "SingletonLock"))).toBe(false);
    expect(() => fs.lstatSync(path.join(dir, "SingletonLock"))).toThrow();
    store.releaseProfileLock(dir);
  });

  it("keeps Chrome's SingletonLock while that Chrome is alive", () => {
    const dir = store.userDataDirForManagedProfile("alivechrome");
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(`${os.hostname()}-${process.pid}`, path.join(dir, "SingletonLock"));
    store.acquireProfileLock(dir);
    expect(fs.lstatSync(path.join(dir, "SingletonLock")).isSymbolicLink()).toBe(true);
    store.releaseProfileLock(dir);
  });
});

describe("session cookie keeper", () => {
  const sessionCookie = {
    name: "sid",
    value: "abc",
    domain: "127.0.0.1",
    path: "/",
    expires: -1,
    session: true,
    httpOnly: true,
    secure: false,
    sameSite: "Lax",
    size: 6,
  };
  const persistent = {
    name: "remember",
    value: "x",
    domain: ".github.com",
    path: "/",
    expires: 1999999999,
    session: false,
  };

  it("keeps only session cookies and strips read-only fields", () => {
    expect(cookies.pickSessionCookies([sessionCookie, persistent])).toEqual([sessionCookie]);
    const [p] = cookies.toSetCookieParams([sessionCookie]);
    expect(p).toEqual({
      name: "sid",
      value: "abc",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    });
  });

  it("backs up to a 0600 file and restores via Storage.setCookies", async () => {
    const dir = store.userDataDirForManagedProfile("cookies");
    fs.mkdirSync(dir, { recursive: true });
    const n = await cookies.backupSessionCookies(
      async () => ({ cookies: [sessionCookie, persistent] }),
      dir,
    );
    expect(n).toBe(1);
    const file = cookies.sessionCookieFile(dir);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const sent: unknown[] = [];
    const restored = await cookies.restoreSessionCookies(async (method, params) => {
      sent.push({ method, params });
      return {};
    }, dir);
    expect(restored).toBe(1);
    expect(sent[0]).toMatchObject({
      method: "Storage.setCookies",
      params: { cookies: [{ name: "sid", value: "abc" }] },
    });
    cookies.clearSavedSessionCookies(dir, "127.0.0.1");
    expect(cookies.readSavedSessionCookies(dir)).toEqual([]);
  });

  it("matches cookie domains to a site", () => {
    expect(cookies.cookieMatchesSite({ domain: ".github.com" }, "github.com")).toBe(true);
    expect(cookies.cookieMatchesSite({ domain: "api.github.com" }, "github.com")).toBe(true);
    expect(cookies.cookieMatchesSite({ domain: "notgithub.com" }, "github.com")).toBe(false);
  });
});

describe("profile resolution for agent calls", () => {
  it("defaults to the shared browser and honors explicit, sticky and per-agent choices", () => {
    expect(runtime.resolveAgentProfile({}).name).toBe("default");
    expect(runtime.resolveAgentProfile({ requested: "work" }).name).toBe("work");
    expect(runtime.resolveAgentProfile({ sticky: "work" }).name).toBe("work");
    expect(runtime.resolveAgentProfile({ requested: "chrome" }).kind).toBe("relay");
    const cfg = { browser: { agentProfiles: { outreach: "outreach-logins" } } } as never;
    expect(runtime.resolveAgentProfile({ agentId: "outreach", cfg }).name).toBe("outreach-logins");
    expect(runtime.resolveAgentProfile({ agentId: "outreach", cfg, requested: "work" }).name).toBe(
      "work",
    );
  });

  it("pins Secure Mode sessions to the secure profile and keeps everyone else out", () => {
    const secureKey = "agent:main:secure-abc123";
    const r = runtime.resolveAgentProfile({ sessionKey: secureKey });
    expect(r).toEqual({ name: "secure", kind: "managed", secure: true });
    expect(() =>
      runtime.resolveAgentProfile({ sessionKey: secureKey, requested: "default" }),
    ).toThrow(/Secure Mode sessions can only use/);
    expect(() => runtime.resolveAgentProfile({ sessionKey: secureKey, sticky: "work" })).toThrow();
    expect(() =>
      runtime.resolveAgentProfile({ sessionKey: "agent:main:main", requested: "secure" }),
    ).toThrow(/reserved for Secure Mode/);
  });

  it("registers a dynamic profile on a free CDP port without touching config", () => {
    const state = {
      port: 18791,
      profiles: new Map(),
      resolved: {
        controlPort: 18791,
        defaultProfile: "chrome",
        profiles: {
          clawd: { cdpPort: 18800 },
          chrome: { cdpUrl: "http://127.0.0.1:18792", driver: "extension" },
        },
      },
    } as never;
    expect(runtime.managedProfileName(state, "default")).toBe("clawd");
    runtime.ensureDynamicProfile(state, "work");
    const work = (state as { resolved: { profiles: Record<string, { cdpPort?: number }> } })
      .resolved.profiles.work;
    expect(work?.cdpPort).toBeGreaterThan(18800);
    expect(runtime.agentProfileName(state, "clawd")).toBe("default");
  });
});
