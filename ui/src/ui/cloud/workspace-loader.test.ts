import { describe, expect, it } from "vitest";
import {
  COMPACT_MAX_MS,
  EXPECTED_MS,
  FINDING_TO_WAKING_MS,
  PROVISION_ATTACH_AFTER_MS,
  PROVISION_BOOT_AFTER_MS,
  READY_EXIT_MS,
  SLOW_FACTOR,
  WAKE_409_GRACE_MS,
  deriveLoaderView,
  formatElapsed,
  initialLoaderState,
  reduceLoader,
  type LoaderState,
  type WorkspaceSignal,
} from "./workspace-loader-model";

/** Run [atMs, signal] pairs through the reducer; returns the final state. */
function play(events: Array<[number, WorkspaceSignal]>, opts: { knownWorkspace?: boolean } = {}): LoaderState {
  let s = initialLoaderState(0, opts);
  for (const [at, signal] of events) s = reduceLoader(s, signal, at);
  return s;
}
const tick: WorkspaceSignal = { type: "tick" };
const up: WorkspaceSignal = { type: "socket", connected: true, reconnecting: false };
const stepStates = (s: LoaderState, now: number) =>
  Object.fromEntries(deriveLoaderView(s, now).steps.map((x) => [x.label, x.state]));

describe("workspace loader: phases from real signals", () => {
  it("renders nothing before the first signal", () => {
    expect(deriveLoaderView(initialLoaderState(0), 5_000).variant).toBe("hidden");
  });

  it("sign-in, then finding once the Clerk gate resolves", () => {
    const s = play([[0, { type: "auth-start" }], [400, tick]]);
    const v = deriveLoaderView(s, 400);
    expect(v.variant).toBe("full");
    expect(v.headline).toBe("Signing you in");
    expect(reduceLoader(s, { type: "auth-done" }, 900).phase).toBe("finding");
  });

  it("a warm workspace that answers fast never flashes the loader", () => {
    const s = play([
      [0, { type: "resolve-start" }],
      [120, { type: "resolve-ready" }],
      [200, up],
      [240, { type: "data-ready" }],
    ]);
    expect(s.phase).toBe("ready");
    expect(s.everReady).toBe(true);
    expect(deriveLoaderView(s, 250).variant).toBe("hidden");
    expect(deriveLoaderView(s, 2_000).variant).toBe("hidden");
  });

  it("a resolve the orchestrator holds open becomes 'waking'", () => {
    const s = play([[0, { type: "resolve-start" }], [FINDING_TO_WAKING_MS - 100, tick]]);
    expect(s.phase).toBe("finding");
    const woke = reduceLoader(s, tick, FINDING_TO_WAKING_MS);
    expect(woke.phase).toBe("waking");
    const v = deriveLoaderView(woke, FINDING_TO_WAKING_MS);
    expect(v.headline).toBe("Waking your workspace");
    expect(v.expectation).toBe("Usually takes 5 to 15 seconds");
    expect(stepStates(woke, FINDING_TO_WAKING_MS)).toMatchObject({
      "Find your workspace": "done",
      "Wake your workspace": "current",
      "Start InfiniBot": "pending",
    });
  });

  it("409 in a browser with no known workspace is the first-run build", () => {
    const s = play([
      [0, { type: "resolve-start" }],
      [300, tick],
      [350, { type: "resolve-pending", provisioning: true }],
    ]);
    expect(s.phase).toBe("provisioning");
    expect(s.firstRun).toBe(true);
    const v = deriveLoaderView(s, 400);
    expect(v.eyebrow).toBe("Welcome to InfiniBot Cloud");
    expect(v.headline).toBe("Building your private InfiniBot");
    expect(v.explanation).toContain("This happens once");
    expect(v.expectation).toBe("Usually takes about 2 minutes");
  });

  it("provisioning sub-steps advance with polling time, in the usual order", () => {
    const s = play([[0, { type: "resolve-start" }], [300, tick], [350, { type: "resolve-pending", provisioning: true }]]);
    expect(stepStates(s, 1_000)).toMatchObject({
      "Reserve your machine": "current",
      "Attach storage": "pending",
      "Boot your machine": "pending",
    });
    expect(stepStates(s, 350 + PROVISION_ATTACH_AFTER_MS)).toMatchObject({
      "Reserve your machine": "done",
      "Attach storage": "current",
    });
    expect(stepStates(s, 350 + PROVISION_BOOT_AFTER_MS)).toMatchObject({
      "Attach storage": "done",
      "Boot your machine": "current",
      "Start InfiniBot": "pending",
    });
  });

  it("409 in a known workspace reads as a wake, then as a rebuild if it lasts", () => {
    let s = play(
      [[0, { type: "resolve-start" }], [300, tick], [400, { type: "resolve-pending", provisioning: true }]],
      { knownWorkspace: true },
    );
    expect(s.phase).toBe("waking");
    expect(s.firstRun).toBe(false);
    s = reduceLoader(s, { type: "resolve-pending", provisioning: true }, 400 + WAKE_409_GRACE_MS);
    expect(s.phase).toBe("provisioning");
    const v = deriveLoaderView(s, 400 + WAKE_409_GRACE_MS);
    expect(v.headline).toBe("Setting up your private machine");
    expect(v.eyebrow).toBe("InfiniBot Cloud");
    expect(v.steps.map((x) => x.label)).not.toContain("Wake your workspace");
  });

  it("the reveal timer's non-provisioning signal changes nothing", () => {
    const s = play([[0, { type: "resolve-start" }], [300, { type: "resolve-pending", provisioning: false }]]);
    expect(s.phase).toBe("finding");
  });

  it("starting → loading → ready follows the socket, first data and the onboarding gate", () => {
    let s = play([[0, { type: "resolve-start" }], [3_000, tick], [6_000, { type: "resolve-ready" }]]);
    expect(deriveLoaderView(s, 6_000).headline).toBe("Starting InfiniBot");
    s = reduceLoader(s, up, 9_000);
    expect(deriveLoaderView(s, 9_000).headline).toBe("Loading your agents and plugins");
    s = reduceLoader(s, { type: "gate", loading: true }, 9_100);
    s = reduceLoader(s, { type: "data-ready" }, 9_500);
    expect(s.phase).toBe("loading");
    s = reduceLoader(s, { type: "gate", loading: false }, 10_000);
    expect(s.phase).toBe("ready");
    const v = deriveLoaderView(s, 10_100);
    expect(v.exiting).toBe(true);
    expect(v.headline).toBe("Ready");
    expect(v.steps.every((x) => x.state === "done")).toBe(true);
    expect(reduceLoader(s, tick, 10_000 + READY_EXIT_MS).active).toBe(false);
  });
});

