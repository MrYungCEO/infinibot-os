/**
 * Kingly Vault — AI-Powered Personalized Learning Path Onboarding
 * Multi-step full-page wizard that interviews the user and generates
 * a tailored learning path from available courses.
 */

import { html, nothing } from "lit";
import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";
import type { LearningPath, LearningPathOnboardingAnswers } from "../../../src/vault/store/types";
import { g8GlassStyles } from "./glass-g8.js";

// ── Step Configuration ──

interface OnboardingStep {
  id: string;
  label: string;
}

const STEPS: OnboardingStep[] = [
  { id: "welcome", label: "Welcome" },
  { id: "interests", label: "Interests" },
  { id: "goals", label: "Goals" },
  { id: "skill", label: "Skill Level" },
  { id: "commitment", label: "Commitment" },
  { id: "focus", label: "Focus" },
  { id: "generating", label: "Creating" },
  { id: "result", label: "Your Path" },
];

const INTEREST_OPTIONS = [
  "Automation", "AI & Machine Learning", "Content Creation",
  "Digital Products", "Business Strategy", "Notion & Productivity",
  "Mindset & Psychology", "Crypto & Web3", "Design & Branding",
  "Marketing & Sales", "Video Production", "Data Analysis",
];

const GOAL_OPTIONS = [
  "Start a side business", "Scale an existing business",
  "Build a personal brand", "Learn new skills for career growth",
  "Automate my workflow", "Create digital products",
  "Master productivity systems", "Generate passive income",
];

const FOCUS_OPTIONS = [
  "Build no-code automations", "Create and sell digital products",
  "Develop a success mindset", "Master Notion for productivity",
  "Build a content engine", "Generate AI-powered visuals",
  "Navigate crypto markets", "All of the above",
];

// ── Icons ──

const ICONS = {
  crown: html`<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 4l3 12h14l3-12-6 4-4-8-4 8-6-4z"/><path d="M3 20h18"/></svg>`,
  compass: html`<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>`,
  target: html`<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>`,
  brain: html`<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2a7 7 0 0 1 7 7c0 2.4-1.2 4.5-3 5.7V16a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1v-1.3a7 7 0 0 1-3-5.7 7 7 0 0 1 7-7z"/><path d="M9 14h6"/><path d="M9 11h6"/></svg>`,
  clock: html`<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
  sparkles: html`<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 3l1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5z"/><path d="M18 14l1 2.5L21.5 18l-2.5 1L18 21.5 16.5 19 14 18l2.5-1z"/></svg>`,
  check: html`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>`,
  arrowLeft: html`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>`,
};

// ── State ──

interface OnboardingWizardState {
  step: number;
  answers: {
    interests: string[];
    goals: string[];
    skillLevel: LearningPathOnboardingAnswers["skillLevel"];
    hoursPerWeek: number;
    wantToLearn: string;
  };
  generating: boolean;
  error: string;
  learningPath: LearningPath | null;
}

function makeState(): OnboardingWizardState {
  return {
    step: 0,
    answers: { interests: [], goals: [], skillLevel: "beginner", hoursPerWeek: 5, wantToLearn: "" },
    generating: false,
    error: "",
    learningPath: null,
  };
}

// ── Progress Bar ──

function renderProgress(state: OnboardingWizardState, total: number) {
  const displaySteps = STEPS.slice(0, total);
  const current = state.step;
  return html`
    <div class="vo-progress">
      <div class="vo-progress-steps">
        ${displaySteps.map((s, i) => {
          const cls = i === current ? "active" : i < current ? "completed" : "";
          return html`
            <div class="vo-progress-step ${cls}" title=${s.label}>
              <span class="vo-step-label">${s.label}</span>
            </div>
            ${i < displaySteps.length - 1
              ? html`<div class="vo-progress-step-line ${i < current ? "filled" : ""}"></div>`
              : nothing}
          `;
        })}
      </div>
      <span class="vo-progress-label">${current + 1} / ${displaySteps.length}</span>
    </div>
  `;
}

// ── Step Renderers ──

function renderWelcome(state: OnboardingWizardState, next: () => void) {
  return html`
    <div class="vo-step">
      <div class="vo-hero">
        <div class="vo-hero-icon">${ICONS.crown}</div>
        <h1>Your Kingdom Awaits</h1>
        <p>
          Welcome to the Kingly Vault. Let us craft a personalized learning path
          forged from your ambitions — drawing from our curated courses to build
          a journey that's truly yours.
        </p>
      </div>
      <div class="vo-actions">
        <button class="vo-btn primary" @click=${next}>
          Begin Your Path
        </button>
      </div>
    </div>
  `;
}

