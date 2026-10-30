import { createSubsystemLogger } from "../logging/subsystem.js";

/**
 * Dedicated, always-on connection tracer for the WhatsApp (Baileys) transport.
 *
 * The point of this module is diagnosability: when a scan "won't connect" we
 * need to see EXACTLY where the state machine stalls — which connection.update
 * fired, with what status code, whether it was a fresh login, when creds were
 * persisted, and when the live message listener actually came online.
 *
 * All output is prefixed with `[wa]` so it is trivially greppable in the
 * gateway logs. Secrets (QR payloads, creds) are never logged — only their
 * presence/length.
 */
const waLog = createSubsystemLogger("gateway/channels/whatsapp").child("conn");

type ConnectionUpdateLike = {
  connection?: string;
  isNewLogin?: boolean;
  qr?: string;
  lastDisconnect?: { error?: unknown } | null;
};

function statusCodeOf(err: unknown): number | undefined {
  return (
    (err as { output?: { statusCode?: number } })?.output?.statusCode ??
    (err as { status?: number })?.status
  );
}

/** Short, secret-free tag identifying which socket produced a line. */
export function waConnTag(scope: string, connectionId?: string): string {
  const short = connectionId ? connectionId.slice(0, 8) : undefined;
  return short ? `${scope}#${short}` : scope;
}

/** Log a Baileys connection.update, masking the QR payload. */
export function logWaConnectionUpdate(tag: string, update: ConnectionUpdateLike): void {
  const status = statusCodeOf(update.lastDisconnect?.error);
  const meta: Record<string, unknown> = { tag };
  if (update.connection) meta.connection = update.connection;
  if (typeof update.isNewLogin === "boolean") meta.isNewLogin = update.isNewLogin;
  if (typeof status === "number") meta.statusCode = status;
  if (update.qr) meta.qr = "present"; // never log the payload itself
  waLog.info(`[wa] connection.update ${describe(meta)}`, meta);
}

/** Log a creds.update event (never logs the creds themselves). */
export function logWaCredsUpdate(tag: string): void {
  waLog.info(`[wa] creds.update saved (${tag})`, { tag });
}

/** Log lifecycle milestones for the live listener / login socket. */
export function logWaEvent(tag: string, message: string, meta?: Record<string, unknown>): void {
  waLog.info(`[wa] ${message} (${tag})`, { tag, ...meta });
}

/** Log an error/close with its status code. */
export function logWaClose(tag: string, err: unknown, extra?: Record<string, unknown>): void {
  const status = statusCodeOf(err);
  waLog.warn(`[wa] connection closed status=${status ?? "unknown"} (${tag})`, {
    tag,
    statusCode: status,
    ...extra,
  });
}

function describe(meta: Record<string, unknown>): string {
  return Object.entries(meta)
    .filter(([k]) => k !== "tag")
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(" ");
}
