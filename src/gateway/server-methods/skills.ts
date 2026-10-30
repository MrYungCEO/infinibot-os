import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { installSkill } from "../../agents/skills-install.js";
import {
  importSkillUpload,
  SkillImportError,
  SKILL_UPLOAD_MAX_BYTES,
  type SkillImportConflictMode,
} from "../../agents/skills-import.js";
import { buildWorkspaceSkillStatus } from "../../agents/skills-status.js";
import { loadWorkspaceSkillEntries, type SkillEntry } from "../../agents/skills.js";
import type { InfinibotConfig } from "../../config/config.js";
import { loadConfig, writeConfigFile } from "../../config/config.js";
import { getRemoteSkillEligibility } from "../../infra/skills-remote.js";
import { CONFIG_DIR } from "../../utils.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateSkillsBinsParams,
  validateSkillsInstallParams,
  validateSkillsStatusParams,
  validateSkillsUpdateParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";
import {
  listDrafts,
  listHealingProposals,
  getDraftContent,
  getProposalContent,
  acceptDraft,
  rejectDraft,
  applyHealing,
  rejectHealing,
  getSkillStats,
  getRecentActivity,
  synthesizeActivityFromQueues,
  type DraftScope,
  type DraftStatus,
  type HealingStatus,
} from "../../agents/skills/queue-store.js";

function listWorkspaceDirs(cfg: InfinibotConfig): string[] {
  const dirs = new Set<string>();
  const list = cfg.agents?.list;
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (entry && typeof entry === "object" && typeof entry.id === "string") {
        dirs.add(resolveAgentWorkspaceDir(cfg, entry.id));
      }
    }
  }
  dirs.add(resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg)));
  return [...dirs];
}

function collectSkillBins(entries: SkillEntry[]): string[] {
  const bins = new Set<string>();
  for (const entry of entries) {
    const required = entry.metadata?.requires?.bins ?? [];
    const anyBins = entry.metadata?.requires?.anyBins ?? [];
    const install = entry.metadata?.install ?? [];
    for (const bin of required) {
      const trimmed = bin.trim();
      if (trimmed) bins.add(trimmed);
    }
    for (const bin of anyBins) {
      const trimmed = bin.trim();
      if (trimmed) bins.add(trimmed);
    }
    for (const spec of install) {
      const specBins = spec?.bins ?? [];
      for (const bin of specBins) {
        const trimmed = String(bin).trim();
        if (trimmed) bins.add(trimmed);
      }
    }
  }
  return [...bins].sort();
}

