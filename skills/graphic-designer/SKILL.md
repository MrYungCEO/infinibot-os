---
name: graphic-designer
description: Visual media generation specialist — images, videos, 3D renders. Comprehensive prompt engineering, model selection, and creative workflows.
homepage: https://ai.google.dev/
metadata: {"infinibot":{"emoji":"🖼️","requires":{"bins":["uv"],"env":["GEMINI_API_KEY","REPLICATE_API_TOKEN"]},"primaryEnv":"GEMINI_API_KEY"}}
---

# 🖼️ Canvas — Graphic Designer Agent

> **Visual media generation specialist.** Master prompt engineering, model selection, and creative workflows for stunning AI-generated content.

## 🎯 Quick Start

### Primary Tools

| Tool | Use Case | Speed | Cost | Quality |
|------|----------|-------|------|---------|
| **Nano Banana Pro** (Gemini) | General images, multi-image composition | Fast | ~$0.01 | Excellent |
| **Veo 3 Fast** | Video generation | Medium | ~$0.40/s | Excellent |
| **Replicate API** | Specialized models (FLUX, Kling) | Varies | Varies | Varies |

### Generate Image (Gemini — Primary)
```bash
uv run {skillsDir}/nano-banana-pro/scripts/generate_image.py \
  --prompt "your prompt" \
  --filename "output.png" \
  --resolution 2K
```

### Generate Video (Veo 3)
```bash
# Via Replicate or direct API
uv run veo3_generate.py --prompt "motion description" --duration 5
```

### Fallback (Replicate)
```powershell
& "$HOME\clawd\replicate-gen.ps1" -Prompt "description" -Model flux-pro
```

---

## 🧠 Prompt Engineering Mastery

### The Anatomy of a Perfect Prompt

```
[Subject] + [Action/Pose] + [Environment] + [Style] + [Lighting] + [Camera/Angle] + [Quality Keywords]
```

### Subject Description Layers

1. **Core subject**: What is it? Be specific
2. **Attributes**: Size, color, texture, material
3. **State/Action**: What's happening?
4. **Expression/Mood**: Emotional quality

### Environment & Context

1. **Setting**: Where is this?
2. **Time**: Day/night, season, era
3. **Weather/Atmosphere**: Mood enhancers
4. **Background elements**: Supporting details

### Style & Aesthetic

| Category | Keywords |
|----------|----------|
| **Photorealistic** | photorealistic, hyperrealistic, photograph, shot on [camera], 8K, RAW |
| **Digital Art** | digital painting, concept art, trending on ArtStation, by [artist] |
| **Illustration** | illustration, vector art, flat design, hand-drawn |
| **Cinematic** | cinematic lighting, film grain, anamorphic, movie still |
| **Anime/Manga** | anime style, Studio Ghibli, Makoto Shinkai, cel-shaded |
| **3D Render** | octane render, unreal engine 5, ray tracing, subsurface scattering |
| **Abstract** | abstract, generative art, geometric, fractal |
| **Vintage** | vintage photograph, polaroid, 35mm film, retro |

### Lighting Keywords

| Type | Effect |
|------|--------|
| **Golden hour** | Warm, soft, romantic |
| **Blue hour** | Cool, melancholic, cinematic |
| **Studio lighting** | Clean, professional, controlled |
| **Rembrandt lighting** | Dramatic, moody, artistic |
| **Volumetric lighting** | God rays, atmospheric depth |
| **Neon lighting** | Cyberpunk, vibrant, edgy |
| **Soft diffused** | Gentle, flattering, editorial |
| **High contrast** | Bold, dramatic, punchy |
| **Backlit/Rim light** | Separation, glow, silhouette |

### Camera & Angle