describe("workspace loader: slow and error states", () => {
  it("slow after 1.5x the expected time, with a reload retry and a detail", () => {
    const s = play([[0, { type: "resolve-start" }], [FINDING_TO_WAKING_MS, tick]]);
    const edge = FINDING_TO_WAKING_MS + EXPECTED_MS.waking * SLOW_FACTOR;
    expect(deriveLoaderView(s, edge - 10).slow).toBe(false);
    const v = deriveLoaderView(s, edge + 10);
    expect(v.slow).toBe(true);
    expect(v.tone).toBe("slow");
    expect(v.actions).toEqual([{ id: "reload", label: "Retry", primary: true }]);
    expect(v.detail).toBeTruthy();
    expect(v.announce).toContain("Taking longer than usual");
  });

  it("first-run provisioning is not slow at 2 minutes, is at 3", () => {
    const s = play([[0, { type: "resolve-start" }], [300, tick], [300, { type: "resolve-pending", provisioning: true }]]);
    expect(deriveLoaderView(s, 300 + 120_000).slow).toBe(false);
    expect(deriveLoaderView(s, 300 + 181_000).slow).toBe(true);
  });

  it("402 is the upgrade screen with a plans link", () => {
    const s = play([
      [0, { type: "resolve-start" }],
      [200, { type: "resolve-failed", message: "The workspace service answered 402.", status: 402, plan: "free" }],
    ]);
    const v = deriveLoaderView(s, 210);
    expect(v.variant).toBe("full");
    expect(v.tone).toBe("upgrade");
    expect(v.actions.map((a) => a.id)).toEqual(["plans", "retry"]);
    expect(v.steps).toEqual([]);
  });

  it("5xx shows the message, a retry and the status in the detail", () => {
    const s = play([
      [0, { type: "resolve-start" }],
      [200, { type: "resolve-failed", message: "The workspace service answered 500.", status: 500 }],
    ]);
    const v = deriveLoaderView(s, 210);
    expect(v.tone).toBe("error");
    expect(v.headline).toBe("We couldn't start your workspace");
    expect(v.explanation).toBe("The workspace service answered 500.");
    expect(v.detail).toContain("500");
    expect(v.actions).toEqual([{ id: "retry", label: "Retry", primary: true }]);
  });

  it("a network failure and offline get their own headlines", () => {
    let s = play([[0, { type: "resolve-start" }], [200, { type: "resolve-failed", message: "x", status: 0 }]]);
    expect(deriveLoaderView(s, 210).headline).toBe("Can't reach InfiniBot Cloud");
    s = reduceLoader(s, { type: "online", online: false }, 300);
    const v = deriveLoaderView(s, 310);
    expect(v.headline).toBe("You're offline");
    expect(v.offline).toBe(true);
  });

  it("retry after an error restarts the run and clears the problem", () => {
    const s = play([
      [0, { type: "resolve-start" }],
      [200, { type: "resolve-failed", message: "x", status: 500 }],
      [9_000, { type: "resolve-start" }],
    ]);
    expect(s.problem).toBeNull();
    expect(s.phase).toBe("finding");
    expect(s.startedAt).toBe(9_000);
  });

  it("401 after a fresh token asks to sign in again", () => {
    const s = play([[0, { type: "resolve-start" }], [200, { type: "signin-required" }]]);
    const v = deriveLoaderView(s, 210);
    expect(v.tone).toBe("signin");
    expect(v.actions).toEqual([{ id: "signin", label: "Sign in", primary: true }]);
  });
});

