/**
 * Learn Store — per-user progress through interactive walkthroughs.
 *
 * Two persistence layers:
 *   • **Tracks** (the curriculum) live as JSON under
 *     `<state>/learn/tracks/` plus the bundled defaults shipped in
 *     `src/learn/walkthroughs/`. Authors edit JSON; admin UI rewrites
 *     it. No database schema change needed when a track gains a step.
 *   • **Progress** (per-user state) lives in `<state>/learn.sqlite`
 *     because it changes per-action and we want fast aggregation for
 *     the admin dashboard.
 *
 * The store is the single API the gateway methods + UI talk to. The
 * standalone `infinilearn/` project in a developer workspace
 * has its own DB; the dashboard runs its own copy here so we don't
 * inherit an external schema or process.
 */

import Database from "better-sqlite3";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { BUNDLED_WALKTHROUGHS } from "./bundled.js";

// ── Types ─────────────────────────────────────────────────────

export type StepStatus = "locked" | "available" | "in_progress" | "completed";

export type StepVerify =
  | { kind: "manual" } // user marks complete themselves
  | { kind: "tab_visited"; tab: string } // user opened a specific tab
  | { kind: "method_called"; method: string } // a gateway method fired
  | { kind: "feature_used"; feature: string }; // generic event the agent emits

export interface WalkthroughStep {
  id: string;
  title: string;
  /** Markdown body shown in the stepper. */
  body: string;
  /** Optional deep-link CTA — e.g. "open the /business page". */
  cta?: { label: string; tab?: string; url?: string };
  /** How completion is recognized. Default is "manual". */
  verify?: StepVerify;
  /** Estimated minutes to complete. */
  estMinutes?: number;
}

export type WalkthroughTier = "beginner" | "intermediate" | "advanced";

export interface Walkthrough {
  id: string;
  title: string;
  description: string;
  audience: "user" | "admin" | "all";
  /** Other walkthrough ids the user should complete first. */
  prerequisites?: string[];
  /** Default-assigned to every new user when true. */
  defaultForNewUsers?: boolean;
  /** Sort weight — lower comes first in the library. */
  order?: number;
  /** Which area of the app the walkthrough covers. */
  category?: string;
  /** Difficulty tier — drives the certification ladder. */
  tier?: WalkthroughTier;
  /** When true, this track must be completed for the master certificate. */
  certRequired?: boolean;
  steps: WalkthroughStep[];
  /** Optional certificate / badge id awarded on completion. */
  badge?: string;
}

export interface UserProgress {
  userId: string;
  trackId: string;
  /** Current step id within the track. */
  currentStepId: string | null;
  /** Step ids the user has completed (in order). */
  completedSteps: string[];
  startedAt: number;
  updatedAt: number;
  completedAt: number | null;
  /** Free-form notes the user adds along the way. */
  notes: string;
}

export interface TrackSummary extends Walkthrough {
  progress?: UserProgress | null;
  totalSteps: number;
  completedCount: number;
  percent: number;
}

// ── Paths ─────────────────────────────────────────────────────

function userTracksDir(stateDir: string): string {
  return resolve(stateDir, "learn", "tracks");
}

function dbPath(stateDir: string): string {
  return resolve(stateDir, "learn.sqlite");
}

// ── Track loader ──────────────────────────────────────────────

