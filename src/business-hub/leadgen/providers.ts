/**
 * Lead generation — provider registry. Built-ins are keyless (osm, website,
 * email-patterns, wikidata); self-hosted slots need a service URL; BYOK slots
 * need an API key (config, or the env vars the old services/lead-generation
 * scrapers used). Nothing external runs unless configured.
 */

import { applyCrawl, crawlSite } from "./website.js";
import { osmSearch, OSM_ATTRIBUTION } from "./osm.js";
import { verifyEmailAddress } from "./email.js";
import { wikidataEnrich } from "./wikidata.js";
import {
  apolloSearch,
  googlePlacesSearch,
  hunterEnrich,
  hunterVerify,
  serpapiSearch,
} from "./byok.js";
import { afterShipVerify, GOSOM_NOTICE, gosomSearch, reacherVerify } from "./external.js";
import type { Availability, LeadgenConfig, LeadProvider } from "./types.js";

const ok: Availability = { ok: true };

function needsUrl(id: string) {
  return (cfg: LeadgenConfig): Availability =>
    cfg.providers[id]?.serviceUrl
      ? ok
      : { ok: false, reason: "set the service URL of your self-hosted instance" };
}

function needsKey(cfg: LeadgenConfig, key: string | null): Availability {
  void cfg;
  return key ? ok : { ok: false, reason: "API key not configured" };
}

export const LEAD_PROVIDERS: readonly LeadProvider[] = [
  {
    id: "osm",
    label: "OpenStreetMap",
    kind: "search",
    description: "Businesses from OpenStreetMap via Overpass (keyless). Geocoding via Photon.",
    notice: OSM_ATTRIBUTION,
    defaultEnabled: true,
    available: () => ok,
    search: osmSearch,
  },
  {
    id: "website",
    label: "Website crawler",
    kind: "enrich",
    description:
      "Reads the business homepage and up to 4 contact/about/team pages (robots.txt honoured) for emails, phones, socials and JSON-LD.",
    defaultEnabled: true,
    available: () => ok,
    enrich: async (lead, ctx) => {
      if (!lead.website) return;
      const crawl = await crawlSite(lead.website, ctx.deps, ctx.country);
      applyCrawl(lead, crawl);
      if (crawl.skipped.length || crawl.errors.length)
        lead.notes = [
          ...(lead.notes ?? []),
          ...crawl.skipped.map((s) => `skipped ${s}`),
          ...crawl.errors,
        ];
    },
  },
  {
    id: "email-patterns",
    label: "Email patterns + MX",
    kind: "verify",
    description:
      "Guesses addresses from names (first.last@…), checks MX, disposable, free-mail and role addresses. No SMTP probing.",
    defaultEnabled: true,
    available: () => ok,
    verify: (email, ctx) => verifyEmailAddress(email, { deps: ctx.deps }),
  },
  {
    id: "wikidata",
    label: "Wikidata",
    kind: "enrich",
    description:
      "Industry, employees, founding date and country for organisations listed on Wikidata (CC0).",
    defaultEnabled: false,
    available: () => ok,
    enrich: wikidataEnrich,
  },
  {
    id: "gosom",
    label: "Google Maps scraper (self-hosted)",
    kind: "search",
    description: "Your own gosom/google-maps-scraper REST instance (web mode).",
    notice: GOSOM_NOTICE,
    requires: { serviceUrl: "http://localhost:8080" },
    defaultEnabled: false,
    available: needsUrl("gosom"),
    search: gosomSearch,
  },
  {
    id: "email-verifier",
    label: "AfterShip email-verifier (self-hosted)",
    kind: "verify",
    description:
      "Your own AfterShip/email-verifier apiserver (MIT). SMTP checks run from your server.",
    requires: { serviceUrl: "http://localhost:8080" },
    defaultEnabled: false,
    available: needsUrl("email-verifier"),
    verify: afterShipVerify,
  },
  {
    id: "reacher",
    label: "Reacher (self-hosted)",
    kind: "verify",
    description: "Your own Reacher / check-if-email-exists backend (AGPL-3.0, run by you).",
    notice: "check-if-email-exists is AGPL-3.0; InfiniBot only calls your instance over HTTP.",
    requires: { serviceUrl: "http://localhost:8080" },
    defaultEnabled: false,
    available: needsUrl("reacher"),
    verify: reacherVerify,
  },
  {
    id: "hunter",
    label: "Hunter.io",
    kind: "enrich",
    description: "Domain search + email verification (paid API, your key).",
    requires: { key: "HUNTER_API_KEY" },
    envKeys: ["HUNTER_API_KEY"],
    defaultEnabled: false,
    available: needsKey,
    enrich: hunterEnrich,
    verify: hunterVerify,
  },
  {
    id: "serpapi",
    label: "SerpAPI (Google Maps)",
    kind: "search",
    description: "Google Maps results through SerpAPI (paid API, your key).",
    requires: { key: "SERP_API_KEY" },
    envKeys: ["SERP_API_KEY", "SERPAPI_API_KEY"],
    defaultEnabled: false,
    available: needsKey,
    search: serpapiSearch,
  },
  {
    id: "google-places",
    label: "Google Places API",
    kind: "search",
    description: "Places API (New) text search (paid API, your key).",
    requires: { key: "GOOGLE_PLACES_API_KEY" },
    envKeys: ["GOOGLE_PLACES_API_KEY"],
    defaultEnabled: false,
    available: needsKey,
    search: googlePlacesSearch,
  },
  {
    id: "apollo",
    label: "Apollo.io",
    kind: "search",
    description: "B2B company search (paid API, your key).",
    requires: { key: "APOLLO_API_KEY" },
    envKeys: ["APOLLO_API_KEY"],
    defaultEnabled: false,
    available: needsKey,
    search: apolloSearch,
  },
];

export function getProvider(id: string): LeadProvider | undefined {
  return LEAD_PROVIDERS.find((p) => p.id === id);
}
