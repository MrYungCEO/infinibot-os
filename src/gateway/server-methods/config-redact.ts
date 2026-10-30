/**
 * Secret redaction for config.get and the matching restore for
 * config.set / config.patch / config.apply. This is the single redaction
 * helper for config: the gateway's config.get handler (every client) and the
 * agent `gateway` tool (strict mode, on top) both use it, and both write the
 * same placeholder, {@link REDACTED_SENTINEL}.
 *
 * config.get used to hand the raw config — gateway password, bot tokens,
 * provider API keys — to every operator client, including the agent's own
 * `gateway` tool. Now secret-looking string values are replaced with the
 * sentinel. When a client writes a config back that still contains the
 * sentinel, the original value at the same path is restored, so the Config
 * page can round-trip without ever seeing the secrets.
 *
 * Strict mode (agent-facing) additionally redacts every string under
 * env/headers/vars maps, a few extra key shapes (webhook URLs, DSNs, PATs,
 * signing keys) and credentials embedded in URLs. Its output cannot always be
 * restored (a URL keeps its host), which is why the agent tool refuses writes
 * that still carry the sentinel.
 */

export const REDACTED_SENTINEL = "__INFINIBOT_REDACTED__";

const SENSITIVE_SUFFIXES = [
  "password",
  "passwd",
  "passphrase",
  "secret",
  "token",
  "apikey",
  "accesskey",
  "privatekey",
  "credential",
  "credentials",
  "cookie",
  "bearer",
];

/** Extra suffixes redacted only in strict (agent-facing) mode. */
const STRICT_SENSITIVE_SUFFIXES = ["authorization", "webhook", "webhookurl", "signingkey", "dsn"];
/** Every string leaf under these keys is secret-shaped. */
const CONTAINER_KEY_RE = /^secrets$/i;
/** Strict mode also treats env vars and HTTP header maps as all-secret. */
const STRICT_CONTAINER_KEY_RE = /^(env|headers|vars)$/i;
/** `pat`, `SUPABASE_PAT`, `github-pat` — but not `compat`. */
const STRICT_PAT_KEY_RE = /(^|[_-])pat$/i;
const URL_CREDENTIALS_RE = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi;

export type RedactOptions = { strict?: boolean };

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Normalized key (lowercase, no separators) ends with a secret-ish word. */
export function isSensitiveConfigKey(key: string, opts?: RedactOptions): boolean {
  const k = normalizeKey(key);
  if (!k) return false;
  if (SENSITIVE_SUFFIXES.some((suffix) => k.endsWith(suffix))) return true;
  if (!opts?.strict) return false;
  return (
    STRICT_SENSITIVE_SUFFIXES.some((suffix) => k.endsWith(suffix)) || STRICT_PAT_KEY_RE.test(key)
  );
}

function isSensitiveContainerKey(key: string, opts: RedactOptions): boolean {
  return CONTAINER_KEY_RE.test(key) || (opts.strict === true && STRICT_CONTAINER_KEY_RE.test(key));
}

type Json = unknown;

function redactValue(
  value: Json,
  collected: Set<string>,
  keyIsSensitive: boolean,
  opts: RedactOptions,
  underContainer = false,
): Json {
  if (typeof value === "string") {
    if (keyIsSensitive && value.length > 0 && value !== REDACTED_SENTINEL) {
      collected.add(value);
      return REDACTED_SENTINEL;
    }
    if (opts.strict && URL_CREDENTIALS_RE.test(value)) {
      URL_CREDENTIALS_RE.lastIndex = 0;
      collected.add(value);
      return value.replace(URL_CREDENTIALS_RE, `$1${REDACTED_SENTINEL}@`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, collected, keyIsSensitive, opts, underContainer));
  }
  if (value && typeof value === "object") {
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(value as Record<string, Json>)) {
      // Everything below a secrets container (strict: env/headers too) is sensitive.
      const container = underContainer || isSensitiveContainerKey(k, opts);
      out[k] = redactValue(
        v,
        collected,
        container || isSensitiveConfigKey(k, opts),
        opts,
        container,
      );
    }
    return out;
  }
  return value;
}

