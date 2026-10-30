/**
 * Profiles Manager — in-app management page for the password-free
 * multi-user profile registry (the same profiles the start-up gate uses).
 *
 * Distinct from the /users page (which manages the password-auth UserStore).
 * Here you view, add, rename, re-avatar, re-theme, switch between, and
 * delete local-device profiles. Each profile points the gateway data layer
 * at a separate per-user data directory; switching reloads the page so a
 * fresh connection re-resolves every store under the chosen profile.
 *
 * Self-contained module state (mirrors profile-gate.ts) so we don't have to
 * thread anything through AppViewState. Re-renders go through the host's
 * requestUpdate hook.
 */

import { html, nothing } from "lit";
import {
  ensureSystemGlass,
  sgAurora,
  sgEmpty,
  sgGloss,
  sgHero,
  sgIcon,
  sgLed,
  sgSkeleton,
} from "./system-glass";
import type { GatewayBrowserClient } from "../gateway.js";
import {
  applyProfileAppearance,
  setLastPicked,
  markGatePassed,
  markGateUnpassed,
  setGateEnabled,
  isGateEnabled,
  type ProfileRecord,
  type SkillLevel,
} from "../profiles.js";

interface ProfilesHost {
  client: GatewayBrowserClient | null;
  requestUpdate?: () => void;
}

type ThemeOption = { id: string; label: string };
const THEME_OPTIONS: ThemeOption[] = [
  { id: "system", label: "System" },
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" },
  { id: "hud", label: "HUD" },
];

const QUICK_AVATARS = ["👤", "🧑‍💻", "👩‍🚀", "🦊", "🐉", "🤖", "👑", "🎯", "🚀", "🌙", "⚡", "🎨"];

interface EditForm {
  mode: "create" | "edit";
  id?: string;
  name: string;
  avatar: string;
  theme: string;
  // Operator context (Layer 1). Stored as plain strings in the form;
  // empty string clears the field server-side.
  role: string;
  goals: string;
  notes: string;
  preferredLanguage: string;
  secondaryLanguage: string;
  skillLevel: "" | SkillLevel;
  projectContext: string;
  communicationStyle: string;
}

const SKILL_OPTIONS: { id: "" | SkillLevel; label: string }[] = [
  { id: "", label: "— not set —" },
  { id: "beginner", label: "Beginner" },
  { id: "intermediate", label: "Intermediate" },
  { id: "advanced", label: "Advanced" },
];

/**
 * Client-side mirror of server `buildProfileContextBlock` (src/users/
 * profile-context.ts). Kept in lockstep so the operator sees EXACTLY what
 * gets injected into the AI surfaces. If you change one, change both.
 */
function buildContextPreview(f: EditForm): string {
  const trim = (s: string) => s.trim();
  const role = trim(f.role);
  const goals = trim(f.goals);
  const notes = trim(f.notes);
  const primary = trim(f.preferredLanguage);
  const secondary = trim(f.secondaryLanguage);
  const skillLevel = f.skillLevel;
  const projectContext = trim(f.projectContext);
  const communicationStyle = trim(f.communicationStyle);

  const hasAny =
    role || goals || notes || primary || secondary || skillLevel || projectContext || communicationStyle;
  if (!hasAny) return "";

  const indent = (v: string) =>
    v.split("\n").map((line) => `  ${line.replace(/\s+$/, "")}`).join("\n");

  const lines: string[] = ["USER CONTEXT"];
  const name = trim(f.name);
  if (name) lines.push(`Name: ${name}`);
  if (role) lines.push(`Role: ${role}`);
  if (primary || secondary) {
    const langs =
      primary && secondary
        ? `${primary} (primary) + ${secondary} (secondary)`
        : primary
          ? `${primary} (primary)`
          : `${secondary} (secondary)`;
    lines.push(`Languages: ${langs}`);
  }
  if (skillLevel) lines.push(`Skill level: ${skillLevel}`);
  if (goals) {
    lines.push("Goals:");
    lines.push(indent(goals));
  }
  if (projectContext) {
    lines.push("Current focus:");
    lines.push(indent(projectContext));
  }
  if (communicationStyle) lines.push(`Communication style: ${communicationStyle}`);
  if (notes) {
    lines.push("Operator notes:");
    lines.push(indent(notes));
  }
  return lines.join("\n");
}

