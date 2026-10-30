/**
 * Social Analytics Dashboard View
 * Interactive charts and stats for social media metrics
 */

import { html, nothing } from "lit";
import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";
import { commIcon, ensureCommunicationGlassStyles } from "./communication-glass.js";
import {
  createSocialsAnalyticsState,
  loadSocialsAnalytics,
  setDateRange,
  setPlatform,
  type SocialsAnalyticsState,
  type FollowerDataPoint,
  type EngagementStats,
  type PostPerformance,
} from "../controllers/socials-analytics";

// ── Theme Constants ──────────────────────────────────────────
const GOLD = "var(--glass-gold, var(--g-primary, #d9b45f))";
const GOLD_DIM = "var(--glass-gold-a40, color-mix(in srgb, var(--glass-gold, #d9b45f) 40%, transparent))";
const GOLD_GLOW = "var(--glass-gold-a16, color-mix(in srgb, var(--glass-gold, #d9b45f) 16%, transparent))";
const DARK_BG = "var(--glass-base, #090806)";
const CARD_BG = "var(--glass-3, rgba(34, 31, 25, 0.64))";
const BORDER = "var(--glass-stroke, rgba(217, 180, 95, 0.16))";
const TEXT_PRIMARY = "var(--glass-fg, var(--g-fg, #f4f1ea))";
const TEXT_MUTED = "var(--glass-fg-2, var(--g-fg-dim, #bbb5aa))";
const SUCCESS = "var(--glass-success, #22c55e)";
const ERROR = "var(--glass-danger, #ef4444)";

