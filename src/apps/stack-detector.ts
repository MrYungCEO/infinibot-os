/**
 * Stack Detector — inspects a repo on disk and emits a normalized
 * {@link StackManifest}.
 *
 * It parses manifests across ecosystems (npm/pnpm/yarn/bun, pip/poetry,
 * go modules, cargo, bundler, composer), Dockerfile/compose, infra/hosting
 * config files, and `.env*` files (env var NAMES only — never values), then
 * maps everything onto the canonical {@link PlatformId} registry.
 *
 * Pure + dependency-light: only Node's `fs`/`path`. It never executes repo
 * code and never installs anything. Owned by the repo-attach / detection
 * stream alongside {@link ./stack-manifest.ts}.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import {
  type Confidence,
  type PlatformId,
  PLATFORM_REGISTRY,
  resolvePlatformId,
  type StackEdge,
  type StackManifest,
  type StackNode,
  type StackRelation,
  STACK_MANIFEST_VERSION,
} from "./stack-manifest.js";

// ═══════════════════════════════════════════════════════════════════
// DEPENDENCY → PLATFORM MAPS
// ═══════════════════════════════════════════════════════════════════

/**
 * npm package name -> canonical platformId. Only names that aren't already
 * resolvable via the registry's own slug/aliases need an entry here.
 */
const NPM_DEP_MAP: Record<string, PlatformId> = {
  next: "nextjs",
  react: "react",
  "react-dom": "react",
  "react-native": "reactnative",
  expo: "expo",
  vue: "vue",
  nuxt: "nuxt",
  svelte: "svelte",
  "@sveltejs/kit": "sveltekit",
  "@angular/core": "angular",
  "solid-js": "solid",
  astro: "astro",
  "@remix-run/react": "remix",
  vite: "vite",
  express: "express",
  fastify: "fastify",
  "@nestjs/core": "nestjs",
  electron: "electron",
  "@tauri-apps/api": "tauri",
  lit: "lit",
  // databases / ORMs
  pg: "postgresql",
  postgres: "postgresql",
  mysql: "mysql",
  mysql2: "mysql",
  "better-sqlite3": "sqlite",
  sqlite3: "sqlite",
  mongoose: "mongodb",
  mongodb: "mongodb",
  redis: "redis",
  ioredis: "redis",
  "@prisma/client": "prisma",
  prisma: "prisma",
  "drizzle-orm": "drizzle",
  typeorm: "typeorm",
  sequelize: "sequelize",
  "@elastic/elasticsearch": "elasticsearch",
  // services
  "@supabase/supabase-js": "supabase",
  "firebase-admin": "firebase",
  firebase: "firebase",
  stripe: "stripe",
  "@clerk/nextjs": "clerk",
  "@clerk/clerk-sdk-node": "clerk",
  "@clerk/clerk-react": "clerk",
  auth0: "auth0",
  "@auth0/auth0-react": "auth0",
  openai: "openai",
  "@anthropic-ai/sdk": "anthropic",
  "@sentry/node": "sentry",
  "@sentry/react": "sentry",
  twilio: "twilio",
  "@sendgrid/mail": "sendgrid",
  resend: "resend",
  algoliasearch: "algolia",
  // tooling
  webpack: "webpack",
  esbuild: "esbuild",
  turbo: "turbo",
  tailwindcss: "tailwind",
  jest: "jest",
  vitest: "vitest",
  "@playwright/test": "playwright",
  eslint: "eslint",
  wrangler: "cloudflare",
};

/** Python distribution name -> platformId. */
const PY_DEP_MAP: Record<string, PlatformId> = {
  fastapi: "fastapi",
  django: "django",
  flask: "flask",
  psycopg2: "postgresql",
  "psycopg2-binary": "postgresql",
  psycopg: "postgresql",
  asyncpg: "postgresql",
  pymysql: "mysql",
  pymongo: "mongodb",
  redis: "redis",
  sqlalchemy: "sqlalchemy",
  elasticsearch: "elasticsearch",
  openai: "openai",
  anthropic: "anthropic",
  stripe: "stripe",
  boto3: "aws",
  "sentry-sdk": "sentry",
};

