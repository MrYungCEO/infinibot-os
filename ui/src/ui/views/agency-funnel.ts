/**
 * Agency Funnel View
 * Full interactive Cytoscape.js-powered agency sales funnel.
 * Topology: Traffic → Lead Capture → MOFU → Qualification → Website → Retention
 */

import { LitElement, html, css, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import cytoscape from "cytoscape";
import type { Core, NodeSingular } from "cytoscape";
import { getGatewayClient } from "../gateway-client.js";
import type { GatewayEventFrame } from "../gateway.js";
import type { FunnelNode, FunnelNodeType, FunnelSection } from "../lib/funnel-types.js";

// ─── Colors ─────────────────────────────────────────────────────────────────

const NODE_BG: Record<FunnelNodeType, string> = {
  "traffic-source":   "#f5d020",
  "platform":         "#e8a0bf",
  "lead-magnet":      "#00bcd4",
  "nurture":          "#009688",
  "conversion-asset": "#ff9800",
  "qualifier":        "#4caf50",
  "website-asset":    "#37474f",
  "closer":           "#1a1a2e",
  "product":          "#7b4dff",
  "retention":        "#1976d2",
  "list-segment":     "#6a0dad",
};

const NODE_FG: Record<FunnelNodeType, string> = {
  "traffic-source":   "#000",
  "platform":         "#000",
  "lead-magnet":      "#000",
  "nurture":          "#fff",
  "conversion-asset": "#000",
  "qualifier":        "#fff",
  "website-asset":    "#fff",
  "closer":           "#fff",
  "product":          "#fff",
  "retention":        "#fff",
  "list-segment":     "#fff",
};

const STATUS_BORDER: Record<string, string> = {
  active:   "#4caf50",
  warning:  "#ff9800",
  critical: "#f44336",
  idle:     "rgba(255,255,255,0.2)",
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtVol(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

function nodeWidth(type: FunnelNodeType): number {
  switch (type) {
    case "traffic-source": return 105;
    case "list-segment":   return 135;
    default:               return 90;
  }
}

function nodeShape(type: FunnelNodeType): string {
  switch (type) {
    case "qualifier":    return "diamond";
    case "closer":       return "rectangle";
    case "retention":    return "ellipse";
    case "list-segment": return "round-rectangle";
    default:             return "round-rectangle";
  }
}

// ─── Graph definition ────────────────────────────────────────────────────────

function n(
  id: string,
  label: string,
  type: FunnelNodeType,
  section: FunnelSection,
  x: number,
  y: number,
  extra?: Partial<FunnelNode>,
) {
  return { data: { id, label, type, section, ...(extra ?? {}) }, position: { x, y } };
}

function e(
  id: string,
  source: string,
  target: string,
  volume = 100,
  edgeType: "solid" | "dashed" = "solid",
) {
  return { data: { id, source, target, volume, type: edgeType } };
}

function buildLabel(d: FunnelNode): string {
  const vol = d.metrics?.volume;
  const rate = d.metrics?.conversionRate;
  let sub = "";
  if (vol !== undefined) sub = fmtVol(vol);
  if (rate !== undefined) sub += (sub ? " · " : "") + Math.round(rate * 100) + "%";
  return sub ? `${d.label}\n${sub}` : d.label;
}

function getFunnelElements() {
  const nodes = [
    // ── Traffic Sources ────────────────────────────────────────────────────
    n("paid-ads",      "Paid Ads",     "traffic-source", "traffic", 200,  50, { status: "active",  metrics: { volume: 5000  } }),
    n("content-hub",   "Content",      "traffic-source", "traffic", 750,  50, { status: "active",  metrics: { volume: 12000 } }),
    n("outreach-hub",  "Outreach",     "traffic-source", "traffic", 1350, 50, { status: "active",  metrics: { volume: 3000  } }),
    n("partnerships",  "Partnerships", "traffic-source", "traffic", 1900, 50, {                    metrics: { volume: 800   } }),

    // ── Platforms (content channels) ──────────────────────────────────────
    n("ig",          "Instagram",   "platform", "traffic", 470,  230, { metrics: { volume: 3500 } }),
    n("tw",          "Twitter",     "platform", "traffic", 640,  230, { metrics: { volume: 1200 } }),
    n("yt",          "YouTube",     "platform", "traffic", 810,  230, { metrics: { volume: 4500 } }),
    n("tt",          "TikTok",      "platform", "traffic", 980,  230, { status: "active", metrics: { volume: 8000 } }),
    n("li",          "LinkedIn",    "platform", "traffic", 1150, 230, { metrics: { volume: 2000 } }),

    // ── Outreach channels ─────────────────────────────────────────────────
    n("cold-email",  "Cold Email",   "platform", "traffic", 1200, 230, { metrics: { volume: 1500 } }),
    n("cold-dm",     "Cold DMs",     "platform", "traffic", 1370, 230, { metrics: { volume: 800  } }),
    n("prospecting", "Prospecting",  "platform", "traffic", 1540, 230, { metrics: { volume: 700  } }),

    // ── Lead Capture ──────────────────────────────────────────────────────
    n("lm-paid",     "Lead Magnet", "lead-magnet", "capture", 200,  430, { metrics: { volume: 1200, conversionRate: 0.24 } }),
    n("lm-content",  "Lead Magnet", "lead-magnet", "capture", 810,  430, { metrics: { volume: 3800, conversionRate: 0.18 } }),
    n("lm-outreach", "Lead Magnet", "lead-magnet", "capture", 1370, 430, { metrics: { volume: 900,  conversionRate: 0.22 } }),
    n("lm-partners", "Lead Magnet", "lead-magnet", "capture", 1900, 430, { metrics: { volume: 250,  conversionRate: 0.30 } }),

    // ── Nurture ───────────────────────────────────────────────────────────
    n("thankyou",    "Thank You Page", "nurture", "capture", 950, 620, { metrics: { volume: 6150 } }),
    n("email-flows", "Email Flows",    "nurture", "capture", 950, 790, { status: "active", metrics: { volume: 5500 } }),

    // ── MOFU ──────────────────────────────────────────────────────────────
    n("products",    "Products",      "product",          "mofu", 100,  990, { metrics: { volume: 2200 } }),
    n("affiliate",   "Affiliate",     "conversion-asset", "mofu", 330,  990, { metrics: { volume: 800  } }),
    n("webinar",     "Webinar/VSL",   "conversion-asset", "mofu", 560,  990, { status: "active", metrics: { volume: 1800 } }),
    n("workshop",    "Live Workshop", "conversion-asset", "mofu", 790,  990, { metrics: { volume: 900  } }),
    n("newsletter",  "Newsletter",    "nurture",          "mofu", 1020, 990, { status: "active", metrics: { volume: 4500 } }),
    n("community",   "Community",     "nurture",          "mofu", 1250, 990, { metrics: { volume: 3200 } }),
    n("appt-setter", "Appt. Setter",  "closer",           "mofu", 1480, 990, { status: "active", metrics: { volume: 450  } }),
    n("unique-mech", "Unique Mech",   "conversion-asset", "mofu", 1710, 990, { metrics: { volume: 600  } }),

    // ── Qualification ─────────────────────────────────────────────────────
    n("unqualified", "Unqualified", "qualifier", "website", 380,  1195, { status: "warning" }),
    n("qualified",   "Qualified",   "qualifier", "website", 1060, 1195, { status: "active", metrics: { volume: 280, conversionRate: 0.05 } }),

    // ── Website assets ────────────────────────────────────────────────────
    n("case-studies",  "Case Studies",       "website-asset", "website", 600,  1380, { metrics: { volume: 280 } }),
    n("free-video",    "Free Video",          "website-asset", "website", 860,  1380, { metrics: { volume: 280 } }),
    n("testimonials",  "Video Testimonials",  "website-asset", "website", 1120, 1380, { metrics: { volume: 280 } }),
    n("vsl-page",      "VSL",                 "website-asset", "website", 1380, 1380, { status: "active", metrics: { volume: 250 } }),

    // ── Closer ────────────────────────────────────────────────────────────
    n("precall",    "Pre-Call Flow", "closer", "website", 1060, 1545, { status: "active",  metrics: { volume: 220, conversionRate: 0.70 } }),
    n("sales-call", "Sales Call",    "closer", "website", 1060, 1710, { status: "active",  metrics: { volume: 154, conversionRate: 0.35 } }),

    // ── Full Funnel sidebar ───────────────────────────────────────────────
    n("social-proof-list", "Social Proof List",    "list-segment", "website", 2100, 540,  { metrics: { volume: 450 } }),
    n("potential-list",    "Potential Client List", "list-segment", "website", 2100, 810,  { metrics: { volume: 180 } }),
    n("dream-list",        "Dream Client List",     "list-segment", "website", 2100, 1080, { status: "active", metrics: { volume: 45 } }),

    // ── Retention ─────────────────────────────────────────────────────────
    n("program", "Program", "retention", "retention", 700,  1900, { status: "active", metrics: { volume: 54 } }),
    n("course",  "Course",  "retention", "retention", 1060, 1900, {                   metrics: { volume: 38 } }),
    n("refer",   "Refer",   "retention", "retention", 1400, 1900, {                   metrics: { volume: 22 } }),
  ];

  const edges = [
    // Traffic → Platforms
    e("paid→lm",        "paid-ads",     "lm-paid",     1200),
    e("c→ig",           "content-hub",  "ig",          3500),
    e("c→tw",           "content-hub",  "tw",          1200),
    e("c→yt",           "content-hub",  "yt",          4500),
    e("c→tt",           "content-hub",  "tt",          8000),
    e("c→li",           "content-hub",  "li",          2000),
    e("o→email",        "outreach-hub", "cold-email",  1500, "dashed"),
    e("o→dm",           "outreach-hub", "cold-dm",     800,  "dashed"),
    e("o→prospect",     "outreach-hub", "prospecting", 700,  "dashed"),
    e("p→lm",           "partnerships", "lm-partners", 250),

    // Platforms → Lead Magnets
    e("ig→lm",    "ig",          "lm-content",  3500),
    e("tw→lm",    "tw",          "lm-content",  1200),
    e("yt→lm",    "yt",          "lm-content",  4500),
    e("tt→lm",    "tt",          "lm-content",  8000),
    e("li→lm",    "li",          "lm-content",  2000),
    e("em→lm",    "cold-email",  "lm-outreach", 1500, "dashed"),
    e("dm→lm",    "cold-dm",     "lm-outreach", 800,  "dashed"),
    e("pr→lm",    "prospecting", "lm-outreach", 700,  "dashed"),

    // Lead Magnets → Thank You
    e("lmp→ty",  "lm-paid",     "thankyou", 1200),
    e("lmc→ty",  "lm-content",  "thankyou", 3800),
    e("lmo→ty",  "lm-outreach", "thankyou", 900),
    e("lmpa→ty", "lm-partners", "thankyou", 250),

    // Thank You → Email Flows
    e("ty→flows", "thankyou", "email-flows", 6150),

    // Email Flows → MOFU
    e("f→prod",  "email-flows", "products",    2200),
    e("f→aff",   "email-flows", "affiliate",   800),
    e("f→web",   "email-flows", "webinar",     1800),
    e("f→wksh",  "email-flows", "workshop",    900),
    e("f→news",  "email-flows", "newsletter",  4500),
    e("f→comm",  "email-flows", "community",   3200),
    e("f→set",   "email-flows", "appt-setter", 450),
    e("f→mech",  "email-flows", "unique-mech", 600),

    // MOFU → Qualification
    e("prod→uq",  "products",    "unqualified", 1800, "dashed"),
    e("prod→q",   "products",    "qualified",   400),
    e("web→q",    "webinar",     "qualified",   900),
    e("wksh→q",   "workshop",    "qualified",   450),
    e("set→q",    "appt-setter", "qualified",   450),
    e("comm→q",   "community",   "qualified",   320),
    e("news→q",   "newsletter",  "qualified",   450),

    // Qualified → Website
    e("q→case", "qualified", "case-studies", 280),
    e("q→vid",  "qualified", "free-video",   280),
    e("q→test", "qualified", "testimonials", 280),
    e("q→vsl",  "qualified", "vsl-page",     280),

    // Website → Pre-Call → Sales
    e("case→pc",  "case-studies", "precall",    220),
    e("vid→pc",   "free-video",   "precall",    220),
    e("test→pc",  "testimonials", "precall",    220),
    e("vsl→pc",   "vsl-page",     "precall",    220),
    e("pc→call",  "precall",      "sales-call", 154),

    // Sidebar list chain + connections
    e("sp→pl", "social-proof-list", "potential-list",    300),
    e("pl→dl", "potential-list",    "dream-list",        150),
    e("sp→cs", "social-proof-list", "case-studies",      180, "dashed"),
    e("pl→set","potential-list",    "appt-setter",       120, "dashed"),
    e("dl→sc", "dream-list",        "sales-call",         45, "dashed"),

    // Sales → Retention
    e("call→prog",  "sales-call", "program", 54),
    e("call→course","sales-call", "course",  38),
    e("prog→refer", "program",    "refer",   22),
    e("crs→refer",  "course",     "refer",   16),
  ];

  return { nodes, edges };
}

// ─── Storage ─────────────────────────────────────────────────────────────────

const STORAGE_KEY = "infinibot.funnel.v1";

function loadPositions(): Record<string, { x: number; y: number }> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return (JSON.parse(raw) as { positions: Record<string, { x: number; y: number }> }).positions ?? {};
  } catch { /* ignore */ }
  return {};
}

function savePositions(cy: Core) {
  const positions: Record<string, { x: number; y: number }> = {};
  cy.nodes().forEach((n: NodeSingular) => { positions[n.id()] = n.position(); });
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ positions }));
}

