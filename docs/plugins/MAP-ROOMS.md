---
summary: "Plugin rooms on the isometric agent mesh map (contributes.mapRoom)"
read_when:
  - You are building a plugin and want its own room on the agent mesh map
  - You are changing how agents are routed to sectors on the Galactic HQ map
  - You are debugging why a plugin's room is missing or agents don't walk to it
---
# Plugin rooms on the agent mesh map

Every enabled manifest-v2 plugin that contributes a page gets its own **room**
on the isometric agent mesh map (`<agency-world-viz>`, the Galactic HQ). Rooms
live in the **Plugin District**: a ring of iso blocks around the 24×24 core
station, joined to the Gateway Concourse by a transit loop of light conduits.
While an agent works *in* a plugin — calls one of its tools or RPCs, works on
one of its pages, runs a task tagged with it, or is one of its roster agents —
the agent walks to that plugin's room, sits at a workstation and works there.

## Manifest: `contributes.mapRoom`

```jsonc
"contributes": {
  "pages": [{ "tab": "infinitrade", "route": "/infinitrade", "builtin": "infinitrade" }],
  "mapRoom": {
    "title": "Infinitrade Floor",   // sign text, ≤ 24 chars (default: plugin name)
    "theme": "trading-floor",       // prop set — see themes below (default: "generic")
    "size": "L",                    // S 6×6 · M 8×8 · L 10×10 tiles (default: "M")
    "placement": "south",           // auto | north | east | south | west (default: "auto")
    "accent": "token:primary",      // optional: token:<name> or #rrggbb (default: the theme's accent)
    "props": ["tickerBoard", "consoleWide", "desk"]   // optional: explicit prop list (≤ 12)
  }
}
```

- **Default:** a plugin with pages and no `mapRoom` block gets a `generic` M
  room titled after the plugin. `"mapRoom": false` opts out. Page-less plugins
  get a room only when they declare one.
- **Validation** is fail-closed like the rest of manifest v2: unknown themes,
  sizes, placements, props, non-token/non-hex accents and titles over 24
  characters reject the manifest (`src/plugins/manifest-v2.ts` `parseMapRoom`).
- **Owner switch:** the room is a live, toggleable contribution
  (`mapRoom:<pluginId>` in Setup › Plugins). Switching it off dissolves the
  room on the next `plugins.list` sync without disabling the plugin.
- `plugins.list` now also returns `rosterAgentIds` per plugin (the ids in its
  `contributes.agents` files) so the map can tell which plugin a roster agent
  belongs to.

### Themes

| theme | reads as | first-party |
| --- | --- | --- |
| `generic` | console + desk + holo table | (default) |
| `fleet` | server racks, big display, robo arm | InfiniCode |
| `voice-studio` | waveform wall, mic booths, mixing console | Robovoice |
| `clinic` | lab benches, scanner arch, patient beds | OmniClinic |
| `media-studio` | camera rig, softboxes, big display | FlyPic |
| `trading-floor` | ticker board with candles, console rows | Infinitrade |
| `terminal-vault` | coin pillar, safes, ingots, consoles | Solatrix |
| `dojo` | tatami mat, bonsai, benches | Discipline |
| `content-lab` | storyboard wall, desks, easel | Content Studio |
| `showroom` | shelf racks, display plinths | Products |
| `drawing-studio` | standing whiteboard, easels | Whiteboard |
| `holo-gallery` | floating holo frames, plinths | HoloCanvas |
| `boardroom` | long glass table, big display | Business & Agency |

Each theme has its own accent (distinct from every core district accent) used
for the room's floor tint, inner trim, monogram sign, conduit stub and in-room
FX. Props are baked iso textures from the shared bakery
(`ui/src/ui/views/agent-ops/iso/galactic-assets.ts`), so they share the
per-renderer bake cache and re-bake after a GL context restore like the core
furniture. No third-party logos: the sign shows the plugin's `appearance.monogram`.

## Layout: the Plugin District

`ui/src/ui/views/agent-ops/iso/plugin-rooms.ts` (pure, unit-tested):

- Ring 1 sits 3 tiles outside the core; slots are 8×8 on an 11-tile pitch.
  Each side of the ring owns one corner (north → top vertex, east → right,
  south → bottom, west → left) plus its interior, centred on the core; the
  north row flanks the Executive Suite pad symmetrically instead of leaving a
  dead slot. Ring 1 = 12 slots (3 per side); ring 2 adds 20, and so on.
- Placement is **deterministic** (same plugins → same layout, independent of
  list order) and **sticky** (rooms keep their slot when other plugins come and
  go). Preferred sides are filled first; a full side spills into the nearest
  free slot. L rooms overflow their slot by one tile but never overlap
  anything (tests cover 1…40 rooms of mixed sizes).
- Fill order is "nearest the Gateway Concourse first", so the first plugins
  land beside the fleet's front door.
- Conduits: one dashed loop per ring, an accent stub from each room's door to
  its loop, spokes between loops, and a trunk from loop 1 through a gate arch
  into the Gateway Concourse.
- Click a room → the plugin's main page (first nav entry, else first page).
  Hover → tooltip with the agents working there.

## Agent behaviour

`ui/src/ui/views/agent-ops/iso/plugin-activity.ts` builds **one resolver** from
`plugins.list` (declared `tools`, `rpc` methods + `aliases`, `rpcAliases`,
page `routes`, `rosterAgentIds`). `resolve()` returns the plugin an agent is
working in, in this order:

1. explicit `pluginId` on the run/task (`plugin`, `pluginId`, or a
   `plugin:<id>` tag in `session.progress` / spawn payloads),
2. the latest tool name (`solana_market`), an RPC method / alias / `<id>.`
   namespace in the tool label (`gateway: infinitrade.orders.list`),
3. a page route in the task text (`/solatrix/wallets`), `#<id>` /
   `plugin:<id>` / `[<id>]` tags,
4. a whole-word mention of the plugin name/id in the task text,
5. the agent's roster id (declared, `<id>`, or `<id>-…`).

Null falls back to the existing core sectors (`agent-spread.ts` domains /
`sectorForToolKind`). The spread planner treats rooms as dynamic work
sectors: agents whose activity resolves to a plugin sit at that room's desks
(`computeWorkSlots` over the room's props), unclassified agents never overflow
into plugin rooms, and a dissolved room re-plans its occupants. With spread
off, the legacy 5-second tool trip walks to the room instead of a core sector.

In-room FX (`plugin-district.ts` `frame()`): typing sparks beside seated
agents, a dashed conversation link with speech pips between two agents sharing
a room, and a carried crate above an agent walking straight from one plugin
room to another (cross-plugin work).

## Verifying

- Unit: `pnpm -C ui test` (plugin-rooms, plugin-activity, agent-spread) and
  `npx vitest run --config vitest.unit.config.ts src/plugins/map-room.test.ts src/plugins/first-party-manifests.test.ts`.
- Visual: `node ui/src/dev/gen-plugin-rooms-fixture.mjs`, then
  `pnpm -C ui exec vite --port 5199` and open
  `/mesh-plugin-rooms-harness.html?plugins=all|none|<id,id>`; `window.__fake`
  spawns agents, fires tools, flips plugins/rooms; `window.__hudPerf.drawMs`
  is the per-frame cost.
