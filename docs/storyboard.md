---
title: Storyboard Studio
description: End-to-end automation for short-form and long-form video — script generation, scene splitting, image generation, voiceover, and effects rendering.
read_when:
  - You are running InfiniBot's `/storyboard` page for the first time
  - You need to know which API keys and helper scripts the pipeline expects
  - You are debugging a stuck project, missing image backend, or failed export
  - You are wiring up a new image-generation backend or TTS provider
---

# Storyboard Studio

Storyboard Studio turns a short prompt into a finished video: it writes the
script with an LLM, splits it into scenes, generates an image per scene,
voices it over with TTS, applies a Remotion-rendered motion effect per scene,
and exports the whole thing through ffmpeg.

The page lives at `/storyboard` in the desktop UI. The same pipeline is
exposed over the gateway as `storyboard.*` methods, so cron jobs and
external scripts can drive it headlessly.

## Pipeline at a glance

```
prompt → script (Gemini/Claude) → scenes (LLM split) →
   images (local ComfyUI server) →
   voiceover (Kokoro / Edge / ElevenLabs) →
   per-scene effect render (Remotion) →
   stitched export (ffmpeg)
```

Image generation runs entirely through your own ComfyUI instance — no
cloud image APIs, no per-image credits. The only required external call
is the script LLM (Gemini or Claude), and even that runs through your
own API key. ElevenLabs is supported as an opt-in cloud voice; default
TTS is local (Edge or Kokoro).

Each stage is independently runnable from the UI ("Step 1 / 2 / 3" buttons)
or from the gateway (`storyboard.generateScript`, `storyboard.splitScenes`,
`storyboard.generateImages`, `storyboard.generateAllVoiceovers`,
`storyboard.exportVideo`). State lives under
`<INFINIBOT_STATE_DIR>/storyboard/` with one JSON file per project.

## Prerequisites

Storyboard runs out of the box once at least **one script-generation key**
and **one image-generation backend** are configured. Everything else is
optional and degrades gracefully.

### Required: a script LLM

Storyboard tries providers in the same order the gateway prefers — set
at least one of:

| Env var | Provider | Order | Notes |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Claude Sonnet | **1st** | Matches the gateway's default; override the model with `ANTHROPIC_SCRIPT_MODEL`. |
| `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) | Gemini 2.0 Flash | 2nd | Free tier rate-limits aggressively — falls through automatically on 429. |
| `OPENROUTER_API_KEY` | OpenRouter (Llama 3.1 70B by default) | 3rd | Last-resort fallback. Override with `OPENROUTER_SCRIPT_MODEL`. |

The script generator auto-falls through on rate-limit (429) or 5xx
errors, so a single exhausted free-tier doesn't block the workflow when
you've configured a second provider. Without any keys,
`storyboard.generateScript` returns
`"No LLM provider configured. Set ANTHROPIC_API_KEY (preferred), GEMINI_API_KEY, or OPENROUTER_API_KEY."`.

### Required: ComfyUI

Storyboard talks to a stock ComfyUI install over its native HTTP API
— no custom wrapper required.

| Endpoint | Purpose |
|---|---|
| `GET /system_stats` | Liveness probe. |
| `GET /object_info/CheckpointLoaderSimple` | Discover available checkpoints. |
| `POST /prompt` | Submit a txt2img workflow. |
| `GET /history/{prompt_id}` | Poll for completion. |
| `GET /view?filename=...&type=output&subfolder=...` | Fetch the rendered PNG. |

**Default URL is `http://127.0.0.1:8000`.** Override one of two ways:

- **Gateway** (server-side `generate()` calls): set `COMFY_URL` (or
  legacy `LOCAL_IMAGE_API_URL`) in the gateway env.
- **UI** (model picker fetches from the browser): set
  `localStorage.comfyuiUrl = "http://your-host:port"` in the dashboard
  origin's DevTools console, then reload.

The page's empty state shows a warning card when ComfyUI isn't reachable.

