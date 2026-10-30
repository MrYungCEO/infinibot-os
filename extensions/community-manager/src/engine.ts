/**
 * Community engine — the deterministic fast path (plan §6.4).
 *
 *   join      → member row, risk score, Unverified role, one welcome DM, raid counter
 *   Verify    → anti-raid gate → Verified role → intake questions (select menus)
 *   intake    → score + tier + offer → interest roles → lead → onboarder (round-robin)
 *               → hot leads get a private #onboarding-desk thread + an owner Telegram ping
 *   message   → scam / banned-claim / invite checks → delete, 1 h quarantine, ban queued
 *               for approval; trading channels get the disclaimer every N messages
 *   Get help  → ticket = private thread under #support
 *   campaigns → due posts; anything pinging @everyone waits for approval
 *
 * Modes: `setup` ignores events; `shadow` logs what it would do and touches
 * nothing; `live` acts. `paused` (kill switch) stops every autonomous action
 * in any mode. In `shadow`, `settings.liveModules` (e.g. ["greeting"]) lets
 * single modules act while everything else keeps logging only. Gated actions (ban, kick, timeout > 1 h, mass DM, @everyone)
 * only ever run after an approval resolves "approved".
 */

import type { DiscordCommunitySeam } from "infinibot/plugin-sdk";

import { ApprovalGate, needsApproval, pingsEveryone } from "./approval-gate.js";
import { assertCompliantOutbound, classifyMessage, withDisclaimer, type Finding } from "./compliance.js";
import type {
  ActivityKind,
  ChannelPurpose,
  IntakeQuestion,
  Lead,
  LiveModule,
  ModAction,
  ModActionKind,
  RolePurpose,
  RoutedOffer,
  Settings,
} from "./contract.js";
import { OFFER_LABELS } from "./contract.js";
import { HOT_LEAD_SLA_MS, MASS_DM_THRESHOLD, MAX_AUTONOMOUS_TIMEOUT_MS } from "./defaults.js";
import {
  GREETING_BATCH_PER_MINUTE,
  greetingButtons,
  greetingDm,
  greetingPost,
  isClosedDmError,
  LEGACY_DEFAULT_WELCOME_DM,
} from "./greeting.js";
import { buildCta, DEFAULT_ROUTE, intakeCompleteMessage, renderWelcomeDm, ROUTE_REASON_LABELS } from "./routing.js";
import { pickAssignee, scoreLead } from "./scoring.js";
import type { CommunityStore } from "./store.js";

export type DiscordPort = DiscordCommunitySeam["rest"];
export type CommunityEvent = Parameters<Parameters<DiscordCommunitySeam["onEvent"]>[0]>[0];
export type ComponentReply = { content: string; ephemeral?: boolean; components?: unknown[] };

export type AlertOwner = (alert: { title: string; body: string; severity?: "warning" | "critical"; link?: string }) => Promise<void>;

export type EngineDeps = {
  store: CommunityStore;
  rest: DiscordPort;
  gate: ApprovalGate;
  /** Current bot token for the community account (read from config each call; never logged). */
  token: () => string | null;
  alertOwner?: AlertOwner | null;
  log?: { info: (m: string) => void; warn: (m: string) => void };
  snowflakeToMs?: (id: string) => number | null;
  /** Pacing between DMs of an approved batch (ms range); tests pass [0, 0]. */
  dmPacingMs?: [number, number];
  /** How long a burst of joins is collected before the one combined greeting (ms); default 60 s. */
  greetBatchMs?: number;
};

const OFFER_CHECKLIST: Record<RoutedOffer, string[]> = {
  infinibot: ["Download InfiniBot (free)", "Install and open it", "Connect a model", "Create the first agent", "Point them at plugins on KinglyVault"],
  kinglyvault: ["Sign up on KinglyVault (free tier)", "Pick a first course (free or paid)", "Link Discord", "Confirm the KV Member role", "Show InfiniBot as the next step"],
  "kinglyvault-plugins": ["Sign up on KinglyVault", "Open the InfiniBot plugin store", "Install the plugin in InfiniBot", "Confirm it runs"],
  pulse: ["Read the risk disclosure", "Confirm 18+ and an allowed region", "Confirm a $100 funded broker account", "Join through KinglyVault", "Confirm the Pulse Member role"],
};

function defaultSnowflakeToMs(id: string): number | null {
  try {
    return Number(BigInt(id) >> 22n) + 1420070400000;
  } catch {
    return null;
  }
}

function parseCustomId(customId: string): { key: string; data: Record<string, string> } {
  const i = customId.indexOf(":");
  const key = i === -1 ? customId : customId.slice(0, i);
  const data: Record<string, string> = {};
  for (const pair of (i === -1 ? "" : customId.slice(i + 1)).split(";")) {
    if (!pair) continue;
    const [k, v] = pair.split("=", 2);
    if (k) data[k] = v ?? k;
  }
  return { key, data };
}

export function verifyPanelComponents(): unknown[] {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 3, label: "Verify", custom_id: "cm:a=verify" },
        { type: 2, style: 2, label: "Get help", custom_id: "cm:a=help" },
      ],
    },
  ];
}

export function questionComponents(q: IntakeQuestion): unknown[] {
  return [
    {
      type: 1,
      components: [
        {
          type: 3,
          custom_id: `cmsel:q=${q.id}`,
          placeholder: q.label.slice(0, 150),
          min_values: 1,
          max_values: 1,
          options: q.options.slice(0, 25).map((o) => ({ label: o.label.slice(0, 100), value: o.value.slice(0, 100) })),
        },
      ],
    },
  ];
}

