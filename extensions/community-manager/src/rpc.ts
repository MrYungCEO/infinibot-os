/**
 * Gateway RPCs (`community-manager.*`). Every response is token-free: token
 * state is `{ configured, source }` and Discord errors pass through
 * `redactToken`.
 */

import type { GatewayRequestHandlerOptions } from "infinibot/plugin-sdk";

import {
  AGENT_ID,
  CHANNEL_PURPOSES,
  LEAD_STAGES,
  LIVE_MODULE_LABELS,
  LIVE_MODULES,
  RPC,
  ROUTED_OFFERS,
  type AnalyticsSummary,
  type ChannelPurpose,
  type HealthCheck,
  type IntakeQuestion,
  type Kpis,
  type LeadStage,
  type LeadTier,
  type LiveModule,
  type ModPreset,
  type RolePurpose,
  type RoutedOffer,
  type Settings,
  type StatusResponse,
  type TeamMember,
  type TicketState,
} from "./contract.js";
import { PRESETS } from "./defaults.js";
import type { CommunityEngine, DiscordPort } from "./engine.js";
import { validateQuestions } from "./scoring.js";
import {
  discoverGuild,
  listGuilds,
  mappingIssues,
  redactToken,
  runTestRun,
  validateToken,
} from "./setup.js";
import { dayKey, type CommunityStore } from "./store.js";
import type { ConfigWriter } from "./token-config.js";

type Respond = GatewayRequestHandlerOptions["respond"];
type Handler = (opts: GatewayRequestHandlerOptions) => Promise<void> | void;

export type RpcDeps = {
  store: () => CommunityStore;
  engine: () => CommunityEngine;
  rest: DiscordPort;
  config: ConfigWriter;
  normalizeToken: (t: string) => string | undefined;
  intentsFromFlags: (flags: number) => { guildMembers: string; messageContent: string; presence: string };
  pro: () => { unlocked: boolean; source: string | null };
  pendingApprovals: () => Array<{ id: string; title: string; summary: string; createdAt: number; sourceRef?: Record<string, string> }>;
  listening: () => boolean;
};