// ── Helpers ──────────────────────────────────────────────────

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function formatPercent(n: number): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function trendIcon(change: number): ReturnType<typeof html> {
  if (change > 0) {
    return html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="${SUCCESS}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>`;
  } else if (change < 0) {
    return html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="${ERROR}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 18 13.5 8.5 8.5 13.5 1 6"/><polyline points="17 18 23 18 23 12"/></svg>`;
  }
  return html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="${TEXT_MUTED}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
}

// ── SVG Line Chart ───────────────────────────────────────────

function renderFollowerChart(data: FollowerDataPoint[]): ReturnType<typeof html> {
  if (data.length === 0) {
    return html`
      <div style="display: flex; align-items: center; justify-content: center; height: 200px; color: ${TEXT_MUTED};">
        No follower data available
      </div>
    `;
  }

  // Reverse to get chronological order (oldest first)
  const sorted = [...data].reverse();
  
  const width = 800;
  const height = 220;
  const padding = { top: 20, right: 20, bottom: 40, left: 60 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  // Calculate scales
  const followers = sorted.map(d => d.followers);
  const minFollowers = Math.min(...followers);
  const maxFollowers = Math.max(...followers);
  const range = maxFollowers - minFollowers || 1;
  const yPadding = range * 0.1;
  const yMin = minFollowers - yPadding;
  const yMax = maxFollowers + yPadding;

  // Generate path points
  const points = sorted.map((d, i) => {
    const x = padding.left + (i / (sorted.length - 1 || 1)) * chartWidth;
    const y = padding.top + chartHeight - ((d.followers - yMin) / (yMax - yMin)) * chartHeight;
    return { x, y, data: d };
  });

  // Build SVG path
  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
  
  // Area path (filled under line)
  const areaPath = `${linePath} L ${points[points.length - 1].x} ${padding.top + chartHeight} L ${points[0].x} ${padding.top + chartHeight} Z`;

  // Y-axis ticks (5 ticks)
  const yTicks = [];
  for (let i = 0; i <= 4; i++) {
    const value = yMin + (i / 4) * (yMax - yMin);
    const y = padding.top + chartHeight - (i / 4) * chartHeight;
    yTicks.push({ value, y });
  }

  // X-axis labels (show ~5-6 dates)
  const xLabelStep = Math.max(1, Math.floor(sorted.length / 6));
  const xLabels = sorted.filter((_, i) => i % xLabelStep === 0 || i === sorted.length - 1);

  return html`
    <svg viewBox="0 0 ${width} ${height}" style="width: 100%; height: auto; overflow: visible;">
      <defs>
        <linearGradient id="followerGradient" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" style="stop-color:${GOLD};stop-opacity:0.4" />
          <stop offset="100%" style="stop-color:${GOLD};stop-opacity:0.05" />
        </linearGradient>
        <filter id="glow">
          <feGaussianBlur stdDeviation="2" result="coloredBlur"/>
          <feMerge>
            <feMergeNode in="coloredBlur"/>
            <feMergeNode in="SourceGraphic"/>
          </feMerge>
        </filter>
      </defs>
      
      <!-- Grid lines -->
      ${yTicks.map(t => html`
        <line x1="${padding.left}" y1="${t.y}" x2="${width - padding.right}" y2="${t.y}" 
              stroke="${BORDER}" stroke-width="1" stroke-dasharray="4,4" opacity="0.5"/>
      `)}
      
      <!-- Y-axis labels -->
      ${yTicks.map(t => html`
        <text x="${padding.left - 10}" y="${t.y}" fill="${TEXT_MUTED}" font-size="11" 
              text-anchor="end" dominant-baseline="middle">
          ${formatNumber(Math.round(t.value))}
        </text>
      `)}
      
      <!-- X-axis labels -->
      ${xLabels.map((d, i) => {
        const idx = sorted.findIndex(s => s.date === d.date);
        const x = padding.left + (idx / (sorted.length - 1 || 1)) * chartWidth;
        return html`
          <text x="${x}" y="${height - 10}" fill="${TEXT_MUTED}" font-size="10" 
                text-anchor="middle">
            ${formatDate(d.date)}
          </text>
        `;
      })}
      
      <!-- Area fill -->
      <path d="${areaPath}" fill="url(#followerGradient)" />
      
      <!-- Line -->
      <path d="${linePath}" fill="none" stroke="${GOLD}" stroke-width="2.5" 
            stroke-linecap="round" stroke-linejoin="round" filter="url(#glow)"/>
      
      <!-- Data points (interactive) -->
      ${points.map((p, i) => html`
        <g class="chart-point" style="cursor: pointer;">
          <circle cx="${p.x}" cy="${p.y}" r="6" fill="${DARK_BG}" stroke="${GOLD}" stroke-width="2"/>
          <title>${formatDate(p.data.date)}: ${formatNumber(p.data.followers)} followers (${p.data.change >= 0 ? '+' : ''}${p.data.change})</title>
        </g>
      `)}
    </svg>
  `;
}

// ── Stats Card ───────────────────────────────────────────────

function renderStatCard(
  title: string,
  value: string | number,
  change: number,
  icon: ReturnType<typeof html>
): ReturnType<typeof html> {
  const changeColor = change > 0 ? SUCCESS : change < 0 ? ERROR : TEXT_MUTED;
  
  return html`
    <div class="stat-card" style="
      background: linear-gradient(135deg, ${CARD_BG} 0%, ${DARK_BG} 100%);
      border: 1px solid ${BORDER};
      border-radius: 12px;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      position: relative;
      overflow: hidden;
    ">
      <!-- Subtle gold accent -->
      <div style="
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        height: 3px;
        background: linear-gradient(90deg, ${GOLD} 0%, transparent 100%);
        opacity: 0.6;
      "></div>
      
      <div style="display: flex; justify-content: space-between; align-items: flex-start;">
        <span style="color: ${TEXT_MUTED}; font-size: 13px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px;">
          ${title}
        </span>
        ${icon}
      </div>
      
      <div style="font-size: 32px; font-weight: 700; color: ${TEXT_PRIMARY}; font-variant-numeric: tabular-nums;">
        ${typeof value === 'number' ? formatNumber(value) : value}
      </div>
      
      <div style="display: flex; align-items: center; gap: 6px;">
        ${trendIcon(change)}
        <span style="color: ${changeColor}; font-size: 13px; font-weight: 600;">
          ${formatPercent(change)}
        </span>
        <span style="color: ${TEXT_MUTED}; font-size: 12px;">vs last period</span>
      </div>
    </div>
  `;
}

// ── Post Performance Card ────────────────────────────────────

function renderPostCard(post: PostPerformance, rank: number): ReturnType<typeof html> {
  const engagementColor = post.engagementRate >= 5 ? SUCCESS : 
                          post.engagementRate >= 2 ? GOLD : TEXT_MUTED;
  
  return html`
    <div class="post-card" style="
      background: ${CARD_BG};
      border: 1px solid ${BORDER};
      border-radius: 10px;
      padding: 16px;
      display: grid;
      grid-template-columns: 32px ${post.thumbnailUrl ? '60px' : '0px'} 1fr auto;
      gap: 12px;
      align-items: center;
      transition: border-color 0.2s;
    " @mouseenter=${(e: Event) => (e.currentTarget as HTMLElement).style.borderColor = GOLD}
       @mouseleave=${(e: Event) => (e.currentTarget as HTMLElement).style.borderColor = BORDER}>
      
      <!-- Rank badge -->
      <div style="
        width: 32px;
        height: 32px;
        border-radius: 50%;
        background: ${rank <= 3 ? GOLD_GLOW : 'transparent'};
        border: 2px solid ${rank <= 3 ? GOLD : BORDER};
        display: flex;
        align-items: center;
        justify-content: center;
        font-weight: 700;
        font-size: 14px;
        color: ${rank <= 3 ? GOLD : TEXT_MUTED};
      ">
        ${rank}
      </div>
      
      <!-- Thumbnail -->
      ${post.thumbnailUrl ? html`
        <div class="post-thumbnail" style="
          width: 60px;
          height: 60px;
          border-radius: 8px;
          background: url('${post.thumbnailUrl}') center/cover;
          border: 1px solid ${BORDER};
        "></div>
      ` : nothing}
      
      <!-- Caption/Info -->
      <div style="min-width: 0;">
        <div style="
          font-size: 14px;
          color: ${TEXT_PRIMARY};
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          margin-bottom: 4px;
        ">
          ${post.caption || 'No caption'}
        </div>
        <div style="display: flex; gap: 12px; font-size: 12px; color: ${TEXT_MUTED};">
          <span>${commIcon("heart", 13)} ${formatNumber(post.likes)}</span>
          <span>${commIcon("chat", 13)} ${formatNumber(post.comments)}</span>
          ${post.shares ? html`<span>${commIcon("share", 13)} ${formatNumber(post.shares)}</span>` : nothing}
          ${post.saves ? html`<span>${commIcon("bookmark", 13)} ${formatNumber(post.saves)}</span>` : nothing}
        </div>
      </div>
      
      <!-- Engagement Rate -->
      <div style="text-align: right;">
        <div style="font-size: 18px; font-weight: 700; color: ${engagementColor};">
          ${post.engagementRate.toFixed(1)}%
        </div>
        <div style="font-size: 11px; color: ${TEXT_MUTED};">engagement</div>
      </div>
    </div>
  `;
}

// ── Date Range Selector ──────────────────────────────────────

function renderDateRangeSelector(
  current: "7d" | "14d" | "30d",
  onChange: (range: "7d" | "14d" | "30d") => void
): ReturnType<typeof html> {
  const ranges: Array<{ value: "7d" | "14d" | "30d"; label: string }> = [
    { value: "7d", label: "7 Days" },
    { value: "14d", label: "14 Days" },
    { value: "30d", label: "30 Days" },
  ];
  
  return html`
    <div class="socials-range" style="display: flex; gap: 4px; background: ${DARK_BG}; border-radius: 8px; padding: 4px; border: 1px solid ${BORDER};">
      ${ranges.map(r => html`
        <button
          style="
            padding: 8px 16px;
            border: none;
            border-radius: 6px;
            font-size: 13px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.2s;
            ${r.value === current
              ? `background: ${GOLD}; color: ${DARK_BG};`
              : `background: transparent; color: ${TEXT_MUTED};`
            }
          "
          @click=${() => onChange(r.value)}
          @mouseenter=${(e: Event) => {
            if (r.value !== current) {
              (e.currentTarget as HTMLElement).style.background = GOLD_GLOW;
              (e.currentTarget as HTMLElement).style.color = TEXT_PRIMARY;
            }
          }}
          @mouseleave=${(e: Event) => {
            if (r.value !== current) {
              (e.currentTarget as HTMLElement).style.background = 'transparent';
              (e.currentTarget as HTMLElement).style.color = TEXT_MUTED;
            }
          }}
        >
          ${r.label}
        </button>
      `)}
    </div>
  `;
}

// ── Platform Selector ────────────────────────────────────────

function renderPlatformSelector(
  accounts: Array<{ platform: string; accountId: string; username: string }>,
  selected: string | null,
  onChange: (platform: string) => void
): ReturnType<typeof html> {
  if (accounts.length === 0) {
    return html`
      <div style="color: ${TEXT_MUTED}; font-size: 13px;">
        No connected accounts
      </div>
    `;
  }
  
  return html`
    <select
      class="socials-platform-select"
      style="
        padding: 8px 12px;
        background: ${CARD_BG};
        border: 1px solid ${BORDER};
        border-radius: 8px;
        color: ${TEXT_PRIMARY};
        font-size: 13px;
        cursor: pointer;
        outline: none;
      "
      @change=${(e: Event) => onChange((e.target as HTMLSelectElement).value)}
    >
      ${accounts.map(a => html`
        <option value="${a.platform}" ?selected=${a.platform === selected}>
          ${a.platform} (@${a.username})
        </option>
      `)}
    </select>
  `;
}

// ── Icons ────────────────────────────────────────────────────

const ICONS = {
  followers: html`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="${GOLD}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
  likes: html`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="${GOLD}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`,
  comments: html`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="${GOLD}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
  reach: html`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="${GOLD}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`,
  engagement: html`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="${GOLD}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`,
};

// ── Main Render Function ─────────────────────────────────────

let _state: SocialsAnalyticsState | null = null;

export function renderSocialsAnalytics(
  state: AppViewState,
  client: GatewayBrowserClient
): ReturnType<typeof html> {
  ensureCommunicationGlassStyles();
  // Initialize state if needed
  if (!_state) {
    _state = createSocialsAnalyticsState();
    // Auto-load on first render
    loadSocialsAnalytics(client, _state, () => state.requestUpdate?.());
  }

  const s = _state;
  
  // Handlers
  const handleDateRangeChange = (range: "7d" | "14d" | "30d") => {
    _state = setDateRange(_state!, range);
    loadSocialsAnalytics(client, _state!, () => state.requestUpdate?.());
  };
  
  const handlePlatformChange = (platform: string) => {
    _state = setPlatform(_state!, platform);
    loadSocialsAnalytics(client, _state!, () => state.requestUpdate?.());
  };
  
  const handleRefresh = () => {
    loadSocialsAnalytics(client, _state!, () => state.requestUpdate?.());
  };

  return html`
    <div class="socials-analytics" style="padding: 0 8px; max-width: 1400px; margin: 0 auto;">
      
      <!-- Header Controls -->
      <div class="socials-header" style="
        display: flex;
        flex-wrap: wrap;
        gap: 16px;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 24px;
        padding-bottom: 16px;
        border-bottom: 1px solid ${BORDER};
      ">
        <div class="socials-filters" style="display: flex; gap: 16px; align-items: center;">
          ${renderPlatformSelector(s.accounts, s.selectedPlatform, handlePlatformChange)}
          ${renderDateRangeSelector(s.dateRange, handleDateRangeChange)}
        </div>
        
        <button
          class="btn btn-sm socials-refresh"
          style="
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 8px 16px;
            background: ${GOLD_GLOW};
            border: 1px solid ${GOLD_DIM};
            border-radius: 8px;
            color: ${GOLD};
            font-size: 13px;
            cursor: pointer;
            transition: all 0.2s;
          "
          @click=${handleRefresh}
          @mouseenter=${(e: Event) => {
            (e.currentTarget as HTMLElement).style.background = GOLD;
            (e.currentTarget as HTMLElement).style.color = DARK_BG;
          }}
          @mouseleave=${(e: Event) => {
            (e.currentTarget as HTMLElement).style.background = GOLD_GLOW;
            (e.currentTarget as HTMLElement).style.color = GOLD;
          }}
        >
          ${s.loading ? "Loading..." : html`${commIcon("refresh", 14)} Refresh`}
        </button>
      </div>
      
      ${s.error ? html`
        <div style="
          padding: 16px;
          background: rgba(239, 68, 68, 0.1);
          border: 1px solid ${ERROR};
          border-radius: 8px;
          color: ${ERROR};
          margin-bottom: 24px;
        ">
          ${s.error}
        </div>
      ` : nothing}
      
      <!-- Stats Cards Grid -->
      <div class="socials-stats" style="
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 16px;
        margin-bottom: 32px;
      ">
        ${s.latestSnapshot ? renderStatCard(
          "Followers",
          s.latestSnapshot.followers,
          s.followerHistory.length > 0 ? s.followerHistory[0].change / Math.max(1, s.latestSnapshot.followers - s.followerHistory[0].change) * 100 : 0,
          ICONS.followers
        ) : nothing}
        
        ${s.engagementStats ? html`
          ${renderStatCard("Total Likes", s.engagementStats.totalLikes, s.engagementStats.likesChange, ICONS.likes)}
          ${renderStatCard("Comments", s.engagementStats.totalComments, s.engagementStats.commentsChange, ICONS.comments)}
          ${renderStatCard("Reach", s.engagementStats.totalReach, s.engagementStats.reachChange, ICONS.reach)}
          ${renderStatCard("Avg Engagement", `${s.engagementStats.avgEngagementRate.toFixed(1)}%`, s.engagementStats.engagementChange, ICONS.engagement)}
        ` : nothing}
      </div>
      
      <!-- Follower Growth Chart -->
      <div class="socials-panel" style="
        background: ${CARD_BG};
        border: 1px solid ${BORDER};
        border-radius: 12px;
        padding: 24px;
        margin-bottom: 32px;
      ">
        <h3 style="margin: 0 0 16px; font-size: 16px; font-weight: 600; color: ${TEXT_PRIMARY};">
          ${commIcon("chart", 17)} Follower Growth
        </h3>
        ${renderFollowerChart(s.followerHistory)}
      </div>
      
      <!-- Top Posts -->
      <div class="socials-panel" style="
        background: ${CARD_BG};
        border: 1px solid ${BORDER};
        border-radius: 12px;
        padding: 24px;
      ">
        <h3 style="margin: 0 0 20px; font-size: 16px; font-weight: 600; color: ${TEXT_PRIMARY};">
          ${commIcon("trophy", 17)} Top Performing Posts
        </h3>
        
        ${s.topPosts.length === 0 ? html`
          <div style="
            padding: 40px;
            text-align: center;
            color: ${TEXT_MUTED};
          ">
            No post data available
          </div>
        ` : html`
          <div style="display: flex; flex-direction: column; gap: 12px;">
            ${s.topPosts.map((post, i) => renderPostCard(post, i + 1))}
          </div>
        `}
      </div>
    </div>
    
    <style>
      .socials-analytics .chart-point circle {
        transition: r 0.2s, stroke-width 0.2s;
      }
      .socials-analytics .chart-point:hover circle {
        r: 8;
        stroke-width: 3;
      }
      .socials-analytics .stat-card {
        transition: transform 0.2s, box-shadow 0.2s;
      }
      .socials-analytics .stat-card:hover {
        transform: translateY(-2px);
        box-shadow: 0 8px 24px rgba(0,0,0,0.3), 0 0 20px ${GOLD_GLOW};
      }
      .socials-analytics .post-card {
        transition: transform 0.2s;
      }
      .socials-analytics .post-card:hover {
        transform: translateX(4px);
      }

      .socials-analytics {
        color: ${TEXT_PRIMARY};
        font-family: var(--glass-font, var(--font-ui, Inter, "SF Pro Display", -apple-system, sans-serif));
      }
      .socials-analytics .socials-header,
      .socials-analytics .socials-panel,
      .socials-analytics .stat-card,
      .socials-analytics .post-card {
        border-color: ${BORDER} !important;
      }
      .socials-analytics .socials-range {
        background: var(--glass-1, ${DARK_BG}) !important;
        border-color: ${BORDER} !important;
      }
      .socials-analytics .socials-platform-select {
        background: color-mix(in srgb, var(--glass-base, #090806) 62%, transparent) !important;
        border-color: ${BORDER} !important;
        color: ${TEXT_PRIMARY} !important;
      }
      
      @media (max-width: 768px) {
        .socials-analytics {
          padding: 0 4px !important;
        }
        .socials-analytics .socials-header {
          align-items: stretch !important;
          padding: 14px !important;
        }
        .socials-analytics .socials-filters {
          align-items: stretch !important;
          flex: 1 1 100%;
          flex-direction: column;
          gap: 10px !important;
          min-width: 0;
        }
        .socials-analytics .socials-platform-select,
        .socials-analytics .socials-refresh {
          width: 100%;
          min-height: 42px;
        }
        .socials-analytics .socials-range button {
          flex: 1 1 0;
          min-width: 0;
          padding-inline: 8px !important;
        }
        .socials-analytics .socials-stats {
          grid-template-columns: minmax(0, 1fr) !important;
          gap: 10px !important;
        }
        .stat-card {
          padding: 16px !important;
        }
        .socials-analytics .socials-panel {
          padding: 16px !important;
          margin-bottom: 16px !important;
        }
        .socials-analytics .post-card {
          grid-template-columns: 32px minmax(0, 1fr) auto !important;
        }
        .socials-analytics .post-thumbnail {
          display: none;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .socials-analytics *, .socials-analytics *::before, .socials-analytics *::after {
          animation: none !important;
          transition: none !important;
        }
      }
    </style>
  `;
}

// Export for cleanup on navigation
export function cleanupSocialsAnalytics(): void {
  _state = null;
}

// Inject CSS globally (call once)
export function injectSocialsAnalyticsStyles(): void {
  if (document.getElementById("socials-analytics-styles")) return;
  
  const style = document.createElement("style");
  style.id = "socials-analytics-styles";
  style.textContent = `
    .socials-analytics select:focus {
      border-color: ${GOLD};
      box-shadow: 0 0 0 2px ${GOLD_GLOW};
    }
    .socials-analytics button:focus {
      outline: none;
      box-shadow: 0 0 0 2px ${GOLD_DIM};
    }
  `;
  document.head.appendChild(style);
}
