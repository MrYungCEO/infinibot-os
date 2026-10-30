import type { GatewayBrowserClient } from "../gateway";
import type {
  SkillStatusReport,
  SkillDraftUi,
  HealingProposalUi,
  SkillActivityEntry,
  SkillSystemConfig,
  SkillQueueStats,
  DraftScope,
} from "../types";

export type SkillsState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  skillsLoading: boolean;
  skillsReport: SkillStatusReport | null;
  skillsError: string | null;
  skillsBusyKey: string | null;
  skillEdits: Record<string, string>;
  skillMessages: SkillMessageMap;
  learnedSkills: LearnedSkill[];
  learnedLoading: boolean;
  learnedError: string | null;
  learnedSelfImproveRunning: boolean;
  learnedSelfImproveSummary: string | null;
  learnedSkillsEnabled: boolean;
  // Queue management
  skillDrafts: SkillDraftUi[];
  skillDraftsLoading: boolean;
  skillDraftsError: string | null;
  skillHealingProposals: HealingProposalUi[];
  skillHealingLoading: boolean;
  skillHealingError: string | null;
  skillActivity: SkillActivityEntry[];
  skillActivityLoading: boolean;
  skillSystemConfig: SkillSystemConfig | null;
  skillConfigLoading: boolean;
  skillConfigSaving: boolean;
  skillQueueStats: SkillQueueStats | null;
  skillQueueStatsLoading: boolean;
};

export type LearnedSkillUsage = {
  skillKey: string;
  invocations: number;
  successes: number;
  failures: number;
  lastInvokedAt?: string;
  lastRefinedAt?: string;
  recentTrajectoryIds: string[];
};

export type LearnedSkill = {
  name: string;
  description: string;
  emoji?: string;
  createdAt: string;
  updatedAt: string;
  sourceTrajectoryId: string;
  fingerprint: string;
  body: string;
  usage: LearnedSkillUsage;
};

export type SelfImproveResult = {
  skillKey: string;
  outcome:
    | "rewrote"
    | "skipped-cooldown"
    | "skipped-min-uses"
    | "skipped-low-confidence"
    | "skipped-no-trajectories"
    | "errored";
  reason: string;
};

export type SkillMessage = {
  kind: "success" | "error";
  message: string;
};

export type SkillMessageMap = Record<string, SkillMessage>;

type LoadSkillsOptions = {
  clearMessages?: boolean;
};

function setSkillMessage(state: SkillsState, key: string, message?: SkillMessage) {
  if (!key.trim()) return;
  const next = { ...state.skillMessages };
  if (message) next[key] = message;
  else delete next[key];
  state.skillMessages = next;
}

function getErrorMessage(err: unknown) {
  if (err instanceof Error) return err.message;
  return String(err);
}

export async function loadSkills(state: SkillsState, options?: LoadSkillsOptions) {
  if (options?.clearMessages && Object.keys(state.skillMessages).length > 0) {
    state.skillMessages = {};
  }
  if (!state.client || !state.connected) return;
  if (state.skillsLoading) return;
  state.skillsLoading = true;
  state.skillsError = null;
  try {
    const res = (await state.client.request("skills.status", {})) as
      | SkillStatusReport
      | undefined;
    if (res) state.skillsReport = res;
  } catch (err) {
    state.skillsError = getErrorMessage(err);
  } finally {
    state.skillsLoading = false;
  }
}

export function updateSkillEdit(
  state: SkillsState,
  skillKey: string,
  value: string,
) {
  state.skillEdits = { ...state.skillEdits, [skillKey]: value };
}

export async function updateSkillEnabled(
  state: SkillsState,
  skillKey: string,
  enabled: boolean,
) {
  if (!state.client || !state.connected) return;
  state.skillsBusyKey = skillKey;
  state.skillsError = null;
  try {
    await state.client.request("skills.update", { skillKey, enabled });
    await loadSkills(state);
    setSkillMessage(state, skillKey, {
      kind: "success",
      message: enabled ? "Skill enabled" : "Skill disabled",
    });
  } catch (err) {
    const message = getErrorMessage(err);
    state.skillsError = message;
    setSkillMessage(state, skillKey, {
      kind: "error",
      message,
    });
  } finally {
    state.skillsBusyKey = null;
  }
}

