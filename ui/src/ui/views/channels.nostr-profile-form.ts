/**
 * Nostr Profile Edit Form
 *
 * Provides UI for editing and publishing Nostr profile (kind:0).
 */

import { html, nothing, type TemplateResult } from "lit";

import type { NostrProfile as NostrProfileType } from "../types";

// ============================================================================
// Types
// ============================================================================

export interface NostrProfileFormState {
  /** Current form values */
  values: NostrProfileType;
  /** Original values for dirty detection */
  original: NostrProfileType;
  /** Whether the form is currently submitting */
  saving: boolean;
  /** Whether import is in progress */
  importing: boolean;
  /** Last error message */
  error: string | null;
  /** Last success message */
  success: string | null;
  /** Validation errors per field */
  fieldErrors: Record<string, string>;
  /** Whether to show advanced fields */
  showAdvanced: boolean;
}

export interface NostrProfileFormCallbacks {
  /** Called when a field value changes */
  onFieldChange: (field: keyof NostrProfileType, value: string) => void;
  /** Called when save is clicked */
  onSave: () => void;
  /** Called when import is clicked */
  onImport: () => void;
  /** Called when cancel is clicked */
  onCancel: () => void;
  /** Called when toggle advanced is clicked */
  onToggleAdvanced: () => void;
}

// ============================================================================
// Helpers
// ============================================================================

function isFormDirty(state: NostrProfileFormState): boolean {
  const { values, original } = state;
  return (
    values.name !== original.name ||
    values.displayName !== original.displayName ||
    values.about !== original.about ||
    values.picture !== original.picture ||
    values.banner !== original.banner ||
    values.website !== original.website ||
    values.nip05 !== original.nip05 ||
    values.lud16 !== original.lud16
  );
}

// ============================================================================
// Form Rendering
// ============================================================================

