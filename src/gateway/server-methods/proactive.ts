/**
 * Proactive Overhaul v2 — gateway handlers
 *
 * Surfaces the v2 commitment + drift-radar engine to web + mobile. Mirrors the
 * `discipline.insights` pattern: gather the shared BusinessSnapshot once, then
 * run the pure engine. All mutations persist to STATE_DIR/proactive.json.
 *
 * RPCs:
 *   proactive.state      — full ProactiveState (focus rows, drift, candidates,
 *                          active commitment, where-was-i). Touches lastSeenAt.
 *   proactive.commit     — start a commitment block (locks the Now-bar)
 *   proactive.break      — break the active block with a 1-sentence reason
 *   proactive.complete   — end-of-block ritual (shipped/blocked + optional next)
 *   proactive.resume     — resume the previous block
 *   proactive.config.get / proactive.config.set — declared MAX + drift days
 *   proactive.focus.set  — declare which projects are in the focus rotation
 *   proactive.project.park / proactive.project.promote — cold ↔ rotation
 */

import { execFileSync } from "node:child_process";
import { GatewayRequestHandlers } from "./types.js";
import { STATE_DIR } from "../../config/paths.js";
import {
  computeCommitStatus,
  computeBuildStatus,
  repoRoot,
} from "../../proactive/change-status.js";
import { gatherBusinessSnapshot } from "../../proactive/business-snapshot.js";
import { computeProactiveState } from "../../proactive/engine.js";
import {
  loadProactiveStore,
  updateProactiveStore,
  setProactiveConfig,
} from "../../proactive/commit-store.js";
import { getPopupStore } from "../../proactive/popup-store.js";
import {
  loadPopupSettings,
  savePopupSettings,
  type QuietHours,
  type FocusMode,
} from "../../proactive/popup-settings.js";
import { buildAndInsertPopup } from "../../proactive/emit.js";
import {
  TIER_ORDER,
  validatePopupMedia,
  validatePopupInteract,
  type PopupTier,
  type PopupAttribution,
  type PopupAction,
  type PopupMedia,
} from "../../proactive/popup-types.js";

/** Optional tap target from RPC params (`deepLink` string or `link` object); normalized in emit. */
function linkParams(p: {
  deepLink?: unknown;
  link?: { deepLink?: unknown; webUrl?: unknown } | null;
}): { deepLink?: string; link?: { deepLink: string; webUrl?: string } } {
  const out: { deepLink?: string; link?: { deepLink: string; webUrl?: string } } = {};
  if (typeof p.deepLink === "string" && p.deepLink.trim()) out.deepLink = p.deepLink.trim();
  const l = p.link;
  if (l && typeof l === "object" && typeof l.deepLink === "string" && l.deepLink.trim()) {
    out.link = {
      deepLink: l.deepLink.trim(),
      ...(typeof l.webUrl === "string" && /^https?:\/\//i.test(l.webUrl.trim())
        ? { webUrl: l.webUrl.trim() }
        : {}),
    };
  }
  return out;
}

/** Parse a snooze duration ("1h" | "1d" | "week" | ms-number) into ms. */
function parseSnoozeDuration(d: unknown): number | null {
  if (typeof d === "number" && d > 0) return d;
  if (typeof d !== "string") return null;
  const s = d.trim().toLowerCase();
  const named: Record<string, number> = {
    "1h": 60 * 60 * 1000,
    "1d": 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
    "1w": 7 * 24 * 60 * 60 * 1000,
  };
  if (named[s]) return named[s];
  const m = /^(\d+)\s*(m|h|d|w)$/.exec(s);
  if (m) {
    const n = Number(m[1]);
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2]]!;
    return n * unit;
  }
  return null;
}

/** Run a shell command, returning stdout; throws (with stderr) on failure. */
function run(cmd: string, args: string[], cwd: string, timeout = 600_000): string {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  })
    .toString()
    .trim();
}

/**
 * Merge a completion-status patch into an agent-summary event's media and
 * broadcast a `proactive.updated` frame so the live overlay refreshes its chips.
 * No-op (returns null) when the event is missing or isn't an agent-summary card.
 */
function patchCompletionStatus(
  id: string | undefined,
  patch: {
    buildStatus?: "built" | "unbuilt";
    commitStatus?: "committed" | "uncommitted";
    pushed?: boolean;
  },
  broadcast: (event: string, payload: unknown) => void,
): unknown {
  if (!id) return null;
  const store = getPopupStore(STATE_DIR);
  const ev = store.get(id);
  if (!ev || ev.media?.kind !== "agent-summary") return null;
  const media = {
    ...ev.media,
    payload: { ...ev.media.payload, ...patch },
  } as PopupMedia;
  const updated = store.setMedia(id, media);
  if (updated) broadcast("proactive.updated", { event: updated });
  return updated;
}

