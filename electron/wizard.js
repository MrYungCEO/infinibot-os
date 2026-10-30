// Renderer for the first-run wizard. Talks to the main process via
// the `window.wizard` bridge defined in preload.js.
//
// Guard against double-execution: if a preload error causes Electron to
// re-run the page scripts in the same context, redeclaring `const api`
// would throw and silently break every button. The guard keeps that
// failure mode from masking the real preload error.
if (window.__infinibotWizardBooted) {
  console.warn("wizard.js double-load suppressed");
} else {
  window.__infinibotWizardBooted = true;

const api = window.wizard;
const lic = window.license;

const tiles = {
  restore: document.getElementById("tile-restore"),
  local: document.getElementById("tile-local"),
  satellite: document.getElementById("tile-satellite"),
  cloud: document.getElementById("tile-cloud"),
};
const panels = {
  restore: document.getElementById("panel-restore"),
  local: document.getElementById("panel-local"),
  satellite: document.getElementById("panel-satellite"),
  cloud: document.getElementById("panel-cloud"),
};

function selectMode(mode) {
  for (const [k, tile] of Object.entries(tiles)) {
    tile.classList.toggle("selected", k === mode);
  }
  for (const [k, panel] of Object.entries(panels)) {
    panel.classList.toggle("active", k === mode);
  }
}
for (const [mode, tile] of Object.entries(tiles)) {
  tile.addEventListener("click", () => selectMode(mode));
}

// ── InfiniBot Cloud tile ─────────────────────────────────────────
for (const [id, inApp] of [["cloud-open", true], ["cloud-browser", false]]) {
  document.getElementById(id)?.addEventListener("click", async () => {
    const st = document.getElementById("cloud-status");
    try {
      const r = await api.openCloud?.({ inApp });
      if (st) st.textContent = r?.ok ? (inApp ? "Opened InfiniBot Cloud." : "Opened in your browser.") : (r?.error || "Couldn't open InfiniBot Cloud.");
    } catch (err) {
      if (st) st.textContent = `Couldn't open InfiniBot Cloud: ${err?.message || err}`;
    }
  });
}

function log(elId, msg, kind = "") {
  const el = document.getElementById(elId);
  el.classList.add("active");
  const line = document.createElement("div");
  if (kind) line.className = kind;
  line.textContent = msg;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

// ── Restore tile ────────────────────────────────────────────────
let selectedZip = null;

document.getElementById("restore-pick").addEventListener("click", async () => {
  const result = await api.pickBackup();
  if (result.canceled || !result.path) return;
  selectedZip = result.path;
  document.getElementById("restore-zip").value = selectedZip;
  document.getElementById("restore-go").disabled = false;

  // Try to preview the manifest
  try {
    const preview = await api.inspectBackup(selectedZip);
    if (preview.ok) {
      const m = preview.manifest;
      const body = document.getElementById("restore-preview-body");
      body.textContent = [
        `created:   ${m.createdAt}`,
        `version:   ${m.infinibotVersion ?? "unknown"}`,
        `user:      ${m.userId}`,
        `hostname:  ${m.hostname}`,
        `platform:  ${m.platform}`,
        `shared:    ${m.sharedDirSource}`,
        m.hasUserSubtree ? `state:     ${m.stateDirSource}` : null,
        m.hasWorkspace ? `workspace: ${m.workspaceDirSource}` : null,
      ].filter(Boolean).join("\n");
      document.getElementById("restore-preview").style.display = "block";
    }
  } catch {
    // preview is best-effort
  }
});

document.getElementById("restore-go").addEventListener("click", async () => {
  if (!selectedZip) return;
  const btn = document.getElementById("restore-go");
  btn.disabled = true;
  btn.textContent = "Restoring…";
  log("restore-log", `Restoring from ${selectedZip}…`);
  const result = await api.restoreBackup(selectedZip);
  for (const line of result.lines ?? []) log("restore-log", line, result.ok ? "" : "warn");
  if (!result.ok) {
    log("restore-log", `Restore failed: ${result.error}`, "err");
    btn.disabled = false;
    btn.textContent = "Restore and Continue";
    return;
  }
  log("restore-log", "Restore complete. Starting local gateway…", "ok");
  await launchGateway("restore-log");
});

// ── Local tile — 7-step stepper ────────────────────────────────
const val = (id) => (document.getElementById(id)?.value ?? "").trim();
const checked = (id) => Boolean(document.getElementById(id)?.checked);

// Selection state. Coder backend (Step 3) + gateway-chat provider/model
// (Step 4) are populated entirely from gateway data — never hardcoded here.
let coderBackends = [];      // [{ id, displayName, description, loginCommand, install }]
let selectedCoder = null;    // CoderBackendId
let providers = [];          // [{ id, label, needsKey, probeField, models:[{id,name}] }]
let coderLoaded = false;
let providersLoaded = false;

function gotoStep(n) {
  for (const s of document.querySelectorAll("#panel-local .wstep")) {
    s.classList.toggle("active", Number(s.dataset.step) === n);
  }
  for (const d of document.querySelectorAll("#local-stepper .stepdot")) {
    const dn = Number(d.dataset.dot);
    d.classList.toggle("active", dn === n);
    d.classList.toggle("done", dn < n);
  }
  // Step rail (displayed 1-indexed, internal data-step in parens):
  //   1(0) KinglyVault · 2(1) Workspace · 3(2) Gateway access · 4(3) CLI agents ·
  //   5(4) Default coder · 6(5) Chat agent · 7(6) Connect Robovoice · 8(7) Channels ·
  //   9(8) Notion · 10(9) Launch.
  // The KinglyVault sign-in step uses data-step="0" so the existing internal
  // step numbers (and every gotoStep()/data-next/data-back) stay stable; only
  // the displayed numbers shift +1 (KV becomes "1").
  if (n === 0) renderKvStep();
  if (n === 3 || n === 4) loadCoderBackends();
  if (n === 5) loadProviders();
  if (n === 7) renderChannelCards();
  if (n === 8) renderNotionStep();
  if (n === 9) updateSummary();
}

// ── Step 0: Sign in to KinglyVault (license gate) ────────────────
// All plan/feature state lives in the main process (electron/license.js); the
// renderer only relays through window.license. Sign-in opens a KV BrowserWindow
// in main and resolves once it redirects to infinibot://callback?token=…
const PLAN_LABELS = { free: "Free", starter: "Starter", ceo: "CEO", vip: "VIP" };

function kvStatus(msg, kind = "") {
  const el = document.getElementById("kv-status");
  if (!el) return;
  el.textContent = msg || "";
  el.className = `kv-status ${kind}`;
}

// Self-hosted (the default) unless the main process runs with
// INFINIBOT_REQUIRE_VAULT=1. No license bridge at all (older/stripped preload)
// also means there is no way to sign in, so treat it as self-hosted too.
function isSelfHosted(state) {
  if (!lic?.getState) return true;
  const st = state || lic.getState();
  return !st || st.selfHosted !== false;
}

// Reflect the current license snapshot into the Step 0 UI.
function renderKvStep(snap) {
  const state = snap || (lic?.getState ? lic.getState() : null);
  const signedOut = document.getElementById("kv-signedout");
  const signedIn = document.getElementById("kv-signedin");
  const continueBtn = document.getElementById("kv-continue");
  const selfHost = isSelfHosted(state);
  const show = (id, on) => {
    const el = document.getElementById(id);
    if (el) el.style.display = on ? "block" : "none";
  };
  show("kv-selfhost", selfHost);
  show("kv-vault-intro", !selfHost);
  const dotLabel = document.getElementById("kv-dot-label");
  if (dotLabel) dotLabel.textContent = selfHost ? "Self-hosted" : "KinglyVault";
  // Self-hosted: no sign-in, no plan — just continue.
  if (selfHost) {
    if (signedOut) signedOut.style.display = "none";
    if (signedIn) signedIn.style.display = "none";
    if (continueBtn) continueBtn.style.display = "inline-flex";
    return;
  }
  // Vault-gated build: sign-in is the only route, even for Free tier. Anything
  // other than a confirmed signed-in state keeps the sign-in CTA visible.
  if (!state || !state.signedIn) {
    if (signedOut) signedOut.style.display = "block";
    if (signedIn) signedIn.style.display = "none";
    if (continueBtn) continueBtn.style.display = "none";
    return;
  }
  // Signed in (verified / grace / debug) → badge + Continue.
  if (signedOut) signedOut.style.display = "none";
  if (signedIn) signedIn.style.display = "block";
  if (continueBtn) continueBtn.style.display = "inline-flex";
  const badge = document.getElementById("kv-plan-badge");
  const sub = document.getElementById("kv-plan-sub");
  const isPaid = state.plan && state.plan !== "free";
  if (badge) {
    badge.classList.toggle("free", !isPaid);
    badge.textContent = isPaid ? `${PLAN_LABELS[state.plan] || state.plan} Plan ✓` : "Free ✓";
  }
  if (sub) {
    if (isPaid) sub.textContent = "Signed in to KinglyVault.";
    else sub.textContent = "Signed in · Free tier.";
  }
  // Show the Upgrade button only when there's a higher tier to move to.
  const upgradeBtn = document.getElementById("kv-upgrade");
  if (upgradeBtn) {
    const plan = state.plan || "free";
    upgradeBtn.style.display = plan === "ceo" || plan === "vip" ? "none" : "inline-flex";
  }
}

function kvRefreshStatus(msg, kind = "") {
  const el = document.getElementById("kv-refresh-status");
  if (!el) return;
  el.textContent = msg || "";
  el.className = `kv-status ${kind}`;
}

// InfiniBot Vault device-auth bridge (separate from the license/plan token).
// This is the credential the gateway/CLI actually require at launch; we
// establish it through the UI so the user never has to run `infinibot login`
// in a terminal.
const authApi = window.auth;

// Show the device user-code while the approval window is open.
authApi?.onDevicePending?.(({ userCode } = {}) => {
  if (userCode) kvStatus(`Approve this device in the window that opened — code: ${userCode}`);
});

// Ensure a valid Vault device token exists, running the UI device login if not.
// Returns { ok } | { ok:false, cancelled?, error }. Treats an older preload
// (no auth bridge) as a no-op success so the wizard still works.
async function ensureVaultAuth() {
  // Self-hosted: the gateway doesn't require a Vault device token.
  if (isSelfHosted()) return { ok: true, skipped: true };
  if (!authApi?.deviceLogin) return { ok: true, skipped: true };
  try {
    const st = await authApi.status();
    if (st?.signedIn) return { ok: true };
  } catch {/* fall through to device login */}
  return (await authApi.deviceLogin()) || { ok: false, error: "no response from device login" };
}

document.getElementById("kv-signin")?.addEventListener("click", async () => {
  const btn = document.getElementById("kv-signin");
  if (!lic?.signIn) { kvStatus("License bridge unavailable.", "bad"); return; }
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = "Opening KinglyVault…";
  kvStatus("Waiting for sign-in to complete…");
  try {
    const res = await lic.signIn();
    if (res?.reachable === false) {
      // KV unreachable: do NOT fall back to guest — sign-in is the only route,
      // even for the Free tier (a Free license is auto-issued on KV signup, so
      // every user has a real signed JWT). Surface the failure and ask the
      // user to retry / check connectivity.
      kvStatus("Couldn't reach KinglyVault. Check your connection and try again.", "bad");
    } else if (res?.ok && res?.state?.signedIn) {
      renderKvStep(res.state);
      // Establish the Vault device token in the same flow so the launch step
      // never falls through to a terminal `infinibot login`. The user is
      // already signed in to KinglyVault, so approval is usually one click.
      btn.textContent = "Authorizing device…";
      const va = await ensureVaultAuth();
      if (va.ok) {
        // The /login token can be a baseline (free) license; pull the live plan
        // from KV so a paid tier shows without a manual Refresh click.
        kvStatus("Signed in. Checking your plan…");
        try {
          const snap = await lic.refresh();
          renderKvStep(snap);
        } catch { /* keep the sign-in state we already have */ }
        kvStatus("Signed in.", "ok");
      } else if (va.cancelled) {
        kvStatus("Signed in. Device authorization was cancelled — click Sign in again to finish it.", "bad");
      } else {
        kvStatus(`Signed in. Device authorization didn't complete (${va.error || "unknown"}) — you can retry.`, "bad");
      }
    } else {
      kvStatus("Sign-in was cancelled. You must sign in to continue.", "bad");
    }
  } catch (err) {
    kvStatus(`Sign-in failed: ${err?.message || err}. Try again.`, "bad");
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
});

document.getElementById("kv-continue")?.addEventListener("click", () => gotoStep(1));

// "I've upgraded — Refresh": re-pull the license from KinglyVault and reflect
// the new plan. The main process re-verifies/decodes the token and restarts the
// gateway if the plan changed, so paid features light up without a relaunch.
document.getElementById("kv-refresh")?.addEventListener("click", async () => {
  const btn = document.getElementById("kv-refresh");
  if (!lic?.refresh) { kvRefreshStatus("License bridge unavailable.", "bad"); return; }
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = "Refreshing…";
  kvRefreshStatus("Checking KinglyVault for your latest plan…");
  try {
    const prevPlan = (lic.getState ? lic.getState() : null)?.plan || "free";
    const snap = await lic.refresh();
    renderKvStep(snap);
    const newPlan = snap?.plan || "free";
    if (newPlan !== prevPlan) {
      kvRefreshStatus(`Updated — you're now on the ${PLAN_LABELS[newPlan] || newPlan} plan.`, "ok");
    } else if (newPlan !== "free") {
      kvRefreshStatus(`Confirmed — ${PLAN_LABELS[newPlan] || newPlan} plan.`, "ok");
    } else {
      kvRefreshStatus("Still on the Free tier. If you just upgraded, give it a moment and try again.", "");
    }
  } catch (err) {
    kvRefreshStatus(`Refresh failed: ${err?.message || err}. Check your connection and try again.`, "bad");
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
});

// Upgrade: open the upgrade landing (all tiers) via the main process. On return
// the license is refreshed automatically (infinibot://license-refreshed).
document.getElementById("kv-upgrade")?.addEventListener("click", async () => {
  if (!lic?.openUpgrade) { kvRefreshStatus("Upgrade bridge unavailable.", "bad"); return; }
  const plan = (lic.getState ? lic.getState() : null)?.plan || "free";
  const target = plan === "starter" ? "ceo" : "ceo";
  try {
    kvRefreshStatus("Opening upgrade…");
    await lic.openUpgrade(target);
    // The main process refreshes + broadcasts on return; onChanged re-renders.
    kvRefreshStatus("");
  } catch (err) {
    kvRefreshStatus(`Couldn't open upgrade: ${err?.message || err}.`, "bad");
  }
});

// Keep the badge + summary live when the main process updates license state
// (sign-in callback, checkout return, debug paste, refresh).
lic?.onChanged?.((snap) => {
  renderKvStep(snap);
  // Refresh the summary plan row if the Launch step is currently visible.
  if (document.querySelector('#panel-local .wstep[data-step="8"].active')) updateSummary();
});

// ── Step 2/3: CLI coder agents (one source of truth = gateway) ───
async function loadCoderBackends(force = false) {
  if (coderLoaded && !force) return;
  const checkEl = document.getElementById("coder-check");
  const pickEl = document.getElementById("coder-pick");
  if (checkEl) checkEl.innerHTML = `<div class="hint">Detecting installed CLI agents…</div>`;
  let res;
  try {
    res = await api.coderBackends();
  } catch (err) {
    if (checkEl) checkEl.innerHTML = `<div class="key-state bad">Could not detect CLI agents: ${err.message}</div>`;
    return;
  }
  if (!res?.ok) {
    if (checkEl) checkEl.innerHTML = `<div class="key-state bad">${res?.error || "Could not detect CLI agents."}</div>`;
    return;
  }
  coderBackends = res.backends || [];
  coderLoaded = true;
  renderCoderCheck();
  renderCoderPick();
  // Default the coder selection to the first installed backend, else the first.
  if (!selectedCoder && coderBackends.length) {
    const firstInstalled = coderBackends.find((b) => b.install?.installed);
    selectCoder((firstInstalled || coderBackends[0]).id);
  }
}

function renderCoderCheck() {
  const el = document.getElementById("coder-check");
  if (!el) return;
  el.innerHTML = "";
  for (const b of coderBackends) {
    const installed = Boolean(b.install?.installed);
    const where = installed
      ? `installed at ${b.install?.binPath || "(path unknown)"}`
      : "not detected on this machine";
    const row = document.createElement("div");
    row.className = "cli-row";
    const head = document.createElement("div");
    head.className = "cli-head";
    const name = document.createElement("span");
    name.className = "cli-name";
    name.textContent = b.displayName || b.id;
    const badge = document.createElement("span");
    badge.className = `cli-badge ${installed ? "ok" : "bad"}`;
    badge.textContent = installed ? "✓ installed" : "not detected";
    head.appendChild(name);
    head.appendChild(badge);
    const pathLine = document.createElement("div");
    pathLine.className = "cli-path";
    pathLine.textContent = where;
    const loginLine = document.createElement("div");
    loginLine.className = "cli-login";
    const cmd = document.createElement("code");
    cmd.className = "code-cmd";
    cmd.textContent = b.loginCommand || "";
    const copy = document.createElement("button");
    copy.className = "copybtn";
    copy.type = "button";
    copy.textContent = "Copy";
    copy.addEventListener("click", () => copyText(b.loginCommand || "", copy));
    loginLine.appendChild(cmd);
    loginLine.appendChild(copy);
    row.appendChild(head);
    row.appendChild(pathLine);
    row.appendChild(loginLine);
    el.appendChild(row);
  }
}

function renderCoderPick() {
  const el = document.getElementById("coder-pick");
  if (!el) return;
  el.innerHTML = "";
  // Skip option — a default coder is optional; users can launch without one.
  {
    const lbl = document.createElement("label");
    lbl.className = "opt";
    lbl.dataset.coder = "";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "coder";
    radio.value = "";
    radio.addEventListener("change", () => selectCoder(""));
    const body = document.createElement("div");
    body.className = "opt-body";
    const title = document.createElement("div");
    title.className = "opt-title";
    title.textContent = "Skip — no default coder";
    const desc = document.createElement("div");
    desc.className = "opt-desc";
    desc.textContent = "Launch without a default CLI agent. You can set one later in Settings.";
    body.appendChild(title);
    body.appendChild(desc);
    lbl.appendChild(radio);
    lbl.appendChild(body);
    el.appendChild(lbl);
  }
  for (const b of coderBackends) {
    const installed = Boolean(b.install?.installed);
    const lbl = document.createElement("label");
    lbl.className = "opt";
    lbl.dataset.coder = b.id;
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "coder";
    radio.value = b.id;
    radio.addEventListener("change", () => selectCoder(b.id));
    const body = document.createElement("div");
    body.className = "opt-body";
    const title = document.createElement("div");
    title.className = "opt-title";
    title.textContent = b.displayName || b.id;
    const desc = document.createElement("div");
    desc.className = "opt-desc";
    desc.textContent = installed
      ? b.description || ""
      : `${b.description || ""} — not detected; selectable, but install & log in first.`;
    body.appendChild(title);
    body.appendChild(desc);
    lbl.appendChild(radio);
    lbl.appendChild(body);
    el.appendChild(lbl);
  }
  syncCoderPick();
}

function selectCoder(id) {
  selectedCoder = id;
  const radio = document.querySelector(`#coder-pick input[name="coder"][value="${id}"]`);
  if (radio) radio.checked = true;
  syncCoderPick();
}

function syncCoderPick() {
  for (const lbl of document.querySelectorAll("#coder-pick .opt")) {
    lbl.classList.toggle("sel", lbl.dataset.coder === selectedCoder);
  }
}

// ── Step 4: gateway-chat provider → model + key ──────────────────
async function loadProviders(force = false) {
  if (providersLoaded && !force) return;
  const provSel = document.getElementById("gw-provider");
  let res;
  try {
    res = await api.listProviders();
  } catch (err) {
    if (provSel) provSel.innerHTML = `<option>Error: ${err.message}</option>`;
    return;
  }
  if (!res?.ok || !(res.providers || []).length) {
    if (provSel) provSel.innerHTML = `<option>${res?.error || "No providers found"}</option>`;
    return;
  }
  providers = res.providers;
  providersLoaded = true;
  // Populate provider <select>.
  provSel.innerHTML = "";
  for (const p of providers) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.label || p.id;
    provSel.appendChild(opt);
  }
  // Default provider = anthropic if present, else first.
  const defaultProvider = providers.find((p) => p.id === "anthropic") || providers[0];
  provSel.value = defaultProvider.id;
  provSel.onchange = () => onProviderChange();
  document.getElementById("gw-key")?.addEventListener("input", scheduleGwProbe);
  onProviderChange(true);
}

function currentProvider() {
  const id = document.getElementById("gw-provider")?.value;
  return providers.find((p) => p.id === id) || null;
}

function onProviderChange(initial = false) {
  const p = currentProvider();
  const modelSel = document.getElementById("gw-model");
  if (!p || !modelSel) return;
  modelSel.innerHTML = "";
  for (const m of p.models || []) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.name || m.id;
    modelSel.appendChild(opt);
  }
  // Default model = cheapest current Sonnet for anthropic, else first model.
  let pick = (p.models || [])[0]?.id;
  if (p.id === "anthropic") {
    const sonnets = (p.models || []).filter((m) => /sonnet/i.test(m.id));
    const best = sonnets.find((m) => /sonnet-4-5$/.test(m.id)) || sonnets[sonnets.length - 1];
    if (best) pick = best.id;
  }
  if (pick) modelSel.value = pick;
  // Toggle the key field by whether this provider takes a non-interactive key.
  const keyField = document.getElementById("gw-key-field");
  const noKeyNote = document.getElementById("gw-nokey-note");
  if (keyField) keyField.style.display = p.needsKey ? "block" : "none";
  if (noKeyNote) noKeyNote.style.display = p.needsKey ? "none" : "block";
  if (!initial) {
    const k = document.getElementById("gw-key");
    if (k) k.value = "";
    const st = document.getElementById("gw-key-state");
    if (st) { st.textContent = ""; st.className = "key-state"; }
  }
}

// Inline (no-network) format validation of the gateway-chat key.
let gwProbeTimer = null;
function scheduleGwProbe() {
  clearTimeout(gwProbeTimer);
  gwProbeTimer = setTimeout(probeGwKey, 250);
}
async function probeGwKey() {
  const p = currentProvider();
  const stateEl = document.getElementById("gw-key-state");
  if (!p || !stateEl) return;
  const raw = val("gw-key");
  if (!raw || !p.probeField) {
    stateEl.textContent = "";
    stateEl.className = "key-state";
    return;
  }
  try {
    const res = await api.probeKeys({ [p.probeField]: raw });
    const ok = res?.results?.[p.probeField];
    stateEl.textContent = ok ? "✓ looks valid" : "✗ unexpected format";
    stateEl.className = `key-state ${ok ? "ok" : "bad"}`;
  } catch {
    stateEl.textContent = "";
    stateEl.className = "key-state";
  }
}

// ── Step 5: live "Fetch models" for the chat provider ────────────
function setModelsState(msg, kind = "") {
  const el = document.getElementById("gw-models-state");
  if (!el) return;
  el.textContent = msg || "";
  el.className = `key-state ${kind}`;
}

document.getElementById("gw-fetch-models")?.addEventListener("click", async () => {
  const p = currentProvider();
  const btn = document.getElementById("gw-fetch-models");
  if (!p) return;
  if (!api.fetchModels) { setModelsState("Fetch isn't available in this build.", "bad"); return; }
  const params = { provider: p.id };
  if (p.id === "ollama") {
    params.endpoint = "http://localhost:11434";
  } else if (p.needsKey) {
    const key = val("gw-key");
    if (!key) { setModelsState("Enter the API key above first, then fetch.", "bad"); return; }
    params.apiKey = key;
  }
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = "Fetching…";
  setModelsState("Fetching the provider's model list…");
  try {
    const res = await api.fetchModels(params);
    if (!res?.ok) { setModelsState(res?.error || "Couldn't fetch models.", "bad"); return; }
    const models = res.models || [];
    if (!models.length) { setModelsState("Provider returned no models.", "bad"); return; }
    // Persist onto the provider object so onProviderChange() keeps them.
    p.models = models;
    const modelSel = document.getElementById("gw-model");
    if (modelSel) {
      modelSel.innerHTML = "";
      for (const m of models) {
        const opt = document.createElement("option");
        opt.value = m.id;
        opt.textContent = m.label || m.name || m.id;
        modelSel.appendChild(opt);
      }
      modelSel.value = models[0].id;
    }
    setModelsState(`Loaded ${models.length} model${models.length === 1 ? "" : "s"}.`, "ok");
  } catch (err) {
    setModelsState(`Fetch failed: ${err?.message || err}`, "bad");
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
});

// Clipboard helper for the login-command copy buttons.
async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const orig = btn.textContent;
    btn.textContent = "Copied!";
    setTimeout(() => { btn.textContent = orig; }, 1200);
  } catch {
    btn.textContent = "Copy failed";
  }
}

// ── Step 2: Gateway access (password / token / none + bind) ──────
// The gateway only enforces token|password (src/gateway/auth.ts). "None" is a
// local-only convenience: we record the user's intent and let onboard fall back
// to its default (auto-token + loopback bind) so the gateway still boots and the
// Electron app holds the credential — nothing on the wire is exposed beyond
// localhost. Password/token are written verbatim via the onboard --gateway-* flags.
function currentGwAuth() {
  return document.querySelector('input[name="gwauth"]:checked')?.value || "password";
}
function syncGwAuthUi() {
  const mode = currentGwAuth();
  for (const lbl of document.querySelectorAll('#gw-auth-pick .opt')) {
    lbl.classList.toggle("sel", lbl.dataset.gwauth === mode);
  }
  document.getElementById("gw-pw-block")?.classList.toggle("show", mode === "password");
  document.getElementById("gw-token-block")?.classList.toggle("show", mode === "token");
  document.getElementById("gw-none-block")?.classList.toggle("show", mode === "none");
}
for (const r of document.querySelectorAll('input[name="gwauth"]')) {
  r.addEventListener("change", () => { syncGwAuthUi(); clearGwAuthError(); });
}
// Password show/hide toggle (covers both password fields).
document.getElementById("gw-pw-toggle")?.addEventListener("click", () => {
  const a = document.getElementById("gw-pw");
  const b = document.getElementById("gw-pw2");
  const showing = a?.type === "text";
  const next = showing ? "password" : "text";
  if (a) a.type = next;
  if (b) b.type = next;
  const btn = document.getElementById("gw-pw-toggle");
  if (btn) btn.textContent = showing ? "Show" : "Hide";
});
// Token "Generate": 32-char crypto-random hex (16 bytes) in the renderer.
document.getElementById("gw-token-gen")?.addEventListener("click", () => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const inp = document.getElementById("gw-token");
  if (inp) inp.value = hex;
  clearGwAuthError();
});
// Expert bind toggle.
document.getElementById("gw-bind-expert")?.addEventListener("change", (e) => {
  document.getElementById("gw-bind-block")?.classList.toggle("show", e.target.checked);
});
// Live password-match hint.
function syncGwPwState() {
  const st = document.getElementById("gw-pw-state");
  if (!st) return;
  const a = val("gw-pw");
  const b = val("gw-pw2");
  if (!a && !b) { st.textContent = ""; st.className = "key-state"; return; }
  if (a.length < 6) { st.textContent = "Password must be at least 6 characters."; st.className = "key-state bad"; return; }
  if (a !== b) { st.textContent = "Passwords don't match."; st.className = "key-state bad"; return; }
  st.textContent = "✓ passwords match"; st.className = "key-state ok";
}
for (const id of ["gw-pw", "gw-pw2"]) {
  document.getElementById(id)?.addEventListener("input", () => { syncGwPwState(); clearGwAuthError(); });
}
function showGwAuthError(msg) {
  // Reuse the password state line as the inline error sink for this step.
  const st = document.getElementById("gw-pw-state");
  if (st) { st.textContent = msg; st.className = "key-state bad"; }
}
function clearGwAuthError() { /* state line is recomputed by syncGwPwState */ }

