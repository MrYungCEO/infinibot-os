/**
 * Whop credentials, entered where they are needed.
 *
 * Setting a payment key used to mean: leave the invoice you are looking at, find
 * the Business page, scroll to Income Sources, expand Whop, save — and then it
 * still would not work, because `business.*` is proxied to master on a satellite
 * while payment links are minted from the LOCAL store. The key went to one node
 * and the spender read another.
 *
 * So this controller talks to `agency.ops.payments.provider.*`, which is not
 * proxied and therefore reads and writes the store this node actually spends
 * from. Any surface that can show an invoice can now also fix the credential
 * that blocks it.
 *
 * The key is never held in module state beyond the in-flight save, and the
 * status returned by the gateway is masked (`••••1234`) — the raw key is
 * write-only from the UI's point of view.
 */

import type { GatewayBrowserClient } from "../gateway";
import {
  ensureAgencyOperationsState,
  type AgencyOperationsHost,
} from "./agency-operations";

const GET_METHOD = "agency.ops.payments.provider.get";
const SET_METHOD = "agency.ops.payments.provider.set";

/** True when this gateway serves the local credential RPCs. */
export function supportsPaymentCredentials(client: GatewayBrowserClient): boolean {
  const advertised = client.serverMethods;
  return advertised ? advertised.has(SET_METHOD) : false;
}

export interface PaymentProviderStatus {
  configured: boolean;
  /** `••••1234` — never the key itself. */
  hint: string | null;
  /** True when the effective key comes from WHOP_API_KEY, not the store. */
  fromEnv: boolean;
  companyId: string | null;
}

export interface PaymentCredentialsState {
  /** The editor is only rendered when this is true. */
  open: boolean;
  /**
   * Which invoice row opened the editor.
   *
   * The credential is per-node, so the state is shared — but every invoice row
   * renders the same editor component, and without this the editor would appear
   * under all of them at once. Only the row whose id matches draws it.
   */
  openFor: string | null;
  loading: boolean;
  saving: boolean;
  loaded: boolean;
  status: PaymentProviderStatus | null;
  error: string | null;
  message: string | null;
  /** Draft field values. The key draft is cleared the moment it is saved. */
  keyDraft: string;
  companyDraft: string;
}

const IDLE: PaymentCredentialsState = {
  open: false,
  openFor: null,
  loading: false,
  saving: false,
  loaded: false,
  status: null,
  error: null,
  message: null,
  keyDraft: "",
  companyDraft: "",
};

/**
 * Single shared editor state.
 *
 * Deliberately not per-invoice: the credential is per-node, so opening it from
 * two different invoices must show — and edit — the same thing.
 */
let state: PaymentCredentialsState = { ...IDLE };

export function paymentCredentialsState(): PaymentCredentialsState {
  return state;
}

function patch(host: AgencyOperationsHost, next: Partial<PaymentCredentialsState>): void {
  state = { ...state, ...next };
  host.requestUpdate?.();
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.trim() || "the gateway rejected the request without saying why";
}

function toStatus(raw: unknown): PaymentProviderStatus | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const whop = (record.whop ?? {}) as Record<string, unknown>;
  return {
    configured: whop.configured === true,
    hint: typeof whop.hint === "string" ? whop.hint : null,
    fromEnv: whop.fromEnv === true,
    companyId: typeof record.whopCompanyId === "string" ? record.whopCompanyId : null,
  };
}

function agencyId(host: AgencyOperationsHost, explicit?: string | null): string | null {
  return explicit ?? ensureAgencyOperationsState(host).selectedAgencyId ?? null;
}

/** Read the current masked status. Safe to call repeatedly. */
export function loadPaymentCredentials(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  explicitAgencyId?: string | null,
): void {
  if (state.loading) return;
  const id = agencyId(host, explicitAgencyId);
  if (!id || !supportsPaymentCredentials(client)) {
    patch(host, { loaded: true });
    return;
  }
  patch(host, { loading: true, error: null });
  void (async () => {
    try {
      const response = await client.request(GET_METHOD, { agencyId: id });
      const status = toStatus(response);
      patch(host, {
        loading: false,
        loaded: true,
        status,
        // Prefill the company id so adding a missing one is a one-field edit.
        companyDraft: state.companyDraft || (status?.companyId ?? ""),
      });
    } catch (error) {
      patch(host, { loading: false, loaded: true, error: errorText(error) });
    }
  })();
}

/** Open the editor, loading current status if it has not been read yet. */
export function openPaymentCredentials(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  explicitAgencyId?: string | null,
  openFor?: string | null,
): void {
  patch(host, { open: true, openFor: openFor ?? null, message: null, error: null });
  if (!state.loaded) loadPaymentCredentials(host, client, explicitAgencyId);
}

/**
 * True once the status has been read and both halves of the credential are on
 * file — the surface uses this to stop advertising a setup step that is done.
 */
export function paymentCredentialsComplete(): boolean {
  return Boolean(state.loaded && state.status?.configured && state.status?.companyId);
}

/**
 * Read the status once so surfaces can decide whether to show a setup
 * affordance at all. Safe to call from render.
 */
export function primePaymentCredentials(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  explicitAgencyId?: string | null,
): void {
  if (state.loaded || state.loading) return;
  loadPaymentCredentials(host, client, explicitAgencyId);
}

export function closePaymentCredentials(host: AgencyOperationsHost): void {
  patch(host, { open: false, openFor: null, keyDraft: "", message: null, error: null });
}

export function setPaymentCredentialDraft(
  host: AgencyOperationsHost,
  field: "keyDraft" | "companyDraft",
  value: string,
): void {
  patch(host, { [field]: value } as Partial<PaymentCredentialsState>);
}

/**
 * Save whatever the operator filled in.
 *
 * Blank fields are omitted rather than sent as empty strings, so saving only a
 * company id cannot silently wipe a key that is already on file.
 */
export async function savePaymentCredentials(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  explicitAgencyId?: string | null,
): Promise<boolean> {
  if (state.saving) return false;
  const id = agencyId(host, explicitAgencyId);
  if (!id) {
    patch(host, { error: "No agency is selected, so credentials cannot be saved." });
    return false;
  }
  const key = state.keyDraft.trim();
  const company = state.companyDraft.trim();
  if (!key && !company) {
    patch(host, { error: "Enter a Whop API key or a company id first." });
    return false;
  }
  patch(host, { saving: true, error: null, message: null });
  try {
    const params: Record<string, unknown> = { agencyId: id };
    if (key) params.whop = key;
    if (company) params.whopCompanyId = company;
    const response = await client.request(SET_METHOD, params);
    const status = toStatus(response);
    const ready = Boolean(status?.configured && status?.companyId);
    patch(host, {
      saving: false,
      loaded: true,
      status,
      // Never keep raw key material around after the write.
      keyDraft: "",
      companyDraft: status?.companyId ?? company,
      message: ready
        ? "Saved. Payment links can be created now."
        : status?.configured
          ? "Key saved — a Whop company id is still required before links can be created."
          : "Company id saved — a Whop API key is still required before links can be created.",
    });
    return ready;
  } catch (error) {
    patch(host, { saving: false, error: errorText(error) });
    return false;
  }
}

/** Drop all editor state. Used by tests and on agency switch. */
export function resetPaymentCredentials(): void {
  state = { ...IDLE };
}
