/**
 * Funnels Onboarding Wizard
 * Step-by-step wizard for first-time users with friendly UX
 */

import { html, nothing, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../gateway";
import {
  createFunnel,
  createFunnelWithTemplate,
  applyDefaultStages,
  getTemplates,
  type FunnelTemplate,
} from "../controllers/funnels";

// ══════════════════════════════════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════════════════════════════════

export interface FunnelsOnboardingProps {
  businesses: { id: string; name: string; industry?: string }[];
  requestUpdate: () => void;
  client?: GatewayBrowserClient;
  onComplete: () => void;
}

interface OnboardingState {
  step: 1 | 2 | 3;
  /**
   * Selected business id when picking from an existing list. Empty string
   * means "no existing business chosen yet" — the wizard then either falls
   * back to creating a new business from `businessName` (when the user has
   * none) or blocks the Next button (when businesses exist but none picked).
   */
  businessId: string;
  /** Used only when no businesses exist yet and the user is creating one. */
  businessName: string;
  businessIndustry: string;
  selectedTemplate: FunnelTemplate | null;
  selectedPlatforms: string[];
  isCreating: boolean;
  error: string | null;
}

// ══════════════════════════════════════════════════════════════════════════════
// Module State
// ══════════════════════════════════════════════════════════════════════════════

let _onboardingState: OnboardingState = {
  step: 1,
  businessId: "",
  businessName: "",
  businessIndustry: "",
  selectedTemplate: null,
  selectedPlatforms: [],
  isCreating: false,
  error: null,
};

// ══════════════════════════════════════════════════════════════════════════════
// SVG Icons
// ══════════════════════════════════════════════════════════════════════════════

const icons = {
  rocket: html`<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg>`,
  building: html`<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2" width="16" height="20" rx="2" ry="2"/><path d="M9 22v-4h6v4"/><path d="M8 6h.01M16 6h.01M12 6h.01M12 10h.01M12 14h.01M16 10h.01M16 14h.01M8 10h.01M8 14h.01"/></svg>`,
  template: html`<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>`,
  connect: html`<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`,
  check: html`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  arrowRight: html`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>`,
  arrowLeft: html`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>`,
  sparkles: html`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z"/><path d="M5 19l.5 1.5L7 21l-1.5.5L5 23l-.5-1.5L3 21l1.5-.5L5 19z"/><path d="M19 11l.5 1.5L21 13l-1.5.5L19 15l-.5-1.5L17 13l1.5-.5L19 11z"/></svg>`,
  help: html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  // Platform icons
  instagram: html`<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="5" ry="5"/><circle cx="12" cy="12" r="4"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg>`,
  tiktok: html`<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 12a4 4 0 1 0 4 4V4a5 5 0 0 0 5 5"/></svg>`,
  youtube: html`<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22.54 6.42a2.78 2.78 0 0 0-1.94-2C18.88 4 12 4 12 4s-6.88 0-8.6.46a2.78 2.78 0 0 0-1.94 2A29 29 0 0 0 1 11.75a29 29 0 0 0 .46 5.33A2.78 2.78 0 0 0 3.4 19c1.72.46 8.6.46 8.6.46s6.88 0 8.6-.46a2.78 2.78 0 0 0 1.94-2 29 29 0 0 0 .46-5.25 29 29 0 0 0-.46-5.33z"/><polygon points="9.75 15.02 15.5 11.75 9.75 8.48 9.75 15.02"/></svg>`,
  twitter: html`<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4l11.733 16h4.267l-11.733-16zM4 20l6.4-6.4M20 4l-6.4 6.4"/></svg>`,
  email: html`<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>`,
  website: html`<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`,
};

// Template configurations with friendly descriptions
const TEMPLATE_CONFIGS: {
  id: FunnelTemplate;
  name: string;
  emoji: string;
  description: string;
  bestFor: string;
  steps: number;
  color: string;
}[] = [
  {
    id: "highTicket",
    name: "High-Ticket Sales",
    emoji: "💎",
    description: "Perfect for premium services & consulting. Builds trust before the big ask.",
    bestFor: "Coaches, consultants, agencies",
    steps: 5,
    color: "#a855f7",
  },
  {
    id: "midTicket",
    name: "Course & Product Launch",
    emoji: "🚀",
    description: "Ideal for digital products, courses, and memberships.",
    bestFor: "Course creators, info products",
    steps: 4,
    color: "#3b82f6",
  },
  {
    id: "lowTicket",
    name: "Quick Sale Funnel",
    emoji: "⚡",
    description: "Fast, simple path from discovery to purchase.",
    bestFor: "E-commerce, low-ticket offers",
    steps: 3,
    color: "#10b981",
  },
  {
    id: "leadMagnet",
    name: "Lead Generation",
    emoji: "🧲",
    description: "Capture emails and build your audience with a free offer.",
    bestFor: "List building, newsletters",
    steps: 3,
    color: "#f59e0b",
  },
  {
    id: "brandAwareness",
    name: "Brand & Content",
    emoji: "✨",
    description: "Grow your presence and nurture relationships over time.",
    bestFor: "Personal brands, influencers",
    steps: 4,
    color: "#ec4899",
  },
  {
    id: "multiOffer",
    name: "Multi-Product Empire",
    emoji: "👑",
    description: "Multiple offers with upsells and cross-sells. Advanced but powerful.",
    bestFor: "Established businesses",
    steps: 6,
    color: "var(--g-primary)",
  },
];

// Platform configurations
const PLATFORM_CONFIGS = [
  { id: "instagram", name: "Instagram", icon: icons.instagram, color: "#E4405F" },
  { id: "tiktok", name: "TikTok", icon: icons.tiktok, color: "#ff0050" },
  { id: "youtube", name: "YouTube", icon: icons.youtube, color: "#FF0000" },
  { id: "twitter", name: "X / Twitter", icon: icons.twitter, color: "#ffffff" },
  { id: "email", name: "Email", icon: icons.email, color: "#ea580c" },
  { id: "website", name: "Website", icon: icons.website, color: "#6366f1" },
];

// Industry options
const INDUSTRIES = [
  "Coaching & Consulting",
  "E-commerce & Products",
  "Courses & Education",
  "Creative Services",
  "Personal Brand",
  "SaaS & Software",
  "Health & Fitness",
  "Real Estate",
  "Finance & Investing",
  "Other",
];

// ══════════════════════════════════════════════════════════════════════════════
// Reset State (call when wizard completes or cancels)
// ══════════════════════════════════════════════════════════════════════════════

export function resetOnboardingState(): void {
  _onboardingState = {
    step: 1,
    businessId: "",
    businessName: "",
    businessIndustry: "",
    selectedTemplate: null,
    selectedPlatforms: [],
    isCreating: false,
    error: null,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// Main Render
// ══════════════════════════════════════════════════════════════════════════════

export function renderFunnelsOnboarding(props: FunnelsOnboardingProps): TemplateResult {
  const { requestUpdate, client, onComplete } = props;
  const state = _onboardingState;

  const goToStep = (step: 1 | 2 | 3) => {
    _onboardingState.step = step;
    _onboardingState.error = null;
    requestUpdate();
  };

  const handleComplete = async () => {
    if (state.isCreating) return;
    
    _onboardingState.isCreating = true;
    _onboardingState.error = null;
    requestUpdate();

    try {
      // Resolve which business this funnel belongs to. Priority:
      //   1. The user explicitly picked one from the dropdown (state.businessId).
      //   2. Fall back to the first existing business when nothing was picked
      //      but some exist (covers the legacy "auto-pick first" behavior).
      //   3. No businesses at all — create one from the legacy text inputs.
      let businessId: string;
      let businessLabel: string;

      const picked = state.businessId
        ? props.businesses.find((b) => b.id === state.businessId)
        : undefined;

      if (picked) {
        businessId = picked.id;
        businessLabel = picked.name;
      } else if (props.businesses.length > 0) {
        businessId = props.businesses[0].id;
        businessLabel = props.businesses[0].name;
      } else {
        const { createBusiness } = await import("../controllers/funnels");
        const biz = await createBusiness(state.businessName || "My Business", state.businessIndustry);
        if (!biz) throw new Error("Failed to create business");
        businessId = biz.id;
        businessLabel = biz.name ?? state.businessName ?? "My Business";
      }

      // Create funnel with template or default
      if (state.selectedTemplate) {
        await createFunnelWithTemplate(businessId, state.selectedTemplate, `${businessLabel} Funnel`);
      } else {
        const funnel = await createFunnel(
          businessId,
          `${businessLabel} Funnel`,
          "Created with onboarding wizard",
        );
        if (funnel) {
          // Shared helper — same default stages + descriptions used by
          // the new-funnel dialog. Keeps the un-templated experience
          // consistent across both entry points instead of one path
          // saying Attract/Engage/Convert and the other saying
          // Start/Process/End with no descriptions on either.
          await applyDefaultStages(funnel.id);
        }
      }

      resetOnboardingState();
      onComplete();
    } catch (err) {
      console.error("[onboarding] Error:", err);
      _onboardingState.error = "Something went wrong. Please try again.";
      _onboardingState.isCreating = false;
      requestUpdate();
    }
  };

  return html`
    <style>${onboardingStyles}</style>
    <div class="onboarding">
      <div class="onboarding__container">
        <!-- Progress indicator -->
        <div class="onboarding__progress">
          ${[1, 2, 3].map(step => html`
            <div class="onboarding__progress-step ${state.step >= step ? 'active' : ''} ${state.step === step ? 'current' : ''}">
              <div class="onboarding__progress-dot">
                ${state.step > step ? icons.check : step}
              </div>
              <span class="onboarding__progress-label">
                ${step === 1 ? "Your Business" : step === 2 ? "Choose Template" : "Connect Platforms"}
              </span>
            </div>
            ${step < 3 ? html`<div class="onboarding__progress-line ${state.step > step ? 'active' : ''}"></div>` : nothing}
          `)}
        </div>

        <!-- Step content -->
        <div class="onboarding__content">
          ${state.step === 1 ? renderStep1(state, props.businesses, requestUpdate, goToStep) : nothing}
          ${state.step === 2 ? renderStep2(state, requestUpdate, goToStep) : nothing}
          ${state.step === 3 ? renderStep3(state, props.businesses, requestUpdate, goToStep, handleComplete) : nothing}
        </div>

        <!-- Error message -->
        ${state.error ? html`
          <div class="onboarding__error">${state.error}</div>
        ` : nothing}
      </div>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Step 1: Name Your Business
// ══════════════════════════════════════════════════════════════════════════════

function renderStep1(
  state: OnboardingState,
  businesses: { id: string; name: string; industry?: string }[],
  requestUpdate: () => void,
  goToStep: (step: 1 | 2 | 3) => void
): TemplateResult {
  // When the user already has businesses, we require a selection — funnels
  // are scoped to exactly one business. When none exist, we keep the legacy
  // text + industry flow so the wizard can bootstrap the first business.
  const hasBusinesses = businesses.length > 0;
  const canProceed = hasBusinesses
    ? state.businessId.trim().length > 0
    : state.businessName.trim().length > 0;

  return html`
    <div class="onboarding__step">
      <div class="onboarding__header">
        <div class="onboarding__icon">${icons.rocket}</div>
        <h1>Let's build your first funnel! 🎉</h1>
        <p>${hasBusinesses
          ? "Which business is this funnel for?"
          : "First, tell us a bit about your business so we can set things up perfectly."}</p>
      </div>

      <div class="onboarding__form">
        ${hasBusinesses ? html`
          <div class="onboarding__field">
            <label>
              Business
              <button class="onboarding__help-btn" title="Funnels are tied to a single business. Pick the one this funnel belongs to.">
                ${icons.help}
              </button>
            </label>
            <select
              class="onboarding__select"
              .value=${state.businessId}
              @change=${(e: Event) => {
                _onboardingState.businessId = (e.target as HTMLSelectElement).value;
                requestUpdate();
              }}
              autofocus
            >
              <option value="" disabled>Select a business…</option>
              ${businesses.map(biz => html`
                <option value=${biz.id} ?selected=${state.businessId === biz.id}>
                  ${biz.name}${biz.industry ? ` — ${biz.industry}` : ""}
                </option>
              `)}
            </select>
          </div>
        ` : html`
          <div class="onboarding__field">
            <label>
              What's your business or brand name?
              <button class="onboarding__help-btn" title="This helps personalize your funnel. You can change it later.">
                ${icons.help}
              </button>
            </label>
            <input
              type="text"
              placeholder="e.g., Sarah's Coaching, TechStartup Inc, My Personal Brand"
              .value=${state.businessName}
              @input=${(e: Event) => {
                _onboardingState.businessName = (e.target as HTMLInputElement).value;
                requestUpdate();
              }}
              autofocus
            />
          </div>

          <div class="onboarding__field">
            <label>
              What industry are you in?
              <span class="onboarding__optional">(optional)</span>
            </label>
            <div class="onboarding__industry-grid">
              ${INDUSTRIES.map(industry => html`
                <button
                  type="button"
                  class="onboarding__industry-btn ${state.businessIndustry === industry ? 'selected' : ''}"
                  @click=${() => {
                    _onboardingState.businessIndustry = state.businessIndustry === industry ? "" : industry;
                    requestUpdate();
                  }}>
                  ${industry}
                </button>
              `)}
            </div>
          </div>
        `}
      </div>

      <div class="onboarding__actions">
        <div></div>
        <button
          class="onboarding__btn onboarding__btn--primary"
          ?disabled=${!canProceed}
          @click=${() => goToStep(2)}>
          Next: Choose a Template
          ${icons.arrowRight}
        </button>
      </div>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Step 2: Choose a Template
// ══════════════════════════════════════════════════════════════════════════════

function renderStep2(
  state: OnboardingState,
  requestUpdate: () => void,
  goToStep: (step: 1 | 2 | 3) => void
): TemplateResult {
  return html`
    <div class="onboarding__step">
      <div class="onboarding__header">
        <div class="onboarding__icon">${icons.template}</div>
        <h1>Pick a template to get started</h1>
        <p>Don't worry — you can customize everything later. Pick what matches your goals best.</p>
      </div>

      <div class="onboarding__templates">
        ${TEMPLATE_CONFIGS.map(template => html`
          <button 
            class="onboarding__template ${state.selectedTemplate === template.id ? 'selected' : ''}"
            style="--template-color: ${template.color}"
            @click=${() => {
              _onboardingState.selectedTemplate = state.selectedTemplate === template.id ? null : template.id;
              requestUpdate();
            }}>
            <div class="onboarding__template-header">
              <span class="onboarding__template-emoji">${template.emoji}</span>
              <span class="onboarding__template-name">${template.name}</span>
              ${state.selectedTemplate === template.id ? html`
                <span class="onboarding__template-check">${icons.check}</span>
              ` : nothing}
            </div>
            <p class="onboarding__template-desc">${template.description}</p>
            <div class="onboarding__template-meta">
              <span class="onboarding__template-steps">${template.steps} steps</span>
              <span class="onboarding__template-best">Best for: ${template.bestFor}</span>
            </div>
          </button>
        `)}
      </div>

      <div class="onboarding__actions">
        <button class="onboarding__btn onboarding__btn--secondary" @click=${() => goToStep(1)}>
          ${icons.arrowLeft}
          Back
        </button>
        <button 
          class="onboarding__btn onboarding__btn--primary"
          @click=${() => goToStep(3)}>
          ${state.selectedTemplate ? "Next: Connect Platforms" : "Skip & Start from Scratch"}
          ${icons.arrowRight}
        </button>
      </div>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Step 3: Connect Platforms (Optional)
// ══════════════════════════════════════════════════════════════════════════════

function renderStep3(
  state: OnboardingState,
  businesses: { id: string; name: string; industry?: string }[],
  requestUpdate: () => void,
  goToStep: (step: 1 | 2 | 3) => void,
  handleComplete: () => void
): TemplateResult {
  // Resolve the display label/industry from either the dropdown pick or
  // the text-input fallback used when no businesses existed.
  const picked = state.businessId ? businesses.find((b) => b.id === state.businessId) : undefined;
  const businessLabel = picked?.name || state.businessName || "—";
  const businessIndustryLabel = picked?.industry || state.businessIndustry || "";
  const togglePlatform = (platformId: string) => {
    const idx = state.selectedPlatforms.indexOf(platformId);
    if (idx >= 0) {
      _onboardingState.selectedPlatforms = state.selectedPlatforms.filter(p => p !== platformId);
    } else {
      _onboardingState.selectedPlatforms = [...state.selectedPlatforms, platformId];
    }
    requestUpdate();
  };

  return html`
    <div class="onboarding__step">
      <div class="onboarding__header">
        <div class="onboarding__icon">${icons.connect}</div>
        <h1>Where do your customers find you?</h1>
        <p>Select the platforms you use. We'll help you track how people move through your funnel.</p>
        <span class="onboarding__skip-hint">This is optional — you can always add these later!</span>
      </div>

      <div class="onboarding__platforms">
        ${PLATFORM_CONFIGS.map(platform => html`
          <button 
            class="onboarding__platform ${state.selectedPlatforms.includes(platform.id) ? 'selected' : ''}"
            style="--platform-color: ${platform.color}"
            @click=${() => togglePlatform(platform.id)}>
            <div class="onboarding__platform-icon">${platform.icon}</div>
            <span class="onboarding__platform-name">${platform.name}</span>
            ${state.selectedPlatforms.includes(platform.id) ? html`
              <span class="onboarding__platform-check">${icons.check}</span>
            ` : nothing}
          </button>
        `)}
      </div>

      <div class="onboarding__summary">
        <h3>Ready to launch! ${icons.sparkles}</h3>
        <div class="onboarding__summary-items">
          <div class="onboarding__summary-item">
            <strong>Business:</strong> ${businessLabel}
            ${businessIndustryLabel ? html` <span class="onboarding__summary-tag">${businessIndustryLabel}</span>` : nothing}
          </div>
          <div class="onboarding__summary-item">
            <strong>Template:</strong> ${state.selectedTemplate 
              ? TEMPLATE_CONFIGS.find(t => t.id === state.selectedTemplate)?.name 
              : "Starting from scratch"}
          </div>
          ${state.selectedPlatforms.length > 0 ? html`
            <div class="onboarding__summary-item">
              <strong>Platforms:</strong> ${state.selectedPlatforms.map(p => 
                PLATFORM_CONFIGS.find(c => c.id === p)?.name
              ).join(", ")}
            </div>
          ` : nothing}
        </div>
      </div>

      <div class="onboarding__actions">
        <button class="onboarding__btn onboarding__btn--secondary" @click=${() => goToStep(2)}>
          ${icons.arrowLeft}
          Back
        </button>
        <button 
          class="onboarding__btn onboarding__btn--primary onboarding__btn--launch"
          ?disabled=${state.isCreating}
          @click=${handleComplete}>
          ${state.isCreating ? html`
            <span class="onboarding__spinner"></span>
            Creating your funnel...
          ` : html`
            ${icons.sparkles}
            Create My Funnel!
          `}
        </button>
      </div>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Styles
// ══════════════════════════════════════════════════════════════════════════════

const onboardingStyles = `
  .onboarding {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100%;
    padding: 40px 20px;
    background: linear-gradient(180deg, var(--glass-3) 0%, var(--glass-3) 50%, var(--glass-3) 100%);
    font-family: 'Inter', -apple-system, sans-serif;
  }

  .onboarding__container {
    width: 100%;
    max-width: 800px;
  }

  /* Progress indicator */
  .onboarding__progress {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0;
    margin-bottom: 48px;
  }

  .onboarding__progress-step {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }

  .onboarding__progress-dot {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: var(--glass-3);
    border: 2px solid var(--glass-stroke);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    font-weight: 600;
    color: var(--glass-fg-3);
    transition: all 0.3s ease;
  }

  .onboarding__progress-step.active .onboarding__progress-dot {
    border-color: var(--g-primary);
    color: var(--g-primary);
  }

  .onboarding__progress-step.current .onboarding__progress-dot {
    background: linear-gradient(135deg, var(--g-primary), #f59e0b);
    border-color: var(--g-primary);
    color: var(--glass-ink);
    box-shadow: 0 0 20px color-mix(in srgb, var(--glass-gold) 30%, transparent);
  }

  .onboarding__progress-step.active .onboarding__progress-dot svg {
    width: 16px;
    height: 16px;
    stroke: var(--g-primary);
  }

  .onboarding__progress-label {
    font-size: 12px;
    color: var(--glass-fg-3);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .onboarding__progress-step.active .onboarding__progress-label {
    color: var(--glass-fg-2);
  }

  .onboarding__progress-step.current .onboarding__progress-label {
    color: var(--g-primary);
  }

  .onboarding__progress-line {
    width: 60px;
    height: 2px;
    background: var(--glass-3);
    margin: 0 8px 24px;
    transition: background 0.3s ease;
  }

  .onboarding__progress-line.active {
    background: linear-gradient(90deg, var(--g-primary), #f59e0b);
  }

  /* Content */
  .onboarding__content {
    background: rgba(20, 20, 20, 0.8);
    border: 1px solid color-mix(in srgb, var(--glass-gold) 10%, transparent);
    border-radius: 16px;
    padding: 40px;
  }

  .onboarding__step {
    animation: fadeIn 0.3s ease;
  }

  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(10px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .onboarding__header {
    text-align: center;
    margin-bottom: 32px;
  }

  .onboarding__icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 80px;
    height: 80px;
    border-radius: 20px;
    background: linear-gradient(135deg, color-mix(in srgb, var(--glass-gold) 20%, transparent), color-mix(in srgb, var(--glass-gold) 10%, transparent));
    margin-bottom: 20px;
  }

  .onboarding__icon svg {
    stroke: var(--g-primary);
  }

  .onboarding__header h1 {
    font-size: 28px;
    font-weight: 700;
    color: var(--glass-fg);
    margin: 0 0 12px;
  }

  .onboarding__header p {
    font-size: 16px;
    color: var(--glass-fg-3);
    margin: 0;
    max-width: 500px;
    margin: 0 auto;
    line-height: 1.5;
  }

  .onboarding__skip-hint {
    display: inline-block;
    margin-top: 12px;
    font-size: 13px;
    color: var(--glass-fg-3);
    font-style: italic;
  }

  /* Form */
  .onboarding__form {
    max-width: 500px;
    margin: 0 auto;
  }

  .onboarding__field {
    margin-bottom: 24px;
  }

  .onboarding__field label {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
    font-weight: 500;
    color: var(--glass-fg-2);
    margin-bottom: 10px;
  }

  .onboarding__optional {
    color: var(--glass-fg-3);
    font-weight: 400;
  }

  .onboarding__help-btn {
    background: none;
    border: none;
    padding: 2px;
    cursor: help;
    color: var(--glass-fg-3);
    transition: color 0.2s;
  }

  .onboarding__help-btn:hover {
    color: var(--g-primary);
  }

  .onboarding__field input,
  .onboarding__field select {
    width: 100%;
    padding: 14px 16px;
    background: var(--glass-3);
    border: 1px solid var(--glass-stroke);
    border-radius: 8px;
    font-size: 16px;
    color: var(--glass-fg);
    transition: border-color 0.2s, box-shadow 0.2s;
    font-family: inherit;
  }

  .onboarding__field input:focus,
  .onboarding__field select:focus {
    outline: none;
    border-color: var(--g-primary);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--glass-gold) 10%, transparent);
  }

  .onboarding__field input::placeholder {
    color: var(--glass-fg-4);
  }

  /* Native <select> appearance differs by browser — match the input's dark
     background so the dropdown isn't a bright white popover. */
  .onboarding__field select option {
    background: var(--glass-3);
    color: var(--glass-fg);
  }

  /* Industry grid */
  .onboarding__industry-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .onboarding__industry-btn {
    padding: 8px 14px;
    background: var(--glass-3);
    border: 1px solid var(--glass-stroke);
    border-radius: 20px;
    font-size: 13px;
    color: var(--glass-fg-3);
    cursor: pointer;
    transition: all 0.2s;
  }

  .onboarding__industry-btn:hover {
    border-color: var(--glass-stroke-strong);
    color: var(--glass-fg-2);
  }

  .onboarding__industry-btn.selected {
    background: linear-gradient(135deg, color-mix(in srgb, var(--glass-gold) 20%, transparent), color-mix(in srgb, var(--glass-gold) 10%, transparent));
    border-color: var(--g-primary);
    color: var(--g-primary);
  }

  /* Templates */
  .onboarding__templates {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 16px;
    margin-bottom: 24px;
  }

  .onboarding__template {
    background: var(--glass-3);
    border: 1px solid var(--glass-stroke);
    border-radius: 12px;
    padding: 16px;
    text-align: left;
    cursor: pointer;
    transition: all 0.2s;
  }

  .onboarding__template:hover {
    border-color: var(--glass-stroke-strong);
    transform: translateY(-2px);
  }

  .onboarding__template.selected {
    border-color: var(--template-color, var(--g-primary));
    background: linear-gradient(135deg, rgba(var(--template-color-rgb, 251, 191, 36), 0.1), transparent);
    box-shadow: 0 0 20px rgba(var(--template-color-rgb, 251, 191, 36), 0.15);
  }

  .onboarding__template-header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 10px;
  }

  .onboarding__template-emoji {
    font-size: 24px;
  }

  .onboarding__template-name {
    font-size: 15px;
    font-weight: 600;
    color: var(--glass-fg);
    flex: 1;
  }

  .onboarding__template-check {
    color: var(--template-color, var(--g-primary));
  }

  .onboarding__template-desc {
    font-size: 13px;
    color: var(--glass-fg-3);
    margin: 0 0 12px;
    line-height: 1.4;
  }

  .onboarding__template-meta {
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 11px;
    color: var(--glass-fg-3);
    text-transform: uppercase;
    letter-spacing: 0.3px;
  }

  .onboarding__template-steps {
    background: var(--glass-3);
    padding: 3px 8px;
    border-radius: 4px;
  }

  /* Platforms */
  .onboarding__platforms {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 12px;
    margin-bottom: 32px;
  }

  .onboarding__platform {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    width: 100px;
    padding: 16px 12px;
    background: var(--glass-3);
    border: 1px solid var(--glass-stroke);
    border-radius: 12px;
    cursor: pointer;
    transition: all 0.2s;
    position: relative;
  }

  .onboarding__platform:hover {
    border-color: var(--glass-stroke-strong);
    transform: translateY(-2px);
  }

  .onboarding__platform.selected {
    border-color: var(--platform-color, var(--g-primary));
    background: linear-gradient(135deg, color-mix(in srgb, var(--glass-fg) 5%, transparent), transparent);
  }

  .onboarding__platform-icon {
    color: var(--glass-fg-3);
    transition: color 0.2s;
  }

  .onboarding__platform.selected .onboarding__platform-icon {
    color: var(--platform-color, var(--g-primary));
  }

  .onboarding__platform-name {
    font-size: 12px;
    color: var(--glass-fg-3);
    transition: color 0.2s;
  }

  .onboarding__platform.selected .onboarding__platform-name {
    color: var(--glass-fg);
  }

  .onboarding__platform-check {
    position: absolute;
    top: -6px;
    right: -6px;
    width: 20px;
    height: 20px;
    background: var(--platform-color, var(--g-primary));
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .onboarding__platform-check svg {
    width: 12px;
    height: 12px;
    stroke: var(--glass-ink);
  }

  /* Summary */
  .onboarding__summary {
    background: color-mix(in srgb, var(--glass-gold) 5%, transparent);
    border: 1px solid color-mix(in srgb, var(--glass-gold) 20%, transparent);
    border-radius: 12px;
    padding: 20px;
    margin-bottom: 24px;
  }

  .onboarding__summary h3 {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 16px;
    font-weight: 600;
    color: var(--g-primary);
    margin: 0 0 12px;
  }

  .onboarding__summary h3 svg {
    stroke: var(--g-primary);
  }

  .onboarding__summary-items {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .onboarding__summary-item {
    font-size: 14px;
    color: var(--glass-fg-2);
  }

  .onboarding__summary-item strong {
    color: var(--glass-fg-3);
    font-weight: 500;
    margin-right: 4px;
  }

  .onboarding__summary-tag {
    display: inline-block;
    background: var(--glass-3);
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 12px;
    color: var(--glass-fg-3);
    margin-left: 6px;
  }

  /* Actions */
  .onboarding__actions {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    margin-top: 32px;
  }

  .onboarding__btn {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 14px 24px;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
    border: none;
  }

  .onboarding__btn--secondary {
    background: transparent;
    border: 1px solid var(--glass-stroke);
    color: var(--glass-fg-3);
  }

  .onboarding__btn--secondary:hover {
    border-color: var(--glass-stroke-strong);
    color: var(--glass-fg-2);
  }

  .onboarding__btn--primary {
    background: linear-gradient(135deg, var(--g-primary), #f59e0b);
    color: var(--glass-ink);
  }

  .onboarding__btn--primary:hover:not(:disabled) {
    transform: translateY(-2px);
    box-shadow: 0 4px 20px color-mix(in srgb, var(--glass-gold) 30%, transparent);
  }

  .onboarding__btn--primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .onboarding__btn--launch {
    padding: 16px 32px;
    font-size: 16px;
  }

  .onboarding__spinner {
    width: 18px;
    height: 18px;
    border: 2px solid transparent;
    border-top-color: currentColor;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  /* Error */
  .onboarding__error {
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.3);
    color: #f87171;
    padding: 12px 16px;
    border-radius: 8px;
    margin-top: 16px;
    text-align: center;
    font-size: 14px;
  }

  /* Responsive */
  @media (max-width: 640px) {
    .onboarding__content {
      padding: 24px 20px;
    }

    .onboarding__header h1 {
      font-size: 22px;
    }

    .onboarding__templates {
      grid-template-columns: 1fr;
    }

    .onboarding__progress-label {
      display: none;
    }

    .onboarding__progress-line {
      margin-bottom: 0;
    }

    .onboarding__actions {
      flex-direction: column-reverse;
    }

    .onboarding__btn {
      width: 100%;
      justify-content: center;
    }
  }
`;