// Validate the gateway-access step before advancing.
function validateGatewayStep() {
  const mode = currentGwAuth();
  if (mode === "password") {
    const a = val("gw-pw");
    const b = val("gw-pw2");
    if (a.length < 6) { showGwAuthError("Password must be at least 6 characters."); return false; }
    if (a !== b) { showGwAuthError("Passwords don't match."); return false; }
  } else if (mode === "token") {
    if (!val("gw-token")) { showGwAuthError("Enter or generate a token."); return false; }
  }
  return true;
}
document.getElementById("gw-auth-next")?.addEventListener("click", () => {
  if (validateGatewayStep()) gotoStep(3);
});
syncGwAuthUi();

// ── Step 7: multi-channel opt-in cards ───────────────────────────
// One card per CHAT_CHANNEL_ORDER entry. Field shapes mirror what the
// channels-cli accepts (src/cli/channels-cli.ts) — hardcoded here so the
// renderer never imports gateway code. Docs URLs mirror CHAT_CHANNEL_META.docsPath
// (src/channels/registry.ts) against infinibotos.com/docs.
const DOCS_BASE = "https://infinibotos.com/docs";
// field: { key, label, type, placeholder, required, hint, options? }
const CHANNELS = [
  {
    id: "telegram", name: "Telegram", docs: `${DOCS_BASE}/channels/telegram`,
    fields: [
      { key: "botToken", label: "Bot token", type: "password", placeholder: "123456:ABC-DEF…", required: true, hint: "From @BotFather → /newbot." },
      { key: "chatId", label: "Default chat id (optional)", type: "text", placeholder: "123456789", hint: "Where proactive notifications are sent. Leave blank to set later." },
    ],
  },
  {
    id: "whatsapp", name: "WhatsApp", docs: `${DOCS_BASE}/channels/whatsapp`,
    note: "Linking uses QR pairing inside the gateway UI after launch — this just enables the channel.",
    fields: [
      { key: "authDir", label: "Auth dir override (optional)", type: "text", placeholder: "~/.infinibot/whatsapp", hint: "Where WhatsApp session data is stored. Leave blank for the default." },
    ],
  },
  {
    id: "discord", name: "Discord", docs: `${DOCS_BASE}/channels/discord`,
    fields: [
      { key: "botToken", label: "Bot token", type: "password", placeholder: "Discord bot token", required: true, hint: "From the Discord Developer Portal → Bot." },
      { key: "guildId", label: "Guild id (optional)", type: "text", placeholder: "server id", hint: "Restrict to a single server. Leave blank to auto-discover." },
    ],
  },
  {
    id: "googlechat", name: "Google Chat", docs: `${DOCS_BASE}/channels/googlechat`,
    fields: [
      { key: "webhookUrl", label: "Webhook URL", type: "url", placeholder: "https://chat.googleapis.com/…", required: true, hint: "Google Workspace Chat app webhook." },
      { key: "audienceType", label: "Audience type", type: "select", options: [["app-url", "App URL"], ["project-number", "Project number"]] },
      { key: "audience", label: "Audience value", type: "text", placeholder: "app URL or project number" },
    ],
  },
  {
    id: "slack", name: "Slack", docs: `${DOCS_BASE}/channels/slack`,
    fields: [
      { key: "botToken", label: "Bot token (xoxb-…)", type: "password", placeholder: "xoxb-…", required: true, hint: "Slack app OAuth bot token." },
      { key: "appToken", label: "App token (xapp-…)", type: "password", placeholder: "xapp-…", required: true, hint: "Socket Mode app-level token." },
    ],
  },
  {
    id: "signal", name: "Signal", docs: `${DOCS_BASE}/channels/signal`,
    fields: [
      { key: "signalNumber", label: "Signal number (E.164)", type: "text", placeholder: "+15555550123", required: true, hint: "The linked Signal account number." },
      { key: "cliPath", label: "signal-cli path (optional)", type: "text", placeholder: "auto-detect", hint: "Leave blank to detect signal-cli on PATH." },
    ],
  },
  {
    id: "imessage", name: "iMessage", docs: `${DOCS_BASE}/channels/imessage`,
    fields: [
      { key: "dbPath", label: "iMessage DB path (optional)", type: "text", placeholder: "~/Library/Messages/chat.db", hint: "Defaults to the standard macOS path." },
      { key: "service", label: "Service", type: "select", options: [["auto", "Auto"], ["imessage", "iMessage"], ["sms", "SMS"]] },
      { key: "region", label: "Region (for SMS)", type: "text", placeholder: "US" },
    ],
  },
];

