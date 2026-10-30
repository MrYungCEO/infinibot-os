import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { runWithUserId } from "../../config/paths.js";
import { enrichedPath, resolveBin } from "../coder-backend/bin-detect.js";
import { CODER_CATALOG, coderForBackend, getCoderEntry, isInstallable } from "./catalog.js";
import {
  _resetJobs,
  buildShim,
  planInstall,
  readManifest,
  scrubbedEnv,
  startJob,
  type HostTools,
} from "./installer.js";
import { applyCoderSpawnEnv, clearCoderKey, coderKeyNames, setCoderKey } from "./keys.js";
import {
  _resetLogins,
  _setPtySpawner,
  cancelLogin,
  parseLoginOutput,
  pollLogin,
  startLogin,
  submitLoginCode,
} from "./login.js";
import { codersBinDir, codersRoot, coderInstallPolicy, coderPrefix, isInside } from "./paths.js";
import { cleanLogText, redactSecrets } from "./redact.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ib-coders-test-"));
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "INFINIBOT_STATE_DIR",
  "INFINIBOT_AGENT_DIR",
  "INFINIBOT_CODERS_DIR",
  "INFINIBOT_CODERS_DISABLED",
  "INFINIBOT_CODERS_ALLOW_SHARED",
  "INFINIBOT_CODERS_QUOTA_MB",
  "SAAS_MODE",
  "FLEET_TENANT_ID",
];

let stateDir = "";
beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  stateDir = fs.mkdtempSync(path.join(TMP, "state-"));
  process.env.INFINIBOT_STATE_DIR = stateDir;
  process.env.INFINIBOT_AGENT_DIR = path.join(stateDir, "agents", "main", "agent");
  process.env.SAAS_MODE = "0";
  _resetJobs();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  _resetLogins();
  _setPtySpawner(null);
});
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

// ── Catalog ───────────────────────────────────────────────────────────────

