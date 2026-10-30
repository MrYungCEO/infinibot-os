/**
 * Offer routing — the owner's positioning rule in code (no LLM, no I/O):
 *
 *   "make sure everyone is directed somewhere, there should never be no offer"
 *
 *   InfiniBot   = the main AI operating system (primary for AI / automation / business-with-AI).
 *   KinglyVault = where people learn (free + paid courses) and buy InfiniBot plugins; free tier is
 *                 the universal fallback.
 *   Gold Desk   = trading, only for qualified members (18+, allowed region, $100 funded broker).
 *                 Trading-interested members who don't qualify get KinglyVault free trading education.
 *
 * Every lead gets a primary AND a secondary offer and a concrete next step. There is no "none" route.
 * The control UI imports this file, so it stays free of Node imports.
 */

import type { ChannelPurpose, IntakeQuestion, Offer, RoutedOffer, Settings } from "./contract.js";

export type GateKind = "age" | "region" | "capital";
export type GateState = "pass" | "fail" | "unknown";

export type RouteReason =
  | "ai-interest"
  | "learn-interest"
  | "plugins-interest"
  | "trading-qualified"
  | "trading-under-18"
  | "trading-age-unknown"
  | "trading-region-blocked"
  | "trading-not-funded"
  | "default";

export const ROUTE_REASON_LABELS: Record<RouteReason, string> = {
  "ai-interest": "AI / automation interest",
  "learn-interest": "Learning / skills interest",
  "plugins-interest": "Plugins / tools interest",
  "trading-qualified": "Trading · qualified (18+, region, funded)",
  "trading-under-18": "Trading · under 18 → free education",
  "trading-age-unknown": "Trading · age not confirmed → free education",
  "trading-region-blocked": "Trading · region not allowed → free education",
  "trading-not-funded": "Trading · no funded account yet → free education",
  default: "No clear interest / incomplete → free default route",
};

export type OfferRoute = {
  primaryOffer: RoutedOffer;
  secondaryOffer: RoutedOffer;
  /** What the member is told to do next (never empty). */
  cta: string;
  reason: RouteReason;
  /** Gold Desk qualification gates as answered (unknown = not answered / not asked). */
  gates: Record<GateKind, GateState>;
};

/** Where each offer's next step points when the owner hasn't mapped a channel or link. */
export const OFFER_CHANNEL_PURPOSE: Record<RoutedOffer, ChannelPurpose> = {
  infinibot: "offer-infinibot",
  kinglyvault: "offer-kinglyvault",
  "kinglyvault-plugins": "offer-kinglyvault",
  pulse: "offer-golddesk",
};
export const OFFER_CHANNEL_FALLBACK: Record<RoutedOffer, string> = {
  infinibot: "#infinibot-start-here",
  kinglyvault: "#vault-start-here",
  "kinglyvault-plugins": "#vault-start-here",
  pulse: "#gold-desk-start-here",
};

/** The default route for unknown / low-score / incomplete members. */
export const DEFAULT_ROUTE: Pick<OfferRoute, "primaryOffer" | "secondaryOffer" | "reason"> = {
  primaryOffer: "infinibot",
  secondaryOffer: "kinglyvault",
  reason: "default",
};

const norm = (s: unknown) => String(s ?? "").toLowerCase();

/** Which qualification gate a question is (explicit `gate`, else inferred from id/label). */
export function gateOf(q: IntakeQuestion): GateKind | null {
  if (q.gate) return q.gate;
  const id = norm(q.id);
  const label = norm(q.label);
  if (id === "age" || /\b18\b|\bhow old\b|\bage\b/.test(label)) return "age";
  if (id === "region" || id === "country" || /\b(region|country|where do you live)\b/.test(label)) return "region";
  if (id === "capital" || id === "funded" || id === "broker" || id === "trading" || /\b(funded|broker|\$100|capital)\b/.test(label)) {
    return "capital";
  }
  return null;
}