export class CommunityEngine {
  private unsubscribers: Array<() => void> = [];
  private recentJoins: number[] = [];
  private lastRaidAlertAt = 0;
  private recentGreetings: number[] = [];
  private pendingGreetings: Array<{ id: string; username: string }> = [];
  private greetTimer: ReturnType<typeof setTimeout> | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  lastEventAt: number | null = null;

  constructor(private deps: EngineDeps) {}

  get store(): CommunityStore {
    return this.deps.store;
  }

  /** Subscribe to Discord events + approval decisions and start the campaign ticker. */
  start(subscribe: (fn: (ev: CommunityEvent) => Promise<ComponentReply | null>) => () => void, tickMs = 30_000): void {
    this.unsubscribers.push(subscribe((ev) => this.handleEvent(ev)));
    this.unsubscribers.push(
      this.deps.gate.onResolved((ref, approved, approvalId) => {
        void this.applyDecision(ref, approved, approvalId).catch((err) =>
          this.deps.log?.warn(`community: applying approval ${approvalId} failed: ${String(err)}`),
        );
      }),
    );
    if (tickMs > 0) {
      this.ticker = setInterval(() => void this.tick().catch(() => {}), tickMs);
      this.ticker.unref?.();
    }
  }

  stop(): void {
    for (const u of this.unsubscribers.splice(0)) u();
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    if (this.greetTimer) clearTimeout(this.greetTimer);
    this.greetTimer = null;
  }

  // ── plumbing ────────────────────────────────────────────────────────────

  private settings(): Settings {
    return this.deps.store.getSettings();
  }

  /** Discord REST options for the configured guild (null when no token/guild). */
  private opts(s: Settings): { botToken: string; guildId: string } | null {
    const token = this.deps.token();
    if (!token || !s.guildId) return null;
    return { botToken: token, guildId: s.guildId };
  }

  private activity(kind: ActivityKind, text: string, dry = false): void {
    this.deps.store.addActivity(kind, text, dry);
  }

  /**
   * Whether autonomous actions of `module` run right now, and why not. `live` runs
   * everything; in `shadow` only modules listed in `liveModules` act. Calls without a
   * module follow the global mode only.
   */
  private actState(s: Settings, module?: LiveModule): { act: boolean; why: "live" | "shadow" | "paused" | "setup" } {
    if (s.paused) return { act: false, why: "paused" };
    if (s.mode === "live") return { act: true, why: "live" };
    if (module && s.mode === "shadow" && (s.liveModules ?? []).includes(module)) return { act: true, why: "live" };
    return { act: false, why: s.mode };
  }

  /**
   * Run one Discord-side effect, or log what would have happened (shadow /
   * paused). Returns the effect's result, or null when it did not run.
   */
  private async perform<T>(
    s: Settings,
    kind: ActivityKind,
    label: string,
    fn: (o: { botToken: string; guildId: string }) => Promise<T>,
    module?: LiveModule,
    onError?: (err: unknown) => boolean,
  ): Promise<T | null> {
    const st = this.actState(s, module);
    if (!st.act) {
      this.activity(kind, `[${st.why}] would ${label}`, true);
      return null;
    }
    const o = this.opts(s);
    if (!o) {
      this.activity("system", `skipped ${label}: no bot token or server configured`, true);
      return null;
    }
    try {
      const out = await fn(o);
      this.activity(kind, label);
      return out;
    } catch (err) {
      // onError returning true = handled quietly (e.g. closed DMs).
      if (onError?.(err)) return null;
      this.activity("system", `failed to ${label}: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`);
      return null;
    }
  }

  private channel(s: Settings, purpose: ChannelPurpose): string | null {
    return s.channelMap[purpose] ?? null;
  }

  private role(s: Settings, purpose: RolePurpose): string | null {
    return s.roleMap[purpose] ?? null;
  }

  /**
   * Every bot post goes through here: banned claims are refused, trading
   * channels get the disclaimer footer, mentions stay off unless approved.
   */
  async post(
    s: Settings,
    channelId: string,
    content: string,
    opts: { components?: unknown[]; allowEveryone?: boolean; kind?: ActivityKind; label?: string; module?: LiveModule } = {},
  ): Promise<{ id: string } | null> {
    if (pingsEveryone(content) && !opts.allowEveryone) {
      throw new Error("@everyone/@here posts need an approval (use a campaign)");
    }
    const text = s.compliance.tradingChannelIds.includes(channelId)
      ? withDisclaimer(content, s.compliance.disclaimer)
      : content;
    assertCompliantOutbound(text, { extraClaims: s.moderation.extraBannedClaims, disclaimer: s.compliance.disclaimer });
    return this.perform(s, opts.kind ?? "system", opts.label ?? `post in <#${channelId}>`, (o) =>
      this.deps.rest.sendMessage(o, channelId, text, {
        components: opts.components,
        allowedMentions: opts.allowEveryone ? { parse: ["everyone", "roles", "users"] } : { parse: ["users"] },
      }),
      opts.module,
    );
  }

  // ── events ──────────────────────────────────────────────────────────────

