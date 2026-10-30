import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("expo-push");

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const BATCH_SIZE = 100;

export interface ExpoMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  priority?: "default" | "high" | "normal";
  sound?: "default" | null;
  channelId?: string;
  badge?: number;
}

interface ExpoTicket {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
}

/**
 * Send push messages via the Expo Push API.
 * Batches into chunks of up to 100 per request (Expo limit).
 * Returns tokens Expo flagged as DeviceNotRegistered so the caller can mark them invalid.
 */
export async function sendExpoPushMessages(
  messages: ExpoMessage[],
): Promise<{ invalidTokens: string[] }> {
  if (messages.length === 0) return { invalidTokens: [] };

  const invalidTokens: string[] = [];

  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    const batch = messages.slice(i, i + BATCH_SIZE);

    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "Accept-Encoding": "gzip, deflate",
        },
        body: JSON.stringify(batch),
      });

      if (!res.ok) {
        log.warn("expo push HTTP error", { status: res.status, batchStart: i });
        continue;
      }

      const json = (await res.json()) as { data: ExpoTicket[] };
      const tickets: ExpoTicket[] = json?.data ?? [];

      tickets.forEach((ticket, idx) => {
        if (ticket.status === "error") {
          log.warn("expo push ticket error", {
            message: ticket.message,
            error: ticket.details?.error,
            tokenSuffix: batch[idx]?.to.slice(-10),
          });
          if (ticket.details?.error === "DeviceNotRegistered") {
            invalidTokens.push(batch[idx].to);
          }
        }
      });
    } catch (err) {
      log.warn("expo push send failed", { error: String(err), batchStart: i });
    }
  }

  return { invalidTokens };
}
