/**
 * Netlify deploy client.
 *
 * Auth: a personal access token (PAT) the user pastes once. Stored at
 *   <CONFIG_DIR>/landing-pages/netlify.json
 *
 * Per-page hosting state (siteId, last deploy, custom domain) lives at
 *   <CONFIG_DIR>/landing-pages/sites/<pageId>.json
 *
 * Deploy flow:
 *   1. Render the page via `renderer.ts` into a temp dir.
 *   2. Zip the dir.
 *   3. POST zip to /api/v1/sites/:site_id/deploys → { id, deploy_ssl_url, state }.
 *   4. Poll the deploy until state==='ready' or 'error'.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { CONFIG_DIR } from "../utils.js";
import { getLandingPagesStore } from "../community/landing-pages.js";
import { renderPageToDirectory } from "./renderer.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("netlify");

const NETLIFY_API = "https://api.netlify.com/api/v1";
const TOKEN_PATH = path.join(CONFIG_DIR, "landing-pages", "netlify.json");
const SITES_DIR = path.join(CONFIG_DIR, "landing-pages", "sites");

// ── Token storage ───────────────────────────────────────────

interface NetlifyTokenFile {
  token: string;
  defaultSiteId?: string;
  verifiedAtMs?: number;
}

export async function setNetlifyToken(
  token: string,
): Promise<{ ok: boolean; user?: { email?: string; full_name?: string } }> {
  // Verify before storing.
  const me = await fetch(`${NETLIFY_API}/user`, { headers: { Authorization: `Bearer ${token}` } });
  if (!me.ok) throw new Error(`Netlify token rejected (${me.status})`);
  const user = (await me.json()) as { email?: string; full_name?: string };
  await fs.mkdir(path.dirname(TOKEN_PATH), { recursive: true });
  const data: NetlifyTokenFile = { token, verifiedAtMs: Date.now() };
  await fs.writeFile(TOKEN_PATH, JSON.stringify(data, null, 2), "utf-8");
  return { ok: true, user };
}

export async function clearNetlifyToken(): Promise<void> {
  try {
    await fs.unlink(TOKEN_PATH);
  } catch {
    /* ignore */
  }
}

async function loadToken(): Promise<NetlifyTokenFile | null> {
  try {
    const raw = await fs.readFile(TOKEN_PATH, "utf-8");
    return JSON.parse(raw) as NetlifyTokenFile;
  } catch {
    return null;
  }
}

export async function getNetlifyStatus(): Promise<{
  connected: boolean;
  user?: { email?: string; full_name?: string };
  verifiedAtMs?: number;
}> {
  const tok = await loadToken();
  if (!tok) return { connected: false };
  try {
    const res = await fetch(`${NETLIFY_API}/user`, {
      headers: { Authorization: `Bearer ${tok.token}` },
    });
    if (!res.ok) return { connected: false };
    const user = (await res.json()) as { email?: string; full_name?: string };
    return { connected: true, user, verifiedAtMs: tok.verifiedAtMs };
  } catch {
    return { connected: false };
  }
}

async function authedFetch(url: string, init?: RequestInit): Promise<Response> {
  const tok = await loadToken();
  if (!tok) throw new Error("Netlify not connected");
  return fetch(url, {
    ...init,
    headers: {
      ...init?.headers,
      Authorization: `Bearer ${tok.token}`,
    },
  });
}

// ── Per-page site state ─────────────────────────────────────

export interface PageSiteState {
  pageId: string;
  netlifySiteId?: string;
  netlifySiteName?: string;
  defaultUrl?: string;
  customDomain?: string;
  lastDeploy?: {
    id: string;
    state: string;
    url?: string;
    createdAtMs: number;
  };
  history: Array<{
    id: string;
    state: string;
    url?: string;
    createdAtMs: number;
  }>;
}

async function loadSiteState(pageId: string): Promise<PageSiteState> {
  const p = path.join(SITES_DIR, `${pageId}.json`);
  try {
    const raw = await fs.readFile(p, "utf-8");
    return JSON.parse(raw) as PageSiteState;
  } catch {
    return { pageId, history: [] };
  }
}

async function saveSiteState(s: PageSiteState): Promise<void> {
  await fs.mkdir(SITES_DIR, { recursive: true });
  const target = path.join(SITES_DIR, `${s.pageId}.json`);
  const tmp = `${target}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`;
  await fs.writeFile(tmp, JSON.stringify(s, null, 2), "utf-8");
  await fs.rename(tmp, target);
}

