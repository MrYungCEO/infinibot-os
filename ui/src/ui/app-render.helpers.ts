import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";

import type { AppViewState } from "./app-view-state";
import { iconForTab, pathForTab, titleForTab, type Tab } from "./navigation";
import { icons } from "./icons";
import { loadChatHistory } from "./controllers/chat";
import { syncUrlWithSessionKey } from "./app-settings";
import type { SessionsListResult } from "./types";
import type { ThemeMode } from "./theme";
import type { ThemeTransitionContext } from "./theme-transition";
import { APP_LOCALES, LOCALE_LABELS, t, type AppLocale } from "./i18n";

import {
  createModelFilterState,
  filterModels,
  getUniqueProviders,
  groupModelsByProvider,
  type ModelCapability,
  type ModelFilterState,
  type ModelOption as SharedModelOption,
} from "./model-filter";

// Re-export so existing importers (chat.ts, masonry-grid.ts, etc.) keep working.
export type ModelOption = SharedModelOption;

// Model selector state (module-level for simplicity)
let modelSelectorOpen = false;
let modelFilter: ModelFilterState = createModelFilterState();

// System prompt modal state (module-level for simplicity)
let systemPromptModalOpen = false;
let systemPromptDraft = "";
let systemPromptSaving = false;

const CAPABILITY_CHIPS: Array<{ cap: ModelCapability; label: string }> = [
  { cap: "vision", label: "Vision" },
  { cap: "tool-use", label: "Tools" },
  { cap: "long-context", label: "Long ctx" },
  { cap: "reasoning", label: "Reasoning" },
];

function closeModelSelector() {
  modelSelectorOpen = false;
  modelFilter = createModelFilterState();
}

function setupModelSelectorClickOutside(container: HTMLElement | null) {
  if (!container) return;
  const handler = (e: MouseEvent) => {
    if (!container.contains(e.target as Node)) {
      closeModelSelector();
      document.removeEventListener("click", handler);
      container.dispatchEvent(new CustomEvent("model-selector-close"));
    }
  };
  // Delay to avoid immediate close from the toggle click
  setTimeout(() => document.addEventListener("click", handler), 0);
}

export function renderTab(state: AppViewState, tab: Tab) {
  const href = pathForTab(tab, state.basePath);
  return html`
    <a
      href=${href}
      class="nav-item ${state.tab === tab ? "active" : ""}"
      @click=${(event: MouseEvent) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        state.setTab(tab);
      }}
      title=${titleForTab(tab)}
    >
      <span class="nav-item__icon" aria-hidden="true">${icons[iconForTab(tab)]}</span>
      <span class="nav-item__text">${titleForTab(tab)}</span>
    </a>
  `;
}

