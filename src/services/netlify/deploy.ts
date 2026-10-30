/**
 * Minimal Netlify deploy client used by the Lead-Qualifier form builder.
 *
 * Flow (digest deploy, per Netlify's "Deploys API"):
 *
 *   1. POST /api/v1/sites                  → create site (only when needed)
 *   2. POST /api/v1/sites/<id>/deploys     with { files: { "/index.html": sha1 } }
 *   3. PUT  /api/v1/deploys/<id>/files/<p> for every path in `required`
 *   4. Poll the deploy until `state === "ready"` (or fail/error).
 *
 * Lightweight: no dependencies; uses global `fetch` + node:crypto. The form
 * builder ships a single static `index.html` so we never need bulk hashing
 * or compression here.
 */

import { createHash } from "node:crypto";

const NETLIFY_API = "https://api.netlify.com/api/v1";

export interface NetlifySite {
  id: string;
  name: string;
  url: string;
  ssl_url?: string;
  admin_url?: string;
}

interface NetlifyDeploy {
  id: string;
  state: "uploading" | "uploaded" | "preparing" | "ready" | "error" | "processing" | string;
  required?: string[];
  ssl_url?: string;
  deploy_ssl_url?: string;
  url?: string;
  error_message?: string | null;
  /** Map of path → sha1 the server expects us to upload. */
  digest?: Record<string, string>;
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function netlifyFetch(
  path: string,
  init: RequestInit & { token: string },
): Promise<Response> {
  const res = await fetch(`${NETLIFY_API}${path}`, {
    ...init,
    headers: {
      ...authHeaders(init.token),
      ...init.headers,
    },
  });
  return res;
}

export async function listSites(token: string): Promise<NetlifySite[]> {
  const res = await netlifyFetch("/sites?per_page=50", { token, method: "GET" });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Netlify list sites failed (${res.status}): ${t.slice(0, 200)}`);
  }
  const sites = (await res.json()) as NetlifySite[];
  return sites.map((s) => ({
    id: s.id,
    name: s.name,
    url: s.url,
    ssl_url: s.ssl_url,
    admin_url: s.admin_url,
  }));
}

export async function getUser(
  token: string,
): Promise<{ id: string; email?: string; full_name?: string }> {
  const res = await netlifyFetch("/user", { token, method: "GET" });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Netlify auth check failed (${res.status}): ${t.slice(0, 200)}`);
  }
  return (await res.json()) as { id: string; email?: string; full_name?: string };
}

async function createSite(token: string, name?: string): Promise<NetlifySite> {
  const body: Record<string, unknown> = {};
  if (name) body.name = name;
  const res = await netlifyFetch("/sites", {
    token,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Netlify create site failed (${res.status}): ${t.slice(0, 200)}`);
  }
  return (await res.json()) as NetlifySite;
}

function sha1Hex(input: string | Buffer): string {
  return createHash("sha1").update(input).digest("hex");
}

async function startDeploy(
  token: string,
  siteId: string,
  files: Record<string, string>,
): Promise<NetlifyDeploy> {
  const res = await netlifyFetch(`/sites/${encodeURIComponent(siteId)}/deploys`, {
    token,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ files }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Netlify start deploy failed (${res.status}): ${t.slice(0, 200)}`);
  }
  return (await res.json()) as NetlifyDeploy;
}

async function uploadFile(
  token: string,
  deployId: string,
  filePath: string,
  contents: Buffer,
): Promise<void> {
  const res = await netlifyFetch(
    `/deploys/${encodeURIComponent(deployId)}/files/${filePath.replace(/^\//, "")}`,
    {
      token,
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      // Cast through `unknown` — Node's global fetch happily accepts a
      // Buffer here, but the DOM lib types restrict BodyInit. The simpler
      // alternative (string body) would mangle binary uploads.
      body: contents as unknown as BodyInit,
    },
  );
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Netlify upload ${filePath} failed (${res.status}): ${t.slice(0, 200)}`);
  }
}

async function pollDeploy(
  token: string,
  deployId: string,
  timeoutMs = 60_000,
): Promise<NetlifyDeploy> {
  const t0 = Date.now();
  while (true) {
    const res = await netlifyFetch(`/deploys/${encodeURIComponent(deployId)}`, {
      token,
      method: "GET",
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`Netlify poll deploy failed (${res.status}): ${t.slice(0, 200)}`);
    }
    const dep = (await res.json()) as NetlifyDeploy;
    if (dep.state === "ready") return dep;
    if (dep.state === "error")
      throw new Error(`Netlify deploy errored: ${dep.error_message ?? "unknown"}`);
    if (Date.now() - t0 > timeoutMs) return dep; // give up polling but return last state
    await new Promise((r) => setTimeout(r, 1500));
  }
}

export interface DeployStaticResult {
  site: NetlifySite;
  deployId: string;
  url: string;
  state: string;
}

/**
 * Deploy a single static HTML page to Netlify. When `siteId` is omitted a
 * new site is created and its id returned in the result so the caller can
 * persist it for future re-deploys.
 */
export async function deployStaticHtml(opts: {
  token: string;
  html: string;
  siteId?: string;
  siteName?: string;
}): Promise<DeployStaticResult> {
  const { token, html } = opts;
  const buf = Buffer.from(html, "utf-8");
  const sha = sha1Hex(buf);

  let site: NetlifySite;
  if (opts.siteId) {
    // Use existing site — Netlify validates it on first deploy call.
    site = { id: opts.siteId, name: opts.siteId, url: "" };
  } else {
    site = await createSite(token, opts.siteName);
  }

  const deploy = await startDeploy(token, site.id, { "/index.html": sha });
  const required = deploy.required ?? [];
  if (required.includes(sha)) {
    await uploadFile(token, deploy.id, "/index.html", buf);
  }

  const finalDeploy = await pollDeploy(token, deploy.id);
  const url =
    finalDeploy.ssl_url ||
    finalDeploy.deploy_ssl_url ||
    finalDeploy.url ||
    site.ssl_url ||
    site.url;
  return {
    site,
    deployId: deploy.id,
    url: url ?? "",
    state: finalDeploy.state,
  };
}