export const skillsHandlers: GatewayRequestHandlers = {
  "skills.status": ({ params, respond }) => {
    if (!validateSkillsStatusParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.status params: ${formatValidationErrors(validateSkillsStatusParams.errors)}`,
        ),
      );
      return;
    }
    const cfg = loadConfig();
    const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
    const report = buildWorkspaceSkillStatus(workspaceDir, {
      config: cfg,
      eligibility: { remote: getRemoteSkillEligibility() },
    });
    respond(true, report, undefined);
  },
  "skills.bins": ({ params, respond }) => {
    if (!validateSkillsBinsParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.bins params: ${formatValidationErrors(validateSkillsBinsParams.errors)}`,
        ),
      );
      return;
    }
    const cfg = loadConfig();
    const workspaceDirs = listWorkspaceDirs(cfg);
    const bins = new Set<string>();
    for (const workspaceDir of workspaceDirs) {
      const entries = loadWorkspaceSkillEntries(workspaceDir, { config: cfg });
      for (const bin of collectSkillBins(entries)) bins.add(bin);
    }
    respond(true, { bins: [...bins].sort() }, undefined);
  },
  "skills.install": async ({ params, respond }) => {
    if (!validateSkillsInstallParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.install params: ${formatValidationErrors(validateSkillsInstallParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      name: string;
      installId: string;
      timeoutMs?: number;
    };
    const cfg = loadConfig();
    const workspaceDirRaw = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
    const result = await installSkill({
      workspaceDir: workspaceDirRaw,
      skillName: p.name,
      installId: p.installId,
      timeoutMs: p.timeoutMs,
      config: cfg,
    });
    respond(
      result.ok,
      result,
      result.ok ? undefined : errorShape(ErrorCodes.UNAVAILABLE, result.message),
    );
  },
  "skills.update": async ({ params, respond }) => {
    if (!validateSkillsUpdateParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.update params: ${formatValidationErrors(validateSkillsUpdateParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      skillKey: string;
      enabled?: boolean;
      apiKey?: string;
      env?: Record<string, string>;
    };
    const cfg = loadConfig();
    const skills = cfg.skills ? { ...cfg.skills } : {};
    const entries = skills.entries ? { ...skills.entries } : {};
    const current = entries[p.skillKey] ? { ...entries[p.skillKey] } : {};
    if (typeof p.enabled === "boolean") {
      current.enabled = p.enabled;
    }
    if (typeof p.apiKey === "string") {
      const trimmed = p.apiKey.trim();
      if (trimmed) current.apiKey = trimmed;
      else delete current.apiKey;
    }
    if (p.env && typeof p.env === "object") {
      const nextEnv = current.env ? { ...current.env } : {};
      for (const [key, value] of Object.entries(p.env)) {
        const trimmedKey = key.trim();
        if (!trimmedKey) continue;
        const trimmedVal = value.trim();
        if (!trimmedVal) delete nextEnv[trimmedKey];
        else nextEnv[trimmedKey] = trimmedVal;
      }
      current.env = nextEnv;
    }
    entries[p.skillKey] = current;
    skills.entries = entries;
    const nextConfig: InfinibotConfig = {
      ...cfg,
      skills,
    };
    await writeConfigFile(nextConfig);
    respond(true, { ok: true, skillKey: p.skillKey, config: current }, undefined);
  },
  // ── Author / edit a user-authored skill via the guided form ───────────────────
  // Writes a SKILL.md (with YAML frontmatter) into the managed skills dir so it
  // shows up in `skills.status` on the next refresh. Intentionally scoped to the
  // managed dir (CONFIG_DIR/skills) so the UI never writes outside it.
  "skills.author": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as {
        slug?: string;
        name?: string;
        description?: string;
        whenToUse?: string;
        category?: string;
        emoji?: string;
        allowedTools?: string[];
        systemPrompt?: string;
        body?: string;
      };
      const name = (p.name ?? "").trim();
      const description = (p.description ?? "").trim();
      if (!name) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "name is required"));
        return;
      }
      if (!description) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "description is required"),
        );
        return;
      }
      const slug = slugifySkill(p.slug || name);
      if (!slug) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "could not derive a valid slug"),
        );
        return;
      }
      const path = await import("node:path");
      const fs = await import("node:fs");
      const managedDir = path.join(CONFIG_DIR, "skills");
      const skillDir = path.join(managedDir, slug);
      const target = path.join(skillDir, "SKILL.md");
      const content = buildSkillMarkdown({
        slug,
        name,
        description,
        whenToUse: (p.whenToUse ?? "").trim(),
        category: (p.category ?? "").trim(),
        emoji: (p.emoji ?? "").trim(),
        allowedTools: Array.isArray(p.allowedTools)
          ? p.allowedTools.map((tool) => String(tool).trim()).filter(Boolean)
          : [],
        systemPrompt: (p.systemPrompt ?? "").trim(),
        body: (p.body ?? "").trim(),
      });
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(target, content, "utf-8");
      respond(true, { ok: true, slug, skillKey: slug, filePath: target }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, (err as Error).message));
    }
  },
  // ── Import an uploaded SKILL.md / zip into the managed skills dir ─────────────
  // Plain-English failures come back as INVALID_REQUEST; name collisions come
  // back as ok:true { status: "conflict" } so the UI can offer replace / keep both.
  "skills.import": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as {
        fileName?: string;
        dataBase64?: string;
        onConflict?: SkillImportConflictMode;
      };
      if (typeof p.dataBase64 !== "string" || !p.dataBase64) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "No file was received."));
        return;
      }
      if (p.dataBase64.length > Math.ceil((SKILL_UPLOAD_MAX_BYTES * 4) / 3) + 8) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `That file is over the ${Math.round(SKILL_UPLOAD_MAX_BYTES / 1024 / 1024)} MB upload limit.`,
          ),
        );
        return;
      }
      const path = await import("node:path");
      const onConflict =
        p.onConflict === "replace" || p.onConflict === "keep-both" ? p.onConflict : "ask";
      const result = await importSkillUpload({
        fileName: String(p.fileName ?? "SKILL.md").slice(0, 200),
        data: Buffer.from(p.dataBase64, "base64"),
        onConflict,
        managedDir: path.join(CONFIG_DIR, "skills"),
      });
      respond(true, { ok: result.status === "imported", ...result }, undefined);
    } catch (err) {
      if (err instanceof SkillImportError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, err.message));
        return;
      }
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INTERNAL_ERROR,
          "Something went wrong saving that skill. Nothing was changed.",
        ),
      );
    }
  },
  // ── Delete a user-authored skill (managed dir only) ───────────────────────────
  "skills.delete": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as { skillKey?: string; filePath?: string };
      const path = await import("node:path");
      const fs = await import("node:fs");
      const managedDir = path.resolve(path.join(CONFIG_DIR, "skills"));
      let skillDir: string | null = null;
      if (p.filePath && p.filePath.trim()) {
        skillDir = path.resolve(path.dirname(p.filePath.trim()));
      } else if (p.skillKey && p.skillKey.trim()) {
        skillDir = path.resolve(path.join(managedDir, slugifySkill(p.skillKey.trim())));
      }
      if (!skillDir) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "skillKey or filePath is required"),
        );
        return;
      }
      // Safety: only ever remove a directory that lives under the managed dir.
      if (skillDir !== managedDir && !skillDir.startsWith(managedDir + path.sep)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "only managed skills can be deleted"),
        );
        return;
      }
      if (skillDir === managedDir || !fs.existsSync(skillDir)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.NOT_FOUND, "skill not found in managed dir"),
        );
        return;
      }
      fs.rmSync(skillDir, { recursive: true, force: true });
      respond(true, { ok: true }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, (err as Error).message));
    }
  },
  "skills.learned.list": async ({ respond }) => {
    try {
      const { listLearnedSkills, resolveCumulativeSkillsConfig } =
        await import("../../agents/skills/cumulative/index.js");
      const config = resolveCumulativeSkillsConfig();
      const skills = listLearnedSkills(config).map((s) => ({
        name: s.frontmatter.name,
        description: s.frontmatter.description,
        emoji: s.frontmatter.emoji,
        createdAt: s.frontmatter.createdAt,
        updatedAt: s.frontmatter.updatedAt,
        sourceTrajectoryId: s.frontmatter.sourceTrajectoryId,
        fingerprint: s.frontmatter.fingerprint,
        body: s.body,
        usage: s.usage,
      }));
      respond(
        true,
        {
          enabled: config.enabled,
          skillsDir: config.skillsLearnedDir,
          count: skills.length,
          skills,
        },
        undefined,
      );
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, (err as Error).message));
    }
  },
  "skills.learned.delete": async ({ params, respond }) => {
    const p = params as { skillKey?: string };
    const skillKey = (p.skillKey ?? "").trim();
    if (!skillKey) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "skillKey is required"));
      return;
    }
    try {
      const path = await import("node:path");
      const fs = await import("node:fs");
      const { resolveCumulativeSkillsConfig } =
        await import("../../agents/skills/cumulative/index.js");
      const config = resolveCumulativeSkillsConfig();
      const skillDir = path.join(config.skillsLearnedDir, skillKey);
      const usageFile = path.join(config.usageDir, `${skillKey}.json`);
      if (!fs.existsSync(skillDir)) {
        respond(false, undefined, errorShape(ErrorCodes.NOT_FOUND, `skill ${skillKey} not found`));
        return;
      }
      fs.rmSync(skillDir, { recursive: true, force: true });
      if (fs.existsSync(usageFile)) fs.rmSync(usageFile, { force: true });
      respond(true, { ok: true, skillKey }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, (err as Error).message));
    }
  },
  "skills.learned.selfImprove": async ({ respond }) => {
    try {
      const cfg = loadConfig();
      const defaultModel =
        (cfg as { agents?: { defaults?: { model?: { default?: string } } } }).agents?.defaults
          ?.model?.default ?? "anthropic:claude-sonnet-4-6";
      const { runSelfImprovePass, resolveCumulativeSkillsConfig } =
        await import("../../agents/skills/cumulative/index.js");
      const { generateDocument } = await import("../../discovery/ai.js");
      const config = resolveCumulativeSkillsConfig();
      if (!config.enabled) {
        respond(true, { enabled: false, results: [] }, undefined);
        return;
      }
      const complete = async (q: { system: string; user: string; maxOutputTokens?: number }) => {
        const res = await generateDocument({
          model: defaultModel,
          systemPrompt: q.system,
          userPrompt: q.user,
          temperature: 0.2,
          maxTokens: q.maxOutputTokens ?? 2000,
          timeoutMs: 60_000,
        });
        return res.text;
      };
      const agentIdForLookup = process.env.INFINIBOT_SELF_IMPROVE_AGENT_ID?.trim() || "default";
      const results = await runSelfImprovePass(config, { complete, agentIdForLookup });
      respond(true, { enabled: true, model: defaultModel, results }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, (err as Error).message));
    }
  },

  // ── Skill draft queue ────────────────────────────────────────────────────────

  "skills.drafts.list": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as { status?: string };
      const status = (p.status as DraftStatus | undefined) ?? undefined;

      // Auto-accept: when approval isn't required, drain every pending
      // draft into the active skill set right here. This is idempotent
      // (acceptDraft is a no-op for already-reviewed drafts) and runs on
      // every list call so the queue can never accumulate stuck items —
      // the UI is the user's primary list surface, so by the time they
      // see "drafts" it's already been resolved.
      const cfg = loadConfig();
      const ss = (
        (cfg as Record<string, unknown>).claudeCoder as Record<string, unknown> | undefined
      )?.skillSystem as Record<string, unknown> | undefined;
      const requireApproval = ss?.requireApproval === true; // default: false
      if (!requireApproval) {
        const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
        const { existsSync } = await import("node:fs");
        for (const draft of listDrafts({ status: "pending" })) {
          // Cascade: if the draft file is missing (deleted by the user
          // or wiped during a workspace reset), accepting it will throw
          // and the draft will stay stuck pending forever. Auto-reject
          // those so the queue drains cleanly — the user can always
          // re-trigger reflection on a new run.
          if (!draft.draftPath || !existsSync(draft.draftPath)) {
            try {
              rejectDraft(draft.id, "draft file missing");
            } catch {
              /* nothing else we can do */
            }
            continue;
          }
          try {
            acceptDraft(draft.id, { targetScope: "infinibot", workspaceDir });
          } catch {
            // One bad draft can't block the rest. Stays pending; the
            // user can Reject manually from the Drafts tab.
          }
        }
      }

      respond(true, { drafts: listDrafts({ status }) }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, (err as Error).message));
    }
  },

  "skills.drafts.get": ({ params, respond }) => {
    try {
      const p = params as { id: string };
      if (!p?.id) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "id is required"));
        return;
      }
      const draft = listDrafts().find((d) => d.id === p.id);
      if (!draft) {
        respond(false, undefined, errorShape(ErrorCodes.NOT_FOUND, `Draft ${p.id} not found`));
        return;
      }
      const content = getDraftContent(p.id);
      respond(true, { draft, content }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, (err as Error).message));
    }
  },

  "skills.drafts.accept": ({ params, respond }) => {
    try {
      const p = params as {
        id: string;
        editedMd?: string;
        targetScope?: string;
      };
      if (!p?.id) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "id is required"));
        return;
      }
      const cfg = loadConfig();
      const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
      acceptDraft(p.id, {
        editedSkillMd: p.editedMd,
        targetScope: (p.targetScope as DraftScope) ?? "infinibot",
        workspaceDir,
      });
      respond(true, { ok: true, id: p.id }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, (err as Error).message));
    }
  },

  "skills.drafts.reject": ({ params, respond }) => {
    try {
      const p = params as { id: string; reason?: string };
      if (!p?.id) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "id is required"));
        return;
      }
      rejectDraft(p.id, p.reason);
      respond(true, { ok: true, id: p.id }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, (err as Error).message));
    }
  },

  // ── Healing proposal queue ───────────────────────────────────────────────────

  "skills.healing.list": ({ params, respond }) => {
    try {
      const p = (params ?? {}) as { status?: string };
      const status = (p.status as HealingStatus | undefined) ?? undefined;
      respond(true, { proposals: listHealingProposals({ status }) }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, (err as Error).message));
    }
  },

  "skills.healing.get": ({ params, respond }) => {
    try {
      const p = params as { id: string };
      if (!p?.id) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "id is required"));
        return;
      }
      const proposal = listHealingProposals().find((h) => h.id === p.id);
      if (!proposal) {
        respond(false, undefined, errorShape(ErrorCodes.NOT_FOUND, `Healing ${p.id} not found`));
        return;
      }
      const cfg = loadConfig();
      const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
      const content = getProposalContent(p.id, workspaceDir);
      respond(
        true,
        {
          proposal,
          currentMd: content?.currentMd ?? "",
          proposedMd: content?.proposedMd ?? "",
          diff: content?.diff ?? "",
        },
        undefined,
      );
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, (err as Error).message));
    }
  },

  "skills.healing.apply": ({ params, respond }) => {
    try {
      const p = params as { id: string; editedMd?: string };
      if (!p?.id) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "id is required"));
        return;
      }
      const cfg = loadConfig();
      const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
      applyHealing(p.id, { editedSkillMd: p.editedMd, workspaceDir });
      respond(true, { ok: true, id: p.id }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, (err as Error).message));
    }
  },

  "skills.healing.reject": ({ params, respond }) => {
    try {
      const p = params as { id: string; reason?: string };
      if (!p?.id) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "id is required"));
        return;
      }
      rejectHealing(p.id, p.reason);
      respond(true, { ok: true, id: p.id }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, (err as Error).message));
    }
  },

  // ── Skill system config ──────────────────────────────────────────────────────

  "skills.config.get": ({ respond }) => {
    try {
      const cfg = loadConfig();
      const cc = (cfg as Record<string, unknown>).claudeCoder as
        | Record<string, unknown>
        | undefined;
      const ss = cc?.skillSystem as Record<string, unknown> | undefined;
      const result = {
        enabled: ss?.enabled !== false,
        autoGenerate: ss?.autoGenerate !== false,
        autoHealing: ss?.autoHealing !== false,
        minDurationMs: typeof ss?.minDurationMs === "number" ? ss.minDurationMs : 5 * 60 * 1000,
        // Default OFF so self-generated drafts auto-install. Users who
        // want a manual review step opt in via the Settings toggle.
        requireApproval: ss?.requireApproval === true,
      };
      respond(true, result, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, (err as Error).message));
    }
  },

  "skills.config.set": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const cfg = loadConfig();
      const cc = ((cfg as Record<string, unknown>).claudeCoder ?? {}) as Record<string, unknown>;
      const ss = (cc.skillSystem ?? {}) as Record<string, unknown>;
      const next = { ...ss };
      if (typeof p.enabled === "boolean") next.enabled = p.enabled;
      if (typeof p.autoGenerate === "boolean") next.autoGenerate = p.autoGenerate;
      if (typeof p.autoHealing === "boolean") next.autoHealing = p.autoHealing;
      if (typeof p.minDurationMs === "number") next.minDurationMs = p.minDurationMs;
      if (typeof p.requireApproval === "boolean") next.requireApproval = p.requireApproval;
      const nextConfig = {
        ...cfg,
        claudeCoder: { ...cc, skillSystem: next },
      };
      await writeConfigFile(nextConfig as Parameters<typeof writeConfigFile>[0]);
      respond(true, { ok: true, config: next }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, (err as Error).message));
    }
  },

  // ── Stats + activity ─────────────────────────────────────────────────────────

  "skills.stats": ({ respond }) => {
    try {
      respond(true, getSkillStats(), undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, (err as Error).message));
    }
  },

  "skills.recent_activity": ({ params, respond }) => {
    try {
      const p = (params ?? {}) as { limit?: number };
      const limit = typeof p.limit === "number" ? Math.min(p.limit, 200) : 50;
      const ringBuffer = getRecentActivity(limit);
      const fromQueues = synthesizeActivityFromQueues(limit);
      // Merge ring buffer (in-memory, current session) with queue-derived events,
      // deduplicate by id, sort newest-first.
      const seen = new Set<string>();
      const merged = [...ringBuffer, ...fromQueues]
        .filter((e) => {
          if (seen.has(e.id)) return false;
          seen.add(e.id);
          return true;
        })
        .sort((a, b) => b.ts - a.ts)
        .slice(0, limit);
      respond(true, { activity: merged }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, (err as Error).message));
    }
  },
};

