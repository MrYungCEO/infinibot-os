/**
 * Every read and write the Voice page makes. All voice settings live in
 * Robovoice (or the Robovoice plugin's Robovoice-scoped settings), so every
 * method here is a robovoice.* RPC — the one exception is turning the plugin
 * itself on (plugins.setEnabled), which is not a voice setting.
 *
 * No /api/settings, /api/voices, voice.json or voice-settings.json: the local
 * voice pipeline is a hidden fallback provider, not configured from here.
 */

import type { RvLinkStatus, RvCredits } from "./console-state.js";

export type Rpc = <T>(method: string, params?: Record<string, unknown>) => Promise<T>;

export type RvCharacter = { id: string; name: string; description?: string; tts_provider?: string; language?: string };

/** Org-scoped config that doesn't belong to the linked Robovoice org (robovoice.config.validate). */
export type RvConfigIssue = {
  field: "characterMap" | "defaultCharacterId" | "linkedCharacters" | "pipelineLocationId";
  key?: string;
  value: string;
  problem: "not_in_org" | "not_linked";
  message: string;
};

export type RvVoiceLlmStatus = {
  publicUrl: string | null;
  baseUrl: string | null;
  locationId: string | null;
  token: { hint: string } | null;
  bound: boolean;
  agents: string[];
  ownerCallerEmails: string[];
  turns: VoiceTurnDiag[];
  summary: { turns: number; ok: number; firstTokenP50Ms: number | null; paths?: Record<string, number> };
  /** "auto" = fast path for conversation, full agent for tool work; "agent" = always the full agent. */
  mode?: "auto" | "agent";
  /** `provider/model` of the fast step (null = the agent's own model). */
  fastModel?: string | null;
};

/** One voice turn as InfiniBot ran it (its share of the latency). */
export type VoiceTurnDiag = {
  at: string;
  agentId: string;
  backend: string;
  trust: string;
  ok: boolean;
  firstTokenMs: number | null;
  totalMs: number;
  error?: string;
  path?: "fast" | "agent" | "fast+agent" | "cli";
  model?: string;
  prepMs?: number;
  firstSentenceMs?: number | null;
  agentPrepMs?: number | null;
  agentFirstTokenMs?: number | null;
  fastError?: string;
  call?: string;
};

export type RvSettingsView = {
  settings: {
    deployment: "self-hosted" | "cloud";
    baseUrl: string;
    defaultCharacterId?: string;
    characterMap: Record<string, string>;
    mcpPublicUrl?: string;
    link?: { orgName?: string; locationName?: string; deviceId?: string; unlinkedAt?: string };
  };
};

export type RvVoiceTest = { ok?: boolean; text: string; firstTokenMs: number | null; totalMs: number; backend: string };

/** Methods the Voice page may WRITE with. Tests pin this list. */
export const VOICE_PAGE_WRITE_METHODS = [
  "robovoice.link.start",
  "robovoice.link.cancel",
  "robovoice.link.sync",
  "robovoice.unlink",
  "robovoice.logout",
  "robovoice.call.start",
  "robovoice.call.end",
  "robovoice.mapping.set",
  "robovoice.settings.set",
  "robovoice.voiceAgent.set",
  "robovoice.voiceLlm.set",
  "robovoice.voiceLlm.rotate",
  "robovoice.voiceLlm.test",
  "robovoice.pipeline.config.set",
  "robovoice.location.select",
  "robovoice.config.validate",
  "plugins.setEnabled",
] as const;

export function voiceConsoleActions(rpc: Rpc) {
  return {
    // ── reads ──
    linkStatus: (remote = true) => rpc<RvLinkStatus>("robovoice.link.status", { remote }),
    credits: () => rpc<RvCredits>("robovoice.credits.get"),
    /** The LINKED org's agents at its location (never the deployment's public roster) + config issues. */
    characters: () =>
      rpc<{
        characters: RvCharacter[];
        characterMap?: Record<string, string>;
        defaultCharacterId?: string | null;
        issues?: RvConfigIssue[];
        linked?: boolean;
        error?: string;
      }>("robovoice.characters.list"),
    /** Re-check org-scoped ids against the linked org; `fix` clears the stale ones. */
    validateConfig: (fix = false) =>
      rpc<{ linked: boolean; issues: RvConfigIssue[]; cleared: boolean }>("robovoice.config.validate", fix ? { fix: true } : {}),
    settings: () => rpc<RvSettingsView>("robovoice.settings.get"),
    voiceLlmStatus: () => rpc<RvVoiceLlmStatus>("robovoice.voiceLlm.status"),

    // ── writes (all Robovoice) ──
    enablePlugin: () => rpc("plugins.setEnabled", { id: "robovoice", enabled: true }),
    linkStart: (apiBase?: string) =>
      rpc<{ userCode: string; verificationUriComplete: string; status: string }>("robovoice.link.start", apiBase ? { apiBase } : {}),
    linkCancel: () => rpc("robovoice.link.cancel"),
    sync: () => rpc("robovoice.link.sync"),
    unlink: () => rpc("robovoice.unlink"),
    logout: () => rpc("robovoice.logout"),
    setCharacter: (agentId: string, characterId: string | null) =>
      rpc<{ characterMap: Record<string, string> }>("robovoice.mapping.set", { agentId, characterId }),
    setDefaultCharacter: (characterId: string) => rpc<RvSettingsView>("robovoice.settings.set", { defaultCharacterId: characterId }),
    setOwnerCallerEmails: (emails: string[]) => rpc<RvSettingsView>("robovoice.settings.set", { ownerCallerEmails: emails }),
    /** Public URL Robovoice reaches this gateway on (voice LLM + agent tools), then re-sync. */
    setPublicUrl: async (url: string | null) => {
      const view = await rpc<RvSettingsView>("robovoice.settings.set", { mcpPublicUrl: url });
      const sync = await rpc<{ mcp?: { status?: string; error?: string } }>("robovoice.link.sync");
      return { view, sync };
    },
    setVoiceAgent: (agentId: string, patch: Record<string, unknown>) => rpc("robovoice.voiceAgent.set", { agentId, ...patch }),
    setVoiceLlm: (patch: { mode?: "auto" | "agent"; fastModel?: string }) => rpc<RvVoiceLlmStatus>("robovoice.voiceLlm.set", patch),
    rotateVoiceLlm: () => rpc<RvVoiceLlmStatus & { syncError?: string | null }>("robovoice.voiceLlm.rotate"),
    testVoiceLlm: (agentId: string) =>
      rpc<RvVoiceTest>("robovoice.voiceLlm.test", { agentId, message: "Introduce yourself in one short sentence." }),
  };
}

export type VoiceConsoleActions = ReturnType<typeof voiceConsoleActions>;

/** "a@x.com, b@y.com" → ["a@x.com","b@y.com"] */
export function parseEmails(raw: string): string[] {
  return raw
    .split(/[\s,;]+/)
    .map((e) => e.trim())
    .filter(Boolean);
}

/** Validate a public gateway URL (http/https) or empty (= off). */
export function normalizePublicUrl(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  const u = new URL(v);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("URL must be http(s)");
  return v.replace(/\/+$/, "");
}