export function redactConfigValue<T>(
  value: T,
  opts: RedactOptions = {},
): { value: T; secrets: string[] } {
  const collected = new Set<string>();
  URL_CREDENTIALS_RE.lastIndex = 0;
  const redacted = redactValue(value, collected, false, opts) as T;
  return { value: redacted, secrets: [...collected] };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replace every quoted occurrence of a secret in JSON5 text. */
export function redactRawConfigText(raw: string, secrets: string[]): string {
  let out = raw;
  // Longest first so a secret that contains another is replaced whole.
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    const escapedJson = JSON.stringify(secret).slice(1, -1);
    for (const form of new Set([secret, escapedJson])) {
      const re = new RegExp(`(["'])${escapeRegExp(form)}\\1`, "g");
      out = out.replace(re, `$1${REDACTED_SENTINEL}$1`);
    }
  }
  return out;
}

export function redactConfigSnapshot<
  T extends { raw?: string | null; parsed?: unknown; config?: unknown },
>(snapshot: T): T {
  const parsed = redactConfigValue(snapshot.parsed);
  const config = redactConfigValue(snapshot.config);
  const secrets = [...new Set([...parsed.secrets, ...config.secrets])];
  return {
    ...snapshot,
    parsed: parsed.value,
    config: config.value,
    raw:
      typeof snapshot.raw === "string" ? redactRawConfigText(snapshot.raw, secrets) : snapshot.raw,
  };
}

/**
 * Agent-facing config.get view (the `gateway` tool): strict redaction of
 * parsed/config, and `raw` (JSON5 text that can't be strictly redacted
 * reliably) replaced with the redacted parsed config. `hash` is kept so
 * config.patch can still pass baseHash.
 */
export function redactConfigSnapshotForAgent(snapshot: unknown): unknown {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return redactConfigValue(snapshot, { strict: true }).value;
  }
  const src = snapshot as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(src)) {
    if (key === "hash" || key === "path" || key === "exists" || key === "valid") {
      out[key] = value;
    } else if (key !== "raw") {
      out[key] = redactConfigValue(value, { strict: true }).value;
    }
  }
  if ("raw" in src) {
    const parsed = out.parsed ?? out.config;
    out.raw = parsed === undefined ? null : JSON.stringify(parsed, null, 2);
    out.redacted = true;
    out.redactionNote = `Secret values are shown as ${REDACTED_SENTINEL}. Use config.patch with only the keys you change; never send ${REDACTED_SENTINEL} back.`;
  }
  return out;
}

export type RestoreResult<T> = { ok: true; value: T } | { ok: false; path: string };

/**
 * Put original values back wherever the incoming config still carries the
 * sentinel. A sentinel with no original at that path is an error (the client
 * moved a redacted value somewhere new; refusing beats writing the sentinel).
 */
export function restoreRedactedValues<T>(incoming: T, original: unknown): RestoreResult<T> {
  let failedPath: string | null = null;
  const walk = (value: Json, orig: Json, path: string): Json => {
    if (failedPath) return value;
    if (value === REDACTED_SENTINEL) {
      if (typeof orig === "string") return orig;
      failedPath = path || "(root)";
      return value;
    }
    if (Array.isArray(value)) {
      const origArr = Array.isArray(orig) ? orig : [];
      return value.map((item, i) => walk(item, origArr[i], `${path}[${i}]`));
    }
    if (value && typeof value === "object") {
      const origObj =
        orig && typeof orig === "object" && !Array.isArray(orig)
          ? (orig as Record<string, Json>)
          : {};
      const out: Record<string, Json> = {};
      for (const [k, v] of Object.entries(value as Record<string, Json>)) {
        out[k] = walk(v, origObj[k], path ? `${path}.${k}` : k);
      }
      return out;
    }
    return value;
  };
  const value = walk(incoming, original, "") as T;
  if (failedPath) return { ok: false, path: failedPath };
  return { ok: true, value };
}
