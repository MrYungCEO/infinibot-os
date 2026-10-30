/**
 * Public HTTP endpoints for deployed landing pages.
 *
 *   POST /api/pages/track                                — analytics ingest
 *   POST /api/pages/:siteId/forms/:formId/submit         — form submissions
 *
 * No auth — these are called from the public internet by user-deployed sites.
 * CORS is permissive on these specific paths; other endpoints stay locked down.
 *
 * Light rate limiting per (path + IP).
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { ingestEventBatch, type TrackEventBatch } from "../landing-pages/analytics.js";
import { captureSubmission } from "../landing-pages/lead-router.js";
import { getLandingPagesStore } from "../community/landing-pages.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isSaasMode } from "../saas/config.js";
import { getFormBindingStore, processSubmission } from "../forms/bindings.js";
import { feedHubFromLegacyForm } from "../business-hub/legacy-intake.js";
import { resolveStateDir } from "../config/paths.js";
import { getUserStore } from "../users/store.js";
import type { FormAnalyticsEvent, FormAnalyticsEventKind } from "../services/qualifier/forms.js";

const log = createSubsystemLogger("pages-public");

// ── Rate limit (sliding 60s window per ip+path key) ─────────

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 60;
const buckets = new Map<string, number[]>();

function rateLimit(key: string): boolean {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = [];
    buckets.set(key, bucket);
  }
  while (bucket.length > 0 && bucket[0] < now - RATE_LIMIT_WINDOW_MS) bucket.shift();
  if (bucket.length >= RATE_LIMIT_MAX) return false;
  bucket.push(now);
  return true;
}

function clientIp(req: IncomingMessage): string {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.length > 0) return xf.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

function setCorsHeaders(res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

async function readJson<T = unknown>(
  req: IncomingMessage,
  maxBytes = 64 * 1024,
): Promise<T | null> {
  return new Promise((resolve) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

export async function handlePagesPublicRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = req.url || "";
  const isPublicSurface =
    url.startsWith("/api/pages/") ||
    url.startsWith("/api/forms/") ||
    url.startsWith("/api/funnels/") ||
    url.startsWith("/api/users/login") ||
    url.startsWith("/p/funnels/") ||
    url.startsWith("/f/");
  if (!isPublicSurface) return false;

  // Preflight
  if (req.method === "OPTIONS") {
    setCorsHeaders(res);
    res.statusCode = 204;
    res.end();
    return true;
  }

  // POST /api/pages/track
  if (
    req.method === "POST" &&
    (url === "/api/pages/track" || url.startsWith("/api/pages/track?"))
  ) {
    setCorsHeaders(res);
    const ip = clientIp(req);
    if (!rateLimit(`track:${ip}`)) {
      send(res, 429, { error: "rate_limited" });
      return true;
    }
    const body = await readJson<TrackEventBatch>(req);
    if (!body || typeof body !== "object") {
      send(res, 400, { error: "invalid_json" });
      return true;
    }
    try {
      await ingestEventBatch({
        ...body,
        ip,
        userAgent:
          typeof req.headers["user-agent"] === "string"
            ? (req.headers["user-agent"] as string)
            : undefined,
      });
      send(res, 200, { ok: true });
    } catch (e) {
      log.warn(`track ingest failed: ${e instanceof Error ? e.message : String(e)}`);
      send(res, 500, { error: "ingest_failed" });
    }
    return true;
  }

  // POST /api/forms/:bindingId/submit
  // Generic public endpoint — any form scaffolded by a workspace template
  // posts here. Routes to the configured database via the FormBindingStore.
  const fb = url.match(/^\/api\/forms\/([^/?#]+)\/submit(?:[?#].*)?$/);
  if (req.method === "POST" && fb) {
    setCorsHeaders(res);
    const ip = clientIp(req);
    if (!rateLimit(`fbsubmit:${ip}`)) {
      send(res, 429, { error: "rate_limited" });
      return true;
    }
    const bindingId = decodeURIComponent(fb[1]);
    const body = await readJson<Record<string, unknown>>(req);
    if (!body || typeof body !== "object") {
      send(res, 400, { error: "invalid_json" });
      return true;
    }
    // Honeypot — bots fill `company_url`. Pretend success so they don't retry.
    if (typeof body.company_url === "string" && body.company_url.length > 0) {
      send(res, 200, { ok: true });
      return true;
    }
    try {
      const stateDir = resolveStateDir();
      const store = getFormBindingStore(stateDir);
      const binding = store.get(bindingId);
      if (!binding) {
        send(res, 404, { error: "binding_not_found" });
        return true;
      }
      const result = await processSubmission({
        binding,
        data: body,
        ip,
        userAgent:
          typeof req.headers["user-agent"] === "string"
            ? (req.headers["user-agent"] as string)
            : undefined,
        stateDir,
      });
      if (!result.ok) {
        send(res, 500, {
          error: "submit_failed",
          message: result.error ?? "unknown",
          submissionId: result.submissionId,
        });
        return true;
      }
      void feedHubFromLegacyForm({
        sourceName: `Form: ${binding.name}`,
        fields: body,
        pageRef: `form-binding:${binding.id}`,
      });
      send(res, 200, {
        ok: true,
        submissionId: result.submissionId,
        rowId: result.rowId,
        redirect: binding.successRedirect ?? null,
      });
    } catch (e) {
      log.warn(`form-binding submit failed: ${e instanceof Error ? e.message : String(e)}`);
      send(res, 500, { error: "submit_failed" });
    }
    return true;
  }

  // POST /api/pages/:siteId/forms/:formId/submit
  const m = url.match(/^\/api\/pages\/([^/?#]+)\/forms\/([^/?#]+)\/submit(?:[?#].*)?$/);
  if (req.method === "POST" && m) {
    setCorsHeaders(res);
    const ip = clientIp(req);
    if (!rateLimit(`submit:${ip}`)) {
      send(res, 429, { error: "rate_limited" });
      return true;
    }
    const siteId = decodeURIComponent(m[1]);
    const formId = decodeURIComponent(m[2]);
    const body = await readJson<{ pageId?: string; data?: Record<string, unknown> }>(req);
    if (!body || typeof body !== "object") {
      send(res, 400, { error: "invalid_json" });
      return true;
    }
    const data = (body.data || {}) as Record<string, unknown>;
    // Honeypot — frontend posts company_url filled when bots submit.
    if (typeof data.company_url === "string" && data.company_url.length > 0) {
      // Pretend success to confuse bots.
      send(res, 200, { ok: true });
      return true;
    }
    try {
      // Resolve businessId via the page if pageId is provided; otherwise treat siteId as businessId directly.
      let businessId = siteId;
      let pageId = body.pageId || "";
      if (pageId) {
        const page = getLandingPagesStore().getPage(pageId);
        if (page) businessId = page.communityId;
      }
      const sub = await captureSubmission({
        businessId,
        pageId,
        formId,
        data,
        ip,
        userAgent:
          typeof req.headers["user-agent"] === "string"
            ? (req.headers["user-agent"] as string)
            : undefined,
        source: "public-form",
      });
      void feedHubFromLegacyForm({
        sourceName: "Landing page form",
        fields: data,
        pageRef: pageId ? `landing-page:${pageId}` : `site:${siteId}`,
      });
      send(res, 200, { ok: true, submissionId: sub.id });
    } catch (e) {
      log.warn(`form submit failed: ${e instanceof Error ? e.message : String(e)}`);
      send(res, 500, { error: "submit_failed" });
    }
    return true;
  }

  // POST /api/users/login — username/email + user-password → gateway-password
  // Public so the dashboard can translate user credentials into the
  // gateway password before opening the WebSocket. Rate-limited per IP
  // to keep brute force out of reach (60 attempts / minute).
  if (req.method === "POST" && url.startsWith("/api/users/login")) {
    setCorsHeaders(res);
    // SaaS mode: local password login is retired in favor of Clerk.
    if (isSaasMode()) {
      send(res, 403, { error: "clerk_auth_required", message: "Sign in with Clerk." });
      return true;
    }
    const ip = clientIp(req);
    if (!rateLimit(`login:${ip}`)) {
      send(res, 429, { error: "rate_limited" });
      return true;
    }
    const body = await readJson<{ login?: unknown; password?: unknown }>(req);
    if (!body || typeof body.login !== "string" || typeof body.password !== "string") {
      send(res, 400, { error: "invalid_credentials" });
      return true;
    }
    try {
      const result = getUserStore(resolveStateDir()).authenticate(body.login.trim(), body.password);
      if (!result) {
        send(res, 401, { error: "unauthorized" });
        return true;
      }
      const { user, gatewayPassword } = result;
      send(res, 200, {
        ok: true,
        gatewayPassword,
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          role: user.role,
          language: user.language,
          context: user.context,
          homeDir: user.homeDir,
          agentGatingEnabled: user.agentGatingEnabled,
          allowedPages: user.allowedPages,
        },
      });
    } catch (e) {
      log.warn(`users login failed: ${e instanceof Error ? e.message : String(e)}`);
      send(res, 500, { error: "login_failed" });
    }
    return true;
  }

  // OPTIONS preflight for the login endpoint.
  if (req.method === "OPTIONS" && url.startsWith("/api/users/login")) {
    setCorsHeaders(res);
    send(res, 204, null);
    return true;
  }

  // ─── Funnel public surface ────────────────────────────────
  // GET  /p/funnels/<slug>                  → published lead-capture page
  // POST /api/funnels/<slug>/submit         → ingest a submission
  // GET  /api/funnels/<funnelId>/asset/...  → serve a workspace asset
  // OPTIONS preflights for both POST endpoints (browser CORS dance).
  const isFunnelPath = url.startsWith("/p/funnels/") || url.startsWith("/api/funnels/");
  if (isFunnelPath) {
    const handled = await handleFunnelRequest(req, res, url);
    if (handled) return true;
  }

  // ─── Lead-qualifier form builder ──────────────────────────
  // GET  /f/<slug>                            → published form HTML
  // POST /api/forms/lq/<slug>/submit          → run the qualifier pipeline
  // POST /api/forms/lq/<slug>/track           → analytics event ingest
  const isLqForm = url.startsWith("/f/") || url.startsWith("/api/forms/lq/");
  if (isLqForm) {
    const handled = await handleLeadQualifierFormRequest(req, res, url);
    if (handled) return true;
  }

  return false;
}

/**
 * Handle every public funnel route. Lives in a sub-function so the main
 * `handlePagesPublicRequest` stays readable; returns true when the
 * request was matched + handled.
 */