export function renderChatControls(state: AppViewState) {
  const sessionOptions = resolveSessionOptions(state.sessionKey, state.sessionsResult);
  const disableThinkingToggle = state.onboarding;
  const disableFocusToggle = state.onboarding;
  const showThinking = state.onboarding ? false : state.settings.chatShowThinking;
  const focusActive = state.onboarding ? true : state.settings.chatFocusMode;
  
  // Get current session's model
  const currentSession = state.sessionsResult?.sessions?.find(
    (s) => s.key === state.sessionKey
  );
  const currentModel = currentSession?.model ?? state.sessionsResult?.defaults?.model ?? "";
  const availableModels = (state as AppViewState & { availableModels?: ModelOption[] }).availableModels ?? [];
  const hasModels = availableModels.length > 0;
  
  // Refresh icon
  const refreshIcon = html`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"></path><path d="M21 3v5h-5"></path></svg>`;
  const focusIcon = html`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V4h3"></path><path d="M20 7V4h-3"></path><path d="M4 17v3h3"></path><path d="M20 17v3h-3"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
  return html`
    <div class="chat-controls">
      <label class="field chat-controls__session">
        <select
          .value=${state.sessionKey}
          ?disabled=${!state.connected}
          @change=${(e: Event) => {
            const next = (e.target as HTMLSelectElement).value;
            state.sessionKey = next;
            state.chatMessage = "";
            state.chatStream = null;
            state.chatStreamStartedAt = null;
            state.chatRunId = null;
            state.resetToolStream();
            state.resetChatScroll();
            state.applySettings({
              ...state.settings,
              sessionKey: next,
              lastActiveSessionKey: next,
            });
            void state.loadAssistantIdentity();
            syncUrlWithSessionKey(state, next, true);
            void loadChatHistory(state);
          }}
        >
          ${repeat(
            sessionOptions,
            (entry) => entry.key,
            (entry) =>
              html`<option value=${entry.key}>
                ${entry.displayName ?? entry.key}
              </option>`,
          )}
        </select>
      </label>
      <button
        class="btn btn--sm btn--icon"
        ?disabled=${state.chatLoading || !state.connected}
        @click=${() => {
          state.resetToolStream();
          // Explicit user-driven refresh — bypass the "already-loaded" guard.
          void loadChatHistory(state, { force: true });
        }}
        title=${t("topbar.refreshChat", undefined, "Refresh chat history")}
      >
        ${refreshIcon}
      </button>
      <span class="chat-controls__separator">|</span>
      ${hasModels
        ? renderModelSelector(state, currentModel, availableModels)
        : nothing}
      <button
        class="btn btn--sm btn--icon ${showThinking ? "active" : ""}"
        ?disabled=${disableThinkingToggle}
        @click=${() => {
          if (disableThinkingToggle) return;
          state.applySettings({
            ...state.settings,
            chatShowThinking: !state.settings.chatShowThinking,
          });
        }}
        aria-pressed=${showThinking}
        title=${disableThinkingToggle
          ? "Disabled during onboarding"
          : "Toggle assistant thinking/working output"}
      >
        ${icons.brain}
      </button>
      <button
        class="btn btn--sm btn--icon ${focusActive ? "active" : ""}"
        ?disabled=${disableFocusToggle}
        @click=${() => {
          if (disableFocusToggle) return;
          state.applySettings({
            ...state.settings,
            chatFocusMode: !state.settings.chatFocusMode,
          });
        }}
        aria-pressed=${focusActive}
        title=${disableFocusToggle
          ? "Disabled during onboarding"
          : t("topbar.toggleFocus", undefined, "Toggle focus mode (hide sidebar + page header)")}
      >
        ${focusIcon}
      </button>
    </div>
  `;
}

function resolveSessionOptions(sessionKey: string, sessions: SessionsListResult | null) {
  const seen = new Set<string>();
  const options: Array<{ key: string; displayName?: string }> = [];

  const resolvedCurrent = sessions?.sessions?.find((s) => s.key === sessionKey);

  // Add current session key first
  seen.add(sessionKey);
  options.push({ key: sessionKey, displayName: resolvedCurrent?.displayName });

  // Add sessions from the result
  if (sessions?.sessions) {
    for (const s of sessions.sessions) {
      if (!seen.has(s.key)) {
        seen.add(s.key);
        options.push({ key: s.key, displayName: s.displayName });
      }
    }
  }

  return options;
}

function renderModelSelector(state: AppViewState, currentModel: string, models: ModelOption[]) {
  const providers = getUniqueProviders(models);
  const filtered = filterModels(models, modelFilter);
  const grouped = groupModelsByProvider(filtered);
  
  // Find current model display info
  const currentModelInfo = models.find((m) => m.id === currentModel);
  const displayName = currentModelInfo?.name ?? currentModel;
  const displayProvider = currentModelInfo?.provider ?? "";
  
  const chevronIcon = html`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`;
  const searchIcon = html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>`;
  const checkIcon = html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`;
  
  const handleSelect = async (modelId: string) => {
    closeModelSelector();
    state.requestUpdate?.();
    // Call method directly on state to preserve `this` binding
    const stateWithPatch = state as AppViewState & { patchSessionModel?: (key: string, model: string) => Promise<void> };
    if (stateWithPatch.patchSessionModel) {
      await stateWithPatch.patchSessionModel.call(state, state.sessionKey, modelId);
      state.requestUpdate?.();
    }
  };
  
  const handleToggle = (e: Event) => {
    e.stopPropagation();
    modelSelectorOpen = !modelSelectorOpen;
    if (modelSelectorOpen) {
      modelFilter = createModelFilterState();
      // Focus search input after render
      requestAnimationFrame(() => {
        const container = (e.target as HTMLElement).closest(".model-selector");
        const input = container?.querySelector<HTMLInputElement>(".model-selector__search-input");
        input?.focus();
        if (container) setupModelSelectorClickOutside(container as HTMLElement);
      });
    }
    state.requestUpdate?.();
  };
  
  const handleSearch = (e: Event) => {
    e.stopPropagation();
    modelFilter.search = (e.target as HTMLInputElement).value;
    state.requestUpdate?.();
  };

  const handleProviderFilter = (provider: string | null) => (e: Event) => {
    e.stopPropagation();
    modelFilter.provider = modelFilter.provider === provider ? null : provider;
    state.requestUpdate?.();
  };

  const handleCapabilityFilter = (cap: ModelCapability) => (e: Event) => {
    e.stopPropagation();
    if (modelFilter.capabilities.has(cap)) modelFilter.capabilities.delete(cap);
    else modelFilter.capabilities.add(cap);
    state.requestUpdate?.();
  };

  const handleTierFilter = (tier: "s" | "m" | "l") => (e: Event) => {
    e.stopPropagation();
    modelFilter.tier = modelFilter.tier === tier ? null : tier;
    state.requestUpdate?.();
  };
  
  return html`
    <div class="model-selector" @model-selector-close=${() => state.requestUpdate?.()}>
      <button
        class="model-selector__trigger ${modelSelectorOpen ? "model-selector__trigger--open" : ""}"
        ?disabled=${!state.connected}
        @click=${handleToggle}
        title=${t("topbar.selectModel", undefined, "Select model for this session")}
      >
        ${displayProvider ? html`<span class="model-selector__provider">${displayProvider}/</span>` : nothing}
        <span class="model-selector__name">${displayName.replace(`${displayProvider}/`, "")}</span>
        <span class="model-selector__chevron">${chevronIcon}</span>
      </button>
      ${modelSelectorOpen
        ? html`
            <div class="model-selector__dropdown" @click=${(e: Event) => e.stopPropagation()}>
              <div class="model-selector__search">
                <span class="model-selector__search-icon">${searchIcon}</span>
                <input
                  type="text"
                  class="model-selector__search-input"
                  placeholder="Search models..."
                  .value=${modelFilter.search}
                  @input=${handleSearch}
                  @keydown=${(e: KeyboardEvent) => {
                    if (e.key === "Escape") {
                      closeModelSelector();
                      state.requestUpdate?.();
                    }
                  }}
                />
              </div>
              ${providers.length > 1
                ? html`
                    <div class="model-selector__filters">
                      <button
                        class="model-selector__filter-chip ${modelFilter.provider === null ? "model-selector__filter-chip--active" : ""}"
                        @click=${handleProviderFilter(null)}
                      >
                        All
                      </button>
                      ${providers.map(
                        (p) => html`
                          <button
                            class="model-selector__filter-chip ${modelFilter.provider === p ? "model-selector__filter-chip--active" : ""}"
                            @click=${handleProviderFilter(p)}
                          >
                            ${p}
                          </button>
                        `,
                      )}
                    </div>
                  `
                : nothing}
              <div class="model-selector__filters">
                ${CAPABILITY_CHIPS.map(
                  ({ cap, label }) => html`
                    <button
                      class="model-selector__filter-chip ${modelFilter.capabilities.has(cap) ? "model-selector__filter-chip--active" : ""}"
                      @click=${handleCapabilityFilter(cap)}
                    >
                      ${label}
                    </button>
                  `,
                )}
                ${(["s", "m", "l"] as const).map(
                  (tier) => html`
                    <button
                      class="model-selector__filter-chip ${modelFilter.tier === tier ? "model-selector__filter-chip--active" : ""}"
                      @click=${handleTierFilter(tier)}
                      title="Filter by size / cost tier"
                    >
                      ${tier === "s" ? "Small" : tier === "m" ? "Mid" : "Large"}
                    </button>
                  `,
                )}
              </div>
              <div class="model-selector__list">
                ${models.length === 0
                  ? html`<div class="model-selector__empty">Loading models...</div>`
                  : filtered.length === 0
                    ? html`<div class="model-selector__empty">No models match your search</div>`
                    : html`
                        ${Array.from(grouped.entries()).map(
                          ([provider, providerModels]) => html`
                            <div class="model-selector__group">
                              <div class="model-selector__group-label">${provider}</div>
                              ${providerModels.map(
                                (m) => html`
                                  <button
                                    class="model-selector__item ${m.id === currentModel ? "model-selector__item--selected" : ""}"
                                    @click=${() => handleSelect(m.id)}
                                  >
                                    <span class="model-selector__item-name">${m.name}</span>
                                    ${m.id === currentModel ? html`<span class="model-selector__item-check">${checkIcon}</span>` : nothing}
                                  </button>
                                `,
                              )}
                            </div>
                          `,
                        )}
                      `}
              </div>
            </div>
          `
        : nothing}
    </div>
    ${renderSystemPromptButton(state)}
    <span class="chat-controls__separator">|</span>
  `;
}

function renderSystemPromptButton(state: AppViewState) {
  const settingsIcon = html`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>`;
  
  const handleOpenModal = async () => {
    // Load current system prompt from config
    // Try to get from configForm first, then configSnapshot
    const configData = state.configForm ?? (state.configSnapshot as Record<string, unknown> | null)?.config as Record<string, unknown> | null;
    const agents = (configData as Record<string, unknown> | null)?.agents as Record<string, unknown> | undefined;
    const defaults = agents?.defaults as Record<string, unknown> | undefined;
    systemPromptDraft = (defaults?.systemPrompt as string) ?? "";
    systemPromptModalOpen = true;
    state.requestUpdate?.();
  };
  
  return html`
    <button
      class="btn btn--sm btn--icon"
      ?disabled=${!state.connected}
      @click=${handleOpenModal}
      title=${t("topbar.configurePrompt", undefined, "Configure system prompt")}
    >
      ${settingsIcon}
    </button>
    ${systemPromptModalOpen ? renderSystemPromptModal(state) : nothing}
  `;
}

function renderSystemPromptModal(state: AppViewState) {
  const closeIcon = html`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;
  
  const handleClose = () => {
    systemPromptModalOpen = false;
    systemPromptDraft = "";
    state.requestUpdate?.();
  };
  
  const handleSave = async () => {
    systemPromptSaving = true;
    state.requestUpdate?.();
    
    try {
      // Update the config form with the new system prompt
      if (state.patchConfigValue) {
        state.patchConfigValue(["agents", "defaults", "systemPrompt"], systemPromptDraft || undefined);
        // Apply the config
        if (state.saveAndApplyConfig) {
          await state.saveAndApplyConfig();
        }
      }
      
      systemPromptModalOpen = false;
      systemPromptDraft = "";
    } catch (error) {
      console.error("Failed to save system prompt:", error);
    } finally {
      systemPromptSaving = false;
      state.requestUpdate?.();
    }
  };
  
  const handleBackdropClick = (e: Event) => {
    if ((e.target as HTMLElement).classList.contains("modal-backdrop")) {
      handleClose();
    }
  };
  
  return html`
    <div class="modal-backdrop" @click=${handleBackdropClick}>
      <div class="modal system-prompt-modal">
        <div class="modal__header">
          <h2 class="modal__title">${t("prompt.modalTitle", undefined, "System Prompt Configuration")}</h2>
          <button class="modal__close" @click=${handleClose} title=${t("common.close", undefined, "Close")}>
            ${closeIcon}
          </button>
        </div>
        <div class="modal__body">
          <p class="modal__help">
            Customize the system prompt sent to the AI model. Leave empty or set to "default" to use the built-in robust prompt that handles tools, identity files (SOUL.md, USER.md), and memory (MEMORY.md).
          </p>
          <label class="field">
            <span>System Prompt</span>
            <textarea
              class="system-prompt-textarea"
              placeholder="Enter custom system prompt or leave empty for default..."
              .value=${systemPromptDraft}
              @input=${(e: Event) => {
                systemPromptDraft = (e.target as HTMLTextAreaElement).value;
                state.requestUpdate?.();
              }}
              rows="12"
            ></textarea>
          </label>
          <div class="modal__hint">
            <strong>Tip:</strong> Context files (SOUL.md, USER.md, MEMORY.md, etc.) from your workspace are automatically appended to both custom and default prompts.
          </div>
        </div>
        <div class="modal__footer">
          <button class="btn" @click=${handleClose} ?disabled=${systemPromptSaving}>
            Cancel
          </button>
          <button class="btn primary" @click=${handleSave} ?disabled=${systemPromptSaving}>
            ${systemPromptSaving ? "Saving..." : "Save & Apply"}
          </button>
        </div>
      </div>
    </div>
  `;
}

