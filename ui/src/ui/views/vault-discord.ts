/**
 * Vault Discord View — Discord server control: roles, channels, permissions
 */

import { html, nothing } from "lit";
import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";
import { g8GlassStyles } from "./glass-g8.js";
import type { VaultState, DiscordGuild, DiscordRole, DiscordChannel } from "../controllers/vault";
import { loadDiscordGuild, sendAnnouncement } from "../controllers/vault";

// ── Module State ─────────────────────────────────────────────

let _lastLoaded: number | null = null;

// ── Styles ───────────────────────────────────────────────────

const S = {
  container: "display:flex;flex-direction:column;gap:1rem;",

  serverCard:
    "background:color-mix(in srgb,var(--vault-accent) 5%,var(--vault-panel));border:1px solid var(--vault-panel-border);border-radius:12px;padding:1.25rem;display:flex;align-items:center;gap:1rem;flex-wrap:wrap;",
  serverIcon:
    "width:64px;height:64px;border-radius:50%;border:3px solid var(--vault-accent);flex-shrink:0;object-fit:cover;",
  serverIconPlaceholder:
    "width:64px;height:64px;border-radius:50%;background:rgba(255,255,255,0.04);border:3px solid var(--vault-accent);display:flex;align-items:center;justify-content:center;font-size:1.8rem;flex-shrink:0;",
  serverInfo: "flex:1;min-width:180px;",
  serverName:
    "font-size:1.15rem;font-weight:700;color:var(--vault-text);font-family:var(--vault-mono);",
  serverStats:
    "display:flex;flex-wrap:wrap;gap:0.6rem;margin-top:0.35rem;font-size:0.76rem;color:var(--vault-text-dim);font-family:var(--vault-mono);",
  boostBadge:
    "display:inline-flex;align-items:center;gap:0.25rem;padding:0.12rem 0.45rem;background:rgba(163,113,255,0.14);color:#a371ff;border-radius:10px;font-size:0.68rem;font-weight:700;font-family:var(--vault-mono);border:1px solid rgba(163,113,255,0.28);",
  syncMeta:
    "font-size:0.68rem;color:var(--vault-text-dim);font-family:var(--vault-mono);margin-top:0.3rem;",

  grid2: "display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:1rem;",

  card: "background:var(--vault-panel);border:1px solid var(--vault-panel-border);border-radius:10px;padding:1rem;",
  cardHeader:
    "display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem;padding-bottom:0.5rem;border-bottom:1px solid var(--vault-panel-border);",
  cardTitle:
    "font-size:0.82rem;font-weight:600;color:var(--vault-accent);font-family:var(--vault-mono);",
  cardCount: "font-size:0.7rem;color:var(--vault-text-dim);font-family:var(--vault-mono);",
  cardBody: "max-height:320px;overflow-y:auto;",

  roleItem:
    "display:flex;justify-content:space-between;align-items:center;padding:0.42rem 0;border-bottom:1px solid rgba(255,255,255,0.04);",
  roleNameWrap:
    "display:flex;align-items:center;gap:0.45rem;font-size:0.83rem;color:var(--vault-text);font-family:var(--vault-mono);min-width:0;",
  roleMeta: "font-size:0.68rem;color:var(--vault-text-dim);font-family:var(--vault-mono);flex-shrink:0;",
  roleBotBadge:
    "font-size:0.58rem;color:var(--vault-text-dim);padding:0.08rem 0.28rem;border:1px solid var(--vault-panel-border);border-radius:3px;flex-shrink:0;",

  channelItem:
    "display:flex;align-items:center;gap:0.4rem;padding:0.32rem 0;padding-left:0.65rem;font-size:0.82rem;color:var(--vault-text);font-family:var(--vault-mono);",
  channelIcon:
    "color:var(--vault-text-dim);width:14px;text-align:center;flex-shrink:0;",
  channelTopic:
    "font-size:0.66rem;color:var(--vault-text-dim);margin-left:auto;max-width:90px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;",
  categoryItem:
    "padding:0.6rem 0;padding-top:0.8rem;font-size:0.68rem;color:var(--vault-text-dim);text-transform:uppercase;letter-spacing:0.07em;font-weight:700;font-family:var(--vault-mono);",

  activityFeed:
    "display:flex;flex-direction:column;gap:0;max-height:280px;overflow-y:auto;",
  activityItem:
    "display:flex;align-items:flex-start;gap:0.6rem;padding:0.5rem 0;border-bottom:1px solid rgba(255,255,255,0.04);",
  activityGlyph:
    "color:var(--vault-accent);font-family:var(--vault-mono);font-size:0.8rem;flex-shrink:0;margin-top:0.15rem;width:14px;text-align:center;",
  activityContent: "flex:1;min-width:0;",
  activityDesc:
    "font-size:0.81rem;color:var(--vault-text);font-family:var(--vault-mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;",
  activityTime:
    "font-size:0.68rem;color:var(--vault-text-dim);font-family:var(--vault-mono);margin-top:0.1rem;",

  primaryBtn:
    "background:var(--vault-accent);color:#000;border:none;border-radius:6px;padding:0.42rem 1rem;cursor:pointer;font-weight:700;font-size:0.8rem;font-family:var(--vault-mono);",
  secondaryBtn:
    "background:transparent;color:var(--vault-accent);border:1px solid var(--vault-panel-border);border-radius:6px;padding:0.38rem 0.8rem;cursor:pointer;font-size:0.79rem;font-family:var(--vault-mono);",

  empty:
    "color:var(--vault-text-dim);font-size:0.84rem;text-align:center;padding:2rem;font-family:var(--vault-mono);",
  notConnected:
    "background:rgba(239,68,68,0.04);border:1px solid rgba(239,68,68,0.18);border-radius:12px;padding:2.5rem;text-align:center;",

  input:
    "background:#050505;border:1px solid var(--vault-panel-border);border-radius:6px;padding:0.45rem 0.7rem;color:var(--vault-text);font-size:0.84rem;width:100%;box-sizing:border-box;font-family:var(--vault-mono);outline:none;",
  textarea:
    "background:#050505;border:1px solid var(--vault-panel-border);border-radius:6px;padding:0.5rem 0.7rem;color:var(--vault-text);font-size:0.84rem;width:100%;box-sizing:border-box;font-family:var(--vault-mono);min-height:100px;resize:vertical;outline:none;",
  select:
    "background:#050505;border:1px solid var(--vault-panel-border);border-radius:6px;padding:0.42rem 0.65rem;color:var(--vault-text);font-size:0.8rem;font-family:var(--vault-mono);outline:none;cursor:pointer;",
  label:
    "display:block;font-size:0.68rem;color:var(--vault-text-dim);margin-bottom:0.25rem;text-transform:uppercase;letter-spacing:0.05em;font-family:var(--vault-mono);",

  quickActions: "display:flex;gap:0.5rem;flex-wrap:wrap;",
  quickAction:
    "background:color-mix(in srgb,var(--vault-accent) 5%,var(--vault-panel));border:1px solid var(--vault-panel-border);border-radius:8px;padding:0.52rem 0.9rem;cursor:pointer;display:flex;align-items:center;gap:0.4rem;transition:border-color 0.15s;",
  quickActionLabel: "font-size:0.79rem;color:var(--vault-accent);font-family:var(--vault-mono);",
  quickActionDisabled:
    "font-size:0.79rem;color:var(--vault-text-dim);font-family:var(--vault-mono);",

  modalOverlay:
    "position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;z-index:1000;overflow:clip;",
  modal:
    "background:var(--vault-panel);border:1px solid var(--vault-panel-border);border-radius:12px;padding:1.5rem;max-width:500px;width:90%;overflow:clip;",
  modalHeader:
    "display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;",
  modalTitle:
    "font-size:1rem;font-weight:700;color:var(--vault-accent);font-family:var(--vault-mono);",
  modalClose:
    "background:none;border:none;color:var(--vault-text-dim);font-size:1.1rem;cursor:pointer;",
};

