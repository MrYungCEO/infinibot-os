# Manifest reference

<!-- GENERATED from src/plugins/manifest-fields.ts. Do not edit by hand:
     run `node --import tsx scripts/gen-plugin-manifest-reference.ts`. A test fails when this file is stale. -->

Every field of `infinibot.plugin.json` for manifest-v2 plugins. The file sits at the root of the plugin folder (and of the package zip).

How to read the tables:

- **Required** — `Yes`: the loader refuses the plugin without it. `Yes (v2)`: required in a v2 manifest. `For packages`: required to pack, install or publish a plugin package. `No`: optional.
- **Status** — `Enforced`: validated strictly; a bad value stops the plugin from loading. `Lenient`: a bad value is dropped with a warning. `Listed only`: shown in Setup › Plugins, but the host does not act on it yet.
- A path such as `contributes.pages[].tab` means the `tab` field of each item in the `contributes.pages` list.

See also: [getting started](getting-started.md), [packaging](packaging.md), [updates](updates.md), [API reference](api-reference.md), [security model](security-model.md).

## Identity and compatibility

| Field | Type | Required | Status | Description |
| --- | --- | --- | --- | --- |
| `manifestVersion` | `2` | For packages | Enforced | Marks a declared-capability (v2) manifest. Omit only for legacy v1 plugins. |
| `id` | string | Yes | Enforced | Unique plugin id. Packages: lowercase letters, digits and dashes, 2–64 characters, not a reserved word. It is the install folder, the RPC namespace (`<id>.*`) and the HTTP prefix (`/plugins/<id>/`). |
| `name` | string | For packages | Enforced | Display name, 64 characters or fewer. |
| `version` | semver | For packages | Enforced | `MAJOR.MINOR.PATCH` with optional `-prerelease` / `+build`. Updates compare versions by semver precedence. |
| `description` | string | No | Enforced | One or two sentences. Shown when the listing has no tagline. |
| `publisher` | string | For packages | Enforced | Your publisher id (lowercase, digits, dashes). Must match the registry entry for updates to apply. |
| `license` | string | No | Enforced | SPDX licence identifier. |
| `homepage` | url | No | Enforced | Project home page. |
| `minHostVersion` | semver | For packages | Enforced | Oldest InfiniBot release that runs the plugin. Older hosts refuse to install or load it. |
| `engines.infinibot-plugin-api` | semver range | Yes (v2) | Enforced | Plugin API range the plugin was built for, for example `^2.0.0`. The plugin loads only when the host's API version satisfies it. |
| `rpcNamespace` | string | No | Enforced | Prefix for the plugin's RPC methods when it differs from the id, for example `partscan` for the id `part-scan`. Lowercase letters, digits and hyphens. Defaults to the id; every `contributes.rpc` method must start with `<rpcNamespace>.`. |
| `kind` | `"memory"` | No | Enforced | Marks a memory plugin (one is active at a time, chosen by `plugins.slots.memory`). |
| `optionalPlugins[]` | string[] | No | Listed only | Ids of other plugins this one can work with. Not read by the host today. |

## Settings

| Field | Type | Required | Status | Description |
| --- | --- | --- | --- | --- |
| `configSchema` | JSON Schema | Yes | Enforced | Schema of the plugin's settings (`plugins.entries.<id>.config`). Use `{ "type": "object", "properties": {} }` when there are none. Setup › Plugins builds the settings form from it. |
| `uiHints` | object | No | Lenient | Per-setting form hints keyed by property name: `label`, `help`, `placeholder`, `advanced`, `sensitive` (write-only secret). |

## Legacy top-level lists

Read for every manifest version.

