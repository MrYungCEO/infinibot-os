/**
 * "Full setup" steps of the SaaS quickstart: messaging channels, integrations
 * and MCP connectors, and business context. Rendered inside the console shell
 * in saas-onboarding.ts, same `.sob-*` visual language.
 *
 * Every connector shows exactly what it can do from here (see
 * src/saas/onboarding-connect-catalog.ts): paste-and-verify a token, link a
 * device (WhatsApp), enable, or "Connect later" with the stated reason. Nothing
 * is shown as connected unless the gateway says it is.
 *
 * No emoji: tiles carry two-letter text marks.
 */
import "../components/telegram-setup";
import { html, nothing, type TemplateResult } from "lit";
import { channelLockReason, channelUpgradeCta, isChannelExcluded } from "../cloud/plan-channels";
import { openUpgrade } from "../cloud/upgrade";
import type { GatewayBrowserClient } from "../gateway";
import { icon } from "../icons";

export type ConnectorView = {
  id: string;
  label: string;
  group: "channel" | "integration" | "mcp";
  mode: "token" | "link" | "toggle" | "later";
  blurb: string;
  signupUrl: string | null;
  laterReason: string | null;
  checkNote: string | null;
  reusesKeyOf: string | null;
  fields: Array<{ id: string; label: string; hint: string }>;
  state: "idle" | "saved" | "linked" | "enabled";
  account: string | null;
  maskedKey: string | null;
  /** The plan leaves this connector out (hosted Free: Telegram, Slack). Comes with mode "later". */
  lockedByPlan?: boolean;
};

/**
 * The plan leaves this connector out: the gateway says so (`lockedByPlan`), or
 * /api/me listed the channel in `channelsExcluded`. Never true off the hosted app.
 */
export function isPlanLocked(c: Pick<ConnectorView, "id" | "group" | "lockedByPlan">): boolean {
  return c.lockedByPlan === true || (c.group === "channel" && isChannelExcluded(c.id));
}

export type TenantBusiness = {
  name: string;
  industry?: string;
  description?: string;
  tagline?: string;
  website?: string;
  brandColor?: string;
  tone?: string;
  audience?: string;
  businessId?: string;
  seededProjectId?: string;
};

export type SetupStatus = {
  connectors?: ConnectorView[];
  business?: TenantBusiness | null;
  businessIndustries?: string[];
  businessTones?: string[];
  /** False when the backend can't create the starter HQ project (the serverless cloud surface). */
  businessSeedAvailable?: boolean;
};

type Busy = { busy: boolean; error: string | null; ok: string | null };

type WaPhase = "idle" | "starting" | "waiting" | "expired" | "error";

export type SetupState = {
  connectors: ConnectorView[];
  selected: { channel: string | null; connect: string | null };
  /** Integrations step tab. */
  tab: "integration" | "mcp";
  drafts: Record<string, string>;
  save: Busy;
  wa: { mode: "qr" | "pairing"; phone: string; phase: WaPhase; qr: string | null; code: string | null; note: string | null; run: number };
  biz: {
    name: string;
    industry: string;
    description: string;
    tagline: string;
    website: string;
    brandColor: string;
    tone: string;
    audience: string;
    seed: boolean;
  };
  bizSaved: string | null;
  bizSeeded: boolean;
  /** Whether the backend can create the starter HQ project at all. */
  seedAvailable: boolean;
  bizSave: Busy;
};

export type SetupCtx = {
  client: GatewayBrowserClient;
  status: SetupStatus;
  requestUpdate: () => void;
  header: (title: TemplateResult | string, sub: TemplateResult | string) => TemplateResult;
  lockIcon: (open: boolean) => TemplateResult;
  st: SetupState;
};

export const BRAND_SWATCHES = ["#e0a030", "#f97316", "#10b981", "#38bdf8", "#8b5cf6", "#f43f5e", "#d4d4d8"] as const;

/** Steps can only be offered when the gateway serves their data. */
export function hasConnectorSteps(status: SetupStatus): boolean {
  return Array.isArray(status.connectors) && status.connectors.length > 0;
}
export function hasBusinessStep(status: SetupStatus): boolean {
  return Array.isArray(status.businessIndustries);
}

export function initSetup(status: SetupStatus): SetupState {
  const connectors = status.connectors ?? [];
  const firstOf = (groups: string[]) =>
    connectors.find((c) => groups.includes(c.group) && c.mode !== "later" && !isPlanLocked(c))?.id ?? null;
  const b = status.business;
  const biz = {
    name: b?.name ?? "",
    industry: b?.industry ?? "",
    description: b?.description ?? "",
    tagline: b?.tagline ?? "",
    website: b?.website ?? "",
    brandColor: b?.brandColor ?? BRAND_SWATCHES[0],
    tone: b?.tone ?? "",
    audience: b?.audience ?? "",
    seed: status.businessSeedAvailable !== false && !b?.seededProjectId,
  };
  return {
    connectors,
    selected: { channel: firstOf(["channel"]), connect: firstOf(["integration"]) },
    tab: "integration",
    drafts: {},
    save: { busy: false, error: null, ok: null },
    wa: { mode: "qr", phone: "", phase: "idle", qr: null, code: null, note: null, run: 0 },
    biz,
    bizSaved: b ? bizFingerprint(biz) : null,
    bizSeeded: Boolean(b?.seededProjectId),
    seedAvailable: status.businessSeedAvailable !== false,
    bizSave: { busy: false, error: null, ok: null },
  };
}

// ── Marks ──────────────────────────────────────────────────────────────────

const CONNECTOR_MARKS: Record<string, string> = {
  telegram: "Tg",
  discord: "Dc",
  slack: "Sl",
  whatsapp: "Wa",
  notion: "No",
  loops: "Lp",
  github: "Gh",
  brave: "Br",
  hunter: "Hu",
  gmail: "Gm",
  "google-calendar": "Ca",
  "notion-mcp": "No",
  supabase: "Sb",
  excalidraw: "Ex",
  canva: "Cv",
  flypic: "Fp",
};

export function connectorMark(c: { id: string; label: string }): string {
  const known = CONNECTOR_MARKS[c.id];
  if (known) return known;
  const letters = [...c.label].filter((ch) => /[\p{L}\p{N}]/u.test(ch));
  return letters.length ? `${letters[0].toUpperCase()}${(letters[1] ?? "").toLowerCase()}` : "--";
}

/** Business monogram: one or two initials, letters and digits only. */
function initials(name: string): string {
  const parts = name
    .trim()
    .split(/\s+/)
    .map((w) => [...w].find((ch) => /[\p{L}\p{N}]/u.test(ch)))
    .filter((ch): ch is string => Boolean(ch));
  return parts.slice(0, 2).join("").toUpperCase();
}

const isOn = (c: ConnectorView) => c.state !== "idle";

/** "a bot token", "an integration secret". */
const withArticle = (noun: string) => `${/^[aeiou]/i.test(noun) ? "an" : "a"} ${noun}`;

function statusLine(c: ConnectorView): string {
  if (isPlanLocked(c)) return isOn(c) ? "Paused" : "Upgrade";
  switch (c.state) {
    case "saved":
      return "Verified";
    case "linked":
      return "Linked";
    case "enabled":
      return "Enabled";
    default:
      if (c.mode === "later") return "Connect later";
      if (c.mode === "link") return "QR or code";
      if (c.mode === "toggle") return c.reusesKeyOf ? "Uses Notion token" : "No account needed";
      return c.group === "mcp" ? "MCP token" : "Token";
  }
}

// ── Connector actions ──────────────────────────────────────────────────────

function replaceConnector(st: SetupState, next: ConnectorView): void {
  st.connectors = st.connectors.map((c) => (c.id === next.id ? next : c));
}

