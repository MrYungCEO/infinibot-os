import type { GatewayBrowserClient } from "../gateway";
import type { ChannelsStatusSnapshot } from "../types";

export type ChannelsState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  channelsLoading: boolean;
  channelsSnapshot: ChannelsStatusSnapshot | null;
  channelsError: string | null;
  channelsLastSuccess: number | null;
  whatsappLoginMessage: string | null;
  whatsappLoginQrDataUrl: string | null;
  whatsappLoginConnected: boolean | null;
  whatsappBusy: boolean;
  // ── Pairing-code (phone-number) linking — the reliable path ──
  /** Which link method the user has selected. Pairing is the default. */
  whatsappLoginMode: "pairing" | "qr";
  /** The phone number the user typed (E.164-ish; normalized server-side). */
  whatsappPhoneNumber: string;
  /** The 8-digit code to type into WhatsApp → Link with phone number. */
  whatsappPairingCode: string | null;
};
