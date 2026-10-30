---
summary: "Plugin manifest + JSON schema requirements (strict config validation)"
read_when:
  - You are building a InfiniBot plugin
  - You need to ship a plugin config schema or debug plugin validation errors
---
# Plugin manifest (infinibot.plugin.json)

Every plugin **must** ship a `infinibot.plugin.json` file in the **plugin root**.
InfiniBot uses this manifest to validate configuration **without executing plugin
code**. Missing or invalid manifests are treated as plugin errors and block
config validation.

See the full plugin system guide: [Plugins](/plugin).

## Required fields

```json
{
  "id": "voice-call",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {}
  }
}
```

Required keys:
- `id` (string): canonical plugin id.
- `configSchema` (object): JSON Schema for plugin config (inline).

Optional keys:
- `rpcNamespace` (string, v2): RPC prefix when it intentionally differs from
  the plugin id (for example plugin `part-scan` exposing `partscan.*`). Defaults
  to `id`; declared RPC methods must use this prefix.
- `kind` (string): plugin kind (example: `"memory"`).
- `channels` (array): channel ids registered by this plugin (example: `["matrix"]`).
- `providers` (array): provider ids registered by this plugin.
- `skills` (array): skill directories to load (relative to the plugin root).
- `name` (string): display name for the plugin.
- `description` (string): short plugin summary.
- `uiHints` (object): config field labels/placeholders/sensitive flags for UI rendering.
- `version` (string): plugin version (informational).

Manifest v2 plugins (`"manifestVersion": 2`) additionally declare their
contributions up front — see [PLUGIN-PLATFORM.md](./PLUGIN-PLATFORM.md) §3.2.
Among them, `contributes.mapRoom` gives the plugin a room on the isometric
agent mesh map ([MAP-ROOMS.md](./MAP-ROOMS.md)); every v2 plugin with a page
gets a default room unless it sets `"mapRoom": false`.

`contributes.learn` ships guided Learn tracks, shown only while the plugin is
enabled. See [LEARN.md](LEARN.md).

## JSON Schema requirements

- **Every plugin must ship a JSON Schema**, even if it accepts no config.
- An empty schema is acceptable (for example, `{ "type": "object", "additionalProperties": false }`).
- Schemas are validated at config read/write time, not at runtime.

## Validation behavior

- Unknown `channels.*` keys are **errors**, unless the channel id is declared by
  a plugin manifest.
- `plugins.entries.<id>`, `plugins.allow`, `plugins.deny`, and `plugins.slots.*`
  must reference **discoverable** plugin ids. Unknown ids are **errors**.
- If a plugin is installed but has a broken or missing manifest or schema,
  validation fails and Doctor reports the plugin error.
- If plugin config exists but the plugin is **disabled**, the config is kept and
  a **warning** is surfaced in Doctor + logs.

## Notes

- The manifest is **required for all plugins**, including local filesystem loads.
- Runtime still loads the plugin module separately; the manifest is only for
  discovery + validation.
- If your plugin depends on native modules, document the build steps and any
  package-manager allowlist requirements (for example, pnpm `allow-build-scripts`
  + `pnpm rebuild <package>`).
