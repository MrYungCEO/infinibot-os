export type AuthProfileConfig = {
  provider: string;
  /**
   * Credential type expected in auth-profiles.json for this profile id.
   * - api_key: static provider API key
   * - oauth: refreshable OAuth credentials (access+refresh+expires)
   * - token: static bearer-style token (optionally expiring; no refresh)
   */
  mode: "api_key" | "oauth" | "token";
  email?: string;
};

export type AuthConfig = {
  profiles?: Record<string, AuthProfileConfig>;
  order?: Record<string, string[]>;
  cooldowns?: {
    /** Default billing backoff (hours). Default: 5. */
    billingBackoffHours?: number;
    /** Optional per-provider billing backoff (hours). */
    billingBackoffHoursByProvider?: Record<string, number>;
    /** Billing backoff cap (hours). Default: 24. */
    billingMaxHours?: number;
    /**
     * Failure window for backoff counters (hours). If no failures occur within
     * this window, counters reset. Default: 24.
     */
    failureWindowHours?: number;
  };
  /**
   * Multi-user workspaces (local accounts, invites, per-workspace visibility).
   * Off by default: when disabled the gateway behaves exactly as single-owner.
   */
  multiUser?: {
    enabled?: boolean;
    /** User session lifetime in hours. Default: 168 (7 days). */
    sessionTtlHours?: number;
    /** Base URL used when building invite links (e.g. https://box.tailnet.ts.net). */
    publicBaseUrl?: string;
  };
};
