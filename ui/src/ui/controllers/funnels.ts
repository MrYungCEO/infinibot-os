/**
 * Funnels Controller
 * State management and gateway interactions for the funnel system
 */

import type { GatewayBrowserClient } from "../gateway";
import type { Funnel, FunnelStage, FunnelConnection, StageKPI, SOPItem, FunnelStageType } from "../views/funnels-canvas";
import type { FunnelMetrics } from "../views/funnels-kpi-dashboard";

// ══════════════════════════════════════════════════════════════════════════════
// Client Storage
// ══════════════════════════════════════════════════════════════════════════════

let _client: GatewayBrowserClient | null = null;

export function setFunnelsClient(client: GatewayBrowserClient): void {
  _client = client;
}

async function callFunnel(method: string, params?: Record<string, unknown>): Promise<any> {
  if (!_client) throw new Error("Funnels client not initialized");
  return _client.request(method, params ?? {});
}

// ══════════════════════════════════════════════════════════════════════════════
// State
// ══════════════════════════════════════════════════════════════════════════════

export interface FunnelsState {
  // Data
  businesses: Business[];
  funnels: Funnel[];
  selectedFunnelId: string | null;
  selectedStageId: string | null;
  metrics: FunnelMetrics | null;

  // UI State
  loading: boolean;
  error: string | null;
  sidebarCollapsed: boolean;
  detailPanelCollapsed: boolean;
  searchQuery: string;
  statusFilter: "all" | "active" | "draft" | "paused";
  timeRange: "7d" | "30d" | "90d" | "1y";
  kpiView: "overview" | "funnel" | "stages";
  detailTab: "settings" | "kpis" | "sop" | "automations";

  // Canvas state
  canvasZoom: number;
  canvasPan: { x: number; y: number };
  draggedStageType: FunnelStageType | null;

  // Page editor state — keyed by funnelId so switching funnels doesn't drop edits
  pageEditor: PageEditorState;
}

// ── Page Editor types ──────────────────────────────────────────
// Mirrors src/funnels/workspace.ts PageConfig — kept in sync manually
// so the controller can be typed without pulling node imports into the browser.

export type PageFieldKind = "text" | "email" | "phone" | "textarea" | "select" | "checkbox" | "hidden";

export interface PageField {
  id: string;
  label: string;
  kind: PageFieldKind;
  required?: boolean;
  placeholder?: string;
  options?: Array<{ label: string; value: string }>;
  defaultValue?: string;
}

export interface PageConfig {
  slug: string;
  published: boolean;
  title: string;
  headline: string;
  subheadline: string;
  bullets: string[];
  cta: string;
  thankYouUrl: string;
  thankYouHeadline: string;
  thankYouBody: string;
  fields: PageField[];
  theme: {
    primaryColor: string;
    bgColor: string;
    textColor: string;
    fontStack: string;
    logoAsset: string | null;
  };
  honeypotField?: string;
  meta: Record<string, unknown>;
  updatedAt: number;
}

export interface SubmissionLogEntry {
  ts: number;
  ip?: string;
  userAgent?: string;
  payload: Record<string, unknown>;
  leadId?: string;
  rejected?: "honeypot" | "rate_limit" | "validation" | "internal_error";
  error?: string;
}

export type PageEditorSection = "settings" | "copy" | "fields" | "theme" | "submissions" | "preview";

export interface PageEditorState {
  funnelId: string | null;
  config: PageConfig | null;
  loading: boolean;
  saving: boolean;
  dirty: boolean;
  error: string | null;
  section: PageEditorSection;
  submissions: SubmissionLogEntry[];
  submissionsLoading: boolean;
  previewHtml: string | null;
  previewLoading: boolean;
}

interface Business {
  id: string;
  name: string;
  description?: string;
  industry?: string;
}

let _state: FunnelsState = {
  businesses: [],
  funnels: [],
  selectedFunnelId: null,
  selectedStageId: null,
  metrics: null,
  loading: false,
  error: null,
  sidebarCollapsed: false,
  detailPanelCollapsed: true,
  searchQuery: "",
  statusFilter: "all",
  timeRange: "30d",
  kpiView: "overview",
  detailTab: "settings",
  canvasZoom: 1,
  canvasPan: { x: 0, y: 0 },
  draggedStageType: null,
  pageEditor: {
    funnelId: null,
    config: null,
    loading: false,
    saving: false,
    dirty: false,
    error: null,
    section: "settings",
    submissions: [],
    submissionsLoading: false,
    previewHtml: null,
    previewLoading: false,
  },
};

let _requestUpdate: (() => void) | null = null;

// ══════════════════════════════════════════════════════════════════════════════
// Public API
// ══════════════════════════════════════════════════════════════════════════════

export function getFunnelsState(): FunnelsState {
  return _state;
}

