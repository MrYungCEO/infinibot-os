/**
 * Learn › Classic — the original server-backed stepper tracks (InfiniLearn v1),
 * now a tab inside the guided Learn page (views/learn.ts). Kept for admin
 * authoring, per-user assignment and the legacy certification ladder.
 *
 * Tabs:
 *   • **My Tracks** — what's assigned to you, with progress bars + a
 *     "Continue" button on the active step.
 *   • **Library** — every track available; non-admins don't see admin
 *     audience tracks. Click any to open the stepper.
 *   • **All Users** (admin) — bird's-eye view of who's done what.
 *   • **Author** (admin) — edit a track's JSON in-place; admin
 *     authored tracks shadow bundled ids.
 *
 * The stepper view dominates when a track is open: left rail of step
 * titles, center rendering the current step's body (markdown), bottom
 * action bar with Prev / Mark complete / Next + an optional "Open X"
 * deep link CTA per step.
 */

import { html, nothing } from "lit";
import type { GatewayBrowserClient } from "../gateway";
import {
  type LearnState,
  type TrackSummary,
  type Walkthrough,
  type WalkthroughStep,
  type AdminUserRow,
  type UserProgress,
  type LearnTab,
  createInitialLearnState,
  loadTracks,
  openTrack,
  assignTrack,
  setCurrentStep,
  completeStep,
  setNotes,
  saveNotes,
  loadAdminUsers,
  saveAuthorDraft,
  deleteAuthorTrack,
  setLearnTab,
  setAuthorDraft,
  loadCertStatus,
  viewCertificate,
  closeCertificate,
  downloadCertificate,
  type CertEligibility,
  type CertTier,
} from "../controllers/learn";
import { icons } from "../icons";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { toSanitizedMarkdownHtml } from "../markdown";
import { ensureHomeGlassStyles } from "./home-glass";

interface LearnHost {
  learn?: LearnState;
  client: GatewayBrowserClient | null;
  /** When true the dashboard renders the admin tabs. */
  isAdmin?: boolean;
  setTab?: (tab: string) => void;
  requestUpdate?: () => void;
}

export function ensureLearnState<T extends LearnHost>(state: T): LearnState {
  if (!state.learn) state.learn = createInitialLearnState();
  return state.learn;
}

let _autoLoaded = false;

export function renderLearnClassic<T extends LearnHost>(state: T, client: GatewayBrowserClient) {
  const ls = ensureLearnState(state);
  if (!_autoLoaded) {
    _autoLoaded = true;
    void loadTracks(state as never, client);
    void loadCertStatus(state as never, client);
  }

  injectStyles();
  ensureHomeGlassStyles();

  // The auth model treats "no users yet" as implicit admin; surface
  // admin tabs in that case too. Real admin/role lookups happen
  // server-side; this just controls visibility.
  const showAdmin = inferAdmin(state);

  return html`
    <div class="learn-page">
      <header class="learn-header">
        <div>
          <h2>${icons.book ?? icons.docs} Classic tracks</h2>
          <p class="learn-sub">
            The original step-by-step reading tracks, per-user assignment and admin authoring.
            Guided walkthroughs live on the Tracks tab.
          </p>
        </div>
        <div class="learn-tabs">
          ${tabButton(state, "my-tracks", "My Tracks")}
          ${tabButton(state, "library", "Library")}
          ${tabButton(state, "certification", "Certification")}
          ${showAdmin ? tabButton(state, "admin-users", "All Users", true) : nothing}
          ${showAdmin ? tabButton(state, "author", "Author", true) : nothing}
        </div>
      </header>


      ${ls.error ? html`<div class="learn-banner learn-banner-error">${ls.error}</div>` : nothing}
      ${ls.success ? html`<div class="learn-banner learn-banner-success">${ls.success}</div>` : nothing}

      ${ls.tab === "my-tracks" ? renderMyTracks(state, client) : nothing}
      ${ls.tab === "library" ? renderLibrary(state, client) : nothing}
      ${ls.tab === "certification" ? renderCertification(state, client) : nothing}
      ${ls.tab === "admin-users" && showAdmin ? renderAdminUsers(state, client) : nothing}
      ${ls.tab === "author" && showAdmin ? renderAuthor(state, client) : nothing}

      ${ls.active ? renderStepperOverlay(state, client) : nothing}
      ${ls.certSvg ? renderCertOverlay(state) : nothing}
    </div>
  `;
}

function tabButton<T extends LearnHost>(state: T, id: LearnTab, label: string, admin = false) {
  const ls = ensureLearnState(state);
  return html`
    <button
      class="learn-tab ${ls.tab === id ? "active" : ""} ${admin ? "admin" : ""}"
      @click=${() => {
        setLearnTab(state as never, id);
        if (id === "admin-users" && state.client) void loadAdminUsers(state as never, state.client);
      }}
    >${label}</button>
  `;
}

