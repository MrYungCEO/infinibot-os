/**
 * Subagent history gateway handler — serves the persistent archive of
 * completed/errored/timeout runs to the Agents page history feed.
 *
 * Reads from the archive maintained by src/agents/subagent-history.ts.  This
 * is a thin wrapper that validates params and forwards to listSubagentHistory.
 */

import {
  listSubagentHistory,
  type HistoryStatus,
  type SubagentHistoryEntry,
} from "../../agents/subagent-history.js";
import type { GatewayRequestHandlers } from "./types.js";

const ALLOWED_STATUSES: ReadonlySet<HistoryStatus> = new Set(["complete", "error", "timeout"]);

function coerceStatusFilter(input: unknown): HistoryStatus[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const out: HistoryStatus[] = [];
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    if (ALLOWED_STATUSES.has(raw as HistoryStatus)) out.push(raw as HistoryStatus);
  }
  return out.length > 0 ? out : undefined;
}

export const subagentsHistoryHandlers: GatewayRequestHandlers = {
  "subagents.history": ({ params, respond }) => {
    const limit =
      typeof params?.limit === "number" && params.limit > 0
        ? Math.min(Math.floor(params.limit), 500)
        : 30;
    const since =
      typeof params?.since === "number" && Number.isFinite(params.since) && params.since > 0
        ? params.since
        : undefined;
    const statusFilter = coerceStatusFilter(params?.statusFilter);
    const requesterSessionKey =
      typeof params?.requesterSessionKey === "string" && params.requesterSessionKey.length > 0
        ? params.requesterSessionKey
        : undefined;

    const { entries, total } = listSubagentHistory({
      limit,
      since,
      statusFilter,
      requesterSessionKey,
    });

    respond(
      true,
      {
        ok: true,
        history: entries as SubagentHistoryEntry[],
        total,
        serverTime: Date.now(),
      },
      undefined,
    );
  },
};