let channelsRendered = false;
function renderChannelCards() {
  if (channelsRendered) return;
  const host = document.getElementById("chan-list");
  if (!host) return;
  host.innerHTML = "";
  for (const ch of CHANNELS) {
    const card = document.createElement("div");
    card.className = "chan-card";
    card.dataset.channel = ch.id;

    const head = document.createElement("div");
    head.className = "chan-head";
    const sw = document.createElement("label");
    sw.className = "switch";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.dataset.channelToggle = ch.id;
    const slider = document.createElement("span");
    slider.className = "slider";
    sw.appendChild(cb);
    sw.appendChild(slider);
    const name = document.createElement("span");
    name.className = "chan-name";
    name.textContent = ch.name;
    const docs = document.createElement("a");
    docs.className = "chan-docs";
    docs.textContent = "Get docs →";
    docs.href = ch.docs;
    docs.target = "_blank";
    docs.rel = "noopener";
    head.appendChild(sw);
    head.appendChild(name);
    head.appendChild(docs);

    const fields = document.createElement("div");
    fields.className = "chan-fields";
    if (ch.note) {
      const note = document.createElement("div");
      note.className = "note-box";
      note.style.marginBottom = "12px";
      note.textContent = ch.note;
      fields.appendChild(note);
    }
    for (const f of ch.fields) {
      const field = document.createElement("div");
      field.className = "field";
      const lbl = document.createElement("label");
      lbl.innerHTML = f.required ? `${f.label} <span style="color:var(--error)">*</span>` : f.label;
      field.appendChild(lbl);
      let input;
      if (f.type === "select") {
        input = document.createElement("select");
        for (const [v, t] of f.options) {
          const opt = document.createElement("option");
          opt.value = v;
          opt.textContent = t;
          input.appendChild(opt);
        }
      } else {
        input = document.createElement("input");
        input.type = f.type === "password" ? "password" : (f.type === "url" ? "url" : "text");
        if (f.placeholder) input.placeholder = f.placeholder;
      }
      input.dataset.channelField = `${ch.id}.${f.key}`;
      field.appendChild(input);
      if (f.hint) {
        const hint = document.createElement("div");
        hint.className = "hint";
        hint.textContent = f.hint;
        field.appendChild(hint);
      }
      fields.appendChild(field);
    }
    const err = document.createElement("div");
    err.className = "chan-err";
    err.dataset.channelErr = ch.id;
    fields.appendChild(err);

    cb.addEventListener("change", () => {
      card.classList.toggle("on", cb.checked);
      if (!cb.checked) err.classList.remove("show");
    });

    card.appendChild(head);
    card.appendChild(fields);
    host.appendChild(card);
  }
  channelsRendered = true;
}

