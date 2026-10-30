/**
 * Funnels KPI Dashboard View
 * KPI overview: metrics cards, conversion funnel viz, revenue tracking
 */

import { html, nothing, type TemplateResult } from "lit";
import { icons } from "../icons";
import type { Funnel, FunnelStage } from "./funnels-canvas";

// ══════════════════════════════════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════════════════════════════════

export interface FunnelMetrics {
  totalRevenue: number;
  totalLeads: number;
  overallConversionRate: number;
  avgTimeToConvert: number; // in days
  stageDropoffs: { stageId: string; stageName: string; dropoffRate: number }[];
  revenueByStage: { stageId: string; stageName: string; revenue: number }[];
  dailyStats: { date: string; leads: number; conversions: number; revenue: number }[];
  topPerformingFunnels: { id: string; name: string; conversionRate: number; revenue: number }[];
}

export interface FunnelKPIDashboardProps {
  funnel: Funnel | null;
  allFunnels: Funnel[];
  metrics: FunnelMetrics | null;
  loading: boolean;
  timeRange: "7d" | "30d" | "90d" | "1y";
  view: "overview" | "funnel" | "stages";
  onTimeRangeChange: (range: "7d" | "30d" | "90d" | "1y") => void;
  onViewChange: (view: "overview" | "funnel" | "stages") => void;
  onRefresh: () => void;
  requestUpdate: () => void;
}

// ══════════════════════════════════════════════════════════════════════════════
// Main Render
// ══════════════════════════════════════════════════════════════════════════════

export function renderFunnelKPIDashboard(props: FunnelKPIDashboardProps): TemplateResult {
  const { funnel, metrics, loading, timeRange, view, onTimeRangeChange, onViewChange, onRefresh } = props;

  return html`
    <style>
      ${dashboardStyles}
    </style>
    <div class="funnel-kpi-dashboard">
      <!-- Header -->
      <div class="funnel-kpi-dashboard__header">
        <div class="funnel-kpi-dashboard__title">
          <span>📊</span>
          <h2>${funnel ? funnel.name : "All Funnels"} Analytics</h2>
        </div>
        <div class="funnel-kpi-dashboard__controls">
          <!-- Time Range Selector -->
          <div class="funnel-kpi-dashboard__time-selector">
            ${(["7d", "30d", "90d", "1y"] as const).map(range => html`
              <button class="funnel-kpi-dashboard__time-btn ${timeRange === range ? 'active' : ''}"
                @click=${() => onTimeRangeChange(range)}>
                ${range === "7d" ? "7 Days" : range === "30d" ? "30 Days" : range === "90d" ? "90 Days" : "1 Year"}
              </button>
            `)}
          </div>
          <button class="funnel-kpi-dashboard__refresh-btn" @click=${onRefresh} title="Refresh">
            ${icons.loader}
          </button>
        </div>
      </div>

      <!-- View Tabs -->
      <div class="funnel-kpi-dashboard__view-tabs">
        ${(["overview", "funnel", "stages"] as const).map(v => html`
          <button class="funnel-kpi-dashboard__view-tab ${view === v ? 'active' : ''}"
            @click=${() => onViewChange(v)}>
            ${v === "overview" ? "📈 Overview" : v === "funnel" ? "🔄 Funnel" : "📊 Stages"}
          </button>
        `)}
      </div>

      <!-- Content -->
      <div class="funnel-kpi-dashboard__content">
        ${loading ? html`
          <div class="funnel-kpi-dashboard__loading">
            <div class="funnel-kpi-dashboard__spinner"></div>
            <span>Loading analytics...</span>
          </div>
        ` : metrics ? renderView(props) : html`
          <div class="funnel-kpi-dashboard__empty">
            <span>📊</span>
            <p>No data available for this time period</p>
          </div>
        `}
      </div>
    </div>
  `;
}

