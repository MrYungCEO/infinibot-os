import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  defaultCommunicationProfile,
  effectiveChannelProfile,
  isWithinWorkingHours,
  migrateCommunicationCadence,
  normalizeCommunicationProfile,
  planResponse,
  renderCommunicationPrompt,
  resolveCommunicationProfile,
  summarizeCommunicationProfile,
  type ScheduleWindow,
} from "./communication.js";
import { assertNoCredentials, parseChannelId } from "./channel-bindings.js";
import {
  defaultExecutionProfile,
  describeToolPolicy,
  isToolAllowed,
  normalizeExecutionProfile,
} from "./execution-profile.js";
import { WorkforceStore } from "./store.js";

// Fixed instants so schedule assertions never depend on the wall clock.
// 2026-07-06 is a Monday.
const MONDAY_10_00_UTC = Date.UTC(2026, 6, 6, 10, 0);
const MONDAY_03_00_UTC = Date.UTC(2026, 6, 6, 3, 0);
const SATURDAY_10_00_UTC = Date.UTC(2026, 6, 11, 10, 0);

const weekdayShift = (over: Partial<ScheduleWindow> = {}): ScheduleWindow => ({
  timezone: "UTC",
  weekdays: [1, 2, 3, 4, 5],
  shiftStart: "09:00",
  shiftEnd: "17:00",
  enabled: true,
  ...over,
});

describe("communication profile — legacy cadence migration", () => {
  it("preserves the operator's original text verbatim", () => {
    const profile = migrateCommunicationCadence(
      "Daily async update; weekly campaign scorecard at 09:30",
    );
    expect(profile.legacyCadence).toBe("Daily async update; weekly campaign scorecard at 09:30");
  });

  it("infers report rhythm and time from the legacy string", () => {
    const profile = migrateCommunicationCadence("Daily standup at 08:15");
    expect(profile.reportCadence).toBe("daily");
    expect(profile.reportTime).toBe("08:15");
    expect(profile.proactivity).toBe("proactive");
  });

  it("reads 'async' as a slower, batched cadence", () => {
    const profile = migrateCommunicationCadence("Async written updates");
    expect(profile.responseLatency.minSeconds).toBeGreaterThan(
      defaultCommunicationProfile().responseLatency.minSeconds,
    );
    expect(profile.responseLatency.batchWindowSeconds).toBe(300);
  });

  it("falls back to defaults, with no legacy text, for an empty string", () => {
    const profile = migrateCommunicationCadence("   ");
    expect(profile.legacyCadence).toBeNull();
    expect(profile.reportCadence).toBe("daily");
  });

  it("prefers a stored profile over migrating the legacy string", () => {
    const stored = { ...defaultCommunicationProfile(), tone: "blunt" as const };
    const resolved = resolveCommunicationProfile({
      communicationProfile: stored,
      communicationCadence: "weekly board memo",
    });
    expect(resolved.tone).toBe("blunt");
    expect(resolved.reportCadence).toBe("daily");
  });
});