export async function saveSkillApiKey(state: SkillsState, skillKey: string) {
  if (!state.client || !state.connected) return;
  state.skillsBusyKey = skillKey;
  state.skillsError = null;
  try {
    const apiKey = state.skillEdits[skillKey] ?? "";
    await state.client.request("skills.update", { skillKey, apiKey });
    await loadSkills(state);
    setSkillMessage(state, skillKey, {
      kind: "success",
      message: "API key saved",
    });
  } catch (err) {
    const message = getErrorMessage(err);
    state.skillsError = message;
    setSkillMessage(state, skillKey, {
      kind: "error",
      message,
    });
  } finally {
    state.skillsBusyKey = null;
  }
}

export async function loadLearnedSkills(state: SkillsState) {
  if (!state.client || !state.connected) return;
  if (state.learnedLoading) return;
  state.learnedLoading = true;
  state.learnedError = null;
  try {
    const res = (await state.client.request("skills.learned.list", {})) as
      | { enabled: boolean; count: number; skills: LearnedSkill[] }
      | undefined;
    if (res) {
      state.learnedSkills = res.skills ?? [];
      state.learnedSkillsEnabled = Boolean(res.enabled);
    }
  } catch (err) {
    state.learnedError = getErrorMessage(err);
  } finally {
    state.learnedLoading = false;
  }
}

export async function deleteLearnedSkill(state: SkillsState, skillKey: string) {
  if (!state.client || !state.connected) return;
  state.skillsBusyKey = `learned:${skillKey}`;
  try {
    await state.client.request("skills.learned.delete", { skillKey });
    state.learnedSkills = state.learnedSkills.filter((s) => s.name !== skillKey);
    setSkillMessage(state, `learned:${skillKey}`, {
      kind: "success",
      message: "Learned skill deleted",
    });
  } catch (err) {
    const message = getErrorMessage(err);
    setSkillMessage(state, `learned:${skillKey}`, { kind: "error", message });
  } finally {
    state.skillsBusyKey = null;
  }
}

export async function runLearnedSelfImprove(state: SkillsState) {
  if (!state.client || !state.connected) return;
  if (state.learnedSelfImproveRunning) return;
  state.learnedSelfImproveRunning = true;
  state.learnedSelfImproveSummary = null;
  state.learnedError = null;
  try {
    const res = (await state.client.request("skills.learned.selfImprove", {})) as
      | { enabled: boolean; model?: string; results: SelfImproveResult[] }
      | undefined;
    if (res) {
      const rewrote = res.results.filter((r) => r.outcome === "rewrote").length;
      const total = res.results.length;
      state.learnedSelfImproveSummary = res.enabled
        ? `Refined ${rewrote}/${total} via ${res.model ?? "default"}`
        : "Cumulative skills disabled (INFINIBOT_CUMULATIVE_SKILLS=0)";
      await loadLearnedSkills(state);
    }
  } catch (err) {
    state.learnedError = getErrorMessage(err);
  } finally {
    state.learnedSelfImproveRunning = false;
  }
}

export async function installSkill(
  state: SkillsState,
  skillKey: string,
  name: string,
  installId: string,
) {
  if (!state.client || !state.connected) return;
  state.skillsBusyKey = skillKey;
  state.skillsError = null;
  try {
    const result = (await state.client.request("skills.install", {
      name,
      installId,
      timeoutMs: 120000,
    })) as { ok?: boolean; message?: string };
    await loadSkills(state);
    setSkillMessage(state, skillKey, {
      kind: "success",
      message: result?.message ?? "Installed",
    });
  } catch (err) {
    const message = getErrorMessage(err);
    state.skillsError = message;
    setSkillMessage(state, skillKey, {
      kind: "error",
      message,
    });
  } finally {
    state.skillsBusyKey = null;
  }
}

export type SkillAuthorInput = {
  slug?: string;
  name: string;
  description: string;
  whenToUse?: string;
  category?: string;
  emoji?: string;
  allowedTools?: string[];
  systemPrompt?: string;
  body?: string;
};

/**
 * Create or overwrite a user-authored skill from the guided author form.
 * Writes a SKILL.md into the managed skills dir server-side, then reloads
 * the status report so the new skill appears in the discovery surface.
 */
