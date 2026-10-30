/**
 * System Issues / Improvement Log (K.I.S.) — shared types.
 *
 * A structured tracker for capturing technical/operational problems inside the
 * InfiniBot AI operating system: bugs, broken functions, failed automations,
 * agent errors, workflow friction, duplicated work, missing automations, and
 * improvement opportunities. See the product spec ("System Issues / Improvement
 * Log") for the field-by-field rationale.
 */

export const ISSUE_TYPES = [
  "Bug",
  "Broken Function",
  "Automation Failure",
  "Agent Failure",
  "Data Issue",
  "Integration Issue",
  "Workflow Inefficiency",
  "Duplicate Work",
  "UX/Usability Issue",
  "Missing Feature",
  "Performance Issue",
  "Process Problem",
  "Improvement Opportunity",
] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];

export const ISSUE_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type IssueSeverity = (typeof ISSUE_SEVERITIES)[number];

export const ISSUE_PRIORITIES = ["low", "medium", "high", "critical"] as const;
export type IssuePriority = (typeof ISSUE_PRIORITIES)[number];

export const ISSUE_STATUSES = [
  "open",
  "triaged",
  "in_progress",
  "fixed",
  "verified",
  "wont_fix",
] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

/**
 * A file attached to an issue (screenshots / images). Mirrors the kanban
 * project-attachment shape so the UI + file-serving story is identical:
 * bytes live under `<state-dir>/files/issues/<issueId>/<sha256><ext>` and the
 * relative `path` is what `files.download` resolves against FILES_ROOT.
 */
export interface IssueAttachment {
  id: string;
  issueId: string;
  name: string;
  /** Relative to the files root, e.g. `issues/<issueId>/<sha256>.png`. */
  path: string;
  mimeType: string;
  size: number;
  sha256: string;
  createdAt: number;
}

/** Fields accepted when attaching a file to an issue. */
export interface IssueAttachmentCreateParams {
  issueId: string;
  name: string;
  path: string;
  mimeType: string;
  size: number;
  sha256: string;
}

/** A fully-materialized issue record as stored + returned by the store. */
export interface Issue {
  id: string;
  // ── Identification / classification ──
  title: string;
  issueType: IssueType | string;
  description: string;
  reportedBy: string;
  /** ISO date (YYYY-MM-DD) the issue was reported. */
  dateReported: string;
  // ── Context / linkage ──
  relatedObject: string;
  relatedProject: string;
  relatedWorkflow: string;
  /** Optional kanban project id this issue is linked to (like notes.projectId). */
  projectId?: string;
  // ── Impact ──
  frequency: string;
  businessImpact: string;
  timeWasted: string;
  severity: IssueSeverity | string;
  priority: IssuePriority | string;
  // ── Diagnosis ──
  temporaryWorkaround: string;
  rootCause: string;
  assignedOwner: string;
  status: IssueStatus | string;
  // ── Resolution ──
  proposedFix: string;
  /** ISO date (YYYY-MM-DD). */
  targetFixDate: string;
  /** ISO date (YYYY-MM-DD). */
  dateFixed: string;
  testedBy: string;
  resolutionNotes: string;
  // ── Flags ──
  recurring: boolean;
  automationCandidate: boolean;
  ceoInputRequired: boolean;
  // ── Timestamps (Unix ms) ──
  createdAt: number;
  updatedAt: number;
  // ── Attachments (screenshots/images) ──
  /** Populated by list()/get(); empty when the issue has no files. */
  attachments?: IssueAttachment[];
}

/** Fields accepted on create. `title` is the only hard requirement. */
export interface IssueCreateParams {
  title: string;
  issueType?: string;
  description?: string;
  reportedBy?: string;
  dateReported?: string;
  relatedObject?: string;
  relatedProject?: string;
  relatedWorkflow?: string;
  projectId?: string;
  frequency?: string;
  businessImpact?: string;
  timeWasted?: string;
  severity?: string;
  priority?: string;
  temporaryWorkaround?: string;
  rootCause?: string;
  assignedOwner?: string;
  status?: string;
  proposedFix?: string;
  targetFixDate?: string;
  dateFixed?: string;
  testedBy?: string;
  resolutionNotes?: string;
  recurring?: boolean;
  automationCandidate?: boolean;
  ceoInputRequired?: boolean;
  /** Optional idempotency key — a second create with the same id no-ops. */
  clientRequestId?: string;
}

/** Partial patch on update; `id` identifies the row. */
export interface IssueUpdateParams extends Partial<IssueCreateParams> {
  id: string;
}

export interface IssueSearchParams {
  query?: string;
  issueType?: string;
  severity?: string;
  priority?: string;
  status?: string;
  assignedOwner?: string;
  projectId?: string;
  /** Only return issues updated after this Unix-ms timestamp. */
  since?: number;
  limit?: number;
}
