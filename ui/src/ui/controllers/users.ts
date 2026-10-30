/**
 * Users Controller — admin CRUD + per-user prefs (language, context,
 * page gating, agent gating). Admins can manage everyone; non-admins
 * see only the self-edit form.
 */

import type { GatewayBrowserClient } from "../gateway";

export type UserRole = "admin" | "user";

export interface UserRecord {
  id: string;
  username: string;
  email: string | null;
  role: UserRole;
  language: string;
  context: string;
  homeDir: string;
  agentGatingEnabled: boolean;
  allowedDirs: string[];
  allowedPages: string[];
  createdAt: number;
  updatedAt: number;
}

export interface UsersMe {
  user: UserRecord | null;
  userCount: number;
  adminCount: number;
  implicitAdmin: boolean;
}

export interface UsersState {
  loading: boolean;
  saving: boolean;
  error: string | null;
  success: string | null;
  users: UserRecord[];
  me: UsersMe | null;
  selectedId: string | null;
  showCreateDialog: boolean;
  createForm: {
    username: string;
    email: string;
    password: string;
    gatewayPassword: string;
    role: UserRole;
    language: string;
    context: string;
    homeDir: string;
    agentGatingEnabled: boolean;
    allowedDirs: string;
    allowedPages: string;
  };
  editForm: {
    username: string;
    email: string;
    password: string;
    gatewayPassword: string;
    role: UserRole;
    language: string;
    context: string;
    homeDir: string;
    agentGatingEnabled: boolean;
    allowedDirs: string;
    allowedPages: string;
  } | null;
}

export function createInitialUsersState(): UsersState {
  return {
    loading: false,
    saving: false,
    error: null,
    success: null,
    users: [],
    me: null,
    selectedId: null,
    showCreateDialog: false,
    createForm: emptyCreateForm(),
    editForm: null,
  };
}

function emptyCreateForm(): UsersState["createForm"] {
  return {
    username: "",
    email: "",
    password: "",
    gatewayPassword: "",
    role: "user",
    language: "en",
    context: "",
    homeDir: "",
    agentGatingEnabled: false,
    allowedDirs: "",
    allowedPages: "",
  };
}

function userToEditForm(user: UserRecord): NonNullable<UsersState["editForm"]> {
  return {
    username: user.username,
    email: user.email ?? "",
    password: "",
    gatewayPassword: "",
    role: user.role,
    language: user.language,
    context: user.context,
    homeDir: user.homeDir,
    agentGatingEnabled: user.agentGatingEnabled,
    allowedDirs: user.allowedDirs.join("\n"),
    allowedPages: user.allowedPages.join(","),
  };
}

