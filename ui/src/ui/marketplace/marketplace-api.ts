/**
 * Client for the plugin marketplace API (Netlify Functions, same origin as the
 * cloud app): `/api/marketplace/{publisher,admin,purchases}/*`, Clerk session JWT
 * as bearer. Server contract: src/saas/cloud/marketplace/{publisher,admin}-api.ts.
 */
import { getClerkToken } from "../saas-clerk";

export class MarketplaceApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export type SubmissionStatus =
  | "draft" | "submitted" | "in_review" | "changes_requested" | "approved" | "rejected" | "published" | "unlisted" | "suspended";

export interface Pricing { model: "free" | "paid"; priceCents: number; currency: string; purchaseUrl: string | null }
export interface Proposal {
  name: string; tagline: string; description: string; category: string; tags: string[]; homepageUrl: string | null;
  changelog: string; distribution: "hosted" | "external"; pricing: Pricing; cover: string | null; icon: string | null;
  screenshots: Array<{ src: string; caption?: string }>;
}
export interface ScanFinding { severity: "info" | "warn" | "high"; code: string; message: string; files?: string[] }
export interface SubmissionView {
  id: string; pluginId: string; status: SubmissionStatus; proposal: Proposal; reviewerEmail: string | null;
  checklist: Record<string, boolean>; notes: string | null; submittedAt: string | null; decidedAt: string | null;
  createdAt: string; updatedAt: string; version: string; sizeBytes: number; sha256: string; hasZip: boolean; blockers: string[];
  preview: { cover: string | null; icon: string | null; screenshots: Array<{ src: string; caption?: string; url: string | null }> };
  permissions?: Record<string, unknown>;
  scan?: { findings: ScanFinding[]; hosts: string[]; counts: { files: number; code: number; bytes: number } };
  fileCount?: number;
  history?: Array<{ action: string; actorRole: string; fromStatus: string | null; toStatus: string | null; notes: string | null; at: string }>;
}
export interface Publisher { id: string; slug: string; name: string; email: string | null; website: string | null; bio: string | null; verified: boolean; status: string; apiTokenHint: string | null }
export interface Notice { id: number; kind: string; title: string; body: string; submissionId: string | null; pluginId: string | null; read: boolean; at: string }
export interface PublisherMe {
  publisher: Publisher | null; staffRole: "owner" | "admin" | "reviewer" | null; email: string | null; categories: string[];
  limits: { maxZipBytes: number; partBytes: number }; notices: Notice[];
}
export interface PluginStats { downloads: number; downloads30d: number; purchases: number; refunds: number; revenueCents: number }
export interface MyPlugin {
  id: string; name: string; status: string; latestVersion: string | null;
  pricing: { model: string; priceCents: number; currency: string; purchaseUrl: string | null };
  distribution: string; statusReason: string | null; stats: PluginStats;
}
/** A paid first-party purchase (Whop checkout on our site). */
export interface Purchase {
  id: string; pluginId: string; email: string | null; clerkUserId: string | null; whopMembershipId: string | null; whopPaymentId: string | null;
  whopPlanId: string | null; amountCents: number | null; currency: string; status: "paid" | "refunded"; source: string; ref: string | null;
  createdAt: string; updatedAt: string;
}
export interface MemberPurchase {
  id: string; pluginId: string; pluginName: string; status: "paid" | "refunded"; createdAt: string;
  amountCents: number | null; currency: string; receiptUrl: string | null;
}
export interface PurchaseSummary {
  purchases: Purchase[];
  perPlugin: Array<{ pluginId: string; name: string; priceCents: number; currency: string; onSale: boolean } & PluginStats>;
  totals: { purchases: number; refunds: number; revenueCents: number };
}
export interface WhopSync {
  sync: { pluginId: string; productId: string | null; planId: string | null; priceCents: number; actions: string[]; changed: boolean };
  applied: boolean;
}
export interface ValidationFailure { errors: Array<{ code: string; message: string }> }

export interface QueueItem {
  id: string; pluginId: string; name: string; status: SubmissionStatus; version: string; previousVersion: string | null; isUpdate: boolean;
  publisher: { id: string; name: string; verified: boolean }; reviewerEmail: string | null; submittedAt: string | null; updatedAt: string | null;
  sizeBytes: number; distribution: string; pricing: Pricing | null; findings: { high: number; warn: number; info: number };
}
export interface Queue { counts: Record<string, number>; submissions: QueueItem[] }
export interface ChecklistItem { id: string; label: string }
export interface SubmissionDetail {
  submission: SubmissionView;
  plugin: { id: string; status: string; firstParty: boolean; latestVersion: string | null; pricing: Pricing; pricingLocked: boolean };
  publisher: { id: string; name: string; email: string | null; website: string | null; verified: boolean; since: string | null };
  manifest: Record<string, unknown>;
  files: Array<{ path: string; size: number }>;
  previousVersion: { version: string; releasedAt: string | null } | null;
  permissionDiff: { added: string[]; removed: string[]; unchanged: string[] };
  actions: string[];
  checklist: ChecklistItem[];
}
export interface FileView { path: string; size: number; binary: boolean; truncated: boolean; content: string | null }
export interface CatalogPlugin {
  id: string; name: string; tagline: string | null; category: string; firstParty: boolean; status: "draft" | "published" | "unlisted" | "suspended";
  distribution: "hosted" | "external"; pricing: Pricing; pricingLocked: boolean; includedPlans: string[]; featured: boolean; sortOrder: number;
  affiliateEnabled: boolean; latestVersion: string | null; statusReason: string | null; updatedAt: string;
  whopProductId: string | null; whopPlanId: string | null; whopPriceCents: number | null; whopSyncedAt: string | null;
  publisher: { id: string; name: string; verified: boolean }; stats: PluginStats;
}
export interface Catalog {
  plugins: CatalogPlugin[]; plans: Array<{ id: string; name: string; active: boolean }>;
  /** Whether the site has WHOP_API_KEY + WHOP_COMPANY_ID (names of the missing ones). */
  whop?: { configured: boolean; missing: string[] };
}
export interface AuditEntry { id: number; at: string | null; actorEmail: string; actorRole: string; action: string; pluginId: string | null; submissionId: string | null; detail: Record<string, unknown> }

