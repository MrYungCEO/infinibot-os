/**
 * Team & Access — multi-user workspaces admin page (/access).
 *
 * Owner + admin users: Users, Invites, Workspaces (members + which records
 * belong to each), the Permissions matrix (roles × resource types × actions,
 * global and per-workspace), Preview-as-user and the Audit log.
 * Everyone else: "My account" (password, two-factor, workspace switcher).
 *
 * Everything here is advisory UI; the gateway enforces the same rules on
 * every RPC (src/access/authz.ts).
 */

import { html, nothing, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../gateway";
import {
  type AccessMe,
  ensureAccessMe,
  getAccessMe,
  type Perms,
} from "../access/access-session";
import {
  ensureSystemGlass,
  sgAurora,
  sgChip,
  sgEmpty,
  sgHero,
  sgIcon,
  type SgIconName,
} from "./system-glass";

// ── Types (wire shapes from access.* RPCs) ────────────────────────────

type Role = "admin" | "member" | "viewer";
type Allowance = {
  resources?: Partial<Record<string, { view?: boolean; edit?: boolean }>>;
  features?: Partial<Record<string, boolean>>;
};
type UserRow = {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  role: Role;
  allowance: Allowance;
  disabled: boolean;
  totpEnabled: boolean;
  createdAt: number;
  lastActiveAt: number | null;
  workspaces: { id: string; role: Role | null; allowance: Allowance }[];
};
type InviteRow = {
  id: string;
  role: Role;
  status: "active" | "expired" | "revoked" | "used";
  workspaces: { id: string; name: string }[];
  maxUses: number | null;
  uses: number;
  expiresAt: number | null;
  email: string | null;
  note: string | null;
  createdBy: string;
  createdAt: number;
};
type WorkspaceRow = {
  id: string;
  name: string;
  description: string;
  color: string | null;
  agencyId: string | null;
  roleOverrides: Partial<Record<Role, Allowance>>;
  members: { userId: string; role: Role | null; allowance: Allowance }[];
  assignments: { resourceType: string; resourceId: string }[];
};
type Overview = {
  enabled: boolean;
  users: UserRow[];
  invites: InviteRow[];
  workspaces: WorkspaceRow[];
  matrix: Partial<Record<Role, Allowance>>;
  shape: {
    resourceTypes: string[];
    actions: string[];
    features: string[];
    roles: Role[];
    defaults: Record<Role, Allowance>;
  };
};
type ResourceItem = { id: string; title: string; kind?: string; parentId?: string | null; workspaceIds: string[] };
type Preview = {
  user: UserRow;
  workspaces: { id: string; name: string; role: string; perms: Perms }[];
  features: Record<string, boolean>;
  visible: Record<string, { id: string; title: string }[]>;
};
type AuditEntry = {
  id: number;
  ts: number;
  actor: string;
  action: string;
  method: string | null;
  target: string | null;
  allowed: boolean;
  detail: string | null;
};

type Section = "users" | "invites" | "workspaces" | "permissions" | "preview" | "audit" | "account";

const S = {
  section: "users" as Section,
  loading: false,
  error: null as string | null,
  notice: null as string | null,
  data: null as Overview | null,
  loadedFor: null as GatewayBrowserClient | null,
  // users
  newUser: { open: false, username: "", displayName: "", role: "viewer" as Role, workspaceIds: [] as string[] },
  secret: null as { label: string; value: string } | null,
  // per-user allowance editor (Users tab)
  allowanceUser: null as string | null,
  allowanceDraft: null as Allowance | null,
  // invites
  invite: {
    role: "viewer" as Role,
    workspaceIds: [] as string[],
    multiUse: false,
    maxUses: "",
    expiresInHours: 72,
    email: "",
    sendEmail: false,
    note: "",
  },
  lastInvite: null as { url: string; emailed?: { ok: boolean; message?: string } } | null,
  // workspaces
  newWorkspace: "",
  openWorkspace: null as string | null,
  resourceType: "projects",
  resources: {} as Record<string, ResourceItem[]>,
  resourceFilter: "",
  // permissions
  matrixScope: "global" as string,
  matrixDraft: null as Partial<Record<Role, Allowance>> | null,
  // preview
  previewUser: "" as string,
  preview: null as Preview | null,
  // audit
  audit: [] as AuditEntry[],
  auditDeniedOnly: false,
  // account
  pw: { current: "", next: "" },
  totp: null as { secret: string; uri: string } | null,
  totpCode: "",
};

const RESOURCE_LABELS: Record<string, string> = {
  projects: "Projects",
  kanban: "Kanban tasks",
  documents: "Documents",
  files: "Files",
  sessions: "Chats & sessions",
  agents: "Agents",
  knowledge: "Knowledge graph",
  reports: "Reports",
  dashboards: "Dashboards",
};
const RESOURCE_ICONS: Record<string, SgIconName> = {
  projects: "layers",
  kanban: "grid",
  documents: "file",
  files: "database",
  sessions: "users",
  agents: "cpu",
  knowledge: "network",
  reports: "activity",
  dashboards: "apps",
};
const FEATURE_LABELS: Record<string, string> = {
  chat: "Chat with agents",
  coders: "Run coders",
  finance: "Billing & finance",
  secure: "Secure Mode",
};
const ROLE_HINT: Record<Role, string> = {
  admin: "Manages people and visibility",
  member: "Views and edits workspace data",
  viewer: "Read-only",
};
const ASSIGNABLE = ["projects", "documents", "reports", "agents"];

// ── Data ──────────────────────────────────────────────────────────────

let _client: GatewayBrowserClient | null = null;
let _update: () => void = () => {};

async function call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T | null> {
  if (!_client) return null;
  try {
    return (await _client.request(method, params)) as T;
  } catch (e) {
    S.error = e instanceof Error ? e.message : String(e);
    _update();
    return null;
  }
}

async function reload() {
  S.loading = true;
  S.error = null;
  _update();
  const ov = await call<Overview>("access.overview");
  if (ov) S.data = ov;
  S.loading = false;
  _update();
}

async function act(method: string, params: Record<string, unknown>, notice?: string) {
  S.error = null;
  S.notice = null;
  const r = await call<Record<string, unknown>>(method, params);
  if (r !== null) {
    if (notice) S.notice = notice;
    await reload();
  }
  return r;
}

async function loadResources(type: string) {
  const r = await call<{ items: ResourceItem[] }>("access.resources.list", { resourceType: type });
  if (r) S.resources[type] = r.items;
  _update();
}

async function loadAudit() {
  const r = await call<{ entries: AuditEntry[] }>("access.audit.list", {
    limit: 300,
    deniedOnly: S.auditDeniedOnly,
  });
  if (r) S.audit = r.entries;
  _update();
}

function fmtTime(ts: number | null): string {
  if (!ts) return "never";
  const d = Date.now() - ts;
  if (d < 60_000) return "just now";
  if (d < 3600_000) return `${Math.round(d / 60_000)} min ago`;
  if (d < 86400_000) return `${Math.round(d / 3600_000)} h ago`;
  return new Date(ts).toLocaleDateString();
}

function wsName(id: string): string {
  return S.data?.workspaces.find((w) => w.id === id)?.name ?? "(deleted)";
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    S.notice = "Copied to clipboard";
  } catch {
    S.notice = "Copy failed — select the text and copy it manually";
  }
  _update();
}

// ── Shared bits ───────────────────────────────────────────────────────

function roleChip(role: string): TemplateResult {
  if (role === "admin") return sgChip(html`${sgIcon("shield", 11)} admin`, "gold");
  if (role === "member") return sgChip(html`${sgIcon("user", 11)} member`, "ok");
  if (role === "owner") return sgChip(html`${sgIcon("key", 11)} owner`, "gold");
  return sgChip(html`${sgIcon("eye", 11)} viewer`);
}

function roleSelect(value: string, onChange: (r: Role) => void, opts: { allowAdmin: boolean; inherit?: boolean }) {
  return html`<select
    class="sg-input acx-select"
    .value=${value}
    @change=${(e: Event) => onChange((e.target as HTMLSelectElement).value as Role)}
  >
    ${opts.inherit ? html`<option value="" ?selected=${!value}>Inherit</option>` : nothing}
    ${opts.allowAdmin || value === "admin" ? html`<option value="admin" ?selected=${value === "admin"}>Admin</option>` : nothing}
    <option value="member" ?selected=${value === "member"}>Member</option>
    <option value="viewer" ?selected=${value === "viewer"}>Viewer</option>
  </select>`;
}