describe("communication profile — normalisation", () => {
  it("round-trips a full profile through normalisation", () => {
    const base = defaultCommunicationProfile(1);
    const patch = {
      tone: "casual",
      verbosity: "terse",
      language: "es",
      emojiUse: "expressive",
      proactivity: "driving",
      reportCadence: "weekly",
      reportTime: "16:45",
      greeting: "Hey",
      signOff: "— Mercury",
      notes: "Never send a wall of text.",
    };
    const next = normalizeCommunicationProfile(patch, base, 2);
    expect(next).toMatchObject({ ...patch, version: 1, updatedAt: 2 });
    // A second pass over its own output must be a fixed point.
    const again = normalizeCommunicationProfile(next, base, 2);
    expect(again).toEqual(next);
  });

  it("clamps nonsense numbers and rejects unknown enum values", () => {
    const next = normalizeCommunicationProfile(
      {
        tone: "sarcastic",
        responseLatency: { minSeconds: -50, targetSeconds: 10, maxSeconds: 5 },
        reportTime: "99:99",
      },
      defaultCommunicationProfile(),
    );
    expect(next.tone).toBe("professional");
    expect(next.responseLatency.minSeconds).toBe(0);
    // target is floored at min, max is floored at target — never inverted.
    expect(next.responseLatency.targetSeconds).toBeGreaterThanOrEqual(
      next.responseLatency.minSeconds,
    );
    expect(next.responseLatency.maxSeconds).toBeGreaterThanOrEqual(
      next.responseLatency.targetSeconds,
    );
    expect(next.reportTime).toBe("09:00");
  });

  it("drops channel overrides whose channel id is not in the registry", () => {
    const next = normalizeCommunicationProfile(
      {
        channelOverrides: [
          { channelId: "slack", verbosity: "terse" },
          { channelId: "myspace", verbosity: "detailed" },
          { channelId: "carrier-pigeon" },
        ],
      },
      defaultCommunicationProfile(),
    );
    expect(next.channelOverrides.map((entry) => entry.channelId)).toEqual(["slack"]);
  });

  it("accepts registry aliases and keeps one override per channel", () => {
    const next = normalizeCommunicationProfile(
      {
        channelOverrides: [
          { channelId: "imsg", signOff: "first" },
          { channelId: "imessage", signOff: "second" },
        ],
      },
      defaultCommunicationProfile(),
    );
    expect(next.channelOverrides).toHaveLength(1);
    expect(next.channelOverrides[0]!.channelId).toBe("imessage");
    expect(next.channelOverrides[0]!.signOff).toBe("first");
  });

  it("keeps the legacy cadence unless explicitly nulled", () => {
    const base = { ...defaultCommunicationProfile(), legacyCadence: "weekly memo" };
    expect(normalizeCommunicationProfile({ tone: "blunt" }, base).legacyCadence).toBe(
      "weekly memo",
    );
    expect(normalizeCommunicationProfile({ legacyCadence: null }, base).legacyCadence).toBeNull();
  });
});

describe("communication profile — per-channel override resolution", () => {
  const profile = normalizeCommunicationProfile(
    {
      tone: "formal",
      verbosity: "detailed",
      signOff: "Kind regards,",
      responseLatency: { minSeconds: 300, targetSeconds: 900, batchWindowSeconds: 600 },
      channelOverrides: [
        {
          channelId: "slack",
          tone: "casual",
          verbosity: "terse",
          maxMessageChars: 400,
          responseLatency: { minSeconds: 30, targetSeconds: 60 },
          signOff: null,
          notes: "Thread replies, no preamble.",
        },
        { channelId: "whatsapp", emojiUse: "expressive" },
      ],
    },
    defaultCommunicationProfile(),
  );

  it("applies the override on the bound channel", () => {
    const slack = effectiveChannelProfile(profile, "slack");
    expect(slack.tone).toBe("casual");
    expect(slack.verbosity).toBe("terse");
    expect(slack.maxMessageChars).toBe(400);
    expect(slack.notes).toBe("Thread replies, no preamble.");
  });

  it("merges latency partially — unset keys inherit the profile", () => {
    const slack = effectiveChannelProfile(profile, "slack");
    expect(slack.responseLatency.minSeconds).toBe(30);
    expect(slack.responseLatency.targetSeconds).toBe(60);
    // Not overridden on Slack, so it comes from the profile.
    expect(slack.responseLatency.batchWindowSeconds).toBe(600);
  });

  it("treats an explicit null override as a real clear, not an inherit", () => {
    expect(effectiveChannelProfile(profile, "slack").signOff).toBeNull();
    expect(effectiveChannelProfile(profile, "whatsapp").signOff).toBe("Kind regards,");
  });

  it("falls back entirely to the profile on an unbound channel", () => {
    const telegram = effectiveChannelProfile(profile, "telegram");
    expect(telegram.tone).toBe("formal");
    expect(telegram.verbosity).toBe("detailed");
    expect(telegram.maxMessageChars).toBeNull();
  });
});

