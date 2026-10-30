/**
 * Stub channel adapter factory.
 *
 * A stub reports its status TRUTHFULLY (`configured: false` + setup notes) so the
 * UI shows "Setup required" instead of silently swallowing messages, and throws a
 * clear error from send(). Each stub documents the concrete integration path in
 * its setupNotes. Replace with a real adapter per the T-tasks in
 * docs/features/comms-hub.md.
 */

import {
  type AdapterStatus,
  type ChannelAdapter,
  type CommsChannel,
  type OutboundSend,
  type SendResult,
} from "../types.js";

export function createStubAdapter(channel: CommsChannel, setupNotes: string): ChannelAdapter {
  return {
    channel,
    async status(): Promise<AdapterStatus> {
      return { channel, configured: false, enabled: false, accountId: null, setupNotes };
    },
    async send(_req: OutboundSend): Promise<SendResult> {
      throw new Error(`${channel} channel is not configured. ${setupNotes}`);
    },
    normalizeInbound() {
      return null;
    },
  };
}

export const emailAdapter = createStubAdapter(
  "email",
  "Wire to the existing email/gmail handlers (channels.email or Gmail OAuth). Implement send() over Nodemailer/Gmail API and normalizeInbound() from the IMAP/Gmail push payload. See task T-2.",
);

export const whatsappAdapter = createStubAdapter(
  "whatsapp",
  "Add channels.whatsapp config (phoneNumberId, accessToken, verifyToken) for the WhatsApp Cloud API. Add a webhook receiver that calls comms.ingest. See task T-3.",
);

export const discordAdapter = createStubAdapter(
  "discord",
  "Add channels.discord config (botToken) and a discord.js client with DM + message-content intents. Route inbound DMs/mentions to comms.ingest. See task T-4.",
);

export const instagramAdapter = createStubAdapter(
  "instagram",
  "Wire to the existing instagram/manychat handlers (IG Graph API DM webhook). Implement send() and route inbound DMs to comms.ingest. See task T-5.",
);
