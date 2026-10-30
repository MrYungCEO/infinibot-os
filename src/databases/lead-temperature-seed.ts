/**
 * Lead Temperature property — idempotent seed for the Leads + Clients
 * role databases.
 *
 * Goal: give Cold / Warm / Hot first-class storage on each row so the
 * dashboard can filter, sort, and write temperature directly. The user's
 * existing status property is used as the BASE TEMPLATE — if a property
 * named Temperature / Heat / LeadTemperature already exists, we extend
 * it. Otherwise we create a new select property and seed the canonical
 * Cold/Warm/Hot options.
 *
 * Additive only. Never deletes user-added options.
 */

import type { DatabasesStore } from "./store.js";
import type { DatabaseProperty, SelectOption } from "./types.js";

/**
 * Names a property can have to be considered the canonical "temperature"
 * axis. Matched case-insensitively, in priority order. The first hit on a
 * given database wins.
 */
const TEMPERATURE_NAME_PATTERNS: ReadonlyArray<RegExp> = [
  /^lead[\s_-]?temperature$/i,
  /^temperature$/i,
  /^heat$/i,
  /^heat[\s_-]?level$/i,
];

/** Canonical option values + colors. Existing matching options keep their colors. */
const CANONICAL_TEMPERATURE_OPTIONS: ReadonlyArray<SelectOption> = [
  { id: "cold", name: "Cold", color: "#38bdf8" },
  { id: "warm", name: "Warm", color: "#f97316" },
  { id: "hot", name: "Hot", color: "#f43f5e" },
];

/** Property names whose options we read to estimate user's palette/keyword preference. */
const STATUS_NAME_PATTERNS: ReadonlyArray<RegExp> = [
  /^lifecycle[\s_-]?status$/i,
  /^stage$/i,
  /^status$/i,
];

/**
 * Roles whose mapped databases get the canonical Temperature property.
 * Order matters only for logging — both are processed.
 */
const ROLE_TARGETS: ReadonlyArray<"leads" | "clients"> = ["leads", "clients"];

export interface TemperaturePropertyInfo {
  databaseId: string;
  propertyId: string;
  propertyName: string;
  /** True when this property was just created by the seed. */
  created: boolean;
  /** Option ids the canonical values map to (cold/warm/hot → option.id). */
  canonicalOptionIds: { cold: string; warm: string; hot: string };
}

/**
 * Make sure both the Leads and Clients role databases have a canonical
 * Temperature property. Idempotent; safe to call on every boot.
 *
 * Strategy per database:
 *   1. If a status property already uses Cold/Warm/Hot as option names,
 *      we DON'T create a separate Temperature property — the user's
 *      status doubles as the temperature axis. We just record which
 *      options map to canonical values.
 *   2. Otherwise, if a property named Temperature/Heat/LeadTemperature
 *      exists, ensure it has the canonical options (additive).
 *   3. Otherwise, create a new select property named "Temperature" with
 *      the canonical options.
 */
export function ensureLeadTemperatureProperty(store: DatabasesStore): TemperaturePropertyInfo[] {
  const out: TemperaturePropertyInfo[] = [];
  for (const role of ROLE_TARGETS) {
    const resolved = store.resolveSystemRole(role);
    if (!resolved || !resolved.database) continue;
    try {
      const info = _ensureForDatabase(store, resolved.database.id);
      if (info) out.push(info);
    } catch {
      // best-effort — never block the caller
    }
  }
  return out;
}

/**
 * Per-business variant: ensure each business's mapped Leads/Clients
 * database has a Temperature property too. Walks every business role
 * mapping for the given businessId.
 */
export function ensureLeadTemperaturePropertyForBusiness(
  store: DatabasesStore,
  businessId: string,
): TemperaturePropertyInfo[] {
  const out: TemperaturePropertyInfo[] = [];
  for (const role of ROLE_TARGETS) {
    const resolved = store.resolveBusinessSystemRole(businessId, role);
    if (!resolved || !resolved.database) continue;
    try {
      const info = _ensureForDatabase(store, resolved.database.id);
      if (info) out.push(info);
    } catch {
      // best-effort
    }
  }
  return out;
}

/**
 * Look up the canonical temperature property id for a database, or null
 * if none exists. Used by leads.setTemperature + leads.stats to know
 * where to write/read.
 */
