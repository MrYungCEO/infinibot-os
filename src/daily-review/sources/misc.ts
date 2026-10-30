import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { clean } from "../util.js";

const execFileAsync = promisify(execFile);

// ── Reports (~/.infinibot/reports is the Reports page's store) ───────────────

export interface ReportFile {
  name: string;
  path: string;
  ts: number;
}

const REPORT_EXT = /\.(pdf|html|md|mp4|png|docx)$/i;

export function listReports(stateDir: string, fromMs: number, toMs: number): ReportFile[] {
  const root = path.join(stateDir, "reports");
  const out = new Map<string, ReportFile>();
  const walk = (dir: string, depth: number) => {
    if (depth > 4) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p, depth + 1);
        continue;
      }
      if (!REPORT_EXT.test(e.name) || /^rpt_[0-9a-f-]{8,}/.test(e.name)) continue;
      let ts = 0;
      try {
        ts = fs.statSync(p).mtimeMs;
      } catch {
        continue;
      }
      if (ts < fromMs || ts >= toMs) continue;
      // One entry per document: report.pdf + report.md + report.html collapse.
      const key = path.join(path.dirname(p), e.name.replace(REPORT_EXT, ""));
      const prev = out.get(key);
      if (!prev || /\.pdf$/i.test(e.name)) {
        out.set(key, {
          name: clean(e.name.replace(REPORT_EXT, "").replace(/[-_]+/g, " "), 100),
          path: path.relative(root, p),
          ts,
        });
      }
    }
  };
  walk(root, 0);
  return [...out.values()].sort((a, b) => b.ts - a.ts);
}

// ── Incidents: gateway OOM kills (journald) + crashes (watchdog.log) ─────────

export interface Incident {
  ts: number;
  kind: "oom" | "crash";
  detail: string;
}

/** Parse `journalctl -o short-iso` lines. Exported for tests. */
export function parseJournal(text: string): Incident[] {
  const out: Incident[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes("Failed with result 'oom-kill'")) continue;
    const ts = Date.parse(line.slice(0, 25));
    if (Number.isFinite(ts))
      out.push({
        ts,
        kind: "oom",
        detail: "Gateway killed by the OOM killer; watchdog restarted it",
      });
  }
  return out;
}

/** Parse watchdog.log `[iso] Gateway exited code=N` lines. Exported for tests. */
export function parseWatchdogLog(text: string): Incident[] {
  const out: Incident[] = [];
  const re = /^\[([^\]]+)\] Gateway exited code=(\d+)/;
  for (const line of text.split("\n")) {
    const m = re.exec(line);
    if (!m || m[2] === "0") continue;
    const ts = Date.parse(m[1]!);
    if (Number.isFinite(ts))
      out.push({ ts, kind: "crash", detail: `Gateway exited with code ${m[2]}` });
  }
  return out;
}

export async function loadIncidents(
  stateDir: string,
  fromMs: number,
  toMs: number,
): Promise<Incident[]> {
  const all: Incident[] = [];
  try {
    const { stdout } = await execFileAsync(
      "journalctl",
      [
        "--user",
        "-u",
        "infinibot-watchdog",
        "--no-pager",
        "-o",
        "short-iso",
        "--since",
        `@${Math.floor(fromMs / 1000)}`,
        "--until",
        `@${Math.floor(toMs / 1000)}`,
      ],
      { timeout: 20_000, maxBuffer: 16 * 1024 * 1024 },
    );
    all.push(...parseJournal(stdout));
  } catch {
    /* no journald (cloud/desktop) */
  }
  try {
    const file = path.join(stateDir, "watchdog.log");
    const st = fs.statSync(file);
    // Only the tail: the log is append-only and can grow large.
    const size = Math.min(st.size, 4 * 1024 * 1024);
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, st.size - size);
    fs.closeSync(fd);
    all.push(...parseWatchdogLog(buf.toString("utf8")));
  } catch {
    /* none */
  }
  // An OOM kill also shows up as a crash a few seconds later: keep the OOM.
  const ooms = all.filter((i) => i.kind === "oom");
  return all
    .filter((i) => i.ts >= fromMs && i.ts < toMs)
    .filter((i) => i.kind === "oom" || !ooms.some((o) => Math.abs(o.ts - i.ts) < 60_000))
    .sort((a, b) => a.ts - b.ts);
}

// ── Existing workload events (work-activity/<day>.jsonl) ─────────────────────

export function countWorkEvents(stateDir: string, days: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of days) {
    try {
      const text = fs.readFileSync(path.join(stateDir, "work-activity", `${d}.jsonl`), "utf8");
      out[d] = text.split("\n").filter((l) => l.trim()).length;
    } catch {
      /* none */
    }
  }
  return out;
}
