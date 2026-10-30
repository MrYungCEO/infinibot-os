/**
 * Local setup wizard: what `infinibot quickstart` (npm installs) opens in the
 * browser. Served by the standalone setup server (src/setup-ui/server.ts) from
 * the `setup.html` entry, and talks to it over `/api/<method>` with the
 * one-time token the CLI printed.
 *
 * It is the hosted quickstart's console (onboarding/console-chrome.ts, the
 * `.sob-*` language) with the self-hosted steps: install mode (standalone or
 * satellite), bring-your-own model key (verified with the provider), optional
 * channels and Robovoice; or, as a satellite, find the master, pair with an
 * invite, test the link and choose what to share. No billing or plans.
 *
 * No emoji anywhere: providers and channels get two-letter text marks.
 */
import { html, nothing, type TemplateResult } from "lit";
import { icon } from "../icons";
import {
  lockIcon,
  providerMark,
  renderBrandMark,
  renderConsoleFooter,
  renderConsoleShell,
  renderStepHeader,
  splitProviderLabel,
} from "../onboarding/console-chrome";
import {
  blockedNote,
  canContinue,
  canFinish,
  clearLocalResume,
  loadLocalResume,
  resumeIndex,
  saveLocalResume,
  stepsForMode,
  type GateState,
  type InstallMode,
  type LocalStepKey,
} from "./local-setup-steps";

// ── Transport ───────────────────────────────────────────────────────────────

export type SetupTransport = <T = Record<string, unknown>>(method: string, params?: Record<string, unknown>) => Promise<T>;

