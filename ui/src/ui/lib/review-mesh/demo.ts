/**
 * ?reviewDemo=1 — synthetic review traffic for visual verification without a
 * backend. Loops a live thread (submission → challenge → reviewer action →
 * response → VERIFIED), a second worker that gets a failing challenge, one
 * escalated thread waiting on the owner, and a handful of gallery screenshots
 * (inline SVG data URLs, so nothing is fetched).
 *
 * Demo-only. Nothing here runs unless the URL carries reviewDemo=1.
 */

import type { ReviewFeed } from "./feed";
import type { CompletionRecordLite } from "./completed";
import type { ReviewMessage, ReviewThreadSummary, ScreenshotEntry } from "./types";

const W1 = "agent:main:subagent:demo-ui-fix";
const W2 = "agent:main:subagent:demo-api-tests";
const W3 = "agent:main:subagent:demo-db-migrate";

type Step = Omit<ReviewMessage, "id" | "seq" | "runId" | "ts" | "round" | "attempt" | "fromAgent" | "toAgent"> & { at: number };

function shotSvg(label: string, route: string, vp: string, pass: boolean, variant = 0, bg = "#0b0d14"): string {
  const accent = pass ? "#22c55e" : "#ef4444";
  const bars = [0, 1, 2, 3]
    .map((i) => `<rect x="${24 + i * 70}" y="${70 + ((i + variant) % 3) * 8}" width="56" height="${40 + ((i * 13 + variant * 7) % 30)}" rx="4" fill="${i % 2 ? "#d4af37" : "#3b82f6"}" opacity="0.8"/>`)
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200"><rect width="320" height="200" fill="${bg}"/><rect x="0" y="0" width="320" height="26" fill="#151824"/><circle cx="14" cy="13" r="4" fill="#ef4444"/><circle cx="28" cy="13" r="4" fill="#f59e0b"/><circle cx="42" cy="13" r="4" fill="#22c55e"/><text x="60" y="17" font-family="monospace" font-size="10" fill="#9aa2b1">${route} · ${vp}</text><text x="24" y="54" font-family="sans-serif" font-size="14" fill="#e8e6e3">${label}</text>${bars}<rect x="24" y="150" width="272" height="26" rx="5" fill="none" stroke="${accent}" stroke-width="2"/><text x="34" y="167" font-family="monospace" font-size="10" fill="${accent}">${pass ? "layout ok" : "overflow at 390px"}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function demoScreenshots(now = Date.now()): ScreenshotEntry[] {
  const rows: Array<[string, string, string, string, boolean, string, boolean]> = [
    ["demo-review-ui-1", "Mesh review panel", "/mesh", "1440x900", true, "dark", true],
    ["demo-review-ui-1", "Mesh review panel", "/mesh", "390x844", true, "dark", false],
    ["demo-review-ui-1", "Mesh review panel", "/mesh", "1440x900", true, "light", false],
    ["demo-review-api-1", "Reports table", "/reports", "1440x900", false, "dark", true],
    ["demo-review-api-1", "Reports table", "/reports", "390x844", false, "dark", false],
    ["demo-review-esc", "Billing settings", "/settings/billing", "1440x900", true, "dark", false],
    ["demo-review-esc", "Billing settings", "/settings/billing", "390x844", false, "light", false],
    ["demo-review-old", "Chat sidebar", "/chat", "1440x900", true, "dark", false],
  ];
  return rows.map(([runId, label, route, vp, pass, theme, baseline], i) => {
    const url = shotSvg(label, route, vp, pass, i);
    return {
      id: `demo-shot-${i}`,
      path: `/demo/${runId}/${i}.png`,
      url,
      thumbUrl: url,
      runId,
      label,
      agent: runId === "demo-review-api-1" ? W2 : runId === "demo-review-esc" ? W3 : W1,
      route,
      viewport: vp,
      theme,
      ts: now - i * 95_000,
      verdict: pass ? "pass" : "fail",
      runState: pass ? "verified" : "unverified",
      runVerdict: pass ? "VERIFIED" : "UNVERIFIED",
      visualDir: null,
      assessment: {
        pass,
        summary: pass ? "Layout matches the expectation; no clipped text." : "Table overflows horizontally at 390px; last column clipped.",
        issues: pass ? [] : ["Horizontal overflow on .reports-table", "Action buttons below 44px tap size"],
      },
      baselinePath: baseline ? `/demo/${runId}/baseline.png` : null,
      // Visibly different "before" so the compare slider reads in demo screenshots.
      baselineUrl: baseline ? shotSvg(`${label} (before)`, route, vp, !pass, i + 5, "#1a1030") : null,
      source: "visual_verify",
    } satisfies ScreenshotEntry;
  });
}

