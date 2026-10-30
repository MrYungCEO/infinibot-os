/**
 * Sites view — landing pages with drag-drop blocks, AI code control,
 * Netlify hosting, per-business CRM capture, and KPI tracking.
 *
 * Outer wrapper inherits the page background. Cards have surfaces.
 * No emojis — SVG icons only.
 */

import { html, nothing, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";
import { icon } from "../icons";
import { gatewayOrigin } from "../gateway-endpoint";

// ── Style tokens ────────────────────────────────────────────

const T = {
  cardBg: "color-mix(in srgb, var(--surface, #0c0c0e) 75%, transparent)",
  cardBgRaised: "color-mix(in srgb, var(--surface, #0c0c0e) 88%, transparent)",
  cardBgHover: "color-mix(in srgb, var(--surface, #14141a) 92%, transparent)",
  cardBlur: "blur(14px) saturate(140%)",
  border: "color-mix(in srgb, var(--g-primary) 14%, transparent)",
  borderStrong: "color-mix(in srgb, var(--g-primary) 28%, transparent)",
  borderInactive: "color-mix(in srgb, currentColor 10%, transparent)",
  primary: "var(--g-primary)",
  primarySoft: "color-mix(in srgb, var(--g-primary) 12%, transparent)",
  primaryHover: "color-mix(in srgb, var(--g-primary) 22%, transparent)",
  primaryGlow: "color-mix(in srgb, var(--g-primary) 32%, transparent)",
  text: "var(--text, #e4e4e7)",
  textMuted: "color-mix(in srgb, var(--text, #e4e4e7) 60%, transparent)",
  textDim: "color-mix(in srgb, var(--text, #e4e4e7) 38%, transparent)",
  active: "#22c55e",
  warn: "#f59e0b",
  error: "#ef4444",
  radius: "12px",
  radiusSm: "8px",
  radiusXs: "6px",
  liftShadow: "0 2px 12px rgba(0,0,0,0.35), inset 0 1px 0 color-mix(in srgb, white 6%, transparent)",
  glowShadow: "0 0 24px color-mix(in srgb, var(--g-primary) 18%, transparent)",
  mono: "'JetBrains Mono','SF Mono','Consolas',monospace",
};

// ── Types (mirror server-side shapes) ───────────────────────

interface PageComponent {
  id: string;
  type: string;
  variant?: string;
  order: number;
  visible: boolean;
  [k: string]: unknown;
}

interface LandingPage {
  id: string;
  communityId: string;
  name: string;
  slug: string;
  status: "draft" | "published" | "archived";
  sourceType: "built" | "linked" | "imported";
  components: PageComponent[];
  settings: Record<string, unknown>;
  currentVersion: number;
  publishedAt?: string;
  createdAt: string;
  updatedAt: string;
}

interface PageSiteState {
  pageId: string;
  netlifySiteId?: string;
  netlifySiteName?: string;
  defaultUrl?: string;
  customDomain?: string;
  lastDeploy?: { id: string; state: string; url?: string; createdAtMs: number };
  history: Array<{ id: string; state: string; url?: string; createdAtMs: number }>;
}

interface NetlifyStatus { connected: boolean; user?: { email?: string; full_name?: string } }
interface PageKpi { pageId: string; views: number; uniqueSessions: number; formSubmits: number; ctaClicks: number; }

// ── State ───────────────────────────────────────────────────

interface BusinessBrandingPreview {
  profile: { id: string; name: string; tagline?: string | null; logo?: string | null; website?: string | null } | null;
  branding: {
    colors?: { primary?: string; secondary?: string; accent?: string; background?: string; text?: string };
    fonts?: { heading?: string; body?: string };
    voice?: { tone?: string; audience?: string };
  } | null;
}

interface SitesViewState {
  loading: boolean;
  error: string | null;
  businesses: string[];
  selectedBusinessId: string;
  selectedBusinessBranding: BusinessBrandingPreview | null;
  pages: LandingPage[];
  selectedPageId: string | null;
  selectedPage: LandingPage | null;
  netlify: NetlifyStatus | null;
  netlifyTokenInput: string;
  netlifyConnecting: boolean;
  pageSiteState: PageSiteState | null;
  deployStatus: string | null;
  deploying: boolean;
  showCreate: boolean;
  newPageName: string;
  newPageBusiness: string;
  showAiPrompt: boolean;
  aiPromptText: string;
  pageKpi: PageKpi | null;
  leadsSummary: { total: number; byPage: Record<string, number>; byForm: Record<string, number> } | null;
  recentLeads: Array<{ id: string; pageId: string; formId: string; receivedAtMs: number; data: Record<string, unknown> }>;
  customDomainInput: string;
  rightPanel: "preview" | "code" | "leads" | "kpi" | "deploy" | "brand";
}

function ensureSitesState(state: AppViewState): SitesViewState {
  const s = state as unknown as { sitesState?: SitesViewState };
  if (!s.sitesState) {
    s.sitesState = {
      loading: false, error: null,
      businesses: [], selectedBusinessId: "default", selectedBusinessBranding: null,
      pages: [], selectedPageId: null, selectedPage: null,
      netlify: null, netlifyTokenInput: "", netlifyConnecting: false,
      pageSiteState: null, deployStatus: null, deploying: false,
      showCreate: false, newPageName: "", newPageBusiness: "default",
      showAiPrompt: false, aiPromptText: "",
      pageKpi: null, leadsSummary: null, recentLeads: [],
      customDomainInput: "",
      rightPanel: "preview",
    };
  }
  return s.sitesState;
}

// ── Data fetchers ───────────────────────────────────────────

async function loadBusinesses(view: SitesViewState, client: GatewayBrowserClient) {
  try {
    const r = (await client.request("pages.businesses.list", {})) as { businesses?: string[] };
    view.businesses = (r?.businesses || []).length > 0 ? (r!.businesses as string[]) : ["default"];
    if (!view.businesses.includes(view.selectedBusinessId)) {
      view.selectedBusinessId = view.businesses[0];
    }
  } catch { view.businesses = ["default"]; }
}

async function loadBusinessBranding(view: SitesViewState, client: GatewayBrowserClient) {
  try {
    const r = (await client.request("business.branding.get", { businessId: view.selectedBusinessId })) as BusinessBrandingPreview;
    view.selectedBusinessBranding = r;
  } catch {
    view.selectedBusinessBranding = null;
  }
}

async function applyBusinessBranding(view: SitesViewState, state: AppViewState, client: GatewayBrowserClient) {
  if (!view.selectedPageId) return;
  try {
    const r = (await client.request("pages.applyBusinessBranding", {
      pageId: view.selectedPageId,
      businessId: view.selectedBusinessId,
    })) as { page?: LandingPage; brandingApplied?: boolean; businessName?: string };
    if (r.page) view.selectedPage = r.page;
    view.deployStatus = r.brandingApplied ? `Applied branding from ${r.businessName || "business"}.` : "No branding to apply (no business profile found).";
  } catch (e) {
    view.error = e instanceof Error ? e.message : String(e);
  } finally {
    state.requestUpdate?.();
  }
}

async function saveBusinessBranding(view: SitesViewState, state: AppViewState, client: GatewayBrowserClient, patch: Record<string, unknown>) {
  try {
    await client.request("business.branding.set", { businessId: view.selectedBusinessId, branding: patch });
    await loadBusinessBranding(view, client);
  } catch (e) {
    view.error = e instanceof Error ? e.message : String(e);
  } finally {
    state.requestUpdate?.();
  }
}

async function loadPages(view: SitesViewState, client: GatewayBrowserClient) {
  view.loading = true;
  try {
    const r = (await client.request("community.pages.list", { communityId: view.selectedBusinessId })) as { pages?: LandingPage[] };
    view.pages = r?.pages || [];
  } catch (e) {
    view.error = e instanceof Error ? e.message : String(e);
  } finally {
    view.loading = false;
  }
}

async function loadNetlifyStatus(view: SitesViewState, client: GatewayBrowserClient) {
  try {
    const r = (await client.request("pages.netlify.status", {})) as NetlifyStatus;
    view.netlify = r;
  } catch { view.netlify = { connected: false }; }
}

async function loadPageDetail(view: SitesViewState, client: GatewayBrowserClient, pageId: string) {
  try {
    const r = (await client.request("community.pages.get", { pageId })) as { page?: LandingPage };
    if (r?.page) view.selectedPage = r.page;
    const s = (await client.request("pages.netlify.bindStatus", { pageId })) as PageSiteState;
    view.pageSiteState = s;
    const k = (await client.request("pages.kpi.page", { businessId: view.selectedBusinessId, pageId })) as { kpi?: PageKpi };
    view.pageKpi = k?.kpi || null;
  } catch { /* swallow */ }
}

async function loadLeadsSummary(view: SitesViewState, client: GatewayBrowserClient) {
  try {
    const summary = (await client.request("pages.leads.summary", { businessId: view.selectedBusinessId })) as { total: number; byPage: Record<string, number>; byForm: Record<string, number> };
    view.leadsSummary = summary;
    const list = (await client.request("pages.leads.list", { businessId: view.selectedBusinessId, limit: 25 })) as { submissions?: SitesViewState["recentLeads"] };
    view.recentLeads = list?.submissions || [];
  } catch { /* swallow */ }
}

// ── Actions ─────────────────────────────────────────────────

async function connectNetlify(view: SitesViewState, state: AppViewState, client: GatewayBrowserClient) {
  const tok = view.netlifyTokenInput.trim();
  if (!tok) return;
  view.netlifyConnecting = true; view.error = null;
  state.requestUpdate?.();
  try {
    await client.request("pages.netlify.connect", { token: tok });
    view.netlifyTokenInput = "";
    await loadNetlifyStatus(view, client);
  } catch (e) {
    view.error = e instanceof Error ? e.message : String(e);
  } finally {
    view.netlifyConnecting = false;
    state.requestUpdate?.();
  }
}

async function disconnectNetlify(view: SitesViewState, state: AppViewState, client: GatewayBrowserClient) {
  if (!confirm("Disconnect Netlify? Your token will be removed.")) return;
  await client.request("pages.netlify.disconnect", {});
  await loadNetlifyStatus(view, client);
  state.requestUpdate?.();
}

async function createPage(view: SitesViewState, state: AppViewState, client: GatewayBrowserClient) {
  if (!view.newPageName.trim()) return;
  view.loading = true; view.error = null;
  state.requestUpdate?.();
  try {
    const r = (await client.request("community.pages.create", {
      communityId: view.newPageBusiness || "default",
      name: view.newPageName.trim(),
    })) as { page?: LandingPage };
    if (r?.page) {
      view.selectedPageId = r.page.id;
      view.selectedPage = r.page;
      view.selectedBusinessId = r.page.communityId;
      await loadBusinesses(view, client);
      await loadPages(view, client);
      view.showCreate = false;
      view.newPageName = "";
    }
  } catch (e) {
    view.error = e instanceof Error ? e.message : String(e);
  } finally {
    view.loading = false;
    state.requestUpdate?.();
  }
}

async function deletePage(view: SitesViewState, state: AppViewState, client: GatewayBrowserClient, pageId: string) {
  if (!confirm("Delete this page permanently?")) return;
  await client.request("community.pages.delete", { pageId });
  if (view.selectedPageId === pageId) {
    view.selectedPageId = null;
    view.selectedPage = null;
  }
  await loadPages(view, client);
  state.requestUpdate?.();
}

async function publishPage(view: SitesViewState, state: AppViewState, client: GatewayBrowserClient, pageId: string) {
  await client.request("community.pages.publish", { pageId });
  await loadPages(view, client);
  if (view.selectedPageId === pageId) await loadPageDetail(view, client, pageId);
  state.requestUpdate?.();
}

async function deployPage(view: SitesViewState, state: AppViewState, client: GatewayBrowserClient) {
  if (!view.selectedPageId) return;
  view.deploying = true; view.deployStatus = "Building..."; view.error = null;
  state.requestUpdate?.();
  try {
    const gatewayUrl = gatewayOrigin();
    const r = (await client.request("pages.deploy", {
      pageId: view.selectedPageId,
      gatewayUrl,
      autoCreate: true,
    })) as { ok: boolean; url?: string; deployId?: string; state?: string; error?: string };
    if (!r.ok) throw new Error(r.error || "deploy failed");
    view.deployStatus = `Deployed: ${r.url || r.state}`;
    await loadPageDetail(view, client, view.selectedPageId);
  } catch (e) {
    view.deployStatus = null;
    view.error = e instanceof Error ? e.message : String(e);
  } finally {
    view.deploying = false;
    state.requestUpdate?.();
  }
}

async function setCustomDomain(view: SitesViewState, state: AppViewState, client: GatewayBrowserClient) {
  if (!view.selectedPageId || !view.customDomainInput.trim()) return;
  try {
    await client.request("pages.netlify.setDomain", {
      pageId: view.selectedPageId,
      domain: view.customDomainInput.trim(),
    });
    view.customDomainInput = "";
    await loadPageDetail(view, client, view.selectedPageId);
  } catch (e) {
    view.error = e instanceof Error ? e.message : String(e);
  } finally {
    state.requestUpdate?.();
  }
}

async function editWithAI(view: SitesViewState, state: AppViewState, client: GatewayBrowserClient) {
  if (!view.selectedPageId || !view.aiPromptText.trim()) return;
  try {
    await client.request("pages.editWithAI", {
      pageId: view.selectedPageId,
      prompt: view.aiPromptText.trim(),
    });
    view.aiPromptText = "";
    view.showAiPrompt = false;
    view.deployStatus = "AI request dispatched — check the activity tab.";
  } catch (e) {
    view.error = e instanceof Error ? e.message : String(e);
  } finally {
    state.requestUpdate?.();
  }
}

// ── Block library + builder ─────────────────────────────────

const BLOCK_LIBRARY: Array<{ type: string; label: string; iconName: Parameters<typeof icon>[0]; defaults: Record<string, unknown> }> = [
  { type: "hero",       label: "Hero",       iconName: "image",     defaults: { headline: "Headline goes here", subheadline: "Supporting tagline", alignment: "center", ctaText: "Get Started", ctaUrl: "#" } },
  { type: "features",   label: "Features",   iconName: "gridFour",  defaults: { title: "Why choose us", columns: 3, items: [{ id: "f1", title: "Fast", description: "Lightning quick" }, { id: "f2", title: "Reliable", description: "Always on" }, { id: "f3", title: "Secure", description: "End-to-end safe" }] } },
  { type: "cta",        label: "CTA",        iconName: "send",      defaults: { headline: "Ready to start?", buttonText: "Book a call", buttonUrl: "#" } },
  { type: "form",       label: "Form",       iconName: "fileText",  defaults: { title: "Get in touch", fields: [{ id: "name", name: "name", label: "Name", type: "text", required: true }, { id: "email", name: "email", label: "Email", type: "email", required: true }, { id: "message", name: "message", label: "Message", type: "textarea" }], submitText: "Submit" } },
  { type: "text",       label: "Text",       iconName: "fileText",  defaults: { content: "Your text here." } },
  { type: "footer",     label: "Footer",     iconName: "minus",     defaults: { tagline: "© Your brand", copyright: "All rights reserved.", columns: [] } },
  { type: "custom",     label: "Custom HTML", iconName: "fileCode", defaults: { html: "<div>Custom HTML here</div>" } },
];

async function addBlock(view: SitesViewState, state: AppViewState, client: GatewayBrowserClient, blockType: string) {
  if (!view.selectedPage) return;
  const def = BLOCK_LIBRARY.find((b) => b.type === blockType);
  if (!def) return;
  const order = view.selectedPage.components.length;
  const id = Math.random().toString(36).slice(2, 10);
  try {
    await client.request("community.pages.component.add", {
      pageId: view.selectedPage.id,
      component: { id, type: blockType, variant: "default", order, visible: true, ...def.defaults },
    });
    await loadPageDetail(view, client, view.selectedPage.id);
  } catch (e) {
    view.error = e instanceof Error ? e.message : String(e);
  } finally {
    state.requestUpdate?.();
  }
}

async function removeBlock(view: SitesViewState, state: AppViewState, client: GatewayBrowserClient, componentId: string) {
  if (!view.selectedPage) return;
  await client.request("community.pages.component.remove", { pageId: view.selectedPage.id, componentId });
  await loadPageDetail(view, client, view.selectedPage.id);
  state.requestUpdate?.();
}

async function reorderBlocks(view: SitesViewState, state: AppViewState, client: GatewayBrowserClient, fromIdx: number, toIdx: number) {
  if (!view.selectedPage) return;
  const components = view.selectedPage.components.slice().sort((a, b) => a.order - b.order);
  const [moved] = components.splice(fromIdx, 1);
  components.splice(toIdx, 0, moved);
  const componentIds = components.map((c) => c.id);
  try {
    await client.request("community.pages.component.reorder", { pageId: view.selectedPage.id, componentIds });
    await loadPageDetail(view, client, view.selectedPage.id);
  } finally {
    state.requestUpdate?.();
  }
}

async function updateBlockProp(view: SitesViewState, state: AppViewState, client: GatewayBrowserClient, componentId: string, key: string, value: unknown) {
  if (!view.selectedPage) return;
  try {
    await client.request("community.pages.component.update", {
      pageId: view.selectedPage.id,
      componentId,
      updates: { [key]: value },
    });
    // Optimistic local update — avoids a full refetch on every keystroke.
    const c = view.selectedPage.components.find((x) => x.id === componentId);
    if (c) (c as Record<string, unknown>)[key] = value;
  } catch (e) {
    view.error = e instanceof Error ? e.message : String(e);
  } finally {
    state.requestUpdate?.();
  }
}

// ── Render: pieces ──────────────────────────────────────────

function btn(label: TemplateResult | string, opts: { onClick: () => void; variant?: "primary" | "ghost" | "danger"; disabled?: boolean; iconName?: Parameters<typeof icon>[0]; small?: boolean }): TemplateResult {
  const v = opts.variant || "ghost";
  const styles = v === "primary"
    ? `background:${T.primary}; color:#000; border:none;`
    : v === "danger"
      ? `background:transparent; color:${T.error}; border:1px solid ${T.error};`
      : `background:transparent; color:${T.textMuted}; border:1px solid ${T.border};`;
  const padding = opts.small ? "4px 10px" : "7px 14px";
  return html`
    <button @click=${opts.onClick} ?disabled=${opts.disabled}
      style="
        ${styles}
        border-radius:${T.radiusSm}; padding:${padding}; cursor:pointer;
        font-size:${opts.small ? "9px" : "10px"}; font-weight:600; letter-spacing:0.08em;
        display:inline-flex; align-items:center; gap:6px;
        opacity:${opts.disabled ? 0.5 : 1};
      ">${opts.iconName ? icon(opts.iconName) : nothing}${label}</button>
  `;
}

function renderNetlifyCard(view: SitesViewState, state: AppViewState, client: GatewayBrowserClient): TemplateResult {
  const ns = view.netlify;
  return html`
    <div style="
      border:1px solid ${T.border}; border-radius:${T.radius};
      background:${T.cardBg}; backdrop-filter:${T.cardBlur};
      padding:14px 16px; box-shadow:${T.liftShadow};
    ">
      <div style="display:flex; align-items:center; gap:10px; margin-bottom:10px;">
        <span style="
          width:30px; height:30px; display:inline-flex; align-items:center; justify-content:center;
          border:1px solid ${T.borderStrong}; border-radius:${T.radiusSm};
          background:${T.primarySoft}; color:${T.primary};
        ">${icon("globe")}</span>
        <div style="flex:1; min-width:0;">
          <div style="font-size:11px; font-weight:700; color:${T.text}; letter-spacing:0.04em;">
            Netlify Hosting
          </div>
          ${ns?.connected ? html`
            <div style="font-size:9px; color:${T.active}; letter-spacing:0.08em;">
              CONNECTED${ns.user?.email ? ` · ${ns.user.email}` : ""}
            </div>
          ` : html`
            <div style="font-size:9px; color:${T.textMuted}; letter-spacing:0.04em;">
              Paste a personal access token to enable one-click deploys.
            </div>
          `}
        </div>
        ${ns?.connected
          ? btn("DISCONNECT", { onClick: () => disconnectNetlify(view, state, client), small: true })
          : nothing}
      </div>
      ${!ns?.connected ? html`
        <div style="display:flex; gap:6px;">
          <input type="password" .value=${view.netlifyTokenInput}
            placeholder="Netlify personal access token"
            @input=${(e: Event) => { view.netlifyTokenInput = (e.target as HTMLInputElement).value; }}
            style="
              flex:1; background:${T.cardBgRaised}; border:1px solid ${T.border};
              border-radius:${T.radiusSm}; padding:7px 10px; color:${T.text};
              font-size:11px; font-family:${T.mono};
            " />
          ${btn("CONNECT", { onClick: () => connectNetlify(view, state, client), variant: "primary", iconName: "link", disabled: view.netlifyConnecting })}
        </div>
      ` : nothing}
    </div>
  `;
}

function renderPagesList(view: SitesViewState, state: AppViewState, client: GatewayBrowserClient): TemplateResult {
  return html`
    <div style="
      border:1px solid ${T.border}; border-radius:${T.radius};
      background:${T.cardBg}; backdrop-filter:${T.cardBlur};
      box-shadow:${T.liftShadow}; overflow:hidden;
    ">
      <div style="
        padding:10px 14px; display:flex; align-items:center; gap:8px;
        border-bottom:1px solid ${T.border}; background:${T.cardBgRaised};
      ">
        <span style="font-size:10px; font-weight:700; color:${T.primary}; letter-spacing:0.16em;">
          PAGES
        </span>
        <select .value=${view.selectedBusinessId}
          @change=${async (e: Event) => {
            view.selectedBusinessId = (e.target as HTMLSelectElement).value;
            await loadPages(view, client);
            await loadLeadsSummary(view, client);
            await loadBusinessBranding(view, client);
            state.requestUpdate?.();
          }}
          style="
            background:${T.cardBg}; border:1px solid ${T.border}; color:${T.text};
            border-radius:${T.radiusXs}; padding:3px 8px; font-size:10px;
            font-family:${T.mono};
          ">
          ${view.businesses.map((b) => html`<option value=${b}>${b}</option>`)}
        </select>
        <div style="flex:1;"></div>
        ${btn("NEW", { onClick: () => { view.showCreate = !view.showCreate; state.requestUpdate?.(); }, iconName: "plus", variant: "primary", small: true })}
      </div>
      ${view.showCreate ? html`
        <div style="padding:10px 14px; border-bottom:1px solid ${T.border}; display:grid; gap:6px;">
          <input type="text" .value=${view.newPageName}
            placeholder="Page name"
            @input=${(e: Event) => { view.newPageName = (e.target as HTMLInputElement).value; state.requestUpdate?.(); }}
            style="background:${T.cardBgRaised}; border:1px solid ${T.border}; border-radius:${T.radiusXs}; padding:6px 10px; color:${T.text}; font-size:11px;" />
          <input type="text" .value=${view.newPageBusiness}
            placeholder="Business / community id"
            @input=${(e: Event) => { view.newPageBusiness = (e.target as HTMLInputElement).value; state.requestUpdate?.(); }}
            style="background:${T.cardBgRaised}; border:1px solid ${T.border}; border-radius:${T.radiusXs}; padding:6px 10px; color:${T.text}; font-size:11px; font-family:${T.mono};" />
          <div style="display:flex; gap:6px;">
            ${btn("CREATE", { onClick: () => createPage(view, state, client), variant: "primary", small: true })}
            ${btn("CANCEL", { onClick: () => { view.showCreate = false; state.requestUpdate?.(); }, small: true })}
          </div>
        </div>
      ` : nothing}
      <div style="max-height:380px; overflow-y:auto;">
        ${view.pages.length === 0
          ? html`<div style="padding:24px; text-align:center; font-size:10px; color:${T.textDim}; letter-spacing:0.1em;">NO PAGES YET</div>`
          : view.pages.map((p) => {
            const sel = p.id === view.selectedPageId;
            return html`
              <div @click=${async () => {
                view.selectedPageId = p.id; view.selectedPage = p;
                await loadPageDetail(view, client, p.id);
                state.requestUpdate?.();
              }}
                style="
                  padding:10px 14px; border-bottom:1px solid ${T.borderInactive};
                  cursor:pointer; transition:background .12s ease;
                  background:${sel ? T.primarySoft : "transparent"};
                "
                @mouseenter=${(e: Event) => { if (!sel) (e.currentTarget as HTMLElement).style.background = T.cardBgHover; }}
                @mouseleave=${(e: Event) => { if (!sel) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
              >
                <div style="display:flex; align-items:center; gap:8px;">
                  <span style="font-size:11px; font-weight:600; color:${T.text}; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${p.name}</span>
                  <span style="font-size:8px; padding:1px 6px; border-radius:999px;
                    border:1px solid ${p.status === "published" ? T.active : T.border};
                    color:${p.status === "published" ? T.active : T.textMuted};
                    letter-spacing:0.1em;
                  ">${p.status.toUpperCase()}</span>
                </div>
                <div style="font-size:9px; color:${T.textMuted}; margin-top:2px; font-family:${T.mono};">
                  /${p.slug} · ${p.components.length} blocks
                </div>
              </div>
            `;
          })}
      </div>
    </div>
  `;
}

function renderBlockPalette(view: SitesViewState, state: AppViewState, client: GatewayBrowserClient): TemplateResult {
  if (!view.selectedPage) return html``;
  return html`
    <div style="
      border:1px solid ${T.border}; border-radius:${T.radius};
      background:${T.cardBg}; backdrop-filter:${T.cardBlur};
      box-shadow:${T.liftShadow}; overflow:hidden; margin-top:14px;
    ">
      <div style="padding:8px 14px; border-bottom:1px solid ${T.border}; background:${T.cardBgRaised};">
        <span style="font-size:10px; font-weight:700; color:${T.primary}; letter-spacing:0.16em;">BLOCKS</span>
      </div>
      <div style="padding:10px 14px; display:grid; grid-template-columns:repeat(2, 1fr); gap:6px;">
        ${BLOCK_LIBRARY.map((b) => html`
          <button @click=${() => addBlock(view, state, client, b.type)}
            style="
              display:flex; align-items:center; gap:6px; padding:8px 10px;
              background:transparent; color:${T.text}; border:1px solid ${T.border};
              border-radius:${T.radiusSm}; cursor:pointer;
              font-size:10px; font-weight:600; letter-spacing:0.04em;
              transition: background .12s, border-color .12s;
            "
            @mouseenter=${(e: Event) => { (e.currentTarget as HTMLElement).style.background = T.primarySoft; (e.currentTarget as HTMLElement).style.borderColor = T.borderStrong; }}
            @mouseleave=${(e: Event) => { (e.currentTarget as HTMLElement).style.background = "transparent"; (e.currentTarget as HTMLElement).style.borderColor = T.border; }}
          >
            <span style="display:inline-flex; color:${T.primary};">${icon(b.iconName)}</span>
            ${b.label}
          </button>
        `)}
      </div>
    </div>
  `;
}

function renderBlockEditor(view: SitesViewState, state: AppViewState, client: GatewayBrowserClient): TemplateResult {
  if (!view.selectedPage) {
    return html`
      <div style="
        border:1px solid ${T.border}; border-radius:${T.radius};
        background:${T.cardBg}; backdrop-filter:${T.cardBlur};
        padding:60px 24px; text-align:center;
      ">
        <div style="color:${T.textMuted}; font-size:11px; letter-spacing:0.12em;">SELECT OR CREATE A PAGE TO START</div>
      </div>
    `;
  }
  const sorted = view.selectedPage.components.slice().sort((a, b) => a.order - b.order);
  return html`
    <div style="
      border:1px solid ${T.border}; border-radius:${T.radius};
      background:${T.cardBg}; backdrop-filter:${T.cardBlur};
      box-shadow:${T.liftShadow}; overflow:hidden;
    ">
      <div style="
        padding:10px 14px; border-bottom:1px solid ${T.border}; background:${T.cardBgRaised};
        display:flex; align-items:center; gap:8px; flex-wrap:wrap;
      ">
        <span style="font-size:10px; font-weight:700; color:${T.primary}; letter-spacing:0.16em;">EDIT</span>
        <span style="font-size:11px; color:${T.text}; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
          ${view.selectedPage.name}
        </span>
        ${btn("APPLY BRAND", { onClick: () => applyBusinessBranding(view, state, client), iconName: "palette", small: true })}
        ${btn("AI EDIT", { onClick: () => { view.showAiPrompt = !view.showAiPrompt; state.requestUpdate?.(); }, iconName: "sparkles", small: true })}
        ${btn(view.selectedPage.status === "published" ? "PUBLISHED" : "PUBLISH", {
          onClick: () => publishPage(view, state, client, view.selectedPage!.id),
          variant: view.selectedPage.status === "published" ? "ghost" : "primary",
          small: true,
          disabled: view.selectedPage.status === "published",
        })}
        ${btn("DELETE", { onClick: () => deletePage(view, state, client, view.selectedPage!.id), variant: "danger", iconName: "trash", small: true })}
      </div>
      ${view.showAiPrompt ? html`
        <div style="padding:10px 14px; border-bottom:1px solid ${T.border}; display:grid; gap:6px;">
          <textarea .value=${view.aiPromptText}
            placeholder="Describe a change… e.g., 'make the hero darker, add a 3-step process section, change the CTA to Book a Strategy Call'"
            @input=${(e: Event) => { view.aiPromptText = (e.target as HTMLTextAreaElement).value; }}
            rows="3"
            style="background:${T.cardBgRaised}; border:1px solid ${T.border}; border-radius:${T.radiusSm}; padding:8px 10px; color:${T.text}; font-size:11px; font-family:${T.mono}; resize:vertical;"></textarea>
          <div style="display:flex; gap:6px;">
            ${btn("DISPATCH TO AGENT", { onClick: () => editWithAI(view, state, client), variant: "primary", iconName: "sparkles", small: true })}
            ${btn("CLOSE", { onClick: () => { view.showAiPrompt = false; state.requestUpdate?.(); }, small: true })}
          </div>
        </div>
      ` : nothing}
      <div style="max-height:520px; overflow-y:auto;">
        ${sorted.length === 0
          ? html`<div style="padding:30px; text-align:center; font-size:10px; color:${T.textDim}; letter-spacing:0.1em;">EMPTY — ADD A BLOCK FROM THE PALETTE</div>`
          : sorted.map((c, idx) => renderBlockRow(c, idx, sorted.length, view, state, client))}
      </div>
    </div>
  `;
}

function renderBlockRow(c: PageComponent, idx: number, total: number, view: SitesViewState, state: AppViewState, client: GatewayBrowserClient): TemplateResult {
  return html`
    <div style="
      padding:10px 14px; border-bottom:1px solid ${T.borderInactive};
      display:grid; gap:6px;
    ">
      <div style="display:flex; align-items:center; gap:6px;">
        <span style="
          font-size:8px; padding:1px 6px; border-radius:999px;
          border:1px solid ${T.borderStrong}; color:${T.primary}; letter-spacing:0.1em;
        ">${c.type.toUpperCase()}</span>
        <span style="flex:1; font-size:10px; color:${T.textMuted}; font-family:${T.mono};">#${c.id}</span>
        <button @click=${() => idx > 0 && reorderBlocks(view, state, client, idx, idx - 1)} ?disabled=${idx === 0}
          style="background:transparent;border:1px solid ${T.border};color:${T.textMuted};border-radius:${T.radiusXs};padding:2px 6px;cursor:pointer;font-size:9px;display:inline-flex;">${icon("chevronDown")}</button>
        <button @click=${() => idx < total - 1 && reorderBlocks(view, state, client, idx, idx + 1)} ?disabled=${idx === total - 1}
          style="background:transparent;border:1px solid ${T.border};color:${T.textMuted};border-radius:${T.radiusXs};padding:2px 6px;cursor:pointer;font-size:9px;display:inline-flex;transform:rotate(180deg);">${icon("chevronDown")}</button>
        <button @click=${() => removeBlock(view, state, client, c.id)}
          style="background:transparent;border:1px solid ${T.error};color:${T.error};border-radius:${T.radiusXs};padding:2px 6px;cursor:pointer;font-size:9px;display:inline-flex;">${icon("trash")}</button>
      </div>
      ${renderPropInputs(c, view, state, client)}
    </div>
  `;
}

function renderPropInputs(c: PageComponent, view: SitesViewState, state: AppViewState, client: GatewayBrowserClient): TemplateResult {
  // Render different prop fields per block type. Simple text/number/textarea, no JSON editor.
  const upd = (key: string) => (e: Event) => {
    const v = (e.target as HTMLInputElement | HTMLTextAreaElement).value;
    void updateBlockProp(view, state, client, c.id, key, v);
  };
  const inputStyle = `background:${T.cardBgRaised}; border:1px solid ${T.border}; border-radius:${T.radiusXs}; padding:5px 8px; color:${T.text}; font-size:10px; width:100%;`;
  const labelStyle = `font-size:8px; color:${T.textMuted}; letter-spacing:0.08em; font-weight:700;`;
  const fieldset = (label: string, input: TemplateResult) => html`
    <label style="display:flex; flex-direction:column; gap:2px;">
      <span style=${labelStyle}>${label}</span>
      ${input}
    </label>
  `;
  switch (c.type) {
    case "hero":
      return html`
        ${fieldset("HEADLINE", html`<input type="text" .value=${String(c.headline ?? "")} @input=${upd("headline")} style=${inputStyle} />`)}
        ${fieldset("SUBHEADLINE", html`<input type="text" .value=${String(c.subheadline ?? "")} @input=${upd("subheadline")} style=${inputStyle} />`)}
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px;">
          ${fieldset("CTA TEXT", html`<input type="text" .value=${String(c.ctaText ?? "")} @input=${upd("ctaText")} style=${inputStyle} />`)}
          ${fieldset("CTA URL", html`<input type="text" .value=${String(c.ctaUrl ?? "")} @input=${upd("ctaUrl")} style=${inputStyle} />`)}
        </div>
      `;
    case "cta":
      return html`
        ${fieldset("HEADLINE", html`<input type="text" .value=${String(c.headline ?? "")} @input=${upd("headline")} style=${inputStyle} />`)}
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px;">
          ${fieldset("BUTTON TEXT", html`<input type="text" .value=${String(c.buttonText ?? "")} @input=${upd("buttonText")} style=${inputStyle} />`)}
          ${fieldset("BUTTON URL", html`<input type="text" .value=${String(c.buttonUrl ?? "")} @input=${upd("buttonUrl")} style=${inputStyle} />`)}
        </div>
      `;
    case "form":
      return html`
        ${fieldset("TITLE", html`<input type="text" .value=${String(c.title ?? "")} @input=${upd("title")} style=${inputStyle} />`)}
        ${fieldset("SUBMIT BUTTON", html`<input type="text" .value=${String(c.submitText ?? "Submit")} @input=${upd("submitText")} style=${inputStyle} />`)}
        <div style="font-size:9px; color:${T.textDim}; padding:4px 0;">
          Submissions feed business <span style="color:${T.primary};">${view.selectedBusinessId}</span>'s CRM.
        </div>
      `;
    case "text":
      return html`
        ${fieldset("CONTENT", html`<textarea rows="3" .value=${String(c.content ?? "")} @input=${upd("content")} style="${inputStyle} font-family:${T.mono}; resize:vertical;"></textarea>`)}
      `;
    case "footer":
      return html`
        ${fieldset("TAGLINE", html`<input type="text" .value=${String(c.tagline ?? "")} @input=${upd("tagline")} style=${inputStyle} />`)}
        ${fieldset("COPYRIGHT", html`<input type="text" .value=${String(c.copyright ?? "")} @input=${upd("copyright")} style=${inputStyle} />`)}
      `;
    case "custom":
      return html`
        ${fieldset("HTML", html`<textarea rows="5" .value=${String(c.html ?? "")} @input=${upd("html")} style="${inputStyle} font-family:${T.mono}; resize:vertical;"></textarea>`)}
      `;
    default:
      return html`<div style="font-size:9px; color:${T.textDim};">No inline editor for "${c.type}" yet — use AI Edit.</div>`;
  }
}

function renderRightPanel(view: SitesViewState, state: AppViewState, client: GatewayBrowserClient): TemplateResult {
  const tab = (key: typeof view.rightPanel, label: string) => html`
    <button @click=${() => { view.rightPanel = key; state.requestUpdate?.(); }}
      style="
        background:${view.rightPanel === key ? T.primarySoft : "transparent"};
        color:${view.rightPanel === key ? T.primary : T.textMuted};
        border:1px solid ${view.rightPanel === key ? T.borderStrong : T.border};
        border-radius:${T.radiusXs}; padding:4px 10px; cursor:pointer;
        font-size:9px; font-weight:600; letter-spacing:0.1em;
      ">${label}</button>
  `;
  return html`
    <div style="
      border:1px solid ${T.border}; border-radius:${T.radius};
      background:${T.cardBg}; backdrop-filter:${T.cardBlur};
      box-shadow:${T.liftShadow}; overflow:hidden; height:100%; display:flex; flex-direction:column;
    ">
      <div style="padding:8px 14px; border-bottom:1px solid ${T.border}; background:${T.cardBgRaised}; display:flex; gap:5px; flex-wrap:wrap;">
        ${tab("preview", "PREVIEW")}
        ${tab("brand", "BRAND")}
        ${tab("deploy", "DEPLOY")}
        ${tab("kpi", "KPI")}
        ${tab("leads", "LEADS")}
      </div>
      <div style="flex:1; overflow:auto;">
        ${view.rightPanel === "preview" ? renderPreview(view, client) : nothing}
        ${view.rightPanel === "brand" ? renderBrandPanel(view, state, client) : nothing}
        ${view.rightPanel === "deploy" ? renderDeployPanel(view, state, client) : nothing}
        ${view.rightPanel === "kpi" ? renderKpiPanel(view) : nothing}
        ${view.rightPanel === "leads" ? renderLeadsPanel(view) : nothing}
      </div>
    </div>
  `;
}

function renderPreview(view: SitesViewState, client: GatewayBrowserClient): TemplateResult {
  if (!view.selectedPageId) return html`<div style="padding:30px; text-align:center; color:${T.textDim}; font-size:10px; letter-spacing:0.1em;">NO PAGE SELECTED</div>`;
  // Build an iframe srcdoc by fetching pages.render.preview lazily on tab switch.
  return html`
    <div style="padding:0; height:100%;">
      <iframe id="lp-preview-frame" style="width:100%; height:100%; border:none; background:#fff;"
        @load=${async () => {
          // intentionally empty
        }}></iframe>
      <script>
        (function(){
          var f = document.getElementById('lp-preview-frame');
          // Fire one load via fetch — Lit doesn't expose hooks here, so we run on next tick.
        })();
      </script>
      ${(() => {
        // Trigger preview fetch + write to iframe.
        void (async () => {
          try {
            const r = (await client.request("pages.render.preview", { pageId: view.selectedPageId, gatewayUrl: gatewayOrigin() })) as { html?: string };
            const frame = document.getElementById("lp-preview-frame") as HTMLIFrameElement | null;
            if (frame && r?.html) frame.srcdoc = r.html;
          } catch { /* ignore */ }
        })();
        return nothing;
      })()}
    </div>
  `;
}

function renderDeployPanel(view: SitesViewState, state: AppViewState, client: GatewayBrowserClient): TemplateResult {
  const ps = view.pageSiteState;
  const ns = view.netlify;
  return html`
    <div style="padding:14px 16px; display:grid; gap:14px;">
      ${!ns?.connected ? html`
        <div style="
          padding:10px 12px; background:color-mix(in srgb, ${T.warn} 8%, transparent);
          border:1px solid ${T.warn}; border-radius:${T.radiusSm};
          color:${T.warn}; font-size:10px; line-height:1.5;
        ">Connect Netlify (in the top-right card on the dashboard) to enable deploys.</div>
      ` : nothing}

      <div>
        <div style="font-size:9px; color:${T.textMuted}; letter-spacing:0.12em; margin-bottom:6px;">
          BINDING
        </div>
        ${ps?.netlifySiteId ? html`
          <div style="font-size:11px; color:${T.text};">${ps.netlifySiteName || ps.netlifySiteId}</div>
          <div style="font-size:10px; color:${T.textMuted}; font-family:${T.mono};">${ps.defaultUrl || "(no url)"}</div>
        ` : html`
          <div style="font-size:10px; color:${T.textDim};">Not bound to a Netlify site yet — click DEPLOY and one will be created.</div>
        `}
      </div>

      <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap;">
        ${btn(view.deploying ? "DEPLOYING…" : "DEPLOY NOW", {
          onClick: () => deployPage(view, state, client),
          variant: "primary",
          iconName: "send",
          disabled: view.deploying || !ns?.connected || !view.selectedPageId,
        })}
        ${ps?.lastDeploy?.url ? html`
          <a href=${ps.lastDeploy.url} target="_blank" rel="noopener noreferrer"
            style="
              color:${T.primary}; font-size:10px; letter-spacing:0.08em;
              display:inline-flex; align-items:center; gap:4px; text-decoration:none;
            ">${icon("externalLink")} VIEW LIVE</a>
        ` : nothing}
      </div>

      ${view.deployStatus ? html`
        <div style="
          padding:8px 10px; background:${T.primarySoft};
          border:1px solid ${T.borderStrong}; border-radius:${T.radiusXs};
          font-size:10px; color:${T.primary}; font-family:${T.mono};
        ">${view.deployStatus}</div>
      ` : nothing}

      <div>
        <div style="font-size:9px; color:${T.textMuted}; letter-spacing:0.12em; margin-bottom:6px;">
          CUSTOM DOMAIN
        </div>
        <div style="display:flex; gap:6px;">
          <input type="text" .value=${view.customDomainInput}
            placeholder="${ps?.customDomain || "yourdomain.com"}"
            @input=${(e: Event) => { view.customDomainInput = (e.target as HTMLInputElement).value; }}
            style="flex:1; background:${T.cardBgRaised}; border:1px solid ${T.border}; border-radius:${T.radiusXs}; padding:6px 10px; color:${T.text}; font-size:11px; font-family:${T.mono};" />
          ${btn("SET", { onClick: () => setCustomDomain(view, state, client), variant: "primary", small: true, disabled: !view.customDomainInput.trim() })}
        </div>
      </div>

      ${ps?.history && ps.history.length > 0 ? html`
        <div>
          <div style="font-size:9px; color:${T.textMuted}; letter-spacing:0.12em; margin-bottom:6px;">DEPLOY HISTORY</div>
          ${ps.history.slice(0, 8).map((h) => html`
            <div style="
              display:flex; align-items:center; gap:8px;
              padding:5px 0; border-bottom:1px solid ${T.borderInactive};
              font-size:10px;
            ">
              <span style="color:${h.state === "ready" ? T.active : h.state === "error" ? T.error : T.textMuted}; font-weight:600; letter-spacing:0.08em;">${h.state.toUpperCase()}</span>
              <span style="color:${T.textMuted}; font-family:${T.mono}; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis;">${new Date(h.createdAtMs).toLocaleString()}</span>
              ${h.url ? html`<a href=${h.url} target="_blank" rel="noopener noreferrer" style="color:${T.primary}; display:inline-flex;">${icon("externalLink")}</a>` : nothing}
            </div>
          `)}
        </div>
      ` : nothing}
    </div>
  `;
}

function renderKpiPanel(view: SitesViewState): TemplateResult {
  const k = view.pageKpi;
  if (!k) {
    return html`<div style="padding:30px; text-align:center; color:${T.textDim}; font-size:10px; letter-spacing:0.1em;">NO METRICS YET — DEPLOY AND DRIVE TRAFFIC</div>`;
  }
  const stat = (label: string, value: number | string) => html`
    <div style="
      padding:14px 18px; border:1px solid ${T.border}; border-radius:${T.radiusSm};
      background:${T.cardBgRaised}; box-shadow:${T.liftShadow};
    ">
      <div style="font-size:9px; color:${T.textMuted}; letter-spacing:0.14em; margin-bottom:4px;">${label}</div>
      <div style="font-size:24px; font-weight:600; color:${T.text}; font-family:${T.mono};">${value}</div>
    </div>
  `;
  return html`
    <div style="padding:14px 16px; display:grid; gap:10px; grid-template-columns:repeat(2, 1fr);">
      ${stat("PAGEVIEWS", k.views)}
      ${stat("UNIQUE SESSIONS", k.uniqueSessions)}
      ${stat("FORM SUBMITS", k.formSubmits)}
      ${stat("CTA CLICKS", k.ctaClicks)}
    </div>
  `;
}

function renderBrandPanel(view: SitesViewState, state: AppViewState, client: GatewayBrowserClient): TemplateResult {
  const bp = view.selectedBusinessBranding;
  if (!bp || !bp.profile) {
    return html`
      <div style="padding:24px; display:grid; gap:8px;">
        <div style="font-size:11px; color:${T.textMuted}; line-height:1.5;">
          No business profile found for <span style="color:${T.primary};">${view.selectedBusinessId}</span>.
          Create one on the <strong>Business</strong> tab — it auto-themes new pages and primes agent context.
        </div>
      </div>
    `;
  }
  const colors = bp.branding?.colors ?? {};
  const fonts = bp.branding?.fonts ?? {};
  const voice = bp.branding?.voice ?? {};
  const colorInput = (key: keyof typeof colors, label: string) => html`
    <label style="display:flex; flex-direction:column; gap:3px;">
      <span style="font-size:8px; color:${T.textMuted}; letter-spacing:0.1em; font-weight:700;">${label}</span>
      <div style="display:flex; gap:6px; align-items:center;">
        <input type="color" .value=${(colors[key] || "#000000")}
          @change=${(e: Event) => saveBusinessBranding(view, state, client, { colors: { [key]: (e.target as HTMLInputElement).value } })}
          style="width:40px; height:30px; padding:0; border:1px solid ${T.border}; border-radius:${T.radiusXs}; background:${T.cardBgRaised};" />
        <input type="text" .value=${colors[key] || ""}
          @change=${(e: Event) => saveBusinessBranding(view, state, client, { colors: { [key]: (e.target as HTMLInputElement).value } })}
          placeholder="#000000 or var()"
          style="flex:1; background:${T.cardBgRaised}; border:1px solid ${T.border}; border-radius:${T.radiusXs}; padding:5px 8px; color:${T.text}; font-size:10px; font-family:${T.mono};" />
      </div>
    </label>
  `;
  const fontInput = (key: keyof typeof fonts, label: string) => html`
    <label style="display:flex; flex-direction:column; gap:3px;">
      <span style="font-size:8px; color:${T.textMuted}; letter-spacing:0.1em; font-weight:700;">${label}</span>
      <input type="text" .value=${fonts[key] || ""}
        @change=${(e: Event) => saveBusinessBranding(view, state, client, { fonts: { [key]: (e.target as HTMLInputElement).value } })}
        placeholder='e.g., "Inter, system-ui, sans-serif"'
        style="background:${T.cardBgRaised}; border:1px solid ${T.border}; border-radius:${T.radiusXs}; padding:5px 8px; color:${T.text}; font-size:10px; font-family:${T.mono};" />
    </label>
  `;
  const voiceInput = (key: keyof typeof voice, label: string, placeholder: string) => html`
    <label style="display:flex; flex-direction:column; gap:3px;">
      <span style="font-size:8px; color:${T.textMuted}; letter-spacing:0.1em; font-weight:700;">${label}</span>
      <input type="text" .value=${(voice[key] as string) || ""}
        @change=${(e: Event) => saveBusinessBranding(view, state, client, { voice: { [key]: (e.target as HTMLInputElement).value } })}
        placeholder=${placeholder}
        style="background:${T.cardBgRaised}; border:1px solid ${T.border}; border-radius:${T.radiusXs}; padding:5px 8px; color:${T.text}; font-size:10px;" />
    </label>
  `;
  return html`
    <div style="padding:14px 16px; display:grid; gap:14px;">
      <div style="display:flex; align-items:center; gap:10px;">
        ${bp.profile.logo
          ? html`<img src=${bp.profile.logo} alt="logo" style="width:42px; height:42px; object-fit:contain; border-radius:${T.radiusSm}; background:${T.cardBgRaised}; border:1px solid ${T.border};" />`
          : html`<span style="width:42px; height:42px; display:inline-flex; align-items:center; justify-content:center; border:1px solid ${T.border}; border-radius:${T.radiusSm}; background:${T.cardBgRaised}; color:${T.textMuted};">${icon("briefcase")}</span>`}
        <div style="flex:1; min-width:0;">
          <div style="font-size:13px; font-weight:600; color:${T.text}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${bp.profile.name}</div>
          ${bp.profile.tagline ? html`<div style="font-size:10px; color:${T.textMuted};">${bp.profile.tagline}</div>` : nothing}
        </div>
        ${btn("APPLY TO PAGE", { onClick: () => applyBusinessBranding(view, state, client), variant: "primary", iconName: "palette", small: true, disabled: !view.selectedPageId })}
      </div>

      <div>
        <div style="font-size:9px; color:${T.textMuted}; letter-spacing:0.12em; margin-bottom:6px;">COLORS</div>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
          ${colorInput("primary", "PRIMARY")}
          ${colorInput("accent", "ACCENT")}
          ${colorInput("background", "BACKGROUND")}
          ${colorInput("text", "TEXT")}
        </div>
      </div>

      <div>
        <div style="font-size:9px; color:${T.textMuted}; letter-spacing:0.12em; margin-bottom:6px;">FONTS</div>
        <div style="display:grid; gap:6px;">
          ${fontInput("heading", "HEADING")}
          ${fontInput("body", "BODY")}
        </div>
      </div>

      <div>
        <div style="font-size:9px; color:${T.textMuted}; letter-spacing:0.12em; margin-bottom:6px;">VOICE &amp; TONE (USED BY AGENTS)</div>
        <div style="display:grid; gap:6px;">
          ${voiceInput("tone", "TONE", "e.g., confident, friendly, technical")}
          ${voiceInput("audience", "AUDIENCE", "e.g., SMB founders, fitness coaches")}
        </div>
      </div>

      <div style="
        padding:8px 12px; background:${T.primarySoft}; border:1px solid ${T.borderStrong};
        border-radius:${T.radiusSm}; font-size:10px; color:${T.primary}; line-height:1.5;
      ">
        Agents can call <span style="font-family:${T.mono};">business.brandPrompt</span> to fetch this profile as a system-prompt fragment.
      </div>
    </div>
  `;
}

function renderLeadsPanel(view: SitesViewState): TemplateResult {
  if (!view.recentLeads || view.recentLeads.length === 0) {
    return html`<div style="padding:30px; text-align:center; color:${T.textDim}; font-size:10px; letter-spacing:0.1em;">NO LEADS YET</div>`;
  }
  return html`
    <div>
      ${view.leadsSummary ? html`
        <div style="
          padding:8px 14px; border-bottom:1px solid ${T.border}; background:${T.cardBgRaised};
          font-size:9px; color:${T.textMuted}; letter-spacing:0.08em;
        ">
          ${view.leadsSummary.total} TOTAL · BUSINESS <span style="color:${T.primary};">${view.selectedBusinessId}</span>
        </div>
      ` : nothing}
      ${view.recentLeads.map((l) => html`
        <div style="padding:10px 14px; border-bottom:1px solid ${T.borderInactive};">
          <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
            <span style="font-size:10px; font-family:${T.mono}; color:${T.textMuted};">${new Date(l.receivedAtMs).toLocaleString()}</span>
            <span style="
              font-size:8px; padding:1px 5px; border-radius:999px;
              border:1px solid ${T.borderStrong}; color:${T.primary}; letter-spacing:0.1em;
            ">${l.formId}</span>
          </div>
          <pre style="
            margin:0; font-size:10px; color:${T.text};
            font-family:${T.mono}; white-space:pre-wrap; word-break:break-word;
          ">${JSON.stringify(l.data, null, 2)}</pre>
        </div>
      `)}
    </div>
  `;
}

// ── Main render ─────────────────────────────────────────────

let bootstrapped = false;

export function renderSites(state: AppViewState, client: GatewayBrowserClient): TemplateResult {
  const view = ensureSitesState(state);
  if (!bootstrapped) {
    bootstrapped = true;
    void (async () => {
      await Promise.all([loadBusinesses(view, client), loadNetlifyStatus(view, client)]);
      await loadPages(view, client);
      await loadLeadsSummary(view, client);
      await loadBusinessBranding(view, client);
      state.requestUpdate?.();
    })();
  }

  return html`
    <div style="
      padding:18px 22px; max-width:1600px; margin:0 auto; width:100%; height:100%;
      overflow-y:auto; box-sizing:border-box;
      display:grid; gap:14px;
      grid-template-columns: 360px 1fr 420px;
      grid-template-rows: auto 1fr;
    ">
      <!-- Header (spans full width) -->
      <div style="grid-column:1 / -1; display:flex; align-items:center; gap:14px; flex-wrap:wrap; padding-bottom:10px; border-bottom:1px solid ${T.border};">
        <div style="flex:1; min-width:240px;">
          <div style="font-size:11px; color:${T.primary}; letter-spacing:0.18em; font-weight:700; margin-bottom:2px;">SITES</div>
          <div style="font-size:20px; font-weight:600; color:${T.text};">Landing pages</div>
          <div style="font-size:10px; color:${T.textMuted}; margin-top:2px;">
            Drag-drop blocks · AI code control · Netlify hosting · Per-business CRM &amp; KPIs
          </div>
        </div>
        ${renderNetlifyCard(view, state, client)}
      </div>

      <!-- Left: pages list + block palette -->
      <div style="display:flex; flex-direction:column; min-height:0;">
        ${renderPagesList(view, state, client)}
        ${renderBlockPalette(view, state, client)}
      </div>

      <!-- Center: block editor -->
      <div style="min-height:0;">
        ${renderBlockEditor(view, state, client)}
      </div>

      <!-- Right: preview + deploy + kpi + leads -->
      <div style="min-height:0;">
        ${renderRightPanel(view, state, client)}
      </div>

      ${view.error ? html`
        <div style="
          grid-column:1 / -1;
          padding:8px 12px; background:color-mix(in srgb, ${T.error} 8%, transparent);
          border:1px solid ${T.error}; border-radius:${T.radiusSm}; color:${T.error};
          font-size:10px; letter-spacing:0.04em;
        ">${view.error}</div>
      ` : nothing}
    </div>
  `;
}
