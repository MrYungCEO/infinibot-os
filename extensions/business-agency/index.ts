/**
 * Business & Agency — first-party InfiniBot plugin (manifest v2).
 *
 * Every business- and command-related surface used to be core, split over
 * two "Business" sidebar groups. It is now this one plugin, bundled but OFF on
 * a fresh install; an upgrading install that already has business data
 * (agencies, clients, pipeline, register rows, HQ progress) is switched on
 * once at boot (src/plugins/core-surface-migrations.ts). While enabled it
 * contributes:
 *   - ONE sidebar section "Business & Agency": Business HQ, Command, Clients,
 *     Sales Pipeline, Register, Leads & Funnels, Business settings (the pages
 *     are plugin-gated tabs; /dashboard shows Business HQ only while on);
 *   - the agency selector in the topbar (`contributes.topbarSlots`);
 *   - every business RPC as `business-agency.*`, plus the legacy names
 *     (agency.ops.*, business.*, clients.*, leads.*, funnels.*, campaigns.*,
 *     opportunity.*, decision.*, risk.*, commitment.*, person.*, hq.*) as
 *     manifest-declared aliases, so the control UI, mobile app, satellites
 *     and agent tools keep calling the names they know;
 *   - the business agent tools (served from core slots, see core-tool-slots);
 *   - the business roster agents (agents/roster.json);
 *   - the agency operating loop, agency SOP schedules and the CEO hourly
 *     report (seeded and run by core only while this plugin is loaded).
 *
 * The backend still compiles into core and is reached only through the
 * `businessAgency` seam (api.runtime.host.businessAgency), which lazy-loads it.
 * Turning the plugin off unregisters all of the above; stored data is never
 * moved or deleted.
 *
 * Docs: docs/plugins/BUSINESS-AGENCY.md.
 */

import type { InfiniBotPluginApi } from "infinibot/plugin-sdk";

/** Must match src/business-hub/plugin-runtime.ts BUSINESS_HUB_HTTP_PATHS and the manifest. */
const HUB_HTTP_PATHS = [
  "/plugins/business-agency/t/s.js",
  "/plugins/business-agency/t/c",
  "/plugins/business-agency/t/o",
  "/plugins/business-agency/t/k",
  "/plugins/business-agency/u",
  "/plugins/business-agency/webhooks/email",
  "/plugins/business-agency/webhooks/revenue",
  "/plugins/business-agency/book",
  "/plugins/business-agency/book/ics",
];

export default function register(api: InfiniBotPluginApi) {
  // Core's instance of the seam: jiti gives a plugin its own copies of every
  // core module it imports, and two copies of the JSON-backed business stores
  // (business.json, hq-progress.json) would overwrite each other.
  const host = api.runtime.host;
  const ba = host.businessAgency;

  for (const [method, handler] of Object.entries(ba.createHandlers())) {
    api.registerGatewayMethod(method, handler);
  }

  // Business hub public routes: tracking snippet + collector, email open /
  // click / unsubscribe and the email + revenue webhooks. Each authenticates
  // itself (site key, signed token or webhook secret) — manifest selfAuthHttp.
  // Loaded on the first request, so a gateway that never gets one never loads the hub.
  let routes: ReturnType<typeof ba.hub.httpRoutes> | null = null;
  for (const path of HUB_HTTP_PATHS) {
    api.registerHttpRoute({
      path,
      handler: async (req, res) => {
        routes ??= ba.hub.httpRoutes();
        const handler = (await routes)[path];
        if (!handler) return void res.writeHead(404).end();
        await handler(req, res);
      },
    });
  }

  // Sender loop, revenue sync, follow-up sync and the one-time migration.
  api.registerService({ id: "business-hub", start: () => ba.hub.start(), stop: () => ba.hub.stop() });

  // Agent tools keep their long-standing names through core's tool slots
  // (src/plugins/core-tool-slots.ts); empty slots are invisible to agents.
  for (const name of ba.toolNames) {
    const factory = ba.toolFactories[name];
    if (!factory) continue;
    host.setCoreToolSlot(name, { pluginId: api.id, pluginName: ba.pluginName, factory });
  }
}