export function demoCompleted(now = Date.now()): CompletionRecordLite[] {
  const mk = (
    runId: string,
    label: string,
    state: string,
    agoMin: number,
    durMin: number,
    summary: string,
    files: number,
    commits: number,
    open: string[] = [],
  ): CompletionRecordLite => ({
    runId,
    childSessionKey: `agent:main:subagent:${runId}`,
    requesterSessionKey: "agent:main:main",
    label,
    backend: "claude-code",
    startedAt: now - (agoMin + durMin) * 60_000,
    terminalAt: now - agoMin * 60_000,
    updatedAt: now - agoMin * 60_000,
    state,
    attempts: [{}],
    result: {
      summary,
      commits: Array.from({ length: commits }, (_, i) => `c0ffee${i}`),
      files_changed: Array.from({ length: files }, (_, i) => `ui/src/file-${i}.ts`),
      open_issues: open,
    },
    review: { verdict: state === "verified" ? "VERIFIED" : state === "failed" ? "FAILED" : "UNVERIFIED" },
  });
  return [
    mk("demo-review-ui-1", "Mesh review panel (UI)", "verified", 2, 9, "Review panel, packets and gallery on /mesh; deployed live after restart.", 7, 2),
    mk("demo-review-esc", "Billing table migration", "needs_owner", 3, 6, "Migration ready; dropping the legacy table needs the owner.", 3, 1),
    mk("demo-review-api-1", "Reports table tests", "unverified", 6, 12, "Snapshot updated and overflow fixed; merged into release branch.", 4, 1, ["Buttons still 32px on mobile"]),
    mk("demo-done-docs", "Docs: plugin standard", "verified", 38, 14, "Plugin standard docs rewritten. Not deployed yet.", 5, 1),
    mk("demo-done-flaky", "Flaky e2e retry", "failed", 74, 21, "Could not reproduce the flake; tests still time out.", 1, 0),
    mk("demo-done-voice", "Voice wake word tweak", "verified", 190, 8, "Lower wake threshold; gateway restart pending.", 2, 1, ["Gateway restart pending"]),
  ];
}

function liveScript(): Step[] {
  return [
    {
      at: 400,
      from: "worker",
      to: "reviewer",
      kind: "submission",
      title: "RESULT: review panel + packets on the mesh",
      text: "Implemented the review layer on /mesh. Build passes, unit tests green, screenshots attached.",
      evidence: [
        { kind: "command", ref: "pnpm -C ui build", status: "pass", cwd: "ui" },
        { kind: "command", ref: "vitest run review-mesh", status: "pass" },
        { kind: "screenshot", ref: "/demo/demo-review-ui-1/0.png", status: "pass" },
      ],
      screenshots: ["/demo/demo-review-ui-1/0.png"],
    },
    {
      at: 3000,
      from: "reviewer",
      to: "worker",
      kind: "challenge",
      title: "Show the mobile layout and re-run tests in ui/",
      text: "Desktop looks right. I need the 390px layout and the test run from the ui/ package root.",
      items: ["Screenshot /mesh at 390x844", "Run vitest from ui/ (record cwd)"],
      evidence: [{ kind: "screenshot", ref: "mobile", status: "warn", detail: "missing" }],
    },
    {
      at: 3500,
      from: "reviewer",
      to: "reviewer",
      kind: "action",
      title: "Re-ran the build in ui/ myself",
      text: "Re-ran the build in the right cwd.",
      actions: [{ kind: "rerun", detail: "pnpm -C ui build", status: "pass", cwd: "ui" }],
    },
    {
      at: 5900,
      from: "worker",
      to: "reviewer",
      kind: "response",
      title: "Mobile screenshot + tests from ui/",
      text: "Added the 390px screenshot; tests re-run from ui/ (cwd recorded).",
      evidence: [
        { kind: "screenshot", ref: "/demo/demo-review-ui-1/1.png", status: "pass" },
        { kind: "command", ref: "vitest run", status: "pass", cwd: "ui" },
      ],
      screenshots: ["/demo/demo-review-ui-1/1.png"],
    },
    {
      at: 8400,
      from: "reviewer",
      to: "worker",
      kind: "verdict",
      verdict: "VERIFIED",
      title: "VERIFIED: desktop + mobile checked",
      text: "Both viewports render, tests pass in the right cwd. Verified.",
      evidence: [{ kind: "visual", ref: "2 screenshots", status: "pass" }],
    },
  ];
}

