/**
 * Users Management Controller
 * CRUD operations for multi-user system
 */

import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";

// ============================================================
// Types
// ============================================================

export interface User {
  id: string;
  name: string;
  telegramId?: string;
  workingDirectory: string;
  allowedAgents: string[];
  additionalContext?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UsersManagementState {
  users: User[];
  loading: boolean;
  error: string | null;
  selectedUserId: string | null;
  editingUser: Partial<User> | null;
  showCreateDialog: boolean;
  showDeleteConfirm: boolean;
  deleteTargetId: string | null;
  searchQuery: string;
  availableAgents: string[];
}

// ============================================================
// State Initialization
// ============================================================

export function createUsersManagementState(): UsersManagementState {
  return {
    users: [],
    loading: false,
    error: null,
    selectedUserId: null,
    editingUser: null,
    showCreateDialog: false,
    showDeleteConfirm: false,
    deleteTargetId: null,
    searchQuery: "",
    availableAgents: ["main", "coder", "architect", "tester", "reviewer"],
  };
}

// ============================================================
// API Functions
// ============================================================

export async function loadUsers(
  state: AppViewState,
  client: GatewayBrowserClient
): Promise<void> {
  if (!state.usersManagementState) {
    state.usersManagementState = createUsersManagementState();
  }

  state.usersManagementState.loading = true;
  state.usersManagementState.error = null;
  state.requestUpdate?.();

  try {
    const res = await client.request("users.list", { includeDisabled: true });
    if (res && typeof res === "object" && "users" in res) {
      state.usersManagementState.users = (res as { users: User[] }).users;
    } else {
      throw new Error("Invalid response from users.list");
    }
  } catch (e) {
    state.usersManagementState.error = `Failed to load users: ${e}`;
    console.error("Failed to load users:", e);
  } finally {
    state.usersManagementState.loading = false;
    state.requestUpdate?.();
  }
}

export async function createUser(
  state: AppViewState,
  client: GatewayBrowserClient,
  input: {
    name: string;
    telegramId?: string;
    workingDirectory: string;
    allowedAgents?: string[];
    additionalContext?: string;
    enabled?: boolean;
  }
): Promise<User | null> {
  if (!state.usersManagementState) return null;

  state.usersManagementState.loading = true;
  state.usersManagementState.error = null;
  state.requestUpdate?.();

  try {
    const res = await client.request("users.create", input);
    if (res && typeof res === "object" && "id" in res) {
      const user = res as User;
      state.usersManagementState.users.push(user);
      state.usersManagementState.showCreateDialog = false;
      state.usersManagementState.editingUser = null;
      state.requestUpdate?.();
      return user;
    } else {
      throw new Error("Invalid response from users.create");
    }
  } catch (e) {
    state.usersManagementState.error = `Failed to create user: ${e}`;
    console.error("Failed to create user:", e);
    state.requestUpdate?.();
    return null;
  } finally {
    state.usersManagementState.loading = false;
    state.requestUpdate?.();
  }
}

export async function updateUser(
  state: AppViewState,
  client: GatewayBrowserClient,
  id: string,
  input: Partial<User>
): Promise<User | null> {
  if (!state.usersManagementState) return null;

  state.usersManagementState.loading = true;
  state.usersManagementState.error = null;
  state.requestUpdate?.();

  try {
    const res = await client.request("users.update", { id, ...input });
    if (res && typeof res === "object" && "id" in res) {
      const user = res as User;
      const idx = state.usersManagementState.users.findIndex((u) => u.id === id);
      if (idx !== -1) {
        state.usersManagementState.users[idx] = user;
      }
      state.usersManagementState.selectedUserId = null;
      state.usersManagementState.editingUser = null;
      state.requestUpdate?.();
      return user;
    } else {
      throw new Error("Invalid response from users.update");
    }
  } catch (e) {
    state.usersManagementState.error = `Failed to update user: ${e}`;
    console.error("Failed to update user:", e);
    state.requestUpdate?.();
    return null;
  } finally {
    state.usersManagementState.loading = false;
    state.requestUpdate?.();
  }
}

export async function deleteUser(
  state: AppViewState,
  client: GatewayBrowserClient,
  id: string
): Promise<boolean> {
  if (!state.usersManagementState) return false;

  state.usersManagementState.loading = true;
  state.usersManagementState.error = null;
  state.requestUpdate?.();

  try {
    await client.request("users.delete", { id });
    state.usersManagementState.users = state.usersManagementState.users.filter(
      (u) => u.id !== id
    );
    state.usersManagementState.showDeleteConfirm = false;
    state.usersManagementState.deleteTargetId = null;
    state.requestUpdate?.();
    return true;
  } catch (e) {
    state.usersManagementState.error = `Failed to delete user: ${e}`;
    console.error("Failed to delete user:", e);
    state.requestUpdate?.();
    return false;
  } finally {
    state.usersManagementState.loading = false;
    state.requestUpdate?.();
  }
}

export async function loadAvailableAgents(
  state: AppViewState,
  client: GatewayBrowserClient
): Promise<void> {
  if (!state.usersManagementState) return;

  try {
    const res = await client.request("config.get", {});
    if (res && typeof res === "object") {
      const config = (res as any).config || res;
      const agentsList = config?.agents?.list || [];
      const agentIds = agentsList.map((a: any) => a.id).filter(Boolean);
      if (agentIds.length > 0) {
        state.usersManagementState.availableAgents = agentIds;
      }
    }
  } catch (e) {
    console.warn("Could not load available agents:", e);
  }
  state.requestUpdate?.();
}

// ============================================================
// Helper Functions
// ============================================================

export function filterUsers(state: UsersManagementState): User[] {
  if (!state.searchQuery) return state.users;

  const query = state.searchQuery.toLowerCase();
  return state.users.filter(
    (u) =>
      u.name.toLowerCase().includes(query) ||
      u.telegramId?.toLowerCase().includes(query) ||
      u.workingDirectory.toLowerCase().includes(query)
  );
}

export function validateUser(user: Partial<User>): string | null {
  if (!user.name?.trim()) {
    return "Name is required";
  }
  if (!user.workingDirectory?.trim()) {
    return "Working directory is required";
  }
  return null;
}

export function openCreateDialog(state: AppViewState): void {
  if (!state.usersManagementState) {
    state.usersManagementState = createUsersManagementState();
  }
  state.usersManagementState.showCreateDialog = true;
  state.usersManagementState.editingUser = {
    name: "",
    telegramId: "",
    workingDirectory: "",
    allowedAgents: ["main"],
    additionalContext: "",
    enabled: true,
  };
  state.requestUpdate?.();
}

export function closeCreateDialog(state: AppViewState): void {
  if (!state.usersManagementState) return;
  state.usersManagementState.showCreateDialog = false;
  state.usersManagementState.editingUser = null;
  state.requestUpdate?.();
}

export function selectUser(state: AppViewState, userId: string): void {
  if (!state.usersManagementState) return;
  const user = state.usersManagementState.users.find((u) => u.id === userId);
  if (user) {
    state.usersManagementState.selectedUserId = userId;
    state.usersManagementState.editingUser = { ...user };
  }
  state.requestUpdate?.();
}

export function closeUserEdit(state: AppViewState): void {
  if (!state.usersManagementState) return;
  state.usersManagementState.selectedUserId = null;
  state.usersManagementState.editingUser = null;
  state.requestUpdate?.();
}

export function showDeleteConfirm(state: AppViewState, userId: string): void {
  if (!state.usersManagementState) return;
  state.usersManagementState.showDeleteConfirm = true;
  state.usersManagementState.deleteTargetId = userId;
  state.requestUpdate?.();
}

export function hideDeleteConfirm(state: AppViewState): void {
  if (!state.usersManagementState) return;
  state.usersManagementState.showDeleteConfirm = false;
  state.usersManagementState.deleteTargetId = null;
  state.requestUpdate?.();
}

export function updateEditingUser(
  state: AppViewState,
  field: keyof User,
  value: unknown
): void {
  if (!state.usersManagementState?.editingUser) return;
  (state.usersManagementState.editingUser as any)[field] = value;
  state.requestUpdate?.();
}

export function toggleAgentInEdit(state: AppViewState, agentId: string): void {
  if (!state.usersManagementState?.editingUser) return;
  const agents = state.usersManagementState.editingUser.allowedAgents || [];
  if (agents.includes(agentId)) {
    state.usersManagementState.editingUser.allowedAgents = agents.filter(
      (a) => a !== agentId
    );
  } else {
    state.usersManagementState.editingUser.allowedAgents = [...agents, agentId];
  }
  state.requestUpdate?.();
}

export function setSearchQuery(state: AppViewState, query: string): void {
  if (!state.usersManagementState) return;
  state.usersManagementState.searchQuery = query;
  state.requestUpdate?.();
}