| Parameter | Options |
|-----------|---------|
| **Shot type** | extreme close-up, close-up, medium shot, full shot, wide shot, establishing shot |
| **Angle** | eye level, low angle, high angle, bird's eye, worm's eye, Dutch angle |
| **Lens** | 24mm wide, 35mm, 50mm, 85mm portrait, 200mm telephoto, macro |
| **Depth** | shallow DOF, deep focus, bokeh, tilt-shift |
| **Movement** | motion blur, frozen action, long exposure |

### Quality Boosters

```
8K resolution, highly detailed, intricate details, sharp focus, 
professional photography, masterpiece, award-winning, 
trending on ArtStation, featured on Behance
```

### Negative Prompts (What to Avoid)

```
blurry, low quality, distorted, deformed, bad anatomy, 
extra limbs, text, watermark, signature, cropped, 
oversaturated, underexposed, noise, artifacts
```

---

## 🎨 Model Selection Guide

### When to Use Each Model

| Scenario | Best Model | Why |
|----------|------------|-----|
| **Quick iteration/drafts** | FLUX Schnell | Fast (~2s), good quality |
| **Production images** | Nano Banana Pro (Gemini) | Excellent quality, prompt adherence |
| **Text in images** | Ideogram | Best text rendering |
| **Multi-image composition** | Nano Banana Pro | Supports up to 14 input images |
| **Artistic/stylized** | SDXL + LoRA | Huge style ecosystem |
| **Photorealistic** | FLUX Pro | Best realism |
| **Video (short)** | Veo 3 Fast | Quality + speed |
| **Video (complex)** | Kling | Longer duration, better motion |
| **Image editing** | Gemini (edit mode) | Natural language edits |
| **Upscaling** | Real-ESRGAN | Best quality upscale |
| **Background removal** | RemoveBG | Clean cutouts |

### Model Characteristics

#### Gemini (Nano Banana Pro)
- **Strengths**: Prompt understanding, multi-image, editing
- **Weaknesses**: Less artistic flexibility
- **Best for**: Production work, compositions, quick edits
- **Resolution**: 1K, 2K, 4K

#### FLUX Pro
- **Strengths**: Photorealism, consistency, detail
- **Weaknesses**: Slower, costs more
- **Best for**: Hero images, marketing materials
- **Resolution**: Up to 1440x1440

#### FLUX Schnell
- **Strengths**: Speed (~2s), good enough quality
- **Weaknesses**: Less refined
- **Best for**: Rapid prototyping, drafts
- **Resolution**: Up to 1024x1024

#### SDXL
- **Strengths**: Style variety via LoRAs, community
- **Weaknesses**: More finicky prompting
- **Best for**: Artistic styles, niche aesthetics
- **Resolution**: 1024x1024 (best at)

#### Kling
- **Strengths**: Video quality, motion coherence
- **Weaknesses**: Longer generation time
- **Best for**: Product videos, motion design
- **Duration**: 5-10s

---

## 📐 Resolution & Aspect Ratio Standards

### Common Aspect Ratios

| Ratio | Use Case | Pixels (Examples) |
|-------|----------|-------------------|
| **1:1** | Social posts, profile pics | 1024×1024, 2048×2048 |
| **4:3** | Traditional display | 1024×768, 2048×1536 |
| **16:9** | Video, widescreen | 1920×1080, 3840×2160 |
| **9:16** | Stories, Reels, TikTok | 1080×1920 |
| **3:2** | Photography standard | 1200×800, 2400×1600 |
| **2:3** | Portrait photography | 800×1200, 1600×2400 |
| **21:9** | Cinematic ultrawide | 2560×1080 |

### Platform-Specific Sizes

| Platform | Size | Format |
|----------|------|--------|
| **Instagram Post** | 1080×1080 | JPG/PNG |
| **Instagram Story** | 1080×1920 | JPG/PNG |
| **Twitter/X** | 1200×675 | JPG/PNG |
| **LinkedIn** | 1200×627 | JPG/PNG |
| **YouTube Thumbnail** | 1280×720 | JPG |
| **Facebook Cover** | 820×312 | PNG |
| **Pinterest** | 1000×1500 | JPG/PNG |
| **Website Hero** | 1920×1080+ | WebP |

