import { onSaasSessionEnd, saasSignOut } from "../saas-clerk";
import { appPath } from "./cloud-env";
import "./affiliate-dashboard";

export function runAffiliateBoot(): void {
  document.title = "InfiniBot Cloud — Affiliates";
  for (const el of document.querySelectorAll("infinibot-app, terminal-background")) el.remove();
  document.documentElement.style.setProperty("--ui-viewport-zoom", "1");
  const dashboard = document.createElement("ib-affiliate-dashboard");
  document.body.appendChild(dashboard);
  onSaasSessionEnd(() => { dashboard.remove(); void saasSignOut(); location.assign(appPath("/affiliates")); });
}