async function buildState(touchSeen: boolean) {
  if (touchSeen) {
    updateProactiveStore(STATE_DIR, (s) => {
      // Record the read so "while away" / idle is anchored to the last view.
      s.lastSeenAt = Date.now();
    });
  }
  const [snap, store] = [await gatherBusinessSnapshot(STATE_DIR), loadProactiveStore(STATE_DIR)];
  return computeProactiveState(snap, store);
}

export const proactiveHandlers: GatewayRequestHandlers = {
  "proactive.state": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as { touch?: boolean };
      const state = await buildState(p.touch !== false);
      respond(true, state);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "proactive.commit": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as {
        taskId?: string;
        projectId?: string;
        title?: string;
        durationMin?: number;
      };
      if (!p.title && !p.taskId) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "title or taskId is required",
        });
        return;
      }
      const duration = [25, 45, 90].includes(p.durationMin ?? 0) ? p.durationMin! : 45;
      updateProactiveStore(STATE_DIR, (s) => {
        // Starting a new block retires any active one into lastCommitment.
        if (s.activeCommitment) {
          s.lastCommitment = { ...s.activeCommitment, endedAt: Date.now() };
        }
        s.activeCommitment = {
          taskId: p.taskId ?? null,
          projectId: p.projectId ?? null,
          title: p.title ?? "Committed block",
          startedAt: Date.now(),
          durationMin: duration,
        };
        s.lastSeenAt = Date.now();
      });
      respond(true, await buildState(false));
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "proactive.break": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as { reason?: string };
      const reason = (p.reason ?? "").trim();
      if (!reason) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "A 1-sentence reason is required to break a commitment",
        });
        return;
      }
      const store = loadProactiveStore(STATE_DIR);
      if (!store.activeCommitment) {
        respond(false, undefined, { code: "NO_ACTIVE", message: "No active commitment to break" });
        return;
      }
      updateProactiveStore(STATE_DIR, (s) => {
        const ac = s.activeCommitment!;
        s.breaks.push({ at: Date.now(), taskId: ac.taskId, reason });
        s.lastCommitment = { ...ac, endedAt: Date.now() };
        s.activeCommitment = null;
        s.lastSeenAt = Date.now();
      });
      respond(true, await buildState(false));
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "proactive.complete": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as { outcome?: "shipped" | "blocked"; next?: string };
      const outcome = p.outcome === "blocked" ? "blocked" : "shipped";
      updateProactiveStore(STATE_DIR, (s) => {
        const ac = s.activeCommitment;
        s.completions.push({
          at: Date.now(),
          taskId: ac?.taskId ?? null,
          outcome,
          next: p.next?.trim() || undefined,
        });
        if (ac) s.lastCommitment = { ...ac, endedAt: Date.now() };
        s.activeCommitment = null;
        s.lastSeenAt = Date.now();
      });
      respond(true, await buildState(false));
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "proactive.resume": async ({ respond }) => {
    try {
      const store = loadProactiveStore(STATE_DIR);
      if (!store.lastCommitment) {
        respond(false, undefined, { code: "NO_LAST", message: "Nothing to resume" });
        return;
      }
      updateProactiveStore(STATE_DIR, (s) => {
        const lc = s.lastCommitment!;
        s.activeCommitment = {
          taskId: lc.taskId,
          projectId: lc.projectId,
          title: lc.title,
          startedAt: Date.now(),
          durationMin: lc.durationMin,
        };
        s.lastSeenAt = Date.now();
      });
      respond(true, await buildState(false));
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "proactive.config.get": async ({ respond }) => {
    try {
      const store = loadProactiveStore(STATE_DIR);
      respond(true, { config: store.config });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "proactive.config.set": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as { maxFocus?: number; driftDays?: number };
      const store = setProactiveConfig(STATE_DIR, p);
      respond(true, { config: store.config });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "proactive.focus.set": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as { projectIds?: string[] };
      if (!Array.isArray(p.projectIds)) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "projectIds must be an array",
        });
        return;
      }
      updateProactiveStore(STATE_DIR, (s) => {
        s.focusedProjectIds = p.projectIds!.filter((x) => typeof x === "string");
        // Declaring a project into rotation clears any cold flag on it.
        s.coldProjectIds = s.coldProjectIds.filter((id) => !s.focusedProjectIds.includes(id));
      });
      respond(true, await buildState(false));
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "proactive.project.park": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as { projectId?: string };
      if (!p.projectId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "projectId is required" });
        return;
      }
      updateProactiveStore(STATE_DIR, (s) => {
        s.focusedProjectIds = s.focusedProjectIds.filter((id) => id !== p.projectId);
        if (!s.coldProjectIds.includes(p.projectId!)) s.coldProjectIds.push(p.projectId!);
      });
      respond(true, await buildState(false));
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "proactive.project.promote": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as { projectId?: string };
      if (!p.projectId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "projectId is required" });
        return;
      }
      updateProactiveStore(STATE_DIR, (s) => {
        s.coldProjectIds = s.coldProjectIds.filter((id) => id !== p.projectId);
        if (!s.focusedProjectIds.includes(p.projectId!)) s.focusedProjectIds.push(p.projectId!);
      });
      respond(true, await buildState(false));
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // ── Pop-Up System (Stage 1) ───────────────────────────────────────────────
  // Interruption RPCs, distinct from the commitment/drift handlers above.
  // Real-time delivery rides the gateway WS broadcast: emit/ack/snooze/dismiss
  // push a `proactive.event` frame; the UI listens via client.subscribe().

  "proactive.emit": async ({ params, respond, context }) => {
    try {
      const p = (params ?? {}) as {
        tier?: string;
        title?: string;
        body?: string;
        attribution?: PopupAttribution;
        actions?: PopupAction[];
        dedupKey?: string;
        voice?: string;
        media?: unknown;
        deepLink?: string;
        link?: { deepLink?: string; webUrl?: string };
      };

      // Attribution is mandatory — no agentId, no pop.
      const attribution = p.attribution;
      if (!attribution || typeof attribution.agentId !== "string" || !attribution.agentId.trim()) {
        respond(false, undefined, {
          code: "ATTRIBUTION_REQUIRED",
          message:
            "proactive.emit requires attribution with a non-empty agentId (cardId / goalId / verifierEvidenceRef optional)",
        });
        return;
      }
      const tier = (p.tier ?? "").toUpperCase() as PopupTier;
      if (!TIER_ORDER.includes(tier)) {
        respond(false, undefined, {
          code: "INVALID_TIER",
          message: `tier must be one of ${TIER_ORDER.join(", ")}`,
        });
        return;
      }
      const title = (p.title ?? "").trim();
      const body = typeof p.body === "string" ? p.body : "";
      if (!title) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "title is required" });
        return;
      }
      const dedupKey = (p.dedupKey ?? "").trim();
      if (!dedupKey) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "dedupKey is required" });
        return;
      }

      // Optional media — leniently validated; a bad shape is dropped, not fatal.
      let media: PopupMedia | undefined;
      if (p.media != null) {
        const v = validatePopupMedia(p.media);
        if (v.error) {
          respond(false, undefined, { code: "INVALID_MEDIA", message: v.error });
          return;
        }
        media = v.media;
      }

      const { event, routing } = buildAndInsertPopup(
        {
          tier,
          title,
          body,
          attribution,
          actions: Array.isArray(p.actions) ? p.actions : [],
          dedupKey,
          voice: p.voice,
          media,
          ...linkParams(p),
        },
        STATE_DIR,
      );

      context.broadcast("proactive.event", { event, routing });
      respond(true, { event, routing });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // Typed convenience wrapper for rich-media pops. Validates the `{ kind,
  // payload }` block strictly, then routes through the same core as emit. Any
  // agent or RPC caller can fire a styled card without hand-building actions.
  "proactive.emitMedia": async ({ params, respond, context }) => {
    try {
      const p = (params ?? {}) as {
        tier?: string;
        title?: string;
        body?: string;
        attribution?: PopupAttribution;
        actions?: PopupAction[];
        dedupKey?: string;
        voice?: string;
        media?: unknown;
        kind?: string;
        payload?: unknown;
        deepLink?: string;
        link?: { deepLink?: string; webUrl?: string };
      };
      const attribution = p.attribution;
      if (!attribution || typeof attribution.agentId !== "string" || !attribution.agentId.trim()) {
        respond(false, undefined, {
          code: "ATTRIBUTION_REQUIRED",
          message: "proactive.emitMedia requires attribution with a non-empty agentId",
        });
        return;
      }
      const title = (p.title ?? "").trim();
      if (!title) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "title is required" });
        return;
      }
      const dedupKey = (p.dedupKey ?? "").trim();
      if (!dedupKey) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "dedupKey is required" });
        return;
      }
      // Accept either { media: { kind, payload } } or a flattened { kind, payload }.
      const rawMedia = p.media ?? (p.kind ? { kind: p.kind, payload: p.payload } : undefined);
      const v = validatePopupMedia(rawMedia);
      if (v.error) {
        respond(false, undefined, { code: "INVALID_MEDIA", message: v.error });
        return;
      }
      // Media-rich pops default to NOTABLE so they actually surface as a toast.
      const tier = (p.tier ?? "NOTABLE").toUpperCase() as PopupTier;
      if (!TIER_ORDER.includes(tier)) {
        respond(false, undefined, {
          code: "INVALID_TIER",
          message: `tier must be one of ${TIER_ORDER.join(", ")}`,
        });
        return;
      }
      const { event, routing } = buildAndInsertPopup(
        {
          tier,
          title,
          body: typeof p.body === "string" ? p.body : "",
          attribution,
          actions: Array.isArray(p.actions) ? p.actions : [],
          dedupKey,
          voice: p.voice,
          media: v.media,
          ...linkParams(p),
        },
        STATE_DIR,
      );
      context.broadcast("proactive.event", { event, routing });
      respond(true, { event, routing });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // Pin / unpin: hold a (typically media-rich) pop on screen past its timer.
  // Pure flag — does not change lifecycle state, so a pinned event can still be
  // acted/snoozed/dismissed later.
  "proactive.pin": async ({ params, respond, context }) => {
    try {
      const p = (params ?? {}) as { id?: string };
      if (!p.id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id is required" });
        return;
      }
      const event = getPopupStore(STATE_DIR).setPinned(p.id, true);
      if (!event) {
        respond(false, undefined, { code: "NOT_FOUND", message: "event not found" });
        return;
      }
      context.broadcast("proactive.updated", { event });
      respond(true, { event });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "proactive.unpin": async ({ params, respond, context }) => {
    try {
      const p = (params ?? {}) as { id?: string };
      if (!p.id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id is required" });
        return;
      }
      const event = getPopupStore(STATE_DIR).setPinned(p.id, false);
      if (!event) {
        respond(false, undefined, { code: "NOT_FOUND", message: "event not found" });
        return;
      }
      context.broadcast("proactive.updated", { event });
      respond(true, { event });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // Interact: drive an already-shown overlay live (server → client). The agent
  // that emitted a stylized-markdown / card-deck pop can highlight an element,
  // scroll to it, replace/append content, advance the cursor, or dismiss while
  // it is still speaking. We persist nothing — the event already exists; this is
  // a pure control frame fanned out over the same WS bridge as emit.
  "proactive.interact": async ({ params, respond, context }) => {
    try {
      const v = validatePopupInteract(params);
      if (v.error) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: v.error });
        return;
      }
      // Confirm the target event exists so a stale eventId fails loudly.
      const event = getPopupStore(STATE_DIR).get(v.interact!.eventId);
      if (!event) {
        respond(false, undefined, { code: "NOT_FOUND", message: "event not found" });
        return;
      }
      context.broadcast("proactive.interact", { interact: v.interact });
      respond(true, { interact: v.interact });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // ── Completion-overlay forward actions ─────────────────────────────────────
  // User-triggered from the completion pop-up's "Build into UI" / "Commit &
  // Push" buttons. Each runs the REAL action, recomputes the derived status, and
  // patches the event's chips in place (proactive.updated broadcast). These are
  // only ever invoked by an explicit button click — nothing auto-runs them.

  "proactive.buildInto": async ({ params, respond, context }) => {
    try {
      const p = (params ?? {}) as { id?: string; workdir?: string; paths?: string[] };
      const wd = p.workdir && p.workdir.trim() ? p.workdir : process.cwd();
      const root = repoRoot(wd) ?? wd;
      let output = "";
      try {
        output = run("pnpm", ["-C", "ui", "build"], root);
      } catch (e: any) {
        respond(false, undefined, {
          code: "BUILD_FAILED",
          message: (e?.stderr ? String(e.stderr) : e?.message || "ui build failed").slice(-2000),
        });
        return;
      }
      // Rebuild landed → recompute against the same paths (marker now fresh).
      const buildStatus = computeBuildStatus(root, Array.isArray(p.paths) ? p.paths : []);
      patchCompletionStatus(p.id, { buildStatus }, context.broadcast);
      respond(true, { buildStatus, output: output.slice(-2000) });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "proactive.commitPush": async ({ params, respond, context }) => {
    try {
      const p = (params ?? {}) as {
        id?: string;
        workdir?: string;
        paths?: string[];
        message?: string;
        push?: boolean;
      };
      const wd = p.workdir && p.workdir.trim() ? p.workdir : process.cwd();
      const root = repoRoot(wd) ?? wd;
      const paths = (Array.isArray(p.paths) ? p.paths : []).filter(
        (x) => typeof x === "string" && x.trim(),
      );
      const message =
        (typeof p.message === "string" && p.message.trim()) || "chore(agent): commit agent changes";
      try {
        // Stage the run's changed paths (fall back to everything when unknown).
        run("git", ["add", "--", ...(paths.length ? paths : ["."])], root, 60_000);
        run("git", ["commit", "-m", message], root, 60_000);
      } catch (e: any) {
        respond(false, undefined, {
          code: "COMMIT_FAILED",
          message: (e?.stderr ? String(e.stderr) : e?.message || "git commit failed").slice(-2000),
        });
        return;
      }
      let pushError: string | null = null;
      if (p.push !== false) {
        try {
          run("git", ["push"], root, 120_000);
        } catch (e: any) {
          pushError = (e?.stderr ? String(e.stderr) : e?.message || "git push failed").slice(-2000);
        }
      }
      const { commitStatus, pushed, branch } = computeCommitStatus(root, paths);
      patchCompletionStatus(p.id, { commitStatus, pushed }, context.broadcast);
      respond(true, { commitStatus, pushed, branch, pushError });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "proactive.list": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as {
        since?: number;
        limit?: number;
        tier?: string;
        state?: string;
      };
      const tier =
        p.tier && TIER_ORDER.includes(p.tier.toUpperCase() as PopupTier)
          ? (p.tier.toUpperCase() as PopupTier)
          : undefined;
      const store = getPopupStore(STATE_DIR);
      const events = store.list({
        since: typeof p.since === "number" ? p.since : undefined,
        limit: typeof p.limit === "number" ? p.limit : undefined,
        tier,
        state: p.state as any,
      });
      respond(true, { events, serverTime: Date.now() });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "proactive.ack": async ({ params, respond, context }) => {
    try {
      const p = (params ?? {}) as { id?: string; action?: string; reasonOpt?: string };
      if (!p.id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id is required" });
        return;
      }
      const store = getPopupStore(STATE_DIR);
      const event = store.ack(p.id, p.action ?? "ack");
      if (!event) {
        respond(false, undefined, { code: "NOT_FOUND", message: "event not found" });
        return;
      }
      context.broadcast("proactive.updated", { event });
      respond(true, { event });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "proactive.snooze": async ({ params, respond, context }) => {
    try {
      const p = (params ?? {}) as { id?: string; duration?: unknown };
      if (!p.id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id is required" });
        return;
      }
      const ms = parseSnoozeDuration(p.duration);
      if (ms == null) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "duration must be '1h' | '1d' | 'week' | '<n>m|h|d|w' | ms-number",
        });
        return;
      }
      const store = getPopupStore(STATE_DIR);
      const now = Date.now();
      const event = store.snooze(p.id, now + ms, now);
      if (!event) {
        respond(false, undefined, { code: "NOT_FOUND", message: "event not found" });
        return;
      }
      context.broadcast("proactive.updated", { event });
      respond(true, { event });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "proactive.dismiss": async ({ params, respond, context }) => {
    try {
      const p = (params ?? {}) as { id?: string; reason?: string };
      if (!p.id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id is required" });
        return;
      }
      const store = getPopupStore(STATE_DIR);
      const event = store.dismiss(p.id, (p.reason ?? "").trim() || "dismissed");
      if (!event) {
        respond(false, undefined, { code: "NOT_FOUND", message: "event not found" });
        return;
      }
      context.broadcast("proactive.updated", { event });
      respond(true, { event });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // Snapshot subscribe: returns the current feed; live updates arrive via the
  // `proactive.event` / `proactive.updated` WS broadcasts (matches the gateway's
  // world-event streaming model — there is no per-RPC long-poll socket).
  "proactive.subscribe": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as { since?: number; limit?: number };
      const store = getPopupStore(STATE_DIR);
      const events = store.list({
        since: typeof p.since === "number" ? p.since : undefined,
        limit: typeof p.limit === "number" ? p.limit : 100,
      });
      respond(true, {
        events,
        serverTime: Date.now(),
        liveEvents: ["proactive.event", "proactive.updated", "proactive.interact"],
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "proactive.settings.get": async ({ respond }) => {
    try {
      respond(true, { settings: loadPopupSettings(STATE_DIR) });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "proactive.settings.set": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as {
        quietHours?: Partial<QuietHours>;
        focusMode?: Partial<FocusMode>;
      };
      const settings = savePopupSettings(STATE_DIR, {
        quietHours: p.quietHours as QuietHours | undefined,
        focusMode: p.focusMode as FocusMode | undefined,
      });
      respond(true, { settings });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
};
