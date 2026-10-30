/**
 * Work-review canvas builder — pure payload assembly for the HoloCanvas-style
 * post-run review scene. No I/O here: the emitter (work-review.ts) gathers the
 * run data (artifacts, checkpoints, diffstat, screenshot data-URIs) and this
 * module lays it out as an `InfiniteCanvasWalkthroughMedia` payload that the
 * existing `<infinite-canvas-walkthrough>` renderer + /canvas/:id share page
 * display without any UI changes.
 */

import type {
  CanvasNode,
  CanvasScene,
  InfiniteCanvasWalkthroughMedia,
} from "../proactive/popup-types.js";
import type { ArtifactStep, VerificationSummary } from "./artifacts/contract.js";

export type WorkReviewVerdict = "PASS" | "FAIL" | "UNVERIFIED";

export interface WorkReviewShot {
  file: string;
  step: string;
  viewport: string;
  /** Inline data-URI for the canvas image node; absent when the file was too big. */
  dataUrl?: string;
}

export interface WorkReviewCheckpoint {
  ts: number;
  summary: string;
  next: string;
  deviations: string[];
}

export interface WorkReviewData {
  runId: string;
  label: string;
  task: string;
  backend?: string;
  startedAt?: number;
  durationMs?: number | null;
  /** `git diff --shortstat` style one-liner, null when workdir isn't a repo. */
  diffstat?: string | null;
  steps: ArtifactStep[];
  shots: WorkReviewShot[];
  checkpoints: WorkReviewCheckpoint[];
  verification: VerificationSummary;
  /** Whether auto-verify was requested for this run. */
  verifyEnabled: boolean;
  reportMd: string;
  succeeded: boolean;
}

/** Map the verification outcome onto the badge verdict. */
export function resolveVerdict(data: {
  verification: VerificationSummary;
  verifyEnabled: boolean;
}): WorkReviewVerdict {
  if (data.verification.verdict === "SHIP") return "PASS";
  if (data.verification.verdict === "DO-NOT-SHIP") return "FAIL";
  return "UNVERIFIED";
}

const VERDICT_COLOR: Record<WorkReviewVerdict, string> = {
  PASS: "#3fb950",
  FAIL: "#f85149",
  UNVERIFIED: "#9aa0a6",
};

