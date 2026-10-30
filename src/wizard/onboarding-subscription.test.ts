import { beforeEach, describe, expect, it, vi } from "vitest";

import type { InfinibotConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "./prompts.js";

const state = vi.hoisted(() => ({
  installed: true,
  auth: "signed-out" as string,
  polls: [] as Array<Record<string, unknown>>,
  submitted: [] as string[],
}));

vi.mock("../agents/coder-install/status.js", () => ({
  coderStatus: vi.fn(async () => ({ installed: state.installed, auth: state.auth })),
  invalidateCoderStatus: vi.fn(),
}));
vi.mock("../agents/coder-install/installer.js", () => ({
  startJob: vi.fn(() => {
    state.installed = true;
    return { ok: true, job: {}, done: Promise.resolve({ ok: true }) };
  }),
}));
vi.mock("../agents/coder-install/login.js", () => ({
  startLogin: vi.fn(async () => ({ ok: true, session: { sessionId: "s1" } })),
  pollLogin: vi.fn(() => state.polls.shift() ?? { status: "succeeded" }),
  submitLoginCode: vi.fn((_id: string, code: string) => {
    state.submitted.push(code);
    return { ok: true };
  }),
  cancelLogin: vi.fn(),
}));

import { promptSubscriptionBrain } from "./onboarding-subscription.js";

function prompter(answers: string[], texts: string[] = []) {
  const notes: string[] = [];
  const stops: string[] = [];
  const selects: Array<{ message: string; labels: string[] }> = [];
  const p: WizardPrompter = {
    intro: vi.fn(async () => {}),
    outro: vi.fn(async () => {}),
    note: vi.fn(async (m: string) => {
      notes.push(m);
    }),
    select: vi.fn(
      async (params: { message: string; options: Array<{ value: unknown; label: string }> }) => {
        selects.push({ message: params.message, labels: params.options.map((o) => o.label) });
        return answers.shift() as never;
      },
    ) as never,
    multiselect: vi.fn(async () => []) as never,
    text: vi.fn(async () => texts.shift() ?? ""),
    confirm: vi.fn(async () => true),
    progress: vi.fn(() => ({ update: vi.fn(), stop: (m?: string) => void stops.push(m ?? "") })),
  };
  return { p, notes, stops, selects };
}

const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as unknown as RuntimeEnv;

describe("infinibot onboard: Which of these do you already have?", () => {
  beforeEach(() => {
    state.installed = true;
    state.auth = "signed-out";
    state.polls = [];
    state.submitted = [];
  });

  it("asks in plain words (no API/CLI/token), installs, opens the browser sign-in, tests, and switches on", async () => {
    state.installed = false;
    state.polls = [
      {
        status: "waiting",
        url: "https://auth.openai.com/device",
        userCode: "ABCD-1234",
        needsCode: false,
      },
      { status: "succeeded" },
    ];
    const opened: string[] = [];
    const { p, selects, stops, notes } = prompter(["codex-cli"]);
    const cfg = await promptSubscriptionBrain({
      config: {} as InfinibotConfig,
      prompter: p,
      runtime,
      deps: {
        pollMs: 0,
        openUrl: async (u) => {
          opened.push(u);
          return true;
        },
        testCliProvider: async () => ({ ok: true, reply: "Ready", ms: 5 }),
      },
    });
    expect(selects[0]?.message).toBe("Which of these do you already have?");
    expect(selects[0]?.labels).toEqual([
      "ChatGPT",
      "Grok",
      "Google account (paid Google plan or Gemini key)",
      "Claude",
      "Something else",
    ]);
    expect(selects[0]?.labels.join(" ")).not.toMatch(/\b(API|CLI|token|provider)\b/i);
    expect(opened).toEqual(["https://auth.openai.com/device"]);
    expect(stops).toContain(
      "Sign in with your ChatGPT account in the window that just opened, then come back here.",
    );
    expect(notes.some((n) => n.includes("ABCD-1234"))).toBe(true);
    expect(cfg?.cliRoutingEnabled).toBe(true);
    expect(cfg?.cliRouting?.providers?.[0]).toBe("codex-cli");
  });

  it("asks for the pasted code when the sign-in page shows one (Claude / Google)", async () => {
    state.polls = [
      { status: "waiting", url: "https://claude.ai/oauth", needsCode: true },
      { status: "verifying", needsCode: true },
      { status: "succeeded" },
    ];
    const { p } = prompter(["claude-cli"], ["code-123"]);
    const cfg = await promptSubscriptionBrain({
      config: {} as InfinibotConfig,
      prompter: p,
      runtime,
      deps: {
        pollMs: 0,
        openUrl: async () => true,
        testCliProvider: async () => ({ ok: true, reply: "Ready", ms: 5 }),
      },
    });
    expect(state.submitted).toEqual(["code-123"]);
    expect(cfg?.cliRouting?.providers?.[0]).toBe("claude-cli");
  });

  it("skips sign-in when already signed in; a failed test offers retry or something else", async () => {
    state.auth = "signed-in";
    const { p, stops } = prompter(["claude-cli", "other"]);
    const cfg = await promptSubscriptionBrain({
      config: {} as InfinibotConfig,
      prompter: p,
      runtime,
      deps: {
        pollMs: 0,
        openUrl: async () => true,
        testCliProvider: async () => ({
          ok: false,
          code: "subscription_limit",
          message: "Claude Code has hit your plan's usage limit.",
          ms: 5,
        }),
      },
    });
    expect(stops).toContain("Claude Code has hit your plan's usage limit.");
    expect(cfg).toBeNull();
  });

  it('"Something else" falls through to the classic menu', async () => {
    const { p } = prompter(["__other"]);
    expect(
      await promptSubscriptionBrain({ config: {} as InfinibotConfig, prompter: p, runtime }),
    ).toBeNull();
  });
});
