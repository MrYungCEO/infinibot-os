/**
 * Funnel Templates — Pre-built funnel configurations
 * Ready-to-deploy sales and marketing funnels
 */

import type {
  Funnel,
  Stage,
  FunnelTask,
  FunnelType,
  StageType,
  FunnelTaskPriority,
} from "./types.js";

// ═══════════════════════════════════════════════════════════════
// TEMPLATE TYPES
// ═══════════════════════════════════════════════════════════════

/**
 * Marketing funnel stage category for better UX
 * Maps to StageType internally
 */
export type MarketingStageCategory =
  | "content" // Top of funnel - awareness content
  | "engagement" // Social engagement triggers
  | "capture" // Lead capture / DM automation
  | "nurture" // Lead magnet / community nurturing
  | "convert"; // Sales conversion

/**
 * KPI definitions for stage tracking
 */
export interface StageKPI {
  name: string;
  description?: string;
  targetValue?: number;
  unit?: string;
}

/**
 * Task checklist item for stage setup
 */
export interface StageTaskTemplate {
  title: string;
  description?: string;
  priority: FunnelTaskPriority;
  estimatedMinutes?: number;
}

/**
 * Stage template definition
 */
export interface StageTemplate {
  name: string;
  description?: string;
  category: MarketingStageCategory;
  stageType: StageType;
  position: number;
  color?: string;
  icon?: string;

  // KPIs to track for this stage
  kpis: StageKPI[];

  // Setup tasks for this stage
  tasks: StageTaskTemplate[];

  // Auto-move rules
  autoMoveAfterDays?: number;
  maxDaysAllowed?: number;
}

/**
 * Complete funnel template definition
 */
export interface FunnelTemplate {
  id: string;
  name: string;
  description: string;
  category: "social" | "email" | "outbound" | "webinar" | "ecommerce" | "custom";
  funnelType: FunnelType;

  // Visual
  color?: string;
  icon?: string;

  // Template metadata
  industry?: string;
  estimatedSetupHours?: number;
  difficulty: "beginner" | "intermediate" | "advanced";

  // Stages
  stages: StageTemplate[];

  // Example business context
  exampleBusiness?: {
    name: string;
    followers?: number;
    platform?: string;
    niche?: string;
  };
}

// ═══════════════════════════════════════════════════════════════
// CATEGORY → STAGE TYPE MAPPING
// ═══════════════════════════════════════════════════════════════

export function mapCategoryToStageType(
  category: MarketingStageCategory,
  position: number,
  totalStages: number,
): StageType {
  if (position === 0) return "entry";
  if (position === totalStages - 1) return "exit";
  if (category === "nurture") return "parking";
  return "standard";
}

// ═══════════════════════════════════════════════════════════════
// TEMPLATE: Instagram → High Ticket
// ═══════════════════════════════════════════════════════════════

