import { describe, expect, it, vi } from "vitest";
import {
  channelsExcludedOf,
  cloudSetupView,
  describeSetupError,
  gateActionFor,
  gatePhaseFor,
  isOnboardingUnsupported,
  isServerlessPlan,
  SetupTimeoutError,
  withTimeout,
  type CloudSetupState,
} from "./saas-setup-state";

const base: CloudSetupState = { loading: false, error: null, me: null, status: null, viewReady: false };

describe("cloudSetupView (never an empty page)", () => {
  it("shows the loading state until the account is known", () => {
    expect(cloudSetupView({ ...base, loading: true })).toBe("loading");
    expect(cloudSetupView(base)).toBe("loading");
  });

  it("shows an error with Retry when a read fails, even mid-load", () => {
    expect(cloudSetupView({ ...base, error: new Error("boom") })).toBe("error");
    expect(cloudSetupView({ ...base, loading: true, error: "x" })).toBe("error");
  });

  it("hands a member with a private gateway to the fleet flow", () => {
    for (const plan of ["starter", "pro", "business", "scale", "ceo"]) {
      expect(cloudSetupView({ ...base, me: { plan } })).toBe("workspace");
    }
  });

  it("gives a free (serverless) member the steps, never the fleet flow", () => {
    const me = { plan: "free" };
    expect(cloudSetupView({ ...base, me })).toBe("loading"); // status still in flight
    expect(cloudSetupView({ ...base, me, status: { required: true } })).toBe("loading"); // view chunk loading
    expect(cloudSetupView({ ...base, me, status: { required: true }, viewReady: true })).toBe("steps");
  });

  it("shows the hosted-plans screen once a free member is set up", () => {
    expect(cloudSetupView({ ...base, me: { plan: "free" }, status: { required: false } })).toBe("hosted-plans");
  });

  it("covers every combination with a concrete view", () => {
    const views = new Set(["loading", "error", "steps", "hosted-plans", "workspace"]);
    for (const loading of [true, false])
      for (const error of [null, new Error("e")])
        for (const me of [null, { plan: "free" }, { plan: "starter" }, { plan: "" }])
          for (const status of [null, { required: true }, { required: false }])
            for (const viewReady of [true, false])
              expect(views.has(cloudSetupView({ loading, error, me, status, viewReady }))).toBe(true);
  });
});

describe("isServerlessPlan", () => {
  it("is true only for plans the orchestrator gives no gateway", () => {
    expect(isServerlessPlan({ plan: "free" })).toBe(true);
    expect(isServerlessPlan({ plan: " Free " })).toBe(true);
    expect(isServerlessPlan({ plan: "starter" })).toBe(false);
    // Hosted Free (users-schema v7): a daily hour on its own Machine, not serverless.
    expect(isServerlessPlan({ plan: "free", dailyUsage: { limited: true } })).toBe(false);
    expect(isServerlessPlan({ plan: "free", dailyUsage: null })).toBe(true);
  });

  it("treats an unknown plan as gateway-backed (the fleet flow has its own states)", () => {
    expect(isServerlessPlan(null)).toBe(false);
    expect(isServerlessPlan({})).toBe(false);
    expect(isServerlessPlan({ plan: null })).toBe(false);
  });
});

describe("gateway gate phase", () => {
  it("requires setup only when the gateway says so", () => {
    expect(gatePhaseFor({ status: { required: true } })).toBe("required");
    expect(gatePhaseFor({ status: { required: false } })).toBe("done");
    expect(gatePhaseFor({ status: null })).toBe("done");
  });

  it("fails open only for a gateway without onboarding", () => {
    expect(gatePhaseFor({ error: new Error("unknown method: saas.onboarding.status") })).toBe("done");
    expect(isOnboardingUnsupported({ status: 501, message: "x" })).toBe(true);
  });

  it("shows a retryable error for timeouts and transient failures", () => {
    expect(gatePhaseFor({ error: new SetupTimeoutError("Your workspace", 15_000) })).toBe("error");
    expect(gatePhaseFor({ error: new Error("gateway not connected") })).toBe("error");
    expect(gatePhaseFor({ error: new Error("request timeout") })).toBe("error");
  });
});

