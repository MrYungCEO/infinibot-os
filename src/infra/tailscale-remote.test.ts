import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chooseHttpsPort,
  createRemoteLink,
  isAllowedExternalUrl,
  parseServeMappings,
  proxiesToPort,
  readRemoteStatus,
  readSavedRemoteUrl,
  removeRemoteLink,
  startTailscaleLogin,
  tailscaleDownloadUrl,
  verifyRemoteLink,
  type RemoteDeps,
  type SpawnFn,
} from "./tailscale-remote.js";

const HOST = "box.tail1234.ts.net";
const GW = 18990;

/** `tailscale status --json` for a signed-in node with MagicDNS + HTTPS on. */
function runningStatus(over: Record<string, unknown> = {}) {
  return {
    BackendState: "Running",
    AuthURL: "",
    MagicDNSSuffix: "tail1234.ts.net",
    CertDomains: [HOST],
    CurrentTailnet: {
      Name: "me@example.com",
      MagicDNSSuffix: "tail1234.ts.net",
      MagicDNSEnabled: true,
    },
    Self: { DNSName: `${HOST}.`, UserID: 1 },
    ...over,
  };
}

/** The owner's real shape: 443 → live gateway, 8445 → Estate OS, funnel on 10000. */
function ownerServe() {
  return {
    TCP: { "443": { HTTPS: true }, "8445": { HTTPS: true }, "10000": { HTTPS: true } },
    Web: {
      [`${HOST}:443`]: {
        Handlers: {
          "/": { Proxy: "http://127.0.0.1:18789" },
          "/flypic": { Proxy: "http://127.0.0.1:3001" },
        },
      },
      [`${HOST}:8445`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:18795" } } },
      [`${HOST}:10000`]: { Handlers: { "/": { Proxy: "http://localhost:8080" } } },
    },
    AllowFunnel: { [`${HOST}:10000`]: true },
  };
}

type Call = { bin: string; args: string[] };

/** A fake `tailscale` CLI whose serve config is mutated by serve commands. */
function fakeCli(
  opts: { status?: Record<string, unknown> | Error; serve?: Record<string, unknown> } = {},
) {
  let serve: Record<string, any> = structuredClone(opts.serve ?? {});
  const calls: Call[] = [];
  const exec = vi.fn(async (bin: string, args: string[]) => {
    calls.push({ bin, args });
    if (args[0] === "status") {
      if (opts.status instanceof Error) throw opts.status;
      return { stdout: JSON.stringify(opts.status ?? runningStatus()), stderr: "" };
    }
    if (args[0] === "serve" && args[1] === "status")
      return { stdout: JSON.stringify(serve), stderr: "" };
    if (args[0] === "serve") {
      const https = args.find((a) => a.startsWith("--https="));
      const port = https ? Number(https.split("=")[1]) : 443;
      const key = `${HOST}:${port}`;
      if (args.at(-1) === "off") {
        delete serve.Web?.[key];
        delete serve.TCP?.[String(port)];
      } else {
        serve.TCP = { ...(serve.TCP ?? {}), [String(port)]: { HTTPS: true } };
        serve.Web = { ...(serve.Web ?? {}), [key]: { Handlers: { "/": { Proxy: args.at(-1) } } } };
      }
      return { stdout: "", stderr: "" };
    }
    throw new Error(`unexpected ${args.join(" ")}`);
  });
  const deps: RemoteDeps = {
    exec: exec as unknown as RemoteDeps["exec"],
    findBinary: async () => "/usr/bin/tailscale",
    platform: "linux",
    savedUrl: readSavedRemoteUrl,
  };
  return { deps, calls, serve: () => serve, setServe: (s: Record<string, any>) => (serve = s) };
}

let stateDir = "";
const prevState = process.env.INFINIBOT_STATE_DIR;

beforeEach(() => {
  // Never the live ~/.infinibot: saveRemoteUrl writes <state>/mobile.json.
  stateDir = mkdtempSync(path.join(os.tmpdir(), "ts-remote-"));
  process.env.INFINIBOT_STATE_DIR = stateDir;
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  if (prevState === undefined) delete process.env.INFINIBOT_STATE_DIR;
  else process.env.INFINIBOT_STATE_DIR = prevState;
});

describe("detection states (stubbed CLI)", () => {
  it("not installed → install step with the OS download page", async () => {
    const s = await readRemoteStatus(GW, {
      ...fakeCli().deps,
      findBinary: async () => null,
      platform: "win32",
    });
    expect(s.installed).toBe(false);
    expect(s.nextStep).toBe("install");
    expect(s.downloadUrl).toBe("https://tailscale.com/download/windows");
    expect(tailscaleDownloadUrl("darwin")).toBe("https://tailscale.com/download/mac");
    expect(tailscaleDownloadUrl("linux")).toBe("https://tailscale.com/download/linux");
  });

  it("installed but tailscaled down → start step", async () => {
    const err = Object.assign(new Error("exit 1"), {
      stderr: "failed to connect to local tailscaled; it doesn't appear to be running",
    });
    const s = await readRemoteStatus(GW, fakeCli({ status: err }).deps);
    expect(s.installed).toBe(true);
    expect(s.running).toBe(false);
    expect(s.nextStep).toBe("start");
  });

  it("logged out → login step, surfaces AuthURL when present", async () => {
    const s = await readRemoteStatus(
      GW,
      fakeCli({
        status: {
          BackendState: "NeedsLogin",
          AuthURL: "https://login.tailscale.com/a/abc123",
          Self: {},
        },
      }).deps,
    );
    expect(s.loggedIn).toBe(false);
    expect(s.nextStep).toBe("login");
    expect(s.authUrl).toBe("https://login.tailscale.com/a/abc123");
  });

  it("logged-out status JSON printed on a non-zero exit is still parsed", async () => {
    const err = Object.assign(new Error("exit 1"), {
      stdout: JSON.stringify({ BackendState: "NeedsLogin", Self: {} }),
    });
    const s = await readRemoteStatus(GW, fakeCli({ status: err }).deps);
    expect(s.nextStep).toBe("login");
  });

  it("signed in but off → login step (tailscale up)", async () => {
    const s = await readRemoteStatus(
      GW,
      fakeCli({ status: { BackendState: "Stopped", Self: { DNSName: `${HOST}.` } } }).deps,
    );
    expect(s.loggedIn).toBe(true);
    expect(s.nextStep).toBe("login");
  });

  it("MagicDNS off → magicdns step with the admin DNS link", async () => {
    const s = await readRemoteStatus(
      GW,
      fakeCli({
        status: runningStatus({
          CurrentTailnet: { MagicDNSEnabled: false },
          Self: { DNSName: "" },
          CertDomains: [],
        }),
      }).deps,
    );
    expect(s.nextStep).toBe("magicdns");
    expect(s.adminDnsUrl).toBe("https://login.tailscale.com/admin/dns");
  });

  it("HTTPS certificates off → https step", async () => {
    const s = await readRemoteStatus(
      GW,
      fakeCli({ status: runningStatus({ CertDomains: null }) }).deps,
    );
    expect(s.magicDns).toBe(true);
    expect(s.httpsCerts).toBe(false);
    expect(s.nextStep).toBe("https");
  });

  it("ready to create, and ready when a mapping already serves this gateway", async () => {
    expect((await readRemoteStatus(GW, fakeCli({ serve: ownerServe() }).deps)).nextStep).toBe(
      "create",
    );
    const live = await readRemoteStatus(18789, fakeCli({ serve: ownerServe() }).deps);
    expect(live.nextStep).toBe("ready");
    expect(live.gatewayMapping?.url).toBe(`https://${HOST}`);
    expect(live.account).toBe("me@example.com");
  });
});

describe("serve mapping helpers", () => {
  it("flattens serve status and flags funnel", () => {
    const rows = parseServeMappings(ownerServe());
    expect(rows.map((r) => `${r.port}${r.path}→${r.target}`)).toEqual([
      "443/→http://127.0.0.1:18789",
      "443/flypic→http://127.0.0.1:3001",
      "8445/→http://127.0.0.1:18795",
      "10000/→http://localhost:8080",
    ]);
    expect(rows.find((r) => r.port === 10000)?.funnel).toBe(true);
  });

  it("matches proxy targets to a port exactly", () => {
    expect(proxiesToPort("http://127.0.0.1:18789", 18789)).toBe(true);
    expect(proxiesToPort("http://localhost:18789/", 18789)).toBe(true);
    expect(proxiesToPort("http://127.0.0.1:187890", 18789)).toBe(false);
    expect(proxiesToPort("http://127.0.0.1:18789/plugins/robovoice", 18789)).toBe(false);
    expect(proxiesToPort("http://10.0.0.5:18789", 18789)).toBe(false);
  });

  it("443 free → 443; 443 taken → first free port from 8443; existing → reuse", () => {
    expect(chooseHttpsPort({}, GW)).toMatchObject({ port: 443, reason: "443-free" });
    expect(chooseHttpsPort(ownerServe(), GW)).toMatchObject({ port: 8443, reason: "443-taken" });
    const busy = ownerServe() as any;
    busy.TCP["8443"] = { HTTPS: true };
    busy.TCP["8444"] = { TCPForward: "127.0.0.1:22" };
    expect(chooseHttpsPort(busy, GW)).toMatchObject({ port: 8446 });
    expect(chooseHttpsPort(ownerServe(), 18795)).toMatchObject({
      port: 8445,
      reason: "already-served",
    });
  });

  it("only opens tailscale.com and ts.net links", () => {
    expect(isAllowedExternalUrl("https://login.tailscale.com/a/x")).toBe(true);
    expect(isAllowedExternalUrl("https://tailscale.com/download/windows")).toBe(true);
    expect(isAllowedExternalUrl(`https://${HOST}:8443`)).toBe(true);
    expect(isAllowedExternalUrl("https://evil.example/tailscale.com")).toBe(false);
    expect(isAllowedExternalUrl("http://tailscale.com")).toBe(false);
    expect(isAllowedExternalUrl("file:///etc/passwd")).toBe(false);
  });
});

describe("create / remove never clobber existing mappings", () => {
  it("creates on a free port when 443 is taken, keeps every existing mapping, saves the phone URL", async () => {
    const cli = fakeCli({ serve: ownerServe() });
    const before = parseServeMappings(cli.serve());
    const res = await createRemoteLink(GW, cli.deps);
    expect(res).toMatchObject({
      url: `https://${HOST}:8443`,
      httpsPort: 8443,
      reused: false,
      preserved: 4,
    });
    expect(res.note).toMatch(/443 is already used/);
    const serveCmd = cli.calls.find((c) => c.args[0] === "serve" && c.args[1] !== "status");
    expect(serveCmd?.args).toEqual([
      "serve",
      "--bg",
      "--yes",
      "--https=8443",
      `http://127.0.0.1:${GW}`,
    ]);
    expect(cli.calls.some((c) => c.args.includes("reset"))).toBe(false);
    const after = parseServeMappings(cli.serve());
    for (const m of before) expect(after).toContainEqual(m);
    const saved = JSON.parse(readFileSync(path.join(stateDir, "mobile.json"), "utf8"));
    expect(saved).toMatchObject({
      remoteUrl: `https://${HOST}:8443`,
      gatewayUrlOverride: `wss://${HOST}:8443`,
    });
  });

  it("uses 443 when nothing is served", async () => {
    const cli = fakeCli({ serve: {} });
    const res = await createRemoteLink(GW, cli.deps);
    expect(res).toMatchObject({ url: `https://${HOST}`, httpsPort: 443, note: null });
  });

  it("reuses an existing mapping without running serve", async () => {
    const cli = fakeCli({ serve: ownerServe() });
    const res = await createRemoteLink(18789, cli.deps);
    expect(res).toMatchObject({ reused: true, httpsPort: 443, url: `https://${HOST}` });
    expect(cli.calls.filter((c) => c.args[0] === "serve" && c.args[1] !== "status")).toHaveLength(
      0,
    );
  });

  it("refuses to create while logged out", async () => {
    const cli = fakeCli({ status: { BackendState: "NeedsLogin", Self: {} } });
    await expect(createRemoteLink(GW, cli.deps)).rejects.toThrow(/Sign in/);
  });

  it("removes only its own port and leaves the rest identical", async () => {
    const cli = fakeCli({ serve: ownerServe() });
    const before = JSON.stringify(cli.serve());
    await createRemoteLink(GW, cli.deps);
    const res = await removeRemoteLink(GW, 8443, cli.deps);
    expect(res.removed).toBe(true);
    expect(JSON.stringify(cli.serve())).toBe(before);
    expect(cli.calls.at(-1)?.args).toEqual(["serve", "--https=8443", "off"]);
    expect(readSavedRemoteUrl()).toBeNull();
  });

  it("refuses to remove a port that serves something else", async () => {
    const cli = fakeCli({ serve: ownerServe() });
    await expect(removeRemoteLink(GW, 443, cli.deps)).rejects.toThrow(/won't remove/);
    await expect(removeRemoteLink(18795, 443, cli.deps)).rejects.toThrow(/won't remove/);
    expect(cli.calls.some((c) => c.args.at(-1) === "off")).toBe(false);
  });

  it("clearing keeps a hand-set override", async () => {
    writeFileSync(
      path.join(stateDir, "mobile.json"),
      JSON.stringify({ gatewayUrlOverride: "wss://mine.example" }),
    );
    const cli = fakeCli({ serve: {} });
    await createRemoteLink(GW, cli.deps);
    await removeRemoteLink(GW, 443, cli.deps);
    const saved = JSON.parse(readFileSync(path.join(stateDir, "mobile.json"), "utf8"));
    expect(saved.remoteUrl).toBeUndefined();
    expect(saved.gatewayUrlOverride).toBeUndefined();
  });
});

describe("sign in", () => {
  function fakeSpawn(
    lines: string[],
    exitCode: number | null = null,
  ): { spawn: SpawnFn; argv: string[][] } {
    const argv: string[][] = [];
    const spawn: SpawnFn = (_bin, args) => {
      argv.push(args);
      return {
        onOutput: (cb) => queueMicrotask(() => lines.forEach(cb)),
        onExit: (cb) => {
          if (exitCode !== null) setTimeout(() => cb(exitCode), 5);
        },
      };
    };
    return { spawn, argv };
  }

  it("logged out → runs `tailscale login` and returns the auth URL it prints", async () => {
    const cli = fakeCli({ status: { BackendState: "NeedsLogin", Self: {} } });
    const sp = fakeSpawn([
      "\nTo authenticate, visit:\n\n\thttps://login.tailscale.com/a/1f2e3d4c\n\n",
    ]);
    const res = await startTailscaleLogin({ ...cli.deps, spawn: sp.spawn, waitMs: 2000 });
    expect(sp.argv).toEqual([["login"]]);
    expect(res).toMatchObject({
      authUrl: "https://login.tailscale.com/a/1f2e3d4c",
      connected: false,
    });
  });

  it("signed in but off → `tailscale up`, connected when it exits 0", async () => {
    const cli = fakeCli({ status: { BackendState: "Stopped", Self: {} } });
    const sp = fakeSpawn([], 0);
    const res = await startTailscaleLogin({ ...cli.deps, spawn: sp.spawn, waitMs: 2000 });
    expect(sp.argv).toEqual([["up"]]);
    expect(res).toMatchObject({ authUrl: null, connected: true });
  });

  it("already running → nothing spawned", async () => {
    const sp = fakeSpawn([]);
    const res = await startTailscaleLogin({ ...fakeCli().deps, spawn: sp.spawn });
    expect(sp.argv).toHaveLength(0);
    expect(res.connected).toBe(true);
  });
});

describe("verify", () => {
  it("green only when both the gateway route and the phone app answer", async () => {
    const ok = vi.fn(async (u: string) =>
      u.endsWith("/api/access/status")
        ? new Response('{"enabled":false}', { status: 200 })
        : new Response("<!doctype html><html></html>", { status: 200 }),
    );
    const res = await verifyRemoteLink(`https://${HOST}:8443/`, ok as unknown as typeof fetch);
    expect(res.ok).toBe(true);
    expect(ok).toHaveBeenCalledWith(`https://${HOST}:8443/api/access/status`, expect.anything());

    const down = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(
      (await verifyRemoteLink(`https://${HOST}:8443`, down as unknown as typeof fetch)).ok,
    ).toBe(false);

    const wrong = vi.fn(async () => new Response("nginx", { status: 502 }));
    expect((await verifyRemoteLink(`https://${HOST}`, wrong as unknown as typeof fetch)).ok).toBe(
      false,
    );
  });

  it("rejects non ts.net URLs", async () => {
    await expect(verifyRemoteLink("https://example.com")).rejects.toThrow(/ts\.net/);
  });
});
