# Plugin UI guide

This guide covers how a plugin puts UI into the InfiniBot control UI: the two page kinds (`builtin` and `entry`), exactly what the host does with each today, a complete entry module you can copy that needs no build step, how to call gateway RPCs from it, how to theme it with InfiniBot design tokens, accessibility basics, and the pitfalls first-party plugins already hit. It describes the code as it is; the limits for third-party pages are stated plainly in the first section.

See also:

- [getting-started.md](getting-started.md)
- [manifest-reference.md](manifest-reference.md)
- [packaging.md](packaging.md)
- [updates.md](updates.md)
- [security-model.md](security-model.md)
- [publishing.md](publishing.md)
- [registry-api.md](registry-api.md)
- [api-reference.md](api-reference.md) (backend API: RPC, HTTP routes, permissions)
- [SIDEBAR-SECTIONS.md](SIDEBAR-SECTIONS.md), [TOPBAR-SLOTS.md](TOPBAR-SLOTS.md), [CLOCK-SECTIONS.md](CLOCK-SECTIONS.md), [MAP-ROOMS.md](MAP-ROOMS.md), [LEARN.md](LEARN.md), [PLUGINS-PAGE-CONTROL.md](PLUGINS-PAGE-CONTROL.md)

## The two page kinds

Source: `src/plugins/manifest-v2.ts` (`PluginPageContribution`), `ui/src/ui/plugin-host.ts`, `ui/src/ui/app-render.ts`, `ui/src/ui/views/plugin-entry-page/index.ts`, `ui/src/ui/views/plugins/index.ts`.

A `contributes.pages[]` entry needs `tab`, `route`, and at least one of `builtin` or `entry`.

| | `builtin` | `entry` |
|---|---|---|
| What it is | Key of a page compiled into the control UI bundle as a lazy chunk | HTTP path of an ES module the plugin serves under `/plugins/<id>/` |
| Who can use it | First-party only: the key must exist in `FIRST_PARTY_PAGES` in `ui/src/ui/plugin-host.ts`, and the render block lives in `ui/src/ui/app-render.ts` | Any plugin |
| Where the UI code lives | In the InfiniBot repo (`ui/src/ui/views/...` or `extensions/<id>/ui/` bundled by the UI build) | In the plugin package |
| Build | Compiled by the control UI's Vite build | None required: plain JavaScript works |
| Gating | The tab is plugin-gated: no sidebar entry and a "plugin disabled" card unless the owning plugin is loaded and the `page:<tab>` contribution is on | Same host checks, plus the module route itself can be switched off |

### What the host renders today

This is the part to read carefully before designing a third-party UI.

**Sidebar pages require a `builtin` key.** The control UI gives a plugin a sidebar section and a route only for pages whose `builtin` key maps to a tab in `FIRST_PARTY_PAGES` (`routableTab` and `applyPluginList` in `ui/src/ui/plugin-host.ts`). A page that declares only `entry`:

- passes manifest validation and loads,
- appears as `page:<tab>` and `nav:<tab>` contributions in Setup › Plugins,
- gets a default room on the agent mesh map,
- but gets **no sidebar section and no route**.

The one entry-module page that is routed today is FlyPic's. Its manifest declares both keys, and `app-render.ts` has a render block for that specific tab that mounts the generic `<plugin-entry-page>` wrapper:

```json
"pages": [
  {
    "tab": "flypic",
    "route": "/flypic",
    "entry": "/plugins/flypic/ui-panel.js",
    "title": "FlyPic Studio",
    "builtin": "flypic"
  }
]
```

(`extensions/flypic/infinibot.plugin.json`.)

**What a third-party plugin can ship that renders now.** Declare a top-level `ui` block. The Plugins page mounts that module as a panel inside your plugin's detail page in Setup › Plugins (`mountV1Panel` in `ui/src/ui/views/plugins/index.ts`), using the same mount contract as `<plugin-entry-page>`:

