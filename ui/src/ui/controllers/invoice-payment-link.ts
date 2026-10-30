/**
 * The Whop payment link for one invoice.
 *
 * `agency.ops.invoice.paymentLink.create` / `.get` / `.detach` were served by
 * the gateway and advertised in `server-methods-list.ts`, but nothing in the UI
 * ever called them — so from the owner's chair "automated Whop payment link
 * creation" did not exist. This module is that missing hop.
 *
 * Three things shape it.
 *
 * **The link is read before it is offered.** `.get` is cheap and answers
 * `{ link: null }` for an invoice with none, so every invoice row can show its
 * true state (link / no link) instead of a button that might be a no-op. The
 * read is done once per invoice and cached in the module map.
 *
 * **A missing API key is a setup step, not a crash.** `.create` throws
 * "Whop API key not configured — …" when the credential is absent. That is the
 * single most likely failure on a fresh install, so it is surfaced verbatim as
 * a normal state with the fix in it, not as a red error the operator has to
 * decode.
 *
 * **Replacing a link is deliberate.** The gateway refuses a second `.create`
 * unless `regenerate: true`, because silently minting a new checkout would
 * leave the old URL live and taking money. The UI mirrors that: "Create" for a
 * fresh link, an explicit "Replace" for an existing one, and "Remove" for the
 * detach — which also retires the checkout at Whop.
 *
 * State lives in a module-level map for the same reason `invoice-pdf.ts` does:
 * `openInvoiceComposer` replaces `AgencyInvoicingState` wholesale, which would
 * drop an in-flight request's target on the floor.
 */

import type { GatewayBrowserClient } from "../gateway";
import {
  ensureAgencyOperationsState,
  type AgencyOperationsHost,
} from "./agency-operations";

/** Method names, newest first, so an older gateway still resolves. */
const METHODS = {
  create: ["agency.ops.invoice.paymentLink.create"],
  get: ["agency.ops.invoice.paymentLink.get"],
  detach: ["agency.ops.invoice.paymentLink.detach"],
} as const;

export type PaymentLinkCapability = keyof typeof METHODS;

/** The advertised name for a capability, or `null` when unserved. */
export function paymentLinkMethod(
  client: GatewayBrowserClient,
  capability: PaymentLinkCapability,
): string | null {
  const advertised = client.serverMethods;
  if (!advertised) return null;
  return METHODS[capability].find((name) => advertised.has(name)) ?? null;
}

/** True once the gateway serves link creation at all. */
export function supportsPaymentLinks(client: GatewayBrowserClient): boolean {
  return paymentLinkMethod(client, "create") !== null;
}

export interface PaymentLink {
  url: string;
  label: string | null;
  provider: string;
  externalId: string;
  amountCents: number;
  currency: string;
  createdAt?: number | null;
}

export type PaymentLinkPhase = "idle" | "loading" | "working" | "error";

export interface PaymentLinkState {
  phase: PaymentLinkPhase;
  /** The link on file, once `.get` has answered. `null` means none. */
  link: PaymentLink | null;
  /** True once `.get` has answered at least once for this invoice. */
  loaded: boolean;
  error: string | null;
  /**
   * Set when the failure is a missing/invalid Whop credential rather than a
   * fault — the surface renders it as a setup note, not an error.
   */
  needsCredentials: boolean;
  message: string | null;
}

const IDLE: PaymentLinkState = {
  phase: "idle",
  link: null,
  loaded: false,
  error: null,
  needsCredentials: false,
  message: null,
};

const links = new Map<string, PaymentLinkState>();

/** The link state for one invoice. Always defined. */
export function paymentLinkState(invoiceId: string | null | undefined): PaymentLinkState {
  if (!invoiceId) return IDLE;
  return links.get(invoiceId) ?? IDLE;
}

export function paymentLinkBusy(invoiceId: string | null | undefined): boolean {
  const phase = paymentLinkState(invoiceId).phase;
  return phase === "loading" || phase === "working";
}

function setState(
  host: AgencyOperationsHost,
  invoiceId: string,
  patch: Partial<PaymentLinkState>,
): void {
  const next = { ...(links.get(invoiceId) ?? IDLE), ...patch };
  links.set(invoiceId, next);
  host.requestUpdate?.();
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.trim() || "the gateway rejected the request without saying why";
}

/**
 * A missing key reads as configuration, not breakage. The gateway's own wording
 * already names the fix, so it is matched rather than reworded.
 */
function isCredentialProblem(message: string): boolean {
  return /api key not configured|whop.*(api key|credential)|company id/i.test(message);
}

function toLink(raw: unknown): PaymentLink | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const url = typeof record.url === "string" ? record.url : "";
  if (!url) return null;
  return {
    url,
    label: typeof record.label === "string" ? record.label : null,
    provider: typeof record.provider === "string" ? record.provider : "whop",
    externalId: typeof record.externalId === "string" ? record.externalId : "",
    amountCents: typeof record.amountCents === "number" ? record.amountCents : 0,
    currency: typeof record.currency === "string" ? record.currency : "USD",
    createdAt: typeof record.createdAt === "number" ? record.createdAt : null,
  };
}

