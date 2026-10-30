/**
 * Funnel Flow Map — Vertical Node-Based Funnel Visualization
 * Terminal-style aesthetic with SVG icons
 */

import { html, nothing, type TemplateResult } from "lit";
import { icons as pIcons } from "../icons";
import { renderIntegrationsPanel, initIntegrationsPanel, setIntegrationsRequestUpdate } from "./integrations-panel.js";
import type { GatewayBrowserClient } from "../gateway-client.js";
import { type FeatureConfigField, type PlatformFeature, PLATFORM_FEATURES } from './platform-features.js';
import { gatewayOrigin } from "../gateway-endpoint";

// ══════════════════════════════════════════════════════════════════════════════
// SVG ICONS — Terminal/Tech Style
// ══════════════════════════════════════════════════════════════════════════════

const icons = {
  // Node types
  entry: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M13.8 12H3"/></svg>`,
  social: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.59 13.51l6.83 3.98M15.41 6.51l-6.82 3.98"/></svg>`,
  messaging: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
  hub: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>`,
  offer: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
  landing: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>`,
  qualification: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>`,
  custom: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
  
  // Platforms
  instagram: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="5" ry="5"/><circle cx="12" cy="12" r="4"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg>`,
  tiktok: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 12a4 4 0 1 0 4 4V4a5 5 0 0 0 5 5"/></svg>`,
  youtube: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22.54 6.42a2.78 2.78 0 0 0-1.94-2C18.88 4 12 4 12 4s-6.88 0-8.6.46a2.78 2.78 0 0 0-1.94 2A29 29 0 0 0 1 11.75a29 29 0 0 0 .46 5.33A2.78 2.78 0 0 0 3.4 19c1.72.46 8.6.46 8.6.46s6.88 0 8.6-.46a2.78 2.78 0 0 0 1.94-2 29 29 0 0 0 .46-5.25 29 29 0 0 0-.46-5.33z"/><polygon points="9.75 15.02 15.5 11.75 9.75 8.48 9.75 15.02"/></svg>`,
  twitter: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4l11.733 16h4.267l-11.733-16zM4 20l6.4-6.4M20 4l-6.4 6.4"/></svg>`,
  linkedin: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z"/><rect x="2" y="9" width="4" height="12"/><circle cx="4" cy="4" r="2"/></svg>`,
  telegram: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>`,
  discord: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 12a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM15 12a1 1 0 1 0 0-2 1 1 0 0 0 0 2z"/><path d="M7.5 7.5c3.5-1 5.5-1 9 0M7 16.5c3.5 1 6.5 1 10 0"/><path d="M15.5 17c0 1 1.5 3 2 3 1.5 0 2.833-1.667 3.5-3 .667-1.667.5-5.833-1.5-11.5-1.457-1.015-3-1.34-4.5-1.5l-1 2M8.5 17c0 1-1.5 3-2 3-1.5 0-2.833-1.667-3.5-3-.667-1.667-.5-5.833 1.5-11.5C5.957 4.485 7.5 4.16 9 4l1 2"/></svg>`,
  whatsapp: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>`,
  website: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`,
  app: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>`,
  email: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>`,

  // Actions
  settings: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
  link: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`,
  trash: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
  plus: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
  minus: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
  reset: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>`,
  close: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
  check: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>`,
  chevronRight: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>`,
  chevronLeft: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>`,
  api: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 17h8M12 17l4-8 4 8M14 17h4"/><path d="M8 7V3M4 7h8M4 7l2 10M12 7l-2 10"/></svg>`,
  webhook: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4L8.12 15.88M14.47 14.48L20 20M8.12 8.12L12 12"/></svg>`,
  manual: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/><circle cx="11" cy="11" r="2"/></svg>`,
  ai: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a4 4 0 0 1 4 4v2a4 4 0 0 1-8 0V6a4 4 0 0 1 4-4z"/><path d="M16 12v4a4 4 0 0 1-8 0v-4"/><line x1="12" y1="16" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/></svg>`,
  copy: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
  move: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/><polyline points="15 19 12 22 9 19"/><polyline points="19 9 22 12 19 15"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/></svg>`,
  bullet: html`<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="4"/></svg>`,
  connected: html`<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="5"/></svg>`,
  disconnected: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/></svg>`,
  
  // Community
  users: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
  
  // Page/Directory
  folder: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`,
  code: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`,
  externalLink: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`,
  edit: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
  eye: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`,
  chart: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>`,
  sparkles: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z"/><path d="M5 19l.5 1.5L7 21l-1.5.5L5 23l-.5-1.5L3 21l1.5-.5L5 19z"/><path d="M19 11l.5 1.5L21 13l-1.5.5L19 15l-.5-1.5L17 13l1.5-.5L19 11z"/></svg>`,
  zap: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
  
  // Templates
  template1: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 8v8M8 12h8"/></svg>`,
  template2: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v18M3 12h18"/><circle cx="12" cy="12" r="3"/></svg>`,
  template3: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>`,
  flowmap: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="3" width="6" height="6" rx="1"/><rect x="9" y="15" width="6" height="6" rx="1"/><path d="M6 9v3a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V9"/><path d="M12 12v3"/></svg>`,
};

// ══════════════════════════════════════════════════════════════════════════════
// TYPES
// ══════════════════════════════════════════════════════════════════════════════

export type FlowNodeType = 
  | "entry" | "social" | "messaging" | "hub" | "offer" | "landing" | "qualification" | "community" | "custom";

export type PlatformType = 
  | "instagram" | "tiktok" | "youtube" | "twitter" | "linkedin"
  | "telegram" | "discord" | "whatsapp" | "website" | "app" | "email";

export interface FlowNode {
  id: string;
  type: FlowNodeType;
  platform?: PlatformType;
  name: string;
  description?: string;
  color?: string;
  row: number;
  column: number;
  width?: number;
  items?: FlowNodeItem[];
  config?: Record<string, any>;
  integration?: {
    type: "api" | "scraping" | "manual" | "webhook";
    connected: boolean;
    lastSync?: number;
    apiKey?: string;
    accessToken?: string;
    refreshToken?: string;
    webhookSecret?: string;
  };
  // Page/Site linking (for landing, offer, etc.)
  pageLink?: {
    type: "directory" | "external" | "none";
    directoryPath?: string;      // e.g., "/sites/my-landing"
    externalUrl?: string;        // e.g., "https://example.com/offer"
    lastEdited?: number;
  };
  // KPI Tracking
  kpiTracking?: {
    enabled: boolean;
    siteId: string;
    trackClicks: boolean;
    trackScroll: boolean;
    trackForms: boolean;
    conversionGoal?: "form_submit" | "button_click" | "page_visit" | "custom";
    customEventName?: string;
  };
  /**
   * Production node library entry id (e.g. "instagram", "email_seq",
   * "sales_page"). Surface-level identity used by the AddNode modal +
   * hover analytics. Internally the node still resolves to a
   * FlowNodeType + optional PlatformType via NODE_LIBRARY, so legacy
   * flow maps without a libraryId still render correctly.
   */
  libraryId?: string;
  /**
   * When the parent flow map is promoted to a funnel (Slice B), each
   * node binds to a funnel stage by id. Hover analytics joins on this
   * to pull real lead counts from funnels.flow.snapshot.
   */
  stageId?: string;
}

export interface FlowNodeItem {
  id: string;
  label: string;
  icon?: string;
  enabled: boolean;
}

export interface FlowConnection {
  id: string;
  from: string;
  to: string;
  label?: string;
  conversionRate?: number;
  conditionType?: 'manual' | 'auto' | 'rule';
  conditionConfig?: {
    ruleId?: string;
    ruleName?: string;
    conditions?: { field: string; operator: string; value: unknown }[];
  };
  transitionCount?: number;
}

export interface FunnelFlowMap {
  id: string;
  name: string;
  businessId: string;
  nodes: FlowNode[];
  connections: FlowConnection[];
  /**
   * Optional binding to a live funnel record (funnels.db). When set,
   * each FlowNode's `stageId` maps to a funnel stage, and the hover
   * analytics card pulls real lead counts via funnels.flow.snapshot.
   *
   * Materialized by `funnels.flowmap.promote` (Slice B). Until promoted,
   * the canvas is a draft — visual only, no analytics.
   */
  funnelId?: string;
}

// ══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ══════════════════════════════════════════════════════════════════════════════

const NODE_COLORS: Record<FlowNodeType, string> = {
  entry: "var(--g-primary)",
  social: "#a78bfa",
  messaging: "#60a5fa",
  hub: "#818cf8",
  offer: "#f97316",
  landing: "#34d399",
  qualification: "#06b6d4",
  community: "#10b981",
  custom: "#ec4899",
};

const PLATFORM_CONFIG: Record<PlatformType, { icon: keyof typeof icons; label: string; color: string }> = {
  instagram: { icon: "instagram", label: "INSTAGRAM", color: "#E4405F" },
  tiktok: { icon: "tiktok", label: "TIKTOK", color: "#ff0050" },
  youtube: { icon: "youtube", label: "YOUTUBE", color: "#FF0000" },
  twitter: { icon: "twitter", label: "X / TWITTER", color: "#ffffff" },
  linkedin: { icon: "linkedin", label: "LINKEDIN", color: "#0A66C2" },
  telegram: { icon: "telegram", label: "TELEGRAM", color: "#0088CC" },
  discord: { icon: "discord", label: "DISCORD", color: "#5865F2" },
  whatsapp: { icon: "whatsapp", label: "WHATSAPP", color: "#25D366" },
  website: { icon: "website", label: "WEBSITE", color: "#6366f1" },
  app: { icon: "app", label: "MOBILE APP", color: "#8b5cf6" },
  email: { icon: "email", label: "EMAIL", color: "#ea580c" },
};

const NODE_TYPE_CONFIG: Record<FlowNodeType, { icon: keyof typeof icons; label: string; description: string }> = {
  entry: { icon: "entry", label: "ENTRY POINT", description: "Where leads enter your funnel" },
  social: { icon: "social", label: "SOCIAL MEDIA", description: "Social media traffic source" },
  messaging: { icon: "messaging", label: "MESSAGING", description: "Direct messaging channel" },
  hub: { icon: "hub", label: "CENTRAL HUB", description: "Main destination step" },
  offer: { icon: "offer", label: "OFFER", description: "Product or service" },
  landing: { icon: "landing", label: "LANDING PAGE", description: "Conversion page" },
  qualification: { icon: "qualification", label: "LEAD SCORING", description: "AI-powered lead scoring" },
  community: { icon: "users", label: "COMMUNITY", description: "Community platform connection" },
  custom: { icon: "custom", label: "CUSTOM", description: "Custom step type" },
};

// ══════════════════════════════════════════════════════════════════════════════
// NODE LIBRARY — production-level building blocks
// ══════════════════════════════════════════════════════════════════════════════
//
// The AddNode modal renders directly from this registry. Each entry is a
// concrete thing a production funnel contains (an Instagram source, an
// email nurture sequence, a sales page, a course community, etc.) —
// flat and clickable, no "social → instagram" sub-pickers.
//
// Each entry maps to an existing FlowNodeType (+ optional PlatformType)
// so the wire format and analytics paths stay unchanged. Adding a node
// from the library writes both `libraryId` (canonical id) and the
// derived type/platform onto the node.

export type NodeLibraryCategory =
  | "Source"
  | "Capture"
  | "Qualify"
  | "Nurture"
  | "Convert"
  | "Destination"
  | "Outcome";

export interface NodeLibraryEntry {
  id: string;
  label: string;
  description: string;
  category: NodeLibraryCategory;
  emoji: string;
  icon: keyof typeof icons;
  color: string;
  type: FlowNodeType;
  platform?: PlatformType;
  defaultName: string;
  defaultItems?: ReadonlyArray<{ id: string; label: string; enabled: boolean }>;
  /** Maps to funnels.db Stage.type when promoted. */
  stageType?: "entry" | "standard" | "qualified" | "won" | "lost";
  /** Tags used for fuzzy search ("ads", "paid", "meta" all match Paid Ad). */
  tags?: ReadonlyArray<string>;
}

export const NODE_LIBRARY: ReadonlyArray<NodeLibraryEntry> = [
  // ── Sources: where leads come from ─────────────────────────
  {
    id: "instagram",
    label: "Instagram",
    description: "Posts, DMs, stories, link-in-bio",
    category: "Source",
    emoji: "📸",
    icon: "social",
    color: "#E4405F",
    type: "social",
    platform: "instagram",
    defaultName: "INSTAGRAM",
    stageType: "entry",
    defaultItems: [
      { id: "dm", label: "DM_FLOWS", enabled: true },
      { id: "bio", label: "LINK_IN_BIO", enabled: true },
    ],
    tags: ["meta", "ig", "social"],
  },
  {
    id: "tiktok",
    label: "TikTok",
    description: "Short-form video traffic & bio link",
    category: "Source",
    emoji: "🎬",
    icon: "social",
    color: "#ff0050",
    type: "social",
    platform: "tiktok",
    defaultName: "TIKTOK",
    stageType: "entry",
    defaultItems: [{ id: "bio", label: "LINK_IN_BIO", enabled: true }],
    tags: ["video", "short-form"],
  },
  {
    id: "youtube",
    label: "YouTube",
    description: "Long-form video + descriptions",
    category: "Source",
    emoji: "▶️",
    icon: "social",
    color: "#FF0000",
    type: "social",
    platform: "youtube",
    defaultName: "YOUTUBE",
    stageType: "entry",
    defaultItems: [
      { id: "bio", label: "LINK_IN_BIO", enabled: true },
      { id: "comments", label: "LINK_IN_COMMENTS", enabled: true },
    ],
    tags: ["video", "long-form"],
  },
  {
    id: "twitter",
    label: "X / Twitter",
    description: "Short-form threads & replies",
    category: "Source",
    emoji: "🐦",
    icon: "social",
    color: "#ffffff",
    type: "social",
    platform: "twitter",
    defaultName: "X_TWITTER",
    stageType: "entry",
    tags: ["x", "twitter"],
  },
  {
    id: "linkedin",
    label: "LinkedIn",
    description: "B2B posts, DMs, employee shares",
    category: "Source",
    emoji: "💼",
    icon: "social",
    color: "#0A66C2",
    type: "social",
    platform: "linkedin",
    defaultName: "LINKEDIN",
    stageType: "entry",
    tags: ["b2b", "professional"],
  },
  {
    id: "paid_ad",
    label: "Paid Ad",
    description: "Meta / Google / TikTok paid traffic",
    category: "Source",
    emoji: "💰",
    icon: "entry",
    color: "#fbbf24",
    type: "entry",
    defaultName: "PAID_AD",
    stageType: "entry",
    tags: ["meta", "google", "tiktok", "ads"],
  },
  {
    id: "referral",
    label: "Referral",
    description: "Word-of-mouth or partner referral",
    category: "Source",
    emoji: "🤝",
    icon: "entry",
    color: "#a78bfa",
    type: "entry",
    defaultName: "REFERRAL",
    stageType: "entry",
    tags: ["partner", "word-of-mouth"],
  },
  {
    id: "organic_search",
    label: "Organic Search",
    description: "SEO-driven website traffic",
    category: "Source",
    emoji: "🔍",
    icon: "entry",
    color: "#34d399",
    type: "entry",
    defaultName: "ORGANIC_SEARCH",
    stageType: "entry",
    tags: ["seo", "google"],
  },
  {
    id: "cold_outreach",
    label: "Cold Outreach",
    description: "Cold DM / email / call cadence",
    category: "Source",
    emoji: "📧",
    icon: "entry",
    color: "#06b6d4",
    type: "entry",
    defaultName: "COLD_OUTREACH",
    stageType: "entry",
    tags: ["cold", "cadence"],
  },

  // ── Capture: opt-in / contact collection ──────────────────
  {
    id: "lead_magnet",
    label: "Lead Magnet",
    description: "Free PDF / video / template exchange",
    category: "Capture",
    emoji: "🧲",
    icon: "landing",
    color: "#34d399",
    type: "landing",
    defaultName: "LEAD_MAGNET",
    stageType: "standard",
    defaultItems: [{ id: "form", label: "OPT_IN_FORM", enabled: true }],
  },
  {
    id: "newsletter_signup",
    label: "Newsletter",
    description: "Email list opt-in",
    category: "Capture",
    emoji: "📨",
    icon: "landing",
    color: "#34d399",
    type: "landing",
    defaultName: "NEWSLETTER",
    stageType: "standard",
    defaultItems: [{ id: "form", label: "EMAIL_SIGNUP", enabled: true }],
  },
  {
    id: "quiz",
    label: "Quiz",
    description: "Self-segmenting quiz funnel",
    category: "Capture",
    emoji: "❓",
    icon: "qualification",
    color: "#06b6d4",
    type: "qualification",
    defaultName: "QUIZ",
    stageType: "standard",
    defaultItems: [{ id: "questions", label: "QUIZ_QUESTIONS", enabled: true }],
  },
  {
    id: "calendar_booking",
    label: "Calendar Booking",
    description: "Calendly / Cal.com / native scheduler",
    category: "Capture",
    emoji: "📅",
    icon: "landing",
    color: "#34d399",
    type: "landing",
    defaultName: "BOOK_CALL",
    stageType: "standard",
    defaultItems: [{ id: "calendar", label: "CALENDAR", enabled: true }],
    tags: ["calendly", "scheduling"],
  },
  {
    id: "webinar_reg",
    label: "Webinar Registration",
    description: "Live or evergreen webinar opt-in",
    category: "Capture",
    emoji: "🎥",
    icon: "landing",
    color: "#34d399",
    type: "landing",
    defaultName: "WEBINAR_REG",
    stageType: "standard",
    defaultItems: [{ id: "webinar", label: "REGISTRATION", enabled: true }],
  },

  // ── Qualify: filter / score / route ───────────────────────
  {
    id: "lead_scorer",
    label: "Lead Scorer",
    description: "AI-driven scoring against criteria",
    category: "Qualify",
    emoji: "🎯",
    icon: "qualification",
    color: "#06b6d4",
    type: "qualification",
    defaultName: "LEAD_SCORER",
    stageType: "qualified",
    tags: ["ai", "scoring", "qualifier"],
  },
  {
    id: "manual_review",
    label: "Manual Review",
    description: "Operator-approved gate",
    category: "Qualify",
    emoji: "👤",
    icon: "qualification",
    color: "#06b6d4",
    type: "qualification",
    defaultName: "MANUAL_REVIEW",
    stageType: "qualified",
  },
  {
    id: "tag_route",
    label: "Tag Router",
    description: "Branches based on lead tags",
    category: "Qualify",
    emoji: "🏷️",
    icon: "qualification",
    color: "#06b6d4",
    type: "qualification",
    defaultName: "TAG_ROUTER",
    stageType: "standard",
  },

  // ── Nurture: warm the lead ────────────────────────────────
  {
    id: "email_seq",
    label: "Email Sequence",
    description: "Drip nurture series",
    category: "Nurture",
    emoji: "✉️",
    icon: "messaging",
    color: "#ea580c",
    type: "messaging",
    platform: "email",
    defaultName: "EMAIL_SEQUENCE",
    stageType: "standard",
    defaultItems: [{ id: "seq", label: "NURTURE_SEQ", enabled: true }],
  },
  {
    id: "sms_seq",
    label: "SMS Sequence",
    description: "Time-sensitive text nurture",
    category: "Nurture",
    emoji: "💬",
    icon: "messaging",
    color: "#60a5fa",
    type: "messaging",
    platform: "whatsapp",
    defaultName: "SMS_SEQUENCE",
    stageType: "standard",
    tags: ["text", "whatsapp"],
  },
  {
    id: "dm_followup",
    label: "DM Follow-up",
    description: "Manual or automated platform DMs",
    category: "Nurture",
    emoji: "📱",
    icon: "messaging",
    color: "#60a5fa",
    type: "messaging",
    platform: "instagram",
    defaultName: "DM_FOLLOWUP",
    stageType: "standard",
  },
  {
    id: "retargeting_ad",
    label: "Retargeting Ad",
    description: "Paid retargeting to warm leads",
    category: "Nurture",
    emoji: "🔁",
    icon: "social",
    color: "#fbbf24",
    type: "social",
    defaultName: "RETARGETING",
    stageType: "standard",
    tags: ["paid", "retargeting", "remarketing"],
  },
  {
    id: "drip_course",
    label: "Drip Course",
    description: "Released-over-time training content",
    category: "Nurture",
    emoji: "🎓",
    icon: "messaging",
    color: "#a78bfa",
    type: "messaging",
    platform: "email",
    defaultName: "DRIP_COURSE",
    stageType: "standard",
  },

  // ── Convert: where the sale happens ────────────────────────
  {
    id: "sales_page",
    label: "Sales Page",
    description: "Long-form pitch / order page",
    category: "Convert",
    emoji: "📃",
    icon: "landing",
    color: "#f97316",
    type: "landing",
    defaultName: "SALES_PAGE",
    stageType: "standard",
    defaultItems: [
      { id: "testimonials", label: "TESTIMONIALS", enabled: true },
      { id: "checkout", label: "CHECKOUT", enabled: true },
    ],
  },
  {
    id: "checkout",
    label: "Checkout",
    description: "Stripe / payment processor",
    category: "Convert",
    emoji: "💳",
    icon: "offer",
    color: "#f97316",
    type: "offer",
    defaultName: "CHECKOUT",
    stageType: "standard",
    tags: ["stripe", "payment", "cart"],
  },
  {
    id: "discovery_call",
    label: "Discovery Call",
    description: "30-min sales call qualifier",
    category: "Convert",
    emoji: "📞",
    icon: "landing",
    color: "#f97316",
    type: "landing",
    defaultName: "DISCOVERY_CALL",
    stageType: "qualified",
    tags: ["sales", "call"],
  },
  {
    id: "application_form",
    label: "Application Form",
    description: "Apply-to-work-with-me gate",
    category: "Convert",
    emoji: "📋",
    icon: "landing",
    color: "#f97316",
    type: "landing",
    defaultName: "APPLICATION",
    stageType: "qualified",
  },
  {
    id: "tripwire",
    label: "Tripwire Offer",
    description: "Low-ticket commitment offer",
    category: "Convert",
    emoji: "🎁",
    icon: "offer",
    color: "#f97316",
    type: "offer",
    defaultName: "TRIPWIRE",
    stageType: "standard",
  },

  // ── Destinations: where converted leads land ───────────────
  {
    id: "course_community",
    label: "Course Community",
    description: "Skool / Circle / Discord course hub",
    category: "Destination",
    emoji: "🏛️",
    icon: "users",
    color: "#10b981",
    type: "community",
    defaultName: "COURSE_COMMUNITY",
    stageType: "won",
    defaultItems: [
      { id: "courses", label: "COURSES", enabled: true },
      { id: "discord", label: "DISCORD_SYNC", enabled: true },
    ],
    tags: ["skool", "circle"],
  },
  {
    id: "membership_tier",
    label: "Membership",
    description: "Paid recurring membership",
    category: "Destination",
    emoji: "🌟",
    icon: "users",
    color: "#10b981",
    type: "community",
    defaultName: "MEMBERSHIP",
    stageType: "won",
    defaultItems: [{ id: "tiers", label: "MEMBERSHIP_TIERS", enabled: true }],
  },
  {
    id: "coaching_program",
    label: "Coaching Program",
    description: "1:1 or group coaching engagement",
    category: "Destination",
    emoji: "🧠",
    icon: "offer",
    color: "#a78bfa",
    type: "offer",
    defaultName: "COACHING_PROGRAM",
    stageType: "won",
    defaultItems: [{ id: "calls", label: "WEEKLY_CALLS", enabled: true }],
  },
  {
    id: "dfy_service",
    label: "Done-for-You Service",
    description: "High-touch service delivery",
    category: "Destination",
    emoji: "🛠️",
    icon: "offer",
    color: "#a78bfa",
    type: "offer",
    defaultName: "DFY_SERVICE",
    stageType: "won",
    tags: ["agency"],
  },
  {
    id: "affiliate_hub",
    label: "Affiliate Hub",
    description: "Partner-driven referral program",
    category: "Destination",
    emoji: "🔗",
    icon: "hub",
    color: "#818cf8",
    type: "hub",
    defaultName: "AFFILIATE_HUB",
    stageType: "standard",
    tags: ["partner", "referral"],
  },

  // ── Outcomes: terminal states ─────────────────────────────
  {
    id: "won",
    label: "Won",
    description: "Closed-won — paid customer",
    category: "Outcome",
    emoji: "✅",
    icon: "check",
    color: "#22c55e",
    type: "custom",
    defaultName: "WON",
    stageType: "won",
  },
  {
    id: "lost",
    label: "Lost",
    description: "Closed-lost — disqualified or churned",
    category: "Outcome",
    emoji: "❌",
    icon: "close",
    color: "#ef4444",
    type: "custom",
    defaultName: "LOST",
    stageType: "lost",
  },
  {
    id: "promoted_to_crm",
    label: "Promoted to CRM",
    description: "Mirrored to clients database",
    category: "Outcome",
    emoji: "📥",
    icon: "users",
    color: "#a855f7",
    type: "custom",
    defaultName: "PROMOTED_TO_CRM",
    stageType: "won",
  },
];

export const NODE_LIBRARY_BY_ID: Readonly<Record<string, NodeLibraryEntry>> =
  NODE_LIBRARY.reduce(
    (acc, entry) => {
      acc[entry.id] = entry;
      return acc;
    },
    {} as Record<string, NodeLibraryEntry>,
  );

export const NODE_LIBRARY_CATEGORIES: ReadonlyArray<{
  id: NodeLibraryCategory;
  emoji: string;
  label: string;
}> = [
  { id: "Source", emoji: "📡", label: "Sources" },
  { id: "Capture", emoji: "🪝", label: "Capture" },
  { id: "Qualify", emoji: "🎯", label: "Qualify" },
  { id: "Nurture", emoji: "🌱", label: "Nurture" },
  { id: "Convert", emoji: "💰", label: "Convert" },
  { id: "Destination", emoji: "🏛️", label: "Destinations" },
  { id: "Outcome", emoji: "🏁", label: "Outcomes" },
];

