// Open-source build stub: the real module is part of the hosted product (see docs/licensing/PRIVATE-SPLIT.md).
export const DEFAULT_VAULT_SCOPES: readonly string[] = ["gateway", "mesh", "federation"];

export function resolveVaultBaseUrl(override?: string): string {
  return (override ?? "").replace(/\/+$/, "");
}

export class VaultError extends Error {
  readonly code: string;
  readonly httpStatus: number;

  constructor(code: string, httpStatus: number, message?: string) {
    super(message ?? code);
    this.name = "VaultError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export type DeviceStartRequest = {
  client_id?: string;
  scopes: readonly string[];
  device_label?: string;
};

export type DeviceStartResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
};

export type TokenBundle = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  tenant_id: string;
  scopes: string[];
  refresh_expires_in?: number;
};

export type TokenPollRequest = {
  device_code: string;
  client_id?: string;
};

export type RefreshRequest = {
  refresh_token: string;
  client_id?: string;
};

export type ValidateResponse =
  | { valid: true; tenant_id: string; user_id: string; scopes: string[]; expires_at: number }
  | { valid: false; error: string };

export type RevokeResponse = { revoked: boolean };

type FetchOpts = {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
};

function unavailable(): VaultError {
  return new VaultError(
    "feature_unavailable",
    503,
    "Kingly Vault sign-in is not available in the open-source build",
  );
}

export async function startDevice(
  _req: DeviceStartRequest,
  _opts: FetchOpts = {},
): Promise<DeviceStartResponse> {
  throw unavailable();
}

export async function pollToken(
  _req: TokenPollRequest,
  _opts: FetchOpts = {},
): Promise<TokenBundle> {
  throw unavailable();
}

export async function refreshToken(
  _req: RefreshRequest,
  _opts: FetchOpts = {},
): Promise<TokenBundle> {
  throw unavailable();
}

export async function validateToken(
  _accessToken: string,
  _opts: FetchOpts = {},
): Promise<ValidateResponse> {
  return { valid: false, error: "feature_unavailable" };
}

export async function revokeToken(
  _accessToken: string,
  _opts: FetchOpts = {},
): Promise<RevokeResponse> {
  return { revoked: false };
}