```json
"ui": {
  "navLabel": "My Plugin",
  "navIcon": "palette",
  "entry": "/plugins/my-plugin/ui.js"
}
```

`navLabel` and `entry` are both required for the block to be recognised (`src/plugins/manifest.ts`).

**Recommendation.** Declare the same module in both places, as FlyPic does: `ui.entry` so it renders in Setup › Plugins today, and `contributes.pages[].entry` (plus `nav`) so the manifest already describes the page for when the host routes entry-only pages. One module, one HTTP route, one mount function.

**Not available.** The design in [PLUGIN-PLATFORM.md](PLUGIN-PLATFORM.md) §3.4 describes sandboxed iframe pages with a postMessage RPC bridge. The control UI does not mount plugin iframes. Only appearance helpers for that bridge exist (`postPluginAppearanceToFrame`, `listenPluginAppearanceBridge`), and nothing calls the host side.

The other UI contributions that take a renderer (`topbarSlots`, `clockSections`, `settings`) all require a `builtin` key and are first-party only; see the linked docs.

## The entry module contract

Source: `ui/src/ui/views/plugin-entry-page/index.ts`, `ui/src/ui/views/plugins/index.ts`.

The host derives an http(s) origin from the gateway WebSocket URL, dynamically imports `<origin><entry>`, and calls the module's **default export**:

```ts
type MountFn = (
  container: HTMLElement,
  ctx: { client: GatewayBrowserClient; pluginId: string },
) => void | (() => void);
```

- `container` is an empty element in the **light DOM**, inside a `[data-plugin-scope="<id>"]` wrapper. Your styles are not isolated unless you add a shadow root yourself, and the plugin's appearance variables cascade in.
- `ctx.client` is the control UI's own authenticated gateway client. You do not create a connection or handle credentials.
- `ctx.pluginId` is your plugin id.
- Return a cleanup function. The host calls it when the user navigates away or the element is removed. Errors thrown by cleanup are swallowed so they cannot break navigation.
- If the module has no default-export function, the host shows `plugin UI module has no default export`. If the import fails, it shows `Failed to load the <id> page: <error>`.
- The module is imported once per page load by the browser; a second visit calls the default export again with a new container. Keep per-mount state inside the mount function, not at module level.
- Custom element names are global to the document. Prefix yours with your plugin id and guard `customElements.define` (see the example).

### Serving the module

Source: `src/plugins/registry.ts` (`registerHttpRoute`), `src/gateway/server-http.ts`.

The route must be declared in `contributes.http` and registered with `publicAsset: true`:

```ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { InfiniBotPluginApi } from "infinibot/plugin-sdk";

export default function register(api: InfiniBotPluginApi) {
  const file = join(dirname(fileURLToPath(import.meta.url)), "ui.js");
  let source: string | undefined;
  try {
    source = readFileSync(file, "utf8");
  } catch (err) {
    api.logger.warn(`UI unavailable: ${String(err)}`);
  }

  api.registerHttpRoute({
    path: "/plugins/my-plugin/ui.js",
    publicAsset: true,
    handler: (_req, res) => {
      if (!source) return void res.writeHead(404).end("UI unavailable");
      res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" });
      res.end(source);
    },
  });

  api.registerGatewayMethod("my-plugin.items.list", ({ respond }) => {
    respond(true, { items: [{ id: "1", title: "First item" }] });
  });
}
```

Why `publicAsset`: every `/plugins/` path is behind the gateway HTTP auth gate, and a browser dynamic `import()` cannot attach the gateway bearer token. `publicAsset: true` makes the host serve that one path without authentication for `GET` and `HEAD` only. The host accepts the flag only when the path is exactly `ui.entry` or a `contributes.pages[].entry`; otherwise the registration is rejected with `public http asset must be a manifest-declared UI entry`.

Consequences:

- The module is world-readable to anyone who can reach the gateway. Never put secrets, tokens or tenant data in it. Fetch data through RPC after mount.
- Only that exact path is public. A second file (a CSS file, an image, a second module imported by relative path) is a separate route behind the gate, and a plain `import` or `<link>` will not authenticate against it. Ship the UI as **one self-contained module** with styles inlined.
- Set the JavaScript content type. Browsers refuse to execute a module served as `text/plain`.

Matching manifest:

```json
{
  "manifestVersion": 2,
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "engines": { "infinibot-plugin-api": "^2.0.0" },
  "configSchema": { "type": "object", "additionalProperties": false, "properties": {} },
  "ui": { "navLabel": "My Plugin", "entry": "/plugins/my-plugin/ui.js" },
  "contributes": {
    "pages": [{ "tab": "my-plugin", "route": "/my-plugin", "entry": "/plugins/my-plugin/ui.js", "title": "My Plugin" }],
    "nav": [{ "tab": "my-plugin", "label": "My Plugin" }],
    "rpc": [{ "method": "my-plugin.items.list", "scope": "read" }],
    "http": ["/plugins/my-plugin/ui.js"]
  },
  "permissions": {}
}
```

## A complete minimal entry module

This is a whole working `ui.js`: a plain custom element, no framework, no build step. It follows the contract above and avoids every pitfall in the last section. Save it next to the plugin entry file.

