/**
 * Issues agent tool — lets agents log, read, update, and resolve entries in the
 * System Issues / Improvement Log (K.I.S.).
 *
 * Routes through the same SQLite-backed `IssuesStore` the gateway `issues.*`
 * handlers and the UI read from, so every write path is a single source of
 * truth.
 */

import { Type } from "@sinclair/typebox";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";
import { getIssuesStore } from "../../issues/store.js";
import type {
  IssueCreateParams,
  IssueSearchParams,
  IssueUpdateParams,
} from "../../issues/types.js";
import {
  ISSUE_PRIORITIES,
  ISSUE_SEVERITIES,
  ISSUE_STATUSES,
  ISSUE_TYPES,
} from "../../issues/types.js";

const ISSUE_ACTIONS = ["list", "get", "create", "update", "delete", "search"] as const;

const IssuesToolSchema = Type.Object({
  action: stringEnum(ISSUE_ACTIONS),
  /** Issue id (for get/update/delete). */
  id: Type.Optional(Type.String()),
  /** Short one-line issue title (required on create). */
  title: Type.Optional(Type.String()),
  issueType: Type.Optional(stringEnum(ISSUE_TYPES)),
  description: Type.Optional(Type.String()),
  reportedBy: Type.Optional(Type.String()),
  /** ISO date YYYY-MM-DD. Defaults to today on create. */
  dateReported: Type.Optional(Type.String()),
  relatedObject: Type.Optional(Type.String()),
  relatedProject: Type.Optional(Type.String()),
  relatedWorkflow: Type.Optional(Type.String()),
  /** Kanban project id to link this issue to. */
  projectId: Type.Optional(Type.String()),
  frequency: Type.Optional(Type.String()),
  businessImpact: Type.Optional(Type.String()),
  timeWasted: Type.Optional(Type.String()),
  severity: Type.Optional(stringEnum(ISSUE_SEVERITIES)),
  priority: Type.Optional(stringEnum(ISSUE_PRIORITIES)),
  temporaryWorkaround: Type.Optional(Type.String()),
  rootCause: Type.Optional(Type.String()),
  assignedOwner: Type.Optional(Type.String()),
  status: Type.Optional(stringEnum(ISSUE_STATUSES)),
  proposedFix: Type.Optional(Type.String()),
  targetFixDate: Type.Optional(Type.String()),
  dateFixed: Type.Optional(Type.String()),
  testedBy: Type.Optional(Type.String()),
  resolutionNotes: Type.Optional(Type.String()),
  recurring: Type.Optional(Type.Boolean()),
  automationCandidate: Type.Optional(Type.Boolean()),
  ceoInputRequired: Type.Optional(Type.Boolean()),
  /** Free-text search query (for search/list). */
  query: Type.Optional(Type.String()),
  /** Max results to return. */
  limit: Type.Optional(Type.Number()),
});

/** Pull all create/update-shaped fields out of a raw params object. */
function collectFields(params: Record<string, unknown>): Partial<IssueCreateParams> {
  const str = (k: string) => readStringParam(params, k) || undefined;
  const bool = (k: string) => (typeof params[k] === "boolean" ? (params[k] as boolean) : undefined);
  return {
    title: str("title"),
    issueType: str("issueType"),
    description: str("description"),
    reportedBy: str("reportedBy"),
    dateReported: str("dateReported"),
    relatedObject: str("relatedObject"),
    relatedProject: str("relatedProject"),
    relatedWorkflow: str("relatedWorkflow"),
    projectId: str("projectId"),
    frequency: str("frequency"),
    businessImpact: str("businessImpact"),
    timeWasted: str("timeWasted"),
    severity: str("severity"),
    priority: str("priority"),
    temporaryWorkaround: str("temporaryWorkaround"),
    rootCause: str("rootCause"),
    assignedOwner: str("assignedOwner"),
    status: str("status"),
    proposedFix: str("proposedFix"),
    targetFixDate: str("targetFixDate"),
    dateFixed: str("dateFixed"),
    testedBy: str("testedBy"),
    resolutionNotes: str("resolutionNotes"),
    recurring: bool("recurring"),
    automationCandidate: bool("automationCandidate"),
    ceoInputRequired: bool("ceoInputRequired"),
  };
}

export function createIssuesTool(_options?: { agentId?: string }): AnyAgentTool {
  return {
    label: "Issues",
    name: "issues",
    description:
      `Log and manage entries in the System Issues / Improvement Log (K.I.S.) — ` +
      `bugs, broken functions, automation/agent failures, data/integration issues, ` +
      `workflow inefficiencies, duplicate work, UX problems, missing features, ` +
      `performance issues, and improvement opportunities. Actions: ` +
      `list (all issues, supports filters), ` +
      `search (find by query/status/severity/priority), ` +
      `get (read one by id), ` +
      `create (log a new issue — title required), ` +
      `update (patch fields by id, e.g. set status/rootCause/resolutionNotes), ` +
      `delete (remove by id). ` +
      `projectId links an issue to a kanban project.`,
    parameters: IssuesToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const store = getIssuesStore();

      try {
        switch (action) {
          case "list":
          case "search": {
            const search: IssueSearchParams = {
              query: readStringParam(params, "query") || undefined,
              issueType: readStringParam(params, "issueType") || undefined,
              severity: readStringParam(params, "severity") || undefined,
              priority: readStringParam(params, "priority") || undefined,
              status: readStringParam(params, "status") || undefined,
              assignedOwner: readStringParam(params, "assignedOwner") || undefined,
              projectId: readStringParam(params, "projectId") || undefined,
              limit: typeof params.limit === "number" ? (params.limit as number) : undefined,
            };
            const issues = store.list(search);
            return jsonResult({ status: "ok", count: issues.length, issues });
          }

          case "get": {
            const id = readStringParam(params, "id", { required: true });
            const issue = store.get(id);
            if (!issue) return jsonResult({ status: "error", error: `Issue "${id}" not found` });
            return jsonResult({ status: "ok", issue });
          }

          case "create": {
            const fields = collectFields(params);
            if (!fields.title) {
              return jsonResult({ status: "error", error: "title is required" });
            }
            const issue = store.create(fields as IssueCreateParams);
            return jsonResult({ status: "ok", issue });
          }

          case "update": {
            const id = readStringParam(params, "id", { required: true });
            const patch = collectFields(params);
            const issue = store.update({ ...patch, id } as IssueUpdateParams);
            if (!issue) return jsonResult({ status: "error", error: `Issue "${id}" not found` });
            return jsonResult({ status: "ok", issue });
          }

          case "delete": {
            const id = readStringParam(params, "id", { required: true });
            const ok = store.delete(id);
            if (!ok) return jsonResult({ status: "error", error: `Issue "${id}" not found` });
            return jsonResult({ status: "ok", deleted: true, id });
          }

          default:
            return jsonResult({ status: "error", error: `Unknown action "${action}"` });
        }
      } catch (e) {
        return jsonResult({ status: "error", error: String(e) });
      }
    },
  };
}
