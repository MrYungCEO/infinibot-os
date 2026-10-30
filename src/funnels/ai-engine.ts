/**
 * Lead AI Engine
 * Intelligent lead scoring, intent classification, offer matching, and response generation
 */

import type { Lead, LeadActivity, Offer, Stage, Business } from "./types.js";
import { getFunnelStore } from "./store.js";

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export type LeadTemperature = "cold" | "warm" | "hot";

export type IntentType =
  | "buyer" // Ready to purchase, high urgency
  | "curious" // Exploring options, gathering info
  | "freebie_seeker" // Only interested in free stuff
  | "spam" // Likely spam/bot
  | "returning" // Previous customer/lead
  | "referral" // Came from referral
  | "unknown";

export type OfferTier = "lead_magnet" | "low_ticket" | "mid_ticket" | "high_ticket";

export interface LeadScoreBreakdown {
  total: number;
  engagement: number; // Activity-based (0-40)
  fit: number; // Profile match (0-30)
  urgency: number; // Time-based signals (0-20)
  recency: number; // Recent activity bonus (0-10)
  components: {
    name: string;
    value: number;
    reason: string;
  }[];
}

export interface IntentClassification {
  primaryIntent: IntentType;
  confidence: number; // 0-1
  signals: string[];
  buyerReadiness: number; // 0-100
  riskFactors: string[];
}

export interface OfferMatch {
  offerId: string;
  offerName: string;
  matchScore: number; // 0-100
  tier: OfferTier;
  reasons: string[];
  objections: string[];
}

export interface QualificationQuestion {
  id: string;
  question: string;
  purpose: string;
  priority: number;
  expectedResponses: string[];
  followUps: string[];
}

export interface GeneratedResponse {
  message: string;
  tone: "friendly" | "professional" | "casual" | "urgent";
  callToAction?: string;
  personalization: string[];
}

// ═══════════════════════════════════════════════════════════════
// LEAD SCORING ENGINE
// ═══════════════════════════════════════════════════════════════