export async function getSiteState(pageId: string): Promise<PageSiteState> {
  return loadSiteState(pageId);
}

// ── Site provisioning ───────────────────────────────────────

export async function listNetlifySites(): Promise<
  Array<{ id: string; name: string; url: string }>
> {
  const res = await authedFetch(`${NETLIFY_API}/sites`);
  if (!res.ok) throw new Error(`Netlify list sites failed (${res.status})`);
  const items = (await res.json()) as Array<{
    site_id?: string;
    id?: string;
    name: string;
    ssl_url?: string;
    url?: string;
  }>;
  return items.map((s) => ({
    id: s.site_id || s.id || "",
    name: s.name,
    url: s.ssl_url || s.url || "",
  }));
}

export async function createNetlifySite(
  name: string,
): Promise<{ id: string; name: string; url: string }> {
  const res = await authedFetch(`${NETLIFY_API}/sites`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Netlify create site failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const s = (await res.json()) as {
    site_id?: string;
    id?: string;
    name: string;
    ssl_url?: string;
    url?: string;
  };
  return { id: s.site_id || s.id || "", name: s.name, url: s.ssl_url || s.url || "" };
}

/** Bind a page to an existing Netlify site (or create one with a derived name). */
export async function bindPageToNetlifySite(
  pageId: string,
  opts: { siteId?: string; siteName?: string },
): Promise<PageSiteState> {
  const s = await loadSiteState(pageId);
  if (opts.siteId) {
    // verify site exists
    const res = await authedFetch(`${NETLIFY_API}/sites/${opts.siteId}`);
    if (!res.ok) throw new Error(`Netlify site ${opts.siteId} not found (${res.status})`);
    const info = (await res.json()) as {
      site_id?: string;
      id?: string;
      name: string;
      ssl_url?: string;
      url?: string;
    };
    s.netlifySiteId = info.site_id || info.id || opts.siteId;
    s.netlifySiteName = info.name;
    s.defaultUrl = info.ssl_url || info.url;
  } else {
    const name = (opts.siteName || `lp-${pageId.slice(0, 8)}`)
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-");
    const created = await createNetlifySite(name);
    s.netlifySiteId = created.id;
    s.netlifySiteName = created.name;
    s.defaultUrl = created.url;
  }
  await saveSiteState(s);
  return s;
}

// ── Zip helper (Node-native, no extra deps) ─────────────────

/**
 * Minimal zip writer. We don't have JSZip available; use the system `zip` if
 * present, otherwise fall back to a tar.gz which Netlify also accepts via the
 * `application/zip`-or-tar deploy endpoint? Netlify accepts only zip — so on
 * platforms without `zip`, we ship the deploy as a multi-file create using
 * the file-digest deploy API.
 */
async function zipDirectory(srcDir: string, outZipPath: string): Promise<boolean> {
  // Try system zip first (available on macOS/Linux/Git-Bash on Windows).
  const { spawn } = await import("node:child_process");
  return new Promise<boolean>((resolve) => {
    const proc = spawn("zip", ["-r", outZipPath, "."], { cwd: srcDir, stdio: "ignore" });
    proc.on("error", () => resolve(false));
    proc.on("exit", (code) => resolve(code === 0));
  });
}

// ── Digest-based deploy (works without `zip`) ───────────────

import { createHash } from "node:crypto";

async function* walk(dir: string, base = dir): AsyncGenerator<{ rel: string; abs: string }> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(abs, base);
    } else {
      const rel = path.relative(base, abs).split(path.sep).join("/");
      yield { rel: `/${rel}`, abs };
    }
  }
}

async function deployByDigest(
  siteId: string,
  srcDir: string,
): Promise<{ id: string; state: string; ssl_url?: string }> {
  // 1. Hash every file.
  const files: Record<string, string> = {};
  const fileBuffers: Record<string, Buffer> = {};
  for await (const { rel, abs } of walk(srcDir)) {
    const buf = await fs.readFile(abs);
    fileBuffers[rel] = buf;
    files[rel] = createHash("sha1").update(buf).digest("hex");
  }
  // 2. Create deploy with digest.
  const createRes = await authedFetch(`${NETLIFY_API}/sites/${siteId}/deploys`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ files }),
  });
  if (!createRes.ok)
    throw new Error(
      `Netlify deploy create failed (${createRes.status}): ${await createRes.text()}`,
    );
  const deploy = (await createRes.json()) as {
    id: string;
    required?: string[];
    state: string;
    ssl_url?: string;
  };
  // 3. Upload required files.
  for (const sha of deploy.required || []) {
    const rel = Object.keys(files).find((k) => files[k] === sha);
    if (!rel) continue;
    const buf = fileBuffers[rel];
    const upRes = await authedFetch(`${NETLIFY_API}/deploys/${deploy.id}/files${rel}`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array(buf),
    });
    if (!upRes.ok) throw new Error(`Netlify upload ${rel} failed (${upRes.status})`);
  }
  return { id: deploy.id, state: deploy.state, ssl_url: deploy.ssl_url };
}