function resolveAgencyId(
  host: AgencyOperationsHost,
  explicit: string | null | undefined,
): string | null {
  return explicit ?? ensureAgencyOperationsState(host).selectedAgencyId ?? null;
}

/**
 * Read the link bound to an invoice, once.
 *
 * Called from render, so it must be idempotent and must never re-enter: the
 * `loaded` flag and the busy check together mean a repainting list issues one
 * request per invoice, not one per frame.
 */
export function primeInvoicePaymentLink(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  invoiceId: string | null | undefined,
  agencyId?: string | null,
): void {
  if (!invoiceId) return;
  const current = paymentLinkState(invoiceId);
  if (current.loaded || current.phase === "loading") return;
  const method = paymentLinkMethod(client, "get");
  const agency = resolveAgencyId(host, agencyId);
  if (!method || !agency) {
    setState(host, invoiceId, { loaded: true });
    return;
  }
  setState(host, invoiceId, { phase: "loading", error: null });
  void (async () => {
    try {
      const response = (await client.request(method, { agencyId: agency, invoiceId })) as
        | Record<string, unknown>
        | undefined;
      setState(host, invoiceId, {
        phase: "idle",
        loaded: true,
        link: toLink(response?.link),
        error: null,
      });
    } catch (error) {
      // A failed read must not present as "no link" — that would offer a
      // Create button that then fails with "already has a payment link".
      setState(host, invoiceId, {
        phase: "error",
        loaded: true,
        error: errorText(error),
        needsCredentials: false,
      });
    }
  })();
}

export interface CreatePaymentLinkOptions {
  /** Replace an existing link. The gateway refuses a silent overwrite. */
  regenerate?: boolean;
  agencyId?: string | null;
}

/**
 * Mint a Whop checkout link for the invoice's outstanding balance.
 *
 * The amount is left to the gateway, which charges `balanceCents` — regenerating
 * after a part payment must not re-bill the paid portion.
 */
export async function createInvoicePaymentLink(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  invoice: { id: string; number: string },
  options: CreatePaymentLinkOptions = {},
): Promise<void> {
  const invoiceId = invoice.id;
  if (!invoiceId || paymentLinkBusy(invoiceId)) return;
  const method = paymentLinkMethod(client, "create");
  if (!method) {
    setState(host, invoiceId, {
      phase: "error",
      error: "This gateway build does not serve agency.ops.invoice.paymentLink.create.",
    });
    return;
  }
  const agencyId = resolveAgencyId(host, options.agencyId);
  if (!agencyId) {
    setState(host, invoiceId, {
      phase: "error",
      error: "No agency is selected, so a payment link cannot be created.",
    });
    return;
  }

  setState(host, invoiceId, {
    phase: "working",
    error: null,
    needsCredentials: false,
    message: options.regenerate
      ? "Replacing the checkout link at Whop…"
      : "Creating a checkout link at Whop…",
  });

  try {
    const response = (await client.request(method, {
      agencyId,
      invoiceId,
      regenerate: options.regenerate === true,
    })) as Record<string, unknown> | undefined;
    const link = toLink(response?.link);
    setState(host, invoiceId, {
      phase: "idle",
      loaded: true,
      link,
      error: link ? null : "Whop accepted the request but returned no checkout URL.",
      message: link
        ? response?.replaced === true
          ? "Replaced the payment link. The previous URL no longer takes payment."
          : "Payment link created. It is embedded in the invoice PDF from the next render."
        : null,
    });
  } catch (error) {
    const message = errorText(error);
    const credentials = isCredentialProblem(message);
    setState(host, invoiceId, {
      phase: "error",
      message: null,
      needsCredentials: credentials,
      error: message,
    });
  }
}

/**
 * Unbind the link and retire the checkout at Whop, so an old URL stops taking
 * money. A remote failure still detaches locally — the gateway does the same —
 * and is reported rather than swallowed.
 */
export async function detachInvoicePaymentLink(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  invoice: { id: string; number: string },
  agencyId?: string | null,
): Promise<void> {
  const invoiceId = invoice.id;
  if (!invoiceId || paymentLinkBusy(invoiceId)) return;
  const method = paymentLinkMethod(client, "detach");
  const agency = resolveAgencyId(host, agencyId);
  if (!method || !agency) return;

  setState(host, invoiceId, {
    phase: "working",
    error: null,
    message: "Removing the payment link…",
  });
  try {
    const response = (await client.request(method, { agencyId: agency, invoiceId })) as
      | Record<string, unknown>
      | undefined;
    const remoteError =
      typeof response?.remoteError === "string" ? response.remoteError : null;
    setState(host, invoiceId, {
      phase: "idle",
      loaded: true,
      link: null,
      error: null,
      message: remoteError
        ? `Link removed here, but Whop reported: ${remoteError}. Retire the checkout in Whop as well.`
        : "Payment link removed. The old URL no longer takes payment.",
    });
  } catch (error) {
    setState(host, invoiceId, { phase: "error", message: null, error: errorText(error) });
  }
}

/** Drop cached link state. Used by tests and by a hard agency switch. */
export function resetInvoicePaymentLinks(): void {
  links.clear();
}
