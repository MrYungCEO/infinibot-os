#!/usr/bin/env node
/**
 * Daily Review rollup CLI. Run by the systemd user timer (tick) and by the
 * gateway (refresh / day) in a child process.
 *
 *   node dist/daily-review/cli.js backfill [--from YYYY-MM-DD]
 *   node dist/daily-review/cli.js refresh            # today (+ yesterday early on)
 *   node dist/daily-review/cli.js day YYYY-MM-DD
 *   node dist/daily-review/cli.js summary [YYYY-MM-DD] [--send] [--media a.png,b.png]
 *   node dist/daily-review/cli.js tick               # refresh + scheduled summary/telegram
 *   node dist/daily-review/cli.js show [YYYY-MM-DD]  # compact text
 */
import fs from "node:fs";
import path from "node:path";
import { compactDay } from "./compact.js";
import { earliestDataDay, readDay, rollupRange, saveDay } from "./rollup.js";
import { generateSummary, sendTelegram, telegramText } from "./summary.js";
import { addDays, analyticsDir, isDayKey, loadConfig, today } from "./util.js";

const argv = process.argv.slice(2);
const cmd = argv[0] ?? "refresh";
const flag = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const log = (m: string) => {
  if (process.stdout.isTTY || process.env.DAILY_REVIEW_VERBOSE) console.log(`[daily-review] ${m}`);
};

function lock(): (() => void) | null {
  const file = path.join(analyticsDir(), "rollup.lock");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const st = fs.statSync(file);
    if (Date.now() - st.mtimeMs < 10 * 60_000) return null; // another rollup is running
  } catch {
    /* free */
  }
  fs.writeFileSync(file, String(process.pid));
  return () => fs.rmSync(file, { force: true });
}

function atOrAfter(hhmm: string, now = new Date()): boolean {
  const [h, m] = hhmm.split(":").map(Number);
  return now.getHours() * 60 + now.getMinutes() >= (h ?? 0) * 60 + (m ?? 0);
}

async function refresh(): Promise<void> {
  const t = today();
  const y = addDays(t, -1);
  const yd = readDay(y);
  // Keep re-rolling yesterday until 06:00: runs that were still going at
  // midnight finish overnight and their outcome belongs to that day.
  const from = !yd || yd.partial || new Date().getHours() < 6 ? y : t;
  await rollupRange({ from, to: t, log });
}

async function summarize(date: string, send: boolean, media: string[]): Promise<void> {
  const cfg = loadConfig();
  let day = readDay(date);
  if (!day) {
    await rollupRange({ from: date, to: date, log });
    day = readDay(date);
  }
  if (!day) throw new Error(`no data for ${date}`);
  day.summary = { ...(await generateSummary(day, cfg)), sentAt: day.summary?.sentAt };
  saveDay(day);
  console.log(day.summary.bullets.map((b) => `- ${b}`).join("\n"));
  if (send) {
    const r = await sendTelegram(cfg, telegramText(day));
    console.log(`telegram: ${r.ok ? "sent" : `failed ${r.detail}`}`);
    for (const m of media) {
      const mr = await sendTelegram(
        cfg,
        `Daily review ${date}: ${path.basename(m, path.extname(m))}`,
        m,
      );
      console.log(`telegram media ${path.basename(m)}: ${mr.ok ? "sent" : `failed ${mr.detail}`}`);
    }
    if (r.ok) {
      day.summary.sentAt = Date.now();
      saveDay(day);
    }
  }
}

async function tick(): Promise<void> {
  await refresh();
  const cfg = loadConfig();
  const t = today();
  const day = readDay(t);
  if (!day) return;
  const wantSummary = atOrAfter(cfg.summary.autoTime) && !day.summary;
  const wantSend = cfg.telegram.enabled && atOrAfter(cfg.telegram.time) && !day.summary?.sentAt;
  if (wantSummary || (wantSend && !day.summary)) {
    day.summary = await generateSummary(day, cfg);
    saveDay(day);
  }
  if (wantSend && day.summary) {
    const r = await sendTelegram(cfg, telegramText(day));
    if (r.ok) {
      day.summary.sentAt = Date.now();
      saveDay(day);
    }
  }
}

async function main(): Promise<void> {
  const release = cmd === "show" ? () => {} : lock();
  if (!release) {
    log("another rollup is running; skipping");
    return;
  }
  try {
    switch (cmd) {
      case "backfill": {
        const from = isDayKey(flag("--from"))
          ? flag("--from")!
          : (loadConfig().backfillFrom ?? earliestDataDay());
        const out = await rollupRange({ from, to: today(), log });
        console.log(`backfilled ${out.length} days from ${from}`);
        break;
      }
      case "refresh":
        await refresh();
        break;
      case "day": {
        const d = argv[1];
        if (!isDayKey(d)) throw new Error("usage: day YYYY-MM-DD");
        await rollupRange({ from: d, to: d, log });
        break;
      }
      case "summary": {
        const d = isDayKey(argv[1]) ? argv[1] : today();
        const media = (flag("--media") ?? "").split(",").filter(Boolean);
        await summarize(d, argv.includes("--send"), media);
        break;
      }
      case "tick":
        await tick();
        break;
      case "show": {
        const d = isDayKey(argv[1]) ? argv[1] : today();
        const r = readDay(d);
        console.log(r ? compactDay(r) : `no rollup for ${d}`);
        break;
      }
      default:
        throw new Error(`unknown command ${cmd}`);
    }
  } finally {
    release();
  }
}

main().catch((err) => {
  console.error(`[daily-review] ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
