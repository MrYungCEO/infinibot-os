/**
 * Tokens & Subscriptions dashboard.
 *
 * This product has NO "credits" — usage is BYOK (the user brings their own LLM
 * keys / CLI subscriptions) and licensing is via Whop + KinglyVault. So this
 * page surfaces only real numbers: real token counts per provider/agent/session,
 * real subscription plans + quota from each provider/CLI, and an *approximate*
 * USD spend derived from the pricing tables (for the BYOK user's own awareness).
 *
 * Reads from the `credits.*` gateway methods via the controller in
 * `controllers/credits.ts`. NOTE: the RPC names keep their `credits.*` wire
 * identity for backward compatibility — renaming them would require a gateway
 * restart and break every existing consumer. Only the UI concept + strings are
 * "tokens" / "subscriptions". Matches the dark + gold HUD palette.
 */

import { html, svg, nothing, type TemplateResult } from "lit";

import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";
import { openSubagentDetailModal } from "../components/subagent-detail-modal";
import {
  closeBudgetDraft,
  deleteBudget,
  exportRecentCsv,
  loadCredits,
  openBudgetDraft,
  saveBudgetDraft,
  setCreditsBucket,
  setCreditsFilter,
  setCreditsGroupBy,
  setCreditsMetric,
  setCreditsPeriod,
  syncProvider,
  openPlanDraft,
  closePlanDraft,
  savePlanDraft,
  refreshPlan,
  testPlanConnection,
  updatePlanDraft,
  setProviderPlan,
  setProviderAuto,
  type CreditsBudget,
  type CreditsBucket,
  type CreditsState,
  type CreditsProviderPlan,
  type CreditsPlanDraft,
  type CreditsTimeseriesPoint,
} from "../controllers/credits";
import { baAurora } from "./ba-glass";
import "./ba-glass/credits.css";

// ── Styles ─────────────────────────────────────────────────
// Glass skin lives in ./ba-glass/credits.css (token-based, so light theme,
// reduced transparency and reduced motion follow automatically).

// ── Formatting helpers ────────────────────────────────────────

const usd = (n: number): string =>
  n >= 1000
    ? `$${(n / 1000).toFixed(2)}k`
    : n >= 1
      ? `$${n.toFixed(2)}`
      : n > 0
        ? `$${n.toFixed(4)}`
        : "$0";

const compact = (n: number): string => {
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
};

const fmtRelative = (ts?: number): string => {
  if (!ts) return "never";
  const diff = Date.now() - ts;
  if (diff < 0) return "—";
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
};

// Black-gold chart palette (CSS custom properties defined in credits.css so
// they follow the theme). Gold leads; status hues keep series distinguishable.
const SERIES_VARS = ["--cr-s1", "--cr-s2", "--cr-s3", "--cr-s4", "--cr-s5", "--cr-s6", "--cr-s7", "--cr-s8"];
function seriesColor(index: number): string {
  return `var(${SERIES_VARS[index % SERIES_VARS.length]})`;
}

// Shared guiding empty state (icon + title + one-line next action).
function crEmpty(title: string, hint?: string, compact = false): TemplateResult {
  return html`<div class="cr-empty ${compact ? "cr-empty--compact" : ""}">
    <span class="cr-empty-glyph" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/></svg></span>
    <span class="cr-empty-title">${title}</span>
    ${hint ? html`<span class="cr-empty-hint">${hint}</span>` : nothing}
  </div>`;
}

// ── Inline SVG: stacked-area chart ────────────────────────────

// Pick the numeric value for the active metric from a series entry.
function metricValue(
  entry: { tokens: number; costUsd: number; requests: number } | undefined,
  metric: CreditsState["metric"],
): number {
  if (!entry) return 0;
  return metric === "cost" ? entry.costUsd : metric === "requests" ? entry.requests : entry.tokens;
}