export function setFunnelsRequestUpdate(fn: () => void): void {
  _requestUpdate = fn;
}

function update(): void {
  _requestUpdate?.();
}

// ══════════════════════════════════════════════════════════════════════════════
// Business Operations
// ══════════════════════════════════════════════════════════════════════════════

export async function loadBusinesses(): Promise<void> {
  try {
    console.log("[funnels-ctrl] loadBusinesses called");
    const result = await callFunnel("funnels.business.list", {});
    console.log("[funnels-ctrl] loadBusinesses result:", result);
    // Gateway returns data directly (not wrapped in {ok, data})
    const businesses = result.data?.businesses ?? result.businesses;
    if (businesses) {
      _state.businesses = businesses;
      console.log("[funnels-ctrl] Loaded businesses:", _state.businesses.length);
      update();
    }
  } catch (e) {
    console.error("[funnels-ctrl] Failed to load businesses:", e);
  }
}

export async function createBusiness(name: string, description?: string, industry?: string): Promise<Business | null> {
  try {
    console.log("[funnels-ctrl] createBusiness called:", name);
    const result = await callFunnel("funnels.business.create", { name, description, industry });
    console.log("[funnels-ctrl] createBusiness result:", result);
    // Gateway returns data directly (not wrapped in {ok, data})
    const business = result.data?.business ?? result.business;
    if (business) {
      _state.businesses.push(business);
      update();
      return business;
    } else {
      console.error("[funnels-ctrl] createBusiness failed - no business in response:", result);
    }
  } catch (e) {
    console.error("[funnels-ctrl] Failed to create business (exception):", e);
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════════════════
// Funnel Operations
// ══════════════════════════════════════════════════════════════════════════════

export async function loadFunnels(businessId?: string): Promise<void> {
  _state.loading = true;
  _state.error = null;
  update();

  try {
    const result = await callFunnel("funnels.list", { businessId, limit: 100 });
    const funnels = result.data?.funnels ?? result.funnels;
    if (funnels) {
      _state.funnels = funnels.map(mapFunnelFromGateway);
      _state.loading = false;
      update();
    } else {
      throw new Error(result.data?.error ?? result.error ?? "Failed to load funnels");
    }
  } catch (e: any) {
    _state.loading = false;
    _state.error = e.message;
    update();
  }
}

export async function loadFunnel(funnelId: string): Promise<Funnel | null> {
  try {
    const result = await callFunnel("funnels.get", { id: funnelId });
    const funnelData = result.data?.funnel ?? result.funnel;
    if (funnelData) {
      const funnel = mapFunnelFromGateway(funnelData);
      const stages = result.data?.stages ?? result.stages ?? [];
      const connections = result.data?.connections ?? result.connections ?? [];
      funnel.stages = stages.map(mapStageFromGateway);
      funnel.connections = connections.map(mapConnectionFromGateway);
      
      // Update in state
      const idx = _state.funnels.findIndex(f => f.id === funnelId);
      if (idx >= 0) {
        _state.funnels[idx] = funnel;
      } else {
        _state.funnels.push(funnel);
      }
      update();
      return funnel;
    }
  } catch (e) {
    console.error("Failed to load funnel:", e);
  }
  return null;
}

export async function createFunnel(businessId: string, name: string, description?: string, type?: string): Promise<Funnel | null> {
  try {
    const result = await callFunnel("funnels.create", { businessId, name, description, type: type || "sales" });
    const funnelData = result.data?.funnel ?? result.funnel;
    if (funnelData) {
      const funnel = mapFunnelFromGateway(funnelData);
      _state.funnels.push(funnel);
      _state.selectedFunnelId = funnel.id;
      update();
      return funnel;
    }
  } catch (e) {
    console.error("Failed to create funnel:", e);
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════════════════
// Template Definitions
// ══════════════════════════════════════════════════════════════════════════════

export type FunnelTemplate = "highTicket" | "midTicket" | "lowTicket" | "multiOffer" | "brandAwareness" | "leadMagnet";

interface TemplateStage {
  name: string;
  type: FunnelStageType;
  description?: string;
}

const FUNNEL_TEMPLATES: Record<FunnelTemplate, { name: string; description: string; stages: TemplateStage[] }> = {
  highTicket: {
    name: "High-Ticket Coaching ($3K+)",
    description: "Personal brand to premium 1:1 or group coaching offer",
    stages: [
      { name: "Authority Content", type: "content", description: "Reels, carousels, thought leadership" },
      { name: "Story Engagement", type: "engagement", description: "DMs, comments, story replies" },
      { name: "Lead Qualification", type: "capture", description: "Application form, quiz" },
      { name: "Discovery Call", type: "nurture", description: "Strategy session booking" },
      { name: "Close Call", type: "convert", description: "Enrollment conversation" },
    ],
  },
  midTicket: {
    name: "Mid-Ticket Program ($500-2K)",
    description: "Group program or digital course with community",
    stages: [
      { name: "Value Content", type: "content", description: "Educational posts, tips, frameworks" },
      { name: "Community Building", type: "engagement", description: "Lives, Q&As, engagement pods" },
      { name: "Lead Magnet", type: "capture", description: "Free guide, mini-course, workshop" },
      { name: "Email Nurture", type: "nurture", description: "Value sequence + case studies" },
      { name: "Launch / Evergreen", type: "convert", description: "Sales page, cart open" },
    ],
  },
  lowTicket: {
    name: "Low-Ticket Offer ($27-197)",
    description: "Self-serve digital product or template",
    stages: [
      { name: "Viral Content", type: "content", description: "Hooks, trends, shareable posts" },
      { name: "Profile Visit", type: "engagement", description: "Bio click, highlight views" },
      { name: "Freebie Opt-in", type: "capture", description: "Link in bio, landing page" },
      { name: "Tripwire Email", type: "nurture", description: "Immediate low-ticket offer" },
      { name: "Checkout", type: "convert", description: "Quick purchase flow" },
    ],
  },
  brandAwareness: {
    name: "Brand Awareness Engine",
    description: "Top-of-funnel content machine for reach & authority",
    stages: [
      { name: "Hook Content", type: "content", description: "Scroll-stopping reels & posts" },
      { name: "Value Stacking", type: "content", description: "Carousels, threads, deep dives" },
      { name: "Social Proof", type: "engagement", description: "Testimonials, results, collabs" },
      { name: "Community Touch", type: "engagement", description: "Comments, shares, saves" },
      { name: "Profile Convert", type: "capture", description: "Follow → Bio link click" },
    ],
  },
  leadMagnet: {
    name: "Lead Magnet Funnel",
    description: "Build email list with free valuable resource",
    stages: [
      { name: "Problem Aware Content", type: "content", description: "Pain point posts" },
      { name: "Solution Tease", type: "engagement", description: "Comment 'GUIDE' to get it" },
      { name: "Opt-in Page", type: "capture", description: "Landing page with form" },
      { name: "Delivery + Welcome", type: "nurture", description: "Email with freebie + intro" },
      { name: "Soft Pitch", type: "convert", description: "Related offer mention" },
    ],
  },
  multiOffer: {
    name: "Multi-Offer Value Ladder",
    description: "3-tier offer stack: low → mid → high ticket ascension",
    stages: [
      { name: "Content Engine", type: "content", description: "Daily value posts, reels, stories" },
      { name: "Engagement Layer", type: "engagement", description: "DMs, comments, community" },
      { name: "Free Resource", type: "capture", description: "Lead magnet opt-in" },
      { name: "Low-Ticket ($27-97)", type: "convert", description: "Tripwire offer, quick win" },
      { name: "Nurture Sequence", type: "nurture", description: "Value + case studies" },
      { name: "Mid-Ticket ($500-2K)", type: "convert", description: "Course or group program" },
      { name: "VIP Nurture", type: "nurture", description: "Results spotlight, exclusivity" },
      { name: "High-Ticket ($3K+)", type: "convert", description: "1:1 coaching, mastermind" },
    ],
  },
};

export async function createFunnelWithTemplate(
  businessId: string, 
  template: FunnelTemplate,
  customName?: string
): Promise<Funnel | null> {
  console.log("[funnels-ctrl] createFunnelWithTemplate called", { businessId, template, customName });
  const templateDef = FUNNEL_TEMPLATES[template];
  if (!templateDef) {
    console.error("[funnels-ctrl] Unknown template:", template);
    return null;
  }

  try {
    // 1. Create the funnel
    const name = customName || templateDef.name;
    console.log("[funnels-ctrl] Creating funnel:", name);
    const result = await callFunnel("funnels.create", { 
      businessId, 
      name, 
      description: templateDef.description,
      type: "sales" 
    });
    console.log("[funnels-ctrl] funnels.create result:", result);
    
    const funnelData = result.data?.funnel ?? result.funnel;
    if (!funnelData) {
      console.error("[funnels-ctrl] Failed to create funnel, result:", result);
      throw new Error("Failed to create funnel");
    }

    const funnel = mapFunnelFromGateway(funnelData);
    funnel.stages = [];
    funnel.connections = [];
    console.log("[funnels-ctrl] Mapped funnel:", funnel);

    // 2. Create stages with positions
    const stageIds: string[] = [];
    const baseX = 100;
    const spacing = 280;

    for (let i = 0; i < templateDef.stages.length; i++) {
      const stageDef = templateDef.stages[i];
      const gatewayType = mapStageTypeToGateway(stageDef.type);
      console.log("[funnels-ctrl] Adding stage:", stageDef.name, stageDef.type, "-> gateway type:", gatewayType);
      const stageResult = await callFunnel("funnels.stage.add", {
        funnelId: funnel.id,
        name: stageDef.name,
        type: gatewayType,
        description: stageDef.description,
        position: i,
      });
      console.log("[funnels-ctrl] stage.add result:", stageResult);

      const stageData = stageResult.data?.stage ?? stageResult.stage;
      if (stageData) {
        const stage = mapStageFromGateway(stageData);
        stage.position = { x: baseX + (i * spacing), y: 150 };
        stage.description = stageDef.description;
        funnel.stages.push(stage);
        stageIds.push(stage.id);
        console.log("[funnels-ctrl] Added stage:", stage);
      }
    }

    // 3. Connect stages sequentially
    console.log("[funnels-ctrl] Connecting stages:", stageIds);
    for (let i = 0; i < stageIds.length - 1; i++) {
      const connResult = await callFunnel("funnels.stage.connect", {
        funnelId: funnel.id,
        sourceStageId: stageIds[i],
        targetStageId: stageIds[i + 1],
      });

      const connData = connResult.data?.connection ?? connResult.connection;
      if (connData) {
        funnel.connections.push(mapConnectionFromGateway(connData));
      }
    }

    // 4. Add to state and select
    console.log("[funnels-ctrl] Final funnel before adding to state:", funnel);
    console.log("[funnels-ctrl] Funnel has", funnel.stages.length, "stages and", funnel.connections.length, "connections");
    _state.funnels.push(funnel);
    _state.selectedFunnelId = funnel.id;
    console.log("[funnels-ctrl] State after update:", { funnelsCount: _state.funnels.length, selectedId: _state.selectedFunnelId });
    update();
    
    return funnel;
  } catch (e) {
    console.error("[funnels-ctrl] Failed to create funnel with template:", e);
  }
  return null;
}

export function getTemplates(): { id: FunnelTemplate; name: string; description: string; stageCount: number }[] {
  return Object.entries(FUNNEL_TEMPLATES).map(([id, def]) => ({
    id: id as FunnelTemplate,
    name: def.name,
    description: def.description,
    stageCount: def.stages.length,
  }));
}

export async function updateFunnel(funnelId: string, patch: Partial<Funnel>): Promise<void> {
  try {
    const result = await callFunnel("funnels.update", { id: funnelId, ...patch });
    const funnelData = result.data?.funnel ?? result.funnel;
    if (funnelData) {
      const idx = _state.funnels.findIndex(f => f.id === funnelId);
      if (idx >= 0) {
        _state.funnels[idx] = { ..._state.funnels[idx], ...mapFunnelFromGateway(funnelData) };
        update();
      }
    }
  } catch (e) {
    console.error("Failed to update funnel:", e);
  }
}

export async function duplicateFunnel(funnelId: string, newName?: string): Promise<Funnel | null> {
  try {
    const result = await callFunnel("funnels.duplicate", { id: funnelId, name: newName });
    const funnelData = result.data?.funnel ?? result.funnel;
    if (funnelData) {
      const funnel = mapFunnelFromGateway(funnelData);
      _state.funnels.push(funnel);
      update();
      return funnel;
    }
  } catch (e) {
    console.error("Failed to duplicate funnel:", e);
  }
  return null;
}

export async function deleteFunnel(funnelId: string): Promise<void> {
  try {
    const result = await callFunnel("funnels.delete", { id: funnelId });
    // Delete is successful if we got a response (it returns {deleted: true})
    if (result.ok !== false && (result.deleted || result.data?.deleted)) {
      _state.funnels = _state.funnels.filter(f => f.id !== funnelId);
      if (_state.selectedFunnelId === funnelId) {
        _state.selectedFunnelId = null;
      }
      update();
    }
  } catch (e) {
    console.error("Failed to delete funnel:", e);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Stage Operations
// ══════════════════════════════════════════════════════════════════════════════

export async function addStage(
  funnelId: string,
  name: string,
  type: FunnelStageType,
  position?: { x: number; y: number },
  description?: string,
): Promise<FunnelStage | null> {
  try {
    const gatewayType = mapStageTypeToGateway(type);
    console.log("[funnels-ctrl] addStage:", name, type, "-> gateway type:", gatewayType);
    const result = await callFunnel("funnels.stage.add", {
      funnelId,
      name,
      type: gatewayType,
      description,
    });
    console.log("[funnels-ctrl] addStage result:", result);
    const stageData = result.data?.stage ?? result.stage;
    if (stageData) {
      const stage = mapStageFromGateway(stageData);
      if (position) {
        stage.position = position;
      }
      // The gateway may not echo back the description on every backend
      // version — stamp it locally so the canvas renderer can show it
      // immediately, no round-trip needed.
      if (description) stage.description = description;

      // Add to funnel
      const funnel = _state.funnels.find((f) => f.id === funnelId);
      if (funnel) {
        funnel.stages.push(stage);
        update();
      }
      return stage;
    }
  } catch (e) {
    console.error("[funnels-ctrl] Failed to add stage:", e);
  }
  return null;
}

/**
 * Apply the canonical "no template selected" stage set to a funnel.
 * Both the new-funnel dialog and the onboarding wizard route through
 * here so the default funnel looks the same no matter which entry
 * point the user came from — and ships with descriptions, so an
 * untemplated funnel doesn't look bare next to a real template.
 */
export async function applyDefaultStages(funnelId: string): Promise<void> {
  const DEFAULT_STAGES: Array<{
    name: string;
    type: FunnelStageType;
    description: string;
    position: { x: number; y: number };
  }> = [
    {
      name: "Attract",
      type: "content",
      description: "Where strangers first meet you — content, ads, search.",
      position: { x: 100, y: 150 },
    },
    {
      name: "Engage",
      type: "engagement",
      description: "Comments, DMs, replies — the first real conversation.",
      position: { x: 380, y: 150 },
    },
    {
      name: "Convert",
      type: "convert",
      description: "The ask. Booking, opt-in, or checkout.",
      position: { x: 660, y: 150 },
    },
  ];
  for (const s of DEFAULT_STAGES) {
    await addStage(funnelId, s.name, s.type, s.position, s.description);
  }
}

export async function updateStage(stageId: string, patch: Partial<FunnelStage>): Promise<void> {
  try {
    const result = await callFunnel("funnels.stage.update", { id: stageId, ...patch });
    // Update succeeded if we got a response (result.stage exists or result.ok !== false)
    if (result.ok !== false || result.stage) {
      // Update in local state
      for (const funnel of _state.funnels) {
        const idx = funnel.stages.findIndex(s => s.id === stageId);
        if (idx >= 0) {
          funnel.stages[idx] = { ...funnel.stages[idx], ...patch };
          update();
          break;
        }
      }
    }
  } catch (e) {
    console.error("Failed to update stage:", e);
  }
}

export async function deleteStage(stageId: string): Promise<void> {
  try {
    const result = await callFunnel("funnels.stage.delete", { id: stageId });
    // Delete succeeded if we got a response
    if (result.ok !== false && (result.deleted || result.data?.deleted)) {
      for (const funnel of _state.funnels) {
        funnel.stages = funnel.stages.filter(s => s.id !== stageId);
        funnel.connections = funnel.connections.filter(c => c.source !== stageId && c.target !== stageId);
      }
      if (_state.selectedStageId === stageId) {
        _state.selectedStageId = null;
      }
      update();
    }
  } catch (e) {
    console.error("Failed to delete stage:", e);
  }
}

export async function connectStages(funnelId: string, sourceId: string, targetId: string, label?: string): Promise<void> {
  try {
    const result = await callFunnel("funnels.stage.connect", { funnelId, sourceStageId: sourceId, targetStageId: targetId, label });
    const connData = result.data?.connection ?? result.connection;
    if (connData) {
      const funnel = _state.funnels.find(f => f.id === funnelId);
      if (funnel) {
        funnel.connections.push(mapConnectionFromGateway(connData));
        update();
      }
    }
  } catch (e) {
    console.error("Failed to connect stages:", e);
  }
}

export async function disconnectStages(funnelId: string, connectionId: string): Promise<void> {
  const funnel = _state.funnels.find(f => f.id === funnelId);
  if (!funnel) return;
  // Optimistic remove so the edge disappears immediately; restore on failure.
  const idx = funnel.connections.findIndex(c => c.id === connectionId);
  const removed = idx >= 0 ? funnel.connections.splice(idx, 1)[0] : null;
  update();
  try {
    await callFunnel("funnels.stage.disconnect", { connectionId });
  } catch (e) {
    console.error("Failed to disconnect stages:", e);
    if (removed) {
      funnel.connections.splice(idx, 0, removed);
      update();
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// KPI Operations
// ══════════════════════════════════════════════════════════════════════════════

export function addKPI(stageId: string, kpi: Omit<StageKPI, "id">): void {
  for (const funnel of _state.funnels) {
    const stage = funnel.stages.find(s => s.id === stageId);
    if (stage) {
      const newKPI: StageKPI = {
        id: `kpi-${Date.now()}`,
        ...kpi,
      };
      stage.kpis.push(newKPI);
      update();
      break;
    }
  }
}

export function updateKPI(stageId: string, kpiId: string, patch: Partial<StageKPI>): void {
  for (const funnel of _state.funnels) {
    const stage = funnel.stages.find(s => s.id === stageId);
    if (stage) {
      const kpi = stage.kpis.find(k => k.id === kpiId);
      if (kpi) {
        Object.assign(kpi, patch);
        update();
      }
      break;
    }
  }
}

export function deleteKPI(stageId: string, kpiId: string): void {
  for (const funnel of _state.funnels) {
    const stage = funnel.stages.find(s => s.id === stageId);
    if (stage) {
      stage.kpis = stage.kpis.filter(k => k.id !== kpiId);
      update();
      break;
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// SOP Operations
// ══════════════════════════════════════════════════════════════════════════════

export function addSOPItem(stageId: string, label: string): void {
  for (const funnel of _state.funnels) {
    const stage = funnel.stages.find(s => s.id === stageId);
    if (stage) {
      if (!stage.sopItems) stage.sopItems = [];
      stage.sopItems.push({
        id: `sop-${Date.now()}`,
        label,
        completed: false,
      });
      update();
      break;
    }
  }
}

export function toggleSOPItem(stageId: string, itemId: string): void {
  for (const funnel of _state.funnels) {
    const stage = funnel.stages.find(s => s.id === stageId);
    if (stage?.sopItems) {
      const item = stage.sopItems.find(i => i.id === itemId);
      if (item) {
        item.completed = !item.completed;
        update();
      }
      break;
    }
  }
}

export function deleteSOPItem(stageId: string, itemId: string): void {
  for (const funnel of _state.funnels) {
    const stage = funnel.stages.find(s => s.id === stageId);
    if (stage?.sopItems) {
      stage.sopItems = stage.sopItems.filter(i => i.id !== itemId);
      update();
      break;
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Analytics Operations
// ══════════════════════════════════════════════════════════════════════════════

export async function loadAnalytics(funnelId?: string): Promise<void> {
  try {
    const result = await callFunnel("funnels.analytics", { id: funnelId });
    const analytics = result.data?.analytics ?? result.analytics;
    const bottlenecks = result.data?.bottlenecks ?? result.bottlenecks ?? [];
    if (analytics) {
      _state.metrics = mapMetricsFromGateway(analytics, bottlenecks);
      update();
    }
  } catch (e) {
    console.error("Failed to load analytics:", e);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// UI State Operations
// ══════════════════════════════════════════════════════════════════════════════

export function selectFunnel(funnelId: string | null): void {
  _state.selectedFunnelId = funnelId;
  _state.selectedStageId = null;
  if (funnelId) {
    loadFunnel(funnelId);
    loadAnalytics(funnelId);
  }
  update();
}

export function selectStage(stageId: string | null): void {
  _state.selectedStageId = stageId;
  _state.detailPanelCollapsed = stageId === null;
  update();
}

export function setSearchQuery(query: string): void {
  _state.searchQuery = query;
  update();
}

export function setStatusFilter(filter: "all" | "active" | "draft" | "paused"): void {
  _state.statusFilter = filter;
  update();
}

export function toggleSidebarCollapsed(): void {
  _state.sidebarCollapsed = !_state.sidebarCollapsed;
  update();
}

export function toggleDetailPanelCollapsed(): void {
  _state.detailPanelCollapsed = !_state.detailPanelCollapsed;
  update();
}

export function setTimeRange(range: "7d" | "30d" | "90d" | "1y"): void {
  _state.timeRange = range;
  if (_state.selectedFunnelId) {
    loadAnalytics(_state.selectedFunnelId);
  }
  update();
}

export function setKPIView(view: "overview" | "funnel" | "stages"): void {
  _state.kpiView = view;
  update();
}

export function setDetailTab(tab: "settings" | "kpis" | "sop" | "automations"): void {
  _state.detailTab = tab;
  update();
}

export function setDraggedStageType(type: FunnelStageType | null): void {
  _state.draggedStageType = type;
  update();
}

export function setCanvasZoom(zoom: number): void {
  _state.canvasZoom = Math.max(0.25, Math.min(2, zoom));
  update();
}

export function setCanvasPan(pan: { x: number; y: number }): void {
  _state.canvasPan = pan;
  update();
}

// ══════════════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════════════

export function getSelectedFunnel(): Funnel | null {
  return _state.funnels.find(f => f.id === _state.selectedFunnelId) || null;
}

export function getSelectedStage(): FunnelStage | null {
  const funnel = getSelectedFunnel();
  if (!funnel) return null;
  return funnel.stages.find(s => s.id === _state.selectedStageId) || null;
}

// ══════════════════════════════════════════════════════════════════════════════
// Data Mappers
// ══════════════════════════════════════════════════════════════════════════════

function mapFunnelFromGateway(data: any): Funnel {
  return {
    id: data.id,
    name: data.name,
    description: data.description,
    stages: [],
    connections: [],
    createdAt: new Date(data.createdAt).getTime(),
    updatedAt: new Date(data.updatedAt).getTime(),
    status: data.status || "draft",
    totalRevenue: data.totalRevenue || 0,
    totalLeads: data.totalLeads || 0,
  };
}

// Map UI stage types to gateway stage types
const UI_TO_GATEWAY_TYPE: Record<FunnelStageType, string> = {
  content: "entry",
  engagement: "standard",
  capture: "decision",
  nurture: "parking",
  convert: "exit",
  upsell: "standard", // fallback
};

function mapStageTypeToGateway(uiType: FunnelStageType): string {
  return UI_TO_GATEWAY_TYPE[uiType] || "standard";
}

function mapStageFromGateway(data: any): FunnelStage {
  // Map stage type to our UI categories
  const typeMap: Record<string, FunnelStageType> = {
    entry: "content",
    standard: "engagement",
    decision: "capture",
    parking: "nurture",
    exit: "convert",
  };

  return {
    id: data.id,
    type: typeMap[data.type] || "engagement",
    name: data.name,
    description: data.description,
    kpis: [],
    conversionRate: data.conversionRate || 0,
    health: data.health || "healthy",
    automations: data.automations || [],
    position: { x: data.position * 250 || 0, y: 100 },
    sopItems: data.sopItems || [],
  };
}

function mapConnectionFromGateway(data: any): FunnelConnection {
  return {
    id: data.id,
    source: data.sourceStageId,
    target: data.targetStageId,
    label: data.label,
    conversionRate: data.conversionRate,
  };
}

function mapMetricsFromGateway(analytics: any, bottlenecks: any[]): FunnelMetrics {
  return {
    totalRevenue: analytics.totalValue || 0,
    totalLeads: analytics.totalLeads || 0,
    overallConversionRate: analytics.overallConversionRate || 0,
    avgTimeToConvert: analytics.averageDaysToClose || 0,
    stageDropoffs: (bottlenecks || []).map((b: any) => ({
      stageId: b.stageId,
      stageName: b.stageName,
      dropoffRate: 100 - (analytics.stageConversionRates?.[b.stageId] || 0),
    })),
    revenueByStage: Object.entries(analytics.valuePerStage || {}).map(([stageId, revenue]) => ({
      stageId,
      stageName: stageId,
      revenue: revenue as number,
    })),
    dailyStats: [],
    topPerformingFunnels: [],
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// Page Editor Operations
// ══════════════════════════════════════════════════════════════════════════════

export async function loadPageConfig(funnelId: string): Promise<void> {
  _state.pageEditor.funnelId = funnelId;
  _state.pageEditor.loading = true;
  _state.pageEditor.error = null;
  _state.pageEditor.dirty = false;
  update();

  try {
    const result = await callFunnel("funnels.page.config.get", { id: funnelId });
    const config = result.data?.config ?? result.config;
    if (config) {
      _state.pageEditor.config = config as PageConfig;
    } else {
      _state.pageEditor.error = result.data?.error ?? result.error ?? "Page config unavailable";
    }
  } catch (e: any) {
    _state.pageEditor.error = e?.message ?? String(e);
  } finally {
    _state.pageEditor.loading = false;
    update();
  }
}

export function patchPageConfig(patch: Partial<PageConfig>): void {
  if (!_state.pageEditor.config) return;
  _state.pageEditor.config = { ..._state.pageEditor.config, ...patch };
  _state.pageEditor.dirty = true;
  update();
}

export function patchPageTheme(patch: Partial<PageConfig["theme"]>): void {
  if (!_state.pageEditor.config) return;
  _state.pageEditor.config = {
    ..._state.pageEditor.config,
    theme: { ..._state.pageEditor.config.theme, ...patch },
  };
  _state.pageEditor.dirty = true;
  update();
}

export function addPageField(after?: number): void {
  if (!_state.pageEditor.config) return;
  const fields = [..._state.pageEditor.config.fields];
  const id = `custom_${Date.now().toString(36)}`;
  const newField: PageField = { id, label: "New field", kind: "text", required: false, placeholder: "" };
  if (typeof after === "number" && after >= 0 && after < fields.length) {
    fields.splice(after + 1, 0, newField);
  } else {
    fields.push(newField);
  }
  _state.pageEditor.config = { ..._state.pageEditor.config, fields };
  _state.pageEditor.dirty = true;
  update();
}

export function updatePageField(index: number, patch: Partial<PageField>): void {
  if (!_state.pageEditor.config) return;
  const fields = [..._state.pageEditor.config.fields];
  if (index < 0 || index >= fields.length) return;
  fields[index] = { ...fields[index], ...patch };
  _state.pageEditor.config = { ..._state.pageEditor.config, fields };
  _state.pageEditor.dirty = true;
  update();
}

export function deletePageField(index: number): void {
  if (!_state.pageEditor.config) return;
  const fields = _state.pageEditor.config.fields.filter((_, i) => i !== index);
  _state.pageEditor.config = { ..._state.pageEditor.config, fields };
  _state.pageEditor.dirty = true;
  update();
}

export function movePageField(index: number, dir: -1 | 1): void {
  if (!_state.pageEditor.config) return;
  const fields = [..._state.pageEditor.config.fields];
  const target = index + dir;
  if (index < 0 || index >= fields.length || target < 0 || target >= fields.length) return;
  [fields[index], fields[target]] = [fields[target], fields[index]];
  _state.pageEditor.config = { ..._state.pageEditor.config, fields };
  _state.pageEditor.dirty = true;
  update();
}

export function addPageBullet(): void {
  if (!_state.pageEditor.config) return;
  _state.pageEditor.config = {
    ..._state.pageEditor.config,
    bullets: [..._state.pageEditor.config.bullets, ""],
  };
  _state.pageEditor.dirty = true;
  update();
}

export function updatePageBullet(index: number, value: string): void {
  if (!_state.pageEditor.config) return;
  const bullets = [..._state.pageEditor.config.bullets];
  if (index < 0 || index >= bullets.length) return;
  bullets[index] = value;
  _state.pageEditor.config = { ..._state.pageEditor.config, bullets };
  _state.pageEditor.dirty = true;
  update();
}

export function deletePageBullet(index: number): void {
  if (!_state.pageEditor.config) return;
  _state.pageEditor.config = {
    ..._state.pageEditor.config,
    bullets: _state.pageEditor.config.bullets.filter((_, i) => i !== index),
  };
  _state.pageEditor.dirty = true;
  update();
}

export async function savePageConfig(): Promise<void> {
  const editor = _state.pageEditor;
  if (!editor.funnelId || !editor.config) return;
  editor.saving = true;
  editor.error = null;
  update();

  try {
    const result = await callFunnel("funnels.page.config.set", {
      id: editor.funnelId,
      config: editor.config,
    });
    const saved = result.data?.config ?? result.config;
    if (saved) {
      editor.config = saved as PageConfig;
      editor.dirty = false;
      // Refresh preview if currently visible.
      if (editor.section === "preview") {
        await loadPagePreview();
      }
    } else {
      editor.error = result.data?.error ?? result.error ?? "Save failed";
    }
  } catch (e: any) {
    editor.error = e?.message ?? String(e);
  } finally {
    editor.saving = false;
    update();
  }
}

export async function togglePagePublished(): Promise<void> {
  const editor = _state.pageEditor;
  if (!editor.funnelId) return;
  // Save any pending edits first so the publish reflects the latest config.
  if (editor.dirty) await savePageConfig();
  try {
    const result = await callFunnel("funnels.page.publish", { id: editor.funnelId });
    const cfg = result.data?.config ?? result.config;
    if (cfg) {
      editor.config = cfg as PageConfig;
      update();
    }
  } catch (e: any) {
    editor.error = e?.message ?? String(e);
    update();
  }
}

export async function loadPageSubmissions(): Promise<void> {
  const editor = _state.pageEditor;
  if (!editor.funnelId) return;
  editor.submissionsLoading = true;
  update();
  try {
    const result = await callFunnel("funnels.page.submissions", { id: editor.funnelId, limit: 100 });
    const submissions = result.data?.submissions ?? result.submissions ?? [];
    editor.submissions = submissions as SubmissionLogEntry[];
  } catch (e) {
    console.error("Failed to load submissions:", e);
  } finally {
    editor.submissionsLoading = false;
    update();
  }
}

export async function loadPagePreview(): Promise<void> {
  const editor = _state.pageEditor;
  if (!editor.funnelId) return;
  // Save before previewing so the rendered HTML matches the editor state.
  if (editor.dirty) await savePageConfig();
  editor.previewLoading = true;
  update();
  try {
    const result = await callFunnel("funnels.page.preview", { id: editor.funnelId });
    const previewHtml = result.data?.html ?? result.html ?? null;
    editor.previewHtml = previewHtml;
  } catch (e) {
    console.error("Failed to load preview:", e);
  } finally {
    editor.previewLoading = false;
    update();
  }
}

export function setPageEditorSection(section: PageEditorSection): void {
  _state.pageEditor.section = section;
  update();
  if (section === "submissions") {
    void loadPageSubmissions();
  } else if (section === "preview") {
    void loadPagePreview();
  }
}

export function resetPageEditor(): void {
  _state.pageEditor = {
    funnelId: null,
    config: null,
    loading: false,
    saving: false,
    dirty: false,
    error: null,
    section: "settings",
    submissions: [],
    submissionsLoading: false,
    previewHtml: null,
    previewLoading: false,
  };
  update();
}

// ══════════════════════════════════════════════════════════════════════════════
// Initialize
// ══════════════════════════════════════════════════════════════════════════════

export async function initFunnels(client?: GatewayBrowserClient): Promise<void> {
  if (client) {
    setFunnelsClient(client);
  }
  if (!_client) {
    console.warn("Funnels: No client provided, skipping initialization");
    return;
  }
  await loadBusinesses();
  await loadFunnels();
}