const MESSAGES: Record<string, string> = {
  unauthorized: "Your session expired. Sign in again.",
  forbidden: "This account does not have access to that.",
  not_a_publisher: "Create a publisher profile first.",
  network: "Could not reach the marketplace.",
};

export function marketplaceApiBase(): string {
  const raw = (import.meta.env.VITE_MARKETPLACE_API_BASE as string | undefined)?.trim() ?? "";
  return `${raw.replace(/\/+$/, "")}/api/marketplace`;
}

const enc = encodeURIComponent;

export class MarketplaceApi {
  private async send(method: string, path: string, init: { json?: unknown; body?: BodyInit; type?: string } = {}): Promise<Response> {
    const once = async (fresh: boolean) => {
      const token = await getClerkToken({ fresh });
      if (!token) throw new MarketplaceApiError(401, "unauthorized", MESSAGES.unauthorized);
      return fetch(`${marketplaceApiBase()}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(init.json !== undefined ? { "content-type": "application/json" } : init.type ? { "content-type": init.type } : {}),
        },
        body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
        credentials: "omit",
        cache: "no-store",
      });
    };
    try {
      let res = await once(false);
      if (res.status === 401) res = await once(true);
      return res;
    } catch (err) {
      if (err instanceof MarketplaceApiError) throw err;
      throw new MarketplaceApiError(0, "network", MESSAGES.network);
    }
  }

  async call<T>(method: string, path: string, init: { json?: unknown; body?: BodyInit; type?: string } = {}): Promise<T> {
    const res = await this.send(method, path, init);
    const data = (await res.json().catch(() => null)) as (T & { error?: string; message?: string }) | null;
    if (!res.ok) {
      const code = typeof data?.error === "string" ? data.error : "";
      const msg = (typeof data?.message === "string" && data.message) || MESSAGES[code] || (code ? code.replace(/_/g, " ") : `HTTP ${res.status}`);
      throw new MarketplaceApiError(res.status, code, msg, (data ?? {}) as Record<string, unknown>);
    }
    return data as T;
  }

  // ── Publisher ──
  me = () => this.call<PublisherMe>("GET", "/publisher/me");
  becomePublisher = (p: { name: string; website?: string; bio?: string }) => this.call<{ publisher: Publisher }>("POST", "/publisher", { json: p });
  markNoticesRead = () => this.call("POST", "/publisher/notices/read", { json: {} });
  submissions = () => this.call<{ submissions: SubmissionView[] }>("GET", "/publisher/submissions");
  submission = (id: string) => this.call<{ submission: SubmissionView }>("GET", `/publisher/submissions/${enc(id)}`);
  saveProposal = (id: string, patch: Partial<Proposal> & { pricing?: Partial<Pricing> }) =>
    this.call<{ submission: SubmissionView }>("PATCH", `/publisher/submissions/${enc(id)}`, { json: patch });
  submit = (id: string) => this.call<{ submission: SubmissionView }>("POST", `/publisher/submissions/${enc(id)}/submit`, { json: {} });
  withdraw = (id: string) => this.call<{ submission: SubmissionView }>("POST", `/publisher/submissions/${enc(id)}/withdraw`, { json: {} });
  addScreenshot = (id: string, file: File, caption: string) =>
    this.call<{ submission: SubmissionView }>("POST", `/publisher/submissions/${enc(id)}/screenshots?caption=${enc(caption)}`, { body: file, type: file.type });
  createExternal = (external: { id: string; name: string; version: string }) =>
    this.call<{ submission: SubmissionView }>("POST", "/publisher/submissions", { json: { external } });
  myPlugins = () => this.call<{ plugins: MyPlugin[] }>("GET", "/publisher/plugins");

  /** Chunked zip upload → validated draft submission. A 422 carries the validation report. */
  async uploadZip(file: Blob, onProgress?: (done: number, total: number) => void): Promise<{ submission: SubmissionView }> {
    const up = await this.call<{ uploadId: string; partBytes: number; maxBytes: number }>("POST", "/publisher/uploads", { json: {} });
    if (file.size > up.maxBytes) throw new MarketplaceApiError(413, "zip_too_large", `The zip is larger than ${Math.round(up.maxBytes / 1048576)} MB.`);
    for (let n = 0, at = 0; at < file.size || n === 0; n++, at += up.partBytes) {
      await this.call("PUT", `/publisher/uploads/${enc(up.uploadId)}/parts/${n}`, { body: file.slice(at, at + up.partBytes), type: "application/octet-stream" });
      onProgress?.(Math.min(at + up.partBytes, file.size), file.size);
    }
    return this.call<{ submission: SubmissionView }>("POST", "/publisher/submissions", { json: { uploadId: up.uploadId } });
  }

  // ── Member ──
  /** Paid first-party plugins this account bought (Clerk user or the same email), with receipt links. */
  myPurchases = () => this.call<{ purchases: MemberPurchase[] }>("GET", "/purchases/mine");

  // ── Staff ──
  adminMe = () => this.call<{ email: string; role: "owner" | "admin" | "reviewer"; checklist: ChecklistItem[] }>("GET", "/admin/me");
  queue = (q: { status?: string; q?: string } = {}) => {
    const p = new URLSearchParams();
    if (q.status) p.set("status", q.status);
    if (q.q) p.set("q", q.q);
    return this.call<Queue>("GET", `/admin/queue${p.size ? `?${p}` : ""}`);
  };
  detail = (id: string) => this.call<SubmissionDetail>("GET", `/admin/submissions/${enc(id)}`);
  file = (id: string, path: string) => this.call<FileView>("GET", `/admin/submissions/${enc(id)}/file?path=${enc(path)}`);
  saveChecklist = (id: string, checklist: Record<string, boolean>) =>
    this.call<{ submission: SubmissionView }>("POST", `/admin/submissions/${enc(id)}/checklist`, { json: { checklist } });
  decide = (id: string, action: string, body: { notes?: string; checklist?: Record<string, boolean>; publish?: boolean } = {}) =>
    this.call<{ submission: SubmissionView }>("POST", `/admin/submissions/${enc(id)}/${enc(action)}`, { json: body });
  pluginAction = (pluginId: string, action: "unlist" | "suspend" | "restore", reason = "") =>
    this.call("POST", `/admin/plugins/${enc(pluginId)}/${action}`, { json: { reason } });
  /** The submission zip as an object URL (the endpoint needs the bearer, so no plain link). */
  async zipUrl(id: string): Promise<string> {
    const res = await this.send("GET", `/admin/submissions/${enc(id)}/zip`);
    if (!res.ok) throw new MarketplaceApiError(res.status, "download_failed", "Could not download the zip.");
    return URL.createObjectURL(await res.blob());
  }
  catalog = () => this.call<Catalog>("GET", "/admin/catalog");
  updatePlugin = (id: string, patch: Record<string, unknown>) => this.call("PATCH", `/admin/plugins/${enc(id)}`, { json: patch });
  /** Create / reprice the plugin's Whop product + one-time plan (`dryRun`: report only). */
  whopSync = (pluginId: string, dryRun = false) => this.call<WhopSync>("POST", `/admin/plugins/${enc(pluginId)}/whop-sync`, { json: { dryRun } });
  purchases = (pluginId?: string) => this.call<PurchaseSummary>("GET", `/admin/purchases${pluginId ? `?pluginId=${enc(pluginId)}` : ""}`);
  whopProducts = () => this.call<{ products: Array<{ whopId: string; pluginId: string; pluginName: string; note: string | null; createdAt: string | null }> }>("GET", "/admin/whop-products");
  mapWhop = (whopId: string, pluginId: string, note: string) => this.call("POST", "/admin/whop-products", { json: { whopId, pluginId, note } });
  unmapWhop = (whopId: string) => this.call("DELETE", `/admin/whop-products/${enc(whopId)}`);
  reviewers = () => this.call<{ owner: string | null; reviewers: Array<{ email: string; role: string; addedBy: string; createdAt: string | null }> }>("GET", "/admin/reviewers");
  addReviewer = (email: string, role: string) => this.call("POST", "/admin/reviewers", { json: { email, role } });
  removeReviewer = (email: string) => this.call("DELETE", `/admin/reviewers/${enc(email)}`);
  audit = (pluginId?: string) => this.call<{ entries: AuditEntry[] }>("GET", `/admin/audit${pluginId ? `?pluginId=${enc(pluginId)}` : ""}`);
}

export const STATUS_TONE: Record<string, "ok" | "warn" | "bad" | "idle"> = {
  draft: "idle", submitted: "warn", in_review: "warn", changes_requested: "warn", approved: "ok", rejected: "bad",
  published: "ok", unlisted: "idle", suspended: "bad",
};
export const statusLabel = (s: string) => s.replace(/_/g, " ");
export const money = (cents: number, currency = "USD") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);
export const priceLabel = (p: { model: string; priceCents: number; currency: string } | null | undefined) =>
  !p ? "—" : p.model === "free" ? "Free" : money(p.priceCents, p.currency);
export const bytes = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
