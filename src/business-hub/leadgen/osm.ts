/**
 * Lead generation — `osm` search provider (keyless): geocode the location via
 * a configurable Photon endpoint (default photon.komoot.io; public Nominatim
 * is deliberately NOT used — its usage policy forbids default use by
 * low-code platforms) or, with geocoder "none", an Overpass area-by-name
 * lookup; then query Overpass for businesses whose OSM tags match the query's
 * category (plus a name regex fallback).
 *
 * Politeness: identifying User-Agent, one Overpass request at a time, a
 * per-day request quota persisted in hub_meta, 30s backoff on 429/504 and a
 * 10-minute result cache. Data © OpenStreetMap contributors, ODbL.
 */

import { getMeta, setMeta, type HubDb } from "../db.js";
import { normalizePhone, normalizeWebsite, registrableDomain, str } from "../util.js";
import { isRoleAddress } from "./email.js";
import { jsonRequest } from "./http.js";
import { emptyLead, type LeadData, type ProviderCtx, type SearchInput } from "./types.js";

export const OSM_ATTRIBUTION =
  "© OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright)";
export const DEFAULT_OVERPASS_URL = "https://overpass-api.de/api/interpreter";
export const DEFAULT_PHOTON_URL = "https://photon.komoot.io/api/";
const BACKOFF_MS = 30_000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const QUOTA_KEY = "leadgen.overpass.quota";

type TagFilter = [key: string, value: string];

/** Category words → OSM tags. Keys are matched as whole words (simple plural folding). */
export const CATEGORY_TAGS: Record<string, TagFilter[]> = {
  plumber: [["craft", "plumber"]],
  plumbing: [["craft", "plumber"]],
  electrician: [["craft", "electrician"]],
  hvac: [["craft", "hvac"]],
  roofing: [["craft", "roofer"]],
  roofer: [["craft", "roofer"]],
  carpenter: [["craft", "carpenter"]],
  painter: [["craft", "painter"]],
  locksmith: [
    ["shop", "locksmith"],
    ["craft", "locksmith"],
  ],
  landscaping: [
    ["craft", "gardener"],
    ["shop", "garden_centre"],
  ],
  landscaper: [["craft", "gardener"]],
  gardener: [["craft", "gardener"]],
  photographer: [
    ["craft", "photographer"],
    ["shop", "photo"],
  ],
  dentist: [
    ["amenity", "dentist"],
    ["healthcare", "dentist"],
  ],
  dental: [
    ["amenity", "dentist"],
    ["healthcare", "dentist"],
  ],
  orthodontist: [
    ["amenity", "dentist"],
    ["healthcare", "dentist"],
  ],
  doctor: [
    ["amenity", "doctors"],
    ["healthcare", "doctor"],
  ],
  clinic: [
    ["amenity", "clinic"],
    ["healthcare", "clinic"],
  ],
  chiropractor: [
    ["healthcare", "chiropractor"],
    ["healthcare", "alternative"],
  ],
  physiotherapist: [["healthcare", "physiotherapist"]],
  physiotherapy: [["healthcare", "physiotherapist"]],
  optician: [["shop", "optician"]],
  optometrist: [
    ["healthcare", "optometrist"],
    ["shop", "optician"],
  ],
  pharmacy: [["amenity", "pharmacy"]],
  veterinarian: [["amenity", "veterinary"]],
  vet: [["amenity", "veterinary"]],
  restaurant: [["amenity", "restaurant"]],
  cafe: [["amenity", "cafe"]],
  coffee: [
    ["amenity", "cafe"],
    ["shop", "coffee"],
  ],
  bar: [
    ["amenity", "bar"],
    ["amenity", "pub"],
  ],
  pub: [["amenity", "pub"]],
  bakery: [["shop", "bakery"]],
  "fast food": [["amenity", "fast_food"]],
  pizza: [
    ["amenity", "restaurant"],
    ["amenity", "fast_food"],
  ],
  hotel: [["tourism", "hotel"]],
  gym: [["leisure", "fitness_centre"]],
  fitness: [["leisure", "fitness_centre"]],
  yoga: [
    ["leisure", "fitness_centre"],
    ["sport", "yoga"],
  ],
  lawyer: [["office", "lawyer"]],
  attorney: [["office", "lawyer"]],
  "law firm": [["office", "lawyer"]],
  accountant: [["office", "accountant"]],
  accounting: [["office", "accountant"]],
  "tax advisor": [["office", "tax_advisor"]],
  "financial advisor": [["office", "financial_advisor"]],
  insurance: [["office", "insurance"]],
  "real estate": [["office", "estate_agent"]],
  realtor: [["office", "estate_agent"]],
  "estate agent": [["office", "estate_agent"]],
  architect: [["office", "architect"]],
  "marketing agency": [["office", "advertising_agency"]],
  "advertising agency": [["office", "advertising_agency"]],
  "it company": [["office", "it"]],
  software: [
    ["office", "it"],
    ["office", "software"],
  ],
  salon: [
    ["shop", "hairdresser"],
    ["shop", "beauty"],
  ],
  "hair salon": [["shop", "hairdresser"]],
  hairdresser: [["shop", "hairdresser"]],
  barber: [["shop", "hairdresser"]],
  "beauty salon": [["shop", "beauty"]],
  "nail salon": [["shop", "beauty"]],
  spa: [
    ["shop", "beauty"],
    ["leisure", "sauna"],
  ],
  massage: [["shop", "massage"]],
  tattoo: [["shop", "tattoo"]],
  florist: [["shop", "florist"]],
  "car repair": [["shop", "car_repair"]],
  "auto repair": [["shop", "car_repair"]],
  mechanic: [["shop", "car_repair"]],
  "car dealer": [["shop", "car"]],
  "pet grooming": [["shop", "pet_grooming"]],
  "pet store": [["shop", "pet"]],
  "dry cleaning": [["shop", "dry_cleaning"]],
  laundry: [["shop", "laundry"]],
  daycare: [
    ["amenity", "childcare"],
    ["amenity", "kindergarten"],
  ],
  "moving company": [["office", "moving_company"]],
  "travel agency": [["shop", "travel_agency"]],
  jeweler: [["shop", "jewelry"]],
  jewelry: [["shop", "jewelry"]],
  bookstore: [["shop", "books"]],
  furniture: [["shop", "furniture"]],
  "hardware store": [["shop", "hardware"]],
  coworking: [
    ["amenity", "coworking_space"],
    ["office", "coworking"],
  ],
};

