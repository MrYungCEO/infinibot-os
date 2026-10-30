import { randomUUID } from "node:crypto";

import { DisconnectReason } from "@whiskeysockets/baileys";
import { loadConfig } from "../config/config.js";
import { danger, info, success } from "../globals.js";
import { logInfo } from "../logger.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { resolveWhatsAppAccount } from "./accounts.js";
import { renderQrPngBase64 } from "./qr-image.js";
import {
  createWaSocket,
  formatError,
  getStatusCode,
  logoutWeb,
  readWebSelfId,
  waitForWaConnection,
  webAuthExists,
} from "./session.js";

type WaSocket = Awaited<ReturnType<typeof createWaSocket>>;

type LoginMode = "qr" | "pairing";

type ActiveLogin = {
  accountId: string;
  authDir: string;
  isLegacyAuthDir: boolean;
  id: string;
  sock: WaSocket;
  startedAt: number;
  mode: LoginMode;
  qr?: string;
  qrDataUrl?: string;
  /** Pairing-code mode: the 8-digit code the user types into WhatsApp. */
  pairingCode?: string;
  /** Pairing-code mode: the E.164 (digits-only) phone number being linked. */
  pairingPhoneNumber?: string;
  connected: boolean;
  error?: string;
  errorStatus?: number;
  waitPromise: Promise<void>;
  /** How many times we've re-minted the socket to survive a transient reconnect. */
  restartCount: number;
  verbose: boolean;
};

const ACTIVE_LOGIN_TTL_MS = 3 * 60_000;
const activeLogins = new Map<string, ActiveLogin>();

// Transient close codes that mean "reconnect, don't tear down the login".
// 515 restartRequired (normal after first pairing), 440 connectionReplaced,
// 428 connectionClosed, 408 timedOut/connectionLost, 503 unavailableService.
const RETRYABLE_LOGIN_STATUSES = new Set([515, 440, 428, 408, 503]);
const MAX_LOGIN_RESTARTS = 6;

function closeSocket(sock: WaSocket) {
  try {
    sock.ws?.close();
  } catch {
    // ignore
  }
}

/** True once WhatsApp has registered the device (i.e. pairing/QR completed). */
function isSockRegistered(sock: WaSocket): boolean {
  return Boolean(
    (sock as unknown as { authState?: { creds?: { registered?: boolean } } }).authState?.creds
      ?.registered,
  );
}

async function resetActiveLogin(accountId: string, reason?: string) {
  const login = activeLogins.get(accountId);
  if (login) {
    closeSocket(login.sock);
    activeLogins.delete(accountId);
  }
  if (reason) {
    logInfo(reason);
  }
}

function isLoginFresh(login: ActiveLogin) {
  return Date.now() - login.startedAt < ACTIVE_LOGIN_TTL_MS;
}

function attachLoginWaiter(accountId: string, login: ActiveLogin) {
  login.waitPromise = waitForWaConnection(login.sock)
    .then(() => {
      const current = activeLogins.get(accountId);
      if (current?.id === login.id) current.connected = true;
    })
    .catch((err) => {
      const current = activeLogins.get(accountId);
      if (current?.id !== login.id) return;
      current.error = formatError(err);
      current.errorStatus = getStatusCode(err);
    });
}

/**
 * Re-mint the login socket to survive a transient reconnect (515/440/428/…)
 * WITHOUT tearing down the active login. Bounded by MAX_LOGIN_RESTARTS so a
 * flapping connection eventually surfaces a real error instead of looping.
 *
 * After the FIRST successful pair, creds are registered on disk, so the fresh
 * socket resumes the session (no QR / no new pairing code needed) — we always
 * re-create in plain resume mode here.
 */
async function restartLoginSocket(login: ActiveLogin, runtime: RuntimeEnv, status?: number) {
  if (login.restartCount >= MAX_LOGIN_RESTARTS) return false;
  login.restartCount += 1;
  runtime.log(
    info(
      `[wa] login reconnect (status ${status ?? "?"}); re-establishing connection ` +
        `(${login.restartCount}/${MAX_LOGIN_RESTARTS})…`,
    ),
  );
  closeSocket(login.sock);
  try {
    const sock = await createWaSocket(false, login.verbose, {
      authDir: login.authDir,
    });
    login.sock = sock;
    login.connected = false;
    login.error = undefined;
    login.errorStatus = undefined;
    attachLoginWaiter(login.accountId, login);
    return true;
  } catch (err) {
    login.error = formatError(err);
    login.errorStatus = getStatusCode(err);
    return false;
  }
}

