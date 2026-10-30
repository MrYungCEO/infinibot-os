/**
 * Lead Outreach Campaigns — domain types.
 *
 * A Campaign is the join object that ties:
 *   business → products → target audience → funnel → goal
 * It is the context source that feeds email-generation and
 * document-generation after a lead is qualified.
 */

export type CampaignStatus = "draft" | "active" | "paused" | "completed";

export interface CampaignTargetAudience {
  description: string;
  industry?: string[];
  region?: string[];
  companySize?: { min?: number; max?: number };
  /** User-defined attributes (e.g. "ad-spend-monthly": "5000-20000"). */
  customFilters?: Record<string, string | string[]>;
}

export interface CampaignGoal {
  primaryConversion: string;
  secondaryConversion?: string;
  targetCount?: number;
  /** ISO date string for the goal deadline. */
  targetDate?: string;
}

export interface CampaignContextBlock {
  valueProp: string;
  differentiators?: string[];
  tone?: string;
  notes?: string;
}

export interface CampaignStats {
  leadsTotal: number;
  leadsQualified: number;
  leadsConverted: number;
  emailsSent: number;
  repliesReceived: number;
}

export interface Campaign {
  id: string;
  name: string;
  status: CampaignStatus;
  businessId: string;
  productIds: string[];
  funnelId: string | null;
  targetAudience: CampaignTargetAudience;
  goal: CampaignGoal;
  context: CampaignContextBlock;
  stats: CampaignStats;
  createdAt: number;
  updatedAt: number;
}

export interface CampaignInput {
  name: string;
  status?: CampaignStatus;
  businessId: string;
  productIds?: string[];
  funnelId?: string | null;
  targetAudience?: Partial<CampaignTargetAudience>;
  goal?: Partial<CampaignGoal>;
  context?: Partial<CampaignContextBlock>;
}

export interface CampaignPatch {
  name?: string;
  status?: CampaignStatus;
  productIds?: string[];
  funnelId?: string | null;
  targetAudience?: Partial<CampaignTargetAudience>;
  goal?: Partial<CampaignGoal>;
  context?: Partial<CampaignContextBlock>;
}

export interface CampaignFilters {
  businessId?: string;
  status?: CampaignStatus;
}

// ─── Assembled context blob passed into generators ───────────────

export interface CampaignContextProduct {
  id: string;
  name: string;
  description?: string;
  price?: number;
  currency?: string;
  features?: string[];
}

export interface CampaignContextBusiness {
  id: string;
  name: string;
  industry?: string;
  voice?: {
    tone?: string;
    audience?: string;
    do?: string[];
    dont?: string[];
  };
  branding?: {
    primaryColor?: string;
    tagline?: string | null;
  };
}

export interface CampaignContextFunnel {
  id: string;
  name: string;
  stageName?: string;
  stagePosition?: number;
}

/**
 * The blob the qualifier hands to email/doc generators after a lead
 * is qualified. Anything an LLM might need to personalize lives here.
 */
export interface CampaignContext {
  campaign: {
    id: string;
    name: string;
    status: CampaignStatus;
    goal: CampaignGoal;
    context: CampaignContextBlock;
    targetAudience: CampaignTargetAudience;
  };
  business: CampaignContextBusiness;
  products: CampaignContextProduct[];
  funnel: CampaignContextFunnel | null;
  lead: {
    id: string;
    name: string;
    email?: string;
    company?: string;
    score?: number;
    tags?: string[];
  };
}

/**
 * Campaign context assembled for a CRM client record. Extends CampaignContext
 * with a `client.placeholders` map containing the user-defined merge variables
 * stored on the client (e.g. websiteDemoUrl). Merge syntax: {{client.placeholders.KEY}}.
 */
export interface ClientCampaignContext extends CampaignContext {
  client: {
    id: string;
    /** Key-value placeholder variables set on the client record. */
    placeholders: Record<string, string>;
  };
}