  async handleEvent(ev: CommunityEvent): Promise<ComponentReply | null> {
    const s = this.settings();
    if (ev.accountId !== s.accountId) return null;
    if (ev.kind !== "component" && ev.guildId !== s.guildId) return null;
    if (ev.kind === "component" && ev.guildId && ev.guildId !== s.guildId) return null;
    if (s.mode === "setup" || !s.guildId) return null;
    this.lastEventAt = Date.now();
    switch (ev.kind) {
      case "member_add":
        await this.onJoin(s, ev.user, ev.joinedAt);
        return null;
      case "member_remove":
        this.deps.store.bumpMetric(s.guildId, "leaves");
        this.activity("leave", `leave <@${ev.userId}>`);
        return null;
      case "message":
        await this.onMessage(s, ev);
        return null;
      case "component":
        return this.onComponent(s, ev);
    }
  }

  private async onJoin(s: Settings, user: { id: string; username: string; avatar?: string | null; bot?: boolean }, joinedAt: string | null): Promise<void> {
    if (user.bot) return;
    const guildId = s.guildId!;
    const now = Date.now();
    const created = (this.deps.snowflakeToMs ?? defaultSnowflakeToMs)(user.id);
    const ageDays = created ? (now - created) / 86_400_000 : null;
    let risk = 0;
    if (ageDays !== null && ageDays < s.moderation.minAccountAgeDays) risk += 50;
    if (!user.avatar && ageDays !== null && ageDays < 30) risk += 20;
    const prev = this.deps.store.getMember(guildId, user.id);
    const member = this.deps.store.upsertMember(guildId, user.id, user.username, {
      joinedAt: joinedAt ? Date.parse(joinedAt) || now : now,
      accountCreatedAt: created,
      riskScore: risk,
    });
    this.deps.store.bumpMetric(guildId, "joins");
    this.activity("join", `join @${user.username}${risk ? ` (risk ${risk})` : ""}`);

    // Raid detection: too many joins inside 60 s → owner alert (once / 10 min).
    this.recentJoins = this.recentJoins.filter((t) => now - t < 60_000);
    this.recentJoins.push(now);
    if (this.recentJoins.length > s.moderation.raidJoinsPerMinute && now - this.lastRaidAlertAt > 600_000) {
      this.lastRaidAlertAt = now;
      this.activity("mod", `raid alert: ${this.recentJoins.length} joins in 60 s`);
      await this.deps.alertOwner?.({
        title: "Possible raid on the community server",
        body: `${this.recentJoins.length} joins in the last minute on ${s.guildName ?? "the server"}. Consider Lockdown in /community.`,
        severity: "critical",
        link: "/community",
      });
    }

    const unverified = this.role(s, "unverified");
    if (unverified) {
      await this.perform(s, "join", `give @${user.username} the Unverified role`, (o) =>
        this.deps.rest.assignRole(o, user.id, unverified, "Community Manager: new member"),
      "onboarding");
    }
    // One welcome (public post + DM) per member, ever (plan §7: no unsolicited DMs beyond this).
    if (!prev?.welcomedAt && !member.welcomedAt) {
      await this.greetPublic(s, user, now);
      let closed = false;
      const sent = await this.perform(
        s,
        "join",
        `send @${user.username} the welcome DM`,
        (o) => this.deps.rest.sendDM(o, user.id, this.welcomeDmText(s, user.username), { components: greetingButtons(s) }),
        "greeting",
        // Closed DMs (403 / 50007) are normal: skip silently, never retry.
        (err) => (closed = isClosedDmError(err)),
      );
      if (sent || closed || this.actState(s, "greeting").act === false) {
        this.deps.store.upsertMember(guildId, user.id, user.username, { welcomedAt: now });
      }
    }
  }

  /**
   * Welcome DM text. In full Live the owner's template is used (Verify + intake exist);
   * with only the greeting live (Shadow + liveModules) it is the built-in three steps,
   * because Verify and the onboarding questions are not running.
   */
  private welcomeDmText(s: Settings, name: string): string {
    const custom = s.mode === "live" && s.welcomeDm && s.welcomeDm !== LEGACY_DEFAULT_WELCOME_DM;
    const text = custom ? renderWelcomeDm(s.welcomeDm, name, s) : greetingDm(s, name);
    assertCompliantOutbound(text, { extraClaims: s.moderation.extraBannedClaims });
    return text;
  }

  /**
   * Public welcome in #welcome. Up to GREETING_BATCH_PER_MINUTE joins a minute get their
   * own post; past that, joins are collected and greeted in one combined post per window.
   */
  private async greetPublic(s: Settings, user: { id: string; username: string }, now: number): Promise<void> {
    const ch = this.channel(s, "welcome");
    if (!ch) return;
    this.recentGreetings = this.recentGreetings.filter((t) => now - t < 60_000);
    if (this.pendingGreetings.length === 0 && this.recentGreetings.length < GREETING_BATCH_PER_MINUTE) {
      this.recentGreetings.push(now);
      await this.sendGreeting(s, ch, [user]);
      return;
    }
    this.pendingGreetings.push(user);
    if (!this.greetTimer) {
      this.greetTimer = setTimeout(() => void this.flushGreetings().catch(() => {}), this.deps.greetBatchMs ?? 60_000);
      this.greetTimer.unref?.();
    }
  }

