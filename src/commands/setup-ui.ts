/**
 * `infinibot setup-ui` — boots the standalone setup wizard.
 *
 * This is the GUI counterpart to `infinibot onboard` (the clack TUI). Both
 * write directly to `~/.infinibot/infinibot.json`. Neither requires a
 * running gateway, by design — the gateway can't be configured via a
 * service that doesn't have its own credentials yet, which was the source
 * of the chicken-and-egg auth bugs in the old `infinibot quickstart`.
 *
 * Lifecycle:
 *   1. Mint a one-shot token (random bytes, never persisted).
 *   2. Boot the standalone HTTP server on a loopback port.
 *   3. Open the user's default browser to the launch URL with the token
 *      in the hash, so the wizard auto-authenticates without a copy-paste.
 *   4. Wait for the wizard to call `quickstart.finalize` (or the user to
 *      close the terminal). Either resolves the server's `done` promise.
 *   5. Stop the server cleanly and return.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { startSetupUiServer } from "../setup-ui/server.js";
import { theme } from "../terminal/theme.js";

export interface SetupUiOptions {
  /** Skip the auto-open of the browser; print the URL instead. */
  noOpen?: boolean;
  /** Override the port. Default 18790. Pass 0 to let the OS pick. */
  port?: number;
}

const DEFAULT_PORT = 18790;

export async function setupUiCommand(opts: SetupUiOptions = {}): Promise<void> {
  const port = opts.port ?? DEFAULT_PORT;
  const token = randomBytes(24).toString("hex");

  console.log(theme.muted("Starting InfiniBot setup wizard…"));

  let server;
  try {
    server = await startSetupUiServer({
      port,
      token,
      log: (msg) => console.log(theme.muted(msg)),
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE") {
      console.error(
        theme.error(
          `Port ${port} is already in use. Pass --port <other> to pick a different port, or stop whatever's listening on ${port}.`,
        ),
      );
    } else {
      console.error(theme.error(`Failed to start setup-ui: ${(err as Error).message}`));
    }
    process.exitCode = 1;
    return;
  }

  console.log(theme.success("✓ Setup server is up."));
  for (const line of setupBanner(server.url, token, server.page)) console.log(line);

  const stopOnSignal = () => {
    void server.stop();
  };
  process.once("SIGINT", stopOnSignal);
  process.once("SIGTERM", stopOnSignal);

  if (!opts.noOpen) {
    // Give the OS a tick to settle the listener before nudging the browser
    // — on Windows, fast launches sometimes race the browser's first
    // request and produce a one-time "site can't be reached" flash.
    await delay(150);
    openBrowser(server.url);
  }

  await server.done;

  // Brief grace period so any in-flight finalize-write fsyncs before the
  // process exits and a follow-up `infinibot gateway run` reads the file.
  await delay(200);

  console.log(theme.success("✓ Setup complete. Run `infinibot gateway run` to start InfiniBot."));

  // Keep serving the finished screen until the wizard closes it (or a
  // couple of minutes pass), then release the port and let the CLI exit.
  await Promise.race([server.exited, delay(FINISHED_GRACE_MS)]);
  await server.stop();
  process.removeListener("SIGINT", stopOnSignal);
  process.removeListener("SIGTERM", stopOnSignal);
}

const FINISHED_GRACE_MS = 120_000;

/**
 * What the terminal shows. Works headless (SSH, containers, no browser): the
 * full URL carries the one-time token, which is also printed on its own for
 * pasting into a browser on another machine via a tunnel. The TUI path is
 * always offered as the fallback.
 */
export function setupBanner(
  url: string,
  token: string,
  page: "console" | "legacy" = "console",
): string[] {
  let port = "18790";
  try {
    port = new URL(url).port || port;
  } catch {
    /* keep the default */
  }
  return [
    `Open ${theme.accent(url)} to continue.`,
    theme.muted(`One-time setup token: ${token}`),
    theme.muted(
      `Headless? Forward the port (e.g. ssh -L ${port}:127.0.0.1:${port} <host>) and open the URL above locally.`,
    ),
    ...(page === "legacy"
      ? [
          theme.muted(
            "(The premium wizard isn't built in this install; serving the classic setup page.)",
          ),
        ]
      : []),
    theme.muted("Prefer the terminal? Press Ctrl+C and run `infinibot onboard` instead."),
    theme.muted("Leave this terminal open while you finish setup. Press Ctrl+C to stop."),
  ];
}

export function openBrowser(url: string): void {
  const platform = process.platform;
  const fallback = (reason: string) => {
    console.log(theme.muted(`Couldn't auto-open browser: ${reason}`));
    console.log(`Open this URL manually: ${url}`);
  };
  try {
    // The empty quoted title is required by cmd's `start` so the URL
    // isn't treated as the window title.
    const [cmd, args] =
      platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : platform === "darwin"
          ? ["open", [url]]
          : ["xdg-open", [url]];
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    // A missing opener (headless server, container, WSL without wslu) emits
    // ENOENT asynchronously; without this listener it crashes the CLI and
    // takes the setup server down with it.
    child.on("error", (err) => fallback(err.message));
    child.unref();
  } catch (err) {
    fallback((err as Error).message);
  }
}
