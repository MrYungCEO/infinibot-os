/**
 * Document types ("categories") — what a document IS, independent of where it
 * sits in the folder tree.
 *
 *   built-in types  fixed ids, can be hidden / recoloured / re-iconed, never deleted
 *   custom types    created by the owner: rename, recolour, re-icon, reorder, archive
 *
 * Persisted local-first next to the documents index (per user / tenant):
 *
 *   <stateDir>/documents/types.json
 *     { version: 1, custom: CustomDocType[], builtin: {id: overrides}, order: string[] }
 *
 * A document carries `type` (a type id) and an optional free `category`.
 * Documents written before types existed have no `type`; their effective type
 * is inferred at read time (inferDocType) so nothing is stored until the owner
 * runs the migration (type-migration.ts) or changes the type by hand.
 *
 * Icons are names from the control UI icon set (ui/src/ui/icons.ts) — no emoji.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  BUILTIN_DOC_TYPES,
  BUILTIN_IDS,
  type CustomDocType,
  type DocTypeDef,
} from "./doc-types-shared.js";

export * from "./doc-types-shared.js";

type BuiltinOverride = { hidden?: boolean; color?: string; icon?: string };

interface TypesFile {
  version: 1;
  custom: CustomDocType[];
  builtin: Record<string, BuiltinOverride>;
  order: string[];
}

const COLOR_RE = /^#[0-9a-f]{6}$/i;
const ICON_RE = /^[a-zA-Z][a-zA-Z0-9]{0,31}$/;
const MAX_LABEL = 40;
const MAX_TEMPLATE = 20_000;
const MAX_CUSTOM = 100;

export class DocTypeValidationError extends Error {}

function cleanLabel(v: unknown): string {
  const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  if (!s) throw new DocTypeValidationError("label is required");
  if (s.length > MAX_LABEL)
    throw new DocTypeValidationError(`label must be at most ${MAX_LABEL} characters`);
  return s;
}

function cleanColor(v: unknown): string {
  if (typeof v !== "string" || !COLOR_RE.test(v.trim()))
    throw new DocTypeValidationError("color must be a #rrggbb hex colour");
  return v.trim().toLowerCase();
}

function cleanIcon(v: unknown): string {
  if (typeof v !== "string" || !ICON_RE.test(v.trim()))
    throw new DocTypeValidationError("icon must be an icon name from the app icon set");
  return v.trim();
}

function cleanTemplate(v: unknown): string | undefined {
  if (v == null || v === "") return undefined;
  if (typeof v !== "string") throw new DocTypeValidationError("template must be a string");
  if (v.length > MAX_TEMPLATE) throw new DocTypeValidationError("template is too long");
  return v;
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "type"
  );
}

function writeAtomic(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export class DocTypeStore {
  private readonly file: string;
  private data: TypesFile | null = null;
  private mtime = 0;

  constructor(documentsRoot: string) {
    this.file = path.join(documentsRoot, "types.json");
  }

  private load(): TypesFile {
    let mtime = 0;
    try {
      mtime = fs.statSync(this.file).mtimeMs;
    } catch {
      /* missing */
    }
    if (this.data && mtime === this.mtime) return this.data;
    let parsed: Partial<TypesFile> = {};
    if (mtime) {
      try {
        parsed = JSON.parse(fs.readFileSync(this.file, "utf-8")) as Partial<TypesFile>;
      } catch {
        try {
          fs.copyFileSync(this.file, `${this.file}.corrupt-${Date.now()}`);
        } catch {
          /* ignore */
        }
      }
    }
    this.data = {
      version: 1,
      custom: Array.isArray(parsed.custom) ? parsed.custom : [],
      builtin: parsed.builtin && typeof parsed.builtin === "object" ? parsed.builtin : {},
      order: Array.isArray(parsed.order) ? parsed.order.filter((x) => typeof x === "string") : [],
    };
    this.mtime = mtime;
    return this.data;
  }

  private save(): void {
    if (!this.data) return;
    writeAtomic(this.file, JSON.stringify(this.data, null, 1));
    try {
      this.mtime = fs.statSync(this.file).mtimeMs;
    } catch {
      this.mtime = 0;
    }
  }

  /** Every type (built-in + custom), in display order. Hidden/archived are flagged, not dropped. */
  list(): DocTypeDef[] {
    const d = this.load();
    const all: Array<Omit<DocTypeDef, "order">> = [
      ...BUILTIN_DOC_TYPES.map((b) => {
        const o = d.builtin[b.id] ?? {};
        return {
          ...b,
          color: o.color ?? b.color,
          icon: o.icon ?? b.icon,
          hidden: o.hidden || undefined,
        };
      }),
      ...d.custom.map((c) => ({
        id: c.id,
        label: c.label,
        icon: c.icon,
        color: c.color,
        description: c.description,
        template: c.template,
        builtin: false,
        backing: "documents" as const,
        creatable: true,
        archived: c.archived || undefined,
      })),
    ];
    const rank = new Map(d.order.map((id, i) => [id, i]));
    const fallback = new Map(all.map((t, i) => [t.id, i]));
    return all
      .map((t) => ({ ...t, order: rank.get(t.id) ?? 10_000 + (fallback.get(t.id) ?? 0) }))
      .sort((a, b) => a.order - b.order)
      .map((t, i) => ({ ...t, order: i }));
  }

  get(id: string): DocTypeDef | null {
    return this.list().find((t) => t.id === id) ?? null;
  }

  /** True when `id` names a type a document may be set to (exists, not archived, not a listing). */
  assignable(id: string): boolean {
    const t = this.get(id);
    return !!t && !t.archived && t.backing === "documents";
  }

  create(p: {
    label: unknown;
    icon?: unknown;
    color?: unknown;
    template?: unknown;
    description?: unknown;
  }): DocTypeDef {
    const d = this.load();
    if (d.custom.length >= MAX_CUSTOM)
      throw new DocTypeValidationError(`at most ${MAX_CUSTOM} custom types`);
    const label = cleanLabel(p.label);
    const lower = label.toLowerCase();
    if (this.list().some((t) => t.label.toLowerCase() === lower && !t.archived))
      throw new DocTypeValidationError(`a type named "${label}" already exists`);
    const ids = new Set(this.list().map((t) => t.id));
    let id = `c-${slug(label)}`;
    while (ids.has(id) || BUILTIN_IDS.has(id))
      id = `c-${slug(label)}-${randomBytes(2).toString("hex")}`;
    const now = new Date().toISOString();
    const t: CustomDocType = {
      id,
      label,
      icon: p.icon == null || p.icon === "" ? "tag" : cleanIcon(p.icon),
      color: p.color == null || p.color === "" ? "#d9b45f" : cleanColor(p.color),
      description:
        typeof p.description === "string" && p.description.trim()
          ? p.description.trim().slice(0, 200)
          : undefined,
      template: cleanTemplate(p.template),
      createdAt: now,
      updatedAt: now,
    };
    d.custom.push(t);
    this.save();
    return this.get(id)!;
  }

  update(
    id: string,
    p: {
      label?: unknown;
      icon?: unknown;
      color?: unknown;
      template?: unknown;
      description?: unknown;
      hidden?: unknown;
      archived?: unknown;
    },
  ): DocTypeDef {
    const d = this.load();
    if (BUILTIN_IDS.has(id)) {
      if (p.label !== undefined)
        throw new DocTypeValidationError("built-in types can't be renamed");
      if (p.archived !== undefined)
        throw new DocTypeValidationError("built-in types can't be archived — hide them instead");
      if (p.template !== undefined)
        throw new DocTypeValidationError("built-in templates are fixed");
      const o = { ...d.builtin[id] };
      if (p.color !== undefined) o.color = cleanColor(p.color);
      if (p.icon !== undefined) o.icon = cleanIcon(p.icon);
      if (p.hidden !== undefined) o.hidden = p.hidden === true || undefined;
      d.builtin[id] = o;
      this.save();
      return this.get(id)!;
    }
    const t = d.custom.find((c) => c.id === id);
    if (!t) throw new DocTypeValidationError(`type "${id}" not found`);
    if (p.label !== undefined) {
      const label = cleanLabel(p.label);
      const lower = label.toLowerCase();
      if (this.list().some((x) => x.id !== id && x.label.toLowerCase() === lower && !x.archived))
        throw new DocTypeValidationError(`a type named "${label}" already exists`);
      t.label = label;
    }
    if (p.color !== undefined) t.color = cleanColor(p.color);
    if (p.icon !== undefined) t.icon = cleanIcon(p.icon);
    if (p.template !== undefined) t.template = cleanTemplate(p.template);
    if (p.description !== undefined)
      t.description =
        typeof p.description === "string" && p.description.trim()
          ? p.description.trim().slice(0, 200)
          : undefined;
    if (p.archived !== undefined) t.archived = p.archived === true || undefined;
    if (p.hidden !== undefined) t.archived = p.hidden === true || undefined;
    t.updatedAt = new Date().toISOString();
    this.save();
    return this.get(id)!;
  }

  /** New display order. Ids not listed keep their relative order after the listed ones. */
  reorder(ids: unknown): DocTypeDef[] {
    if (!Array.isArray(ids)) throw new DocTypeValidationError("ids must be an array");
    const known = new Set(this.list().map((t) => t.id));
    const seen = new Set<string>();
    const head: string[] = [];
    for (const v of ids) {
      if (typeof v === "string" && known.has(v) && !seen.has(v)) {
        seen.add(v);
        head.push(v);
      }
    }
    const tail = this.list()
      .map((t) => t.id)
      .filter((id) => !seen.has(id));
    this.load().order = [...head, ...tail];
    this.save();
    return this.list();
  }

  /** Archive (custom) or hide (built-in). Never deletes — documents keep their type id. */
  archive(id: string, archived = true): DocTypeDef {
    return BUILTIN_IDS.has(id)
      ? this.update(id, { hidden: archived })
      : this.update(id, { archived });
  }
}

const typeStores = new Map<string, DocTypeStore>();

export function docTypeStoreAt(documentsRoot: string): DocTypeStore {
  let s = typeStores.get(documentsRoot);
  if (!s) {
    s = new DocTypeStore(documentsRoot);
    typeStores.set(documentsRoot, s);
  }
  return s;
}
