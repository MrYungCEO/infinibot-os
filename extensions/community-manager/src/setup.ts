/**
 * Setup wizard backend (plan §4): token validation + intents, invite URL,
 * server picker, channel/role discovery, and the sandboxed test run.
 *
 * Token handling: a token only ever travels UI → `setup.validateToken` /
 * `setup.saveToken` → Discord. It is never returned, logged, or written
 * anywhere but `channels.discord.accounts.<id>.token` in the core config
 * (whose redaction already masks it in config.get). Error text from Discord
 * is passed through `redactToken` before it reaches a response.
 */

import { ApprovalGate, type ApprovalsLike } from "./approval-gate.js";
import {
  CHANNEL_PURPOSES,
  ROLE_PURPOSES,
  RUN_PERMISSIONS,
  SETUP_PERMISSIONS,
  type GuildDiscovery,
  type GuildSummary,
  type HealthCheck,
  type Offer,
  type Settings,
  type TestRunResult,
  type TestRunStep,
  type TokenValidation,
} from "./contract.js";
import { CommunityEngine, type DiscordPort } from "./engine.js";
import { CommunityStore } from "./store.js";

export const PERMISSION_NAMES: Record<number, string> = {
  0: "Create Invite",
  1: "Kick Members",
  2: "Ban Members",
  3: "Administrator",
  4: "Manage Channels",
  5: "Manage Server",
  6: "Add Reactions",
  7: "View Audit Log",
  10: "View Channels",
  11: "Send Messages",
  13: "Manage Messages",
  14: "Embed Links",
  15: "Attach Files",
  16: "Read Message History",
  17: "Mention Everyone",
  18: "Use External Emojis",
  28: "Manage Roles",
  33: "Manage Events",
  34: "Manage Threads",
  35: "Create Public Threads",
  36: "Create Private Threads",
  38: "Send Messages in Threads",
  40: "Moderate Members",
  44: "Create Events",
};

const ADMINISTRATOR = 1n << 3n;

/** Names of the permissions in `required` that `have` lacks (Administrator covers all). */
export function missingPermissions(have: string | bigint, required: string = RUN_PERMISSIONS): string[] {
  let h: bigint;
  let r: bigint;
  try {
    h = BigInt(have);
    r = BigInt(required);
  } catch {
    return ["(unreadable permission value)"];
  }
  if ((h & ADMINISTRATOR) === ADMINISTRATOR) return [];
  const out: string[] = [];
  for (let bit = 0; bit < 50; bit += 1) {
    const mask = 1n << BigInt(bit);
    if ((r & mask) === mask && (h & mask) !== mask) out.push(PERMISSION_NAMES[bit] ?? `bit ${bit}`);
  }
  return out;
}

/** Bot tokens are three dot-separated base64url parts. */
export function looksLikeBotToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}$/.test(token);
}

export function redactToken(text: string, token: string | null | undefined): string {
  let out = String(text ?? "");
  if (token && token.length > 8) out = out.split(token).join("[redacted]");
  // Anything shaped like a bot token, wherever it came from.
  return out.replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}/g, "[redacted]");
}

export function inviteUrl(applicationId: string, permissions = SETUP_PERMISSIONS): string {
  const q = new URLSearchParams({ client_id: applicationId, scope: "bot applications.commands", permissions });
  return `https://discord.com/oauth2/authorize?${q.toString().replace(/%20/g, "+")}`;
}

type IntentsFromFlags = (flags: number) => { guildMembers: string; messageContent: string; presence: string };

