/**
 * Community Manager contract: RPC names, request/response shapes and the
 * shared enums. The control UI (ui/src/ui/views/community/*) imports this file
 * for types and the static tables, so it must stay free of Node imports.
 *
 * Secrets: no response type ever carries the bot token. Token state is
 * reported as `{ configured, source }` only.
 */

export const PLUGIN_ID = "community-manager";
/** Dedicated Discord account (channels.discord.accounts.<id>) for the community bot. */
export const DEFAULT_ACCOUNT_ID = "ycs";
/** Persistent roster agent bound to the community guild. */
export const AGENT_ID = "community";

/** Setup-time permission integer (includes Manage Channels for the template). */
export const SETUP_PERMISSIONS = "19095693552886";
/** Least-privilege run set (Manage Channels removed). */
export const RUN_PERMISSIONS = "19095693552870";

export const RPC = {
  status: "community-manager.status",
  setupState: "community-manager.setup.state",
  validateToken: "community-manager.setup.validateToken",
  saveToken: "community-manager.setup.saveToken",
  guilds: "community-manager.setup.guilds",
  selectGuild: "community-manager.setup.selectGuild",
  discovery: "community-manager.setup.discovery",
  saveMapping: "community-manager.setup.saveMapping",
  saveQuestions: "community-manager.setup.saveQuestions",
  savePreset: "community-manager.setup.savePreset",
  saveTeam: "community-manager.setup.saveTeam",
  testRun: "community-manager.setup.testRun",
  goLive: "community-manager.setup.goLive",
  simulate: "community-manager.setup.simulate",
  pause: "community-manager.control.pause",
  liveModules: "community-manager.control.liveModules",
  activity: "community-manager.activity.list",
  leads: "community-manager.leads.list",
  leadUpdate: "community-manager.leads.update",
  modQueue: "community-manager.mod.queue",
  tickets: "community-manager.tickets.list",
  ticketUpdate: "community-manager.tickets.update",
  campaigns: "community-manager.campaigns.list",
  campaignCreate: "community-manager.campaigns.create",
  campaignCancel: "community-manager.campaigns.cancel",
  analytics: "community-manager.analytics.summary",
} as const;

export type RpcScope = "read" | "write" | "admin";
/** Scope per RPC (setup + kill switch are admin, ops are write, reads are read). */
export const RPC_SCOPES: Record<(typeof RPC)[keyof typeof RPC], RpcScope> = {
  [RPC.status]: "read",
  [RPC.setupState]: "admin",
  [RPC.validateToken]: "admin",
  [RPC.saveToken]: "admin",
  [RPC.guilds]: "admin",
  [RPC.selectGuild]: "admin",
  [RPC.discovery]: "admin",
  [RPC.saveMapping]: "admin",
  [RPC.saveQuestions]: "admin",
  [RPC.savePreset]: "admin",
  [RPC.saveTeam]: "admin",
  [RPC.testRun]: "admin",
  [RPC.goLive]: "admin",
  [RPC.simulate]: "admin",
  [RPC.pause]: "admin",
  [RPC.liveModules]: "admin",
  [RPC.activity]: "read",
  [RPC.leads]: "read",
  [RPC.leadUpdate]: "write",
  [RPC.modQueue]: "read",
  [RPC.tickets]: "read",
  [RPC.ticketUpdate]: "write",
  [RPC.campaigns]: "read",
  [RPC.campaignCreate]: "write",
  [RPC.campaignCancel]: "write",
  [RPC.analytics]: "read",
};

// ── Enums ────────────────────────────────────────────────────────────────

/** setup = wizard not finished; shadow = log only; live = acts. `paused` is a separate kill switch. */
export type Mode = "setup" | "shadow" | "live";
/**
 * Parts of the engine that can run LIVE on their own while the plugin is in Shadow
 * (`Settings.liveModules`). Mode `live` runs every module; `paused` stops every module.
 *   greeting   — public welcome post in #welcome + the one welcome DM
 *   onboarding — Unverified/Verified roles, intake roles, lead threads, owner pings
 *   moderation — deletes, timeouts, warnings, approved bans/kicks, mod-log mirror
 *   disclaimer — risk disclaimer re-posts in trading channels
 *   tickets    — Get help ticket threads
 *   campaigns  — scheduled posts + DM batches
 */
