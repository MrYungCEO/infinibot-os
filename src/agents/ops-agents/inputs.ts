/**
 * `collectOpsInputs()` — the ONE place the ops agents read the live singleton
 * stores. It assembles an `OpsInputs` snapshot; every agent core function is
 * pure over that snapshot (so tests seed a snapshot directly, no SQLite).
 *
 * Read-only: no store is mutated here. Kanban tasks/projects are async; the
 * six KIS object stores are synchronous.
 */

import type { OpsInputs } from "./types.js";
import { getKanbanStore } from "../../tasks/store.js";
import { getOpportunityStore } from "../../opportunity/store.js";
import { getDecisionStore } from "../../decision/store.js";
import { getRiskStore } from "../../risk/store.js";
import { getCommitmentStore } from "../../commitment/store.js";
import { getPersonStore } from "../../person/store.js";
import { getIssuesStore } from "../../issues/store.js";

/**
 * Read every store and return a snapshot. `now` defaults to the wall clock but
 * can be pinned by callers/tests. `stateDir` is forwarded to each store factory
 * so a non-default profile can be targeted.
 */
export async function collectOpsInputs(opts: {
  now?: number;
  stateDir?: string;
} = {}): Promise<OpsInputs> {
  const now = opts.now ?? Date.now();
  const dir = opts.stateDir;

  const kanban = getKanbanStore(dir);
  const [projects, tasks] = await Promise.all([kanban.getProjects(), kanban.getTasks()]);

  return {
    now,
    projects,
    tasks,
    opportunities: getOpportunityStore(dir).list({ limit: 1000 }),
    decisions: getDecisionStore(dir).list({ limit: 1000 }),
    risks: getRiskStore(dir).list({ limit: 1000 }),
    commitments: getCommitmentStore(dir).list({ limit: 1000 }),
    persons: getPersonStore(dir).list({ limit: 1000 }),
    issues: getIssuesStore(dir).list({ limit: 1000 }),
  };
}
