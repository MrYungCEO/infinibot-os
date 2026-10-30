/**
 * Defaults the wizard starts from. Everything here is editable in the UI;
 * the disclaimer and region list are drafts that need owner/legal review
 * before Pulse channels go live.
 */

import {
  DEFAULT_ACCOUNT_ID,
  type ComplianceSettings,
  type IntakeQuestion,
  type ModPreset,
  type ModerationSettings,
  type Settings,
} from "./contract.js";

/** Lead tiers (plan §2.1): 60+ hot, 30–59 warm, below 30 nurture. */
export const HOT_THRESHOLD = 60;
export const WARM_THRESHOLD = 30;
/** First-contact SLA on hot leads. */
export const HOT_LEAD_SLA_MS = 15 * 60_000;
/** Autonomous timeouts up to this length; longer ones need approval. */
export const MAX_AUTONOMOUS_TIMEOUT_MS = 60 * 60_000;
/** DMs to more recipients than this need approval. */
export const MASS_DM_THRESHOLD = 25;

/**
 * Default intake (the YCS shape). The goal answer names the interest; `age` and `trading`
 * are the Gold Desk gates (18+ and a $100 funded broker account). Every combination of
 * answers — including none — routes to at least InfiniBot free + KinglyVault free.
 */
export const DEFAULT_QUESTIONS: IntakeQuestion[] = [
  {
    id: "goal",
    label: "Your #1 goal in the next 90 days?",
    type: "single",
    weight: 30,
    options: [
      { value: "ai", label: "Automate my business with AI", points: 90, offer: "infinibot", role: "interest-infinibot" },
      { value: "learn", label: "Learn skills / build digital products", points: 75, offer: "kinglyvault", role: "interest-kinglyvault" },
      { value: "plugins", label: "Get plugins and tools for InfiniBot", points: 80, offer: "kinglyvault-plugins", role: "interest-kinglyvault" },
      { value: "trading", label: "Learn to trade", points: 70, offer: "pulse", role: "interest-pulse" },
      { value: "network", label: "Network with other founders", points: 15, offer: "none" },
    ],
  },
  {
    id: "now",
    label: "What do you do now?",
    type: "single",
    weight: 15,
    options: [
      { value: "business", label: "Business owner (with revenue)", points: 90 },
      { value: "agency", label: "Agency / team", points: 100 },
      { value: "creator", label: "Creator / solo builder", points: 60 },
      { value: "job", label: "I have a job", points: 40 },
      { value: "student", label: "Student / just starting", points: 20 },
    ],
  },
  {
    id: "budget",
    label: "Monthly budget for tools and education?",
    type: "single",
    weight: 30,
    options: [
      { value: "0", label: "$0", points: 0 },
      { value: "lt20", label: "Under $20", points: 25 },
      { value: "20-50", label: "$20 – $50", points: 50 },
      { value: "50-200", label: "$50 – $200", points: 80 },
      { value: "200+", label: "$200+", points: 100 },
    ],
  },
  {
    id: "trading",
    label: "Trading: where are you?",
    type: "single",
    weight: 15,
    gate: "capital",
    options: [
      { value: "never", label: "Never traded / not interested", points: 20, pass: false },
      { value: "learning-no-capital", label: "Learning, no spare money to risk", points: 20, pass: false },
      { value: "learning-capital", label: "Learning, and I have $100+ I can afford to lose", points: 70, pass: true },
      { value: "active", label: "Active trader", points: 85, pass: true },
    ],
  },
  {
    id: "age",
    label: "Are you 18 or older?",
    type: "single",
    weight: 10,
    gate: "age",
    options: [
      { value: "yes", label: "Yes, I'm 18+", points: 100, pass: true },
      { value: "no", label: "No, I'm under 18", points: 0, pass: false },
    ],
  },
];

/**
 * Default welcome DM for full Live (Verify panel + intake running). With only the greeting
 * live (Shadow + liveModules) the built-in three-step DM from greeting.ts is sent instead.
 */
export const DEFAULT_WELCOME_DM =
  "Welcome to Young CEO Society, {name}! Head to #start-here and answer a few quick questions so we can point you " +
  "to the right place.\n\n{offers}\n\nNeed help? Reply here or open a ticket.";

/** Built-in banned financial claims (plan §2.6). Matched case-insensitively. */
export const BUILTIN_BANNED_CLAIMS = [
  "guaranteed profit",
  "guaranteed profits",
  "guaranteed returns",
  "risk-free",
  "risk free",
  "can't lose",
  "cant lose",
  "100% win rate",
  "double your money",
  "financial advice",
  "dm me for signals",
  "dm for signals",
];

/** Built-in scam families + lookalike domains. */
export const BUILTIN_SCAM_DOMAINS = [
  "discord-nitro.gift",
  "dlscord.gift",
  "discordgift.site",
  "discord-app.gift",
  "steamcommunnity.com",
  "free-nitro.com",
];

export const PRESETS: Record<ModPreset, Omit<ModerationSettings, "extraBannedClaims" | "extraScamDomains">> = {
  relaxed: { preset: "relaxed", minAccountAgeDays: 1, raidJoinsPerMinute: 20, blockInvites: false },
  standard: { preset: "standard", minAccountAgeDays: 7, raidJoinsPerMinute: 10, blockInvites: true },
  strict: { preset: "strict", minAccountAgeDays: 30, raidJoinsPerMinute: 6, blockInvites: true },
};

/** Draft only — needs owner + legal review before Pulse channels go live. */
export const DEFAULT_DISCLAIMER =
  "Risk disclaimer: Trading involves substantial risk of loss and is not suitable for everyone. " +
  "Nothing in this channel is financial advice. Past results do not guarantee future results. " +
  "Only trade with money you can afford to lose. 18+ only.";

export const DEFAULT_COMPLIANCE: ComplianceSettings = {
  disclaimer: DEFAULT_DISCLAIMER,
  tradingChannelIds: [],
  repostEvery: 50,
  minAge: 18,
  blockedRegions: [],
};

export function defaultSettings(): Settings {
  return {
    accountId: DEFAULT_ACCOUNT_ID,
    guildId: null,
    guildName: null,
    memberCount: null,
    mode: "setup",
    paused: false,
    liveModules: [],
    channelMap: {},
    roleMap: {},
    questions: DEFAULT_QUESTIONS.map((q) => ({ ...q, options: q.options.map((o) => ({ ...o })) })),
    welcomeDm: DEFAULT_WELCOME_DM,
    offerLinks: {},
    moderation: { ...PRESETS.strict, extraBannedClaims: [], extraScamDomains: [] },
    compliance: { ...DEFAULT_COMPLIANCE, tradingChannelIds: [], blockedRegions: [] },
    testRun: null,
    setupStep: 1,
    liveSince: null,
    version: 1,
  };
}