export function findTemperatureProperty(
  store: DatabasesStore,
  databaseId: string,
): {
  property: DatabaseProperty;
  canonicalOptionIds: { cold: string; warm: string; hot: string };
} | null {
  const props = store.listProperties(databaseId);
  const tempProp = props.find((p) => _isTemperaturePropName(p.name));
  if (tempProp) {
    return {
      property: tempProp,
      canonicalOptionIds: _mapCanonicalIds(tempProp.config?.options ?? []),
    };
  }
  // Fall back: a status property whose option names include cold/warm/hot.
  const statusProp = props.find(
    (p) =>
      (p.type === "select" || p.type === "status") &&
      STATUS_NAME_PATTERNS.some((re) => re.test(p.name)) &&
      _statusHasTemperatureKeywords(p.config?.options ?? []),
  );
  if (statusProp) {
    return {
      property: statusProp,
      canonicalOptionIds: _mapCanonicalIds(statusProp.config?.options ?? []),
    };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// internals
// ─────────────────────────────────────────────────────────────────────

function _ensureForDatabase(
  store: DatabasesStore,
  databaseId: string,
): TemperaturePropertyInfo | null {
  const props = store.listProperties(databaseId);

  // Case 1: an existing status property already encodes cold/warm/hot.
  // Treat it as the canonical temperature axis without creating a dupe.
  const reusedStatus = props.find(
    (p) =>
      (p.type === "select" || p.type === "status") &&
      STATUS_NAME_PATTERNS.some((re) => re.test(p.name)) &&
      _statusHasTemperatureKeywords(p.config?.options ?? []),
  );

  // Case 2: an existing Temperature/Heat property — extend it additively.
  const existingTemp = props.find((p) => _isTemperaturePropName(p.name));
  if (existingTemp) {
    const merged = _mergeOptions(existingTemp.config?.options ?? []);
    if (merged.changed) {
      store.updateProperty(existingTemp.id, {
        config: { ...existingTemp.config, options: merged.options },
      });
    }
    return {
      databaseId,
      propertyId: existingTemp.id,
      propertyName: existingTemp.name,
      created: false,
      canonicalOptionIds: _mapCanonicalIds(merged.options),
    };
  }

  // If the user's status property already covers cold/warm/hot, prefer
  // reuse over creating a redundant property.
  if (reusedStatus) {
    return {
      databaseId,
      propertyId: reusedStatus.id,
      propertyName: reusedStatus.name,
      created: false,
      canonicalOptionIds: _mapCanonicalIds(reusedStatus.config?.options ?? []),
    };
  }

  // Case 3: nothing matches — create a fresh select Temperature property.
  const created = store.createProperty({
    databaseId,
    name: "Temperature",
    type: "select",
    config: { options: CANONICAL_TEMPERATURE_OPTIONS.slice() },
    hidden: false,
  });
  return {
    databaseId,
    propertyId: created.id,
    propertyName: created.name,
    created: true,
    canonicalOptionIds: { cold: "cold", warm: "warm", hot: "hot" },
  };
}

function _isTemperaturePropName(name: string): boolean {
  return TEMPERATURE_NAME_PATTERNS.some((re) => re.test(name));
}

function _statusHasTemperatureKeywords(options: ReadonlyArray<SelectOption>): boolean {
  const names = options.map((o) => o.name.toLowerCase());
  return names.includes("cold") && names.includes("warm") && names.includes("hot");
}

/**
 * Merge canonical Cold/Warm/Hot into the user's existing options.
 * Match by option name (case-insensitive) first, then by id. Never
 * removes user-added options. Returns the merged list + whether
 * anything changed so callers can skip the SQL UPDATE if not.
 */
function _mergeOptions(existing: ReadonlyArray<SelectOption>): {
  options: SelectOption[];
  changed: boolean;
} {
  const out: SelectOption[] = existing.map((o) => ({ ...o }));
  let changed = false;
  for (const canonical of CANONICAL_TEMPERATURE_OPTIONS) {
    const hit = out.find(
      (o) =>
        o.name.toLowerCase() === canonical.name.toLowerCase() ||
        o.id.toLowerCase() === canonical.id.toLowerCase(),
    );
    if (!hit) {
      out.push({ ...canonical });
      changed = true;
    }
  }
  return { options: out, changed };
}

function _mapCanonicalIds(options: ReadonlyArray<SelectOption>): {
  cold: string;
  warm: string;
  hot: string;
} {
  const pick = (label: string, fallback: string): string => {
    const lc = label.toLowerCase();
    const hit = options.find(
      (o) => o.name.toLowerCase() === lc || o.id.toLowerCase() === fallback.toLowerCase(),
    );
    return hit?.id ?? fallback;
  };
  return {
    cold: pick("Cold", "cold"),
    warm: pick("Warm", "warm"),
    hot: pick("Hot", "hot"),
  };
}