function channelFieldVal(channelId, key) {
  const el = document.querySelector(`[data-channel-field="${channelId}.${key}"]`);
  return (el?.value ?? "").trim();
}
function channelEnabled(channelId) {
  return Boolean(document.querySelector(`[data-channel-toggle="${channelId}"]`)?.checked);
}
function setAllChannelsOff() {
  for (const cb of document.querySelectorAll("[data-channel-toggle]")) {
    if (cb.checked) { cb.checked = false; cb.dispatchEvent(new Event("change")); }
  }
}

// Collect enabled channels into { <id>: { <field>: value } }. Empty strings dropped.
function collectChannels() {
  const out = {};
  for (const ch of CHANNELS) {
    if (!channelEnabled(ch.id)) continue;
    const entry = { enabled: true };
    for (const f of ch.fields) {
      const v = channelFieldVal(ch.id, f.key);
      if (v) entry[f.key] = v;
    }
    out[ch.id] = entry;
  }
  return out;
}

// Validate required fields on every enabled channel. Shows inline errors and
// returns the first failure (or null when all good).
function validateChannels() {
  let firstBad = null;
  for (const ch of CHANNELS) {
    const errEl = document.querySelector(`[data-channel-err="${ch.id}"]`);
    if (errEl) errEl.classList.remove("show");
    if (!channelEnabled(ch.id)) continue;
    const missing = ch.fields.filter((f) => f.required && !channelFieldVal(ch.id, f.key));
    if (missing.length) {
      const msg = `${ch.name} needs: ${missing.map((f) => f.label).join(", ")}.`;
      if (errEl) { errEl.textContent = msg; errEl.classList.add("show"); }
      if (!firstBad) firstBad = msg;
    }
  }
  return firstBad;
}
document.getElementById("channels-next")?.addEventListener("click", () => {
  const bad = validateChannels();
  if (bad) return;
  gotoStep(8);
});

