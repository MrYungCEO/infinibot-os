/**
 * Incremental parser for durable coder-run logs (durable/<runId>/stdout.log).
 *
 * claude-code writes stream-json: the `result` events carry cost + token
 * usage; codex writes `turn.completed` (usage) and `item.completed`
 * (agent_message). Logs can be many MB, so we stream line by line, only
 * JSON.parse the few lines we need, and resume from a saved byte offset on
 * the next pass. Archived logs (stdout.log.gz) are parsed once.
 */
import fs from "node:fs";
import readline from "node:readline";
import zlib from "node:zlib";
import { clean, redact } from "./util.js";

export interface LogMetrics {
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  model?: string;
  results: number;
  /** Telegram deliveries the run made through the InfiniBot MCP tools. */
  telegramSends: number;
  /** Running total from the last result event (claude), used for deltas. */
  lastTotalCost: number;
  /** Tail of the final assistant/result text (redacted, capped). */
  finalText?: string;
}

export interface LogCursor {
  file: string;
  ino: number;
  offset: number;
  done: boolean;
  metrics: LogMetrics;
}

export const emptyMetrics = (): LogMetrics => ({
  costUsd: 0,
  tokensIn: 0,
  tokensOut: 0,
  tokensCached: 0,
  results: 0,
  telegramSends: 0,
  lastTotalCost: 0,
});

const FINAL_TEXT_CAP = 6000;

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function keepFinal(text: unknown): string | undefined {
  if (typeof text !== "string" || !text.trim()) return undefined;
  // Keep the end: the RESULT block lives there.
  return redact(text.length > FINAL_TEXT_CAP ? text.slice(-FINAL_TEXT_CAP) : text);
}

/** Fold one log line into the metrics. Exported for tests. */
export function applyLine(m: LogMetrics, line: string): void {
  if (line.length < 10) return;
  if (line.startsWith('{"type":"assistant"') && line.includes("telegram")) {
    const hits = line.match(/"name":"mcp__infinibot__(?:message|telegram_send)"/g);
    if (hits) m.telegramSends += hits.length;
    return;
  }
  if (
    line.includes('"type":"result"') &&
    !line.startsWith('{"type":"user"') &&
    !line.startsWith('{"type":"assistant"')
  ) {
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      return;
    }
    if (o?.type !== "result") return;
    m.results += 1;
    const since = o.model_usage_since_last_result;
    if (since && typeof since === "object") {
      for (const [model, u] of Object.entries<any>(since)) {
        m.costUsd += num(u?.costUSD);
        m.tokensIn += num(u?.inputTokens) + num(u?.cacheCreationInputTokens);
        m.tokensOut += num(u?.outputTokens);
        m.tokensCached += num(u?.cacheReadInputTokens);
        m.model = model;
      }
    } else {
      const total = num(o.total_cost_usd);
      if (total >= m.lastTotalCost) m.costUsd += total - m.lastTotalCost;
      else m.costUsd += total;
      const u = o.usage ?? {};
      m.tokensIn += num(u.input_tokens) + num(u.cache_creation_input_tokens);
      m.tokensOut += num(u.output_tokens);
      m.tokensCached += num(u.cache_read_input_tokens);
      const models =
        o.modelUsage && typeof o.modelUsage === "object" ? Object.keys(o.modelUsage) : [];
      if (models.length) m.model = models[models.length - 1];
    }
    m.lastTotalCost = num(o.total_cost_usd) || m.lastTotalCost;
    const ft = keepFinal(o.result);
    if (ft) m.finalText = ft;
    return;
  }
  if (line.startsWith('{"type":"system"') && line.includes('"subtype":"init"')) {
    const mm = /"model":"([^"]{1,80})"/.exec(line);
    if (mm && !m.model) m.model = mm[1];
    return;
  }
  // codex exec --json
  if (line.includes('"type":"turn.completed"')) {
    try {
      const u = JSON.parse(line)?.usage ?? {};
      m.tokensIn += Math.max(0, num(u.input_tokens) - num(u.cached_input_tokens));
      m.tokensCached += num(u.cached_input_tokens);
      m.tokensOut += num(u.output_tokens) + num(u.reasoning_output_tokens);
      m.results += 1;
    } catch {
      /* ignore */
    }
    return;
  }
  if (line.includes('"type":"item.completed"') && line.includes('"agent_message"')) {
    try {
      const item = JSON.parse(line)?.item;
      const ft = keepFinal(item?.text);
      if (ft) m.finalText = ft;
    } catch {
      /* ignore */
    }
  }
}