export async function startWebLoginWithQr(
  opts: {
    verbose?: boolean;
    timeoutMs?: number;
    force?: boolean;
    accountId?: string;
    runtime?: RuntimeEnv;
  } = {},
): Promise<{ qrDataUrl?: string; message: string }> {
  const runtime = opts.runtime ?? defaultRuntime;
  const cfg = loadConfig();
  const account = resolveWhatsAppAccount({ cfg, accountId: opts.accountId });
  const hasWeb = await webAuthExists(account.authDir);
  const selfId = readWebSelfId(account.authDir);
  if (hasWeb && !opts.force) {
    const who = selfId.e164 ?? selfId.jid ?? "unknown";
    return {
      message: `WhatsApp is already linked (${who}). Say “relink” if you want a fresh QR.`,
    };
  }

  // Relink (force) MUST start from a clean slate. If we keep the old creds,
  // Baileys tries to RESUME the (now-dead) session instead of emitting a fresh
  // QR — so no QR appears and the relink silently never connects. Wipe the
  // on-disk session first so a brand-new QR + session are minted.
  if (opts.force && hasWeb) {
    await resetActiveLogin(account.accountId);
    try {
      await logoutWeb({
        authDir: account.authDir,
        isLegacyAuthDir: account.isLegacyAuthDir,
        runtime,
      });
      runtime.log(info("Cleared previous WhatsApp session for relink; generating a fresh QR."));
    } catch (err) {
      runtime.log(danger(`Failed clearing WhatsApp session before relink: ${formatError(err)}`));
    }
  }

  const existing = activeLogins.get(account.accountId);
  if (existing && isLoginFresh(existing) && existing.qrDataUrl) {
    return {
      qrDataUrl: existing.qrDataUrl,
      message: "QR already active. Scan it in WhatsApp → Linked Devices.",
    };
  }

  await resetActiveLogin(account.accountId);

  let resolveQr: ((qr: string) => void) | null = null;
  let rejectQr: ((err: Error) => void) | null = null;
  const qrPromise = new Promise<string>((resolve, reject) => {
    resolveQr = resolve;
    rejectQr = reject;
  });

  const qrTimer = setTimeout(
    () => {
      rejectQr?.(new Error("Timed out waiting for WhatsApp QR"));
    },
    Math.max(opts.timeoutMs ?? 30_000, 5000),
  );

  let sock: WaSocket;
  let pendingQr: string | null = null;
  try {
    sock = await createWaSocket(false, Boolean(opts.verbose), {
      authDir: account.authDir,
      onQr: (qr: string) => {
        if (pendingQr) return;
        pendingQr = qr;
        const current = activeLogins.get(account.accountId);
        if (current && !current.qr) current.qr = qr;
        clearTimeout(qrTimer);
        runtime.log(info("WhatsApp QR received."));
        resolveQr?.(qr);
      },
    });
  } catch (err) {
    clearTimeout(qrTimer);
    await resetActiveLogin(account.accountId);
    return {
      message: `Failed to start WhatsApp login: ${String(err)}`,
    };
  }
  const login: ActiveLogin = {
    accountId: account.accountId,
    authDir: account.authDir,
    isLegacyAuthDir: account.isLegacyAuthDir,
    id: randomUUID(),
    sock,
    startedAt: Date.now(),
    mode: "qr",
    connected: false,
    waitPromise: Promise.resolve(),
    restartCount: 0,
    verbose: Boolean(opts.verbose),
  };
  activeLogins.set(account.accountId, login);
  if (pendingQr && !login.qr) login.qr = pendingQr;
  attachLoginWaiter(account.accountId, login);

  let qr: string;
  try {
    qr = await qrPromise;
  } catch (err) {
    clearTimeout(qrTimer);
    await resetActiveLogin(account.accountId);
    return {
      message: `Failed to get QR: ${String(err)}`,
    };
  }

  const base64 = await renderQrPngBase64(qr);
  login.qrDataUrl = `data:image/png;base64,${base64}`;
  return {
    qrDataUrl: login.qrDataUrl,
    message: "Scan this QR in WhatsApp → Linked Devices.",
  };
}

function normalizePhoneNumber(raw: string): string {
  // Baileys wants the number in international format, digits only (no +, spaces,
  // dashes, or parentheses). e.g. "+1 (555) 123-4567" → "15551234567".
  return String(raw ?? "").replace(/[^0-9]/g, "");
}