function renderView(props: FunnelKPIDashboardProps): TemplateResult {
  const { view } = props;
  switch (view) {
    case "overview":
      return renderOverviewView(props);
    case "funnel":
      return renderFunnelView(props);
    case "stages":
      return renderStagesView(props);
    default:
      return html``;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Overview View
// ══════════════════════════════════════════════════════════════════════════════

function renderOverviewView(props: FunnelKPIDashboardProps): TemplateResult {
  const { metrics } = props;
  if (!metrics) return html``;

  return html`
    <div class="funnel-kpi-dashboard__overview">
      <!-- Key Metrics Cards -->
      <div class="funnel-kpi-dashboard__metrics-grid">
        ${renderMetricCard("💰", "Total Revenue", formatCurrency(metrics.totalRevenue))}
        ${renderMetricCard("👥", "Total Leads", formatNumber(metrics.totalLeads))}
        ${renderMetricCard("📈", "Conversion Rate", `${metrics.overallConversionRate.toFixed(1)}%`)}
        ${renderMetricCard("⏱️", "Avg. Time to Convert", `${metrics.avgTimeToConvert} days`)}
      </div>

      <!-- Revenue Chart -->
      <div class="funnel-kpi-dashboard__chart-section">
        <h3>Revenue Trend</h3>
        ${renderRevenueChart(metrics.dailyStats)}
      </div>

      <!-- Top Performing Funnels -->
      <div class="funnel-kpi-dashboard__top-funnels">
        <h3>Top Performing Funnels</h3>
        ${renderTopFunnelsList(metrics.topPerformingFunnels)}
      </div>
    </div>
  `;
}

function renderMetricCard(icon: string, label: string, value: string): TemplateResult {
  return html`
    <div class="funnel-kpi-dashboard__metric-card">
      <div class="funnel-kpi-dashboard__metric-header">
        <span class="funnel-kpi-dashboard__metric-icon">${icon}</span>
      </div>
      <div class="funnel-kpi-dashboard__metric-value">${value}</div>
      <div class="funnel-kpi-dashboard__metric-label">${label}</div>
    </div>
  `;
}

function renderRevenueChart(dailyStats: { date: string; revenue: number }[]): TemplateResult {
  if (!dailyStats.length) return html`<p class="no-data">No data available</p>`;

  const maxRevenue = Math.max(...dailyStats.map(d => d.revenue), 1);
  const chartHeight = 200;
  const chartWidth = 100; // percentage
  const barWidth = chartWidth / dailyStats.length;

  return html`
    <div class="funnel-kpi-dashboard__chart">
      <div class="funnel-kpi-dashboard__chart-bars">
        ${dailyStats.map((stat, i) => html`
          <div class="funnel-kpi-dashboard__chart-bar-container" style="width: ${barWidth}%">
            <div class="funnel-kpi-dashboard__chart-bar" 
              style="height: ${(stat.revenue / maxRevenue) * 100}%"
              title="${stat.date}: ${formatCurrency(stat.revenue)}">
            </div>
            ${i % Math.ceil(dailyStats.length / 7) === 0 ? html`
              <span class="funnel-kpi-dashboard__chart-label">${formatDate(stat.date)}</span>
            ` : nothing}
          </div>
        `)}
      </div>
      <div class="funnel-kpi-dashboard__chart-y-axis">
        <span>${formatCurrency(maxRevenue)}</span>
        <span>${formatCurrency(maxRevenue / 2)}</span>
        <span>$0</span>
      </div>
    </div>
  `;
}

function renderTopFunnelsList(funnels: { id: string; name: string; conversionRate: number; revenue: number }[]): TemplateResult {
  if (!funnels.length) return html`<p class="no-data">No data available</p>`;

  return html`
    <div class="funnel-kpi-dashboard__funnel-list">
      ${funnels.map((funnel, i) => html`
        <div class="funnel-kpi-dashboard__funnel-item">
          <span class="funnel-kpi-dashboard__funnel-rank">#${i + 1}</span>
          <span class="funnel-kpi-dashboard__funnel-name">${funnel.name}</span>
          <div class="funnel-kpi-dashboard__funnel-stats">
            <span class="funnel-kpi-dashboard__funnel-conversion">${funnel.conversionRate.toFixed(1)}%</span>
            <span class="funnel-kpi-dashboard__funnel-revenue">${formatCurrency(funnel.revenue)}</span>
          </div>
        </div>
      `)}
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Funnel View (Conversion Funnel Visualization)
// ══════════════════════════════════════════════════════════════════════════════

function renderFunnelView(props: FunnelKPIDashboardProps): TemplateResult {
  const { funnel, metrics } = props;
  if (!funnel || !metrics) return html`<p class="no-data">Select a funnel to view its conversion data</p>`;

  // Build stage funnel using actual lead counts from the gateway
  const stageData = funnel.stages.map((stage, i) => {
    const entryCount = stage.leadCount ?? 0;
    const exitCount = i < funnel.stages.length - 1 ? Math.floor(entryCount * (stage.conversionRate || 80) / 100) : entryCount;
    return {
      ...stage,
      entryCount,
      exitCount,
      conversionRate: stage.conversionRate || 80,
    };
  });

  const maxWidth = 100;
  const minWidth = 30;

  return html`
    <div class="funnel-kpi-dashboard__funnel-viz">
      <h3>Conversion Funnel</h3>
      <div class="funnel-kpi-dashboard__funnel-stages">
        ${stageData.map((stage, i) => {
          const widthPercent = maxWidth - ((maxWidth - minWidth) * (i / Math.max(1, stageData.length - 1)));
          const dropoff = i > 0 ? stageData[i-1].entryCount - stage.entryCount : 0;
          
          return html`
            <div class="funnel-kpi-dashboard__funnel-stage">
              <div class="funnel-kpi-dashboard__funnel-bar" style="width: ${widthPercent}%">
                <span class="funnel-kpi-dashboard__funnel-stage-name">${stage.name}</span>
                <span class="funnel-kpi-dashboard__funnel-stage-count">${formatNumber(stage.entryCount)}</span>
              </div>
              ${i > 0 ? html`
                <div class="funnel-kpi-dashboard__funnel-dropoff">
                  <span>↓ ${formatNumber(dropoff)} (${((dropoff / stageData[i-1].entryCount) * 100).toFixed(1)}% drop)</span>
                </div>
              ` : nothing}
            </div>
          `;
        })}
      </div>

      <!-- Stage Breakdown -->
      <div class="funnel-kpi-dashboard__stage-breakdown">
        <h4>Stage Metrics</h4>
        <table class="funnel-kpi-dashboard__stage-table">
          <thead>
            <tr>
              <th>Stage</th>
              <th>Entries</th>
              <th>Exits</th>
              <th>Conv. Rate</th>
              <th>Drop-off</th>
            </tr>
          </thead>
          <tbody>
            ${stageData.map((stage, i) => html`
              <tr>
                <td>${stage.name}</td>
                <td>${formatNumber(stage.entryCount)}</td>
                <td>${formatNumber(stage.exitCount)}</td>
                <td class="highlight">${stage.conversionRate.toFixed(1)}%</td>
                <td class="${100 - stage.conversionRate > 30 ? 'danger' : ''}">${(100 - stage.conversionRate).toFixed(1)}%</td>
              </tr>
            `)}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Stages View (Individual Stage Analytics)
// ══════════════════════════════════════════════════════════════════════════════

function renderStagesView(props: FunnelKPIDashboardProps): TemplateResult {
  const { funnel, metrics } = props;
  if (!funnel) return html`<p class="no-data">Select a funnel to view stage analytics</p>`;

  return html`
    <div class="funnel-kpi-dashboard__stages-view">
      <h3>Stage-by-Stage Analysis</h3>
      <div class="funnel-kpi-dashboard__stages-grid">
        ${funnel.stages.map(stage => renderStageAnalytics(stage, metrics))}
      </div>
    </div>
  `;
}

function renderStageAnalytics(stage: FunnelStage, metrics: FunnelMetrics | null): TemplateResult {
  const stageRevenue = metrics?.revenueByStage.find(r => r.stageId === stage.id)?.revenue || 0;
  const dropoff = metrics?.stageDropoffs.find(d => d.stageId === stage.id)?.dropoffRate || 0;

  return html`
    <div class="funnel-kpi-dashboard__stage-card">
      <div class="funnel-kpi-dashboard__stage-header">
        <h4>${stage.name}</h4>
        <span class="funnel-kpi-dashboard__stage-health ${stage.health}">●</span>
      </div>
      
      <div class="funnel-kpi-dashboard__stage-metrics">
        <div class="funnel-kpi-dashboard__stage-metric">
          <span class="label">Conversion</span>
          <span class="value">${stage.conversionRate || 0}%</span>
          <div class="bar">
            <div class="fill" style="width: ${stage.conversionRate || 0}%"></div>
          </div>
        </div>
        
        <div class="funnel-kpi-dashboard__stage-metric">
          <span class="label">Drop-off</span>
          <span class="value ${dropoff > 30 ? 'danger' : ''}">${dropoff.toFixed(1)}%</span>
          <div class="bar danger">
            <div class="fill" style="width: ${dropoff}%"></div>
          </div>
        </div>

        <div class="funnel-kpi-dashboard__stage-metric">
          <span class="label">Revenue</span>
          <span class="value">${formatCurrency(stageRevenue)}</span>
        </div>
      </div>

      <!-- KPIs -->
      ${stage.kpis.length > 0 ? html`
        <div class="funnel-kpi-dashboard__stage-kpis">
          ${stage.kpis.slice(0, 3).map(kpi => html`
            <div class="funnel-kpi-dashboard__mini-kpi">
              <span class="label">${kpi.label}</span>
              <span class="value">
                ${kpi.unit === "$" ? "$" : ""}${formatNumber(kpi.value)}${kpi.unit === "%" ? "%" : ""}
              </span>
            </div>
          `)}
        </div>
      ` : nothing}
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════════════

function formatCurrency(amount: number): string {
  if (amount >= 1000000) return `$${(amount / 1000000).toFixed(1)}M`;
  if (amount >= 1000) return `$${(amount / 1000).toFixed(1)}K`;
  return `$${amount.toLocaleString()}`;
}

function formatNumber(num: number): string {
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
  return num.toLocaleString();
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

// ══════════════════════════════════════════════════════════════════════════════
// Styles
// ══════════════════════════════════════════════════════════════════════════════

const dashboardStyles = `
  .funnel-kpi-dashboard {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--g-surface);
    overflow: hidden;
  }

  .funnel-kpi-dashboard__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid color-mix(in srgb, var(--g-fg) 8%, transparent);
    background: var(--g-surface);
  }

  .funnel-kpi-dashboard__title {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .funnel-kpi-dashboard__title h2 {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
    color: white;
  }

  .funnel-kpi-dashboard__controls {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .funnel-kpi-dashboard__time-selector {
    display: flex;
    background: color-mix(in srgb, var(--g-fg) 5%, transparent);
    border-radius: 8px;
    padding: 3px;
  }

  .funnel-kpi-dashboard__time-btn {
    padding: 6px 12px;
    background: transparent;
    border: none;
    border-radius: 6px;
    color: color-mix(in srgb, var(--g-fg) 50%, transparent);
    font-size: 12px;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .funnel-kpi-dashboard__time-btn:hover {
    color: white;
  }

  .funnel-kpi-dashboard__time-btn.active {
    background: var(--info, var(--glass-gold));
    color: white;
  }

  .funnel-kpi-dashboard__refresh-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    background: transparent;
    border: 1px solid color-mix(in srgb, var(--g-fg) 10%, transparent);
    border-radius: 8px;
    color: color-mix(in srgb, var(--g-fg) 50%, transparent);
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .funnel-kpi-dashboard__refresh-btn:hover {
    background: color-mix(in srgb, var(--g-fg) 5%, transparent);
    color: white;
  }

  .funnel-kpi-dashboard__refresh-btn svg {
    width: 16px;
    height: 16px;
    stroke: currentColor;
    stroke-width: 2;
    fill: none;
  }

  .funnel-kpi-dashboard__view-tabs {
    display: flex;
    padding: 0 20px;
    border-bottom: 1px solid color-mix(in srgb, var(--g-fg) 8%, transparent);
    background: var(--g-surface);
  }

  .funnel-kpi-dashboard__view-tab {
    padding: 12px 16px;
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    color: color-mix(in srgb, var(--g-fg) 50%, transparent);
    font-size: 13px;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .funnel-kpi-dashboard__view-tab:hover {
    color: white;
  }

  .funnel-kpi-dashboard__view-tab.active {
    color: var(--info, var(--glass-gold));
    border-bottom-color: var(--info, var(--glass-gold));
  }

  .funnel-kpi-dashboard__content {
    flex: 1;
    overflow-y: auto;
    padding: 20px;
  }

  .funnel-kpi-dashboard__loading,
  .funnel-kpi-dashboard__empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: color-mix(in srgb, var(--g-fg) 40%, transparent);
    gap: 12px;
  }

  .funnel-kpi-dashboard__spinner {
    width: 32px;
    height: 32px;
    border: 3px solid color-mix(in srgb, var(--g-fg) 10%, transparent);
    border-top-color: var(--info, var(--glass-gold));
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }

  .funnel-kpi-dashboard__empty span {
    font-size: 48px;
  }

  .no-data {
    text-align: center;
    color: color-mix(in srgb, var(--g-fg) 40%, transparent);
    padding: 24px;
  }

  /* Overview View */
  .funnel-kpi-dashboard__overview {
    display: flex;
    flex-direction: column;
    gap: 24px;
  }

  .funnel-kpi-dashboard__metrics-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 16px;
  }

  @media (max-width: 1200px) {
    .funnel-kpi-dashboard__metrics-grid {
      grid-template-columns: repeat(2, 1fr);
    }
  }

  .funnel-kpi-dashboard__metric-card {
    padding: 20px;
    background: var(--g-surface);
    border: 1px solid color-mix(in srgb, var(--g-fg) 8%, transparent);
    border-radius: 12px;
  }

  .funnel-kpi-dashboard__metric-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
  }

  .funnel-kpi-dashboard__metric-icon {
    font-size: 24px;
  }

  .funnel-kpi-dashboard__metric-change {
    font-size: 12px;
    font-weight: 500;
    padding: 2px 8px;
    border-radius: 4px;
  }

  .funnel-kpi-dashboard__metric-change.up {
    color: var(--ok, #22c55e);
    background: rgba(16, 185, 129, 0.15);
  }

  .funnel-kpi-dashboard__metric-change.down {
    color: var(--destructive, #ef4444);
    background: rgba(239, 68, 68, 0.15);
  }

  .funnel-kpi-dashboard__metric-value {
    font-size: 28px;
    font-weight: 700;
    color: white;
    margin-bottom: 4px;
  }

  .funnel-kpi-dashboard__metric-label {
    font-size: 13px;
    color: color-mix(in srgb, var(--g-fg) 50%, transparent);
  }

  /* Chart Section */
  .funnel-kpi-dashboard__chart-section {
    padding: 20px;
    background: var(--g-surface);
    border: 1px solid color-mix(in srgb, var(--g-fg) 8%, transparent);
    border-radius: 12px;
  }

  .funnel-kpi-dashboard__chart-section h3 {
    margin: 0 0 16px 0;
    font-size: 16px;
    font-weight: 600;
    color: white;
  }

  .funnel-kpi-dashboard__chart {
    position: relative;
    height: 200px;
    display: flex;
  }

  .funnel-kpi-dashboard__chart-bars {
    flex: 1;
    display: flex;
    align-items: flex-end;
    gap: 2px;
    padding-right: 60px;
  }

  .funnel-kpi-dashboard__chart-bar-container {
    display: flex;
    flex-direction: column;
    align-items: center;
    height: 100%;
    justify-content: flex-end;
  }

  .funnel-kpi-dashboard__chart-bar {
    width: 80%;
    background: linear-gradient(to top, var(--info, var(--glass-gold)), color-mix(in srgb, var(--info, var(--glass-gold)) 70%, white));
    border-radius: 2px 2px 0 0;
    transition: all 0.3s ease;
  }

  .funnel-kpi-dashboard__chart-bar:hover {
    background: linear-gradient(to top, color-mix(in srgb, var(--info, var(--glass-gold)) 85%, black), var(--info, var(--glass-gold)));
  }

  .funnel-kpi-dashboard__chart-label {
    font-size: 10px;
    color: color-mix(in srgb, var(--g-fg) 40%, transparent);
    margin-top: 8px;
    white-space: nowrap;
  }

  .funnel-kpi-dashboard__chart-y-axis {
    position: absolute;
    right: 0;
    top: 0;
    bottom: 0;
    width: 50px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    font-size: 10px;
    color: color-mix(in srgb, var(--g-fg) 40%, transparent);
    text-align: right;
  }

  /* Top Funnels */
  .funnel-kpi-dashboard__top-funnels {
    padding: 20px;
    background: var(--g-surface);
    border: 1px solid color-mix(in srgb, var(--g-fg) 8%, transparent);
    border-radius: 12px;
  }

  .funnel-kpi-dashboard__top-funnels h3 {
    margin: 0 0 16px 0;
    font-size: 16px;
    font-weight: 600;
    color: white;
  }

  .funnel-kpi-dashboard__funnel-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .funnel-kpi-dashboard__funnel-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px;
    background: color-mix(in srgb, var(--g-fg) 3%, transparent);
    border-radius: 8px;
  }

  .funnel-kpi-dashboard__funnel-rank {
    width: 24px;
    font-size: 12px;
    font-weight: 600;
    color: var(--info, var(--glass-gold));
  }

  .funnel-kpi-dashboard__funnel-name {
    flex: 1;
    font-size: 14px;
    color: white;
  }

  .funnel-kpi-dashboard__funnel-stats {
    display: flex;
    gap: 16px;
  }

  .funnel-kpi-dashboard__funnel-conversion {
    font-size: 13px;
    color: var(--ok, #22c55e);
    font-weight: 500;
  }

  .funnel-kpi-dashboard__funnel-revenue {
    font-size: 13px;
    color: color-mix(in srgb, var(--g-fg) 70%, transparent);
  }

  /* Funnel View */
  .funnel-kpi-dashboard__funnel-viz {
    padding: 20px;
    background: var(--g-surface);
    border: 1px solid color-mix(in srgb, var(--g-fg) 8%, transparent);
    border-radius: 12px;
  }

  .funnel-kpi-dashboard__funnel-viz h3 {
    margin: 0 0 24px 0;
    font-size: 16px;
    font-weight: 600;
    color: white;
  }

  .funnel-kpi-dashboard__funnel-stages {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    margin-bottom: 32px;
  }

  .funnel-kpi-dashboard__funnel-stage {
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  .funnel-kpi-dashboard__funnel-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 16px 20px;
    background: linear-gradient(90deg, color-mix(in srgb, var(--glass-gold) 30%, transparent), color-mix(in srgb, var(--glass-gold) 10%, transparent));
    border: 1px solid color-mix(in srgb, var(--glass-gold) 30%, transparent);
    border-radius: 8px;
    transition: all 0.3s ease;
  }

  .funnel-kpi-dashboard__funnel-bar:hover {
    background: linear-gradient(90deg, color-mix(in srgb, var(--glass-gold) 40%, transparent), color-mix(in srgb, var(--glass-gold) 20%, transparent));
  }

  .funnel-kpi-dashboard__funnel-stage-name {
    font-size: 14px;
    font-weight: 500;
    color: white;
  }

  .funnel-kpi-dashboard__funnel-stage-count {
    font-size: 16px;
    font-weight: 700;
    color: var(--info, var(--glass-gold));
  }

  .funnel-kpi-dashboard__funnel-dropoff {
    padding: 8px 0;
    font-size: 11px;
    color: var(--destructive, #ef4444);
  }

  .funnel-kpi-dashboard__stage-breakdown {
    margin-top: 24px;
  }

  .funnel-kpi-dashboard__stage-breakdown h4 {
    margin: 0 0 16px 0;
    font-size: 14px;
    font-weight: 600;
    color: color-mix(in srgb, var(--g-fg) 80%, transparent);
  }

  .funnel-kpi-dashboard__stage-table {
    width: 100%;
    border-collapse: collapse;
  }

  .funnel-kpi-dashboard__stage-table th,
  .funnel-kpi-dashboard__stage-table td {
    padding: 12px;
    text-align: left;
    border-bottom: 1px solid color-mix(in srgb, var(--g-fg) 8%, transparent);
  }

  .funnel-kpi-dashboard__stage-table th {
    font-size: 11px;
    font-weight: 600;
    color: color-mix(in srgb, var(--g-fg) 50%, transparent);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .funnel-kpi-dashboard__stage-table td {
    font-size: 13px;
    color: color-mix(in srgb, var(--g-fg) 80%, transparent);
  }

  .funnel-kpi-dashboard__stage-table td.highlight {
    color: var(--ok, #22c55e);
    font-weight: 500;
  }

  .funnel-kpi-dashboard__stage-table td.danger {
    color: var(--destructive, #ef4444);
  }

  /* Stages View */
  .funnel-kpi-dashboard__stages-view h3 {
    margin: 0 0 20px 0;
    font-size: 16px;
    font-weight: 600;
    color: white;
  }

  .funnel-kpi-dashboard__stages-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 16px;
  }

  .funnel-kpi-dashboard__stage-card {
    padding: 16px;
    background: var(--g-surface);
    border: 1px solid color-mix(in srgb, var(--g-fg) 8%, transparent);
    border-radius: 12px;
  }

  .funnel-kpi-dashboard__stage-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
  }

  .funnel-kpi-dashboard__stage-header h4 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    color: white;
  }

  .funnel-kpi-dashboard__stage-health {
    font-size: 12px;
  }

  .funnel-kpi-dashboard__stage-health.healthy { color: var(--ok, #22c55e); }
  .funnel-kpi-dashboard__stage-health.warning { color: var(--warn, #f59e0b); }
  .funnel-kpi-dashboard__stage-health.critical { color: var(--destructive, #ef4444); }

  .funnel-kpi-dashboard__stage-metrics {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .funnel-kpi-dashboard__stage-metric {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }

  .funnel-kpi-dashboard__stage-metric .label {
    font-size: 12px;
    color: color-mix(in srgb, var(--g-fg) 50%, transparent);
    min-width: 80px;
  }

  .funnel-kpi-dashboard__stage-metric .value {
    font-size: 14px;
    font-weight: 600;
    color: white;
  }

  .funnel-kpi-dashboard__stage-metric .value.danger {
    color: var(--destructive, #ef4444);
  }

  .funnel-kpi-dashboard__stage-metric .bar {
    flex: 1;
    min-width: 60px;
    height: 6px;
    background: color-mix(in srgb, var(--g-fg) 10%, transparent);
    border-radius: 3px;
  }

  .funnel-kpi-dashboard__stage-metric .bar .fill {
    height: 100%;
    background: var(--info, var(--glass-gold));
    border-radius: 3px;
  }

  .funnel-kpi-dashboard__stage-metric .bar.danger .fill {
    background: var(--destructive, #ef4444);
  }

  .funnel-kpi-dashboard__stage-kpis {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 16px;
    padding-top: 16px;
    border-top: 1px solid color-mix(in srgb, var(--g-fg) 8%, transparent);
  }

  .funnel-kpi-dashboard__mini-kpi {
    display: flex;
    flex-direction: column;
    padding: 8px 12px;
    background: color-mix(in srgb, var(--g-fg) 3%, transparent);
    border-radius: 6px;
  }

  .funnel-kpi-dashboard__mini-kpi .label {
    font-size: 10px;
    color: color-mix(in srgb, var(--g-fg) 40%, transparent);
    margin-bottom: 2px;
  }

  .funnel-kpi-dashboard__mini-kpi .value {
    font-size: 13px;
    font-weight: 600;
    color: white;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }
`;
