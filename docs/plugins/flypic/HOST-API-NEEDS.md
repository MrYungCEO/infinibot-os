# FlyPic host API needs (plugin API v0)

FlyPic targets manifest v2 while the host API is still explicitly v0. This file records every host/core dependency introduced or still missing.

## Added in this branch

1. `InfiniBotPluginApi.registerMediaProvider(provider)` — registers the generic `MediaGenerationProvider` contract (generate, edit, status, list models, estimate cost).
2. `src/media-generation/*` — active-provider registry plus the existing local ComfyUI path as the built-in `comfyui` provider.
3. `src/plugin-sdk/index.ts` exports the media-provider types and registry lookup.
4. `registerHttpRoute({ publicAsset: true })` — narrowly exposes an exact
   manifest-declared UI entry to unauthenticated `GET`/`HEAD` requests so
   browser `import()` can load it. Data/API routes remain behind HTTP auth.

These are provider-neutral. No FlyPic endpoint, model, credential or UI implementation lives in core.

## Core-boundary audit

- The former `src/compositions/notes-edit-flypic.ts` projection is now the
  provider-neutral `notes-edit-storyboard.ts` interchange format and writes
  `project.storyboard.json`.
- Agent role defaults no longer request a separate `flypic` MCP server. When
  this plugin is enabled, its non-optional `flypic_generate_*` tools enter the
  normal agent tool set through `registerTool`.
- Content Studio compatibility now asks the content agent for
  `flypic_generate_image` or `flypic_generate_video`, rather than the removed
  external MCP tool names.
- The generic project metadata link is `mediaProjectId`. Core retains exactly
  one read-only compatibility migration from the historic SQLite column name;
  no runtime API exposes that legacy provider-specific field.
- A regression test (`src/media-generation/core-boundary.test.ts`) locks these
  boundaries so provider-specific implementation cannot drift back into core.

## Host APIs used today

- `registerTool` for the five FlyPic agent tools.
- `registerGatewayMethod` for gallery, settings, models, generation and status RPCs.
- `registerHttpRoute({ publicAsset: true })` for the plugin-owned browser module.
- `registerService` to bind the JSON job store to `<stateDir>/plugin-data/flypic` (host Data tab dir; a pre-release `plugins/flypic` dir is moved over once).
- `runtime.config.loadConfig/writeConfigFile` to persist validated plugin settings with the host's `0600` config write path.
- Manifest `uiHints.sensitive` plus `permissions.secrets` for API-key handling.

## Still needed from the host

1. **Routed external plugin pages.** `contributes.pages[].entry` is parsed, but the control UI currently mounts plugin browser modules only inline under Setup › Plugins. Until the generic route host lands, `/flypic` is declared but the verified UI surface is the FlyPic Studio panel on Setup › Plugins.
2. **Secret vault API.** `uiHints.sensitive` masks form fields and the config file is mode `0600`, but plugin secrets should ultimately use opaque `secrets.get/set` handles rather than appear in plugin config JSON.
3. **Credits metering API.** FlyPic probes an optional `api.credits.recordUsage` hook and otherwise remains a no-op. The host should publish a typed, tenant-aware, idempotent usage-metering API before Cloud billing is enabled.
4. **Plugin storage API.** The service correctly scopes files under the supplied state directory, but a typed `api.storage` namespace would centralize quotas, atomic writes and cloud-backed tenant storage.
5. **Hot settings reload.** FlyPic applies settings immediately in-process; the generic Plugins UI should expose schema-driven config editing and notify plugins after validated changes.