// Community Node Feature Config
const COMMUNITY_FEATURES: PlatformFeature[] = [
  { 
    id: 'courses', 
    name: 'ONLINE_COURSES', 
    icon: 'hub', 
    description: 'Course modules, lessons, and progress tracking',
    sections: [
      {
        title: 'COURSE SETTINGS',
        fields: [
          { id: 'max_courses', label: 'MAX_COURSES', type: 'number', placeholder: '10', hint: 'Maximum courses allowed' },
          { id: 'drip_content', label: 'DRIP_CONTENT', type: 'checkbox', hint: 'Release lessons over time' },
          { id: 'completion_certificates', label: 'CERTIFICATES', type: 'checkbox', hint: 'Auto-generate completion certificates' },
          { id: 'quizzes_enabled', label: 'QUIZZES', type: 'checkbox', hint: 'Enable quizzes and assessments' },
        ]
      },
      {
        title: 'PROGRESS TRACKING',
        fields: [
          { id: 'track_completion', label: 'TRACK_COMPLETION', type: 'checkbox', hint: 'Track lesson completion %' },
          { id: 'require_order', label: 'REQUIRE_ORDER', type: 'checkbox', hint: 'Force sequential lesson completion' },
        ]
      }
    ]
  },
  { 
    id: 'vault', 
    name: 'VAULT_FILES', 
    icon: 'hub', 
    description: 'File storage, resources, and downloads',
    sections: [
      {
        title: 'STORAGE',
        fields: [
          { id: 'storage_limit_gb', label: 'STORAGE_LIMIT_GB', type: 'number', placeholder: '10', hint: 'Max storage in GB' },
          { id: 'allow_uploads', label: 'MEMBER_UPLOADS', type: 'checkbox', hint: 'Allow members to upload files' },
          { id: 'tier_folders', label: 'TIER_FOLDERS', type: 'checkbox', hint: 'Organize files by membership tier' },
        ]
      }
    ]
  },
  { 
    id: 'membership_tiers', 
    name: 'MEMBERSHIP_TIERS', 
    icon: 'offer', 
    description: 'Define access levels with different permissions',
    sections: [
      {
        title: 'TIER SETTINGS',
        fields: [
          { id: 'default_tier', label: 'DEFAULT_TIER', type: 'select', options: [
            { value: 'free', label: 'Free' },
            { value: 'basic', label: 'Basic' },
            { value: 'premium', label: 'Premium' },
            { value: 'vip', label: 'VIP' },
          ], hint: 'Tier assigned to new members' },
          { id: 'custom_tiers', label: 'CUSTOM_TIERS', type: 'textarea', placeholder: 'silver\ngold\nplatinum', hint: 'One tier name per line' },
        ]
      },
      {
        title: 'TIER BENEFITS',
        fields: [
          { id: 'tier_courses', label: 'COURSE_ACCESS', type: 'checkbox', hint: 'Gate courses by tier' },
          { id: 'tier_vault', label: 'VAULT_ACCESS', type: 'checkbox', hint: 'Gate vault files by tier' },
          { id: 'tier_discord_roles', label: 'DISCORD_ROLES', type: 'checkbox', hint: 'Sync tier to Discord roles' },
        ]
      }
    ]
  },
  { 
    id: 'discord', 
    name: 'DISCORD_SYNC', 
    icon: 'discord', 
    description: 'Sync roles, members, and notifications',
    sections: [
      {
        title: 'DISCORD CONNECTION',
        fields: [
          { id: 'discord_server_id', label: 'SERVER_ID', type: 'text', placeholder: '123456789012345678', required: true },
          { id: 'discord_bot_token', label: 'BOT_TOKEN', type: 'password', placeholder: 'Bot token from Developer Portal', required: true },
        ]
      },
      {
        title: 'ROLE MAPPING',
        fields: [
          { id: 'sync_roles', label: 'SYNC_ROLES', type: 'checkbox', hint: 'Auto-sync membership tiers to Discord roles' },
          { id: 'welcome_channel', label: 'WELCOME_CHANNEL', type: 'text', placeholder: 'Channel ID for welcome messages' },
          { id: 'course_channels', label: 'COURSE_CHANNELS', type: 'checkbox', hint: 'Create channels per course' },
        ]
      },
      {
        title: 'NOTIFICATIONS',
        fields: [
          { id: 'notify_new_lesson', label: 'NEW_LESSON', type: 'checkbox', hint: 'Notify when new lesson published' },
          { id: 'notify_new_resource', label: 'NEW_RESOURCE', type: 'checkbox', hint: 'Notify when new vault resource' },
        ]
      }
    ]
  },
  { 
    id: 'onboarding', 
    name: 'ONBOARDING_FLOW', 
    icon: 'entry', 
    description: 'Automated welcome sequence for new members',
    sections: [
      {
        title: 'WELCOME SEQUENCE',
        fields: [
          { id: 'welcome_enabled', label: 'ENABLED', type: 'checkbox', hint: 'Enable automated onboarding' },
          { id: 'welcome_email', label: 'WELCOME_EMAIL', type: 'checkbox', hint: 'Send welcome email' },
          { id: 'welcome_dm', label: 'WELCOME_DM', type: 'checkbox', hint: 'Send Discord DM on join' },
        ]
      },
      {
        title: 'FIRST STEPS',
        fields: [
          { id: 'intro_video_url', label: 'INTRO_VIDEO', type: 'text', placeholder: 'https://youtube.com/watch?v=...', hint: 'Welcome video URL' },
          { id: 'first_course_id', label: 'FIRST_COURSE', type: 'text', placeholder: 'Course ID to start with', hint: 'Auto-enroll in starter course' },
          { id: 'checklist_enabled', label: 'CHECKLIST', type: 'checkbox', hint: 'Show getting started checklist' },
        ]
      }
    ]
  },
  { 
    id: 'events', 
    name: 'EVENTS_CALENDAR', 
    icon: 'qualification', 
    description: 'Live events, webinars, and Q&A sessions',
    sections: [
      {
        title: 'EVENT SETTINGS',
        fields: [
          { id: 'google_calendar_id', label: 'GCAL_ID', type: 'text', placeholder: 'Calendar ID for sync' },
          { id: 'zoom_api_key', label: 'ZOOM_API_KEY', type: 'password', placeholder: 'Zoom API key for auto-links' },
          { id: 'event_reminders', label: 'REMINDERS', type: 'checkbox', hint: 'Send event reminders' },
        ]
      },
      {
        title: 'EVENT TYPES',
        fields: [
          { id: 'live_calls', label: 'LIVE_CALLS', type: 'checkbox', hint: 'Enable live group calls' },
          { id: 'webinars', label: 'WEBINARS', type: 'checkbox', hint: 'Enable webinar broadcasts' },
          { id: 'qna_sessions', label: 'Q&A_SESSIONS', type: 'checkbox', hint: 'Enable Q&A sessions' },
        ]
      }
    ]
  },
  { 
    id: 'gamification', 
    name: 'GAMIFICATION', 
    icon: 'offer', 
    description: 'Points, badges, leaderboards, and streaks',
    sections: [
      {
        title: 'POINTS SYSTEM',
        fields: [
          { id: 'points_enabled', label: 'POINTS', type: 'checkbox', hint: 'Enable points system' },
          { id: 'points_per_lesson', label: 'PTS_PER_LESSON', type: 'number', placeholder: '10', hint: 'Points for lesson completion' },
          { id: 'points_per_course', label: 'PTS_PER_COURSE', type: 'number', placeholder: '100', hint: 'Bonus points for course completion' },
          { id: 'points_per_comment', label: 'PTS_PER_COMMENT', type: 'number', placeholder: '5', hint: 'Points for engagement' },
        ]
      },
      {
        title: 'ACHIEVEMENTS',
        fields: [
          { id: 'badges_enabled', label: 'BADGES', type: 'checkbox', hint: 'Award badges for milestones' },
          { id: 'streaks_enabled', label: 'STREAKS', type: 'checkbox', hint: 'Track daily login streaks' },
          { id: 'leaderboard', label: 'LEADERBOARD', type: 'checkbox', hint: 'Show community leaderboard' },
        ]
      }
    ]
  },
  { 
    id: 'discussions', 
    name: 'DISCUSSIONS', 
    icon: 'messaging', 
    description: 'Community forums and lesson comments',
    sections: [
      {
        title: 'FORUM SETTINGS',
        fields: [
          { id: 'forum_enabled', label: 'FORUM', type: 'checkbox', hint: 'Enable community forum' },
          { id: 'lesson_comments', label: 'LESSON_COMMENTS', type: 'checkbox', hint: 'Allow comments on lessons' },
          { id: 'require_approval', label: 'MODERATION', type: 'checkbox', hint: 'Require post approval' },
        ]
      },
      {
        title: 'CATEGORIES',
        fields: [
          { id: 'forum_categories', label: 'CATEGORIES', type: 'textarea', placeholder: 'General\nAnnouncements\nSupport\nWins & Victories', hint: 'One category per line' },
        ]
      }
    ]
  },
  { 
    id: 'landing_pages', 
    name: 'LANDING_PAGES', 
    icon: 'landing', 
    description: 'Build custom landing pages with drag-drop editor',
    sections: [
      {
        title: 'PAGE BUILDER',
        fields: [
          { id: 'custom_domain', label: 'CUSTOM_DOMAIN', type: 'text', placeholder: 'community.yourdomain.com' },
          { id: 'ssl_enabled', label: 'SSL_ENABLED', type: 'checkbox', hint: 'Enable HTTPS' },
          { id: 'landing_templates', label: 'TEMPLATES', type: 'select', options: [
            { value: 'minimal', label: 'Minimal' },
            { value: 'sales', label: 'Sales Page' },
            { value: 'webinar', label: 'Webinar Opt-in' },
            { value: 'course', label: 'Course Sales' },
          ]},
        ]
      }
    ]
  },
  { 
    id: 'email_sequences', 
    name: 'EMAIL_SEQUENCES', 
    icon: 'email', 
    description: 'Automated email campaigns and drip sequences',
    sections: [
      {
        title: 'EMAIL PROVIDER',
        fields: [
          { id: 'email_provider', label: 'PROVIDER', type: 'select', options: [
            { value: 'smtp', label: 'Custom SMTP' },
            { value: 'sendgrid', label: 'SendGrid' },
            { value: 'mailgun', label: 'Mailgun' },
            { value: 'ses', label: 'Amazon SES' },
          ]},
          { id: 'email_api_key', label: 'API_KEY', type: 'password', placeholder: 'Provider API key' },
          { id: 'from_email', label: 'FROM_EMAIL', type: 'text', placeholder: 'hello@community.com' },
          { id: 'from_name', label: 'FROM_NAME', type: 'text', placeholder: 'Your Community' },
        ]
      },
      {
        title: 'SEQUENCES',
        fields: [
          { id: 'welcome_sequence', label: 'WELCOME_SEQ', type: 'checkbox', hint: 'Auto-send welcome email series' },
          { id: 'course_reminders', label: 'COURSE_REMINDERS', type: 'checkbox', hint: 'Remind inactive learners' },
          { id: 'win_celebration', label: 'WIN_EMAILS', type: 'checkbox', hint: 'Celebrate course completions' },
        ]
      }
    ]
  },
  { 
    id: 'payments', 
    name: 'PAYMENTS_BILLING', 
    icon: 'offer', 
    description: 'Stripe integration for subscriptions and one-time purchases',
    sections: [
      {
        title: 'STRIPE CONNECTION',
        fields: [
          { id: 'stripe_publishable', label: 'PK_KEY', type: 'text', placeholder: 'pk_live_...', required: true },
          { id: 'stripe_secret', label: 'SK_KEY', type: 'password', placeholder: 'sk_live_...', required: true },
          { id: 'stripe_webhook_secret', label: 'AUTO-SYNC KEY', type: 'password', placeholder: 'whsec_...', hint: 'For automatic payment updates' },
        ]
      },
      {
        title: 'PRICING',
        fields: [
          { id: 'free_trial_days', label: 'FREE_TRIAL', type: 'number', placeholder: '7', hint: 'Days of free trial (0 = none)' },
          { id: 'currency', label: 'CURRENCY', type: 'select', options: [
            { value: 'usd', label: 'USD' },
            { value: 'eur', label: 'EUR' },
            { value: 'gbp', label: 'GBP' },
          ]},
        ]
      }
    ]
  },
  { 
    id: 'kpi_tracking', 
    name: 'KPI_TRACKING', 
    icon: 'qualification', 
    description: 'Embeddable analytics script for all pages',
    sections: [
      {
        title: 'TRACKING SCRIPT',
        fields: [
          { id: 'track_pageviews', label: 'TRACK_PAGEVIEWS', type: 'checkbox', hint: 'Track page views' },
          { id: 'track_conversions', label: 'TRACK_CONVERSIONS', type: 'checkbox', hint: 'Track conversion events' },
          { id: 'track_utm', label: 'TRACK_UTM', type: 'checkbox', hint: 'Capture UTM parameters' },
        ]
      },
      {
        title: 'ANALYTICS',
        fields: [
          { id: 'ga_id', label: 'GOOGLE_ANALYTICS', type: 'text', placeholder: 'G-XXXXXXXXXX' },
          { id: 'fb_pixel', label: 'FB_PIXEL', type: 'text', placeholder: '1234567890' },
        ]
      }
    ]
  },
  { 
    id: 'supabase', 
    name: 'SUPABASE_DB', 
    icon: 'hub', 
    description: 'Connect Supabase for data storage',
    sections: [
      {
        title: 'DATABASE CONNECTION',
        fields: [
          { id: 'supabase_url', label: 'PROJECT_URL', type: 'text', placeholder: 'https://xxx.supabase.co', required: true },
          { id: 'supabase_key', label: 'SERVICE_KEY', type: 'password', placeholder: 'eyJhbGciOiJIUzI1NiIs...', required: true },
        ]
      },
      {
        title: 'SCHEMA',
        fields: [
          { id: 'auto_migrate', label: 'AUTO_MIGRATE', type: 'checkbox', hint: 'Auto-run schema migrations' },
          { id: 'realtime', label: 'REALTIME', type: 'checkbox', hint: 'Enable realtime subscriptions' },
        ]
      }
    ]
  },
  { 
    id: 'automation', 
    name: 'AUTOMATION_RULES', 
    icon: 'custom', 
    description: 'Trigger actions based on member behavior',
    sections: [
      {
        title: 'TRIGGERS',
        fields: [
          { id: 'on_signup', label: 'ON_SIGNUP', type: 'checkbox', hint: 'Trigger on new member signup' },
          { id: 'on_course_complete', label: 'ON_COURSE_COMPLETE', type: 'checkbox', hint: 'Trigger when course completed' },
          { id: 'on_tier_change', label: 'ON_TIER_CHANGE', type: 'checkbox', hint: 'Trigger on membership tier change' },
          { id: 'on_payment', label: 'ON_PAYMENT', type: 'checkbox', hint: 'Trigger on successful payment' },
          { id: 'on_churn', label: 'ON_CHURN', type: 'checkbox', hint: 'Trigger on subscription cancellation' },
        ]
      },
      {
        title: 'ACTIONS',
        fields: [
          { id: 'action_email', label: 'SEND_EMAIL', type: 'checkbox', hint: 'Send automated emails' },
          { id: 'action_discord', label: 'DISCORD_MSG', type: 'checkbox', hint: 'Send Discord messages' },
          { id: 'action_webhook', label: 'EXTERNAL APPS', type: 'checkbox', hint: 'Send automatic updates to other apps' },
        ]
      }
    ]
  },
  { 
    id: 'ai_assistant', 
    name: 'AI_ASSISTANT', 
    icon: 'ai', 
    description: 'AI-powered support and content assistant',
    sections: [
      {
        title: 'AI SETTINGS',
        fields: [
          { id: 'ai_enabled', label: 'ENABLED', type: 'checkbox', hint: 'Enable AI assistant' },
          { id: 'ai_model', label: 'MODEL', type: 'select', options: [
            { value: 'gpt-4', label: 'GPT-4' },
            { value: 'claude', label: 'Claude' },
            { value: 'gemini', label: 'Gemini Pro' },
          ]},
          { id: 'openai_key', label: 'OPENAI_KEY', type: 'password', placeholder: 'sk-...' },
        ]
      },
      {
        title: 'CAPABILITIES',
        fields: [
          { id: 'ai_support', label: 'SUPPORT_BOT', type: 'checkbox', hint: 'Answer member questions' },
          { id: 'ai_content', label: 'CONTENT_GEN', type: 'checkbox', hint: 'Generate course content' },
          { id: 'ai_moderation', label: 'AUTO_MOD', type: 'checkbox', hint: 'Moderate discussions' },
        ]
      }
    ]
  },
];

const NODE_WIDTH = 260;
const NODE_MIN_HEIGHT = 80;
const ROW_GAP = 140;
const COL_GAP = 50;
const CANVAS_PADDING = 80;

// ══════════════════════════════════════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════════════════════════════════════

let _selectedNodeId: string | null = null;
let _showAddNodeModal = false;
let _addNodeType: FlowNodeType | null = null;
// Add-node modal UX state — search query + recently-used list. Persists
// in memory only; reset when the page reloads. Keyed by node type for
// quick repeat insertions.
let _addNodeSearch = "";
let _addNodeRecent: string[] = []; // NODE_LIBRARY ids, newest first
let _addNodeFocusIdx = 0;

// ── Hover analytics: per-funnel snapshot cache ───────────────────────
//
// When a flow map has been promoted (slice B) it carries a `funnelId`.
// Renderers hovering on a node pull the latest funnels.flow.snapshot
// for that funnel, cache it for 5s, and join on each node's stageId to
// surface real lead counts. While a fetch is in flight the renderer
// shows structural counts (in/out/items) so the card never looks blank.
interface FlowSnapshotStage {
  id: string;
  name?: string;
  leadCount?: number;
  qualified?: number;
  unqualified?: number;
  pending?: number;
}
interface FlowSnapshotOutcomes {
  won?: number;
  lost?: number;
  promotedToCrm?: number;
  totalLeads?: number;
}
interface FlowSnapshot {
  funnel: { id: string };
  stages: FlowSnapshotStage[];
  outcomes: FlowSnapshotOutcomes;
}
const _snapshotCache = new Map<string, { at: number; data: FlowSnapshot }>();
const _snapshotInflight = new Set<string>();
const SNAPSHOT_TTL_MS = 5_000;

async function ensureFlowSnapshot(
  funnelId: string,
  props: FunnelFlowMapProps,
): Promise<FlowSnapshot | null> {
  const cached = _snapshotCache.get(funnelId);
  if (cached && Date.now() - cached.at < SNAPSHOT_TTL_MS) return cached.data;
  if (_snapshotInflight.has(funnelId)) return cached?.data ?? null;
  if (!props.client) return null;
  _snapshotInflight.add(funnelId);
  try {
    const result = await props.client.request<FlowSnapshot>("funnels.flow.snapshot", {
      funnelId,
    });
    if (result?.funnel) {
      _snapshotCache.set(funnelId, { at: Date.now(), data: result });
      props.requestUpdate();
      return result;
    }
  } catch (err) {
    console.warn("[ffm] snapshot fetch failed:", err);
  } finally {
    _snapshotInflight.delete(funnelId);
  }
  return cached?.data ?? null;
}

function getFlowSnapshot(funnelId?: string): FlowSnapshot | null {
  if (!funnelId) return null;
  return _snapshotCache.get(funnelId)?.data ?? null;
}
let _showSetupWizard = false;
let _setupWizardNode: FlowNode | null = null;
let _setupWizardStep = 0;
let _connectingFromId: string | null = null;
let _viewPan = { x: 0, y: 0 };
let _viewZoom = 1;

// Drag/pan state
let _isSpacePressed = false;
let _isDragging = false;
let _dragStart = { x: 0, y: 0 };
let _panStart = { x: 0, y: 0 };

// Spawn dialog state
let _showSpawnDialog = false;
let _spawnContext: {
  nodeId: string;
  nodeName: string;
  directoryPath: string;
  taskType: "edit_page" | "create_page" | "optimize_page";
  userInstructions: string;
} | null = null;

// KPI snippet modal
let _showKpiSnippet = false;
let _kpiSnippetNode: FlowNode | null = null;

// Connection editor modal
let _showConnectionEditor = false;
let _editingConnection: FlowConnection | null = null;

// ══════════════════════════════════════════════════════════════════════════════
// PROPS
// ══════════════════════════════════════════════════════════════════════════════

export interface FunnelFlowMapProps {
  flowMap: FunnelFlowMap | null;
  loading: boolean;
  onSave: (flowMap: FunnelFlowMap) => void;
  onSpawnAI: (nodeId: string, capability: string) => void;
  requestUpdate: () => void;
  client?: GatewayBrowserClient;
}

// ══════════════════════════════════════════════════════════════════════════════
// LAYOUT ENGINE
// ══════════════════════════════════════════════════════════════════════════════

interface LayoutNode { id: string; x: number; y: number; width: number; height: number; }

function calculateLayout(nodes: FlowNode[]): Map<string, LayoutNode> {
  const layout = new Map<string, LayoutNode>();
  const rows = new Map<number, FlowNode[]>();
  
  nodes.forEach(node => {
    const row = node.row ?? 0;
    if (!rows.has(row)) rows.set(row, []);
    rows.get(row)!.push(node);
  });
  
  const sortedRows = Array.from(rows.entries()).sort((a, b) => a[0] - b[0]);
  let currentY = CANVAS_PADDING;
  
  sortedRows.forEach(([_, rowNodes]) => {
    rowNodes.sort((a, b) => (a.column ?? 0) - (b.column ?? 0));
    const totalWidth = rowNodes.reduce((sum, n) => sum + (n.width || NODE_WIDTH) + COL_GAP, -COL_GAP);
    let startX = CANVAS_PADDING + (900 - totalWidth) / 2;
    let maxHeight = NODE_MIN_HEIGHT;
    
    rowNodes.forEach(node => {
      const width = node.width || NODE_WIDTH;
      const height = estimateNodeHeight(node);
      maxHeight = Math.max(maxHeight, height);
      layout.set(node.id, { id: node.id, x: startX, y: currentY, width, height });
      startX += width + COL_GAP;
    });
    
    currentY += maxHeight + ROW_GAP;
  });
  
  return layout;
}

function estimateNodeHeight(node: FlowNode): number {
  let height = 56;
  if (node.items && node.items.length > 0) height += 8 + node.items.filter(i => i.enabled).length * 28;
  height += 44;
  return Math.max(NODE_MIN_HEIGHT, height);
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN RENDER
// ══════════════════════════════════════════════════════════════════════════════

export function renderFunnelFlowMap(props: FunnelFlowMapProps): TemplateResult {
  const { flowMap, loading, requestUpdate } = props;

  if (loading) {
    return html`<div class="ffm__loading"><div class="ffm__spinner"></div><span class="ffm__mono">LOADING...</span></div>`;
  }

  if (!flowMap || flowMap.nodes.length === 0) {
    return renderEmptyState(props);
  }

  const layout = calculateLayout(flowMap.nodes);

  // Setup keyboard listeners (spacebar for pan mode)
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.code === 'Space' && !_isSpacePressed) {
      e.preventDefault();
      _isSpacePressed = true;
      requestUpdate();
    }
  };
  
  const handleKeyUp = (e: KeyboardEvent) => {
    if (e.code === 'Space') {
      _isSpacePressed = false;
      _isDragging = false;
      requestUpdate();
    }
  };
  
  const handleMouseDown = (e: MouseEvent) => {
    if (_isSpacePressed) {
      e.preventDefault();
      _isDragging = true;
      _dragStart = { x: e.clientX, y: e.clientY };
      _panStart = { x: _viewPan.x, y: _viewPan.y };
    }
  };
  
  const handleMouseMove = (e: MouseEvent) => {
    if (_isDragging && _isSpacePressed) {
      const dx = e.clientX - _dragStart.x;
      const dy = e.clientY - _dragStart.y;
      _viewPan = { x: _panStart.x + dx, y: _panStart.y + dy };
      requestUpdate();
    }
  };
  
  const handleMouseUp = () => {
    _isDragging = false;
  };

  return html`
    <style>${flowMapStyles}</style>
    <div class="ffm ${_isSpacePressed ? 'ffm--pan-mode' : ''}" 
      tabindex="0"
      @wheel=${(e: WheelEvent) => handleZoom(e, requestUpdate)}
      @keydown=${handleKeyDown}
      @keyup=${handleKeyUp}
      @mousedown=${handleMouseDown}
      @mousemove=${handleMouseMove}
      @mouseup=${handleMouseUp}
      @mouseleave=${handleMouseUp}>
      <div class="ffm__canvas">
        <svg class="ffm__grid" width="100%" height="100%">
          <defs>
            <pattern id="ffm-grid-dots" width="24" height="24" patternUnits="userSpaceOnUse">
              <circle cx="1" cy="1" r="1" fill="rgba(255, 200, 0, 0.08)"/>
            </pattern>
            <pattern id="ffm-grid-lines" width="24" height="24" patternUnits="userSpaceOnUse">
              <path d="M 24 0 L 0 0 0 24" fill="none" stroke="rgba(255, 200, 0, 0.03)" stroke-width="1"/>
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#ffm-grid-lines)"/>
          <rect width="100%" height="100%" fill="url(#ffm-grid-dots)"/>
        </svg>

        <div class="ffm__content" style="transform: translate(${_viewPan.x}px, ${_viewPan.y}px) scale(${_viewZoom});">
          <!-- Connection lines rendered as individual divs for reliability -->
          ${flowMap.connections.map(conn => {
            const fromNode = layout.get(conn.from);
            const toNode = layout.get(conn.to);
            if (!fromNode || !toNode) return nothing;
            return renderConnectionLine(fromNode, toNode, conn, props);
          })}
          ${flowMap.nodes.map(node => {
            const pos = layout.get(node.id);
            return pos ? renderNode(node, pos, flowMap, props) : nothing;
          })}
        </div>
      </div>

      <!-- Toolbar -->
      <div class="ffm__toolbar">
        <button class="ffm__toolbar-btn ffm__toolbar-btn--primary" @click=${() => { _showAddNodeModal = true; requestUpdate(); }}>
          <span class="ffm__icon">${icons.plus}</span>
          <span>ADD_NODE</span>
        </button>
        <div class="ffm__toolbar-sep"></div>
        ${flowMap.funnelId
          ? html`
            <button class="ffm__toolbar-btn ffm__toolbar-btn--live" title="Live funnel — analytics streaming. Click to refresh.">
              <span class="ffm__live-dot"></span>
              <span>LIVE</span>
            </button>
          `
          : html`
            <button class="ffm__toolbar-btn ffm__toolbar-btn--go-live"
              title="Promote this flow map to a live funnel — materializes stages, starts lead tracking, unlocks real analytics."
              @click=${() => promoteFlowMap(flowMap, props)}>
              <span class="ffm__icon">${icons.sparkles ?? icons.plus}</span>
              <span>GO_LIVE</span>
            </button>
          `}
        <div class="ffm__toolbar-sep"></div>
        <button class="ffm__toolbar-btn" @click=${() => { _viewZoom = Math.min(1.5, _viewZoom + 0.1); requestUpdate(); }}>
          <span class="ffm__icon">${icons.plus}</span>
        </button>
        <span class="ffm__zoom">${Math.round(_viewZoom * 100)}%</span>
        <button class="ffm__toolbar-btn" @click=${() => { _viewZoom = Math.max(0.5, _viewZoom - 0.1); requestUpdate(); }}>
          <span class="ffm__icon">${icons.minus}</span>
        </button>
        <button class="ffm__toolbar-btn" @click=${() => { _viewZoom = 1; _viewPan = { x: 0, y: 0 }; requestUpdate(); }}>
          <span class="ffm__icon">${icons.reset}</span>
        </button>
      </div>

      <!-- Pan mode indicator -->
      ${_isSpacePressed ? html`
        <div class="ffm__pan-indicator">
          <span class="ffm__icon">${icons.move}</span>
          <span class="ffm__mono">PAN_MODE</span>
        </div>
      ` : nothing}

      ${_showAddNodeModal ? renderAddNodeModal(flowMap, props) : nothing}
      ${_showSetupWizard && _setupWizardNode ? renderSetupWizard(_setupWizardNode, flowMap, props) : nothing}
      ${_showSpawnDialog && _spawnContext ? renderSpawnDialog(props) : nothing}
      ${_showConnectionEditor && _editingConnection ? renderConnectionEditor(_editingConnection, flowMap, props) : nothing}
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// EMPTY STATE
// ══════════════════════════════════════════════════════════════════════════════

function renderEmptyState(props: FunnelFlowMapProps): TemplateResult {
  return html`
    <style>${flowMapStyles}</style>
    <div class="ffm ffm--empty">
      <div class="ffm__empty-box">
        <div class="ffm__empty-icon">${icons.flowmap}</div>
        <h2>Create Your Customer Journey</h2>
        <p>Map out how people discover you and become customers</p>
        
        <div class="ffm__templates">
          <div class="ffm__templates-header">${pIcons.target} Community & Membership</div>
          <button class="ffm__template" @click=${() => createTemplate('community-membership', props)}>
            <span class="ffm__template-icon">${icons.users}</span>
            <div class="ffm__template-info">
              <span class="ffm__template-name">Community Membership</span>
              <span class="ffm__template-desc">Social media → Landing page → Community → Upsell</span>
            </div>
            <span class="ffm__template-arrow">${icons.chevronRight}</span>
          </button>
          <button class="ffm__template" @click=${() => createTemplate('course-funnel', props)}>
            <span class="ffm__template-icon">${icons.hub}</span>
            <div class="ffm__template-info">
              <span class="ffm__template-name">Online Course</span>
              <span class="ffm__template-desc">Webinar → Email sequence → Course community</span>
            </div>
            <span class="ffm__template-arrow">${icons.chevronRight}</span>
          </button>
          <button class="ffm__template" @click=${() => createTemplate('coaching-business', props)}>
            <span class="ffm__template-icon">${icons.offer}</span>
            <div class="ffm__template-info">
              <span class="ffm__template-name">Coaching Business</span>
              <span class="ffm__template-desc">Multiple entry points → Qualify leads → Client portal</span>
            </div>
            <span class="ffm__template-arrow">${icons.chevronRight}</span>
          </button>
          
          <div class="ffm__templates-header" style="margin-top:16px;">${pIcons.smartphone} Social Media Funnels</div>
          <button class="ffm__template" @click=${() => createTemplate('social-to-offer', props)}>
            <span class="ffm__template-icon">${icons.social}</span>
            <div class="ffm__template-info">
              <span class="ffm__template-name">Social to Community</span>
              <span class="ffm__template-desc">Instagram/TikTok → Community → Offer</span>
            </div>
            <span class="ffm__template-arrow">${icons.chevronRight}</span>
          </button>
          <button class="ffm__template" @click=${() => createTemplate('lead-magnet', props)}>
            <span class="ffm__template-icon">${icons.qualification}</span>
            <div class="ffm__template-info">
              <span class="ffm__template-name">Lead Magnet</span>
              <span class="ffm__template-desc">Content → Capture emails → Nurture → Community</span>
            </div>
            <span class="ffm__template-arrow">${icons.chevronRight}</span>
          </button>
        </div>

        <div class="ffm__divider"><span>or start from scratch</span></div>

        <button class="ffm__start-btn" @click=${() => { _showAddNodeModal = true; props.requestUpdate(); }}>
          <span class="ffm__icon">${icons.plus}</span>
          <span>Build from scratch</span>
        </button>
        
        <div class="ffm__help-link">
          <a href="#" @click=${(e: Event) => { e.preventDefault(); alert('Help docs coming soon! For now, pick a template or start from scratch.'); }}>
            💡 Need help? Learn how funnels work
          </a>
        </div>
      </div>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// NODE RENDERING