// Step navigation buttons
for (const btn of document.querySelectorAll("#panel-local [data-next]")) {
  btn.addEventListener("click", () => gotoStep(Number(btn.dataset.next)));
}
for (const btn of document.querySelectorAll("#panel-local [data-back]")) {
  btn.addEventListener("click", () => gotoStep(Number(btn.dataset.back)));
}

document.getElementById("coder-recheck")?.addEventListener("click", () => loadCoderBackends(true));

// ── Step 8: Notion sync (optional, mirrors the quickstart Notion step) ──
let notionVerified = false;
let notionIntegrationName = null;

function notionState(msg, kind = "") {
  const el = document.getElementById("notion-state");
  if (!el) return;
  el.textContent = msg || "";
  el.className = `key-state ${kind}`;
}

function renderNotionStep() {
  // Reflect any prior verification so returning to the step keeps it expanded.
  const block = document.getElementById("notion-config-block");
  if (block) block.classList.toggle("show", notionVerified);
}

document.getElementById("notion-verify")?.addEventListener("click", async () => {
  const token = val("notion-token");
  const btn = document.getElementById("notion-verify");
  if (!token) { notionState("Paste your Notion integration token first.", "bad"); return; }
  if (!api.notionVerify) { notionState("Notion verify isn't available in this build.", "bad"); return; }
  btn.disabled = true; const orig = btn.textContent; btn.textContent = "Verifying…";
  notionState("Verifying token with Notion…");
  try {
    const res = await api.notionVerify({ token });
    if (!res?.ok) {
      notionVerified = false;
      notionState(res?.error || "Verification failed.", "bad");
    } else {
      notionVerified = true;
      notionIntegrationName = res.integrationName || null;
      const ws = res.workspace ? ` · ${res.workspace}` : "";
      notionState(`✓ Connected as "${res.integrationName || "integration"}"${ws}.`, "ok");
      document.getElementById("notion-config-block")?.classList.add("show");
    }
  } catch (err) {
    notionVerified = false;
    notionState(`Verification failed: ${err?.message || err}`, "bad");
  } finally {
    btn.disabled = false; btn.textContent = orig;
  }
});