describe("working hours", () => {
  it("is on-shift inside a rostered weekday window", () => {
    expect(isWithinWorkingHours([weekdayShift()], MONDAY_10_00_UTC, "UTC")).toBe(true);
  });

  it("is off-shift at 03:00 and at the weekend", () => {
    expect(isWithinWorkingHours([weekdayShift()], MONDAY_03_00_UTC, "UTC")).toBe(false);
    expect(isWithinWorkingHours([weekdayShift()], SATURDAY_10_00_UTC, "UTC")).toBe(false);
  });

  it("treats an absent schedule as always available", () => {
    expect(isWithinWorkingHours([], MONDAY_03_00_UTC, "UTC")).toBe(true);
  });

  it("ignores disabled schedule rows", () => {
    expect(isWithinWorkingHours([weekdayShift({ enabled: false })], MONDAY_10_00_UTC, "UTC")).toBe(
      true,
    );
  });

  it("handles an overnight shift that spans midnight", () => {
    const nightShift = weekdayShift({ shiftStart: "22:00", shiftEnd: "06:00" });
    // 03:00 Monday is inside Sunday-night's span only if Sunday is rostered.
    expect(isWithinWorkingHours([nightShift], MONDAY_03_00_UTC, "UTC")).toBe(false);
    expect(
      isWithinWorkingHours(
        [weekdayShift({ shiftStart: "22:00", shiftEnd: "06:00", weekdays: [0, 1] })],
        MONDAY_03_00_UTC,
        "UTC",
      ),
    ).toBe(true);
  });

  it("respects the schedule's own timezone", () => {
    // 10:00 UTC is 02:00 in Los Angeles — outside a 09:00-17:00 LA shift.
    expect(
      isWithinWorkingHours(
        [weekdayShift({ timezone: "America/Los_Angeles" })],
        MONDAY_10_00_UTC,
        "UTC",
      ),
    ).toBe(false);
  });

  it("degrades to UTC rather than throwing on a bogus timezone", () => {
    expect(
      isWithinWorkingHours([weekdayShift({ timezone: "Mars/Olympus" })], MONDAY_10_00_UTC, "UTC"),
    ).toBe(true);
  });
});