export const INSTAGRAM_HIGH_TICKET_TEMPLATE: FunnelTemplate = {
  id: "instagram-high-ticket-v1",
  name: "Instagram to High Ticket",
  description:
    "Convert Instagram followers into high-ticket clients through content, DMs, and community nurturing",
  category: "social",
  funnelType: "sales",
  color: "#E1306C", // Instagram gradient start
  icon: "📱",
  industry: "Coaching/Consulting",
  estimatedSetupHours: 8,
  difficulty: "intermediate",

  exampleBusiness: {
    name: "Creator Academy",
    followers: 230000,
    platform: "Instagram",
    niche: "AI Business Automation",
  },

  stages: [
    // Stage 1: Content (Entry)
    {
      name: "Video Posts",
      description: "Create viral content with strong CTAs to drive engagement",
      category: "content",
      stageType: "entry",
      position: 0,
      color: "#FF6B6B",
      icon: "🎬",
      kpis: [
        { name: "views", description: "Total video views", unit: "views" },
        { name: "reach", description: "Unique accounts reached", unit: "accounts" },
        {
          name: "engagement_rate",
          description: "Likes + Comments / Reach",
          unit: "%",
          targetValue: 5,
        },
      ],
      tasks: [
        {
          title: "Hook script",
          description: "Write attention-grabbing first 3 seconds",
          priority: "high",
        },
        { title: "CTA copy", description: "Clear call-to-action for comments", priority: "high" },
        {
          title: "Trending audio",
          description: "Find and save trending sounds",
          priority: "normal",
        },
      ],
      autoMoveAfterDays: 7,
    },

    // Stage 2: Engagement
    {
      name: "Comment CTA",
      description: "Drive comments with keyword triggers for DM automation",
      category: "engagement",
      stageType: "standard",
      position: 1,
      color: "#4ECDC4",
      icon: "💬",
      kpis: [
        { name: "comments", description: "Total comments received", unit: "comments" },
        { name: "dm_triggers", description: "Comments matching keywords", unit: "triggers" },
      ],
      tasks: [
        {
          title: "Keyword list",
          description: 'Define trigger words (e.g., "AI", "FREE", "LINK")',
          priority: "high",
        },
        {
          title: "Response templates",
          description: "Create comment reply templates",
          priority: "normal",
        },
      ],
      maxDaysAllowed: 2,
    },

    // Stage 3: Capture (DM Automation)
    {
      name: "ManyChat DM",
      description: "Automated DM sequence to capture leads and qualify interest",
      category: "capture",
      stageType: "standard",
      position: 2,
      color: "#9B59B6",
      icon: "🤖",
      kpis: [
        { name: "dm_opens", description: "DMs opened by users", unit: "opens" },
        { name: "click_rate", description: "Link clicks in DMs", unit: "%", targetValue: 30 },
        { name: "response_rate", description: "Users who respond", unit: "%", targetValue: 40 },
      ],
      tasks: [
        { title: "Flow built", description: "Build ManyChat automation flow", priority: "high" },
        { title: "A/B tested", description: "Test 2+ message variations", priority: "normal" },
        {
          title: "Compliance check",
          description: "Ensure messages comply with IG ToS",
          priority: "high",
        },
      ],
      autoMoveAfterDays: 3,
    },

    // Stage 4: Lead Magnet (Nurture)
    {
      name: "Free AI Course",
      description: "Free value-first content to build trust and demonstrate expertise",
      category: "nurture",
      stageType: "parking",
      position: 3,
      color: "#3498DB",
      icon: "📚",
      kpis: [
        { name: "signups", description: "Course registrations", unit: "signups" },
        {
          name: "completion_rate",
          description: "Users completing course",
          unit: "%",
          targetValue: 25,
        },
        {
          name: "email_opens",
          description: "Follow-up email open rate",
          unit: "%",
          targetValue: 40,
        },
      ],
      tasks: [
        {
          title: "Course live",
          description: "Course content published and accessible",
          priority: "high",
        },
        {
          title: "Email sequence",
          description: "Create 5-7 email nurture sequence",
          priority: "high",
        },
        {
          title: "Tracking pixels",
          description: "Set up analytics and retargeting",
          priority: "normal",
        },
      ],
      autoMoveAfterDays: 14,
    },

    // Stage 5: Community (Nurture)
    {
      name: "Paid Community",
      description: "Low-ticket community to build deeper relationships",
      category: "nurture",
      stageType: "standard",
      position: 4,
      color: "#2ECC71",
      icon: "👥",
      kpis: [
        {
          name: "join_rate",
          description: "Lead magnet to community conversion",
          unit: "%",
          targetValue: 10,
        },
        { name: "retention", description: "Monthly retention rate", unit: "%", targetValue: 80 },
        { name: "engagement", description: "Active members per week", unit: "members" },
      ],
      tasks: [
        {
          title: "Onboarding flow",
          description: "New member welcome experience",
          priority: "high",
        },
        {
          title: "Welcome sequence",
          description: "First-week engagement messages",
          priority: "normal",
        },
      ],
      maxDaysAllowed: 30,
    },

    // Stage 6: High Ticket (Convert/Exit)
    {
      name: "AI Biz In A Box",
      description: "High-ticket offer - complete AI business automation solution",
      category: "convert",
      stageType: "exit",
      position: 5,
      color: "#F39C12",
      icon: "💰",
      kpis: [
        { name: "calls_booked", description: "Strategy calls scheduled", unit: "calls" },
        { name: "show_rate", description: "Calls that showed up", unit: "%", targetValue: 80 },
        { name: "close_rate", description: "Calls that converted", unit: "%", targetValue: 25 },
        { name: "revenue", description: "Total revenue generated", unit: "USD" },
      ],
      tasks: [
        { title: "Sales page", description: "High-converting sales page live", priority: "high" },
        {
          title: "Calendar setup",
          description: "Booking system configured (Calendly/Cal)",
          priority: "high",
        },
        { title: "Call script", description: "Sales call framework documented", priority: "high" },
      ],
    },
  ],
};

