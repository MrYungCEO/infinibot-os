/**
 * <ib-onboarding-flow> — the local first-run onboarding (Setup › Wizard).
 *
 * One flow, the same design as InfiniBot Cloud's workspace setup (it reuses
 * the cloud console styles), plus the local-only options the cloud can't
 * offer:
 *
 *   01 Use      "What are you using InfiniBot for?" (multi-select)
 *   02 Brain    "Which of these do you already have?" ChatGPT / Grok / Google
 *               (free) / Claude: install, sign in and a test message, all
 *               automatic (onboarding/cli-setup.ts). More options: a model on
 *               this computer (Ollama / vLLM) or an API key.
 *               "Start chatting" opens the first chat (onboarding/first-chat.ts).
 *   03 Channels Telegram (guided), WhatsApp (QR or phone pairing code), Discord
 *   04 Voice    one-click local voice (<ib-local-voice-setup>: Docker + Speaches
 *               + Kokoro, installed and tested for you) or cloud (Robovoice), mic test
 *   05 Phone    "Reach InfiniBot from anywhere" (Tailscale + MagicDNS private
 *               link, <ib-remote-access-setup>), then Android or iPhone: install
 *               path, pairing QR and Add to Home Screen (<ib-phone-app-setup>)
 *   06 Privacy  Secure Mode: private chats stay on this computer
 *   07 Plan     recommended plugins, courses and starter setup
 *   08 Finish   apply, then the first course starts on the Chat page
 *
 * Every step is optional and skippable; progress and answers are saved as
 * you go (localStorage + the gateway's onboarding.profile) so a reload or a
 * gateway restart resumes on the same step.
 */
