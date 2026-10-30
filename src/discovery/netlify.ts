/**
 * Discovery Docs — minimal Netlify REST client.
 *
 * Only the endpoints we actually use:
 *   POST   /sites                                      create
 *   POST   /sites/{id}/deploys                         create deploy + file-digest
 *   PUT    /deploys/{id}/files/{path}                  upload required file blob
 *   GET    /sites/{id}                                 read (status, ssl_url, etc.)
 *   GET    /sites/{id}/forms                           list forms on site
 *   GET    /sites/{id}/submissions                     list submissions (paginated)
 *   DELETE /submissions/{id}                           drop after successful process
 *
 * Auth: personal access token via `Authorization: Bearer <token>`. The
 * token never lands in this module — it's passed in by the caller, read
 * from the local secrets store.
 *
 * Reference: https://docs.netlify.com/api/get-started/
 */

import { createHash } from "node:crypto";

const NETLIFY_API = "https://api.netlify.com/api/v1";

export interface NetlifyClientOpts {
  token: string;
  /** Per-request timeout. Default 30s. */
  timeoutMs?: number;
}

export interface NetlifyError extends Error {
  status: number;
  body?: unknown;
}

export interface NetlifySite {
  id: string;
  name: string;
  ssl_url?: string;
  url?: string;
  admin_url?: string;
  account_slug?: string;
  custom_domain?: string | null;
}

export interface NetlifyDeploy {
  id: string;
  state: string; // "uploading" | "ready" | "error" | ...
  required: string[]; // sha1s that still need to be uploaded
  required_functions?: string[];
  ssl_url?: string;
  deploy_ssl_url?: string;
  deploy_url?: string;
  url?: string;
}

export interface NetlifyForm {
  id: string;
  site_id: string;
  name: string;
  paths?: string[];
  submission_count?: number;
  fields?: Array<{ name: string; type: string }>;
  created_at: string;
}

export interface NetlifySubmission {
  id: string;
  form_id: string;
  form_name: string;
  site_url?: string;
  data: Record<string, string>;
  human_fields?: Record<string, string>;
  ordered_human_fields?: Array<{ name: string; title: string; type: string; value: string }>;
  created_at: string;
}

export class NetlifyClient {
  private token: string;
  private timeoutMs: number;

  constructor(opts: NetlifyClientOpts) {
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  // ── HTTP ────────────────────────────────────────────────────

  private async http<T>(
    method: string,
    path: string,
    body?: unknown,
    rawBody?: Buffer,
    contentType?: string,
  ): Promise<T> {
    const url = `${NETLIFY_API}${path}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json",
      };
      let payload: BodyInit | undefined;
      if (rawBody) {
        payload = new Uint8Array(rawBody) as unknown as BodyInit;
        if (contentType) headers["Content-Type"] = contentType;
      } else if (body !== undefined) {
        headers["Content-Type"] = "application/json";
        payload = JSON.stringify(body);
      }
      const res = await fetch(url, {
        method,
        headers,
        body: payload,
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        let parsed: unknown = text;
        try {
          parsed = JSON.parse(text);
        } catch {
          /* keep text */
        }
        const err = new Error(
          `Netlify ${method} ${path} → ${res.status}: ${typeof parsed === "string" ? parsed.slice(0, 200) : JSON.stringify(parsed).slice(0, 200)}`,
        ) as NetlifyError;
        err.status = res.status;
        err.body = parsed;
        throw err;
      }
      if (!text) return undefined as unknown as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        return text as unknown as T;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Auth check ──────────────────────────────────────────────

  /** Round-trip /user to verify the token works and fetch the default account slug. */
  async whoami(): Promise<{ email?: string; default_account_slug?: string; full_name?: string }> {
    return this.http("GET", "/user");
  }

  // ── Sites ───────────────────────────────────────────────────

  async listSites(): Promise<NetlifySite[]> {
    return this.http("GET", "/sites?per_page=100");
  }

  async getSite(siteId: string): Promise<NetlifySite> {
    return this.http("GET", `/sites/${siteId}`);
  }

  async createSite(opts: {
    name?: string;
    accountSlug?: string;
    custom_domain?: string;
  }): Promise<NetlifySite> {
    const path = opts.accountSlug ? `/${opts.accountSlug}/sites` : `/sites`;
    return this.http("POST", path, {
      name: opts.name,
      custom_domain: opts.custom_domain,
    });
  }

  async findOrCreateSite(opts: { name: string; accountSlug?: string }): Promise<NetlifySite> {
    const sites = await this.listSites();
    const match = sites.find((s) => s.name === opts.name);
    if (match) return match;
    return this.createSite({ name: opts.name, accountSlug: opts.accountSlug });
  }

  // ── Deploy ──────────────────────────────────────────────────

  /**
   * Deploy a flat set of files to the site. Implements Netlify's file-digest
   * pattern:
   *   1. POST { files: { "<path>": "<sha1>" } } → returns { id, required[] }
   *   2. For each sha1 in required, PUT /deploys/{id}/files/<path>
   *   3. The deploy goes "ready" once all required files are uploaded.
   */
  async deployFiles(
    siteId: string,
    files: Array<{ path: string; contents: string | Buffer }>,
  ): Promise<NetlifyDeploy> {
    // Normalize: every file becomes a Buffer; compute sha1 + canonical path.
    const prepared = files.map((f) => {
      const buf = Buffer.isBuffer(f.contents) ? f.contents : Buffer.from(f.contents, "utf-8");
      const sha1 = createHash("sha1").update(buf).digest("hex");
      const path = "/" + f.path.replace(/^\/+/, "");
      return { path, sha1, buf };
    });

    const filesMap: Record<string, string> = {};
    for (const f of prepared) filesMap[f.path] = f.sha1;

    const deploy = await this.http<NetlifyDeploy>("POST", `/sites/${siteId}/deploys`, {
      files: filesMap,
      async: false,
      draft: false,
    });

    // Upload only the files Netlify says it doesn't already have.
    const required = new Set(deploy.required ?? []);
    if (required.size > 0) {
      for (const f of prepared) {
        if (!required.has(f.sha1)) continue;
        await this.http(
          "PUT",
          `/deploys/${deploy.id}/files${f.path}`,
          undefined,
          f.buf,
          "application/octet-stream",
        );
      }
    }
    return deploy;
  }

  // ── Forms / submissions ─────────────────────────────────────

  async listForms(siteId: string): Promise<NetlifyForm[]> {
    return this.http("GET", `/sites/${siteId}/forms`);
  }

  /**
   * List submissions for a site, optionally filtered to one form.
   * Netlify paginates with page/per_page query params (max 100/page).
   * Returns submissions newest-first.
   */
  async listSubmissions(
    siteId: string,
    opts: { formId?: string; page?: number; perPage?: number } = {},
  ): Promise<NetlifySubmission[]> {
    const params = new URLSearchParams();
    if (opts.formId) params.set("form_id", opts.formId);
    params.set("per_page", String(opts.perPage ?? 100));
    if (opts.page) params.set("page", String(opts.page));
    return this.http("GET", `/sites/${siteId}/submissions?${params}`);
  }

  async deleteSubmission(submissionId: string): Promise<void> {
    await this.http("DELETE", `/submissions/${submissionId}`);
  }
}
