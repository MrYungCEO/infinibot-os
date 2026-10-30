/**
 * Integrations Panel — ManyChat + Instagram connector hub.
 * Luxury black-gold glass (see glass-integrations.css.ts + glass-tools-shared.ts).
 */

import { html, nothing, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../gateway-client.js";
import { GLASS_INTEGRATIONS_CSS } from "./glass-integrations.css.js";
import { glassAurora, glassHero, glassToolsStyle } from "./glass-tools-shared.js";

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

interface IntegrationCredential {
  id: string;
  platformId: string;
  businessId?: string;
  method: string;
  apiKey?: string;
  connected: boolean;
  lastVerified?: number;
  accountName?: string;
  accountId?: string;
}

interface ManyChatFlow {
  id: string;
  name: string;
  type: string;
  status: string;
  created_at?: string;
  updated_at?: string;
  triggers?: any[];
  folder_id?: string;
}

interface ManyChatTag {
  id: string;
  name: string;
  subscribers_count: number;
}

interface ManyChatAutomation {
  id: string;
  name: string;
  status: string;
  type: string;
}

interface ManyChatCustomField {
  id: number;
  name: string;
  type: string;
  description?: string;
}

// Instagram Types
interface InstagramProfile {
  id: string;
  username: string;
  name: string;
  biography: string;
  profile_picture_url: string;
  followers_count: number;
  follows_count: number;
  media_count: number;
  website: string;
  account_type: string;
}

interface InstagramMedia {
  id: string;
  media_type: 'IMAGE' | 'VIDEO' | 'CAROUSEL_ALBUM' | 'REELS';
  media_url: string;
  thumbnail_url?: string;
  permalink: string;
  caption: string;
  timestamp: string;
  like_count: number;
  comments_count: number;
  insights?: {
    impressions: number;
    reach: number;
    engagement: number;
    saved: number;
    plays?: number;
    shares?: number;
  };
}

interface InstagramProfileInsights {
  impressions: number;
  reach: number;
  profile_views: number;
  website_clicks: number;
  accounts_engaged?: number;
}

// ═══════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════

interface IntegrationsPanelState {
  credentials: IntegrationCredential[];
  selectedPlatform: 'manychat' | 'instagram';
  activeTab: 'overview' | 'flows' | 'automations' | 'tags' | 'fields' | 'settings' | 'ig-profile' | 'ig-media' | 'ig-insights';
  manychat: {
    flows: ManyChatFlow[];
    tags: ManyChatTag[];
    automations: ManyChatAutomation[];
    customFields: ManyChatCustomField[];
    growthTools: any[];
    loading: boolean;
    error: string | null;
    stats: {
      totalSubscribers: number;
      totalFlows: number;
      activeFlows: number;
      activeTags: number;
      activeAutomations: number;
    };
  };
  connecting: boolean;
  apiKeyInput: string;
  verificationResult: { valid: boolean; accountName?: string; error?: string } | null;
  searchQuery: string;
  viewMode: 'grid' | 'list';
  selectedFlow: ManyChatFlow | null;
  showFlowModal: boolean;
  // Instagram
  instagram: {
    profile: InstagramProfile | null;
    media: InstagramMedia[];
    profileInsights: InstagramProfileInsights | null;
    loading: boolean;
    error: string | null;
  };
  igAccessToken: string;
  selectedMedia: InstagramMedia | null;
  showMediaModal: boolean;
  // Connector hub (search + category filter over the connector cards)
  connectorQuery: string;
  connectorFilter: ConnectorFilter;
  credentialsLoading: boolean;
}

type ConnectorFilter = 'all' | 'connected' | 'messaging' | 'analytics';

let _state: IntegrationsPanelState = {
  credentials: [],
  selectedPlatform: 'manychat',
  activeTab: 'overview',
  manychat: {
    flows: [],
    tags: [],
    automations: [],
    customFields: [],
    growthTools: [],
    loading: false,
    error: null,
    stats: { totalSubscribers: 0, totalFlows: 0, activeFlows: 0, activeTags: 0, activeAutomations: 0 },
  },
  connecting: false,
  apiKeyInput: '',
  verificationResult: null,
  searchQuery: '',
  viewMode: 'grid',
  selectedFlow: null,
  showFlowModal: false,
  instagram: {
    profile: null,
    media: [],
    profileInsights: null,
    loading: false,
    error: null,
  },
  igAccessToken: '',
  selectedMedia: null,
  showMediaModal: false,
  connectorQuery: '',
  connectorFilter: 'all',
  credentialsLoading: false,
};

let _client: GatewayBrowserClient | null = null;
let _requestUpdate: (() => void) | null = null;
let _businessId = 'default';

// ═══════════════════════════════════════════════════════════════
// ICONS
// ═══════════════════════════════════════════════════════════════

const icons = {
  manychat: html`<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>`,
  connected: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
  flow: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`,
  tag: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>`,
  automation: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/></svg>`,
  refresh: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>`,
  check: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>`,
  key: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>`,
  close: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
  users: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>`,
  play: html`<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>`,
  pause: html`<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`,
  search: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
  grid: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>`,
  list: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>`,
  plus: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
  edit: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
  trash: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>`,
  message: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>`,
  zap: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
  database: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>`,
  externalLink: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`,
  copy: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>`,
  instagram: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="5" ry="5"/><circle cx="12" cy="12" r="4"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg>`,
  terminal: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`,
  activity: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`,
  clock: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
  info: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
  send: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`,
  arrowRight: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>`,
  link: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>`,
  heart: html`<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21s-7.5-4.6-9.6-9.2C.9 8.4 3 4.5 6.7 4.5c2.1 0 3.6 1.2 4.3 2.5h2c.7-1.3 2.2-2.5 4.3-2.5 3.7 0 5.8 3.9 4.3 7.3C19.5 16.4 12 21 12 21z"/></svg>`,
  eye: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`,
  bookmark: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/></svg>`,
  share: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>`,
  trend: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>`,
  calendar: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`,
  hash: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/></svg>`,
  folder: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>`,
  target: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>`,
  image: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`,
  layers: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>`,
  film: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/></svg>`,
};

/** Brand marks for the connector logo tiles (white glyph on a brand-tinted tile). */
const brandMarks = {
  manychat: html`<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3.2c-5 0-9 3.6-9 8.1 0 2.5 1.2 4.7 3.2 6.2v3.3l3.1-1.8c.9.3 1.8.4 2.7.4 5 0 9-3.6 9-8.1S17 3.2 12 3.2z" fill="#fff"/><path d="M8.2 11.6c.9 1.6 2.3 2.4 3.8 2.4s2.9-.8 3.8-2.4" stroke="#1e6bf0" stroke-width="1.9" stroke-linecap="round"/></svg>`,
  instagram: html`<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.1" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5.2"/><circle cx="12" cy="12" r="4.1"/><circle cx="17.4" cy="6.6" r="1.1" fill="#fff" stroke="none"/></svg>`,
};

function brandLogo(brand: keyof typeof brandMarks, size: '' | 'sm' | 'lg' = '') {
  return html`<span class="int-logo ${size ? `int-logo--${size}` : ''}" data-brand=${brand} aria-hidden="true">${brandMarks[brand]}</span>`;
}

// ═══════════════════════════════════════════════════════════════
// ACTIONS
// ═══════════════════════════════════════════════════════════════

export async function initIntegrationsPanel(client: GatewayBrowserClient, businessId = 'default') {
  console.log("[integrations] initIntegrationsPanel called");
  _client = client;
  _businessId = businessId;
  await loadCredentials();
}

export function setIntegrationsRequestUpdate(fn: () => void) {
  _requestUpdate = fn;
}

async function loadCredentials() {
  if (!_client) return;
  
  _state.credentialsLoading = true;
  try {
    const res = await _client.request('integrations.credentials.list', { businessId: _businessId }) as { credentials?: any[] };
    console.log("[integrations] Credentials loaded:", res);
    
    if (res?.credentials) {
      _state.credentials = res.credentials;
      
      // Load ManyChat data if connected
      const manychat = _state.credentials.find((c: any) => c.platformId === 'manychat');
      if (manychat?.connected) {
        await loadManyChatData();
      }
      
      // Load Instagram data if connected
      const instagram = _state.credentials.find((c: any) => c.platformId === 'instagram');
      if (instagram?.connected) {
        await loadInstagramData();
      }
    }
  } catch (e) {
    console.error("[integrations] Failed to load credentials:", e);
  }
  
  _state.credentialsLoading = false;
  _requestUpdate?.();
}

async function loadManyChatData() {
  if (!_client) return;
  
  _state.manychat.loading = true;
  _state.manychat.error = null;
  _requestUpdate?.();
  
  try {
    const [flowsRes, tagsRes, automationsRes, fieldsRes, statsRes] = await Promise.all([
      _client.request('integrations.manychat.getFlows', { businessId: _businessId }) as Promise<{ flows?: any[] }>,
      _client.request('integrations.manychat.getTags', { businessId: _businessId }) as Promise<{ tags?: any[] }>,
      _client.request('integrations.manychat.getAutomations', { businessId: _businessId }) as Promise<{ automations?: any[] }>,
      _client.request('integrations.manychat.getCustomFields', { businessId: _businessId }) as Promise<{ fields?: any[] }>,
      _client.request('integrations.manychat.getStats', { businessId: _businessId }).catch(() => ({ stats: { subscriberCount: 0 } })) as Promise<{ stats?: { subscriberCount: number } }>,
    ]);
    
    console.log("[integrations] ManyChat data loaded:", { flowsRes, tagsRes, automationsRes, fieldsRes, statsRes });
    
    _state.manychat.flows = flowsRes?.flows || [];
    _state.manychat.tags = tagsRes?.tags || [];
    _state.manychat.automations = automationsRes?.automations || [];
    _state.manychat.customFields = fieldsRes?.fields || [];
    
    // Calculate stats - all flows from API are considered active (drafts aren't returned)
    const totalFlows = _state.manychat.flows.length;
    _state.manychat.stats = {
      totalSubscribers: statsRes?.stats?.subscriberCount || _state.manychat.tags.reduce((sum, t) => sum + (t.subscribers_count || 0), 0),
      totalFlows,
      activeFlows: totalFlows, // All returned flows are active (API doesn't return drafts)
      activeTags: _state.manychat.tags.length,
      activeAutomations: _state.manychat.automations.length, // Count all (no status filter)
    };
    
    console.log("[integrations] ManyChat stats:", _state.manychat.stats);
    
  } catch (e: any) {
    console.error("[integrations] Failed to load ManyChat data:", e);
    _state.manychat.error = e.message || 'Failed to load ManyChat data';
  }
  
  _state.manychat.loading = false;
  _requestUpdate?.();
}

async function verifyApiKey() {
  if (!_client || !_state.apiKeyInput) return;
  
  _state.connecting = true;
  _state.verificationResult = null;
  _requestUpdate?.();
  
  try {
    const res = await _client.request('integrations.credentials.verify', {
      platformId: 'manychat',
      businessId: _businessId,
      apiKey: _state.apiKeyInput,
    }) as { verification?: { valid: boolean; accountName?: string; error?: string } };
    
    if (res.verification) {
      _state.verificationResult = res.verification;
      if (res.verification.valid) {
        _state.apiKeyInput = '';
        await loadCredentials();
      }
    } else {
      _state.verificationResult = { valid: false, error: 'No verification response' };
    }
  } catch (e: any) {
    _state.verificationResult = { valid: false, error: e?.message || 'Verification error' };
  }
  
  _state.connecting = false;
  _requestUpdate?.();
}

async function disconnectManyChat() {
  if (!_client) return;
  
  const manychat = _state.credentials.find(c => c.platformId === 'manychat');
  if (manychat) {
    await _client.request('integrations.credentials.delete', { id: manychat.id });
    _state.manychat = {
      flows: [],
      tags: [],
      automations: [],
      customFields: [],
      growthTools: [],
      loading: false,
      error: null,
      stats: { totalSubscribers: 0, totalFlows: 0, activeFlows: 0, activeTags: 0, activeAutomations: 0 },
    };
    await loadCredentials();
  }
}

async function toggleAutomation(automationId: string, enabled: boolean) {
  if (!_client) return;
  
  try {
    await _client.request('integrations.manychat.toggleAutomation', {
      businessId: _businessId,
      automationId,
      enabled,
    });
    
    const auto = _state.manychat.automations.find(a => a.id === automationId);
    if (auto) auto.status = enabled ? 'active' : 'inactive';
    _requestUpdate?.();
  } catch (e) {
    console.error("[integrations] Failed to toggle automation:", e);
  }
}

function setTab(tab: typeof _state.activeTab) {
  _state.activeTab = tab;
  _state.searchQuery = '';
  _requestUpdate?.();
}

function setPlatform(platform: typeof _state.selectedPlatform) {
  _state.selectedPlatform = platform;
  _state.activeTab = 'overview';
  _requestUpdate?.();
}

// ═══════════════════════════════════════════════════════════════
// INSTAGRAM ACTIONS
// ═══════════════════════════════════════════════════════════════

async function loadInstagramData() {
  if (!_client) return;

  _state.instagram.loading = true;
  _state.instagram.error = null;
  _requestUpdate?.();

  const [profileRes, mediaRes, insightsRes] = await Promise.all([
    _client.request('integrations.instagram.getProfile', { businessId: _businessId })
      .catch((e: any) => ({ profile: null, _err: e?.message || 'Profile load failed' })) as Promise<{ profile?: InstagramProfile | null; _err?: string }>,
    _client.request('integrations.instagram.getMedia', { businessId: _businessId, limit: 12, withInsights: true })
      .catch((e: any) => ({ media: null, _err: e?.message || 'Media load failed' })) as Promise<{ media?: InstagramMedia[] | null; _err?: string }>,
    _client.request('integrations.instagram.getProfileInsights', { businessId: _businessId })
      .catch((e: any) => ({ insights: null, _err: e?.message || 'Insights load failed' })) as Promise<{ insights?: InstagramProfileInsights | null; _err?: string }>,
  ]);

  console.log("[integrations] Instagram data loaded:", { profileRes, mediaRes, insightsRes });

  _state.instagram.profile = (profileRes as any)?.profile || null;
  _state.instagram.media = (mediaRes as any)?.media || [];
  _state.instagram.profileInsights = (insightsRes as any)?.insights || null;

  const errs: string[] = [];
  if ((profileRes as any)?._err) errs.push(`Profile: ${(profileRes as any)._err}`);
  if ((mediaRes as any)?._err) errs.push(`Media: ${(mediaRes as any)._err}`);
  if ((insightsRes as any)?._err) errs.push(`Insights: ${(insightsRes as any)._err}`);
  if (errs.length) _state.instagram.error = errs.join(' · ');

  _state.instagram.loading = false;
  _requestUpdate?.();
}

async function verifyInstagram() {
  if (!_client || !_state.igAccessToken) return;
  
  _state.connecting = true;
  _state.verificationResult = null;
  _requestUpdate?.();
  
  try {
    const res = await _client.request('integrations.instagram.verify', {
      businessId: _businessId,
      accessToken: _state.igAccessToken,
    }) as { verification?: { valid: boolean; username?: string; error?: string } };
    
    if (res.verification) {
      _state.verificationResult = { 
        valid: res.verification.valid, 
        accountName: res.verification.username,
        error: res.verification.error 
      };
      if (res.verification.valid) {
        _state.igAccessToken = '';
        await loadCredentials();
      }
    }
  } catch (e: any) {
    _state.verificationResult = { valid: false, error: e?.message || 'Verification error' };
  }
  
  _state.connecting = false;
  _requestUpdate?.();
}

async function disconnectInstagram() {
  if (!_client) return;
  
  const instagram = _state.credentials.find(c => c.platformId === 'instagram');
  if (instagram) {
    await _client.request('integrations.credentials.delete', { id: instagram.id });
    _state.instagram = {
      profile: null,
      media: [],
      profileInsights: null,
      loading: false,
      error: null,
    };
    await loadCredentials();
  }
}

function openMediaModal(media: InstagramMedia) {
  _state.selectedMedia = media;
  _state.showMediaModal = true;
  _requestUpdate?.();
}

function closeMediaModal() {
  _state.selectedMedia = null;
  _state.showMediaModal = false;
  _requestUpdate?.();
}

function formatTimeAgo(timestamp: string): string {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diff = now - then;
  
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'Just now';
}

function openFlowModal(flow: ManyChatFlow) {
  _state.selectedFlow = flow;
  _state.showFlowModal = true;
  _requestUpdate?.();
}

function closeFlowModal() {
  _state.selectedFlow = null;
  _state.showFlowModal = false;
  _requestUpdate?.();
}

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text);
}

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function formatNumber(n: number | null | undefined): string {
  // Upstream APIs omit counts they can't read; one missing field must not
  // throw and blank the whole panel.
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toString();
}

