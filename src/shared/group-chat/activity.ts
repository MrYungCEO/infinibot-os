/**
 * Shared activity ledger for agent group chats.
 *
 * Members only ever saw each other's final TEXT, so a claim like "pushed to
 * master" travelled through the group unchecked while the push had actually
 * failed. After every member turn the gateway reads that member's tool calls
 * and their REAL results from its session transcript, compacts them into
 * `ToolActivity` entries and stamps them on the group message, so the next
 * member sees "git push → FAILED: no remote" instead of the claim.
 *
 * Pure (no fs / no gateway imports) so the gateway, the control UI and the
 * mobile app can share it.
 */

export type ToolActivity = {
  /** Tool name (`exec`, `write`, `kanban`, `claude_coder`, …). */
  tool: string;
  /** One-line description of the call (`git push origin master`, `write sum.js`). */
  summary: string;
  ok: boolean;
  exitCode?: number;
  /** Short error text when the call failed. */
  error?: string;
  /** Short output tail (exec only). */
  output?: string;
  /** Directory the command ran in (exec). */
  cwd?: string;
  /** Files written / edited by this call. */
  files?: string[];
  /** `git commit` → the new commit's short SHA. */
  commit?: string;
  /** `git push` → whether it reached the remote. */
  push?: { ok: boolean; target?: string };
  /** A spawned background run (claude_coder, sessions_spawn, …) — started, NOT finished. */
  spawnedRunId?: string;
  /** Kanban / task-board write (create/update/move …) that succeeded. */
  kanban?: { action: string; taskId?: string; title?: string };
  /** A file rename / move / tag / collection change that really changed something. */
  organize?: { action: string; changed: number };
};

/** secure_lane actions that organise Secure Files (rename, move, tag, …). */
const FILE_ORGANIZE_ACTIONS = new Set([
  "create_collection",
  "rename_collection",
  "delete_collection",
  "rename_file",
  "move_files",
  "tag_files",
  "untag_files",
  "set_project",
  "update_file",
  "bulk_update",
]);

type Part = { type?: string; id?: string; name?: string; arguments?: unknown; text?: string };
export type RawTranscriptMessage = {
  role?: string;
  content?: unknown;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  details?: unknown;
  timestamp?: number;
};

const MAX_ENTRIES = 24;
const ERROR_CHARS = 240;
const OUTPUT_CHARS = 160;

/** Tools that start a background run whose result arrives later. */
export const SPAWN_TOOLS = new Set([
  "claude_coder",
  "codex_coder",
  "grok_coder",
  "opencode_coder",
  "gemini_coder",
  "sessions_spawn",
  "queue_run",
  "goal_run",
]);

/** Read-only tools — never evidence that something was created/changed. */
const READ_ONLY_TOOLS = new Set([
  "read",
  "web_search",
  "web_fetch",
  "web_read",
  "memory_search",
  "memory_get",
  "session_status",
  "sessions_list",
  "agents_list",
  "subagents_list",
  "subagents_events",
  "show_panel",
  "image",
  "vision",
]);

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Part[])
    .map((p) => (p && p.type === "text" && typeof p.text === "string" ? p.text : ""))
    .filter(Boolean)
    .join("\n");
}

function clip(text: string, max: number): string {
  const t = text.trim().replace(/\s+\n/g, "\n");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function tail(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `…${t.slice(t.length - max + 1)}` : t;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** The shell command of an exec-style call (accepts the `cmd` alias, string or argv). */
export function commandOf(args: Record<string, unknown>): string {
  const c = args.command ?? args.cmd;
  if (typeof c === "string") return c.trim();
  if (Array.isArray(c)) return c.map(String).join(" ").trim();
  return "";
}

/** Parse a tool result body: JSON `{status:"error", error}` envelopes count as failures. */
function resultEnvelope(text: string): Record<string, unknown> | null {
  const t = text.trim();
  if (!t.startsWith("{")) return null;
  try {
    return rec(JSON.parse(t));
  } catch {
    return null;
  }
}

const EXIT_RE = /(?:exited with code|exit code[:=]?|exit status)\s*(-?\d+)/i;
const COMMIT_RE = /\[[^\]\s]+(?: \([^)]*\))? ([0-9a-f]{7,40})\]/;
const VALIDATION_RE = /^Validation failed for tool/;

function describeCall(tool: string, args: Record<string, unknown>): string {
  if (tool === "exec" || tool === "bash") return commandOf(args) || "(no command)";
  if (tool === "read" || tool === "write" || tool === "edit")
    return `${tool} ${str(args.path) ?? str(args.file_path) ?? "?"}`;
  if (tool === "apply_patch") return "apply_patch";
  if (SPAWN_TOOLS.has(tool)) {
    const label = str(args.label) ?? str(args.task) ?? str(args.message) ?? "";
    return `${tool}${label ? ` "${clip(label, 80)}"` : ""}`;
  }
  const action = str(args.action);
  return action ? `${tool} ${action}` : tool;
}

