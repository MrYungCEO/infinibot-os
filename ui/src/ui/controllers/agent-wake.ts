/**
 * Agent wake-word controller.
 *
 * For every known agent, register a wake word `hey <name>` so the user
 * can say "hey Romeo" and the live-action voice side panel opens for
 * Romeo. Reuses the existing per-panel wake-word infrastructure in
 * controllers/wake-word.ts — one registration per agent, scoped by
 * panelId = `agent:<id>`.
 *
 * Lifecycle:
 *   - syncAgentWakeWords() is the single entry point. Call it after the
 *     agent list loads and any time it changes (rename / add / remove).
 *     It diffs the current registry against the desired set and
 *     reconciles via register / update / unregister.
 *   - Master "always on" toggle lives in localStorage so it survives
 *     reloads. When ON, every agent's wake word is enabled and the
 *     listener keeps running in the background; when OFF, all agent
 *     wake words are disabled and the listener idles.
 */

import {
  registerPanelWakeWord,
  updatePanelWakeWord,
  type PanelWakeConfig,
} from "./wake-word.js";

const STORAGE_KEY = "infinibot-agent-wake";

interface PersistedSettings {
  alwaysOn: boolean;
  /** Per-agent overrides for the auto-derived "hey <name>" trigger. */
  overrides?: Record<string, string>;
  /** Threshold applied to every agent wake-word (sensitivity 0.1–0.9). */
  threshold?: number;
}

interface AgentLike {
  id: string;
  name?: string | null;
}

interface RegisteredAgent {
  id: string;
  name: string;
  wakeWord: string;
  unsubscribe: () => void;
}

type OpenVoiceForAgent = (agent: { id: string; name: string; wakeWord: string }) => void;

const registry = new Map<string, RegisteredAgent>();
let openHandler: OpenVoiceForAgent | null = null;
let settings: PersistedSettings = loadSettings();

function loadSettings(): PersistedSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as PersistedSettings;
      return {
        alwaysOn: !!parsed.alwaysOn,
        overrides: parsed.overrides ?? {},
        threshold: typeof parsed.threshold === "number" ? parsed.threshold : 0.5,
      };
    }
  } catch {
    /* corrupt storage — fall through to defaults */
  }
  return { alwaysOn: true, overrides: {}, threshold: 0.5 };
}

function saveSettings(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* quota / private mode — non-fatal */
  }
}

function panelIdFor(agent: AgentLike): string {
  return `agent:${agent.id}`;
}

/**
 * Compute the wake phrase the listener should match for this agent.
 * Format is "hey <name>" lowercased — keeps it consistent and easy to
 * remember. A per-agent override lets the user dial in a custom phrase
 * (e.g. for agents with names that don't transcribe well).
 */
function wakeWordFor(agent: AgentLike): string {
  const id = agent.id;
  const override = settings.overrides?.[id]?.trim();
  if (override) return override.toLowerCase();
  const name = (agent.name ?? "").trim();
  if (!name) return "";
  return `hey ${name.toLowerCase()}`;
}

/** Bind the live-action voice panel opener once at app boot. */
export function setAgentWakeOpenHandler(handler: OpenVoiceForAgent): void {
  openHandler = handler;
}

/** Master always-on toggle. */
export function setAgentWakeAlwaysOn(enabled: boolean): void {
  settings.alwaysOn = enabled;
  saveSettings();
  for (const reg of registry.values()) {
    updatePanelWakeWord(panelIdFor({ id: reg.id }), { enabled });
  }
}

export function isAgentWakeAlwaysOn(): boolean {
  return settings.alwaysOn;
}

/** Override the wake phrase for one agent (or clear via empty string). */
export function setAgentWakeOverride(agentId: string, phrase: string): void {
  settings.overrides = settings.overrides ?? {};
  const clean = phrase.trim().toLowerCase();
  if (clean) settings.overrides[agentId] = clean;
  else delete settings.overrides[agentId];
  saveSettings();
}

/**
 * Reconcile the wake-word registry against the desired agent set. Call
 * this after every loadAgentsMgmt (or any agent mutation). Idempotent —
 * unchanged agents keep their existing registration.
 */
export function syncAgentWakeWords(agents: AgentLike[] | undefined | null): void {
  if (!openHandler) {
    // Boot order: app may call sync before the voice panel registers
    // its opener. Drop quietly — the next sync after init will catch up.
    return;
  }
  const seen = new Set<string>();
  for (const agent of agents ?? []) {
    if (!agent?.id) continue;
    const word = wakeWordFor(agent);
    if (!word) continue; // unnamed agent — nothing to register
    seen.add(agent.id);
    const existing = registry.get(agent.id);
    if (existing) {
      // Reconcile rename / phrase override.
      if (existing.wakeWord !== word) {
        existing.wakeWord = word;
        existing.name = (agent.name ?? existing.name).toString();
        updatePanelWakeWord(panelIdFor(agent), { wakeWord: word });
      }
      // Reconcile master toggle.
      updatePanelWakeWord(panelIdFor(agent), { enabled: settings.alwaysOn });
      continue;
    }
    const cfg: PanelWakeConfig = {
      panelId: panelIdFor(agent),
      enabled: settings.alwaysOn,
      wakeWord: word,
      threshold: settings.threshold ?? 0.5,
      callback: () => {
        const handler = openHandler;
        if (!handler) return;
        try {
          handler({
            id: agent.id,
            name: (agent.name ?? "").toString(),
            wakeWord: word,
          });
        } catch (err) {
          console.error("[agent-wake] open handler threw:", err);
        }
      },
    };
    const unsubscribe = registerPanelWakeWord(cfg);
    registry.set(agent.id, {
      id: agent.id,
      name: (agent.name ?? "").toString(),
      wakeWord: word,
      unsubscribe,
    });
  }
  // Drop agents that no longer exist.
  for (const [id, reg] of registry) {
    if (!seen.has(id)) {
      try {
        reg.unsubscribe();
      } catch {
        /* ignore */
      }
      registry.delete(id);
    }
  }
}

/** Diagnostic — what's currently active. Used by settings UI. */
export function listAgentWakeRegistrations(): Array<{
  id: string;
  name: string;
  wakeWord: string;
}> {
  return [...registry.values()].map((r) => ({
    id: r.id,
    name: r.name,
    wakeWord: r.wakeWord,
  }));
}