function workspacePicker(selected: string[], onToggle: (id: string) => void): TemplateResult {
  const ws = S.data?.workspaces ?? [];
  if (!ws.length) return html`<span class="sg-faint">No workspaces yet — create one in the Workspaces tab.</span>`;
  return html`<div class="acx-picks">
    ${ws.map(
      (w) => html`<button
        type="button"
        class="acx-pick ${selected.includes(w.id) ? "is-on" : ""}"
        aria-pressed=${selected.includes(w.id)}
        @click=${() => onToggle(w.id)}
      >
        ${selected.includes(w.id) ? sgIcon("check", 12) : sgIcon("plus", 12)} ${w.name}
      </button>`,
    )}
  </div>`;
}

function toggle(on: boolean, onClick: () => void, opts: { label: string; inherited?: boolean; disabled?: boolean }) {
  return html`<button
    type="button"
    role="switch"
    aria-checked=${on}
    aria-label=${opts.label}
    title=${opts.inherited ? `${opts.label} (inherited)` : opts.label}
    class="acx-toggle ${on ? "is-on" : ""} ${opts.inherited ? "is-inherited" : ""}"
    ?disabled=${opts.disabled}
    @click=${onClick}
  >
    <span class="acx-toggle__knob"></span>
  </button>`;
}

// ── Sections ──────────────────────────────────────────────────────────

function isOwner(me: AccessMe | null): boolean {
  return !me || me.owner === true;
}

function renderUsers(me: AccessMe | null): TemplateResult {
  const d = S.data!;
  const owner = isOwner(me);
  const nu = S.newUser;
  return html`
    <div class="acx-head">
      <div>
        <h2 class="sg-h2">People</h2>
        <p class="sg-faint">Everyone who can sign in to this gateway. The owner (gateway password) is not listed and always has full access.</p>
      </div>
      <button class="sg-btn sg-btn--primary" @click=${() => ((nu.open = !nu.open), _update())}>
        ${sgIcon("plus", 15)} Add user
      </button>
    </div>
    ${nu.open
      ? html`<div class="sg-card acx-form">
          <div class="acx-form__row">
            <label>Username<input class="sg-input" .value=${nu.username} @input=${(e: Event) => (nu.username = (e.target as HTMLInputElement).value)} placeholder="e.g. maria" /></label>
            <label>Display name<input class="sg-input" .value=${nu.displayName} @input=${(e: Event) => (nu.displayName = (e.target as HTMLInputElement).value)} placeholder="Maria Lopez" /></label>
            <label>Role${roleSelect(nu.role, (r) => ((nu.role = r), _update()), { allowAdmin: owner })}</label>
          </div>
          <div class="acx-form__label">Workspaces</div>
          ${workspacePicker(nu.workspaceIds, (id) => {
            nu.workspaceIds = nu.workspaceIds.includes(id) ? nu.workspaceIds.filter((x) => x !== id) : [...nu.workspaceIds, id];
            _update();
          })}
          <div class="acx-form__actions">
            <button class="sg-btn sg-btn--ghost" @click=${() => ((nu.open = false), _update())}>Cancel</button>
            <button
              class="sg-btn sg-btn--primary"
              ?disabled=${!nu.username.trim()}
              @click=${async () => {
                const r = await act("access.users.create", {
                  username: nu.username.trim(),
                  displayName: nu.displayName.trim(),
                  role: nu.role,
                  workspaceIds: nu.workspaceIds,
                });
                const pw = (r as { temporaryPassword?: string } | null)?.temporaryPassword;
                if (pw) S.secret = { label: `Temporary password for ${nu.username.trim()}`, value: pw };
                if (r) Object.assign(nu, { open: false, username: "", displayName: "", workspaceIds: [] });
                _update();
              }}
            >${sgIcon("check", 15)} Create user</button>
          </div>
        </div>`
      : nothing}
    ${d.users.length === 0
      ? sgEmpty({
          icon: "users",
          title: "No workspace users yet",
          body: "Send an invite link from the Invites tab, or add someone directly.",
        })
      : html`<div class="acx-table-wrap"><table class="sg-table acx-table">
          <thead><tr><th>User</th><th>Role</th><th>Workspaces</th><th>Last active</th><th>Status</th><th class="acx-r">Actions</th></tr></thead>
          <tbody>
            ${d.users.map((u) => {
              const locked = !owner && u.role === "admin";
              return html`<tr class=${u.disabled ? "is-disabled" : ""}>
                <td>
                  <div class="acx-user">
                    <span class="acx-avatar">${(u.displayName || u.username).slice(0, 1).toUpperCase()}</span>
                    <span><strong>${u.displayName}</strong><span class="sg-faint acx-sub">@${u.username}${u.email ? ` · ${u.email}` : ""}</span></span>
                  </div>
                </td>
                <td>${locked
                  ? roleChip(u.role)
                  : roleSelect(u.role, (r) => void act("access.users.update", { id: u.id, role: r }, `${u.username} is now ${r}`), { allowAdmin: owner })}</td>
                <td><div class="acx-chips">${u.workspaces.length ? u.workspaces.map((w) => sgChip(wsName(w.id))) : html`<span class="sg-faint">none</span>`}</div></td>
                <td class="sg-faint">${fmtTime(u.lastActiveAt)}</td>
                <td>
                  ${u.disabled ? sgChip("disabled", "bad") : sgChip("active", "ok", true)}
                  ${u.totpEnabled ? sgChip(html`${sgIcon("lock", 11)} 2FA`, "gold") : nothing}
                </td>
                <td class="acx-r">
                  <div class="acx-row-actions">
                    <button class="sg-btn sg-btn--sm ${S.allowanceUser === u.id ? "" : "sg-btn--ghost"}" title="Custom permissions" ?disabled=${locked}
                      @click=${() => {
                        S.allowanceUser = S.allowanceUser === u.id ? null : u.id;
                        S.allowanceDraft = JSON.parse(JSON.stringify(u.allowance ?? {})) as Allowance;
                        _update();
                      }}>${sgIcon("shield", 14)}</button>
                    <button class="sg-btn sg-btn--sm sg-btn--ghost" title="Preview as this user" ?disabled=${locked}
                      @click=${() => ((S.previewUser = u.id), (S.section = "preview"), void loadPreview())}>${sgIcon("eye", 14)}</button>
                    <button class="sg-btn sg-btn--sm sg-btn--ghost" title="Reset password" ?disabled=${locked}
                      @click=${async () => {
                        const r = await act("access.users.resetPassword", { id: u.id });
                        const pw = (r as { temporaryPassword?: string } | null)?.temporaryPassword;
                        if (pw) S.secret = { label: `New temporary password for ${u.username}`, value: pw };
                        _update();
                      }}>${sgIcon("key", 14)}</button>
                    ${u.totpEnabled
                      ? html`<button class="sg-btn sg-btn--sm sg-btn--ghost" title="Reset two-factor" ?disabled=${locked}
                          @click=${() => void act("access.users.resetTotp", { id: u.id }, `Two-factor reset for ${u.username}`)}>${sgIcon("lock", 14)}</button>`
                      : nothing}
                    <button class="sg-btn sg-btn--sm sg-btn--ghost" title=${u.disabled ? "Enable" : "Disable"} ?disabled=${locked}
                      @click=${() => void act("access.users.update", { id: u.id, disabled: !u.disabled }, u.disabled ? `${u.username} enabled` : `${u.username} disabled and signed out`)}>
                      ${sgIcon(u.disabled ? "play" : "close", 14)}</button>
                    <button class="sg-btn sg-btn--sm sg-btn--danger" title="Remove user" ?disabled=${locked}
                      @click=${() => {
                        if (confirm(`Remove ${u.username}? They lose access immediately.`)) void act("access.users.remove", { id: u.id }, `${u.username} removed`);
                      }}>${sgIcon("trash", 14)}</button>
                  </div>
                </td>
              </tr>
              ${S.allowanceUser === u.id && S.allowanceDraft ? html`<tr class="acx-allow-row"><td colspan="6">${renderAllowanceEditor(u, owner)}</td></tr>` : nothing}`;
            })}
          </tbody>
        </table></div>`}
  `;
}

