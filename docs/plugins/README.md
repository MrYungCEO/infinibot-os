# InfiniBot plugins

Documentation for building, packaging, installing and publishing InfiniBot plugins.

## Build a plugin

| Doc | What it covers |
| --- | --- |
| [Getting started](getting-started.md) | Scaffold, run, pack and install a plugin, following `examples/plugin-hello`. |
| [Manifest reference](manifest-reference.md) | Every field of `infinibot.plugin.json`. Generated from the schema. |
| [API reference](api-reference.md) | The plugin API: RPC methods, HTTP routes, tools, services, settings, data folder, permissions. |
| [UI guide](ui-guide.md) | Plugin pages and panels, theming, accessibility, and pitfalls to avoid. |

## Ship a plugin

| Doc | What it covers |
| --- | --- |
| [Packaging](packaging.md) | The InfiniBot Plugin Package format, limits, versioning, `pack` and `validate`, install rules. |
| [Updates](updates.md) | Update checks, updating, rollback, automatic updates, permission re-prompts. |
| [Security model](security-model.md) | What the host guarantees at install and at run time, and what it does not. |
| [Publishing](publishing.md) | Marketplace submission, paid plugins, review guidelines. |
| [Registry API](registry-api.md) | The HTTP contract between InfiniBot and a plugin registry. |

## Feature docs

- [Plugin platform design](PLUGIN-PLATFORM.md) (design notes; the API reference lists what is implemented)
- [Setup › Plugins page](PLUGINS-PAGE-CONTROL.md)
- [Sidebar sections](SIDEBAR-SECTIONS.md), [topbar slots](TOPBAR-SLOTS.md), [clock sections](CLOCK-SECTIONS.md), [map rooms](MAP-ROOMS.md), [Learn tracks](LEARN.md)
- [Agent tools](agent-tools.md), [voice providers](voice-providers.md)