// ═══════════════════════════════════════════════════════════════
// TEMPLATE: Email Nurture Funnel
// ═══════════════════════════════════════════════════════════════

export const EMAIL_NURTURE_TEMPLATE: FunnelTemplate = {
  id: "email-nurture-v1",
  name: "Email Nurture Sequence",
  description: "Warm cold leads through strategic email sequences to high-ticket offers",
  category: "email",
  funnelType: "marketing",
  color: "#EA4335",
  icon: "📧",
  industry: "General",
  estimatedSetupHours: 6,
  difficulty: "beginner",

  stages: [
    // Stage 1: Lead Capture
    {
      name: "Lead Magnet Signup",
      description: "Capture email via valuable free resource",
      category: "capture",
      stageType: "entry",
      position: 0,
      color: "#4285F4",
      icon: "🎁",
      kpis: [
        { name: "signups", description: "New email subscribers", unit: "subscribers" },
        { name: "conversion_rate", description: "Visitors to signup", unit: "%", targetValue: 25 },
      ],
      tasks: [
        {
          title: "Lead magnet created",
          description: "PDF, video, or course ready",
          priority: "high",
        },
        { title: "Landing page live", description: "Opt-in page published", priority: "high" },
        {
          title: "Thank you page",
          description: "Confirmation page with next steps",
          priority: "normal",
        },
      ],
    },

    // Stage 2: Welcome Sequence
    {
      name: "Welcome Sequence",
      description: "3-5 emails introducing your brand and building trust",
      category: "nurture",
      stageType: "standard",
      position: 1,
      color: "#34A853",
      icon: "👋",
      kpis: [
        { name: "open_rate", description: "Emails opened", unit: "%", targetValue: 45 },
        { name: "click_rate", description: "Links clicked", unit: "%", targetValue: 10 },
        { name: "reply_rate", description: "Direct replies", unit: "%", targetValue: 5 },
      ],
      tasks: [
        {
          title: "Email 1: Delivery",
          description: "Deliver lead magnet + introduce yourself",
          priority: "high",
        },
        { title: "Email 2: Story", description: "Share your origin story", priority: "high" },
        { title: "Email 3: Value", description: "Provide unexpected value", priority: "high" },
        {
          title: "Email 4: Social proof",
          description: "Share results/testimonials",
          priority: "normal",
        },
        {
          title: "Email 5: Soft pitch",
          description: "Introduce paid offering",
          priority: "normal",
        },
      ],
      autoMoveAfterDays: 7,
    },

    // Stage 3: Engagement Sequence
    {
      name: "Value Bombing",
      description: "Weekly valuable content to maintain engagement",
      category: "nurture",
      stageType: "parking",
      position: 2,
      color: "#FBBC04",
      icon: "💎",
      kpis: [
        { name: "engagement_score", description: "Opens + clicks over time", unit: "score" },
        { name: "list_health", description: "Active vs dormant ratio", unit: "%", targetValue: 60 },
      ],
      tasks: [
        {
          title: "Content calendar",
          description: "4-week email content planned",
          priority: "normal",
        },
        {
          title: "Segmentation rules",
          description: "Tag engaged vs cold subscribers",
          priority: "high",
        },
        {
          title: "Re-engagement flow",
          description: "Win-back sequence for cold leads",
          priority: "normal",
        },
      ],
      maxDaysAllowed: 30,
    },

    // Stage 4: Sales Sequence
    {
      name: "Launch Sequence",
      description: "Direct sales pitch with urgency and scarcity",
      category: "convert",
      stageType: "standard",
      position: 3,
      color: "#EA4335",
      icon: "🚀",
      kpis: [
        { name: "sales", description: "Total purchases", unit: "sales" },
        { name: "revenue", description: "Total revenue", unit: "USD" },
        { name: "conversion_rate", description: "Emails to sales", unit: "%", targetValue: 3 },
      ],
      tasks: [
        {
          title: "Sales email 1",
          description: "Pain point + solution introduction",
          priority: "high",
        },
        { title: "Sales email 2", description: "Case study / transformation", priority: "high" },
        { title: "Sales email 3", description: "FAQ objection handling", priority: "high" },
        { title: "Sales email 4", description: "Final call with urgency", priority: "high" },
        { title: "Checkout page", description: "Sales page optimized", priority: "high" },
      ],
      autoMoveAfterDays: 5,
    },

    // Stage 5: Customer/Lost
    {
      name: "Customer or Nurture",
      description: "Post-campaign segmentation",
      category: "convert",
      stageType: "exit",
      position: 4,
      color: "#9C27B0",
      icon: "🎯",
      kpis: [
        { name: "customer_rate", description: "Leads converted to customers", unit: "%" },
        { name: "ltv", description: "Customer lifetime value", unit: "USD" },
      ],
      tasks: [
        {
          title: "Customer onboarding",
          description: "Welcome sequence for buyers",
          priority: "high",
        },
        {
          title: "Non-buyer nurture",
          description: "Continue value for non-buyers",
          priority: "normal",
        },
      ],
    },
  ],
};

