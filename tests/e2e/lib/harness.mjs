/**
 * Shared browser harness for the agency e2e suites.
 *
 * Everything runs through a real Chromium driving the built control UI, because
 * the gateway rejects direct websocket RPC from Node (control-ui clients must
 * come from a secure context). Driving the page means every assertion goes over
 * the same socket, auth and handlers a human operator uses.
 *
 * Uses `playwright-core` against the already-installed browser — `@playwright/test`
 * is deliberately NOT a dependency of this repo.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

export const BASE_URL = process.env.VERIFY_UI_URL || "http://localhost:18789";
export const GATEWAY_URL = process.env.VERIFY_GATEWAY_URL || BASE_URL;

const CHROME =
  process.env.VERIFY_CHROME ||
  join(homedir(), "AppData", "Local", "ms-playwright", "chromium-1228", "chrome-win64", "chrome.exe");

/**
 * Console noise that is an artifact of the harness, not the app under test.
 * Headless Chromium denies microphone access, so the wake-word engine always
 * throws; and the browser's own favicon/devtools chatter is not app behaviour.
 */
const IGNORED_CONSOLE = [
  /WakeWord/i,
  /NotAllowedError/i,
  /Permission denied/i,
  /favicon/i,
  /Autoplay/i,
  /^ResizeObserver loop/i,
  // Chromium logs a generic, URL-less line for every failing subresource. The
  // `httpErrors` list below records the same failures WITH their URLs, so the
  // console copy would only duplicate them less usefully.
  /Failed to load resource/i,
];

export function isIgnorableConsoleError(text) {
  return IGNORED_CONSOLE.some((re) => re.test(text));
}

/**
 * Network failures that are not the app under test:
 *  - `/api/kokoro/*` is the OPTIONAL voice TTS sidecar; it 503s whenever that
 *    container is not running, which is a deployment condition, not a UI bug.
 *    (It is still surfaced — see `optionalServiceErrors`.)
 *  - Google Fonts is a third-party CDN and is blocked/offline in CI.
 */
