const DEFAULT_PORT = 18792;

const BADGE = {
  on: { text: "ON", color: "#FF5A36" },
  off: { text: "", color: "#000000" },
  pair: { text: "PAIR", color: "#7C3AED" },
  paused: { text: "OFF", color: "#475569" },
  connecting: { text: "…", color: "#F59E0B" },
  error: { text: "!", color: "#B91C1C" },
};

/** @type {WebSocket|null} */
let relayWs = null;
/** @type {Promise<void>|null} */
let relayConnectPromise = null;
let reconnectAttempt = 0;

let debuggerListenersInstalled = false;

let nextSession = 1;

/** @type {Map<number, {state:'connecting'|'connected', sessionId?:string, targetId?:string, attachOrder?:number, owner?:string}>} */
const tabs = new Map();
/** @type {Map<string, number>} */
const tabBySession = new Map();
/** @type {Map<string, number>} */
const childSessionToTab = new Map();
/** Tabs the user explicitly detached via the toolbar — auto-attach skips these until re-toggled. */
/** @type {Set<number>} */
const userDetached = new Set();

/** @type {Map<number, {resolve:(v:any)=>void, reject:(e:Error)=>void}>} */
const pending = new Map();

function nowStack() {
  try {
    return new Error().stack || "";
  } catch {
    return "";
  }
}

async function getRelayPort() {
  const stored = await chrome.storage.local.get(["relayPort"]);
  const raw = stored.relayPort;
  const n = Number.parseInt(String(raw || ""), 10);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) return DEFAULT_PORT;
  return n;
}

async function getRelaySettings() {
  const stored = await chrome.storage.local.get([
    "relayPort",
    "pairingToken",
    "profileName",
    "autoAttachExisting",
    "paused",
  ]);
  return {
    port: Number.isFinite(Number(stored.relayPort)) ? Number(stored.relayPort) : DEFAULT_PORT,
    token: String(stored.pairingToken || ""),
    profileName: String(stored.profileName || "Chrome"),
    autoAttachExisting: stored.autoAttachExisting === true,
    paused: stored.paused === true,
  };
}

function setBadge(tabId, kind) {
  const cfg = BADGE[kind];
  void chrome.action.setBadgeText({ tabId, text: cfg.text });
  void chrome.action.setBadgeBackgroundColor({ tabId, color: cfg.color });
  void chrome.action.setBadgeTextColor({ tabId, color: "#FFFFFF" }).catch(() => {});
}

async function ensureRelayConnection() {
  if (relayWs && relayWs.readyState === WebSocket.OPEN) return;
  if (relayConnectPromise) return await relayConnectPromise;

  relayConnectPromise = (async () => {
    const settings = await getRelaySettings();
    const port = settings.port;
    if (settings.paused) throw new Error("Browser control is paused in the extension");
    if (!settings.token) {
      await chrome.action.setBadgeText({ text: BADGE.pair.text });
      await chrome.action.setBadgeBackgroundColor({ color: BADGE.pair.color });
      throw new Error("Pair this Chrome profile from the InfiniBot Browser page first");
    }
    const httpBase = `http://127.0.0.1:${port}`;
    const wsUrl = `ws://127.0.0.1:${port}/extension?token=${encodeURIComponent(settings.token)}&profile=${encodeURIComponent(settings.profileName)}`;

    // Fast preflight: is the relay server up?
    try {
      await fetch(`${httpBase}/`, { method: "HEAD", signal: AbortSignal.timeout(2000) });
    } catch (err) {
      throw new Error(`Relay server not reachable at ${httpBase} (${String(err)})`);
    }

    const ws = new WebSocket(wsUrl);
    relayWs = ws;

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        try {
          ws.close();
        } catch {
          // ignore
        }
        reject(new Error("WebSocket connect timeout"));
      }, 5000);
      ws.onopen = () => {
        clearTimeout(t);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(t);
        reject(new Error("WebSocket connect failed"));
      };
      ws.onclose = (ev) => {
        clearTimeout(t);
        reject(new Error(`WebSocket closed (${ev.code} ${ev.reason || "no reason"})`));
      };
    }).catch((err) => {
      // Don't keep a dead socket around: the reconnect logic keys off it.
      if (relayWs === ws) relayWs = null;
      throw err;
    });

    ws.onmessage = (event) => void onRelayMessage(String(event.data || ""));
    ws.onclose = () => onRelayClosed("closed");
    ws.onerror = () => onRelayClosed("error");
    reconnectAttempt = 0;
    if (quickRetryTimer) {
      clearTimeout(quickRetryTimer);
      quickRetryTimer = null;
    }
    void chrome.alarms.clear(RECONNECT_ALARM).catch(() => {});

    if (!debuggerListenersInstalled) {
      debuggerListenersInstalled = true;
      chrome.debugger.onEvent.addListener(onDebuggerEvent);
      chrome.debugger.onDetach.addListener(onDebuggerDetach);
    }
  })();

  try {
    await relayConnectPromise;
  } finally {
    relayConnectPromise = null;
  }
}

