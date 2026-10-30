/**
 * Loops.so REST client.
 *
 * Why a thin wrapper instead of `@loops/api`: the official npm package
 * trails the REST API; we want the full surface (events, transactional,
 * mailing-list management, custom properties) and a single shape that
 * agent tools, gateway methods, and CRM sync can all share.
 *
 * Loops API docs: https://loops.so/docs/api
 *
 * Auth: `Authorization: Bearer <apiKey>`. Base URL is
 * `https://app.loops.so/api/v1` and is overridable for tests.
 *
 * Failure model: every method returns the parsed JSON body on success or
 * throws a `LoopsApiError` with the HTTP status + Loops error message on
 * failure. Callers decide whether to log/swallow (sync paths) or surface
 * (agent tools).
 */
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("loops").child("client");

export interface LoopsClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** Hard timeout per request in ms. Default 15s — Loops is usually fast,
   *  but their batch endpoints can stall on retry. */
  timeoutMs?: number;
}

export class LoopsApiError extends Error {
  readonly status: number;
  readonly path: string;
  readonly body: unknown;
  constructor(status: number, path: string, message: string, body?: unknown) {
    super(`Loops API ${status} on ${path}: ${message}`);
    this.name = "LoopsApiError";
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

/** Common shape used across endpoints. Loops accepts `email` OR `userId`
 *  to identify a contact; everything else is application-defined. */
export interface ContactPayload {
  email?: string;
  userId?: string;
  firstName?: string;
  lastName?: string;
  source?: string;
  /** false = unsubscribe (still kept; no marketing emails). true = re-subscribe. */
  subscribed?: boolean;
  /** Free-form bucket Loops uses for segmentation alongside lists. */
  userGroup?: string;
  /** Map of mailingListId → true (add) | false (remove). */
  mailingLists?: Record<string, boolean>;
  /** Anything else lands as a custom property. */
  [k: string]: unknown;
}

export interface MailingList {
  id: string;
  name: string;
  isPublic: boolean;
  description?: string | null;
}

export interface CustomProperty {
  key: string;
  label: string;
  type: "string" | "number" | "boolean" | "date";
}

export interface SendEventInput {
  email?: string;
  userId?: string;
  eventName: string;
  eventProperties?: Record<string, unknown>;
  mailingLists?: Record<string, boolean>;
  contactProperties?: Record<string, unknown>;
}

export interface SendTransactionalInput {
  transactionalId: string;
  email: string;
  /** Liquid variables resolved into the template body. */
  dataVariables?: Record<string, unknown>;
  /** Auto-add the recipient as a Loops contact if missing. */
  addToAudience?: boolean;
  /** File attachments — base64 encoded; Loops accepts up to 5. */
  attachments?: Array<{ filename: string; contentType: string; data: string }>;
}

export class LoopsClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: LoopsClientOptions) {
    if (!opts.apiKey || !opts.apiKey.trim()) {
      throw new Error("LoopsClient: apiKey is required");
    }
    this.apiKey = opts.apiKey.trim();
    this.baseUrl = (opts.baseUrl ?? "https://app.loops.so/api/v1").replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  // ── Internal HTTP ────────────────────────────────────────────

