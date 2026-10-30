/**
 * /apps page — Apps & Sites Registry.
 *
 * Cards across the page show every app, site, project, directory the
 * operator has built. Filters by type / business / featured. Each card
 * shows source pill (where it came from), linked business + directory,
 * and quick actions: open URL, edit, feature, delete.
 *
 * Operator workflows:
 *   • Backfill once on first load to mirror existing kanban projects,
 *     directories, compositions, storyboards, landing pages.
 *   • Add manual entries (e.g. an external Vercel deployment) via the
 *     Add app dialog.
 *   • Featured apps surface on a future home dashboard widget.
 *   • Edit any app to assign it to a business or directory — the link
 *     surfaces the entry on the business's command center.
 */

import { html, nothing } from "lit";
import type { GatewayBrowserClient } from "../gateway";
import {
  ensureSystemGlass,
  sgAurora,
  sgEmpty,
  sgGloss,
  sgHero,
  sgIcon,
  sgLed,
  sgSkeleton,
  type SgIconName,
} from "./system-glass";
import {
  type App,
  type AppType,
  type AppsState,
  createInitialAppsState,
  loadApps,
  createApp,
  updateApp,
  deleteApp,
  toggleFeatured,
  backfillRegistry,
  setFilterType,
  setFilterBusiness,
  setFilterFeatured,
  setSearch,
  openCreate,
  closeCreate,
  updateCreateField,
  openEdit,
  closeEdit,
  patchEdit,
} from "../controllers/apps";

interface AppsHost {
  apps?: AppsState;
  client: GatewayBrowserClient | null;
  /** Optional list of businesses for filter + edit dropdowns. */
  businessState?: { businesses?: Array<{ id: string; name: string }> };
  setTab?: (tab: string) => void;
  requestUpdate?: () => void;
}

export function ensureAppsState<T extends AppsHost>(state: T): AppsState {
  if (!state.apps) state.apps = createInitialAppsState();
  return state.apps;
}

let _autoLoaded = false;

