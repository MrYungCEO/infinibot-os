/**
 * Autopilot Controller
 *
 * Page-by-page agentic mode. The user types a goal in the AgentChat sidebar;
 * the planner returns a list of `AutonomyCommand`s; we dispatch them through
 * `autonomyBus` and narrate progress back into the chat.
 *
 * The planner runs server-side via a single gateway method (`agent.autopilot.plan`).
 * If that method isn't available we fall back to a tiny client-side rule-based
 * planner so the sidebar still feels responsive on day one.
 */

import type { GatewayBrowserClient } from "../gateway";
import type { Tab } from "../navigation";
import { autonomyBus, type AutonomyCommand } from "../lib/autonomy-bus";

// ── Types ─────────────────────────────────────────────────────────

export type AutopilotMessageRole = "user" | "assistant" | "system";

export interface AutopilotMessage {
  id: string;
  role: AutopilotMessageRole;
  /** Plain-text content. Lines append-able (autopilot narrations). */
  text: string;
  /** Time the message was created (ms). */
  ts: number;
}

export interface AutopilotRun {
  id: string;
  startedAt: number;
  /** The user message that kicked off this run. */
  prompt: string;
  /** The assistant message id that we keep appending narration to. */
  msgId: string;
  /** Live status. */
  status: "planning" | "running" | "done" | "failed" | "stopped";
  /** Page tab the run was started on. */
  tab: Tab;
}

export interface AutopilotState {
  /** Whether autopilot mode is on (otherwise plain chat). */
  autopilotOn: boolean;
  /** Whether the sidebar is open. */
  sidebarOpen: boolean;
  /** Chat history shown in the sidebar. */
  messages: AutopilotMessage[];
  /** Active in-flight runs. */
  activeRuns: Map<string, AutopilotRun>;
  /** Current draft input. */
  draft: string;
  /** True while the sidebar is sending a regular (non-autopilot) chat msg. */
  sending: boolean;
  /** Last error (auto-clears on next send). */
  error: string | null;
}

// ── Factory ───────────────────────────────────────────────────────

export function createAutopilotState(): AutopilotState {
  return {
    autopilotOn: false,
    sidebarOpen: false,
    messages: [],
    activeRuns: new Map(),
    draft: "",
    sending: false,
    error: null,
  };
}

// ── Helpers ───────────────────────────────────────────────────────

