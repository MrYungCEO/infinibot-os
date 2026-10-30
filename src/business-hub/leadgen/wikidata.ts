/**
 * Lead generation — `wikidata` enrich provider (keyless, opt-in): look up an
 * organisation by its official website (P856) or exact English label and
 * read industry (P452), employees (P1128), inception (P571) and country
 * (P17). Wikidata content is CC0.
 */

import { registrableDomain } from "../util.js";
import { jsonRequest } from "./http.js";
import type { LeadData, ProviderCtx } from "./types.js";

export const WIKIDATA_SPARQL = "https://query.wikidata.org/sparql";
export const WIKIDATA_ATTRIBUTION = "Wikidata (CC0)";

function sparqlString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ")}"`;
}

/** SPARQL for an org by website domain variants, or by exact label when no domain. */
export function buildWikidataQuery(input: {
  domain?: string | null;
  name?: string | null;
}): string | null {
  let match = "";
  if (input.domain) {
    const d = input.domain.toLowerCase();
    const variants = ["https://", "http://"]
      .flatMap((p) => [`${p}${d}`, `${p}www.${d}`])
      .flatMap((u) => [`<${u}>`, `<${u}/>`]);
    match = `VALUES ?site { ${variants.join(" ")} } ?item wdt:P856 ?site .`;
  } else if (input.name) {
    match = `?item rdfs:label ${sparqlString(input.name)}@en ; wdt:P452 [] .`;
  } else return null;
  return `SELECT ?item ?itemLabel ?industryLabel ?employees ?inception ?countryLabel WHERE {
  ${match}
  OPTIONAL { ?item wdt:P452 ?industry . }
  OPTIONAL { ?item wdt:P1128 ?employees . }
  OPTIONAL { ?item wdt:P571 ?inception . }
  OPTIONAL { ?item wdt:P17 ?country . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} LIMIT 5`;
}

type Binding = Record<string, { value: string } | undefined>;

export function applyWikidata(lead: LeadData, json: unknown): boolean {
  const rows = (json as { results?: { bindings?: Binding[] } })?.results?.bindings ?? [];
  const b = rows[0];
  if (!b) return false;
  if (!lead.industry && b.industryLabel?.value) lead.industry = b.industryLabel.value;
  const emp = Number(b.employees?.value);
  if (lead.employees == null && Number.isFinite(emp)) lead.employees = emp;
  if (!lead.founded && b.inception?.value)
    lead.founded = b.inception.value.replace(/^\+/, "").slice(0, 10);
  if (!lead.country && b.countryLabel?.value) lead.country = b.countryLabel.value;
  if (b.item?.value) lead.refs.wikidata = b.item.value.replace(/^.*\//, "");
  if (!lead.providers.includes("wikidata")) lead.providers.push("wikidata");
  if (!lead.attribution.includes(WIKIDATA_ATTRIBUTION)) lead.attribution.push(WIKIDATA_ATTRIBUTION);
  return true;
}

export async function wikidataEnrich(lead: LeadData, ctx: ProviderCtx): Promise<void> {
  const q = buildWikidataQuery({
    domain: lead.domain ?? registrableDomain(lead.website),
    name: lead.name,
  });
  if (!q) return;
  const u = new URL(ctx.settings.endpoint || WIKIDATA_SPARQL);
  u.searchParams.set("query", q);
  u.searchParams.set("format", "json");
  const res = await jsonRequest<unknown>(ctx.fetch, u.toString(), {
    headers: { Accept: "application/sparql-results+json" },
    timeoutMs: 10_000,
  });
  if (res.status !== 200) throw new Error(`Wikidata HTTP ${res.status}`);
  applyWikidata(lead, res.data);
}
