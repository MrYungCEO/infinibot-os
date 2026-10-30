import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import * as tar from "tar";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  _resetJobs,
  buildShim,
  detectHostTools,
  detectNpm,
  explainNpmFailure,
  planInstall,
  readManifest,
  runProcess,
  startJob,
  type HostTools,
} from "./installer.js";
import { getCoderEntry } from "./catalog.js";
import {
  _resetNodeRuntime,
  ensureNodeRuntime,
  findNodeRuntime,
  nodeDistArtifact,
  type RuntimeProbe,
} from "./node-runtime.js";
import { resolveCmdShimTarget } from "../../process/win-spawn.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ib-node-runtime-test-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));
beforeEach(() => {
  _resetNodeRuntime();
  _resetJobs();
});

/** A fake machine: files that exist, binaries on PATH, node versions. */
function machine(
  over: Partial<RuntimeProbe> & {
    files?: string[];
    path?: Record<string, string>;
    nodes?: Record<string, string>;
  },
): RuntimeProbe {
  const files = new Set(over.files ?? []);
  return {
    platform: over.platform ?? "linux",
    arch: over.arch ?? "x64",
    execPath: over.execPath ?? "/usr/bin/node",
    versions: over.versions ?? { node: "22.1.0" },
    env: over.env ?? { INFINIBOT_CODERS_DIR: path.join(TMP, "none") },
    exists: (p) => files.has(p),
    which: (bin) => over.path?.[bin],
    nodeVersion: (n) => over.nodes?.[n] ?? null,
    realpath: (p) => p,
  };
}

describe("detectNpm / findNodeRuntime", () => {
  it("Windows desktop app with npm.cmd on PATH: runs node.exe + npm-cli.js, never npm.cmd", () => {
    const node = "C:\\Program Files\\nodejs\\node.exe";
    const cli = "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";
    const probe = machine({
      platform: "win32",
      execPath: "C:\\Users\\a\\AppData\\Local\\Programs\\InfiniBot\\InfiniBot.exe",
      versions: { node: "22.0.0", electron: "35.0.0" },
      files: [cli],
      path: { node, npm: "C:\\Program Files\\nodejs\\npm.cmd" },
      nodes: { [node]: "v22.11.0" },
    });
    const npm = detectNpm(probe);
    expect(npm).toEqual({ command: node, args: [cli] });
    expect(npm?.command).not.toMatch(/\.cmd$/i);
    expect(detectHostTools(probe)).toMatchObject({ node, canFetchNode: false });
  });

  it("Electron execPath is never used as node, even with npm-cli.js beside it", () => {
    const exe = "/tmp/.mount_InfiniX/infinibot-desktop";
    const probe = machine({
      execPath: exe,
      versions: { node: "22.0.0", electron: "35.0.0" },
      files: [
        path.posix.join(
          "/tmp/.mount_InfiniX",
          "..",
          "lib",
          "node_modules",
          "npm",
          "bin",
          "npm-cli.js",
        ),
      ],
    });
    expect(findNodeRuntime(probe)).toBeNull();
    const host = detectHostTools(probe);
    expect(host.npm).toBeNull();
    expect(host.node).toBe("");
    // No Node on the machine → InfiniBot downloads its own; the card is installable.
    expect(host.canFetchNode).toBe(true);
    expect(planInstall(getCoderEntry("gemini")!, host)).toMatchObject({ ok: true });
  });

  it("no npm anywhere and no Node build for this OS → plain message, no exit code", () => {
    const probe = machine({ platform: "aix" as NodeJS.Platform, versions: { electron: "35" } });
    const host = detectHostTools(probe);
    expect(host.canFetchNode).toBe(false);
    const plan = planInstall(getCoderEntry("gemini")!, host);
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.message).toMatch(/Install Node.js 20 or newer from https:\/\/nodejs.org/);
      expect(plan.message).not.toMatch(/exit/);
    }
  });

  it("npm / web install: the gateway's own node + its npm", () => {
    const cli = "/opt/node/lib/node_modules/npm/bin/npm-cli.js";
    const probe = machine({ execPath: "/opt/node/bin/node", files: [cli] });
    expect(findNodeRuntime(probe)).toMatchObject({
      node: "/opt/node/bin/node",
      npmCli: cli,
      source: "gateway",
    });
  });

  it("system node older than 20 is skipped; Unix npm symlink resolves to npm-cli.js", () => {
    const old = machine({
      versions: { electron: "35" },
      execPath: "/app/infinibot",
      path: { node: "/usr/bin/node", npm: "/usr/bin/npm" },
      nodes: { "/usr/bin/node": "v18.19.0" },
    });
    expect(findNodeRuntime(old)).toBeNull();
    const ok = machine({
      versions: { electron: "35" },
      execPath: "/app/infinibot",
      path: { node: "/usr/bin/node", npm: "/usr/bin/npm" },
      nodes: { "/usr/bin/node": "v20.11.0" },
    });
    ok.realpath = (p) => (p === "/usr/bin/npm" ? "/usr/lib/node_modules/npm/bin/npm-cli.js" : p);
    expect(findNodeRuntime(ok)).toMatchObject({
      node: "/usr/bin/node",
      npmCli: "/usr/lib/node_modules/npm/bin/npm-cli.js",
      source: "system",
    });
  });

  it("INFINIBOT_CODERS_NODE=managed ignores the gateway and system node", () => {
    const cli = "/opt/node/lib/node_modules/npm/bin/npm-cli.js";
    const probe = machine({
      execPath: "/opt/node/bin/node",
      files: [cli],
      path: { node: "/opt/node/bin/node" },
      nodes: { "/opt/node/bin/node": "v22.0.0" },
      env: { INFINIBOT_CODERS_DIR: path.join(TMP, "none"), INFINIBOT_CODERS_NODE: "managed" },
    });
    expect(findNodeRuntime(probe)).toBeNull();
  });

  it("maps every desktop platform to an official Node build", () => {
    expect(nodeDistArtifact("v22.1.0", "win32", "x64")).toMatchObject({
      file: "node-v22.1.0-win-x64.zip",
      kind: "zip",
    });
    expect(nodeDistArtifact("v22.1.0", "linux", "x64")).toMatchObject({
      file: "node-v22.1.0-linux-x64.tar.gz",
    });
    expect(nodeDistArtifact("v22.1.0", "darwin", "arm64")).toMatchObject({
      file: "node-v22.1.0-darwin-arm64.tar.gz",
    });
    expect(nodeDistArtifact("v22.1.0", "linux", "ia32")).toBeNull();
  });
});

