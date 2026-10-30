/**
 * Report kind: `oversight_event` — the generic on-event report backing the
 * proactive event rules (#14 sub-agent failure, #15 Notion sync error,
 * #16 critical kanban transition).
 *
 * Event-driven, not scheduled: a firing site calls `fireEventTriggers(eventType,
 * config)` (see src/reports/trigger.ts) and the worker renders this kind with
 * whatever the firing site put in `config`. So one kind serves every event rule;
 * the rule's `eventType` + the config shape it.
 *
 * Recognised config fields (all optional, all best-effort):
 *   eventType, title, summary, details, stderrTail, rowId, runId, taskId,
 *   actions (string[]).
 */

import type { CollectedReport, ReportKindModule, ReportPayload } from "../../types.js";
import { renderOversightCollected } from "../../oversight/markdown.js";

export const OVERSIGHT_EVENT_KIND = "oversight_event" as const;

export const oversightEventKind: ReportKindModule = {
  kind: OVERSIGHT_EVENT_KIND,
  collect({ theme, config, stateDir }): CollectedReport {
    const now = typeof config?.now === "number" ? (config.now as number) : Date.now();
    const eventType = String(config?.eventType ?? "event");
    const title = String(config?.title ?? `Oversight event — ${eventType}`);
    const summary = String(config?.summary ?? "");
    const details = typeof config?.details === "string" ? config.details : "";
    const stderrTail = typeof config?.stderrTail === "string" ? config.stderrTail : "";
    const actions = Array.isArray(config?.actions)
      ? (config.actions as unknown[]).map(String).filter(Boolean)
      : [];

    const idBits: string[] = [];
    for (const k of ["runId", "taskId", "rowId"] as const) {
      if (config?.[k]) idBits.push(`${k}=${String(config[k])}`);
    }

    const sections: ReportPayload["sections"] = [];
    if (summary) sections.push({ heading: "What happened", body: summary });
    if (idBits.length) sections.push({ heading: "References", code: idBits.join("\n") });
    if (details) sections.push({ heading: "Details", code: details });
    if (stderrTail) sections.push({ heading: "stderr (tail)", code: stderrTail });
    if (!sections.length) sections.push({ heading: "Event", body: `Fired: ${eventType}` });

    const topActions = actions.length
      ? actions
      : ["Review the event above and decide whether action is needed."];

    const payload: ReportPayload = {
      title,
      subtitle: `Event-driven oversight alert (${eventType}).`,
      eyebrow: "InfiniBot · Oversight",
      generatedAt: now,
      metrics: [{ label: "Event", value: eventType }],
      sections,
      footer: "oversight_event",
    };

    return renderOversightCollected({
      slug: `event-${eventType}`,
      freq: "continuous",
      payload,
      theme,
      topActions,
      summaryText: summary || `Event: ${eventType}`,
      stateDir,
      now,
    });
  },
};

export default oversightEventKind;