// ═══════════════════════════════════════════════════════════════
// TEMPLATE: Cold Outreach Funnel
// ═══════════════════════════════════════════════════════════════

export const COLD_OUTREACH_TEMPLATE: FunnelTemplate = {
  id: "cold-outreach-v1",
  name: "Cold Outreach B2B",
  description: "Cold email and LinkedIn outreach for B2B lead generation",
  category: "outbound",
  funnelType: "sales",
  color: "#0077B5", // LinkedIn blue
  icon: "🎯",
  industry: "B2B Services",
  estimatedSetupHours: 10,
  difficulty: "advanced",

  stages: [
    // Stage 1: Prospecting
    {
      name: "Prospect Research",
      description: "Build targeted prospect lists with ICP matching",
      category: "content",
      stageType: "entry",
      position: 0,
      color: "#607D8B",
      icon: "🔍",
      kpis: [
        { name: "prospects_found", description: "Total prospects identified", unit: "prospects" },
        {
          name: "icp_match_rate",
          description: "ICP qualification rate",
          unit: "%",
          targetValue: 80,
        },
        { name: "email_found_rate", description: "Valid emails found", unit: "%", targetValue: 70 },
      ],
      tasks: [
        {
          title: "ICP documented",
          description: "Ideal Customer Profile defined",
          priority: "high",
        },
        {
          title: "Source list",
          description: "LinkedIn Sales Nav / Apollo setup",
          priority: "high",
        },
        {
          title: "Email finder",
          description: "Hunter.io or similar configured",
          priority: "normal",
        },
        { title: "CRM integration", description: "Prospects sync to CRM", priority: "normal" },
      ],
    },

    // Stage 2: Cold Email
    {
      name: "Cold Email Sequence",
      description: "4-touch email sequence with personalization",
      category: "engagement",
      stageType: "standard",
      position: 1,
      color: "#2196F3",
      icon: "📤",
      kpis: [
        { name: "emails_sent", description: "Total emails sent", unit: "emails" },
        { name: "open_rate", description: "Emails opened", unit: "%", targetValue: 50 },
        { name: "reply_rate", description: "Positive replies", unit: "%", targetValue: 5 },
        { name: "bounce_rate", description: "Bounced emails", unit: "%", targetValue: 3 },
      ],
      tasks: [
        {
          title: "Email 1: Value hook",
          description: "Pattern interrupt + value prop",
          priority: "high",
        },
        { title: "Email 2: Case study", description: "Relevant success story", priority: "high" },
        {
          title: "Email 3: Different angle",
          description: "Address different pain point",
          priority: "normal",
        },
        {
          title: "Email 4: Breakup",
          description: "Final attempt with soft close",
          priority: "normal",
        },
        { title: "Domain warmup", description: "Sending domain warmed 2+ weeks", priority: "high" },
      ],
      autoMoveAfterDays: 14,
    },

    // Stage 3: LinkedIn Touch
    {
      name: "LinkedIn Outreach",
      description: "Parallel LinkedIn connection and messaging",
      category: "engagement",
      stageType: "standard",
      position: 2,
      color: "#0077B5",
      icon: "💼",
      kpis: [
        {
          name: "connection_rate",
          description: "Connection requests accepted",
          unit: "%",
          targetValue: 30,
        },
        { name: "message_rate", description: "Messages opened", unit: "%", targetValue: 60 },
        { name: "reply_rate", description: "Positive conversations", unit: "%", targetValue: 15 },
      ],
      tasks: [
        {
          title: "Profile optimized",
          description: "LinkedIn profile sales-ready",
          priority: "high",
        },
        {
          title: "Connection message",
          description: "Personalized connection template",
          priority: "high",
        },
        {
          title: "Follow-up sequence",
          description: "3-message nurture sequence",
          priority: "normal",
        },
        { title: "Content strategy", description: "Daily/weekly posting plan", priority: "normal" },
      ],
      autoMoveAfterDays: 7,
    },

    // Stage 4: Conversation
    {
      name: "Active Conversation",
      description: "Engaged prospects in active dialogue",
      category: "capture",
      stageType: "standard",
      position: 3,
      color: "#4CAF50",
      icon: "💬",
      kpis: [
        { name: "conversations", description: "Active conversations", unit: "conversations" },
        {
          name: "qualification_rate",
          description: "Conversations that qualify",
          unit: "%",
          targetValue: 40,
        },
        {
          name: "meeting_rate",
          description: "Conversations to meetings",
          unit: "%",
          targetValue: 30,
        },
      ],
      tasks: [
        {
          title: "Qualification questions",
          description: "BANT/MEDDIC framework ready",
          priority: "high",
        },
        {
          title: "Objection handling",
          description: "Common objections documented",
          priority: "normal",
        },
        {
          title: "Case studies ready",
          description: "Relevant proof points accessible",
          priority: "normal",
        },
      ],
      maxDaysAllowed: 14,
    },

    // Stage 5: Discovery Call
    {
      name: "Discovery Call",
      description: "First sales call to qualify and discover needs",
      category: "convert",
      stageType: "standard",
      position: 4,
      color: "#FF9800",
      icon: "📞",
      kpis: [
        { name: "calls_booked", description: "Calls scheduled", unit: "calls" },
        { name: "show_rate", description: "Prospects who attended", unit: "%", targetValue: 75 },
        {
          name: "next_step_rate",
          description: "Calls advancing to proposal",
          unit: "%",
          targetValue: 50,
        },
      ],
      tasks: [
        { title: "Discovery script", description: "Call framework documented", priority: "high" },
        { title: "Calendar setup", description: "Booking link configured", priority: "high" },
        { title: "Reminder sequence", description: "Automated call reminders", priority: "normal" },
        { title: "Note template", description: "Call notes template ready", priority: "low" },
      ],
      autoMoveAfterDays: 3,
    },

    // Stage 6: Proposal
    {
      name: "Proposal Sent",
      description: "Custom proposal delivered, awaiting decision",
      category: "convert",
      stageType: "exit",
      position: 5,
      color: "#9C27B0",
      icon: "📋",
      kpis: [
        { name: "proposals_sent", description: "Total proposals delivered", unit: "proposals" },
        { name: "close_rate", description: "Proposals that closed", unit: "%", targetValue: 35 },
        { name: "avg_deal_size", description: "Average contract value", unit: "USD" },
        {
          name: "days_to_close",
          description: "Average sales cycle",
          unit: "days",
          targetValue: 30,
        },
      ],
      tasks: [
        { title: "Proposal template", description: "Branded proposal template", priority: "high" },
        { title: "Follow-up cadence", description: "Post-proposal touchpoints", priority: "high" },
        { title: "Contract ready", description: "Legal docs prepared", priority: "normal" },
        {
          title: "Negotiation playbook",
          description: "Discount/terms framework",
          priority: "normal",
        },
      ],
    },
  ],
};

