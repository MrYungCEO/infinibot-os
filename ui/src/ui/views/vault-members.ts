/**
 * Vault Members View — Member list, search, filters, profile management
 */

import { html, nothing } from "lit";
import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";
import { g8GlassStyles } from "./glass-g8.js";
import type { VaultState, VaultMember, MemberFilters } from "../controllers/vault";
import {
  loadMembers,
  updateMember,
  warnMember,
  kickMember,
  banMember,
  clearWarnings,
  sendDirectMessage,
} from "../controllers/vault";

// ── Module State ─────────────────────────────────────────────

let _viewMode: "grid" | "list" = "grid";
let _selectedIds: Set<string> = new Set();
let _searchTimer: ReturnType<typeof setTimeout> | null = null;

// ── Styles ───────────────────────────────────────────────────

const S = {
  container: "display:flex;flex-direction:column;gap:1rem;",
  header:
    "display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:0.75rem;",
  searchBar: "display:flex;gap:0.5rem;flex:1;min-width:260px;",
  filters: "display:flex;gap:0.5rem;flex-wrap:wrap;align-items:center;",

  memberGrid:
    "display:grid;grid-template-columns:repeat(auto-fill,minmax(clamp(240px,30%,320px),1fr));gap:0.75rem;",
  memberList: "display:flex;flex-direction:column;gap:0.4rem;",

  memberCard: (sel: boolean) =>
    `background:var(--vault-panel);border:1px solid ${sel ? "var(--vault-accent)" : "var(--vault-panel-border)"};border-radius:10px;padding:1rem;cursor:pointer;transition:border-color 0.15s;${sel ? "background:color-mix(in srgb,var(--vault-accent) 8%,var(--vault-panel));" : ""}`,
  memberHeader: "display:flex;align-items:center;gap:0.75rem;margin-bottom:0.6rem;",
  memberInfo: "flex:1;min-width:0;",
  memberName:
    "font-weight:600;color:var(--vault-text);font-size:0.93rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:var(--vault-mono);",
  memberMeta:
    "display:flex;flex-wrap:wrap;gap:0.3rem;margin-top:0.25rem;align-items:center;",
  memberStats:
    "display:flex;gap:0.75rem;margin-top:0.5rem;font-size:0.74rem;color:var(--vault-text-dim);font-family:var(--vault-mono);",

  listRow: (sel: boolean) =>
    `display:flex;align-items:center;gap:0.75rem;padding:0.55rem 0.85rem;border-radius:8px;cursor:pointer;border:1px solid ${sel ? "var(--vault-accent)" : "transparent"};background:${sel ? "color-mix(in srgb,var(--vault-accent) 6%,var(--vault-panel))" : "var(--vault-panel)"};transition:border-color 0.15s;`,
  listName:
    "flex:1;min-width:0;font-size:0.86rem;color:var(--vault-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:var(--vault-mono);",
  listMeta: "display:flex;gap:0.4rem;align-items:center;flex-shrink:0;",
  listTime:
    "font-size:0.7rem;color:var(--vault-text-dim);font-family:var(--vault-mono);white-space:nowrap;",

  avatarImg: (size: number) =>
    `width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;border:2px solid var(--vault-panel-border);flex-shrink:0;`,
  avatarInitials: (size: number, bg: string) =>
    `width:${size}px;height:${size}px;border-radius:50%;background:${bg};border:2px solid var(--vault-panel-border);display:flex;align-items:center;justify-content:center;font-size:${Math.floor(size * 0.34)}px;font-weight:700;color:#fff;flex-shrink:0;font-family:var(--vault-mono);letter-spacing:-0.02em;`,

  onlineDot: (online: boolean) =>
    `width:9px;height:9px;border-radius:50%;background:${online ? "#22c55e" : "var(--vault-text-dim)"};border:2px solid var(--vault-panel);flex-shrink:0;`,

  bulkBar:
    "display:flex;align-items:center;gap:0.6rem;padding:0.6rem 1rem;background:color-mix(in srgb,var(--vault-accent) 8%,var(--vault-panel));border:1px solid var(--vault-accent);border-radius:8px;flex-wrap:wrap;",
  bulkCount:
    "font-size:0.8rem;color:var(--vault-accent);font-weight:700;flex:1;font-family:var(--vault-mono);",

  statusBadge: (status: string) => {
    const map: Record<string, [string, string]> = {
      active: ["#22c55e", "rgba(34,197,94,0.12)"],
      inactive: ["var(--vault-text-dim)", "rgba(0,0,0,0.3)"],
      warned: ["#f59e0b", "rgba(245,158,11,0.12)"],
      suspended: ["#ef4444", "rgba(239,68,68,0.12)"],
      banned: ["#dc2626", "rgba(220,38,38,0.12)"],
    };
    const [color, bg] = map[status] ?? ["var(--vault-text-dim)", "rgba(0,0,0,0.3)"];
    return `display:inline-block;background:${bg};color:${color};font-size:0.6rem;padding:0.1rem 0.35rem;border-radius:4px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;font-family:var(--vault-mono);border:1px solid ${color}30;`;
  },
  tierBadge:
    "background:color-mix(in srgb,var(--vault-accent) 18%,transparent);color:var(--vault-accent);font-size:0.6rem;padding:0.1rem 0.4rem;border-radius:4px;font-weight:700;font-family:var(--vault-mono);border:1px solid var(--vault-panel-border);",
  roleBadge:
    "background:rgba(255,255,255,0.04);color:var(--vault-text-dim);font-size:0.6rem;padding:0.1rem 0.35rem;border-radius:4px;font-family:var(--vault-mono);border:1px solid rgba(255,255,255,0.06);",

  profileModal:
    "background:var(--vault-panel);border:1px solid var(--vault-panel-border);border-radius:12px;padding:0;max-width:580px;width:95%;max-height:88vh;overflow:hidden;display:flex;flex-direction:column;",
  profileHeader:
    "background:linear-gradient(135deg,color-mix(in srgb,var(--vault-accent) 20%,transparent) 0%,transparent 100%);padding:1.4rem;border-bottom:1px solid var(--vault-panel-border);position:relative;",
  profileHeaderContent: "display:flex;align-items:center;gap:1rem;",
  profileName:
    "font-size:1.15rem;font-weight:700;color:var(--vault-text);font-family:var(--vault-mono);",
  profileBody: "padding:1.2rem;overflow-y:auto;flex:1;",
  profileSection: "margin-bottom:1.2rem;",
  profileSectionTitle:
    "font-size:0.68rem;color:var(--vault-text-dim);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:0.45rem;border-bottom:1px solid var(--vault-panel-border);padding-bottom:0.3rem;font-family:var(--vault-mono);",
  profileRow: "display:flex;justify-content:space-between;padding:0.28rem 0;font-size:0.83rem;",
  profileLabel: "color:var(--vault-text-dim);font-family:var(--vault-mono);",
  profileValue: "color:var(--vault-text);font-weight:500;font-family:var(--vault-mono);",
  profileActions:
    "display:flex;gap:0.5rem;flex-wrap:wrap;padding-top:0.75rem;border-top:1px solid var(--vault-panel-border);",

  warnSection:
    "background:rgba(245,158,11,0.05);border:1px solid rgba(245,158,11,0.22);border-radius:8px;padding:0.85rem;margin-top:0.75rem;",

  input:
    "background:#050505;border:1px solid var(--vault-panel-border);border-radius:6px;padding:0.45rem 0.7rem;color:var(--vault-text);font-size:0.85rem;flex:1;font-family:var(--vault-mono);outline:none;min-width:0;",
  select:
    "background:#050505;border:1px solid var(--vault-panel-border);border-radius:6px;padding:0.42rem 0.65rem;color:var(--vault-text);font-size:0.8rem;font-family:var(--vault-mono);outline:none;cursor:pointer;",
  textarea:
    "background:#050505;border:1px solid var(--vault-panel-border);border-radius:6px;padding:0.5rem 0.7rem;color:var(--vault-text);font-size:0.84rem;width:100%;box-sizing:border-box;font-family:var(--vault-mono);min-height:80px;resize:vertical;outline:none;",
  label:
    "display:block;font-size:0.68rem;color:var(--vault-text-dim);margin-bottom:0.25rem;text-transform:uppercase;letter-spacing:0.05em;font-family:var(--vault-mono);",

  primaryBtn:
    "background:var(--vault-accent);color:#000;border:none;border-radius:6px;padding:0.4rem 0.8rem;cursor:pointer;font-weight:700;font-size:0.8rem;font-family:var(--vault-mono);",
  secondaryBtn:
    "background:transparent;color:var(--vault-accent);border:1px solid var(--vault-panel-border);border-radius:6px;padding:0.35rem 0.7rem;cursor:pointer;font-size:0.78rem;font-family:var(--vault-mono);",
  dangerBtn:
    "background:rgba(239,68,68,0.08);color:#ef4444;border:1px solid rgba(239,68,68,0.3);border-radius:6px;padding:0.35rem 0.7rem;cursor:pointer;font-size:0.78rem;font-family:var(--vault-mono);",
  iconBtn: (active: boolean) =>
    `background:${active ? "color-mix(in srgb,var(--vault-accent) 15%,transparent)" : "transparent"};color:${active ? "var(--vault-accent)" : "var(--vault-text-dim)"};border:1px solid ${active ? "var(--vault-panel-border)" : "transparent"};border-radius:5px;padding:0.32rem 0.55rem;cursor:pointer;font-size:0.82rem;font-family:var(--vault-mono);line-height:1;`,
  filterChip: (active: boolean) =>
    `background:${active ? "var(--vault-accent)" : "transparent"};color:${active ? "#000" : "var(--vault-text-dim)"};border:1px solid ${active ? "var(--vault-accent)" : "var(--vault-panel-border)"};border-radius:20px;padding:0.25rem 0.7rem;cursor:pointer;font-size:0.74rem;font-family:var(--vault-mono);`,

  checkbox:
    "width:16px;height:16px;cursor:pointer;accent-color:var(--vault-accent);flex-shrink:0;",

  empty:
    "color:var(--vault-text-dim);font-size:0.88rem;text-align:center;padding:3rem 1rem;font-family:var(--vault-mono);",
  emptyIcon: "font-size:2.5rem;margin-bottom:0.6rem;",
  loading:
    "color:var(--vault-text-dim);font-size:0.84rem;text-align:center;padding:2rem;font-family:var(--vault-mono);",

  modalOverlay:
    "position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;z-index:1000;",
  modalClose:
    "position:absolute;top:0.7rem;right:0.7rem;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);color:var(--vault-text-dim);font-size:0.95rem;cursor:pointer;padding:0.2rem 0.4rem;border-radius:4px;",

  pagination:
    "display:flex;justify-content:center;align-items:center;gap:0.5rem;padding:1rem 0;",
  pageBtn: (active: boolean) =>
    `background:${active ? "var(--vault-accent)" : "transparent"};color:${active ? "#000" : "var(--vault-text-dim)"};border:1px solid ${active ? "var(--vault-accent)" : "var(--vault-panel-border)"};border-radius:4px;padding:0.3rem 0.65rem;cursor:pointer;font-size:0.8rem;font-family:var(--vault-mono);`,
};

