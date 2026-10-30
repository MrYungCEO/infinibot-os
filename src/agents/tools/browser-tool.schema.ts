import { Type } from "@sinclair/typebox";

import { optionalStringEnum, stringEnum } from "../schema/typebox.js";

/**
 * One flat object, few fields, plain names: local models (Ollama Qwen) fill
 * this reliably; nested `request` objects and 60-value enums they did not.
 * Keep the root `type: "object"` (OpenAI rejects a root anyOf) and no unions
 * (Vertex rejects nested anyOf).
 */
export const BROWSER_TOOL_ACTIONS = [
  "open",
  "snapshot",
  "click",
  "type",
  "select",
  "check",
  "uncheck",
  "press",
  "scroll",
  "wait",
  "screenshot",
  "tabs",
  "tab",
  "new_tab",
  "close_tab",
  "back",
  "forward",
  "reload",
  "resize",
  "evaluate",
  "status",
  "profiles",
] as const;

const SCROLL_DIRECTIONS = ["down", "up", "bottom", "top"] as const;

export const BrowserToolSchema = Type.Object({
  action: stringEnum(BROWSER_TOOL_ACTIONS, {
    description:
      "What to do. Start with open; then click/type/select using refs from the snapshot.",
  }),
  url: Type.Optional(Type.String({ description: "open / new_tab: the address to load." })),
  ref: Type.Optional(
    Type.String({
      description: 'Element id from the latest snapshot, e.g. "e12" (inside iframes like "f1e3").',
    }),
  ),
  text: Type.Optional(
    Type.String({
      description:
        "type: the text to enter. click/check/scroll: visible label of the element when you have no ref. wait: text to wait for.",
    }),
  ),
  value: Type.Optional(
    Type.String({
      description: 'select: the visible option. resize: dimensions such as "390x844".',
    }),
  ),
  key: Type.Optional(
    Type.String({ description: 'press: a key such as "Enter", "Escape", "Tab", "PageDown".' }),
  ),
  submit: Type.Optional(Type.Boolean({ description: "type: press Enter after typing." })),
  direction: optionalStringEnum(SCROLL_DIRECTIONS, {
    description: "scroll: down/up one screen, or jump to bottom/top.",
  }),
  index: Type.Optional(
    Type.Number({ description: "tab / close_tab: tab number from action tabs (1 = first)." }),
  ),
  ms: Type.Optional(
    Type.Number({ description: "wait: max milliseconds to wait (default 15000)." }),
  ),
  fullPage: Type.Optional(
    Type.Boolean({ description: "screenshot: capture the whole page, not just the screen." }),
  ),
  code: Type.Optional(
    Type.String({ description: "evaluate: JavaScript run in the page; use return for a value." }),
  ),
  screenshot: Type.Optional(
    Type.Boolean({ description: "Also return a screenshot after this action." }),
  ),
  maxChars: Type.Optional(
    Type.Number({ description: "snapshot: max characters of page text to return." }),
  ),
  profile: Type.Optional(
    Type.String({
      description:
        'Browser profile (saved cookies/logins). Default "default" — the browser the user sees in InfiniBot. Use another name, e.g. "work", for a separate set of logins; "chrome" = the user\'s own Chrome via the Browser Relay extension.',
    }),
  ),
  approvalId: Type.Optional(
    Type.String({
      description:
        "Retry token returned by a prior approval_required browser result. Wait for approval, then repeat the exact action with this id.",
    }),
  ),
  node: Type.Optional(
    Type.String({
      description: "Federation device to run on instead of this computer (rarely needed).",
    }),
  ),
});
