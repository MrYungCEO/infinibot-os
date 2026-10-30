/**
 * Field catalog for `infinibot.plugin.json` — the single source the manifest
 * reference (docs/plugins/manifest-reference.md) is generated from.
 *
 * Drift guards (manifest-fields.test.ts + the compiler):
 *  - the doc file must equal `renderManifestReference()` byte for byte;
 *  - the key records below are typed `Record<keyof …, true>`, so adding a
 *    field to PluginContributes / PluginPermissions / PluginListing /
 *    PluginUpdateBlock without listing it here fails `tsc`;
 *  - every key path used by a bundled plugin's manifest must be documented;
 *  - a manifest that uses every documented field must pass the real parser.
 *
 * Regenerate the doc: `node --import tsx scripts/gen-plugin-manifest-reference.ts`.
 */

import type { PluginListing } from "./listing.js";
import type { PluginContributes, PluginPermissions } from "./manifest-v2.js";
import type { PluginUpdateBlock } from "./packages/format.js";

export type ManifestFieldRequired =
  /** The loader refuses the plugin without it. */
  | "always"
  /** Required in a manifest-v2 plugin. */
  | "v2"
  /** Required to pack / install / publish a package. */
  | "package"
  | "no";

export type ManifestFieldStatus =
  /** Validated by the strict parser and acted on by the host. */
  | "enforced"
  /** Parsed leniently (a bad value is dropped with a warning). */
  | "lenient"
  /** Listed in Setup › Plugins (toggle, label) but the host does not act on it yet. */
  | "listed";

export type ManifestField = {
  path: string;
  type: string;
  required: ManifestFieldRequired;
  status: ManifestFieldStatus;
  description: string;
  /** The walker stops here: the value is free-form (schemas, maps, lists the host only lists). */
  opaque?: boolean;
};

const f = (
  path: string,
  type: string,
  description: string,
  opts: Partial<Pick<ManifestField, "required" | "status" | "opaque">> = {},
): ManifestField => ({
  path,
  type,
  description,
  required: opts.required ?? "no",
  status: opts.status ?? "enforced",
  ...(opts.opaque ? { opaque: true } : {}),
});

export type ManifestFieldGroup = { title: string; intro?: string; fields: ManifestField[] };

