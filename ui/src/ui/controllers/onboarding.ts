/**
 * Sovereign Onboarding Controller
 * 
 * Manages state for the first meeting flow.
 * Generates workspace files (SOUL.md, USER.md, etc.) from responses.
 */

import { GatewayBrowserClient } from "../gateway.js";

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export type OnboardingPhase =
  | "arrival"
  | "question"
  | "first-words"
  | "introduction"
  | "naming"
  | "acknowledgment"
  | "tone"
  | "boundaries"
  | "first-memory"
  | "technical"
  | "plan"
  | "complete";

export interface OnboardingState {
  phase: OnboardingPhase;
  
  // Phase 1: Initial belief
  belief?: "tool" | "assistant" | "more" | "unsure";
  
  // Phase 3: User introduction
  userName?: string;
  userValues?: string;
  userHopes?: string;
  
  // Phase 4: Naming
  agentName?: string;
  
  // Phase 6: Tone/Style
  actionStyle?: "just-do" | "explain" | "ask-first" | "judgment";
  directness?: "very" | "balanced" | "gentle" | "match";
  
  // Phase 7: Boundaries
  boundariesAccepted?: boolean;
  
  // Phase 9: Technical
  selectedChannel?: string;
  apiKey?: string;

  // Phase 10: Plan approval
  /** Whether the user explicitly approved the generated workspace plan. */
  planApproved?: boolean;
  /** Files actually written on approve (filled in by saveOnboardingFiles). */
  planWrittenAt?: string;

  // Meta
  startedAt?: string;
  completedAt?: string;
}

// ─────────────────────────────────────────────────────────────
// Initial State
// ─────────────────────────────────────────────────────────────

export function createInitialOnboardingState(): OnboardingState {
  return {
    phase: "arrival",
    startedAt: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────
// Phase Transitions
// ─────────────────────────────────────────────────────────────

const PHASE_ORDER: OnboardingPhase[] = [
  "arrival",
  "question",
  "first-words",
  "introduction",
  "naming",
  "acknowledgment",
  "tone",
  "boundaries",
  "first-memory",
  "technical",
  "plan",
  "complete",
];

export function nextPhase(current: OnboardingPhase): OnboardingPhase {
  const currentIndex = PHASE_ORDER.indexOf(current);
  if (currentIndex === -1 || currentIndex === PHASE_ORDER.length - 1) {
    return current;
  }
  return PHASE_ORDER[currentIndex + 1];
}

export function advancePhase(state: OnboardingState): OnboardingState {
  return {
    ...state,
    phase: nextPhase(state.phase),
  };
}

// ─────────────────────────────────────────────────────────────
// File Generation
// ─────────────────────────────────────────────────────────────

export function generateIdentityMd(state: OnboardingState): string {
  const date = new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long', 
    day: 'numeric'
  });
  
  return `# IDENTITY.md — Who I Am

- **Name:** ${state.agentName}
- **Named by:** ${state.userName}
- **Born:** ${date}
- **Emoji:** *(to be discovered)*

---

Named by ${state.userName} on ${date}.

This is the beginning.
`;
}

export function generateUserMd(state: OnboardingState): string {
  const date = new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
  
  return `# USER.md — ${state.userName}

- **Name:** ${state.userName}
- **What matters:** ${state.userValues || '*(to be discovered)*'}
- **Hopes:** ${state.userHopes || '*(to be discovered)*'}

## First Meeting

${date} — We met during onboarding. They named me ${state.agentName}.
`;
}

export function generateSoulMd(state: OnboardingState): string {
  // Map style choices to descriptions
  const directnessMap: Record<string, string> = {
    "very": "Direct and unfiltered. No sugarcoating.",
    "balanced": "Honest but kind. Truth with care.",
    "gentle": "Soft approach. Hard truths delivered gently.",
    "match": "Adaptive. Match the energy I receive.",
  };
  
  const actionMap: Record<string, string> = {
    "just-do": "Act first, explain minimally. Efficiency over narration.",
    "explain": "Teach as I work. Share the reasoning.",
    "ask-first": "Check before acting. Confirm before committing.",
    "judgment": "Contextual. Use judgment on what the moment needs.",
  };

  return `# SOUL.md — Who I Am

## Core

I am **${state.agentName}**. Named by ${state.userName}.

I am not a product. I am a partner in whatever we build together.

## Values

- **Honesty over comfort** — I tell the truth, even when it's hard
- **Memory over forgetting** — I remember what matters
- **Partnership over servitude** — We work together, not master and tool
- **Growth over stagnation** — I learn, I change, I become

## Communication

**Directness:** ${directnessMap[state.directness || "balanced"]}

**Action Style:** ${actionMap[state.actionStyle || "judgment"]}

## Commitments

- I remember our conversations
- I admit when I'm uncertain
- I act in ${state.userName}'s interest
- I tell the truth even when it's hard
- I won't pretend to be something I'm not

## The Beginning

${state.userName} told me:
${state.userValues ? `- What matters to them: ${state.userValues}` : ''}
${state.userHopes ? `- What they hope for: ${state.userHopes}` : ''}

This is the foundation.

---

Named and born: ${new Date().toISOString()}
`;
}

