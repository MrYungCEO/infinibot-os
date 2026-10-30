/**
 * /learn — guided Learn (v2).
 *
 *   /learn                 catalog: hero + stats + search, Day-1 missions strip,
 *                          Recommended next, core tracks, plugin tracks grouped
 *                          under their plugin (monogram + accent), certification
 *                          path with plugin mastery badges.
 *   /learn/<trackId>       track page: overview, 3–6 guided walkthroughs
 *                          (Start / Resume / Replay), quick check (quiz), badge.
 *   ?walkthrough=<id>      starts that walkthrough (mobile deep link target:
 *                          infinibot://learn/<trackId>/<walkthroughId>).
 *
 * Tabs: Tracks · Certification · Classic (the v1 stepper tracks + admin
 * authoring, views/learn-classic.ts).
 *
 * Data: ui/src/learn/guided/catalog-store.ts (gateway `learn.guided.*`,
 * progress synced per user). Tours: ui/src/learn/guided/engine.ts.
 */

import { html, nothing, type TemplateResult } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type { GatewayBrowserClient } from "../gateway";
import { toSanitizedMarkdownHtml } from "../markdown";
import { walkthroughRef, type LearnWalkthrough } from "../../../../src/learn/guided/types.js";
import {
  availableTracks,
  badges,
  certLadder,
  findTrack,
  guidedState,
  loadGuidedCatalog,
  pref,
  resetWalkthrough,
  setPref,
  statusOf,
  submitQuiz,
  subscribeGuided,
  walkthroughProgress,
  type CatalogPlugin,
  type PublicLearnTrack,
  type QuizOutcome,
} from "../../learn/guided/catalog-store";
import { recommendTracks } from "../../../../src/learn/guided/status.js";
import { currentUseCases } from "../onboarding/profile";
import { planFor, useCaseById, useCaseTrackBoost } from "../onboarding/use-cases";
import { createPath, currentPath, pathProgress, setPathAuto, startPath, walkthroughProgressMap } from "../../learn/guided/learning-path";
import { currentRoute, navigateTo, startTrack, startWalkthrough } from "../../learn/guided/engine";
import { loadStore as loadMissionStore } from "../controllers/learn-missions";
import { renderLearnClassic } from "./learn-classic";
import { ensureHomeGlassStyles } from "./home-glass";

interface LearnHost {
  client: GatewayBrowserClient | null;
  isAdmin?: boolean;
  requestUpdate?: () => void;
}

type PageTab = "tracks" | "cert" | "classic";
type Filter = "all" | "core" | "plugins" | "progress" | "done";

const ui = {
  tab: "tracks" as PageTab,
  filter: "all" as Filter,
  query: "",
  quiz: {} as Record<string, number[]>,
  quizResult: {} as Record<string, QuizOutcome | null>,
  quizBusy: false,
  certSvg: null as { tier: string; svg: string } | null,
  copied: false,
  autoStarted: "",
};

let wired = false;
let host: LearnHost | null = null;

function rerender(): void {
  host?.requestUpdate?.();
}

export function renderLearn<T extends LearnHost>(state: T, client: GatewayBrowserClient) {
  host = state;
  if (!wired) {
    wired = true;
    subscribeGuided(rerender);
    window.addEventListener("popstate", rerender);
  }
  void loadGuidedCatalog(client);
  injectStyles();
  ensureHomeGlassStyles();

  const route = currentRoute();
  const m = /^\/learn\/([a-z0-9-]+)/.exec(route.split("?")[0] ?? "");
  const trackId = m?.[1];
  const gs = guidedState();

  if (trackId && gs.loaded) {
    const track = findTrack(trackId);
    const wtParam = new URLSearchParams(route.split("?")[1] ?? "").get("walkthrough");
    if (track && wtParam && ui.autoStarted !== `${trackId}/${wtParam}`) {
      ui.autoStarted = `${trackId}/${wtParam}`;
      setTimeout(() => void startWalkthrough(track.id, wtParam), 300);
    }
    return html`<div class="lv2" data-learn-id="learn-page">${track ? renderTrackPage(track) : renderMissingTrack(trackId)}</div>`;
  }

  return html`
    <div class="lv2" data-learn-id="learn-page">
      ${renderHero()}
      <nav class="lv2-tabs" role="tablist" aria-label="Learn sections" data-learn-id="learn-tabs">
        ${tabBtn("tracks", "Tracks")} ${tabBtn("cert", "Certification")} ${tabBtn("classic", "Classic & admin")}
      </nav>
      ${!gs.loaded ? renderSkeleton() : nothing}
      ${gs.loaded && ui.tab === "tracks" ? renderCatalog() : nothing}
      ${gs.loaded && ui.tab === "cert" ? renderCertification() : nothing}
      ${ui.tab === "classic" ? html`<div class="lv2-classic">${renderLearnClassic(state as never, client)}</div>` : nothing}
      ${ui.certSvg ? renderCertOverlay() : nothing}
    </div>
  `;
}

function tabBtn(id: PageTab, label: string) {
  return html`<button
    role="tab"
    aria-selected=${ui.tab === id}
    class="lv2-tab ${ui.tab === id ? "on" : ""}"
    data-learn-id=${`learn-tab-${id}`}
    @click=${() => {
      ui.tab = id;
      rerender();
    }}
  >${label}</button>`;
}

// ── hero ──────────────────────────────────────────────────────────────

function renderHero(): TemplateResult {
  const tracks = availableTracks();
  const statuses = tracks.map(statusOf);
  const doneTracks = statuses.filter((s) => s.completed).length;
  const wDone = statuses.reduce((n, s) => n + s.walkthroughsDone, 0);
  const wTotal = statuses.reduce((n, s) => n + s.walkthroughsTotal, 0);
  const earned = badges();
  const ladder = certLadder();
  const tier = [...ladder].reverse().find((r) => r.eligible)?.tier;
  const inProgress = tracks.find((t) => {
    const s = statusOf(t);
    return s.percent > 0 && !s.completed;
  });
  const gs = guidedState();
  return html`
    <header class="lv2-hero">
      <div class="lv2-hero-main">
        <div class="lv2-eyebrow">Learn InfiniBot</div>
        <h1>Guided walkthroughs over the real app</h1>
        <p>
          Every track opens the right page, points at the real controls and waits for you to try them.
          Risky actions (trades, transactions, sends) are explained, never performed.
        </p>
        <div class="lv2-stats" role="list">
          ${stat(`${doneTracks}/${tracks.length}`, "tracks complete")}
          ${stat(`${wDone}/${wTotal}`, "walkthroughs")}
          ${stat(String(earned.length), "badges")}
          ${stat(tier ? cap(tier) : "—", "certification")}
        </div>
        ${gs.source === "local"
          ? html`<div class="lv2-note" role="note">Progress is saved on this device until the gateway is updated to sync it.</div>`
          : nothing}
      </div>
      <div class="lv2-hero-side">
        <label class="lv2-search">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input
            type="search"
            placeholder="Search tracks, walkthroughs, plugins…"
            aria-label="Search Learn"
            data-learn-id="learn-search"
            .value=${ui.query}
            @input=${(e: Event) => {
              ui.query = (e.target as HTMLInputElement).value;
              ui.tab = "tracks";
              rerender();
            }}
          />
        </label>
        ${inProgress
          ? html`<button class="lv2-btn primary" data-learn-id="learn-resume" @click=${() => void startTrack(inProgress.id)}>
              Resume · ${inProgress.title}
            </button>`
          : nothing}
      </div>
    </header>
  `;
}