// ══════════════════════════════════════════════════════════════════════════════

function renderNode(node: FlowNode, pos: LayoutNode, flowMap: FunnelFlowMap, props: FunnelFlowMapProps): TemplateResult {
  const isSelected = _selectedNodeId === node.id;
  const isConnecting = _connectingFromId !== null;
  const libraryEntry = node.libraryId ? NODE_LIBRARY_BY_ID[node.libraryId] : undefined;
  const color = node.color || libraryEntry?.color || NODE_COLORS[node.type];
  const config = NODE_TYPE_CONFIG[node.type];
  const platformConfig = node.platform ? PLATFORM_CONFIG[node.platform] : null;
  const iconKey = platformConfig?.icon || libraryEntry?.icon || config.icon;
  const icon = icons[iconKey as keyof typeof icons] || icons.custom;
  const kindLabel = libraryEntry?.label || platformConfig?.label || config.label;

  // Derived metrics — structural counts (in/out/items) always available.
  // Real lead throughput overlays when the parent flow map is bound to a
  // live funnel and we have a fresh funnels.flow.snapshot for it.
  const enabledItems = (node.items ?? []).filter((i) => i.enabled).length;
  const totalItems = (node.items ?? []).length;
  const incoming = flowMap.connections.filter((c) => c.to === node.id).length;
  const outgoing = flowMap.connections.filter((c) => c.from === node.id).length;
  const isConnected = !!node.integration?.connected;
  const snapshot = getFlowSnapshot(flowMap.funnelId);
  const stage = node.stageId && snapshot
    ? snapshot.stages.find((s) => s.id === node.stageId)
    : undefined;
  const liveLeadCount = stage?.leadCount;
  const isLiveBound = !!flowMap.funnelId;

  return html`
    <div class="ffm__node ${isSelected ? 'ffm__node--selected' : ''} ${isConnecting ? 'ffm__node--connectable' : ''} ${isConnected ? 'ffm__node--live' : ''}"
      style="left: ${pos.x}px; top: ${pos.y}px; width: ${pos.width}px; --node-color: ${color};"
      @click=${(e: Event) => { e.stopPropagation(); _selectedNodeId = node.id; props.requestUpdate(); }}
      @dblclick=${() => openSetupWizard(node, props)}
    >
      <!-- Live status pill in the top-right corner, animates when integration is connected -->
      <div class="ffm__node-live-badge ${isConnected ? 'live' : 'dim'}" title="${isConnected ? 'Integration connected — live data flowing' : 'Not connected — open Configure to wire it up'}">
        <span class="ffm__node-live-dot"></span>
        <span class="ffm__node-live-label">${isConnected ? 'LIVE' : 'OFFLINE'}</span>
      </div>

      <div class="ffm__node-header">
        <span class="ffm__node-icon">${icon}</span>
        <div class="ffm__node-title">
          <span class="ffm__node-name ffm__mono">${node.name.toUpperCase()}</span>
          <span class="ffm__node-type">${platformConfig?.label || config.label}</span>
        </div>
      </div>

      <!-- Quick-glance chips: connection count + item count. Sit between
           header and items so the user reads them inline without hovering. -->
      <div class="ffm__node-chips">
        <span class="ffm__node-chip" title="Incoming connections"><span class="ffm__node-chip-icon">↘</span>${incoming} in</span>
        <span class="ffm__node-chip" title="Outgoing connections"><span class="ffm__node-chip-icon">↗</span>${outgoing} out</span>
        ${totalItems > 0 ? html`
          <span class="ffm__node-chip ffm__node-chip--items" title="Active / total items">
            <span class="ffm__node-chip-icon">⬢</span>${enabledItems}/${totalItems}
          </span>
        ` : nothing}
      </div>

      ${node.items && enabledItems > 0 ? html`
        <div class="ffm__node-items">
          ${node.items.filter((i) => i.enabled).slice(0, 4).map((item) => html`
            <div class="ffm__node-item">
              <span class="ffm__node-item-dot">${icons.bullet}</span>
              <span class="ffm__mono">${item.label}</span>
            </div>
          `)}
          ${enabledItems > 4 ? html`
            <div class="ffm__node-item ffm__node-item--more">+${enabledItems - 4} more</div>
          ` : nothing}
        </div>
      ` : nothing}

      <!-- Hover-revealed analytics card. Pops out to the right of the
           node when there's room; mirrors to the left when there isn't.
           Pure CSS reveal so it never lags behind the cursor.
           When the parent flow map is bound to a live funnel, the top
           row surfaces real lead counts via funnels.flow.snapshot. -->
      <div class="ffm__node-analytics"
        aria-hidden="true"
        @mouseenter=${() => {
          if (flowMap.funnelId) void ensureFlowSnapshot(flowMap.funnelId, props);
        }}>
        <div class="ffm__node-analytics-header">
          <span class="ffm__node-analytics-title">${(node.name || config.label).toUpperCase()}</span>
          <span class="ffm__node-analytics-kind">${kindLabel}</span>
        </div>
        ${isLiveBound ? html`
          <div class="ffm__node-analytics-live">
            <span class="ffm__node-analytics-live-dot"></span>
            <span class="ffm__node-analytics-live-text">${liveLeadCount !== undefined ? `${liveLeadCount} leads in stage` : 'Live · loading…'}</span>
          </div>
          ${stage ? html`
            <div class="ffm__node-analytics-bar">
              <span class="ffm__node-analytics-bar-q" style="flex:${stage.qualified ?? 0}"></span>
              <span class="ffm__node-analytics-bar-u" style="flex:${stage.unqualified ?? 0}"></span>
              <span class="ffm__node-analytics-bar-p" style="flex:${stage.pending ?? 0}"></span>
            </div>
            <div class="ffm__node-analytics-legend">
              <span class="ffm__node-analytics-legend-item q">✓ ${stage.qualified ?? 0}</span>
              <span class="ffm__node-analytics-legend-item u">✗ ${stage.unqualified ?? 0}</span>
              <span class="ffm__node-analytics-legend-item p">⏳ ${stage.pending ?? 0}</span>
            </div>
          ` : nothing}
        ` : nothing}
        <div class="ffm__node-analytics-grid">
          <div class="ffm__node-analytics-cell">
            <span class="ffm__node-analytics-label">Status</span>
            <span class="ffm__node-analytics-value ${isConnected ? 'ok' : 'dim'}">${isConnected ? 'CONNECTED' : 'OFFLINE'}</span>
          </div>
          <div class="ffm__node-analytics-cell">
            <span class="ffm__node-analytics-label">Active items</span>
            <span class="ffm__node-analytics-value">${enabledItems}<span class="ffm__node-analytics-sub">/ ${totalItems}</span></span>
          </div>
          <div class="ffm__node-analytics-cell">
            <span class="ffm__node-analytics-label">Inbound</span>
            <span class="ffm__node-analytics-value">${incoming}</span>
          </div>
          <div class="ffm__node-analytics-cell">
            <span class="ffm__node-analytics-label">Outbound</span>
            <span class="ffm__node-analytics-value">${outgoing}</span>
          </div>
        </div>
        <div class="ffm__node-analytics-hint">${isLiveBound ? 'Live data updates every 5s · Double-click to configure' : 'Promote to a live funnel to see real lead counts · Double-click to configure'}</div>
      </div>

      <div class="ffm__node-actions">
        <button class="ffm__node-action" @click=${(e: Event) => { e.stopPropagation(); openSetupWizard(node, props); }} title="Configure">
          ${icons.settings}
        </button>
        <button class="ffm__node-action" @click=${(e: Event) => { e.stopPropagation(); startConnecting(node.id, props); }} title="Connect">
          ${icons.link}
        </button>
        <button class="ffm__node-action ffm__node-action--danger" @click=${(e: Event) => { e.stopPropagation(); deleteNode(node.id, flowMap, props); }} title="Delete">
          ${icons.trash}
        </button>
      </div>

      <div class="ffm__connector ffm__connector--top"
        @click=${(e: Event) => { e.stopPropagation(); handleConnectorClick(node.id, 'top', flowMap, props); }}></div>
      <div class="ffm__connector ffm__connector--bottom"
        @click=${(e: Event) => { e.stopPropagation(); handleConnectorClick(node.id, 'bottom', flowMap, props); }}></div>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// CONNECTIONS
// ══════════════════════════════════════════════════════════════════════════════

function renderConnectionLine(
  from: LayoutNode, 
  to: LayoutNode, 
  connection: FlowConnection,
  props: FunnelFlowMapProps
): TemplateResult {
  const connId = connection.id;
  const fromX = from.x + from.width / 2;
  const fromY = from.y + from.height;
  const toX = to.x + to.width / 2;
  const toY = to.y;

  // Calculate SVG path (relative to local coordinates)
  const controlOffset = Math.min(Math.abs(toY - fromY) * 0.4, 70);
  
  // Local path starting from 0,0
  const localFromX = 30;
  const localFromY = 10;
  const localToX = Math.abs(toX - fromX) + 30;
  const localToY = Math.abs(toY - fromY) + 10;
  
  // Adjust for direction
  const startX = fromX < toX ? localFromX : localToX;
  const startY = localFromY;
  const endX = fromX < toX ? localToX : localFromX;
  const endY = localToY;
  
  const localPath = `M ${startX} ${startY} C ${startX} ${startY + controlOffset}, ${endX} ${endY - controlOffset}, ${endX} ${endY}`;

  // Calculate bounding box
  const minX = Math.min(fromX, toX) - 30;
  const minY = fromY - 10;
  const svgWidth = Math.abs(toX - fromX) + 60;
  const svgHeight = Math.abs(toY - fromY) + 20;

  // Midpoint for label
  const labelX = svgWidth / 2;
  const labelY = svgHeight / 2;

  // Conversion rate display
  const hasConversionRate = connection.conversionRate != null;
  const conversionRateText = hasConversionRate ? `${connection.conversionRate}%` : '';
  const rateColor = hasConversionRate 
    ? (connection.conversionRate! >= 50 ? '#34d399' : connection.conversionRate! >= 20 ? '#ffc800' : '#ff6464')
    : '#ffc800';

  // Condition indicator
  const hasConditions = connection.conditionType === 'rule' || 
    (connection.conditionConfig?.conditions && connection.conditionConfig.conditions.length > 0);

  const handleClick = (e: Event) => {
    e.stopPropagation();
    _editingConnection = connection;
    _showConnectionEditor = true;
    props.requestUpdate();
  };

  return html`
    <svg class="ffm__conn-svg ffm__conn-svg--clickable" 
      style="position:absolute; left:${minX}px; top:${minY}px; width:${svgWidth}px; height:${svgHeight}px; overflow:visible; z-index:5; cursor:pointer;"
      @click=${handleClick}>
      <defs>
        <linearGradient id="grad-${connId}" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stop-color="${rateColor}" stop-opacity="1"/>
          <stop offset="100%" stop-color="${rateColor}" stop-opacity="0.4"/>
        </linearGradient>
        <filter id="glow-${connId}" x="-100%" y="-100%" width="300%" height="300%">
          <feGaussianBlur stdDeviation="4" result="blur"/>
          <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>
      
      <!-- Invisible wider hit area for easier clicking -->
      <path d="${localPath}" fill="none" stroke="transparent" stroke-width="20" stroke-linecap="round" style="pointer-events:stroke;"/>
      
      <!-- Glow background -->
      <path d="${localPath}" fill="none" stroke="rgba(255,200,0,0.15)" stroke-width="12" stroke-linecap="round" style="pointer-events:none;"/>
      
      <!-- Main line with gradient -->
      <path d="${localPath}" fill="none" stroke="url(#grad-${connId})" stroke-width="3" stroke-linecap="round" style="pointer-events:none;"/>
      
      <!-- Animated flowing dots -->
      <circle r="5" fill="${rateColor}" filter="url(#glow-${connId})" style="pointer-events:none;">
        <animateMotion dur="2s" repeatCount="indefinite" path="${localPath}"/>
      </circle>
      <circle r="5" fill="${rateColor}" filter="url(#glow-${connId})" opacity="0.7" style="pointer-events:none;">
        <animateMotion dur="2s" repeatCount="indefinite" path="${localPath}" begin="0.5s"/>
      </circle>
      <circle r="5" fill="${rateColor}" filter="url(#glow-${connId})" opacity="0.4" style="pointer-events:none;">
        <animateMotion dur="2s" repeatCount="indefinite" path="${localPath}" begin="1s"/>
      </circle>

      <!-- Conversion rate label -->
      ${hasConversionRate ? html`
        <g transform="translate(${labelX}, ${labelY})" style="pointer-events:none;">
          <rect x="-24" y="-12" width="48" height="24" rx="6" fill="#111" stroke="${rateColor}" stroke-width="1"/>
          <text x="0" y="5" text-anchor="middle" fill="${rateColor}" font-family="JetBrains Mono, monospace" font-size="11" font-weight="bold">
            ${conversionRateText}
          </text>
        </g>
      ` : nothing}

      <!-- Condition indicator -->
      ${hasConditions ? html`
        <g transform="translate(${labelX + (hasConversionRate ? 35 : 0)}, ${labelY})" style="pointer-events:none;">
          <circle r="10" fill="#1a1a1a" stroke="#60a5fa" stroke-width="1"/>
          <text x="0" y="4" text-anchor="middle" fill="#60a5fa" font-family="JetBrains Mono, monospace" font-size="10">⚡</text>
        </g>
      ` : nothing}

      <!-- Label -->
      ${connection.label ? html`
        <g transform="translate(${labelX}, ${labelY + (hasConversionRate ? 22 : 0)})" style="pointer-events:none;">
          <text x="0" y="5" text-anchor="middle" fill="rgba(255,255,255,0.5)" font-family="JetBrains Mono, monospace" font-size="9">
            ${connection.label}
          </text>
        </g>
      ` : nothing}
    </svg>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// CONNECTION EDITOR MODAL
// ══════════════════════════════════════════════════════════════════════════════

const CONDITION_OPERATORS = [
  { value: 'equals', label: 'equals' },
  { value: 'not_equals', label: 'does not equal' },
  { value: 'contains', label: 'contains' },
  { value: 'greater_than', label: 'is greater than' },
  { value: 'less_than', label: 'is less than' },
  { value: 'is_set', label: 'is set' },
  { value: 'is_not_set', label: 'is not set' },
];

const CONDITION_FIELDS = [
  { value: 'lead.score', label: 'Lead Score' },
  { value: 'lead.source', label: 'Lead Source' },
  { value: 'lead.status', label: 'Lead Status' },
  { value: 'lead.priority', label: 'Priority' },
  { value: 'lead.tags', label: 'Tags' },
  { value: 'lead.company', label: 'Company' },
  { value: 'lead.estimatedValue', label: 'Deal Value' },
];

function renderConnectionEditor(connection: FlowConnection, flowMap: FunnelFlowMap, props: FunnelFlowMapProps): TemplateResult {
  const closeEditor = () => { 
    _showConnectionEditor = false; 
    _editingConnection = null; 
    props.requestUpdate(); 
  };

  const fromNode = flowMap.nodes.find(n => n.id === connection.from);
  const toNode = flowMap.nodes.find(n => n.id === connection.to);

  // Initialize conditionConfig if not present
  if (!connection.conditionConfig) {
    connection.conditionConfig = { conditions: [] };
  }
  const conditions = connection.conditionConfig.conditions || [];

  const saveConnection = () => {
    // Connection is already mutated, just save the flow map
    props.onSave(flowMap);
    closeEditor();
  };

  const deleteConnection = () => {
    if (confirm('Delete this connection?')) {
      flowMap.connections = flowMap.connections.filter(c => c.id !== connection.id);
      props.onSave(flowMap);
      closeEditor();
    }
  };

  const addCondition = () => {
    if (!connection.conditionConfig) connection.conditionConfig = { conditions: [] };
    if (!connection.conditionConfig.conditions) connection.conditionConfig.conditions = [];
    connection.conditionConfig.conditions.push({ field: 'lead.score', operator: 'greater_than', value: '' });
    props.requestUpdate();
  };

  const removeCondition = (index: number) => {
    connection.conditionConfig!.conditions!.splice(index, 1);
    props.requestUpdate();
  };

  return html`
    <div class="ffm__overlay" @click=${closeEditor}>
      <div class="ffm__conn-editor" @click=${(e: Event) => e.stopPropagation()}>
        <div class="ffm__conn-editor-header">
          <div class="ffm__conn-editor-title">
            <span class="ffm__icon">${icons.link}</span>
            <h3 class="ffm__mono">CONNECTION_SETTINGS</h3>
          </div>
          <button class="ffm__modal-close" @click=${closeEditor}>${icons.close}</button>
        </div>

        <div class="ffm__conn-editor-flow">
          <div class="ffm__conn-node-badge">
            <span class="ffm__mono">${fromNode?.name || 'Unknown'}</span>
          </div>
          <span class="ffm__conn-arrow">${icons.chevronRight}</span>
          <div class="ffm__conn-node-badge">
            <span class="ffm__mono">${toNode?.name || 'Unknown'}</span>
          </div>
        </div>

        <div class="ffm__conn-editor-body">
          <!-- Label -->
          <div class="ffm__field">
            <label class="ffm__mono">LABEL</label>
            <input type="text" class="ffm__input" 
              placeholder="e.g., Qualified, Interested, Ready to Buy"
              .value=${connection.label || ''}
              @input=${(e: Event) => { connection.label = (e.target as HTMLInputElement).value; props.requestUpdate(); }}
            />
          </div>

          <!-- Conversion Rate -->
          <div class="ffm__field">
            <label class="ffm__mono">CONVERSION_RATE (%)</label>
            <div class="ffm__conv-rate-row">
              <input type="number" class="ffm__input ffm__input--number" 
                min="0" max="100"
                placeholder="e.g., 25"
                .value=${String(connection.conversionRate ?? '')}
                @input=${(e: Event) => { 
                  const val = (e.target as HTMLInputElement).value;
                  connection.conversionRate = val ? Number(val) : undefined; 
                  props.requestUpdate(); 
                }}
              />
              <span class="ffm__conv-rate-hint">
                ${connection.transitionCount ? `${connection.transitionCount} leads transitioned` : 'No data yet'}
              </span>
            </div>
          </div>

          <!-- Condition Type -->
          <div class="ffm__field">
            <label class="ffm__mono">CONDITION_TYPE</label>
            <div class="ffm__cond-type-grid">
              <button class="ffm__cond-type-btn ${connection.conditionType === 'manual' || !connection.conditionType ? 'selected' : ''}"
                @click=${() => { connection.conditionType = 'manual'; props.requestUpdate(); }}>
                <span>📋</span>
                <span class="ffm__mono">MANUAL</span>
                <small>User moves leads</small>
              </button>
              <button class="ffm__cond-type-btn ${connection.conditionType === 'auto' ? 'selected' : ''}"
                @click=${() => { connection.conditionType = 'auto'; props.requestUpdate(); }}>
                <span>${pIcons.zap}</span>
                <span class="ffm__mono">AUTO</span>
                <small>Rule-based transition</small>
              </button>
              <button class="ffm__cond-type-btn ${connection.conditionType === 'rule' ? 'selected' : ''}"
                @click=${() => { connection.conditionType = 'rule'; props.requestUpdate(); }}>
                <span>${pIcons.wrench}</span>
                <span class="ffm__mono">RULE</span>
                <small>Link to automation</small>
              </button>
            </div>
          </div>

          <!-- Conditions (for auto type) -->
          ${connection.conditionType === 'auto' ? html`
            <div class="ffm__conditions-section">
              <div class="ffm__conditions-header">
                <label class="ffm__mono">CONDITIONS</label>
                <span class="ffm__conditions-hint">All conditions must match</span>
              </div>
              
              <div class="ffm__conditions-list">
                ${conditions.map((cond, index) => html`
                  <div class="ffm__condition-row">
                    <select class="ffm__select" .value=${cond.field}
                      @change=${(e: Event) => { cond.field = (e.target as HTMLSelectElement).value; props.requestUpdate(); }}>
                      ${CONDITION_FIELDS.map(f => html`<option value=${f.value} ?selected=${f.value === cond.field}>${f.label}</option>`)}
                    </select>
                    <select class="ffm__select" .value=${cond.operator}
                      @change=${(e: Event) => { cond.operator = (e.target as HTMLSelectElement).value; props.requestUpdate(); }}>
                      ${CONDITION_OPERATORS.map(o => html`<option value=${o.value} ?selected=${o.value === cond.operator}>${o.label}</option>`)}
                    </select>
                    ${!['is_set', 'is_not_set'].includes(cond.operator) ? html`
                      <input type="text" class="ffm__input ffm__input--small" 
                        .value=${String(cond.value || '')}
                        placeholder="value"
                        @input=${(e: Event) => { cond.value = (e.target as HTMLInputElement).value; props.requestUpdate(); }}
                      />
                    ` : nothing}
                    <button class="ffm__remove-btn" @click=${() => removeCondition(index)}>
                      ${icons.trash}
                    </button>
                  </div>
                `)}
                
                <button class="ffm__add-btn" @click=${addCondition}>
                  ${icons.plus} <span class="ffm__mono">ADD_CONDITION</span>
                </button>
              </div>
            </div>
          ` : nothing}

          <!-- Rule Link (for rule type) -->
          ${connection.conditionType === 'rule' ? html`
            <div class="ffm__field">
              <label class="ffm__mono">LINKED_RULE</label>
              <div class="ffm__rule-link">
                ${connection.conditionConfig?.ruleName ? html`
                  <div class="ffm__rule-badge">
                    <span>${pIcons.zap}</span>
                    <span>${connection.conditionConfig.ruleName}</span>
                  </div>
                ` : html`
                  <p class="ffm__rule-hint">Go to Automation tab to create rules that trigger this transition.</p>
                `}
              </div>
            </div>
          ` : nothing}
        </div>

        <div class="ffm__conn-editor-footer">
          <button class="ffm__btn ffm__btn--danger" @click=${deleteConnection}>
            ${icons.trash} <span class="ffm__mono">DELETE</span>
          </button>
          <button class="ffm__btn ffm__btn--primary" @click=${saveConnection}>
            ${icons.check} <span class="ffm__mono">SAVE_CHANGES</span>
          </button>
        </div>
      </div>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// ADD NODE MODAL
// ══════════════════════════════════════════════════════════════════════════════

function renderAddNodeModal(flowMap: FunnelFlowMap, props: FunnelFlowMapProps): TemplateResult {
  const closeModal = () => {
    _showAddNodeModal = false;
    _addNodeType = null;
    _addNodeSearch = "";
    _addNodeFocusIdx = 0;
    props.requestUpdate();
  };

  const pick = (entry: NodeLibraryEntry) => {
    addNodeFromLibrary(entry, flowMap, props);
  };

  // Fuzzy match against label, description, type id, and tags. So "ig"
  // → Instagram, "meta" → Instagram + Facebook + Paid Ad, "score" →
  // Lead Scorer, etc.
  const q = _addNodeSearch.trim().toLowerCase();
  const matchesSearch = (entry: NodeLibraryEntry): boolean => {
    if (!q) return true;
    if (entry.label.toLowerCase().includes(q)) return true;
    if (entry.description.toLowerCase().includes(q)) return true;
    if (entry.id.toLowerCase().includes(q)) return true;
    if (entry.tags?.some((t) => t.toLowerCase().includes(q))) return true;
    return false;
  };

  // Build the flat list keyboard navigation walks: recents first (no
  // dupes), then category order. Skip the recents lookup when there's
  // a search query so the keyboard always lands on the visible matches.
  const recentEntries = q
    ? []
    : _addNodeRecent
        .map((id) => NODE_LIBRARY_BY_ID[id])
        .filter((e): e is NodeLibraryEntry => !!e);
  const flatBody: NodeLibraryEntry[] = [];
  for (const cat of NODE_LIBRARY_CATEGORIES) {
    for (const entry of NODE_LIBRARY) {
      if (entry.category !== cat.id) continue;
      if (!matchesSearch(entry)) continue;
      flatBody.push(entry);
    }
  }
  const flat: NodeLibraryEntry[] = [...recentEntries, ...flatBody];
  if (flat.length > 0 && _addNodeFocusIdx >= flat.length) _addNodeFocusIdx = 0;

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeModal();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      _addNodeFocusIdx = (_addNodeFocusIdx + 1) % Math.max(1, flat.length);
      props.requestUpdate();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      _addNodeFocusIdx = (_addNodeFocusIdx - 1 + flat.length) % Math.max(1, flat.length);
      props.requestUpdate();
    } else if (e.key === "Enter") {
      const sel = flat[_addNodeFocusIdx];
      if (sel) {
        e.preventDefault();
        pick(sel);
      }
    }
  };

  // Focus search on mount.
  requestAnimationFrame(() => {
    const input = document.querySelector(".ffm__add-search-input") as HTMLInputElement | null;
    if (input && document.activeElement !== input) input.focus();
  });

  const focusedId = flat[_addNodeFocusIdx]?.id;

  return html`
    <div class="ffm__overlay" @click=${closeModal} @keydown=${onKey}>
      <div class="ffm__modal ffm__modal--addnode" @click=${(e: Event) => e.stopPropagation()}>
        <div class="ffm__modal-header">
          <div class="ffm__add-title-block">
            <h3>Add a Step</h3>
            <p class="ffm__modal-hint">${NODE_LIBRARY.length} production blocks — search or browse by category</p>
          </div>
          <button class="ffm__modal-close" @click=${closeModal} title="Close (Esc)">${icons.close}</button>
        </div>

        <!-- Search bar -->
        <div class="ffm__add-search">
          <span class="ffm__add-search-icon">${pIcons.search}</span>
          <input
            class="ffm__add-search-input"
            type="text"
            placeholder="Search — try 'instagram', 'email', 'sales', 'coaching', 'score'…"
            .value=${_addNodeSearch}
            @input=${(e: Event) => {
              _addNodeSearch = (e.target as HTMLInputElement).value;
              _addNodeFocusIdx = 0;
              props.requestUpdate();
            }}
            @keydown=${onKey}
          />
          ${_addNodeSearch ? html`
            <button class="ffm__add-search-clear" @click=${() => { _addNodeSearch = ""; _addNodeFocusIdx = 0; props.requestUpdate(); }} title="Clear">×</button>
          ` : nothing}
        </div>

        <div class="ffm__modal-body ffm__add-body">
          ${recentEntries.length > 0 ? html`
            <div class="ffm__add-section">
              <div class="ffm__add-section-header">
                <span class="ffm__add-section-emoji">${pIcons.clock}</span>
                <span class="ffm__add-section-label">Recently used</span>
                <span class="ffm__add-section-count">${recentEntries.length}</span>
              </div>
              <div class="ffm__add-grid ffm__add-grid--recents">
                ${recentEntries.map((entry) => html`
                  <button class="ffm__add-card ffm__add-card--compact ${focusedId === entry.id ? "focused" : ""}"
                    style="--node-color: ${entry.color};"
                    @click=${() => pick(entry)}
                    @mouseenter=${() => { _addNodeFocusIdx = flat.findIndex((e) => e.id === entry.id); props.requestUpdate(); }}>
                    <span class="ffm__add-card-emoji">${entry.emoji}</span>
                    <span class="ffm__add-card-label">${entry.label}</span>
                  </button>
                `)}
              </div>
            </div>
          ` : nothing}

          ${flatBody.length === 0 ? html`
            <div class="ffm__add-empty">
              <span class="ffm__add-empty-emoji">🕳️</span>
              <span>No blocks match "<strong>${_addNodeSearch}</strong>"</span>
              <button class="ffm__add-empty-clear" @click=${() => { _addNodeSearch = ""; props.requestUpdate(); }}>Clear search</button>
            </div>
          ` : nothing}

          ${NODE_LIBRARY_CATEGORIES.map((cat) => {
            const entries = NODE_LIBRARY.filter((e) => e.category === cat.id && matchesSearch(e));
            if (entries.length === 0) return nothing;
            return html`
              <div class="ffm__add-section">
                <div class="ffm__add-section-header">
                  <span class="ffm__add-section-emoji">${cat.emoji}</span>
                  <span class="ffm__add-section-label">${cat.label}</span>
                  <span class="ffm__add-section-count">${entries.length}</span>
                </div>
                <div class="ffm__add-grid">
                  ${entries.map((entry) => html`
                    <button class="ffm__add-card ${focusedId === entry.id ? "focused" : ""}"
                      style="--node-color: ${entry.color};"
                      @click=${() => pick(entry)}
                      @mouseenter=${() => { _addNodeFocusIdx = flat.findIndex((e) => e.id === entry.id); props.requestUpdate(); }}>
                      <span class="ffm__add-card-emoji">${entry.emoji}</span>
                      <div class="ffm__add-card-body">
                        <span class="ffm__add-card-label">${entry.label}</span>
                        <span class="ffm__add-card-desc">${entry.description}</span>
                      </div>
                    </button>
                  `)}
                </div>
              </div>
            `;
          })}
        </div>

        <div class="ffm__add-footer">
          <span class="ffm__add-kbd-hint">
            <kbd>↑</kbd><kbd>↓</kbd> navigate · <kbd>Enter</kbd> add · <kbd>Esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// NODE CONFIG PANEL (Single Page - No Wizard Steps)
// ══════════════════════════════════════════════════════════════════════════════

let _configTab: 'basic' | 'features' | 'api' | 'integrations' | 'page' | 'kpi' = 'basic';
let _integrationsInitialized = false;

function renderSetupWizard(node: FlowNode, flowMap: FunnelFlowMap, props: FunnelFlowMapProps): TemplateResult {
  const closeConfig = () => { _showSetupWizard = false; _setupWizardNode = null; _configTab = 'basic'; props.requestUpdate(); };
  const config = NODE_TYPE_CONFIG[node.type];
  const platformConfig = node.platform ? PLATFORM_CONFIG[node.platform] : null;
  const iconKey = platformConfig?.icon || config.icon;

  // Initialize integration if not present
  if (!node.integration) node.integration = { type: 'manual', connected: false };
  if (!node.items) node.items = getDefaultItems(node.type, node.platform);
  
  // Initialize integrations panel when tab is shown
  if (_configTab === 'integrations' && props.client && !_integrationsInitialized) {
    _integrationsInitialized = true;
    setIntegrationsRequestUpdate(props.requestUpdate);
    initIntegrationsPanel(props.client, flowMap.businessId || 'default');
  }

  return html`
    <div class="ffm__overlay" @click=${closeConfig}>
      <div class="ffm__config-panel" @click=${(e: Event) => e.stopPropagation()}>
        <!-- Header -->
        <div class="ffm__config-header">
          <span class="ffm__config-icon">${icons[iconKey as keyof typeof icons]}</span>
          <div class="ffm__config-title">
            <input type="text" class="ffm__config-name" .value=${node.name}
              @input=${(e: Event) => { node.name = (e.target as HTMLInputElement).value; props.requestUpdate(); }}/>
            <span class="ffm__config-type">${platformConfig?.label || config.label}</span>
          </div>
          <div class="ffm__config-status ${node.integration?.connected ? 'connected' : ''}">
            ${node.integration?.connected ? html`${icons.connected} <span>CONNECTED</span>` : html`${icons.disconnected} <span>NOT_CONNECTED</span>`}
          </div>
          <button class="ffm__modal-close" @click=${closeConfig}>${icons.close}</button>
        </div>

        <!-- Tabs -->
        <div class="ffm__config-tabs">
          <button class="ffm__config-tab ${_configTab === 'basic' ? 'active' : ''}" @click=${() => { _configTab = 'basic'; props.requestUpdate(); }}>
            ${icons.settings} <span class="ffm__mono">BASIC</span>
          </button>
          ${['landing', 'offer', 'hub', 'community'].includes(node.type) ? html`
            <button class="ffm__config-tab ${_configTab === 'page' ? 'active' : ''}" @click=${() => { _configTab = 'page'; props.requestUpdate(); }}>
              ${icons.folder} <span class="ffm__mono">PAGE</span>
            </button>
          ` : nothing}
          <button class="ffm__config-tab ${_configTab === 'features' ? 'active' : ''}" @click=${() => { _configTab = 'features'; props.requestUpdate(); }}>
            ${icons.bullet} <span class="ffm__mono">FEATURES</span>
          </button>
          ${['landing', 'offer', 'hub', 'community'].includes(node.type) ? html`
            <button class="ffm__config-tab ${_configTab === 'kpi' ? 'active' : ''}" @click=${() => { _configTab = 'kpi'; props.requestUpdate(); }}>
              ${icons.chart} <span class="ffm__mono">KPI</span>
            </button>
          ` : nothing}
          <button class="ffm__config-tab ${_configTab === 'api' ? 'active' : ''}" @click=${() => { _configTab = 'api'; props.requestUpdate(); }}>
            ${icons.api} <span class="ffm__mono">API_CONFIG</span>
          </button>
          ${node.platform === 'instagram' || node.type === 'messaging' ? html`
            <button class="ffm__config-tab ${_configTab === 'integrations' ? 'active' : ''}" 
              @click=${() => { _configTab = 'integrations'; props.requestUpdate(); }}>
              ${icons.link} <span class="ffm__mono">MANYCHAT</span>
            </button>
          ` : nothing}
        </div>

        <!-- Content -->
        <div class="ffm__config-body">
          ${_configTab === 'basic' ? renderBasicConfig(node, props) : nothing}
          ${_configTab === 'page' ? renderPageConfig(node, flowMap, props) : nothing}
          ${_configTab === 'features' ? renderFeaturesConfig(node, props) : nothing}
          ${_configTab === 'kpi' ? renderKpiConfig(node, flowMap, props) : nothing}
          ${_configTab === 'api' ? renderApiConfig(node, props) : nothing}
          ${_configTab === 'integrations' ? renderIntegrationsPanel(flowMap.businessId || 'default') : nothing}
        </div>

        <!-- Footer -->
        <div class="ffm__config-footer">
          <button class="ffm__btn ffm__btn--danger" @click=${() => { deleteNode(node.id, flowMap, props); closeConfig(); }}>
            ${icons.trash} <span class="ffm__mono">DELETE</span>
          </button>
          <button class="ffm__btn ffm__btn--primary" @click=${() => saveNodeConfig(node, flowMap, props)}>
            ${icons.check} <span class="ffm__mono">SAVE_CHANGES</span>
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderBasicConfig(node: FlowNode, props: FunnelFlowMapProps): TemplateResult {
  return html`
    <div class="ffm__config-section">
      <div class="ffm__field">
        <label class="ffm__mono">DESCRIPTION</label>
        <textarea class="ffm__textarea" .value=${node.description || ''} rows="2" placeholder="What is this node for?"
          @input=${(e: Event) => { node.description = (e.target as HTMLTextAreaElement).value; props.requestUpdate(); }}></textarea>
      </div>
      
      <div class="ffm__field-row">
        <div class="ffm__field">
          <label class="ffm__mono">ROW_POSITION</label>
          <input type="number" class="ffm__input" .value=${String(node.row ?? 0)} min="0"
            @input=${(e: Event) => { node.row = parseInt((e.target as HTMLInputElement).value) || 0; props.requestUpdate(); }}/>
        </div>
        <div class="ffm__field">
          <label class="ffm__mono">COLUMN</label>
          <input type="number" class="ffm__input" .value=${String(node.column ?? 0)} min="0"
            @input=${(e: Event) => { node.column = parseInt((e.target as HTMLInputElement).value) || 0; props.requestUpdate(); }}/>
        </div>
      </div>
      <p class="ffm__hint">// ROW 0 = TOP OF CANVAS. COLUMN 0 = LEFT.</p>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// PAGE LINK CONFIG
// ══════════════════════════════════════════════════════════════════════════════

function renderPageConfig(node: FlowNode, flowMap: FunnelFlowMap, props: FunnelFlowMapProps): TemplateResult {
  // Initialize pageLink if not present
  if (!node.pageLink) {
    node.pageLink = { type: 'none' };
  }
  const pageLink = node.pageLink;
  
  const openSpawnDialog = (taskType: "edit_page" | "create_page" | "optimize_page") => {
    _spawnContext = {
      nodeId: node.id,
      nodeName: node.name,
      directoryPath: pageLink.directoryPath || '',
      taskType,
      userInstructions: '',
    };
    _showSpawnDialog = true;
    props.requestUpdate();
  };

  return html`
    <div class="ffm__config-section">
      <div class="ffm__section-title">${pIcons.fileText} PAGE_LINK</div>
      <p class="ffm__section-desc">Link this node to a page - either a local directory or external URL</p>
      
      <!-- Link Type Selection -->
      <div class="ffm__field">
        <label class="ffm__mono">LINK_TYPE</label>
        <div class="ffm__link-type-grid">
          <button class="ffm__link-type-btn ${pageLink.type === 'directory' ? 'selected' : ''}"
            @click=${() => { pageLink.type = 'directory'; props.requestUpdate(); }}>
            ${icons.folder}
            <span>DIRECTORY</span>
            <small>Local site folder</small>
          </button>
          <button class="ffm__link-type-btn ${pageLink.type === 'external' ? 'selected' : ''}"
            @click=${() => { pageLink.type = 'external'; props.requestUpdate(); }}>
            ${icons.externalLink}
            <span>EXTERNAL</span>
            <small>Link to URL</small>
          </button>
          <button class="ffm__link-type-btn ${pageLink.type === 'none' ? 'selected' : ''}"
            @click=${() => { pageLink.type = 'none'; props.requestUpdate(); }}>
            ${icons.close}
            <span>NOT_SET</span>
            <small>No page linked</small>
          </button>
        </div>
      </div>

      ${pageLink.type === 'directory' ? html`
        <!-- Directory Path -->
        <div class="ffm__field">
          <label class="ffm__mono">DIRECTORY_PATH</label>
          <div class="ffm__input-with-btn">
            <input type="text" class="ffm__input" 
              placeholder="/sites/my-landing-page"
              .value=${pageLink.directoryPath || ''}
              @input=${(e: Event) => { pageLink.directoryPath = (e.target as HTMLInputElement).value; props.requestUpdate(); }}/>
            <button class="ffm__icon-btn" title="Browse">
              ${icons.folder}
            </button>
          </div>
          <p class="ffm__hint">// Path relative to workspace root</p>
        </div>

        <!-- Action Buttons -->
        <div class="ffm__page-actions">
          <button class="ffm__action-card" @click=${() => openSpawnDialog('edit_page')}>
            <div class="ffm__action-icon">${icons.edit}</div>
            <div class="ffm__action-info">
              <span class="ffm__mono">EDIT_WITH_AI</span>
              <small>Spawn AI session to edit this page</small>
            </div>
          </button>
          
          <button class="ffm__action-card" @click=${() => openSpawnDialog('create_page')}>
            <div class="ffm__action-icon">${icons.sparkles}</div>
            <div class="ffm__action-info">
              <span class="ffm__mono">CREATE_NEW</span>
              <small>Generate a new page with AI</small>
            </div>
          </button>
          
          <button class="ffm__action-card" @click=${() => openSpawnDialog('optimize_page')}>
            <div class="ffm__action-icon">${icons.zap}</div>
            <div class="ffm__action-info">
              <span class="ffm__mono">OPTIMIZE</span>
              <small>Improve conversion & design</small>
            </div>
          </button>
          
          ${pageLink.directoryPath ? html`
            <button class="ffm__action-card ffm__action-card--secondary" 
              @click=${() => window.open('file://' + pageLink.directoryPath + '/index.html', '_blank')}>
              <div class="ffm__action-icon">${icons.eye}</div>
              <div class="ffm__action-info">
                <span class="ffm__mono">PREVIEW</span>
                <small>Open in browser</small>
              </div>
            </button>
          ` : nothing}
        </div>

        ${pageLink.lastEdited ? html`
          <p class="ffm__hint" style="margin-top:12px;">
            // Last edited: ${new Date(pageLink.lastEdited).toLocaleString()}
          </p>
        ` : nothing}
      ` : nothing}

      ${pageLink.type === 'external' ? html`
        <!-- External URL -->
        <div class="ffm__field">
          <label class="ffm__mono">EXTERNAL_URL</label>
          <div class="ffm__input-with-btn">
            <input type="text" class="ffm__input" 
              placeholder="https://example.com/my-offer"
              .value=${pageLink.externalUrl || ''}
              @input=${(e: Event) => { pageLink.externalUrl = (e.target as HTMLInputElement).value; props.requestUpdate(); }}/>
            <button class="ffm__icon-btn" title="Open URL" 
              @click=${() => pageLink.externalUrl && window.open(pageLink.externalUrl, '_blank')}>
              ${icons.externalLink}
            </button>
          </div>
        </div>

        <div class="ffm__external-note">
          <p>External pages can still be tracked with the KPI script.</p>
          <p>Go to the <strong>KPI</strong> tab to get the embed code.</p>
        </div>
      ` : nothing}

      ${pageLink.type === 'none' ? html`
        <div class="ffm__empty-state-small">
          <p>No page linked to this node yet.</p>
          <p>Select <strong>DIRECTORY</strong> to link a local site, or <strong>EXTERNAL</strong> to link a URL.</p>
        </div>
      ` : nothing}
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// KPI TRACKING CONFIG
// ══════════════════════════════════════════════════════════════════════════════

function renderKpiConfig(node: FlowNode, flowMap: FunnelFlowMap, props: FunnelFlowMapProps): TemplateResult {
  // Initialize kpiTracking if not present
  if (!node.kpiTracking) {
    node.kpiTracking = {
      enabled: false,
      siteId: node.name.toLowerCase().replace(/[^a-z0-9]/g, '-'),
      trackClicks: true,
      trackScroll: true,
      trackForms: true,
      conversionGoal: 'form_submit',
    };
  }
  const kpi = node.kpiTracking;
  
  // Generate the tracking script
  const gatewayUrl = gatewayOrigin();
  const trackingScript = `<!-- InfiniBot KPI Tracker -->
<script 
  src="${gatewayUrl}/kpi.js"
  data-funnel="${flowMap.id}"
  data-node="${node.id}"
  data-site="${kpi.siteId}"
  ${kpi.trackClicks ? 'data-track-clicks="true"' : ''}
  ${kpi.trackScroll ? 'data-track-scroll="true"' : ''}
  ${kpi.trackForms ? 'data-track-forms="true"' : ''}
></script>`;

  const copyToClipboard = () => {
    navigator.clipboard.writeText(trackingScript);
    // Show toast or feedback
  };

  return html`
    <div class="ffm__config-section">
      <div class="ffm__section-title">${pIcons.barChart} KPI_TRACKING</div>
      <p class="ffm__section-desc">Track visitors, conversions, and engagement for this page</p>
      
      <!-- Enable Toggle -->
      <div class="ffm__kpi-toggle">
        <label class="ffm__checkbox-label ffm__checkbox-label--large">
          <input type="checkbox" class="ffm__checkbox-input" .checked=${kpi.enabled}
            @change=${(e: Event) => { kpi.enabled = (e.target as HTMLInputElement).checked; props.requestUpdate(); }}/>
          <span class="ffm__checkbox-box"></span>
          <span class="ffm__mono">ENABLE_TRACKING</span>
        </label>
      </div>

      ${kpi.enabled ? html`
        <!-- Site ID -->
        <div class="ffm__field">
          <label class="ffm__mono">SITE_ID</label>
          <input type="text" class="ffm__input" 
            placeholder="my-landing-page"
            .value=${kpi.siteId}
            @input=${(e: Event) => { kpi.siteId = (e.target as HTMLInputElement).value; props.requestUpdate(); }}/>
          <p class="ffm__hint">// Unique identifier for this page in analytics</p>
        </div>

        <!-- Tracking Options -->
        <div class="ffm__kpi-options">
          <div class="ffm__kpi-option">
            <label class="ffm__checkbox-label">
              <input type="checkbox" class="ffm__checkbox-input" .checked=${kpi.trackClicks}
                @change=${(e: Event) => { kpi.trackClicks = (e.target as HTMLInputElement).checked; props.requestUpdate(); }}/>
              <span class="ffm__checkbox-box"></span>
              <span>Track CTA Clicks</span>
            </label>
          </div>
          <div class="ffm__kpi-option">
            <label class="ffm__checkbox-label">
              <input type="checkbox" class="ffm__checkbox-input" .checked=${kpi.trackScroll}
                @change=${(e: Event) => { kpi.trackScroll = (e.target as HTMLInputElement).checked; props.requestUpdate(); }}/>
              <span class="ffm__checkbox-box"></span>
              <span>Track Scroll Depth</span>
            </label>
          </div>
          <div class="ffm__kpi-option">
            <label class="ffm__checkbox-label">
              <input type="checkbox" class="ffm__checkbox-input" .checked=${kpi.trackForms}
                @change=${(e: Event) => { kpi.trackForms = (e.target as HTMLInputElement).checked; props.requestUpdate(); }}/>
              <span class="ffm__checkbox-box"></span>
              <span>Track Form Submits</span>
            </label>
          </div>
        </div>

        <!-- Conversion Goal -->
        <div class="ffm__field">
          <label class="ffm__mono">CONVERSION_GOAL</label>
          <select class="ffm__select" .value=${kpi.conversionGoal || 'form_submit'}
            @change=${(e: Event) => { kpi.conversionGoal = (e.target as HTMLSelectElement).value as any; props.requestUpdate(); }}>
            <option value="form_submit">Form Submit</option>
            <option value="button_click">Button Click</option>
            <option value="page_visit">Page Visit</option>
            <option value="custom">Custom Event</option>
          </select>
        </div>

        ${kpi.conversionGoal === 'custom' ? html`
          <div class="ffm__field">
            <label class="ffm__mono">CUSTOM_EVENT_NAME</label>
            <input type="text" class="ffm__input" 
              placeholder="purchase_complete"
              .value=${kpi.customEventName || ''}
              @input=${(e: Event) => { kpi.customEventName = (e.target as HTMLInputElement).value; props.requestUpdate(); }}/>
          </div>
        ` : nothing}

        <!-- Tracking Code -->
        <div class="ffm__kpi-code">
          <div class="ffm__kpi-code-header">
            <label class="ffm__mono">EMBED_CODE</label>
            <button class="ffm__copy-btn" @click=${copyToClipboard} title="Copy to clipboard">
              ${icons.copy} <span>COPY</span>
            </button>
          </div>
          <pre class="ffm__code-block"><code>${trackingScript}</code></pre>
          <p class="ffm__hint">// Add this script before &lt;/body&gt; on your page</p>
        </div>

        <!-- What's Tracked -->
        <div class="ffm__kpi-tracked">
          <div class="ffm__kpi-tracked-header ffm__mono">// TRACKED_EVENTS</div>
          <div class="ffm__kpi-tracked-grid">
            <div class="ffm__kpi-tracked-item">${pIcons.checkCircle} Page Views</div>
            <div class="ffm__kpi-tracked-item">${pIcons.checkCircle} Session Duration</div>
            <div class="ffm__kpi-tracked-item">${pIcons.checkCircle} UTM Parameters</div>
            <div class="ffm__kpi-tracked-item">${pIcons.checkCircle} Referrer Source</div>
            ${kpi.trackClicks ? html`<div class="ffm__kpi-tracked-item">${pIcons.checkCircle} CTA Clicks</div>` : nothing}
            ${kpi.trackScroll ? html`<div class="ffm__kpi-tracked-item">${pIcons.checkCircle} Scroll Depth</div>` : nothing}
            ${kpi.trackForms ? html`<div class="ffm__kpi-tracked-item">${pIcons.checkCircle} Form Submits</div>` : nothing}
          </div>
        </div>
      ` : html`
        <div class="ffm__empty-state-small">
          <p>Enable tracking to get the embed code and start collecting analytics.</p>
        </div>
      `}
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// SPAWN DIALOG
// ══════════════════════════════════════════════════════════════════════════════

function renderSpawnDialog(props: FunnelFlowMapProps): TemplateResult {
  if (!_spawnContext) return html``;
  
  const context = _spawnContext;
  
  const closeDialog = () => {
    _showSpawnDialog = false;
    _spawnContext = null;
    props.requestUpdate();
  };

  const taskLabels = {
    edit_page: { title: 'EDIT_PAGE', icon: icons.edit, desc: 'Modify the existing page design and content' },
    create_page: { title: 'CREATE_PAGE', icon: icons.sparkles, desc: 'Generate a new page from scratch' },
    optimize_page: { title: 'OPTIMIZE_PAGE', icon: icons.zap, desc: 'Improve conversion rate and design' },
  };
  
  const task = taskLabels[context.taskType];

  const spawnAgent = async () => {
    // Build the task prompt with full context
    let taskPrompt = '';
    
    if (context.taskType === 'edit_page') {
      taskPrompt = `Edit the landing page at ${context.directoryPath || 'the specified directory'}.

Node: ${context.nodeName}
Directory: ${context.directoryPath || '(not set)'}

User Instructions:
${context.userInstructions || 'Make improvements to the page design and content.'}

Use the frontend-designer skill for visual changes. Read the existing files first, then make targeted edits.`;
    } else if (context.taskType === 'create_page') {
      taskPrompt = `Create a new landing page for "${context.nodeName}".

Save to: ${context.directoryPath || '/sites/' + context.nodeName.toLowerCase().replace(/[^a-z0-9]/g, '-')}

User Instructions:
${context.userInstructions || 'Create a modern, high-converting landing page.'}

Use the frontend-designer skill. Create index.html with inline CSS and minimal JS. Focus on conversion.`;
    } else if (context.taskType === 'optimize_page') {
      taskPrompt = `Optimize the landing page at ${context.directoryPath} for better conversions.

Node: ${context.nodeName}
Directory: ${context.directoryPath || '(not set)'}

User Instructions:
${context.userInstructions || 'Analyze the page and improve: headline, CTA buttons, social proof, mobile responsiveness, load speed.'}

Read the current page, identify issues, and make targeted improvements. Use frontend-designer skill.`;
    }

    // Spawn the agent
    props.onSpawnAI(context.nodeId, taskPrompt);
    closeDialog();
  };

  return html`
    <div class="ffm__overlay" @click=${closeDialog}>
      <div class="ffm__spawn-dialog" @click=${(e: Event) => e.stopPropagation()}>
        <div class="ffm__spawn-header">
          <div class="ffm__spawn-icon">${task.icon}</div>
          <div class="ffm__spawn-title">
            <h3 class="ffm__mono">${task.title}</h3>
            <p>${task.desc}</p>
          </div>
          <button class="ffm__modal-close" @click=${closeDialog}>${icons.close}</button>
        </div>

        <div class="ffm__spawn-body">
          <!-- Context Info -->
          <div class="ffm__spawn-context">
            <div class="ffm__spawn-context-item">
              <span class="ffm__mono">NODE:</span>
              <span>${context.nodeName}</span>
            </div>
            <div class="ffm__spawn-context-item">
              <span class="ffm__mono">PATH:</span>
              <span>${context.directoryPath || '(not set)'}</span>
            </div>
          </div>

          <!-- Directory Path (if not set) -->
          ${!context.directoryPath && context.taskType !== 'edit_page' ? html`
            <div class="ffm__field">
              <label class="ffm__mono">DIRECTORY_PATH</label>
              <input type="text" class="ffm__input" 
                placeholder="/sites/my-new-page"
                .value=${context.directoryPath}
                @input=${(e: Event) => { context.directoryPath = (e.target as HTMLInputElement).value; props.requestUpdate(); }}/>
              <p class="ffm__hint">// Where to save the page files</p>
            </div>
          ` : nothing}

          <!-- User Instructions -->
          <div class="ffm__field">
            <label class="ffm__mono">YOUR_INSTRUCTIONS</label>
            <textarea class="ffm__textarea ffm__spawn-textarea" 
              rows="5"
              placeholder=${context.taskType === 'edit_page' 
                ? 'e.g., "Change the headline to focus on pain points. Add more testimonials. Make the CTA button more prominent."'
                : context.taskType === 'create_page'
                ? 'e.g., "Create a high-ticket coaching sales page with video embed, testimonials section, FAQ, and strong CTA."'
                : 'e.g., "The form abandonment is high. Simplify the form fields. Add trust badges near the submit button."'}
              .value=${context.userInstructions}
              @input=${(e: Event) => { context.userInstructions = (e.target as HTMLTextAreaElement).value; props.requestUpdate(); }}></textarea>
            <p class="ffm__hint">// Be specific about what you want. The AI will use this as guidance.</p>
          </div>

          <!-- Quick Suggestions -->
          <div class="ffm__spawn-suggestions">
            <span class="ffm__mono">QUICK_ADD:</span>
            <div class="ffm__spawn-suggestion-chips">
              ${['Improve mobile layout', 'Add social proof', 'Stronger headline', 'Simplify CTA', 'Add urgency'].map(suggestion => html`
                <button class="ffm__chip" @click=${() => {
                  context.userInstructions = (context.userInstructions ? context.userInstructions + '\\n' : '') + suggestion + '. ';
                  props.requestUpdate();
                }}>${suggestion}</button>
              `)}
            </div>
          </div>
        </div>

        <div class="ffm__spawn-footer">
          <button class="ffm__btn ffm__btn--secondary" @click=${closeDialog}>
            CANCEL
          </button>
          <button class="ffm__btn ffm__btn--primary" @click=${spawnAgent}>
            ${icons.sparkles} <span class="ffm__mono">SPAWN_AGENT</span>
          </button>
        </div>
      </div>
    </div>
  `;
}

// Platform-specific features with FULL configuration panels
// FeatureConfigField, PlatformFeature, and PLATFORM_FEATURES are imported from ./platform-features.js


function renderFeatureField(field: FeatureConfigField, featureId: string, node: FlowNode, props: FunnelFlowMapProps): TemplateResult {
  if (!node.config) node.config = {};
  if (!node.config[featureId]) node.config[featureId] = {};
  const itemConfig = node.config[featureId];
  const value = itemConfig[field.id] || '';
  
  const updateValue = (val: string | boolean) => {
    node.config![featureId][field.id] = val;
    props.requestUpdate();
  };
  
  if (field.type === 'checkbox') {
    return html`
      <div class="ffm__pf-field ffm__pf-field--checkbox">
        <label class="ffm__checkbox-label">
          <input type="checkbox" class="ffm__checkbox-input" .checked=${!!value}
            @change=${(e: Event) => updateValue((e.target as HTMLInputElement).checked)}/>
          <span class="ffm__checkbox-box"></span>
          <span class="ffm__mono">${field.label}</span>
        </label>
        ${field.hint ? html`<span class="ffm__pf-hint">${field.hint}</span>` : nothing}
      </div>
    `;
  }
  
  if (field.type === 'select') {
    return html`
      <div class="ffm__pf-field">
        <label class="ffm__mono">${field.label}${field.required ? html`<span class="ffm__required">*</span>` : nothing}</label>
        <select class="ffm__select" .value=${value} @change=${(e: Event) => updateValue((e.target as HTMLSelectElement).value)}>
          <option value="">Select...</option>
          ${field.options?.map(opt => html`<option value="${opt.value}" ?selected=${value === opt.value}>${opt.label}</option>`)}
        </select>
        ${field.hint ? html`<span class="ffm__pf-hint">${field.hint}</span>` : nothing}
      </div>
    `;
  }
  
  if (field.type === 'textarea') {
    return html`
      <div class="ffm__pf-field">
        <label class="ffm__mono">${field.label}${field.required ? html`<span class="ffm__required">*</span>` : nothing}</label>
        <textarea class="ffm__textarea" placeholder="${field.placeholder || ''}" .value=${value}
          @input=${(e: Event) => updateValue((e.target as HTMLTextAreaElement).value)}></textarea>
        ${field.hint ? html`<span class="ffm__pf-hint">${field.hint}</span>` : nothing}
      </div>
    `;
  }
  
  // text, password, number
  return html`
    <div class="ffm__pf-field">
      <label class="ffm__mono">${field.label}${field.required ? html`<span class="ffm__required">*</span>` : nothing}</label>
      <input type="${field.type}" class="ffm__input" 
        placeholder="${field.placeholder || ''}"
        .value=${value}
        @input=${(e: Event) => updateValue((e.target as HTMLInputElement).value)}/>
      ${field.hint ? html`<span class="ffm__pf-hint">${field.hint}</span>` : nothing}
    </div>
  `;
}

function renderFeaturesConfig(node: FlowNode, props: FunnelFlowMapProps): TemplateResult {
  const platformFeatures = node.platform ? PLATFORM_FEATURES[node.platform] : null;
  const communityFeatures = node.type === 'community' ? COMMUNITY_FEATURES : null;
  const activeFeatures = communityFeatures || platformFeatures;
  const featureLabel = communityFeatures ? 'Community Node' : (node.platform ? PLATFORM_CONFIG[node.platform]?.label : null);
  
  return html`
    <div class="ffm__config-section ffm__features-config">
      ${activeFeatures ? html`
        <p class="ffm__section-desc">${communityFeatures ? html`${pIcons.house} Community platform features` : `Platform-specific features for ${featureLabel}`}</p>
        
        <div class="ffm__platform-features">
          ${activeFeatures.map(feature => {
            const isEnabled = node.items?.some(i => i.id === feature.id && i.enabled);
            
            return html`
              <div class="ffm__platform-feature ${isEnabled ? 'enabled' : ''}">
                <div class="ffm__pf-header" @click=${() => toggleFeature(node, feature.id, props)}>
                  <span class="ffm__pf-icon">${(icons as Record<string, unknown>)[feature.icon] ?? nothing}</span>
                  <div class="ffm__pf-info">
                    <span class="ffm__mono">${feature.name}</span>
                    <span class="ffm__pf-desc">${feature.description}</span>
                  </div>
                  <span class="ffm__pf-toggle ${isEnabled ? 'on' : ''}"></span>
                </div>
                
                ${isEnabled && feature.requiredIntegration ? html`
                  <div class="ffm__pf-badge">
                    ${icons.link} Requires ${feature.requiredIntegration.toUpperCase()}
                  </div>
                ` : nothing}
                
                ${isEnabled && feature.sections ? html`
                  <div class="ffm__pf-config ffm__pf-sections">
                    ${feature.sections.map(section => html`
                      <div class="ffm__pf-section">
                        <div class="ffm__pf-section-title">${section.title}</div>
                        <div class="ffm__pf-section-fields">
                          ${section.fields.map(field => renderFeatureField(field, feature.id, node, props))}
                        </div>
                      </div>
                    `)}
                  </div>
                ` : nothing}
                
                ${isEnabled && feature.configFields && !feature.sections ? html`
                  <div class="ffm__pf-config">
                    ${feature.configFields.map(field => renderFeatureField(field, feature.id, node, props))}
                  </div>
                ` : nothing}
              </div>
            `;
          })}
        </div>
      ` : html`
        <p class="ffm__section-desc">Custom features for this node</p>
      `}
      
      <!-- Custom features -->
      <div class="ffm__custom-features">
        <div class="ffm__section-header ffm__mono">// CUSTOM_FEATURES</div>
        <div class="ffm__features">
          ${(node.items || []).filter(i => !activeFeatures?.some(pf => pf.id === i.id)).map((item, idx) => html`
            <div class="ffm__feature">
              <input type="checkbox" class="ffm__checkbox" .checked=${item.enabled}
                @change=${(e: Event) => { item.enabled = (e.target as HTMLInputElement).checked; props.requestUpdate(); }}/>
              <input type="text" class="ffm__feature-input" .value=${item.label}
                @input=${(e: Event) => { item.label = (e.target as HTMLInputElement).value; props.requestUpdate(); }}/>
              <button class="ffm__feature-del" @click=${() => { node.items!.splice(idx, 1); props.requestUpdate(); }}>
                ${icons.close}
              </button>
            </div>
          `)}
        </div>

        <button class="ffm__add-btn" @click=${() => { 
          if (!node.items) node.items = [];
          node.items.push({ id: `custom-${Date.now()}`, label: 'CUSTOM_FEATURE', enabled: true }); 
          props.requestUpdate(); 
        }}>
          ${icons.plus} <span class="ffm__mono">ADD_CUSTOM</span>
        </button>
      </div>
    </div>
  `;
}

function toggleFeature(node: FlowNode, featureId: string, props: FunnelFlowMapProps) {
  if (!node.items) node.items = [];
  const existing = node.items.find(i => i.id === featureId);
  if (existing) {
    existing.enabled = !existing.enabled;
  } else {
    node.items.push({ id: featureId, label: featureId.toUpperCase().replace(/_/g, ' '), enabled: true });
  }
  props.requestUpdate();
}

function renderApiConfig(node: FlowNode, props: FunnelFlowMapProps): TemplateResult {
  const integration = node.integration!;
  
  return html`
    <div class="ffm__config-section">
      <!-- Integration Type Selection -->
      <div class="ffm__field">
        <label class="ffm__mono">HOW TO CONNECT</label>
        <div class="ffm__integration-grid">
          <button class="ffm__integration-opt ${integration.type === 'api' ? 'selected' : ''}"
            @click=${() => { integration.type = 'api'; props.requestUpdate(); }}
            title="Connect directly using your account credentials">
            ${icons.api} <span>Direct Connect</span>
          </button>
          <button class="ffm__integration-opt ${integration.type === 'webhook' ? 'selected' : ''}"
            @click=${() => { integration.type = 'webhook'; props.requestUpdate(); }}
            title="Receive automatic updates when things happen">
            ${icons.webhook} <span>Auto-Sync</span>
          </button>
          <button class="ffm__integration-opt ${integration.type === 'manual' ? 'selected' : ''}"
            @click=${() => { integration.type = 'manual'; props.requestUpdate(); }}
            title="Enter data manually without automation">
            ${icons.manual} <span>Manual</span>
          </button>
        </div>
      </div>

      ${integration.type === 'api' ? html`
        <!-- API Configuration -->
        <div class="ffm__api-section">
          <div class="ffm__field">
            <label class="ffm__mono">API KEY</label>
            <input type="password" class="ffm__input" placeholder="sk_live_..." 
              .value=${integration.apiKey || ''}
              @input=${(e: Event) => { integration.apiKey = (e.target as HTMLInputElement).value; props.requestUpdate(); }}/>
          </div>
          
          <div class="ffm__field">
            <label class="ffm__mono">ACCESS TOKEN</label>
            <input type="password" class="ffm__input" placeholder="Paste your access token here"
              .value=${integration.accessToken || ''}
              @input=${(e: Event) => { integration.accessToken = (e.target as HTMLInputElement).value; props.requestUpdate(); }}/>
          </div>
          
          <div class="ffm__field">
            <label class="ffm__mono">REFRESH TOKEN <span style="opacity:0.5">(optional)</span></label>
            <input type="password" class="ffm__input" placeholder="For auto-renewal"
              .value=${integration.refreshToken || ''}
              @input=${(e: Event) => { integration.refreshToken = (e.target as HTMLInputElement).value; props.requestUpdate(); }}/>
          </div>

          <button class="ffm__test-btn" @click=${() => testApiConnection(node, props)}>
            ${icons.link} <span class="ffm__mono">TEST CONNECTION</span>
          </button>
        </div>
      ` : nothing}

      ${integration.type === 'webhook' ? html`
        <!-- Auto-Sync Configuration -->
        <div class="ffm__api-section">
          <div class="ffm__field">
            <label class="ffm__mono">YOUR SYNC URL</label>
            <p style="font-size: 12px; color: #888; margin: 0 0 8px;">Copy this URL into your platform's settings to receive automatic updates</p>
            <div class="ffm__webhook-field">
              <code class="ffm__mono">${gatewayOrigin()}/api/webhooks/funnel/${node.id}</code>
              <button class="ffm__copy-btn" title="Copy URL" @click=${() => navigator.clipboard.writeText(`${gatewayOrigin()}/api/webhooks/funnel/${node.id}`)}>
                ${icons.copy}
              </button>
            </div>
          </div>
          
          <div class="ffm__field">
            <label class="ffm__mono">SECRET KEY <span style="opacity:0.5">(optional)</span></label>
            <input type="text" class="ffm__input" placeholder="For extra security" 
              .value=${integration.webhookSecret || ''}
              @input=${(e: Event) => { integration.webhookSecret = (e.target as HTMLInputElement).value; props.requestUpdate(); }}/>
          </div>
        </div>
      ` : nothing}

      ${integration.type === 'manual' ? html`
        <div class="ffm__manual-note">
          <p>${pIcons.penLine} Manual mode — you'll enter data yourself instead of syncing automatically.</p>
          <p style="color: #888; font-size: 12px;">Update your stats anytime from the dashboard.</p>
        </div>
      ` : nothing}

      <!-- Connection Status -->
      <div class="ffm__connection-status">
        <div class="ffm__status-row">
          <span class="ffm__mono">STATUS:</span>
          <span class="ffm__status-badge ${integration.connected ? 'connected' : 'disconnected'}">
            ${integration.connected ? 'CONNECTED' : 'DISCONNECTED'}
          </span>
        </div>
        ${integration.lastSync ? html`
          <div class="ffm__status-row">
            <span class="ffm__mono">LAST_SYNC:</span>
            <span>${new Date(integration.lastSync).toLocaleString()}</span>
          </div>
        ` : nothing}
      </div>

      <!-- AI Assistant -->
      <button class="ffm__ai-btn" @click=${() => props.onSpawnAI(node.id, 'api-setup')}>
        ${icons.ai} <span class="ffm__mono">AI_SETUP_ASSISTANT</span>
      </button>
    </div>
  `;
}

async function testApiConnection(node: FlowNode, props: FunnelFlowMapProps): Promise<void> {
  // TODO: Implement actual API testing
  if (node.integration) {
    node.integration.connected = true;
    node.integration.lastSync = Date.now();
    props.requestUpdate();
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════════

function getDefaultItems(type: FlowNodeType, platform?: PlatformType): FlowNodeItem[] {
  if (platform === 'instagram') return [
    { id: 'dm', label: 'DM_FLOWS', enabled: true },
    { id: 'bio', label: 'LINK_IN_BIO', enabled: true },
  ];
  if (platform === 'youtube') return [
    { id: 'bio', label: 'LINK_IN_BIO', enabled: true },
    { id: 'comments', label: 'LINK_IN_COMMENTS', enabled: true },
  ];
  if (platform === 'tiktok') return [{ id: 'bio', label: 'LINK_IN_BIO', enabled: true }];
  if (type === 'hub') return [
    { id: 'website', label: 'WEBSITE', enabled: true },
    { id: 'discord', label: 'DISCORD', enabled: true },
  ];
  if (type === 'offer') return [{ id: 'landing', label: 'LANDING_PAGE', enabled: true }];
  if (type === 'entry') return [{ id: 'dm', label: 'DM_FLOW', enabled: true }];
  if (type === 'community') return [
    { id: 'courses', label: 'COURSES', enabled: true },
    { id: 'vault', label: 'VAULT_FILES', enabled: true },
    { id: 'membership_tiers', label: 'MEMBERSHIP_TIERS', enabled: true },
    { id: 'discord', label: 'DISCORD_SYNC', enabled: true },
    { id: 'onboarding', label: 'ONBOARDING_FLOW', enabled: true },
    { id: 'events', label: 'EVENTS_CALENDAR', enabled: false },
    { id: 'gamification', label: 'GAMIFICATION', enabled: false },
    { id: 'discussions', label: 'DISCUSSIONS', enabled: false },
    { id: 'email_sequences', label: 'EMAIL_SEQUENCES', enabled: false },
    { id: 'payments', label: 'PAYMENTS_BILLING', enabled: false },
    { id: 'kpi_tracking', label: 'KPI_TRACKING', enabled: false },
    { id: 'supabase', label: 'SUPABASE_DB', enabled: false },
    { id: 'automation', label: 'AUTOMATION_RULES', enabled: false },
    { id: 'ai_assistant', label: 'AI_ASSISTANT', enabled: false },
  ];
  return [];
}

function addNode(type: FlowNodeType, flowMap: FunnelFlowMap, props: FunnelFlowMapProps) {
  if (type === 'social' || type === 'messaging') { _addNodeType = type; props.requestUpdate(); return; }
  
  const config = NODE_TYPE_CONFIG[type];
  const maxRow = Math.max(0, ...flowMap.nodes.map(n => n.row ?? 0));
  const newNode: FlowNode = {
    id: `node-${Date.now()}`,
    type,
    name: config.label.replace(/_/g, ' '),
    row: maxRow + 1,
    column: 0,
    items: getDefaultItems(type),
  };
  
  flowMap.nodes.push(newNode);
  _showAddNodeModal = false;
  _addNodeType = null;
  openSetupWizard(newNode, props);
}

/**
 * Promote the current flow map to a live funnel. Calls
 * funnels.flowmap.promote on the gateway, which:
 *   1. Creates a funnel record (or reuses the bound one)
 *   2. Materializes one stage per node, preserved canvas order
 *   3. Writes funnelId back onto the flow map + stageId onto each node
 * After the round-trip we replace the in-memory flowMap with the
 * server's response so the canvas + hover analytics immediately reflect
 * the new bound state.
 */
async function promoteFlowMap(flowMap: FunnelFlowMap, props: FunnelFlowMapProps) {
  if (!props.client) {
    alert("Gateway not connected.");
    return;
  }
  if (flowMap.nodes.length === 0) {
    alert("Add at least one step to the flow before going live.");
    return;
  }
  if (
    !window.confirm(
      `Promote "${flowMap.name}" to a live funnel?\n\n` +
        `• Creates a funnel record\n` +
        `• Materializes ${flowMap.nodes.length} stage${flowMap.nodes.length === 1 ? "" : "s"}\n` +
        `• Unlocks real lead tracking + analytics on hover\n\n` +
        `You can keep editing the canvas after going live.`,
    )
  )
    return;
  try {
    // Persist current canvas state first so the server promotes a fresh
    // copy (in case the user edited and hasn't saved since last tick).
    props.onSave(flowMap);
    const result = await props.client.request<{
      flowMap: FunnelFlowMap;
      funnel: { id: string; name: string };
    }>("funnels.flowmap.promote", { flowMapId: flowMap.id });
    if (result?.flowMap) {
      // Drop the canvas's draft fields onto the returned shape so the
      // current render sees funnelId immediately.
      Object.assign(flowMap, result.flowMap);
      props.onSave(result.flowMap);
      // Invalidate the snapshot cache so the first hover fetches live counts.
      _snapshotCache.delete(result.flowMap.funnelId!);
    }
    props.requestUpdate();
  } catch (err) {
    console.error("[ffm] promote failed:", err);
    alert(`Could not promote flow map: ${(err as Error).message ?? err}`);
  }
}

/**
 * Add a node from the production NODE_LIBRARY. Carries the library id
 * onto the node so the canvas + analytics can resolve it back. Stamps
 * default items, color, and name from the library entry. Saves and
 * opens the setup wizard so the operator can fine-tune immediately.
 */
function addNodeFromLibrary(
  entry: NodeLibraryEntry,
  flowMap: FunnelFlowMap,
  props: FunnelFlowMapProps,
) {
  const maxRow = Math.max(0, ...flowMap.nodes.map((n) => n.row ?? 0));
  const newNode: FlowNode = {
    id: `node-${Date.now()}`,
    type: entry.type,
    platform: entry.platform,
    name: entry.defaultName,
    color: entry.color,
    row: maxRow + 1,
    column: 0,
    items: (entry.defaultItems
      ? entry.defaultItems.map((i) => ({ ...i }))
      : getDefaultItems(entry.type, entry.platform)) as FlowNodeItem[],
    libraryId: entry.id,
  };

  flowMap.nodes.push(newNode);
  _showAddNodeModal = false;
  _addNodeType = null;
  _addNodeSearch = "";
  _addNodeRecent = [entry.id, ..._addNodeRecent.filter((id) => id !== entry.id)].slice(0, 6);
  props.onSave(flowMap);
  openSetupWizard(newNode, props);
}

function addNodeWithPlatform(type: FlowNodeType, platform: PlatformType, flowMap: FunnelFlowMap, props: FunnelFlowMapProps) {
  const config = PLATFORM_CONFIG[platform];
  const maxRow = Math.max(0, ...flowMap.nodes.map(n => n.row ?? 0));
  const newNode: FlowNode = {
    id: `node-${Date.now()}`,
    type,
    platform,
    name: config.label,
    row: maxRow + 1,
    column: 0,
    items: getDefaultItems(type, platform),
  };
  
  flowMap.nodes.push(newNode);
  _showAddNodeModal = false;
  _addNodeType = null;
  openSetupWizard(newNode, props);
}

function openSetupWizard(node: FlowNode, props: FunnelFlowMapProps) {
  _setupWizardNode = node;
  _setupWizardStep = 0;
  _showSetupWizard = true;
  props.requestUpdate();
}

function saveNodeConfig(node: FlowNode, flowMap: FunnelFlowMap, props: FunnelFlowMapProps) {
  const idx = flowMap.nodes.findIndex(n => n.id === node.id);
  if (idx >= 0) flowMap.nodes[idx] = { ...node };
  props.onSave(flowMap);
  _showSetupWizard = false;
  _setupWizardNode = null;
  _setupWizardStep = 0;
  props.requestUpdate();
}

function deleteNode(nodeId: string, flowMap: FunnelFlowMap, props: FunnelFlowMapProps) {
  flowMap.nodes = flowMap.nodes.filter(n => n.id !== nodeId);
  flowMap.connections = flowMap.connections.filter(c => c.from !== nodeId && c.to !== nodeId);
  _selectedNodeId = null;
  props.onSave(flowMap);
  props.requestUpdate();
}

function startConnecting(nodeId: string, props: FunnelFlowMapProps) {
  _connectingFromId = nodeId;
  props.requestUpdate();
}

function handleConnectorClick(nodeId: string, position: 'top' | 'bottom', flowMap: FunnelFlowMap, props: FunnelFlowMapProps) {
  if (_connectingFromId && _connectingFromId !== nodeId) {
    const conn: FlowConnection = {
      id: `conn-${Date.now()}`,
      from: position === 'top' ? nodeId : _connectingFromId,
      to: position === 'top' ? _connectingFromId : nodeId,
    };
    const exists = flowMap.connections.some(c => (c.from === conn.from && c.to === conn.to) || (c.from === conn.to && c.to === conn.from));
    if (!exists) { flowMap.connections.push(conn); props.onSave(flowMap); }
    _connectingFromId = null;
  } else {
    _connectingFromId = nodeId;
  }
  props.requestUpdate();
}

function handleZoom(e: WheelEvent, requestUpdate: () => void) {
  e.preventDefault();
  _viewZoom = Math.min(1.5, Math.max(0.5, _viewZoom + (e.deltaY > 0 ? -0.05 : 0.05)));
  requestUpdate();
}

// ══════════════════════════════════════════════════════════════════════════════
// TEMPLATES
// ══════════════════════════════════════════════════════════════════════════════

function createTemplate(template: string, props: FunnelFlowMapProps) {
  const flowMap = buildJourneyFlowMap(template, '');
  props.onSave(flowMap);
  props.requestUpdate();
}

/**
 * Pure builder — given a template id + business id, return a fresh
 * FunnelFlowMap. No side-effects. Used by the sidebar's "Journeys"
 * panel to load a template directly without going through the
 * empty-state UI.
 */
export function buildJourneyFlowMap(template: string, businessId: string): FunnelFlowMap {
  let flowMap: FunnelFlowMap;
  
  if (template === 'community-membership') {
    // Full community platform with courses, tiers, and monetization
    flowMap = {
      id: `flow-${Date.now()}`, name: 'Community Membership', businessId: '',
      nodes: [
        { id: 'n1', type: 'social', platform: 'instagram', name: 'INSTAGRAM', row: 0, column: 0, items: getDefaultItems('social', 'instagram') },
        { id: 'n2', type: 'social', platform: 'youtube', name: 'YOUTUBE', row: 0, column: 1, items: getDefaultItems('social', 'youtube') },
        { id: 'n3', type: 'landing', name: 'SALES_PAGE', row: 1, column: 0, items: [{ id: 'form', label: 'OPT_IN_FORM', enabled: true }, { id: 'testimonials', label: 'TESTIMONIALS', enabled: true }] },
        { id: 'n4', type: 'community', name: 'COMMUNITY_HUB', row: 2, column: 0, items: getDefaultItems('community') },
        { id: 'n5', type: 'offer', name: 'PREMIUM_TIER', row: 3, column: 0, items: [{ id: 'coaching', label: '1:1_COACHING', enabled: true }] },
        { id: 'n6', type: 'qualification', name: 'LEAD_SCORING', row: 3, column: 1, items: [] },
      ],
      connections: [
        { id: 'c1', from: 'n1', to: 'n3' },
        { id: 'c2', from: 'n2', to: 'n3' },
        { id: 'c3', from: 'n3', to: 'n4' },
        { id: 'c4', from: 'n4', to: 'n5' },
        { id: 'c5', from: 'n4', to: 'n6' },
      ],
    };
  } else if (template === 'course-funnel') {
    // Course-focused funnel with community
    flowMap = {
      id: `flow-${Date.now()}`, name: 'Course Funnel', businessId: '',
      nodes: [
        { id: 'n1', type: 'social', platform: 'instagram', name: 'INSTAGRAM', row: 0, column: 0, items: getDefaultItems('social', 'instagram') },
        { id: 'n2', type: 'social', platform: 'tiktok', name: 'TIKTOK', row: 0, column: 1, items: getDefaultItems('social', 'tiktok') },
        { id: 'n3', type: 'landing', name: 'FREE_TRAINING', row: 1, column: 0, items: [{ id: 'webinar', label: 'WEBINAR_REG', enabled: true }] },
        { id: 'n4', type: 'messaging', platform: 'email', name: 'EMAIL_SEQUENCE', row: 2, column: 0, items: [{ id: 'seq', label: 'NURTURE_SEQ', enabled: true }] },
        { id: 'n5', type: 'community', name: 'COURSE_COMMUNITY', row: 3, column: 0, items: getDefaultItems('community') },
        { id: 'n6', type: 'offer', name: 'HIGH_TICKET', row: 4, column: 0, items: getDefaultItems('offer') },
      ],
      connections: [
        { id: 'c1', from: 'n1', to: 'n3' },
        { id: 'c2', from: 'n2', to: 'n3' },
        { id: 'c3', from: 'n3', to: 'n4' },
        { id: 'c4', from: 'n4', to: 'n5' },
        { id: 'c5', from: 'n5', to: 'n6' },
      ],
    };
  } else if (template === 'coaching-business') {
    // Coaching/consulting business funnel
    flowMap = {
      id: `flow-${Date.now()}`, name: 'Coaching Business', businessId: '',
      nodes: [
        { id: 'n1', type: 'entry', name: 'CONTENT_LEADS', row: 0, column: 0, items: getDefaultItems('entry') },
        { id: 'n2', type: 'entry', name: 'REFERRALS', row: 0, column: 1, items: getDefaultItems('entry') },
        { id: 'n3', type: 'entry', name: 'ADS', row: 0, column: 2, items: getDefaultItems('entry') },
        { id: 'n4', type: 'landing', name: 'BOOK_CALL', row: 1, column: 1, items: [{ id: 'calendar', label: 'CALENDLY', enabled: true }] },
        { id: 'n5', type: 'qualification', name: 'QUALIFY_LEADS', row: 2, column: 1, items: [] },
        { id: 'n6', type: 'community', name: 'CLIENT_PORTAL', row: 3, column: 0, items: getDefaultItems('community') },
        { id: 'n7', type: 'offer', name: 'COACHING_PROGRAM', row: 3, column: 1, items: [{ id: 'calls', label: 'WEEKLY_CALLS', enabled: true }] },
      ],
      connections: [
        { id: 'c1', from: 'n1', to: 'n4' },
        { id: 'c2', from: 'n2', to: 'n4' },
        { id: 'c3', from: 'n3', to: 'n4' },
        { id: 'c4', from: 'n4', to: 'n5' },
        { id: 'c5', from: 'n5', to: 'n6' },
        { id: 'c6', from: 'n5', to: 'n7' },
      ],
    };
  } else if (template === 'social-to-offer') {
    // Social → Community → Offer (updated to use community node)
    flowMap = {
      id: `flow-${Date.now()}`, name: 'Social to Offer', businessId: '',
      nodes: [
        { id: 'n1', type: 'social', platform: 'instagram', name: 'INSTAGRAM', row: 0, column: 0, items: getDefaultItems('social', 'instagram') },
        { id: 'n2', type: 'social', platform: 'tiktok', name: 'TIKTOK', row: 0, column: 1, items: getDefaultItems('social', 'tiktok') },
        { id: 'n3', type: 'community', name: 'COMMUNITY', row: 1, column: 0, items: getDefaultItems('community') },
        { id: 'n4', type: 'offer', name: 'HIGH_TICKET', row: 2, column: 0, items: getDefaultItems('offer') },
        { id: 'n5', type: 'qualification', name: 'LEAD_QUAL', row: 3, column: 0, items: [] },
      ],
      connections: [
        { id: 'c1', from: 'n1', to: 'n3' },
        { id: 'c2', from: 'n2', to: 'n3' },
        { id: 'c3', from: 'n3', to: 'n4' },
        { id: 'c4', from: 'n4', to: 'n5' },
      ],
    };
  } else if (template === 'multi-entry') {
    // Multi-entry → Community Hub
    flowMap = {
      id: `flow-${Date.now()}`, name: 'Multi-Entry Hub', businessId: '',
      nodes: [
        { id: 'n1', type: 'entry', name: 'BEGINNER', row: 0, column: 0, items: getDefaultItems('entry') },
        { id: 'n2', type: 'entry', name: 'BUSINESS', row: 0, column: 1, items: getDefaultItems('entry') },
        { id: 'n3', type: 'entry', name: 'ADVANCED', row: 0, column: 2, items: getDefaultItems('entry') },
        { id: 'n4', type: 'community', name: 'COMMUNITY_HUB', row: 1, column: 1, items: getDefaultItems('community') },
        { id: 'n5', type: 'offer', name: 'MAIN_OFFER', row: 2, column: 0, items: getDefaultItems('offer') },
        { id: 'n6', type: 'offer', name: 'PREMIUM', row: 2, column: 1, items: getDefaultItems('offer') },
      ],
      connections: [
        { id: 'c1', from: 'n1', to: 'n4' },
        { id: 'c2', from: 'n2', to: 'n4' },
        { id: 'c3', from: 'n3', to: 'n4' },
        { id: 'c4', from: 'n4', to: 'n5' },
        { id: 'c5', from: 'n4', to: 'n6' },
      ],
    };
  } else {
    // Lead Magnet funnel (default)
    flowMap = {
      id: `flow-${Date.now()}`, name: 'Lead Magnet', businessId: '',
      nodes: [
        { id: 'n1', type: 'social', platform: 'instagram', name: 'INSTAGRAM', row: 0, column: 0, items: getDefaultItems('social', 'instagram') },
        { id: 'n2', type: 'landing', name: 'OPT_IN', row: 1, column: 0, items: [{ id: 'form', label: 'LEAD_FORM', enabled: true }] },
        { id: 'n3', type: 'messaging', platform: 'email', name: 'EMAIL_NURTURE', row: 2, column: 0, items: [{ id: 'seq', label: 'SEQUENCE', enabled: true }] },
        { id: 'n4', type: 'community', name: 'COMMUNITY', row: 3, column: 0, items: getDefaultItems('community') },
        { id: 'n5', type: 'offer', name: 'OFFER', row: 4, column: 0, items: getDefaultItems('offer') },
      ],
      connections: [
        { id: 'c1', from: 'n1', to: 'n2' },
        { id: 'c2', from: 'n2', to: 'n3' },
        { id: 'c3', from: 'n3', to: 'n4' },
        { id: 'c4', from: 'n4', to: 'n5' },
      ],
    };
  }
  if (businessId) flowMap.businessId = businessId;
  return flowMap;
}

/**
 * Registry of customer-journey templates exposed in the sidebar.
 * Order here is the order shown to the user. Each entry's `id` matches
 * the case in `buildJourneyFlowMap` above.
 */
export interface JourneyTemplateEntry {
  id: string;
  name: string;
  description: string;
  category: "Community" | "Acquisition" | "Sales";
  emoji: string;
}

export const JOURNEY_TEMPLATES: ReadonlyArray<JourneyTemplateEntry> = [
  {
    id: "community-membership",
    name: "Community Membership",
    description: "Social media → Sales page → Community → Premium tier",
    category: "Community",
    emoji: "🏛️",
  },
  {
    id: "course-funnel",
    name: "Online Course",
    description: "Webinar → Email sequence → Course community → High-ticket",
    category: "Community",
    emoji: "🎓",
  },
  {
    id: "coaching-business",
    name: "Coaching Business",
    description: "Multi-entry → Book call → Qualify → Client portal",
    category: "Sales",
    emoji: "🎯",
  },
  {
    id: "social-to-offer",
    name: "Social to Offer",
    description: "Instagram + TikTok → Community → High-ticket → Qualify",
    category: "Acquisition",
    emoji: "📱",
  },
  {
    id: "lead-magnet",
    name: "Lead Magnet",
    description: "Content → Opt-in → Email nurture → Community → Offer",
    category: "Acquisition",
    emoji: "🧲",
  },
  {
    id: "multi-entry",
    name: "Multi-Entry Hub",
    description: "Beginner / Business / Advanced → Hub → Main + Premium offer",
    category: "Sales",
    emoji: "🌐",
  },
];

export function createEmptyFlowMap(businessId: string): FunnelFlowMap {
  return { id: `flow-${Date.now()}`, name: 'New Flow', businessId, nodes: [], connections: [] };
}

// ══════════════════════════════════════════════════════════════════════════════
// STYLES
// ══════════════════════════════════════════════════════════════════════════════

const flowMapStyles = `
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap');

  .ffm {
    position: relative;
    width: 100%;
    height: 100%;
    background: var(--glass-3);
    overflow: hidden;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    outline: none;
  }

  .ffm--pan-mode {
    cursor: grab;
  }

  .ffm--pan-mode:active {
    cursor: grabbing;
  }

  .ffm--pan-mode * {
    pointer-events: none !important;
  }

  .ffm__mono {
    font-family: 'JetBrains Mono', 'Fira Code', 'SF Mono', Consolas, monospace;
    letter-spacing: -0.02em;
  }

  .ffm__icon {
    width: 16px;
    height: 16px;
    display: inline-flex;
  }

  .ffm__icon svg {
    width: 100%;
    height: 100%;
  }

  /* ═══════════════════════════════════════════════════════════════
     LOADING
     ═══════════════════════════════════════════════════════════════ */
  .ffm__loading {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    gap: 16px;
    color: color-mix(in srgb, var(--glass-gold) 60%, transparent);
  }

  .ffm__spinner {
    width: 32px;
    height: 32px;
    border: 2px solid color-mix(in srgb, var(--glass-gold) 15%, transparent);
    border-top-color: var(--glass-gold);
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }

  @keyframes spin { to { transform: rotate(360deg); } }

  /* ═══════════════════════════════════════════════════════════════
     EMPTY STATE
     ═══════════════════════════════════════════════════════════════ */
  .ffm--empty {
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .ffm__empty-box {
    text-align: center;
    max-width: 480px;
    padding: 48px;
    background: linear-gradient(180deg, color-mix(in srgb, var(--glass-gold) 2%, transparent) 0%, transparent 100%);
    border: 1px solid color-mix(in srgb, var(--glass-gold) 10%, transparent);
    border-radius: 16px;
  }

  .ffm__empty-icon {
    width: 64px;
    height: 64px;
    margin: 0 auto 24px;
    color: color-mix(in srgb, var(--glass-gold) 50%, transparent);
  }

  .ffm__empty-icon svg {
    width: 100%;
    height: 100%;
  }

  .ffm__empty-box h2 {
    margin: 0 0 8px;
    font-size: 20px;
    color: var(--glass-gold);
  }

  .ffm__empty-box > p {
    margin: 0 0 32px;
    color: var(--glass-fg-3);
    font-size: 14px;
  }

  .ffm__templates {
    text-align: left;
    margin-bottom: 24px;
  }

  .ffm__templates-header {
    font-size: 11px;
    color: color-mix(in srgb, var(--glass-gold) 40%, transparent);
    margin-bottom: 12px;
  }

  .ffm__template {
    display: flex;
    align-items: center;
    gap: 14px;
    width: 100%;
    padding: 14px 16px;
    margin-bottom: 8px;
    background: color-mix(in srgb, var(--glass-gold) 3%, transparent);
    border: 1px solid color-mix(in srgb, var(--glass-gold) 8%, transparent);
    border-radius: 10px;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .ffm__template:hover {
    background: color-mix(in srgb, var(--glass-gold) 6%, transparent);
    border-color: color-mix(in srgb, var(--glass-gold) 20%, transparent);
    transform: translateX(4px);
  }

  .ffm__template-icon {
    width: 24px;
    height: 24px;
    color: color-mix(in srgb, var(--glass-gold) 60%, transparent);
  }

  .ffm__template-icon svg {
    width: 100%;
    height: 100%;
  }

  .ffm__template-info {
    flex: 1;
    text-align: left;
  }

  .ffm__template-info .ffm__mono {
    display: block;
    color: white;
    font-size: 12px;
    margin-bottom: 2px;
  }

  .ffm__template-desc {
    font-size: 11px;
    color: var(--glass-fg-4);
  }

  .ffm__template-arrow {
    width: 16px;
    height: 16px;
    color: color-mix(in srgb, var(--glass-gold) 30%, transparent);
  }

  .ffm__template-arrow svg {
    width: 100%;
    height: 100%;
  }

  .ffm__divider {
    display: flex;
    align-items: center;
    gap: 16px;
    margin: 20px 0;
  }

  .ffm__divider::before, .ffm__divider::after {
    content: '';
    flex: 1;
    height: 1px;
    background: color-mix(in srgb, var(--glass-gold) 10%, transparent);
  }

  .ffm__divider span {
    font-size: 10px;
    color: color-mix(in srgb, var(--glass-gold) 30%, transparent);
  }

  .ffm__start-btn {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    padding: 14px 28px;
    background: linear-gradient(135deg, color-mix(in srgb, var(--glass-gold) 12%, transparent) 0%, color-mix(in srgb, var(--glass-gold) 8%, transparent) 100%);
    border: 1px solid color-mix(in srgb, var(--glass-gold) 25%, transparent);
    border-radius: 10px;
    color: var(--glass-gold);
    font-size: 12px;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .ffm__start-btn:hover {
    background: color-mix(in srgb, var(--glass-gold) 18%, transparent);
    box-shadow: 0 0 30px color-mix(in srgb, var(--glass-gold) 10%, transparent);
  }

  .ffm__help-link {
    margin-top: 20px;
    text-align: center;
  }

  .ffm__help-link a {
    color: color-mix(in srgb, var(--glass-gold) 50%, transparent);
    font-size: 12px;
    text-decoration: none;
    transition: color 0.15s ease;
  }

  .ffm__help-link a:hover {
    color: var(--glass-gold);
    text-decoration: underline;
  }

  .ffm__template-name {
    display: block;
    color: white;
    font-size: 13px;
    font-weight: 500;
    margin-bottom: 2px;
  }

  .ffm__templates-header {
    font-size: 11px;
    font-weight: 600;
    color: color-mix(in srgb, var(--glass-gold) 50%, transparent);
    letter-spacing: 0.5px;
    margin-bottom: 10px;
    padding-left: 4px;
  }

  /* ═══════════════════════════════════════════════════════════════
     CANVAS
     ═══════════════════════════════════════════════════════════════ */
  .ffm__canvas {
    width: 100%;
    height: 100%;
    position: relative;
    overflow: hidden;
  }

  .ffm__grid {
    position: absolute;
    top: 0;
    left: 0;
    pointer-events: none;
  }

  .ffm__content {
    position: absolute;
    width: 2000px;
    height: 2000px;
    transform-origin: 0 0;
  }

  .ffm__connections {
    position: absolute;
    top: 0;
    left: 0;
    pointer-events: none;
    overflow: visible;
    z-index: 1;
  }

  /* ═══════════════════════════════════════════════════════════════
     NODES
     ═══════════════════════════════════════════════════════════════ */
  .ffm__node {
    position: absolute;
    z-index: 10;
    background: linear-gradient(155deg,
        color-mix(in srgb, var(--node-color) 14%, color-mix(in srgb, var(--glass-fg) 5%, transparent)) 0%,
        color-mix(in srgb, var(--glass-fg) 2%, transparent) 55%,
        color-mix(in srgb, var(--node-color) 6%, color-mix(in srgb, var(--glass-base) 8%, transparent)) 100%);
    border: 1px solid color-mix(in srgb, var(--node-color) 28%, var(--g-border, color-mix(in srgb, var(--glass-fg) 8%, transparent)));
    border-radius: 14px;
    overflow: visible;
    cursor: pointer;
    backdrop-filter: var(--g-blur, blur(14px) saturate(160%));
    -webkit-backdrop-filter: var(--g-blur, blur(14px) saturate(160%));
    box-shadow:
      0 8px 24px rgba(0,0,0,0.35),
      inset 0 1px 0 rgba(255,255,255,0.06),
      0 0 0 1px rgba(0,0,0,0.4);
    transition:
      transform 0.18s cubic-bezier(0.2, 0.8, 0.2, 1),
      box-shadow 0.25s ease,
      border-color 0.15s ease;
    isolation: isolate;
  }

  .ffm__node::before {
    /* Top edge highlight — reads as light from above */
    content: "";
    position: absolute;
    inset: 0;
    pointer-events: none;
    border-radius: inherit;
    background:
      radial-gradient(ellipse 60% 30% at 50% -10%,
        color-mix(in srgb, var(--node-color) 18%, transparent),
        transparent 60%);
    mix-blend-mode: screen;
    opacity: 0.85;
  }

  .ffm__node:hover {
    transform: translateY(-3px);
    border-color: var(--node-color);
    box-shadow:
      0 18px 48px rgba(0,0,0,0.55),
      0 0 0 1px var(--node-color),
      0 0 36px color-mix(in srgb, var(--node-color) 20%, transparent);
    z-index: 50; /* lift above siblings so the analytics card isn't clipped */
  }

  .ffm__node--selected {
    border-color: var(--node-color);
    box-shadow:
      0 0 48px color-mix(in srgb, var(--node-color) 28%, transparent),
      0 0 0 1px var(--node-color),
      inset 0 1px 0 color-mix(in srgb, var(--node-color) 30%, transparent);
  }

  .ffm__node--connectable {
    cursor: crosshair;
  }

  .ffm__node--live {
    /* Subtle pulsing aura when the integration is connected */
    animation: ffm__node-live-pulse 3.2s ease-in-out infinite;
  }
  @keyframes ffm__node-live-pulse {
    0%, 100% {
      box-shadow:
        0 8px 24px rgba(0,0,0,0.35),
        inset 0 1px 0 rgba(255,255,255,0.06),
        0 0 0 1px rgba(0,0,0,0.4),
        0 0 0 0 color-mix(in srgb, var(--node-color) 30%, transparent);
    }
    50% {
      box-shadow:
        0 8px 24px rgba(0,0,0,0.35),
        inset 0 1px 0 rgba(255,255,255,0.06),
        0 0 0 1px rgba(0,0,0,0.4),
        0 0 24px color-mix(in srgb, var(--node-color) 25%, transparent);
    }
  }

  /* ── Live badge ─────────────────────────────────────────── */
  .ffm__node-live-badge {
    position: absolute;
    top: -8px;
    right: 10px;
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 3px 8px 3px 6px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--g-bg-deep, var(--glass-3)) 70%, transparent);
    border: 1px solid var(--node-color);
    font-family: 'JetBrains Mono', monospace;
    font-size: 9px;
    letter-spacing: 1.2px;
    color: var(--node-color);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    z-index: 5;
  }
  .ffm__node-live-badge.dim {
    border-color: color-mix(in srgb, var(--glass-fg) 12%, transparent);
    color: var(--glass-fg-4);
  }
  .ffm__node-live-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
    box-shadow: 0 0 6px currentColor;
  }
  .ffm__node-live-badge.live .ffm__node-live-dot {
    animation: ffm__live-dot-pulse 1.4s ease-in-out infinite;
  }
  @keyframes ffm__live-dot-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.45; transform: scale(0.78); }
  }

  /* ── Chips row ──────────────────────────────────────────── */
  .ffm__node-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 6px 14px 0;
  }
  .ffm__node-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--node-color) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--node-color) 18%, transparent);
    color: color-mix(in srgb, var(--node-color) 85%, white);
    font-family: 'JetBrains Mono', monospace;
    font-size: 9px;
    letter-spacing: 0.6px;
    font-variant-numeric: tabular-nums;
  }
  .ffm__node-chip-icon {
    font-size: 10px;
    line-height: 1;
    opacity: 0.85;
  }
  .ffm__node-chip--items {
    background: color-mix(in srgb, var(--g-primary, var(--glass-gold)) 8%, transparent);
    border-color: color-mix(in srgb, var(--g-primary, var(--glass-gold)) 22%, transparent);
    color: var(--g-primary, var(--glass-gold));
  }
  .ffm__node-item--more {
    opacity: 0.55;
    font-style: italic;
    background: transparent !important;
  }

  /* ── Hover analytics card ───────────────────────────────── */
  .ffm__node-analytics {
    position: absolute;
    top: 0;
    left: calc(100% + 12px);
    width: 220px;
    padding: 12px 14px;
    background: linear-gradient(155deg,
        color-mix(in srgb, var(--node-color) 6%, rgba(15,15,15,0.92)) 0%,
        rgba(15,15,15,0.94) 60%,
        color-mix(in srgb, var(--glass-base) 95%, transparent) 100%);
    border: 1px solid color-mix(in srgb, var(--node-color) 30%, transparent);
    border-radius: 12px;
    pointer-events: none;
    opacity: 0;
    transform: translateX(-6px) scale(0.96);
    transition: opacity 0.2s ease, transform 0.2s ease;
    z-index: 60;
    box-shadow:
      0 18px 48px rgba(0,0,0,0.55),
      0 0 24px color-mix(in srgb, var(--node-color) 18%, transparent);
    backdrop-filter: blur(20px) saturate(160%);
    -webkit-backdrop-filter: blur(20px) saturate(160%);
    font-family: var(--g-font-family, system-ui, sans-serif);
  }
  .ffm__node:hover .ffm__node-analytics {
    opacity: 1;
    transform: translateX(0) scale(1);
    pointer-events: auto;
    transition-delay: 0.15s;
  }
  .ffm__node-analytics-header {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding-bottom: 8px;
    margin-bottom: 8px;
    border-bottom: 1px solid color-mix(in srgb, var(--node-color) 18%, transparent);
  }
  .ffm__node-analytics-title {
    font-size: 11px;
    font-weight: 700;
    color: var(--node-color);
    letter-spacing: 1.4px;
  }
  .ffm__node-analytics-kind {
    font-family: 'JetBrains Mono', monospace;
    font-size: 9px;
    color: var(--glass-fg-4);
    text-transform: uppercase;
    letter-spacing: 0.8px;
  }
  .ffm__node-analytics-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px 12px;
  }
  .ffm__node-analytics-cell {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .ffm__node-analytics-label {
    font-size: 9px;
    color: var(--glass-fg-4);
    text-transform: uppercase;
    letter-spacing: 0.8px;
  }
  .ffm__node-analytics-value {
    font-family: 'JetBrains Mono', monospace;
    font-size: 16px;
    color: white;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }
  .ffm__node-analytics-value.ok {
    color: #34d399;
    text-shadow: 0 0 12px rgba(52,211,153,0.4);
  }
  .ffm__node-analytics-value.dim {
    color: var(--glass-fg-3);
    font-size: 12px;
  }
  .ffm__node-analytics-sub {
    font-size: 10px;
    color: var(--glass-fg-4);
    margin-left: 3px;
  }
  .ffm__node-analytics-hint {
    margin-top: 8px;
    padding-top: 6px;
    border-top: 1px solid color-mix(in srgb, var(--glass-fg) 5%, transparent);
    font-size: 9px;
    color: var(--glass-fg-4);
    text-align: center;
    font-style: italic;
  }
  /* Live lead counts (when flow map bound to a funnel) */
  .ffm__node-analytics-live {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 8px;
    padding: 6px 8px;
    border-radius: 6px;
    background: color-mix(in srgb, #22c55e 14%, transparent);
    border: 1px solid color-mix(in srgb, #22c55e 32%, transparent);
  }
  .ffm__node-analytics-live-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #22c55e;
    box-shadow: 0 0 6px #22c55e;
    animation: ffm__live-dot-pulse 1.4s ease-in-out infinite;
  }
  .ffm__node-analytics-live-text {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    color: #34d399;
    letter-spacing: 0.4px;
    font-weight: 600;
  }
  .ffm__node-analytics-bar {
    display: flex;
    width: 100%;
    height: 5px;
    border-radius: 999px;
    overflow: hidden;
    background: color-mix(in srgb, var(--glass-fg) 6%, transparent);
    margin: 6px 0 4px;
  }
  .ffm__node-analytics-bar-q { background: #22c55e; }
  .ffm__node-analytics-bar-u { background: #ef4444; }
  .ffm__node-analytics-bar-p { background: var(--glass-gold); }
  .ffm__node-analytics-legend {
    display: flex;
    justify-content: space-between;
    font-family: 'JetBrains Mono', monospace;
    font-size: 9px;
    margin-bottom: 4px;
  }
  .ffm__node-analytics-legend-item.q { color: #22c55e; }
  .ffm__node-analytics-legend-item.u { color: #ef4444; }
  .ffm__node-analytics-legend-item.p { color: var(--glass-gold); }

  .ffm__node-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 16px;
    background: linear-gradient(180deg, color-mix(in srgb, var(--node-color) 6%, transparent) 0%, transparent 100%);
    border-bottom: 1px solid color-mix(in srgb, var(--glass-fg) 4%, transparent);
  }

  .ffm__node-icon {
    width: 20px;
    height: 20px;
    color: var(--node-color);
  }

  .ffm__node-icon svg {
    width: 100%;
    height: 100%;
  }

  .ffm__node-title {
    flex: 1;
    min-width: 0;
  }

  .ffm__node-name {
    display: block;
    font-size: 12px;
    font-weight: 600;
    color: white;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .ffm__node-type {
    display: block;
    font-family: 'JetBrains Mono', monospace;
    font-size: 9px;
    color: var(--glass-fg-4);
    letter-spacing: 0.5px;
  }

  .ffm__node-status {
    width: 10px;
    height: 10px;
    color: var(--glass-fg-4);
  }

  .ffm__node-status svg {
    width: 100%;
    height: 100%;
  }

  .ffm__node-status.connected {
    color: #34d399;
  }

  .ffm__node-items {
    padding: 8px 14px;
  }

  .ffm__node-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 10px;
    margin: 3px 0;
    background: color-mix(in srgb, var(--glass-fg) 2%, transparent);
    border-radius: 5px;
  }

  .ffm__node-item-dot {
    width: 6px;
    height: 6px;
    color: var(--node-color);
    opacity: 0.6;
  }

  .ffm__node-item-dot svg {
    width: 100%;
    height: 100%;
  }

  .ffm__node-item .ffm__mono {
    font-size: 10px;
    color: var(--glass-fg-2);
  }

  .ffm__node-actions {
    display: flex;
    gap: 4px;
    padding: 10px 14px;
    border-top: 1px solid color-mix(in srgb, var(--glass-fg) 4%, transparent);
    opacity: 0;
    transition: opacity 0.15s ease;
  }

  .ffm__node:hover .ffm__node-actions {
    opacity: 1;
  }

  .ffm__node-action {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 8px;
    background: color-mix(in srgb, var(--glass-gold) 4%, transparent);
    border: 1px solid color-mix(in srgb, var(--glass-gold) 10%, transparent);
    border-radius: 6px;
    color: color-mix(in srgb, var(--glass-gold) 50%, transparent);
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .ffm__node-action svg {
    width: 14px;
    height: 14px;
  }

  .ffm__node-action:hover {
    background: color-mix(in srgb, var(--glass-gold) 10%, transparent);
    color: var(--glass-gold);
  }

  .ffm__node-action--danger {
    color: rgba(255,100,100,0.4);
    border-color: rgba(255,100,100,0.1);
    background: rgba(255,100,100,0.03);
  }

  .ffm__node-action--danger:hover {
    background: rgba(255,100,100,0.1);
    color: #ff6464;
  }

  /* Connectors */
  .ffm__connector {
    position: absolute;
    width: 14px;
    height: 14px;
    background: var(--glass-3);
    border: 2px solid var(--node-color);
    border-radius: 50%;
    cursor: crosshair;
    z-index: 10;
    transition: all 0.15s ease;
    opacity: 0;
  }

  .ffm__node:hover .ffm__connector,
  .ffm__node--selected .ffm__connector {
    opacity: 1;
  }

  .ffm__connector:hover {
    transform: translateX(-50%) scale(1.3);
    background: var(--node-color);
    box-shadow: 0 0 15px var(--node-color);
  }

  .ffm__connector--top {
    top: -7px;
    left: 50%;
    transform: translateX(-50%);
  }

  .ffm__connector--bottom {
    bottom: -7px;
    left: 50%;
    transform: translateX(-50%);
  }

  /* ═══════════════════════════════════════════════════════════════
     TOOLBAR
     ═══════════════════════════════════════════════════════════════ */
  .ffm__toolbar {
    position: absolute;
    top: 20px;
    right: 20px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 12px;
    background: rgba(16,16,16,0.95);
    border: 1px solid color-mix(in srgb, var(--glass-gold) 12%, transparent);
    border-radius: 10px;
    backdrop-filter: blur(12px);
  }

  .ffm__toolbar-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    width: 34px;
    height: 34px;
    background: color-mix(in srgb, var(--glass-gold) 4%, transparent);
    border: 1px solid color-mix(in srgb, var(--glass-gold) 10%, transparent);
    border-radius: 7px;
    color: color-mix(in srgb, var(--glass-gold) 60%, transparent);
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .ffm__toolbar-btn:hover {
    background: color-mix(in srgb, var(--glass-gold) 10%, transparent);
    color: var(--glass-gold);
  }

  .ffm__toolbar-btn--primary {
    width: auto;
    padding: 0 16px;
    font-size: 11px;
    background: linear-gradient(135deg, color-mix(in srgb, var(--glass-gold) 10%, transparent) 0%, color-mix(in srgb, var(--glass-gold) 6%, transparent) 100%);
  }

  .ffm__toolbar-btn--go-live {
    width: auto;
    padding: 0 14px;
    font-size: 11px;
    background: linear-gradient(135deg,
      color-mix(in srgb, #22c55e 20%, transparent) 0%,
      color-mix(in srgb, #22c55e 8%, transparent) 100%);
    border-color: color-mix(in srgb, #22c55e 35%, transparent);
    color: #34d399;
  }
  .ffm__toolbar-btn--go-live:hover {
    background: linear-gradient(135deg,
      color-mix(in srgb, #22c55e 30%, transparent) 0%,
      color-mix(in srgb, #22c55e 14%, transparent) 100%);
    border-color: color-mix(in srgb, #22c55e 55%, transparent);
    box-shadow: 0 0 16px color-mix(in srgb, #22c55e 30%, transparent);
  }

  .ffm__toolbar-btn--live {
    width: auto;
    padding: 0 12px;
    font-size: 11px;
    background: color-mix(in srgb, #22c55e 18%, transparent);
    border-color: color-mix(in srgb, #22c55e 40%, transparent);
    color: #34d399;
    cursor: default;
  }
  .ffm__live-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #22c55e;
    box-shadow: 0 0 6px #22c55e;
    animation: ffm__live-dot-pulse 1.4s ease-in-out infinite;
    margin-right: 6px;
  }

  .ffm__toolbar-sep {
    width: 1px;
    height: 20px;
    background: color-mix(in srgb, var(--glass-gold) 12%, transparent);
    margin: 0 4px;
  }

  .ffm__zoom {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    color: var(--glass-fg-4);
    min-width: 40px;
    text-align: center;
  }

  .ffm__pan-indicator {
    position: absolute;
    top: 20px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 18px;
    background: color-mix(in srgb, var(--glass-gold) 15%, transparent);
    border: 1px solid color-mix(in srgb, var(--glass-gold) 40%, transparent);
    border-radius: 8px;
    color: var(--glass-gold);
    font-size: 11px;
    backdrop-filter: blur(10px);
    z-index: 50;
    animation: pulse-pan 1s ease infinite;
  }

  .ffm__pan-indicator .ffm__icon {
    width: 16px;
    height: 16px;
  }

  @keyframes pulse-pan {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.7; }
  }

  /* ═══════════════════════════════════════════════════════════════
     MODALS
     ═══════════════════════════════════════════════════════════════ */
  .ffm__overlay {
    position: absolute;
    inset: 0;
    background: color-mix(in srgb, var(--g-bg-deep, var(--glass-3)) 75%, transparent);
    backdrop-filter: blur(14px) saturate(140%);
    -webkit-backdrop-filter: blur(14px) saturate(140%);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
    animation: ffm__overlay-fade 0.2s ease;
  }
  @keyframes ffm__overlay-fade {
    from { opacity: 0; }
    to   { opacity: 1; }
  }

  .ffm__modal {
    width: 580px;
    max-width: 95vw;
    max-height: 85vh;
    background: linear-gradient(155deg,
        color-mix(in srgb, var(--g-primary, var(--glass-gold)) 4%, rgba(15,15,15,0.95)) 0%,
        rgba(15,15,15,0.96) 60%,
        color-mix(in srgb, var(--glass-base) 96%, transparent) 100%);
    border: 1px solid color-mix(in srgb, var(--g-primary, var(--glass-gold)) 25%, transparent);
    border-radius: var(--g-radius-lg, 16px);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    box-shadow:
      0 24px 80px rgba(0,0,0,0.7),
      0 0 0 1px rgba(0,0,0,0.4),
      inset 0 1px 0 rgba(255,255,255,0.06);
    animation: ffm__modal-pop 0.25s cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  @keyframes ffm__modal-pop {
    from { opacity: 0; transform: translateY(8px) scale(0.96); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
  }
  .ffm__modal--addnode {
    width: 640px;
  }

  .ffm__modal-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    padding: 20px 24px 16px;
    border-bottom: 1px solid color-mix(in srgb, var(--g-primary, var(--glass-gold)) 12%, transparent);
    gap: 12px;
  }

  .ffm__add-title-block {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .ffm__add-title-block .ffm__modal-hint {
    margin: 0;
    font-size: 11px;
    color: var(--glass-fg-3);
    letter-spacing: 0;
  }

  .ffm__modal-header h3 {
    margin: 0;
    font-size: 18px;
    font-weight: 700;
    color: var(--g-primary, var(--glass-gold));
    letter-spacing: 0.5px;
  }

  /* ── Search bar ─────────────────────────────────────────── */
  .ffm__add-search {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 24px;
    border-bottom: 1px solid color-mix(in srgb, var(--glass-fg) 6%, transparent);
  }
  .ffm__add-search-icon {
    font-size: 13px;
    opacity: 0.5;
  }
  .ffm__add-search-input {
    flex: 1;
    background: color-mix(in srgb, var(--glass-fg) 4%, transparent);
    border: 1px solid color-mix(in srgb, var(--glass-fg) 10%, transparent);
    border-radius: 8px;
    padding: 10px 12px;
    color: white;
    font-size: 13px;
    font-family: inherit;
    outline: none;
    transition: border-color 0.15s ease, background 0.15s ease;
  }
  .ffm__add-search-input::placeholder {
    color: var(--glass-fg-4);
  }
  .ffm__add-search-input:focus {
    border-color: color-mix(in srgb, var(--g-primary, var(--glass-gold)) 50%, transparent);
    background: color-mix(in srgb, var(--glass-fg) 6%, transparent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--g-primary, var(--glass-gold)) 12%, transparent);
  }
  .ffm__add-search-clear {
    position: absolute;
    right: 28px;
    top: 50%;
    transform: translateY(-50%);
    background: transparent;
    border: none;
    color: var(--glass-fg-3);
    font-size: 18px;
    cursor: pointer;
    padding: 0 8px;
    line-height: 1;
  }
  .ffm__add-search-clear:hover {
    color: white;
  }

  /* ── Body sections ──────────────────────────────────────── */
  .ffm__add-body {
    padding: 16px 24px 8px;
    display: flex;
    flex-direction: column;
    gap: 18px;
    overflow-y: auto;
    flex: 1;
    min-height: 0;
  }
  .ffm__add-section {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .ffm__add-section-header {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 1.4px;
    color: var(--glass-fg-3);
    padding-bottom: 4px;
    border-bottom: 1px dashed color-mix(in srgb, var(--glass-fg) 6%, transparent);
  }
  .ffm__add-section-emoji {
    font-size: 14px;
  }
  .ffm__add-section-label {
    flex: 1;
    color: var(--glass-fg-2);
    font-weight: 600;
  }
  .ffm__add-section-count {
    color: var(--glass-fg-4);
    font-size: 10px;
    background: color-mix(in srgb, var(--glass-fg) 5%, transparent);
    padding: 1px 7px;
    border-radius: 999px;
  }
  .ffm__add-back {
    background: transparent;
    border: 1px solid color-mix(in srgb, var(--glass-fg) 10%, transparent);
    color: var(--glass-fg-3);
    padding: 3px 10px;
    border-radius: 999px;
    font-size: 10px;
    cursor: pointer;
    font-family: inherit;
    text-transform: none;
    letter-spacing: 0.3px;
  }
  .ffm__add-back:hover {
    border-color: var(--g-primary, var(--glass-gold));
    color: var(--g-primary, var(--glass-gold));
  }
  .ffm__add-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .ffm__add-grid--recents {
    grid-template-columns: repeat(auto-fit, minmax(100px, 1fr));
  }
  .ffm__add-grid--platforms {
    grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
  }

  .ffm__add-card {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    background: linear-gradient(135deg,
        color-mix(in srgb, var(--glass-fg) 4%, transparent) 0%,
        color-mix(in srgb, var(--glass-fg) 2%, transparent) 100%);
    border: 1px solid color-mix(in srgb, var(--glass-fg) 8%, transparent);
    border-radius: 10px;
    text-align: left;
    cursor: pointer;
    transition:
      transform 0.12s cubic-bezier(0.2, 0.8, 0.2, 1),
      border-color 0.15s ease,
      background 0.15s ease,
      box-shadow 0.2s ease;
    font-family: inherit;
    color: var(--glass-fg);
  }
  .ffm__add-card:hover,
  .ffm__add-card.focused {
    border-color: color-mix(in srgb, var(--g-primary, var(--glass-gold)) 45%, transparent);
    background: linear-gradient(135deg,
        color-mix(in srgb, var(--g-primary, var(--glass-gold)) 10%, transparent) 0%,
        color-mix(in srgb, var(--glass-fg) 2%, transparent) 100%);
    transform: translateY(-1px);
    box-shadow: 0 8px 20px rgba(0,0,0,0.3),
      0 0 0 1px color-mix(in srgb, var(--g-primary, var(--glass-gold)) 25%, transparent);
  }
  .ffm__add-card.selected {
    border-color: var(--g-primary, var(--glass-gold));
    background: color-mix(in srgb, var(--g-primary, var(--glass-gold)) 12%, transparent);
  }
  .ffm__add-card-icon {
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--g-primary, var(--glass-gold));
    flex-shrink: 0;
  }
  .ffm__add-card-emoji {
    width: 28px;
    height: 28px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 18px;
    line-height: 1;
    border-radius: 8px;
    background: color-mix(in srgb, var(--node-color, var(--g-primary, var(--glass-gold))) 18%, color-mix(in srgb, var(--glass-base) 40%, transparent));
    border: 1px solid color-mix(in srgb, var(--node-color, var(--g-primary, var(--glass-gold))) 35%, transparent);
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.05);
  }
  /* Per-block left accent stripe driven by --node-color set on the card */
  .ffm__add-card {
    position: relative;
  }
  .ffm__add-card::before {
    content: "";
    position: absolute;
    left: 0;
    top: 14px;
    bottom: 14px;
    width: 2px;
    border-radius: 2px;
    background: color-mix(in srgb, var(--node-color, transparent) 70%, transparent);
    opacity: 0.5;
    transition: opacity 0.15s ease;
  }
  .ffm__add-card:hover::before,
  .ffm__add-card.focused::before {
    opacity: 1;
  }
  .ffm__add-card-icon svg {
    width: 100%;
    height: 100%;
  }
  .ffm__add-card-body {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .ffm__add-card-label {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: white;
    letter-spacing: 0.4px;
  }
  .ffm__add-card-desc {
    font-size: 11px;
    color: var(--glass-fg-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ffm__add-card-arrow {
    color: var(--glass-fg-3);
    font-size: 14px;
  }
  .ffm__add-card:hover .ffm__add-card-arrow,
  .ffm__add-card.focused .ffm__add-card-arrow {
    color: var(--g-primary, var(--glass-gold));
    transform: translateX(2px);
  }
  .ffm__add-card--compact {
    padding: 8px 10px;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
  }
  .ffm__add-card--compact .ffm__add-card-icon {
    width: 18px;
    height: 18px;
  }
  .ffm__add-card--platform {
    flex-direction: column;
    align-items: center;
    padding: 14px 8px;
    gap: 8px;
    text-align: center;
  }

  .ffm__add-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 32px 16px;
    border: 1px dashed color-mix(in srgb, var(--glass-fg) 10%, transparent);
    border-radius: 10px;
    color: var(--glass-fg-3);
    font-size: 12px;
  }
  .ffm__add-empty-emoji {
    font-size: 28px;
    margin-bottom: 4px;
  }
  .ffm__add-empty-clear {
    margin-top: 4px;
    padding: 6px 14px;
    border: 1px solid color-mix(in srgb, var(--g-primary, var(--glass-gold)) 25%, transparent);
    border-radius: 999px;
    background: transparent;
    color: var(--g-primary, var(--glass-gold));
    cursor: pointer;
    font-family: inherit;
    font-size: 11px;
  }
  .ffm__add-empty-clear:hover {
    background: color-mix(in srgb, var(--g-primary, var(--glass-gold)) 10%, transparent);
  }

  .ffm__add-footer {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 12px 24px;
    border-top: 1px solid color-mix(in srgb, var(--glass-fg) 6%, transparent);
    background: color-mix(in srgb, var(--glass-base) 30%, transparent);
  }
  .ffm__add-kbd-hint {
    font-size: 10px;
    color: var(--glass-fg-3);
    display: flex;
    align-items: center;
    gap: 4px;
    letter-spacing: 0.4px;
  }
  .ffm__add-kbd-hint kbd {
    display: inline-block;
    padding: 1px 6px;
    background: color-mix(in srgb, var(--glass-fg) 6%, transparent);
    border: 1px solid color-mix(in srgb, var(--glass-fg) 10%, transparent);
    border-bottom-width: 2px;
    border-radius: 4px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    color: var(--glass-fg-2);
    margin: 0 2px;
  }

  .ffm__modal-close {
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 1px solid rgba(255,100,100,0.15);
    border-radius: 6px;
    color: rgba(255,100,100,0.5);
    cursor: pointer;
  }

  .ffm__modal-close svg {
    width: 14px;
    height: 14px;
  }

  .ffm__modal-close:hover {
    background: rgba(255,100,100,0.08);
    color: #ff6464;
  }

  .ffm__modal-body {
    padding: 22px;
    overflow-y: auto;
  }

  .ffm__modal-hint {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    color: color-mix(in srgb, var(--glass-gold) 35%, transparent);
    margin: 0 0 16px;
  }

  .ffm__type-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }

  .ffm__type-btn {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 16px;
    background: color-mix(in srgb, var(--glass-gold) 2%, transparent);
    border: 1px solid color-mix(in srgb, var(--glass-gold) 8%, transparent);
    border-radius: 10px;
    text-align: left;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .ffm__type-btn:hover {
    background: color-mix(in srgb, var(--glass-gold) 6%, transparent);
    border-color: color-mix(in srgb, var(--glass-gold) 20%, transparent);
  }

  .ffm__type-btn.selected {
    background: color-mix(in srgb, var(--glass-gold) 10%, transparent);
    border-color: color-mix(in srgb, var(--glass-gold) 30%, transparent);
  }

  .ffm__type-icon {
    width: 22px;
    height: 22px;
    color: color-mix(in srgb, var(--glass-gold) 60%, transparent);
  }

  .ffm__type-icon svg {
    width: 100%;
    height: 100%;
  }

  .ffm__type-info .ffm__mono {
    display: block;
    color: white;
    font-size: 11px;
    margin-bottom: 2px;
  }

  .ffm__type-desc {
    font-size: 10px;
    color: var(--glass-fg-4);
  }

  .ffm__platform-section {
    margin-top: 20px;
    padding-top: 20px;
    border-top: 1px solid color-mix(in srgb, var(--glass-gold) 8%, transparent);
  }

  .ffm__platform-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
  }

  .ffm__platform-btn {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 16px 12px;
    background: color-mix(in srgb, var(--glass-fg) 2%, transparent);
    border: 1px solid color-mix(in srgb, var(--glass-fg) 6%, transparent);
    border-radius: 10px;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .ffm__platform-btn:hover {
    background: color-mix(in srgb, var(--glass-gold) 6%, transparent);
    border-color: color-mix(in srgb, var(--glass-gold) 20%, transparent);
  }

  .ffm__platform-icon {
    width: 24px;
    height: 24px;
    color: var(--glass-fg-2);
  }

  .ffm__platform-icon svg {
    width: 100%;
    height: 100%;
  }

  .ffm__platform-btn .ffm__mono {
    font-size: 9px;
    color: var(--glass-fg-3);
  }

  /* ═══════════════════════════════════════════════════════════════
     CONFIG PANEL (Single Page Node Configuration)
     ═══════════════════════════════════════════════════════════════ */
  .ffm__config-panel {
    width: 640px;
    max-width: 95vw;
    max-height: 90vh;
    background: var(--glass-3);
    border: 1px solid color-mix(in srgb, var(--glass-gold) 20%, transparent);
    border-radius: 16px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    box-shadow: 0 25px 80px rgba(0,0,0,0.6);
  }

  .ffm__config-header {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 20px 24px;
    background: linear-gradient(180deg, color-mix(in srgb, var(--glass-gold) 4%, transparent) 0%, transparent 100%);
    border-bottom: 1px solid color-mix(in srgb, var(--glass-gold) 10%, transparent);
  }

  .ffm__config-icon {
    width: 36px;
    height: 36px;
    color: var(--glass-gold);
    padding: 8px;
    background: color-mix(in srgb, var(--glass-gold) 10%, transparent);
    border-radius: 10px;
  }

  .ffm__config-icon svg {
    width: 100%;
    height: 100%;
  }

  .ffm__config-title {
    flex: 1;
  }

  .ffm__config-name {
    display: block;
    width: 100%;
    background: transparent;
    border: none;
    font-family: 'JetBrains Mono', monospace;
    font-size: 16px;
    font-weight: 600;
    color: white;
    padding: 0;
    margin-bottom: 4px;
  }

  .ffm__config-name:focus {
    outline: none;
    border-bottom: 1px solid color-mix(in srgb, var(--glass-gold) 30%, transparent);
  }

  .ffm__config-type {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    color: color-mix(in srgb, var(--glass-gold) 50%, transparent);
    letter-spacing: 0.5px;
  }

  .ffm__config-status {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    background: rgba(255,100,100,0.1);
    border: 1px solid rgba(255,100,100,0.2);
    border-radius: 6px;
    color: rgba(255,100,100,0.7);
    font-size: 9px;
  }

  .ffm__config-status svg {
    width: 10px;
    height: 10px;
  }

  .ffm__config-status.connected {
    background: rgba(52,211,153,0.1);
    border-color: rgba(52,211,153,0.2);
    color: #34d399;
  }

  .ffm__config-tabs {
    display: flex;
    gap: 4px;
    padding: 12px 24px;
    border-bottom: 1px solid color-mix(in srgb, var(--glass-gold) 8%, transparent);
    background: color-mix(in srgb, var(--glass-base) 30%, transparent);
  }

  .ffm__config-tab {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 18px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 8px;
    color: var(--glass-fg-3);
    font-size: 11px;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .ffm__config-tab svg {
    width: 14px;
    height: 14px;
  }

  .ffm__config-tab:hover {
    color: var(--glass-fg-2);
    background: color-mix(in srgb, var(--glass-gold) 3%, transparent);
  }

  .ffm__config-tab.active {
    background: color-mix(in srgb, var(--glass-gold) 10%, transparent);
    border-color: color-mix(in srgb, var(--glass-gold) 20%, transparent);
    color: var(--glass-gold);
  }

  .ffm__config-body {
    flex: 1;
    overflow-y: auto;
    padding: 24px;
  }

  .ffm__config-section {
    display: flex;
    flex-direction: column;
    gap: 20px;
  }

  .ffm__section-desc {
    margin: 0;
    color: var(--glass-fg-3);
    font-size: 13px;
  }

  .ffm__section-header {
    font-size: 10px;
    color: color-mix(in srgb, var(--glass-gold) 40%, transparent);
    margin: 16px 0 8px;
  }

  /* Platform Features */
  .ffm__platform-features {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .ffm__platform-feature {
    background: color-mix(in srgb, var(--glass-fg) 2%, transparent);
    border: 1px solid color-mix(in srgb, var(--glass-fg) 6%, transparent);
    border-radius: 12px;
    overflow: hidden;
    transition: all 0.15s ease;
  }

  .ffm__platform-feature.enabled {
    background: color-mix(in srgb, var(--glass-gold) 4%, transparent);
    border-color: color-mix(in srgb, var(--glass-gold) 15%, transparent);
  }

  .ffm__pf-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 16px;
    cursor: pointer;
    transition: background 0.15s ease;
  }

  .ffm__pf-header:hover {
    background: color-mix(in srgb, var(--glass-gold) 3%, transparent);
  }

  .ffm__pf-icon {
    width: 20px;
    height: 20px;
    color: color-mix(in srgb, var(--glass-gold) 50%, transparent);
  }

  .ffm__pf-icon svg {
    width: 100%;
    height: 100%;
  }

  .ffm__platform-feature.enabled .ffm__pf-icon {
    color: var(--glass-gold);
  }

  .ffm__pf-info {
    flex: 1;
  }

  .ffm__pf-info .ffm__mono {
    display: block;
    font-size: 11px;
    color: white;
    margin-bottom: 2px;
  }

  .ffm__pf-desc {
    font-size: 10px;
    color: var(--glass-fg-3);
  }

  .ffm__pf-toggle {
    width: 36px;
    height: 20px;
    background: color-mix(in srgb, var(--glass-fg) 10%, transparent);
    border-radius: 10px;
    position: relative;
    transition: all 0.15s ease;
  }

  .ffm__pf-toggle::after {
    content: '';
    position: absolute;
    left: 3px;
    top: 3px;
    width: 14px;
    height: 14px;
    background: color-mix(in srgb, var(--glass-fg) 30%, transparent);
    border-radius: 50%;
    transition: all 0.15s ease;
  }

  .ffm__pf-toggle.on {
    background: color-mix(in srgb, var(--glass-gold) 30%, transparent);
  }

  .ffm__pf-toggle.on::after {
    left: 19px;
    background: var(--glass-gold);
  }

  .ffm__pf-badge {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 16px;
    background: color-mix(in srgb, var(--glass-gold-hi) 10%, transparent);
    border-top: 1px solid color-mix(in srgb, var(--glass-gold-hi) 15%, transparent);
    font-size: 9px;
    color: var(--glass-gold-hi);
  }

  .ffm__pf-badge svg {
    width: 12px;
    height: 12px;
  }

  .ffm__pf-config {
    padding: 12px 16px;
    background: color-mix(in srgb, var(--glass-base) 20%, transparent);
    border-top: 1px solid color-mix(in srgb, var(--glass-gold) 8%, transparent);
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .ffm__pf-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .ffm__pf-field label {
    font-size: 9px;
    color: color-mix(in srgb, var(--glass-gold) 40%, transparent);
  }

  .ffm__pf-field .ffm__input {
    padding: 10px 12px;
    font-size: 12px;
  }

  .ffm__pf-hint {
    font-size: 10px;
    color: var(--glass-fg-4);
    margin-top: 2px;
  }

  .ffm__required {
    color: #ef4444;
    margin-left: 2px;
  }

  .ffm__pf-sections {
    padding: 0 !important;
    gap: 0 !important;
  }

  .ffm__pf-section {
    border-top: 1px solid color-mix(in srgb, var(--glass-gold) 8%, transparent);
  }

  .ffm__pf-section:first-child {
    border-top: none;
  }

  .ffm__pf-section-title {
    padding: 12px 16px 8px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 9px;
    font-weight: 600;
    color: color-mix(in srgb, var(--glass-gold) 60%, transparent);
    letter-spacing: 0.5px;
    background: color-mix(in srgb, var(--glass-gold) 3%, transparent);
  }

  .ffm__pf-section-fields {
    padding: 8px 16px 16px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .ffm__pf-field--checkbox {
    flex-direction: row !important;
    align-items: flex-start !important;
    gap: 0 !important;
  }

  .ffm__checkbox-label {
    display: flex;
    align-items: center;
    gap: 10px;
    cursor: pointer;
    flex: 1;
  }

  .ffm__checkbox-input {
    display: none;
  }

  .ffm__checkbox-box {
    width: 18px;
    height: 18px;
    border: 2px solid color-mix(in srgb, var(--glass-gold) 30%, transparent);
    border-radius: 4px;
    position: relative;
    transition: all 0.15s ease;
    flex-shrink: 0;
  }

  .ffm__checkbox-input:checked + .ffm__checkbox-box {
    background: var(--glass-gold);
    border-color: var(--glass-gold);
  }

  .ffm__checkbox-input:checked + .ffm__checkbox-box::after {
    content: '';
    position: absolute;
    left: 5px;
    top: 2px;
    width: 5px;
    height: 9px;
    border: solid var(--glass-stroke);
    border-width: 0 2px 2px 0;
    transform: rotate(45deg);
  }

  .ffm__checkbox-label .ffm__mono {
    font-size: 11px;
    color: var(--glass-fg-2);
  }

  .ffm__pf-field--checkbox .ffm__pf-hint {
    margin-left: 28px;
    margin-top: 4px;
  }

  .ffm__select {
    padding: 10px 12px;
    background: color-mix(in srgb, var(--glass-base) 30%, transparent);
    border: 1px solid color-mix(in srgb, var(--glass-fg) 10%, transparent);
    border-radius: 8px;
    color: white;
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    cursor: pointer;
    appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23ffc800' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 12px center;
    padding-right: 36px;
  }

  .ffm__select:focus {
    outline: none;
    border-color: color-mix(in srgb, var(--glass-gold) 40%, transparent);
  }

  .ffm__textarea {
    padding: 10px 12px;
    background: color-mix(in srgb, var(--glass-base) 30%, transparent);
    border: 1px solid color-mix(in srgb, var(--glass-fg) 10%, transparent);
    border-radius: 8px;
    color: white;
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    min-height: 80px;
    resize: vertical;
  }

  .ffm__textarea:focus {
    outline: none;
    border-color: color-mix(in srgb, var(--glass-gold) 40%, transparent);
  }

  .ffm__features-config {
    max-height: 500px;
    overflow-y: auto;
  }

  .ffm__custom-features {
    margin-top: 16px;
    padding-top: 16px;
    border-top: 1px solid color-mix(in srgb, var(--glass-gold) 8%, transparent);
  }

  .ffm__config-footer {
    display: flex;
    justify-content: space-between;
    padding: 18px 24px;
    border-top: 1px solid color-mix(in srgb, var(--glass-gold) 10%, transparent);
    background: color-mix(in srgb, var(--glass-base) 30%, transparent);
  }

  /* API Config Specific */
  .ffm__integration-grid {
    display: flex;
    gap: 8px;
  }

  .ffm__integration-opt {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 14px 12px;
    background: color-mix(in srgb, var(--glass-fg) 2%, transparent);
    border: 1px solid color-mix(in srgb, var(--glass-fg) 8%, transparent);
    border-radius: 10px;
    color: var(--glass-fg-3);
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .ffm__integration-opt svg {
    width: 20px;
    height: 20px;
  }

  .ffm__integration-opt:hover {
    background: color-mix(in srgb, var(--glass-gold) 5%, transparent);
    border-color: color-mix(in srgb, var(--glass-gold) 15%, transparent);
  }

  .ffm__integration-opt.selected {
    background: color-mix(in srgb, var(--glass-gold) 10%, transparent);
    border-color: color-mix(in srgb, var(--glass-gold) 30%, transparent);
    color: var(--glass-gold);
  }

  .ffm__api-section {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 20px;
    background: color-mix(in srgb, var(--glass-gold) 2%, transparent);
    border: 1px solid color-mix(in srgb, var(--glass-gold) 8%, transparent);
    border-radius: 12px;
  }

  .ffm__webhook-field {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 14px;
    background: color-mix(in srgb, var(--glass-base) 40%, transparent);
    border-radius: 8px;
  }

  .ffm__webhook-field code {
    flex: 1;
    font-size: 11px;
    color: color-mix(in srgb, var(--glass-gold) 70%, transparent);
    word-break: break-all;
  }

  .ffm__test-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 12px 20px;
    background: rgba(52,211,153,0.1);
    border: 1px solid rgba(52,211,153,0.2);
    border-radius: 8px;
    color: #34d399;
    font-size: 11px;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .ffm__test-btn svg {
    width: 14px;
    height: 14px;
  }

  .ffm__test-btn:hover {
    background: rgba(52,211,153,0.15);
  }

  .ffm__manual-note {
    padding: 16px;
    background: color-mix(in srgb, var(--glass-fg) 2%, transparent);
    border-radius: 10px;
    color: var(--glass-fg-3);
    font-size: 13px;
  }

  .ffm__manual-note .ffm__mono {
    color: color-mix(in srgb, var(--glass-gold) 40%, transparent);
    font-size: 11px;
    margin-top: 8px;
  }

  .ffm__connection-status {
    padding: 16px;
    background: color-mix(in srgb, var(--glass-base) 30%, transparent);
    border-radius: 10px;
  }

  .ffm__status-row {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 8px;
    font-size: 12px;
    color: var(--glass-fg-3);
  }

  .ffm__status-row:last-child {
    margin-bottom: 0;
  }

  .ffm__status-badge {
    padding: 4px 10px;
    border-radius: 4px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
  }

  .ffm__status-badge.connected {
    background: rgba(52,211,153,0.15);
    color: #34d399;
  }

  .ffm__status-badge.disconnected {
    background: rgba(255,100,100,0.15);
    color: rgba(255,100,100,0.7);
  }

  .ffm__btn--danger {
    background: rgba(255,100,100,0.1);
    border: 1px solid rgba(255,100,100,0.2);
    color: rgba(255,100,100,0.7);
  }

  .ffm__btn--danger:hover {
    background: rgba(255,100,100,0.15);
    color: #ff6464;
  }

  .ffm__field {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .ffm__field label {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    color: color-mix(in srgb, var(--glass-gold) 40%, transparent);
    letter-spacing: 0.5px;
  }

  .ffm__input, .ffm__textarea {
    padding: 12px 14px;
    background: color-mix(in srgb, var(--glass-fg) 3%, transparent);
    border: 1px solid color-mix(in srgb, var(--glass-gold) 10%, transparent);
    border-radius: 8px;
    color: white;
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
  }

  .ffm__input:focus, .ffm__textarea:focus {
    outline: none;
    border-color: color-mix(in srgb, var(--glass-gold) 30%, transparent);
    background: color-mix(in srgb, var(--glass-gold) 2%, transparent);
  }

  .ffm__textarea {
    resize: vertical;
    font-family: -apple-system, BlinkMacSystemFont, sans-serif;
  }

  .ffm__field-row {
    display: flex;
    gap: 14px;
  }

  .ffm__field-row .ffm__field {
    flex: 1;
  }

  .ffm__hint {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    color: var(--glass-fg-4);
    margin: 0;
  }

  .ffm__features {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .ffm__feature {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    background: color-mix(in srgb, var(--glass-fg) 2%, transparent);
    border: 1px solid color-mix(in srgb, var(--glass-fg) 5%, transparent);
    border-radius: 8px;
  }

  .ffm__checkbox {
    width: 16px;
    height: 16px;
    accent-color: var(--glass-gold);
  }

  .ffm__feature-input {
    flex: 1;
    padding: 6px 10px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 5px;
    color: white;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
  }

  .ffm__feature-input:focus {
    background: color-mix(in srgb, var(--glass-gold) 3%, transparent);
    border-color: color-mix(in srgb, var(--glass-gold) 12%, transparent);
    outline: none;
  }

  .ffm__feature-del {
    width: 22px;
    height: 22px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: none;
    color: rgba(255,100,100,0.35);
    cursor: pointer;
    border-radius: 4px;
  }

  .ffm__feature-del svg {
    width: 12px;
    height: 12px;
  }

  .ffm__feature-del:hover {
    background: rgba(255,100,100,0.08);
    color: #ff6464;
  }

  .ffm__add-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 10px 18px;
    background: color-mix(in srgb, var(--glass-gold) 4%, transparent);
    border: 1px dashed color-mix(in srgb, var(--glass-gold) 18%, transparent);
    border-radius: 8px;
    color: color-mix(in srgb, var(--glass-gold) 60%, transparent);
    font-size: 11px;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .ffm__add-btn svg {
    width: 14px;
    height: 14px;
  }

  .ffm__add-btn:hover {
    background: color-mix(in srgb, var(--glass-gold) 8%, transparent);
    color: var(--glass-gold);
  }

  .ffm__integrations {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-bottom: 16px;
  }

  .ffm__integration {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 16px 18px;
    background: color-mix(in srgb, var(--glass-fg) 2%, transparent);
    border: 1px solid color-mix(in srgb, var(--glass-fg) 6%, transparent);
    border-radius: 10px;
    text-align: left;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .ffm__integration:hover {
    background: color-mix(in srgb, var(--glass-gold) 4%, transparent);
    border-color: color-mix(in srgb, var(--glass-gold) 12%, transparent);
  }

  .ffm__integration.selected {
    background: color-mix(in srgb, var(--glass-gold) 8%, transparent);
    border-color: color-mix(in srgb, var(--glass-gold) 25%, transparent);
  }

  .ffm__integration-icon {
    width: 22px;
    height: 22px;
    color: color-mix(in srgb, var(--glass-gold) 50%, transparent);
  }

  .ffm__integration-icon svg {
    width: 100%;
    height: 100%;
  }

  .ffm__integration .ffm__mono {
    display: block;
    color: white;
    font-size: 11px;
    margin-bottom: 2px;
  }

  .ffm__integration-desc {
    font-size: 10px;
    color: var(--glass-fg-4);
  }

  .ffm__webhook {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 14px;
    background: color-mix(in srgb, var(--glass-base) 30%, transparent);
    border-radius: 8px;
  }

  .ffm__webhook code {
    flex: 1;
    font-size: 10px;
    color: color-mix(in srgb, var(--glass-gold) 70%, transparent);
    word-break: break-all;
  }

  .ffm__copy-btn {
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: color-mix(in srgb, var(--glass-gold) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--glass-gold) 15%, transparent);
    border-radius: 6px;
    color: color-mix(in srgb, var(--glass-gold) 60%, transparent);
    cursor: pointer;
  }

  .ffm__copy-btn svg {
    width: 14px;
    height: 14px;
  }

  .ffm__copy-btn:hover {
    background: color-mix(in srgb, var(--glass-gold) 15%, transparent);
    color: var(--glass-gold);
  }

  .ffm__ai-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    width: 100%;
    padding: 14px 20px;
    margin-top: 8px;
    background: linear-gradient(135deg, color-mix(in srgb, var(--glass-gold) 8%, transparent) 0%, color-mix(in srgb, var(--glass-gold) 4%, transparent) 100%);
    border: 1px solid color-mix(in srgb, var(--glass-gold) 18%, transparent);
    border-radius: 10px;
    color: var(--glass-gold);
    font-size: 11px;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .ffm__ai-btn svg {
    width: 16px;
    height: 16px;
  }

  .ffm__ai-btn:hover {
    background: color-mix(in srgb, var(--glass-gold) 12%, transparent);
    box-shadow: 0 0 25px color-mix(in srgb, var(--glass-gold) 8%, transparent);
  }

  .ffm__wizard-footer {
    display: flex;
    justify-content: space-between;
    padding: 18px 24px;
    border-top: 1px solid color-mix(in srgb, var(--glass-gold) 8%, transparent);
    background: color-mix(in srgb, var(--glass-base) 20%, transparent);
  }

  .ffm__btn {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 22px;
    border-radius: 8px;
    font-size: 11px;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .ffm__btn svg {
    width: 14px;
    height: 14px;
  }

  .ffm__btn--primary {
    background: linear-gradient(135deg, color-mix(in srgb, var(--glass-gold) 12%, transparent) 0%, color-mix(in srgb, var(--glass-gold) 8%, transparent) 100%);
    border: 1px solid color-mix(in srgb, var(--glass-gold) 25%, transparent);
    color: var(--glass-gold);
  }

  .ffm__btn--primary:hover {
    background: color-mix(in srgb, var(--glass-gold) 18%, transparent);
    box-shadow: 0 0 20px color-mix(in srgb, var(--glass-gold) 10%, transparent);
  }

  .ffm__btn--secondary {
    background: transparent;
    border: 1px solid color-mix(in srgb, var(--glass-fg) 8%, transparent);
    color: var(--glass-fg-3);
  }

  .ffm__btn--secondary:hover {
    background: color-mix(in srgb, var(--glass-fg) 4%, transparent);
    color: white;
  }

  /* ═══════════════════════════════════════════════════════════════
     PAGE LINK CONFIG
     ═══════════════════════════════════════════════════════════════ */

  .ffm__section-title {
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    font-weight: 600;
    color: var(--glass-gold);
    margin-bottom: 8px;
  }

  .ffm__section-desc {
    font-size: 12px;
    color: var(--glass-fg-3);
    margin: 0 0 20px 0;
  }

  .ffm__link-type-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 10px;
  }

  .ffm__link-type-btn {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 16px 12px;
    background: color-mix(in srgb, var(--glass-fg) 2%, transparent);
    border: 1px solid color-mix(in srgb, var(--glass-fg) 8%, transparent);
    border-radius: 10px;
    cursor: pointer;
    transition: all 0.15s ease;
    text-align: center;
  }

  .ffm__link-type-btn svg {
    width: 24px;
    height: 24px;
    color: var(--glass-fg-3);
  }

  .ffm__link-type-btn span {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    color: white;
  }

  .ffm__link-type-btn small {
    font-size: 9px;
    color: var(--glass-fg-4);
  }

  .ffm__link-type-btn:hover {
    background: color-mix(in srgb, var(--glass-gold) 4%, transparent);
    border-color: color-mix(in srgb, var(--glass-gold) 15%, transparent);
  }

  .ffm__link-type-btn.selected {
    background: color-mix(in srgb, var(--glass-gold) 8%, transparent);
    border-color: color-mix(in srgb, var(--glass-gold) 30%, transparent);
  }

  .ffm__link-type-btn.selected svg {
    color: var(--glass-gold);
  }

  .ffm__input-with-btn {
    display: flex;
    gap: 8px;
  }

  .ffm__input-with-btn .ffm__input {
    flex: 1;
  }

  .ffm__icon-btn {
    width: 44px;
    height: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: color-mix(in srgb, var(--glass-gold) 6%, transparent);
    border: 1px solid color-mix(in srgb, var(--glass-gold) 15%, transparent);
    border-radius: 8px;
    color: color-mix(in srgb, var(--glass-gold) 60%, transparent);
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .ffm__icon-btn svg {
    width: 18px;
    height: 18px;
  }

  .ffm__icon-btn:hover {
    background: color-mix(in srgb, var(--glass-gold) 12%, transparent);
    color: var(--glass-gold);
  }

  .ffm__page-actions {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 10px;
    margin-top: 20px;
  }

  .ffm__action-card {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 16px;
    background: color-mix(in srgb, var(--glass-gold) 3%, transparent);
    border: 1px solid color-mix(in srgb, var(--glass-gold) 10%, transparent);
    border-radius: 10px;
    cursor: pointer;
    transition: all 0.15s ease;
    text-align: left;
  }

  .ffm__action-card:hover {
    background: color-mix(in srgb, var(--glass-gold) 8%, transparent);
    border-color: color-mix(in srgb, var(--glass-gold) 25%, transparent);
    transform: translateY(-2px);
  }

  .ffm__action-card--secondary {
    background: color-mix(in srgb, var(--glass-fg) 2%, transparent);
    border-color: color-mix(in srgb, var(--glass-fg) 6%, transparent);
  }

  .ffm__action-card--secondary:hover {
    background: color-mix(in srgb, var(--glass-fg) 5%, transparent);
    border-color: color-mix(in srgb, var(--glass-fg) 12%, transparent);
  }

  .ffm__action-icon {
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: color-mix(in srgb, var(--glass-gold) 10%, transparent);
    border-radius: 8px;
    color: var(--glass-gold);
  }

  .ffm__action-icon svg {
    width: 18px;
    height: 18px;
  }

  .ffm__action-info {
    flex: 1;
  }

  .ffm__action-info span {
    display: block;
    font-size: 11px;
    color: white;
    margin-bottom: 2px;
  }

  .ffm__action-info small {
    font-size: 10px;
    color: var(--glass-fg-3);
  }

  .ffm__external-note, .ffm__empty-state-small {
    padding: 20px;
    background: color-mix(in srgb, var(--glass-gold) 3%, transparent);
    border: 1px dashed color-mix(in srgb, var(--glass-gold) 12%, transparent);
    border-radius: 10px;
    text-align: center;
  }

  .ffm__external-note p, .ffm__empty-state-small p {
    margin: 0 0 8px 0;
    font-size: 12px;
    color: var(--glass-fg-3);
  }

  .ffm__external-note p:last-child, .ffm__empty-state-small p:last-child {
    margin-bottom: 0;
  }

  /* ═══════════════════════════════════════════════════════════════
     KPI CONFIG
     ═══════════════════════════════════════════════════════════════ */

  .ffm__kpi-toggle {
    margin-bottom: 20px;
  }

  .ffm__checkbox-label {
    display: flex;
    align-items: center;
    gap: 10px;
    cursor: pointer;
    font-size: 12px;
    color: var(--glass-fg-2);
  }

  .ffm__checkbox-label--large {
    font-size: 13px;
    padding: 14px 16px;
    background: color-mix(in srgb, var(--glass-gold) 3%, transparent);
    border: 1px solid color-mix(in srgb, var(--glass-gold) 10%, transparent);
    border-radius: 10px;
  }

  .ffm__checkbox-input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }

  .ffm__checkbox-box {
    width: 20px;
    height: 20px;
    background: color-mix(in srgb, var(--glass-base) 40%, transparent);
    border: 2px solid color-mix(in srgb, var(--glass-gold) 30%, transparent);
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s ease;
  }

  .ffm__checkbox-input:checked + .ffm__checkbox-box {
    background: var(--glass-gold);
    border-color: var(--glass-gold);
  }

  .ffm__checkbox-input:checked + .ffm__checkbox-box::after {
    content: '✓';
    color: black;
    font-size: 12px;
    font-weight: bold;
  }

  .ffm__kpi-options {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin: 16px 0;
  }

  .ffm__kpi-option {
    padding: 10px 14px;
    background: color-mix(in srgb, var(--glass-fg) 2%, transparent);
    border: 1px solid color-mix(in srgb, var(--glass-fg) 5%, transparent);
    border-radius: 8px;
  }

  .ffm__kpi-code {
    margin-top: 24px;
    padding: 16px;
    background: color-mix(in srgb, var(--glass-base) 40%, transparent);
    border: 1px solid color-mix(in srgb, var(--glass-gold) 10%, transparent);
    border-radius: 10px;
  }

  .ffm__kpi-code-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
  }

  .ffm__copy-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    background: color-mix(in srgb, var(--glass-gold) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--glass-gold) 20%, transparent);
    border-radius: 6px;
    color: var(--glass-gold);
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .ffm__copy-btn svg {
    width: 12px;
    height: 12px;
  }

  .ffm__copy-btn:hover {
    background: color-mix(in srgb, var(--glass-gold) 15%, transparent);
  }

  .ffm__code-block {
    padding: 14px;
    background: color-mix(in srgb, var(--glass-base) 50%, transparent);
    border-radius: 8px;
    overflow-x: auto;
    margin: 0;
  }

  .ffm__code-block code {
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 11px;
    color: #22c55e;
    white-space: pre-wrap;
    word-break: break-all;
  }

  .ffm__kpi-tracked {
    margin-top: 20px;
  }

  .ffm__kpi-tracked-header {
    font-size: 10px;
    color: color-mix(in srgb, var(--glass-gold) 40%, transparent);
    margin-bottom: 10px;
  }

  .ffm__kpi-tracked-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 6px;
  }

  .ffm__kpi-tracked-item {
    padding: 8px 12px;
    background: rgba(34,197,94,0.06);
    border: 1px solid rgba(34,197,94,0.1);
    border-radius: 6px;
    font-size: 11px;
    color: var(--glass-fg-2);
  }

  /* ═══════════════════════════════════════════════════════════════
     SPAWN DIALOG
     ═══════════════════════════════════════════════════════════════ */

  .ffm__spawn-dialog {
    width: 560px;
    max-width: 95vw;
    background: var(--glass-3);
    border: 1px solid color-mix(in srgb, var(--glass-gold) 20%, transparent);
    border-radius: 16px;
    overflow: hidden;
    box-shadow: 0 25px 80px rgba(0,0,0,0.6);
  }

  .ffm__spawn-header {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 20px 24px;
    background: linear-gradient(180deg, color-mix(in srgb, var(--glass-gold) 4%, transparent) 0%, transparent 100%);
    border-bottom: 1px solid color-mix(in srgb, var(--glass-gold) 10%, transparent);
  }

  .ffm__spawn-icon {
    width: 44px;
    height: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: color-mix(in srgb, var(--glass-gold) 10%, transparent);
    border-radius: 12px;
    color: var(--glass-gold);
  }

  .ffm__spawn-icon svg {
    width: 22px;
    height: 22px;
  }

  .ffm__spawn-title {
    flex: 1;
  }

  .ffm__spawn-title h3 {
    margin: 0 0 4px 0;
    font-size: 16px;
    color: var(--glass-gold);
  }

  .ffm__spawn-title p {
    margin: 0;
    font-size: 12px;
    color: var(--glass-fg-3);
  }

  .ffm__spawn-body {
    padding: 24px;
  }

  .ffm__spawn-context {
    display: flex;
    gap: 20px;
    padding: 14px 16px;
    background: color-mix(in srgb, var(--glass-gold) 3%, transparent);
    border: 1px solid color-mix(in srgb, var(--glass-gold) 8%, transparent);
    border-radius: 10px;
    margin-bottom: 20px;
  }

  .ffm__spawn-context-item {
    display: flex;
    gap: 8px;
    font-size: 12px;
  }

  .ffm__spawn-context-item span:first-child {
    color: color-mix(in srgb, var(--glass-gold) 60%, transparent);
  }

  .ffm__spawn-context-item span:last-child {
    color: white;
  }

  .ffm__spawn-textarea {
    min-height: 120px;
  }

  .ffm__spawn-suggestions {
    margin-top: 12px;
  }

  .ffm__spawn-suggestions > span {
    display: block;
    font-size: 10px;
    color: color-mix(in srgb, var(--glass-gold) 40%, transparent);
    margin-bottom: 8px;
  }

  .ffm__spawn-suggestion-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .ffm__chip {
    padding: 6px 12px;
    background: color-mix(in srgb, var(--glass-fg) 4%, transparent);
    border: 1px solid color-mix(in srgb, var(--glass-fg) 8%, transparent);
    border-radius: 20px;
    color: var(--glass-fg-2);
    font-size: 11px;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .ffm__chip:hover {
    background: color-mix(in srgb, var(--glass-gold) 8%, transparent);
    border-color: color-mix(in srgb, var(--glass-gold) 20%, transparent);
    color: var(--glass-gold);
  }

  .ffm__spawn-footer {
    display: flex;
    justify-content: flex-end;
    gap: 12px;
    padding: 18px 24px;
    border-top: 1px solid color-mix(in srgb, var(--glass-gold) 8%, transparent);
    background: color-mix(in srgb, var(--glass-base) 20%, transparent);
  }

  .ffm__btn--danger {
    background: rgba(239,68,68,0.08);
    border: 1px solid rgba(239,68,68,0.2);
    color: #ef4444;
  }

  .ffm__btn--danger:hover {
    background: rgba(239,68,68,0.15);
  }

  /* ═══════════════════════════════════════════════════════════════
     CONNECTION EDITOR
     ═══════════════════════════════════════════════════════════════ */

  .ffm__conn-svg--clickable {
    cursor: pointer;
  }

  .ffm__conn-svg--clickable:hover path[stroke-width="3"] {
    stroke-width: 4;
  }

  .ffm__conn-editor {
    width: 100%;
    max-width: 520px;
    background: linear-gradient(145deg, rgba(20,20,20,0.98) 0%, color-mix(in srgb, var(--glass-base) 98%, transparent) 100%);
    border: 1px solid color-mix(in srgb, var(--glass-gold) 15%, transparent);
    border-radius: 16px;
    box-shadow: 0 25px 80px rgba(0,0,0,0.6);
    overflow: hidden;
  }

  .ffm__conn-editor-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 18px 24px;
    border-bottom: 1px solid color-mix(in srgb, var(--glass-gold) 8%, transparent);
    background: color-mix(in srgb, var(--glass-base) 20%, transparent);
  }

  .ffm__conn-editor-title {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .ffm__conn-editor-title h3 {
    margin: 0;
    font-size: 14px;
    color: var(--glass-gold);
  }

  .ffm__conn-editor-flow {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 16px 24px;
    background: color-mix(in srgb, var(--glass-gold) 3%, transparent);
    border-bottom: 1px solid color-mix(in srgb, var(--glass-gold) 5%, transparent);
  }

  .ffm__conn-node-badge {
    padding: 8px 16px;
    background: color-mix(in srgb, var(--glass-base) 30%, transparent);
    border: 1px solid color-mix(in srgb, var(--glass-gold) 15%, transparent);
    border-radius: 8px;
    font-size: 12px;
    color: white;
  }

  .ffm__conn-arrow {
    width: 24px;
    height: 24px;
    color: var(--glass-gold);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .ffm__conn-arrow svg {
    width: 100%;
    height: 100%;
  }

  .ffm__conn-editor-body {
    padding: 24px;
    display: flex;
    flex-direction: column;
    gap: 20px;
    max-height: 60vh;
    overflow-y: auto;
  }

  .ffm__conv-rate-row {
    display: flex;
    align-items: center;
    gap: 16px;
  }

  .ffm__input--number {
    width: 100px;
  }

  .ffm__conv-rate-hint {
    font-size: 11px;
    color: var(--glass-fg-3);
  }

  .ffm__cond-type-grid {
    display: flex;
    gap: 10px;
  }

  .ffm__cond-type-btn {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 14px 12px;
    background: color-mix(in srgb, var(--glass-fg) 2%, transparent);
    border: 1px solid color-mix(in srgb, var(--glass-fg) 8%, transparent);
    border-radius: 10px;
    color: var(--glass-fg-2);
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .ffm__cond-type-btn span:first-child {
    font-size: 18px;
  }

  .ffm__cond-type-btn .ffm__mono {
    font-size: 10px;
    color: var(--glass-fg-2);
  }

  .ffm__cond-type-btn small {
    font-size: 9px;
    color: var(--glass-fg-4);
  }

  .ffm__cond-type-btn:hover {
    background: color-mix(in srgb, var(--glass-gold) 5%, transparent);
    border-color: color-mix(in srgb, var(--glass-gold) 15%, transparent);
  }

  .ffm__cond-type-btn.selected {
    background: color-mix(in srgb, var(--glass-gold) 10%, transparent);
    border-color: color-mix(in srgb, var(--glass-gold) 30%, transparent);
  }

  .ffm__cond-type-btn.selected .ffm__mono {
    color: var(--glass-gold);
  }

  .ffm__conditions-section {
    padding: 16px;
    background: color-mix(in srgb, var(--glass-gold) 3%, transparent);
    border: 1px solid color-mix(in srgb, var(--glass-gold) 10%, transparent);
    border-radius: 12px;
  }

  .ffm__conditions-header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 12px;
  }

  .ffm__conditions-header label {
    color: var(--glass-gold);
  }

  .ffm__conditions-hint {
    font-size: 10px;
    color: color-mix(in srgb, var(--glass-gold) 60%, transparent);
  }

  .ffm__conditions-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .ffm__condition-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    background: color-mix(in srgb, var(--glass-base) 30%, transparent);
    border-radius: 8px;
  }

  .ffm__condition-row .ffm__select {
    flex: 1;
    min-width: 0;
  }

  .ffm__input--small {
    width: 80px;
    flex-shrink: 0;
  }

  .ffm__remove-btn {
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: none;
    color: rgba(255,100,100,0.5);
    cursor: pointer;
    border-radius: 6px;
    flex-shrink: 0;
    transition: all 0.15s ease;
  }

  .ffm__remove-btn:hover {
    background: rgba(255,100,100,0.1);
    color: #ff6464;
  }

  .ffm__remove-btn svg {
    width: 14px;
    height: 14px;
  }

  .ffm__rule-link {
    padding: 16px;
    background: color-mix(in srgb, var(--glass-gold-hi) 5%, transparent);
    border: 1px solid color-mix(in srgb, var(--glass-gold-hi) 12%, transparent);
    border-radius: 10px;
  }

  .ffm__rule-badge {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    background: color-mix(in srgb, var(--glass-gold-hi) 10%, transparent);
    border-radius: 8px;
    color: var(--glass-gold-hi);
    font-size: 13px;
  }

  .ffm__rule-hint {
    margin: 0;
    font-size: 12px;
    color: var(--glass-fg-3);
    text-align: center;
  }

  .ffm__conn-editor-footer {
    display: flex;
    justify-content: space-between;
    padding: 18px 24px;
    border-top: 1px solid color-mix(in srgb, var(--glass-gold) 8%, transparent);
    background: color-mix(in srgb, var(--glass-base) 20%, transparent);
  }
`;