function failingScript(): Step[] {
  return [
    {
      at: 1500,
      from: "worker",
      to: "reviewer",
      kind: "submission",
      title: "RESULT: reports table API tests",
      text: "Tests added for the reports endpoint.",
      evidence: [{ kind: "command", ref: "pnpm test reports", status: "pass" }],
    },
    {
      at: 4300,
      from: "reviewer",
      to: "worker",
      kind: "challenge",
      title: "2 checks failed when I re-ran them",
      text: "Re-running in the package root fails: snapshot drift and a 390px overflow.",
      items: ["Fix snapshot drift in reports.test.ts", "Fix horizontal overflow at 390px"],
      evidence: [
        { kind: "command", ref: "pnpm test reports", status: "fail", detail: "1 snapshot obsolete", cwd: "." },
        { kind: "screenshot", ref: "/demo/demo-review-api-1/4.png", status: "fail" },
      ],
      screenshots: ["/demo/demo-review-api-1/4.png"],
    },
    {
      at: 7200,
      from: "worker",
      to: "reviewer",
      kind: "response",
      title: "Snapshot updated, overflow fixed",
      text: "Updated the snapshot and wrapped the table in a scroller.",
      evidence: [{ kind: "command", ref: "pnpm test reports", status: "pass" }],
    },
    {
      at: 9800,
      from: "reviewer",
      to: "worker",
      kind: "verdict",
      verdict: "changes_needed",
      title: "Changes needed: buttons still under 44px",
      text: "Overflow is fixed but the action buttons are still 32px tall on mobile.",
      items: ["Raise action buttons to 44px on touch"],
    },
  ];
}

function escalatedThread(now: number): ReviewMessage[] {
  const base = { runId: "demo-review-esc", round: 1, attempt: 1 } as const;
  return [
    {
      ...base,
      id: "demo-review-esc#1",
      seq: 1,
      ts: now - 4 * 60_000,
      from: "worker",
      to: "reviewer",
      fromAgent: W3,
      toAgent: "auditor",
      kind: "submission",
      title: "RESULT: billing migration ready",
      text: "Migration drops the legacy invoices table after copying rows.",
      evidence: [{ kind: "command", ref: "pnpm db:migrate --dry-run", status: "pass" }],
    },
    {
      ...base,
      id: "demo-review-esc#2",
      seq: 2,
      ts: now - 3 * 60_000,
      from: "reviewer",
      to: "worker",
      fromAgent: "auditor",
      toAgent: W3,
      kind: "verdict",
      verdict: "escalate",
      title: "Escalated: destructive migration needs the owner",
      text: "The change drops a production table. I will not approve that on my own.",
      escalation: {
        category: "destructive",
        decision: "Approve dropping the legacy invoices table after the copy, or keep it read-only for 30 days?",
        reason: "Irreversible data change on production billing data.",
      },
    },
  ];
}

