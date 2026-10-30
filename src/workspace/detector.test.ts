import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { detectWorkspace, planWorkspaceCommand } from "./detector.js";

const roots: string[] = [];
function fixture(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ib-workspace-detect-"));
  roots.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const pkg = (dependencies: Record<string, string>, scripts = { dev: "dev" }) =>
  JSON.stringify({ scripts, dependencies });

describe("detectWorkspace", () => {
  it.each([
    ["next", { next: "latest" }, 3000],
    ["vite", { vite: "latest", react: "latest" }, 5173],
    ["react-scripts", { "react-scripts": "latest" }, 3000],
    ["astro", { astro: "latest" }, 4321],
    ["sveltekit", { "@sveltejs/kit": "latest" }, 5173],
    ["nuxt", { nuxt: "latest" }, 3000],
    ["remix", { "@remix-run/dev": "latest" }, 3000],
    ["gatsby", { gatsby: "latest" }, 8000],
    ["expo-web", { expo: "latest" }, 8081],
  ] as const)("detects %s", (kind, deps, port) => {
    const root = fixture({ "package.json": pkg(deps), "pnpm-lock.yaml": "lockfileVersion: 9" });
    const result = detectWorkspace(root);
    expect(result.kind).toBe(kind);
    expect(result.packageManager).toBe("pnpm");
    expect(result.expectedPort).toBe(port);
    expect(result.devCmd).toBe("dev");
  });

  it("detects a plain static site", () => {
    const result = detectWorkspace(fixture({ "index.html": "<h1>hello</h1>" }));
    expect(result.kind).toBe("static");
    expect(result.command?.display).toContain("infinibot-static");
  });

  it.each([
    ["django", { "manage.py": "#!/usr/bin/env python3" }],
    ["flask", { "app.py": "from flask import Flask\napp = Flask(__name__)" }],
    ["fastapi", { "main.py": "from fastapi import FastAPI\napp = FastAPI()" }],
  ])("detects %s", (kind, files) => {
    expect(detectWorkspace(fixture(files)).kind).toBe(kind);
  });

  it("selects the strongest app in a monorepo and offers every candidate", () => {
    const root = fixture({
      "package.json": JSON.stringify({ private: true, workspaces: ["apps/*"] }),
      "pnpm-lock.yaml": "lockfileVersion: 9",
      "apps/docs/package.json": pkg({ astro: "latest" }),
      "apps/web/package.json": pkg({ next: "latest" }),
    });
    const result = detectWorkspace(root);
    expect(result.monorepo).toBe(true);
    expect(result.kind).toBe("next");
    expect(result.relativeAppPath).toBe("apps/web");
    expect(result.candidates.map((item) => item.relativePath)).toEqual(["apps/web", "apps/docs"]);
  });

  it("reads the node requirement and missing dependencies", () => {
    const root = fixture({
      "package.json": JSON.stringify({
        scripts: { dev: "vite" },
        dependencies: { vite: "latest" },
        engines: { node: ">=22" },
      }),
      ".nvmrc": "22.23.1",
    });
    const result = detectWorkspace(root);
    expect(result.nodeVersion).toBe("22.23.1");
    expect(result.missingDependencies).toBe(true);
    expect(result.installCmd).toBe("npm install");
  });
});

describe("planWorkspaceCommand", () => {
  it("maps framework-specific port arguments", () => {
    const next = planWorkspaceCommand(
      { kind: "next", packageManager: "pnpm", devCmd: "dev", appPath: "/tmp/x" },
      4100,
      "/p/",
    );
    expect(next?.args).toEqual(["run", "dev", "-H", "127.0.0.1", "-p", "4100"]);
    const vite = planWorkspaceCommand(
      { kind: "vite", packageManager: "npm", devCmd: "dev", appPath: "/tmp/x" },
      4101,
      "/p/",
    );
    expect(vite?.args).toEqual([
      "run",
      "dev",
      "--",
      "--host",
      "127.0.0.1",
      "--port",
      "4101",
      "--base",
      "/p/",
    ]);
    const cra = planWorkspaceCommand(
      { kind: "react-scripts", packageManager: "yarn", devCmd: "start", appPath: "/tmp/x" },
      4102,
      "/p/",
    );
    expect(cra?.env).toMatchObject({ HOST: "127.0.0.1", PORT: "4102" });
  });

  it("starts Expo web with --port and CI=1 (Expo has no --non-interactive flag)", () => {
    const expo = planWorkspaceCommand(
      { kind: "expo-web", packageManager: "npm", devCmd: "start", appPath: "/tmp/x" },
      8082,
      "/p/",
    );
    expect(expo?.args).toEqual(["run", "start", "--", "--web", "--port", "8082"]);
    expect(expo?.args).not.toContain("--non-interactive");
    expect(expo?.env).toMatchObject({ CI: "1" });
  });

  it("only uses npm's script-argument separator", () => {
    for (const manager of ["pnpm", "yarn", "bun"] as const) {
      const command = planWorkspaceCommand(
        { kind: "vite", packageManager: manager, devCmd: "dev", appPath: "/tmp/x" },
        4300,
        "/preview/",
      );
      expect(command?.args).toEqual([
        "run",
        "dev",
        "--host",
        "127.0.0.1",
        "--port",
        "4300",
        "--base",
        "/preview/",
      ]);
    }
  });
});
