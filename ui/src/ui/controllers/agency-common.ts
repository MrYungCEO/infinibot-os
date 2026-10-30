/**
 * Small shared primitives for the agency surfaces that sit on top of the
 * `agency.ops.*` RPC family (Topology and Daily Operations).
 *
 * The rules encoded here are the ones the Operations Center already follows and
 * that both new surfaces must not break:
 *  - every panel request is fault isolated, so one dead RPC cannot blank a page;
 *  - a failure is *recorded*, because an empty table and a table we could not
 *    fetch look identical to an operator otherwise;
 *  - responses are unwrapped defensively — handlers return `{ clients: [...] }`
 *    today but older/newer gateways may return the bare array.
 */

import type { GatewayBrowserClient } from "../gateway";
import { getBizFilter } from "../lib/biz-filter";

export interface AgencyRef {
  id: string;
  name: string;
  role: "owner" | "admin" | "member" | "viewer";
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function unwrap<T>(value: unknown, key: string, fallback: T): T {
  if (value && typeof value === "object" && key in value) {
    const inner = (value as Record<string, unknown>)[key];
    return (inner as T) ?? fallback;
  }
  return (value as T) ?? fallback;
}

/**
 * Issues one panel request. A rejection is captured in `failures` instead of
 * propagating, so `Promise.all` over a batch always resolves and the surface can
 * render everything that *did* load while still naming what did not.
 */
export function attempt(
  client: GatewayBrowserClient,
  failures: string[],
  method: string,
  params: unknown,
): Promise<unknown> {
  return client.request(method, params).catch((error: unknown) => {
    const entry = `${method} — ${errorMessage(error)}`;
    if (!failures.includes(entry)) failures.push(entry);
    return null;
  });
}

/**
 * Resolves the agency both surfaces operate on. The global business filter is
 * the same workspace boundary the Operations Center, Projects and CRM already
 * use, so switching there switches here too; otherwise fall back to the agency
 * this operator owns.
 */
export async function resolveAgency(
  client: GatewayBrowserClient,
  failures: string[],
): Promise<{ agencies: AgencyRef[]; agencyId: string | null; agencyName: string }> {
  const result = await attempt(client, failures, "agency.ops.agencies.list", {});
  const agencies = unwrap<AgencyRef[]>(result, "agencies", []);
  const preferred = getBizFilter();
  const selected =
    agencies.find((agency) => agency.id === preferred) ??
    agencies.find((agency) => agency.role === "owner") ??
    agencies[0] ??
    null;
  return {
    agencies,
    agencyId: selected?.id ?? null,
    agencyName: selected?.name ?? "",
  };
}

/** Cents → a compact currency string. Agency money is stored in cents. */
export function money(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format((cents || 0) / 100);
}

export function relativeTime(value: number | null | undefined): string {
  if (!value) return "never";
  const delta = Date.now() - value;
  const abs = Math.abs(delta);
  const minutes = Math.round(abs / 60_000);
  if (minutes < 1) return delta >= 0 ? "just now" : "in under a minute";
  if (minutes < 60) return delta >= 0 ? `${minutes}m ago` : `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return delta >= 0 ? `${hours}h ago` : `in ${hours}h`;
  const days = Math.round(hours / 24);
  return delta >= 0 ? `${days}d ago` : `in ${days}d`;
}

export function clockTime(value: number | null | undefined): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}
