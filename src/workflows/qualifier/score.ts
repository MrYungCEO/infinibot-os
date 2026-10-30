/**
 * Lead Qualifier Worker
 *
 * Takes an enriched lead and runs two-pass qualification:
 *   Pass 1 — Fast rule filter (configurable per-campaign overrides).
 *   Pass 2 — LLM scoring via Claude API.
 *
 * Output: { score: 0-100, reason: string, recommended_pitch: string }
 * Transition: enriched → scored → qualified/disqualified based on threshold.
 *
 * Template prompts live at ~/.infinibot/qualifier/templates/<campaign>.md
 * A sensible default is used if the file is missing.
 *
 * Usage:
 *   import { scoreLead } from "./score.js";
 *   const result = await scoreLead({ lead, campaignId, threshold: 70 });
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LeadForQualification {
  id: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  address?: string | null;
  rating?: number | null;
  reviewCount?: number | null;
  companySizeHint?: string | null;
  description?: string | null;
  lifecycleStatus?: string | null;
  leadSource?: string | null;
}

export interface QualificationRules {
  /** Campaigns that pitch website-building should NOT disqualify leads with no website. */
  noWebsiteDisqualifies?: boolean;
  minRating?: number;
  minReviewCount?: number;
  requireEmail?: boolean;
  requirePhone?: boolean;
}

export interface QualificationResult {
  leadId: string;
  score: number;
  reason: string;
  recommended_pitch: string;
  status: "qualified" | "disqualified" | "scoring_failed";
  passedRuleFilter: boolean;
  llmCalled: boolean;
  errorMessage?: string;
}

export interface ScoreLeadOpts {
  lead: LeadForQualification;
  campaignId?: string;
  threshold?: number;
  rules?: QualificationRules;
  log?: (line: string) => void;
  signal?: AbortSignal;
}

// ── Default qualifier prompt template ─────────────────────────────────────────

const DEFAULT_QUALIFIER_PROMPT = `You are a B2B outreach qualifier. Evaluate this lead and output ONLY valid JSON.

Lead details:
- Name: {{lead.name}}
- Website: {{lead.website || "none"}}
- Phone: {{lead.phone || "not found"}}
- Email: {{lead.email || "not found"}}
- Rating: {{lead.rating || "unknown"}} ({{lead.reviewCount || 0}} reviews)
- Address: {{lead.address || "unknown"}}
- Size hint: {{lead.companySizeHint || "unknown"}}
- Description: {{lead.description || "none"}}

Score this lead 0-100 for cold outreach suitability. Consider:
- Completeness of contact info (email/phone)
- Signs of an active, established business
- Rating and review volume
- Website presence and quality

Output exactly this JSON (no other text):
{"score": <0-100>, "reason": "<1-2 sentences explaining the score>", "recommended_pitch": "<specific angle or hook for this lead>"}`;

// ── Public API ────────────────────────────────────────────────────────────────

export async function scoreLead(opts: ScoreLeadOpts): Promise<QualificationResult> {
  const {
    lead,
    campaignId,
    threshold = 70,
    rules = {},
    log = (l: string) => console.log(l),
    signal,
  } = opts;

  log(`[qualifier] start leadId=${lead.id} name=${lead.name} threshold=${threshold}`);

  // Pass 1 — Fast rule filter
  const ruleResult = _applyRules(lead, rules);
  if (!ruleResult.passed) {
    log(`[qualifier] rule filter FAIL: ${ruleResult.reason}`);
    return {
      leadId: lead.id,
      score: 0,
      reason: ruleResult.reason,
      recommended_pitch: "",
      status: "disqualified",
      passedRuleFilter: false,
      llmCalled: false,
    };
  }
  log(`[qualifier] rule filter PASS`);

  // Pass 2 — LLM scoring
  const prompt = _buildPrompt(lead, campaignId);
  let score = 50;
  let reason = "LLM scoring unavailable — using default score";
  let recommended_pitch = `Contact ${lead.name} about your services`;
  let llmCalled = false;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    log(`[qualifier] ANTHROPIC_API_KEY not set — using default score`);
  } else {
    try {
      const llmResult = await _callLlm(prompt, apiKey, log, signal);
      score = llmResult.score;
      reason = llmResult.reason;
      recommended_pitch = llmResult.recommended_pitch;
      llmCalled = true;
    } catch (err) {
      log(`[qualifier] LLM call failed: ${String(err)}`);
      // Fall through with default score rather than failing the lead
    }
  }

  const status = score >= threshold ? "qualified" : "disqualified";
  log(`[qualifier] done score=${score} status=${status}`);

  return {
    leadId: lead.id,
    score,
    reason,
    recommended_pitch,
    status,
    passedRuleFilter: true,
    llmCalled,
  };
}