function onRelayClosed(reason) {
  relayWs = null;
  for (const [id, p] of pending.entries()) {
    pending.delete(id);
    p.reject(new Error(`Relay disconnected (${reason})`));
  }

  for (const tabId of tabs.keys()) {
    void chrome.debugger.detach({ tabId }).catch(() => {});
    setBadge(tabId, "connecting");
    void chrome.action.setTitle({
      tabId,
      title: "InfiniBot Browser Relay: disconnected (click to re-attach)",
    });
  }
  tabs.clear();
  tabBySession.clear();
  childSessionToTab.clear();
  void scheduleReconnect();
}

const RECONNECT_ALARM = "infinibot-relay-reconnect";
/**
 * Always-on 30 s heartbeat while paired. MV3 kills an idle service worker;
 * the alarm wakes it again so the relay socket comes back on its own (after
 * Chrome sleeps, the laptop wakes, or the InfiniBot gateway restarts).
 */
const KEEPALIVE_ALARM = "infinibot-relay-keepalive";
let quickRetryTimer = null;

async function scheduleReconnect() {
  const settings = await getRelaySettings();
  if (settings.paused || !settings.token) return;
  reconnectAttempt = Math.min(reconnectAttempt + 1, 8);
  // Fast path while the worker is still alive: 1 s, 2 s, 4 s, 8 s, 15 s…
  if (quickRetryTimer) clearTimeout(quickRetryTimer);
  const quickMs = Math.min(15_000, 500 * 2 ** reconnectAttempt);
  quickRetryTimer = setTimeout(() => {
    quickRetryTimer = null;
    void ensureRelayConnectionSafe();
  }, quickMs);
  // Slow path survives the worker being killed.
  const delayInMinutes = Math.max(0.5, Math.min(5, 2 ** reconnectAttempt / 60));
  chrome.alarms.create(RECONNECT_ALARM, { delayInMinutes });
}

async function ensureKeepaliveAlarm() {
  const settings = await getRelaySettings();
  if (settings.paused || !settings.token) {
    await chrome.alarms.clear(KEEPALIVE_ALARM).catch(() => {});
    return;
  }
  const existing = await chrome.alarms.get(KEEPALIVE_ALARM).catch(() => null);
  if (!existing) chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
}

function sendToRelay(payload) {
  const ws = relayWs;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error("Relay not connected");
  }
  ws.send(JSON.stringify(payload));
}

async function maybeOpenHelpOnce() {
  try {
    const stored = await chrome.storage.local.get(["helpOnErrorShown"]);
    if (stored.helpOnErrorShown === true) return;
    await chrome.storage.local.set({ helpOnErrorShown: true });
    await chrome.runtime.openOptionsPage();
  } catch {
    // ignore
  }
}