function select(ctx: SetupCtx, slot: "channel" | "connect", id: string): void {
  const { st } = ctx;
  if (st.selected[slot] === id) return;
  st.selected[slot] = id;
  st.save = { busy: false, error: null, ok: null };
  stopWhatsApp(st);
  ctx.requestUpdate();
}

async function saveConnector(ctx: SetupCtx, c: ConnectorView): Promise<void> {
  const { st } = ctx;
  if (st.save.busy) return;
  const values: Record<string, string> = {};
  for (const f of c.fields) values[f.id] = (st.drafts[`${c.id}.${f.id}`] ?? "").trim();
  st.save = { busy: true, error: null, ok: null };
  ctx.requestUpdate();
  try {
    const res = await ctx.client.request<
      { ok: true; connector: ConnectorView } | { ok: false; error: string }
    >("saas.onboarding.connector.save", { id: c.id, ...values });
    if (res?.ok) {
      replaceConnector(st, res.connector);
      for (const f of c.fields) delete st.drafts[`${c.id}.${f.id}`];
      st.save = { busy: false, error: null, ok: c.mode === "toggle" ? "enabled" : "verified" };
    } else {
      st.save = { busy: false, error: (res as { error?: string })?.error ?? `${c.label} rejected this token.`, ok: null };
    }
  } catch (err) {
    st.save = { busy: false, error: String((err as Error)?.message ?? err), ok: null };
  }
  ctx.requestUpdate();
}

/** Re-read one connector after something else (the Telegram wizard) changed it. */
async function refreshConnector(ctx: SetupCtx, c: ConnectorView): Promise<void> {
  try {
    const res = await ctx.client.request<{ connectors?: ConnectorView[] }>(
      "saas.onboarding.status",
      {},
    );
    const next = res?.connectors?.find((x) => x.id === c.id);
    if (next) replaceConnector(ctx.st, next);
  } catch {
    /* the wizard shows its own state; the tile catches up on the next load */
  }
  ctx.requestUpdate();
}

async function removeConnector(ctx: SetupCtx, c: ConnectorView): Promise<void> {
  const { st } = ctx;
  try {
    const res = await ctx.client.request<{ ok: boolean; connector?: ConnectorView }>(
      "saas.onboarding.connector.remove",
      { id: c.id },
    );
    replaceConnector(st, res?.connector ?? { ...c, state: "idle", account: null, maskedKey: null });
    st.save = { busy: false, error: null, ok: null };
    st.wa = { ...st.wa, phase: "idle", qr: null, code: null, note: null };
  } catch (err) {
    st.save = { busy: false, error: String((err as Error)?.message ?? err), ok: null };
  }
  ctx.requestUpdate();
}

function stopWhatsApp(st: SetupState): void {
  st.wa.run += 1;
  if (st.wa.phase === "waiting" || st.wa.phase === "starting") {
    st.wa = { ...st.wa, phase: "idle", qr: null, code: null, note: null };
  }
}

/** Leave the step: stop any WhatsApp polling. */
export function leaveSetupStep(st: SetupState): void {
  stopWhatsApp(st);
}

async function startWhatsApp(ctx: SetupCtx): Promise<void> {
  const { st } = ctx;
  const run = ++st.wa.run;
  st.wa = { ...st.wa, phase: "starting", qr: null, code: null, note: null, run };
  st.save = { busy: false, error: null, ok: null };
  ctx.requestUpdate();
  try {
    const res = await ctx.client.request<{
      ok: boolean;
      linked?: boolean;
      qrDataUrl?: string;
      pairingCode?: string;
      connector?: ConnectorView;
      error?: string;
    }>("saas.onboarding.whatsapp.start", {
      mode: st.wa.mode,
      phoneNumber: st.wa.mode === "pairing" ? st.wa.phone : undefined,
    });
    if (run !== st.wa.run) return;
    if (!res?.ok) {
      st.wa = { ...st.wa, phase: "error", note: res?.error ?? "WhatsApp didn't issue a code." };
    } else if (res.linked && res.connector) {
      replaceConnector(st, res.connector);
      st.wa = { ...st.wa, phase: "idle" };
    } else {
      st.wa = { ...st.wa, phase: "waiting", qr: res.qrDataUrl ?? null, code: res.pairingCode ?? null };
      ctx.requestUpdate();
      void pollWhatsApp(ctx, run);
      return;
    }
  } catch (err) {
    if (run !== st.wa.run) return;
    st.wa = { ...st.wa, phase: "error", note: String((err as Error)?.message ?? err) };
  }
  ctx.requestUpdate();
}

async function pollWhatsApp(ctx: SetupCtx, run: number): Promise<void> {
  const { st } = ctx;
  const deadline = Date.now() + 180_000;
  while (run === st.wa.run && Date.now() < deadline) {
    try {
      const res = await ctx.client.request<{
        connected: boolean;
        expired: boolean;
        message?: string;
        connector?: ConnectorView;
      }>("saas.onboarding.whatsapp.wait", {});
      if (run !== st.wa.run) return;
      if (res?.connected && res.connector) {
        replaceConnector(st, res.connector);
        st.wa = { ...st.wa, phase: "idle", qr: null, code: null };
        ctx.requestUpdate();
        return;
      }
      if (res?.expired) {
        st.wa = { ...st.wa, phase: "expired", qr: null, code: null, note: res.message ?? null };
        ctx.requestUpdate();
        return;
      }
    } catch (err) {
      if (run !== st.wa.run) return;
      st.wa = { ...st.wa, phase: "error", note: String((err as Error)?.message ?? err) };
      ctx.requestUpdate();
      return;
    }
  }
  if (run === st.wa.run) {
    st.wa = { ...st.wa, phase: "expired", qr: null, code: null, note: null };
    ctx.requestUpdate();
  }
}

// ── Pieces ─────────────────────────────────────────────────────────────────

function tile(ctx: SetupCtx, slot: "channel" | "connect", c: ConnectorView, index: number): TemplateResult {
  const selected = ctx.st.selected[slot] === c.id;
  const locked = isPlanLocked(c);
  return html`<button
    type="button"
    role="radio"
    aria-checked=${selected}
    aria-label=${`${c.label}, ${statusLine(c)}`}
    title=${c.blurb || c.label}
    data-testid=${`so-conn-${c.id}`}
    class="sob-prov sob-ctile ${selected ? "is-selected" : ""} ${isOn(c) && !locked ? "is-linked" : ""} ${c.mode === "later" || locked ? "is-later" : ""} ${locked ? "is-plan-locked" : ""}"
    data-plan-locked=${locked ? "true" : nothing}
    @click=${() => select(ctx, slot, c.id)}
  >
    <span class="sob-prov__mark" aria-hidden="true"
      ><span class="sob-prov__z">${String(index + 1).padStart(2, "0")}</span>${connectorMark(c)}</span
    >
    <span class="sob-prov__text">
      <span class="sob-prov__name">${c.label}</span>
      <span class="sob-prov__status">${statusLine(c)}</span>
    </span>
    ${locked
      ? html`<span class="sob-ctile__later sob-ctile__lock" aria-hidden="true">${icon("lock")}</span>`
      : c.mode === "later" && !isOn(c)
      ? html`<span class="sob-ctile__later" aria-hidden="true">${icon("clock")}</span>`
      : html`<span class="sob-led ${isOn(c) ? "is-on" : ""}"></span>`}
  </button>`;
}