/**
 * Start a WhatsApp link using the PAIRING CODE (phone-number) method — the more
 * reliable path than QR (no camera, no ~20s QR churn). The user enters their
 * phone number, we ask WhatsApp for an 8-digit code, they type it into
 * WhatsApp → Linked devices → "Link with phone number instead". The connection
 * then completes through the SAME activeLogins lifecycle + reconnect hardening
 * as the QR path, so `waitForWebLogin` works unchanged for both.
 */
export async function startWebLoginWithPairingCode(opts: {
  phoneNumber: string;
  verbose?: boolean;
  timeoutMs?: number;
  force?: boolean;
  accountId?: string;
  runtime?: RuntimeEnv;
}): Promise<{ pairingCode?: string; message: string }> {
  const runtime = opts.runtime ?? defaultRuntime;
  const cfg = loadConfig();
  const account = resolveWhatsAppAccount({ cfg, accountId: opts.accountId });
  const phoneNumber = normalizePhoneNumber(opts.phoneNumber);
  if (phoneNumber.length < 8) {
    return {
      message:
        "Enter your full phone number in international format (country code + number, digits only).",
    };
  }

  const hasWeb = await webAuthExists(account.authDir);
  const selfId = readWebSelfId(account.authDir);
  if (hasWeb && !opts.force) {
    const who = selfId.e164 ?? selfId.jid ?? "unknown";
    return {
      message: `WhatsApp is already linked (${who}). Say “relink” if you want a fresh link.`,
    };
  }

  // Relink (force) MUST start from a clean slate — otherwise Baileys tries to
  // resume the dead session and never mints a fresh pairing code. Same rule as
  // the QR path.
  if (opts.force && hasWeb) {
    await resetActiveLogin(account.accountId);
    try {
      await logoutWeb({
        authDir: account.authDir,
        isLegacyAuthDir: account.isLegacyAuthDir,
        runtime,
      });
      runtime.log(
        info("[wa] Cleared previous WhatsApp session for relink; requesting a fresh pairing code."),
      );
    } catch (err) {
      runtime.log(
        danger(`[wa] Failed clearing WhatsApp session before relink: ${formatError(err)}`),
      );
    }
  }

  const existing = activeLogins.get(account.accountId);
  if (
    existing &&
    isLoginFresh(existing) &&
    existing.mode === "pairing" &&
    existing.pairingCode &&
    existing.pairingPhoneNumber === phoneNumber
  ) {
    return {
      pairingCode: existing.pairingCode,
      message:
        "Pairing code active. Enter it in WhatsApp → Linked devices → Link with phone number.",
    };
  }

  await resetActiveLogin(account.accountId);

  let resolveCode: ((code: string) => void) | null = null;
  let rejectCode: ((err: Error) => void) | null = null;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const codeTimer = setTimeout(
    () => {
      rejectCode?.(new Error("Timed out waiting for WhatsApp pairing code"));
    },
    Math.max(opts.timeoutMs ?? 30_000, 5000),
  );

  let sock: WaSocket;
  let pendingCode: string | null = null;
  try {
    runtime.log(info(`[wa] Requesting pairing code for +${phoneNumber}…`));
    sock = await createWaSocket(false, Boolean(opts.verbose), {
      authDir: account.authDir,
      pairing: {
        phoneNumber,
        onCode: (code: string) => {
          if (pendingCode) return;
          pendingCode = code;
          const current = activeLogins.get(account.accountId);
          if (current && !current.pairingCode) current.pairingCode = code;
          clearTimeout(codeTimer);
          runtime.log(success(`[wa] Pairing code ready: ${code}`));
          resolveCode?.(code);
        },
        onError: (err: unknown) => {
          clearTimeout(codeTimer);
          rejectCode?.(err instanceof Error ? err : new Error(formatError(err)));
        },
      },
    });
  } catch (err) {
    clearTimeout(codeTimer);
    await resetActiveLogin(account.accountId);
    return { message: `[wa] Failed to start WhatsApp pairing: ${formatError(err)}` };
  }

  const login: ActiveLogin = {
    accountId: account.accountId,
    authDir: account.authDir,
    isLegacyAuthDir: account.isLegacyAuthDir,
    id: randomUUID(),
    sock,
    startedAt: Date.now(),
    mode: "pairing",
    pairingPhoneNumber: phoneNumber,
    connected: false,
    waitPromise: Promise.resolve(),
    restartCount: 0,
    verbose: Boolean(opts.verbose),
  };
  activeLogins.set(account.accountId, login);
  if (pendingCode && !login.pairingCode) login.pairingCode = pendingCode;
  attachLoginWaiter(account.accountId, login);

  let code: string;
  try {
    code = await codePromise;
  } catch (err) {
    clearTimeout(codeTimer);
    await resetActiveLogin(account.accountId);
    return { message: `[wa] Failed to get pairing code: ${formatError(err)}` };
  }

  login.pairingCode = code;
  return {
    pairingCode: code,
    message:
      "On your phone: WhatsApp → Settings → Linked devices → Link a device → " +
      "Link with phone number instead — then enter this code.",
  };
}