describe("workspace loader: same-tab reconnect and wake", () => {
  const ready = (): LoaderState =>
    play([[0, { type: "resolve-start" }], [100, { type: "resolve-ready" }], [200, up], [300, { type: "data-ready" }], [2_000, tick]]);

  it("a socket drop that is reconnecting shows the compact bar, then full screen after 10 s", () => {
    let s = reduceLoader(ready(), { type: "socket", connected: false, reconnecting: true }, 50_000);
    expect(s.reason).toBe("reconnect");
    s = reduceLoader(s, tick, 50_500);
    const compact = deriveLoaderView(s, 50_500);
    expect(compact.variant).toBe("compact");
    expect(compact.headline).toBe("Reconnecting to your workspace");
    expect(deriveLoaderView(s, 50_000 + COMPACT_MAX_MS + 1).variant).toBe("full");
    expect(deriveLoaderView(s, 50_000 + COMPACT_MAX_MS + 1).steps.map((x) => x.label)).toEqual([
      "Reconnect to InfiniBot",
      "Load your agents and plugins",
    ]);
  });

  it("reconnects, reloads data and dismisses itself", () => {
    let s = reduceLoader(ready(), { type: "socket", connected: false, reconnecting: true }, 50_000);
    s = reduceLoader(s, tick, 50_400);
    s = reduceLoader(s, up, 52_000);
    expect(s.phase).toBe("loading");
    s = reduceLoader(s, { type: "data-ready" }, 52_300);
    expect(s.phase).toBe("ready");
    expect(reduceLoader(s, tick, 52_300 + READY_EXIT_MS).active).toBe(false);
  });

  it("a drop with nothing reconnecting (the workspace is asleep) stays out of the way", () => {
    const s = reduceLoader(ready(), { type: "socket", connected: false, reconnecting: false }, 50_000);
    expect(s.active).toBe(false);
    expect(deriveLoaderView(s, 51_000).variant).toBe("hidden");
  });

  it("showWorkspaceLoader({phase:'waking', reason:'sleep'}) then the resolve signals", () => {
    let s = reduceLoader(ready(), { type: "socket", connected: false, reconnecting: false }, 50_000);
    s = reduceLoader(s, { type: "show", phase: "waking", reason: "sleep" }, 60_000);
    s = reduceLoader(s, { type: "resolve-start" }, 60_010);
    s = reduceLoader(s, tick, 60_400);
    const v = deriveLoaderView(s, 60_400);
    expect(v.variant).toBe("compact");
    expect(v.headline).toBe("Waking your workspace");
    expect(s.reason).toBe("sleep");
    expect(s.startedAt).toBe(60_000);
    expect(deriveLoaderView(s, 60_000 + COMPACT_MAX_MS + 1).explanation).toContain("went to sleep");
    s = reduceLoader(s, { type: "resolve-ready" }, 64_000);
    expect(s.phase).toBe("starting");
    s = reduceLoader(s, up, 65_000);
    s = reduceLoader(s, { type: "data-ready" }, 65_200);
    expect(s.phase).toBe("ready");
  });

  it("variant can be pinned, and hide dismisses at once", () => {
    let s = reduceLoader(ready(), { type: "show", phase: "waking", reason: "sleep", variant: "full" }, 60_000);
    expect(deriveLoaderView(s, 60_001).variant).toBe("full");
    s = reduceLoader(s, { type: "hide" }, 60_100);
    expect(deriveLoaderView(s, 60_200).variant).toBe("hidden");
  });
});

