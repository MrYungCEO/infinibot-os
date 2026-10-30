/**
 * Form Bindings — map a public form (`bindingId`) to a target database row
 * write, with a property mapping that translates inbound form fields into
 * canonical PropertyValue shapes via the same coercion the agent tool uses.
 *
 * Storage: a single SQLite table `form_bindings` next to the rest of the
 * gateway state.  Fields are stored as JSON so the schema doesn't need
 * migrations as we add features (notification webhooks, success redirects,
 * required-field policies).
 *
 * No auth — bindings are looked up by their UUID-ish id, which acts as a
 * capability token.  Anyone who knows the id can post to it (same model as
 * the existing landing-page form endpoints), so don't embed binding ids in
 * places you wouldn't paste a webhook URL.
 */

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { getDatabasesStore } from "../databases/store.js";
import type {
  DatabaseProperty,
  PropertyValue,
} from "../databases/types.js";

// ── Types ─────────────────────────────────────────────────────────

export interface FormBinding {
  id: string;
  /** Human-readable label shown in admin UI. */
  name: string;
  /** Target database id where rows should land. */
  databaseId: string;
  /**
   * Map: form field name → property NAME (or id) on the target database.
   * Unmapped fields are dropped on submit. The property-name resolver
   * matches case-insensitively to keep templates portable across DBs.
   */
  fieldMap: Record<string, string>;
  /** Optional title pattern, e.g. "Lead from {{name}}". Defaults to name. */
  titleTemplate?: string;
  /** Webhook URL to POST the raw submission to (best-effort, fire-and-forget). */
  webhookUrl?: string;
  /** URL to send the browser to after a successful submit. */
  successRedirect?: string;
  /** Free-form metadata (originating workspace, tags, etc.). */
  meta?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface FormBindingCreate {
  id?: string;
  name: string;
  databaseId: string;
  fieldMap?: Record<string, string>;
  titleTemplate?: string;
  webhookUrl?: string;
  successRedirect?: string;
  meta?: Record<string, unknown>;
}

export type FormBindingPatch = Partial<Omit<FormBindingCreate, "id">>;

// ── Singleton store ───────────────────────────────────────────────

let _db: Database.Database | null = null;
let _stateDir: string | null = null;

function ensureDb(stateDir: string): Database.Database {
  if (_db && _stateDir === stateDir) return _db;
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  const db = new Database(resolve(stateDir, "form-bindings.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS form_bindings (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      database_id TEXT NOT NULL,
      field_map_json TEXT NOT NULL DEFAULT '{}',
      title_template TEXT,
      webhook_url TEXT,
      success_redirect TEXT,
      meta_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_form_bindings_db ON form_bindings(database_id);
    CREATE TABLE IF NOT EXISTS form_submissions (
      id TEXT PRIMARY KEY,
      binding_id TEXT NOT NULL,
      database_id TEXT,
      row_id TEXT,
      data_json TEXT NOT NULL,
      ip TEXT,
      user_agent TEXT,
      received_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'ok',
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_form_subs_binding ON form_submissions(binding_id);
    CREATE INDEX IF NOT EXISTS idx_form_subs_received ON form_submissions(received_at DESC);
  `);
  _db = db;
  _stateDir = stateDir;
  return db;
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToBinding(row: Record<string, unknown>): FormBinding {
  return {
    id: row.id as string,
    name: row.name as string,
    databaseId: row.database_id as string,
    fieldMap: parseJson(row.field_map_json as string | null, {} as Record<string, string>),
    titleTemplate: (row.title_template as string | null) ?? undefined,
    webhookUrl: (row.webhook_url as string | null) ?? undefined,
    successRedirect: (row.success_redirect as string | null) ?? undefined,
    meta: parseJson(row.meta_json as string | null, {} as Record<string, unknown>),
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

// ── Public API ────────────────────────────────────────────────────

export class FormBindingStore {
  constructor(private db: Database.Database) {}

  list(): FormBinding[] {
    return (
      this.db
        .prepare(`SELECT * FROM form_bindings ORDER BY created_at DESC`)
        .all() as Record<string, unknown>[]
    ).map(rowToBinding);
  }

  get(id: string): FormBinding | null {
    const row = this.db
      .prepare(`SELECT * FROM form_bindings WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? rowToBinding(row) : null;
  }

  create(input: FormBindingCreate): FormBinding {
    const id = input.id || `fb_${randomUUID()}`;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO form_bindings (id, name, database_id, field_map_json, title_template, webhook_url, success_redirect, meta_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.databaseId,
        JSON.stringify(input.fieldMap ?? {}),
        input.titleTemplate ?? null,
        input.webhookUrl ?? null,
        input.successRedirect ?? null,
        JSON.stringify(input.meta ?? {}),
        now,
        now,
      );
    return this.get(id)!;
  }

  update(id: string, patch: FormBindingPatch): FormBinding | null {
    const existing = this.get(id);
    if (!existing) return null;
    const next: FormBinding = {
      ...existing,
      ...patch,
      // patch keys may be undefined — preserve existing
      name: patch.name ?? existing.name,
      databaseId: patch.databaseId ?? existing.databaseId,
      fieldMap: patch.fieldMap ?? existing.fieldMap,
      titleTemplate: patch.titleTemplate ?? existing.titleTemplate,
      webhookUrl: patch.webhookUrl ?? existing.webhookUrl,
      successRedirect: patch.successRedirect ?? existing.successRedirect,
      meta: patch.meta ?? existing.meta,
      updatedAt: Date.now(),
    };
    this.db
      .prepare(
        `UPDATE form_bindings SET name = ?, database_id = ?, field_map_json = ?, title_template = ?, webhook_url = ?, success_redirect = ?, meta_json = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        next.name,
        next.databaseId,
        JSON.stringify(next.fieldMap),
        next.titleTemplate ?? null,
        next.webhookUrl ?? null,
        next.successRedirect ?? null,
        JSON.stringify(next.meta ?? {}),
        next.updatedAt,
        id,
      );
    return this.get(id);
  }

  delete(id: string): boolean {
    return this.db.prepare(`DELETE FROM form_bindings WHERE id = ?`).run(id).changes > 0;
  }

  recordSubmission(input: {
    bindingId: string;
    databaseId: string | null;
    rowId: string | null;
    data: Record<string, unknown>;
    ip?: string;
    userAgent?: string;
    status?: "ok" | "error";
    error?: string;
  }): string {
    const id = `fs_${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO form_submissions (id, binding_id, database_id, row_id, data_json, ip, user_agent, received_at, status, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.bindingId,
        input.databaseId,
        input.rowId,
        JSON.stringify(input.data),
        input.ip ?? null,
        input.userAgent ?? null,
        Date.now(),
        input.status ?? "ok",
        input.error ?? null,
      );
    return id;
  }

  listSubmissions(
    bindingId: string,
    opts?: { limit?: number },
  ): Array<{
    id: string;
    bindingId: string;
    databaseId: string | null;
    rowId: string | null;
    data: Record<string, unknown>;
    receivedAt: number;
    status: string;
    error?: string;
  }> {
    const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 500);
    const rows = this.db
      .prepare(
        `SELECT * FROM form_submissions WHERE binding_id = ? ORDER BY received_at DESC LIMIT ?`,
      )
      .all(bindingId, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string,
      bindingId: r.binding_id as string,
      databaseId: (r.database_id as string | null) ?? null,
      rowId: (r.row_id as string | null) ?? null,
      data: parseJson(r.data_json as string, {} as Record<string, unknown>),
      receivedAt: r.received_at as number,
      status: (r.status as string) ?? "ok",
      error: (r.error as string | null) ?? undefined,
    }));
  }
}

export function getFormBindingStore(stateDir: string): FormBindingStore {
  return new FormBindingStore(ensureDb(stateDir));
}

// ── Submission processor ──────────────────────────────────────────
// Resolves a binding, coerces the inbound data into a PropertyValue map
// against the target database's schema, writes a row, optionally fires a
// webhook, and records the submission. Reuses the same value coercion
// rules as the agent tool's `databases` action so behaviour matches.

function asString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

function findProperty(
  props: DatabaseProperty[],
  key: string,
): DatabaseProperty | null {
  if (!key) return null;
  const byId = props.find((p) => p.id === key);
  if (byId) return byId;
  const lower = key.toLowerCase();
  return props.find((p) => p.name.toLowerCase() === lower) ?? null;
}

function resolveOptionId(prop: DatabaseProperty, raw: unknown): string | null {
  const val = asString(raw);
  if (!val) return null;
  const opts = prop.config?.options ?? [];
  const byId = opts.find((o) => o.id === val);
  if (byId) return byId.id;
  const lower = val.toLowerCase();
  const byName = opts.find((o) => o.name.toLowerCase() === lower);
  return byName ? byName.id : val;
}

function coerceValue(
  prop: DatabaseProperty,
  raw: unknown,
): PropertyValue | undefined {
  switch (prop.type) {
    case "title":
      return { type: "title", text: asString(raw) ?? "" };
    case "richText":
      return { type: "richText", markdown: asString(raw) ?? "" };
    case "select":
      return { type: "select", optionId: resolveOptionId(prop, raw) };
    case "status":
      return { type: "status", optionId: resolveOptionId(prop, raw) };
    case "multiSelect": {
      const arr = Array.isArray(raw)
        ? raw
        : typeof raw === "string"
          ? raw.split(",").map((s) => s.trim()).filter(Boolean)
          : [];
      const ids = arr
        .map((entry) => resolveOptionId(prop, entry))
        .filter((id): id is string => Boolean(id));
      return { type: "multiSelect", optionIds: ids };
    }
    case "date":
      return { type: "date", iso: asString(raw) };
    case "number": {
      if (raw === null || raw === undefined || raw === "") {
        return { type: "number", value: null };
      }
      const n = typeof raw === "number" ? raw : Number(raw);
      return { type: "number", value: Number.isFinite(n) ? n : null };
    }
    case "checkbox":
      return {
        type: "checkbox",
        checked: raw === true || raw === "true" || raw === "on" || raw === 1 || raw === "1",
      };
    case "url":
      return { type: "url", url: asString(raw) };
    case "email":
      return { type: "email", email: asString(raw) };
    case "phone":
      return { type: "phone", phone: asString(raw) };
    default:
      return undefined;
  }
}

function applyTitleTemplate(template: string, data: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key: string) => {
    const v = data[key];
    return v === null || v === undefined ? "" : String(v);
  });
}

