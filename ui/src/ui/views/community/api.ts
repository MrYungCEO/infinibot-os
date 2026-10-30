/**
 * Typed client for the community-manager plugin RPCs. Shapes come from the
 * plugin contract (extensions/community-manager/src/contract.ts). The bot
 * token is only ever sent (validate/save), never received.
 */

import {
  RPC,
  type Activity,
  type AnalyticsSummary,
  type Campaign,
  type ComplianceSettings,
  type GuildDiscovery,
  type GuildSummary,
  type IntakeQuestion,
  type Lead,
  type LeadStage,
  type LiveModule,
  type ModAction,
  type ModPreset,
  type Settings,
  type StatusResponse,
  type TeamMember,
  type TestRunResult,
  type Ticket,
  type TicketState,
  type TokenValidation,
} from "../../../../../extensions/community-manager/src/contract.js";

export interface GatewayCallable {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
}

export type PendingApproval = { id: string; title: string; summary: string; createdAt: number };

export class CommunityApi {
  constructor(private client: GatewayCallable) {}

  status = () => this.client.request<StatusResponse>(RPC.status, {});
  setupState = () => this.client.request<{ settings: Settings; team: TeamMember[]; status: StatusResponse }>(RPC.setupState, {});
  validateToken = (token?: string) => this.client.request<TokenValidation & { source: string }>(RPC.validateToken, token ? { token } : {});
  saveToken = (token: string, allowRestart = false) =>
    this.client.request<TokenValidation & { saved: boolean; needsRestart?: boolean }>(RPC.saveToken, { token, ...(allowRestart ? { allowRestart: true } : {}) });
  guilds = () => this.client.request<{ guilds: GuildSummary[] }>(RPC.guilds, {});
  selectGuild = (guildId: string) => this.client.request<{ guild: GuildSummary; settings: Settings }>(RPC.selectGuild, { guildId });
  discovery = () => this.client.request<GuildDiscovery>(RPC.discovery, {});
  saveMapping = (p: { channelMap: Settings["channelMap"]; roleMap: Settings["roleMap"]; tradingChannelIds: string[] }) =>
    this.client.request<{ settings: Settings; issues: string[] }>(RPC.saveMapping, p);
  saveQuestions = (questions: IntakeQuestion[], welcomeDm: string, offerLinks?: Settings["offerLinks"]) =>
    this.client.request<{ settings: Settings; issues: string[] }>(RPC.saveQuestions, { questions, welcomeDm, offerLinks });
  savePreset = (p: { preset: ModPreset; extraBannedClaims?: string[]; extraScamDomains?: string[]; compliance?: Partial<ComplianceSettings> }) =>
    this.client.request<{ settings: Settings }>(RPC.savePreset, p);
  saveTeam = (team: TeamMember[]) => this.client.request<{ team: TeamMember[] }>(RPC.saveTeam, { team });
  testRun = () => this.client.request<TestRunResult>(RPC.testRun, {});
  goLive = (mode: "shadow" | "live", postPanel = false) =>
    this.client.request<{ ok: boolean; blockers?: string[]; settings?: Settings; verifyPanelPosted?: boolean }>(RPC.goLive, { mode, postPanel });
  liveModules = (modules: LiveModule[]) =>
    this.client.request<{ mode: string; paused: boolean; liveModules: LiveModule[] }>(RPC.liveModules, { modules });
  pause = (paused: boolean) => this.client.request<{ paused: boolean; mode: string }>(RPC.pause, { paused });
  activity = (afterId = 0) => this.client.request<{ items: Activity[] }>(RPC.activity, { afterId, limit: 120 });
  leads = () => this.client.request<{ leads: Lead[] }>(RPC.leads, {});
  updateLead = (id: string, patch: { stage?: LeadStage; assigneeId?: string }) => this.client.request<{ lead: Lead }>(RPC.leadUpdate, { id, ...patch });
  modQueue = () => this.client.request<{ pending: ModAction[]; approvals: PendingApproval[]; recent: ModAction[] }>(RPC.modQueue, {});
  tickets = () => this.client.request<{ tickets: Ticket[] }>(RPC.tickets, {});
  updateTicket = (id: string, state: TicketState) => this.client.request<{ ticket: Ticket }>(RPC.ticketUpdate, { id, state });
  campaigns = () => this.client.request<{ campaigns: Campaign[] }>(RPC.campaigns, {});
  createCampaign = (p: { title: string; content: string; scheduleAt: number; channelId?: string }) => this.client.request<{ campaign: Campaign }>(RPC.campaignCreate, p);
  cancelCampaign = (id: string) => this.client.request<{ campaign: Campaign }>(RPC.campaignCancel, { id });
  analytics = (days = 14) => this.client.request<AnalyticsSummary>(RPC.analytics, { days });
  /** Core approvals (same queue as Telegram / mobile). */
  resolveApproval = (id: string, action: "approve" | "deny") => this.client.request("approvals.resolve", { id, action });
}
