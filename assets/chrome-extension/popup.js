const state = document.getElementById("state");
const detail = document.getElementById("detail");
const dot = document.getElementById("dot");
const toggle = document.getElementById("toggle");
const pause = document.getElementById("pause");
const message = document.getElementById("message");

async function call(action, extra = {}) {
  return await chrome.runtime.sendMessage({ action, ...extra });
}

async function refresh() {
  const s = await call("status");
  dot.classList.toggle("on", s.connected && !s.paused);
  state.textContent = s.paused
    ? "Paused"
    : s.connected
      ? `Connected · ${s.profileName}`
      : s.paired
        ? "Reconnecting"
        : "Pairing required";
  detail.textContent = `${s.controlledTabs || 0} controlled tab${s.controlledTabs === 1 ? "" : "s"}`;
  pause.textContent = s.paused ? "Resume browser control" : "Pause all browser control";
  pause.dataset.paused = String(Boolean(s.paused));
  toggle.disabled = s.paused || !s.paired;
}

toggle.addEventListener("click", async () => {
  message.textContent = "Updating tab access…";
  const res = await call("toggle-active");
  message.textContent = res?.ok
    ? "Current tab access updated."
    : String(res?.error || "Could not update tab access.");
  await refresh();
});

pause.addEventListener("click", async () => {
  const paused = pause.dataset.paused !== "true";
  await call("set-paused", { paused });
  message.textContent = paused ? "All browser control paused." : "Browser control resumed.";
  await refresh();
});

document
  .getElementById("settings")
  .addEventListener("click", () => chrome.runtime.openOptionsPage());
void refresh();