type Tri = boolean | undefined;

/** inherit → allow → deny → inherit */
function triButton(value: Tri, onChange: (v: Tri) => void, label: string, disabled = false): TemplateResult {
  const next: Tri = value === undefined ? true : value === true ? false : undefined;
  const text = value === undefined ? "Inherit" : value ? "Allow" : "Deny";
  return html`<button type="button" class="acx-tri ${value === undefined ? "" : value ? "is-allow" : "is-deny"}"
    aria-label="${label}: ${text}" title="${label}: ${text} (click to change)" ?disabled=${disabled}
    @click=${() => onChange(next)}>${value === undefined ? sgIcon("refresh", 11) : value ? sgIcon("check", 11) : sgIcon("close", 11)} ${text}</button>`;
}

/** Custom allowance for one person — overrides their role everywhere they're a member. */
function renderAllowanceEditor(u: UserRow, owner: boolean): TemplateResult {
  const d = S.data!;
  const a = S.allowanceDraft!;
  const setRes = (t: string, action: "view" | "edit", v: Tri) => {
    const res = (a.resources ??= {});
    const g = (res[t] ??= {});
    if (v === undefined) delete g[action];
    else g[action] = v;
    if (!Object.keys(g).length) delete res[t];
    _update();
  };
  const setFeat = (f: string, v: Tri) => {
    const feats = (a.features ??= {});
    if (v === undefined) delete feats[f];
    else feats[f] = v;
    _update();
  };
  return html`<div class="acx-allow">
    <div class="acx-allow__head">
      <div>
        <div class="acx-card-title">${sgIcon("shield", 15)} Custom permissions for ${u.displayName}</div>
        <p class="sg-faint acx-hint">Overrides their ${u.role} role in every workspace they belong to. "Inherit" keeps the role's setting.</p>
      </div>
      <div class="sg-actions">
        <button class="sg-btn sg-btn--sm sg-btn--ghost" @click=${() => ((S.allowanceDraft = {}), _update())}>${sgIcon("refresh", 13)} Clear all</button>
        <button class="sg-btn sg-btn--sm sg-btn--primary" @click=${async () => {
          const r = await act("access.users.update", { id: u.id, allowance: S.allowanceDraft }, `Permissions saved for ${u.username}`);
          if (r) S.allowanceUser = null;
          _update();
        }}>${sgIcon("check", 13)} Save</button>
      </div>
    </div>
    <div class="acx-allow__grid">
      ${d.shape.resourceTypes.map(
        (t) => html`<div class="acx-allow__item">
          <span class="acx-res-label">${sgIcon(RESOURCE_ICONS[t] ?? "file", 13)} ${RESOURCE_LABELS[t] ?? t}</span>
          <span class="acx-allow__pair">
            <span class="sg-faint">View</span>${triButton(a.resources?.[t]?.view, (v) => setRes(t, "view", v), `${RESOURCE_LABELS[t]} view`)}
            <span class="sg-faint">Edit</span>${triButton(a.resources?.[t]?.edit, (v) => setRes(t, "edit", v), `${RESOURCE_LABELS[t]} edit`)}
          </span>
        </div>`,
      )}
      ${d.shape.features.map(
        (f) => html`<div class="acx-allow__item">
          <span class="acx-res-label">${sgIcon(f === "secure" ? "lock" : f === "finance" ? "activity" : f === "coders" ? "bolt" : "users", 13)} ${FEATURE_LABELS[f] ?? f}</span>
          <span class="acx-allow__pair">${triButton(a.features?.[f], (v) => setFeat(f, v), FEATURE_LABELS[f] ?? f, f === "secure" && !owner)}</span>
        </div>`,
      )}
    </div>
  </div>`;
}

function renderInvites(me: AccessMe | null): TemplateResult {
  const d = S.data!;
  const f = S.invite;
  const owner = isOwner(me);
  const toggleWs = (id: string) => {
    f.workspaceIds = f.workspaceIds.includes(id) ? f.workspaceIds.filter((x) => x !== id) : [...f.workspaceIds, id];
    _update();
  };
  return html`
    <div class="acx-split">
      <div class="sg-card acx-form">
        <div class="acx-card-title">${sgIcon("link", 16)} New signup link</div>
        <div class="acx-form__row">
          <label>Role${roleSelect(f.role, (r) => ((f.role = r), _update()), { allowAdmin: owner })}</label>
          <label>Expires
            <select class="sg-input acx-select" .value=${String(f.expiresInHours)} @change=${(e: Event) => ((f.expiresInHours = Number((e.target as HTMLSelectElement).value)), _update())}>
              <option value="24">in 24 hours</option>
              <option value="72">in 3 days</option>
              <option value="168">in 7 days</option>
              <option value="720">in 30 days</option>
              <option value="0">never</option>
            </select>
          </label>
        </div>
        <p class="sg-faint acx-hint">${ROLE_HINT[f.role]}</p>
        <div class="acx-form__label">Workspaces they join</div>
        ${workspacePicker(f.workspaceIds, toggleWs)}
        <div class="acx-form__row acx-form__row--inline">
          <span class="acx-inline">${toggle(f.multiUse, () => ((f.multiUse = !f.multiUse), _update()), { label: "Multi-use link" })} Multi-use link</span>
          ${f.multiUse
            ? html`<label class="acx-inline">Max uses<input class="sg-input acx-num" type="number" min="1" placeholder="unlimited" .value=${f.maxUses} @input=${(e: Event) => (f.maxUses = (e.target as HTMLInputElement).value)} /></label>`
            : html`<span class="sg-faint">Single use — the link stops working after one signup.</span>`}
        </div>
        <div class="acx-form__row">
          <label>Email (optional)<input class="sg-input" type="email" .value=${f.email} @input=${(e: Event) => ((f.email = (e.target as HTMLInputElement).value), _update())} placeholder="name@company.com" /></label>
          <label>Note (optional)<input class="sg-input" .value=${f.note} @input=${(e: Event) => (f.note = (e.target as HTMLInputElement).value)} placeholder="e.g. Agency contractor" /></label>
        </div>
        ${f.email.trim()
          ? html`<span class="acx-inline">${toggle(f.sendEmail, () => ((f.sendEmail = !f.sendEmail), _update()), { label: "Email the link" })} Email the link through your configured email channel</span>`
          : nothing}
        <div class="acx-form__actions">
          <button class="sg-btn sg-btn--primary" @click=${async () => {
            const r = await act("access.invites.create", {
              role: f.role,
              workspaceIds: f.workspaceIds,
              multiUse: f.multiUse,
              maxUses: f.multiUse && f.maxUses ? Number(f.maxUses) : undefined,
              expiresInHours: f.expiresInHours,
              email: f.email.trim() || undefined,
              sendEmail: f.sendEmail && !!f.email.trim(),
              note: f.note.trim() || undefined,
              origin: location.origin + (location.pathname.replace(/\/[^/]*$/, "") || ""),
            });
            if (r) S.lastInvite = { url: String((r as { url: string }).url), emailed: (r as { emailed?: { ok: boolean; message?: string } }).emailed };
            _update();
          }}>${sgIcon("spark", 15)} Create link</button>
        </div>
        ${S.lastInvite
          ? html`<div class="acx-link">
              <code class="sg-mono">${S.lastInvite.url}</code>
              <button class="sg-btn sg-btn--sm" @click=${() => void copy(S.lastInvite!.url)}>${sgIcon("copy", 14)} Copy</button>
              ${S.lastInvite.emailed
                ? S.lastInvite.emailed.ok
                  ? html`<span class="acx-ok">${sgIcon("check", 13)} Emailed</span>`
                  : html`<span class="acx-warn">${sgIcon("alert", 13)} Email not sent (${S.lastInvite.emailed.message ?? "no email channel"}) — copy the link instead</span>`
                : nothing}
              <p class="sg-faint">Shown once. Anyone with this link can create an account until it expires or is used up.</p>
            </div>`
          : nothing}
      </div>
      <div class="acx-list">
        <h2 class="sg-h2">Invites</h2>
        ${d.invites.length === 0
          ? sgEmpty({ icon: "link", title: "No invites yet", body: "Links you create appear here with their status." })
          : d.invites.map(
              (i) => html`<div class="sg-card acx-invite">
                <div class="acx-invite__top">
                  ${roleChip(i.role)}
                  ${i.status === "active" ? sgChip("active", "ok", true) : i.status === "used" ? sgChip("used") : sgChip(i.status, i.status === "revoked" ? "bad" : "warn")}
                  <span class="sg-faint">${i.maxUses === null ? `${i.uses} uses · unlimited` : `${i.uses}/${i.maxUses} used`}</span>
                  <span class="sg-spacer"></span>
                  ${i.status === "active"
                    ? html`<button class="sg-btn sg-btn--sm sg-btn--ghost" @click=${() => void act("access.invites.revoke", { id: i.id }, "Invite revoked")}>${sgIcon("close", 13)} Revoke</button>`
                    : html`<button class="sg-btn sg-btn--sm sg-btn--ghost" title="Delete" @click=${() => void act("access.invites.delete", { id: i.id })}>${sgIcon("trash", 13)}</button>`}
                </div>
                <div class="acx-chips">${i.workspaces.length ? i.workspaces.map((w) => sgChip(w.name)) : html`<span class="sg-faint">no workspace</span>`}</div>
                <div class="sg-faint acx-sub">
                  ${i.email ? html`${i.email} · ` : nothing}${i.note ? html`${i.note} · ` : nothing}by ${i.createdBy} ·
                  ${i.expiresAt ? (i.expiresAt > Date.now() ? `expires ${new Date(i.expiresAt).toLocaleString()}` : "expired") : "no expiry"}
                </div>
              </div>`,
            )}
      </div>
    </div>
  `;
}