  /** Post the one combined greeting for a burst of joins (raid-safe). Returns members greeted. */
  async flushGreetings(): Promise<number> {
    if (this.greetTimer) clearTimeout(this.greetTimer);
    this.greetTimer = null;
    const batch = this.pendingGreetings.splice(0);
    if (!batch.length) return 0;
    const s = this.settings();
    const ch = this.channel(s, "welcome");
    if (!ch || s.mode === "setup") return 0;
    this.recentGreetings.push(Date.now());
    await this.sendGreeting(s, ch, batch);
    return batch.length;
  }

  private async sendGreeting(s: Settings, channelId: string, members: Array<{ id: string; username: string }>): Promise<void> {
    const p = greetingPost(s, members);
    assertCompliantOutbound(`${p.content}\n${p.embed.description}`, { extraClaims: s.moderation.extraBannedClaims });
    const who = members.length === 1 ? `@${members[0]!.username}` : `${members.length} new members`;
    await this.perform(
      s,
      "join",
      `greet ${who} in <#${channelId}>`,
      (o) => this.deps.rest.sendMessage(o, channelId, p.content, { embed: p.embed, components: p.components, allowedMentions: p.allowedMentions }),
      "greeting",
    );
  }

  private async onMessage(s: Settings, ev: Extract<CommunityEvent, { kind: "message" }>): Promise<void> {
    if (ev.author.bot) return;
    const guildId = s.guildId!;
    this.deps.store.bumpMetric(guildId, "messages");
    this.deps.store.markActive(guildId, ev.author.id);
    const staffChannels = new Set([this.channel(s, "staff"), this.channel(s, "mod-log")].filter(Boolean));
    const finding = classifyMessage(ev.content, {
      extraClaims: s.moderation.extraBannedClaims,
      extraDomains: s.moderation.extraScamDomains,
      blockInvites: s.moderation.blockInvites && !staffChannels.has(ev.channelId),
    });
    if (finding) {
      await this.moderateMessage(s, ev, finding);
      return;
    }
    if (s.compliance.tradingChannelIds.includes(ev.channelId)) {
      const n = this.deps.store.bumpChannelCounter(ev.channelId);
      if (n >= Math.max(1, s.compliance.repostEvery)) {
        this.deps.store.resetChannelCounter(ev.channelId);
        const st = this.actState(s, "disclaimer");
        if (!st.act) {
          this.activity("disclaimer", `[${st.why}] would re-post the risk disclaimer in <#${ev.channelId}>`, true);
        } else {
          const o = this.opts(s);
          if (o) {
            await this.deps.rest
              .sendMessage(o, ev.channelId, s.compliance.disclaimer, { allowedMentions: { parse: [] } })
              .then(() => this.activity("disclaimer", `re-posted the risk disclaimer in <#${ev.channelId}>`))
              .catch((err) => this.activity("system", `disclaimer post failed: ${String(err).slice(0, 160)}`));
          }
        }
      }
    }
  }

  private async moderateMessage(s: Settings, ev: Extract<CommunityEvent, { kind: "message" }>, finding: Finding): Promise<void> {
    const guildId = s.guildId!;
    const who = `@${ev.author.username}`;
    const evidence = ev.content.slice(0, 500);
    await this.perform(s, "mod", `delete a ${finding.kind.replace("_", " ")} message from ${who} (${finding.match})`, (o) =>
      this.deps.rest.deleteMessage(o, ev.channelId, ev.messageId, `Community Manager: ${finding.rule}`),
    "moderation");
    const st = this.actState(s, "moderation");
    const base = {
      actor: "agent",
      targetId: ev.author.id,
      targetName: ev.author.username,
      evidence,
      guildId,
      channelId: ev.channelId,
      messageId: ev.messageId,
    };
    this.deps.store.createModAction({
      ...base,
      action: "delete",
      rule: finding.rule,
      reason: `${finding.kind}: ${finding.match}`,
      status: st.act ? "done" : st.why === "paused" ? "paused" : "shadow",
      approvalId: null,
      durationMs: null,
    });
    const member = this.deps.store.getMember(guildId, ev.author.id);
    this.deps.store.upsertMember(guildId, ev.author.id, ev.author.username, { strikes: (member?.strikes ?? 0) + 1 });

    if (finding.kind === "scam") {
      // Scam: straight to a 1 h quarantine timeout + a ban queued for approval.
      await this.moderate(s, { action: "timeout", targetId: ev.author.id, targetName: ev.author.username, durationMs: MAX_AUTONOMOUS_TIMEOUT_MS, rule: finding.rule, reason: `Scam link/phrase: ${finding.match}`, evidence });
      await this.moderate(s, { action: "ban", targetId: ev.author.id, targetName: ev.author.username, durationMs: null, rule: finding.rule, reason: `Scam link/phrase: ${finding.match}`, evidence });
    } else if (finding.kind === "banned_claim") {
      const strikes = (member?.strikes ?? 0) + 1;
      if (strikes >= 3) {
        await this.moderate(s, { action: "timeout", targetId: ev.author.id, targetName: ev.author.username, durationMs: MAX_AUTONOMOUS_TIMEOUT_MS, rule: finding.rule, reason: `3rd banned claim: ${finding.match}`, evidence });
      } else {
        await this.perform(s, "mod", `warn ${who} by DM (banned claim)`, (o) =>
          this.deps.rest.sendDM(o, ev.author.id, `Heads up: your message was removed because it made a claim we don't allow here ("${finding.match}"). Repeat breaks lead to a timeout.`),
        "moderation");
      }
    }
    await this.modLog(s, finding.kind === "scam" ? "Scam removed" : "Message removed", ev.author, `${finding.rule}: ${finding.match}`);
  }

