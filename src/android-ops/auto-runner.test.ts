/**
 * These pin the stop conditions. A runner that keeps typing into a CAPTCHA, or
 * that taps blind when it cannot find a control, is the failure mode this file
 * exists to prevent — so the interesting assertions are all about halting.
 */
import { describe, it, expect } from "vitest";
import { automateStep, type AutomationDriver } from "./auto-runner.js";

const node = (attrs: Record<string, string>) =>
  `<node ${Object.entries(attrs)
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ")}>`;
const screen = (...texts: Array<{ text?: string; id?: string; cls?: string }>) =>
  `<hierarchy>${texts
    .map((t, i) =>
      node({
        text: t.text ?? "",
        "resource-id": t.id ?? "",
        class: t.cls ?? "android.widget.TextView",
        "content-desc": "",
        clickable: "true",
        focused: "false",
        password: "false",
        bounds: `[0,${i * 100}][720,${i * 100 + 80}]`,
      }),
    )
    .join("")}</hierarchy>`;

function driverOf(screens: string[]) {
  const calls: string[] = [];
  let i = 0;
  const driver: AutomationDriver = {
    dump: async () => screens[Math.min(i++, screens.length - 1)],
    tap: async (x, y) => {
      calls.push(`tap:${x},${y}`);
    },
    type: async (t) => {
      calls.push(`type:${t}`);
    },
    key: async (k) => {
      calls.push(`key:${k}`);
    },
    launch: async (p) => {
      calls.push(`launch:${p}`);
    },
    wait: async () => {},
  };
  return { driver, calls };
}

const ctx = {
  platform: "instagram",
  handle: "demo.acct",
  displayName: "Demo Studio",
  bio: "Daily builds.",
  recoveryEmail: "demo.acct@ops.example",
  password: null,
};

describe("signup automation", () => {
  it("halts on a CAPTCHA instead of continuing", async () => {
    const { driver, calls } = driverOf([
      screen({ text: "Security check" }, { text: "Confirm you're human" }),
    ]);
    const out = await automateStep("signup", driver, ctx);
    expect(out.status).toBe("blocked");
    if (out.status === "blocked") expect(out.blocker.kind).toBe("captcha");
    // it launched the app and then stopped — no taps, no typing
    expect(calls.filter((c) => c.startsWith("tap") || c.startsWith("type"))).toHaveLength(0);
  });

  it("halts on a verification prompt rather than trying to satisfy it", async () => {
    const { driver } = driverOf([
      screen({ text: "Sign up" }),
      screen({ text: "We sent you a code" }, { text: "Enter the confirmation code" }),
    ]);
    const out = await automateStep("signup", driver, ctx);
    expect(out.status).toBe("blocked");
    if (out.status === "blocked") expect(out.blocker.kind).toBe("human_verification");
  });

  it("asks for the operator when no signup entry point is on screen", async () => {
    const { driver, calls } = driverOf([screen({ text: "Log in" }, { text: "Forgot password" })]);
    const out = await automateStep("signup", driver, ctx);
    expect(out.status).toBe("needs_operator");
    if (out.status === "needs_operator") expect(out.reason).toMatch(/signup entry point/i);
    expect(calls.some((c) => c.startsWith("type"))).toBe(false);
  });

  it("fills what it can, then hands over before verification", async () => {
    const { driver, calls } = driverOf([
      screen({ text: "Create new account" }),
      screen({
        text: "Sign up",
        id: "com.instagram.android:id/email_field",
        cls: "android.widget.EditText",
      }),
    ]);
    const out = await automateStep("signup", driver, ctx);
    expect(calls).toContain("launch:com.instagram.android");
    expect(calls.some((c) => c === "type:demo.acct@ops.example")).toBe(true);
    expect(out.status).toBe("needs_operator");
    if (out.status === "needs_operator") expect(out.reason).toMatch(/rest is yours/i);
  });
});

describe("profile automation", () => {
  it("applies the authored copy and advances", async () => {
    const { driver, calls } = driverOf([
      screen({ text: "Edit profile" }),
      screen({
        text: "",
        id: "com.instagram.android:id/full_name",
        cls: "android.widget.EditText",
      }),
      screen({ text: "", id: "com.instagram.android:id/bio", cls: "android.widget.EditText" }),
    ]);
    const out = await automateStep("profile", driver, ctx);
    expect(out.status).toBe("advanced");
    expect(calls).toContain("type:Demo Studio");
    expect(calls).toContain("type:Daily builds.");
  });

  it("stops when the editor is not open rather than tapping blind", async () => {
    const { driver, calls } = driverOf([screen({ text: "Home feed" })]);
    const out = await automateStep("profile", driver, ctx);
    expect(out.status).toBe("needs_operator");
    expect(calls.some((c) => c.startsWith("type"))).toBe(false);
  });
});

describe("steps this runner will not touch", () => {
  it("hands verification straight back", async () => {
    const { driver, calls } = driverOf([screen({ text: "anything" })]);
    const out = await automateStep("verification", driver, ctx);
    expect(out.status).toBe("needs_operator");
    if (out.status === "needs_operator") expect(out.reason).toMatch(/yours to clear/i);
    expect(calls).toHaveLength(0);
  });

  it("hands 2FA straight back", async () => {
    const { driver } = driverOf([screen({ text: "anything" })]);
    const out = await automateStep("two_factor", driver, ctx);
    expect(out.status).toBe("needs_operator");
  });
});