// ── My Tracks ───────────────────────────────────────────────

function renderMyTracks<T extends LearnHost>(state: T, client: GatewayBrowserClient) {
  const ls = ensureLearnState(state);
  const assigned = ls.tracks.filter((t) => t.progress != null);

  if (ls.loading && assigned.length === 0) return html`<div class="learn-empty">Loading…</div>`;
  if (assigned.length === 0) {
    return html`
      <div class="learn-empty">
        <p>No tracks assigned yet. Pop into the Library tab and pick one.</p>
        <button class="learn-btn learn-btn-primary" @click=${() => setLearnTab(state as never, "library")}>Open Library</button>
      </div>
    `;
  }
  return html`
    <section class="learn-grid">
      ${assigned
        .sort((a, b) => (a.percent === 100 ? 1 : 0) - (b.percent === 100 ? 1 : 0) || (a.order ?? 0) - (b.order ?? 0))
        .map((t) => renderTrackCard(state, client, t))}
    </section>
  `;
}

function renderTrackCard<T extends LearnHost>(state: T, client: GatewayBrowserClient, track: TrackSummary) {
  const done = track.percent === 100;
  return html`
    <button
      class="learn-card ${done ? "done" : ""}"
      @click=${() => void openTrack(state as never, client, track.id)}
    >
      <div class="learn-card-head">
        <span class="learn-card-cat">${track.category ?? "General"}</span>
        ${done ? html`<span class="learn-pill learn-pill-ok">Complete</span>` : nothing}
        ${track.audience === "admin" ? html`<span class="learn-pill learn-pill-admin">Admin</span>` : nothing}
      </div>
      <h3>${track.title}</h3>
      <p>${track.description}</p>
      <div class="learn-progress">
        <div class="learn-progress-bar"><div class="learn-progress-fill" style="width: ${track.percent}%"></div></div>
        <span class="learn-progress-text">${track.completedCount}/${track.totalSteps} · ${track.percent}%</span>
      </div>
    </button>
  `;
}

// ── Library ─────────────────────────────────────────────────

function renderLibrary<T extends LearnHost>(state: T, client: GatewayBrowserClient) {
  const ls = ensureLearnState(state);
  if (ls.loading) return html`<div class="learn-empty">Loading…</div>`;
  if (ls.tracks.length === 0) return html`<div class="learn-empty">No tracks available.</div>`;
  // Group by category.
  const byCat = new Map<string, TrackSummary[]>();
  for (const t of ls.tracks) {
    const cat = t.category ?? "General";
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat)!.push(t);
  }
  return html`
    <section class="learn-library">
      ${[...byCat.entries()].map(([cat, list]) => html`
        <div class="learn-library-cat">
          <h3>${cat}</h3>
          <div class="learn-grid">
            ${list.map((t) => renderTrackCard(state, client, t))}
          </div>
        </div>
      `)}
    </section>
  `;
}

// ── Certification ────────────────────────────────────────────

function renderCertification<T extends LearnHost>(state: T, client: GatewayBrowserClient) {
  const ls = ensureLearnState(state);
  if (ls.certEligibility.length === 0) {
    return html`<div class="learn-empty"><p>Loading certification ladder…</p></div>`;
  }
  return html`
    <section class="learn-cert">
      <div class="learn-cert-intro">
        <h3>InfiniBot AI Agent Systems Master Certification</h3>
        <p>
          Three tiers, awarded automatically as you complete the bundled walkthroughs.
          Every track flagged required for the certificate counts toward the next tier — finish them all and the Master cert mints.
          Certificates are SVG-rendered, downloadable, and carry a verification fingerprint.
        </p>
      </div>
      <div class="learn-cert-ladder">
        ${ls.certEligibility.map((e) => renderCertTier(state, client, e))}
      </div>
      ${ls.certificates.length > 0 ? html`
        <div class="learn-cert-list">
          <h4>Awarded</h4>
          ${ls.certificates.map((c) => html`
            <div class="learn-cert-row">
              <span class="learn-cert-tier-name learn-cert-${c.tier}">${tierTitle(c.tier)}</span>
              <span class="learn-cert-date">${new Date(c.awardedAt).toLocaleDateString()}</span>
              <code class="learn-cert-hash">${c.hash.slice(0, 16)}…</code>
              <button class="learn-btn learn-btn-ghost" @click=${() => void viewCertificate(state as never, client, c.tier)}>View</button>
            </div>
          `)}
        </div>
      ` : nothing}
    </section>
  `;
}

