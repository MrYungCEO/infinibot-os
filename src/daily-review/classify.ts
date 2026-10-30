import path from "node:path";
import type { DeployRef, WorkCategory } from "./types.js";

/** Canonical product names; aliases match label prefixes, repo and project names. */
const PROJECT_ALIASES: Array<[RegExp, string]> = [
  [/^(?:vg|vector\s*games?|vgie|infinitrade)\b|^vg[-_]|vectorgames/i, "VectorGames"],
  [/^(?:kv|kingly\s*vault)\b|^kv[-_]|kinglyvault|kingly-vault/i, "KinglyVault"],
  [/flypic|fly\s*pic/i, "FlyPic"],
  [/robovoice|^rv\b|^rv[-_]/i, "Robovoice"],
  [/omniclinic|dr\.?\s*aios/i, "OmniClinic"],
  [/estate\s*os|estateos/i, "Estate OS"],
  [/droid[-\s]*swarm/i, "Droid Swarm"],
  [/^(?:ib|infinibot)\b|^ib[-_]|infinibot/i, "InfiniBot"],
  [/youngceo|ycs\b|young\s*ceo/i, "YoungCEO"],
  [/lesson|course|avatar[-\s]*explainer/i, "KinglyVault"],
];

export function canonicalProject(name: string | undefined | null): string | null {
  const s = (name ?? "").trim();
  if (!s) return null;
  for (const [re, canon] of PROJECT_ALIASES) if (re.test(s)) return canon;
  return null;
}

/** Repo / worktree directory → project name. */
export function projectFromPath(p: string | undefined): string | null {
  if (!p) return null;
  const parts = p.split(path.sep).filter(Boolean);
  // Walk from the deepest segment up: worktree names usually carry the product.
  for (let i = parts.length - 1; i >= Math.max(0, parts.length - 3); i--) {
    const c = canonicalProject(parts[i]);
    if (c) return c;
  }
  const base = parts[parts.length - 1];
  if (!base || base === "Development" || base === "Desktop" || base === "user") return null;
  return base;
}

/** Product names mentioned anywhere in a label ("Deploy VG SL/TP drag…"). */
const LABEL_MENTIONS: Array<[RegExp, string]> = [
  [/\b(?:VG|VectorGames|Vector Games|TradeLocker)\b/, "VectorGames"],
  [/\b(?:KV|KinglyVault|Kingly Vault)\b/i, "KinglyVault"],
  [/\bFlyPic\b/i, "FlyPic"],
  [/\bRobovoice\b/i, "Robovoice"],
  [/\bOmniClinic\b/i, "OmniClinic"],
];

export function projectFromText(text: string | undefined): string | null {
  if (!text) return null;
  for (const [re, canon] of LABEL_MENTIONS) if (re.test(text)) return canon;
  return null;
}

export function resolveProject(opts: {
  label?: string;
  kanbanProject?: string | null;
  workdir?: string;
}): string {
  const prefix = /^([^:]{2,40}):/.exec(opts.label ?? "")?.[1];
  // Most specific first: an explicit "Product:" prefix, then a product named
  // in the label, then the kanban project, then the repo the agent ran in.
  return (
    canonicalProject(prefix) ??
    projectFromText(opts.label) ??
    canonicalProject(opts.kanbanProject) ??
    (opts.kanbanProject && opts.kanbanProject.length <= 40 ? opts.kanbanProject : null) ??
    projectFromPath(opts.workdir) ??
    canonicalProject(opts.label) ??
    "Other"
  );
}

const CATEGORY_RULES: Array<[WorkCategory, RegExp]> = [
  [
    "deploy",
    /\b(deploy(?:s|ed|ing)?|release[sd]?|ship(?:ped|ping)?|go[-\s]?live|roll(?:out|ed)|publish(?:ed)?|promote|netlify|fly\.io|hotfix to live)\b/i,
  ],
  [
    "video",
    /\b(video|reel|render|hyperframes?|lesson|clip|trailer|footage|mp4|voice[-\s]?over|\bvo\b|edit(?:s|ing)? the (?:video|cut)|b-roll|explainer|ugc|shorts?)\b/i,
  ],
  [
    "research",
    /\b(research|report|audit|analy[sz](?:e|is)|investigat\w*|dossier|strategy|plan(?:ning)?|review of|compare|feasibility|brief)\b/i,
  ],
  [
    "design",
    /\b(ui|ux|restyle|redesign|design|landing|glass|layout|visual|css|mobile screen|premium look|theme)\b/i,
  ],
  [
    "ops",
    /\b(disk|cleanup|oom|restart|infra|monitor|backup|migrat\w*|cron|watchdog|dns|ssl|server|tunnel)\b/i,
  ],
];

export function classifyCategory(label: string, task?: string): WorkCategory {
  const text = `${label}\n${(task ?? "").slice(0, 400)}`;
  // The label is the strongest signal; fall back to the task text.
  for (const [cat, re] of CATEGORY_RULES) if (re.test(label)) return cat;
  for (const [cat, re] of CATEGORY_RULES) if (re.test(text)) return cat;
  return "code";
}

export function backendFromCommand(cmd: string | undefined): string | null {
  if (!cmd) return null;
  const b = path.basename(cmd);
  if (b === "claude") return "claude-code";
  if (["codex", "opencode", "gemini", "grok", "qwen"].includes(b)) return b;
  return null;
}

/**
 * Best-effort deploy detection from a run's final summary + claims. Only
 * phrases that pair a deploy verb with a concrete target count.
 */
export function detectDeploys(text: string, runId: string, label: string, ts: number): DeployRef[] {
  if (!text) return [];
  const out: DeployRef[] = [];
  const seen = new Set<string>();
  const add = (target: string, ref?: string) => {
    const key = `${target}:${ref ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ target, ref, label, runId, ts });
  };
  const negated =
    /\b(not|never|no|without|didn'?t|did not|skip(?:ped)?)\b[^.\n]{0,30}\b(deploy|release|live)/i;
  const lines = text.split(/\n|(?<=\.)\s/);
  for (const line of lines) {
    if (!/\b(deploy|deployed|released?|live|rolled|promoted|published|shipped)\b/i.test(line))
      continue;
    if (negated.test(line)) continue;
    const netlify =
      /netlify[^\n]{0,80}?\b([0-9a-f]{24})\b/i.exec(line) ??
      /\b([0-9a-f]{24})\b[^\n]{0,40}netlify/i.exec(line);
    if (netlify) add("netlify", netlify[1]);
    else if (/\bnetlify\b/i.test(line)) add("netlify");
    const fly = /\bfly(?:\.io)?\b[^\n]{0,60}?\b(v\d{1,4})\b/i.exec(line);
    if (fly) add("fly", fly[1]);
    else if (/\bfly(?:\.io| deploy| release| machines?)\b/i.test(line)) add("fly");
    if (
      /\b(?:live gateway|gateway (?:restart|deploy)|IB-live-release|deploy\/flypic-fixes-live)\b/i.test(
        line,
      )
    )
      add("gateway");
    if (/\b(?:npm publish|published to npm)\b/i.test(line)) add("npm");
    if (/\bvercel\b/i.test(line)) add("vercel");
    if (/\b(?:github release|desktop (?:release|v?20\d\d\.\d+))\b/i.test(line)) add("desktop");
    if (
      /\b(?:KinglyVault|kv)\b[^\n]{0,40}\b(?:course|lesson)\b[^\n]{0,40}\b(?:published|live)\b/i.test(
        line,
      )
    )
      add("kinglyvault");
  }
  return out.slice(0, 6);
}