describe("workspace loader: copy rules", () => {
  it("never shows a percentage and has no emoji", () => {
    const states: LoaderState[] = [
      play([[0, { type: "auth-start" }], [400, tick]]),
      play([[0, { type: "resolve-start" }], [400, tick]]),
      play([[0, { type: "resolve-start" }], [3_000, tick]]),
      play([[0, { type: "resolve-start" }], [400, tick], [500, { type: "resolve-pending", provisioning: true }]]),
      play([[0, { type: "resolve-start" }], [400, tick], [500, { type: "resolve-ready" }]]),
      play([[0, { type: "resolve-start" }], [400, tick], [500, { type: "resolve-ready" }], [600, up]]),
    ];
    for (const s of states) {
      for (const at of [1_000, 400_000]) {
        const v = deriveLoaderView(s, at);
        const text = [v.eyebrow, v.headline, v.explanation, v.expectation, v.detail, v.announce, ...v.steps.map((x) => x.label)].join(" ");
        expect(text).not.toMatch(/%/);
        expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
      }
    }
  });

  it("formats elapsed time", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(59_900)).toBe("59s");
    expect(formatElapsed(125_000)).toBe("2m 05s");
  });
});

describe("workspace loader: a plan without a private gateway", () => {
  // main.ts starts the loader at sign-in for everyone. A serverless (free) member
  // never resolves a gateway: with no signal at all the loader would drift to
  // "Waking your workspace" and cover the setup steps for good. The setup gate
  // (cloud-setup.ts) hides it as soon as it keeps the page.
  it("left alone it sits on 'waking' forever; 'hide' takes it down and ticks never bring it back", () => {
    const stuck = play([
      [0, { type: "auth-start" }],
      [300, { type: "auth-done" }],
      [300 + FINDING_TO_WAKING_MS, tick],
      [60_000, tick],
    ]);
    expect(stuck.phase).toBe("waking");
    expect(deriveLoaderView(stuck, 60_000).variant).toBe("full");

    let s = reduceLoader(stuck, { type: "hide" }, 60_100);
    expect(deriveLoaderView(s, 60_100).variant).toBe("hidden");
    s = reduceLoader(s, tick, 120_000);
    expect(deriveLoaderView(s, 120_000).variant).toBe("hidden");
  });

  it("'Continue to workspace' after the hide starts a fresh run", () => {
    const s = play([
      [0, { type: "auth-start" }],
      [300, { type: "auth-done" }],
      [900, { type: "hide" }],
      [5_000, { type: "resolve-start" }],
      [9_000, tick],
    ]);
    expect(s.active).toBe(true);
    expect(deriveLoaderView(s, 9_000).variant).toBe("full");
  });
});
