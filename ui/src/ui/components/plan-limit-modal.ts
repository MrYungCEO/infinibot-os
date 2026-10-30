/**
 * <plan-limit-modal> — "plan limit hit → upgrade" dialog for hosted tenants.
 *
 * (Separate from components/upgrade-modal.ts, which is the KinglyVault license
 * upsell used by the upgrade chip / license guard.)
 *
 * Mounted once in the app shell (app-render.ts). It is idle until a plan-limit
 * payload arrives, from either:
 *   - the gateway's `plan.limit` WS event (src/agents/agent-concurrency-gate.ts),
 *     which app-gateway.ts re-dispatches as the window event below; or
 *   - any other surface that dispatches `infinibot:plan-limit` with the same
 *     payload shape (reusable for future plan caps).
 *
 * Primary CTA: when signed in to the cloud app it mints a Whop checkout via
 * POST /api/whop-checkout {plan} and redirects there; otherwise (or if that
 * call fails) it opens /pricing preselected on the next tier.
 *
 * Visual language matches the SaaS onboarding console (.sob-*): near-black
 * ground, gold hairlines + glow, mono eyebrow, no emoji.
 */
import { LitElement, css, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { PLAN_LIMIT_TIERS, type TierInfo } from "./plan-limit-tiers.js";

export const PLAN_LIMIT_WINDOW_EVENT = "infinibot:plan-limit";

export type PlanLimitPayload = {
  code?: string;
  /** Which cap was hit: "agents" (total) or "coders" (CLI coders); other kinds get generic copy. */
  kind?: string;
  limit: number;
  plan: string;
  used: number;
  nextPlan?: string | null;
  upgradeUrl?: string;
  message?: string;
};

const TIERS: Record<string, TierInfo> = PLAN_LIMIT_TIERS;

function tierName(id: string | null | undefined): string {
  if (!id) return "";
  return TIERS[id]?.name ?? id.charAt(0).toUpperCase() + id.slice(1);
}

function isPayload(v: unknown): v is PlanLimitPayload {
  const p = v as PlanLimitPayload | null;
  return !!p && typeof p.limit === "number" && typeof p.used === "number" && typeof p.plan === "string";
}

/** Fire the modal from anywhere in the UI. */
export function showPlanLimit(payload: PlanLimitPayload): void {
  window.dispatchEvent(new CustomEvent(PLAN_LIMIT_WINDOW_EVENT, { detail: payload }));
}

@customElement("plan-limit-modal")
export class PlanLimitModal extends LitElement {
  @state() private payload: PlanLimitPayload | null = null;
  @state() private busy = false;
  private lastFocus: Element | null = null;

  private readonly onLimit = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (isPayload(detail)) this.open(detail);
  };

  private readonly onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && this.payload) this.close();
  };

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener(PLAN_LIMIT_WINDOW_EVENT, this.onLimit);
    window.addEventListener("keydown", this.onKey);
  }

  disconnectedCallback(): void {
    window.removeEventListener(PLAN_LIMIT_WINDOW_EVENT, this.onLimit);
    window.removeEventListener("keydown", this.onKey);
    super.disconnectedCallback();
  }

  open(payload: PlanLimitPayload): void {
    if (!this.payload) this.lastFocus = document.activeElement;
    this.payload = payload;
    this.busy = false;
    void this.updateComplete.then(() => {
      (this.renderRoot.querySelector(".um-cta") as HTMLElement | null)?.focus();
    });
  }

  close(): void {
    this.payload = null;
    (this.lastFocus as HTMLElement | null)?.focus?.();
    this.lastFocus = null;
  }

  private pricingUrl(p: PlanLimitPayload): string {
    const base = p.upgradeUrl || "/pricing";
    if (!p.nextPlan) return base;
    return `${base}${base.includes("?") ? "&" : "?"}plan=${encodeURIComponent(p.nextPlan)}&reason=${encodeURIComponent(p.kind ?? "limit")}`;
  }

  /** Signed in → Whop checkout for the next tier; otherwise /pricing. */
  private async upgrade(): Promise<void> {
    const p = this.payload;
    if (!p || this.busy) return;
    this.busy = true;
    const fallback = this.pricingUrl(p);
    try {
      if (p.nextPlan) {
        const { getClerkToken } = await import("../saas-clerk");
        const token = await getClerkToken().catch(() => null);
        if (token) {
          const { cloudApiBase } = await import("../cloud/cloud-env");
          const res = await fetch(`${cloudApiBase()}/whop-checkout`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ plan: p.nextPlan }),
            credentials: "omit",
          });
          const body = (await res.json().catch(() => null)) as { checkoutUrl?: unknown } | null;
          if (res.ok && typeof body?.checkoutUrl === "string" && body.checkoutUrl.startsWith("https://")) {
            window.location.assign(body.checkoutUrl);
            return;
          }
        }
      }
    } catch {
      // fall through to the pricing page
    }
    window.location.assign(fallback);
  }

  private renderMeter(p: PlanLimitPayload, next: TierInfo | undefined, nextCap: number | undefined) {
    const total = Math.max(p.limit, nextCap ?? p.limit);
    const cells = Array.from({ length: Math.min(total, 12) }, (_, i) => {
      const cls = i < Math.min(p.used, p.limit) ? "is-used" : i < p.limit ? "is-free" : "is-next";
      return html`<span class="um-cell ${cls}"></span>`;
    });
    return html`<div class="um-meter" aria-hidden="true">${cells}</div>
      <div class="um-meter__legend">
        <span><i class="um-dot is-used"></i>${tierName(p.plan)} &middot; ${p.limit}</span>
        ${next ? html`<span><i class="um-dot is-next"></i>${next.name} &middot; ${nextCap}</span>` : nothing}
      </div>`;
  }

  render() {
    const p = this.payload;
    if (!p) return nothing;
    const kind = p.kind ?? "agents";
    const coders = kind === "coders";
    const slots = kind === "agents" || coders;
    const current = tierName(p.plan);
    const next = p.nextPlan ? TIERS[p.nextPlan] : undefined;
    const nextName = tierName(p.nextPlan);
    const nextCap = next ? (coders ? next.coders : next.agents) : undefined;
    const noun = coders ? (p.limit === 1 ? "coder" : "coders") : p.limit === 1 ? "agent" : "agents";
    const slot = coders ? "coder" : "agent";
    const title = slots
      ? html`You're running <span class="um-num">${p.used}/${p.limit}</span> ${noun} on ${current}`
      : html`You've reached the ${current} plan limit`;
    const sub = slots
      ? next
        ? `Every ${slot} slot on your plan is busy. ${nextName} runs up to ${nextCap} ${coders ? "coders" : "agents"} in parallel — or wait for one to finish.`
        : `Every ${slot} slot on your plan is busy. Wait for one to finish, or talk to us about more capacity.`
      : (p.message ?? "Upgrade to raise this limit.");

    return html`<div class="um-backdrop" @click=${(e: Event) => e.target === e.currentTarget && this.close()}>
      <section class="um-card" role="dialog" aria-modal="true" aria-labelledby="um-title" aria-describedby="um-sub">
        <div class="um-glow" aria-hidden="true"></div>
        <header class="um-eyebrow">
          <span class="um-eyebrow__code">PLAN LIMIT</span>
          <span class="um-eyebrow__rule"></span>
          <span class="um-eyebrow__code um-eyebrow__code--dim">${coders ? "PARALLEL CODERS" : slots ? "PARALLEL AGENTS" : kind.toUpperCase()}</span>
        </header>
        <h2 class="um-title" id="um-title">${title}</h2>
        <p class="um-sub" id="um-sub">${sub}</p>
        ${slots ? this.renderMeter(p, next, nextCap) : nothing}
        ${next
          ? html`<div class="um-next">
              <div class="um-next__head">
                <span class="um-next__name">${next.name}</span>
                <span class="um-next__price">$${next.price}<small>/mo</small></span>
              </div>
              <ul class="um-next__list">
                <li><span class="um-tick"></span>${next.agents} parallel agents &middot; ${next.coders} coding at once</li>
                <li><span class="um-tick"></span>${next.ram} Machine &middot; ${next.builds} concurrent build${next.builds === 1 ? "" : "s"}</li>
                <li><span class="um-tick"></span>${next.extra}</li>
              </ul>
            </div>`
          : nothing}
        <div class="um-actions">
          <button class="um-btn um-btn--ghost" type="button" @click=${() => this.close()}>Not now</button>
          <button class="um-btn um-cta" type="button" ?disabled=${this.busy} @click=${() => this.upgrade()}>
            ${this.busy ? "Opening checkout…" : next ? `Upgrade to ${nextName}` : "See plans"}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
          </button>
        </div>
      </section>
    </div>`;
  }

  static styles = css`
    :host {
      --um-gold: var(--g-primary, #fbbf24);
      --um-warm: color-mix(in srgb, var(--um-gold) 80%, #ff8a00 20%);
      --um-ink: #050505;
      --um-fg: #f5f2ea;
      --um-fg-2: rgba(245, 242, 234, 0.72);
      --um-fg-3: rgba(245, 242, 234, 0.46);
      --um-line: color-mix(in srgb, var(--um-gold) 16%, rgba(255, 255, 255, 0.07));
      --um-line-2: color-mix(in srgb, var(--um-gold) 38%, transparent);
      --um-sans: "Space Grotesk", "Inter", ui-sans-serif, system-ui, sans-serif;
      --um-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      --um-ease: cubic-bezier(0.16, 1, 0.3, 1);
    }
    *, *::before, *::after { box-sizing: border-box; }
    .um-backdrop {
      position: fixed;
      inset: 0;
      z-index: 10000;
      display: grid;
      place-items: center;
      padding: 20px;
      background: radial-gradient(80% 70% at 50% 40%, rgba(20, 16, 8, 0.72), rgba(0, 0, 0, 0.86));
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      animation: um-fade 220ms ease-out both;
      color-scheme: dark;
    }
    /* The laptop band zooms <body> to 0.7; render the dialog 1:1. */
    @media (min-width: 1101px) and (max-width: 1680px) {
      .um-backdrop { zoom: calc(1 / var(--ui-viewport-zoom, 0.7)); }
    }
    .um-card {
      position: relative;
      width: min(520px, calc(100vw - 32px));
      max-height: calc(100dvh - 40px);
      overflow: auto;
      padding: 28px 28px 22px;
      border-radius: 18px;
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.035), rgba(255, 255, 255, 0) 40%),
        var(--um-ink);
      border: 1px solid var(--um-line-2);
      box-shadow:
        0 0 0 1px rgba(0, 0, 0, 0.6),
        0 30px 80px -20px rgba(0, 0, 0, 0.9),
        0 0 42px -8px color-mix(in srgb, var(--um-gold) 32%, transparent);
      color: var(--um-fg);
      font-family: var(--um-sans);
      font-size: 15px;
      line-height: 1.55;
      animation: um-rise 360ms var(--um-ease) both;
    }
    .um-card::before {
      /* scanlines */
      content: "";
      position: absolute;
      inset: 0;
      border-radius: inherit;
      pointer-events: none;
      background: repeating-linear-gradient(0deg, rgba(255, 255, 255, 0.018) 0 1px, transparent 1px 3px);
    }
    .um-glow {
      position: absolute;
      left: 50%;
      top: -120px;
      width: 420px;
      height: 220px;
      margin-left: -210px;
      pointer-events: none;
      background: radial-gradient(closest-side, color-mix(in srgb, var(--um-gold) 22%, transparent), transparent 72%);
    }
    .um-eyebrow {
      position: relative;
      display: flex;
      align-items: center;
      gap: 10px;
      font-family: var(--um-mono);
      font-size: 11px;
      letter-spacing: 0.14em;
    }
    .um-eyebrow__code { color: var(--um-gold); text-shadow: 0 0 8px color-mix(in srgb, var(--um-gold) 50%, transparent); }
    .um-eyebrow__code--dim { color: var(--um-fg-3); text-shadow: none; }
    .um-eyebrow__rule { flex: 1; height: 1px; background: linear-gradient(90deg, var(--um-line-2), transparent); }
    .um-title {
      position: relative;
      margin: 16px 0 8px;
      font-size: clamp(22px, 4.6vw, 27px);
      line-height: 1.2;
      font-weight: 600;
      letter-spacing: -0.01em;
    }
    .um-num {
      font-family: var(--um-mono);
      color: var(--um-gold);
      text-shadow: 0 0 4px color-mix(in srgb, var(--um-gold) 60%, transparent), 0 0 14px color-mix(in srgb, var(--um-warm) 40%, transparent);
    }
    .um-sub { position: relative; margin: 0 0 18px; color: var(--um-fg-2); }
    .um-meter { position: relative; display: flex; gap: 5px; }
    .um-cell {
      flex: 1;
      height: 8px;
      border-radius: 2px;
      border: 1px solid var(--um-line);
      background: rgba(255, 255, 255, 0.03);
    }
    .um-cell.is-used {
      border-color: transparent;
      background: linear-gradient(90deg, var(--um-gold), var(--um-warm));
      box-shadow: 0 0 10px color-mix(in srgb, var(--um-gold) 45%, transparent);
    }
    .um-cell.is-next { border-style: dashed; border-color: var(--um-line-2); background: transparent; }
    .um-meter__legend {
      display: flex;
      gap: 16px;
      margin: 8px 0 18px;
      font-family: var(--um-mono);
      font-size: 11px;
      color: var(--um-fg-3);
    }
    .um-meter__legend span { display: inline-flex; align-items: center; gap: 6px; }
    .um-dot { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }
    .um-dot.is-used { background: var(--um-gold); }
    .um-dot.is-next { border: 1px dashed var(--um-line-2); }
    .um-next {
      position: relative;
      padding: 14px 16px;
      border-radius: 12px;
      border: 1px solid var(--um-line);
      background: linear-gradient(180deg, color-mix(in srgb, var(--um-gold) 6%, transparent), transparent);
    }
    .um-next__head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 8px; }
    .um-next__name { font-weight: 600; letter-spacing: 0.01em; }
    .um-next__price { font-family: var(--um-mono); color: var(--um-gold); font-size: 18px; }
    .um-next__price small { color: var(--um-fg-3); font-size: 12px; }
    .um-next__list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; color: var(--um-fg-2); font-size: 14px; }
    .um-next__list li { display: flex; align-items: center; gap: 10px; }
    .um-tick {
      width: 14px;
      height: 14px;
      flex: none;
      border-radius: 50%;
      border: 1px solid var(--um-line-2);
      background: radial-gradient(circle, var(--um-gold) 0 3px, transparent 3.5px);
    }
    .um-actions { position: relative; display: flex; justify-content: flex-end; gap: 10px; margin-top: 22px; flex-wrap: wrap; }
    .um-btn {
      min-height: 44px;
      padding: 0 18px;
      border-radius: 10px;
      font: 600 14px/1 var(--um-sans);
      letter-spacing: 0.01em;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      transition: transform 160ms var(--um-ease), box-shadow 160ms var(--um-ease), background 160ms;
    }
    .um-btn svg { width: 16px; height: 16px; }
    .um-btn--ghost { background: transparent; color: var(--um-fg-2); border: 1px solid var(--um-line); }
    .um-btn--ghost:hover { color: var(--um-fg); border-color: var(--um-line-2); }
    .um-cta {
      border: 1px solid color-mix(in srgb, var(--um-gold) 70%, #fff 0%);
      color: #140f02;
      background: linear-gradient(180deg, color-mix(in srgb, var(--um-gold) 92%, #fff 8%), var(--um-warm));
      box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.4), 0 0 18px -2px color-mix(in srgb, var(--um-gold) 60%, transparent);
    }
    .um-cta:hover:not([disabled]) { transform: translateY(-1px); box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.4), 0 0 26px 0 color-mix(in srgb, var(--um-gold) 70%, transparent); }
    .um-cta[disabled] { opacity: 0.7; cursor: progress; }
    .um-btn:focus-visible { outline: 2px solid var(--um-gold); outline-offset: 2px; }
    @media (max-width: 480px) {
      .um-card { padding: 22px 18px 18px; }
      .um-actions { flex-direction: column-reverse; }
      .um-btn { width: 100%; justify-content: center; }
    }
    @keyframes um-fade { from { opacity: 0; } to { opacity: 1; } }
    @keyframes um-rise { from { opacity: 0; transform: translateY(14px) scale(0.98); } to { opacity: 1; transform: none; } }
    @media (prefers-reduced-motion: reduce) {
      .um-backdrop, .um-card { animation: none; }
      .um-btn { transition: none; }
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "plan-limit-modal": PlanLimitModal;
  }
}
