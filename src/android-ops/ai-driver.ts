/**
 * AI-driven step execution.
 *
 * The hand-written runner in auto-runner.ts knows one path: the selectors that
 * were true for one app on one day. Real signup flows branch — a phone-number
 * step here, an interstitial there, a rename because the handle was taken — and
 * a fixed script stops at the first screen nobody anticipated.
 *
 * This asks a model instead. Each turn it sends the goal, the account's own
 * details, and the CURRENT screen as a flat list of controls, and gets back one
 * action. It executes that action, re-reads the screen, and asks again. When it
 * cannot make progress it is expected to say so, with a reason — that is the
 * troubleshooting half, and it is worth more than a silent retry.
 *
 * Two things are deliberately NOT delegated:
 *   - The safety checks. detectBlocker() runs before the model is consulted, so
 *     a CAPTCHA or a platform block halts the run whatever the model would say.
 *   - The action vocabulary. Anything outside tap/type/key/scroll/done/stuck is
 *     rejected here rather than passed to the device.
 *
 * The password is never put in a prompt. When a step needs it typed, the driver
 * emits a `type_password` action and the caller substitutes the value from the
 * vault at execution time.
 */
import type { UiNode } from "./ui-automation.js";

export interface AiScreenContext {
  goal: string;
  platform: string;
  handle: string;
  displayName: string | null;
  bio: string | null;
  recoveryEmail: string | null;
  /** What has already been tried, so the model does not loop. */
  history: string[];
}

export type AiAction =
  | { action: "tap"; label: string; why: string }
  | { action: "type"; label: string; text: string; why: string }
  | { action: "type_password"; label: string; why: string }
  | { action: "key"; keyevent: string; why: string }
  | { action: "scroll"; direction: "up" | "down"; why: string }
  | { action: "done"; why: string }
  | { action: "stuck"; why: string };

const KEYEVENTS = new Set([
  "KEYCODE_BACK",
  "KEYCODE_HOME",
  "KEYCODE_ENTER",
  "KEYCODE_TAB",
  "KEYCODE_DEL",
]);

/** One line per control, which is all the model needs to choose a target. */
export function describeScreen(nodes: UiNode[], limit = 60): string {
  const interesting = nodes.filter(
    (n) => n.text.trim() || n.contentDesc.trim() || n.className.includes("EditText"),
  );
  return interesting
    .slice(0, limit)
    .map((n, i) => {
      const label = (n.text.trim() || n.contentDesc.trim() || "").slice(0, 60);
      const kind = n.className.split(".").pop() ?? n.className;
      const flags = [n.clickable ? "clickable" : "", n.password ? "password" : ""]
        .filter(Boolean)
        .join(",");
      return `${i}. "${label}" [${kind}${flags ? " " + flags : ""}]`;
    })
    .join("\n");
}

export function buildPrompt(ctx: AiScreenContext, nodes: UiNode[]): string {
  return [
    "You are driving an Android handset to complete one step of an account setup run.",
    "",
    `GOAL: ${ctx.goal}`,
    `PLATFORM: ${ctx.platform}`,
    "",
    "ACCOUNT DETAILS you may type (use these exact values):",
    `  username: ${ctx.handle}`,
    `  display name: ${ctx.displayName ?? "(not set)"}`,
    `  bio: ${ctx.bio ?? "(not set)"}`,
    `  email: ${ctx.recoveryEmail ?? "(not set)"}`,
    "  password: use the type_password action — the value is not shown to you",
    "",
    "SCREEN (each line is a control; refer to one by its exact label text):",
    describeScreen(nodes),
    "",
    ctx.history.length
      ? `ALREADY TRIED (do not repeat a failed action):\n${ctx.history
          .slice(-8)
          .map((h) => "  " + h)
          .join("\n")}`
      : "",
    "",
    "Reply with ONE action as strict JSON, no prose, no code fence:",
    '  {"action":"tap","label":"<exact label on screen>","why":"..."}',
    '  {"action":"type","label":"<field label>","text":"<value>","why":"..."}',
    '  {"action":"type_password","label":"<field label>","why":"..."}',
    '  {"action":"key","keyevent":"KEYCODE_BACK|KEYCODE_ENTER|KEYCODE_HOME|KEYCODE_TAB|KEYCODE_DEL","why":"..."}',
    '  {"action":"scroll","direction":"up|down","why":"..."}',
    '  {"action":"done","why":"the goal is complete"}',
    '  {"action":"stuck","why":"what is wrong and what a human should do"}',
    "",
    "Rules:",
    "- Choose from the controls listed. Do not invent a label that is not on screen.",
    "- If the screen asks for a CAPTCHA, a verification code, or says the account is blocked, answer stuck — you must not attempt those.",
    "- If the same action has already failed, try a different one or answer stuck.",
    "- Prefer the email path over a phone-number path when both are offered.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** Parse a model reply into an action, refusing anything outside the vocabulary. */
export function parseAction(raw: string): AiAction | { action: "invalid"; why: string } {
  const text = String(raw ?? "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return { action: "invalid", why: "no JSON object in the reply" };
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { action: "invalid", why: "reply was not valid JSON" };
  }
  const why = String(parsed.why ?? "").slice(0, 300);
  const label = String(parsed.label ?? "").trim();
  switch (parsed.action) {
    case "tap":
      if (!label) return { action: "invalid", why: "tap needs a label" };
      return { action: "tap", label, why };
    case "type": {
      const value = String(parsed.text ?? "");
      if (!label || !value) return { action: "invalid", why: "type needs a label and text" };
      return { action: "type", label, text: value, why };
    }
    case "type_password":
      if (!label) return { action: "invalid", why: "type_password needs a label" };
      return { action: "type_password", label, why };
    case "key": {
      const keyevent = String(parsed.keyevent ?? "").trim();
      if (!KEYEVENTS.has(keyevent))
        return { action: "invalid", why: `keyevent ${keyevent} is not permitted` };
      return { action: "key", keyevent, why };
    }
    case "scroll": {
      const direction = parsed.direction === "up" ? "up" : "down";
      return { action: "scroll", direction, why };
    }
    case "done":
      return { action: "done", why };
    case "stuck":
      return { action: "stuck", why: why || "no reason given" };
    default:
      return { action: "invalid", why: `unknown action ${String(parsed.action)}` };
  }
}