/**
 * Turn one member turn's transcript slice into ledger entries: every tool call
 * paired with its result. Calls that failed schema validation and were retried
 * successfully with the same tool are dropped (noise, not activity).
 */
export function extractToolActivity(messages: RawTranscriptMessage[]): ToolActivity[] {
  const calls = new Map<string, { tool: string; args: Record<string, unknown> }>();
  const order: string[] = [];
  const results = new Map<string, RawTranscriptMessage>();
  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const p of m.content as Part[]) {
        if (p?.type !== "toolCall" || !p.id || !p.name) continue;
        calls.set(p.id, { tool: p.name, args: rec(p.arguments) });
        order.push(p.id);
      }
    } else if (m.role === "toolResult" && m.toolCallId) {
      results.set(m.toolCallId, m);
    }
  }

  const out: ToolActivity[] = [];
  for (const id of order) {
    const call = calls.get(id)!;
    const res = results.get(id);
    const entry = buildEntry(call.tool, call.args, res);
    if (entry) out.push(entry);
  }
  // Drop validation failures that were followed by a successful call of the same tool.
  const filtered = out.filter((e, i) => {
    if (!e.error || !VALIDATION_RE.test(e.error)) return true;
    return !out.slice(i + 1).some((n) => n.tool === e.tool && n.ok);
  });
  return filtered.length > MAX_ENTRIES ? filtered.slice(-MAX_ENTRIES) : filtered;
}

function buildEntry(
  tool: string,
  args: Record<string, unknown>,
  res: RawTranscriptMessage | undefined,
): ToolActivity | null {
  const summary = clip(describeCall(tool, args), 200);
  if (!res) return { tool, summary, ok: false, error: "no result recorded (interrupted?)" };
  const body = textOf(res.content);
  const details = rec(res.details);
  const env = resultEnvelope(body);
  const envStatus = str(env?.status) ?? str(details.status);
  const envError = str(env?.error) ?? str(details.error);
  let exitCode =
    typeof details.exitCode === "number"
      ? details.exitCode
      : typeof env?.exitCode === "number"
        ? (env.exitCode as number)
        : undefined;
  if (exitCode === undefined) {
    const m = EXIT_RE.exec(envError ?? body);
    if (m) exitCode = Number(m[1]);
  }
  const failed =
    res.isError === true ||
    envStatus === "error" ||
    envStatus === "failed" ||
    env?.ok === false ||
    (typeof exitCode === "number" && exitCode !== 0);
  const entry: ToolActivity = { tool, summary, ok: !failed };
  if (typeof exitCode === "number") entry.exitCode = exitCode;
  const cwd = str(details.cwd) ?? str(args.workdir);
  if (cwd && (tool === "exec" || tool === "bash")) entry.cwd = cwd;
  if (failed) entry.error = clip(envError ?? body ?? "failed", ERROR_CHARS) || "failed";

  if (tool === "exec" || tool === "bash") {
    const cmd = commandOf(args);
    const output = str(details.aggregated) ?? body;
    if (!failed && output && output !== "(no output)") entry.output = tail(output, OUTPUT_CHARS);
    if (/\bgit\b[^|;&]*\bcommit\b/.test(cmd) && !failed) {
      const m = COMMIT_RE.exec(output);
      if (m) entry.commit = m[1].slice(0, 12);
    }
    if (!failed && /(^|[;&|]\s*)(mv|rename)\s+\S/.test(cmd))
      entry.organize = { action: "mv", changed: 1 };
    if (/\bgit\b[^|;&]*\bpush\b/.test(cmd)) {
      const target = /\bpush\b\s+(.*)$/.exec(cmd)?.[1]?.trim();
      entry.push = { ok: !failed, ...(target ? { target: clip(target, 80) } : {}) };
    }
  } else if ((tool === "write" || tool === "edit") && !failed) {
    const p = str(args.path) ?? str(args.file_path);
    if (p) entry.files = [p];
  } else if (tool === "apply_patch" && !failed) {
    const patch = str(args.input) ?? str(args.patch) ?? "";
    const files = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) =>
      m[1].trim(),
    );
    if (files.length) entry.files = files;
  } else if (SPAWN_TOOLS.has(tool) && !failed) {
    const runId = str(env?.runId) ?? str(env?.childSessionKey) ?? str(details.runId);
    if (runId) entry.spawnedRunId = runId;
    // claude_coder & co. file a kanban card for the run — that IS a task the member created.
    const taskId = str(env?.kanbanTaskId);
    if (taskId) entry.kanban = { action: "create", taskId };
  } else if ((tool === "secure_lane" || tool === "file_context") && !failed) {
    const action = str(args.action) ?? "";
    const organizes =
      (tool === "secure_lane" && FILE_ORGANIZE_ACTIONS.has(action)) ||
      (tool === "file_context" && (action === "rename" || action === "move"));
    if (organizes) {
      // `changed` is what the tool re-read after the write; collection ops have no count.
      const changed =
        typeof env?.changed === "number"
          ? (env.changed as number)
          : action.endsWith("collection")
            ? 1
            : 0;
      entry.organize = { action, changed };
    } else if (tool === "secure_lane" && /^(create|update|delete)_(task|project)$/.test(action)) {
      entry.kanban = {
        action,
        ...(str(rec(env?.task).id) ? { taskId: str(rec(env?.task).id) } : {}),
      };
    }
  } else if (tool === "kanban" && !failed) {
    const action = str(args.action) ?? "";
    if (action && !/^(list|get|search|read|show|find)/.test(action)) {
      entry.kanban = {
        action,
        ...(str(env?.id) || str(rec(env?.task).id)
          ? { taskId: str(env?.id) ?? str(rec(env?.task).id) }
          : {}),
        ...(str(args.title) ? { title: clip(str(args.title)!, 80) } : {}),
      };
    }
  }
  return entry;
}

