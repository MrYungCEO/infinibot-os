/**
 * Financial Commitments controller — data layer for the commitment ledger view.
 *
 * Mirrors the role of `controllers/clients.ts`: it owns the typed shapes and the
 * thin async calls to the gateway `commitment.*` RPCs, so the view
 * (`views/commitment.ts`) stays presentation-only. All money amounts are in the
 * same currency base units the store persists.
 */

import type { GatewayBrowserClient } from "../gateway";

// ── Enums (kept in sync with src/commitment/types.ts) ──
export const COMMITMENT_TYPES = [
  "Client Invoice",
  "Deposit",
  "Milestone Payment",
  "Recurring Revenue",
  "Contractor Payment",
  "Vendor Commitment",
  "Project Expense",
] as const;

export const COMMITMENT_DIRECTIONS = ["Money In", "Money Out"] as const;

export const COMMITMENT_STATUSES = [
  "Expected",
  "Invoiced",
  "Partially Paid",
  "Paid",
  "Overdue",
  "Cancelled",
] as const;

export const PRIORITIES = ["P0", "P1", "P2", "P3"] as const;

// ── Types ──
export interface Commitment {
  id: string;
  name: string;
  commitmentType: string;
  direction: string;
  status: string;
  amount: number;
  dueDate: string;
  amountPaid: number;
  remainingBalance: number;
  overdue: boolean;
  sourceDocumentLink: string;
  owner: string;
  supportingOwner?: string;
  ceoRequired?: boolean;
  priority: string;
  nextAction?: string;
  nextActionOwner?: string;
  nextActionDate?: string;
  clientId?: string;
  opportunityId?: string;
  projectId?: string;
  productId?: string;
  dataQuality?: string;
  authorityLevel?: string;
  createdAt: number;
  updatedAt: number;
}

export type CommitmentDraft = Partial<Commitment>;

export interface CommitmentAggregates {
  moneyExpected: number;
  moneyOwed: number;
  moneyOverdue: number;
  depositsNotReceived: number;
  workProceedingWithoutPayment: {
    count: number;
    amount: number;
    projectIds: string[];
    commitmentIds: string[];
  };
  overdueCount: number;
  total: number;
}

export interface CommitmentSearch {
  query?: string;
  commitmentType?: string;
  direction?: string;
  status?: string;
  owner?: string;
  clientId?: string;
  projectId?: string;
  overdueOnly?: boolean;
  limit?: number;
}

// ── RPC calls ──
export async function fetchCommitments(
  client: GatewayBrowserClient,
  search: CommitmentSearch = {},
): Promise<Commitment[]> {
  const res = (await client.request("commitment.list", search)) as {
    commitments?: Commitment[];
  };
  return res?.commitments ?? [];
}

export async function fetchAggregates(
  client: GatewayBrowserClient,
  search: CommitmentSearch = {},
): Promise<CommitmentAggregates> {
  return (await client.request("commitment.aggregates", search)) as CommitmentAggregates;
}

export async function createCommitment(
  client: GatewayBrowserClient,
  draft: CommitmentDraft,
): Promise<Commitment> {
  const { remainingBalance: _r, overdue: _o, ...payload } = draft;
  return (await client.request("commitment.create", {
    ...payload,
    createdBy: "control-ui",
  })) as Commitment;
}

export async function updateCommitment(
  client: GatewayBrowserClient,
  id: string,
  draft: CommitmentDraft,
): Promise<Commitment> {
  const { remainingBalance: _r, overdue: _o, ...payload } = draft;
  return (await client.request("commitment.update", {
    ...payload,
    id,
    createdBy: "control-ui",
  })) as Commitment;
}

export async function deleteCommitment(
  client: GatewayBrowserClient,
  id: string,
): Promise<void> {
  await client.request("commitment.delete", { id });
}

// ── Formatting helpers ──
export function formatMoney(amount: number | undefined | null): string {
  const n = Number(amount ?? 0);
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
}

export function isMoneyIn(c: { direction?: string }): boolean {
  return c.direction === "Money In";
}
