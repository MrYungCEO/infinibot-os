/**
 * Oversight report kinds — barrel. These are the worker-rendered kinds behind
 * the default oversight crons (see src/cron/oversight-jobs.ts). `inbox_triage`
 * is intentionally NOT here: unread DMs/threads live only in the live gateway
 * session feed, which the out-of-process report worker cannot read, so that one
 * is produced by a main-session gather+render nudge instead.
 */

import type { ReportKindModule } from "../../types.js";
import { morningBriefKind } from "./morning-brief.js";
import { driftDigestKind } from "./drift-digest.js";
import { velocityReportKind } from "./velocity-report.js";
import { costReportKind } from "./cost-report.js";
import { clientSnapshotKind } from "./client-snapshot.js";
import { followupsReportKind } from "./followups-report.js";
import { healthAuditKind } from "./health-audit.js";
import { memoryHygieneKind } from "./memory-hygiene.js";
import { oversightEventKind } from "./event-report.js";

export const OVERSIGHT_KINDS: ReportKindModule[] = [
  morningBriefKind,
  driftDigestKind,
  velocityReportKind,
  costReportKind,
  clientSnapshotKind,
  followupsReportKind,
  healthAuditKind,
  memoryHygieneKind,
  oversightEventKind,
];

export {
  morningBriefKind,
  driftDigestKind,
  velocityReportKind,
  costReportKind,
  clientSnapshotKind,
  followupsReportKind,
  healthAuditKind,
  memoryHygieneKind,
  oversightEventKind,
};
