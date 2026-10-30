import { Type } from "@sinclair/typebox";

import { optionalStringEnum, stringEnum } from "../schema/typebox.js";

const BROWSER_ACT_KINDS = [
  "click",
  "type",
  "press",
  "hover",
  "drag",
  "select",
  "fill",
  "resize",
  "wait",
  "evaluate",
  "close",
] as const;

const BROWSER_TOOL_ACTIONS = [
  "status",
  "start",
  "stop",
  "profiles",
  "tabs",
  "open",
  "focus",
  "close",
  "snapshot",
  "screenshot",
  "navigate",
  "console",
  "pdf",
  "upload",
  "dialog",
  "act",
  // Self-healing / skill-building surface. `exec` runs ad-hoc JS in the
  // current page; `skill.*` persists/loads reusable approaches under
  // skills/browser/<name>.js so repeat workflows skip re-derivation.
  "exec",
  "skill.save",
  "skill.call",
  "skill.list",
  // ─── Profile + session management ──────────────────────────
  // The "infini" profile is the canonical persistent Chrome profile —
  // cookies, logins, extensions, history all live under
  // ~/.infinibot/chrome-profile/infini/. These actions let the agent
  // manage that profile (and any custom ones) without touching the
  // filesystem directly.
  "profile.use_infini",
  "profile.create",
  "profile.list",
  "profile.info",
  "profile.delete",
  "profile.snapshot",
  "profile.snapshots",
  "profile.restore",
  "profile.delete_snapshot",
  "nav_policy.get",
  "nav_policy.set",
  // ─── Cookie + storage tooling ──────────────────────────────
  // Export/import Playwright-format storageState JSON (cookies +
  // localStorage). Lets you back up auth before a destructive run,
  // bootstrap a sandboxed profile with just the cookies it needs, or
  // move a session to another machine.
  "storage.export",
  "storage.import",
  "cookies.export",
  "cookies.import",
  "cookies.clear",
] as const;

const BROWSER_TARGETS = ["sandbox", "host", "node"] as const;

const BROWSER_SNAPSHOT_FORMATS = ["aria", "ai"] as const;
const BROWSER_SNAPSHOT_MODES = ["efficient"] as const;
const BROWSER_SNAPSHOT_REFS = ["role", "aria"] as const;

const BROWSER_IMAGE_TYPES = ["png", "jpeg"] as const;

// NOTE: Using a flattened object schema instead of Type.Union([Type.Object(...), ...])
// because Claude API on Vertex AI rejects nested anyOf schemas as invalid JSON Schema.
// The discriminator (kind) determines which properties are relevant; runtime validates.
const BrowserActSchema = Type.Object({
  kind: stringEnum(BROWSER_ACT_KINDS),
  // Common fields
  targetId: Type.Optional(Type.String()),
  ref: Type.Optional(Type.String()),
  // click
  doubleClick: Type.Optional(Type.Boolean()),
  button: Type.Optional(Type.String()),
  modifiers: Type.Optional(Type.Array(Type.String())),
  // type
  text: Type.Optional(Type.String()),
  submit: Type.Optional(Type.Boolean()),
  slowly: Type.Optional(Type.Boolean()),
  // press
  key: Type.Optional(Type.String()),
  // drag
  startRef: Type.Optional(Type.String()),
  endRef: Type.Optional(Type.String()),
  // select
  values: Type.Optional(Type.Array(Type.String())),
  // fill - use permissive array of objects
  fields: Type.Optional(Type.Array(Type.Object({}, { additionalProperties: true }))),
  // resize
  width: Type.Optional(Type.Number()),
  height: Type.Optional(Type.Number()),
  // wait
  timeMs: Type.Optional(Type.Number()),
  textGone: Type.Optional(Type.String()),
  // evaluate
  fn: Type.Optional(Type.String()),
});

// IMPORTANT: OpenAI function tool schemas must have a top-level `type: "object"`.
// A root-level `Type.Union([...])` compiles to `{ anyOf: [...] }` (no `type`),
// which OpenAI rejects ("Invalid schema ... type: None"). Keep this schema an object.
export const LegacyBrowserToolSchema = Type.Object({
  action: stringEnum(BROWSER_TOOL_ACTIONS),
  target: optionalStringEnum(BROWSER_TARGETS),
  node: Type.Optional(Type.String()),
  profile: Type.Optional(Type.String()),
  targetUrl: Type.Optional(Type.String()),
  targetId: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Number()),
  maxChars: Type.Optional(Type.Number()),
  mode: optionalStringEnum(BROWSER_SNAPSHOT_MODES),
  snapshotFormat: optionalStringEnum(BROWSER_SNAPSHOT_FORMATS),
  refs: optionalStringEnum(BROWSER_SNAPSHOT_REFS),
  interactive: Type.Optional(Type.Boolean()),
  compact: Type.Optional(Type.Boolean()),
  depth: Type.Optional(Type.Number()),
  selector: Type.Optional(Type.String()),
  frame: Type.Optional(Type.String()),
  labels: Type.Optional(Type.Boolean()),
  fullPage: Type.Optional(Type.Boolean()),
  ref: Type.Optional(Type.String()),
  element: Type.Optional(Type.String()),
  type: optionalStringEnum(BROWSER_IMAGE_TYPES),
  level: Type.Optional(Type.String()),
  paths: Type.Optional(Type.Array(Type.String())),
  inputRef: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number()),
  accept: Type.Optional(Type.Boolean()),
  promptText: Type.Optional(Type.String()),
  request: Type.Optional(BrowserActSchema),
  // exec / skill.* fields
  code: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  argsSignature: Type.Optional(Type.String()),
  args: Type.Optional(Type.Object({}, { additionalProperties: true })),
  // profile.* / cookies.* / storage.* fields
  profileName: Type.Optional(
    Type.String({
      description:
        "Target profile name for profile.* and cookies.* / storage.* actions. Default: 'infini'. Use 'infini' for the persistent daily-driver profile (logged-in cookies live here). Create or pick another name for sandboxed/ephemeral work.",
    }),
  ),
  label: Type.Optional(
    Type.String({
      description: "Free-form label attached to a profile snapshot.",
    }),
  ),
  archivePath: Type.Optional(
    Type.String({
      description:
        "Absolute path to a snapshot .tar.gz for profile.restore / profile.delete_snapshot.",
    }),
  ),
  filePath: Type.Optional(
    Type.String({
      description:
        "Absolute path to read or write a storageState / cookies JSON file. Default: stored under ~/.infinibot/chrome-profile-storage/ keyed by profile + timestamp.",
    }),
  ),
  importMode: Type.Optional(stringEnum(["merge", "replace"] as const)),
  originsFilter: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Restrict storage.export to specific origins (e.g. ['https://github.com', 'https://notion.so']) to ship only the cookies an agent needs.",
    }),
  ),
  confirmInfini: Type.Optional(
    Type.Boolean({
      description:
        "Must be true to delete the 'infini' profile (typo protection — the canonical profile holds real logins).",
    }),
  ),
  navPolicy: Type.Optional(
    Type.Object(
      {
        allowedSchemes: Type.Optional(Type.Array(Type.String())),
        allowPrivateHosts: Type.Optional(Type.Array(Type.String())),
        allowPrivateNetworks: Type.Optional(Type.Boolean()),
        denyHosts: Type.Optional(Type.Array(Type.String())),
      },
      { additionalProperties: false },
    ),
  ),
});