function splitLines(input: string): string[] {
  return input
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
function splitCsv(input: string): string[] {
  return input
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function flash(state: { users: UsersState }, key: "error" | "success", value: string | null, ms = 3000) {
  state.users[key] = value;
  if (value) setTimeout(() => { if (state.users[key] === value) state.users[key] = null; }, ms);
}

// ── API calls ───────────────────────────────────────────────────

export async function loadUsersAndMe(state: { users: UsersState; requestUpdate?: () => void }, client: GatewayBrowserClient): Promise<void> {
  state.users.loading = true;
  state.users.error = null;
  state.requestUpdate?.();
  try {
    const [meRes, listRes] = await Promise.all([
      client.request("users.me", {}) as Promise<UsersMe>,
      client.request("users.list", {}).catch(() => ({ users: [] as UserRecord[] })),
    ]);
    state.users.me = meRes;
    state.users.users = (listRes as { users?: UserRecord[] }).users ?? [];
  } catch (err) {
    state.users.error = err instanceof Error ? err.message : String(err);
  } finally {
    state.users.loading = false;
    state.requestUpdate?.();
  }
}

export async function createUser(state: { users: UsersState; requestUpdate?: () => void }, client: GatewayBrowserClient): Promise<void> {
  const f = state.users.createForm;
  if (!f.username.trim()) { flash(state, "error", "Username required"); state.requestUpdate?.(); return; }
  if (!f.password) { flash(state, "error", "Password required"); state.requestUpdate?.(); return; }
  if (!f.gatewayPassword) { flash(state, "error", "Gateway password required"); state.requestUpdate?.(); return; }

  state.users.saving = true;
  state.requestUpdate?.();
  try {
    await client.request("users.create", {
      username: f.username.trim(),
      email: f.email.trim() || undefined,
      password: f.password,
      gatewayPassword: f.gatewayPassword,
      role: f.role,
      language: f.language.trim(),
      context: f.context,
      homeDir: f.homeDir.trim() || undefined,
      agentGatingEnabled: f.agentGatingEnabled,
      allowedDirs: splitLines(f.allowedDirs),
      allowedPages: splitCsv(f.allowedPages),
    });
    state.users.showCreateDialog = false;
    state.users.createForm = emptyCreateForm();
    flash(state, "success", `Created user "${f.username.trim()}"`);
    await loadUsersAndMe(state, client);
  } catch (err) {
    flash(state, "error", err instanceof Error ? err.message : String(err));
  } finally {
    state.users.saving = false;
    state.requestUpdate?.();
  }
}

export async function saveEdit(state: { users: UsersState; requestUpdate?: () => void }, client: GatewayBrowserClient): Promise<void> {
  const id = state.users.selectedId;
  const f = state.users.editForm;
  if (!id || !f) return;
  state.users.saving = true;
  state.requestUpdate?.();
  try {
    const patch: Record<string, unknown> = {
      id,
      username: f.username.trim(),
      email: f.email.trim() || null,
      role: f.role,
      language: f.language,
      context: f.context,
      homeDir: f.homeDir.trim() || undefined,
      agentGatingEnabled: f.agentGatingEnabled,
      allowedDirs: splitLines(f.allowedDirs),
      allowedPages: splitCsv(f.allowedPages),
    };
    if (f.password) patch.password = f.password;
    if (f.gatewayPassword) patch.gatewayPassword = f.gatewayPassword;
    await client.request("users.update", patch);
    flash(state, "success", "Saved");
    await loadUsersAndMe(state, client);
    selectUser(state, id);
  } catch (err) {
    flash(state, "error", err instanceof Error ? err.message : String(err));
  } finally {
    state.users.saving = false;
    state.requestUpdate?.();
  }
}

export async function deleteUser(state: { users: UsersState; requestUpdate?: () => void }, client: GatewayBrowserClient, id: string): Promise<void> {
  if (!confirm("Delete this user? Their home directory is left in place but they lose access immediately.")) return;
  state.users.saving = true;
  state.requestUpdate?.();
  try {
    await client.request("users.delete", { id });
    flash(state, "success", "User deleted");
    if (state.users.selectedId === id) {
      state.users.selectedId = null;
      state.users.editForm = null;
    }
    await loadUsersAndMe(state, client);
  } catch (err) {
    flash(state, "error", err instanceof Error ? err.message : String(err));
  } finally {
    state.users.saving = false;
    state.requestUpdate?.();
  }
}

// ── Local state mutators ───────────────────────────────────────

export function openCreateDialog(state: { users: UsersState; requestUpdate?: () => void }): void {
  state.users.showCreateDialog = true;
  state.users.createForm = emptyCreateForm();
  state.requestUpdate?.();
}

export function closeCreateDialog(state: { users: UsersState; requestUpdate?: () => void }): void {
  state.users.showCreateDialog = false;
  state.requestUpdate?.();
}

export function updateCreateField<K extends keyof UsersState["createForm"]>(
  state: { users: UsersState; requestUpdate?: () => void },
  field: K,
  value: UsersState["createForm"][K],
): void {
  state.users.createForm[field] = value;
  state.requestUpdate?.();
}

export function selectUser(state: { users: UsersState; requestUpdate?: () => void }, id: string): void {
  state.users.selectedId = id;
  const found = state.users.users.find((u) => u.id === id);
  state.users.editForm = found ? userToEditForm(found) : null;
  state.requestUpdate?.();
}

export function updateEditField<K extends keyof NonNullable<UsersState["editForm"]>>(
  state: { users: UsersState; requestUpdate?: () => void },
  field: K,
  value: NonNullable<UsersState["editForm"]>[K],
): void {
  if (!state.users.editForm) return;
  state.users.editForm[field] = value;
  state.requestUpdate?.();
}

/**
 * Determine whether the current user can see a given top-nav tab.
 * Empty allowedPages = no restriction. Admins always see everything.
 * The page key matches the Tab string used elsewhere in navigation.
 */
export function userCanAccessPage(me: UsersMe | null, page: string): boolean {
  if (!me) return true; // legacy / pre-auth single-tenant
  if (me.implicitAdmin) return true;
  if (!me.user) return true;
  if (me.user.role === "admin") return true;
  if (me.user.allowedPages.length === 0) return true;
  return me.user.allowedPages.includes(page);
}