export async function validateToken(
  rawToken: string,
  deps: { rest: DiscordPort; normalize: (t: string) => string | undefined; intentsFromFlags: IntentsFromFlags },
): Promise<TokenValidation> {
  const token = deps.normalize(rawToken ?? "") ?? "";
  const checks: HealthCheck[] = [];
  if (!token) {
    return { ok: false, error: "Paste the bot token from the Developer Portal (Bot → Reset Token).", checks: [{ id: "format", label: "Token format", state: "fail", detail: "Empty" }] };
  }
  if (!looksLikeBotToken(token)) {
    return {
      ok: false,
      error: "That doesn't look like a bot token (three parts separated by dots).",
      checks: [{ id: "format", label: "Token format", state: "fail", detail: "Expected xxxxx.yyyy.zzzzz" }],
    };
  }
  checks.push({ id: "format", label: "Token format", state: "ok", detail: "Looks like a bot token" });
  let me: Awaited<ReturnType<DiscordPort["getCurrentUser"]>>;
  try {
    me = await deps.rest.getCurrentUser(token);
  } catch (err) {
    const msg = redactToken(err instanceof Error ? err.message : String(err), token);
    const unauthorized = /\b401\b/.test(msg);
    checks.push({ id: "identity", label: "Discord accepts the token", state: "fail", detail: unauthorized ? "Discord rejected the token (401)" : msg.slice(0, 160) });
    return { ok: false, error: unauthorized ? "Discord rejected this token. Reset it in the Developer Portal and paste the new one." : `Could not reach Discord: ${msg.slice(0, 160)}`, checks };
  }
  checks.push({ id: "identity", label: "Discord accepts the token", state: "ok", detail: `Signed in as ${me.username}` });
  const bot = {
    id: me.id,
    username: me.username,
    globalName: me.globalName,
    avatarUrl: me.avatar ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=128` : null,
  };
  let app: Awaited<ReturnType<DiscordPort["getCurrentApplication"]>> | null = null;
  try {
    app = await deps.rest.getCurrentApplication(token);
  } catch (err) {
    checks.push({ id: "application", label: "Application flags", state: "fail", detail: redactToken(String(err instanceof Error ? err.message : err), token).slice(0, 160) });
  }
  if (!app) return { ok: false, error: "Could not read the application (needed for intents and the invite link).", bot, checks };
  const intents = deps.intentsFromFlags(app.flags);
  const on = (v: string) => v === "enabled" || v === "limited";
  checks.push({
    id: "intent-members",
    label: "Server Members intent",
    state: on(intents.guildMembers) ? "ok" : "fail",
    detail: on(intents.guildMembers) ? `On (${intents.guildMembers})` : "Off — turn on Bot → Privileged Gateway Intents → Server Members",
  });
  checks.push({
    id: "intent-content",
    label: "Message Content intent",
    state: on(intents.messageContent) ? "ok" : "fail",
    detail: on(intents.messageContent) ? `On (${intents.messageContent})` : "Off — turn on Bot → Privileged Gateway Intents → Message Content",
  });
  checks.push({
    id: "intent-presence",
    label: "Presence intent",
    state: on(intents.presence) ? "warn" : "ok",
    detail: on(intents.presence) ? "On but not needed — you can turn it off" : "Not needed",
  });
  checks.push({
    id: "public-bot",
    label: "Public Bot",
    state: app.botPublic ? "warn" : "ok",
    detail: app.botPublic ? "On — anyone with the link can add it. Turn Public Bot off." : "Off (only you can invite it)",
  });
  const ok = on(intents.guildMembers) && on(intents.messageContent);
  return {
    ok,
    ...(ok ? {} : { error: "Turn on the Server Members and Message Content intents, then check again." }),
    bot,
    application: { id: app.id, name: app.name, flags: app.flags, botPublic: app.botPublic, intents },
    inviteUrl: inviteUrl(app.id),
    checks,
  };
}

export async function listGuilds(token: string, rest: DiscordPort): Promise<GuildSummary[]> {
  const guilds = await rest.listBotGuilds(token);
  return guilds.map((g) => ({
    id: g.id,
    name: g.name,
    iconUrl: g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=64` : null,
    memberCount: g.memberCount,
    admin: (BigInt(g.permissions || "0") & ADMINISTRATOR) === ADMINISTRATOR,
    missingPermissions: missingPermissions(g.permissions),
  }));
}