export function renderApps<T extends AppsHost>(state: T, client: GatewayBrowserClient) {
  const as = ensureAppsState(state);
  if (!_autoLoaded) {
    _autoLoaded = true;
    void loadApps(state as never, client);
  }
  ensureSystemGlass();
  injectStyles();

  const businesses = state.businessState?.businesses ?? [];
  const search = as.search.trim().toLowerCase();
  const filtered = !search
    ? as.apps
    : as.apps.filter((a) =>
        [a.name, a.description, a.url ?? "", ...a.tags].some((s) => s.toLowerCase().includes(search)),
      );
  const types: Array<{ id: AppType | "all"; label: string }> = [
    { id: "all", label: "All" },
    { id: "web-app", label: "Web apps" },
    { id: "landing-page", label: "Landing pages" },
    { id: "project", label: "Projects" },
    { id: "directory", label: "Directories" },
    { id: "composition", label: "Compositions" },
    { id: "storyboard", label: "Storyboards" },
    { id: "mobile-app", label: "Mobile" },
    { id: "other", label: "Other" },
  ];
  const featuredCount = as.apps.filter((a) => a.featured).length;
  const liveCount = as.apps.filter((a) => a.url).length;
  const linkedCount = as.apps.filter((a) => a.businessId).length;
  const filtersActive = as.filterType !== "all" || !!as.filterBusiness || as.filterFeatured;
  const loadingFirst = as.loading && as.apps.length === 0;

  return html`
    <div class="sg-page sg-apps apps-page">
      ${sgAurora()}
      ${sgHero({
        eyebrow: "Registry",
        title: "Apps",
        accent: "& Sites",
        icon: "apps",
        sub: "Every app, site, project, and directory you've built — one place to find them, link them to a business, feature the active ones. New projects and directories register here automatically.",
        status: as.loading
          ? { tone: "info", label: "Syncing" }
          : as.error
            ? { tone: "bad", label: "Error" }
            : { tone: "ok", label: "Registry live" },
        actions: html`
          <button class="sg-btn apps-btn apps-btn-ghost" @click=${() => loadApps(state as never, client)}>${sgIcon("refresh", 15)} Refresh</button>
          <button class="sg-btn apps-btn apps-btn-ghost" ?disabled=${as.busy} @click=${() => void backfillRegistry(state as never, client)}>${sgIcon("bolt", 15)} Backfill</button>
          <button class="sg-btn sg-btn--primary apps-btn apps-btn-primary" @click=${() => openCreate(state as never)}>${sgIcon("plus", 15)} Add app</button>
        `,
        stats: [
          { label: filtersActive ? "Matching" : "In registry", value: loadingFirst ? "—" : as.apps.length, icon: "apps", foot: filtersActive ? "With current filters" : "Apps, sites & projects" },
          { label: "Featured", value: loadingFirst ? "—" : featuredCount, icon: "spark", tone: featuredCount > 0 ? "gold" : undefined, foot: "Dashboard spotlight" },
          { label: "Live URLs", value: loadingFirst ? "—" : liveCount, icon: "globe", foot: "Openable links" },
          { label: "Linked", value: loadingFirst ? "—" : linkedCount, icon: "link", foot: "Assigned to a business" },
        ],
      })}

      ${as.error ? html`<div class="apps-banner apps-banner-error" role="alert">${sgIcon("alert", 15)}<span>${as.error}</span></div>` : nothing}
      ${as.success ? html`<div class="apps-banner apps-banner-success" role="status">${sgIcon("check", 15)}<span>${as.success}</span></div>` : nothing}

      <div class="apps-filters sg-panel">
        <div class="apps-filter-top">
          <label class="apps-search-wrap">
            ${sgIcon("search", 15)}
            <input
              type="text"
              class="sg-input apps-search"
              placeholder="Search by name, description, tag, URL…"
              aria-label="Search apps"
              .value=${as.search}
              @input=${(e: Event) => setSearch(state as never, (e.target as HTMLInputElement).value)}
            />
          </label>
          <div class="apps-filter-group">
            ${businesses.length > 0 ? html`
              <select
                class="sg-input apps-select"
                aria-label="Filter by business"
                .value=${as.filterBusiness}
                @change=${(e: Event) => {
                  setFilterBusiness(state as never, (e.target as HTMLSelectElement).value);
                  void loadApps(state as never, client);
                }}
              >
                <option value="">All businesses</option>
                ${businesses.map((b) => html`<option value=${b.id}>${b.name}</option>`)}
              </select>
            ` : nothing}
            <label class="apps-checkbox">
              <input
                type="checkbox"
                class="apps-switch"
                role="switch"
                .checked=${as.filterFeatured}
                @change=${(e: Event) => {
                  setFilterFeatured(state as never, (e.target as HTMLInputElement).checked);
                  void loadApps(state as never, client);
                }}
              />
              <span>Featured only</span>
            </label>
          </div>
        </div>
        <div class="sg-seg apps-seg" role="group" aria-label="Filter by type">
          ${types.map((t) => html`
            <button
              class="apps-chip ${as.filterType === t.id ? "active" : ""}"
              aria-pressed=${as.filterType === t.id ? "true" : "false"}
              @click=${() => { setFilterType(state as never, t.id); void loadApps(state as never, client); }}
            >${t.id !== "all" ? sgIcon(typeIcon(t.id), 13) : nothing}${t.label}</button>
          `)}
        </div>
      </div>

      ${as.loading && as.apps.length === 0
        ? html`<div class="apps-grid">${[0, 1, 2, 3, 4, 5].map(() => html`<span class="sg-skel sg-skel--block apps-skel"></span>`)}</div>`
        : as.loading
          ? html`<div class="apps-loading">${sgSkeleton(1)}</div>${renderGrid(state, client, filtered, businesses)}`
          : filtered.length === 0
            ? html`
                <div class="apps-empty sg-panel">
                  ${sgEmpty({
                    icon: as.apps.length === 0 ? "apps" : "search",
                    title: as.apps.length === 0 ? "Nothing in the registry yet." : "No apps match your filters.",
                    body: as.apps.length === 0
                      ? "Backfill mirrors your existing kanban projects, directories, compositions, storyboards and landing pages in one go — or add an external deployment by hand."
                      : "Try a different type, clear the search, or switch off “Featured only”.",
                    action: as.apps.length === 0
                      ? html`<div class="sg-actions apps-empty-actions">
                          <button class="sg-btn sg-btn--primary apps-btn apps-btn-primary" @click=${() => void backfillRegistry(state as never, client)}>${sgIcon("bolt", 15)} Backfill from existing projects</button>
                          <button class="sg-btn apps-btn" @click=${() => openCreate(state as never)}>${sgIcon("plus", 15)} Add manually</button>
                        </div>`
                      : undefined,
                  })}
                </div>
              `
            : renderGrid(state, client, filtered, businesses)}

      ${as.showCreate ? renderCreateDialog(state, client) : nothing}
      ${as.editApp ? renderEditDialog(state, client, businesses) : nothing}
    </div>
  `;
}

