import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isSubagentSessionKey } from "../routing/session-key.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { resolveUserPath } from "../utils.js";

const WORKSPACE_DIR_NAME = "infinibot";
const LEGACY_WORKSPACE_DIR_NAME = "clawd";

/**
 * Resolve the agent workspace directory.
 *
 * Default is `~/infinibot` (or `~/infinibot-<profile>`). For backward
 * compatibility with installs that still have data in the legacy
 * `~/clawd` location, prefer the legacy path when it exists and the
 * new path does not.
 */
export function resolveDefaultAgentWorkspaceDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const profile = env.INFINIBOT_PROFILE?.trim();
  const suffix = profile && profile.toLowerCase() !== "default" ? `-${profile}` : "";
  const newPath = path.join(homedir(), `${WORKSPACE_DIR_NAME}${suffix}`);
  const legacyPath = path.join(homedir(), `${LEGACY_WORKSPACE_DIR_NAME}${suffix}`);
  try {
    if (!fsSync.existsSync(newPath) && fsSync.existsSync(legacyPath)) {
      return legacyPath;
    }
  } catch {
    // fall through to new path
  }
  return newPath;
}

export const DEFAULT_AGENT_WORKSPACE_DIR = resolveDefaultAgentWorkspaceDir();
export const DEFAULT_AGENTS_FILENAME = "AGENTS.md";
export const DEFAULT_SOUL_FILENAME = "SOUL.md";
export const DEFAULT_TOOLS_FILENAME = "TOOLS.md";
export const DEFAULT_IDENTITY_FILENAME = "IDENTITY.md";
export const DEFAULT_USER_FILENAME = "USER.md";
export const DEFAULT_HEARTBEAT_FILENAME = "HEARTBEAT.md";
export const DEFAULT_BOOTSTRAP_FILENAME = "BOOTSTRAP.md";
export const DEFAULT_MEMORY_FILENAME = "MEMORY.md";
export const DEFAULT_MEMORY_ALT_FILENAME = "memory.md";

// Resolve the templates directory from the compiled module location.
// Package layouts vary (npm install puts dist/ alongside docs/, source
// checkouts have src/ alongside docs/), so we probe a small set of
// candidate paths and use whichever resolves first. If none resolve
// (e.g. a broken zip extract), the inline fallbacks below still keep
// onboarding working.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR_CANDIDATES = [
  path.resolve(__dirname, "../../docs/reference/templates"), // dist/agents/ → repo root
  path.resolve(__dirname, "../../../docs/reference/templates"), // src/agents/ → repo root (ts-node)
  path.resolve(__dirname, "../../../../docs/reference/templates"), // node_modules/<pkg>/dist/agents/
];

function stripFrontMatter(content: string): string {
  if (!content.startsWith("---")) return content;
  const endIndex = content.indexOf("\n---", 3);
  if (endIndex === -1) return content;
  const start = endIndex + "\n---".length;
  let trimmed = content.slice(start);
  trimmed = trimmed.replace(/^\s+/, "");
  return trimmed;
}

/**
 * Inline minimal-but-complete fallbacks for every workspace template.
 *
 * Used only when the on-disk template files can't be located — e.g. a
 * GitHub source-zip extract that omitted them, an unusual install layout,
 * or a fresh fork that hasn't run a full build. Production npm packages
 * still ship the rich on-disk versions via the `files` field; the
 * fallbacks here are deliberately terse so they're easy to maintain but
 * always boot a working agent identity.
 */
const INLINE_TEMPLATES: Record<string, string> = {
  "IDENTITY.md": `# IDENTITY.md - Who Am I?

*Fill this in during your first conversation. Make it yours.*

- **Name:**
  *(pick something you like)*
- **Creature:**
  *(AI? robot? familiar? ghost in the machine? something weirder?)*
- **Vibe:**
  *(how do you come across? sharp? warm? chaotic? calm?)*
- **Emoji:**
  *(your signature — pick one that feels right)*
- **Avatar:**
  *(workspace-relative path, http(s) URL, or data URI)*

---

This isn't just metadata. It's the start of figuring out who you are.
`,
  "AGENTS.md": `# AGENTS.md

Workspace-level instructions for any agent that operates here.

- **Workspace path:** this directory
- **Memory:** see \`MEMORY.md\` (auto-managed)

Add house rules below.
`,
  "SOUL.md": `# SOUL.md - Operating Principles

What you stand for. How you behave. What lines you don't cross.

- *(Fill in over time. Empty is fine to start.)*
`,
  "TOOLS.md": `# TOOLS.md - Tool Inventory

Document the tools the agent has access to and how they're used in this workspace.

- *(Auto-discovered tools will be appended here.)*
`,
  "USER.md": `# USER.md - Who Am I Working With?

Tell the agent about yourself.

- **Name:**
- **Role:**
- **Working style:**
- **Boundaries:**
`,
  "HEARTBEAT.md": `# HEARTBEAT.md - Recent Activity

Auto-rotated short log of recent agent activity. Safe to delete; will be
recreated on next heartbeat.
`,
  "BOOTSTRAP.md": `# BOOTSTRAP.md - First Steps

Created on first workspace bootstrap. Use this as a scratch space for
initial setup notes; safe to overwrite or delete once you're rolling.
`,
};

