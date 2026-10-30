/**
 * Client pipeline status: the *real* workflow state of a client.
 *
 * The agency database originally stored only a three-value enum
 * (`prospect|active|inactive`). The owner's actual pipeline has many more
 * states ("Cold", "Lead", "In progress", "Updating", "Completed", ...), so
 * everything collapsed into three buckets and `/clients` (which reads
 * business.json) could never agree with Agency Operations (which reads
 * agency.db).
 *
 * From schema version 9 the real status is a first-class, indexed column and
 * the legacy enum is a *derived rollup* computed here, in one place, so the
 * two can never drift again.
 */

export type LegacyClientStatus = "prospect" | "active" | "inactive";

export type NormalizedClientPipelineStatus = {
  /** Case-folded, whitespace-collapsed key. This is what is stored/indexed. */
  status: string;
  /** Human-readable form. Canonical casing for known values, verbatim otherwise. */
  label: string;
};

/**
 * A blank status is not "unknown" — the owner decided it means Cold. 209 of
 * 406 legacy clients carry no status at all and they are all cold leads.
 */
export const DEFAULT_CLIENT_PIPELINE_STATUS_LABEL = "Cold";
export const DEFAULT_CLIENT_PIPELINE_STATUS = "cold";

const KNOWN: ReadonlyArray<{ label: string; rollup: LegacyClientStatus }> = [
  { label: "Cold", rollup: "prospect" },
  { label: "Lead", rollup: "prospect" },
  { label: "In progress", rollup: "active" },
  { label: "Updating", rollup: "active" },
  { label: "Won", rollup: "active" },
  { label: "Active", rollup: "active" },
  { label: "Completed", rollup: "inactive" },
  { label: "Archived", rollup: "inactive" },
  { label: "Lost", rollup: "inactive" },
  { label: "Cancelled", rollup: "inactive" },
  { label: "Inactive", rollup: "inactive" },
];

const KNOWN_BY_KEY = new Map(KNOWN.map((entry) => [entry.label.toLowerCase(), entry]));

/** Display labels of the statuses this build recognises, in pipeline order. */
export const KNOWN_CLIENT_PIPELINE_STATUSES: readonly string[] = KNOWN.map((e) => e.label);

/** Longest value accepted on write; a status is a label, not a document. */
export const MAX_CLIENT_PIPELINE_STATUS_LENGTH = 120;

/**
 * Normalise a status arriving from Notion/business.json/an RPC.
 *
 * Rules:
 *  - non-strings and blank values become the default ("Cold");
 *  - surrounding whitespace is trimmed and internal runs collapsed to one
 *    space, so "  in   progress " and "In Progress" are the same status;
 *  - the stored key is case-folded, so grouping is case-insensitive;
 *  - a recognised status gets its canonical display casing;
 *  - an *unrecognised* status is preserved verbatim as its label. A status
 *    this build has never seen is data, not an error.
 */
export function normalizeClientPipelineStatus(value: unknown): NormalizedClientPipelineStatus {
  const raw = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!raw) {
    return {
      status: DEFAULT_CLIENT_PIPELINE_STATUS,
      label: DEFAULT_CLIENT_PIPELINE_STATUS_LABEL,
    };
  }
  const trimmed = raw.slice(0, MAX_CLIENT_PIPELINE_STATUS_LENGTH);
  const key = trimmed.toLowerCase();
  const known = KNOWN_BY_KEY.get(key);
  return { status: key, label: known ? known.label : trimmed };
}

/** True when this build recognises the status (callers may still store it). */
export function isKnownClientPipelineStatus(value: unknown): boolean {
  return KNOWN_BY_KEY.has(normalizeClientPipelineStatus(value).status);
}

/**
 * The legacy three-value rollup, derived from the pipeline status.
 *
 * This is the single definition of that mapping; `legacyClientStatus()` in
 * legacy-migration.ts and every store write path go through it.
 *
 * Regression guard: "Completed" is inactive, not active. A finished
 * engagement is not a live client, and counting it as one inflated every
 * active-client figure in the agency (dashboard KPI, topology scope, revenue
 * rollups) — an owner with 2 jobs in flight was shown 9.
 */
export function deriveLegacyClientStatus(value: unknown): LegacyClientStatus {
  const { status } = normalizeClientPipelineStatus(value);
  const known = KNOWN_BY_KEY.get(status);
  if (known) return known.rollup;
  // Unknown values still get a best-effort bucket so KPIs keep working.
  // "inactive" must be tested first — it contains the substring "active".
  if (/(inactive|archived|lost|cancelled|canceled|completed|churned)/.test(status)) {
    return "inactive";
  }
  if (/(active|customer|client|in progress|updating|won|live|retainer)/.test(status)) {
    return "active";
  }
  return "prospect";
}

const NOTE_STATUS_KEYS = ["Status", "status", "Stage", "stage"] as const;

/**
 * Recover the pipeline status from the raw legacy `notes` JSON blob, which is
 * where it has been hiding — unqueryable — since the first import.
 */
export function clientPipelineStatusFromNotes(notes: unknown): NormalizedClientPipelineStatus {
  if (!notes || typeof notes !== "string") {
    return normalizeClientPipelineStatus(null);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(notes);
  } catch {
    return normalizeClientPipelineStatus(null);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return normalizeClientPipelineStatus(null);
  }
  const data = parsed as Record<string, unknown>;
  for (const key of NOTE_STATUS_KEYS) {
    const candidate = data[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return normalizeClientPipelineStatus(candidate);
    }
  }
  return normalizeClientPipelineStatus(null);
}