function renderGrid<T extends AppsHost>(
  state: T,
  client: GatewayBrowserClient,
  apps: App[],
  businesses: Array<{ id: string; name: string }>,
) {
  return html`<div class="apps-grid">${apps.map((a) => renderAppCard(state, client, a, businesses))}</div>`;
}

// ── Cards + dialogs ─────────────────────────────────────────

const STAR = (filled: boolean) => html`<svg class="sg-ico" width="14" height="14" viewBox="0 0 24 24" fill=${filled ? "currentColor" : "none"}
  stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 2.7 5.6 6.1.8-4.5 4.3 1.1 6.1L12 16.9l-5.4 2.9 1.1-6.1-4.5-4.3 6.1-.8L12 3Z"/></svg>`;

function typeIcon(t: AppType): SgIconName {
  switch (t) {
    case "web-app": return "globe";
    case "landing-page": return "file";
    case "project": return "grid";
    case "directory": return "database";
    case "composition": return "play";
    case "storyboard": return "layers";
    case "mobile-app": return "phone";
    default: return "apps";
  }
}

function renderAppCard<T extends AppsHost>(
  state: T,
  client: GatewayBrowserClient,
  app: App,
  businesses: Array<{ id: string; name: string }>,
) {
  const businessName = app.businessId ? businesses.find((b) => b.id === app.businessId)?.name : null;
  const led = app.status === "archived" ? "off" : app.status === "draft" ? "warn" : "ok";
  return html`
    <div class="apps-card sg-card sg-card--interactive ${app.featured ? "featured" : ""}" @pointermove=${sgGloss}>
      <div class="apps-card-head">
        <span class="apps-type-ico">${sgIcon(typeIcon(app.type), 17)}</span>
        <span class="apps-card-type apps-card-type--${app.type}">${prettyType(app.type)}</span>
        ${app.featured ? html`<span class="apps-pill apps-pill-gold sg-chip sg-chip--gold">${STAR(true)} Featured</span>` : nothing}
        ${app.status === "archived" ? html`<span class="apps-pill apps-pill-mute sg-chip">archived</span>` : nothing}
        <span class="apps-status" title=${app.status}>${sgLed(led)}</span>
      </div>
      <h3 class="apps-card-title">${app.name}</h3>
      ${app.description ? html`<p class="apps-card-desc">${app.description}</p>` : nothing}
      <div class="apps-card-links">
        ${app.url ? html`<a class="apps-open" href=${app.url} target="_blank" rel="noreferrer">${sgIcon("link", 12)} Open</a>` : nothing}
        ${businessName ? html`<span class="apps-card-meta">${sgIcon("server", 12)} ${businessName}</span>` : nothing}
        ${app.directoryId ? html`<span class="apps-card-meta">${sgIcon("database", 12)} dir</span>` : nothing}
        <span class="apps-card-meta apps-source">${prettySource(app.sourceKind)}</span>
      </div>
      ${app.tags.length > 0 ? html`
        <div class="apps-card-tags">
          ${app.tags.slice(0, 5).map((t) => html`<span class="apps-tag">${t}</span>`)}
        </div>
      ` : nothing}
      <div class="apps-card-actions">
        <button class="sg-btn sg-btn--sm sg-btn--icon apps-iconbtn ${app.featured ? "apps-iconbtn--on" : ""}" title=${app.featured ? "Unfeature" : "Feature"} aria-label=${app.featured ? "Unfeature" : "Feature"} aria-pressed=${app.featured ? "true" : "false"} @click=${() => void toggleFeatured(state as never, client, app.id)}>
          ${STAR(app.featured)}
        </button>
        <button class="sg-btn sg-btn--sm sg-btn--icon apps-iconbtn" title="Edit" aria-label="Edit" @click=${() => openEdit(state as never, app)}>${sgIcon("edit", 14)}</button>
        <button class="sg-btn sg-btn--sm sg-btn--icon sg-btn--danger apps-iconbtn apps-danger" title="Remove from registry" aria-label="Remove from registry" @click=${() => void deleteApp(state as never, client, app.id, app.name)}>${sgIcon("trash", 14)}</button>
      </div>
    </div>
  `;
}