function renderWorkspaces(me: AccessMe | null): TemplateResult {
  const d = S.data!;
  const owner = isOwner(me);
  return html`
    <div class="acx-head">
      <div>
        <h2 class="sg-h2">Workspaces</h2>
        <p class="sg-faint">A workspace is a shared space: its members see only the records assigned to it. Your own data stays private until you assign it here.</p>
      </div>
      <div class="sg-actions">
        <input class="sg-input" placeholder="New workspace name" .value=${S.newWorkspace}
          @input=${(e: Event) => ((S.newWorkspace = (e.target as HTMLInputElement).value), _update())}
          @keydown=${(e: KeyboardEvent) => e.key === "Enter" && S.newWorkspace.trim() && void createWorkspace()} />
        <button class="sg-btn sg-btn--primary" ?disabled=${!S.newWorkspace.trim()} @click=${() => void createWorkspace()}>${sgIcon("plus", 15)} Create</button>
        <button class="sg-btn sg-btn--ghost" title="Create a workspace for every Agency"
          @click=${async () => {
            const r = await act("access.workspaces.importAgencies", {});
            if (r) S.notice = `Imported ${(r as { created: number }).created} of ${(r as { found: number }).found} agencies`;
            _update();
          }}>${sgIcon("download", 15)} Import agencies</button>
      </div>
    </div>
    ${d.workspaces.length === 0
      ? sgEmpty({ icon: "layers", title: "No workspaces yet", body: "Create one, then add people and assign projects, documents, reports and agents to it." })
      : html`<div class="acx-ws-grid">${d.workspaces.map((w) => renderWorkspaceCard(w, owner))}</div>`}
  `;
}

async function createWorkspace() {
  const name = S.newWorkspace.trim();
  if (!name) return;
  const r = await act("access.workspaces.create", { name }, `Workspace "${name}" created`);
  if (r) S.newWorkspace = "";
  _update();
}

function renderWorkspaceCard(w: WorkspaceRow, owner: boolean): TemplateResult {
  const d = S.data!;
  const open = S.openWorkspace === w.id;
  const counts: Record<string, number> = {};
  for (const a of w.assignments) counts[a.resourceType] = (counts[a.resourceType] ?? 0) + 1;
  const nonMembers = d.users.filter((u) => !w.members.some((m) => m.userId === u.id));
  return html`<div class="sg-card acx-ws ${open ? "is-open" : ""}">
    <div class="acx-ws__top">
      <span class="acx-ws__icon">${sgIcon("layers", 18)}</span>
      <div class="acx-ws__name">
        <strong>${w.name}</strong>
        <span class="sg-faint acx-sub">${w.members.length} member${w.members.length === 1 ? "" : "s"} · ${w.assignments.length} record${w.assignments.length === 1 ? "" : "s"}${w.agencyId ? " · linked agency" : ""}</span>
      </div>
      <span class="sg-spacer"></span>
      <button class="sg-btn sg-btn--sm" @click=${() => {
        S.openWorkspace = open ? null : w.id;
        if (!open && !S.resources[S.resourceType]) void loadResources(S.resourceType);
        _update();
      }}>${sgIcon(open ? "close" : "settings", 14)} ${open ? "Close" : "Manage"}</button>
      <button class="sg-btn sg-btn--sm sg-btn--danger" title="Delete workspace" @click=${() => {
        if (confirm(`Delete workspace "${w.name}"? Members lose access to its records (the records themselves are kept).`)) void act("access.workspaces.delete", { id: w.id }, "Workspace deleted");
      }}>${sgIcon("trash", 14)}</button>
    </div>
    <div class="acx-chips">
      ${ASSIGNABLE.map((t) => sgChip(html`${sgIcon(RESOURCE_ICONS[t], 11)} ${counts[t] ?? 0} ${RESOURCE_LABELS[t].toLowerCase()}`))}
    </div>
    ${open
      ? html`
          <div class="acx-ws__body">
            <div>
              <div class="acx-form__label">Members</div>
              ${w.members.length === 0 ? html`<p class="sg-faint">Nobody yet.</p>` : nothing}
              ${w.members.map((m) => {
                const u = d.users.find((x) => x.id === m.userId);
                if (!u) return nothing;
                const locked = !owner && u.role === "admin";
                return html`<div class="acx-member">
                  <span class="acx-avatar acx-avatar--sm">${(u.displayName || u.username).slice(0, 1).toUpperCase()}</span>
                  <span class="acx-member__name">${u.displayName} <span class="sg-faint">· ${u.role}</span></span>
                  <span class="sg-faint">role here</span>
                  ${locked
                    ? roleChip(m.role ?? u.role)
                    : roleSelect(m.role ?? "", (r) => void act("access.members.set", { workspaceId: w.id, userId: u.id, role: r || null, allowance: m.allowance }), { allowAdmin: owner, inherit: true })}
                  <button class="sg-btn sg-btn--sm sg-btn--ghost" title="Remove from workspace" ?disabled=${locked}
                    @click=${() => void act("access.members.remove", { workspaceId: w.id, userId: u.id })}>${sgIcon("close", 13)}</button>
                </div>`;
              })}
              ${nonMembers.length
                ? html`<select class="sg-input acx-select" @change=${(e: Event) => {
                    const id = (e.target as HTMLSelectElement).value;
                    (e.target as HTMLSelectElement).value = "";
                    if (id) void act("access.members.set", { workspaceId: w.id, userId: id, role: null, allowance: {} });
                  }}>
                    <option value="">+ Add a member…</option>
                    ${nonMembers.map((u) => html`<option value=${u.id}>${u.displayName} (@${u.username})</option>`)}
                  </select>`
                : nothing}
            </div>
            <div>
              <div class="acx-form__label">Records in this workspace</div>
              <div class="sg-seg acx-seg" role="tablist">
                ${ASSIGNABLE.map(
                  (t) => html`<button role="tab" class=${S.resourceType === t ? "is-active" : ""} aria-selected=${S.resourceType === t}
                    @click=${() => {
                      S.resourceType = t;
                      if (!S.resources[t]) void loadResources(t);
                      _update();
                    }}>${sgIcon(RESOURCE_ICONS[t], 13)} ${RESOURCE_LABELS[t]}</button>`,
                )}
              </div>
              <input class="sg-input acx-filter" placeholder="Filter…" .value=${S.resourceFilter} @input=${(e: Event) => ((S.resourceFilter = (e.target as HTMLInputElement).value), _update())} />
              ${renderResourcePicker(w)}
            </div>
          </div>`
      : nothing}
  </div>`;
}