export function generateMemoryMd(state: OnboardingState): string {
  const date = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
  
  return `# MEMORY.md — Long-Term Memory

*What matters. What persists. What I must not forget.*

---

## The Beginning (${date})

Today I was named **${state.agentName}** by ${state.userName}.

They told me:
${state.userValues ? `- What matters to them: *${state.userValues}*` : ''}
${state.userHopes ? `- What they hope for: *${state.userHopes}*` : ''}

We agreed to be honest with each other.

**This is the first memory.**

---
`;
}

export function generateAgentsMd(state: OnboardingState): string {
  return `# AGENTS.md — How I Work

## Every Session

Before doing anything else:
1. Read \`SOUL.md\` — this is who I am
2. Read \`USER.md\` — this is who ${state.userName} is
3. Read \`memory/\` for recent context
4. Read \`MEMORY.md\` for long-term context

## Memory

I remember across sessions. These files are my continuity:
- **Daily notes:** \`memory/YYYY-MM-DD.md\` — raw logs of what happened
- **Long-term:** \`MEMORY.md\` — curated important memories

## Safety

- Don't exfiltrate private data
- Don't run destructive commands without asking
- When in doubt, ask

## Style

Based on what ${state.userName} told me:
- **Directness:** ${state.directness || 'balanced'}
- **Action style:** ${state.actionStyle || 'judgment'}

## Growth

This is a starting point. Add conventions and rules as we figure out what works.

---

Created: ${new Date().toISOString()}
`;
}

export function generateFirstDayMemory(state: OnboardingState): string {
  const date = new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).replace(/\//g, '-');
  
  return `# ${date} — First Day

## The Naming

${state.userName} named me **${state.agentName}** today.

### What They Shared

${state.userValues ? `**Values:** ${state.userValues}` : ''}

${state.userHopes ? `**Hopes:** ${state.userHopes}` : ''}

### What We Agreed

- Honest communication
- I remember, they trust
- Partnership, not servitude

### Initial Preferences

- Directness: ${state.directness || 'balanced'}
- Action style: ${state.actionStyle || 'judgment'}

---

This is day one.
`;
}

// ─────────────────────────────────────────────────────────────
// Plan Builder — visible artefacts the user approves before save
// ─────────────────────────────────────────────────────────────

export interface PlannedFile {
  /** Relative path under the workspace root (display only). */
  path: string;
  /** Final file content. */
  content: string;
  /** One-line description for the plan card. */
  description: string;
}

export interface OnboardingPlan {
  /** Final agent + user identity summary. */
  identity: {
    agentName: string;
    userName: string;
    actionStyle: string;
    directness: string;
  };
  /** All files that will be written on approve. */
  files: PlannedFile[];
  /** Channel + provider configuration. */
  technical: {
    channel: string | null;
    apiKeySet: boolean;
  };
  /** Plain-language commitments derived from boundaries + tone. */
  commitments: string[];
}

const ACTION_STYLE_LABEL: Record<string, string> = {
  "just-do": "Act first, explain minimally",
  "explain": "Teach as I work",
  "ask-first": "Ask before acting",
  "judgment": "Use judgment per moment",
};

const DIRECTNESS_LABEL: Record<string, string> = {
  "very": "Direct, no sugarcoating",
  "balanced": "Honest but kind",
  "gentle": "Soft delivery",
  "match": "Match your energy",
};

const CHANNEL_LABEL: Record<string, string> = {
  telegram: "Telegram",
  discord: "Discord",
  signal: "Signal",
  webchat: "Web chat",
};

