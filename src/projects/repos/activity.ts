/**
 * Who is using a folder right now — running sub-agents (registry workdir),
 * tmux panes (current path) and live processes (/proc/<pid>/cwd on Linux).
 *
 * Read-only and best-effort: anything we cannot read is simply skipped. The
 * cleanup executor treats any hit as "do not touch".
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface FolderUser {
  cwd: string;
  who: string;
}

function tmuxSockets(): string[] {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const dir = path.join(process.env.TMUX_TMPDIR || "/tmp", `tmux-${uid}`);
  try {
    return fs.readdirSync(dir).map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

function tmuxPanesOn(socket: string | null): Promise<FolderUser[]> {
  const args = [
    ...(socket ? ["-S", socket] : []),
    "list-panes",
    "-a",
    "-F",
    "#{session_name}\t#{pane_current_path}",
  ];
  return new Promise((resolve) => {
    execFile("tmux", args, { timeout: 3000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve([]);
      resolve(
        String(stdout)
          .split("\n")
          .map((l) => l.split("\t"))
          .filter((p) => p.length === 2 && p[1])
          .map(([sess, cwd]) => ({ cwd: cwd.trim(), who: `tmux: ${sess}` })),
      );
    });
  });
}

/** Panes on every tmux server of this user (InfiniBot uses `-L infinibot`). */
async function tmuxPanes(): Promise<FolderUser[]> {
  const sockets = tmuxSockets();
  const all = await Promise.all(
    sockets.length ? sockets.map((s) => tmuxPanesOn(s)) : [tmuxPanesOn(null)],
  );
  return all.flat();
}

function procCwds(): FolderUser[] {
  if (process.platform !== "linux") return [];
  const out: FolderUser[] = [];
  let pids: string[] = [];
  try {
    pids = fs.readdirSync("/proc").filter((n) => /^\d+$/.test(n));
  } catch {
    return out;
  }
  const self = String(process.pid);
  for (const pid of pids) {
    if (pid === self) continue;
    let cwd: string;
    try {
      cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      continue;
    }
    if (!cwd || cwd === "/" || cwd.endsWith(" (deleted)")) continue;
    let comm = "process";
    try {
      comm = fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim() || comm;
    } catch {
      /* ignore */
    }
    // Our own short-lived git/du children are not "users".
    if (comm === "git" || comm === "du") continue;
    out.push({ cwd, who: `process: ${comm} (${pid})` });
  }
  return out;
}

async function subagentWorkdirs(): Promise<FolderUser[]> {
  try {
    const { listActiveSubagentRuns } = await import("../../agents/subagent-registry.js");
    const out: FolderUser[] = [];
    for (const r of listActiveSubagentRuns()) {
      const who = `agent: ${String(r.label ?? r.runId ?? "sub-agent").slice(0, 60)}`;
      if (typeof r.workdir === "string" && r.workdir) out.push({ cwd: r.workdir, who });
      // An agent may edit a different worktree than the one it started in.
      for (const f of r.filesTouched ?? []) {
        if (f.action !== "read" && path.isAbsolute(f.path)) {
          out.push({ cwd: path.dirname(f.path), who });
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

export type FolderUsersProvider = () => Promise<FolderUser[]>;

let override: FolderUsersProvider | null = null;

/** Tests inject a fixed list instead of reading the machine. */
export function setFolderUsersProviderForTests(fn: FolderUsersProvider | null): void {
  override = fn;
}

/** tmux + /proc only — for scripts running outside the gateway process. */
export async function collectFolderUsersWithoutRegistry(): Promise<FolderUser[]> {
  return [...(await tmuxPanes()), ...procCwds()];
}

export async function collectFolderUsers(): Promise<FolderUser[]> {
  if (override) return override();
  const [tmux, agents] = await Promise.all([tmuxPanes(), subagentWorkdirs()]);
  return [...agents, ...tmux, ...procCwds()];
}

/**
 * Map users to the deepest matching folder in `folders` (so a cwd inside a
 * nested worktree is attributed to that worktree, not its parent repo).
 */
export function attributeUsers(folders: string[], users: FolderUser[]): Map<string, string[]> {
  const sorted = [...folders].sort((a, b) => b.length - a.length);
  const out = new Map<string, string[]>();
  for (const u of users) {
    const cwd = path.resolve(u.cwd);
    const hit = sorted.find((f) => cwd === f || cwd.startsWith(f + path.sep));
    if (!hit) continue;
    const list = out.get(hit) ?? [];
    if (!list.includes(u.who)) list.push(u.who);
    out.set(hit, list);
  }
  return out;
}