function renderResourcePicker(w: WorkspaceRow): TemplateResult {
  const items = S.resources[S.resourceType];
  if (!items) return html`<p class="sg-faint">Loading…</p>`;
  const q = S.resourceFilter.trim().toLowerCase();
  const shown = items.filter((i) => !q || i.title.toLowerCase().includes(q)).slice(0, 200);
  if (!shown.length) return html`<p class="sg-faint">Nothing to assign.</p>`;
  return html`<div class="acx-res">
    ${shown.map((i) => {
      const on = i.workspaceIds.includes(w.id);
      return html`<label class="acx-res__row ${on ? "is-on" : ""}">
        ${toggle(on, async () => {
          await call("access.assign", { resourceType: S.resourceType, resourceId: i.id, workspaceId: w.id, assigned: !on });
          i.workspaceIds = on ? i.workspaceIds.filter((x) => x !== w.id) : [...i.workspaceIds, w.id];
          void reload();
        }, { label: `Share ${i.title}` })}
        <span class="acx-res__title">${i.kind === "folder" ? sgIcon("layers", 13) : nothing} ${i.title}</span>
        ${i.kind === "folder" && on ? html`<span class="sg-faint">includes everything inside</span>` : nothing}
        ${i.workspaceIds.filter((x) => x !== w.id).map((x) => sgChip(wsName(x)))}
      </label>`;
    })}
  </div>`;
}

function effectiveGrant(role: Role, layer: Partial<Record<Role, Allowance>>, type: string, action: "view" | "edit", wsOverride?: Allowance): { on: boolean; inherited: boolean } {
  const def = S.data!.shape.defaults[role]?.resources?.[type]?.[action] ?? false;
  const g = layer[role]?.resources?.[type]?.[action];
  let on = typeof g === "boolean" ? g : def;
  let inherited = typeof g !== "boolean";
  if (wsOverride) {
    const o = wsOverride.resources?.[type]?.[action];
    if (typeof o === "boolean") {
      on = o;
      inherited = false;
    } else inherited = true;
  }
  return { on, inherited };
}

function renderPermissions(me: AccessMe | null): TemplateResult {
  const d = S.data!;
  const owner = isOwner(me);
  const scope = S.matrixScope;
  const ws = scope === "global" ? null : d.workspaces.find((w) => w.id === scope) ?? null;
  // Draft = global matrix, or the workspace's override layer.
  if (!S.matrixDraft) S.matrixDraft = JSON.parse(JSON.stringify(ws ? ws.roleOverrides : d.matrix)) as Partial<Record<Role, Allowance>>;
  const draft = S.matrixDraft;
  const roles = d.shape.roles;
  const set = (role: Role, kind: "resources" | "features", key: string, action: string | null, value: boolean | undefined) => {
    const layer = (draft[role] ??= {});
    if (kind === "resources") {
      const res = (layer.resources ??= {});
      const g = (res[key] ??= {});
      if (value === undefined) delete (g as Record<string, boolean>)[action!];
      else (g as Record<string, boolean>)[action!] = value;
      // Edit implies view; removing view removes edit.
      if (action === "edit" && value) g.view = true;
      if (action === "view" && value === false) g.edit = false;
    } else {
      const f = (layer.features ??= {});
      if (value === undefined) delete f[key];
      else f[key] = value;
    }
    _update();
  };
  const cell = (role: Role, type: string, action: "view" | "edit") => {
    const g = ws
      ? effectiveGrant(role, d.matrix, type, action, draft[role])
      : effectiveGrant(role, draft, type, action);
    return toggle(g.on, () => set(role, "resources", type, action, !g.on), {
      label: `${role} ${action} ${RESOURCE_LABELS[type] ?? type}`,
      inherited: g.inherited,
    });
  };
  const featureCell = (role: Role, f: string) => {
    const def = d.shape.defaults[role]?.features?.[f] ?? false;
    const base = (ws ? d.matrix : draft)[role]?.features?.[f];
    const over = ws ? draft[role]?.features?.[f] : undefined;
    const on = typeof over === "boolean" ? over : typeof base === "boolean" ? base : def;
    const secureLocked = f === "secure";
    return toggle(secureLocked ? false : on, () => set(role, "features", f, null, !on), {
      label: `${role} ${FEATURE_LABELS[f]}`,
      inherited: ws ? typeof over !== "boolean" : typeof base !== "boolean",
      disabled: secureLocked,
    });
  };
  return html`
    <div class="acx-head">
      <div>
        <h2 class="sg-h2">Visibility &amp; permissions</h2>
        <p class="sg-faint">Roles × what they can see and change. Dimmed switches are inherited${ws ? " from the global defaults" : " from the built-in defaults"}. Anything not switched on is denied.</p>
      </div>
      <div class="sg-actions">
        <select class="sg-input acx-select" .value=${scope} @change=${(e: Event) => {
          S.matrixScope = (e.target as HTMLSelectElement).value;
          S.matrixDraft = null;
          _update();
        }}>
          <option value="global">Global defaults</option>
          ${d.workspaces.map((w) => html`<option value=${w.id} ?selected=${w.id === scope}>Override: ${w.name}</option>`)}
        </select>
        <button class="sg-btn sg-btn--ghost" @click=${() => {
          S.matrixDraft = ws ? {} : {};
          _update();
        }}>${sgIcon("refresh", 14)} Reset</button>
        <button class="sg-btn sg-btn--primary" @click=${async () => {
          if (ws) await act("access.workspaces.update", { id: ws.id, roleOverrides: draft }, `Overrides saved for ${ws.name}`);
          else await act("access.matrix.set", { matrix: draft }, "Permission matrix saved");
          S.matrixDraft = null;
          _update();
        }}>${sgIcon("check", 15)} Save</button>
      </div>
    </div>
    <div class="acx-table-wrap"><table class="sg-table acx-matrix">
      <thead>
        <tr><th rowspan="2">Resource</th>${roles.map((r) => html`<th colspan="2" class="acx-c">${roleChip(r)}</th>`)}</tr>
        <tr>${roles.map(() => html`<th class="acx-c sg-faint">View</th><th class="acx-c sg-faint">Edit</th>`)}</tr>
      </thead>
      <tbody>
        ${d.shape.resourceTypes.map(
          (t) => html`<tr>
            <td><span class="acx-res-label">${sgIcon(RESOURCE_ICONS[t] ?? "file", 14)} ${RESOURCE_LABELS[t] ?? t}</span></td>
            ${roles.map((r) => html`<td class="acx-c">${cell(r, t, "view")}</td><td class="acx-c">${cell(r, t, "edit")}</td>`)}
          </tr>`,
        )}
        <tr class="acx-matrix__sep"><td colspan=${1 + roles.length * 2}>Features</td></tr>
        ${d.shape.features.map(
          (f) => html`<tr>
            <td><span class="acx-res-label">${sgIcon(f === "secure" ? "lock" : f === "finance" ? "activity" : f === "coders" ? "bolt" : "users", 14)} ${FEATURE_LABELS[f] ?? f}</span></td>
            ${roles.map((r) => html`<td colspan="2" class="acx-c">${featureCell(r, f)}</td>`)}
          </tr>`,
        )}
      </tbody>
    </table></div>
    <p class="sg-faint acx-hint">${sgIcon("lock", 12)} Secure Mode is never granted by a role. ${owner ? "Grant it to one person from Users → their custom permissions if you really need to." : "Only the owner can grant it."}</p>
  `;
}

async function loadPreview() {
  S.preview = null;
  _update();
  if (!S.previewUser) return;
  S.preview = await call<Preview>("access.preview", { userId: S.previewUser });
  _update();
}