// ═══════════════════════════════════════════════════════════════
// TEMPLATE: Webinar Funnel
// ═══════════════════════════════════════════════════════════════

export const WEBINAR_FUNNEL_TEMPLATE: FunnelTemplate = {
  id: "webinar-funnel-v1",
  name: "Webinar Sales Funnel",
  description: "Live or automated webinar to high-ticket offer conversion",
  category: "webinar",
  funnelType: "sales",
  color: "#6366F1",
  icon: "🎥",
  industry: "Coaching/Education",
  estimatedSetupHours: 15,
  difficulty: "advanced",

  stages: [
    // Stage 1: Registration
    {
      name: "Webinar Registration",
      description: "Drive registrations through paid and organic traffic",
      category: "capture",
      stageType: "entry",
      position: 0,
      color: "#6366F1",
      icon: "📝",
      kpis: [
        { name: "registrations", description: "Total sign-ups", unit: "registrations" },
        {
          name: "cost_per_reg",
          description: "Ad spend per registration",
          unit: "USD",
          targetValue: 5,
        },
        {
          name: "page_conversion",
          description: "Landing page conversion",
          unit: "%",
          targetValue: 35,
        },
      ],
      tasks: [
        {
          title: "Registration page",
          description: "High-converting landing page",
          priority: "high",
        },
        { title: "Ad creatives", description: "Facebook/YouTube ads ready", priority: "high" },
        {
          title: "Email confirmation",
          description: "Registration confirmation flow",
          priority: "high",
        },
        { title: "Calendar invite", description: "Auto-add to calendar", priority: "normal" },
      ],
    },

    // Stage 2: Pre-Webinar Nurture
    {
      name: "Pre-Webinar Warmup",
      description: "Reminder sequence and value delivery before event",
      category: "nurture",
      stageType: "standard",
      position: 1,
      color: "#8B5CF6",
      icon: "🔥",
      kpis: [
        { name: "email_opens", description: "Reminder email opens", unit: "%", targetValue: 55 },
        {
          name: "video_watches",
          description: "Pre-webinar video views",
          unit: "%",
          targetValue: 30,
        },
        { name: "engagement_score", description: "Pre-event engagement", unit: "score" },
      ],
      tasks: [
        { title: "Reminder 1: 24h", description: "24-hour reminder email", priority: "high" },
        { title: "Reminder 2: 1h", description: "1-hour reminder email", priority: "high" },
        { title: "SMS reminders", description: "Text message reminders", priority: "normal" },
        { title: "Pre-value video", description: "Valuable preview content", priority: "normal" },
      ],
      autoMoveAfterDays: 3,
    },

    // Stage 3: Live Attendance
    {
      name: "Webinar Attendance",
      description: "Live (or replay) webinar attendance tracking",
      category: "engagement",
      stageType: "standard",
      position: 2,
      color: "#EC4899",
      icon: "🎬",
      kpis: [
        { name: "show_rate", description: "Registrants who attended", unit: "%", targetValue: 35 },
        {
          name: "avg_watch_time",
          description: "Average minutes watched",
          unit: "minutes",
          targetValue: 45,
        },
        { name: "stayed_to_offer", description: "Watched until pitch", unit: "%", targetValue: 60 },
        { name: "engagement", description: "Chat/Q&A participation", unit: "messages" },
      ],
      tasks: [
        { title: "Webinar deck", description: "Slides and presentation", priority: "high" },
        { title: "Tech check", description: "Stream/platform tested", priority: "high" },
        { title: "Q&A prep", description: "Common questions ready", priority: "normal" },
        { title: "Offer reveal", description: "Pitch sequence scripted", priority: "high" },
      ],
    },

    // Stage 4: Hot Leads (Offer Page)
    {
      name: "Offer Page Visitors",
      description: "Registrants who visited the offer page",
      category: "convert",
      stageType: "standard",
      position: 3,
      color: "#F59E0B",
      icon: "👀",
      kpis: [
        { name: "page_visits", description: "Offer page visits", unit: "visits" },
        { name: "time_on_page", description: "Average time on offer", unit: "minutes" },
        { name: "scroll_depth", description: "Page scroll completion", unit: "%" },
      ],
      tasks: [
        { title: "Sales page live", description: "Long-form sales page", priority: "high" },
        { title: "Order bumps", description: "Additional offer elements", priority: "normal" },
        { title: "Urgency elements", description: "Countdown timers, scarcity", priority: "high" },
        { title: "Exit intent", description: "Exit popup offer", priority: "normal" },
      ],
      maxDaysAllowed: 3,
    },

    // Stage 5: Post-Webinar Follow-up
    {
      name: "Follow-up Sequence",
      description: "Post-event email sequence with replay and urgency",
      category: "nurture",
      stageType: "parking",
      position: 4,
      color: "#10B981",
      icon: "📨",
      kpis: [
        { name: "replay_views", description: "Replay video watches", unit: "views" },
        { name: "email_opens", description: "Follow-up email opens", unit: "%", targetValue: 40 },
        { name: "link_clicks", description: "Offer link clicks", unit: "clicks" },
      ],
      tasks: [
        { title: "Replay email", description: "Immediate replay access", priority: "high" },
        { title: "Case study email", description: "Success story follow-up", priority: "high" },
        { title: "FAQ email", description: "Address common objections", priority: "normal" },
        { title: "Final call email", description: "Cart close urgency", priority: "high" },
        { title: "Deadline reminder", description: "Last chance messaging", priority: "high" },
      ],
      autoMoveAfterDays: 5,
    },

    // Stage 6: Conversion
    {
      name: "Purchase / Application",
      description: "Final conversion — purchase or application",
      category: "convert",
      stageType: "exit",
      position: 5,
      color: "#059669",
      icon: "💰",
      kpis: [
        { name: "conversions", description: "Total purchases/applications", unit: "conversions" },
        { name: "conversion_rate", description: "Attendees to buyers", unit: "%", targetValue: 5 },
        { name: "revenue", description: "Total revenue generated", unit: "USD" },
        { name: "cost_per_acquisition", description: "Total spend / conversions", unit: "USD" },
      ],
      tasks: [
        {
          title: "Checkout optimized",
          description: "Frictionless checkout flow",
          priority: "high",
        },
        { title: "Payment options", description: "Payment plans available", priority: "normal" },
        { title: "Application form", description: "Qualify high-ticket leads", priority: "high" },
        { title: "Welcome sequence", description: "New customer onboarding", priority: "normal" },
      ],
    },
  ],
};