import { LitElement, html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import type { GatewayBrowserClient } from "../gateway";
import "../components/kv-connect.js";
import { icon, type IconName } from "../icons";
import { isTabAvailable } from "../plugin-host.js";
import { renderTerminalGround, terminalAmbientStyles } from "../saas-terminal-ambient";
import { BRAND_DEFAULT_LOGO } from "./branding-modal";
import { g8GlassStyles } from "./glass-g8.js";
import { onboardingStyles } from "./saas-onboarding";
import { setupStyles } from "./saas-onboarding-setup";
import "../components/telegram-setup";
import "../components/robovoice-link.js";
import "../components/local-voice-setup.js";
import "../components/pair-invite-panel.js";
import "../components/remote-access-setup.js";
import "../components/phone-app-setup.js";
import "../components/browser-connect-setup.js";
import "../components/mcp-clients-setup.js";
import "../components/kv-connect-card.js";
import "../components/provider-logo.js";
import { USE_CASES, FIRST_COURSE, planFor, type OnboardingPlan, type UseCaseId } from "../onboarding/use-cases";
import {
  clearProgress,
  loadLocalProfile,
  loadProgress,
  persistProfile,
  saveProgress,
  syncProfile,
  type OnboardingProgress,
  type StepId,
  type UseCaseProfile,
} from "../onboarding/profile";
import { decidePlugin, defaultEnableSet, type PluginDecision } from "../onboarding/plugin-gating";
import { IDLE_MIC, MicTest, micHeard, type MicTestState } from "../onboarding/mic-test";
import { createTelegramTestBackend, isTelegramTestMode } from "../onboarding/telegram-test-backend";
import type { TelegramSetupBackend } from "../components/telegram-setup-backend";
import { availableTracks, loadGuidedCatalog } from "../../learn/guided/catalog-store";
import { startTrack } from "../../learn/guided/engine";
import { createPath, currentPath, startPath, type PathItem } from "../../learn/guided/learning-path";
import { markFirstRunItem, setFirstRunStatus } from "../controllers/first-run";
import { CLOUD_VOICE_PROVIDER_ID, selectVoiceProvider, switchToLocalVoice } from "../controllers/voice-provider";
import {
  BRAIN_PROVIDERS,
  getBrainProvider,
  saveBrainProvider,
  toModelOptions,
  type BrainModelOption,
  type BrainProvider,
} from "../lib/brain-providers";
import { onboardingFlowStyles } from "./onboarding-flow.styles";
import { CliRoutingModel, copyText, type CliRoutingStatus } from "../controllers/cli-routing";
import {
  BEGINNER_CARDS,
  CliSetupRunner,
  GOOGLE_ID,
  cardSubtitle,
  cliDemoState,
  demoStatus,
  type CliSetupView,
  type CliStepState,
} from "../onboarding/cli-setup";
import { firstChatDone, prepareFirstChat } from "../onboarding/first-chat";
import { renderSetupGuideButton } from "../setup-guide-video";
import { isCloudBuild } from "../cloud/cloud-env";
import {
  ONBOARDING_CLOSE_EVENT,
  SETUP_EDIT_DONE_EVENT,
  areaFor,
  describeApply,
  patchConfigLive,
  type EditDoneDetail,
  type EditableStep,
} from "../onboarding/setup-areas";

type Rpc = GatewayBrowserClient;
type Host = { setTab?: (tab: never) => void; requestUpdate?: () => void } | null;

interface StepDef {
  id: StepId;
  label: string;
  hint: string;
}

export const ONBOARDING_STEPS: readonly StepDef[] = [
  { id: "usecases", label: "Your goals", hint: "What it's for" },
  { id: "model", label: "AI brain", hint: "Your AI account" },
  { id: "channels", label: "Channels", hint: "Where you chat" },
  { id: "voice", label: "Voice", hint: "Talk out loud" },
  { id: "phone", label: "Phone", hint: "Phone and remote access" },
  { id: "browser", label: "Browser", hint: "Connect your Chrome" },
  { id: "aiapps", label: "AI apps", hint: "Claude, Cursor, Codex…" },
  { id: "kinglyvault", label: "KinglyVault", hint: "Optional · courses + KV agent" },
  { id: "privacy", label: "Privacy", hint: "Secure Mode" },
  { id: "recommend", label: "Your plan", hint: "Plugins and courses" },
  { id: "finish", label: "Finish", hint: "Review and go" },
];

const STEP_IDS = ONBOARDING_STEPS.map((s) => s.id);

type ChannelId = "web" | "telegram" | "whatsapp" | "discord";

interface LocalRuntime {
  id: string;
  label: string;
  kind?: string;
  providers?: string[];
  healthy?: boolean;
  loadedModels?: string[];
}

interface ApplyLine {
  label: string;
  status: "pending" | "ok" | "skip" | "fail";
  detail?: string;
}

const DASH_PRESET_KEY = "infinibot.dashboard.preset";
/** Finish result + the course still waiting to auto-start (survives the plugin restart). */
const RESULT_KEY = "infinibot.onboarding.result.v1";
const PENDING_COURSE_TTL_MS = 10 * 60_000;

interface FinishResult {
  applied: ApplyLine[];
  pendingCourse: string | null;
  at: number;
}

function readResult(): FinishResult | null {
  try {
    const v = JSON.parse(localStorage.getItem(RESULT_KEY) ?? "null") as FinishResult | null;
    return v && Array.isArray(v.applied) ? v : null;
  } catch {
    return null;
  }
}

function writeResult(r: FinishResult | null): void {
  try {
    if (r) localStorage.setItem(RESULT_KEY, JSON.stringify(r));
    else localStorage.removeItem(RESULT_KEY);
  } catch {
    /* storage blocked */
  }
}

function errText(err: unknown): string {
  return String((err as Error)?.message ?? err).replace(/^Error:\s*/, "").slice(0, 220);
}

/** Deep search (the app nests shadow roots) for the first match of `sel`. */
function findDeep(sel: string, root: Document | ShadowRoot = document): HTMLElement | null {
  const hit = root.querySelector<HTMLElement>(sel);
  if (hit) return hit;
  for (const el of root.querySelectorAll("*")) {
    if (el.shadowRoot) {
      const r = findDeep(sel, el.shadowRoot);
      if (r) return r;
    }
  }
  return null;
}

/** After routing away: focus the target page (the composer on Chat, else its heading). */
export function focusPage(tab: string, timeoutMs = 2500): void {
  if (typeof document === "undefined") return;
  const sel =
    tab === "webchat"
      ? "textarea"
      : "main h1, main h2, .content-header h2, .page-header h1, h1";
  const start = Date.now();
  const tick = () => {
    if (document.querySelector("ib-onboarding-flow")) return void setTimeout(tick, 60);
    const el = findDeep(sel);
    if (el && el.getClientRects().length) {
      if (el.tabIndex < 0 && !/^(TEXTAREA|INPUT|BUTTON|A)$/.test(el.tagName)) el.setAttribute("tabindex", "-1");
      el.focus({ preventScroll: true });
      return;
    }
    if (Date.now() - start < timeoutMs) setTimeout(tick, 60);
  };
  setTimeout(tick, 0);
}

/** Exposed for the Setup page: true once onboarding was finished in this browser. */
export function onboardingFinished(): boolean {
  return Boolean(loadProgress()?.finishedAt);
}

@customElement("ib-onboarding-flow")
export class OnboardingFlow extends LitElement {
  @property({ attribute: false }) client: Rpc | null = null;
  @property({ attribute: false }) host: Host = null;
  /**
   * Edit one area from Setup › Your setup: only this step, pre-filled from the
   * current config, then back to the summary (never step 1 or the next step).
   */
  @property({ attribute: false }) editStep: EditableStep | null = null;

  // ── progress ──
  @state() private step: StepId = "usecases";
  @state() private done = new Set<StepId>();
  @state() private skipped = new Set<StepId>();
  @state() private picked = new Set<UseCaseId>();

  // ── brain ──
  /** Under "More options": a model on this computer or an API key. */
  @state() private brainMode: "local" | "cloud" = "local";
  @state() private brainMore = false;
  @state() private currentPrimary: string | null = null;
  @state() private ollama: { running: boolean; host: string; models: string[] } | null = null;
  @state() private runtimes: LocalRuntime[] = [];
  @state() private localModel = "";
  @state() private provider = BRAIN_PROVIDERS[0]!.id;
  @state() private apiKey = "";
  @state() private cloudModel = BRAIN_PROVIDERS[0]!.model;
  @state() private showMoreProviders = false;
  /** Curated live list for the current key (chat-only, no retired models). Empty until "Check key". */
  @state() private cloudModels: BrainModelOption[] = [];
  @state() private cloudModelFilter = "";
  @state() private freeOnly = false;
  /** The current key passed "Check key" (models loaded). Gates Test & save. */
  @state() private keyChecked = false;
  @state() private brainBusy: string | null = null;
  @state() private brainMsg: { ok: boolean; text: string } | null = null;
  /** "My subscription": CLI routing status (null = loading / unavailable). */
  /** ?onbCliDemo=<state>: fake data, no RPC calls (visual checks). */
  private readonly cliDemo = cliDemoState();
  private cliModel = new CliRoutingModel(this, () => this.client, { onSignedIn: (id) => this.cliSetup.onSignedIn(id) });
  private cliSetup = new CliSetupRunner(this, this.cliModel, this.cliDemo, {
    onUseApiKey: () => {
      // Google ended Gemini CLI for free accounts: land on the API-key panel with Google picked.
      this.brainMore = true;
      this.brainMode = "cloud";
      this.provider = "google";
      this.apiKey = "";
      this.keyChecked = false;
      this.brainMsg = null;
    },
    onConnected: () => {
      this.done = new Set(this.done).add("model");
      this.skipped.delete("model");
      markFirstRunItem("provider");
      if (!this.cliDemo) this.persist();
    },
  });
  @state() private cliCode = "";
  @state() private cliCopied: "link" | "code" | "manual" | null = null;

  // ── channels ──
  @state() private channel: ChannelId = "web";
  @state() private telegramConnected = false;
  @state() private discordToken = "";
  @state() private wa: { mode: "qr" | "pairing"; phone: string; busy: boolean; qr: string | null; code: string | null; note: string | null; linked: boolean } = {
    mode: "qr",
    phone: "",
    busy: false,
    qr: null,
    code: null,
    note: null,
    linked: false,
  };
  @state() private channelMsg: { ok: boolean; text: string } | null = null;
  /** A Discord bot token is already saved in the config. */
  @state() private discordSaved = false;

  // ── voice ──
  @state() private voiceChoice: "local" | "cloud" | "later" = "local";
  @state() private engines: { kokoro: boolean; speaches: boolean } | null = null;
  @state() private voiceRuntime: { stt?: { reachable?: boolean; detail?: string }; tts?: { reachable?: boolean; detail?: string } } | null = null;
  @state() private voiceMsg: { ok: boolean; text: string } | null = null;
  @state() private mic: MicTestState = { ...IDLE_MIC };
  // ── phone ──
  /** The Tailscale link from <ib-remote-access-setup>, for the phone QR. */
  @state() private remoteLink: { url: string | null; verified: boolean } = { url: null, verified: false };
  // ── learning path (Finish) ──
  @state() private pathItems: PathItem[] = [];

  // ── privacy ──
  @state() private secure: { enabled: boolean; available: boolean } | null = null;
  @state() private secureBusy = false;
  @state() private secureMsg: string | null = null;

  // ── plan ──
  @state() private decisions: PluginDecision[] = [];
  @state() private pluginsLoaded = false;
  @state() private enable = new Set<string>();
  @state() private trackTitles = new Map<string, string>();
  @state() private makeTasks = true;
  @state() private setDashboard = true;

  // ── finish ──
  @state() private applying = false;
  @state() private applied: ApplyLine[] | null = null;
  @state() private finishedAt: number | null = null;
  @state() private countdown = 0;

  private mt: MicTest | null = null;
  private tgBackend: TelegramSetupBackend | null = isTelegramTestMode() ? createTelegramTestBackend() : null;
  private countdownTimer: ReturnType<typeof setInterval> | null = null;
  private loadedFor = new Set<StepId>();

  /** Light DOM: shares the cloud console stylesheet and stays reachable for Learn targets. */
  protected createRenderRoot() {
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    if (this.cliDemo) {
      // Demo: the brain step with fake data, nothing loaded or saved.
      this.step = "model";
      this.cliModel.status = demoStatus();
      return;
    }
    const progress = loadProgress();
    if (progress) {
      this.step = this.editStep ?? progress.step;
      this.done = new Set(progress.done);
      this.skipped = new Set(progress.skipped);
      this.finishedAt = progress.finishedAt ?? null;
    }
    if (this.editStep) this.step = this.editStep;
    const profile = loadLocalProfile();
    if (profile) this.applyProfile(profile);
    // Running setup again never redoes one-off extras unasked (a second starter
    // project, the dashboard layout someone already changed).
    if (profile?.completedAt || this.finishedAt) {
      this.rerun = true;
      this.makeTasks = false;
      this.setDashboard = false;
    }
    if (this.editStep) {
      this.editInitial = { picked: [...this.picked].sort().join(","), voice: this.voiceChoice };
      this.enterStep(this.step);
      return;
    }
    const result = this.finishedAt ? readResult() : null;
    if (result) {
      this.applied = result.applied;
      void loadGuidedCatalog().then(() => (this.pathItems = currentPath()?.items ?? []));
      if (result.pendingCourse && Date.now() - result.at < PENDING_COURSE_TTL_MS) {
        queueMicrotask(() => this.startCountdown());
      }
    }
    void syncProfile(this.client).then((p) => {
      if (p) this.applyProfile(p);
      // Finished on another device/browser: same rerun rules as above.
      if (p?.completedAt && !this.rerun && !this.applied) {
        this.rerun = true;
        this.makeTasks = false;
        this.setDashboard = false;
      }
    });
    this.enterStep(this.step);
  }

  private topObserver: ResizeObserver | null = null;

  /** Offset the screen under the app top bar (it stays usable for navigation). */
  private trackTopbar() {
    const find = (root: Document | ShadowRoot): HTMLElement | null => {
      const hit = root.querySelector<HTMLElement>(".topbar");
      if (hit) return hit;
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) {
          const r = find(el.shadowRoot);
          if (r) return r;
        }
      }
      return null;
    };
    const bar = find(document);
    const apply = () => {
      const r = bar?.getBoundingClientRect();
      const h = r && r.height > 0 && getComputedStyle(bar!).display !== "none" ? Math.round(r.bottom) : 0;
      this.style.setProperty("--iob-top", `${Math.max(0, h)}px`);
    };
    apply();
    if (bar && typeof ResizeObserver !== "undefined") {
      this.topObserver = new ResizeObserver(apply);
      this.topObserver.observe(bar);
    }
  }

  firstUpdated(): void {
    this.trackTopbar();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.topObserver?.disconnect();
    this.topObserver = null;
    this.mt?.stop();
    this.mt = null;
    if (this.countdownTimer) clearInterval(this.countdownTimer);
  }

  private applyProfile(p: UseCaseProfile) {
    if (p.useCases.length) this.picked = new Set(p.useCases);
    if (p.voice) this.voiceChoice = p.voice;
  }

  // ── navigation / persistence ───────────────────────────────────────────

  private persist() {
    if (this.cliDemo) return;
    const progress: OnboardingProgress = {
      step: this.editStep ? (loadProgress()?.step ?? "finish") : this.step,
      done: [...this.done],
      skipped: [...this.skipped],
      finishedAt: this.finishedAt,
    };
    saveProgress(progress);
  }

  private draftProfile(extra: Partial<UseCaseProfile> = {}): UseCaseProfile {
    const plan = this.plan();
    const prev = loadLocalProfile();
    return {
      useCases: [...this.picked],
      courses: plan.courses,
      plugins: [...new Set([...this.enable, ...this.decisions.filter((d) => d.action === "on").map((d) => d.id)])],
      agents: plan.agents,
      dashboard: plan.dashboard,
      localModels: this.brainMode === "local" && Boolean(this.localModel),
      secureMode: this.secure?.enabled ?? prev?.secureMode,
      voice: this.voiceChoice,
      updatedAt: Date.now(),
      completedAt: prev?.completedAt ?? null,
      ...extra,
    };
  }

  private plan(): OnboardingPlan {
    return planFor([...this.picked]);
  }

  private go(next: StepId, mark: "done" | "skipped" | null = null) {
    // Editing one area: "next" (Continue, Skip voice…) means save and return.
    if (this.editStep) return void this.saveEdit();
    if (mark === "done") {
      this.done = new Set(this.done).add(this.step);
      this.skipped.delete(this.step);
    } else if (mark === "skipped") {
      this.skipped = new Set(this.skipped).add(this.step);
    }
    if (this.step === "voice") {
      this.mt?.stop();
      void this.commitVoiceChoice();
    }
    if (this.step === "usecases") void persistProfile(this.client, this.draftProfile());
    this.step = next;
    this.persist();
    this.enterStep(next);
    void this.updateComplete.then(() => {
      const h = this.querySelector<HTMLElement>(".sob-panel h2");
      h?.focus({ preventScroll: false });
    });
  }

  private index(id: StepId = this.step): number {
    return STEP_IDS.indexOf(id);
  }

  private nextStep(): StepId {
    return STEP_IDS[Math.min(STEP_IDS.length - 1, this.index() + 1)]!;
  }

  private prevStep(): StepId {
    return STEP_IDS[Math.max(0, this.index() - 1)]!;
  }

  /** Lazy data loads per step (once per mount; buttons refresh explicitly). */
  private enterStep(id: StepId) {
    if (this.loadedFor.has(id)) return;
    this.loadedFor.add(id);
    if (id === "model") void this.loadBrain();
    if (id === "channels") void this.loadChannels();
    if (id === "voice") void this.loadVoice();
    if (id === "privacy") void this.loadSecure();
    if (id === "recommend" || id === "finish") void this.loadPlan();
  }

  /** Start over from step 1 (answers stay pre-filled from the saved profile). */
  restart() {
    this.cancelCountdown();
    writeResult(null);
    clearProgress();
    this.finishedAt = null;
    this.applied = null;
    this.done = new Set();
    this.skipped = new Set();
    this.loadedFor.clear();
    this.step = "usecases";
    this.persist();
    this.enterStep("usecases");
  }

  private openAdvanced() {
    this.persist();
    this.close();
    window.dispatchEvent(new CustomEvent("infinibot:setup-section", { detail: { section: "wizard-advanced" } }));
    this.host?.requestUpdate?.();
  }

  /** Leave the console for the Setup overview (progress is kept; Get started resumes it). */
  private exit() {
    if (this.editStep) return this.endEdit(false);
    this.persist();
    this.close();
    window.dispatchEvent(new CustomEvent("infinibot:setup-section", { detail: { section: "overview" } }));
    this.host?.setTab?.("setup" as never);
    this.host?.requestUpdate?.();
  }

  private toDashboard() {
    this.leave("dashboard");
  }

  /** Ask the Setup page to stop showing this full-screen flow. */
  private close() {
    window.dispatchEvent(new CustomEvent(ONBOARDING_CLOSE_EVENT));
  }

  /**
   * Every "go somewhere else" button: save progress, close the flow (it covers
   * the whole window, so a target under it never visibly opens), route, then
   * move focus to the target page.
   */
  private leave(tab: string) {
    this.cancelCountdown();
    this.persist();
    if (!this.cliDemo) void persistProfile(this.client, this.draftProfile());
    this.close();
    this.host?.setTab?.(tab as never);
    this.host?.requestUpdate?.();
    focusPage(tab);
  }

  // ── edit one area (Setup › Your setup) ─────────────────────────────────

  private editInitial: { picked: string; voice: string } | null = null;
  /** Setup was finished before: the plan starts from what's on now, not the recommendations. */
  private rerun = false;
  @state() private editBusy = false;
  @state() private editMsg: { ok: boolean; text: string } | null = null;
  /** Plugins that were on when the Plan edit opened (to save only what changed). */
  private pluginsOnAtOpen = new Set<string>();

  /** Back to the summary; `saved` + message show there. */
  private endEdit(saved: boolean, message?: string) {
    const step = this.editStep;
    if (!step) return;
    this.mt?.stop();
    window.dispatchEvent(new CustomEvent<EditDoneDetail>(SETUP_EDIT_DONE_EVENT, { detail: { step, saved, message } }));
    this.host?.requestUpdate?.();
  }

  /** Save this one area live, then return to the summary. */
  private async saveEdit() {
    const step = this.editStep;
    if (!step || this.editBusy) return;
    this.editBusy = true;
    this.editMsg = null;
    try {
      let message: string;
      if (step === "usecases") {
        await persistProfile(this.client, this.draftProfile());
        const plan = this.plan();
        const items = await createPath(plan.courses, [...this.picked]).catch(() => null);
        message = items ? `Goals saved. Your learning path now has ${items.length} lessons.` : "Goals saved.";
      } else if (step === "voice") {
        message = await this.saveVoiceEdit();
      } else if (step === "recommend") {
        message = await this.savePluginEdit();
      } else {
        // Brain, channels, phone and privacy apply as you go (their own buttons).
        message = `${areaFor(step)?.label ?? "Setting"} updated.`;
      }
      this.endEdit(true, message);
    } catch (err) {
      this.editMsg = { ok: false, text: errText(err) };
    } finally {
      this.editBusy = false;
    }
  }

  private async saveVoiceEdit(): Promise<string> {
    const before = this.editInitial?.voice;
    await persistProfile(this.client, this.draftProfile());
    if (this.voiceChoice === "cloud") {
      if (!isTabAvailable("robovoice")) return "Saved. Cloud voice needs the Robovoice plugin: turn it on under Plan · plugins.";
      await selectVoiceProvider(this.client!, CLOUD_VOICE_PROVIDER_ID);
      return "Cloud voice (Robovoice) is on. Applied live, no restart needed.";
    }
    if (before === "cloud" && this.client) {
      await switchToLocalVoice(this.client);
      return "Back on local voice. Applied live, no restart needed.";
    }
    return this.voiceChoice === "later" ? "Saved. Voice stays off until you set it up." : "Local voice saved. Applied live, no restart needed.";
  }

  /** Turn on / off only the plugins that changed. */
  private async savePluginEdit(): Promise<string> {
    const changed: Record<string, { enabled: boolean }> = {};
    for (const d of this.decisions) {
      if (d.action !== "enable" && d.action !== "on") continue;
      const now = this.enable.has(d.id);
      if (now !== this.pluginsOnAtOpen.has(d.id)) changed[d.id] = { enabled: now };
    }
    await persistProfile(this.client, this.draftProfile());
    const ids = Object.keys(changed);
    if (!ids.length) return "No plugin changes.";
    const snap = await this.rpc<{ config?: { plugins?: { allow?: unknown } } }>("config.get");
    const allow = snap?.config?.plugins?.allow;
    const patch: Record<string, unknown> = { entries: changed };
    const turnedOn = ids.filter((id) => changed[id]!.enabled);
    if (Array.isArray(allow) && allow.length > 0 && turnedOn.length) patch.allow = [...new Set([...(allow as string[]), ...turnedOn])];
    const res = await patchConfigLive(this.rpc.bind(this), { plugins: patch });
    const names = ids.map((id) => `${this.decisions.find((d) => d.id === id)?.name ?? id} ${changed[id]!.enabled ? "on" : "off"}`);
    return describeApply(res, `Saved: ${names.join(", ")}`);
  }

  private rpc<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.client) return Promise.reject(new Error("Not connected to InfiniBot yet."));
    return this.client.request(method, params) as Promise<T>;
  }

  // ── brain ──────────────────────────────────────────────────────────────

  private async loadBrain() {
    const [brain, ollama, runtimes] = await Promise.allSettled([
      this.rpc<{ primary?: string | null }>("voice.setup.brainGet"),
      this.rpc<{ running: boolean; host: string; models: string[] }>("voice.setup.ollamaModels"),
      this.rpc<{ runtimes?: LocalRuntime[] }>("localRuntimes.status"),
      this.loadCli(),
    ]);
    if (brain.status === "fulfilled") this.currentPrimary = brain.value?.primary ?? null;
    if (ollama.status === "fulfilled") {
      this.ollama = ollama.value;
      if (!this.localModel && ollama.value.models[0]) this.localModel = ollama.value.models[0];
    } else {
      this.ollama = { running: false, host: "http://127.0.0.1:11434", models: [] };
    }
    if (runtimes.status === "fulfilled") this.runtimes = runtimes.value?.runtimes ?? [];
    const hasLocal = Boolean(this.ollama?.models.length) || this.vllmModels().length > 0;
    if (!hasLocal && !this.currentPrimary?.startsWith("ollama/")) this.brainMode = "cloud";
    if (this.currentPrimary?.startsWith("ollama/")) this.localModel = this.currentPrimary.slice(7);
    // Someone already on a local model sees those options open.
    if (hasLocal && this.currentPrimary && /^(ollama|vllm)\//.test(this.currentPrimary) && !this.cli?.enabled) this.brainMore = true;
  }

  /** cliRouting.status; an older gateway without it falls back to the local / key options. */
  private async loadCli() {
    await this.cliModel.load(true);
  }

  private get cli(): CliRoutingStatus | null {
    return this.cliModel.status;
  }

  /** Subscription cards are offered (desktop / self-hosted, gateway new enough). */
  private cliOffered(): boolean {
    return Boolean(this.cli?.available !== false && this.cli && !this.cliModel.missing);
  }

  /** What the assistant thinks with right now: a connected account wins over the model setting. */
  private brainSummary(): string | null {
    const c = this.cli;
    if (c?.enabled) {
      const b = c.backends.find((x) => x.id === c.active);
      if (b) return `your ${b.account}`;
    }
    return this.currentPrimary;
  }

  /** "Start chatting": straight into the first chat; the rest of setup waits on the Setup page. */
  private startFirstChat() {
    const b = this.cliSetup.view().backend;
    this.done = new Set(this.done).add("model");
    if (this.step === "model") this.step = this.nextStep();
    this.persist();
    if (!this.cliDemo) {
      prepareFirstChat({ account: b?.account ?? null, useCases: [...this.picked], courses: this.plan().courses, pendingPath: true });
    }
    this.leave("webchat");
  }

  private vllmModels(): string[] {
    return this.runtimes
      .filter((r) => (r.kind === "vllm" || r.providers?.includes("vllm") || /vllm/i.test(r.id)) && r.healthy)
      .flatMap((r) => (r.loadedModels ?? []).map((m) => `vllm/${m}`));
  }

  private async saveLocalBrain() {
    const model = this.localModel.trim();
    if (!model) return;
    this.brainBusy = "save";
    this.brainMsg = null;
    try {
      if (model.startsWith("vllm/")) await this.rpc("voice.setup.brain", { provider: "cloud", modelId: model });
      else await this.rpc("voice.setup.brain", { provider: "ollama", modelId: model });
      this.currentPrimary = model.startsWith("vllm/") ? model : `ollama/${model}`;
      this.brainMsg = { ok: true, text: `Saved. Your assistant now thinks with ${model} on this computer.` };
      markFirstRunItem("provider");
    } catch (err) {
      this.brainMsg = { ok: false, text: errText(err) };
    } finally {
      this.brainBusy = null;
    }
  }

  private async checkKey() {
    const p = getBrainProvider(this.provider) ?? BRAIN_PROVIDERS[0]!;
    if (!this.apiKey.trim()) return;
    this.brainBusy = "check";
    this.brainMsg = null;
    try {
      const res = await this.rpc<{
        models?: Array<{ id: string; label?: string; free?: boolean }> | string[];
        defaultModel?: string;
        error?: string;
      }>("quickstart.providers.fetchModels", {
        provider: p.id,
        apiKey: this.apiKey.trim(),
        preferred: p.model || undefined,
      });
      // The RPC answers ok with `error` set when the provider rejects the key.
      if (res?.error) throw new Error(res.error);
      const models = toModelOptions(res?.models);
      const ids = models.map((m) => m.id);
      this.cloudModel = res?.defaultModel && ids.includes(res.defaultModel) ? res.defaultModel : (ids[0] ?? this.cloudModel);
      // The preselected model leads the list so it's visible without scrolling.
      this.cloudModels = [...models].sort((a, b) => Number(b.id === this.cloudModel) - Number(a.id === this.cloudModel));
      this.keyChecked = true;
      this.cloudModelFilter = "";
      this.freeOnly = false;
      const freeCount = models.filter((m) => m.free).length;
      this.brainMsg = {
        ok: true,
        text: ids.length
          ? `Key works. ${ids.length} models available${freeCount ? `, ${freeCount} free` : ""}. Pick one, then Test & save.`
          : "Key accepted.",
      };
    } catch (err) {
      this.brainMsg = { ok: false, text: `That key didn't work: ${errText(err)}` };
    } finally {
      this.brainBusy = null;
    }
  }

  private async saveCloudBrain() {
    const p = getBrainProvider(this.provider) ?? BRAIN_PROVIDERS[0]!;
    const key = this.apiKey.trim();
    if (!key) return;
    this.brainBusy = "save";
    this.brainMsg = null;
    try {
      const model = this.cloudModel.trim();
      if (!model) throw new Error("Press Check key and pick a model first.");
      // One tiny real turn: never save a model the key can't actually call.
      this.brainBusy = "test";
      const test = await this.rpc<{ ok?: boolean; error?: string; latencyMs?: number }>("quickstart.providers.testModel", {
        provider: p.id,
        apiKey: key,
        model,
      });
      if (!test?.ok) throw new Error(`${model} didn't answer: ${test?.error ?? "unknown error"}`);
      this.brainBusy = "save";
      const ref = await saveBrainProvider(this.rpc.bind(this), p, key, model);
      this.currentPrimary = ref;
      this.apiKey = "";
      this.brainMsg = {
        ok: true,
        text: `Tested and saved. ${model} answered in ${((test.latencyMs ?? 0) / 1000).toFixed(1)}s. Your assistant uses ${p.label}.`,
      };
      markFirstRunItem("provider");
    } catch (err) {
      this.brainMsg = { ok: false, text: errText(err) };
    } finally {
      this.brainBusy = null;
    }
  }

  // ── channels ───────────────────────────────────────────────────────────

  private async startWhatsApp() {
    this.wa = { ...this.wa, busy: true, qr: null, code: null, note: null };
    try {
      if (this.wa.mode === "pairing") {
        const res = await this.rpc<{ message?: string; pairingCode?: string }>("web.login.pairingCode.start", {
          phoneNumber: this.wa.phone.replace(/[^\d+]/g, ""),
          force: true,
          timeoutMs: 30000,
        });
        this.wa = { ...this.wa, busy: false, code: res.pairingCode ?? null, note: res.message ?? null };
      } else {
        const res = await this.rpc<{ message?: string; qrDataUrl?: string }>("web.login.start", { force: true, timeoutMs: 30000 });
        this.wa = { ...this.wa, busy: false, qr: res.qrDataUrl ?? null, note: res.message ?? null };
      }
      if (this.wa.qr || this.wa.code) void this.awaitWhatsApp();
    } catch (err) {
      const text = errText(err);
      this.wa = {
        ...this.wa,
        busy: false,
        note: /not available|not supported/i.test(text)
          ? "WhatsApp is switched off on this InfiniBot. Turn it on from the Channels page, then come back."
          : text,
      };
    }
  }

  private async awaitWhatsApp() {
    const deadline = Date.now() + 180_000;
    while ((this.wa.qr || this.wa.code) && !this.wa.linked && Date.now() < deadline && this.isConnected) {
      try {
        const res = await this.rpc<{ connected?: boolean; message?: string }>("web.login.wait", { timeoutMs: 30000 });
        if (res.connected) {
          this.wa = { ...this.wa, linked: true, qr: null, code: null, note: "Linked. WhatsApp is ready." };
          markFirstRunItem("channel");
          return;
        }
        if (res.message && /expired|no active/i.test(res.message)) {
          this.wa = { ...this.wa, qr: null, code: null, note: "That code expired. Ask for a new one." };
          return;
        }
      } catch (err) {
        this.wa = { ...this.wa, note: errText(err) };
        return;
      }
    }
  }

  private async saveDiscord() {
    const token = this.discordToken.trim();
    if (!token) return;
    this.channelMsg = null;
    try {
      const res = await patchConfigLive(this.rpc.bind(this), { channels: { discord: { token } } });
      this.discordToken = "";
      this.discordSaved = true;
      this.channelMsg = { ok: true, text: describeApply(res, "Discord bot saved") };
      markFirstRunItem("channel");
    } catch (err) {
      this.channelMsg = { ok: false, text: errText(err) };
    }
  }

  /** Pre-fill: open on the channel that is already set up. */
  private async loadChannels() {
    try {
      const res = await this.rpc<{ channels?: Record<string, { configured?: boolean }> }>("channels.status");
      const ch = res?.channels ?? {};
      this.discordSaved = Boolean(ch.discord?.configured);
      if (this.channel === "web") {
        const first = (["telegram", "whatsapp", "discord"] as const).find((id) => ch[id]?.configured);
        if (first) this.channel = first;
      }
    } catch {
      /* older gateway: "Just this app" stays selected */
    }
  }

  // ── voice ──────────────────────────────────────────────────────────────

  private async loadVoice() {
    const [setup, runtime] = await Promise.allSettled([
      this.rpc<{ models?: { kokoro?: { present?: boolean }; speaches?: { present?: boolean } } }>("voice.setup.get"),
      this.rpc<typeof this.voiceRuntime>("voice.runtime.status"),
    ]);
    if (setup.status === "fulfilled") {
      this.engines = {
        kokoro: Boolean(setup.value?.models?.kokoro?.present),
        speaches: Boolean(setup.value?.models?.speaches?.present),
      };
    } else {
      this.engines = { kokoro: false, speaches: false };
    }
    if (runtime.status === "fulfilled") this.voiceRuntime = runtime.value;
  }

  /** Local speech-to-text is configured for this InfiniBot and answering. */
  private sttReady(): boolean {
    return Boolean(this.voiceRuntime?.stt?.reachable);
  }

  /** "Set up voice for me" finished: refresh the engine state and run the mic test. */
  private async onLocalVoiceReady() {
    await this.loadVoice();
    markFirstRunItem("voice");
    this.voiceMsg = null;
    if (this.mic.phase === "idle") void this.micTest().start();
  }

  private micTest(): MicTest {
    this.mt ??= new MicTest((s) => (this.mic = s));
    return this.mt;
  }

  // ── privacy ────────────────────────────────────────────────────────────

  private async loadSecure() {
    try {
      const res = await this.rpc<{ enabled?: boolean }>("secure.status");
      this.secure = { enabled: Boolean(res?.enabled), available: true };
    } catch {
      this.secure = { enabled: false, available: false };
    }
  }

  private async toggleSecure(on: boolean) {
    this.secureBusy = true;
    this.secureMsg = null;
    try {
      const res = await this.rpc<{ enabled?: boolean }>("secure.set", { enabled: on });
      this.secure = { enabled: Boolean(res?.enabled ?? on), available: true };
      this.secureMsg = on ? "Secure Mode is on. Private chats only use models on this computer." : "Secure Mode is off.";
    } catch (err) {
      this.secureMsg = errText(err);
    } finally {
      this.secureBusy = false;
    }
  }

  // ── plan ───────────────────────────────────────────────────────────────

  private async loadPlan() {
    const plan = this.plan();
    const [list, market] = await Promise.allSettled([
      this.rpc<{ plugins?: Array<Record<string, unknown>> }>("plugins.list"),
      Promise.race([
        this.rpc<{ plugins?: Array<Record<string, unknown>> }>("plugins.marketplace.list"),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 4000)),
      ]),
    ]);
    const installed = new Map((list.status === "fulfilled" ? list.value?.plugins ?? [] : []).map((p) => [String(p.id), p] as const));
    const marketRows = new Map((market.status === "fulfilled" ? market.value?.plugins ?? [] : []).map((p) => [String(p.id), p] as const));
    const hosted = Boolean((installed.values().next().value as { cloud?: unknown } | undefined)?.cloud);
    this.decisions = plan.plugins.map((id) => decidePlugin(id, installed.get(id), marketRows.get(id), { hosted }));
    if (!this.pluginsLoaded) {
      if (this.editStep || this.rerun) {
        // Editing or running setup again: start from what is on now, nothing
        // recommended pre-ticked (never turn back on what someone turned off).
        this.pluginsOnAtOpen = new Set(this.decisions.filter((d) => d.action === "on").map((d) => d.id));
        this.enable = new Set(this.pluginsOnAtOpen);
      } else {
        this.enable = defaultEnableSet(this.decisions);
      }
    }
    this.pluginsLoaded = true;
    try {
      await loadGuidedCatalog(this.client);
      const titles = new Map<string, string>();
      for (const t of availableTracks()) titles.set(t.id, t.title);
      this.trackTitles = titles;
    } catch {
      /* titles fall back to ids */
    }
  }

  private courseTitle(id: string): string {
    return (
      this.trackTitles.get(id) ??
      this.decisions.find((d) => d.id === id || (id === "whiteboard" && d.id === "mcp-excalidraw"))?.name ??
      id.replace(/-/g, " ").replace(/^\w/, (c) => c.toUpperCase())
    );
  }

  // ── finish ─────────────────────────────────────────────────────────────

  private async apply() {
    if (this.applying) return;
    this.applying = true;
    const plan = this.plan();
    const lines: ApplyLine[] = [
      { label: "Save your goals", status: "pending" },
      { label: this.setDashboard ? `Dashboard layout: ${plan.dashboard}` : "Dashboard layout", status: this.setDashboard ? "pending" : "skip" },
      { label: this.makeTasks ? `Starter tasks (${plan.tasks.length})` : "Starter tasks", status: this.makeTasks ? "pending" : "skip" },
      { label: this.enable.size ? `Turn on ${this.enable.size} plugin${this.enable.size === 1 ? "" : "s"}` : "Plugins", status: this.enable.size ? "pending" : "skip" },
    ];
    const set = (i: number, status: ApplyLine["status"], detail?: string) => {
      lines[i] = { ...lines[i]!, status, detail };
      this.applied = [...lines];
    };
    this.applied = [...lines];

    const now = Date.now();
    const saved = await persistProfile(this.client, this.draftProfile({ completedAt: now }));
    set(0, "ok", saved ? undefined : "Saved in this browser");

    if (this.setDashboard) {
      try {
        localStorage.setItem(DASH_PRESET_KEY, plan.dashboard);
        set(1, "ok");
      } catch {
        set(1, "fail", "Browser storage is blocked");
      }
    }

    if (this.makeTasks) {
      try {
        const project = await this.rpc<{ id?: string; project?: { id?: string } }>("kanban.projects.create", {
          name: "Getting started with InfiniBot",
          description: "Starter tasks from setup. Tick them off as you go.",
        });
        const projectId = project?.id ?? project?.project?.id ?? null;
        for (const t of plan.tasks) {
          await this.rpc("kanban.tasks.create", { title: t.title, description: t.description, projectId, status: "todo", priority: "medium" });
        }
        set(2, "ok");
      } catch (err) {
        set(2, "fail", errText(err));
      }
    }

    if (this.enable.size) {
      // Only plugins that are off now; already-on ones need no write (and no restart).
      const ids = [...this.enable].filter((id) => this.decisions.find((d) => d.id === id)?.action !== "on");
      if (!ids.length) set(3, "ok", "Already on");
      else
        try {
          const snap = await this.rpc<{ config?: { plugins?: { allow?: unknown } } }>("config.get");
          const entries = Object.fromEntries(ids.map((id) => [id, { enabled: true }]));
          const allow = snap?.config?.plugins?.allow;
          const patch: Record<string, unknown> = { entries };
          if (Array.isArray(allow) && allow.length > 0) patch.allow = [...new Set([...(allow as string[]), ...ids])];
          const res = await patchConfigLive(this.rpc.bind(this), { plugins: patch });
          set(3, "ok", res.restartRequired ? "InfiniBot restarts for a few seconds to load them" : "Applied live");
        } catch (err) {
          set(3, "fail", errText(err));
        }
    }

    // Personal learning path: guided lessons picked from the answers above.
    lines.push({ label: "Your learning path", status: "pending" });
    this.applied = [...lines];
    try {
      this.pathItems = await createPath(plan.courses, [...this.picked]);
      const mins = this.pathItems.reduce((n, i) => n + i.estMinutes, 0);
      set(lines.length - 1, "ok", `${this.pathItems.length} lessons, about ${mins} minutes`);
    } catch (err) {
      set(lines.length - 1, "fail", errText(err));
    }

    markFirstRunItem("learn");
    setFirstRunStatus("complete");
    this.finishedAt = now;
    this.done = new Set(this.done).add("finish");
    this.persist();
    writeResult({ applied: lines, pendingCourse: plan.courses[0] ?? FIRST_COURSE, at: now });
    this.applying = false;
    this.startCountdown();
  }

  private startCountdown() {
    if (this.countdownTimer) clearInterval(this.countdownTimer);
    this.countdown = 5;
    this.countdownTimer = setInterval(() => {
      this.countdown -= 1;
      if (this.countdown <= 0) {
        clearInterval(this.countdownTimer!);
        this.countdownTimer = null;
        void this.startFirstCourse();
      }
    }, 1000);
  }

  private cancelCountdown() {
    if (this.countdownTimer) clearInterval(this.countdownTimer);
    this.countdownTimer = null;
    this.countdown = 0;
    const r = readResult();
    if (r?.pendingCourse) writeResult({ ...r, pendingCourse: null });
  }

  /** The first recommended course always opens the Chat page (/webchat). */
  private async startFirstCourse() {
    this.cancelCountdown();
    // First message first: the learning path starts after InfiniBot's first reply (webchat).
    if (!firstChatDone()) {
      prepareFirstChat({ account: this.cli?.enabled ? (this.cli.backends.find((b) => b.id === this.cli?.active)?.account ?? null) : null, useCases: [...this.picked], courses: this.plan().courses, pendingPath: true });
      this.leave("webchat");
      return;
    }
    const first = this.plan().courses[0] ?? FIRST_COURSE;
    // Close first and land on Chat: a lesson whose first step has no route
    // (e.g. "Tour the app") runs on the page it starts on, and that must never
    // be the Setup page under this full-screen flow.
    this.leave("webchat");
    // Lesson 1 of the personal learning path; the plain first course if there's no path.
    const started = (await startPath().catch(() => false)) || (await startTrack(first).catch(() => false));
    // Nothing to start (path finished): the Learn page shows what's next.
    if (!started) this.host?.setTab?.("learn" as never);
  }

  // ── render ─────────────────────────────────────────────────────────────

  private header(title: TemplateResult | string, sub: TemplateResult | string): TemplateResult {
    const i = this.index();
    return html`
      <div class="sob-eyebrow">
        <span class="sob-eyebrow__code">${this.editStep ? "Edit" : `Step ${String(i + 1).padStart(2, "0")}`}</span>
        <span class="sob-eyebrow__rule"></span>
        <span>${ONBOARDING_STEPS[i]?.label}</span>
      </div>
      <h2 class="sob-title" tabindex="-1">${title}</h2>
      <p class="sob-sub">${sub}</p>
    `;
  }

  private alert(m: { ok: boolean; text: string } | null): TemplateResult | typeof nothing {
    if (!m) return nothing;
    return html`<div class="iob-msg ${m.ok ? "is-ok" : "is-bad"}" role=${m.ok ? "status" : "alert"}>
      ${icon(m.ok ? "checkCircle" : "alertCircle")}<span>${m.text}</span>
    </div>`;
  }

  private renderUseCases(): TemplateResult {
    const toggle = (id: UseCaseId) => {
      const next = new Set(this.picked);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      if (id !== "exploring" && next.has(id)) next.delete("exploring");
      if (id === "exploring" && next.has("exploring")) {
        next.clear();
        next.add("exploring");
      }
      this.picked = next;
      saveProgress({ step: this.step, done: [...this.done], skipped: [...this.skipped], finishedAt: this.finishedAt });
    };
    return html`
      ${this.header(
        "What are you using InfiniBot for?",
        "Pick as many as you like. We'll suggest the right courses, plugins and a starter setup. You can change this any time.",
      )}
      <div class="iob-usecases" role="group" aria-label="What you use InfiniBot for" data-learn-id="onboarding-usecases">
        ${USE_CASES.map(
          (u) => html`<button
            type="button"
            role="checkbox"
            aria-checked=${this.picked.has(u.id) ? "true" : "false"}
            class="sob-opt iob-uc ${this.picked.has(u.id) ? "is-selected" : ""}"
            data-testid=${`onb-uc-${u.id}`}
            @click=${() => toggle(u.id)}
          >
            <span class="sob-opt__icon">${icon(u.icon as IconName)}</span>
            <span class="sob-opt__title">${u.title}</span>
            <span class="sob-opt__desc">${u.blurb}</span>
            <span class="iob-check" aria-hidden="true">${this.picked.has(u.id) ? icon("check") : nothing}</span>
          </button>`,
        )}
      </div>
      <p class="sob-hint iob-count" aria-live="polite">
        ${this.picked.size === 0 ? "Nothing picked yet. Skip to keep everything general." : `${this.picked.size} picked.`}
      </p>
    `;
  }

  private renderLocalPanel(): TemplateResult {
    const localModels = [...(this.ollama?.models ?? []), ...this.vllmModels()];
    return html`
            <div class="iob-panel">
              <div class="iob-row">
                <span class="iob-led ${this.ollama?.running ? "is-on" : ""}"></span>
                <ib-provider-logo provider="ollama" size="28"></ib-provider-logo>
                <span>
                  <strong>Ollama</strong>
                  ${this.ollama === null
                    ? "checking…"
                    : this.ollama.running
                      ? `running · ${this.ollama.models.length} model${this.ollama.models.length === 1 ? "" : "s"}`
                      : "not found on this computer"}
                </span>
              </div>
              ${this.runtimes
                .filter((r) => r.id !== "ollama")
                .map(
                  (r) => html`<div class="iob-row">
                    <span class="iob-led ${r.healthy ? "is-on" : ""}"></span>
                    <span><strong>${r.label}</strong> ${r.healthy ? "running" : "stopped"}</span>
                  </div>`,
                )}
              ${localModels.length
                ? html`<label class="sob-field">
                    <span class="sob-label">Model <span class="iob-free">${icon("tag")}Free</span></span>
                    <select
                      class="sob-input sob-select"
                      data-testid="onb-local-model"
                      .value=${this.localModel}
                      @change=${(e: Event) => (this.localModel = (e.target as HTMLSelectElement).value)}
                    >
                      ${localModels.map((m) => html`<option value=${m} ?selected=${m === this.localModel}>${m}</option>`)}
                    </select>
                  </label>
                  <div class="iob-actions">
                    <button type="button" class="sob-btn sob-btn--primary" ?disabled=${Boolean(this.brainBusy)} @click=${() => void this.saveLocalBrain()}>
                      ${this.brainBusy === "save" ? html`<span class="sob-spinner"></span>Saving…` : "Use this model"}
                    </button>
                  </div>`
                : html`<p class="sob-hint">
                    Install <a class="sob-link" href="https://ollama.com/download" target="_blank" rel="noopener">Ollama</a>, then run
                    <code>ollama pull llama3.2</code> and press Refresh. Or pick a cloud provider instead.
                  </p>
                  <div class="iob-actions">
                    <button type="button" class="sob-btn sob-btn--ghost" @click=${() => void this.loadBrain()}>${icon("refresh")}Refresh</button>
                  </div>`}
            </div>
          `;
  }

  private renderKeyPanel(): TemplateResult {
    const p = getBrainProvider(this.provider) ?? BRAIN_PROVIDERS[0]!;
    return html`
            <div class="iob-providers" role="radiogroup" aria-label="Provider" data-testid="onb-providers">
              ${BRAIN_PROVIDERS.filter((x) => x.featured || this.showMoreProviders || x.id === this.provider).map((x) => this.renderProviderOption(x))}
            </div>
            ${BRAIN_PROVIDERS.some((x) => !x.featured)
              ? html`<button
                  type="button"
                  class="sob-btn sob-btn--ghost iob-more-providers"
                  data-testid="onb-more-providers"
                  aria-expanded=${this.showMoreProviders ? "true" : "false"}
                  @click=${() => (this.showMoreProviders = !this.showMoreProviders)}
                >
                  ${this.showMoreProviders ? "Fewer providers" : `More providers (${BRAIN_PROVIDERS.filter((x) => !x.featured).length})`}
                </button>`
              : nothing}
            <label class="sob-field">
              <span class="sob-label">${p.label} API key</span>
              <input
                class="sob-input sob-input--mono"
                type="password"
                autocomplete="off"
                data-testid="onb-api-key"
                placeholder=${p.placeholder}
                .value=${this.apiKey}
                @input=${(e: Event) => {
                  this.apiKey = (e.target as HTMLInputElement).value;
                  this.keyChecked = false;
                  this.cloudModels = [];
                }}
              />
              <span class="sob-hint">
                ${p.keyUrl
                  ? html`Get a key at <a class="sob-link" href=${p.keyUrl} target="_blank" rel="noopener">${new URL(p.keyUrl).host}</a>.`
                  : nothing}
                It's stored only on this computer.
              </span>
            </label>
            ${this.renderCloudModelPicker()}
            <div class="iob-actions">
              <button type="button" class="sob-btn sob-btn--ghost" data-testid="onb-check-key" ?disabled=${!this.apiKey.trim() || Boolean(this.brainBusy)} @click=${() => void this.checkKey()}>
                ${this.brainBusy === "check" ? html`<span class="sob-spinner"></span>Checking…` : "Check key"}
              </button>
              <button
                type="button"
                class="sob-btn sob-btn--primary"
                data-testid="onb-test-save"
                ?disabled=${!this.apiKey.trim() || !this.keyChecked || !this.cloudModel.trim() || Boolean(this.brainBusy)}
                @click=${() => void this.saveCloudBrain()}
              >
                ${this.brainBusy === "test"
                  ? html`<span class="sob-spinner"></span>Testing ${this.cloudModel}…`
                  : this.brainBusy === "save"
                    ? html`<span class="sob-spinner"></span>Saving…`
                    : "Test & save"}
              </button>
            </div>
          `;
  }

  /** Live model list for the checked key: search, Free filter, Free badges. */
  private renderCloudModelPicker(): TemplateResult {
    if (!this.cloudModels.length) {
      const typed = this.keyChecked;
      return html`<div class="sob-field">
        <span class="sob-label">Model</span>
        ${typed
          ? html`<input class="sob-input sob-input--mono" .value=${this.cloudModel} @input=${(e: Event) => (this.cloudModel = (e.target as HTMLInputElement).value)} />`
          : html`<select class="sob-input sob-select" data-testid="onb-model-placeholder" disabled aria-describedby="onb-models-empty">
                <option>Check your key to load its models</option>
              </select>
              <p class="sob-hint iob-models-empty" id="onb-models-empty" data-testid="onb-models-empty">
                Press <strong>Check key</strong> to load the models your key can use. Retired models are hidden and free ones are marked.
              </p>`}
      </div>`;
    }
    const q = this.cloudModelFilter.trim().toLowerCase();
    const anyFree = this.cloudModels.some((m) => m.free);
    const shown = this.cloudModels.filter(
      (m) => (!this.freeOnly || m.free) && (!q || m.id.toLowerCase().includes(q) || (m.label ?? "").toLowerCase().includes(q)),
    );
    return html`<div class="sob-field">
      <span class="sob-label">Model</span>
      <div class="iob-model-tools">
        ${this.cloudModels.length > 8
          ? html`<input
              class="sob-input iob-model-search"
              type="search"
              placeholder="Search ${this.cloudModels.length} models"
              aria-label="Search models"
              .value=${this.cloudModelFilter}
              @input=${(e: Event) => (this.cloudModelFilter = (e.target as HTMLInputElement).value)}
            />`
          : nothing}
        ${anyFree
          ? html`<button
              type="button"
              class="iob-free-toggle ${this.freeOnly ? "is-on" : ""}"
              aria-pressed=${this.freeOnly ? "true" : "false"}
              data-testid="onb-free-only"
              @click=${() => (this.freeOnly = !this.freeOnly)}
            >
              ${icon("tag")}Free only
            </button>`
          : nothing}
      </div>
      <div class="iob-models" role="listbox" aria-label="Models" data-testid="onb-models">
        ${shown.length
          ? shown.map(
              (m) => html`<button
                type="button"
                role="option"
                aria-selected=${m.id === this.cloudModel ? "true" : "false"}
                class="iob-model ${m.id === this.cloudModel ? "is-selected" : ""}"
                data-model=${m.id}
                @click=${() => (this.cloudModel = m.id)}
              >
                <span class="iob-model__name">${m.label && m.label !== m.id ? m.label : m.id}</span>
                ${m.label && m.label !== m.id ? html`<code class="iob-model__id">${m.id}</code>` : nothing}
                ${m.free ? html`<span class="iob-free">${icon("tag")}Free</span>` : nothing}
              </button>`,
            )
          : html`<p class="sob-hint">No models match.</p>`}
      </div>
    </div>`;
  }

  private renderProviderOption(x: BrainProvider): TemplateResult {
    return html`<button
      type="button"
      role="radio"
      aria-checked=${this.provider === x.id ? "true" : "false"}
      class="sob-opt iob-prov ${this.provider === x.id ? "is-selected" : ""}"
      data-provider=${x.id}
      @click=${() => {
        this.provider = x.id;
        this.cloudModel = x.model;
        this.cloudModels = [];
        this.keyChecked = false;
        this.brainMsg = null;
      }}
    >
      <span class="sob-opt__icon sob-opt__icon--logo"><ib-provider-logo provider=${x.id} label=${x.label}></ib-provider-logo></span>
      <span class="sob-opt__title">${x.label}</span>
      <span class="sob-opt__desc">${x.badge ? html`<span class="iob-prov__badge">${x.badge}</span>` : nothing}${x.sub}</span>
      <span class="sob-opt__radio"></span>
    </button>`;
  }

  /** Local model / API key switch + the chosen panel (the advanced path). */
  private renderAdvancedBrain(): TemplateResult {
    return html`
      <div class="sob-seg iob-seg" role="radiogroup" aria-label="Other ways to run the assistant" data-learn-id="setup-providers">
        ${(["local", "cloud"] as const).map(
          (m) => html`<button
            type="button"
            role="radio"
            aria-checked=${this.brainMode === m ? "true" : "false"}
            class="sob-seg__opt ${this.brainMode === m ? "is-selected" : ""}"
            data-testid=${m === "local" ? "onb-brain-local" : "onb-brain-apikey"}
            @click=${() => {
              this.brainMode = m;
              this.brainMsg = null;
            }}
          >
            <span class="sob-seg__dot"></span>${m === "local" ? "Run a model on this computer" : "I have an API key (advanced)"}
          </button>`,
        )}
      </div>
      ${this.brainMode === "local" ? this.renderLocalPanel() : this.renderKeyPanel()}
      ${this.alert(this.brainMsg)}
    `;
  }

  private renderModel(): TemplateResult {
    const summary = this.brainSummary();
    const current = summary
      ? html`<div class="iob-current">${icon("checkCircle")}<span>Currently using <code>${summary}</code></span></div>`
      : nothing;
    // Hosted cloud or an older gateway: the local / key options as before.
    if (!this.cliOffered() && (this.cli || this.cliModel.missing || this.cliModel.error)) {
      return html`
        ${this.header(
          "Choose your assistant's brain",
          "Run a model free and private on this computer, or connect a provider with your own key. You can switch later.",
        )}
        <div class="sob-guide-chip">${renderSetupGuideButton({ startAt: 159, label: "Watch: AI brains & API keys explained" })}</div>
        ${current}
        ${this.cliModel.missing
          ? html`<p class="sob-hint" data-testid="onb-cli-missing">Using your ChatGPT, Grok, Google or Claude account needs an InfiniBot update.</p>`
          : nothing}
        ${this.renderAdvancedBrain()}
      `;
    }
    if (this.cliSetup.active) return this.renderCliSetup(this.cliSetup.view());
    const c = this.cli;
    return html`
      ${this.header("Which of these do you already have?", "Pick the one you use and InfiniBot connects to it, so you don't pay twice. No account yet? Gemini works with an API key or a paid Google plan.")}
      <div class="sob-guide-chip">${renderSetupGuideButton({ startAt: 159, label: "Watch: AI brains & API keys explained" })}</div>
      ${current}
      <div class="iob-have" role="list" data-learn-id="setup-providers">
        ${c
          ? BEGINNER_CARDS.map(({ id }) => {
              const b = c.backends.find((x) => x.id === id);
              if (!b) return nothing;
              const inUse = c.enabled && c.active === b.id;
              return html`<button
                type="button"
                role="listitem"
                class="sob-opt iob-have__card ${b.recommended ? "is-recommended" : ""} ${inUse ? "is-selected" : ""}"
                data-testid=${`onb-brain-card-${b.id}`}
                @click=${() => void this.cliSetup.start(b.id)}
              >
                <span class="sob-opt__icon sob-opt__icon--logo"><ib-provider-logo provider=${b.id} label=${b.account}></ib-provider-logo></span>
                <span class="sob-opt__title">${b.account}${b.free ? html`<span class="iob-chip is-free">Free</span>` : nothing}</span>
                <span class="sob-opt__desc">${inUse ? "Connected. Click to check it again." : cardSubtitle(b)}</span>
                <span class="iob-have__go" aria-hidden="true">${icon("arrowRight")}</span>
              </button>`;
            })
          : [0, 1, 2, 3].map(() => html`<div class="sob-opt iob-have__card is-skeleton" aria-hidden="true"></div>`)}
        ${c ? this.renderOllamaCloudCard() : nothing}
      </div>
      ${c && c.backends.some((b) => b.id === GOOGLE_ID)
        ? html`<p class="sob-hint iob-have__none">None of these? Pick <strong>Google account</strong> and use a Gemini API key (or a paid Google plan). It takes about a minute.</p>`
        : nothing}
      <div class="iob-more">
        <button
          type="button"
          class="iob-more__toggle"
          aria-expanded=${this.brainMore ? "true" : "false"}
          data-testid="onb-brain-more"
          @click=${() => (this.brainMore = !this.brainMore)}
        >
          ${icon(this.brainMore ? "chevronDown" : "chevronRight")}More options
        </button>
        ${this.brainMore ? html`<div class="iob-more__body">${this.renderAdvancedBrain()}</div>` : nothing}
      </div>
    `;
  }

  /** Ollama Cloud next to the subscription cards: best value, and the built-in fallback. */
  private renderOllamaCloudCard(): TemplateResult {
    const oc = getBrainProvider("ollama-cloud");
    if (!oc) return html``;
    const inUse = Boolean(this.currentPrimary?.startsWith("ollama-cloud/"));
    return html`<button
      type="button"
      role="listitem"
      class="sob-opt iob-have__card iob-have__card--wide ${inUse ? "is-selected" : ""}"
      data-testid="onb-brain-card-ollama-cloud"
      @click=${() => {
        this.brainMore = true;
        this.brainMode = "cloud";
        this.provider = oc.id;
        this.cloudModel = oc.model;
        this.cloudModels = [];
        this.keyChecked = false;
        this.brainMsg = null;
        void this.updateComplete.then(() =>
          this.querySelector('[data-testid="onb-api-key"]')?.scrollIntoView({ block: "center", behavior: "smooth" }),
        );
      }}
    >
      <span class="sob-opt__icon sob-opt__icon--logo"><ib-provider-logo provider=${oc.id} label=${oc.label}></ib-provider-logo></span>
      <span class="sob-opt__title">${oc.label}${oc.badge ? html`<span class="iob-chip is-free">${oc.badge}</span>` : nothing}</span>
      <span class="sob-opt__desc">${inUse ? "Connected. Click to change the key or model." : "Paste an Ollama API key. Big open models, great value."}</span>
      <span class="iob-have__go" aria-hidden="true">${icon("arrowRight")}</span>
    </button>`;
  }

  /** The automatic checklist after picking a card: get ready → sign in → connect. */
  private async copyCli(what: "link" | "code" | "manual", text: string): Promise<void> {
    if (!(await copyText(text))) return;
    this.cliCopied = what;
    setTimeout(() => {
      if (this.cliCopied === what) this.cliCopied = null;
    }, 1800);
  }

  private renderCliSetup(v: CliSetupView): TemplateResult {
    const b = v.backend;
    const acct = b?.account ?? "your account";
    const marker = (st: CliStepState, n: number) =>
      st === "done" || st === "skipped"
        ? icon("check")
        : st === "active"
          ? html`<span class="sob-spinner"></span>`
          : st === "error"
            ? icon("alertCircle")
            : html`<span>${n}</span>`;
    const pct = Math.round(v.progress * 100);
    const onPrimary = () => {
      const p = v.primary;
      if (!p || p.busy) return;
      if (p.id === "chat") return this.startFirstChat();
      if (p.id === "code") return void this.cliSetup.submitCode(this.cliCode).then(() => (this.cliCode = ""));
      if (p.id === "retry" || p.id === "google" || p.id === "relogin" || p.id === "guide" || p.id === "apikey") return this.cliSetup.fix(p.id);
      this.cliSetup.primary(p.id);
    };
    const primaryBtn = v.primary
      ? html`<button
          type="button"
          class="sob-btn sob-btn--primary iob-setup__primary"
          data-testid=${v.phase === "error" ? "onb-cli-fix" : "onb-cli-primary"}
          ?disabled=${Boolean(v.primary.busy) || (v.primary.id === "code" && !this.cliCode.trim())}
          aria-busy=${v.primary.busy ? "true" : "false"}
          @click=${onPrimary}
        >
          ${v.primary.busy ? html`<span class="sob-spinner"></span>` : nothing}${v.primary.label}${v.primary.id === "chat" ? icon("arrowRight") : nothing}
        </button>`
      : nothing;
    return html`
      ${this.header(
        v.phase === "done" ? "You're connected" : `Setting up ${acct}`,
        v.phase === "done" ? "Say hello to InfiniBot. Your first chat is one click away." : "InfiniBot does this for you. It usually takes a minute or two.",
      )}
      <section class="iob-setup iob-ph-${v.phase === "error" ? "fail" : v.phase}" data-testid="onb-cli-setup" aria-label=${`Setting up ${acct}`}>
        <div class="iob-setup__bar" role="progressbar" aria-label="Setup progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${pct}>
          <span style=${`width:${pct}%`}></span>
        </div>
        <ol class="iob-setup__steps">
          ${v.steps.map(
            (st, n) => html`<li class="iob-setup__step iob-st-${st.state === "error" ? "fail" : st.state}" data-testid=${`onb-cli-step-${st.id}`} data-state=${st.state}>
              <span class="iob-setup__mark" aria-hidden="true">${marker(st.state, n + 1)}</span>
              <span class="iob-setup__text">
                <span class="iob-setup__label">${st.label}</span>
                ${st.detail ? html`<span class="sob-hint">${st.detail}</span>` : nothing}
              </span>
            </li>`,
          )}
        </ol>
        ${v.phase === "error" && v.error
          ? html`<div class="iob-msg is-bad iob-setup__err" role="alert" data-testid="onb-cli-error">
              ${icon("alertCircle")}
              <span>
                ${v.error.message}
                ${v.error.details
                  ? html`<button type="button" class="iob-linkbtn" @click=${() => this.cliSetup.toggleDetails()}>${this.cliSetup.showDetails ? "Hide details" : "Show details"}</button>
                      ${this.cliSetup.showDetails ? html`<span class="iob-setup__details">${v.error.details}</span>` : nothing}`
                  : nothing}
              </span>
            </div>`
          : html`<p class="iob-setup__line" aria-live="polite">${v.line}</p>`}
        ${v.phase === "signin" && v.login?.url
          ? html`<div class="iob-setup__link" data-testid="onb-cli-signin-link">
              <span class="sob-hint">Sign-in page (opens in your browser)</span>
              <code class="iob-setup__url" title=${v.login.url}>${v.login.url}</code>
              <span class="iob-setup__linkbtns">
                <button type="button" class="sob-btn iob-setup__mini" data-testid="onb-cli-open-browser" @click=${() => this.cliSetup.primary("reopen")}>
                  ${icon("externalLink")}Open in browser
                </button>
                <button type="button" class="sob-btn iob-setup__mini" data-testid="onb-cli-copy-link" @click=${() => this.copyCli("link", v.login!.url!)}>
                  ${this.cliCopied === "link" ? "Copied" : "Copy link"}
                </button>
              </span>
            </div>`
          : nothing}
        ${v.phase === "signin" && v.login?.userCode
          ? html`<div class="iob-setup__code"><span class="sob-hint">Your code</span><span class="iob-code" data-testid="onb-cli-user-code">${v.login.userCode}</span>
              <button type="button" class="sob-btn iob-setup__mini" data-testid="onb-cli-copy-code" @click=${() => this.copyCli("code", v.login!.userCode!)}>
                ${this.cliCopied === "code" ? "Copied" : "Copy code"}
              </button></div>`
          : nothing}
        ${v.phase === "error" && v.error?.manual
          ? html`<div class="iob-setup__link" data-testid="onb-cli-manual">
              <span class="sob-hint">Or install it yourself in a terminal, then click Try again</span>
              <code class="iob-setup__url">${v.error.manual}</code>
              <span class="iob-setup__linkbtns">
                <button type="button" class="sob-btn iob-setup__mini" @click=${() => this.copyCli("manual", v.error!.manual!)}>
                  ${this.cliCopied === "manual" ? "Copied" : "Copy command"}
                </button>
              </span>
            </div>`
          : nothing}
        ${v.phase === "signin" && v.login?.needsCode
          ? html`<label class="sob-field iob-setup__paste">
              <span class="sob-label">Code from the ${acct} page</span>
              <input
                class="sob-input sob-input--mono"
                autocomplete="off"
                spellcheck="false"
                data-testid="onb-cli-code-input"
                placeholder="Paste it here"
                .value=${this.cliCode}
                @input=${(e: Event) => (this.cliCode = (e.target as HTMLInputElement).value)}
                @keydown=${(e: KeyboardEvent) => {
                  if (e.key === "Enter" && this.cliCode.trim()) onPrimary();
                }}
              />
            </label>`
          : nothing}
        ${v.login?.error ? html`<p class="sob-hint iob-setup__warn" role="alert">${v.login.error}</p>` : nothing}
        ${v.phase === "done" && v.reply
          ? html`<figure class="iob-setup__reply" data-testid="onb-cli-done">
              <figcaption>${icon("checkCircle")}InfiniBot replied through your ${acct}</figcaption>
              <blockquote>${v.reply}</blockquote>
            </figure>`
          : nothing}
        <div class="iob-actions iob-setup__actions">
          ${primaryBtn}
          ${v.phase === "done"
            ? html`<button type="button" class="iob-linkbtn" data-testid="onb-cli-continue" @click=${() => this.go(this.nextStep(), "done")}>Continue setup first</button>`
            : html`<button type="button" class="iob-linkbtn" data-testid="onb-cli-back" @click=${() => this.cliSetup.reset()}>${v.phase === "error" && v.error?.code === "subscription_unsupported" ? "Skip, use another AI" : "Choose another"}</button>`}
        </div>
        ${v.nudge
          ? html`<button type="button" class="iob-linkbtn iob-setup__nudge" data-testid="onb-cli-reopen" @click=${() => this.cliSetup.nudge(v.nudge!.action)}>
              ${icon("externalLink")}${v.nudge.text}
            </button>`
          : nothing}
        <p class="iob-note">${icon("globe")}<span>Your chats go to ${b?.vendor ?? "that company"}'s servers, like when you use ${acct} yourself. Secure Mode chats never do.</span></p>
      </section>
    `;
  }

  private renderChannels(): TemplateResult {
    const tiles: Array<{ id: ChannelId; label: string; sub: string; glyph: IconName }> = [
      { id: "web", label: "Just this app", sub: "Chat in the browser and the desktop app. Nothing to set up.", glyph: "messageSquare" },
      { id: "telegram", label: "Telegram", sub: "Message your assistant from your phone. Guided, about a minute.", glyph: "send" },
      { id: "whatsapp", label: "WhatsApp", sub: "Link with a QR code or a pairing code from your phone number.", glyph: "smartphone" },
      { id: "discord", label: "Discord", sub: "Add your assistant to a Discord server with a bot token.", glyph: "users" },
    ];
    const wa = this.wa;
    const phoneOk = /^\+?[\d\s()-]{7,20}$/.test(wa.phone.trim());
    return html`
      ${this.header("Where do you want to chat?", "The app always works. Add a messaging app to reach your assistant from anywhere.")}
      <div class="sob-options iob-channels" role="radiogroup" aria-label="Channel">
        ${tiles.map(
          (t) => html`<button
            type="button"
            role="radio"
            aria-checked=${this.channel === t.id ? "true" : "false"}
            class="sob-opt ${this.channel === t.id ? "is-selected" : ""}"
            data-testid=${`onb-ch-${t.id}`}
            @click=${() => {
              this.channel = t.id;
              this.channelMsg = null;
            }}
          >
            <span class="sob-opt__icon">${icon(t.glyph)}</span>
            <span class="sob-opt__title">${t.label}${t.id === "telegram" && this.telegramConnected ? html` <span class="sob-tag">Connected</span>` : nothing}</span>
            <span class="sob-opt__desc">${t.sub}</span>
            <span class="sob-opt__radio"></span>
          </button>`,
        )}
      </div>
      ${this.channel === "telegram"
        ? html`<div class="iob-panel">
            ${this.tgBackend ? html`<div class="iob-testmode" role="note">${icon("alertCircle")}Test mode: no real bot is created and nothing is saved.</div>` : nothing}
            <telegram-setup
              data-testid="onb-telegram-setup"
              .client=${this.client}
              .backend=${this.tgBackend}
              @telegram-setup-ready=${(e: CustomEvent<{ connected: boolean }>) => (this.telegramConnected = Boolean(e.detail?.connected))}
              @telegram-setup-changed=${(e: CustomEvent<{ connected: boolean }>) => {
                this.telegramConnected = Boolean(e.detail?.connected);
                if (this.telegramConnected) markFirstRunItem("channel");
              }}
            ></telegram-setup>
          </div>`
        : nothing}
      ${this.channel === "whatsapp"
        ? html`<div class="iob-panel">
            <div class="sob-seg iob-seg" role="radiogroup" aria-label="How to link WhatsApp">
              ${(["qr", "pairing"] as const).map(
                (m) => html`<button
                  type="button"
                  role="radio"
                  aria-checked=${wa.mode === m ? "true" : "false"}
                  class="sob-seg__opt ${wa.mode === m ? "is-selected" : ""}"
                  @click=${() => (this.wa = { ...wa, mode: m, qr: null, code: null, note: null })}
                >
                  <span class="sob-seg__dot"></span>${m === "qr" ? "QR code" : "Phone number"}
                </button>`,
              )}
            </div>
            ${wa.mode === "pairing"
              ? html`<label class="sob-field">
                  <span class="sob-label">Your WhatsApp phone number</span>
                  <input class="sob-input" inputmode="tel" placeholder="+1 555 123 4567" .value=${wa.phone} @input=${(e: Event) => (this.wa = { ...this.wa, phone: (e.target as HTMLInputElement).value })} />
                </label>`
              : nothing}
            <ol class="iob-steps">
              <li>Open WhatsApp on your phone and go to <strong>Linked devices</strong>.</li>
              <li>${wa.mode === "qr" ? "Tap Link a device and point your phone at the code." : "Tap Link with phone number instead, then type the code."}</li>
            </ol>
            <div class="iob-actions">
              <button type="button" class="sob-btn sob-btn--primary" ?disabled=${wa.busy || (wa.mode === "pairing" && !phoneOk)} @click=${() => void this.startWhatsApp()}>
                ${wa.busy ? html`<span class="sob-spinner"></span>Contacting WhatsApp…` : wa.mode === "qr" ? "Show QR code" : "Get pairing code"}
              </button>
            </div>
            ${wa.qr ? html`<div class="iob-qr"><img src=${wa.qr} alt="WhatsApp link QR code" /></div>` : nothing}
            ${wa.code ? html`<div class="iob-code" aria-label="Pairing code">${wa.code}</div>` : nothing}
            ${wa.note ? html`<p class="sob-hint" role="status">${wa.note}</p>` : nothing}
          </div>`
        : nothing}
      ${this.channel === "discord"
        ? html`<div class="iob-panel">
            <label class="sob-field">
              <span class="sob-label">Discord bot token</span>
              <input class="sob-input sob-input--mono" type="password" autocomplete="off" data-testid="onb-discord-token" .value=${this.discordToken} @input=${(e: Event) => (this.discordToken = (e.target as HTMLInputElement).value)} />
              <span class="sob-hint">
                ${this.discordSaved ? html`<strong data-testid="onb-discord-saved">A bot token is saved.</strong> Paste a new one to replace it. ` : nothing}From the
                <a class="sob-link" href="https://discord.com/developers/applications" target="_blank" rel="noopener">Discord Developer Portal</a>: your application, then Bot.
              </span>
            </label>
            <div class="iob-actions">
              <button type="button" class="sob-btn sob-btn--primary" data-testid="onb-discord-save" ?disabled=${!this.discordToken.trim()} @click=${() => void this.saveDiscord()}>Save bot</button>
            </div>
          </div>`
        : nothing}
      ${this.alert(this.channelMsg)}
    `;
  }

  private renderMicTest(): TemplateResult {
    const m = this.mic;
    const heard = micHeard(m);
    const bars = Array.from({ length: 24 }, (_, i) => i / 24 < m.level);
    const live = m.phase === "listening" || m.phase === "recording";
    return html`
      <div class="iob-mic" data-testid="onb-mic-test" data-learn-id="onboarding-mic-test">
        <div class="iob-mic__head">
          <span class="iob-mic__icon">${icon("mic")}</span>
          <div>
            <div class="iob-mic__title">Test your microphone</div>
            <div class="sob-hint">${m.deviceLabel && !/MediaStream|^default$/i.test(m.deviceLabel) ? `Using ${m.deviceLabel}. ` : ""}Your audio stays on this computer.</div>
          </div>
        </div>
        <div class="iob-meter ${live ? "is-live" : ""}" role="meter" aria-label="Microphone level" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${Math.round(m.level * 100)}>
          ${bars.map((on) => html`<span class=${on ? "is-on" : ""}></span>`)}
        </div>
        <p class="iob-mic__status" aria-live="polite" data-testid="onb-mic-status">
          ${m.phase === "idle"
            ? "Press Start and say a few words."
            : m.phase === "asking"
              ? "Allow the microphone when your browser asks."
              : m.phase === "error"
                ? m.error
                : m.phase === "recording"
                  ? `Recording… ${m.remaining}s. Say: "Hello InfiniBot, can you hear me?"`
                  : m.phase === "transcribing"
                    ? "Turning your words into text on this computer…"
                    : heard
                      ? "We can hear you. Your microphone works."
                      : "Listening… speak up a little if the bars don't move."}
        </p>
        ${m.transcript !== null
          ? html`<div class="iob-transcript"><span class="sob-label">We heard</span><q>${m.transcript || "(silence)"}</q></div>`
          : nothing}
        ${m.sttError
          ? html`<p class="sob-hint">Your microphone works. Speech-to-text isn't set up yet: press <strong>Set up voice for me</strong> above, then try again.</p>`
          : nothing}
        ${m.playbackUrl ? html`<audio class="iob-audio" controls src=${m.playbackUrl} aria-label="Your recording"></audio>` : nothing}
        <div class="iob-actions">
          ${m.phase === "idle" || m.phase === "error"
            ? html`<button type="button" class="sob-btn sob-btn--primary" data-testid="onb-mic-start" @click=${() => void this.micTest().start()}>${icon("mic")}Start mic test</button>`
            : html`<button
                  type="button"
                  class="sob-btn sob-btn--primary"
                  data-testid="onb-mic-record"
                  ?disabled=${m.phase === "recording" || m.phase === "transcribing" || m.phase === "asking"}
                  @click=${() => void this.micTest().record(this.sttReady())}
                >
                  ${icon("play")}${this.sttReady() ? "Record and transcribe" : "Record a clip"}
                </button>
                <button type="button" class="sob-btn sob-btn--ghost" @click=${() => {
                  this.mt?.stop();
                  this.mic = { ...IDLE_MIC };
                }}>Stop</button>`}
        </div>
      </div>
    `;
  }

  /**
   * Leaving the Voice step: cloud voice is used only because the user picked it
   * here (voice.backend = "robovoice"). Local / later never switch anything —
   * local voice is already the default.
   */
  private async commitVoiceChoice(): Promise<void> {
    if (this.voiceChoice !== "cloud" || !this.client || !isTabAvailable("robovoice")) return;
    try {
      await selectVoiceProvider(this.client, CLOUD_VOICE_PROVIDER_ID);
    } catch {
      // Not linked yet: the Voice page keeps offering Connect; local voice stays on.
    }
  }

  private renderVoice(): TemplateResult {
    const opt = (id: "local" | "cloud" | "later", glyph: IconName, title: string, desc: string) => html`<button
      type="button"
      role="radio"
      aria-checked=${this.voiceChoice === id ? "true" : "false"}
      class="sob-opt ${this.voiceChoice === id ? "is-selected" : ""}"
      data-testid=${`onb-voice-${id}`}
      @click=${() => (this.voiceChoice = id)}
    >
      <span class="sob-opt__icon">${icon(glyph)}</span>
      <span class="sob-opt__title">${title}</span>
      <span class="sob-opt__desc">${desc}</span>
      <span class="sob-opt__radio"></span>
    </button>`;
    const eng = this.engines;
    const robovoice = isTabAvailable("robovoice");
    return html`
      ${this.header(
        html`Talk to your assistant <span class="sob-tag">Recommended</span>`,
        "Local voice runs on this computer: private, free and works offline. Cloud voice works on any device.",
      )}
      <div class="sob-options" role="radiogroup" aria-label="Voice">
        ${opt("local", "server", "Local voice", "Talk and listen right on this computer. We set it up for you.")}
        ${opt("cloud", "globe", "Cloud voice (Robovoice)", "Optional and free: studio voices from Robovoice's cloud. Switch back to local any time.")}
        ${opt("later", "volumeMute", "Set up later", "Type for now. Turn voice on any time from the Voice page.")}
      </div>
      ${this.voiceChoice === "local"
        ? html`<div class="iob-voice-setup" data-testid="onb-voice-local" data-learn-id="onboarding-voice-setup">
            ${eng?.kokoro && eng?.speaches
              ? html`<div class="iob-row"><span class="iob-led is-on"></span><span><strong>Local voice is running</strong> on this computer.</span></div>`
              : nothing}
            <ib-local-voice-setup
              .client=${this.client}
              context="onboarding"
              @voice-ready=${() => void this.onLocalVoiceReady()}
              @use-cloud=${() => (this.voiceChoice = "cloud")}
              @skip-voice=${() => {
                this.voiceChoice = "later";
                this.go(this.nextStep(), "skipped");
              }}
            ></ib-local-voice-setup>
          </div>`
        : nothing}
      ${this.voiceChoice === "cloud"
        ? html`<div class="iob-panel">
            ${robovoice
              ? html`<robovoice-link variant="compact"></robovoice-link>`
              : html`<p class="sob-hint">Cloud voice comes with the Robovoice plugin. Turn it on in the next steps, or from the Plugins page.</p>`}
          </div>`
        : nothing}
      ${this.alert(this.voiceMsg)} ${this.renderMicTest()}
    `;
  }

  /**
   * Cloud first (owner directive 2026-10-27): on a self-hosted install, point out
   * the always-on hosted option without getting in the way of local use. Never
   * shown on InfiniBot Cloud itself.
   */
  private renderAlwaysOnCloud(where: "phone" | "done"): TemplateResult | typeof nothing {
    if (isCloudBuild()) return nothing;
    const lead =
      where === "phone"
        ? "Your phone reaches InfiniBot while this computer is on."
        : "This InfiniBot runs while this computer is on.";
    return html`<div class="iob-note iob-cloud" data-testid="onb-cloud-always-on">
      ${icon("globe")}
      <span>${lead} <b>Want it always on?</b> InfiniBot Cloud runs your agents 24/7 on a private machine (Pro, $49/mo; Free plan to try, no card).
        <a href="https://cloud.infinibotos.com/pricing" target="_blank" rel="noopener">See InfiniBot Cloud</a></span>
    </div>`;
  }

  private renderPhone(): TemplateResult {
    const phones = this.picked.has("phones");
    return html`
      ${this.header(
        "Put InfiniBot on your phone",
        "First give InfiniBot a private link so your phone can reach it from anywhere, then pick your phone and scan the code.",
      )}
      <div class="iob-panel" data-testid="onb-phone">
        <ib-remote-access-setup
          .client=${this.client}
          @remote-link=${(e: CustomEvent<{ url: string | null; verified: boolean }>) => (this.remoteLink = e.detail)}
        ></ib-remote-access-setup>
        <ib-phone-app-setup
          style="display:block;margin-top:22px;padding-top:18px;border-top:1px solid rgba(255,255,255,0.08)"
          .client=${this.client}
          .remoteUrl=${this.remoteLink.url}
          .remoteVerified=${this.remoteLink.verified}
        ></ib-phone-app-setup>
        <details style="margin-top:14px">
          <summary class="sob-hint" style="cursor:pointer">Sign in a browser on another device without the password (one-time invite)</summary>
          <pair-invite-panel style="margin-top:10px"></pair-invite-panel>
        </details>
      </div>
      ${this.renderAlwaysOnCloud("phone")}
      ${phones
        ? html`<div class="iob-note">
            ${icon("smartphone")}
            <span>Automating Android phones? Droid Swarm links each phone separately. You'll find it in your plan on the next steps.</span>
          </div>`
        : nothing}
    `;
  }

  private renderBrowser(): TemplateResult {
    return html`
      ${this.header(
        "Connect your browser",
        isCloudBuild()
          ? "Your cloud assistant has its own browser. Here's how to let it use your Chrome too."
          : "Let InfiniBot work in your own Chrome, with your logins: add the extension, pair it, and try it. About a minute.",
      )}
      <div class="iob-panel" data-testid="onb-browser">
        <ib-browser-connect-setup
          .client=${this.client}
          context=${isCloudBuild() ? "cloud" : "onboarding"}
          .skippable=${false}
        ></ib-browser-connect-setup>
      </div>
    `;
  }

  private renderAiApps(): TemplateResult {
    return html`
      ${this.header(
        "Connect your AI apps",
        "Add InfiniBot to Claude Code, Claude Desktop, Cursor, Codex or VS Code in one click, so they can use its memory, tasks, agents and your browser.",
      )}
      <div class="iob-panel" data-testid="onb-aiapps">
        <ib-mcp-clients-setup
          .client=${this.client}
          context=${isCloudBuild() ? "cloud" : "onboarding"}
          .skippable=${false}
        ></ib-mcp-clients-setup>
      </div>
    `;
  }

  // Optional: link KinglyVault (kinglyvault-relay plugin, on by default and
  // idle until paired). Its own step so the brain / browser / MCP steps stay
  // untouched. Skip in the footer always works; Connect can happen later from
  // Plugins or Setup › Connect KinglyVault.
  private renderKinglyVault(): TemplateResult {
    return html`
      ${this.header(
        "Sign in with KinglyVault (optional)",
        "Have a KinglyVault account? Sign in once on kinglyvault.com and this page updates by itself. Signing in again on this computer reuses the same link. Skip if you don't use KinglyVault.",
      )}
      <div class="iob-panel" data-testid="onb-kinglyvault">
        <kv-connect-card mode="onboarding" .client=${this.client}></kv-connect-card>
      </div>
    `;
  }

  private renderPrivacy(): TemplateResult {
    const s = this.secure;
    const local = Boolean(this.currentPrimary?.startsWith("ollama/") || this.currentPrimary?.startsWith("vllm/") || this.ollama?.models.length);
    return html`
      ${this.header(
        "Keep private things private",
        "Secure Mode gives you private chats and files that only use AI models on this computer. Nothing in them is sent to the internet.",
      )}
      <div class="iob-panel">
        <div class="iob-secure">
          <span class="iob-secure__icon">${icon(s?.enabled ? "lock" : "unlock")}</span>
          <div class="iob-secure__text">
            <div class="iob-mic__title">Secure Mode</div>
            <div class="sob-hint">
              ${s === null
                ? "Checking…"
                : !s.available
                  ? "This InfiniBot doesn't have Secure Mode yet."
                  : s.enabled
                    ? "On: secure chats only use local models."
                    : local
                      ? "Off. Turn it on to keep sensitive chats on this computer."
                      : "Off. It needs a model on this computer (step 2) to answer secure chats."}
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked=${s?.enabled ? "true" : "false"}
            aria-label="Secure Mode"
            class="sob-switch iob-switch ${s?.enabled ? "is-on" : ""}"
            data-testid="onb-secure-toggle"
            ?disabled=${!s?.available || this.secureBusy}
            @click=${() => void this.toggleSecure(!s?.enabled)}
          ><span></span></button>
        </div>
        ${this.secureMsg ? html`<p class="sob-hint" role="status">${this.secureMsg}</p>` : nothing}
      </div>
    `;
  }

  private badge(b: string): TemplateResult {
    const label = b === "pro" ? "Pro" : b === "paid" ? "Paid" : b === "desktop" ? "Desktop" : "Free";
    return html`<span class="iob-badge iob-badge--${b}">${label}</span>`;
  }

  private renderRecommend(): TemplateResult {
    const plan = this.plan();
    const toggle = (id: string) => {
      const next = new Set(this.enable);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      this.enable = next;
    };
    return html`
      ${this.header(
        "Your plan",
        this.picked.size
          ? "Based on your goals. Untick anything you don't want. Paid plugins are never bought for you."
          : "A general starting point. Go back to step 1 to tailor it.",
      )}
      <section class="iob-section" aria-labelledby="iob-plugins-h" data-learn-id="onboarding-plugins">
        <h3 id="iob-plugins-h" class="iob-h3">${icon("puzzle")}Plugins</h3>
        ${!this.pluginsLoaded
          ? html`<p class="sob-hint">Loading plugins…</p>`
          : this.decisions.length === 0
            ? html`<p class="sob-hint">No extra plugins needed. Everything you picked is built in.</p>`
            : html`<div class="iob-plugins">
                ${this.decisions.map((d) => {
                  const can = d.action === "enable" || (Boolean(this.editStep) && d.action === "on");
                  const on = d.action === "on" && !can;
                  const checked = on || (can && this.enable.has(d.id));
                  return html`<div class="iob-plugin ${checked ? "is-selected" : ""}" data-testid=${`onb-plugin-${d.id}`}>
                    <div class="iob-plugin__main">
                      <div class="iob-plugin__name">${d.name} ${d.badges.map((b) => this.badge(b))}</div>
                      <div class="sob-hint">${d.description}</div>
                      ${d.note ? html`<div class="iob-plugin__note">${d.note}</div>` : nothing}
                    </div>
                    ${can
                      ? html`<button
                          type="button"
                          role="switch"
                          aria-checked=${checked ? "true" : "false"}
                          aria-label=${`Turn on ${d.name}`}
                          data-testid=${`onb-plugin-switch-${d.id}`}
                          class="sob-switch iob-switch ${checked ? "is-on" : ""}"
                          @click=${() => toggle(d.id)}
                        ><span></span></button>`
                      : on
                        ? html`<span class="iob-state">${icon("checkCircle")}On</span>`
                        : d.action === "unavailable"
                          ? html`<span class="iob-state is-muted">Not here</span>`
                          : html`<button type="button" class="sob-btn sob-btn--ghost iob-small" data-testid=${`onb-plugin-get-${d.id}`} @click=${() => this.leave("plugins")}>
                              ${d.action === "buy" ? "View plan" : "Get it"}${icon("externalLink")}
                            </button>`}
                  </div>`;
                })}
              </div>`}
        <div class="iob-kv" data-testid="onb-kv-connect">
          <p class="sob-hint">Bought plugins on KinglyVault, or on the CEO plan? Connect your account and they unlock here.</p>
          <ib-kv-connect .client=${this.client} variant="compact" @kv-changed=${() => void this.loadPlan()}></ib-kv-connect>
        </div>
      </section>
      <section class="iob-section" aria-labelledby="iob-courses-h" data-learn-id="onboarding-courses">
        <h3 id="iob-courses-h" class="iob-h3">${icon("book")}Courses</h3>
        <ol class="iob-courses">
          ${plan.courses.map(
            (id, i) => html`<li class="iob-course" data-testid=${`onb-course-${id}`}>
              <span class="iob-course__num">${String(i + 1).padStart(2, "0")}</span>
              <span class="iob-course__title">${this.courseTitle(id)}</span>
              ${i === 0 ? html`<span class="sob-tag">Starts first, on the Chat page</span>` : nothing}
            </li>`,
          )}
        </ol>
      </section>
      <section class="iob-section" aria-labelledby="iob-defaults-h">
        <h3 id="iob-defaults-h" class="iob-h3">${icon("layoutGrid")}Starter setup</h3>
        <label class="iob-check-row">
          <input type="checkbox" .checked=${this.makeTasks} @change=${(e: Event) => (this.makeTasks = (e.target as HTMLInputElement).checked)} />
          <span>Add ${plan.tasks.length} starter task${plan.tasks.length === 1 ? "" : "s"}: ${plan.tasks.map((t) => t.title).join(" · ")}</span>
        </label>
        <label class="iob-check-row">
          <input type="checkbox" .checked=${this.setDashboard} @change=${(e: Event) => (this.setDashboard = (e.target as HTMLInputElement).checked)} />
          <span>Set the dashboard to the <strong>${plan.dashboard}</strong> layout</span>
        </label>
      </section>
    `;
  }

  private renderFinish(): TemplateResult {
    const plan = this.plan();
    if (this.applied && !this.applying && this.finishedAt) {
      return html`
        <div class="sob-done" data-testid="onb-done">
          <div class="sob-eyebrow sob-eyebrow--center"><span class="sob-eyebrow__rule"></span><span>Setup complete</span><span class="sob-eyebrow__rule"></span></div>
          <h2 class="sob-title sob-title--hero" tabindex="-1">You're all set</h2>
          <ul class="iob-applied">${this.applied.map((l) => this.applyLine(l))}</ul>
          ${this.renderPathPreview()}
          <p class="sob-sub" aria-live="polite" data-testid="onb-course-countdown">
            ${!firstChatDone()
              ? this.countdown > 0
                ? html`Opening your first chat in ${this.countdown}… Your learning path starts after InfiniBot's first reply.`
                : html`Say hello to InfiniBot first. Your learning path starts after its first reply.`
              : this.countdown > 0
                ? html`Starting ${this.pathItems.length ? html`lesson 1, <strong>${this.pathItems[0]!.title}</strong>,` : html`your first course, <strong>${this.courseTitle(plan.courses[0] ?? FIRST_COURSE)}</strong>,`} in ${this.countdown}…`
                : html`Your learning path is waiting on the Learn page.`}
          </p>
          <div class="iob-actions iob-actions--center">
            <button type="button" class="sob-btn sob-btn--primary sob-btn--xl" data-testid="onb-start-course" @click=${() => void this.startFirstCourse()}>
              ${firstChatDone() ? html`${icon("play")}${this.pathItems.length ? "Start my learning path" : "Start the first course"}` : html`${icon("messageSquare")}Start chatting`}
            </button>
            ${this.countdown > 0
              ? html`<button type="button" class="sob-btn sob-btn--ghost" @click=${() => this.cancelCountdown()}>Not now</button>`
              : html`<button type="button" class="sob-btn sob-btn--ghost" @click=${() => this.toDashboard()}>Go to the dashboard</button>`}
          </div>
          ${this.renderAlwaysOnCloud("done")}
          <button type="button" class="iob-exit iob-again" data-testid="onb-run-again" @click=${() => this.restart()}>Run setup again</button>
        </div>
      `;
    }
    const row = (label: string, value: TemplateResult | string) =>
      html`<div class="sob-manifest__row"><dt>${label}</dt><span class="sob-manifest__lead"></span><dd>${value}</dd></div>`;
    const status = (id: StepId) => (this.done.has(id) ? "Done" : this.skipped.has(id) ? "Skipped" : "Not visited");
    return html`
      ${this.header("Review and finish", "Here's what happens when you finish. Skipped steps stay available from Setup any time.")}
      <dl class="sob-manifest">
        ${row("Goals", this.picked.size ? [...this.picked].map((id) => USE_CASES.find((u) => u.id === id)?.title ?? id).join(", ") : "General")}
        ${row("AI brain", this.brainSummary() ?? status("model"))}
        ${row("Channels", this.telegramConnected ? "Telegram connected" : this.wa.linked ? "WhatsApp linked" : status("channels"))}
        ${row("Voice", this.voiceChoice === "local" ? "Local voice" : this.voiceChoice === "cloud" ? "Cloud voice (Robovoice)" : "Later")}
        ${row("Secure Mode", this.secure ? (this.secure.enabled ? "On" : "Off") : status("privacy"))}
        ${row("Plugins to turn on", this.enable.size ? [...this.enable].map((id) => this.decisions.find((d) => d.id === id)?.name ?? id).join(", ") : "None")}
        ${row("Learning path", plan.courses.slice(0, 4).map((c) => this.courseTitle(c)).join(" → ") || this.courseTitle(FIRST_COURSE))}
      </dl>
      ${this.applied ? html`<ul class="iob-applied">${this.applied.map((l) => this.applyLine(l))}</ul>` : nothing}
    `;
  }

  /** The lessons InfiniBot picked for these goals, in order. */
  private renderPathPreview(): TemplateResult | typeof nothing {
    const items = this.pathItems;
    if (!items.length) return nothing;
    const mins = items.reduce((n, i) => n + i.estMinutes, 0);
    return html`<section class="iob-path" data-testid="onb-learning-path" data-learn-id="onboarding-learning-path" aria-label="Your learning path">
      <div class="iob-path__head">
        <span class="iob-path__icon">${icon("book")}</span>
        <div>
          <div class="iob-path__title">Your learning path</div>
          <div class="sob-hint">${items.length} short guided lessons · about ${mins} minutes · picked for your goals. Each one walks you through the real app.</div>
        </div>
      </div>
      <ol class="iob-path__list">
        ${items.slice(0, 8).map(
          (i, n) => html`<li><span class="iob-path__n">${n + 1}</span><span class="iob-path__name">${i.title}<span class="sob-hint"> · ${i.trackTitle}</span></span><span class="iob-path__min">${i.estMinutes} min</span></li>`,
        )}
        ${items.length > 8 ? html`<li class="iob-path__more"><span class="sob-hint">+ ${items.length - 8} more on the Learn page</span></li>` : nothing}
      </ol>
    </section>`;
  }

  private applyLine(l: ApplyLine): TemplateResult {
    const glyph: IconName = l.status === "ok" ? "checkCircle" : l.status === "fail" ? "alertCircle" : l.status === "skip" ? "minus" : "loader";
    return html`<li class="iob-applied__row is-${l.status}">${icon(glyph)}<span>${l.label}</span>${l.detail ? html`<span class="sob-hint">${l.detail}</span>` : nothing}</li>`;
  }

  private body(): TemplateResult {
    switch (this.step) {
      case "usecases":
        return this.renderUseCases();
      case "model":
        return this.renderModel();
      case "channels":
        return this.renderChannels();
      case "voice":
        return this.renderVoice();
      case "phone":
        return this.renderPhone();
      case "browser":
        return this.renderBrowser();
      case "aiapps":
        return this.renderAiApps();
      case "kinglyvault":
        return this.renderKinglyVault();
      case "privacy":
        return this.renderPrivacy();
      case "recommend":
        return this.renderRecommend();
      default:
        return this.renderFinish();
    }
  }

  /** Setup › Your setup › Edit: just this step, then back to the summary. */
  private renderEdit(): TemplateResult {
    const area = areaFor(this.step);
    const commits = this.step === "usecases" || this.step === "voice" || this.step === "recommend";
    return html`
      ${terminalAmbientStyles()} ${onboardingStyles()} ${setupStyles()} ${g8GlassStyles} ${onboardingFlowStyles}
      <div class="sob-screen g8-page is-long iob-screen iob-edit" data-testid="onboarding-flow" data-edit-step=${this.step}>
        ${renderTerminalGround()}
        <main class="sob-stage">
          <div class="sob-console" style="--sob-progress:1;--sob-steps:1">
            <span class="sob-corner sob-corner--tl"></span><span class="sob-corner sob-corner--tr"></span>
            <span class="sob-corner sob-corner--bl"></span><span class="sob-corner sob-corner--br"></span>
            <div class="sob-console__inner">
              <div class="sob-bar">
                <div class="sob-bar__brand">
                  <img src=${BRAND_DEFAULT_LOGO} alt="" />
                  <span class="sob-bar__name">InfiniBot</span>
                  <span class="sob-bar__path">/ setup / ${area?.label ?? this.step}</span>
                </div>
                <div class="sob-bar__status">
                  <button type="button" class="iob-exit" data-testid="onb-edit-back" @click=${() => this.endEdit(false)}>${icon("arrowLeft")} Back to your setup</button>
                </div>
              </div>
              <div class="sob-body iob-edit__body">
                <section class="sob-panel" aria-live="off">${keyed(this.step, html`<div class="sob-panel__step">${this.body()}</div>`)}</section>
              </div>
              ${this.alert(this.editMsg)}
              <footer class="sob-foot">
                <button type="button" class="sob-btn sob-btn--ghost" data-testid="onb-edit-cancel" ?disabled=${this.editBusy} @click=${() => this.endEdit(false)}>
                  ${commits ? "Cancel" : "Back"}
                </button>
                <span class="sob-foot__spacer"></span>
                <span class="sob-hint iob-edit__applies" data-testid="onb-edit-applies">${area?.applies ?? ""}</span>
                <button
                  type="button"
                  class="sob-btn sob-btn--primary"
                  data-testid="onb-edit-save"
                  aria-busy=${this.editBusy ? "true" : "false"}
                  ?disabled=${this.editBusy}
                  @click=${() => void this.saveEdit()}
                >
                  ${this.editBusy ? html`<span class="sob-spinner"></span>Saving…` : commits ? html`Save${icon("check")}` : html`Done${icon("check")}`}
                </button>
              </footer>
            </div>
          </div>
        </main>
      </div>
    `;
  }

  render() {
    if (this.editStep) return this.renderEdit();
    const i = this.index();
    const total = ONBOARDING_STEPS.length;
    const isLast = this.step === "finish";
    const finished = Boolean(this.finishedAt && this.applied);
    const progress = finished ? 1 : i / (total - 1);
    const current = ONBOARDING_STEPS[i]!;
    return html`
      ${terminalAmbientStyles()} ${onboardingStyles()} ${setupStyles()} ${g8GlassStyles} ${onboardingFlowStyles}
      <div class="sob-screen g8-page is-long iob-screen" data-testid="onboarding-flow">
        ${renderTerminalGround()}
        <main class="sob-stage">
          <header class="sob-hero">
            <div class="sob-hero__eyebrow"><span class="sob-led is-on"></span>Welcome</div>
            <h1 class="sob-hero__title">Let's set up InfiniBot</h1>
            <p class="sob-hero__sub">Ten short steps, all optional. Your progress is saved, so you can stop and come back any time.</p>
            <div class="sob-hero__guide">${renderSetupGuideButton()}</div>
          </header>
          <div class="sob-console" style="--sob-progress:${progress};--sob-steps:${total}">
            <span class="sob-corner sob-corner--tl"></span><span class="sob-corner sob-corner--tr"></span>
            <span class="sob-corner sob-corner--bl"></span><span class="sob-corner sob-corner--br"></span>
            <span class="sob-console__trace"></span>
            <div class="sob-console__inner">
              <div class="sob-bar">
                <div class="sob-bar__brand">
                  <img src=${BRAND_DEFAULT_LOGO} alt="" />
                  <span class="sob-bar__name">InfiniBot</span>
                  <span class="sob-bar__path">/ setup</span>
                </div>
                <div class="sob-bar__status">
                  <button type="button" class="iob-exit" data-testid="onb-advanced" @click=${() => this.openAdvanced()} title="Federation, coding agents, Notion and more">Advanced</button>
                  <button type="button" class="iob-exit" data-testid="onb-exit" @click=${() => this.exit()}>Save and exit</button>
                  <span class="sob-bar__count">${finished ? "Done" : `${String(i + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}`}</span>
                </div>
              </div>
              <div class="sob-body">
                <nav class="sob-rail is-long" aria-label="Setup progress">
                  <span class="sob-rail__track"><span class="sob-rail__fill"></span></span>
                  ${ONBOARDING_STEPS.map((s, n) => {
                    const done = this.done.has(s.id) || finished;
                    const skipped = this.skipped.has(s.id) && !done;
                    const active = n === i && !finished;
                    return html`<button
                      type="button"
                      class="sob-node ${active ? "is-active" : ""} ${done ? "is-done" : ""} ${skipped ? "is-skipped" : ""}"
                      aria-current=${active ? "step" : "false"}
                      aria-label=${`Step ${n + 1}: ${s.label}${done ? " (done)" : skipped ? " (skipped)" : ""}`}
                      data-learn-id=${`onboarding-step-${s.id}`}
                      ?disabled=${this.applying}
                      @click=${() => this.go(s.id)}
                    >
                      <span class="sob-node__dot">${done ? icon("check") : html`<span class="sob-node__num">${n + 1}</span>`}</span>
                      <span class="sob-node__text">
                        <span class="sob-node__code">${String(n + 1).padStart(2, "0")}</span>
                        <span class="sob-node__label">${s.label}</span>
                        <span class="sob-node__hint">${skipped ? "Skipped" : s.hint}</span>
                      </span>
                    </button>`;
                  })}
                </nav>
                ${finished
                  ? nothing
                  : html`<div class="sob-rail__now" aria-hidden="true">
                      <span class="sob-rail__now-code">${String(i + 1).padStart(2, "0")}</span>${current.label}<span class="sob-dot"></span><span class="sob-rail__now-hint">${current.hint}</span>
                    </div>`}
                <section class="sob-panel" aria-live="off">${keyed(this.step, html`<div class="sob-panel__step">${this.body()}</div>`)}</section>
              </div>
              ${finished
                ? nothing
                : html`<footer class="sob-foot">
                    <button type="button" class="sob-btn sob-btn--ghost" ?disabled=${i === 0 || this.applying} @click=${() => this.go(this.prevStep())}>
                      ${icon("arrowLeft")}Back
                    </button>
                    <span class="sob-foot__spacer"></span>
                    ${isLast
                      ? html`<button
                          type="button"
                          class="sob-btn sob-btn--primary"
                          data-testid="onb-finish"
                          aria-busy=${this.applying ? "true" : "false"}
                          ?disabled=${this.applying}
                          @click=${() => void this.apply()}
                        >
                          ${this.applying ? html`<span class="sob-spinner"></span>Setting things up…` : html`Finish setup${icon("arrowRight")}`}
                        </button>`
                      : this.step === "model" && this.cliOffered() && this.cliSetup.view().phase !== "pick"
                        ? // The setup checklist has its own single gold action
                          // (and "Continue setup first" once connected).
                          nothing
                        : html`<button type="button" class="sob-btn sob-btn--ghost" data-testid="onb-skip" @click=${() => this.go(this.nextStep(), "skipped")}>Skip</button>
                          <button
                            type="button"
                            class="sob-btn ${this.step === "model" && this.cliOffered() && !this.done.has("model") ? "sob-btn--ghost" : "sob-btn--primary"}"
                            data-testid="onb-next"
                            @click=${() => this.go(this.nextStep(), "done")}
                          >
                            Continue${icon("arrowRight")}
                          </button>`}
                  </footer>`}
            </div>
          </div>
        </main>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ib-onboarding-flow": OnboardingFlow;
  }
}