export function renderNostrProfileForm(params: {
  state: NostrProfileFormState;
  callbacks: NostrProfileFormCallbacks;
  accountId: string;
}): TemplateResult {
  const { state, callbacks, accountId } = params;
  const isDirty = isFormDirty(state);

  const renderField = (
    field: keyof NostrProfileType,
    label: string,
    opts: {
      type?: "text" | "url" | "textarea";
      placeholder?: string;
      maxLength?: number;
      help?: string;
    } = {}
  ) => {
    const { type = "text", placeholder, maxLength, help } = opts;
    const value = state.values[field] ?? "";
    const error = state.fieldErrors[field];

    const inputId = `nostr-profile-${field}`;

    if (type === "textarea") {
      return html`
        <div class="form-field nostr-profile-form__field">
          <label for="${inputId}">
            ${label}
          </label>
          <textarea
            id="${inputId}"
            .value=${value}
            placeholder=${placeholder ?? ""}
            maxlength=${maxLength ?? 2000}
            rows="3"
            aria-invalid=${error ? "true" : "false"}
            aria-describedby=${error ? `${inputId}-error` : nothing}
            @input=${(e: InputEvent) => {
              const target = e.target as HTMLTextAreaElement;
              callbacks.onFieldChange(field, target.value);
            }}
            ?disabled=${state.saving}
          ></textarea>
          ${help ? html`<div class="nostr-profile-form__help">${help}</div>` : nothing}
          ${error ? html`<div id="${inputId}-error" class="nostr-profile-form__error" role="alert">${error}</div>` : nothing}
        </div>
      `;
    }

    return html`
      <div class="form-field nostr-profile-form__field">
        <label for="${inputId}">
          ${label}
        </label>
        <input
          id="${inputId}"
          type=${type}
          .value=${value}
          placeholder=${placeholder ?? ""}
          maxlength=${maxLength ?? 256}
          aria-invalid=${error ? "true" : "false"}
          aria-describedby=${error ? `${inputId}-error` : nothing}
          @input=${(e: InputEvent) => {
            const target = e.target as HTMLInputElement;
            callbacks.onFieldChange(field, target.value);
          }}
          ?disabled=${state.saving}
        />
        ${help ? html`<div class="nostr-profile-form__help">${help}</div>` : nothing}
        ${error ? html`<div id="${inputId}-error" class="nostr-profile-form__error" role="alert">${error}</div>` : nothing}
      </div>
    `;
  };

  const renderPicturePreview = () => {
    const picture = state.values.picture;
    if (!picture) return nothing;

    return html`
      <div class="nostr-profile-form__preview-wrap">
        <img
          src=${picture}
          alt="Profile picture preview"
          class="nostr-profile-form__preview"
          @error=${(e: Event) => {
            const img = e.target as HTMLImageElement;
            img.style.display = "none";
          }}
          @load=${(e: Event) => {
            const img = e.target as HTMLImageElement;
            img.style.display = "block";
          }}
        />
      </div>
    `;
  };

  return html`
    <div class="nostr-profile-form">
      <div class="nostr-profile-form__header">
        <div class="nostr-profile-form__title">Edit Profile</div>
        <div class="nostr-profile-form__account">Account: ${accountId}</div>
      </div>

      ${state.error
        ? html`<div class="callout danger" style="margin-bottom: 12px;">${state.error}</div>`
        : nothing}

      ${state.success
        ? html`<div class="callout success" style="margin-bottom: 12px;">${state.success}</div>`
        : nothing}

      ${renderPicturePreview()}

      ${renderField("name", "Username", {
        placeholder: "satoshi",
        maxLength: 256,
        help: "Short username (e.g., satoshi)",
      })}

      ${renderField("displayName", "Display Name", {
        placeholder: "Satoshi Nakamoto",
        maxLength: 256,
        help: "Your full display name",
      })}

      ${renderField("about", "Bio", {
        type: "textarea",
        placeholder: "Tell people about yourself...",
        maxLength: 2000,
        help: "A brief bio or description",
      })}

      ${renderField("picture", "Avatar URL", {
        type: "url",
        placeholder: "https://example.com/avatar.jpg",
        help: "HTTPS URL to your profile picture",
      })}

      ${state.showAdvanced
        ? html`
            <div class="nostr-profile-form__advanced">
              <div class="nostr-profile-form__title">Advanced</div>

              ${renderField("banner", "Banner URL", {
                type: "url",
                placeholder: "https://example.com/banner.jpg",
                help: "HTTPS URL to a banner image",
              })}

              ${renderField("website", "Website", {
                type: "url",
                placeholder: "https://example.com",
                help: "Your personal website",
              })}

              ${renderField("nip05", "NIP-05 Identifier", {
                placeholder: "you@example.com",
                help: "Verifiable identifier (e.g., you@domain.com)",
              })}

              ${renderField("lud16", "Lightning Address", {
                placeholder: "you@getalby.com",
                help: "Lightning address for tips (LUD-16)",
              })}
            </div>
          `
        : nothing}

      <div class="nostr-profile-form__actions">
        <button
          class="btn primary"
          @click=${callbacks.onSave}
          ?disabled=${state.saving || !isDirty}
        >
          ${state.saving ? "Saving..." : "Save & Publish"}
        </button>

        <button
          class="btn"
          @click=${callbacks.onImport}
          ?disabled=${state.importing || state.saving}
        >
          ${state.importing ? "Importing..." : "Import from Relays"}
        </button>

        <button
          class="btn"
          @click=${callbacks.onToggleAdvanced}
        >
          ${state.showAdvanced ? "Hide Advanced" : "Show Advanced"}
        </button>

        <button
          class="btn"
          @click=${callbacks.onCancel}
          ?disabled=${state.saving}
        >
          Cancel
        </button>
      </div>

      ${isDirty
        ? html`<div class="nostr-profile-form__dirty" role="status">
            You have unsaved changes
          </div>`
        : nothing}
    </div>
  `;
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create initial form state from existing profile
 */
export function createNostrProfileFormState(
  profile: NostrProfileType | undefined
): NostrProfileFormState {
  const values: NostrProfileType = {
    name: profile?.name ?? "",
    displayName: profile?.displayName ?? "",
    about: profile?.about ?? "",
    picture: profile?.picture ?? "",
    banner: profile?.banner ?? "",
    website: profile?.website ?? "",
    nip05: profile?.nip05 ?? "",
    lud16: profile?.lud16 ?? "",
  };

  return {
    values,
    original: { ...values },
    saving: false,
    importing: false,
    error: null,
    success: null,
    fieldErrors: {},
    showAdvanced: Boolean(
      profile?.banner || profile?.website || profile?.nip05 || profile?.lud16
    ),
  };
}
