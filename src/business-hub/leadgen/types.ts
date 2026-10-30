/**
 * Lead generation — shared types: the normalised lead record every provider
 * produces, the provider contract, the persisted config shape and the
 * injectable network dependencies (so tests never touch the network).
 */

import type { HubDb } from "../db.js";

export const LEADGEN_USER_AGENT = "InfiniBot-BusinessHub/1.0 (+https://infinibotos.com)";
/** Token matched against robots.txt `User-agent:` lines. */
export const LEADGEN_ROBOTS_TOKEN = "infinibot-businesshub";

export type EmailVerdictStatus = "valid" | "risky" | "invalid" | "unknown";

export type LeadEmail = {
  email: string;
  /** Where it came from: "osm", "website", "jsonld", "pattern", "hunter", … */
  source: string;
  status?: EmailVerdictStatus;
  reasons?: string[];
  role?: boolean;
  /** On the company's own registrable domain. */
  onDomain?: boolean;
  /** Person this address belongs to (pattern guesses, team pages). */
  personName?: string;
};

export type LeadPerson = { name: string; title?: string | null; email?: string | null };

/** One business, as found/enriched by providers. Stored in leadgen_results.data. */
export type LeadData = {
  name: string;
  website?: string | null;
  domain?: string | null;
  phone?: string | null;
  phoneE164?: string | null;
  phones?: string[];
  emails: LeadEmail[];
  /** Best email after verification (also mirrored by emailStatus). */
  email?: string | null;
  emailStatus?: EmailVerdictStatus;
  address?: string | null;
  street?: string | null;
  city?: string | null;
  region?: string | null;
  postcode?: string | null;
  country?: string | null;
  lat?: number | null;
  lon?: number | null;
  category?: string | null;
  /** True when a provider matched the query by category (not just a name regex). */
  categoryMatched?: boolean;
  openingHours?: string | null;
  rating?: number | null;
  reviewCount?: number | null;
  description?: string | null;
  industry?: string | null;
  employees?: number | null;
  founded?: string | null;
  social: Record<string, string>;
  people: LeadPerson[];
  /** Provider ids that contributed. */
  providers: string[];
  /** Provider-specific ids ("osm" → "node/123", "gosom" → maps link, …). */
  refs: Record<string, string>;
  attribution: string[];
  scoreReasons?: string[];
  existing?: { companyId?: string | null; contactId?: string | null } | null;
  notes?: string[];
};

export type ProviderKind = "search" | "enrich" | "verify";

export type ProviderSettings = {
  enabled?: boolean;
  serviceUrl?: string;
  /** Encrypted at rest (secret-crypto); never returned by RPCs. */
  apiKey?: string;
  endpoint?: string;
  /** OSM only: geocoder (Photon-compatible) URL, or "none" for Overpass area-by-name. */
  geocoderUrl?: string;
};

export type LeadgenConfig = {
  providers: Record<string, ProviderSettings>;
  defaultCountry: string;
  dailyOverpassQuota: number;
};

export type Availability = { ok: boolean; reason?: string };

export type EmailVerdict = {
  email: string;
  status: EmailVerdictStatus;
  reasons: string[];
  mx: boolean | null;
  disposable: boolean;
  freeMail: boolean;
  role: boolean;
  provider?: string;
};

export type MxRecord = { exchange: string; priority: number };
export type LookupAddress = { address: string; family: number };

export type LeadgenDeps = {
  fetchImpl?: typeof fetch;
  resolveMx?: (domain: string) => Promise<MxRecord[]>;
  /** DNS lookup used by the SSRF guard (all addresses of a host). */
  lookupHost?: (host: string) => Promise<LookupAddress[]>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  env?: Record<string, string | undefined>;
  /** Secret codec for stored API keys (defaults to services/email/secret-crypto). */
  secrets?: { encrypt: (s: string) => string | null; decrypt: (s: string) => string | null };
  /** Min gap between requests to one website host (default 1000ms). */
  hostIntervalMs?: number;
  /** gosom job polling interval (default 5000ms). */
  pollIntervalMs?: number;
  onProgress?: (jobId: string, progress: JobProgress) => void;
};

export type JobProgress = {
  stage: "queued" | "search" | "enrich" | "verify" | "score" | "done" | "error";
  found: number;
  enriched: number;
  verified: number;
  total?: number;
  errors?: string[];
  attribution?: string[];
};

/** Resolved runtime context handed to providers. */
export type ProviderCtx = {
  db: HubDb;
  cfg: LeadgenConfig;
  settings: ProviderSettings;
  apiKey: string | null;
  deps: LeadgenDeps;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  country: string;
};

export type SearchInput = { query: string; location?: string | null; limit: number };

export type LeadProvider = {
  id: string;
  label: string;
  kind: ProviderKind;
  description: string;
  /** Licence / ToS note shown in the UI. */
  notice?: string;
  requires?: { key?: string; serviceUrl?: string };
  /** Enabled when there is no config entry. */
  defaultEnabled: boolean;
  /** Env vars consulted when no key is stored in config (BYOK). */
  envKeys?: string[];
  available: (cfg: LeadgenConfig, apiKey: string | null) => Availability;
  search?: (
    input: SearchInput,
    ctx: ProviderCtx,
  ) => Promise<{ leads: LeadData[]; attribution?: string }>;
  enrich?: (lead: LeadData, ctx: ProviderCtx) => Promise<void>;
  verify?: (email: string, ctx: ProviderCtx) => Promise<EmailVerdict | null>;
};

export function emptyLead(name: string, provider: string): LeadData {
  return {
    name,
    emails: [],
    social: {},
    people: [],
    providers: [provider],
    refs: {},
    attribution: [],
  };
}
