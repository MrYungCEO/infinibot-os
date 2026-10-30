import { html } from "lit";

import type { ConfigUiHints } from "../types";
import type { ChannelsProps } from "./channels.types";
import {
  analyzeConfigSchema,
  renderNode,
  schemaType,
  type JsonSchema,
} from "./config-form";

type ChannelConfigFormProps = {
  channelId: string;
  configValue: Record<string, unknown> | null;
  schema: unknown | null;
  uiHints: ConfigUiHints;
  disabled: boolean;
  onPatch: (path: Array<string | number>, value: unknown) => void;
  /** Triggered when the user clicks the retry button on a load failure. */
  onRetry?: () => void;
};

type SchemaResolution =
  | { kind: "found"; node: JsonSchema }
  | { kind: "missing-no-schema" }
  | { kind: "missing-strict" }
  | { kind: "missing-no-root" };

/**
 * Walk `schema` down `path`. Returns a discriminated result so callers can
 * tell apart "this channel allows config but no schema is registered" (the
 * channel plugin didn't ship a configSchema — show a friendly empty state)
 * from "the schema strictly forbids this channel" (real error).
 */
export function resolveChannelSchemaNode(
  schema: JsonSchema | null,
  path: Array<string | number>,
): SchemaResolution {
  let current: JsonSchema | null = schema;
  if (!current) return { kind: "missing-no-root" };
  for (const key of path) {
    if (!current) return { kind: "missing-no-root" };
    const type = schemaType(current);
    if (type === "object") {
      const properties: Record<string, JsonSchema> = current.properties ?? {};
      if (typeof key === "string" && properties[key]) {
        current = properties[key];
        continue;
      }
      const additional = current.additionalProperties;
      if (typeof key === "string" && additional && typeof additional === "object") {
        current = additional as JsonSchema;
        continue;
      }
      if (additional === true) {
        // Channels parent allows arbitrary children but no schema was
        // registered for this specific channel id (plugin didn't ship
        // a configSchema). Tell the caller so it can render an
        // informational empty state instead of a danger callout.
        return { kind: "missing-no-schema" };
      }
      return { kind: "missing-strict" };
    }
    if (type === "array") {
      if (typeof key !== "number") return { kind: "missing-strict" };
      const items: JsonSchema | undefined = Array.isArray(current.items)
        ? current.items[0]
        : current.items;
      current = items ?? null;
      continue;
    }
    return { kind: "missing-strict" };
  }
  if (!current) return { kind: "missing-no-root" };
  return { kind: "found", node: current };
}

function resolveChannelValue(
  config: Record<string, unknown>,
  channelId: string,
): Record<string, unknown> {
  const channels = (config.channels ?? {}) as Record<string, unknown>;
  const fromChannels = channels[channelId];
  const fallback = config[channelId];
  const resolved =
    (fromChannels && typeof fromChannels === "object"
      ? (fromChannels as Record<string, unknown>)
      : null) ??
    (fallback && typeof fallback === "object"
      ? (fallback as Record<string, unknown>)
      : null);
  return resolved ?? {};
}

export function renderChannelConfigForm(props: ChannelConfigFormProps) {
  const analysis = analyzeConfigSchema(props.schema);
  const normalized = analysis.schema;
  if (!normalized) {
    return html`
      <div class="channel-config-empty">
        <div class="channel-config-empty-title">Config schema didn't load</div>
        <div class="channel-config-empty-body">
          The gateway didn't return a schema for this session. Use Raw
          mode to edit, or retry.
        </div>
        ${props.onRetry
          ? html`<button class="btn channel-btn" @click=${props.onRetry}>
              Retry
            </button>`
          : null}
      </div>
    `;
  }
  const resolution = resolveChannelSchemaNode(normalized, [
    "channels",
    props.channelId,
  ]);
  if (resolution.kind === "missing-no-schema") {
    return html`
      <div class="channel-config-empty">
        <div class="channel-config-empty-title">No editable config</div>
        <div class="channel-config-empty-body">
          This channel doesn't expose a config schema — its plugin is
          loaded but offers no editable fields. Use Raw mode if you need
          to set values manually.
        </div>
      </div>
    `;
  }
  if (resolution.kind !== "found") {
    return html`
      <div class="callout danger">
        Channel config schema unavailable for "${props.channelId}".
      </div>
    `;
  }
  const configValue = props.configValue ?? {};
  const value = resolveChannelValue(configValue, props.channelId);
  return html`
    <div class="config-form">
      ${renderNode({
        schema: resolution.node,
        value,
        path: ["channels", props.channelId],
        hints: props.uiHints,
        unsupported: new Set(analysis.unsupportedPaths),
        disabled: props.disabled,
        showLabel: false,
        onPatch: props.onPatch,
      })}
    </div>
  `;
}

export function renderChannelConfigSection(params: {
  channelId: string;
  props: ChannelsProps;
}) {
  const { channelId, props } = params;
  const disabled = props.configSaving || props.configSchemaLoading;
  return html`
    <div class="channel-config-divider"></div>
    <div class="channel-config-title">Configuration</div>
    <div>
      ${props.configSchemaLoading
        ? html`<div class="channel-config-skeleton" role="status" aria-label="Loading channel configuration">
            <span></span><span></span><span></span>
          </div>`
        : renderChannelConfigForm({
            channelId,
            configValue: props.configForm,
            schema: props.configSchema,
            uiHints: props.configUiHints,
            disabled,
            onPatch: props.onConfigPatch,
            onRetry: () => props.onConfigReload(),
          })}
      <div class="channel-actions channel-config-actions">
        <button
          class="btn channel-btn primary"
          ?disabled=${disabled || !props.configFormDirty}
          @click=${() => props.onConfigSave()}
        >
          ${props.configSaving ? "Saving…" : "Save"}
        </button>
        <button
          class="btn channel-btn"
          ?disabled=${disabled}
          @click=${() => props.onConfigReload()}
        >
          Reload
        </button>
        ${!props.configFormDirty && !props.configSaving
          ? html`<span class="channel-config-saved" role="status">Configuration synced</span>`
          : null}
      </div>
    </div>
  `;
}
