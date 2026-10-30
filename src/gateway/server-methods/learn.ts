/**
 * Gateway Methods — InfiniLearn (interactive walkthroughs).
 *
 * The dashboard's `/learn` page calls these to list tracks, advance the
 * stepper, and (when admin) inspect every user's progress + author new
 * walkthroughs.
 *
 * Auth model:
 *   • Self-actions (list own tracks, advance own steps, set own notes)
 *     work for any authenticated user.
 *   • Admin-only actions (`learn.admin.*`, plus `learn.tracks.assign`
 *     for someone else) require role=admin OR implicit-admin (when no
 *     users exist yet).
 */

import { resolveStateDir } from "../../config/paths.js";
import {
  autoEnrollUser,
  deleteUserTrack,
  getLearnStore,
  getTrack,
  loadAllTracks,
  summarizeTrack,
  writeUserTrack,
  type Walkthrough,
} from "../../learn/store.js";
import {
  computeEligibility,
  getCertificate,
  listAllCertificates,
  listCertificates,
  mintIfEligible,
  renderCertificateSvg,
  type CertTier,
} from "../../learn/cert.js";
import { getUserStore, type User } from "../../users/store.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";

// ── Helpers ─────────────────────────────────────────────────

function asStr(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function callerUser(opts: GatewayRequestHandlerOptions): User | null {
  const pw = opts.client?.connect.auth?.password;
  if (!pw) return null;
  return getUserStore(resolveStateDir()).findByGatewayPassword(pw);
}

/** Implicit-admin rule: until users exist, every connection is admin. */
function isAdmin(opts: GatewayRequestHandlerOptions): boolean {
  if (getUserStore(resolveStateDir()).count() === 0) return true;
  return callerUser(opts)?.role === "admin";
}

function requireAdmin(opts: GatewayRequestHandlerOptions): boolean {
  if (isAdmin(opts)) return true;
  opts.respond(false, undefined, { code: "FORBIDDEN", message: "admin role required" });
  return false;
}

/** Resolve the user this request applies to: explicit `userId` (admin), or self. */
function resolveTargetUser(opts: GatewayRequestHandlerOptions): { userId: string | null; isSelf: boolean } {
  const target = asStr(opts.params?.userId);
  const me = callerUser(opts);
  if (!target) return { userId: me?.id ?? null, isSelf: true };
  if (me?.id === target) return { userId: target, isSelf: true };
  if (isAdmin(opts)) return { userId: target, isSelf: false };
  return { userId: null, isSelf: false };
}

// ── Handlers ────────────────────────────────────────────────

export const learnHandlers: GatewayRequestHandlers = {
  /**
   * List every available track (bundled + admin-authored), each with
   * the caller's progress summary attached. Filters out admin-only
   * tracks for non-admin users.
   */
  "learn.tracks.list": async (opts) => {
    try {
      const stateDir = resolveStateDir();
      const me = callerUser(opts);
      const admin = isAdmin(opts);
      const tracks = loadAllTracks(stateDir).filter((t) => admin || t.audience !== "admin");
      const store = getLearnStore(stateDir);
      const userId = me?.id ?? "_implicit_admin";
      const summaries = tracks.map((t) => summarizeTrack(t, store.getProgress(userId, t.id)));
      opts.respond(true, { tracks: summaries });
    } catch (e) {
      opts.respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Fetch a single track + the caller's (or admin-target's) progress. */
  "learn.track.get": async (opts) => {
    try {
      const id = asStr(opts.params?.id);
      if (!id) {
        opts.respond(false, undefined, { code: "INVALID_PARAMS", message: "id required" });
        return;
      }
      const track = getTrack(resolveStateDir(), id);
      if (!track) {
        opts.respond(false, undefined, { code: "NOT_FOUND", message: "track not found" });
        return;
      }
      if (track.audience === "admin" && !isAdmin(opts)) {
        opts.respond(false, undefined, { code: "FORBIDDEN", message: "admin-only track" });
        return;
      }
      const { userId } = resolveTargetUser(opts);
      const store = getLearnStore(resolveStateDir());
      const progress = userId ? store.getProgress(userId, track.id) : null;
      opts.respond(true, { track, progress });
    } catch (e) {
      opts.respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Caller's progress across every track. */
  "learn.progress.get": async (opts) => {
    try {
      const { userId } = resolveTargetUser(opts);
      if (!userId) {
        opts.respond(true, { progress: [] });
        return;
      }
      const store = getLearnStore(resolveStateDir());
      const tracks = loadAllTracks(resolveStateDir());
      const trackById = new Map(tracks.map((t) => [t.id, t] as const));
      const summaries = store
        .listProgressForUser(userId)
        .map((p) => {
          const track = trackById.get(p.trackId);
          if (!track) return null;
          return summarizeTrack(track, p);
        })
        .filter((s): s is NonNullable<typeof s> => s != null);
      opts.respond(true, { progress: summaries });
    } catch (e) {
      opts.respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Mark a step complete and advance the cursor. */
  "learn.progress.completeStep": async (opts) => {
    try {
      const trackId = asStr(opts.params?.trackId);
      const stepId = asStr(opts.params?.stepId);
      if (!trackId || !stepId) {
        opts.respond(false, undefined, { code: "INVALID_PARAMS", message: "trackId and stepId required" });
        return;
      }
      const { userId } = resolveTargetUser(opts);
      if (!userId) {
        opts.respond(false, undefined, { code: "UNAUTHORIZED", message: "no user bound" });
        return;
      }
      const track = getTrack(resolveStateDir(), trackId);
      if (!track) {
        opts.respond(false, undefined, { code: "NOT_FOUND", message: "track not found" });
        return;
      }
      const store = getLearnStore(resolveStateDir());
      const progress = store.completeStep(userId, track, stepId);
      opts.respond(true, { progress });
    } catch (e) {
      opts.respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Move the cursor to a specific step without marking it complete. */
  "learn.progress.setCurrent": async (opts) => {
    try {
      const trackId = asStr(opts.params?.trackId);
      const stepId = asStr(opts.params?.stepId);
      if (!trackId || !stepId) {
        opts.respond(false, undefined, { code: "INVALID_PARAMS", message: "trackId and stepId required" });
        return;
      }
      const { userId } = resolveTargetUser(opts);
      if (!userId) {
        opts.respond(false, undefined, { code: "UNAUTHORIZED", message: "no user bound" });
        return;
      }
      const store = getLearnStore(resolveStateDir());
      const progress = store.setCurrentStep(userId, trackId, stepId);
      opts.respond(true, { progress });
    } catch (e) {
      opts.respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Save free-form notes for the caller's track. */
  "learn.progress.setNotes": async (opts) => {
    try {
      const trackId = asStr(opts.params?.trackId);
      const notes = asStr(opts.params?.notes) ?? "";
      if (!trackId) {
        opts.respond(false, undefined, { code: "INVALID_PARAMS", message: "trackId required" });
        return;
      }
      const { userId } = resolveTargetUser(opts);
      if (!userId) {
        opts.respond(false, undefined, { code: "UNAUTHORIZED", message: "no user bound" });
        return;
      }
      const store = getLearnStore(resolveStateDir());
      const progress = store.setNotes(userId, trackId, notes);
      opts.respond(true, { progress });
    } catch (e) {
      opts.respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Assign a track to a user. Self-assign always works; assigning to
   * other users requires admin.
   */
  "learn.tracks.assign": async (opts) => {
    try {
      const trackId = asStr(opts.params?.trackId);
      const targetUserId = asStr(opts.params?.userId);
      if (!trackId) {
        opts.respond(false, undefined, { code: "INVALID_PARAMS", message: "trackId required" });
        return;
      }
      const me = callerUser(opts);
      const userId = targetUserId ?? me?.id;
      if (!userId) {
        opts.respond(false, undefined, { code: "UNAUTHORIZED", message: "no user bound" });
        return;
      }
      if (targetUserId && targetUserId !== me?.id && !isAdmin(opts)) {
        opts.respond(false, undefined, { code: "FORBIDDEN", message: "cannot assign to other users" });
        return;
      }
      const track = getTrack(resolveStateDir(), trackId);
      if (!track) {
        opts.respond(false, undefined, { code: "NOT_FOUND", message: "track not found" });
        return;
      }
      const store = getLearnStore(resolveStateDir());
      const progress = store.assignTrack(userId, track);
      opts.respond(true, { progress });
    } catch (e) {
      opts.respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Self-unassign or admin-unassign for someone else. */
  "learn.tracks.unassign": async (opts) => {
    try {
      const trackId = asStr(opts.params?.trackId);
      const targetUserId = asStr(opts.params?.userId);
      if (!trackId) {
        opts.respond(false, undefined, { code: "INVALID_PARAMS", message: "trackId required" });
        return;
      }
      const me = callerUser(opts);
      const userId = targetUserId ?? me?.id;
      if (!userId) {
        opts.respond(false, undefined, { code: "UNAUTHORIZED", message: "no user bound" });
        return;
      }
      if (targetUserId && targetUserId !== me?.id && !isAdmin(opts)) {
        opts.respond(false, undefined, { code: "FORBIDDEN", message: "cannot unassign for other users" });
        return;
      }
      const store = getLearnStore(resolveStateDir());
      const removed = store.unassignTrack(userId, trackId);
      opts.respond(true, { removed });
    } catch (e) {
      opts.respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // ── Admin-only ────────────────────────────────────────────

  /**
   * Admin overview — every user × every track they have progress on,
   * with completion percentage. The /learn admin tab pivots this for
   * the dashboard view.
   */
  "learn.admin.allUsers": async (opts) => {
    if (!requireAdmin(opts)) return;
    try {
      const stateDir = resolveStateDir();
      const userStore = getUserStore(stateDir);
      const learnStore = getLearnStore(stateDir);
      const tracks = loadAllTracks(stateDir);
      const trackById = new Map(tracks.map((t) => [t.id, t] as const));
      const users = userStore.list();
      const allProgress = learnStore.listAllProgress();
      const grouped = new Map<string, ReturnType<typeof summarizeTrack>[]>();
      for (const p of allProgress) {
        const track = trackById.get(p.trackId);
        if (!track) continue;
        if (!grouped.has(p.userId)) grouped.set(p.userId, []);
        grouped.get(p.userId)!.push(summarizeTrack(track, p));
      }
      const rows = users.map((u) => ({
        user: { id: u.id, username: u.username, role: u.role, language: u.language },
        progress: grouped.get(u.id) ?? [],
      }));
      opts.respond(true, { users: rows, totalTracks: tracks.length });
    } catch (e) {
      opts.respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Admin: create or replace a walkthrough by id. */
  "learn.admin.upsertTrack": async (opts) => {
    if (!requireAdmin(opts)) return;
    try {
      const track = opts.params?.track as Walkthrough | undefined;
      if (!track || typeof track.id !== "string" || !Array.isArray(track.steps)) {
        opts.respond(false, undefined, { code: "INVALID_PARAMS", message: "track with id + steps[] required" });
        return;
      }
      writeUserTrack(resolveStateDir(), track);
      opts.respond(true, { track });
    } catch (e) {
      opts.respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Admin: delete a user-authored walkthrough (bundled tracks can't be deleted). */
  "learn.admin.deleteTrack": async (opts) => {
    if (!requireAdmin(opts)) return;
    try {
      const id = asStr(opts.params?.id);
      if (!id) {
        opts.respond(false, undefined, { code: "INVALID_PARAMS", message: "id required" });
        return;
      }
      const removed = deleteUserTrack(resolveStateDir(), id);
      opts.respond(true, { removed });
    } catch (e) {
      opts.respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Certificate status for the caller. Returns eligibility ladder for
   * Apprentice/Practitioner/Master plus any already-awarded records.
   * Calling this also auto-mints any tier the user has just qualified
   * for, so the UI never has to ask for the cert separately — the
   * status response includes the freshly-awarded record.
   */
  "learn.certificate.status": async (opts) => {
    try {
      const me = callerUser(opts);
      if (!me) {
        opts.respond(true, { eligibility: [], certificates: [] });
        return;
      }
      const stateDir = resolveStateDir();
      const progress = getLearnStore(stateDir).listProgressForUser(me.id);
      const eligibility = computeEligibility({
        stateDir,
        userId: me.id,
        isAdmin: me.role === "admin",
        progress,
      });
      // Auto-mint any tier the user has fully completed.
      const tiers: CertTier[] = ["apprentice", "practitioner", "master"];
      for (const tier of tiers) {
        const e = eligibility.find((x) => x.tier === tier);
        if (!e || e.awarded || e.missing.length > 0 || e.total === 0) continue;
        mintIfEligible({
          stateDir,
          userId: me.id,
          displayName: me.username,
          isAdmin: me.role === "admin",
          progress,
          tier,
        });
      }
      const certificates = listCertificates(stateDir, me.id);
      // Recompute eligibility post-mint so the `awarded` flags reflect
      // the freshly-awarded tier(s).
      const finalEligibility = computeEligibility({
        stateDir,
        userId: me.id,
        isAdmin: me.role === "admin",
        progress,
      });
      opts.respond(true, { eligibility: finalEligibility, certificates });
    } catch (e) {
      opts.respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Render the certificate as an inline SVG string. */
  "learn.certificate.svg": async (opts) => {
    try {
      const tier = asStr(opts.params?.tier) as CertTier | undefined;
      if (!tier || !["apprentice", "practitioner", "master"].includes(tier)) {
        opts.respond(false, undefined, { code: "INVALID_PARAMS", message: "tier must be apprentice|practitioner|master" });
        return;
      }
      const me = callerUser(opts);
      if (!me) {
        opts.respond(false, undefined, { code: "UNAUTHORIZED", message: "no user bound" });
        return;
      }
      const cert = getCertificate(resolveStateDir(), me.id, tier);
      if (!cert) {
        opts.respond(false, undefined, { code: "NOT_AWARDED", message: "certificate not awarded" });
        return;
      }
      opts.respond(true, { svg: renderCertificateSvg(cert), certificate: cert });
    } catch (e) {
      opts.respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Admin-only — every awarded certificate across all users. */
  "learn.certificate.list": async (opts) => {
    if (!requireAdmin(opts)) return;
    try {
      const certs = listAllCertificates(resolveStateDir());
      opts.respond(true, { certificates: certs });
    } catch (e) {
      opts.respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Admin: kick auto-enroll for a specific user (handy for back-fill). */
  "learn.admin.autoEnroll": async (opts) => {
    if (!requireAdmin(opts)) return;
    try {
      const userId = asStr(opts.params?.userId);
      if (!userId) {
        opts.respond(false, undefined, { code: "INVALID_PARAMS", message: "userId required" });
        return;
      }
      const enrolled = autoEnrollUser(resolveStateDir(), userId);
      opts.respond(true, { enrolled });
    } catch (e) {
      opts.respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
};

export default learnHandlers;