  /**
   * One moderation action through the gate: autonomous ones run (or are
   * logged in shadow/paused); gated ones become an approval request.
   */
  async moderate(
    s: Settings,
    input: { action: ModActionKind; targetId: string; targetName: string; durationMs: number | null; rule: string; reason: string; evidence?: string | null; actor?: string },
  ): Promise<ModAction> {
    const gated = needsApproval({ action: input.action, durationMs: input.durationMs });
    const st = this.actState(s, "moderation");
    const rec = this.deps.store.createModAction({
      actor: input.actor ?? "agent",
      targetId: input.targetId,
      targetName: input.targetName,
      action: input.action,
      rule: input.rule,
      reason: input.reason,
      evidence: input.evidence ?? null,
      status: gated ? "pending_approval" : st.act ? "done" : st.why === "paused" ? "paused" : "shadow",
      approvalId: null,
      durationMs: input.durationMs,
      guildId: s.guildId,
    });
    if (gated) {
      const approvalId = this.deps.gate.request({
        title: `${input.action === "ban" ? "Ban" : input.action === "kick" ? "Kick" : "Long timeout"} @${input.targetName}?`,
        summary: `${input.reason} (rule ${input.rule})`,
        details: input.evidence ? `Evidence: ${input.evidence}` : undefined,
        risk: input.action === "ban" ? "high" : "medium",
        ref: { kind: "mod", id: rec.id },
      });
      if (!approvalId) {
        this.deps.store.setModStatus(rec.id, "denied");
        this.activity("approval", `no approval system: ${input.action} @${input.targetName} was not run`);
        return { ...rec, status: "denied" };
      }
      this.deps.store.setModStatus(rec.id, "pending_approval", approvalId);
      this.activity("approval", `${input.action} @${input.targetName} waiting for approval`);
      return { ...rec, approvalId };
    }
    await this.perform(s, "mod", `${input.action} @${input.targetName}${input.durationMs ? ` for ${Math.round(input.durationMs / 60_000)} min` : ""}`, (o) =>
      this.execute(o, input.action, input.targetId, input.reason, input.durationMs),
    "moderation");
    return rec;
  }

  private async execute(o: { botToken: string; guildId: string }, action: ModActionKind, targetId: string, reason: string, durationMs: number | null): Promise<void> {
    const why = `Community Manager: ${reason}`.slice(0, 500);
    switch (action) {
      case "timeout":
        await this.deps.rest.timeoutMember(o, targetId, durationMs ?? MAX_AUTONOMOUS_TIMEOUT_MS, why);
        return;
      case "kick":
        await this.deps.rest.kickMember(o, targetId, why);
        return;
      case "ban":
        await this.deps.rest.banMember(o, targetId, why, 1);
        return;
      case "warn":
        await this.deps.rest.sendDM(o, targetId, `Warning from the moderators: ${reason}`);
        return;
      default:
        return;
    }
  }

  /** Apply a resolved approval to the plugin record it belongs to. */
  async applyDecision(ref: { kind: string; id: string }, approved: boolean, approvalId: string): Promise<void> {
    const s = this.settings();
    if (ref.kind === "mod") {
      const rec = this.deps.store.getModAction(ref.id);
      if (!rec || rec.status !== "pending_approval") return;
      if (!approved) {
        this.deps.store.setModStatus(rec.id, "denied");
        this.activity("approval", `denied: ${rec.action} @${rec.targetName ?? rec.targetId}`);
        return;
      }
      const st = this.actState(s, rec.action === "mass_dm" ? "campaigns" : "moderation");
      if (!st.act) {
        // Approved while paused / in shadow: record it, run nothing.
        this.deps.store.setModStatus(rec.id, st.why === "paused" ? "paused" : "shadow");
        this.activity("approval", `[${st.why}] approved ${rec.action} @${rec.targetName ?? ""} was not run`, true);
        return;
      }
      if (rec.action === "mass_dm") {
        await this.runMassDm(s, rec);
        return;
      }
      const o = this.opts(s);
      if (!o || !rec.targetId) {
        this.deps.store.setModStatus(rec.id, "failed");
        return;
      }
      try {
        await this.execute(o, rec.action, rec.targetId, rec.reason, rec.durationMs);
        this.deps.store.setModStatus(rec.id, "approved");
        this.activity("mod", `approved ${rec.action} @${rec.targetName ?? rec.targetId} done`);
        await this.modLog(s, `${rec.action} (approved)`, { id: rec.targetId, username: rec.targetName ?? rec.targetId }, rec.reason);
      } catch (err) {
        this.deps.store.setModStatus(rec.id, "failed");
        this.activity("system", `approved ${rec.action} failed: ${String(err).slice(0, 160)}`);
      }
      return;
    }
    if (ref.kind === "campaign") {
      const c = this.deps.store.getCampaign(ref.id);
      if (!c || c.status !== "pending_approval") return;
      if (!approved) {
        this.deps.store.setCampaignStatus(c.id, "denied");
        this.activity("campaign", `denied: "${c.title}"`);
        return;
      }
      await this.sendCampaign(s, c.id, true);
    }
  }