describe("catalog", () => {
  it("has unique ids, bins and valid shapes", () => {
    const ids = CODER_CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const bins = CODER_CATALOG.map((e) => e.bin);
    expect(new Set(bins).size).toBe(bins.length);
    for (const e of CODER_CATALOG) {
      expect(e.id).toMatch(/^[a-z0-9-]+$/);
      expect(e.bin).toMatch(/^[a-z0-9-]+$/);
      expect(e.monogram).toMatch(/^[A-Z]$/);
      expect(e.install.length).toBeGreaterThan(0);
      expect(e.homepage).toMatch(/^https:\/\//);
      for (const m of e.install) {
        if (m.kind === "npm") {
          expect(m.package).toMatch(/^(@[a-z0-9-]+\/)?[a-z0-9.-]+$/);
          expect(m.version).toMatch(/^(latest|\d+\.\d+\.\d+)$/);
        }
        if (m.kind === "manual") expect(m.url).toMatch(/^https:\/\//);
      }
      for (const a of e.auth) {
        if (a.kind === "api-key") {
          expect(a.envVars?.length).toBeGreaterThan(0);
          for (const v of a.envVars ?? []) expect(v).toMatch(/^[A-Z][A-Z0-9_]+$/);
        } else {
          expect(Array.isArray(a.loginArgs) && a.loginArgs.length > 0).toBe(true);
        }
      }
    }
  });

  it("covers the four drivable backends and the required coders", () => {
    for (const b of ["claude-code", "codex", "opencode", "gemini"] as const) {
      expect(coderForBackend(b)?.backend).toBe(b);
    }
    for (const id of ["claude-code", "codex", "opencode", "gemini"]) {
      expect(isInstallable(getCoderEntry(id)!)).toBe(true);
    }
    expect(isInstallable(getCoderEntry("goose")!)).toBe(false);
    expect(getCoderEntry("../../etc")).toBeUndefined();
    expect(getCoderEntry({})).toBeUndefined();
  });
});

// ── Paths + policy ────────────────────────────────────────────────────────

describe("paths and policy", () => {
  it("local root is <state>/coders; override wins", () => {
    expect(codersRoot()).toBe(path.join(stateDir, "coders"));
    expect(codersBinDir()).toBe(path.join(stateDir, "coders", "bin"));
    expect(coderPrefix("codex")).toBe(path.join(stateDir, "coders", "codex"));
    process.env.INFINIBOT_CODERS_DIR = path.join(TMP, "elsewhere");
    expect(codersRoot()).toBe(path.join(TMP, "elsewhere"));
  });

  it("cloud (state on /data) resolves to /data/coders", () => {
    const env = {
      ...process.env,
      INFINIBOT_STATE_DIR: "/data",
      SAAS_MODE: "1",
      FLEET_TENANT_ID: "t1",
    };
    expect(codersRoot(env)).toBe("/data/coders");
    expect(coderPrefix("claude-code", env)).toBe("/data/coders/claude-code");
    expect(coderInstallPolicy(env)).toEqual({ allowed: true, mode: "fleet" });
  });

  it("shared multi-tenant SaaS is blocked; disabled flag wins everywhere", () => {
    const shared = coderInstallPolicy({ SAAS_MODE: "1" });
    expect(shared.allowed).toBe(false);
    expect(coderInstallPolicy({ SAAS_MODE: "1", INFINIBOT_CODERS_ALLOW_SHARED: "1" }).allowed).toBe(
      true,
    );
    expect(coderInstallPolicy({ SAAS_MODE: "0" })).toEqual({ allowed: true, mode: "local" });
    expect(coderInstallPolicy({ INFINIBOT_CODERS_DISABLED: "1" }).allowed).toBe(false);
    expect(
      coderInstallPolicy({
        SAAS_MODE: "1",
        FLEET_TENANT_ID: "t",
        INFINIBOT_CODERS_DISABLED: "true",
      }).allowed,
    ).toBe(false);
  });

  it("tenant-scoped requests get disjoint roots", () => {
    const a = runWithUserId("tenant-a", () => codersRoot());
    const b = runWithUserId("tenant-b", () => codersRoot());
    const evil = runWithUserId("../../x", () => codersRoot());
    expect(a).toBe(path.join(stateDir, "coders", "tenants", "tenant-a"));
    expect(b).not.toBe(a);
    expect(isInside(path.join(stateDir, "coders", "tenants"), evil)).toBe(true);
    expect(isInside(a, b)).toBe(false);
  });

  it("rejects bad ids and path escapes", () => {
    expect(() => coderPrefix("../x" as never)).toThrow();
    expect(isInside("/a/b", "/a/b/c")).toBe(true);
    expect(isInside("/a/b", "/a/b")).toBe(false);
    expect(isInside("/a/b", "/a/bc")).toBe(false);
    expect(isInside("/a/b", "/a/b/../c")).toBe(false);
  });
});

// ── Planner ───────────────────────────────────────────────────────────────

const npmHost = { npm: { command: "node", args: ["npm-cli.js"] }, uv: null, pipx: null };

describe("planInstall", () => {
  it("picks npm into the managed prefix", () => {
    const plan = planInstall(getCoderEntry("codex")!, npmHost);
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.method.kind).toBe("npm");
      expect(plan.prefix).toBe(path.join(stateDir, "coders", "codex"));
    }
  });

  it("falls through uv → pipx and reports missing prerequisites", () => {
    const aider = getCoderEntry("aider")!;
    const none = planInstall(aider, npmHost);
    expect(none.ok).toBe(false);
    if (!none.ok) {
      expect(none.code).toBe("MISSING_PREREQ");
      expect(none.message).toMatch(/uv/);
    }
    const pipx = planInstall(aider, { ...npmHost, pipx: "/usr/bin/pipx" });
    expect(pipx.ok && pipx.method.kind).toBe("pipx");
    const uv = planInstall(aider, { ...npmHost, uv: "/usr/bin/uv", pipx: "/usr/bin/pipx" });
    expect(uv.ok && uv.method.kind).toBe("uv");
  });

  it("manual entries and missing npm are explained", () => {
    const goose = planInstall(getCoderEntry("goose")!, npmHost);
    expect(!goose.ok && goose.code).toBe("MANUAL");
    const noNpm = planInstall(getCoderEntry("claude-code")!, { npm: null, uv: null, pipx: null });
    expect(!noNpm.ok && noNpm.code).toBe("MISSING_PREREQ");
    expect(!noNpm.ok && noNpm.message).toMatch(/Node\.js/);
  });

  it("policy blocks shared SaaS", () => {
    process.env.SAAS_MODE = "1";
    const plan = planInstall(getCoderEntry("codex")!, npmHost);
    expect(!plan.ok && plan.code).toBe("POLICY");
  });
});