async function deployByZip(
  siteId: string,
  srcDir: string,
): Promise<{ id: string; state: string; ssl_url?: string }> {
  const tmp = path.join(os.tmpdir(), `lp-deploy-${Date.now()}.zip`);
  const ok = await zipDirectory(srcDir, tmp);
  if (!ok) throw new Error("zip command failed");
  const buf = await fs.readFile(tmp);
  const res = await authedFetch(`${NETLIFY_API}/sites/${siteId}/deploys`, {
    method: "POST",
    headers: { "Content-Type": "application/zip" },
    body: new Uint8Array(buf),
  });
  await fs.unlink(tmp).catch(() => {});
  if (!res.ok) throw new Error(`Netlify zip deploy failed (${res.status}): ${await res.text()}`);
  const deploy = (await res.json()) as { id: string; state: string; ssl_url?: string };
  return deploy;
}

// ── Public deploy entrypoint ────────────────────────────────

export interface DeployOptions {
  pageId: string;
  /** Public gateway URL the page will call for analytics + form submissions. */
  gatewayUrl: string;
  /** Force re-create site if missing. */
  autoCreate?: boolean;
}

export async function deployPage(opts: DeployOptions): Promise<{
  ok: boolean;
  url?: string;
  deployId?: string;
  state?: string;
  error?: string;
}> {
  const store = getLandingPagesStore();
  const page = store.getPage(opts.pageId);
  if (!page) return { ok: false, error: "page not found" };

  let site = await loadSiteState(opts.pageId);
  if (!site.netlifySiteId) {
    if (!opts.autoCreate)
      return {
        ok: false,
        error: "page is not bound to a Netlify site (call pages.netlify.bind first)",
      };
    site = await bindPageToNetlifySite(opts.pageId, { siteName: page.slug });
  }
  if (!site.netlifySiteId) return { ok: false, error: "no netlify site id after bind" };

  // Render to temp dir.
  const outDir = path.join(os.tmpdir(), `lp-render-${page.id}-${Date.now()}`);
  try {
    await renderPageToDirectory({ page, outDir, gatewayUrl: opts.gatewayUrl });
    let result: { id: string; state: string; ssl_url?: string };
    try {
      result = await deployByZip(site.netlifySiteId, outDir);
    } catch {
      // Fallback: digest-based deploy when `zip` isn't installed.
      result = await deployByDigest(site.netlifySiteId, outDir);
    }
    const entry = {
      id: result.id,
      state: result.state,
      url: result.ssl_url || site.defaultUrl,
      createdAtMs: Date.now(),
    };
    site.lastDeploy = entry;
    site.history = [entry, ...(site.history || [])].slice(0, 25);
    await saveSiteState(site);
    log.info(`deployed page ${page.id} → ${entry.url}`);
    return { ok: true, url: entry.url, deployId: entry.id, state: entry.state };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.warn(`deploy failed: ${msg}`);
    return { ok: false, error: msg };
  } finally {
    // Best-effort cleanup
    try {
      await fs.rm(outDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

export async function getDeployStatus(
  pageId: string,
  deployId: string,
): Promise<{ id: string; state: string; ssl_url?: string }> {
  const res = await authedFetch(`${NETLIFY_API}/deploys/${deployId}`);
  if (!res.ok) throw new Error(`get deploy failed (${res.status})`);
  return res.json() as Promise<{ id: string; state: string; ssl_url?: string }>;
}

export async function setCustomDomain(pageId: string, domain: string): Promise<PageSiteState> {
  const s = await loadSiteState(pageId);
  if (!s.netlifySiteId) throw new Error("no netlify site bound");
  const res = await authedFetch(`${NETLIFY_API}/sites/${s.netlifySiteId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ custom_domain: domain }),
  });
  if (!res.ok) throw new Error(`set domain failed (${res.status})`);
  s.customDomain = domain;
  await saveSiteState(s);
  return s;
}