| Field | Type | Required | Status | Description |
| --- | --- | --- | --- | --- |
| `channels[]` | string[] | No | Lenient | Channel ids the plugin provides (`api.registerChannel`). |
| `providers[]` | string[] | No | Lenient | Model or media provider ids the plugin provides. |
| `skills[]` | string[] | No | Lenient | Folders (inside the plugin) of agent skills it ships. |
| `ui.navLabel` | string | No | Lenient | Label of the plugin's panel in Setup › Plugins. |
| `ui.navIcon` | string | No | Lenient | Icon name for that panel. |
| `ui.entry` | path | No | Lenient | HTTP path (under `/plugins/<id>/`) of the ES module that mounts the panel. See the UI guide. |

## Store listing

Shown in Setup › Plugins and on the marketplace. A malformed field is dropped with a warning when loading, and is an error when packing.

| Field | Type | Required | Status | Description |
| --- | --- | --- | --- | --- |
| `listing.tagline` | string | For packages | Lenient | One line under the name (140 characters). |
| `listing.description` | markdown | For packages | Lenient | Long description (20,000 characters). |
| `listing.category` | slug | No | Lenient | `apps`, `channels`, `integrations`, `developer`, or another lowercase slug. |
| `listing.tags[]` | string[] | No | Lenient | Up to 12 tags, 32 characters each. |
| `listing.cover` | image path | No | Lenient | 16:9 image inside the package (png, webp, jpg, gif, avif, svg) or a `data:image/…` URL of 256 KB or less. |
| `listing.icon` | image path | No | Lenient | Square image, same rules as `cover`. |
| `listing.screenshots[].src` | image path | No | Lenient | Up to 8 screenshots, same rules as `cover`. |
| `listing.screenshots[].caption` | string | No | Lenient | Caption (200 characters). |
| `listing.publisher.name` | string | No | Lenient | Publisher display name. |
| `listing.publisher.url` | url | No | Lenient | Publisher website (http or https). |
| `listing.links.docs` | url | No | Lenient | Documentation link. |
| `listing.links.support` | url | No | Lenient | Support link. |
| `listing.links.source` | url | No | Lenient | Source code link. |

## Updates

| Field | Type | Required | Status | Description |
| --- | --- | --- | --- | --- |
| `update.registryUrl` | url | No | Enforced | Registry this plugin's updates come from, instead of the host's `plugins.registryUrl`. Must be https (http only for localhost). Ignored on InfiniBot Cloud. |
| `update.changelog` | path | No | Enforced | Changelog file inside the package shown in the install review. Default `CHANGELOG.md`. |

## Permissions

Declared up front and shown to the owner before install. The owner can revoke each one; gated permissions start off.

| Field | Type | Required | Status | Description |
| --- | --- | --- | --- | --- |
| `permissions.network[]` | string[] | For packages | Enforced | Hosts the plugin connects to. Key: `network:<host>`. |
| `permissions.fs[]` | string[] | No | Enforced | Paths the plugin reads or writes outside its data folder. Key: `fs:<path>`. |
| `permissions.exec` | boolean | No | Enforced | The plugin runs programs or commands. Key: `exec`. |
| `permissions.secrets[]` | string[] | No | Enforced | Secret names it reads. Key: `secrets:<NAME>`. |
| `permissions.channels[]` | string[] | No | Enforced | Channels it sends through. Key: `channels:<id>`. |
| `permissions.credits` | boolean | No | Enforced | It spends credits. Key: `credits`. |
| `permissions.phi` | boolean | No | Enforced | It stores protected health information. |
| `permissions.gated[].id` | string | No | Enforced | A high-risk capability that is OFF until the owner grants it. Key: `gated:<id>`. |
| `permissions.gated[].label` | string | No | Enforced | Short name of the capability. |
| `permissions.gated[].description` | string | No | Enforced | Consent text shown next to the switch. |

## Appearance

Defaults for the plugin's own pages. Colours must be InfiniBot tokens (`token:<name>`). See the UI guide.