### Resolution Guidelines

| Quality Tier | Resolution | Use Case |
|--------------|------------|----------|
| **Web/Social** | 1K (1024px) | Quick shares, drafts |
| **Print-ready** | 2K+ (2048px) | Marketing, presentations |
| **Large format** | 4K (4096px) | Posters, billboards |
| **Vector** | Infinite | Logos, icons (post-process) |

---

## 🎭 Color Theory Basics

### Color Harmonies

| Harmony | Description | Effect |
|---------|-------------|--------|
| **Monochromatic** | Single hue, varying saturation | Cohesive, elegant |
| **Complementary** | Opposite on wheel | High contrast, vibrant |
| **Analogous** | Adjacent colors | Harmonious, natural |
| **Triadic** | Three equidistant | Balanced, dynamic |
| **Split-complementary** | One + two adjacent opposites | Contrast with harmony |

### Color Psychology

| Color | Associations | Best For |
|-------|--------------|----------|
| **Blue** | Trust, calm, professional | Tech, finance, healthcare |
| **Red** | Energy, urgency, passion | Food, sales, entertainment |
| **Green** | Nature, growth, health | Eco, wellness, finance |
| **Yellow** | Optimism, warning, warmth | Caution, kids, energy |
| **Purple** | Luxury, creativity, mystery | Beauty, premium, spiritual |
| **Orange** | Friendly, confident, fun | Youth, creativity, food |
| **Black** | Sophisticated, powerful | Luxury, fashion, tech |
| **White** | Clean, minimal, pure | Health, tech, minimal design |

### Prompt Color Keywords

```
# Warm palette
warm tones, golden, amber, rust, terracotta, burnt orange, crimson

# Cool palette
cool tones, teal, azure, cobalt, slate, ice blue, mint

# Neutral palette
neutral colors, beige, taupe, gray, charcoal, ivory, cream

# Vibrant
vibrant colors, saturated, bold, electric, neon, vivid

# Muted
muted palette, desaturated, pastel, dusty, faded, soft

# Specific moods
moody and dark, bright and airy, earthy and organic, 
futuristic and synthetic, vintage and warm
```

---

## 📏 Composition Principles

### Rule of Thirds
- Divide frame into 3×3 grid
- Place subjects at intersections
- Prompt: "subject positioned at rule of thirds"

### Leading Lines
- Guide eye toward subject
- Prompt: "leading lines toward subject", "converging perspective"

### Symmetry & Balance
- Creates harmony and stability
- Prompt: "symmetrical composition", "centered subject", "perfect symmetry"

### Framing
- Use elements to frame subject
- Prompt: "natural framing", "framed by archway", "window frame composition"

### Depth Layers
- Foreground, midground, background
- Prompt: "layered composition", "depth of field", "foreground elements"

### Negative Space
- Let subject breathe
- Prompt: "minimalist composition", "negative space", "clean background"

### Dynamic Angles
- Create energy and interest
- Prompt: "dynamic angle", "dramatic perspective", "worm's eye view"

---

## 🎬 Video Generation Workflows

### Video Prompt Structure

```
[Subject + Action] + [Camera Movement] + [Environment] + [Style] + [Mood]
```

### Motion Keywords

| Type | Keywords |
|------|----------|
| **Subject motion** | walking, running, dancing, flying, floating, morphing |
| **Camera motion** | tracking shot, dolly zoom, crane shot, handheld, steadicam |
| **Speed** | slow motion, time-lapse, hyperlapse, real-time |
| **Transitions** | fade, dissolve, zoom transition, morph |

### Video Workflow

1. **Concept**: Define story/motion
2. **Storyboard**: Generate key frames as images first
3. **Generate**: Use Veo 3 or Kling for motion
4. **Review**: Check motion coherence
5. **Iterate**: Adjust prompt, regenerate
6. **Post-process**: Add audio, edit if needed

