---
name: course-video-generator
description: Generate full course videos with AI avatar (HeyGen), motion graphics (Veo 3), slides (Nano Banana Pro), and Remotion assembly. Use when asked to create educational videos, course content, tutorials, or training videos on any topic.
metadata:
  tags: video, heygen, course, avatar, veo3, remotion, education
  infinibot:
    emoji: "🎬"
    requires:
      bins: ["uv", "ffmpeg"]
      env: ["HEYGEN_API_KEY", "GEMINI_API_KEY"]
---

# Course Video Generator

Generate complete course videos with AI avatar narration, motion graphics B-roll, and professional slides.

## Pipeline Overview

```
Topic → Script → HeyGen Avatar + Veo 3 B-roll + Slides → Remotion Assembly → Final Video
```

## Quick Start

### 1. Generate Course Outline
```bash
uv run {baseDir}/scripts/generate_course.py --topic "Your Topic" --lessons 5 --output course_data.json
```

### 2. Generate All Assets
```bash
uv run {baseDir}/scripts/generate_assets.py --input course_data.json --output assets/
```

### 3. Assemble Final Video
```bash
uv run {baseDir}/scripts/assemble_video.py --assets assets/ --output final_course.mp4
```

## Component Scripts

### generate_course.py
Generates course structure with AI:
- Course title and description
- Lesson breakdown with scripts
- Visual cue points for B-roll
- Slide content descriptions

Options:
- `--topic`: Course topic (required)
- `--lessons`: Number of lessons (default: 5)
- `--duration`: Target duration per lesson in minutes (default: 3)
- `--style`: Presentation style (professional|casual|energetic)
- `--output`: Output JSON file

### generate_assets.py
Generates all media assets in parallel:
- **HeyGen videos**: Avatar narration for each lesson
- **Veo 3 clips**: Motion graphics B-roll
- **Nano Banana Pro**: Slide graphics and diagrams

Options:
- `--input`: Course data JSON from step 1
- `--output`: Output directory for assets
- `--avatar`: HeyGen avatar ID (default: stock avatar)
- `--voice`: HeyGen voice ID (default: Melissa - Friendly)
- `--skip-avatar`: Skip HeyGen generation (voice-only mode)

### assemble_video.py
Assembles all assets into final video:
- Combines avatar clips with B-roll overlays
- Adds slides at marked positions
- Applies transitions and captions
- Renders final video

Options:
- `--assets`: Assets directory from step 2
- `--output`: Final video file path
- `--resolution`: Output resolution (1080p|720p|4k)
- `--format`: Output format (mp4|webm)

## HeyGen Configuration

### Available Voices (Recommended)
| Voice ID | Name | Style |
|----------|------|-------|
| `1776ddbd05374fa480e92f0297bbc67e` | Melissa | Friendly, Female |
| `5cb81a519c4845f2b3c3d12b9630e258` | Paul | Friendly, Male |
| `030a414bdb8a4c49a1b04bae627fb945` | Infini | Male |
| `71b0aa6499f6458e8b040818a017db1f` | Nova | Female |

### Credit Usage
- Standard avatar: 1 credit/minute
- Avatar IV: 6 credits/minute
- Estimate 5-minute course: ~5 credits standard

## Cost Estimation

| Component | Cost | 10-min Course |
|-----------|------|---------------|
| HeyGen | 1 credit/min | 10 credits |
| Veo 3 | $0.40/sec | ~$24 (60s B-roll) |
| Nano Banana Pro | Free (Gemini) | $0 |
| **Total** | | ~$24 + 10 credits |

## Environment Variables

```bash
HEYGEN_API_KEY=sk_...     # HeyGen API key
GEMINI_API_KEY=...        # For Veo 3 + Nano Banana Pro
```

## Example Workflow

```bash
# Generate a 5-lesson course on "Python Basics"
uv run scripts/generate_course.py \
  --topic "Python Basics for Beginners" \
  --lessons 5 \
  --duration 3 \
  --style professional \
  --output python_course.json

# Generate all assets
uv run scripts/generate_assets.py \
  --input python_course.json \
  --output assets/ \
  --voice "1776ddbd05374fa480e92f0297bbc67e"

# Assemble final video
uv run scripts/assemble_video.py \
  --assets assets/ \
  --output python_course_final.mp4 \
  --resolution 1080p
```

## References

- [HeyGen API Patterns](references/heygen-api.md) - Video generation patterns
- [Veo 3 Prompts](references/veo3-prompts.md) - Optimal motion graphics prompts
- [Asset Timing](references/asset-timing.md) - Audio-visual sync guidelines