/** Whether an answer passes its gate (explicit `pass`, else inferred, failing closed). */
export function optionPasses(gate: GateKind, opt: { value: string; label: string; pass?: boolean }, blockedRegions: string[] = []): boolean {
  if (typeof opt.pass === "boolean") return opt.pass;
  const text = `${norm(opt.value)} ${norm(opt.label)}`;
  if (gate === "age") {
    if (/\bunder\b|<\s*18|\bminor\b|\bno\b|\bnot\b|n't\b/.test(text)) return false;
    return /\byes\b|18\s*\+|\bover 18\b|\badult\b|\b18 or older\b/.test(text);
  }
  if (gate === "region") {
    const blocked = blockedRegions.map(norm);
    if (blocked.includes(norm(opt.value)) || blocked.includes(norm(opt.label))) return false;
    return !/\bblocked\b|\bnot\b|\bno\b|n't\b|\bunsure\b/.test(text);
  }
  // capital: needs a funded / fundable $100+ broker account
  // Any negation or doubt fails closed ("not ready to fund $100", "may not be supported / not sure").
  if (/\bno\b|\bnot\b|n't\b|\bnever\b|\bnone\b|\bunsure\b/.test(text)) return false;
  return /\$\s?100|\bcapital\b|\bactive\b|\bfunded\b|\byes\b/.test(text);
}

function gateStates(questions: IntakeQuestion[], answers: Record<string, string>, blockedRegions: string[]): Record<GateKind, GateState> {
  const gates: Record<GateKind, GateState> = { age: "unknown", region: "unknown", capital: "unknown" };
  let regionAsked = false;
  for (const q of questions) {
    const g = gateOf(q);
    if (!g) continue;
    if (g === "region") regionAsked = true;
    const opt = q.options.find((o) => o.value === answers[q.id]);
    if (!opt) continue;
    const ok = optionPasses(g, opt, blockedRegions);
    // Any failing answer for a gate wins (fail closed).
    if (gates[g] !== "fail") gates[g] = ok ? "pass" : "fail";
  }
  // No region question configured: the onboarder confirms the region in the Gold Desk checklist,
  // so it doesn't block routing (age + funding still must be answered and pass).
  if (!regionAsked && gates.region === "unknown") gates.region = "pass";
  return gates;
}

/** The interest the member stated: first answered option that names an offer. */
export function statedInterest(questions: IntakeQuestion[], answers: Record<string, string>): Offer {
  for (const q of questions) {
    const opt = q.options.find((o) => o.value === answers[q.id]);
    if (opt?.offer) return opt.offer;
  }
  return "none";
}

/**
 * The route for a member. Total over every input: any questions, any (or no) answers,
 * any compliance settings → a primary + secondary offer + a CTA.
 */
export function routeOffer(
  questions: IntakeQuestion[] | null | undefined,
  answers: Record<string, string> | null | undefined,
  settings?: Pick<Settings, "channelMap" | "offerLinks" | "compliance"> | null,
): OfferRoute {
  const qs = Array.isArray(questions) ? questions.filter((q) => q && Array.isArray(q.options)) : [];
  const ans = answers && typeof answers === "object" ? answers : {};
  const gates = gateStates(qs, ans, settings?.compliance?.blockedRegions ?? []);
  let interest = statedInterest(qs, ans);
  // Any trading signal (a Pulse-tagged answer or the Pulse interest role) makes this a trading lead
  // when the stated interest is only "learn" or nothing: the gates then decide Gold Desk vs free education.
  const tradingSignal = qs.some((q) => {
    const o = q.options.find((x) => x.value === ans[q.id]);
    return o?.offer === "pulse" || o?.role === "interest-pulse";
  });
  if (tradingSignal && (interest === "kinglyvault" || interest === "none")) interest = "pulse";

  let base: Pick<OfferRoute, "primaryOffer" | "secondaryOffer" | "reason">;
  switch (interest) {
    case "infinibot":
      base = { primaryOffer: "infinibot", secondaryOffer: "kinglyvault-plugins", reason: "ai-interest" };
      break;
    case "kinglyvault":
      base = { primaryOffer: "kinglyvault", secondaryOffer: "infinibot", reason: "learn-interest" };
      break;
    case "kinglyvault-plugins":
      base = { primaryOffer: "kinglyvault-plugins", secondaryOffer: "infinibot", reason: "plugins-interest" };
      break;
    case "pulse": {
      // Hard age gate: under 18 or age not confirmed is never routed to Gold Desk / Pulse.
      const reason: RouteReason | null =
        gates.age === "fail"
          ? "trading-under-18"
          : gates.age === "unknown"
            ? "trading-age-unknown"
            : gates.region !== "pass"
              ? "trading-region-blocked"
              : gates.capital !== "pass"
                ? "trading-not-funded"
                : null;
      base = reason
        ? { primaryOffer: "kinglyvault", secondaryOffer: "infinibot", reason }
        : { primaryOffer: "pulse", secondaryOffer: "kinglyvault", reason: "trading-qualified" };
      break;
    }
    default:
      base = { ...DEFAULT_ROUTE };
  }
  const trading = base.reason.startsWith("trading-") && base.reason !== "trading-qualified";
  return { ...base, gates, cta: buildCta(base.primaryOffer, base.secondaryOffer, settings, trading) };
}

/** True when the member may get the Pulse / trading interest role (18+ confirmed). */
export function mayGetTradingRole(route: OfferRoute): boolean {
  return route.gates.age === "pass";
}

function where(offer: RoutedOffer, settings?: Pick<Settings, "channelMap" | "offerLinks"> | null): string {
  const link = settings?.offerLinks?.[offer]?.trim();
  const channelId = settings?.channelMap?.[OFFER_CHANNEL_PURPOSE[offer]];
  const channel = channelId ? `<#${channelId}>` : OFFER_CHANNEL_FALLBACK[offer];
  return link ? `${channel} · ${link}` : channel;
}

/** One-line next step per offer (no prices, no invented links: links come from settings only). */
export function offerStep(
  offer: RoutedOffer,
  settings?: Pick<Settings, "channelMap" | "offerLinks"> | null,
  opts: { trading?: boolean } = {},
): string {
  const at = where(offer, settings);
  switch (offer) {
    case "infinibot":
      return `Start free with InfiniBot, the AI operating system: ${at}`;
    case "kinglyvault":
      return opts.trading
        ? `Free trading education on KinglyVault: ${at}`
        : `Learn free on KinglyVault (free + paid courses): ${at}`;
    case "kinglyvault-plugins":
      return `Get InfiniBot plugins on KinglyVault: ${at}`;
    case "pulse":
      return `Kingly Gold Desk: read the risk disclosure in ${at}, then an onboarder confirms 18+, region and broker funding`;
  }
}

export function buildCta(
  primary: RoutedOffer,
  secondary: RoutedOffer,
  settings?: Pick<Settings, "channelMap" | "offerLinks"> | null,
  trading = false,
): string {
  return `${offerStep(primary, settings, { trading })}\nAlso for you: ${offerStep(secondary, settings)}`;
}

/** Footer appended to the welcome DM so even members who never finish intake have a route. */
export function defaultRouteFooter(settings?: Pick<Settings, "channelMap" | "offerLinks"> | null): string {
  return `Not sure where to start? ${offerStep("infinibot", settings)}\nAnd ${offerStep("kinglyvault", settings).replace(/^L/, "l")}`;
}

/**
 * Welcome DM text: `{offers}` places the default route; a template that already names both
 * InfiniBot and KinglyVault is left alone; anything else gets the default route appended.
 */
export function renderWelcomeDm(
  template: string,
  name: string,
  settings?: Pick<Settings, "channelMap" | "offerLinks"> | null,
): string {
  const footer = defaultRouteFooter(settings);
  const body = (template || "").replace(/\{name\}/g, name);
  if (body.includes("{offers}")) return body.replace(/\{offers\}/g, footer);
  // The owner's own copy already routes to both InfiniBot and KinglyVault: don't repeat it.
  if (/infinibot/i.test(body) && /kingly\s*vault/i.test(body)) return body;
  return `${body.trim()}\n\n${footer}`;
}

/** The member-facing intake completion message (always names an offer + next step). */
export function intakeCompleteMessage(route: Pick<OfferRoute, "primaryOffer" | "cta">, hot: boolean, labels: Record<RoutedOffer, string>): string {
  const head = hot
    ? `You're all set! An onboarder will reach out shortly about ${labels[route.primaryOffer]}.`
    : `You're all set! Your best next step is ${labels[route.primaryOffer]}.`;
  return `${head}\n${route.cta}`;
}

export type MatrixRow = { id: string; who: string; route: OfferRoute };

/**
 * "Who goes where" for the current questionnaire: synthetic members per segment, run through
 * the real router. Used by the wizard preview and the tests; the last row is the fallback.
 */
export function routingMatrix(
  questions: IntakeQuestion[],
  settings?: Pick<Settings, "channelMap" | "offerLinks" | "compliance"> | null,
): MatrixRow[] {
  const blocked = settings?.compliance?.blockedRegions ?? [];
  const interestAnswer = (offer: Offer): Record<string, string> | null => {
    // Prefer a plain interest question over a gate question carrying the tag.
    const ordered = [...questions.filter((q) => !gateOf(q)), ...questions.filter((q) => gateOf(q))];
    for (const q of ordered) {
      const o = q.options.find((x) => x.offer === offer);
      if (o) return { [q.id]: o.value };
    }
    if (offer === "pulse") {
      // Trading interest carried by the role only (e.g. goal "Trading" with no offer tag).
      for (const q of ordered) {
        const o = q.options.find((x) => x.role === "interest-pulse");
        if (o) return { [q.id]: o.value };
      }
    }
    return null;
  };
  const gateAnswers = (want: Partial<Record<GateKind, boolean>>): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const q of questions) {
      const g = gateOf(q);
      if (!g || want[g] === undefined) continue;
      const o = q.options.find((x) => optionPasses(g, x, blocked) === want[g]);
      if (o) out[q.id] = o.value;
    }
    return out;
  };
  const rows: Array<[string, string, Offer, Partial<Record<GateKind, boolean>>]> = [
    ["ai", "AI / automation / business with AI", "infinibot", {}],
    ["learn", "Learning / skills / digital products", "kinglyvault", {}],
    ["plugins", "Plugins / tools for InfiniBot", "kinglyvault-plugins", {}],
    ["trade-ok", "Trading · 18+, allowed region, $100 funded", "pulse", { age: true, region: true, capital: true }],
    ["trade-minor", "Trading · under 18", "pulse", { age: false, region: true, capital: true }],
    ["trade-unfunded", "Trading · 18+ but not funded / unknown", "pulse", { age: true, region: true, capital: false }],
  ];
  const out: MatrixRow[] = [];
  for (const [id, who, offer, gates] of rows) {
    const interest = interestAnswer(offer);
    if (!interest) continue;
    if (offer === "pulse") {
      for (const q of questions) {
        const o = !gateOf(q) && !(q.id in interest) ? q.options.find((x) => x.role === "interest-pulse") : undefined;
        if (o) interest[q.id] = o.value;
      }
    }
    // Gate answers win when the interest tag sits on a gate question (e.g. "Ready to fund $100+" → Pulse),
    // so each row shows what a member with exactly that profile really gets.
    out.push({ id, who, route: routeOffer(questions, { ...interest, ...gateAnswers(gates) }, settings) });
  }
  out.push({ id: "fallback", who: "Fallback · unknown, low score, networking or incomplete intake", route: routeOffer(questions, {}, settings) });
  return out;
}