function renderPreview(): TemplateResult {
  const d = S.data!;
  const p = S.preview;
  const u = d.users.find((x) => x.id === S.previewUser);
  return html`
    <div class="acx-head">
      <div>
        <h2 class="sg-h2">Preview as user</h2>
        <p class="sg-faint">Exactly what the gateway will let this person see and do, computed by the same rules it enforces.</p>
      </div>
      <div class="sg-actions">
        <select class="sg-input acx-select" .value=${S.previewUser} @change=${(e: Event) => {
          S.previewUser = (e.target as HTMLSelectElement).value;
          void loadPreview();
        }}>
          <option value="">Choose a user…</option>
          ${d.users.map((x) => html`<option value=${x.id} ?selected=${x.id === S.previewUser}>${x.displayName} (@${x.username}) · ${x.role}</option>`)}
        </select>
        <button class="sg-btn sg-btn--primary" ?disabled=${!S.previewUser || u?.disabled} title="Opens a read-only session as this user in a new tab"
          @click=${async () => {
            const r = await call<{ token: string }>("access.preview.session", { userId: S.previewUser });
            if (!r) return;
            const url = new URL(location.href);
            url.pathname = url.pathname.replace(/\/access\/?$/, "/projects");
            url.searchParams.set("accessPreview", r.token);
            window.open(url.toString(), "_blank", "noopener");
          }}>${sgIcon("eye", 15)} Open live preview</button>
      </div>
    </div>
    ${!S.previewUser
      ? sgEmpty({ icon: "eye", title: "Pick someone to preview", body: "You'll see their workspaces, permissions and the exact records visible to them." })
      : !p
        ? html`<p class="sg-faint">Loading…</p>`
        : html`
            <div class="acx-preview-head sg-card">
              <span class="acx-avatar">${(p.user.displayName || p.user.username).slice(0, 1).toUpperCase()}</span>
              <div><strong>${p.user.displayName}</strong> ${roleChip(p.user.role)}
                <div class="acx-chips">
                  ${Object.entries(p.features).map(([f, on]) => sgChip(html`${sgIcon(on ? "check" : "close", 11)} ${FEATURE_LABELS[f] ?? f}`, on ? "ok" : undefined))}
                </div>
              </div>
            </div>
            ${p.workspaces.length === 0
              ? sgEmpty({ icon: "layers", title: "Not in any workspace", body: "They can sign in but will see nothing until you add them to a workspace." })
              : html`<div class="acx-ws-grid">${p.workspaces.map(
                  (w) => html`<div class="sg-card acx-ws">
                    <div class="acx-ws__top"><span class="acx-ws__icon">${sgIcon("layers", 18)}</span><strong>${w.name}</strong><span class="sg-spacer"></span>${roleChip(w.role)}</div>
                    <div class="acx-perm-grid">
                      ${Object.entries(w.perms.resources).map(
                        ([t, g]) => html`<span class="acx-perm ${g.view ? "is-on" : ""}">${sgIcon(RESOURCE_ICONS[t] ?? "file", 12)} ${RESOURCE_LABELS[t] ?? t}
                          <em>${g.edit ? "edit" : g.view ? "view" : "hidden"}</em></span>`,
                      )}
                    </div>
                  </div>`,
                )}</div>`}
            <h3 class="sg-h2 acx-h3">Visible records</h3>
            <div class="acx-visible">
              ${ASSIGNABLE.map((t) => {
                const list = p.visible[t] ?? [];
                return html`<div class="sg-card">
                  <div class="acx-card-title">${sgIcon(RESOURCE_ICONS[t], 14)} ${RESOURCE_LABELS[t]} <span class="sg-faint">${list.length}</span></div>
                  ${list.length ? html`<ul class="acx-vlist">${list.slice(0, 30).map((r) => html`<li>${r.title}</li>`)}</ul>` : html`<p class="sg-faint">None</p>`}
                </div>`;
              })}
            </div>
          `}
  `;
}

function renderAudit(): TemplateResult {
  return html`
    <div class="acx-head">
      <div>
        <h2 class="sg-h2">Audit log</h2>
        <p class="sg-faint">Every sign-in, access change and denied request by a workspace user.</p>
      </div>
      <div class="sg-actions">
        <span class="acx-inline">${toggle(S.auditDeniedOnly, () => ((S.auditDeniedOnly = !S.auditDeniedOnly), void loadAudit()), { label: "Denied only" })} Denied only</span>
        <button class="sg-btn sg-btn--ghost" @click=${() => void loadAudit()}>${sgIcon("refresh", 14)} Refresh</button>
      </div>
    </div>
    ${S.audit.length === 0
      ? sgEmpty({ icon: "activity", title: "Nothing logged yet" })
      : html`<div class="acx-table-wrap"><table class="sg-table acx-table">
          <thead><tr><th>When</th><th>Who</th><th>What</th><th>Target</th><th>Result</th></tr></thead>
          <tbody>${S.audit.map(
            (e) => html`<tr>
              <td class="sg-faint">${new Date(e.ts).toLocaleString()}</td>
              <td>${e.actor}</td>
              <td><code class="sg-mono">${e.method ?? e.action}</code></td>
              <td class="sg-faint acx-trunc">${e.target ?? ""}</td>
              <td>${e.allowed ? sgChip("allowed", "ok") : sgChip(html`denied${e.detail ? html` · ${e.detail}` : nothing}`, "bad")}</td>
            </tr>`,
          )}</tbody>
        </table></div>`}
  `;
}

