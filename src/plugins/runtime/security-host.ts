/**
 * Security seams for first-party plugins that move money or hold secrets
 * (Solatrix). Plugins run in their own jiti module instances, so they must use
 * core's single approval registry, KEK and SaaS identity through
 * `api.runtime.host`, never through their own imports.
 *
 * Nothing here hands a plugin the KEK itself; it gets wrap/unwrap only.
 */

import {
  createApprovalRequest,
  getApprovalRequest,
  listApprovalRequests,
  onApprovalEvent,
  resolveApprovalRequest,
  type ApprovalEvent,
  type ApprovalRecord,
  type CreateApprovalRequestInput,
} from "../../autonomy/approval-registry.js";
import { isSaasMode } from "../../saas/config.js";
import { gatewayLinkPair } from "../../notifications/public-base.js";
import {
  tenantKekConfigured,
  unwrapTenantDataKey,
  wrapTenantDataKey,
  type WrappedDataKey,
} from "../../security/tenant-kek.js";

export type HostApprovals = {
  create(input: Omit<CreateApprovalRequestInput, "onResolve">): ApprovalRecord;
  get(id: string): ApprovalRecord | null;
  list(filter?: { status?: ApprovalRecord["status"] | "all" }): ApprovalRecord[];
  /** Cancel (deny) a pending request the plugin itself created. */
  cancel(id: string, reason: string): void;
  onEvent(listener: (event: ApprovalEvent) => void): () => void;
};

export type HostKek = {
  configured(): boolean;
  wrap(dataKey: Uint8Array, tenantId: string, purpose: string): WrappedDataKey;
  unwrap(wrapped: WrappedDataKey, tenantId: string, purpose: string): Buffer;
};

export type StepUpResult = { ok: true; email?: string } | { ok: false; reason: string };

export type HostSaas = {
  /** SAAS_MODE=1 (hosted InfiniBot Cloud tenant Machine). */
  isSaasMode(): boolean;
  /**
   * The tenant this process serves. Only a dedicated per-tenant Machine
   * (FLEET_TENANT_ID) has one; a shared multi-tenant process returns null.
   */
  dedicatedTenantId(): string | null;
  /** Plan of the dedicated tenant (FLEET_TENANT_PLAN), if the orchestrator set it. */
  dedicatedTenantPlan(): string | null;
  /**
   * Verify a Clerk step-up: a fresh session token for `expectedEmail` whose
   * first factor was verified within `maxFactorAgeMin` minutes (Clerk `fva`).
   */
  verifyStepUp(
    token: string,
    opts: { expectedEmail?: string; maxFactorAgeMin: number },
  ): Promise<StepUpResult>;
};

export type HostAlert = (alert: {
  title: string;
  body: string;
  severity?: "warning" | "critical";
  /**
   * Where the alert should open: a deep link (`infinibot://…`) or a web path
   * (`/solatrix/alerts`). Becomes the notification's deepLink and, when the
   * gateway has a public base URL, an "Open" link in the Telegram message.
   */
  link?: string;
}) => Promise<void>;

/** Deep link + web opener URL for plugins (null webUrl without a public base). */
export type HostLinkPair = (targetOrLink: string) => { deepLink: string; webUrl: string | null };

export const hostLinkPair: HostLinkPair = (targetOrLink) => gatewayLinkPair(targetOrLink);

export const hostApprovals: HostApprovals = {
  create: (input) => createApprovalRequest(input),
  get: (id) => getApprovalRequest(id),
  list: (filter) => listApprovalRequests(filter),
  cancel: (id, reason) => {
    resolveApprovalRequest(id, {
      action: "deny",
      via: "system",
      by: "system",
      reason,
      actor: { kind: "system" },
    });
  },
  onEvent: (listener) => onApprovalEvent(listener),
};

export const hostKek: HostKek = {
  configured: () => tenantKekConfigured(),
  wrap: (key, tenantId, purpose) => wrapTenantDataKey(key, tenantId, purpose),
  unwrap: (wrapped, tenantId, purpose) => unwrapTenantDataKey(wrapped, tenantId, purpose),
};

export const hostSaas: HostSaas = {
  isSaasMode: () => isSaasMode(),
  dedicatedTenantId: () => process.env.FLEET_TENANT_ID?.trim() || null,
  dedicatedTenantPlan: () => process.env.FLEET_TENANT_PLAN?.trim() || null,
  async verifyStepUp(token, opts) {
    if (!token) return { ok: false, reason: "re-authentication required" };
    const { verifyClerkToken } = await import("../../saas/clerk.js");
    const identity = await verifyClerkToken(token);
    if (!identity) return { ok: false, reason: "re-authentication failed" };
    if (
      opts.expectedEmail &&
      identity.email &&
      identity.email !== opts.expectedEmail.toLowerCase()
    ) {
      return { ok: false, reason: "re-authentication belongs to a different account" };
    }
    // Clerk `fva` = [minutes since first factor, minutes since second factor]
    // (-1 = never). Its absence means reverification isn't available.
    const fva = (identity.claims as Record<string, unknown>).fva;
    const first = Array.isArray(fva) ? Number(fva[0]) : Number.NaN;
    if (!Number.isFinite(first) || first < 0) {
      return {
        ok: false,
        reason: "this sign-in can't prove a recent re-authentication (Clerk fva claim missing)",
      };
    }
    if (first > opts.maxFactorAgeMin) {
      return { ok: false, reason: `re-authenticate: your last sign-in was ${first} minutes ago` };
    }
    return { ok: true, email: identity.email };
  },
};

/**
 * Owner alert: in-app notification plus, when Telegram approvals are set up, a
 * direct Telegram message to the operator chat. Best-effort and never throws.
 */
export const hostAlertOwner: HostAlert = async ({ title, body, severity = "critical", link }) => {
  let pair: { deepLink: string; webUrl: string | null } | null = null;
  if (link) {
    try {
      pair = gatewayLinkPair(link);
    } catch {
      pair = null;
    }
  }
  try {
    const { emitNotification } = await import("../../notifications/emit.js");
    await emitNotification({
      category: "manual",
      severity: severity === "critical" ? "critical" : "warn",
      title,
      body,
      source: "plugin",
      deepLink: pair?.deepLink ?? null,
      webUrl: pair?.webUrl ?? null,
    });
  } catch {
    /* notifications are best-effort */
  }
  try {
    const [{ loadConfig }, tg, fmt] = await Promise.all([
      import("../../config/config.js"),
      import("../../approvals/telegram-approvals.js"),
      import("../../approvals/telegram-format.js"),
    ]);
    const conf = tg.resolveTelegramApprovalsConfig(loadConfig());
    if (!conf.enabled || !conf.chatId) return;
    const transport = tg.createDefaultApprovalTransport(conf.accountId);
    const open = fmt.openLinkParts(pair?.webUrl);
    await transport.send(
      conf.chatId,
      `🚨 <b>${fmt.escapeHtml(title)}</b>\n${fmt.escapeClipped(body, 1500)}${open.line ? `\n${open.line}` : ""}`,
      open.row ? { keyboard: [open.row] } : undefined,
    );
  } catch {
    /* Telegram is best-effort (channels may be skipped) */
  }
};