| Field | Type | Required | Status | Description |
| --- | --- | --- | --- | --- |
| `appearance.accent` | `token:<name>` | No | Enforced | Accent colour token. |
| `appearance.tint` | `token:<name>` \| `none` | No | Enforced | Surface tint token. |
| `appearance.tintStrength` | number | No | Enforced | 0 to 0.3. |
| `appearance.density` | `compact` \| `comfortable` | No | Enforced | Default spacing. |
| `appearance.fontScale` | number | No | Enforced | 0.85 to 1.3. |
| `appearance.icon` | string | No | Enforced | Icon name. |
| `appearance.monogram` | string | No | Enforced | Up to 3 characters shown when there is no icon. |
| `appearance.layout[].id` | string | No | Enforced | Layout option id. |
| `appearance.layout[].label` | string | No | Enforced | Label of the option. |
| `appearance.layout[].type` | `select` \| `toggle` | No | Enforced | Control type. |
| `appearance.layout[].options` | list | No | Enforced | Choices of a `select` (strings or `{ value, label }`). |
| `appearance.layout[].default` | string \| boolean | No | Enforced | Default value. |
| `appearance.variables[].name` | string | No | Enforced | CSS variable, namespaced `--plugin-<id>-*`. |
| `appearance.variables[].label` | string | No | Enforced | Label shown in Setup › Plugins › Appearance. |
| `appearance.variables[].type` | `color` \| `length` \| `number` \| `select` | No | Enforced | Variable type. |
| `appearance.variables[].default` | string \| number | No | Enforced | Default (a colour default must be a token). |
| `appearance.variables[].role` | string | No | Enforced | How a colour is used (`text`, `ui`, …), for contrast checks. |
| `appearance.variables[].options` | string[] | No | Enforced | Choices of a `select` variable. |
| `appearance.variables[].min` | number | No | Enforced | Lower bound of a number or length. |
| `appearance.variables[].max` | number | No | Enforced | Upper bound of a number or length. |

## Contributions the host enforces

Everything the plugin registers must be declared here; registering something undeclared is rejected. Any entry may add `requires: string[]` (permission keys it depends on): revoking one switches the entry off.

