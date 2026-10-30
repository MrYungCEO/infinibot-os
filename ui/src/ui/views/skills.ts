import { html, nothing } from "lit";
import { icons } from "../icons";

import { clampText } from "../format";
import type {
  SkillStatusEntry,
  SkillStatusReport,
  SkillDraftUi,
  HealingProposalUi,
  SkillActivityEntry,
  SkillSystemConfig,
  SkillQueueStats,
  DraftScope,
} from "../types";
import type { LearnedSkill, SkillMessageMap, SkillAuthorInput } from "../controllers/skills";
import { t } from "../i18n";
import "../components/import-upload.js";
import { glassAurora, glassToolsStyle } from "./glass-tools-shared";
import { glassSkillsStyle } from "./glass-skills.css";

export type SkillsProps = {
  loading: boolean;
  report: SkillStatusReport | null;
  error: string | null;
  filter: string;
  edits: Record<string, string>;
  busyKey: string | null;
  messages: SkillMessageMap;
  onFilterChange: (next: string) => void;
  onRefresh: () => void;
  onToggle: (skillKey: string, enabled: boolean) => void;
  onEdit: (skillKey: string, value: string) => void;
  onSaveKey: (skillKey: string) => void;
  onInstall: (skillKey: string, name: string, installId: string) => void;
  onAuthorSkill?: (input: SkillAuthorInput) => void;
  /** Gateway client + refresh hook for the Import (upload) button. */
  importClient?: import("../gateway").GatewayBrowserClient | null;
  onImported?: () => void;
  onDeleteSkill?: (skillKey: string, filePath?: string) => void;
  learnedSkills: LearnedSkill[];
  learnedLoading: boolean;
  learnedError: string | null;
  learnedEnabled: boolean;
  learnedSelfImproveRunning: boolean;
  learnedSelfImproveSummary: string | null;
  onLearnedRefresh: () => void;
  onLearnedDelete: (skillKey: string) => void;
  onLearnedSelfImprove: () => void;
  // Queue management (optional — only needed by the full Skills page)
  drafts?: SkillDraftUi[];
  draftsLoading?: boolean;
  draftsError?: string | null;
  healingProposals?: HealingProposalUi[];
  healingLoading?: boolean;
  healingError?: string | null;
  activity?: SkillActivityEntry[];
  activityLoading?: boolean;
  skillConfig?: SkillSystemConfig | null;
  skillConfigLoading?: boolean;
  skillConfigSaving?: boolean;
  queueStats?: SkillQueueStats | null;
  onDraftsRefresh?: () => void;
  onDraftAccept?: (id: string, scope: DraftScope, editedMd?: string) => void;
  onDraftReject?: (id: string, reason?: string) => void;
  onDraftGetContent?: (id: string) => Promise<{ skillMd: string; metadata: Record<string, unknown> } | null>;
  onHealingRefresh?: () => void;
  onHealingApply?: (id: string, editedMd?: string) => void;
  onHealingReject?: (id: string, reason?: string) => void;
  onHealingGetContent?: (id: string) => Promise<{ proposedMd: string; currentMd: string; diff: string } | null>;
  onActivityRefresh?: () => void;
  onSaveConfig?: (patch: Partial<SkillSystemConfig>) => void;
};

// ── Browse Skills modal state (module-level so we don't have to plumb a
// new prop through every caller). The modal is a richer alternative to the
// inline list — it shows every bundled + workspace skill with search, filter
// tabs, full descriptions, and one-click install. Each toggle here calls
// _rerender() so the host view picks up the change without prop changes.
type BrowseFilter = "all" | "available" | "installed" | "needs-setup" | "blocked";
let _showBrowseModal = false;
let _browseSearch = "";
let _browseFilter: BrowseFilter = "all";
let _browseSelectedKey: string | null = null;
let _browseRerender: (() => void) | null = null;
function _rerender() {
  _browseRerender?.();
}

/**
 * Callback invoked when the user picks a skill from the modal to use in
 * their current prompt. The string is the skill's display name (sans
 * leading `/`); callers typically prepend "@" or "/skill:" depending on
 * how their compose surface references skills.
 */
type SkillPickHandler = (skillName: string, skill: SkillStatusEntry) => void;
let _onPickSkill: SkillPickHandler | null = null;

/**
 * Open the Browse Skills modal from anywhere in the UI. The chat-panel
 * slash-command popup wires `/skill` here so the user gets a real picker
 * instead of bare text injected into the prompt. The modal renders globally
 * via `renderSkillsBrowseModalGlobal` mounted at the app root, so it pops
 * over whichever tab the user is on.
 *
 * Pass `onPick` to receive the chosen skill back in the calling compose
 * surface — without it the modal still works for browse / install but the
 * "Use in prompt" button is hidden.
 */
export function openSkillsBrowseModal(opts: { search?: string; rerender?: () => void; onPick?: SkillPickHandler } = {}): void {
  _showBrowseModal = true;
  if (opts.search !== undefined) _browseSearch = opts.search;
  _browseFilter = "all";
  _browseSelectedKey = null;
  if (opts.rerender) _browseRerender = opts.rerender;
  _onPickSkill = opts.onPick ?? null;
  _rerender();
}

export function closeSkillsBrowseModal(): void {
  _showBrowseModal = false;
  _onPickSkill = null;
  _rerender();
}

export function isSkillsBrowseModalOpen(): boolean {
  return _showBrowseModal;
}

/** Internal: insert the skill reference into the calling compose surface. */
function _pickSkill(skill: SkillStatusEntry): void {
  const handler = _onPickSkill;
  if (!handler) return;
  // Use a clean skill identifier rather than the display name so the
  // downstream parser/agent can look the skill up reliably. The skillKey
  // is stable (e.g. "github", "1password"); the display name might have
  // emoji or punctuation that confuses /skill resolution.
  handler(skill.skillKey, skill);
  closeSkillsBrowseModal();
}

// ── Skills page tab state (module-level, like browse modal) ──────────────────

type SkillsTab = "active" | "drafts" | "healing" | "activity" | "settings";
let _skillsTab: SkillsTab = "active";

// ── Discovery surface state (active tab) ─────────────────────────────────────
// The active tab is a curated discovery surface: featured row, fuzzy search,
// category pills, status badges, a detail drawer, and a guided author form.
// All state is module-level (mirrors the browse-modal pattern) so we don't have
// to thread extra props through every caller. Each mutation calls _rerender().
let _discoverSearch = "";
let _discoverCategory = "all";
let _discoverStatus: "all" | "ready" | "needs-setup" | "disabled" = "all";
let _drawerKey: string | null = null; // skillKey whose detail drawer is open
let _showAdvanced = false; // reveals the legacy raw list + browse modal

// Guided author/edit form. `_authorOpen` shows the form drawer; `_authorEditKey`
// is the skillKey when editing an existing managed skill (null when creating).
let _authorOpen = false;
let _authorEditKey: string | null = null;
type AuthorForm = {
  name: string;
  slug: string;
  description: string;
  emoji: string;
  category: string;
  whenToUse: string;
  tools: string;
  systemPrompt: string;
};
let _authorForm: AuthorForm = blankAuthorForm();

function blankAuthorForm(): AuthorForm {
  return { name: "", slug: "", description: "", emoji: "", category: "", whenToUse: "", tools: "", systemPrompt: "" };
}

// Per-draft/healing expand + edit state
const _draftExpanded = new Set<string>();
const _draftEditing = new Map<string, string>(); // id → edited MD
const _draftRejectInput = new Map<string, string>(); // id → reason
const _draftRejectOpen = new Set<string>();

const _healingExpanded = new Set<string>();
const _healingEditing = new Map<string, string>(); // id → edited MD
const _healingRejectInput = new Map<string, string>();
const _healingRejectOpen = new Set<string>();

// Drafts filter chip
type QueueFilter = "all" | "pending" | "accepted" | "rejected";
let _draftsFilter: QueueFilter = "pending";
let _healingFilter: QueueFilter = "pending";

// Settings local edits (pending Save)
let _configEdits: Partial<SkillSystemConfig> | null = null;

// Track whether we've already kicked an auto-load for this open session,
// so we don't fire repeated `onRefresh` calls every time `_rerender` runs
// (search input, filter pill clicks, etc.).
let _autoLoadFired = false;

// 30-second polling timer for queue stats (active while Skills page is visible).
let _statsPollerHandle: ReturnType<typeof setInterval> | null = null;
let _statsPollerCallback: (() => void) | null = null;

function startStatsPoller(onTick: () => void) {
  if (_statsPollerHandle) return;
  _statsPollerCallback = onTick;
  _statsPollerHandle = setInterval(() => _statsPollerCallback?.(), 30_000);
}

export function stopSkillsStatsPoller() {
  if (_statsPollerHandle) {
    clearInterval(_statsPollerHandle);
    _statsPollerHandle = null;
    _statsPollerCallback = null;
  }
}

/**
 * Render the modal at the app root. Used by `renderApp` so /grid and any
 * other tab can pop the modal without owning its data plumbing. Returns
 * `nothing` when closed.
 *
 * Auto-loads the skills report on first open when it's missing, so users
 * who hit `/skill` from a chat panel without ever visiting /skills still
 * see the full skill list instead of an empty modal.
 */
export function renderSkillsBrowseModalGlobal(props: SkillsProps & { rerender?: () => void }): unknown {
  if (props.rerender) _browseRerender = props.rerender;
  if (!_showBrowseModal) {
    _autoLoadFired = false; // reset on close so a re-open re-fetches if needed
    return nothing;
  }

  const skills = props.report?.skills ?? [];
  if (skills.length === 0 && !props.loading && !_autoLoadFired) {
    _autoLoadFired = true;
    // Defer the load past this render pass — calling onRefresh from inside
    // render will trigger a synchronous state update + recurse here. The
    // load is async; the next paint after the report lands will populate
    // the modal.
    queueMicrotask(() => {
      try { props.onRefresh(); } catch { /* ignore */ }
    });
  }

  return renderBrowseSkillsModal(props);
}


// ── Glass helpers ─────────────────────────────────────────────────────────────

type Tone = "ok" | "warn" | "danger" | "idle" | "gold";

// Brand-safe tint per category so the gallery reads as a cohesive set of
// gold variations rather than a rainbow.
const CATEGORY_TINT: Record<string, number> = {
  "Code Review": 0, Design: 3, Research: 2, DevOps: 5, Writing: 2, Media: 4,
  Communication: 1, Productivity: 0, Personal: 4, Coding: 1, Other: 0,
};