function renderCreateDialog<T extends AppsHost>(state: T, client: GatewayBrowserClient) {
  const as = ensureAppsState(state);
  const f = as.createForm;
  return html`
    <div class="sg-backdrop apps-dialog-backdrop" @click=${() => closeCreate(state as never)}>
      <form
        class="sg-sheet apps-dialog"
        role="dialog"
        aria-modal="true"
        @click=${(e: Event) => e.stopPropagation()}
        @submit=${(e: Event) => { e.preventDefault(); void createApp(state as never, client); }}
      >
        <div class="apps-sheet-head">
          <span class="apps-type-ico apps-type-ico--lg">${sgIcon("plus", 20)}</span>
          <div class="apps-sheet-title"><p class="sg-eyebrow">Apps &amp; Sites</p><h3>Add an app</h3></div>
          <button type="button" class="sg-btn sg-btn--ghost sg-btn--icon" aria-label="Close" @click=${() => closeCreate(state as never)}>${sgIcon("close", 16)}</button>
        </div>
        <p class="apps-help">For external apps/sites that aren't already a kanban project / directory / composition. Source-backed entries register automatically.</p>
        <div class="apps-form-grid">
          <label><span>Name</span><input class="sg-input" type="text" required .value=${f.name} @input=${(e: Event) => updateCreateField(state as never, "name", (e.target as HTMLInputElement).value)} /></label>
          <label><span>Type</span>
            <select class="sg-input" .value=${f.type} @change=${(e: Event) => updateCreateField(state as never, "type", (e.target as HTMLSelectElement).value as AppType)}>
              <option value="web-app">Web app</option>
              <option value="landing-page">Landing page</option>
              <option value="project">Project</option>
              <option value="directory">Directory</option>
              <option value="mobile-app">Mobile app</option>
              <option value="other">Other</option>
            </select>
          </label>
          <label class="apps-form-wide"><span>Description</span><textarea class="sg-input" rows="3" .value=${f.description} @input=${(e: Event) => updateCreateField(state as never, "description", (e.target as HTMLTextAreaElement).value)}></textarea></label>
          <label class="apps-form-wide"><span>URL</span><input class="sg-input" type="url" .value=${f.url} @input=${(e: Event) => updateCreateField(state as never, "url", (e.target as HTMLInputElement).value)} /></label>
          <label><span>Linked business id</span><input class="sg-input" type="text" .value=${f.businessId} @input=${(e: Event) => updateCreateField(state as never, "businessId", (e.target as HTMLInputElement).value)} /></label>
          <label><span>Linked directory id</span><input class="sg-input" type="text" .value=${f.directoryId} @input=${(e: Event) => updateCreateField(state as never, "directoryId", (e.target as HTMLInputElement).value)} /></label>
          <label class="apps-form-wide"><span>Tags (comma-separated)</span><input class="sg-input" type="text" .value=${f.tags} @input=${(e: Event) => updateCreateField(state as never, "tags", (e.target as HTMLInputElement).value)} /></label>
        </div>
        <div class="apps-dialog-actions">
          <button type="button" class="sg-btn sg-btn--ghost apps-btn apps-btn-ghost" @click=${() => closeCreate(state as never)}>Cancel</button>
          <button type="submit" class="sg-btn sg-btn--primary apps-btn apps-btn-primary" ?disabled=${as.busy}>${as.busy ? "Adding…" : "Add"}</button>
        </div>
      </form>
    </div>
  `;
}

