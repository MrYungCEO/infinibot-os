import { LitElement, html, css, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  type LicenseState,
  hasFeature,
  minimumPlanFor,
  subscribeLicenseState,
} from "../lib/license";
import { openUpgradeModal } from "../components/upgrade-modal";
import "../components/upgrade-chip";

/**
 * Optional download packs map to gateable license features. None is premium
 * today (voice is free: local voice by default, Cloud voice optional). Add
 * entries here as packs become paid unlocks.
 */
const PACK_FEATURE: Record<string, string> = {};

/** Resolve the gating feature for a pack, by exact name. */
function packFeature(name: string): string | null {
  return PACK_FEATURE[name.toLowerCase()] ?? null;
}

/**
 * Settings → Components tab.
 *
 * Lists the optional download-on-demand packs (local LLM, video,
 * browser, image, federation) and lets the user install / remove each.
 * Talks to the Electron main process over the preload `window.api.components`
 * bridge (see electron/preload.js + electron/components/installer.js).
 *
 * When opened in a plain browser (no Electron preload), it degrades to an
 * explanatory message instead of failing — component management is a
 * desktop-app capability because it writes binaries to disk.
 */

interface PackInfo {
  name: string;
  title: string;
  description: string;
  size: number;
  installed: boolean;
  requestedAtSetup?: boolean;
  enablesFeatures?: string[];
}

type ComponentsBridge = {
  list: () => Promise<PackInfo[]>;
  status: (name: string) => Promise<unknown>;
  install: (name: string) => Promise<unknown>;
  remove: (name: string) => Promise<unknown>;
  onProgress: (cb: (p: { name: string; phase: string; percent?: number }) => void) => () => void;
};

function bridge(): ComponentsBridge | null {
  const api = (window as unknown as { api?: { components?: ComponentsBridge } }).api;
  return api?.components ?? null;
}