export const MANIFEST_FIELD_GROUPS: ManifestFieldGroup[] = [
  {
    title: "Identity and compatibility",
    fields: [
      f(
        "manifestVersion",
        "`2`",
        "Marks a declared-capability (v2) manifest. Omit only for legacy v1 plugins.",
        { required: "package" },
      ),
      f(
        "id",
        "string",
        "Unique plugin id. Packages: lowercase letters, digits and dashes, 2–64 characters, not a reserved word. It is the install folder, the RPC namespace (`<id>.*`) and the HTTP prefix (`/plugins/<id>/`).",
        { required: "always" },
      ),
      f("name", "string", "Display name, 64 characters or fewer.", { required: "package" }),
      f(
        "version",
        "semver",
        "`MAJOR.MINOR.PATCH` with optional `-prerelease` / `+build`. Updates compare versions by semver precedence.",
        { required: "package" },
      ),
      f("description", "string", "One or two sentences. Shown when the listing has no tagline."),
      f(
        "publisher",
        "string",
        "Your publisher id (lowercase, digits, dashes). Must match the registry entry for updates to apply.",
        { required: "package" },
      ),
      f("license", "string", "SPDX licence identifier."),
      f("homepage", "url", "Project home page."),
      f(
        "minHostVersion",
        "semver",
        "Oldest InfiniBot release that runs the plugin. Older hosts refuse to install or load it.",
        { required: "package" },
      ),
      f(
        "engines.infinibot-plugin-api",
        "semver range",
        "Plugin API range the plugin was built for, for example `^2.0.0`. The plugin loads only when the host's API version satisfies it.",
        { required: "v2" },
      ),
      f(
        "rpcNamespace",
        "string",
        "Prefix for the plugin's RPC methods when it differs from the id, for example `partscan` for the id `part-scan`. Lowercase letters, digits and hyphens. Defaults to the id; every `contributes.rpc` method must start with `<rpcNamespace>.`.",
      ),
      f(
        "kind",
        '`"memory"`',
        "Marks a memory plugin (one is active at a time, chosen by `plugins.slots.memory`).",
      ),
      f(
        "optionalPlugins[]",
        "string[]",
        "Ids of other plugins this one can work with. Not read by the host today.",
        { status: "listed" },
      ),
    ],
  },
  {
    title: "Settings",
    fields: [
      f(
        "configSchema",
        "JSON Schema",
        'Schema of the plugin\'s settings (`plugins.entries.<id>.config`). Use `{ "type": "object", "properties": {} }` when there are none. Setup › Plugins builds the settings form from it.',
        { required: "always", opaque: true },
      ),
      f(
        "uiHints",
        "object",
        "Per-setting form hints keyed by property name: `label`, `help`, `placeholder`, `advanced`, `sensitive` (write-only secret).",
        { opaque: true, status: "lenient" },
      ),
    ],
  },
  {
    title: "Legacy top-level lists",
    intro: "Read for every manifest version.",
    fields: [
      f("channels[]", "string[]", "Channel ids the plugin provides (`api.registerChannel`).", {
        status: "lenient",
      }),
      f("providers[]", "string[]", "Model or media provider ids the plugin provides.", {
        status: "lenient",
      }),
      f("skills[]", "string[]", "Folders (inside the plugin) of agent skills it ships.", {
        status: "lenient",
      }),
      f("ui.navLabel", "string", "Label of the plugin's panel in Setup › Plugins.", {
        status: "lenient",
      }),
      f("ui.navIcon", "string", "Icon name for that panel.", { status: "lenient" }),
      f(
        "ui.entry",
        "path",
        "HTTP path (under `/plugins/<id>/`) of the ES module that mounts the panel. See the UI guide.",
        { status: "lenient" },
      ),
    ],
  },
  {
    title: "Store listing",
    intro:
      "Shown in Setup › Plugins and on the marketplace. A malformed field is dropped with a warning when loading, and is an error when packing.",
    fields: [
      f("listing.tagline", "string", "One line under the name (140 characters).", {
        required: "package",
        status: "lenient",
      }),
      f("listing.description", "markdown", "Long description (20,000 characters).", {
        required: "package",
        status: "lenient",
      }),
      f(
        "listing.category",
        "slug",
        "`apps`, `channels`, `integrations`, `developer`, or another lowercase slug.",
        { status: "lenient" },
      ),
      f("listing.tags[]", "string[]", "Up to 12 tags, 32 characters each.", { status: "lenient" }),
      f(
        "listing.cover",
        "image path",
        "16:9 image inside the package (png, webp, jpg, gif, avif, svg) or a `data:image/…` URL of 256 KB or less.",
        { status: "lenient" },
      ),
      f("listing.icon", "image path", "Square image, same rules as `cover`.", {
        status: "lenient",
      }),
      f("listing.screenshots[].src", "image path", "Up to 8 screenshots, same rules as `cover`.", {
        status: "lenient",
      }),
      f("listing.screenshots[].caption", "string", "Caption (200 characters).", {
        status: "lenient",
      }),
      f("listing.publisher.name", "string", "Publisher display name.", { status: "lenient" }),
      f("listing.publisher.url", "url", "Publisher website (http or https).", {
        status: "lenient",
      }),
      f("listing.links.docs", "url", "Documentation link.", { status: "lenient" }),
      f("listing.links.support", "url", "Support link.", { status: "lenient" }),
      f("listing.links.source", "url", "Source code link.", { status: "lenient" }),
    ],
  },
  {
    title: "Updates",
    fields: [
      f(
        "update.registryUrl",
        "url",
        "Registry this plugin's updates come from, instead of the host's `plugins.registryUrl`. Must be https (http only for localhost). Ignored on InfiniBot Cloud.",
      ),
      f(
        "update.changelog",
        "path",
        "Changelog file inside the package shown in the install review. Default `CHANGELOG.md`.",
      ),
    ],
  },
  {
    title: "Permissions",
    intro:
      "Declared up front and shown to the owner before install. The owner can revoke each one; gated permissions start off.",
    fields: [
      f(
        "permissions.network[]",
        "string[]",
        "Hosts the plugin connects to. Key: `network:<host>`.",
        { required: "package" },
      ),
      f(
        "permissions.fs[]",
        "string[]",
        "Paths the plugin reads or writes outside its data folder. Key: `fs:<path>`.",
      ),
      f("permissions.exec", "boolean", "The plugin runs programs or commands. Key: `exec`."),
      f("permissions.secrets[]", "string[]", "Secret names it reads. Key: `secrets:<NAME>`."),
      f("permissions.channels[]", "string[]", "Channels it sends through. Key: `channels:<id>`."),
      f("permissions.credits", "boolean", "It spends credits. Key: `credits`."),
      f("permissions.phi", "boolean", "It stores protected health information."),
      f(
        "permissions.gated[].id",
        "string",
        "A high-risk capability that is OFF until the owner grants it. Key: `gated:<id>`.",
      ),
      f("permissions.gated[].label", "string", "Short name of the capability."),
      f("permissions.gated[].description", "string", "Consent text shown next to the switch."),
    ],
  },
  {
    title: "Appearance",
    intro:
      "Defaults for the plugin's own pages. Colours must be InfiniBot tokens (`token:<name>`). See the UI guide.",
    fields: [
      f("appearance.accent", "`token:<name>`", "Accent colour token."),
      f("appearance.tint", "`token:<name>` \\| `none`", "Surface tint token."),
      f("appearance.tintStrength", "number", "0 to 0.3."),
      f("appearance.density", "`compact` \\| `comfortable`", "Default spacing."),
      f("appearance.fontScale", "number", "0.85 to 1.3."),
      f("appearance.icon", "string", "Icon name."),
      f("appearance.monogram", "string", "Up to 3 characters shown when there is no icon."),
      f("appearance.layout[].id", "string", "Layout option id."),
      f("appearance.layout[].label", "string", "Label of the option."),
      f("appearance.layout[].type", "`select` \\| `toggle`", "Control type."),
      f(
        "appearance.layout[].options",
        "list",
        "Choices of a `select` (strings or `{ value, label }`).",
        { opaque: true },
      ),
      f("appearance.layout[].default", "string \\| boolean", "Default value."),
      f("appearance.variables[].name", "string", "CSS variable, namespaced `--plugin-<id>-*`."),
      f("appearance.variables[].label", "string", "Label shown in Setup › Plugins › Appearance."),
      f(
        "appearance.variables[].type",
        "`color` \\| `length` \\| `number` \\| `select`",
        "Variable type.",
      ),
      f(
        "appearance.variables[].default",
        "string \\| number",
        "Default (a colour default must be a token).",
      ),
      f(
        "appearance.variables[].role",
        "string",
        "How a colour is used (`text`, `ui`, …), for contrast checks.",
      ),
      f("appearance.variables[].options", "string[]", "Choices of a `select` variable.", {
        opaque: true,
      }),
      f("appearance.variables[].min", "number", "Lower bound of a number or length."),
      f("appearance.variables[].max", "number", "Upper bound of a number or length."),
    ],
  },
  {
    title: "Contributions the host enforces",
    intro:
      "Everything the plugin registers must be declared here; registering something undeclared is rejected. Any entry may add `requires: string[]` (permission keys it depends on): revoking one switches the entry off.",
    fields: [
      f(
        "contributes.*[].requires[]",
        "string[]",
        "Permission keys the entry needs (`exec`, `credits`, `network:<host>`, `secrets:<NAME>`, `channels:<id>`, `fs:<path>`, `gated:<id>`, or a bare category).",
      ),
      f("contributes.pages[].tab", "string", "Tab id of the page."),
      f("contributes.pages[].route", "path", "URL path of the page, for example `/my-plugin`."),
      f(
        "contributes.pages[].builtin",
        "string",
        "First-party page compiled into the control UI. A page needs `builtin` or `entry`.",
      ),
      f("contributes.pages[].entry", "path", "ES module the plugin serves under `/plugins/<id>/`."),
      f("contributes.pages[].title", "string", "Page title."),
      f("contributes.nav[].tab", "string", "Tab the entry opens; must match a `pages` entry."),
      f("contributes.nav[].label", "string", "Sidebar label."),
      f("contributes.nav[].icon", "string", "Icon name."),
      f(
        "contributes.nav[].group",
        "string",
        "Former sidebar group. Kept for compatibility; plugins now get their own section.",
      ),
      f("contributes.navSection.title", "string", "Heading of the plugin's sidebar section."),
      f(
        "contributes.navSection.order",
        "number",
        "Sort order among plugin sections (default 1000).",
      ),
      f("contributes.navSection.collapsedByDefault", "boolean", "Start collapsed."),
      f("contributes.navSection.items[].page", "string", "Tab of a `pages` entry."),
      f("contributes.navSection.items[].label", "string", "Label override."),
      f("contributes.navSection.items[].icon", "string", "Icon override."),
      f(
        "contributes.landing",
        "string",
        "Page tab that can become the start page when the owner sets `plugins.landing`.",
      ),
      f(
        "contributes.rpc[]",
        "list",
        "Gateway methods. An entry is a method name (scope `admin`) or `{ method, scope, aliases, requires }`.",
      ),
      f("contributes.rpc[].method", "string", "Gateway method, namespaced `<id>.*`."),
      f(
        "contributes.rpc[].scope",
        "`read` \\| `write` \\| `admin`",
        "Who may call it. Default `admin`.",
      ),
      f(
        "contributes.rpc[].aliases[]",
        "string[]",
        "Extra names served by the same handler (inherit the scope).",
      ),
      f("contributes.rpcAliases[].method", "string", "Legacy un-namespaced method name."),
      f("contributes.rpcAliases[].target", "string", "Declared `rpc` method that serves it."),
      f(
        "contributes.http[]",
        "path[]",
        "HTTP routes under `/plugins/<id>/`. An entry is a path string or `{ path, requires }`.",
      ),
      f("contributes.http[].path", "path", "Route path, in the object form."),
      f(
        "contributes.selfAuthHttp[]",
        "path[]",
        "Routes (also listed in `http`) the plugin authenticates itself, such as signed webhooks.",
      ),
      f(
        "contributes.tools[]",
        "string[]",
        "Agent tool names. An entry is a name or `{ name, trust, requires }`.",
      ),
      f("contributes.tools[].name", "string", "Tool name, in the object form."),
      f(
        "contributes.tools[].trust",
        "string",
        "Trust class shown in Setup › Plugins; `exec` adds the `exec` permission to `requires`.",
      ),
      f("contributes.panels[]", "string[]", "Chat panel kinds, namespaced `<id>.*`."),
      f("contributes.services[]", "string[]", "Background service ids (`api.registerService`)."),
      f(
        "contributes.voiceProviders[]",
        "string[]",
        "Voice provider ids (`api.registerVoiceProvider`).",
      ),
      f(
        "contributes.agents[]",
        "path[]",
        "Roster-agent JSON files inside the plugin, added while it is on.",
      ),
      f("contributes.mcpServers[].id", "string", "Id of a bundled stdio MCP server."),
      f("contributes.mcpServers[].label", "string", "Display label."),
      f("contributes.mcpServers[].command", "string", "Command that starts it."),
      f("contributes.mcpServers[].args[]", "string[]", "Command arguments."),
      f("contributes.clockSections[].id", "string", "Section id (`a-z0-9-`)."),
      f("contributes.clockSections[].label", "string", "Toggle label in the topbar clock."),
      f("contributes.clockSections[].description", "string", "Help text."),
      f("contributes.clockSections[].builtin", "string", "First-party renderer key."),
      f(
        "contributes.clockSections[].defaultEnabled",
        "boolean",
        "Initial toggle state (default true).",
      ),
      f("contributes.topbarSlots[].id", "string", "Slot id (`a-z0-9-`)."),
      f("contributes.topbarSlots[].label", "string", "Label."),
      f("contributes.topbarSlots[].description", "string", "Help text."),
      f("contributes.topbarSlots[].builtin", "string", "First-party renderer key."),
      f("contributes.topbarSlots[].order", "number", "Sort order (default 100)."),
      f(
        "contributes.topbarSlots[].placement",
        "`left` \\| `right`",
        "Topbar group (default `left`).",
      ),
      f("contributes.settings[].id", "string", "Settings section id (`a-z0-9-`)."),
      f("contributes.settings[].label", "string", "Section label."),
      f("contributes.settings[].description", "string", "Help text."),
      f("contributes.settings[].builtin", "string", "First-party renderer key."),
      f("contributes.settings[].order", "number", "Sort order (default 100)."),
      f(
        "contributes.setupChecks[].id",
        "string",
        "Check id, namespaced `<id>.*` (`api.registerSetupCheck`).",
      ),
      f("contributes.setupChecks[].title", "string", "What is being set up."),
      f(
        "contributes.setupChecks[].tabs[]",
        "string[]",
        "The plugin's own page tabs that glow while setup is needed.",
      ),
      f("contributes.setupChecks[].action.label", "string", "Button label of the default action."),
      f("contributes.setupChecks[].action.tab", "string", "Page tab the action opens."),
      f("contributes.setupChecks[].action.view", "string", "Optional sub-view."),
      f(
        "contributes.mapRoom.title",
        "string",
        "Sign on the plugin's room on the agent map (24 characters). `mapRoom: false` opts out.",
      ),
      f("contributes.mapRoom.theme", "string", "Room theme (see MAP-ROOMS.md)."),
      f("contributes.mapRoom.accent", "`token:<name>` \\| `#rrggbb`", "Room accent."),
      f(
        "contributes.mapRoom.props[]",
        "string[]",
        "Up to 12 props replacing the theme's furniture.",
      ),
      f("contributes.mapRoom.size", "`S` \\| `M` \\| `L`", "Room footprint."),
      f(
        "contributes.mapRoom.placement",
        "`auto` \\| `north` \\| `east` \\| `south` \\| `west`",
        "Preferred side of the plugin district.",
      ),
      f(
        "contributes.learn",
        "object \\| path",
        "Guided Learn tracks, inline or a `.json` file inside the plugin (see LEARN.md).",
        { opaque: true },
      ),
      f("contributes.importers[].id", "string", "Data importer id (Setup › Plugins › Data).", {
        status: "lenient",
      }),
      f("contributes.importers[].label", "string", "Label.", { status: "lenient" }),
      f("contributes.importers[].description", "string", "Help text.", { status: "lenient" }),
      f("contributes.importers[].method", "string", "Declared `rpc` method that runs the import.", {
        status: "lenient",
      }),
      f("contributes.importers[].accept", "string", "File types the picker accepts.", {
        status: "lenient",
      }),
      f(
        "contributes.importers[].input",
        "`file` \\| `none`",
        "`none` shows a run button instead of a file picker.",
        { status: "lenient" },
      ),
    ],
  },
  {
    title: "Contributions that are listed only",
    intro:
      "These blocks appear in Setup › Plugins (with an on/off switch where it makes sense), but the host does not act on them yet. Declare them only to describe what your code already does through the plugin API.",
    fields: [
      f(
        "contributes.cron[]",
        "object[]",
        "Scheduled jobs: `id`, `label`, `schedule`, `description`, `defaultEnabled`.",
        { status: "listed", opaque: true },
      ),
      f(
        "contributes.subviews[]",
        "object[]",
        "Sub-views inside a host page: `id`, `label`, `host`.",
        { status: "listed", opaque: true },
      ),
      f("contributes.widgets[]", "object[]", "Dashboard widgets: `id`, `label`, `surface`.", {
        status: "listed",
        opaque: true,
      }),
      f("contributes.overlays[]", "object[]", "Overlays: `id`, `label`, `trigger`.", {
        status: "listed",
        opaque: true,
      }),
      f("contributes.launchpad[]", "object[]", "Launchpad entries: `id`, `label`.", {
        status: "listed",
        opaque: true,
      }),
      f("contributes.mapLayers[]", "object[]", "Map layers: `id`, `label`.", {
        status: "listed",
        opaque: true,
      }),
      f("contributes.panelKinds[]", "object[]", "Older form of `panels`: `id`, `label`.", {
        status: "listed",
        opaque: true,
      }),
      f("contributes.skills[]", "list", "Skills, as paths or `{ path }`.", {
        status: "listed",
        opaque: true,
      }),
      f("contributes.roster[]", "object[]", "Older form of `agents`: `agentId`, `label`.", {
        status: "listed",
        opaque: true,
      }),
      f("contributes.channels[]", "list", "Channels, as ids or `{ id }`.", {
        status: "listed",
        opaque: true,
      }),
      f("contributes.providers[]", "list", "Providers, as ids or `{ id, label, kind }`.", {
        status: "listed",
        opaque: true,
      }),
      f("contributes.hooks[]", "list", "Hooks, as event names or `{ event }`.", {
        status: "listed",
        opaque: true,
      }),
      f(
        "contributes.sidecars[]",
        "object[]",
        "Sidecar containers: `id`, `label`, `image`. Not supervised by the host.",
        { status: "listed", opaque: true },
      ),
    ],
  },
];

