/**
 * Clock sections — the plugin slot inside the expanded topbar clock.
 *
 * A loaded manifest-v2 plugin declares `contributes.clockSections`
 * (plugin-host.ts → pluginClockSections()). The clock panel lists one toggle
 * per section; switched on, the section's body renders under the clock. The
 * on/off choice is stored per user in localStorage. When the plugin is
 * disabled (or the owner switches the contribution off) the section and its
 * toggle disappear on the next plugins.list sync.
 *
 * First-party bodies are compiled into the control UI as lazy chunks keyed by
 * the manifest's `builtin`. Design: docs/plugins/CLOCK-SECTIONS.md.
 */

import { html, nothing, type TemplateResult } from "lit";

import type { PluginClockSection } from "../plugin-host.js";

/** What a clock section body receives on every render. */
export type ClockSectionContext = {
  /** The clock's current time (the app's 1 Hz tick). */
  now: Date;
  /** Gateway client for read-only RPCs (may be null while connecting). */
  client: { request: <T = unknown>(method: string, params?: unknown) => Promise<T> } | null;
  requestUpdate: () => void;
};

export type ClockSectionModule = {
  renderClockSection: (ctx: ClockSectionContext) => TemplateResult;
};

/** First-party clock-section bodies, keyed by manifest `clockSections[].builtin`. */
export const FIRST_PARTY_CLOCK_SECTIONS: Readonly<Record<string, () => Promise<ClockSectionModule>>> = {
  "infinitrade-sessions": () => import("../../../../extensions/infinitrade/ui/clock-sessions.js"),
};

// ── per-user toggle state ────────────────────────────────────────────────

export const CLOCK_SECTIONS_STORAGE_KEY = "infinibot.clock.sections.v1";

type PrefStore = Record<string, Record<string, boolean>>;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function storage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function readStore(s: StorageLike | null): PrefStore {
  try {
    const raw = s?.getItem(CLOCK_SECTIONS_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as PrefStore) : {};
  } catch {
    return {};
  }
}

/** Whether a section is switched on for this user (defaults from the manifest). */
export function isClockSectionOn(section: PluginClockSection, userKey: string, s: StorageLike | null = storage()): boolean {
  const v = readStore(s)[userKey]?.[section.key];
  return typeof v === "boolean" ? v : section.defaultEnabled;
}

export function setClockSectionOn(section: PluginClockSection, userKey: string, on: boolean, s: StorageLike | null = storage()): void {
  const store = readStore(s);
  store[userKey] = { ...store[userKey], [section.key]: on };
  try {
    s?.setItem(CLOCK_SECTIONS_STORAGE_KEY, JSON.stringify(store));
  } catch {
    /* private mode — the choice lasts for this page only */
  }
}

// ── lazy bodies ──────────────────────────────────────────────────────────

const loaded = new Map<string, ClockSectionModule>();
const failed = new Set<string>();
const pending = new Set<string>();

function ensureLoaded(builtin: string, requestUpdate: () => void): ClockSectionModule | null {
  const hit = loaded.get(builtin);
  if (hit) return hit;
  const load = FIRST_PARTY_CLOCK_SECTIONS[builtin];
  if (!load || failed.has(builtin) || pending.has(builtin)) return null;
  pending.add(builtin);
  load()
    .then((mod) => loaded.set(builtin, mod))
    .catch((err) => {
      failed.add(builtin);
      console.warn("[clock-sections] failed to load", builtin, err);
    })
    .finally(() => {
      pending.delete(builtin);
      requestUpdate();
    });
  return null;
}

/** Sections this UI can actually draw (unknown builtins are skipped). */
export function renderableClockSections(sections: readonly PluginClockSection[]): PluginClockSection[] {
  return sections.filter((s) => s.builtin in FIRST_PARTY_CLOCK_SECTIONS);
}

/**
 * The toggle row + enabled bodies for the expanded clock. Renders nothing
 * when no plugin contributes a section.
 */
export function renderClockSections(args: {
  sections: readonly PluginClockSection[];
  userKey: string;
  ctx: ClockSectionContext;
}): TemplateResult | typeof nothing {
  const sections = renderableClockSections(args.sections);
  if (!sections.length) return nothing;
  const { ctx, userKey } = args;
  return html`
    <div class="ibc-sections" role="group" aria-label="Clock sections">
      <div class="ibc-sections__toggles">
        ${sections.map((s) => {
          const on = isClockSectionOn(s, userKey);
          return html`
            <label class="ibc-switch" title=${s.description ?? `${s.label} · from ${s.pluginName}`}>
              <input
                type="checkbox"
                role="switch"
                data-clock-section=${s.key}
                .checked=${on}
                aria-checked=${on ? "true" : "false"}
                @change=${(e: Event) => {
                  setClockSectionOn(s, userKey, (e.target as HTMLInputElement).checked);
                  ctx.requestUpdate();
                }}
              />
              <span class="ibc-switch__track" aria-hidden="true"><span class="ibc-switch__thumb"></span></span>
              <span class="ibc-switch__label">${s.label}</span>
              <span class="ibc-switch__source">${s.pluginName}</span>
            </label>
          `;
        })}
      </div>
      ${sections
        .filter((s) => isClockSectionOn(s, userKey))
        .map((s) => {
          const mod = ensureLoaded(s.builtin, ctx.requestUpdate);
          return html`<section class="ibc-section" data-section=${s.key} aria-label=${s.label}>
            ${mod
              ? mod.renderClockSection(ctx)
              : failed.has(s.builtin)
                ? html`<div class="ibc-section__empty">${s.label} could not load.</div>`
                : html`<div class="ibc-section__empty">Loading ${s.label}…</div>`}
          </section>`;
        })}
    </div>
  `;
}