function summaryFor(runId: string, label: string, worker: string, now: number, extra: Partial<ReviewThreadSummary> = {}): ReviewThreadSummary {
  return {
    runId,
    label,
    workerAgent: worker,
    childSessionKey: worker,
    requesterSessionKey: "agent:main:main",
    backend: "claude-code",
    state: "running",
    verdict: null,
    rounds: 1,
    messageCount: 0,
    startedAt: now,
    lastTs: now,
    lastKind: null,
    lastTitle: "",
    escalated: false,
    screenshots: 0,
    ...extra,
  };
}

/**
 * Start the synthetic stream. Returns a stop function. `cycleMs` loops the
 * live threads so a screenshot at any moment catches packets in flight.
 */
export function startReviewDemo(feed: ReviewFeed, cycleMs = 12_500): () => void {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let cycle = 0;
  let stopped = false;
  const later = (ms: number, fn: () => void) => {
    const t = setTimeout(() => {
      timers.delete(t);
      if (!stopped) fn();
    }, ms);
    timers.add(t);
  };

  const now0 = Date.now();
  feed.ingestScreenshots(demoScreenshots(now0), false, true);
  feed.ingestCompleted(demoCompleted(now0), true);

  // Escalated thread lands shortly after mount (live so the marker appears).
  later(900, () => {
    const now = Date.now();
    const msgs = escalatedThread(now);
    for (let i = 0; i < msgs.length; i++) {
      later(i * 1200, () => {
        feed.ingest(
          {
            message: { ...msgs[i], ts: Date.now() },
            summary: summaryFor("demo-review-esc", "Billing table migration", W3, now, {
              state: i === msgs.length - 1 ? "needs_owner" : "running",
              verdict: i === msgs.length - 1 ? "escalate" : null,
              escalated: i === msgs.length - 1,
              ...(i === msgs.length - 1 ? { escalation: msgs[i].escalation } : {}),
              messageCount: i + 1,
              lastKind: msgs[i].kind,
              lastTitle: msgs[i].title,
              screenshots: 2,
            }),
          },
          true,
        );
      });
    }
  });

  const runScript = (runId: string, label: string, worker: string, steps: Step[]) => {
    const started = Date.now();
    let seq = 0;
    let round = 0;
    for (const s of steps) {
      later(s.at, () => {
        seq++;
        if (s.kind === "submission" || s.kind === "response") round++;
        const { at: _at, ...rest } = s;
        const msg: ReviewMessage = {
          ...rest,
          id: `${runId}#${seq}`,
          seq,
          runId,
          ts: Date.now(),
          round: Math.max(1, round),
          attempt: Math.max(1, round),
          fromAgent: s.from === "reviewer" ? "auditor" : worker,
          toAgent: s.to === "reviewer" ? "auditor" : worker,
        };
        const final = s.kind === "verdict";
        if (final) {
          const rec = demoCompleted(Date.now()).find((r) => runId.startsWith(r.runId.replace(/-1$/, "")));
          if (rec) {
            feed.ingestCompleted(
              [{ ...rec, runId, childSessionKey: worker, startedAt: started, terminalAt: Date.now(), updatedAt: Date.now(), state: s.verdict === "VERIFIED" ? "verified" : "unverified" }],
              true,
            );
          }
        }
        feed.ingest(
          {
            message: msg,
            summary: summaryFor(runId, label, worker, started, {
              state: final ? (s.verdict === "VERIFIED" ? "verified" : "unverified") : "running",
              verdict: final ? s.verdict ?? null : null,
              messageCount: seq,
              rounds: round,
              lastTs: msg.ts,
              lastKind: msg.kind,
              lastTitle: msg.title,
              screenshots: s.screenshots?.length ?? 0,
            }),
          },
          true,
        );
      });
    }
  };

  const loop = () => {
    cycle++;
    runScript(`demo-review-ui-${cycle}`, "Mesh review panel (UI)", W1, liveScript());
    runScript(`demo-review-api-${cycle}`, "Reports table tests", W2, failingScript());
    later(cycleMs, loop);
  };
  loop();

  return () => {
    stopped = true;
    for (const t of timers) clearTimeout(t);
    timers.clear();
  };
}
