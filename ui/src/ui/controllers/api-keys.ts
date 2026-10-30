import type { GatewayBrowserClient } from "../gateway";

// ============================================================================
// Types
// ============================================================================

export type AuthProfileEntry = {
  profileId: string;
  provider: string;
  type: "api_key" | "oauth" | "token";
  email?: string;
  status: "ok" | "expiring" | "expired" | "missing" | "static";
  expiresAt?: number;
  remainingMs?: number;
  label: string;
  maskedKey?: string;
};

export type AuthProviderSummary = {
  provider: string;
  status: "ok" | "expiring" | "expired" | "missing" | "static";
  profiles: AuthProfileEntry[];
  profileCount: number;
};

export type ApiKeysState = {
  loading: boolean;
  error: string | null;
  providers: AuthProviderSummary[];
  profileCount: number;
  now: number;
  filter: string;
  selectedProfileId: string | null;
  showAddDialog: boolean;
  addForm: {
    provider: string;
    profileName: string;
    key: string;
    email: string;
  };
  saving: boolean;
  testing: Record<string, boolean>;
  testResults: Record<string, { valid: boolean; message: string } | null>;
};

// ============================================================================
// Known Providers
// ============================================================================

/**
 * Provider catalogue rendered by the API Keys page. The single source of truth
 * now lives in a server-safe module (src/agents/known-providers.ts) so the
 * gateway (`providers.catalog.list` RPC) and the Electron first-run wizard can
 * read the exact same list. We re-export here to preserve this controller's
 * public surface — every existing `import { KNOWN_PROVIDERS, getProviderInfo,
 * type KnownProvider } from "../controllers/api-keys.js"` keeps working.
 */
export {
  KNOWN_PROVIDERS,
  getProviderInfo,
  listModelProviders,
} from "../../../../src/agents/known-providers.js";
export type { KnownProvider } from "../../../../src/agents/known-providers.js";

// ============================================================================
// State Factory
// ============================================================================

export function createInitialApiKeysState(): ApiKeysState {
  return {
    loading: false,
    error: null,
    providers: [],
    profileCount: 0,
    now: Date.now(),
    filter: "",
    selectedProfileId: null,
    showAddDialog: false,
    addForm: {
      provider: "",
      profileName: "default",
      key: "",
      email: "",
    },
    saving: false,
    testing: {},
    testResults: {},
  };
}

// ============================================================================
// API Functions
// ============================================================================

export async function loadApiKeys(
  state: { apiKeysState?: ApiKeysState | null; requestUpdate?: () => void },
  client: GatewayBrowserClient
): Promise<void> {
  if (!state.apiKeysState) {
    state.apiKeysState = createInitialApiKeysState();
  }

  state.apiKeysState.loading = true;
  state.apiKeysState.error = null;
  state.requestUpdate?.();

  try {
    const result = await client.request<{
      providers: AuthProviderSummary[];
      profileCount: number;
      now: number;
    }>("auth.profiles.list", {});

    state.apiKeysState.providers = result.providers || [];
    state.apiKeysState.profileCount = result.profileCount || 0;
    state.apiKeysState.now = result.now || Date.now();
    state.apiKeysState.loading = false;
  } catch (err) {
    state.apiKeysState.error = err instanceof Error ? err.message : String(err);
    state.apiKeysState.loading = false;
  }

  state.requestUpdate?.();
}

export async function upsertApiKey(
  state: { apiKeysState?: ApiKeysState | null; requestUpdate?: () => void },
  client: GatewayBrowserClient,
  params: {
    provider: string;
    profileName?: string;
    key: string;
    email?: string;
  }
): Promise<boolean> {
  if (!state.apiKeysState) return false;

  state.apiKeysState.saving = true;
  state.requestUpdate?.();

  try {
    const profileId = params.profileName && params.profileName !== "default"
      ? `${params.provider}:${params.profileName}`
      : `${params.provider}:default`;

    await client.request("auth.profiles.upsert", {
      profileId,
      provider: params.provider,
      type: "api_key",
      key: params.key,
      ...(params.email ? { email: params.email } : {}),
    });

    state.apiKeysState.saving = false;
    state.apiKeysState.showAddDialog = false;
    state.apiKeysState.addForm = {
      provider: "",
      profileName: "default",
      key: "",
      email: "",
    };
    state.requestUpdate?.();

    // Reload the list
    await loadApiKeys(state, client);
    return true;
  } catch (err) {
    state.apiKeysState.error = err instanceof Error ? err.message : String(err);
    state.apiKeysState.saving = false;
    state.requestUpdate?.();
    return false;
  }
}

export async function deleteApiKey(
  state: { apiKeysState?: ApiKeysState | null; requestUpdate?: () => void },
  client: GatewayBrowserClient,
  profileId: string
): Promise<boolean> {
  if (!state.apiKeysState) return false;

  try {
    await client.request("auth.profiles.delete", { profileId });
    
    // Reload the list
    await loadApiKeys(state, client);
    return true;
  } catch (err) {
    state.apiKeysState.error = err instanceof Error ? err.message : String(err);
    state.requestUpdate?.();
    return false;
  }
}

export async function testApiKey(
  state: { apiKeysState?: ApiKeysState | null; requestUpdate?: () => void },
  client: GatewayBrowserClient,
  profileId: string
): Promise<void> {
  if (!state.apiKeysState) return;

  state.apiKeysState.testing[profileId] = true;
  state.apiKeysState.testResults[profileId] = null;
  state.requestUpdate?.();

  try {
    const result = await client.request<{
      profileId: string;
      provider: string;
      valid: boolean;
      message: string;
    }>("auth.profiles.test", { profileId });

    state.apiKeysState.testResults[profileId] = {
      valid: result.valid,
      message: result.message,
    };
  } catch (err) {
    state.apiKeysState.testResults[profileId] = {
      valid: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  state.apiKeysState.testing[profileId] = false;
  state.requestUpdate?.();
}

// ============================================================================
// Helpers
// ============================================================================

export function formatRemainingTime(remainingMs: number | undefined): string {
  if (remainingMs === undefined || Number.isNaN(remainingMs)) return "unknown";
  if (remainingMs <= 0) return "expired";
  const minutes = Math.max(1, Math.round(remainingMs / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

export function getStatusColor(status: string): string {
  switch (status) {
    case "ok":
    case "static":
      return "var(--c-emerald-500, #10b981)";
    case "expiring":
      return "var(--c-amber-500, #f59e0b)";
    case "expired":
    case "missing":
      return "var(--c-red-500, #ef4444)";
    default:
      return "var(--c-zinc-500, #71717a)";
  }
}

export function getStatusLabel(status: string): string {
  switch (status) {
    case "ok":
      return "Active";
    case "static":
      return "API Key";
    case "expiring":
      return "Expiring Soon";
    case "expired":
      return "Expired";
    case "missing":
      return "Missing";
    default:
      return status;
  }
}
