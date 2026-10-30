import fs from "node:fs";
import path from "node:path";

import type {
  WorkspaceAppCandidate,
  WorkspaceCommand,
  WorkspaceDetection,
  WorkspaceFrameworkKind,
  WorkspacePackageManager,
} from "./types.js";

type PackageJson = {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
  engines?: { node?: string };
};

const FRAMEWORKS: Array<{
  kind: WorkspaceFrameworkKind;
  deps: string[];
  port: number;
  flag: string | null;
  confidence: number;
}> = [
  { kind: "next", deps: ["next"], port: 3000, flag: "-p", confidence: 0.995 },
  { kind: "sveltekit", deps: ["@sveltejs/kit"], port: 5173, flag: "--port", confidence: 0.99 },
  { kind: "astro", deps: ["astro"], port: 4321, flag: "--port", confidence: 0.99 },
  { kind: "nuxt", deps: ["nuxt", "nuxt3"], port: 3000, flag: "--port", confidence: 0.98 },
  { kind: "remix", deps: ["@remix-run/dev"], port: 3000, flag: "--port", confidence: 0.96 },
  { kind: "gatsby", deps: ["gatsby"], port: 8000, flag: "-p", confidence: 0.97 },
  { kind: "expo-web", deps: ["expo"], port: 8081, flag: "--port", confidence: 0.94 },
  { kind: "react-scripts", deps: ["react-scripts"], port: 3000, flag: null, confidence: 0.98 },
  { kind: "vite", deps: ["vite"], port: 5173, flag: "--port", confidence: 0.97 },
];

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function allDeps(pkg: PackageJson): Set<string> {
  return new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ]);
}

function classifyPackage(pkg: PackageJson): { kind: WorkspaceFrameworkKind; confidence: number } {
  const deps = allDeps(pkg);
  for (const framework of FRAMEWORKS) {
    if (framework.deps.some((name) => deps.has(name))) {
      return { kind: framework.kind, confidence: framework.confidence };
    }
  }
  if (pkg.scripts?.dev || pkg.scripts?.start || pkg.scripts?.preview) {
    return { kind: "node", confidence: 0.68 };
  }
  return { kind: "unknown", confidence: 0.2 };
}