document.getElementById("notion-load-pages")?.addEventListener("click", async () => {
  const token = val("notion-token");
  const btn = document.getElementById("notion-load-pages");
  const sel = document.getElementById("notion-parent");
  if (!token) { notionState("Verify your token first.", "bad"); return; }
  if (!api.notionPages || !sel) return;
  btn.disabled = true; const orig = btn.textContent; btn.textContent = "Loading…";
  try {
    const res = await api.notionPages({ token });
    if (!res?.ok) { notionState(res?.error || "Couldn't load pages.", "bad"); return; }
    const pages = res.pages || [];
    sel.innerHTML = `<option value="">— none (choose later) —</option>`;
    for (const pg of pages) {
      const opt = document.createElement("option");
      opt.value = pg.id;
      opt.textContent = pg.title || "(untitled)";
      sel.appendChild(opt);
    }
    notionState(
      pages.length
        ? `Loaded ${pages.length} page${pages.length === 1 ? "" : "s"}. Pick a parent.`
        : "No shared pages found — share a page with the integration in Notion, then reload.",
      pages.length ? "ok" : "bad",
    );
  } catch (err) {
    notionState(`Couldn't load pages: ${err?.message || err}`, "bad");
  } finally {
    btn.disabled = false; btn.textContent = orig;
  }
});

document.getElementById("notion-next")?.addEventListener("click", () => gotoStep(9));
document.getElementById("import-pick")?.addEventListener("click", async () => {
  const r = await window.api?.pickFolder?.({ title: "Choose your Obsidian vault folder" });
  if (r && !r.canceled && r.path) {
    const el = document.getElementById("import-vault");
    if (el) el.value = r.path;
  }
});
document.getElementById("notion-skip")?.addEventListener("click", () => {
  const t = document.getElementById("notion-token");
  if (t) t.value = "";
  notionVerified = false;
  notionIntegrationName = null;
  gotoStep(9);
});

// "Quick setup" — skip Robovoice linking, channels & Notion, jump to the
// summary (Step 9).
function quickSetup() {
  const v = document.getElementById("voice-connect-robovoice");
  if (v) v.checked = false;
  renderChannelCards();
  setAllChannelsOff();
  gotoStep(9);
}
for (const b of document.querySelectorAll("#panel-local #quick-setup, #panel-local .quick-jump")) {
  b.addEventListener("click", quickSetup);
}

function collectOpts() {
  const p = currentProvider();
  // Gateway ACCESS auth (Step 2) — how the gateway protects itself. Distinct
  // from `chat` below, which is the in-app chat provider. main.js maps this to
  // the onboard --gateway-* flags.
  const gwMode = currentGwAuth();
  const gateway = { auth: gwMode };
  if (gwMode === "password") gateway.password = val("gw-pw") || undefined;
  if (gwMode === "token") gateway.token = val("gw-token") || undefined;
  const bind = val("gw-bind") || "127.0.0.1";
  if (bind && bind !== "127.0.0.1") gateway.bind = bind;
  return {
    workspace: val("local-workspace") || undefined,
    coderBackend: selectedCoder || undefined,
    gateway,
    // In-app chat provider/model/key (Step 5).
    chat: {
      provider: p?.id,
      model: document.getElementById("gw-model")?.value || undefined,
      apiKey: p?.needsKey ? (val("gw-key") || undefined) : undefined,
    },
    // Voice runs on Robovoice (Step 6). Nothing is installed or configured
    // locally — the only choice is whether to open the Voice page (the
    // Robovoice console) after launch so the user can link it.
    voice: { connectRobovoice: checked("voice-connect-robovoice") },
    // Multi-channel opt-in (Step 7): { <channelId>: { enabled, ...fields } }.
    channels: collectChannels(),
    // Notion sync (Step 8, optional). Undefined when no token entered.
    // Obsidian vault import (optional) — queued, started after the gateway boots.
    importNotes: (() => {
      const v = val("import-vault");
      if (!v) return undefined;
      const createTasks = checked("import-tasks");
      return /^https:\/\//i.test(v) ? { source: "git", url: v, createTasks } : { source: "folder", path: v, createTasks };
    })(),
    notion: (() => {
      const token = val("notion-token");
      if (!token) return undefined;
      return {
        token,
        syncMode: document.getElementById("notion-sync-mode")?.value || "mirror",
        parentPageId: document.getElementById("notion-parent")?.value || undefined,
        integrationName: notionIntegrationName || undefined,
      };
    })(),
  };
}