describe("schedule-aware response planning", () => {
  const profile = normalizeCommunicationProfile(
    {
      responseLatency: {
        minSeconds: 60,
        targetSeconds: 240,
        maxSeconds: 3600,
        batchWindowSeconds: 120,
      },
      workingHours: { respectSchedule: true, outsideHours: "defer" },
    },
    defaultCommunicationProfile(),
  );

  it("holds the reply for the target latency while on shift", () => {
    const plan = planResponse({
      profile,
      schedules: [weekdayShift()],
      now: MONDAY_10_00_UTC,
    });
    expect(plan.action).toBe("respond");
    expect(plan.withinWorkingHours).toBe(true);
    expect(plan.delaySeconds).toBe(240);
    expect(plan.batchWindowSeconds).toBe(120);
    expect(plan.respondAt).toBe(MONDAY_10_00_UTC + 240_000);
  });

  it("defers an out-of-hours message to the next shift opening", () => {
    const plan = planResponse({
      profile,
      schedules: [weekdayShift()],
      now: MONDAY_03_00_UTC,
    });
    expect(plan.action).toBe("defer");
    expect(plan.withinWorkingHours).toBe(false);
    // 03:00 -> 09:00 the same morning is six hours away.
    expect(plan.respondAt).toBe(MONDAY_03_00_UTC + 6 * 3_600_000);
  });

  it("lets urgent traffic bypass both the delay and the deferral", () => {
    const plan = planResponse({
      profile,
      schedules: [weekdayShift()],
      now: MONDAY_03_00_UTC,
      urgent: true,
    });
    expect(plan.action).toBe("respond");
    expect(plan.delaySeconds).toBe(0);
    expect(plan.respondAt).toBe(MONDAY_03_00_UTC);
  });

  it("does not bypass when the profile disables urgentBypass", () => {
    const strict = normalizeCommunicationProfile(
      { responseLatency: { urgentBypass: false } },
      profile,
    );
    const plan = planResponse({
      profile: strict,
      schedules: [weekdayShift()],
      now: MONDAY_03_00_UTC,
      urgent: true,
    });
    expect(plan.action).toBe("defer");
  });

  it("auto-replies out of hours when configured", () => {
    const autoReply = normalizeCommunicationProfile(
      {
        workingHours: {
          respectSchedule: true,
          outsideHours: "auto_reply",
          outsideHoursMessage: "I'm off shift — back at 09:00.",
        },
      },
      profile,
    );
    const plan = planResponse({
      profile: autoReply,
      schedules: [weekdayShift()],
      now: MONDAY_03_00_UTC,
    });
    expect(plan.action).toBe("auto_reply");
    expect(plan.autoReplyMessage).toBe("I'm off shift — back at 09:00.");
  });

  it("answers out of hours when the policy says respond", () => {
    const alwaysOn = normalizeCommunicationProfile(
      { workingHours: { respectSchedule: true, outsideHours: "respond" } },
      profile,
    );
    const plan = planResponse({
      profile: alwaysOn,
      schedules: [weekdayShift()],
      now: MONDAY_03_00_UTC,
    });
    expect(plan.action).toBe("respond");
    expect(plan.withinWorkingHours).toBe(false);
  });

  it("ignores schedules entirely when respectSchedule is off", () => {
    const noSchedule = normalizeCommunicationProfile(
      { workingHours: { respectSchedule: false } },
      profile,
    );
    const plan = planResponse({
      profile: noSchedule,
      schedules: [weekdayShift()],
      now: MONDAY_03_00_UTC,
    });
    expect(plan.action).toBe("respond");
    expect(plan.withinWorkingHours).toBe(true);
  });

  it("uses the channel's own latency when a channel is given", () => {
    const perChannel = normalizeCommunicationProfile(
      { channelOverrides: [{ channelId: "slack", responseLatency: { targetSeconds: 15 } }] },
      profile,
    );
    const slack = planResponse({
      profile: perChannel,
      channelId: "slack",
      schedules: [weekdayShift()],
      now: MONDAY_10_00_UTC,
    });
    // Floored by the profile-level minSeconds of 60, which Slack does not override.
    expect(slack.delaySeconds).toBe(60);
    expect(
      planResponse({
        profile: perChannel,
        channelId: "telegram",
        schedules: [weekdayShift()],
        now: MONDAY_10_00_UTC,
      }).delaySeconds,
    ).toBe(240);
  });

  it("never mutes an employee whose shifts can never open", () => {
    const plan = planResponse({
      profile,
      schedules: [weekdayShift({ weekdays: [], shiftStart: "bogus", shiftEnd: "17:00" })],
      now: MONDAY_03_00_UTC,
    });
    expect(plan.action).toBe("defer");
    expect(plan.delaySeconds).toBe(240);
  });
});