interface ManagerData {
  loaded: boolean;
  loading: boolean;
  profiles: ProfileRecord[];
  currentUserId: string;
  error: string | null;
  busy: boolean;
  form: EditForm | null;
}

const data: ManagerData = {
  loaded: false,
  loading: false,
  profiles: [],
  currentUserId: "default",
  error: null,
  busy: false,
  form: null,
};

let _requestUpdate: (() => void) | undefined;

async function loadProfiles(client: GatewayBrowserClient): Promise<void> {
  if (data.loading) return;
  data.loading = true;
  try {
    const res = await client.call<{ profiles: ProfileRecord[]; currentUserId: string }>(
      "profiles.list",
    );
    data.profiles = res.profiles ?? [];
    data.currentUserId = res.currentUserId ?? "default";
    data.error = null;
  } catch (e) {
    data.error = String((e as Error)?.message ?? e);
  } finally {
    data.loaded = true;
    data.loading = false;
    _requestUpdate?.();
  }
}

function emptyContextFields() {
  return {
    role: "",
    goals: "",
    notes: "",
    preferredLanguage: "",
    secondaryLanguage: "",
    skillLevel: "" as "" | SkillLevel,
    projectContext: "",
    communicationStyle: "",
  };
}

function openCreate(): void {
  data.form = { mode: "create", name: "", avatar: "👤", theme: "system", ...emptyContextFields() };
  _requestUpdate?.();
}

function openEdit(p: ProfileRecord): void {
  data.form = {
    mode: "edit",
    id: p.id,
    name: p.name,
    avatar: p.avatar || "👤",
    theme: p.theme || "system",
    role: p.role ?? "",
    goals: p.goals ?? "",
    notes: p.notes ?? "",
    preferredLanguage: p.preferredLanguage ?? "",
    secondaryLanguage: p.secondaryLanguage ?? "",
    skillLevel: p.skillLevel ?? "",
    projectContext: p.projectContext ?? "",
    communicationStyle: p.communicationStyle ?? "",
  };
  _requestUpdate?.();
}

function closeForm(): void {
  data.form = null;
  _requestUpdate?.();
}

function patchForm(patch: Partial<EditForm>): void {
  if (!data.form) return;
  data.form = { ...data.form, ...patch };
  _requestUpdate?.();
}

/** The Layer-1 operator-context subset of the form, sent verbatim to update. */
function contextPatch(f: EditForm) {
  return {
    role: f.role.trim(),
    goals: f.goals.trim(),
    notes: f.notes.trim(),
    preferredLanguage: f.preferredLanguage.trim(),
    secondaryLanguage: f.secondaryLanguage.trim(),
    skillLevel: f.skillLevel,
    projectContext: f.projectContext.trim(),
    communicationStyle: f.communicationStyle.trim(),
  };
}

async function submitForm(client: GatewayBrowserClient): Promise<void> {
  const f = data.form;
  if (!f || !f.name.trim() || data.busy) return;
  data.busy = true;
  data.error = null;
  _requestUpdate?.();
  try {
    if (f.mode === "create") {
      // Create first (name/avatar/theme), then persist operator context via
      // update so a single round-trip path owns all the Layer-1 fields.
      const res = await client.call<{ profile?: ProfileRecord }>("profiles.create", {
        name: f.name.trim(),
        avatar: f.avatar,
        theme: f.theme,
      });
      const newId = res?.profile?.id;
      if (newId) await client.call("profiles.update", { id: newId, ...contextPatch(f) });
    } else if (f.id) {
      await client.call("profiles.update", {
        id: f.id,
        name: f.name.trim(),
        avatar: f.avatar,
        theme: f.theme,
        ...contextPatch(f),
      });
    }
    data.form = null;
    data.loaded = false;
    await loadProfiles(client);
  } catch (e) {
    data.error = String((e as Error)?.message ?? e);
  } finally {
    data.busy = false;
    _requestUpdate?.();
  }
}

