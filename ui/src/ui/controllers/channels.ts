import type { ChannelsStatusSnapshot } from "../types";
import type { ChannelsState } from "./channels.types";

export type { ChannelsState };

export async function loadChannels(state: ChannelsState, probe: boolean) {
  if (!state.client || !state.connected) return;
  if (state.channelsLoading) return;
  state.channelsLoading = true;
  state.channelsError = null;
  try {
    const res = (await state.client.request("channels.status", {
      probe,
      timeoutMs: 8000,
    })) as ChannelsStatusSnapshot;
    state.channelsSnapshot = res;
    state.channelsLastSuccess = Date.now();
  } catch (err) {
    state.channelsError = String(err);
  } finally {
    state.channelsLoading = false;
  }
}

export async function startWhatsAppLogin(state: ChannelsState, force: boolean) {
  if (!state.client || !state.connected || state.whatsappBusy) return;
  state.whatsappBusy = true;
  try {
    const res = (await state.client.request("web.login.start", {
      force,
      timeoutMs: 30000,
    })) as { message?: string; qrDataUrl?: string };
    state.whatsappLoginMessage = res.message ?? null;
    state.whatsappLoginQrDataUrl = res.qrDataUrl ?? null;
    state.whatsappLoginConnected = null;
  } catch (err) {
    state.whatsappLoginMessage = String(err);
    state.whatsappLoginQrDataUrl = null;
    state.whatsappLoginConnected = null;
  } finally {
    state.whatsappBusy = false;
  }
  // One-click connect: once a QR is displayed, automatically poll for the scan
  // and refresh channel status on success — the user only has to scan.
  if (state.whatsappLoginQrDataUrl && !state.whatsappLoginConnected) {
    void autoAwaitWhatsAppLink(state);
  }
}

// Start a pairing-code (phone-number) link — the reliable path. Requests an
// 8-digit code for the given phone number, then auto-polls for the link the
// same way the QR flow does (both share web.login.wait + the server-side
// activeLogins lifecycle).
export async function startWhatsAppPairing(
  state: ChannelsState,
  phoneNumber: string,
  force: boolean,
) {
  if (!state.client || !state.connected || state.whatsappBusy) return;
  state.whatsappBusy = true;
  state.whatsappPairingCode = null;
  state.whatsappLoginQrDataUrl = null;
  state.whatsappLoginConnected = null;
  try {
    const res = (await state.client.request("web.login.pairingCode.start", {
      phoneNumber,
      force,
      timeoutMs: 30000,
    })) as { message?: string; pairingCode?: string };
    state.whatsappLoginMessage = res.message ?? null;
    state.whatsappPairingCode = res.pairingCode ?? null;
  } catch (err) {
    state.whatsappLoginMessage = String(err);
    state.whatsappPairingCode = null;
  } finally {
    state.whatsappBusy = false;
  }
  // Once a code is displayed, poll for the link in the background — the user
  // only has to type the code into WhatsApp.
  if (state.whatsappPairingCode && !state.whatsappLoginConnected) {
    void autoAwaitWhatsAppLink(state);
  }
}

// Background poll after a QR/pairing code is shown. Bounded by the ~3-min login
// TTL. Does not set whatsappBusy so Logout/Refresh stay usable while linking.
async function autoAwaitWhatsAppLink(state: ChannelsState) {
  const deadline = Date.now() + 180_000;
  const pending = () => Boolean(state.whatsappLoginQrDataUrl || state.whatsappPairingCode);
  while (pending() && !state.whatsappLoginConnected && Date.now() < deadline) {
    if (!state.client || !state.connected) return;
    let res: { connected?: boolean; message?: string };
    try {
      res = (await state.client.request("web.login.wait", { timeoutMs: 30000 })) as {
        connected?: boolean;
        message?: string;
      };
    } catch (err) {
      state.whatsappLoginMessage = String(err);
      return;
    }
    if (res.connected) {
      state.whatsappLoginConnected = true;
      state.whatsappLoginMessage = res.message ?? "Linked! WhatsApp is ready.";
      state.whatsappLoginQrDataUrl = null;
      state.whatsappPairingCode = null;
      await loadChannels(state, true);
      return;
    }
    if (res.message) state.whatsappLoginMessage = res.message;
    // Server dropped the pending login (expired / no active session): stop polling.
    if (res.message && /expired|no active/i.test(res.message)) {
      state.whatsappLoginQrDataUrl = null;
      state.whatsappPairingCode = null;
      return;
    }
  }
}

export async function waitWhatsAppLogin(state: ChannelsState) {
  if (!state.client || !state.connected || state.whatsappBusy) return;
  state.whatsappBusy = true;
  try {
    const res = (await state.client.request("web.login.wait", {
      timeoutMs: 120000,
    })) as { connected?: boolean; message?: string };
    state.whatsappLoginMessage = res.message ?? null;
    state.whatsappLoginConnected = res.connected ?? null;
    if (res.connected) {
      state.whatsappLoginQrDataUrl = null;
      state.whatsappPairingCode = null;
    }
  } catch (err) {
    state.whatsappLoginMessage = String(err);
    state.whatsappLoginConnected = null;
  } finally {
    state.whatsappBusy = false;
  }
}

export async function logoutWhatsApp(state: ChannelsState) {
  if (!state.client || !state.connected || state.whatsappBusy) return;
  state.whatsappBusy = true;
  try {
    await state.client.request("channels.logout", { channel: "whatsapp" });
    state.whatsappLoginMessage = "Logged out.";
    state.whatsappLoginQrDataUrl = null;
    state.whatsappPairingCode = null;
    state.whatsappLoginConnected = null;
  } catch (err) {
    state.whatsappLoginMessage = String(err);
  } finally {
    state.whatsappBusy = false;
  }
}