// ═══════════════════════════════════════════════════════════════
// TEMPLATE REGISTRY
// ═══════════════════════════════════════════════════════════════

export const FUNNEL_TEMPLATES: Record<string, FunnelTemplate> = {
  "instagram-high-ticket-v1": INSTAGRAM_HIGH_TICKET_TEMPLATE,
  "email-nurture-v1": EMAIL_NURTURE_TEMPLATE,
  "cold-outreach-v1": COLD_OUTREACH_TEMPLATE,
  "webinar-funnel-v1": WEBINAR_FUNNEL_TEMPLATE,
};

export function getTemplate(templateId: string): FunnelTemplate | undefined {
  return FUNNEL_TEMPLATES[templateId];
}

export function listTemplates(): FunnelTemplate[] {
  return Object.values(FUNNEL_TEMPLATES);
}

export function listTemplatesByCategory(category: FunnelTemplate["category"]): FunnelTemplate[] {
  return Object.values(FUNNEL_TEMPLATES).filter((t) => t.category === category);
}

// ═══════════════════════════════════════════════════════════════
// SEED FUNCTION — Create Instagram Funnel
// ═══════════════════════════════════════════════════════════════

/**
 * Seed data structure for creating a funnel from template
 */
export interface FunnelSeedData {
  business: {
    id: string;
    name: string;
    description?: string;
    industry?: string;
  };
  funnel: Omit<Funnel, "createdAt" | "updatedAt">;
  stages: Omit<Stage, "createdAt" | "updatedAt">[];
  tasks: Omit<FunnelTask, "createdAt" | "updatedAt">[];
}