function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash);
}

function formatDate(dateStr?: string): string {
  if (!dateStr) return '—';
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function getFlowTypeLabel(type: string): string {
  const types: Record<string, string> = {
    'content': 'Content',
    'default_reply': 'Default Reply',
    'welcome_message': 'Welcome Message',
    'keywords': 'Keywords',
    'story_mention': 'Story Mention',
    'story_reply': 'Story Reply',
    'comment': 'Comment Trigger',
    'ice_breakers': 'Ice Breakers',
    'persistent_menu': 'Persistent Menu',
  };
  return types[type] || type;
}

// ═══════════════════════════════════════════════════════════════
// FLOW MODAL
// ═══════════════════════════════════════════════════════════════

function renderFlowModal(): TemplateResult {
  const flow = _state.selectedFlow;
  if (!flow) return html``;

  return html`
    <div class="int-modal-overlay" @click=${closeFlowModal}>
      <div class="int-modal" role="dialog" aria-modal="true" aria-label=${flow.name} @click=${(e: Event) => e.stopPropagation()}>
        <div class="int-modal-header">
          <div class="int-modal-icon">${icons.flow}</div>
          <div class="int-modal-title">
            <h2>${flow.name}</h2>
            <span class="int-modal-type">${getFlowTypeLabel(flow.type)}</span>
          </div>
          <button class="gt-btn int-btn int-btn--icon int-icon-btn" aria-label="Close" @click=${closeFlowModal}>
            ${icons.close}
          </button>
        </div>

        <div class="int-modal-body">
          <div class="int-modal-section">
            <h4>${icons.zap} Status</h4>
            <div class="int-modal-status ${flow.status}">
              <span class="int-status-dot"></span>
              ${flow.status === 'active' ? 'Active' : flow.status === 'draft' ? 'Draft' : 'Inactive'}
            </div>
          </div>

          <div class="int-modal-grid">
            <div class="int-modal-section">
              <h4>${icons.hash} Flow ID</h4>
              <div class="int-modal-code">
                <code>${flow.id}</code>
                <button class="gt-btn int-btn int-btn--sm" aria-label="Copy flow ID" title="Copy" @click=${() => copyToClipboard(flow.id)}>
                  ${icons.copy}
                </button>
              </div>
            </div>

            <div class="int-modal-section">
              <h4>${icons.folder} Type</h4>
              <p>${getFlowTypeLabel(flow.type)}</p>
            </div>
          </div>

          <div class="int-modal-grid">
            <div class="int-modal-section">
              <h4>${icons.calendar} Created</h4>
              <p>${formatDate(flow.created_at)}</p>
            </div>

            <div class="int-modal-section">
              <h4>${icons.refresh} Updated</h4>
              <p>${formatDate(flow.updated_at)}</p>
            </div>
          </div>

          ${flow.triggers && flow.triggers.length > 0 ? html`
            <div class="int-modal-section">
              <h4>${icons.target} Triggers</h4>
              <div class="int-modal-triggers">
                ${flow.triggers.map(t => html`
                  <span class="gt-chip int-trigger-tag">${t.type || t}</span>
                `)}
              </div>
            </div>
          ` : nothing}
        </div>

        <div class="int-modal-footer">
          <button class="gt-btn int-btn" @click=${closeFlowModal}>
            Close
          </button>
          <a href="https://manychat.com/fb${flow.id ? `/${flow.id}` : ''}" target="_blank" class="gt-btn gt-primary int-btn int-btn--primary">
            ${icons.externalLink} Edit in ManyChat
          </a>
        </div>
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════
// CONNECTOR HUB (cards, search, category filter)
// ═══════════════════════════════════════════════════════════════

type ConnectorId = 'manychat' | 'instagram';
type ConnectorState = 'ok' | 'warn' | 'danger' | 'idle';

interface ConnectorView {
  id: ConnectorId;
  name: string;
  category: 'messaging' | 'analytics';
  categoryLabel: string;
  desc: string;
  cred?: IntegrationCredential;
  state: ConnectorState;
  stateLabel: string;
  account?: string;
}

function connectorState(cred: IntegrationCredential | undefined, loading: boolean, error: string | null, partialLabel?: string): { state: ConnectorState; label: string } {
  if (cred?.connected) {
    if (error) return partialLabel ? { state: 'warn', label: partialLabel } : { state: 'danger', label: 'Sync error' };
    if (loading) return { state: 'warn', label: 'Syncing' };
    return { state: 'ok', label: 'Connected' };
  }
  if (cred) return { state: 'danger', label: 'Expired' };
  return { state: 'idle', label: 'Not connected' };
}

function getConnectors(): ConnectorView[] {
  const mc = _state.credentials.find(c => c.platformId === 'manychat');
  const ig = _state.credentials.find(c => c.platformId === 'instagram');
  const mcState = connectorState(mc, _state.manychat.loading, _state.manychat.error);
  const igState = connectorState(ig, _state.instagram.loading, _state.instagram.error, 'Partial data');
  return [
    {
      id: 'manychat',
      name: 'ManyChat',
      category: 'messaging',
      categoryLabel: 'Messaging',
      desc: 'Automate Instagram DMs, comment triggers and subscriber management.',
      cred: mc,
      state: mcState.state,
      stateLabel: mcState.label,
      account: mc?.connected ? (mc.accountName || 'ManyChat workspace') : undefined,
    },
    {
      id: 'instagram',
      name: 'Instagram Analytics',
      category: 'analytics',
      categoryLabel: 'Analytics',
      desc: 'Profile stats, reel analytics and post-level content performance.',
      cred: ig,
      state: igState.state,
      stateLabel: igState.label,
      account: ig?.connected ? `@${ig.accountName || _state.instagram.profile?.username || 'instagram'}` : undefined,
    },
  ];
}

function setConnectorFilter(filter: ConnectorFilter) {
  _state.connectorFilter = filter;
  _requestUpdate?.();
}

/** Select a connector and, when it isn't connected yet, focus its credential input. */
function openConnector(c: ConnectorView) {
  setPlatform(c.id);
  if (!c.cred?.connected) {
    setTimeout(() => {
      (document.querySelector('.int-panel .int-connect .gt-input') as HTMLInputElement | null)?.focus();
    }, 60);
  }
}

function renderConnectorCard(c: ConnectorView, i: number): TemplateResult {
  const selected = _state.selectedPlatform === c.id;
  const connected = !!c.cred?.connected;
  const cta = connected
    ? html`<button class="gt-btn" @click=${(e: Event) => { e.stopPropagation(); openConnector(c); }}>
        Manage <span class="int-connector-arrow">${icons.arrowRight}</span>
      </button>`
    : c.cred
      ? html`<button class="gt-btn gt-danger" @click=${(e: Event) => { e.stopPropagation(); openConnector(c); }}>
          ${icons.refresh} Reconnect
        </button>`
      : html`<button class="gt-btn gt-primary" @click=${(e: Event) => { e.stopPropagation(); openConnector(c); }}>
          ${icons.link} Connect
        </button>`;
  return html`
    <div class="int-connector gt-glass gt-lift gt-rise" style="--gt-i:${i}"
      data-state=${c.state} aria-selected=${selected ? 'true' : 'false'}
      aria-label="${c.name}: ${c.stateLabel}"
      @click=${() => setPlatform(c.id)}>
      <div class="int-connector-top">
        ${brandLogo(c.id)}
        <div class="int-connector-id">
          <span class="int-connector-name">${c.name}</span>
          <span class="int-connector-cat">${c.categoryLabel}</span>
        </div>
        <span class="gt-light" data-state=${c.state} ?data-pulse=${c.state === 'ok' || c.state === 'warn'}></span>
      </div>
      <p class="int-connector-desc">${c.account
        ? html`Linked to <strong>${c.account}</strong>${c.cred && verifiedAgo(c.cred) ? html` · ${verifiedAgo(c.cred)!.replace('Verified', 'verified')}` : nothing}`
        : c.cred && !c.cred.connected
          ? html`Credentials for <strong>${c.cred.accountName || c.name}</strong> are no longer valid. Reconnect to resume syncing.`
          : c.desc}</p>
      <div class="int-connector-foot">
        <div class="int-connector-meta">
          ${_state.credentialsLoading && !c.cred
            ? html`<span class="gt-skel" style="width:96px;height:22px;border-radius:999px"></span>`
            : html`<span class="gt-chip" data-tone=${c.state === 'idle' ? '' : c.state}>${c.stateLabel}</span>`}
        </div>
        ${cta}
      </div>
    </div>
  `;
}

function renderConnectorHub(): TemplateResult {
  const all = getConnectors();
  const q = _state.connectorQuery.trim().toLowerCase();
  const f = _state.connectorFilter;
  const shown = all.filter(c =>
    (!q || `${c.name} ${c.categoryLabel} ${c.desc}`.toLowerCase().includes(q)) &&
    (f === 'all' || (f === 'connected' ? !!c.cred?.connected : c.category === f)),
  );
  const connectedCount = all.filter(c => c.cred?.connected).length;
  const count = (filter: ConnectorFilter) => filter === 'all' ? all.length
    : filter === 'connected' ? connectedCount
    : all.filter(c => c.category === filter).length;
  const followers = _state.instagram.profile?.followers_count;
  const segs: Array<[ConnectorFilter, string]> = [['all', 'All'], ['connected', 'Connected'], ['messaging', 'Messaging'], ['analytics', 'Analytics']];

  return html`
    ${glassHero({
      eyebrow: 'Integrations',
      title: 'Connected channels',
      sub: 'Link the platforms this funnel talks to and manage their data in one place.',
      stats: [
        { value: `${connectedCount}/${all.length}`, label: 'Live' },
        { value: _state.manychat.stats.totalSubscribers ? formatNumber(_state.manychat.stats.totalSubscribers) : '—', label: 'Subscribers' },
        { value: followers ? formatNumber(followers) : '—', label: 'Followers' },
      ],
    })}
    <div class="int-hub-tools">
      <label class="int-hub-search">
        ${icons.search}
        <span class="int-sr">Search integrations</span>
        <input class="gt-input" type="search" placeholder="Search integrations…" .value=${_state.connectorQuery}
          @input=${(e: Event) => { _state.connectorQuery = (e.target as HTMLInputElement).value; _requestUpdate?.(); }}/>
      </label>
      <div class="gt-seg" role="group" aria-label="Filter integrations">
        ${segs.map(([id, label]) => html`
          <button aria-pressed=${f === id ? 'true' : 'false'} @click=${() => setConnectorFilter(id)}>
            ${label}<span class="int-seg-count">${count(id)}</span>
          </button>
        `)}
      </div>
    </div>
    <div class="int-connectors">
      ${shown.map((c, i) => renderConnectorCard(c, i))}
      ${shown.length === 0 ? html`
        <div class="gt-empty gt-glass int-hub-empty">
          <div class="gt-empty-orb">${icons.search}</div>
          <div class="gt-empty-title">No integrations match</div>
          <div class="gt-empty-sub">Try a different search or category.</div>
          <button class="gt-btn" @click=${() => { _state.connectorQuery = ''; _state.connectorFilter = 'all'; _requestUpdate?.(); }}>Clear filters</button>
        </div>
      ` : nothing}
    </div>
  `;
}

function renderSkeleton(caption: string): TemplateResult {
  return html`
    <div class="int-loading" role="status" aria-live="polite">
      <div class="int-skel-grid">
        ${[0, 1, 2].map(() => html`<div class="gt-skel int-skel-card"></div>`)}
      </div>
      ${[0, 1, 2, 3].map(() => html`
        <div class="int-skel-row">
          <span class="gt-skel" style="width:32px;height:32px;border-radius:10px"></span>
          <span style="flex:1;display:grid;gap:6px">
            <span class="gt-skel" style="width:46%;height:11px"></span>
            <span class="gt-skel" style="width:28%;height:9px"></span>
          </span>
          <span class="gt-skel" style="width:58px;height:20px;border-radius:999px"></span>
        </div>
      `)}
      <span class="int-loading-caption"><span class="gt-light" data-state="gold" data-pulse></span>${caption}</span>
    </div>
  `;
}

function verifiedAgo(cred: IntegrationCredential): string | null {
  if (!cred.lastVerified) return null;
  return `Verified ${formatTimeAgo(new Date(cred.lastVerified).toISOString()).replace('Just now', 'just now')}`;
}

// ═══════════════════════════════════════════════════════════════
// CONNECT FORM
// ═══════════════════════════════════════════════════════════════

function renderConnectForm(): TemplateResult {
  return html`
    <div class="int-connect gt-glass gt-rise">
      <div class="int-connect-hero">
        ${brandLogo('manychat', 'lg')}
        <div>
          <h2>Connect ManyChat</h2>
          <p>Automate Instagram DMs, comment triggers, and subscriber management</p>
        </div>
      </div>

      <div class="int-connect-form">
        <div class="int-field">
          <label for="int-mc-key">
            <span class="int-field-icon">${icons.key}</span>
            ManyChat API Key
          </label>
          <div class="int-input-group">
            <input id="int-mc-key" type="password" class="gt-input int-input" autocomplete="off"
              placeholder="Enter your API key..."
              .value=${_state.apiKeyInput}
              @input=${(e: Event) => { _state.apiKeyInput = (e.target as HTMLInputElement).value; _requestUpdate?.(); }}
              @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter') verifyApiKey(); }}/>
            <button class="gt-btn gt-primary int-btn int-btn--primary" ?disabled=${_state.connecting || !_state.apiKeyInput}
              @click=${verifyApiKey}>
              ${_state.connecting ? html`<span class="int-spinner"></span>` : icons.link}
              ${_state.connecting ? 'Connecting...' : 'Connect'}
            </button>
          </div>
        </div>

        <div class="int-help">
          <div class="int-help-header">${icons.info} Getting your API key</div>
          <ol>
            <li><span>Go to <a href="https://manychat.com/settings/api" target="_blank">ManyChat Settings → API</a></span></li>
            <li><span>Enable the API if not already enabled</span></li>
            <li><span>Copy your API key</span></li>
          </ol>
        </div>

        ${_state.verificationResult ? html`
          <div class="int-result ${_state.verificationResult.valid ? 'success' : 'error'}" role="status">
            ${_state.verificationResult.valid ? icons.check : icons.close}
            <span>${_state.verificationResult.valid
              ? `Connected to ${_state.verificationResult.accountName || 'ManyChat'}`
              : (_state.verificationResult.error || 'Invalid API key')}</span>
          </div>
        ` : nothing}
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════════════

function renderDashboard(manychatCred: IntegrationCredential): TemplateResult {
  const verified = verifiedAgo(manychatCred);
  const err = _state.manychat.error;
  const stats: Array<{ icon: TemplateResult; value: string | number; label: string; highlight?: boolean }> = [
    { icon: icons.users, value: formatNumber(_state.manychat.stats.totalSubscribers), label: 'Subscribers' },
    { icon: icons.flow, value: _state.manychat.stats.totalFlows, label: 'Total Flows' },
    { icon: icons.activity, value: _state.manychat.stats.activeFlows, label: 'Active Flows', highlight: true },
    { icon: icons.tag, value: _state.manychat.stats.activeTags, label: 'Tags' },
    { icon: icons.zap, value: _state.manychat.stats.activeAutomations, label: 'Automations' },
  ];
  const tabs: Array<[typeof _state.activeTab, TemplateResult, string]> = [
    ['overview', icons.grid, 'Overview'],
    ['flows', icons.flow, 'Flows'],
    ['automations', icons.zap, 'Automations'],
    ['tags', icons.tag, 'Tags'],
    ['fields', icons.database, 'Fields'],
  ];
  return html`
    <div class="int-dashboard">
      <!-- Header -->
      <div class="int-header gt-glass gt-rise">
        <div class="int-header-left">
          <div class="int-brand">
            ${brandLogo('manychat')}
            <div class="int-brand-info">
              <h2>${manychatCred.accountName || 'ManyChat'}</h2>
              <span class="int-brand-status">
                <span class="gt-light" data-state=${err ? 'danger' : 'ok'} ?data-pulse=${!err}></span>
                <span class="gt-chip" data-tone=${err ? 'danger' : 'ok'}>${err ? 'Sync error' : 'Connected'}</span>
                ${verified ? html`<span class="int-brand-verified">${verified}</span>` : nothing}
              </span>
            </div>
          </div>
        </div>
        <div class="int-header-right">
          <button class="gt-btn int-btn" @click=${loadManyChatData} ?disabled=${_state.manychat.loading}>
            ${icons.refresh} Refresh
          </button>
          <button class="gt-btn gt-danger int-btn int-btn--danger" @click=${disconnectManyChat}>
            Disconnect
          </button>
        </div>
      </div>

      ${err ? html`
        <div class="int-error-banner" role="alert">
          <span class="gt-light" data-state="danger"></span>
          <span>${err}</span>
        </div>
      ` : nothing}

      <!-- Stats Grid -->
      <div class="int-stats">
        ${stats.map((s, i) => html`
          <div class="int-stat gt-glass gt-rise ${s.highlight ? 'highlight' : ''}" style="--gt-i:${i + 1}">
            <div class="int-stat-icon">${s.icon}</div>
            <div class="int-stat-data">
              <span class="int-stat-value">${_state.manychat.loading ? html`<span class="gt-skel" style="display:block;width:44px;height:20px"></span>` : s.value}</span>
              <span class="int-stat-label">${s.label}</span>
            </div>
          </div>
        `)}
      </div>

      <!-- Tabs -->
      <div class="int-tabs" role="tablist" aria-label="ManyChat sections">
        ${tabs.map(([id, icon, label]) => html`
          <button class="int-tab ${_state.activeTab === id ? 'active' : ''}" role="tab"
            aria-selected=${_state.activeTab === id ? 'true' : 'false'} @click=${() => setTab(id)}>
            ${icon} ${label}
          </button>
        `)}
      </div>

      <!-- Content -->
      <div class="int-content">
        ${_state.manychat.loading ? renderSkeleton('Loading ManyChat data...') : html`
          ${_state.activeTab === 'overview' ? renderOverview() : nothing}
          ${_state.activeTab === 'flows' ? renderFlows() : nothing}
          ${_state.activeTab === 'automations' ? renderAutomations() : nothing}
          ${_state.activeTab === 'tags' ? renderTags() : nothing}
          ${_state.activeTab === 'fields' ? renderFields() : nothing}
        `}
      </div>
    </div>

    ${_state.showFlowModal ? renderFlowModal() : nothing}
  `;
}

function renderOverview(): TemplateResult {
  const activeFlows = _state.manychat.flows.filter(f => f.status === 'active').slice(0, 5);
  const topTags = [..._state.manychat.tags].sort((a, b) => b.subscribers_count - a.subscribers_count).slice(0, 6);

  return html`
    <div class="int-overview">
      <div class="int-section gt-glass gt-rise">
        <div class="int-section-header">
          <h3>${icons.activity} Active Flows</h3>
          <button class="gt-btn int-btn int-btn--sm" @click=${() => setTab('flows')}>View all ${icons.arrowRight}</button>
        </div>
        <div class="int-list">
          ${activeFlows.map(flow => html`
            <div class="int-list-item" @click=${() => openFlowModal(flow)}>
              <div class="int-list-icon">${icons.message}</div>
              <div class="int-list-content">
                <span class="int-list-title">${flow.name}</span>
                <span class="int-list-meta">${getFlowTypeLabel(flow.type)}</span>
              </div>
              <span class="int-badge success">active</span>
            </div>
          `)}
          ${activeFlows.length === 0 ? html`<div class="int-empty">No active flows</div>` : nothing}
        </div>
      </div>

      <div class="int-section gt-glass gt-rise" style="--gt-i:1">
        <div class="int-section-header">
          <h3>${icons.tag} Top Tags</h3>
          <button class="gt-btn int-btn int-btn--sm" @click=${() => setTab('tags')}>View all ${icons.arrowRight}</button>
        </div>
        <div class="int-tags-grid">
          ${topTags.map(tag => html`
            <div class="int-tag-card">
              <div class="int-tag-color" style="background: hsl(${hashCode(tag.name) % 360}, 70%, 58%); color: hsl(${hashCode(tag.name) % 360}, 70%, 58%);"></div>
              <span class="int-tag-name">${tag.name}</span>
              <span class="int-tag-count">${formatNumber(tag.subscribers_count)}</span>
            </div>
          `)}
          ${topTags.length === 0 ? html`<div class="int-empty">No tags found</div>` : nothing}
        </div>
      </div>
    </div>
  `;
}

function renderSearch(placeholder: string): TemplateResult {
  return html`
    <label class="int-search">
      ${icons.search}
      <span class="int-sr">${placeholder}</span>
      <input type="text" placeholder=${placeholder} .value=${_state.searchQuery}
        @input=${(e: Event) => { _state.searchQuery = (e.target as HTMLInputElement).value; _requestUpdate?.(); }}/>
    </label>
  `;
}

function renderFlows(): TemplateResult {
  const flows = _state.manychat.flows.filter(f =>
    !_state.searchQuery || f.name.toLowerCase().includes(_state.searchQuery.toLowerCase())
  );

  return html`
    <div class="int-flows">
      <div class="int-toolbar">
        ${renderSearch('Search flows...')}
        <div class="int-toolbar-actions">
          <div class="int-view-toggle" role="group" aria-label="View mode">
            <button class="gt-btn int-btn int-btn--icon ${_state.viewMode === 'grid' ? 'active' : ''}" aria-label="Grid view"
              aria-pressed=${_state.viewMode === 'grid' ? 'true' : 'false'}
              @click=${() => { _state.viewMode = 'grid'; _requestUpdate?.(); }}>
              ${icons.grid}
            </button>
            <button class="gt-btn int-btn int-btn--icon ${_state.viewMode === 'list' ? 'active' : ''}" aria-label="List view"
              aria-pressed=${_state.viewMode === 'list' ? 'true' : 'false'}
              @click=${() => { _state.viewMode = 'list'; _requestUpdate?.(); }}>
              ${icons.list}
            </button>
          </div>
          <a href="https://manychat.com" target="_blank" class="gt-btn gt-primary int-btn int-btn--primary">
            ${icons.plus} Create Flow
          </a>
        </div>
      </div>

      ${_state.viewMode === 'grid' ? html`
        <div class="int-grid">
          ${flows.map((flow, i) => html`
            <div class="int-flow-card gt-glass gt-lift gt-rise" style="--gt-i:${Math.min(i, 12)}" @click=${() => openFlowModal(flow)}>
              <div class="int-flow-header">
                <span class="int-flow-icon">${icons.message}</span>
                <span class="int-badge ${flow.status === 'active' ? 'success' : 'muted'}">${flow.status}</span>
              </div>
              <h4>${flow.name}</h4>
              <p>${getFlowTypeLabel(flow.type)}</p>
              <div class="int-flow-footer">
                <span class="int-flow-date">${icons.clock} ${formatDate(flow.updated_at)}</span>
              </div>
            </div>
          `)}
        </div>
      ` : html`
        <div class="int-list int-list--lg">
          ${flows.map(flow => html`
            <div class="int-list-item" @click=${() => openFlowModal(flow)}>
              <div class="int-list-icon">${icons.message}</div>
              <div class="int-list-content">
                <span class="int-list-title">${flow.name}</span>
                <span class="int-list-meta">${getFlowTypeLabel(flow.type)} • ${formatDate(flow.updated_at)}</span>
              </div>
              <span class="int-badge ${flow.status === 'active' ? 'success' : 'muted'}">${flow.status}</span>
            </div>
          `)}
        </div>
      `}

      ${flows.length === 0 ? html`
        <div class="int-empty-lg">
          ${icons.flow}
          <span>No flows found</span>
        </div>
      ` : nothing}
    </div>
  `;
}

function renderAutomations(): TemplateResult {
  return html`
    <div class="int-automations">
      <div class="int-toolbar">
        ${renderSearch('Search automations...')}
      </div>

      <div class="int-list int-list--lg">
        ${_state.manychat.automations.map(auto => html`
          <div class="int-automation-item">
            <div class="int-automation-info">
              <div class="int-automation-icon ${auto.status === 'active' ? 'active' : ''}">${icons.zap}</div>
              <div>
                <h4>${auto.name}</h4>
                <span class="int-automation-type">${auto.type}</span>
              </div>
            </div>
            <div class="int-toggle ${auto.status === 'active' ? 'on' : ''}"
              role="switch" tabindex="0" aria-label="Toggle ${auto.name}"
              aria-checked=${auto.status === 'active' ? 'true' : 'false'}
              @click=${() => toggleAutomation(auto.id, auto.status !== 'active')}
              @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleAutomation(auto.id, auto.status !== 'active'); } }}>
              <div class="int-toggle-track"></div>
              <div class="int-toggle-thumb"></div>
            </div>
          </div>
        `)}
      </div>
      ${_state.manychat.automations.length === 0 ? html`
        <div class="int-empty-lg">${icons.zap}<span>No automations found</span></div>
      ` : nothing}
    </div>
  `;
}

