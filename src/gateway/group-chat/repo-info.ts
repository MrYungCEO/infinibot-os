/**
 * Group chat binding helpers (gateway side): validate a group's shared
 * working directory and probe its real git state (branch, HEAD, remotes) for
 * the member context block and the group settings UI.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { RepoInfo } from "../../shared/group-chat/context.js";
import type { GroupChatBinding } from "../../shared/group-chat/types.js";
/** Invalid binding input (the service maps it to a GroupChatError). */
export class BindingError extends Error {}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    }).trim();
  } catch {
    return null;
  }
}

/** Real git state of `dir` (never throws). */
export function probeRepo(dir: string): RepoInfo {
  const info: RepoInfo = { path: dir, exists: false, isGitRepo: false, remotes: [] };
  try {
    if (!fs.statSync(dir).isDirectory()) {
      info.error = "not a directory";
      return info;
    }
  } catch {
    info.error = "directory not found";
    return info;
  }
  info.exists = true;
  if (git(dir, ["rev-parse", "--is-inside-work-tree"]) !== "true") return info;
  info.isGitRepo = true;
  const branch = git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch && branch !== "HEAD") info.branch = branch;
  else if (branch === "HEAD") info.branch = "(detached HEAD)";
  const head = git(dir, ["rev-parse", "--short", "HEAD"]);
  if (head) info.head = head;
  const status = git(dir, ["status", "--porcelain"]);
  if (status !== null) info.dirty = status ? status.split("\n").length : 0;
  const remotes = git(dir, ["remote", "-v"]);
  if (remotes) {
    const seen = new Set<string>();
    for (const line of remotes.split("\n")) {
      const [name, url] = line.split(/\s+/);
      if (!name || !url || seen.has(name)) continue;
      seen.add(name);
      info.remotes.push({ name, url });
    }
  }
  const upstream = git(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (upstream) info.upstream = upstream;
  return info;
}

const cache = new Map<string, { at: number; info: RepoInfo }>();
const CACHE_MS = 4000;

/** `probeRepo` with a short cache (describe() is called on every UI refresh). */
export function probeRepoCached(dir: string): RepoInfo {
  const hit = cache.get(dir);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.info;
  const info = probeRepo(dir);
  cache.set(dir, { at: Date.now(), info });
  return info;
}

export function invalidateRepoCache(dir?: string) {
  if (dir) cache.delete(dir);
  else cache.clear();
}

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Validate a binding patch from a client. `null` / "" clears a field.
 * The workdir must be an existing absolute directory.
 */
export function normalizeBindingPatch(
  raw: unknown,
  prev: GroupChatBinding | undefined,
): GroupChatBinding | undefined {
  if (raw === undefined) return prev;
  if (raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw))
    throw new BindingError("binding must be an object");
  const r = raw as Record<string, unknown>;
  const next: GroupChatBinding = { ...prev };
  const field = (k: keyof GroupChatBinding, max: number) => {
    if (!(k in r)) return;
    const v = r[k];
    if (v === null || v === "") {
      delete next[k];
      return;
    }
    if (typeof v !== "string") throw new BindingError(`binding.${k} must be a string`);
    const t = v.trim();
    if (!t) delete next[k];
    else next[k] = t.slice(0, max);
  };
  field("projectId", 200);
  field("projectName", 200);
  field("purpose", 1000);
  if ("workdir" in r) {
    const v = r.workdir;
    if (v === null || v === "" || (typeof v === "string" && !v.trim())) delete next.workdir;
    else {
      if (typeof v !== "string") throw new BindingError("binding.workdir must be a string");
      const p = path.resolve(expandHome(v.trim()));
      if (!path.isAbsolute(expandHome(v.trim())))
        throw new BindingError("binding.workdir must be an absolute path");
      let st: fs.Stats;
      try {
        st = fs.statSync(p);
      } catch {
        throw new BindingError(`Working directory not found: ${p}`);
      }
      if (!st.isDirectory()) throw new BindingError(`Not a directory: ${p}`);
      next.workdir = p;
      invalidateRepoCache(p);
    }
  }
  return Object.keys(next).length ? next : undefined;
}