export const MANIFEST_FIELDS: ManifestField[] = MANIFEST_FIELD_GROUPS.flatMap((g) => g.fields);

// ── compile-time drift guards ────────────────────────────────────────────
// Adding a key to one of these types without adding it here is a type error.

export const CONTRIBUTES_KEYS: Record<keyof PluginContributes, true> = {
  nav: true,
  pages: true,
  rpc: true,
  rpcAliases: true,
  http: true,
  selfAuthHttp: true,
  services: true,
  voiceProviders: true,
  agents: true,
  landing: true,
  tools: true,
  panels: true,
  navSection: true,
  mcpServers: true,
  clockSections: true,
  topbarSlots: true,
  settings: true,
  learn: true,
  setupChecks: true,
  mapRoom: true,
};

export const PERMISSION_KEYS: Record<keyof PluginPermissions, true> = {
  network: true,
  fs: true,
  exec: true,
  secrets: true,
  channels: true,
  credits: true,
  phi: true,
  gated: true,
};

export const LISTING_KEYS: Record<keyof PluginListing, true> = {
  tagline: true,
  description: true,
  category: true,
  tags: true,
  cover: true,
  icon: true,
  screenshots: true,
  publisher: true,
  links: true,
};

export const UPDATE_KEYS: Record<keyof PluginUpdateBlock, true> = {
  registryUrl: true,
  changelog: true,
};