// ── Scrubbed env + shims ──────────────────────────────────────────────────

describe("child env and shims", () => {
  it("scrubbed env drops secrets but keeps PATH/HOME and the managed bin dir", () => {
    const env = scrubbedEnv(
      {},
      {
        ...process.env,
        HOME: "/home/x",
        PATH: "/usr/bin",
        ANTHROPIC_API_KEY: "sk-ant-secret",
        INFINIBOT_GATEWAY_TOKEN: "tok",
        NEON_DATABASE_URL: "postgres://u:p@h/db",
        HTTPS_PROXY: "http://proxy:1",
      },
    );
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.INFINIBOT_GATEWAY_TOKEN).toBeUndefined();
    expect(env.NEON_DATABASE_URL).toBeUndefined();
    expect(env.HOME).toBe("/home/x");
    expect(env.HTTPS_PROXY).toBe("http://proxy:1");
    expect(env.PATH?.split(":")[0]).toBe(codersBinDir());
    expect(env.PATH).toContain(path.dirname(process.execPath));
  });

  it("node scripts run on the pinned node; native binaries are exec'd", () => {
    const dir = fs.mkdtempSync(path.join(TMP, "shim-"));
    const js = path.join(dir, "cli.js");
    fs.writeFileSync(js, "#!/usr/bin/env node\nconsole.log('1.0.0')\n");
    const native = path.join(dir, "bin.exe");
    fs.writeFileSync(native, "\x7fELF....");
    const s1 = buildShim(js, "/opt/node/bin/node", "linux");
    expect(s1).toContain(`exec "$NODE_BIN" '${js}' "$@"`);
    expect(s1).toContain("NODE_BIN='/opt/node/bin/node'");
    const s2 = buildShim(native, "/opt/node/bin/node", "linux");
    expect(s2).toContain(`exec '${native}' "$@"`);
    const q = buildShim(path.join(dir, "it's.js"), "/n", "linux");
    expect(q).toContain(`'\\''`);
  });
});

// ── Install engine with a fake npm ────────────────────────────────────────

/**
 * A stand-in for npm-cli.js: `install --global --prefix <p> ... <pkg>@<ver>`
 * lays out <p>/lib/node_modules/<pkg> with a node-script bin, like npm does.
 * FAKE_NPM_FAIL=1 makes it exit 1.
 */
function writeFakeNpm(dir: string): string {
  const p = path.join(dir, "fake-npm.cjs");
  fs.writeFileSync(
    p,
    `
const fs = require("fs"), path = require("path");
const a = process.argv.slice(2);
// Control file next to this script (the installer scrubs the child env).
let ctl = {};
try { ctl = JSON.parse(fs.readFileSync(__filename + ".json", "utf8")); } catch {}
if (ctl.fail) { console.error("boom sk-ant-abcdefghijklmnop"); process.exit(1); }
if (a[0] === "view") { console.log("9.9.9"); process.exit(0); }
const prefix = a[a.indexOf("--prefix") + 1];
const spec = a[a.length - 1];
const at = spec.lastIndexOf("@");
const pkg = spec.slice(0, at);
const ver = ctl.version || "1.2.3";
const pd = path.join(prefix, "lib", "node_modules", pkg);
fs.mkdirSync(path.join(pd, "bin"), { recursive: true });
fs.writeFileSync(path.join(pd, "package.json"), JSON.stringify({ name: pkg, version: ver, bin: { codex: "bin/cli.js" } }));
fs.writeFileSync(path.join(pd, "bin", "cli.js"), "#!/usr/bin/env node\\nconsole.log('codex-cli " + ver + "')\\n", { mode: 0o755 });
fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
fs.symlinkSync(path.join("..", "lib", "node_modules", pkg, "bin", "cli.js"), path.join(prefix, "bin", "codex"));
console.log("added 1 package");
`,
  );
  return p;
}