// Format an x-axis bucket timestamp according to bucket granularity.
function fmtBucketTick(ts: number, bucket: CreditsBucket): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (bucket === "minute") return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (bucket === "hour") return `${pad(d.getHours())}:00`;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[d.getMonth()]} ${d.getDate()}`;
}

function renderChart(
  points: CreditsTimeseriesPoint[],
  metric: CreditsState["metric"],
  bucket: CreditsBucket,
): TemplateResult {
  if (!points || points.length === 0) {
    return crEmpty("No usage in this range yet", "Record an LLM call, then press Refresh — or widen the period.");
  }
  const width = 1000;
  const height = 260;
  const padX = 40;
  const padY = 16;
  const labelPad = 22; // room at bottom for x-axis labels

  const fmt = metric === "cost" ? usd : compact;

  const allKeys = new Set<string>();
  for (const p of points) for (const k of Object.keys(p.series)) allKeys.add(k);
  const keys = Array.from(allKeys).sort();

  const totals: number[] = points.map((p) =>
    keys.reduce((sum, k) => sum + metricValue(p.series[k], metric), 0),
  );
  const max = Math.max(0.0001, ...totals);

  const xs = (i: number) =>
    points.length === 1 ? padX + (width - padX * 2) / 2 : padX + (i / (points.length - 1)) * (width - padX * 2);
  const ys = (v: number) => (height - labelPad) - padY - (v / max) * ((height - labelPad) - padY * 2);

  // Stack series bottom-up.
  const stacks = points.map((p) => {
    let acc = 0;
    return keys.map((k) => {
      const v = metricValue(p.series[k], metric);
      const bottom = acc;
      acc += v;
      return { bottom, top: acc };
    });
  });

  const paths = keys.map((k, ki) => {
    const top = points.map((_, pi) => `${xs(pi)},${ys(stacks[pi][ki].top)}`).join(" L");
    const bot = points.map((_, pi) => `${xs(pi)},${ys(stacks[pi][ki].bottom)}`).reverse().join(" L");
    return svg`<path class="cr-area" d="M${top} L${bot} Z" style="fill:${seriesColor(ki)};stroke:${seriesColor(ki)}" stroke-width="1" />`;
  });

  // Y-axis ticks
  const ticks = [0, 0.5, 1].map((t) => {
    const y = ys(max * t);
    return svg`<line class="cr-grid-line" x1="${padX}" x2="${width - padX}" y1="${y}" y2="${y}" />
      <text class="cr-axis" x="${padX - 6}" y="${y + 3}" text-anchor="end" font-size="10">${fmt(max * t)}</text>`;
  });

  // X-axis time labels — up to ~6 evenly spaced.
  const step = Math.max(1, Math.ceil(points.length / 6));
  const yLabel = height - labelPad + 14;
  const xLabels = points
    .map((p, i) => ({ p, i }))
    .filter(({ i }) => i % step === 0 || i === points.length - 1)
    .map(({ p, i }) => {
      const anchor = i === 0 ? "start" : i === points.length - 1 ? "end" : "middle";
      return svg`<text class="cr-axis" x="${xs(i)}" y="${yLabel}" text-anchor="${anchor}" font-size="10">${fmtBucketTick(p.bucketStart, bucket)}</text>`;
    });

  return html`
    <svg class="cr-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${metric} over time">
      ${ticks}
      ${paths}
      ${xLabels}
    </svg>
    <div class="cr-legend">
      ${keys.map((k, ki) => html`<span class="cr-legend-item"><span class="cr-legend-swatch" style="background:${seriesColor(ki)}"></span>${k}</span>`)}
    </div>
  `;
}

// Top models table — driven by summary.byModel.
function renderTopModels(s: CreditsState): TemplateResult {
  const rows = s.summary?.byModel ?? [];
  if (rows.length === 0) return crEmpty("No model-tagged usage yet", "Model rows appear once agents make LLM calls.", true);
  const total = rows.reduce((acc, r) => acc + r.costUsd, 0) || 1;
  return html`
    <div class="cr-table-wrap"><table class="cr-table">
      <thead><tr><th>Model</th><th>Provider</th><th class="r">Requests</th><th class="r">Tokens</th><th class="r">USD</th><th class="r">%</th></tr></thead>
      <tbody>
        ${rows.map((r) => html`
          <tr>
            <td><code>${r.model}</code></td>
            <td>${r.provider}</td>
            <td class="r">${compact(r.requests)}</td>
            <td class="r">${compact(r.tokens)}</td>
            <td class="r">${usd(r.costUsd)}</td>
            <td class="r">${((r.costUsd / total) * 100).toFixed(1)}%</td>
          </tr>
        `)}
      </tbody>
    </table></div>
  `;
}

// ── Plan status cards (rings) ─────────────────────────────────

// Friendly backend label + the CLI each provider maps to.
const PROVIDER_META: Record<string, { label: string; cli: string }> = {
  anthropic: { label: "Claude", cli: "claude" },
  openai: { label: "Codex", cli: "codex" },
  opencode: { label: "OpenCode", cli: "opencode" },
  google: { label: "Gemini", cli: "gemini" },
};

// Map a puller status to a short human banner for the card.
function planStatusBanner(p: CreditsProviderPlan): { text: string; tone: "ok" | "warn" | "muted" } {
  const u = p.usage;
  if (u.status === "unsupported" && /not installed/i.test(u.message ?? "")) {
    return { text: "CLI not installed", tone: "muted" };
  }
  if (u.status === "missing-credentials") return { text: "Auth required", tone: "warn" };
  if (u.status === "error") return { text: "Error", tone: "warn" };
  if (u.source === "api") return { text: "Live", tone: "ok" };
  return { text: "Estimated", tone: "muted" };
}

// Format a "resets in …" string from a period-end timestamp.
function fmtResetIn(periodEnd?: number): string {
  if (!periodEnd) return "—";
  const diff = periodEnd - Date.now();
  if (diff <= 0) return "—";
  const days = Math.floor(diff / 86_400_000);
  const hours = Math.floor((diff % 86_400_000) / 3_600_000);
  if (days >= 1) return `${days}d ${hours}h`;
  const mins = Math.floor((diff % 3_600_000) / 60_000);
  return `${hours}h ${mins}m`;
}

// One progress ring (donut arc) for a used/limit pair. pct in 0..100.
function progressRing(pct: number | null, centerLabel: string, tone: "ok" | "warn" | "bad" | "muted"): TemplateResult {
  const size = 88;
  const stroke = 9;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const filled = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  const dash = (filled / 100) * circ;
  // Gauge semantics: brand gold while healthy, warn/bad status hues near the
  // limit, a dotted muted ring when there is no limit to measure against.
  return html`
    <svg class="cr-ring cr-ring--${tone}" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"
      role="img" aria-label=${pct != null ? `${Math.round(pct)}% of limit used` : "No limit set"}>
      <g transform="rotate(-90 ${size / 2} ${size / 2})">
        <circle class="cr-ring-track" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="${stroke}" />
        ${pct != null
          ? svg`<circle class="cr-ring-fill" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none"
              stroke-width="${stroke}" stroke-linecap="round"
              stroke-dasharray="${dash.toFixed(1)} ${(circ - dash).toFixed(1)}" />`
          : svg`<circle class="cr-ring-fill cr-ring-fill--none" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none"
              stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="3 7" />`}
      </g>
      <text class="cr-ring-label" x="${size / 2}" y="${size / 2}" text-anchor="middle" dominant-baseline="central"
        font-size="17" font-weight="660">${centerLabel}</text>
    </svg>
  `;
}

function renderPlanCards(s: CreditsState, host: AppLike, client: GatewayBrowserClient): TemplateResult {
  const plans = s.providerPlans ?? [];
  if (plans.length === 0) {
    if (s.loading && !s.lastLoadedAt) {
      return html`<div class="cr-cards" aria-busy="true">
        ${[0, 1, 2, 3].map(() => html`<div class="cr-card cr-card--skel"><span class="bag-skel" style="width:40%"></span><span class="bag-skel" style="width:70%;min-height:76px"></span><span class="bag-skel" style="width:55%"></span></div>`)}
      </div>`;
    }
    return crEmpty("No backends tracked yet", "Configure a plan in “Provider plans & usage” below to start tracking quota.");
  }
  // Stable order: Claude, Codex, OpenCode, Gemini, then any others.
  const order = ["anthropic", "openai", "opencode", "google"];
  const sorted = [...plans].sort(
    (a, b) => (order.indexOf(a.provider) + 1 || 99) - (order.indexOf(b.provider) + 1 || 99),
  );
  return html`
    <div class="cr-cards">
      ${sorted.map((p) => {
        const meta = PROVIDER_META[p.provider] ?? { label: p.provider, cli: p.provider };
        const u = p.usage;
        const used = u.usedUsd ?? 0;
        const limit = u.limitUsd;
        const pct = limit && limit > 0 ? (used / limit) * 100 : null;
        const tone: "ok" | "warn" | "bad" | "muted" =
          pct == null ? "muted" : pct >= 95 ? "bad" : pct >= 80 ? "warn" : "ok";
        const banner = planStatusBanner(p);
        const busy = s.refreshingPlan === p.provider;
        const center = pct != null ? `${Math.round(pct)}%` : "∙";
        const auto = p.config.auto ?? true;
        const detected = u.detectedPlan;
        const detectedLabel = p.availablePlans.find((o) => o.id === detected)?.label ?? detected;
        // Suggest the CLI-detected plan only when the user has pinned a different
        // one — never silently overwrite a manual selection.
        const showDetectPrompt = !auto && !!detected && detected !== p.config.plan;
        return html`
          <div class="cr-card ${tone === "bad" ? "bad" : tone === "warn" ? "warn" : ""}" data-provider=${p.provider}>
            <div class="cr-card-head">
              <div>
                <div class="cr-card-title">${meta.label}</div>
                <div class="cr-card-picker">
                  <select
                    class="cr-plan-select"
                    title=${auto ? "Auto-detected from CLI — toggle Auto off to pick manually" : "Pinned plan"}
                    ?disabled=${auto || busy}
                    .value=${p.config.plan}
                    @change=${(e: Event) => {
                      const v = (e.target as HTMLSelectElement).value;
                      const lbl = p.availablePlans.find((o) => o.id === v)?.label;
                      void setProviderPlan(host, client, p.provider, v, lbl);
                    }}>
                    ${p.availablePlans.map(
                      (o) => html`<option value="${o.id}" ?selected=${p.config.plan === o.id}>${o.label}</option>`,
                    )}
                  </select>
                  <button
                    class="cr-auto-toggle ${auto ? "on" : ""}"
                    ?disabled=${busy}
                    title=${auto ? "CLI auto-detect ON — plan follows your subscription" : "Pinned — click to follow CLI detection"}
                    @click=${() => void setProviderAuto(host, client, p.provider, !auto)}>
                    ${auto ? "Auto" : "Manual"}
                  </button>
                </div>
              </div>
              <span class="cr-badge ${banner.tone}">
                <span class="cr-status-dot ${u.status}"></span>${banner.text}
              </span>
            </div>
            ${showDetectPrompt
              ? html`<div class="cr-detect-prompt">
                  CLI says <b>${detectedLabel}</b> —
                  <button class="cr-link" @click=${() => void setProviderPlan(host, client, p.provider, detected!, detectedLabel ?? undefined)}>use detected</button>
                </div>`
              : nothing}
            <div class="cr-card-body">
              ${progressRing(pct, center, tone)}
              <div class="cr-card-stats">
                <div class="cr-card-used">${usd(used)}</div>
                <div class="cr-card-limit">${limit ? `of ${usd(limit)}` : "no limit set"}</div>
                <div class="cr-card-reset">resets in ${fmtResetIn(u.periodEnd)}</div>
                ${u.usedTokens ? html`<div class="cr-card-reset">${compact(u.usedTokens)} tok</div>` : nothing}
              </div>
            </div>
            <div class="cr-card-foot">
              <button class="cr-btn sm" ?disabled=${busy} @click=${() => refreshPlan(host, client, p.provider)}>
                ${busy ? "Refreshing…" : "Refresh"}
              </button>
              <button class="cr-btn sm" @click=${() => openPlanDraft(host, p)}>Edit plan</button>
            </div>
            ${u.message ? html`<div class="cr-card-msg" title="${u.message}">${u.message}</div>` : nothing}
          </div>
        `;
      })}
    </div>
  `;
}

// ── Token-share donut (input / output / cache read / cache write) ──

function renderTokenDonut(s: CreditsState): TemplateResult {
  const sum = s.summary;
  const segments = [
    { key: "input", label: "Input", value: sum?.totalTokensIn ?? 0, color: "var(--cr-s1)" },
    { key: "output", label: "Output", value: sum?.totalTokensOut ?? 0, color: "var(--cr-s2)" },
    { key: "cacheRead", label: "Cache read", value: sum?.totalCacheReadTokens ?? 0, color: "var(--cr-s3)" },
    { key: "cacheWrite", label: "Cache write", value: sum?.totalCacheWriteTokens ?? 0, color: "var(--cr-s4)" },
  ];
  const total = segments.reduce((acc, seg) => acc + seg.value, 0);
  if (total <= 0) {
    return crEmpty("No token usage in this range yet", "Try a wider period such as Month or All.");
  }
  const size = 200;
  const stroke = 34;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  let offset = 0;
  const arcs = segments
    .filter((seg) => seg.value > 0)
    .map((seg) => {
      const frac = seg.value / total;
      const dash = frac * circ;
      const arc = svg`<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" style="stroke:${seg.color}"
        stroke-width="${stroke}" stroke-dasharray="${dash.toFixed(1)} ${(circ - dash).toFixed(1)}"
        stroke-dashoffset="${(-offset).toFixed(1)}" />`;
      offset += dash;
      return arc;
    });
  return html`
    <div class="cr-donut">
      <svg class="cr-donut-svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="Token share">
        <g transform="rotate(-90 ${size / 2} ${size / 2})">
          <circle class="cr-ring-track" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="${stroke}" />
          ${arcs}
        </g>
        <text class="cr-donut-total" x="${size / 2}" y="${size / 2 - 7}" text-anchor="middle" dominant-baseline="central"
          font-size="24" font-weight="660">${compact(total)}</text>
        <text class="cr-donut-cap" x="${size / 2}" y="${size / 2 + 16}" text-anchor="middle" dominant-baseline="central"
          font-size="11">total tokens</text>
      </svg>
      <div class="cr-donut-legend">
        ${segments.map((seg) => {
          const pct = total > 0 ? (seg.value / total) * 100 : 0;
          return html`
            <div class="cr-donut-row">
              <span class="cr-legend-swatch" style="background:${seg.color}"></span>
              <span class="cr-donut-name">${seg.label}</span>
              <span class="cr-donut-val">${compact(seg.value)}</span>
              <span class="cr-donut-pct">${pct.toFixed(1)}%</span>
            </div>
          `;
        })}
      </div>
    </div>
  `;
}

// ── Per-agent token breakdown ─────────────────────────────────
// Real per-backend token figures (input / output / cache-read / cache-write +
// approx USD) for each running/recent agent. Sourced by aggregating the real
// ledger entries in `s.recent` by `agentBackend` — these rows carry the full
// token split that `summary.byBackend` omits. Codex `tokensOut` already
// includes reasoning tokens (no double-add).

interface AgentTokenRow {
  backend: string;
  label: string;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  requests: number;
  lastTs: number;
}

// Friendly label for an agent backend slug.
function agentBackendLabel(b: string): string {
  switch (b) {
    case "claude-code": return "Claude Code";
    case "codex": return "Codex";
    case "opencode": return "OpenCode";
    case "gemini": return "Gemini";
    case "voice": return "Voice";
    case "native": return "Native";
    case "direct-api": return "Direct API";
    case "ollama-local": return "Ollama (Local)";
    case "ollama-cloud": return "Ollama (Cloud)";
    case "mcp": return "MCP";
    case "gateway": return "Gateway";
    case "":
    case "unknown": return "Unknown";
    default: return b.replace(/(^|[-_])(\w)/g, (_, sep, c) => (sep ? " " : "") + c.toUpperCase());
  }
}

function aggregateAgentTokens(s: CreditsState): AgentTokenRow[] {
  const agg = new Map<string, AgentTokenRow>();
  for (const e of s.recent) {
    const backend = e.agentBackend || "unknown";
    const row = agg.get(backend) ?? {
      backend,
      label: agentBackendLabel(backend),
      tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0,
      costUsd: 0, requests: 0, lastTs: 0,
    };
    row.tokensIn += e.tokensIn || 0;
    row.tokensOut += e.tokensOut || 0;
    row.cacheRead += e.cacheReadTokens || 0;
    row.cacheWrite += e.cacheWriteTokens || 0;
    row.costUsd += e.costUsd || 0;
    row.requests += 1;
    row.lastTs = Math.max(row.lastTs, e.timestamp || 0);
    agg.set(backend, row);
  }
  return [...agg.values()].sort(
    (a, b) => (b.tokensIn + b.tokensOut) - (a.tokensIn + a.tokensOut),
  );
}

function renderAgentTokens(s: CreditsState): TemplateResult {
  const rows = aggregateAgentTokens(s);
  if (rows.length === 0) {
    return crEmpty("No agent token usage yet", "Spawn an agent, then press Refresh to see its input, output and cache tokens.");
  }
  return html`
    <div class="cr-table-wrap"><table class="cr-table">
      <thead>
        <tr>
          <th>Agent backend</th>
          <th class="r">Input</th>
          <th class="r">Output</th>
          <th class="r">Cache read</th>
          <th class="r">Cache write</th>
          <th class="r">Runs</th>
          <th class="r" title="Approximate, derived from pricing tables">Approx USD</th>
          <th class="r">Last</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((r) => html`
          <tr>
            <td><span class="cr-strong">${r.label}</span> <span class="cr-dim">${r.backend}</span></td>
            <td class="r">${compact(r.tokensIn)}</td>
            <td class="r">${compact(r.tokensOut)}</td>
            <td class="r">${r.cacheRead ? compact(r.cacheRead) : "—"}</td>
            <td class="r">${r.cacheWrite ? compact(r.cacheWrite) : "—"}</td>
            <td class="r">${compact(r.requests)}</td>
            <td class="r">${usd(r.costUsd)}</td>
            <td class="r cr-dim" title="${r.lastTs ? new Date(r.lastTs).toISOString() : ""}">${fmtRelative(r.lastTs)}</td>
          </tr>
        `)}
      </tbody>
    </table></div>
  `;
}

// ── Sub-panels ────────────────────────────────────────────────

function renderKpis(s: CreditsState): TemplateResult {
  const sum = s.summary;
  const dash = s.dashboard;
  const monthTotal = dash?.totalMonthlyCostUsd ?? sum?.totalCostUsd ?? 0;
  const subUsd = dash?.totalSubscriptionUsd ?? 0;
  const usageUsd = dash?.totalUsageUsd ?? sum?.totalCostUsd ?? 0;
  return html`
    <div class="cr-kpi-grid" aria-busy=${s.loading && !s.lastLoadedAt ? "true" : "false"}>
      <div class="cr-tile cr-tile--hero">
        <div class="cr-tile-label">Approx total this month</div>
        <div class="cr-tile-value">${usd(monthTotal)}</div>
        <div class="cr-tile-sub">${usd(subUsd)} subscriptions + ${usd(usageUsd)} usage (approx)</div>
      </div>
      <div class="cr-tile">
        <div class="cr-tile-label">Approx USD spend · ${s.period}</div>
        <div class="cr-tile-value">${usd(sum?.totalCostUsd ?? 0)}</div>
        <div class="cr-tile-sub">${compact(sum?.totalRequests ?? 0)} requests · derived from pricing</div>
      </div>
      <div class="cr-tile">
        <div class="cr-tile-label">Tokens in</div>
        <div class="cr-tile-value">${compact(sum?.totalTokensIn ?? 0)}</div>
        <div class="cr-tile-sub">cache read: ${compact(sum?.totalCacheReadTokens ?? 0)}</div>
      </div>
      <div class="cr-tile">
        <div class="cr-tile-label">Tokens out</div>
        <div class="cr-tile-value">${compact(sum?.totalTokensOut ?? 0)}</div>
        <div class="cr-tile-sub">cache write: ${compact(sum?.totalCacheWriteTokens ?? 0)}</div>
      </div>
      <div class="cr-tile">
        <div class="cr-tile-label">Autonomous</div>
        <div class="cr-tile-value">${(sum?.autonomousPercent ?? 0).toFixed(1)}%</div>
        <div class="cr-tile-sub">of token volume</div>
      </div>
    </div>
  `;
}

function renderSubscriptions(s: CreditsState): TemplateResult {
  const subs = s.dashboard?.subscriptions ?? [];
  if (subs.length === 0) {
    return crEmpty("No flat-rate subscriptions configured", "Add one to ~/.infinibot/subscriptions.json and it will appear here.", true);
  }
  return html`
    <div class="cr-table-wrap"><table class="cr-table">
      <thead>
        <tr>
          <th>Provider</th>
          <th>Plan</th>
          <th>Status</th>
          <th class="r">Monthly</th>
          <th class="r">This period</th>
        </tr>
      </thead>
      <tbody>
        ${subs.map((sub) => html`
          <tr>
            <td class="cr-strong">${sub.provider}</td>
            <td>${sub.plan}</td>
            <td>
              <span class="cr-badge ${sub.isActive ? "ok" : "muted"}"><span class="cr-status-dot ${sub.isActive ? "ok" : "missing-credentials"}"></span>${sub.isActive ? "Active" : "Paused"}</span>
            </td>
            <td class="r">${usd(sub.monthlyAmountUsd)}</td>
            <td class="r">${usd(sub.period.periodCostUsd)}</td>
          </tr>
        `)}
      </tbody>
    </table></div>
  `;
}

function renderProviderTable(s: CreditsState): TemplateResult {
  const rows = s.summary?.byProvider ?? [];
  if (rows.length === 0) return crEmpty("No provider activity yet", undefined, true);
  const total = rows.reduce((acc, r) => acc + r.costUsd, 0) || 1;
  return html`
    <div class="cr-table-wrap"><table class="cr-table">
      <thead><tr><th>Provider</th><th class="r">Requests</th><th class="r">Tokens in</th><th class="r">Tokens out</th><th class="r">Cache</th><th class="r">USD</th><th class="r">%</th></tr></thead>
      <tbody>
        ${rows.map((r) => html`
          <tr>
            <td class="cr-strong">${r.provider}</td>
            <td class="r">${compact(r.requests)}</td>
            <td class="r">${compact(r.tokensIn)}</td>
            <td class="r">${compact(r.tokensOut)}</td>
            <td class="r">${compact(r.cacheReadTokens + r.cacheWriteTokens)}</td>
            <td class="r">${usd(r.costUsd)}</td>
            <td class="r">${((r.costUsd / total) * 100).toFixed(1)}%</td>
          </tr>
        `)}
      </tbody>
    </table></div>
  `;
}

function renderBackendTable(s: CreditsState): TemplateResult {
  const rows = s.summary?.byBackend ?? [];
  if (rows.length === 0) return crEmpty("No agent / CLI activity yet", undefined, true);
  return html`
    <div class="cr-table-wrap"><table class="cr-table">
      <thead><tr><th>Backend</th><th class="r">Requests</th><th class="r">Tokens in</th><th class="r">Tokens out</th><th class="r">USD</th></tr></thead>
      <tbody>
        ${rows.map((r) => html`
          <tr>
            <td class="cr-strong">${r.agentBackend}</td>
            <td class="r">${compact(r.requests)}</td>
            <td class="r">${compact(r.tokensIn)}</td>
            <td class="r">${compact(r.tokensOut)}</td>
            <td class="r">${usd(r.costUsd)}</td>
          </tr>
        `)}
      </tbody>
    </table></div>
  `;
}

function renderTopProjects(s: CreditsState): TemplateResult {
  const rows = s.summary?.byProject ?? [];
  if (rows.length === 0) return crEmpty("No project-tagged usage yet", "Link agents to a project to see spend per project.", true);
  return html`
    <div class="cr-table-wrap"><table class="cr-table">
      <thead><tr><th>Project</th><th class="r">Requests</th><th class="r">Tokens</th><th class="r">USD</th></tr></thead>
      <tbody>
        ${rows.map((r) => html`
          <tr>
            <td><code>${r.projectId}</code></td>
            <td class="r">${compact(r.requests)}</td>
            <td class="r">${compact(r.tokens)}</td>
            <td class="r">${usd(r.costUsd)}</td>
          </tr>
        `)}
      </tbody>
    </table></div>
  `;
}

function renderTopSessions(s: CreditsState, host: AppLike, client: GatewayBrowserClient): TemplateResult {
  const rows = s.summary?.bySession ?? [];
  if (rows.length === 0) return crEmpty("No session-tagged usage yet", undefined, true);
  const openFocus = (sessionKey: string) => {
    if (!sessionKey) return;
    openSubagentDetailModal({
      client,
      requestUpdate: () => host.requestUpdate?.(),
      sessionKey,
    });
  };
  return html`
    <div class="cr-table-wrap"><table class="cr-table">
      <thead><tr><th>Session</th><th class="r">Requests</th><th class="r">Tokens</th><th class="r">Approx USD</th></tr></thead>
      <tbody>
        ${rows.map((r) => html`
          <tr class="click" tabindex="0" title="Open Agent Focus — ${r.sessionKey}"
            @click=${() => openFocus(r.sessionKey)}
            @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openFocus(r.sessionKey); } }}>
            <td><code>${r.sessionKey.length > 48 ? r.sessionKey.slice(0, 48) + "…" : r.sessionKey}</code></td>
            <td class="r">${compact(r.requests)}</td>
            <td class="r">${compact(r.tokens)}</td>
            <td class="r">${usd(r.costUsd)}</td>
          </tr>
        `)}
      </tbody>
    </table></div>
  `;
}

function renderRecent(s: CreditsState, host: AppLike): TemplateResult {
  if (s.recent.length === 0) return crEmpty("No recorded entries yet", "Every LLM call your agents make is logged here.", true);
  return html`
    <div class="cr-table-wrap cr-table-wrap--tall"><table class="cr-table">
      <thead><tr><th>When</th><th>Provider</th><th>Model</th><th>Backend</th><th class="r">In</th><th class="r">Out</th><th class="r">USD</th><th>Session</th></tr></thead>
      <tbody>
        ${s.recent.slice(0, 50).map((e) => html`
          <tr>
            <td class="cr-dim" title="${new Date(e.timestamp).toISOString()}">${fmtRelative(e.timestamp)}</td>
            <td>${e.provider}</td>
            <td><code>${e.model}</code></td>
            <td>${e.agentBackend}</td>
            <td class="r">${compact(e.tokensIn)}</td>
            <td class="r">${compact(e.tokensOut)}</td>
            <td class="r">${usd(e.costUsd)}</td>
            <td><code class="cr-code-dim">${(e.sessionKey ?? "—").slice(0, 24)}</code></td>
          </tr>
        `)}
      </tbody>
    </table></div>
  `;
}

// Provider plans — plan-aware usage with progress bars + (estimated) badges.
function renderProviderPlans(s: CreditsState, host: AppLike, client: GatewayBrowserClient): TemplateResult {
  const plans = s.providerPlans ?? [];
  if (plans.length === 0) return crEmpty("No providers tracked yet", undefined, true);
  return html`
    <div class="cr-table-wrap"><table class="cr-table">
      <thead>
        <tr>
          <th>Provider</th><th>Plan</th><th>Source</th>
          <th class="cr-col-bar">Used / limit</th>
          <th class="r">Used</th><th>Updated</th><th><span class="cr-sr">Actions</span></th>
        </tr>
      </thead>
      <tbody>
        ${plans.map((p) => {
          const u = p.usage;
          const used = u.usedUsd ?? 0;
          const limit = u.limitUsd;
          const pct = limit && limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
          const cls = pct >= 95 ? "bad" : pct >= 80 ? "warn" : "";
          const test = s.planTestResult?.[p.provider];
          const busy = s.refreshingPlan === p.provider;
          return html`
            <tr>
              <td class="cr-strong"><span class="cr-status-dot ${u.status}"></span>${p.provider}</td>
              <td>${p.planDef?.label ?? p.config.plan}</td>
              <td>
                ${u.source === "api"
                  ? html`<span class="cr-badge ok">Live</span>`
                  : html`<span class="cr-badge muted" title="${u.message ?? "No provider API — summed from local ledger"}">Estimated</span>`}
              </td>
              <td>
                ${limit
                  ? html`<div class="cr-bar ${cls}"><span style="width:${pct.toFixed(1)}%"></span></div>
                      <div class="cr-bar-note">${usd(used)} of ${usd(limit)} (${pct.toFixed(0)}%)</div>`
                  : html`<span class="cr-dim">No limit set</span>`}
              </td>
              <td class="r">${usd(used)}</td>
              <td class="cr-dim">${fmtRelative(u.fetchedAt)}</td>
              <td class="cr-actions">
                <span class="cr-actions-row">
                  <button class="cr-btn sm" ?disabled=${busy} @click=${() => refreshPlan(host, client, p.provider)}>${busy ? "…" : "Refresh"}</button>
                  <button class="cr-btn sm" ?disabled=${busy} @click=${() => testPlanConnection(host, client, p.provider)}>Test</button>
                  <button class="cr-btn sm" @click=${() => openPlanDraft(host, p)}>Edit</button>
                </span>
                ${test ? html`<div class="cr-test ${test.ok ? "ok" : "warn"}">${test.ok ? "✓ live" : `· ${test.status}`}</div>` : nothing}
              </td>
            </tr>
          `;
        })}
      </tbody>
    </table></div>
  `;
}

function renderPlanModal(s: CreditsState, host: AppLike, client: GatewayBrowserClient): TemplateResult | typeof nothing {
  const d = s.planDraft;
  if (!d) return nothing;
  const planDef = d.availablePlans.find((p) => p.id === d.plan);
  const needsKey = planDef?.hasUsageApi ?? false;
  const keyLabel = d.provider === "anthropic" ? "Admin API key (sk-ant-admin-…)" : d.provider === "openai" ? "Admin API key (sk-admin-…)" : "API key";
  return html`
    <div class="cr-modal-backdrop" @click=${(e: Event) => { if (e.target === e.currentTarget) closePlanDraft(host); }}
      @keydown=${(e: KeyboardEvent) => { if (e.key === "Escape") closePlanDraft(host); }}>
      <div class="cr-modal" role="dialog" aria-modal="true" aria-labelledby="cr-plan-modal-title">
        <div class="cr-modal-eyebrow">Provider plan</div>
        <h3 id="cr-plan-modal-title">${PROVIDER_META[d.provider]?.label ?? d.provider} <span class="cr-dim">${d.provider}</span></h3>
        <div class="cr-field">
          <label>Plan</label>
          <select .value=${d.plan} @change=${(e: Event) => updatePlanDraft(host, { plan: (e.target as HTMLSelectElement).value })}>
            ${d.availablePlans.map((p) => html`<option value="${p.id}" ?selected=${d.plan === p.id}>${p.label}${p.hasUsageApi ? " · live API" : ""}</option>`)}
          </select>
        </div>
        ${needsKey ? html`
          <div class="cr-field">
            <label>${keyLabel}</label>
            <input type="password" placeholder=${d.hasApiKey ? "•••••• (stored — leave blank to keep)" : "paste key to enable live usage"}
              @input=${(e: Event) => updatePlanDraft(host, { apiKey: (e.target as HTMLInputElement).value })} />
          </div>
          <div class="cr-field">
            <label>Org ID (optional)</label>
            <input .value=${d.orgId ?? ""} @input=${(e: Event) => updatePlanDraft(host, { orgId: (e.target as HTMLInputElement).value })} />
          </div>` : html`<div class="cr-modal-note">This plan has no usage API — usage is estimated from the local ledger. Set a budget below to get a progress bar.</div>`}
        <div class="cr-field">
          <label>Monthly budget USD (override)</label>
          <input type="number" min="0" step="1" .value=${d.monthlyBudgetUsd != null ? String(d.monthlyBudgetUsd) : ""}
            @input=${(e: Event) => { const v = (e.target as HTMLInputElement).value; updatePlanDraft(host, { monthlyBudgetUsd: v === "" ? undefined : Number(v) }); }} />
        </div>
        <div class="cr-field">
          <label>Monthly token cap (override)</label>
          <input type="number" min="0" step="1000" .value=${d.monthlyTokenCap != null ? String(d.monthlyTokenCap) : ""}
            @input=${(e: Event) => { const v = (e.target as HTMLInputElement).value; updatePlanDraft(host, { monthlyTokenCap: v === "" ? undefined : Number(v) }); }} />
        </div>
        <div class="cr-modal-actions">
          <button class="cr-btn" @click=${() => closePlanDraft(host)}>Cancel</button>
          <button class="cr-btn primary" @click=${() => savePlanDraft(host, client)}>Save</button>
        </div>
      </div>
    </div>
  `;
}

function renderProviderSync(s: CreditsState, host: AppLike, client: GatewayBrowserClient): TemplateResult {
  if (s.providers.length === 0) return crEmpty("No providers detected", undefined, true);
  return html`
    <div class="cr-table-wrap"><table class="cr-table">
      <thead><tr><th>Provider</th><th>Status</th><th>Last sync</th><th class="r">Reconciled USD</th><th><span class="cr-sr">Actions</span></th></tr></thead>
      <tbody>
        ${s.providers.map((p) => html`
          <tr>
            <td class="cr-strong"><span class="cr-status-dot ${p.status}"></span>${p.provider}</td>
            <td>${p.status}${p.message ? html` <span class="cr-dim">— ${p.message}</span>` : nothing}</td>
            <td class="cr-dim">${fmtRelative(p.lastSyncAt)}</td>
            <td class="r">${p.lastReconciledTotalUsd != null ? usd(p.lastReconciledTotalUsd) : "—"}</td>
            <td class="cr-actions">
              <button class="cr-btn sm" ?disabled=${s.refreshingProvider === p.provider} @click=${() => syncProvider(host, client, p.provider)}>
                ${s.refreshingProvider === p.provider ? "Syncing…" : "Sync now"}
              </button>
            </td>
          </tr>
        `)}
      </tbody>
    </table></div>
  `;
}

function renderBudgets(s: CreditsState, host: AppLike, client: GatewayBrowserClient): TemplateResult {
  return html`
    <div class="cr-table-wrap"><table class="cr-table">
      <thead><tr><th>Name</th><th>Scope</th><th class="r">Limit</th><th class="r">Spent</th><th>Progress</th><th>State</th><th><span class="cr-sr">Actions</span></th></tr></thead>
      <tbody>
        ${s.budgetStatuses.length === 0
          ? html`<tr class="cr-empty-row"><td colspan="7">${crEmpty("No budgets configured", "Press “New budget” to set a monthly spend cap.", true)}</td></tr>`
          : s.budgetStatuses.map((b) => {
              const cls = b.state === "ok" ? "" : b.state === "warn" ? "warn" : "bad";
              const pct = Math.min(100, b.pctUsed);
              return html`
                <tr>
                  <td class="cr-strong">${b.name}</td>
                  <td>${b.scopeAxis}${b.scopeValue ? ` = ${b.scopeValue}` : ""}</td>
                  <td class="r">${usd(b.monthlyLimitUsd)}</td>
                  <td class="r">${usd(b.currentSpendUsd)}</td>
                  <td class="cr-col-bar">
                    <div class="cr-bar ${cls}"><span style="width:${pct.toFixed(1)}%"></span></div>
                    <div class="cr-bar-note">${b.pctUsed.toFixed(1)}% used</div>
                  </td>
                  <td><span class="cr-badge ${b.state === "ok" ? "ok" : b.state === "warn" ? "warn" : "bad"}">${b.state}</span>${b.blockOnHard ? html` <span class="cr-dim">· blocks spawns</span>` : nothing}</td>
                  <td class="cr-actions">
                    <span class="cr-actions-row">
                      <button class="cr-btn sm" @click=${() => openBudgetDraft(host, b)}>Edit</button>
                      <button class="cr-btn sm danger" aria-label="Delete budget ${b.name}" title="Delete budget" @click=${() => deleteBudget(host, client, b.id)}>×</button>
                    </span>
                  </td>
                </tr>
              `;
            })}
      </tbody>
    </table></div>
  `;
}

function renderBudgetModal(s: CreditsState, host: AppLike, client: GatewayBrowserClient): TemplateResult | typeof nothing {
  if (!s.budgetDraft) return nothing;
  const d = s.budgetDraft;
  const upd = (patch: Partial<CreditsBudget>) => {
    s.budgetDraft = { ...d, ...patch };
    host.requestUpdate?.();
  };
  return html`
    <div class="cr-modal-backdrop" @click=${(e: Event) => { if (e.target === e.currentTarget) closeBudgetDraft(host); }}
      @keydown=${(e: KeyboardEvent) => { if (e.key === "Escape") closeBudgetDraft(host); }}>
      <div class="cr-modal" role="dialog" aria-modal="true" aria-labelledby="cr-budget-modal-title">
        <div class="cr-modal-eyebrow">Spend cap</div>
        <h3 id="cr-budget-modal-title">${d.id ? "Edit budget" : "New budget"}</h3>
        <div class="cr-field">
          <label>Name</label>
          <input .value=${d.name ?? ""} @input=${(e: Event) => upd({ name: (e.target as HTMLInputElement).value })} />
        </div>
        <div class="cr-field">
          <label>Scope axis</label>
          <select .value=${d.scopeAxis ?? "all"} @change=${(e: Event) => upd({ scopeAxis: (e.target as HTMLSelectElement).value as CreditsBudget["scopeAxis"] })}>
            <option value="all">All spend</option>
            <option value="provider">Provider</option>
            <option value="agent_backend">Agent backend</option>
            <option value="project_id">Project</option>
            <option value="session_key">Session</option>
          </select>
        </div>
        ${d.scopeAxis && d.scopeAxis !== "all" ? html`
          <div class="cr-field">
            <label>Scope value</label>
            <input .value=${d.scopeValue ?? ""} @input=${(e: Event) => upd({ scopeValue: (e.target as HTMLInputElement).value })} />
          </div>` : nothing}
        <div class="cr-field">
          <label>Monthly limit USD</label>
          <input type="number" min="0" step="0.5" .value=${String(d.monthlyLimitUsd ?? 0)} @input=${(e: Event) => upd({ monthlyLimitUsd: Number((e.target as HTMLInputElement).value) })} />
        </div>
        <div class="cr-field">
          <label>Warn threshold %</label>
          <input type="number" min="0" max="100" .value=${String(d.warnThresholdPct ?? 80)} @input=${(e: Event) => upd({ warnThresholdPct: Number((e.target as HTMLInputElement).value) })} />
        </div>
        <div class="cr-field">
          <label>Hard threshold %</label>
          <input type="number" min="0" max="100" .value=${String(d.hardThresholdPct ?? 100)} @input=${(e: Event) => upd({ hardThresholdPct: Number((e.target as HTMLInputElement).value) })} />
        </div>
        <div class="cr-field cr-field--check">
          <label><input type="checkbox" .checked=${!!d.blockOnHard} @change=${(e: Event) => upd({ blockOnHard: (e.target as HTMLInputElement).checked })} /> Block new spawns when hard threshold is hit</label>
        </div>
        <div class="cr-modal-actions">
          <button class="cr-btn" @click=${() => closeBudgetDraft(host)}>Cancel</button>
          <button class="cr-btn primary" @click=${() => saveBudgetDraft(host, client)}>Save</button>
        </div>
      </div>
    </div>
  `;
}

// ── Top-level chip bar ────────────────────────────────────────

interface AppLike extends AppViewState {
  creditsState?: CreditsState;
}

async function downloadRecentCsv(host: AppLike): Promise<void> {
  const csv = await exportRecentCsv(host);
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `tokens-recent-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