async function scanStream(stream: NodeJS.ReadableStream, m: LogMetrics): Promise<void> {
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) applyLine(m, line);
}

/**
 * Parse (or continue parsing) a run's log. Returns the updated cursor; pass it
 * back next time and only the appended bytes are read.
 */
export async function parseRunLog(dir: string, prev?: LogCursor | null): Promise<LogCursor | null> {
  const plain = `${dir}/stdout.log`;
  const gz = `${plain}.gz`;
  if (fs.existsSync(plain)) {
    const st = fs.statSync(plain);
    let cur: LogCursor =
      prev && prev.file === plain && prev.ino === st.ino && prev.offset <= st.size && !prev.done
        ? { ...prev, metrics: { ...prev.metrics } }
        : { file: plain, ino: st.ino, offset: 0, done: false, metrics: emptyMetrics() };
    if (prev && prev.file === plain && prev.ino === st.ino && prev.offset === st.size) return prev;
    if (st.size > cur.offset) {
      // Only consume complete lines: stop at the last newline we can see.
      const end = await lastNewlineBefore(plain, st.size, cur.offset);
      if (end > cur.offset) {
        await scanStream(
          fs.createReadStream(plain, { start: cur.offset, end: end - 1 }),
          cur.metrics,
        );
        cur.offset = end;
      }
    }
    return cur;
  }
  if (fs.existsSync(gz)) {
    if (prev && prev.file === gz && prev.done) return prev;
    const m = emptyMetrics();
    try {
      await scanStream(fs.createReadStream(gz).pipe(zlib.createGunzip()), m);
    } catch {
      /* truncated archive: keep what we got */
    }
    return { file: gz, ino: fs.statSync(gz).ino, offset: 0, done: true, metrics: m };
  }
  return null;
}

async function lastNewlineBefore(file: string, size: number, floor: number): Promise<number> {
  const fd = await fs.promises.open(file, "r");
  try {
    const chunk = 64 * 1024;
    let pos = size;
    while (pos > floor) {
      const start = Math.max(floor, pos - chunk);
      const buf = Buffer.alloc(pos - start);
      await fd.read(buf, 0, buf.length, start);
      const idx = buf.lastIndexOf(0x0a);
      if (idx >= 0) return start + idx + 1;
      pos = start;
    }
    return floor;
  } finally {
    await fd.close();
  }
}

// ── RESULT block ──────────────────────────────────────────────────────────────

export interface ResultBlock {
  status?: string;
  summary?: string;
  commits: string[];
  files: number;
  /** Concatenated claim/summary text for deploy detection (not stored). */
  text: string;
}

export function parseResultBlock(text: string | undefined): ResultBlock | null {
  if (!text) return null;
  const all = [...text.matchAll(/<<<RESULT\s*([\s\S]*?)\s*RESULT>>>/g)];
  const body = all.length ? all[all.length - 1]![1]! : null;
  if (!body) return null;
  let o: any;
  try {
    o = JSON.parse(body);
  } catch {
    return { summary: clean(body, 300), commits: [], files: 0, text: body.slice(0, 4000) };
  }
  const commits = Array.isArray(o.commits)
    ? o.commits.filter((c: unknown) => typeof c === "string").slice(0, 20)
    : [];
  const claims = Array.isArray(o.claims)
    ? o.claims.map((c: any) => `${c?.claim ?? ""} ${c?.evidence_ref ?? ""}`).join("\n")
    : "";
  return {
    status: typeof o.status === "string" ? o.status : undefined,
    summary: clean(o.summary, 300),
    commits,
    files: Array.isArray(o.files_changed) ? o.files_changed.length : 0,
    text: `${o.summary ?? ""}\n${claims}`.slice(0, 6000),
  };
}