// ── Utility ──────────────────────────────────────────────────

function timeAgo(dateStr: string): string {
  if (!dateStr) return "Never";
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function formatDate(dateStr: string): string {
  if (!dateStr) return "N/A";
  return new Date(dateStr).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function getAvatarUrl(member: VaultMember): string | null {
  if (!member.avatar || !member.discordId) return null;
  return `https://cdn.discordapp.com/avatars/${member.discordId}/${member.avatar}.png`;
}

function getInitials(username: string): string {
  const parts = username.split(/[\s_.\-]+/);
  if (parts.length >= 2 && parts[1].length > 0)
    return (parts[0][0] + parts[1][0]).toUpperCase();
  return username.slice(0, 2).toUpperCase();
}

function getInitialsColor(username: string): string {
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = username.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue},48%,32%)`;
}

function isOnline(lastActive?: string): boolean {
  if (!lastActive) return false;
  return Date.now() - new Date(lastActive).getTime() < 5 * 60 * 1000;
}

// ── Avatar ───────────────────────────────────────────────────

function renderAvatar(member: VaultMember, size = 44) {
  const url = getAvatarUrl(member);
  if (url) {
    return html`<img src=${url} alt=${member.username} style=${S.avatarImg(size)} />`;
  }
  const bg = getInitialsColor(member.username);
  return html`<div style=${S.avatarInitials(size, bg)}>${getInitials(member.username)}</div>`;
}

// ── Filters ──────────────────────────────────────────────────

function renderFilters(vs: VaultState, state: AppViewState, gw: GatewayBrowserClient) {
  const statuses = ["all", "active", "inactive", "warned", "suspended", "banned"];
  const tiers = ["all", "free", "basic", "premium", "vip"];

  const doSearch = async () => {
    const result = await loadMembers(gw, vs.filters);
    vs.members = result.members;
    vs.membersTotal = result.total;
    _selectedIds.clear();
    state.requestUpdate?.();
  };

  return html`
    <div style=${S.header}>
      <div style=${S.searchBar}>
        <input
          style=${S.input}
          type="text"
          placeholder="Search members…"
          .value=${vs.filters.search || ""}
          @input=${(e: Event) => {
            vs.filters.search = (e.target as HTMLInputElement).value;
            state.requestUpdate?.();
            if (_searchTimer) clearTimeout(_searchTimer);
            _searchTimer = setTimeout(doSearch, 320);
          }}
          @keydown=${(e: KeyboardEvent) => {
            if (e.key === "Enter") {
              if (_searchTimer) clearTimeout(_searchTimer);
              doSearch();
            }
          }}
        />
      </div>

      <div style=${S.filters}>
        <select
          style=${S.select}
          .value=${vs.filters.status || "all"}
          @change=${async (e: Event) => {
            const v = (e.target as HTMLSelectElement).value;
            vs.filters.status = v === "all" ? undefined : v;
            await doSearch();
          }}
        >
          ${statuses.map(
            (s) =>
              html`<option value=${s}>${s === "all" ? "All Status" : s.charAt(0).toUpperCase() + s.slice(1)}</option>`
          )}
        </select>

        <select
          style=${S.select}
          .value=${vs.filters.tier || "all"}
          @change=${async (e: Event) => {
            const v = (e.target as HTMLSelectElement).value;
            vs.filters.tier = v === "all" ? undefined : v;
            await doSearch();
          }}
        >
          ${tiers.map(
            (t) =>
              html`<option value=${t}>${t === "all" ? "All Tiers" : t.charAt(0).toUpperCase() + t.slice(1)}</option>`
          )}
        </select>

        <select
          style=${S.select}
          .value=${vs.filters.sortBy || "joinedAt"}
          @change=${async (e: Event) => {
            vs.filters.sortBy = (e.target as HTMLSelectElement).value as MemberFilters["sortBy"];
            await doSearch();
          }}
        >
          <option value="joinedAt">↓ Join Date</option>
          <option value="lastActive">↓ Last Active</option>
          <option value="username">A–Z Name</option>
          <option value="engagementScore">↓ Engagement</option>
          <option value="warningCount">↓ Warnings</option>
        </select>

        <button
          style=${S.filterChip(vs.filters.hasWarnings || false)}
          @click=${async () => {
            vs.filters.hasWarnings = vs.filters.hasWarnings ? undefined : true;
            await doSearch();
          }}
        >
          ⚠ Warnings
        </button>

        <div
          style="display:flex;gap:2px;border:1px solid var(--vault-panel-border);border-radius:6px;overflow:hidden;"
        >
          <button
            style=${S.iconBtn(_viewMode === "grid")}
            title="Grid view"
            @click=${() => {
              _viewMode = "grid";
              state.requestUpdate?.();
            }}
          >
            ⊞
          </button>
          <button
            style=${S.iconBtn(_viewMode === "list")}
            title="List view"
            @click=${() => {
              _viewMode = "list";
              state.requestUpdate?.();
            }}
          >
            ☰
          </button>
        </div>
      </div>
    </div>
  `;
}

// ── Bulk Action Bar ──────────────────────────────────────────

function renderBulkBar(vs: VaultState, state: AppViewState, gw: GatewayBrowserClient) {
  if (_selectedIds.size === 0) return nothing;

  const count = _selectedIds.size;
  const ids = [..._selectedIds];
  const clearSel = () => {
    _selectedIds.clear();
    state.requestUpdate?.();
  };

  return html`
    <div style=${S.bulkBar}>
      <span style=${S.bulkCount}>${count} member${count > 1 ? "s" : ""} selected</span>

      <button
        style=${S.secondaryBtn}
        @click=${async () => {
          const message = prompt(`Send DM to ${count} member(s):`);
          if (!message) return;
          await Promise.all(ids.map((id) => sendDirectMessage(gw, id, message).catch(() => null)));
          vs.successMessage = `DM sent to ${count} member(s)`;
          clearSel();
          setTimeout(() => {
            vs.successMessage = null;
            state.requestUpdate?.();
          }, 3000);
        }}
      >
        💬 DM All
      </button>

      <button
        style="${S.secondaryBtn}opacity:0.45;cursor:not-allowed;"
        disabled
        title="Export not yet available — backend endpoint pending"
      >
        ↓ Export
      </button>

      <button
        style=${S.dangerBtn}
        @click=${async () => {
          const reason = prompt(`Kick ${count} member(s). Reason:`);
          if (reason === null) return;
          await Promise.all(ids.map((id) => kickMember(gw, id, reason).catch(() => null)));
          const result = await loadMembers(gw, vs.filters);
          vs.members = result.members;
          vs.membersTotal = result.total;
          clearSel();
        }}
      >
        Kick ${count}
      </button>

      <button
        style=${S.dangerBtn}
        @click=${async () => {
          const reason = prompt(`Ban ${count} member(s). Reason:`);
          if (reason === null) return;
          await Promise.all(ids.map((id) => banMember(gw, id, reason).catch(() => null)));
          const result = await loadMembers(gw, vs.filters);
          vs.members = result.members;
          vs.membersTotal = result.total;
          clearSel();
        }}
      >
        Ban ${count}
      </button>

      <button style=${S.secondaryBtn} @click=${clearSel}>✕ Clear</button>
    </div>
  `;
}

// ── Member Card (Grid) ───────────────────────────────────────

function renderMemberCard(member: VaultMember, vs: VaultState, state: AppViewState) {
  const isSelected = _selectedIds.has(member.id);
  const online = isOnline(member.lastActive);
  const visibleRoles = member.roles.slice(0, 3);

  return html`
    <div
      style=${S.memberCard(isSelected)}
      @click=${() => {
        vs.selectedMember = member;
        vs.showMemberModal = true;
        state.requestUpdate?.();
      }}
    >
      <div style=${S.memberHeader}>
        <div style="position:relative;flex-shrink:0;">
          ${renderAvatar(member, 44)}
          <span
            style="position:absolute;bottom:-1px;right:-1px;${S.onlineDot(online)}"
          ></span>
        </div>
        <div style=${S.memberInfo}>
          <div style=${S.memberName}>${member.username}</div>
          <div style=${S.memberMeta}>
            <span style=${S.statusBadge(member.status)}>${member.status}</span>
            ${member.tier && member.tier !== "free"
              ? html`<span style=${S.tierBadge}>${member.tier.toUpperCase()}</span>`
              : nothing}
          </div>
        </div>
        <input
          type="checkbox"
          style=${S.checkbox}
          .checked=${isSelected}
          @click=${(e: Event) => e.stopPropagation()}
          @change=${(e: Event) => {
            if ((e.target as HTMLInputElement).checked) _selectedIds.add(member.id);
            else _selectedIds.delete(member.id);
            state.requestUpdate?.();
          }}
        />
      </div>

      ${visibleRoles.length > 0
        ? html`
            <div style="display:flex;flex-wrap:wrap;gap:0.25rem;margin-bottom:0.5rem;">
              ${visibleRoles.map((r) => html`<span style=${S.roleBadge}>${r}</span>`)}
              ${member.roles.length > 3
                ? html`<span style=${S.roleBadge}>+${member.roles.length - 3}</span>`
                : nothing}
            </div>
          `
        : nothing}

      <div style=${S.memberStats}>
        <span title="Engagement">▲ ${member.engagementScore}%</span>
        <span title="Courses">⊙ ${member.coursesCompleted}/${member.coursesInProgress + member.coursesCompleted}</span>
        ${member.warningCount > 0
          ? html`<span style="color:#f59e0b;" title="Warnings">⚠ ${member.warningCount}</span>`
          : nothing}
        <span style="margin-left:auto;" title="Last active">${timeAgo(member.lastActive || "")}</span>
      </div>
    </div>
  `;
}

// ── Member Row (List) ────────────────────────────────────────

function renderMemberRow(member: VaultMember, vs: VaultState, state: AppViewState) {
  const isSelected = _selectedIds.has(member.id);
  const online = isOnline(member.lastActive);

  return html`
    <div
      style=${S.listRow(isSelected)}
      @click=${() => {
        vs.selectedMember = member;
        vs.showMemberModal = true;
        state.requestUpdate?.();
      }}
    >
      <input
        type="checkbox"
        style=${S.checkbox}
        .checked=${isSelected}
        @click=${(e: Event) => e.stopPropagation()}
        @change=${(e: Event) => {
          if ((e.target as HTMLInputElement).checked) _selectedIds.add(member.id);
          else _selectedIds.delete(member.id);
          state.requestUpdate?.();
        }}
      />
      <div style="position:relative;flex-shrink:0;">
        ${renderAvatar(member, 32)}
        <span style="position:absolute;bottom:-1px;right:-1px;${S.onlineDot(online)}"></span>
      </div>
      <span style=${S.listName}>${member.username}</span>
      <div style=${S.listMeta}>
        <span style=${S.statusBadge(member.status)}>${member.status}</span>
        ${member.tier && member.tier !== "free"
          ? html`<span style=${S.tierBadge}>${member.tier.toUpperCase()}</span>`
          : nothing}
        ${member.warningCount > 0
          ? html`<span
              style="color:#f59e0b;font-size:0.7rem;font-family:var(--vault-mono);"
              >⚠ ${member.warningCount}</span
            >`
          : nothing}
        <span style=${S.listTime}>${timeAgo(member.lastActive || "")}</span>
      </div>
    </div>
  `;
}

// ── Member List Container ────────────────────────────────────

function renderMembersList(vs: VaultState, state: AppViewState, gw: GatewayBrowserClient) {
  if (vs.members.length === 0) {
    const hasFilters =
      vs.filters.search || vs.filters.status || vs.filters.tier || vs.filters.hasWarnings;
    return html`
      <div style=${S.empty}>
        <div style=${S.emptyIcon}>${hasFilters ? "🔍" : "👥"}</div>
        <div>${hasFilters ? "No members match these filters." : "No members loaded yet."}</div>
        <div style="margin-top:0.75rem;">
          ${hasFilters
            ? html`<button
                style=${S.secondaryBtn}
                @click=${async () => {
                  vs.filters = { sortBy: "joinedAt", sortOrder: "desc", limit: 50, offset: 0 };
                  const result = await loadMembers(gw, vs.filters);
                  vs.members = result.members;
                  vs.membersTotal = result.total;
                  _selectedIds.clear();
                  state.requestUpdate?.();
                }}
              >
                Clear Filters
              </button>`
            : html`<span style="font-size:0.78rem;color:var(--vault-text-dim);font-family:var(--vault-mono);"
                >Sync your Discord server to import members.</span
              >`}
        </div>
      </div>
    `;
  }

  return html`
    <div style=${_viewMode === "grid" ? S.memberGrid : S.memberList}>
      ${vs.members.map((m) =>
        _viewMode === "grid"
          ? renderMemberCard(m, vs, state)
          : renderMemberRow(m, vs, state)
      )}
    </div>
    ${renderPagination(vs, state, gw)}
  `;
}

// ── Pagination ───────────────────────────────────────────────

function renderPagination(vs: VaultState, state: AppViewState, gw: GatewayBrowserClient) {
  const pageSize = vs.filters.limit || 50;
  const totalPages = Math.ceil(vs.membersTotal / pageSize);
  const currentPage = vs.membersPage;

  if (totalPages <= 1) return nothing;

  return html`
    <div style=${S.pagination}>
      <button
        style=${S.pageBtn(false)}
        ?disabled=${currentPage === 0}
        @click=${async () => {
          vs.membersPage = Math.max(0, currentPage - 1);
          vs.filters.offset = vs.membersPage * pageSize;
          const result = await loadMembers(gw, vs.filters);
          vs.members = result.members;
          state.requestUpdate?.();
        }}
      >
        ← Prev
      </button>

      <span
        style="color:var(--vault-text-dim);font-size:0.8rem;font-family:var(--vault-mono);"
      >
        ${currentPage + 1} / ${totalPages} · ${vs.membersTotal} members
      </span>

      <button
        style=${S.pageBtn(false)}
        ?disabled=${currentPage >= totalPages - 1}
        @click=${async () => {
          vs.membersPage = Math.min(totalPages - 1, currentPage + 1);
          vs.filters.offset = vs.membersPage * pageSize;
          const result = await loadMembers(gw, vs.filters);
          vs.members = result.members;
          state.requestUpdate?.();
        }}
      >
        Next →
      </button>
    </div>
  `;
}

// ── Profile Modal ────────────────────────────────────────────

function renderMemberProfileModal(
  vs: VaultState,
  state: AppViewState,
  gw: GatewayBrowserClient
) {
  if (!vs.showMemberModal || !vs.selectedMember) return nothing;

  const member = vs.selectedMember;
  const online = isOnline(member.lastActive);

  return html`
    <div
      style=${S.modalOverlay}
      @click=${(e: Event) => {
        if (e.target === e.currentTarget) {
          vs.showMemberModal = false;
          vs.selectedMember = null;
          state.requestUpdate?.();
        }
      }}
    >
      <div style=${S.profileModal}>
        <div style=${S.profileHeader}>
          <button
            style=${S.modalClose}
            @click=${() => {
              vs.showMemberModal = false;
              vs.selectedMember = null;
              state.requestUpdate?.();
            }}
          >
            ✕
          </button>
          <div style=${S.profileHeaderContent}>
            <div style="position:relative;flex-shrink:0;">
              ${renderAvatar(member, 64)}
              <span
                style="position:absolute;bottom:2px;right:2px;${S.onlineDot(online)}"
              ></span>
            </div>
            <div>
              <div style=${S.profileName}>
                ${member.username}${member.discriminator ? `#${member.discriminator}` : ""}
              </div>
              <div style="display:flex;gap:0.4rem;margin-top:0.35rem;flex-wrap:wrap;align-items:center;">
                <span style=${S.statusBadge(member.status)}>${member.status}</span>
                ${member.tier
                  ? html`<span style=${S.tierBadge}>${member.tier.toUpperCase()}</span>`
                  : nothing}
                <span
                  style="font-size:0.7rem;color:${online ? "#22c55e" : "var(--vault-text-dim)"};font-family:var(--vault-mono);"
                >
                  ${online ? "● Online" : "○ Offline"}
                </span>
              </div>
            </div>
          </div>
        </div>

        <div style=${S.profileBody}>
          <div style=${S.profileSection}>
            <div style=${S.profileSectionTitle}>Member Info</div>
            <div style=${S.profileRow}>
              <span style=${S.profileLabel}>Discord ID</span>
              <span style=${S.profileValue}>${member.discordId}</span>
            </div>
            <div style=${S.profileRow}>
              <span style=${S.profileLabel}>Joined</span>
              <span style=${S.profileValue}>${formatDate(member.joinedAt)}</span>
            </div>
            <div style=${S.profileRow}>
              <span style=${S.profileLabel}>Last Active</span>
              <span style=${S.profileValue}>
                ${member.lastActive ? timeAgo(member.lastActive) : "Never"}
              </span>
            </div>
            ${member.email
              ? html`
                  <div style=${S.profileRow}>
                    <span style=${S.profileLabel}>Email</span>
                    <span style=${S.profileValue}>${member.email}</span>
                  </div>
                `
              : nothing}
          </div>

          <div style=${S.profileSection}>
            <div style=${S.profileSectionTitle}>Engagement</div>
            <div style=${S.profileRow}>
              <span style=${S.profileLabel}>Score</span>
              <span style=${S.profileValue}>${member.engagementScore}%</span>
            </div>
            <div style=${S.profileRow}>
              <span style=${S.profileLabel}>Courses Completed</span>
              <span style=${S.profileValue}>${member.coursesCompleted}</span>
            </div>
            <div style=${S.profileRow}>
              <span style=${S.profileLabel}>In Progress</span>
              <span style=${S.profileValue}>${member.coursesInProgress}</span>
            </div>
          </div>

          <div style=${S.profileSection}>
            <div style=${S.profileSectionTitle}>Roles</div>
            <div style="display:flex;flex-wrap:wrap;gap:0.4rem;">
              ${member.roles.length > 0
                ? member.roles.map((r) => html`<span style=${S.roleBadge}>${r}</span>`)
                : html`<span
                    style="color:var(--vault-text-dim);font-size:0.82rem;font-family:var(--vault-mono);"
                    >No roles assigned</span
                  >`}
            </div>
          </div>

          ${member.warningCount > 0
            ? html`
                <div style=${S.warnSection}>
                  <div
                    style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem;"
                  >
                    <span
                      style="color:#f59e0b;font-weight:700;font-size:0.86rem;font-family:var(--vault-mono);"
                      >⚠ ${member.warningCount} Warning(s)</span
                    >
                    <button
                      style=${S.secondaryBtn}
                      @click=${async () => {
                        if (confirm("Clear all warnings for this member?")) {
                          await clearWarnings(gw, member.id);
                          member.warningCount = 0;
                          state.requestUpdate?.();
                        }
                      }}
                    >
                      Clear All
                    </button>
                  </div>
                </div>
              `
            : nothing}

          <div style=${S.profileSection}>
            <div style=${S.profileSectionTitle}>Notes</div>
            <textarea
              style=${S.textarea}
              placeholder="Add notes about this member…"
              .value=${member.notes || ""}
              @blur=${async (e: Event) => {
                const notes = (e.target as HTMLTextAreaElement).value;
                if (notes !== member.notes) {
                  await updateMember(gw, member.id, { notes });
                  member.notes = notes;
                }
              }}
            ></textarea>
          </div>

          <div style=${S.profileActions}>
            <button
              style=${S.secondaryBtn}
              @click=${async () => {
                const message = prompt("Send DM to " + member.username + ":");
                if (message) {
                  await sendDirectMessage(gw, member.id, message);
                  vs.successMessage = "DM sent!";
                  setTimeout(() => {
                    vs.successMessage = null;
                    state.requestUpdate?.();
                  }, 3000);
                  state.requestUpdate?.();
                }
              }}
            >
              💬 DM
            </button>

            <button
              style=${S.secondaryBtn}
              @click=${() => {
                vs.showWarnModal = true;
                vs.warnForm = { memberId: member.id, reason: "", severity: "low" };
                state.requestUpdate?.();
              }}
            >
              ⚠ Warn
            </button>

            ${member.status !== "banned"
              ? html`
                  <button
                    style=${S.dangerBtn}
                    @click=${async () => {
                      const reason = prompt("Reason for kick:");
                      if (reason !== null) {
                        await kickMember(gw, member.id, reason);
                        vs.showMemberModal = false;
                        _selectedIds.delete(member.id);
                        const result = await loadMembers(gw, vs.filters);
                        vs.members = result.members;
                        state.requestUpdate?.();
                      }
                    }}
                  >
                    Kick
                  </button>

                  <button
                    style=${S.dangerBtn}
                    @click=${async () => {
                      const reason = prompt("Reason for ban:");
                      if (reason !== null) {
                        await banMember(gw, member.id, reason);
                        vs.showMemberModal = false;
                        _selectedIds.delete(member.id);
                        const result = await loadMembers(gw, vs.filters);
                        vs.members = result.members;
                        state.requestUpdate?.();
                      }
                    }}
                  >
                    Ban
                  </button>
                `
              : html`
                  <button
                    style=${S.secondaryBtn}
                    @click=${async () => {
                      await import("../controllers/vault").then((m) =>
                        m.unbanMember(gw, member.id)
                      );
                      vs.showMemberModal = false;
                      const result = await loadMembers(gw, vs.filters);
                      vs.members = result.members;
                      state.requestUpdate?.();
                    }}
                  >
                    Unban
                  </button>
                `}
          </div>
        </div>
      </div>
    </div>
    ${renderWarnModal(vs, state, gw)}
  `;
}

// ── Warn Modal ───────────────────────────────────────────────

function renderWarnModal(vs: VaultState, state: AppViewState, gw: GatewayBrowserClient) {
  if (!vs.showWarnModal) return nothing;

  return html`
    <div
      style=${S.modalOverlay}
      @click=${(e: Event) => {
        if (e.target === e.currentTarget) {
          vs.showWarnModal = false;
          state.requestUpdate?.();
        }
      }}
    >
      <div
        style="background:var(--vault-panel);border:1px solid var(--vault-panel-border);border-radius:12px;padding:1.5rem;max-width:400px;width:90%;"
      >
        <div
          style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;"
        >
          <span
            style="font-size:1rem;font-weight:700;color:#f59e0b;font-family:var(--vault-mono);"
            >⚠ Issue Warning</span
          >
          <button
            style="background:none;border:none;color:var(--vault-text-dim);font-size:1.1rem;cursor:pointer;"
            @click=${() => {
              vs.showWarnModal = false;
              state.requestUpdate?.();
            }}
          >
            ✕
          </button>
        </div>

        <div style="margin-bottom:1rem;">
          <label style=${S.label}>Severity</label>
          <select
            style=${S.select}
            .value=${vs.warnForm.severity}
            @change=${(e: Event) => {
              vs.warnForm.severity = (e.target as HTMLSelectElement).value;
              state.requestUpdate?.();
            }}
          >
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="critical">Critical</option>
          </select>
        </div>

        <div style="margin-bottom:1rem;">
          <label style=${S.label}>Reason</label>
          <textarea
            style=${S.textarea}
            placeholder="Reason for warning…"
            .value=${vs.warnForm.reason}
            @input=${(e: Event) => {
              vs.warnForm.reason = (e.target as HTMLTextAreaElement).value;
              state.requestUpdate?.();
            }}
          ></textarea>
        </div>

        <div style="display:flex;gap:0.5rem;justify-content:flex-end;">
          <button
            style=${S.secondaryBtn}
            @click=${() => {
              vs.showWarnModal = false;
              state.requestUpdate?.();
            }}
          >
            Cancel
          </button>
          <button
            style="background:#f59e0b;color:#000;border:none;border-radius:6px;padding:0.4rem 0.85rem;cursor:pointer;font-weight:700;font-size:0.8rem;font-family:var(--vault-mono);"
            ?disabled=${!vs.warnForm.reason}
            @click=${async () => {
              await warnMember(
                gw,
                vs.warnForm.memberId,
                vs.warnForm.reason,
                vs.warnForm.severity
              );
              vs.showWarnModal = false;
              if (vs.selectedMember) vs.selectedMember.warningCount++;
              state.requestUpdate?.();
            }}
          >
            Issue Warning
          </button>
        </div>
      </div>
    </div>
  `;
}

// ── Main Export ──────────────────────────────────────────────

export function renderVaultMembers(
  vs: VaultState,
  state: AppViewState,
  gw: GatewayBrowserClient
) {
  if (vs.members.length === 0 && !vs.loading) {
    loadMembers(gw, vs.filters).then((result) => {
      vs.members = result.members;
      vs.membersTotal = result.total;
      state.requestUpdate?.();
    });
  }

  return html`
    ${g8GlassStyles}
    <div class="g8-page vault-members" style=${S.container}>
      ${renderFilters(vs, state, gw)}
      ${renderBulkBar(vs, state, gw)}
      ${vs.loading
        ? html`<div style=${S.loading}>Loading members…</div>`
        : renderMembersList(vs, state, gw)}
      ${renderMemberProfileModal(vs, state, gw)}
    </div>
  `;
}