function field(ctx: SetupCtx, c: ConnectorView, f: ConnectorView["fields"][number], autofocus: boolean): TemplateResult {
  const key = `${c.id}.${f.id}`;
  return html`<label class="sob-field sob-cfield">
    <span class="sob-label">${f.label}</span>
    <div class="sob-input-wrap ${ctx.st.save.busy ? "is-scanning" : ""}">
      <span class="sob-input-wrap__icon">${icon("key")}</span>
      <input
        class="sob-input sob-input--mono"
        type="password"
        autocomplete="off"
        spellcheck="false"
        data-testid=${`so-conn-field-${f.id}`}
        placeholder=${f.hint}
        ?autofocus=${autofocus}
        .value=${ctx.st.drafts[key] ?? ""}
        @input=${(e: Event) => {
          ctx.st.drafts[key] = (e.target as HTMLInputElement).value;
          ctx.requestUpdate();
        }}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === "Enter") void saveConnector(ctx, c);
        }}
      />
      <span class="sob-input-wrap__scan"></span>
    </div>
  </label>`;
}

function connectedCallout(ctx: SetupCtx, c: ConnectorView, live: string): TemplateResult {
  const verb = c.state === "linked" ? "linked" : c.state === "enabled" ? "enabled" : "connected";
  const meta = [c.account, c.maskedKey].filter(Boolean) as string[];
  return html`<div class="sob-unlock" data-testid="so-conn-ok">
    <span class="sob-unlock__icon">${ctx.lockIcon(true)}</span>
    <span class="sob-unlock__text">
      <span class="sob-unlock__title"><strong>${c.label}</strong> is ${verb}</span>
      <span class="sob-unlock__meta">
        ${meta.map((m, i) => html`${i ? html`<span class="sob-dot"></span>` : nothing}<span>${m}</span>`)}
        ${meta.length ? html`<span class="sob-dot"></span>` : nothing}<span class="sob-unlock__live">${live}</span>
      </span>
    </span>
    <button type="button" class="sob-link" data-testid="so-conn-remove" @click=${() => void removeConnector(ctx, c)}>
      ${c.state === "enabled" ? "Turn off" : "Disconnect"}
    </button>
  </div>`;
}

/** What "connected" means today for this group (the runtime truth, not a promise). */
function liveNote(c: ConnectorView): string {
  if (c.group === "channel") return "Saved to your workspace";
  if (c.state === "enabled") return "On for your workspace";
  return "Saved to your workspace";
}

function whatsappBody(ctx: SetupCtx, c: ConnectorView): TemplateResult {
  const { wa } = ctx.st;
  const busy = wa.phase === "starting";
  const phoneOk = /^\+?[\d\s()-]{7,20}$/.test(wa.phone.trim());
  const setMode = (mode: "qr" | "pairing") => {
    if (wa.mode === mode) return;
    stopWhatsApp(ctx.st);
    ctx.st.wa = { ...ctx.st.wa, mode, phase: "idle", qr: null, code: null, note: null };
    ctx.requestUpdate();
  };
  const seg = (mode: "qr" | "pairing", label: string, glyph: string) => html`<button
    type="button"
    role="radio"
    aria-checked=${wa.mode === mode}
    data-testid=${`so-wa-mode-${mode}`}
    class="sob-seg__opt ${wa.mode === mode ? "is-selected" : ""}"
    @click=${() => setMode(mode)}
  >
    ${icon(glyph as Parameters<typeof icon>[0])}${label}
  </button>`;
  const waiting = wa.phase === "waiting";
  return html`
    <div class="sob-wa">
      <div class="sob-wa__controls">
        <div class="sob-seg" role="radiogroup" aria-label="Link method">
          ${seg("qr", "QR code", "grid")} ${seg("pairing", "Pairing code", "smartphone")}
        </div>
        ${wa.mode === "pairing"
          ? html`<label class="sob-field sob-cfield">
              <span class="sob-label">Phone number</span>
              <div class="sob-input-wrap">
                <span class="sob-input-wrap__icon">${icon("smartphone")}</span>
                <input
                  class="sob-input sob-input--mono"
                  type="tel"
                  inputmode="tel"
                  autocomplete="tel"
                  data-testid="so-wa-phone"
                  placeholder="+44 7700 900123"
                  .value=${wa.phone}
                  @input=${(e: Event) => {
                    ctx.st.wa.phone = (e.target as HTMLInputElement).value;
                    ctx.requestUpdate();
                  }}
                />
              </div>
            </label>`
          : nothing}
        <ol class="sob-wa__steps">
          <li>Open WhatsApp on your phone.</li>
          <li>Go to <strong>Linked devices</strong>, then <strong>Link a device</strong>.</li>
          <li>${wa.mode === "qr" ? "Point your phone at the code." : "Choose link with phone number and enter the code."}</li>
        </ol>
        <div class="sob-wa__action">
          <button
            type="button"
            class="sob-btn sob-btn--primary"
            data-testid="so-wa-start"
            aria-busy=${busy ? "true" : "false"}
            ?disabled=${busy || (wa.mode === "pairing" && !phoneOk)}
            @click=${() => void startWhatsApp(ctx)}
          >
            ${busy
              ? html`<span class="sob-spinner"></span>Requesting…`
              : waiting || wa.phase === "expired"
                ? html`${icon("refresh")}New ${wa.mode === "qr" ? "QR code" : "pairing code"}`
                : html`${ctx.lockIcon(false)}${wa.mode === "qr" ? "Show QR code" : "Get pairing code"}`}
          </button>
          ${c.state === "idle"
            ? html`<span class="sob-hint">The session is stored in your workspace only.</span>`
            : nothing}
        </div>
      </div>
      <div class="sob-wa__stage ${waiting ? "is-live" : ""}" aria-live="polite">
        ${waiting && wa.qr
          ? html`<div class="sob-wa__qr"><img src=${wa.qr} alt="WhatsApp link QR code" data-testid="so-wa-qr" /><span class="sob-wa__beam"></span></div>`
          : waiting && wa.code
            ? html`<div class="sob-wa__code" data-testid="so-wa-code">
                ${[...wa.code.replace(/[^0-9A-Z]/gi, "")].map(
                  (ch, i) => html`${i === 4 ? html`<span class="sob-wa__dash"></span>` : nothing}<span>${ch}</span>`,
                )}
              </div>`
            : html`<div class="sob-wa__idle">
                <span class="sob-wa__frame">${icon(wa.mode === "qr" ? "grid" : "smartphone")}</span>
                <span>${wa.phase === "expired" ? "That code expired. Request a new one." : busy ? "Contacting WhatsApp…" : wa.mode === "qr" ? "Your QR code appears here" : "Your pairing code appears here"}</span>
              </div>`}
        ${waiting
          ? html`<span class="sob-wa__status"><span class="sob-led is-on"></span>Waiting for phone</span>`
          : nothing}
      </div>
    </div>
    ${wa.phase === "error" && wa.note
      ? html`<div class="sob-alert" role="alert" data-testid="so-conn-error">${icon("alertCircle")}<span>${wa.note}</span></div>`
      : nothing}
  `;
}