| Field | Type | Required | Status | Description |
| --- | --- | --- | --- | --- |
| `contributes.*[].requires[]` | string[] | No | Enforced | Permission keys the entry needs (`exec`, `credits`, `network:<host>`, `secrets:<NAME>`, `channels:<id>`, `fs:<path>`, `gated:<id>`, or a bare category). |
| `contributes.pages[].tab` | string | No | Enforced | Tab id of the page. |
| `contributes.pages[].route` | path | No | Enforced | URL path of the page, for example `/my-plugin`. |
| `contributes.pages[].builtin` | string | No | Enforced | First-party page compiled into the control UI. A page needs `builtin` or `entry`. |
| `contributes.pages[].entry` | path | No | Enforced | ES module the plugin serves under `/plugins/<id>/`. |
| `contributes.pages[].title` | string | No | Enforced | Page title. |
| `contributes.nav[].tab` | string | No | Enforced | Tab the entry opens; must match a `pages` entry. |
| `contributes.nav[].label` | string | No | Enforced | Sidebar label. |
| `contributes.nav[].icon` | string | No | Enforced | Icon name. |
| `contributes.nav[].group` | string | No | Enforced | Former sidebar group. Kept for compatibility; plugins now get their own section. |
| `contributes.navSection.title` | string | No | Enforced | Heading of the plugin's sidebar section. |
| `contributes.navSection.order` | number | No | Enforced | Sort order among plugin sections (default 1000). |
| `contributes.navSection.collapsedByDefault` | boolean | No | Enforced | Start collapsed. |
| `contributes.navSection.items[].page` | string | No | Enforced | Tab of a `pages` entry. |
| `contributes.navSection.items[].label` | string | No | Enforced | Label override. |
| `contributes.navSection.items[].icon` | string | No | Enforced | Icon override. |
| `contributes.landing` | string | No | Enforced | Page tab that can become the start page when the owner sets `plugins.landing`. |
| `contributes.rpc[]` | list | No | Enforced | Gateway methods. An entry is a method name (scope `admin`) or `{ method, scope, aliases, requires }`. |
| `contributes.rpc[].method` | string | No | Enforced | Gateway method, namespaced `<id>.*`. |
| `contributes.rpc[].scope` | `read` \| `write` \| `admin` | No | Enforced | Who may call it. Default `admin`. |
| `contributes.rpc[].aliases[]` | string[] | No | Enforced | Extra names served by the same handler (inherit the scope). |
| `contributes.rpcAliases[].method` | string | No | Enforced | Legacy un-namespaced method name. |
| `contributes.rpcAliases[].target` | string | No | Enforced | Declared `rpc` method that serves it. |
| `contributes.http[]` | path[] | No | Enforced | HTTP routes under `/plugins/<id>/`. An entry is a path string or `{ path, requires }`. |
| `contributes.http[].path` | path | No | Enforced | Route path, in the object form. |
| `contributes.selfAuthHttp[]` | path[] | No | Enforced | Routes (also listed in `http`) the plugin authenticates itself, such as signed webhooks. |
| `contributes.tools[]` | string[] | No | Enforced | Agent tool names. An entry is a name or `{ name, trust, requires }`. |
| `contributes.tools[].name` | string | No | Enforced | Tool name, in the object form. |
| `contributes.tools[].trust` | string | No | Enforced | Trust class shown in Setup › Plugins; `exec` adds the `exec` permission to `requires`. |
| `contributes.panels[]` | string[] | No | Enforced | Chat panel kinds, namespaced `<id>.*`. |
| `contributes.services[]` | string[] | No | Enforced | Background service ids (`api.registerService`). |
| `contributes.voiceProviders[]` | string[] | No | Enforced | Voice provider ids (`api.registerVoiceProvider`). |
| `contributes.agents[]` | path[] | No | Enforced | Roster-agent JSON files inside the plugin, added while it is on. |
| `contributes.mcpServers[].id` | string | No | Enforced | Id of a bundled stdio MCP server. |
| `contributes.mcpServers[].label` | string | No | Enforced | Display label. |
| `contributes.mcpServers[].command` | string | No | Enforced | Command that starts it. |
| `contributes.mcpServers[].args[]` | string[] | No | Enforced | Command arguments. |
| `contributes.clockSections[].id` | string | No | Enforced | Section id (`a-z0-9-`). |
| `contributes.clockSections[].label` | string | No | Enforced | Toggle label in the topbar clock. |
| `contributes.clockSections[].description` | string | No | Enforced | Help text. |
| `contributes.clockSections[].builtin` | string | No | Enforced | First-party renderer key. |
| `contributes.clockSections[].defaultEnabled` | boolean | No | Enforced | Initial toggle state (default true). |
| `contributes.topbarSlots[].id` | string | No | Enforced | Slot id (`a-z0-9-`). |
| `contributes.topbarSlots[].label` | string | No | Enforced | Label. |
| `contributes.topbarSlots[].description` | string | No | Enforced | Help text. |
| `contributes.topbarSlots[].builtin` | string | No | Enforced | First-party renderer key. |
| `contributes.topbarSlots[].order` | number | No | Enforced | Sort order (default 100). |
| `contributes.topbarSlots[].placement` | `left` \| `right` | No | Enforced | Topbar group (default `left`). |
| `contributes.settings[].id` | string | No | Enforced | Settings section id (`a-z0-9-`). |
| `contributes.settings[].label` | string | No | Enforced | Section label. |
| `contributes.settings[].description` | string | No | Enforced | Help text. |
| `contributes.settings[].builtin` | string | No | Enforced | First-party renderer key. |
| `contributes.settings[].order` | number | No | Enforced | Sort order (default 100). |
| `contributes.setupChecks[].id` | string | No | Enforced | Check id, namespaced `<id>.*` (`api.registerSetupCheck`). |
| `contributes.setupChecks[].title` | string | No | Enforced | What is being set up. |
| `contributes.setupChecks[].tabs[]` | string[] | No | Enforced | The plugin's own page tabs that glow while setup is needed. |
| `contributes.setupChecks[].action.label` | string | No | Enforced | Button label of the default action. |
| `contributes.setupChecks[].action.tab` | string | No | Enforced | Page tab the action opens. |
| `contributes.setupChecks[].action.view` | string | No | Enforced | Optional sub-view. |
| `contributes.mapRoom.title` | string | No | Enforced | Sign on the plugin's room on the agent map (24 characters). `mapRoom: false` opts out. |
| `contributes.mapRoom.theme` | string | No | Enforced | Room theme (see MAP-ROOMS.md). |
| `contributes.mapRoom.accent` | `token:<name>` \| `#rrggbb` | No | Enforced | Room accent. |
| `contributes.mapRoom.props[]` | string[] | No | Enforced | Up to 12 props replacing the theme's furniture. |
| `contributes.mapRoom.size` | `S` \| `M` \| `L` | No | Enforced | Room footprint. |
| `contributes.mapRoom.placement` | `auto` \| `north` \| `east` \| `south` \| `west` | No | Enforced | Preferred side of the plugin district. |
| `contributes.learn` | object \| path | No | Enforced | Guided Learn tracks, inline or a `.json` file inside the plugin (see LEARN.md). |
| `contributes.importers[].id` | string | No | Lenient | Data importer id (Setup › Plugins › Data). |
| `contributes.importers[].label` | string | No | Lenient | Label. |
| `contributes.importers[].description` | string | No | Lenient | Help text. |
| `contributes.importers[].method` | string | No | Lenient | Declared `rpc` method that runs the import. |
| `contributes.importers[].accept` | string | No | Lenient | File types the picker accepts. |
| `contributes.importers[].input` | `file` \| `none` | No | Lenient | `none` shows a run button instead of a file picker. |

