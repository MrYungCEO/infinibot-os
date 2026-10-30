/**
 * Report kind: `memory_hygiene` (oversight monthly #9).
 *
 * Scans the agent memory workspace for empty/orphaned files and oversized index
 * files (a MEMORY.md over budget can no longer be fully loaded into context).
 */

import type { CollectedReport, ReportKindModule, ReportPayload } from "../../types.js";
import { renderOversightCollected } from "../../oversight/markdown.js";
import { collectMemoryHygiene, fmtBytes } from "../../oversight/collectors.js";

export const MEMORY_HYGIENE_KIND = "memory_hygiene" as const;

export const memoryHygieneKind: ReportKindModule = {
  kind: MEMORY_HYGIENE_KIND,
  async collect({ theme, config, stateDir }): Promise<CollectedReport> {
    const now = typeof config?.now === "number" ? (config.now as number) : Date.now();
    const workspaceDir =
      typeof config?.workspaceDir === "string" ? (config.workspaceDir as string) : undefined;
    const m = await collectMemoryHygiene({ workspaceDir });

    const sections: ReportPayload["sections"] = [
      { heading: "Workspace", body: `Scanned \`${m.workspaceDir}\` — ${m.total} memory file(s).` },
      {
        heading: "Empty / orphaned files",
        count: m.empty.length,
        bullets: m.empty.length ? m.empty : ["none"],
      },
      {
        heading: "Oversized files (> 24 KB)",
        count: m.large.length,
        table: {
          columns: ["File", "Size"],
          rows: m.large.map((f) => [f.path, fmtBytes(f.bytes)]),
        },
      },
    ];
    if (m.gaps.length) sections.push({ heading: "Data gaps", bullets: m.gaps });

    const topActions: string[] = [];
    if (m.empty.length) topActions.push(`Delete ${m.empty.length} empty memory file(s).`);
    for (const f of m.large.slice(0, 2))
      topActions.push(`Trim ${f.path} (${fmtBytes(f.bytes)}) — move detail into topic files.`);
    if (!topActions.length) topActions.push("Memory is tidy — no hygiene action needed.");

    const payload: ReportPayload = {
      title: `Memory Hygiene — ${new Date(now).toLocaleDateString()}`,
      subtitle: "Empty, orphaned, and oversized agent-memory files.",
      eyebrow: "InfiniBot · Oversight",
      generatedAt: now,
      metrics: [
        { label: "Files", value: m.total },
        { label: "Empty", value: m.empty.length },
        { label: "Oversized", value: m.large.length },
      ],
      sections,
      footer: "memory_hygiene",
    };

    return renderOversightCollected({
      slug: "memory-hygiene",
      freq: "monthly",
      payload,
      theme,
      topActions,
      summaryText: `${m.total} file(s) · ${m.empty.length} empty · ${m.large.length} oversized`,
      stateDir,
      now,
    });
  },
};

export default memoryHygieneKind;
