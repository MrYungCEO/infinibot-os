import { html, nothing, type TemplateResult } from "lit";

import type { GatewayBrowserClient } from "../gateway";
import {
  ensureAgencyOperationsState,
  loadAgencyOperations,
  switchAgencyOperationsAgency,
  type AgencyOperationsHost,
} from "../controllers/agency-operations";

type AgencySwitcherHost = AgencyOperationsHost & {
  client?: GatewayBrowserClient | null;
};

/**
 * Global workspace switcher. It deliberately lives in the application shell,
 * not on an individual business page, because an agency selection scopes every
 * operational surface (projects, tasks, clients, workforce and personas).
 */
export function renderAgencySwitcher(host: AgencySwitcherHost): TemplateResult | typeof nothing {
  const client = host.client;
  if (!client) return nothing;

  const state = ensureAgencyOperationsState(host);
  if (!state.loading && state.lastLoadedAt === null) {
    queueMicrotask(() => void loadAgencyOperations(host, client));
  }

  const selected = state.agencies.find((agency) => agency.id === state.selectedAgencyId);
  const owned = state.agencies.filter((agency) => agency.role === "owner");
  const shared = state.agencies.filter((agency) => agency.role !== "owner");

  return html`
    <style>
      .global-agency-switcher {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        min-width: 150px;
        max-width: 230px;
        height: 34px;
        padding: 0 9px;
        border: 1px solid color-mix(in srgb, var(--g-primary, #8b5cf6) 38%, transparent);
        border-radius: 10px;
        background: color-mix(in srgb, var(--panel, #111827) 88%, transparent);
      }
      .global-agency-switcher__mark {
        display: grid;
        width: 20px;
        height: 20px;
        flex: 0 0 20px;
        place-items: center;
        border-radius: 6px;
        background: var(--g-primary, #8b5cf6);
        color: #fff;
        font-size: 11px;
        font-weight: 800;
      }
      .global-agency-switcher__label {
        display: grid;
        min-width: 0;
        flex: 1;
      }
      .global-agency-switcher small {
        color: var(--muted, #94a3b8);
        font-size: 8px;
        font-weight: 700;
        letter-spacing: .08em;
        line-height: 9px;
        text-transform: uppercase;
      }
      .global-agency-switcher select {
        width: 100%;
        min-width: 0;
        border: 0;
        outline: 0;
        background: transparent;
        color: inherit;
        font: inherit;
        font-size: 12px;
        font-weight: 650;
        /* Own chevron (below) instead of the native arrow, which painted over
           long names ("Kingly Kreationz"); the name ellipsises before it. */
        appearance: none;
        -webkit-appearance: none;
        padding: 0 14px 0 0;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
        cursor: pointer;
      }
      .global-agency-switcher select option,
      .global-agency-switcher select optgroup {
        color: var(--text, #e4e4e7);
        background: var(--bg-elevated, #111);
      }
      .global-agency-switcher__chev {
        flex: 0 0 10px;
        width: 10px;
        height: 10px;
        margin-left: -12px;
        pointer-events: none;
        color: var(--muted, #94a3b8);
      }
      .global-agency-switcher:focus-within {
        border-color: color-mix(in srgb, var(--g-primary, #8b5cf6) 70%, transparent);
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--g-primary, #8b5cf6) 25%, transparent);
      }
      @media (max-width: 1000px) {
        .global-agency-switcher { min-width: 112px; max-width: 150px; }
      }
    </style>
    <label
      class="global-agency-switcher"
      title=${selected
        ? `${selected.name} · ${selected.role}`
        : "Select the agency workspace used across all business data"}
    >
      <span class="global-agency-switcher__mark" aria-hidden="true">A</span>
      <span class="global-agency-switcher__label">
        <small>Agency</small>
        <select
          aria-label="Active agency"
          .value=${state.selectedAgencyId ?? ""}
          ?disabled=${state.loading || state.agencies.length === 0}
          @change=${(event: Event) => {
            const agencyId = (event.target as HTMLSelectElement).value;
            if (agencyId) void switchAgencyOperationsAgency(host, client, agencyId);
          }}
        >
          ${state.agencies.length === 0
            ? html`<option value="">${state.loading ? "Loading…" : "No agencies"}</option>`
            : nothing}
          ${owned.length
            ? html`<optgroup label="Owned by me">
                ${owned.map(
                  (agency) =>
                    html`<option value=${agency.id}>${agency.name}</option>`,
                )}
              </optgroup>`
            : nothing}
          ${shared.length
            ? html`<optgroup label="Shared with me">
                ${shared.map(
                  (agency) =>
                    html`<option value=${agency.id}>${agency.name} · ${agency.role}</option>`,
                )}
              </optgroup>`
            : nothing}
        </select>
      </span>
      <svg class="global-agency-switcher__chev" viewBox="0 0 10 10" aria-hidden="true">
        <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </label>
  `;
}
