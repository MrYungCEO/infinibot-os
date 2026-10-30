/**
 * Pull gateway credentials out of `location.hash` once on app boot.
 *
 * Used so launchers (`infinibot ui open`, `infinibot quickstart`, deep links
 * from the Mac app, etc.) can hand a fresh `#token=...` or `#password=...` to
 * the Control UI without making the user paste anything into the settings
 * panel. Mirrors the pattern in `src/gateway/quickstart-ui.ts:323` so both
 * surfaces accept the same launch URL.
 *
 * Hash values are read once, persisted to settings (so reloads stay
 * authenticated), then scrubbed from the address bar via `replaceState` so
 * the secret doesn't sit in browser history. Empty / missing values are
 * ignored — never overwrite a stored credential with `""`.
 */
import { loadSettings, saveSettings, type UiSettings } from "./storage";

export type HashAuthPickup = {
  token?: string;
  password?: string;
};

/**
 * Read `#token=...` / `#password=...` from the URL hash, persist them, and
 * return the picked-up values. Safe to call from non-browser contexts (SSR,
 * unit tests) — bails cleanly if `window`/`localStorage` aren't there.
 */
export function pickupAuthFromHash(): HashAuthPickup {
  if (typeof window === "undefined" || !window.location) return {};

  const raw = window.location.hash || "";
  if (!raw || raw === "#") return {};

  // The hash may carry a router fragment ("#/whiteboard") or a credential
  // payload ("#token=abc"). Only the latter has `=`, so we ignore the rest
  // to avoid clobbering route hashes.
  const body = raw.startsWith("#") ? raw.slice(1) : raw;
  if (!body.includes("=")) return {};

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(body);
  } catch {
    return {};
  }

  const token = params.get("token")?.trim() || undefined;
  const password = params.get("password")?.trim() || undefined;
  if (!token && !password) return {};

  // Persist before scrubbing the URL so a redirect-during-load can't lose
  // the credential between hash-strip and settings-write.
  try {
    const current = loadSettings();
    const next: UiSettings = {
      ...current,
      ...(token ? { token } : {}),
      ...(password ? { password } : {}),
    };
    saveSettings(next);
  } catch {
    // Storage might be locked (private mode, quota). The in-memory return
    // value still lets the current session connect; reload will re-prompt.
  }

  // Strip credentials from the address bar. Keep the path + search so any
  // unrelated query string (e.g. ?onboarding=1) survives the rewrite.
  try {
    const { pathname, search } = window.location;
    window.history.replaceState(null, "", `${pathname}${search}`);
  } catch {
    // Older browsers without history API — leaving the hash in place is
    // a tiny privacy regression, not a functional one.
  }

  return { token, password };
}
