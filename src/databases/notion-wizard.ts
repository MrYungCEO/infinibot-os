/**
 * Notion setup wizard backend.
 *
 * Drives the user-friendly Notion onboarding flow: paste API key → verify
 * token → list pages the integration can access → pick a parent page →
 * auto-create the system databases with relations → run a verification pass
 * → persist to infinibot.json.
 *
 * Each step is its own RPC so the web UI can render progress per-step and
 * give actionable error messages (especially for the common "you forgot to
 * share the page with the integration" case).
 */
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  getNotionConfig,
  setNotionRuntimeOverride,
  writeNotionConfig,
  type NotionSyncMode,
} from "./notion-config.js";

const log = createSubsystemLogger("notion-wizard");

const NOTION_API_URL = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

export interface VerifyTokenResult {
  ok: boolean;
  /** Display name of the integration as seen by Notion (e.g. "InfiniBot Sync"). */
  integrationName?: string;
  /** Workspace name the token belongs to. */
  workspace?: string;
  /** Bot id from the /users/me probe. */
  botId?: string;
  /** Raw error if the token failed (`unauthorized`, `restricted_resource`, etc). */
  error?: string;
  /** Friendly hint with corrective action. */
  hint?: string;
}

export interface AccessiblePage {
  id: string;
  title: string;
  /** "page" | "database" — the wizard only offers pages as parents. */
  kind: "page" | "database";
  url?: string;
  parentTitle?: string;
  /** Last edited time (ms). */
  lastEditedAt: number;
}

export interface CreateSystemDbsInput {
  apiKey: string;
  parentPageId: string;
  /** Optional override for db titles; defaults are "Projects" and "Tasks". */
  projectsTitle?: string;
  tasksTitle?: string;
}

export interface CreateSystemDbsResult {
  projectsDbId: string;
  tasksDbId: string;
  /** Notion URLs for both DBs so the UI can deep-link. */
  projectsUrl?: string;
  tasksUrl?: string;
  /** CRM database ids — created during onboarding so the InfiniBot CRM has a Notion mirror from day one. */
  crm: {
    clientsDbId: string;
    leadsDbId: string;
    companiesDbId: string;
    dealsDbId: string;
    contactsDbId: string;
    /** Per-CRM-DB Notion URLs for UI deep-links. */
    urls: Partial<Record<"clients" | "leads" | "companies" | "deals" | "contacts", string>>;
  };
}

export interface VerificationCheck {
  id: string;
  label: string;
  ok: boolean;
  detail?: string;
  hint?: string;
}

export interface RunVerificationResult {
  ok: boolean;
  checks: VerificationCheck[];
}

