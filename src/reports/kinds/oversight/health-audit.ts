/**
 * Report kind: `health_audit` (oversight monthly #8).
 *
 * System health: log/report dir sizes, DB sizes, free disk, gateway uptime.
 * Flags the big offenders so monthly housekeeping has a target list.
 */

import type { CollectedReport, ReportKindModule, ReportPayload } from "../../types.js";
import { renderOversightCollected } from "../../oversight/markdown.js";
import { collectHealth, fmtBytes } from "../../oversight/collectors.js";

export const HEALTH_AUDIT_KIND = "health_audit" as const;
const LOG_WARN_BYTES = 1e9; // 1 GB
const FREE_WARN_BYTES = 5e9; // 5 GB

function hms(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d > 0 ? `${d}d ${h}h ${m}m` : `${h}h ${m}m`;
}

export const healthAuditKind: ReportKindModule = {
  kind: HEALTH_AUDIT_KIND,
  collect({ theme, config, stateDir }): CollectedReport {
    const now = typeof config?.now === "number" ? (config.now as number) : Date.now();
    const h = collectHealth({ stateDir });

    const sections: ReportPayload["sections"] = [
      {
        heading: "Storage",
        table: {
          columns: ["Area", "Size"],
          rows: [
            ["Logs", fmtBytes(h.logsBytes)],
            ["Reports", fmtBytes(h.reportsBytes)],
            ["Free disk", h.freeBytes == null ? "unknown" : fmtBytes(h.freeBytes)],
          ],
        },
      },
      {
        heading: "Databases",
        count: h.dbBytes.length,
        table: {
          columns: ["File", "Size"],
          rows: h.dbBytes.slice(0, 25).map((d) => [d.name, fmtBytes(d.bytes)]),
        },
      },
      {
        heading: "Runtime",
        body: `Gateway uptime: ${hms(h.uptimeSec)}`,
      },
    ];
    if (h.gaps.length) sections.push({ heading: "Data gaps", bullets: h.gaps });

    const topActions: string[] = [];
    if (h.logsBytes >= LOG_WARN_BYTES)
      topActions.push(`Rotate logs — ${fmtBytes(h.logsBytes)} on disk.`);
    if (h.freeBytes != null && h.freeBytes < FREE_WARN_BYTES)
      topActions.push(`Free disk low (${fmtBytes(h.freeBytes)}) — clean up.`);
    if (h.dbBytes[0] && h.dbBytes[0].bytes > 5e8)
      topActions.push(
        `Largest DB ${h.dbBytes[0].name} is ${fmtBytes(h.dbBytes[0].bytes)} — consider vacuum/prune.`,
      );
    if (!topActions.length) topActions.push("System healthy — no housekeeping required.");

    const payload: ReportPayload = {
      title: `Health Audit — ${new Date(now).toLocaleDateString()}`,
      subtitle: "Disk, logs, databases, and uptime.",
      eyebrow: "InfiniBot · Oversight",
      generatedAt: now,
      metrics: [
        { label: "Logs", value: fmtBytes(h.logsBytes) },
        { label: "Free", value: h.freeBytes == null ? "?" : fmtBytes(h.freeBytes) },
        { label: "Uptime", value: hms(h.uptimeSec) },
      ],
      sections,
      footer: "health_audit",
    };

    return renderOversightCollected({
      slug: "health-audit",
      freq: "monthly",
      payload,
      theme,
      topActions,
      summaryText: `logs ${fmtBytes(h.logsBytes)} · free ${h.freeBytes == null ? "?" : fmtBytes(h.freeBytes)} · up ${hms(h.uptimeSec)}`,
      stateDir,
      now,
    });
  },
};

export default healthAuditKind;