function renderEditDialog<T extends AppsHost>(
  state: T,
  client: GatewayBrowserClient,
  businesses: Array<{ id: string; name: string }>,
) {
  const as = ensureAppsState(state);
  const a = as.editApp!;
  return html`
    <div class="sg-backdrop apps-dialog-backdrop" @click=${() => closeEdit(state as never)}>
      <form
        class="sg-sheet apps-dialog"
        role="dialog"
        aria-modal="true"
        @click=${(e: Event) => e.stopPropagation()}
        @submit=${(e: Event) => { e.preventDefault(); void updateApp(state as never, client); }}
      >
        <div class="apps-sheet-head">
          <span class="apps-type-ico apps-type-ico--lg">${sgIcon(typeIcon(a.type), 20)}</span>
          <div class="apps-sheet-title"><p class="sg-eyebrow">Edit app</p><h3>${a.name}</h3></div>
          <button type="button" class="sg-btn sg-btn--ghost sg-btn--icon" aria-label="Close" @click=${() => closeEdit(state as never)}>${sgIcon("close", 16)}</button>
        </div>
        ${a.sourceKind !== "manual" ? html`
          <p class="apps-help">This entry mirrors a ${prettySource(a.sourceKind)} record. Editing here updates the registry only — the underlying source is untouched.</p>
        ` : nothing}
        <div class="apps-form-grid">
          <label><span>Name</span><input class="sg-input" type="text" required .value=${a.name} @input=${(e: Event) => patchEdit(state as never, "name", (e.target as HTMLInputElement).value)} /></label>
          <label><span>Type</span>
            <select class="sg-input" .value=${a.type} @change=${(e: Event) => patchEdit(state as never, "type", (e.target as HTMLSelectElement).value as AppType)}>
              <option value="web-app">Web app</option>
              <option value="landing-page">Landing page</option>
              <option value="project">Project</option>
              <option value="directory">Directory</option>
              <option value="composition">Composition</option>
              <option value="storyboard">Storyboard</option>
              <option value="mobile-app">Mobile app</option>
              <option value="other">Other</option>
            </select>
          </label>
          <label class="apps-form-wide"><span>Description</span><textarea class="sg-input" rows="3" .value=${a.description} @input=${(e: Event) => patchEdit(state as never, "description", (e.target as HTMLTextAreaElement).value)}></textarea></label>
          <label class="apps-form-wide"><span>URL</span><input class="sg-input" type="url" .value=${a.url ?? ""} @input=${(e: Event) => patchEdit(state as never, "url", (e.target as HTMLInputElement).value || null)} /></label>
          <label><span>Status</span>
            <select class="sg-input" .value=${a.status} @change=${(e: Event) => patchEdit(state as never, "status", (e.target as HTMLSelectElement).value as never)}>
              <option value="active">Active</option>
              <option value="draft">Draft</option>
              <option value="archived">Archived</option>
            </select>
          </label>
          <label><span>Linked business</span>
            ${businesses.length > 0
              ? html`
                  <select class="sg-input" .value=${a.businessId ?? ""} @change=${(e: Event) => patchEdit(state as never, "businessId", (e.target as HTMLSelectElement).value || null)}>
                    <option value="">— none —</option>
                    ${businesses.map((b) => html`<option value=${b.id}>${b.name}</option>`)}
                  </select>
                `
              : html`<input class="sg-input" type="text" .value=${a.businessId ?? ""} @input=${(e: Event) => patchEdit(state as never, "businessId", (e.target as HTMLInputElement).value || null)} />`}
          </label>
          <label><span>Linked directory id</span><input class="sg-input" type="text" .value=${a.directoryId ?? ""} @input=${(e: Event) => patchEdit(state as never, "directoryId", (e.target as HTMLInputElement).value || null)} /></label>
          <label class="apps-form-wide"><span>Tags (comma-separated)</span>
            <input class="sg-input" type="text" .value=${a.tags.join(", ")} @input=${(e: Event) => patchEdit(state as never, "tags", (e.target as HTMLInputElement).value.split(",").map((s) => s.trim()).filter(Boolean))} />
          </label>
          <label class="apps-form-checkbox">
            <input type="checkbox" class="apps-switch" role="switch" .checked=${a.featured} @change=${(e: Event) => patchEdit(state as never, "featured", (e.target as HTMLInputElement).checked)} />
            <span>Featured (surfaces on dashboard spotlights)</span>
          </label>
        </div>
        <div class="apps-dialog-actions">
          <button type="button" class="sg-btn sg-btn--ghost apps-btn apps-btn-ghost" @click=${() => closeEdit(state as never)}>Cancel</button>
          <button type="submit" class="sg-btn sg-btn--primary apps-btn apps-btn-primary" ?disabled=${as.busy}>${as.busy ? "Saving…" : "Save"}</button>
        </div>
      </form>
    </div>
  `;
}

