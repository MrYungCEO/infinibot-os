# notes-edit → Hyperframes Studio bridge

Generates a Hyperframes Studio project from a notes-edit workspace so the
local motion-graphics editor (`hyperframes/packages/studio`) can preview
and extend the cut.

## What it produces

A self-regenerable Hyperframes project at
`<HYPERFRAMES_DIR>/packages/studio/data/projects/notes-edit/`:

| File | Purpose |
|---|---|
| `index.html` | composition: root `<div id="root" data-composition-id="root" data-start="0" data-duration="<cut>" data-width="1920" data-height="1080" data-fps="30">` with one `<video muted id="scene-N-video">` (picture) and one `<audio id="scene-N-audio" data-volume="1">` (sound) per source clip; registers `window.__timelines["root"]` |
| `build.mjs` | the same generator copied alongside, so the project rebuilds itself with `node build.mjs` whenever an EDL changes |
| `<slug>-cut.mp4` | symlink to each clip's `cut.proxy.mp4` (lives in the notes-edit workspace) |
| `merged-audio.m4a` | AAC concat of every clip's audio (used by the studio's audio shim as an `audio-src` fallback when the iframe runtime drift-pauses video audio) |

Visuals + audio are intentionally split into separate elements — the
runtime's drift-correction was silencing `<video>` audio tracks during
playback; routing audio through dedicated `<audio>` elements bypasses
that path and matches the canonical `registry/examples/play-mode` pattern.

## Use

### From notes-edit jobs

```bash
bun src/compositions/notes-edit-hyperframes/install.ts \
  [--workspace <path>] \
  [--studio-projects-dir <path>] \
  [--project-id notes-edit] \
  [--rebuild-audio]
```

Defaults:
- `--workspace` → `$NOTES_EDIT_WORKSPACE` ?? `~/Infini/.notes-edit`
- `--studio-projects-dir` → `$HYPERFRAMES_DIR/packages/studio/data/projects` (`HYPERFRAMES_DIR` is required when this flag is omitted)
- `--project-id` → `notes-edit` (fixed URL: `http://localhost:5190/#projectId=notes-edit`)
- `--rebuild-audio` only re-concats audio if you've trimmed an EDL

### Programmatic

```ts
import { installHyperframesProject } from "./install.js";

const r = await installHyperframesProject();
// → { projectDir, projectId, studioUrl, sourceClipCount, cutDurationSec }
```

## Studio dev server

Hyperframes Studio runs under systemd:

```
systemctl --user status flypic-studio    # (mis-named service) — port 3000
# Hyperframes is launched manually:
cd /path/to/hyperframes
bun run dev                              # serves studio on port 5190
```

After running `install.ts`, open the URL it prints — the project shows up
in the studio's project picker as `notes-edit`.

## Lint compliance

Generated `index.html` satisfies Hyperframes lint:
- root composition has `data-start="0"` + `id="root"`
- every timed `<video>` / `<audio>` has a stable `id="scene-N-video|audio"`
- `window.__timelines["root"]` is registered with a paused GSAP timeline