async function removeProfile(client: GatewayBrowserClient, p: ProfileRecord): Promise<void> {
  if (p.id === "default" || data.busy) return;
  const ok = window.confirm(
    `Delete profile "${p.name}"? Its data folder is left on disk unless you remove it manually.`,
  );
  if (!ok) return;
  data.busy = true;
  data.error = null;
  _requestUpdate?.();
  try {
    await client.call("profiles.delete", { id: p.id });
    data.loaded = false;
    await loadProfiles(client);
  } catch (e) {
    data.error = String((e as Error)?.message ?? e);
  } finally {
    data.busy = false;
    _requestUpdate?.();
  }
}

async function switchTo(client: GatewayBrowserClient, p: ProfileRecord): Promise<void> {
  if (data.busy) return;
  data.busy = true;
  data.error = null;
  _requestUpdate?.();
  try {
    await client.call("profiles.switch", { id: p.id });
    applyProfileAppearance(p);
    setLastPicked(p.id);
    markGatePassed();
    location.reload();
  } catch (e) {
    data.error = String((e as Error)?.message ?? e);
    data.busy = false;
    _requestUpdate?.();
  }
}

/** Show the gate on the next page load (manual re-open). */
function showGateNow(): void {
  setGateEnabled(true);
  markGateUnpassed();
  location.reload();
}

function fmtDate(ts?: number): string {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return "—";
  }
}

function themeLabel(theme: string): string {
  return THEME_OPTIONS.find((t) => t.id === theme)?.label ?? (theme || "System");
}

export function renderProfilesManager<T extends ProfilesHost>(state: T, client: GatewayBrowserClient) {
  // Wrap rather than copy the method: the host is the app LitElement and an
  // unbound `requestUpdate` throws "Cannot read properties of undefined
  // (reading 'isUpdatePending')" when the async load resolves.
  _requestUpdate = () => state.requestUpdate?.();
  if (!data.loaded && !data.loading) void loadProfiles(client);

  ensureSystemGlass();
  injectStyles();
  const gateOn = isGateEnabled();
  const active = data.profiles.find((p) => p.id === data.currentUserId);
  const withContext = data.profiles.filter((p) => hasContext(p)).length;

  return html`
    <div class="sg-page sg-profiles pm-page">
      ${sgAurora()}
      ${sgHero({
        eyebrow: "Settings",
        title: "Profiles",
        accent: "& People",
        icon: "user",
        sub: "Password-free profiles — separate data & agent memory per person, shared services. Switching reloads the app under the chosen profile.",
        status: !data.loaded
          ? { tone: "info", label: "Loading" }
          : { tone: "ok", label: active ? `Active · ${active.name}` : "Ready" },
        actions: html`
          <button class="sg-btn pm-btn pm-btn-ghost" ?disabled=${data.busy} @click=${() => { data.loaded = false; void loadProfiles(client); }}>
            ${sgIcon("refresh", 15)} Refresh
          </button>
          <button class="sg-btn pm-btn pm-btn-ghost" ?disabled=${data.busy} @click=${showGateNow} title="Reopen the profile chooser">
            ${sgIcon("users", 15)} Open chooser
          </button>
          <button class="sg-btn sg-btn--primary pm-btn pm-btn-primary" ?disabled=${data.busy} @click=${openCreate}>
            ${sgIcon("plus", 15)} Add profile
          </button>
        `,
        stats: [
          { label: "Profiles", value: data.loaded ? data.profiles.length : "—", icon: "users", foot: "On this device" },
          { label: "Active", value: active?.name ?? "—", icon: "user", tone: active ? "gold" : undefined, foot: active ? themeLabel(active.theme) + " theme" : "No profile loaded" },
          { label: "With context", value: data.loaded ? withContext : "—", icon: "spark", foot: "Operator notes set" },
          { label: "Chooser", value: gateOn ? "On" : "Off", icon: "shield", tone: gateOn ? "ok" : undefined, foot: "Shown at start-up" },
        ],
      })}

      ${data.error ? html`<div class="pm-banner pm-banner-error" role="alert">${sgIcon("alert", 15)}<span>${data.error}</span></div>` : nothing}

      <label class="pm-toggle-row sg-panel">
        <span class="pm-toggle-ico">${sgIcon("users", 18)}</span>
        <span class="pm-toggle-copy">
          <strong>Profile chooser</strong>
          <span>Show the profile chooser on every fresh browser session</span>
        </span>
        <input
          type="checkbox"
          class="pm-switch"
          role="switch"
          .checked=${gateOn}
          @change=${(e: Event) => {
            setGateEnabled((e.target as HTMLInputElement).checked);
            state.requestUpdate?.();
          }}
        />
      </label>

      <div class="sg-section-head">Profiles <span class="sg-count">${data.loaded ? data.profiles.length : ""}</span></div>
      ${!data.loaded
        ? html`<div class="pm-empty">${sgSkeleton(3, true)}</div>`
        : data.profiles.length === 0
          ? html`<div class="pm-empty sg-panel">
              ${sgEmpty({
                icon: "user",
                title: "No profiles yet",
                body: "Add one per person who shares this computer — each gets its own chats, memory and settings while the gateway and models stay shared.",
                action: html`<button class="sg-btn sg-btn--primary" ?disabled=${data.busy} @click=${openCreate}>${sgIcon("plus", 15)} Add the first profile</button>`,
              })}
            </div>`
          : html`
              <div class="pm-grid">
                ${data.profiles.map((p) => renderCard(client, p))}
                <button class="pm-card pm-card--add" ?disabled=${data.busy} @click=${openCreate}>
                  <span class="pm-add-ico">${sgIcon("plus", 22)}</span>
                  <span class="pm-card-name">Add profile</span>
                  <span class="pm-add-sub">Separate data &amp; memory, shared services</span>
                </button>
              </div>
            `}

      ${data.form ? renderFormDialog(client) : nothing}
    </div>
  `;
}