function coderLabel(id) {
  return coderBackends.find((b) => b.id === id)?.displayName || id || "—";
}

function channelName(id) {
  return CHANNELS.find((c) => c.id === id)?.name || id;
}

function updateSummary() {
  const o = collectOpts();

  // Plan row (top) — reflects the Step 0 license state.
  const sumPlan = document.getElementById("sum-plan");
  if (sumPlan) {
    const st = lic?.getState ? lic.getState() : null;
    let txt = "Free (not signed in)";
    if (isSelfHosted(st)) txt = "Self-hosted";
    else if (st) {
      const isPaid = st.plan && st.plan !== "free";
      if (st.guest) txt = "Free (guest)";
      else if (isPaid) txt = `${PLAN_LABELS[st.plan] || st.plan} ✓`;
      else if (st.signedIn) txt = "Free (signed-in)";
    }
    sumPlan.textContent = txt;
  }

  document.getElementById("sum-workspace").textContent =
    o.workspace || "default (~/infinibot)";

  // Gateway access row.
  const sumGw = document.getElementById("sum-gateway");
  if (sumGw) {
    let txt;
    if (o.gateway.auth === "password") txt = "Password set";
    else if (o.gateway.auth === "token") {
      const t = o.gateway.token || "";
      txt = t ? `Token: ${t.slice(0, 8)}…` : "Token (not generated)";
    } else txt = "Open (no auth)";
    if (o.gateway.bind && o.gateway.bind !== "127.0.0.1") txt += ` · bind ${o.gateway.bind}`;
    sumGw.textContent = txt;
  }

  document.getElementById("sum-coder").textContent = coderLabel(o.coderBackend);
  document.getElementById("sum-chat").textContent = o.chat.provider
    ? `${o.chat.provider} / ${o.chat.model || "—"}`
    : "—";
  const sumVoice = document.getElementById("sum-voice");
  if (sumVoice) {
    sumVoice.textContent = o.voice.connectRobovoice ? "Robovoice — link after setup" : "Skipped";
  }

  // Channels — "On (N)" with a chip cluster of enabled ids when >1.
  const sumCh = document.getElementById("sum-channels");
  if (sumCh) {
    const ids = Object.keys(o.channels);
    sumCh.innerHTML = "";
    if (!ids.length) {
      sumCh.textContent = "None";
    } else if (ids.length === 1) {
      sumCh.textContent = channelName(ids[0]);
    } else {
      sumCh.append(`On (${ids.length})`);
      const cluster = document.createElement("span");
      cluster.className = "chan-chips";
      for (const id of ids) {
        const chip = document.createElement("span");
        chip.className = "chip";
        chip.textContent = id;
        cluster.appendChild(chip);
      }
      sumCh.appendChild(cluster);
    }
  }

  // Notion row.
  const sumImport = document.getElementById("sum-import");
  if (sumImport) sumImport.textContent = o.importNotes ? `Obsidian · ${o.importNotes.url || o.importNotes.path}${o.importNotes.createTasks ? " · tasks" : ""}` : "None";
  const sumNotion = document.getElementById("sum-notion");
  if (sumNotion) {
    if (!o.notion) {
      sumNotion.textContent = "Not connected";
    } else {
      sumNotion.textContent = `${notionVerified ? "Connected" : "Token set"} · ${o.notion.syncMode}`;
    }
  }
}

document.getElementById("local-go").addEventListener("click", async () => {
  const opts = collectOpts();
  if (!validateGatewayStep()) {
    log("local-log", "Finish the gateway access step (Step 2).", "err");
    gotoStep(2);
    return;
  }
  if (!opts.coderBackend) {
    // A default coder is optional — InfiniBot can launch without one and the
    // user can pick a CLI agent later in Settings. Note it and continue.
    log("local-log", "No default coder selected — launching without one (you can set it later in Settings).", "warn");
  }
  const p = currentProvider();
  if (p?.needsKey && !opts.chat.apiKey) {
    log("local-log", `The "${p.id}" chat provider needs an API key (Step 5).`, "err");
    gotoStep(5);
    return;
  }
  const badChannel = validateChannels();
  if (badChannel) {
    log("local-log", `${badChannel} (Step 7).`, "err");
    gotoStep(7);
    return;
  }
  const btn = document.getElementById("local-go");
  btn.disabled = true;
  btn.textContent = "Initializing…";
  // Safety net: the gateway/onboard require a Vault device token. If it wasn't
  // established during sign-in (e.g. the user cancelled that window), run the
  // UI device login now rather than letting the gateway print "infinibot login".
  const va = await ensureVaultAuth();
  if (!va.ok && !va.skipped) {
    log("local-log", `InfiniBot sign-in is required to launch (${va.error || "device authorization cancelled"}). Re-run sign-in on Step 1.`, "err");
    btn.disabled = false;
    btn.textContent = "Initialize and Launch";
    gotoStep(0);
    return;
  }
  log("local-log", "Writing config and creating workspace…");
  const result = await api.setupLocal(opts);
  for (const line of result.lines ?? []) log("local-log", line);
  if (!result.ok) {
    if (result.alreadyConfigured) {
      log("local-log", "InfiniBot is already configured on this machine.", "warn");
    }
    log("local-log", `Setup failed: ${friendlyError(result.error)}`, "err");
    btn.disabled = false;
    btn.textContent = "Initialize and Launch";
    return;
  }
  log("local-log", "Setup complete. Starting local gateway…", "ok");
  await launchGateway("local-log");
});

// Developer-only "Reset for re-test" button (sandbox / unpacked only).
document.getElementById("local-reset")?.addEventListener("click", async () => {
  const r = await api.resetState();
  if (r?.ok) {
    log("local-log", `Reset OK — removed ${(r.removed || []).length} file(s). Re-run setup.`, "ok");
  } else {
    log("local-log", `Reset failed: ${r?.error || "unknown"}`, "err");
  }
});

// Initialize stepper view on load — start at the Account step (self-hosted
// notice + Continue by default; KinglyVault sign-in only for Vault-gated builds).
gotoStep(0);

