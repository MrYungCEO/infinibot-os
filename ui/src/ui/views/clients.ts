/**
 * Client CRM View — Dynamic Notion-driven CRM dashboard with grid/table/kanban views.
 */

import { html, nothing, type TemplateResult } from "lit";
import "../components/people-chips";
import { baAurora, renderHubLink } from "./ba-glass";
import "./ba-glass/clients.css";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { ref } from "lit/directives/ref.js";
import { keyed } from "lit/directives/keyed.js";
import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";
import type { DynamicClientRecord, ClientsState, NotionDbSchema, NotionPropertySchema } from "../controllers/clients";
import {
  createNotionPullState,
  notionPullStyles,
  renderNotionPullButton,
  type NotionPullState,
} from "../notion-pull";

// Pull-from-Notion state for the clients top bar.
const _clientsPullState: NotionPullState = createNotionPullState();
import {
  getFilteredClients,
  getClientsByGroup,
  getGroupableProperties,
  getGroupOptions,
  setClientsGroupBy,
  getDefaultGroupBy,
  resolveGroupBy,
  isMultiValueType,
  CLIENTS_GROUP_BY_NONE,
  CLIENTS_UNGROUPED_COLUMN,
  getTitleProperty,
  getClientName,
  createClient,
  updateClient,
  updateClientProperty,
  deleteClient,
  loadClients,
  createNotionCrmDatabase,
  syncClientsToNotion,
  importClientsFromNotion,
  connectNotionFromUrl,
  parseNotionDatabaseUrl,
  importClientsFromText,
  disconnectNotionCrmDatabase,
  setDetailTab,
  openClientDetail,
  closeClientDetail,
  setDocsDraft,
  saveDocs,
  setClientProperty,
  loadRelationsForDetail,
  loadRelationCatalogs,
  linkClientPeer,
  unlinkClientPeer,
  linkClientCampaign,
  setRelationPickerOpen,
  setRelationPickerQuery,
  getClientCampaignId,
  getClientPlaceholders,
  getClientCampaignRelations,
  loadCampaignPickerOptions,
  assignClientCampaign,
  saveCampaignPlaceholders,
  generateClientContext,
  CLIENT_CAMPAIGN_PLACEHOLDERS_KEY,
  loadDetailRevenue,
  logDetailRevenue,
  loadDetailActivity,
  logDetailActivity,
  loadPageRevenue,
  logPageRevenue,
  GRID_WINDOW_BASE,
  GRID_WINDOW_STEP,
  TABLE_WINDOW_BASE,
  TABLE_WINDOW_STEP,
  KANBAN_COL_WINDOW_BASE,
  KANBAN_COL_WINDOW_STEP,
  type ClientRevenueEntry,
  type ClientActivityEntry,
} from "../controllers/clients";
import { activeBusinessProfile, switchBusiness } from "../controllers/business";
import { consumeDeepLink } from "../app-settings";
// Agency operating system inside the CRM record. The composer, the money
// arithmetic and the payment controls are reused from the invoicing modules —
// nothing here re-implements them.
import { ensureAgencyOperationsState } from "../controllers/agency-operations";
import { loadClientAgencyLink, resetClientAgencyLink } from "../controllers/clients-agency";
import { invoicingStyles, renderInvoiceComposer } from "./agency-invoicing";
import { clientAgencyStyles, renderDetailAgency } from "./clients-agency";
import { renderRelatedPanel } from "../components/related-panel";
// The navigable-graph layer: resolved connection cards + the back-stack thread
// that lets a user walk Client › Opportunity › Project without losing context.
import {
  invalidateConnections,
  objectConnectionsStyles,
  renderConnectedFocus,
  renderConnectionsPanel,
} from "../components/object-connections";
import {
  consumeBootThread,
  renderThreadBreadcrumb,
  threadIsDrilled,
  threadPush,
  threadTop,
} from "../components/object-thread-nav";
import { ensureCovers, renderCoverBanner, renderCoverThumb } from "../components/object-cover";
import { renderObjectReports } from "../components/report-associations";
import { requestChangeNotionDb } from "./change-notion-db-host";
import { requestEmailCompose } from "./email-composer-host";
import { toSanitizedMarkdownHtml } from "../markdown";
import "../components/markdown-editor";

// ── Helpers ──────────────────────────────────────────────────