function hasContext(p: ProfileRecord): boolean {
  return Boolean(
    p.role || p.goals || p.notes || p.preferredLanguage || p.secondaryLanguage || p.skillLevel || p.projectContext || p.communicationStyle,
  );
}

function renderCard(client: GatewayBrowserClient, p: ProfileRecord) {
  const isActive = p.id === data.currentUserId;
  const isDefault = p.id === "default";
  const langs = [p.preferredLanguage, p.secondaryLanguage].filter(Boolean).join(" + ");
  return html`
    <div class="pm-card sg-card sg-card--interactive ${isActive ? "pm-card--active" : ""}" @pointermove=${sgGloss}>
      <div class="pm-card-top">
        <span class="pm-avatar ${isActive ? "pm-avatar--active" : ""}"><span>${p.avatar || "👤"}</span></span>
        ${isActive
          ? html`<span class="pm-pill pm-pill-active sg-chip sg-chip--gold">${sgLed("ok")} Active</span>`
          : html`<span class="sg-chip">${sgLed("off")} Idle</span>`}
      </div>
      <div>
        <div class="pm-card-name">${p.name}</div>
        ${p.role ? html`<div class="pm-card-role">${p.role}</div>` : nothing}
      </div>
      <div class="pm-card-meta">
        <span class="pm-meta-row"><span class="pm-meta-k">Theme</span><span class="pm-meta-v">${themeLabel(p.theme)}</span></span>
        <span class="pm-meta-row"><span class="pm-meta-k">Created</span><span class="pm-meta-v">${fmtDate(p.createdAt)}</span></span>
        ${langs ? html`<span class="pm-meta-row"><span class="pm-meta-k">Languages</span><span class="pm-meta-v">${langs}</span></span>` : nothing}
        ${isDefault ? html`<span class="pm-meta-row"><span class="pm-meta-k">ID</span><span class="pm-meta-v sg-mono">default</span></span>` : nothing}
      </div>
      <div class="pm-card-chips">
        ${hasContext(p)
          ? html`<span class="sg-chip sg-chip--gold">${sgIcon("spark", 11)} Context set</span>`
          : html`<span class="sg-chip">No context</span>`}
        ${p.skillLevel ? html`<span class="sg-chip">${p.skillLevel}</span>` : nothing}
      </div>
      <div class="pm-card-actions">
        ${!isActive
          ? html`<button class="sg-btn sg-btn--primary sg-btn--sm pm-btn pm-btn-primary pm-btn-sm" ?disabled=${data.busy} @click=${() => switchTo(client, p)}>${sgIcon("arrowRight", 13)} Switch to</button>`
          : html`<button class="sg-btn sg-btn--sm pm-btn pm-btn-sm" disabled>${sgIcon("check", 13)} Current</button>`}
        <button class="sg-btn sg-btn--sm pm-btn pm-btn-sm" ?disabled=${data.busy} @click=${() => openEdit(p)}>${sgIcon("edit", 13)} Edit</button>
        ${!isDefault
          ? html`<button class="sg-btn sg-btn--danger sg-btn--sm sg-btn--icon pm-btn pm-btn-danger pm-btn-sm" title="Delete" aria-label="Delete ${p.name}" ?disabled=${data.busy} @click=${() => removeProfile(client, p)}>${sgIcon("trash", 14)}</button>`
          : nothing}
      </div>
    </div>
  `;
}