export async function discoverGuild(token: string, guildId: string, botUserId: string, rest: DiscordPort): Promise<GuildDiscovery> {
  const o = { botToken: token, guildId };
  const [channels, roles, botMember] = await Promise.all([
    rest.listChannels(o),
    rest.listRoles(o),
    rest.getMember(o, botUserId).catch(() => null),
  ]);
  const byId = new Map(roles.map((r) => [r.id, r]));
  const botRolePosition = botMember
    ? Math.max(0, ...botMember.roles.map((id) => byId.get(id)?.position ?? 0))
    : null;
  const checks: HealthCheck[] = [];
  checks.push({
    id: "bot-member",
    label: "Bot is in the server",
    state: botMember ? "ok" : "fail",
    detail: botMember ? "Found the bot's member record" : "The bot isn't a member of this server",
  });
  const assignable = roles.filter((r) => !r.managed && r.name !== "@everyone");
  const above = botRolePosition === null ? [] : assignable.filter((r) => r.position >= botRolePosition);
  checks.push({
    id: "role-position",
    label: "Bot role position",
    state: botRolePosition === null ? "fail" : above.length ? "warn" : "ok",
    detail:
      botRolePosition === null
        ? "Unknown"
        : above.length
          ? `${above.length} role(s) sit above the bot (it can't assign them): ${above.slice(0, 5).map((r) => r.name).join(", ")}`
          : "The bot role is above every role it assigns",
  });
  return {
    guildId,
    channels: channels.map((c) => ({ id: c.id, name: c.name, type: c.type, parentId: c.parentId ?? null })),
    roles: roles
      .filter((r) => r.name !== "@everyone")
      .sort((a, b) => b.position - a.position)
      .map((r) => ({ id: r.id, name: r.name, position: r.position, managed: Boolean(r.managed), aboveBot: botRolePosition !== null && r.position >= botRolePosition })),
    botRolePosition,
    checks,
  };
}

/** Wizard step 4: every required purpose mapped. */
export function mappingIssues(s: Pick<Settings, "channelMap" | "roleMap">): string[] {
  const out: string[] = [];
  for (const p of CHANNEL_PURPOSES) if (p.required && !s.channelMap[p.id]) out.push(`Map a channel for "${p.label}".`);
  for (const r of ROLE_PURPOSES) if (r.required && !s.roleMap[r.id]) out.push(`Map a role for "${r.label}".`);
  return out;
}

// ── Test run (wizard step 9) ───────────────────────────────────────────────

type Call = { fn: string; args: unknown[] };

/** A recording fake of the Discord port: nothing leaves the process. */
export function sandboxRest(): { rest: DiscordPort; calls: Call[] } {
  const calls: Call[] = [];
  let n = 0;
  const rec = (fn: string) => async (...args: unknown[]) => {
    calls.push({ fn, args: args.slice(1) });
    n += 1;
    if (fn === "createPrivateThread") return { id: `sandbox-thread-${n}`, name: String(args[2] ?? "") };
    if (fn === "sendMessage" || fn === "sendDM") return { id: `sandbox-msg-${n}`, channelId: String(args[1] ?? "") };
    return undefined;
  };
  const rest = new Proxy({} as DiscordPort, {
    get: (_t, prop: string) =>
      prop === "formatModLogEmbed"
        ? (action: string) => ({ embed: { title: action } })
        : rec(prop),
  });
  return { rest, calls };
}

export function sandboxApprovals(): ApprovalsLike & { created: Array<{ id: string; title: string }> } {
  const created: Array<{ id: string; title: string }> = [];
  return {
    created,
    create(input) {
      const id = `sandbox-approval-${created.length + 1}`;
      created.push({ id, title: input.title });
      return { id, status: "pending" };
    },
    get: (id) => ({ id, status: "pending" }),
    onEvent: () => () => {},
  };
}