  private async modLog(s: Settings, action: string, target: { id: string; username: string }, reason: string): Promise<void> {
    const ch = this.channel(s, "mod-log");
    if (!ch || !this.actState(s, "moderation").act) return;
    const o = this.opts(s);
    if (!o) return;
    const embed = this.deps.rest.formatModLogEmbed(action, target, "Community Manager", reason);
    await this.deps.rest.sendMessage(o, ch, "", { ...embed, allowedMentions: { parse: [] } }).catch(() => {});
  }

  // ── components ──────────────────────────────────────────────────────────

  private async onComponent(s: Settings, ev: Extract<CommunityEvent, { kind: "component" }>): Promise<ComponentReply | null> {
    const { key, data } = parseCustomId(ev.customId);
    if (key !== "cm" && key !== "cmsel") return null;
    if (s.paused) {
      this.activity("system", `[paused] @${ev.user.username} pressed ${ev.customId}`, true);
      return { content: "The community assistant is paused right now. A moderator will help you shortly." };
    }
    if (key === "cm" && data.a === "verify") return this.onVerify(s, ev.user);
    if (key === "cm" && data.a === "help") return this.onHelp(s, ev.user);
    if (key === "cmsel" && data.q) return this.onAnswer(s, ev.user, data.q, ev.values[0] ?? "");
    if (key === "cm" && data.a === "claim" && data.l) return this.onClaim(s, ev.user, data.l);
    return null;
  }

  private async onVerify(s: Settings, user: { id: string; username: string }): Promise<ComponentReply> {
    const guildId = s.guildId!;
    const member = this.deps.store.getMember(guildId, user.id) ?? this.deps.store.upsertMember(guildId, user.id, user.username, {
      accountCreatedAt: (this.deps.snowflakeToMs ?? defaultSnowflakeToMs)(user.id),
    });
    const ageDays = member.accountCreatedAt ? (Date.now() - member.accountCreatedAt) / 86_400_000 : null;
    if (ageDays !== null && ageDays < s.moderation.minAccountAgeDays) {
      this.deps.store.upsertMember(guildId, user.id, user.username, { review: "new-account" });
      this.activity("verify", `@${user.username} held for manual review (account ${Math.floor(ageDays)} days old)`);
      return { content: "Thanks! New accounts are checked by a moderator first — you'll get access shortly." };
    }
    if (!member.verifiedAt) {
      this.deps.store.upsertMember(guildId, user.id, user.username, { verifiedAt: Date.now() });
      this.deps.store.bumpMetric(guildId, "verified");
      const verified = this.role(s, "verified");
      const unverified = this.role(s, "unverified");
      if (verified) {
        await this.perform(s, "verify", `verify @${user.username} (Verified role)`, (o) =>
          this.deps.rest.assignRole(o, user.id, verified, "Community Manager: verified"),
        "onboarding");
      } else {
        this.activity("verify", `verified @${user.username}`, this.actState(s, "onboarding").act === false);
      }
      if (unverified) {
        await this.perform(s, "verify", `remove Unverified from @${user.username}`, (o) =>
          this.deps.rest.removeRole(o, user.id, unverified, "Community Manager: verified"),
        "onboarding");
      }
    }
    const next = this.nextQuestion(s, user.id);
    if (!next) return { content: `You're verified — welcome in!\n${buildCta(DEFAULT_ROUTE.primaryOffer, DEFAULT_ROUTE.secondaryOffer, s)}` };
    return { content: `You're verified! A few quick questions so we can point you to the right place.\n**${next.label}**`, components: questionComponents(next) };
  }

  private nextQuestion(s: Settings, memberId: string): IntakeQuestion | null {
    const answers = this.deps.store.answers(s.guildId!, memberId);
    return s.questions.find((q) => !(q.id in answers)) ?? null;
  }

  private async onAnswer(s: Settings, user: { id: string; username: string }, questionId: string, value: string): Promise<ComponentReply> {
    const guildId = s.guildId!;
    const q = s.questions.find((x) => x.id === questionId);
    if (!q || !q.options.some((o) => o.value === value)) return { content: "That question has changed — press Verify again to continue." };
    const member = this.deps.store.getMember(guildId, user.id);
    if (!member?.verifiedAt) return { content: "Press **Verify** first." };
    this.deps.store.recordAnswer(guildId, user.id, questionId, value);
    const next = this.nextQuestion(s, user.id);
    if (next) return { content: `**${next.label}**`, components: questionComponents(next) };
    if (member.intakeDoneAt) return { content: "Thanks — your answers are updated." };
    const lead = await this.finishIntake(s, user);
    return { content: intakeCompleteMessage({ primaryOffer: lead.primaryOffer, cta: lead.cta }, lead.tier === "hot", OFFER_LABELS) };
  }