export async function authorSkill(state: SkillsState, input: SkillAuthorInput) {
  if (!state.client || !state.connected) return;
  const busyKey = `author:${input.slug ?? input.name}`;
  state.skillsBusyKey = busyKey;
  state.skillsError = null;
  try {
    const res = (await state.client.request("skills.author", input)) as
      | { ok?: boolean; slug?: string }
      | undefined;
    await loadSkills(state);
    setSkillMessage(state, "author", {
      kind: "success",
      message: res?.slug ? `Saved skill "${res.slug}"` : "Skill saved",
    });
  } catch (err) {
    const message = getErrorMessage(err);
    state.skillsError = message;
    setSkillMessage(state, "author", { kind: "error", message });
  } finally {
    state.skillsBusyKey = null;
  }
}

/**
 * Delete a user-authored (managed) skill. The gateway refuses to remove
 * anything outside the managed skills dir, so bundled skills are safe.
 */
export async function deleteSkill(
  state: SkillsState,
  skillKey: string,
  filePath?: string,
) {
  if (!state.client || !state.connected) return;
  state.skillsBusyKey = skillKey;
  state.skillsError = null;
  try {
    await state.client.request("skills.delete", { skillKey, filePath });
    await loadSkills(state);
    setSkillMessage(state, skillKey, { kind: "success", message: "Skill deleted" });
  } catch (err) {
    const message = getErrorMessage(err);
    state.skillsError = message;
    setSkillMessage(state, skillKey, { kind: "error", message });
  } finally {
    state.skillsBusyKey = null;
  }
}

// ── Queue management controllers ─────────────────────────────────────────────

export async function loadSkillDrafts(state: SkillsState) {
  if (!state.client || !state.connected) return;
  if (state.skillDraftsLoading) return;
  state.skillDraftsLoading = true;
  state.skillDraftsError = null;
  try {
    const res = (await state.client.request("skills.drafts.list", {})) as
      | { drafts: SkillDraftUi[] }
      | undefined;
    state.skillDrafts = res?.drafts ?? [];
  } catch (err) {
    state.skillDraftsError = getErrorMessage(err);
  } finally {
    state.skillDraftsLoading = false;
  }
}

export async function getDraftFullContent(
  state: SkillsState,
  id: string,
): Promise<{ skillMd: string; metadata: Record<string, unknown> } | null> {
  if (!state.client || !state.connected) return null;
  try {
    const res = (await state.client.request("skills.drafts.get", { id })) as
      | { draft: SkillDraftUi; content: { skillMd: string; metadata: Record<string, unknown> } | null }
      | undefined;
    return res?.content ?? null;
  } catch {
    return null;
  }
}

export async function acceptSkillDraft(
  state: SkillsState,
  id: string,
  opts: { editedMd?: string; targetScope?: DraftScope } = {},
) {
  if (!state.client || !state.connected) return;
  state.skillsBusyKey = `draft:${id}`;
  try {
    await state.client.request("skills.drafts.accept", {
      id,
      editedMd: opts.editedMd,
      targetScope: opts.targetScope ?? "infinibot",
    });
    await loadSkillDrafts(state);
    await loadSkillQueueStats(state);
    setSkillMessage(state, `draft:${id}`, { kind: "success", message: "Draft accepted and installed" });
  } catch (err) {
    setSkillMessage(state, `draft:${id}`, { kind: "error", message: getErrorMessage(err) });
  } finally {
    state.skillsBusyKey = null;
  }
}

export async function rejectSkillDraft(
  state: SkillsState,
  id: string,
  reason?: string,
) {
  if (!state.client || !state.connected) return;
  state.skillsBusyKey = `draft:${id}`;
  try {
    await state.client.request("skills.drafts.reject", { id, reason });
    await loadSkillDrafts(state);
    await loadSkillQueueStats(state);
    setSkillMessage(state, `draft:${id}`, { kind: "success", message: "Draft rejected" });
  } catch (err) {
    setSkillMessage(state, `draft:${id}`, { kind: "error", message: getErrorMessage(err) });
  } finally {
    state.skillsBusyKey = null;
  }
}