const THEME_ORDER: ThemeMode[] = ["system", "light", "dark"];

export function renderThemeToggle(state: AppViewState) {
  const index = Math.max(0, THEME_ORDER.indexOf(state.theme));
  const applyTheme = (next: ThemeMode) => (event: MouseEvent) => {
    const element = event.currentTarget as HTMLElement;
    const context: ThemeTransitionContext = { element };
    if (event.clientX || event.clientY) {
      context.pointerClientX = event.clientX;
      context.pointerClientY = event.clientY;
    }
    state.setTheme(next, context);
  };

  return html`
    <div class="theme-toggle" style="--theme-index: ${index};">
      <div class="theme-toggle__track" role="group" aria-label="Theme">
        <span class="theme-toggle__indicator"></span>
        <button
          class="theme-toggle__button ${state.theme === "system" ? "active" : ""}"
          @click=${applyTheme("system")}
          aria-pressed=${state.theme === "system"}
          aria-label="System theme"
          title=${t("topbar.theme.system", undefined, "System")}
        >
          ${renderMonitorIcon()}
        </button>
        <button
          class="theme-toggle__button ${state.theme === "light" ? "active" : ""}"
          @click=${applyTheme("light")}
          aria-pressed=${state.theme === "light"}
          aria-label="Light theme"
          title=${t("topbar.theme.light", undefined, "Light")}
        >
          ${renderSunIcon()}
        </button>
        <button
          class="theme-toggle__button ${state.theme === "dark" ? "active" : ""}"
          @click=${applyTheme("dark")}
          aria-pressed=${state.theme === "dark"}
          aria-label="Dark theme"
          title=${t("topbar.theme.dark", undefined, "Dark")}
        >
          ${renderMoonIcon()}
        </button>
      </div>
    </div>
  `;
}