const REQUIRED_LABEL: Record<ManifestFieldRequired, string> = {
  always: "Yes",
  v2: "Yes (v2)",
  package: "For packages",
  no: "No",
};

const STATUS_LABEL: Record<ManifestFieldStatus, string> = {
  enforced: "Enforced",
  lenient: "Lenient",
  listed: "Listed only",
};

/** The manifest reference, as markdown. docs/plugins/manifest-reference.md is exactly this. */
export function renderManifestReference(): string {
  const out: string[] = [
    "# Manifest reference",
    "",
    "<!-- GENERATED from src/plugins/manifest-fields.ts. Do not edit by hand:",
    "     run `node --import tsx scripts/gen-plugin-manifest-reference.ts`. A test fails when this file is stale. -->",
    "",
    "Every field of `infinibot.plugin.json` for manifest-v2 plugins. The file sits at the root of the plugin folder (and of the package zip).",
    "",
    "How to read the tables:",
    "",
    "- **Required** — `Yes`: the loader refuses the plugin without it. `Yes (v2)`: required in a v2 manifest. `For packages`: required to pack, install or publish a plugin package. `No`: optional.",
    "- **Status** — `Enforced`: validated strictly; a bad value stops the plugin from loading. `Lenient`: a bad value is dropped with a warning. `Listed only`: shown in Setup › Plugins, but the host does not act on it yet.",
    "- A path such as `contributes.pages[].tab` means the `tab` field of each item in the `contributes.pages` list.",
    "",
    "See also: [getting started](getting-started.md), [packaging](packaging.md), [updates](updates.md), [API reference](api-reference.md), [security model](security-model.md).",
    "",
  ];
  for (const group of MANIFEST_FIELD_GROUPS) {
    out.push(`## ${group.title}`, "");
    if (group.intro) out.push(group.intro, "");
    out.push(
      "| Field | Type | Required | Status | Description |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const field of group.fields) {
      out.push(
        `| \`${field.path}\` | ${field.type} | ${REQUIRED_LABEL[field.required]} | ${STATUS_LABEL[field.status]} | ${field.description} |`,
      );
    }
    out.push("");
  }
  out.push(
    "## Minimal package manifest",
    "",
    "```json",
    JSON.stringify(
      {
        manifestVersion: 2,
        id: "my-plugin",
        name: "My Plugin",
        version: "1.0.0",
        publisher: "my-publisher",
        minHostVersion: "2026.6.30",
        engines: { "infinibot-plugin-api": "^2.0.0" },
        listing: {
          tagline: "What it does in one line.",
          description: "A longer **markdown** description.",
        },
        configSchema: { type: "object", properties: {} },
        contributes: {},
        permissions: {},
      },
      null,
      2,
    ),
    "```",
    "",
  );
  return out.join("\n");
}

/**
 * Leaf key paths of a raw manifest in the catalog's notation. Descent stops
 * at fields the catalog marks `opaque`; `requires` on any contribution entry
 * collapses to `contributes.*[].requires[]`.
 */
export function manifestKeyPaths(raw: unknown): string[] {
  const opaque = new Set(MANIFEST_FIELDS.filter((x) => x.opaque).map((x) => x.path));
  const out = new Set<string>();
  const walk = (value: unknown, path: string) => {
    if (opaque.has(path) || opaque.has(`${path}[]`)) {
      out.add(opaque.has(path) ? path : `${path}[]`);
      return;
    }
    if (/^contributes\.[A-Za-z]+\[\]\.requires$/.test(path)) {
      out.add("contributes.*[].requires[]");
      return;
    }
    // Empty lists and objects declare nothing.
    if (Array.isArray(value)) {
      for (const item of value) walk(item, `${path}[]`);
      return;
    }
    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        walk(v, path ? `${path}.${k}` : k);
      }
      return;
    }
    out.add(path);
  };
  walk(raw, "");
  return [...out].sort();
}
