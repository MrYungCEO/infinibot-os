const DEFAULT_PORT = 18792;

function clampPort(value) {
  const n = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(n)) return DEFAULT_PORT;
  if (n <= 0 || n > 65535) return DEFAULT_PORT;
  return n;
}

function updateRelayUrl(port) {
  const el = document.getElementById("relay-url");
  if (!el) return;
  el.textContent = `http://127.0.0.1:${port}/`;
}

function setStatus(kind, message) {
  const status = document.getElementById("status");
  if (!status) return;
  status.dataset.kind = kind || "";
  status.textContent = message || "";
}

function setPairStatus(kind, message) {
  const status = document.getElementById("pair-status");
  if (!status) return;
  status.dataset.kind = kind || "";
  status.textContent = message || "";
}

async function checkRelayReachable(port) {
  const url = `http://127.0.0.1:${port}/`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 900);
  try {
    const res = await fetch(url, { method: "HEAD", signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setStatus("ok", `Relay reachable at ${url}`);
  } catch {
    setStatus(
      "error",
      `Relay not reachable at ${url}. Start InfiniBot’s browser relay on this machine, then click the toolbar button again.`,
    );
  } finally {
    clearTimeout(t);
  }
}

async function load() {
  const stored = await chrome.storage.local.get([
    "relayPort",
    "pairingToken",
    "profileName",
    "autoAttachExisting",
  ]);
  const port = clampPort(stored.relayPort);
  document.getElementById("port").value = String(port);
  document.getElementById("profile-name").value = stored.profileName || "My Chrome";
  document.getElementById("auto-attach").checked = stored.autoAttachExisting === true;
  setPairStatus(
    stored.pairingToken ? "ok" : "",
    stored.pairingToken ? `Paired as ${stored.profileName || "Chrome"}.` : "Not paired yet.",
  );
  updateRelayUrl(port);
  await checkRelayReachable(port);
}

async function save() {
  const input = document.getElementById("port");
  const port = clampPort(input.value);
  await chrome.storage.local.set({
    relayPort: port,
    autoAttachExisting: document.getElementById("auto-attach").checked,
  });
  input.value = String(port);
  updateRelayUrl(port);
  await checkRelayReachable(port);
}

async function pair() {
  const port = clampPort(document.getElementById("port").value);
  const code = String(document.getElementById("pairing-code").value || "")
    .trim()
    .toUpperCase();
  const name = String(document.getElementById("profile-name").value || "").trim() || "My Chrome";
  setPairStatus("", "Pairing…");
  try {
    const res = await fetch(`http://127.0.0.1:${port}/extension/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, name, extensionId: chrome.runtime.id }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.token) throw new Error(body.error || `HTTP ${res.status}`);
    await chrome.storage.local.set({
      relayPort: port,
      pairingToken: body.token,
      profileName: body.profile?.name || name,
      autoAttachExisting: document.getElementById("auto-attach").checked,
      paused: false,
    });
    document.getElementById("pairing-code").value = "";
    setPairStatus(
      "ok",
      `Paired as ${body.profile?.name || name}. The relay will reconnect automatically.`,
    );
    await chrome.runtime.sendMessage({ action: "set-paused", paused: false }).catch(() => {});
  } catch (err) {
    setPairStatus("error", err instanceof Error ? err.message : String(err));
  }
}

document.getElementById("save").addEventListener("click", () => void save());
document.getElementById("pair").addEventListener("click", () => void pair());
void load();