const PERIOD_LABEL: Record<string, string> = { hour: "Hour", day: "Day", week: "Week", month: "Month", all: "All" };
const GROUP_LABEL: Record<string, string> = { agent_backend: "Agent backend", provider: "Provider", model: "Model", project_id: "Project" };

function renderControls(s: CreditsState, host: AppLike, client: GatewayBrowserClient): TemplateResult {
  const period = s.period;
  const periods = ["hour", "day", "week", "month", "all"] as const;
  const buckets = ["minute", "hour", "day", "week"] as const;
  return html`
    <div class="cr-toolbar bag-surface" role="toolbar" aria-label="Usage filters">
      <div class="cr-seg" role="tablist" aria-label="Period">
        ${periods.map((p) => html`
          <button class="cr-chip ${period === p ? "active" : ""}" role="tab" aria-selected=${period === p ? "true" : "false"}
            @click=${() => { setCreditsPeriod(host, p); void loadCredits(host, client); }}>${PERIOD_LABEL[p] ?? p}</button>
        `)}
      </div>
      <span class="cr-toolbar-sep" aria-hidden="true"></span>
      <label class="cr-chip cr-select">
        <span class="cr-select-label">Bucket</span>
        <select @change=${(e: Event) => { setCreditsBucket(host, (e.target as HTMLSelectElement).value as typeof buckets[number]); void loadCredits(host, client); }}>
          ${buckets.map((b) => html`<option value="${b}" ?selected=${s.bucket === b}>${b}</option>`)}
        </select>
      </label>
      <label class="cr-chip cr-select">
        <span class="cr-select-label">Stack by</span>
        <select @change=${(e: Event) => { setCreditsGroupBy(host, (e.target as HTMLSelectElement).value as CreditsState["groupBy"]); void loadCredits(host, client); }}>
          ${(["agent_backend", "provider", "model", "project_id"] as const).map((g) => html`<option value="${g}" ?selected=${s.groupBy === g}>${GROUP_LABEL[g] ?? g}</option>`)}
        </select>
      </label>
      <label class="cr-chip cr-select">
        <span class="cr-select-label">Provider</span>
        <select @change=${(e: Event) => { setCreditsFilter(host, { ...s.filter, provider: (e.target as HTMLSelectElement).value || undefined }); void loadCredits(host, client); }}>
          <option value="">All</option>
          ${(s.summary?.byProvider ?? []).map((p) => html`<option value="${p.provider}" ?selected=${s.filter.provider === p.provider}>${p.provider}</option>`)}
        </select>
      </label>
      <label class="cr-chip cr-select">
        <span class="cr-select-label">Backend</span>
        <select @change=${(e: Event) => { setCreditsFilter(host, { ...s.filter, agentBackend: (e.target as HTMLSelectElement).value || undefined }); void loadCredits(host, client); }}>
          <option value="">All</option>
          ${(s.summary?.byBackend ?? []).map((b) => html`<option value="${b.agentBackend}" ?selected=${s.filter.agentBackend === b.agentBackend}>${b.agentBackend}</option>`)}
        </select>
      </label>
      <span class="cr-toolbar-meta">${s.lastLoadedAt ? `Loaded ${fmtRelative(s.lastLoadedAt)}` : s.loading ? "Loading…" : ""}</span>
    </div>
  `;
}

