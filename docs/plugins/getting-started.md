# Getting started with plugins

This guide takes you from nothing to an installed plugin: scaffold, run, pack, install. It follows `examples/plugin-hello`, which is exactly what the scaffold command writes for the id `hello`.

See also: [manifest reference](manifest-reference.md), [API reference](api-reference.md), [UI guide](ui-guide.md), [packaging](packaging.md), [updates](updates.md), [security model](security-model.md), [publishing](publishing.md), [registry API](registry-api.md).

## Before you start

- InfiniBot 2026.6.30 or newer, with the `infinibot` command on your path.
- A plugin is plain JavaScript or TypeScript that runs inside the gateway. The example needs no build step.

## 1. Scaffold

```bash
infinibot plugins create hello --publisher my-publisher
cd hello
```

Options: `--dir <path>` (default `./<id>`), `--name <display name>`, `--publisher <id>`.

The id must be lowercase letters, digits and dashes. It becomes the install folder, the RPC namespace (`hello.*`) and the HTTP prefix (`/plugins/hello/`).

You get nine files:

| File | What it is |
| --- | --- |
| `infinibot.plugin.json` | The manifest: identity, settings, what the plugin adds, permissions. |
| `package.json` | Names the entry file (`infinibot.extensions`). |
| `index.js` | The plugin entry. Runs in the gateway. |
| `ui.js` | A small UI panel, served by the plugin. |
| `assets/icon.svg` | The listing icon. |
| `README.md`, `CHANGELOG.md`, `LICENSE` | Shown to users and reviewers. |
| `.ibpluginignore` | Files left out of the package. |

## 2. Read the manifest

`examples/plugin-hello/infinibot.plugin.json`, shortened:

```json
{
  "manifestVersion": 2,
  "id": "hello",
  "name": "Hello",
  "version": "0.1.0",
  "publisher": "infinibot-examples",
  "minHostVersion": "2026.6.30",
  "engines": { "infinibot-plugin-api": "^2.0.0" },
  "listing": { "tagline": "Say hello from Hello.", "description": "…", "icon": "assets/icon.svg" },
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": { "greeting": { "type": "string", "default": "Hello" } }
  },
  "ui": { "navLabel": "Hello", "entry": "/plugins/hello/ui.js" },
  "contributes": {
    "rpc": [{ "method": "hello.greet", "scope": "read" }],
    "http": ["/plugins/hello/ui.js"],
    "tools": ["hello_greet"]
  },
  "permissions": {}
}
```

The manifest is a contract. The host rejects an RPC method, an HTTP route or a tool that the plugin registers without declaring it under `contributes`. Every field is in the [manifest reference](manifest-reference.md).

## 3. Read the entry

`examples/plugin-hello/index.js` registers one of each thing the manifest declares:

```js
export default {
  id: "hello",
  name: "Hello",

  register(api) {
    // Gateway RPC, callable from the UI panel and other gateway clients.
    api.registerGatewayMethod("hello.greet", ({ params, respond }) => {
      respond(true, { message: greet(api, params?.name) });
    });

    // Agent tool.
    api.registerTool({
      name: "hello_greet",
      label: "Hello: greet",
      description: "Return a friendly greeting for a name.",
      parameters: { type: "object", properties: { name: { type: "string" } } },
      async execute(_toolCallId, params) {
        const message = greet(api, params?.name);
        return { content: [{ type: "text", text: message }], details: { message } };
      },
    });

    // The UI module. The browser imports it, so it is served without credentials.
    api.registerHttpRoute({ path: "/plugins/hello/ui.js", publicAsset: true, handler: /* … */ });
  },
};
```

- `api.pluginConfig` holds the settings the owner saved, validated against `configSchema`.
- `register` must be synchronous. A returned promise is ignored.
- The full API is in the [API reference](api-reference.md). The panel contract (`export default function mount(container, { client, pluginId })`) is in the [UI guide](ui-guide.md).

## 4. Run it from your folder

Link the folder so the gateway loads it in place, with no copy:

```bash
infinibot plugins install --link .
infinibot plugins enable hello
# restart the gateway
infinibot plugins list
```

Then:

- Open **Setup › Plugins › Hello**. The panel is in the plugin's page; type a name and press **Greet**.
- Change the greeting under **Settings** and save. Saving settings restarts the gateway.
- Ask an agent to use the `hello_greet` tool.

After you edit the code, restart the gateway to load the change.

`infinibot plugins doctor` lists load errors, such as an undeclared RPC method.

## 5. Validate and pack

```bash
infinibot plugins validate .
infinibot plugins pack .
```

```
Packed hello 0.1.0
file:   ./hello-0.1.0.ibplugin.zip (4.9 KB, 8 files)
sha256: f33077f9…
```

`pack` writes the zip and a `.sha256` file next to it. Packing the same contents again gives the same bytes and the same checksum. The format, the limits and the ignore file are described in [packaging](packaging.md).

## 6. Install the package

Remove the link first, so the id is free:

```bash
infinibot plugins disable hello
# remove the folder from plugins.load.paths in your config, then:
infinibot plugins install ./hello-0.1.0.ibplugin.zip
```

The command verifies the checksum from `hello-0.1.0.ibplugin.zip.sha256`, prints what the plugin asks permission for, and asks before it installs.

In the app: open **Setup › Plugins**, press **Import plugin** (or drop the zip on the page), read the review, and confirm.

The plugin is installed **off**. Turn it on in Setup › Plugins, or:

```bash
infinibot plugins enable hello
# restart the gateway
```

## 7. Ship an update

1. Change the code.
2. Raise `version` in `infinibot.plugin.json` (and `package.json`), and add an entry to `CHANGELOG.md`.
3. `infinibot plugins pack .`
4. Install the new zip the same way. It is treated as an update: settings, data, the on/off switch and granted permissions are kept, and the previous version is kept for rollback.

```bash
infinibot plugins rollback hello
```

To publish to the marketplace so users get the update in the app, see [publishing](publishing.md).

## Command summary

| Command | What it does |
| --- | --- |
| `infinibot plugins create <id>` | Scaffold a plugin. |
| `infinibot plugins validate <dir\|zip>` | Check a folder or a package. |
| `infinibot plugins pack <dir>` | Build the package zip and its SHA-256. |
| `infinibot plugins install <zip\|url>` | Install a package (review first, installed off). |
| `infinibot plugins install <id> --marketplace` | Install from the marketplace. |
| `infinibot plugins install --link <dir>` | Load a folder in place, for development. |
| `infinibot plugins enable <id>` | Turn a plugin on (restart the gateway). |
| `infinibot plugins disable <id>` | Turn a plugin off (restart the gateway). |
| `infinibot plugins updates` | Check the registry for updates. |
| `infinibot plugins update <id>` | Update one plugin from the registry (`--all` for every plugin). |
| `infinibot plugins rollback <id>` | Return to the previous version. |
| `infinibot plugins auto-update <id> on\|off` | Automatic updates for one plugin (default off). |
| `infinibot plugins marketplace [query]` | List marketplace plugins. |
| `infinibot plugins list` | List discovered plugins. |
| `infinibot plugins info <id>` | Show one plugin's details. |
| `infinibot plugins doctor` | Report load errors. |

## What the example does not show

- A routed page in the sidebar. Today only first-party pages compiled into the control UI get a sidebar route; a third-party plugin's UI is the panel on its Setup › Plugins page. See the [UI guide](ui-guide.md).
- Permissions. The example asks for none. See the [security model](security-model.md).
- A build step. If you write TypeScript or use Lit, compile before you pack, and compile UI code with the UI compiler settings described in the [UI guide](ui-guide.md).
