/**
 * Auto-generated settings form from a plugin's manifest `configSchema`
 * (JSON Schema). Supports string (text / enum / write-only secret), number,
 * integer, boolean, string arrays and one level of nested objects; anything
 * else is edited as JSON. Secrets never come back from the gateway — the form
 * shows "stored" / "not set" and only sends a value when one is typed.
 */

import { html, nothing, type TemplateResult } from "lit";

type Schema = Record<string, unknown>;
type Hints = Record<string, { label?: string; help?: string; sensitive?: boolean; placeholder?: string; advanced?: boolean }>;

export type ConfigFormContext = {
  schema: Schema | null;
  hints: Hints;
  values: Record<string, unknown>;
  secretKeys: string[];
  /** Values as saved on the gateway (secret masks say whether one is stored). */
  savedValues?: Record<string, unknown>;
  /** Dotted paths that differ from the saved values (marked in the form). */
  changed?: ReadonlySet<string>;
  onChange: (key: string, value: unknown) => void;
};

function propsOf(schema: Schema | null): [string, Schema][] {
  const props = (schema?.properties ?? {}) as Record<string, Schema>;
  return Object.entries(props);
}

function isSecretMask(v: unknown): v is { __secret: true; set: boolean } {
  return Boolean(v && typeof v === "object" && (v as { __secret?: unknown }).__secret === true);
}

function labelFor(key: string, prop: Schema, hints: Hints): string {
  return hints[key]?.label ?? (typeof prop.title === "string" ? prop.title : key.replace(/([a-z])([A-Z])/g, "$1 $2"));
}