function expandSimpleWorkspacePatterns(root: string, patterns: string[]): string[] {
  const out = new Set<string>();
  for (const pattern of patterns) {
    const normalized = pattern.replace(/\\/g, "/").replace(/\/$/, "");
    if (!normalized || normalized.startsWith("!") || normalized.includes("**")) continue;
    const star = normalized.indexOf("*");
    if (star === -1) {
      const abs = path.resolve(root, normalized);
      if (fs.existsSync(path.join(abs, "package.json"))) out.add(abs);
      continue;
    }
    const parentRel = normalized.slice(0, star).replace(/\/$/, "");
    const suffix = normalized.slice(star + 1).replace(/^\//, "");
    const parent = path.resolve(root, parentRel || ".");
    let names: fs.Dirent[] = [];
    try {
      names = fs.readdirSync(parent, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of names) {
      if (!entry.isDirectory()) continue;
      const abs = path.join(parent, entry.name, suffix);
      if (fs.existsSync(path.join(abs, "package.json"))) out.add(abs);
    }
  }
  return [...out];
}

function workspacePatterns(root: string, pkg: PackageJson | null): string[] {
  const fromPkg = Array.isArray(pkg?.workspaces)
    ? pkg.workspaces
    : Array.isArray(pkg?.workspaces?.packages)
      ? pkg.workspaces.packages
      : [];
  const pnpmFile = path.join(root, "pnpm-workspace.yaml");
  if (!fs.existsSync(pnpmFile)) return [...fromPkg];
  try {
    const raw = fs.readFileSync(pnpmFile, "utf8");
    const yamlPatterns = [...raw.matchAll(/^\s*-\s*["']?([^"'#\n]+)["']?\s*$/gm)].map((m) =>
      m[1]!.trim(),
    );
    return [...fromPkg, ...yamlPatterns];
  } catch {
    return [...fromPkg];
  }
}

function packageManagerFor(root: string, appPath: string): WorkspacePackageManager {
  for (const dir of [root, appPath]) {
    if (fs.existsSync(path.join(dir, "pnpm-lock.yaml"))) return "pnpm";
    if (fs.existsSync(path.join(dir, "bun.lockb")) || fs.existsSync(path.join(dir, "bun.lock")))
      return "bun";
    if (fs.existsSync(path.join(dir, "yarn.lock"))) return "yarn";
    if (fs.existsSync(path.join(dir, "package-lock.json"))) return "npm";
  }
  return "npm";
}

/**
 * The framework's conventional dev port. This is only a *preference*: the
 * dev-server manager always bind-probes it (and walks upward) before use,
 * because hosts routinely hold these ports (e.g. `tailscale serve` on 8081).
 */
export function defaultPort(kind: WorkspaceFrameworkKind): number {
  return FRAMEWORKS.find((item) => item.kind === kind)?.port ?? (kind === "flask" ? 5000 : 3000);
}

function portFlag(kind: WorkspaceFrameworkKind): string | null {
  return FRAMEWORKS.find((item) => item.kind === kind)?.flag ?? null;
}

function nodeVersion(root: string, appPath: string, pkg: PackageJson | null): string | null {
  for (const dir of [appPath, root]) {
    for (const file of [".nvmrc", ".node-version"]) {
      try {
        const value = fs.readFileSync(path.join(dir, file), "utf8").trim();
        if (value) return value;
      } catch {}
    }
  }
  return pkg?.engines?.node ?? null;
}

function packageCommand(
  manager: WorkspacePackageManager,
  script: string,
  kind: WorkspaceFrameworkKind,
  port: number,
  prefix: string,
): WorkspaceCommand {
  const command =
    manager === "yarn" ? "yarn" : manager === "bun" ? "bun" : manager === "pnpm" ? "pnpm" : "npm";
  const args = ["run", script];
  // npm consumes `--` as its script/argument separator. pnpm, Yarn and Bun
  // forward subsequent arguments directly; adding the npm separator there
  // reaches the framework as a literal positional `--` and silently disables
  // Vite/Next host, port and base-path flags.
  const scriptArgs = manager === "npm" ? ["--"] : [];
  const env: Record<string, string> = {};
  if (kind === "react-scripts") {
    env.HOST = "127.0.0.1";
    env.PORT = String(port);
    // CRA otherwise prompts "Would you like to run the app on another port
    // instead?" when the port is taken and tries to open a browser.
    env.BROWSER = "none";
  } else if (kind === "next") {
    args.push(...scriptArgs, "-H", "127.0.0.1", "-p", String(port));
  } else if (kind === "gatsby") {
    args.push(...scriptArgs, "-H", "127.0.0.1", "-p", String(port));
  } else if (kind === "expo-web") {
    // Expo CLI has no `--non-interactive` flag (it errors on unknown
    // options); non-interactive mode is selected with CI=1, which also makes
    // Expo fail fast with "Port N is being used by another process" instead
    // of prompting for another port.
    args.push(...scriptArgs, "--web", "--port", String(port));
    env.CI = "1";
  } else {
    args.push(...scriptArgs, "--host", "127.0.0.1", "--port", String(port));
    if (["vite", "sveltekit", "astro"].includes(kind)) args.push("--base", prefix);
  }
  return { command, args, env, display: [command, ...args].join(" ") };
}

export function planWorkspaceCommand(
  detection: Pick<WorkspaceDetection, "kind" | "packageManager" | "devCmd" | "appPath">,
  port: number,
  prefix: string,
): WorkspaceCommand | null {
  if (detection.kind === "static") {
    return {
      command: process.execPath,
      args: ["__INFINIBOT_STATIC_SERVER__", detection.appPath, String(port)],
      env: {},
      display: `infinibot-static --host 127.0.0.1 --port ${port}`,
    };
  }
  if (detection.kind === "django") {
    return {
      command: "python3",
      args: ["manage.py", "runserver", `127.0.0.1:${port}`],
      env: {},
      display: `python3 manage.py runserver 127.0.0.1:${port}`,
    };
  }
  if (detection.kind === "flask") {
    return {
      command: "python3",
      args: ["-m", "flask", "run", "--host", "127.0.0.1", "--port", String(port)],
      env: {},
      display: `python3 -m flask run --host 127.0.0.1 --port ${port}`,
    };
  }
  if (detection.kind === "fastapi") {
    return {
      command: "python3",
      args: [
        "-m",
        "uvicorn",
        "main:app",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--reload",
      ],
      env: {},
      display: `python3 -m uvicorn main:app --host 127.0.0.1 --port ${port} --reload`,
    };
  }
  if (
    !detection.devCmd ||
    detection.packageManager === "none" ||
    detection.packageManager === "python"
  )
    return null;
  return packageCommand(detection.packageManager, detection.devCmd, detection.kind, port, prefix);
}

function detectPython(
  root: string,
): { kind: WorkspaceFrameworkKind; confidence: number; hints: string[] } | null {
  if (fs.existsSync(path.join(root, "manage.py")))
    return {
      kind: "django",
      confidence: 0.98,
      hints: ["Django settings/module environment may be required"],
    };
  let corpus = "";
  for (const file of ["requirements.txt", "pyproject.toml", "Pipfile", "app.py", "main.py"]) {
    try {
      corpus += `\n${fs.readFileSync(path.join(root, file), "utf8")}`;
    } catch {}
  }
  if (/fastapi|from\s+fastapi/i.test(corpus))
    return {
      kind: "fastapi",
      confidence: 0.94,
      hints: ["Detected ASGI app as main:app; adjust if the module differs"],
    };
  if (/flask|from\s+flask/i.test(corpus))
    return {
      kind: "flask",
      confidence: 0.94,
      hints: ["Set FLASK_APP if the application is not app.py"],
    };
  return null;
}

export function detectWorkspace(
  rootInput: string,
  opts: { appPath?: string; port?: number; previewPrefix?: string } = {},
): WorkspaceDetection {
  const root = path.resolve(rootInput);
  const rootPkg = readJson<PackageJson>(path.join(root, "package.json"));
  const patterns = workspacePatterns(root, rootPkg);
  const packageDirs = [root, ...expandSimpleWorkspacePatterns(root, patterns)];
  const candidates: WorkspaceAppCandidate[] = [];
  for (const dir of packageDirs) {
    const pkg = readJson<PackageJson>(path.join(dir, "package.json"));
    if (!pkg) continue;
    const classified = classifyPackage(pkg);
    if (dir !== root || classified.kind !== "unknown") {
      candidates.push({
        path: dir,
        relativePath: path.relative(root, dir) || ".",
        name: pkg.name || path.basename(dir),
        kind: classified.kind,
        confidence: classified.confidence,
      });
    }
  }
  candidates.sort(
    (a, b) => b.confidence - a.confidence || a.relativePath.localeCompare(b.relativePath),
  );
  let appPath = opts.appPath ? path.resolve(root, opts.appPath) : (candidates[0]?.path ?? root);
  if (appPath !== root && !appPath.startsWith(root + path.sep)) appPath = root;
  let pkg = readJson<PackageJson>(path.join(appPath, "package.json"));
  let classified = pkg
    ? classifyPackage(pkg)
    : { kind: "unknown" as WorkspaceFrameworkKind, confidence: 0.2 };
  const python = detectPython(appPath);
  if (python && classified.kind === "unknown") classified = python;
  if (classified.kind === "unknown" && fs.existsSync(path.join(appPath, "index.html"))) {
    classified = { kind: "static", confidence: 0.96 };
  }
  const kind = classified.kind;
  const manager: WorkspacePackageManager = python
    ? "python"
    : pkg
      ? packageManagerFor(root, appPath)
      : "none";
  const script = pkg?.scripts?.dev
    ? "dev"
    : pkg?.scripts?.start
      ? "start"
      : pkg?.scripts?.preview
        ? "preview"
        : null;
  const expectedPort = opts.port ?? defaultPort(kind);
  const previewPrefix = opts.previewPrefix ?? "/api/workspace/dev/project/";
  const command = planWorkspaceCommand(
    { kind, packageManager: manager, devCmd: script, appPath },
    expectedPort,
    previewPrefix,
  );
  const installCmd = pkg
    ? manager === "yarn"
      ? "yarn install"
      : manager === "bun"
        ? "bun install"
        : manager === "pnpm"
          ? "pnpm install"
          : "npm install"
    : python
      ? "python3 -m pip install -r requirements.txt"
      : null;
  const reasons = [
    kind === "static" ? "index.html found with no package runtime" : `${kind} markers detected`,
    patterns.length > 0
      ? `workspace packages discovered from ${patterns.join(", ")}`
      : "single-package project",
  ];
  return {
    root,
    appPath,
    relativeAppPath: path.relative(root, appPath) || ".",
    kind,
    packageManager: manager,
    installCmd,
    devCmd: script,
    command,
    expectedPort,
    portFlag: portFlag(kind),
    envHints: [
      ...(python?.hints ?? []),
      ...(nodeVersion(root, appPath, pkg)
        ? [`Node requirement: ${nodeVersion(root, appPath, pkg)}`]
        : []),
      ...(!script && pkg ? ["No dev/start/preview script found"] : []),
    ],
    confidence: classified.confidence,
    missingDependencies: Boolean(
      pkg &&
      !fs.existsSync(path.join(appPath, "node_modules")) &&
      !fs.existsSync(path.join(root, "node_modules")),
    ),
    nodeVersion: nodeVersion(root, appPath, pkg),
    monorepo: patterns.length > 0 || candidates.filter((item) => item.path !== root).length > 0,
    candidates,
    reasons,
  };
}