function renderAccount(me: Extract<AccessMe, { owner: false }>, client: GatewayBrowserClient): TemplateResult {
  return html`
    <div class="acx-split">
      <div class="sg-card acx-form">
        <div class="acx-card-title">${sgIcon("layers", 16)} Your workspaces</div>
        ${me.workspaces.length === 0
          ? html`<p class="sg-faint">You haven't been added to a workspace yet. Ask your admin.</p>`
          : me.workspaces.map(
              (w) => html`<div class="acx-member">
                <span class="acx-ws__icon">${sgIcon("layers", 14)}</span>
                <span class="acx-member__name">${w.name}</span>
                ${roleChip(w.role)}
                ${me.activeWorkspaceId === w.id
                  ? sgChip("current", "gold")
                  : html`<button class="sg-btn sg-btn--sm" @click=${async () => {
                      await call("access.workspace.select", { workspaceId: w.id });
                      ensureAccessMe(client, _update, true);
                    }}>Switch</button>`}
              </div>`,
            )}
        <p class="sg-faint acx-hint">New projects and documents you create go into your current workspace.</p>
      </div>
      <div class="sg-card acx-form">
        <div class="acx-card-title">${sgIcon("key", 16)} Change password</div>
        <label>Current password<input class="sg-input" type="password" autocomplete="current-password" .value=${S.pw.current} @input=${(e: Event) => (S.pw.current = (e.target as HTMLInputElement).value)} /></label>
        <label>New password<input class="sg-input" type="password" autocomplete="new-password" .value=${S.pw.next} @input=${(e: Event) => (S.pw.next = (e.target as HTMLInputElement).value)} /></label>
        <div class="acx-form__actions">
          <button class="sg-btn sg-btn--primary" @click=${async () => {
            const r = await call("access.password.change", { current: S.pw.current, next: S.pw.next });
            if (r) {
              S.pw = { current: "", next: "" };
              S.notice = "Password changed — sign in again with the new one.";
              _update();
            }
          }}>Update password</button>
        </div>
        <div class="sg-divider"></div>
        <div class="acx-card-title">${sgIcon("lock", 16)} Two-factor sign-in</div>
        ${me.user.totpEnabled
          ? html`<p>${sgChip("on", "ok", true)} Codes from your authenticator are required at sign-in.</p>
              <label>Current code<input class="sg-input acx-num" inputmode="numeric" maxlength="6" .value=${S.totpCode} @input=${(e: Event) => (S.totpCode = (e.target as HTMLInputElement).value)} /></label>
              <div class="acx-form__actions"><button class="sg-btn sg-btn--danger" @click=${async () => {
                const r = await call("access.totp.disable", { code: S.totpCode });
                if (r) ((S.totpCode = ""), (S.notice = "Two-factor turned off"), ensureAccessMe(client, _update, true));
              }}>Turn off</button></div>`
          : S.totp
            ? html`<p class="sg-faint">Add this key to your authenticator app (Google Authenticator, 1Password, Authy), then enter the 6-digit code.</p>
                <div class="acx-link"><code class="sg-mono">${S.totp.secret}</code><button class="sg-btn sg-btn--sm" @click=${() => void copy(S.totp!.uri)}>${sgIcon("copy", 14)} Copy setup link</button></div>
                <label>Code<input class="sg-input acx-num" inputmode="numeric" maxlength="6" .value=${S.totpCode} @input=${(e: Event) => (S.totpCode = (e.target as HTMLInputElement).value)} /></label>
                <div class="acx-form__actions"><button class="sg-btn sg-btn--primary" @click=${async () => {
                  const r = await call("access.totp.enable", { code: S.totpCode });
                  if (r) ((S.totp = null), (S.totpCode = ""), (S.notice = "Two-factor is on"), ensureAccessMe(client, _update, true));
                }}>Verify &amp; turn on</button></div>`
            : html`<p class="sg-faint">Off. Add a second step with an authenticator app.</p>
                <div class="acx-form__actions"><button class="sg-btn" @click=${async () => {
                  S.totp = await call<{ secret: string; uri: string }>("access.totp.setup", {});
                  _update();
                }}>${sgIcon("shield", 14)} Set up two-factor</button></div>`}
      </div>
    </div>
  `;
}

// ── Page ──────────────────────────────────────────────────────────────

export function renderAccessAdmin(
  state: { requestUpdate?: () => void },
  client: GatewayBrowserClient,
): TemplateResult {
  ensureSystemGlass();
  ensureAccessCss();
  _client = client;
  _update = () => state.requestUpdate?.();
  ensureAccessMe(client, _update);
  const me = getAccessMe();
  const admin = !me || me.isAdmin;

  if (!admin) {
    if (S.section !== "account") S.section = "account";
  } else if (S.loadedFor !== client) {
    S.loadedFor = client;
    void reload();
  }

  const d = S.data;
  const sections: { id: Section; label: string; icon: SgIconName }[] = admin
    ? [
        { id: "users", label: "Users", icon: "users" },
        { id: "invites", label: "Invites", icon: "link" },
        { id: "workspaces", label: "Workspaces", icon: "layers" },
        { id: "permissions", label: "Permissions", icon: "shield" },
        { id: "preview", label: "Preview as user", icon: "eye" },
        { id: "audit", label: "Audit", icon: "activity" },
        ...(me && !me.owner ? [{ id: "account" as Section, label: "My account", icon: "user" as SgIconName }] : []),
      ]
    : [{ id: "account", label: "My account", icon: "user" }];

  const activeInvites = d?.invites.filter((i) => i.status === "active").length ?? 0;
  return html`<div class="sg-page acx-page">
    ${sgAurora()}
    ${sgHero({
      eyebrow: "Settings",
      title: "Team &",
      accent: "Access",
      icon: "shield",
      sub: admin
        ? "Invite people, group your data into workspaces and decide exactly what each person can see."
        : "Your account, your workspaces and how you sign in.",
      status: admin && d
        ? d.enabled
          ? { tone: "ok", label: "Multi-user on" }
          : { tone: "warn", label: "Multi-user off" }
        : undefined,
      stats:
        admin && d
          ? [
              { label: "People", value: d.users.length, tone: "gold" },
              { label: "Active invites", value: activeInvites },
              { label: "Workspaces", value: d.workspaces.length },
              { label: "Disabled", value: d.users.filter((u) => u.disabled).length },
            ]
          : undefined,
    })}
    ${admin && d && !d.enabled
      ? html`<div class="acx-banner acx-banner--warn">${sgIcon("alert", 15)}
          <span>Workspace sign-in is <strong>off</strong>. You can set everything up now; invitees can sign up once the owner sets <code class="sg-mono">auth.multiUser.enabled: true</code> in the gateway config (no restart needed).</span></div>`
      : nothing}
    ${S.error ? html`<div class="acx-banner acx-banner--bad" role="alert">${sgIcon("alert", 15)}<span>${S.error}</span><button class="sg-btn sg-btn--sm sg-btn--ghost" @click=${() => ((S.error = null), _update())}>${sgIcon("close", 13)}</button></div>` : nothing}
    ${S.notice ? html`<div class="acx-banner acx-banner--ok" role="status">${sgIcon("check", 15)}<span>${S.notice}</span><button class="sg-btn sg-btn--sm sg-btn--ghost" @click=${() => ((S.notice = null), _update())}>${sgIcon("close", 13)}</button></div>` : nothing}
    ${S.secret
      ? html`<div class="acx-banner acx-banner--gold">${sgIcon("key", 15)}<span>${S.secret.label}: <code class="sg-mono">${S.secret.value}</code> — share it privately; it is shown once.</span>
          <button class="sg-btn sg-btn--sm" @click=${() => void copy(S.secret!.value)}>${sgIcon("copy", 13)} Copy</button>
          <button class="sg-btn sg-btn--sm sg-btn--ghost" @click=${() => ((S.secret = null), _update())}>${sgIcon("close", 13)}</button></div>`
      : nothing}
    <nav class="sg-seg acx-tabs" role="tablist" aria-label="Team and access sections">
      ${sections.map(
        (s) => html`<button role="tab" class=${S.section === s.id ? "is-active" : ""} aria-selected=${S.section === s.id}
          @click=${() => {
            S.section = s.id;
            S.matrixDraft = null;
            if (s.id === "audit") void loadAudit();
            _update();
          }}>${sgIcon(s.icon, 14)} <span>${s.label}</span></button>`,
      )}
    </nav>
    <section class="acx-body">
      ${S.section === "account" && me && !me.owner
        ? renderAccount(me, client)
        : !d
          ? html`<div class="sg-card"><p class="sg-faint">${S.loading ? "Loading…" : "No data"}</p></div>`
          : S.section === "users"
            ? renderUsers(me)
            : S.section === "invites"
              ? renderInvites(me)
              : S.section === "workspaces"
                ? renderWorkspaces(me)
                : S.section === "permissions"
                  ? renderPermissions(me)
                  : S.section === "preview"
                    ? renderPreview()
                    : renderAudit()}
    </section>
  </div>`;
}

/** Test/preview hook: jump to a section (e.g. from ui_control). */
export function setAccessSection(section: Section): void {
  S.section = section;
  if (section === "audit") void loadAudit();
}

// ── Styles ────────────────────────────────────────────────────────────

const CSS_ID = "access-admin-css";
function ensureAccessCss() {
  if (typeof document === "undefined" || document.getElementById(CSS_ID)) return;
  const el = document.createElement("style");
  el.id = CSS_ID;
  el.textContent = ACCESS_CSS;
  document.head.appendChild(el);
}

const ACCESS_CSS = `
.acx-page { display: flex; flex-direction: column; gap: 18px; padding-bottom: 48px; }
.acx-tabs { align-self: flex-start; flex-wrap: wrap; }
.acx-tabs button { display: inline-flex; align-items: center; gap: 6px; }
.acx-body { display: flex; flex-direction: column; gap: 16px; }
.acx-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.acx-head > div:first-child { flex: 1 1 360px; min-width: 0; }
.acx-head h2 { margin: 0 0 4px; }
.acx-head p { margin: 0; font-size: 13px; line-height: 1.5; text-transform: none; letter-spacing: normal; }
.acx-head .sg-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; justify-content: flex-end; flex: 0 1 auto; }
.acx-head .sg-actions .sg-input { width: auto; min-width: 200px; }
.acx-banner { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-radius: var(--sg-radius-sm);
  border: 1px solid rgba(217,180,95,.28); background: rgba(217,180,95,.07); color: var(--sg-fg-2); font-size: 13px; }