function hashColor(str: string): string {
  if (!str) str = "?";
  let hash = 0;
  for (let i = 0; i < str.length; i++) { hash = str.charCodeAt(i) + ((hash << 5) - hash); }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 55%, 45%)`;
}

function initials(name: string): string {
  if (!name) return "??";
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

/** Map Notion color names to CSS colors */
function notionColor(color: string): string {
  const map: Record<string, string> = {
    default: "#6b7280", gray: "#6b7280", brown: "#92400e", orange: "#ea580c",
    yellow: "#eab308", green: "#22c55e", blue: "#3b82f6", purple: "#a855f7",
    pink: "#ec4899", red: "#ef4444",
  };
  return map[color] ?? map.default;
}

function notionBg(color: string): string {
  const map: Record<string, string> = {
    default: "rgba(107,114,128,0.1)", gray: "rgba(107,114,128,0.1)", brown: "rgba(146,64,14,0.1)",
    orange: "rgba(234,88,12,0.1)", yellow: "rgba(234,179,8,0.1)", green: "rgba(34,197,94,0.1)",
    blue: "rgba(59,130,246,0.1)", purple: "rgba(168,85,247,0.1)", pink: "rgba(236,72,153,0.1)",
    red: "rgba(239,68,68,0.1)",
  };
  return map[color] ?? map.default;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

/** Get the first property value of a given type from client data */
function getFirstValue(client: DynamicClientRecord, schema: NotionDbSchema | null, type: string): any {
  if (!schema || !client?.data) return null;
  for (const [name, prop] of Object.entries(schema.properties)) {
    if (prop.type === type && client.data[name] != null && client.data[name] !== "") {
      return { name, value: client.data[name], prop };
    }
  }
  return null;
}

/** Get the option color for a select/status value */
function getOptionColor(schema: NotionDbSchema | null, propName: string, value: string): string {
  if (!schema) return "default";
  const prop = schema.properties[propName];
  const opt = prop?.options?.find((o) => o.name === value);
  return opt?.color ?? "default";
}

/**
 * Find the canonical Temperature property on the clients schema. Returns
 * its name + the lowercased value currently on the client, or null when
 * the schema doesn't include a temperature property yet (pre-seed users).
 *
 * Matches `Temperature` / `Lead Temperature` / `Heat` (case-insensitive)
 * AND a status property whose option values include cold/warm/hot. This
 * mirrors the server-side resolver in lead-temperature-seed.ts.
 */
function getTemperaturePropertyName(schema: NotionDbSchema | null): string | null {
  if (!schema) return null;
  for (const [name, prop] of Object.entries(schema.properties)) {
    if (/^lead[\s_-]?temperature$|^temperature$|^heat$/i.test(name)) return name;
    if (prop.type === "select" || prop.type === "status") {
      const opts = (prop.options ?? []).map((o) => o.name.toLowerCase());
      if (opts.includes("cold") && opts.includes("warm") && opts.includes("hot")) return name;
    }
  }
  return null;
}

/** Bucket a temperature option name (case-insensitive) into cold/warm/hot. */
function bucketTemperature(value: string | null | undefined): "cold" | "warm" | "hot" | null {
  if (!value) return null;
  const lc = String(value).toLowerCase();
  if (lc.includes("hot")) return "hot";
  if (lc.includes("warm")) return "warm";
  if (lc.includes("cold")) return "cold";
  return null;
}

// ── Social Platform Icons ─────────────────────────────────────

const SOCIAL_PLATFORMS = [
  {
    key: "WhatsApp",
    label: "WhatsApp",
    color: "#25D366",
    href: (v: string) => `https://wa.me/${v.replace(/\D/g, "")}`,
    action: "link" as const,
    icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20">
      <circle cx="12" cy="12" r="12" fill="#25D366"/>
      <path fill="#fff" d="M12 4.8A7.2 7.2 0 0 0 5.6 15.4l-.9 3.2 3.3-.9A7.2 7.2 0 1 0 12 4.8zm0 13.1a5.9 5.9 0 0 1-3-.83l-.22-.13-2.25.59.6-2.2-.14-.22A5.9 5.9 0 1 1 12 17.9zm3.24-4.37c-.18-.09-1.06-.52-1.22-.58s-.28-.09-.4.09-.46.58-.56.7-.21.13-.39.04a4.9 4.9 0 0 1-1.44-.89 5.4 5.4 0 0 1-1-1.24c-.1-.18 0-.27.08-.36s.18-.21.27-.31a1.2 1.2 0 0 0 .18-.3.33.33 0 0 0-.01-.31c-.04-.09-.4-.96-.55-1.31s-.29-.3-.4-.3h-.34a.65.65 0 0 0-.47.22 2 2 0 0 0-.62 1.48 3.47 3.47 0 0 0 .73 1.84 7.94 7.94 0 0 0 3.04 2.69c.43.18.76.29 1.02.37a2.46 2.46 0 0 0 1.13.07 1.84 1.84 0 0 0 1.21-.85 1.49 1.49 0 0 0 .1-.85c-.04-.07-.16-.12-.34-.21z"/>
    </svg>`,
  },
  {
    key: "Telegram",
    label: "Telegram",
    color: "#229ED9",
    href: (v: string) => `https://t.me/${v.replace(/^@/, "")}`,
    action: "link" as const,
    icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20">
      <circle cx="12" cy="12" r="12" fill="#229ED9"/>
      <path fill="#fff" d="M5.49 11.74 17.1 7.18c.55-.2 1.03.13.85.95l-1.96 9.23c-.14.64-.53.8-1.07.5l-2.96-2.18-1.43 1.37c-.16.16-.29.29-.59.29l.21-3 5.43-4.9c.24-.21-.05-.33-.36-.12L8.02 14.35 5.1 13.44c-.64-.2-.65-.64.39-1.07z"/>
    </svg>`,
  },
  {
    key: "Discord",
    label: "Discord",
    color: "#5865F2",
    href: () => "#",
    action: "copy" as const,
    icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20">
      <rect width="24" height="24" rx="5" fill="#5865F2"/>
      <path fill="#fff" d="M19.27 5.33A17.1 17.1 0 0 0 15.07 4a11.9 11.9 0 0 0-.52 1.07 15.75 15.75 0 0 0-4.73 0A11.67 11.67 0 0 0 9.3 4 17.14 17.14 0 0 0 5.1 5.33 18.08 18.08 0 0 0 2 17.3a17.32 17.32 0 0 0 5.27 2.68 12.77 12.77 0 0 0 1.1-1.81 11.2 11.2 0 0 1-1.74-.84l.44-.32a12.33 12.33 0 0 0 10.86 0l.44.32a11.11 11.11 0 0 1-1.74.84A12.5 12.5 0 0 0 17.73 20 17.26 17.26 0 0 0 22 17.3 18.08 18.08 0 0 0 19.27 5.33zm-9.35 8.58c-1 0-1.83-.93-1.83-2.07s.8-2.08 1.83-2.08 1.85.93 1.83 2.08-.81 2.07-1.83 2.07zm6.76 0c-1 0-1.83-.93-1.83-2.07s.8-2.08 1.83-2.08 1.85.93 1.83 2.08-.8 2.07-1.83 2.07z"/>
    </svg>`,
  },
  {
    key: "Instagram",
    label: "Instagram",
    color: "#e1306c",
    href: (v: string) => `https://instagram.com/${v.replace(/^@/, "")}`,
    action: "link" as const,
    icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20">
      <defs><linearGradient id="ig-grad" x1="0%" y1="100%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#f09433"/>
        <stop offset="25%" stop-color="#e6683c"/>
        <stop offset="50%" stop-color="#dc2743"/>
        <stop offset="75%" stop-color="#cc2366"/>
        <stop offset="100%" stop-color="#bc1888"/>
      </linearGradient></defs>
      <rect width="24" height="24" rx="6" fill="url(#ig-grad)"/>
      <rect x="7" y="7" width="10" height="10" rx="3" fill="none" stroke="#fff" stroke-width="1.5"/>
      <circle cx="12" cy="12" r="2.5" fill="none" stroke="#fff" stroke-width="1.5"/>
      <circle cx="16.5" cy="7.5" r="0.8" fill="#fff"/>
    </svg>`,
  },
  {
    key: "Phone",
    label: "Phone",
    color: "#4CAF50",
    href: (v: string) => `tel:${v}`,
    action: "link" as const,
    icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20">
      <circle cx="12" cy="12" r="12" fill="#4CAF50"/>
      <path fill="#fff" d="M16.9 15.4l-2-.2a1.5 1.5 0 0 0-1.2.4l-1.4 1.4a11.4 11.4 0 0 1-5-5l1.4-1.4a1.5 1.5 0 0 0 .4-1.2l-.2-2A1.5 1.5 0 0 0 7.4 6H6a1.5 1.5 0 0 0-1.5 1.6 13.9 13.9 0 0 0 12 12A1.5 1.5 0 0 0 18 18.1v-1.3a1.5 1.5 0 0 0-1.1-1.4z"/>
    </svg>`,
  },
  {
    key: "Email",
    label: "Email",
    color: "#c9a84c",
    href: (v: string) => `mailto:${v}`,
    action: "link" as const,
    icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20">
      <circle cx="12" cy="12" r="12" fill="#c9a84c"/>
      <path fill="#fff" d="M18 8H6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1zm-1.5 1.5-4.5 3-4.5-3zm-10 5.5V10.7l5 3.3 5-3.3V15z"/>
    </svg>`,
  },
] as const;

type SocialKey = typeof SOCIAL_PLATFORMS[number]["key"];

function getSocialValue(c: DynamicClientRecord, key: SocialKey): string | null {
  const v = c.data[key] ?? c.data[key.toLowerCase()] ?? null;
  return v && typeof v === "string" ? v.trim() || null : null;
}

function renderSocialIcons(c: DynamicClientRecord, opts?: { showEmpty?: boolean }) {
  const filled = SOCIAL_PLATFORMS.filter((p) => opts?.showEmpty || getSocialValue(c, p.key));
  if (filled.length === 0) return nothing;
  return html`
    <div class="crm-social-icons" @click=${(e: Event) => e.stopPropagation()}>
      ${filled.map((p) => {
        const val = getSocialValue(c, p.key) ?? "";
        const href = p.action === "copy" ? "#" : p.href(val);
        return html`
          <a
            class="crm-social-icon"
            href=${p.action === "copy" ? "#" : href}
            target=${p.action === "link" ? "_blank" : nothing}
            rel="noopener noreferrer"
            title=${`${p.label}: ${val}`}
            style="--social-color:${p.color}"
            @click=${p.action === "copy"
              ? (e: Event) => {
                  e.preventDefault();
                  navigator.clipboard.writeText(val).catch(() => {});
                }
              : undefined}
          >${unsafeHTML(p.icon)}</a>
        `;
      })}
    </div>
  `;
}

/** Tiny campaign status chip shown on client cards and kanban cards. */
function renderCampaignChip(c: DynamicClientRecord, cs: ClientsState) {
  const id = getClientCampaignId(c);
  if (!id) return nothing;
  const opt = cs.campaignPickerOptions.find((o) => o.id === id);
  const label = opt?.name ?? "Campaign";
  const status = opt?.status ?? "draft";
  return html`<span class="crm-campaign-chip crm-campaign-chip--${status}" title="Campaign: ${label}">${label}</span>`;
}

// ── Styles ───────────────────────────────────────────────────

const clientStyles = html`
<style>
  ${notionPullStyles}
  /* ─── Clients page shell — ambient depth gradient ──────── */
  .crm-page {
    display: flex; flex-direction: column;
    height: 100%; overflow: hidden;
    font-family: -apple-system, 'Inter', 'JetBrains Mono', 'SF Mono', monospace;
    color: #e4e4e7;
    background:
      radial-gradient(ellipse 80% 50% at 0% 0%,
        color-mix(in srgb, var(--g-primary) 7%, transparent),
        transparent 55%),
      radial-gradient(ellipse 70% 60% at 100% 100%,
        color-mix(in srgb, #6366f1 6%, transparent),
        transparent 60%),
      radial-gradient(ellipse 60% 40% at 50% 100%,
        color-mix(in srgb, var(--g-primary) 4%, transparent),
        transparent 65%);
    position: relative;
    isolation: isolate;
  }
  .crm-page::before {
    content: ""; position: absolute; inset: 0; z-index: -1;
    pointer-events: none;
    background:
      linear-gradient(180deg,
        color-mix(in srgb, var(--g-bg, #050505) 88%, transparent),
        color-mix(in srgb, var(--g-bg, #050505) 75%, transparent));
  }

  /* ─── Control bar (glassmorphism) ──────────────────────── */
  .crm-topbar {
    display: flex; align-items: center; justify-content: space-between;
    gap: 12px;
    padding: 12px 18px;
    margin: 14px 14px 0;
    border-radius: 14px;
    background:
      linear-gradient(135deg,
        color-mix(in srgb, var(--g-primary) 6%, transparent),
        transparent 65%),
      linear-gradient(180deg,
        color-mix(in srgb, #fff 3%, transparent),
        color-mix(in srgb, #000 38%, transparent));
    border: 1px solid color-mix(in srgb, var(--g-primary) 18%, transparent);
    box-shadow:
      inset 0 1px 0 color-mix(in srgb, #fff 8%, transparent),
      0 14px 32px rgba(0, 0, 0, 0.34);
    backdrop-filter: blur(18px) saturate(160%);
    flex-shrink: 0; flex-wrap: wrap;
    position: relative; z-index: 4;
  }
  .crm-topbar-left { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .crm-topbar-right { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

  .crm-badge {
    font: 700 9.5px 'JetBrains Mono', monospace;
    text-transform: uppercase; letter-spacing: 0.22em;
    padding: 5px 12px;
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--g-primary) 32%, transparent);
    color: var(--g-primary);
    background:
      linear-gradient(135deg,
        color-mix(in srgb, var(--g-primary) 14%, transparent),
        color-mix(in srgb, var(--g-primary) 6%, transparent));
    box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 8%, transparent);
    display: inline-flex; align-items: center; gap: 6px;
  }
  .crm-badge::before {
    content: ""; width: 6px; height: 6px; border-radius: 50%;
    background: var(--g-primary);
    box-shadow: 0 0 8px color-mix(in srgb, var(--g-primary) 70%, transparent);
  }
  .crm-count {
    font: 500 11px 'Inter', sans-serif;
    color: rgba(255,255,255,0.55);
  }

  .crm-view-toggle {
    display: flex; gap: 2px;
    padding: 3px;
    border-radius: 10px;
    background: color-mix(in srgb, #000 36%, transparent);
    border: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
    box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 4%, transparent);
  }
  .crm-view-btn {
    padding: 6px 14px;
    border: none; background: transparent;
    color: rgba(255,255,255,0.5);
    font: 600 10px 'Inter', sans-serif;
    letter-spacing: 0.08em; text-transform: uppercase;
    border-radius: 7px;
    cursor: pointer;
    transition: all 160ms cubic-bezier(0.2, 0.9, 0.3, 1);
  }
  .crm-view-btn:hover { color: #f5f5f4; background: color-mix(in srgb, #fff 4%, transparent); }
  .crm-view-btn.active {
    background:
      linear-gradient(180deg,
        color-mix(in srgb, var(--g-primary) 22%, transparent),
        color-mix(in srgb, var(--g-primary) 12%, transparent));
    color: var(--g-primary);
    box-shadow:
      inset 0 1px 0 color-mix(in srgb, #fff 12%, transparent),
      0 4px 14px color-mix(in srgb, var(--g-primary) 22%, transparent);
  }

  /* ─── Group-by switcher ────────────────────────────────── */
  .crm-groupby { position: relative; display: inline-flex; }
  .crm-groupby-trigger {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 6px 10px 6px 12px;
    border-radius: 10px;
    background: color-mix(in srgb, #000 36%, transparent);
    border: 1px solid color-mix(in srgb, var(--g-primary) 16%, transparent);
    box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 4%, transparent);
    color: #f5f5f4;
    cursor: pointer;
    transition: border-color 160ms ease, background 160ms ease, box-shadow 160ms ease;
  }
  .crm-groupby-trigger:hover {
    border-color: color-mix(in srgb, var(--g-primary) 34%, transparent);
    background: color-mix(in srgb, #000 28%, transparent);
  }
  .crm-groupby-trigger.is-open {
    border-color: color-mix(in srgb, var(--g-primary) 55%, transparent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--g-primary) 12%, transparent);
  }
  .crm-groupby-label {
    font: 700 8.5px 'JetBrains Mono', monospace;
    text-transform: uppercase; letter-spacing: 0.18em;
    color: rgba(255,255,255,0.42);
  }
  .crm-groupby-value {
    font: 600 11px 'Inter', sans-serif;
    color: var(--g-primary);
    max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .crm-groupby-chevron {
    width: 12px; height: 12px; flex-shrink: 0;
    color: color-mix(in srgb, var(--g-primary) 70%, transparent);
    transition: transform 200ms cubic-bezier(0.2, 0.9, 0.3, 1);
  }
  .crm-groupby-trigger.is-open .crm-groupby-chevron { transform: rotate(180deg); }

  .crm-groupby-menu {
    position: absolute; top: calc(100% + 8px); left: 0;
    min-width: 232px; max-height: 340px; overflow-y: auto;
    padding: 6px;
    border-radius: 12px;
    background:
      linear-gradient(135deg,
        color-mix(in srgb, var(--g-primary) 7%, transparent),
        transparent 60%),
      linear-gradient(180deg, #131211, #0a0a0a);
    border: 1px solid color-mix(in srgb, var(--g-primary) 26%, transparent);
    box-shadow:
      inset 0 1px 0 color-mix(in srgb, #fff 7%, transparent),
      0 18px 40px rgba(0,0,0,0.62);
    backdrop-filter: blur(18px) saturate(160%);
    z-index: 40;
    animation: crmGroupByIn 170ms cubic-bezier(0.2, 0.9, 0.3, 1);
  }
  @keyframes crmGroupByIn {
    from { opacity: 0; transform: translateY(-6px) scale(0.985); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
  }
  .crm-groupby-item {
    display: flex; align-items: center; gap: 9px; width: 100%;
    padding: 8px 10px;
    border: none; border-radius: 8px;
    background: transparent;
    color: rgba(255,255,255,0.72);
    font: 500 11.5px 'Inter', sans-serif;
    text-align: left; cursor: pointer;
    transition: background 130ms ease, color 130ms ease;
  }
  .crm-groupby-item:hover { background: color-mix(in srgb, #fff 6%, transparent); color: #f5f5f4; }
  .crm-groupby-item.is-active {
    background:
      linear-gradient(90deg,
        color-mix(in srgb, var(--g-primary) 18%, transparent),
        color-mix(in srgb, var(--g-primary) 6%, transparent));
    color: var(--g-primary);
  }
  .crm-groupby-glyph {
    width: 18px; text-align: center; flex-shrink: 0;
    font-size: 10px;
    color: color-mix(in srgb, var(--g-primary) 62%, transparent);
  }
  .crm-groupby-item.is-active .crm-groupby-glyph { color: var(--g-primary); }
  .crm-groupby-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .crm-groupby-meta {
    font: 500 9px 'JetBrains Mono', monospace;
    letter-spacing: 0.08em;
    color: rgba(255,255,255,0.34);
    flex-shrink: 0;
  }
  .crm-groupby-check { width: 12px; height: 12px; flex-shrink: 0; color: var(--g-primary); }
  .crm-groupby-divider {
    height: 1px; margin: 5px 8px;
    background: color-mix(in srgb, var(--g-primary) 14%, transparent);
  }
  .crm-groupby-hint {
    padding: 9px 11px;
    font: 500 10.5px 'Inter', sans-serif;
    line-height: 1.5;
    color: rgba(255,255,255,0.5);
  }

  /* Regroup transition — columns stagger in when the axis changes. */
  .crm-kanban-col { animation: crmColIn 260ms cubic-bezier(0.2, 0.9, 0.3, 1) both; }
  @keyframes crmColIn {
    from { opacity: 0; transform: translateY(8px); }
    to   { opacity: 1; transform: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    .crm-kanban-col { animation: none; }
    .crm-groupby-menu { animation: none; }
  }

  .crm-kanban-col-empty {
    display: flex; align-items: center; justify-content: center;
    padding: 16px 10px;
    border-radius: 9px;
    border: 1px dashed color-mix(in srgb, var(--g-primary) 13%, transparent);
    color: rgba(255,255,255,0.3);
    font: 500 9.5px 'JetBrains Mono', monospace;
    text-transform: uppercase; letter-spacing: 0.14em;
  }

  .crm-search {
    padding: 8px 14px 8px 32px;
    border-radius: 10px;
    background:
      color-mix(in srgb, #000 35%, transparent);
    border: 1px solid color-mix(in srgb, var(--g-primary) 16%, transparent);
    color: #f5f5f4;
    font: 500 12px 'Inter', sans-serif;
    outline: none;
    width: 220px;
    transition: all 180ms ease;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%23a1a1aa' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='11' cy='11' r='8'/%3E%3Cpath d='m21 21-4.3-4.3'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: 10px center;
  }
  .crm-search:focus {
    border-color: color-mix(in srgb, var(--g-primary) 55%, transparent);
    background-color: color-mix(in srgb, #000 50%, transparent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--g-primary) 12%, transparent);
    width: 280px;
  }
  .crm-search::placeholder { color: rgba(255,255,255,0.35); }

  .crm-select {
    padding: 7px 28px 7px 12px;
    border-radius: 10px;
    background:
      color-mix(in srgb, #000 32%, transparent)
      url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23a1a1aa' stroke-width='2.4' stroke-linecap='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E")
      no-repeat right 10px center;
    border: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
    color: #d4d4d8;
    font: 500 11px 'Inter', sans-serif;
    outline: none; cursor: pointer; appearance: none; -webkit-appearance: none;
    transition: all 160ms ease;
  }
  .crm-select:hover { border-color: color-mix(in srgb, var(--g-primary) 30%, transparent); color: #f5f5f4; }
  .crm-select:focus { border-color: color-mix(in srgb, var(--g-primary) 55%, transparent); }
  .crm-select option { background: #0a0a0a; color: #f5f5f4; }

  .crm-btn {
    padding: 8px 16px;
    border-radius: 10px;
    font: 600 10.5px 'JetBrains Mono', monospace;
    text-transform: uppercase; letter-spacing: 0.12em;
    border: 1px solid color-mix(in srgb, var(--g-primary) 22%, transparent);
    background:
      linear-gradient(180deg,
        color-mix(in srgb, var(--g-primary) 12%, transparent),
        color-mix(in srgb, var(--g-primary) 5%, transparent));
    color: var(--g-primary);
    cursor: pointer;
    transition: all 160ms cubic-bezier(0.2, 0.9, 0.3, 1);
    box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 6%, transparent);
  }
  .crm-btn:hover:not(:disabled) {
    background:
      linear-gradient(180deg,
        color-mix(in srgb, var(--g-primary) 22%, transparent),
        color-mix(in srgb, var(--g-primary) 12%, transparent));
    border-color: color-mix(in srgb, var(--g-primary) 50%, transparent);
    transform: translateY(-1px);
    box-shadow:
      inset 0 1px 0 color-mix(in srgb, #fff 12%, transparent),
      0 8px 24px color-mix(in srgb, var(--g-primary) 18%, transparent);
  }
  .crm-btn:active:not(:disabled) { transform: translateY(0); }
  .crm-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .crm-btn.primary {
    background:
      linear-gradient(180deg,
        color-mix(in srgb, var(--g-primary) 28%, transparent),
        color-mix(in srgb, var(--g-primary) 14%, transparent));
    border-color: color-mix(in srgb, var(--g-primary) 55%, transparent);
    color: var(--g-primary);
  }
  .crm-btn.danger {
    border-color: rgba(239,68,68,0.35);
    color: #fca5a5;
    background:
      linear-gradient(180deg, rgba(239,68,68,0.16), rgba(239,68,68,0.05));
  }
  .crm-btn.danger:hover:not(:disabled) {
    background: linear-gradient(180deg, rgba(239,68,68,0.28), rgba(239,68,68,0.12));
    border-color: rgba(239,68,68,0.55);
    box-shadow: 0 8px 24px rgba(239,68,68,0.22);
  }
  .crm-btn-sm { padding: 5px 11px; font-size: 9px; }
  .crm-btn-notion {
    border-color: rgba(167,139,250,0.32);
    color: #c4b5fd;
    background: linear-gradient(180deg, rgba(167,139,250,0.16), rgba(167,139,250,0.05));
  }
  .crm-btn-notion:hover:not(:disabled) {
    background: linear-gradient(180deg, rgba(167,139,250,0.26), rgba(167,139,250,0.10));
    border-color: rgba(167,139,250,0.5);
    color: #ddd6fe;
    box-shadow: 0 8px 24px rgba(167,139,250,0.22);
  }

  .crm-success {
    padding: 8px 14px;
    margin: 8px 14px 0;
    border-radius: 10px;
    background: linear-gradient(180deg, rgba(34,197,94,0.16), rgba(34,197,94,0.04));
    border: 1px solid rgba(34,197,94,0.30);
    color: #86efac;
    font: 500 11.5px 'Inter', sans-serif;
    flex-shrink: 0;
    box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 6%, transparent);
  }
  .crm-error {
    padding: 8px 14px;
    margin: 8px 14px 0;
    border-radius: 10px;
    background: linear-gradient(180deg, rgba(220,38,38,0.16), rgba(220,38,38,0.04));
    border: 1px solid rgba(220,38,38,0.30);
    color: #fca5a5;
    font: 500 11.5px 'Inter', sans-serif;
    display: flex; align-items: center; justify-content: space-between;
    flex-shrink: 0;
    box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 6%, transparent);
  }
  .crm-error-dismiss { background: none; border: none; color: #fca5a5; cursor: pointer; font-size: 13px; padding: 0 6px; }

  .crm-content { flex: 1; display: flex; overflow: hidden; min-height: 0; }
  .crm-main { flex: 1; overflow-y: auto; padding: 16px; min-height: 0; }
  .crm-main::-webkit-scrollbar { width: 6px; }
  .crm-main::-webkit-scrollbar-thumb {
    background: color-mix(in srgb, var(--g-primary) 22%, transparent);
    border-radius: 999px;
  }

  /* ─── Grid + Cards (glass with depth + sheen) ──────────── */
  .crm-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 14px;
  }
  .crm-grid-spinner {
    width: 12px; height: 12px; border-radius: 50%;
    border: 2px solid color-mix(in srgb, var(--g-primary) 30%, transparent);
    border-top-color: var(--g-primary);
    animation: crm-grid-spin 0.7s linear infinite;
  }
  @keyframes crm-grid-spin { to { transform: rotate(360deg); } }
  .crm-card {
    position: relative; overflow: hidden;
    padding: 18px 18px 16px;
    border-radius: 16px;
    cursor: pointer;
    background:
      linear-gradient(135deg,
        color-mix(in srgb, var(--g-primary) 5%, transparent),
        transparent 60%),
      linear-gradient(180deg,
        color-mix(in srgb, #fff 3%, transparent),
        color-mix(in srgb, #000 28%, transparent));
    border: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
    box-shadow:
      inset 0 1px 0 color-mix(in srgb, #fff 6%, transparent),
      0 8px 24px rgba(0, 0, 0, 0.28);
    backdrop-filter: blur(14px) saturate(150%);
    transition: transform 220ms cubic-bezier(0.2, 0.9, 0.3, 1),
                border-color 200ms ease,
                box-shadow 220ms ease,
                background 200ms ease;
  }
  /* subtle top sheen highlight */
  .crm-card::before {
    content: ""; position: absolute; inset: 0;
    pointer-events: none;
    background:
      radial-gradient(ellipse 70% 40% at 30% 0%,
        color-mix(in srgb, var(--g-primary) 14%, transparent),
        transparent 65%);
    opacity: 0.55;
    transition: opacity 220ms ease;
  }
  .crm-card:hover {
    transform: translateY(-3px);
    border-color: color-mix(in srgb, var(--g-primary) 38%, transparent);
    box-shadow:
      inset 0 1px 0 color-mix(in srgb, #fff 14%, transparent),
      0 22px 48px rgba(0, 0, 0, 0.42),
      0 0 32px color-mix(in srgb, var(--g-primary) 20%, transparent);
  }
  .crm-card:hover::before { opacity: 0.9; }
  .crm-card.selected {
    border-color: color-mix(in srgb, var(--g-primary) 55%, transparent);
    box-shadow:
      inset 0 1px 0 color-mix(in srgb, #fff 14%, transparent),
      0 22px 48px rgba(0, 0, 0, 0.42),
      0 0 0 1px color-mix(in srgb, var(--g-primary) 35%, transparent),
      0 0 36px color-mix(in srgb, var(--g-primary) 24%, transparent);
  }
  .crm-card-header { position: relative; display: flex; align-items: center; gap: 12px; margin-bottom: 12px; z-index: 1; }
  .crm-avatar {
    width: 42px; height: 42px;
    border-radius: 50%;
    display: grid; place-items: center;
    font: 700 13px 'Inter', sans-serif;
    color: #fff;
    flex-shrink: 0;
    border: 1px solid color-mix(in srgb, #fff 14%, transparent);
    box-shadow:
      inset 0 1px 0 color-mix(in srgb, #fff 26%, transparent),
      0 8px 18px rgba(0,0,0,0.36);
  }
  .crm-card-info { flex: 1; min-width: 0; }
  .crm-card-name {
    font: 700 14px/1.2 -apple-system, 'Inter', sans-serif;
    letter-spacing: -0.01em;
    color: #f5f5f4;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .crm-card-company {
    font: 500 11px 'Inter', sans-serif;
    color: rgba(255,255,255,0.5);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    margin-top: 2px;
  }
  .crm-card-details {
    position: relative; z-index: 1;
    display: flex; flex-direction: column; gap: 6px;
    margin-bottom: 10px;
  }
  .crm-card-detail {
    display: flex; align-items: center; gap: 8px;
    font: 500 11px 'Inter', sans-serif;
    color: rgba(255,255,255,0.62);
  }
  .crm-card-detail-icon { flex-shrink: 0; opacity: 0.55; color: var(--g-primary); }
  .crm-card-detail-value { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .crm-card-footer {
    position: relative; z-index: 1;
    display: flex; align-items: center; justify-content: space-between;
    gap: 8px; flex-wrap: wrap;
    padding-top: 10px;
    border-top: 1px dashed color-mix(in srgb, #fff 6%, transparent);
  }
  .crm-status-badge {
    display: inline-flex; align-items: center; gap: 4px;
    font: 700 9px 'JetBrains Mono', monospace;
    text-transform: uppercase; letter-spacing: 0.14em;
    padding: 4px 9px;
    border-radius: 999px;
    backdrop-filter: blur(4px);
  }
  .crm-tags { display: flex; gap: 4px; flex-wrap: wrap; }
  .crm-tag {
    font: 600 9.5px 'Inter', sans-serif;
    padding: 3px 8px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--g-primary) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--g-primary) 22%, transparent);
    color: var(--g-primary);
  }
  .crm-card-time {
    font: 500 10px 'JetBrains Mono', monospace;
    color: rgba(255,255,255,0.4);
  }

  /* ── Social platform icon strip ── */
  .crm-social-icons {
    display: flex; align-items: center; gap: 6px;
    flex-wrap: wrap;
    margin: 6px 0 2px;
  }
  .crm-social-icon {
    display: inline-flex; align-items: center; justify-content: center;
    width: 22px; height: 22px;
    border-radius: 50%;
    opacity: 0.82;
    transition: opacity 150ms ease, transform 150ms ease, box-shadow 150ms ease;
    text-decoration: none;
    flex-shrink: 0;
  }
  .crm-social-icon svg { display: block; width: 20px; height: 20px; }
  .crm-social-icon:hover {
    opacity: 1;
    transform: scale(1.18);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--social-color, #c9a84c) 55%, transparent);
  }

  /* Contact & Socials section in detail page */
  .crm-contact-section { display: flex; flex-direction: column; gap: 10px; }
  .crm-contact-row {
    display: flex; align-items: center; gap: 10px;
    padding: 8px 10px;
    border-radius: 8px;
    background: rgba(255,255,255,0.03);
    border: 1px solid rgba(255,255,255,0.06);
  }
  .crm-contact-row-icon { flex-shrink: 0; display: flex; align-items: center; }
  .crm-contact-row-icon svg { width: 20px; height: 20px; }
  .crm-contact-row-label { font: 600 10px 'Inter', sans-serif; color: rgba(255,255,255,0.45); min-width: 80px; }
  .crm-contact-row-value {
    flex: 1; font: 500 12px 'JetBrains Mono', monospace; color: #f5f5f4;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .crm-contact-row-value a { color: inherit; text-decoration: none; }
  .crm-contact-row-value a:hover { color: var(--g-primary); }
  .crm-contact-copy {
    background: none; border: none; cursor: pointer;
    font-size: 11px; color: rgba(255,255,255,0.35);
    padding: 2px 6px; border-radius: 4px;
    transition: color 150ms, background 150ms;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .crm-contact-copy:hover { color: var(--g-primary); background: rgba(201,168,76,0.1); }

  /* Contact & Socials fields in the create/edit form */
  .crm-nc-socials-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }
  .crm-nc-social-field { display: flex; flex-direction: column; gap: 5px; }
  .crm-nc-social-label {
    display: flex; align-items: center; gap: 6px;
    font: 600 10.5px 'Inter', sans-serif; color: rgba(255,255,255,0.55);
    text-transform: uppercase; letter-spacing: 0.08em;
  }
  .crm-nc-social-label svg { width: 16px; height: 16px; flex-shrink: 0; }
  .crm-nc-social-input {
    width: 100%;
    padding: 8px 10px;
    border-radius: 8px;
    border: 1px solid rgba(255,255,255,0.10);
    background: rgba(255,255,255,0.04);
    color: #f5f5f4;
    font: 500 12px 'JetBrains Mono', monospace;
    outline: none;
    transition: border-color 150ms, background 150ms;
    box-sizing: border-box;
  }
  .crm-nc-social-input:focus {
    border-color: rgba(201,168,76,0.45);
    background: rgba(201,168,76,0.04);
  }
  .crm-nc-social-divider {
    display: flex; align-items: center; gap: 10px;
    margin: 4px 0;
  }
  .crm-nc-social-divider-line {
    flex: 1; height: 1px;
    background: linear-gradient(90deg, transparent, rgba(201,168,76,0.25), transparent);
  }
  .crm-nc-social-divider-label {
    font: 700 9px 'JetBrains Mono', monospace;
    color: rgba(201,168,76,0.6);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    white-space: nowrap;
  }

  .crm-card-actions {
    position: absolute; top: 10px; right: 10px; z-index: 2;
    display: flex; gap: 4px;
    opacity: 0;
    transform: translateY(-4px);
    transition: opacity 200ms ease, transform 200ms ease;
  }
  .crm-card:hover .crm-card-actions {
    opacity: 1; transform: translateY(0);
  }
  .crm-card-action {
    padding: 5px 10px;
    border-radius: 8px;
    border: 1px solid color-mix(in srgb, var(--g-primary) 22%, transparent);
    background: color-mix(in srgb, #000 50%, transparent);
    color: #d4d4d8;
    font: 600 9.5px 'JetBrains Mono', monospace;
    letter-spacing: 0.06em;
    cursor: pointer;
    backdrop-filter: blur(10px);
    transition: all 140ms ease;
  }
  .crm-card-action:hover {
    color: var(--g-primary);
    border-color: color-mix(in srgb, var(--g-primary) 50%, transparent);
    background: color-mix(in srgb, var(--g-primary) 14%, transparent);
  }
  .crm-card-action.danger:hover {
    color: #fca5a5;
    border-color: rgba(239,68,68,0.5);
    background: rgba(239,68,68,0.18);
  }

  /* ─── Table (glass sheet) ──────────────────────────────── */
  .crm-table-wrap {
    overflow-x: auto;
    border-radius: 14px;
    border: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
    background:
      linear-gradient(180deg,
        color-mix(in srgb, #fff 3%, transparent),
        color-mix(in srgb, #000 35%, transparent));
    box-shadow:
      inset 0 1px 0 color-mix(in srgb, #fff 6%, transparent),
      0 14px 32px rgba(0, 0, 0, 0.32);
    /* Deliberately NO backdrop-filter. This wrapper grows to the full height of
       the row list, and blurring a backdrop that tall dominates every scroll
       frame: measured 55.1ms median frames with it vs 16.7ms without, over the
       same 1,297 rows (130/148 frames >50ms vs 1/148). Row transitions and
       content-visibility made no difference — this was the whole cost. The
       gradient below carries the glass look; the page behind is near-opaque,
       so there is nothing meaningful left to blur. */
  }
  .crm-table-wrap::-webkit-scrollbar { height: 6px; }
  .crm-table-wrap::-webkit-scrollbar-thumb {
    background: color-mix(in srgb, var(--g-primary) 22%, transparent);
    border-radius: 999px;
  }
  .crm-table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 12px; }
  .crm-table thead {
    background:
      linear-gradient(180deg,
        color-mix(in srgb, var(--g-primary) 8%, transparent),
        transparent);
    position: sticky; top: 0; z-index: 2;
    backdrop-filter: blur(10px);
  }
  .crm-table th {
    text-align: left;
    font: 700 9.5px 'JetBrains Mono', monospace;
    text-transform: uppercase; letter-spacing: 0.18em;
    color: color-mix(in srgb, var(--g-primary) 60%, #fff);
    padding: 12px 14px;
    border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 18%, transparent);
    cursor: pointer; user-select: none; white-space: nowrap;
    transition: color 140ms ease, background 140ms ease;
  }
  .crm-table th:hover { color: var(--g-primary); background: color-mix(in srgb, var(--g-primary) 6%, transparent); }
  .crm-table th.sorted {
    color: var(--g-primary);
    background: color-mix(in srgb, var(--g-primary) 10%, transparent);
  }
  .crm-table td {
    padding: 12px 14px;
    border-bottom: 1px solid color-mix(in srgb, #fff 4%, transparent);
    color: rgba(255,255,255,0.78);
    vertical-align: middle;
    max-width: 240px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font: 500 12px 'Inter', sans-serif;
  }
  .crm-table tbody tr {
    transition: background 140ms ease, transform 140ms ease;
    cursor: pointer;
  }
  .crm-table tbody tr:hover {
    background: linear-gradient(90deg,
      color-mix(in srgb, var(--g-primary) 8%, transparent),
      transparent 80%);
  }
  .crm-table tbody tr:hover td { color: #f5f5f4; }
  .crm-table tbody tr:last-child td { border-bottom: none; }
  .crm-table-name { display: flex; align-items: center; gap: 10px; }
  .crm-table-avatar {
    width: 28px; height: 28px;
    border-radius: 50%;
    display: grid; place-items: center;
    font: 700 10px 'Inter', sans-serif;
    color: #fff;
    flex-shrink: 0;
    border: 1px solid color-mix(in srgb, #fff 14%, transparent);
    box-shadow:
      inset 0 1px 0 color-mix(in srgb, #fff 26%, transparent),
      0 4px 10px rgba(0,0,0,0.34);
  }
  .crm-table-name-text {
    color: #f5f5f4; font-weight: 600;
    font-size: 12.5px; letter-spacing: -0.005em;
  }

  /* ─── Kanban (glass columns, lift-on-drag) ──────────────── */
  .crm-kanban {
    display: flex; gap: 14px;
    overflow-x: auto;
    min-height: 0; height: 100%;
    padding: 4px 4px 12px;
  }
  .crm-kanban::-webkit-scrollbar { height: 6px; }
  .crm-kanban::-webkit-scrollbar-thumb {
    background: color-mix(in srgb, var(--g-primary) 22%, transparent);
    border-radius: 999px;
  }
  .crm-kanban-col {
    flex: 0 0 280px;
    display: flex; flex-direction: column;
    border-radius: 14px;
    overflow: hidden;
    background:
      linear-gradient(180deg,
        color-mix(in srgb, var(--g-primary) 5%, transparent),
        transparent 35%),
      linear-gradient(180deg,
        color-mix(in srgb, #fff 2%, transparent),
        color-mix(in srgb, #000 36%, transparent));
    border: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
    box-shadow:
      inset 0 1px 0 color-mix(in srgb, #fff 6%, transparent),
      0 12px 28px rgba(0, 0, 0, 0.32);
    backdrop-filter: blur(14px) saturate(150%);
    transition: border-color 180ms ease, box-shadow 220ms ease, transform 220ms ease;
  }
  .crm-kanban-header {
    padding: 12px 14px;
    font: 700 10.5px 'JetBrains Mono', monospace;
    text-transform: uppercase; letter-spacing: 0.2em;
    border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 16%, transparent);
    display: flex; align-items: center; justify-content: space-between;
    background: color-mix(in srgb, var(--g-primary) 4%, transparent);
  }
  .crm-kanban-count {
    font: 700 9px 'JetBrains Mono', monospace;
    color: color-mix(in srgb, var(--g-primary) 70%, #fff);
    padding: 3px 9px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--g-primary) 14%, transparent);
    border: 1px solid color-mix(in srgb, var(--g-primary) 22%, transparent);
  }
  .crm-kanban-cards {
    flex: 1; overflow-y: auto;
    padding: 10px;
    display: flex; flex-direction: column; gap: 8px;
  }
  .crm-kanban-cards::-webkit-scrollbar { width: 5px; }
  .crm-kanban-cards::-webkit-scrollbar-thumb {
    background: color-mix(in srgb, var(--g-primary) 22%, transparent);
    border-radius: 999px;
  }
  .crm-kanban-card {
    padding: 12px 13px;
    border-radius: 12px;
    cursor: pointer;
    background:
      linear-gradient(135deg,
        color-mix(in srgb, var(--g-primary) 6%, transparent),
        transparent 60%),
      color-mix(in srgb, #000 28%, transparent);
    border: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
    box-shadow:
      inset 0 1px 0 color-mix(in srgb, #fff 8%, transparent),
      0 6px 16px rgba(0, 0, 0, 0.28);
    transition: all 180ms cubic-bezier(0.2, 0.9, 0.3, 1);
    backdrop-filter: blur(6px);
  }
  .crm-kanban-card:hover {
    transform: translateY(-2px);
    border-color: color-mix(in srgb, var(--g-primary) 38%, transparent);
    box-shadow:
      inset 0 1px 0 color-mix(in srgb, #fff 14%, transparent),
      0 14px 30px rgba(0, 0, 0, 0.40),
      0 0 20px color-mix(in srgb, var(--g-primary) 18%, transparent);
  }
  .crm-kanban-card-name {
    font: 700 13px/1.25 -apple-system, 'Inter', sans-serif;
    letter-spacing: -0.005em;
    color: #f5f5f4;
    margin-bottom: 4px;
  }
  .crm-kanban-card-company {
    font: 500 11px 'Inter', sans-serif;
    color: rgba(255,255,255,0.5);
    margin-bottom: 6px;
  }
  .crm-kanban-card-tags { display: flex; gap: 4px; flex-wrap: wrap; }
  .crm-kanban-card-move { display: flex; gap: 4px; margin-top: 8px; }
  .crm-kanban-move-btn {
    padding: 3px 8px;
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--g-primary) 16%, transparent);
    background: color-mix(in srgb, #000 30%, transparent);
    color: rgba(255,255,255,0.55);
    font: 600 9px 'JetBrains Mono', monospace;
    letter-spacing: 0.06em;
    cursor: pointer;
    transition: all 140ms ease;
  }
  .crm-kanban-move-btn:hover {
    color: var(--g-primary);
    border-color: color-mix(in srgb, var(--g-primary) 40%, transparent);
    background: color-mix(in srgb, var(--g-primary) 14%, transparent);
  }

  /* Detail Panel */
  .crm-detail { width:380px; flex-shrink:0; border-left:1px solid color-mix(in srgb, var(--g-primary) 8%, transparent); background:#060606; display:flex; flex-direction:column; overflow:hidden; animation:crm-slide-in 0.2s ease-out; }
  @keyframes crm-slide-in { from { transform:translateX(20px); opacity:0; } to { transform:translateX(0); opacity:1; } }
  .crm-detail-header { padding:12px 16px; display:flex; align-items:center; justify-content:space-between; border-bottom:1px solid color-mix(in srgb, var(--g-primary) 6%, transparent); flex-shrink:0; }
  .crm-detail-title { font-size:10px; text-transform:uppercase; letter-spacing:0.15em; color:var(--g-primary); font-weight:700; }
  .crm-detail-close { background:none; border:none; color:#52525b; cursor:pointer; font-size:14px; padding:2px 6px; transition:color 0.12s; }
  .crm-detail-close:hover { color:#e4e4e7; }
  .crm-detail-body { flex:1; overflow-y:auto; padding:16px; }
  .crm-detail-body::-webkit-scrollbar { width:3px; }
  .crm-detail-body::-webkit-scrollbar-thumb { background:color-mix(in srgb, var(--g-primary) 10%, transparent); }
  .crm-detail-avatar { width:56px; height:56px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:20px; font-weight:700; color:#fff; margin:0 auto 12px; }
  .crm-detail-name { font-size:16px; font-weight:700; color:#e4e4e7; text-align:center; margin-bottom:2px; }
  .crm-detail-company { font-size:10px; color:#71717a; text-align:center; margin-bottom:12px; }
  .crm-detail-section { margin-bottom:16px; }
  .crm-detail-section-title { font-size:8px; text-transform:uppercase; letter-spacing:0.2em; color:var(--g-primary); margin-bottom:8px; font-weight:700; padding-bottom:4px; border-bottom:1px solid color-mix(in srgb, var(--g-primary) 6%, transparent); }
  .crm-detail-field { display:flex; justify-content:space-between; align-items:flex-start; padding:4px 0; font-size:10px; gap:8px; }
  .crm-detail-label { color:#71717a; white-space:nowrap; flex-shrink:0; }
  .crm-detail-value { color:#a1a1aa; text-align:right; max-width:220px; overflow:hidden; text-overflow:ellipsis; word-break:break-word; }
  .crm-detail-notes { font-size:10px; color:#a1a1aa; line-height:1.5; white-space:pre-wrap; background:#0a0a0a; padding:8px 10px; border:1px solid color-mix(in srgb, var(--g-primary) 4%, transparent); }
  .crm-detail-actions { display:flex; gap:6px; margin-top:16px; padding-top:12px; border-top:1px solid color-mix(in srgb, var(--g-primary) 6%, transparent); }
  .crm-detail-notion { font-size:9px; color:#52525b; margin-top:8px; }
  .crm-detail-notion strong { color:#a78bfa; }

  /* Dialog */
  .crm-dialog-overlay { position:fixed; inset:0; background:rgba(0,0,0,0.8); display:flex; align-items:center; justify-content:center; z-index:1000; backdrop-filter:blur(4px); }
  .crm-dialog { background:#0c0c0c; border:1px solid color-mix(in srgb, var(--g-primary) 20%, transparent); padding:24px; width:560px; max-width:92vw; max-height:85vh; overflow-y:auto; box-shadow:0 0 60px color-mix(in srgb, var(--g-primary) 6%, transparent); }
  .crm-dialog-title { font-size:13px; text-transform:uppercase; letter-spacing:0.15em; color:var(--g-primary); margin-bottom:16px; padding-bottom:10px; border-bottom:1px solid color-mix(in srgb, var(--g-primary) 8%, transparent); }
  .crm-form-group { margin-bottom:14px; }
  .crm-form-label { display:block; font-size:9px; text-transform:uppercase; letter-spacing:0.15em; color:#71717a; margin-bottom:5px; }
  .crm-form-input { width:100%; padding:8px 10px; background:#0a0a0a; border:1px solid color-mix(in srgb, var(--g-primary) 8%, transparent); color:#e4e4e7; font-family:inherit; font-size:11px; outline:none; transition:border-color 0.15s; box-sizing:border-box; }
  .crm-form-input:focus { border-color:color-mix(in srgb, var(--g-primary) 25%, transparent); box-shadow:0 0 8px color-mix(in srgb, var(--g-primary) 4%, transparent); }
  .crm-form-input::placeholder { color:#3f3f46; }
  .crm-form-textarea { width:100%; padding:8px 10px; background:#0a0a0a; border:1px solid color-mix(in srgb, var(--g-primary) 8%, transparent); color:#e4e4e7; font-family:inherit; font-size:11px; outline:none; transition:border-color 0.15s; box-sizing:border-box; resize:vertical; min-height:60px; line-height:1.5; }
  .crm-form-textarea:focus { border-color:color-mix(in srgb, var(--g-primary) 25%, transparent); box-shadow:0 0 8px color-mix(in srgb, var(--g-primary) 4%, transparent); }
  .crm-form-textarea::placeholder { color:#3f3f46; }
  .crm-form-row { display:flex; gap:10px; }
  .crm-form-row .crm-form-group { flex:1; }
  .crm-form-tags { display:flex; flex-wrap:wrap; gap:4px; margin-top:4px; }
  .crm-form-tag { display:inline-flex; align-items:center; gap:3px; font-size:9px; padding:2px 6px; background:color-mix(in srgb, var(--g-primary) 6%, transparent); border:1px solid color-mix(in srgb, var(--g-primary) 10%, transparent); color:var(--g-primary); }
  .crm-form-tag-remove { background:none; border:none; color:var(--g-primary); cursor:pointer; font-size:10px; padding:0 2px; line-height:1; }
  .crm-form-tag-remove:hover { color:#f87171; }
  .crm-dialog-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:18px; padding-top:14px; border-top:1px solid color-mix(in srgb, var(--g-primary) 5%, transparent); }

  /* Notion Bar */
  .crm-notion-bar { display:flex; align-items:center; gap:8px; padding:6px 16px; background:#050505; border-bottom:1px solid rgba(167,139,250,0.06); flex-shrink:0; font-size:9px; color:#71717a; flex-wrap:wrap; }
  .crm-notion-dot { width:6px; height:6px; border-radius:50%; flex-shrink:0; }
  .crm-notion-dot.connected { background:#a78bfa; box-shadow:0 0 6px rgba(167,139,250,0.5); }
  .crm-notion-dot.disconnected { background:#3f3f46; }

  .crm-empty { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:14px; padding:60px 20px; color:#3f3f46; text-align:center; flex:1; }
  .crm-empty-icon { font-size:40px; opacity:0.2; }
  .crm-empty-text { font-size:11px; text-transform:uppercase; letter-spacing:0.15em; }
  .crm-loading { text-align:center; padding:60px 20px; color:#52525b; font-size:12px; text-transform:uppercase; letter-spacing:0.15em; }
  .crm-loading-dot { display:inline-block; animation:crmPulse 1.5s infinite; color:var(--g-primary); }
  @keyframes crmPulse { 0%,100%{opacity:0.3;} 50%{opacity:1;} }

  /* ── Drag & Drop ── */
  .crm-kanban-card.dragging {
    opacity: 0.5;
    transform: rotate(-1.5deg) scale(0.98);
    border: 1px dashed color-mix(in srgb, var(--g-primary) 55%, transparent);
    box-shadow: 0 22px 44px rgba(0,0,0,0.55), 0 0 32px color-mix(in srgb, var(--g-primary) 30%, transparent);
  }
  .crm-kanban-col.drag-over {
    border-color: color-mix(in srgb, var(--g-primary) 55%, transparent);
    box-shadow:
      inset 0 1px 0 color-mix(in srgb, #fff 14%, transparent),
      0 18px 40px rgba(0,0,0,0.42),
      0 0 0 1px color-mix(in srgb, var(--g-primary) 28%, transparent),
      0 0 40px color-mix(in srgb, var(--g-primary) 22%, transparent);
  }
  .crm-kanban-col.drag-over .crm-kanban-cards { min-height: 80px; }
  .crm-kanban-drop-zone {
    min-height: 48px;
    margin: 4px 0;
    display: none;
    align-items: center; justify-content: center;
    border-radius: 10px;
    border: 1px dashed color-mix(in srgb, var(--g-primary) 22%, transparent);
    color: rgba(255,255,255,0.4);
    font: 700 9.5px 'JetBrains Mono', monospace;
    text-transform: uppercase; letter-spacing: 0.18em;
    background: color-mix(in srgb, var(--g-primary) 4%, transparent);
  }
  .crm-kanban-col.drag-over .crm-kanban-drop-zone {
    display: flex;
    border-color: color-mix(in srgb, var(--g-primary) 55%, transparent);
    color: var(--g-primary);
    background: color-mix(in srgb, var(--g-primary) 10%, transparent);
  }
  .crm-kanban-card[draggable="true"] { cursor: grab; }
  .crm-kanban-card[draggable="true"]:active { cursor: grabbing; }
  .crm-kanban-card[draggable="true"]:active { cursor:grabbing; }
  .crm-notion-synced { color:#a78bfa; font-size:8px; margin-left:4px; opacity:0; transition:opacity 0.3s; }
  .crm-notion-synced.show { opacity:1; }

  /* ── Temperature filter strip + card chip ── */
  .crm-temp-strip {
    display: flex; gap: 6px; padding: 6px 12px;
    border-radius: 10px;
    background: var(--g-surface, rgba(255,255,255,0.025));
    border: 1px solid var(--g-border, rgba(255,255,255,0.06));
    margin: 0 0 10px;
  }
  .crm-temp-pill {
    appearance: none; cursor: pointer;
    padding: 4px 12px; border-radius: 999px;
    background: transparent;
    border: 1px solid var(--g-border, rgba(255,255,255,0.10));
    color: var(--g-fg-dim, rgba(255,255,255,0.6));
    font-size: 11px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.06em;
    transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
  }
  .crm-temp-pill:hover { color: var(--g-fg, #fff); border-color: var(--g-border-strong, rgba(255,255,255,0.18)); }
  .crm-temp-pill.is-active { color: var(--g-fg, #fff); border-color: var(--g-primary, #60a5fa); background: color-mix(in srgb, var(--g-primary, #60a5fa) 14%, transparent); }
  .crm-temp-pill--cold.is-active { color: var(--hw-info, #38bdf8); border-color: var(--hw-info, #38bdf8); background: color-mix(in srgb, var(--hw-info, #38bdf8) 14%, transparent); }
  .crm-temp-pill--warm.is-active { color: var(--hw-warning, #f97316); border-color: var(--hw-warning, #f97316); background: color-mix(in srgb, var(--hw-warning, #f97316) 14%, transparent); }
  .crm-temp-pill--hot.is-active  { color: var(--hw-danger,  #f43f5e); border-color: var(--hw-danger,  #f43f5e); background: color-mix(in srgb, var(--hw-danger,  #f43f5e) 14%, transparent); }

  .crm-temp-chip {
    display: inline-block; width: 8px; height: 8px;
    border-radius: 50%; margin-right: 6px;
    background: currentColor; box-shadow: 0 0 6px currentColor;
    vertical-align: middle;
  }
  .crm-temp-chip--cold { color: var(--hw-info, #38bdf8); }
  .crm-temp-chip--warm { color: var(--hw-warning, #f97316); }
  .crm-temp-chip--hot  { color: var(--hw-danger,  #f43f5e); }

  /* ─── Campaign chips (cards + kanban) ───────────────────── */
  .crm-campaign-chip {
    display: inline-flex; align-items: center; gap: 4px;
    font: 600 9.5px 'JetBrains Mono', monospace;
    text-transform: uppercase; letter-spacing: 0.15em;
    padding: 2px 8px; border-radius: 999px;
    border: 1px solid; white-space: nowrap;
    max-width: 120px; overflow: hidden; text-overflow: ellipsis;
  }
  .crm-campaign-chip--active {
    color: var(--g-primary, #60a5fa);
    border-color: color-mix(in srgb, var(--g-primary, #60a5fa) 40%, transparent);
    background: color-mix(in srgb, var(--g-primary, #60a5fa) 10%, transparent);
  }
  .crm-campaign-chip--paused {
    color: rgba(234,179,8,0.9);
    border-color: rgba(234,179,8,0.28);
    background: rgba(234,179,8,0.08);
  }
  .crm-campaign-chip--completed {
    color: rgba(34,197,94,0.9);
    border-color: rgba(34,197,94,0.25);
    background: rgba(34,197,94,0.07);
  }
  .crm-campaign-chip--draft {
    color: rgba(255,255,255,0.4);
    border-color: rgba(255,255,255,0.1);
    background: transparent;
  }

  /* ─── Campaign tab dot indicator on tab button ──────────── */
  .crm-page-tab-dot {
    display: inline-block; width: 6px; height: 6px; border-radius: 50%;
    background: var(--g-primary, #60a5fa);
    box-shadow: 0 0 6px color-mix(in srgb, var(--g-primary, #60a5fa) 70%, transparent);
    margin-left: 4px; flex-shrink: 0;
  }

  /* ─── Campaign detail tab layout ────────────────────────── */
  .crm-page-campaign { display: flex; flex-direction: column; gap: 0; }
  .crm-campaign-summary { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; }
  .crm-campaign-summary-name { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .crm-campaign-status-dot {
    width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
    box-shadow: 0 0 6px currentColor;
  }
  .crm-campaign-empty {
    padding: 16px 0; display: flex; flex-direction: column; align-items: flex-start; gap: 8px;
  }
  .crm-campaign-picker-wrap {
    border: 1px solid color-mix(in srgb, var(--g-primary, #60a5fa) 18%, transparent);
    border-radius: 10px; overflow: hidden; max-height: 220px; overflow-y: auto;
    background: color-mix(in srgb, #000 40%, transparent);
  }
  .crm-campaign-funnel-card {
    border-left: 3px solid color-mix(in srgb, var(--g-primary, #60a5fa) 50%, transparent);
  }

  /* ─── Placeholder table ─────────────────────────────────── */
  .crm-placeholder-table { display: flex; flex-direction: column; gap: 6px; }
  .crm-placeholder-row {
    display: grid;
    grid-template-columns: 180px 1fr max-content 24px;
    gap: 6px; align-items: center;
  }
  .crm-placeholder-key,
  .crm-placeholder-val {
    background: rgba(255,255,255,0.04);
    border: 1px solid rgba(255,255,255,0.09);
    border-radius: 6px; padding: 5px 8px;
    font: 500 12px 'JetBrains Mono', monospace;
    color: #e4e4e7; outline: none;
  }
  .crm-placeholder-key:focus,
  .crm-placeholder-val:focus { border-color: color-mix(in srgb, var(--g-primary, #60a5fa) 45%, transparent); }
  .crm-placeholder-key--ro { font-size: 11px; color: rgba(255,255,255,0.6); padding: 4px 6px; }
  .crm-placeholder-val--ro { font-size: 12px; color: #f5f5f4; padding: 4px 6px; word-break: break-all; }
  .crm-placeholder-copy {
    font: 500 10px 'JetBrains Mono', monospace; color: var(--g-primary, #60a5fa);
    padding: 3px 7px; border-radius: 5px;
    background: color-mix(in srgb, var(--g-primary, #60a5fa) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--g-primary, #60a5fa) 22%, transparent);
    cursor: pointer; white-space: nowrap; user-select: none;
    transition: background 0.14s;
  }
  .crm-placeholder-copy:hover { background: color-mix(in srgb, var(--g-primary, #60a5fa) 20%, transparent); }
  .crm-placeholder-add-row {
    background: transparent; border: 1px dashed rgba(255,255,255,0.14);
    border-radius: 7px; padding: 6px 12px; color: rgba(255,255,255,0.45);
    font: 500 11px 'Inter', sans-serif; cursor: pointer; text-align: left;
    transition: border-color 0.15s, color 0.15s; margin-top: 2px;
  }
  .crm-placeholder-add-row:hover { border-color: var(--g-primary, #60a5fa); color: var(--g-primary, #60a5fa); }

  /* ─── Context preview ───────────────────────────────────── */
  .crm-context-preview {
    background: rgba(0,0,0,0.35); border: 1px solid rgba(255,255,255,0.08);
    border-radius: 8px; padding: 12px; font: 500 11px 'JetBrains Mono', monospace;
    color: rgba(255,255,255,0.75); overflow: auto; max-height: 340px;
    white-space: pre; line-height: 1.55;
  }

  /* ─── New Client modal (glassmorphism wizard shell) ─────── */
  .crm-nc-overlay {
    position: fixed; inset: 0; z-index: 1300;
    background:
      radial-gradient(ellipse 60% 50% at 0% 0%,
        color-mix(in srgb, var(--g-primary) 8%, transparent),
        transparent 60%),
      radial-gradient(ellipse 60% 50% at 100% 100%,
        color-mix(in srgb, #6366f1 6%, transparent),
        transparent 60%),
      color-mix(in srgb, #000 72%, transparent);
    backdrop-filter: blur(18px) saturate(140%);
    display: grid; place-items: center;
    padding: 32px 16px;
    animation: bzModalFade 160ms ease-out;
  }
  .crm-nc {
    width: min(780px, 100%);
    max-height: 90vh;
    display: flex; flex-direction: column;
    border-radius: 18px;
    overflow: hidden;
    position: relative;
    background:
      linear-gradient(135deg,
        color-mix(in srgb, var(--g-primary) 6%, transparent),
        transparent 65%),
      linear-gradient(180deg,
        color-mix(in srgb, var(--g-bg, #0a0a0a) 96%, transparent),
        color-mix(in srgb, var(--g-bg, #0a0a0a) 86%, transparent));
    border: 1px solid color-mix(in srgb, var(--g-primary) 32%, transparent);
    box-shadow:
      inset 0 1px 0 color-mix(in srgb, #fff 10%, transparent),
      0 36px 80px rgba(0, 0, 0, 0.65);
    backdrop-filter: blur(22px) saturate(180%);
    animation: bzModalRise 240ms cubic-bezier(0.2, 0.8, 0.25, 1);
  }
  .crm-nc::before {
    content: ""; position: absolute; inset: 0;
    pointer-events: none;
    background:
      radial-gradient(ellipse 60% 40% at 0% 0%,
        color-mix(in srgb, var(--g-primary) 12%, transparent),
        transparent 65%);
  }
  .crm-nc-head {
    position: relative; z-index: 1;
    padding: 22px 56px 16px 26px;
    display: flex; flex-direction: column; gap: 6px;
    border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
  }
  .crm-nc-eyebrow {
    font: 700 9.5px 'JetBrains Mono', monospace;
    letter-spacing: 0.22em; text-transform: uppercase;
    color: color-mix(in srgb, var(--g-primary) 78%, #fff);
    display: inline-flex; align-items: center; gap: 8px;
  }
  .crm-nc-eyebrow::before {
    content: ""; width: 6px; height: 6px; border-radius: 50%;
    background: var(--g-primary);
    box-shadow: 0 0 8px color-mix(in srgb, var(--g-primary) 60%, transparent);
  }
  .crm-nc-title {
    font: 700 22px/1.2 -apple-system, 'Inter', sans-serif;
    letter-spacing: -0.012em;
    color: #f5f5f4; margin: 0;
  }
  .crm-nc-sub {
    font: 400 12.5px/1.55 -apple-system, 'Inter', sans-serif;
    color: rgba(255,255,255,0.55);
    max-width: 60ch;
  }
  .crm-nc-close {
    position: absolute; top: 14px; right: 14px;
    width: 30px; height: 30px;
    border-radius: 8px;
    border: 1px solid color-mix(in srgb, #fff 10%, transparent);
    background: transparent;
    color: rgba(255,255,255,0.55);
    display: grid; place-items: center;
    cursor: pointer;
    font: 600 14px sans-serif;
    transition: all 140ms;
  }
  .crm-nc-close:hover { background: color-mix(in srgb, #fff 6%, transparent); color: #fff; }

  .crm-nc-body {
    position: relative; z-index: 1;
    flex: 1;
    overflow-y: auto;
    padding: 18px 26px 22px;
    display: flex; flex-direction: column; gap: 14px;
  }
  .crm-nc-body::-webkit-scrollbar { width: 6px; }
  .crm-nc-body::-webkit-scrollbar-thumb {
    background: color-mix(in srgb, var(--g-primary) 26%, transparent);
    border-radius: 999px;
  }

  /* ── Smart paste / AI block ── */
  .crm-nc-ai {
    padding: 14px 16px;
    border-radius: 14px;
    background:
      linear-gradient(135deg,
        color-mix(in srgb, var(--g-primary) 10%, transparent),
        color-mix(in srgb, #6366f1 4%, transparent) 70%);
    border: 1px solid color-mix(in srgb, var(--g-primary) 30%, transparent);
    box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 8%, transparent);
    position: relative;
    overflow: hidden;
  }
  .crm-nc-ai::after {
    content: ""; position: absolute; inset: 0; pointer-events: none;
    background:
      radial-gradient(ellipse 60% 40% at 100% 0%,
        color-mix(in srgb, var(--g-primary) 18%, transparent),
        transparent 70%);
  }
  .crm-nc-ai-head {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 10px;
    position: relative; z-index: 1;
  }
  .crm-nc-ai-title {
    display: inline-flex; align-items: center; gap: 8px;
    font: 700 11px 'JetBrains Mono', monospace;
    letter-spacing: 0.18em; text-transform: uppercase;
    color: color-mix(in srgb, var(--g-primary) 80%, #fff);
  }
  .crm-nc-ai-spark {
    width: 16px; height: 16px;
    background:
      radial-gradient(circle at 50% 50%, var(--g-primary), transparent 60%);
    border-radius: 50%;
    box-shadow: 0 0 12px color-mix(in srgb, var(--g-primary) 60%, transparent);
    animation: crmSparkPulse 1.8s ease-in-out infinite;
  }
  @keyframes crmSparkPulse { 0%, 100% { transform: scale(1); opacity: 0.85; } 50% { transform: scale(1.18); opacity: 1; } }
  .crm-nc-ai-hint {
    font: 500 11px 'Inter', sans-serif;
    color: rgba(255,255,255,0.55);
  }
  .crm-nc-ai-textarea {
    position: relative; z-index: 1;
    width: 100%;
    padding: 11px 12px;
    border-radius: 10px;
    background: color-mix(in srgb, #000 40%, transparent);
    border: 1px solid color-mix(in srgb, var(--g-primary) 18%, transparent);
    color: #f5f5f4;
    font: 500 13px/1.5 -apple-system, 'Inter', sans-serif;
    outline: none;
    resize: vertical;
    min-height: 70px;
    box-sizing: border-box;
    transition: all 160ms ease;
  }
  .crm-nc-ai-textarea:focus {
    border-color: color-mix(in srgb, var(--g-primary) 55%, transparent);
    background: color-mix(in srgb, #000 50%, transparent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--g-primary) 14%, transparent);
  }
  .crm-nc-ai-textarea::placeholder { color: rgba(255,255,255,0.35); }
  .crm-nc-ai-actions {
    position: relative; z-index: 1;
    display: flex; gap: 8px; align-items: center; justify-content: space-between;
    margin-top: 10px;
    flex-wrap: wrap;
  }
  .crm-nc-ai-results {
    font: 500 11.5px 'Inter', sans-serif;
    color: var(--g-primary);
    display: inline-flex; align-items: center; gap: 6px;
  }
  .crm-nc-ai-fill {
    appearance: none; cursor: pointer;
    padding: 8px 14px;
    border-radius: 10px;
    border: 1px solid color-mix(in srgb, var(--g-primary) 55%, transparent);
    background:
      linear-gradient(180deg,
        color-mix(in srgb, var(--g-primary) 30%, transparent),
        color-mix(in srgb, var(--g-primary) 14%, transparent));
    color: var(--g-primary);
    font: 700 11px 'JetBrains Mono', monospace;
    letter-spacing: 0.14em; text-transform: uppercase;
    transition: all 160ms cubic-bezier(0.2, 0.9, 0.3, 1);
    box-shadow:
      inset 0 1px 0 color-mix(in srgb, #fff 14%, transparent),
      0 6px 16px color-mix(in srgb, var(--g-primary) 22%, transparent);
    display: inline-flex; align-items: center; gap: 6px;
  }
  .crm-nc-ai-fill:hover {
    transform: translateY(-1px);
    background:
      linear-gradient(180deg,
        color-mix(in srgb, var(--g-primary) 40%, transparent),
        color-mix(in srgb, var(--g-primary) 22%, transparent));
    box-shadow:
      inset 0 1px 0 color-mix(in srgb, #fff 20%, transparent),
      0 12px 26px color-mix(in srgb, var(--g-primary) 32%, transparent);
  }
  .crm-nc-ai-fill:disabled { opacity: 0.4; cursor: not-allowed; }
  .crm-nc-ai-clear {
    appearance: none; cursor: pointer;
    padding: 7px 12px;
    border-radius: 8px;
    background: transparent;
    border: 1px solid color-mix(in srgb, #fff 10%, transparent);
    color: rgba(255,255,255,0.55);
    font: 600 10px 'JetBrains Mono', monospace;
    letter-spacing: 0.1em; text-transform: uppercase;
    transition: all 140ms;
  }
  .crm-nc-ai-clear:hover {
    color: #f5f5f4;
    border-color: color-mix(in srgb, #fff 22%, transparent);
  }

  /* ── Sectioned form ── */
  .crm-nc-section {
    padding: 14px 16px;
    border-radius: 12px;
    background: color-mix(in srgb, #000 28%, transparent);
    border: 1px solid color-mix(in srgb, var(--g-primary) 12%, transparent);
    box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 4%, transparent);
  }
  .crm-nc-section-head {
    font: 700 10px 'JetBrains Mono', monospace;
    letter-spacing: 0.2em; text-transform: uppercase;
    color: color-mix(in srgb, var(--g-primary) 75%, #fff);
    margin-bottom: 10px;
    display: flex; align-items: center; gap: 8px;
  }
  .crm-nc-section-head .badge-count {
    color: rgba(255,255,255,0.4);
    font-weight: 500;
  }
  .crm-nc-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 10px;
  }
  .crm-nc-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
  .crm-nc-field-wide { grid-column: 1 / -1; }
  .crm-nc-label {
    font: 600 10px 'JetBrains Mono', monospace;
    letter-spacing: 0.1em; text-transform: uppercase;
    color: rgba(255,255,255,0.55);
    display: flex; align-items: center; gap: 6px;
  }
  .crm-nc-label .req { color: var(--g-primary); font-size: 11px; }
  .crm-nc-input,
  .crm-nc-textarea,
  .crm-nc-select {
    width: 100%;
    padding: 10px 12px;
    border-radius: 10px;
    background: color-mix(in srgb, #000 36%, transparent);
    border: 1px solid color-mix(in srgb, #fff 8%, transparent);
    color: #f5f5f4;
    font: 500 13px -apple-system, 'Inter', sans-serif;
    outline: none;
    box-sizing: border-box;
    transition: all 160ms ease;
  }
  .crm-nc-textarea { min-height: 80px; resize: vertical; line-height: 1.55; font-size: 12.5px; }
  .crm-nc-select {
    appearance: none; -webkit-appearance: none;
    padding-right: 30px;
    background:
      color-mix(in srgb, #000 36%, transparent)
      url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23a1a1aa' stroke-width='2.4' stroke-linecap='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E")
      no-repeat right 10px center;
    cursor: pointer;
  }
  .crm-nc-input:hover,
  .crm-nc-textarea:hover,
  .crm-nc-select:hover {
    border-color: color-mix(in srgb, #fff 14%, transparent);
    background-color: color-mix(in srgb, #000 28%, transparent);
  }
  .crm-nc-input:focus,
  .crm-nc-textarea:focus,
  .crm-nc-select:focus {
    border-color: color-mix(in srgb, var(--g-primary) 55%, transparent);
    background-color: color-mix(in srgb, #000 50%, transparent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--g-primary) 14%, transparent);
  }
  .crm-nc-input::placeholder,
  .crm-nc-textarea::placeholder { color: rgba(255,255,255,0.32); }
  .crm-nc-input.is-prefilled,
  .crm-nc-textarea.is-prefilled {
    border-color: color-mix(in srgb, var(--g-primary) 36%, transparent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--g-primary) 10%, transparent);
    animation: crmNcPrefill 700ms ease-out;
  }
  @keyframes crmNcPrefill {
    0%   { background-color: color-mix(in srgb, var(--g-primary) 22%, transparent); }
    100% { background-color: color-mix(in srgb, #000 36%, transparent); }
  }
  .crm-nc-hint { font: 400 11px 'Inter', sans-serif; color: rgba(255,255,255,0.4); }

  .crm-nc-multi {
    display: flex; flex-wrap: wrap; gap: 5px;
    padding: 8px;
    border-radius: 10px;
    background: color-mix(in srgb, #000 36%, transparent);
    border: 1px solid color-mix(in srgb, #fff 8%, transparent);
    min-height: 38px;
  }
  .crm-nc-chip {
    appearance: none; cursor: pointer;
    padding: 5px 11px;
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--g-primary) 20%, transparent);
    background: color-mix(in srgb, var(--g-primary) 6%, transparent);
    color: rgba(255,255,255,0.6);
    font: 600 10.5px 'Inter', sans-serif;
    transition: all 140ms;
  }
  .crm-nc-chip:hover {
    border-color: color-mix(in srgb, var(--g-primary) 45%, transparent);
    color: var(--g-primary);
  }
  .crm-nc-chip.is-selected {
    background: color-mix(in srgb, var(--g-primary) 22%, transparent);
    border-color: color-mix(in srgb, var(--g-primary) 50%, transparent);
    color: var(--g-primary);
    box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 14%, transparent);
  }

  .crm-nc-checkbox-row {
    display: inline-flex; align-items: center; gap: 8px;
    cursor: pointer;
    color: rgba(255,255,255,0.78);
    font: 500 12px 'Inter', sans-serif;
  }
  .crm-nc-checkbox-row input[type="checkbox"] {
    width: 16px; height: 16px; cursor: pointer; accent-color: var(--g-primary);
  }

  .crm-nc-foot {
    position: relative; z-index: 1;
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
    padding: 14px 22px 18px;
    border-top: 1px solid color-mix(in srgb, var(--g-primary) 12%, transparent);
    background: color-mix(in srgb, #000 26%, transparent);
  }
  .crm-nc-foot-status {
    font: 500 11.5px 'Inter', sans-serif;
    color: rgba(255,255,255,0.5);
  }
  .crm-nc-foot-actions { display: flex; gap: 8px; }

  /* ─── Card customization tokens ─────────────────────────── */
  /* When a card has data-card-color / data-card-style, these vars override
     the default gold sheen. The card uses the vars throughout so the new
     hue propagates to sheen, ring, glow, avatar, etc. */
  .crm-card[data-card-color] {
    --card-accent: var(--card-accent-override);
  }
  .crm-card[data-card-color]::before {
    background:
      radial-gradient(ellipse 70% 40% at 30% 0%,
        color-mix(in srgb, var(--card-accent) 16%, transparent),
        transparent 65%);
  }
  .crm-card[data-card-color] {
    background:
      linear-gradient(135deg,
        color-mix(in srgb, var(--card-accent) 6%, transparent),
        transparent 60%),
      linear-gradient(180deg,
        color-mix(in srgb, #fff 3%, transparent),
        color-mix(in srgb, #000 28%, transparent));
    border-color: color-mix(in srgb, var(--card-accent) 22%, transparent);
  }
  .crm-card[data-card-color]:hover {
    border-color: color-mix(in srgb, var(--card-accent) 50%, transparent);
    box-shadow:
      inset 0 1px 0 color-mix(in srgb, #fff 14%, transparent),
      0 22px 48px rgba(0, 0, 0, 0.42),
      0 0 32px color-mix(in srgb, var(--card-accent) 28%, transparent);
  }
  .crm-card[data-card-color].selected {
    border-color: color-mix(in srgb, var(--card-accent) 60%, transparent);
    box-shadow:
      inset 0 1px 0 color-mix(in srgb, #fff 14%, transparent),
      0 22px 48px rgba(0, 0, 0, 0.42),
      0 0 0 1px color-mix(in srgb, var(--card-accent) 45%, transparent),
      0 0 36px color-mix(in srgb, var(--card-accent) 30%, transparent);
  }

  /* Style variants */
  .crm-card[data-card-style="soft"] {
    background:
      linear-gradient(135deg,
        color-mix(in srgb, var(--card-accent, var(--g-primary)) 10%, transparent),
        color-mix(in srgb, var(--card-accent, var(--g-primary)) 2%, transparent) 70%),
      color-mix(in srgb, #000 22%, transparent);
    backdrop-filter: blur(24px) saturate(180%);
  }
  .crm-card[data-card-style="vivid"] {
    background:
      linear-gradient(135deg,
        color-mix(in srgb, var(--card-accent, var(--g-primary)) 22%, transparent),
        color-mix(in srgb, var(--card-accent, var(--g-primary)) 6%, transparent) 65%),
      linear-gradient(180deg,
        color-mix(in srgb, #fff 4%, transparent),
        color-mix(in srgb, #000 30%, transparent));
    border-color: color-mix(in srgb, var(--card-accent, var(--g-primary)) 50%, transparent);
    box-shadow:
      inset 0 1px 0 color-mix(in srgb, #fff 14%, transparent),
      0 12px 32px rgba(0, 0, 0, 0.36),
      0 0 24px color-mix(in srgb, var(--card-accent, var(--g-primary)) 22%, transparent);
  }
  .crm-card[data-card-style="vivid"]::before {
    background:
      radial-gradient(ellipse 80% 50% at 30% 0%,
        color-mix(in srgb, var(--card-accent, var(--g-primary)) 24%, transparent),
        transparent 70%);
    opacity: 0.9;
  }
  .crm-card[data-card-style="mono"] {
    background:
      linear-gradient(180deg,
        color-mix(in srgb, #fff 4%, transparent),
        color-mix(in srgb, #000 38%, transparent));
    border-color: color-mix(in srgb, #fff 14%, transparent);
  }
  .crm-card[data-card-style="mono"]::before { opacity: 0; }
  .crm-card[data-card-style="frosted"] {
    background:
      linear-gradient(180deg,
        color-mix(in srgb, #fff 12%, transparent),
        color-mix(in srgb, #fff 4%, transparent));
    border-color: color-mix(in srgb, #fff 24%, transparent);
    backdrop-filter: blur(28px) saturate(180%);
    color: #f5f5f4;
  }
  .crm-card[data-card-style="frosted"] .crm-card-name,
  .crm-card[data-card-style="frosted"] .crm-card-company,
  .crm-card[data-card-style="frosted"] .crm-card-detail { color: #f5f5f4; }

  /* Same accent override applies to kanban cards */
  .crm-kanban-card[data-card-color] {
    --card-accent: var(--card-accent-override);
    background:
      linear-gradient(135deg,
        color-mix(in srgb, var(--card-accent) 8%, transparent),
        transparent 60%),
      color-mix(in srgb, #000 28%, transparent);
    border-color: color-mix(in srgb, var(--card-accent) 22%, transparent);
  }
  .crm-kanban-card[data-card-color]:hover {
    border-color: color-mix(in srgb, var(--card-accent) 50%, transparent);
    box-shadow:
      inset 0 1px 0 color-mix(in srgb, #fff 14%, transparent),
      0 14px 30px rgba(0, 0, 0, 0.40),
      0 0 20px color-mix(in srgb, var(--card-accent) 26%, transparent);
  }

  /* Avatar with uploaded image */
  .crm-avatar.has-image,
  .crm-table-avatar.has-image {
    background-size: cover !important;
    background-position: center;
    color: transparent !important;
  }

  /* ─── Right-click context menu ──────────────────────────── */
  .crm-cardmenu {
    position: fixed; z-index: 1400;
    width: 280px;
    border-radius: 14px;
    overflow: hidden;
    background:
      linear-gradient(180deg,
        color-mix(in srgb, var(--g-primary) 6%, transparent),
        transparent 55%),
      linear-gradient(180deg,
        color-mix(in srgb, #fff 4%, transparent),
        color-mix(in srgb, #000 50%, transparent));
    border: 1px solid color-mix(in srgb, var(--g-primary) 26%, transparent);
    box-shadow:
      inset 0 1px 0 color-mix(in srgb, #fff 8%, transparent),
      0 30px 60px rgba(0, 0, 0, 0.6);
    backdrop-filter: blur(22px) saturate(180%);
    animation: cardmenuRise 180ms cubic-bezier(0.2, 0.9, 0.3, 1);
    user-select: none;
  }
  @keyframes cardmenuRise {
    from { opacity: 0; transform: translateY(6px) scale(0.97); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
  }
  .crm-cardmenu-head {
    padding: 10px 14px;
    border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
    display: flex; align-items: center; justify-content: space-between;
    background: color-mix(in srgb, var(--g-primary) 6%, transparent);
  }
  .crm-cardmenu-title {
    font: 700 9.5px 'JetBrains Mono', monospace;
    letter-spacing: 0.22em; text-transform: uppercase;
    color: color-mix(in srgb, var(--g-primary) 75%, #fff);
    display: inline-flex; align-items: center; gap: 6px;
  }
  .crm-cardmenu-title::before {
    content: ""; width: 5px; height: 5px; border-radius: 50%;
    background: var(--g-primary);
    box-shadow: 0 0 6px color-mix(in srgb, var(--g-primary) 60%, transparent);
  }
  .crm-cardmenu-close {
    appearance: none; cursor: pointer;
    width: 22px; height: 22px;
    border: 1px solid color-mix(in srgb, #fff 10%, transparent);
    background: transparent;
    color: rgba(255,255,255,0.55);
    border-radius: 6px;
    font: 600 12px sans-serif;
    display: inline-flex; align-items: center; justify-content: center;
    transition: all 140ms;
  }
  .crm-cardmenu-close:hover { background: color-mix(in srgb, #fff 6%, transparent); color: #f5f5f4; }

  .crm-cardmenu-section { padding: 12px 14px; border-bottom: 1px dashed color-mix(in srgb, #fff 5%, transparent); }
  .crm-cardmenu-section:last-child { border-bottom: none; }
  .crm-cardmenu-label {
    font: 600 9px 'JetBrains Mono', monospace;
    letter-spacing: 0.18em; text-transform: uppercase;
    color: rgba(255,255,255,0.45);
    margin-bottom: 8px;
  }
  .crm-cardmenu-colors {
    display: grid; grid-template-columns: repeat(6, 1fr); gap: 6px;
  }
  .crm-cardmenu-swatch {
    appearance: none; cursor: pointer;
    width: 100%; aspect-ratio: 1;
    border-radius: 10px;
    border: 1px solid color-mix(in srgb, #fff 10%, transparent);
    background: var(--swatch);
    box-shadow:
      inset 0 1px 0 color-mix(in srgb, #fff 22%, transparent),
      0 4px 10px color-mix(in srgb, var(--swatch) 28%, transparent);
    transition: transform 140ms, box-shadow 140ms;
    position: relative;
  }
  .crm-cardmenu-swatch:hover { transform: translateY(-2px) scale(1.08); }
  .crm-cardmenu-swatch.is-active {
    box-shadow:
      inset 0 1px 0 color-mix(in srgb, #fff 30%, transparent),
      0 0 0 2px color-mix(in srgb, #fff 70%, transparent),
      0 6px 14px color-mix(in srgb, var(--swatch) 50%, transparent);
  }
  .crm-cardmenu-swatch.is-active::after {
    content: "✓"; position: absolute; inset: 0;
    display: grid; place-items: center;
    color: #fff; font: 700 13px sans-serif;
    text-shadow: 0 1px 2px rgba(0,0,0,0.5);
  }
  .crm-cardmenu-swatch.clear {
    background:
      linear-gradient(45deg,
        transparent 47.5%, rgba(255,90,90,0.7) 47.5%,
        rgba(255,90,90,0.7) 52.5%, transparent 52.5%);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, #fff 10%, transparent);
  }

  .crm-cardmenu-styles {
    display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px;
  }
  .crm-cardmenu-style {
    appearance: none; cursor: pointer;
    padding: 8px 4px;
    border-radius: 9px;
    border: 1px solid color-mix(in srgb, #fff 8%, transparent);
    background: color-mix(in srgb, #000 36%, transparent);
    color: rgba(255,255,255,0.75);
    font: 600 9.5px 'JetBrains Mono', monospace;
    letter-spacing: 0.1em; text-transform: uppercase;
    transition: all 140ms;
  }
  .crm-cardmenu-style:hover {
    border-color: color-mix(in srgb, var(--g-primary) 40%, transparent);
    color: var(--g-primary);
  }
  .crm-cardmenu-style.is-active {
    background: color-mix(in srgb, var(--g-primary) 18%, transparent);
    border-color: color-mix(in srgb, var(--g-primary) 50%, transparent);
    color: var(--g-primary);
    box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 14%, transparent);
  }

  .crm-cardmenu-icon-row {
    display: flex; align-items: center; gap: 10px;
  }
  .crm-cardmenu-icon-preview {
    width: 48px; height: 48px;
    border-radius: 12px;
    border: 1px solid color-mix(in srgb, var(--g-primary) 22%, transparent);
    background:
      linear-gradient(135deg,
        color-mix(in srgb, var(--g-primary) 14%, transparent),
        transparent 60%),
      color-mix(in srgb, #000 38%, transparent);
    background-size: cover; background-position: center;
    display: grid; place-items: center;
    font: 700 16px 'Inter', sans-serif;
    color: var(--g-primary);
    flex-shrink: 0;
    box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 14%, transparent);
  }
  .crm-cardmenu-icon-btns { display: flex; flex-direction: column; gap: 6px; flex: 1; }
  .crm-cardmenu-icon-btn {
    appearance: none; cursor: pointer;
    padding: 7px 10px;
    border-radius: 8px;
    border: 1px solid color-mix(in srgb, var(--g-primary) 22%, transparent);
    background:
      linear-gradient(180deg,
        color-mix(in srgb, var(--g-primary) 14%, transparent),
        color-mix(in srgb, var(--g-primary) 6%, transparent));
    color: var(--g-primary);
    font: 600 10px 'JetBrains Mono', monospace;
    letter-spacing: 0.1em; text-transform: uppercase;
    transition: all 140ms;
  }
  .crm-cardmenu-icon-btn:hover {
    background:
      linear-gradient(180deg,
        color-mix(in srgb, var(--g-primary) 24%, transparent),
        color-mix(in srgb, var(--g-primary) 12%, transparent));
    transform: translateY(-1px);
  }
  .crm-cardmenu-icon-btn.is-danger {
    color: #fca5a5;
    border-color: rgba(239,68,68,0.32);
    background: linear-gradient(180deg, rgba(239,68,68,0.14), rgba(239,68,68,0.05));
  }
  .crm-cardmenu-icon-btn.is-danger:hover {
    background: linear-gradient(180deg, rgba(239,68,68,0.24), rgba(239,68,68,0.10));
  }
  .crm-cardmenu-hidden-file { display: none; }
  .crm-cardmenu-hint {
    margin-top: 6px;
    font: 500 10.5px 'Inter', sans-serif;
    color: rgba(255,255,255,0.42);
  }

  @media (max-width: 900px) {
    .crm-detail { width: 100%; position: fixed; inset: 0; z-index: 999; animation: crm-slide-in 0.2s ease-out; }
    .crm-grid { grid-template-columns: 1fr; }
    .crm-kanban-col { flex: 0 0 240px; }
    .crm-topbar { padding: 10px 12px; margin: 10px 10px 0; }
    .crm-search { width: 160px; }
    .crm-search:focus { width: 200px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .crm-card,
    .crm-card::before,
    .crm-kanban-card,
    .crm-view-btn,
    .crm-btn,
    .crm-table tbody tr {
      transition: none !important;
    }
    .crm-card:hover,
    .crm-kanban-card:hover { transform: none !important; }
  }

  /* ─── Full Client Detail Page (glassmorphism) ──────────────── */
  .crm-page-overlay {
    position: fixed; inset: 0; z-index: 1200;
    background:
      radial-gradient(ellipse 70% 50% at 0% 0%,
        color-mix(in srgb, var(--g-primary) 8%, transparent),
        transparent 55%),
      radial-gradient(ellipse 70% 50% at 100% 100%,
        color-mix(in srgb, #6366f1 6%, transparent),
        transparent 60%),
      color-mix(in srgb, #000 76%, transparent);
    backdrop-filter: blur(20px) saturate(140%);
    display: flex; flex-direction: column;
    animation: crmPageFade 200ms ease-out;
  }
  @keyframes crmPageFade { from { opacity: 0; } to { opacity: 1; } }
  @keyframes crmPageStep {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .crm-page-shell {
    flex: 1;
    width: min(1240px, 100%);
    margin: 0 auto;
    /* The overlay is position:fixed inset:0, so it starts UNDER the app's
       sticky .topbar (64px). Without this the first row of the record page —
       which is now the thread breadcrumb, the one control you need at every
       depth — renders behind the header. (ux-guidelines Navigation/Sticky
       Navigation: pad by the nav's height rather than letting it overlap.) */
    padding: 84px 32px 28px;
    display: flex; flex-direction: column; gap: 18px;
    overflow: hidden;
  }
  @media (max-width: 720px) {
    .crm-page-shell { padding: 72px 14px 18px; gap: 14px; }
  }

  .crm-page-bar {
    display: flex; align-items: center; justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
  }
  /* The thread bar is the widest thing in the row; give it the slack. */
  .crm-page-bar > .crm-thread-bar { flex: 1 1 420px; min-width: 0; }
  .crm-page-back {
    appearance: none; cursor: pointer;
    background: color-mix(in srgb, #fff 3%, transparent);
    border: 1px solid color-mix(in srgb, var(--g-primary) 16%, transparent);
    color: rgba(255,255,255,0.78);
    font: 600 10.5px 'JetBrains Mono', monospace;
    letter-spacing: 0.16em; text-transform: uppercase;
    padding: 8px 14px; border-radius: 10px;
    transition: all 140ms;
  }
  .crm-page-back:hover {
    background: color-mix(in srgb, var(--g-primary) 10%, transparent);
    color: var(--g-primary);
  }

  /* Hero card */
  .crm-page-hero {
    position: relative;
    padding: 26px 28px 22px;
    border-radius: 18px;
    background:
      linear-gradient(135deg,
        color-mix(in srgb, var(--g-primary) 6%, transparent),
        transparent 65%),
      linear-gradient(180deg,
        color-mix(in srgb, var(--g-bg, #0a0a0a) 92%, transparent),
        color-mix(in srgb, var(--g-bg, #0a0a0a) 78%, transparent));
    border: 1px solid color-mix(in srgb, var(--g-primary) 24%, transparent);
    box-shadow:
      inset 0 1px 0 color-mix(in srgb, #fff 8%, transparent),
      0 24px 60px rgba(0,0,0,0.55);
    overflow: hidden;
    animation: crmPageStep 280ms cubic-bezier(0.2, 0.9, 0.3, 1);
  }
  .crm-page-hero::before {
    content: ""; position: absolute; inset: 0;
    background:
      radial-gradient(ellipse 50% 60% at 0% 0%,
        color-mix(in srgb, var(--g-primary) 14%, transparent),
        transparent 65%);
    pointer-events: none;
  }
  .crm-page-hero-row { position: relative; display: flex; align-items: center; gap: 18px; }
  .crm-page-avatar {
    width: 76px; height: 76px;
    border-radius: 50%;
    display: grid; place-items: center;
    font: 700 28px 'Inter', sans-serif;
    color: #fff;
    box-shadow:
      inset 0 1px 0 color-mix(in srgb, #fff 22%, transparent),
      0 14px 28px rgba(0,0,0,0.45);
    border: 1px solid color-mix(in srgb, #fff 14%, transparent);
    flex-shrink: 0;
  }
  .crm-page-id-block { display: flex; flex-direction: column; gap: 4px; min-width: 0; flex: 1; }
  .crm-page-eyebrow {
    font: 700 9.5px 'JetBrains Mono', monospace;
    letter-spacing: 0.22em; text-transform: uppercase;
    color: color-mix(in srgb, var(--g-primary) 75%, #fff);
    display: inline-flex; align-items: center; gap: 8px;
  }
  .crm-page-eyebrow-dot {
    width: 6px; height: 6px; border-radius: 50%;
    background: var(--g-primary);
    box-shadow: 0 0 8px color-mix(in srgb, var(--g-primary) 60%, transparent);
  }
  .crm-page-name-input {
    width: 100%;
    font: 700 32px/1.15 -apple-system, 'Inter', sans-serif;
    letter-spacing: -0.018em;
    color: #f5f5f4;
    background: transparent;
    border: none; outline: none;
    padding: 0; margin: 0;
  }
  .crm-page-name-input:focus {
    background: color-mix(in srgb, #fff 4%, transparent);
    border-radius: 8px; padding: 4px 8px; margin: -4px -8px;
  }
  .crm-page-sub {
    font: 400 13px 'Inter', sans-serif;
    color: rgba(255,255,255,0.55);
    display: inline-flex; flex-wrap: wrap; gap: 12px; align-items: center;
  }
  .crm-page-sub-pill {
    padding: 3px 10px; border-radius: 999px;
    font: 600 10.5px 'JetBrains Mono', monospace;
    letter-spacing: 0.08em;
    background: color-mix(in srgb, #fff 4%, transparent);
    border: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
    color: rgba(255,255,255,0.78);
  }
  .crm-page-hero-actions {
    position: relative;
    display: flex; gap: 8px; flex-shrink: 0;
  }
  .crm-page-action {
    appearance: none; cursor: pointer;
    padding: 9px 14px; border-radius: 10px;
    font: 600 10.5px 'JetBrains Mono', monospace;
    letter-spacing: 0.14em; text-transform: uppercase;
    background: color-mix(in srgb, #fff 3%, transparent);
    border: 1px solid color-mix(in srgb, var(--g-primary) 18%, transparent);
    color: rgba(255,255,255,0.78);
    transition: all 140ms;
  }
  .crm-page-action:hover {
    background: color-mix(in srgb, var(--g-primary) 14%, transparent);
    border-color: color-mix(in srgb, var(--g-primary) 40%, transparent);
    color: var(--g-primary);
    transform: translateY(-1px);
  }
  .crm-page-action.is-danger:hover {
    background: color-mix(in srgb, #ef4444 18%, transparent);
    border-color: color-mix(in srgb, #ef4444 50%, transparent);
    color: #f87171;
  }

  /* Tabs */
  .crm-page-tabs {
    display: flex; gap: 4px;
    padding: 6px; border-radius: 14px;
    background: color-mix(in srgb, #000 32%, transparent);
    border: 1px solid color-mix(in srgb, var(--g-primary) 12%, transparent);
    width: fit-content; max-width: 100%;
    overflow-x: auto;
  }
  .crm-page-tab {
    appearance: none; cursor: pointer;
    padding: 8px 16px; border-radius: 10px;
    background: transparent; border: none;
    font: 600 11px 'Inter', sans-serif;
    color: rgba(255,255,255,0.6);
    letter-spacing: 0.02em;
    display: inline-flex; align-items: center; gap: 8px;
    white-space: nowrap;
    transition: all 140ms;
  }
  .crm-page-tab:hover { color: #f5f5f4; }
  .crm-page-tab.is-active {
    background: color-mix(in srgb, var(--g-primary) 16%, transparent);
    color: var(--g-primary);
    box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 6%, transparent);
  }
  .crm-page-tab-badge {
    min-width: 18px; height: 18px; padding: 0 6px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--g-primary) 22%, transparent);
    color: var(--g-primary);
    font: 700 9px 'JetBrains Mono', monospace;
    display: inline-flex; align-items: center; justify-content: center;
  }
  .crm-page-tab.is-active .crm-page-tab-badge {
    background: color-mix(in srgb, var(--g-primary) 28%, transparent);
  }

  /* Tab body */
  .crm-page-body {
    flex: 1;
    overflow-y: auto;
    padding-right: 6px;
    animation: crmPageStep 240ms cubic-bezier(0.2, 0.9, 0.3, 1) both;
  }
  .crm-page-body::-webkit-scrollbar { width: 6px; }
  .crm-page-body::-webkit-scrollbar-thumb {
    background: color-mix(in srgb, var(--g-primary) 24%, transparent);
    border-radius: 999px;
  }

  .crm-page-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 14px;
  }
  .crm-page-card {
    padding: 18px 20px;
    border-radius: 14px;
    background:
      linear-gradient(135deg,
        color-mix(in srgb, var(--g-primary) 4%, transparent),
        transparent 70%),
      color-mix(in srgb, var(--g-bg, #0a0a0a) 88%, transparent);
    border: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
    box-shadow:
      inset 0 1px 0 color-mix(in srgb, #fff 6%, transparent),
      0 8px 20px rgba(0,0,0,0.28);
  }
  .crm-page-card-title {
    font: 700 9.5px 'JetBrains Mono', monospace;
    letter-spacing: 0.2em; text-transform: uppercase;
    color: color-mix(in srgb, var(--g-primary) 80%, #fff);
    margin: 0 0 12px;
    display: flex; justify-content: space-between; align-items: center;
  }
  .crm-page-prop {
    display: grid; grid-template-columns: 110px 1fr;
    gap: 10px; padding: 8px 0;
    border-bottom: 1px dashed color-mix(in srgb, #fff 6%, transparent);
    font-size: 12.5px;
    align-items: center;
  }
  .crm-page-prop:last-child { border-bottom: none; }
  .crm-page-prop-label {
    font: 500 10.5px 'JetBrains Mono', monospace;
    letter-spacing: 0.06em;
    color: rgba(255,255,255,0.5);
    text-transform: uppercase;
  }
  .crm-page-prop-value { color: #f5f5f4; min-width: 0; word-break: break-word; }
  .crm-page-prop-input,
  .crm-page-prop-select,
  .crm-page-prop-textarea {
    width: 100%;
    padding: 7px 9px;
    border-radius: 8px;
    background: color-mix(in srgb, #000 40%, transparent);
    border: 1px solid transparent;
    color: #f5f5f4;
    font: 500 12.5px -apple-system, 'Inter', sans-serif;
    transition: border-color 140ms, background 140ms;
  }
  .crm-page-prop-textarea { min-height: 70px; resize: vertical; line-height: 1.5; }
  .crm-page-prop-input:hover,
  .crm-page-prop-select:hover,
  .crm-page-prop-textarea:hover {
    background: color-mix(in srgb, #000 28%, transparent);
    border-color: color-mix(in srgb, #fff 8%, transparent);
  }
  .crm-page-prop-input:focus,
  .crm-page-prop-select:focus,
  .crm-page-prop-textarea:focus {
    outline: none;
    border-color: color-mix(in srgb, var(--g-primary) 50%, transparent);
    background: color-mix(in srgb, #000 50%, transparent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--g-primary) 12%, transparent);
  }

  /* Docs editor */
  .crm-page-docs {
    padding: 18px 22px;
    border-radius: 14px;
    background:
      linear-gradient(135deg,
        color-mix(in srgb, var(--g-primary) 4%, transparent),
        transparent 70%),
      color-mix(in srgb, var(--g-bg, #0a0a0a) 92%, transparent);
    border: 1px solid color-mix(in srgb, var(--g-primary) 16%, transparent);
    box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 6%, transparent);
  }
  .crm-page-docs-bar {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 14px;
  }
  .crm-page-docs-title {
    font: 700 11px 'JetBrains Mono', monospace;
    letter-spacing: 0.2em; text-transform: uppercase;
    color: color-mix(in srgb, var(--g-primary) 80%, #fff);
  }
  .crm-page-docs-status {
    font: 500 10.5px 'JetBrains Mono', monospace;
    color: rgba(255,255,255,0.55);
  }
  .crm-page-docs-status.is-dirty { color: var(--g-primary); }
  .crm-page-md-preview {
    font: 400 14px/1.65 -apple-system, 'Inter', sans-serif;
    color: rgba(245,245,244,0.92);
    min-height: 200px;
    padding: 10px 6px;
  }
  .crm-page-md-preview h1,
  .crm-page-md-preview h2,
  .crm-page-md-preview h3 { color: #f5f5f4; }
  .crm-page-md-preview h1 { font-size: 22px; margin: 18px 0 10px; }
  .crm-page-md-preview h2 { font-size: 18px; margin: 16px 0 8px; }
  .crm-page-md-preview h3 { font-size: 15px; margin: 14px 0 6px; }
  .crm-page-md-preview p { margin: 8px 0; }
  .crm-page-md-preview code {
    background: color-mix(in srgb, var(--g-primary) 12%, transparent);
    border-radius: 4px; padding: 2px 6px;
    font: 500 12.5px 'JetBrains Mono', monospace;
    color: var(--g-primary);
  }
  .crm-page-md-preview pre {
    background: color-mix(in srgb, #000 50%, transparent);
    border: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
    border-radius: 8px; padding: 12px 14px;
    overflow-x: auto;
  }
  .crm-page-md-preview pre code {
    background: transparent; padding: 0; color: rgba(245,245,244,0.94);
  }
  .crm-page-md-preview ul,
  .crm-page-md-preview ol { margin: 8px 0; padding-left: 22px; }
  .crm-page-md-preview a { color: var(--g-primary); }
  .crm-page-md-preview blockquote {
    border-left: 3px solid color-mix(in srgb, var(--g-primary) 50%, transparent);
    padding-left: 12px;
    margin: 10px 0;
    color: rgba(255,255,255,0.65);
  }
  .crm-page-docs-empty {
    text-align: center;
    padding: 40px 20px;
    color: rgba(255,255,255,0.45);
    font: 400 13px 'Inter', sans-serif;
  }

  /* Relations */
  .crm-page-rel-group { margin-bottom: 18px; }
  .crm-page-rel-head {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 10px;
  }
  .crm-page-rel-head-left {
    display: inline-flex; align-items: center; gap: 10px;
  }
  .crm-page-rel-pills {
    display: flex; flex-wrap: wrap; gap: 6px;
    min-height: 28px;
  }
  .crm-page-rel-pill {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 6px 10px 6px 12px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--g-primary) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--g-primary) 28%, transparent);
    color: var(--g-primary);
    font: 600 11px 'Inter', sans-serif;
    animation: crmPageStep 200ms;
  }
  .crm-page-rel-pill-rm {
    appearance: none; cursor: pointer;
    width: 16px; height: 16px;
    border-radius: 50%;
    border: none; background: transparent;
    color: var(--g-primary); opacity: 0.6;
    display: inline-flex; align-items: center; justify-content: center;
    font: 700 12px 'Inter', sans-serif;
    transition: opacity 140ms, background 140ms;
  }
  .crm-page-rel-pill-rm:hover {
    opacity: 1; background: color-mix(in srgb, var(--g-primary) 20%, transparent);
  }
  .crm-page-rel-empty {
    color: rgba(255,255,255,0.4); font: 400 12px 'Inter', sans-serif;
    padding: 4px 0;
  }
  /* Project pills navigate to the kanban project on click. */
  .crm-page-rel-pill.is-navigable { cursor: pointer; transition: background 140ms, border-color 140ms; }
  .crm-page-rel-pill.is-navigable:hover {
    background: color-mix(in srgb, var(--g-primary) 20%, transparent);
    border-color: color-mix(in srgb, var(--g-primary) 50%, transparent);
  }
  /* Loading skeleton shimmer pills — match the relation-pill silhouette. */
  .crm-page-rel-skel {
    display: inline-block; height: 28px; border-radius: 999px;
    background: linear-gradient(90deg,
      rgba(255,255,255,0.04) 25%,
      rgba(255,255,255,0.09) 37%,
      rgba(255,255,255,0.04) 63%);
    background-size: 400% 100%;
    animation: crm-rel-shimmer 1.4s ease infinite;
  }
  @keyframes crm-rel-shimmer { 0% { background-position: 100% 0; } 100% { background-position: 0 0; } }
  .crm-page-rel-error {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 10px 12px; margin-bottom: 14px;
    border-radius: 8px;
    background: rgba(239,68,68,0.08);
    border: 1px solid rgba(239,68,68,0.3);
    color: #fca5a5; font: 500 12px 'Inter', sans-serif;
  }
  .crm-page-rel-retry {
    appearance: none; cursor: pointer; flex-shrink: 0;
    padding: 5px 12px; border-radius: 999px;
    background: transparent; border: 1px solid rgba(239,68,68,0.5);
    color: #fca5a5; font: 600 10.5px 'JetBrains Mono', monospace;
    letter-spacing: 0.08em; text-transform: uppercase;
    transition: all 140ms;
  }
  .crm-page-rel-retry:hover { background: rgba(239,68,68,0.15); }
  .crm-page-rel-add {
    appearance: none; cursor: pointer;
    padding: 6px 12px; border-radius: 999px;
    background: transparent;
    border: 1px dashed color-mix(in srgb, var(--g-primary) 35%, transparent);
    color: var(--g-primary);
    font: 600 10.5px 'JetBrains Mono', monospace;
    letter-spacing: 0.08em; text-transform: uppercase;
    transition: all 140ms;
  }
  .crm-page-rel-add:hover {
    background: color-mix(in srgb, var(--g-primary) 12%, transparent);
    border-style: solid;
  }

  /* Relation picker dropdown */
  .crm-page-picker {
    position: relative;
    margin-top: 8px;
    padding: 12px;
    border-radius: 12px;
    background: color-mix(in srgb, #000 50%, transparent);
    border: 1px solid color-mix(in srgb, var(--g-primary) 26%, transparent);
    box-shadow: 0 12px 30px rgba(0,0,0,0.4);
    animation: crmPageStep 180ms;
  }
  .crm-page-picker-input {
    width: 100%;
    padding: 9px 12px;
    border-radius: 8px;
    background: color-mix(in srgb, #000 30%, transparent);
    border: 1px solid color-mix(in srgb, var(--g-primary) 18%, transparent);
    color: #f5f5f4;
    font: 500 12.5px 'Inter', sans-serif;
    margin-bottom: 8px;
  }
  .crm-page-picker-input:focus {
    outline: none;
    border-color: color-mix(in srgb, var(--g-primary) 55%, transparent);
  }
  .crm-page-picker-list {
    max-height: 220px;
    overflow-y: auto;
    display: flex; flex-direction: column; gap: 2px;
  }
  .crm-page-picker-list::-webkit-scrollbar { width: 5px; }
  .crm-page-picker-list::-webkit-scrollbar-thumb {
    background: color-mix(in srgb, var(--g-primary) 24%, transparent);
    border-radius: 999px;
  }
  .crm-page-picker-row {
    appearance: none; cursor: pointer;
    text-align: left;
    padding: 8px 10px;
    border-radius: 8px;
    background: transparent;
    border: 1px solid transparent;
    color: rgba(255,255,255,0.82);
    font: 500 12px 'Inter', sans-serif;
    transition: all 120ms;
    display: flex; justify-content: space-between; align-items: center;
  }
  .crm-page-picker-row:hover {
    background: color-mix(in srgb, var(--g-primary) 12%, transparent);
    border-color: color-mix(in srgb, var(--g-primary) 24%, transparent);
    color: var(--g-primary);
  }
  .crm-page-picker-row.is-selected {
    background: color-mix(in srgb, var(--g-primary) 18%, transparent);
    color: var(--g-primary);
  }
  .crm-page-picker-empty {
    text-align: center; padding: 18px 12px;
    color: rgba(255,255,255,0.4);
    font: 400 12px 'Inter', sans-serif;
  }
  .crm-page-picker-close {
    appearance: none; cursor: pointer;
    margin-top: 6px;
    width: 100%;
    padding: 6px;
    border-radius: 8px;
    background: transparent;
    border: 1px solid color-mix(in srgb, #fff 8%, transparent);
    color: rgba(255,255,255,0.55);
    font: 600 10.5px 'JetBrains Mono', monospace;
    letter-spacing: 0.12em; text-transform: uppercase;
  }
  .crm-page-picker-close:hover {
    background: color-mix(in srgb, #fff 6%, transparent); color: #f5f5f4;
  }

  /* ── Linked kanban board (inside client detail Overview) ── */
  .crm-page-board {
    margin-bottom: 14px;
    padding: 18px 20px 16px;
    border-radius: 16px;
    background:
      linear-gradient(135deg,
        color-mix(in srgb, var(--g-primary) 5%, transparent),
        transparent 60%),
      linear-gradient(180deg,
        color-mix(in srgb, #fff 3%, transparent),
        color-mix(in srgb, #000 28%, transparent));
    border: 1px solid color-mix(in srgb, var(--g-primary) 18%, transparent);
    box-shadow:
      inset 0 1px 0 color-mix(in srgb, #fff 6%, transparent),
      0 14px 32px rgba(0,0,0,0.32);
    backdrop-filter: blur(14px) saturate(150%);
  }
  .crm-page-board-head {
    display: flex; align-items: center; justify-content: space-between;
    gap: 10px;
    margin-bottom: 12px;
  }
  .crm-page-board-head-left {
    display: inline-flex; align-items: center; gap: 10px;
  }
  .crm-page-board-title {
    font: 700 11px 'JetBrains Mono', monospace;
    letter-spacing: 0.2em; text-transform: uppercase;
    color: color-mix(in srgb, var(--g-primary) 80%, #fff);
    display: inline-flex; align-items: center; gap: 8px;
  }
  .crm-page-board-title::before {
    content: ""; width: 6px; height: 6px; border-radius: 50%;
    background: var(--g-primary);
    box-shadow: 0 0 8px color-mix(in srgb, var(--g-primary) 60%, transparent);
  }
  .crm-page-board-pill {
    padding: 3px 9px; border-radius: 999px;
    font: 600 10px 'JetBrains Mono', monospace;
    letter-spacing: 0.08em;
    background: color-mix(in srgb, #fff 4%, transparent);
    border: 1px solid color-mix(in srgb, var(--g-primary) 18%, transparent);
    color: rgba(255,255,255,0.7);
  }
  .crm-page-board-cols {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 10px;
  }
  .crm-page-board-col {
    padding: 10px 10px 12px;
    border-radius: 12px;
    background: color-mix(in srgb, #000 32%, transparent);
    border: 1px solid color-mix(in srgb, #fff 6%, transparent);
    min-height: 100px;
  }
  .crm-page-board-col-head {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 8px;
    font: 700 9.5px 'JetBrains Mono', monospace;
    letter-spacing: 0.18em; text-transform: uppercase;
  }
  .crm-page-board-col-count {
    padding: 2px 8px; border-radius: 999px;
    background: color-mix(in srgb, #fff 6%, transparent);
    color: rgba(255,255,255,0.6);
    font: 700 9px 'JetBrains Mono', monospace;
  }
  .crm-page-board-col.is-todo  .crm-page-board-col-head { color: #94a3b8; }
  .crm-page-board-col.is-doing .crm-page-board-col-head { color: #fcd34d; }
  .crm-page-board-col.is-done  .crm-page-board-col-head { color: #4ade80; }
  .crm-page-board-col.is-block .crm-page-board-col-head { color: #fca5a5; }

  .crm-page-board-task {
    padding: 9px 10px;
    border-radius: 9px;
    background:
      linear-gradient(180deg,
        color-mix(in srgb, #fff 3%, transparent),
        color-mix(in srgb, #000 24%, transparent));
    border: 1px solid color-mix(in srgb, var(--g-primary) 12%, transparent);
    margin-bottom: 6px;
    box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 6%, transparent);
    transition: border-color 140ms, box-shadow 140ms, transform 140ms;
  }
  .crm-page-board-task:hover {
    border-color: color-mix(in srgb, var(--g-primary) 35%, transparent);
    box-shadow:
      inset 0 1px 0 color-mix(in srgb, #fff 10%, transparent),
      0 6px 16px rgba(0,0,0,0.32);
    transform: translateY(-1px);
  }
  .crm-page-board-task-title {
    font: 600 12px/1.35 -apple-system, 'Inter', sans-serif;
    color: #f5f5f4;
    margin-bottom: 4px;
  }
  .crm-page-board-task-meta {
    display: flex; flex-wrap: wrap; gap: 4px;
    font: 500 10px 'Inter', sans-serif;
    color: rgba(255,255,255,0.5);
  }
  .crm-page-board-task-pill {
    padding: 2px 7px; border-radius: 999px;
    background: color-mix(in srgb, var(--g-primary) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--g-primary) 22%, transparent);
    color: var(--g-primary);
    font: 600 9px 'JetBrains Mono', monospace;
    letter-spacing: 0.06em;
  }
  .crm-page-board-task-pill.priority-high { background: rgba(239,68,68,0.14); border-color: rgba(239,68,68,0.4); color: #fca5a5; }
  .crm-page-board-task-pill.priority-low  { background: rgba(100,116,139,0.14); border-color: rgba(100,116,139,0.4); color: #cbd5e1; }
  .crm-page-board-empty {
    color: rgba(255,255,255,0.32);
    font: 400 11px 'Inter', sans-serif;
    text-align: center;
    padding: 16px 8px;
  }
  .crm-page-board-empty-msg {
    grid-column: 1 / -1;
    text-align: center; padding: 24px 12px;
    color: rgba(255,255,255,0.45);
    font: 500 12.5px 'Inter', sans-serif;
  }

  /* Activity placeholder */
  .crm-page-activity-empty {
    text-align: center; padding: 64px 20px;
    color: rgba(255,255,255,0.45);
    font: 400 13px 'Inter', sans-serif;
  }

  /* ─── Page-level tabs ──────────────────────────────────── */
  .crm-page-tabs-bar {
    display: flex; gap: 4px; padding: 10px 18px 0;
    border-bottom: 1px solid rgba(255,255,255,0.08);
    flex-shrink: 0;
  }
  .crm-page-tab-btn {
    background: transparent; border: none; cursor: pointer;
    padding: 8px 16px;
    font: 500 12px 'Inter', sans-serif;
    color: rgba(255,255,255,0.55);
    border-bottom: 2px solid transparent;
    margin-bottom: -1px; transition: color .15s, border-color .15s;
    border-radius: 4px 4px 0 0;
  }
  .crm-page-tab-btn:hover { color: rgba(255,255,255,0.85); }
  .crm-page-tab-btn.active {
    color: var(--g-primary);
    border-bottom-color: var(--g-primary);
  }

  /* ─── Stat band ─────────────────────────────────────────── */
  .crm-stat-band {
    display: flex; gap: 10px; padding: 14px 18px 0;
    flex-shrink: 0; flex-wrap: wrap;
  }
  .crm-stat-card {
    flex: 1; min-width: 110px;
    background: rgba(255,255,255,0.04);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 10px; padding: 12px 14px;
    display: flex; flex-direction: column; gap: 4px;
    transition: border-color .15s;
  }
  .crm-stat-card:hover { border-color: rgba(255,255,255,0.16); }
  .crm-stat-card.gold { border-color: color-mix(in srgb, var(--g-primary) 30%, transparent); }
  .crm-stat-card.warn { border-color: rgba(239,68,68,0.35); }
  .crm-stat-value {
    font: 700 22px 'Inter', sans-serif;
    color: #fff; line-height: 1;
  }
  .crm-stat-card.gold .crm-stat-value { color: var(--g-primary); }
  .crm-stat-card.warn .crm-stat-value { color: #f87171; }
  .crm-stat-label {
    font: 500 9px 'Inter', sans-serif;
    color: rgba(255,255,255,0.45);
    text-transform: uppercase; letter-spacing: .06em;
  }

  /* ─── Pagination ────────────────────────────────────────── */
  .crm-pagination {
    display: flex; align-items: center; justify-content: center; gap: 4px;
    padding: 14px 18px; flex-shrink: 0;
  }
  .crm-pg-btn {
    background: rgba(255,255,255,0.05);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 6px; padding: 5px 10px;
    font: 500 11px 'Inter', sans-serif; color: rgba(255,255,255,0.7);
    cursor: pointer; transition: background .12s, border-color .12s, color .12s;
  }
  .crm-pg-btn:hover:not(:disabled) { background: rgba(255,255,255,0.1); color: #fff; }
  .crm-pg-btn.active {
    background: color-mix(in srgb, var(--g-primary) 18%, transparent);
    border-color: var(--g-primary); color: var(--g-primary);
  }
  .crm-pg-btn:disabled { opacity: 0.35; cursor: default; }
  .crm-pg-ellipsis { color: rgba(255,255,255,0.4); padding: 0 4px; }

  /* ─── Revenue page ──────────────────────────────────────── */
  .crm-rev-page { padding: 16px 18px; overflow-y: auto; height: 100%; }
  .crm-rev-header {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 16px;
  }
  .crm-rev-total {
    font: 700 28px 'Inter', sans-serif; color: var(--g-primary); margin-top: 4px;
  }
  .crm-rev-chart-wrap {
    background: rgba(255,255,255,0.04);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 10px; padding: 14px;
    margin-bottom: 16px;
  }
  .crm-rev-table {
    width: 100%; border-collapse: collapse;
    font: 400 12px 'Inter', sans-serif;
  }
  .crm-rev-th {
    text-align: left; padding: 8px 10px;
    font: 600 10px 'Inter', sans-serif; color: rgba(255,255,255,0.45);
    text-transform: uppercase; letter-spacing: .05em;
    border-bottom: 1px solid rgba(255,255,255,0.1);
  }
  .crm-rev-row:hover td { background: rgba(255,255,255,0.04); }
  .crm-rev-td { padding: 9px 10px; color: rgba(255,255,255,0.8); border-bottom: 1px solid rgba(255,255,255,0.06); }
</style>
`;

// ── Main Render ──────────────────────────────────────────────

export function renderClients(state: AppViewState, client: GatewayBrowserClient) {
  const cs = state.businessState?._clientsState;
  if (!cs) return html`<div class="crm-page ba-glass">${baAurora()}${clientStyles}<div class="crm-loading"><span class="crm-loading-dot">◆</span> INITIALIZING</div></div>`;
  if (cs.loading) {
    const lp = cs.loadProgress;
    return html`<div class="crm-page ba-glass">${baAurora()}${clientStyles}<div class="crm-loading">
      <span class="crm-loading-dot">◆</span> LOADING CLIENTS${lp
        ? html` — ${fmtCount(lp.loaded)} / ${fmtCount(lp.total)}`
        : nothing}
    </div></div>`;
  }

  // Deep-link: a pasted /clients/:slug URL auto-opens that client once the list
  // has loaded. Fires exactly once (consumeDeepLink clears the pending flag).
  {
    const dlHost = state as unknown as Parameters<typeof consumeDeepLink>[0];
    const ref = consumeDeepLink(
      dlHost,
      "client",
      cs.clients.map((c) => ({ id: c.id, name: getClientName(c, cs.schema) })),
    );
    if (ref?.id && cs.detailClient?.id !== ref.id) {
      const record = cs.clients.find((c) => c.id === ref.id);
      if (record) openClientDetail(state, client, record);
    }
  }

  return html`
    <div class="crm-page ba-glass">
      ${baAurora()}
      ${clientStyles}
      ${cs.success ? html`<div class="crm-success">${cs.success}</div>` : nothing}
      ${cs.error ? html`<div class="crm-error"><span>⚠ ${cs.error}</span><button class="crm-error-dismiss" @click=${() => { cs.error = null; state.requestUpdate?.(); }}>✕</button></div>` : nothing}
      ${renderPageTabs(state, cs, client)}
      <div class="crm-hub-links">
        ${renderHubLink(state, {
          section: "pipeline",
          title: "Pipeline has moved to Business hub",
          text: "Deals, stages and weighted forecasts now use the single shared Business hub pipeline.",
          cta: "Open pipeline",
        })}
        ${renderHubLink(state, {
          section: "revenue",
          title: "Revenue has moved to Business hub",
          text: "Revenue, transactions and customer attribution now live in one canonical ledger view.",
          cta: "Open revenue",
        })}
      </div>
      ${cs.pageTab === "clients" ? html`
        ${renderStatCards(cs)}
        ${renderTopBar(state, cs, client)}
        ${renderNotionBar(state, cs, client)}
        <div class="crm-content">
          <div class="crm-main">
            ${cs.clients.length === 0
              ? renderEmptyState(state, cs, client)
              : cs.viewMode === "grid"
                ? renderGridView(state, cs, client)
                : cs.viewMode === "table"
                  ? renderTableView(state, cs, client)
                  : renderKanbanView(state, cs, client)}
            ${cs.viewMode !== "kanban" && cs.totalPages > 1 ? renderPagination(state, cs) : nothing}
          </div>
          ${cs.showDetailPanel && cs.detailClient ? renderDetailPanel(state, cs, client) : nothing}
        </div>
      ` : cs.pageTab === "activity" ? renderActivityPage(state, cs, client)
        : html`<div class="crm-empty"><div class="crm-empty-text">This view now lives in Business hub. Use the gold shortcut above.</div></div>`}
      ${cs.showCreateDialog ? renderCreateDialog(state, cs, client) : nothing}
      ${cs.showEditDialog ? renderEditDialog(state, cs, client) : nothing}
      ${cs.showDeleteConfirm ? renderDeleteConfirm(state, cs, client) : nothing}
      ${cs.showImportDialog ? renderImportDialog(state, cs, client) : nothing}
      ${renderCardContextMenu(state, cs, client)}
    </div>
    ${invoicingStyles}
    ${clientAgencyStyles}
    ${objectConnectionsStyles}
    <!-- The composer is a fixed overlay. It is mounted here, outside
         .crm-page-overlay, because that element carries a backdrop-filter and
         so would become the containing block for anything fixed inside it. -->
    ${renderInvoiceComposer(state, ensureAgencyOperationsState(state), client)}
  `;
}

// ── Page Tabs ────────────────────────────────────────────────

function renderPageTabs(state: AppViewState, cs: ClientsState, client: GatewayBrowserClient) {
  const tabs: { id: ClientsState["pageTab"]; label: string }[] = [
    { id: "clients", label: "Clients" },
    { id: "activity", label: "Activity" },
  ];
  return html`
    <div class="crm-page-tabs-bar">
      ${tabs.map((t) => html`
        <button
          data-learn-id=${`clients-tab-${t.id}`}
          class="crm-page-tab-btn ${cs.pageTab === t.id ? "active" : ""}"
          @click=${() => {
            cs.pageTab = t.id;
            state.requestUpdate?.();
          }}
        >${t.label}</button>
      `)}
    </div>
  `;
}

// ── Stat Cards ───────────────────────────────────────────────

function fmtCurrency(cents: number): string {
  const dollars = cents / 100;
  if (dollars >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(1)}M`;
  if (dollars >= 1_000) return `$${(dollars / 1_000).toFixed(1)}K`;
  return `$${dollars.toFixed(0)}`;
}

function renderStatCards(cs: ClientsState) {
  const s = cs.stats;
  const total = (s?.total ?? cs.totalClients) || cs.clients.length;
  const active = s?.active ?? 0;
  const mrr = s?.totalMrrCents ?? 0;
  const avgDeal = s?.avgDealCents ?? 0;
  const churn = s?.churnCount ?? 0;
  const cards = [
    { label: "TOTAL CLIENTS", value: String(total) },
    { label: "ACTIVE", value: String(active), gold: true },
    { label: "MRR", value: fmtCurrency(mrr), gold: true },
    { label: "AVG DEAL", value: fmtCurrency(avgDeal) },
    { label: "CHURNED", value: String(churn), warn: churn > 0 },
  ];
  return html`
    <div class="crm-stat-band">
      ${cards.map((c) => html`
        <div class="crm-stat-card ${c.gold ? "gold" : ""} ${c.warn ? "warn" : ""}">
          <span class="crm-stat-value">${c.value}</span>
          <span class="crm-stat-label">${c.label}</span>
        </div>
      `)}
    </div>
  `;
}

// ── Pagination ───────────────────────────────────────────────

function renderPagination(state: AppViewState, cs: ClientsState) {
  const { page, totalPages } = cs;
  const pages: (number | "…")[] = [];
  if (totalPages <= 7) {
    for (let i = 1; i <= totalPages; i++) pages.push(i);
  } else {
    pages.push(1);
    if (page > 3) pages.push("…");
    for (let i = Math.max(2, page - 1); i <= Math.min(totalPages - 1, page + 1); i++) pages.push(i);
    if (page < totalPages - 2) pages.push("…");
    pages.push(totalPages);
  }
  const go = (p: number) => { cs.page = Math.max(1, Math.min(totalPages, p)); state.requestUpdate?.(); };
  return html`
    <div class="crm-pagination">
      <button class="crm-pg-btn" ?disabled=${page <= 1} @click=${() => go(page - 1)}>‹ Prev</button>
      ${pages.map((p) =>
        p === "…"
          ? html`<span class="crm-pg-ellipsis">…</span>`
          : html`<button class="crm-pg-btn ${p === page ? "active" : ""}" @click=${() => go(p as number)}>${p}</button>`
      )}
      <button class="crm-pg-btn" ?disabled=${page >= totalPages} @click=${() => go(page + 1)}>Next ›</button>
    </div>
  `;
}

// ── Revenue Page ─────────────────────────────────────────────

function renderRevenuePage(state: AppViewState, cs: ClientsState, client: GatewayBrowserClient) {
  const entries = [...cs.revenueEntries].sort((a, b) => {
    if (cs.revenueSortCol === "amount") return cs.revenueSortDir === "asc" ? a.amountCents - b.amountCents : b.amountCents - a.amountCents;
    if (cs.revenueSortCol === "client") return cs.revenueSortDir === "asc" ? a.clientId.localeCompare(b.clientId) : b.clientId.localeCompare(a.clientId);
    return cs.revenueSortDir === "asc" ? a.loggedAt - b.loggedAt : b.loggedAt - a.loggedAt;
  });

  const now = Date.now();
  const months = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(now);
    d.setMonth(d.getMonth() - (11 - i));
    return { year: d.getFullYear(), month: d.getMonth(), total: 0, label: ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getMonth()] };
  });
  for (const e of cs.revenueEntries) {
    const d = new Date(e.loggedAt);
    const slot = months.find((m) => m.year === d.getFullYear() && m.month === d.getMonth());
    if (slot) slot.total += e.amountCents;
  }
  const maxVal = Math.max(1, ...months.map((m) => m.total));
  const svgH = 60; const svgW = 360;
  const pts = months.map((m, i) => `${(i / 11) * svgW},${svgH - (m.total / maxVal) * svgH}`);
  const area = `M${pts.join("L")}L${svgW},${svgH}L0,${svgH}Z`;

  const sortCol = (col: typeof cs.revenueSortCol, label: string) => html`
    <th class="crm-rev-th" style="cursor:pointer" @click=${() => {
      if (cs.revenueSortCol === col) cs.revenueSortDir = cs.revenueSortDir === "asc" ? "desc" : "asc";
      else { cs.revenueSortCol = col; cs.revenueSortDir = "desc"; }
      state.requestUpdate?.();
    }}>${label}${cs.revenueSortCol === col ? (cs.revenueSortDir === "asc" ? " ↑" : " ↓") : ""}</th>
  `;

  const clientName = (id: string) => {
    const c = cs.clients.find((x) => x.id === id);
    return c ? getClientName(c, null) : id.slice(0, 8) + "…";
  };

  return html`
    <div class="crm-rev-page">
      <div class="crm-rev-header">
        <div>
          <div class="crm-stat-label">TOTAL MRR</div>
          <div class="crm-rev-total">${fmtCurrency(cs.revenueTotalCents)}</div>
        </div>
        <button class="crm-btn crm-btn-sm" style="border-color:var(--g-primary);color:var(--g-primary);"
          @click=${() => { cs.revenueShowLog = true; state.requestUpdate?.(); }}>+ Log Revenue</button>
      </div>
      <div class="crm-rev-chart-wrap">
        <div class="crm-stat-label" style="margin-bottom:6px;">MRR — Last 12 Months</div>
        <svg viewBox="0 0 ${svgW} ${svgH}" preserveAspectRatio="none" style="width:100%;height:80px;display:block;">
          <defs><linearGradient id="rev-g" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="var(--g-primary)" stop-opacity="0.35"/>
            <stop offset="100%" stop-color="var(--g-primary)" stop-opacity="0.02"/>
          </linearGradient></defs>
          <path d="${area}" fill="url(#rev-g)"/>
          <polyline points="${pts.join(" ")}" fill="none" stroke="var(--g-primary)" stroke-width="2"/>
        </svg>
        <div style="display:flex;justify-content:space-between;margin-top:2px;">
          ${months.filter((_,i) => i%2===0).map((m) => html`<span class="crm-stat-label">${m.label}</span>`)}
        </div>
      </div>
      ${cs.revenueLoading ? html`<div class="crm-loading"><span class="crm-loading-dot">◆</span> Loading…</div>` : html`
        <table class="crm-rev-table">
          <thead><tr>${sortCol("client","Client")}${sortCol("amount","Amount")}${sortCol("date","Date")}<th class="crm-rev-th">Note</th></tr></thead>
          <tbody>
            ${entries.length === 0 ? html`<tr><td colspan="4" style="padding:20px;text-align:center;color:rgba(255,255,255,0.4);">No revenue logged yet.</td></tr>`
              : entries.map((e) => html`
                <tr class="crm-rev-row">
                  <td class="crm-rev-td">${clientName(e.clientId)}</td>
                  <td class="crm-rev-td" style="color:var(--g-primary);font-weight:600;">${fmtCurrency(e.amountCents)}</td>
                  <td class="crm-rev-td">${new Date(e.loggedAt).toLocaleDateString()}</td>
                  <td class="crm-rev-td" style="color:rgba(255,255,255,0.6);">${e.note ?? "—"}</td>
                </tr>`)}
          </tbody>
        </table>
      `}
      ${cs.revenueShowLog ? html`
        <div style="position:fixed;inset:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:9999;"
          @click=${(e: Event) => { if (e.target === e.currentTarget) { cs.revenueShowLog=false; state.requestUpdate?.(); } }}>
          <div style="background:#111;border:1px solid var(--g-primary);border-radius:12px;padding:24px;width:340px;display:flex;flex-direction:column;gap:10px;">
            <div style="font:600 14px Inter;color:#fff;margin-bottom:4px;">Log Revenue</div>
            <label class="crm-page-prop-label">Client</label>
            <select class="crm-page-prop-select" .value=${cs.revenueLogClientId}
              @change=${(e: Event) => { cs.revenueLogClientId=(e.target as HTMLSelectElement).value; state.requestUpdate?.(); }}>
              <option value="">— Select client —</option>
              ${cs.clients.map((c) => html`<option value="${c.id}">${getClientName(c,null)}</option>`)}
            </select>
            <label class="crm-page-prop-label">Amount ($)</label>
            <input class="crm-page-prop-input" type="number" min="0" step="0.01" placeholder="0.00"
              .value=${cs.revenueLogAmount}
              @input=${(e: Event) => { cs.revenueLogAmount=(e.target as HTMLInputElement).value; state.requestUpdate?.(); }}/>
            <label class="crm-page-prop-label">Note</label>
            <input class="crm-page-prop-input" type="text" placeholder="Optional"
              .value=${cs.revenueLogNote}
              @input=${(e: Event) => { cs.revenueLogNote=(e.target as HTMLInputElement).value; state.requestUpdate?.(); }}/>
            <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:6px;">
              <button class="crm-btn crm-btn-sm" @click=${() => { cs.revenueShowLog=false; state.requestUpdate?.(); }}>Cancel</button>
              <button class="crm-btn crm-btn-sm" style="border-color:var(--g-primary);color:var(--g-primary);"
                ?disabled=${cs.revenueLogSaving||!cs.revenueLogClientId||!cs.revenueLogAmount}
                @click=${() => void logPageRevenue(state,client)}>
                ${cs.revenueLogSaving ? "Saving…" : "Log Revenue"}
              </button>
            </div>
          </div>
        </div>
      ` : nothing}
    </div>
  `;
}

// ── Pipeline Page ─────────────────────────────────────────────

function renderPipelinePage(state: AppViewState, cs: ClientsState, gwClient: GatewayBrowserClient) {
  const groups = new Map<string, typeof cs.clients>();
  for (const c of cs.clients) {
    const status = ((c.data?.Status ?? c.data?.status ?? "Unknown") as string);
    if (!groups.has(status)) groups.set(status, []);
    groups.get(status)!.push(c);
  }
  if (groups.size === 0) return html`<div class="crm-page-activity-empty">No clients yet.</div>`;
  return html`
    <div style="padding:16px;overflow-x:auto;">
      <div style="display:flex;gap:12px;min-width:max-content;">
        ${[...groups.entries()].map(([status, clients]) => html`
          <div style="width:220px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:10px;padding:10px;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
              <span style="font:600 11px Inter;color:rgba(255,255,255,0.8);text-transform:uppercase;">${status}</span>
              <span style="font:500 10px Inter;color:rgba(255,255,255,0.4);">${clients.length}</span>
            </div>
            ${clients.map((c) => html`
              <div style="background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);border-radius:6px;padding:8px;margin-bottom:6px;cursor:pointer;"
                @click=${() => { openClientDetail(state, gwClient, c); }}>
                <div style="font:600 12px Inter;color:#fff;">${getClientName(c,null)}</div>
                <div style="font:400 10px Inter;color:rgba(255,255,255,0.5);margin-top:2px;">${c.data?.Email??c.data?.email??""}</div>
              </div>
            `)}
          </div>
        `)}
      </div>
    </div>
  `;
}

// ── Activity Page ─────────────────────────────────────────────

function renderActivityPage(state: AppViewState, cs: ClientsState, _gwClient: GatewayBrowserClient) {
  return html`
    <div class="crm-page-activity-empty">
      <p style="margin-bottom:12px;">Select a client and open the Activity tab to log and view interactions.</p>
      <button class="crm-btn crm-btn-sm" @click=${() => { cs.pageTab="clients"; state.requestUpdate?.(); }}>← Back to Clients</button>
    </div>
  `;
}

// ── Group-by switcher ────────────────────────────────────────

/** Per-type glyph so the menu reads at a glance without spelling out types. */
function groupByGlyph(type: string): string {
  if (type === "status") return "◉";
  if (type === "select") return "◈";
  return "◆";
}

const CHEVRON_SVG = html`<svg class="crm-groupby-chevron" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"
  aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>`;

const CHECK_SVG = html`<svg class="crm-groupby-check" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"
  aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>`;

/**
 * "Group by: [Status ▾]" — one tap to change the axis the board is sliced on.
 *
 * A native <select> can't carry the type glyph, option counts or the active
 * check, so this is a popover. It closes on select, on Escape, and on the next
 * pointerdown anywhere else (listener attached only while open).
 */
function renderGroupBySwitcher(state: AppViewState, cs: ClientsState) {
  const groupable = getGroupableProperties(cs.schema);
  const active = resolveGroupBy(cs);
  const isNone = active === CLIENTS_GROUP_BY_NONE;

  // Nothing to group on: say so kindly instead of leaving a dead control.
  // (The board itself renders the same guidance in full.)
  if (groupable.length === 0) {
    return html`
      <span class="crm-groupby-label" title="This client list has no status, select or tag property to group by yet.">
        No groupable fields
      </span>
    `;
  }

  const close = (): void => {
    if (!cs.groupByMenuOpen) return;
    cs.groupByMenuOpen = false;
    state.requestUpdate?.();
  };

  const choose = (value: string): void => {
    setClientsGroupBy(cs, value);
    // A different axis means different columns; per-column render windows
    // from the old grouping would otherwise cap the new ones.
    cs.kanbanColWindow = {};
    cs.groupByMenuOpen = false;
    state.requestUpdate?.();
  };

  const toggle = (e: Event): void => {
    e.stopPropagation();
    cs.groupByMenuOpen = !cs.groupByMenuOpen;
    state.requestUpdate?.();
    if (!cs.groupByMenuOpen) return;
    // Attached after this click so it doesn't immediately swallow it.
    const onAway = (): void => {
      document.removeEventListener("pointerdown", onAway, true);
      document.removeEventListener("keydown", onKey, true);
      close();
    };
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key !== "Escape") return;
      document.removeEventListener("pointerdown", onAway, true);
      document.removeEventListener("keydown", onKey, true);
      close();
    };
    setTimeout(() => {
      document.addEventListener("pointerdown", onAway, true);
      document.addEventListener("keydown", onKey, true);
    }, 0);
  };

  const activeLabel = isNone ? "None" : active || "None";

  return html`
    <div class="crm-groupby" @pointerdown=${(e: Event) => e.stopPropagation()}>
      <button
        class="crm-groupby-trigger ${cs.groupByMenuOpen ? "is-open" : ""}"
        aria-haspopup="listbox"
        aria-expanded=${cs.groupByMenuOpen ? "true" : "false"}
        title="Choose which property the board groups by"
        @click=${toggle}
      >
        <span class="crm-groupby-label">Group by</span>
        <span class="crm-groupby-value">${activeLabel}</span>
        ${CHEVRON_SVG}
      </button>
      ${cs.groupByMenuOpen
        ? html`
            <div class="crm-groupby-menu" role="listbox" aria-label="Group clients by">
              ${groupable.map((p) => {
                const count = p.options?.length ?? 0;
                const selected = !isNone && active === p.name;
                return html`
                  <button
                    class="crm-groupby-item ${selected ? "is-active" : ""}"
                    role="option"
                    aria-selected=${selected ? "true" : "false"}
                    @click=${() => choose(p.name)}
                  >
                    <span class="crm-groupby-glyph">${groupByGlyph(p.type)}</span>
                    <span class="crm-groupby-name">${p.name}</span>
                    <span class="crm-groupby-meta">${count === 1 ? "1 value" : `${count} values`}</span>
                    ${selected ? CHECK_SVG : nothing}
                  </button>
                `;
              })}
              <div class="crm-groupby-divider"></div>
              <button
                class="crm-groupby-item ${isNone ? "is-active" : ""}"
                role="option"
                aria-selected=${isNone ? "true" : "false"}
                @click=${() => choose(CLIENTS_GROUP_BY_NONE)}
              >
                <span class="crm-groupby-glyph">≡</span>
                <span class="crm-groupby-name">None</span>
                <span class="crm-groupby-meta">flat list</span>
                ${isNone ? CHECK_SVG : nothing}
              </button>
            </div>
          `
        : nothing}
    </div>
  `;
}

// ── Top Bar ──────────────────────────────────────────────────

function renderTopBar(state: AppViewState, cs: ClientsState, client: GatewayBrowserClient) {
  const bizName = state.businessState?.businesses.find(
    (b) => b.id === state.businessState?.activeBusinessId
  )?.name || "Business";
  // The full set is loaded in memory, so `clients.length` IS the real total;
  // `totalClients` (from the server's pagination.total) is the cross-check.
  const total = cs.totalClients || cs.clients.length;
  const shown = getFilteredClients(cs).length;
  const filteredDown = shown < total;
  // The value filter follows the board's axis, but "None" has no options of
  // its own — fall back to the first groupable property so the filter never
  // collapses to an empty dropdown.
  const activeGroupBy = resolveGroupBy(cs);
  const filterProp =
    activeGroupBy && activeGroupBy !== CLIENTS_GROUP_BY_NONE
      ? activeGroupBy
      : (getGroupableProperties(cs.schema)[0]?.name ?? "");

  return html`
    <div class="crm-topbar">
      <div class="crm-topbar-left">
        <span class="crm-badge">${bizName}</span>
        <span class="crm-count" title="${filteredDown ? `${fmtCount(shown)} of ${fmtCount(total)} clients match the current search/filter` : `${fmtCount(total)} clients loaded`}">
          ${filteredDown
            ? html`${fmtCount(shown)} of ${fmtCount(total)} clients`
            : html`${fmtCount(total)} client${total !== 1 ? "s" : ""}`}
        </span>
        <div class="crm-view-toggle" data-learn-id="clients-view-toggle">
          <button class="crm-view-btn ${cs.viewMode === "grid" ? "active" : ""}" @click=${() => { cs.viewMode = "grid"; state.requestUpdate?.(); }}>⊞ Grid</button>
          <button class="crm-view-btn ${cs.viewMode === "table" ? "active" : ""}" @click=${() => { cs.viewMode = "table"; state.requestUpdate?.(); }}>☰ Table</button>
          <button class="crm-view-btn ${cs.viewMode === "kanban" ? "active" : ""}" @click=${() => { cs.viewMode = "kanban"; state.requestUpdate?.(); }}>⫏ Kanban</button>
        </div>
        ${cs.viewMode === "kanban" ? renderGroupBySwitcher(state, cs) : nothing}
      </div>
      <div class="crm-topbar-right">
        <input class="crm-search" data-learn-id="clients-search" type="text" placeholder="Search clients..."
          .value=${cs.searchQuery}
          @input=${(e: Event) => { cs.searchQuery = (e.target as HTMLInputElement).value; state.requestUpdate?.(); }} />
        ${cs.schema && filterProp ? html`
          <select class="crm-select" title="Filter by ${filterProp}" @change=${(e: Event) => { cs.filterStatus = (e.target as HTMLSelectElement).value; state.requestUpdate?.(); }}>
            <option value="">All</option>
            ${getGroupOptions(cs.schema, filterProp).map((o) => html`
              <option value="${o.name}" ?selected=${cs.filterStatus === o.name}>${o.name}</option>
            `)}
          </select>
        ` : nothing}
        <button class="crm-btn crm-btn-sm" @click=${() => { cs.formData = {}; cs.showCreateDialog = true; state.requestUpdate?.(); }}>+ ADD</button>
        <button
          class="crm-btn crm-btn-sm"
          @click=${() => {
            cs.showImportDialog = true;
            cs.importLastResult = null;
            cs.importDataText = "";
            state.requestUpdate?.();
          }}
          title="Import clients from a CSV / JSON / vCard file"
        >↥ Import</button>
        ${renderNotionPullButton({
          client,
          pullState: _clientsPullState,
          role: "clients",
          onSuccess: () => loadClients(state, client).then(() => state.requestUpdate?.()),
          requestUpdate: () => state.requestUpdate?.(),
          label: "Pull",
        })}
        <button class="crm-btn crm-btn-sm" @click=${() => loadClients(state, client)}>↻</button>
        <button
          class="crm-btn crm-btn-sm crm-btn-notion"
          @click=${() => requestChangeNotionDb("clients", cs.notionDbId ?? null)}
          title="Swap which Notion database drives Clients (with overlap analysis + relation reassign)"
        >
          ⇄ Change DB
        </button>
      </div>
    </div>
  `;
}

// ── Notion Bar ───────────────────────────────────────────────

function renderBusinessSwitcher(state: AppViewState, client: GatewayBrowserClient) {
  const bs = state.businessState;
  if (!bs) return nothing;
  const active = activeBusinessProfile(bs);
  const businesses = bs.businesses ?? [];
  const onChange = (e: Event) => {
    const value = (e.target as HTMLSelectElement).value;
    if (!value || value === bs.activeBusinessId) return;
    void switchBusiness(state, client, value).then(() => {
      // Reload clients with the new business scope so the CRM bar + grid
      // refresh against that business's database.
      void loadClients(state, client);
    });
  };
  return html`
    <span style="color:#52525b;">|</span>
    <span style="color:#a78bfa;font-size:9px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;">CRM for</span>
    ${businesses.length > 1
      ? html`
          <select
            class="crm-business-select"
            .value=${bs.activeBusinessId ?? ""}
            @change=${onChange}
            style="padding:3px 8px;background:rgba(167,139,250,0.06);border:1px solid rgba(167,139,250,0.22);border-radius:4px;color:#ddd;font-family:inherit;font-size:10px;font-weight:600;outline:none;cursor:pointer;"
            title="Switch the active business — each business can connect a different Notion CRM database."
          >
            ${businesses.map(
              (b) => html`<option value=${b.id} ?selected=${b.id === bs.activeBusinessId}>${b.name || "Untitled"}</option>`,
            )}
          </select>
        `
      : html`<span style="color:#a78bfa;font-size:11px;font-weight:700;">${active?.name ?? "—"}</span>`}
  `;
}

function renderNotionBar(state: AppViewState, cs: ClientsState, client: GatewayBrowserClient) {
  const connected = !!cs.notionDbId;
  const lastSync = cs.notionLastSync ? new Date(cs.notionLastSync).toLocaleString() : "never";
  const urlValid = cs.notionDbUrl ? !!parseNotionDatabaseUrl(cs.notionDbUrl) : false;
  const schemaCount = cs.schema ? Object.keys(cs.schema.properties).length : 0;
  const bs = state.businessState;
  const active = activeBusinessProfile(bs);
  // Only ever the *Notion* database name — and only when the server confirmed
  // a live Notion connection. The database the list actually comes from is
  // `cs.clientsDbName`, rendered separately below.
  const dbName = connected ? (active?.crmDatabaseName ?? null) : null;
  const boundDbName = cs.clientsDbName;
  const boundDbRows = cs.clientsDbRowCount;

  return html`
    <div class="crm-notion-bar" style="flex-direction:column;align-items:stretch;gap:6px;">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <span class="crm-notion-dot ${connected ? "connected" : "disconnected"}"></span>
        <span>Notion CRM: ${connected ? "Connected" : "Not connected"}</span>
        ${renderBusinessSwitcher(state, client)}
        ${boundDbName
          ? html`
              <span style="color:#52525b;">|</span>
              <span
                style="color:#a78bfa;font-size:9px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;"
                title="The database this business's clients role is bound to — the source of the list below."
              >Source</span>
              <span style="color:#c4b5fd;font-size:10px;font-weight:700;">${boundDbName}</span>
              ${boundDbRows !== null
                ? html`<span style="color:#71717a;font-size:9px;">(${boundDbRows} rows)</span>`
                : nothing}
            `
          : nothing}
        ${connected && dbName
          ? html`<span style="color:#52525b;">|</span><span style="color:#c4b5fd;font-size:10px;font-style:italic;">${dbName}</span>`
          : nothing}
        ${connected ? html`
          <span style="color:#52525b;">|</span>
          <span>Schema: ${schemaCount} properties</span>
          <span style="color:#52525b;">|</span>
          <span>Last sync: ${lastSync}</span>
          <span style="color:#52525b;">|</span>
          <span class="mono" style="color:#a78bfa;font-size:8px;" title="${cs.notionDbId}">${cs.notionDbId?.slice(0, 8)}…</span>
          <div style="margin-left:auto;display:flex;gap:4px;">
            <button class="crm-btn crm-btn-sm crm-btn-notion" ?disabled=${cs.notionSyncing}
              @click=${() => syncClientsToNotion(state, client)}>
              ${cs.notionSyncing ? "⟳ SYNCING..." : "⟳ PUSH"}
            </button>
            <button class="crm-btn crm-btn-sm crm-btn-notion" ?disabled=${cs.notionImporting}
              @click=${() => importClientsFromNotion(state, client)}>
              ${cs.notionImporting ? "⟳ IMPORTING..." : "↓ PULL"}
            </button>
            <button class="crm-btn crm-btn-sm" style="color:#71717a;border-color:rgba(255,255,255,0.06);"
              @click=${() => { cs.showNotionConnect = !cs.showNotionConnect; state.requestUpdate?.(); }}>
              ✎ CHANGE DB
            </button>
            <button class="crm-btn crm-btn-sm" style="color:#f87171;border-color:rgba(248,113,113,0.2);"
              title="Disconnect this business from Notion. Local clients are kept; manual ones stay editable."
              @click=${() => {
                if (confirm("Disconnect this business from its Notion CRM database? Local clients will be kept.")) {
                  void disconnectNotionCrmDatabase(state, client);
                }
              }}>
              ⊘ DISCONNECT
            </button>
          </div>
        ` : html`
          <div style="margin-left:auto;display:flex;gap:4px;">
            <button class="crm-btn crm-btn-sm crm-btn-notion"
              @click=${() => { cs.showNotionConnect = !cs.showNotionConnect; state.requestUpdate?.(); }}>
              ⛓ CONNECT EXISTING DB
            </button>
            <button class="crm-btn crm-btn-sm crm-btn-notion" ?disabled=${cs.notionCreatingDb}
              @click=${() => createNotionCrmDatabase(state, client)}>
              ${cs.notionCreatingDb ? "CREATING..." : "✦ CREATE NEW CRM DB"}
            </button>
          </div>
        `}
      </div>

      ${cs.showNotionConnect ? html`
        <div style="display:flex;align-items:center;gap:8px;padding:6px 0 2px;border-top:1px solid rgba(167,139,250,0.06);margin-top:2px;">
          <span style="color:#a78bfa;font-size:9px;white-space:nowrap;">DATABASE URL:</span>
          <input type="text" placeholder="Paste Notion database URL or ID…"
            .value=${cs.notionDbUrl}
            @input=${(e: Event) => { cs.notionDbUrl = (e.target as HTMLInputElement).value; state.requestUpdate?.(); }}
            @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter" && urlValid) connectNotionFromUrl(state, client); }}
            style="flex:1;padding:5px 10px;background:rgba(167,139,250,0.04);border:1px solid ${cs.notionDbUrl ? (urlValid ? "rgba(167,139,250,0.3)" : "rgba(239,68,68,0.3)") : "rgba(255,255,255,0.06)"};border-radius:4px;color:#ddd;font-family:inherit;font-size:10px;outline:none;" />
          <button class="crm-btn crm-btn-sm crm-btn-notion" ?disabled=${!urlValid}
            @click=${() => connectNotionFromUrl(state, client)}>CONNECT</button>
          <button class="crm-btn crm-btn-sm" style="color:#71717a;border-color:rgba(255,255,255,0.06);"
            @click=${() => { cs.showNotionConnect = false; cs.notionDbUrl = ""; state.requestUpdate?.(); }}>✕</button>
          ${cs.notionDbUrl && !urlValid ? html`<span style="color:#f87171;font-size:9px;">Invalid URL/ID</span>` : nothing}
          ${cs.notionDbUrl && urlValid ? html`<span style="color:#a78bfa;font-size:9px;" class="mono">${parseNotionDatabaseUrl(cs.notionDbUrl)?.slice(0, 12)}…</span>` : nothing}
        </div>
      ` : nothing}
      ${cs.notionSyncError ? html`<span style="color:#f87171;font-size:9px;">⚠ ${cs.notionSyncError}</span>` : nothing}
    </div>
  `;
}

// ── Empty State ──────────────────────────────────────────────

function renderEmptyState(state: AppViewState, cs: ClientsState, _client: GatewayBrowserClient) {
  return html`
    <div class="crm-empty">
      <div class="crm-empty-icon">◇</div>
      <div class="crm-empty-text">NO CLIENTS YET</div>
      <div style="font-size:10px;color:#52525b;max-width:300px;">
        ${cs.notionDbId
          ? "Pull clients from your connected Notion database, or add one manually."
          : "Connect a Notion database or add your first client."}
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center;">
        <button class="crm-btn primary" @click=${() => { cs.formData = {}; cs.showCreateDialog = true; state.requestUpdate?.(); }}>+ ADD CLIENT</button>
        <button class="crm-btn" @click=${() => {
          cs.showImportDialog = true;
          cs.importLastResult = null;
          cs.importDataText = "";
          state.requestUpdate?.();
        }}>↥ IMPORT (CSV / JSON / vCard)</button>
        ${cs.notionDbId ? html`
          <button class="crm-btn crm-btn-notion" @click=${() => importClientsFromNotion(state, _client)}>↓ PULL FROM NOTION</button>
        ` : nothing}
      </div>
    </div>
  `;
}

// ── Grid View ────────────────────────────────────────────────

/** Thousands-separated count for the header/stat surfaces. */
function fmtCount(n: number): string {
  return n.toLocaleString();
}

/**
 * Resolve how many rows of `filtered` to actually mount.
 *
 * Grid and table both render heavy surfaces (glass cards / wide rows), so the
 * full set is never painted at once — 1,300 nodes collapses the compositor.
 * The window grows as a sentinel scrolls in, and resets to the base whenever
 * the filter/sort signature changes.
 */
type WindowMode = "grid" | "table";

/**
 * Grid and table keep SEPARATE windows. A window grown by scrolling the grid
 * must not be inherited by the table: a table row is ~12 cells, so 600 rows
 * carried over from the grid drops frames the moment the view is switched.
 */
const WINDOW_CFG = {
  grid: { base: GRID_WINDOW_BASE, step: GRID_WINDOW_STEP, key: "gridWindow", sig: "_gridWindowSig" },
  table: { base: TABLE_WINDOW_BASE, step: TABLE_WINDOW_STEP, key: "tableWindow", sig: "_tableWindowSig" },
} as const;

function resolveRenderWindow(
  cs: ClientsState,
  filteredLength: number,
  mode: WindowMode,
): { size: number; hasMore: boolean; showAll: () => void } {
  const cfg = WINDOW_CFG[mode];
  const anyCs = cs as unknown as Record<string, unknown>;
  const sig = `${cs.searchQuery}|${cs.filterStatus}|${cs.sortBy}|${cs.sortDir}|${filteredLength}`;
  if (anyCs[cfg.sig] !== sig) {
    anyCs[cfg.sig] = sig;
    anyCs[cfg.key] = cfg.base;
  }
  const size = Math.min((anyCs[cfg.key] as number) || cfg.base, filteredLength);
  return {
    size,
    hasMore: size < filteredLength,
    showAll: () => { anyCs[cfg.key] = filteredLength; },
  };
}

/**
 * Attach a one-shot IntersectionObserver to a sentinel node that grows the
 * render window. Scoped to the `.crm-main` scroll container so it fires
 * correctly inside the shadow-DOM overflow region.
 */
function attachWindowSentinel(state: AppViewState, cs: ClientsState, mode: WindowMode) {
  const cfg = WINDOW_CFG[mode];
  return (el?: Element) => {
    if (!el) return;
    const anyEl = el as any;
    if (anyEl.__io) return; // Lit reuses this node across renders — observe once.
    const root = el.closest(".crm-main");
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        const total = getFilteredClients(cs).length;
        const anyCs = cs as unknown as Record<string, unknown>;
        if (((anyCs[cfg.key] as number) || cfg.base) >= total) return;
        anyCs[cfg.key] = Math.min(((anyCs[cfg.key] as number) || cfg.base) + cfg.step, total);
        state.requestUpdate?.();
      },
      { root: root ?? null, rootMargin: "400px 0px" },
    );
    io.observe(el);
    anyEl.__io = io;
  };
}

function renderGridView(state: AppViewState, cs: ClientsState, client: GatewayBrowserClient) {
  const filtered = getFilteredClients(cs);
  if (filtered.length === 0) return html`<div class="crm-empty"><div class="crm-empty-text" style="font-size:10px;">No clients match filters</div></div>`;

  const { size: windowSize, hasMore, showAll } = resolveRenderWindow(cs, filtered.length, "grid");
  const visible = filtered.slice(0, windowSize);
  const attachSentinel = attachWindowSentinel(state, cs, "grid");

  // One batch call resolves every card thumbnail for the grid.
  if (filtered.length) ensureCovers(state, client, "client", filtered.map((c) => c.id));

  return html`<div class="crm-grid">
    <div class="crm-card" style="border:1px dashed color-mix(in srgb, var(--g-primary) 15%, transparent);display:flex;align-items:center;justify-content:center;min-height:120px;cursor:pointer;opacity:0.6;transition:all 0.2s;"
      @click=${() => { cs.formData = {}; cs.showCreateDialog = true; state.requestUpdate?.(); }}
      @mouseenter=${(e: Event) => (e.target as HTMLElement).style.opacity = "1"}
      @mouseleave=${(e: Event) => (e.target as HTMLElement).style.opacity = "0.6"}>
      <div style="text-align:center;color:var(--g-primary);">
        <div style="font-size:24px;margin-bottom:6px;">+</div>
        <div style="font-size:9px;text-transform:uppercase;letter-spacing:0.15em;">New Client</div>
      </div>
    </div>
    ${visible.map((c) => renderClientCard(state, cs, client, c))}
    ${hasMore
      ? html`<div class="crm-grid-sentinel" ${ref(attachSentinel)}
          style="grid-column:1/-1;display:flex;align-items:center;justify-content:center;gap:10px;padding:16px;color:var(--g-primary);opacity:0.7;font-size:10px;text-transform:uppercase;letter-spacing:0.14em;">
          <span class="crm-grid-spinner"></span>
          Loading ${fmtCount(filtered.length - windowSize)} more…
          <button class="crm-btn crm-btn-sm" style="margin-left:8px;"
            @click=${() => { showAll(); state.requestUpdate?.(); }}>Show all ${fmtCount(filtered.length)}</button>
        </div>`
      : html`<div class="crm-grid-footer" style="grid-column:1/-1;text-align:center;padding:12px 0 4px;color:rgba(255,255,255,0.32);font-size:9px;text-transform:uppercase;letter-spacing:0.14em;">
          ${fmtCount(filtered.length)} client${filtered.length === 1 ? "" : "s"}
        </div>`}
  </div>`;
}

function renderClientCard(state: AppViewState, cs: ClientsState, client: GatewayBrowserClient, c: DynamicClientRecord) {
  const name = getClientName(c, cs.schema);
  const fallbackColor = hashColor(name);
  const selected = cs.detailClient?.id === c.id && cs.showDetailPanel;

  // Customization
  const customAccent = getCardAccent(c, "");
  const cardStyle = getCardStyle(c);
  const iconUrl = getCardIcon(c);
  const avatarStyle = iconUrl
    ? `background-image:url('${iconUrl}')`
    : `background:${customAccent || fallbackColor}`;
  const cardStyleVar = customAccent ? `--card-accent-override:${customAccent};` : "";

  // Find first status/select for badge
  const statusEntry = getFirstValue(c, cs.schema, "status") || getFirstValue(c, cs.schema, "select");
  // Company (rich_text named "Company")
  const company = c.data["Company"] || null;
  // Email & phone
  const email = getFirstValue(c, cs.schema, "email");
  const phone = getFirstValue(c, cs.schema, "phone_number");
  // Multi-select tags
  const multiSelects: string[] = [];
  if (cs.schema) {
    for (const [pname, prop] of Object.entries(cs.schema.properties)) {
      if (prop.type === "multi_select" && Array.isArray(c.data[pname])) {
        multiSelects.push(...c.data[pname].slice(0, 3));
        if (multiSelects.length >= 3) break;
      }
    }
  }

  return html`
    <div
      class="crm-card ${selected ? "selected" : ""}"
      data-card-color=${customAccent ? "" : null as any}
      data-card-style=${cardStyle !== "default" ? cardStyle : null as any}
      style=${cardStyleVar}
      @click=${() => { openClientDetail(state, client, c); }}
      @contextmenu=${(e: MouseEvent) => openCardMenu(state, e, c.id)}
    >
      <!-- Cover thumbnail (full-bleed out of the card padding) -->
      <div style="margin:-18px -18px 12px; position:relative; z-index:1;">
        ${renderCoverThumb(state, client, "client", c.id, {
          height: 88,
          seed: c.id || name,
          monogram: initials(name),
          radius: "16px 16px 0 0",
        })}
      </div>
      <div class="crm-card-actions">
        <button class="crm-card-action"
          title="Customize (right-click)"
          @click=${(e: MouseEvent) => { e.stopPropagation(); openCardMenu(state, e, c.id); }}
        >◐</button>
        <button class="crm-card-action" @click=${(e: Event) => { e.stopPropagation(); openEditDialog(state, cs, c); }}>✎</button>
        <button class="crm-card-action danger" @click=${(e: Event) => { e.stopPropagation(); cs.showDeleteConfirm = c.id; state.requestUpdate?.(); }}>✕</button>
      </div>
      <div class="crm-card-header">
        <div class="crm-avatar ${iconUrl ? "has-image" : ""}" style=${avatarStyle}>${iconUrl ? "" : initials(name)}</div>
        <div class="crm-card-info">
          <div class="crm-card-name">${name}</div>
          ${company ? html`<div class="crm-card-company">${company}</div>` : nothing}
        </div>
      </div>
      ${renderSocialIcons(c)}
      <div class="crm-card-details">
        ${email ? html`<div class="crm-card-detail"><span class="crm-card-detail-icon">✉</span><span class="crm-card-detail-value">${email.value}</span></div>` : nothing}
        ${phone ? html`<div class="crm-card-detail"><span class="crm-card-detail-icon">☏</span><span class="crm-card-detail-value">${phone.value}</span></div>` : nothing}
      </div>
      <div class="crm-card-footer">
        ${statusEntry ? html`
          <span class="crm-status-badge" style="color:${notionColor(getOptionColor(cs.schema, statusEntry.name, statusEntry.value))};background:${notionBg(getOptionColor(cs.schema, statusEntry.name, statusEntry.value))};">
            ${statusEntry.value}
          </span>
        ` : nothing}
        ${renderCampaignChip(c, cs)}
        ${multiSelects.length > 0 ? html`<div class="crm-tags">${multiSelects.slice(0, 3).map((t) => html`<span class="crm-tag">${t}</span>`)}</div>` : nothing}
        <span class="crm-card-time">${timeAgo(c.updated_at)}</span>
      </div>
    </div>
  `;
}

// ── Table View ───────────────────────────────────────────────

function renderTableView(state: AppViewState, cs: ClientsState, client: GatewayBrowserClient) {
  const filtered = getFilteredClients(cs);
  if (filtered.length === 0) return html`<div class="crm-empty"><div class="crm-empty-text" style="font-size:10px;">No clients match filters</div></div>`;

  // Build columns from schema
  const columns: { name: string; prop: NotionPropertySchema }[] = [];
  if (cs.schema) {
    // Title first
    for (const [name, prop] of Object.entries(cs.schema.properties)) {
      if (prop.type === "title") columns.push({ name, prop });
    }
    // Then others (skip files, created_time)
    const skipTypes = new Set(["title", "files"]);
    for (const [name, prop] of Object.entries(cs.schema.properties)) {
      if (!skipTypes.has(prop.type)) columns.push({ name, prop });
    }
  }
  // Limit columns to prevent overflow
  const visibleCols = columns.slice(0, 10);

  // Same incremental window as the grid: 1,300 rows x ~12 cells is ~16k DOM
  // nodes, which stalls scrolling. Rows mount in blocks as the sentinel row
  // scrolls into view.
  const { size: windowSize, hasMore, showAll } = resolveRenderWindow(cs, filtered.length, "table");
  const visible = filtered.slice(0, windowSize);
  const attachSentinel = attachWindowSentinel(state, cs, "table");

  const sortIcon = (col: string) => cs.sortBy === col ? (cs.sortDir === "asc" ? " ↑" : " ↓") : "";
  const toggleSort = (col: string) => {
    if (cs.sortBy === col) cs.sortDir = cs.sortDir === "asc" ? "desc" : "asc";
    else { cs.sortBy = col; cs.sortDir = "asc"; }
    state.requestUpdate?.();
  };

  return html`
    <div class="crm-table-wrap">
      <table class="crm-table">
        <thead>
          <tr>
            ${visibleCols.map((col) => html`
              <th class="${cs.sortBy === col.name ? "sorted" : ""}" @click=${() => toggleSort(col.name)}>
                ${col.name}${sortIcon(col.name)}
              </th>
            `)}
            <th>Updated</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${visible.map((c) => {
            const name = getClientName(c, cs.schema);
            const color = hashColor(name);
            return html`
              <tr @click=${() => { openClientDetail(state, client, c); }}>
                ${visibleCols.map((col) => {
                  const val = c.data[col.name];
                  if (col.prop.type === "title") {
                    return html`<td><div class="crm-table-name"><div class="crm-table-avatar" style="background:${color}">${initials(name)}</div><span class="crm-table-name-text">${val || "—"}</span></div></td>`;
                  }
                  if (col.prop.type === "select" || col.prop.type === "status") {
                    if (!val) return html`<td>—</td>`;
                    const optColor = getOptionColor(cs.schema, col.name, val);
                    return html`<td><span class="crm-status-badge" style="color:${notionColor(optColor)};background:${notionBg(optColor)};">${val}</span></td>`;
                  }
                  if (col.prop.type === "multi_select") {
                    if (!Array.isArray(val) || val.length === 0) return html`<td>—</td>`;
                    return html`<td><div class="crm-tags">${val.slice(0, 3).map((t: string) => html`<span class="crm-tag">${t}</span>`)}</div></td>`;
                  }
                  if (col.prop.type === "number") {
                    return html`<td>${val != null ? val : "—"}</td>`;
                  }
                  if (col.prop.type === "date" || col.prop.type === "created_time") {
                    return html`<td style="color:#3f3f46;">${val ? new Date(val).toLocaleDateString() : "—"}</td>`;
                  }
                  if (col.prop.type === "checkbox") {
                    return html`<td>${val ? "✓" : "—"}</td>`;
                  }
                  // Default: string value
                  return html`<td>${val || "—"}</td>`;
                })}
                <td style="color:#3f3f46;">${timeAgo(c.updated_at)}</td>
                <td>
                  <button class="crm-card-action" style="opacity:1;" @click=${(e: Event) => { e.stopPropagation(); openEditDialog(state, cs, c); }}>✎</button>
                </td>
              </tr>
            `;
          })}
          ${hasMore
            ? html`<tr class="crm-table-sentinel" ${ref(attachSentinel)}>
                <td colspan="${visibleCols.length + 2}" style="text-align:center;padding:14px;color:var(--g-primary);opacity:0.7;font-size:10px;text-transform:uppercase;letter-spacing:0.14em;">
                  <span class="crm-grid-spinner"></span>
                  Loading ${fmtCount(filtered.length - windowSize)} more…
                  <button class="crm-btn crm-btn-sm" style="margin-left:8px;"
                    @click=${() => { showAll(); state.requestUpdate?.(); }}>Show all ${fmtCount(filtered.length)}</button>
                </td>
              </tr>`
            : nothing}
          <tr style="cursor:pointer;opacity:0.5;transition:opacity 0.15s;" @click=${() => { cs.formData = {}; cs.showCreateDialog = true; state.requestUpdate?.(); }}
            @mouseenter=${(e: Event) => ((e.currentTarget as HTMLElement).style.opacity = "1")}
            @mouseleave=${(e: Event) => ((e.currentTarget as HTMLElement).style.opacity = "0.5")}>
            <td colspan="${visibleCols.length + 2}" style="text-align:center;padding:10px;color:var(--g-primary);font-size:10px;text-transform:uppercase;letter-spacing:0.1em;border:1px dashed color-mix(in srgb, var(--g-primary) 12%, transparent);">+ New Client</td>
          </tr>
        </tbody>
      </table>
    </div>
  `;
}

// ── Kanban View ──────────────────────────────────────────────

function renderKanbanView(state: AppViewState, cs: ClientsState, client: GatewayBrowserClient) {
  const groupProp = resolveGroupBy(cs);
  const isUngrouped = groupProp === CLIENTS_GROUP_BY_NONE;

  // No status/select/tag property anywhere in the schema. This is a state to
  // explain, not an error to report — the fix is on the bound database, and
  // the other two views still work.
  if (!groupProp && getGroupableProperties(cs.schema).length === 0) {
    return html`
      <div class="crm-empty">
        <div class="crm-empty-text" style="font-size:11px;line-height:1.7;max-width:420px;">
          <strong style="color:var(--g-primary);">Nothing to group by yet.</strong><br />
          A board needs a status, select or tag property. Add one to this
          client list's database — or switch to Grid or Table in the meantime.
        </div>
      </div>
    `;
  }

  const byGroup = getClientsByGroup(cs);
  const options = isUngrouped ? [] : getGroupOptions(cs.schema, groupProp);

  // Build column order from options, then any value the rows use that the
  // schema never declared, plus "—" for uncategorized.
  const columnOrder = isUngrouped ? [CLIENTS_UNGROUPED_COLUMN] : options.map((o) => o.name);
  if (!isUngrouped) {
    const declared = new Set(columnOrder);
    for (const name of Object.keys(byGroup)) {
      if (name === "—" || declared.has(name)) continue;
      columnOrder.push(name);
    }
    if (byGroup["—"]?.length) columnOrder.push("—");
  }

  // Temperature axis — only renders the filter strip + card chips when
  // the schema has a Temperature property (post-seed). Pre-seed users
  // still see the kanban exactly as before.
  const tempProp = getTemperaturePropertyName(cs.schema);
  const tempFilter = cs.kanbanTempFilter || "";
  const filterByTemp = (c: DynamicClientRecord): boolean => {
    if (!tempFilter || !tempProp) return true;
    const bucket = bucketTemperature(c.data?.[tempProp]);
    return bucket === tempFilter;
  };
  const setTemperature = async (clientId: string, value: "cold" | "warm" | "hot"): Promise<void> => {
    if (!tempProp) return;
    const target = cs.clients.find((c) => c.id === clientId);
    if (target?.data) target.data[tempProp] = value.charAt(0).toUpperCase() + value.slice(1);
    state.requestUpdate?.();
    await updateClientProperty(
      state,
      client,
      clientId,
      tempProp,
      value.charAt(0).toUpperCase() + value.slice(1),
    );
  };

  // Drag handlers
  const onDragStart = (e: DragEvent, clientId: string) => {
    if (!e.dataTransfer) return;
    e.dataTransfer.setData("text/plain", clientId);
    e.dataTransfer.effectAllowed = "move";
    cs.kanbanDragClientId = clientId;
    state.requestUpdate?.();
    // Add dragging class after a tick so the visual stays during drag
    requestAnimationFrame(() => {
      const el = (e.target as HTMLElement);
      el.classList.add("dragging");
    });
  };

  const onDragEnd = (_e: DragEvent) => {
    cs.kanbanDragClientId = null;
    cs.kanbanDragOverCol = null;
    state.requestUpdate?.();
  };

  const onDragOver = (e: DragEvent, colName: string) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    if (cs.kanbanDragOverCol !== colName) {
      cs.kanbanDragOverCol = colName;
      state.requestUpdate?.();
    }
  };

  const onDragLeave = (e: DragEvent, colName: string) => {
    // Only clear if actually leaving the column (not entering a child)
    const relTarget = e.relatedTarget as HTMLElement | null;
    const colEl = (e.currentTarget as HTMLElement);
    if (relTarget && colEl.contains(relTarget)) return;
    if (cs.kanbanDragOverCol === colName) {
      cs.kanbanDragOverCol = null;
      state.requestUpdate?.();
    }
  };

  const onDrop = async (e: DragEvent, targetCol: string) => {
    e.preventDefault();
    const clientId = e.dataTransfer?.getData("text/plain");
    cs.kanbanDragClientId = null;
    cs.kanbanDragOverCol = null;
    state.requestUpdate?.();

    if (!clientId || targetCol === "—") return;
    // No axis to write (None), or a tag-style axis where a drop would clobber
    // the whole array — leave the data alone.
    if (isUngrouped || isMultiValueType(cs.schema?.properties?.[groupProp]?.type)) return;

    // Find the client and check if it's already in this column
    const c = cs.clients.find((cl) => cl.id === clientId);
    if (!c) return;
    const currentVal = c.data?.[groupProp];
    if (currentVal === targetCol) return;

    // Optimistic update
    if (c.data) c.data[groupProp] = targetCol;
    state.requestUpdate?.();

    // Persist + Notion sync
    await updateClientProperty(state, client, clientId, groupProp, targetCol);
  };

  // Build the temperature filter strip + drop-targets. Each pill is also
  // a drop zone: dropping a card onto a pill sets the row's Temperature
  // option. The strip is hidden when the schema doesn't yet expose a
  // temperature property (pre-seed install).
  const tempStrip = tempProp
    ? html`
        <div class="crm-temp-strip" role="tablist" aria-label="Filter by temperature">
          ${(["", "cold", "warm", "hot"] as const).map((id) => {
            const label = id === "" ? "All" : id.charAt(0).toUpperCase() + id.slice(1);
            const isActive = tempFilter === id;
            const onClick = () => {
              cs.kanbanTempFilter = id;
              state.requestUpdate?.();
            };
            const onDropTemp = async (e: DragEvent): Promise<void> => {
              if (id === "") return;
              e.preventDefault();
              const droppedId = e.dataTransfer?.getData("text/plain");
              if (droppedId) await setTemperature(droppedId, id as "cold" | "warm" | "hot");
            };
            return html`
              <button
                class="crm-temp-pill crm-temp-pill--${id || "all"} ${isActive ? "is-active" : ""}"
                role="tab"
                aria-selected=${isActive}
                @click=${onClick}
                @dragover=${(e: DragEvent) => {
                  if (id === "") return;
                  e.preventDefault();
                  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
                }}
                @drop=${onDropTemp}
              >${label}</button>
            `;
          })}
        </div>
      `
    : nothing;

  return html`
    ${tempStrip}
    ${keyed(groupProp, html`
    <div class="crm-kanban">
      ${columnOrder.map((colName) => {
        const clients = (byGroup[colName] ?? []).filter(filterByTemp);
        // Cap the mounted cards per column — a busy stage can hold hundreds.
        const colWindow = Math.min(
          cs.kanbanColWindow[colName] || KANBAN_COL_WINDOW_BASE,
          clients.length,
        );
        const colVisible = clients.slice(0, colWindow);
        const colHasMore = colWindow < clients.length;
        const opt = options.find((o) => o.name === colName);
        const colColor = opt ? notionColor(opt.color) : "#6b7280";
        const isDragOver = cs.kanbanDragOverCol === colName;

        return html`
          <div class="crm-kanban-col ${isDragOver ? "drag-over" : ""}"
            @dragover=${(e: DragEvent) => onDragOver(e, colName)}
            @dragleave=${(e: DragEvent) => onDragLeave(e, colName)}
            @drop=${(e: DragEvent) => onDrop(e, colName)}>
            <div class="crm-kanban-header" style="color:${colColor};border-left:2px solid ${colColor};">
              ${colName}
              <span class="crm-kanban-count">${fmtCount(clients.length)}</span>
            </div>
            <div class="crm-kanban-cards">
              ${colName !== "—" && !isUngrouped && !isMultiValueType(cs.schema?.properties?.[groupProp]?.type) ? html`
                <div class="crm-kanban-card" style="border:1px dashed color-mix(in srgb, var(--g-primary) 12%, transparent);cursor:pointer;opacity:0.5;transition:opacity 0.15s;text-align:center;padding:6px 10px;"
                  @mouseenter=${(e: Event) => ((e.currentTarget as HTMLElement).style.opacity = "1")}
                  @mouseleave=${(e: Event) => ((e.currentTarget as HTMLElement).style.opacity = "0.5")}
                  @click=${(e: Event) => { e.stopPropagation(); cs.formData = { [groupProp]: colName }; cs.showCreateDialog = true; state.requestUpdate?.(); }}>
                  <span style="color:var(--g-primary);font-size:9px;text-transform:uppercase;letter-spacing:0.1em;">+ New</span>
                </div>
              ` : nothing}
              ${clients.length === 0
                ? html`<div class="crm-kanban-col-empty">No clients</div>`
                : nothing}
              ${colVisible.map((c) => {
                const name = getClientName(c, cs.schema);
                const company = c.data?.["Company"] || null;
                const isDragging = cs.kanbanDragClientId === c.id;
                const tempBucket = tempProp ? bucketTemperature(c.data?.[tempProp]) : null;
                // Get multi-select tags for display
                const tags: string[] = [];
                if (cs.schema) {
                  for (const [pname, prop] of Object.entries(cs.schema.properties)) {
                    if (isMultiValueType(prop.type) && Array.isArray(c.data?.[pname])) {
                      tags.push(...c.data[pname].slice(0, 2));
                      if (tags.length >= 3) break;
                    }
                  }
                }

                const kAccent = getCardAccent(c, "");
                const kStyle = getCardStyle(c);
                const kStyleVar = kAccent ? `--card-accent-override:${kAccent};` : "";
                return html`
                  <div class="crm-kanban-card ${isDragging ? "dragging" : ""}"
                    data-card-color=${kAccent ? "" : null as any}
                    data-card-style=${kStyle !== "default" ? kStyle : null as any}
                    style=${kStyleVar}
                    draggable="true"
                    @dragstart=${(e: DragEvent) => onDragStart(e, c.id)}
                    @dragend=${(e: DragEvent) => onDragEnd(e)}
                    @click=${() => { openClientDetail(state, client, c); }}
                    @contextmenu=${(e: MouseEvent) => openCardMenu(state, e, c.id)}>
                    <div class="crm-kanban-card-name">
                      ${tempBucket
                        ? html`<span class="crm-temp-chip crm-temp-chip--${tempBucket}" title="Temperature: ${tempBucket}"></span>`
                        : nothing}
                      ${name}
                    </div>
                    ${company ? html`<div class="crm-kanban-card-company">${company}</div>` : nothing}
                    ${renderCampaignChip(c, cs)}
                    ${tags.length > 0 ? html`<div class="crm-kanban-card-tags">${tags.slice(0, 3).map((t) => html`<span class="crm-tag">${t}</span>`)}</div>` : nothing}
                  </div>
                `;
              })}
              ${colHasMore
                ? html`<button class="crm-btn crm-btn-sm" style="width:100%;margin-top:4px;"
                    @click=${(e: Event) => {
                      e.stopPropagation();
                      cs.kanbanColWindow = {
                        ...cs.kanbanColWindow,
                        [colName]: colWindow + KANBAN_COL_WINDOW_STEP,
                      };
                      state.requestUpdate?.();
                    }}>Show ${fmtCount(Math.min(KANBAN_COL_WINDOW_STEP, clients.length - colWindow))} more of ${fmtCount(clients.length)}</button>`
                : nothing}
              <div class="crm-kanban-drop-zone">DROP HERE</div>
            </div>
          </div>
        `;
      })}
    </div>
    `)}
  `;
}

// ── Detail Panel (legacy compact panel — kept for reference) ─────────
// The active surface is renderDetailPage further below; renderDetailPanel
// is the back-compat entry point and just forwards there.

function renderDetailPanel(state: AppViewState, cs: ClientsState, client: GatewayBrowserClient) {
  return renderDetailPage(state, cs, client);
}

function renderLegacyDetailPanel(state: AppViewState, cs: ClientsState, client: GatewayBrowserClient) {
  const c = cs.detailClient;
  if (!c) return nothing;
  const name = getClientName(c, cs.schema);
  const color = hashColor(name);
  const company = c.data["Company"] || null;

  // Group properties by type for sections
  const contactProps: [string, NotionPropertySchema][] = [];
  const statusProps: [string, NotionPropertySchema][] = [];
  const detailProps: [string, NotionPropertySchema][] = [];
  const financialProps: [string, NotionPropertySchema][] = [];
  const timelineProps: [string, NotionPropertySchema][] = [];
  const otherProps: [string, NotionPropertySchema][] = [];

  if (cs.schema) {
    for (const [propName, prop] of Object.entries(cs.schema.properties)) {
      if (prop.type === "title") continue; // shown in header
      switch (prop.type) {
        case "email": case "phone_number": case "url":
          contactProps.push([propName, prop]); break;
        case "select": case "status": case "multi_select": case "checkbox":
          statusProps.push([propName, prop]); break;
        case "rich_text":
          detailProps.push([propName, prop]); break;
        case "number":
          financialProps.push([propName, prop]); break;
        case "date": case "created_time":
          timelineProps.push([propName, prop]); break;
        case "files":
          otherProps.push([propName, prop]); break;
        default:
          otherProps.push([propName, prop]); break;
      }
    }
  }

  const renderValue = (propName: string, prop: NotionPropertySchema) => {
    const val = c.data[propName];
    if (val === null || val === undefined || val === "") return html`<span style="color:#3f3f46;">—</span>`;

    switch (prop.type) {
      case "select": case "status": {
        const optColor = getOptionColor(cs.schema, propName, val);
        return html`<span class="crm-status-badge" style="color:${notionColor(optColor)};background:${notionBg(optColor)};">${val}</span>`;
      }
      case "multi_select": {
        if (!Array.isArray(val) || val.length === 0) return html`<span style="color:#3f3f46;">—</span>`;
        return html`<div class="crm-tags" style="justify-content:flex-end;">${val.map((t: string) => {
          const optColor = getOptionColor(cs.schema, propName, t);
          return html`<span class="crm-tag" style="color:${notionColor(optColor)};border-color:${notionColor(optColor)}30;background:${notionBg(optColor)};">${t}</span>`;
        })}</div>`;
      }
      case "url":
        return html`<a href="${val}" target="_blank" style="color:#a78bfa;text-decoration:none;font-size:10px;" title="${val}">${String(val).slice(0, 30)}${String(val).length > 30 ? "…" : ""}</a>`;
      case "email":
        return html`<a href="mailto:${val}" style="color:#a78bfa;text-decoration:none;">${val}</a>`;
      case "phone_number":
        return html`<a href="tel:${val}" style="color:#a78bfa;text-decoration:none;">${val}</a>`;
      case "date": case "created_time":
        return html`<span>${new Date(val).toLocaleDateString()}</span>`;
      case "number":
        return html`<span>${val}</span>`;
      case "checkbox":
        return html`<span>${val ? "✓ Yes" : "✕ No"}</span>`;
      case "files":
        if (!Array.isArray(val) || val.length === 0) return html`<span style="color:#3f3f46;">—</span>`;
        return html`${val.map((f: any) => html`<a href="${f.url}" target="_blank" style="color:#a78bfa;text-decoration:none;font-size:9px;display:block;">${f.name || "File"}</a>`)}`;
      default:
        return html`<span>${String(val).slice(0, 100)}</span>`;
    }
  };

  const renderSection = (title: string, props: [string, NotionPropertySchema][]) => {
    if (props.length === 0) return nothing;
    // Check if any have values
    const hasValues = props.some(([pn]) => {
      const v = c.data[pn];
      return v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0);
    });

    return html`
      <div class="crm-detail-section">
        <div class="crm-detail-section-title">${title}</div>
        ${props.map(([propName, prop]) => {
          const val = c.data[propName];
          // For rich_text with long content, show as notes block
          if (prop.type === "rich_text" && typeof val === "string" && val.length > 60) {
            return html`
              <div style="margin-bottom:8px;">
                <div class="crm-detail-label" style="margin-bottom:4px;">${propName}</div>
                <div class="crm-detail-notes">${val}</div>
              </div>
            `;
          }
          return html`
            <div class="crm-detail-field">
              <span class="crm-detail-label">${propName}</span>
              <span class="crm-detail-value">${renderValue(propName, prop)}</span>
            </div>
          `;
        })}
      </div>
    `;
  };

  return html`
    <div class="crm-detail">
      <div class="crm-detail-header">
        <span class="crm-detail-title">◆ CLIENT DETAILS</span>
        <button class="crm-detail-close" @click=${() => { cs.showDetailPanel = false; cs.detailClient = null; state.requestUpdate?.(); }}>✕</button>
      </div>
      <div class="crm-detail-body">
        <div class="crm-detail-avatar" style="background:${color}">${initials(name)}</div>
        <div class="crm-detail-name">${name}</div>
        ${company ? html`<div class="crm-detail-company">${company}</div>` : nothing}

        ${renderSection("CONTACT", contactProps)}
        ${renderSection("STATUS & CATEGORIES", statusProps)}
        ${renderSection("DETAILS", detailProps)}
        ${renderSection("FINANCIAL", financialProps)}
        ${renderSection("TIMELINE", timelineProps)}
        ${otherProps.length > 0 ? renderSection("OTHER", otherProps) : nothing}

        <div class="crm-detail-section">
          <div class="crm-detail-section-title">SYSTEM</div>
          <div class="crm-detail-field"><span class="crm-detail-label">Created</span><span class="crm-detail-value">${new Date(c.created_at).toLocaleString()}</span></div>
          <div class="crm-detail-field"><span class="crm-detail-label">Updated</span><span class="crm-detail-value">${new Date(c.updated_at).toLocaleString()}</span></div>
          ${c.last_synced ? html`<div class="crm-detail-field"><span class="crm-detail-label">Synced</span><span class="crm-detail-value">${new Date(c.last_synced).toLocaleString()}</span></div>` : nothing}
        </div>

        ${c.notion_page_id ? html`
          <div class="crm-detail-notion"><strong>Notion</strong>: ${c.notion_page_id.slice(0, 12)}...</div>
        ` : nothing}

        <div class="crm-detail-actions">
          <button class="crm-btn crm-btn-sm" @click=${() => openEditDialog(state, cs, c)}>✎ EDIT</button>
          <button
            class="crm-btn crm-btn-sm"
            style="border-color:rgba(110,167,255,0.3); color:#bcd2ff;"
            @click=${() => {
              const email = (c.data?.Email ?? c.data?.email ?? "") as string;
              const nm = (c.data?.Name ?? c.data?.Client ?? c.data?.Title ?? "") as string;
              requestEmailCompose({
                to: email,
                subject: nm ? `Following up — ${nm}` : "Following up",
                businessId: state.businessState?.activeBusinessId ?? undefined,
                contextLabel: nm ? `Client: ${nm}` : "Client",
              });
            }}
          >✉ EMAIL</button>
          <button class="crm-btn crm-btn-sm danger" @click=${() => { cs.showDeleteConfirm = c.id; state.requestUpdate?.(); }}>✕ DELETE</button>
        </div>
      </div>
    </div>
  `;
}

// ── Full Detail Page (glassmorphism, tabbed) ─────────────────

function debounce<T extends (...args: any[]) => void>(fn: T, ms: number): T {
  let timer: any = null;
  return ((...args: any[]) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  }) as T;
}

// Debounced docs autosave map per client id.
// ── Card customization (right-click menu, color + style + icon) ───
// Stored on the client record as data fields prefixed with "_card":
//   _cardColor: hex string (or null to clear)
//   _cardStyle: "default" | "soft" | "vivid" | "mono" | "frosted"
//   _icon:      data URL of the uploaded thumbnail (or null to clear)
// We use `setClientProperty` to persist — same wire format as every other
// editable property, so a Notion-synced CRM also picks them up if the user
// adds matching schema columns.

type CardStyle = "default" | "soft" | "vivid" | "mono" | "frosted";

const CARD_COLOR_PRESETS: { name: string; value: string }[] = [
  { name: "Gold",     value: "#facc15" },
  { name: "Amber",    value: "#f59e0b" },
  { name: "Rose",     value: "#f43f5e" },
  { name: "Magenta",  value: "#d946ef" },
  { name: "Indigo",   value: "#6366f1" },
  { name: "Sky",      value: "#0ea5e9" },
  { name: "Cyan",     value: "#06b6d4" },
  { name: "Emerald",  value: "#10b981" },
  { name: "Lime",     value: "#a3e635" },
  { name: "Slate",    value: "#64748b" },
  { name: "Violet",   value: "#a855f7" },
];

const CARD_STYLE_PRESETS: { id: CardStyle; label: string }[] = [
  { id: "default",  label: "Default" },
  { id: "soft",     label: "Soft" },
  { id: "vivid",    label: "Vivid" },
  { id: "mono",     label: "Mono" },
  { id: "frosted",  label: "Frosted" },
];

// Module-level menu state — single context menu at a time across the page.
let _cardMenu: { clientId: string; x: number; y: number } | null = null;

function openCardMenu(state: AppViewState, ev: MouseEvent, clientId: string): void {
  ev.preventDefault();
  ev.stopPropagation();
  // Clamp to viewport so the menu never spills off-screen.
  const W = 280, H = 360;
  const vw = window.innerWidth || 1024;
  const vh = window.innerHeight || 768;
  const x = Math.min(ev.clientX, vw - W - 12);
  const y = Math.min(ev.clientY, vh - H - 12);
  _cardMenu = { clientId, x: Math.max(8, x), y: Math.max(8, y) };
  state.requestUpdate?.();
}

function closeCardMenu(state: AppViewState): void {
  _cardMenu = null;
  state.requestUpdate?.();
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function handleIconUpload(
  state: AppViewState,
  client: GatewayBrowserClient,
  clientId: string,
  file: File | null,
): Promise<void> {
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    const cs = state.businessState?._clientsState;
    if (cs) {
      cs.error = "Icon must be an image file (PNG / JPEG / WebP / SVG).";
      state.requestUpdate?.();
    }
    return;
  }
  // 2 MB cap — anything larger inflates business.json with little benefit.
  if (file.size > 2 * 1024 * 1024) {
    const cs = state.businessState?._clientsState;
    if (cs) {
      cs.error = "Icon is too large — please pick an image under 2 MB.";
      state.requestUpdate?.();
    }
    return;
  }
  try {
    const dataUrl = await readFileAsDataUrl(file);
    await setClientProperty(state, client, clientId, "_icon", dataUrl);
  } catch (err) {
    const cs = state.businessState?._clientsState;
    if (cs) {
      cs.error = err instanceof Error ? err.message : "Failed to read icon";
      state.requestUpdate?.();
    }
  }
}

function getCardAccent(c: DynamicClientRecord, fallback: string): string {
  const raw = c.data?._cardColor;
  return typeof raw === "string" && /^#?[0-9a-fA-F]{3,8}$/.test(raw.replace("#", ""))
    ? (raw.startsWith("#") ? raw : `#${raw}`)
    : fallback;
}

function getCardStyle(c: DynamicClientRecord): CardStyle {
  const raw = c.data?._cardStyle;
  return CARD_STYLE_PRESETS.some((s) => s.id === raw) ? (raw as CardStyle) : "default";
}

function getCardIcon(c: DynamicClientRecord): string | null {
  const raw = c.data?._icon;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function renderCardContextMenu(
  state: AppViewState,
  cs: ClientsState,
  client: GatewayBrowserClient,
): TemplateResult | typeof nothing {
  if (!_cardMenu) return nothing;
  const c = cs.clients.find((x) => x.id === _cardMenu!.clientId);
  if (!c) return nothing;

  const accent = getCardAccent(c, "");
  const style = getCardStyle(c);
  const icon = getCardIcon(c);
  const name = getClientName(c, cs.schema);

  return html`
    <!-- click-outside scrim -->
    <div
      style="position:fixed;inset:0;z-index:1399;background:transparent;"
      @click=${() => closeCardMenu(state)}
      @contextmenu=${(e: Event) => { e.preventDefault(); closeCardMenu(state); }}
    ></div>
    <div class="crm-cardmenu" style="left:${_cardMenu.x}px; top:${_cardMenu.y}px;"
         @click=${(e: Event) => e.stopPropagation()}
         @contextmenu=${(e: Event) => e.preventDefault()}
    >
      <div class="crm-cardmenu-head">
        <span class="crm-cardmenu-title">Customize</span>
        <button class="crm-cardmenu-close" @click=${() => closeCardMenu(state)} aria-label="Close">×</button>
      </div>

      <div class="crm-cardmenu-section">
        <div class="crm-cardmenu-label">Accent color</div>
        <div class="crm-cardmenu-colors">
          ${CARD_COLOR_PRESETS.map((p) => html`
            <button
              type="button"
              class="crm-cardmenu-swatch ${accent.toLowerCase() === p.value.toLowerCase() ? "is-active" : ""}"
              style="--swatch:${p.value};"
              title="${p.name}"
              aria-label="${p.name}"
              @click=${async () => {
                await setClientProperty(state, client, c.id, "_cardColor", p.value);
              }}
            ></button>
          `)}
          <button
            type="button"
            class="crm-cardmenu-swatch clear ${accent === "" ? "is-active" : ""}"
            title="Clear color"
            aria-label="Clear color"
            @click=${async () => {
              await setClientProperty(state, client, c.id, "_cardColor", null);
            }}
          ></button>
        </div>
      </div>

      <div class="crm-cardmenu-section">
        <div class="crm-cardmenu-label">Style</div>
        <div class="crm-cardmenu-styles">
          ${CARD_STYLE_PRESETS.map((s) => html`
            <button
              type="button"
              class="crm-cardmenu-style ${style === s.id ? "is-active" : ""}"
              @click=${async () => {
                await setClientProperty(state, client, c.id, "_cardStyle", s.id);
              }}
            >${s.label}</button>
          `)}
        </div>
      </div>

      <div class="crm-cardmenu-section">
        <div class="crm-cardmenu-label">Icon / thumbnail</div>
        <div class="crm-cardmenu-icon-row">
          <div
            class="crm-cardmenu-icon-preview"
            style=${icon ? `background-image: url('${icon}');` : ""}
            title=${icon ? "Current icon" : "No icon set"}
          >${icon ? "" : initials(name)}</div>
          <div class="crm-cardmenu-icon-btns">
            <button
              type="button"
              class="crm-cardmenu-icon-btn"
              @click=${(e: Event) => {
                const input = (e.currentTarget as HTMLElement)
                  .parentElement?.parentElement?.querySelector<HTMLInputElement>(".crm-cardmenu-hidden-file");
                input?.click();
              }}
            >${icon ? "Replace" : "Upload"} image</button>
            ${icon ? html`
              <button
                type="button"
                class="crm-cardmenu-icon-btn is-danger"
                @click=${async () => {
                  await setClientProperty(state, client, c.id, "_icon", null);
                }}
              >Remove icon</button>
            ` : nothing}
          </div>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/svg+xml,image/gif"
            class="crm-cardmenu-hidden-file"
            @change=${async (e: Event) => {
              const f = (e.target as HTMLInputElement).files?.[0] ?? null;
              await handleIconUpload(state, client, c.id, f);
              (e.target as HTMLInputElement).value = "";
            }}
          />
        </div>
        <div class="crm-cardmenu-hint">PNG / JPEG / WebP / SVG · up to 2 MB</div>
      </div>
    </div>
  `;
}

const docsAutosaveMap = new Map<string, (state: AppViewState, c: GatewayBrowserClient) => void>();
function getDocsAutosaver(clientId: string) {
  let fn = docsAutosaveMap.get(clientId);
  if (!fn) {
    fn = debounce((state: AppViewState, c: GatewayBrowserClient) => { void saveDocs(state, c); }, 900);
    docsAutosaveMap.set(clientId, fn);
  }
  return fn;
}

/**
 * Replay a `?thread=` deep link into the live navigation stack.
 *
 * A thread URL carries only `type:id` pairs — the labels are whatever the
 * resolver returns, which arrives asynchronously. The nodes are therefore
 * pushed with a placeholder label and relabelled by the connections loader
 * (`threadRelabel`) the moment each object resolves, so a pasted URL never
 * shows a raw id for longer than one round-trip.
 *
 * The refs come from `consumeBootThread()`, which snapshots them at module load
 * — by the time this runs, `threadRoot` has already rewritten the URL to the
 * bare record path, so reading `location` here would find nothing.
 */
function restorePendingThread(state: AppViewState): void {
  for (const ref of consumeBootThread()) {
    threadPush(state, { type: ref.type, id: ref.id, label: ref.id });
  }
}

/**
 * Connections tab — the client's place in the business graph.
 *
 * Sourced from `objrel.connections`, which resolves the typed-edge relation
 * store (src/relations) into named, clickable records: Opportunities, Projects,
 * Tasks, Reports, Financial Commitments, People, Products, Decisions, Risks —
 * plus the Lead / Funnel this client originated from, inferred from the CRM
 * page id stamped by `leads.saveToCRM` when no explicit edge was ever written.
 *
 * Every card threads INTO that object rather than navigating away, which is
 * what makes this a graph the user can walk instead of a list of dead links.
 */
function renderDetailConnections(
  state: AppViewState,
  cs: ClientsState,
  client: GatewayBrowserClient,
) {
  const c = cs.detailClient!;
  return html`
    <div class="crm-page-connections">
      ${renderConnectionsPanel(state, client, "client", c.id, {
        title: "Connections — everything linked to this client",
      })}
      ${renderObjectReports(state, client, "client", c.id, {
        title: "Reports — documents this client",
      })}
      <!-- The raw typed-edge view stays available underneath the resolved
           cards: it is the audit surface (which edge, in which direction),
           and it is what still works if connection resolution is unavailable. -->
      <div class="crm-page-card">
        ${renderRelatedPanel(state, client, "client", c.id, {
          title: "Typed edges (raw graph)",
        })}
      </div>
    </div>
  `;
}

function renderDetailPage(state: AppViewState, cs: ClientsState, client: GatewayBrowserClient) {
  const c = cs.detailClient;
  if (!c) return nothing;
  const name = getClientName(c, cs.schema);
  const color = hashColor(name);
  const company = c.data["Company"] || c.data["company"] || null;
  const email = c.data["Email"] || c.data["email"] || null;

  const titleProp = getTitleProperty(cs.schema);
  const props = cs.schema
    ? Object.entries(cs.schema.properties).filter(([n, p]) => p.type !== "title" && n !== "_docs")
    : [];

  const counts = {
    project: cs.detailRelations.project.length,
    note: cs.detailRelations.note.length,
    workflow: cs.detailRelations.workflow.length,
    campaign: cs.detailRelations.campaign.length,
  };
  const totalRels = counts.project + counts.note + counts.workflow + counts.campaign;
  const hasCampaign = !!getClientCampaignId(c);

  const tabs: { id: ClientsState["detailTab"]; label: string; badge?: number; dot?: boolean }[] = [
    { id: "overview", label: "Overview" },
    { id: "connections", label: "Connections" },
    { id: "properties", label: "Properties", badge: props.length },
    { id: "revenue", label: "Revenue" },
    { id: "campaign", label: "Campaign", dot: hasCampaign },
    { id: "docs", label: "Docs" },
    { id: "relations", label: "Relations", badge: totalRels || undefined },
    { id: "agency", label: "Invoicing & agency", dot: true },
    { id: "activity", label: "Activity" },
    { id: "kanban", label: "Projects" },
  ];

  // The agency ledger is resolved on first open of its tab; opening a record
  // must not fire the agency RPCs for a tab nobody looked at.
  const openAgencyTab = () => {
    setDetailTab(state, client, "agency");
    void loadClientAgencyLink(state, client, name);
  };

  // Closing the record must also release the shared per-client revenue detail,
  // or Agency Operations would open its revenue overlay for whoever was last
  // inspected here.
  const closeDetail = () => {
    resetClientAgencyLink(state);
    closeClientDetail(state);
  };

  // A pasted `?thread=opportunity:<id>` URL restores the whole drill-in path,
  // not just the client at its root. Runs once per opened record: after the
  // first replay the live stack already carries the nodes.
  restorePendingThread(state);

  // Non-null only when the user has threaded PAST this client, in which case
  // the shell renders that object's focus instead of the client's own body.
  const drilled = threadIsDrilled() ? threadTop() : null;

  return html`
    <div class="crm-page-overlay" @click=${(e: Event) => {
      if (e.target === e.currentTarget) closeDetail();
    }}>
      <div class="crm-page-shell">
        <!-- Thread bar. Replaces the old single "back to list" button: the user
             may be several objects deep (Client > Opportunity > Project) and
             needs to see the path AND jump to any point on it, not just unwind
             one step at a time. -->
        <div class="crm-page-bar">
          ${renderThreadBreadcrumb(state, { exitLabel: "Clients", onExit: () => closeDetail() })}
          <div class="crm-page-hero-actions">
            ${email ? html`
              <button class="crm-page-action" @click=${() => {
                requestEmailCompose({
                  to: String(email),
                  subject: name ? `Following up — ${name}` : "Following up",
                  businessId: state.businessState?.activeBusinessId ?? undefined,
                  contextLabel: name ? `Client: ${name}` : "Client",
                });
              }}>✉ Email</button>
            ` : nothing}
            <button class="crm-page-action is-danger"
              @click=${() => { cs.showDeleteConfirm = c.id; state.requestUpdate?.(); }}>Delete</button>
          </div>
        </div>

        ${drilled
          ? html`<div class="crm-page-body">${renderConnectedFocus(state, client, drilled)}</div>`
          : renderClientFocusBody(state, cs, client, c, {
              name,
              color,
              company,
              titleProp,
              tabs,
              openAgencyTab,
            })}
      </div>
    </div>
  `;
}

/**
 * The client's own focus body — cover → identity → tabs → tab content.
 *
 * Split out of `renderDetailPage` because that shell is now shared: when the
 * user threads INTO a connected object the shell keeps its breadcrumb and
 * actions but swaps this whole body for the connected object's focus.
 */
function renderClientFocusBody(
  state: AppViewState,
  cs: ClientsState,
  client: GatewayBrowserClient,
  c: DynamicClientRecord,
  ctx: {
    name: string;
    color: string;
    company: unknown;
    titleProp: string | null;
    tabs: { id: ClientsState["detailTab"]; label: string; badge?: number; dot?: boolean }[];
    openAgencyTab: () => void;
  },
) {
  const { name, color, company, titleProp, tabs, openAgencyTab } = ctx;
  return html`
        <!-- Notion-style cover banner (shared component; see components/object-cover.ts) -->
        ${renderCoverBanner(state, client, "client", c.id, {
          height: 176,
          seed: c.id || name,
          radius: "14px",
        })}

        <div class="crm-page-hero">
          <div class="crm-page-hero-row">
            <div class="crm-page-avatar" style="background:${color}">${initials(name)}</div>
            <div class="crm-page-id-block">
              <span class="crm-page-eyebrow">
                <span class="crm-page-eyebrow-dot"></span>
                Client
              </span>
              <input
                class="crm-page-name-input"
                .value=${name}
                @blur=${(e: Event) => {
                  const next = (e.target as HTMLInputElement).value.trim();
                  if (titleProp && next && next !== name) {
                    void setClientProperty(state, client, c.id, titleProp, next);
                  }
                }}
                @keydown=${(e: KeyboardEvent) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                }}
              />
              <div class="crm-page-sub">
                ${company ? html`<span class="crm-page-sub-pill">${company}</span>` : nothing}
                <span>Updated ${new Date(c.updated_at).toLocaleDateString()}</span>
                ${c.notion_page_id ? html`<span class="crm-page-sub-pill">Notion</span>` : nothing}
              </div>
              <ib-people-chips style="margin-top:8px" .client=${client} objectType="client" objectId=${c.id}></ib-people-chips>
            </div>
          </div>
        </div>

        <div class="crm-page-tabs" role="tablist">
          ${tabs.map((t) => html`
            <button
              role="tab"
              class="crm-page-tab ${cs.detailTab === t.id ? "is-active" : ""}"
              aria-selected=${cs.detailTab === t.id ? "true" : "false"}
              @click=${() => (t.id === "agency" ? openAgencyTab() : setDetailTab(state, client, t.id))}
            >
              <span>${t.label}</span>
              ${t.badge && t.badge > 0 ? html`<span class="crm-page-tab-badge">${t.badge}</span>` : nothing}
              ${t.dot && !t.badge ? html`<span class="crm-page-tab-dot"></span>` : nothing}
            </button>
          `)}
        </div>

        <div class="crm-page-body" key=${cs.detailTab}>
          ${cs.detailTab === "overview"   ? renderDetailOverview(state, cs, client) :
            cs.detailTab === "connections" ? renderDetailConnections(state, cs, client) :
            cs.detailTab === "properties" ? renderDetailProperties(state, cs, client) :
            cs.detailTab === "revenue"    ? renderDetailRevenue(state, cs, client) :
            cs.detailTab === "campaign"   ? renderDetailCampaign(state, cs, client) :
            cs.detailTab === "docs"       ? renderDetailDocs(state, cs, client) :
            cs.detailTab === "relations"  ? renderDetailRelations(state, cs, client) :
            cs.detailTab === "agency"     ? renderDetailAgency(state, cs, client, name) :
            cs.detailTab === "activity"   ? renderDetailActivityLog(state, cs, client) :
            cs.detailTab === "kanban"     ? renderDetailKanban(state, cs, client) :
            nothing}
        </div>
  `;
}

// — Overview tab: summary cards with the most-likely-useful fields ───
// Linked-projects kanban shown at the top of the client Overview tab.
function renderDetailKanban(state: AppViewState, cs: ClientsState, client: GatewayBrowserClient) {
  const linkedProjectCount = cs.detailRelations.project.length;
  const k = cs.detailKanban;
  if (k.loading && k.tasks.length === 0 && k.projects.length === 0) {
    return html`
      <div class="crm-page-board">
        <div class="crm-page-board-head">
          <div class="crm-page-board-head-left">
            <span class="crm-page-board-title">Projects &amp; tasks</span>
          </div>
          <span class="crm-page-board-pill">Loading…</span>
        </div>
      </div>
    `;
  }
  if (linkedProjectCount === 0) {
    return html`
      <div class="crm-page-board">
        <div class="crm-page-board-head">
          <div class="crm-page-board-head-left">
            <span class="crm-page-board-title">Projects &amp; tasks</span>
          </div>
          <span class="crm-page-board-pill">0 linked</span>
        </div>
        <div class="crm-page-board-empty-msg">
          No projects linked to this client yet. Open the <strong>Relations</strong> tab to link one.
        </div>
      </div>
    `;
  }

  const columns: { id: string; key: ClientsState["detailKanban"]["tasks"][number]["status"]; label: string; cls: string }[] = [
    { id: "todo",     key: "todo",        label: "Todo",        cls: "is-todo" },
    { id: "doing",    key: "in_progress", label: "In progress", cls: "is-doing" },
    { id: "blocked",  key: "blocked",     label: "Blocked",     cls: "is-block" },
    { id: "done",     key: "done",        label: "Done",        cls: "is-done" },
  ];
  const grouped: Record<string, typeof k.tasks> = { todo: [], in_progress: [], blocked: [], done: [] };
  for (const t of k.tasks) {
    (grouped[t.status] ?? grouped.todo).push(t);
  }
  const projectName = (id: string | null): string => {
    if (!id) return "";
    const hit = k.projects.find((p) => p.id === id);
    if (hit) return hit.name;
    // Fall back to the linked-project list from relations if kanban store
    // didn't return a project record (e.g. relation points at a stale id).
    const rel = cs.detailRelations.project.find((p) => p.id === id);
    return rel?.name ?? id.slice(0, 8);
  };

  return html`
    <div class="crm-page-board">
      <div class="crm-page-board-head">
        <div class="crm-page-board-head-left">
          <span class="crm-page-board-title">Projects &amp; tasks</span>
          <span class="crm-page-board-pill">${linkedProjectCount} project${linkedProjectCount === 1 ? "" : "s"}</span>
          <span class="crm-page-board-pill">${k.tasks.length} task${k.tasks.length === 1 ? "" : "s"}</span>
        </div>
        <span class="crm-page-board-pill" style="cursor:pointer;" @click=${() => setDetailTab(state, client, "relations")}>
          Manage links →
        </span>
      </div>
      ${k.tasks.length === 0 ? html`
        <div class="crm-page-board-empty-msg">
          ${linkedProjectCount} project${linkedProjectCount === 1 ? "" : "s"} linked, but no tasks yet.
        </div>
      ` : html`
        <div class="crm-page-board-cols">
          ${columns.map((col) => {
            const tasks = grouped[col.key] ?? [];
            return html`
              <div class="crm-page-board-col ${col.cls}">
                <div class="crm-page-board-col-head">
                  <span>${col.label}</span>
                  <span class="crm-page-board-col-count">${tasks.length}</span>
                </div>
                ${tasks.length === 0
                  ? html`<div class="crm-page-board-empty">—</div>`
                  : tasks.map((t) => html`
                      <div class="crm-page-board-task">
                        <div class="crm-page-board-task-title">${t.title}</div>
                        <div class="crm-page-board-task-meta">
                          ${t.projectId ? html`<span class="crm-page-board-task-pill">${projectName(t.projectId)}</span>` : nothing}
                          ${t.priority ? html`<span class="crm-page-board-task-pill priority-${t.priority.toLowerCase()}">${t.priority}</span>` : nothing}
                          ${t.dueDate ? html`<span>Due ${new Date(t.dueDate).toLocaleDateString()}</span>` : nothing}
                          ${t.assignee ? html`<span>${t.assignee}</span>` : nothing}
                        </div>
                      </div>
                    `)}
              </div>
            `;
          })}
        </div>
      `}
    </div>
  `;
}

function renderContactSocialsCard(c: DynamicClientRecord) {
  const filled = SOCIAL_PLATFORMS.filter((p) => getSocialValue(c, p.key));
  if (filled.length === 0) return nothing;
  return html`
    <div class="crm-page-card">
      <div class="crm-page-card-title" style="display:flex;align-items:center;gap:8px;">
        Contact &amp; Socials
        <span style="flex:1;height:1px;background:linear-gradient(90deg,rgba(201,168,76,0.3),transparent);"></span>
      </div>
      <div class="crm-contact-section">
        ${filled.map((p) => {
          const val = getSocialValue(c, p.key) ?? "";
          const isLink = p.action === "link";
          const href = isLink ? p.href(val) : "#";
          return html`
            <div class="crm-contact-row">
              <div class="crm-contact-row-icon">${unsafeHTML(p.icon)}</div>
              <span class="crm-contact-row-label">${p.label}</span>
              <span class="crm-contact-row-value">
                ${isLink
                  ? html`<a href=${href} target="_blank" rel="noopener noreferrer">${val}</a>`
                  : val}
              </span>
              <button
                class="crm-contact-copy"
                title="Copy ${p.label}"
                @click=${(e: Event) => {
                  e.stopPropagation();
                  navigator.clipboard.writeText(val).catch(() => {});
                  const btn = e.currentTarget as HTMLButtonElement;
                  btn.textContent = "✓";
                  setTimeout(() => { btn.textContent = "Copy"; }, 1400);
                }}
              >Copy</button>
            </div>
          `;
        })}
      </div>
    </div>
  `;
}

function renderDetailOverview(state: AppViewState, cs: ClientsState, client: GatewayBrowserClient) {
  const c = cs.detailClient!;
  if (!cs.schema) {
    return html`<div class="crm-page-docs-empty">Schema loading…</div>`;
  }
  const all = Object.entries(cs.schema.properties);
  const pickFirst = (types: string[]) => all.find(([n, p]) => types.includes(p.type) && n !== "_docs");

  const groups: { title: string; entries: [string, NotionPropertySchema][] }[] = [
    { title: "Contact", entries: all.filter(([_, p]) => ["email", "phone_number", "url"].includes(p.type)) },
    { title: "Status", entries: all.filter(([_, p]) => ["select", "status", "multi_select", "checkbox"].includes(p.type)) },
    { title: "Financial", entries: all.filter(([_, p]) => p.type === "number") },
    { title: "Timeline", entries: all.filter(([_, p]) => ["date", "created_time"].includes(p.type)) },
  ];

  // Funnel card — shown when a campaign with a funnel is linked to this client
  const linkedCampaignId = getClientCampaignId(c);
  const linkedCampaign = linkedCampaignId
    ? cs.campaignPickerOptions.find((o) => o.id === linkedCampaignId) ?? null
    : null;
  const funnelCard = linkedCampaign?.funnelId ? html`
    <div class="crm-page-card crm-campaign-funnel-card">
      <div class="crm-page-card-title">Funnel</div>
      <div class="crm-page-prop">
        <span class="crm-page-prop-label">Campaign</span>
        <span class="crm-page-prop-value">
          <span class="crm-campaign-chip crm-campaign-chip--${linkedCampaign.status}">${linkedCampaign.name}</span>
        </span>
      </div>
      <div class="crm-page-prop">
        <span class="crm-page-prop-label">Funnel</span>
        <span class="crm-page-prop-value" style="font:500 12px 'JetBrains Mono',monospace;color:var(--g-primary);">${linkedCampaign.funnelId}</span>
      </div>
      <div style="margin-top:8px;">
        <button class="crm-page-action" style="font-size:10px;" @click=${() => setDetailTab(state, client, "campaign")}>Open Campaign tab →</button>
      </div>
    </div>
  ` : nothing;

  return html`
    ${renderConnectionsPanel(state, client, "client", c.id, {
      title: "Connections — Opportunities · Projects · Reports · People",
      compact: true,
    })}
    ${renderObjectReports(state, client, "client", c.id, { title: "Reports — documents this client" })}
    ${renderDetailKanban(state, cs, client)}
    <div class="crm-page-grid">
      ${funnelCard}
      ${renderContactSocialsCard(c)}
      ${groups.map((g) => g.entries.length === 0 ? nothing : html`
        <div class="crm-page-card">
          <div class="crm-page-card-title">${g.title}</div>
          ${g.entries.map(([propName, prop]) => html`
            <div class="crm-page-prop">
              <span class="crm-page-prop-label">${propName}</span>
              <span class="crm-page-prop-value">${renderPropertyDisplay(c, propName, prop, cs.schema)}</span>
            </div>
          `)}
        </div>
      `)}
      ${pickFirst(["rich_text"]) ? html`
        <div class="crm-page-card" style="grid-column: 1 / -1;">
          <div class="crm-page-card-title">Notes</div>
          ${all.filter(([_, p]) => p.type === "rich_text").map(([n]) => {
            const v = c.data[n];
            return v ? html`
              <div style="margin-bottom:10px;">
                <div class="crm-page-prop-label">${n}</div>
                <div style="margin-top:6px; color:#f5f5f4; font-size:13px; line-height:1.55; white-space:pre-wrap;">${v}</div>
              </div>
            ` : nothing;
          })}
        </div>
      ` : nothing}
    </div>
  `;
}

// — Properties tab: inline edit ALL properties ───────────────
function renderDetailProperties(state: AppViewState, cs: ClientsState, client: GatewayBrowserClient) {
  const c = cs.detailClient!;
  if (!cs.schema) return html`<div class="crm-page-docs-empty">Schema loading…</div>`;
  const all = Object.entries(cs.schema.properties).filter(([n]) => n !== "_docs");
  return html`
    <div class="crm-page-card">
      <div class="crm-page-card-title">All properties</div>
      ${all.map(([propName, prop]) => html`
        <div class="crm-page-prop">
          <span class="crm-page-prop-label">${propName}</span>
          <span class="crm-page-prop-value">${renderPropertyEditor(state, client, c, propName, prop, cs.schema)}</span>
        </div>
      `)}
    </div>
  `;
}

// — Docs tab: markdown editor + live preview ─────────────────
function renderDetailDocs(state: AppViewState, cs: ClientsState, client: GatewayBrowserClient) {
  const c = cs.detailClient!;
  const draft = cs.detailDocsDraft || "";
  const autoSave = getDocsAutosaver(c.id);
  const status =
    cs.detailDocsSaving ? "Saving…"
    : cs.detailDocsDirty ? "Unsaved — autosaving…"
    : "Saved";
  const statusClass = cs.detailDocsDirty && !cs.detailDocsSaving ? "is-dirty" : "";

  return html`
    <div class="crm-page-docs">
      <div class="crm-page-docs-bar">
        <span class="crm-page-docs-title">Documentation</span>
        <span class="crm-page-docs-status ${statusClass}">${status}</span>
      </div>
      <moltbot-markdown-editor
        .value=${draft}
        placeholder="Project briefs, meeting notes, decisions, anything you want the agent to know. Markdown supported."
        minRows="14"
        @change=${(e: CustomEvent) => {
          setDocsDraft(state, e.detail?.value ?? "");
          autoSave(state, client);
        }}
      ></moltbot-markdown-editor>
      ${draft.trim().length > 0 ? html`
        <details style="margin-top:14px;">
          <summary style="cursor:pointer; font: 600 10.5px 'JetBrains Mono', monospace; letter-spacing:0.18em; text-transform:uppercase; color: rgba(255,255,255,0.55);">Live preview</summary>
          <div class="crm-page-md-preview">${unsafeHTML(toSanitizedMarkdownHtml(draft))}</div>
        </details>
      ` : html`<div class="crm-page-docs-empty">Start typing — the agent reads this on every reply.</div>`}
    </div>
  `;
}

// — Relations tab: pills + picker for projects/notes/workflows/campaigns ──
function renderDetailRelations(state: AppViewState, cs: ClientsState, client: GatewayBrowserClient) {
  const campaignCatalog = cs.campaignPickerOptions.map((o) => ({ id: o.id, name: o.name }));
  const groups: { type: "project" | "note" | "workflow" | "campaign"; label: string; catalog: { id: string; name: string }[]; rels: { id: string; name: string }[] }[] = [
    { type: "project",  label: "Projects",  catalog: cs.catalogs.projects,  rels: cs.detailRelations.project  },
    { type: "note",     label: "Notes",     catalog: cs.catalogs.notes,     rels: cs.detailRelations.note     },
    { type: "workflow", label: "Workflows", catalog: cs.catalogs.workflows, rels: cs.detailRelations.workflow },
    { type: "campaign", label: "Campaigns", catalog: campaignCatalog,        rels: cs.detailRelations.campaign },
  ];

  const loading = cs.detailRelations.loading;
  const error = cs.detailRelations.error;

  return html`
    <div class="crm-page-card">
      ${error ? html`
        <div class="crm-page-rel-error">
          <span>Couldn't load relations. ${error}</span>
          <button class="crm-page-rel-retry" @click=${() => void loadRelationsForDetail(state, client)}>Retry</button>
        </div>
      ` : nothing}
      ${groups.map((g) => html`
        <div class="crm-page-rel-group">
          <div class="crm-page-rel-head">
            <div class="crm-page-rel-head-left">
              <span class="crm-page-card-title" style="margin:0;">${g.label}</span>
              <span style="color:rgba(255,255,255,0.4); font:500 11px 'Inter', sans-serif;">${loading ? "" : g.rels.length}</span>
            </div>
            ${cs.relationPickerOpenFor === g.type
              ? html`<button class="crm-page-rel-add" @click=${() => setRelationPickerOpen(state, null)}>Done</button>`
              : html`<button class="crm-page-rel-add" ?disabled=${loading} @click=${() => {
                  if (g.type === "campaign") void loadCampaignPickerOptions(state, client);
                  setRelationPickerOpen(state, g.type);
                }}>+ Link ${g.label.toLowerCase()}</button>`}
          </div>
          <div class="crm-page-rel-pills">
            ${loading
              ? html`
                  <span class="crm-page-rel-skel" style="width:96px;"></span>
                  <span class="crm-page-rel-skel" style="width:124px;"></span>
                  <span class="crm-page-rel-skel" style="width:72px;"></span>
                `
              : g.rels.length === 0
                ? html`<span class="crm-page-rel-empty">No linked ${g.label.toLowerCase()} yet.</span>`
                : g.rels.map((peer) => {
                    const navigable = g.type === "project";
                    return html`
                      <span
                        class="crm-page-rel-pill ${navigable ? "is-navigable" : ""}"
                        title="${navigable ? "Open project — " : ""}${peer.id}"
                        @click=${navigable
                          ? () => window.dispatchEvent(new CustomEvent("infinibot:kanban-open-task", { detail: { projectId: peer.id } }))
                          : null}
                      >
                        ${peer.name}
                        <button class="crm-page-rel-pill-rm" title="Unlink" aria-label="Unlink ${peer.name}"
                          @click=${(e: Event) => { e.stopPropagation(); unlinkClientPeer(state, client, g.type, peer.id); }}>×</button>
                      </span>
                    `;
                  })}
          </div>
          ${cs.relationPickerOpenFor === g.type ? renderRelationPicker(state, cs, client, g.type, g.catalog, g.rels.map(r => r.id)) : nothing}
        </div>
      `)}
    </div>
  `;
}

// ── Campaign Tab ─────────────────────────────────────────────────────────────
function renderDetailCampaign(state: AppViewState, cs: ClientsState, client: GatewayBrowserClient) {
  const c = cs.detailClient!;
  const campaignId = getClientCampaignId(c);
  const linkedCampaign = campaignId
    ? cs.campaignPickerOptions.find((o) => o.id === campaignId) ?? null
    : null;
  const placeholders = getClientPlaceholders(c);
  const draft = cs.campaignPlaceholderDraft;

  const statusColor = (s: string) => {
    if (s === "active") return "var(--g-primary)";
    if (s === "paused") return "rgba(234,179,8,0.9)";
    if (s === "completed") return "rgba(34,197,94,0.9)";
    return "rgba(255,255,255,0.4)";
  };

  return html`
    <div class="crm-page-campaign">

      <!-- ── Campaign assignment ──────────────────────────── -->
      <div class="crm-page-card">
        <div class="crm-page-card-title">Campaign</div>
        ${campaignId && linkedCampaign ? html`
          <div class="crm-campaign-summary">
            <div class="crm-campaign-summary-name">
              <span class="crm-campaign-status-dot" style="background:${statusColor(linkedCampaign.status)};"></span>
              <span style="font:600 14px 'Inter',sans-serif;color:#f5f5f4;">${linkedCampaign.name}</span>
              <span class="crm-campaign-chip crm-campaign-chip--${linkedCampaign.status}">${linkedCampaign.status}</span>
            </div>
            ${linkedCampaign.funnelId ? html`
              <div class="crm-page-prop" style="margin-top:8px;">
                <span class="crm-page-prop-label">Funnel ID</span>
                <span class="crm-page-prop-value" style="font:500 11px 'JetBrains Mono',monospace;color:var(--g-primary);">${linkedCampaign.funnelId}</span>
              </div>
            ` : nothing}
            <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;">
              <button class="crm-page-action" @click=${() => {
                cs.campaignPickerOpen = true;
                void loadCampaignPickerOptions(state, client);
                state.requestUpdate?.();
              }}>Change campaign</button>
              <button class="crm-page-action is-danger" @click=${() => assignClientCampaign(state, client, c.id, null)}>Unlink</button>
            </div>
          </div>
        ` : campaignId ? html`
          <div class="crm-page-prop">
            <span class="crm-page-prop-label">Campaign ID</span>
            <span class="crm-page-prop-value" style="font:500 11px 'JetBrains Mono',monospace;">${campaignId}</span>
          </div>
          <button class="crm-page-action" style="margin-top:8px;" @click=${() => {
            cs.campaignPickerOpen = true;
            void loadCampaignPickerOptions(state, client);
            state.requestUpdate?.();
          }}>Change campaign</button>
        ` : html`
          <div class="crm-campaign-empty">
            <div style="font-size:13px;color:rgba(255,255,255,0.45);margin-bottom:12px;">No campaign assigned to this client.</div>
            <button class="crm-btn primary" @click=${() => {
              cs.campaignPickerOpen = true;
              void loadCampaignPickerOptions(state, client);
              state.requestUpdate?.();
            }}>Assign campaign</button>
          </div>
        `}

        <!-- Campaign picker dropdown -->
        ${cs.campaignPickerOpen ? html`
          <div class="crm-campaign-picker-wrap" style="margin-top:12px;">
            ${cs.campaignPickerLoading ? html`<div class="crm-page-docs-empty">Loading campaigns…</div>` : nothing}
            ${cs.campaignPickerOptions.length === 0 && !cs.campaignPickerLoading ? html`
              <div class="crm-page-docs-empty">No campaigns found. Create one in the Campaigns section first.</div>
            ` : nothing}
            ${cs.campaignPickerOptions.map((opt) => html`
              <button
                class="crm-page-picker-row ${opt.id === campaignId ? "is-selected" : ""}"
                @click=${async () => {
                  cs.campaignPickerOpen = false;
                  state.requestUpdate?.();
                  await assignClientCampaign(state, client, c.id, opt.id);
                }}
              >
                <span class="crm-campaign-status-dot" style="background:${statusColor(opt.status)};flex-shrink:0;"></span>
                <span>${opt.name}</span>
                <span style="color:rgba(255,255,255,0.32);font:500 10px 'JetBrains Mono',monospace;">${opt.status}</span>
              </button>
            `)}
            <button class="crm-page-picker-close" @click=${() => { cs.campaignPickerOpen = false; state.requestUpdate?.(); }}>Cancel</button>
          </div>
        ` : nothing}
      </div>

      <!-- ── Campaign Placeholders ────────────────────────── -->
      <div class="crm-page-card" style="margin-top:14px;">
        <div class="crm-page-card-title" style="display:flex;align-items:center;justify-content:space-between;">
          <span>Campaign Placeholders</span>
          ${draft === null ? html`
            <button class="crm-page-action" style="font-size:10px;" @click=${() => {
              cs.campaignPlaceholderDraft = { ...placeholders };
              state.requestUpdate?.();
            }}>Edit</button>
          ` : html`
            <div style="display:flex;gap:6px;">
              <button class="crm-page-action" @click=${() => {
                void saveCampaignPlaceholders(state, client, c.id, draft!);
              }}>Save</button>
              <button class="crm-page-action" @click=${() => {
                cs.campaignPlaceholderDraft = null;
                state.requestUpdate?.();
              }}>Cancel</button>
            </div>
          `}
        </div>

        <div style="margin-top:4px;font-size:11px;color:rgba(255,255,255,0.4);line-height:1.5;margin-bottom:12px;">
          These variables are merged into campaign emails and documents as
          <code style="background:rgba(255,255,255,0.07);padding:1px 5px;border-radius:4px;color:var(--g-primary);">&#123;&#123;client.placeholders.KEY&#125;&#125;</code>
        </div>

        ${draft !== null ? html`
          <!-- Edit mode: editable rows + add row -->
          <div class="crm-placeholder-table">
            ${Object.entries(draft).map(([k, v], i) => html`
              <div class="crm-placeholder-row">
                <input
                  class="crm-placeholder-key"
                  type="text"
                  placeholder="variableName"
                  .value=${k}
                  @blur=${(e: Event) => {
                    const newKey = (e.target as HTMLInputElement).value.trim();
                    if (!newKey || newKey === k) return;
                    const val = draft![k];
                    const updated: Record<string, string> = {};
                    for (const [ek, ev] of Object.entries(draft!)) {
                      updated[ek === k ? newKey : ek] = ev;
                    }
                    cs.campaignPlaceholderDraft = updated;
                    state.requestUpdate?.();
                  }}
                />
                <input
                  class="crm-placeholder-val"
                  type="text"
                  placeholder="value or URL"
                  .value=${v}
                  @input=${(e: Event) => {
                    if (cs.campaignPlaceholderDraft) {
                      cs.campaignPlaceholderDraft = { ...cs.campaignPlaceholderDraft, [k]: (e.target as HTMLInputElement).value };
                    }
                  }}
                />
                <span class="crm-placeholder-copy" title="Copy merge tag" @click=${() => {
                  void navigator.clipboard.writeText(`{{client.placeholders.${k}}}`);
                }}>&#123;&#123;${k}&#125;&#125;</span>
                <button class="crm-page-rel-pill-rm" style="flex-shrink:0;" @click=${() => {
                  const updated = { ...cs.campaignPlaceholderDraft };
                  delete updated[k];
                  cs.campaignPlaceholderDraft = updated;
                  state.requestUpdate?.();
                }}>×</button>
              </div>
            `)}
            <button class="crm-placeholder-add-row" @click=${() => {
              const n = `variable${Object.keys(draft!).length + 1}`;
              cs.campaignPlaceholderDraft = { ...draft!, [n]: "" };
              state.requestUpdate?.();
            }}>+ Add variable</button>
          </div>
        ` : Object.keys(placeholders).length === 0 ? html`
          <div class="crm-campaign-empty" style="padding:0;">
            <div style="font-size:12px;color:rgba(255,255,255,0.38);">No placeholders defined yet. Click Edit to add custom merge variables.</div>
          </div>
        ` : html`
          <!-- Display mode: read-only rows -->
          <div class="crm-placeholder-table">
            ${Object.entries(placeholders).map(([k, v]) => html`
              <div class="crm-placeholder-row">
                <span class="crm-placeholder-key crm-placeholder-key--ro">${k}</span>
                <span class="crm-placeholder-val crm-placeholder-val--ro">${v || html`<span style="color:rgba(255,255,255,0.3);">—</span>`}</span>
                <span class="crm-placeholder-copy" title="Copy merge tag" @click=${() => {
                  void navigator.clipboard.writeText(`{{client.placeholders.${k}}}`);
                }}>&#123;&#123;${k}&#125;&#125;</span>
              </div>
            `)}
          </div>
        `}
      </div>

      <!-- ── Generate Context ──────────────────────────────── -->
      ${campaignId ? html`
        <div class="crm-page-card" style="margin-top:14px;">
          <div class="crm-page-card-title" style="display:flex;align-items:center;justify-content:space-between;">
            <span>Context Preview</span>
            <button
              class="crm-page-action"
              ?disabled=${cs.campaignContextLoading || !campaignId}
              @click=${() => generateClientContext(state, client, c.id)}
            >${cs.campaignContextLoading ? "Building…" : "Generate context"}</button>
          </div>
          <div style="margin-top:4px;font-size:11px;color:rgba(255,255,255,0.4);line-height:1.5;margin-bottom:8px;">
            Preview the full JSON blob sent to email and document generators when this client's campaign runs.
          </div>
          ${cs.campaignContextPreview !== null ? html`
            <pre class="crm-context-preview">${JSON.stringify(cs.campaignContextPreview, null, 2)}</pre>
          ` : nothing}
        </div>
      ` : nothing}
    </div>
  `;
}

function renderRelationPicker(
  state: AppViewState,
  cs: ClientsState,
  client: GatewayBrowserClient,
  peerType: "project" | "note" | "workflow" | "campaign",
  catalog: { id: string; name: string }[],
  selectedIds: string[],
) {
  const q = cs.relationPickerQuery.trim().toLowerCase();
  const selectedSet = new Set(selectedIds);
  const filtered = catalog
    .filter((entry) => !selectedSet.has(entry.id))
    .filter((entry) => !q || entry.name.toLowerCase().includes(q))
    .slice(0, 80);

  return html`
    <div class="crm-page-picker">
      <input
        class="crm-page-picker-input"
        type="text"
        autofocus
        placeholder="Search ${peerType}s by name…"
        .value=${cs.relationPickerQuery}
        @input=${(e: Event) => setRelationPickerQuery(state, (e.target as HTMLInputElement).value)}
        @keydown=${(e: KeyboardEvent) => { if (e.key === "Escape") setRelationPickerOpen(state, null); }}
      />
      <div class="crm-page-picker-list">
        ${catalog.length === 0
          ? html`<div class="crm-page-picker-empty">No ${peerType}s exist yet. Create one and it'll show up here.</div>`
          : filtered.length === 0
            ? html`<div class="crm-page-picker-empty">${q ? "No matches." : "Nothing left to link."}</div>`
            : filtered.map((entry) => html`
                <button
                  class="crm-page-picker-row"
                  @click=${async () => {
                    if (peerType === "campaign") {
                      await linkClientCampaign(state, client, cs.detailClient!.id, entry.id);
                    } else {
                      await linkClientPeer(state, client, peerType, entry.id);
                    }
                    setRelationPickerQuery(state, "");
                  }}
                >
                  <span>${entry.name}</span>
                  <span style="color:rgba(255,255,255,0.32); font:500 10px 'JetBrains Mono', monospace;">${entry.id.slice(0, 8)}</span>
                </button>
              `)}
      </div>
      <button class="crm-page-picker-close" @click=${() => setRelationPickerOpen(state, null)}>Close picker</button>
    </div>
  `;
}

/**
 * Activity thread — the client's interaction history as one chronological
 * stream rather than a bare list.
 *
 * Three sources are merged and sorted newest-first so the thread reads the way
 * the relationship actually happened:
 *   - logged interactions (`clients.activity.list`) — notes, calls, emails,
 *     meetings the user recorded
 *   - revenue events (`clients.revenue.list`) — money is an interaction, and
 *     leaving it on its own tab meant "we invoiced them the day after that
 *     call" was invisible
 *   - record lifecycle (created / last updated) — the bookends, so a client
 *     with no logged activity still shows something true instead of a blank
 *
 * The composer is inline at the TOP of the thread rather than behind a toggle:
 * adding a note is the primary action on this tab, and hiding the primary
 * action behind a button costs a click on every single use.
 */

type ThreadEntryKind = "note" | "call" | "email" | "meeting" | "revenue" | "lifecycle";

interface ActivityThreadEntry {
  id: string;
  kind: ThreadEntryKind;
  /** Display label for the entry type. */
  label: string;
  body: string;
  at: number;
  /** Rendered on the right of the header (amount, etc.). */
  accent?: string;
}

const THREAD_GLYPH: Record<ThreadEntryKind, string> = {
  note: "✎",
  call: "☎",
  email: "✉",
  meeting: "☷",
  revenue: "$",
  lifecycle: "◆",
};

const ACTIVITY_TYPES: { id: string; label: string }[] = [
  { id: "note", label: "Note" },
  { id: "call", label: "Call" },
  { id: "email", label: "Email" },
  { id: "meeting", label: "Meeting" },
];

/** Merge every activity source into one newest-first stream. */
function buildActivityThread(
  cs: ClientsState,
  c: DynamicClientRecord,
): ActivityThreadEntry[] {
  const out: ActivityThreadEntry[] = [];

  for (const e of cs.detailActivity.entries) {
    const kind = (["note", "call", "email", "meeting"] as const).includes(
      e.type as "note",
    )
      ? (e.type as ThreadEntryKind)
      : "note";
    out.push({
      id: `act:${e.id}`,
      kind,
      label: e.type || "note",
      body: e.note,
      at: e.createdAt,
    });
  }

  for (const r of cs.detailRevenue.entries) {
    out.push({
      id: `rev:${r.id}`,
      kind: "revenue",
      label: "revenue",
      body: r.note || "Revenue logged",
      at: r.loggedAt || r.createdAt,
      accent: fmtCurrency(r.amountCents),
    });
  }

  const created = new Date(c.created_at).getTime();
  if (Number.isFinite(created) && created > 0) {
    out.push({
      id: "life:created",
      kind: "lifecycle",
      label: "created",
      body: "Client record created.",
      at: created,
    });
  }
  const updated = new Date(c.updated_at).getTime();
  if (Number.isFinite(updated) && updated > 0 && updated - created > 60_000) {
    out.push({
      id: "life:updated",
      kind: "lifecycle",
      label: "updated",
      body: "Record last updated.",
      at: updated,
    });
  }

  return out.sort((a, b) => b.at - a.at);
}

function dayLabel(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = new Date(d);
  day.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 7 && diff > 0) return `${diff} days ago`;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function renderDetailActivityLog(state: AppViewState, cs: ClientsState, gwClient: GatewayBrowserClient) {
  const c = cs.detailClient!;
  const da = cs.detailActivity;
  // Revenue rides in this thread, so pull it here rather than making the user
  // visit the Revenue tab first to make the merged view complete.
  if (cs.detailRevenue.entries.length === 0 && !cs.detailRevenue.loading) {
    void loadDetailRevenue(state, gwClient);
  }

  const entries = buildActivityThread(cs, c);
  let lastDay = "";

  const submit = () => {
    if (!da.formNote.trim() || da.saving) return;
    void logDetailActivity(state, gwClient);
  };

  return html`
    <div class="crm-thread-panel">
      <div class="crm-conn-head">
        <span class="crm-conn-head-title">Activity thread</span>
        ${entries.length ? html`<span class="crm-conn-count">${entries.length}</span>` : nothing}
        <button
          class="crm-conn-refresh"
          title="Reload activity"
          @click=${() => {
            void loadDetailActivity(state, gwClient);
            void loadDetailRevenue(state, gwClient);
          }}
        >↻</button>
      </div>

      <!-- Inline composer, always open -->
      <div class="crm-thread-composer">
        <div class="crm-thread-type-row">
          ${ACTIVITY_TYPES.map((t) => html`
            <button
              class="crm-thread-type ${da.formType === t.id ? "is-active" : ""}"
              @click=${() => { da.formType = t.id; state.requestUpdate?.(); }}
            >
              <span class="crm-thread-type-glyph">${THREAD_GLYPH[t.id as ThreadEntryKind]}</span>
              ${t.label}
            </button>
          `)}
        </div>
        <textarea
          class="crm-thread-input"
          rows="2"
          placeholder="What happened? (⌘/Ctrl + Enter to post)"
          .value=${da.formNote}
          @input=${(e: Event) => { da.formNote = (e.target as HTMLTextAreaElement).value; state.requestUpdate?.(); }}
          @keydown=${(e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); submit(); }
          }}
        ></textarea>
        <div class="crm-thread-composer-foot">
          <span class="crm-thread-hint">Posts to this client's history and the merged thread.</span>
          <button
            class="crm-thread-post"
            ?disabled=${da.saving || !da.formNote.trim()}
            @click=${submit}
          >${da.saving ? "Posting…" : "Post"}</button>
        </div>
      </div>

      ${da.loading && entries.length === 0
        ? html`<div class="crm-conn-note">Loading the thread…</div>`
        : entries.length === 0
          ? html`<div class="crm-conn-note">
              Nothing recorded yet — the first note you post starts this client's history.
            </div>`
          : html`
              <ol class="crm-thread-list">
                ${entries.map((e) => {
                  const day = dayLabel(e.at);
                  const showDay = day !== lastDay;
                  lastDay = day;
                  return html`
                    ${showDay
                      ? html`<li class="crm-thread-day" aria-hidden="true"><span>${day}</span></li>`
                      : nothing}
                    <li class="crm-thread-entry kind-${e.kind}">
                      <span class="crm-thread-node" aria-hidden="true">${THREAD_GLYPH[e.kind]}</span>
                      <div class="crm-thread-entry-body">
                        <div class="crm-thread-entry-head">
                          <span class="crm-thread-entry-kind">${e.label}</span>
                          ${e.accent ? html`<span class="crm-thread-entry-accent">${e.accent}</span>` : nothing}
                          <time class="crm-thread-entry-time" datetime=${new Date(e.at).toISOString()}>
                            ${new Date(e.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                          </time>
                        </div>
                        <div class="crm-thread-entry-text">${e.body}</div>
                      </div>
                    </li>
                  `;
                })}
              </ol>
            `}
    </div>
  `;
}

function renderDetailRevenue(state: AppViewState, cs: ClientsState, gwClient: GatewayBrowserClient) {
  const dr = cs.detailRevenue;
  return html`
    <div class="crm-page-card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <div>
          <div class="crm-page-card-title" style="margin:0;">Revenue</div>
          <div style="font:600 18px Inter;color:var(--g-primary);margin-top:4px;">${fmtCurrency(dr.totalCents)}</div>
        </div>
        <button class="crm-btn crm-btn-sm" style="border-color:var(--g-primary);color:var(--g-primary);"
          @click=${() => { dr.showForm = !dr.showForm; state.requestUpdate?.(); }}>
          ${dr.showForm ? "Cancel" : "+ Log Revenue"}
        </button>
      </div>
      ${dr.showForm ? html`
        <div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:12px;margin-bottom:12px;display:flex;flex-direction:column;gap:8px;">
          <label class="crm-page-prop-label">Amount ($)</label>
          <input class="crm-page-prop-input" type="number" min="0" step="0.01" placeholder="0.00"
            .value=${dr.formAmount}
            @input=${(e: Event) => { dr.formAmount=(e.target as HTMLInputElement).value; state.requestUpdate?.(); }}/>
          <label class="crm-page-prop-label">Note</label>
          <input class="crm-page-prop-input" type="text" placeholder="Optional"
            .value=${dr.formNote}
            @input=${(e: Event) => { dr.formNote=(e.target as HTMLInputElement).value; state.requestUpdate?.(); }}/>
          <button class="crm-btn crm-btn-sm" style="border-color:var(--g-primary);color:var(--g-primary);align-self:flex-end;"
            ?disabled=${dr.saving||!dr.formAmount}
            @click=${() => void logDetailRevenue(state, gwClient)}>
            ${dr.saving ? "Saving…" : "Log Revenue"}
          </button>
        </div>
      ` : nothing}
      ${dr.loading ? html`<div class="crm-loading"><span class="crm-loading-dot">◆</span> Loading…</div>` : html`
        ${dr.entries.length === 0 ? html`<p style="color:rgba(255,255,255,0.4);font:400 12px Inter;">No revenue logged yet.</p>` : html`
          <table style="width:100%;border-collapse:collapse;">
            <thead>
              <tr>
                <th class="crm-rev-th">Amount</th>
                <th class="crm-rev-th">Date</th>
                <th class="crm-rev-th">Note</th>
              </tr>
            </thead>
            <tbody>
              ${dr.entries.map((e) => html`
                <tr class="crm-rev-row">
                  <td class="crm-rev-td" style="color:var(--g-primary);font-weight:600;">${fmtCurrency(e.amountCents)}</td>
                  <td class="crm-rev-td">${new Date(e.loggedAt).toLocaleDateString()}</td>
                  <td class="crm-rev-td" style="color:rgba(255,255,255,0.6);">${e.note ?? "—"}</td>
                </tr>
              `)}
            </tbody>
          </table>
        `}
      `}
    </div>
  `;
}



// Display + edit helpers reused across tabs.
function renderPropertyDisplay(c: DynamicClientRecord, propName: string, prop: NotionPropertySchema, schema: NotionDbSchema | null) {
  const val = c.data[propName];
  if (val === null || val === undefined || val === "") return html`<span style="color:rgba(255,255,255,0.32);">—</span>`;
  switch (prop.type) {
    case "select":
    case "status": {
      const optColor = getOptionColor(schema, propName, val);
      return html`<span class="crm-status-badge" style="color:${notionColor(optColor)};background:${notionBg(optColor)};">${val}</span>`;
    }
    case "multi_select":
      if (!Array.isArray(val) || val.length === 0) return html`<span style="color:rgba(255,255,255,0.32);">—</span>`;
      return html`<div style="display:flex; flex-wrap:wrap; gap:4px;">${val.map((t: string) => {
        const optColor = getOptionColor(schema, propName, t);
        return html`<span class="crm-tag" style="color:${notionColor(optColor)};border-color:${notionColor(optColor)}40;background:${notionBg(optColor)};">${t}</span>`;
      })}</div>`;
    case "url":
      return html`<a href="${val}" target="_blank" style="color:var(--g-primary); text-decoration:none;">${String(val).slice(0, 60)}${String(val).length > 60 ? "…" : ""}</a>`;
    case "email":
      return html`<a href="mailto:${val}" style="color:var(--g-primary); text-decoration:none;">${val}</a>`;
    case "phone_number":
      return html`<a href="tel:${val}" style="color:var(--g-primary); text-decoration:none;">${val}</a>`;
    case "date":
    case "created_time":
      return html`<span>${new Date(val).toLocaleDateString()}</span>`;
    case "checkbox":
      return html`<span>${val ? "✓ Yes" : "✕ No"}</span>`;
    default:
      return html`<span>${String(val)}</span>`;
  }
}

function renderPropertyEditor(
  state: AppViewState,
  client: GatewayBrowserClient,
  c: DynamicClientRecord,
  propName: string,
  prop: NotionPropertySchema,
  schema: NotionDbSchema | null,
) {
  const val = c.data[propName];
  const commit = (v: unknown) => { void setClientProperty(state, client, c.id, propName, v); };

  switch (prop.type) {
    case "select":
    case "status": {
      const opts = prop.options ?? [];
      return html`
        <select class="crm-page-prop-select"
          .value=${val ?? ""}
          @change=${(e: Event) => commit((e.target as HTMLSelectElement).value || null)}
        >
          <option value="">—</option>
          ${opts.map((o) => html`<option value=${o.name} ?selected=${o.name === val}>${o.name}</option>`)}
        </select>`;
    }
    case "multi_select": {
      const opts = prop.options ?? [];
      const arr: string[] = Array.isArray(val) ? val : [];
      return html`
        <div style="display:flex; flex-wrap:wrap; gap:4px;">
          ${opts.map((o) => {
            const on = arr.includes(o.name);
            return html`
              <button
                class="crm-tag"
                style="cursor:pointer; opacity:${on ? 1 : 0.45}; color:${notionColor(o.color)}; border-color:${notionColor(o.color)}40; background:${on ? notionBg(o.color) : "transparent"};"
                @click=${() => {
                  const next = on ? arr.filter((x) => x !== o.name) : [...arr, o.name];
                  commit(next);
                }}
              >${o.name}</button>
            `;
          })}
        </div>`;
    }
    case "checkbox":
      return html`
        <input type="checkbox" .checked=${!!val}
          @change=${(e: Event) => commit((e.target as HTMLInputElement).checked)}
          style="width:18px; height:18px; cursor:pointer; accent-color: var(--g-primary);"
        />`;
    case "number":
      return html`
        <input class="crm-page-prop-input" type="number"
          .value=${val == null ? "" : String(val)}
          @blur=${(e: Event) => {
            const s = (e.target as HTMLInputElement).value.trim();
            commit(s === "" ? null : Number(s));
          }}
        />`;
    case "date":
    case "created_time": {
      const iso = val ? new Date(val).toISOString().slice(0, 10) : "";
      return html`
        <input class="crm-page-prop-input" type="date" .value=${iso}
          @change=${(e: Event) => {
            const s = (e.target as HTMLInputElement).value;
            commit(s ? new Date(s).toISOString() : null);
          }}
        />`;
    }
    case "rich_text":
      return html`
        <textarea class="crm-page-prop-textarea"
          .value=${val ?? ""}
          @blur=${(e: Event) => commit((e.target as HTMLTextAreaElement).value)}
        ></textarea>`;
    case "url":
    case "email":
    case "phone_number":
    case "title":
    default:
      return html`
        <input class="crm-page-prop-input" type=${prop.type === "email" ? "email" : prop.type === "url" ? "url" : "text"}
          .value=${val ?? ""}
          @blur=${(e: Event) => commit((e.target as HTMLInputElement).value)}
        />`;
  }
}

// ── Create Dialog ────────────────────────────────────────────

// ── Smart paste parser ────────────────────────────────────────
// Extracts contact fields from a freeform blob (business card OCR,
// email signature, "John Smith, CEO @ Acme, john@acme.com, 555-1234").
// 100% client-side, no LLM round-trip — deterministic and instant.

interface ParsedContact {
  name?: string;
  email?: string;
  phone?: string;
  url?: string;
  company?: string;
  title?: string;
  notes?: string;
}

function smartParseContact(raw: string): ParsedContact {
  if (!raw || !raw.trim()) return {};
  const text = raw.replace(/\s+/g, " ").trim();
  const out: ParsedContact = {};

  // Email — strict-enough regex.
  const emailMatch = text.match(/[\w.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9.-]+/);
  if (emailMatch) out.email = emailMatch[0];

  // Phone — handle (xxx) xxx-xxxx, xxx-xxx-xxxx, +cc xxx-xxxx-xxxx, etc.
  // Capture sequences with 7+ digits ignoring separators.
  const phoneCandidate = raw.match(/(\+?\d[\d\s\-().]{6,}\d)/);
  if (phoneCandidate) {
    const digits = phoneCandidate[1].replace(/[^\d+]/g, "");
    if (digits.replace(/^\+/, "").length >= 7) out.phone = phoneCandidate[1].trim();
  }

  // URL — first http(s) or www.* match that isn't the email domain.
  const urlMatch = text.match(/(https?:\/\/[^\s,;]+|www\.[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}[^\s,;]*)/);
  if (urlMatch) out.url = urlMatch[0];

  // Company — common patterns: "at <Company>", "@ <Company>", "from <Company>", or a line that contains corp/inc/llc/co.
  const companyAt = text.match(/(?:\sat\s|\s@\s|\sfrom\s)([A-Z][\w.&'\- ]{1,40}?)(?=[,.;\n]|$)/);
  if (companyAt) out.company = companyAt[1].trim().replace(/\s+/g, " ");
  if (!out.company) {
    const corp = text.match(/\b([A-Z][\w.&'\- ]{1,40}?(?:\s(?:Inc|LLC|Co|Corp|Ltd|GmbH|SaaS|Studios?|Labs?|Group|Agency)\.?))\b/);
    if (corp) out.company = corp[1].trim();
  }

  // Title — common job titles before "at"/"@"/comma.
  const titlePat = /\b(CEO|CTO|CFO|COO|CMO|VP|Founder|Co-?Founder|Partner|Director|Manager|Engineer|Designer|Developer|Producer|Consultant|Owner|Principal|Head\s+of\s+[A-Z][a-zA-Z]+|Marketing\s+Lead|Sales\s+Lead|Account\s+Executive)\b/i;
  const titleMatch = text.match(titlePat);
  if (titleMatch) out.title = titleMatch[1];

  // Name — pick the first 2-4 capitalized tokens that don't look like a company.
  // Strategy: look at what's before the email or the first comma.
  let nameCandidate = "";
  if (out.email) {
    const idx = text.indexOf(out.email);
    nameCandidate = text.slice(0, idx).replace(/[<>"'(),;:|]/g, " ").trim();
  } else {
    nameCandidate = text.split(/[,;\n]/)[0] ?? "";
  }
  if (nameCandidate) {
    // Take leading capitalized words. e.g. "John Q. Smith" — up to 4 tokens, alpha.
    const tokens = nameCandidate.split(/\s+/).filter(Boolean);
    const namedTokens: string[] = [];
    for (const tok of tokens) {
      const isCap = /^[A-Z][a-zA-Z'.\-]*$/.test(tok);
      const isInitial = /^[A-Z]\.$/.test(tok);
      if (isCap || isInitial) namedTokens.push(tok);
      else if (namedTokens.length >= 2) break;
      if (namedTokens.length >= 4) break;
    }
    // Strip a leading "Mr/Mrs/Ms/Dr."
    while (namedTokens[0] && /^(Mr|Mrs|Ms|Dr)\.?$/.test(namedTokens[0])) namedTokens.shift();
    if (namedTokens.length >= 2) out.name = namedTokens.join(" ");
    else if (namedTokens.length === 1 && tokens.length <= 3) out.name = namedTokens[0];
  }

  // If name still empty but email is present, derive from local-part.
  if (!out.name && out.email) {
    const local = out.email.split("@")[0];
    const tokens = local.split(/[._\-+]/).filter((t) => /^[a-zA-Z]+$/.test(t));
    if (tokens.length > 0) {
      out.name = tokens
        .slice(0, 2)
        .map((t) => t[0].toUpperCase() + t.slice(1).toLowerCase())
        .join(" ");
    }
  }

  // Notes — anything substantive not already absorbed.
  const stripped = text
    .replace(out.email ?? "", "")
    .replace(out.phone ?? "", "")
    .replace(out.url ?? "", "")
    .replace(out.company ?? "", "")
    .replace(out.title ?? "", "")
    .replace(out.name ?? "", "")
    .replace(/^[\s,;:|]+|[\s,;:|]+$/g, "")
    .trim();
  if (stripped.length >= 40) out.notes = stripped;

  return out;
}

// Module-level state for the new-client modal's smart paste field.
// Lives outside ClientsState so we don't bloat the controller shape just
// for transient UI text. Keyed by "create" or "edit" if we ever extend.
let _newClientSmartText = "";
let _newClientPrefilled = new Set<string>();

function applyParsedToForm(state: AppViewState, cs: ClientsState, parsed: ParsedContact) {
  if (!cs.schema) {
    cs.formData = { ...cs.formData };
    if (parsed.name) cs.formData["Name"] = parsed.name;
    state.requestUpdate?.();
    return 0;
  }

  // Resolve which schema property each parsed field maps to.
  const schemaProps = cs.schema.properties;
  const findByType = (type: string): string | null => {
    for (const [name, p] of Object.entries(schemaProps)) if (p.type === type) return name;
    return null;
  };
  const findByName = (...needles: string[]): string | null => {
    const lower = needles.map((n) => n.toLowerCase());
    for (const [name] of Object.entries(schemaProps)) {
      const n = name.toLowerCase();
      if (lower.some((needle) => n.includes(needle))) return name;
    }
    return null;
  };

  const titleProp = getTitleProperty(cs.schema);
  const emailProp = findByType("email");
  const phoneProp = findByType("phone_number");
  const urlProp = findByType("url");
  const companyProp = findByName("company", "organization", "org", "biz");
  const titleProp2 = findByName("title", "role", "position", "job");
  const notesProp = findByName("notes", "note", "description", "comment", "context");

  cs.formData = { ...cs.formData };
  _newClientPrefilled = new Set();

  const setIf = (key: string | null, value: string | undefined) => {
    if (!key || !value) return;
    cs.formData[key] = value;
    _newClientPrefilled.add(key);
  };
  if (titleProp && parsed.name) setIf(titleProp, parsed.name);
  setIf(emailProp, parsed.email);
  setIf(phoneProp, parsed.phone);
  setIf(urlProp, parsed.url);
  setIf(companyProp, parsed.company);
  setIf(titleProp2, parsed.title);
  setIf(notesProp, parsed.notes);

  state.requestUpdate?.();
  return _newClientPrefilled.size;
}

// ── New Client / Edit Client modal (glassmorphism shell) ─────

function renderCreateDialog(state: AppViewState, cs: ClientsState, client: GatewayBrowserClient) {
  return renderClientModal(state, cs, client, /*mode*/ "create");
}

function renderClientModal(
  state: AppViewState,
  cs: ClientsState,
  client: GatewayBrowserClient,
  mode: "create" | "edit",
) {
  const titleProp = getTitleProperty(cs.schema);
  const hasName = titleProp ? !!String(cs.formData[titleProp] ?? "").trim() : true;
  const isEdit = mode === "edit";

  const closeIt = () => {
    if (isEdit) {
      cs.showEditDialog = false;
      cs.editingClient = null;
    } else {
      cs.showCreateDialog = false;
      _newClientSmartText = "";
      _newClientPrefilled = new Set();
    }
    cs.formData = {};
    state.requestUpdate?.();
  };

  const parsedPreview: string[] = [];
  if (_newClientSmartText.trim() && !isEdit) {
    const p = smartParseContact(_newClientSmartText);
    if (p.name) parsedPreview.push("name");
    if (p.email) parsedPreview.push("email");
    if (p.phone) parsedPreview.push("phone");
    if (p.url) parsedPreview.push("URL");
    if (p.company) parsedPreview.push("company");
    if (p.title) parsedPreview.push("title");
    if (p.notes) parsedPreview.push("notes");
  }

  return html`
    <div class="crm-nc-overlay" @click=${(e: Event) => { if (e.target === e.currentTarget) closeIt(); }}>
      <div class="crm-nc" role="dialog" aria-modal="true">
        <button class="crm-nc-close" @click=${closeIt} aria-label="Close">×</button>
        <header class="crm-nc-head">
          <span class="crm-nc-eyebrow">${isEdit ? "Edit Client" : "New Client"}</span>
          <h2 class="crm-nc-title">${isEdit ? "Update contact details" : "Add someone new to your CRM"}</h2>
          <p class="crm-nc-sub">
            ${isEdit
              ? "Refine the properties below. Changes save when you click Save."
              : "Paste a business card, email signature, or quick description — smart paste fills the form for you. Or just type it in."}
          </p>
        </header>

        <div class="crm-nc-body">
          ${!isEdit ? html`
            <section class="crm-nc-ai">
              <div class="crm-nc-ai-head">
                <span class="crm-nc-ai-title">
                  <span class="crm-nc-ai-spark"></span>
                  Smart paste
                </span>
                <span class="crm-nc-ai-hint">${parsedPreview.length > 0 ? `Detected: ${parsedPreview.join(" · ")}` : "Auto-detects name, email, phone, URL, company"}</span>
              </div>
              <textarea
                class="crm-nc-ai-textarea"
                placeholder=${"e.g. Jane Smith, Head of Marketing at Acme Corp · jane@acme.com · (555) 234-5678 · acme.com — met at SaaStr, interested in Q2 rollout"}
                .value=${_newClientSmartText}
                @input=${(e: Event) => {
                  _newClientSmartText = (e.target as HTMLTextAreaElement).value;
                  state.requestUpdate?.();
                }}
              ></textarea>
              <div class="crm-nc-ai-actions">
                ${parsedPreview.length > 0 ? html`
                  <span class="crm-nc-ai-results">
                    ✦ Will fill ${parsedPreview.length} field${parsedPreview.length === 1 ? "" : "s"}
                  </span>
                ` : html`<span></span>`}
                <div style="display:flex; gap:8px; align-items:center;">
                  ${_newClientSmartText ? html`
                    <button class="crm-nc-ai-clear"
                      @click=${() => { _newClientSmartText = ""; state.requestUpdate?.(); }}
                    >Clear</button>
                  ` : nothing}
                  <button
                    class="crm-nc-ai-fill"
                    ?disabled=${!_newClientSmartText.trim() || parsedPreview.length === 0}
                    @click=${() => {
                      const parsed = smartParseContact(_newClientSmartText);
                      const filled = applyParsedToForm(state, cs, parsed);
                      if (filled === 0) {
                        cs.error = "Couldn't extract anything new — try adding an email or phone number.";
                        state.requestUpdate?.();
                      }
                    }}
                  >✦ Auto-fill form</button>
                </div>
              </div>
            </section>
          ` : nothing}

          ${renderDynamicFormStylized(state, cs)}
        </div>

        <footer class="crm-nc-foot">
          <span class="crm-nc-foot-status">
            ${cs.saving
              ? "Saving…"
              : isEdit
                ? "Edits save when you click Save"
                : titleProp && hasName
                  ? `Ready to create "${cs.formData[titleProp]}"`
                  : "Add a name to enable Create"}
          </span>
          <div class="crm-nc-foot-actions">
            <button class="crm-btn" @click=${closeIt}>Cancel</button>
            <button
              class="crm-btn primary"
              ?disabled=${cs.saving || !hasName}
              @click=${() => isEdit ? updateClient(state, client) : createClient(state, client)}
            >${cs.saving ? (isEdit ? "Saving…" : "Creating…") : isEdit ? "Save" : "Create client →"}</button>
          </div>
        </footer>
      </div>
    </div>
  `;
}

// ── Edit Dialog ──────────────────────────────────────────────

function renderEditDialog(state: AppViewState, cs: ClientsState, client: GatewayBrowserClient) {
  return renderClientModal(state, cs, client, "edit");
}

// ── Dynamic Form ─────────────────────────────────────────────

// ── Stylized dynamic form (new glassmorphism inputs) ────────
// Mirrors renderDynamicForm but uses the new section/grid CSS, larger
// inputs, contextual placeholders, and per-field "prefilled" highlights
// driven by _newClientPrefilled (smart-paste afterglow).

function renderDynamicFormStylized(state: AppViewState, cs: ClientsState) {
  if (!cs.schema) {
    return html`
      <section class="crm-nc-section">
        <div class="crm-nc-section-head">Identity</div>
        <div class="crm-nc-grid">
          <div class="crm-nc-field crm-nc-field-wide">
            <label class="crm-nc-label">Name <span class="req">*</span></label>
            <input
              class="crm-nc-input ${_newClientPrefilled.has("Name") ? "is-prefilled" : ""}"
              type="text"
              placeholder="Jane Smith"
              .value=${cs.formData["Name"] || ""}
              @input=${(e: Event) => {
                cs.formData = { ...cs.formData, Name: (e.target as HTMLInputElement).value };
                state.requestUpdate?.();
              }}
            />
          </div>
        </div>
      </section>
    `;
  }

  // Group schema fields into sections.
  type Entry = [string, NotionPropertySchema];
  const buckets: { title: string; entries: Entry[]; hint?: string }[] = [
    { title: "Identity", entries: [], hint: "Who is this client?" },
    { title: "Contact", entries: [], hint: "How to reach them" },
    { title: "Status & Tags", entries: [] },
    { title: "Financial & Dates", entries: [] },
    { title: "Notes & Context", entries: [], hint: "Long-form fields" },
    { title: "Other", entries: [] },
  ];
  const titleIdx = 0, contactIdx = 1, statusIdx = 2, financeIdx = 3, notesIdx = 4, otherIdx = 5;
  const skipFormTypes = new Set(["files", "created_time", "button"]);

  for (const [propName, prop] of Object.entries(cs.schema.properties)) {
    if (propName.startsWith("_")) continue; // hidden meta fields
    if (skipFormTypes.has(prop.type)) continue;
    const ln = propName.toLowerCase();
    const looksLikeNameField = prop.type === "title" || ln === "name" || ln === "client" || ln === "contact";
    const looksLikeCompany = ln.includes("company") || ln.includes("organization") || ln === "org";
    const looksLikeJobTitle = ln === "title" || ln.includes("role") || ln.includes("position") || ln.includes("job");
    switch (prop.type) {
      case "title":
        buckets[titleIdx].entries.push([propName, prop]);
        break;
      case "email":
      case "phone_number":
      case "url":
        buckets[contactIdx].entries.push([propName, prop]);
        break;
      case "select":
      case "status":
      case "multi_select":
      case "checkbox":
        buckets[statusIdx].entries.push([propName, prop]);
        break;
      case "number":
      case "date":
        buckets[financeIdx].entries.push([propName, prop]);
        break;
      case "rich_text":
        if (looksLikeCompany || looksLikeJobTitle) {
          buckets[titleIdx].entries.push([propName, prop]);
        } else {
          buckets[notesIdx].entries.push([propName, prop]);
        }
        break;
      default:
        if (looksLikeNameField) buckets[titleIdx].entries.push([propName, prop]);
        else buckets[otherIdx].entries.push([propName, prop]);
    }
  }

  const placeholderFor = (propName: string, prop: NotionPropertySchema): string => {
    const ln = propName.toLowerCase();
    if (prop.type === "email" || ln.includes("email")) return "jane@company.com";
    if (prop.type === "phone_number" || ln.includes("phone")) return "+1 (555) 234-5678";
    if (prop.type === "url" || ln.includes("url") || ln.includes("website")) return "https://example.com";
    if (prop.type === "title" || ln === "name" || ln === "client") return "Jane Smith";
    if (ln.includes("company") || ln.includes("organization")) return "Acme Corp";
    if (ln === "title" || ln.includes("role") || ln.includes("position")) return "Head of Marketing";
    if (ln.includes("note") || ln.includes("context") || ln.includes("description"))
      return "Anything you'd want to remember — context, history, follow-ups…";
    if (prop.type === "number") return "0";
    return propName;
  };

  const renderField = ([propName, prop]: Entry) => {
    const val = cs.formData[propName];
    const prefilled = _newClientPrefilled.has(propName);
    const isTitle = prop.type === "title";
    const wide =
      prop.type === "rich_text" ||
      prop.type === "multi_select" ||
      (typeof propName === "string" && propName.toLowerCase().includes("address"));

    const setVal = (v: unknown) => {
      cs.formData = { ...cs.formData, [propName]: v };
      state.requestUpdate?.();
    };

    switch (prop.type) {
      case "title":
      case "url":
      case "email":
      case "phone_number":
        return html`
          <div class="crm-nc-field ${wide ? "crm-nc-field-wide" : ""}">
            <label class="crm-nc-label">${propName} ${isTitle ? html`<span class="req">*</span>` : nothing}</label>
            <input
              class="crm-nc-input ${prefilled ? "is-prefilled" : ""}"
              type=${prop.type === "email" ? "email" : prop.type === "url" ? "url" : prop.type === "phone_number" ? "tel" : "text"}
              placeholder=${placeholderFor(propName, prop)}
              .value=${val ?? ""}
              @input=${(e: Event) => setVal((e.target as HTMLInputElement).value)}
            />
          </div>
        `;
      case "rich_text":
        return html`
          <div class="crm-nc-field crm-nc-field-wide">
            <label class="crm-nc-label">${propName}</label>
            <textarea
              class="crm-nc-textarea ${prefilled ? "is-prefilled" : ""}"
              placeholder=${placeholderFor(propName, prop)}
              .value=${val ?? ""}
              @input=${(e: Event) => setVal((e.target as HTMLTextAreaElement).value)}
            ></textarea>
          </div>
        `;
      case "select":
      case "status": {
        const opts = prop.options ?? [];
        return html`
          <div class="crm-nc-field">
            <label class="crm-nc-label">${propName}</label>
            <select class="crm-nc-select ${prefilled ? "is-prefilled" : ""}"
              .value=${val ?? ""}
              @change=${(e: Event) => setVal((e.target as HTMLSelectElement).value || null)}
            >
              <option value="">— pick one —</option>
              ${opts.map((o) => html`<option value=${o.name} ?selected=${o.name === val}>${o.name}</option>`)}
            </select>
          </div>
        `;
      }
      case "multi_select": {
        const opts = prop.options ?? [];
        const arr: string[] = Array.isArray(val) ? val : [];
        return html`
          <div class="crm-nc-field crm-nc-field-wide">
            <label class="crm-nc-label">${propName}</label>
            <div class="crm-nc-multi">
              ${opts.length === 0 ? html`<span class="crm-nc-hint">No options defined in schema.</span>` : nothing}
              ${opts.map((o) => {
                const on = arr.includes(o.name);
                return html`
                  <button
                    type="button"
                    class="crm-nc-chip ${on ? "is-selected" : ""}"
                    style="color:${notionColor(o.color)}; border-color:${notionColor(o.color)}40; background:${on ? notionBg(o.color) : "transparent"};"
                    @click=${() => setVal(on ? arr.filter((x) => x !== o.name) : [...arr, o.name])}
                  >${o.name}</button>
                `;
              })}
            </div>
          </div>
        `;
      }
      case "checkbox":
        return html`
          <div class="crm-nc-field">
            <label class="crm-nc-checkbox-row">
              <input type="checkbox" .checked=${!!val}
                @change=${(e: Event) => setVal((e.target as HTMLInputElement).checked)} />
              <span>${propName}</span>
            </label>
          </div>
        `;
      case "number":
        return html`
          <div class="crm-nc-field">
            <label class="crm-nc-label">${propName}</label>
            <input class="crm-nc-input ${prefilled ? "is-prefilled" : ""}" type="number"
              placeholder=${placeholderFor(propName, prop)}
              .value=${val == null ? "" : String(val)}
              @input=${(e: Event) => {
                const s = (e.target as HTMLInputElement).value.trim();
                setVal(s === "" ? null : Number(s));
              }}
            />
          </div>
        `;
      case "date":
        return html`
          <div class="crm-nc-field">
            <label class="crm-nc-label">${propName}</label>
            <input class="crm-nc-input ${prefilled ? "is-prefilled" : ""}" type="date"
              .value=${val ? new Date(val).toISOString().slice(0, 10) : ""}
              @change=${(e: Event) => {
                const s = (e.target as HTMLInputElement).value;
                setVal(s ? new Date(s).toISOString() : null);
              }}
            />
          </div>
        `;
      default:
        return html`
          <div class="crm-nc-field ${wide ? "crm-nc-field-wide" : ""}">
            <label class="crm-nc-label">${propName}</label>
            <input class="crm-nc-input ${prefilled ? "is-prefilled" : ""}" type="text"
              placeholder=${placeholderFor(propName, prop)}
              .value=${val ?? ""}
              @input=${(e: Event) => setVal((e.target as HTMLInputElement).value)}
            />
          </div>
        `;
    }
  };

  const renderSocialFormField = (p: typeof SOCIAL_PLATFORMS[number]) => {
    const val = cs.formData[p.key] ?? "";
    const placeholder =
      p.key === "WhatsApp" ? "+1 555 000 0000"
      : p.key === "Telegram" ? "@username"
      : p.key === "Discord" ? "user#1234"
      : p.key === "Instagram" ? "@handle"
      : p.key === "Phone" ? "+1 555 000 0000"
      : "email@example.com";
    return html`
      <div class="crm-nc-social-field">
        <label class="crm-nc-social-label">
          ${unsafeHTML(p.icon.replace('width="20" height="20"', 'width="16" height="16"'))}
          ${p.label}
        </label>
        <input
          class="crm-nc-social-input"
          type="text"
          placeholder=${placeholder}
          .value=${val}
          @input=${(e: Event) => {
            cs.formData = { ...cs.formData, [p.key]: (e.target as HTMLInputElement).value };
            state.requestUpdate?.();
          }}
        />
      </div>
    `;
  };

  return html`
    ${buckets.map((b) => b.entries.length === 0 ? nothing : html`
      <section class="crm-nc-section">
        <div class="crm-nc-section-head">
          <span>${b.title}</span>
          <span class="badge-count">${b.entries.length}</span>
          ${b.hint ? html`<span class="badge-count" style="margin-left:auto; text-transform:none; letter-spacing:0;">${b.hint}</span>` : nothing}
        </div>
        <div class="crm-nc-grid">
          ${b.entries.map(renderField)}
        </div>
      </section>
    `)}
    <section class="crm-nc-section">
      <div class="crm-nc-social-divider">
        <div class="crm-nc-social-divider-line"></div>
        <span class="crm-nc-social-divider-label">Contact &amp; Socials</span>
        <div class="crm-nc-social-divider-line"></div>
      </div>
      <div class="crm-nc-socials-grid">
        ${SOCIAL_PLATFORMS.map(renderSocialFormField)}
      </div>
    </section>
  `;
}

function renderDynamicForm(state: AppViewState, cs: ClientsState) {
  if (!cs.schema) {
    // Fallback: simple name field
    return html`
      <div class="crm-form-group">
        <label class="crm-form-label">NAME *</label>
        <input class="crm-form-input" type="text" placeholder="Client name"
          .value=${cs.formData["Name"] || ""}
          @input=${(e: Event) => { cs.formData = { ...cs.formData, Name: (e.target as HTMLInputElement).value }; state.requestUpdate?.(); }} />
      </div>
    `;
  }

  // Group form fields: title first, then by type
  const titleFields: [string, NotionPropertySchema][] = [];
  const contactFields: [string, NotionPropertySchema][] = [];
  const selectFields: [string, NotionPropertySchema][] = [];
  const textFields: [string, NotionPropertySchema][] = [];
  const numberFields: [string, NotionPropertySchema][] = [];
  const dateFields: [string, NotionPropertySchema][] = [];
  const checkboxFields: [string, NotionPropertySchema][] = [];

  const skipFormTypes = new Set(["files", "created_time", "button"]);

  for (const [propName, prop] of Object.entries(cs.schema.properties)) {
    if (skipFormTypes.has(prop.type)) continue;
    switch (prop.type) {
      case "title": titleFields.push([propName, prop]); break;
      case "email": case "phone_number": case "url": contactFields.push([propName, prop]); break;
      case "select": case "status": case "multi_select": selectFields.push([propName, prop]); break;
      case "rich_text": textFields.push([propName, prop]); break;
      case "number": numberFields.push([propName, prop]); break;
      case "date": dateFields.push([propName, prop]); break;
      case "checkbox": checkboxFields.push([propName, prop]); break;
    }
  }

  const renderField = ([propName, prop]: [string, NotionPropertySchema]) => {
    const val = cs.formData[propName];

    switch (prop.type) {
      case "title":
        return html`
          <div class="crm-form-group">
            <label class="crm-form-label">${propName} *</label>
            <input class="crm-form-input" type="text" placeholder="${propName}"
              .value=${val || ""}
              @input=${(e: Event) => { cs.formData = { ...cs.formData, [propName]: (e.target as HTMLInputElement).value }; state.requestUpdate?.(); }} />
          </div>
        `;

      case "rich_text": {
        // Use textarea for long-form fields
        const longFields = new Set(["Notes", "Lead/Company Research", "Challenges", "Support History", "Interest"]);
        const isLong = longFields.has(propName) || propName.toLowerCase().includes("notes") || propName.toLowerCase().includes("research");
        if (isLong) {
          return html`
            <div class="crm-form-group">
              <label class="crm-form-label">${propName}</label>
              <textarea class="crm-form-textarea" placeholder="${propName}"
                .value=${val || ""}
                @input=${(e: Event) => { cs.formData = { ...cs.formData, [propName]: (e.target as HTMLTextAreaElement).value }; state.requestUpdate?.(); }}></textarea>
            </div>
          `;
        }
        return html`
          <div class="crm-form-group">
            <label class="crm-form-label">${propName}</label>
            <input class="crm-form-input" type="text" placeholder="${propName}"
              .value=${val || ""}
              @input=${(e: Event) => { cs.formData = { ...cs.formData, [propName]: (e.target as HTMLInputElement).value }; state.requestUpdate?.(); }} />
          </div>
        `;
      }

      case "email":
        return html`
          <div class="crm-form-group">
            <label class="crm-form-label">${propName}</label>
            <input class="crm-form-input" type="email" placeholder="email@example.com"
              .value=${val || ""}
              @input=${(e: Event) => { cs.formData = { ...cs.formData, [propName]: (e.target as HTMLInputElement).value }; state.requestUpdate?.(); }} />
          </div>
        `;

      case "phone_number":
        return html`
          <div class="crm-form-group">
            <label class="crm-form-label">${propName}</label>
            <input class="crm-form-input" type="tel" placeholder="+1 234 567 890"
              .value=${val || ""}
              @input=${(e: Event) => { cs.formData = { ...cs.formData, [propName]: (e.target as HTMLInputElement).value }; state.requestUpdate?.(); }} />
          </div>
        `;

      case "url":
        return html`
          <div class="crm-form-group">
            <label class="crm-form-label">${propName}</label>
            <input class="crm-form-input" type="url" placeholder="https://..."
              .value=${val || ""}
              @input=${(e: Event) => { cs.formData = { ...cs.formData, [propName]: (e.target as HTMLInputElement).value }; state.requestUpdate?.(); }} />
          </div>
        `;

      case "number":
        return html`
          <div class="crm-form-group">
            <label class="crm-form-label">${propName}</label>
            <input class="crm-form-input" type="number" placeholder="0"
              .value=${val ?? ""}
              @input=${(e: Event) => {
                const v = (e.target as HTMLInputElement).value;
                cs.formData = { ...cs.formData, [propName]: v ? parseFloat(v) : null };
                state.requestUpdate?.();
              }} />
          </div>
        `;

      case "date":
        return html`
          <div class="crm-form-group">
            <label class="crm-form-label">${propName}</label>
            <input class="crm-form-input" type="date"
              .value=${val ? String(val).slice(0, 10) : ""}
              @input=${(e: Event) => { cs.formData = { ...cs.formData, [propName]: (e.target as HTMLInputElement).value || null }; state.requestUpdate?.(); }} />
          </div>
        `;

      case "select": case "status":
        return html`
          <div class="crm-form-group">
            <label class="crm-form-label">${propName}</label>
            <select class="crm-form-input" style="cursor:pointer;"
              @change=${(e: Event) => { cs.formData = { ...cs.formData, [propName]: (e.target as HTMLSelectElement).value || null }; state.requestUpdate?.(); }}>
              <option value="" ?selected=${!val}>— Select —</option>
              ${(prop.options ?? []).map((o) => html`
                <option value="${o.name}" ?selected=${val === o.name}>${o.name}</option>
              `)}
            </select>
          </div>
        `;

      case "multi_select": {
        const tags: string[] = Array.isArray(val) ? val : [];
        return html`
          <div class="crm-form-group">
            <label class="crm-form-label">${propName}</label>
            <input class="crm-form-input" type="text" placeholder="Type and press Enter"
              list="dl-${propName.replace(/\s/g, '-')}"
              @keydown=${(e: KeyboardEvent) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  const input = e.target as HTMLInputElement;
                  const tag = input.value.trim();
                  if (tag && !tags.includes(tag)) {
                    cs.formData = { ...cs.formData, [propName]: [...tags, tag] };
                    input.value = "";
                    state.requestUpdate?.();
                  }
                }
              }} />
            <datalist id="dl-${propName.replace(/\s/g, '-')}">
              ${(prop.options ?? []).filter((o) => !tags.includes(o.name)).map((o) => html`<option value="${o.name}">`)}
            </datalist>
            ${tags.length > 0 ? html`
              <div class="crm-form-tags">
                ${tags.map((t) => html`
                  <span class="crm-form-tag">
                    ${t}
                    <button class="crm-form-tag-remove" @click=${() => {
                      cs.formData = { ...cs.formData, [propName]: tags.filter((x) => x !== t) };
                      state.requestUpdate?.();
                    }}>✕</button>
                  </span>
                `)}
              </div>
            ` : nothing}
          </div>
        `;
      }

      case "checkbox":
        return html`
          <div class="crm-form-group" style="display:flex;align-items:center;gap:8px;">
            <input type="checkbox" ?checked=${!!val}
              @change=${(e: Event) => { cs.formData = { ...cs.formData, [propName]: (e.target as HTMLInputElement).checked }; state.requestUpdate?.(); }} />
            <label class="crm-form-label" style="margin-bottom:0;">${propName}</label>
          </div>
        `;

      default:
        return nothing;
    }
  };

  // Render groups of fields in rows where appropriate
  return html`
    ${titleFields.map(renderField)}
    ${contactFields.length > 0 ? html`
      <div class="crm-form-row">${contactFields.slice(0, 2).map(renderField)}</div>
      ${contactFields.length > 2 ? contactFields.slice(2).map(renderField) : nothing}
    ` : nothing}
    ${selectFields.length > 0 ? html`
      ${selectFields.length >= 2 ? html`
        <div class="crm-form-row">${selectFields.slice(0, 2).map(renderField)}</div>
        ${selectFields.slice(2).map(renderField)}
      ` : selectFields.map(renderField)}
    ` : nothing}
    ${numberFields.length > 0 ? html`
      <div class="crm-form-row">${numberFields.slice(0, 2).map(renderField)}</div>
      ${numberFields.slice(2).map(renderField)}
    ` : nothing}
    ${dateFields.map(renderField)}
    ${textFields.map(renderField)}
    ${checkboxFields.map(renderField)}
  `;
}

// ── Delete Confirm ───────────────────────────────────────────

function renderDeleteConfirm(state: AppViewState, cs: ClientsState, client: GatewayBrowserClient) {
  const c = cs.clients.find((x) => x.id === cs.showDeleteConfirm);
  const name = c ? getClientName(c, cs.schema) : "this client";

  return html`
    <div class="crm-dialog-overlay" @click=${(e: Event) => { if (e.target === e.currentTarget) { cs.showDeleteConfirm = null; state.requestUpdate?.(); } }}>
      <div class="crm-dialog" style="width:380px;">
        <div class="crm-dialog-title" style="color:#f87171;">◇ DELETE CLIENT</div>
        <div style="font-size:11px;color:#a1a1aa;margin-bottom:16px;">
          Delete <strong style="color:#e4e4e7;">${name}</strong>? This cannot be undone.
        </div>
        <div class="crm-dialog-actions">
          <button class="crm-btn" @click=${() => { cs.showDeleteConfirm = null; state.requestUpdate?.(); }}>CANCEL</button>
          <button class="crm-btn danger" @click=${() => { if (cs.showDeleteConfirm) deleteClient(state, client, cs.showDeleteConfirm); }}>DELETE</button>
        </div>
      </div>
    </div>
  `;
}

// ── Import Dialog (CSV / JSON / vCard) ──────────────────────
//
// Pasting is the primary path; file-picker is secondary because most users
// will be coming from a Google Contacts / Apple Contacts export, where
// download → drag & drop is faster than copy/paste of a 50KB file.

function renderImportDialog(state: AppViewState, cs: ClientsState, client: GatewayBrowserClient) {
  const close = () => { cs.showImportDialog = false; state.requestUpdate?.(); };
  const fmt = cs.importFormat;

  const placeholders: Record<typeof fmt, string> = {
    csv:
      "Name,Email,Phone,Company\nAda Lovelace,ada@example.com,555-0100,Analytical Engines\nGrace Hopper,grace@example.com,555-0101,UNIVAC",
    json:
      `[\n  { "Name": "Ada Lovelace", "Email": "ada@example.com" },\n  { "Name": "Grace Hopper", "Email": "grace@example.com" }\n]`,
    vcard:
      "BEGIN:VCARD\nVERSION:3.0\nFN:Ada Lovelace\nEMAIL:ada@example.com\nTEL:555-0100\nORG:Analytical Engines\nEND:VCARD",
  };

  const acceptByFormat: Record<typeof fmt, string> = {
    csv: ".csv,text/csv",
    json: ".json,application/json",
    vcard: ".vcf,.vcard,text/vcard",
  };

  const onFile = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      cs.importDataText = text;
      // Best-effort: pick the format from the file extension if the user
      // hasn't explicitly chosen one.
      const lower = file.name.toLowerCase();
      if (lower.endsWith(".csv")) cs.importFormat = "csv";
      else if (lower.endsWith(".json")) cs.importFormat = "json";
      else if (lower.endsWith(".vcf") || lower.endsWith(".vcard")) cs.importFormat = "vcard";
      state.requestUpdate?.();
    } catch (err) {
      cs.error = err instanceof Error ? err.message : String(err);
      state.requestUpdate?.();
    }
  };

  const startImport = () => {
    void importClientsFromText(state, client, cs.importFormat, cs.importDataText);
  };

  const formatBtn = (key: typeof fmt, label: string, hint: string) => html`
    <button
      class="crm-btn ${cs.importFormat === key ? "primary" : ""}"
      style="flex:1;display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:10px 12px;text-align:left;"
      @click=${() => { cs.importFormat = key; state.requestUpdate?.(); }}
      title=${hint}
    >
      <span style="font-size:11px;font-weight:700;letter-spacing:0.06em;">${label}</span>
      <span style="font-size:9px;color:#a1a1aa;font-weight:500;">${hint}</span>
    </button>
  `;

  return html`
    <div class="crm-dialog-overlay" @click=${(e: Event) => { if (e.target === e.currentTarget) close(); }}>
      <div class="crm-dialog" style="width:560px;max-width:95vw;">
        <div class="crm-dialog-title">◇ IMPORT CLIENTS</div>
        <div style="font-size:11px;color:#a1a1aa;margin-bottom:12px;">
          Imports straight into this business. Existing clients are not
          touched. After importing you can run "↺ Push" if you want the
          rows mirrored to Notion.
        </div>

        <div style="display:flex;gap:6px;margin-bottom:12px;">
          ${formatBtn("csv", "CSV", "Spreadsheets, Google Contacts export")}
          ${formatBtn("json", "JSON", "Array of objects, or { clients: [...] }")}
          ${formatBtn("vcard", "vCard", "Apple Contacts / phone export (.vcf)")}
        </div>

        <label style="display:flex;flex-direction:column;gap:6px;font-size:10px;color:#a78bfa;letter-spacing:0.05em;">
          <span>FILE (optional — paste below if you prefer)</span>
          <input
            type="file"
            accept=${acceptByFormat[fmt]}
            @change=${onFile}
            style="font-size:11px;color:#ddd;background:rgba(167,139,250,0.04);padding:6px;border-radius:4px;border:1px solid rgba(167,139,250,0.18);"
          />
        </label>

        <label style="display:flex;flex-direction:column;gap:6px;font-size:10px;color:#a78bfa;letter-spacing:0.05em;margin-top:10px;">
          <span>${fmt.toUpperCase()} CONTENT</span>
          <textarea
            placeholder=${placeholders[fmt]}
            .value=${cs.importDataText}
            @input=${(e: Event) => { cs.importDataText = (e.target as HTMLTextAreaElement).value; state.requestUpdate?.(); }}
            style="height:200px;background:rgba(0,0,0,0.3);border:1px solid rgba(167,139,250,0.18);border-radius:6px;padding:10px;color:#e4e4e7;font-family:ui-monospace,monospace;font-size:11px;resize:vertical;outline:none;"
          ></textarea>
        </label>

        ${fmt === "csv" ? html`
          <div style="font-size:10px;color:#71717a;margin-top:6px;line-height:1.5;">
            CSV column headers map directly to client properties. Common
            names like Name, Email, Phone, Company, Status, Notes pick up
            their schema automatically when a Notion DB is connected.
          </div>
        ` : nothing}
        ${fmt === "vcard" ? html`
          <div style="font-size:10px;color:#71717a;margin-top:6px;line-height:1.5;">
            Reads FN/N, EMAIL, TEL, ORG, TITLE, NOTE, ADR, URL. Multiple
            values for the same field (e.g. several emails) are joined
            with a semicolon.
          </div>
        ` : nothing}
        ${fmt === "json" ? html`
          <div style="font-size:10px;color:#71717a;margin-top:6px;line-height:1.5;">
            Accepts a top-level array of objects, or
            <span class="mono">{ "clients": [...] }</span>. Each object's
            keys become CRM property names.
          </div>
        ` : nothing}

        ${cs.importLastResult ? html`
          <div style="margin-top:10px;padding:8px 10px;background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.25);border-radius:6px;font-size:11px;color:#86efac;">
            Imported ${cs.importLastResult.imported} of ${cs.importLastResult.total}
            ${cs.importLastResult.skipped > 0 ? html`<span style="color:#fbbf24;"> · ${cs.importLastResult.skipped} skipped</span>` : nothing}
          </div>
        ` : nothing}

        <div class="crm-dialog-actions" style="margin-top:14px;">
          <button class="crm-btn" @click=${close}>CANCEL</button>
          <button
            class="crm-btn primary"
            ?disabled=${cs.importBusy || !cs.importDataText.trim()}
            @click=${startImport}
          >
            ${cs.importBusy ? "IMPORTING…" : "IMPORT"}
          </button>
        </div>
      </div>
    </div>
  `;
}

// ── Helpers ──────────────────────────────────────────────────

function openEditDialog(state: AppViewState, cs: ClientsState, c: DynamicClientRecord) {
  cs.editingClient = c;
  cs.formData = { ...c.data };
  cs.showEditDialog = true;
  state.requestUpdate?.();
}