const OPTIONAL_ENDPOINTS = [/\/api\/kokoro\//i, /fonts\.gstatic\.com/i, /fonts\.googleapis\.com/i];

export function isOptionalEndpoint(url) {
  return OPTIONAL_ENDPOINTS.some((re) => re.test(url));
}

/**
 * Read BOTH gateway secrets.
 *
 * `gateway.auth.mode` decides which one the server checks, and `verifyAuth`
 * treats token and password as mutually exclusive. Seeding only the token made
 * every check in this suite fail with "gateway not connected" the moment the
 * install switched to password mode. `sendConnect` sends both and lets the
 * server pick — the login form does the same — so either mode works.
 */
function readGatewayCredentials() {
  const path = join(homedir(), ".infinibot", "infinibot.json");
  try {
    const config = JSON.parse(readFileSync(path, "utf8"));
    const token = typeof config?.gateway?.auth?.token === "string" ? config.gateway.auth.token : "";
    const password =
      typeof config?.gateway?.auth?.password === "string" ? config.gateway.auth.password : "";
    if (!token && !password) throw new Error("neither gateway.auth.token nor .password is set");
    return { token, password };
  } catch (error) {
    throw new Error(
      `could not read the gateway credentials from ${path}: ${error?.message ?? error}. ` +
        "Start the gateway once so it writes its config, or set VERIFY_UI_URL to a reachable instance.",
    );
  }
}

/**
 * Launch Chromium, seed the control-UI auth blob, dismiss the profile gate and
 * wait until the app's gateway client has completed its handshake.
 *
 * Returns a session with helpers; always `await session.close()` in a `finally`.
 */
export async function openControlUi({ route = "/dashboard", viewport } = {}) {
  const { token, password } = readGatewayCredentials();
  const browser = await chromium.launch({ headless: true, executablePath: CHROME });
  const context = await browser.newContext({
    viewport: viewport ?? { width: 1440, height: 900 },
  });
  await context.addInitScript(
    ([key, value]) => {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        /* storage unavailable; the gate fallback handles it */
      }
    },
    [
      "infinibot.control.settings.v1",
      JSON.stringify({
        gatewayUrl: GATEWAY_URL.replace(/^http/, "ws"),
        token,
        password,
        sessionKey: "main",
        lastActiveSessionKey: "main",
      }),
    ],
  );

  const page = await context.newPage();
  /** Every console error / uncaught page error seen since the last reset. */
  const errors = [];
  /** Every HTTP response >= 400 seen since the last reset, WITH its URL. */
  const httpErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text().slice(0, 300));
  });
  page.on("pageerror", (err) => errors.push(`pageerror: ${String(err).slice(0, 300)}`));
  page.on("response", (res) => {
    if (res.status() >= 400) httpErrors.push(`HTTP ${res.status()} ${res.url()}`);
  });

  await page.goto(`${BASE_URL}${route}`, { waitUntil: "domcontentloaded", timeout: 90_000 });

  // A profile picker renders before the app mounts; nothing appears until it is
  // dismissed.
  try {
    const gate = page.getByRole("button", { name: /Continue as/i });
    await gate.waitFor({ state: "visible", timeout: 20_000 });
    await gate.click();
  } catch {
    /* already dismissed for this profile */
  }

  await page.waitForFunction(
    () => {
      const app = document.querySelector("infinibot-app");
      return Boolean(app && app.client);
    },
    { timeout: 90_000 },
  );

  /** Issue a gateway RPC through the page's own connected client. */
  const rpc = async (method, params = {}) =>
    page.evaluate(
      async ([m, p]) => {
        const app = document.querySelector("infinibot-app");
        try {
          return { ok: true, payload: await app.client.request(m, p) };
        } catch (error) {
          return { ok: false, error: String(error?.message ?? error) };
        }
      },
      [method, params],
    );

  /** RPC that throws on failure — for setup steps where a failure is fatal. */
  const rpcOrThrow = async (method, params = {}) => {
    const res = await rpc(method, params);
    if (!res.ok) throw new Error(`${method} failed: ${res.error}`);
    return res.payload;
  };

  return {
    browser,
    context,
    page,
    rpc,
    rpcOrThrow,
    errors,
    httpErrors,
    resetErrors: () => {
      errors.length = 0;
      httpErrors.length = 0;
    },
    /** App-relevant console errors only. */
    appErrors: () => [...new Set(errors)].filter((e) => !isIgnorableConsoleError(e)),
    /** Failed requests to endpoints the app genuinely depends on. */
    coreHttpErrors: () => [...new Set(httpErrors)].filter((e) => !isOptionalEndpoint(e)),
    /** Failed requests to optional sidecars — reported, never fatal. */
    optionalServiceErrors: () => [...new Set(httpErrors)].filter((e) => isOptionalEndpoint(e)),
    close: async () => {
      await browser.close().catch(() => {});
    },
  };
}

/** Navigate to a route and wait for the main content region to paint. */
export async function gotoRoute(session, route) {
  session.resetErrors();
  await session.page.goto(`${BASE_URL}${route}`, {
    waitUntil: "domcontentloaded",
    timeout: 90_000,
  });
  const main = session.page.locator("main.content").first();
  await main.waitFor({ state: "visible", timeout: 60_000 });
  return main;
}

/**
 * Poll the main region's text until `predicate` holds. Views stream their
 * panels in independently, so a single snapshot races whichever panel paints
 * last; polling is what makes these assertions non-flaky.
 */
export async function waitForContent(main, predicate, { timeout = 40_000, interval = 750 } = {}) {
  const deadline = Date.now() + timeout;
  let text = "";
  for (;;) {
    text = (await main.innerText()).replace(/\s+/g, " ").trim();
    if (predicate(text)) return { ok: true, text };
    if (Date.now() > deadline) return { ok: false, text };
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

/** Horizontal overflow of the document, in CSS pixels. */
export async function horizontalOverflowPx(page) {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
