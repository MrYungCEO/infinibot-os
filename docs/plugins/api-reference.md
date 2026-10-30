# Plugin API and runtime reference

This is the reference for the API a manifest-v2 plugin receives in `register(api)`: what each `register*` method does, what the host enforces against the manifest, which host services are reachable through `api.runtime`, and how config, data, permissions, logging, lifecycle and cloud restrictions work. Everything here describes the code as it is today; where a design document promises something that is not implemented, this page says so. Source paths are repo-relative so you can check each claim.

See also:

- [getting-started.md](getting-started.md)
- [manifest-reference.md](manifest-reference.md)
- [packaging.md](packaging.md)
- [updates.md](updates.md)
- [security-model.md](security-model.md)
- [publishing.md](publishing.md)
- [registry-api.md](registry-api.md)
- [ui-guide.md](ui-guide.md) (plugin pages in the control UI)
- [PLUGIN-PLATFORM.md](PLUGIN-PLATFORM.md) (design; parts of it are not built yet, see [Not implemented](#not-implemented))

## Contents

- [Plugin entry shape](#plugin-entry-shape)
- [The api object](#the-api-object)
- [What manifest v2 enforces](#what-manifest-v2-enforces)
- [api.runtime and api.runtime.host](#apiruntime-and-apiruntimehost)
- [registerGatewayMethod (RPC)](#registergatewaymethod-rpc)
- [registerHttpRoute](#registerhttproute)
- [registerTool](#registertool)
- [registerService](#registerservice)
- [Nav, pages and navSection](#nav-pages-and-navsection)
- [Other contributes blocks](#other-contributes-blocks)
- [Other register methods](#other-register-methods)
- [Plugin panel data](#plugin-panel-data)
- [Plugin config](#plugin-config)
- [Plugin data directory](#plugin-data-directory)
- [Permissions and gated permissions](#permissions-and-gated-permissions)
- [Logging](#logging)
- [Enable, disable and restarts](#enable-disable-and-restarts)
- [Cloud and tenant restrictions](#cloud-and-tenant-restrictions)
- [What infinibot/plugin-sdk exports](#what-infinibotplugin-sdk-exports)
- [Not implemented](#not-implemented)

## Plugin entry shape

Source: `src/plugins/loader.ts`, `src/plugins/types.ts` (`InfiniBotPluginModule`, `InfiniBotPluginDefinition`).

The loader loads the plugin's entry file with jiti (TypeScript or JavaScript, no build step required) and accepts either form as the default export:

```ts
// Form 1: a function
import type { InfiniBotPluginApi } from "infinibot/plugin-sdk";

export default function register(api: InfiniBotPluginApi) {
  api.logger.info("hello");
}
```

```ts
// Form 2: an object with register (or activate)
import type { InfiniBotPluginApi } from "infinibot/plugin-sdk";

export default {
  id: "my-plugin",
  name: "My Plugin",
  register(api: InfiniBotPluginApi) {
    api.logger.info("hello");
  },
};
```

Rules the loader applies:

- `register` must be **synchronous**. If it returns a promise the loader records the warning `plugin register returned a promise; async registration is ignored` and does not wait. Do async work inside handlers or in a service's `start`.
- `activate` is accepted as an alias for `register`.
- A plugin without a `configSchema` in its manifest fails to load (`missing config schema`).
- A v2 plugin whose `engines["infinibot-plugin-api"]` range does not include the host's `PLUGIN_API_VERSION` (`2.0.0`, `src/plugins/manifest-v2.ts`) is not loaded; its status is `error` with the reason shown.
- If `register` throws, the plugin's status is `error` and nothing it registered is kept as loaded.
- `infinibot/plugin-sdk` is resolved by a jiti alias to the host's `src/plugin-sdk` (or `dist/plugin-sdk`). It is not an npm package you install.

## The api object

Source: `src/plugins/types.ts` (`InfiniBotPluginApi`), `src/plugins/registry.ts` (`createApi`).

| Member | Type | Notes |
|---|---|---|
| `id`, `name`, `version`, `description` | strings | From the manifest. |
| `source` | `string` | Path of the entry file. |
| `config` | `InfinibotConfig` | The gateway config at load time (a snapshot). |
| `pluginConfig` | `Record<string, unknown> \| undefined` | `plugins.entries.<id>.config`, already validated against your `configSchema`. |
| `runtime` | `PluginRuntime` | Host services. See below. |
| `logger` | `PluginLogger` | See [Logging](#logging). |
| `resolvePath(input)` | `(string) => string` | Expands `~` and resolves a user path. |
| `registerGatewayMethod(method, handler)` | | RPC. |
| `registerHttpRoute({ path, handler, publicAsset? })` | | HTTP. |
| `registerHttpHandler(handler)` | | v1 only. Rejected for v2 plugins. |
| `registerTool(tool \| factory, opts?)` | | Agent tools. |
| `registerService({ id, start, stop? })` | | Background services. |
| `registerHook(events, handler, opts?)` | | Internal hook events. |
| `on(hookName, handler, opts?)` | | Typed lifecycle hooks. |
| `registerCommand(def)` | | Chat commands that bypass the agent. |
| `registerCli(registrar, opts?)` | | CLI subcommands. |
| `registerChannel(reg)` | | Messaging channels. |
| `registerProvider(provider)` | | Model provider auth. |
| `registerMediaProvider(provider)` | | Image/video generation. |
| `registerVoiceProvider(provider)` | | Voice backends. |
| `registerPanelKind(def)` | | v2 only. Chat panel kinds. |
| `registerSetupCheck(check)` | | v2 only. "Needs setup" checks. |

## What manifest v2 enforces

Source: `src/plugins/manifest-v2.ts` (`parseManifestV2`), `src/plugins/registry.ts`.

A v2 manifest is a contract and fails closed. Parse-time errors (the plugin does not load):

| Rule | Error |
|---|---|
| `engines["infinibot-plugin-api"]` missing | `v2 manifest requires engines["infinibot-plugin-api"]` |
| RPC method not `<id>.*` | `rpc method "x" must be namespaced "<id>.*"` |
| RPC scope not `read`/`write`/`admin` | `rpc "x" has unknown scope "y"` |
| HTTP route not under `/plugins/<id>/` | `http route "x" must live under /plugins/<id>/` |
| Page `entry` not under `/plugins/<id>/` | `page "x" entry must live under /plugins/<id>/` |
| Page with neither `builtin` nor `entry` | `page "x" needs builtin or entry` |
| Nav entry without a page for its `tab` | `nav entry "x" has no matching contributes.pages entry` |
| `selfAuthHttp` route not also in `http` | `selfAuthHttp route "x" must also be listed in contributes.http` |
| Panel kind not `<id>.*` | `panel kind "x" must be namespaced "<id>.*"` |
| Setup check id not `<id>.*`, or naming a tab that is not the plugin's own | error |

Registration-time rejections (the call is dropped and an `error` diagnostic is recorded; the rest of the plugin still loads):

| Call | Rejected when |
|---|---|
| `registerGatewayMethod` | method is not in `contributes.rpc` (as `method` or one of its `aliases`); or the name is already taken by core or another plugin |
| `registerHttpRoute` | path is not in `contributes.http`; or already registered; or `publicAsset: true` on a path that is not a declared UI entry |
| `registerHttpHandler` | always, for v2 (`v2 plugins must use registerHttpRoute with declared routes`) |
| `registerTool` | any name known up front is not in `contributes.tools` |
| `registerVoiceProvider` | id not in `contributes.voiceProviders`, or id is `local`/`auto` (reserved) |
| `registerPanelKind` | kind not in `contributes.panels`, or it calls an RPC that is not one of the plugin's own `read`-scoped methods |
| `registerSetupCheck` | id not in `contributes.setupChecks` |

Not enforced against the manifest today: `registerService` (see [registerService](#registerservice)), `registerHook`, `on`, `registerCommand`, `registerCli`, `registerChannel`, `registerProvider`, `registerMediaProvider`.

After `register` returns, the loader warns (does not fail) for every declared RPC method or alias that was not registered.

## api.runtime and api.runtime.host

Source: `src/plugins/runtime/types.ts`, `src/plugins/runtime/index.ts`, `src/plugins/runtime/security-host.ts`.

### Why you must use it

Plugins are loaded by jiti, and a jiti-loaded module that imports a core file gets its **own copy** of that module, separate from the instance the gateway is running. The type comment on `PluginRuntime.host` states it directly: "Plugins run in their own module instances (jiti), so in-process buses and seams are handed over here rather than imported." An event bus, cache or singleton imported by relative path from a plugin is a different object from the gateway's, so subscriptions never fire and state is never shared.

Reach host services through `api.runtime` (and `api.runtime.host` for in-process buses and seams), or through the functions `infinibot/plugin-sdk` exports. Do not import files from `src/` by path.

A note on how the host itself copes: registries the SDK re-exports (the plugin registry, host state, log buffers, service table) are stored on `globalThis` under `Symbol.for(...)` keys precisely so that separate module instances see the same data (`src/plugins/runtime.ts`, `src/plugins/host-state.ts`, `src/plugins/plugin-logs.ts`, `src/plugins/services.ts`).

### api.runtime groups

| Group | Members |
|---|---|
| `version` | Host product version string. |
| `config` | `loadConfig()`, `writeConfigFile(cfg)` |
| `state` | `resolveStateDir()` (per profile, tenant-namespaced in SaaS), `resolveSharedDir()` (install-wide) |
| `logging` | `shouldLogVerbose()`, `getChildLogger(bindings?, opts?)` |
| `system` | `enqueueSystemEvent`, `runCommandWithTimeout`, `formatNativeDependencyHint` |
| `media` | `loadWebMedia`, `detectMime`, `mediaKindFromMime`, `isVoiceCompatibleAudio`, `getImageMetadata`, `resizeToJpeg` |
| `tts` | `textToSpeechTelephony` |
| `tools` | `createMemoryGetTool`, `createMemorySearchTool`, `registerMemoryCli` |
| `channel` | Helpers for channel plugins: `text`, `reply`, `routing`, `pairing`, `media`, `activity`, `session`, `mentions`, `reactions`, `groups`, `debounce`, `commands`, plus per-channel groups (`discord`, `slack`, `telegram`, `signal`, `imessage`, `whatsapp`, `line`) |
| `host` | In-process seams, below |

### api.runtime.host

| Member | Purpose |
|---|---|
| `onAgentEvent(listener)` | Agent run stream (lifecycle, tool events). Returns unsubscribe. |
| `onWorkCompleted(listener)` | Kanban task done / agent run completed. Returns unsubscribe. |
| `emitNotification(...)` | In-app and push notification. |
| `alertOwner(...)` | In-app and Telegram owner alert (best effort); `link` adds a deep link. |
| `linkPair?(...)` | `infinibot://` deep link plus https opener for a link or web path. Optional: check before calling. |
| `runLLM(...)` | One-shot completion on the owner's default model. The plugin never sees API keys. |
| `voiceTurn(...)` | One LLM turn for an external voice pipeline. |
| `approvals` | Core approval registry: `create`, `get`, `list`, `cancel`. |
| `kek` | Wrap/unwrap per-tenant data keys (never the key-encryption key itself). |
| `saas` | SaaS identity: mode, dedicated tenant, Clerk step-up verification. |
| `gatherBusinessSnapshot()` | Kanban and CRM snapshot. |
| `setDayPlannerProvider(p \| null)` | Day-planner seam. |
| `setCoreToolSlot(slot, tool \| null)` | Fill or clear a core agent-tool slot. |
| `businessAgency` | Backend seam for the first-party Business & Agency plugin. |

Several of these exist for specific first-party plugins that moved out of core. Third-party plugins can call them, but treat anything not listed in [security-model.md](security-model.md) as unstable.

```ts
export default function register(api: InfiniBotPluginApi) {
  let off: (() => void) | undefined;
  api.registerService({
    id: "my-plugin-watcher",
    start() {
      // Correct: the gateway's own bus, handed over by the host.
      off = api.runtime.host.onWorkCompleted((evt) => {
        api.logger.info(`work completed: ${JSON.stringify(evt).slice(0, 200)}`);
      });
    },
    stop() {
      off?.();
    },
  });
}
```

## registerGatewayMethod (RPC)

Source: `src/plugins/registry.ts` (`registerGatewayMethod`, `wireRpcAliases`), `src/plugins/runtime.ts` (`resolvePluginMethodScope`), `src/gateway/server-methods.ts` (`authorizeGatewayMethod`, dispatch), `src/gateway/server-methods/types.ts`.

```ts
registerGatewayMethod(method: string, handler: GatewayRequestHandler): void;

type GatewayRequestHandler = (opts: {
  req: RequestFrame;
  params: Record<string, unknown>;
  client: GatewayClient | null;   // connection identity (authMethod, saasTenantId, connId, ...)
  respond: (ok: boolean, payload?: unknown, error?: { code: string; message: string }) => void;
  context: GatewayRequestContext; // includes broadcast(event, payload)
  isWebchatConnect: (...) => boolean;
}) => Promise<void> | void;
```

Manifest:

```json
"contributes": {
  "rpc": [
    { "method": "my-plugin.items.list", "scope": "read" },
    { "method": "my-plugin.items.add", "scope": "write", "requires": ["network:api.example.com"] },
    { "method": "my-plugin.settings.set", "scope": "admin" }
  ]
}
```

Plugin:

```ts
api.registerGatewayMethod("my-plugin.items.list", ({ params, respond }) => {
  const limit = typeof params.limit === "number" ? params.limit : 50;
  respond(true, { items: store.list(limit) });
});

api.registerGatewayMethod("my-plugin.items.add", async ({ params, respond }) => {
  try {
    respond(true, { item: await store.add(String(params.title ?? "")) });
  } catch (err) {
    respond(false, undefined, { code: "bad_request", message: String(err) });
  }
});
```

### Namespacing

Every declared method must start with `<id>.`. A method name already served by core or by another plugin is rejected (`gateway method already registered`).

### Scopes

The scope declared in the manifest is what the gateway checks on each call:

| Scope | Caller needs |
|---|---|
| `read` | `operator.read` or `operator.write` |
| `write` | `operator.write` |
| `admin` | `operator.admin` |

A caller with `operator.admin` passes every check. An rpc entry given as a bare string, or without `scope`, defaults to `admin`. Methods from v1 plugins have no declared scope and are admin-only.

### Aliases

There are two ways to serve an extra name, both for migrating existing callers:

- `rpc[].aliases`: extra names for one method. You register each alias yourself with `registerGatewayMethod`; it inherits the canonical method's scope. An alias must look like `namespace.name` and must not equal the method.
- `contributes.rpcAliases: [{ method, target }]`: a legacy name outside your namespace that the **host** wires to the handler you registered for `target`. You do not register it. The alias must not be in the plugin namespace, `target` must be a declared method, and the alias inherits the target's scope. If the name is already served by core or another plugin, the alias is skipped with a warning; it never shadows.

Real example (`extensions/content-studio/infinibot.plugin.json`):

```json
"rpc": [{ "method": "content-studio.intel.list", "scope": "admin" }],
"rpcAliases": [{ "method": "content.intel.list", "target": "content-studio.intel.list" }]
```

### Live gating

Every plugin RPC is checked on each call against the owner's toggles and permission state (`pluginMethodBlockedReason` in `src/plugins/host-state.ts`). If the owner switched `rpc:<method>` off, or a permission in its `requires` list is revoked or not granted, the call fails with `<method> is turned off in Setup › Plugins › <name>`. Aliases are gated exactly like their target. No restart is involved.

## registerHttpRoute

Source: `src/plugins/registry.ts` (`registerHttpRoute`), `src/gateway/server/plugins-http.ts`, `src/gateway/server-http.ts`, `src/plugins/http-path.ts`.

```ts
registerHttpRoute(params: {
  path: string;
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;
  publicAsset?: boolean;
}): void;
```

Manifest:

```json
"contributes": {
  "http": [
    "/plugins/my-plugin/export",
    { "path": "/plugins/my-plugin/webhook", "requires": ["network:api.example.com"] },
    "/plugins/my-plugin/ui.js"
  ],
  "selfAuthHttp": ["/plugins/my-plugin/webhook"]
}
```

Plugin:

```ts
api.registerHttpRoute({
  path: "/plugins/my-plugin/export",
  handler: (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ items: store.list(1000) }));
  },
});
```

Facts:

- Paths must live under `/plugins/<id>/` and be listed in `contributes.http`. Matching is **exact** on the URL pathname. There are no wildcards or path parameters; use the query string.
- A leading `/` is added if missing (`normalizePluginHttpPath`).
- A handler that throws produces a 500 `Internal Server Error` and a warning in the gateway log.
- A route the owner switched off (`http:<path>`), or whose `requires` permission is not granted, returns 404 `This plugin route is turned off.`

### Auth: three classes of route

| Class | How to declare | Auth |
|---|---|---|
| Gated (default) | listed in `contributes.http` | Behind the gateway HTTP security gate, like every `/plugins/` and `/api/` path: the request must carry the gateway credential (header or session cookie), pass the host-header check, the auth-failure rate limiter and the CSRF check. Your handler only runs for authenticated callers. |
| Self-authenticated | also listed in `contributes.selfAuthHttp` | Dispatched **before** the gate. The gateway does no authentication at all. Your handler **must** reject unauthenticated requests itself (scoped token, signed webhook). |
| Public UI asset | `publicAsset: true` in the `registerHttpRoute` call | Served without authentication, for `GET` and `HEAD` only, and only when the path is exactly the manifest's `ui.entry` or a `contributes.pages[].entry`. Any other path is rejected at registration. Other verbs on the same path go through the gate. |

Public UI assets exist because a browser dynamic `import()` cannot attach the gateway bearer token. Treat the module as public: never embed secrets or tenant data in it.

Real self-auth example (`extensions/robovoice/infinibot.plugin.json`):

```json
"http": [
  { "path": "/plugins/robovoice/connection-details", "requires": ["network"] },
  "/plugins/robovoice/mcp",
  "/plugins/robovoice/agent-mcp",
  "/plugins/robovoice/voice-llm/v1/chat/completions"
],
"selfAuthHttp": [
  "/plugins/robovoice/agent-mcp",
  "/plugins/robovoice/voice-llm/v1/chat/completions"
]
```

If plugin backend code needs to call one of its own gated routes, `resolveSelfCallAuthHeaders` from `infinibot/plugin-sdk` returns the authorization header to use.

`registerPluginHttpRoute` (also exported by the SDK, `src/plugins/http-registry.ts`) is a lower-level helper used by channel plugins for webhook paths. It does not check `contributes.http`, does not set `publicAsset` or `selfAuth`, and returns an unregister function. v2 plugins should use `api.registerHttpRoute`.

## registerTool

Source: `src/plugins/registry.ts` (`registerTool`), `src/plugins/tools.ts` (`resolvePluginTools`). Tool shape, optional tools and allowlists: [agent-tools.md](agent-tools.md).

```ts
registerTool(
  tool: AnyAgentTool | ((ctx: InfiniBotPluginToolContext) => AnyAgentTool | AnyAgentTool[] | null | undefined),
  opts?: { name?: string; names?: string[]; optional?: boolean },
): void;
```

Manifest (names, or objects with `trust` and `requires`):

```json
"contributes": {
  "tools": [
    "my_plugin_search",
    { "name": "my_plugin_send", "trust": "write", "requires": ["network:api.example.com"] }
  ]
}
```

Plugin:

```ts
api.registerTool({
  name: "my_plugin_search",
  description: "Search my-plugin items",
  parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
  async execute(_id, params) {
    return { content: [{ type: "text", text: JSON.stringify(store.search(params.q)) }] };
  },
});

// A factory gets per-run context. State the names so the host can check them.
api.registerTool((ctx) => makeTools({ agentId: ctx.agentId }), {
  names: ["my_plugin_send"],
});
```

Facts:

- For a v2 plugin, every name the host can see at registration (the tool object's `name`, or `opts.name`/`opts.names` for a factory) must be in `contributes.tools`. Otherwise the whole registration is dropped with `tool not declared in manifest contributes.tools: ...`. This is easy to miss: [agent-tools.md](agent-tools.md) predates v2 and does not mention the declaration.
- A factory registered **without** names is not checked at registration. Always pass `names` so the tool can be toggled and gated by key.
- Factory context: `config`, `workspaceDir`, `agentDir`, `agentId`, `sessionKey`, `messageChannel`, `agentAccountId`, `sandboxed`. Returning `null`/`undefined` contributes no tool for that run.
- A tool whose `tool:<name>` contribution is switched off, or whose `requires` permission is not granted, is left out when tools are resolved for an agent run. This applies on the next run, with no restart.
- A tool name that collides with a core tool or another plugin tool is skipped with an error diagnostic. A plugin whose **id** equals a core tool name has all its tools blocked.
- `optional: true` tools are only offered when an agent allowlist names the tool, the plugin id, or `group:plugins`.
- `trust: "exec"` in the manifest implicitly adds `exec` to the tool's `requires`, so revoking the `exec` permission turns the tool off (`src/plugins/contributions.ts`).

## registerService

Source: `src/plugins/services.ts`, `src/plugins/registry.ts` (`registerService`).

```ts
registerService(service: {
  id: string;
  start: (ctx: InfiniBotPluginServiceContext) => void | Promise<void>;
  stop?: (ctx: InfiniBotPluginServiceContext) => void | Promise<void>;
}): void;

type InfiniBotPluginServiceContext = {
  config: InfinibotConfig;
  workspaceDir?: string;
  stateDir: string;
  logger: PluginLogger;
};
```

Real example (`extensions/flypic/index.ts`):

```ts
const service: InfiniBotPluginService = {
  id: "flypic-job-store",
  start(ctx) {
    store = new FlyPicJobStore(flypicDataDir(ctx.stateDir));
    ctx.logger.info(`FlyPic job store ready (${store.list(500).length} tracked job(s))`);
  },
};
api.registerService(service);
```

Facts:

- Services start when the gateway starts plugin services, in registration order, and stop in reverse order on shutdown.
- A `start` that throws is caught: the service is marked not running, the error is kept as `lastError` and shown in Setup › Plugins › Health & Logs. The gateway keeps running.
- `registerService` does **not** check the id against `contributes.services`. Declare it anyway: the owner's `service:<id>` toggle and any `requires` gating only exist for declared ids. A declared service that is switched off is not started.
- Toggling `service:<id>` starts or stops that service in place (`reconcilePluginServices`), and the Plugins page can restart one plugin's services without restarting the gateway.
- `stop` should release everything `start` acquired (timers, sockets, subscriptions). Do long-running or async setup here, not in `register`.

## Nav, pages and navSection

Source: `src/plugins/manifest-v2.ts`, `ui/src/ui/plugin-host.ts`. Details: [SIDEBAR-SECTIONS.md](SIDEBAR-SECTIONS.md), [ui-guide.md](ui-guide.md).

```json
"contributes": {
  "pages": [
    { "tab": "my-plugin", "route": "/my-plugin", "entry": "/plugins/my-plugin/ui.js", "title": "My Plugin" }
  ],
  "nav": [
    { "tab": "my-plugin", "label": "My Plugin", "icon": "palette" }
  ],
  "navSection": {
    "title": "My Plugin",
    "order": 500,
    "collapsedByDefault": false,
    "items": [{ "page": "my-plugin", "label": "Studio", "icon": "palette" }]
  }
}
```

| Field | Rules |
|---|---|
| `pages[].tab`, `route` | Required. |
| `pages[].builtin` | Key of a first-party page compiled into the control UI. |
| `pages[].entry` | HTTP path of an ES module the plugin serves; must be under `/plugins/<id>/`. |
| `pages[]` | Needs `builtin` or `entry` (both allowed). |
| `nav[].tab`, `label` | Required; `tab` must match a page. `icon` optional. `group` is still parsed but no longer places the entry inside a core sidebar group. |
| `navSection.items[].page` | Must be a declared page tab, listed once. Without `items` the section lists every page in manifest order. |
| `navSection.order` | Number, default 1000. Sections sort by order, then title. |
| `landing` | A page tab the operator may opt into as the start page via `plugins.landing: "<id>"`. |

These are declarations only: there is no `api.registerPage`. The control UI builds the sidebar from the `plugins.list` RPC.

Important limit for third-party plugins: today the control UI only routes a page as a sidebar tab when its `builtin` key is in the `FIRST_PARTY_PAGES` map compiled into the UI (`routableTab` in `ui/src/ui/plugin-host.ts`). A page that declares only `entry` parses and loads, and its `nav`/`page` contributions are listed in Setup › Plugins, but it gets **no sidebar section and no route**. See [ui-guide.md](ui-guide.md) for what does render and how to ship a UI that works now.

## Other contributes blocks

Source: `src/plugins/manifest-v2.ts` (strict parsing), `src/plugins/contributions.ts` (catalog and toggle keys).

| Block | What it does | Third-party usable today | Docs |
|---|---|---|---|
| `rpc`, `rpcAliases` | RPC methods and legacy names | Yes | this page |
| `http`, `selfAuthHttp` | HTTP routes | Yes | this page |
| `tools` | Agent tools | Yes | [agent-tools.md](agent-tools.md) |
| `services` | Background services | Yes | this page |
| `nav`, `pages`, `navSection`, `landing` | Sidebar and pages | Only with a first-party `builtin` key | [SIDEBAR-SECTIONS.md](SIDEBAR-SECTIONS.md), [ui-guide.md](ui-guide.md) |
| `mapRoom` | Room on the agent mesh map. Default room for any plugin with pages; `false` opts out | Yes (themes and props are a fixed list) | [MAP-ROOMS.md](MAP-ROOMS.md) |
| `learn` | Guided Learn tracks (inline or a `learn.json` file) | Yes | [LEARN.md](LEARN.md) |
| `clockSections` | Sections in the expanded topbar clock | No: `builtin` renderer key required | [CLOCK-SECTIONS.md](CLOCK-SECTIONS.md) |
| `topbarSlots` | Controls in the app topbar | No: `builtin` renderer key required | [TOPBAR-SLOTS.md](TOPBAR-SLOTS.md) |
| `settings` | Sections on the plugin's Setup › Plugins page | No: `builtin` renderer key required; unknown keys render nothing | (no dedicated doc yet) |
| `setupChecks` | "Needs setup" glow and banner; pair with `api.registerSetupCheck` | Yes (own pages only) | `docs/gateway/setup-status.md` |
| `panels` | Chat panel kinds (`<id>.<kind>`); pair with `api.registerPanelKind` and see [Plugin panel data](#plugin-panel-data) | Yes; host API v1, may change | |
| `voiceProviders` | Voice provider ids; pair with `api.registerVoiceProvider` | Yes | [voice-providers.md](voice-providers.md) |
| `agents` | Roster-agent JSON files inside the plugin, seeded while enabled | Yes (paths must stay inside the plugin) | |
| `mcpServers` | Bundled stdio MCP servers: `{ id, command, args, label? }` | Yes; `id` and `command` are required | |
| `importers` | Data importers on the Data tab: `{ id, label, method, accept?, input? }`; `method` must be a declared RPC | Yes | [PLUGINS-PAGE-CONTROL.md](PLUGINS-PAGE-CONTROL.md) |

The catalog in `contributions.ts` also recognises `subviews`, `widgets`, `overlays`, `launchpad`, `mapLayers`, `cron`, `skills`, `channels`, `providers`, `hooks`, `sidecars` and `roster` so they can be **listed and toggled** in Setup › Plugins. For most of these the toggle is saved but nothing in the host acts on it yet (`live: false`). Do not rely on them doing anything unless a dedicated doc says so.

Every entry that is an object may carry `requires: string[]` (see [Permissions](#permissions-and-gated-permissions)). The owner's page for all of this is described in [PLUGINS-PAGE-CONTROL.md](PLUGINS-PAGE-CONTROL.md).

## Other register methods

Source: `src/plugins/types.ts`, `src/plugins/registry.ts`.

| Method | Summary |
|---|---|
| `on(hookName, handler, { priority? })` | Typed lifecycle hooks: `before_agent_start`, `agent_end`, `before_compaction`, `after_compaction`, `message_received`, `message_sending`, `message_sent`, `before_tool_call`, `after_tool_call`, `tool_result_persist`, `session_start`, `session_end`, `gateway_start`, `gateway_stop`. Some return values change behaviour, for example `before_tool_call` may return `{ block: true, blockReason }` and `message_sending` may return `{ content }` or `{ cancel: true }`. |
| `registerHook(events, handler, { name, description?, register? })` | Internal hook events. `name` is required (a registration without one is dropped with a warning). The handler is only attached when `hooks.internal.enabled` is true in config. |
| `registerCommand({ name, description, acceptsArgs?, requireAuth?, handler })` | A chat command that runs before built-in commands and before the agent. `requireAuth` defaults to true. Duplicate or invalid names are rejected. |
| `registerCli(registrar, { commands? })` | Adds commander subcommands. |
| `registerChannel(plugin \| { plugin, dock? })` | A messaging channel. |
| `registerProvider(provider)` | Model provider auth flows. Ids must be unique. |
| `registerMediaProvider(provider)` | Image/video generation provider. Ids must be unique. |
| `registerVoiceProvider(provider)` | Voice backend; see [voice-providers.md](voice-providers.md). |
| `registerPanelKind(def)` | v2 only; `def.methods` may only name the plugin's own `read`-scoped RPCs. |
| `registerSetupCheck({ id, evaluate, priority?, localOnly? })` | v2 only. `evaluate` must be cheap and local: read config or stores, never spawn or hit the network. A returned `action` may only point at the plugin's own pages. |

```ts
api.on("before_tool_call", (event) => {
  if (event.toolName === "my_plugin_send" && !event.params.to) {
    return { block: true, blockReason: "a recipient is required" };
  }
});
```

## Plugin panel data

Source: `ui/src/ui/chat-panels/plugin-panel.ts`, `src/chat-panels/types.ts`. Example: `extensions/flypic/src/panels.ts`.

A kind registered with `registerPanelKind` has no UI code of its own. Its `resolve(query, call)` returns `{ data, summary, count, empty, title?, link?, refreshMs? }` and the control UI renders `data` from the blocks below, all optional. The same data drives the inline chat card and the expanded modal. `refreshMs` on a result overrides the kind's interval for that result; `0` stops polling, for example once a tracked job has finished.

| Block | Shape | Renders |
|---|---|---|
| `icon` | icon name | header icon |
| `badge` | `"live" \| "demo"` | demo pill |
| `alert` | `{ tone: ok\|warn\|danger, title?, message, details?: [{label, value}] }` | a callout; put the real error and identifiers (request ids) here |
| `progress` | `{ label?, startedAt?: ms, typicalSeconds?, basis? }` | a bar and clock that tick every second; capped at 95 % until the next refresh replaces it, with "taking longer than usual" past the typical time |
| `media` | `[{ url, kind: image\|video, alt? }]` | image or video player (http(s), blob, same-origin path or `data:image/*` / `data:video/*` URLs only) |
| `fields` | `[{ label, value, mono?, clamp? }]` | key/value list |
| `tiles`, `table`, `candles`, `notes` | as before (v0) | stat tiles, table, candle chart, footnotes |
| `filters` | `[{ param, label?, value?, options: [{value, label}] }]` | chips; picking one re-resolves with `query[param] = value` (`""` clears it) |
| `search` | `{ param, placeholder?, value? }` | a search box that sets `query[param]` |
| `grid` | `{ layout: media\|list, items, groups?: [{id, label}], empty?, more?: {param, value, label?} }` | thumbnail grid (click → `item.detail`) or rows with per-item actions, optionally grouped by `item.group` |
| `actions` | `[action]` | a button row |

Grid items are `{ id, title, subtitle?, group?, media?, badges?: [{label, tone}], actions?, detail?: { media?, fields?, actions?, alert? } }`.

An **action** is `{ id, label, icon?, tone?: primary|danger, title?, disabled?, … }` plus one of:

- `href` (+ `download` file name): open an http(s) link in a new tab, go to an in-app `/path`, or download the URL.
- `rpc: { method, params? }`: call **one of the plugin's own RPCs** (`<pluginId>.*`) in the user's UI session. The gateway still checks that session's scopes, and `chat.panel.*` can't be called. `"$origin"` / `"$path"` in `params` become the gateway origin and the current path. Add `input: { param, label?, placeholder?, multiline?, submitLabel? }` to ask for text first (it goes in `params[param]`), `confirm: "…"` to ask first, `open: "<field>"` to open a URL field of the result in a popup (OAuth sign-in), and `done: "…"` for a success note. If the result carries a `chatPanel` ref, that panel opens as a live card inside this one. The panel then re-resolves.

To make a tool open a panel, put a data-free `ChatPanelRef` (`{ v: 1, panelId, kind, query, title, display, summary, count, empty, error, link, refreshMs, ts }`) as the **first** key of the tool's JSON result, under `chatPanel`, on channels that render UI (`ctx.messageChannel` is `webchat`, `voice` or unset). `show_panel` lists and accepts loaded plugins' kinds.

## Plugin config

Source: `src/plugins/loader.ts` (`validatePluginConfig`), `src/gateway/server-methods/plugins.ts` (`secretConfigKeys`, `maskPluginConfig`, `mergePluginConfig`, `plugins.config.get`/`set`), `src/plugins/types.ts` (`PluginConfigUiHint`). Manifest fields: [manifest.md](manifest.md).

`configSchema` (JSON Schema, required even when empty) and `uiHints` live at the top level of the manifest:

```json
"configSchema": {
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "baseUrl": { "type": "string", "minLength": 1, "default": "https://api.flypic.ai" },
    "apiKey": { "type": "string", "writeOnly": true },
    "defaultImageModel": { "type": "string" }
  }
},
"uiHints": {
  "baseUrl": { "label": "FlyPic API base URL", "placeholder": "https://api.flypic.ai" },
  "apiKey": { "label": "FlyPic API key", "sensitive": true },
  "defaultImageModel": { "label": "Default image model", "advanced": true }
}
```

(From `extensions/flypic/infinibot.plugin.json`.)

- Values are stored at `plugins.entries.<id>.config` and validated against the schema at load. Invalid config puts the plugin in status `error` (`invalid config: ...`). The validated value is `api.pluginConfig`.
- `uiHints` keys: `label`, `help`, `advanced`, `sensitive`, `placeholder`. Setup › Plugins generates the settings form from the schema and the hints.
- Saving the form (`plugins.config.set`) validates against the schema and, when the plugin is loaded, restarts the gateway so `register` runs again with the new values.

```ts
type Cfg = { baseUrl?: string; apiKey?: string };
export default function register(api: InfiniBotPluginApi) {
  const cfg = (api.pluginConfig ?? {}) as Cfg;
  const baseUrl = cfg.baseUrl?.trim() || "https://api.example.com";
}
```

### Secrets are write-only

A config key is treated as a secret when any of these is true:

- `uiHints.<key>.sensitive === true`
- the schema property has `writeOnly: true`, `format: "password"` or `x-secret: true`
- the key name ends in `token`, `secret`, `password`, `passwd`, `apiKey`/`api_key`/`api-key`, `privateKey` or `credential` (optionally plural), case-insensitive

For secret keys:

- `plugins.config.get` never returns the value. It returns `{ "__secret": true, "set": true | false }`.
- On save, an omitted, blank or still-masked secret keeps its stored value. Sending `null` clears it.
- The plugin itself still reads the real value from `api.pluginConfig`.

Write-only is a property of the Setup › Plugins config RPCs. If you add your own RPC that returns settings, mask secrets yourself, as FlyPic does:

```ts
api.registerGatewayMethod("flypic.settings.get", ({ respond }) => {
  respond(true, {
    baseUrl: settings.baseUrl,
    apiKeyConfigured: Boolean(settings.apiKey),
    apiKeyMasked: maskSecret(settings.apiKey),
  });
});
```

For secrets you store in your own data directory, `encryptInstallSecret` / `decryptInstallSecret` from the SDK use the install's key (AES-256-GCM), the same store email accounts use.

`api.runtime.config.writeConfigFile` can write the whole gateway config. A plugin should only touch its own `plugins.entries.<id>` entry.

## Plugin data directory

Source: `src/plugins/plugin-data.ts`, `src/gateway/server-methods/plugins.ts` (`plugins.data.*`).

A plugin's own data belongs in `<stateDir>/plugin-data/<id>/`. `resolveStateDir()` is tenant-namespaced in SaaS mode, so the same code is per-tenant there.

There is no `api.storage` helper today: build the path yourself and create the directory.

```ts
import fs from "node:fs";
import path from "node:path";

function dataDir(api: InfiniBotPluginApi): string {
  const dir = path.join(api.runtime.state.resolveStateDir(), "plugin-data", api.id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
```

Inside a service, `ctx.stateDir` is the state directory resolved once at process start (`STATE_DIR` in `src/config/paths.ts`). On a single-profile install that is the same root. Where the state directory is resolved per request (SaaS tenant namespaces), call `api.runtime.state.resolveStateDir()` at the point of use instead of caching `ctx.stateDir`.

What the host does with that directory (Setup › Plugins › Data):

| Operation | RPC | Behaviour |
|---|---|---|
| Size | `plugins.get` | Bytes and file count. Symlinks are skipped. |
| Export | `plugins.data.export` | A JSON bundle (`format: "infinibot-plugin-data@1"`) with every file base64-encoded. Refused above 20 MB total. |
| Import | `plugins.data.import` | `merge` (default) or `replace` (clears first). The bundle's `pluginId` must match, the size cap applies, and paths that escape the directory are rejected. |
| Clear | `plugins.data.clear` | Removes the directory. |
| Uninstall | `plugins.uninstall` | Keep-data or remove-data. |

Consequences for authors:

- Only files under `plugin-data/<id>/` are counted, exported, imported, cleared or removed on uninstall. Data kept anywhere else is invisible to the owner's data controls.
- Keep the directory under 20 MB if you want export to work, or expose your own export RPC and declare it under `contributes.importers` for the reverse direction.
- Declare the directory in `permissions.fs` (for example `"<stateDir>/plugin-data/my-plugin"`) so the consent text matches what you do.
- `resolveSharedDir()` is for install-wide state shared by every profile (provider credentials, device links). Robovoice uses `<sharedDir>/plugin-data/robovoice`. Data there is **not** covered by the per-profile data controls above.

## Permissions and gated permissions

Source: `src/plugins/manifest-v2.ts` (`PluginPermissions`), `src/plugins/contributions.ts` (`listPermissionItems`, `isRequirementRevoked`), `src/plugins/host-state.ts`.

```json
"permissions": {
  "network": ["api.example.com"],
  "fs": ["<stateDir>/plugin-data/my-plugin"],
  "exec": false,
  "secrets": ["EXAMPLE_API_KEY"],
  "channels": [],
  "credits": false,
  "gated": [
    { "id": "orders", "label": "Place orders", "description": "Lets the plugin send orders to your account." }
  ]
}
```

### What permissions are today

Permissions are a **declaration plus a consent and gating model**. They are flattened into keys the owner can revoke individually in Setup › Plugins:

| Manifest | Key |
|---|---|
| `network: ["api.example.com"]` | `network:api.example.com` |
| `fs: ["..."]` | `fs:<value>` |
| `secrets: ["NAME"]` | `secrets:NAME` |
| `channels: ["telegram"]` | `channels:telegram` |
| `exec: true` | `exec` |
| `credits: true` | `credits` |
| `gated: [{ id: "orders" }]` | `gated:orders` |

The host does **not** sandbox an in-process plugin: it does not intercept `fetch`, the filesystem or `child_process`. What the host enforces is the link between permission keys and contributions, described next. See [security-model.md](security-model.md).

### requires on contributions

Any contribution entry written as an object may list the permission keys it depends on:

```json
"rpc": [
  { "method": "flypic.generate", "scope": "write",
    "requires": ["network:api.flypic.ai", "secrets:FLYPIC_API_KEY"] }
],
"tools": [
  { "name": "infinitrade_order", "requires": ["gated:orders"] }
]
```

When a required key is revoked (or, for a gated key, not granted), the contribution is off:

- RPC: the call fails with a "turned off" error.
- HTTP route: 404.
- Tool: left out of agent runs.
- Service: not started, or stopped when the state changes.

A bare category (`"requires": ["network"]`) is conservatively unmet when **any** key in that category is revoked.

All of this applies on the next call. Contribution toggles, permission revokes and grants never need a restart.

### Gated permissions

Entries in `permissions.gated` are high-risk capabilities that are **off until the owner grants them**. Each needs `id` and `label`; `description` becomes the consent text. In the host's effective state an ungranted gated key counts as revoked, so every contribution that `requires` it stays off by default.

To check a grant in code, use the SDK export and read it **on every call**, not once at load, so a grant or revoke applies immediately. Real example (`extensions/infinitrade/index.ts`):

```ts
import { isPluginPermissionGranted } from "infinibot/plugin-sdk";

// Owner grant of the gated `orders` permission, read on every call so a
// grant/revoke in Setup › Plugins applies without a restart.
const ordersGranted = () => isPluginPermissionGranted("infinitrade", "gated:orders");
```

`isPluginPermissionGranted(pluginId, key)` works for any key (`"exec"`, `"network:api.example.com"`, `"gated:orders"`). It returns false for a revoked key and for an ungranted gated key.

Use both layers for anything dangerous: `requires` on the contribution so the host turns the whole tool or RPC off, and an explicit `isPluginPermissionGranted` check inside code paths that are shared with ungated features.

Owner state is stored in config under `plugins.entries.<id>`: `contributions.disabled`, `contributions.enabled` (default-off items switched on), `permissions.revoked`, `permissions.granted`.

## Logging

Source: `src/plugins/plugin-logs.ts`, `src/plugins/registry.ts` (`createApi`), `src/plugins/services.ts`.

```ts
api.logger.info("connected");
api.logger.warn("retrying");
api.logger.error(`sync failed: ${String(err)}`);
api.logger.debug?.("verbose detail"); // debug is optional: use ?.
```

- `PluginLogger` is `{ info, warn, error, debug? }`, each taking a single string.
- Every line goes to the gateway's `plugins` subsystem log **and** to a per-plugin ring buffer shown in Setup › Plugins › Health & Logs (`plugins.logs`).
- The buffer is in memory only, holds the last 300 lines per plugin, and truncates each message to 2000 characters. It is empty after a restart.
- Host events about your plugin (service started/stopped/failed, settings saved, toggles) are written to the same buffer with source `host`.
- A service's `ctx.logger` is captured the same way, except `debug`, which goes only to the subsystem log.
- `api.runtime.logging.getChildLogger(bindings)` returns a structured child logger; its lines are **not** captured in the per-plugin buffer.
- Never log secrets. The buffer is readable by anyone who can open the Plugins page.

## Enable, disable and restarts

Source: `src/gateway/server-methods/plugins.ts`, `src/plugins/config-state.ts`, `src/plugins/host-state.ts`.

| Action | RPC | Restart |
|---|---|---|
| Enable or disable the plugin | `plugins.setEnabled` | **Gateway restart** |
| Save settings | `plugins.config.set` | **Gateway restart** when the plugin is loaded |
| Full reload | `plugins.restart` with `full: true` | **Gateway restart** |
| Restart services only | `plugins.restart` | No: services restart in place |
| Uninstall | `plugins.uninstall` | **Gateway restart** when it was loaded or its package directory was removed |
| Toggle one contribution | `plugins.contributions.set` | No |
| Revoke or grant a permission | `plugins.permissions.set` | No |
| Appearance | `plugins.appearance.set` / `reset` | No |
| Landing page | `plugins.setLanding` | No |

What a restart means for your plugin:

- `register` runs again from scratch in a new load. Module-level state is gone; anything you need must be in config or your data directory.
- Service `stop` is called on shutdown (in reverse start order). Make it idempotent and fast.
- In-flight requests and agent runs on the gateway are interrupted. Do not design a flow that needs the owner to toggle the plugin while work is running.
- After a disable, none of the plugin's RPCs, routes, tools, services, nav entries or pages exist. Data and config are kept.

Default enable state (`resolveEnableState`): a non-bundled plugin that is discovered is enabled unless `plugins.entries.<id>.enabled` is `false`, it is in `plugins.deny`, or a `plugins.allow` list exists and omits it. Bundled plugins are off by default apart from a small built-in set.

## Cloud and tenant restrictions

Source: `src/saas/fleet-plugins.ts`, `src/plugins/config-state.ts`, `src/plugins/host-state.ts`.

These rules apply only on a hosted fleet tenant Machine (`SAAS_MODE` on and `FLEET_TENANT_ID` set). Self-hosted installs are unaffected.

- **Third-party plugins do not load.** Any plugin that is not bundled and not in the cloud catalogue gets status `unsupported` with the reason `Third-party plugins are not available in InfiniBot Cloud yet.` The source comment gives the condition for lifting this: the marketplace registry and a mandatory sandbox.
- **First-party plugins** are governed by a catalogue: `available`, `coming-soon` or `self-host-only`. A plugin that needs host exec, a local sidecar or operator-owned credentials is listed as coming soon or self-host only rather than loading broken.
- **Plan entitlements.** The orchestrator passes `FLEET_PLUGIN_POLICY` (`{"plan","allowed":[...]|"all","max"}`). A plugin outside the plan is `locked`. When the variable is missing or malformed, a conservative starter set applies. `max` caps how many plugins may be on at once.
- **Platform-blocked gated permissions.** The catalogue can list gated keys the platform never grants on a tenant Machine. They stay revoked even if the tenant's config records a grant, so `isPluginPermissionGranted` returns false and every contribution that `requires` them stays off.
- **Tenant KEK.** A catalogue entry can require the per-tenant key envelope; without it the plugin is listed as coming soon.

Writing a plugin that will be cloud-ready later:

- Keep all data under `resolveStateDir()` (already tenant-namespaced).
- Scope by `client.saasTenantId` / `client.saasNamespace` in RPC handlers where relevant.
- Do not depend on `exec`, local sidecars or host binaries.
- Put anything high-risk behind a gated permission.

## What infinibot/plugin-sdk exports

Source: `src/plugin-sdk/index.ts`, `src/plugin-sdk/appearance-client.ts`.

The SDK is a large barrel, mostly channel-plugin helpers. The parts a typical v2 plugin uses:

| Export | Use |
|---|---|
| Types `InfiniBotPluginApi`, `InfiniBotPluginService`, `InfiniBotPluginServiceContext`, `InfiniBotPluginSetupCheck`, `PluginRuntime` | Plugin entry typing |
| Types `GatewayRequestHandler`, `GatewayRequestHandlerOptions`, `RespondFn` | RPC handlers |
| Type `AnyAgentTool`; `jsonResult`, `readStringParam`, `readNumberParam`, `createActionGate`, `stringEnum`, `optionalStringEnum` | Agent tools |
| `callGatewayTool`, type `GatewayCallOptions` | Calling gateway RPCs from an agent tool |
| `isPluginPermissionGranted` | Permission and gated-permission checks |
| `emptyPluginConfigSchema` | A config schema object for plugins with no config |
| `normalizePluginHttpPath`, `registerPluginHttpRoute` | HTTP path helpers |
| `resolveSelfCallAuthHeaders` | Auth header for calling your own gated routes |
| `encryptInstallSecret`, `decryptInstallSecret` | Encrypting secrets you store yourself |
| Types `PanelKindDef`, `PanelQuery`, `PanelKindOutput`, `ChatPanelRef`, `PanelCaller`, `PanelLink` | Chat panel kinds |
| Types `VoiceProvider` and related; `VoiceProviderError` | Voice providers |
| Types `MediaGenerationProvider` and related; `getMediaProviderRegistry` | Media providers |
| `listAgentPersonas`, type `AgentPersona` | Listing configured agents |
| `registerLogTransport`, `emitDiagnosticEvent`, `onDiagnosticEvent`, `isDiagnosticsEnabled` | Diagnostics |
| `detectMime`, `extensionForMime`, `getFileExtension`, `loadWebMedia` | Media utilities |
| `PLUGIN_APPEARANCE_EVENT`, `readPluginAppearance`, `onPluginAppearanceChange`, `findPluginScope`, `listenPluginAppearanceBridge` and types | Browser-side appearance helpers; see [ui-guide.md](ui-guide.md) |
| Types `PluginAppearanceManifest`, `PluginAppearanceOverride`, `ResolvedPluginAppearance` | Appearance typing |

Also exported, but first-party seams you should not build on: `contentStudio`, `canvasRuntime`, `getFederationHub`, `registerProductStoreProvider`, the business-role database bridge (`ensureBusinessRoleDatabase` and friends), `getRelationsStore`, `getAuditStore`, and the per-channel account, onboarding and normalisation helpers.

The appearance helpers are pure DOM code. They are importable from the SDK in Node-side plugin code, but a browser module served by your plugin cannot `import "infinibot/plugin-sdk"` (that alias only exists in the gateway's loader). In a no-build UI module, use the CSS variables directly or copy the small helper.

## Not implemented

These appear in [PLUGIN-PLATFORM.md](PLUGIN-PLATFORM.md) (design) but do not exist in `InfiniBotPluginApi` or the SDK today. Do not write code against them.

| Design doc | Reality |
|---|---|
| `definePlugin`, `z` from `@infinibot/plugin-sdk` | Not exported. The import path is `infinibot/plugin-sdk`, resolved by a loader alias; there is no published npm package. |
| `api.rpc`, `api.tool`, `api.cron`, `api.panelKind` | Use `registerGatewayMethod`, `registerTool`, `registerPanelKind`. There is no cron registration method. |
| `api.storage.kv/sqlite/dir` | Not present. Use the data directory directly. |
| `api.secrets`, `api.credits`, `api.fetch`, `api.events`, `api.federation`, `api.sidecars`, `api.mcp`, `api.roster`, `api.ui`, `api.verification` | Not present. |
| `"runtime": "sandboxed"`, tier T2 process sandbox | Not present. All plugins run in-process. |
| Sandboxed iframe pages with a postMessage RPC bridge | Not present. Only the appearance half of the bridge exists as helpers. |
| `@infinibot/plugin-sdk/ui` kit (`<ib-page>`, `<ib-card>`, ...) | Not present. |
| Hot load on enable | Not present. Enable and disable restart the gateway. |
| `migrations/NNN-*` run by the host | Not present. Run your own migrations at service start. |