const BUSINESS_KEYS = "^(shop|office|craft|amenity|healthcare|leisure|tourism)$";

function fold(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** OSM tag filters for a free-text query ("Dentists" → amenity=dentist, healthcare=dentist). */
export function categoryTags(query: string): TagFilter[] {
  const q = ` ${fold(query)} `;
  const out: TagFilter[] = [];
  const add = (fs: TagFilter[]) => {
    for (const f of fs) if (!out.some((o) => o[0] === f[0] && o[1] === f[1])) out.push(f);
  };
  // Longest keys first so "hair salon" wins over "salon".
  const keys = Object.keys(CATEGORY_TAGS).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    const forms = [k, `${k}s`, `${k}es`, k.endsWith("y") ? `${k.slice(0, -1)}ies` : k];
    if (forms.some((f) => q.includes(` ${f} `))) add(CATEGORY_TAGS[k]);
  }
  return out;
}

function escapeOverpass(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type AreaSpec =
  | { kind: "area"; id: number }
  | { kind: "bbox"; south: number; west: number; north: number; east: number }
  | { kind: "around"; lat: number; lon: number; radius: number }
  | { kind: "name"; name: string };

/** Build the Overpass QL for a query in an area. */
export function buildOverpassQuery(query: string, area: AreaSpec, limit: number): string {
  const tags = categoryTags(query);
  let head = "";
  let scope = "";
  if (area.kind === "area") {
    head = `area(id:${area.id})->.a;`;
    scope = "(area.a)";
  } else if (area.kind === "name") {
    head = `area["name"="${escapeOverpass(area.name)}"]["boundary"="administrative"]->.a;`;
    scope = "(area.a)";
  } else if (area.kind === "bbox") {
    scope = `(${area.south},${area.west},${area.north},${area.east})`;
  } else {
    scope = `(around:${Math.round(area.radius)},${area.lat},${area.lon})`;
  }
  const parts = tags.map(([k, v]) => `  nwr["${k}"="${v}"]["name"]${scope};`);
  const words = fold(query)
    .split(" ")
    .filter((w) => w.length >= 3)
    .map((w) => w.replace(/(ies)$/, "y").replace(/s$/, ""));
  if (words.length) {
    // The (singularised) phrase, so "real estate" does not match every "Real …".
    const re = escapeOverpass(words.map(escapeRegex).join(" "));
    parts.push(`  nwr[~"${BUSINESS_KEYS}"~"."]["name"~"${re}",i]${scope};`);
  }
  // Over-fetch so ranking can prefer entries with a website/phone (cheap for Overpass).
  const n = Math.min(Math.max(limit * 4, 50), 500);
  return `[out:json][timeout:25];\n${head}\n(\n${parts.join("\n")}\n);\nout center ${n};`;
}

type OverpassElement = {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
};

const SOCIAL_TAGS: Record<string, string> = {
  "contact:facebook": "facebook",
  "contact:instagram": "instagram",
  "contact:linkedin": "linkedin",
  "contact:twitter": "x",
  "contact:youtube": "youtube",
  "contact:tiktok": "tiktok",
  facebook: "facebook",
  instagram: "instagram",
};

/** Overpass JSON → leads (named elements only; de-duplicated by OSM id). */
export function parseOverpass(json: unknown, query: string, country = "US"): LeadData[] {
  const els = ((json as { elements?: OverpassElement[] })?.elements ?? []).filter(
    (e) => e.tags?.name,
  );
  const wanted = categoryTags(query);
  const out: LeadData[] = [];
  const seen = new Set<string>();
  for (const e of els) {
    const ref = `${e.type}/${e.id}`;
    if (seen.has(ref)) continue;
    seen.add(ref);
    const t = e.tags ?? {};
    const lead = emptyLead(t.name, "osm");
    lead.refs.osm = ref;
    lead.attribution.push(OSM_ATTRIBUTION);
    const website = normalizeWebsite(
      t.website ?? t["contact:website"] ?? t.url ?? t["brand:website"],
    );
    if (website) {
      lead.website = website;
      lead.domain = registrableDomain(website);
    }
    const phoneRaw = t.phone ?? t["contact:phone"] ?? t["contact:mobile"] ?? t.mobile;
    const phones = (phoneRaw ?? "")
      .split(/[;,]/)
      .map((p) => normalizePhone(p, country))
      .filter((p): p is string => !!p);
    if (phones.length) {
      lead.phone = phoneRaw?.split(/[;,]/)[0]?.trim() ?? phones[0];
      lead.phoneE164 = phones[0];
      lead.phones = phones;
    }
    for (const raw of (t.email ?? t["contact:email"] ?? "").split(/[;,]/)) {
      const em = str(raw)?.toLowerCase();
      if (em && /@/.test(em))
        lead.emails.push({
          email: em,
          source: "osm",
          role: isRoleAddress(em),
          onDomain: !!lead.domain && registrableDomain(em) === lead.domain,
        });
    }
    const street = [t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" ");
    lead.street = street || null;
    lead.city = t["addr:city"] ?? null;
    lead.region = t["addr:state"] ?? t["addr:province"] ?? null;
    lead.postcode = t["addr:postcode"] ?? null;
    lead.country = t["addr:country"] ?? null;
    lead.address =
      [street, t["addr:city"], [t["addr:state"], t["addr:postcode"]].filter(Boolean).join(" ")]
        .filter(Boolean)
        .join(", ") || null;
    lead.lat = e.lat ?? e.center?.lat ?? null;
    lead.lon = e.lon ?? e.center?.lon ?? null;
    lead.openingHours = t.opening_hours ?? null;
    const matched = wanted.find(([k, v]) => t[k] === v);
    lead.categoryMatched = !!matched;
    const catKey = ["craft", "amenity", "shop", "office", "healthcare", "leisure", "tourism"].find(
      (k) => t[k],
    );
    lead.category = matched ? matched[1] : catKey ? t[catKey] : null;
    for (const [k, net] of Object.entries(SOCIAL_TAGS)) {
      const v = t[k];
      if (!v || lead.social[net]) continue;
      lead.social[net] = /^https?:/i.test(v)
        ? v
        : `https://www.${net === "x" ? "x" : net}.com/${v.replace(/^@/, "")}`;
    }
    out.push(lead);
  }
  return out;
}

// ── Politeness: single concurrency, quota, cache ────────────────────────────

let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

const cache = new Map<string, { at: number; data: unknown }>();

function today(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function overpassQuotaUsed(db: HubDb, now = Date.now()): number {
  const raw = getMeta(db, QUOTA_KEY);
  try {
    const q = raw ? (JSON.parse(raw) as { day: string; count: number }) : null;
    return q && q.day === today(now) ? q.count : 0;
  } catch {
    return 0;
  }
}

function bumpQuota(db: HubDb, now: number): void {
  setMeta(
    db,
    QUOTA_KEY,
    JSON.stringify({ day: today(now), count: overpassQuotaUsed(db, now) + 1 }),
  );
}

async function overpassPost(ql: string, ctx: ProviderCtx): Promise<unknown> {
  const url = ctx.settings.endpoint || DEFAULT_OVERPASS_URL;
  const key = `${url}\n${ql}`;
  const hit = cache.get(key);
  if (hit && ctx.now() - hit.at < CACHE_TTL_MS) return hit.data;
  return serial(async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const quota = ctx.cfg.dailyOverpassQuota;
      if (overpassQuotaUsed(ctx.db, ctx.now()) >= quota)
        throw new Error(`daily Overpass quota reached (${quota}); raise it in lead-gen settings`);
      bumpQuota(ctx.db, ctx.now());
      const res = await jsonRequest<unknown>(ctx.fetch, url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `data=${encodeURIComponent(ql)}`,
        timeoutMs: 40_000,
      });
      if ((res.status === 429 || res.status === 504) && attempt === 0) {
        await ctx.sleep(BACKOFF_MS);
        continue;
      }
      if (res.status !== 200 || !res.data)
        throw new Error(
          `Overpass HTTP ${res.status}${res.status === 429 ? " (rate limited)" : ""}`,
        );
      cache.set(key, { at: ctx.now(), data: res.data });
      return res.data;
    }
    throw new Error("Overpass busy (429/504 after backoff)");
  });
}

