/**
 * Plugin settings sections (`contributes.settings`, docs/plugins/SETTINGS-SECTIONS.md).
 *
 * A loaded plugin can add first-party settings UI to its Setup › Plugins
 * detail page, above the auto-generated config form. `builtin` names a
 * renderer compiled into the control UI (below); unknown builtins render
 * nothing, so a manifest can never inject markup. Renderers load lazily.
 */

import { html, nothing, type TemplateResult } from "lit";

import type { GatewayBrowserClient } from "../gateway.js";
import { derivePluginSettingsSections, type PluginListItem, type PluginSettingsSection } from "../plugin-host.js";

type SectionRenderer = (ctx: { client: GatewayBrowserClient | null; section: PluginSettingsSection }) => TemplateResult;

/** First-party settings renderers, keyed by the manifest's `builtin`. */
export const SETTINGS_SECTION_RENDERERS: Readonly<Record<string, SectionRenderer>> = {
  // Solatrix: agent access mode, trading limits, kill switch, audit log.
  "solatrix-agent-access": ({ client }) => {
    void import("../../../../extensions/solatrix/ui/agent-access.js");
    return html`<solatrix-agent-access .client=${client}></solatrix-agent-access>`;
  },
  // Solatrix: copy-trading alert rules, channels, quiet hours, digests.
  "solatrix-intel-alerts": ({ client }) => {
    void import("../../../../extensions/solatrix/ui/intel/alerts-settings.js");
    return html`<solatrix-intel-alerts .client=${client}></solatrix-intel-alerts>`;
  },
};

/** Every settings section of `plugin`, or nothing. */
export function renderPluginSettingsSections(
  plugin: PluginListItem | null | undefined,
  client: GatewayBrowserClient | null,
): TemplateResult | typeof nothing {
  const sections = derivePluginSettingsSections(plugin).filter((s) => SETTINGS_SECTION_RENDERERS[s.builtin]);
  if (!sections.length) return nothing;
  return html`${sections.map(
    (section) => html`<div class="pm-plugin-settings" data-settings-section=${section.key} data-plugin-scope=${section.pluginId} data-ib-target=${`plugin:${section.pluginId}/settings/${section.id}`}>
      ${SETTINGS_SECTION_RENDERERS[section.builtin]({ client, section })}
    </div>`,
  )}`;
}