export async function waitForWebLogin(
  opts: { timeoutMs?: number; runtime?: RuntimeEnv; accountId?: string } = {},
): Promise<{ connected: boolean; message: string }> {
  const runtime = opts.runtime ?? defaultRuntime;
  const cfg = loadConfig();
  const account = resolveWhatsAppAccount({ cfg, accountId: opts.accountId });
  const activeLogin = activeLogins.get(account.accountId);
  if (!activeLogin) {
    return {
      connected: false,
      message: "No active WhatsApp login in progress.",
    };
  }

  const login = activeLogin;
  if (!isLoginFresh(login)) {
    await resetActiveLogin(account.accountId);
    return {
      connected: false,
      message: "The login QR expired. Ask me to generate a new one.",
    };
  }
  const timeoutMs = Math.max(opts.timeoutMs ?? 120_000, 1000);
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return {
        connected: false,
        message: "Still waiting for the QR scan. Let me know when you’ve scanned it.",
      };
    }
    const timeout = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), remaining),
    );
    const result = await Promise.race([login.waitPromise.then(() => "done"), timeout]);

    if (result === "timeout") {
      return {
        connected: false,
        message: "Still waiting for the QR scan. Let me know when you’ve scanned it.",
      };
    }

    if (login.error) {
      if (login.errorStatus === DisconnectReason.loggedOut) {
        await logoutWeb({
          authDir: login.authDir,
          isLegacyAuthDir: login.isLegacyAuthDir,
          runtime,
        });
        const message =
          "WhatsApp reported the session is logged out. Cleared cached web session; please scan a new QR.";
        await resetActiveLogin(account.accountId, message);
        runtime.log(danger(message));
        return { connected: false, message };
      }
      if (
        typeof login.errorStatus === "number" &&
        RETRYABLE_LOGIN_STATUSES.has(login.errorStatus)
      ) {
        // A pairing-code session that drops BEFORE the user enters the code
        // (creds not yet registered) can't be resumed — the code is now dead.
        // Surface a clear, actionable error so the UI prompts for a fresh code
        // instead of spinning on a socket that will never pair.
        if (login.mode === "pairing" && !isSockRegistered(login.sock)) {
          const message =
            "The pairing code expired before it was entered. Request a new code and try again.";
          await resetActiveLogin(account.accountId, message);
          runtime.log(danger(`[wa] ${message}`));
          return { connected: false, message };
        }
        // Transient reconnect (515/440/428/…): keep the login alive and re-mint
        // the socket instead of surfacing "No active login in progress" on the
        // next web.login.wait poll. After a completed pair the creds are
        // registered, so the fresh socket resumes cleanly.
        const restarted = await restartLoginSocket(login, runtime, login.errorStatus);
        if (restarted && isLoginFresh(login)) {
          continue;
        }
      }
      const message = `WhatsApp login failed: ${login.error}`;
      await resetActiveLogin(account.accountId, message);
      runtime.log(danger(message));
      return { connected: false, message };
    }

    if (login.connected) {
      const message = "✅ Linked! WhatsApp is ready.";
      runtime.log(success(message));
      // Fully tear down the login socket, then give WhatsApp a moment to release
      // the connection slot BEFORE the caller starts the live monitor socket.
      // Otherwise the monitor's first connect races the just-closed login socket
      // and gets a 440 (stream replaced / conflict). The monitor now retries on
      // 440 anyway, but settling here means it connects on the first try.
      await resetActiveLogin(account.accountId);
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      return { connected: true, message };
    }

    return { connected: false, message: "Login ended without a connection." };
  }
}
