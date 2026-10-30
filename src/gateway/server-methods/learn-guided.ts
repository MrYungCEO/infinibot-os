/**
 * Gateway Methods — guided Learn (interactive walkthroughs v2).
 *
 *   learn.guided.catalog          (read)  core + enabled-plugin tracks, quiz keys stripped,
 *                                         with the caller's progress, badges and cert ladder
 *   learn.guided.progress.get     (read)  the caller's progress only
 *   learn.guided.progress.update  (write) step reached / walkthrough completed / reset
 *   learn.guided.quiz.submit      (write) graded server-side against the answer key
 *   learn.guided.prefs.set        (write) small per-user prefs (missions dismissed, touched tabs,
 *                                         the in-flight tour for cross-device resume)
 *   learn.guided.certificate      (read)  SVG of an awarded guided-ladder certificate
 *
 * Progress is per user: the bound user (users store) or, on a single-owner
 * install with no users, the shared "_owner" record — so it follows the owner
 * across browsers and the mobile app.
 */

import { resolveStateDir } from "../../config/paths.js";
import {
  awardCertificate,
  getCertificate,
  renderCertificateSvg,
  type CertTier,
} from "../../learn/cert.js";
import {
  buildGuidedCatalog,
  findWalkthrough,
  type GuidedCatalog,
} from "../../learn/guided/catalog.js";
import { getGuidedProgressStore } from "../../learn/guided/progress-store.js";
import {
  computeBadges,
  computeCertLadder,
  computeTrackStatuses,
} from "../../learn/guided/status.js";
import {
  QUIZ_PASS_RATIO,
  stripQuizAnswers,
  walkthroughRef,
  type GuidedProgress,
} from "../../learn/guided/types.js";
import { getUserStore, type User } from "../../users/store.js";
import { learnCatalogPluginInputs } from "./plugins.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";

const OWNER_ID = "_owner";
// "path" = the personal learning path built from the onboarding answers (ui/src/learn/guided/learning-path.ts).
const PREF_KEYS = new Set([
  "missionsDismissed",
  "touched",
  "session",
  "lastTrack",
  "autoPopped",
  "path",
]);

