export type EmbeddedContextFile = { path: string; content: string };

export type FailoverReason =
  | "auth"
  | "format"
  | "rate_limit"
  | "billing"
  | "timeout"
  /** Model id isn't in the provider's catalog (retired upstream, typo, stale config). */
  | "model_not_found"
  | "unknown";
