/**
 * Shared working context for agent group chat members.
 *
 * Every member turn gets the same block in its system prompt: what the group
 * is for, who is in it and what each member can do, the ONE repo/working
 * directory everyone works in (with its real git branch and remote status —
 * "no remote" is said explicitly), the linked kanban project, the date, and
 * the group's truthfulness rules. Pure; the gateway supplies the git probe.
 */
import type { GroupChatBinding } from "./types.js";

export type RepoRemote = { name: string; url: string };

export type RepoInfo = {
  path: string;
  exists: boolean;
  isGitRepo: boolean;
  branch?: string;
  head?: string;
  /** `git status --porcelain` line count. */
  dirty?: number;
  remotes: RepoRemote[];
  /** Upstream of the current branch (`origin/main`), when tracking. */
  upstream?: string;
  error?: string;
};

export type GroupContextMember = {
  id: string;
  name: string;
  /** Free-text role (identity theme / config description). */
  role?: string;
  /** Tool capabilities resolved from the agent's tool policy. */
  canExec?: boolean;
  canWrite?: boolean;
  canSpawn?: boolean;
};

/** One-line remote status, explicit about the no-remote case. */
export function describeRemotes(repo: RepoInfo | null | undefined): string {
  if (!repo || !repo.isGitRepo) return "not a git repository";
  if (!repo.remotes.length)
    return "NO git remote is configured — `git push` cannot work and there is NO URL to clone or pull from. Share work through this directory (same path for every member).";
  const list = repo.remotes.map((r) => `${r.name} → ${r.url}`).join(", ");
  return `${list}${repo.upstream ? ` (branch tracks ${repo.upstream})` : " (current branch has no upstream yet)"}`;
}

function capabilities(m: GroupContextMember): string {
  const caps: string[] = [];
  if (m.canExec === false) caps.push("no shell");
  else if (m.canExec) caps.push("shell");
  if (m.canWrite === false) caps.push("read-only (cannot write/edit files)");
  else if (m.canWrite) caps.push("can edit files");
  if (m.canSpawn) caps.push("can start coder runs");
  return caps.join(", ");
}

export const GROUP_TRUTH_RULES = [
  "Truthfulness rules for this group (the gateway checks every reply against your real tool results and flags violations to everyone):",
  "- Never claim an action you did not make a tool call for in this turn. Never say created / committed / pushed / enabled / fixed / done / tests pass unless a tool result in THIS turn shows it succeeded.",
  "- If a tool call failed (non-zero exit, error, rejected push), say so plainly with the error. Do not paper over it.",
  "- Starting a background run (claude_coder, codex_coder, sessions_spawn, …) is NOT finishing it. Say \"started run <id>\" — never \"done\" or \"enabled\" — until that run reports a verified result.",
  "- Never invent URLs, remotes, branches, commit SHAs or file paths. Only quote ones you saw in a tool result or in this context block.",
  "- Relaying another member's claim? Check the [Tool activity] ledger under their message first; if it shows a failure or no tool call, say that instead of repeating the claim.",
  "- Use the exact tool parameter names from the tool schemas (exec → `command`, read/write/edit → `path`).",
].join("\n");

function fmtDate(now: Date, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      dateStyle: "full",
      timeStyle: "short",
      ...(timeZone ? { timeZone } : {}),
    }).format(now);
  } catch {
    return now.toISOString();
  }
}

export function buildGroupMemberContext(params: {
  groupTitle: string;
  self: GroupContextMember;
  members: GroupContextMember[];
  binding?: GroupChatBinding | null;
  repo?: RepoInfo | null;
  now?: Date;
  timeZone?: string;
  ownerName?: string;
}): string {
  const b = params.binding ?? {};
  const lines: string[] = [
    `## Group chat: "${params.groupTitle}"`,
    `You are ${params.self.name} (@${params.self.id}), one member of this agent group chat. The user talks to the whole group; members see each other's messages and the gateway-recorded results of each other's tool calls.`,
  ];
  if (b.purpose?.trim()) lines.push(`Purpose: ${b.purpose.trim()}`);
  if (params.ownerName?.trim()) lines.push(`Owner (the user): ${params.ownerName.trim()}`);
  lines.push(
    `Date: ${fmtDate(params.now ?? new Date(), params.timeZone)}${params.timeZone ? ` (${params.timeZone})` : ""}`,
  );
  lines.push("", "Members:");
  for (const m of params.members) {
    const caps = capabilities(m);
    lines.push(
      `- ${m.name} (@${m.id})${m.id === params.self.id ? " ← you" : ""}${m.role ? ` — ${m.role}` : ""}${caps ? ` [${caps}]` : ""}`,
    );
  }

  lines.push("", "Shared workspace:");
  const repo = params.repo;
  if (b.workdir) {
    lines.push(
      `- Shared repo / working directory: ${b.workdir}`,
      "  This is the cwd of your exec/read/write/edit tools in this group. Every member works in this SAME directory — do all group work here, not in your personal agent workspace.",
    );
    if (repo && !repo.exists) lines.push(`  ⚠ This directory does not exist (${repo.error ?? "missing"}).`);
    else if (repo && !repo.isGitRepo) lines.push("- Git: this directory is not a git repository.");
    else if (repo) {
      lines.push(
        `- Git branch: ${repo.branch ?? "(detached / unknown)"}${repo.head ? ` @ ${repo.head}` : ""}${typeof repo.dirty === "number" ? ` · ${repo.dirty} uncommitted change(s)` : ""}`,
        `- Remote: ${describeRemotes(repo)}`,
      );
    }
  } else {
    lines.push(
      "- No shared repo is bound to this group. Members' tools run in their own separate workspaces, so files one member writes are NOT visible to the others. Say so instead of pretending to share files; the user can bind a repo in the group settings.",
    );
  }
  if (b.projectId || b.projectName) {
    lines.push(
      `- Linked kanban project: ${b.projectName ?? b.projectId}${b.projectId ? ` (id ${b.projectId})` : ""} — file and update tasks for this group's work there.`,
    );
  } else {
    lines.push("- Linked kanban project: none.");
  }
  lines.push("", GROUP_TRUTH_RULES);
  return lines.join("\n");
}