describe("prompt rendering", () => {
  it("states the tone, verbosity, latency and hand-off phrasing", () => {
    const profile = normalizeCommunicationProfile(
      {
        tone: "blunt",
        verbosity: "terse",
        language: "en-GB",
        signOff: "— Vega",
        escalation: { handoffPhrase: "Passing this to {assignee}." },
      },
      defaultCommunicationProfile(),
    );
    const text = renderCommunicationPrompt(profile);
    expect(text).toContain("Tone: blunt");
    expect(text).toContain("Verbosity: terse");
    expect(text).toContain("en-GB");
    expect(text).toContain("Do NOT answer instantly");
    expect(text).toContain("Passing this to {assignee}.");
    expect(text).toContain("— Vega");
  });

  it("renders a per-channel line for every override", () => {
    const profile = normalizeCommunicationProfile(
      {
        channelOverrides: [
          { channelId: "slack", verbosity: "terse", maxMessageChars: 300 },
          { channelId: "telegram", tone: "friendly" },
        ],
      },
      defaultCommunicationProfile(),
    );
    const text = renderCommunicationPrompt(profile);
    expect(text).toContain("On slack:");
    expect(text).toContain("max 300 chars");
    expect(text).toContain("On telegram:");
  });

  it("carries the operator's original cadence text into the prompt", () => {
    const profile = migrateCommunicationCadence("Weekly campaign scorecard, Mondays");
    expect(renderCommunicationPrompt(profile)).toContain("Weekly campaign scorecard, Mondays");
  });

  it("summarises into a readable one-liner for the legacy column", () => {
    const summary = summarizeCommunicationProfile(
      normalizeCommunicationProfile(
        { reportCadence: "weekly", reportTime: "10:00", tone: "friendly" },
        defaultCommunicationProfile(),
      ),
    );
    expect(summary).toContain("weekly report 10:00");
    expect(summary).toContain("friendly/concise");
  });
});

describe("channel bindings — validation and credential safety", () => {
  it("accepts every id in the registry, plus aliases", () => {
    expect(parseChannelId("slack")).toBe("slack");
    expect(parseChannelId(" TELEGRAM ")).toBe("telegram");
    expect(parseChannelId("imsg")).toBe("imessage");
    expect(parseChannelId("gchat")).toBe("googlechat");
  });

  it("rejects an unknown channel rather than storing free text", () => {
    for (const bogus of ["myspace", "", "  ", null, 42, undefined]) {
      expect(() => parseChannelId(bogus)).toThrow(/known chat channel/);
    }
  });

  it("refuses anything that looks like a credential", () => {
    for (const key of ["token", "botToken", "api_key", "apiKey", "password", "signingSecret"]) {
      expect(() => assertNoCredentials({ [key]: "x" })).toThrow(/credential/i);
    }
  });

  it("detects credentials nested inside the config bag", () => {
    expect(() =>
      assertNoCredentials({ slack: { workspace: "acme", authToken: "xoxb-1" } }),
    ).toThrow(/credential/i);
  });

  it("allows genuine routing metadata", () => {
    expect(() =>
      assertNoCredentials({ threadId: "1699", locale: "en-GB", mentionPolicy: "on-request" }),
    ).not.toThrow();
  });
});