function renderFormDialog(client: GatewayBrowserClient) {
  const f = data.form!;
  return html`
    <div class="sg-backdrop pm-dialog-backdrop" @click=${closeForm}>
      <form class="sg-sheet pm-dialog" role="dialog" aria-modal="true" aria-label=${f.mode === "create" ? "Add profile" : "Edit profile"} @click=${(e: Event) => e.stopPropagation()} @submit=${(e: Event) => { e.preventDefault(); void submitForm(client); }}>
        <div class="pm-sheet-head">
          <span class="pm-avatar pm-avatar--lg"><span>${f.avatar || "👤"}</span></span>
          <div class="pm-sheet-title">
            <p class="sg-eyebrow">Profiles</p>
            <h3>${f.mode === "create" ? "Add profile" : "Edit profile"}</h3>
          </div>
          <button type="button" class="sg-btn sg-btn--ghost sg-btn--icon" aria-label="Close" @click=${closeForm}>${sgIcon("close", 16)}</button>
        </div>

        <label class="pm-field">
          <span>Name</span>
          <input
            class="sg-input"
            type="text"
            required
            autofocus
            placeholder="e.g. Alex"
            .value=${f.name}
            @input=${(e: Event) => patchForm({ name: (e.target as HTMLInputElement).value })}
          />
        </label>

        <div class="pm-field">
          <span>Avatar</span>
          <div class="pm-avatar-row">
            <input
              class="sg-input pm-avatar-input"
              type="text"
              maxlength="4"
              .value=${f.avatar}
              @input=${(e: Event) => patchForm({ avatar: (e.target as HTMLInputElement).value || "👤" })}
            />
            <div class="pm-avatar-picks">
              ${QUICK_AVATARS.map(
                (a) => html`<button
                  type="button"
                  class="pm-avatar-pick ${f.avatar === a ? "active" : ""}"
                  @click=${() => patchForm({ avatar: a })}
                >${a}</button>`,
              )}
            </div>
          </div>
        </div>

        <label class="pm-field">
          <span>Theme</span>
          <select class="sg-input" .value=${f.theme} @change=${(e: Event) => patchForm({ theme: (e.target as HTMLSelectElement).value })}>
            ${THEME_OPTIONS.map((t) => html`<option value=${t.id} ?selected=${t.id === f.theme}>${t.label}</option>`)}
          </select>
        </label>

        <div class="sg-section-head pm-section-divider">Operator context</div>
        <p class="pm-section-hint">
          Stable notes the agents always see — injected into voice, chat, and spawned coder agents.
          Separate from auto-memory, which keeps evolving on its own.
        </p>

        <div class="pm-section-title">Languages</div>
        <div class="pm-field-row">
          <label class="pm-field">
            <span>Primary language</span>
            <input class="sg-input" type="text" placeholder="e.g. th" .value=${f.preferredLanguage}
              @input=${(e: Event) => patchForm({ preferredLanguage: (e.target as HTMLInputElement).value })} />
          </label>
          <label class="pm-field">
            <span>Secondary (optional)</span>
            <input class="sg-input" type="text" placeholder="e.g. en" .value=${f.secondaryLanguage}
              @input=${(e: Event) => patchForm({ secondaryLanguage: (e.target as HTMLInputElement).value })} />
          </label>
        </div>

        <div class="pm-section-title">Role &amp; goals</div>
        <label class="pm-field">
          <span>Role / title</span>
          <input class="sg-input" type="text" placeholder="e.g. Running Example Studio" .value=${f.role}
            @input=${(e: Event) => patchForm({ role: (e.target as HTMLInputElement).value })} />
        </label>
        <label class="pm-field">
          <span>Skill level</span>
          <select class="sg-input" .value=${f.skillLevel}
            @change=${(e: Event) => patchForm({ skillLevel: (e.target as HTMLSelectElement).value as "" | SkillLevel })}>
            ${SKILL_OPTIONS.map((s) => html`<option value=${s.id} ?selected=${s.id === f.skillLevel}>${s.label}</option>`)}
          </select>
        </label>
        <label class="pm-field">
          <span>Goals / learning targets</span>
          <textarea class="sg-input" rows="3" placeholder="What is this user trying to achieve or learn?" .value=${f.goals}
            @input=${(e: Event) => patchForm({ goals: (e.target as HTMLTextAreaElement).value })}></textarea>
        </label>

        <div class="pm-section-title">Project context</div>
        <label class="pm-field">
          <span>Current focus / projects</span>
          <textarea class="sg-input" rows="3" placeholder="What is she working on right now?" .value=${f.projectContext}
            @input=${(e: Event) => patchForm({ projectContext: (e.target as HTMLTextAreaElement).value })}></textarea>
        </label>

        <div class="pm-section-title">Communication style</div>
        <label class="pm-field">
          <span>How agents should talk to this user</span>
          <input class="sg-input" type="text" placeholder="e.g. explain concepts before jargon; keep it terse" .value=${f.communicationStyle}
            @input=${(e: Event) => patchForm({ communicationStyle: (e.target as HTMLInputElement).value })} />
        </label>

        <div class="pm-section-title">Operator notes</div>
        <label class="pm-field">
          <span>Freeform notes</span>
          <textarea class="sg-input" rows="4" placeholder="Anything else the agents should always keep in mind." .value=${f.notes}
            @input=${(e: Event) => patchForm({ notes: (e.target as HTMLTextAreaElement).value })}></textarea>
        </label>

        ${renderContextPreview(f)}

        <div class="pm-form-actions">
          <button type="button" class="sg-btn sg-btn--ghost pm-btn pm-btn-ghost" @click=${closeForm}>Cancel</button>
          <button type="submit" class="sg-btn sg-btn--primary pm-btn pm-btn-primary" ?disabled=${data.busy || !f.name.trim()}>
            ${data.busy ? "Saving…" : f.mode === "create" ? "Create" : "Save"}
          </button>
        </div>
      </form>
    </div>
  `;
}

