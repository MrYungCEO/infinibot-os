/**
 * Glass G1 modal + form kit for the Opportunities host pages (opportunity,
 * decision, risk, commitment, person). Presentation only — every helper takes
 * the value and a change callback, so each view keeps its own state/setters.
 * Styles live in ./kis.css under the `.wg-kis` page root.
 */
import { html, nothing, type TemplateResult } from "lit";
import { icon } from "../kis-shared";
import "./kis.css";

/** A linked-object marker in a label ("Owner 🔗") becomes a small link glyph. */
function labelContent(label: string): TemplateResult {
  const linked = label.includes("🔗");
  const text = linked ? label.replace(/\s*🔗\s*/g, " ").trim() : label;
  return html`<span class="wgk-label">${text}${linked ? html`<span title="Linked record">${icon("link", 11)}</span>` : nothing}</span>`;
}

export function wgkField(
  label: string,
  value: string | number,
  onInput: (v: string) => void,
  opts: { area?: boolean; rows?: number; type?: string; placeholder?: string; span?: boolean } = {},
): TemplateResult {
  return html`
    <label class="wgk-field ${opts.span ? "wgk-span" : ""}">
      ${labelContent(label)}
      ${opts.area
        ? html`<textarea
            class="wgk-input"
            rows=${opts.rows ?? 3}
            placeholder=${opts.placeholder ?? ""}
            .value=${String(value ?? "")}
            @input=${(e: Event) => onInput((e.target as HTMLTextAreaElement).value)}
          ></textarea>`
        : html`<input
            class="wgk-input"
            type=${opts.type ?? "text"}
            placeholder=${opts.placeholder ?? ""}
            .value=${String(value ?? "")}
            @input=${(e: Event) => onInput((e.target as HTMLInputElement).value)}
          />`}
    </label>
  `;
}

export function wgkSelect(
  label: string,
  value: string,
  options: readonly string[],
  onChange: (v: string) => void,
  opts: { labels?: Record<string, string>; format?: (o: string) => string; span?: boolean } = {},
): TemplateResult {
  return html`
    <label class="wgk-field ${opts.span ? "wgk-span" : ""}">
      ${labelContent(label)}
      <select class="wgk-input" .value=${value} @change=${(e: Event) => onChange((e.target as HTMLSelectElement).value)}>
        ${options.map(
          (o) => html`<option value=${o} ?selected=${o === value}>${opts.format ? opts.format(o) : (opts.labels?.[o] ?? o)}</option>`,
        )}
      </select>
    </label>
  `;
}

export const wgkSection = (title: string): TemplateResult => html`<div class="wgk-section">${title}</div>`;

export function wgkError(message: string | null | undefined): TemplateResult | typeof nothing {
  return message ? html`<div class="wgk-err" role="alert">${message}</div>` : nothing;
}

/**
 * Glass modal sheet. Clicking the scrim (not the sheet) closes it; Escape on
 * the dialog closes it too.
 */
export function wgkModal(opts: {
  eyebrow: string;
  title: string;
  onClose: () => void;
  body: unknown;
  foot: unknown;
  error?: string | null;
  width?: number;
  center?: boolean;
  stack?: boolean;
}): TemplateResult {
  return html`
    <div
      class="wgk-scrim ${opts.center ? "wgk-scrim--center" : ""}"
      @click=${(e: Event) => {
        if (e.target === e.currentTarget) opts.onClose();
      }}
    >
      <div
        class="wgk-modal"
        role="dialog"
        aria-modal="true"
        aria-label=${opts.title}
        style=${opts.width ? `--wgk-w:${opts.width}px` : nothing}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === "Escape") opts.onClose();
        }}
      >
        <div class="wgk-modal__head">
          <div>
            <div class="wgk-modal__eyebrow">${opts.eyebrow}</div>
            <h2 class="wgk-modal__title">${opts.title}</h2>
          </div>
          <button class="wgk-x" aria-label="Close" title="Close" @click=${opts.onClose}>${icon("x", 13)}</button>
        </div>
        <div class="wgk-modal__body ${opts.stack ? "wgk-modal__body--stack" : ""}">${opts.body}</div>
        ${wgkError(opts.error)}
        <div class="wgk-modal__foot">${opts.foot}</div>
      </div>
    </div>
  `;
}