function monogram(name: string): string {
  const clean = (name || "?").replace(/[^\p{L}\p{N}\s_-]/gu, " ").trim();
  const words = clean.split(/[\s_-]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  const w = words[0] ?? "?";
  return w[0].toUpperCase() + (w[1] ?? "").toLowerCase();
}

/** Skill glyph: the skill's emoji when present, otherwise a gold monogram. */
function skillGlyph(
  skill: { name: string; emoji?: string },
  size: "sm" | "md" | "lg" = "md",
  category?: string,
) {
  const emoji = skill.emoji?.trim();
  const tint = category ? (CATEGORY_TINT[category] ?? 0) : 0;
  return html`<span class="gs-icon" data-size=${size} data-tint=${String(tint)} aria-hidden="true">${emoji
    ? html`<span class="gs-icon-emoji">${emoji}</span>`
    : html`<span class="gs-icon-mono">${monogram(skill.name)}</span>`}</span>`;
}

function statusPill(label: string, tone: Tone, pulse = false) {
  return html`<span class="gs-status" data-tone=${tone}><span class="gt-light" data-state=${tone} ?data-pulse=${pulse}></span>${label}</span>`;
}

function panelHead(icon: unknown, title: string, sub: unknown, actions?: unknown) {
  return html`
    <div class="gs-panel-head">
      <div class="gs-panel-id">
        <span class="gs-ico-badge">${icon}</span>
        <div style="min-width:0;">
          <h3 class="gs-panel-title">${title}</h3>
          ${sub ? html`<p class="gs-panel-sub">${sub}</p>` : nothing}
        </div>
      </div>
      ${actions ? html`<div class="gs-actions">${actions}</div>` : nothing}
    </div>
  `;
}

function note(tone: "gold" | "ok" | "warn" | "danger", body: unknown) {
  const icon = tone === "danger" ? icons.alertCircle : tone === "ok" ? icons.checkCircle : tone === "warn" ? icons.alert : icons.lightbulb;
  return html`<div class="gs-note" data-tone=${tone} role=${tone === "danger" ? "alert" : "status"}>${icon}<div>${body}</div></div>`;
}

function emptyState(icon: unknown, title: string, sub: string, action?: unknown) {
  return html`
    <div class="gt-empty gs-empty-panel">
      <span class="gt-empty-orb">${icon}</span>
      <div class="gt-empty-title">${title}</div>
      <div class="gt-empty-sub">${sub}</div>
      ${action ?? nothing}
    </div>
  `;
}

// Copy-to-clipboard feedback for the example invocations in the drawer.
let _copiedText: string | null = null;
let _copiedTimer: ReturnType<typeof setTimeout> | null = null;
function copyText(text: string) {
  try { void navigator.clipboard?.writeText(text); } catch { /* ignore */ }
  _copiedText = text;
  if (_copiedTimer) clearTimeout(_copiedTimer);
  _copiedTimer = setTimeout(() => { _copiedText = null; _rerender(); }, 1400);
  _rerender();
}

function selectTab(tab: SkillsTab, props: SkillsProps) {
  _skillsTab = tab;
  _rerender();
  if (tab === "drafts" && (props.drafts ?? []).length === 0) props.onDraftsRefresh?.();
  if (tab === "healing" && (props.healingProposals ?? []).length === 0) props.onHealingRefresh?.();
  if (tab === "activity" && (props.activity ?? []).length === 0) props.onActivityRefresh?.();
  if (tab === "settings" && !props.skillConfig) props.onSaveConfig?.({});
}

function openDrawer(skillKey: string) {
  _drawerKey = skillKey;
  _rerender();
}

export function renderSkills(props: SkillsProps) {
  // Wire the modal's rerender hook into the same refresh path the rest of
  // the page uses, so toggling/searching inside the modal repaints the
  // outer view too. Re-set on every render to capture the latest closures.
  _browseRerender = () => props.onFilterChange(props.filter);

  // Start a 30-second polling ticker for queue stats badge counts.
  // Each render re-registers the callback so props closures stay fresh.
  if (props.onDraftsRefresh || props.onHealingRefresh) {
    startStatsPoller(() => {
      props.onDraftsRefresh?.();
      props.onHealingRefresh?.();
    });
    // Active tab shows the "Self-Generated Skills" section which is
    // populated from props.drafts. Without an initial fetch the section
    // is invisible until the 30s ticker fires for the first time. Kick
    // off a fetch once on first render so newly auto-accepted drafts
    // show up immediately.
    if (props.drafts === undefined) {
      props.onDraftsRefresh?.();
    }
  }

  const stats = props.queueStats;
  const pendingDrafts = stats?.pendingDrafts ?? (props.drafts ?? []).filter((d) => d.status === "pending").length;
  const pendingHealing = stats?.pendingHealing ?? (props.healingProposals ?? []).filter((h) => h.status === "pending").length;

  const tabIcon: Record<SkillsTab, unknown> = {
    active: icons.layoutGrid,
    drafts: icons.sparkles,
    healing: icons.wrench,
    activity: icons.activity,
    settings: icons.sliders,
  };

  return html`
    ${glassToolsStyle()}
    ${glassSkillsStyle()}
    <div class="gt-scope gs-page">
      ${glassAurora()}

      <!-- Hero + stats -->
      ${renderSkillsHero(props, pendingDrafts, pendingHealing)}

      <!-- Tab bar -->
      <div class="gs-tabs-wrap">
        <div class="gt-seg gs-tabs" role="tablist" aria-label="Skills sections">
          ${(["active", "drafts", "healing", "activity", "settings"] as SkillsTab[]).map((tab) => {
            const badge = tab === "drafts" ? pendingDrafts : tab === "healing" ? pendingHealing : 0;
            const label = tab === "active" ? "Active Skills"
              : tab === "drafts" ? "Drafts"
              : tab === "healing" ? "Healing"
              : tab === "activity" ? "Activity"
              : "Settings";
            return html`
              <button
                role="tab"
                data-learn-id=${`skills-tab-${tab}`}
                aria-selected=${_skillsTab === tab ? "true" : "false"}
                aria-pressed=${_skillsTab === tab ? "true" : "false"}
                @click=${() => selectTab(tab, props)}
              >
                ${tabIcon[tab]} ${label}
                ${badge > 0 ? html`<span class="gs-badge">${badge}</span>` : nothing}
              </button>
            `;
          })}
        </div>
      </div>

      <!-- Tab content -->
      ${_skillsTab === "active" ? renderActiveSkillsTab(props) : nothing}
      ${_skillsTab === "drafts" ? renderDraftsTab(props) : nothing}
      ${_skillsTab === "healing" ? renderHealingTab(props) : nothing}
      ${_skillsTab === "activity" ? renderActivityTab(props) : nothing}
      ${_skillsTab === "settings" ? renderSettingsTab(props) : nothing}
    </div>

    ${_skillsTab === "active" && _drawerKey ? renderSkillDrawer(props) : nothing}
    ${_skillsTab === "active" && _authorOpen ? renderAuthorDrawer(props) : nothing}
    ${/* The Browse Skills modal is mounted once, globally, by
        renderSkillsBrowseModalGlobal() at the app root (it used to be
        rendered here too, which stacked two identical modals on /skills). */ nothing}
  `;
}

function renderSkillsHero(props: SkillsProps, pendingDrafts: number, pendingHealing: number) {
  const stats = props.queueStats;
  const all = props.report?.skills ?? [];
  const activeCount = all.filter((s) => s.eligible && !s.disabled).length;
  const rejected = stats?.rejectedLastWeek ?? 0;
  const tiles: Array<{ label: string; value: number; of?: number; tone: Tone; tab?: SkillsTab; pulse?: boolean }> = [
    { label: "Active", value: activeCount, of: all.length || undefined, tone: "ok" },
    { label: "Pending Drafts", value: pendingDrafts, tone: pendingDrafts > 0 ? "gold" : "idle", tab: "drafts", pulse: pendingDrafts > 0 },
    { label: "Pending Healing", value: pendingHealing, tone: pendingHealing > 0 ? "warn" : "idle", tab: "healing", pulse: pendingHealing > 0 },
    { label: "Accepted / 7d", value: stats?.acceptedLastWeek ?? 0, tone: "ok" },
    { label: "Rejected / 7d", value: rejected, tone: rejected > 0 ? "danger" : "idle" },
  ];
  return html`
    <header class="gt-hero gs-hero">
      <div class="gs-hero-copy">
        <span class="gt-eyebrow">Capability library</span>
        <h1 class="gt-title">Skills</h1>
        <p class="gt-sub">${t("skills.discover.subtitle", undefined, "Browse, install, and manage skills — give your agents new abilities in one click.")}</p>
        <div class="gs-hero-actions">
          <button
            class="gt-btn gt-primary"
            data-learn-id="skills-create"
            ?disabled=${!props.onAuthorSkill}
            @click=${() => { _skillsTab = "active"; openAuthor(null); }}
            title=${t("skills.author.new", undefined, "Create a new skill")}
          >${icons.penLine} ${t("skills.author.new", undefined, "Create skill")}</button>
          ${props.importClient
            ? html`<import-upload
                .client=${props.importClient}
                method="skills.import"
                noun="skill"
                accept=".md,.markdown,.zip"
                label="Import skill"
                @imported=${() => props.onImported?.()}
              ></import-upload>`
            : nothing}
          <button class="gt-btn" ?disabled=${props.loading} @click=${props.onRefresh}>
            ${icons.refresh} ${props.loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </div>
      <div class="gt-stats gs-stats" data-learn-id="skills-stats">
        ${tiles.map((s, i) => {
          const body = html`
            <span class="gt-light" data-state=${s.tone} ?data-pulse=${s.pulse}></span>
            <span class="gt-stat-value">${s.value}${s.of !== undefined ? html`<span class="gs-stat-of">/ ${s.of}</span>` : nothing}</span>
            <span class="gt-stat-label">${s.label}</span>
          `;
          return s.tab
            ? html`<button class="gt-stat gt-glass gs-stat gt-rise" style="--gt-i:${i}" title="Open ${s.label.toLowerCase()}" @click=${() => selectTab(s.tab!, props)}>${body}</button>`
            : html`<div class="gt-stat gt-glass gs-stat gt-rise" style="--gt-i:${i}">${body}</div>`;
        })}
      </div>
    </header>
  `;
}

// One-shot guard so we kick a single auto-load when the discovery surface
// first renders without data, instead of forcing the user to hit Refresh.
let _activeAutoLoadFired = false;

function renderActiveSkillsTab(props: SkillsProps) {
  const skills = props.report?.skills ?? [];
  if (skills.length === 0 && !props.loading && !_activeAutoLoadFired) {
    _activeAutoLoadFired = true;
    queueMicrotask(() => { try { props.onRefresh(); } catch { /* ignore */ } });
  }
  const search = _discoverSearch.trim().toLowerCase();

  // Apply search → category → status, in that order.
  const filtered = skills.filter((skill) => {
    if (search && !matchesDiscover(skill, search)) return false;
    if (_discoverCategory !== "all" && deriveCategory(skill) !== _discoverCategory) return false;
    if (_discoverStatus !== "all" && statusInfo(skill).key !== _discoverStatus) return false;
    return true;
  });

  const featured = pickFeatured(skills);
  const categories = collectCategories(skills);
  const filtersActive = Boolean(search) || _discoverCategory !== "all" || _discoverStatus !== "all";
  const statusCount = (key: "ready" | "needs-setup" | "disabled") => skills.filter((s) => statusInfo(s).key === key).length;

  return html`
    <!-- Discovery toolbar -->
    <section class="gt-glass gs-toolbar" data-learn-id="skills-discover" aria-label=${t("skills.discover.title", undefined, "Discover skills")}>
      <div class="gs-toolbar-row">
        <label class="gs-search">
          ${icons.search}
          <input
            class="gt-input"
            type="search"
            data-learn-id="skills-search"
            aria-label=${t("skills.discover.title", undefined, "Discover skills")}
            .value=${_discoverSearch}
            @input=${(e: Event) => { _discoverSearch = (e.target as HTMLInputElement).value; props.onFilterChange(_discoverSearch); }}
            placeholder=${t("skills.discover.search", undefined, "Search skills by name, description, trigger, or requirement…")}
          />
        </label>
        <!-- Status filter -->
        <div class="gt-seg gs-statusseg" role="group" aria-label="Status">
          ${([
            ["all", t("skills.status.all", undefined, "Any status"), "gold"],
            ["ready", t("skills.status.enabled", undefined, "Enabled"), "ok"],
            ["needs-setup", t("skills.status.needsSetup", undefined, "Needs setup"), "warn"],
            ["disabled", t("skills.status.disabled", undefined, "Disabled"), "idle"],
          ] as const).map(([key, label, tone]) => {
            const active = _discoverStatus === key;
            return html`
              <button
                aria-pressed=${active ? "true" : "false"}
                title=${key === "all" ? label : `${label} · ${statusCount(key)}`}
                @click=${() => { _discoverStatus = active ? "all" : key; _rerender(); }}
              >${key !== "all" ? html`<span class="gt-light" data-state=${tone}></span>` : nothing}${label}</button>
            `;
          })}
        </div>
      </div>

      <!-- Category chips -->
      <div class="gs-cats" role="group" aria-label="Categories">
        ${["all", ...categories].map((cat) => {
          const active = _discoverCategory === cat;
          const count = cat === "all" ? skills.length : skills.filter((s) => deriveCategory(s) === cat).length;
          return html`
            <button
              class="gs-cat"
              aria-pressed=${active ? "true" : "false"}
              @click=${() => { _discoverCategory = active ? "all" : cat; _rerender(); }}
            >${cat === "all" ? t("skills.discover.allCategories", undefined, "All") : cat} <span class="gs-cat-n">${count}</span></button>
          `;
        })}
      </div>
    </section>

    ${props.error ? note("danger", props.error) : nothing}

    <!-- Featured row -->
    ${featured.length > 0 && !search && _discoverCategory === "all" && _discoverStatus === "all"
      ? html`
          <section class="gs-sec">
            <div class="gs-sec-head" data-tone="gold">${icons.star} ${t("skills.discover.featured", undefined, "Featured")}</div>
            <div class="gs-featured">
              ${featured.map((s, i) => renderFeaturedCard(s, props, i))}
            </div>
          </section>
        `
      : nothing}

    <!-- Main gallery -->
    <section class="gs-sec">
      <div class="gs-sec-head">
        ${icons.layoutGrid} ${t("skills.discover.all", undefined, "All skills")} <span class="gs-count">${filtered.length}</span>
      </div>
      ${props.loading && skills.length === 0
        ? html`<div class="gs-grid" aria-busy="true" aria-label="Loading skills…">
            ${Array.from({ length: 8 }, () => html`
              <div class="gt-glass gs-skel-tile">
                <div class="gs-skel-row">
                  <div class="gt-skel" style="width:44px;height:44px;border-radius:14px;"></div>
                  <div style="flex:1;display:grid;gap:7px;">
                    <div class="gt-skel" style="height:12px;width:60%;"></div>
                    <div class="gt-skel" style="height:9px;width:38%;"></div>
                  </div>
                </div>
                <div class="gt-skel" style="height:10px;width:92%;"></div>
                <div class="gt-skel" style="height:10px;width:70%;"></div>
                <div class="gt-skel" style="height:28px;width:100%;margin-top:6px;border-radius:10px;"></div>
              </div>
            `)}
          </div>`
        : filtered.length === 0
          ? html`<div class="gt-glass">
              ${emptyState(
                icons.search,
                skills.length === 0 ? "No skills loaded yet" : t("skills.discover.empty", undefined, "No skills match your filters."),
                skills.length === 0
                  ? "Skills appear here once the gateway reports them. Refresh to try again."
                  : "Try a different search, or clear the category and status filters.",
                skills.length === 0
                  ? html`<button class="gt-btn" ?disabled=${props.loading} @click=${props.onRefresh}>${icons.refresh} Refresh</button>`
                  : filtersActive
                    ? html`<button class="gt-btn" @click=${() => {
                        _discoverSearch = ""; _discoverCategory = "all"; _discoverStatus = "all";
                        props.onFilterChange("");
                        _rerender();
                      }}>${icons.x} Clear filters</button>`
                    : nothing,
              )}
            </div>`
          : html`
              <div class="gs-grid">
                ${filtered.map((s, i) => renderDiscoverCard(s, props, i))}
              </div>
            `}
    </section>

    ${renderSelfGeneratedSection(props)}
    ${renderLearnedSkillsSection(props)}

    <!-- Advanced (legacy raw list + MCP + browse modal) -->
    <section class="gt-glass gs-panel">
      ${panelHead(
        icons.sliders,
        t("skills.advanced.title", undefined, "Advanced"),
        t("skills.advanced.subtitle", undefined, "Raw skill list, MCP servers, and the full browse modal."),
        html`<button class="gt-btn" aria-expanded=${_showAdvanced ? "true" : "false"} @click=${() => { _showAdvanced = !_showAdvanced; _rerender(); }}>
          ${_showAdvanced ? icons.chevronUp : icons.chevronDown} ${_showAdvanced ? "Hide advanced" : "Show advanced"}
        </button>`,
      )}
      ${_showAdvanced ? renderAdvancedSection(props, skills) : nothing}
    </section>
  `;
}

// ── Discovery helpers ─────────────────────────────────────────────────────────

// Curated "popular" skill keys, surfaced in the featured row when present in
// the loaded report. Anything not installed locally simply doesn't appear.
const FEATURED_KEYS = [
  "code-review", "github", "deep-research", "architect", "frontend-designer",
  "coder", "ux-expert", "notion", "gemini", "orchestrator", "web-dev", "qa-inspector",
];

function pickFeatured(skills: SkillStatusEntry[]): SkillStatusEntry[] {
  const byKey = new Map(skills.map((s) => [s.skillKey, s]));
  const curated = FEATURED_KEYS.map((k) => byKey.get(k)).filter((s): s is SkillStatusEntry => Boolean(s));
  if (curated.length >= 3) return curated.slice(0, 6);
  // Thin curated set → backfill with ready, non-curated skills.
  const extra = skills
    .filter((s) => s.eligible && !s.disabled && !FEATURED_KEYS.includes(s.skillKey))
    .slice(0, 6 - curated.length);
  return [...curated, ...extra].slice(0, 6);
}

function collectCategories(skills: SkillStatusEntry[]): string[] {
  const set = new Set<string>();
  for (const s of skills) set.add(deriveCategory(s));
  return [...set].sort();
}

// Heuristic category from the skill's name/key/description. Used for the
// category pills since the status payload has no explicit category field.
function deriveCategory(skill: SkillStatusEntry): string {
  const hay = `${skill.skillKey} ${skill.name} ${skill.description}`.toLowerCase();
  const has = (...words: string[]) => words.some((w) => hay.includes(w));
  if (has("review", "lint", "audit", "security", "qa", "test", "inspector")) return "Code Review";
  if (has("plan", "architect", "design", "ui", "ux", "frontend", "css", "layout")) return "Design";
  if (has("research", "search", "deep-research", "web search", "scrape", "fetch")) return "Research";
  if (has("deploy", "docker", "kubernetes", "ci", "cd", "devops", "infra", "terraform", "github", "git")) return "DevOps";
  if (has("write", "copy", "doc", "blog", "content", "notion", "markdown")) return "Writing";
  if (has("video", "image", "photo", "remotion", "frame", "media", "canva", "atlas")) return "Media";
  if (has("crm", "lead", "client", "sales", "telegram", "message", "channel", "bluebubble")) return "Communication";
  if (has("orchestrat", "agent", "mesh", "workflow", "coordinat")) return "Productivity";
  if (has("weather", "personal", "calendar", "reminder")) return "Personal";
  if (has("code", "coder", "typescript", "python", "go", "build")) return "Coding";
  return "Other";
}

// Status badge semantics derived from the SkillStatusEntry flags.
function statusInfo(skill: SkillStatusEntry): { label: string; color: string; tone: Tone; key: "ready" | "needs-setup" | "disabled" } {
  if (skill.disabled) return { label: "Disabled", color: "#9ca3af", tone: "idle", key: "disabled" };
  if (skill.blockedByAllowlist) return { label: "Blocked", color: "#ef4444", tone: "danger", key: "disabled" };
  if (skill.missing.bins.length > 0 || skill.missing.env.length > 0) return { label: "Needs setup", color: "#f59e0b", tone: "warn", key: "needs-setup" };
  if (!skill.eligible) return { label: "Unavailable", color: "#ef4444", tone: "danger", key: "needs-setup" };
  return { label: "Enabled", color: "#22c55e", tone: "ok", key: "ready" };
}

function matchesDiscover(skill: SkillStatusEntry, search: string): boolean {
  const haystack = [
    skill.name, skill.description ?? "", skill.source, skill.skillKey,
    skill.primaryEnv ?? "", deriveCategory(skill),
    ...skill.requirements.bins.map((b) => `bin:${b}`),
    ...skill.requirements.env.map((e) => `env:${e}`),
    ...skill.install.map((i) => `${i.id} ${i.label}`),
  ].join(" ").toLowerCase();
  return haystack.includes(search);
}

// Pull a "When to use / Triggers" snippet out of the freeform description.
function extractTrigger(description: string): string | null {
  if (!description) return null;
  const m = description.match(/(?:^|[.\n])\s*((?:use when|trigger[s]? (?:on|when)|invoke when|when the user)\b[^.]*\.?)/i);
  if (m && m[1]) return m[1].trim();
  return null;
}

// Whether this skill lives in the managed dir (user-authored ⇒ editable/deletable).
function isManagedSkill(skill: SkillStatusEntry, props: SkillsProps): boolean {
  const managed = props.report?.managedSkillsDir;
  if (!managed) return false;
  return Boolean(skill.filePath && skill.filePath.startsWith(managed));
}

function renderFeaturedCard(skill: SkillStatusEntry, props: SkillsProps, index = 0) {
  const busy = props.busyKey === skill.skillKey;
  const info = statusInfo(skill);
  const ready = info.key === "ready";
  const category = deriveCategory(skill);
  return html`
    <div
      class="gs-feat gt-glass gt-lift gt-rise"
      style="--gt-i:${index}"
      role="button"
      tabindex="0"
      aria-label=${`${skill.name} — ${info.label}`}
      @click=${() => openDrawer(skill.skillKey)}
      @keydown=${(e: KeyboardEvent) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDrawer(skill.skillKey); }
      }}
    >
      <span class="gs-glow" aria-hidden="true"></span>
      ${skillGlyph(skill, "md", category)}
      <span class="gs-feat-name">${skill.name}</span>
      ${statusPill(info.label, info.tone)}
      <span class="gs-feat-desc">${clampText(skill.description ?? "", 140)}</span>
      <span class="gs-feat-foot">
        <span class="gt-chip">${category}</span>
        ${ready
          ? html`<span class="gt-chip" data-tone="ok">${icons.check} ${t("skills.card.enabled", undefined, "Enabled")}</span>`
          : skill.disabled
            ? html`<button class="gt-btn gt-primary" ?disabled=${busy}
                @click=${(e: Event) => { e.stopPropagation(); props.onToggle(skill.skillKey, true); }}
              >${t("skills.card.enable", undefined, "Enable")}</button>`
            : skill.install.length > 0
              ? html`<button class="gt-btn gt-primary" ?disabled=${busy}
                  @click=${(e: Event) => { e.stopPropagation(); props.onInstall(skill.skillKey, skill.name, skill.install[0].id); }}
                >${icons.download} ${busy ? "…" : t("skills.card.install", undefined, "Install")}</button>`
              : html`<span class="gt-chip" data-tone="warn">${info.label}</span>`}
      </span>
    </div>
  `;
}

function renderDiscoverCard(skill: SkillStatusEntry, props: SkillsProps, index = 0) {
  const busy = props.busyKey === skill.skillKey;
  const info = statusInfo(skill);
  const ready = info.key === "ready";
  const managed = isManagedSkill(skill, props);
  const category = deriveCategory(skill);
  return html`
    <div
      class="gs-tile gt-glass gt-lift gt-rise"
      style="--gt-i:${Math.min(index, 18)}"
      role="button"
      tabindex="0"
      aria-label=${`${skill.name} — ${info.label}`}
      data-state=${info.key}
      ?data-selected=${_drawerKey === skill.skillKey}
      @click=${() => openDrawer(skill.skillKey)}
      @keydown=${(e: KeyboardEvent) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDrawer(skill.skillKey); }
      }}
    >
      <span class="gs-glow" aria-hidden="true"></span>
      <div class="gs-tile-top">
        ${skillGlyph(skill, "md", category)}
        <div class="gs-tile-id">
          <span class="gs-tile-name">${skill.name}</span>
          <span class="gs-tile-key">${skill.skillKey}</span>
        </div>
        ${statusPill(info.label, info.tone)}
      </div>
      <p class="gs-tile-desc">${clampText(skill.description ?? "", 140)}</p>
      <div class="gs-tile-foot">
        <span class="gs-chips">
          <span class="gt-chip">${category}</span>
          ${skill.primaryEnv ? html`<span class="gt-chip" title=${skill.primaryEnv}>${icons.key} ${skill.primaryEnv}</span>` : nothing}
          ${managed ? html`<span class="gt-chip" data-tone="gold">yours</span>` : nothing}
        </span>
        ${ready
          ? html`<button class="gt-btn" ?disabled=${busy} @click=${(e: Event) => { e.stopPropagation(); props.onToggle(skill.skillKey, false); }}>${t("skills.card.disable", undefined, "Disable")}</button>`
          : skill.disabled
            ? html`<button class="gt-btn gt-primary" ?disabled=${busy} @click=${(e: Event) => { e.stopPropagation(); props.onToggle(skill.skillKey, true); }}>${t("skills.card.enable", undefined, "Enable")}</button>`
            : skill.install.length > 0
              ? html`<button class="gt-btn gt-primary" ?disabled=${busy} @click=${(e: Event) => { e.stopPropagation(); props.onInstall(skill.skillKey, skill.name, skill.install[0].id); }}>${icons.download} ${busy ? "…" : t("skills.card.install", undefined, "Install")}</button>`
              : nothing}
      </div>
    </div>
  `;
}

function renderAdvancedSection(props: SkillsProps, skills: SkillStatusEntry[]) {
  const filter = _discoverSearch.trim().toLowerCase();
  const filtered = filter
    ? skills.filter((skill) => [skill.name, skill.description, skill.source].join(" ").toLowerCase().includes(filter))
    : skills;
  return html`
    <div style="display:grid; gap: 16px;">
      <!-- MCP Management Section -->
      <div class="gs-card">
        <div class="gs-card-head">
          <div class="gs-card-main">
            <div class="gs-card-title">${icons.plug} MCP Servers</div>
            <div class="gs-card-sub">Install and manage Model Context Protocol servers.</div>
          </div>
          <div class="gs-actions">
            <a href="http://localhost:5500" target="_blank" class="gt-btn" style="text-decoration:none;">ANKHUI Admin ${icons.externalLink}</a>
            <a href="http://localhost:8889/admin/tasks" target="_blank" class="gt-btn" style="text-decoration:none;">MCP Tasks ${icons.externalLink}</a>
          </div>
        </div>
        <div class="gs-card-sub">
          <strong>Broker:</strong> <code>ws://localhost:8890</code> •
          <strong>Health:</strong> <code>http://localhost:8890/health</code>
        </div>
      </div>

      <div class="gs-sec">
        <div class="gs-panel-head">
          <div class="gs-sec-head" style="flex:1;">Raw skill list <span class="gs-count">${filtered.length}</span></div>
          <button class="gt-btn" ?disabled=${props.loading || skills.length === 0}
            @click=${() => { _showBrowseModal = true; _browseSearch = _discoverSearch; _browseFilter = "all"; _browseSelectedKey = null; _rerender(); }}>
            ${icons.search} Browse modal
          </button>
        </div>
        ${filtered.length === 0
          ? html`<div class="gs-meta">No skills.</div>`
          : html`<div class="gs-list">${filtered.map((skill) => renderSkill(skill, props))}</div>`}
      </div>
    </div>
  `;
}

// ── Skill detail drawer ───────────────────────────────────────────────────────

function renderSkillDrawer(props: SkillsProps) {
  const skill = (props.report?.skills ?? []).find((s) => s.skillKey === _drawerKey);
  if (!skill) { _drawerKey = null; return nothing; }
  const busy = props.busyKey === skill.skillKey;
  const info = statusInfo(skill);
  const apiKey = props.edits[skill.skillKey] ?? "";
  const message = props.messages[skill.skillKey] ?? null;
  const managed = isManagedSkill(skill, props);
  const trigger = extractTrigger(skill.description ?? "");
  const category = deriveCategory(skill);
  // Requirements with live satisfied/missing state (bins, env, config, os).
  const reqs: Array<{ kind: string; name: string; missing: boolean }> = [
    ...skill.requirements.bins.map((b) => ({ kind: "bin", name: b, missing: skill.missing.bins.includes(b) })),
    ...skill.requirements.env.map((e) => ({ kind: "env", name: e, missing: skill.missing.env.includes(e) })),
    ...skill.requirements.config.map((c) => ({ kind: "config", name: c, missing: skill.missing.config.includes(c) })),
    ...skill.requirements.os.map((o) => ({ kind: "os", name: o, missing: skill.missing.os.includes(o) })),
  ];
  const close = () => { _drawerKey = null; _rerender(); };
  const invocations = [`@${skill.skillKey}`, `/skill ${skill.skillKey}`];

  return html`
    <div
      class="gt-scope gs-overlay"
      data-kind="skill"
      @keydown=${(e: KeyboardEvent) => { if (e.key === "Escape") close(); }}
    >
      ${glassToolsStyle()}
      ${glassSkillsStyle()}
      <div class="gs-scrim" @click=${close}></div>
      <aside
        class="gs-drawer gt-glass"
        role="dialog"
        aria-modal="true"
        aria-label=${skill.name}
        @click=${(e: Event) => e.stopPropagation()}
      >
        <!-- Header -->
        <header class="gs-drawer-head">
          ${skillGlyph(skill, "lg", category)}
          <div class="gs-drawer-id">
            <h2 class="gs-drawer-title">${skill.name}</h2>
            <span class="gs-drawer-key">${skill.skillKey}</span>
            <div class="gs-chips" style="margin-top:6px;">
              ${statusPill(info.label, info.tone, info.key === "ready")}
            </div>
          </div>
          <button class="gs-close" aria-label="Close" title="Close (Esc)" @click=${close}>${icons.x}</button>
        </header>

        <div class="gs-drawer-body">
          <!-- Facts -->
          <div class="gs-facts">
            <div class="gs-fact"><span class="gs-dlabel">Category</span><span class="gs-fact-v">${category}</span></div>
            <div class="gs-fact"><span class="gs-dlabel">Source</span><span class="gs-fact-v" title=${skill.source}>${skill.source}</span></div>
            <div class="gs-fact"><span class="gs-dlabel">Eligible</span><span class="gs-fact-v"><span class="gt-light" data-state=${skill.eligible ? "ok" : "danger"}></span>${skill.eligible ? "Yes" : "No"}</span></div>
            <div class="gs-fact"><span class="gs-dlabel">Owner</span><span class="gs-fact-v">${managed ? "Yours" : skill.always ? "Always on" : "Bundled"}</span></div>
          </div>

          <!-- Description -->
          <div class="gs-dsec">
            <span class="gs-dlabel">${t("skills.drawer.about", undefined, "About")}</span>
            <p class="gs-dtext">${skill.description}</p>
          </div>

          <!-- Trigger conditions -->
          ${trigger
            ? html`<div class="gs-dsec">
                <span class="gs-dlabel">${t("skills.drawer.triggers", undefined, "Trigger conditions")}</span>
                <p class="gs-dtext" data-dim>${trigger}</p>
              </div>`
            : nothing}

          <!-- Example invocations -->
          <div class="gs-dsec">
            <span class="gs-dlabel">${t("skills.drawer.examples", undefined, "Example invocations")}</span>
            ${invocations.map((inv) => html`
              <div class="gs-invoke">
                <code>${inv}</code>
                <button class="gs-copy" ?data-done=${_copiedText === inv} aria-label=${`Copy ${inv}`} title="Copy" @click=${() => copyText(inv)}>
                  ${_copiedText === inv ? icons.check : icons.copy}
                </button>
              </div>
            `)}
          </div>

          <!-- Tools / requirements -->
          ${reqs.length > 0
            ? html`<div class="gs-dsec">
                <span class="gs-dlabel">${t("skills.drawer.tools", undefined, "Tools & requirements")}</span>
                <div class="gs-reqs">
                  ${reqs.map((r) => html`
                    <div class="gs-req" title=${r.missing ? "Missing" : "Satisfied"}>
                      <span class="gt-light" data-state=${r.missing ? "warn" : "ok"}></span>
                      <span>${r.name}</span>
                      <span class="gs-req-kind">${r.kind}${r.missing ? " · missing" : ""}</span>
                    </div>
                  `)}
                </div>
              </div>`
            : nothing}

          <!-- Install -->
          ${skill.install.length > 0 && (skill.missing.bins.length > 0 || !skill.eligible)
            ? html`<div class="gs-dsec">
                <span class="gs-dlabel">${t("skills.drawer.install", undefined, "Install")}</span>
                <div class="gs-actions">
                  ${skill.install.map((opt) => html`
                    <button class="gt-btn gt-primary" ?disabled=${busy}
                      @click=${() => props.onInstall(skill.skillKey, skill.name, opt.id)}>${icons.download} ${busy ? "Installing…" : opt.label}</button>
                  `)}
                </div>
              </div>`
            : nothing}

          <!-- API key -->
          ${skill.primaryEnv
            ? html`<div class="gs-dsec">
                <span class="gs-dlabel">${t("skills.drawer.apiKey", undefined, "API key")} (${skill.primaryEnv})</span>
                <div class="gs-inline">
                  <input class="gt-input" type="password" autocomplete="off" .value=${apiKey}
                    aria-label=${`${skill.primaryEnv} value`}
                    @input=${(e: Event) => props.onEdit(skill.skillKey, (e.target as HTMLInputElement).value)}
                    placeholder="Set ${skill.primaryEnv}" />
                  <button class="gt-btn gt-primary" ?disabled=${busy} @click=${() => props.onSaveKey(skill.skillKey)}>${icons.key} Save</button>
                </div>
              </div>`
            : nothing}

          ${message ? note(message.kind === "error" ? "danger" : "ok", message.message) : nothing}
        </div>

        <!-- Actions -->
        <footer class="gs-drawer-foot">
          <button class="gt-btn ${skill.disabled ? "gt-primary" : ""}" ?disabled=${busy}
            @click=${() => props.onToggle(skill.skillKey, skill.disabled)}>
            ${skill.disabled ? icons.play : icons.pause}
            ${skill.disabled ? t("skills.card.enable", undefined, "Enable") : t("skills.card.disable", undefined, "Disable")}
          </button>
          ${managed && props.onAuthorSkill
            ? html`<button class="gt-btn" @click=${() => openAuthor(skill)}>${icons.penLine} ${t("skills.drawer.edit", undefined, "Edit")}</button>`
            : nothing}
          ${skill.filePath
            ? html`<a class="gt-btn" href="vscode://file/${skill.filePath}" title=${skill.filePath} style="text-decoration:none;">${icons.externalLink} ${t("skills.drawer.openFile", undefined, "Open file")}</a>`
            : nothing}
          ${managed && props.onDeleteSkill
            ? html`<button class="gt-btn gt-danger gs-push" ?disabled=${busy}
                @click=${() => {
                  if (confirm(`Delete skill "${skill.name}"? This removes its SKILL.md.`)) {
                    props.onDeleteSkill?.(skill.skillKey, skill.filePath);
                    _drawerKey = null;
                  }
                }}>${icons.trash} ${t("skills.drawer.delete", undefined, "Delete")}</button>`
            : nothing}
        </footer>
      </aside>
    </div>
  `;
}

// ── Author / edit form drawer ─────────────────────────────────────────────────

function slugify(raw: string): string {
  return raw.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

function openAuthor(skill: SkillStatusEntry | null) {
  _authorOpen = true;
  if (skill) {
    _authorEditKey = skill.skillKey;
    _authorForm = {
      name: skill.name,
      slug: skill.skillKey,
      description: skill.description ?? "",
      emoji: skill.emoji ?? "",
      category: deriveCategory(skill),
      whenToUse: extractTrigger(skill.description ?? "") ?? "",
      tools: skill.requirements.bins.join(", "),
      systemPrompt: "",
    };
  } else {
    _authorEditKey = null;
    _authorForm = blankAuthorForm();
  }
  _rerender();
}

const AUTHOR_CATEGORIES = ["Code Review", "Design", "Research", "DevOps", "Writing", "Media", "Communication", "Productivity", "Personal", "Coding", "Other"];

function renderAuthorDrawer(props: SkillsProps) {
  const f = _authorForm;
  const effectiveSlug = f.slug.trim() ? slugify(f.slug) : slugify(f.name);
  const valid = f.name.trim().length > 0 && f.description.trim().length > 0 && effectiveSlug.length > 0;
  const message = props.messages["author"] ?? null;
  const fieldLabel = (text: string, hint?: string) => html`
    <span><span class="gs-field-label">${text}</span>${hint ? html`<span class="gs-field-hint">${hint}</span>` : nothing}</span>`;
  const close = () => { _authorOpen = false; _rerender(); };

  return html`
    <div
      class="gt-scope gs-overlay"
      data-kind="author"
      @keydown=${(e: KeyboardEvent) => { if (e.key === "Escape") close(); }}
    >
      ${glassToolsStyle()}
      ${glassSkillsStyle()}
      <div class="gs-scrim" @click=${close}></div>
      <aside class="gs-drawer gt-glass" role="dialog" aria-modal="true"
        aria-label=${_authorEditKey ? t("skills.author.editTitle", undefined, "Edit skill") : t("skills.author.newTitle", undefined, "Create a new skill")}
        @click=${(e: Event) => e.stopPropagation()}>
        <header class="gs-drawer-head">
          ${skillGlyph({ name: f.name || "New skill", emoji: f.emoji }, "lg", f.category || undefined)}
          <div class="gs-drawer-id">
            <span class="gt-eyebrow">${_authorEditKey ? "Edit" : "Author"}</span>
            <h2 class="gs-drawer-title">
              ${_authorEditKey ? t("skills.author.editTitle", undefined, "Edit skill") : t("skills.author.newTitle", undefined, "Create a new skill")}
            </h2>
            <span class="gs-drawer-key">${effectiveSlug || "…"}</span>
          </div>
          <button class="gs-close" aria-label="Close" title="Close (Esc)" @click=${close}>${icons.x}</button>
        </header>

        <div class="gs-drawer-body" style="gap:16px;">
          <p class="gs-dtext" data-dim style="margin-top:-4px;">
            ${t("skills.author.help", undefined, "Fill in the fields below — we generate the SKILL.md for you. No raw markdown required.")}
          </p>

          <div class="gs-field-row">
            <label class="gs-field">
              ${fieldLabel(t("skills.author.name", undefined, "Name"))}
              <input class="gt-input" .value=${f.name}
                @input=${(e: Event) => { _authorForm = { ...f, name: (e.target as HTMLInputElement).value }; _rerender(); }}
                placeholder="Code Reviewer" />
            </label>
            <label class="gs-field">
              ${fieldLabel(t("skills.author.emoji", undefined, "Emoji"))}
              <input class="gt-input" .value=${f.emoji} maxlength="4"
                @input=${(e: Event) => { _authorForm = { ...f, emoji: (e.target as HTMLInputElement).value }; _rerender(); }}
                placeholder="🔍" />
            </label>
          </div>

          <label class="gs-field">
            ${fieldLabel(t("skills.author.slug", undefined, "Slug"), `→ ${effectiveSlug || "…"}`)}
            <input class="gt-input" style="font-family: var(--mono); font-size: 12.5px;" .value=${f.slug} ?disabled=${Boolean(_authorEditKey)}
              @input=${(e: Event) => { _authorForm = { ...f, slug: (e.target as HTMLInputElement).value }; _rerender(); }}
              placeholder="auto from name" />
          </label>

          <label class="gs-field">
            ${fieldLabel(t("skills.author.description", undefined, "Description"))}
            <textarea class="gt-input" .value=${f.description}
              @input=${(e: Event) => { _authorForm = { ...f, description: (e.target as HTMLTextAreaElement).value }; _rerender(); }}
              placeholder="One or two lines describing what this skill does."></textarea>
          </label>

          <label class="gs-field">
            ${fieldLabel(t("skills.author.category", undefined, "Category"))}
            <select class="gt-input" .value=${f.category}
              @change=${(e: Event) => { _authorForm = { ...f, category: (e.target as HTMLSelectElement).value }; _rerender(); }}>
              <option value="">—</option>
              ${AUTHOR_CATEGORIES.map((c) => html`<option value=${c} ?selected=${f.category === c}>${c}</option>`)}
            </select>
          </label>

          <label class="gs-field">
            ${fieldLabel(t("skills.author.whenToUse", undefined, "Trigger / when to use"))}
            <textarea class="gt-input" style="min-height:62px;" .value=${f.whenToUse}
              @input=${(e: Event) => { _authorForm = { ...f, whenToUse: (e.target as HTMLTextAreaElement).value }; _rerender(); }}
              placeholder="Use when the user asks to review a diff or audit code for bugs."></textarea>
          </label>

          <label class="gs-field">
            ${fieldLabel(t("skills.author.tools", undefined, "Allowed tools"), "comma-separated")}
            <input class="gt-input" .value=${f.tools}
              @input=${(e: Event) => { _authorForm = { ...f, tools: (e.target as HTMLInputElement).value }; _rerender(); }}
              placeholder="Read, Grep, Bash" />
          </label>

          <label class="gs-field">
            ${fieldLabel(t("skills.author.instructions", undefined, "Instructions / system prompt"), "optional")}
            <textarea class="gt-input" style="min-height:140px; font-family: var(--mono); font-size: 12px;" .value=${f.systemPrompt}
              @input=${(e: Event) => { _authorForm = { ...f, systemPrompt: (e.target as HTMLTextAreaElement).value }; _rerender(); }}
              placeholder="Step-by-step guidance the agent should follow when this skill fires."></textarea>
          </label>

          ${message ? note(message.kind === "error" ? "danger" : "ok", message.message) : nothing}
        </div>

        <footer class="gs-drawer-foot">
          <button class="gt-btn gt-primary" ?disabled=${!valid || !props.onAuthorSkill}
            @click=${() => {
              if (!valid) return;
              props.onAuthorSkill?.({
                slug: effectiveSlug,
                name: f.name.trim(),
                description: f.description.trim(),
                emoji: f.emoji.trim() || undefined,
                category: f.category.trim() || undefined,
                whenToUse: f.whenToUse.trim() || undefined,
                allowedTools: f.tools.split(",").map((s) => s.trim()).filter(Boolean),
                systemPrompt: f.systemPrompt.trim() || undefined,
              });
              _authorOpen = false;
              _rerender();
            }}>
            ${icons.check} ${_authorEditKey ? t("skills.author.save", undefined, "Save changes") : t("skills.author.create", undefined, "Create skill")}
          </button>
          <button class="gt-btn" @click=${close}>${t("common.cancel", undefined, "Cancel")}</button>
        </footer>
      </aside>
    </div>
  `;
}

// ── Queue filter (drafts + healing) ───────────────────────────────────────────

function renderQueueFilter(
  current: QueueFilter,
  counts: Record<string, number>,
  onPick: (f: QueueFilter) => void,
  labelFor: (f: QueueFilter) => string = (f) => f,
) {
  return html`
    <div class="gt-seg gs-statusseg" role="group" aria-label="Filter">
      ${(["all", "pending", "accepted", "rejected"] as const).map((f) => html`
        <button aria-pressed=${current === f ? "true" : "false"} @click=${() => onPick(f)} style="text-transform: capitalize;">
          ${labelFor(f)} <span class="gs-cat-n">${counts[f]}</span>
        </button>
      `)}
    </div>
  `;
}

// ── Drafts tab ────────────────────────────────────────────────────────────────

function renderDraftsTab(props: SkillsProps) {
  const allDrafts = props.drafts ?? [];
  const filtered = allDrafts.filter((d) =>
    _draftsFilter === "all" ? true : d.status === _draftsFilter,
  );
  const counts: Record<string, number> = {
    all: allDrafts.length,
    pending: allDrafts.filter((d) => d.status === "pending").length,
    accepted: allDrafts.filter((d) => d.status === "accepted").length,
    rejected: allDrafts.filter((d) => d.status === "rejected").length,
  };

  return html`
    <section class="gt-glass gs-panel gt-rise" data-learn-id="skills-drafts">
      ${panelHead(
        icons.sparkles,
        "Skill Drafts",
        "Auto-generated skill candidates from completed runs — review before promoting.",
        html`<button class="gt-btn" ?disabled=${props.draftsLoading} @click=${props.onDraftsRefresh}>
          ${icons.refresh} ${props.draftsLoading ? "Loading…" : "Refresh"}
        </button>`,
      )}

      ${renderQueueFilter(_draftsFilter, counts, (f) => { _draftsFilter = f; _rerender(); })}

      ${props.draftsError ? note("danger", props.draftsError) : nothing}

      ${props.draftsLoading && allDrafts.length === 0
        ? html`<div class="gs-list">${[0, 1, 2].map(() => html`<div class="gt-skel" style="height:74px;border-radius:16px;"></div>`)}</div>`
        : filtered.length === 0
          ? emptyState(
              icons.sparkles,
              allDrafts.length === 0 ? "No drafts yet" : `No ${_draftsFilter} drafts`,
              allDrafts.length === 0
                ? "No drafts yet. Drafts appear after agents complete substantial tasks."
                : `No ${_draftsFilter} drafts.`,
            )
          : html`<div class="gs-list">
              ${filtered.map((draft) => renderDraftCard(draft, props))}
            </div>`}
    </section>
  `;
}

function renderDraftCard(draft: SkillDraftUi, props: SkillsProps) {
  const isExpanded = _draftExpanded.has(draft.id);
  const isEditing = _draftEditing.has(draft.id);
  const editedMd = _draftEditing.get(draft.id) ?? "";
  const isRejectOpen = _draftRejectOpen.has(draft.id);
  const rejectReason = _draftRejectInput.get(draft.id) ?? "";
  const busy = props.busyKey === `draft:${draft.id}`;
  const msg = props.messages[`draft:${draft.id}`];

  const tone: Tone = draft.status === "accepted" ? "ok"
    : draft.status === "rejected" ? "danger"
    : "gold";

  return html`
    <div class="gs-card" data-tone=${draft.status === "pending" ? "gold" : tone}>
      <!-- Header row -->
      <div class="gs-card-head">
        ${skillGlyph({ name: draft.slug }, "sm")}
        <div class="gs-card-main">
          <div class="gs-card-title">
            <span>${draft.slug}</span>
            <span class="gt-chip">${draft.source}</span>
            ${statusPill(draft.status, tone, draft.status === "pending")}
          </div>
          <div class="gs-meta">
            ${formatRelativeMs(draft.proposedAt)} ago
            ${draft.triggerOp ? html` — <span title=${draft.triggerOp}>${clampText(draft.triggerOp, 80)}</span>` : nothing}
          </div>
        </div>
        ${draft.status === "pending" ? html`
          <div class="gs-actions">
            <button class="gt-btn" ?disabled=${busy} aria-expanded=${isExpanded ? "true" : "false"} @click=${async () => {
              if (!isExpanded) {
                _draftExpanded.add(draft.id);
                if (!draft.skillMd && props.onDraftGetContent) {
                  const c = await props.onDraftGetContent(draft.id);
                  if (c) { _draftEditing.delete(draft.id); draft.skillMd = c.skillMd; }
                }
              } else {
                _draftExpanded.delete(draft.id);
              }
              _rerender();
            }}>
              ${isExpanded ? icons.chevronUp : icons.eye} ${isExpanded ? "Collapse" : "Review"}
            </button>
            <button class="gt-btn gt-primary" ?disabled=${busy} @click=${() => {
              const scope = "infinibot" as DraftScope;
              props.onDraftAccept?.(draft.id, scope, _draftEditing.get(draft.id));
            }}>
              ${busy ? "…" : html`${icons.check} Accept`}
            </button>
            <button class="gt-btn gt-danger" ?disabled=${busy} @click=${() => {
              _draftRejectOpen.add(draft.id);
              _rerender();
            }}>${icons.x} Reject</button>
          </div>
        ` : nothing}
        ${draft.status !== "pending" ? html`
          <div class="gs-meta">
            ${draft.status === "accepted" ? `Accepted ${formatRelativeMs(draft.reviewedAt ?? 0)} ago` : ""}
            ${draft.status === "rejected" ? `Rejected ${formatRelativeMs(draft.reviewedAt ?? 0)} ago${draft.rejectReason ? `: ${draft.rejectReason}` : ""}` : ""}
          </div>
        ` : nothing}
      </div>

      <!-- Reject reason input -->
      ${isRejectOpen ? html`
        <div class="gs-inline">
          <input
            class="gt-input"
            type="text"
            placeholder="Reason (optional)"
            .value=${rejectReason}
            @input=${(e: Event) => _draftRejectInput.set(draft.id, (e.target as HTMLInputElement).value)}
          />
          <button class="gt-btn gt-danger" ?disabled=${busy} @click=${() => {
            props.onDraftReject?.(draft.id, _draftRejectInput.get(draft.id));
            _draftRejectOpen.delete(draft.id);
            _draftRejectInput.delete(draft.id);
          }}>Confirm</button>
          <button class="gt-btn" @click=${() => { _draftRejectOpen.delete(draft.id); _rerender(); }}>Cancel</button>
        </div>
      ` : nothing}

      <!-- Expanded: full content + edit -->
      ${isExpanded ? html`
        <div class="gs-card-split">
          ${isEditing ? html`
            <textarea
              class="gt-input gs-textarea"
              .value=${editedMd}
              @input=${(e: Event) => _draftEditing.set(draft.id, (e.target as HTMLTextAreaElement).value)}
            ></textarea>
            <div class="gs-actions">
              <span class="gs-meta">Target scope:</span>
              ${(["infinibot", "user", "workspace"] as DraftScope[]).map((scope) => html`
                <button class="gt-btn" @click=${() => {
                  props.onDraftAccept?.(draft.id, scope, _draftEditing.get(draft.id));
                  _draftEditing.delete(draft.id);
                  _draftExpanded.delete(draft.id);
                }}>Accept → ${scope}</button>
              `)}
              <button class="gt-btn" @click=${() => { _draftEditing.delete(draft.id); _rerender(); }}>Cancel edit</button>
            </div>
          ` : html`
            <pre class="gs-code">${draft.skillMd ?? "(content not available)"}</pre>
            <div class="gs-actions">
              <button class="gt-btn" @click=${() => {
                _draftEditing.set(draft.id, draft.skillMd ?? "");
                _rerender();
              }}>${icons.penLine} Edit before accept</button>
              ${(["infinibot", "user", "workspace"] as DraftScope[]).map((scope) => html`
                <button class="gt-btn gt-primary" @click=${() => {
                  props.onDraftAccept?.(draft.id, scope, undefined);
                }}>Accept → ${scope}</button>
              `)}
            </div>
          `}
        </div>
      ` : nothing}

      ${msg ? note(msg.kind === "error" ? "danger" : "ok", msg.message) : nothing}
    </div>
  `;
}

// ── Healing tab ───────────────────────────────────────────────────────────────

function renderHealingTab(props: SkillsProps) {
  const allProposals = props.healingProposals ?? [];
  const filtered = allProposals.filter((h) =>
    _healingFilter === "all" ? true :
    _healingFilter === "accepted" ? h.status === "applied" :
    _healingFilter === "rejected" ? h.status === "rejected" :
    h.status === "pending",
  );
  const counts: Record<string, number> = {
    all: allProposals.length,
    pending: allProposals.filter((h) => h.status === "pending").length,
    accepted: allProposals.filter((h) => h.status === "applied").length,
    rejected: allProposals.filter((h) => h.status === "rejected").length,
  };

  return html`
    <section class="gt-glass gs-panel gt-rise" data-learn-id="skills-healing">
      ${panelHead(
        icons.wrench,
        "Healing Proposals",
        "Proposed corrections to existing skills, triggered by task failures.",
        html`<button class="gt-btn" ?disabled=${props.healingLoading} @click=${props.onHealingRefresh}>
          ${icons.refresh} ${props.healingLoading ? "Loading…" : "Refresh"}
        </button>`,
      )}

      ${renderQueueFilter(_healingFilter, counts, (f) => { _healingFilter = f; _rerender(); }, (f) => (f === "accepted" ? "applied" : f))}

      ${props.healingError ? note("danger", props.healingError) : nothing}

      ${props.healingLoading && allProposals.length === 0
        ? html`<div class="gs-list">${[0, 1, 2].map(() => html`<div class="gt-skel" style="height:84px;border-radius:16px;"></div>`)}</div>`
        : filtered.length === 0
          ? emptyState(
              icons.wrench,
              allProposals.length === 0 ? "No healing proposals yet" : `No ${_healingFilter} proposals`,
              allProposals.length === 0
                ? "No healing proposals yet. These appear when agents report skill failures via SKILL_ISSUE."
                : `No ${_healingFilter} proposals.`,
            )
          : html`<div class="gs-list">
              ${filtered.map((h) => renderHealingCard(h, props))}
            </div>`}
    </section>
  `;
}

function renderHealingCard(healing: HealingProposalUi, props: SkillsProps) {
  const isExpanded = _healingExpanded.has(healing.id);
  const isEditing = _healingEditing.has(healing.id);
  const editedMd = _healingEditing.get(healing.id) ?? "";
  const isRejectOpen = _healingRejectOpen.has(healing.id);
  const rejectReason = _healingRejectInput.get(healing.id) ?? "";
  const busy = props.busyKey === `healing:${healing.id}`;
  const msg = props.messages[`healing:${healing.id}`];

  const tone: Tone = healing.status === "applied" ? "ok"
    : healing.status === "rejected" ? "danger"
    : "warn";

  return html`
    <div class="gs-card" data-tone=${tone}>
      <div class="gs-card-head">
        ${skillGlyph({ name: healing.skillName }, "sm")}
        <div class="gs-card-main">
          <div class="gs-card-title">
            <span>${healing.skillName}</span>
            ${statusPill(healing.status === "applied" ? "applied" : healing.status, tone, healing.status === "pending")}
          </div>
          <div class="gs-meta">${formatRelativeMs(healing.proposedAt)} ago</div>
          <div class="gs-card-sub">${clampText(healing.reason, 120)}</div>
        </div>
        ${healing.status === "pending" ? html`
          <div class="gs-actions">
            <button class="gt-btn" ?disabled=${busy} aria-expanded=${isExpanded ? "true" : "false"} @click=${async () => {
              if (!isExpanded) {
                _healingExpanded.add(healing.id);
                if (!healing.diff && props.onHealingGetContent) {
                  const c = await props.onHealingGetContent(healing.id);
                  if (c) { healing.diff = c.diff; healing.proposedMd = c.proposedMd; healing.currentMd = c.currentMd; }
                }
              } else {
                _healingExpanded.delete(healing.id);
              }
              _rerender();
            }}>
              ${isExpanded ? icons.chevronUp : icons.fileCode} ${isExpanded ? "Collapse" : "Show Diff"}
            </button>
            <button class="gt-btn gt-primary" ?disabled=${busy} @click=${() => {
              props.onHealingApply?.(healing.id, _healingEditing.get(healing.id));
            }}>
              ${busy ? "…" : html`${icons.check} Apply`}
            </button>
            <button class="gt-btn gt-danger" ?disabled=${busy} @click=${() => {
              _healingRejectOpen.add(healing.id);
              _rerender();
            }}>${icons.x} Reject</button>
          </div>
        ` : html`
          <div class="gs-meta">
            ${healing.status === "applied" ? `Applied ${formatRelativeMs(healing.reviewedAt ?? 0)} ago` : ""}
            ${healing.status === "rejected" ? `Rejected${healing.rejectReason ? `: ${healing.rejectReason}` : ""}` : ""}
          </div>
        `}
      </div>

      ${isRejectOpen ? html`
        <div class="gs-inline">
          <input class="gt-input" type="text" placeholder="Reason (optional)" .value=${rejectReason}
            @input=${(e: Event) => _healingRejectInput.set(healing.id, (e.target as HTMLInputElement).value)}
          />
          <button class="gt-btn gt-danger" ?disabled=${busy} @click=${() => {
            props.onHealingReject?.(healing.id, _healingRejectInput.get(healing.id));
            _healingRejectOpen.delete(healing.id);
            _healingRejectInput.delete(healing.id);
          }}>Confirm</button>
          <button class="gt-btn" @click=${() => { _healingRejectOpen.delete(healing.id); _rerender(); }}>Cancel</button>
        </div>
      ` : nothing}

      ${isExpanded ? html`
        <div class="gs-card-split">
          ${isEditing ? html`
            <textarea
              class="gt-input gs-textarea"
              .value=${editedMd}
              @input=${(e: Event) => _healingEditing.set(healing.id, (e.target as HTMLTextAreaElement).value)}
            ></textarea>
            <div class="gs-actions">
              <button class="gt-btn gt-primary" @click=${() => {
                props.onHealingApply?.(healing.id, _healingEditing.get(healing.id));
                _healingEditing.delete(healing.id);
              }}>Apply edited</button>
              <button class="gt-btn" @click=${() => { _healingEditing.delete(healing.id); _rerender(); }}>Cancel</button>
            </div>
          ` : html`
            ${healing.diff ? renderDiffView(healing.diff) : html`<div class="gt-skel" style="height:120px;border-radius:12px;" aria-label="Loading diff…"></div>`}
            <div class="gs-actions">
              <button class="gt-btn" @click=${() => {
                _healingEditing.set(healing.id, healing.proposedMd ?? "");
                _rerender();
              }}>${icons.penLine} Edit before apply</button>
            </div>
          `}
        </div>
      ` : nothing}

      ${msg ? note(msg.kind === "error" ? "danger" : "ok", msg.message) : nothing}
    </div>
  `;
}

function renderDiffView(diff: string) {
  if (!diff || diff === "(no changes)") {
    return html`<div class="gs-meta">(no changes)</div>`;
  }
  const lines = diff.split("\n");
  return html`
    <pre class="gs-code">${lines.map((line) => {
      const cls = line.startsWith("+") ? "gs-add"
        : line.startsWith("-") ? "gs-del"
        : "gs-ctx";
      return html`<span class=${cls}>${line}</span>`;
    })}</pre>
  `;
}

// ── Activity tab ──────────────────────────────────────────────────────────────

function renderActivityTab(props: SkillsProps) {
  const events = props.activity ?? [];
  const typeIcon: Record<string, string> = {
    draft_created: "🧬",
    draft_accepted: "✅",
    draft_rejected: "❌",
    healing_queued: "🩹",
    healing_applied: "✓",
    healing_rejected: "✕",
  };

  return html`
    <section class="gt-glass gs-panel gt-rise">
      ${panelHead(
        icons.activity,
        "Skill System Activity",
        "Recent skill system events — drafts, healing, and review actions.",
        html`<button class="gt-btn" ?disabled=${props.activityLoading} @click=${props.onActivityRefresh}>
          ${icons.refresh} ${props.activityLoading ? "Loading…" : "Refresh"}
        </button>`,
      )}

      ${props.activityLoading && events.length === 0
        ? html`<div class="gs-list">${[0, 1, 2, 3].map(() => html`<div class="gt-skel" style="height:48px;border-radius:14px;"></div>`)}</div>`
        : events.length === 0
          ? emptyState(
              icons.activity,
              "No activity yet",
              "No activity yet. Events appear after agents run and the skill system triggers reflection or healing.",
            )
          : html`
            <div class="gs-timeline">
              ${events.map((evt) => html`
                <div
                  class="gs-event"
                  ?data-link=${Boolean(evt.relatedId)}
                  role=${evt.relatedId ? "button" : "listitem"}
                  tabindex=${evt.relatedId ? "0" : "-1"}
                  @click=${() => {
                    if (!evt.relatedId) return;
                    if (evt.type.startsWith("draft")) {
                      _skillsTab = "drafts";
                      _draftsFilter = "all";
                    } else if (evt.type.startsWith("healing")) {
                      _skillsTab = "healing";
                      _healingFilter = "all";
                    }
                    _rerender();
                  }}
                  @keydown=${(e: KeyboardEvent) => { if ((e.key === "Enter" || e.key === " ") && evt.relatedId) { e.preventDefault(); (e.currentTarget as HTMLElement).click(); } }}
                >
                  <span class="gs-event-dot" aria-hidden="true">${typeIcon[evt.type] ?? "·"}</span>
                  <div style="min-width:0;">
                    <div class="gs-event-msg">${evt.message}</div>
                    <div class="gs-event-ts">${new Date(evt.ts).toLocaleString()}</div>
                  </div>
                </div>
              `)}
            </div>
          `}
    </section>
  `;
}

// ── Settings tab ──────────────────────────────────────────────────────────────

function renderSettingsTab(props: SkillsProps) {
  const cfg = props.skillConfig;
  const edits = _configEdits ?? {};
  const get = <K extends keyof SkillSystemConfig>(k: K): SkillSystemConfig[K] => {
    if (k in edits) return edits[k] as SkillSystemConfig[K];
    if (cfg && k in cfg) return cfg[k] as SkillSystemConfig[K];
    // Defaults applied when config hasn't loaded yet — match the
    // gateway's defaults in skills.config.get so toggles don't visibly
    // flip after the first load.
    if (k === "minDurationMs") return 300000 as SkillSystemConfig[K];
    if (k === "requireApproval") return false as SkillSystemConfig[K];
    return true as SkillSystemConfig[K];
  };
  const msg = props.messages["config"];

  return html`
    <section data-learn-id="skills-settings" class="gt-glass gs-panel gt-rise">
      ${panelHead(
        icons.sliders,
        "Skill System Settings",
        "Control when the system generates and proposes new skills.",
        props.skillConfigLoading ? html`<span class="gs-status" data-tone="gold"><span class="gt-light" data-state="gold" data-pulse></span>Loading…</span>` : undefined,
      )}

      <div class="gs-list" style="max-width: 720px;">

        ${renderToggle("Skill System Enabled", "Master on/off switch — disables reflection + healing when off.", get("enabled"),
          (v) => { _configEdits = { ...((_configEdits ?? {})), enabled: v }; _rerender(); })}

        ${renderToggle("Auto-generate skills from successful runs", "After runs ≥ min duration or starting with a task verb, spawn a reflection pass to identify reusable skill candidates.", get("autoGenerate"),
          (v) => { _configEdits = { ...((_configEdits ?? {})), autoGenerate: v }; _rerender(); })}

        ${renderToggle("Auto-queue healing proposals from failures", "When a run fails and output includes SKILL_ISSUE, run a post-mortem pass and queue a healing proposal.", get("autoHealing"),
          (v) => { _configEdits = { ...((_configEdits ?? {})), autoHealing: v }; _rerender(); })}

        ${renderToggle(
          "Require approval before installing self-generated skills",
          "Off (default): skills written by reflection auto-install into the InfiniBot skills directory and show in the Self-Generated section. On: drafts wait in the Drafts tab until you click Accept.",
          get("requireApproval"),
          (v) => {
            _configEdits = { ...((_configEdits ?? {})), requireApproval: v };
            _rerender();
          },
        )}

        <div class="gs-card gs-setting">
          <div style="flex:1; min-width:0;">
            <div class="gs-setting-label">Minimum run duration for reflection</div>
            <div class="gs-setting-desc">Runs shorter than this don't trigger reflection unless the task starts with a qualifying verb.</div>
          </div>
          <div class="gs-inline" style="flex:none; flex-wrap:nowrap;">
            <input
              class="gt-input"
              type="number"
              min="1"
              max="60"
              aria-label="Minimum run duration in minutes"
              .value=${String(Math.round(get("minDurationMs") / 60000))}
              @input=${(e: Event) => {
                const val = Number((e.target as HTMLInputElement).value);
                if (val > 0) { _configEdits = { ...((_configEdits ?? {})), minDurationMs: val * 60000 }; }
              }}
              style="width: 84px; flex: none; text-align: center; font-variant-numeric: tabular-nums;"
            />
            <span class="gs-meta">minutes</span>
          </div>
        </div>

        <div class="gs-actions" style="margin-top: 4px;">
          <button
            class="gt-btn gt-primary"
            ?disabled=${props.skillConfigSaving || !_configEdits}
            @click=${() => {
              if (_configEdits) {
                props.onSaveConfig?.(_configEdits);
                _configEdits = null;
              }
            }}
          >
            ${icons.save} ${props.skillConfigSaving ? "Saving…" : "Save Settings"}
          </button>
          ${_configEdits ? html`<button class="gt-btn" @click=${() => { _configEdits = null; _rerender(); }}>Reset</button>` : nothing}
          ${_configEdits ? html`<span class="gs-status" data-tone="warn"><span class="gt-light" data-state="warn"></span>Unsaved changes</span>` : nothing}
        </div>

        ${msg ? note(msg.kind === "error" ? "danger" : "ok", msg.message) : nothing}
      </div>
    </section>
  `;
}

function renderToggle(
  label: string,
  description: string,
  value: boolean,
  onChange: (next: boolean) => void,
) {
  return html`
    <div class="gs-card gs-setting">
      <div style="flex: 1; min-width: 0;">
        <div class="gs-setting-label">${label}</div>
        <div class="gs-setting-desc">${description}</div>
      </div>
      <button
        class="gs-switch"
        role="switch"
        aria-checked=${value ? "true" : "false"}
        aria-label=${label}
        @click=${() => onChange(!value)}
      ></button>
    </div>
  `;
}

/**
 * "Self-Generated Skills" section — auto-accepted drafts, surfaced in
 * the active tab so the user can see what reflection has installed
 * without having to dig through the Drafts tab. With auto-approval on
 * (the default), drafts skip the pending state entirely and land here
 * the moment reflection finishes.
 */
function renderSelfGeneratedSection(props: SkillsProps) {
  const accepted = (props.drafts ?? [])
    .filter((d) => d.status === "accepted")
    .sort((a, b) => (b.reviewedAt ?? b.proposedAt) - (a.reviewedAt ?? a.proposedAt));
  if (accepted.length === 0) {
    // Hide entirely when there's nothing to show — the empty-state for
    // self-generated lives inside renderLearnedSkillsSection.
    return nothing;
  }
  const fmtAgo = (ts: number | undefined): string => {
    if (!ts) return "";
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  };
  return html`
    <section class="gt-glass gs-panel">
      ${panelHead(
        icons.sparkles,
        "Self-Generated Skills",
        html`Skills the agent wrote during reflection and auto-installed into
          <code>~/.infinibot/skills</code>. They're already active — search the
          grid above by name to inspect, or toggle approval back on in Settings to
          review future drafts manually.`,
        html`<span class="gt-chip" data-tone="gold">${accepted.length} installed</span>`,
      )}

      <div class="gs-cards">
        ${accepted.map(
          (d) => html`
            <div class="gs-card skill" data-tone="ok">
              <div class="gs-card-head" style="flex-wrap:nowrap; align-items:center;">
                ${skillGlyph({ name: d.slug }, "sm")}
                <div class="gs-card-main" style="flex:1;">
                  <div class="gs-card-title">${d.slug}</div>
                  <span class="gs-meta">${fmtAgo(d.reviewedAt ?? d.proposedAt)}</span>
                </div>
              </div>
              ${d.triggerOp
                ? html`<div class="gs-card-sub">
                    ${d.triggerOp.length > 110 ? `${d.triggerOp.slice(0, 110)}…` : d.triggerOp}
                  </div>`
                : nothing}
            </div>
          `,
        )}
      </div>
    </section>
  `;
}

function renderLearnedSkillsSection(props: SkillsProps) {
  const sorted = [...props.learnedSkills].sort((a, b) => {
    const av = a.usage?.invocations ?? 0;
    const bv = b.usage?.invocations ?? 0;
    if (av !== bv) return bv - av;
    return (b.updatedAt || "").localeCompare(a.updatedAt || "");
  });
  return html`
    <section class="gt-glass gs-panel" data-learn-id="skills-learned">
      ${panelHead(
        icons.brain,
        "Self-Generated Skills",
        `Skills the agent distilled from past runs. Refined automatically once each
          crosses the usage threshold; use the buttons below to inspect, refine on
          demand, or delete.`,
        html`
          <button
            class="gt-btn gt-primary"
            ?disabled=${props.learnedSelfImproveRunning || !props.learnedEnabled}
            @click=${props.onLearnedSelfImprove}
            title=${props.learnedEnabled
              ? "Reflect on recent trajectories and refine eligible skills"
              : "Cumulative skills disabled (INFINIBOT_CUMULATIVE_SKILLS=0)"}
          >
            ${icons.magicWand} ${props.learnedSelfImproveRunning ? "Refining…" : "Run Self-Improve"}
          </button>
          <button class="gt-btn" ?disabled=${props.learnedLoading} @click=${props.onLearnedRefresh}>
            ${icons.refresh} ${props.learnedLoading ? "Loading…" : "Refresh"}
          </button>
        `,
      )}

      ${!props.learnedEnabled
        ? note("gold", html`
            Cumulative-skills system is disabled. Set
            <code>INFINIBOT_CUMULATIVE_SKILLS=1</code> and restart the gateway to enable
            trajectory capture and self-improvement.`)
        : nothing}

      ${props.learnedError ? note("danger", props.learnedError) : nothing}

      ${props.learnedSelfImproveSummary ? note("ok", props.learnedSelfImproveSummary) : nothing}

      ${sorted.length === 0
        ? html`<div class="gs-card" style="justify-items:start;">
            <div class="gs-card-sub">
              No self-generated skills yet. The agent learns from completed runs once the
              quality gate is satisfied — give it a few non-trivial tasks first.
            </div>
          </div>`
        : html`
            <div class="gs-list">
              ${sorted.map((s) => renderLearnedSkill(s, props))}
            </div>
          `}
    </section>
  `;
}

function renderLearnedSkill(skill: LearnedSkill, props: SkillsProps) {
  const busyKey = `learned:${skill.name}`;
  const msg = props.messages[busyKey];
  const u = skill.usage ?? {
    invocations: 0,
    successes: 0,
    failures: 0,
    recentTrajectoryIds: [],
    skillKey: skill.name,
  };
  const successRate =
    u.invocations > 0 ? Math.round((u.successes / u.invocations) * 100) : null;
  return html`
    <div class="gs-card skill">
      <div class="gs-card-head">
        ${skillGlyph(skill, "sm")}
        <div class="gs-card-main">
          <div class="gs-card-title">${skill.name}</div>
          <div class="gs-card-sub">${clampText(skill.description, 180)}</div>
        </div>
        <div class="gs-actions">
          <button
            class="gt-btn gt-danger"
            ?disabled=${props.busyKey === busyKey}
            @click=${() => {
              if (confirm(`Delete learned skill "${skill.name}"? This removes the SKILL.md and its usage history.`)) {
                props.onLearnedDelete(skill.name);
              }
            }}
            title="Delete this learned skill"
          >${icons.trash} Delete</button>
        </div>
      </div>

      <div class="gs-chips" style="align-items:center;">
        <span class="gt-chip" data-tone="gold">${icons.barChart} ${u.invocations} uses</span>
        ${successRate !== null
          ? html`<span class="gt-chip" data-tone="ok">${icons.check} ${successRate}% success</span>`
          : nothing}
        ${u.failures > 0
          ? html`<span class="gt-chip" data-tone="danger">${icons.xCircle} ${u.failures} fail</span>`
          : nothing}
        ${u.lastRefinedAt
          ? html`<span class="gs-meta">refined ${formatRelative(u.lastRefinedAt)}</span>`
          : html`<span class="gs-meta">never refined</span>`}
        <span class="gs-meta">· created ${formatRelative(skill.createdAt)}</span>
        <span class="gs-meta" title=${skill.sourceTrajectoryId}>
          · from trajectory ${skill.sourceTrajectoryId.slice(0, 8)}…
        </span>
      </div>

      ${msg ? note(msg.kind === "error" ? "danger" : "ok", msg.message) : nothing}
    </div>
  `;
}

function formatRelativeMs(ms: number): string {
  if (!ms) return "unknown";
  return formatRelative(new Date(ms).toISOString());
}

function formatRelative(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(t).toISOString().slice(0, 10);
}

// ── Browse Skills Modal ────────────────────────────────────────────
//
// Full search-and-load surface that beats the inline filter input. Lists
// every bundled / workspace skill from the same `skills.status` payload
// the page already loaded — no extra RPC. Search runs against name,
// description, source, skill key, install ids, missing bins, and primary
// env so the user can find a skill by any reasonable handle. Filter pills
// narrow by readiness state. Clicking a card opens a detail pane on the
// right with the full description and install / API-key controls.

function renderBrowseSkillsModal(props: SkillsProps) {
  const skills = props.report?.skills ?? [];
  const search = _browseSearch.trim().toLowerCase();
  const filtered = skills.filter((s) => {
    if (!matchesBrowseFilter(s)) return false;
    if (!search) return true;
    const haystack = [
      s.name,
      s.description ?? "",
      s.source,
      s.skillKey,
      s.primaryEnv ?? "",
      ...s.install.map((i) => `${i.id} ${i.label}`),
      ...s.missing.bins.map((b) => `bin:${b}`),
      ...s.missing.env.map((e) => `env:${e}`),
      s.emoji ?? "",
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(search);
  });

  const counts = {
    all: skills.length,
    available: skills.filter((s) => s.eligible && !s.disabled).length,
    installed: skills.filter((s) => s.eligible && s.missing.bins.length === 0 && !s.disabled).length,
    "needs-setup": skills.filter((s) => s.missing.bins.length > 0 || s.missing.env.length > 0).length,
    blocked: skills.filter((s) => !s.eligible || s.blockedByAllowlist).length,
  };

  const selected = _browseSelectedKey
    ? skills.find((s) => s.skillKey === _browseSelectedKey) ?? null
    : null;
  const close = () => { _showBrowseModal = false; _rerender(); };

  return html`
    <div
      class="gt-scope gs-overlay skills-browse-backdrop"
      data-kind="modal"
      @keydown=${(e: KeyboardEvent) => { if (e.key === "Escape") close(); }}
    >
      ${glassToolsStyle()}
      ${glassSkillsStyle()}
      <div class="gs-scrim" @click=${close}></div>
      <div
        class="gs-modal gt-glass skills-browse-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Browse Skills"
        ?data-has-selection=${Boolean(selected)}
        @click=${(e: Event) => e.stopPropagation()}
      >
        <!-- Header -->
        <div class="gs-modal-head">
          <div class="gs-modal-title">
            <span class="gs-ico-badge">${icons.search}</span>
            <div style="min-width:0;">
              <h2>Browse Skills</h2>
              <span class="gs-meta">${filtered.length} of ${skills.length} skill${skills.length === 1 ? "" : "s"}</span>
            </div>
          </div>
          <button class="gs-close" @click=${close} title="Close (Esc)" aria-label="Close">${icons.x}</button>
        </div>

        <!-- Search + filter pills -->
        <div class="gs-modal-tools">
          <label class="gs-search">
            ${icons.search}
            <input
              class="gt-input"
              autofocus
              type="search"
              aria-label="Search skills"
              placeholder="Search by name, description, bin, env, or source…"
              .value=${_browseSearch}
              @input=${(e: Event) => { _browseSearch = (e.target as HTMLInputElement).value; _rerender(); }}
            />
          </label>
          <div class="gt-seg gs-statusseg" role="group" aria-label="Filter">
            ${(["all", "available", "installed", "needs-setup", "blocked"] as BrowseFilter[]).map((f) => html`
              <button aria-pressed=${_browseFilter === f ? "true" : "false"} @click=${() => { _browseFilter = f; _rerender(); }}>
                ${browseFilterLabel(f)} <span class="gs-cat-n">${counts[f]}</span>
              </button>
            `)}
          </div>
        </div>

        <!-- Results list -->
        <div class="gs-modal-list" role="listbox" aria-label="Skills">
          ${props.loading && skills.length === 0
            ? [0, 1, 2, 3, 4, 5].map(() => html`<div class="gt-skel" style="height:60px;border-radius:16px;"></div>`)
            : filtered.length === 0
              ? emptyState(
                  icons.search,
                  skills.length === 0 ? "No skills loaded yet." : "No skills match.",
                  skills.length === 0 ? "Reload to fetch the skill catalogue from the gateway." : "Try another search or filter.",
                  skills.length === 0
                    ? html`<button class="gt-btn" @click=${() => props.onRefresh()}>${icons.refresh} Reload</button>`
                    : nothing,
                )
              : filtered.map((s) => renderBrowseCard(s, props, _browseSelectedKey === s.skillKey))}
        </div>

        <!-- Detail pane -->
        <div class="gs-modal-detail">
          ${selected
            ? html`
                <button class="gt-btn gs-back" @click=${() => { _browseSelectedKey = null; _rerender(); }}>${icons.arrowLeft} All skills</button>
                ${renderBrowseDetail(selected, props)}
              `
            : emptyState(
                icons.puzzle,
                "Select a skill",
                "Pick a skill on the left to see its full description, requirements, and install options.",
              )}
        </div>
      </div>
    </div>
  `;
}

function browseFilterLabel(f: BrowseFilter): string {
  switch (f) {
    case "all": return "All";
    case "available": return "Available";
    case "installed": return "Installed";
    case "needs-setup": return "Needs Setup";
    case "blocked": return "Blocked";
  }
}

function matchesBrowseFilter(s: SkillStatusEntry): boolean {
  switch (_browseFilter) {
    case "all":
      return true;
    case "available":
      return s.eligible && !s.disabled;
    case "installed":
      return s.eligible && s.missing.bins.length === 0 && !s.disabled;
    case "needs-setup":
      return s.missing.bins.length > 0 || s.missing.env.length > 0;
    case "blocked":
      return !s.eligible || s.blockedByAllowlist;
  }
}

function renderBrowseCard(skill: SkillStatusEntry, props: SkillsProps, isSelected: boolean) {
  const busy = props.busyKey === skill.skillKey;
  const ready = skill.eligible && skill.missing.bins.length === 0 && !skill.disabled;
  const stateTone: Tone = !skill.eligible
    ? "danger"
    : skill.disabled
      ? "idle"
      : skill.missing.bins.length > 0
        ? "warn"
        : "ok";
  const stateLabel = !skill.eligible
    ? "Blocked"
    : skill.disabled
      ? "Disabled"
      : skill.missing.bins.length > 0
        ? "Needs setup"
        : "Ready";
  // Rendered as a focusable div (not <button>) so the nested action buttons
  // are valid HTML; Enter/Space select it like the old card button did.
  return html`
    <div
      class="gs-row skills-browse-card"
      role="option"
      tabindex="0"
      aria-selected=${isSelected ? "true" : "false"}
      @click=${() => { _browseSelectedKey = skill.skillKey; _rerender(); }}
      @keydown=${(e: KeyboardEvent) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); _browseSelectedKey = skill.skillKey; _rerender(); }
      }}
      title=${skill.description}
    >
      ${skillGlyph(skill, "sm", deriveCategory(skill))}
      <span class="gs-row-main">
        <span class="gs-row-name">${skill.name}</span>
        <span class="gs-row-desc">${clampText(skill.description ?? "", 90)}</span>
        <span class="gs-chips" style="margin-top: 3px;">
          <span class="gt-chip">${skill.source}</span>
          ${skill.primaryEnv ? html`<span class="gt-chip">${skill.primaryEnv}</span>` : nothing}
        </span>
      </span>
      <span class="gs-row-side">
        ${statusPill(stateLabel, stateTone)}
        ${ready
          ? skill.disabled
            ? html`
                <button
                  class="gt-btn gt-primary"
                  ?disabled=${busy}
                  @click=${(e: Event) => { e.stopPropagation(); props.onToggle(skill.skillKey, true); }}
                >Enable</button>
              `
            : _onPickSkill
              ? html`
                  <button
                    class="gt-btn gt-primary"
                    ?disabled=${busy}
                    @click=${(e: Event) => { e.stopPropagation(); _pickSkill(skill); }}
                    title="Insert @${skill.skillKey} into your prompt"
                  >→ Use</button>
                `
              : nothing
          : skill.install.length > 0
            ? html`
                <button
                  class="gt-btn gt-primary"
                  ?disabled=${busy}
                  @click=${(e: Event) => { e.stopPropagation(); props.onInstall(skill.skillKey, skill.name, skill.install[0].id); }}
                >${busy ? "…" : "Install"}</button>
              `
            : nothing}
      </span>
    </div>
  `;
}

function renderBrowseDetail(skill: SkillStatusEntry, props: SkillsProps) {
  const busy = props.busyKey === skill.skillKey;
  const apiKey = props.edits[skill.skillKey] ?? "";
  const message = props.messages[skill.skillKey] ?? null;
  const missing = [
    ...skill.missing.bins.map((b) => `bin:${b}`),
    ...skill.missing.env.map((e) => `env:${e}`),
    ...skill.missing.config.map((c) => `config:${c}`),
    ...skill.missing.os.map((o) => `os:${o}`),
  ];
  return html`
    <div class="gs-dsec" style="gap: 20px;">
      <div style="display:flex; align-items:center; gap:14px; min-width:0;">
        ${skillGlyph(skill, "lg", deriveCategory(skill))}
        <div style="min-width:0; display:grid; gap:6px;">
          <h3 class="gs-drawer-title" style="font-size:19px;">${skill.name}</h3>
          <span class="gs-drawer-key">${skill.skillKey}</span>
        </div>
      </div>

      <p class="gs-dtext">${skill.description}</p>

      <div class="gs-chips">
        <span class="gt-chip">${skill.source}</span>
        <span class="gt-chip" data-tone=${skill.eligible ? "ok" : "warn"}>
          ${skill.eligible ? "eligible" : "blocked"}
        </span>
        ${skill.disabled ? html`<span class="gt-chip" data-tone="warn">disabled</span>` : nothing}
        ${skill.blockedByAllowlist ? html`<span class="gt-chip" data-tone="warn">allowlist</span>` : nothing}
      </div>

      ${missing.length > 0
        ? html`
            <div class="gs-dsec">
              <span class="gs-dlabel">Missing</span>
              <div class="gs-chips">
                ${missing.map((m) => html`<span class="gt-chip" data-tone="warn">${m}</span>`)}
              </div>
            </div>
          `
        : nothing}

      ${skill.install.length > 0
        ? html`
            <div class="gs-dsec">
              <span class="gs-dlabel">Install</span>
              <div class="gs-actions">
                ${skill.install.map((opt) => html`
                  <button
                    class="gt-btn gt-primary"
                    ?disabled=${busy}
                    @click=${() => props.onInstall(skill.skillKey, skill.name, opt.id)}
                  >${icons.download} ${busy ? "Installing…" : opt.label}</button>
                `)}
              </div>
            </div>
          `
        : nothing}

      <div class="gs-dsec">
        <span class="gs-dlabel">Use</span>
        <div class="gs-actions">
          ${_onPickSkill
            ? html`
                <button
                  class="gt-btn gt-primary"
                  ?disabled=${busy || !skill.eligible || skill.disabled}
                  @click=${() => _pickSkill(skill)}
                  title=${skill.eligible && !skill.disabled
                    ? "Insert @" + skill.skillKey + " into your prompt"
                    : "Skill is not ready — install + enable first"}
                >
                  → Use in prompt
                </button>
              `
            : nothing}
          <button
            class="gt-btn"
            ?disabled=${busy}
            @click=${() => props.onToggle(skill.skillKey, skill.disabled)}
          >
            ${skill.disabled ? icons.play : icons.pause} ${skill.disabled ? "Enable" : "Disable"}
          </button>
        </div>
      </div>

      ${skill.primaryEnv
        ? html`
            <div class="gs-dsec">
              <span class="gs-dlabel">API key (${skill.primaryEnv})</span>
              <div class="gs-inline">
                <input
                  class="gt-input"
                  type="password"
                  autocomplete="off"
                  aria-label=${`${skill.primaryEnv} value`}
                  .value=${apiKey}
                  @input=${(e: Event) => props.onEdit(skill.skillKey, (e.target as HTMLInputElement).value)}
                  placeholder="Set ${skill.primaryEnv}"
                />
                <button
                  class="gt-btn gt-primary"
                  ?disabled=${busy}
                  @click=${() => props.onSaveKey(skill.skillKey)}
                >${icons.key} Save</button>
              </div>
            </div>
          `
        : nothing}

      ${message ? note(message.kind === "error" ? "danger" : "ok", message.message) : nothing}
    </div>
  `;
}

function renderSkill(skill: SkillStatusEntry, props: SkillsProps) {
  const busy = props.busyKey === skill.skillKey;
  const apiKey = props.edits[skill.skillKey] ?? "";
  const message = props.messages[skill.skillKey] ?? null;
  const canInstall =
    skill.install.length > 0 && skill.missing.bins.length > 0;
  const missing = [
    ...skill.missing.bins.map((b) => `bin:${b}`),
    ...skill.missing.env.map((e) => `env:${e}`),
    ...skill.missing.config.map((c) => `config:${c}`),
    ...skill.missing.os.map((o) => `os:${o}`),
  ];
  const reasons: string[] = [];
  if (skill.disabled) reasons.push("disabled");
  if (skill.blockedByAllowlist) reasons.push("blocked by allowlist");
  const info = statusInfo(skill);
  return html`
    <div class="gs-card">
      <div class="gs-card-head">
        ${skillGlyph(skill, "sm", deriveCategory(skill))}
        <div class="gs-card-main">
          <div class="gs-card-title">${skill.name} ${statusPill(info.label, info.tone)}</div>
          <div class="gs-card-sub">${clampText(skill.description, 140)}</div>
          <div class="gs-chips" style="margin-top: 4px;">
            <span class="gt-chip">${skill.source}</span>
            <span class="gt-chip" data-tone=${skill.eligible ? "ok" : "warn"}>
              ${skill.eligible ? "eligible" : "blocked"}
            </span>
            ${skill.disabled ? html`<span class="gt-chip" data-tone="warn">disabled</span>` : nothing}
          </div>
          ${missing.length > 0
            ? html`<div class="gs-meta" style="margin-top: 4px;">Missing: ${missing.join(", ")}</div>`
            : nothing}
          ${reasons.length > 0
            ? html`<div class="gs-meta" style="margin-top: 2px;">Reason: ${reasons.join(", ")}</div>`
            : nothing}
        </div>
        <div class="gs-actions">
          <button
            class="gt-btn"
            ?disabled=${busy}
            @click=${() => props.onToggle(skill.skillKey, skill.disabled)}
          >
            ${skill.disabled ? "Enable" : "Disable"}
          </button>
          ${canInstall
            ? html`<button
                class="gt-btn gt-primary"
                ?disabled=${busy}
                @click=${() =>
                  props.onInstall(skill.skillKey, skill.name, skill.install[0].id)}
              >
                ${busy ? "Installing…" : skill.install[0].label}
              </button>`
            : nothing}
        </div>
      </div>
      ${message ? note(message.kind === "error" ? "danger" : "ok", message.message) : nothing}
      ${skill.primaryEnv
        ? html`
            <div class="gs-inline">
              <input
                class="gt-input"
                type="password"
                placeholder="API key"
                aria-label="API key"
                .value=${apiKey}
                @input=${(e: Event) =>
                  props.onEdit(skill.skillKey, (e.target as HTMLInputElement).value)}
              />
              <button
                class="gt-btn gt-primary"
                ?disabled=${busy}
                @click=${() => props.onSaveKey(skill.skillKey)}
              >
                Save key
              </button>
            </div>
          `
        : nothing}
    </div>
  `;
}
