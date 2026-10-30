/**
 * Stack Manifest — the canonical shared contract for InfiniBot's
 * "Sites & Apps" platform.
 *
 * When a repo is attached (see {@link ./stack-detector.ts} and
 * {@link ./repo-attach.ts}) the detector emits a normalized
 * {@link StackManifest}: a typed graph of the technologies that make up
 * the project. Downstream consumers — the constellation graph UI, the
 * management agents, the app-data store — all import the types from THIS
 * file. It is the single source of truth for the manifest shape and for
 * the {@link PlatformId} slug registry that the frontend uses to map a
 * detected technology to its logo asset.
 *
 * OWNERSHIP: this file (the manifest types) and `stack-detector.ts` are
 * owned by the repo-attach / detection stream. The app-data store / KPI /
 * campaign / cron / alert schema lives elsewhere and IMPORTS the
 * `StackManifest` type from here — it does not redefine it.
 */

// ═══════════════════════════════════════════════════════════════════
// CATEGORIES
// ═══════════════════════════════════════════════════════════════════

/**
 * The high-level bucket a node falls into. The constellation graph uses
 * this to colour/cluster nodes; the registry below assigns one to every
 * known platform.
 */
export type StackCategory = "language" | "framework" | "database" | "infra" | "service" | "tooling";

// ═══════════════════════════════════════════════════════════════════
// PLATFORM ID REGISTRY
// ═══════════════════════════════════════════════════════════════════

/**
 * One entry in the canonical platform registry. `platformId` is the slug
 * the frontend uses for logo lookup (e.g. `nextjs` -> `/logos/nextjs.svg`).
 */
export interface PlatformDef {
  /** Canonical slug — stable, lowercase, used for logo asset lookup. */
  id: string;
  /** Human-facing label shown in the constellation graph. */
  label: string;
  /** Which bucket this platform belongs to. */
  category: StackCategory;
  /** Optional alternate slugs we may detect under, mapped to this id. */
  aliases?: string[];
}

/**
 * The canonical registry of known platforms. Keys ARE the canonical
 * platformId slugs. Add a row here to teach the detector + frontend about
 * a new technology. The frontend maps `platformId -> logo` purely from the
 * keys of this object, so keep slugs stable.
 */