export function scoreLead(lead: Lead, activities?: LeadActivity[]): LeadScoreBreakdown {
  const components: LeadScoreBreakdown["components"] = [];
  let engagement = 0;
  let fit = 0;
  let urgency = 0;
  let recency = 0;

  // ── Engagement Score (0-40) ─────────────────────────────────

  // Activity count
  const activityCount = activities?.length ?? 0;
  if (activityCount > 0) {
    const activityScore = Math.min(15, activityCount * 3);
    engagement += activityScore;
    components.push({
      name: "activity_count",
      value: activityScore,
      reason: `${activityCount} activities recorded`,
    });
  }

  // Activity types
  const hasEmail = activities?.some((a) => a.type === "email");
  const hasCall = activities?.some((a) => a.type === "call");
  const hasMeeting = activities?.some((a) => a.type === "meeting");

  if (hasEmail) {
    engagement += 5;
    components.push({ name: "email_engagement", value: 5, reason: "Email interaction" });
  }
  if (hasCall) {
    engagement += 8;
    components.push({ name: "call_engagement", value: 8, reason: "Phone call interaction" });
  }
  if (hasMeeting) {
    engagement += 12;
    components.push({
      name: "meeting_engagement",
      value: 12,
      reason: "Meeting scheduled/completed",
    });
  }

  engagement = Math.min(40, engagement);

  // ── Fit Score (0-30) ─────────────────────────────────────────

  // Company provided
  if (lead.company) {
    fit += 8;
    components.push({ name: "company_provided", value: 8, reason: "Company name provided" });
  }

  // Contact completeness
  if (lead.email) {
    fit += 5;
    components.push({ name: "email_provided", value: 5, reason: "Email provided" });
  }
  if (lead.phone) {
    fit += 5;
    components.push({ name: "phone_provided", value: 5, reason: "Phone number provided" });
  }

  // Title/role
  if (lead.title) {
    const executiveTitles = [
      "ceo",
      "cfo",
      "coo",
      "cto",
      "founder",
      "owner",
      "director",
      "vp",
      "head",
    ];
    const isExecutive = executiveTitles.some((t) => lead.title?.toLowerCase().includes(t));
    if (isExecutive) {
      fit += 10;
      components.push({
        name: "executive_title",
        value: 10,
        reason: `Decision-maker title: ${lead.title}`,
      });
    } else {
      fit += 5;
      components.push({
        name: "title_provided",
        value: 5,
        reason: `Title provided: ${lead.title}`,
      });
    }
  }

  // Estimated value
  if (lead.estimatedValue && lead.estimatedValue > 0) {
    const valueScore = Math.min(7, Math.floor(lead.estimatedValue / 1000));
    fit += valueScore;
    components.push({
      name: "deal_value",
      value: valueScore,
      reason: `Estimated value: $${lead.estimatedValue}`,
    });
  }

  fit = Math.min(30, fit);

  // ── Urgency Score (0-20) ─────────────────────────────────────

  // Expected close date
  if (lead.expectedCloseDate) {
    const daysToClose = Math.floor(
      (new Date(lead.expectedCloseDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24),
    );
    if (daysToClose <= 7) {
      urgency += 15;
      components.push({
        name: "close_imminent",
        value: 15,
        reason: `Expected close within ${daysToClose} days`,
      });
    } else if (daysToClose <= 30) {
      urgency += 10;
      components.push({
        name: "close_soon",
        value: 10,
        reason: `Expected close within ${daysToClose} days`,
      });
    } else if (daysToClose <= 90) {
      urgency += 5;
      components.push({
        name: "close_planned",
        value: 5,
        reason: `Expected close within ${daysToClose} days`,
      });
    }
  }

  // Priority
  if (lead.priority === "urgent") {
    urgency += 10;
    components.push({ name: "urgent_priority", value: 10, reason: "Marked as urgent" });
  } else if (lead.priority === "high") {
    urgency += 5;
    components.push({ name: "high_priority", value: 5, reason: "Marked as high priority" });
  }

  urgency = Math.min(20, urgency);

  // ── Recency Score (0-10) ─────────────────────────────────────

  const lastActivity = lead.lastActivityAt ?? lead.updatedAt;
  const daysSinceActivity = Math.floor(
    (Date.now() - new Date(lastActivity).getTime()) / (1000 * 60 * 60 * 24),
  );

  if (daysSinceActivity <= 1) {
    recency = 10;
    components.push({ name: "very_recent", value: 10, reason: "Activity within last 24 hours" });
  } else if (daysSinceActivity <= 3) {
    recency = 8;
    components.push({ name: "recent", value: 8, reason: "Activity within last 3 days" });
  } else if (daysSinceActivity <= 7) {
    recency = 5;
    components.push({ name: "this_week", value: 5, reason: "Activity within last week" });
  } else if (daysSinceActivity <= 14) {
    recency = 2;
    components.push({ name: "two_weeks", value: 2, reason: "Activity within last 2 weeks" });
  }

  const total = engagement + fit + urgency + recency;

  return {
    total,
    engagement,
    fit,
    urgency,
    recency,
    components,
  };
}

export function getLeadTemperature(score: number): LeadTemperature {
  if (score >= 70) return "hot";
  if (score >= 40) return "warm";
  return "cold";
}

// ═══════════════════════════════════════════════════════════════
// INTENT CLASSIFICATION
// ═══════════════════════════════════════════════════════════════

export function classifyIntent(
  lead: Lead,
  activities?: LeadActivity[],
  messages?: string[],
): IntentClassification {
  const signals: string[] = [];
  const riskFactors: string[] = [];
  let buyerReadiness = 0;

  // ── Analyze Activity Patterns ───────────────────────────────

  const activityCount = activities?.length ?? 0;

  if (activityCount === 0) {
    signals.push("No recorded activities");
    riskFactors.push("Low engagement - may be freebie seeker or spam");
  }

  const hasCallOrMeeting = activities?.some((a) => a.type === "call" || a.type === "meeting");
  if (hasCallOrMeeting) {
    signals.push("Has engaged via call/meeting");
    buyerReadiness += 30;
  }

  const hasProposalActivity = activities?.some(
    (a) =>
      a.description.toLowerCase().includes("proposal") ||
      a.description.toLowerCase().includes("quote"),
  );
  if (hasProposalActivity) {
    signals.push("Has requested/viewed proposal");
    buyerReadiness += 25;
  }

  // ── Analyze Message Content (if provided) ───────────────────

  const allMessages = messages?.join(" ").toLowerCase() ?? "";

  // Buyer signals
  const buyerKeywords = [
    "ready to buy",
    "ready to start",
    "how much",
    "pricing",
    "cost",
    "contract",
    "when can we start",
    "let's do it",
    "sign up",
    "purchase",
    "budget",
    "timeline",
    "invoice",
    "payment",
  ];
  const buyerMatches = buyerKeywords.filter((kw) => allMessages.includes(kw));
  if (buyerMatches.length > 0) {
    signals.push(`Buyer keywords detected: ${buyerMatches.join(", ")}`);
    buyerReadiness += buyerMatches.length * 10;
  }

  // Freebie seeker signals
  const freebieKeywords = [
    "free",
    "discount",
    "trial",
    "sample",
    "no cost",
    "cheap",
    "lowest price",
  ];
  const freebieMatches = freebieKeywords.filter((kw) => allMessages.includes(kw));
  if (freebieMatches.length >= 2) {
    riskFactors.push(`Multiple freebie keywords: ${freebieMatches.join(", ")}`);
  }

  // Spam signals
  const spamKeywords = [
    "unsubscribe",
    "remove me",
    "stop",
    "not interested",
    "wrong number",
    "wrong email",
  ];
  const spamMatches = spamKeywords.filter((kw) => allMessages.includes(kw));
  if (spamMatches.length > 0) {
    riskFactors.push(`Negative signals: ${spamMatches.join(", ")}`);
    buyerReadiness -= 30;
  }

  // ── Analyze Lead Status & Source ────────────────────────────

  if (lead.source === "referral") {
    signals.push("Came from referral");
    buyerReadiness += 15;
  }

  if (lead.status === "qualified" || lead.status === "proposal") {
    signals.push(`Already at ${lead.status} stage`);
    buyerReadiness += 20;
  }

  if (lead.status === "negotiation") {
    signals.push("In negotiation stage");
    buyerReadiness += 35;
  }

  // ── Determine Primary Intent ────────────────────────────────

  buyerReadiness = Math.max(0, Math.min(100, buyerReadiness));

  let primaryIntent: IntentType = "unknown";
  let confidence = 0.5;

  if (spamMatches.length > 0) {
    primaryIntent = "spam";
    confidence = 0.8;
  } else if (lead.source === "referral") {
    primaryIntent = "referral";
    confidence = 0.75;
  } else if (buyerReadiness >= 70) {
    primaryIntent = "buyer";
    confidence = 0.85;
  } else if (buyerReadiness >= 40) {
    primaryIntent = "curious";
    confidence = 0.7;
  } else if (freebieMatches.length >= 2 && buyerMatches.length === 0) {
    primaryIntent = "freebie_seeker";
    confidence = 0.65;
  } else if (activityCount === 0 && !lead.email) {
    primaryIntent = "spam";
    confidence = 0.6;
  } else {
    primaryIntent = "curious";
    confidence = 0.5;
  }

  return {
    primaryIntent,
    confidence,
    signals,
    buyerReadiness,
    riskFactors,
  };
}

// ═══════════════════════════════════════════════════════════════
// OFFER MATCHING
// ═══════════════════════════════════════════════════════════════

export function getOfferTier(price: number): OfferTier {
  if (price === 0) return "lead_magnet";
  if (price < 100) return "low_ticket";
  if (price < 1000) return "mid_ticket";
  return "high_ticket";
}

export function matchOffers(
  lead: Lead,
  offers: Offer[],
  scoreBreakdown?: LeadScoreBreakdown,
  intentClassification?: IntentClassification,
): OfferMatch[] {
  const score = scoreBreakdown?.total ?? lead.score ?? 50;
  const intent = intentClassification?.primaryIntent ?? "unknown";
  const buyerReadiness = intentClassification?.buyerReadiness ?? 50;

  const matches: OfferMatch[] = [];

  for (const offer of offers) {
    if (offer.status !== "active") continue;

    let matchScore = 50; // Base score
    const reasons: string[] = [];
    const objections: string[] = [];
    const tier = getOfferTier(offer.price);

    // ── Score Requirements ────────────────────────────────────

    if (offer.minScore !== undefined && score < offer.minScore) {
      matchScore -= 30;
      objections.push(`Lead score (${score}) below minimum (${offer.minScore})`);
    } else if (offer.minScore !== undefined) {
      matchScore += 10;
      reasons.push(`Lead score meets minimum (${offer.minScore})`);
    }

    // ── Stage Targeting ───────────────────────────────────────

    if (offer.targetStages?.length) {
      if (offer.targetStages.includes(lead.stageId)) {
        matchScore += 20;
        reasons.push("Lead is in target stage");
      } else {
        matchScore -= 10;
        objections.push("Lead not in target stage");
      }
    }

    // ── Intent-Based Matching ─────────────────────────────────

    if (intent === "buyer") {
      if (tier === "mid_ticket" || tier === "high_ticket") {
        matchScore += 25;
        reasons.push("Buyer intent matches premium offer");
      }
    } else if (intent === "curious") {
      if (tier === "lead_magnet" || tier === "low_ticket") {
        matchScore += 20;
        reasons.push("Curious lead - low-commitment offer appropriate");
      } else {
        matchScore -= 10;
        objections.push("Lead not ready for high-ticket offer");
      }
    } else if (intent === "freebie_seeker") {
      if (tier === "lead_magnet") {
        matchScore += 15;
        reasons.push("Free offer for freebie seeker");
      } else {
        matchScore -= 20;
        objections.push("Freebie seeker unlikely to purchase");
      }
    }

    // ── Buyer Readiness ───────────────────────────────────────

    if (buyerReadiness >= 70 && (tier === "mid_ticket" || tier === "high_ticket")) {
      matchScore += 15;
      reasons.push("High buyer readiness for premium offer");
    } else if (buyerReadiness < 30 && tier === "high_ticket") {
      matchScore -= 20;
      objections.push("Low buyer readiness for high-ticket");
    }

    // ── Value Match ───────────────────────────────────────────

    if (lead.estimatedValue && lead.estimatedValue > 0) {
      const valueRatio = offer.price / lead.estimatedValue;
      if (valueRatio > 0.5) {
        objections.push("Offer price high relative to deal value");
        matchScore -= 10;
      }
    }

    // ── Tag Matching ──────────────────────────────────────────

    if (offer.targetTags?.length && lead.tags?.length) {
      const matchingTags = offer.targetTags.filter((t) => lead.tags?.includes(t));
      if (matchingTags.length > 0) {
        matchScore += matchingTags.length * 5;
        reasons.push(`Matching tags: ${matchingTags.join(", ")}`);
      }
    }

    matchScore = Math.max(0, Math.min(100, matchScore));

    matches.push({
      offerId: offer.id,
      offerName: offer.name,
      matchScore,
      tier,
      reasons,
      objections,
    });
  }

  // Sort by match score descending
  return matches.sort((a, b) => b.matchScore - a.matchScore);
}

// ═══════════════════════════════════════════════════════════════
// QUALIFICATION QUESTIONS
// ═══════════════════════════════════════════════════════════════

export function generateQualificationQuestions(
  lead: Lead,
  stage?: Stage,
  intent?: IntentClassification,
): QualificationQuestion[] {
  const questions: QualificationQuestion[] = [];
  let priority = 1;

  // ── Missing Information Questions ───────────────────────────

  if (!lead.company) {
    questions.push({
      id: "company",
      question: "What company or organization are you with?",
      purpose: "Understand business context",
      priority: priority++,
      expectedResponses: ["Company name", "Self-employed", "Freelancer"],
      followUps: ["What does your company do?", "How large is your team?"],
    });
  }

  if (!lead.title) {
    questions.push({
      id: "role",
      question: "What's your role in the decision-making process?",
      purpose: "Identify decision-maker authority",
      priority: priority++,
      expectedResponses: ["Decision-maker", "Influencer", "Researcher", "User"],
      followUps: ["Who else is involved in this decision?"],
    });
  }

  // ── Budget & Timeline Questions ─────────────────────────────

  if (!lead.estimatedValue) {
    questions.push({
      id: "budget",
      question: "Do you have a budget range in mind for this project?",
      purpose: "Qualify financial fit",
      priority: priority++,
      expectedResponses: ["Under $1K", "$1K-$5K", "$5K-$20K", "$20K+", "Not sure yet"],
      followUps: ["Is this budget approved or estimated?"],
    });
  }

  if (!lead.expectedCloseDate) {
    questions.push({
      id: "timeline",
      question: "What's your ideal timeline for getting started?",
      purpose: "Assess urgency",
      priority: priority++,
      expectedResponses: ["ASAP", "This month", "Next quarter", "Just exploring"],
      followUps: ["Is there a specific deadline driving this?"],
    });
  }

  // ── Intent-Based Questions ──────────────────────────────────

  if (intent?.primaryIntent === "curious") {
    questions.push({
      id: "motivation",
      question: "What prompted you to reach out to us today?",
      purpose: "Understand trigger event",
      priority: priority++,
      expectedResponses: ["Problem to solve", "Saw content", "Referral", "Comparison shopping"],
      followUps: ["Tell me more about that challenge"],
    });
  }

  if (intent?.primaryIntent === "freebie_seeker") {
    questions.push({
      id: "commitment",
      question: "If you find the right solution, are you ready to invest in it?",
      purpose: "Qualify commitment level",
      priority: priority++,
      expectedResponses: ["Yes, if it's right", "Maybe", "Just want free resources"],
      followUps: ["What would make it the right solution for you?"],
    });
  }

  // ── Stage-Specific Questions ────────────────────────────────

  if (stage?.type === "decision") {
    questions.push({
      id: "objections",
      question: "What concerns do you have about moving forward?",
      purpose: "Surface and address objections",
      priority: priority++,
      expectedResponses: ["Price", "Timing", "Need approval", "Comparing options", "None"],
      followUps: ["What would help address that concern?"],
    });
  }

  return questions.sort((a, b) => a.priority - b.priority);
}

// ═══════════════════════════════════════════════════════════════
// RESPONSE GENERATION
// ═══════════════════════════════════════════════════════════════

export function generateResponse(
  lead: Lead,
  business: Business | null,
  context: {
    intent?: IntentClassification;
    stage?: Stage;
    lastActivity?: LeadActivity;
    responseType: "initial" | "follow_up" | "offer" | "qualification" | "closing";
  },
): GeneratedResponse {
  const personalization: string[] = [];
  let tone: GeneratedResponse["tone"] = "friendly";
  let message = "";
  let callToAction: string | undefined;

  const firstName = lead.name.split(" ")[0];
  personalization.push(`Used first name: ${firstName}`);

  // ── Determine Tone ──────────────────────────────────────────

  if (context.intent?.primaryIntent === "buyer") {
    tone = "professional";
  } else if (context.intent?.buyerReadiness && context.intent.buyerReadiness >= 70) {
    tone = "urgent";
  } else if (lead.source === "referral") {
    tone = "friendly";
  }

  // ── Generate Message ────────────────────────────────────────

  const businessName = business?.name ?? "us";

  switch (context.responseType) {
    case "initial":
      message = `Hi ${firstName}! Thanks for reaching out to ${businessName}. `;
      if (lead.source === "referral") {
        message += "It's great to connect with you through a referral. ";
        personalization.push("Acknowledged referral source");
      }
      if (lead.company) {
        message += `I see you're with ${lead.company} — `;
        personalization.push("Mentioned their company");
      }
      message += "I'd love to learn more about what you're looking for and see how we can help.";
      callToAction = "Would you have 15 minutes this week for a quick call?";
      break;

    case "follow_up":
      message = `Hi ${firstName}, just circling back! `;
      if (context.lastActivity) {
        const daysSince = Math.floor(
          (Date.now() - new Date(context.lastActivity.createdAt).getTime()) / (1000 * 60 * 60 * 24),
        );
        if (daysSince > 7) {
          message += `It's been a little while since we connected. `;
        }
      }
      message +=
        "I wanted to check in and see if you had any questions or if there's anything I can help clarify.";
      callToAction = "Let me know what works best for you!";
      break;

    case "offer":
      message = `${firstName}, based on what you've shared, I think our solution would be a great fit for you. `;
      if (lead.estimatedValue) {
        message += `For a project like yours, we typically see significant ROI. `;
        personalization.push("Referenced their project scope");
      }
      callToAction = "Would you like me to put together a personalized proposal?";
      break;

    case "qualification":
      message = `Hi ${firstName}, thanks for your interest! `;
      message +=
        "To make sure I can point you in the right direction, I have a few quick questions. ";
      callToAction = "Mind if I ask what specifically brought you to us today?";
      break;

    case "closing":
      message = `${firstName}, it sounds like we're aligned on the solution. `;
      if (context.intent?.buyerReadiness && context.intent.buyerReadiness >= 70) {
        message += "I'm excited to help you get started! ";
        personalization.push("Matched high buyer readiness");
      }
      callToAction = "Ready to move forward? I can get the paperwork started right away.";
      break;
  }

  return {
    message,
    tone,
    callToAction,
    personalization,
  };
}

// ═══════════════════════════════════════════════════════════════
// IMPROVEMENT SUGGESTIONS
// ═══════════════════════════════════════════════════════════════

export function suggestImprovements(funnelId: string): {
  suggestions: {
    area: string;
    suggestion: string;
    priority: "high" | "medium" | "low";
    impact: string;
  }[];
} {
  const store = getFunnelStore();
  const analytics = store.getFunnelAnalytics(funnelId);
  const funnel = store.getFunnel(funnelId);

  const suggestions: {
    area: string;
    suggestion: string;
    priority: "high" | "medium" | "low";
    impact: string;
  }[] = [];

  if (!analytics || !funnel) {
    return { suggestions: [] };
  }

  // ── Conversion Rate Issues ──────────────────────────────────

  if (analytics.overallConversionRate < 5) {
    suggestions.push({
      area: "conversion",
      suggestion:
        "Overall conversion rate is very low. Consider reviewing your qualification criteria and offer positioning.",
      priority: "high",
      impact: "Could 2-3x your conversion rate",
    });
  }

  // ── Bottleneck-Based Suggestions ────────────────────────────

  const stages = store.getStages(funnelId);
  for (const stage of stages) {
    const convRate = analytics.stageConversionRates[stage.id] ?? 0;
    const avgTime = analytics.averageTimePerStage[stage.id] ?? 0;

    if (convRate < 10 && (analytics.leadsPerStage[stage.id] ?? 0) > 0) {
      suggestions.push({
        area: "stage_optimization",
        suggestion: `Stage "${stage.name}" has critical issues: conversion rate is only ${convRate}%. Add automation or nurture sequences to move leads through.`,
        priority: "high",
        impact: "Reduce lead drop-off at this stage",
      });
    } else if (avgTime > 14) {
      suggestions.push({
        area: "stage_optimization",
        suggestion: `Stage "${stage.name}": leads spend an average of ${Math.round(avgTime)} days here. Consider adding follow-up tasks or qualification criteria.`,
        priority: "medium",
        impact: "Improve flow through funnel",
      });
    }
  }

  // ── Automation Suggestions ──────────────────────────────────

  if (!funnel.automationEnabled) {
    suggestions.push({
      area: "automation",
      suggestion:
        "Enable automation for this funnel to auto-create follow-up tasks and score leads automatically.",
      priority: "medium",
      impact: "Save 5-10 hours per week on manual tasks",
    });
  }

  // ── Lead Value Optimization ─────────────────────────────────

  if (analytics.averageDealSize < 100) {
    suggestions.push({
      area: "pricing",
      suggestion:
        "Average deal size is low. Consider introducing mid-ticket or high-ticket offers for qualified leads.",
      priority: "medium",
      impact: "Increase revenue per customer",
    });
  }

  // ── Activity Suggestions ────────────────────────────────────

  if (analytics.totalActivities / analytics.totalLeads < 2) {
    suggestions.push({
      area: "engagement",
      suggestion:
        "Low activity per lead. Implement more touchpoints like email sequences, check-in calls, or content sharing.",
      priority: "low",
      impact: "Increase lead engagement and qualification data",
    });
  }

  return { suggestions };
}

// ═══════════════════════════════════════════════════════════════
// CONVENIENCE FUNCTIONS
// ═══════════════════════════════════════════════════════════════

/**
 * Full lead qualification - scores, classifies, and returns recommendations
 */
export function qualifyLead(
  lead: Lead,
  activities?: LeadActivity[],
): {
  score: LeadScoreBreakdown;
  temperature: LeadTemperature;
  intent: IntentClassification;
  questions: QualificationQuestion[];
  recommendation: string;
} {
  const score = scoreLead(lead, activities);
  const temperature = getLeadTemperature(score.total);
  const intent = classifyIntent(lead, activities);
  const questions = generateQualificationQuestions(lead, undefined, intent);

  let recommendation = "";
  if (temperature === "hot" && intent.primaryIntent === "buyer") {
    recommendation = "High priority - schedule sales call immediately";
  } else if (temperature === "hot") {
    recommendation = "Warm up with targeted content, then present offer";
  } else if (temperature === "warm" && intent.primaryIntent !== "freebie_seeker") {
    recommendation = "Nurture with value-add content, qualify with questions";
  } else if (intent.primaryIntent === "freebie_seeker") {
    recommendation = "Provide lead magnet, add to nurture sequence";
  } else {
    recommendation = "Add to cold outreach sequence, monitor engagement";
  }

  return {
    score,
    temperature,
    intent,
    questions,
    recommendation,
  };
}
