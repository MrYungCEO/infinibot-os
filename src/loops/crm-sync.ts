/**
 * One-way sync: InfiniBot CRM rows → Loops contacts.
 *
 * Loops is the source of truth for *email state* (subscribed/unsubscribed,
 * mailing-list memberships, custom properties used in templates), but the
 * CRM is the source of truth for *the customer relationship* (stage, notes,
 * source, tags). This module pushes CRM changes outbound; we don't pull
 * back, because round-tripping unsubscribe state would let an operator
 * accidentally re-subscribe somebody by editing a CRM row.
 */
import type { LoopsClient } from "./client.js";
import { recordSyncLog } from "./store.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { DatabasesStore } from "../databases/store.js";
import type { DatabaseRow, PropertyValue } from "../databases/types.js";

const log = createSubsystemLogger("loops").child("crm-sync");

const CRM_DATABASES = ["clients", "leads"] as const;

export interface CrmContact {
  email: string;
  firstName?: string;
  lastName?: string;
  source?: string;
  /** "client" | "lead" — surfaces in Loops as the userGroup tag. */
  userGroup: string;
  /** CRM row id, used as Loops `userId` so updates round-trip. */
  userId: string;
  props: Record<string, unknown>;
}

function valueToString(value: PropertyValue | undefined): string {
  if (!value) return "";
  switch (value.type) {
    case "title":
      return value.text?.trim() ?? "";
    case "richText":
      return value.markdown?.trim() ?? "";
    case "select":
    case "status":
      return value.optionId ?? "";
    case "multiSelect":
      return value.optionIds.join(", ");
    case "date":
      return value.iso ?? "";
    case "dateRange":
      return [value.start, value.end].filter(Boolean).join(" → ");
    case "number":
      return value.value != null ? String(value.value) : "";
    case "checkbox":
      return value.checked ? "true" : "false";
    case "url":
      return value.url ?? "";
    case "email":
      return value.email ?? "";
    case "phone":
      return value.phone ?? "";
    case "files":
      return value.files.map((f) => f.name).join(", ");
    case "relation":
      return value.rowIds.join(", ");
    case "person":
      return value.personIds.join(", ");
    case "createdAt":
    case "updatedAt":
      return value.iso ?? "";
    default:
      return "";
  }
}

function readField(row: DatabaseRow, names: string[]): string {
  // Match by property *name* — values_json is keyed by property id, but
  // we don't have the property catalog here, so fall back to scanning
  // common Notion-canonical names. The store later returns rows where
  // canonical names show up under `values[propId]` shape; many also
  // surface `values[name]` for legacy CRM imports.
  const v = row.values as Record<string, PropertyValue>;
  for (const n of names) {
    const direct = v[n];
    if (direct !== undefined) {
      const s = valueToString(direct);
      if (s) return s;
    }
    // case-insensitive fallback
    const k = Object.keys(v).find((key) => key.toLowerCase() === n.toLowerCase());
    if (k) {
      const s = valueToString(v[k]);
      if (s) return s;
    }
  }
  // Also check the row title — clients/leads use the canonical "Name" prop
  // which often becomes the title.
  if (names.some((n) => /name/i.test(n)) && row.title) return row.title.trim();
  return "";
}

/**
 * Read all client/lead rows and turn them into Loops contact payloads.
 * Deduplicates by email; clients win over leads on conflict.
 */
export function collectCrmContacts(store: DatabasesStore): CrmContact[] {
  const byEmail = new Map<string, CrmContact>();
  for (const databaseId of CRM_DATABASES) {
    let rows: DatabaseRow[] = [];
    try {
      rows = store.listRows(databaseId);
    } catch (err) {
      log.warn(`listRows(${databaseId}) failed: ${(err as Error).message}`);
      continue;
    }
    for (const row of rows) {
      const email = readField(row, ["Email", "email"]).toLowerCase();
      if (!email || !email.includes("@")) continue;

      const userGroup = databaseId === "clients" ? "client" : "lead";
      const existing = byEmail.get(email);
      if (existing && existing.userGroup === "client" && userGroup === "lead") continue;

      const name = readField(row, ["Name", "name"]);
      const [firstName, ...rest] = name.split(/\s+/).filter(Boolean);
      const lastName = rest.join(" ") || undefined;

      const props: Record<string, unknown> = {
        crmDatabase: databaseId,
        crmRowId: row.id,
        crmUpdatedAt: row.updatedAt,
      };
      for (const key of ["Stage", "Status", "Source", "Phone", "Notes"]) {
        const val = readField(row, [key]);
        if (val) props[key.toLowerCase()] = val;
      }

      byEmail.set(email, {
        email,
        firstName: firstName || undefined,
        lastName,
        source: readField(row, ["Source"]) || `infinibot:${databaseId}`,
        userGroup,
        userId: `${databaseId}:${row.id}`,
        props,
      });
    }
  }
  return [...byEmail.values()];
}

export interface SyncResult {
  attempted: number;
  upserted: number;
  failed: Array<{ email: string; error: string }>;
}

export async function syncCrmContactsToLoops(
  client: LoopsClient,
  store: DatabasesStore,
  opts?: { mailingLists?: Record<string, boolean> },
): Promise<SyncResult> {
  const contacts = collectCrmContacts(store);
  const result: SyncResult = { attempted: contacts.length, upserted: 0, failed: [] };
  for (const c of contacts) {
    try {
      const payload = {
        email: c.email,
        userId: c.userId,
        firstName: c.firstName,
        lastName: c.lastName,
        source: c.source,
        userGroup: c.userGroup,
        ...c.props,
        ...(opts?.mailingLists ? { mailingLists: opts.mailingLists } : {}),
      };
      await client.upsertContact(payload);
      result.upserted++;
      recordSyncLog({ kind: "contact", action: "upsert", target: c.email, success: true });
    } catch (err) {
      const msg = (err as Error).message;
      result.failed.push({ email: c.email, error: msg });
      recordSyncLog({
        kind: "contact",
        action: "upsert",
        target: c.email,
        success: false,
        message: msg,
      });
    }
  }
  log.info(
    `CRM → Loops: ${result.upserted}/${result.attempted} upserted, ${result.failed.length} failed`,
  );
  return result;
}
