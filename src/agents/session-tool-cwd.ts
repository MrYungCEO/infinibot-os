/**
 * Per-session tool working directory override.
 *
 * A session's agent workspace (identity / memory / bootstrap files) and the
 * directory its exec/read/write/edit tools operate in are usually the same.
 * Agent group chats bind a shared repo: every member turn must run its tools
 * in THAT directory while still loading the member's own identity files from
 * its agent workspace. The group chat service registers the repo for each
 * member session key; the tool factory consults it.
 *
 * Keyed by sessionKey (not AsyncLocalStorage) because tools are built after
 * the command-queue boundary, which drops ALS context — same pattern as the
 * Live Action flag in pi-tools.
 */

const overrides = new Map<string, string>();

function norm(key: string): string {
  return key.trim().toLowerCase();
}

export function setSessionToolCwd(sessionKey: string, dir: string | null | undefined): void {
  if (!sessionKey) return;
  if (dir && dir.trim()) overrides.set(norm(sessionKey), dir.trim());
  else overrides.delete(norm(sessionKey));
}

export function resolveSessionToolCwd(sessionKey: string | null | undefined): string | undefined {
  if (!sessionKey) return undefined;
  return overrides.get(norm(sessionKey));
}

export function clearSessionToolCwdForTest(): void {
  overrides.clear();
}
