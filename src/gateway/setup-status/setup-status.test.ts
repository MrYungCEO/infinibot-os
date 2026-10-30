import { afterEach, describe, expect, it, vi } from "vitest";

import { runWithUserId } from "../../config/paths.js";
import { parseManifestV2 } from "../../plugins/manifest-v2.js";
import { createPluginRegistry } from "../../plugins/registry.js";
import {
  calendarOutcome,
  channelsOutcome,
  codersOutcome,
  coreSetupChecks,
  inboxOutcome,
  mobileOutcome,
  modelCredentialOutcome,
  voiceOutcome,
  type ModelCredentialFacts,
} from "./core-checks.js";
import {
  evaluateSetupChecks,
  isSetupRelevantWrite,
  resetSetupStatusForTests,
  scheduleSetupStatusRefresh,
  setCoreSetupChecks,
  getSetupStatus,
} from "./registry.js";
import type { SetupCheckDefinition } from "./types.js";

const noCreds: ModelCredentialFacts = {
  providersWithAuth: [],
  customProvider: false,
  localPrimary: false,
  cliLogin: false,
  rejected: [],
  storedProfiles: 0,
};

describe("core setup checks", () => {
  it("models: needs setup with no credential of any kind", () => {
    expect(modelCredentialOutcome(noCreds).state).toBe("needs-setup");
  });

  it.each([
    ["stored/env key", { providersWithAuth: ["anthropic"] }],
    ["custom provider", { customProvider: true }],
    ["local ollama primary", { localPrimary: true }],
    ["claude/codex CLI login", { cliLogin: true }],
  ])("models: ready with a %s", (_label, facts) => {
    expect(modelCredentialOutcome({ ...noCreds, ...facts }).state).toBe("ready");
  });

  it("models: error when every stored key was rejected and nothing else can stand in", () => {
    const rejected = { provider: "openai", profileId: "openai:default" };
    const out = modelCredentialOutcome({
      ...noCreds,
      providersWithAuth: ["openai"],
      storedProfiles: 1,
      rejected: [rejected],
    });
    expect(out.state).toBe("error");
    expect(out.reason).toContain("openai");
    // …but a CLI login keeps chat working → no error.
    expect(
      modelCredentialOutcome({
        ...noCreds,
        providersWithAuth: ["openai"],
        storedProfiles: 1,
        rejected: [rejected],
        cliLogin: true,
      }).state,
    ).toBe("ready");
    // …and one good key among several → ready.
    expect(
      modelCredentialOutcome({
        ...noCreds,
        providersWithAuth: ["openai", "anthropic"],
        storedProfiles: 2,
        rejected: [rejected],
      }).state,
    ).toBe("ready");
  });

  it("inbox: needs setup only with zero accounts", () => {
    expect(inboxOutcome(0).state).toBe("needs-setup");
    expect(inboxOutcome(2).state).toBe("ready");
  });

  it("channels: optional until one is configured; webchat/defaults and disabled ones don't count", () => {
    expect(channelsOutcome(undefined).state).toBe("optional");
    expect(channelsOutcome({ webchat: { enabled: true }, defaults: { x: 1 } }).state).toBe(
      "optional",
    );
    expect(channelsOutcome({ telegram: { enabled: false, botToken: "t" } }).state).toBe("optional");
    expect(channelsOutcome({ telegram: { botToken: "123:abc" } }).state).toBe("ready");
    expect(channelsOutcome({ discord: { enabled: true } }).state).toBe("ready");
    expect(channelsOutcome({ whatsapp: { accounts: { default: {} } } }).state).toBe("ready");
  });

  it("coders / voice / calendar / mobile", () => {
    expect(codersOutcome(0).state).toBe("needs-setup");
    expect(codersOutcome(1).state).toBe("ready");
    expect(voiceOutcome(false).state).toBe("needs-setup");
    expect(voiceOutcome(true).state).toBe("ready");
    expect(calendarOutcome(false).state).toBe("optional");
    expect(calendarOutcome(true).state).toBe("ready");
    expect(mobileOutcome(0).state).toBe("optional");
    expect(mobileOutcome(1).state).toBe("ready");
  });

  it("every core check has an action target, tabs and a unique id", () => {
    const defs = coreSetupChecks();
    expect(new Set(defs.map((d) => d.id)).size).toBe(defs.length);
    for (const d of defs) {
      expect(d.id.startsWith("core.")).toBe(true);
      expect(d.tabs.length).toBeGreaterThan(0);
      expect(d.action?.label).toBeTruthy();
    }
    expect(defs.find((d) => d.id === "core.models")?.priority).toBe(100);
  });
});