function renderField(key: string, prop: Schema, value: unknown, ctx: ConfigFormContext, path: string): TemplateResult {
  const hint = ctx.hints[path] ?? ctx.hints[key] ?? {};
  const label = labelFor(key, prop, ctx.hints);
  const help = hint.help ?? (typeof prop.description === "string" ? prop.description : undefined);
  const id = `cfg-${path.replace(/\W/g, "-")}`;
  const type = Array.isArray(prop.type) ? (prop.type as string[])[0] : (prop.type as string | undefined);
  const secret = ctx.secretKeys.includes(path);

  const changed = ctx.changed?.has(path) ?? false;
  const changedMark = changed ? html`<span class="pp-changed" title="Changed — not saved yet">●<span class="pp-sr"> changed</span></span>` : nothing;
  const helpId = `${id}-help`;

  let control: TemplateResult;
  if (secret) {
    const savedVal = path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), ctx.savedValues ?? {});
    const typed = typeof value === "string" && value !== "";
    const saved = isSecretMask(savedVal) ? savedVal.set : isSecretMask(value) ? value.set : false;
    control = html`
      <div class="pp-secret">
        <input
          id=${id}
          class="pp-input"
          type="password"
          autocomplete="new-password"
          aria-describedby=${helpId}
          placeholder=${saved ? "•••••••• stored — type to replace" : "Not set — paste a value"}
          @input=${(e: Event) => ctx.onChange(path, (e.target as HTMLInputElement).value || undefined)}
        />
        <span class="pp-secret-state ${typed ? "new" : saved ? "set" : "unset"}" data-secret-state=${path}>${typed ? "New value" : saved ? "Set" : "Not set"}</span>
      </div>
      <span class="pp-help" id=${helpId}>${help ? html`${help} · ` : nothing}Write-only: the saved value is never shown or sent back to the browser.</span>
    `;
  } else if (Array.isArray(prop.enum)) {
    control = html`<select id=${id} class="pp-select" @change=${(e: Event) => ctx.onChange(path, (e.target as HTMLSelectElement).value)}>
      ${value === undefined ? html`<option value="" selected>—</option>` : nothing}
      ${(prop.enum as unknown[]).map((opt) => html`<option value=${String(opt)} ?selected=${opt === value}>${String(opt)}</option>`)}
    </select>`;
  } else if (type === "boolean") {
    const on = value === true || (value === undefined && prop.default === true);
    return html`<div class="pp-field pp-toggle-row ${changed ? "is-changed" : ""}" data-field=${path}>
      <div class="pp-toggle-text">
        <label class="pp-label" id=${`${id}-label`} for=${id}>${label} ${changedMark}</label>
        ${help ? html`<span class="pp-help" id=${helpId}>${help}</span>` : nothing}
      </div>
      <button
        id=${id}
        class="pp-switch"
        role="switch"
        aria-checked=${String(on)}
        aria-labelledby=${`${id}-label`}
        aria-describedby=${help ? helpId : nothing}
        @click=${() => ctx.onChange(path, !on)}
      ></button>
    </div>`;
  } else if (type === "number" || type === "integer") {
    control = html`<input
      id=${id}
      class="pp-input"
      type="number"
      step=${type === "integer" ? "1" : "any"}
      .value=${value === undefined ? "" : String(value)}
      placeholder=${prop.default !== undefined ? String(prop.default) : ""}
      @input=${(e: Event) => {
        const raw = (e.target as HTMLInputElement).value;
        ctx.onChange(path, raw === "" ? undefined : Number(raw));
      }}
    />`;
  } else if (type === "array" && (prop.items as Schema | undefined)?.type === "string") {
    control = html`<input
      id=${id}
      class="pp-input"
      .value=${Array.isArray(value) ? value.join(", ") : ""}
      placeholder="comma, separated, values"
      @input=${(e: Event) => {
        const raw = (e.target as HTMLInputElement).value;
        ctx.onChange(path, raw.trim() ? raw.split(",").map((s) => s.trim()).filter(Boolean) : undefined);
      }}
    />`;
  } else if (type === "object" && prop.properties) {
    const obj = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
    return html`<fieldset class="pp-field pp-fieldset" data-field=${path}>
      <legend class="pp-label">${label}</legend>
      ${help ? html`<span class="pp-help">${help}</span>` : nothing}
      ${propsOf(prop).map(([k, p]) => renderField(k, p, obj[k], ctx, `${path}.${k}`))}
    </fieldset>`;
  } else if (type === "string" || type === undefined) {
    control = html`<input
      id=${id}
      class="pp-input"
      .value=${typeof value === "string" ? value : ""}
      placeholder=${hint.placeholder ?? (prop.default !== undefined ? String(prop.default) : "")}
      @input=${(e: Event) => ctx.onChange(path, (e.target as HTMLInputElement).value || undefined)}
    />`;
  } else {
    control = html`<textarea
      id=${id}
      class="pp-input pp-code"
      rows="4"
      .value=${value === undefined ? "" : JSON.stringify(value, null, 2)}
      @change=${(e: Event) => {
        const raw = (e.target as HTMLTextAreaElement).value.trim();
        try {
          ctx.onChange(path, raw ? JSON.parse(raw) : undefined);
        } catch {
          /* keep last valid value; schema validation reports errors on save */
        }
      }}
    ></textarea>`;
  }
  return html`<div class="pp-field ${changed ? "is-changed" : ""}" data-field=${path}>
    <label class="pp-label" for=${id}>${label} ${changedMark}</label>
    ${control}
    ${help && !secret ? html`<span class="pp-help" id=${helpId}>${help}</span>` : nothing}
  </div>`;
}

export function renderConfigForm(ctx: ConfigFormContext): TemplateResult {
  const props = propsOf(ctx.schema);
  if (!ctx.schema || props.length === 0) {
    return html`<p class="pp-p pp-muted">This plugin has no settings.</p>`;
  }
  return html`${props.map(([key, prop]) => renderField(key, prop, ctx.values[key], ctx, key))}`;
}

/** Set a dotted path on a shallow-cloned object. */
export function setPath(obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const [head, ...rest] = path.split(".");
  const next = { ...obj };
  if (rest.length === 0) {
    if (value === undefined) delete next[head];
    else next[head] = value;
    return next;
  }
  const child = (next[head] && typeof next[head] === "object" ? next[head] : {}) as Record<string, unknown>;
  next[head] = setPath(child, rest.join("."), value);
  return next;
}
