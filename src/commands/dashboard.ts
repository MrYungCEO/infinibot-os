import { readConfigFileSnapshot, resolveGatewayPort } from "../config/config.js";
import { copyToClipboard } from "../infra/clipboard.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import {
  detectBrowserOpenSupport,
  formatControlUiSshHint,
  openUrl,
  resolveControlUiLinks,
} from "./onboard-helpers.js";

type DashboardOptions = {
  noOpen?: boolean;
};

export async function dashboardCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: DashboardOptions = {},
) {
  const snapshot = await readConfigFileSnapshot();
  const cfg = snapshot.valid ? snapshot.config : {};
  const port = resolveGatewayPort(cfg);
  const bind = cfg.gateway?.bind ?? "loopback";
  const basePath = cfg.gateway?.controlUi?.basePath;
  const customBindHost = cfg.gateway?.customBindHost;
  const token = cfg.gateway?.auth?.token ?? process.env.INFINIBOT_GATEWAY_TOKEN ?? "";

  const links = resolveControlUiLinks({
    port,
    bind,
    customBindHost,
    basePath,
  });
  // resolveControlUiLinks returns the UI root (which resolves to the chat
  // tab in the SPA). The user-facing `infinibot dashboard` command should
  // land on the actual Dashboard page — append the /dashboard route and
  // keep the trailing slash if it was there as the base.
  const baseHttp = links.httpUrl.endsWith("/") ? links.httpUrl.slice(0, -1) : links.httpUrl;
  const dashboardUrl = `${baseHttp}/dashboard`;
  const authedUrl = token ? `${dashboardUrl}?token=${encodeURIComponent(token)}` : dashboardUrl;

  runtime.log(`Dashboard URL: ${authedUrl}`);

  const copied = await copyToClipboard(authedUrl).catch(() => false);
  runtime.log(copied ? "Copied to clipboard." : "Copy to clipboard unavailable.");

  let opened = false;
  let hint: string | undefined;
  if (!options.noOpen) {
    const browserSupport = await detectBrowserOpenSupport();
    if (browserSupport.ok) {
      opened = await openUrl(authedUrl);
    }
    if (!opened) {
      hint = formatControlUiSshHint({
        port,
        basePath,
        token: token || undefined,
      });
    }
  } else {
    hint = "Browser launch disabled (--no-open). Use the URL above.";
  }

  if (opened) {
    runtime.log("Opened in your browser. Keep that tab to control InfiniBot.");
  } else if (hint) {
    runtime.log(hint);
  }
}
