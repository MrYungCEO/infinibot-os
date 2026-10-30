/**
 * Notion database schema / page properties → Documents property model.
 *
 * Title handling: the Notion `title` property becomes the node title. It is
 * listed in the folder `schema` (first column, type "title", keyed by its
 * Notion name) so table views know what to label the title column, but it is
 * NOT duplicated into the doc's `properties` — UIs read `node.title` for it.
 *
 * Column keys are the Notion property names (unique within a database), so
 * the API and ZIP (CSV header) importers produce the same keys.
 */

import type { DocPropertyColumn, DocPropertyType, DocPropertyValue } from "../types.js";
import { fileObjectUrl } from "./blocks-to-md.js";
import { normalizeNotionId } from "./shared.js";

/* eslint-disable @typescript-eslint/no-explicit-any -- raw Notion JSON */
export type NotionPropertySchema = { id?: string; name?: string; type: string; [k: string]: any };
export type NotionPropertyValue = { id?: string; type: string; [k: string]: any };
/* eslint-enable @typescript-eslint/no-explicit-any */

const TYPE_MAP: Record<string, DocPropertyType> = {
  title: "title",
  rich_text: "text",
  number: "number",
  select: "select",
  multi_select: "multiSelect",
  status: "status",
  date: "date",
  checkbox: "checkbox",
  url: "url",
  email: "email",
  phone_number: "phone",
  people: "person",
  created_by: "person",
  last_edited_by: "person",
  files: "files",
  relation: "relation",
  created_time: "createdAt",
  last_edited_time: "updatedAt",
  formula: "text",
  rollup: "text",
  unique_id: "text",
  verification: "text",
};

/** Notion property type → DocPropertyType (null for types we don't import, e.g. button). */
export function mapNotionPropertyType(type: string): DocPropertyType | null {
  return TYPE_MAP[type] ?? null;
}

/** Notion database `properties` schema → ordered columns (title first). */
export function notionSchemaToColumns(
  properties: Record<string, NotionPropertySchema> | undefined,
): DocPropertyColumn[] {
  const cols: DocPropertyColumn[] = [];
  for (const [name, def] of Object.entries(properties ?? {})) {
    const type = mapNotionPropertyType(def.type);
    if (!type) continue;
    cols.push({ key: name, name, type });
  }
  // Title first, the rest in Notion's order.
  return [...cols.filter((c) => c.type === "title"), ...cols.filter((c) => c.type !== "title")];
}

function plain(rich: Array<{ plain_text?: string }> | undefined): string {
  return (rich ?? []).map((r) => r.plain_text ?? "").join("");
}

function dateText(d: { start?: string; end?: string | null } | null | undefined): string | null {
  if (!d?.start) return null;
  return d.end ? `${d.start} → ${d.end}` : d.start;
}

function personName(p: { name?: string; id?: string } | null | undefined): string {
  return p?.name || p?.id || "";
}

/** Rollup array items / formula results → a flat display string. */
function scalarText(v: DocPropertyValue): string {
  if (v === null) return "";
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}

export interface PropertyValueOptions {
  /** Maps Notion-hosted file URLs (which expire) to local asset URLs. */
  resolveAsset?: (url: string, nameHint: string) => string;
  /** Page title for a Notion id (rollups of relations show titles, not ids). */
  titleOf?: (notionId: string) => string | undefined;
}

/** Convert one Notion page property value to a DocPropertyValue. */
export function notionPropertyValue(
  prop: NotionPropertyValue | undefined,
  opts: PropertyValueOptions = {},
): DocPropertyValue {
  if (!prop) return null;
  const v = prop[prop.type];
  switch (prop.type) {
    case "title":
    case "rich_text":
      return plain(v);
    case "number":
      return typeof v === "number" ? v : null;
    case "select":
    case "status":
      return v?.name ?? null;
    case "multi_select":
      return Array.isArray(v) ? v.map((o: { name: string }) => o.name) : [];
    case "date":
      return dateText(v);
    case "checkbox":
      return v === true;
    case "url":
    case "email":
    case "phone_number":
      return typeof v === "string" && v ? v : null;
    case "people":
      return Array.isArray(v) ? v.map(personName).filter(Boolean) : [];
    case "created_by":
    case "last_edited_by":
      return personName(v) || null;
    case "files":
      return Array.isArray(v)
        ? v
            .map((f) => {
              const obj = fileObjectUrl(f);
              if (!obj) return "";
              return obj.hosted && opts.resolveAsset
                ? opts.resolveAsset(obj.url, obj.name)
                : obj.url;
            })
            .filter(Boolean)
        : [];
    case "relation":
      return Array.isArray(v)
        ? v.map((r: { id: string }) => normalizeNotionId(r.id) ?? r.id).filter(Boolean)
        : [];
    case "created_time":
    case "last_edited_time":
      return typeof v === "string" ? v : null;
    case "formula": {
      if (!v) return null;
      if (v.type === "date") return dateText(v.date);
      const out = v[v.type];
      return typeof out === "string" || typeof out === "number" || typeof out === "boolean"
        ? out
        : null;
    }
    case "rollup": {
      if (!v) return null;
      if (v.type === "number") return v.number == null ? null : String(v.number);
      if (v.type === "date") return dateText(v.date);
      if (v.type === "array") {
        const parts = (v.array ?? [])
          .map((item: NotionPropertyValue) => {
            const val = notionPropertyValue(item, opts);
            if (item?.type === "relation" && Array.isArray(val) && opts.titleOf) {
              return val.map((id) => opts.titleOf!(id) || id).join(", ");
            }
            return scalarText(val);
          })
          .filter(Boolean);
        return parts.join(", ");
      }
      return null;
    }
    case "unique_id":
      return v?.number == null ? null : v.prefix ? `${v.prefix}-${v.number}` : String(v.number);
    case "verification":
      return v?.state ?? null;
    default:
      return null;
  }
}

/**
 * Split a page's properties into its title and the remaining property values.
 * Unsupported property types (e.g. button) are dropped.
 */
export function notionPageProperties(
  properties: Record<string, NotionPropertyValue> | undefined,
  opts: PropertyValueOptions = {},
): { title: string; properties: Record<string, DocPropertyValue> } {
  let title = "";
  const out: Record<string, DocPropertyValue> = {};
  for (const [name, prop] of Object.entries(properties ?? {})) {
    if (prop.type === "title") {
      title = plain(prop.title);
      continue;
    }
    if (!mapNotionPropertyType(prop.type)) continue;
    out[name] = notionPropertyValue(prop, opts);
  }
  return { title: title.trim(), properties: out };
}

/** All hosted (expiring) file URLs referenced by `files` properties. */
export function collectPropertyAssets(
  properties: Record<string, NotionPropertyValue> | undefined,
): Array<{ url: string; hosted: boolean; name: string }> {
  const out: Array<{ url: string; hosted: boolean; name: string }> = [];
  for (const prop of Object.values(properties ?? {})) {
    if (prop.type !== "files" || !Array.isArray(prop.files)) continue;
    for (const f of prop.files) {
      const obj = fileObjectUrl(f);
      if (obj) out.push(obj);
    }
  }
  return out;
}