function detail(ctx: SetupCtx, c: ConnectorView | null): TemplateResult {
  if (!c) return html``;
  const { st } = ctx;
  const head = html`<div class="sob-cdetail__head">
    <span class="sob-cdetail__mark" aria-hidden="true">${connectorMark(c)}</span>
    <span class="sob-cdetail__title">
      <span class="sob-cdetail__name">${c.label}${c.group === "mcp" ? html`<span class="sob-tag">MCP</span>` : nothing}</span>
      <span class="sob-cdetail__blurb">${c.blurb}</span>
    </span>
  </div>`;

  let body: TemplateResult;
  if (isPlanLocked(c)) {
    body = planLockBody(ctx, c);
  } else if (c.id === "telegram") {
    // The guided setup: makes the bot, checks the token, finds the member's own
    // Telegram ID, tests it. Saves to this workspace only (tenant store).
    body = html`<telegram-setup
      data-testid="so-telegram-setup"
      .client=${ctx.client}
      @telegram-setup-changed=${() => void refreshConnector(ctx, c)}
    ></telegram-setup>`;
  } else if (isOn(c)) {
    body = connectedCallout(ctx, c, liveNote(c));
  } else if (c.mode === "later") {
    body = html`<div class="sob-later" data-testid="so-conn-later">
      <span class="sob-later__icon">${icon("clock")}</span>
      <span class="sob-later__text">
        <span class="sob-later__title">Connect later</span>
        <span class="sob-later__reason">${c.laterReason}</span>
      </span>
    </div>`;
  } else if (c.mode === "link") {
    body = whatsappBody(ctx, c);
  } else if (c.mode === "toggle") {
    const owner = c.reusesKeyOf ? st.connectors.find((x) => x.id === c.reusesKeyOf) : null;
    const blocked = Boolean(owner && !isOn(owner));
    body = html`<div class="sob-ctoggle">
      <span class="sob-hint">
        ${blocked
          ? `Connect ${owner!.label} first. ${c.label} runs on its token.`
          : owner
            ? `Runs on the ${owner.label} token you connected. Nothing else to paste.`
            : "Nothing to paste. Turn it on and your agents can use it."}
      </span>
      <button
        type="button"
        class="sob-btn sob-btn--primary"
        data-testid="so-conn-enable"
        aria-busy=${st.save.busy ? "true" : "false"}
        ?disabled=${blocked || st.save.busy}
        @click=${() => void saveConnector(ctx, c)}
      >
        ${st.save.busy ? html`<span class="sob-spinner"></span>Enabling…` : html`${blocked ? ctx.lockIcon(false) : icon("plug")}Enable`}
      </button>
    </div>`;
  } else {
    const ready = c.fields.every((f) => (st.drafts[`${c.id}.${f.id}`] ?? "").trim());
    body = html`
      <div class="sob-cform ${c.fields.length > 1 ? "is-pair" : ""}">
        ${c.fields.map((f, i) => field(ctx, c, f, i === 0))}
        <button
          type="button"
          class="sob-btn sob-btn--primary"
          data-testid="so-conn-save"
          aria-busy=${st.save.busy ? "true" : "false"}
          ?disabled=${!ready || st.save.busy}
          @click=${() => void saveConnector(ctx, c)}
        >
          ${st.save.busy ? html`<span class="sob-spinner"></span>Checking…` : html`${ctx.lockIcon(false)}Verify &amp; connect`}
        </button>
      </div>
      <span class="sob-hint sob-cnote">
        ${c.checkNote ? `${c.checkNote} ` : ""}${c.signupUrl
          ? html`<a href=${c.signupUrl} target="_blank" rel="noopener noreferrer">Get ${withArticle(c.fields[0]?.label.toLowerCase() ?? "token")} from ${c.label}</a>.`
          : nothing}
      </span>
    `;
  }
  return html`<div class="sob-cdetail" data-testid="so-conn-detail">
    ${head}${body}
    ${st.save.error
      ? html`<div class="sob-alert" role="alert" data-testid="so-conn-error">${icon("alertCircle")}<span>${st.save.error}</span></div>`
      : nothing}
  </div>`;
}

/** A connector the plan leaves out: why, and the upgrade (nothing to fill in, nothing deleted). */
function planLockBody(ctx: SetupCtx, c: ConnectorView): TemplateResult {
  const paused = isOn(c);
  const reason = c.laterReason ?? channelLockReason(c.id);
  return html`<div class="sob-planlock" data-testid="so-conn-planlock" data-plan-lock=${c.id}>
    <span class="sob-planlock__icon">${ctx.lockIcon(false)}</span>
    <span class="sob-planlock__text">
      <span class="sob-planlock__title">${paused ? "Paused on Free" : "Not on the Free plan"}</span>
      <span class="sob-planlock__reason">${paused
        ? `Your ${c.label} connection is saved but not running. Upgrade to resume it.`
        : reason}</span>
    </span>
    <button
      type="button"
      class="sob-btn sob-btn--primary sob-planlock__cta"
      data-testid="so-conn-upgrade"
      @click=${() => void openUpgrade("pro", { source: `onboarding:${c.id}` })}
    >
      ${icon("zap")}${paused ? "Upgrade to resume" : channelUpgradeCta(c.id)}
    </button>
  </div>`;
}

function countBar(label: string, items: ConnectorView[]): TemplateResult {
  const on = items.filter((c) => isOn(c) && !isPlanLocked(c)).length;
  const later = items.filter((c) => (c.mode === "later" || isPlanLocked(c)) && !isOn(c)).length;
  return html`<span class="sob-provbar__count"
    ><span class="sob-provbar__num">${items.length}</span> ${label}<span class="sob-dot"></span
    ><span class="sob-provbar__num ${on ? "is-on" : ""}">${on}</span> connected${later
      ? html`<span class="sob-dot"></span><span class="sob-provbar__num">${later}</span> later`
      : nothing}</span
  >`;
}

// ── Steps ──────────────────────────────────────────────────────────────────

export function renderChannelsStep(ctx: SetupCtx): TemplateResult {
  const channels = ctx.st.connectors.filter((c) => c.group === "channel");
  const sel = channels.find((c) => c.id === ctx.st.selected.channel) ?? null;
  return html`
    ${ctx.header(
      html`Connect your channels <span class="sob-tag">Optional</span>`,
      html`Reach your assistant where you already talk. Each token is checked with the service and stored
        only in your workspace. Skip any of them and add it later.`,
    )}
    <div class="sob-provbar">${countBar("channels", channels)}</div>
    <div class="sob-cgrid sob-cgrid--channels" role="radiogroup" aria-label="Channel">
      ${channels.map((c, i) => tile(ctx, "channel", c, i))}
    </div>
    ${detail(ctx, sel)}
  `;
}

export function renderIntegrationsStep(ctx: SetupCtx): TemplateResult {
  const { st } = ctx;
  const groups = {
    integration: st.connectors.filter((c) => c.group === "integration"),
    mcp: st.connectors.filter((c) => c.group === "mcp"),
  };
  const shown = groups[st.tab];
  const sel = shown.find((c) => c.id === st.selected.connect) ?? null;
  const tab = (id: "integration" | "mcp", label: string) => {
    const on = groups[id].filter(isOn).length;
    return html`<button
      type="button"
      role="tab"
      aria-selected=${st.tab === id}
      data-testid=${`so-conn-tab-${id}`}
      class="sob-ctab ${st.tab === id ? "is-selected" : ""}"
      @click=${() => {
        if (st.tab === id) return;
        st.tab = id;
        st.selected.connect =
          groups[id].find((c) => c.mode !== "later" && !isOn(c))?.id ?? groups[id][0]?.id ?? null;
        st.save = { busy: false, error: null, ok: null };
        ctx.requestUpdate();
      }}
    >
      ${label}<span class="sob-ctab__count ${on ? "is-on" : ""}">${on ? `${on}/` : ""}${groups[id].length}</span>
    </button>`;
  };
  return html`
    ${ctx.header(
      html`Integrations &amp; MCP <span class="sob-tag">Optional</span>`,
      "Give your agents your tools. Tokens are verified before they're saved. Anything that needs a sign-in we can't host yet is marked Connect later.",
    )}
    <div class="sob-provbar">
      <div class="sob-ctabs" role="tablist" aria-label="Connector type">
        ${tab("integration", "Integrations")} ${tab("mcp", "MCP connectors")}
      </div>
      ${countBar(st.tab === "mcp" ? "connectors" : "integrations", shown)}
    </div>
    <div class="sob-cgrid" role="radiogroup" aria-label=${st.tab === "mcp" ? "MCP connector" : "Integration"}>
      ${shown.map((c, i) => tile(ctx, "connect", c, i))}
    </div>
    ${detail(ctx, sel)}
  `;
}

