/**
 * Users view — admin CRUD + per-user prefs page at /users.
 *
 * Layout: list on the left, edit form on the right. Non-admin users
 * see only their own self-edit form (the list collapses to a single
 * row). The "New User" button is admin-only.
 */

import { html, nothing } from "lit";
import type { GatewayBrowserClient } from "../gateway";
import {
  type UsersState,
  type UserRecord,
  loadUsersAndMe,
  createUser,
  saveEdit,
  deleteUser,
  openCreateDialog,
  closeCreateDialog,
  updateCreateField,
  selectUser,
  updateEditField,
  createInitialUsersState,
} from "../controllers/users";
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

interface UsersHost {
  users?: UsersState;
  client: GatewayBrowserClient | null;
  requestUpdate?: () => void;
}

export function ensureUsersState<T extends UsersHost>(state: T): UsersState {
  if (!state.users) state.users = createInitialUsersState();
  return state.users;
}

let _autoLoaded = false;

export function renderUsers<T extends UsersHost>(state: T, client: GatewayBrowserClient) {
  const us = ensureUsersState(state);
  if (!_autoLoaded) {
    _autoLoaded = true;
    void loadUsersAndMe(state as { users: UsersState; requestUpdate?: () => void }, client);
  }

  ensureSystemGlass();
  injectStyles();

  const meRecord = us.me?.user ?? null;
  const isAdmin = us.me?.implicitAdmin || meRecord?.role === "admin";
  const visibleUsers = isAdmin ? us.users : meRecord ? [meRecord] : [];
  const host = state as { users: UsersState; requestUpdate?: () => void };
  const userCount = us.me?.userCount ?? us.users.length;
  const adminCount = us.me?.adminCount ?? us.users.filter((u) => u.role === "admin").length;
  const gatedCount = us.users.filter((u) => u.agentGatingEnabled).length;
  const access = isAdmin ? "Admin" : us.me ? "Member" : "—";
  const accessFoot = us.me?.implicitAdmin ? "Implicit · gateway password" : meRecord?.username ?? "Gateway password";

  return html`
    <div class="sg-page sg-users users-page">
      ${sgAurora()}
      <div data-learn-id="users-header">
        ${sgHero({
          eyebrow: "Settings",
          title: "Users",
          accent: "& Access",
          icon: "users",
          sub: us.me?.implicitAdmin
            ? "No accounts yet — you're connected as the implicit admin. Create the first account to start sharing this gateway safely."
            : isAdmin
              ? "Accounts, roles and per-user sandboxes. Each user gets their own gateway password, home directory and agent context."
              : "Your profile — language and background context the agents see every session.",
          status: us.loading
            ? { tone: "info", label: "Loading" }
            : us.me?.implicitAdmin
              ? { tone: "gold", label: "Implicit admin" }
              : isAdmin
                ? { tone: "ok", label: "Admin view" }
                : { tone: "ok", label: "Signed in" },
          actions: html`
            <button class="sg-btn users-btn users-btn-ghost" @click=${() => loadUsersAndMe(host, client)}>
              ${sgIcon("refresh", 15)} Refresh
            </button>
            ${isAdmin
              ? html`
                  <button
                    class="sg-btn sg-btn--primary users-btn users-btn-primary"
                    data-learn-id="users-new"
                    @click=${() => openCreateDialog(host)}
                  >
                    ${sgIcon("plus", 15)} New User
                  </button>
                `
              : nothing}
          `,
          stats: isAdmin
            ? [
                { label: "Users", value: us.loading && !us.me ? "—" : userCount, icon: "users", foot: userCount === 0 ? "None created yet" : "Registered accounts" },
                { label: "Admins", value: us.loading && !us.me ? "—" : adminCount, icon: "shield", tone: adminCount > 0 ? "gold" : undefined, foot: "Full gateway control" },
                { label: "Sandboxed", value: gatedCount, icon: "lock", foot: "Agent locked to dirs" },
                { label: "Your access", value: access, icon: "key", foot: accessFoot },
              ]
            : undefined,
        })}
      </div>

      ${us.error
        ? html`<div class="users-banner users-banner-error" role="alert">${sgIcon("alert", 15)}<span>${us.error}</span></div>`
        : nothing}
      ${us.success
        ? html`<div class="users-banner users-banner-success" role="status">${sgIcon("check", 15)}<span>${us.success}</span></div>`
        : nothing}

      <div class="users-layout">
        <aside class="users-list sg-panel" data-learn-id="users-list">
          <div class="sg-section-head">
            ${isAdmin ? "Accounts" : "You"} <span class="sg-count">${visibleUsers.length}</span>
          </div>
          <div class="users-rows">
            ${us.loading && visibleUsers.length === 0
              ? sgSkeleton(3, true)
              : visibleUsers.length === 0
                ? html`<div class="users-empty">
                    ${sgEmpty({
                      icon: us.me?.implicitAdmin ? "shield" : "users",
                      title: us.me?.implicitAdmin ? "You're the implicit admin" : "No users yet",
                      body: us.me?.implicitAdmin
                        ? "Anyone with the gateway password has full control. Create the first account — make it an admin — to start handing out scoped access."
                        : "Accounts appear here once an admin creates them.",
                      action: isAdmin
                        ? html`<button class="sg-btn sg-btn--primary" @click=${() => openCreateDialog(host)}>
                            ${sgIcon("plus", 15)} Create the first account
                          </button>`
                        : undefined,
                    })}
                  </div>`
                : visibleUsers.map((user) => renderRow(state, user, us.selectedId === user.id, meRecord?.id === user.id))}
          </div>
        </aside>
        <section class="users-detail sg-panel" data-learn-id="users-detail">
          ${us.editForm
            ? renderEditForm(state, client, isAdmin)
            : html`
                <div class="users-empty users-detail-empty">
                  ${sgEmpty({
                    icon: visibleUsers.length === 0 ? "spark" : "edit",
                    title: visibleUsers.length === 0 ? "Create a user to get started" : "Select a user",
                    body:
                      visibleUsers.length === 0
                        ? "Each account gets a login, a gateway password, a home directory for its agents and optional page + folder restrictions."
                        : "Pick an account on the left to edit its role, passwords, language, background context and sandbox.",
                  })}
                  ${visibleUsers.length === 0 && isAdmin
                    ? html`<ol class="users-steps">
                        <li><span class="users-step-ico">${sgIcon("shield", 15)}</span><span><strong>Create an admin account</strong>Your own login, so the shared gateway password can be retired.</span></li>
                        <li><span class="users-step-ico">${sgIcon("key", 15)}</span><span><strong>Hand out gateway passwords</strong>Each user connects with their own password — revoke one without touching the rest.</span></li>
                        <li><span class="users-step-ico">${sgIcon("lock", 15)}</span><span><strong>Sandbox their agents</strong>Lock agents to a home folder and limit which pages they can open.</span></li>
                      </ol>`
                    : nothing}
                </div>
              `}
        </section>
      </div>

      ${us.showCreateDialog ? renderCreateDialog(state, client) : nothing}
    </div>
  `;
}