describe("runProcess / errors", () => {
  it("a process that can't start reports the reason, and the message has no 'exit -1'", async () => {
    const res = await runProcess(path.join(TMP, "does-not-exist"), ["--version"], {
      env: { PATH: "/usr/bin:/bin" },
      timeoutMs: 5000,
    });
    expect(res.code).toBe(-1);
    expect(res.spawnError).toBe("ENOENT");
    const msg = explainNpmFailure("Gemini CLI", res);
    expect(msg).toMatch(
      /couldn't start the installer for Gemini CLI \(ENOENT\)\. Click Try again\./,
    );
    expect(msg).not.toMatch(/exit -1/);
  });

  it("explains network, disk, permission and generic npm failures in plain words", () => {
    const mk = (output: string, code = 1) => explainNpmFailure("Codex CLI", { code, output });
    expect(
      mk("npm ERR! code ENOTFOUND\nnpm ERR! getaddrinfo ENOTFOUND registry.npmjs.org"),
    ).toMatch(/couldn't reach the download server/);
    expect(mk("npm ERR! code ENOSPC")).toMatch(/ran out of disk space/);
    expect(mk("npm ERR! code EPERM\nnpm ERR! operation not permitted")).toMatch(
      /permission denied/,
    );
    expect(mk("npm ERR! 404 Not Found - GET https://registry.npmjs.org/x")).toMatch(
      /^Installing Codex CLI failed: 404 Not Found/,
    );
    expect(explainNpmFailure("X", { code: null, output: "", timedOut: true })).toMatch(
      /took too long/,
    );
  });
});

describe("shims", () => {
  it("Windows .cmd shim is read back by spawnCli as node.exe + script (no cmd.exe, no EINVAL)", () => {
    const dir = fs.mkdtempSync(path.join(TMP, "shim-"));
    const script = path.join(dir, "gemini.js");
    fs.writeFileSync(script, "#!/usr/bin/env node\nconsole.log('x')\n");
    const node = path.join(dir, "node.exe");
    fs.writeFileSync(node, "");
    const body = buildShim(script, node, "win32");
    expect(body).toBe(`@echo off\r\n"${node}" "${script}" %*\r\n`);
    const shim = path.join(dir, "gemini.cmd");
    fs.writeFileSync(shim, body);
    expect(resolveCmdShimTarget(shim)).toEqual({ command: node, prefixArgs: [script] });
  });

  it("native binaries never get an empty or Electron NODE_BIN", () => {
    const dir = fs.mkdtempSync(path.join(TMP, "shim-"));
    const exe = path.join(dir, "grok");
    fs.writeFileSync(exe, "\x7fELF");
    const body = buildShim(exe, "", "linux");
    expect(body).not.toMatch(/NODE_BIN/);
    expect(body).toMatch(/exec '.*\/grok' "\$@"/);
  });
});

// ── Download + install on a machine with no Node (local fake nodejs.org) ────

async function fakeNodeDist(
  version: string,
): Promise<{ url: string; close: () => Promise<void>; hits: string[] }> {
  const art = nodeDistArtifact(version, process.platform, process.arch)!;
  const top = art.file.replace(/\.tar\.gz$/, "");
  const src = fs.mkdtempSync(path.join(TMP, "dist-src-"));
  const root = path.join(src, top);
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.mkdirSync(path.join(root, "lib", "node_modules", "npm", "bin"), { recursive: true });
  // "node" = the test's real node (so npm-cli.js and the CLI really run).
  fs.writeFileSync(path.join(root, "bin", "node"), `#!/bin/sh\nexec '${process.execPath}' "$@"\n`, {
    mode: 0o755,
  });
  // Fake npm: `install --global --prefix <p> ... <pkg>@<v>` lays out the package.
  fs.writeFileSync(
    path.join(root, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    `const fs=require("fs"),path=require("path");const a=process.argv.slice(2);
const prefix=a[a.indexOf("--prefix")+1];const spec=a[a.length-1];const pkg=spec.slice(0,spec.lastIndexOf("@"));
const dir=path.join(prefix,"lib","node_modules",pkg);fs.mkdirSync(path.join(dir,"bin"),{recursive:true});
fs.writeFileSync(path.join(dir,"package.json"),JSON.stringify({name:pkg,version:"7.7.7",bin:{gemini:"bin/cli.js"}}));
fs.writeFileSync(path.join(dir,"bin","cli.js"),"#!/usr/bin/env node\\nconsole.log('gemini 7.7.7 on '+process.version)\\n");
console.log("added 1 package");`,
  );
  const tgz = path.join(src, art.file);
  await tar.c({ gzip: true, file: tgz, cwd: src, portable: true }, [top]);
  const body = fs.readFileSync(tgz);
  const sha = createHash("sha256").update(body).digest("hex");
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? "");
    if (req.url === "/index.json") {
      res.end(JSON.stringify([{ version, files: [art.indexKey] }]));
    } else if (req.url === `/${version}/SHASUMS256.txt`) {
      res.end(`${sha}  ${art.file}\n`);
    } else if (req.url === `/${version}/${art.file}`) {
      res.end(body);
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

describe.runIf(process.platform === "linux" || process.platform === "darwin")(
  "clean machine (no Node)",
  () => {
    it("downloads a checksum-verified private Node, installs the coder on it, shim runs that node", async () => {
      const dist = await fakeNodeDist("v22.99.1");
      const coders = fs.mkdtempSync(path.join(TMP, "coders-"));
      const env = {
        ...process.env,
        INFINIBOT_CODERS_DIR: coders,
        INFINIBOT_NODE_DIST_URL: dist.url,
        INFINIBOT_CODERS_NODE: "managed",
      };
      try {
        const host: HostTools = {
          npm: null,
          uv: null,
          pipx: null,
          node: "",
          nodeVersion: "",
          canFetchNode: true,
        };
        const r = startJob("gemini", "install", { host, env });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const job = await r.done;
        expect(job.error).toBeUndefined();
        expect(job.ok).toBe(true);
        expect(job.log.join("\n")).toMatch(/downloading its own copy/);
        expect(dist.hits).toContain("/v22.99.1/SHASUMS256.txt");

        const managedNode = path.join(
          coders,
          ".node",
          "node-v22.99.1-" +
            `${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch}`,
          "bin",
          "node",
        );
        expect(fs.existsSync(managedNode)).toBe(true);
        expect(readManifest("gemini", env)).toMatchObject({ method: "npm", version: "7.7.7" });
        const shim = fs.readFileSync(path.join(coders, "bin", "gemini"), "utf8");
        expect(shim).toContain(`NODE_BIN='${managedNode}'`);

        // The managed runtime is found next time without downloading again.
        expect(
          findNodeRuntime({ ...(await import("./node-runtime.js")).defaultProbe(env) }),
        ).toMatchObject({
          source: "managed",
          node: managedNode,
        });
        const before = dist.hits.length;
        await ensureNodeRuntime({ env });
        expect(dist.hits.length).toBe(before);
      } finally {
        await dist.close();
      }
    });

    it("a tampered download is refused with a plain message", async () => {
      const dist = await fakeNodeDist("v22.99.2");
      const coders = fs.mkdtempSync(path.join(TMP, "coders-"));
      // Serve a wrong checksum.
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const u = String(input);
        if (u.endsWith("SHASUMS256.txt")) {
          const art = nodeDistArtifact("v22.99.2", process.platform, process.arch)!;
          return new Response(`${"0".repeat(64)}  ${art.file}\n`);
        }
        return realFetch(input, init);
      }) as typeof fetch;
      try {
        await expect(
          ensureNodeRuntime({
            env: {
              INFINIBOT_CODERS_DIR: coders,
              INFINIBOT_NODE_DIST_URL: dist.url,
              INFINIBOT_CODERS_NODE: "managed",
            },
          }),
        ).rejects.toThrow(/didn't match its published checksum/);
        expect(fs.existsSync(path.join(coders, ".node", "runtime.json"))).toBe(false);
      } finally {
        globalThis.fetch = realFetch;
        await dist.close();
      }
    });

    it("offline: says to check the connection or install Node.js, never an exit code", async () => {
      const coders = fs.mkdtempSync(path.join(TMP, "coders-"));
      await expect(
        ensureNodeRuntime({
          env: {
            INFINIBOT_CODERS_DIR: coders,
            INFINIBOT_NODE_DIST_URL: "http://127.0.0.1:9",
            INFINIBOT_CODERS_NODE: "managed",
          },
        }),
      ).rejects.toThrow(/couldn't download Node.js.*Check your internet connection.*nodejs.org/);
    });
  },
);