/** Go module path fragment -> platformId. */
const GO_DEP_MAP: Record<string, PlatformId> = {
  "github.com/gin-gonic/gin": "gin",
  "github.com/lib/pq": "postgresql",
  "github.com/jackc/pgx": "postgresql",
  "go.mongodb.org/mongo-driver": "mongodb",
  "github.com/go-redis/redis": "redis",
  "github.com/redis/go-redis": "redis",
};

/** Cargo crate -> platformId. */
const CARGO_DEP_MAP: Record<string, PlatformId> = {
  "actix-web": "actix",
  axum: "axum",
  tokio: "rust",
  sqlx: "postgresql",
  "tokio-postgres": "postgresql",
  redis: "redis",
};

/** Ruby gem -> platformId. */
const GEM_DEP_MAP: Record<string, PlatformId> = {
  rails: "rails",
  pg: "postgresql",
  mysql2: "mysql",
  redis: "redis",
  mongoid: "mongodb",
};

/** PHP composer package -> platformId. */
const COMPOSER_DEP_MAP: Record<string, PlatformId> = {
  "laravel/framework": "laravel",
};

// ═══════════════════════════════════════════════════════════════════
// MANIFEST BUILDER
// ═══════════════════════════════════════════════════════════════════

/** Accumulates nodes/edges with dedupe + provenance merging. */
class ManifestBuilder {
  private nodes = new Map<string, StackNode>();
  private edges: StackEdge[] = [];
  private edgeKeys = new Set<string>();
  readonly envVars = new Set<string>();
  readonly notes: string[] = [];

  /** Add or merge a node keyed by platformId (or explicit id). */
  add(
    platformId: PlatformId | null,
    detectedFrom: string,
    opts: { id?: string; label?: string; confidence?: Confidence; version?: string | null } = {},
  ): string {
    const def = platformId
      ? (PLATFORM_REGISTRY[platformId] as { label: string; category: StackNode["category"] })
      : null;
    const id = opts.id ?? platformId ?? slugify(opts.label ?? "unknown");
    const existing = this.nodes.get(id);
    if (existing) {
      if (!existing.detectedFrom.includes(detectedFrom)) existing.detectedFrom.push(detectedFrom);
      if (opts.confidence && rank(opts.confidence) > rank(existing.confidence))
        existing.confidence = opts.confidence;
      if (opts.version && !existing.version) existing.version = opts.version;
      return id;
    }
    this.nodes.set(id, {
      id,
      label: opts.label ?? def?.label ?? id,
      category: def?.category ?? "tooling",
      platformId,
      detectedFrom: [detectedFrom],
      confidence: opts.confidence ?? "medium",
      version: opts.version ?? null,
    });
    return id;
  }

  /** Record an edge once (dedup on from|to|relation). */
  link(from: string, to: string, relation: StackRelation): void {
    if (from === to) return;
    const key = `${from}|${to}|${relation}`;
    if (this.edgeKeys.has(key)) return;
    this.edgeKeys.add(key);
    this.edges.push({ from, to, relation });
  }

  has(id: string): boolean {
    return this.nodes.has(id);
  }

  finalize(repo: StackManifest["repo"], detectedAt: number): StackManifest {
    // Drop edges that dangle (defensive — every id should exist).
    const ids = new Set(this.nodes.keys());
    const edges = this.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
    return {
      version: STACK_MANIFEST_VERSION,
      repo,
      nodes: [...this.nodes.values()],
      edges,
      envVars: [...this.envVars].sort(),
      notes: this.notes,
      detectedAt,
    };
  }
}

function rank(c: Confidence): number {
  return c === "high" ? 3 : c === "medium" ? 2 : 1;
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "unknown"
  );
}

// ═══════════════════════════════════════════════════════════════════
// FILE HELPERS
// ═══════════════════════════════════════════════════════════════════

