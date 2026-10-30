/**
 * Discovery Docs — context puller.
 *
 * Resolves each `ContextSource` to a JSON-serializable blob by reading
 * rows out of the InfiniBot database registry. The same code path the
 * Clients page uses to read its CRM rows (`databases store + db_rows`)
 * — we just slurp them in shape that's friendly for LLM prompts.
 *
 * Returns a `Record<variableName, RowsBlob>` that the prompt resolver
 * then JSON.stringifies inline.
 */

import { getDatabasesStore } from "../databases/store.js";
import type { ContextSource } from "./types.js";

export interface ContextRowSummary {
  id: string;
  title: string;
  /** Flattened key→primitive map from the row's property values. */
  values: Record<string, unknown>;
  body?: string;
}

export interface ResolvedContext {
  [variableName: string]: {
    sourceLabel: string;
    rowCount: number;
    rows: ContextRowSummary[];
  };
}

export function resolveContext(sources: ContextSource[]): ResolvedContext {
  if (sources.length === 0) return {};
  const store = getDatabasesStore();
  const out: ResolvedContext = {};

  for (const src of sources) {
    if (!src.databaseId || !src.variableName) continue;
    try {
      const rows = store.listRows(src.databaseId);
      const filterPropertyId = src.filterPropertyId;
      const filterValue = src.filterValue;
      const filtered =
        filterPropertyId && filterValue !== undefined
          ? rows.filter((r) => {
              const v = r.values?.[filterPropertyId];
              return matchesFilter(v, filterValue);
            })
          : rows;
      const sliced = filtered.slice(0, Math.max(1, src.rowLimit || 10));
      out[src.variableName] = {
        sourceLabel: src.label,
        rowCount: sliced.length,
        rows: sliced.map((r) => ({
          id: r.id,
          title: r.title,
          values: flattenValues(r.values),
          body: src.includeBody ? (r.body ?? undefined) : undefined,
        })),
      };
    } catch (err) {
      // Don't kill the whole run on one bad source — emit an empty
      // bucket and log. The user can fix the source in the editor.
      console.warn(`[discovery] context source "${src.variableName}" failed:`, err);
      out[src.variableName] = {
        sourceLabel: src.label,
        rowCount: 0,
        rows: [],
      };
    }
  }

  return out;
}

/**
 * Property values land in `db_rows.values_json` as the row-property
 * shapes from `databases/types.ts` (e.g. `{ kind: "text", value: "hi" }`).
 * For LLM prompts we want the inner primitive, not the wrapper — flatten
 * so the prompt sees `{ name: "Acme", revenue: 1000 }` instead of
 * `{ name: { kind: "text", value: "Acme" } }`.
 */
function flattenValues(values: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!values) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    out[k] = unwrapPropertyValue(v);
  }
  return out;
}

function unwrapPropertyValue(v: unknown): unknown {
  if (v == null) return v;
  if (typeof v !== "object") return v;
  // Row property shapes from databases/types.ts: { kind, value | options | … }.
  const obj = v as Record<string, unknown>;
  if ("value" in obj) return obj.value;
  if ("options" in obj) return obj.options;
  if ("checked" in obj) return obj.checked;
  if ("number" in obj) return obj.number;
  return v;
}

function matchesFilter(v: unknown, target: string): boolean {
  const t = String(target).toLowerCase().trim();
  const actual = unwrapPropertyValue(v);
  if (actual == null) return false;
  if (Array.isArray(actual)) return actual.some((x) => String(x).toLowerCase() === t);
  return String(actual).toLowerCase() === t;
}