export interface FinalizeInput {
  apiKey: string;
  syncMode: NotionSyncMode;
  parentPageId?: string;
  projectsDbId?: string;
  tasksDbId?: string;
  integrationName?: string;
  clientsDbId?: string;
  leadsDbId?: string;
  companiesDbId?: string;
  dealsDbId?: string;
  contactsDbId?: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Step 1: verify token
// ─────────────────────────────────────────────────────────────────────────

export async function verifyToken(apiKey: string): Promise<VerifyTokenResult> {
  if (!apiKey || !apiKey.trim()) {
    return {
      ok: false,
      error: "missing_token",
      hint: "Paste your Notion integration token here. It starts with `secret_` or `ntn_`.",
    };
  }
  // Reject non-Latin-1 chars before we hand the key to fetch — otherwise
  // the Authorization header throws an opaque "Cannot convert argument to
  // a ByteString" TypeError. Most common cause: pasting from a tooltip
  // that truncates with "…" instead of revealing the full token.
  const trimmed = apiKey.replace(/^[\s​‌‍﻿]+|[\s​‌‍﻿]+$/g, "");
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (code > 255) {
      const ch = trimmed[i];
      return {
        ok: false,
        error: "invalid_chars",
        hint: `Token contains a non-ASCII character (${JSON.stringify(ch)}, U+${code.toString(16).toUpperCase().padStart(4, "0")}). This usually means it was pasted from a tooltip showing "secret_xxx…xxx" instead of the full reveal — copy from Notion's "Show" reveal directly.`,
      };
    }
  }
  apiKey = trimmed;
  try {
    // 8s budget — /users/me is normally <500ms. The default 30s ceiling
    // made the wizard's verify step read as "stuck" whenever Notion was
    // even slightly slow; clip it so the user gets feedback inside a
    // reasonable timeout instead of waiting half a minute.
    const me = (await notionFetch(apiKey, "/users/me", {
      signal: AbortSignal.timeout(8_000),
    })) as {
      id: string;
      name?: string;
      bot?: { workspace_name?: string; owner?: { type?: string } };
    };
    return {
      ok: true,
      botId: me.id,
      integrationName: me.name ?? "InfiniBot Sync",
      workspace: me.bot?.workspace_name,
    };
  } catch (err) {
    const message = (err as Error).message ?? "";
    if (/401|unauthorized/i.test(message)) {
      return {
        ok: false,
        error: "unauthorized",
        hint: "Notion rejected this token. Double-check you copied the *Internal Integration Secret* (Settings → Connections → Develop or manage integrations → Your integration → Show secret).",
      };
    }
    return {
      ok: false,
      error: "request_failed",
      hint: `Couldn't reach Notion: ${message}. Check your network connection and try again.`,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Step 2: list accessible pages the integration can see
// ─────────────────────────────────────────────────────────────────────────

export async function listAccessiblePages(apiKey: string): Promise<AccessiblePage[]> {
  if (!apiKey) return [];
  try {
    const body = (await notionFetch(apiKey, "/search", {
      method: "POST",
      body: JSON.stringify({
        filter: { value: "page", property: "object" },
        sort: { direction: "descending", timestamp: "last_edited_time" },
        page_size: 100,
      }),
    })) as { results?: Array<Record<string, unknown>> };

    const pages: AccessiblePage[] = [];
    for (const r of body.results ?? []) {
      const page = r as {
        id: string;
        object: string;
        url?: string;
        last_edited_time?: string;
        properties?: Record<string, unknown>;
        parent?: { type?: string; database_id?: string; page_id?: string; workspace?: boolean };
      };
      const title = extractPageTitle(page);
      pages.push({
        id: page.id,
        kind: "page",
        title: title || "Untitled",
        url: page.url,
        lastEditedAt: page.last_edited_time ? new Date(page.last_edited_time).getTime() : 0,
        parentTitle: describeParent(page.parent),
      });
    }
    return pages;
  } catch (err) {
    log.warn("listAccessiblePages failed", { error: (err as Error).message });
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Page → markdown import. Used by the "Notion Import" quickstart wizard to
// pull whole pages (not databases) into the local Notes store. We fetch the
// page for its title, then walk its block children and flatten them to a
// readable markdown body. Best-effort: unsupported block types are skipped
// rather than failing the whole import.
// ─────────────────────────────────────────────────────────────────────────

export interface ImportedPageContent {
  id: string;
  title: string;
  markdown: string;
}

function richTextToPlain(rich: unknown): string {
  if (!Array.isArray(rich)) return "";
  return rich
    .map((seg) => {
      const s = seg as { plain_text?: string };
      return s?.plain_text ?? "";
    })
    .join("");
}

function blockToMarkdown(block: Record<string, unknown>): string {
  const type = block.type as string | undefined;
  if (!type) return "";
  const data = (block[type] as Record<string, unknown>) ?? {};
  const text = richTextToPlain(data.rich_text);
  switch (type) {
    case "heading_1":
      return text ? `# ${text}` : "";
    case "heading_2":
      return text ? `## ${text}` : "";
    case "heading_3":
      return text ? `### ${text}` : "";
    case "bulleted_list_item":
      return text ? `- ${text}` : "";
    case "numbered_list_item":
      return text ? `1. ${text}` : "";
    case "to_do":
      return text ? `- [${data.checked ? "x" : " "}] ${text}` : "";
    case "quote":
      return text ? `> ${text}` : "";
    case "callout":
      return text ? `> ${text}` : "";
    case "code":
      return text ? "```\n" + text + "\n```" : "";
    case "divider":
      return "---";
    case "paragraph":
    default:
      return text;
  }
}

/**
 * Fetch a single Notion page and flatten its top-level blocks to markdown.
 * Returns null when the page can't be read (not shared with the integration,
 * deleted, etc.) so the caller can report a partial result.
 */
export async function importPageAsMarkdown(
  apiKey: string,
  pageId: string,
): Promise<ImportedPageContent | null> {
  try {
    const page = (await notionFetch(apiKey, `/pages/${pageId}`)) as {
      properties?: Record<string, unknown>;
    };
    const title = extractPageTitle(page) || "Untitled Notion page";
    const lines: string[] = [];
    let cursor: string | undefined;
    let guard = 0;
    do {
      const qs = cursor
        ? `?start_cursor=${encodeURIComponent(cursor)}&page_size=100`
        : "?page_size=100";
      const body = (await notionFetch(apiKey, `/blocks/${pageId}/children${qs}`)) as {
        results?: Array<Record<string, unknown>>;
        has_more?: boolean;
        next_cursor?: string | null;
      };
      for (const block of body.results ?? []) {
        const md = blockToMarkdown(block);
        if (md) lines.push(md);
      }
      cursor = body.has_more ? (body.next_cursor ?? undefined) : undefined;
      guard += 1;
    } while (cursor && guard < 20);
    return { id: pageId, title, markdown: lines.join("\n\n") };
  } catch (err) {
    log.warn("importPageAsMarkdown failed", { pageId, error: (err as Error).message });
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Step 2b: list databases the integration can read — used by the wizard's
// "Import additional Notion databases" picker so users can pull existing
// data into the local SQLite store. Filters out the system DBs we manage
// (Projects/Tasks + the CRM five) so the picker doesn't offer to duplicate
// what's already wired.
// ─────────────────────────────────────────────────────────────────────────

export interface AccessibleDatabase {
  id: string;
  title: string;
  /** Notion URL for one-click open. */
  url?: string;
  /** Last edited time (ms). */
  lastEditedAt: number;
  /** Property count — gives the user a sense of how rich the DB is. */
  propertyCount: number;
  /** True when the DB id matches one of our managed system DBs (Projects/Tasks/CRM). */
  isSystemManaged: boolean;
}

export async function listAccessibleDatabases(
  apiKey: string,
  managedIds: string[] = [],
  extraKnownIds: string[] = [],
): Promise<AccessibleDatabase[]> {
  if (!apiKey) return [];
  const managed = new Set(managedIds.map(stripDashes).filter(Boolean));
  // Throws on real failures (401, 5xx, network) so callers can surface a
  // useful error in the UI instead of silently rendering "no databases."
  // The previous catch-and-return-[] hid every Notion error behind an
  // empty picker — the wizard then looked broken with no indication of
  // why. Notion's `/search` endpoint returns 200 with `results: []`
  // when the integration has no shared databases, so an empty list still
  // resolves naturally without throwing.
  // Paginated: workspaces with >100 databases used to lose every result
  // after the first page (the import wizard never saw them, the picker
  // showed a truncated list). Walk the cursor up to a safety ceiling
  // so we don't accidentally page forever against a malformed cursor.
  const allResults: Array<Record<string, unknown>> = [];
  const PAGE_CAP = 10; // 10 × 100 = 1000 databases — plenty.
  let cursor: string | undefined;
  for (let i = 0; i < PAGE_CAP; i++) {
    const payload: Record<string, unknown> = {
      filter: { value: "database", property: "object" },
      sort: { direction: "descending", timestamp: "last_edited_time" },
      page_size: 100,
    };
    if (cursor) payload.start_cursor = cursor;
    let page: {
      results?: Array<Record<string, unknown>>;
      has_more?: boolean;
      next_cursor?: string;
    };
    try {
      page = (await notionFetch(apiKey, "/search", {
        method: "POST",
        body: JSON.stringify(payload),
      })) as { results?: Array<Record<string, unknown>>; has_more?: boolean; next_cursor?: string };
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      log.warn("listAccessibleDatabases failed", { error: message });
      throw new Error(message);
    }
    if (page.results) allResults.push(...page.results);
    if (!page.has_more || !page.next_cursor) break;
    cursor = page.next_cursor;
  }
  const body = { results: allResults };
  const out: AccessibleDatabase[] = [];
  const seen = new Set<string>();
  const pushDb = (db: {
    id: string;
    url?: string;
    last_edited_time?: string;
    title?: Array<{ plain_text?: string }>;
    properties?: Record<string, unknown>;
  }) => {
    const norm = stripDashes(db.id);
    if (seen.has(norm)) return;
    seen.add(norm);
    const title = Array.isArray(db.title)
      ? db.title
          .map((t) => t?.plain_text ?? "")
          .join("")
          .trim() || "Untitled"
      : "Untitled";
    out.push({
      id: db.id,
      title,
      url: db.url,
      lastEditedAt: db.last_edited_time ? new Date(db.last_edited_time).getTime() : 0,
      propertyCount: Object.keys(db.properties ?? {}).length,
      isSystemManaged: managed.has(stripDashes(db.id)),
    });
  };
  for (const raw of body.results ?? []) {
    pushDb(
      raw as {
        id: string;
        url?: string;
        last_edited_time?: string;
        title?: Array<{ plain_text?: string }>;
        properties?: Record<string, unknown>;
      },
    );
  }

  // Notion's `/search` endpoint only returns objects the integration was
  // *directly* shared with. Databases that were shared via a parent page
  // routinely don't appear, even though `/databases/{id}` returns them
  // happily — this is a long-standing platform quirk. So for any DB id
  // the caller already knows about (prior bindings, system DBs, per-
  // business CRM/products IDs), do a best-effort direct lookup and union
  // the results. Lookups that 404/403 just get dropped.
  //
  // Cap the probe set so a user with dozens of business profiles +
  // bindings doesn't make the wizard wait on a long parallel fan-out
  // before showing anything. Each probe also gets a 6s budget — Notion
  // typically responds in <500ms; anything beyond that is degraded and
  // worth dropping rather than blocking the discover step.
  const PROBE_LIMIT = 30;
  const PROBE_TIMEOUT_MS = 6_000;
  const knownNorm = new Set<string>();
  const knownLookup: Array<{ original: string; norm: string }> = [];
  for (const id of extraKnownIds) {
    if (knownLookup.length >= PROBE_LIMIT) break;
    const norm = stripDashes(id);
    if (!norm || knownNorm.has(norm) || seen.has(norm)) continue;
    knownNorm.add(norm);
    knownLookup.push({ original: id, norm });
  }
  if (knownLookup.length > 0) {
    await Promise.all(
      knownLookup.map(async ({ original }) => {
        try {
          const db = (await notionFetch(apiKey, `/databases/${original}`, {
            method: "GET",
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
          })) as {
            id: string;
            url?: string;
            last_edited_time?: string;
            title?: Array<{ plain_text?: string }>;
            properties?: Record<string, unknown>;
          };
          pushDb(db);
        } catch (err) {
          // 404/403 just means the integration can't see this DB — fine,
          // skip it. Anything noisier (5xx, network, timeout) is also
          // dropped here so a flaky lookup doesn't blank out the wizard.
          log.debug("direct lookup skipped", { id: original, err: (err as Error).message });
        }
      }),
    );
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Step 3: create system databases (Projects + Tasks with relation)
// ─────────────────────────────────────────────────────────────────────────

interface ChildDatabaseRef {
  id: string;
  url?: string;
}

/**
 * Find databases the integration can already see whose parent page matches
 * `parentPageId`, indexed by title. Used to make the system-database
 * creation step idempotent: if a user re-runs the wizard against the same
 * parent page, we reuse the dbs we previously made instead of duplicating
 * "Projects" / "Tasks" / each CRM table on every retry.
 *
 * Notion's `/search` endpoint returns every database the integration has
 * been invited to, regardless of parent — there's no server-side parent
 * filter. We page through results client-side and keep only those whose
 * `parent.page_id` (with dashes stripped, since Notion sometimes returns
 * IDs with and sometimes without) matches the requested parent.
 */
async function findChildDatabasesByTitle(
  apiKey: string,
  parentPageId: string,
): Promise<Map<string, ChildDatabaseRef>> {
  const out = new Map<string, ChildDatabaseRef>();
  const wantedParent = stripDashes(parentPageId);
  if (!wantedParent) return out;

  let cursor: string | undefined;
  // Cap the loop so a misconfigured workspace can't make us page forever.
  // Notion typically returns ≤100 results per request; 10 pages = up to 1000
  // databases scanned, more than enough for any user's parent page.
  for (let i = 0; i < 10; i++) {
    const reqBody: Record<string, unknown> = {
      filter: { value: "database", property: "object" },
      page_size: 100,
    };
    if (cursor) reqBody.start_cursor = cursor;
    const body = (await notionFetch(apiKey, "/search", {
      method: "POST",
      body: JSON.stringify(reqBody),
    })) as {
      results?: Array<{
        id: string;
        url?: string;
        title?: Array<{ plain_text?: string }>;
        parent?: { type?: string; page_id?: string };
      }>;
      has_more?: boolean;
      next_cursor?: string;
    };

    for (const db of body.results ?? []) {
      if (db.parent?.type !== "page_id") continue;
      if (stripDashes(db.parent.page_id ?? "") !== wantedParent) continue;
      const title = Array.isArray(db.title)
        ? db.title
            .map((t) => t?.plain_text ?? "")
            .join("")
            .trim()
        : "";
      if (!title) continue;
      // First match wins when titles collide — Notion has no uniqueness
      // constraint so a parent page can host two "Tasks" dbs. The duplicate
      // would have been a user mistake; we don't try to disambiguate.
      if (!out.has(title)) {
        out.set(title, { id: db.id, url: db.url });
      }
    }
    if (!body.has_more || !body.next_cursor) break;
    cursor = body.next_cursor;
  }

  return out;
}

export async function createSystemDatabases(
  input: CreateSystemDbsInput,
): Promise<CreateSystemDbsResult> {
  const { apiKey, parentPageId } = input;
  const projectsTitle = input.projectsTitle ?? "Projects";
  const tasksTitle = input.tasksTitle ?? "Tasks";

  // Look up what the integration already sees under this parent so we can
  // reuse instead of duplicating. A retry of the wizard against the same
  // page should land on the same dbs every time.
  const existing = await findChildDatabasesByTitle(apiKey, parentPageId);

  // Step 1: Projects DB — reuse if a database with this title already
  // exists under the parent, otherwise create a fresh one.
  const projects = await ensureDatabase(apiKey, existing, projectsTitle, {
    parent: { type: "page_id", page_id: parentPageId },
    icon: { type: "emoji", emoji: "📁" },
    title: [{ type: "text", text: { content: projectsTitle } }],
    properties: {
      Project: { title: {} },
      Status: { status: {} },
      Priority: {
        select: {
          options: [
            { name: "Immediate", color: "red" },
            { name: "High", color: "orange" },
            { name: "Medium", color: "yellow" },
            { name: "Low", color: "gray" },
          ],
        },
      },
      Description: { rich_text: {} },
      "Due Date": { date: {} },
    },
  });

  // Step 2: Tasks DB *after* Projects so its relation column can target it.
  const tasks = await ensureDatabase(apiKey, existing, tasksTitle, {
    parent: { type: "page_id", page_id: parentPageId },
    icon: { type: "emoji", emoji: "✅" },
    title: [{ type: "text", text: { content: tasksTitle } }],
    properties: {
      "Task Name": { title: {} },
      "Status Update": { status: {} },
      "Priority Level": {
        select: {
          options: [
            { name: "Immediate", color: "red" },
            { name: "High", color: "orange" },
            { name: "Medium", color: "yellow" },
            { name: "Low", color: "gray" },
          ],
        },
      },
      Description: { rich_text: {} },
      "Due Date": { date: {} },
      Project: {
        relation: {
          database_id: projects.id,
          type: "single_property",
          single_property: {},
        },
      },
      Done: { checkbox: {} },
    },
  });

  // Step 3: create the CRM mirror — Clients, Leads, Companies, Deals,
  // Contacts. Properties mirror src/databases/business-templates.ts so the
  // local SQLite store and Notion view stay structurally aligned. CRM DBs
  // have circular relations (Companies ↔ Clients ↔ Deals); Notion's create
  // API can't forward-reference, so we create all five with non-relation
  // props first, then PATCH each with its relation columns once every id is
  // known. createCrmDatabases is idempotent in the same way as above.
  const crm = await createCrmDatabases({
    apiKey,
    parentPageId,
    projectsDbId: projects.id,
    existing,
  });

  return {
    projectsDbId: projects.id,
    tasksDbId: tasks.id,
    projectsUrl: projects.url,
    tasksUrl: tasks.url,
    crm,
  };
}

/**
 * Either reuse an existing database (matched by title under the parent
 * page) or POST a new one. Avoids duplicating system DBs across retries.
 */
async function ensureDatabase(
  apiKey: string,
  existing: Map<string, ChildDatabaseRef>,
  title: string,
  createBody: Record<string, unknown>,
): Promise<ChildDatabaseRef> {
  const found = existing.get(title);
  if (found) {
    log.info("notion-wizard: reusing existing database", { title, id: found.id });
    return found;
  }
  const created = (await notionFetch(apiKey, "/databases", {
    method: "POST",
    body: JSON.stringify(createBody),
  })) as { id: string; url?: string };
  const ref: ChildDatabaseRef = { id: created.id, url: created.url };
  // Cache for any later look-ups in the same call so a same-title retry
  // mid-flight (network hiccup + retry) doesn't double-create.
  existing.set(title, ref);
  return ref;
}

async function createCrmDatabases(input: {
  apiKey: string;
  parentPageId: string;
  projectsDbId: string;
  /**
   * Reusable index of existing dbs under the parent page, keyed by title.
   * Optional — when omitted we rebuild it ourselves (the standalone
   * caller path). Passing it through from `createSystemDatabases` saves a
   * second round-trip to Notion's /search.
   */
  existing?: Map<string, ChildDatabaseRef>;
}): Promise<CreateSystemDbsResult["crm"]> {
  const { apiKey, parentPageId } = input;
  const existing = input.existing ?? (await findChildDatabasesByTitle(apiKey, parentPageId));

  // Pass 1: create each CRM DB with its non-relation properties (or reuse
  // the existing db when the title already exists under the parent).
  const companies = await ensureDatabase(apiKey, existing, "Companies", {
    parent: { type: "page_id", page_id: parentPageId },
    icon: { type: "emoji", emoji: "🏢" },
    title: [{ type: "text", text: { content: "Companies" } }],
    properties: {
      Name: { title: {} },
      Industry: {
        select: {
          options: [
            { name: "SaaS" },
            { name: "Fintech" },
            { name: "E-commerce" },
            { name: "Agency" },
            { name: "Media" },
            { name: "Healthcare" },
            { name: "Other" },
          ],
        },
      },
      Size: {
        select: {
          options: [
            { name: "1–10" },
            { name: "11–50" },
            { name: "51–200" },
            { name: "201–500" },
            { name: "501–1000" },
            { name: "1000+" },
          ],
        },
      },
      Domain: { url: {} },
      Country: { rich_text: {} },
      Notes: { rich_text: {} },
    },
  });

  const clients = await ensureDatabase(apiKey, existing, "Clients", {
    parent: { type: "page_id", page_id: parentPageId },
    icon: { type: "emoji", emoji: "👥" },
    title: [{ type: "text", text: { content: "Clients" } }],
    properties: {
      Name: { title: {} },
      Status: { status: {} },
      Tier: {
        select: {
          options: [
            { name: "Enterprise", color: "purple" },
            { name: "Growth", color: "blue" },
            { name: "Starter", color: "green" },
          ],
        },
      },
      Email: { email: {} },
      Phone: { phone_number: {} },
      Website: { url: {} },
      MRR: { number: { format: "dollar" } },
      Tags: { multi_select: { options: [] } },
      "Last Contact": { date: {} },
      Notes: { rich_text: {} },
    },
  });

  const deals = await ensureDatabase(apiKey, existing, "Deals", {
    parent: { type: "page_id", page_id: parentPageId },
    icon: { type: "emoji", emoji: "💼" },
    title: [{ type: "text", text: { content: "Deals" } }],
    properties: {
      Name: { title: {} },
      Stage: { status: {} },
      Amount: { number: { format: "dollar" } },
      Probability: { number: { format: "percent" } },
      "Close Date": { date: {} },
      Notes: { rich_text: {} },
    },
  });

  const leads = await ensureDatabase(apiKey, existing, "Leads", {
    parent: { type: "page_id", page_id: parentPageId },
    icon: { type: "emoji", emoji: "🎯" },
    title: [{ type: "text", text: { content: "Leads" } }],
    properties: {
      Name: { title: {} },
      Stage: { status: {} },
      Source: {
        select: {
          options: [
            { name: "Inbound" },
            { name: "Referral" },
            { name: "Outbound" },
            { name: "Event" },
            { name: "Social" },
            { name: "Other" },
          ],
        },
      },
      Email: { email: {} },
      Phone: { phone_number: {} },
      "Estimated Value": { number: { format: "dollar" } },
      Probability: { number: { format: "percent" } },
      "Next Step": { rich_text: {} },
      "Next Action Date": { date: {} },
      Tags: { multi_select: { options: [] } },
      "First Contacted": { date: {} },
      Notes: { rich_text: {} },
    },
  });

  const contacts = await ensureDatabase(apiKey, existing, "Contacts", {
    parent: { type: "page_id", page_id: parentPageId },
    icon: { type: "emoji", emoji: "📇" },
    title: [{ type: "text", text: { content: "Contacts" } }],
    properties: {
      Name: { title: {} },
      Email: { email: {} },
      Phone: { phone_number: {} },
      Title: { rich_text: {} },
      LinkedIn: { url: {} },
      Relationship: {
        select: {
          options: [
            { name: "Primary contact" },
            { name: "Decision maker" },
            { name: "Champion" },
            { name: "End user" },
            { name: "Other" },
          ],
        },
      },
      Tags: { multi_select: { options: [] } },
      "Last Contact": { date: {} },
      Notes: { rich_text: {} },
    },
  });

  // Pass 2: PATCH each DB with its relation columns now that every id exists.
  // Each relation uses `single_property` so it's a one-way pointer Notion
  // displays as a column. Users can manually convert to dual-property in
  // Notion later if they want backlinks.
  await notionFetch(apiKey, `/databases/${clients.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      properties: {
        Company: {
          relation: { database_id: companies.id, type: "single_property", single_property: {} },
        },
        Deals: {
          relation: { database_id: deals.id, type: "single_property", single_property: {} },
        },
      },
    }),
  });

  await notionFetch(apiKey, `/databases/${leads.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      properties: {
        Company: {
          relation: { database_id: companies.id, type: "single_property", single_property: {} },
        },
      },
    }),
  });

  await notionFetch(apiKey, `/databases/${deals.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      properties: {
        Company: {
          relation: { database_id: companies.id, type: "single_property", single_property: {} },
        },
        Client: {
          relation: { database_id: clients.id, type: "single_property", single_property: {} },
        },
      },
    }),
  });

  await notionFetch(apiKey, `/databases/${contacts.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      properties: {
        Company: {
          relation: { database_id: companies.id, type: "single_property", single_property: {} },
        },
      },
    }),
  });

  return {
    clientsDbId: clients.id,
    leadsDbId: leads.id,
    companiesDbId: companies.id,
    dealsDbId: deals.id,
    contactsDbId: contacts.id,
    urls: {
      clients: clients.url,
      leads: leads.url,
      companies: companies.url,
      deals: deals.url,
      contacts: contacts.url,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Step 4: run verification — token works, DBs exist, relation correct, write probe
// ─────────────────────────────────────────────────────────────────────────

export async function runVerification(input: {
  apiKey: string;
  projectsDbId: string;
  tasksDbId: string;
}): Promise<RunVerificationResult> {
  const checks: VerificationCheck[] = [];

  // 1. Token still valid
  try {
    await notionFetch(input.apiKey, "/users/me");
    checks.push({ id: "token", label: "Notion token works", ok: true });
  } catch (err) {
    checks.push({
      id: "token",
      label: "Notion token works",
      ok: false,
      detail: (err as Error).message,
      hint: "Re-run the verify step with a fresh token.",
    });
    return { ok: false, checks };
  }

  // 2. Projects DB reachable
  let projectsDb: any = null;
  try {
    projectsDb = await notionFetch(input.apiKey, `/databases/${input.projectsDbId}`);
    checks.push({ id: "projects-db", label: "Projects database reachable", ok: true });
  } catch (err) {
    checks.push({
      id: "projects-db",
      label: "Projects database reachable",
      ok: false,
      detail: (err as Error).message,
      hint: "Make sure the integration is invited to the parent page (Notion page menu → Connections → InfiniBot).",
    });
  }

  // 3. Tasks DB reachable
  let tasksDb: any = null;
  try {
    tasksDb = await notionFetch(input.apiKey, `/databases/${input.tasksDbId}`);
    checks.push({ id: "tasks-db", label: "Tasks database reachable", ok: true });
  } catch (err) {
    checks.push({
      id: "tasks-db",
      label: "Tasks database reachable",
      ok: false,
      detail: (err as Error).message,
      hint: "Make sure the integration is invited to the parent page (Notion page menu → Connections → InfiniBot).",
    });
  }

  // 4. Relation correctly targets Projects
  if (projectsDb && tasksDb) {
    const relationProp = (tasksDb.properties as Record<string, any>)?.Project;
    const target = relationProp?.relation?.database_id;
    const ok = !!target && stripDashes(target) === stripDashes(input.projectsDbId);
    checks.push({
      id: "relation",
      label: "Tasks → Projects relation wired",
      ok,
      detail: ok
        ? undefined
        : `Tasks.Project should target ${input.projectsDbId}, found ${target ?? "missing"}`,
      hint: ok
        ? undefined
        : "Re-run the database creation step — the relation property is missing or pointing elsewhere.",
    });
  }

  // 5. Write probe — create a temp row in Projects, then archive it.
  if (projectsDb) {
    try {
      const created = (await notionFetch(input.apiKey, "/pages", {
        method: "POST",
        body: JSON.stringify({
          parent: { database_id: input.projectsDbId },
          properties: {
            Project: {
              title: [{ text: { content: "InfiniBot setup probe (safe to delete)" } }],
            },
          },
        }),
      })) as { id: string };
      await notionFetch(input.apiKey, `/pages/${created.id}`, {
        method: "PATCH",
        body: JSON.stringify({ archived: true }),
      }).catch(() => {});
      checks.push({ id: "write-probe", label: "Write access confirmed", ok: true });
    } catch (err) {
      checks.push({
        id: "write-probe",
        label: "Write access confirmed",
        ok: false,
        detail: (err as Error).message,
        hint: "The integration is connected but lacks write permission. Re-share the page and select 'Can edit' for the integration.",
      });
    }
  }

  const allOk = checks.every((c) => c.ok);
  return { ok: allOk, checks };
}

// ─────────────────────────────────────────────────────────────────────────
// Step 5: finalize — persist config, set runtime override, seed system roles
// ─────────────────────────────────────────────────────────────────────────

export async function finalizeNotionSetup(input: FinalizeInput): Promise<{
  ok: true;
  syncMode: NotionSyncMode;
}> {
  // Make the new config visible to in-flight callers without restart.
  setNotionRuntimeOverride({
    apiKey: input.apiKey,
    syncMode: input.syncMode,
    projectsDbId: input.projectsDbId ?? null,
    tasksDbId: input.tasksDbId ?? null,
    parentPageId: input.parentPageId ?? null,
    integrationName: input.integrationName ?? null,
    clientsDbId: input.clientsDbId ?? null,
    leadsDbId: input.leadsDbId ?? null,
    companiesDbId: input.companiesDbId ?? null,
    dealsDbId: input.dealsDbId ?? null,
    contactsDbId: input.contactsDbId ?? null,
  });

  // Persist to infinibot.json.
  await writeNotionConfig({
    apiKey: input.apiKey,
    syncMode: input.syncMode,
    projectsDbId: input.projectsDbId ?? null,
    tasksDbId: input.tasksDbId ?? null,
    parentPageId: input.parentPageId ?? null,
    integrationName: input.integrationName ?? null,
    clientsDbId: input.clientsDbId ?? null,
    leadsDbId: input.leadsDbId ?? null,
    companiesDbId: input.companiesDbId ?? null,
    dealsDbId: input.dealsDbId ?? null,
    contactsDbId: input.contactsDbId ?? null,
  });

  return { ok: true, syncMode: input.syncMode };
}

// ─────────────────────────────────────────────────────────────────────────
// Status — used by the UI to render the current setup state on entry.
// ─────────────────────────────────────────────────────────────────────────

export interface NotionSetupStatus {
  configured: boolean;
  syncMode: NotionSyncMode;
  projectsDbId: string | null;
  tasksDbId: string | null;
  parentPageId: string | null;
  integrationName: string | null;
  /** True iff the gateway can reach Notion right now with the saved key. */
  reachable?: boolean;
  /** CRM database ids surfaced so the wizard can re-render setup state on revisit. */
  clientsDbId: string | null;
  leadsDbId: string | null;
  companiesDbId: string | null;
  dealsDbId: string | null;
  contactsDbId: string | null;
}

export async function getStatus(): Promise<NotionSetupStatus> {
  const cfg = getNotionConfig();
  // Reachability is probed with a tight 3s budget so the import wizard
  // doesn't sit on its "Checking for existing connection…" splash for
  // 30s if Notion is slow / api.notion.com is unreachable. The wizard's
  // discover step runs a real /search shortly after, so the worst we
  // lose here is the "Connected to X" badge on the connect step — the
  // import itself still surfaces an actionable error if the key is bad.
  let reachable: boolean | undefined;
  if (cfg.apiKey) {
    try {
      await notionFetch(cfg.apiKey, "/users/me", {
        signal: AbortSignal.timeout(3_000),
      });
      reachable = true;
    } catch {
      reachable = false;
    }
  }
  return {
    configured: !!cfg.apiKey && cfg.syncMode !== "off",
    syncMode: cfg.syncMode,
    projectsDbId: cfg.projectsDbId,
    tasksDbId: cfg.tasksDbId,
    parentPageId: cfg.parentPageId,
    integrationName: cfg.integrationName,
    reachable,
    clientsDbId: cfg.clientsDbId,
    leadsDbId: cfg.leadsDbId,
    companiesDbId: cfg.companiesDbId,
    dealsDbId: cfg.dealsDbId,
    contactsDbId: cfg.contactsDbId,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────

async function notionFetch(apiKey: string, path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${NOTION_API_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...((init.headers as Record<string, string> | undefined) ?? {}),
    },
    // Caller-supplied AbortSignal wins (used by tighter per-probe timeouts
    // in listAccessibleDatabases). Default to a 30s ceiling when omitted so
    // existing /search + /users/me callers behave the same as before.
    signal: init.signal ?? AbortSignal.timeout(30_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = (body as any)?.message ?? JSON.stringify(body);
    throw new Error(`Notion API ${res.status}: ${detail}`);
  }
  return body;
}

function extractPageTitle(page: { properties?: Record<string, unknown> }): string {
  const props = page.properties ?? {};
  for (const value of Object.values(props)) {
    const v = value as { type?: string; title?: Array<{ plain_text?: string }> };
    if (v?.type === "title" && Array.isArray(v.title)) {
      return v.title.map((t) => t.plain_text ?? "").join("");
    }
  }
  return "";
}

function describeParent(
  parent:
    | { type?: string; database_id?: string; page_id?: string; workspace?: boolean }
    | undefined,
): string | undefined {
  if (!parent) return undefined;
  if (parent.workspace) return "Workspace";
  if (parent.type === "page_id") return "Sub-page";
  if (parent.type === "database_id") return "Inside database";
  return undefined;
}

function stripDashes(id: string): string {
  return id.replace(/-/g, "").toLowerCase();
}