function read(root: string, rel: string): string | null {
  const p = join(root, rel);
  try {
    if (!existsSync(p) || !statSync(p).isFile()) return null;
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function readJson(root: string, rel: string): any | null {
  const raw = read(root, rel);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// PER-ECOSYSTEM DETECTORS
// ═══════════════════════════════════════════════════════════════════

function detectNode(b: ManifestBuilder, root: string): void {
  const pkg = readJson(root, "package.json");
  if (!pkg) return;

  // Language: TS if tsconfig/typescript dep, else JS.
  const allDeps: Record<string, string> = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
    ...pkg.peerDependencies,
    ...pkg.optionalDependencies,
  };
  const hasTs = existsSync(join(root, "tsconfig.json")) || "typescript" in allDeps;
  const langId = b.add(
    hasTs ? "typescript" : "javascript",
    hasTs ? "tsconfig.json / package.json" : "package.json",
    {
      confidence: "high",
    },
  );

  // Package manager from lockfile.
  const pm: { file: string; id: PlatformId }[] = [
    { file: "pnpm-lock.yaml", id: "pnpm" },
    { file: "yarn.lock", id: "yarn" },
    { file: "bun.lockb", id: "bun" },
    { file: "package-lock.json", id: "npm" },
  ];
  for (const { file, id } of pm) {
    if (existsSync(join(root, file))) {
      const pmId = b.add(id, file, { confidence: "high" });
      b.link(langId, pmId, "built-with");
      break;
    }
  }

  // Map each dependency to a platform.
  for (const [name, version] of Object.entries(allDeps)) {
    const pid = NPM_DEP_MAP[name] ?? resolvePlatformId(name);
    if (!pid) continue;
    const isDep = name in (pkg.dependencies ?? {});
    const nodeId = b.add(
      pid,
      `package.json:${isDep ? "dependencies" : "devDependencies"}.${name}`,
      {
        confidence: "high",
        version: typeof version === "string" ? version : null,
      },
    );
    const cat = PLATFORM_REGISTRY[pid].category;
    if (cat === "framework") b.link(nodeId, langId, "runs-on");
    else if (cat === "database" || cat === "service") b.link(langId, nodeId, "uses");
    else if (cat === "tooling") b.link(langId, nodeId, "built-with");
  }
}

function detectPython(b: ManifestBuilder, root: string): void {
  const req = read(root, "requirements.txt");
  const pyproject = read(root, "pyproject.toml");
  const pipfile = read(root, "Pipfile");
  if (!req && !pyproject && !pipfile && !existsSync(join(root, "setup.py"))) return;

  const langId = b.add(
    "python",
    req ? "requirements.txt" : pyproject ? "pyproject.toml" : "Pipfile",
    {
      confidence: "high",
    },
  );

  if (pyproject) {
    if (/\[tool\.poetry\]/.test(pyproject))
      b.link(langId, b.add("poetry", "pyproject.toml:[tool.poetry]", {}), "built-with");
  }

  const names = new Set<string>();
  if (req) {
    for (const line of req.split("\n")) {
      const m = line.trim().match(/^([A-Za-z0-9_.-]+)/);
      if (m && !line.trim().startsWith("#")) names.add(m[1].toLowerCase());
    }
  }
  if (pyproject) {
    // crude: capture quoted dep names in [project.dependencies]/[tool.poetry.dependencies]
    for (const m of pyproject.matchAll(/^\s*["']?([A-Za-z0-9_.-]+)["']?\s*[=:>~^]/gm)) {
      names.add(m[1].toLowerCase());
    }
  }
  for (const name of names) {
    const pid = PY_DEP_MAP[name] ?? resolvePlatformId(name);
    if (!pid || pid === "python") continue;
    const nodeId = b.add(pid, `python:${name}`, { confidence: "high" });
    const cat = PLATFORM_REGISTRY[pid].category;
    if (cat === "framework") b.link(nodeId, langId, "runs-on");
    else b.link(langId, nodeId, "uses");
  }
}

function detectGo(b: ManifestBuilder, root: string): void {
  const mod = read(root, "go.mod");
  if (!mod) return;
  const langId = b.add("go", "go.mod", { confidence: "high" });
  b.link(langId, b.add("gomod", "go.mod", {}), "built-with");
  for (const [frag, pid] of Object.entries(GO_DEP_MAP)) {
    if (mod.includes(frag)) {
      const nodeId = b.add(pid, `go.mod:${frag}`, { confidence: "high" });
      const cat = PLATFORM_REGISTRY[pid].category;
      b.link(
        cat === "framework" ? nodeId : langId,
        cat === "framework" ? langId : nodeId,
        cat === "framework" ? "runs-on" : "uses",
      );
    }
  }
}

function detectRust(b: ManifestBuilder, root: string): void {
  const cargo = read(root, "Cargo.toml");
  if (!cargo) return;
  const langId = b.add("rust", "Cargo.toml", { confidence: "high" });
  b.link(langId, b.add("cargo", "Cargo.toml", {}), "built-with");
  for (const [crate, pid] of Object.entries(CARGO_DEP_MAP)) {
    if (new RegExp(`^\\s*${crate.replace(/[-.]/g, "[-.]")}\\s*=`, "m").test(cargo)) {
      if (pid === "rust") continue;
      const nodeId = b.add(pid, `Cargo.toml:${crate}`, { confidence: "high" });
      const cat = PLATFORM_REGISTRY[pid].category;
      if (cat === "framework") b.link(nodeId, langId, "runs-on");
      else b.link(langId, nodeId, "uses");
    }
  }
}

function detectRuby(b: ManifestBuilder, root: string): void {
  const gemfile = read(root, "Gemfile");
  if (!gemfile) return;
  const langId = b.add("ruby", "Gemfile", { confidence: "high" });
  b.link(langId, b.add("bundler", "Gemfile", {}), "built-with");
  for (const m of gemfile.matchAll(/gem\s+["']([A-Za-z0-9_.-]+)["']/g)) {
    const pid = GEM_DEP_MAP[m[1]] ?? resolvePlatformId(m[1]);
    if (!pid || pid === "ruby") continue;
    const nodeId = b.add(pid, `Gemfile:${m[1]}`, { confidence: "high" });
    const cat = PLATFORM_REGISTRY[pid].category;
    if (cat === "framework") b.link(nodeId, langId, "runs-on");
    else b.link(langId, nodeId, "uses");
  }
}

function detectPhp(b: ManifestBuilder, root: string): void {
  const composer = readJson(root, "composer.json");
  if (!composer) return;
  const langId = b.add("php", "composer.json", { confidence: "high" });
  b.link(langId, b.add("composer", "composer.json", {}), "built-with");
  const deps = { ...composer.require, ...composer["require-dev"] };
  for (const name of Object.keys(deps)) {
    const pid = COMPOSER_DEP_MAP[name] ?? resolvePlatformId(name.split("/").pop() ?? name);
    if (!pid || pid === "php") continue;
    const nodeId = b.add(pid, `composer.json:${name}`, { confidence: "high" });
    if (PLATFORM_REGISTRY[pid].category === "framework") b.link(nodeId, langId, "runs-on");
    else b.link(langId, nodeId, "uses");
  }
}

function detectDocker(b: ManifestBuilder, root: string): void {
  const dockerfile = existsSync(join(root, "Dockerfile"));
  const compose =
    read(root, "docker-compose.yml") ??
    read(root, "docker-compose.yaml") ??
    read(root, "compose.yml") ??
    read(root, "compose.yaml");
  if (dockerfile) b.add("docker", "Dockerfile", { confidence: "high" });
  if (compose) {
    b.add("docker", "docker-compose", { confidence: "high" });
    // Pull service images out of compose to spot databases.
    for (const m of compose.matchAll(/image:\s*["']?([\w./-]+)/g)) {
      const img = m[1].toLowerCase();
      const pid = resolvePlatformId(basename(img).split(":")[0]);
      if (pid) b.add(pid, `docker-compose:image ${m[1]}`, { confidence: "medium" });
    }
  }
}

function detectInfra(b: ManifestBuilder, root: string): void {
  const hints: { test: () => boolean; id: PlatformId; from: string }[] = [
    { test: () => existsSync(join(root, "vercel.json")), id: "vercel", from: "vercel.json" },
    { test: () => existsSync(join(root, ".vercel")), id: "vercel", from: ".vercel/" },
    { test: () => existsSync(join(root, "netlify.toml")), id: "netlify", from: "netlify.toml" },
    { test: () => existsSync(join(root, "fly.toml")), id: "fly", from: "fly.toml" },
    {
      test: () => existsSync(join(root, "wrangler.toml")),
      id: "cloudflare",
      from: "wrangler.toml",
    },
    { test: () => existsSync(join(root, "render.yaml")), id: "render", from: "render.yaml" },
    {
      test: () => existsSync(join(root, "railway.json")) || existsSync(join(root, "railway.toml")),
      id: "railway",
      from: "railway.*",
    },
    { test: () => existsSync(join(root, "Procfile")), id: "heroku", from: "Procfile" },
    { test: () => existsSync(join(root, "app.yaml")), id: "gcp", from: "app.yaml" },
    {
      test: () =>
        existsSync(join(root, "k8s")) ||
        existsSync(join(root, "kubernetes")) ||
        existsSync(join(root, "helm")),
      id: "kubernetes",
      from: "k8s/ manifests",
    },
    {
      test: () =>
        existsSync(join(root, "supabase")) || existsSync(join(root, "supabase", "config.toml")),
      id: "supabase",
      from: "supabase/",
    },
    {
      test: () => existsSync(join(root, "firebase.json")),
      id: "firebase",
      from: "firebase.json",
    },
    {
      test: () =>
        existsSync(join(root, "serverless.yml")) ||
        existsSync(join(root, "template.yaml")) ||
        existsSync(join(root, "cdk.json")),
      id: "aws",
      from: "serverless/SAM/CDK config",
    },
  ];
  for (const h of hints) {
    try {
      if (h.test()) b.add(h.id, h.from, { confidence: "high" });
    } catch {
      /* ignore */
    }
  }
}

const ENV_FILES = [
  ".env",
  ".env.example",
  ".env.sample",
  ".env.local",
  ".env.template",
  ".env.development",
  ".env.production",
];

function detectEnvVars(b: ManifestBuilder, root: string): void {
  for (const f of ENV_FILES) {
    const raw = read(root, f);
    if (!raw) continue;
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const m = t.replace(/^export\s+/, "").match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (m) b.envVars.add(m[1]); // NAME only — value deliberately discarded
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════

export interface DetectOptions {
  /** Override the detected repo name. */
  name?: string;
  /** The git URL the repo was cloned from, if any. */
  gitUrl?: string | null;
  /** Epoch ms to stamp the manifest with (injectable for determinism). */
  now?: number;
}

/**
 * Inspect a repo directory and return a normalized {@link StackManifest}.
 * Synchronous and side-effect-free (reads only).
 */
export function detectStack(repoPath: string, opts: DetectOptions = {}): StackManifest {
  const root = repoPath;
  const b = new ManifestBuilder();

  if (!existsSync(root) || !statSync(root).isDirectory()) {
    b.notes.push(`repo path "${root}" is not a directory`);
    return b.finalize(
      { path: root, gitUrl: opts.gitUrl ?? null, name: opts.name ?? null },
      opts.now ?? Date.now(),
    );
  }

  detectNode(b, root);
  detectPython(b, root);
  detectGo(b, root);
  detectRust(b, root);
  detectRuby(b, root);
  detectPhp(b, root);
  detectDocker(b, root);
  detectInfra(b, root);
  detectEnvVars(b, root);

  if (b.envVars.size === 0 && !hasAnyManifest(root)) {
    b.notes.push("no recognized stack manifests found at repo root");
  }

  const name = opts.name ?? readJson(root, "package.json")?.name ?? basename(root);
  return b.finalize({ path: root, gitUrl: opts.gitUrl ?? null, name }, opts.now ?? Date.now());
}

function hasAnyManifest(root: string): boolean {
  const files = [
    "package.json",
    "requirements.txt",
    "pyproject.toml",
    "Pipfile",
    "go.mod",
    "Cargo.toml",
    "Gemfile",
    "composer.json",
    "Dockerfile",
  ];
  return files.some((f) => existsSync(join(root, f)));
}

/** Convenience: list the top-level files the detector considers, for debugging. */
export function listDetectableFiles(root: string): string[] {
  try {
    return readdirSync(root).filter((f) => !f.startsWith(".git"));
  } catch {
    return [];
  }
}