function bizFingerprint(b: SetupState["biz"]): string {
  const { seed: _seed, ...rest } = b;
  return JSON.stringify(rest);
}

export function businessDirty(st: SetupState): boolean {
  if (!st.biz.name.trim()) return false;
  return st.bizSaved !== bizFingerprint(st.biz) || (st.biz.seed && !st.bizSeeded);
}

/** Save the business when it has changes. Resolves false when the save failed (stay on the step). */
export async function saveBusinessIfNeeded(ctx: SetupCtx): Promise<boolean> {
  const { st } = ctx;
  if (!businessDirty(st)) return true;
  st.bizSave = { busy: true, error: null, ok: null };
  ctx.requestUpdate();
  try {
    const res = await ctx.client.request<
      { ok: true; business: TenantBusiness; seeded: boolean } | { ok: false; error: string }
    >("saas.onboarding.business.save", { ...st.biz });
    if (res?.ok) {
      st.bizSaved = bizFingerprint(st.biz);
      st.bizSeeded = st.bizSeeded || Boolean(res.business.seededProjectId);
      st.bizSave = { busy: false, error: null, ok: res.seeded ? "saved and seeded" : "saved" };
      ctx.requestUpdate();
      return true;
    }
    st.bizSave = { busy: false, error: (res as { error?: string })?.error ?? "Couldn't save your business.", ok: null };
  } catch (err) {
    st.bizSave = { busy: false, error: String((err as Error)?.message ?? err), ok: null };
  }
  ctx.requestUpdate();
  return false;
}

function chips(
  ctx: SetupCtx,
  options: readonly string[],
  value: string,
  set: (v: string) => void,
  testid: string,
  label: string,
): TemplateResult {
  const slug = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return html`<div class="sob-chips" role="radiogroup" aria-label=${label}>
    ${options.map(
      (o) => html`<button
        type="button"
        role="radio"
        aria-checked=${value === o}
        data-testid=${`${testid}-${slug(o)}`}
        class="sob-seg__opt sob-chip ${value === o ? "is-selected" : ""}"
        @click=${() => {
          set(value === o ? "" : o);
          ctx.requestUpdate();
        }}
      >
        <span class="sob-seg__dot"></span>${o}
      </button>`,
    )}
  </div>`;
}

function textField(
  ctx: SetupCtx,
  label: string,
  value: string,
  set: (v: string) => void,
  opts: { testid: string; placeholder: string; max: number; type?: string; lg?: boolean },
): TemplateResult {
  return html`<label class="sob-field">
    <span class="sob-label">${label}</span>
    <input
      class="sob-input ${opts.lg ? "sob-input--biz" : "sob-input--sm"}"
      data-testid=${opts.testid}
      type=${opts.type ?? "text"}
      maxlength=${opts.max}
      autocomplete="off"
      placeholder=${opts.placeholder}
      .value=${value}
      @input=${(e: Event) => {
        set((e.target as HTMLInputElement).value);
        ctx.requestUpdate();
      }}
    />
  </label>`;
}

export function renderBusinessStep(ctx: SetupCtx): TemplateResult {
  const { st } = ctx;
  const b = st.biz;
  const industries = ctx.status.businessIndustries ?? [];
  const tones = ctx.status.businessTones ?? [];
  const mono = initials(b.name);
  const host = b.website.trim().replace(/^https?:\/\//i, "").replace(/\/$/, "");
  return html`
    ${ctx.header(
      html`Your business <span class="sob-tag">Optional</span>`,
      "Tell your assistant what you do. It becomes working context for every agent, and can set up your Business HQ.",
    )}
    <div class="sob-biz" style="--biz:${b.brandColor}">
      <div class="sob-biz__form">
        ${textField(ctx, "Business name", b.name, (v) => (b.name = v), {
          testid: "so-biz-name",
          placeholder: "e.g. Northwind Studio",
          max: 80,
          lg: true,
        })}
        <div class="sob-biz__pair">
          <label class="sob-field">
            <span class="sob-label">Industry</span>
            <select
              class="sob-input sob-input--sm sob-select sob-biz__select ${b.industry ? "" : "is-empty"}"
              data-testid="so-biz-industry"
              @change=${(e: Event) => {
                b.industry = (e.target as HTMLSelectElement).value;
                ctx.requestUpdate();
              }}
            >
              <option value="" ?selected=${!b.industry}>Choose one</option>
              ${industries.map((o) => html`<option value=${o} ?selected=${b.industry === o}>${o}</option>`)}
              ${b.industry && !industries.includes(b.industry)
                ? html`<option value=${b.industry} selected>${b.industry}</option>`
                : nothing}
            </select>
          </label>
          ${textField(ctx, "Website", b.website, (v) => (b.website = v), {
            testid: "so-biz-website",
            placeholder: "northwind.studio",
            max: 200,
            type: "url",
          })}
        </div>
        <label class="sob-field">
          <span class="sob-label">What you do</span>
          <textarea
            class="sob-input sob-textarea"
            data-testid="so-biz-desc"
            rows="3"
            maxlength="1200"
            placeholder="Who you serve, what you sell, and what makes you different."
            .value=${b.description}
            @input=${(e: Event) => {
              b.description = (e.target as HTMLTextAreaElement).value;
              ctx.requestUpdate();
            }}
          ></textarea>
        </label>
        <div class="sob-biz__pair">
          ${textField(ctx, "Tagline", b.tagline, (v) => (b.tagline = v), {
            testid: "so-biz-tagline",
            placeholder: "Design that ships",
            max: 140,
          })}
          ${textField(ctx, "Audience", b.audience, (v) => (b.audience = v), {
            testid: "so-biz-audience",
            placeholder: "Seed-stage founders",
            max: 200,
          })}
        </div>
      </div>

      <aside class="sob-biz__side">
        <div class="sob-bizcard" data-testid="so-biz-preview">
          <span class="sob-bizcard__label">Brand preview</span>
          <div class="sob-bizcard__row">
            <span class="sob-bizcard__mark">${mono || html`<span class="sob-bizcard__blank"></span>`}</span>
            <span class="sob-bizcard__id">
              <span class="sob-bizcard__name">${b.name.trim() || "Your business"}</span>
              <span class="sob-bizcard__tag">${b.tagline.trim() || b.industry || "Tagline"}</span>
            </span>
          </div>
          <div class="sob-bizcard__meta">
            ${b.industry ? html`<span>${b.industry}</span>` : nothing}
            ${b.tone ? html`<span>${b.tone}</span>` : nothing}
            ${host ? html`<span class="sob-bizcard__host">${host}</span>` : nothing}
          </div>
          <span class="sob-bizcard__bar"></span>
        </div>

        <div class="sob-field">
          <span class="sob-label" id="sob-biz-color">Brand colour</span>
          <div class="sob-swatches" role="radiogroup" aria-labelledby="sob-biz-color">
            ${BRAND_SWATCHES.map(
              (hex) => html`<button
                type="button"
                role="radio"
                aria-checked=${b.brandColor === hex}
                aria-label=${hex}
                data-testid=${`so-biz-color-${hex.slice(1)}`}
                class="sob-swatch ${b.brandColor === hex ? "is-selected" : ""}"
                style="--sw:${hex}"
                @click=${() => {
                  b.brandColor = hex;
                  ctx.requestUpdate();
                }}
              ></button>`,
            )}
            <label class="sob-swatch sob-swatch--custom ${BRAND_SWATCHES.includes(b.brandColor as (typeof BRAND_SWATCHES)[number]) ? "" : "is-selected"}" style="--sw:${b.brandColor}" title="Custom colour">
              <input
                type="color"
                aria-label="Custom brand colour"
                data-testid="so-biz-color-custom"
                .value=${b.brandColor}
                @input=${(e: Event) => {
                  b.brandColor = (e.target as HTMLInputElement).value;
                  ctx.requestUpdate();
                }}
              />
              ${icon("plus")}
            </label>
          </div>
        </div>

        <div class="sob-field">
          <span class="sob-label">Voice</span>
          ${chips(ctx, tones, b.tone, (v) => (b.tone = v), "so-biz-tone", "Brand voice")}
        </div>

        ${st.seedAvailable ? html`<button
          type="button"
          role="switch"
          aria-checked=${st.bizSeeded || b.seed}
          data-testid="so-biz-seed"
          class="sob-switch ${st.bizSeeded || b.seed ? "is-on" : ""}"
          ?disabled=${st.bizSeeded}
          @click=${() => {
            b.seed = !b.seed;
            ctx.requestUpdate();
          }}
        >
          <span class="sob-switch__track"><span class="sob-switch__thumb"></span></span>
          <span class="sob-switch__text">
            <span class="sob-switch__title">${st.bizSeeded ? "Business HQ created" : "Set up my Business HQ"}</span>
            <span class="sob-switch__desc">${st.bizSeeded
              ? "Your starter project is on the board."
              : html`Adds <strong>${b.name.trim() || "your business"} HQ</strong> with three starter tasks.`}</span>
          </span>
        </button>` : nothing}
      </aside>
    </div>
    ${st.bizSave.error
      ? html`<div class="sob-alert" role="alert" data-testid="so-biz-error">${icon("alertCircle")}<span>${st.bizSave.error}</span></div>`
      : st.bizSaved && !businessDirty(st)
        ? html`<div class="sob-savedline" data-testid="so-biz-saved"><span class="sob-led is-on"></span>Saved to your workspace</div>`
        : nothing}
  `;
}

/** Rows for the review manifest. */
export function setupSummary(st: SetupState, status: SetupStatus): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  const names = (group: string[]) =>
    st.connectors.filter((c) => group.includes(c.group) && isOn(c)).map((c) => c.label).join(", ");
  if (hasConnectorSteps(status)) {
    rows.push({ label: "Channels", value: names(["channel"]) || "None yet" });
    rows.push({ label: "Integrations", value: names(["integration", "mcp"]) || "None yet" });
  }
  if (hasBusinessStep(status)) {
    rows.push({
      label: "Business",
      value: st.bizSaved
        ? [st.biz.name.trim(), st.biz.industry, st.bizSeeded ? "HQ ready" : null].filter(Boolean).join(" · ")
        : "Not set",
    });
  }
  return rows;
}