function sectionHead(title: string | TemplateResult, meta?: string | TemplateResult): TemplateResult {
  return html`<div class="cr-section-title"><h2>${title}</h2>${meta ? html`<span class="cr-section-meta">${meta}</span>` : nothing}</div>`;
}

// ── Entry point ───────────────────────────────────────────────

export function renderCredits(state: AppViewState, client: GatewayBrowserClient): TemplateResult {
  const host = state as AppLike;
  if (!host.creditsState) {
    void loadCredits(host, client);
  } else if (!host.creditsState.lastLoadedAt && !host.creditsState.loading) {
    void loadCredits(host, client);
  }
  const s = host.creditsState ?? {
    loading: true,
    period: "month",
    bucket: "day",
    groupBy: "agent_backend",
    metric: "tokens",
    recent: [],
    providers: [],
    pricedModels: [],
    budgets: [],
    budgetStatuses: [],
    filter: {},
    providerPlans: [],
    planTestResult: {},
  } as CreditsState;

  const refreshIcon = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 4v5h-5"/></svg>`;
  const downloadIcon = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 21h16"/></svg>`;

  return html`
    <div class="cr-shell ba-glass">
      ${baAurora()}
      ${/* The "API keys | Usage & plans" sub-tab bar comes from the Keys & Usage host. */ ""}
      <header class="cr-hero">
        <div class="cr-hero-copy">
          <div class="bag-eyebrow">Keys &amp; Usage</div>
          <h1 class="cr-title">Usage &amp; <span class="bag-gold-text">plans</span></h1>
          <p class="cr-sub">Real token counts per provider, agent and session, your CLI subscription quotas, and an approximate USD view of what your own keys are spending.</p>
        </div>
        <div class="cr-hero-actions">
          <button class="cr-btn" ?disabled=${s.loading} @click=${() => loadCredits(host, client)}>${refreshIcon}${s.loading ? "Loading…" : "Refresh"}</button>
          <button class="cr-btn primary" @click=${() => void downloadRecentCsv(host)}>${downloadIcon}Export CSV</button>
        </div>
      </header>

      ${renderControls(s, host, client)}

      <section class="cr-section">
        ${sectionHead("Subscriptions & plans", "Live from each CLI · Refresh re-runs its status command")}
        ${renderPlanCards(s, host, client)}
      </section>

      ${renderKpis(s)}

      <section class="cr-section">
        ${sectionHead("Flat-rate subscriptions", html`Edit <code>~/.infinibot/subscriptions.json</code>`)}
        ${renderSubscriptions(s)}
      </section>

      <section class="cr-section">
        ${sectionHead("Tokens by agent", "Input · output · cache · approx USD — tap a session below for Agent Focus")}
        ${renderAgentTokens(s)}
      </section>

      <div class="cr-grid cr-grid--2-1">
        <section class="cr-section">
          <div class="cr-section-title">
            <h2><span class="cr-cap">${s.metric}</span> by ${GROUP_LABEL[s.groupBy] ?? s.groupBy}</h2>
            <span class="cr-seg cr-seg--sm" role="tablist" aria-label="Chart metric">
              ${(["tokens", "cost", "requests"] as const).map((m) => html`
                <button class="cr-chip ${s.metric === m ? "active" : ""}" role="tab" aria-selected=${s.metric === m ? "true" : "false"} @click=${() => setCreditsMetric(host, m)}>${m === "tokens" ? "Tokens" : m === "cost" ? "Cost" : "Requests"}</button>
              `)}
            </span>
          </div>
          ${renderChart(s.timeseries?.points ?? [], s.metric, s.timeseries?.bucket ?? s.bucket)}
        </section>
        <section class="cr-section">
          ${sectionHead(html`Token share <span class="cr-dim">· ${PERIOD_LABEL[s.period] ?? s.period}</span>`)}
          ${renderTokenDonut(s)}
        </section>
      </div>

      <div class="cr-grid cr-grid--2">
        <section class="cr-section">
          ${sectionHead("Top providers")}
          ${renderProviderTable(s)}
        </section>
        <section class="cr-section">
          ${sectionHead("Top agents / CLIs")}
          ${renderBackendTable(s)}
        </section>
      </div>

      <section class="cr-section">
        ${sectionHead("Top models")}
        ${renderTopModels(s)}
      </section>

      <div class="cr-grid cr-grid--2">
        <section class="cr-section">
          ${sectionHead("Top projects")}
          ${renderTopProjects(s)}
        </section>
        <section class="cr-section">
          ${sectionHead("Top sessions", "Tap a row → Agent Focus")}
          ${renderTopSessions(s, host, client)}
        </section>
      </div>

      <section class="cr-section">
        ${sectionHead("Provider plans & usage", "Live where an API exists · otherwise estimated")}
        ${renderProviderPlans(s, host, client)}
      </section>

      <section class="cr-section">
        <div class="cr-section-title">
          <h2>Provider sync</h2>
          <button class="cr-btn sm" @click=${() => syncProvider(host, client)}>Sync all</button>
        </div>
        ${renderProviderSync(s, host, client)}
      </section>

      <section class="cr-section">
        <div class="cr-section-title">
          <h2>Budgets</h2>
          <button class="cr-btn sm primary" @click=${() => openBudgetDraft(host)}>+ New budget</button>
        </div>
        ${renderBudgets(s, host, client)}
      </section>

      <section class="cr-section">
        ${sectionHead("Recent entries", `${compact(s.recent.length)} loaded`)}
        ${renderRecent(s, host)}
      </section>

      ${s.error ? html`<div class="cr-error" role="alert"><strong>Error:</strong> ${s.error}</div>` : nothing}
    </div>
    ${s.budgetDraft || s.planDraft || s.toast ? html`<div class="ba-glass cr-layer">
      ${renderBudgetModal(s, host, client)}
      ${renderPlanModal(s, host, client)}
      ${s.toast ? html`<div class="cr-toast ${s.toast.tone}" role="status">${s.toast.text}</div>` : nothing}
    </div>` : nothing}
  `;
}