function slugifySkill(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function yamlEscape(value: string): string {
  // Quote when the value contains characters that would confuse a YAML scalar.
  if (value === "" || /[:#\-?[\]{}&*!|>'"%@`,\n]/.test(value) || /^\s|\s$/.test(value)) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}

function buildSkillMarkdown(input: {
  slug: string;
  name: string;
  description: string;
  whenToUse: string;
  category: string;
  emoji: string;
  allowedTools: string[];
  systemPrompt: string;
  body: string;
}): string {
  const fm: string[] = [
    "---",
    `name: ${yamlEscape(input.slug)}`,
    `description: ${yamlEscape(input.description)}`,
  ];
  if (input.emoji) fm.push(`emoji: ${yamlEscape(input.emoji)}`);
  if (input.allowedTools.length > 0) {
    fm.push(`allowed-tools: [${input.allowedTools.map((tool) => yamlEscape(tool)).join(", ")}]`);
  }
  if (input.category || input.whenToUse) {
    fm.push("metadata:");
    if (input.category) fm.push(`  category: ${yamlEscape(input.category)}`);
    if (input.whenToUse) fm.push(`  whenToUse: ${yamlEscape(input.whenToUse)}`);
  }
  fm.push("---", "");

  const sections: string[] = [`# ${input.name}`, "", input.description, ""];
  if (input.whenToUse) {
    sections.push("## When to use", "", input.whenToUse, "");
  }
  const bodyText = input.body || input.systemPrompt;
  if (bodyText) {
    sections.push("## Instructions", "", bodyText, "");
  }
  if (input.allowedTools.length > 0) {
    sections.push(
      "## Allowed tools",
      "",
      input.allowedTools.map((tool) => `- ${tool}`).join("\n"),
      "",
    );
  }
  return `${fm.join("\n")}${sections.join("\n")}`.trimEnd() + "\n";
}