function renderContextPreview(f: EditForm) {
  const preview = buildContextPreview(f);
  return html`
    <div class="pm-preview">
      <div class="pm-preview-head">${sgIcon("file", 13)} Injected context block</div>
      ${preview
        ? html`<pre class="pm-preview-body">${preview}</pre>`
        : html`<div class="pm-preview-empty">No operator context set — nothing is injected for this profile.</div>`}
    </div>
  `;
}

const PM_STYLE_ID = "sg-profiles-css";
function injectStyles() {
  if (typeof document === "undefined") return;
  let style = document.getElementById(PM_STYLE_ID) as HTMLStyleElement | null;
  if (style?.textContent === PM_CSS) return;
  if (!style) {
    style = document.createElement("style");
    style.id = PM_STYLE_ID;
    document.head.appendChild(style);
  }
  style.textContent = PM_CSS;
}

const PM_CSS = `
.sg-profiles { padding: clamp(14px, 2vw, 24px); }
.pm-banner { display: flex; align-items: center; gap: 10px; padding: 11px 14px; border-radius: var(--sg-radius-md); font-size: 13px; }
.pm-banner-error { color: var(--sg-bad); background: color-mix(in srgb, var(--sg-bad) 10%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sg-bad) 28%, transparent); }

/* Chooser toggle row */
.pm-toggle-row { display: flex; align-items: center; gap: 14px; padding: 14px 18px; cursor: pointer; user-select: none; }
.pm-toggle-ico { flex: none; display: grid; place-items: center; width: 38px; height: 38px; border-radius: 12px; color: var(--sg-gold); background: var(--glass-gold-a10); box-shadow: inset 0 0 0 1px var(--glass-gold-a24); }
.pm-toggle-copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; font-size: 12.5px; color: var(--sg-fg-2); }
.pm-toggle-copy strong { color: var(--sg-fg); font-size: 14px; font-weight: 620; }
.pm-switch {
  appearance: none; -webkit-appearance: none; flex: none; position: relative; width: 44px; height: 26px; margin: 0; border-radius: 999px; cursor: pointer;
  background: var(--glass-press, rgba(255, 255, 255, 0.12)); box-shadow: inset 0 0 0 1px var(--glass-stroke-strong);
  transition: background var(--sg-dur) var(--sg-ease), box-shadow var(--sg-dur) var(--sg-ease);
}
.pm-switch::after { content: ""; position: absolute; top: 3px; left: 3px; width: 20px; height: 20px; border-radius: 50%; background: #fff; box-shadow: 0 2px 6px rgba(0, 0, 0, 0.35); transition: transform var(--sg-dur) var(--sg-spring); }
.pm-switch:checked { background: var(--glass-gold-fill, var(--sg-gold)); box-shadow: inset 0 0 0 1px var(--glass-stroke-gold), 0 0 14px -4px var(--glass-gold-a40); }
.pm-switch:checked::after { transform: translateX(18px); }
.pm-switch:focus-visible { box-shadow: var(--glass-focus-ring, 0 0 0 2px var(--sg-gold)); }

/* Grid + cards */
.sg-profiles > .sg-section-head { margin: 6px 0 -4px; }
.pm-empty { min-width: 0; }
.pm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 14px; }
.pm-card { display: flex; flex-direction: column; gap: 12px; padding: 18px; cursor: default; }
.pm-card--active { box-shadow: var(--glass-elev-2, none), inset 0 0 0 1px var(--glass-stroke-gold), var(--glass-glow-soft, none); }
.pm-card--active::before { background: var(--glass-edge); }
.pm-card-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.pm-avatar {
  --ring: var(--glass-stroke-strong, rgba(255, 255, 255, 0.16));
  flex: none; display: grid; place-items: center; width: 58px; height: 58px; padding: 2px; border-radius: 50%;
  background: conic-gradient(from 210deg, var(--ring), transparent 40%, var(--ring) 70%, transparent);
}
.pm-avatar > span {
  display: grid; place-items: center; width: 100%; height: 100%; border-radius: 50%; font-size: 28px; line-height: 1;
  background: radial-gradient(120% 120% at 30% 20%, var(--glass-gold-a16), transparent 60%), var(--glass-3);
  box-shadow: inset 0 0 0 1px var(--glass-stroke), var(--glass-specular, none);
}
.pm-avatar--active { --ring: var(--sg-gold); box-shadow: 0 0 18px -4px var(--glass-gold-a40); }
.pm-avatar--lg { width: 54px; height: 54px; }
.pm-avatar--lg > span { font-size: 26px; }
.pm-card-name { color: var(--sg-fg); font: 650 17px/1.2 var(--font-ui-display, var(--glass-font, system-ui)); letter-spacing: -0.02em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pm-card-role { margin-top: 3px; color: var(--sg-fg-3); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pm-card-meta { display: flex; flex-direction: column; gap: 0; border-radius: var(--sg-radius-sm); background: var(--glass-hover); box-shadow: inset 0 0 0 1px var(--glass-stroke); }
.pm-meta-row { display: flex; justify-content: space-between; gap: 10px; padding: 7px 11px; font-size: 12px; }
.pm-meta-row + .pm-meta-row { border-top: 1px solid var(--glass-stroke); }
.pm-meta-k { color: var(--sg-fg-3); }
.pm-meta-v { color: var(--sg-fg-2); text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pm-card-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.pm-card-chips .sg-chip { font-size: 10.5px; padding: 2px 8px; text-transform: capitalize; }
.pm-card-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: auto; }
.pm-card-actions .pm-btn-primary { flex: 1 1 auto; }
.pm-card--add {
  align-items: center; justify-content: center; text-align: center; min-height: 260px; border-radius: var(--sg-radius-md); cursor: pointer; font: inherit;
  color: var(--sg-fg-2); background: transparent; border: 1.5px dashed var(--glass-stroke-gold, rgba(217, 180, 95, 0.28));
  -webkit-backdrop-filter: none; backdrop-filter: none;
  transition: background var(--sg-dur) var(--sg-ease), border-color var(--sg-dur) var(--sg-ease), color var(--sg-dur) var(--sg-ease), transform var(--sg-dur) var(--sg-spring);
}
.pm-card--add:hover:not([disabled]) { color: var(--sg-fg); border-color: var(--sg-gold); background: var(--glass-gold-a06); transform: var(--glass-lift, translateY(-1px)); }
.pm-card--add[disabled] { opacity: 0.5; cursor: not-allowed; }
.pm-add-ico { display: grid; place-items: center; width: 52px; height: 52px; border-radius: 50%; color: var(--sg-gold); background: var(--glass-gold-a10); box-shadow: inset 0 0 0 1px var(--glass-gold-a24); }
.pm-add-sub { font-size: 12px; color: var(--sg-fg-3); }

/* Sheet */
.pm-dialog { width: min(560px, 100%); }
.pm-sheet-head { display: flex; align-items: center; gap: 14px; margin-bottom: 18px; }
.pm-sheet-title { flex: 1; min-width: 0; }
.pm-sheet-title .sg-eyebrow { margin-bottom: 4px; }
.pm-dialog h3 { margin: 0; color: var(--sg-fg); font: 650 20px/1.15 var(--font-ui-display, var(--glass-font, system-ui)); letter-spacing: -0.02em; }
.pm-field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; min-width: 0; font-size: 12px; color: var(--sg-fg-2); }
.pm-field > span { font-weight: 560; }
.pm-field textarea.sg-input { resize: vertical; min-height: 64px; line-height: 1.5; }
.pm-field select.sg-input option { background: var(--glass-solid, #15130f); color: var(--sg-fg); }
.pm-field-row { display: flex; gap: 12px; }
.pm-field-row .pm-field { flex: 1; }
.pm-section-divider { margin: 22px 0 6px; }
.pm-section-hint { margin: 0 0 12px; font-size: 12px; color: var(--sg-fg-3); line-height: 1.5; }
.pm-section-title { margin: 16px 0 8px; color: var(--sg-gold); font-size: 10.5px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; }
.pm-preview { margin: 18px 0 6px; border-radius: var(--sg-radius-md); overflow: hidden; box-shadow: inset 0 0 0 1px var(--glass-stroke-gold); background: color-mix(in srgb, var(--glass-base, #07070a) 40%, transparent); }
.pm-preview-head { display: flex; align-items: center; gap: 7px; padding: 8px 12px; font-size: 10.5px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: var(--sg-gold); background: var(--glass-gold-a06); border-bottom: 1px solid var(--glass-stroke); }
.pm-preview-body { margin: 0; padding: 12px; font-size: 11.5px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; color: var(--sg-fg); font-family: var(--glass-font-mono, ui-monospace, monospace); max-height: 240px; overflow-y: auto; }
.pm-preview-empty { padding: 12px; font-size: 12px; color: var(--sg-fg-3); }
.pm-avatar-row { display: flex; gap: 10px; align-items: flex-start; }
.pm-avatar-input { width: 58px !important; flex: none; text-align: center; font-size: 22px !important; min-height: 44px; }
.pm-avatar-picks { display: flex; flex-wrap: wrap; gap: 5px; flex: 1; min-width: 0; }
.pm-avatar-pick {
  width: 36px; height: 36px; border: 0; border-radius: 10px; font-size: 18px; cursor: pointer; background: var(--glass-hover);
  box-shadow: inset 0 0 0 1px var(--glass-stroke); transition: transform var(--glass-dur-fast, 140ms) var(--sg-ease), box-shadow var(--sg-dur) var(--sg-ease);
}
.pm-avatar-pick:hover { transform: translateY(-1px); box-shadow: inset 0 0 0 1px var(--glass-stroke-gold); }
.pm-avatar-pick.active { background: var(--glass-gold-a16); box-shadow: inset 0 0 0 1.5px var(--sg-gold), 0 0 12px -4px var(--glass-gold-a40); }
.pm-form-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--glass-stroke); }

@media (max-width: 720px) {
  .sg-profiles { padding: 12px; }
  .pm-grid { grid-template-columns: minmax(0, 1fr); }
  .pm-card--add { min-height: 140px; }
  .pm-field-row { flex-direction: column; gap: 0; }
  .pm-toggle-row { padding: 12px 14px; }
  .pm-form-actions > .sg-btn { flex: 1 1 auto; }
}
@media (prefers-reduced-motion: reduce) {
  .pm-switch, .pm-switch::after, .pm-card--add, .pm-avatar-pick { transition: none; }
}
`;