// ── Utility ──────────────────────────────────────────────────

function getChannelIcon(type: number): string {
  switch (type) {
    case 0:  return "#";
    case 2:  return "♪";
    case 4:  return "▸";
    case 5:  return "◉";
    case 13: return "⬡";
    case 15: return "☰";
    default: return "#";
  }
}

function getActivityGlyph(type: string): string {
  const map: Record<string, string> = {
    member_join: "→",
    member_leave: "←",
    course_complete: "✓",
    warning_issued: "⚠",
    role_change: "◎",
    payment: "$",
    message: "▸",
  };
  return map[type] ?? "·";
}

function timeAgo(dateStr: string): string {
  if (!dateStr) return "—";
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function sortRoles(roles: DiscordRole[]): DiscordRole[] {
  return [...roles].sort((a, b) => b.position - a.position);
}

function organizeChannels(channels: DiscordChannel[]): Map<string | null, DiscordChannel[]> {
  const map = new Map<string | null, DiscordChannel[]>();
  for (const ch of channels) {
    if (ch.type === 4) continue;
    const key = ch.parentId ?? null;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(ch);
  }
  for (const [, list] of map) {
    list.sort((a, b) => a.position - b.position);
  }
  return map;
}

// ── Server Info ──────────────────────────────────────────────

function renderServerInfo(
  guild: DiscordGuild,
  vs: VaultState,
  state: AppViewState,
  gw: GatewayBrowserClient
) {
  const iconUrl = guild.icon
    ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=128`
    : null;

  const voiceCount = guild.channels.filter((c) => c.type === 2).length;
  const textCount = guild.channels.filter((c) => c.type === 0).length;
  const boostTier = (guild as unknown as Record<string, unknown>)["premiumTier"] as
    | number
    | undefined;

  return html`
    <div style=${S.serverCard}>
      ${iconUrl
        ? html`<img src=${iconUrl} alt=${guild.name} style=${S.serverIcon} />`
        : html`<div style=${S.serverIconPlaceholder}>🏰</div>`}
      <div style=${S.serverInfo}>
        <div style=${S.serverName}>${guild.name}</div>
        <div style=${S.serverStats}>
          <span>👥 ${guild.memberCount.toLocaleString()}</span>
          <span>🏷 ${guild.roles.length} roles</span>
          <span># ${textCount} text</span>
          <span>♪ ${voiceCount} voice</span>
          <span>😀 ${guild.emojis.length}</span>
          ${boostTier != null && boostTier > 0
            ? html`<span style=${S.boostBadge}>⚡ Tier ${boostTier}</span>`
            : nothing}
        </div>
        ${_lastLoaded
          ? html`<div style=${S.syncMeta}>
              Synced ${timeAgo(new Date(_lastLoaded).toISOString())}
            </div>`
          : nothing}
      </div>
      <div style="display:flex;flex-direction:column;gap:0.4rem;flex-shrink:0;">
        <button
          style=${S.secondaryBtn}
          @click=${async () => {
            const newGuild = await loadDiscordGuild(gw);
            if (newGuild) {
              vs.discordGuild = newGuild;
              _lastLoaded = Date.now();
              state.requestUpdate?.();
            }
          }}
        >
          ↻ Refresh
        </button>
      </div>
    </div>

    <div style=${S.quickActions}>
      <div
        style=${S.quickAction}
        @click=${() => {
          vs.showAnnounceModal = true;
          vs.announceForm = { title: "", content: "", channelId: "" };
          state.requestUpdate?.();
        }}
      >
        <span>📢</span>
        <span style=${S.quickActionLabel}>Announcement</span>
      </div>
      <div
        style="${S.quickAction}cursor:not-allowed;opacity:0.55;"
        title="Server settings — backend endpoint pending"
      >
        <span>🔧</span>
        <span style=${S.quickActionDisabled}>Server Settings</span>
      </div>
      <div
        style="${S.quickAction}cursor:not-allowed;opacity:0.55;"
        title="Moderation panel — backend endpoint pending"
      >
        <span>🛡</span>
        <span style=${S.quickActionDisabled}>Moderation</span>
      </div>
    </div>
  `;
}

// ── Roles ────────────────────────────────────────────────────

function renderRoles(guild: DiscordGuild) {
  const roles = sortRoles(guild.roles).filter((r) => r.name !== "@everyone");

  return html`
    <div style=${S.card}>
      <div style=${S.cardHeader}>
        <span style=${S.cardTitle}>🏷 Roles</span>
        <span style=${S.cardCount}>${roles.length}</span>
      </div>
      <div style=${S.cardBody}>
        ${roles.length === 0
          ? html`<div style=${S.empty}>No roles</div>`
          : roles.map((r) => {
              const hex =
                r.color && r.color !== 0
                  ? `#${r.color.toString(16).padStart(6, "0")}`
                  : "#52525b";
              return html`
                <div style=${S.roleItem}>
                  <div style=${S.roleNameWrap}>
                    <span
                      style="width:11px;height:11px;border-radius:50%;background:${hex};flex-shrink:0;border:1px solid rgba(255,255,255,0.1);"
                    ></span>
                    <span
                      style="color:${r.color && r.color !== 0 ? hex : "var(--vault-text)"};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"
                    >${r.name}</span>
                    ${r.managed
                      ? html`<span style=${S.roleBotBadge}>BOT</span>`
                      : nothing}
                  </div>
                  <span style=${S.roleMeta}
                    >${r.memberCount != null ? r.memberCount : "?"}</span
                  >
                </div>
              `;
            })}
      </div>
    </div>
  `;
}

// ── Channels ─────────────────────────────────────────────────

function renderChannels(guild: DiscordGuild) {
  const categories = guild.channels
    .filter((c) => c.type === 4)
    .sort((a, b) => a.position - b.position);
  const channelMap = organizeChannels(guild.channels);
  const uncategorized = channelMap.get(null) ?? [];

  return html`
    <div style=${S.card}>
      <div style=${S.cardHeader}>
        <span style=${S.cardTitle}># Channels</span>
        <span style=${S.cardCount}>${guild.channels.filter((c) => c.type !== 4).length}</span>
      </div>
      <div style=${S.cardBody}>
        ${uncategorized.map(
          (c) => html`
            <div style=${S.channelItem}>
              <span style=${S.channelIcon}>${getChannelIcon(c.type)}</span>
              <span>${c.name}</span>
              ${c.topic
                ? html`<span style=${S.channelTopic} title=${c.topic}>${c.topic}</span>`
                : nothing}
            </div>
          `
        )}

        ${categories.map((cat) => {
          const inCat = channelMap.get(cat.id) ?? [];
          return html`
            <div style=${S.categoryItem}>${cat.name}</div>
            ${inCat.map(
              (c) => html`
                <div style=${S.channelItem}>
                  <span style=${S.channelIcon}>${getChannelIcon(c.type)}</span>
                  <span>${c.name}</span>
                  ${c.type === 0 && c.topic
                    ? html`<span style=${S.channelTopic} title=${c.topic}>${c.topic}</span>`
                    : nothing}
                </div>
              `
            )}
          `;
        })}
      </div>
    </div>
  `;
}

// ── Activity Feed ────────────────────────────────────────────

function renderActivityFeed(vs: VaultState) {
  const activities = vs.analytics?.recentActivity;
  if (!activities || activities.length === 0) return nothing;

  return html`
    <div style=${S.card}>
      <div style=${S.cardHeader}>
        <span style=${S.cardTitle}>▸ Recent Activity</span>
        <span style=${S.cardCount}>${activities.length}</span>
      </div>
      <div style=${S.activityFeed}>
        ${activities.slice(0, 15).map(
          (a) => html`
            <div style=${S.activityItem}>
              <span style=${S.activityGlyph}>${getActivityGlyph(a.type)}</span>
              <div style=${S.activityContent}>
                <div style=${S.activityDesc}>
                  ${a.memberName
                    ? html`<span style="color:var(--vault-accent);">${a.memberName}</span>
                        —
                      `
                    : nothing}${a.description}${a.channelName
                    ? html`
                        <span style="color:var(--vault-text-dim);"> #${a.channelName}</span>
                      `
                    : nothing}
                </div>
                <div style=${S.activityTime}>${timeAgo(a.timestamp)}</div>
              </div>
            </div>
          `
        )}
      </div>
    </div>
  `;
}

// ── Tier Role Mapping ────────────────────────────────────────

function renderTierRoles(vs: VaultState) {
  const config = vs.config;
  const guild = vs.discordGuild;
  if (!guild) return nothing;

  const tiers = ["free", "basic", "premium", "vip"];

  return html`
    <div style=${S.card}>
      <div style=${S.cardHeader}>
        <span style=${S.cardTitle}>👑 Tier Role Mapping</span>
      </div>
      <div style="display:flex;flex-direction:column;gap:0.5rem;">
        ${tiers.map(
          (tier) => html`
            <div
              style="display:flex;justify-content:space-between;align-items:center;padding:0.32rem 0;"
            >
              <span
                style="color:var(--vault-text);font-size:0.83rem;text-transform:capitalize;font-family:var(--vault-mono);"
                >${tier}</span
              >
              <select style="${S.select}width:auto;min-width:150px;">
                <option value="">Not mapped</option>
                ${guild.roles
                  .filter((r) => r.name !== "@everyone")
                  .map(
                    (r) =>
                      html`<option
                        value=${r.id}
                        ?selected=${config?.tierRoles?.[tier] === r.id}
                      >
                        ${r.name}
                      </option>`
                  )}
              </select>
            </div>
          `
        )}
      </div>
    </div>
  `;
}

// ── Emojis ───────────────────────────────────────────────────

function renderEmojis(guild: DiscordGuild) {
  return html`
    <div style=${S.card}>
      <div style=${S.cardHeader}>
        <span style=${S.cardTitle}>😀 Emojis</span>
        <span style=${S.cardCount}>${guild.emojis.length}</span>
      </div>
      <div
        style="display:flex;flex-wrap:wrap;gap:0.35rem;max-height:170px;overflow-y:auto;padding:0.25rem 0;"
      >
        ${guild.emojis.length === 0
          ? html`<div style=${S.empty}>No custom emojis</div>`
          : guild.emojis.slice(0, 50).map(
              (e) => html`
                <img
                  src="https://cdn.discordapp.com/emojis/${e.id}.${e.animated
                    ? "gif"
                    : "png"}?size=32"
                  alt=":${e.name}:"
                  title=":${e.name}:"
                  style="width:28px;height:28px;"
                />
              `
            )}
        ${guild.emojis.length > 50
          ? html`<span
              style="color:var(--vault-text-dim);font-size:0.7rem;align-self:center;font-family:var(--vault-mono);"
              >+${guild.emojis.length - 50} more</span
            >`
          : nothing}
      </div>
    </div>
  `;
}

// ── Announcement Modal ───────────────────────────────────────

function renderAnnounceModal(
  vs: VaultState,
  state: AppViewState,
  gw: GatewayBrowserClient
) {
  if (!vs.showAnnounceModal) return nothing;

  const guild = vs.discordGuild;
  const textChannels = guild
    ? guild.channels.filter((c) => c.type === 0 || c.type === 5)
    : [];

  return html`
    <div
      style=${S.modalOverlay}
      @click=${(e: Event) => {
        if (e.target === e.currentTarget) {
          vs.showAnnounceModal = false;
          state.requestUpdate?.();
        }
      }}
    >
      <div style=${S.modal}>
        <div style=${S.modalHeader}>
          <span style=${S.modalTitle}>📢 Send Announcement</span>
          <button
            style=${S.modalClose}
            @click=${() => {
              vs.showAnnounceModal = false;
              state.requestUpdate?.();
            }}
          >
            ✕
          </button>
        </div>

        <div style="margin-bottom:0.85rem;">
          <label style=${S.label}>Channel</label>
          <select
            style=${S.select}
            .value=${vs.announceForm.channelId}
            @change=${(e: Event) => {
              vs.announceForm.channelId = (e.target as HTMLSelectElement).value;
              state.requestUpdate?.();
            }}
          >
            <option value="">— Select channel —</option>
            ${textChannels.map(
              (c) => html`<option value=${c.id}># ${c.name}</option>`
            )}
          </select>
        </div>

        <div style="margin-bottom:0.85rem;">
          <label style=${S.label}>Message</label>
          <textarea
            style=${S.textarea}
            placeholder="Announcement text…"
            .value=${vs.announceForm.content}
            @input=${(e: Event) => {
              vs.announceForm.content = (e.target as HTMLTextAreaElement).value;
              state.requestUpdate?.();
            }}
          ></textarea>
        </div>

        <div style="display:flex;gap:0.5rem;justify-content:flex-end;">
          <button
            style=${S.secondaryBtn}
            @click=${() => {
              vs.showAnnounceModal = false;
              state.requestUpdate?.();
            }}
          >
            Cancel
          </button>
          <button
            style=${S.primaryBtn}
            ?disabled=${!vs.announceForm.channelId || !vs.announceForm.content}
            @click=${async () => {
              await sendAnnouncement(
                gw,
                vs.announceForm.channelId,
                vs.announceForm.content
              );
              vs.showAnnounceModal = false;
              vs.successMessage = "Announcement sent!";
              setTimeout(() => {
                vs.successMessage = null;
                state.requestUpdate?.();
              }, 3000);
              state.requestUpdate?.();
            }}
          >
            📢 Send
          </button>
        </div>
      </div>
    </div>
  `;
}

// ── Disconnected State ───────────────────────────────────────

function renderNotConnected(
  vs: VaultState,
  state: AppViewState,
  gw: GatewayBrowserClient
) {
  return html`
    <div style=${S.notConnected}>
      <div style="font-size:3rem;margin-bottom:1rem;">💬</div>
      <div
        style="color:var(--vault-text);font-size:1rem;font-weight:700;margin-bottom:0.5rem;font-family:var(--vault-mono);"
      >
        Discord Not Connected
      </div>
      <div
        style="color:var(--vault-text-dim);font-size:0.86rem;margin-bottom:1.5rem;font-family:var(--vault-mono);"
      >
        Connect your Discord server to manage roles, channels, and members.
      </div>
      <button
        style=${S.primaryBtn}
        @click=${async () => {
          const guild = await loadDiscordGuild(gw);
          if (guild) {
            vs.discordGuild = guild;
            _lastLoaded = Date.now();
            state.requestUpdate?.();
          }
        }}
      >
        ↻ Connect Discord
      </button>
    </div>
  `;
}

// ── Main Export ──────────────────────────────────────────────

export function renderVaultDiscord(
  vs: VaultState,
  state: AppViewState,
  gw: GatewayBrowserClient
) {
  const guild = vs.discordGuild;

  if (!guild && !vs.loading) {
    loadDiscordGuild(gw).then((g) => {
      if (g) {
        vs.discordGuild = g;
        _lastLoaded = Date.now();
        state.requestUpdate?.();
      }
    });
  }

  if (!guild) {
    return html`
      ${g8GlassStyles}
      <div class="g8-page vault-discord">${renderNotConnected(vs, state, gw)}${renderAnnounceModal(vs, state, gw)}</div>
    `;
  }

  return html`
    ${g8GlassStyles}
    <div class="g8-page vault-discord" style=${S.container}>
      ${renderServerInfo(guild, vs, state, gw)}

      <div style=${S.grid2}>
        ${renderRoles(guild)} ${renderChannels(guild)}
      </div>

      <div style=${S.grid2}>
        ${renderTierRoles(vs)} ${renderEmojis(guild)}
      </div>

      ${renderActivityFeed(vs)}
    </div>
    ${renderAnnounceModal(vs, state, gw)}
  `;
}