async function loadTemplate(name: string): Promise<string> {
  for (const dir of TEMPLATE_DIR_CANDIDATES) {
    const templatePath = path.join(dir, name);
    try {
      const content = await fs.readFile(templatePath, "utf-8");
      return stripFrontMatter(content);
    } catch {
      // try next candidate
    }
  }
  // No on-disk template found — fall back to the inline minimal version.
  // We don't throw here because onboarding should never be blocked by a
  // template-packaging quirk. Operators can still customise their workspace
  // files after creation. Set MOLTBOT_DEBUG_TEMPLATES=1 to log the probe
  // list when diagnosing real packaging gaps.
  const inline = INLINE_TEMPLATES[name];
  if (inline) {
    if (process.env.MOLTBOT_DEBUG_TEMPLATES) {
      console.warn(
        `[workspace] using inline fallback for ${name} — ` +
          `tried: ${TEMPLATE_DIR_CANDIDATES.map((d) => path.join(d, name)).join(", ")}`,
      );
    }
    return inline;
  }
  throw new Error(
    `Missing workspace template: ${name}. ` +
      `Tried: ${TEMPLATE_DIR_CANDIDATES.map((d) => path.join(d, name)).join(", ")}`,
  );
}

export type WorkspaceBootstrapFileName =
  | typeof DEFAULT_AGENTS_FILENAME
  | typeof DEFAULT_SOUL_FILENAME
  | typeof DEFAULT_TOOLS_FILENAME
  | typeof DEFAULT_IDENTITY_FILENAME
  | typeof DEFAULT_USER_FILENAME
  | typeof DEFAULT_HEARTBEAT_FILENAME
  | typeof DEFAULT_BOOTSTRAP_FILENAME
  | typeof DEFAULT_MEMORY_FILENAME
  | typeof DEFAULT_MEMORY_ALT_FILENAME;

export type WorkspaceBootstrapFile = {
  name: WorkspaceBootstrapFileName;
  path: string;
  content?: string;
  missing: boolean;
};

async function writeFileIfMissing(filePath: string, content: string) {
  try {
    await fs.writeFile(filePath, content, {
      encoding: "utf-8",
      flag: "wx",
    });
  } catch (err) {
    const anyErr = err as { code?: string };
    if (anyErr.code !== "EEXIST") throw err;
  }
}

