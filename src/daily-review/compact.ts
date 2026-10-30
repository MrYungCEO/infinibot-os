/**
 * Compact plain-text renderings for agents, voice and the AI summary prompt.
 * Always capped: one oversized tool result poisons a 128k voice session.
 */
import type { DayIndexEntry, DayRollup } from "./types.js";

export const COMPACT_CAP = 6000;

const money = (n: number) => `$${n >= 100 ? Math.round(n) : n.toFixed(2)}`;
const hrs = (min: number) => `${(min / 60).toFixed(1)} h`;

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 20)}\n… (truncated)` : text;
}

export function compactDay(d: DayRollup, max = COMPACT_CAP): string {
  const t = d.totals;
  const s = d.score;
  const lines: string[] = [];
  lines.push(
    `Daily review ${d.date}${d.partial ? " (so far today)" : ""}: score ${s.value}/100 (${s.grade}); ${s.net} points vs a 14-day baseline of ${s.baseline} (${s.ratio}x).`,
  );
  lines.push(
    `Agent tasks: ${t.runs} (${t.verified} verified, ${t.unverified} unverified, ${t.failed} failed, ${t.needsYou} need you, ${t.running} running); ${hrs(t.agentMinutes)} of agent time; ${money(t.costUsd)} spent; ${t.activeHours} active hours.`,
  );
  lines.push(
    `Git: ${t.commits} commits + ${t.merges} merges in ${t.reposTouched} repos. Deploys: ${t.deploys}. Kanban: ${t.kanbanCompleted} done, ${t.kanbanCreated} created. Reports: ${t.reports}. Telegram sends: ${t.telegramSends}. Incidents: ${t.incidents}${t.oomKills ? ` (${t.oomKills} OOM)` : ""}.`,
  );
  const totalMin = d.byProject.reduce((a, p) => a + p.minutes, 0) || 1;
  if (d.byProject.length) {
    lines.push(
      `By project: ${d.byProject
        .slice(0, 6)
        .map(
          (p) =>
            `${p.name} ${Math.round((100 * p.minutes) / totalMin)}% (${p.runs} tasks, ${p.verified} verified)`,
        )
        .join("; ")}.`,
    );
  }
  if (d.byCategory.length)
    lines.push(`By type: ${d.byCategory.map((c) => `${c.name} ${c.runs}`).join(", ")}.`);
  if (d.byBackend.length)
    lines.push(`By backend: ${d.byBackend.map((c) => `${c.name} ${c.runs}`).join(", ")}.`);
  if (d.accomplishments.length) {
    lines.push("Shipped:");
    for (const a of d.accomplishments.slice(0, 8))
      lines.push(`- [${a.kind}] ${a.project}: ${a.title}`);
  }
  if (d.needsYou.length) {
    lines.push("Needs you:");
    for (const n of d.needsYou.slice(0, 6)) lines.push(`- ${n.project}: ${n.title} (${n.reason})`);
  }
  if (d.inProgress.length) {
    lines.push("In progress:");
    for (const n of d.inProgress.slice(0, 5)) lines.push(`- ${n.project}: ${n.title}`);
  }
  if (d.summary?.bullets.length) {
    lines.push("End-of-day summary:");
    for (const b of d.summary.bullets) lines.push(`- ${b}`);
  }
  return cap(lines.join("\n"), max);
}

export function compactRange(entries: DayIndexEntry[], max = COMPACT_CAP): string {
  if (!entries.length) return "No daily review data for that range.";
  const sum = (k: keyof DayIndexEntry) => entries.reduce((a, e) => a + (Number(e[k]) || 0), 0);
  const active = entries.filter((e) => e.net > 0);
  const avg = active.length
    ? Math.round(active.reduce((a, e) => a + e.score, 0) / active.length)
    : 0;
  const best = [...entries].sort((a, b) => b.score - a.score).slice(0, 3);
  const projects = new Map<string, number>();
  for (const e of entries)
    for (const p of e.projects) projects.set(p.name, (projects.get(p.name) ?? 0) + p.minutes);
  const pTotal = [...projects.values()].reduce((a, b) => a + b, 0) || 1;
  const lines = [
    `Daily review ${entries[0]!.date} to ${entries[entries.length - 1]!.date}: ${active.length} active days, average score ${avg}.`,
    `Totals: ${sum("verified")} verified tasks, ${sum("failed")} failed, ${sum("commits")} commits, ${sum("deploys")} deploys, ${sum("kanbanCompleted")} kanban done, ${money(sum("costUsd"))} spent, ${hrs(sum("agentMinutes"))} of agent time.`,
    `Best days: ${best.map((b) => `${b.date} (${b.score})`).join(", ")}.`,
    `Where the time went: ${[...projects.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([n, m]) => `${n} ${Math.round((100 * m) / pTotal)}%`)
      .join(", ")}.`,
    "Per day (date score verified/failed commits deploys cost):",
    ...entries
      .slice(-31)
      .map(
        (e) =>
          `${e.date} ${e.score} ${e.verified}/${e.failed} ${e.commits} ${e.deploys} ${money(e.costUsd)}`,
      ),
  ];
  return cap(lines.join("\n"), max);
}
