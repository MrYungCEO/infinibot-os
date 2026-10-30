/**
 * Hosted cloud build flag (VITE_INFINIBOT_CLOUD=1).
 *
 * Distinct from SAAS_MODE: a SaaS gateway injects `__INFINIBOT_SAAS_MODE__` and
 * the Clerk keys into the page it serves. The cloud build is a static site on
 * Netlify, so the same globals are baked in at build time from
 * VITE_CLERK_PUBLISHABLE_KEY. It runs the full control UI against the member's
 * own per-tenant gateway, whose URL comes only from the fleet orchestrator at
 * runtime (fleet-connect.ts) — never from the build or from storage.
 */

export function isCloudBuild(): boolean {
  return import.meta.env.VITE_INFINIBOT_CLOUD === "1";
}

/** Clerk's frontend API host is the base64 payload of the publishable key. */
function frontendApiFromKey(pk: string): string | undefined {
  const m = /^pk_(?:test|live)_(.+)$/.exec(pk.trim());
  if (!m) return undefined;
  try {
    return atob(m[1]).replace(/\$+$/, "") || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Path the cloud app is served under, without a trailing slash: "/app" on
 * infinibotos.com (static marketing owns the root), "" for a root build.
 * Derived from the Vite `base` (INFINIBOT_CONTROL_UI_BASE_PATH at build time).
 */
export function cloudAppBase(): string {
  const raw = (import.meta.env.BASE_URL as string | undefined) ?? "/";
  if (!raw.startsWith("/")) return ""; // relative ("./") build: root-served
  return raw.replace(/\/+$/, "");
}

/** `${cloudAppBase()}${path}` — e.g. appPath("/admin") → "/app/admin". */
export function appPath(path: string): string {
  return `${cloudAppBase()}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Set the globals saas-clerk.ts reads, before the Clerk gate runs. */
export function applyCloudBootGlobals(): void {
  if (!isCloudBuild()) return;
  // Pin the router's base so /app/<tab> deep links never get read as a tab path.
  const base = cloudAppBase();
  if (base && !window.__INFINIBOT_CONTROL_UI_BASE_PATH__) window.__INFINIBOT_CONTROL_UI_BASE_PATH__ = base;
  const pk = (import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined)?.trim() ?? "";
  window.__INFINIBOT_SAAS_MODE__ = true;
  if (pk) {
    window.__INFINIBOT_CLERK_PUBLISHABLE_KEY__ = pk;
    window.__INFINIBOT_CLERK_FRONTEND_API__ =
      (import.meta.env.VITE_CLERK_FRONTEND_API as string | undefined)?.trim() || frontendApiFromKey(pk);
  }
}

/** Base URL of the Functions API (same origin by default). */
export function cloudApiBase(): string {
  const base = (import.meta.env.VITE_INFINIBOT_CLOUD_API_BASE as string | undefined)?.trim();
  return (base || "/api").replace(/\/+$/, "");
}
