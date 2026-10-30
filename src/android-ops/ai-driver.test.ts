/**
 * The parser is the guard between a model's reply and a real handset, so these
 * cases are mostly about what it REFUSES: an action outside the vocabulary, a
 * keyevent that is not on the list, prose instead of JSON.
 */
import { describe, it, expect } from "vitest";
import { buildPrompt, describeScreen, parseAction } from "./ai-driver.js";
import { parseHierarchy } from "./ui-automation.js";

const node = (attrs: Record<string, string>) =>
  `<node ${Object.entries(attrs)
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ")}>`;
const screen = parseHierarchy(
  `<hierarchy>${[
    node({
      text: "What's your email?",
      class: "android.widget.TextView",
      clickable: "false",
      bounds: "[0,0][720,80]",
    }),
    node({
      text: "",
      "content-desc": "Email",
      class: "android.widget.EditText",
      clickable: "true",
      bounds: "[0,100][720,180]",
    }),
    node({
      text: "",
      "content-desc": "Next",
      class: "android.view.View",
      clickable: "true",
      bounds: "[0,200][720,280]",
    }),
  ].join("")}</hierarchy>`,
);

describe("screen description", () => {
  it("lists controls by their label, falling back to the description", () => {
    const text = describeScreen(screen);
    expect(text).toMatch(/What's your email\?/);
    expect(text).toMatch(/"Email" \[EditText/);
    expect(text).toMatch(/clickable/);
  });
});

describe("prompt", () => {
  const ctx = {
    goal: "open the signup flow",
    platform: "instagram",
    handle: "demo.acct",
    displayName: "Demo",
    bio: "hi",
    recoveryEmail: "demo@ops.example",
    history: ["tap Sign up — failed"],
  };

  it("carries the account values but never a password", () => {
    const p = buildPrompt(ctx, screen);
    expect(p).toMatch(/demo@ops\.example/);
    expect(p).toMatch(/type_password action — the value is not shown to you/);
  });

  it("tells the model to refuse the things this system refuses", () => {
    expect(buildPrompt(ctx, screen)).toMatch(
      /CAPTCHA, a verification code, or says the account is blocked/,
    );
  });

  it("shows what has already been tried so it does not loop", () => {
    expect(buildPrompt(ctx, screen)).toMatch(/ALREADY TRIED/);
  });
});

describe("parsing a reply", () => {
  it("reads a tap", () => {
    expect(parseAction('{"action":"tap","label":"Next","why":"advance"}')).toEqual({
      action: "tap",
      label: "Next",
      why: "advance",
    });
  });

  it("tolerates a code fence or surrounding prose", () => {
    const out = parseAction('Sure!\n```json\n{"action":"done","why":"finished"}\n```');
    expect(out.action).toBe("done");
  });

  it("refuses an action outside the vocabulary", () => {
    expect(parseAction('{"action":"install_apk","why":"x"}').action).toBe("invalid");
  });

  it("refuses a keyevent that is not on the list", () => {
    expect(parseAction('{"action":"key","keyevent":"KEYCODE_POWER","why":"x"}').action).toBe(
      "invalid",
    );
  });

  it("refuses a tap with no target rather than guessing one", () => {
    expect(parseAction('{"action":"tap","why":"x"}').action).toBe("invalid");
  });

  it("refuses prose", () => {
    expect(parseAction("I would tap the Next button").action).toBe("invalid");
  });

  it("keeps a stuck reason for the operator", () => {
    const out = parseAction('{"action":"stuck","why":"a code was emailed and I must not read it"}');
    expect(out).toMatchObject({ action: "stuck" });
    expect(out.why).toMatch(/must not read it/);
  });
});

/**
 * The loop itself, with the model and the device both faked: what matters is
 * that guardrails run BEFORE the model is consulted, and that its answers are
 * bounded.
 */