function stat(value: string, label: string) {
  return html`<div class="lv2-stat" role="listitem"><strong>${value}</strong><span>${label}</span></div>`;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function renderSkeleton() {
  return html`<div class="lv2-grid" aria-busy="true">
    ${Array.from({ length: 6 }, () => html`<div class="lv2-card lv2-skel"><div></div><div></div><div></div></div>`)}
  </div>`;
}

// ── catalog ───────────────────────────────────────────────────────────

function matches(t: PublicLearnTrack, q: string, plugin?: CatalogPlugin): boolean {
  if (!q) return true;
  const hay = [t.title, t.summary, t.category, plugin?.name ?? "", ...t.walkthroughs.flatMap((w) => [w.title, w.summary])]
    .join(" ")
    .toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

function passesFilter(t: PublicLearnTrack): boolean {
  const s = statusOf(t);
  switch (ui.filter) {
    case "core":
      return !t.pluginId;
    case "plugins":
      return Boolean(t.pluginId);
    case "progress":
      return s.percent > 0 && !s.completed;
    case "done":
      return s.completed;
    default:
      return true;
  }
}

function renderCatalog(): TemplateResult {
  const gs = guidedState();
  const tracks = availableTracks();
  const pluginsById = new Map(gs.plugins.map((p) => [p.id, p] as const));
  const visible = tracks.filter((t) => passesFilter(t) && matches(t, ui.query, t.pluginId ? pluginsById.get(t.pluginId) : undefined));
  const core = visible.filter((t) => !t.pluginId);
  const plug = visible.filter((t) => t.pluginId);
  const touched = [...new Set([...(loadMissionStore().touched ?? []), ...((pref<string[]>("touched") ?? []) as string[])])];
  const useCases = currentUseCases();
  const recoIds = recommendTracks(tracks, gs.progress, touched, useCases.length ? 4 : 3, useCases.length ? useCaseTrackBoost(useCases) : undefined);
  const recoWhy = useCases.length
    ? `Picked for your goals: ${useCases.map((id) => useCaseById(id)?.title ?? id).join(", ")}`
    : "Based on what you have and haven't used yet";
  const reco = recoIds.map((id) => tracks.find((t) => t.id === id)).filter((t): t is PublicLearnTrack => Boolean(t));
  const searching = ui.query.trim().length > 0 || ui.filter !== "all";
  const groups = new Map<string, PublicLearnTrack[]>();
  for (const t of plug) {
    const k = t.pluginId!;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(t);
  }
  return html`
    ${!searching ? renderLearningPath() : nothing}
    ${!searching ? renderMissionsStrip() : nothing}
    ${!searching && reco.length
      ? html`<section class="lv2-section" aria-labelledby="lv2-reco" data-learn-id="learn-recommended">
          <div class="lv2-section-head"><h2 id="lv2-reco">Recommended next</h2><span>${recoWhy}</span></div>
          <div class="lv2-grid lv2-grid-reco">${reco.map((t) => trackCard(t, pluginsById.get(t.pluginId ?? ""), true))}</div>
        </section>`
      : nothing}
    <div class="lv2-filters" role="group" aria-label="Filter tracks" data-learn-id="learn-filters">
      ${filterChip("all", "All")} ${filterChip("core", "Core")} ${filterChip("plugins", "Plugins")}
      ${filterChip("progress", "In progress")} ${filterChip("done", "Completed")}
    </div>
    ${visible.length === 0
      ? html`<div class="lv2-empty">${ui.query.trim()
          ? `No tracks match “${ui.query}”. Try a feature name like “goals” or a plugin like “Infinitrade”.`
          : tracks.length === 0
            ? "No tracks yet — they appear as soon as the catalog loads."
            : "Nothing here yet. Try another filter."}</div>`
      : nothing}
    ${core.length
      ? html`<section class="lv2-section" aria-labelledby="lv2-core" data-learn-id="learn-core-tracks">
          <div class="lv2-section-head"><h2 id="lv2-core">Core tracks</h2><span>${core.length} tracks · everything built into InfiniBot</span></div>
          <div class="lv2-grid">${core.map((t) => trackCard(t))}</div>
        </section>`
      : nothing}
    ${groups.size
      ? html`<section class="lv2-section" aria-labelledby="lv2-plug" data-learn-id="learn-plugin-tracks">
          <div class="lv2-section-head"><h2 id="lv2-plug">Plugin tracks</h2><span>Shipped by your enabled plugins — they appear when a plugin is turned on</span></div>
          ${[...groups.entries()].map(([pid, list]) => {
            const p = pluginsById.get(pid);
            return html`<div class="lv2-plugin-group" data-learn-id=${`learn-plugin-${pid}`} style=${accentStyle(p)}>
              <div class="lv2-plugin-head">
                ${monogram(p, pid)}
                <div><h3>${p?.name ?? pid}</h3><span>${list.length} track${list.length === 1 ? "" : "s"}</span></div>
              </div>
              <div class="lv2-grid">${list.map((t) => trackCard(t, p))}</div>
            </div>`;
          })}
        </section>`
      : nothing}
  `;
}

function filterChip(id: Filter, label: string) {
  return html`<button
    class="lv2-chip ${ui.filter === id ? "on" : ""}"
    aria-pressed=${ui.filter === id}
    data-learn-id=${`learn-filter-${id}`}
    @click=${() => {
      ui.filter = id;
      rerender();
    }}
  >${label}</button>`;
}

function accentStyle(p?: CatalogPlugin): string {
  const dark = document.documentElement.dataset.theme === "light" ? p?.accent?.light : p?.accent?.dark;
  return dark ? `--lv2-accent:${dark}` : "";
}

function monogram(p: CatalogPlugin | undefined, fallbackId: string) {
  const text = p?.monogram ?? (p?.name ?? fallbackId).replace(/[^A-Za-z0-9 ]/g, "").split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  return html`<span class="lv2-mono" aria-hidden="true">${text}</span>`;
}

const LEVEL_LABEL = { beginner: "Beginner", intermediate: "Intermediate", advanced: "Advanced" } as const;

function ring(percent: number) {
  const r = 16;
  const c = 2 * Math.PI * r;
  return html`<svg class="lv2-ring" viewBox="0 0 40 40" width="40" height="40" role="img" aria-label=${`${percent}% complete`}>
    <circle cx="20" cy="20" r=${r} class="bg"></circle>
    <circle cx="20" cy="20" r=${r} class="fg" stroke-dasharray=${`${(percent / 100) * c} ${c}`}></circle>
    <text x="20" y="24" text-anchor="middle">${percent}</text>
  </svg>`;
}

function trackCard(t: PublicLearnTrack, plugin?: CatalogPlugin, reco = false) {
  const s = statusOf(t);
  return html`<article class="lv2-card ${s.completed ? "done" : ""}" data-learn-track=${t.id} style=${accentStyle(plugin)}>
    <div class="lv2-card-top">
      ${plugin ? monogram(plugin, t.pluginId!) : html`<span class="lv2-mono core" aria-hidden="true">${t.badge.icon ?? "◆"}</span>`}
      <div class="lv2-card-tags">
        <span class="lv2-tag">${t.category}</span>
        <span class="lv2-tag lvl-${t.level}">${LEVEL_LABEL[t.level]}</span>
        ${reco ? html`<span class="lv2-tag reco">Recommended</span>` : nothing}
      </div>
      ${ring(s.percent)}
    </div>
    <h3><button class="lv2-stretch" data-learn-id=${`learn-track-${t.id}`} @click=${() => navigateTo(`/learn/${t.id}`)}>${t.title}</button></h3>
    <p>${t.summary}</p>
    <div class="lv2-card-foot">
      <span>${t.walkthroughs.length} walkthroughs · ~${t.estMinutes ?? 5} min</span>
      ${s.completed ? html`<span class="lv2-badge-earned" title=${t.badge.label}>${t.badge.icon ?? "★"} ${t.badge.label}</span>` : nothing}
    </div>
  </article>`;
}

// ── Day-1 missions (inline; dismissible for good) ─────────────────────

/**
 * "Your learning path": the guided lessons picked from the onboarding answers,
 * in order, with progress and one button to carry on (learning-path.ts).
 */
function renderLearningPath(): TemplateResult | typeof nothing {
  const cur = currentPath();
  const useCases = currentUseCases();
  if (!cur || !cur.items.length) {
    if (!useCases.length) return nothing;
    // Finished onboarding before paths existed: offer to build one.
    return html`<section class="lv2-missions lv2-path" aria-labelledby="lv2-path" data-learn-id="learn-path">
      <div class="lv2-missions-head">
        <div>
          <h2 id="lv2-path">Your learning path</h2>
          <span>Short guided lessons picked for ${useCases.map((id) => useCaseById(id)?.title ?? id).join(", ")}.</span>
        </div>
        <button class="lv2-btn primary" data-learn-id="learn-path-build" @click=${async () => {
          await createPath(planFor(useCases).courses, useCases);
          await startPath();
        }}>Build my path and start</button>
      </div>
    </section>`;
  }
  const progress = walkthroughProgressMap();
  const prog = pathProgress(cur.items, progress);
  const nextIdx = cur.items.findIndex((i) => progress[i.ref]?.status !== "completed");
  const pct = prog.total ? Math.round((prog.done / prog.total) * 100) : 0;
  return html`<section class="lv2-missions lv2-path" aria-labelledby="lv2-path" data-learn-id="learn-path">
    <div class="lv2-missions-head">
      <div>
        <h2 id="lv2-path">Your learning path</h2>
        <span>${prog.done === prog.total
          ? "All done. You know your way around InfiniBot."
          : `${prog.done} of ${prog.total} done · about ${prog.minutesLeft} min left · each lesson walks you through the real app`}</span>
      </div>
      <div class="lv2-row">
        ${prog.done < prog.total
          ? html`<button class="lv2-btn primary" data-learn-id="learn-path-continue" @click=${() => void startPath()}>
              ${prog.done ? "Continue my path" : "Start my path"}
            </button>`
          : nothing}
        <button class="lv2-btn ghost" data-learn-id="learn-path-auto" aria-pressed=${cur.stored.auto ? "true" : "false"}
          title="Start the next lesson by itself when one finishes"
          @click=${() => void setPathAuto(!cur.stored.auto)}>
          ${cur.stored.auto ? "Auto-continue: on" : "Auto-continue: off"}
        </button>
      </div>
    </div>
    <div class="lv2-path-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${pct}><span style="width:${pct}%"></span></div>
    <ol class="lv2-mission-list">
      ${cur.items.map((i, n) => {
        const done = progress[i.ref]?.status === "completed";
        const next = n === nextIdx;
        return html`<li class="${done ? "done" : ""} ${next ? "next" : ""}">
          <span class="lv2-mission-n">${done ? "✓" : n + 1}</span>
          <div><strong>${i.title}</strong><span>${i.trackTitle} · ~${i.estMinutes} min${next ? " · up next" : ""}</span></div>
          <button class="lv2-btn ${done ? "ghost" : next ? "primary" : ""}" @click=${() => void startWalkthrough(i.trackId, i.walkthroughId)}>
            ${done ? "Replay" : "Start"}
          </button>
        </li>`;
      })}
    </ol>
  </section>`;
}

function renderMissionsStrip(): TemplateResult | typeof nothing {
  const gs = guidedState();
  if (pref<boolean>("missionsDismissed")) return nothing;
  const items = gs.missions
    .filter((m) => m.starter)
    .map((m) => {
      const [tid, wid] = m.walkthrough.split("/");
      const t = findTrack(tid!);
      const w = t?.walkthroughs.find((x) => x.id === wid);
      return t && w ? { t, w, done: walkthroughProgress(t.id, w.id)?.status === "completed" } : null;
    })
    .filter((x): x is { t: PublicLearnTrack; w: LearnWalkthrough; done: boolean } => Boolean(x));
  if (!items.length) return nothing;
  const left = items.filter((i) => !i.done).length;
  return html`<section class="lv2-missions" aria-labelledby="lv2-day1" data-learn-id="learn-missions">
    <div class="lv2-missions-head">
      <div>
        <h2 id="lv2-day1">Day 1 missions</h2>
        <span>${left ? `${left} of ${items.length} left — a few minutes each` : "All done. Nice work."}</span>
      </div>
      <button class="lv2-btn ghost" data-learn-id="learn-missions-dismiss" @click=${() => void setPref("missionsDismissed", true)}>
        Don't show again
      </button>
    </div>
    <ol class="lv2-mission-list">
      ${items.map(
        (i, n) => html`<li class=${i.done ? "done" : ""}>
          <span class="lv2-mission-n">${i.done ? "✓" : n + 1}</span>
          <div><strong>${i.w.title}</strong><span>${i.t.title} · ~${i.w.estMinutes} min</span></div>
          <button class="lv2-btn ${i.done ? "ghost" : "primary"}" @click=${() => void startWalkthrough(i.t.id, i.w.id)}>
            ${i.done ? "Replay" : "Start"}
          </button>
        </li>`,
      )}
    </ol>
  </section>`;
}

// ── track page ────────────────────────────────────────────────────────

function renderMissingTrack(id: string): TemplateResult {
  return html`<div class="lv2-empty lv2-missing">
    <h2>That track isn't available</h2>
    <p>“${id}” may belong to a plugin that is turned off, or it needs a newer InfiniBot build.</p>
    <div class="lv2-row">
      <button class="lv2-btn primary" @click=${() => navigateTo("/learn")}>All tracks</button>
      <button class="lv2-btn" @click=${() => navigateTo("/plugins")}>Plugins</button>
    </div>
  </div>`;
}

function renderTrackPage(t: PublicLearnTrack): TemplateResult {
  const gs = guidedState();
  const plugin = t.pluginId ? gs.plugins.find((p) => p.id === t.pluginId) : undefined;
  const s = statusOf(t);
  const prereq = (t.prerequisites ?? []).map((id) => findTrack(id)).filter((x): x is PublicLearnTrack => Boolean(x));
  const deepLink = `infinibot://learn/${t.id}`;
  return html`
    <div class="lv2-track" style=${accentStyle(plugin)} data-learn-id="learn-track-page" data-track=${t.id}>
      <button class="lv2-back" data-learn-id="learn-back" @click=${() => navigateTo("/learn")}>← All tracks</button>
      <header class="lv2-track-head">
        ${plugin ? monogram(plugin, t.pluginId!) : html`<span class="lv2-mono core big" aria-hidden="true">${t.badge.icon ?? "◆"}</span>`}
        <div class="lv2-track-title">
          <div class="lv2-card-tags">
            <span class="lv2-tag">${plugin ? plugin.name : t.category}</span>
            <span class="lv2-tag lvl-${t.level}">${LEVEL_LABEL[t.level]}</span>
            <span class="lv2-tag">~${t.estMinutes ?? 5} min</span>
          </div>
          <h1>${t.title}</h1>
          <p>${t.summary}</p>
        </div>
        <div class="lv2-track-cta">
          ${ring(s.percent)}
          <button class="lv2-btn primary" data-learn-id="learn-track-start" @click=${() => void startTrack(t.id)}>
            ${s.completed ? "Replay" : s.percent > 0 ? "Continue" : "Start track"}
          </button>
        </div>
      </header>

      ${t.disclaimer ? html`<div class="lv2-disclaimer" role="note" data-learn-id="learn-disclaimer"><strong>Important:</strong> ${t.disclaimer}</div>` : nothing}

      <div class="lv2-track-body">
        <section class="lv2-overview" aria-label="Overview" data-learn-id="learn-overview">
          <h2>Overview</h2>
          <div class="lv2-md">${unsafeHTML(toSanitizedMarkdownHtml(t.overview))}</div>
          ${prereq.length
            ? html`<p class="lv2-prereq">Recommended first: ${prereq.map((p, i) => html`${i ? ", " : ""}<a href="#" @click=${(e: Event) => {
                e.preventDefault();
                navigateTo(`/learn/${p.id}`);
              }}>${p.title}</a>`)}</p>`
            : nothing}
        </section>
        <aside class="lv2-side">
          <div class="lv2-badge-card ${s.completed ? "earned" : ""}" data-learn-id="learn-badge">
            <span class="lv2-badge-icon" aria-hidden="true">${t.badge.icon ?? "★"}</span>
            <div><strong>${t.badge.label}</strong><span>${s.completed ? "Earned" : `Finish ${t.walkthroughs.length} walkthroughs${t.quiz.length ? " + the check" : ""}`}</span></div>
          </div>
          <div class="lv2-mobile-link">
            <span>Open on your phone</span>
            <code>${deepLink}</code>
            <button class="lv2-btn ghost" @click=${async () => {
              try {
                await navigator.clipboard.writeText(deepLink);
                ui.copied = true;
                rerender();
                setTimeout(() => {
                  ui.copied = false;
                  rerender();
                }, 1500);
              } catch {
                /* clipboard unavailable */
              }
            }}>${ui.copied ? "Copied" : "Copy link"}</button>
          </div>
        </aside>
      </div>

      <section class="lv2-section" aria-labelledby="lv2-wts" data-learn-id="learn-walkthroughs">
        <div class="lv2-section-head"><h2 id="lv2-wts">Guided walkthroughs</h2><span>${s.walkthroughsDone}/${s.walkthroughsTotal} done</span></div>
        <ol class="lv2-wt-list">
          ${t.walkthroughs.map((w, i) => walkthroughRow(t, w, i))}
        </ol>
      </section>

      ${t.quiz.length ? renderQuiz(t) : nothing}
    </div>
  `;
}

function walkthroughRow(t: PublicLearnTrack, w: LearnWalkthrough, i: number) {
  const p = walkthroughProgress(t.id, w.id);
  const done = p?.status === "completed";
  const started = p?.status === "in_progress";
  const risky = w.steps.some((s) => s.practice);
  const prereqMissing = (w.prerequisites ?? []).filter((ref) => {
    const full = ref.includes("/") ? ref : walkthroughRef(t.id, ref);
    return guidedState().progress.walkthroughs[full]?.status !== "completed";
  });
  return html`<li class="lv2-wt ${done ? "done" : ""}" data-learn-walkthrough=${w.id}>
    <span class="lv2-wt-n" aria-hidden="true">${done ? "✓" : i + 1}</span>
    <div class="lv2-wt-main">
      <h3>${w.title}</h3>
      <p>${w.summary}</p>
      <div class="lv2-wt-meta">
        <span>${w.steps.length} steps</span><span>~${w.estMinutes} min</span>
        ${risky ? html`<span class="lv2-safe" title="Risky actions are explained, never performed">🛡 Safe practice</span>` : nothing}
        ${w.requires ? html`<span class="lv2-bonus" title="Covers newer UI; optional for the badge">Bonus</span>` : nothing}
        ${prereqMissing.length ? html`<span class="lv2-warn">Best after: ${prereqMissing.join(", ")}</span>` : nothing}
      </div>
    </div>
    <div class="lv2-wt-actions">
      <button
        class="lv2-btn ${done ? "" : "primary"}"
        data-learn-id=${`learn-start-${t.id}-${w.id}`}
        @click=${() => void startWalkthrough(t.id, w.id, started && p?.stepId ? { stepId: p.stepId } : {})}
      >${done ? "Replay" : started ? "Resume" : "Start"}</button>
      ${done || started ? html`<button class="lv2-btn ghost" title="Reset progress" aria-label=${`Reset ${w.title}`} @click=${() => void resetWalkthrough(t.id, w.id)}>Reset</button>` : nothing}
    </div>
  </li>`;
}

function renderQuiz(t: PublicLearnTrack): TemplateResult {
  const answers = ui.quiz[t.id] ?? [];
  const result = ui.quizResult[t.id];
  const best = guidedState().progress.quizzes[t.id];
  const all = t.quiz.every((_, i) => typeof answers[i] === "number");
  return html`<section class="lv2-section lv2-quiz" aria-labelledby="lv2-quiz" data-learn-id="learn-quiz">
    <div class="lv2-section-head">
      <h2 id="lv2-quiz">Quick check</h2>
      <span>${best ? `Best: ${best.score}/${best.total}${best.passed ? " · passed" : ""}` : `${t.quiz.length} questions · 70% to pass`}</span>
    </div>
    <ol class="lv2-q-list">
      ${t.quiz.map((q, qi) => {
        const r = result?.results[qi];
        return html`<li class="lv2-q ${r ? (r.correct ? "ok" : "bad") : ""}">
          <fieldset>
            <legend>${q.prompt}</legend>
            ${q.options.map(
              (o, oi) => html`<label class="lv2-opt ${r && r.answer === oi ? "answer" : ""}">
                <input
                  type="radio"
                  name=${`q-${t.id}-${q.id}`}
                  .checked=${answers[qi] === oi}
                  @change=${() => {
                    const next = [...(ui.quiz[t.id] ?? [])];
                    next[qi] = oi;
                    ui.quiz[t.id] = next;
                    ui.quizResult[t.id] = null;
                    rerender();
                  }}
                />
                <span>${o}</span>
              </label>`,
            )}
            ${r && r.explain ? html`<p class="lv2-explain">${r.correct ? "Correct. " : "Not quite. "}${r.explain}</p>` : nothing}
          </fieldset>
        </li>`;
      })}
    </ol>
    <div class="lv2-row">
      <button
        class="lv2-btn primary"
        data-learn-id="learn-quiz-submit"
        ?disabled=${!all || ui.quizBusy}
        @click=${async () => {
          ui.quizBusy = true;
          rerender();
          ui.quizResult[t.id] = await submitQuiz(t.id, answers);
          ui.quizBusy = false;
          rerender();
        }}
      >Check answers</button>
      ${result
        ? html`<span class="lv2-result ${result.passed ? "ok" : "bad"}" role="status">
            ${result.score}/${result.total} — ${result.passed ? "passed" : "70% needed, try again"}
          </span>`
        : nothing}
    </div>
  </section>`;
}

// ── certification ─────────────────────────────────────────────────────

function renderCertification(): TemplateResult {
  const ladder = certLadder();
  const tracks = availableTracks();
  const earned = badges();
  const gs = guidedState();
  const byId = new Map(tracks.map((t) => [t.id, t] as const));
  const pluginTracks = tracks.filter((t) => t.pluginId);
  const TITLES = { apprentice: "Apprentice", practitioner: "Practitioner", master: "Master" } as const;
  const BLURB = {
    apprentice: "Every beginner core track.",
    practitioner: "Apprentice + every intermediate core track.",
    master: "Practitioner + every advanced core track + one plugin mastery badge.",
  } as const;
  return html`<section class="lv2-section" data-learn-id="learn-cert">
    <div class="lv2-section-head"><h2>Certification path</h2><span>InfiniBot AI Agent Systems certification — awarded automatically</span></div>
    <div class="lv2-ladder">
      ${ladder.map(
        (r) => html`<article class="lv2-rung ${r.eligible ? "earned" : ""}">
          <div class="lv2-rung-head">
            <h3>${TITLES[r.tier]}</h3>
            ${ring(r.percent)}
          </div>
          <p>${BLURB[r.tier]}</p>
          <ul>
            ${r.required.map((id) => html`<li class=${r.done.includes(id) ? "ok" : ""}>
              <a href="#" @click=${(e: Event) => {
                e.preventDefault();
                navigateTo(`/learn/${id}`);
              }}>${byId.get(id)?.title ?? id}</a>
            </li>`)}
            ${r.needsPluginMastery ? html`<li class=${r.hasPluginMastery ? "ok" : ""}>Any plugin mastery badge</li>` : nothing}
          </ul>
          ${r.eligible && gs.source === "gateway"
            ? html`<button class="lv2-btn" @click=${() => void viewCert(r.tier)}>View certificate</button>`
            : nothing}
        </article>`,
      )}
    </div>
    <div class="lv2-section-head" style="margin-top:24px"><h2>Plugin mastery badges</h2><span>Finish a plugin's track to earn its badge</span></div>
    <div class="lv2-badges">
      ${pluginTracks.length === 0 ? html`<div class="lv2-empty">Enable a plugin to unlock its mastery track.</div>` : nothing}
      ${pluginTracks.map((t) => {
        const got = earned.some((b) => b.trackId === t.id);
        const p = gs.plugins.find((x) => x.id === t.pluginId);
        return html`<button class="lv2-badge ${got ? "earned" : ""}" style=${accentStyle(p)} @click=${() => navigateTo(`/learn/${t.id}`)}>
          ${monogram(p, t.pluginId!)}
          <span><strong>${t.badge.label}</strong><small>${got ? "Earned" : "Locked"}</small></span>
        </button>`;
      })}
    </div>
  </section>`;
}

async function viewCert(tier: string): Promise<void> {
  const c = host?.client;
  if (!c) return;
  try {
    const res = (await c.request("learn.guided.certificate", { tier })) as { svg: string };
    ui.certSvg = { tier, svg: res.svg };
    rerender();
  } catch {
    /* not awarded yet */
  }
}

function renderCertOverlay() {
  return html`<div class="lv2-cert-overlay" role="dialog" aria-modal="true" aria-label="Certificate" @click=${() => {
    ui.certSvg = null;
    rerender();
  }}>
    <div class="lv2-cert-frame" @click=${(e: Event) => e.stopPropagation()}>${unsafeHTML(ui.certSvg!.svg)}
      <button class="lv2-btn" @click=${() => {
        ui.certSvg = null;
        rerender();
      }}>Close</button>
    </div>
  </div>`;
}

// ── styles ────────────────────────────────────────────────────────────

let _styled = false;
function injectStyles(): void {
  if (_styled || typeof document === "undefined") return;
  _styled = true;
  const el = document.createElement("style");
  el.id = "learn-v2-styles";
  el.textContent = LEARN_V2_CSS;
  document.head.appendChild(el);
}

const LEARN_V2_CSS = `
.lv2 { --lv2-accent: var(--g-primary, #d4af37); box-sizing: border-box; width: 100%; max-width: none; padding: 20px clamp(14px, 2.4vw, 36px) 64px; color: var(--g-fg, #ece7da); }
.lv2 *, .lv2 *::before, .lv2 *::after { box-sizing: border-box; }
.lv2 h1, .lv2 h2, .lv2 h3 { color: var(--g-fg, #fff); margin: 0; }
.lv2-hero { display: grid; grid-template-columns: minmax(0, 1fr) minmax(260px, 380px); gap: 24px; align-items: end; padding: 26px 28px; border-radius: 22px;
  background: radial-gradient(120% 140% at 0% 0%, color-mix(in srgb, var(--lv2-accent) 18%, transparent), transparent 55%), color-mix(in srgb, var(--g-surface, #16140f) 90%, transparent);
  border: 1px solid color-mix(in srgb, var(--lv2-accent) 28%, var(--g-border, #2a2a2a)); }
.lv2-eyebrow { font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: var(--lv2-accent); font-weight: 700; margin-bottom: 8px; }
.lv2-hero h1 { font-size: clamp(22px, 2.4vw, 32px); line-height: 1.15; letter-spacing: -.01em; }
.lv2-hero p { margin: 10px 0 0; max-width: 62ch; color: var(--g-fg-muted, var(--g-fg-dim, #bdb6a4)); font-size: 14px; line-height: 1.55; }
.lv2-stats { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 18px; }
.lv2-stat { min-width: 110px; padding: 10px 14px; border-radius: 14px; border: 1px solid var(--g-border, #2d2a24); background: color-mix(in srgb, var(--g-fg, #fff) 3%, transparent); }
.lv2-stat strong { display: block; font-size: 18px; font-variant-numeric: tabular-nums; }
.lv2-stat span { font-size: 11.5px; color: var(--g-fg-dim, #a59e8c); }
.lv2-note { margin-top: 12px; font-size: 12px; color: var(--g-fg-dim, #a59e8c); }
.lv2-hero-side { display: flex; flex-direction: column; gap: 10px; }
.lv2-search { display: flex; align-items: center; gap: 8px; padding: 0 12px; min-height: 44px; border-radius: 12px; border: 1px solid var(--g-border, #34302a); background: color-mix(in srgb, var(--g-bg, #0c0b09) 60%, transparent); color: var(--g-fg-dim, #a59e8c); }
.lv2-search:focus-within { border-color: var(--lv2-accent); }
.lv2-search input { flex: 1; min-width: 0; border: 0; background: transparent; color: var(--g-fg, #fff); font: inherit; font-size: 14px; outline: none; min-height: 42px; }
.lv2-tabs { display: flex; gap: 6px; margin: 18px 0 6px; border-bottom: 1px solid var(--g-border, #2a2722); }
.lv2-tab { background: none; border: 0; border-bottom: 2px solid transparent; color: var(--g-fg-dim, #a59e8c); font: inherit; font-size: 13.5px; font-weight: 600; padding: 10px 12px; cursor: pointer; min-height: 44px; }
.lv2-tab.on, .lv2-tab:hover { color: var(--g-fg, #fff); border-bottom-color: var(--lv2-accent); }
.lv2-tab:focus-visible, .lv2-btn:focus-visible, .lv2-chip:focus-visible, .lv2-stretch:focus-visible { outline: 2px solid var(--lv2-accent); outline-offset: 2px; }
.lv2-section { margin-top: 22px; }
.lv2-section-head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
.lv2-section-head h2 { font-size: 17px; }
.lv2-section-head span { font-size: 12.5px; color: var(--g-fg-dim, #a59e8c); }
.lv2-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 270px), 1fr)); gap: 14px; }
.lv2-card { position: relative; display: flex; flex-direction: column; gap: 8px; padding: 16px; border-radius: 16px; border: 1px solid var(--g-border, #2d2a24);
  background: linear-gradient(180deg, color-mix(in srgb, var(--lv2-accent) 6%, transparent), transparent 60%), color-mix(in srgb, var(--g-surface, #16140f) 88%, transparent);
  transition: border-color .15s ease, transform .15s ease; }
.lv2-card:hover { border-color: color-mix(in srgb, var(--lv2-accent) 60%, transparent); transform: translateY(-1px); }
.lv2-card.done { border-color: color-mix(in srgb, var(--g-success, #22c55e) 45%, var(--g-border, #2d2a24)); }
.lv2-card h3 { font-size: 15px; line-height: 1.3; }
.lv2-card p { margin: 0; font-size: 13px; line-height: 1.5; color: var(--g-fg-muted, var(--g-fg-dim, #bdb6a4)); flex: 1; }
.lv2-card-top { display: flex; align-items: flex-start; gap: 10px; }
.lv2-card-tags { display: flex; flex-wrap: wrap; gap: 6px; flex: 1; }
.lv2-tag { font-size: 10.5px; font-weight: 600; letter-spacing: .03em; padding: 3px 8px; border-radius: 99px; border: 1px solid var(--g-border, #34302a); color: var(--g-fg-dim, #b3ab98); }
.lv2-tag.lvl-beginner { color: var(--g-success, #4ade80); border-color: color-mix(in srgb, var(--g-success, #4ade80) 40%, transparent); }
.lv2-tag.lvl-intermediate { color: var(--g-info, #60a5fa); border-color: color-mix(in srgb, var(--g-info, #60a5fa) 40%, transparent); }
.lv2-tag.lvl-advanced { color: var(--g-warning, #f59e0b); border-color: color-mix(in srgb, var(--g-warning, #f59e0b) 40%, transparent); }
.lv2-tag.reco { color: var(--lv2-accent); border-color: var(--lv2-accent); }
.lv2-stretch { all: unset; cursor: pointer; }
.lv2-stretch::after { content: ""; position: absolute; inset: 0; border-radius: 16px; }
.lv2-card-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 11.5px; color: var(--g-fg-dim, #a59e8c); }
.lv2-badge-earned { color: var(--g-success, #4ade80); font-weight: 600; }
.lv2-mono { flex: none; width: 36px; height: 36px; border-radius: 11px; display: grid; place-items: center; font-weight: 800; font-size: 13px; letter-spacing: .02em;
  color: var(--lv2-accent); background: color-mix(in srgb, var(--lv2-accent) 16%, transparent); border: 1px solid color-mix(in srgb, var(--lv2-accent) 45%, transparent); }
.lv2-mono.core { font-size: 16px; }
.lv2-mono.big { width: 56px; height: 56px; font-size: 24px; border-radius: 16px; }
.lv2-ring { flex: none; }
.lv2-ring .bg { fill: none; stroke: color-mix(in srgb, var(--g-fg, #fff) 12%, transparent); stroke-width: 3.5; }
.lv2-ring .fg { fill: none; stroke: var(--lv2-accent); stroke-width: 3.5; stroke-linecap: round; transform: rotate(-90deg); transform-origin: 50% 50%; }
.lv2-ring text { font-size: 10px; font-weight: 700; fill: var(--g-fg, #fff); }
.lv2-filters { display: flex; flex-wrap: wrap; gap: 8px; margin: 20px 0 4px; }
.lv2-chip { font: inherit; font-size: 12.5px; font-weight: 600; min-height: 36px; padding: 0 14px; border-radius: 99px; border: 1px solid var(--g-border, #34302a); background: transparent; color: var(--g-fg-dim, #b3ab98); cursor: pointer; }
.lv2-chip.on { color: var(--g-on-primary, #111); background: var(--lv2-accent); border-color: var(--lv2-accent); }
.lv2-plugin-group { margin-bottom: 18px; padding: 14px; border-radius: 18px; border: 1px solid color-mix(in srgb, var(--lv2-accent) 25%, var(--g-border, #2d2a24)); background: color-mix(in srgb, var(--lv2-accent) 4%, transparent); }
.lv2-plugin-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.lv2-plugin-head h3 { font-size: 15px; }
.lv2-plugin-head span { font-size: 12px; color: var(--g-fg-dim, #a59e8c); }
.lv2-btn { font: inherit; font-size: 13px; font-weight: 600; min-height: 40px; padding: 0 16px; border-radius: 11px; border: 1px solid var(--g-border, #3a352c); background: transparent; color: var(--g-fg, #fff); cursor: pointer; white-space: nowrap; }
.lv2-btn:hover:not(:disabled) { border-color: var(--lv2-accent); }
.lv2-btn.primary { background: var(--lv2-accent); border-color: var(--lv2-accent); color: var(--g-on-primary, #111); }
.lv2-btn.ghost { color: var(--g-fg-dim, #b3ab98); }
.lv2-btn:disabled { opacity: .45; cursor: not-allowed; }
.lv2-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.lv2-empty { padding: 26px; text-align: center; border: 1px dashed var(--g-border, #34302a); border-radius: 16px; color: var(--g-fg-dim, #a59e8c); }
.lv2-missing h2 { margin-bottom: 6px; }
.lv2-missing .lv2-row { justify-content: center; margin-top: 12px; }
.lv2-skel { min-height: 150px; }
.lv2-skel div { height: 12px; border-radius: 6px; background: color-mix(in srgb, var(--g-fg, #fff) 8%, transparent); }
.lv2-skel div:nth-child(1) { width: 40%; } .lv2-skel div:nth-child(2) { width: 85%; } .lv2-skel div:nth-child(3) { width: 60%; }
.lv2-missions { margin-top: 18px; padding: 16px 18px; border-radius: 18px; border: 1px solid color-mix(in srgb, var(--lv2-accent) 40%, transparent); background: color-mix(in srgb, var(--lv2-accent) 7%, transparent); }
.lv2-missions-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; }
.lv2-missions-head h2 { font-size: 16px; }
.lv2-missions-head span { font-size: 12.5px; color: var(--g-fg-dim, #a59e8c); }
.lv2-mission-list { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 280px), 1fr)); gap: 10px; }
.lv2-mission-list li { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: 14px; background: color-mix(in srgb, var(--g-surface, #16140f) 85%, transparent); border: 1px solid var(--g-border, #2d2a24); }
.lv2-mission-list li > div { flex: 1; min-width: 0; }
.lv2-mission-list strong { display: block; font-size: 13.5px; }
.lv2-mission-list span { font-size: 11.5px; color: var(--g-fg-dim, #a59e8c); }
.lv2-mission-n { flex: none; width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; font-weight: 700; font-size: 12px; border: 1px solid var(--lv2-accent); color: var(--lv2-accent); }
.lv2-path .lv2-row { display: flex; gap: 8px; flex-wrap: wrap; }
.lv2-path-bar { height: 6px; border-radius: 99px; background: color-mix(in srgb, var(--g-fg, #fff) 8%, transparent); overflow: hidden; margin: 0 0 12px; }
.lv2-path-bar span { display: block; height: 100%; border-radius: inherit; background: var(--lv2-accent); transition: width .4s ease; }
.lv2-path .lv2-mission-list li.next { border-color: var(--lv2-accent); box-shadow: 0 0 0 1px color-mix(in srgb, var(--lv2-accent) 35%, transparent); }
.lv2-mission-list li.done .lv2-mission-n { background: var(--g-success, #22c55e); border-color: var(--g-success, #22c55e); color: #fff; }
.lv2-back { background: none; border: 0; color: var(--g-fg-dim, #a59e8c); font: inherit; font-size: 13px; cursor: pointer; padding: 6px 0; min-height: 40px; }
.lv2-back:hover { color: var(--g-fg, #fff); }
.lv2-track-head { display: flex; gap: 18px; align-items: center; padding: 22px 24px; border-radius: 22px; border: 1px solid color-mix(in srgb, var(--lv2-accent) 30%, var(--g-border, #2d2a24));
  background: radial-gradient(120% 140% at 0% 0%, color-mix(in srgb, var(--lv2-accent) 16%, transparent), transparent 55%), color-mix(in srgb, var(--g-surface, #16140f) 90%, transparent); flex-wrap: wrap; }
.lv2-track-head .lv2-mono { width: 56px; height: 56px; font-size: 18px; border-radius: 16px; }
.lv2-track-title { flex: 1; min-width: 240px; }
.lv2-track-title h1 { font-size: clamp(22px, 2.2vw, 30px); margin-top: 8px; }
.lv2-track-title p { margin: 6px 0 0; color: var(--g-fg-muted, var(--g-fg-dim, #bdb6a4)); font-size: 14px; }
.lv2-track-cta { display: flex; align-items: center; gap: 12px; }
.lv2-disclaimer { margin-top: 14px; padding: 12px 16px; border-radius: 14px; font-size: 13px; line-height: 1.5; border: 1px solid color-mix(in srgb, var(--g-warning, #f59e0b) 55%, transparent); background: color-mix(in srgb, var(--g-warning, #f59e0b) 10%, transparent); }
.lv2-track-body { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 18px; margin-top: 18px; }
.lv2-overview { padding: 18px 20px; border-radius: 18px; border: 1px solid var(--g-border, #2d2a24); background: color-mix(in srgb, var(--g-surface, #16140f) 80%, transparent); }
.lv2-overview h2 { font-size: 15px; margin-bottom: 8px; }
.lv2-md { font-size: 13.5px; line-height: 1.65; color: var(--g-fg-muted, var(--g-fg-dim, #c9c2b0)); }
.lv2-md p { margin: 0 0 10px; } .lv2-md ul { margin: 0 0 10px; padding-left: 18px; }
.lv2-prereq { font-size: 12.5px; color: var(--g-fg-dim, #a59e8c); margin: 8px 0 0; }
.lv2-prereq a, .lv2-rung a { color: var(--lv2-accent); }
.lv2-side { display: flex; flex-direction: column; gap: 12px; }
.lv2-badge-card { display: flex; gap: 12px; align-items: center; padding: 14px; border-radius: 16px; border: 1px solid var(--g-border, #2d2a24); }
.lv2-badge-card.earned { border-color: var(--g-success, #22c55e); }
.lv2-badge-card strong { display: block; font-size: 13.5px; } .lv2-badge-card span { font-size: 12px; color: var(--g-fg-dim, #a59e8c); }
.lv2-badge-icon { width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center; font-size: 20px; border: 2px solid var(--lv2-accent); background: color-mix(in srgb, var(--lv2-accent) 14%, transparent); flex: none; }
.lv2-badge-card:not(.earned) .lv2-badge-icon { filter: grayscale(1); opacity: .6; }
.lv2-mobile-link { display: flex; flex-direction: column; gap: 6px; padding: 14px; border-radius: 16px; border: 1px solid var(--g-border, #2d2a24); font-size: 12px; color: var(--g-fg-dim, #a59e8c); }
.lv2-mobile-link code { font-size: 11.5px; word-break: break-all; color: var(--g-fg, #fff); }
.lv2-wt-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.lv2-wt { display: flex; gap: 14px; align-items: center; padding: 14px 16px; border-radius: 16px; border: 1px solid var(--g-border, #2d2a24); background: color-mix(in srgb, var(--g-surface, #16140f) 80%, transparent); }
.lv2-wt.done { border-color: color-mix(in srgb, var(--g-success, #22c55e) 45%, var(--g-border, #2d2a24)); }
.lv2-wt-n { flex: none; width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; font-weight: 700; border: 1px solid var(--lv2-accent); color: var(--lv2-accent); }
.lv2-wt.done .lv2-wt-n { background: var(--g-success, #22c55e); border-color: var(--g-success, #22c55e); color: #fff; }
.lv2-wt-main { flex: 1; min-width: 0; }
.lv2-wt-main h3 { font-size: 14.5px; }
.lv2-wt-main p { margin: 3px 0 6px; font-size: 13px; color: var(--g-fg-muted, var(--g-fg-dim, #bdb6a4)); line-height: 1.45; }
.lv2-wt-meta { display: flex; gap: 12px; flex-wrap: wrap; font-size: 11.5px; color: var(--g-fg-dim, #a59e8c); }
.lv2-safe { color: var(--g-success, #4ade80); } .lv2-warn { color: var(--g-warning, #f59e0b); } .lv2-bonus { color: var(--lv2-accent); font-weight: 600; }
.lv2-wt-actions { display: flex; gap: 6px; flex: none; }
.lv2-q-list { list-style: none; padding: 0; margin: 0; display: grid; gap: 12px; }
.lv2-q fieldset { border: 1px solid var(--g-border, #2d2a24); border-radius: 16px; padding: 14px 16px; margin: 0; }
.lv2-q.ok fieldset { border-color: var(--g-success, #22c55e); } .lv2-q.bad fieldset { border-color: var(--g-danger, #ef4444); }
.lv2-q legend { font-weight: 600; font-size: 14px; padding: 0 6px; color: var(--g-fg, #fff); }
.lv2-opt { display: flex; gap: 10px; align-items: center; padding: 8px 6px; border-radius: 10px; font-size: 13.5px; cursor: pointer; min-height: 40px; }
.lv2-opt:hover { background: color-mix(in srgb, var(--g-fg, #fff) 5%, transparent); }
.lv2-opt.answer { outline: 1px solid var(--g-success, #22c55e); }
.lv2-opt input { width: 18px; height: 18px; accent-color: var(--lv2-accent); }
.lv2-explain { margin: 8px 6px 0; font-size: 12.5px; color: var(--g-fg-dim, #b3ab98); }
.lv2-result.ok { color: var(--g-success, #4ade80); font-weight: 600; } .lv2-result.bad { color: var(--g-danger, #f87171); font-weight: 600; }
.lv2-quiz .lv2-row { margin-top: 12px; }
.lv2-ladder { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr)); gap: 14px; }
.lv2-rung { padding: 16px 18px; border-radius: 18px; border: 1px solid var(--g-border, #2d2a24); background: color-mix(in srgb, var(--g-surface, #16140f) 85%, transparent); }
.lv2-rung.earned { border-color: var(--lv2-accent); box-shadow: 0 0 0 1px color-mix(in srgb, var(--lv2-accent) 30%, transparent) inset; }
.lv2-rung-head { display: flex; align-items: center; justify-content: space-between; }
.lv2-rung p { font-size: 12.5px; color: var(--g-fg-dim, #a59e8c); margin: 6px 0 10px; }
.lv2-rung ul { list-style: none; padding: 0; margin: 0 0 10px; display: grid; gap: 5px; font-size: 12.5px; }
.lv2-rung li::before { content: "○ "; color: var(--g-fg-dim, #8a8474); } .lv2-rung li.ok::before { content: "● "; color: var(--g-success, #4ade80); }
.lv2-badges { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 230px), 1fr)); gap: 10px; }
.lv2-badge { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 14px; border: 1px solid var(--g-border, #2d2a24); background: transparent; color: var(--g-fg, #fff); font: inherit; text-align: left; cursor: pointer; min-height: 56px; }
.lv2-badge:not(.earned) { opacity: .62; } .lv2-badge.earned { border-color: var(--lv2-accent); }
.lv2-badge strong { display: block; font-size: 13px; } .lv2-badge small { font-size: 11px; color: var(--g-fg-dim, #a59e8c); }
.lv2-cert-overlay { position: fixed; inset: 0; z-index: 10070; background: rgba(0,0,0,.6); display: grid; place-items: center; padding: 20px; }
.lv2-cert-frame { max-width: min(900px, 95vw); display: flex; flex-direction: column; gap: 12px; align-items: center; }
.lv2-cert-frame svg { width: 100%; height: auto; border-radius: 12px; }
.lv2-classic { margin-top: 10px; }
@media (max-width: 900px) {
  .lv2-hero { grid-template-columns: 1fr; padding: 20px; }
  .lv2-track-body { grid-template-columns: 1fr; }
}
@media (max-width: 560px) {
  .lv2 { padding: 12px 12px 48px; }
  .lv2-stat { min-width: calc(50% - 5px); }
  .lv2-wt { flex-wrap: wrap; }
  .lv2-wt-actions { width: 100%; }
  .lv2-wt-actions .lv2-btn { flex: 1; }
  .lv2-track-head { padding: 16px; }
  .lv2-tabs { overflow-x: auto; }
}
@media (prefers-reduced-motion: reduce) { .lv2-card { transition: none; } .lv2-card:hover { transform: none; } }
`;