function renderCertTier<T extends LearnHost>(state: T, client: GatewayBrowserClient, eligibility: CertEligibility) {
  const ls = ensureLearnState(state);
  const tierLabel = tierTitle(eligibility.tier);
  const trackById = new Map(ls.tracks.map((t) => [t.id, t] as const));
  return html`
    <div class="learn-cert-tier learn-cert-${eligibility.tier} ${eligibility.awarded ? "awarded" : ""}">
      <header>
        <span class="learn-cert-tier-label">${tierLabel}</span>
        ${eligibility.awarded
          ? html`<span class="learn-pill learn-pill-ok">Awarded</span>`
          : eligibility.percent === 100
            ? html`<span class="learn-pill learn-pill-ok">Ready to mint</span>`
            : html`<span class="learn-pill">${eligibility.percent}%</span>`}
      </header>
      <div class="learn-progress">
        <div class="learn-progress-bar"><div class="learn-progress-fill" style="width: ${eligibility.percent}%"></div></div>
        <span class="learn-progress-text">${eligibility.earned.length}/${eligibility.total}</span>
      </div>
      ${eligibility.missing.length > 0 ? html`
        <div class="learn-cert-missing">
          <p>Still to complete:</p>
          <ul>
            ${eligibility.missing.map((id) => {
              const t = trackById.get(id);
              return html`<li>
                <button class="learn-btn-link" @click=${() => t ? void openTrack(state as never, client, t.id) : null}>${t?.title ?? id}</button>
              </li>`;
            })}
          </ul>
        </div>
      ` : nothing}
      ${eligibility.awarded ? html`
        <div class="learn-cert-actions">
          <button class="learn-btn learn-btn-primary" @click=${() => void viewCertificate(state as never, client, eligibility.tier)}>View certificate</button>
        </div>
      ` : eligibility.percent === 100 ? html`
        <div class="learn-cert-actions">
          <button class="learn-btn learn-btn-primary" @click=${() => void loadCertStatus(state as never, client).then(() => viewCertificate(state as never, client, eligibility.tier))}>Mint &amp; view</button>
        </div>
      ` : nothing}
    </div>
  `;
}

function renderCertOverlay<T extends LearnHost>(state: T) {
  const ls = ensureLearnState(state);
  if (!ls.certSvg) return nothing;
  return html`
    <div class="learn-cert-overlay" @click=${(e: Event) => {
      if ((e.target as HTMLElement).classList.contains("learn-cert-overlay")) closeCertificate(state as never);
    }}>
      <div class="learn-cert-modal" @click=${(e: Event) => e.stopPropagation()}>
        <div class="learn-cert-svg-wrap" .innerHTML=${ls.certSvg.svg}></div>
        <div class="learn-cert-modal-actions">
          <button class="learn-btn learn-btn-ghost" @click=${() => closeCertificate(state as never)}>Close</button>
          <button
            class="learn-btn learn-btn-primary"
            @click=${() => {
              const cert = ls.certificates.find((c) => c.tier === ls.certSvg!.tier);
              if (cert) downloadCertificate(ls.certSvg!.svg, ls.certSvg!.tier, cert.displayName || "infinibot-operator");
            }}
          >Download SVG</button>
        </div>
      </div>
    </div>
  `;
}

function tierTitle(tier: CertTier): string {
  if (tier === "apprentice") return "Apprentice";
  if (tier === "practitioner") return "Practitioner";
  return "Master";
}

// ── Admin: All Users ────────────────────────────────────────

function renderAdminUsers<T extends LearnHost>(state: T, client: GatewayBrowserClient) {
  const ls = ensureLearnState(state);
  if (ls.adminUsers.length === 0) {
    return html`
      <div class="learn-empty">
        <p>No users yet — create one from Settings → Users.</p>
      </div>
    `;
  }
  return html`
    <section class="learn-admin">
      ${ls.adminUsers.map((row) => renderAdminUserRow(state, client, row))}
    </section>
  `;
}

function renderAdminUserRow<T extends LearnHost>(_state: T, _client: GatewayBrowserClient, row: AdminUserRow) {
  return html`
    <div class="learn-admin-row">
      <div class="learn-admin-user">
        <span class="learn-admin-name">${row.user.username}</span>
        <span class="learn-pill ${row.user.role === "admin" ? "learn-pill-admin" : ""}">${row.user.role}</span>
        <span class="learn-admin-lang">${row.user.language || "en"}</span>
      </div>
      ${row.progress.length === 0
        ? html`<div class="learn-admin-empty">No progress yet.</div>`
        : html`
            <div class="learn-admin-tracks">
              ${row.progress.map((t) => html`
                <div class="learn-admin-track">
                  <span class="learn-admin-track-name">${t.title}</span>
                  <div class="learn-progress">
                    <div class="learn-progress-bar"><div class="learn-progress-fill" style="width: ${t.percent}%"></div></div>
                    <span class="learn-progress-text">${t.completedCount}/${t.totalSteps}</span>
                  </div>
                </div>
              `)}
            </div>
          `}
    </div>
  `;
}