export type LiveModule = "greeting" | "onboarding" | "moderation" | "disclaimer" | "tickets" | "campaigns";
export const LIVE_MODULES: LiveModule[] = ["greeting", "onboarding", "moderation", "disclaimer", "tickets", "campaigns"];
export const LIVE_MODULE_LABELS: Record<LiveModule, string> = {
  greeting: "Welcome greeting",
  onboarding: "Verify + intake",
  moderation: "Moderation",
  disclaimer: "Risk disclaimer",
  tickets: "Tickets",
  campaigns: "Campaigns",
};
/**
 * What an intake answer can point at. `kinglyvault` = KinglyVault Learn (free + paid courses),
 * `kinglyvault-plugins` = the InfiniBot plugin store on KinglyVault. `none` is only an answer
 * tag ("no preference") — a lead is never routed to it (see routing.ts).
 */
export type Offer = "infinibot" | "kinglyvault" | "kinglyvault-plugins" | "pulse" | "none";
/** Offers a lead can actually be routed to (primary / secondary). */
export type RoutedOffer = Exclude<Offer, "none">;
export const ROUTED_OFFERS: RoutedOffer[] = ["infinibot", "kinglyvault", "kinglyvault-plugins", "pulse"];
export const OFFER_LABELS: Record<Offer, string> = {
  infinibot: "InfiniBot",
  kinglyvault: "KinglyVault · Learn",
  "kinglyvault-plugins": "KinglyVault · Plugins",
  pulse: "Gold Desk · Pulse",
  none: "No preference (default route)",
};
export type LeadTier = "hot" | "warm" | "nurture";
export type LeadStage = "new" | "contacted" | "call_booked" | "offer_sent" | "converted" | "lost";
export const LEAD_STAGES: LeadStage[] = [
  "new",
  "contacted",
  "call_booked",
  "offer_sent",
  "converted",
  "lost",
];

export type ChannelPurpose =
  | "start-here"
  | "welcome"
  | "announcements"
  | "help"
  | "support"
  | "onboarding-desk"
  | "mod-log"
  | "staff"
  | "offer-infinibot"
  | "offer-kinglyvault"
  | "offer-golddesk"
  | "introductions"
  | "faq"
  | "lives";

export const CHANNEL_PURPOSES: Array<{ id: ChannelPurpose; label: string; hint: string; required: boolean }> = [
  { id: "start-here", label: "Start here", hint: "Where new members see the Verify button", required: true },
  { id: "welcome", label: "Welcome", hint: "Public welcome posts", required: false },
  { id: "announcements", label: "Announcements", hint: "Scheduled posts and campaigns", required: true },
  { id: "help", label: "Help", hint: "FAQ answers and the Get help button", required: false },
  { id: "support", label: "Support", hint: "Private ticket threads open under this channel", required: true },
  { id: "onboarding-desk", label: "Onboarding desk", hint: "Private lead threads for onboarders", required: true },
  { id: "mod-log", label: "Mod log", hint: "Every moderation action is mirrored here", required: true },
  { id: "staff", label: "Staff", hint: "Daily staff digest", required: false },
  { id: "offer-infinibot", label: "InfiniBot start", hint: "Where the InfiniBot next step points (e.g. #infinibot-start-here)", required: false },
  { id: "offer-kinglyvault", label: "KinglyVault start", hint: "Where KinglyVault learn + plugin steps point (e.g. #vault-start-here)", required: false },
  { id: "offer-golddesk", label: "Gold Desk start", hint: "Where qualified traders are pointed (e.g. #gold-desk-start-here)", required: false },
  { id: "introductions", label: "Introductions", hint: "Where the welcome greeting asks new members to say hi", required: false },
  { id: "faq", label: "FAQ", hint: "Linked from the welcome greeting next to tickets", required: false },
  { id: "lives", label: "Lives", hint: "Where live events happen (linked from the welcome greeting)", required: false },
];

export type RolePurpose =
  | "unverified"
  | "verified"
  | "interest-infinibot"
  | "interest-kinglyvault"
  | "interest-pulse"
  | "staff"
  | "onboarder"
  | "moderator";