function requestFromRelay(command) {
  const id = command.id;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      sendToRelay(command);
    } catch (err) {
      pending.delete(id);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

async function onRelayMessage(text) {
  /** @type {any} */
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }

  if (msg && msg.method === "ping") {
    try {
      sendToRelay({ method: "pong" });
    } catch {
      // ignore
    }
    return;
  }

  if (msg && typeof msg.id === "number" && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(String(msg.error)));
    else p.resolve(msg.result);
    return;
  }

  if (msg && typeof msg.id === "number" && msg.method === "forwardCDPCommand") {
    try {
      const result = await handleForwardCdpCommand(msg);
      sendToRelay({ id: msg.id, result });
    } catch (err) {
      sendToRelay({ id: msg.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

function getTabBySessionId(sessionId) {
  const direct = tabBySession.get(sessionId);
  if (direct) return { tabId: direct, kind: "main" };
  const child = childSessionToTab.get(sessionId);
  if (child) return { tabId: child, kind: "child" };
  return null;
}

function getTabByTargetId(targetId) {
  for (const [tabId, tab] of tabs.entries()) {
    if (tab.targetId === targetId) return tabId;
  }
  return null;
}

const attachInFlight = new Map();
/** Tabs InfiniBot is creating itself (Target.createTarget): auto-attach leaves them alone. */
const agentCreatedTabs = new Set();

/**
 * Idempotent: a tab that is already attached (or being attached by the
 * tabs.onCreated auto-attach) returns that attachment instead of failing with
 * "Another debugger is already attached".
 */
async function attachTab(tabId, opts = {}) {
  const existing = tabs.get(tabId);
  if (existing?.state === "connected" && existing.sessionId && existing.targetId) {
    if (opts.owner) existing.owner = opts.owner;
    return { sessionId: existing.sessionId, targetId: existing.targetId };
  }
  const pending = attachInFlight.get(tabId);
  if (pending) {
    const res = await pending;
    const state = tabs.get(tabId);
    if (state && opts.owner) state.owner = opts.owner;
    return res;
  }
  const p = attachTabNow(tabId, opts);
  attachInFlight.set(tabId, p);
  try {
    return await p;
  } finally {
    attachInFlight.delete(tabId);
  }
}

async function attachTabNow(tabId, opts = {}) {
  const debuggee = { tabId };
  await chrome.debugger.attach(debuggee, "1.3");
  await chrome.debugger.sendCommand(debuggee, "Page.enable").catch(() => {});

  const info = /** @type {any} */ (
    await chrome.debugger.sendCommand(debuggee, "Target.getTargetInfo")
  );
  const targetInfo = info?.targetInfo;
  const targetId = String(targetInfo?.targetId || "").trim();
  if (!targetId) {
    throw new Error("Target.getTargetInfo returned no targetId");
  }

  const sessionId = `cb-tab-${nextSession++}`;
  const attachOrder = nextSession;

  tabs.set(tabId, { state: "connected", sessionId, targetId, attachOrder, owner: opts.owner });
  tabBySession.set(sessionId, tabId);
  void chrome.action.setTitle({
    tabId,
    title: "InfiniBot Browser Relay: attached (click to detach)",
  });

  if (!opts.skipAttachedEvent) {
    sendToRelay({
      method: "forwardCDPEvent",
      params: {
        method: "Target.attachedToTarget",
        params: {
          sessionId,
          targetInfo: { ...targetInfo, attached: true },
          waitingForDebugger: false,
        },
      },
    });
  }

  setBadge(tabId, "on");
  return { sessionId, targetId };
}

async function detachTab(tabId, reason) {
  const tab = tabs.get(tabId);
  if (tab?.sessionId && tab?.targetId) {
    try {
      sendToRelay({
        method: "forwardCDPEvent",
        params: {
          method: "Target.detachedFromTarget",
          params: { sessionId: tab.sessionId, targetId: tab.targetId, reason },
        },
      });
    } catch {
      // ignore
    }
  }

  if (tab?.sessionId) tabBySession.delete(tab.sessionId);
  tabs.delete(tabId);

  for (const [childSessionId, parentTabId] of childSessionToTab.entries()) {
    if (parentTabId === tabId) childSessionToTab.delete(childSessionId);
  }

  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // ignore
  }

  setBadge(tabId, "off");
  void chrome.action.setTitle({
    tabId,
    title: "InfiniBot Browser Relay (click to attach/detach)",
  });
}

async function connectOrToggleForActiveTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = active?.id;
  if (!tabId) return;

  const existing = tabs.get(tabId);
  if (existing?.state === "connected") {
    userDetached.add(tabId);
    await detachTab(tabId, "toggle");
    return;
  }

  userDetached.delete(tabId);

  tabs.set(tabId, { state: "connecting" });
  setBadge(tabId, "connecting");
  void chrome.action.setTitle({
    tabId,
    title: "InfiniBot Browser Relay: connecting to local relay…",
  });

  try {
    await ensureRelayConnection();
    await attachTab(tabId);
  } catch (err) {
    tabs.delete(tabId);
    setBadge(tabId, "error");
    void chrome.action.setTitle({
      tabId,
      title: "InfiniBot Browser Relay: relay not running (open options for setup)",
    });
    void maybeOpenHelpOnce();
    // Extra breadcrumbs in chrome://extensions service worker logs.
    const message = err instanceof Error ? err.message : String(err);
    console.warn("attach failed", message, nowStack());
  }
}

/**
 * URLs that chrome.debugger.attach cannot attach to (or shouldn't, for safety):
 * Chrome's own UI surfaces, the Web Store, devtools, and view-source pages.
 */
function isEligibleUrl(url) {
  if (!url) return false;
  if (url.startsWith("chrome://")) return false;
  if (url.startsWith("chrome-extension://")) return false;
  if (url.startsWith("chrome-search://")) return false;
  if (url.startsWith("devtools://")) return false;
  if (url.startsWith("view-source:")) return false;
  if (url.startsWith("edge://")) return false;
  if (url.startsWith("about:") && url !== "about:blank") return false;
  if (url.includes("chrome.google.com/webstore")) return false;
  if (url.includes("chromewebstore.google.com")) return false;
  return true;
}

/**
 * Try to auto-attach a tab without surfacing errors. The relay may be down,
 * the tab may be a chrome:// page, or DevTools may already be attached —
 * all are silent no-ops because auto-attach runs in the background.
 */
async function safeAutoAttach(tabId, url) {
  const settings = await getRelaySettings();
  if (!settings.autoAttachExisting) return;
  if (userDetached.has(tabId)) return;
  if (tabs.has(tabId)) return;
  if (agentCreatedTabs.has(tabId)) return;
  if (!isEligibleUrl(url)) return;

  tabs.set(tabId, { state: "connecting" });
  setBadge(tabId, "connecting");

  try {
    await ensureRelayConnection();
    await attachTab(tabId);
  } catch (err) {
    tabs.delete(tabId);
    setBadge(tabId, "off");
    const message = err instanceof Error ? err.message : String(err);
    console.debug("auto-attach skipped", tabId, message);
  }
}

async function rescanAllTabs() {
  const settings = await getRelaySettings();
  if (!settings.autoAttachExisting) {
    chrome.alarms.clear(AUTO_ATTACH_ALARM).catch(() => {});
    return;
  }
  let allTabs;
  try {
    allTabs = await chrome.tabs.query({});
  } catch {
    return;
  }
  for (const t of allTabs) {
    if (typeof t.id === "number") {
      void safeAutoAttach(t.id, t.url || t.pendingUrl || "");
    }
  }
  void updateAutoAttachAlarm();
}

const AUTO_ATTACH_ALARM = "infinibot-auto-attach-rescan";

/**
 * Count tabs that *should* be attached but aren't yet — i.e. eligible URL,
 * not user-detached, not already in our tabs map. While any exist, we keep an
 * alarm running so the service worker is periodically woken to retry. Once
 * everything is attached, the alarm is cleared.
 */
async function countPendingAttachTabs() {
  const settings = await getRelaySettings();
  if (!settings.autoAttachExisting) return 0;
  let allTabs;
  try {
    allTabs = await chrome.tabs.query({});
  } catch {
    return 0;
  }
  let pending = 0;
  for (const t of allTabs) {
    const id = typeof t.id === "number" ? t.id : null;
    if (id === null) continue;
    if (userDetached.has(id)) continue;
    if (tabs.has(id)) continue;
    if (!isEligibleUrl(t.url || t.pendingUrl || "")) continue;
    pending++;
  }
  return pending;
}

async function updateAutoAttachAlarm() {
  const pending = await countPendingAttachTabs();
  if (pending > 0) {
    // periodInMinutes minimum is 0.5 in MV3 — fires every 30s.
    chrome.alarms.create(AUTO_ATTACH_ALARM, { periodInMinutes: 0.5 });
  } else {
    chrome.alarms.clear(AUTO_ATTACH_ALARM).catch(() => {});
  }
}

async function handleForwardCdpCommand(msg) {
  const method = String(msg?.params?.method || "").trim();
  const params = msg?.params?.params || undefined;
  const sessionId = typeof msg?.params?.sessionId === "string" ? msg.params.sessionId : undefined;

  // ── Tab-independent methods ──────────────────────────────────────────────
  // These must be handled BEFORE the "no attached tab" guard below, otherwise
  // a cold start (relay connected, zero tabs attached yet) can never bootstrap
  // its first tab: Target.createTarget would throw "No attached tab" even
  // though its whole job is to CREATE a tab. This was the root cause of
  // `Page.enable` / cold-attach timeouts — the relay had nothing attached and
  // no way to attach the first target from the consumer side.
  if (method === "Target.createTarget") {
    const url = typeof params?.url === "string" ? params.url : "about:blank";
    const tab = await chrome.tabs.create({ url, active: false });
    if (!tab.id) throw new Error("Failed to create tab");
    agentCreatedTabs.add(tab.id);
    setTimeout(() => agentCreatedTabs.delete(tab.id), 10_000);
    await new Promise((r) => setTimeout(r, 100));
    // An auto-attach that won the race marks the tab "connecting" first;
    // give it a moment so attachTab() can reuse it.
    for (let i = 0; i < 20 && tabs.get(tab.id)?.state === "connecting" && !attachInFlight.has(tab.id); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const owner = typeof params?.infinibotRunId === "string" ? params.infinibotRunId : "agent";
    const attached = await attachTab(tab.id, { owner });
    await groupAgentTab(
      tab.id,
      owner,
      typeof params?.infinibotLabel === "string" ? params.infinibotLabel : owner,
    );
    return { targetId: attached.targetId };
  }

  if (method === "InfiniBot.claimTab") {
    const target = typeof params?.targetId === "string" ? params.targetId : "";
    const toClaim = target ? getTabByTargetId(target) : null;
    if (!toClaim) throw new Error("Tab not found for claim");
    const runId = String(params?.runId || "agent");
    const label = String(params?.label || runId);
    const state = tabs.get(toClaim);
    if (state) state.owner = runId;
    await groupAgentTab(toClaim, runId, label);
    return { claimed: true };
  }

  if (method === "InfiniBot.releaseTab") {
    const target = typeof params?.targetId === "string" ? params.targetId : "";
    const toRelease = target ? getTabByTargetId(target) : null;
    if (!toRelease) return { released: false };
    await detachTab(toRelease, "released by agent");
    return { released: true };
  }

  // Map command to tab
  const bySession = sessionId ? getTabBySessionId(sessionId) : null;
  const targetId = typeof params?.targetId === "string" ? params.targetId : undefined;
  const tabId =
    bySession?.tabId ||
    (targetId ? getTabByTargetId(targetId) : null) ||
    (() => {
      // No sessionId: pick the first connected tab (stable-ish).
      for (const [id, tab] of tabs.entries()) {
        if (tab.state === "connected") return id;
      }
      return null;
    })();

  if (!tabId) throw new Error(`No attached tab for method ${method}`);

  /** @type {chrome.debugger.DebuggerSession} */
  const debuggee = { tabId };

  if (method === "Target.closeTarget") {
    const target = typeof params?.targetId === "string" ? params.targetId : "";
    const toClose = target ? getTabByTargetId(target) : tabId;
    if (!toClose) return { success: false };
    try {
      await chrome.tabs.remove(toClose);
    } catch {
      return { success: false };
    }
    return { success: true };
  }

  if (method === "Target.activateTarget") {
    const target = typeof params?.targetId === "string" ? params.targetId : "";
    const toActivate = target ? getTabByTargetId(target) : tabId;
    if (!toActivate) return {};
    const tab = await chrome.tabs.get(toActivate).catch(() => null);
    if (!tab) return {};
    if (tab.windowId) {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    }
    await chrome.tabs.update(toActivate, { active: true }).catch(() => {});
    return {};
  }

  const tabState = tabs.get(tabId);
  const mainSessionId = tabState?.sessionId;
  const debuggerSession =
    sessionId && mainSessionId && sessionId !== mainSessionId
      ? { ...debuggee, sessionId }
      : debuggee;

  return await chrome.debugger.sendCommand(debuggerSession, method, params);
}

const GROUP_COLORS = ["orange", "yellow", "green", "cyan", "blue", "purple", "pink", "red", "grey"];

async function groupAgentTab(tabId, runId, label) {
  try {
    const hash = [...String(runId)].reduce((n, ch) => (n * 33 + ch.charCodeAt(0)) >>> 0, 5381);
    const groupId = await chrome.tabs.group({ tabIds: [tabId] });
    await chrome.tabGroups.update(groupId, {
      title: `InfiniBot · ${String(label).slice(0, 32)}`,
      color: GROUP_COLORS[hash % GROUP_COLORS.length],
      collapsed: false,
    });
  } catch (err) {
    console.debug("tab grouping unavailable", String(err));
  }
}

function onDebuggerEvent(source, method, params) {
  const tabId = source.tabId;
  if (!tabId) return;
  const tab = tabs.get(tabId);
  if (!tab?.sessionId) return;

  if (method === "Target.attachedToTarget" && params?.sessionId) {
    childSessionToTab.set(String(params.sessionId), tabId);
  }

  if (method === "Target.detachedFromTarget" && params?.sessionId) {
    childSessionToTab.delete(String(params.sessionId));
  }

  try {
    sendToRelay({
      method: "forwardCDPEvent",
      params: {
        sessionId: source.sessionId || tab.sessionId,
        method,
        params,
      },
    });
  } catch {
    // ignore
  }
}

function onDebuggerDetach(source, reason) {
  const tabId = source.tabId;
  if (!tabId) return;
  if (!tabs.has(tabId)) return;
  void detachTab(tabId, reason);
}

chrome.action.onClicked.addListener(() => void connectOrToggleForActiveTab());

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.action === "toggle-active") {
    void connectOrToggleForActiveTab()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  if (message?.action === "set-paused") {
    void setPaused(Boolean(message.paused))
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  if (message?.action === "status") {
    void getRelaySettings().then((settings) =>
      sendResponse({
        connected: Boolean(relayWs && relayWs.readyState === WebSocket.OPEN),
        paused: settings.paused,
        paired: Boolean(settings.token),
        profileName: settings.profileName,
        controlledTabs: tabs.size,
      }),
    );
    return true;
  }
  return false;
});

async function setPaused(paused) {
  await chrome.storage.local.set({ paused });
  if (paused) {
    for (const tabId of [...tabs.keys()]) await detachTab(tabId, "kill switch");
    relayWs?.close(4000, "paused by user");
    await chrome.action.setBadgeText({ text: BADGE.paused.text });
    await chrome.action.setBadgeBackgroundColor({ color: BADGE.paused.color });
  } else {
    await chrome.action.setBadgeText({ text: "" });
    await ensureRelayConnectionSafe();
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    void chrome.runtime.openOptionsPage();
  }
  void rescanAllTabs();
  void earlyBootstrapRescan();
});

chrome.runtime.onStartup.addListener(() => {
  void rescanAllTabs();
  void earlyBootstrapRescan();
});

chrome.tabs.onCreated.addListener((tab) => {
  if (typeof tab.id !== "number") return;
  void safeAutoAttach(tab.id, tab.url || tab.pendingUrl || "");
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url) return;
  void safeAutoAttach(tabId, changeInfo.url || tab.url || "");
});