function setFake(npmScript: string, ctl: { fail?: boolean; version?: string }) {
  fs.writeFileSync(`${npmScript}.json`, JSON.stringify(ctl));
}

function fakeHost(npmScript: string): HostTools {
  return {
    npm: { command: process.execPath, args: [npmScript] },
    uv: null,
    pipx: null,
    node: process.execPath,
    nodeVersion: process.versions.node,
  };
}

describe("install / update / uninstall (fake npm, temp state)", () => {
  it("installs into the prefix, shims, resolves via bin-detect, updates, uninstalls", async () => {
    const npmScript = writeFakeNpm(fs.mkdtempSync(path.join(TMP, "npm-")));
    const host = fakeHost(npmScript);
    const events: string[] = [];
    const r = startJob("codex", "install", { host, listener: (j) => events.push(j.phase) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const job = await r.done;
    expect(job.error).toBeUndefined();
    expect(job.ok).toBe(true);
    expect(job.version).toBe("1.2.3");
    expect(events.at(-1)).toBe("done");

    const shim = path.join(codersBinDir(), "codex");
    expect(fs.existsSync(shim)).toBe(true);
    expect(readManifest("codex")).toMatchObject({
      method: "npm",
      package: "@openai/codex",
      version: "1.2.3",
    });
    // No staging dirs left behind.
    expect(fs.readdirSync(codersRoot()).filter((d) => d.startsWith(".staging"))).toEqual([]);

    // bin-detect puts the managed dir first and resolves the shim with no restart.
    expect(enrichedPath().split(path.delimiter)[0]).toBe(codersBinDir());
    expect(resolveBin("codex")).toBe(shim);

    // Update is idempotent and swaps the version in.
    setFake(npmScript, { version: "2.0.0" });
    const up = startJob("codex", "update", { host });
    expect(up.ok).toBe(true);
    if (up.ok) expect((await up.done).version).toBe("2.0.0");

    // A failing update leaves the working install untouched (staged swap).
    setFake(npmScript, { fail: true, version: "3.0.0" });
    const bad = startJob("codex", "update", { host });
    if (bad.ok) {
      const j = await bad.done;
      expect(j.ok).toBe(false);
      // Failure output is redacted before it is kept for the UI.
      expect(j.log.join("\n")).not.toContain("sk-ant-abcdefghijklmnop");
    }
    setFake(npmScript, {});
    expect(readManifest("codex")?.version).toBe("2.0.0");
    expect(fs.existsSync(shim)).toBe(true);

    const rm = startJob("codex", "uninstall", { host });
    expect(rm.ok).toBe(true);
    if (rm.ok) expect((await rm.done).ok).toBe(true);
    expect(fs.existsSync(coderPrefix("codex"))).toBe(false);
    expect(fs.existsSync(shim)).toBe(false);
  });

  it("rejects unknown ids, concurrent jobs and quota overruns", async () => {
    const host = fakeHost(writeFakeNpm(fs.mkdtempSync(path.join(TMP, "npm-"))));
    expect(startJob("nope" as never, "install", { host })).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
    const first = startJob("codex", "install", { host });
    expect(startJob("codex", "install", { host })).toMatchObject({ ok: false, code: "BUSY" });
    if (first.ok) await first.done;

    process.env.INFINIBOT_CODERS_QUOTA_MB = "1";
    const q = startJob("claude-code", "install", { host });
    if (q.ok) {
      const j = await q.done;
      expect(j.ok).toBe(false);
      expect(j.error).toMatch(/quota/i);
    }
  });

  it("refuses to install in shared multi-tenant SaaS", () => {
    process.env.SAAS_MODE = "1";
    const host = fakeHost("/nonexistent");
    expect(startJob("codex", "install", { host })).toMatchObject({ ok: false, code: "POLICY" });
  });
});

// ── Keys ──────────────────────────────────────────────────────────────────

describe("BYOK keys", () => {
  it("stores per coder, injects only into that coder's env, clears", () => {
    setCoderKey("codex", "OPENAI_API_KEY", "sk-test-1234567890");
    setCoderKey("claude-code", "CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-abcdefghij");
    expect(coderKeyNames("codex")).toEqual(["OPENAI_API_KEY"]);
    expect(() => setCoderKey("codex", "PATH", "sk-test-1234567890")).toThrow();
    expect(() => setCoderKey("codex", "OPENAI_API_KEY", "short")).toThrow();
    expect(() => setCoderKey("codex", "OPENAI_API_KEY", "has space inside")).toThrow();

    const codexEnv = applyCoderSpawnEnv("codex", { OPENAI_API_KEY: "inherited" });
    expect(codexEnv.OPENAI_API_KEY).toBe("sk-test-1234567890");
    expect(codexEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    const ocEnv = applyCoderSpawnEnv("opencode", {});
    expect(ocEnv.OPENAI_API_KEY).toBeUndefined();
    expect(applyCoderSpawnEnv("claude-code", {}).CLAUDE_CODE_OAUTH_TOKEN).toBe(
      "sk-ant-oat01-abcdefghij",
    );

    // Profiles don't collide with model-provider auth.
    const store = JSON.parse(
      fs.readFileSync(path.join(process.env.INFINIBOT_AGENT_DIR!, "auth-profiles.json"), "utf8"),
    );
    for (const cred of Object.values(store.profiles) as Array<{ provider: string }>) {
      expect(cred.provider).toBe("coder-cli");
    }
    expect(clearCoderKey("codex")).toBe(1);
    expect(coderKeyNames("codex")).toEqual([]);
  });
});

// ── Redaction ─────────────────────────────────────────────────────────────

describe("redaction", () => {
  it("masks tokens and known secrets, strips ANSI/OSC links", () => {
    expect(redactSecrets("key sk-ant-oat01-AAAAAAAAAAAAAAAAAAAA ok")).not.toContain("AAAAAAAAAAAA");
    expect(redactSecrets("OPENAI_API_KEY=sk-proj-abcdefghijklmnop")).not.toContain(
      "abcdefghijklmnop",
    );
    expect(redactSecrets("value hunter2hunter2", ["hunter2hunter2"])).toBe("value ***");
    const osc =
      "\u001b]8;;https://x.test/a\u0007\u001b[94mhttps://x.test/a\u001b[39m\u001b]8;;\u0007";
    expect(cleanLogText(osc)).toBe("https://x.test/a");
  });
});

// ── Sign-in sessions ──────────────────────────────────────────────────────

const CODEX_OUT =
  "Welcome to Codex [v\u001b[90m0.158.0\u001b[0m]\r\n\r\n1. Open this link in your browser and sign in to your account\r\n   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m\r\n\r\n2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m\r\n   \u001b[94m3VL0-Z5RSP\u001b[0m\r\n";
const CLAUDE_OUT =
  "Opening browser to sign in…\r\nIf the browser didn't open, visit: \u001b]8;;https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz\u0007\u001b[94mhttps://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz\u001b[39m\u001b]8;;\u0007\r\nPaste code here if prompted > ";

describe("sign-in", () => {
  it("parses codex device-code and claude paste-code output", () => {
    expect(parseLoginOutput(CODEX_OUT)).toEqual({
      url: "https://auth.openai.com/codex/device",
      userCode: "3VL0-Z5RSP",
      needsCode: false,
    });
    const c = parseLoginOutput(CLAUDE_OUT);
    expect(c.url).toBe("https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz");
    expect(c.needsCode).toBe(true);
    expect(c.userCode).toBeUndefined();
  });

  it("runs a session over a fake PTY, forwards the code, scopes by tenant", async () => {
    // Put a fake claude on the managed PATH so startLogin can resolve it.
    const bin = codersBinDir();
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "claude"), "#!/bin/sh\n", { mode: 0o755 });
    let written = "";
    let exit: ((e: { exitCode: number }) => void) | null = null;
    let spawnedEnv: NodeJS.ProcessEnv = {};
    _setPtySpawner((_file, args, opts) => {
      expect(args).toEqual(["auth", "login"]);
      spawnedEnv = opts.env;
      let data: ((d: string) => void) | null = null;
      setTimeout(() => data?.(CLAUDE_OUT), 1);
      return {
        write: (d) => {
          written += d;
          setTimeout(() => exit?.({ exitCode: 0 }), 1);
        },
        kill: () => {},
        onData: (cb) => (data = cb),
        onExit: (cb) => (exit = cb),
      };
    });
    process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-leak-into-login";
    const res = await startLogin("claude-code");
    delete process.env.ANTHROPIC_API_KEY;
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(spawnedEnv.ANTHROPIC_API_KEY).toBeUndefined();
    await new Promise((r) => setTimeout(r, 10));
    const view = pollLogin(res.session.sessionId)!;
    expect(view.status).toBe("waiting");
    expect(view.needsCode).toBe(true);
    expect(view.url).toContain("claude.com/cai/oauth/authorize");

    // Another tenant can't see or drive it.
    expect(runWithUserId("tenant-z", () => pollLogin(res.session.sessionId))).toBeUndefined();
    expect(runWithUserId("tenant-z", () => submitLoginCode(res.session.sessionId, "x")).ok).toBe(
      false,
    );
    expect(submitLoginCode(res.session.sessionId, "bad\u0003code").ok).toBe(false);

    expect(submitLoginCode(res.session.sessionId, "  code#123  ").ok).toBe(true);
    expect(written).toBe("code#123\r");
    await new Promise((r) => setTimeout(r, 10));
    expect(pollLogin(res.session.sessionId)?.status).toBe("succeeded");
    expect(cancelLogin("nope")).toBe(false);
  });

  it("Gemini: answers its auth menu, skips the ToS link, finishes when oauth_creds.json appears", async () => {
    const home = fs.mkdtempSync(path.join(TMP, "gem-home-"));
    const savedHome = process.env.HOME;
    process.env.HOME = home;
    const bin = codersBinDir();
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "gemini"), "#!/bin/sh\n", { mode: 0o755 });
    let written = "";
    let data: ((d: string) => void) | null = null;
    let killed = false;
    _setPtySpawner((_file, args, opts) => {
      expect(args).toEqual(["--skip-trust"]);
      expect(opts.env.NO_BROWSER).toBe("true");
      setTimeout(
        () =>
          data?.(
            "│ How would you like to authenticate for this project? │\r\n│ ● 1. Sign in with Google │\r\n│ https://geminicli.com/docs/resources/tos-privacy/ │\r\n",
          ),
        1,
      );
      return {
        write: (d) => {
          written += d;
          if (d === "\r" && !written.includes("4/0Ab")) {
            setTimeout(
              () =>
                data?.(
                  "Please visit the following URL to authorize the application:\r\nhttps://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https%3A%2F%2Fcodeassist.google.com%2Fauthcode&code_challenge=x&state=y\r\nEnter the authorization code: ",
                ),
              1,
            );
          }
        },
        kill: () => {
          killed = true;
        },
        onData: (cb) => (data = cb),
        onExit: () => {},
      };
    });
    try {
      const res = await startLogin("gemini");
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      await new Promise((r) => setTimeout(r, 100));
      // Only the ToS link so far: nothing to open yet.
      expect(pollLogin(res.session.sessionId)?.url).toBeUndefined();
      await new Promise((r) => setTimeout(r, 500));
      expect(written).toBe("\r");
      const v = pollLogin(res.session.sessionId)!;
      expect(v.url).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
      expect(v.needsCode).toBe(true);
      expect(submitLoginCode(res.session.sessionId, "4/0AbCdEf").ok).toBe(true);
      // Gemini keeps running; the credential file is the success signal.
      fs.mkdirSync(path.join(home, ".gemini"), { recursive: true });
      fs.writeFileSync(path.join(home, ".gemini", "oauth_creds.json"), '{"refresh_token":"x"}');
      await new Promise((r) => setTimeout(r, 1700));
      expect(pollLogin(res.session.sessionId)?.status).toBe("succeeded");
      expect(killed).toBe(true);
    } finally {
      process.env.HOME = savedHome;
    }
  });

  it("refuses coders without browser sign-in or not installed", async () => {
    expect(await startLogin("aider")).toMatchObject({ ok: false, code: "UNSUPPORTED" });
    _setPtySpawner(() => {
      throw new Error("should not spawn");
    });
    const r = await startLogin("codex");
    if (!r.ok) expect(r.code).toBe("NOT_INSTALLED");
  });
});