export const ROLE_PURPOSES: Array<{ id: RolePurpose; label: string; required: boolean }> = [
  { id: "unverified", label: "Unverified", required: true },
  { id: "verified", label: "Verified", required: true },
  { id: "interest-infinibot", label: "Interest: InfiniBot", required: false },
  { id: "interest-kinglyvault", label: "Interest: KinglyVault", required: false },
  { id: "interest-pulse", label: "Interest: Pulse", required: false },
  { id: "staff", label: "Staff", required: false },
  { id: "onboarder", label: "Onboarder", required: false },
  { id: "moderator", label: "Moderator", required: false },
];

export type IntakeOption = {
  value: string;
  label: string;
  /** 0–100: how strongly this answer signals a qualified lead. */
  points: number;
  /** The interest this answer signals (first matching answer wins; routing.ts turns it into offers). */
  offer?: Offer;
  /** Interest role granted for this answer. */
  role?: RolePurpose;
  /** For gate questions: whether this answer passes (inferred from the text when unset, failing closed). */
  pass?: boolean;
};

export type IntakeQuestion = {
  id: string;
  label: string;
  type: "single";
  /** Share of the 0–100 score; all weights add up to 100. */
  weight: number;
  options: IntakeOption[];
  /** Gold Desk qualification gate this question answers (inferred from id/label when unset). */
  gate?: "age" | "region" | "capital";
};

export type ModPreset = "relaxed" | "standard" | "strict";

export type ModerationSettings = {
  preset: ModPreset;
  /** Accounts younger than this go to manual review instead of auto-verify. */
  minAccountAgeDays: number;
  /** Joins per 60 s that trigger lockdown + an owner alert. */
  raidJoinsPerMinute: number;
  /** Delete invite links outside staff channels. */
  blockInvites: boolean;
  /** Extra phrases on top of the built-in banned-claims list. */
  extraBannedClaims: string[];
  /** Extra scam domains on top of the built-in list. */
  extraScamDomains: string[];
};

export type ComplianceSettings = {
  /** Pulse / Gold Desk risk disclaimer (owner/legal to finalise). */
  disclaimer: string;
  /** Channels tagged `compliance: trading`. */
  tradingChannelIds: string[];
  /** Re-post the disclaimer every N messages in a trading channel. */
  repostEvery: number;
  minAge: number;
  blockedRegions: string[];
};

export type TeamMember = {
  discordId: string;
  name: string;
  role: "onboarder" | "moderator" | "manager";
  offers: Offer[];
  active: boolean;
};

export type TestRunStep = { id: string; label: string; ok: boolean; detail: string };
export type TestRunResult = { ok: boolean; at: number; steps: TestRunStep[] };

export type Settings = {
  accountId: string;
  guildId: string | null;
  guildName: string | null;
  memberCount: number | null;
  mode: Mode;
  paused: boolean;
  /**
   * Modules that act LIVE while `mode` is "shadow" (e.g. ["greeting"]). Empty / missing =
   * the plain global mode. Ignored in "live" (everything acts) and "setup" (nothing runs).
   */
  liveModules?: LiveModule[];
  channelMap: Partial<Record<ChannelPurpose, string>>;
  roleMap: Partial<Record<RolePurpose, string>>;
  questions: IntakeQuestion[];
  welcomeDm: string;
  /** Optional owner-supplied link per offer, shown next to the channel in every CTA. Never invented. */
  offerLinks: Partial<Record<RoutedOffer, string>>;
  moderation: ModerationSettings;
  compliance: ComplianceSettings;
  testRun: TestRunResult | null;
  /** Furthest wizard step saved (resume point). */
  setupStep: number;
  liveSince: number | null;
  version: number;
};

// ── Records ──────────────────────────────────────────────────────────────

export type Lead = {
  id: string;
  guildId: string;
  memberId: string;
  username: string;
  /** Same as primaryOffer (kept for older readers + the funnel). */
  offer: RoutedOffer;
  primaryOffer: RoutedOffer;
  secondaryOffer: RoutedOffer;
  /** The next step the member was given (never empty). */
  cta: string;
  /** Why this route (see routing.ts RouteReason). */
  routeReason: string;
  score: number;
  tier: LeadTier;
  breakdown: Array<{ questionId: string; answer: string; points: number; weight: number; contribution: number }>;
  stage: LeadStage;
  assigneeId: string | null;
  assigneeName: string | null;
  slaDueAt: number | null;
  threadId: string | null;
  createdAt: number;
  updatedAt: number;
};