function def(
  id: string,
  state: "ready" | "needs-setup" | "optional" | "error",
  extra: Partial<SetupCheckDefinition> = {},
) {
  return {
    id,
    title: id,
    tabs: ["x"],
    evaluate: () => ({ state, reason: `${id} reason` }),
    ...extra,
  } as SetupCheckDefinition;
}

describe("setup-status registry", () => {
  afterEach(() => {
    resetSetupStatusForTests();
    vi.useRealTimers();
  });

  it("evaluates core + plugin checks with source attribution; ready clears the reason", async () => {
    const snap = await evaluateSetupChecks({
      cloud: false,
      core: [def("core.a", "needs-setup"), def("core.b", "ready")],
      plugins: [{ pluginId: "demo", source: "/x", def: def("demo.c", "error") }],
    });
    expect(snap.checks.map((c) => [c.id, c.source, c.state, c.reason])).toEqual([
      ["core.a", "core", "needs-setup", "core.a reason"],
      ["core.b", "core", "ready", ""],
      ["demo.c", "demo", "error", "demo.c reason"],
    ]);
  });

  it("cloud mode skips localOnly checks (features that don't exist there)", async () => {
    const core = [
      def("core.voice", "needs-setup", { localOnly: true }),
      def("core.models", "needs-setup"),
    ];
    expect(
      (await evaluateSetupChecks({ cloud: true, core, plugins: [] })).checks.map((c) => c.id),
    ).toEqual(["core.models"]);
    expect((await evaluateSetupChecks({ cloud: false, core, plugins: [] })).checks).toHaveLength(2);
  });

  it("a throwing, invalid or slow check is dropped instead of glowing wrongly", async () => {
    vi.useFakeTimers();
    const pending = evaluateSetupChecks({
      cloud: false,
      core: [
        def("core.boom", "ready", {
          evaluate: () => {
            throw new Error("x");
          },
        }),
        def("core.bad", "ready", { evaluate: () => ({ state: "maybe" }) as never }),
        def("core.slow", "ready", { evaluate: () => new Promise(() => {}) }),
        def("core.ok", "needs-setup"),
      ],
      plugins: [],
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await pending).checks.map((c) => c.id)).toEqual(["core.ok"]);
  });

  it("caches per tenant namespace and pushes only real changes after writes", async () => {
    vi.useFakeTimers();
    let state: "needs-setup" | "ready" = "needs-setup";
    let calls = 0;
    setCoreSetupChecks(() => [
      def("core.inbox", "ready", {
        evaluate: () => {
          calls++;
          return { state, reason: "no email" };
        },
      }),
    ]);
    const a = await getSetupStatus();
    await getSetupStatus();
    expect(calls).toBe(1); // cached
    expect(a.checks[0].state).toBe("needs-setup");

    const broadcast = vi.fn();
    scheduleSetupStatusRefresh(broadcast);
    await vi.advanceTimersByTimeAsync(500);
    expect(broadcast).not.toHaveBeenCalled(); // unchanged → no push

    state = "ready"; // user connected an account
    scheduleSetupStatusRefresh(broadcast);
    scheduleSetupStatusRefresh(broadcast); // debounced
    await vi.advanceTimersByTimeAsync(500);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast.mock.calls[0][0]).toBe("setup.status");
    expect(broadcast.mock.calls[0][1].checks[0].state).toBe("ready");

    // A tenant request scope gets its own cache entry (and counts as cloud).
    const tenant = await runWithUserId("tenant-a", () => getSetupStatus());
    expect(tenant.cloud).toBe(true);
    expect(calls).toBe(4);
  });

  it("chat/session traffic doesn't trigger recomputes; config/plugin/key writes do", () => {
    for (const m of [
      "chat.send",
      "agent",
      "sessions.patch",
      "setup.status",
      "kanban.tasks.update",
    ]) {
      expect(isSetupRelevantWrite(m)).toBe(false);
    }
    for (const m of [
      "auth.profiles.upsert",
      "config.patch",
      "plugins.setEnabled",
      "coders.install",
      "solatrix.agent.rpc.set",
      "email.accounts.add",
    ]) {
      expect(isSetupRelevantWrite(m)).toBe(true);
    }
  });
});