// ── Admin: Author ───────────────────────────────────────────

function renderAuthor<T extends LearnHost>(state: T, client: GatewayBrowserClient) {
  const ls = ensureLearnState(state);
  return html`
    <section class="learn-author">
      <aside class="learn-author-list">
        <h4>Tracks</h4>
        ${ls.tracks.map((t) => html`
          <button
            class="learn-author-item ${ls.authorTrackId === t.id ? "active" : ""}"
            @click=${() => setAuthorDraft(state as never, JSON.stringify(t, null, 2), t.id)}
          >
            <span>${t.title}</span>
            <small>${t.id}</small>
          </button>
        `)}
        <button
          class="learn-btn learn-btn-ghost"
          @click=${() => setAuthorDraft(state as never, JSON.stringify({
            id: "my-track",
            title: "My new track",
            description: "What this track teaches",
            audience: "all",
            order: 100,
            category: "Custom",
            steps: [
              { id: "step-1", title: "First step", body: "Markdown body here.", estMinutes: 1 },
            ],
          }, null, 2))}
        >+ New track</button>
      </aside>
      <div class="learn-author-edit">
        <textarea
          class="learn-author-textarea"
          spellcheck="false"
          .value=${ls.authorDraft}
          @input=${(e: Event) => setAuthorDraft(state as never, (e.target as HTMLTextAreaElement).value)}
          placeholder="Pick a track on the left, or click + New track."
        ></textarea>
        <div class="learn-author-actions">
          <button
            class="learn-btn learn-btn-primary"
            ?disabled=${!ls.authorDraft.trim()}
            @click=${() => void saveAuthorDraft(state as never, client)}
          >Save</button>
          ${ls.authorTrackId
            ? html`
                <button
                  class="learn-btn learn-btn-danger"
                  @click=${() => void deleteAuthorTrack(state as never, client, ls.authorTrackId!)}
                >Delete</button>
              `
            : nothing}
          <span class="learn-help">
            Saving writes to <code>&lt;state&gt;/learn/tracks/&lt;id&gt;.json</code>. Admin-authored tracks shadow bundled ids.
          </span>
        </div>
      </div>
    </section>
  `;
}

// ── Stepper overlay ─────────────────────────────────────────

function renderStepperOverlay<T extends LearnHost>(state: T, client: GatewayBrowserClient) {
  const ls = ensureLearnState(state);
  if (!ls.active) return nothing;
  const track = ls.active.track;
  const progress = ls.active.progress;
  const step = track.steps.find((s) => s.id === ls.currentStepId) ?? track.steps[0];
  const stepIdx = track.steps.findIndex((s) => s.id === step?.id);
  const completed = new Set(progress?.completedSteps ?? []);
  const isStepComplete = step ? completed.has(step.id) : false;
  const isLast = stepIdx === track.steps.length - 1;
  const isFirst = stepIdx <= 0;

  return html`
    <div class="learn-stepper-overlay" @click=${(e: Event) => {
      if ((e.target as HTMLElement).classList.contains("learn-stepper-overlay")) closeActive(state);
    }}>
      <div class="learn-stepper" @click=${(e: Event) => e.stopPropagation()}>
        <header class="learn-stepper-head">
          <div>
            <span class="learn-card-cat">${track.category ?? "General"}</span>
            <h3>${track.title}</h3>
          </div>
          <button class="learn-btn learn-btn-ghost" @click=${() => closeActive(state)}>Close</button>
        </header>

        <div class="learn-stepper-body">
          <aside class="learn-stepper-rail">
            ${track.steps.map((s, idx) => html`
              <button
                class="learn-stepper-step ${s.id === step?.id ? "active" : ""} ${completed.has(s.id) ? "done" : ""}"
                @click=${() => void setCurrentStep(state as never, client, s.id)}
              >
                <span class="learn-stepper-num">${completed.has(s.id) ? "✓" : idx + 1}</span>
                <span class="learn-stepper-title">${s.title}</span>
                ${s.estMinutes ? html`<span class="learn-stepper-min">${s.estMinutes}m</span>` : nothing}
              </button>
            `)}
          </aside>

          <article class="learn-stepper-content">
            ${step ? renderStep(state, step) : html`<p>Empty track.</p>`}
            ${renderNotes(state, client)}
          </article>
        </div>

        <footer class="learn-stepper-foot">
          <button
            class="learn-btn learn-btn-ghost"
            ?disabled=${isFirst}
            @click=${() => void setCurrentStep(state as never, client, track.steps[Math.max(0, stepIdx - 1)].id)}
          >‹ Prev</button>
          <button
            class="learn-btn learn-btn-primary"
            ?disabled=${!step}
            @click=${() => step ? void completeStep(state as never, client, step.id) : null}
          >${isStepComplete ? "Re-mark complete" : isLast ? "Finish" : "Mark complete"}</button>
          <button
            class="learn-btn learn-btn-ghost"
            ?disabled=${isLast}
            @click=${() => void setCurrentStep(state as never, client, track.steps[Math.min(track.steps.length - 1, stepIdx + 1)].id)}
          >Next ›</button>
          ${progress?.completedAt
            ? html`<span class="learn-pill learn-pill-ok">Track complete</span>`
            : html`<span class="learn-help">${progress ? `${progress.completedSteps.length}/${track.steps.length} done` : "Click Mark complete to start"}</span>`}
        </footer>
      </div>
    </div>
  `;
}