type PhotonFeature = {
  geometry?: { coordinates?: [number, number] };
  properties?: {
    osm_type?: string;
    osm_id?: number;
    osm_key?: string;
    osm_value?: string;
    extent?: [number, number, number, number];
    name?: string;
  };
};

/** Photon feature → Overpass scope (relation area > bbox extent > 10km radius). */
export function areaFromPhoton(json: unknown): AreaSpec | null {
  const feats = ((json as { features?: PhotonFeature[] })?.features ?? []).filter(
    (f) => f.properties,
  );
  const best =
    feats.find(
      (f) => f.properties?.osm_type === "R" && /place|boundary/.test(f.properties?.osm_key ?? ""),
    ) ??
    feats.find((f) => f.properties?.extent) ??
    feats[0];
  if (!best?.properties) return null;
  const p = best.properties;
  if (p.osm_type === "R" && typeof p.osm_id === "number")
    return { kind: "area", id: 3_600_000_000 + p.osm_id };
  if (p.extent) {
    const [west, north, east, south] = p.extent;
    return { kind: "bbox", south, west, north, east };
  }
  const c = best.geometry?.coordinates;
  return c ? { kind: "around", lat: c[1], lon: c[0], radius: 10_000 } : null;
}

async function resolveArea(location: string, ctx: ProviderCtx): Promise<AreaSpec> {
  const geocoder = ctx.settings.geocoderUrl ?? DEFAULT_PHOTON_URL;
  const byName: AreaSpec = { kind: "name", name: location.split(",")[0].trim() };
  if (geocoder === "none") return byName;
  const u = new URL(geocoder);
  u.searchParams.set("q", location);
  u.searchParams.set("limit", "5");
  u.searchParams.set("lang", "en");
  const key = `photon\n${u}`;
  const hit = cache.get(key);
  let data: unknown = hit && ctx.now() - hit.at < CACHE_TTL_MS ? hit.data : null;
  if (!data) {
    try {
      const res = await jsonRequest<unknown>(ctx.fetch, u.toString(), { timeoutMs: 15_000 });
      if (res.status === 200 && res.data) {
        data = res.data;
        cache.set(key, { at: ctx.now(), data });
      }
    } catch {
      /* fall back to area-by-name */
    }
  }
  return (data ? areaFromPhoton(data) : null) ?? byName;
}

export async function osmSearch(
  input: SearchInput,
  ctx: ProviderCtx,
): Promise<{ leads: LeadData[]; attribution: string }> {
  if (!input.location) throw new Error("OpenStreetMap search needs a location (city, region)");
  const area = await resolveArea(input.location, ctx);
  const ql = buildOverpassQuery(input.query, area, input.limit);
  const json = await overpassPost(ql, ctx);
  const leads = parseOverpass(json, input.query, ctx.country);
  // Category matches first, then the ones with a website/phone (better leads).
  leads.sort(
    (a, b) =>
      Number(!!b.categoryMatched) - Number(!!a.categoryMatched) ||
      Number(!!b.website) + Number(!!b.phone) - (Number(!!a.website) + Number(!!a.phone)),
  );
  return { leads: leads.slice(0, input.limit), attribution: OSM_ATTRIBUTION };
}

/** Reset caches (tests). */
export function resetOsmState(): void {
  cache.clear();
  chain = Promise.resolve();
}