export const PLATFORM_REGISTRY = {
  // ── Languages ────────────────────────────────────────────────
  typescript: { id: "typescript", label: "TypeScript", category: "language" },
  javascript: { id: "javascript", label: "JavaScript", category: "language" },
  python: { id: "python", label: "Python", category: "language" },
  go: { id: "go", label: "Go", category: "language", aliases: ["golang"] },
  rust: { id: "rust", label: "Rust", category: "language" },
  ruby: { id: "ruby", label: "Ruby", category: "language" },
  php: { id: "php", label: "PHP", category: "language" },
  java: { id: "java", label: "Java", category: "language" },
  csharp: { id: "csharp", label: "C#", category: "language", aliases: ["dotnet", "c#"] },
  elixir: { id: "elixir", label: "Elixir", category: "language" },

  // ── Frameworks ───────────────────────────────────────────────
  nextjs: { id: "nextjs", label: "Next.js", category: "framework", aliases: ["next"] },
  react: { id: "react", label: "React", category: "framework" },
  vue: { id: "vue", label: "Vue", category: "framework", aliases: ["vuejs"] },
  nuxt: { id: "nuxt", label: "Nuxt", category: "framework" },
  svelte: { id: "svelte", label: "Svelte", category: "framework" },
  sveltekit: { id: "sveltekit", label: "SvelteKit", category: "framework" },
  angular: { id: "angular", label: "Angular", category: "framework" },
  solid: { id: "solid", label: "SolidJS", category: "framework", aliases: ["solidjs"] },
  astro: { id: "astro", label: "Astro", category: "framework" },
  remix: { id: "remix", label: "Remix", category: "framework" },
  vite: { id: "vite", label: "Vite", category: "framework" },
  express: { id: "express", label: "Express", category: "framework" },
  fastify: { id: "fastify", label: "Fastify", category: "framework" },
  nestjs: { id: "nestjs", label: "NestJS", category: "framework", aliases: ["nest"] },
  fastapi: { id: "fastapi", label: "FastAPI", category: "framework" },
  django: { id: "django", label: "Django", category: "framework" },
  flask: { id: "flask", label: "Flask", category: "framework" },
  rails: { id: "rails", label: "Ruby on Rails", category: "framework", aliases: ["ruby-on-rails"] },
  laravel: { id: "laravel", label: "Laravel", category: "framework" },
  spring: { id: "spring", label: "Spring", category: "framework", aliases: ["spring-boot"] },
  gin: { id: "gin", label: "Gin", category: "framework" },
  actix: { id: "actix", label: "Actix", category: "framework", aliases: ["actix-web"] },
  axum: { id: "axum", label: "Axum", category: "framework" },
  phoenix: { id: "phoenix", label: "Phoenix", category: "framework" },
  expo: { id: "expo", label: "Expo", category: "framework" },
  reactnative: {
    id: "reactnative",
    label: "React Native",
    category: "framework",
    aliases: ["react-native"],
  },
  electron: { id: "electron", label: "Electron", category: "framework" },
  tauri: { id: "tauri", label: "Tauri", category: "framework" },
  lit: { id: "lit", label: "Lit", category: "framework" },

  // ── Databases / ORMs ─────────────────────────────────────────
  postgresql: {
    id: "postgresql",
    label: "PostgreSQL",
    category: "database",
    aliases: ["postgres", "pg"],
  },
  mysql: { id: "mysql", label: "MySQL", category: "database" },
  sqlite: { id: "sqlite", label: "SQLite", category: "database", aliases: ["better-sqlite3"] },
  mongodb: {
    id: "mongodb",
    label: "MongoDB",
    category: "database",
    aliases: ["mongo", "mongoose"],
  },
  redis: { id: "redis", label: "Redis", category: "database", aliases: ["ioredis"] },
  prisma: { id: "prisma", label: "Prisma", category: "database" },
  drizzle: { id: "drizzle", label: "Drizzle", category: "database", aliases: ["drizzle-orm"] },
  typeorm: { id: "typeorm", label: "TypeORM", category: "database" },
  sequelize: { id: "sequelize", label: "Sequelize", category: "database" },
  sqlalchemy: { id: "sqlalchemy", label: "SQLAlchemy", category: "database" },
  elasticsearch: { id: "elasticsearch", label: "Elasticsearch", category: "database" },

  // ── Infra / Hosting ──────────────────────────────────────────
  docker: { id: "docker", label: "Docker", category: "infra" },
  kubernetes: { id: "kubernetes", label: "Kubernetes", category: "infra", aliases: ["k8s"] },
  vercel: { id: "vercel", label: "Vercel", category: "infra" },
  netlify: { id: "netlify", label: "Netlify", category: "infra" },
  fly: { id: "fly", label: "Fly.io", category: "infra", aliases: ["flyio"] },
  aws: { id: "aws", label: "AWS", category: "infra" },
  gcp: { id: "gcp", label: "Google Cloud", category: "infra", aliases: ["google-cloud"] },
  azure: { id: "azure", label: "Azure", category: "infra" },
  cloudflare: {
    id: "cloudflare",
    label: "Cloudflare",
    category: "infra",
    aliases: ["wrangler", "workers"],
  },
  render: { id: "render", label: "Render", category: "infra" },
  railway: { id: "railway", label: "Railway", category: "infra" },
  heroku: { id: "heroku", label: "Heroku", category: "infra" },

  // ── Services ─────────────────────────────────────────────────
  supabase: { id: "supabase", label: "Supabase", category: "service" },
  firebase: { id: "firebase", label: "Firebase", category: "service" },
  stripe: { id: "stripe", label: "Stripe", category: "service" },
  clerk: { id: "clerk", label: "Clerk", category: "service" },
  auth0: { id: "auth0", label: "Auth0", category: "service" },
  openai: { id: "openai", label: "OpenAI", category: "service" },
  anthropic: { id: "anthropic", label: "Anthropic", category: "service" },
  sentry: { id: "sentry", label: "Sentry", category: "service" },
  twilio: { id: "twilio", label: "Twilio", category: "service" },
  sendgrid: { id: "sendgrid", label: "SendGrid", category: "service" },
  resend: { id: "resend", label: "Resend", category: "service" },
  algolia: { id: "algolia", label: "Algolia", category: "service" },

  // ── Tooling ──────────────────────────────────────────────────
  npm: { id: "npm", label: "npm", category: "tooling" },
  pnpm: { id: "pnpm", label: "pnpm", category: "tooling" },
  yarn: { id: "yarn", label: "Yarn", category: "tooling" },
  bun: { id: "bun", label: "Bun", category: "tooling" },
  webpack: { id: "webpack", label: "Webpack", category: "tooling" },
  esbuild: { id: "esbuild", label: "esbuild", category: "tooling" },
  turbo: { id: "turbo", label: "Turborepo", category: "tooling", aliases: ["turborepo"] },
  tailwind: {
    id: "tailwind",
    label: "Tailwind CSS",
    category: "tooling",
    aliases: ["tailwindcss"],
  },
  jest: { id: "jest", label: "Jest", category: "tooling" },
  vitest: { id: "vitest", label: "Vitest", category: "tooling" },
  playwright: { id: "playwright", label: "Playwright", category: "tooling" },
  eslint: { id: "eslint", label: "ESLint", category: "tooling" },
  poetry: { id: "poetry", label: "Poetry", category: "tooling" },
  pip: { id: "pip", label: "pip", category: "tooling" },
  cargo: { id: "cargo", label: "Cargo", category: "tooling" },
  gomod: { id: "gomod", label: "Go Modules", category: "tooling", aliases: ["go-modules"] },
  bundler: { id: "bundler", label: "Bundler", category: "tooling" },
  composer: { id: "composer", label: "Composer", category: "tooling" },
} as const satisfies Record<string, PlatformDef>;

