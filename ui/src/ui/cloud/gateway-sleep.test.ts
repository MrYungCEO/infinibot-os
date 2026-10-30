import { beforeEach, describe, expect, it } from "vitest";
import {
  ACTIVITY_PING_MS,
  FLEET_SLEEP_CLOSE_CODE,
  INACTIVE_AFTER_MS,
  configureGatewaySleep,
  isGatewaySleeping,
  noteGatewayClosed,
  noteGatewayConnected,
  noteSleepAnnounced,
  noteUserInput,
  onSleepChange,
  requestWake,
  resetGatewaySleepForTest,
  setActivityPinger,
  setWakeHandler,
  sleepPhase,
} from "./gateway-sleep";
import { fairUseBannerModel } from "./fair-use-banner";
import { sleepNoticeModel } from "./sleep-notice";

let clock = 1_000_000;
let hidden = false;

beforeEach(() => {
  clock = 1_000_000;
  hidden = false;
  resetGatewaySleepForTest({ now: () => clock, hidden: () => hidden });
});

const wakePlan = () => configureGatewaySleep({ runMode: "wake", idleMinutes: 15 });

describe("gateway sleep: when a closed socket means 'asleep'", () => {
  it("close code 4010 on a wake plan: sleeping, and the client must not reconnect", () => {
    wakePlan();
    noteUserInput(); // even right after input: the gateway said so explicitly
    expect(noteGatewayClosed(FLEET_SLEEP_CLOSE_CODE)).toBe(true);
    expect(sleepPhase()).toBe("sleeping");
    expect(isGatewaySleeping()).toBe(true);
  });

  it("the fleet.sleep event alone is enough", () => {
    wakePlan();
    noteSleepAnnounced();
    expect(sleepPhase()).toBe("sleeping");
    expect(noteGatewayClosed(1006)).toBe(true); // the close that follows stays parked
  });

  it("an abnormal close while nobody is using the tab: sleeping (suspended by Fly / the reaper)", () => {
    wakePlan();
    noteUserInput();
    clock += INACTIVE_AFTER_MS + 1;
    expect(noteGatewayClosed(1006)).toBe(true);
  });

  it("a hidden tab never reconnects by itself", () => {
    wakePlan();
    noteUserInput();
    hidden = true;
    expect(noteGatewayClosed(1006)).toBe(true);
  });

  it("an abnormal close while the member IS using the tab reconnects as before", () => {
    wakePlan();
    noteUserInput();
    clock += 5_000;
    expect(noteGatewayClosed(1006)).toBe(false);
    expect(noteGatewayClosed(1012)).toBe(false); // service restart
    expect(sleepPhase()).toBe("awake");
  });

  it("a failed connect handshake (4008) is not sleep", () => {
    wakePlan();
    clock += INACTIVE_AFTER_MS * 10;
    expect(noteGatewayClosed(4008)).toBe(false);
  });

  it("always-on plans, local installs and unknown plans never enter the sleeping state", () => {
    configureGatewaySleep({ runMode: "always-on" });
    clock += INACTIVE_AFTER_MS * 10;
    expect(noteGatewayClosed(FLEET_SLEEP_CLOSE_CODE)).toBe(false);
    noteSleepAnnounced();
    expect(sleepPhase()).toBe("awake");
    configureGatewaySleep(null);
    expect(noteGatewayClosed(1006)).toBe(false);
  });
});