function nextMsgId(): string {
  return `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function nextRunId(): string {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function appendMessage(
  state: AutopilotState,
  role: AutopilotMessageRole,
  text: string,
): AutopilotMessage {
  const msg: AutopilotMessage = { id: nextMsgId(), role, text, ts: Date.now() };
  state.messages = [...state.messages, msg];
  return msg;
}

export function appendLineToMessage(
  state: AutopilotState,
  msgId: string,
  line: string,
): void {
  state.messages = state.messages.map((m) => {
    if (m.id !== msgId) return m;
    const text = m.text ? `${m.text}\n${line}` : line;
    return { ...m, text };
  });
}

export function clearMessages(state: AutopilotState): void {
  state.messages = [];
  state.error = null;
}

// ── Plan execution ─────────────────────────────────────────────────

export interface AutopilotPlan {
  /** One-line narration to lead the run. */
  narration?: string;
  /** Ordered command list. */
  commands: AutonomyCommand[];
}

function describeStep(cmd: AutonomyCommand): string {
  switch (cmd.kind) {
    case "navigate":
      return `→ Opened ${cmd.tab}`;
    case "setFormField":
      return `· Set ${cmd.field}`;
    case "click":
      return `· Clicked ${cmd.target}`;
    case "focus":
      return `· Focused ${cmd.target}`;
    case "openModal":
      return `· Opened ${cmd.modal}`;
    case "closeModal":
      return `· Closed modal`;
    case "business.activate":
      return `· Activated business`;
    case "business.create":
      return `· Created business "${cmd.name}"`;
    case "business.section":
      return `· Switched to ${cmd.section}`;
    case "agents.select":
      return `· Selected agent ${cmd.agentId}`;
    case "agents.openConfig":
      return `· Opened ${cmd.agentId} config`;
    case "discipline.subView":
      return `· Discipline view: ${cmd.subView}`;
    case "discipline.startBlock":
      return `· Started block`;
    case "discipline.completeBlock":
      return `· Completed block`;
    case "discipline.applyPreset":
      return `· Applied preset ${cmd.presetId}`;
    case "grid.addPanel":
      return `· Added grid panel`;
    case "grid.send":
      return `· Sent to grid`;
    case "grid.removePanel":
      return `· Removed panel`;
    default:
      return `· ${(cmd as { kind: string }).kind}`;
  }
}

export interface RunAutopilotOptions {
  state: AutopilotState;
  client: GatewayBrowserClient;
  /** The page tab the user is currently on. */
  tab: Tab;
  /** User's natural-language goal. */
  prompt: string;
  /** Callback to trigger a re-render. */
  requestUpdate: () => void;
}

/** Run autopilot for one user prompt. Returns when the chain finishes. */
export async function runAutopilot(opts: RunAutopilotOptions): Promise<void> {
  const { state, client, tab, prompt, requestUpdate } = opts;
  const runId = nextRunId();
  const userMsg = appendMessage(state, "user", prompt);
  const assistantMsg = appendMessage(state, "assistant", "");
  const run: AutopilotRun = {
    id: runId,
    startedAt: Date.now(),
    prompt,
    msgId: assistantMsg.id,
    status: "planning",
    tab,
  };
  state.activeRuns.set(runId, run);
  requestUpdate();

  try {
    const plan = await fetchPlan(client, prompt, tab);
    run.status = "running";
    if (plan.narration) {
      appendLineToMessage(state, assistantMsg.id, plan.narration);
      requestUpdate();
    }

    if (!plan.commands.length) {
      run.status = "done";
      state.activeRuns.delete(runId);
      requestUpdate();
      return;
    }

    for (const cmd of plan.commands) {
      try {
        await autonomyBus.emitAndWait(cmd, { timeoutMs: 8000 });
        appendLineToMessage(state, assistantMsg.id, describeStep(cmd));
      } catch (err) {
        const msg = err instanceof Error ? err.message : "step failed";
        appendLineToMessage(state, assistantMsg.id, `⚠ ${msg}`);
        run.status = "failed";
        state.activeRuns.delete(runId);
        requestUpdate();
        return;
      }
      requestUpdate();
    }

    run.status = "done";
    state.activeRuns.delete(runId);
    requestUpdate();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "autopilot failed";
    appendLineToMessage(state, assistantMsg.id, `⚠ ${msg}`);
    run.status = "failed";
    state.activeRuns.delete(runId);
    requestUpdate();
  }

  // Suppress unused-variable warning while keeping the binding for future
  // features (e.g. a "rerun" button keyed off the original user message).
  void userMsg;
}

// ── Planner ────────────────────────────────────────────────────────

/** Try the gateway planner first; fall back to a local heuristic planner. */
async function fetchPlan(
  client: GatewayBrowserClient,
  prompt: string,
  tab: Tab,
): Promise<AutopilotPlan> {
  try {
    const res = (await client.request("agent.autopilot.plan", {
      prompt,
      tab,
    })) as AutopilotPlan;
    if (res && Array.isArray(res.commands)) return res;
  } catch {
    // fall through to local planner
  }
  return localPlan(prompt, tab);
}

/**
 * Tiny rule-based planner so the sidebar works even before the gateway
 * method is wired up. Recognises a handful of high-leverage intents per
 * page so the basic flow ("go to discipline, start the timeline view")
 * works out of the box.
 */
function localPlan(prompt: string, tab: Tab): AutopilotPlan {
  const p = prompt.toLowerCase();

  // Cross-page navigation triggers.
  const navTargets: Array<{ keywords: string[]; tab: Tab }> = [
    { keywords: ["business", "biz", "company"], tab: "business" },
    { keywords: ["agent"], tab: "agents" },
    { keywords: ["discipline", "schedule", "block"], tab: "discipline" },
    { keywords: ["grid", "multi-chat", "panels"], tab: "grid" },
    { keywords: ["chat"], tab: "chat" },
    { keywords: ["mcp"], tab: "mcp" },
  ];
  for (const { keywords, tab: t } of navTargets) {
    if (keywords.some((k) => p.includes(k)) && t !== tab) {
      return {
        narration: `Heading to ${t}.`,
        commands: [{ kind: "navigate", tab: t }],
      };
    }
  }

  if (tab === "discipline") {
    if (p.includes("timeline")) {
      return {
        narration: "Switching discipline to the timeline view.",
        commands: [{ kind: "discipline.subView", subView: "timeline" }],
      };
    }
    if (p.includes("block")) {
      return {
        narration: "Showing your blocks.",
        commands: [{ kind: "discipline.subView", subView: "blocks" }],
      };
    }
    if (p.includes("score") || p.includes("compliance")) {
      return {
        narration: "Showing your score.",
        commands: [{ kind: "discipline.subView", subView: "score" }],
      };
    }
    if (p.includes("deep focus")) {
      return {
        narration: "Applying the Deep Focus preset.",
        commands: [{ kind: "discipline.applyPreset", presetId: "deep-focus" }],
      };
    }
  }

  if (tab === "business") {
    if (p.includes("notion")) {
      return { narration: "Opening Notion settings.", commands: [{ kind: "business.section", section: "notion" }] };
    }
    if (p.includes("brand")) {
      return { narration: "Opening Brand controls.", commands: [{ kind: "business.section", section: "brand" }] };
    }
    if (p.includes("client")) {
      return { narration: "Opening Clients.", commands: [{ kind: "business.section", section: "clients" }] };
    }
    if (p.includes("plan")) {
      return { narration: "Opening Plan.", commands: [{ kind: "business.section", section: "plan" }] };
    }
  }

  if (tab === "grid") {
    if (p.includes("add") || p.includes("new")) {
      return { narration: "Adding a new chat panel.", commands: [{ kind: "grid.addPanel" }] };
    }
  }

  return {
    narration: "I'll need a more specific instruction — try \"go to discipline\" or \"open notion settings\".",
    commands: [],
  };
}
