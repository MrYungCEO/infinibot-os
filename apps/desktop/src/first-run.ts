/**
 * First-run wizard renderer — runs in the sandboxed renderer process.
 * Uses window.firstRunBridge (exposed by preload.ts) to communicate
 * with the main process.
 *
 * The CLI wizard (infinibot quickstart) remains the fallback for headless
 * environments and satellite setups.
 */

export {};  // make this a module so `declare global` is valid

interface FirstRunBridge {
  complete: () => Promise<void>;
}

interface GatewayBridge {
  status: () => Promise<{ ready: boolean; running: boolean; port: number; url: string }>;
  onLog: (cb: (entry: { type: string; message: string }) => void) => () => void;
}

declare global {
  interface Window {
    firstRunBridge: FirstRunBridge;
    gatewayBridge: GatewayBridge;
  }
}

// ─── Step definitions ─────────────────────────────────────────────────────────

type StepId = "welcome" | "voice" | "provider" | "done";

const STEPS: { id: StepId; label: string }[] = [
  { id: "welcome", label: "Welcome" },
  { id: "voice", label: "Voice" },
  { id: "provider", label: "AI Provider" },
  { id: "done", label: "Launch" },
];

let currentStep: StepId = "welcome";

// ─── DOM helpers ──────────────────────────────────────────────────────────────

function $(sel: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(sel);
  if (!el) throw new Error(`Element not found: ${sel}`);
  return el;
}

function showStep(id: StepId): void {
  currentStep = id;
  document.querySelectorAll<HTMLElement>(".step-panel").forEach((panel) => {
    panel.style.display = panel.dataset.step === id ? "block" : "none";
  });
  document.querySelectorAll<HTMLElement>(".step-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.step === id);
  });
}

function appendLog(message: string, type: "info" | "error" | "warn" = "info"): void {
  const log = document.querySelector<HTMLElement>("#log");
  if (!log) return;
  const line = document.createElement("div");
  line.className = `log-line log-${type}`;
  line.textContent = message;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

// ─── Wizard logic ─────────────────────────────────────────────────────────────

async function handleDone(): Promise<void> {
  const btn = $("#btn-launch") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "Launching…";

  try {
    await window.firstRunBridge.complete();
    appendLog("Gateway starting…", "info");

    // Subscribe to gateway logs while we wait
    const unsub = window.gatewayBridge.onLog(({ type, message }) => {
      appendLog(message.trim(), type as "info" | "error" | "warn");
    });

    // Poll until gateway is ready, then the main process will navigate
    const deadline = Date.now() + 60_000;
    const poll = setInterval(async () => {
      const status = await window.gatewayBridge.status();
      if (status.ready) {
        clearInterval(poll);
        unsub();
        appendLog(`✓ Gateway ready at ${status.url}`, "info");
        // Main process will load the dashboard; show a brief message
        btn.textContent = "Opening Dashboard…";
      } else if (Date.now() > deadline) {
        clearInterval(poll);
        unsub();
        appendLog("Timed out waiting for gateway. Check logs.", "error");
        btn.disabled = false;
        btn.textContent = "Retry";
      }
    }, 800);
  } catch (err) {
    appendLog(`Error: ${err}`, "error");
    btn.disabled = false;
    btn.textContent = "Try Again";
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  // Build step nav
  const nav = document.querySelector<HTMLElement>("#step-nav");
  STEPS.forEach(({ id, label }) => {
    const item = document.createElement("div");
    item.className = "step-item";
    item.dataset.step = id;
    item.textContent = label;
    nav?.appendChild(item);
  });

  // Wire next/back buttons
  document.getElementById("btn-next-welcome")?.addEventListener("click", () => showStep("voice"));
  document.getElementById("btn-next-voice")?.addEventListener("click", () => showStep("provider"));
  document.getElementById("btn-next-provider")?.addEventListener("click", () => showStep("done"));
  document.getElementById("btn-back-voice")?.addEventListener("click", () => showStep("welcome"));
  document.getElementById("btn-back-provider")?.addEventListener("click", () => showStep("voice"));
  document.getElementById("btn-back-done")?.addEventListener("click", () => showStep("provider"));
  document.getElementById("btn-launch")?.addEventListener("click", () => void handleDone());

  showStep("welcome");
});