> **Removed:** The previous build also exposed Nano Banana (Gemini),
> Replicate, and Flypic cloud-image backends, plus a credit-cost
> estimator. Those were merged in from a different repo by accident and
> have been ripped out. Image generation is on-device only; no credits,
> no per-image billing display, no cloud API keys required for images.

### Optional: voiceover

| Provider | Env / setup | Notes |
|---|---|---|
| **Kokoro** (local) | `KOKORO_API_URL` (default `http://localhost:8882`) | Free, runs offline. Recommended default. |
| **Edge TTS** | None | Free, uses Microsoft Edge's neural voices over HTTP — no key. |
| **Local TTS** | Whatever the local image API server advertises under voice models | For users running a self-hosted TTS endpoint alongside ComfyUI. |
| **ElevenLabs** (opt-in cloud) | `ELEVENLABS_API_KEY` (or `XI_API_KEY`) | Best quality, paid. Voice cloning supported via `storyboard.cloneVoice`. Disabled until the key is set. |

### Optional: motion effects (Remotion)

Per-scene motion presets (Ken Burns, Punch Zoom, Atmospheric Mist, etc.)
are rendered through a sibling Remotion project. Point at it with
`REMOTION_PRESETS_DIR`; default is
`~/.infinibot/skills/remotion-presets`. If Remotion is not available,
the export falls back to ffmpeg-only Ken Burns.

### Optional: characters

Reference images for character consistency live in
`<INFINIBOT_STATE_DIR>/characters` (override with
`INFINIBOT_CHARACTERS_DIR`). The Character Manager page writes here; the
storyboard pipeline reads `metadata.json` per character to enrich prompts
and supply reference images to backends that support them.

## Configuration variables

| Variable | Default | Purpose |
|---|---|---|
| `INFINIBOT_STATE_DIR` | `state` | Root for projects, generated images, character library. |
| `INFINIBOT_CHARACTERS_DIR` | `<state>/characters` (else `~/.infinibot/characters`) | Character Manager store the pipeline reads from. |
| `INFINIBOT_STORYBOARD_OUTPUT_DIR` | `<state>/storyboard-generated` | Where image generators drop PNG files. |
| `INFINIBOT_STORYBOARD_HELPER_CWD` | `INFINIBOT_STORYBOARD_OUTPUT_DIR` | `cwd` for spawned image-gen helper scripts. |
| `COMFY_URL` (or legacy `LOCAL_IMAGE_API_URL`) | `http://127.0.0.1:8000` | Stock ComfyUI server URL. The browser-side picker uses `localStorage.comfyuiUrl` instead. |
| `REMOTION_PRESETS_DIR` | `~/.infinibot/skills/remotion-presets` | Remotion preset package for motion/overlay rendering. |
| `KOKORO_API_URL` | `http://localhost:8882` | Local Kokoro TTS endpoint. |
| `ANTHROPIC_API_KEY` | — | Primary script LLM (matches gateway default). |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | — | Fallback script LLM. |
| `OPENROUTER_API_KEY` | — | Last-resort script LLM fallback. |
| `ANTHROPIC_SCRIPT_MODEL` | `claude-sonnet-4-6` | Override the Anthropic script model. |
| `OPENROUTER_SCRIPT_MODEL` | `meta-llama/llama-3.1-70b-instruct` | Override the OpenRouter script model. |
| `ELEVENLABS_API_KEY` | — | Optional ElevenLabs TTS + voice cloning. |

## Workflow from the UI

1. **Create a project.** Header → New Project. Pick platform (YouTube /
   TikTok / Shorts / Reels / Custom), target duration, image style,
   ComfyUI model, language, and TTS provider. Aspect ratio defaults from
   the platform.
2. **Step 1 — Generate Script.** Calls `storyboard.generateScript`. The
   generated script is editable in the **Script** tab.
3. **Step 2 — Split into Scenes.** Calls `storyboard.splitScenes`. Output
   shows up in the **Scenes** tab as a grid; each card has its own
   regenerate / edit / preview controls.
4. **Step 3 — Generate Images.** Runs the picked backend over every
   pending scene. Per-scene retries (`storyboard.regenerateSceneImage`)
   and prompt edits are available from the scene editor modal.
