/**
 * Skill queue-store — read/write the auto-generation queues.
 *
 * Drafts queue:  CREATE_QUEUE_PATH   (skill-create-queue.jsonl)
 * Healing queue: HEALING_QUEUE_PATH  (skill-healing-queue.jsonl)
 *
 * Status updates are appended as _event:"reviewed" entries (reversible).
 * Accept  → moves draft SKILL.md to target scope directory (atomic rename).
 * Apply   → replaces existing skill file atomically.
 * Reject  → appends review event only; files untouched.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  appendFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

import { CONFIG_DIR } from "../../utils.js";
import { HEALING_QUEUE_PATH, CREATE_QUEUE_PATH } from "../claude-code/skill-system.js";

// ─── Public types ─────────────────────────────────────────────────────────────

export type DraftStatus = "pending" | "accepted" | "rejected";
export type HealingStatus = "pending" | "applied" | "rejected";
export type DraftScope = "user" | "workspace" | "infinibot";

export interface SkillDraft {
  id: string;
  slug: string;
  proposedAt: number;
  source: "reflection" | "healing";
  triggerOp?: string;
  draftPath: string;
  status: DraftStatus;
  reviewedAt?: number;
  rejectReason?: string;
}

export interface HealingProposal {
  id: string;
  skillName: string;
  reason: string;
  proposedAt: number;
  proposalPath: string;
  status: HealingStatus;
  reviewedAt?: number;
  rejectReason?: string;
}

export interface SkillActivity {
  id: string;
  ts: number;
  type:
    | "draft_created"
    | "draft_accepted"
    | "draft_rejected"
    | "healing_queued"
    | "healing_applied"
    | "healing_rejected";
  message: string;
  relatedId?: string;
  relatedSlug?: string;
}

export interface SkillStats {
  pendingDrafts: number;
  pendingHealing: number;
  acceptedLastWeek: number;
  rejectedLastWeek: number;
}

export interface SkillSystemConfig {
  enabled: boolean;
  autoGenerate: boolean;
  autoHealing: boolean;
  minDurationMs: number;
  requireApproval: boolean;
}

// ─── Activity ring buffer ─────────────────────────────────────────────────────

const MAX_ACTIVITY = 200;
const activityBuffer: SkillActivity[] = [];

export function addSkillActivity(event: Omit<SkillActivity, "id">): void {
  activityBuffer.push({ id: randomUUID(), ...event });
  if (activityBuffer.length > MAX_ACTIVITY) activityBuffer.shift();
}

export function getRecentActivity(limit = 50): SkillActivity[] {
  return [...activityBuffer].reverse().slice(0, limit);
}

// ─── JSONL helpers ─────────────────────────────────────────────────────────────

function readJsonlLines(filePath: string): Record<string, unknown>[] {
  if (!existsSync(filePath)) return [];
  try {
    const raw = readFileSync(filePath, "utf-8").trim();
    if (!raw) return [];
    return raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function appendJsonl(filePath: string, entry: object): void {
  try {
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
    appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf-8");
  } catch {
    // non-fatal
  }
}

function atomicWrite(filePath: string, content: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp.${randomUUID().slice(0, 8)}`;
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, filePath);
}

// ─── Status map builder ───────────────────────────────────────────────────────

function buildStatusMap(
  lines: Record<string, unknown>[],
): Map<string, { status: string; reviewedAt: number; rejectReason?: string }> {
  const map = new Map<string, { status: string; reviewedAt: number; rejectReason?: string }>();
  for (const line of lines) {
    if (
      line._event === "reviewed" &&
      typeof line.targetId === "string" &&
      typeof line.status === "string"
    ) {
      map.set(line.targetId, {
        status: line.status,
        reviewedAt: typeof line.reviewedAt === "number" ? line.reviewedAt : Date.now(),
        rejectReason: typeof line.reason === "string" ? line.reason : undefined,
      });
    }
  }
  return map;
}

// ─── Drafts ───────────────────────────────────────────────────────────────────

export function listDrafts(opts: { status?: DraftStatus } = {}): SkillDraft[] {
  const lines = readJsonlLines(CREATE_QUEUE_PATH);
  const statusMap = buildStatusMap(lines);

  return lines
    .filter((l) => !l._event && typeof l.id === "string" && typeof l.slug === "string")
    .map((l): SkillDraft => {
      const review = statusMap.get(l.id as string);
      const status = (review?.status ?? "pending") as DraftStatus;
      return {
        id: l.id as string,
        slug: l.slug as string,
        proposedAt: typeof l.at === "string" ? Date.parse(l.at) : 0,
        source: "reflection",
        triggerOp: typeof l.task === "string" ? l.task : undefined,
        draftPath: typeof l.draftPath === "string" ? l.draftPath : "",
        status,
        reviewedAt: review?.reviewedAt,
        rejectReason: review?.rejectReason,
      };
    })
    .filter((d) => !opts.status || d.status === opts.status)
    .sort((a, b) => b.proposedAt - a.proposedAt);
}

export function getDraftContent(
  id: string,
): { skillMd: string; metadata: Record<string, unknown> } | null {
  const draft = listDrafts().find((d) => d.id === id);
  if (!draft?.draftPath || !existsSync(draft.draftPath)) return null;
  return {
    skillMd: readFileSync(draft.draftPath, "utf-8"),
    metadata: {
      id: draft.id,
      slug: draft.slug,
      status: draft.status,
      proposedAt: draft.proposedAt,
      triggerOp: draft.triggerOp,
    },
  };
}

export function acceptDraft(
  id: string,
  opts: {
    editedSkillMd?: string;
    targetScope?: DraftScope;
    workspaceDir?: string;
  } = {},
): void {
  const draft = listDrafts().find((d) => d.id === id);
  if (!draft) throw new Error(`Draft ${id} not found`);
  if (draft.status !== "pending") throw new Error(`Draft ${id} is already ${draft.status}`);

  const scope = opts.targetScope ?? "infinibot";
  const targetDir = resolveSkillTargetDir(draft.slug, scope, opts.workspaceDir);
  mkdirSync(targetDir, { recursive: true });

  let content = opts.editedSkillMd;
  if (!content && draft.draftPath && existsSync(draft.draftPath)) {
    content = readFileSync(draft.draftPath, "utf-8");
  }
  if (!content) throw new Error(`No content available for draft ${id}`);

  const targetPath = join(targetDir, "SKILL.md");
  atomicWrite(targetPath, content);

  appendJsonl(CREATE_QUEUE_PATH, {
    _event: "reviewed",
    targetId: id,
    status: "accepted",
    reviewedAt: Date.now(),
    targetScope: scope,
    targetPath,
  });

  addSkillActivity({
    ts: Date.now(),
    type: "draft_accepted",
    message: `Draft "${draft.slug}" accepted → ${scope} (${targetPath})`,
    relatedId: id,
    relatedSlug: draft.slug,
  });
}

export function rejectDraft(id: string, reason?: string): void {
  const draft = listDrafts().find((d) => d.id === id);
  if (!draft) throw new Error(`Draft ${id} not found`);

  appendJsonl(CREATE_QUEUE_PATH, {
    _event: "reviewed",
    targetId: id,
    status: "rejected",
    reviewedAt: Date.now(),
    reason,
  });

  addSkillActivity({
    ts: Date.now(),
    type: "draft_rejected",
    message: `Draft "${draft.slug}" rejected${reason ? `: ${reason}` : ""}`,
    relatedId: id,
    relatedSlug: draft.slug,
  });
}

// ─── Healing proposals ────────────────────────────────────────────────────────

export function listHealingProposals(opts: { status?: HealingStatus } = {}): HealingProposal[] {
  const lines = readJsonlLines(HEALING_QUEUE_PATH);
  const statusMap = buildStatusMap(lines);

  return lines
    .filter((l) => !l._event && typeof l.id === "string" && typeof l.skillName === "string")
    .map((l): HealingProposal => {
      const review = statusMap.get(l.id as string);
      const status = (review?.status ?? "pending") as HealingStatus;
      return {
        id: l.id as string,
        skillName: l.skillName as string,
        reason: typeof l.task === "string" ? l.task : "skill failure (no task recorded)",
        proposedAt: typeof l.at === "string" ? Date.parse(l.at) : 0,
        proposalPath: typeof l.draftPath === "string" ? l.draftPath : "",
        status,
        reviewedAt: review?.reviewedAt,
        rejectReason: review?.rejectReason,
      };
    })
    .filter((h) => !opts.status || h.status === opts.status)
    .sort((a, b) => b.proposedAt - a.proposedAt);
}

export function getProposalContent(
  id: string,
  workspaceDir?: string,
): { proposedMd: string; currentMd: string; diff: string } | null {
  const healing = listHealingProposals().find((h) => h.id === id);
  if (!healing) return null;

  let proposedMd = "";
  if (healing.proposalPath && existsSync(healing.proposalPath)) {
    try {
      proposedMd = readFileSync(healing.proposalPath, "utf-8");
    } catch {
      // fall through to queue entry
    }
  }

  if (!proposedMd) {
    const lines = readJsonlLines(HEALING_QUEUE_PATH);
    const entry = lines.find((l) => l.id === id);
    if (entry?.proposedPatch) proposedMd = String(entry.proposedPatch);
  }

  const currentMd = findSkillContent(healing.skillName, workspaceDir);
  const diff = computeSimpleDiff(currentMd, proposedMd);
  return { proposedMd, currentMd, diff };
}

export function applyHealing(
  id: string,
  opts: { editedSkillMd?: string; workspaceDir?: string } = {},
): void {
  const healing = listHealingProposals().find((h) => h.id === id);
  if (!healing) throw new Error(`Healing ${id} not found`);
  if (healing.status !== "pending") throw new Error(`Healing ${id} is already ${healing.status}`);

  const content = opts.editedSkillMd ?? getProposalContent(id, opts.workspaceDir)?.proposedMd ?? "";
  if (!content) throw new Error(`No proposed content for healing ${id}`);

  const targetPath = findSkillPath(healing.skillName, opts.workspaceDir);
  if (!targetPath) throw new Error(`Cannot find existing SKILL.md for "${healing.skillName}"`);

  atomicWrite(targetPath, content);

  appendJsonl(HEALING_QUEUE_PATH, {
    _event: "reviewed",
    targetId: id,
    status: "applied",
    reviewedAt: Date.now(),
    targetPath,
  });

  addSkillActivity({
    ts: Date.now(),
    type: "healing_applied",
    message: `Healing applied to skill "${healing.skillName}" (${targetPath})`,
    relatedId: id,
    relatedSlug: healing.skillName,
  });
}

export function rejectHealing(id: string, reason?: string): void {
  const healing = listHealingProposals().find((h) => h.id === id);
  if (!healing) throw new Error(`Healing ${id} not found`);

  appendJsonl(HEALING_QUEUE_PATH, {
    _event: "reviewed",
    targetId: id,
    status: "rejected",
    reviewedAt: Date.now(),
    reason,
  });

  addSkillActivity({
    ts: Date.now(),
    type: "healing_rejected",
    message: `Healing rejected for skill "${healing.skillName}"${reason ? `: ${reason}` : ""}`,
    relatedId: id,
    relatedSlug: healing.skillName,
  });
}

// ─── Stats ────────────────────────────────────────────────────────────────────

export function getSkillStats(): SkillStats {
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const drafts = listDrafts();
  const healings = listHealingProposals();

  return {
    pendingDrafts: drafts.filter((d) => d.status === "pending").length,
    pendingHealing: healings.filter((h) => h.status === "pending").length,
    acceptedLastWeek:
      drafts.filter((d) => d.status === "accepted" && (d.reviewedAt ?? 0) > sevenDaysAgo).length +
      healings.filter((h) => h.status === "applied" && (h.reviewedAt ?? 0) > sevenDaysAgo).length,
    rejectedLastWeek:
      drafts.filter((d) => d.status === "rejected" && (d.reviewedAt ?? 0) > sevenDaysAgo).length +
      healings.filter((h) => h.status === "rejected" && (h.reviewedAt ?? 0) > sevenDaysAgo).length,
  };
}

// ─── Synthesized activity from queue files ────────────────────────────────────

export function synthesizeActivityFromQueues(limit = 100): SkillActivity[] {
  const events: SkillActivity[] = [];

  for (const d of listDrafts()) {
    events.push({
      id: `dc-${d.id}`,
      ts: d.proposedAt,
      type: "draft_created",
      message: `Draft "${d.slug}" proposed — task: ${(d.triggerOp ?? "unknown").slice(0, 80)}`,
      relatedId: d.id,
      relatedSlug: d.slug,
    });
    if (d.status === "accepted" && d.reviewedAt) {
      events.push({
        id: `da-${d.id}`,
        ts: d.reviewedAt,
        type: "draft_accepted",
        message: `Draft "${d.slug}" accepted`,
        relatedId: d.id,
        relatedSlug: d.slug,
      });
    } else if (d.status === "rejected" && d.reviewedAt) {
      events.push({
        id: `dr-${d.id}`,
        ts: d.reviewedAt,
        type: "draft_rejected",
        message: `Draft "${d.slug}" rejected${d.rejectReason ? `: ${d.rejectReason}` : ""}`,
        relatedId: d.id,
        relatedSlug: d.slug,
      });
    }
  }

  for (const h of listHealingProposals()) {
    events.push({
      id: `hq-${h.id}`,
      ts: h.proposedAt,
      type: "healing_queued",
      message: `Healing queued for "${h.skillName}": ${h.reason.slice(0, 100)}`,
      relatedId: h.id,
      relatedSlug: h.skillName,
    });
    if (h.status === "applied" && h.reviewedAt) {
      events.push({
        id: `ha-${h.id}`,
        ts: h.reviewedAt,
        type: "healing_applied",
        message: `Healing applied to "${h.skillName}"`,
        relatedId: h.id,
        relatedSlug: h.skillName,
      });
    } else if (h.status === "rejected" && h.reviewedAt) {
      events.push({
        id: `hr-${h.id}`,
        ts: h.reviewedAt,
        type: "healing_rejected",
        message: `Healing rejected for "${h.skillName}"`,
        relatedId: h.id,
        relatedSlug: h.skillName,
      });
    }
  }

  return events.sort((a, b) => b.ts - a.ts).slice(0, limit);
}

// ─── Path helpers ─────────────────────────────────────────────────────────────

function resolveSkillTargetDir(slug: string, scope: DraftScope, workspaceDir?: string): string {
  switch (scope) {
    case "user":
      return join(homedir(), ".claude", "skills", slug);
    case "workspace":
      if (!workspaceDir) throw new Error("workspaceDir is required for workspace scope");
      return join(workspaceDir, "skills", slug);
    case "infinibot":
    default:
      return join(CONFIG_DIR, "skills", slug);
  }
}

function findSkillPath(skillName: string, workspaceDir?: string): string | null {
  const candidates = [
    join(CONFIG_DIR, "skills", skillName, "SKILL.md"),
    join(homedir(), ".claude", "skills", skillName, "SKILL.md"),
    ...(workspaceDir ? [join(workspaceDir, "skills", skillName, "SKILL.md")] : []),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

function findSkillContent(skillName: string, workspaceDir?: string): string {
  const p = findSkillPath(skillName, workspaceDir);
  if (!p) return "";
  try {
    return readFileSync(p, "utf-8");
  } catch {
    return "";
  }
}

// ─── Simple line-diff ─────────────────────────────────────────────────────────

export function computeSimpleDiff(oldText: string, newText: string): string {
  if (oldText === newText) return "(no changes)";
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const maxLen = Math.max(oldLines.length, newLines.length);
  const result: string[] = [];
  for (let i = 0; i < maxLen; i++) {
    const o = oldLines[i];
    const n = newLines[i];
    if (o === undefined) result.push(`+${n}`);
    else if (n === undefined) result.push(`-${o}`);
    else if (o !== n) {
      result.push(`-${o}`);
      result.push(`+${n}`);
    } else {
      result.push(` ${o}`);
    }
  }
  return result.join("\n");
}