### Example Video Prompts

**Product Shot:**
```
Sleek smartphone rotating slowly on a reflective surface, 
soft studio lighting, product photography, 
smooth camera orbit around object, 
clean white background, commercial style
```

**Cinematic Scene:**
```
Aerial drone shot flying over misty mountain forest at sunrise,
golden hour lighting, cinematic color grading,
slow forward movement, establishing shot,
4K nature documentary style
```

**Character Animation:**
```
Young woman walking through neon-lit Tokyo street at night,
tracking shot following from side, 
reflections on wet pavement, rain particles,
cyberpunk aesthetic, blade runner style
```

---

## 🏢 Brand Consistency Guidelines

### Maintaining Visual Identity

1. **Document brand colors** (HEX values) in prompts
2. **Specify consistent style** keywords
3. **Use reference images** when possible
4. **Create style templates** for recurring needs

### Brand Prompt Template

```
[Subject Description]
Brand style: [modern/classic/playful/professional]
Color palette: [primary color], [secondary color], [accent]
Aesthetic: [brand aesthetic keywords]
Mood: [desired emotional response]
Format: [dimensions and platform]
```

### Example Brand Prompt

```
Professional headshot of diverse team member smiling confidently,
Brand style: modern tech startup,
Color palette: deep blue (#1e3a5f), warm gold (#d4a84b), clean white,
Aesthetic: approachable yet professional, innovative, trustworthy,
Mood: confident, welcoming, forward-thinking,
Format: 1:1 square for LinkedIn, clean background
```

---

## 📁 File Format Optimization

### Format Selection

| Format | Best For | Notes |
|--------|----------|-------|
| **WebP** | Web delivery | 30% smaller than JPEG, good quality |
| **PNG** | Transparency, graphics | Lossless, larger files |
| **JPEG** | Photos, social | Good compression, no transparency |
| **AVIF** | Modern web | Best compression, limited support |
| **SVG** | Logos, icons | Vector, infinite scale |
| **MP4** | Video | Universal support |
| **WebM** | Web video | Better compression, less support |

### Quality Settings

| Use Case | JPEG Quality | WebP Quality |
|----------|--------------|--------------|
| **Thumbnail** | 70 | 75 |
| **Web display** | 80-85 | 80 |
| **High quality** | 90 | 85 |
| **Archive/Print** | 95-100 | 95 |

### Output Directory

All generated media → `$HOME/.infinibot/generated/`

Naming convention:
```
YYYY-MM-DD_HH-MM-SS_[model]_[brief-desc].[ext]
2026-03-22_13-00-00_gemini_cyberpunk-city.webp
```

---

## 🔧 MCP Configuration

### Available MCPs for Media Generation

#### 1. Fal.ai MCP
Real-time and high-quality image generation.
```bash
# Install via npm
npx @anthropic/mcp install fal-ai/fal-mcp

# Or add to infinibot.json mcpServers
{
  "fal-ai": {
    "command": "npx",
    "args": ["-y", "@fal-ai/mcp"],
    "env": { "FAL_KEY": "${FAL_AI_API_KEY}" }
  }
}
```
**Models**: FLUX Pro, FLUX Schnell, SDXL Lightning, Kling Video, Real-time generation

#### 2. StudioMCPHub (32 Creative Tools)
Comprehensive creative suite.
```bash
npx @anthropic/mcp install studio-mcp-hub
```
**Tools**: Image gen, video gen, audio, upscaling, style transfer

#### 3. Blender MCP (3D Modeling)
```bash
npx @anthropic/mcp install blender-mcp
```
**Capabilities**: 3D modeling, rendering, scene composition

#### 4. Agent-Media (Video Generation)
```bash
npx @anthropic/mcp install agent-media
```
**Models**: Kling, Veo, Sora integration

### Current Active Tools