function renderStep<T extends LearnHost>(state: T, step: WalkthroughStep) {
  return html`
    <h2>${step.title}</h2>
    ${step.estMinutes ? html`<p class="learn-help">~ ${step.estMinutes} min</p>` : nothing}
    <div class="learn-md md-body">${unsafeHTML(toSanitizedMarkdownHtml(step.body))}</div>
    ${step.cta
      ? html`
          <button
            class="learn-btn learn-btn-primary"
            @click=${() => {
              if (step.cta!.tab && state.setTab) state.setTab(step.cta!.tab);
              else if (step.cta!.url) window.open(step.cta!.url, "_blank");
            }}
          >→ ${step.cta.label}</button>
        `
      : nothing}
  `;
}

function renderNotes<T extends LearnHost>(state: T, client: GatewayBrowserClient) {
  const ls = ensureLearnState(state);
  return html`
    <details class="learn-notes">
      <summary>My notes for this track</summary>
      <textarea
        class="learn-notes-area"
        placeholder="Anything you want the agent (and future-you) to remember about this track."
        .value=${ls.notesDraft}
        @input=${(e: Event) => setNotes(state as never, (e.target as HTMLTextAreaElement).value)}
      ></textarea>
      <div class="learn-actions">
        <button
          class="learn-btn learn-btn-ghost"
          ?disabled=${!ls.notesDirty}
          @click=${() => void saveNotes(state as never, client)}
        >Save notes</button>
        ${ls.notesDirty ? html`<span class="learn-help">unsaved</span>` : nothing}
      </div>
    </details>
  `;
}

function closeActive<T extends LearnHost>(state: T): void {
  const ls = ensureLearnState(state);
  ls.active = null;
  ls.activeTrackId = null;
  ls.currentStepId = null;
  state.requestUpdate?.();
}

// Markdown rendering delegated to toSanitizedMarkdownHtml (canonical renderer).

// ── Admin detection ─────────────────────────────────────────

function inferAdmin<T extends LearnHost>(state: T): boolean {
  if (state.isAdmin === true) return true;
  // Fall back to the multi-user store snapshot if it's already loaded.
  const me = (state as unknown as { users?: { me?: { user?: { role?: string }; implicitAdmin?: boolean } } }).users?.me;
  if (me?.implicitAdmin) return true;
  if (me?.user?.role === "admin") return true;
  return false;
}

// ── Styles ──────────────────────────────────────────────────

let _stylesInjected = false;
function injectStyles() {
  if (_stylesInjected || typeof document === "undefined") return;
  _stylesInjected = true;
  const s = document.createElement("style");
  s.textContent = LEARN_CSS;
  document.head.appendChild(s);
}

