/**
 * Guided Learn — per-user progress in the gateway (`<state>/learn.sqlite`).
 *
 * Progress lives server-side so it follows the user across browsers and the
 * mobile app (which opens walkthroughs as web views). The control UI keeps a
 * localStorage mirror only for instant paint and offline resume.
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import type { GuidedProgress, QuizResult, WalkthroughProgress } from "./types.js";

type Row = Record<string, unknown>;

export class GuidedProgressStore {
  private db: Database.Database;

  constructor(stateDir: string, dbFile = resolve(stateDir, "learn.sqlite")) {
    mkdirSync(stateDir, { recursive: true });
    this.db = new Database(dbFile);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS guided_walkthroughs (
        userId TEXT NOT NULL,
        ref TEXT NOT NULL,
        status TEXT NOT NULL,
        stepId TEXT,
        completedSteps TEXT NOT NULL DEFAULT '[]',
        updatedAt INTEGER NOT NULL,
        completedAt INTEGER,
        PRIMARY KEY (userId, ref)
      );
      CREATE TABLE IF NOT EXISTS guided_quizzes (
        userId TEXT NOT NULL,
        trackId TEXT NOT NULL,
        score INTEGER NOT NULL,
        total INTEGER NOT NULL,
        passed INTEGER NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY (userId, trackId)
      );
      CREATE TABLE IF NOT EXISTS guided_prefs (
        userId TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updatedAt INTEGER NOT NULL,
        PRIMARY KEY (userId, key)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  get(userId: string): GuidedProgress {
    const walkthroughs: Record<string, WalkthroughProgress> = {};
    for (const r of this.db
      .prepare("SELECT * FROM guided_walkthroughs WHERE userId = ?")
      .all(userId) as Row[]) {
      walkthroughs[String(r.ref)] = rowToWalkthrough(r);
    }
    const quizzes: Record<string, QuizResult> = {};
    for (const r of this.db
      .prepare("SELECT * FROM guided_quizzes WHERE userId = ?")
      .all(userId) as Row[]) {
      quizzes[String(r.trackId)] = {
        score: Number(r.score),
        total: Number(r.total),
        passed: Number(r.passed) === 1,
        at: Number(r.at),
      };
    }
    const prefs: Record<string, unknown> = {};
    let session: GuidedProgress["session"] = null;
    for (const r of this.db
      .prepare("SELECT * FROM guided_prefs WHERE userId = ?")
      .all(userId) as Row[]) {
      let value: unknown = null;
      try {
        value = JSON.parse(String(r.value));
      } catch {
        value = null;
      }
      if (r.key === "session") session = isSession(value) ? value : null;
      else prefs[String(r.key)] = value;
    }
    return { userId, walkthroughs, quizzes, prefs, session };
  }

  /** Record that a step was reached / done. Never moves a completed walkthrough backwards. */
  step(userId: string, ref: string, stepId: string, done: boolean): WalkthroughProgress {
    const cur = this.getWalkthrough(userId, ref);
    const completedSteps = new Set(cur?.completedSteps ?? []);
    if (done) completedSteps.add(stepId);
    const now = Date.now();
    const status = cur?.status === "completed" ? "completed" : "in_progress";
    this.db
      .prepare(
        `INSERT INTO guided_walkthroughs (userId, ref, status, stepId, completedSteps, updatedAt, completedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(userId, ref) DO UPDATE SET status = excluded.status, stepId = excluded.stepId,
           completedSteps = excluded.completedSteps, updatedAt = excluded.updatedAt`,
      )
      .run(
        userId,
        ref,
        status,
        stepId,
        JSON.stringify([...completedSteps]),
        now,
        cur?.completedAt ?? null,
      );
    return this.getWalkthrough(userId, ref)!;
  }

  complete(userId: string, ref: string, stepIds: string[]): WalkthroughProgress {
    const cur = this.getWalkthrough(userId, ref);
    const now = Date.now();
    const steps = [...new Set([...(cur?.completedSteps ?? []), ...stepIds])];
    this.db
      .prepare(
        `INSERT INTO guided_walkthroughs (userId, ref, status, stepId, completedSteps, updatedAt, completedAt)
         VALUES (?, ?, 'completed', NULL, ?, ?, ?)
         ON CONFLICT(userId, ref) DO UPDATE SET status = 'completed', stepId = NULL,
           completedSteps = excluded.completedSteps, updatedAt = excluded.updatedAt,
           completedAt = COALESCE(guided_walkthroughs.completedAt, excluded.completedAt)`,
      )
      .run(userId, ref, JSON.stringify(steps), now, now);
    return this.getWalkthrough(userId, ref)!;
  }

  reset(userId: string, ref: string): void {
    this.db
      .prepare("DELETE FROM guided_walkthroughs WHERE userId = ? AND ref = ?")
      .run(userId, ref);
  }

  /** Keep the best quiz result (a pass is never lost by a later retake). */
  recordQuiz(
    userId: string,
    trackId: string,
    score: number,
    total: number,
    passed: boolean,
  ): QuizResult {
    const prev = this.db
      .prepare("SELECT * FROM guided_quizzes WHERE userId = ? AND trackId = ?")
      .get(userId, trackId) as Row | undefined;
    const prevPassed = prev ? Number(prev.passed) === 1 : false;
    const prevScore = prev ? Number(prev.score) : -1;
    const keepPrev =
      prev && ((prevPassed && !passed) || (prevPassed === passed && prevScore > score));
    if (!keepPrev) {
      this.db
        .prepare(
          `INSERT INTO guided_quizzes (userId, trackId, score, total, passed, at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(userId, trackId) DO UPDATE SET score = excluded.score, total = excluded.total,
             passed = excluded.passed, at = excluded.at`,
        )
        .run(userId, trackId, score, total, passed ? 1 : 0, Date.now());
    }
    return this.get(userId).quizzes[trackId]!;
  }

  setPref(userId: string, key: string, value: unknown): void {
    if (value === null || value === undefined) {
      this.db.prepare("DELETE FROM guided_prefs WHERE userId = ? AND key = ?").run(userId, key);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO guided_prefs (userId, key, value, updatedAt) VALUES (?, ?, ?, ?)
         ON CONFLICT(userId, key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`,
      )
      .run(userId, key, JSON.stringify(value), Date.now());
  }

  private getWalkthrough(userId: string, ref: string): WalkthroughProgress | null {
    const r = this.db
      .prepare("SELECT * FROM guided_walkthroughs WHERE userId = ? AND ref = ?")
      .get(userId, ref) as Row | undefined;
    return r ? rowToWalkthrough(r) : null;
  }
}

function rowToWalkthrough(r: Row): WalkthroughProgress {
  let completedSteps: string[] = [];
  try {
    const parsed = JSON.parse(String(r.completedSteps ?? "[]"));
    if (Array.isArray(parsed))
      completedSteps = parsed.filter((x): x is string => typeof x === "string");
  } catch {
    /* ignore */
  }
  const status = String(r.status);
  return {
    status:
      status === "completed"
        ? "completed"
        : status === "in_progress"
          ? "in_progress"
          : "not_started",
    stepId: r.stepId ? String(r.stepId) : null,
    completedSteps,
    updatedAt: Number(r.updatedAt),
    completedAt: r.completedAt == null ? null : Number(r.completedAt),
  };
}

function isSession(v: unknown): v is NonNullable<GuidedProgress["session"]> {
  return (
    Boolean(v) &&
    typeof v === "object" &&
    typeof (v as Record<string, unknown>).trackId === "string" &&
    typeof (v as Record<string, unknown>).walkthroughId === "string" &&
    typeof (v as Record<string, unknown>).stepId === "string"
  );
}

let _store: GuidedProgressStore | null = null;
let _dir: string | null = null;

export function getGuidedProgressStore(stateDir: string): GuidedProgressStore {
  if (!_store || _dir !== stateDir) {
    _store = new GuidedProgressStore(stateDir);
    _dir = stateDir;
  }
  return _store;
}