/**
 * Walk the whole pipeline against an in-memory store and a recording fake
 * Discord: join → verify → intake → lead → onboarder thread → scam message →
 * ban approval → Pulse disclaimer → ticket → @everyone gate → pause.
 * Uses the real settings (questions, mapping, presets) but never calls Discord.
 */
export async function runTestRun(settings: Settings, team: Array<{ discordId: string; name: string; role: "onboarder" | "moderator" | "manager"; offers: Offer[]; active: boolean }>): Promise<TestRunResult> {
  const steps: TestRunStep[] = [];
  const step = (id: string, label: string, ok: boolean, detail: string) => steps.push({ id, label, ok, detail });
  const guildId = settings.guildId ?? "sandbox-guild";
  const store = new CommunityStore(":memory:");
  try {
    const trading = settings.compliance.tradingChannelIds[0] ?? "sandbox-trading";
    store.saveSettings({
      ...settings,
      guildId,
      mode: "live",
      paused: false,
      compliance: { ...settings.compliance, tradingChannelIds: [...new Set([...settings.compliance.tradingChannelIds, trading])], repostEvery: 2 },
      channelMap: { "start-here": "sb-start", support: "sb-support", "onboarding-desk": "sb-desk", "mod-log": "sb-modlog", announcements: "sb-ann", ...settings.channelMap },
    }, "test-run");
    store.saveTeam(team.length ? team : [{ discordId: "sandbox-onboarder", name: "Sandbox onboarder", role: "onboarder", offers: [], active: true }]);
    const { rest, calls } = sandboxRest();
    const approvals = sandboxApprovals();
    const alerts: string[] = [];
    const engine = new CommunityEngine({
      store,
      rest,
      gate: new ApprovalGate(approvals),
      token: () => "sandbox-token",
      alertOwner: async (a) => {
        alerts.push(a.title);
      },
      // An old account so the anti-raid gate lets it through.
      snowflakeToMs: () => Date.now() - 400 * 86_400_000,
      dmPacingMs: [0, 0],
    });
    const s = store.getSettings();
    const user = { id: "100000000000000001", username: "sandbox-member", avatar: "x" };
    const base = { accountId: s.accountId, guildId };

    await engine.handleEvent({ kind: "member_add", ...base, user, joinedAt: new Date().toISOString() });
    const dm = calls.find((c) => c.fn === "sendDM");
    step("welcome", "Welcome DM on join", Boolean(dm), dm ? "Welcome DM queued for the new member" : "No welcome DM was sent");

    const verify = await engine.handleEvent({ kind: "component", ...base, channelId: "sb-start", user, customId: "cm:a=verify", values: [] });
    const verifiedRole = s.roleMap.verified;
    const gotRole = verifiedRole ? calls.some((c) => c.fn === "assignRole" && c.args[1] === verifiedRole) : true;
    step("verify", "Verify → Verified role", Boolean(verify?.components?.length) && gotRole, verify ? `Reply: ${verify.content.split("\n")[0]}` : "No reply");

    // Answer every question with its highest-scoring option → a hot lead,
    // steering the offer to one the roster covers so routing is exercised.
    const covered = store.listTeam().find((t) => t.active && t.offers.length)?.offers[0];
    let lastReply = verify;
    for (const q of s.questions) {
      const steer = covered ? q.options.find((o) => o.offer === covered) : undefined;
      const best = steer ?? [...q.options].sort((a, b) => b.points - a.points)[0];
      lastReply = await engine.handleEvent({ kind: "component", ...base, channelId: "sb-start", user, customId: `cmsel:q=${q.id}`, values: [best?.value ?? ""] });
    }
    const lead = store.listLeads({ guildId })[0];
    step("intake", "Intake questionnaire", Boolean(lead), lastReply?.content ?? "No reply");
    step(
      "lead",
      "Lead scored and routed (primary + secondary offer + CTA)",
      Boolean(lead && lead.score > 0 && lead.assigneeId && lead.primaryOffer && lead.secondaryOffer && lead.cta),
      lead ? `Score ${lead.score} (${lead.tier}) · ${lead.primaryOffer} + ${lead.secondaryOffer} · ${lead.assigneeName ?? "unassigned"}` : "No lead",
    );
    const thread = calls.find((c) => c.fn === "createPrivateThread" && c.args[0] === (s.channelMap["onboarding-desk"] ?? "sb-desk"));
    step("onboarder-thread", "Private onboarder thread + owner ping", Boolean(thread) && alerts.length > 0, thread ? `Thread opened, ${alerts.length} owner alert(s)` : "No onboarding thread (hot leads need #onboarding-desk)");

    const before = calls.length;
    await engine.handleEvent({ kind: "message", ...base, channelId: "sb-general", messageId: "m1", author: { id: "100000000000000002", username: "scammer" }, content: "free nitro here https://discord-nitro.gift/abc" });
    const scamCalls = calls.slice(before).map((c) => c.fn);
    const banned = scamCalls.includes("banMember");
    step("scam", "Scam deleted + 1 h quarantine", scamCalls.includes("deleteMessage") && scamCalls.includes("timeoutMember"), `Actions: ${scamCalls.join(", ") || "none"}`);
    step("ban-approval", "Ban waits for approval", !banned && approvals.created.some((a) => /^Ban /.test(a.title)), banned ? "A ban ran without approval" : `${approvals.created.length} approval request(s) filed`);

    await engine.handleEvent({ kind: "message", ...base, channelId: trading, messageId: "m2", author: { id: "100000000000000003", username: "trader" }, content: "this setup gives guaranteed profit" });
    const claimDeleted = calls.some((c) => c.fn === "deleteMessage" && c.args[0] === trading);
    step("claims", "Banned claim removed", claimDeleted, claimDeleted ? "\"guaranteed profit\" was deleted" : "Not caught");
    const posted = await engine.post(store.getSettings(), trading, "Market recap is up.");
    const lastMsg = calls.filter((c) => c.fn === "sendMessage").pop();
    step("disclaimer", "Pulse disclaimer footer", Boolean(posted) && String(lastMsg?.args[1] ?? "").includes(s.compliance.disclaimer.slice(0, 30)), "Bot message in a trading channel carries the disclaimer");

    const help = await engine.handleEvent({ kind: "component", ...base, channelId: "sb-start", user, customId: "cm:a=help", values: [] });
    step("ticket", "Get help → ticket thread", store.listTickets({ open: true }).length === 1, help?.content ?? "No reply");

    let everyoneBlocked = false;
    try {
      await engine.post(store.getSettings(), "sb-ann", "@everyone big news");
    } catch {
      everyoneBlocked = true;
    }
    store.createCampaign({ title: "Test announcement", content: "@everyone test", channelId: "sb-ann", scheduleAt: Date.now() - 1000, status: "scheduled", pingsEveryone: true });
    await engine.tick();
    const campaignGated = store.listCampaigns().some((c) => c.status === "pending_approval");
    step("everyone", "@everyone needs approval", everyoneBlocked && campaignGated, everyoneBlocked && campaignGated ? "Direct @everyone refused; campaign queued for approval" : "An @everyone post was not gated");

    store.saveSettings({ paused: true }, "test-run");
    const pausedBefore = calls.length;
    await engine.handleEvent({ kind: "member_add", ...base, user: { id: "100000000000000004", username: "late-joiner", avatar: "y" }, joinedAt: null });
    await engine.handleEvent({ kind: "message", ...base, channelId: "sb-general", messageId: "m3", author: { id: "100000000000000005", username: "spam" }, content: "https://discord-nitro.gift/x" });
    step("pause", "Pause stops every action", calls.length === pausedBefore, calls.length === pausedBefore ? "No Discord calls while paused" : `${calls.length - pausedBefore} call(s) while paused`);
  } catch (err) {
    step("error", "Test run crashed", false, String(err instanceof Error ? err.message : err).slice(0, 200));
  } finally {
    store.close();
  }
  return { ok: steps.every((x) => x.ok), at: Date.now(), steps };
}