// ── Satellite tile ─────────────────────────────────────────────
// "Connect to another InfiniBot" turns THIS computer into a federation node:
//   1. Redeem the invite: probe the master's addresses, write
//      federation.mode=satellite + the invite token into infinibot.json.
//   2. Boot the local satellite gateway. It registers with the master
//      (invite → durable device key), sends this device's capabilities and
//      keeps a heartbeat, so the master can open a terminal here, run
//      commands, take screenshots, browse files and spawn coders/sessions.
//   3. Wait until the master has actually accepted this device. Only then
//      show the master's UI (1:1) with a "This device" badge. Any failure is
//      shown in plain words — no "webpage-only" connection.
async function joinAsSatellite() {
  const invite = document.getElementById("sat-invite").value.trim();
  const name = document.getElementById("sat-name")?.value.trim() || "";
  const btn = document.getElementById("sat-join-go");
  const reset = () => {
    btn.disabled = false;
    btn.textContent = "Join with invite";
  };
  if (!invite) {
    log("sat-log", "Paste the invite code from the master first (Fleet › Share Invite).", "err");
    return;
  }
  btn.disabled = true;
  btn.textContent = "Checking invite…";
  log("sat-log", "Checking the invite and looking for the master…");
  const res = await api.joinFederation({ invite, name, force: true });
  for (const line of res.lines ?? []) log("sat-log", line);
  if (!res.ok) {
    log("sat-log", friendlyError(res.error), "err");
    reset();
    return;
  }
  btn.textContent = "Starting satellite…";
  log("sat-log", "Starting this computer's satellite service…", "ok");
  const gw = await api.startLocalGateway();
  if (!gw.ok) {
    for (const line of (gw.lines ?? []).slice(-8)) log("sat-log", line);
    log("sat-log", `The satellite service did not start: ${friendlyError(gw.error)}`, "err");
    reset();
    return;
  }
  btn.textContent = "Joining the master…";
  log("sat-log", `Registering "${res.name}" with the master…`);
  const joined = await window.satellite.waitConnected({ timeoutMs: 90_000 });
  if (!joined.ok) {
    log("sat-log", joined.error || "The master did not accept this device.", "err");
    log("sat-log", "The satellite keeps retrying in the background. Open Satellite status for details.", "warn");
    reset();
    btn.textContent = "Try again";
    await window.satellite.openStatus();
    return;
  }
  const st = joined.status?.status;
  log(
    "sat-log",
    `Connected. The master now lists this computer as "${st?.nodeName ?? res.name}"${typeof st?.latencyMs === "number" ? ` (${st.latencyMs} ms)` : ""}.`,
    "ok",
  );
  // This window becomes this computer's own InfiniBot (the satellite node the
  // master now drives); the master's screen is one click away in Satellite status.
  btn.textContent = "Opening InfiniBot…";
  await api.openGatewayUi(gw.url);
}

// Plain words for a failure (never a raw "ENOENT: no such file or directory,
// open …"). Main-process errors already arrive in plain words; this catches raw
// filesystem codes from older paths and from rejected IPC calls.
function friendlyError(err) {
  const msg = String(err?.message || err || "");
  const raw = msg.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, "");
  if (/\bENOENT\b/.test(raw)) {
    return "InfiniBot couldn't find or create its settings file on this computer. Check that your user folder is writable, then try again.";
  }
  if (/\b(EACCES|EPERM)\b/.test(raw)) {
    return "InfiniBot isn't allowed to save its settings on this computer. Check folder permissions or antivirus, then try again.";
  }
  if (/\bENOSPC\b/.test(raw)) return "The disk is full, so InfiniBot couldn't save its settings. Free up some space, then try again.";
  if (/\bEBUSY\b/.test(raw)) return "Another program is using InfiniBot's settings file. Close it, then try again.";
  return raw || "unknown error";
}

document.getElementById("sat-join-go")?.addEventListener("click", () => {
  joinAsSatellite().catch((err) => {
    log("sat-log", `Joining failed: ${friendlyError(err)}`, "err");
    const btn = document.getElementById("sat-join-go");
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Try again";
    }
  });
});

// ── Skip link ──────────────────────────────────────────────────
document.getElementById("skip-link").addEventListener("click", async (e) => {
  e.preventDefault();
  await api.openSatelliteUi();
});

async function launchGateway(logId) {
  const r = await api.startLocalGateway();
  for (const line of r.lines ?? []) log(logId, line);
  if (!r.ok) {
    log(logId, `Gateway failed to start: ${friendlyError(r.error)}`, "err");
    return;
  }
  log(logId, `Gateway ready at ${r.url}`, "ok");
  await api.openGatewayUi(r.url);
}

// Pre-fill workspace + name with sensible defaults from the platform.
(async () => {
  const defaults = await api.getDefaults();
  // Title-bar version comes from the packaged app, not a hardcoded string.
  if (defaults?.appVersion) {
    const v = document.querySelector(".titlebar-version");
    if (v) v.textContent = `v${defaults.appVersion}`;
  }
  if (defaults?.workspace) {
    document.getElementById("local-workspace").placeholder = defaults.workspace;
  }
  if (defaults?.hostname) {
    document.getElementById("sat-name").placeholder = defaults.hostname;
  }
  // Reveal the developer "Reset for re-test" button only for unpacked/dev or
  // when explicitly allowed (the main-process handler enforces the real guard).
  if (defaults?.canReset) {
    document.getElementById("local-reset")?.classList.add("show");
  }
})();

// ── First launch (?mode=firstrun) ──────────────────────────────
// One desktop screen (data folder → Get started). It writes a default config
// with `infinibot onboard --non-interactive` (no keys), boots the gateway and
// opens the control UI, whose Setup › Get started onboarding opens on its own
// for a brand-new install. Restore / satellite / Cloud switch to their panels.
const frLog = (msg) => {
  const el = document.getElementById("fr-log");
  if (!el || !msg) return;
  el.textContent += `${msg}\n`;
  el.scrollTop = el.scrollHeight;
};
function frBusy(on, status) {
  const go = document.getElementById("fr-go");
  const change = document.getElementById("fr-change");
  if (go) go.disabled = on;
  if (change) change.disabled = on;
  document.getElementById("fr-progress")?.classList.toggle("on", on);
  if (status) document.getElementById("fr-status").textContent = status;
}
function frError(msg) {
  const el = document.getElementById("fr-error");
  if (!el) return;
  el.textContent = msg || "";
  el.classList.toggle("on", Boolean(msg));
  document.getElementById("fr-log")?.classList.toggle("on", Boolean(msg));
}
async function frRefreshDir(info) {
  const d = info || (await api.getDefaults());
  const dir = document.getElementById("fr-dir");
  if (dir && d?.stateDir) dir.textContent = d.stateDir;
  const go = document.getElementById("fr-go");
  if (go) go.textContent = d?.configured ? "Open InfiniBot" : "Get started";
  const note = document.getElementById("fr-note");
  if (note && d?.configured) note.textContent = "This folder already holds an InfiniBot install. It opens as it is; nothing is reset.";
}
document.getElementById("fr-change")?.addEventListener("click", async () => {
  frError("");
  const r = await api.pickStateDir?.();
  if (r?.error) frError(r.error);
  if (r && !r.canceled) await frRefreshDir(r);
});
document.getElementById("fr-go")?.addEventListener("click", async () => {
  frError("");
  document.getElementById("fr-log").textContent = "";
  frBusy(true, "Setting up InfiniBot on this computer…");
  const setup = await api.firstRunSetup();
  for (const line of setup?.lines ?? []) frLog(line);
  if (!setup?.ok) {
    frBusy(false);
    frError(`Setup failed: ${friendlyError(setup?.error).replace(/\.?$/, ".")} Try again, or choose another data folder.`);
    return;
  }
  frBusy(true, "Starting your gateway…");
  const gw = await api.startLocalGateway();
  for (const line of gw?.lines ?? []) frLog(line);
  if (!gw?.ok) {
    frBusy(false);
    frError(`The gateway did not start: ${gw?.error || "unknown error"}.`);
    return;
  }
  frBusy(true, "Opening setup…");
  await api.openGatewayUi(gw.url);
});
for (const a of document.querySelectorAll(".fr-alt a[data-alt]")) {
  a.addEventListener("click", () => {
    document.body.removeAttribute("data-mode");
    selectMode(a.getAttribute("data-alt"));
  });
}
document.getElementById("fr-back")?.addEventListener("click", () => {
  document.body.setAttribute("data-mode", "firstrun");
});
if (document.body.getAttribute("data-mode") === "firstrun") void frRefreshDir();

// Default selection
selectMode("restore");

} // end double-load guard