/**
 * Language picker as a single control.
 *
 * This used to render one button per locale — seven chips permanently docked in
 * the global header, competing for width with the agent mesh, the satellite
 * pill and the GPU readouts, and colliding with them on narrower viewports.
 * Language is a set-once preference, so it does not earn seven pixels-wide
 * slots of persistent chrome.
 *
 * A native <select> keeps it to one slot, and is better on accessibility than
 * the button row it replaces: real keyboard semantics and a proper accessible
 * name, instead of seven `aria-pressed` toggles the user must tab through to
 * reach anything else in the header.
 */
export function renderLanguageToggle(state: AppViewState) {
  const current = state.settings.locale ?? "en";
  return html`
    <label class="lang-select" title="Language">
      <span class="sr-only">Language</span>
      <select
        class="lang-select__control"
        aria-label="Language"
        .value=${current}
        @change=${(event: Event) => {
          const next = (event.target as HTMLSelectElement).value as AppLocale;
          if (state.settings.locale === next) return;
          state.applySettings({ ...state.settings, locale: next });
        }}
      >
        ${APP_LOCALES.map(
          (loc) => html`
            <option value=${loc} ?selected=${current === loc}>
              ${LOCALE_LABELS[loc].short} · ${LOCALE_LABELS[loc].native}
            </option>
          `,
        )}
      </select>
    </label>
  `;
}

