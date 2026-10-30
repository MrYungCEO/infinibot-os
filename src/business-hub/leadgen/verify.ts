/**
 * Lead generation — per-lead email verification: grade published addresses
 * (MX / disposable / role), add one first.last pattern guess for a named
 * person when nothing personal was published, then let a configured external
 * verifier (AfterShip, Reacher, Hunter) refine the primary address.
 */

import type { HubDb } from "../db.js";
import { isFreeMailDomain, registrableDomain } from "../util.js";
import { isEnabled, loadLeadgenConfig, providerCtx } from "./config.js";
import { emailPatternCandidates, lookupMx, verifyEmailAddress } from "./email.js";
import { LEAD_PROVIDERS } from "./providers.js";
import type {
  EmailVerdict,
  LeadData,
  LeadEmail,
  LeadgenConfig,
  LeadgenDeps,
  LeadProvider,
} from "./types.js";

/** Enabled + available external verifiers (the built-in MX check always runs). */
export function activeVerifiers(db: HubDb, cfg: LeadgenConfig, deps: LeadgenDeps): LeadProvider[] {
  return LEAD_PROVIDERS.filter(
    (p) =>
      p.verify &&
      p.id !== "email-patterns" &&
      isEnabled(p, cfg) &&
      p.available(cfg, providerCtx(db, cfg, p, deps).apiKey).ok,
  );
}

const STATUS_RANK: Record<string, number> = { valid: 0, risky: 1, unknown: 2, invalid: 3 };

/** Pick the best address: valid > risky; own-domain personal > own-domain role > other. */
export function pickPrimaryEmail(lead: LeadData): LeadEmail | null {
  const usable = lead.emails.filter((e) => e.status !== "invalid");
  if (!usable.length) return null;
  return [...usable].sort(
    (a, b) =>
      (STATUS_RANK[a.status ?? "unknown"] ?? 2) - (STATUS_RANK[b.status ?? "unknown"] ?? 2) ||
      Number(!!b.onDomain) - Number(!!a.onDomain) ||
      Number(!!a.role) - Number(!!b.role) ||
      Number(a.source === "pattern") - Number(b.source === "pattern"),
  )[0];
}

async function externalVerify(
  email: string,
  verifiers: LeadProvider[],
  db: HubDb,
  cfg: LeadgenConfig,
  deps: LeadgenDeps,
): Promise<EmailVerdict | null> {
  for (const p of verifiers) {
    try {
      const v = await p.verify?.(email, providerCtx(db, cfg, p, deps));
      if (v) return v;
    } catch {
      /* next verifier */
    }
  }
  return null;
}

/**
 * Verify published addresses (MX + disposable + role), guess patterns for
 * named people when no personal address was published, then let a configured
 * external verifier refine the primary address.
 */
export async function verifyLeadEmails(
  lead: LeadData,
  opts: { db: HubDb; cfg: LeadgenConfig; deps: LeadgenDeps; verifiers: LeadProvider[] },
): Promise<void> {
  const { deps } = opts;
  for (const e of lead.emails) {
    if (e.status === "valid" || e.status === "invalid") continue;
    const v = await verifyEmailAddress(e.email, { foundOnSite: e.source !== "pattern", deps });
    e.status = v.status;
    e.reasons = v.reasons;
    e.role = v.role;
  }
  const domain = lead.domain ?? registrableDomain(lead.website);
  const hasPersonal = lead.emails.some((e) => !e.role && e.status !== "invalid" && e.onDomain);
  if (domain && !isFreeMailDomain(domain) && !hasPersonal) {
    const person = lead.people.find((p) => !p.email && p.name.trim().includes(" "));
    if (person) {
      const mx = await lookupMx(domain, deps);
      if (mx.ok) {
        const [guess] = emailPatternCandidates({ name: person.name }, domain).slice(1, 2); // first.last
        if (guess && !lead.emails.some((e) => e.email === guess)) {
          lead.emails.push({
            email: guess,
            source: "pattern",
            status: "risky",
            reasons: [
              "pattern guess (first.last)",
              "domain accepts mail (MX)",
              "mailbox unconfirmed (no SMTP probing)",
            ],
            role: false,
            onDomain: true,
            personName: person.name,
          });
        }
      }
    }
  }
  let primary = pickPrimaryEmail(lead);
  if (primary && opts.verifiers.length) {
    const v = await externalVerify(primary.email, opts.verifiers, opts.db, opts.cfg, deps);
    if (v) {
      primary.status = v.status;
      primary.reasons = [
        ...(primary.reasons ?? []),
        ...v.reasons.map((r) => `${v.provider}: ${r}`),
      ];
      primary = pickPrimaryEmail(lead);
    }
  }
  lead.email = primary?.email ?? null;
  lead.emailStatus = primary?.status ?? undefined;
}

/** Standalone address check (RPC `hub.leadgen.verifyEmail`). */
export async function verifyEmail(
  db: HubDb,
  email: string,
  deps: LeadgenDeps = {},
): Promise<EmailVerdict> {
  const cfg = loadLeadgenConfig(db);
  const base = await verifyEmailAddress(email, { deps });
  if (base.status === "invalid") return base;
  const verifiers = activeVerifiers(db, cfg, deps);
  const ext = await externalVerify(base.email, verifiers, db, cfg, deps);
  return ext ? { ...ext, reasons: [...base.reasons, ...ext.reasons] } : base;
}
