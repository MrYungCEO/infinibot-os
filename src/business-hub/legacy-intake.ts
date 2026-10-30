/**
 * Business hub — intake from the older public form endpoints (form bindings,
 * landing-page forms, funnel pages, lead-qualifier forms). Their own storage
 * stays as it is; this makes every submission ALSO become a hub contact with
 * a timeline entry and an open deal, so form leads are no longer a dead end.
 *
 * Best effort and fire-and-forget: a hub failure never fails the visitor's
 * submit, and nothing happens while the business-agency plugin is off.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("business-hub");

function pick(fields: Record<string, unknown>, re: RegExp): string | null {
  for (const [k, v] of Object.entries(fields)) {
    if (re.test(k) && (typeof v === "string" || typeof v === "number") && String(v).trim())
      return String(v).trim();
  }
  return null;
}

export type LegacyFormInput = {
  /** Shown as the source, e.g. "Landing page form", "Lead qualifier: roofing". */
  sourceName: string;
  fields: Record<string, unknown>;
  utm?: { campaign?: string | null; source?: string | null } | null;
  pageRef?: string | null;
};

export async function feedHubFromLegacyForm(input: LegacyFormInput): Promise<void> {
  try {
    const { isBusinessAgencyActive } = await import("../business-agency/runtime.js");
    if (!isBusinessAgencyActive()) return;
    const f = input.fields ?? {};
    const email = pick(f, /^(e-?mail|email_?address|your_?email)$|e-?mail/i);
    const name = pick(f, /^(full_?name|name|your_?name|contact_?name)$/i);
    const first = pick(f, /^(first_?name|given_?name|fname)$/i);
    const last = pick(f, /^(last_?name|surname|family_?name|lname)$/i);
    const phone = pick(f, /phone|tel|mobile|whatsapp/i);
    if (!email && !phone && !name && !first) return;
    const [{ getHubDb }, { ingestLead, agencyClientLinker }] = await Promise.all([
      import("./db.js"),
      import("./automation.js"),
    ]);
    const db = getHubDb();
    const consent = Object.entries(f).some(
      ([k, v]) =>
        /consent|opt_?in|subscribe|marketing/i.test(k) && /^(1|true|on|yes)$/i.test(String(v)),
    );
    ingestLead(
      db,
      {
        email,
        name,
        firstName: first,
        lastName: last,
        phone,
        company: pick(f, /company|business|organi[sz]ation/i),
        website: pick(f, /website|url|domain/i),
        message: pick(f, /message|note|comment|details|how_?can/i),
        consent,
        fields: f,
        source: { kind: "form", name: input.sourceName.slice(0, 120) },
        utmCampaign:
          input.utm?.campaign ?? (typeof f.utm_campaign === "string" ? f.utm_campaign : null),
        pageRef: input.pageRef ?? null,
      },
      { linkClient: agencyClientLinker(db) },
    );
  } catch (err) {
    log.warn(
      `hub intake from legacy form failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