export function setupStyles(): TemplateResult {
  return html`<style>
    /* ── Connector tiles (reuse .sob-prov) ─────────────────── */
    .sob-cgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(196px, 1fr)); gap: 10px; }
    .sob-cgrid--channels { grid-template-columns: repeat(4, minmax(0, 1fr)); margin-top: 2px; }
    .sob-ctile.is-later:not(.is-selected) { border-style: dashed; background: rgba(255, 255, 255, 0.012); }
    .sob-ctile.is-later:not(.is-selected) .sob-prov__mark { color: var(--sob-fg-4); }
    .sob-ctile.is-later .sob-prov__status { color: color-mix(in srgb, var(--sob-amber) 70%, var(--sob-fg-3)); }
    .sob-ctile__later { display: grid; color: color-mix(in srgb, var(--sob-amber) 65%, var(--sob-fg-4)); }
    .sob-ctile__later svg { width: 14px; height: 14px; }
    /* Four channels in one row: the LED moves into the corner so names keep their width. */
    .sob-cgrid--channels .sob-prov { grid-template-columns: 40px minmax(0, 1fr); padding-right: 12px; }
    .sob-cgrid--channels .sob-prov > .sob-led, .sob-cgrid--channels .sob-prov > .sob-ctile__later { position: absolute; top: 9px; right: 9px; }
    .sob-cgrid--channels .sob-prov > .sob-ctile__later svg { width: 12px; height: 12px; }
    .sob-ctabs { display: inline-flex; gap: 4px; padding: 4px; border-radius: 12px; background: rgba(0, 0, 0, 0.35); border: 1px solid var(--sob-line); }
    .sob-ctab {
      display: inline-flex; align-items: center; gap: 8px; height: 32px; padding: 0 12px; border-radius: 8px;
      border: 1px solid transparent; background: none; color: var(--sob-fg-3); cursor: pointer;
      font: 500 13px var(--sob-sans); white-space: nowrap;
      transition: color 0.25s, background 0.25s, border-color 0.25s, box-shadow 0.25s;
    }
    .sob-ctab:hover { color: var(--sob-fg); }
    .sob-ctab:focus-visible { outline: 2px solid var(--sob-gold); outline-offset: 2px; }
    .sob-ctab.is-selected {
      color: var(--sob-fg); border-color: color-mix(in srgb, var(--sob-gold) 55%, transparent);
      background: color-mix(in srgb, var(--sob-gold) 11%, rgba(0, 0, 0, 0.3)); box-shadow: var(--sob-glow-soft);
    }
    .sob-ctab__count { font-family: var(--sob-mono); font-size: 10.5px; color: var(--sob-fg-4); font-variant-numeric: tabular-nums; }
    .sob-ctab.is-selected .sob-ctab__count { color: var(--sob-gold); }
    .sob-ctab__count.is-on { color: var(--sob-ok) !important; }

    /* ── Detail card ───────────────────────────────────────── */
    .sob-cdetail {
      margin-top: 14px; padding: 16px 18px 18px; border-radius: 16px;
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.03), rgba(0, 0, 0, 0.22));
      border: 1px solid var(--sob-line);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
      animation: sob-step-in 0.4s var(--sob-ease) both;
    }
    .sob-cdetail .sob-unlock, .sob-cdetail .sob-alert { margin-top: 14px; }
    .sob-cdetail__head { display: flex; align-items: center; gap: 14px; }
    .sob-cdetail__mark {
      width: 42px; height: 42px; border-radius: 11px; flex-shrink: 0; display: grid; place-items: center;
      font: 600 16px/1 var(--sob-mono); color: color-mix(in srgb, var(--sob-gold) 70%, #fff);
      background: radial-gradient(circle at 50% 18%, color-mix(in srgb, var(--sob-gold) 28%, #15110a), #0a0907 75%);
      border: 1px solid color-mix(in srgb, var(--sob-gold) 55%, transparent);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.18), var(--sob-glow-soft);
      text-shadow: 0 0 10px color-mix(in srgb, var(--sob-gold) 70%, transparent);
    }
    .sob-cdetail__title { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .sob-cdetail__name { display: flex; align-items: center; gap: 10px; font-size: 16px; font-weight: 600; color: var(--sob-fg); }
    .sob-cdetail__name .sob-tag { padding: 2px 8px; font-size: 9.5px; }
    .sob-cdetail__blurb { font-size: 13.5px; color: var(--sob-fg-3); line-height: 1.45; }
    .sob-cform { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; align-items: end; margin-top: 14px; }
    .sob-cform.is-pair { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; }
    .sob-cfield { margin-top: 0; gap: 8px; }
    .sob-cfield .sob-input { height: 48px; }
    .sob-cnote { display: block; margin-top: 10px; font-size: 12.5px; }
    .sob-unlock__live { color: var(--sob-fg-3); }
    .sob-ctoggle { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 14px; }

    /* Plan lock (hosted Free: Telegram, Slack): gold, not amber, and an upgrade CTA. */
    .sob-ctile.is-plan-locked .sob-prov__status { color: color-mix(in srgb, var(--sob-gold) 78%, var(--sob-fg-3)); }
    .sob-ctile__lock { color: color-mix(in srgb, var(--sob-gold) 80%, var(--sob-fg-4)); }
    .sob-planlock {
      display: flex; align-items: center; gap: 14px; margin-top: 14px; padding: 14px 16px; border-radius: 13px;
      background: linear-gradient(180deg, color-mix(in srgb, var(--sob-gold) 9%, rgba(0, 0, 0, 0.25)), rgba(0, 0, 0, 0.28));
      border: 1px solid color-mix(in srgb, var(--sob-gold) 38%, transparent);
      box-shadow: var(--sob-glow-soft);
    }
    .sob-planlock__icon {
      width: 34px; height: 34px; border-radius: 10px; flex-shrink: 0; display: grid; place-items: center;
      color: var(--sob-gold); border: 1px solid color-mix(in srgb, var(--sob-gold) 45%, transparent);
      background: color-mix(in srgb, var(--sob-gold) 10%, #0b0a08);
    }
    .sob-planlock__icon svg { width: 17px; height: 17px; }
    .sob-planlock__text { display: flex; flex-direction: column; gap: 3px; flex: 1; min-width: 0; }
    .sob-planlock__title { font-family: var(--sob-mono); font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--sob-gold); }
    .sob-planlock__reason { font-size: 14px; color: var(--sob-fg-2); line-height: 1.5; }
    .sob-planlock__cta { flex-shrink: 0; white-space: nowrap; }
    .sob-planlock__cta svg { width: 15px; height: 15px; }
    @media (max-width: 640px) {
      .sob-planlock { flex-wrap: wrap; }
      .sob-planlock__cta { width: 100%; justify-content: center; }
    }

    .sob-later {
      display: flex; align-items: flex-start; gap: 14px; margin-top: 14px; padding: 14px 16px; border-radius: 13px;
      background: color-mix(in srgb, var(--sob-amber) 6%, rgba(0, 0, 0, 0.25));
      border: 1px dashed color-mix(in srgb, var(--sob-amber) 34%, transparent);
    }
    .sob-later__icon {
      width: 34px; height: 34px; border-radius: 10px; flex-shrink: 0; display: grid; place-items: center;
      color: var(--sob-amber); border: 1px solid color-mix(in srgb, var(--sob-amber) 38%, transparent);
      background: color-mix(in srgb, var(--sob-amber) 8%, #0b0a08);
    }
    .sob-later__icon svg { width: 17px; height: 17px; }
    .sob-later__text { display: flex; flex-direction: column; gap: 3px; }
    .sob-later__title { font-family: var(--sob-mono); font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--sob-amber); }
    .sob-later__reason { font-size: 14px; color: var(--sob-fg-2); line-height: 1.5; }

    /* ── WhatsApp link ─────────────────────────────────────── */
    .sob-wa { display: grid; grid-template-columns: minmax(0, 1fr) 172px; gap: 20px; margin-top: 12px; align-items: stretch; }
    .sob-wa__controls { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
    .sob-wa__action { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
    .sob-wa__action .sob-hint { font-size: 12.5px; }
    .sob-wa__steps { margin: 0; padding-left: 20px; display: grid; gap: 3px; font-size: 13.5px; color: var(--sob-fg-2); line-height: 1.45; }
    .sob-wa__steps li::marker { font-family: var(--sob-mono); font-size: 11px; color: var(--sob-gold); }
    .sob-wa__steps strong { color: var(--sob-fg); font-weight: 600; }
    .sob-wa__stage {
      position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px;
      min-height: 164px; padding: 10px; border-radius: 14px;
      background: rgba(0, 0, 0, 0.35); border: 1px solid var(--sob-line);
    }
    .sob-wa__stage.is-live { border-color: color-mix(in srgb, var(--sob-gold) 45%, transparent); box-shadow: var(--sob-glow-soft); }
    .sob-wa__idle { display: flex; flex-direction: column; align-items: center; gap: 10px; text-align: center; font-size: 12.5px; color: var(--sob-fg-4); }
    .sob-wa__frame {
      position: relative; width: 74px; height: 74px; display: grid; place-items: center; color: var(--sob-fg-4);
      background:
        linear-gradient(var(--sob-line-2), var(--sob-line-2)) top left / 14px 1.5px no-repeat,
        linear-gradient(var(--sob-line-2), var(--sob-line-2)) top left / 1.5px 14px no-repeat,
        linear-gradient(var(--sob-line-2), var(--sob-line-2)) top right / 14px 1.5px no-repeat,
        linear-gradient(var(--sob-line-2), var(--sob-line-2)) top right / 1.5px 14px no-repeat,
        linear-gradient(var(--sob-line-2), var(--sob-line-2)) bottom left / 14px 1.5px no-repeat,
        linear-gradient(var(--sob-line-2), var(--sob-line-2)) bottom left / 1.5px 14px no-repeat,
        linear-gradient(var(--sob-line-2), var(--sob-line-2)) bottom right / 14px 1.5px no-repeat,
        linear-gradient(var(--sob-line-2), var(--sob-line-2)) bottom right / 1.5px 14px no-repeat;
    }
    .sob-wa__frame svg { width: 26px; height: 26px; }
    .sob-wa__qr { position: relative; width: 140px; height: 140px; padding: 7px; border-radius: 10px; background: #fff; overflow: hidden; animation: sob-unlock-in 0.5s var(--sob-ease) both; }
    .sob-wa__qr img { display: block; width: 100%; height: 100%; image-rendering: pixelated; }
    .sob-wa__beam {
      position: absolute; left: 0; right: 0; top: 0; height: 30%; pointer-events: none;
      background: linear-gradient(180deg, transparent, color-mix(in srgb, var(--sob-gold) 32%, transparent) 85%, color-mix(in srgb, var(--sob-gold) 70%, transparent));
      animation: sob-wa-beam 2.4s ease-in-out infinite;
    }
    @keyframes sob-wa-beam { 0% { transform: translateY(-100%); } 100% { transform: translateY(340%); } }
    .sob-wa__code { display: flex; align-items: center; gap: 4px; font: 600 22px/1 var(--sob-mono); color: var(--sob-fg); animation: sob-unlock-in 0.5s var(--sob-ease) both; }
    .sob-wa__code span:not(.sob-wa__dash) {
      width: 19px; height: 32px; display: grid; place-items: center; border-radius: 6px;
      background: rgba(255, 255, 255, 0.04); border: 1px solid var(--sob-line-2); color: color-mix(in srgb, var(--sob-gold) 60%, #fff);
    }
    .sob-wa__dash { width: 6px; height: 1.5px; background: var(--sob-fg-4); margin: 0 1px; }
    .sob-wa__status { display: inline-flex; align-items: center; gap: 8px; font-family: var(--sob-mono); font-size: 10.5px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--sob-fg-3); }

    /* ── Business ──────────────────────────────────────────── */
    .sob-biz { display: grid; grid-template-columns: minmax(0, 1fr) 244px; gap: 24px; align-items: start; }
    .sob-biz__form, .sob-biz__side { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
    .sob-biz__select { max-width: none; }
    .sob-biz__select.is-empty { color: var(--sob-fg-4); }
    .sob-biz .sob-field { margin-top: 0; gap: 8px; }
    .sob-biz__pair { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .sob-input--sm { height: 44px; font-size: 14.5px; }
    .sob-input--biz { height: 50px; font-size: 16.5px; }
    .sob-textarea { height: auto; min-height: 76px; padding: 12px 16px; resize: vertical; line-height: 1.5; font-size: 14.5px; }
    .sob-chips { display: flex; flex-wrap: wrap; gap: 7px; }
    .sob-chip { height: 32px; padding: 0 11px; font-size: 12.5px; gap: 6px; }
    .sob-biz__side .sob-chips { gap: 6px; }
    .sob-biz__side .sob-chip { padding: 0 9px; font-size: 12px; }
    .sob-chip .sob-seg__dot { width: 6px; height: 6px; }

    .sob-bizcard {
      position: relative; overflow: hidden; padding: 14px 16px 16px; border-radius: 14px;
      background:
        radial-gradient(120% 90% at 0% 0%, color-mix(in srgb, var(--biz) 20%, transparent), transparent 60%),
        linear-gradient(180deg, rgba(255, 255, 255, 0.035), rgba(0, 0, 0, 0.3));
      border: 1px solid color-mix(in srgb, var(--biz) 38%, var(--sob-line));
      box-shadow: 0 16px 40px -24px color-mix(in srgb, var(--biz) 70%, transparent);
      transition: border-color 0.35s, box-shadow 0.35s;
    }
    .sob-bizcard__label { font-family: var(--sob-mono); font-size: 9.5px; letter-spacing: 0.22em; text-transform: uppercase; color: var(--sob-fg-4); }
    .sob-bizcard__row { display: flex; align-items: center; gap: 12px; margin-top: 10px; }
    .sob-bizcard__mark {
      width: 44px; height: 44px; border-radius: 12px; flex-shrink: 0; display: grid; place-items: center;
      font: 600 17px/1 var(--sob-sans); letter-spacing: -0.02em; color: #0b0a08;
      background: linear-gradient(160deg, color-mix(in srgb, var(--biz) 55%, #fff), var(--biz));
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.45), 0 0 18px -4px color-mix(in srgb, var(--biz) 80%, transparent);
      transition: background 0.35s, box-shadow 0.35s;
    }
    .sob-bizcard__blank { width: 16px; height: 16px; border-radius: 4px; border: 1.5px solid rgba(0, 0, 0, 0.45); transform: rotate(45deg); }
    .sob-bizcard__id { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .sob-bizcard__name { font-size: 15.5px; font-weight: 600; color: var(--sob-fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sob-bizcard__tag { font-size: 12.5px; color: var(--sob-fg-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sob-bizcard__meta { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; min-height: 22px; }
    .sob-bizcard__meta span {
      font-family: var(--sob-mono); font-size: 10px; letter-spacing: 0.06em; color: var(--sob-fg-2);
      padding: 3px 8px; border-radius: 999px; border: 1px solid color-mix(in srgb, var(--biz) 30%, var(--sob-line));
      max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .sob-bizcard__bar { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: linear-gradient(90deg, var(--biz), transparent); }

    .sob-swatches { display: flex; flex-wrap: wrap; gap: 8px; padding: 2px 0 2px 2px; }
    .sob-swatch {
      position: relative; width: 22px; height: 22px; border-radius: 50%; padding: 0; cursor: pointer;
      background: var(--sw); border: 1px solid rgba(255, 255, 255, 0.18);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.35);
      transition: transform 0.2s var(--sob-ease), box-shadow 0.25s;
    }
    .sob-swatch:hover { transform: scale(1.08); }
    .sob-swatch:focus-visible, .sob-swatch--custom:focus-within { outline: 2px solid var(--sob-gold); outline-offset: 3px; }
    .sob-swatch.is-selected { box-shadow: 0 0 0 2px #0b0a08, 0 0 0 3.5px var(--sw), 0 0 14px -2px var(--sw); }
    .sob-swatch--custom {
      display: grid; place-items: center; color: var(--sob-fg-2);
      background: conic-gradient(from 0deg, #f43f5e, #f59e0b, #10b981, #38bdf8, #8b5cf6, #f43f5e);
    }
    .sob-swatch--custom.is-selected { background: var(--sw); }
    .sob-swatch--custom svg { width: 13px; height: 13px; color: #0b0a08; filter: drop-shadow(0 0 2px rgba(255,255,255,0.6)); }
    .sob-swatch--custom input { position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; height: 100%; }

    .sob-switch {
      display: grid; grid-template-columns: 40px minmax(0, 1fr); gap: 12px; align-items: start; text-align: left;
      padding: 12px 14px; border-radius: 13px; cursor: pointer; color: inherit; font: inherit;
      background: rgba(0, 0, 0, 0.28); border: 1px solid var(--sob-line);
      transition: border-color 0.25s, background 0.25s, box-shadow 0.25s;
    }
    .sob-switch:focus-visible { outline: 2px solid var(--sob-gold); outline-offset: 2px; }
    .sob-switch.is-on { border-color: color-mix(in srgb, var(--sob-gold) 50%, transparent); background: color-mix(in srgb, var(--sob-gold) 7%, rgba(0, 0, 0, 0.28)); }
    .sob-switch:disabled { cursor: default; }
    .sob-switch__track { position: relative; width: 38px; height: 22px; margin-top: 1px; border-radius: 999px; background: rgba(255, 255, 255, 0.06); border: 1px solid var(--sob-line-2); transition: background 0.25s; }
    .sob-switch__thumb { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--sob-fg-3); transition: transform 0.3s var(--sob-ease), background 0.25s, box-shadow 0.25s; }
    .sob-switch.is-on .sob-switch__track { background: color-mix(in srgb, var(--sob-gold) 30%, transparent); }
    .sob-switch.is-on .sob-switch__thumb { transform: translateX(16px); background: var(--sob-gold); box-shadow: 0 0 10px var(--sob-gold); }
    .sob-switch__text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .sob-switch__title { font-size: 14px; font-weight: 600; color: var(--sob-fg); }
    .sob-switch__desc { font-size: 12.5px; color: var(--sob-fg-3); line-height: 1.45; }
    .sob-switch__desc strong { color: var(--sob-fg-2); font-weight: 600; }
    .sob-savedline { display: inline-flex; align-items: center; gap: 9px; margin-top: 14px; font-family: var(--sob-mono); font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--sob-fg-3); }

    @media (min-width: 861px) and (max-height: 960px) {
      .sob-textarea { min-height: 64px; }
      .sob-bizcard__meta { margin-top: 10px; }
    }
    @media (max-width: 860px) {
      .sob-cgrid--channels { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .sob-biz { grid-template-columns: minmax(0, 1fr); }
      .sob-biz__side { display: grid; grid-template-columns: minmax(0, 1fr); }
    }
    @media (max-width: 560px) {
      .sob-cgrid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
      /* Two narrow columns: let long names ("Google Calendar") take a second line. */
      .sob-ctile .sob-prov__name { white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
      .sob-ctabs { width: 100%; }
      .sob-ctab { flex: 1; justify-content: center; }
      .sob-cdetail { padding: 14px; }
      .sob-cform, .sob-cform.is-pair { grid-template-columns: minmax(0, 1fr); }
      .sob-cform .sob-btn { width: 100%; }
      .sob-ctoggle { flex-direction: column; align-items: stretch; }
      .sob-wa { grid-template-columns: minmax(0, 1fr); }
      /* A live code is what the member needs to see first on a phone. */
      .sob-wa__stage.is-live { order: -1; }
      .sob-wa__controls .sob-btn { align-self: stretch; }
      .sob-biz__pair { grid-template-columns: minmax(0, 1fr); }
      .sob-ctile > .sob-ctile__later { position: absolute; top: 7px; right: 7px; }
      .sob-ctile > .sob-ctile__later svg { width: 11px; height: 11px; }
    }
  </style>`;
}
