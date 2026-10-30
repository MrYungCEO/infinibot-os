# Voice Terminal — holographic redesign brief (presentation-layer only)

Transform the Voice/Robovoice default view into an ultra-premium, cinematic, BORDERLESS
holographic AI command interface — **same app after a high-end futuristic reskin**. It must stay
immediately recognizable as the current Voice Terminal. Target files live in this folder
(`session-view.ts`, `session-styles.ts`, `voice-console.ts`, `live-state.ts`) + reuse/extend
`ui/src/ui/components/holo-panel.ts`.

## HARD CONSTRAINT — preserve functional identity (do NOT break anything)
This is a PRESENTATION redesign. Keep ALL existing event handlers, Lit state/reactive props,
WebSocket/live-state wiring, mic + audio-device selection, speaker selection, pipeline config,
model/LLM selection, transcript logic, connect/disconnect logic, navigation, settings, API calls.
Reuse existing components; redesign their presentation. If the central blob is already WebGL/
Three/canvas — KEEP IT, do not replace with an image; add HUD layers around it. Do not rebuild
architecture or rearrange the information architecture.

## Preserve the information architecture (same regions)
- Top-left nav: Session · Pipeline · Voice agents · Characters · Voice LLM · Account (Session stays clearly selected).
- Top-center branding, HUD-integrated: `INFINI` / `VOICE INTELLIGENCE TERMINAL`.
- Top-right: Wallet, balance, credits, menu, digital clock, HUD button, Settings/gear. Keep all.
- LEFT column (~20-23%): VOICE TERMINAL heading, OFFLINE + ROBOVOICE status, floating TRANSCRIPT, SYSTEM LOG (keep CLEAR).
- CENTER (~55-58%): the central wireframe AI core dominates, with session controls above (Connect, Mic, INFINI dropdown) and bottom primary controls (CONNECT, INFINI dropdown, central MICROPHONE, HUD, PIPELINE).
- RIGHT column (~20-23%): SYSTEM heading, LIVE PIPELINE (STT/LLM/TTS), MICROPHONE module, SPEAKER module.

## Dissolve the "boxed dashboard" feel (critical)
Replace rectangular panels with floating content: partial lines, corner brackets, local gradients,
soft glass fields, light traces, spatial separation, negative space. Many areas have NO full border
— use partial framing (top-left + bottom-right corner brackets) not full rectangles. Controls appear
suspended in space; the near-black background is the canvas.

## Central holographic AI core (most important)
Preserve the recognizable irregular polygonal WIREFRAME BLOB (hundreds of triangles), warm
champagne-white/pale gold, dark center so the wires read, suspended in space. NOT a face/robot/
smooth sphere/planet/logo/flame. Surround it with concentric HUD: targeting rings, segmented radial
rings, thin orbital tracks, rotating arcs, tick marks, data indicators, broken circles, waveform
arcs, floating particles, faint grid — WITH visual hierarchy (some rings nearly invisible, a few
segments glow). Small atmospheric HUD labels: LEFT = LISTEN/THINK/SPEAK/EVOLVE and HUMAN IDEAS +
MACHINE POTENTIAL; RIGHT = REALTIME/MULTIMODAL/INTELLIGENCE and THE FUTURE SPEAKS WITH YOU (small,
not headlines). Subtle holographic projection PLATFORM beneath the core (concentric ellipses, gold
floor traces, soft volumetric gold light) — kept subtle so the blob dominates.

## Transcript (floating comms feed, not a card)
Floating holographic feed with partial edges/brackets/gradients/glass. Seed demo messages:
`YOU 14:37:12 Hey Infini, what can you do?` / `INFINI 14:37:13 I can chat...` / `YOU 14:37:20 Tell me
a fun fact about space.` / `INFINI 14:37:21 A day on Venus is longer than a year on Venus.` /
`YOU 14:37:28 That's crazy. Can you speak it?` / `INFINI 14:37:30 Sure! Here you go...`
USER msgs: dark smoked glass, restrained, small user icon. INFINI msgs: warm translucent gold glass,
amber edge, AI/mic icon, tiny waveform, slightly brighter. Floating translucent capsules, not web
bubbles. Bottom status `∞ REALTIME CONVERSATION...` with a tiny animated waveform.