  /** Score → roles → lead → routing. Exposed for the wizard test run. */
  async finishIntake(s: Settings, user: { id: string; username: string }): Promise<Lead> {
    const guildId = s.guildId!;
    const answers = this.deps.store.answers(guildId, user.id);
    const result = scoreLead(s.questions, answers, s);
    const route = result.route;
    this.deps.store.upsertMember(guildId, user.id, user.username, { intakeDoneAt: Date.now() });
    this.activity("intake", `@${user.username} finished intake → ${OFFER_LABELS[route.primaryOffer]} + ${OFFER_LABELS[route.secondaryOffer]}, score ${result.score}`);
    for (const purpose of result.roles) {
      const roleId = this.role(s, purpose);
      if (!roleId) continue;
      await this.perform(s, "intake", `give @${user.username} the ${purpose} role`, (o) =>
        this.deps.rest.assignRole(o, user.id, roleId, "Community Manager: intake answer"),
      "onboarding");
    }
    const team = this.deps.store.listTeam();
    const load = this.deps.store.openLoad();
    const assignee =
      result.tier === "nurture"
        ? null
        : pickAssignee(team.map((t) => ({ ...t, openLeads: load.get(t.discordId) ?? 0 })), route.primaryOffer);
    const lead = this.deps.store.createLead({
      guildId,
      memberId: user.id,
      username: user.username,
      offer: route.primaryOffer,
      primaryOffer: route.primaryOffer,
      secondaryOffer: route.secondaryOffer,
      cta: route.cta,
      routeReason: route.reason,
      score: result.score,
      tier: result.tier,
      breakdown: result.breakdown,
      stage: "new",
      assigneeId: assignee?.discordId ?? null,
      assigneeName: assignee?.name ?? null,
      slaDueAt: result.tier === "hot" ? Date.now() + HOT_LEAD_SLA_MS : null,
      threadId: null,
    });
    this.deps.store.bumpMetric(guildId, "leads");
    if (assignee) this.deps.store.markAssigned(assignee.discordId);
    this.activity("lead", `lead @${user.username} · ${result.tier} ${result.score} · ${OFFER_LABELS[route.primaryOffer]}${assignee ? ` → ${assignee.name}` : ""}`);

    if (result.tier === "hot") {
      const desk = this.channel(s, "onboarding-desk");
      if (desk) {
        const thread = await this.perform(s, "lead", `open a private onboarding thread for @${user.username}`, (o) =>
          this.deps.rest.createPrivateThread(o, desk, `Lead · ${user.username} · ${OFFER_LABELS[route.primaryOffer]}`),
        "onboarding");
        if (thread) {
          this.deps.store.updateLead(lead.id, { threadId: thread.id }, "engine");
          lead.threadId = thread.id;
          const o = this.opts(s);
          if (o && assignee) await this.deps.rest.addThreadMember(o, thread.id, assignee.discordId).catch(() => {});
          const brief = [
            `**Hot lead** <@${user.id}> · score ${result.score} · ${OFFER_LABELS[route.primaryOffer]} (then ${OFFER_LABELS[route.secondaryOffer]})`,
            `Route: ${ROUTE_REASON_LABELS[route.reason]}`,
            `Member was told: ${route.cta.replace(/\n/g, " · ")}`,
            ...result.breakdown.map((b) => `• ${b.questionId}: ${b.answer}`),
            assignee ? `Assigned to <@${assignee.discordId}> — first contact within 15 min.` : "Nobody on shift covers this offer — claim it.",
            "",
            "**Access steps**",
            ...OFFER_CHECKLIST[route.primaryOffer].map((step) => `- [ ] ${step}`),
          ].join("\n");
          await this.post(s, thread.id, brief, {
            kind: "lead",
            module: "onboarding",
            label: `post the lead brief for @${user.username}`,
            components: [{ type: 1, components: [{ type: 2, style: 1, label: "Claim lead", custom_id: `cm:a=claim;l=${lead.id}` }] }],
          }).catch((err) => this.activity("system", `lead brief blocked: ${String(err).slice(0, 160)}`));
        }
      }
      if (this.actState(s, "onboarding").act) {
        await this.deps.alertOwner?.({
          title: `Hot lead: ${user.username}`,
          body: `Score ${result.score} · ${OFFER_LABELS[route.primaryOffer]}${assignee ? ` · assigned to ${assignee.name}` : " · unassigned"}`,
          link: "/community",
        }).catch(() => {});
      } else {
        this.activity("lead", `[${this.actState(s, "onboarding").why}] would ping the owner on Telegram about @${user.username}`, true);
      }
    }
    return this.deps.store.getLead(lead.id) ?? lead;
  }

  private async onHelp(s: Settings, user: { id: string; username: string }): Promise<ComponentReply> {
    const guildId = s.guildId!;
    const open = this.deps.store.openTicketFor(guildId, user.id);
    if (open) return { content: open.threadId ? `You already have a ticket open: <#${open.threadId}>` : "You already have a ticket open — staff will reply there." };
    const support = this.channel(s, "support");
    let threadId: string | null = null;
    if (support) {
      const thread = await this.perform(s, "ticket", `open a private ticket thread for @${user.username}`, (o) =>
        this.deps.rest.createPrivateThread(o, support, `Ticket · ${user.username}`),
      "tickets");
      if (thread) {
        threadId = thread.id;
        const o = this.opts(s);
        if (o) await this.deps.rest.addThreadMember(o, thread.id, user.id).catch(() => {});
        await this.post(s, thread.id, `Hi <@${user.id}>, tell us what you need help with. A staff member will reply here.`, { kind: "ticket", module: "tickets" }).catch(() => {});
      }
    }
    const ticket = this.deps.store.createTicket({ guildId, memberId: user.id, username: user.username, category: "general", threadId, state: "open" });
    this.activity("ticket", `ticket ${ticket.id} opened by @${user.username}`, threadId === null && !this.actState(s, "tickets").act);
    return { content: threadId ? `Ticket opened: <#${threadId}>` : "Thanks — your request is logged and staff will reach out." };
  }