const LEARN_CSS = `
.learn-page { padding: 24px; max-width: 1280px; margin: 0 auto; color: var(--g-fg); }
.learn-mission-rail-wrap { margin: 4px 0 22px; padding: 16px; border-radius: 14px; border: 1px solid color-mix(in srgb, var(--infinibot-gold, #d4af37) 28%, transparent); background: color-mix(in srgb, var(--infinibot-gold, #d4af37) 5%, color-mix(in srgb, var(--g-surface) 70%, transparent)); }
.learn-mission-rail-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
.learn-mission-rail-title { font-size: 13px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: var(--infinibot-gold-bright, #fff3c0); }
.learn-mission-rail-sub { font-size: 12px; color: var(--g-fg-dim); }
.learn-mission-rail { display: flex; gap: 12px; overflow-x: auto; padding-bottom: 6px; scroll-snap-type: x proximity; }
.learn-mission-rail learn-mission-card { scroll-snap-align: start; }
.learn-mission-rail::-webkit-scrollbar { height: 6px; }
.learn-mission-rail::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--g-fg) 16%, transparent); border-radius: 999px; }
@media (prefers-reduced-motion: reduce) { .learn-mission-rail { scroll-behavior: auto; } }
.learn-header { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; margin-bottom: 16px; flex-wrap: wrap; }
.learn-header h2 { display: flex; align-items: center; gap: 10px; margin: 0 0 4px; font-size: 22px; font-weight: 600; }
.learn-sub { color: var(--g-fg-dim); font-size: 13px; margin: 0; max-width: 640px; }
.learn-tabs { display: inline-flex; background: color-mix(in srgb, var(--g-fg) 6%, transparent); padding: 4px; border-radius: 10px; gap: 2px; }
.learn-tab { padding: 7px 14px; border-radius: 7px; border: none; background: transparent; color: var(--g-fg-dim); font-size: 13px; font-weight: 500; cursor: pointer; }
.learn-tab.active { background: var(--g-primary); color: var(--g-bg); }
.learn-tab.admin::after { content: " ·"; color: var(--g-primary); }
.learn-banner { padding: 10px 14px; border-radius: 8px; margin-bottom: 12px; font-size: 13px; }
.learn-banner-error { background: color-mix(in srgb, #dc2626 14%, transparent); color: #fca5a5; }
.learn-banner-success { background: color-mix(in srgb, #10b981 14%, transparent); color: #6ee7b7; }
.learn-empty { padding: 40px; text-align: center; color: var(--g-fg-faint); display: flex; flex-direction: column; align-items: center; gap: 12px; }
.learn-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
.learn-library-cat { margin-bottom: 24px; }
.learn-library-cat h3 { margin: 0 0 10px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--g-fg-dim); }
.learn-card { display: flex; flex-direction: column; gap: 8px; padding: 16px; text-align: left; border: 1px solid color-mix(in srgb, var(--g-fg) 8%, transparent); border-radius: 12px; background: color-mix(in srgb, var(--g-surface) 70%, transparent); cursor: pointer; color: var(--g-fg); transition: border-color 0.12s, transform 0.12s; }
.learn-card:hover { border-color: var(--g-primary); transform: translateY(-1px); }
.learn-card.done { opacity: 0.85; }
.learn-card-head { display: flex; align-items: center; gap: 6px; }
.learn-card-cat { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--g-fg-dim); }
.learn-card h3 { margin: 0; font-size: 15px; font-weight: 600; }
.learn-card p { margin: 0; font-size: 12.5px; color: var(--g-fg-dim); line-height: 1.45; flex: 1; }
.learn-progress { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
.learn-progress-bar { flex: 1; height: 4px; background: color-mix(in srgb, var(--g-fg) 8%, transparent); border-radius: 999px; overflow: hidden; }
.learn-progress-fill { height: 100%; background: var(--g-primary); transition: width 0.2s; }
.learn-progress-text { font-size: 10.5px; color: var(--g-fg-dim); font-family: ui-monospace, monospace; }
.learn-pill { padding: 2px 8px; border-radius: 999px; font-size: 10.5px; background: color-mix(in srgb, var(--g-fg) 8%, transparent); color: var(--g-fg-dim); }
.learn-pill-ok { background: color-mix(in srgb, #10b981 14%, transparent); color: #6ee7b7; }
.learn-pill-admin { background: color-mix(in srgb, var(--g-primary) 18%, transparent); color: var(--g-primary); }

.learn-admin { display: flex; flex-direction: column; gap: 10px; }
.learn-admin-row { padding: 14px; border: 1px solid color-mix(in srgb, var(--g-fg) 8%, transparent); border-radius: 10px; background: color-mix(in srgb, var(--g-surface) 70%, transparent); }
.learn-admin-user { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.learn-admin-name { font-weight: 600; }
.learn-admin-lang { color: var(--g-fg-dim); font-size: 11px; }
.learn-admin-empty { color: var(--g-fg-faint); font-size: 12px; }
.learn-admin-tracks { display: flex; flex-direction: column; gap: 6px; }
.learn-admin-track { display: flex; align-items: center; gap: 12px; }
.learn-admin-track-name { flex: 0 0 200px; font-size: 12.5px; }

.learn-author { display: grid; grid-template-columns: 280px 1fr; gap: 16px; }
.learn-author-list { display: flex; flex-direction: column; gap: 4px; }
.learn-author-list h4 { margin: 0 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--g-fg-dim); }
.learn-author-item { text-align: left; padding: 8px 10px; border-radius: 7px; border: 1px solid transparent; background: color-mix(in srgb, var(--g-surface) 60%, transparent); color: var(--g-fg); cursor: pointer; display: flex; flex-direction: column; }
.learn-author-item.active { border-color: var(--g-primary); background: color-mix(in srgb, var(--g-primary) 8%, transparent); }
.learn-author-item small { color: var(--g-fg-dim); font-size: 10.5px; font-family: ui-monospace, monospace; }
.learn-author-edit { display: flex; flex-direction: column; gap: 8px; }
.learn-author-textarea { width: 100%; min-height: 460px; font-family: ui-monospace, monospace; font-size: 12.5px; padding: 12px; border-radius: 8px; border: 1px solid color-mix(in srgb, var(--g-fg) 14%, transparent); background: color-mix(in srgb, var(--g-bg) 70%, transparent); color: var(--g-fg); resize: vertical; }
.learn-author-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.learn-help { font-size: 11.5px; color: var(--g-fg-dim); }
.learn-help code { padding: 1px 5px; background: color-mix(in srgb, var(--g-fg) 8%, transparent); border-radius: 4px; }

.learn-btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px; border-radius: 7px; border: 1px solid transparent; font-size: 13px; font-weight: 500; cursor: pointer; }
.learn-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.learn-btn-primary { background: var(--g-primary); color: var(--g-bg); }
.learn-btn-ghost { background: transparent; border-color: color-mix(in srgb, var(--g-fg) 14%, transparent); color: var(--g-fg); }
.learn-btn-danger { background: color-mix(in srgb, #dc2626 16%, transparent); color: #fca5a5; border-color: color-mix(in srgb, #dc2626 28%, transparent); }
.learn-actions { display: flex; gap: 8px; align-items: center; margin-top: 6px; }

.learn-stepper-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.55); display: flex; align-items: stretch; justify-content: center; z-index: 9998; backdrop-filter: blur(2px); }
.learn-stepper { width: min(1100px, 96vw); max-height: 92vh; margin: 4vh auto; display: flex; flex-direction: column; background: linear-gradient(var(--g-surface, transparent), var(--g-surface, transparent)), var(--g-bg, #0a0a0e); border: 1px solid color-mix(in srgb, var(--g-fg) 14%, transparent); border-radius: 14px; overflow: hidden; }
.learn-stepper-head { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid color-mix(in srgb, var(--g-fg) 8%, transparent); }
.learn-stepper-head h3 { margin: 4px 0 0; font-size: 17px; }
.learn-stepper-body { display: grid; grid-template-columns: 260px 1fr; gap: 0; flex: 1; overflow: hidden; }
.learn-stepper-rail { display: flex; flex-direction: column; gap: 4px; padding: 12px; border-right: 1px solid color-mix(in srgb, var(--g-fg) 8%, transparent); overflow-y: auto; }
.learn-stepper-step { display: grid; grid-template-columns: 24px 1fr auto; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 7px; border: 1px solid transparent; background: transparent; color: var(--g-fg); cursor: pointer; text-align: left; font-size: 12.5px; }
.learn-stepper-step:hover { background: color-mix(in srgb, var(--g-fg) 4%, transparent); }
.learn-stepper-step.active { background: color-mix(in srgb, var(--g-primary) 12%, transparent); border-color: var(--g-primary); }
.learn-stepper-step.done .learn-stepper-num { background: #10b981; color: white; }
.learn-stepper-num { width: 22px; height: 22px; display: grid; place-items: center; border-radius: 50%; background: color-mix(in srgb, var(--g-fg) 12%, transparent); color: var(--g-fg-dim); font-size: 11px; font-weight: 600; }
.learn-stepper-step.active .learn-stepper-num { background: var(--g-primary); color: var(--g-bg); }
.learn-stepper-min { color: var(--g-fg-faint); font-size: 10.5px; }
.learn-stepper-content { padding: 24px 28px; overflow-y: auto; line-height: 1.55; font-size: 14px; }
.learn-stepper-content h2 { margin: 0 0 4px; font-size: 20px; }
.learn-md h3 { font-size: 15px; margin: 16px 0 6px; }
.learn-md h4 { font-size: 13.5px; margin: 12px 0 4px; }
.learn-md p { margin: 8px 0; color: var(--g-fg); }
.learn-md ul { margin: 6px 0 10px; padding-left: 22px; }
.learn-md li { margin-bottom: 3px; color: var(--g-fg); }
.learn-md code { padding: 1px 5px; background: color-mix(in srgb, var(--g-fg) 8%, transparent); border-radius: 4px; font-size: 12.5px; }
.learn-md pre { margin: 10px 0; padding: 12px; background: color-mix(in srgb, var(--g-bg) 70%, transparent); border-radius: 8px; overflow-x: auto; }
.learn-md pre code { background: transparent; padding: 0; }
.learn-md strong { font-weight: 600; }
.learn-md em { font-style: italic; }

.learn-notes { margin-top: 24px; padding: 12px; border-radius: 8px; background: color-mix(in srgb, var(--g-fg) 4%, transparent); }
.learn-notes summary { cursor: pointer; font-size: 12.5px; color: var(--g-fg-dim); }
.learn-notes-area { width: 100%; min-height: 100px; margin-top: 8px; padding: 10px; border-radius: 6px; border: 1px solid color-mix(in srgb, var(--g-fg) 12%, transparent); background: color-mix(in srgb, var(--g-bg) 70%, transparent); color: var(--g-fg); font-size: 13px; resize: vertical; font-family: inherit; }

.learn-stepper-foot { display: flex; gap: 8px; align-items: center; padding: 14px 20px; border-top: 1px solid color-mix(in srgb, var(--g-fg) 8%, transparent); }
.learn-stepper-foot .learn-help { margin-left: auto; }

.learn-cert { display: flex; flex-direction: column; gap: 20px; }
.learn-cert-intro h3 { margin: 0 0 6px; font-size: 18px; }
.learn-cert-intro p { margin: 0; color: var(--g-fg-dim); font-size: 13px; line-height: 1.5; max-width: 720px; }
.learn-cert-ladder { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
.learn-cert-tier { padding: 18px; border: 1px solid color-mix(in srgb, var(--g-fg) 10%, transparent); border-radius: 14px; background: color-mix(in srgb, var(--g-surface) 75%, transparent); display: flex; flex-direction: column; gap: 12px; }
.learn-cert-tier header { display: flex; justify-content: space-between; align-items: center; }
.learn-cert-tier-label { font-size: 16px; font-weight: 600; }
.learn-cert-apprentice { border-color: color-mix(in srgb, #6ee7b7 30%, transparent); }
.learn-cert-practitioner { border-color: color-mix(in srgb, #a78bfa 30%, transparent); }
.learn-cert-master { border-color: color-mix(in srgb, #fbbf24 35%, transparent); background: color-mix(in srgb, #fbbf24 4%, var(--g-surface) 96%); }
.learn-cert-tier.awarded { box-shadow: 0 0 0 1px var(--g-primary), 0 6px 18px color-mix(in srgb, var(--g-primary) 18%, transparent); }
.learn-cert-missing p { margin: 0 0 4px; color: var(--g-fg-dim); font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.06em; }
.learn-cert-missing ul { margin: 0; padding-left: 18px; font-size: 13px; line-height: 1.5; }
.learn-cert-actions { display: flex; gap: 6px; }
.learn-cert-list { padding-top: 16px; border-top: 1px solid color-mix(in srgb, var(--g-fg) 8%, transparent); }
.learn-cert-list h4 { margin: 0 0 10px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--g-fg-dim); }
.learn-cert-row { display: grid; grid-template-columns: 140px 140px 1fr auto; align-items: center; gap: 12px; padding: 8px 0; border-bottom: 1px solid color-mix(in srgb, var(--g-fg) 6%, transparent); }
.learn-cert-tier-name { font-weight: 600; }
.learn-cert-date { color: var(--g-fg-dim); font-size: 12px; }
.learn-cert-hash { font-size: 11px; color: var(--g-fg-faint); font-family: ui-monospace, monospace; }
.learn-cert-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.7); display: flex; align-items: center; justify-content: center; z-index: 9999; backdrop-filter: blur(4px); padding: 20px; }
.learn-cert-modal { background: color-mix(in srgb, var(--g-bg) 95%, transparent); border: 1px solid color-mix(in srgb, var(--g-fg) 14%, transparent); border-radius: 14px; max-width: 1240px; max-height: 92vh; overflow: hidden; display: flex; flex-direction: column; }
.learn-cert-svg-wrap { padding: 16px; max-height: 80vh; overflow: auto; display: flex; align-items: center; justify-content: center; }
.learn-cert-svg-wrap svg { max-width: 100%; height: auto; }
.learn-cert-modal-actions { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px; border-top: 1px solid color-mix(in srgb, var(--g-fg) 10%, transparent); }
.learn-btn-link { background: none; border: none; color: var(--g-primary); font-size: 13px; cursor: pointer; padding: 0; text-align: left; }

@media (max-width: 880px) {
  .learn-stepper-body { grid-template-columns: 1fr; }
  .learn-stepper-rail { border-right: none; border-bottom: 1px solid color-mix(in srgb, var(--g-fg) 8%, transparent); max-height: 200px; }
  .learn-author { grid-template-columns: 1fr; }
  .learn-cert-ladder { grid-template-columns: 1fr; }
  .learn-cert-row { grid-template-columns: 1fr; gap: 4px; }
}
`;