// ─── Component ──────────────────────────────────────────────────────────────

@customElement("agency-funnel-view")
export class AgencyFunnelView extends LitElement {
  @state() private _selectedNode: FunnelNode | null = null;
  @state() private _section: FunnelSection = "all";
  @state() private _liveEnabled = false;
  @state() private _contextMenu: { x: number; y: number; nodeId: string } | null = null;

  private _cy: Core | null = null;
  private _pulseTimer: ReturnType<typeof setInterval> | null = null;
  private _unsubscribe: (() => void) | null = null;

  static styles = css`
    :host {
      display: block;
      height: 100%;
      overflow: hidden;
      background: var(--glass-3);
      color: var(--glass-fg);
      font-family: var(--font-mono, ui-monospace, "JetBrains Mono", monospace);
    }

    .funnel-page {
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
    }

    /* ── Toolbar ─────────────────────────────────────────────────────────── */
    .toolbar {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 14px;
      background: linear-gradient(to right, rgba(20,16,8,0.97), color-mix(in srgb, var(--glass-base) 97%, transparent));
      border-bottom: 1px solid color-mix(in srgb, var(--glass-gold) 25%, transparent);
      flex-shrink: 0;
      flex-wrap: wrap;
      z-index: 10;
    }

    .toolbar-title {
      font-size: 13px;
      font-weight: 700;
      color: var(--g-primary, var(--glass-gold));
      margin-right: 6px;
      letter-spacing: 1.5px;
      text-transform: uppercase;
      flex-shrink: 0;
    }

    .section-btns {
      display: flex;
      gap: 3px;
      flex-wrap: wrap;
    }

    .btn {
      padding: 4px 11px;
      border-radius: 5px;
      border: 1px solid color-mix(in srgb, var(--glass-fg) 12%, transparent);
      background: color-mix(in srgb, var(--glass-fg) 4%, transparent);
      color: var(--glass-fg-2);
      font-size: 11px;
      cursor: pointer;
      transition: all 0.15s;
      font-family: inherit;
      line-height: 1.6;
    }

    .btn:hover {
      background: color-mix(in srgb, var(--glass-fg) 9%, transparent);
      border-color: color-mix(in srgb, var(--glass-gold) 35%, transparent);
      color: var(--glass-fg);
    }

    .btn.active {
      background: color-mix(in srgb, var(--glass-gold) 18%, transparent);
      border-color: color-mix(in srgb, var(--glass-gold) 65%, transparent);
      color: var(--g-primary, var(--glass-gold));
    }

    .toolbar-end {
      margin-left: auto;
      display: flex;
      gap: 4px;
      align-items: center;
    }

    .btn-live.on {
      background: rgba(76,175,80,0.18);
      border-color: rgba(76,175,80,0.55);
      color: #4caf50;
    }

    .live-dot {
      display: inline-block;
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: #4caf50;
      margin-right: 4px;
      animation: blink 1.4s ease-in-out infinite;
      vertical-align: middle;
    }

    @keyframes blink {
      0%, 100% { opacity: 1; }
      50%       { opacity: 0.3; }
    }

    /* ── Canvas ──────────────────────────────────────────────────────────── */
    .canvas-wrap {
      position: relative;
      flex: 1;
      min-height: 0;
      overflow: hidden;
    }

    #cy-container {
      width: 100%;
      height: 100%;
      background: var(--glass-3);
    }

    /* ── Detail drawer ───────────────────────────────────────────────────── */
    .detail-drawer {
      position: absolute;
      top: 0;
      right: 0;
      width: 320px;
      height: 100%;
      background: linear-gradient(168deg, rgba(22,18,10,0.96), color-mix(in srgb, var(--glass-base) 97%, transparent));
      border-left: 1px solid color-mix(in srgb, var(--glass-gold) 28%, transparent);
      backdrop-filter: blur(24px) saturate(180%);
      overflow-y: auto;
      transform: translateX(100%);
      transition: transform 0.22s cubic-bezier(0.16,1,0.3,1);
      z-index: 20;
      padding: 14px;
      box-sizing: border-box;
    }

    .detail-drawer.open {
      transform: translateX(0);
    }

    .drawer-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      margin-bottom: 14px;
      gap: 8px;
    }

    .drawer-title {
      font-size: 15px;
      font-weight: 700;
      color: var(--glass-fg);
      margin: 0 0 4px;
      line-height: 1.2;
    }

    .type-badge {
      display: inline-block;
      padding: 2px 7px;
      border-radius: 4px;
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      font-weight: 600;
    }

    .drawer-close {
      width: 26px;
      height: 26px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 5px;
      border: 1px solid color-mix(in srgb, var(--glass-fg) 12%, transparent);
      background: color-mix(in srgb, var(--glass-fg) 4%, transparent);
      cursor: pointer;
      color: var(--glass-fg-2);
      flex-shrink: 0;
      font-size: 12px;
    }

    .drawer-close:hover {
      background: color-mix(in srgb, var(--glass-fg) 10%, transparent);
      color: var(--glass-fg);
    }

    .section-lbl {
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: color-mix(in srgb, var(--glass-gold) 65%, transparent);
      margin-bottom: 7px;
    }

    .drawer-sect {
      margin-bottom: 14px;
    }

    .metric-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
    }

    .metric-card {
      padding: 9px 10px;
      border-radius: 7px;
      background: color-mix(in srgb, var(--glass-fg) 4%, transparent);
      border: 1px solid color-mix(in srgb, var(--glass-fg) 7%, transparent);
    }

    .metric-val {
      font-size: 19px;
      font-weight: 700;
      color: var(--g-primary, var(--glass-gold));
      line-height: 1;
    }

    .metric-lbl {
      font-size: 9px;
      color: var(--glass-fg-3);
      margin-top: 3px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .agent-chip {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 4px 9px;
      border-radius: 5px;
      background: rgba(123,77,255,0.18);
      border: 1px solid rgba(123,77,255,0.38);
      font-size: 11px;
      color: #b39dff;
    }

    .agent-dot {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: #7b4dff;
    }

    .url-link {
      display: block;
      color: #4dd0e1;
      font-size: 11px;
      word-break: break-all;
      text-decoration: none;
      padding: 5px 8px;
      border-radius: 5px;
      background: color-mix(in srgb, var(--glass-gold) 7%, transparent);
      border: 1px solid color-mix(in srgb, var(--glass-gold) 18%, transparent);
    }

    .url-link:hover {
      background: color-mix(in srgb, var(--glass-gold) 13%, transparent);
    }

    textarea.prompt-hint {
      width: 100%;
      min-height: 72px;
      background: color-mix(in srgb, var(--glass-fg) 4%, transparent);
      border: 1px solid color-mix(in srgb, var(--glass-fg) 9%, transparent);
      border-radius: 5px;
      color: var(--glass-fg);
      font-size: 11px;
      padding: 7px;
      resize: vertical;
      font-family: inherit;
      box-sizing: border-box;
    }

    .quick-actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 5px;
    }

    .qa-btn {
      padding: 7px 6px;
      border-radius: 5px;
      border: 1px solid color-mix(in srgb, var(--glass-gold) 25%, transparent);
      background: color-mix(in srgb, var(--glass-gold) 7%, transparent);
      color: color-mix(in srgb, var(--glass-gold) 85%, transparent);
      font-size: 10px;
      cursor: pointer;
      text-align: center;
      transition: all 0.15s;
      font-family: inherit;
    }

    .qa-btn:hover {
      background: color-mix(in srgb, var(--glass-gold) 14%, transparent);
      border-color: color-mix(in srgb, var(--glass-gold) 45%, transparent);
    }

    .tools-list {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }

    .tool-chip {
      padding: 2px 6px;
      border-radius: 3px;
      background: rgba(0,150,136,0.14);
      border: 1px solid rgba(0,150,136,0.28);
      font-size: 10px;
      color: #80cbc4;
    }

    /* ── Context menu ────────────────────────────────────────────────────── */
    .context-menu {
      position: absolute;
      background: linear-gradient(168deg, rgba(22,18,10,0.99), color-mix(in srgb, var(--glass-base) 99%, transparent));
      border: 1px solid color-mix(in srgb, var(--glass-gold) 38%, transparent);
      border-radius: 8px;
      padding: 4px;
      z-index: 100;
      min-width: 155px;
      backdrop-filter: blur(20px);
      box-shadow: 0 8px 32px rgba(0,0,0,0.6);
    }

    .ctx-item {
      padding: 6px 11px;
      border-radius: 4px;
      font-size: 11px;
      color: var(--glass-fg-2);
      cursor: pointer;
      user-select: none;
    }

    .ctx-item:hover {
      background: color-mix(in srgb, var(--glass-gold) 14%, transparent);
      color: var(--glass-fg);
    }

    .ctx-item.danger {
      color: rgba(244,67,54,0.75);
    }

    .ctx-item.danger:hover {
      background: rgba(244,67,54,0.14);
      color: #f44336;
    }

    /* ── Legend ──────────────────────────────────────────────────────────── */
    .legend {
      position: absolute;
      bottom: 10px;
      left: 10px;
      display: flex;
      gap: 10px;
      background: color-mix(in srgb, var(--glass-base) 85%, transparent);
      border: 1px solid color-mix(in srgb, var(--glass-fg) 9%, transparent);
      border-radius: 7px;
      padding: 6px 10px;
      font-size: 10px;
      color: var(--glass-fg-2);
      backdrop-filter: blur(8px);
      z-index: 5;
    }

    .legend-dot {
      display: inline-block;
      width: 7px;
      height: 7px;
      border-radius: 50%;
      margin-right: 3px;
      vertical-align: middle;
    }

    /* ── Divider ─────────────────────────────────────────────────────────── */
    .divider {
      border: none;
      border-top: 1px solid color-mix(in srgb, var(--glass-fg) 6%, transparent);
      margin: 12px 0;
    }
  `;

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._pulseTimer != null) clearInterval(this._pulseTimer);
    if (this._unsubscribe) this._unsubscribe();
    if (this._cy) { this._cy.destroy(); this._cy = null; }
  }

  firstUpdated() {
    this._initCytoscape();
  }

  // ── Cytoscape init ────────────────────────────────────────────────────────

  private _initCytoscape() {
    const container = this.renderRoot.querySelector<HTMLElement>("#cy-container");
    if (!container) return;

    const saved = loadPositions();
    const { nodes: rawNodes, edges } = getFunnelElements();

    const nodes = rawNodes.map((node) => {
      const pos = saved[node.data.id];
      return pos ? { ...node, position: pos } : node;
    });

    this._cy = cytoscape({
      container,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      elements: { nodes, edges } as any,
      layout: { name: "preset" },
      style: this._buildStyle(),
      minZoom: 0.08,
      maxZoom: 3,
      wheelSensitivity: 0.25,
    });

    if (Object.keys(saved).length === 0) {
      this._cy.fit(undefined, 50);
    }

    this._cy.on("dragfree", () => { if (this._cy) savePositions(this._cy); });

    this._cy.on("tap", "node", (evt) => {
      const nd = evt.target as NodeSingular;
      this._selectedNode = nd.data() as FunnelNode;
      this._contextMenu = null;
    });

    this._cy.on("tap", (evt) => {
      if (evt.target === this._cy) {
        this._selectedNode = null;
        this._contextMenu = null;
      }
    });

    this._cy.on("cxttap", "node", (evt) => {
      const nd = evt.target as NodeSingular;
      const rp = nd.renderedPosition();
      this._contextMenu = { x: rp.x, y: rp.y, nodeId: nd.id() };
    });

    this._startPulse();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _buildStyle(): any[] {
    return [
      {
        selector: "node",
        style: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          "background-color": (n: any) => NODE_BG[n.data("type") as FunnelNodeType] ?? "#555",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          "color":            (n: any) => NODE_FG[n.data("type") as FunnelNodeType] ?? "#fff",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          "label":            (n: any) => buildLabel(n.data() as FunnelNode),
          "text-valign":      "center",
          "text-halign":      "center",
          "font-size":        "10px",
          "font-weight":      "600",
          "font-family":      "ui-monospace, monospace",
          "text-wrap":        "wrap",
          "text-max-width":   "88px",
          "line-height":      "1.3",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          "width":            (n: any) => nodeWidth(n.data("type") as FunnelNodeType),
          "height":           38,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          "shape":            (n: any) => nodeShape(n.data("type") as FunnelNodeType),
          "border-width":     2,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          "border-color":     (n: any) => STATUS_BORDER[n.data("status") as string] ?? STATUS_BORDER.idle,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          "border-opacity":   (n: any) => (n.data("status") === "active" ? 1 : 0.35),
        },
      },
      {
        selector: "node.pulsing",
        style: {
          "border-width":   4,
          "border-opacity": 1,
          "overlay-opacity": 0.12,
          "overlay-color":  "#ffffff",
        },
      },
      {
        selector: "node:selected",
        style: {
          "border-width":   3,
          "border-color":   "#d4a017",
          "border-opacity": 1,
          "overlay-opacity": 0.1,
          "overlay-color":  "#d4a017",
        },
      },
      {
        selector: "edge",
        style: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          "width":              (e: any) => Math.max(1.5, Math.log((e.data("volume") as number || 100) + 1) * 1.5),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          "line-color":         (e: any) => e.data("type") === "dashed" ? "rgba(255,255,255,0.18)" : "rgba(212,160,23,0.38)",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          "line-style":         (e: any) => e.data("type") === "dashed" ? "dashed" : "solid",
          "line-dash-pattern":  [6, 4],
          "target-arrow-shape": "triangle",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          "target-arrow-color": (e: any) => e.data("type") === "dashed" ? "rgba(255,255,255,0.18)" : "rgba(212,160,23,0.38)",
          "arrow-scale":        0.65,
          "curve-style":        "bezier",
          "opacity":            0.75,
        },
      },
      {
        selector: "edge:selected",
        style: {
          "line-color":         "#d4a017",
          "target-arrow-color": "#d4a017",
          "opacity":            1,
        },
      },
    ];
  }

  // ── Animation ─────────────────────────────────────────────────────────────

  private _startPulse() {
    this._pulseTimer = setInterval(() => {
      if (!this._cy) return;
      this._cy.nodes('[status = "active"]').forEach((n: NodeSingular) => {
        n.flashClass("pulsing", 700);
      });
    }, 2200);
  }

  // ── Section filter ────────────────────────────────────────────────────────

  private _setSection(section: FunnelSection) {
    this._section = section;
    if (!this._cy) return;

    this._cy.elements().show();

    if (section !== "all") {
      this._cy.nodes().forEach((nd: NodeSingular) => {
        const ns = nd.data("section") as string;
        if (ns !== section) nd.hide();
      });
      this._cy.edges().forEach((ed) => {
        if (ed.source().hidden() || ed.target().hidden()) ed.hide();
      });
    }
  }

  // ── Live toggle ──────────────────────────────────────────────────────────

  private _toggleLive() {
    this._liveEnabled = !this._liveEnabled;
    if (this._liveEnabled) {
      this._subscribeLive();
    } else {
      if (this._unsubscribe) { this._unsubscribe(); this._unsubscribe = null; }
    }
  }

  private _subscribeLive() {
    const client = getGatewayClient();
    if (!client) return;
    this._unsubscribe = client.subscribe((evt: GatewayEventFrame) => {
      if (evt.event !== "infinibot:funnel:update") return;
      const p = evt.payload as { nodeId?: string; metrics?: FunnelNode["metrics"] } | undefined;
      if (!p?.nodeId || !this._cy) return;
      const node = this._cy.$id(p.nodeId);
      if (node.length && p.metrics) {
        node.data("metrics", p.metrics);
        this._cy.style().update();
      }
    });
  }

  // ── Context actions ───────────────────────────────────────────────────────

  private _handleContextAction(action: string) {
    const nodeId = this._contextMenu?.nodeId;
    this._contextMenu = null;
    if (!nodeId || !this._cy) return;
    const node = this._cy.$id(nodeId);

    switch (action) {
      case "edit":
        this._selectedNode = node.data() as FunnelNode;
        break;
      case "delete":
        this._cy.remove(node);
        savePositions(this._cy);
        if (this._selectedNode?.id === nodeId) this._selectedNode = null;
        break;
      case "goal":
        node.data("status", "active");
        this._cy.style().update();
        break;
    }
  }

  // ── Export / fit ─────────────────────────────────────────────────────────

  private _exportPng() {
    if (!this._cy) return;
    const url = (this._cy.png as (opts: Record<string, unknown>) => string)({ full: true, scale: 2, bg: "#080704" });
    const a = document.createElement("a");
    a.href = url;
    a.download = "agency-funnel.png";
    a.click();
  }

  private _fitView() {
    this._cy?.fit(undefined, 50);
  }

  // ── Render ────────────────────────────────────────────────────────────────

  render() {
    return html`
      <div class="funnel-page" @click=${() => { this._contextMenu = null; }}>
        ${this._renderToolbar()}
        <div class="canvas-wrap" @click=${(e: Event) => e.stopPropagation()}>
          <div id="cy-container"></div>
          ${this._renderDrawer()}
          ${this._contextMenu ? this._renderContextMenu() : nothing}
          ${this._renderLegend()}
        </div>
      </div>
    `;
  }

  private _renderToolbar() {
    const sections: [FunnelSection, string][] = [
      ["all",       "Full Funnel"],
      ["traffic",   "Traffic"],
      ["capture",   "Lead Capture"],
      ["mofu",      "MOFU"],
      ["website",   "Website"],
      ["retention", "Retention"],
    ];

    return html`
      <div class="toolbar">
        <span class="toolbar-title">Agency Funnel</span>
        <div class="section-btns">
          ${sections.map(([id, lbl]) => html`
            <button class="btn ${this._section === id ? "active" : ""}"
              @click=${(e: Event) => { e.stopPropagation(); this._setSection(id); }}>
              ${lbl}
            </button>
          `)}
        </div>
        <div class="toolbar-end">
          <button
            class="btn btn-live ${this._liveEnabled ? "on" : ""}"
            @click=${(e: Event) => { e.stopPropagation(); this._toggleLive(); }}>
            ${this._liveEnabled ? html`<span class="live-dot"></span>` : ""}
            Live
          </button>
          <button class="btn" @click=${(e: Event) => { e.stopPropagation(); this._fitView(); }}>⊙ Fit</button>
          <button class="btn" @click=${(e: Event) => { e.stopPropagation(); this._exportPng(); }}>↓ PNG</button>
        </div>
      </div>
    `;
  }

  private _renderDrawer() {
    return html`
      <div class="detail-drawer ${this._selectedNode ? "open" : ""}">
        ${this._selectedNode ? this._renderDrawerContent(this._selectedNode) : nothing}
      </div>
    `;
  }

  private _renderDrawerContent(node: FunnelNode) {
    const bg = NODE_BG[node.type] ?? "#888";
    const fg = NODE_FG[node.type] ?? "#fff";

    return html`
      <div class="drawer-header">
        <div>
          <p class="drawer-title">${node.label}</p>
          <span class="type-badge" style="background:${bg}22;color:${bg};border:1px solid ${bg}44">
            ${node.type}
          </span>
          ${node.status ? html`
            <span class="type-badge" style="margin-left:4px;background:${STATUS_BORDER[node.status]}22;color:${STATUS_BORDER[node.status]};border:1px solid ${STATUS_BORDER[node.status]}44">
              ${node.status}
            </span>
          ` : nothing}
        </div>
        <button class="drawer-close" @click=${() => { this._selectedNode = null; }}>✕</button>
      </div>

      ${node.metrics ? html`
        <div class="drawer-sect">
          <div class="section-lbl">Metrics</div>
          <div class="metric-grid">
            ${node.metrics.volume !== undefined ? html`
              <div class="metric-card">
                <div class="metric-val">${fmtVol(node.metrics.volume)}</div>
                <div class="metric-lbl">Volume</div>
              </div>
            ` : nothing}
            ${node.metrics.conversionRate !== undefined ? html`
              <div class="metric-card">
                <div class="metric-val">${Math.round(node.metrics.conversionRate * 100)}%</div>
                <div class="metric-lbl">Conv. Rate</div>
              </div>
            ` : nothing}
            ${node.metrics.revenue !== undefined ? html`
              <div class="metric-card">
                <div class="metric-val">$${fmtVol(node.metrics.revenue)}</div>
                <div class="metric-lbl">Revenue</div>
              </div>
            ` : nothing}
            ${node.metrics.activeNow !== undefined ? html`
              <div class="metric-card">
                <div class="metric-val">${node.metrics.activeNow}</div>
                <div class="metric-lbl">Active Now</div>
              </div>
            ` : nothing}
          </div>
        </div>
      ` : nothing}

      ${node.agentId ? html`
        <div class="drawer-sect">
          <div class="section-lbl">Assigned Agent</div>
          <div class="agent-chip">
            <span class="agent-dot"></span>
            ${node.agentId}
          </div>
        </div>
      ` : nothing}

      ${node.url ? html`
        <div class="drawer-sect">
          <div class="section-lbl">URL</div>
          <a class="url-link" href="${node.url}" target="_blank" rel="noopener">${node.url}</a>
        </div>
      ` : nothing}

      <div class="drawer-sect">
        <div class="section-lbl">System Prompt Hint</div>
        <textarea class="prompt-hint"
          .value=${node.systemPromptHint ?? ""}
          placeholder="Context for the owning agent…"
          @input=${(ev: Event) => {
            if (!this._selectedNode || !this._cy) return;
            const hint = (ev.target as HTMLTextAreaElement).value;
            this._selectedNode = { ...this._selectedNode, systemPromptHint: hint };
            this._cy.$id(node.id).data("systemPromptHint", hint);
          }}></textarea>
      </div>

      <hr class="divider" />

      <div class="drawer-sect">
        <div class="section-lbl">Quick Actions</div>
        <div class="quick-actions">
          <button class="qa-btn">⚡ Assign Agent</button>
          <button class="qa-btn" @click=${() => node.url && window.open(node.url, "_blank")}>🔗 Open URL</button>
          <button class="qa-btn">▶ Run Task</button>
          <button class="qa-btn">📊 Reports</button>
        </div>
      </div>

      ${node.tools?.length ? html`
        <div class="drawer-sect">
          <div class="section-lbl">Tools</div>
          <div class="tools-list">
            ${node.tools.map((t) => html`<span class="tool-chip">${t}</span>`)}
          </div>
        </div>
      ` : nothing}

      <div style="color:rgba(255,255,255,0.18);font-size:9px;margin-top:8px">
        ID: ${node.id} · Section: ${node.section}
      </div>
    `;

    // satisfy TS unused import warning suppression
    void fg;
  }

  private _renderContextMenu() {
    const cm = this._contextMenu!;
    return html`
      <div class="context-menu" style="left:${cm.x}px;top:${cm.y}px;"
        @click=${(e: Event) => e.stopPropagation()}>
        <div class="ctx-item" @click=${() => this._handleContextAction("edit")}>✏️ Edit</div>
        <div class="ctx-item" @click=${() => this._handleContextAction("goal")}>🎯 Set as Goal</div>
        <div class="ctx-item" @click=${() => this._handleContextAction("assign")}>🤖 Assign Agent</div>
        <div class="ctx-item" @click=${() => this._handleContextAction("link")}>🔗 Link URL</div>
        <div class="ctx-item" @click=${() => this._handleContextAction("reports")}>📊 View Reports</div>
        <div class="ctx-item danger" @click=${() => this._handleContextAction("delete")}>🗑 Delete Node</div>
      </div>
    `;
  }

  private _renderLegend() {
    const items: [string, string][] = [
      ["#4caf50", "Active"],
      ["#ff9800", "Warning"],
      ["#f44336", "Critical"],
      ["rgba(255,255,255,0.3)", "Idle"],
    ];
    return html`
      <div class="legend">
        ${items.map(([color, lbl]) => html`
          <span>
            <span class="legend-dot" style="background:${color}"></span>${lbl}
          </span>
        `)}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "agency-funnel-view": AgencyFunnelView;
  }
}