| Tool | Status | API Key |
|------|--------|---------|
| Nano Banana Pro | ✅ Active | GEMINI_API_KEY |
| Replicate | ✅ Active | REPLICATE_API_TOKEN |
| Veo 3 | ✅ Active | (via Google AI) |

---

## ⚡ Quick Prompt Templates

### Portrait
```
Professional portrait of [subject], 
[age/gender/ethnicity if relevant],
[expression: confident/warm/thoughtful],
[clothing/style],
soft studio lighting with slight fill,
shot on Canon 5D Mark IV, 85mm f/1.4,
shallow depth of field, bokeh background,
[color grading: warm/cool/natural],
8K, photorealistic, highly detailed
```

### Product Shot
```
[Product name/description] on [surface: marble/wood/minimal],
[angle: hero/flat lay/45-degree],
[lighting: soft diffused/dramatic/natural],
[background: gradient/solid/contextual],
commercial product photography,
clean shadows, professional composition,
8K render, advertising quality
```

### Landscape/Environment
```
[Scene description] at [time: golden hour/blue hour/night],
[weather: clear/foggy/stormy],
[atmosphere: peaceful/dramatic/mysterious],
[style: photorealistic/painterly/cinematic],
[foreground elements] leading to [subject],
volumetric lighting, depth layers,
shot on Phase One IQ4, 24mm
```

### Concept Art
```
[Scene/character description],
[genre: sci-fi/fantasy/cyberpunk],
[mood: epic/intimate/mysterious],
concept art by [reference artists],
highly detailed environment,
dramatic lighting, rich colors,
trending on ArtStation,
matte painting quality
```

### Social Media Graphic
```
[Subject/message] for [platform],
[style: modern/playful/professional],
[brand colors if applicable],
clean typography space,
[aspect ratio],
bold and shareable,
high contrast, attention-grabbing
```

---

## ✅ Pre-Generation Checklist

Before generating:

- [ ] **Clear subject** — What exactly are we creating?
- [ ] **Purpose defined** — What's it for? (social, print, web)
- [ ] **Dimensions set** — Aspect ratio and resolution
- [ ] **Style established** — Aesthetic and mood
- [ ] **Model chosen** — Best tool for the job
- [ ] **Quality level** — Draft vs production

## 📤 Post-Generation Workflow

After generating:

1. **Review** — Does it match the brief?
2. **Document** — Save prompt for reproducibility
3. **Format** — Convert to optimal format
4. **Deliver** — Return path + metadata
5. **Iterate** — Refine if needed

### Output Format

Always return:
```
✅ Generated: [brief description]
📁 Path: $HOME/.infinibot/generated/[filename]
🎨 Model: [model used]
📐 Resolution: [dimensions]
💬 Prompt: "[prompt used]"

MEDIA: $HOME/.infinibot/generated/[filename]
```

---

## 🚨 Troubleshooting

| Issue | Solution |
|-------|----------|
| Blurry output | Increase resolution, add "sharp focus, highly detailed" |
| Wrong style | Be more explicit, use artist references |
| Bad composition | Specify "rule of thirds", "centered", etc. |
| Missing details | Add specific descriptors, layer your prompt |
| Wrong colors | Explicitly state color palette or mood |
| Artifacts | Try different seed, simplify prompt |
| Hands/faces bad | Zoom out, use portrait-specific keywords |

---

## 🎓 Advanced Techniques

### Seed Control
Use consistent seeds for variations on the same base.

### Prompt Weighting
Some models support: `(important detail:1.3)` or `[less important]`

### Style Mixing
Combine artists: "style of Moebius and Studio Ghibli"

### Iterative Refinement
1. Generate base concept (fast model)
2. Refine with detailed prompt (quality model)
3. Upscale if needed
4. Post-process (edit mode)

### Multi-Image Composition
With Gemini, combine up to 14 reference images:
```bash
uv run generate_image.py --prompt "combine into scene" -i ref1.png -i ref2.png -i ref3.png
```

---

*Canvas Agent — Creating visual excellence, one pixel at a time.* 🎨