/** fetch → `/api/<method>`; the server answers `{ ok, data }` / `{ ok:false, error }`. */
export function createHttpTransport(token: string, fetchImpl: typeof fetch = fetch): SetupTransport {
  return async <T,>(method: string, params: Record<string, unknown> = {}) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60_000);
    let res: Response;
    try {
      res = await fetchImpl(`./api/${encodeURIComponent(method)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Setup-Token": token, Accept: "application/json" },
        body: JSON.stringify(params),
        signal: ctrl.signal,
        credentials: "same-origin",
      });
    } catch (err) {
      clearTimeout(timer);
      throw new Error(
        (err as Error)?.name === "AbortError"
          ? "The setup server didn't answer in time."
          : "Lost connection to the setup server. Is `infinibot quickstart` still running?",
      );
    }
    clearTimeout(timer);
    const body = (await res.json().catch(() => null)) as
      | { ok: true; data: T }
      | { ok: false; error?: { message?: string } }
      | null;
    if (!body) throw new Error(`Setup server answered HTTP ${res.status}.`);
    if (!body.ok) throw new Error(body.error?.message ?? `Setup server answered HTTP ${res.status}.`);
    return body.data;
  };
}

// ── Types ───────────────────────────────────────────────────────────────────

export type SetupProvider = {
  id: string;
  label: string;
  keyHint: string;
  signupUrl: string;
  kind: "chat" | "local";
  verifiable: boolean;
  configured: boolean;
  maskedKey: string | null;
};

export type SetupChannel = {
  id: string;
  label: string;
  blurb: string;
  signupUrl: string | null;
  fields: Array<{ id: string; label: string; hint: string }>;
  configured: boolean;
};

export type ShareState = { terminals: boolean; coders: boolean; agents: boolean; compute: boolean };

export type LocalSetupStatus = {
  installMode: InstallMode;
  providers: SetupProvider[];
  primaryModel: string | null;
  channels: SetupChannel[];
  robovoice: { linked: boolean };
  satellite: {
    masterUrl: string | null;
    nodeName: string | null;
    paired: boolean;
    share: Partial<ShareState>;
  };
  hostname: string;
  platform: string;
  gatewayPort: number;
  cloudUrl: string;
  onboarded: boolean;
};

type Busy = { busy: boolean; error: string | null; ok: string | null };
const idle = (): Busy => ({ busy: false, error: null, ok: null });

type ProbeResult = {
  ok: boolean;
  masterUrl: string;
  code?: string;
  error?: string;
  latencyMs?: number;
  permission?: string | null;
  tried?: string[];
};

type InviteInfo = {
  ok: boolean;
  error?: string;
  masterUrls?: string[];
  hubName?: string | null;
  satelliteName?: string | null;
  expiresAt?: number | null;
  permission?: string | null;
};

type State = {
  mode: InstallMode;
  step: number;
  status: LocalSetupStatus;
  // keys
  selected: string | null;
  keyDraft: string;
  filter: string;
  save: Busy;
  // channels
  channel: string | null;
  channelDrafts: Record<string, string>;
  channelSave: Busy;
  channelAccounts: Record<string, string>;
  // satellite
  masterUrl: string;
  discover: { busy: boolean; ran: boolean; found: Array<{ name: string; url: string; source: string }> };
  invite: string;
  inviteInfo: InviteInfo | null;
  nodeName: string;
  probe: { busy: boolean; result: ProbeResult | null };
  share: ShareState;
  satelliteSave: Busy;
  satelliteSaved: boolean;
  // finish
  finishing: boolean;
  finishError: string | null;
  finished: { gatewayPort: number; mirrored: string[] | null; mirrorError: string | null } | null;
  closed: boolean;
  copied: boolean;
  advancing: boolean;
};

export type LocalSetupProps = {
  send: SetupTransport;
  status: LocalSetupStatus;
  requestUpdate: () => void;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
};

let s: State | null = null;

function gate(st: State): GateState {
  return {
    mode: st.mode,
    hasModel: st.status.providers.some((p) => p.configured),
    masterUrl: st.masterUrl,
    linkVerified: Boolean(st.probe.result?.ok),
    satelliteSaved: st.satelliteSaved,
  };
}

function init(props: LocalSetupProps): State {
  const status = props.status;
  const saved = loadLocalResume(props.storage);
  const mode: InstallMode = saved?.mode ?? status.installMode;
  const share = status.satellite.share ?? {};
  const st: State = {
    mode,
    step: 0,
    status,
    selected: status.providers.find((p) => !p.configured)?.id ?? status.providers[0]?.id ?? null,
    keyDraft: "",
    filter: "",
    save: idle(),
    channel: status.channels[0]?.id ?? null,
    channelDrafts: {},
    channelSave: idle(),
    channelAccounts: {},
    masterUrl: status.satellite.masterUrl ?? "",
    discover: { busy: false, ran: false, found: [] },
    invite: "",
    inviteInfo: null,
    nodeName: status.satellite.nodeName ?? status.hostname,
    probe: { busy: false, result: null },
    share: {
      terminals: share.terminals ?? true,
      coders: share.coders ?? true,
      agents: share.agents ?? true,
      compute: share.compute ?? true,
    },
    satelliteSave: idle(),
    satelliteSaved: status.satellite.paired,
    finishing: false,
    finishError: null,
    finished: null,
    closed: false,
    copied: false,
    advancing: false,
  };
  st.step = resumeIndex(stepsForMode(mode), saved, gate(st));
  return st;
}

function persist(props: LocalSetupProps, st: State): void {
  const at = stepsForMode(st.mode)[st.step]?.key;
  if (at && !st.finished) saveLocalResume(props.storage, { mode: st.mode, at });
}

async function refreshStatus(props: LocalSetupProps, st: State): Promise<void> {
  try {
    st.status = await props.send<LocalSetupStatus>("setup.status");
  } catch {
    /* keep the last good snapshot */
  }
}

// ── Actions ─────────────────────────────────────────────────────────────────

async function saveKey(props: LocalSetupProps, st: State): Promise<void> {
  const provider = st.status.providers.find((p) => p.id === st.selected);
  if (!provider || st.save.busy) return;
  const value = st.keyDraft.trim();
  if (provider.kind !== "local" && !value) return;
  st.save = { busy: true, error: null, ok: null };
  props.requestUpdate();
  try {
    const res = await props.send<{ ok: boolean; error?: string; modelCount?: number; verified?: boolean }>(
      "setup.provider.save",
      provider.kind === "local" ? { provider: provider.id, endpoint: value } : { provider: provider.id, apiKey: value },
    );
    if (res.ok) {
      st.keyDraft = "";
      st.save = {
        busy: false,
        error: null,
        ok:
          res.verified === false
            ? "stored, not verified (no key check for this provider)"
            : typeof res.modelCount === "number"
              ? `${res.modelCount} models available`
              : provider.kind === "local"
                ? "Ollama is reachable"
                : "key verified",
      };
      await refreshStatus(props, st);
    } else {
      st.save = { busy: false, error: res.error ?? "The provider rejected this key.", ok: null };
    }
  } catch (err) {
    st.save = { busy: false, error: String((err as Error)?.message ?? err), ok: null };
  }
  props.requestUpdate();
}

async function removeKey(props: LocalSetupProps, st: State, id: string): Promise<void> {
  try {
    await props.send("setup.provider.remove", { provider: id });
    await refreshStatus(props, st);
    st.selected = id;
    st.save = idle();
  } catch (err) {
    st.save = { busy: false, error: String((err as Error)?.message ?? err), ok: null };
  }
  props.requestUpdate();
}

async function saveChannel(props: LocalSetupProps, st: State, ch: SetupChannel): Promise<void> {
  if (st.channelSave.busy) return;
  const values = Object.fromEntries(ch.fields.map((f) => [f.id, (st.channelDrafts[`${ch.id}.${f.id}`] ?? "").trim()]));
  st.channelSave = { busy: true, error: null, ok: null };
  props.requestUpdate();
  try {
    const res = await props.send<{ ok: boolean; error?: string; account?: string | null }>("setup.channel.save", {
      channel: ch.id,
      values,
    });
    if (res.ok) {
      for (const f of ch.fields) delete st.channelDrafts[`${ch.id}.${f.id}`];
      if (res.account) st.channelAccounts[ch.id] = res.account;
      st.channelSave = { busy: false, error: null, ok: res.account ? `connected as ${res.account}` : "token verified" };
      await refreshStatus(props, st);
    } else {
      st.channelSave = { busy: false, error: res.error ?? `${ch.label} rejected this token.`, ok: null };
    }
  } catch (err) {
    st.channelSave = { busy: false, error: String((err as Error)?.message ?? err), ok: null };
  }
  props.requestUpdate();
}

async function removeChannel(props: LocalSetupProps, st: State, id: string): Promise<void> {
  try {
    await props.send("setup.channel.remove", { channel: id });
    delete st.channelAccounts[id];
    st.channelSave = idle();
    await refreshStatus(props, st);
  } catch (err) {
    st.channelSave = { busy: false, error: String((err as Error)?.message ?? err), ok: null };
  }
  props.requestUpdate();
}

async function discover(props: LocalSetupProps, st: State): Promise<void> {
  if (st.discover.busy) return;
  st.discover = { busy: true, ran: false, found: [] };
  props.requestUpdate();
  try {
    const res = await props.send<{ masters: State["discover"]["found"] }>("setup.satellite.discover");
    st.discover = { busy: false, ran: true, found: res.masters ?? [] };
    if (!st.masterUrl && st.discover.found[0]) st.masterUrl = st.discover.found[0].url;
  } catch {
    st.discover = { busy: false, ran: true, found: [] };
  }
  props.requestUpdate();
}

async function readInvite(props: LocalSetupProps, st: State): Promise<void> {
  const invite = st.invite.trim();
  st.probe = { busy: false, result: null };
  if (!invite) {
    st.inviteInfo = null;
    props.requestUpdate();
    return;
  }
  try {
    st.inviteInfo = await props.send<InviteInfo>("setup.satellite.decodeInvite", { invite });
    if (st.inviteInfo.ok && st.inviteInfo.satelliteName && st.nodeName === st.status.hostname) {
      st.nodeName = st.inviteInfo.satelliteName;
    }
  } catch (err) {
    st.inviteInfo = { ok: false, error: String((err as Error)?.message ?? err) };
  }
  props.requestUpdate();
}

async function testLink(props: LocalSetupProps, st: State): Promise<void> {
  if (st.probe.busy) return;
  st.probe = { busy: true, result: null };
  props.requestUpdate();
  try {
    const res = await props.send<ProbeResult>("setup.satellite.test", {
      masterUrl: st.masterUrl,
      invite: st.invite.trim() || undefined,
      nodeName: st.nodeName,
    });
    st.probe = { busy: false, result: res };
    if (res.ok) st.masterUrl = res.masterUrl;
  } catch (err) {
    st.probe = { busy: false, result: { ok: false, masterUrl: st.masterUrl, error: String((err as Error)?.message ?? err) } };
  }
  props.requestUpdate();
}

async function saveSatellite(props: LocalSetupProps, st: State): Promise<boolean> {
  st.satelliteSave = { busy: true, error: null, ok: null };
  props.requestUpdate();
  try {
    const res = await props.send<{ ok: boolean; error?: string }>("setup.satellite.save", {
      masterUrl: st.masterUrl,
      invite: st.invite.trim() || undefined,
      nodeName: st.nodeName,
      share: st.share,
    });
    if (!res.ok) {
      st.satelliteSave = { busy: false, error: res.error ?? "Saving failed.", ok: null };
      props.requestUpdate();
      return false;
    }
    st.satelliteSaved = true;
    st.satelliteSave = { busy: false, error: null, ok: "saved" };
    return true;
  } catch (err) {
    st.satelliteSave = { busy: false, error: String((err as Error)?.message ?? err), ok: null };
    props.requestUpdate();
    return false;
  }
}

async function chooseMode(props: LocalSetupProps, st: State, mode: InstallMode): Promise<void> {
  if (st.mode === mode) return;
  if (st.mode === "satellite" && st.satelliteSaved) {
    // Leaving satellite mode: this machine is its own InfiniBot again.
    try {
      await props.send("setup.satellite.clear");
      st.satelliteSaved = false;
    } catch {
      /* the finish step re-checks */
    }
  }
  st.mode = mode;
  persist(props, st);
  props.requestUpdate();
}

async function finish(props: LocalSetupProps, st: State): Promise<void> {
  if (st.finishing) return;
  st.finishing = true;
  st.finishError = null;
  props.requestUpdate();
  try {
    if (st.mode === "satellite" && !(await saveSatellite(props, st))) {
      st.finishError = st.satelliteSave.error;
      st.finishing = false;
      props.requestUpdate();
      return;
    }
    const res = await props.send<{ gatewayPort: number; mirrored: string[] | null; mirrorError: string | null }>(
      "setup.finalize",
      { mode: st.mode },
    );
    st.finished = res;
    clearLocalResume(props.storage);
  } catch (err) {
    st.finishError = String((err as Error)?.message ?? err);
  }
  st.finishing = false;
  props.requestUpdate();
}

async function closeSetup(props: LocalSetupProps, st: State): Promise<void> {
  try {
    await props.send("exit");
  } catch {
    /* the server is already gone */
  }
  st.closed = true;
  props.requestUpdate();
}

// ── Pieces ──────────────────────────────────────────────────────────────────

function header(st: State, key: LocalStepKey, title: TemplateResult | string, sub: TemplateResult | string) {
  return renderStepHeader(stepsForMode(st.mode), key, title, sub);
}

function alert(message: string | null, testid: string): TemplateResult | typeof nothing {
  return message
    ? html`<div class="sob-alert" role="alert" data-testid=${testid}>${icon("alertCircle")}<span>${message}</span></div>`
    : nothing;
}

function option(o: {
  selected: boolean;
  glyph: TemplateResult;
  title: string;
  desc: string;
  testid: string;
  onClick: () => void;
  role?: "radio" | "checkbox";
}): TemplateResult {
  return html`<button
    type="button"
    role=${o.role ?? "radio"}
    aria-checked=${o.selected}
    data-testid=${o.testid}
    class="sob-opt ${o.selected ? "is-selected" : ""} ${o.role === "checkbox" ? "lsw-check" : ""}"
    @click=${o.onClick}
  >
    <span class="sob-opt__icon">${o.glyph}</span>
    <span class="sob-opt__title">${o.title}</span>
    <span class="sob-opt__desc">${o.desc}</span>
    <span class="sob-opt__radio">${o.role === "checkbox" && o.selected ? icon("check") : nothing}</span>
  </button>`;
}

// ── Steps ───────────────────────────────────────────────────────────────────

function renderMode(props: LocalSetupProps, st: State): TemplateResult {
  return html`
    ${header(
      st,
      "mode",
      "How will this install run?",
      "Pick one. You can switch later by running the setup again.",
    )}
    <div class="sob-options lsw-modes" role="radiogroup" aria-label="Install mode">
      ${option({
        selected: st.mode === "standalone",
        glyph: icon("monitor"),
        title: "Standalone",
        desc: "This machine is its own InfiniBot. Bring a model key, add channels and voice.",
        testid: "ls-mode-standalone",
        onClick: () => void chooseMode(props, st, "standalone"),
      })}
      ${option({
        selected: st.mode === "satellite",
        glyph: icon("network"),
        title: "Satellite",
        desc: "Join an InfiniBot you already run. It supplies the models; this machine adds its terminals, coders and compute.",
        testid: "ls-mode-satellite",
        onClick: () => void chooseMode(props, st, "satellite"),
      })}
    </div>
    <a class="lsw-cloud" data-testid="ls-cloud" href=${st.status.cloudUrl} target="_blank" rel="noopener noreferrer">
      <span class="lsw-cloud__icon">${icon("globe")}</span>
      <span class="lsw-cloud__text"
        ><strong>Use InfiniBot Cloud instead</strong><span>Hosted for you. Nothing to install or keep running.</span></span
      >
      ${icon("externalLink")}
    </a>
  `;
}

function renderProviderTile(props: LocalSetupProps, st: State, p: SetupProvider, index: number): TemplateResult {
  const { title, sub } = splitProviderLabel(p.label);
  const detail = sub ?? (p.kind === "local" ? "On this machine" : "Model API");
  return html`<button
    type="button"
    role="radio"
    aria-checked=${st.selected === p.id}
    aria-label=${`${p.label}, ${p.configured ? "connected" : "not connected"}`}
    title=${p.label}
    data-testid=${`ls-provider-${p.id}`}
    class="sob-prov ${st.selected === p.id ? "is-selected" : ""} ${p.configured ? "is-linked" : ""}"
    @click=${() => {
      st.selected = p.id;
      st.keyDraft = "";
      st.save = idle();
      props.requestUpdate();
    }}
  >
    <span class="sob-prov__mark" aria-hidden="true"
      ><span class="sob-prov__z">${String(index + 1).padStart(2, "0")}</span>${providerMark(p)}</span
    >
    <span class="sob-prov__text">
      <span class="sob-prov__name">${title}</span>
      <span class="sob-prov__status">
        ${p.configured ? html`Connected<span class="sob-prov__mask">${p.maskedKey ?? ""}</span>` : detail}
      </span>
    </span>
    <span class="sob-led ${p.configured ? "is-on" : ""}"></span>
  </button>`;
}

function renderKeys(props: LocalSetupProps, st: State): TemplateResult {
  const providers = st.status.providers;
  const sel = providers.find((p) => p.id === st.selected) ?? null;
  const q = st.filter.trim().toLowerCase();
  const indexed = providers.map((p, i) => ({ p, i }));
  const shown = q ? indexed.filter(({ p }) => `${p.label} ${p.id}`.toLowerCase().includes(q)) : indexed;
  const linked = providers.filter((p) => p.configured).length;
  const selTitle = sel ? splitProviderLabel(sel.label).title : "";
  const local = sel?.kind === "local";
  return html`
    ${header(
      st,
      "keys",
      "Connect a model provider",
      html`InfiniBot runs on <strong>your own</strong> API key. We check it with the provider before saving. It's
        stored only in this machine's config and sent only to that provider.`,
    )}
    <div class="sob-provbar">
      <span class="sob-provbar__count" data-testid="ls-prov-count"
        ><span class="sob-provbar__num">${providers.length}</span> providers<span class="sob-dot"></span
        ><span class="sob-provbar__num ${linked ? "is-on" : ""}">${linked}</span> linked</span
      >
      <label class="sob-filter">
        <span class="sob-filter__icon">${icon("search")}</span>
        <input
          class="sob-filter__input"
          type="search"
          placeholder="Filter providers"
          autocomplete="off"
          spellcheck="false"
          aria-label="Filter providers"
          .value=${st.filter}
          @input=${(e: Event) => {
            st.filter = (e.target as HTMLInputElement).value;
            props.requestUpdate();
          }}
        />
      </label>
    </div>
    <div class="sob-provscroll">
      <div class="sob-providers" role="radiogroup" aria-label="Model provider">
        ${shown.map(({ p, i }) => renderProviderTile(props, st, p, i))}
      </div>
      ${shown.length === 0
        ? html`<div class="sob-provempty">No provider matches <code>${st.filter.trim()}</code>.</div>`
        : nothing}
    </div>
    ${sel
      ? sel.configured
        ? html`<div class="sob-unlock" data-testid="ls-key-ok">
            <span class="sob-unlock__icon">${lockIcon(true)}</span>
            <span class="sob-unlock__text">
              <span class="sob-unlock__title"><strong>${selTitle}</strong> is connected</span>
              <span class="sob-unlock__meta"
                ><span>${sel.maskedKey}</span>${st.save.ok ? html`<span class="sob-dot"></span><span>${st.save.ok}</span>` : nothing}</span
              >
            </span>
            <button type="button" class="sob-link" @click=${() => void removeKey(props, st, sel.id)}>
              ${local ? "Remove" : "Replace key"}
            </button>
          </div>`
        : html`<div class="sob-field sob-field--key">
            <label class="sob-label" for="ls-key">${local ? "Ollama address" : `${selTitle} API key`}</label>
            <div class="sob-keyrow">
              <div class="sob-input-wrap ${st.save.busy ? "is-scanning" : ""}">
                <span class="sob-input-wrap__icon">${icon(local ? "server" : "key")}</span>
                <input
                  id="ls-key"
                  class="sob-input sob-input--mono"
                  type=${local ? "text" : "password"}
                  autocomplete="off"
                  spellcheck="false"
                  data-testid="ls-key"
                  placeholder=${sel.keyHint}
                  .value=${st.keyDraft}
                  @input=${(e: Event) => {
                    st.keyDraft = (e.target as HTMLInputElement).value;
                    props.requestUpdate();
                  }}
                  @keydown=${(e: KeyboardEvent) => {
                    if (e.key === "Enter") void saveKey(props, st);
                  }}
                />
                <span class="sob-input-wrap__scan"></span>
              </div>
              <button
                type="button"
                class="sob-btn sob-btn--primary"
                data-testid="ls-save-key"
                aria-busy=${st.save.busy ? "true" : "false"}
                ?disabled=${(!local && !st.keyDraft.trim()) || st.save.busy}
                @click=${() => void saveKey(props, st)}
              >
                ${st.save.busy
                  ? html`<span class="sob-spinner"></span>Checking…`
                  : html`${lockIcon(false)}${local ? "Check & use" : "Verify & save"}`}
              </button>
            </div>
            <span class="sob-hint">
              ${local
                ? html`Runs open models on this machine, no key. Leave blank for <code>http://localhost:11434</code>.
                    <a href=${sel.signupUrl} target="_blank" rel="noopener noreferrer">Get Ollama</a>.`
                : sel.signupUrl
                  ? html`Don't have one?
                      <a href=${sel.signupUrl} target="_blank" rel="noopener noreferrer">Create a key at ${selTitle}</a>.`
                  : nothing}
            </span>
          </div>`
      : nothing}
    ${alert(st.save.error, "ls-key-error")}
  `;
}

function renderChannels(props: LocalSetupProps, st: State): TemplateResult {
  const channels = st.status.channels;
  const sel = channels.find((c) => c.id === st.channel) ?? null;
  return html`
    ${header(
      st,
      "channels",
      html`Channels <span class="sob-tag">Optional</span>`,
      "Chat with your assistant from Telegram, Discord or Slack. Each token is checked with the platform before it's saved. Skip this and add channels any time.",
    )}
    <div class="sob-providers lsw-channels" role="radiogroup" aria-label="Channel">
      ${channels.map(
        (c, i) => html`<button
          type="button"
          role="radio"
          aria-checked=${st.channel === c.id}
          data-testid=${`ls-channel-${c.id}`}
          class="sob-prov ${st.channel === c.id ? "is-selected" : ""} ${c.configured ? "is-linked" : ""}"
          @click=${() => {
            st.channel = c.id;
            st.channelSave = idle();
            props.requestUpdate();
          }}
        >
          <span class="sob-prov__mark" aria-hidden="true"
            ><span class="sob-prov__z">${String(i + 1).padStart(2, "0")}</span>${providerMark(c)}</span
          >
          <span class="sob-prov__text">
            <span class="sob-prov__name">${c.label}</span>
            <span class="sob-prov__status"
              >${c.configured ? html`Connected${st.channelAccounts[c.id] ? html`<span class="sob-prov__mask">@${st.channelAccounts[c.id]}</span>` : nothing}` : "Bot token"}</span
            >
          </span>
          <span class="sob-led ${c.configured ? "is-on" : ""}"></span>
        </button>`,
      )}
    </div>
    ${sel
      ? sel.configured
        ? html`<div class="sob-unlock" data-testid="ls-channel-ok">
            <span class="sob-unlock__icon">${lockIcon(true)}</span>
            <span class="sob-unlock__text">
              <span class="sob-unlock__title"><strong>${sel.label}</strong> is connected</span>
              <span class="sob-unlock__meta">${st.channelSave.ok ?? "starts with the gateway"}</span>
            </span>
            <button type="button" class="sob-link" @click=${() => void removeChannel(props, st, sel.id)}>Disconnect</button>
          </div>`
        : html`<div class="lsw-fields">
            <p class="sob-hint lsw-blurb">${sel.blurb}</p>
            ${sel.fields.map(
              (f) => html`<label class="sob-field">
                <span class="sob-label">${f.label}</span>
                <div class="sob-input-wrap ${st.channelSave.busy ? "is-scanning" : ""}">
                  <span class="sob-input-wrap__icon">${icon("key")}</span>
                  <input
                    class="sob-input sob-input--mono"
                    type="password"
                    autocomplete="off"
                    spellcheck="false"
                    data-testid=${`ls-channel-${sel.id}-${f.id}`}
                    placeholder=${f.hint}
                    .value=${st.channelDrafts[`${sel.id}.${f.id}`] ?? ""}
                    @input=${(e: Event) => {
                      st.channelDrafts[`${sel.id}.${f.id}`] = (e.target as HTMLInputElement).value;
                      props.requestUpdate();
                    }}
                  />
                  <span class="sob-input-wrap__scan"></span>
                </div>
              </label>`,
            )}
            <div class="lsw-row">
              ${sel.signupUrl
                ? html`<span class="sob-hint"
                    >Need a bot? <a href=${sel.signupUrl} target="_blank" rel="noopener noreferrer">Create one</a>.</span
                  >`
                : html`<span></span>`}
              <button
                type="button"
                class="sob-btn sob-btn--primary"
                data-testid="ls-channel-save"
                aria-busy=${st.channelSave.busy ? "true" : "false"}
                ?disabled=${st.channelSave.busy || sel.fields.some((f) => !(st.channelDrafts[`${sel.id}.${f.id}`] ?? "").trim())}
                @click=${() => void saveChannel(props, st, sel)}
              >
                ${st.channelSave.busy ? html`<span class="sob-spinner"></span>Checking…` : html`${lockIcon(false)}Verify & connect`}
              </button>
            </div>
          </div>`
      : nothing}
    ${alert(st.channelSave.error, "ls-channel-error")}
  `;
}

function renderVoice(_props: LocalSetupProps, st: State): TemplateResult {
  const linked = st.status.robovoice.linked;
  return html`
    ${header(
      st,
      "voice",
      html`Voice <span class="sob-tag">Optional</span>`,
      "Voice runs on Robovoice. Link this install to your Robovoice org and your agents answer calls with Robovoice characters. Skip it and connect any time.",
    )}
    ${linked
      ? html`<div class="sob-unlock" data-testid="ls-voice-linked">
          <span class="sob-unlock__icon">${lockIcon(true)}</span>
          <span class="sob-unlock__text">
            <span class="sob-unlock__title"><strong>Robovoice</strong> is linked</span>
            <span class="sob-unlock__meta">Voice is ready when the gateway starts</span>
          </span>
        </div>`
      : html`<div class="sob-hosted lsw-voice" data-testid="ls-voice">
          <div class="sob-hosted__head">${icon("volumeUp")}<span>Connect Robovoice</span></div>
          <ol class="lsw-steps">
            <li>Run <code>infinibot robovoice login</code> in a terminal and approve the device code, or</li>
            <li>after setup, open the Voice page in InfiniBot and link Robovoice there.</li>
          </ol>
          <p class="sob-hint"><code>infinibot robovoice status</code> shows the linked org, location and credits.</p>
        </div>`}
  `;
}

function renderMaster(props: LocalSetupProps, st: State): TemplateResult {
  return html`
    ${header(
      st,
      "master",
      "Find your master",
      "The master is the InfiniBot you already run. This machine connects to it and adds its own terminals, coders and compute to it.",
    )}
    <label class="sob-field">
      <span class="sob-label">Master address</span>
      <div class="sob-input-wrap">
        <span class="sob-input-wrap__icon">${icon("server")}</span>
        <input
          class="sob-input sob-input--mono"
          data-testid="ls-master-url"
          placeholder="192.168.1.20:18789  or  ws://studio.local:18789"
          autocomplete="off"
          spellcheck="false"
          .value=${st.masterUrl}
          @input=${(e: Event) => {
            st.masterUrl = (e.target as HTMLInputElement).value;
            st.probe = { busy: false, result: null };
            props.requestUpdate();
          }}
        />
      </div>
      <span class="sob-hint">The master's gateway address and port (18789 unless you changed it). An invite fills this in for you.</span>
    </label>
    <div class="lsw-discover">
      <button
        type="button"
        class="sob-btn sob-btn--ghost"
        data-testid="ls-discover"
        aria-busy=${st.discover.busy ? "true" : "false"}
        ?disabled=${st.discover.busy}
        @click=${() => void discover(props, st)}
      >
        ${st.discover.busy ? html`<span class="sob-spinner"></span>Scanning…` : html`${icon("search")}Scan network`}
      </button>
      <span class="sob-hint">Looks on your LAN (mDNS) and your Tailscale network.</span>
    </div>
    ${st.discover.ran
      ? st.discover.found.length
        ? html`<div class="sob-providers lsw-found" role="radiogroup" aria-label="Masters found">
            ${st.discover.found.map(
              (m) => html`<button
                type="button"
                role="radio"
                aria-checked=${st.masterUrl === m.url}
                class="sob-prov ${st.masterUrl === m.url ? "is-selected" : ""}"
                @click=${() => {
                  st.masterUrl = m.url;
                  props.requestUpdate();
                }}
              >
                <span class="sob-prov__mark" aria-hidden="true">${m.source === "tailscale" ? "Ts" : "Ln"}</span>
                <span class="sob-prov__text">
                  <span class="sob-prov__name">${m.name}</span>
                  <span class="sob-prov__status">${m.url}</span>
                </span>
                <span class="sob-led is-on"></span>
              </button>`,
            )}
          </div>`
        : html`<p class="sob-hint" data-testid="ls-discover-none">
            No master answered on this network. Enter its address, or paste an invite in the next step.
          </p>`
      : nothing}
  `;
}

function renderProbe(st: State): TemplateResult | typeof nothing {
  const r = st.probe.result;
  if (!r) return nothing;
  if (r.ok) {
    return html`<div class="sob-unlock" data-testid="ls-link-ok">
      <span class="sob-unlock__icon">${lockIcon(true)}</span>
      <span class="sob-unlock__text">
        <span class="sob-unlock__title"><strong>Linked</strong> to ${r.masterUrl}</span>
        <span class="sob-unlock__meta"
          >${r.latencyMs ?? "?"} ms${r.permission ? html`<span class="sob-dot"></span>${r.permission} access` : nothing}</span
        >
      </span>
    </div>`;
  }
  return html`<div class="sob-alert" role="alert" data-testid="ls-link-error">
    ${icon("alertCircle")}<span
      >${r.error}${r.tried && r.tried.length > 1 ? html`<br /><small>Tried: ${r.tried.join(", ")}</small>` : nothing}</span
    >
  </div>`;
}

function renderPair(props: LocalSetupProps, st: State): TemplateResult {
  const info = st.inviteInfo;
  return html`
    ${header(
      st,
      "pair",
      "Pair with the master",
      html`On the master, open <strong>Federation</strong> and choose <strong>Invite a node</strong> (or run
        <code>infinibot federation invite</code> there), then paste the invite here. We test the link exactly as the
        satellite will make it.`,
    )}
    <label class="sob-field">
      <span class="sob-label">Invite</span>
      <textarea
        class="sob-input sob-input--mono lsw-invite"
        data-testid="ls-invite"
        rows="3"
        spellcheck="false"
        placeholder="Paste the invite code from your master"
        .value=${st.invite}
        @input=${(e: Event) => {
          st.invite = (e.target as HTMLTextAreaElement).value;
          props.requestUpdate();
        }}
        @change=${() => void readInvite(props, st)}
        @blur=${() => void readInvite(props, st)}
      ></textarea>
    </label>
    ${info?.ok
      ? html`<p class="sob-hint" data-testid="ls-invite-info">
          Invite for <strong>${info.hubName ?? "your master"}</strong>${info.permission ? html` · ${info.permission} access` : nothing}${info.expiresAt
            ? html` · expires ${new Date(info.expiresAt).toLocaleString()}`
            : nothing}
        </p>`
      : info && !info.ok
        ? alert(info.error ?? "This invite can't be read.", "ls-invite-error")
        : nothing}
    <label class="sob-field">
      <span class="sob-label">This machine's name</span>
      <input
        class="sob-input"
        data-testid="ls-node-name"
        maxlength="48"
        .value=${st.nodeName}
        @input=${(e: Event) => {
          st.nodeName = (e.target as HTMLInputElement).value;
          props.requestUpdate();
        }}
      />
      <span class="sob-hint">How it shows up in the master's node list.</span>
    </label>
    <div class="lsw-row">
      <span class="sob-hint">${st.masterUrl ? html`Master: <code>${st.masterUrl}</code>` : "The invite carries the master's address."}</span>
      <button
        type="button"
        class="sob-btn sob-btn--primary"
        data-testid="ls-test-link"
        aria-busy=${st.probe.busy ? "true" : "false"}
        ?disabled=${st.probe.busy || (!st.invite.trim() && !st.masterUrl.trim())}
        @click=${() => void testLink(props, st)}
      >
        ${st.probe.busy ? html`<span class="sob-spinner"></span>Testing…` : html`${icon("activity")}Test connection`}
      </button>
    </div>
    ${renderProbe(st)}
  `;
}

const SHARE_COPY: Array<{ key: keyof ShareState; title: string; desc: string; glyph: () => TemplateResult }> = [
  { key: "terminals", title: "Terminals", desc: "The master can open shells on this machine.", glyph: () => icon("terminal") },
  { key: "coders", title: "Coder CLIs", desc: "Claude Code, Codex and OpenCode installed here can be spawned from the master.", glyph: () => icon("fileCode") },
  { key: "agents", title: "Agent runs", desc: "The master can run agent sessions and chats on this machine.", glyph: () => icon("bot") },
  { key: "compute", title: "Local compute", desc: "Advertise local models and GPU (Ollama, ComfyUI) for the master to use.", glyph: () => icon("zap") },
];

function renderShare(props: LocalSetupProps, st: State): TemplateResult {
  return html`
    ${header(
      st,
      "share",
      "What this satellite shares",
      "The master only gets what you switch on. Anything off is refused on this machine, whatever the master asks.",
    )}
    <div class="sob-options lsw-share" role="group" aria-label="Shared with the master">
      ${SHARE_COPY.map((c) =>
        option({
          role: "checkbox",
          selected: st.share[c.key],
          glyph: c.glyph(),
          title: c.title,
          desc: c.desc,
          testid: `ls-share-${c.key}`,
          onClick: () => {
            st.share = { ...st.share, [c.key]: !st.share[c.key] };
            props.requestUpdate();
          },
        }),
      )}
    </div>
    <p class="sob-hint">Models come from the master: this machine needs no API key of its own.</p>
    ${alert(st.satelliteSave.error, "ls-share-error")}
  `;
}

function commandBox(st: State, props: LocalSetupProps, cmd: string): TemplateResult {
  return html`<div class="lsw-cmd" data-testid="ls-next-command">
    <code>${cmd}</code>
    <button
      type="button"
      class="sob-link"
      @click=${async () => {
        try {
          await navigator.clipboard.writeText(cmd);
          st.copied = true;
        } catch {
          st.copied = false;
        }
        props.requestUpdate();
      }}
    >
      ${st.copied ? "Copied" : "Copy"}
    </button>
  </div>`;
}

function renderFinish(props: LocalSetupProps, st: State): TemplateResult {
  const sat = st.mode === "satellite";
  if (st.finished) {
    const port = st.finished.gatewayPort;
    return html`
      <div class="sob-done" data-testid="ls-done">
        <div class="sob-done__emblem">
          <span class="sob-done__wave"></span>
          <span class="sob-done__wave sob-done__wave--late"></span>
          <span class="lsw-emblem">${renderBrandMark(96)}</span>
        </div>
        <div class="sob-eyebrow sob-eyebrow--center">
          <span class="sob-eyebrow__rule"></span><span>${sat ? "Satellite paired" : "Setup complete"}</span
          ><span class="sob-eyebrow__rule"></span>
        </div>
        <h2 class="sob-title sob-title--hero">${sat ? "Ready to join your master" : "InfiniBot is ready"}</h2>
        <p class="sob-sub">
          ${st.closed
            ? "Setup is closed. You can close this tab."
            : sat
              ? "Start the gateway and this machine connects to the master and shows up in its node list."
              : html`Start the gateway, then open <code>http://localhost:${port}/</code>.`}
        </p>
        ${commandBox(st, props, "infinibot gateway run")}
        ${sat && st.finished.mirrored
          ? html`<p class="sob-hint">Mirrored from the master: ${st.finished.mirrored.join(", ") || "nothing yet"}.</p>`
          : sat && st.finished.mirrorError
            ? html`<p class="sob-hint" data-testid="ls-mirror-note">
                The master's shared settings will sync when the gateway connects (${st.finished.mirrorError}).
              </p>`
            : nothing}
        ${st.closed
          ? nothing
          : html`<button
              type="button"
              class="sob-btn sob-btn--primary sob-btn--xl"
              data-testid="ls-close"
              @click=${() => void closeSetup(props, st)}
            >
              ${lockIcon(true)}Close setup
            </button>`}
      </div>
    `;
  }
  const row = (label: string, value: TemplateResult | string) =>
    html`<div class="sob-manifest__row"><dt>${label}</dt><span class="sob-manifest__lead"></span><dd>${value}</dd></div>`;
  const connected = st.status.providers.filter((p) => p.configured).map((p) => splitProviderLabel(p.label).title);
  const channels = st.status.channels.filter((c) => c.configured).map((c) => c.label);
  const shared = SHARE_COPY.filter((c) => st.share[c.key]).map((c) => c.title);
  return html`
    ${header(
      st,
      "finish",
      "Review & finish",
      sat
        ? "We'll write the satellite settings, then pull the master's shared settings (models, MCP, voice)."
        : "We'll write your settings and pick sensible defaults for the gateway. You can change everything later.",
    )}
    <dl class="sob-manifest" data-testid="ls-manifest">
      ${row("Install", sat ? "Satellite" : "Standalone")}
      ${sat
        ? html`${row("Master", html`<code>${st.masterUrl || "—"}</code>`)} ${row("Node name", st.nodeName || st.status.hostname)}
          ${row("Shares", shared.join(", ") || "Nothing")} ${row("Models", "Supplied by the master")}`
        : html`${row("Models", connected.join(", ") || "—")}
          ${row("Default", html`<code>${st.status.primaryModel ?? "—"}</code>`)} ${row("Channels", channels.join(", ") || "None yet")}
          ${row("Voice", st.status.robovoice.linked ? "Robovoice linked" : "Not linked (optional)")}`}
      ${row("Runs on", st.status.platform === "win32" ? "Windows" : st.status.platform === "darwin" ? "macOS" : st.status.platform === "linux" ? "Linux" : st.status.platform)}
    </dl>
    ${alert(st.finishError, "ls-finish-error")}
  `;
}

const STEP_RENDERERS: Record<LocalStepKey, (props: LocalSetupProps, st: State) => TemplateResult> = {
  mode: renderMode,
  keys: renderKeys,
  channels: renderChannels,
  voice: renderVoice,
  master: renderMaster,
  pair: renderPair,
  share: renderShare,
  finish: renderFinish,
};

// ── Shell ───────────────────────────────────────────────────────────────────

export function renderLocalSetup(props: LocalSetupProps): TemplateResult {
  if (!s) s = init(props);
  const st = s;
  const steps = stepsForMode(st.mode);
  st.step = Math.min(st.step, steps.length - 1);
  const key = steps[st.step].key;
  const g = gate(st);
  const canNext = canContinue(key, g) && !st.advancing;
  const go = async (n: number) => {
    const next = Math.max(0, Math.min(steps.length - 1, n));
    if (next === st.step || st.advancing) return;
    if (next > st.step && !canContinue(key, g)) return;
    if (key === "share" && next > st.step) {
      // Shares are written on the way out, so they stick even if setup stops here.
      st.advancing = true;
      props.requestUpdate();
      const ok = await saveSatellite(props, st);
      st.advancing = false;
      if (!ok) return;
    }
    st.step = next;
    st.copied = false;
    persist(props, st);
    props.requestUpdate();
  };
  const sat = st.mode === "satellite";
  const primary =
    st.step < steps.length - 1
      ? html`<button
          type="button"
          class="sob-btn sob-btn--primary"
          data-testid="ls-next"
          aria-busy=${st.advancing ? "true" : "false"}
          ?disabled=${!canNext}
          @click=${() => void go(st.step + 1)}
        >
          ${st.advancing ? html`<span class="sob-spinner"></span>Saving…` : html`Continue${icon("arrowRight")}`}
        </button>`
      : html`<button
          type="button"
          class="sob-btn sob-btn--primary"
          data-testid="ls-finish"
          aria-busy=${st.finishing ? "true" : "false"}
          ?disabled=${st.finishing || !canFinish(g)}
          @click=${() => void finish(props, st)}
        >
          ${st.finishing ? html`<span class="sob-spinner"></span>Finishing…` : html`${lockIcon(false)}Finish setup`}
        </button>`;
  return renderConsoleShell({
    steps,
    step: st.step,
    finished: Boolean(st.finished),
    canNext,
    onGo: (i) => void go(i),
    hero: {
      eyebrow: sat ? "Satellite setup" : "Local setup",
      title: "Welcome to InfiniBot",
      sub: sat
        ? "Join the InfiniBot you already run. No model keys needed on this machine."
        : "Five short steps. Only one model key is required.",
    },
    barPath: sat ? "/ satellite-link" : "/ local-init",
    barStatus: html`<span class="sob-bar__link"><span class="sob-led is-on"></span>${sat ? "Satellite" : "Standalone"}</span>`,
    body: STEP_RENDERERS[key](props, st),
    footer: renderConsoleFooter({
      canBack: st.step > 0 && !st.advancing,
      onBack: () => void go(st.step - 1),
      note: blockedNote(key, g),
      primary,
    }),
    testid: "local-setup",
    extraStyles: localSetupStyles(),
  });
}

/** Drop module state (tests). */
export function resetLocalSetup(): void {
  s = null;
}

/** The few pieces the hosted quickstart doesn't have, in the same `.sob` language. */
function localSetupStyles(): TemplateResult {
  return html`<style>
    .lsw-modes { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .lsw-share { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .lsw-check .sob-opt__radio { display: grid; place-items: center; border-radius: 6px; }
    .lsw-check .sob-opt__radio svg { width: 12px; height: 12px; }
    .lsw-cloud {
      display: flex; align-items: center; gap: 14px; margin-top: 18px; padding: 14px 16px;
      border-radius: 14px; border: 1px dashed var(--sob-line-2); color: var(--sob-fg-2); text-decoration: none;
      transition: border-color 0.2s, background 0.2s, color 0.2s;
    }
    .lsw-cloud:hover, .lsw-cloud:focus-visible { border-color: var(--sob-gold); color: var(--sob-fg); background: color-mix(in srgb, var(--sob-gold) 6%, transparent); }
    .lsw-cloud__icon { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 10px; border: 1px solid var(--sob-line-2); color: var(--sob-gold); flex: none; }
    .lsw-cloud__text { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
    .lsw-cloud__text strong { color: var(--sob-fg); font-weight: 600; }
    .lsw-cloud__text span { font-size: 13px; }
    .lsw-cloud svg { width: 16px; height: 16px; flex: none; }
    .lsw-channels { grid-template-columns: repeat(3, minmax(0, 1fr)); margin-bottom: 18px; }
    .lsw-fields { display: flex; flex-direction: column; gap: 14px; }
    .lsw-blurb { margin: 0; }
    .lsw-row { display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; margin-top: 4px; }
    .lsw-steps { margin: 4px 0 10px 18px; padding: 0; color: var(--sob-fg-2); line-height: 1.8; }
    .lsw-discover { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin: 16px 0; }
    .lsw-found { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .lsw-invite { min-height: 84px; resize: vertical; font-size: 12.5px; line-height: 1.5; word-break: break-all; padding-top: 12px; }
    .sob-field + .sob-field, .sob-field + .lsw-row, .sob-hint + .sob-field { margin-top: 14px; }
    .lsw-cmd {
      display: flex; align-items: center; gap: 14px; margin: 6px auto 18px; padding: 12px 16px; max-width: 420px; width: 100%;
      box-sizing: border-box; min-width: 0;
      border-radius: 12px; border: 1px solid var(--sob-line-2); background: rgba(0, 0, 0, 0.35);
      font-family: var(--sob-mono); font-size: 14px; color: var(--sob-gold);
    }
    .lsw-cmd code { flex: 1; min-width: 0; text-align: left; overflow-wrap: anywhere; }
    .lsw-emblem { position: relative; display: grid; place-items: center; width: 128px; height: 128px; }
    .lsw-emblem .sob-mark { filter: drop-shadow(0 10px 30px color-mix(in srgb, var(--sob-gold) 45%, transparent)); }
    @media (max-width: 720px) {
      .lsw-modes, .lsw-share, .lsw-found { grid-template-columns: 1fr; }
      .lsw-channels { grid-template-columns: 1fr; }
      .lsw-row .sob-btn { width: 100%; }
    }
  </style>`;
}