function renderSunIcon() {
  return html`
    <svg class="theme-icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="4"></circle>
      <path d="M12 2v2"></path>
      <path d="M12 20v2"></path>
      <path d="m4.93 4.93 1.41 1.41"></path>
      <path d="m17.66 17.66 1.41 1.41"></path>
      <path d="M2 12h2"></path>
      <path d="M20 12h2"></path>
      <path d="m6.34 17.66-1.41 1.41"></path>
      <path d="m19.07 4.93-1.41 1.41"></path>
    </svg>
  `;
}

function renderMoonIcon() {
  return html`
    <svg class="theme-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"
      ></path>
    </svg>
  `;
}

function renderMonitorIcon() {
  return html`
    <svg class="theme-icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect width="20" height="14" x="2" y="3" rx="2"></rect>
      <line x1="8" x2="16" y1="21" y2="21"></line>
      <line x1="12" x2="12" y1="17" y2="21"></line>
    </svg>
  `;
}

/* ── Gateway Restart Button ─────────────────────────────────── */

let _restartBusy = false;

async function handleGatewayRestart(state: AppViewState) {
  if (_restartBusy) return;
  _restartBusy = true;
  state.requestUpdate?.();
  try {
    // Step 1: get current config + baseHash
    const configRes = await state.client.request<{ config: unknown; hash?: string; baseHash?: string }>("config.get", {});
    const baseHash = (configRes as Record<string, unknown>)?.hash ?? (configRes as Record<string, unknown>)?.baseHash;
    if (!baseHash || typeof baseHash !== "string") {
      console.error("[restart] Could not obtain config baseHash");
      return;
    }
    // Step 2: patch with empty object → triggers restart via SIGUSR1
    await state.client.request("config.patch", {
      raw: "{}",
      baseHash,
      note: "Gateway restart from UI",
    });
  } catch (err) {
    console.error("[restart] Gateway restart failed:", err);
  } finally {
    // Keep spinner for a bit since gateway is restarting
    setTimeout(() => {
      _restartBusy = false;
      state.requestUpdate?.();
    }, 5000);
  }
}