describe("execution profile", () => {
  it("defaults to inheriting every gateway setting", () => {
    const profile = defaultExecutionProfile(0);
    expect(profile.fallbackModelBinding).toBeNull();
    expect(profile.timeoutMinutes).toBeNull();
    expect(profile.maxConcurrent).toBeNull();
    expect(profile.toolAllowlist).toEqual([]);
  });

  it("round-trips and clamps a patch", () => {
    const next = normalizeExecutionProfile(
      {
        fallbackModelBinding: "claude",
        toolAllowlist: ["Read", "read", " Write "],
        timeoutMinutes: 9_999,
        maxConcurrent: 0,
        maxRetries: 99,
      },
      defaultExecutionProfile(0),
      5,
    );
    expect(next.fallbackModelBinding).toBe("claude");
    // Deduplicated case-insensitively, trimmed, order preserved.
    expect(next.toolAllowlist).toEqual(["Read", "Write"]);
    expect(next.timeoutMinutes).toBe(240);
    expect(next.maxConcurrent).toBe(1);
    expect(next.maxRetries).toBe(5);
    expect(normalizeExecutionProfile(next, defaultExecutionProfile(0), 5)).toEqual(next);
  });

  it("treats an explicit null as a real clear back to inherit", () => {
    const base = normalizeExecutionProfile(
      { timeoutMinutes: 30, fallbackModelBinding: "codex" },
      defaultExecutionProfile(0),
    );
    const cleared = normalizeExecutionProfile(
      { timeoutMinutes: null, fallbackModelBinding: null },
      base,
    );
    expect(cleared.timeoutMinutes).toBeNull();
    expect(cleared.fallbackModelBinding).toBeNull();
  });

  it("enforces the allowlist and lets the denylist win", () => {
    const open = defaultExecutionProfile(0);
    expect(isToolAllowed(open, "Bash")).toBe(true);

    const restricted = normalizeExecutionProfile({ toolAllowlist: ["Read", "Grep"] }, open);
    expect(isToolAllowed(restricted, "read")).toBe(true);
    expect(isToolAllowed(restricted, "Bash")).toBe(false);

    const wildcard = normalizeExecutionProfile({ toolAllowlist: ["*"] }, open);
    expect(isToolAllowed(wildcard, "Bash")).toBe(true);

    const denied = normalizeExecutionProfile(
      { toolAllowlist: ["*"], toolDenylist: ["Bash"] },
      open,
    );
    expect(isToolAllowed(denied, "Bash")).toBe(false);
  });

  it("describes the boundary for the prompt, and stays silent when open", () => {
    expect(describeToolPolicy(defaultExecutionProfile(0))).toBe("");
    const text = describeToolPolicy(
      normalizeExecutionProfile(
        { toolAllowlist: ["Read"], toolDenylist: ["Bash"] },
        defaultExecutionProfile(0),
      ),
    );
    expect(text).toContain("only use these tools/capabilities: Read");
    expect(text).toContain("must NOT use: Bash");
  });
});