  private async request<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
    query?: Record<string, string | undefined>,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
      }
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      const text = await res.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        // Loops sometimes returns plain-text errors for 5xx; keep `text`.
      }
      if (!res.ok) {
        const message =
          (parsed && typeof parsed === "object" && (parsed as { message?: string }).message) ||
          text ||
          res.statusText;
        throw new LoopsApiError(res.status, path, String(message), parsed ?? text);
      }
      return (parsed ?? {}) as T;
    } catch (err) {
      if (err instanceof LoopsApiError) throw err;
      if ((err as { name?: string }).name === "AbortError") {
        throw new LoopsApiError(0, path, `request timeout after ${this.timeoutMs}ms`);
      }
      throw new LoopsApiError(0, path, (err as Error).message);
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Public API ───────────────────────────────────────────────

  /** Verify the API key. Returns Loops's team name for sanity-check display. */
  async verifyKey(): Promise<{ success: boolean; teamName?: string }> {
    const res = await this.request<{ success: boolean; teamName?: string }>("GET", "/api-key");
    return res;
  }

  // ── Contacts ──────────────────────────────────────────────────

  /** Create-or-do-nothing. If the email already exists Loops returns 409;
   *  use `upsert` if you don't care which path you took. */
  async createContact(
    payload: ContactPayload,
  ): Promise<{ success: boolean; id?: string; message?: string }> {
    return this.request("POST", "/contacts/create", payload);
  }

  async updateContact(
    payload: ContactPayload,
  ): Promise<{ success: boolean; id?: string; message?: string }> {
    return this.request("PUT", "/contacts/update", payload);
  }

  /** Idempotent: tries update, falls back to create on 404. */
  async upsertContact(
    payload: ContactPayload,
  ): Promise<{ success: boolean; id?: string; created: boolean }> {
    if (!payload.email && !payload.userId) {
      throw new Error("upsertContact: email or userId required");
    }
    try {
      const res = await this.updateContact(payload);
      return { success: !!res.success, id: res.id, created: false };
    } catch (err) {
      if (err instanceof LoopsApiError && err.status === 404) {
        const res = await this.createContact(payload);
        return { success: !!res.success, id: res.id, created: true };
      }
      throw err;
    }
  }

  async findContact(query: { email?: string; userId?: string }): Promise<ContactPayload | null> {
    const res = await this.request<unknown>("GET", "/contacts/find", undefined, {
      email: query.email,
      userId: query.userId,
    });
    if (Array.isArray(res) && res.length > 0) return res[0] as ContactPayload;
    if (res && typeof res === "object") {
      // Some Loops versions return `{ contact: {...} }` directly.
      const c = res as { contact?: ContactPayload; success?: boolean };
      if (c.contact) return c.contact;
    }
    return null;
  }

  async deleteContact(query: {
    email?: string;
    userId?: string;
  }): Promise<{ success: boolean; message?: string }> {
    return this.request("POST", "/contacts/delete", query);
  }

  // ── Mailing lists ─────────────────────────────────────────────

  async listMailingLists(): Promise<MailingList[]> {
    const res = await this.request<MailingList[] | { lists: MailingList[] }>("GET", "/lists");
    if (Array.isArray(res)) return res;
    return res.lists ?? [];
  }

  // ── Custom fields (a.k.a. custom properties) ────────────────
  //
  // The endpoint name has shifted across Loops API versions
  // (/customProperties → /customFields). Try the current name, fall
  // back to the legacy one on 404, and swallow a final 404 as "no
  // fields configured" so the dashboard doesn't error out for
  // operators who haven't set any custom fields yet.

  async listCustomProperties(): Promise<CustomProperty[]> {
    const paths = ["/contacts/customFields", "/contacts/customProperties"];
    for (const path of paths) {
      try {
        const res = await this.request<
          CustomProperty[] | { properties?: CustomProperty[]; fields?: CustomProperty[] }
        >("GET", path);
        if (Array.isArray(res)) return res;
        return res.properties ?? res.fields ?? [];
      } catch (err) {
        if (err instanceof LoopsApiError && err.status === 404) continue;
        throw err;
      }
    }
    return [];
  }

  // ── Events (campaign triggers) ───────────────────────────────

  async sendEvent(input: SendEventInput): Promise<{ success: boolean; message?: string }> {
    if (!input.email && !input.userId) {
      throw new Error("sendEvent: email or userId required");
    }
    if (!input.eventName || !input.eventName.trim()) {
      throw new Error("sendEvent: eventName required");
    }
    return this.request("POST", "/events/send", input);
  }

  // ── Transactional ────────────────────────────────────────────

  async sendTransactional(
    input: SendTransactionalInput,
  ): Promise<{ success: boolean; message?: string }> {
    if (!input.transactionalId) throw new Error("sendTransactional: transactionalId required");
    if (!input.email) throw new Error("sendTransactional: email required");
    return this.request("POST", "/transactional", input);
  }

  // ── Diagnostic ───────────────────────────────────────────────

  /** Best-effort smoke test for the connection — used by the gateway's
   *  health snapshot. Returns null on any failure rather than throwing,
   *  so the health pipeline never goes red on a transient Loops outage. */
  async safeVerify(): Promise<{ ok: boolean; teamName?: string; error?: string }> {
    try {
      const res = await this.verifyKey();
      return { ok: !!res.success, teamName: res.teamName };
    } catch (err) {
      log.warn(`verifyKey failed: ${(err as Error).message}`);
      return { ok: false, error: (err as Error).message };
    }
  }
}

let cachedSingleton: { key: string; client: LoopsClient } | null = null;

/** Singleton accessor keyed by API key. The gateway re-resolves on each
 *  request so config edits take effect without a restart. */
export function getLoopsClient(apiKey: string | undefined | null): LoopsClient | null {
  const key = (apiKey ?? "").trim();
  if (!key) return null;
  if (cachedSingleton?.key === key) return cachedSingleton.client;
  cachedSingleton = { key, client: new LoopsClient({ apiKey: key }) };
  return cachedSingleton.client;
}