export function renderRestartButton(state: AppViewState) {
  return html`
    <button
      class="pill"
      style="cursor:pointer; border:none;"
      @click=${() => handleGatewayRestart(state)}
      title=${t("topbar.restartGateway", undefined, "Restart Gateway")}
      ?disabled=${_restartBusy}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        style="${_restartBusy ? "animation: spin 1s linear infinite;" : ""}"
      >
        <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
        <path d="M21 3v5h-5" />
      </svg>
      ${_restartBusy ? t("topbar.restarting", undefined, "Restarting…") : t("topbar.restart", undefined, "Restart")}
    </button>
  `;
}

// Check if running in Electron
function isElectron(): boolean {
  return !!(window as any).electronAPI?.isElectron;
}

export function renderNewWindowButton() {
  // Only show in Electron
  if (!isElectron()) return nothing;
  
  return html`
    <button
      class="pill new-window-btn"
      style="cursor:pointer; border:none; padding: 6px 10px;"
      @click=${async () => {
        try {
          const result = await (window as any).electronAPI.createNewWindow();
          console.log('[UI] New window created:', result);
        } catch (e) {
          console.error('[UI] Failed to create new window:', e);
        }
      }}
      title=${t("topbar.newWindow", undefined, "Open New Window")}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <line x1="12" y1="5" x2="12" y2="19" />
        <line x1="5" y1="12" x2="19" y2="12" />
      </svg>
    </button>
  `;
}