describe("WorkforceStore — profiles and bindings persistence", () => {
  let directory: string;
  let store: WorkforceStore;

  const seed = () =>
    store.createWorker({
      id: "mercury",
      agencyId: "agency-a",
      type: "ai",
      displayName: "Mercury",
      title: "CMO",
      communicationCadence: "Daily async update; weekly campaign scorecard",
    });

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "infinibot-comms-"));
    store = new WorkforceStore(join(directory, "agency.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("migrates the legacy cadence on read without writing", () => {
    const worker = seed();
    expect(worker.communicationProfile).toBeNull();
    const profile = store.getCommunicationProfile("agency-a", "mercury")!;
    expect(profile.legacyCadence).toBe("Daily async update; weekly campaign scorecard");
    expect(profile.reportCadence).toBe("daily");
    // Read must not persist anything.
    expect(store.getWorker("agency-a", "mercury")!.communicationProfile).toBeNull();
  });

  it("round-trips a profile through the database", () => {
    seed();
    const saved = store.setCommunicationProfile("agency-a", "mercury", {
      tone: "friendly",
      verbosity: "terse",
      channelOverrides: [{ channelId: "slack", maxMessageChars: 500 }],
    })!;
    expect(saved.changed).toBe(true);
    const reloaded = store.getCommunicationProfile("agency-a", "mercury")!;
    expect(reloaded.tone).toBe("friendly");
    expect(reloaded.channelOverrides[0]!.channelId).toBe("slack");
    // The operator's original text survives the first structured write.
    expect(reloaded.legacyCadence).toBe("Daily async update; weekly campaign scorecard");
    // The legacy column stays readable for old readers.
    expect(store.getWorker("agency-a", "mercury")!.communicationCadence).toContain("friendly");
  });

  it("is a genuine no-op when the patch changes nothing", () => {
    seed();
    store.setCommunicationProfile("agency-a", "mercury", { tone: "friendly" });
    const first = store.getWorker("agency-a", "mercury")!;
    const auditsBefore = store.listAuditEntries("agency-a").length;

    const again = store.setCommunicationProfile("agency-a", "mercury", { tone: "friendly" })!;
    expect(again.changed).toBe(false);
    expect(store.getWorker("agency-a", "mercury")!.updatedAt).toBe(first.updatedAt);
    // The 633 MB incident: a re-run must not add an audit row.
    expect(store.listAuditEntries("agency-a").length).toBe(auditsBefore);
  });

  it("round-trips an execution profile and no-ops on a repeat", () => {
    seed();
    const saved = store.setExecutionProfile("agency-a", "mercury", {
      fallbackModelBinding: "claude",
      timeoutMinutes: 45,
      toolAllowlist: ["Read", "Write"],
    })!;
    expect(saved.changed).toBe(true);
    expect(store.getExecutionProfile("agency-a", "mercury")!.fallbackModelBinding).toBe("claude");

    const auditsBefore = store.listAuditEntries("agency-a").length;
    const repeat = store.setExecutionProfile("agency-a", "mercury", {
      fallbackModelBinding: "claude",
      timeoutMinutes: 45,
      toolAllowlist: ["Read", "Write"],
    })!;
    expect(repeat.changed).toBe(false);
    expect(store.listAuditEntries("agency-a").length).toBe(auditsBefore);
  });

  it("binds a worker to a channel and upserts on the same triple", () => {
    seed();
    const first = store.upsertChannelBinding("agency-a", {
      workerId: "mercury",
      channelId: "slack",
      target: "C0123",
      handle: "@mercury",
    });
    expect(first.channelId).toBe("slack");
    expect(first.direction).toBe("both");

    const second = store.upsertChannelBinding("agency-a", {
      workerId: "mercury",
      channelId: "slack",
      target: "C0123",
      handle: "@mercury-bot",
      direction: "outbound",
    });
    expect(second.id).toBe(first.id);
    expect(second.handle).toBe("@mercury-bot");
    expect(store.listChannelBindings("agency-a", { workerId: "mercury" })).toHaveLength(1);

    // A different target on the same channel is a distinct binding.
    store.upsertChannelBinding("agency-a", {
      workerId: "mercury",
      channelId: "slack",
      target: "C0999",
    });
    expect(store.listChannelBindings("agency-a", { workerId: "mercury" })).toHaveLength(2);
  });

  it("rejects an unknown channel id at the store boundary", () => {
    seed();
    expect(() =>
      store.upsertChannelBinding("agency-a", { workerId: "mercury", channelId: "myspace" }),
    ).toThrow(/known chat channel/);
  });

  it("never persists a credential in a binding config", () => {
    seed();
    expect(() =>
      store.upsertChannelBinding("agency-a", {
        workerId: "mercury",
        channelId: "slack",
        config: { botToken: "xoxb-secret" },
      }),
    ).toThrow(/credential/i);
    expect(store.listChannelBindings("agency-a", { workerId: "mercury" })).toHaveLength(0);
  });

  it("refuses to bind a worker from another agency", () => {
    seed();
    expect(() =>
      store.upsertChannelBinding("agency-b", { workerId: "mercury", channelId: "slack" }),
    ).toThrow(/worker not found/);
  });

  it("filters and removes bindings", () => {
    seed();
    store.upsertChannelBinding("agency-a", { workerId: "mercury", channelId: "slack" });
    const telegram = store.upsertChannelBinding("agency-a", {
      workerId: "mercury",
      channelId: "telegram",
      enabled: false,
    });
    expect(store.listChannelBindings("agency-a", { channelId: "slack" })).toHaveLength(1);
    expect(store.listChannelBindings("agency-a", { enabled: true })).toHaveLength(1);

    expect(store.removeChannelBinding("agency-a", telegram.id)).toBe(true);
    expect(store.removeChannelBinding("agency-a", telegram.id)).toBe(false);
    expect(store.listChannelBindings("agency-a")).toHaveLength(1);
  });
});