/** True when the call could have changed something (not a pure read). */
export function isMutatingActivity(a: ToolActivity): boolean {
  if (READ_ONLY_TOOLS.has(a.tool)) return false;
  if (a.tool === "exec" || a.tool === "bash") {
    return !/^\s*(ls|cat|pwd|echo|git (status|log|diff|show|remote|branch)|head|tail|grep|find|which)\b/.test(
      a.summary,
    );
  }
  return true;
}

function statusOf(a: ToolActivity): string {
  if (a.spawnedRunId) return `STARTED run ${a.spawnedRunId} (not finished / not verified yet)`;
  if (!a.ok) {
    const code = typeof a.exitCode === "number" ? `exit ${a.exitCode}` : "FAILED";
    return `${code}${a.error ? ` — ${a.error.split("\n").find((l) => l.trim()) ?? a.error}` : ""}`;
  }
  return typeof a.exitCode === "number" ? `ok (exit ${a.exitCode})` : "ok";
}

/** One line per entry, e.g. `exec \`git push origin master\` → exit 128 — fatal: 'origin' …`. */
export function formatActivityLine(a: ToolActivity): string {
  const facts: string[] = [];
  if (a.commit) facts.push(`commit ${a.commit}`);
  if (a.push) facts.push(a.push.ok ? "PUSH SUCCEEDED" : "PUSH FAILED");
  if (a.files?.length) facts.push(`files: ${a.files.join(", ")}`);
  if (a.kanban)
    facts.push(`kanban ${a.kanban.action}${a.kanban.taskId ? ` ${a.kanban.taskId}` : ""}`);
  if (a.organize) facts.push(`${a.organize.action}: ${a.organize.changed} changed`);
  const where = a.cwd ? ` in ${a.cwd}` : "";
  const label = a.tool === "exec" || a.tool === "bash" ? `exec \`${a.summary}\`` : a.summary;
  return `- ${label}${where} → ${statusOf(a)}${facts.length ? ` [${facts.join("; ")}]` : ""}`;
}

/** Compact ledger block other members see under a message. Empty string when nothing ran. */
export function formatActivityBlock(activity: ToolActivity[] | undefined, maxLines = 12): string {
  if (!activity?.length) return "";
  const lines = activity.map(formatActivityLine);
  const kept =
    lines.length > maxLines
      ? [`- … ${lines.length - maxLines} earlier call(s)`, ...lines.slice(-maxLines)]
      : lines;
  return `[Tool activity — real results recorded by the gateway]\n${kept.join("\n")}`;
}

/** No tools were called at all — still useful to say so next to big claims. */
export function activityFacts(activity: ToolActivity[] | undefined) {
  const list = activity ?? [];
  return {
    any: list.length > 0,
    anyOk: list.some((a) => a.ok),
    mutatingOk: list.some((a) => a.ok && isMutatingActivity(a) && !a.spawnedRunId),
    pushOk: list.some((a) => a.push?.ok),
    pushFailed: list.some((a) => a.push && !a.push.ok),
    commitOk: list.some((a) => Boolean(a.commit)),
    filesChanged: list.flatMap((a) => a.files ?? []),
    kanbanWrite: list.some((a) => Boolean(a.kanban)),
    /** A rename/move/tag that really changed at least one file. */
    organizeOk: list.some((a) => a.ok && (a.organize?.changed ?? 0) > 0),
    organizeTried: list.some(
      (a) =>
        Boolean(a.organize) ||
        (!a.ok &&
          /secure_lane (rename|move|tag|bulk|update_file|set_project)|file_context (rename|move)/.test(
            a.summary,
          )),
    ),
    spawned: list.filter((a) => a.spawnedRunId).map((a) => a.spawnedRunId!),
    testsOk: list.some(
      (a) =>
        a.ok &&
        (a.tool === "exec" || a.tool === "bash") &&
        /\b(test|tests|jest|vitest|pytest|mocha|node\s+\S*test\S*|npm (run )?test|pnpm (run )?test|yarn test|go test|cargo test)\b/i.test(
          a.summary,
        ),
    ),
  };
}