```js
// ui.js — served at /plugins/my-plugin/ui.js

const TAG = "my-plugin-page";

const CSS = `
  :host { display: block; color: var(--g-fg, #f5f5f4); font-size: calc(14px * var(--plugin-font-scale, 1)); }
  .wrap { display: grid; gap: var(--plugin-space, 12px); }
  h2 { margin: 0; font-size: 1.4em; }
  .muted { color: var(--muted, #a1a1aa); }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
  li {
    padding: var(--plugin-space, 12px);
    border: 1px solid var(--g-line, rgba(255, 255, 255, 0.12));
    border-radius: 10px;
    background: var(--plugin-surface, var(--card, #0f0f0f));
  }
  button {
    justify-self: start;
    min-height: 36px;
    padding: 0 14px;
    border-radius: 8px;
    border: 1px solid var(--plugin-accent, var(--g-primary, #fbbf24));
    background: transparent;
    color: var(--plugin-accent, var(--g-primary, #fbbf24));
    font: inherit;
    cursor: pointer;
  }
  button:focus-visible { outline: 2px solid var(--plugin-accent, var(--g-primary, #fbbf24)); outline-offset: 2px; }
  button[disabled] { opacity: 0.55; cursor: wait; }
  .error { color: var(--g-danger, #ef4444); }
  /* Rest state is fully visible; the animation is decoration only. */
  @media (prefers-reduced-motion: no-preference) {
    .wrap { animation: mp-in 160ms ease-out; }
    @keyframes mp-in { from { transform: translateY(4px); } to { transform: none; } }
  }
`;

class MyPluginPage extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.gateway = null;      // set by mount(); not "client"/"title"/"remove" etc.
    this.items = [];
    this.loading = false;
    this.problem = "";
    this.retryTimer = null;
    this.alive = false;
    // Bind once: these are passed around as callbacks.
    this.reload = this.reload.bind(this);
  }

  connectedCallback() {
    this.alive = true;
    this.draw();
    void this.reload();
  }

  disconnectedCallback() {
    this.alive = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  async reload(attempt = 0) {
    if (!this.alive || !this.gateway) return;
    this.loading = true;
    this.problem = "";
    this.draw();
    try {
      const res = await this.gateway.request("my-plugin.items.list", {});
      this.items = Array.isArray(res?.items) ? res.items : [];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Cold load: the page can mount before the socket has finished its
      // handshake. Retry a few times instead of showing an error or "empty".
      if (message === "gateway not connected" && attempt < 20) {
        this.retryTimer = setTimeout(() => void this.reload(attempt + 1), 500);
        return;
      }
      this.problem = message;
    }
    this.loading = false;
    this.draw();
  }

  draw() {
    const root = this.shadowRoot;
    root.textContent = "";

    const style = document.createElement("style");
    style.textContent = CSS;

    const wrap = document.createElement("div");
    wrap.className = "wrap";

    const heading = document.createElement("h2");
    heading.textContent = "My Plugin";

    const status = document.createElement("div");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.className = this.problem ? "error" : "muted";
    status.textContent = this.problem
      ? `Could not load items: ${this.problem}`
      : this.loading
        ? "Loading…"
        : `${this.items.length} item(s)`;

    const list = document.createElement("ul");
    for (const item of this.items) {
      const li = document.createElement("li");
      li.textContent = String(item.title ?? item.id ?? ""); // textContent, never innerHTML
      list.append(li);
    }

    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.textContent = "Refresh";
    refresh.disabled = this.loading;
    refresh.addEventListener("click", () => void this.reload());

    wrap.append(heading, status, list, refresh);
    root.append(style, wrap);
  }
}

if (!customElements.get(TAG)) customElements.define(TAG, MyPluginPage);

export default function mount(container, ctx) {
  const el = document.createElement(TAG);
  el.gateway = ctx.client;
  container.replaceChildren(el);

  // Live updates: gateway events arrive on the same socket.
  const unsubscribe = ctx.client.subscribe((evt) => {
    if (evt?.event === "my-plugin.items.changed") void el.reload();
  });

  return () => {
    unsubscribe();
    el.remove();
  };
}
```

Notes on the example:

- A shadow root keeps the page's CSS from leaking into the control UI and the reverse. CSS custom properties still inherit through it, so the plugin's appearance variables work.
- The gateway client is stored as `gateway`, and the reload method is `reload`: neither collides with an `HTMLElement` member.
- All text goes in through `textContent`. If you build HTML strings, escape every interpolated value, as `extensions/flypic/src/ui-panel.js` does with its `esc` helper.
- The event name `my-plugin.items.changed` is an example. A backend handler emits events with `context.broadcast(event, payload)` (`src/gateway/server-methods/types.ts`).

## Calling gateway RPCs from the browser

Source: `ui/src/ui/gateway.ts` (`GatewayBrowserClient`).

`ctx.client` members a plugin page uses:

| Member | Behaviour |
|---|---|
| `request<T>(method, params?, { timeoutMs? })` | Returns a promise of the response payload. Rejects with `Error("gateway not connected")` when the socket is not open **or the handshake has not finished**. Rejects with the gateway's error when the handler responds `ok: false`. Default timeout 60 s. At most 12 requests are in flight at once; the rest queue. |
| `subscribe(handler)` | Receives every gateway event frame. Returns an unsubscribe function. |
| `connected` | Whether the socket is currently connected. |
| `supports(method)` | True when the gateway advertised the method, and also true while the method list is still unknown (before the handshake). Use it to hide a feature the gateway does not serve; do not treat it as proof of connection. |
| `url` | The gateway's `ws(s)://` URL. |

Rules:

- Call only your own declared methods (`<id>.*`). The caller's scopes are checked per method: `read` needs `operator.read` or `operator.write`, `write` needs `operator.write`, `admin` needs `operator.admin`. See [api-reference.md](api-reference.md#scopes).
- An RPC the owner switched off, or whose required permission is not granted, rejects with `<method> is turned off in Setup › Plugins › <name>`. Show that message; do not treat it as a crash.
- Do not open your own WebSocket and do not read credentials from `localStorage`. The client you are handed is already authenticated.
- For HTTP routes behind the gate, a same-origin `fetch` from the page relies on the control UI's session cookie; on a hosted install the UI is on another origin and that does not hold. Prefer RPC for data.
- Poll sparingly. If you poll, stop in your cleanup function (FlyPic clears its 5 s interval there).

## Theming with InfiniBot design tokens

Source: `src/plugins/appearance.ts`, `src/plugin-sdk/appearance-client.ts`, `ui/src/ui/plugin-host.ts` (`buildPluginAppearanceCss`, `applyPluginAppearances`).

### How it works

Every plugin surface is rendered inside a scope container `[data-plugin-scope="<id>"]`. The control UI writes the plugin's resolved appearance onto that container as CSS custom properties, once for the dark theme and once under `:root[data-theme="light"]`. They cascade into your page and nowhere else: not into core UI and not into other plugins.

Style with variables and your page follows the owner's theme, accent and density with no JavaScript.

### Variables you can use

Scope variables (set per plugin):

| Variable | Meaning |
|---|---|
| `--plugin-accent` | The plugin's accent colour |
| `--plugin-tint`, `--plugin-surface` | Surface tint and tinted surface |
| `--plugin-space` | Base spacing for the chosen density |
| `--plugin-density-scale` | Below 1 means compact |
| `--plugin-font-scale` | Owner's font scale for this plugin (0.85 to 1.3) |
| `--plugin-<id>-accent`, `-tint`, `-density`, `-font-scale`, `-layout-<option>` | Namespaced copies and declared layout options |
| `--plugin-<id>-*` | Your own declared variables |

Core tokens (the control UI's own, mirrored in `APPEARANCE_TOKENS`):

| Token name | CSS variable | Dark | Light |
|---|---|---|---|
| `primary` | `--g-primary` | `#fbbf24` | `#fbbf24` |
| `accent` | `--g-accent` | `#a855f7` | `#a855f7` |
| `info` | `--g-info` | `#38bdf8` | `#0891b2` |
| `success` | `--g-success` | `#22c55e` | `#16a34a` |
| `warning` | `--g-warning` | `#f59e0b` | `#d97706` |
| `danger` | `--g-danger` | `#ef4444` | `#dc2626` |
| `neutral` | `--g-neutral` | `#94a3b8` | `#64748b` |
| `text` | `--g-fg` | `#f5f5f4` | `#18181b` |
| `muted` | `--muted` | `#a1a1aa` | `#71717a` |
| `surface` | `--card` | `#0f0f0f` | `#ffffff` |
| `bg` | `--g-bg` | `#0a0a0e` | `#f4f4f5` |

`--g-line` (hairline borders) is also used throughout first-party pages.

Rules of thumb:

- Always give a fallback: `var(--plugin-accent, var(--g-primary, #fbbf24))`. The module may be mounted before appearance is applied.
- Do not hard-code a dark background or white text. The light theme exists and owners use it. Check both.
- Do not hard-code status colours either; use `--g-success`, `--g-danger`, `--g-warning`, which have different light-theme values chosen for contrast.
- Scale type and spacing from `--plugin-font-scale` and `--plugin-space` so the owner's density and font settings apply.

### Declaring appearance in the manifest

```json
"appearance": {
  "accent": "token:accent",
  "tint": "none",
  "tintStrength": 0.06,
  "density": "comfortable",
  "fontScale": 1,
  "icon": "palette",
  "monogram": "FP"
}
```

(`extensions/flypic/infinibot.plugin.json`.)

- Defaults are `accent: "token:primary"`, `tint: "none"`, `tintStrength: 0.06`, `density: "comfortable"`, `fontScale: 1`.
- Defaults should reference tokens (`token:<name>` from the table above) so an untouched plugin looks native.
- `layout` declares select/toggle options surfaced to the owner; `variables` declares your own CSS variables, which must be named `--plugin-<id>-*` and may carry a contrast `role` (`text` needs 4.5:1, `ui` 3:1, `decorative` is unchecked).
- `monogram` is used for the sidebar section (at most three characters are shown). Without one the host derives two letters from the plugin name.
- Owner overrides live in `plugins.entries.<id>.appearance`. Every colour an override introduces is checked against WCAG AA in **both** themes and auto-adjusted when it fails. Changes apply live.

### Reading appearance in JavaScript

Needed only when CSS variables are not enough, for example drawing on a canvas.

```js
function accentOf(el) {
  const cs = getComputedStyle(el);
  return cs.getPropertyValue("--plugin-accent").trim() || cs.getPropertyValue("--g-primary").trim();
}

// Follow owner changes and theme flips.
function onAppearanceChange(cb) {
  window.addEventListener("infinibot-plugin-appearance", cb);
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => {
    window.removeEventListener("infinibot-plugin-appearance", cb);
    mo.disconnect();
  };
}
```

This is what `readPluginAppearance` and `onPluginAppearanceChange` in `src/plugin-sdk/appearance-client.ts` do. Those helpers are exported from `infinibot/plugin-sdk`, but that import path only resolves inside the gateway's plugin loader. A no-build browser module cannot import it, so inline the few lines as above (the helper file is pure DOM with no imports, so a bundled plugin UI can also copy it whole). The current theme is `document.documentElement.dataset.theme` (`"light"`, otherwise dark).

## Accessibility basics

These are requirements for a page that sits inside someone else's app. The first-party FlyPic panel and the example above follow them.

- **Use real controls.** `<button type="button">` for actions, `<a href>` for navigation, `<input>`/`<select>` with a visible `<label>` or an `aria-label` (FlyPic labels every field, for example `aria-label="FlyPic API key"`). A clickable `<div>` is not keyboard reachable.
- **Keep focus visible.** Do not remove outlines without replacing them; style `:focus-visible` with the accent colour.
- **Announce async state.** Put loading, result and error text in an element with `role="status"` and `aria-live="polite"`. Use `role="alert"` for failures the user must act on (the host's own load-failure card does this).
- **Do not rely on colour alone.** Pair a status colour with text ("failed", "running").
- **Contrast in both themes.** Text needs 4.5:1, large text and UI components 3:1. The host checks appearance overrides against these numbers, not your hard-coded colours, so use tokens.
- **Respect reduced motion.** Wrap animation in `@media (prefers-reduced-motion: no-preference)` and make the rest state complete without it. See the pitfall below: the control UI also strips animation in low-power mode.
- **Touch targets.** Aim for at least 44 px on narrow screens (FlyPic sets `min-height: 44px` on its buttons under 720 px).
- **Headings and landmarks.** Start at `<h2>`; the host page already owns the top-level heading. Use lists for lists and tables for tabular data.
- **Images and media.** Give every `<img>` an `alt`. FlyPic uses the generation prompt.
- **Escape everything you render.** Data from RPC is untrusted input to your DOM. Use `textContent` or escape before `innerHTML`.
- **Narrow layouts.** The page is also shown on phones. Use flexible grids and test at 390 px wide.

## Pitfalls we already hit

Each of these cost a first-party plugin a bug. The evidence is listed so you can read the original fix.

### Plugin UI compiled with the Node tsconfig (Lit properties never update)

Symptom: the page renders once, then navigation or property changes do nothing until a full refresh.

Cause: the plugin's UI was compiled with the plugin's Node `tsconfig.json`. With `target: ES2022` TypeScript defaults `useDefineForClassFields` to true, so class-field initialisers are emitted as real fields that shadow the reactive accessors Lit's decorators install on the prototype. Assignments then write to a plain field and never trigger a render.

Fix: compile plugin UI with the control UI's settings. `ui/tsconfig.json` sets:

```json
"experimentalDecorators": true,
"useDefineForClassFields": false
```

Bundlers pick the **nearest** `tsconfig.json` per file, so put one in the UI folder. This is what Solatrix does (`extensions/solatrix/ui/tsconfig.json` extends `extensions/solatrix/tsconfig.ui.json`), with a guard test (`extensions/solatrix/test/ui-build-config.test.ts`).

Evidence: commit `d0a41774` "fix(solatrix): ... nav stuck until refresh"; the comment in `extensions/solatrix/ui/tsconfig.json`.

This only affects UI written in TypeScript with Lit decorators. A plain-JavaScript custom element like the example above has no compile step and no decorators.

### Method names that clash with built-in HTMLElement members

Symptom: a click handler deletes the element, or a property silently has browser behaviour.

Cause: a custom element class is an `HTMLElement`. Naming a method `remove` overrides `Element.remove`; naming a property `title` collides with `HTMLElement.title`. TypeScript does not always complain.

Fix: avoid built-in member names for your own methods and properties. Names that have bitten or are easy to hit: `remove`, `title`, `hidden`, `focus`, `blur`, `click`, `closest`, `append`, `prepend`, `replaceWith`, `scroll`, `animate`, `id`, `slot`, `dir`, `lang`, `translate`, `draggable`, `dataset`, `style`, `role`. Prefer verb-noun names (`trashNode`, `reload`, `nodeTitle`).

Evidence: commit `c9de71a0` "fix(ui): documents workspace method name clashed with Element.remove" (renamed `remove` to `trashNode`); commit `7e719d66` "... avoid HTMLElement.title clash (nodeTitle)".

### The control UI zooms the body to 0.7

Symptom: a dragged element drifts away from the pointer, or a popover positioned from `getBoundingClientRect` lands at 70% of where it should.

Cause: between 1101 px and 1680 px viewport width the control UI applies `body { zoom: var(--ui-viewport-zoom, 0.7) }` (`ui/src/styles/viewport-scale.css`). `getBoundingClientRect` and pointer event coordinates are in unzoomed viewport pixels, but `left`/`top`/`width` on an element inside `body` are in zoomed CSS pixels. Viewport units (`100vh`) are not affected by zoom either, so a `100vh` box renders at 70% of the window.

Fix: read the zoom and divide it out wherever you convert viewport coordinates into CSS lengths.

```js
function bodyZoom() {
  const z = parseFloat(getComputedStyle(document.body).zoom || "1");
  return Number.isFinite(z) && z > 0 ? z : 1;
}

// Position a body-level popover under an anchor.
const rect = anchor.getBoundingClientRect();
const z = bodyZoom();
popover.style.left = `${rect.left / z}px`;
popover.style.top = `${rect.bottom / z}px`;
```

Do not assume 0.7: the value is overridable per install through `--ui-viewport-zoom`, and it is 1 outside that width band. Size full-height containers from the parent (`height: 100%`) instead of `100vh`. Test at a 1440 px wide window and at one above 1680 px.

Evidence: `ui/src/styles/viewport-scale.css`; commits `ecf6bd94` "fix(ui): rail flyouts account for body zoom", `c8c850c4` "fix(chat): dock drag tracks the pointer under the desktop body zoom", `3667d685` "fix(ui): theme background layer fills the viewport under the 0.7 body zoom"; `bodyZoom()` in `ui/src/ui/controllers/nav-plugin-flyout.ts`.

### An entrance animation as the only thing making content visible

Symptom: on some machines the page is blank, or covered by an overlay that never leaves.

Cause: content starts at `opacity: 0` (or behind a closed overlay) and only an animation reveals it. The control UI has a low-power mode (`<html class="low-power">`, set for devices with few cores, little memory, or reduced motion) whose stylesheet sets `animation: none !important; transition: none !important` on everything (`ui/src/styles/low-power.css`). The animation never runs, so the element stays in its starting state for good.

Fix: the rest state, with no animation and no transition, must be the finished, visible state. Animate **from** a hidden keyframe, never rely on arriving **at** the visible one:

```css
/* Wrong: invisible unless the animation runs. */
.panel { opacity: 0; animation: fade-in 200ms forwards; }

/* Right: visible at rest; the animation only decorates. */
.panel { opacity: 1; }
@media (prefers-reduced-motion: no-preference) {
  .panel { animation: fade-in 200ms; }
  @keyframes fade-in { from { opacity: 0; } }
}
```

Test with reduced motion switched on in the OS.

Evidence: commit `34dbb7a8` "fix(cloud-onboarding): hosted setup console is no longer covered in low-power mode" (blast doors rested closed; boot log lines rested at opacity 0); commit `8785ff4b` "docs(saas): low-power rest-state rule for setup surfaces".

### Unbound requestUpdate callbacks

Symptom: `TypeError: Cannot read properties of undefined (reading 'isUpdatePending')` and the control does nothing.

Cause: `requestUpdate` is a Lit prototype method. Passing it as a bare reference (`onChange: this.requestUpdate`, `window.addEventListener("x", host.requestUpdate)`, or reading it off a state object) loses `this`.

Fix: wrap or bind it.

```ts
window.addEventListener("infinibot-plugin-host", () => this.requestUpdate());
```

The same applies to any method you hand out as a callback from a plain custom element; the example above binds `reload` in the constructor.

Evidence: commit `284d5fdb` "fix(ui): bind requestUpdate for the sidebar and Launchpad" (the Launchpad button threw "reading isUpdatePending" and never opened); commit `08f49c6d` "... binds requestUpdate (unbound call threw in Lit)"; commit `ecf6bd94` "... plugin-host redraw calls the app element".

### Cold load: assuming the gateway client is connected at first render

Symptom: opening the page's URL directly (or refreshing on it) shows "gateway not connected" or an empty state such as "No items yet", while navigating to it from another page works.

Cause, two parts:

1. A lazily loaded page can mount before the WebSocket handshake finishes. `client.request` rejects with `gateway not connected` both when the socket is closed and when it is open but `hello` has not been answered (`ui/src/ui/gateway.ts`).
2. For Lit elements defined by a lazy chunk, a property set on the element before the class was defined is only restored at the first update, which is **after** `connectedCallback`. Loading data in `connectedCallback` therefore sees `client === undefined`.

Fix:

- Do not load only in `connectedCallback`. In Lit, also load when the client property arrives (`updated(changed)` with `changed.has("client")`).
- Treat `gateway not connected` as "not yet": retry with a bound (the Robovoice page uses bounded retries) instead of rendering an error or an empty state.
- Never render "empty" until a request has actually succeeded with zero rows. Loading, failed and empty are three different states.

Entry modules are a little safer, because `<plugin-entry-page>` only calls your mount function once it has a client object. That client may still be mid-handshake, so the retry in the example is still needed.

Evidence: commit `00276aa7` "fix(content-studio): cold-load page list ..." ("Lit restores a pre-upgrade property only at first update, after connectedCallback — a cold visit to /content-pages showed 'No content pages yet'"); commit `b0111fc9` "fix(ui): Robovoice page + provider card wait for the gateway client" ("Direct loads of /robovoice mounted before the WS client existed and showed 'gateway not connected'"); the handshake guard in `ui/src/ui/gateway.ts`.

### More recommendations

These come from reading the host code rather than from a recorded bug.

- **Light DOM by default.** The host mounts your container in the light DOM. Unscoped selectors like `button { ... }` in an injected `<style>` restyle the whole control UI. Use a shadow root, or prefix every class (FlyPic prefixes with `.fp-`).
- **Module-level state survives navigation.** The browser caches the imported module for the page's lifetime. Timers, listeners and caches created at module level are never cleaned up.
- **Clean up everything in the returned function**: intervals, event listeners, `subscribe` handles, observers. The host calls it on navigation.
- **Plugin updates and browser caching.** The module URL does not change between plugin versions, so a browser may keep an old copy. If you need to force a refresh after an update, send a `Cache-Control` header from your route handler.
- **Hosted installs load the UI from another origin.** The host derives the module URL from the gateway WebSocket URL, so the module is fetched cross-origin there. Do not use relative URLs for anything inside the module.