/**
 * Generate seed data for the Instagram High Ticket funnel.
 */
export function seedInstagramFunnel(): FunnelSeedData {
  const template = INSTAGRAM_HIGH_TICKET_TEMPLATE;
  const businessId = "biz-creator-academy-001";
  const funnelId = "funnel-ig-high-ticket-001";
  const now = new Date().toISOString();

  // Generate stage IDs
  const stageIds = template.stages.map((_, i) => `stage-ig-${i + 1}`);

  // Create stages
  const stages: Omit<Stage, "createdAt" | "updatedAt">[] = template.stages.map(
    (stageTemplate, index) => ({
      id: stageIds[index],
      funnelId,
      name: stageTemplate.name,
      description: stageTemplate.description,
      type: stageTemplate.stageType,
      position: stageTemplate.position,
      color: stageTemplate.color,
      icon: stageTemplate.icon,
      autoMoveAfterDays: stageTemplate.autoMoveAfterDays,
      maxDaysAllowed: stageTemplate.maxDaysAllowed,
      leadCount: 0,
    }),
  );

  // Create tasks from stage templates
  const tasks: Omit<FunnelTask, "createdAt" | "updatedAt">[] = [];
  let taskCounter = 1;

  template.stages.forEach((stageTemplate, stageIndex) => {
    stageTemplate.tasks.forEach((taskTemplate) => {
      tasks.push({
        id: `task-ig-${taskCounter++}`,
        businessId,
        funnelId,
        stageId: stageIds[stageIndex],
        title: taskTemplate.title,
        description: taskTemplate.description,
        type: "custom",
        status: "pending",
        priority: taskTemplate.priority,
        autoGenerated: true,
      });
    });
  });

  return {
    business: {
      id: businessId,
      name: template.exampleBusiness!.name,
      description: `${template.exampleBusiness!.followers?.toLocaleString()}+ followers on Instagram`,
      industry: template.exampleBusiness!.niche,
    },
    funnel: {
      id: funnelId,
      businessId,
      name: template.name,
      description: template.description,
      type: template.funnelType,
      status: "draft",
      color: template.color,
      icon: template.icon,
      automationEnabled: true,
      totalLeads: 0,
    },
    stages,
    tasks,
  };
}