function asStr(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function callerUser(opts: GatewayRequestHandlerOptions): User | null {
  const pw = opts.client?.connect.auth?.password;
  if (!pw) return null;
  try {
    return getUserStore(resolveStateDir()).findByGatewayPassword(pw);
  } catch {
    return null;
  }
}

function learnerId(opts: GatewayRequestHandlerOptions): string {
  return callerUser(opts)?.id ?? OWNER_ID;
}

function catalogNow(): GuidedCatalog {
  return buildGuidedCatalog(learnCatalogPluginInputs());
}

function fail(opts: GatewayRequestHandlerOptions, code: string, message: string) {
  opts.respond(false, undefined, { code, message });
}

function statusPayload(catalog: GuidedCatalog, progress: GuidedProgress) {
  return {
    statuses: computeTrackStatuses(catalog.tracks, progress),
    badges: computeBadges(catalog.tracks, progress),
    cert: computeCertLadder(catalog.tracks, progress),
  };
}

/** Mint any guided-ladder certificate the learner just became eligible for. */
function mintEligible(
  opts: GatewayRequestHandlerOptions,
  catalog: GuidedCatalog,
  progress: GuidedProgress,
) {
  const stateDir = resolveStateDir();
  const name = callerUser(opts)?.username ?? "InfiniBot owner";
  const minted: CertTier[] = [];
  for (const rung of computeCertLadder(catalog.tracks, progress)) {
    if (!rung.eligible) continue;
    if (getCertificate(stateDir, progress.userId, rung.tier)) continue;
    if (awardCertificate(stateDir, progress.userId, rung.tier, name)) minted.push(rung.tier);
  }
  return minted;
}

export const learnGuidedHandlers: GatewayRequestHandlers = {
  "learn.guided.catalog": async (opts) => {
    try {
      const catalog = catalogNow();
      const userId = learnerId(opts);
      const progress = getGuidedProgressStore(resolveStateDir()).get(userId);
      opts.respond(true, {
        tracks: catalog.tracks.map(stripQuizAnswers),
        plugins: catalog.plugins,
        missions: catalog.missions,
        progress,
        ...statusPayload(catalog, progress),
      });
    } catch (e) {
      fail(opts, "INTERNAL_ERROR", String(e));
    }
  },

  "learn.guided.progress.get": async (opts) => {
    try {
      const catalog = catalogNow();
      const progress = getGuidedProgressStore(resolveStateDir()).get(learnerId(opts));
      opts.respond(true, { progress, ...statusPayload(catalog, progress) });
    } catch (e) {
      fail(opts, "INTERNAL_ERROR", String(e));
    }
  },

  "learn.guided.progress.update": async (opts) => {
    try {
      const p = opts.params ?? {};
      const trackId = asStr(p.trackId);
      const walkthroughId = asStr(p.walkthroughId);
      const event = asStr(p.event);
      if (!trackId || !walkthroughId || !event || !["step", "complete", "reset"].includes(event)) {
        fail(
          opts,
          "INVALID_PARAMS",
          "expected { trackId, walkthroughId, event: step|complete|reset, stepId? }",
        );
        return;
      }
      const catalog = catalogNow();
      const found = findWalkthrough(catalog, trackId, walkthroughId);
      if (!found) {
        fail(opts, "NOT_FOUND", "walkthrough not found (is its plugin enabled?)");
        return;
      }
      const store = getGuidedProgressStore(resolveStateDir());
      const userId = learnerId(opts);
      const ref = walkthroughRef(trackId, walkthroughId);
      if (event === "reset") store.reset(userId, ref);
      else if (event === "complete") {
        store.complete(
          userId,
          ref,
          found.walkthrough.steps.map((s) => s.id),
        );
      } else {
        const stepId = asStr(p.stepId);
        if (!stepId || !found.walkthrough.steps.some((s) => s.id === stepId)) {
          fail(opts, "INVALID_PARAMS", "stepId must be a step of the walkthrough");
          return;
        }
        store.step(userId, ref, stepId, p.done === true);
      }
      const progress = store.get(userId);
      const minted = mintEligible(opts, catalog, progress);
      opts.respond(true, { progress, minted, ...statusPayload(catalog, progress) });
    } catch (e) {
      fail(opts, "INTERNAL_ERROR", String(e));
    }
  },

  "learn.guided.quiz.submit": async (opts) => {
    try {
      const trackId = asStr(opts.params?.trackId);
      const answers = opts.params?.answers;
      if (!trackId || !Array.isArray(answers)) {
        fail(opts, "INVALID_PARAMS", "expected { trackId, answers: number[] }");
        return;
      }
      const catalog = catalogNow();
      const track = catalog.tracks.find((t) => t.id === trackId);
      if (!track || track.quiz.length === 0) {
        fail(opts, "NOT_FOUND", "track has no quiz");
        return;
      }
      const results = track.quiz.map((q, i) => ({
        id: q.id,
        correct: answers[i] === q.answer,
        answer: q.answer,
        explain: q.explain,
      }));
      const score = results.filter((r) => r.correct).length;
      const passed = score / track.quiz.length >= QUIZ_PASS_RATIO;
      const store = getGuidedProgressStore(resolveStateDir());
      const userId = learnerId(opts);
      const quiz = store.recordQuiz(userId, trackId, score, track.quiz.length, passed);
      const progress = store.get(userId);
      const minted = mintEligible(opts, catalog, progress);
      opts.respond(true, {
        score,
        total: track.quiz.length,
        passed,
        best: quiz,
        results,
        progress,
        minted,
        ...statusPayload(catalog, progress),
      });
    } catch (e) {
      fail(opts, "INTERNAL_ERROR", String(e));
    }
  },

  "learn.guided.prefs.set": async (opts) => {
    try {
      const key = asStr(opts.params?.key);
      if (!key || !PREF_KEYS.has(key)) {
        fail(opts, "INVALID_PARAMS", `key must be one of ${[...PREF_KEYS].join(", ")}`);
        return;
      }
      const value = opts.params?.value;
      if (JSON.stringify(value ?? null).length > 8000) {
        fail(opts, "INVALID_PARAMS", "value too large");
        return;
      }
      const store = getGuidedProgressStore(resolveStateDir());
      const userId = learnerId(opts);
      store.setPref(userId, key, value ?? null);
      opts.respond(true, { progress: store.get(userId) });
    } catch (e) {
      fail(opts, "INTERNAL_ERROR", String(e));
    }
  },

  "learn.guided.certificate": async (opts) => {
    try {
      const tier = asStr(opts.params?.tier) as CertTier | undefined;
      if (!tier || !["apprentice", "practitioner", "master"].includes(tier)) {
        fail(opts, "INVALID_PARAMS", "tier must be apprentice|practitioner|master");
        return;
      }
      const cert = getCertificate(resolveStateDir(), learnerId(opts), tier);
      if (!cert) {
        fail(opts, "NOT_AWARDED", "certificate not awarded yet");
        return;
      }
      opts.respond(true, { svg: renderCertificateSvg(cert), certificate: cert });
    } catch (e) {
      fail(opts, "INTERNAL_ERROR", String(e));
    }
  },
};

export default learnGuidedHandlers;
