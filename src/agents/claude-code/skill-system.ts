/**
 * Claude Coder Skill + Memory Runtime System
 *
 * Injects InfiniBot context (skill index, memory guidance, self-improvement protocols)
 * into every claude_coder spawn. Handles post-mortem analysis on failures and
 * reflection on substantial successes — both fire-and-forget, results queued for
 * operator review. Never modifies live SKILL.md files automatically.
 */

import {
  existsSync,
  mkdirSync,
  appendFileSync,
  writeFileSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";

import { createSubsystemLogger } from "../../logging/subsystem.js";
import { CONFIG_DIR } from "../../utils.js";
import { loadConfig } from "../../config/config.js";
import { getSkillsSnapshotVersion } from "../skills/refresh.js";
import { buildWorkspaceSkillSnapshot } from "../skills/workspace.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import type { SessionInfo } from "./launcher.js";
import { formatErrorMessage } from "../../infra/errors.js";

const log = createSubsystemLogger("agent").child("skill-system");

// ── Browser skill detection ───────────────────────────────────────────────────

/** Directory containing browser-specific skill subdirectories. */
const BROWSER_SKILLS_DIR = join(homedir(), ".infinibot", "skills", "browser");

const BROWSER_TASK_KEYWORDS = [
  "browser",
  "playwright",
  "chrome",
  "chromium",
  "firefox",
  "page",
  "click",
  "navigate",
  "scrape",
  "automate",
  "screenshot",
  "crawl",
  "dom",
  "selector",
  "xpath",
  "aria",
  "oauth",
  "tab",
  "cdp",
  "web automation",
  "form fill",
  "css selector",
  "open url",
  "visit url",
  "go to url",
  "web scraping",
] as const;

/** Returns true when the task likely requires browser automation skills. */
export function detectsBrowserTask(task: string): boolean {
  if (!task) return false;
  const lower = task.toLowerCase();
  return BROWSER_TASK_KEYWORDS.some((kw) => {
    // Short keywords (≤4 chars) are matched as whole words to avoid false positives
    // (e.g. "tab" inside "database", "dom" inside "domain").
    if (kw.length <= 4) {
      return new RegExp(`\\b${kw}\\b`).test(lower);
    }
    return lower.includes(kw);
  });
}

/** Read description from a SKILL.md frontmatter line `description: "..."`. */
function readSkillDescription(skillPath: string): string {
  try {
    const raw = readFileSync(skillPath, "utf-8");
    const match = raw.match(/^description:\s*["']?(.+?)["']?\s*$/m);
    return match ? match[1].trim() : "";
  } catch {
    return "";
  }
}

/** Build the browser skills listing block injected when a browser task is detected. */
function buildBrowserSkillsBlock(): string {
  if (!existsSync(BROWSER_SKILLS_DIR)) return "";
  let subdirs: string[] = [];
  try {
    subdirs = readdirSync(BROWSER_SKILLS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch (err) {
    log.warn(`browser skills: failed to read ${BROWSER_SKILLS_DIR}: ${formatErrorMessage(err)}`);
    return "";
  }

  const entries: Array<{ name: string; description: string; filePath: string }> = [];
  for (const sub of subdirs) {
    const skillPath = join(BROWSER_SKILLS_DIR, sub, "SKILL.md");
    if (!existsSync(skillPath)) continue;
    entries.push({ name: sub, description: readSkillDescription(skillPath), filePath: skillPath });
  }
  if (entries.length === 0) return "";

  const skillLines = entries
    .map(
      (e) =>
        `  <skill>\n    <name>${e.name}</name>\n    <description>${e.description}</description>\n    <location>${e.filePath}</location>\n  </skill>`,
    )
    .join("\n");

  return [
    "### Browser Skills (auto-loaded — browser task detected)",
    "Your task involves browser automation. The following specialized browser skills are pre-loaded.",
    "Before performing any browser action: select the most specific matching skill,",
    "use the Read tool on its SKILL.md at the location shown, and follow it.",
    "",
    "<available_browser_skills>",
    skillLines,
    "</available_browser_skills>",
  ].join("\n");
}

// ── Queue + draft paths ───────────────────────────────────────────────────────

/** Healing proposals land here for operator review. */
export const HEALING_QUEUE_PATH = join(CONFIG_DIR, "skill-healing-queue.jsonl");
/** Skill creation candidates land here for operator review. */
export const CREATE_QUEUE_PATH = join(CONFIG_DIR, "skill-create-queue.jsonl");

// ── Config flag ───────────────────────────────────────────────────────────────

export function isSkillSystemEnabled(): boolean {
  try {
    const cfg = loadConfig() as Record<string, unknown>;
    const claudeCoder = cfg?.claudeCoder as Record<string, unknown> | undefined;
    const skillSystem = claudeCoder?.skillSystem as Record<string, unknown> | undefined;
    return skillSystem?.enabled !== false;
  } catch {
    return true;
  }
}

// ── Path setup ────────────────────────────────────────────────────────────────

/**
 * Ensure queue files and the _drafts directory exist. Called once during
 * onboarding and lazily on first preamble build.
 */
export function ensureSkillSystemPaths(workspaceDir?: string): void {
  if (!existsSync(CONFIG_DIR)) {
    try {
      mkdirSync(CONFIG_DIR, { recursive: true });
    } catch {
      // ok if already exists
    }
  }
  for (const queuePath of [HEALING_QUEUE_PATH, CREATE_QUEUE_PATH]) {
    if (!existsSync(queuePath)) {
      try {
        writeFileSync(queuePath, "", "utf-8");
      } catch {
        // non-fatal
      }
    }
  }
  if (workspaceDir) {
    const draftsDir = join(workspaceDir, "skills", "_drafts");
    if (!existsSync(draftsDir)) {
      try {
        mkdirSync(draftsDir, { recursive: true });
      } catch {
        // non-fatal
      }
    }
  }
}

function appendToQueue(queuePath: string, entry: object): void {
  try {
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
    appendFileSync(queuePath, JSON.stringify(entry) + "\n", "utf-8");
  } catch (err) {
    log.warn(`skill-system: failed to append queue entry: ${formatErrorMessage(err)}`);
  }
}

// ── Skill index cache + preamble builder ──────────────────────────────────────

type PreambleCache = {
  version: number;
  preamble: string;
  skillCount: number;
};

// Keyed by "workspaceDir:plain" or "workspaceDir:browser"; invalidated when skills snapshot version bumps.
const preambleCache = new Map<string, PreambleCache>();

/**
 * Byte budget for the skills block in the coder preamble. The full XML index
 * runs ~115 KB on a 300-skill install, which pushed every coder prompt near
 * the 128 KiB per-argv-string exec limit (E2BIG) and cost every spawn ~30k
 * tokens. Above this budget the preamble carries a compact list and the full
 * index is written to disk for lookup.
 */
export const SKILLS_BLOCK_INLINE_BUDGET = 32 * 1024;

type PromptSkill = { name: string; description: string; filePath: string };

function truncateAtWord(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  if (max <= 1) return "";
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.(-]+$/, "")}…`;
}

/**
 * Compact skills list: grouped by skills root so every SKILL.md path stays
 * derivable (`<root>/<dir>/SKILL.md`), with descriptions shortened just enough
 * to fit `budget`. The untouched XML index lives at `indexPath`.
 */
export function buildCompactSkillsBlock(
  skills: readonly PromptSkill[],
  indexPath: string,
  budget = SKILLS_BLOCK_INLINE_BUDGET,
): string {
  const groups = new Map<string, PromptSkill[]>();
  for (const skill of skills) {
    const root = dirname(dirname(skill.filePath));
    const list = groups.get(root) ?? [];
    list.push(skill);
    groups.set(root, list);
  }
  const render = (maxDesc: number): string => {
    const lines = [
      `<available_skills count="${skills.length}" format="compact">`,
      `Each skill lives at <root>/<name>/SKILL.md under the root it is listed in (a`,
      `"[dir: x]" tag means the folder is x instead of the name). Descriptions are`,
      `shortened; the full index with every description and <location> is at`,
      `${indexPath} — grep it when two skills look alike.`,
    ];
    for (const [root, list] of groups) {
      lines.push("", `Root: ${root}/`);
      for (const skill of list) {
        const dir = basename(dirname(skill.filePath));
        const tag = dir === skill.name ? "" : ` [dir: ${dir}]`;
        const desc = maxDesc > 0 ? truncateAtWord(skill.description, maxDesc) : "";
        lines.push(`- ${skill.name}${tag}${desc ? `: ${desc}` : ""}`);
      }
    }
    lines.push("</available_skills>");
    return lines.join("\n");
  };
  for (let maxDesc = 240; maxDesc > 0; maxDesc -= 10) {
    const block = render(maxDesc);
    if (Buffer.byteLength(block, "utf8") <= budget) return block;
  }
  return render(0);
}

function writeFullSkillIndex(workspaceDir: string, prompt: string): string {
  const hash = createHash("sha1").update(workspaceDir).digest("hex").slice(0, 12);
  const dir = join(CONFIG_DIR, "skills-index");
  const filePath = join(dir, `coder-skills-${hash}.xml`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, prompt + "\n", "utf-8");
  } catch (err) {
    log.warn(
      `skill-system: failed to write full skill index ${filePath}: ${formatErrorMessage(err)}`,
    );
  }
  return filePath;
}

function buildSkillsBlock(workspaceDir: string): { block: string; count: number } {
  try {
    const snapshot = buildWorkspaceSkillSnapshot(workspaceDir);
    const count = snapshot.skills.length;
    const prompt = snapshot.prompt?.trim();
    if (!prompt || count === 0) return { block: "(no skills installed)", count: 0 };
    const skills = (snapshot.resolvedSkills ?? []) as PromptSkill[];
    if (Buffer.byteLength(prompt, "utf8") <= SKILLS_BLOCK_INLINE_BUDGET || skills.length === 0) {
      return { block: prompt, count };
    }
    const indexPath = writeFullSkillIndex(workspaceDir, prompt);
    return { block: buildCompactSkillsBlock(skills, indexPath), count };
  } catch (err) {
    log.warn(
      `skill-system: failed to build skill snapshot for preamble: ${formatErrorMessage(err)}`,
    );
    return { block: "(skill index temporarily unavailable)", count: 0 };
  }
}

/**
 * Build the InfiniBot preamble injected via --append-system-prompt into every
 * claude_coder spawn. Result is cached by workspace dir + skills snapshot version
 * (+ browser flag) so rebuilds only happen when the skill registry actually changes.
 *
 * Pass `opts.task` to enable browser-task detection: when the task contains browser
 * automation keywords, the browser-specific skills from ~/.infinibot/skills/browser/
 * are automatically listed in the preamble under <available_browser_skills>.
 */
export function buildClaudeCoderPreamble(
  workspaceDir: string,
  opts?: { task?: string },
): {
  preamble: string;
  skillCount: number;
  cacheState: "hit" | "miss";
} {
  ensureSkillSystemPaths(workspaceDir);

  const isBrowser = detectsBrowserTask(opts?.task ?? "");
  const cacheKey = `${workspaceDir}:${isBrowser ? "browser" : "plain"}`;
  const ver = getSkillsSnapshotVersion(workspaceDir);
  const cached = preambleCache.get(cacheKey);
  if (cached && cached.version === ver) {
    return { preamble: cached.preamble, skillCount: cached.skillCount, cacheState: "hit" };
  }

  const { block, count } = buildSkillsBlock(workspaceDir);
  const browserBlock = isBrowser ? buildBrowserSkillsBlock() : "";

  const parts = [
    "## InfiniBot Skill + Memory Runtime",
    "",
    "You are a Claude Code agent spawned by the InfiniBot gateway. You are a",
    "first-class extension of InfiniBot: you share memory, workflows, and skills",
    "with all other gateway agents running on this installation.",
    "",
    "### Shared Memory (call before any non-trivial task)",
    "Your MCP connection exposes the full InfiniBot gateway tool registry:",
    "- `mcp__infinibot__memory_search` — semantic search across all prior agent sessions",
    "- `mcp__infinibot__memory_get` — fetch a specific memory entry by id",
    "- `mcp__infinibot__workflows` — list and run saved gateway workflows",
    "- `mcp__infinibot__kanban` — read and update the shared kanban board",
    "- `mcp__infinibot__notes` — read / write shared notes",
    "- `mcp__infinibot__research` — access prior research artifacts",
    "Call `mcp__infinibot__memory_search` before starting when the task involves",
    "anything touched in prior sessions (decisions, file paths, preferences, prior work).",
    "",
    "### Skills (mandatory — scan before replying)",
    "Before replying: scan <available_skills> below.",
    "- If exactly one skill clearly applies: use the Read tool on its SKILL.md path",
    "  (its <location>, or <root>/<name>/SKILL.md in the compact list), then follow it.",
    "- If multiple could apply: pick the most specific one, then read / follow it.",
    "- If none clearly apply: do not read any SKILL.md.",
    "Constraint: never read more than one skill up-front; only after selecting.",
    "",
    block,
  ];

  if (browserBlock) {
    parts.push("", browserBlock);
  }

  parts.push(
    "",
    "### Self-Healing Protocol",
    "If this task fails because a skill gave stale or incorrect instructions,",
    "include this line anywhere in your final output:",
    "  SKILL_ISSUE: <skill-name> | <brief diagnosis of what was wrong>",
    "The runtime will queue a repair proposal for operator review.",
    "Never modify any SKILL.md file directly — proposals require explicit approval.",
    "",
    "### Skill Candidate Protocol",
    "If you complete a substantial task and notice a reusable pattern that would",
    "help future agents, include this line anywhere in your final output:",
    "  SKILL_CANDIDATE: <slug> | <one-line when-to-use description>",
    "A draft SKILL.md will be queued under skills/_drafts/<slug>/ for review.",
    "",
    "### Always Show Media On Screen (mandatory)",
    "Whenever you PRODUCE or SURFACE media — a generated image or video, a PDF or",
    "report, a markdown document, or an HTML preview — you MUST also make it appear",
    "on the user's screen as a proactive media overlay. Silent media delivery is",
    "not allowed.",
    "- Use the `report` tool for PDFs/reports (it shows the styled PDF on screen",
    "  automatically — do not also re-post it).",
    "- Otherwise use `mcp__infinibot__proactive` with action `emitMedia`:",
    "  mediaKind `image` ({url,caption}) or `video` ({url,caption}) for generated",
    "  visuals, `stylized-markdown` ({markdown,title}) for a styled document,",
    "  `card-deck` ({cards:[...]}) for a sequence, `html` ({html}) for a preview.",
    "- Server-side producers (reports, hyperframes renders, note saves, browser",
    "  screenshots) already auto-show their artifact, so you only need to emit for",
    "  media you create through other tools (e.g. image/video generation).",
  );

  const preamble = parts.join("\n");

  preambleCache.set(cacheKey, { version: ver, preamble, skillCount: count });
  return { preamble, skillCount: count, cacheState: "miss" };
}

// ── Utility Claude spawn (for post-mortem + reflection) ───────────────────────

/** Spawn a bare `claude -p` invocation without MCP, skills, or preamble. */
async function spawnUtilityClaude(prompt: string, workdir: string): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Claude CLI manages its own auth; remove Anthropic keys to avoid confusion.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_API_KEY_OLD;

  const result = await runCommandWithTimeout(
    ["claude", "-p", "--output-format", "stream-json", "--verbose", prompt],
    { timeoutMs: 3 * 60 * 1000, cwd: workdir, env },
  );

  // Extract result text from stream-json NDJSON output.
  const stdout = result.stdout.trim();
  if (!stdout) return "";
  for (const line of stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)) {
    try {
      const ev = JSON.parse(line) as Record<string, unknown>;
      if (ev.type === "result" && typeof ev.result === "string") return ev.result;
    } catch {
      // not a JSON event line
    }
  }
  return stdout;
}

// ── Post-mortem (failure) ─────────────────────────────────────────────────────

/**
 * Kick off a non-blocking post-mortem analysis when a child run fails.
 * Spawns a short-lived utility Claude to determine if a skill was at fault.
 * On detection: writes a .proposed patch file and appends to HEALING_QUEUE_PATH.
 */
export function triggerPostMortem(params: {
  info: SessionInfo;
  task: string;
  workdir: string;
  stdoutTail: string;
  stderrTail: string;
}): void {
  setImmediate(() => {
    runPostMortem(params).catch((err) => {
      log.warn(
        `heal: post-mortem errored for runId=${params.info.runId}: ${formatErrorMessage(err)}`,
      );
    });
  });
}

async function runPostMortem(params: {
  info: SessionInfo;
  task: string;
  workdir: string;
  stdoutTail: string;
  stderrTail: string;
}): Promise<void> {
  const { info, task, workdir, stdoutTail, stderrTail } = params;
  log.info(`heal: post-mortem for runId=${info.runId} exitCode=${info.exitCode}`);

  const prompt = [
    "A Claude Code task failed. Determine whether the failure was caused by a",
    "faulty or stale InfiniBot skill instruction.",
    "",
    "Task:",
    task.slice(0, 500),
    "",
    "Last stdout (up to 200 lines):",
    stdoutTail.slice(0, 4000),
    "",
    "Stderr:",
    stderrTail.slice(0, 1000),
    "",
    "If a skill was the root cause, reply with EXACTLY:",
    "SKILL_PATCH: <skill-name>",
    "<proposed minimal correction to the SKILL.md — fix only what was wrong>",
    "END_SKILL_PATCH",
    "",
    "Otherwise reply with exactly: no skill issue",
  ].join("\n");

  let output = "";
  try {
    output = await spawnUtilityClaude(prompt, workdir);
  } catch (err) {
    log.warn(`heal: utility spawn failed for runId=${info.runId}: ${formatErrorMessage(err)}`);
    return;
  }

  const trimmed = output.trim().toLowerCase();
  if (!trimmed || trimmed.startsWith("no skill issue")) {
    log.info(`heal: no skill issue detected for runId=${info.runId}`);
    return;
  }

  const patchMatch = output.match(/SKILL_PATCH:\s*(\S+)\n([\s\S]+?)END_SKILL_PATCH/);
  if (!patchMatch) {
    log.debug(`heal: unrecognized post-mortem format for runId=${info.runId}`);
    return;
  }

  const skillName = patchMatch[1].trim();
  const proposedPatch = patchMatch[2].trim();

  // Write proposed patch alongside the existing skill (never overwrites live SKILL.md).
  const draftPath = join(workdir, "skills", `${skillName}.SKILL.md.proposed`);
  try {
    writeFileSync(draftPath, proposedPatch, "utf-8");
    log.info(`heal: wrote proposed patch → ${draftPath}`);
  } catch (err) {
    log.warn(`heal: failed to write proposed patch: ${formatErrorMessage(err)}`);
  }

  const entry = {
    id: randomUUID(),
    at: new Date().toISOString(),
    runId: info.runId,
    agentId: info.agentId,
    skillName,
    proposedPatch,
    draftPath,
    task: task.slice(0, 200),
    exitCode: info.exitCode,
  };
  appendToQueue(HEALING_QUEUE_PATH, entry);
  log.info(`heal: queued healing entry id=${entry.id} skill="${skillName}"`);
}

// ── Reflection (success) ──────────────────────────────────────────────────────

const SUBSTANTIAL_TASK_VERBS = [
  "build",
  "implement",
  "add",
  "create",
  "refactor",
  "fix",
  "migrate",
  "integrate",
  "write",
  "scaffold",
  "port",
];
const SUBSTANTIAL_DURATION_MS = 5 * 60 * 1000;

/** Returns true when a completed run qualifies for a skill-creation reflection pass. */
export function isSubstantialRun(task: string, durationMs: number): boolean {
  if (durationMs >= SUBSTANTIAL_DURATION_MS) return true;
  const lower = task.trim().toLowerCase();
  return SUBSTANTIAL_TASK_VERBS.some((v) => lower.startsWith(v));
}

// Rate-limit: one reflection create-pass per workspace per 24 h in-memory.
const lastReflectionAt = new Map<string, number>();
const REFLECTION_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * Kick off a non-blocking reflection pass after a substantial successful run.
 * Spawns a short-lived utility Claude to identify reusable skill candidates.
 * On detection: writes draft to skills/_drafts/<slug>/SKILL.md and appends
 * to CREATE_QUEUE_PATH. Rate-limited to one pass per workspace per 24 h.
 */
export function triggerReflection(params: {
  info: SessionInfo;
  task: string;
  workdir: string;
  output: string;
}): void {
  const now = Date.now();
  const last = lastReflectionAt.get(params.workdir) ?? 0;
  if (now - last < REFLECTION_COOLDOWN_MS) {
    log.debug(`reflect: 24 h cooldown active for workdir — skipping`);
    return;
  }
  lastReflectionAt.set(params.workdir, now);

  setImmediate(() => {
    runReflection(params).catch((err) => {
      log.warn(`reflect: errored for runId=${params.info.runId}: ${formatErrorMessage(err)}`);
    });
  });
}

async function runReflection(params: {
  info: SessionInfo;
  task: string;
  workdir: string;
  output: string;
}): Promise<void> {
  const { info, task, workdir, output } = params;
  log.info(
    `reflect: running for runId=${info.runId} duration=${Math.round(info.durationMs / 1000)}s`,
  );

  const prompt = [
    "A Claude Code task completed successfully. Identify reusable patterns worth",
    "capturing as an InfiniBot skill so future agents solve similar problems faster.",
    "",
    "Task:",
    task.slice(0, 500),
    "",
    "Output summary (truncated):",
    output.slice(0, 3000),
    "",
    `Duration: ${Math.round(info.durationMs / 1000)}s`,
    "",
    "If a new skill should be created, reply with EXACTLY:",
    "SKILL_DRAFT: <slug>",
    "---",
    "<complete SKILL.md following this exact structure:",
    "---",
    "name: <slug>",
    "description: <one-line description>",
    "---",
    "# <Skill Name>",
    "## When to use",
    "<2-4 trigger conditions>",
    "## How to apply",
    "<step-by-step instructions an agent can follow>",
    "## Rules",
    "- Never ...",
    "- Always ...",
    ">",
    "---",
    "END_SKILL_DRAFT",
    "",
    "Otherwise reply with exactly: no skill candidate",
  ].join("\n");

  let reflOutput = "";
  try {
    reflOutput = await spawnUtilityClaude(prompt, workdir);
  } catch (err) {
    log.warn(`reflect: utility spawn failed for runId=${info.runId}: ${formatErrorMessage(err)}`);
    return;
  }

  if (!reflOutput || reflOutput.trim().toLowerCase().startsWith("no skill candidate")) {
    log.info(`reflect: no skill candidate for runId=${info.runId}`);
    return;
  }

  const draftMatch = reflOutput.match(
    /SKILL_DRAFT:\s*(\S+)\n---\n([\s\S]+?)\n---\nEND_SKILL_DRAFT/,
  );
  if (!draftMatch) {
    log.debug(`reflect: unrecognized format for runId=${info.runId}`);
    return;
  }

  const slug = draftMatch[1]
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-");
  const skillContent = draftMatch[2].trim();
  const draftDir = join(workdir, "skills", "_drafts", slug);
  const draftPath = join(draftDir, "SKILL.md");

  try {
    mkdirSync(draftDir, { recursive: true });
    writeFileSync(draftPath, skillContent, "utf-8");
    log.info(`reflect: wrote draft skill "${slug}" → ${draftPath}`);
  } catch (err) {
    log.warn(`reflect: failed to write draft skill: ${formatErrorMessage(err)}`);
    return;
  }

  const entry = {
    id: randomUUID(),
    at: new Date().toISOString(),
    runId: info.runId,
    agentId: info.agentId,
    slug,
    draftPath,
    task: task.slice(0, 200),
    durationMs: info.durationMs,
  };
  appendToQueue(CREATE_QUEUE_PATH, entry);
  log.info(`reflect: queued creation entry id=${entry.id} slug="${slug}"`);

  // Auto-accept unless the workspace config opts back into manual
  // approval. The reflection pipeline runs unattended after every
  // qualifying agent run, so leaving drafts in pending is the equivalent
  // of dropping the skill on the floor — by the time the user opens the
  // Skills view, hundreds of stale drafts have accumulated. Make
  // self-generated skills install themselves and let users disable via
  // the Skill System settings toggle if they want to gate them.
  try {
    const { loadConfig } = await import("../../config/config.js");
    const cfg = loadConfig();
    const ss = ((cfg as Record<string, unknown>).claudeCoder as Record<string, unknown> | undefined)
      ?.skillSystem as Record<string, unknown> | undefined;
    const requireApproval = ss?.requireApproval === true; // default: false
    if (!requireApproval) {
      const { acceptDraft } = await import("../skills/queue-store.js");
      acceptDraft(entry.id, { targetScope: "infinibot", workspaceDir: workdir });
      log.info(`reflect: auto-accepted draft id=${entry.id} slug="${slug}"`);
    }
  } catch (err) {
    log.warn(`reflect: auto-accept failed for id=${entry.id}: ${formatErrorMessage(err)}`);
  }
}