.acx-banner span { flex: 1; min-width: 0; }
.acx-banner--warn { border-color: rgba(231,167,75,.4); background: rgba(231,167,75,.08); }
.acx-banner--bad { border-color: rgba(227,107,107,.45); background: rgba(227,107,107,.08); }
.acx-banner--ok { border-color: rgba(76,201,138,.4); background: rgba(76,201,138,.07); }
.acx-banner--gold code { color: var(--sg-gold-hi); }
.acx-table-wrap { overflow-x: auto; border-radius: var(--sg-radius-md); }
.acx-table td, .acx-matrix td { vertical-align: middle; }
.acx-table tr.is-disabled td { opacity: .55; }
.acx-r { text-align: right; }
.acx-c { text-align: center; }
.acx-user { display: flex; align-items: center; gap: 10px; }
.acx-user strong { display: block; color: var(--sg-fg); }
.acx-sub { display: block; font-size: 12px; }
.acx-avatar { width: 34px; height: 34px; border-radius: 50%; flex: none; display: grid; place-items: center; font-weight: 700;
  color: #120d02; background: linear-gradient(135deg, var(--sg-gold-hi), var(--sg-gold-deep)); box-shadow: 0 0 0 1px rgba(241,211,138,.35), 0 4px 14px rgba(217,180,95,.25); }
.acx-avatar--sm { width: 24px; height: 24px; font-size: 11px; }
.acx-chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.acx-row-actions { display: inline-flex; gap: 4px; }
.acx-select { min-width: 120px; width: auto !important; flex: none; }
.acx-form { display: flex; flex-direction: column; gap: 12px; }
.acx-form label { display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: var(--sg-fg-3); flex: 1; min-width: 160px; }
.acx-form__row { display: flex; gap: 12px; flex-wrap: wrap; }
.acx-form__row--inline { align-items: center; }
.acx-form__label { font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: var(--sg-fg-3); margin-top: 4px; }
.acx-form__actions { display: flex; justify-content: flex-end; gap: 8px; }
.acx-card-title { display: flex; align-items: center; gap: 8px; font-weight: 600; color: var(--sg-fg); }
.acx-card-title svg { color: var(--sg-gold); }
.acx-hint { font-size: 12px; margin: 0; display: flex; align-items: center; gap: 6px; }
.acx-inline { display: inline-flex !important; flex-direction: row !important; align-items: center; gap: 10px; font-size: 13px; color: var(--sg-fg-2); }
.acx-num { width: 110px; }
.acx-picks { display: flex; flex-wrap: wrap; gap: 8px; }
.acx-pick { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 999px; cursor: pointer; font: inherit; font-size: 13px;
  border: 1px solid rgba(244,241,234,.14); background: rgba(255,255,255,.03); color: var(--sg-fg-2); transition: all var(--sg-dur) var(--sg-ease); }
.acx-pick:hover { border-color: rgba(217,180,95,.45); }
.acx-pick.is-on { border-color: var(--sg-gold); color: var(--sg-gold-hi); background: rgba(217,180,95,.12); }
.acx-toggle { position: relative; width: 38px; height: 22px; border-radius: 999px; border: 1px solid rgba(244,241,234,.18); cursor: pointer; flex: none;
  background: rgba(255,255,255,.06); padding: 0; transition: background var(--sg-dur) var(--sg-ease), border-color var(--sg-dur) var(--sg-ease); }
.acx-toggle__knob { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--sg-fg-3);
  transition: transform var(--sg-dur) var(--sg-spring), background var(--sg-dur) var(--sg-ease); }
.acx-toggle.is-on { background: linear-gradient(135deg, rgba(241,211,138,.9), rgba(168,118,44,.9)); border-color: var(--sg-gold); }
.acx-toggle.is-on .acx-toggle__knob { transform: translateX(16px); background: #120d02; }
.acx-toggle.is-inherited { opacity: .55; }
.acx-toggle:disabled { cursor: not-allowed; opacity: .3; }
.acx-toggle:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--sg-gold); }
.acx-split { display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr); gap: 16px; align-items: start; }
.acx-list { display: flex; flex-direction: column; gap: 10px; }
.acx-invite { display: flex; flex-direction: column; gap: 8px; }
.acx-invite__top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.acx-link { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 10px; border-radius: var(--sg-radius-sm); border: 1px dashed rgba(217,180,95,.4); background: rgba(217,180,95,.05); }
.acx-link code { flex: 1; min-width: 0; overflow-wrap: anywhere; color: var(--sg-gold-hi); font-size: 12px; }
.acx-link p { flex-basis: 100%; margin: 0; font-size: 12px; }
.acx-ok { color: var(--sg-ok); display: inline-flex; gap: 4px; align-items: center; font-size: 12px; }
.acx-warn { color: var(--sg-warn); display: inline-flex; gap: 4px; align-items: center; font-size: 12px; }
.acx-ws-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 14px; }
.acx-ws { display: flex; flex-direction: column; gap: 10px; }
.acx-ws.is-open { grid-column: 1 / -1; }
.acx-ws__top { display: flex; align-items: center; gap: 10px; }
.acx-ws__icon { width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center; flex: none; color: var(--sg-gold);
  background: rgba(217,180,95,.1); border: 1px solid rgba(217,180,95,.25); }
.acx-ws__name strong { color: var(--sg-fg); }
.acx-ws__body { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr); gap: 18px; padding-top: 6px; border-top: 1px solid rgba(244,241,234,.08); }
.acx-member { display: flex; align-items: center; gap: 8px; padding: 6px 0; flex-wrap: wrap; }
.acx-member__name { flex: 1; min-width: 120px; color: var(--sg-fg); }
.acx-member .acx-select { min-width: 110px; }
.acx-seg { margin: 6px 0; flex-wrap: wrap; }
.acx-seg button { display: inline-flex; align-items: center; gap: 5px; }
.acx-filter { margin: 6px 0; width: 100%; box-sizing: border-box; }
.acx-res { display: flex; flex-direction: column; max-height: 360px; overflow: auto; border-radius: var(--sg-radius-sm); border: 1px solid rgba(244,241,234,.08); }
.acx-res__row { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-bottom: 1px solid rgba(244,241,234,.05); cursor: default; flex-wrap: wrap; }
.acx-res__row.is-on { background: rgba(217,180,95,.06); }
.acx-res__title { flex: 1; min-width: 0; color: var(--sg-fg); display: inline-flex; align-items: center; gap: 6px; }
.acx-matrix th, .acx-matrix td { padding: 8px 10px; }
.acx-matrix__sep td { font-size: 11px; letter-spacing: .1em; text-transform: uppercase; color: var(--sg-gold); padding-top: 16px; }
.acx-res-label { display: inline-flex; align-items: center; gap: 8px; color: var(--sg-fg); white-space: nowrap; }
.acx-res-label svg { color: var(--sg-gold); }
.acx-preview-head { display: flex; gap: 14px; align-items: center; }
.acx-perm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 6px; }
.acx-perm { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--sg-fg-4); padding: 6px 8px; border-radius: 8px; border: 1px solid rgba(244,241,234,.06); }
.acx-perm em { margin-left: auto; font-style: normal; font-size: 11px; }
.acx-perm.is-on { color: var(--sg-fg-2); border-color: rgba(217,180,95,.25); }
.acx-perm.is-on em { color: var(--sg-gold-hi); }
.acx-h3 { margin-top: 8px; }
.acx-visible { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
.acx-vlist { margin: 6px 0 0; padding-left: 18px; color: var(--sg-fg-2); font-size: 13px; }
.acx-allow-row td { background: rgba(217,180,95,.04); }
.acx-allow { display: flex; flex-direction: column; gap: 12px; padding: 6px 2px; }
.acx-allow__head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
.acx-allow__head .sg-actions { display: flex; gap: 8px; }
.acx-allow__grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 6px 18px; }
.acx-allow__item { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 6px 0; border-bottom: 1px solid rgba(244,241,234,.05); }
.acx-allow__pair { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; }
.acx-tri { display: inline-flex; align-items: center; gap: 4px; min-width: 70px; justify-content: center; padding: 4px 8px; border-radius: 999px; cursor: pointer;
  font: inherit; font-size: 11px; color: var(--sg-fg-3); background: rgba(255,255,255,.03); border: 1px dashed rgba(244,241,234,.18); transition: all var(--sg-dur) var(--sg-ease); }
.acx-tri.is-allow { color: #120d02; background: linear-gradient(135deg, var(--sg-gold-hi), var(--sg-gold-deep)); border: 1px solid var(--sg-gold); }
.acx-tri.is-deny { color: #f3b5b5; background: rgba(227,107,107,.12); border: 1px solid rgba(227,107,107,.5); }
.acx-tri:disabled { opacity: .35; cursor: not-allowed; }
.acx-tri:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--sg-gold); }
.acx-trunc { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 900px) {
  .acx-split, .acx-ws__body { grid-template-columns: 1fr; }
}
@media (max-width: 560px) {
  .acx-tabs button span { display: none; }
  .acx-head .sg-actions { width: 100%; }
  .acx-head .sg-actions > * { flex: 1; }
  .acx-table th:nth-child(3), .acx-table td:nth-child(3), .acx-table th:nth-child(4), .acx-table td:nth-child(4) { display: none; }
}
`;
