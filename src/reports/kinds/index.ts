/**
 * Report kind registry. New kinds drop in by importing their module here and
 * adding it to REGISTRY. `getKind(name)` returns null for unknown kinds so the
 * worker can fail the row gracefully instead of crashing.
 */

import type { ReportKindModule } from "../types.js";
import { ceoHourlyReportKind } from "./ceo-hourly.js";
import { dailySummaryKind } from "./daily-summary.js";
import { gatewayRecoveryKind } from "./gateway-recovery.js";
import { invoiceReportKind } from "./invoice.js";
import { proposalReportKind } from "./proposal.js";
import { OVERSIGHT_KINDS } from "./oversight/index.js";

const REGISTRY: Record<string, ReportKindModule> = {
  [gatewayRecoveryKind.kind]: gatewayRecoveryKind,
  [ceoHourlyReportKind.kind]: ceoHourlyReportKind,
  [dailySummaryKind.kind]: dailySummaryKind,
  [invoiceReportKind.kind]: invoiceReportKind,
  [proposalReportKind.kind]: proposalReportKind,
  ...Object.fromEntries(OVERSIGHT_KINDS.map((k) => [k.kind, k])),
};

export function getKind(kind: string): ReportKindModule | null {
  return REGISTRY[kind] ?? null;
}

export function listKinds(): string[] {
  return Object.keys(REGISTRY);
}