function renderInterests(state: OnboardingWizardState, update: (s: Partial<OnboardingWizardState>) => void, next: () => void) {
  const sel = state.answers.interests;
  return html`
    <div class="vo-step">
      <div class="vo-hero">
        <div class="vo-hero-icon">${ICONS.compass}</div>
        <h1>What Interests You?</h1>
        <p>Select the areas that spark your curiosity. You can pick multiple.</p>
      </div>
      <div class="vo-form">
        <div class="vo-field-group">
          <span class="vo-label">Pick your interests</span>
          <div class="vo-tags">
            ${INTEREST_OPTIONS.map(
              (opt) => html`
                <span
                  class="vo-tag ${sel.includes(opt) ? "selected" : ""}"
                  @click=${() => {
                    const next = sel.includes(opt)
                      ? sel.filter((s) => s !== opt)
                      : [...sel, opt];
                    update({ answers: { ...state.answers, interests: next } });
                  }}
                >${opt}</span>
              `
            )}
          </div>
        </div>
      </div>
      <div class="vo-actions">
        <button class="vo-btn primary" ?disabled=${sel.length === 0} @click=${next}>
          Continue
        </button>
      </div>
    </div>
  `;
}

function renderGoals(state: OnboardingWizardState, update: (s: Partial<OnboardingWizardState>) => void, next: () => void) {
  const sel = state.answers.goals;
  return html`
    <div class="vo-step">
      <div class="vo-hero">
        <div class="vo-hero-icon">${ICONS.target}</div>
        <h1>What Are Your Goals?</h1>
        <p>What do you hope to achieve on your journey?</p>
      </div>
      <div class="vo-form">
        <div class="vo-field-group">
          <span class="vo-label">Select your goals</span>
          <div class="vo-tags">
            ${GOAL_OPTIONS.map(
              (opt) => html`
                <span
                  class="vo-tag ${sel.includes(opt) ? "selected" : ""}"
                  @click=${() => {
                    const next = sel.includes(opt)
                      ? sel.filter((s) => s !== opt)
                      : [...sel, opt];
                    update({ answers: { ...state.answers, goals: next } });
                  }}
                >${opt}</span>
              `
            )}
          </div>
        </div>
      </div>
      <div class="vo-actions">
        <button class="vo-btn secondary" @click=${() => update({ step: state.step - 1 })}>
          ${ICONS.arrowLeft} Back
        </button>
        <button class="vo-btn primary" @click=${next}>
          Continue
        </button>
      </div>
    </div>
  `;
}

function renderSkillLevel(state: OnboardingWizardState, update: (s: Partial<OnboardingWizardState>) => void, next: () => void) {
  const skill = state.answers.skillLevel;
  const options: { value: LearningPathOnboardingAnswers["skillLevel"]; label: string; desc: string }[] = [
    { value: "beginner", label: "Beginner", desc: "New to these topics" },
    { value: "intermediate", label: "Intermediate", desc: "Some experience" },
    { value: "advanced", label: "Advanced", desc: "Experienced and skilled" },
  ];
  return html`
    <div class="vo-step">
      <div class="vo-hero">
        <div class="vo-hero-icon">${ICONS.brain}</div>
        <h1>Your Current Level</h1>
        <p>Where would you place yourself today?</p>
      </div>
      <div class="vo-form">
        <div class="vo-field-group">
          <span class="vo-label">Experience Level</span>
          <div class="vo-pills">
            ${options.map(
              (o) => html`
                <div
                  class="vo-pill ${skill === o.value ? "selected" : ""}"
                  @click=${() => update({ answers: { ...state.answers, skillLevel: o.value } })}
                >
                  <div style="font-weight:600;margin-bottom:2px">${o.label}</div>
                  <div style="font-size:11px;color:var(--vo-text-muted)">${o.desc}</div>
                </div>
              `
            )}
          </div>
        </div>
      </div>
      <div class="vo-actions">
        <button class="vo-btn secondary" @click=${() => update({ step: state.step - 1 })}>
          ${ICONS.arrowLeft} Back
        </button>
        <button class="vo-btn primary" @click=${next}>
          Continue
        </button>
      </div>
    </div>
  `;
}

