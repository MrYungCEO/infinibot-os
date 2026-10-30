/**
 * Entry for the local setup wizard (`infinibot quickstart`), built as
 * dist/control-ui/setup.html and served by the standalone setup server
 * (src/setup-ui/server.ts). It shares the hosted onboarding's console
 * (ui/onboarding/*) but none of the app shell, so it stays small.
 */
import "./styles/low-power.css";
import { html, render } from "lit";
import { applyLowPowerClass } from "./ui/perf";
import { renderSaasBootScreen, renderSaasSetupNotice } from "./ui/saas-terminal-ambient";
import {
  createHttpTransport,
  renderLocalSetup,
  type LocalSetupStatus,
} from "./ui/views/local-setup";

// Low-power devices and prefers-reduced-motion drop every animation; the
// console's resting styles are its final, readable state.
applyLowPowerClass();

/** The CLI puts the one-time token in the URL hash; keep it for reloads, drop it from history. */
function readToken(): string {
  try {
    const params = new URLSearchParams(location.hash.replace(/^#/, ""));
    const t = params.get("token");
    if (t) {
      sessionStorage.setItem("infinibot.setup.token", t);
      history.replaceState(null, "", location.pathname);
      return t;
    }
    return sessionStorage.getItem("infinibot.setup.token") ?? "";
  } catch {
    return "";
  }
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const root = document.getElementById("setup-root")!;
const fontLink = document.createElement("link");
fontLink.rel = "stylesheet";
fontLink.href =
  "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap";
document.head.appendChild(fontLink);

async function boot(): Promise<void> {
  render(renderSaasBootScreen(["Setup server reached", "Reading this machine's config", "Preparing the console"]), root);
  const token = readToken();
  const retry = () => location.reload();
  if (!token) {
    render(
      renderSaasSetupNotice({
        title: "Setup link incomplete",
        detail:
          "Open the full link printed by `infinibot quickstart` in your terminal (it ends with #token=…). Run it again for a fresh link.",
        testid: "ls-missing-token",
        actions: [{ label: "Reload", onClick: retry, primary: true }],
      }),
      root,
    );
    return;
  }
  const send = createHttpTransport(token);
  let status: LocalSetupStatus;
  try {
    status = await send<LocalSetupStatus>("setup.status");
  } catch (err) {
    render(
      renderSaasSetupNotice({
        title: "Can't reach the setup server",
        detail: `${String((err as Error)?.message ?? err)} Keep the terminal running \`infinibot quickstart\` open, or run it again.`,
        testid: "ls-unreachable",
        actions: [{ label: "Try again", onClick: retry, primary: true }],
      }),
      root,
    );
    return;
  }
  let queued = false;
  const draw = () => {
    queued = false;
    render(html`${renderLocalSetup({ send, status, requestUpdate, storage: storage() })}`, root);
  };
  function requestUpdate(): void {
    if (queued) return;
    queued = true;
    queueMicrotask(draw);
  }
  draw();
}

void boot();
