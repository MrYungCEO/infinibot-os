/**
 * Lead scoring and routing — plain code, no LLM (plan §1 "deterministic first").
 *
 *   score = Σ weight(q) × points(answer) / 100      (weights add up to 100 → 0..100)
 *   tier  = hot ≥ 60, warm 30–59, nurture < 30
 *   route = routing.ts: primary + secondary offer + CTA for EVERY input (never "none")
 *
 * Routing picks the active onboarder who handles that offer with the fewest
 * open leads (ties → longest since last assignment), i.e. round-robin weighted
 * by load.
 */

import type {
  IntakeQuestion,
  Lead,
  LeadTier,
  RolePurpose,
  RoutedOffer,
  Settings,
  TeamMember,
} from "./contract.js";
import { HOT_THRESHOLD, WARM_THRESHOLD } from "./defaults.js";
import { mayGetTradingRole, routeOffer, type OfferRoute } from "./routing.js";

export type ScoreResult = {
  score: number;
  tier: LeadTier;
  /** = route.primaryOffer */
  offer: RoutedOffer;
  route: OfferRoute;
  roles: RolePurpose[];
  breakdown: Lead["breakdown"];
  complete: boolean;
};

export function tierFor(score: number): LeadTier {
  if (score >= HOT_THRESHOLD) return "hot";
  if (score >= WARM_THRESHOLD) return "warm";
  return "nurture";
}

export function scoreLead(
  questions: IntakeQuestion[],
  answers: Record<string, string>,
  settings?: Pick<Settings, "channelMap" | "offerLinks" | "compliance"> | null,
): ScoreResult {
  let total = 0;
  const roles: RolePurpose[] = [];
  const breakdown: Lead["breakdown"] = [];
  let complete = true;
  for (const q of Array.isArray(questions) ? questions : []) {
    if (!q || !Array.isArray(q.options)) continue;
    const value = answers?.[q.id];
    const opt = q.options.find((o) => o.value === value);
    if (!opt) {
      complete = false;
      continue;
    }
    const points = Math.max(0, Math.min(100, Number(opt.points) || 0));
    const contribution = ((Number(q.weight) || 0) * points) / 100;
    total += contribution;
    breakdown.push({ questionId: q.id, answer: opt.value, points, weight: q.weight, contribution });
    if (opt.role && !roles.includes(opt.role)) roles.push(opt.role);
  }
  const score = Math.round(Math.max(0, Math.min(100, total)));
  const route = routeOffer(questions, answers, settings);
  // Hard age gate: no trading interest role unless 18+ is confirmed.
  const safeRoles = mayGetTradingRole(route) ? roles : roles.filter((r) => r !== "interest-pulse");
  return { score, tier: tierFor(score), offer: route.primaryOffer, route, roles: safeRoles, breakdown, complete };
}

export type QuestionIssue = { questionId: string | null; message: string };

/** Wizard step 5 validation (plan §4): ≤ 5 questions, unique values, weights = 100. */
export function validateQuestions(questions: IntakeQuestion[]): QuestionIssue[] {
  const issues: QuestionIssue[] = [];
  if (!Array.isArray(questions) || questions.length === 0) {
    return [{ questionId: null, message: "Add at least one question." }];
  }
  if (questions.length > 5) issues.push({ questionId: null, message: "At most 5 questions per step." });
  const ids = new Set<string>();
  let weights = 0;
  for (const q of questions) {
    if (!q.id || !/^[a-z0-9_-]{1,32}$/.test(q.id)) {
      issues.push({ questionId: q.id ?? null, message: "Question ids are 1–32 chars: a-z, 0-9, - or _." });
    }
    if (ids.has(q.id)) issues.push({ questionId: q.id, message: "Duplicate question id." });
    ids.add(q.id);
    if (!q.label?.trim()) issues.push({ questionId: q.id, message: "Question text is empty." });
    if (!Number.isFinite(q.weight) || q.weight < 0) {
      issues.push({ questionId: q.id, message: "Weight must be 0 or more." });
    }
    weights += Number.isFinite(q.weight) ? q.weight : 0;
    if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 25) {
      issues.push({ questionId: q.id, message: "Each question needs 2–25 options." });
      continue;
    }
    const values = new Set<string>();
    for (const o of q.options) {
      if (!o.value?.trim() || !o.label?.trim()) {
        issues.push({ questionId: q.id, message: "Every option needs a value and a label." });
      }
      if (values.has(o.value)) issues.push({ questionId: q.id, message: `Duplicate option value "${o.value}".` });
      values.add(o.value);
      if (!Number.isFinite(o.points) || o.points < 0 || o.points > 100) {
        issues.push({ questionId: q.id, message: `Points for "${o.label}" must be 0–100.` });
      }
    }
  }
  if (Math.round(weights) !== 100) {
    issues.push({ questionId: null, message: `Weights add up to ${Math.round(weights)}, not 100.` });
  }
  return issues;
}

export type RouteCandidate = TeamMember & { openLeads: number; lastAssignedAt: number };

const isKv = (o: string) => o === "kinglyvault" || o === "kinglyvault-plugins";
/** Team offers cover the lead's offer (KinglyVault learn and plugins share one desk). */
export function covers(teamOffers: string[], offer: RoutedOffer): boolean {
  return teamOffers.length === 0 || teamOffers.includes(offer) || (isKv(offer) && teamOffers.some(isKv));
}

/** The onboarder for a new lead, or null when nobody active covers the offer. */
export function pickAssignee(candidates: RouteCandidate[], offer: RoutedOffer): RouteCandidate | null {
  const eligible = candidates.filter(
    (c) => c.active && (c.role === "onboarder" || c.role === "manager") && covers(c.offers, offer),
  );
  if (eligible.length === 0) return null;
  eligible.sort((a, b) => a.openLeads - b.openLeads || a.lastAssignedAt - b.lastAssignedAt);
  return eligible[0] ?? null;
}
