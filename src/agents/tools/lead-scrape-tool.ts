/**
 * lead_scrape — MCP tool that wraps the reusable Playwright scraping module.
 *
 * The LLM's job: pick `source`, `query`, and `maxResults`.
 * This tool's job: call the stable compiled module, persist results.
 *
 * Storage path: leads → funnelStore.upsertLeadFromExternal (funnel inbox)
 *                     → upsertRowForBusinessRole (databases tab + Notion sync).
 * Neither raw SQL nor direct HTTP — same helpers the existing leads.search
 * gateway handler uses so RLS and Notion sync still fire.
 */

import { openLeadDeal } from "../../business-hub/automation.js";
import { ensureSource, upsertCompany, upsertContact } from "../../business-hub/contacts.js";
import { getHubDb } from "../../business-hub/db.js";
import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as path from "node:path";

import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam, readNumberParam } from "./common.js";
import {
  type ScrapeLeadsInput,
  type ScrapedLead,
  scrapeLeads,
  SCRAPE_LEADS_MODULE_PATH,
} from "../../workflows/playwright/scrape-leads.js";
import { getFunnelStore } from "../../funnels/store.js";
import {
  ensureBusinessRoleDatabase,
  upsertRowForBusinessRole,
} from "../../databases/system-role-bridge.js";
import { createSlotTool } from "../../plugins/core-tool-slots.js";
import { resolveStateDir } from "../../config/paths.js";

// ── Constants ─────────────────────────────────────────────────────────────────

export const leadScrapeName = "lead_scrape";

const LEAD_SOURCES = ["google_maps", "instagram_search", "directory_site"] as const;

const LeadScrapeSchema = Type.Object({
  source: stringEnum(LEAD_SOURCES, {
    description: "Where to scrape: google_maps | instagram_search | directory_site.",
  }),
  query: Type.String({
    description: "Search text (google_maps, instagram_search) or direct URL (directory_site).",
  }),
  maxResults: Type.Optional(
    Type.Number({
      description: "Max leads to collect per run. Default 50.",
    }),
  ),
  filters: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description: "Source-specific filter key/value pairs.",
    }),
  ),
  business_id: Type.Optional(
    Type.String({
      description:
        "Business to scope leads under. Omit to use the active business from state/business.json.",
    }),
  ),
  storageStatePath: Type.Optional(
    Type.String({
      description: "Path to Playwright storageState JSON (required for instagram_search).",
    }),
  ),
});

// ── Active-business resolution ────────────────────────────────────────────────

function resolveActiveBusinessId(explicitId?: string): string | null {
  if (explicitId) return explicitId;
  try {
    const stateDir = resolveStateDir(); // same dir business.ts writes business.json to
    const file = path.join(stateDir, "business.json");
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as { activeBusinessId?: string };
    return raw.activeBusinessId ?? null;
  } catch {
    return null;
  }
}

// ── CRM persistence ───────────────────────────────────────────────────────────

/**
 * Mirror scraped leads into the business's funnel inbox (stage history +
 * activity timeline) and the databases-tab row store (Notion-syncable).
 * Idempotent — repeated scrapes dedup by externalId / email / phone.
 */
function persistLeads(
  leads: ScrapedLead[],
  source: string,
  businessId: string,
  log: (line: string) => void,
): number {
  const store = getFunnelStore();
  let inserted = 0;

  // Ensure the per-business leads database exists for the /databases tab.
  try {
    ensureBusinessRoleDatabase(
      businessId,
      "leads",
      "Leads",
      "Per-business leads — playwright scraper via lead_scrape tool.",
    );
  } catch (err) {
    log(`[lead_scrape] db-role ensure failed: ${(err as Error).message}`);
  }

  for (const lead of leads) {
    const externalId = `pw-${source}-${lead.sourceUrl ?? lead.business ?? randomUUID()}`;
    const name = lead.name ?? lead.business ?? "Unknown";

    // ── Funnel store (CRM inbox) ──────────────────────────────────────────
    try {
      store.upsertLeadFromExternal({
        businessId,
        externalId,
        source,
        name,
        company: lead.business ?? lead.name,
        email: lead.email,
        phone: lead.phone,
        tags: ["playwright-scrape", source],
        metadata: {
          website: lead.website,
          address: lead.address,
          rating: lead.rating,
          reviewCount: lead.reviewCount,
          socials: lead.socials,
          sourceUrl: lead.sourceUrl,
        },
      });
    } catch (err) {
      log(`[lead_scrape] funnel upsert failed for ${name}: ${(err as Error).message}`);
    }

    // ── Business hub (the canonical CRM: company + contact + open deal) ──
    try {
      const db = getHubDb();
      const sourceId = ensureSource(db, "leadgen", `Browser scrape: ${source}`);
      const company =
        upsertCompany(
          db,
          {
            name: lead.business ?? lead.name ?? null,
            website: lead.website ?? null,
            phone: lead.phone ?? null,
            address: lead.address ?? null,
            social: Object.fromEntries((lead.socials ?? []).map((x) => [x.platform, x.url])),
          },
          { sourceId, actor: "lead_scrape" },
        )?.company ?? null;
      const contact = lead.email
        ? (upsertContact(
            db,
            {
              name: lead.name ?? lead.business ?? null,
              email: lead.email,
              phone: lead.phone ?? null,
              companyId: company?.id ?? null,
              lifecycle: "lead",
              tags: ["playwright-scrape", source],
            },
            { sourceId, actor: "lead_scrape" },
          )?.contact ?? null)
        : null;
      openLeadDeal(db, { contactId: contact?.id ?? null, companyId: company?.id ?? null });
    } catch (err) {
      log(`[lead_scrape] hub upsert failed for ${name}: ${(err as Error).message}`);
    }

    // ── Database row store (Notion-syncable) ──────────────────────────────
    try {
      upsertRowForBusinessRole("leads", businessId, {
        id: externalId,
        title: name,
        values: {
          source,
          status: "new",
          quality: "unknown",
          email: lead.email,
          phone: lead.phone,
          company: lead.business ?? lead.name,
          website: lead.website,
          address: lead.address,
          rating: lead.rating,
          reviewCount: lead.reviewCount,
        } as unknown as Record<string, import("../../databases/types.js").PropertyValue>,
      });
    } catch (err) {
      log(`[lead_scrape] db-row upsert failed for ${name}: ${(err as Error).message}`);
    }

    inserted++;
    log(`[lead_scrape] persisted: ${name}`);
  }

  return inserted;
}

