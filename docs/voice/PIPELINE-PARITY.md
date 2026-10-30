# Voice › Pipeline = Robovoice's location Pipeline page

The Pipeline tab on InfiniBot's Voice page (`<rv-pipeline-editor>`, `ui/src/ui/views/robovoice/pipeline-editor.ts` + `pipeline-styles.ts`) is a port, in function and in look, of Robovoice's own location Pipeline page:

- **Robovoice route:** `robovoice.io/l/<slug>/pipeline`.
- **Robovoice components:** `frontend/components/dashboard/tabs/pipeline-tab.tsx` (`PipelineTab` in location scope) and `CharacterPipeline` in `characters-tab.tsx`, Robovoice-Prod `ad6163b`.
- **Data:** everything the tab shows comes from the linked account through three RPCs:
  - `robovoice.pipeline.config.get`: Robovoice's `GET /api/edge/infinibot/pipeline`, the same body as the dashboard's `/api/location/<id>/settings-view`.
  - `robovoice.pipeline.config.set`: `PATCH` on the same route, with the same validation as `/api/location/<id>/config`.
  - `robovoice.pipeline.catalog.get`: `GET /api/edge/infinibot/catalog?stage=`.
- **No local defaults:** nothing is invented. A stage that no Robovoice layer sets shows as unset.
- **Look:** Robovoice's own, not InfiniBot's black/gold. `ui/src/ui/views/robovoice/pipeline-styles.ts` is a class-by-class translation of the Tailwind in `pipeline-tab.tsx`, `characters-tab.tsx`, `ui-kit.tsx`, `settings-scope.tsx`, `model-picker.tsx`, `tier-badge.tsx`, `scope-access-note.tsx` and `styles/globals.css`.
  - Robovoice's dark tokens are `--rv-*` custom properties on `:host`, so nothing leaks either way.
  - The tab paints Robovoice's page background (`#07060f` plus the indigo/violet aurora) inside its own rounded panel.
  - Fonts: Plus Jakarta Sans for UI text, loaded once from Google Fonts by the component (a shadow root can't declare `@font-face`), and JetBrains Mono for numbers, already in the InfiniBot bundle. Offline, text falls back to the system sans.

## Semantics (identical)

- **Precedence:** org → location defaults → character → location × character. The most specific *set* value wins. `null` and `""` mean inherit; `false`, `0` and `[]` are real values.
- **Field lists:** location and character fields are exactly Robovoice's `LOCATION_DEFAULT_FIELDS` and `LOCATION_CHARACTER_FIELDS`, with the same kinds and ranges (`extensions/robovoice/src/pipeline.ts`).
  - The plugin coerces values like Robovoice's `coerceField`, so bad values fail before they reach Robovoice.
  - Robovoice validates again on write.
- **Apply live** diffs the edit against the inherited value (Robovoice's `decide()`):
  - A value equal to the inherited one, or empty, clears the override.
  - An unchanged value sends nothing ("No changes").
- **Global view:** defaults and the active agent's Text-to-Speech are sent in one `PATCH` (`characterValues`), as on Robovoice.
- **Resets:**
  - "Reset to inherited" on a saved override writes immediately ("Reset — now inherited").
  - "Reset location defaults" / "Reset agent overrides" clears that scope ("All overrides reset — everything inherits again").
- **Model/voice lists:** Robovoice's live list per provider (`options`). A saved value the account no longer offers is flagged "unavailable" with Robovoice's warning. If Robovoice returns no list for a provider, the field is free text.
- **InfiniBot as LLM:** only at the character layer, and only when the location's voice LLM is bound.

## Field-by-field

Two InfiniBot-side notes:

- **Active agent:** Robovoice binds the global view's TTS card to the org's active character. The edge view doesn't expose `active_character_id`, so InfiniBot uses the **Default character** set on the Voice page, else the main agent's character, else the first callable one. The card names the agent, e.g. "Provider · INFINI".
- **Platform-admin figures:** analytics, cost and margin are not exposed to edge tokens.

| Robovoice (location Pipeline page) | InfiniBot Voice › Pipeline | Parity |
|---|---|---|
| **Access note:** "You can override any field for {loc}. API keys stay with the organization — providers it has no key for can't be picked." / read-only / "placed here but not in the voice agent's roster" | Same copy (`canEditPipeline`, `callable:false` characters) | ✓ |
| **Sticky bar:** "At {loc} · Live voice pipeline for {agent} · latency = 24h p50 · swap a stage & apply." | Same copy. In agent scope InfiniBot names the agent being edited; Robovoice keeps the active agent | ✓ |
| Sticky bar: status / error text | Same ("Saved ✓", "No changes", errors) | ✓ |
| Sticky bar: **Reset location defaults** (location scope, can edit, has overrides) | Same; in agent scope it is "Reset agent overrides" and clears that agent's overrides (Robovoice keeps "Reset location defaults" there) | ✓ |
| Sticky bar: **Apply live** / "Applying…", disabled while saving or read-only | Same | ✓ |
| **Configure pipeline for:** Global pipeline ("The stages every agent inherits") + one option per agent, hinted with its own STT/LLM/TTS or "Inherits the global pipeline" | Same trigger and menu (label + hint per row, check on the current one), plus " · InfiniBot" on agents linked to an InfiniBot agent | ✓ |
| Scope helper: "Editing {loc}'s defaults — every field inherits from the organization until you override it here." / "Editing {agent} at {loc} — every field inherits until you override it here." | Same copy | ✓ |
| Location switch: the URL (`/l/<slug>`) | "Location:" select in the same card when the org has more than one location (`robovoice.location.select`) | ✓ (InfiniBot equivalent) |
| **1 Speech-to-Text:** number, engine pill, model, `lang: {stt_language}` | Same | ✓ |
| STT **Provider:** Groq · AssemblyAI · Soniox · fal.ai · Speaches (Whisper) (local) · VibeVoice (local); " · {price}"; "— no organization API key" for unavailable ones | Robovoice's own `providers.stt` list, labels and availability; " · included · 0 credits/min". The select shows the effective provider, with no separate "Inherit" row: picking the inherited one clears the override, as on Robovoice | ✓ |
| STT **Model:** searchable live list, per-provider field (`stt_model_groq`, `stt_model_speaches`, `stt_model_assemblyai`, `stt_model_soniox`) | Robovoice's combo: mono trigger, menu with Filter, name / id / price per row, "unavailable" badge. Same fields (fal STT model is org-level: "no model field for this provider"). No favourite stars (favourites are org settings) | ✓ |
| **2 Language Model:** pill, model, `temp {t} · ctx {num_ctx}` | Same, but only `temp {t}` (`num_ctx` isn't a location field, so the edge API doesn't send it) | ✓ except ctx |
| LLM **Provider:** OpenRouter · Groq · Google Gemini · Cerebras · Ollama Cloud · Ollama (local) | Robovoice's `providers.llm` (InfiniBot hidden in global scope, as on Robovoice) | ✓ |
| LLM **Model:** live list, per-provider field (`openrouter_model`, `groq_model`, `gemini_model`, `cerebras_model`, `ollama_model`, `ollama_cloud_model`); option price note | Same fields; tier price from the org catalog | ✓ |
| **3 Text-to-Speech:** "Provider · {active agent}", voice-tier badge, provider select "{label} — {price}", `speed {tts_speed}×` | Same; the tier and credits/min come from the org catalog. No `speed` line (`tts_speed` isn't a location field) | ✓ except speed |
| TTS **Voice:** ElevenLabs / Inworld searchable; fal is org-level ("fal voice (global)…"); Kokoro/Qwen select; Piper org-level | Same per provider (Piper and fal show "Organization-level") | ✓ |
| ProviderNotice "API key required." | Same | ✓ |
| Stage meters **Speed** (p50 · 24h) | Same panel, showing "—" (what Robovoice shows when it has no figure) | Element ✓, value ✗: Robovoice analytics aren't exposed to edge tokens |
| Stage meters **Price** / "Price / min {cpm} credits" + tier | "Price: Included · no extra credits" (STT/LLM); TTS "Price / min" + tier from the catalog | ✓ |
| Admin-only cost module (provider cost, est., % of turn cost), CostSplitBar | — | ✗ platform-admin only (edge tokens are never admin) |
| **Pause billing when idle:** copy, presets 10 s … 1 h ("After {n} idle") | Same copy and presets; the select shows the effective timeout | ✓ |
| **Language routing:** Adaptive language / Mixed-language speech / Auto-switch to ElevenLabs v3, default on, same copy | Same three toggles and copy, marker under each toggle | ✓ |
| **Default language map** (org-level on a location page) | Same heading and copy, marked "Organization-level" with a link to Robovoice, in both scopes. No on/off toggle or "N routed" pill: the map and its switch aren't sent to edge tokens | Partial (read-only there too) |
| **What this pipeline bills:** credits per conversation minute, tier sentence, Standard / Premium / Expressive chips | Same, from the org catalog's tier prices | ✓ except the plan-discount suffix (plan not exposed) |
| KPI grid: End-to-end p50/p95, EOU p50, Turns (24h), Price / min, Per 1k minutes | All six tiles; the four latency / turn tiles show "—", plus a link to Robovoice for the figures | Tiles ✓, values partial (analytics not exposed) |
| **Presets** (org-level on a location page) | Heading and copy, marked "Organization-level", in both scopes. The preset list itself isn't sent to edge tokens | Partial (read-only there too) |
| **Agent scope** (CharacterPipeline): "Pipeline" + "Override the STT / LLM stage for this agent. Leave a row on "inherit" to follow the global pipeline." | Same | ✓ |
| Agent scope rows: STT / LLM "Inherit global — {provider}" + model "Inherit — {model}", "set" pill; TTS provider + voice | Same. Selects show the agent's own value (org-level or overridden here), as on Robovoice | ✓ |
| Agent scope: "Effective now — STT p/m · LLM p/m · TTS p/v" | Same | ✓ |
| Agent scope: **Seamless multilingual** "(auto: on/off)" | Same auto rule (Qwen, or ElevenLabs v3/multilingual/flash/turbo_v2_5) | ✓ |
| Agent scope: **Expressive (laughter & emotion)** "(default: on/off)" with engine notes | Same copy and notes | ✓ |
| Agent scope: **Language voices (per-agent)** | Same copy; the map is marked "Organization-level" (not a location field). No route list or "inherits default" pill (not sent to edge tokens) | Partial (read-only on Robovoice's location page too) |
| Below the agent editor: Default language map, What this pipeline bills, KPI grid, Presets | Same four blocks in agent scope | ✓ |
| Per-field markers: "Inherited" / "Overridden here" + "Reset to inherited" / "Organization-level" | Same, plus "· unsaved" for pending edits | ✓ |
| Location-configurable fields Robovoice edits under Controls / Agents (turn detection, endpointing, VAD, interruptions, wake word, temperature, max tokens, STT language, ElevenLabs model and voice settings, Inworld model, expressive, seamless, preemptive generation) | **Advanced — location overrides** (collapsed), same labels, ranges and inherit markers | InfiniBot extra: Robovoice has these on other pages |

## What the edge API does not send

Checked against Robovoice's `app/api/edge/infinibot/pipeline/route.ts`, `lib/location-config-api.ts` (`locationConfigView`) and `app/api/edge/infinibot/catalog/route.ts`. None of these are in the response, so no RPC field could be added for them:

- 24h analytics: per-stage p50, end-to-end p50/p95, EOU delay, turn count.
- The plan and its discount (the catalog sends only credits/min per tier).
- `num_ctx`, `tts_speed`, the language map and its switch, presets, favourites, provider-status notes.
- Platform-admin cost, margin and rate-card figures.

Each one renders as Robovoice's own element in its no-data state, or is left out where Robovoice only shows it to platform admins.

## Side-by-side proof

`/tmp/voice-original-ui-shots/harness-pipeline/` (not in the repo) renders both sides from source with the same test fixtures:

- **Robovoice:** the real `PipelineTab` and `ScopeAccessNote` through `useLocationSettingsState`, built by Vite with Robovoice's `globals.css` and Tailwind. Only `fetch` is stubbed. Analytics, rate card and provider status are left unanswered, so the page shows its own empty states.
- **InfiniBot:** `<rv-pipeline-editor>` from this tree with a stub gateway client. Its view is produced by the plugin's real `pipelineView()` from the same fixtures.
- Run `./restart.sh`, then `node shoot.mjs`. It writes `pipeline-robovoice-global.png`, `pipeline-infinibot-global.png`, `pipeline-robovoice-agent.png` and `pipeline-infinibot-agent.png` to `/tmp/voice-original-ui-shots/`, 1440 wide.

The Robovoice side is rendered as a platform admin, the only view with the Provider + Model selects and the "Configure pipeline for" card. That view also carries admin-only blocks InfiniBot can't have: the "Admin · provider cost" panel in each stage card, the cost split bar, the cost/margin row under "What this pipeline bills", two extra KPI tiles and "· cost …" on option labels.