function initials(name: string): string {
  const parts = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function monogram(name: string, admin: boolean, size: "sm" | "lg" = "sm") {
  return html`<span class="users-avatar users-avatar--${size} ${admin ? "users-avatar--admin" : ""}" aria-hidden="true">
    <span>${initials(name)}</span>
  </span>`;
}

function renderRow<T extends UsersHost>(state: T, user: UserRecord, isActive: boolean, isMe: boolean) {
  return html`
    <button
      class="users-row sg-card sg-card--interactive ${isActive ? "active" : ""}"
      aria-pressed=${isActive ? "true" : "false"}
      @pointermove=${sgGloss}
      @click=${() => selectUser(state as { users: UsersState; requestUpdate?: () => void }, user.id)}
    >
      ${monogram(user.username, user.role === "admin")}
      <span class="users-row-body">
        <span class="users-row-main">
          <span class="users-row-name">${user.username}</span>
          ${isMe ? html`<span class="users-you">you</span>` : nothing}
          <span class="users-row-led" title=${user.agentGatingEnabled ? "Sandboxed" : "Unrestricted"}>
            ${sgLed(user.agentGatingEnabled ? "warn" : "ok")}
          </span>
        </span>
        <span class="users-row-meta">
          ${user.role === "admin"
            ? html`<span class="users-pill admin sg-chip sg-chip--gold">${sgIcon("shield", 11)} admin</span>`
            : html`<span class="users-pill sg-chip">user</span>`}
          ${user.agentGatingEnabled ? html`<span class="users-pill gated sg-chip sg-chip--warn">${sgIcon("lock", 11)} gated</span>` : nothing}
          ${user.allowedPages.length > 0 ? html`<span class="sg-chip">${user.allowedPages.length} page${user.allowedPages.length === 1 ? "" : "s"}</span>` : nothing}
        </span>
        ${user.email ? html`<span class="users-row-email">${user.email}</span>` : nothing}
        <span class="users-row-home sg-mono" title="${user.homeDir}">${user.homeDir}</span>
      </span>
    </button>
  `;
}

function renderEditForm<T extends UsersHost>(state: T, client: GatewayBrowserClient, isAdmin: boolean) {
  const us = ensureUsersState(state);
  const f = us.editForm!;
  const target = us.users.find((u) => u.id === us.selectedId);

  return html`
    <form
      class="users-form"
      @submit=${(e: Event) => {
        e.preventDefault();
        void saveEdit(state as { users: UsersState; requestUpdate?: () => void }, client);
      }}
    >
      <div class="users-form-head">
        ${monogram(f.username || target?.username || "?", f.role === "admin", "lg")}
        <div class="users-form-title">
          <p class="sg-eyebrow">${isAdmin ? "Edit account" : "Your profile"}</p>
          <h3>${target?.username ?? f.username ?? "user"}</h3>
          <div class="users-row-meta">
            ${f.role === "admin"
              ? html`<span class="sg-chip sg-chip--gold">${sgIcon("shield", 11)} admin</span>`
              : html`<span class="sg-chip">user</span>`}
            ${f.agentGatingEnabled
              ? html`<span class="sg-chip sg-chip--warn">${sgIcon("lock", 11)} sandboxed</span>`
              : html`<span class="sg-chip sg-chip--ok">${sgLed("ok")} unrestricted</span>`}
          </div>
        </div>
      </div>

      <div class="sg-section-head users-group">Identity &amp; security</div>
      <div class="users-form-grid">
        <label class="users-field">
          <span>Username</span>
          <input
            class="sg-input"
            type="text"
            .value=${f.username}
            ?disabled=${!isAdmin}
            @input=${(e: Event) =>
              updateEditField(
                state as { users: UsersState; requestUpdate?: () => void },
                "username",
                (e.target as HTMLInputElement).value,
              )}
          />
        </label>

        <label class="users-field">
          <span>Email</span>
          <input
            class="sg-input"
            type="email"
            .value=${f.email}
            ?disabled=${!isAdmin}
            @input=${(e: Event) =>
              updateEditField(
                state as { users: UsersState; requestUpdate?: () => void },
                "email",
                (e.target as HTMLInputElement).value,
              )}
          />
        </label>

        <label class="users-field">
          <span>User password (leave blank to keep)</span>
          <input
            class="sg-input"
            type="password"
            autocomplete="new-password"
            .value=${f.password}
            @input=${(e: Event) =>
              updateEditField(
                state as { users: UsersState; requestUpdate?: () => void },
                "password",
                (e.target as HTMLInputElement).value,
              )}
          />
        </label>

        ${isAdmin
          ? html`
              <label class="users-field">
                <span>Gateway password (leave blank to keep)</span>
                <input
                  class="sg-input"
                  type="password"
                  autocomplete="new-password"
                  .value=${f.gatewayPassword}
                  @input=${(e: Event) =>
                    updateEditField(
                      state as { users: UsersState; requestUpdate?: () => void },
                      "gatewayPassword",
                      (e.target as HTMLInputElement).value,
                    )}
                />
                <small>The password the WebSocket connection uses for this user.</small>
              </label>
            `
          : nothing}

        ${isAdmin
          ? html`
              <label class="users-field">
                <span>Role</span>
                <select
                  class="sg-input"
                  .value=${f.role}
                  @change=${(e: Event) =>
                    updateEditField(
                      state as { users: UsersState; requestUpdate?: () => void },
                      "role",
                      (e.target as HTMLSelectElement).value as "admin" | "user",
                    )}
                >
                  <option value="user">user</option>
                  <option value="admin">admin</option>
                </select>
              </label>
            `
          : nothing}

        <div class="sg-section-head users-group users-field-wide">Personalisation</div>
        <label class="users-field">
          <span>Language</span>
          <input
            class="sg-input"
            type="text"
            placeholder="en, th, Spanish — formal register, …"
            .value=${f.language}
            @input=${(e: Event) =>
              updateEditField(
                state as { users: UsersState; requestUpdate?: () => void },
                "language",
                (e.target as HTMLInputElement).value,
              )}
          />
        </label>

        <label class="users-field users-field-wide">
          <span>Background context — prepended to the agent's system prompt every session</span>
          <textarea
            class="sg-input"
            rows="6"
            placeholder="e.g. I'm a senior backend engineer working on a Rust trading system. Default to terse answers."
            .value=${f.context}
            @input=${(e: Event) =>
              updateEditField(
                state as { users: UsersState; requestUpdate?: () => void },
                "context",
                (e.target as HTMLTextAreaElement).value,
              )}
          ></textarea>
        </label>

        ${isAdmin
          ? html`
              <div class="sg-section-head users-group users-field-wide">Agent sandbox</div>
              <label class="users-field users-field-wide">
                <span>Home directory (subagent default cwd)</span>
                <input
                  class="sg-input"
                  type="text"
                  .value=${f.homeDir}
                  @input=${(e: Event) =>
                    updateEditField(
                      state as { users: UsersState; requestUpdate?: () => void },
                      "homeDir",
                      (e.target as HTMLInputElement).value,
                    )}
                />
                <small>Defaults to <code>&lt;state&gt;/users/&lt;username&gt;/</code>. Subagents create projects here.</small>
              </label>

              <label class="users-field users-field-checkbox">
                <input
                  type="checkbox"
                  class="users-switch"
                  role="switch"
                  .checked=${f.agentGatingEnabled}
                  @change=${(e: Event) =>
                    updateEditField(
                      state as { users: UsersState; requestUpdate?: () => void },
                      "agentGatingEnabled",
                      (e.target as HTMLInputElement).checked,
                    )}
                />
                <span>Lock agent to home + allowed directories</span>
              </label>

              <label class="users-field users-field-wide">
                <span>Allowed directories (one per line) — only used when gating is enabled</span>
                <textarea
            class="sg-input"
                  rows="3"
                  placeholder="C:/projects/shared&#10;D:/datasets"
                  .value=${f.allowedDirs}
                  @input=${(e: Event) =>
                    updateEditField(
                      state as { users: UsersState; requestUpdate?: () => void },
                      "allowedDirs",
                      (e.target as HTMLTextAreaElement).value,
                    )}
                ></textarea>
              </label>

              <label class="users-field users-field-wide">
                <span>Allowed pages (comma-separated) — empty = all pages</span>
                <input
                  class="sg-input"
                  type="text"
                  placeholder="chat, projects, files, business"
                  .value=${f.allowedPages}
                  @input=${(e: Event) =>
                    updateEditField(
                      state as { users: UsersState; requestUpdate?: () => void },
                      "allowedPages",
                      (e.target as HTMLInputElement).value,
                    )}
                />
              </label>
            `
          : nothing}
      </div>

      <div class="users-form-actions">
        <button type="submit" class="sg-btn sg-btn--primary users-btn users-btn-primary" ?disabled=${us.saving}>
          ${us.saving ? "Saving…" : html`${sgIcon("check", 15)} Save changes`}
        </button>
        ${isAdmin && target && us.me?.user?.id !== target.id
          ? html`
              <button
                type="button"
                class="sg-btn sg-btn--danger users-btn users-btn-danger"
                ?disabled=${us.saving}
                @click=${() =>
                  void deleteUser(state as { users: UsersState; requestUpdate?: () => void }, client, target.id)}
              >
                ${sgIcon("trash", 14)} Delete
              </button>
            `
          : nothing}
      </div>
    </form>
  `;
}

function renderCreateDialog<T extends UsersHost>(state: T, client: GatewayBrowserClient) {
  const us = ensureUsersState(state);
  const f = us.createForm;
  return html`
    <div
      class="sg-backdrop users-dialog-backdrop"
      @click=${() => closeCreateDialog(state as { users: UsersState; requestUpdate?: () => void })}
    >
      <form
        class="sg-sheet users-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="New user"
        data-learn-id="users-dialog"
        @click=${(e: Event) => e.stopPropagation()}
        @submit=${(e: Event) => {
          e.preventDefault();
          void createUser(state as { users: UsersState; requestUpdate?: () => void }, client);
        }}
      >
        <div class="users-form-head">
          <span class="users-sheet-icon">${sgIcon("user", 22)}</span>
          <div class="users-form-title">
            <p class="sg-eyebrow">Users &amp; Access</p>
            <h3>New User</h3>
            <p class="users-sheet-sub">A login, a gateway password and a home directory for their agents.</p>
          </div>
          <button
            type="button"
            class="sg-btn sg-btn--ghost sg-btn--icon users-sheet-close"
            aria-label="Close"
            @click=${() => closeCreateDialog(state as { users: UsersState; requestUpdate?: () => void })}
          >${sgIcon("close", 16)}</button>
        </div>
        <div class="sg-section-head users-group">Account</div>
        <div class="users-form-grid">
          <label class="users-field">
            <span>Username</span>
            <input
              class="sg-input"
              type="text"
              required
              .value=${f.username}
              @input=${(e: Event) =>
                updateCreateField(
                  state as { users: UsersState; requestUpdate?: () => void },
                  "username",
                  (e.target as HTMLInputElement).value,
                )}
            />
          </label>
          <label class="users-field">
            <span>Email</span>
            <input
              class="sg-input"
              type="email"
              .value=${f.email}
              @input=${(e: Event) =>
                updateCreateField(
                  state as { users: UsersState; requestUpdate?: () => void },
                  "email",
                  (e.target as HTMLInputElement).value,
                )}
            />
          </label>
          <label class="users-field">
            <span>User password</span>
            <input
              class="sg-input"
              type="password"
              autocomplete="new-password"
              required
              .value=${f.password}
              @input=${(e: Event) =>
                updateCreateField(
                  state as { users: UsersState; requestUpdate?: () => void },
                  "password",
                  (e.target as HTMLInputElement).value,
                )}
            />
          </label>
          <label class="users-field">
            <span>Gateway password</span>
            <input
              class="sg-input"
              type="password"
              autocomplete="new-password"
              required
              .value=${f.gatewayPassword}
              @input=${(e: Event) =>
                updateCreateField(
                  state as { users: UsersState; requestUpdate?: () => void },
                  "gatewayPassword",
                  (e.target as HTMLInputElement).value,
                )}
            />
          </label>
          <label class="users-field" data-learn-id="users-role">
            <span>Role</span>
            <select
                  class="sg-input"
              .value=${f.role}
              @change=${(e: Event) =>
                updateCreateField(
                  state as { users: UsersState; requestUpdate?: () => void },
                  "role",
                  (e.target as HTMLSelectElement).value as "admin" | "user",
                )}
            >
              <option value="user">user</option>
              <option value="admin">admin</option>
            </select>
          </label>
          <div class="sg-section-head users-group users-field-wide">Personalisation &amp; sandbox</div>
          <label class="users-field">
            <span>Language</span>
            <input
              class="sg-input"
              type="text"
              .value=${f.language}
              @input=${(e: Event) =>
                updateCreateField(
                  state as { users: UsersState; requestUpdate?: () => void },
                  "language",
                  (e.target as HTMLInputElement).value,
                )}
            />
          </label>
          <label class="users-field users-field-wide">
            <span>Background context</span>
            <textarea
            class="sg-input"
              rows="3"
              .value=${f.context}
              @input=${(e: Event) =>
                updateCreateField(
                  state as { users: UsersState; requestUpdate?: () => void },
                  "context",
                  (e.target as HTMLTextAreaElement).value,
                )}
            ></textarea>
          </label>
          <label class="users-field users-field-wide">
            <span>Home directory (defaults to &lt;state&gt;/users/&lt;username&gt;/)</span>
            <input
              class="sg-input"
              type="text"
              .value=${f.homeDir}
              @input=${(e: Event) =>
                updateCreateField(
                  state as { users: UsersState; requestUpdate?: () => void },
                  "homeDir",
                  (e.target as HTMLInputElement).value,
                )}
            />
          </label>
          <label class="users-field users-field-checkbox" data-learn-id="users-lock-dirs">
            <input
              type="checkbox"
                  class="users-switch"
                  role="switch"
              .checked=${f.agentGatingEnabled}
              @change=${(e: Event) =>
                updateCreateField(
                  state as { users: UsersState; requestUpdate?: () => void },
                  "agentGatingEnabled",
                  (e.target as HTMLInputElement).checked,
                )}
            />
            <span>Lock agent to home + allowed directories</span>
          </label>
          <label class="users-field users-field-wide">
            <span>Allowed directories (one per line)</span>
            <textarea
            class="sg-input"
              rows="3"
              .value=${f.allowedDirs}
              @input=${(e: Event) =>
                updateCreateField(
                  state as { users: UsersState; requestUpdate?: () => void },
                  "allowedDirs",
                  (e.target as HTMLTextAreaElement).value,
                )}
            ></textarea>
          </label>
          <label class="users-field users-field-wide" data-learn-id="users-allowed-pages">
            <span>Allowed pages (comma-separated, empty = all)</span>
            <input
              class="sg-input"
              type="text"
              .value=${f.allowedPages}
              @input=${(e: Event) =>
                updateCreateField(
                  state as { users: UsersState; requestUpdate?: () => void },
                  "allowedPages",
                  (e.target as HTMLInputElement).value,
                )}
            />
          </label>
        </div>
        <div class="users-form-actions users-form-actions--end">
          <button
            type="button"
            class="sg-btn sg-btn--ghost users-btn users-btn-ghost"
            data-learn-id="users-dialog-cancel"
            @click=${() => closeCreateDialog(state as { users: UsersState; requestUpdate?: () => void })}
          >
            Cancel
          </button>
          <button type="submit" class="sg-btn sg-btn--primary users-btn users-btn-primary" ?disabled=${us.saving}>
            ${us.saving ? "Creating…" : html`${sgIcon("plus", 15)} Create user`}
          </button>
        </div>
      </form>
    </div>
  `;
}

// ── styles ──────────────────────────────────────────────────────

const USERS_STYLE_ID = "sg-users-css";
function injectStyles() {
  if (typeof document === "undefined") return;
  let style = document.getElementById(USERS_STYLE_ID) as HTMLStyleElement | null;
  if (style?.textContent === USERS_CSS) return;
  if (!style) {
    style = document.createElement("style");
    style.id = USERS_STYLE_ID;
    document.head.appendChild(style);
  }
  style.textContent = USERS_CSS;
}

const USERS_CSS = `
.sg-users { padding: clamp(14px, 2vw, 24px); }

/* Banners */
.users-banner { display: flex; align-items: center; gap: 10px; padding: 11px 14px; border-radius: var(--sg-radius-md); font-size: 13px; line-height: 1.45; }
.users-banner .sg-ico { flex: none; }
.users-banner-error { color: var(--sg-bad); background: color-mix(in srgb, var(--sg-bad) 10%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sg-bad) 28%, transparent); }
.users-banner-success { color: var(--sg-ok); background: color-mix(in srgb, var(--sg-ok) 10%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sg-ok) 26%, transparent); }

/* Layout */
.users-layout { display: grid; grid-template-columns: minmax(280px, 360px) minmax(0, 1fr); gap: 16px; align-items: start; }
.users-list { display: flex; flex-direction: column; padding: 16px; }
.users-list .sg-section-head { margin-bottom: 10px; }
.users-rows { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.users-detail { min-height: 320px; padding: 22px; }
.users-empty { display: grid; place-items: center; }
.users-detail-empty { min-height: 280px; align-content: center; gap: 4px; }
.users-steps { list-style: none; display: grid; gap: 10px; width: min(520px, 100%); margin: 0 auto 8px; padding: 0; }
.users-steps li { display: flex; gap: 12px; align-items: flex-start; padding: 12px 14px; border-radius: var(--sg-radius-md); background: var(--glass-hover); box-shadow: inset 0 0 0 1px var(--glass-stroke); text-align: left; font-size: 12.5px; color: var(--sg-fg-2); line-height: 1.45; }
.users-steps strong { display: block; color: var(--sg-fg); font-size: 13px; font-weight: 620; margin-bottom: 2px; }
.users-step-ico { flex: none; display: grid; place-items: center; width: 30px; height: 30px; border-radius: 10px; color: var(--sg-gold); background: var(--glass-gold-a10); box-shadow: inset 0 0 0 1px var(--glass-gold-a24); }

/* Rows */
.users-row {
  display: flex; align-items: flex-start; gap: 12px; width: 100%; padding: 12px 13px; border: 0; text-align: left;
  color: var(--sg-fg); font: inherit;
}
.users-row.active { box-shadow: var(--glass-elev-2, none), inset 0 0 0 1px var(--glass-stroke-gold), var(--glass-glow-soft, none); }
.users-row.active::before { background: var(--glass-edge); }
.users-row-body { display: flex; flex-direction: column; gap: 5px; min-width: 0; flex: 1; }
.users-row-main { display: flex; align-items: center; gap: 8px; min-width: 0; }
.users-row-name { font-weight: 640; font-size: 14px; letter-spacing: -0.01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.users-row-led { margin-left: auto; display: inline-flex; padding-left: 6px; }
.users-you { padding: 1px 7px; border-radius: 999px; font-size: 10px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--sg-gold); background: var(--glass-gold-a10); }
.users-row-meta { display: flex; flex-wrap: wrap; gap: 5px; }
.users-row-meta .sg-chip { padding: 2px 8px; font-size: 10.5px; }
.users-row-email, .users-row-home { font-size: 11.5px; color: var(--sg-fg-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.users-row-email { color: var(--sg-fg-2); }

/* Monogram avatar with a gold ring */
.users-avatar {
  --ring: var(--glass-stroke-strong, rgba(255, 255, 255, 0.16));
  flex: none; position: relative; display: grid; place-items: center; width: 40px; height: 40px; border-radius: 50%;
  padding: 2px; background: conic-gradient(from 210deg, var(--ring), transparent 40%, var(--ring) 70%, transparent);
}
.users-avatar > span {
  display: grid; place-items: center; width: 100%; height: 100%; border-radius: 50%;
  color: var(--sg-fg); font: 650 13px/1 var(--font-ui-display, var(--glass-font, system-ui)); letter-spacing: 0.02em;
  background: radial-gradient(120% 120% at 30% 20%, var(--glass-gold-a16), transparent 60%), var(--glass-3);
  box-shadow: inset 0 0 0 1px var(--glass-stroke), var(--glass-specular, none);
}
.users-avatar--admin { --ring: var(--sg-gold); box-shadow: 0 0 16px -4px var(--glass-gold-a40); }
.users-avatar--admin > span { color: var(--sg-gold); }
.users-avatar--lg { width: 58px; height: 58px; }
.users-avatar--lg > span { font-size: 19px; }

/* Form */
.users-form-head { display: flex; align-items: center; gap: 14px; margin-bottom: 18px; min-width: 0; }
.users-form-title { min-width: 0; flex: 1; }
.users-form-title .sg-eyebrow { margin-bottom: 4px; }
.users-form h3, .users-dialog h3 { margin: 0 0 6px; color: var(--sg-fg); font: 650 20px/1.15 var(--font-ui-display, var(--glass-font, system-ui)); letter-spacing: -0.02em; overflow: hidden; text-overflow: ellipsis; }
.users-sheet-sub { margin: 0; color: var(--sg-fg-2); font-size: 12.5px; }
.users-sheet-icon { flex: none; display: grid; place-items: center; width: 50px; height: 50px; border-radius: 16px; color: var(--sg-gold); background: var(--glass-gold-tint, var(--glass-gold-a10)); box-shadow: inset 0 0 0 1px var(--glass-stroke-gold), var(--glass-glow-soft, none); }
.users-sheet-close { align-self: flex-start; }
.users-group { margin: 6px 0 12px; }
.users-form-grid .users-group { margin: 10px 0 0; }
.users-form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 16px; }
.users-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; font-size: 12px; color: var(--sg-fg-2); }
.users-field > span:first-child { font-weight: 560; }
.users-field textarea.sg-input { resize: vertical; min-height: 64px; line-height: 1.5; }
.users-field .sg-input:disabled { opacity: 0.55; cursor: not-allowed; }
.users-field select.sg-input option { background: var(--glass-solid, #15130f); color: var(--sg-fg); }
.users-field small { font-size: 11px; color: var(--sg-fg-3); line-height: 1.45; }
.users-field code { font-family: var(--glass-font-mono, ui-monospace, monospace); font-size: 0.95em; color: var(--sg-gold); }
.users-field-wide { grid-column: 1 / -1; }
.users-field-checkbox {
  grid-column: 1 / -1; flex-direction: row; align-items: center; gap: 12px; padding: 12px 14px; border-radius: var(--sg-radius-md); cursor: pointer;
  font-size: 13px; color: var(--sg-fg); background: var(--glass-hover); box-shadow: inset 0 0 0 1px var(--glass-stroke);
}
.users-field-checkbox > span { font-weight: 560; }
.users-form-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 22px; padding-top: 16px; border-top: 1px solid var(--glass-stroke); }
.users-form-actions--end { justify-content: flex-end; }

/* iOS-style switch */
.users-switch {
  appearance: none; -webkit-appearance: none; flex: none; position: relative; width: 40px; height: 24px; margin: 0; border-radius: 999px; cursor: pointer;
  background: var(--glass-press, rgba(255, 255, 255, 0.12)); box-shadow: inset 0 0 0 1px var(--glass-stroke-strong);
  transition: background var(--sg-dur) var(--sg-ease), box-shadow var(--sg-dur) var(--sg-ease);
}
.users-switch::after {
  content: ""; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%;
  background: #fff; box-shadow: 0 2px 6px rgba(0, 0, 0, 0.35); transition: transform var(--sg-dur) var(--sg-spring);
}
.users-switch:checked { background: var(--glass-gold-fill, var(--sg-gold)); box-shadow: inset 0 0 0 1px var(--glass-stroke-gold), 0 0 14px -4px var(--glass-gold-a40); }
.users-switch:checked::after { transform: translateX(16px); }
.users-switch:focus-visible { box-shadow: var(--glass-focus-ring, 0 0 0 2px var(--sg-gold)); }

/* Sheet */
.users-dialog { width: min(760px, 100%); padding: 24px; }

@media (max-width: 960px) {
  .users-layout { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 720px) {
  .sg-users { padding: 12px; }
  .users-form-grid { grid-template-columns: minmax(0, 1fr); }
  .users-detail { padding: 16px; }
  .users-dialog { padding: 18px; }
  .users-form-actions > .sg-btn { flex: 1 1 auto; }
  .users-avatar--lg { width: 48px; height: 48px; }
}
@media (prefers-reduced-motion: reduce) {
  .users-switch, .users-switch::after { transition: none; }
}
`;