export type ModActionStatus = "done" | "shadow" | "pending_approval" | "approved" | "denied" | "failed" | "paused";
export type ModActionKind =
  | "warn"
  | "delete"
  | "timeout"
  | "kick"
  | "ban"
  | "mass_dm"
  | "announce_everyone";

export type ModAction = {
  id: string;
  ts: number;
  actor: string;
  targetId: string | null;
  targetName: string | null;
  action: ModActionKind;
  rule: string;
  reason: string;
  evidence: string | null;
  status: ModActionStatus;
  approvalId: string | null;
  durationMs: number | null;
};

export type TicketState = "open" | "waiting_member" | "waiting_staff" | "resolved" | "closed";
export type Ticket = {
  id: string;
  guildId: string;
  memberId: string;
  username: string;
  category: string;
  threadId: string | null;
  state: TicketState;
  createdAt: number;
  updatedAt: number;
};

export type CampaignStatus = "scheduled" | "pending_approval" | "sent" | "shadow" | "cancelled" | "denied" | "failed";
export type Campaign = {
  id: string;
  title: string;
  content: string;
  channelId: string | null;
  scheduleAt: number;
  status: CampaignStatus;
  approvalId: string | null;
  pingsEveryone: boolean;
  createdAt: number;
};

export type ActivityKind =
  | "join"
  | "leave"
  | "verify"
  | "intake"
  | "lead"
  | "mod"
  | "ticket"
  | "disclaimer"
  | "campaign"
  | "approval"
  | "system";

export type Activity = {
  id: number;
  ts: number;
  kind: ActivityKind;
  text: string;
  /** True when the engine only logged what it would have done (shadow / paused). */
  dry: boolean;
};

// ── Responses ────────────────────────────────────────────────────────────

export type HealthCheck = { id: string; label: string; state: "ok" | "warn" | "fail"; detail: string };

export type TokenValidation = {
  ok: boolean;
  error?: string;
  bot?: { id: string; username: string; globalName: string | null; avatarUrl: string | null };
  application?: {
    id: string;
    name: string;
    flags: number;
    botPublic: boolean;
    intents: { guildMembers: string; messageContent: string; presence: string };
  };
  inviteUrl?: string;
  checks: HealthCheck[];
};

export type GuildSummary = {
  id: string;
  name: string;
  iconUrl: string | null;
  memberCount: number | null;
  admin: boolean;
  missingPermissions: string[];
};

export type GuildDiscovery = {
  guildId: string;
  channels: Array<{ id: string; name: string; type: number | string; parentId: string | null }>;
  roles: Array<{ id: string; name: string; position: number; managed: boolean; aboveBot: boolean }>;
  botRolePosition: number | null;
  checks: HealthCheck[];
};

export type StatusResponse = {
  pluginId: string;
  accountId: string;
  mode: Mode;
  paused: boolean;
  /** Modules acting LIVE while in Shadow (empty = none). */
  liveModules: LiveModule[];
  setupStep: number;
  guild: { id: string; name: string | null; memberCount: number | null } | null;
  connection: {
    tokenConfigured: boolean;
    tokenSource: string;
    accountEnabled: boolean;
    guildMembersIntent: boolean;
    discordPluginEnabled: boolean;
    lastEventAt: number | null;
    listening: boolean;
  };
  pro: { unlocked: boolean; source: string | null };
  kpis: Kpis;
  health: HealthCheck[];
};

export type Kpis = {
  joinsToday: number;
  verifiedPct: number | null;
  messagesToday: number;
  activeToday: number;
  hotLeadsOpen: number;
  leadsOpen: number;
  /** % of members who finished intake and have a lead with an assigned offer (target 100). */
  offerAssignedPct: number | null;
  ticketsOpen: number;
  modActions24h: number;
  pendingApprovals: number;
};

export type AnalyticsSummary = {
  days: Array<{ date: string; joins: number; verified: number; messages: number; active: number; leads: number }>;
  funnel: Array<{ offer: RoutedOffer; joined: number; leads: number; contacted: number; converted: number }>;
  tiers: Record<LeadTier, number>;
};