  private async onClaim(s: Settings, user: { id: string; username: string }, leadId: string): Promise<ComponentReply> {
    const lead = this.deps.store.getLead(leadId);
    if (!lead) return { content: "That lead no longer exists." };
    const member = this.deps.store.listTeam().find((t) => t.discordId === user.id && t.active);
    if (!member) return { content: "Only team members can claim leads." };
    this.deps.store.updateLead(lead.id, { assigneeId: member.discordId, assigneeName: member.name, stage: lead.stage === "new" ? "contacted" : lead.stage }, user.username);
    this.activity("lead", `${member.name} claimed lead @${lead.username}`);
    return { content: `Claimed — @${lead.username} is yours.` };
  }

  // ── campaigns + mass DM ─────────────────────────────────────────────────

  async tick(now = Date.now()): Promise<void> {
    const s = this.settings();
    if (s.mode === "setup") return;
    for (const c of this.deps.store.dueCampaigns(now)) {
      if (c.pingsEveryone) {
        const approvalId = this.deps.gate.request({
          title: `Post "${c.title}" with @everyone?`,
          summary: c.content.slice(0, 300),
          risk: "medium",
          ref: { kind: "campaign", id: c.id },
        });
        this.deps.store.setCampaignStatus(c.id, approvalId ? "pending_approval" : "denied", approvalId);
        this.activity("approval", `"${c.title}" pings @everyone — waiting for approval`);
        continue;
      }
      await this.sendCampaign(s, c.id, false);
    }
  }

  private async sendCampaign(s: Settings, id: string, approved: boolean): Promise<void> {
    const c = this.deps.store.getCampaign(id);
    if (!c) return;
    const channelId = c.channelId ?? this.channel(s, "announcements");
    if (!channelId) {
      this.deps.store.setCampaignStatus(c.id, "failed");
      this.activity("campaign", `"${c.title}" has no channel`);
      return;
    }
    const st = this.actState(s, "campaigns");
    try {
      const sent = await this.post(s, channelId, c.content, { allowEveryone: approved && c.pingsEveryone, kind: "campaign", module: "campaigns", label: `post "${c.title}"` });
      this.deps.store.setCampaignStatus(c.id, sent ? "sent" : st.act ? "failed" : "shadow");
    } catch (err) {
      this.deps.store.setCampaignStatus(c.id, "failed");
      this.activity("campaign", `"${c.title}" blocked: ${String(err instanceof Error ? err.message : err).slice(0, 160)}`);
    }
  }

  /** DM a list of members; more than 25 recipients waits for approval. */
  async requestMassDm(s: Settings, recipients: string[], content: string): Promise<ModAction> {
    assertCompliantOutbound(content, { extraClaims: s.moderation.extraBannedClaims });
    const evidence = JSON.stringify({ recipients: recipients.slice(0, 200), content });
    if (recipients.length > MASS_DM_THRESHOLD) {
      const rec = this.deps.store.createModAction({ actor: "agent", targetId: null, targetName: `${recipients.length} members`, action: "mass_dm", rule: "mass-dm", reason: content.slice(0, 200), evidence, status: "pending_approval", approvalId: null, durationMs: null, guildId: s.guildId });
      const approvalId = this.deps.gate.request({ title: `DM ${recipients.length} members?`, summary: content.slice(0, 300), risk: "high", ref: { kind: "mod", id: rec.id } });
      this.deps.store.setModStatus(rec.id, approvalId ? "pending_approval" : "denied", approvalId);
      this.activity("approval", `DM to ${recipients.length} members waiting for approval`);
      return { ...rec, approvalId };
    }
    const rec = this.deps.store.createModAction({ actor: "agent", targetId: null, targetName: `${recipients.length} members`, action: "mass_dm", rule: "dm", reason: content.slice(0, 200), evidence, status: this.actState(s, "campaigns").act ? "done" : "shadow", approvalId: null, durationMs: null, guildId: s.guildId });
    await this.runMassDm(s, rec);
    return rec;
  }

  private async runMassDm(s: Settings, rec: ModAction): Promise<void> {
    let parsed: { recipients: string[]; content: string };
    try {
      parsed = JSON.parse(rec.evidence ?? "{}");
    } catch {
      return;
    }
    const [min, max] = this.deps.dmPacingMs ?? [3000, 6000];
    let failed = 0;
    let sent = 0;
    for (const id of (parsed.recipients ?? []).slice(0, 200)) {
      const ok = await this.perform(s, "campaign", `DM <@${id}>`, (o) => this.deps.rest.sendDM(o, id, parsed.content), "campaigns");
      if (ok) sent += 1;
      else if (this.actState(s, "campaigns").act) failed += 1;
      // Stop on a >2% failure rate (Discord 40003 "opening DMs too fast").
      if (sent + failed >= 10 && failed / (sent + failed) > 0.02) {
        this.activity("campaign", `DM batch stopped after ${failed} failures`);
        break;
      }
      if (max > 0) await new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));
    }
    if (rec.status === "pending_approval") this.deps.store.setModStatus(rec.id, "approved");
  }

  /** Post the Verify / Get help panel in #start-here (go-live). */
  async postVerifyPanel(s: Settings): Promise<boolean> {
    const ch = this.channel(s, "start-here");
    if (!ch) return false;
    const sent = await this.post(s, ch, "**Welcome!** Press **Verify** to unlock the server, or **Get help** to talk to staff.", {
      components: verifyPanelComponents(),
      kind: "system",
      module: "onboarding",
      label: "post the Verify panel in #start-here",
    });
    return sent !== null;
  }
}