function renderCommitment(state: OnboardingWizardState, update: (s: Partial<OnboardingWizardState>) => void, next: () => void) {
  const hrs = state.answers.hoursPerWeek;
  const presets = [2, 5, 10, 20];
  return html`
    <div class="vo-step">
      <div class="vo-hero">
        <div class="vo-hero-icon">${ICONS.clock}</div>
        <h1>Your Time Commitment</h1>
        <p>How many hours per week can you dedicate to learning?</p>
      </div>
      <div class="vo-form">
        <div class="vo-field-group">
          <span class="vo-label">Hours per week</span>
          <div class="vo-pills">
            ${presets.map(
              (h) => html`
                <div
                  class="vo-pill ${hrs === h ? "selected" : ""}"
                  @click=${() => update({ answers: { ...state.answers, hoursPerWeek: h } })}
                >${h} hrs</div>
              `
            )}
          </div>
          <input
            class="vo-input"
            type="number"
            min="1"
            max="80"
            .value=${String(hrs)}
            @input=${(e: InputEvent) => {
              const v = parseInt((e.target as HTMLInputElement).value, 10);
              if (v > 0) update({ answers: { ...state.answers, hoursPerWeek: v } });
            }}
          />
        </div>
      </div>
      <div class="vo-actions">
        <button class="vo-btn secondary" @click=${() => update({ step: state.step - 1 })}>
          ${ICONS.arrowLeft} Back
        </button>
        <button class="vo-btn primary" @click=${next}>
          Continue
        </button>
      </div>
    </div>
  `;
}

function renderFocus(state: OnboardingWizardState, update: (s: Partial<OnboardingWizardState>) => void, next: () => void) {
  const want = state.answers.wantToLearn;
  const selFocus = state.answers.goals.find((g) => FOCUS_OPTIONS.includes(g));
  return html`
    <div class="vo-step">
      <div class="vo-hero">
        <div class="vo-hero-icon">${ICONS.sparkles}</div>
        <h1>What Excites You Most?</h1>
        <p>Tell us what you really want to learn — or type your own focus area.</p>
      </div>
      <div class="vo-form">
        <div class="vo-field-group">
          <span class="vo-label">Choose a focus or write your own</span>
          <div class="vo-tags">
            ${FOCUS_OPTIONS.map(
              (opt) => html`
                <span
                  class="vo-tag ${want === opt ? "selected" : ""}"
                  @click=${() => update({ answers: { ...state.answers, wantToLearn: want === opt ? "" : opt } })}
                >${opt}</span>
              `
            )}
          </div>
        </div>
        <div class="vo-field-group">
          <span class="vo-label">Or write your own focus</span>
          <textarea
            class="vo-input vo-textarea"
            placeholder="e.g., I want to build AI-powered marketing funnels..."
            .value=${FOCUS_OPTIONS.includes(want) ? "" : want}
            @input=${(e: InputEvent) => {
              const v = (e.target as HTMLTextAreaElement).value;
              update({ answers: { ...state.answers, wantToLearn: v } });
            }}
          ></textarea>
        </div>
      </div>
      <div class="vo-actions">
        <button class="vo-btn secondary" @click=${() => update({ step: state.step - 1 })}>
          ${ICONS.arrowLeft} Back
        </button>
        <button class="vo-btn primary" @click=${next}>
          Generate My Path
        </button>
      </div>
    </div>
  `;
}

function renderGenerating() {
  return html`
    <div class="vo-step">
      <div class="vo-generating">
        <div class="vo-generating-spinner"></div>
        <h2>Forging Your Path</h2>
        <p>Analyzing your interests and matching with available courses...</p>
      </div>
    </div>
  `;
}