function renderTags(): TemplateResult {
  const tags = _state.manychat.tags.filter(t =>
    !_state.searchQuery || t.name.toLowerCase().includes(_state.searchQuery.toLowerCase())
  );

  return html`
    <div class="int-tags">
      <div class="int-toolbar">
        ${renderSearch('Search tags...')}
      </div>

      <div class="int-tags-list">
        ${tags.map(tag => html`
          <div class="int-tag-row">
            <div class="int-tag-color" style="background: hsl(${hashCode(tag.name) % 360}, 70%, 58%); color: hsl(${hashCode(tag.name) % 360}, 70%, 58%);"></div>
            <span class="int-tag-name">${tag.name}</span>
            <span class="int-tag-subs">${formatNumber(tag.subscribers_count)} subscribers</span>
          </div>
        `)}
      </div>
      ${tags.length === 0 ? html`<div class="int-empty-lg">${icons.tag}<span>No tags found</span></div>` : nothing}
    </div>
  `;
}

function renderFields(): TemplateResult {
  return html`
    <div class="int-fields">
      <div class="int-list int-list--lg">
        ${_state.manychat.customFields.map(field => html`
          <div class="int-field-item">
            <div class="int-field-icon">${icons.database}</div>
            <div class="int-field-info">
              <h4>${field.name}</h4>
              <span class="int-field-type">${field.type}${field.description ? ` — ${field.description}` : ''}</span>
            </div>
            <code class="int-field-id">${field.id}</code>
          </div>
        `)}
      </div>
      ${_state.manychat.customFields.length === 0 ? html`
        <div class="int-empty-lg">${icons.database}<span>No custom fields found</span></div>
      ` : nothing}
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════
// MAIN RENDER
// ═══════════════════════════════════════════════════════════════

export function renderIntegrationsPanel(businessId = 'default'): TemplateResult {
  _businessId = businessId;
  const manychatCred = _state.credentials.find(c => c.platformId === 'manychat');
  const instagramCred = _state.credentials.find(c => c.platformId === 'instagram');
  const stageName = _state.selectedPlatform === 'manychat' ? 'ManyChat' : 'Instagram Analytics';

  return html`
    ${glassToolsStyle()}
    <style>${GLASS_INTEGRATIONS_CSS}</style>

    <div class="int-panel gt-scope">
      ${glassAurora()}
      ${renderConnectorHub()}

      <section class="int-stage" aria-label="${stageName} workspace">
        <div class="int-stage-label">${stageName} · ${(_state.selectedPlatform === 'manychat' ? manychatCred : instagramCred)?.connected ? 'Workspace' : 'Setup'}</div>
        ${_state.selectedPlatform === 'manychat'
          ? (manychatCred?.connected ? renderDashboard(manychatCred) : renderConnectForm())
          : (instagramCred?.connected ? renderInstagramDashboard(instagramCred) : renderInstagramConnect())
        }
      </section>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════
// INSTAGRAM RENDERING
// ═══════════════════════════════════════════════════════════════

function renderInstagramConnect(): TemplateResult {
  return html`
    <div class="int-connect gt-glass gt-rise">
      <div class="int-connect-hero">
        ${brandLogo('instagram', 'lg')}
        <div>
          <h2>Connect Instagram Analytics</h2>
          <p>View profile stats, video analytics, and content performance</p>
        </div>
      </div>

      <div class="int-connect-form">
        <div class="int-field">
          <label for="int-ig-token">
            <span class="int-field-icon">${icons.key}</span>
            Instagram Access Token
          </label>
          <div class="int-input-group">
            <input id="int-ig-token" type="password" class="gt-input int-input" autocomplete="off"
              placeholder="Enter your access token..."
              .value=${_state.igAccessToken}
              @input=${(e: Event) => { _state.igAccessToken = (e.target as HTMLInputElement).value; _requestUpdate?.(); }}
              @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter') verifyInstagram(); }}/>
            <button class="gt-btn gt-primary int-btn int-btn--primary" ?disabled=${_state.connecting || !_state.igAccessToken}
              @click=${verifyInstagram}>
              ${_state.connecting ? html`<span class="int-spinner"></span>` : icons.link}
              ${_state.connecting ? 'Connecting...' : 'Connect'}
            </button>
          </div>
        </div>

        <div class="int-help">
          <div class="int-help-header">${icons.info} Getting your Access Token</div>
          <ol>
            <li><span>Go to <a href="https://developers.facebook.com/tools/explorer/" target="_blank">Graph API Explorer</a></span></li>
            <li><span>Select your app and get a User Token</span></li>
            <li><span>Add permissions: instagram_basic, instagram_manage_insights, pages_read_engagement</span></li>
            <li><span>Generate and copy the token</span></li>
          </ol>
          <p class="int-help-note">
            Requires Instagram Business/Creator account connected to a Facebook Page.
          </p>
        </div>

        ${_state.verificationResult ? html`
          <div class="int-result ${_state.verificationResult.valid ? 'success' : 'error'}" role="status">
            ${_state.verificationResult.valid ? icons.check : icons.close}
            <span>${_state.verificationResult.valid
              ? `Connected to @${_state.verificationResult.accountName}`
              : (_state.verificationResult.error || 'Invalid access token')}</span>
          </div>
        ` : nothing}
      </div>
    </div>
  `;
}

function mediaTypeBadge(type: InstagramMedia['media_type'], titleCase = false): TemplateResult {
  const [icon, label] = type === 'VIDEO' ? [icons.film, 'Reel'] : type === 'CAROUSEL_ALBUM' ? [icons.layers, 'Album'] : [icons.image, 'Post'];
  return html`${icon} ${titleCase ? label : label.toUpperCase()}`;
}

function renderInstagramDashboard(cred: IntegrationCredential): TemplateResult {
  const profile = _state.instagram.profile;
  const media = _state.instagram.media;
  const insights = _state.instagram.profileInsights;
  const err = _state.instagram.error;
  const verified = verifiedAgo(cred);

  return html`
    <div class="int-dashboard">
      <!-- Header -->
      <div class="int-header gt-glass gt-rise">
        <div class="int-header-left">
          <div class="int-brand">
            ${brandLogo('instagram')}
            <div class="int-brand-info">
              <h2>@${cred.accountName || profile?.username || 'Instagram'}</h2>
              <span class="int-brand-status">
                <span class="gt-light" data-state=${err ? 'warn' : 'ok'} ?data-pulse=${!err}></span>
                <span class="gt-chip" data-tone=${err ? 'warn' : 'ok'}>${err ? 'Partial data' : 'Connected'}</span>
                ${verified ? html`<span class="int-brand-verified">${verified}</span>` : nothing}
              </span>
            </div>
          </div>
        </div>
        <div class="int-header-right">
          <button class="gt-btn int-btn" @click=${loadInstagramData} ?disabled=${_state.instagram.loading}>
            ${icons.refresh} Refresh
          </button>
          <button class="gt-btn gt-danger int-btn int-btn--danger" @click=${disconnectInstagram}>
            Disconnect
          </button>
        </div>
      </div>

      ${_state.instagram.loading ? renderSkeleton('Loading Instagram data...') : html`
        ${err ? html`
          <div class="int-error-banner" role="alert">
            <span class="gt-light" data-state="danger"></span>
            <span>${err}</span>
          </div>
        ` : nothing}

        <!-- Profile Card -->
        ${profile ? html`
          <div class="int-ig-profile gt-glass gt-rise">
            <span class="int-ig-avatar">
              <img class="int-ig-profile-pic" src="${profile.profile_picture_url}" alt="${profile.username}" />
            </span>
            <div class="int-ig-profile-info">
              <h3 class="int-ig-profile-name">${profile.name}</h3>
              <p class="int-ig-profile-username">@${profile.username}</p>
              <div class="int-ig-profile-stats">
                <div class="int-ig-profile-stat">
                  <span class="int-ig-profile-stat-value">${formatNumber(profile.followers_count)}</span>
                  <span class="int-ig-profile-stat-label">Followers</span>
                </div>
                <div class="int-ig-profile-stat">
                  <span class="int-ig-profile-stat-value">${formatNumber(profile.follows_count)}</span>
                  <span class="int-ig-profile-stat-label">Following</span>
                </div>
                <div class="int-ig-profile-stat">
                  <span class="int-ig-profile-stat-value">${formatNumber(profile.media_count)}</span>
                  <span class="int-ig-profile-stat-label">Posts</span>
                </div>
              </div>
              ${profile.biography ? html`<p class="int-ig-profile-bio">${profile.biography}</p>` : nothing}
            </div>
          </div>
        ` : html`
          <div class="int-empty-note">Profile unavailable — check token permissions.</div>
        `}

        <!-- Insights -->
        ${insights ? html`
          <div class="int-ig-insights-grid">
            ${([
              [insights.reach, 'Reach (Today)'],
              [insights.accounts_engaged || 0, 'Engaged'],
              [insights.profile_views, 'Profile Views'],
              [insights.website_clicks, 'Link Clicks'],
            ] as Array<[number, string]>).map(([value, label], i) => html`
              <div class="int-ig-insight-card gt-glass gt-rise" style="--gt-i:${i + 1}">
                <div class="int-ig-insight-value">${formatNumber(value)}</div>
                <div class="int-ig-insight-label">${label}</div>
              </div>
            `)}
          </div>
        ` : html`
          <div class="int-empty-note">Insights unavailable — requires <code>instagram_manage_insights</code> permission.</div>
        `}

        <!-- Recent Media -->
        <div class="int-section int-section--bare">
          <div class="int-section-header">
            <h3>${icons.grid} Recent Posts</h3>
          </div>
        </div>

        <div class="int-ig-media-grid">
          ${media.map((m, i) => html`
            <div class="int-ig-media-card gt-rise" style="--gt-i:${Math.min(i, 12)}" tabindex="0" role="button"
              aria-label="View analytics for ${m.caption?.slice(0, 40) || 'post'}"
              @click=${() => openMediaModal(m)}
              @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openMediaModal(m); } }}>
              <img src="${m.thumbnail_url || m.media_url}" alt="${m.caption?.slice(0, 50) || 'Post'}" loading="lazy" />
              <span class="int-ig-media-type">${mediaTypeBadge(m.media_type)}</span>
              <div class="int-ig-media-stats">
                <span class="int-ig-media-stat">${icons.heart} ${formatNumber(m.like_count)}</span>
                <span class="int-ig-media-stat">${icons.message} ${formatNumber(m.comments_count)}</span>
              </div>
              <div class="int-ig-media-overlay">
                <span>View Analytics</span>
              </div>
            </div>
          `)}
        </div>

        ${media.length === 0 ? html`
          <div class="int-empty-lg">${icons.instagram}<span>No posts found</span></div>
        ` : nothing}
      `}
    </div>

    ${_state.showMediaModal ? renderMediaModal() : nothing}
  `;
}

function renderMediaModal(): TemplateResult {
  const m = _state.selectedMedia;
  if (!m) return html``;

  const engagementRate = m.like_count && _state.instagram.profile?.followers_count
    ? ((m.like_count + m.comments_count) / _state.instagram.profile.followers_count * 100).toFixed(2)
    : '0';

  return html`
    <div class="int-media-modal-overlay" @click=${closeMediaModal}>
      <div class="int-media-modal" role="dialog" aria-modal="true" aria-label="Post analytics" @click=${(e: Event) => e.stopPropagation()}>
        <div class="int-media-modal-header">
          <div class="int-media-modal-type ${m.media_type.toLowerCase()}">
            ${mediaTypeBadge(m.media_type, true)}
          </div>
          <button class="gt-btn int-btn int-btn--icon int-icon-btn" aria-label="Close" @click=${closeMediaModal}>${icons.close}</button>
        </div>

        <div class="int-media-modal-content">
          <div class="int-media-modal-preview">
            ${m.media_type === 'VIDEO' ? html`
              <video src="${m.media_url}" controls poster="${m.thumbnail_url || ''}" playsinline></video>
            ` : html`
              <img src="${m.media_url || m.thumbnail_url}" alt="Post" />
            `}
          </div>

          <div class="int-media-modal-analytics">
            <h3>${icons.trend} Analytics</h3>

            <div class="int-media-stats-grid">
              <div class="int-media-stat-card">
                <span class="int-media-stat-icon">${icons.heart}</span>
                <span class="int-media-stat-value">${formatNumber(m.like_count)}</span>
                <span class="int-media-stat-label">Likes</span>
              </div>
              <div class="int-media-stat-card">
                <span class="int-media-stat-icon">${icons.message}</span>
                <span class="int-media-stat-value">${formatNumber(m.comments_count)}</span>
                <span class="int-media-stat-label">Comments</span>
              </div>
              <div class="int-media-stat-card highlight">
                <span class="int-media-stat-icon">${icons.trend}</span>
                <span class="int-media-stat-value">${engagementRate}%</span>
                <span class="int-media-stat-label">Engagement</span>
              </div>
              ${m.insights?.reach ? html`
                <div class="int-media-stat-card">
                  <span class="int-media-stat-icon">${icons.eye}</span>
                  <span class="int-media-stat-value">${formatNumber(m.insights.reach)}</span>
                  <span class="int-media-stat-label">Reach</span>
                </div>
              ` : nothing}
              ${m.insights?.plays ? html`
                <div class="int-media-stat-card highlight">
                  <span class="int-media-stat-icon">${icons.play}</span>
                  <span class="int-media-stat-value">${formatNumber(m.insights.plays)}</span>
                  <span class="int-media-stat-label">Plays</span>
                </div>
              ` : nothing}
              ${m.insights?.saved ? html`
                <div class="int-media-stat-card">
                  <span class="int-media-stat-icon">${icons.bookmark}</span>
                  <span class="int-media-stat-value">${formatNumber(m.insights.saved)}</span>
                  <span class="int-media-stat-label">Saves</span>
                </div>
              ` : nothing}
              ${m.insights?.shares ? html`
                <div class="int-media-stat-card">
                  <span class="int-media-stat-icon">${icons.share}</span>
                  <span class="int-media-stat-value">${formatNumber(m.insights.shares)}</span>
                  <span class="int-media-stat-label">Shares</span>
                </div>
              ` : nothing}
            </div>

            <div class="int-media-caption">
              <h4>Caption</h4>
              <p>${m.caption?.slice(0, 200) || 'No caption'}${m.caption && m.caption.length > 200 ? '...' : ''}</p>
            </div>

            <div class="int-media-meta">
              ${icons.calendar} <span>${formatTimeAgo(m.timestamp)}</span>
            </div>
          </div>
        </div>

        <div class="int-media-modal-footer">
          <a href="${m.permalink}" target="_blank" class="gt-btn gt-primary int-btn int-btn--primary">
            ${icons.externalLink} View on Instagram
          </a>
        </div>
      </div>
    </div>
  `;
}