/**
 * Generate seed data from any template
 */
export function seedFromTemplate(
  templateId: string,
  businessId: string,
  businessName: string,
): FunnelSeedData | null {
  const template = getTemplate(templateId);
  if (!template) return null;

  const funnelId = `funnel-${templateId}-${Date.now()}`;

  // Generate stage IDs
  const stageIds = template.stages.map((_, i) => `stage-${funnelId}-${i + 1}`);

  // Create stages
  const stages: Omit<Stage, "createdAt" | "updatedAt">[] = template.stages.map(
    (stageTemplate, index) => ({
      id: stageIds[index],
      funnelId,
      name: stageTemplate.name,
      description: stageTemplate.description,
      type: stageTemplate.stageType,
      position: stageTemplate.position,
      color: stageTemplate.color,
      icon: stageTemplate.icon,
      autoMoveAfterDays: stageTemplate.autoMoveAfterDays,
      maxDaysAllowed: stageTemplate.maxDaysAllowed,
      leadCount: 0,
    }),
  );

  // Create tasks
  const tasks: Omit<FunnelTask, "createdAt" | "updatedAt">[] = [];
  let taskCounter = 1;

  template.stages.forEach((stageTemplate, stageIndex) => {
    stageTemplate.tasks.forEach((taskTemplate) => {
      tasks.push({
        id: `task-${funnelId}-${taskCounter++}`,
        businessId,
        funnelId,
        stageId: stageIds[stageIndex],
        title: taskTemplate.title,
        description: taskTemplate.description,
        type: "custom",
        status: "pending",
        priority: taskTemplate.priority,
        autoGenerated: true,
      });
    });
  });

  return {
    business: {
      id: businessId,
      name: businessName,
      industry: template.industry,
    },
    funnel: {
      id: funnelId,
      businessId,
      name: template.name,
      description: template.description,
      type: template.funnelType,
      status: "draft",
      color: template.color,
      icon: template.icon,
      automationEnabled: true,
      totalLeads: 0,
    },
    stages,
    tasks,
  };
}