function loadTracksFromDir(dir: string): Walkthrough[] {
  if (!existsSync(dir)) return [];
  const out: Walkthrough[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    const p = join(dir, entry);
    try {
      const raw = JSON.parse(readFileSync(p, "utf-8")) as Walkthrough;
      if (raw && typeof raw.id === "string" && Array.isArray(raw.steps)) out.push(raw);
    } catch (err) {
      console.warn(
        `[learn] skipping malformed track ${entry}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return out;
}

/** Bundled defaults + admin-authored tracks. Admin tracks shadow bundled ids. */
export function loadAllTracks(stateDir: string): Walkthrough[] {
  const userOverrides = loadTracksFromDir(userTracksDir(stateDir));
  const map = new Map<string, Walkthrough>();
  for (const t of BUNDLED_WALKTHROUGHS) map.set(t.id, t);
  for (const t of userOverrides) map.set(t.id, t);
  return Array.from(map.values()).sort(
    (a, b) => (a.order ?? 1000) - (b.order ?? 1000) || a.title.localeCompare(b.title),
  );
}

export function getTrack(stateDir: string, id: string): Walkthrough | null {
  return loadAllTracks(stateDir).find((t) => t.id === id) ?? null;
}

export function writeUserTrack(stateDir: string, track: Walkthrough): void {
  const dir = userTracksDir(stateDir);
  mkdirSync(dir, { recursive: true });
  const safeId = track.id.replace(/[^a-zA-Z0-9._-]/g, "_");
  writeFileSync(join(dir, `${safeId}.json`), JSON.stringify(track, null, 2), "utf-8");
}

export function deleteUserTrack(stateDir: string, id: string): boolean {
  const safe = id.replace(/[^a-zA-Z0-9._-]/g, "_");
  const p = join(userTracksDir(stateDir), `${safe}.json`);
  if (!existsSync(p)) return false;
  try {
    unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

// ── Progress store ────────────────────────────────────────────

export class LearnStore {
  private db: Database.Database;
  private stateDir: string;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    mkdirSync(dirname(dbPath(stateDir)), { recursive: true });
    this.db = new Database(dbPath(stateDir));
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_progress (
        userId TEXT NOT NULL,
        trackId TEXT NOT NULL,
        currentStepId TEXT,
        completedSteps TEXT NOT NULL DEFAULT '[]',
        startedAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        completedAt INTEGER,
        notes TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (userId, trackId)
      );
      CREATE INDEX IF NOT EXISTS idx_user_progress_user ON user_progress(userId);
      CREATE INDEX IF NOT EXISTS idx_user_progress_track ON user_progress(trackId);
    `);
  }

  /**
   * Idempotently assign a track to a user. Used both by auto-enroll on
   * `users.create` and by the admin "Assign track" action. If the user
   * already has progress on this track, returns the existing record.
   */
  assignTrack(userId: string, track: Walkthrough): UserProgress {
    const existing = this.getProgress(userId, track.id);
    if (existing) return existing;
    const firstStep = track.steps[0]?.id ?? null;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO user_progress (userId, trackId, currentStepId, completedSteps, startedAt, updatedAt, completedAt, notes)
         VALUES (?, ?, ?, '[]', ?, ?, NULL, '')`,
      )
      .run(userId, track.id, firstStep, now, now);
    return this.getProgress(userId, track.id)!;
  }

  unassignTrack(userId: string, trackId: string): boolean {
    const r = this.db
      .prepare("DELETE FROM user_progress WHERE userId = ? AND trackId = ?")
      .run(userId, trackId);
    return r.changes > 0;
  }

  getProgress(userId: string, trackId: string): UserProgress | null {
    const row = this.db
      .prepare("SELECT * FROM user_progress WHERE userId = ? AND trackId = ?")
      .get(userId, trackId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return rowToProgress(row);
  }

  listProgressForUser(userId: string): UserProgress[] {
    const rows = this.db
      .prepare("SELECT * FROM user_progress WHERE userId = ? ORDER BY updatedAt DESC")
      .all(userId) as Array<Record<string, unknown>>;
    return rows.map(rowToProgress);
  }

  /** Admin-only — list everyone's progress for the dashboard overview. */
  listAllProgress(): UserProgress[] {
    const rows = this.db
      .prepare("SELECT * FROM user_progress ORDER BY updatedAt DESC")
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowToProgress);
  }

  /**
   * Mark a step complete and advance to the next one. Returns the
   * updated progress record. If the step was the last one in the
   * track, `completedAt` is stamped.
   */
  completeStep(userId: string, track: Walkthrough, stepId: string): UserProgress {
    const cur = this.getProgress(userId, track.id) ?? this.assignTrack(userId, track);
    const completed = new Set(cur.completedSteps);
    completed.add(stepId);
    // Find the next uncompleted step.
    let nextStepId: string | null = null;
    for (const s of track.steps) {
      if (!completed.has(s.id)) {
        nextStepId = s.id;
        break;
      }
    }
    const now = Date.now();
    const allDone = nextStepId === null;
    const completedList = track.steps.filter((s) => completed.has(s.id)).map((s) => s.id);
    this.db
      .prepare(
        `UPDATE user_progress
         SET currentStepId = ?, completedSteps = ?, updatedAt = ?, completedAt = ?
         WHERE userId = ? AND trackId = ?`,
      )
      .run(nextStepId, JSON.stringify(completedList), now, allDone ? now : null, userId, track.id);
    return this.getProgress(userId, track.id)!;
  }

  setCurrentStep(userId: string, trackId: string, stepId: string): UserProgress | null {
    const cur = this.getProgress(userId, trackId);
    if (!cur) return null;
    const now = Date.now();
    this.db
      .prepare(
        "UPDATE user_progress SET currentStepId = ?, updatedAt = ? WHERE userId = ? AND trackId = ?",
      )
      .run(stepId, now, userId, trackId);
    return this.getProgress(userId, trackId);
  }

  setNotes(userId: string, trackId: string, notes: string): UserProgress | null {
    const cur = this.getProgress(userId, trackId);
    if (!cur) return null;
    const now = Date.now();
    this.db
      .prepare("UPDATE user_progress SET notes = ?, updatedAt = ? WHERE userId = ? AND trackId = ?")
      .run(notes, now, userId, trackId);
    return this.getProgress(userId, trackId);
  }

  /** Drop ALL progress for a user — when the admin deletes the account. */
  clearForUser(userId: string): void {
    this.db.prepare("DELETE FROM user_progress WHERE userId = ?").run(userId);
  }
}

function rowToProgress(row: Record<string, unknown>): UserProgress {
  let completed: string[] = [];
  try {
    const parsed = JSON.parse(String(row.completedSteps ?? "[]"));
    if (Array.isArray(parsed)) completed = parsed.filter((v): v is string => typeof v === "string");
  } catch {
    /* ignore */
  }
  return {
    userId: String(row.userId),
    trackId: String(row.trackId),
    currentStepId: row.currentStepId ? String(row.currentStepId) : null,
    completedSteps: completed,
    startedAt: Number(row.startedAt),
    updatedAt: Number(row.updatedAt),
    completedAt: row.completedAt == null ? null : Number(row.completedAt),
    notes: String(row.notes ?? ""),
  };
}

// ── Singleton ────────────────────────────────────────────────

let _store: LearnStore | null = null;
let _storeStateDir: string | null = null;

export function getLearnStore(stateDir: string): LearnStore {
  if (!_store || _storeStateDir !== stateDir) {
    _store = new LearnStore(stateDir);
    _storeStateDir = stateDir;
  }
  return _store;
}

// ── High-level helpers ──────────────────────────────────────

export function summarizeTrack(
  track: Walkthrough,
  progress: UserProgress | null | undefined,
): TrackSummary {
  const total = track.steps.length;
  const completed = progress?.completedSteps.length ?? 0;
  return {
    ...track,
    progress: progress ?? null,
    totalSteps: total,
    completedCount: completed,
    percent: total === 0 ? 0 : Math.round((completed / total) * 100),
  };
}

/** Auto-enroll: assign every track flagged `defaultForNewUsers: true`. */
export function autoEnrollUser(stateDir: string, userId: string): UserProgress[] {
  const store = getLearnStore(stateDir);
  const out: UserProgress[] = [];
  for (const track of loadAllTracks(stateDir)) {
    if (!track.defaultForNewUsers) continue;
    out.push(store.assignTrack(userId, track));
  }
  return out;
}