export interface ProcessSubmissionInput {
  binding: FormBinding;
  data: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
  stateDir: string;
}

export interface ProcessSubmissionResult {
  ok: boolean;
  rowId?: string;
  databaseId?: string;
  submissionId: string;
  error?: string;
}

export async function processSubmission(
  input: ProcessSubmissionInput,
): Promise<ProcessSubmissionResult> {
  const store = getFormBindingStore(input.stateDir);
  let rowId: string | null = null;
  let errMsg: string | undefined;
  let ok = true;

  try {
    const databasesStore = getDatabasesStore(input.stateDir);
    const props = databasesStore.listProperties(input.binding.databaseId);

    // Translate fieldMap{ formField → propName } against the schema.
    const values: Record<string, PropertyValue> = {};
    let titleFromValues: string | undefined;
    for (const [formField, propKey] of Object.entries(input.binding.fieldMap ?? {})) {
      if (!propKey) continue;
      const prop = findProperty(props, propKey);
      if (!prop) continue;
      const raw = input.data[formField];
      const coerced = coerceValue(prop, raw);
      if (coerced === undefined) continue;
      values[prop.id] = coerced;
      // Capture the title-typed property's text if present so we can use it
      // as the row's title fallback.
      if (prop.type === "title" && coerced.type === "title") {
        titleFromValues = coerced.text;
      }
    }

    // Title resolution: explicit template > title-typed value > binding name
    const title = input.binding.titleTemplate
      ? applyTitleTemplate(input.binding.titleTemplate, input.data).trim() ||
        titleFromValues ||
        input.binding.name
      : titleFromValues || input.binding.name;

    const row = databasesStore.upsertRow({
      databaseId: input.binding.databaseId,
      title,
      values,
      externalRef: null,
    });
    rowId = row.id;
  } catch (err) {
    ok = false;
    errMsg = err instanceof Error ? err.message : String(err);
  }

  // Optional webhook fan-out (best-effort).
  if (input.binding.webhookUrl) {
    void fetch(input.binding.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bindingId: input.binding.id,
        bindingName: input.binding.name,
        databaseId: input.binding.databaseId,
        rowId,
        data: input.data,
        receivedAt: Date.now(),
      }),
    }).catch(() => {
      /* swallow — webhook failures shouldn't fail the submission */
    });
  }

  const submissionId = store.recordSubmission({
    bindingId: input.binding.id,
    databaseId: ok ? input.binding.databaseId : null,
    rowId,
    data: input.data,
    ip: input.ip,
    userAgent: input.userAgent,
    status: ok ? "ok" : "error",
    error: errMsg,
  });

  return {
    ok,
    rowId: rowId ?? undefined,
    databaseId: ok ? input.binding.databaseId : undefined,
    submissionId,
    error: errMsg,
  };
}

// Internal — keep `join` reachable so tree-shaking doesn't kill it; the
// store path uses it implicitly through `resolve`.
export function _formBindingsDbPath(stateDir: string): string {
  return join(stateDir, "form-bindings.db");
}