describe("withTimeout", () => {
  it("passes a settled value through", async () => {
    await expect(withTimeout(Promise.resolve(7), 50, "x")).resolves.toBe(7);
    await expect(withTimeout(Promise.reject(new Error("no")), 50, "x")).rejects.toThrow("no");
  });

  it("rejects a read that never answers, so the page can't wait forever", async () => {
    vi.useFakeTimers();
    try {
      const p = withTimeout(new Promise(() => {}), 15_000, "Your workspace");
      const caught = p.catch((e) => e);
      await vi.advanceTimersByTimeAsync(15_000);
      const err = await caught;
      expect(err).toBeInstanceOf(SetupTimeoutError);
      expect(describeSetupError(err)).toBe("Your workspace didn't answer within 15s.");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("describeSetupError", () => {
  it("turns a network failure into something a member can act on", () => {
    expect(describeSetupError(new TypeError("Failed to fetch"))).toMatch(/Check your connection/);
    expect(describeSetupError(new Error(""))).toMatch(/Check your connection/);
  });

  it("keeps a server message but never lets it run away", () => {
    expect(describeSetupError(new Error("The workspace database is unavailable."))).toBe(
      "The workspace database is unavailable.",
    );
    expect(describeSetupError(new Error("x".repeat(500))).length).toBeLessThanOrEqual(221);
  });
});

describe("gateActionFor (hosted gateway: the steps survive a dropped socket)", () => {
  const at = (o: Partial<Parameters<typeof gateActionFor>[0]>) =>
    gateActionFor({ connected: true, hasClient: true, phase: null, sameClient: false, ...o });

  it("before the first connect there is nothing to gate", () => {
    expect(at({ connected: false })).toBe("app");
    expect(at({ hasClient: false })).toBe("app");
  });

  it("reads the status as soon as the socket is connected", () => {
    expect(at({})).toBe("load");
  });

  it("keeps the boot screen while the status is in flight, also if the socket drops", () => {
    expect(at({ phase: "loading", sameClient: true })).toBe("show");
    expect(at({ phase: "loading", sameClient: true, connected: false })).toBe("show");
  });

  it("setup required: the steps stay up while the gateway sleeps, restarts or reconnects", () => {
    expect(at({ phase: "required", sameClient: true })).toBe("show");
    expect(at({ phase: "required", sameClient: true, connected: false })).toBe("show");
    expect(at({ phase: "required", sameClient: false, connected: false })).toBe("show");
  });

  it("setup required and the app made a new socket: same steps, new client (no reload of the gate)", () => {
    expect(at({ phase: "required", sameClient: false })).toBe("rebind");
  });

  it("an error stays on screen with Retry; one caused by a dropped socket re-reads once it is back", () => {
    expect(at({ phase: "error", sameClient: true })).toBe("show");
    expect(at({ phase: "error", sameClient: true, connected: false, failedOffline: true })).toBe("show");
    expect(at({ phase: "error", sameClient: true, failedOffline: true })).toBe("load");
    expect(at({ phase: "error", sameClient: false })).toBe("load");
  });

  it("setup done: the app renders, and a new socket is checked again", () => {
    expect(at({ phase: "done", sameClient: true })).toBe("app");
    expect(at({ phase: "done", sameClient: true, connected: false })).toBe("app");
    expect(at({ phase: "done", sameClient: false })).toBe("load");
  });
});

describe("channelsExcludedOf (GET /api/me)", () => {
  it("defaults to [] for older servers and paid plans", () => {
    expect(channelsExcludedOf(null)).toEqual([]);
    expect(channelsExcludedOf({ plan: "pro" })).toEqual([]);
    expect(channelsExcludedOf({ plan: "pro", channelsExcluded: [] })).toEqual([]);
  });
  it("passes the Free list through, lowercased", () => {
    expect(channelsExcludedOf({ plan: "free", channelsExcluded: ["Telegram", "slack"] })).toEqual(["telegram", "slack"]);
  });
});