export async function loadSkillHealingProposals(state: SkillsState) {
  if (!state.client || !state.connected) return;
  if (state.skillHealingLoading) return;
  state.skillHealingLoading = true;
  state.skillHealingError = null;
  try {
    const res = (await state.client.request("skills.healing.list", {})) as
      | { proposals: HealingProposalUi[] }
      | undefined;
    state.skillHealingProposals = res?.proposals ?? [];
  } catch (err) {
    state.skillHealingError = getErrorMessage(err);
  } finally {
    state.skillHealingLoading = false;
  }
}

export async function getHealingProposalContent(
  state: SkillsState,
  id: string,
): Promise<{ proposedMd: string; currentMd: string; diff: string } | null> {
  if (!state.client || !state.connected) return null;
  try {
    const res = (await state.client.request("skills.healing.get", { id })) as
      | { proposedMd: string; currentMd: string; diff: string }
      | undefined;
    return res ?? null;
  } catch {
    return null;
  }
}

export async function applySkillHealing(
  state: SkillsState,
  id: string,
  editedMd?: string,
) {
  if (!state.client || !state.connected) return;
  state.skillsBusyKey = `healing:${id}`;
  try {
    await state.client.request("skills.healing.apply", { id, editedMd });
    await loadSkillHealingProposals(state);
    await loadSkillQueueStats(state);
    setSkillMessage(state, `healing:${id}`, { kind: "success", message: "Healing applied" });
  } catch (err) {
    setSkillMessage(state, `healing:${id}`, { kind: "error", message: getErrorMessage(err) });
  } finally {
    state.skillsBusyKey = null;
  }
}

export async function rejectSkillHealing(
  state: SkillsState,
  id: string,
  reason?: string,
) {
  if (!state.client || !state.connected) return;
  state.skillsBusyKey = `healing:${id}`;
  try {
    await state.client.request("skills.healing.reject", { id, reason });
    await loadSkillHealingProposals(state);
    await loadSkillQueueStats(state);
    setSkillMessage(state, `healing:${id}`, { kind: "success", message: "Healing rejected" });
  } catch (err) {
    setSkillMessage(state, `healing:${id}`, { kind: "error", message: getErrorMessage(err) });
  } finally {
    state.skillsBusyKey = null;
  }
}

export async function loadSkillActivity(state: SkillsState) {
  if (!state.client || !state.connected) return;
  state.skillActivityLoading = true;
  try {
    const res = (await state.client.request("skills.recent_activity", { limit: 100 })) as
      | { activity: SkillActivityEntry[] }
      | undefined;
    state.skillActivity = res?.activity ?? [];
  } catch {
    state.skillActivity = [];
  } finally {
    state.skillActivityLoading = false;
  }
}

export async function loadSkillSystemConfig(state: SkillsState) {
  if (!state.client || !state.connected) return;
  state.skillConfigLoading = true;
  try {
    const res = (await state.client.request("skills.config.get", {})) as
      | SkillSystemConfig
      | undefined;
    if (res) state.skillSystemConfig = res;
  } catch {
    // leave null
  } finally {
    state.skillConfigLoading = false;
  }
}

export async function saveSkillSystemConfig(
  state: SkillsState,
  patch: Partial<SkillSystemConfig>,
) {
  if (!state.client || !state.connected) return;
  state.skillConfigSaving = true;
  try {
    const res = (await state.client.request("skills.config.set", patch)) as
      | { ok: boolean; config: SkillSystemConfig }
      | undefined;
    if (res?.config) state.skillSystemConfig = { ...(state.skillSystemConfig ?? {} as SkillSystemConfig), ...res.config };
    setSkillMessage(state, "config", { kind: "success", message: "Settings saved" });
  } catch (err) {
    setSkillMessage(state, "config", { kind: "error", message: getErrorMessage(err) });
  } finally {
    state.skillConfigSaving = false;
  }
}

export async function loadSkillQueueStats(state: SkillsState) {
  if (!state.client || !state.connected) return;
  state.skillQueueStatsLoading = true;
  try {
    const res = (await state.client.request("skills.stats", {})) as
      | SkillQueueStats
      | undefined;
    if (res) state.skillQueueStats = res;
  } catch {
    // non-fatal
  } finally {
    state.skillQueueStatsLoading = false;
  }
}