// ── Tool factory ──────────────────────────────────────────────────────────────

/**
 * `lead_scrape` is a Business & Agency plugin tool: core keeps the name as a slot
 * (src/plugins/core-tool-slots.ts) that the plugin fills while it is enabled.
 * With the plugin off the slot is empty and agents never see the tool.
 */
export function createLeadScrapeTool(): AnyAgentTool {
  return createSlotTool("lead_scrape", "Business & Agency");
}

/** The real tool; the business-agency plugin fills the slot with it. */
export function createLeadScrapeToolImpl(): AnyAgentTool {
  return {
    label: "Lead Scrape (Playwright)",
    name: leadScrapeName,
    description: `Scrape leads from Google Maps, Instagram, or a directory URL using a real (visible) browser window.

Uses the compiled Playwright module at: ${fileURLToPath(import.meta.url).replace("lead-scrape-tool", "../../workflows/playwright/scrape-leads")}

The same module is loaded on every call — the LLM never writes browser automation.
Scraped leads are automatically inserted into the active business's CRM.

Sources:
- google_maps: Search Google Maps by keyword (e.g. "coffee shops Bangkok"). Requires Chrome/Chromium.
- instagram_search: Scrape a profile (@handle) or hashtag (#tag). Requires storageStatePath.
- directory_site: Navigate directly to a URL and extract structured business data.

Examples:
  { "source": "google_maps", "query": "pressure washing Atlanta", "maxResults": 20 }
  { "source": "directory_site", "query": "https://example-directory.com/businesses", "maxResults": 10 }
  { "source": "instagram_search", "query": "@restauranthandle", "storageStatePath": "/tmp/ig-auth.json" }`,

    parameters: LeadScrapeSchema,

    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;

      const source = readStringParam(params, "source", { required: true }) as
        | ScrapeLeadsInput["source"]
        | undefined;
      const query = readStringParam(params, "query", { required: true });

      if (!source || !query) {
        return jsonResult({ status: "error", error: "source and query are required" });
      }

      const maxResults = readNumberParam(params, "maxResults", { integer: true }) ?? 50;
      const storageStatePath = readStringParam(params, "storageStatePath");
      const explicitBusinessId = readStringParam(params, "business_id");

      const businessId = resolveActiveBusinessId(explicitBusinessId);

      const logs: string[] = [];
      const emit = (line: string) => {
        logs.push(line);
        console.log(line);
      };

      emit(`[lead_scrape] SCRAPE_LEADS_MODULE_PATH=${SCRAPE_LEADS_MODULE_PATH}`);

      try {
        const scrapeInput: ScrapeLeadsInput = {
          source,
          query,
          maxResults,
          filters:
            typeof params.filters === "object" && params.filters !== null
              ? (params.filters as Record<string, string>)
              : undefined,
          headless: false,
          storageStatePath,
        };

        const output = await scrapeLeads(scrapeInput, { log: emit });

        let leadsInserted = 0;
        if (businessId && output.leads.length > 0) {
          leadsInserted = persistLeads(output.leads, source, businessId, emit);
        } else if (!businessId && output.leads.length > 0) {
          emit("[lead_scrape] no active business — leads scraped but not persisted to CRM");
        }

        return jsonResult({
          status: "ok",
          source,
          query,
          leads: output.leads,
          totalSeen: output.totalSeen,
          truncated: output.truncated,
          durationMs: output.durationMs,
          leadsInserted,
          businessId,
          moduleUsed: SCRAPE_LEADS_MODULE_PATH,
          log: logs,
        });
      } catch (err) {
        return jsonResult({
          status: "error",
          error: (err as Error).message,
          log: logs,
        });
      }
    },
  };
}