async function handleFunnelRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
): Promise<boolean> {
  // Lazy-load to avoid a circular import at module init.
  const fnMod = await import("../funnels/workspace.js");
  const renderMod = await import("../funnels/page-render.js");
  const storeMod = await import("../funnels/store.js");
  const { getFunnelStore } = storeMod as { getFunnelStore: (stateDir: string) => unknown };

  const stateDir = resolveStateDir();
  const ip = clientIp(req);

  // ── GET /p/funnels/<slug> — render the page ─────────────
  const pageMatch = url.match(/^\/p\/funnels\/([^/?#]+)\/?$/);
  if (req.method === "GET" && pageMatch) {
    const slug = decodeURIComponent(pageMatch[1]);
    const found = findFunnelBySlug(stateDir, slug);
    if (!found) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end("<h1>Page not found</h1>");
      return true;
    }
    const cfg = fnMod.readPageConfig(found.id);
    if (!cfg || !cfg.published) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end("<h1>Page not published</h1>");
      return true;
    }
    const html = renderMod.renderPageHtml(cfg, found.id);
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(html);
    return true;
  }

  // ── POST /api/funnels/<slug>/submit ─────────────────────
  const submitMatch = url.match(/^\/api\/funnels\/([^/?#]+)\/submit(?:[?#].*)?$/);
  if (req.method === "POST" && submitMatch) {
    setCorsHeaders(res);
    if (!rateLimit(`funnel-submit:${ip}`)) {
      send(res, 429, { error: "rate_limited" });
      return true;
    }
    const slug = decodeURIComponent(submitMatch[1]);
    const found = findFunnelBySlug(stateDir, slug);
    if (!found) {
      send(res, 404, { error: "not_found" });
      return true;
    }
    const cfg = fnMod.readPageConfig(found.id);
    if (!cfg || !cfg.published) {
      send(res, 404, { error: "not_published" });
      return true;
    }

    const body = await readJson<Record<string, unknown>>(req);
    if (!body || typeof body !== "object") {
      send(res, 400, { error: "invalid_json" });
      return true;
    }

    // Honeypot — bots fill the hidden field. Pretend success so they
    // don't retry, and log the rejection for monitoring.
    const honeypot = cfg.honeypotField ?? "company_url";
    if (typeof body[honeypot] === "string" && (body[honeypot] as string).length > 0) {
      fnMod.appendSubmission(found.id, {
        ts: Date.now(),
        ip,
        userAgent:
          typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined,
        payload: body,
        rejected: "honeypot",
      });
      send(res, 200, { ok: true });
      return true;
    }

    try {
      // Convert the submission into a lead in the entry stage.
      const { ingestSubmission } = await import("../funnels/intake.js");
      const result = await ingestSubmission({
        stateDir,
        funnelId: found.id,
        payload: body,
        ip,
        userAgent:
          typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined,
      });
      void feedHubFromLegacyForm({
        sourceName: `Funnel page: ${found.id.slice(0, 8)}`,
        fields: body,
        pageRef: `funnel:${found.id}`,
      });
      send(res, 200, { ok: true, leadId: result.leadId, redirect: cfg.thankYouUrl || null });
    } catch (err) {
      log.warn(`funnel submit failed: ${err instanceof Error ? err.message : String(err)}`);
      send(res, 500, { error: "submit_failed" });
    }
    return true;
  }

  if (req.method === "OPTIONS" && submitMatch) {
    setCorsHeaders(res);
    send(res, 204, null);
    return true;
  }

  // ── GET /api/funnels/<funnelId>/asset/<file> ─────────────
  const assetMatch = url.match(/^\/api\/funnels\/([^/]+)\/asset\/([^/?#]+)(?:[?#].*)?$/);
  if (req.method === "GET" && assetMatch) {
    const funnelId = decodeURIComponent(assetMatch[1]);
    const file = decodeURIComponent(assetMatch[2]);
    // Refuse path traversal.
    if (file.includes("..") || file.startsWith("/") || file.includes("\\")) {
      res.statusCode = 400;
      res.end("bad asset path");
      return true;
    }
    const path = require("node:path").join(fnMod.funnelAssetsDir(funnelId), file);
    const fs = require("node:fs") as typeof import("node:fs");
    if (!fs.existsSync(path)) {
      res.statusCode = 404;
      res.end("");
      return true;
    }
    const buf = fs.readFileSync(path);
    res.statusCode = 200;
    res.setHeader("Content-Type", contentTypeFor(file));
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.end(buf);
    return true;
  }

  // Surface for the linter — store namespace is used to ensure the import
  // type-checks even though the workspace functions do the heavy lifting.
  void getFunnelStore;
  return false;
}

/**
 * Look up a funnel by its public page slug. Walks every funnel in the
 * state dir's `funnels/` workspace, reading each `page.json` until a
 * match is found. Cheap because there are typically <50 funnels.
 */
function findFunnelBySlug(stateDir: string, slug: string): { id: string } | null {
  try {
    const path = require("node:path") as typeof import("node:path");
    const fs = require("node:fs") as typeof import("node:fs");
    const root = path.join(stateDir, "funnels");
    if (!fs.existsSync(root)) return null;
    for (const id of fs.readdirSync(root)) {
      const cfgPath = path.join(root, id, "page.json");
      if (!fs.existsSync(cfgPath)) continue;
      try {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8")) as { slug?: string };
        if (cfg?.slug === slug) return { id };
      } catch {
        /* skip */
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

function contentTypeFor(file: string): string {
  const ext = file.toLowerCase().split(".").pop() ?? "";
  return (
    (
      {
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        gif: "image/gif",
        webp: "image/webp",
        svg: "image/svg+xml",
        pdf: "application/pdf",
        mp4: "video/mp4",
        webm: "video/webm",
      } as Record<string, string>
    )[ext] ?? "application/octet-stream"
  );
}

/**
 * Public surface for the lead-qualifier form builder.
 *
 *   GET  /f/<slug>                         → render the published HTML
 *   POST /api/forms/lq/<slug>/submit       → run the qualifier pipeline
 *   POST /api/forms/lq/<slug>/track        → analytics event ingest
 *
 * Submission flow:
 *   1. Look up the form by slug.
 *   2. If `qualifierBusinessId` is set load that qualifier config; otherwise
 *      fall back to the form's `businessId`. If no config exists we still
 *      log the submission so leads aren't dropped.
 *   3. Run the action stack against `{ body: data }` so it matches the
 *      same payload shape the webhook handlers receive.
 *   4. Append a submission record + emit a synthetic analytics event so
 *      the KPI dashboard updates in real time.
 */
async function handleLeadQualifierFormRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
): Promise<boolean> {
  const formsMod = await import("../services/qualifier/forms.js");
  const renderMod = await import("../services/qualifier/form-render.js");
  const ip = clientIp(req);

  // ── GET /f/<slug> — render the page ─────────────────────
  const pageMatch = url.match(/^\/f\/([^/?#]+)\/?$/);
  if (req.method === "GET" && pageMatch) {
    const slug = decodeURIComponent(pageMatch[1]);
    const form = formsMod.getFormBySlug(slug);
    if (!form || !form.published) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end("<h1>Form not found</h1>");
      return true;
    }
    const html = renderMod.renderFormHtml(form);
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(html);
    return true;
  }

  // ── POST /api/forms/lq/<slug>/submit ────────────────────
  const submitMatch = url.match(/^\/api\/forms\/lq\/([^/?#]+)\/submit(?:[?#].*)?$/);
  if (req.method === "POST" && submitMatch) {
    setCorsHeaders(res);
    if (!rateLimit(`lq-form-submit:${ip}`)) {
      send(res, 429, { error: "rate_limited" });
      return true;
    }
    const slug = decodeURIComponent(submitMatch[1]);
    const form = formsMod.getFormBySlug(slug);
    if (!form || !form.published) {
      send(res, 404, { error: "form_not_found" });
      return true;
    }
    const body = await readJson<{
      formId?: string;
      vid?: string;
      utm?: Record<string, string>;
      score?: number;
      data?: Record<string, unknown>;
    }>(req);
    if (!body || typeof body !== "object") {
      send(res, 400, { error: "invalid_json" });
      return true;
    }
    const data = (body.data ?? {}) as Record<string, unknown>;
    // Honeypot — bots fill the hidden field.
    if (
      typeof data[form.honeypotField] === "string" &&
      (data[form.honeypotField] as string).length > 0
    ) {
      const ts = Date.now();
      formsMod.appendSubmission(form.id, {
        id: `sub_${ts}_${Math.random().toString(36).slice(2, 8)}`,
        formId: form.id,
        ts,
        payload: data,
        qualified: false,
        score: 0,
        ip,
        userAgent:
          typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined,
        utm: body.utm,
        rejected: "honeypot",
      });
      send(res, 200, { ok: true });
      return true;
    }

    const score = typeof body.score === "number" ? body.score : 0;
    const qualifiedByScore = score >= form.qualifier.scoreThreshold;

    let leadId: string | undefined;
    let qualifierResult: "qualified" | "unqualified" | "error" = qualifiedByScore
      ? "qualified"
      : "unqualified";

    try {
      const { getConfig } = await import("../services/qualifier/store.js");
      const { runQualifier } = await import("../services/qualifier/runner.js");
      const qualifierId = form.qualifierBusinessId || form.businessId;
      const config = qualifierId ? getConfig(qualifierId) : null;
      if (config) {
        const payload = { body: data, _meta: { formId: form.id, score, utm: body.utm } };
        const result = await runQualifier(payload, config);
        leadId = result.leadId;
        qualifierResult = result.result;
      }
    } catch (e) {
      log.warn(`lq form qualifier run failed: ${e instanceof Error ? e.message : String(e)}`);
      qualifierResult = "error";
    }

    const qualified = qualifiedByScore && qualifierResult !== "unqualified";
    void feedHubFromLegacyForm({
      sourceName: `Lead qualifier: ${form.slug}`,
      fields: data,
      utm: body.utm
        ? {
            campaign: body.utm.campaign ?? body.utm.utm_campaign ?? null,
            source: body.utm.source ?? body.utm.utm_source ?? null,
          }
        : null,
      pageRef: `lq-form:${form.id}`,
    });
    const ts = Date.now();
    formsMod.appendSubmission(form.id, {
      id: `sub_${ts}_${Math.random().toString(36).slice(2, 8)}`,
      formId: form.id,
      ts,
      payload: data,
      qualified,
      leadId,
      score,
      ip,
      userAgent:
        typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined,
      utm: body.utm,
    });

    // Stitch into the funnel KPI dashboard when this form is linked to
    // a funnel — the funnel-level aggregation reads back form
    // submissions by funnelId, so all we need to do is make sure the
    // submission record (already written above) carries the linkage.
    // No additional write needed here; the form summary endpoint
    // aggregates across forms that share a funnelId.

    // Auto-ingest into the bound funnel. If the user has bound this
    // form to a (funnel, stage) pair via funnels.form.bind, drop a
    // lead in that stage now so the funnel canvas + flow snapshot
    // see the submission. Best-effort — never block the submit
    // response on funnel writes.
    try {
      const { getFunnelStore } = await import("../funnels/store.js");
      const store = getFunnelStore();
      const binding = store.getFormBinding(form.id);
      if (binding) {
        // If qualifier already created a lead, move it onto this funnel/stage
        // and tag with the form id so flow.snapshot attributes it correctly.
        const tag = binding.tag ? `form_${binding.tag}` : `form_${form.id}`;
        if (leadId) {
          const existing = store.getLead(leadId);
          if (existing) {
            const tags = Array.from(new Set([...(existing.tags ?? []), tag, `form_${form.id}`]));
            store.updateLead(leadId, {
              funnelId: binding.funnelId,
              stageId: binding.entryStageId,
              tags,
            });
          }
        } else {
          // Qualifier didn't run (no save-to-crm action) — create a lead
          // from the form payload directly. We pull common contact
          // fields by convention; unknown fields land in customFields.
          const name =
            (typeof data.name === "string" && data.name) ||
            (typeof data.fullName === "string" && data.fullName) ||
            (typeof data.email === "string" && data.email) ||
            "Form submission";
          const created = store.createLead({
            businessId: binding.businessId,
            funnelId: binding.funnelId,
            stageId: binding.entryStageId,
            name,
            email: typeof data.email === "string" ? data.email : undefined,
            phone: typeof data.phone === "string" ? data.phone : undefined,
            company: typeof data.company === "string" ? data.company : undefined,
            source: "form" as never,
            status: qualified ? ("qualified" as never) : ("new" as never),
            priority: "medium" as never,
            score: typeof score === "number" ? score : undefined,
            tags: [tag, `form_${form.id}`],
            customFields: data,
          });
          leadId = created.id;
        }
      }
    } catch (e) {
      log.warn(`lq form → funnel ingest failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    send(res, 200, {
      ok: true,
      qualified,
      leadId,
      redirect: form.content.thankYouUrl || null,
    });
    return true;
  }

  if (req.method === "OPTIONS" && submitMatch) {
    setCorsHeaders(res);
    send(res, 204, null);
    return true;
  }

  // ── POST /api/forms/lq/<slug>/track ─────────────────────
  const trackMatch = url.match(/^\/api\/forms\/lq\/([^/?#]+)\/track(?:[?#].*)?$/);
  if (req.method === "POST" && trackMatch) {
    setCorsHeaders(res);
    if (!rateLimit(`lq-form-track:${ip}`)) {
      send(res, 429, { error: "rate_limited" });
      return true;
    }
    const slug = decodeURIComponent(trackMatch[1]);
    const form = formsMod.getFormBySlug(slug);
    if (!form) {
      send(res, 404, { error: "form_not_found" });
      return true;
    }
    const body = await readJson<Partial<FormAnalyticsEvent>>(req);
    if (!body || typeof body !== "object" || typeof body.kind !== "string") {
      send(res, 400, { error: "invalid_event" });
      return true;
    }
    formsMod.appendAnalytics(form.id, {
      ts: typeof body.ts === "number" ? body.ts : Date.now(),
      vid: typeof body.vid === "string" ? body.vid : "anon",
      kind: body.kind as FormAnalyticsEventKind,
      field: typeof body.field === "string" ? body.field : undefined,
      step: typeof body.step === "number" ? body.step : undefined,
      ref: typeof body.ref === "string" ? body.ref.slice(0, 240) : undefined,
      utm: (body.utm as Record<string, string>) ?? undefined,
      leadId: typeof body.leadId === "string" ? body.leadId : undefined,
      qualified: typeof body.qualified === "boolean" ? body.qualified : undefined,
    });
    send(res, 200, { ok: true });
    return true;
  }

  if (req.method === "OPTIONS" && trackMatch) {
    setCorsHeaders(res);
    send(res, 204, null);
    return true;
  }

  return false;
}