describe("gateway sleep: waking", () => {
  it("a click or key press wakes through the handler (resolve), exactly once", async () => {
    wakePlan();
    let wakes = 0;
    let release: (ok: boolean) => void = () => {};
    setWakeHandler(
      () =>
        new Promise<boolean>((r) => {
          wakes++;
          release = r;
        }),
    );
    const phases: string[] = [];
    onSleepChange((p) => phases.push(p));
    noteGatewayClosed(FLEET_SLEEP_CLOSE_CODE);

    noteUserInput(); // click
    noteUserInput(); // impatient second click
    noteUserInput();
    expect(sleepPhase()).toBe("waking");
    expect(isGatewaySleeping()).toBe(true); // sockets stay parked until the Machine is up
    expect(wakes).toBe(1);
    release(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(sleepPhase()).toBe("awake");
    expect(phases).toEqual(["sleeping", "waking", "awake"]);
  });

  it("no loop: with no interaction, nothing ever wakes it", async () => {
    wakePlan();
    let wakes = 0;
    setWakeHandler(async () => {
      wakes++;
      return true;
    });
    noteGatewayClosed(FLEET_SLEEP_CLOSE_CODE);
    // Every parked client that tries again is told to stay parked.
    for (let i = 0; i < 100; i++) {
      clock += 15_000;
      expect(noteGatewayClosed(1006)).toBe(true);
      expect(isGatewaySleeping()).toBe(true);
    }
    expect(wakes).toBe(0);
  });

  it("scrolling does not wake a sleeping workspace", () => {
    wakePlan();
    let wakes = 0;
    setWakeHandler(async () => {
      wakes++;
      return true;
    });
    noteGatewayClosed(FLEET_SLEEP_CLOSE_CODE);
    noteUserInput(false);
    expect(sleepPhase()).toBe("sleeping");
    expect(wakes).toBe(0);
  });

  it("a failed wake goes back to sleeping and waits for the next interaction", async () => {
    wakePlan();
    let attempt = 0;
    setWakeHandler(async () => {
      attempt++;
      if (attempt === 1) throw new Error("orchestrator unreachable");
      return true;
    });
    noteGatewayClosed(FLEET_SLEEP_CLOSE_CODE);
    expect(await requestWake()).toBe(false);
    expect(sleepPhase()).toBe("sleeping");
    expect(attempt).toBe(1); // it did not retry by itself
    expect(await requestWake()).toBe(true);
    expect(sleepPhase()).toBe("awake");
  });
});

describe("gateway sleep: reporting real input", () => {
  it("pings fleet.activity on input, at most once a minute, and never from a timer", () => {
    wakePlan();
    let pings = 0;
    setActivityPinger(() => pings++);
    for (let i = 0; i < 30; i++) {
      noteUserInput();
      clock += 1_000;
    }
    expect(pings).toBe(1);
    clock += ACTIVITY_PING_MS;
    noteUserInput(false); // reading (scroll) counts as using the app
    expect(pings).toBe(2);
    clock += 60 * ACTIVITY_PING_MS; // an hour of nobody touching anything
    expect(pings).toBe(2);
  });

  it("does not ping on an always-on plan or while asleep", () => {
    let pings = 0;
    setActivityPinger(() => pings++);
    configureGatewaySleep({ runMode: "always-on" });
    noteUserInput();
    expect(pings).toBe(0);
    wakePlan();
    noteGatewayClosed(FLEET_SLEEP_CLOSE_CODE);
    setWakeHandler(() => new Promise(() => {}));
    noteUserInput();
    expect(pings).toBe(0);
  });

  it("reports the interaction that woke it once the socket is back", async () => {
    wakePlan();
    let pings = 0;
    setActivityPinger(() => pings++);
    setWakeHandler(async () => true);
    noteGatewayClosed(FLEET_SLEEP_CLOSE_CODE);
    await requestWake();
    noteGatewayConnected();
    expect(pings).toBe(1);
  });

  it("a reconnect with nobody at the tab reports nothing", () => {
    wakePlan();
    let pings = 0;
    setActivityPinger(() => pings++);
    clock += INACTIVE_AFTER_MS + 1;
    noteGatewayConnected();
    expect(pings).toBe(0);
  });
});

describe("sleep notice + fair-use banner models", () => {
  it("sleeping / waking copy; nothing while awake", () => {
    expect(sleepNoticeModel("awake", 15)).toBeNull();
    expect(sleepNoticeModel("sleeping", 15)).toEqual({
      phase: "sleeping",
      title: "Sleeping — click or type to wake",
      detail: "It sleeps after 15 min idle. Nothing was lost.",
    });
    expect(sleepNoticeModel("waking", 15)?.title).toBe("Waking your workspace");
  });

  const base = { capHours: 150, month: "2026-10", resetsAt: "2026-11-01T00:00:00.000Z" };

  it("nothing below 80%", () => {
    expect(fairUseBannerModel(null)).toBeNull();
    expect(fairUseBannerModel({ ...base, usedHours: 90, pct: 60, state: "ok" })).toBeNull();
  });

  it("80%: a notice with the numbers and the reset date", () => {
    const m = fairUseBannerModel({ ...base, usedHours: 121.5, pct: 81, state: "warn", policy: "soft" });
    expect(m).toMatchObject({
      level: "warn",
      title: "Starter fair use",
      detail: "121.5 of 150 active hours used this month. Resets Nov 1.",
    });
    expect(m?.meterPct).toBeCloseTo(81);
  });

  it("100%: upgrade banner, says the workspace keeps working and sleeps sooner", () => {
    const m = fairUseBannerModel(
      { ...base, usedHours: 152, pct: 101.3, state: "over", policy: "soft", idleMinutes: 5 },
      "https://infinibotos.com/pricing",
    );
    expect(m).toMatchObject({
      level: "over",
      title: "Upgrade to Pro for always-on",
      meterPct: 100,
      cta: { label: "Upgrade to Pro", href: "https://infinibotos.com/pricing" },
    });
    expect(m?.detail).toBe(
      "152 of 150 active hours used this month. Your workspace keeps working and now sleeps after 5 min idle. Resets Nov 1.",
    );
  });

  it("policy off: over the cap shows nothing (nothing changed for the member)", () => {
    expect(
      fairUseBannerModel({ ...base, usedHours: 200, pct: 133, state: "over", policy: "off" }),
    ).toBeNull();
  });
});
