/**
 * <token-usage-breakdown> — reusable 24-hour token-usage HUD card.
 *
 * Shows the most-used agents (by coder backend) over the last 24h with their
 * backend logo, run count, and REAL token consumption, plus a share-of-total
 * bar. There are no "credits" in this product (BYOK + Whop + KinglyVault) — this
 * card surfaces only real numbers sourced from the ledger.
 *
 * Data source: the gateway `credits.timeseries` RPC (groupBy `agent_backend`,
 * an explicit 24h range). The RPC name keeps its `credits.*` wire identity for
 * backward compatibility (renaming it would need a gateway restart and break
 * every existing consumer); only the UI concept is "tokens". Points are summed
 * client-side into per-backend totals — no new RPC required. If the ledger is
 * empty an explicit empty state renders ("NO USAGE DATA · awaiting traffic").
 *
 * Mounted on several surfaces (agent world map, activity page, masonry grid)
 * via the back-compat <credit-usage-breakdown> shim, plus the new
 * <token-usage-breakdown> tag directly.
 *
 * Visual language matches the agent-ops "ACTIVE AGENTS" / pin-board overlays:
 * deep panel bg, gold border, gold L-bracket corners, backdrop blur, gold
 * uppercase header with wide letter-spacing.
 */

import { LitElement, html, css, nothing, unsafeCSS, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../gateway";
import { AGENT_SPRITE_SRC } from "../views/agent-ops/agent-sprites";
import { HUD_OVERLAY_CSS } from "../views/agent-ops/hud-overlay.css";
import { managedInterval, type SchedulerHandle } from "../perf/visibility-scheduler";

// ── Backend → sprite slot + friendly label ──────────────────────────
type SpriteSlot = keyof typeof AGENT_SPRITE_SRC;

function backendSlot(backend: string): SpriteSlot {
  switch (backend) {
    case "claude-code":
      return "claude";
    case "opencode":
      return "opencode";
    case "codex":
      return "codex";
    case "gemini":
      return "gemini";
    default:
      return "default";
  }
}

function backendLabel(backend: string): string {
  switch (backend) {
    case "claude-code":
      return "Claude Code";
    case "opencode":
      return "OpenCode";
    case "codex":
      return "Codex";
    case "gemini":
      return "Gemini";
    case "grok":
      return "Grok Build";
    case "ollama-local":
      return "Ollama (Local)";
    case "ollama-cloud":
      return "Ollama (Cloud)";
    case "direct-api":
      return "Direct API";
    case "mcp":
      return "MCP";
    case "gateway":
      return "Gateway";
    case "unknown":
    case "":
      return "Unknown";
    default:
      // Title-case any future backend slug.
      return backend.replace(/(^|[-_])(\w)/g, (_, sep, c) => (sep ? " " : "") + c.toUpperCase());
  }
}

interface TokenRow {
  backend: string;
  label: string;
  slot: SpriteSlot;
  tokens: number;
  runs: number;
  costUsd: number;
}

// Shape of a `credits.timeseries` response point series value.
interface SeriesEntry {
  tokens: number;
  costUsd: number;
  requests: number;
}
interface TimeseriesResponse {
  points?: Array<{ bucketStart: number; series: Record<string, SeriesEntry> }>;
}

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

// Compact token count for tight HUD rows (1.2M, 18.4k …).
function fmtTokens(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

@customElement("token-usage-breakdown")
export class TokenUsageBreakdown extends LitElement {
  /** Gateway client used to call `credits.timeseries`. */
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  /** Compact mode: smaller rows, no progress bar, fewer rows, no motion. */
  @property({ type: Boolean }) compact = false;
  /** Max number of agent rows to show (full mode). Compact caps at 3. */
  @property({ type: Number }) limit = 5;

  @state() private rows: TokenRow[] = [];
  @state() private totalTokens = 0;
  @state() private loading = true;
  @state() private errored = false;

  private timer: SchedulerHandle | null = null;

  static styles = css`
    ${unsafeCSS(HUD_OVERLAY_CSS)}

    :host {
      display: block;
      font-family: "JetBrains Mono", "SF Mono", "Consolas", monospace;
      color: var(--g-fg, var(--gx-text, #e4e4e7));

      /* Re-map the shared --gx-* HUD tokens onto the live InfiniBot dynamic
         theme (--g-primary / --g-accent / --g-fg / --g-bg-deep) so this card
         tracks palette swaps on every surface — activity page, world map,
         masonry grid — not only when the galactic theme root bridge has run. */
      --gx-gold: var(--g-primary, #d4af37);
      --gx-gold-lt: color-mix(in srgb, var(--g-primary, #d4af37) 75%, #ffffff);
      --gx-gold-dp: color-mix(in srgb, var(--g-primary, #d4af37) 60%, #000000);
      --gx-gold-15: color-mix(in srgb, var(--g-primary, #d4af37) 15%, transparent);
      --gx-gold-30: color-mix(in srgb, var(--g-primary, #d4af37) 30%, transparent);
      --gx-gold-50: color-mix(in srgb, var(--g-primary, #d4af37) 50%, transparent);
      --gx-gold-80: color-mix(in srgb, var(--g-primary, #d4af37) 80%, transparent);
      --gx-accent2: var(--g-accent, #a855f7);
      --gx-accent2-20: color-mix(in srgb, var(--g-accent, #a855f7) 20%, transparent);
      --gx-accent2-40: color-mix(in srgb, var(--g-accent, #a855f7) 40%, transparent);
      --gx-text: var(--g-fg, #e4e4e7);
      --gx-muted: var(--g-fg-dim, #71717a);
      --gx-void: var(--g-bg-deep, #06000f);
      --gx-glass: var(--g-surface, rgba(255, 255, 255, 0.04));
    }

    /* Visual frame treatment comes from the shared .hud-overlay class. */

    .header {
      position: relative;
      z-index: 2;
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
      padding: 9px 12px 8px;
    }
    .total {
      color: var(--gx-gold-lt, #e9c46a);
      font-size: 12px;
      font-weight: 700;
      white-space: nowrap;
    }
    .total .unit {
      color: var(--gx-muted, #71717a);
      font-weight: 500;
      font-size: 10px;
      margin-left: 3px;
    }

    .body {
      position: relative;
      z-index: 2;
      padding: 8px 10px 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    :host([compact]) .body {
      padding: 6px 8px 8px;
      gap: 6px;
    }

    .row {
      display: grid;
      grid-template-columns: auto 1fr auto;
      grid-template-rows: auto auto;
      column-gap: 9px;
      row-gap: 5px;
      align-items: center;
    }
    .logo {
      grid-row: 1 / 3;
      width: 24px;
      height: 24px;
      border-radius: 5px;
      object-fit: cover;
      background: var(--gx-glass, #11091d);
      border: 1px solid var(--gx-gold-30, rgba(212, 175, 55, 0.25));
    }
    :host([compact]) .logo {
      width: 18px;
      height: 18px;
    }
    .name {
      grid-column: 2;
      grid-row: 1;
      color: var(--gx-text, #fff);
      font-size: 12px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
    }
    :host([compact]) .name {
      font-size: 11px;
    }
    .sub {
      grid-column: 2;
      grid-row: 2;
      color: var(--gx-muted, #7c7a85);
      font-size: 10px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
    }
    .tokens {
      grid-column: 3;
      grid-row: 1 / 3;
      color: var(--gx-gold-lt, #e9c46a);
      font-size: 13px;
      font-weight: 700;
      white-space: nowrap;
      text-align: right;
    }
    :host([compact]) .tokens {
      font-size: 11px;
    }
    .tokens .unit {
      color: var(--gx-muted, #71717a);
      font-weight: 500;
      font-size: 9px;
      margin-left: 2px;
    }

    .bar {
      grid-column: 1 / 4;
      grid-row: 3;
      height: 3px;
      border-radius: 2px;
      background: var(--gx-gold-15, rgba(255, 255, 255, 0.06));
      overflow: hidden;
      margin-top: 2px;
    }
    .bar-fill {
      height: 100%;
      border-radius: 2px;
      background: linear-gradient(90deg, var(--gx-gold, #d4af37), var(--gx-accent2, #a855f7));
    }

    .empty {
      position: relative;
      z-index: 2;
      padding: 22px 14px;
      text-align: center;
      color: var(--gx-muted, #71717a);
      font-size: 10px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
    }
    .empty .dot {
      color: var(--gx-gold-lt, #e9c46a);
      opacity: 0.5;
    }

    /* Subtle pulse on the header title dot — gated to reduced-motion + non-compact */
    @media (prefers-reduced-motion: no-preference) {
      :host(:not([compact])) .hud-eyebrow::after {
        content: "";
        display: inline-block;
        width: 5px;
        height: 5px;
        margin-left: 8px;
        border-radius: 50%;
        background: var(--gx-gold-lt, #e9c46a);
        vertical-align: middle;
        animation: blip 2.4s ease-in-out infinite;
      }
    }
    @keyframes blip {
      0%,
      100% {
        opacity: 0.25;
      }
      50% {
        opacity: 1;
      }
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    void this.refresh();
    this.timer = managedInterval(() => void this.refresh(), 60_000, { hiddenMs: 120_000 });
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.timer) {
      this.timer.cancel();
      this.timer = null;
    }
  }

  updated(changed: PropertyValues): void {
    if (changed.has("client") && this.client) void this.refresh();
  }

  private async refresh(): Promise<void> {
    if (!this.client) {
      this.loading = false;
      return;
    }
    try {
      const end = Date.now();
      const start = end - 24 * 60 * 60 * 1000;
      const res = (await this.client.request("credits.timeseries", {
        bucket: "hour",
        range: { start, end },
        groupBy: "agent_backend",
      })) as TimeseriesResponse;

      // Sum every hourly bucket into per-backend totals — real ledger tokens.
      const agg = new Map<string, { tokens: number; costUsd: number; runs: number }>();
      for (const point of res?.points ?? []) {
        for (const [backend, entry] of Object.entries(point.series ?? {})) {
          const prev = agg.get(backend) ?? { tokens: 0, costUsd: 0, runs: 0 };
          prev.tokens += entry.tokens ?? 0;
          prev.costUsd += entry.costUsd ?? 0;
          prev.runs += entry.requests ?? 0;
          agg.set(backend, prev);
        }
      }

      const rows: TokenRow[] = [...agg.entries()]
        .map(([backend, v]) => ({
          backend,
          label: backendLabel(backend),
          slot: backendSlot(backend),
          tokens: Math.round(v.tokens),
          runs: v.runs,
          costUsd: v.costUsd,
        }))
        .filter((r) => r.runs > 0 || r.tokens > 0)
        .sort((a, b) => b.tokens - a.tokens || b.runs - a.runs);

      this.totalTokens = rows.reduce((s, r) => s + r.tokens, 0);
      this.rows = rows;
      this.errored = false;
    } catch {
      this.errored = true;
    } finally {
      this.loading = false;
    }
  }

  render() {
    const cap = this.compact ? Math.min(3, this.limit) : this.limit;
    const visible = this.rows.slice(0, cap);
    const max = visible.reduce((m, r) => Math.max(m, r.tokens), 0) || 1;

    return html`
      <div class="hud-overlay frame">
        <span class="hud-corner hud-corner--tl"></span>
        <span class="hud-corner hud-corner--tr"></span>
        <span class="hud-corner hud-corner--bl"></span>
        <span class="hud-corner hud-corner--br"></span>
        ${this.compact ? nothing : html`<span class="hud-scanline"></span>`}

        <div class="header">
          <span class="hud-eyebrow">24H Token Usage</span>
          <span class="total"
            >${fmtTokens(this.totalTokens)}<span class="unit">tok</span></span
          >
        </div>
        <hr class="hud-rule" />

        ${visible.length === 0
          ? html`<div class="empty">
              No Usage Data <span class="dot">·</span> awaiting traffic
            </div>`
          : html`<div class="body">
              ${visible.map((r) => this.renderRow(r, max))}
            </div>`}
        ${this.compact ? nothing : html`<span class="hud-footer-strip"></span>`}
      </div>
    `;
  }

  private renderRow(r: TokenRow, max: number) {
    const pct = max > 0 ? Math.max(2, Math.round((r.tokens / max) * 100)) : 0;
    return html`
      <div class="row">
        <img
          class="logo"
          src=${AGENT_SPRITE_SRC[r.slot]}
          alt=${r.label}
          loading="lazy"
        />
        <div class="name" title=${r.label}>${r.label}</div>
        <div class="sub">${r.backend} · ${fmtInt(r.runs)} runs</div>
        <div class="tokens">${fmtTokens(r.tokens)}<span class="unit">tok</span></div>
        ${this.compact
          ? nothing
          : html`<div class="bar">
              <div class="bar-fill" style="width:${pct}%"></div>
            </div>`}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "token-usage-breakdown": TokenUsageBreakdown;
  }
}