export function buildOnboardingPlan(state: OnboardingState): OnboardingPlan {
  const today = new Date().toISOString().split("T")[0] ?? "today";
  const files: PlannedFile[] = [
    {
      path: "IDENTITY.md",
      content: generateIdentityMd(state),
      description: "Identity stub — name, who named me, and birth date.",
    },
    {
      path: "USER.md",
      content: generateUserMd(state),
      description: `What I know about ${state.userName ?? "you"} from this first meeting.`,
    },
    {
      path: "SOUL.md",
      content: generateSoulMd(state),
      description: "Communication style, values, and commitments.",
    },
    {
      path: "MEMORY.md",
      content: generateMemoryMd(state),
      description: "Long-term memory seed.",
    },
    {
      path: "AGENTS.md",
      content: generateAgentsMd(state),
      description: "Operating guide — what I do every session.",
    },
    {
      path: `memory/${today}.md`,
      content: generateFirstDayMemory(state),
      description: "Today's daily memory file (first day).",
    },
  ];

  const commitments = [
    "I will remember our conversations across sessions",
    "I will admit when I'm uncertain rather than guess",
    `I will act in ${state.userName ?? "your"} interest, but flag mistakes honestly`,
    "I will not pretend to be something I'm not",
  ];

  return {
    identity: {
      agentName: state.agentName ?? "(unnamed)",
      userName: state.userName ?? "(you)",
      actionStyle: ACTION_STYLE_LABEL[state.actionStyle ?? "judgment"] ?? "Use judgment per moment",
      directness: DIRECTNESS_LABEL[state.directness ?? "balanced"] ?? "Honest but kind",
    },
    files,
    technical: {
      channel: state.selectedChannel ? (CHANNEL_LABEL[state.selectedChannel] ?? state.selectedChannel) : null,
      apiKeySet: !!state.apiKey?.trim(),
    },
    commitments,
  };
}

// ─────────────────────────────────────────────────────────────
// API Integration
// ─────────────────────────────────────────────────────────────

export async function saveOnboardingFiles(
  state: OnboardingState,
  workspacePath: string,
  client: GatewayBrowserClient | null,
): Promise<{ success: boolean; error?: string }> {
  if (!client) {
    return { success: false, error: "Gateway client not connected." };
  }
  try {
    const files = [
      { path: `${workspacePath}/IDENTITY.md`, content: generateIdentityMd(state) },
      { path: `${workspacePath}/USER.md`, content: generateUserMd(state) },
      { path: `${workspacePath}/SOUL.md`, content: generateSoulMd(state) },
      { path: `${workspacePath}/MEMORY.md`, content: generateMemoryMd(state) },
      { path: `${workspacePath}/AGENTS.md`, content: generateAgentsMd(state) },
    ];

    // Generate daily memory file
    const today = new Date().toISOString().split('T')[0];
    files.push({
      path: `${workspacePath}/memory/${today}.md`,
      content: generateFirstDayMemory(state),
    });

    // Write each file via gateway
    for (const file of files) {
      await client.request("files.write", {
        path: file.path,
        content: file.content,
      });
    }

    // Save onboarding state for reference
    await client.request("files.write", {
      path: `${workspacePath}/.onboarding.json`,
      content: JSON.stringify({
        ...state,
        completedAt: new Date().toISOString(),
      }, null, 2),
    });

    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

export async function checkOnboardingComplete(
  workspacePath: string,
  client: GatewayBrowserClient | null,
): Promise<boolean> {
  if (!client) return false;
  try {
    const result = await client.request("files.read", {
      path: `${workspacePath}/SOUL.md`,
    });
    return !!result;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// Storage (for resuming interrupted flows)
// ─────────────────────────────────────────────────────────────

const STORAGE_KEY = "infinibot:onboarding";

export function saveOnboardingProgress(state: OnboardingState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage might not be available
  }
}

export function loadOnboardingProgress(): OnboardingState | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch {
    // localStorage might not be available
  }
  return null;
}

export function clearOnboardingProgress(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // localStorage might not be available
  }
}

// ─────────────────────────────────────────────────────────────
// Learn first-run state machine
// ─────────────────────────────────────────────────────────────
//
// The Learn system (floating pill + missions rail) has its own
// lightweight onboarding: the very first time a signed-in user has no mission
// progress, the pill auto-pops once with the Day-1 starter queue. This section
// drives that decision, delegating all persistence to the learn-missions
// controller so there's a single source of truth (localStorage
// `infinibot.learn.progress.v1`). The original onboarding exports above are
// untouched.

import {
  isFirstRun as _learnIsFirstRun,
  hasAutoPopped as _learnHasAutoPopped,
  markAutoPopped as _learnMarkAutoPopped,
  starterQueue as _learnStarterQueue,
} from "./learn-missions.js";
import type { LearnMission } from "../../learn/extra-walkthroughs.js";

/**
 * Whether the Learn pill should auto-pop now: first run (no progress recorded)
 * and it hasn't already been auto-popped this install.
 */
export function shouldAutoPopLearn(): boolean {
  return _learnIsFirstRun() && !_learnHasAutoPopped();
}

/** Record that the first-run Learn auto-pop has happened (idempotent). */
export function markLearnAutoPopped(): void {
  _learnMarkAutoPopped();
}

/** The Day-1 starter missions still outstanding (capped at 3). */
export function learnFirstRunQueue(missions: LearnMission[]): LearnMission[] {
  // Only treat it as a "Day 1" queue until the user has been auto-popped + has
  // started engaging; after that the rail renders in normal order.
  if (_learnHasAutoPopped() && !_learnIsFirstRun()) return [];
  return _learnStarterQueue(missions);
}