describe("plugin setup checks (contributes.setupChecks + api.registerSetupCheck)", () => {
  const baseManifest = (setupChecks: unknown) => ({
    manifestVersion: 2,
    id: "demo",
    name: "Demo",
    version: "1.0.0",
    engines: { "infinibot-plugin-api": "^2.0.0" },
    contributes: {
      pages: [
        { tab: "demo", route: "/demo", builtin: "demo" },
        { tab: "demo-settings", route: "/demo/settings", builtin: "demo-settings" },
      ],
      nav: [],
      setupChecks,
    },
  });

  it("parses declarations and rejects foreign pages / un-namespaced ids", () => {
    const ok = parseManifestV2(
      "demo",
      baseManifest([
        {
          id: "demo.key",
          title: "Demo key",
          tabs: ["demo"],
          action: { label: "Add key", tab: "demo-settings" },
        },
      ]),
    );
    expect(ok.ok).toBe(true);
    if (ok.ok)
      expect(ok.fields.contributes.setupChecks?.[0]).toMatchObject({
        id: "demo.key",
        tabs: ["demo"],
      });

    const errs = [
      [[{ id: "key", title: "t", tabs: ["demo"] }], 'namespaced "demo.*"'],
      [[{ id: "demo.key", title: "t", tabs: ["inbox"] }], "not one of the plugin's pages"],
      [
        [{ id: "demo.key", title: "t", tabs: ["demo"], action: { label: "x", tab: "apikeys" } }],
        "not one of the plugin's pages",
      ],
      [[{ id: "demo.key", title: "t", tabs: [] }], "needs tabs"],
      ["nope", "must be an array"],
    ] as const;
    for (const [decl, msg] of errs) {
      const r = parseManifestV2("demo", baseManifest(decl));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain(msg);
    }
  });

  it("registers declared checks only, and evaluates them through the registry", async () => {
    const parsed = parseManifestV2(
      "demo",
      baseManifest([
        {
          id: "demo.key",
          title: "Demo key",
          tabs: ["demo"],
          action: { label: "Add key", tab: "demo-settings" },
        },
      ]),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    const { registry, createApi } = createPluginRegistry({ logger, runtime: {} as never });
    const record = {
      id: "demo",
      name: "Demo",
      source: "/plugins/demo",
      origin: "workspace",
      enabled: true,
      status: "loaded",
      manifestVersion: 2,
      contributes: parsed.fields.contributes,
      toolNames: [],
      hookNames: [],
      channelIds: [],
      providerIds: [],
      gatewayMethods: [],
      cliCommands: [],
      services: [],
      commands: [],
      httpHandlers: 0,
      hookCount: 0,
      configSchema: false,
    } as never;
    const api = createApi(record, { config: {} as never });
    api.registerSetupCheck({
      id: "demo.key",
      evaluate: () => ({ state: "needs-setup", reason: "No key" }),
    });
    api.registerSetupCheck({ id: "demo.undeclared", evaluate: () => ({ state: "ready" }) });
    api.registerSetupCheck({ id: "demo.key", evaluate: () => ({ state: "ready" }) }); // duplicate
    // Retargeting the action to a core page is stripped.
    expect(registry.setupChecks).toHaveLength(1);
    expect(registry.diagnostics.map((d) => d.message).join("\n")).toMatch(
      /not declared[\s\S]*already registered/,
    );

    const snap = await evaluateSetupChecks({
      cloud: false,
      core: [],
      plugins: registry.setupChecks,
    });
    expect(snap.checks).toEqual([
      {
        id: "demo.key",
        source: "demo",
        title: "Demo key",
        tabs: ["demo"],
        state: "needs-setup",
        reason: "No key",
        action: { label: "Add key", tab: "demo-settings" },
      },
    ]);
  });

  it("a plugin can't point its action at a core page at runtime", async () => {
    const parsed = parseManifestV2(
      "demo",
      baseManifest([{ id: "demo.key", title: "Demo key", tabs: ["demo"] }]),
    );
    if (!parsed.ok) throw new Error(parsed.error);
    const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    const { registry, createApi } = createPluginRegistry({ logger, runtime: {} as never });
    const api = createApi(
      {
        id: "demo",
        source: "/p",
        status: "loaded",
        enabled: true,
        contributes: parsed.fields.contributes,
      } as never,
      {
        config: {} as never,
      },
    );
    api.registerSetupCheck({
      id: "demo.key",
      evaluate: () => ({
        state: "needs-setup",
        reason: "x",
        action: { label: "Go", tab: "apikeys" },
      }),
    });
    const snap = await evaluateSetupChecks({
      cloud: false,
      core: [],
      plugins: registry.setupChecks,
    });
    expect(snap.checks[0].action).toBeUndefined();
  });
});