export function formatDuration(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

const STEP_ICON: Record<ArtifactStep["status"], string> = {
  done: "✅",
  skipped: "⏭️",
  failed: "❌",
};

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Build the full canvas payload for a finalized run's work review. */
export function buildWorkReviewCanvasPayload(data: WorkReviewData): InfiniteCanvasWalkthroughMedia {
  const verdict = resolveVerdict(data);
  const nodes: CanvasNode[] = [];
  const scenes: CanvasScene[] = [];

  const doneCount = data.steps.filter((s) => s.status === "done").length;
  const failedCount = data.steps.filter((s) => s.status === "failed").length;

  // ── Header ──
  const subParts = [
    data.backend ?? "coder",
    formatDuration(data.durationMs),
    data.diffstat ? data.diffstat.trim() : null,
  ].filter(Boolean);
  nodes.push({
    id: "header",
    kind: "title",
    x: 240,
    y: 240,
    w: 1000,
    kicker: "WORK REVIEW",
    brand: "InfiniBot",
    h1: truncate(data.label, 90),
    sub: subParts.join(" · "),
    part: data.succeeded ? "Run complete" : "Run ended with issues",
  });
  scenes.push({
    id: "s-header",
    focusNodeId: "header",
    narration: {
      ttsText: `Work review for ${data.label}.`,
      captionMd: `**Work review** — ${truncate(data.label, 60)}`,
    },
  });

  // ── Stats ──
  nodes.push({
    id: "stats",
    kind: "stats",
    x: 1360,
    y: 280,
    w: 820,
    stats: [
      { n: data.steps.length ? `${doneCount}/${data.steps.length}` : "—", l: "steps done" },
      { n: String(data.shots.length), l: "screenshots" },
      { n: String(data.checkpoints.length), l: "check-ins" },
      { n: formatDuration(data.durationMs), l: "duration" },
    ],
  });

  // ── Verdict badge ──
  const claims = data.verification.claims.slice(0, 8);
  const claimsMd = claims.length
    ? claims.map((c) => `${c.status === "PASS" ? "✅" : "❌"} ${truncate(c.claim, 90)}`).join("\n")
    : verdict === "UNVERIFIED"
      ? data.verifyEnabled
        ? "Verifier ran but produced no verdict."
        : "Auto-verify was not enabled for this run."
      : "";
  nodes.push({
    id: "verdict",
    kind: "callout",
    x: 240,
    y: 860,
    w: 640,
    cl: VERDICT_COLOR[verdict],
    icon: verdict === "PASS" ? "🟢" : verdict === "FAIL" ? "🔴" : "⚪",
    title:
      verdict === "PASS" ? "SHIP" : verdict === "FAIL" ? "DO NOT SHIP" : "UNVERIFIED",
    body: claimsMd,
  });
  scenes.push({
    id: "s-verdict",
    focusNodeId: "verdict",
    narration: {
      ttsText:
        verdict === "PASS"
          ? "Verification passed. Ship it."
          : verdict === "FAIL"
            ? "Verification failed. Do not ship."
            : "This run is unverified.",
      captionMd: `Verdict: **${verdict}**`,
    },
  });

  // ── Steps checklist ──
  if (data.steps.length) {
    nodes.push({
      id: "steps",
      kind: "reveal-list",
      x: 960,
      y: 860,
      w: 780,
      kicker: `STEPS · ${doneCount} done${failedCount ? ` · ${failedCount} failed` : ""}`,
      title: "Step log",
      items: data.steps.slice(0, 14).map((s) => ({
        md: `${STEP_ICON[s.status]} **${truncate(s.title, 70)}**${s.note ? ` — ${truncate(s.note, 80)}` : ""}`,
      })),
    });
    scenes.push({
      id: "s-steps",
      focusNodeId: "steps",
      narration: {
        ttsText: `${doneCount} of ${data.steps.length} steps completed.`,
        captionMd: `**${doneCount}/${data.steps.length}** steps done`,
      },
    });
  }

  // ── Checkpoint timeline ──
  if (data.checkpoints.length) {
    const t0 = data.startedAt ?? data.checkpoints[0].ts;
    nodes.push({
      id: "timeline",
      kind: "timeline",
      x: 1820,
      y: 860,
      w: 820,
      kicker: "CHECK-INS",
      title: "Checkpoint timeline",
      events: data.checkpoints.slice(0, 12).map((cp) => ({
        at: `+${formatDuration(cp.ts - t0)}`,
        label: truncate(cp.summary, 110),
        kicker: cp.deviations.length ? `⚠ ${cp.deviations.length} deviation(s)` : undefined,
      })),
    });
    scenes.push({
      id: "s-timeline",
      focusNodeId: "timeline",
      narration: {
        ttsText: `${data.checkpoints.length} check-ins were recorded during the run.`,
        captionMd: `${data.checkpoints.length} mid-run check-ins`,
      },
    });
  }

  // ── Screenshot gallery grid ──
  const gallery = data.shots.filter((s) => s.dataUrl).slice(0, 12);
  gallery.forEach((shot, i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const badge = shot.viewport
      ? shot.viewport === "mobile"
        ? "MOBILE · 375×812"
        : "DESKTOP · 1440×900"
      : "SCREENSHOT";
    nodes.push({
      id: `shot-${i}`,
      kind: "image",
      x: 240 + col * 740,
      y: 1720 + row * 640,
      w: 680,
      kicker: badge,
      title: truncate(shot.step, 60),
      imageUrl: shot.dataUrl!,
      alt: shot.file,
    });
  });
  if (gallery.length) {
    scenes.push({
      id: "s-shots",
      focusNodeId: "shot-0",
      narration: {
        ttsText: `${gallery.length} screenshots were captured across the contract viewports.`,
        captionMd: `**${gallery.length}** screenshots`,
      },
    });
  }

  return {
    title: `Work Review — ${truncate(data.label, 80)}`,
    world: { w: 4800, h: 1720 + Math.max(1, Math.ceil(gallery.length / 3)) * 640 + 800 },
    nodes,
    links: [
      ["header", "verdict"],
      ...(data.steps.length ? ([["verdict", "steps"]] as const) : []),
      ...(data.checkpoints.length && data.steps.length
        ? ([["steps", "timeline"]] as const)
        : []),
    ] as InfiniteCanvasWalkthroughMedia["links"],
    scenes,
    autoAdvance: true,
  };
}