// ── Rule filter ───────────────────────────────────────────────────────────────

function _applyRules(
  lead: LeadForQualification,
  rules: QualificationRules,
): { passed: boolean; reason: string } {
  const noWebsiteDisqualifies = rules.noWebsiteDisqualifies ?? true;
  const minRating = rules.minRating ?? 3.0;
  const minReviewCount = rules.minReviewCount ?? 2;

  if (noWebsiteDisqualifies && !lead.website) {
    return { passed: false, reason: "No website found — lead may be inactive or too early-stage" };
  }

  if (lead.rating != null && lead.rating < minRating) {
    return {
      passed: false,
      reason: `Rating ${lead.rating} is below minimum ${minRating} — poor reputation risk`,
    };
  }

  if (lead.reviewCount != null && lead.reviewCount < minReviewCount) {
    return {
      passed: false,
      reason: `Only ${lead.reviewCount} reviews — business may be too new or inactive`,
    };
  }

  return { passed: true, reason: "Passed all rule filters" };
}

// ── Prompt builder ────────────────────────────────────────────────────────────

function _buildPrompt(lead: LeadForQualification, campaignId?: string): string {
  // Try campaign-specific template first
  if (campaignId) {
    const templatePath = resolve(
      homedir(),
      ".infinibot",
      "qualifier",
      "templates",
      `${campaignId}.md`,
    );
    if (existsSync(templatePath)) {
      return _interpolate(readFileSync(templatePath, "utf8"), lead);
    }
  }

  // Try default campaign template
  const defaultPath = resolve(homedir(), ".infinibot", "qualifier", "templates", "default.md");
  if (existsSync(defaultPath)) {
    return _interpolate(readFileSync(defaultPath, "utf8"), lead);
  }

  return _interpolate(DEFAULT_QUALIFIER_PROMPT, lead);
}

function _interpolate(template: string, lead: LeadForQualification): string {
  return template
    .replace(/\{\{lead\.name\}\}/g, lead.name)
    .replace(/\{\{lead\.website \|\| "([^"]+)"\}\}/g, lead.website || "$1")
    .replace(/\{\{lead\.website\}\}/g, lead.website ?? "none")
    .replace(/\{\{lead\.phone \|\| "([^"]+)"\}\}/g, lead.phone || "$1")
    .replace(/\{\{lead\.phone\}\}/g, lead.phone ?? "not found")
    .replace(/\{\{lead\.email \|\| "([^"]+)"\}\}/g, lead.email || "$1")
    .replace(/\{\{lead\.email\}\}/g, lead.email ?? "not found")
    .replace(/\{\{lead\.rating \|\| "([^"]+)"\}\}/g, String(lead.rating ?? "$1"))
    .replace(/\{\{lead\.rating\}\}/g, String(lead.rating ?? "unknown"))
    .replace(/\{\{lead\.reviewCount \|\| 0\}\}/g, String(lead.reviewCount ?? 0))
    .replace(/\{\{lead\.address\}\}/g, lead.address ?? "unknown")
    .replace(/\{\{lead\.companySizeHint \|\| "([^"]+)"\}\}/g, lead.companySizeHint || "$1")
    .replace(/\{\{lead\.companySizeHint\}\}/g, lead.companySizeHint ?? "unknown")
    .replace(/\{\{lead\.description \|\| "([^"]+)"\}\}/g, lead.description || "$1")
    .replace(/\{\{lead\.description\}\}/g, lead.description ?? "none");
}

// ── LLM scoring ───────────────────────────────────────────────────────────────

interface LlmScoreResult {
  score: number;
  reason: string;
  recommended_pitch: string;
}

async function _callLlm(
  prompt: string,
  apiKey: string,
  log: (l: string) => void,
  signal?: AbortSignal,
): Promise<LlmScoreResult> {
  log(`[qualifier] calling Claude claude-haiku-4-5-20251001 for scoring`);

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      messages: [{ role: "user", content: prompt }],
    }),
    signal,
  });

  if (!res.ok) {
    throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as {
    content: Array<{ type: string; text: string }>;
  };

  const text = data.content.find((c) => c.type === "text")?.text ?? "";

  // Parse JSON from the response
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`LLM response had no JSON: ${text.slice(0, 100)}`);

  const parsed = JSON.parse(jsonMatch[0]) as Partial<LlmScoreResult>;
  const score = Math.max(0, Math.min(100, Number(parsed.score ?? 50)));
  const reason = String(parsed.reason ?? "No reason provided");
  const recommended_pitch = String(
    parsed.recommended_pitch ?? "Contact this lead about your services",
  );

  log(`[qualifier] LLM result: score=${score} reason="${reason.slice(0, 60)}…"`);
  return { score, reason, recommended_pitch };
}