function fmtSize(bytes: number): string {
  if (!bytes) return "";
  const mb = bytes / 1_000_000;
  if (mb >= 1000) return `${(mb / 1000).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

@customElement("components-settings")
export class ComponentsSettings extends LitElement {
  @state() private packs: PackInfo[] = [];
  @state() private busy: Record<string, string> = {};
  @state() private progress: Record<string, number> = {};
  @state() private error = "";
  @state() private supported = true;
  @state() private loading = true;
  @state() private license: LicenseState | null = null;

  private unsub?: () => void;
  private unsubLicense?: () => void;

  connectedCallback(): void {
    super.connectedCallback();
    this.unsubLicense = subscribeLicenseState((s) => {
      this.license = s;
    });
    const b = bridge();
    this.supported = !!b;
    if (!b) this.loading = false;
    if (b) {
      this.unsub = b.onProgress((p) => {
        if (typeof p.percent === "number") {
          this.progress = { ...this.progress, [p.name]: p.percent };
        }
        if (p.phase === "done") {
          this.busy = { ...this.busy, [p.name]: "" };
        }
      });
      void this.refresh();
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsub?.();
    this.unsubLicense?.();
  }

  private async refresh(): Promise<void> {
    const b = bridge();
    if (!b) return;
    try {
      this.packs = await b.list();
      this.error = "";
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.loading = false;
    }
  }

  private async install(name: string): Promise<void> {
    // License gate: clicking a locked pack's install pops the upgrade modal
    // instead of downloading.
    const feature = packFeature(name);
    if (feature && !hasFeature(this.license, feature)) {
      openUpgradeModal(minimumPlanFor(feature) ?? "ceo", feature);
      return;
    }
    const b = bridge();
    if (!b) return;
    this.busy = { ...this.busy, [name]: "Installing" };
    this.progress = { ...this.progress, [name]: 0 };
    try {
      await b.install(name);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.busy = { ...this.busy, [name]: "" };
      await this.refresh();
    }
  }

  private async removePack(name: string): Promise<void> {
    const b = bridge();
    if (!b) return;
    this.busy = { ...this.busy, [name]: "Removing" };
    try {
      await b.remove(name);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.busy = { ...this.busy, [name]: "" };
      await this.refresh();
    }
  }

  static styles = css`
    :host {
      display: block;
      --gs-gold: var(--glass-gold, var(--g-primary, #d4af37));
      color: var(--text);
      --gs-1: var(--glass-1, color-mix(in srgb, var(--panel) 76%, transparent));
      --gs-2: var(--glass-2, color-mix(in srgb, var(--panel) 88%, transparent));
      --gs-3: var(--glass-3, color-mix(in srgb, var(--bg-elevated) 94%, transparent));
      --gs-stroke: var(--glass-stroke, color-mix(in srgb, var(--gs-gold) 18%, var(--border)));
      --gs-stroke-strong: var(--glass-stroke-strong, color-mix(in srgb, var(--gs-gold) 42%, var(--border-strong)));
      --gs-glow: color-mix(in srgb, var(--gs-gold) 24%, transparent);
      --gs-shadow: 0 20px 58px color-mix(in srgb, var(--bg) 52%, transparent), inset 0 1px 0 color-mix(in srgb, var(--text) 9%, transparent);
      position: relative;
      isolation: isolate;
    }
    :host::before {
      content: "";
      position: absolute;
      inset: -18px;
      z-index: -1;
      pointer-events: none;
      background: radial-gradient(circle at 8% 0%, var(--gs-glow), transparent 34%), radial-gradient(circle at 92% 28%, color-mix(in srgb, var(--gs-gold) 8%, transparent), transparent 32%);
    }
    .head {
      display: flex;
      align-items: end;
      justify-content: space-between;
      gap: 20px;
      margin-bottom: 18px;
      padding: 22px 24px;
      border: 1px solid var(--gs-stroke);
      border-radius: 20px;
      background: linear-gradient(125deg, color-mix(in srgb, var(--gs-gold) 9%, transparent), var(--gs-2));
      box-shadow: var(--gs-shadow);
      backdrop-filter: blur(22px) saturate(145%);
    }
    .kicker { color: var(--gs-gold); font-size: 10px; font-weight: 750; letter-spacing: .2em; text-transform: uppercase; }
    .head h2 { margin: 5px 0 5px; font-size: 28px; letter-spacing: -.035em; }
    .head p { max-width: 68ch; margin: 0; color: var(--muted); font-size: 13px; line-height: 1.5; }
    .count { flex: none; display: grid; min-width: 80px; padding: 10px 14px; border: 1px solid var(--gs-stroke); border-radius: 14px; background: var(--gs-1); text-align: center; box-shadow: inset 0 1px 0 color-mix(in srgb, var(--text) 7%, transparent); }
    .count strong { color: var(--gs-gold); font-size: 22px; line-height: 1; }
    .count span { margin-top: 4px; color: var(--muted); font-size: 9px; letter-spacing: .12em; text-transform: uppercase; }
    .notice {
      padding: 18px; border: 1px solid var(--gs-stroke);
      border-radius: 16px; background: var(--gs-2); color: var(--muted); line-height: 1.55;
      box-shadow: var(--gs-shadow); backdrop-filter: blur(20px) saturate(140%);
    }
    .err { color: var(--danger); margin: 8px 0 14px; font-size: 13px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px; }
    .card {
      position: relative; overflow: hidden; border: 1px solid var(--gs-stroke); border-radius: 17px;
      padding: 17px 18px; background: linear-gradient(150deg, color-mix(in srgb, var(--gs-gold) 6%, var(--gs-3)), var(--gs-1));
      box-shadow: var(--gs-shadow); backdrop-filter: blur(22px) saturate(145%);
      display: flex; flex-direction: column; gap: 10px;
      transition: transform var(--duration-normal) var(--ease-out), border-color var(--duration-normal) ease, box-shadow var(--duration-normal) ease;
    }
    .card::before { content: ""; position: absolute; inset: 0; pointer-events: none; background: linear-gradient(180deg, color-mix(in srgb, var(--text) 5%, transparent), transparent 24%); }
    .card > * { position: relative; }
    .card:hover { transform: translateY(-3px); border-color: var(--gs-stroke-strong); box-shadow: 0 26px 68px color-mix(in srgb, var(--bg) 58%, transparent), 0 0 30px var(--gs-glow), inset 0 1px 0 color-mix(in srgb, var(--text) 12%, transparent); }
    .row { display: flex; align-items: center; gap: 12px; justify-content: space-between; }
    .title { min-width: 0; font-weight: 650; font-size: 14px; display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
    .size { color: var(--muted); font-weight: 400; font-size: 11px; }
    .desc { color: var(--muted); font-size: 12.5px; line-height: 1.5; }
    .badge { font-size: 10px; font-weight: 650; padding: 3px 8px; border: 1px solid currentColor; border-radius: var(--radius-full); }
    .badge.on { background: color-mix(in srgb, var(--ok) 10%, transparent); color: var(--ok); }
    .badge.req { background: color-mix(in srgb, var(--gs-gold) 10%, transparent); color: var(--gs-gold); }
    button {
      min-height: 36px; border: 1px solid var(--gs-stroke); background: var(--gs-2);
      color: inherit; padding: 7px 14px; border-radius: 10px; cursor: pointer;
      font-size: 12px; font-weight: 650; white-space: nowrap;
      box-shadow: inset 0 1px 0 color-mix(in srgb, var(--text) 7%, transparent);
      transition: transform var(--duration-fast) ease, border-color var(--duration-fast) ease, box-shadow var(--duration-fast) ease;
    }
    button:hover:not(:disabled) { transform: translateY(-1px); border-color: var(--gs-stroke-strong); box-shadow: 0 10px 24px var(--gs-glow); }
    button:focus-visible { outline: 2px solid var(--gs-gold); outline-offset: 3px; }
    button.primary { background: linear-gradient(145deg, color-mix(in srgb, var(--gs-gold) 82%, var(--text)), var(--gs-gold)); border-color: var(--gs-stroke-strong); color: var(--bg); }
    button:disabled { opacity: 0.5; cursor: default; }
    .bar { height: 5px; border-radius: var(--radius-full); background: var(--gs-3); overflow: hidden; }
    .bar > i { display: block; height: 100%; background: var(--gs-gold); box-shadow: 0 0 12px var(--gs-glow); transition: width .15s; }
    .skeleton { min-height: 148px; }
    .skeleton span { display: block; height: 12px; margin-bottom: 14px; border-radius: var(--radius-full); background: linear-gradient(90deg, var(--gs-1), var(--gs-glow), var(--gs-1)); background-size: 220% 100%; animation: shimmer 1.6s ease-in-out infinite; }
    .skeleton span:first-child { width: 46%; height: 20px; }
    .skeleton span:nth-child(3) { width: 74%; }
    @keyframes shimmer { from { background-position: 110% 0; } to { background-position: -110% 0; } }
    @media (max-width: 600px) { .head { align-items: stretch; flex-direction: column; padding: 19px 17px; } .count { align-self: flex-start; } .grid { grid-template-columns: 1fr; } .row { align-items: flex-start; } }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 1ms !important; transition-duration: 1ms !important; } }
    @media (prefers-reduced-transparency: reduce) { .head, .notice, .card { backdrop-filter: none; background: var(--panel); } }
  `;

  render() {
    if (!this.supported) {
      return html`
        <div class="head"><div><div class="kicker">Settings · Runtime</div><h2>Components</h2></div></div>
        <div class="notice">
          Optional component packs are managed from the <strong>InfiniBot desktop app</strong>.
          Open InfiniBot in the desktop window to install or remove packs — they download binaries to disk,
          which a browser tab can't do.
        </div>`;
    }
    return html`
      <div class="head">
        <div>
          <div class="kicker">Settings · Runtime</div>
          <h2>Components</h2>
          <p>Optional packs are downloaded on demand and kept out of the base installer. Remove anytime — re-install stays one click away.</p>
        </div>
        <div class="count"><strong>${this.packs.filter((pack) => pack.installed).length}</strong><span>installed</span></div>
      </div>
      ${this.error ? html`<div class="err">${this.error}</div>` : nothing}
      <div class="grid">
        ${this.loading
          ? [0, 1, 2].map(() => html`<div class="card skeleton" role="status" aria-label="Loading component"><span></span><span></span><span></span></div>`)
          : this.packs.map((p) => {
          const busy = this.busy[p.name];
          const pct = Math.round((this.progress[p.name] ?? 0) * 100);
          const feature = packFeature(p.name);
          const locked = !!feature && !p.installed && !hasFeature(this.license, feature);
          return html`
            <div class="card">
              <div class="row">
                <span class="title">
                  ${p.title}
                  ${p.installed ? html`<span class="badge on">Installed</span>` : nothing}
                  ${!p.installed && p.requestedAtSetup ? html`<span class="badge req">Requested</span>` : nothing}
                  ${locked ? html`<upgrade-chip feature=${feature!}></upgrade-chip>` : nothing}
                  <span class="size">${fmtSize(p.size)}</span>
                </span>
                ${p.installed
                  ? html`<button @click=${() => this.removePack(p.name)} ?disabled=${!!busy}>${busy || "Remove"}</button>`
                  : html`<button
                      class="primary"
                      @click=${() => this.install(p.name)}
                      ?disabled=${!!busy && !locked}
                      title=${locked ? "Requires a higher plan" : ""}
                    >${busy || "Install"}</button>`}
              </div>
              <div class="desc">${p.description}</div>
              ${busy === "Installing" ? html`<div class="bar"><i style="width:${pct}%"></i></div>` : nothing}
            </div>`;
          })}
      </div>`;
  }
}