function renderResult(state: OnboardingWizardState, reset: () => void) {
  const lp = state.learningPath;
  if (!lp) {
    return html`
      <div class="vo-step">
        <div class="vo-error">
          <p>${state.error || "Something went wrong generating your path."}</p>
          <button class="vo-btn primary" @click=${reset}>Try Again</button>
        </div>
      </div>
    `;
  }

  return html`
    <div class="vo-step">
      <div class="vo-result">
        <div class="vo-result-header">
          <div class="vo-hero-icon">${ICONS.crown}</div>
          <h2>Your Learning Path</h2>
          <p>${lp.summary}</p>
        </div>

        <div class="vo-summary-card">
          <div class="vo-summary-stat">
            <span class="vo-summary-stat-value">${lp.totalWeeks}</span>
            <span class="vo-summary-stat-label">Weeks</span>
          </div>
          <div class="vo-summary-stat">
            <span class="vo-summary-stat-value">${lp.totalCourses}</span>
            <span class="vo-summary-stat-label">Courses</span>
          </div>
          <div class="vo-summary-stat">
            <span class="vo-summary-stat-value">${lp.answers.hoursPerWeek}h</span>
            <span class="vo-summary-stat-label">Per Week</span>
          </div>
        </div>

        ${lp.weeks.map(
          (w) => html`
            <div class="vo-week-card">
              <div class="vo-week-header">
                <span class="vo-week-title">Week ${w.week}</span>
                <span class="vo-week-focus">${w.focus}</span>
              </div>
              <div class="vo-week-courses">
                ${w.courses.map(
                  (c) => html`<span class="vo-week-course" title=${c.reason}>${c.name}</span>`
                )}
              </div>
            </div>
          `
        )}

        <div class="vo-actions">
          <button class="vo-btn primary" @click=${reset}>
            ${ICONS.check} Path Saved — Start Learning
          </button>
        </div>
      </div>
    </div>
  `;
}

// ── Render Entry Point ──

export function injectVaultOnboardingStyles() {
  if (document.querySelector("#vault-onboarding-styles")) return;
  const link = document.createElement("link");
  link.id = "vault-onboarding-styles";
  link.rel = "stylesheet";
  link.href = "/styles/vault-onboarding.css";
  document.head.appendChild(link);
}

export function renderVaultOnboarding(
  state: AppViewState,
  gw: GatewayBrowserClient,
  requestUpdate: () => void,
) {
  injectVaultOnboardingStyles();

  const wizard: OnboardingWizardState = (state as any).__vaultOnboarding ?? makeState();
  (state as any).__vaultOnboarding = wizard;

  const update = (patch: Partial<OnboardingWizardState>) => {
    Object.assign(wizard, patch);
    requestUpdate();
  };

  const stepsBeforeGenerate = 5; // welcome + interests + goals + skill + commitment
  const totalSteps = 7; // the above + focus + result (generating is transient)

  const generatePath = async () => {
    update({ generating: true, error: "" });
    try {
      const memberId = "current"; // Gateway resolves to the current user/session member
      const result = await gw.request<{ learningPath: LearningPath }>("vault.learningPath.generate", {
        memberId,
        interests: wizard.answers.interests,
        goals: wizard.answers.goals,
        skillLevel: wizard.answers.skillLevel,
        hoursPerWeek: wizard.answers.hoursPerWeek,
        wantToLearn: wizard.answers.wantToLearn,
      });
      if (result?.learningPath) {
        update({ learningPath: result.learningPath, generating: false, step: totalSteps });
      } else {
        update({ generating: false, error: "No path returned. Please try again." });
      }
    } catch (e: any) {
      update({ generating: false, error: e?.message || "Failed to generate path. Try again." });
    }
  };

  const next = () => {
    if (wizard.step < stepsBeforeGenerate) {
      update({ step: wizard.step + 1 });
    } else if (wizard.step === stepsBeforeGenerate) {
      // Move to generating state
      update({ step: 6 });
      generatePath();
    }
  };

  const reset = () => {
    (state as any).__vaultOnboarding = makeState();
    requestUpdate();
  };

  return html`
    ${g8GlassStyles}
    <div class="vault-onboarding g8-page">
      ${wizard.step < totalSteps ? renderProgress(wizard, totalSteps) : nothing}

      ${wizard.step === 0 ? renderWelcome(wizard, next) : nothing}
      ${wizard.step === 1 ? renderInterests(wizard, update, next) : nothing}
      ${wizard.step === 2 ? renderGoals(wizard, update, next) : nothing}
      ${wizard.step === 3 ? renderSkillLevel(wizard, update, next) : nothing}
      ${wizard.step === 4 ? renderCommitment(wizard, update, next) : nothing}
      ${wizard.step === 5 ? renderFocus(wizard, update, next) : nothing}
      ${wizard.step === 6 ? renderGenerating() : nothing}
      ${wizard.step === 7 ? renderResult(wizard, reset) : nothing}
    </div>
  `;
}