function prettyType(t: AppType): string {
  switch (t) {
    case "web-app": return "Web app";
    case "landing-page": return "Landing page";
    case "project": return "Project";
    case "directory": return "Directory";
    case "composition": return "Composition";
    case "storyboard": return "Storyboard";
    case "mobile-app": return "Mobile";
    default: return "Other";
  }
}
function prettySource(s: string): string {
  return ({
    "manual": "manual",
    "kanban-project": "kanban",
    "directory": "directory",
    "composition": "composition",
    "storyboard": "storyboard",
    "landing-page": "landing-page",
    "expo-app": "expo",
  } as Record<string, string>)[s] ?? s;
}

// ── Styles ──────────────────────────────────────────────────

let _stylesInjected = false;
function injectStyles() {
  if (_stylesInjected || typeof document === "undefined") return;
  _stylesInjected = true;
  const s = document.createElement("style");
  s.textContent = APPS_CSS;
  document.head.appendChild(s);
}

const APPS_CSS = `
/* Apps & Sites — page layer on the sg-* system glass kit (system-glass.ts).
   Reads only --sg-* / --glass-* tokens so dark, light and custom palettes follow. */
.apps-page { padding-bottom: 24px; }

.apps-banner { position: relative; display: flex; align-items: center; gap: 10px; padding: 11px 14px 11px 16px; margin-bottom: 14px; border-radius: var(--sg-radius-md); font-size: 13px; color: var(--sg-fg); background: color-mix(in srgb, var(--tone) 9%, var(--glass-2, transparent)); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tone) 30%, transparent); }
.apps-banner::before { content: ""; position: absolute; left: 0; top: 9px; bottom: 9px; width: 3px; border-radius: 3px; background: var(--tone); }
.apps-banner > .sg-ico { flex: none; color: var(--tone); }
.apps-banner > span { min-width: 0; overflow-wrap: anywhere; }
.apps-banner-error { --tone: var(--sg-bad); }
.apps-banner-success { --tone: var(--sg-ok); }

.apps-filters { display: flex; flex-direction: column; gap: 12px; margin-bottom: 16px; padding: 14px; }
.apps-filter-top { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.apps-search-wrap { position: relative; flex: 1 1 320px; min-width: 0; display: flex; align-items: center; }
.apps-search-wrap > .sg-ico { position: absolute; left: 12px; color: var(--sg-fg-3); pointer-events: none; }
.apps-search-wrap:focus-within > .sg-ico { color: var(--sg-gold); }
.apps-search { width: 100%; padding-left: 36px; }
.apps-filter-group { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.apps-select { width: auto; min-width: 170px; }
.apps-checkbox { display: inline-flex; align-items: center; gap: 9px; font-size: 13px; color: var(--sg-fg-2); cursor: pointer; user-select: none; white-space: nowrap; }
.apps-switch {
  appearance: none; -webkit-appearance: none; flex: none; position: relative; width: 38px; height: 22px; margin: 0; border-radius: 999px; cursor: pointer;
  background: var(--glass-press, rgba(255, 255, 255, 0.12)); box-shadow: inset 0 0 0 1px var(--glass-stroke-strong);
  transition: background var(--sg-dur) var(--sg-ease), box-shadow var(--sg-dur) var(--sg-ease);
}
.apps-switch::after { content: ""; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: #fff; box-shadow: 0 2px 6px rgba(0, 0, 0, 0.35); transition: transform var(--sg-dur) var(--sg-spring); }
.apps-switch:checked { background: var(--glass-gold-fill, var(--sg-gold)); box-shadow: inset 0 0 0 1px var(--glass-stroke-gold), 0 0 14px -4px var(--glass-gold-a40); }
.apps-switch:checked::after { transform: translateX(16px); }
.apps-switch:focus-visible { box-shadow: var(--glass-focus-ring, 0 0 0 2px var(--sg-gold)); }
.apps-seg { align-self: flex-start; }
.apps-chip .sg-ico { opacity: 0.8; }

.apps-empty { padding: 48px 20px; }
.apps-empty-actions { justify-content: center; flex-wrap: wrap; }
.apps-loading { margin-bottom: 12px; }
.apps-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 280px), 1fr)); gap: 14px; }
.apps-skel { min-height: 190px; border-radius: var(--sg-radius-md); }

.apps-card { display: flex; flex-direction: column; gap: 10px; padding: 16px; min-width: 0; }
.apps-card.featured { box-shadow: var(--glass-elev-2, none), inset 0 0 0 1px var(--glass-stroke-gold); }
.apps-card-head { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.apps-type-ico { flex: none; display: grid; place-items: center; width: 34px; height: 34px; border-radius: 11px; color: var(--sg-gold); background: linear-gradient(180deg, var(--glass-gold-a16, var(--glass-gold-a10)), var(--glass-gold-a06)); box-shadow: inset 0 0 0 1px var(--glass-stroke-gold); }
.apps-type-ico--lg { width: 42px; height: 42px; border-radius: 13px; }
.apps-card-type { --t: var(--sg-fg-2); padding: 3px 9px; border-radius: 999px; font: 650 10px/1.3 var(--glass-font, system-ui); letter-spacing: 0.08em; text-transform: uppercase; color: var(--t); background: color-mix(in srgb, var(--t) 12%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--t) 24%, transparent); }
.apps-card-type--project, .apps-card-type--web-app { --t: var(--sg-gold); }
.apps-card-type--composition, .apps-card-type--mobile-app { --t: var(--sg-info); }
.apps-card-type--storyboard { --t: var(--sg-warn); }
.apps-card-type--directory { --t: var(--sg-ok); }
.apps-card-type--landing-page { --t: var(--sg-bad); }
.apps-status { margin-left: auto; display: inline-flex; }
.apps-pill { display: inline-flex; align-items: center; gap: 4px; }
.apps-card-title { margin: 2px 0 0; font: 650 15.5px/1.3 var(--glass-font, system-ui); letter-spacing: -0.01em; color: var(--sg-fg); overflow-wrap: anywhere; }
.apps-card-desc { margin: 0; font-size: 12.5px; color: var(--sg-fg-2); line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.apps-card-links { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; font-size: 12px; min-width: 0; }
.apps-open { display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px; border-radius: 999px; color: var(--sg-gold); text-decoration: none; font-weight: 600; background: var(--glass-gold-a06); box-shadow: inset 0 0 0 1px var(--glass-stroke-gold); transition: background var(--sg-dur) var(--sg-ease); }
.apps-open:hover { background: var(--glass-gold-a16, var(--glass-gold-a10)); }
.apps-open:focus-visible { outline: none; box-shadow: var(--glass-focus-ring, 0 0 0 2px var(--sg-gold)); }
.apps-card-meta { display: inline-flex; align-items: center; gap: 5px; color: var(--sg-fg-3); min-width: 0; }
.apps-source { margin-left: auto; font-family: var(--glass-font-mono, ui-monospace, monospace); font-size: 10.5px; color: var(--sg-fg-4); }
.apps-card-tags { display: flex; flex-wrap: wrap; gap: 5px; }
.apps-tag { padding: 2px 8px; border-radius: 999px; font-size: 11px; color: var(--sg-fg-2); background: var(--glass-hover, rgba(255, 255, 255, 0.05)); box-shadow: inset 0 0 0 1px var(--glass-stroke); }
.apps-card-actions { display: flex; gap: 6px; margin-top: auto; padding-top: 10px; border-top: 1px solid var(--glass-stroke); }
.apps-iconbtn--on { color: var(--sg-gold); box-shadow: inset 0 0 0 1px var(--glass-stroke-gold); }
.apps-help { color: var(--sg-fg-3); font-size: 12.5px; margin: 0 0 14px; line-height: 1.55; }

.apps-dialog { width: min(720px, 100%); }
.apps-sheet-head { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.apps-sheet-title { flex: 1; min-width: 0; }
.apps-sheet-title .sg-eyebrow { margin: 0 0 2px; }
.apps-sheet-title h3 { margin: 0; font: 650 18px/1.25 var(--glass-font, system-ui); color: var(--sg-fg); overflow-wrap: anywhere; }
.apps-form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 14px; }
.apps-form-grid > label { display: flex; flex-direction: column; gap: 6px; min-width: 0; font: 650 10.5px/1.2 var(--glass-font, system-ui); letter-spacing: 0.08em; text-transform: uppercase; color: var(--sg-fg-3); }
.apps-form-grid textarea.sg-input { resize: vertical; min-height: 76px; line-height: 1.5; font-family: inherit; }
.apps-form-wide { grid-column: 1 / -1; }
.apps-form-grid > label.apps-form-checkbox { flex-direction: row; align-items: center; gap: 10px; grid-column: 1 / -1; font: 500 13px/1.4 var(--glass-font, system-ui); letter-spacing: 0; text-transform: none; color: var(--sg-fg-2); cursor: pointer; }
.apps-dialog-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--glass-stroke); }

@media (max-width: 720px) {
  .apps-form-grid { grid-template-columns: 1fr; }
  .apps-filter-group { width: 100%; justify-content: space-between; }
  .apps-select { flex: 1 1 auto; min-width: 0; }
  .sg-seg.apps-seg { align-self: stretch; display: flex; flex-wrap: wrap; overflow: visible; }
}
@media (prefers-reduced-motion: reduce) {
  .apps-switch, .apps-switch::after, .apps-open { transition: none; }
}
`;