## Contributions that are listed only

These blocks appear in Setup › Plugins (with an on/off switch where it makes sense), but the host does not act on them yet. Declare them only to describe what your code already does through the plugin API.

| Field | Type | Required | Status | Description |
| --- | --- | --- | --- | --- |
| `contributes.cron[]` | object[] | No | Listed only | Scheduled jobs: `id`, `label`, `schedule`, `description`, `defaultEnabled`. |
| `contributes.subviews[]` | object[] | No | Listed only | Sub-views inside a host page: `id`, `label`, `host`. |
| `contributes.widgets[]` | object[] | No | Listed only | Dashboard widgets: `id`, `label`, `surface`. |
| `contributes.overlays[]` | object[] | No | Listed only | Overlays: `id`, `label`, `trigger`. |
| `contributes.launchpad[]` | object[] | No | Listed only | Launchpad entries: `id`, `label`. |
| `contributes.mapLayers[]` | object[] | No | Listed only | Map layers: `id`, `label`. |
| `contributes.panelKinds[]` | object[] | No | Listed only | Older form of `panels`: `id`, `label`. |
| `contributes.skills[]` | list | No | Listed only | Skills, as paths or `{ path }`. |
| `contributes.roster[]` | object[] | No | Listed only | Older form of `agents`: `agentId`, `label`. |
| `contributes.channels[]` | list | No | Listed only | Channels, as ids or `{ id }`. |
| `contributes.providers[]` | list | No | Listed only | Providers, as ids or `{ id, label, kind }`. |
| `contributes.hooks[]` | list | No | Listed only | Hooks, as event names or `{ event }`. |
| `contributes.sidecars[]` | object[] | No | Listed only | Sidecar containers: `id`, `label`, `image`. Not supervised by the host. |

## Minimal package manifest

```json
{
  "manifestVersion": 2,
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "publisher": "my-publisher",
  "minHostVersion": "2026.6.30",
  "engines": {
    "infinibot-plugin-api": "^2.0.0"
  },
  "listing": {
    "tagline": "What it does in one line.",
    "description": "A longer **markdown** description."
  },
  "configSchema": {
    "type": "object",
    "properties": {}
  },
  "contributes": {},
  "permissions": {}
}
```
