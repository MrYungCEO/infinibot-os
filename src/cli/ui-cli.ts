/**
 * UI CLI — Control UI management
 *
 * `infinibot ui open` is the friendly entry point for users with an already
 * running gateway: it builds a launch URL that carries the gateway token (or
 * password) in the URL hash so the Control UI auto-authenticates without a
 * trip to the settings panel. The Control UI side of the contract lives in
 * `ui/src/ui/auth-hash.ts`.
 *
 * Hash (not query-string) is intentional: the gateway HTTP server never sees
 * the fragment, so the credential stays out of access logs, reverse-proxy
 * traces, and Referer headers when the user clicks an outbound link.
 */
import type { Command } from "commander";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../config/config.js";
import { normalizeControlUiBasePath } from "../gateway/control-ui-shared.js";
import {
  resolveAuthForLaunch,
  buildControlUiLaunchUrl,
  hasLaunchCredential,
  type GatewayAuthSnapshot,
} from "./control-ui-launch.js";

function resolveControlUiPort(opts: { port?: string }): number {
  if (opts.port) {
    const parsed = Number(opts.port);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  try {
    const cfg = loadConfig() as { gateway?: { port?: number } };
    if (typeof cfg?.gateway?.port === "number") return cfg.gateway.port;
  } catch {
    // ignore
  }
  return 18789;
}

function resolveControlUiBase(): string {
  try {
    const cfg = loadConfig() as { gateway?: { controlUi?: { basePath?: string } } };
    return normalizeControlUiBasePath(cfg?.gateway?.controlUi?.basePath);
  } catch {
    return "";
  }
}

/** `ui open` targets an already-running gateway whose bind host it can't
 *  observe, so it uses localhost — the common case. For non-loopback binds
 *  (e.g. tailnet) the gateway's own startup auto-open uses the real host. */
function buildLaunchUrl(opts: {
  port: number;
  basePath: string;
  auth: GatewayAuthSnapshot;
  onboarding: boolean;
}): string {
  return buildControlUiLaunchUrl({ host: "localhost", ...opts });
}

function openInBrowser(url: string): void {
  // spawn-with-array (rather than execSync) avoids shell-escaping the `&`
  // in `#token=a&password=b`, which the Windows `start` builtin and POSIX
  // shells would otherwise mangle.
  const platform = process.platform;
  const onError = (err: Error) => {
    console.error("Failed to open browser:", err.message);
    console.log(`Open this URL manually: ${url}`);
  };
  try {
    // `start` is a cmd builtin; the empty quoted title arg is required so
    // cmd doesn't treat the URL as the window title.
    const child =
      platform === "win32"
        ? spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true })
        : platform === "darwin"
          ? spawn("open", [url], { stdio: "ignore", detached: true })
          : spawn("xdg-open", [url], { stdio: "ignore", detached: true });
    // A missing opener arrives as an async 'error' event, not a throw.
    child.on("error", onError);
    child.unref();
  } catch (err) {
    onError(err as Error);
  }
}

export function registerUiCli(program: Command) {
  const ui = program.command("ui").description("Control UI management");

  ui.command("open")
    .description(
      "Open the Control UI in your default browser, auto-authenticating from your config",
    )
    .option("--onboarding", "Open in onboarding mode", false)
    .option("--port <port>", "Gateway port (default: from config or 18789)")
    .option("--print-url", "Print the URL instead of launching a browser", false)
    .action(async (opts) => {
      try {
        const port = resolveControlUiPort(opts);
        const basePath = resolveControlUiBase();
        const auth = resolveAuthForLaunch();
        const url = buildLaunchUrl({
          port,
          basePath,
          auth,
          onboarding: Boolean(opts.onboarding),
        });

        if (!hasLaunchCredential(auth)) {
          console.warn(
            `Warning: gateway auth mode is "${auth.mode}" but no ${auth.mode} is configured.\n` +
              `  Set gateway.auth.${auth.mode} in ~/.infinibot/infinibot.json, or export ` +
              `INFINIBOT_GATEWAY_${auth.mode.toUpperCase()}.`,
          );
        }

        if (opts.printUrl) {
          console.log(url);
          return;
        }

        console.log(`Opening Control UI: ${url.replace(/#.*$/, "#…")}`);
        openInBrowser(url);
      } catch (err) {
        console.error("Failed to open UI:", (err as Error).message);
        process.exit(1);
      }
    });

  ui.command("status")
    .description("Show UI status and URL")
    .option("--json", "Output as JSON", false)
    .option("--reveal", "Include the auth credential in the printed URL", false)
    .action(async (opts) => {
      try {
        const port = resolveControlUiPort({});
        const basePath = resolveControlUiBase();
        const auth = resolveAuthForLaunch();
        const url = `http://localhost:${port}${basePath || ""}/`;
        const launchUrl = buildLaunchUrl({ port, basePath, auth, onboarding: false });
        const hasCredential = hasLaunchCredential(auth);

        if (opts.json) {
          console.log(
            JSON.stringify(
              {
                url,
                launchUrl: opts.reveal && hasCredential ? launchUrl : undefined,
                port,
                basePath: basePath || "/",
                authMode: auth.mode,
                hasCredential,
              },
              null,
              2,
            ),
          );
        } else {
          console.log("Control UI Status");
          console.log("─".repeat(40));
          console.log(`URL:        ${url}`);
          console.log(`Auth mode:  ${auth.mode}`);
          console.log(`Configured: ${hasCredential ? "yes" : "no"}`);
          if (opts.reveal && hasCredential) {
            console.log(`Launch URL: ${launchUrl}`);
          } else if (hasCredential) {
            console.log(`Launch URL: ${url}#… (run with --reveal to print the credential)`);
          }
          console.log(`Port:       ${port}`);
        }
      } catch (err) {
        console.error("Failed to get UI status:", (err as Error).message);
        process.exit(1);
      }
    });

  ui.command("serve")
    .description("Serve the Control UI standalone (dev)")
    .option("--port <port>", "HTTP port", "5173")
    .action(async (opts) => {
      const uiDir = path.resolve(process.cwd(), "ui");
      if (!existsSync(uiDir)) {
        console.error("UI directory not found:", uiDir);
        process.exit(1);
      }

      console.log(`Starting UI dev server on port ${opts.port}...`);
      const proc = spawn("npm", ["run", "dev", "--", "--port", opts.port], {
        cwd: uiDir,
        stdio: "inherit",
        shell: true,
      });

      proc.on("exit", (code) => process.exit(code || 0));
    });
}