## System log (semi-borderless, monospace)
`14:37:01 SYSTEM INITIALIZED` / `14:37:01 Found 3 mics, 3 speakers` / `14:37:12 Connected to INFINI`
/ `14:37:21 STT → LLM → TTS pipeline ready` / `14:37:30 Voice output playing...`. Semantic colors:
green=ok, gold=active, white/gray=metadata, red=errors only. Faint partial framing only.

## Controls as floating holographic capsules (no container bar)
Session controls (Connect/Mic/INFINI dropdown) float independently: smoked glass, thin gold outline,
internal highlight, tiny indicator dot, soft glow, pill geometry. Bottom controls float individually
(no large container): CONNECT = strongest CTA, warm champagne/gold illuminated glass (a tiny
pink/violet edge hint allowed, gold dominant). INFINI = dark capsule w/ gold outline. MICROPHONE =
circular reactor: gold outer ring, champagne inner glow, subtle pale violet/pink energy gradient,
layered circles, luminous mic glyph, halo, tiny particles — appears to power the core. HUD + PIPELINE
= dark glass capsules, gold outlines, small icons.

## Right modules (floating, not stacked cards)
LIVE PIPELINE: STT (AssemblyAI - universal-streaming-english) → LLM (InfiniBot - infinibot:main) →
TTS (Kokoro - af_heart) vertical, connected by a thin luminous signal path with animated-looking
nodes; bottom `IDLE - AWAITING TURN` + a `— MS` latency indicator; slightly more visible dark
navy/black glass with ultra-thin gold/steel edge (still no thick border). MICROPHONE module: DEVICE
dropdown (floating dark glass, not default HTML), STATUS READY glows gold/green, indicator dot.
SPEAKER module: OUTPUT DEVICE dropdown, VOLUME slider → thin gold energy track, glowing circular
handle, illuminated progress trail.

## Material / palette / type / depth
Background near-black (#020304 / #050608 / #08090B) with faint grid, sparse gold dust, micro data
points, subtle radial gradients, atmospheric haze, restrained bloom — NOT a starfield/outer space.
Gold as LIGHT not flat yellow, tiers: #4A3510 #7A5816 #D6A62A #F5C84B #FFE49A #FFF3CF (white-gold
only on brightest edges; bright controls illuminate nearby surfaces). ~90% black/graphite/gold;
only tiny violet/pink/cyan-white energy accents (e.g. mic reactor gold→champagne→pale violet). Glass
= dark/technical/sharp/industrial smoked glass (rgba black + blur + thin illuminated perimeter +
localized gold reflection + soft shadow), NOT Apple frost. Typography: condensed uppercase technical
for headings; monospace for technical data/timestamps; clean sans-serif for conversation (most
readable). Clear Z-depth layers (bg → grid → particles → glass panels → HUD rings → blob → controls)
with differing blur/brightness/scale. Cinematic lighting from: core, HUD rings, platform, mic
reactor, CONNECT. Microdetail (tick marks, telemetry, targeting marks) noticed on second look, never
overpowering usability.

## Reusable visual primitives to build (Lit, in this view's folder or components/)
`HolographicPanel`, `HudCorners`, `GlowButton`, `HudCapsule`, `StatusIndicator`, `TelemetryLabel`,
`PipelineNode`, `TranscriptMessage`, `OrbitalRing`, `VoiceCore` (wrap existing blob), `MicReactor`.
CSS for glass/glow/borders/gradients/controls/status; SVG for rings/instrumentation; keep the WebGL
core. Prefer CSS/SVG/WebGL over static images.

## DO NOT
Radically change layout; remove any control/device selector/pipeline info; replace the wireframe
blob; make a face/robot/plain sphere; large solid panels; thick borders everywhere; everything
glowing equally; heavy blue neon / rainbow / crypto / generic-admin / game-inventory look; busy
background; sacrifice readability; huge typography; over-round everything; make controls
unrecognizable.

## Priority order
FUNCTIONAL FIDELITY > LAYOUT FIDELITY > CENTRAL BLOB FIDELITY > PREMIUM HOLOGRAPHIC DEPTH >
DECORATIVE SCI-FI EFFECTS.

## Verify
`pnpm -C ui build` green. Use the visual-verify-loop skill: screenshot the Voice view, confirm it
reads as a believable production Voice AI OS (not a sci-fi skin), the blob dominates center, controls
float, no boxed-dashboard feel, readability preserved, all original controls present. Iterate until
it clears the premium bar.
