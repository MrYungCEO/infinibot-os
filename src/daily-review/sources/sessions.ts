/**
 * Gateway chat / voice / Telegram activity from agent session transcripts
 * (agents/<agentId>/sessions/<sessionId>.jsonl). Each file is streamed once
 * and folded into per-day buckets; the buckets are cached by (size, mtime) so
 * the next pass only re-reads files that changed.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { dayKey, readJson } from "../util.js";

export interface SessionDayBucket {
  user: number;
  assistant: number;
  costUsd: number;
  tokens: number;
  telegramSends: number;
  hours: number[];
}

export interface SessionFileCache {
  size: number;
  mtimeMs: number;
  agent: string;
  channel: string;
  days: Record<string, SessionDayBucket>;
}

export type SessionCache = Record<string, SessionFileCache>;

export function channelForKey(agent: string, key: string | undefined): string {
  const k = (key ?? "").toLowerCase();
  if (agent === "voice" || k.includes("voice")) return "voice";
  if (k.includes("telegram")) return "telegram";
  if (k.includes("discord")) return "discord";
  if (k.includes(":subagent:") || k.includes("claude-coder") || k.includes("coder"))
    return "agents";
  if (k.includes("mcp-")) return "mcp";
  if (k.includes("terminal")) return "terminal";
  if (k.includes("cron") || k.includes("hook")) return "automation";
  return "chat";
}

const emptyBucket = (): SessionDayBucket => ({
  user: 0,
  assistant: 0,
  costUsd: 0,
  tokens: 0,
  telegramSends: 0,
  hours: new Array(24).fill(0),
});

const TS_RE = /"timestamp":"([0-9T:.\-]{19,30}Z?)"/;
const ROLE_RE = /"role":"(user|assistant)"/;
const COST_RE = /"cost":\{[^{}]*"total":([0-9.eE-]+)/;
const TOK_RE = /"totalTokens":(\d+)/;

/** Fold one transcript line into the per-day buckets. Exported for tests. */
export function applySessionLine(days: Record<string, SessionDayBucket>, line: string): void {
  if (!line.startsWith('{"type":"message"')) return;
  const head = line.slice(0, 400);
  const ts = TS_RE.exec(head);
  const role = ROLE_RE.exec(line.slice(0, 600));
  if (!ts || !role) return;
  const t = Date.parse(ts[1]!);
  if (!Number.isFinite(t)) return;
  const key = dayKey(t);
  const b = (days[key] ??= emptyBucket());
  b.hours[new Date(t).getHours()]! += 1;
  if (role[1] === "user") {
    // Tool results come back as role "toolResult"; plain user turns only here.
    b.user += 1;
    return;
  }
  b.assistant += 1;
  const tail = line.length > 4000 ? line.slice(-1500) : line;
  const cost = COST_RE.exec(tail);
  if (cost) b.costUsd += Number(cost[1]) || 0;
  const tok = TOK_RE.exec(tail);
  if (tok) b.tokens += Number(tok[1]) || 0;
  if (line.includes('"telegram')) {
    const calls = line.match(/"name":"(?:message|telegram_send)","arguments":\{[^}]{0,400}/g) ?? [];
    for (const c of calls)
      if (c.includes("telegram_send") || /"channel":"telegram"/.test(c)) b.telegramSends += 1;
  }
}

function sessionKeyIndex(sessionsDir: string): Map<string, string> {
  const idx = new Map<string, string>();
  const data =
    readJson<Record<string, { sessionId?: string }>>(path.join(sessionsDir, "sessions.json")) ?? {};
  for (const [key, v] of Object.entries(data)) if (v?.sessionId) idx.set(v.sessionId, key);
  return idx;
}

/**
 * Update `cache` for every transcript touched since `sinceMs`. Returns the
 * cache (mutated) — callers aggregate the per-day buckets they need.
 */
export async function scanSessions(
  stateDir: string,
  sinceMs: number,
  cache: SessionCache,
): Promise<SessionCache> {
  const agentsDir = path.join(stateDir, "agents");
  let agents: string[] = [];
  try {
    agents = fs.readdirSync(agentsDir);
  } catch {
    return cache;
  }
  for (const agent of agents) {
    const dir = path.join(agentsDir, agent, "sessions");
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    let keys: Map<string, string> | null = null;
    for (const f of files) {
      const file = path.join(dir, f);
      let st: fs.Stats;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      if (st.mtimeMs < sinceMs) continue;
      const prev = cache[file];
      if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) continue;
      keys ??= sessionKeyIndex(dir);
      const days: Record<string, SessionDayBucket> = {};
      try {
        const rl = readline.createInterface({
          input: fs.createReadStream(file),
          crlfDelay: Infinity,
        });
        for await (const line of rl) applySessionLine(days, line);
      } catch {
        continue;
      }
      cache[file] = {
        size: st.size,
        mtimeMs: st.mtimeMs,
        agent,
        channel: channelForKey(agent, keys.get(f.replace(/\.jsonl$/, ""))),
        days,
      };
    }
  }
  return cache;
}
