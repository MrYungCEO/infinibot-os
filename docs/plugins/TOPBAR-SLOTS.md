# Plugin topbar slots (`contributes.topbarSlots`)

A manifest-v2 plugin can put a control in the app topbar. The first user is
the Business & Agency plugin's **agency selector**, which used to be a
hard-coded core topbar element (`renderAgencySwitcher` in `app-render.ts`).

```jsonc
"contributes": {
  "topbarSlots": [
    {
      "id": "agency-selector",          // a-z0-9-, key "topbarSlot:<id>"
      "label": "Agency selector",       // Setup › Plugins, overflow menus
      "description": "Pick the active agency…",
      "builtin": "agency-selector",     // first-party renderer key
      "order": 10                       // default 100; lower = further left
    }
  ]
}
```

| Part | Where |
|---|---|
| Parse / validate (fails closed) | `src/plugins/manifest-v2.ts` `parseTopbarSlots` |
| Setup › Plugins contribution row, live toggle `topbarSlot:<id>` | `src/plugins/contributions.ts` |
| Derived list (loaded plugins only, minus switched-off slots) | `ui/src/ui/plugin-host.ts` `derivePluginTopbarSlots` / `pluginTopbarSlots()` |
| Renderers (`builtin` → Lit template) | `ui/src/ui/components/topbar-slots.ts` `TOPBAR_SLOT_RENDERERS` |
| Mount point | `app-render.ts`, where `renderAgencySwitcher(state)` used to be: `${renderTopbarSlots(state)}` |

## Rules

- `builtin` only selects a renderer compiled into the control UI. An unknown
  key renders nothing, so a manifest can never inject markup. Marketplace
  (entry-module) topbar controls are future work.
- Each slot is wrapped in
  `<span class="topbar-slot" data-topbar-slot="<plugin>:<id>" data-plugin-scope="<plugin>" style="display:contents">`.
  The control lays out exactly like a direct topbar child, and the plugin's
  appearance variables still reach it.
- Disabling the plugin, or switching the slot off in Setup › Plugins,
  removes it on the next `plugins.list` sync (the `infinibot-plugin-host`
  event redraws the shell).

## Merging with `feat/control-bar-clock`

That branch wraps the old call in its own priority-layout item:
`<span class="cb-slot" data-cb-item="agency">${renderAgencySwitcher(state)}</span>`.
Resolve the conflict by keeping both intents:

```ts
<span class="cb-slot" data-cb-item="agency">${renderTopbarSlots(state)}</span>
```

The control bar can also key items off `data-topbar-slot`, so every plugin
slot gets its own overflow priority. Its `clockSections` manifest field is
parsed next to `topbarSlots` in `manifest-v2.ts` / `contributions.ts` /
`plugin-host.ts`. Keep both blocks; they are independent.
