/**
 * Channel adapter registry.
 *
 * getAdapter(channel) returns the transport for a channel. Telegram is live;
 * the rest are honest stubs (configured:false) until their T-task lands.
 */

import { type ChannelAdapter, type CommsChannel, COMMS_CHANNELS } from "../types.js";
import { telegramAdapter } from "./telegram.js";
import { discordAdapter, emailAdapter, instagramAdapter, whatsappAdapter } from "./stub.js";

const ADAPTERS: Record<CommsChannel, ChannelAdapter> = {
  telegram: telegramAdapter,
  email: emailAdapter,
  whatsapp: whatsappAdapter,
  discord: discordAdapter,
  instagram: instagramAdapter,
};

export function getAdapter(channel: CommsChannel): ChannelAdapter {
  return ADAPTERS[channel];
}

export function listAdapters(): ChannelAdapter[] {
  return COMMS_CHANNELS.map((c) => ADAPTERS[c]);
}