function fail(respond: Respond, err: unknown, token?: string | null): void {
  const message = redactToken(err instanceof Error ? err.message : String(err), token ?? null);
  respond(false, undefined, { code: "INVALID_REQUEST", message });
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** Owner-supplied offer links: http(s) URLs only, ≤ 300 chars; anything else is dropped. */
function cleanOfferLinks(raw: unknown, prev: Settings["offerLinks"]): Settings["offerLinks"] {
  if (!raw || typeof raw !== "object") return prev ?? {};
  const out: Settings["offerLinks"] = {};
  for (const o of ROUTED_OFFERS) {
    const v = str((raw as Record<string, unknown>)[o]);
    if (v && v.length <= 300 && /^https?:\/\/\S+$/.test(v)) out[o] = v;
  }
  return out;
}

function kpis(store: CommunityStore, s: Settings, pendingApprovals: number): Kpis {
  const today = dayKey(Date.now());
  const g = s.guildId ?? "";
  const day = store.metricsSince(g || null, today)[0];
  const members = store.count("SELECT COUNT(*) n FROM cm_members WHERE guild_id = ?", g);
  const verified = store.count("SELECT COUNT(*) n FROM cm_members WHERE guild_id = ? AND verified_at IS NOT NULL", g);
  // "% of members with an assigned offer": everyone who finished intake must have a routed lead.
  const intakeDone = store.count("SELECT COUNT(*) n FROM cm_members WHERE guild_id = ? AND intake_done_at IS NOT NULL", g);
  const withOffer = store.count(
    `SELECT COUNT(DISTINCT m.discord_id) n FROM cm_members m JOIN cm_leads l ON l.guild_id = m.guild_id AND l.member_id = m.discord_id
     WHERE m.guild_id = ? AND m.intake_done_at IS NOT NULL AND l.offer IN (${ROUTED_OFFERS.map(() => "?").join(",")})`,
    g,
    ...ROUTED_OFFERS,
  );
  return {
    joinsToday: day?.joins ?? 0,
    verifiedPct: members ? Math.round((verified / members) * 100) : null,
    messagesToday: day?.messages ?? 0,
    activeToday: day?.active ?? 0,
    hotLeadsOpen: store.count("SELECT COUNT(*) n FROM cm_leads WHERE tier = 'hot' AND stage NOT IN ('converted','lost')"),
    leadsOpen: store.count("SELECT COUNT(*) n FROM cm_leads WHERE stage NOT IN ('converted','lost')"),
    offerAssignedPct: intakeDone ? Math.round((withOffer / intakeDone) * 100) : null,
    ticketsOpen: store.count("SELECT COUNT(*) n FROM cm_tickets WHERE state NOT IN ('resolved','closed')"),
    modActions24h: store.count("SELECT COUNT(*) n FROM cm_mod_actions WHERE ts > ?", Date.now() - 86_400_000),
    pendingApprovals,
  };
}

export function createCommunityHandlers(deps: RpcDeps): Record<string, Handler> {
  const token = () => deps.config.token();

  const status = (): StatusResponse => {
    const store = deps.store();
    const s = store.getSettings();
    const acct = deps.config.account();
    const pending = deps.pendingApprovals().length;
    const health: HealthCheck[] = [
      { id: "token", label: "Bot token", state: acct.tokenConfigured ? "ok" : "fail", detail: acct.tokenConfigured ? `Saved (${acct.tokenSource})` : "Not connected" },
      { id: "intent", label: "Server Members intent (config)", state: acct.guildMembersIntent ? "ok" : "warn", detail: acct.guildMembersIntent ? "On for this account" : "Off — joins won't be seen" },
      { id: "discord-plugin", label: "Discord channel", state: acct.discordPluginEnabled ? "ok" : "warn", detail: acct.discordPluginEnabled ? "Enabled" : "Discord channel plugin is off (enable + restart to receive events)" },
      { id: "guild", label: "Server", state: s.guildId ? "ok" : "fail", detail: s.guildName ?? "No server picked" },
      {
        id: "mode",
        label: "Mode",
        state: s.paused ? "warn" : s.mode === "live" ? "ok" : "warn",
        detail: s.paused
          ? "Paused"
          : s.mode === "shadow" && s.liveModules?.length
            ? `shadow · live: ${s.liveModules.map((m) => LIVE_MODULE_LABELS[m]).join(", ")}`
            : s.mode,
      },
    ];
    return {
      pluginId: "community-manager",
      accountId: s.accountId,
      mode: s.mode,
      paused: s.paused,
      liveModules: s.mode === "shadow" ? (s.liveModules ?? []) : [],
      setupStep: s.setupStep,
      guild: s.guildId ? { id: s.guildId, name: s.guildName, memberCount: s.memberCount } : null,
      connection: {
        tokenConfigured: acct.tokenConfigured,
        tokenSource: acct.tokenSource,
        accountEnabled: acct.enabled,
        guildMembersIntent: acct.guildMembersIntent,
        discordPluginEnabled: acct.discordPluginEnabled,
        lastEventAt: deps.engine().lastEventAt,
        listening: deps.listening(),
      },
      pro: deps.pro(),
      kpis: kpis(store, s, pending),
      health,
    };
  };

  const advance = (store: CommunityStore, step: number, patch: Partial<Settings> = {}) => {
    const s = store.getSettings();
    return store.saveSettings({ ...patch, setupStep: Math.max(s.setupStep, step) });
  };

  const handlers: Record<string, Handler> = {
    [RPC.status]: ({ respond }) => {
      try {
        respond(true, status());
      } catch (err) {
        fail(respond, err);
      }
    },

    [RPC.setupState]: ({ respond }) => {
      try {
        const store = deps.store();
        respond(true, { settings: store.getSettings(), team: store.listTeam(), status: status() });
      } catch (err) {
        fail(respond, err);
      }
    },

    // Step 1: check a pasted token (or the saved one) without saving it.
    [RPC.validateToken]: async ({ params, respond }) => {
      const pasted = str(params?.token);
      const t = pasted || token() || "";
      try {
        const result = await validateToken(t, { rest: deps.rest, normalize: deps.normalizeToken, intentsFromFlags: deps.intentsFromFlags });
        respond(true, { ...result, source: pasted ? "pasted" : t ? "saved" : "none" });
      } catch (err) {
        fail(respond, err, t);
      }
    },

    // Step 1: validate, then save to channels.discord.accounts.<id>.token (+ guildMembers intent).
    [RPC.saveToken]: async ({ params, respond }) => {
      const pasted = str(params?.token);
      try {
        const result = await validateToken(pasted, { rest: deps.rest, normalize: deps.normalizeToken, intentsFromFlags: deps.intentsFromFlags });
        if (!result.bot) {
          respond(true, { ...result, saved: false });
          return;
        }
        // channels.discord.* hot-reloads only while the Discord channel plugin
        // is loaded; otherwise the config write restarts the whole gateway
        // (which kills running coder runs). Refuse unless asked explicitly.
        if (!deps.config.account().discordPluginEnabled && params?.allowRestart !== true) {
          respond(true, {
            ...result,
            saved: false,
            needsRestart: true,
            error:
              "The Discord channel plugin is off, so saving the token now would restart the gateway. Turn on Discord in Plugins (one planned restart), then save again — or save and restart now.",
          });
          return;
        }
        const store = deps.store();
        await deps.config.saveToken(store.getSettings().accountId, deps.normalizeToken(pasted) ?? "", result.bot.username);
        advance(store, 2);
        respond(true, { ...result, saved: true });
      } catch (err) {
        fail(respond, err, pasted);
      }
    },

    // Steps 2–3: guilds the bot is in (polled while waiting for the invite).
    [RPC.guilds]: async ({ respond }) => {
      const t = token();
      if (!t) return fail(respond, new Error("Connect the bot token first (step 1)."));
      try {
        respond(true, { guilds: await listGuilds(t, deps.rest) });
      } catch (err) {
        fail(respond, err, t);
      }
    },

    // Step 3: pick the server; binds it to the community agent.
    [RPC.selectGuild]: async ({ params, respond }) => {
      const t = token();
      const guildId = str(params?.guildId);
      if (!t) return fail(respond, new Error("Connect the bot token first (step 1)."));
      if (!/^\d{3,25}$/.test(guildId)) return fail(respond, new Error("guildId required"));
      try {
        const guilds = await listGuilds(t, deps.rest);
        const g = guilds.find((x) => x.id === guildId);
        if (!g) return fail(respond, new Error("The bot isn't in that server yet — use the invite link first."));
        const store = deps.store();
        const s = advance(store, 4, { guildId: g.id, guildName: g.name, memberCount: g.memberCount });
        await deps.config.bindGuild(s.accountId, g.id, AGENT_ID);
        respond(true, { guild: g, settings: s });
      } catch (err) {
        fail(respond, err, t);
      }
    },

    // Step 4: channels + roles of the picked server.
    [RPC.discovery]: async ({ respond }) => {
      const t = token();
      const s = deps.store().getSettings();
      if (!t || !s.guildId) return fail(respond, new Error("Pick a server first (step 3)."));
      try {
        const me = await deps.rest.getCurrentUser(t);
        respond(true, await discoverGuild(t, s.guildId, me.id, deps.rest));
      } catch (err) {
        fail(respond, err, t);
      }
    },

    [RPC.saveMapping]: ({ params, respond }) => {
      try {
        const store = deps.store();
        const s = store.getSettings();
        const channelMap = cleanMap<ChannelPurpose>(params?.channelMap);
        const roleMap = cleanMap<RolePurpose>(params?.roleMap);
        const trading = Array.isArray(params?.tradingChannelIds)
          ? (params.tradingChannelIds as unknown[]).map(str).filter((x) => /^\d{3,25}$/.test(x))
          : s.compliance.tradingChannelIds;
        const issues = mappingIssues({ channelMap, roleMap });
        const next = store.saveSettings({
          channelMap,
          roleMap,
          compliance: { ...s.compliance, tradingChannelIds: trading },
          ...(issues.length ? {} : { setupStep: Math.max(s.setupStep, 5) }),
        });
        respond(true, { settings: next, issues });
      } catch (err) {
        fail(respond, err);
      }
    },

    [RPC.saveQuestions]: ({ params, respond }) => {
      try {
        const store = deps.store();
        const s = store.getSettings();
        const questions = (Array.isArray(params?.questions) ? params.questions : s.questions) as IntakeQuestion[];
        const welcomeDm = str(params?.welcomeDm) || s.welcomeDm;
        const offerLinks = cleanOfferLinks(params?.offerLinks, s.offerLinks);
        const issues = validateQuestions(questions).map((i) => i.message);
        if (issues.length) {
          respond(true, { settings: s, issues });
          return;
        }
        const next = store.saveSettings({ questions, welcomeDm, offerLinks, setupStep: Math.max(s.setupStep, 6) });
        respond(true, { settings: next, issues: [] });
      } catch (err) {
        fail(respond, err);
      }
    },

    [RPC.savePreset]: ({ params, respond }) => {
      try {
        const store = deps.store();
        const s = store.getSettings();
        const preset = (str(params?.preset) || s.moderation.preset) as ModPreset;
        if (!PRESETS[preset]) return fail(respond, new Error("preset must be relaxed, standard or strict"));
        const list = (v: unknown, fallback: string[]) =>
          Array.isArray(v) ? (v as unknown[]).map(str).filter(Boolean).slice(0, 200) : fallback;
        const c = (params?.compliance ?? {}) as Record<string, unknown>;
        const next = store.saveSettings({
          moderation: {
            ...PRESETS[preset],
            extraBannedClaims: list(params?.extraBannedClaims, s.moderation.extraBannedClaims),
            extraScamDomains: list(params?.extraScamDomains, s.moderation.extraScamDomains),
          },
          compliance: {
            ...s.compliance,
            disclaimer: str(c.disclaimer) || s.compliance.disclaimer,
            repostEvery: Number.isFinite(c.repostEvery) ? Math.max(5, Math.min(500, Number(c.repostEvery))) : s.compliance.repostEvery,
            blockedRegions: list(c.blockedRegions, s.compliance.blockedRegions),
          },
          setupStep: Math.max(s.setupStep, 8),
        });
        respond(true, { settings: next });
      } catch (err) {
        fail(respond, err);
      }
    },

    [RPC.saveTeam]: ({ params, respond }) => {
      try {
        const store = deps.store();
        const offers: string[] = ROUTED_OFFERS;
        const team: TeamMember[] = (Array.isArray(params?.team) ? (params.team as Array<Record<string, unknown>>) : [])
          .map((t) => ({
            discordId: str(t.discordId),
            name: str(t.name) || str(t.discordId),
            role: (["onboarder", "moderator", "manager"].includes(str(t.role)) ? str(t.role) : "onboarder") as TeamMember["role"],
            offers: Array.isArray(t.offers) ? (t.offers as unknown[]).map(str).filter((o): o is RoutedOffer => offers.includes(o)) : [],
            active: t.active !== false,
          }))
          .filter((t) => /^\d{3,25}$/.test(t.discordId));
        store.saveTeam(team);
        advance(store, 8);
        respond(true, { team: store.listTeam() });
      } catch (err) {
        fail(respond, err);
      }
    },

    // Step 9: sandboxed walk-through (never touches Discord).
    [RPC.testRun]: async ({ respond }) => {
      try {
        const store = deps.store();
        const result = await runTestRun(store.getSettings(), store.listTeam());
        const s = store.getSettings();
        store.saveSettings({ testRun: result, ...(result.ok ? { setupStep: Math.max(s.setupStep, 10) } : {}) });
        store.addActivity("system", `test run ${result.ok ? "passed" : "failed"} (${result.steps.filter((x) => x.ok).length}/${result.steps.length})`, true);
        respond(true, result);
      } catch (err) {
        fail(respond, err);
      }
    },

    // Step 9 "simulate join": feed a synthetic member through the real
    // engine. Shadow mode only, so it can never touch Discord; everything it
    // logs is tagged [simulated].
    [RPC.simulate]: async ({ params, respond }) => {
      try {
        const store = deps.store();
        const s = store.getSettings();
        if (s.mode !== "shadow" || s.paused) {
          return fail(respond, new Error("Simulation runs only in Shadow mode (nothing is sent to Discord)."));
        }
        const id = /^\d{3,25}$/.test(str(params?.userId)) ? str(params?.userId) : String(9_000_000_000_000_000 + Math.floor(Math.random() * 1e9));
        const user = { id, username: str(params?.username) || `sim-${id.slice(-4)}`, avatar: "sim" };
        const base = { accountId: s.accountId, guildId: s.guildId ?? "" };
        const engine = deps.engine();
        const kind = str(params?.kind) || "join";
        store.addActivity("system", `[simulated] ${kind} for @${user.username}`, true);
        if (kind === "join" || kind === "member") {
          await engine.handleEvent({ kind: "member_add", ...base, user, joinedAt: new Date().toISOString() });
        }
        if (kind === "member") {
          await engine.handleEvent({ kind: "component", ...base, channelId: s.channelMap["start-here"] ?? null, user, customId: "cm:a=verify", values: [] });
          const answers = (params?.answers ?? {}) as Record<string, string>;
          for (const q of s.questions) {
            const v = answers[q.id] ?? q.options[0]?.value ?? "";
            await engine.handleEvent({ kind: "component", ...base, channelId: s.channelMap["start-here"] ?? null, user, customId: `cmsel:q=${q.id}`, values: [v] });
          }
        }
        if (kind === "message") {
          await engine.handleEvent({ kind: "message", ...base, channelId: str(params?.channelId) || "0", messageId: `sim-${Date.now()}`, author: user, content: str(params?.content) });
        }
        if (kind === "help") {
          await engine.handleEvent({ kind: "component", ...base, channelId: s.channelMap["start-here"] ?? null, user, customId: "cm:a=help", values: [] });
        }
        respond(true, { ok: true, userId: id });
      } catch (err) {
        fail(respond, err);
      }
    },

    // Step 10: shadow (log only) or live. Live needs a passing test run.
    [RPC.goLive]: async ({ params, respond }) => {
      try {
        const store = deps.store();
        const s = store.getSettings();
        const mode = str(params?.mode) === "live" ? "live" : "shadow";
        const blockers = [
          ...(s.guildId ? [] : ["Pick a server (step 3)."]),
          ...(deps.config.account().tokenConfigured ? [] : ["Connect the bot token (step 1)."]),
          ...mappingIssues(s),
          ...(s.testRun?.ok ? [] : ["Run the test run (step 9) until it passes."]),
        ];
        if (blockers.length) {
          respond(true, { ok: false, blockers });
          return;
        }
        const next = store.saveSettings({ mode, paused: false, liveSince: s.liveSince ?? Date.now(), setupStep: 10 });
        store.addActivity("system", `went ${mode === "live" ? "LIVE" : "into SHADOW mode"}`);
        let panel = false;
        if (mode === "live" && params?.postPanel === true) panel = await deps.engine().postVerifyPanel(next);
        respond(true, { ok: true, settings: next, verifyPanelPosted: panel });
      } catch (err) {
        fail(respond, err);
      }
    },

    // Kill switch.
    [RPC.pause]: ({ params, respond }) => {
      try {
        const store = deps.store();
        const paused = params?.paused !== false;
        const next = store.saveSettings({ paused });
        store.addActivity("system", paused ? "PAUSED — autonomous actions stopped" : "resumed");
        respond(true, { paused: next.paused, mode: next.mode });
      } catch (err) {
        fail(respond, err);
      }
    },

    // Per-module live list: in Shadow, only these modules act (e.g. ["greeting"]).
    // Hot: the engine reads settings on every event, so no restart is needed.
    [RPC.liveModules]: ({ params, respond }) => {
      try {
        const store = deps.store();
        const s = store.getSettings();
        if (!Array.isArray(params?.modules)) return fail(respond, new Error(`modules must be an array of: ${LIVE_MODULES.join(", ")}`));
        const raw = (params.modules as unknown[]).map(str);
        const unknown = raw.filter((m) => !LIVE_MODULES.includes(m as LiveModule));
        if (unknown.length) return fail(respond, new Error(`unknown module(s): ${unknown.join(", ")} (allowed: ${LIVE_MODULES.join(", ")})`));
        const modules = LIVE_MODULES.filter((m) => raw.includes(m));
        if (modules.length && s.mode === "setup") return fail(respond, new Error("Finish setup first: live modules run only in Shadow mode."));
        // Optional `channels`: purposes merged into the existing map (e.g. the greeting's
        // introductions / faq / lives), so callers don't have to resend the whole mapping.
        const known = new Set<string>(CHANNEL_PURPOSES.map((p) => p.id));
        const channels = Object.fromEntries(Object.entries(cleanMap<ChannelPurpose>(params?.channels)).filter(([k]) => known.has(k)));
        const next = store.saveSettings({
          liveModules: modules,
          ...(Object.keys(channels).length ? { channelMap: { ...s.channelMap, ...channels } } : {}),
        });
        store.addActivity(
          "system",
          modules.length ? `LIVE modules in Shadow: ${modules.map((m) => LIVE_MODULE_LABELS[m]).join(", ")}` : "no LIVE modules: Shadow logs everything",
        );
        respond(true, { mode: next.mode, paused: next.paused, liveModules: next.liveModules ?? [], channelMap: next.channelMap });
      } catch (err) {
        fail(respond, err);
      }
    },

    [RPC.activity]: ({ params, respond }) => {
      const afterId = Number(params?.afterId) || 0;
      const limit = Math.max(1, Math.min(300, Number(params?.limit) || 100));
      respond(true, { items: deps.store().listActivity({ afterId, limit }) });
    },

    [RPC.leads]: ({ params, respond }) => {
      const s = deps.store().getSettings();
      respond(true, { leads: deps.store().listLeads({ guildId: s.guildId, open: params?.open === true, limit: 300 }) });
    },

    [RPC.leadUpdate]: ({ params, respond }) => {
      const id = str(params?.id);
      const stage = str(params?.stage) as LeadStage;
      const patch: Record<string, unknown> = {};
      if (stage) {
        if (!LEAD_STAGES.includes(stage)) return fail(respond, new Error("unknown stage"));
        patch.stage = stage;
      }
      if (typeof params?.assigneeId === "string") {
        const member = deps.store().listTeam().find((t) => t.discordId === params.assigneeId);
        patch.assigneeId = member?.discordId ?? null;
        patch.assigneeName = member?.name ?? null;
      }
      const lead = deps.store().updateLead(id, patch, "dashboard");
      if (!lead) return fail(respond, new Error("lead not found"));
      deps.store().addActivity("lead", `lead @${lead.username} → ${lead.stage}${lead.assigneeName ? ` (${lead.assigneeName})` : ""}`);
      respond(true, { lead });
    },

    [RPC.modQueue]: ({ respond }) => {
      const store = deps.store();
      const approvals = deps.pendingApprovals();
      respond(true, {
        pending: store.listModActions({ status: "pending_approval" }),
        approvals,
        recent: store.listModActions({ limit: 50 }),
      });
    },

    [RPC.tickets]: ({ respond }) => {
      respond(true, { tickets: deps.store().listTickets({ limit: 200 }) });
    },

    [RPC.ticketUpdate]: ({ params, respond }) => {
      const state = str(params?.state) as TicketState;
      if (!["open", "waiting_member", "waiting_staff", "resolved", "closed"].includes(state)) return fail(respond, new Error("unknown state"));
      const t = deps.store().updateTicket(str(params?.id), state);
      if (!t) return fail(respond, new Error("ticket not found"));
      respond(true, { ticket: t });
    },

    [RPC.campaigns]: ({ respond }) => {
      respond(true, { campaigns: deps.store().listCampaigns() });
    },

    [RPC.campaignCreate]: ({ params, respond }) => {
      try {
        const title = str(params?.title);
        const content = str(params?.content);
        const at = Number(params?.scheduleAt);
        if (!title || !content) return fail(respond, new Error("title and content required"));
        if (!Number.isFinite(at)) return fail(respond, new Error("scheduleAt (ms) required"));
        const c = deps.store().createCampaign({
          title: title.slice(0, 120),
          content: content.slice(0, 1900),
          channelId: str(params?.channelId) || null,
          scheduleAt: at,
          status: "scheduled",
          pingsEveryone: /@(everyone|here)\b/.test(content),
        });
        deps.store().addActivity("campaign", `scheduled "${c.title}"${c.pingsEveryone ? " (needs approval: @everyone)" : ""}`);
        respond(true, { campaign: c });
      } catch (err) {
        fail(respond, err);
      }
    },

    [RPC.campaignCancel]: ({ params, respond }) => {
      const c = deps.store().getCampaign(str(params?.id));
      if (!c) return fail(respond, new Error("campaign not found"));
      if (c.status === "scheduled" || c.status === "pending_approval") deps.store().setCampaignStatus(c.id, "cancelled");
      respond(true, { campaign: deps.store().getCampaign(c.id) });
    },

    [RPC.analytics]: ({ params, respond }) => {
      const store = deps.store();
      const s = store.getSettings();
      const days = Math.max(1, Math.min(90, Number(params?.days) || 14));
      const from = dayKey(Date.now() - (days - 1) * 86_400_000);
      const rows = store.metricsSince(s.guildId, from);
      const byDate = new Map(rows.map((r) => [r.date, r]));
      const series: AnalyticsSummary["days"] = [];
      for (let i = days - 1; i >= 0; i -= 1) {
        const date = dayKey(Date.now() - i * 86_400_000);
        const r = byDate.get(date);
        series.push({ date, joins: r?.joins ?? 0, verified: r?.verified ?? 0, messages: r?.messages ?? 0, active: r?.active ?? 0, leads: r?.leads ?? 0 });
      }
      // Legacy rows routed to "none" read as the default route (InfiniBot), like rowToLead.
      const offers = ROUTED_OFFERS;
      const match = (o: string) => (o === "infinibot" ? "offer IN (?, 'none')" : "offer = ?");
      const joined = store.count("SELECT COUNT(*) n FROM cm_members WHERE guild_id = ?", s.guildId ?? "");
      const funnel = offers.map((offer) => ({
        offer,
        joined,
        leads: store.count(`SELECT COUNT(*) n FROM cm_leads WHERE ${match(offer)}`, offer),
        contacted: store.count(`SELECT COUNT(*) n FROM cm_leads WHERE ${match(offer)} AND stage != 'new'`, offer),
        converted: store.count(`SELECT COUNT(*) n FROM cm_leads WHERE ${match(offer)} AND stage = 'converted'`, offer),
      }));
      const tiers = { hot: 0, warm: 0, nurture: 0 } as Record<LeadTier, number>;
      for (const t of ["hot", "warm", "nurture"] as LeadTier[]) tiers[t] = store.count("SELECT COUNT(*) n FROM cm_leads WHERE tier = ?", t);
      const out: AnalyticsSummary = { days: series, funnel, tiers };
      respond(true, out);
    },
  };
  return handlers;
}

function cleanMap<K extends string>(raw: unknown): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string" && /^\d{3,25}$/.test(v.trim())) out[k as K] = v.trim();
  }
  return out;
}