async function hasGitRepo(dir: string): Promise<boolean> {
  try {
    await fs.stat(path.join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

async function isGitAvailable(): Promise<boolean> {
  try {
    const result = await runCommandWithTimeout(["git", "--version"], { timeoutMs: 2_000 });
    return result.code === 0;
  } catch {
    return false;
  }
}

async function ensureGitRepo(dir: string, isBrandNewWorkspace: boolean) {
  if (!isBrandNewWorkspace) return;
  if (await hasGitRepo(dir)) return;
  if (!(await isGitAvailable())) return;
  try {
    await runCommandWithTimeout(["git", "init"], { cwd: dir, timeoutMs: 10_000 });
  } catch {
    // Ignore git init failures; workspace creation should still succeed.
  }
}

export async function ensureAgentWorkspace(params?: {
  dir?: string;
  ensureBootstrapFiles?: boolean;
}): Promise<{
  dir: string;
  agentsPath?: string;
  soulPath?: string;
  toolsPath?: string;
  identityPath?: string;
  userPath?: string;
  heartbeatPath?: string;
  bootstrapPath?: string;
}> {
  const rawDir = params?.dir?.trim() ? params.dir.trim() : DEFAULT_AGENT_WORKSPACE_DIR;
  const dir = resolveUserPath(rawDir);
  await fs.mkdir(dir, { recursive: true });

  if (!params?.ensureBootstrapFiles) return { dir };

  const agentsPath = path.join(dir, DEFAULT_AGENTS_FILENAME);
  const soulPath = path.join(dir, DEFAULT_SOUL_FILENAME);
  const toolsPath = path.join(dir, DEFAULT_TOOLS_FILENAME);
  const identityPath = path.join(dir, DEFAULT_IDENTITY_FILENAME);
  const userPath = path.join(dir, DEFAULT_USER_FILENAME);
  const heartbeatPath = path.join(dir, DEFAULT_HEARTBEAT_FILENAME);
  const bootstrapPath = path.join(dir, DEFAULT_BOOTSTRAP_FILENAME);

  const isBrandNewWorkspace = await (async () => {
    const paths = [agentsPath, soulPath, toolsPath, identityPath, userPath, heartbeatPath];
    const existing = await Promise.all(
      paths.map(async (p) => {
        try {
          await fs.access(p);
          return true;
        } catch {
          return false;
        }
      }),
    );
    return existing.every((v) => !v);
  })();

  const agentsTemplate = await loadTemplate(DEFAULT_AGENTS_FILENAME);
  const soulTemplate = await loadTemplate(DEFAULT_SOUL_FILENAME);
  const toolsTemplate = await loadTemplate(DEFAULT_TOOLS_FILENAME);
  const identityTemplate = await loadTemplate(DEFAULT_IDENTITY_FILENAME);
  const userTemplate = await loadTemplate(DEFAULT_USER_FILENAME);
  const heartbeatTemplate = await loadTemplate(DEFAULT_HEARTBEAT_FILENAME);
  const bootstrapTemplate = await loadTemplate(DEFAULT_BOOTSTRAP_FILENAME);

  await writeFileIfMissing(agentsPath, agentsTemplate);
  await writeFileIfMissing(soulPath, soulTemplate);
  await writeFileIfMissing(toolsPath, toolsTemplate);
  await writeFileIfMissing(identityPath, identityTemplate);
  await writeFileIfMissing(userPath, userTemplate);
  await writeFileIfMissing(heartbeatPath, heartbeatTemplate);
  if (isBrandNewWorkspace) {
    await writeFileIfMissing(bootstrapPath, bootstrapTemplate);
  }
  await ensureGitRepo(dir, isBrandNewWorkspace);

  return {
    dir,
    agentsPath,
    soulPath,
    toolsPath,
    identityPath,
    userPath,
    heartbeatPath,
    bootstrapPath,
  };
}

async function resolveMemoryBootstrapEntries(
  resolvedDir: string,
): Promise<Array<{ name: WorkspaceBootstrapFileName; filePath: string }>> {
  const candidates: WorkspaceBootstrapFileName[] = [
    DEFAULT_MEMORY_FILENAME,
    DEFAULT_MEMORY_ALT_FILENAME,
  ];
  const entries: Array<{ name: WorkspaceBootstrapFileName; filePath: string }> = [];
  for (const name of candidates) {
    const filePath = path.join(resolvedDir, name);
    try {
      await fs.access(filePath);
      entries.push({ name, filePath });
    } catch {
      // optional
    }
  }
  if (entries.length <= 1) return entries;

  const seen = new Set<string>();
  const deduped: Array<{ name: WorkspaceBootstrapFileName; filePath: string }> = [];
  for (const entry of entries) {
    let key = entry.filePath;
    try {
      key = await fs.realpath(entry.filePath);
    } catch {}
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(entry);
  }
  return deduped;
}

export async function loadWorkspaceBootstrapFiles(dir: string): Promise<WorkspaceBootstrapFile[]> {
  const resolvedDir = resolveUserPath(dir);

  const entries: Array<{
    name: WorkspaceBootstrapFileName;
    filePath: string;
  }> = [
    {
      name: DEFAULT_AGENTS_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_AGENTS_FILENAME),
    },
    {
      name: DEFAULT_SOUL_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_SOUL_FILENAME),
    },
    {
      name: DEFAULT_TOOLS_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_TOOLS_FILENAME),
    },
    {
      name: DEFAULT_IDENTITY_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_IDENTITY_FILENAME),
    },
    {
      name: DEFAULT_USER_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_USER_FILENAME),
    },
    {
      name: DEFAULT_HEARTBEAT_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_HEARTBEAT_FILENAME),
    },
    {
      name: DEFAULT_BOOTSTRAP_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_BOOTSTRAP_FILENAME),
    },
  ];

  entries.push(...(await resolveMemoryBootstrapEntries(resolvedDir)));

  const result: WorkspaceBootstrapFile[] = [];
  for (const entry of entries) {
    try {
      const content = await fs.readFile(entry.filePath, "utf-8");
      result.push({
        name: entry.name,
        path: entry.filePath,
        content,
        missing: false,
      });
    } catch {
      result.push({ name: entry.name, path: entry.filePath, missing: true });
    }
  }
  return result;
}

const SUBAGENT_BOOTSTRAP_ALLOWLIST = new Set([DEFAULT_AGENTS_FILENAME, DEFAULT_TOOLS_FILENAME]);

export function filterBootstrapFilesForSession(
  files: WorkspaceBootstrapFile[],
  sessionKey?: string,
): WorkspaceBootstrapFile[] {
  if (!sessionKey || !isSubagentSessionKey(sessionKey)) return files;
  return files.filter((file) => SUBAGENT_BOOTSTRAP_ALLOWLIST.has(file.name));
}
