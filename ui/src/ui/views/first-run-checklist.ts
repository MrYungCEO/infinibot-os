/**
 * First-run getting-started checklist — the landing view for a brand-new
 * install (see controllers/first-run.ts for when it shows).
 *
 * Six steps, each with a one-click jump to the page that does it. Steps
 * auto-tick from live gateway state where that's cheap to detect; every step
 * can also be ticked by hand. "Skip to dashboard" dismisses it for good and
 * the normal dashboard (Business HQ) takes over.
 */

import { html, nothing, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../gateway";
import type { Tab } from "../navigation";
import { icon } from "../icons";
import { ensureHomeGlassStyles } from "./home-glass";
import {
  FIRST_RUN_ITEMS,
  firstRunProgress,
  isFirstRunItemDone,
  markFirstRunItem,
  refreshFirstRunChecks,
  setFirstRunStatus,
  type FirstRunItemId,
} from "../controllers/first-run";

export interface FirstRunHost {
  client: GatewayBrowserClient | null;
  setTab: (tab: Tab) => void;
  requestUpdate?: () => void;
  learn?: unknown;
}

interface ItemDef {
  title: string;
  desc: string;
  cta: string;
  optional?: boolean;
  icon: Parameters<typeof icon>[0];
  go: (host: FirstRunHost) => void;
}

function openSetupWizard(host: FirstRunHost): void {
  window.dispatchEvent(new CustomEvent("infinibot:setup-section", { detail: { section: "wizard" } }));
  host.setTab("setup" as Tab);
}

async function openWelcomeWalkthrough(host: FirstRunHost): Promise<void> {
  markFirstRunItem("learn");
  try {
    // The guided "Getting started" tour runs over the real app.
    const { startTrack } = await import("../../learn/guided/engine");
    if (await startTrack("getting-started")) return;
  } catch {
    /* fall through to the Learn page */
  }
  host.setTab("learn" as Tab);
}

const ITEMS: Record<FirstRunItemId, ItemDef> = {
  provider: {
    title: "Run the guided setup",
    desc: "Tell InfiniBot what you use it for, pick its brain (free on this computer or your own key), connect Telegram, set up voice and get a plan made for you.",
    cta: "Start setup",
    icon: "bot",
    go: openSetupWizard,
  },
  chat: {
    title: "Send your first message",
    desc: "Say hello in chat and make sure the model answers.",
    cta: "Open chat",
    icon: "messageSquare",
    go: (h) => h.setTab("webchat" as Tab),
  },
  channel: {
    title: "Connect a channel",
    desc: "Reach your assistant from Telegram, Discord or WhatsApp. The in-app chat works without this.",
    cta: "Open channels",
    optional: true,
    icon: "radio",
    go: (h) => h.setTab("channels" as Tab),
  },
  voice: {
    title: "Talk to it",
    desc: "Voice runs on this machine: open the Voice page and connect to talk to an agent or a CLI agent. Cloud voice (Robovoice) is optional for devices that can't run voice locally.",
    cta: "Open Voice",
    optional: true,
    icon: "mic",
    go: (h) => h.setTab("voice" as Tab),
  },
  agent: {
    title: "Spawn an agent",
    desc: "Hand a task to a background agent and watch it work.",
    cta: "Open agents",
    icon: "zap",
    go: (h) => h.setTab("agents" as Tab),
  },
  learn: {
    title: "Take the Welcome walkthrough",
    desc: "A short guided tour of the app. More walkthroughs live on the Learn page.",
    cta: "Start walkthrough",
    icon: "book",
    go: (h) => void openWelcomeWalkthrough(h),
  },
};

export function renderFirstRunChecklist(host: FirstRunHost): TemplateResult {
  ensureHomeGlassStyles();
  const rerender = () => host.requestUpdate?.();
  if (host.client) void refreshFirstRunChecks(host.client, rerender);
  const { done, total } = firstRunProgress();
  const allDone = done === total;
  const pct = Math.round((done / total) * 100);

  const finish = (status: "dismissed" | "complete") => {
    setFirstRunStatus(status);
    rerender();
  };

  return html`
    ${styles}
    <div class="frc-root" data-testid="first-run-checklist">
      <header class="frc-head">
        <div>
          <div class="frc-eyebrow">GETTING STARTED · ${done} OF ${total}</div>
          <h1 class="frc-title">${allDone ? "You're all set." : "Welcome to InfiniBot."}</h1>
          <p class="frc-sub">
            ${allDone
              ? "Everything's wired up. Your dashboard is next."
              : "A few steps to a working assistant. Each one opens the page that does it — come back here any time from the dashboard until you're done."}
          </p>
        </div>
        <button class="frc-skip" data-testid="first-run-skip" @click=${() => finish(allDone ? "complete" : "dismissed")}>
          ${allDone ? "Go to dashboard →" : "Skip to dashboard"}
        </button>
      </header>

      <div class="frc-bar" role="progressbar" aria-valuenow=${pct} aria-valuemin="0" aria-valuemax="100">
        <div class="frc-bar__fill" style="width:${pct}%"></div>
      </div>

      <ol class="frc-list">
        ${FIRST_RUN_ITEMS.map((id, i) => {
          const it = ITEMS[id];
          const isDone = isFirstRunItemDone(id);
          return html`
            <li class="frc-item ${isDone ? "is-done" : ""}" data-item=${id}>
              <button
                class="frc-check"
                title=${isDone ? "Mark as not done" : "Mark as done"}
                aria-label=${isDone ? `${it.title}: done` : `${it.title}: mark as done`}
                @click=${() => {
                  markFirstRunItem(id, !isDone);
                  rerender();
                }}
              >
                ${isDone ? icon("check") : html`<span class="frc-num">${i + 1}</span>`}
              </button>
              <div class="frc-body">
                <div class="frc-item__title">
                  ${it.title}
                  ${it.optional ? html`<span class="frc-opt">optional</span>` : nothing}
                </div>
                <div class="frc-item__desc">${it.desc}</div>
              </div>
              <button class="frc-cta ${isDone ? "" : "is-primary"}" @click=${() => it.go(host)}>
                <span class="frc-cta__ic">${icon(it.icon)}</span>${it.cta}
              </button>
            </li>
          `;
        })}
      </ol>

      <p class="frc-foot">
        Prefer the command line? <code>infinibot onboard</code> runs the same setup in a terminal.
      </p>
    </div>
  `;
}

const styles = html`<style>
  .frc-root {
    --frc-primary: var(--g-primary, #fbbf24);
    --frc-soft: color-mix(in srgb, var(--frc-primary) 12%, transparent);
    --frc-strong: color-mix(in srgb, var(--frc-primary) 38%, transparent);
    --frc-text: var(--text, #e4e4e7);
    --frc-mute: color-mix(in srgb, var(--text, #e4e4e7) 62%, transparent);
    --frc-border: color-mix(in srgb, var(--frc-primary) 18%, rgba(255,255,255,0.08));
    max-width: 880px; margin: 0 auto; padding: 32px 24px 48px; box-sizing: border-box; color: var(--frc-text);
  }
  .frc-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; flex-wrap: wrap; }
  .frc-eyebrow { font-size: 11px; letter-spacing: .14em; color: var(--frc-primary); font-weight: 600; }
  .frc-title { margin: 6px 0 8px; font-size: clamp(24px, 3.4vw, 34px); font-weight: 750; letter-spacing: -.01em; }
  .frc-sub { margin: 0; max-width: 560px; color: var(--frc-mute); font-size: 14px; line-height: 1.55; }
  .frc-skip { all: unset; cursor: pointer; font-size: 13px; color: var(--frc-mute); padding: 8px 12px; border-radius: 8px;
    border: 1px solid var(--frc-border); white-space: nowrap; }
  .frc-skip:hover { color: var(--frc-text); border-color: var(--frc-strong); }
  .frc-bar { margin: 22px 0 18px; height: 6px; border-radius: 999px; background: rgba(255,255,255,0.06); overflow: hidden; }
  .frc-bar__fill { height: 100%; background: var(--frc-primary); border-radius: inherit; transition: width .3s ease; }
  .frc-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
  .frc-item { display: flex; align-items: center; gap: 14px; padding: 14px 16px; border-radius: 14px;
    background: rgba(255,255,255,0.035); border: 1px solid var(--frc-border); }
  .frc-item.is-done { opacity: .72; }
  .frc-check { all: unset; cursor: pointer; flex: none; width: 30px; height: 30px; border-radius: 50%;
    display: grid; place-items: center; border: 1.5px solid var(--frc-strong); color: var(--frc-primary); font-size: 13px; font-weight: 700; }
  .frc-item.is-done .frc-check { background: var(--frc-primary); color: #111; border-color: var(--frc-primary); }
  .frc-check svg { width: 16px; height: 16px; }
  .frc-body { flex: 1; min-width: 0; }
  .frc-item__title { font-size: 15px; font-weight: 650; }
  .frc-item.is-done .frc-item__title { text-decoration: line-through; text-decoration-color: var(--frc-strong); }
  .frc-item__desc { margin-top: 3px; font-size: 13px; color: var(--frc-mute); line-height: 1.45; }
  .frc-opt { margin-left: 6px; font-size: 10px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase;
    padding: 1px 7px; border-radius: 999px; color: var(--frc-mute); border: 1px solid var(--frc-border); vertical-align: middle; }
  .frc-cta { all: unset; cursor: pointer; flex: none; display: inline-flex; align-items: center; gap: 7px; font-size: 13px;
    font-weight: 600; padding: 8px 14px; border-radius: 10px; border: 1px solid var(--frc-border); color: var(--frc-text); }
  .frc-cta:hover { border-color: var(--frc-strong); background: var(--frc-soft); }
  .frc-cta.is-primary { background: var(--frc-primary); color: #111; border-color: var(--frc-primary); }
  .frc-cta.is-primary:hover { filter: brightness(1.06); }
  .frc-cta__ic { display: inline-flex; }
  .frc-cta__ic svg { width: 15px; height: 15px; }
  .frc-foot { margin: 22px 0 0; font-size: 12px; color: var(--frc-mute); }
  .frc-foot code { font-size: 11.5px; }
  @media (max-width: 640px) {
    .frc-root { padding: 20px 14px 36px; }
    .frc-item { flex-wrap: wrap; }
    .frc-body { flex-basis: calc(100% - 46px); }
    .frc-cta { margin-left: 44px; }
  }
</style>`;