/** Canonical platform slug — the key space of {@link PLATFORM_REGISTRY}. */
export type PlatformId = keyof typeof PLATFORM_REGISTRY;

/** All known canonical slugs as a runtime array. */
export const PLATFORM_IDS = Object.keys(PLATFORM_REGISTRY) as PlatformId[];

/**
 * Reverse lookup: alias slug -> canonical platformId. Built once from the
 * `aliases` field of every registry entry. Used by the detector to map a
 * dependency name like `next` or `postgres` onto its canonical id.
 */
export const PLATFORM_ALIASES: Readonly<Record<string, PlatformId>> = (() => {
  const map: Record<string, PlatformId> = {};
  for (const id of PLATFORM_IDS) {
    map[id] = id;
    const def = PLATFORM_REGISTRY[id] as PlatformDef;
    for (const alias of def.aliases ?? []) map[alias.toLowerCase()] = id;
  }
  return map;
})();

/** Resolve a raw slug/name to a canonical {@link PlatformId}, or null. */
export function resolvePlatformId(raw: string): PlatformId | null {
  return PLATFORM_ALIASES[raw.trim().toLowerCase()] ?? null;
}

// ═══════════════════════════════════════════════════════════════════
// MANIFEST SHAPE
// ═══════════════════════════════════════════════════════════════════

/** How confident the detector is that a node belongs in the manifest. */
export type Confidence = "high" | "medium" | "low";

/** Relationship between two nodes in the stack graph. */
export type StackRelation =
  | "depends-on" // generic dependency
  | "runs-on" // framework runs on a language/runtime
  | "deploys-to" // app deploys to an infra target
  | "uses" // app uses a service/database
  | "built-with" // built with a tool
  | "contains"; // monorepo/workspace containment

/** A single technology node in the manifest graph. */
export interface StackNode {
  /** Stable id within this manifest (usually the platformId). */
  id: string;
  /** Display label. */
  label: string;
  /** Bucket — language / framework / database / infra / service / tooling. */
  category: StackCategory;
  /**
   * Canonical platform slug for logo lookup, or null when the technology
   * is not in {@link PLATFORM_REGISTRY} (detected but unknown to the UI).
   */
  platformId: PlatformId | null;
  /** Human-readable provenance, e.g. "package.json:dependencies.next". */
  detectedFrom: string[];
  /** Detector confidence. */
  confidence: Confidence;
  /** Optional detected version string (raw, e.g. "^14.2.0"). */
  version?: string | null;
}

/** A directed relationship between two {@link StackNode}s. */
export interface StackEdge {
  from: string;
  to: string;
  relation: StackRelation;
}

/**
 * The normalized output of attaching a repo. THIS is the canonical
 * contract other streams import.
 */
export interface StackManifest {
  /** Schema version of the manifest contract. */
  version: 1;
  /** The repo this manifest describes. */
  repo: {
    path: string | null;
    gitUrl: string | null;
    name: string | null;
  };
  nodes: StackNode[];
  edges: StackEdge[];
  /** Env var NAMES discovered (never values). */
  envVars: string[];
  /** Free-form notes about how detection went (e.g. files skipped). */
  notes: string[];
  /** Epoch ms the manifest was produced. */
  detectedAt: number;
}

/** The current manifest schema version. */
export const STACK_MANIFEST_VERSION = 1 as const;

// ═══════════════════════════════════════════════════════════════════
// VALIDATION
// ═══════════════════════════════════════════════════════════════════

/**
 * Lightweight structural validation. Returns the list of problems; an
 * empty array means the manifest is well-formed. Kept dependency-free so
 * any stream can call it without pulling in a schema lib.
 */
export function validateStackManifest(m: unknown): string[] {
  const errs: string[] = [];
  if (!m || typeof m !== "object") return ["manifest is not an object"];
  const man = m as Partial<StackManifest>;
  if (man.version !== STACK_MANIFEST_VERSION)
    errs.push(`version must be ${STACK_MANIFEST_VERSION}`);
  if (!Array.isArray(man.nodes)) errs.push("nodes must be an array");
  if (!Array.isArray(man.edges)) errs.push("edges must be an array");
  if (!Array.isArray(man.envVars)) errs.push("envVars must be an array");

  const ids = new Set<string>();
  for (const [i, n] of (man.nodes ?? []).entries()) {
    if (!n || typeof n !== "object") {
      errs.push(`nodes[${i}] is not an object`);
      continue;
    }
    if (!n.id) errs.push(`nodes[${i}] missing id`);
    if (n.id && ids.has(n.id)) errs.push(`duplicate node id "${n.id}"`);
    if (n.id) ids.add(n.id);
    if (n.platformId !== null && !(n.platformId in PLATFORM_REGISTRY)) {
      errs.push(`nodes[${i}] platformId "${n.platformId}" not in registry`);
    }
  }
  for (const [i, e] of (man.edges ?? []).entries()) {
    if (!ids.has(e.from)) errs.push(`edges[${i}].from "${e.from}" has no node`);
    if (!ids.has(e.to)) errs.push(`edges[${i}].to "${e.to}" has no node`);
  }
  return errs;
}
