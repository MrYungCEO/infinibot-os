# World Audio + Cosmetics Theming — mount guide

Two self-contained, additive layers for the Agency World map. Neither touches
`agency-world-viz.ts`, the iso engine, sprites, or other `world-*` components.

## Files

| File | What |
|------|------|
| `src/audio/world-sounds.ts` | Vanilla-WebAudio synth engine (no deps, no asset files). Singleton via `getWorldSounds()`. |
| `ui/src/ui/components/world-audio.ts` | `<world-audio>` — bottom-right audio puck + volume/category panel. |
| `src/cosmetics/themes.ts` | Theme registry (4 starter themes) → `--world-*` token maps. |
| `src/cosmetics/index.ts` | `applyTheme()` / `initCosmetics()` / generated `:root[data-world-theme=…]` stylesheet. |
| `ui/src/ui/components/cosmetics-picker.ts` | `<cosmetics-picker>` — palette puck + modal swatch grid. |

## Mount (in `agency-world-viz.ts`, inside the `.host` div)

```ts
import { initCosmetics } from "../../../../src/cosmetics/index.js";
import "./components/world-audio.js";
import "./components/cosmetics-picker.js";

initCosmetics();                                       // once, at boot — applies persisted/default theme
host.appendChild(document.createElement("world-audio"));
host.appendChild(document.createElement("cosmetics-picker"));
```

## Feed audio from the event bus (in `applyBatch(events)`)

The audio layer mirrors the `<agent-fx-layer>` contract — forward each
`WorldEvent` as a window event (one line, no coupling):

```ts
for (const e of events) {
  window.dispatchEvent(new CustomEvent("infinibot:world-event", { detail: e }));
}
```

`WorldEvent.kind` → sound mapping (unknown kinds ignored):
`agent.complete`→complete (or **error** when `success===false`) · `agent.spawn`→spawn ·
`fed.msg.send`/`fed.peer.connect`/`ssh.connection.opened`→beam ·
`fed.msg.fail`/`ssh.connection.error`→error · `achievement`→achievement.

Alternatives: `window.__worldAudio?.trigger("agent.spawn")` or `el.trigger(kind, success)`.

## Theming

`applyTheme("midnight")` sets `data-world-theme` on `<html>`, persists to
`localStorage["infinibot-world-theme"]`, and cascades the theme's `--world-*`
tokens. Any world layer reads them: `var(--world-bg | --world-surface |
--world-text | --world-accent | --world-accent-strong | --world-grid |
--world-beam | --world-status-{running,idle,error,complete})`.

Add a theme by appending to `COSMETIC_THEMES` — the stylesheet is generated from
the registry, so tokens and CSS never drift. Open the picker programmatically
with `document.querySelector("cosmetics-picker").open()`.

## Notes

- **Autoplay policy**: muted until the first user gesture on the audio puck
  (`unlock()` resumes the `AudioContext`). Mute + volume + per-category toggles
  persist in `localStorage["infinibot-world-audio"]`.
- **No asset files** ship — all sounds are synthesised. To swap in CC0 samples,
  drop files at the paths in `WORLD_SOUND_ASSETS` and call `sounds.loadAssets()`.

## Verify

`ui/world-cosmetics-test.html` + `ui/__world-cosmetics-test.ts` is a standalone
harness. `npx vite` then load `/world-cosmetics-test.html`; `window.__testCycleTheme(id)`
and `window.__testFire(kind, success)` drive it. Captured screenshots:
`/tmp/cosmetics-{black-gold,midnight,emerald,crimson}.png`, `/tmp/cosmetics-modal.png`,
`/tmp/world-audio-panel.png`.