5. **Generate Voiceovers.** Optional — adds a voice track per scene.
6. **Export Video.** Stitches scenes with per-scene effect presets
   through Remotion (when available) and merges audio with ffmpeg.

The **Effect Preset Builder** (Presets button in the header) lets you
build custom motion/overlay presets and save them for reuse across
scenes.

## Headless / cron usage

The `cron.add` API can schedule any storyboard method. Common pattern:

```jsonc
// Daily auto-generated short
{
  "method": "storyboard.runSurvivalWorkflow",
  "params": {
    "topic": "Today in survival history",
    "durationMinutes": 1,
    "stylePreset": "cinematic"
  },
  "schedule": "0 7 * * *"
}
```

For full flexibility, store a project id and chain
`storyboard.generateScript` → `storyboard.splitScenes` →
`storyboard.generateImages` → `storyboard.exportVideo`.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| "ComfyUI not reachable" warning on the empty state | ComfyUI isn't running, or its URL doesn't match the gateway/browser default | Confirm `http://127.0.0.1:8000/system_stats` returns 200. If your server binds elsewhere, set `COMFY_URL` (gateway) and `localStorage.comfyuiUrl` (browser). |
| Backend selected but no models listed | ComfyUI has no checkpoints loaded, or `/object_info/CheckpointLoaderSimple` returns empty | Drop a `.safetensors`/`.ckpt` into your ComfyUI checkpoints folder and restart the server. |
| `unknown method: storyboard.*` over the gateway | The method isn't in `READ_METHODS` / `WRITE_METHODS` in `src/gateway/server-methods.ts` | Add the method to the appropriate scope set and restart the gateway. |
| Remotion effects not rendering, only ffmpeg Ken Burns | `REMOTION_PRESETS_DIR` missing or Remotion CLI not installed | Set `REMOTION_PRESETS_DIR` and `npm install` inside that package. |
| Voiceovers silent | TTS provider unreachable | For Kokoro, verify `KOKORO_API_URL` returns 200 on `/healthz`. For ElevenLabs, confirm the key is set. |
| Project stuck in `generating` after a crash | Pipeline aborted mid-run; status didn't roll back | Open the project, hit "Step 3" again — the pipeline only re-renders scenes whose `imageStatus` is `pending` or `failed`. |

## Gateway method reference

All methods live under the `storyboard.*` namespace. Read methods
(`storyboard.list`, `.get`, `.backends`, `.voices`, `.stylePresets`,
`.remotionStatus`, `.listEffectPresets`) require the `operator.read`
scope; mutating methods require `operator.write`.

| Method | Effect |
|---|---|
| `storyboard.list` / `.get` | Project listing & detail. |
| `storyboard.create` / `.update` / `.delete` | CRUD for projects. |
| `storyboard.run` | Run all stages end-to-end. |
| `storyboard.generateScript` / `.regenerateScript` | Stage 1. |
| `storyboard.splitScenes` / `.regenerateScenes` | Stage 2. |
| `storyboard.generateImages` / `.regenerateSceneImage` | Stage 3. |
| `storyboard.generateVoiceover` / `.generateAllVoiceovers` | TTS. |
| `storyboard.cloneVoice` / `.deleteVoice` / `.voices` | ElevenLabs cloned voices. |
| `storyboard.updateScene` / `.addCharacter` / `.updateCharacter` / `.deleteCharacter` | Editor mutations. |
| `storyboard.backends` | List image generators currently reporting `isAvailable()`. |
| `storyboard.exportVideo` / `.generateClip` / `.renderSceneWithEffect` | Render & export. |
| `storyboard.listEffectPresets` / `.saveEffectPreset` / `.deleteEffectPreset` / `.renderPresetPreview` | Custom Remotion preset CRUD. |
| `storyboard.runSurvivalWorkflow` / `.generateSurvivalScript` / `.analyzeStyle` / `.stylePresets` | Pre-baked survival-content workflow. |
| `storyboard.generatePromptSuggestions` | Ask Claude for unexpected scene-image prompts. |

See `src/gateway/server-methods/storyboard.ts` for the full handler list
and parameter shapes.