chrome.tabs.onRemoved.addListener((tabId) => {
  userDetached.delete(tabId);
  void updateAutoAttachAlarm();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name === AUTO_ATTACH_ALARM) void rescanAllTabs();
  if (alarm?.name === RECONNECT_ALARM || alarm?.name === KEEPALIVE_ALARM) {
    void ensureRelayConnectionSafe();
  }
});

// Pairing / pause changes from the options page or popup.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.pairingToken || changes.paused || changes.relayPort) {
    reconnectAttempt = 0;
    void ensureKeepaliveAlarm();
    void ensureRelayConnectionSafe();
  }
});

/**
 * Cold-start race window: the relay HTTP server may come up a beat after Chrome
 * launches with --load-extension, so the first attach attempt can fail. Retry
 * quickly for ~10 seconds before falling back to the chrome.alarms cadence
 * (which only fires every 30s minimum).
 */
async function earlyBootstrapRescan() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    void ensureRelayConnectionSafe();
    const pending = await countPendingAttachTabs();
    if (pending === 0 && relayWs && relayWs.readyState === WebSocket.OPEN) return;
    await new Promise((r) => setTimeout(r, 1000));
    await rescanAllTabs();
  }
}

/**
 * Open the relay WebSocket eagerly so the gateway shows connected=true and can
 * deliver server-initiated commands (Target.createTarget, evaluate, etc.) even
 * before any user tab is attached. Without this, the WS is only opened lazily
 * by safeAutoAttach, which never fires if the only open tabs are chrome:// or
 * extension pages.
 */
async function ensureRelayConnectionSafe() {
  try {
    await ensureRelayConnection();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.debug("relay connect skipped", message);
    if ((!relayWs || relayWs.readyState !== WebSocket.OPEN) && !quickRetryTimer) {
      void scheduleReconnect();
    }
  }
}

// Rescan on service-worker boot — Chrome can kill and revive the SW at any time.
void ensureKeepaliveAlarm();
void ensureRelayConnectionSafe();
void rescanAllTabs();
void earlyBootstrapRescan();
