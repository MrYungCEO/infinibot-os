---
name: replicate-media
description: Generate images and videos using Replicate API. Supports FLUX, SDXL, Kling, Minimax, and more. Always returns direct media links.
homepage: https://replicate.com/docs
metadata: {"infinibot":{"emoji":"🎨","requires":{"env":["REPLICATE_API_TOKEN"]},"primaryEnv":"REPLICATE_API_TOKEN"}}
---

# Replicate Media Generation

Generate high-quality images and videos using the Replicate API.

## Quick Start

### PowerShell Helper Script
```powershell
# Location: $HOME\clawd\replicate-gen.ps1

# Basic image generation
.\replicate-gen.ps1 -Prompt "cyberpunk city at night, neon lights, rain" -Model flux-pro

# Fast generation
.\replicate-gen.ps1 -Prompt "cute robot" -Model flux-schnell

# Video generation
.\replicate-gen.ps1 -Prompt "a cat walking through a garden" -Model kling

# With save
.\replicate-gen.ps1 -Prompt "portrait" -Model flux-pro -AspectRatio "9:16" -Save
```

### Direct API (when script unavailable)

```powershell
# Set token
$token = $env:REPLICATE_API_TOKEN
$headers = @{ "Authorization" = "Bearer $token"; "Content-Type" = "application/json" }

# Get model version
$model = Invoke-RestMethod -Uri "https://api.replicate.com/v1/models/black-forest-labs/flux-1.1-pro" -Headers $headers
$version = $model.latest_version.id

# Create prediction
$body = @{
    version = $version
    input = @{
        prompt = "YOUR PROMPT"
        aspect_ratio = "1:1"
        output_format = "webp"
        output_quality = 90
    }
} | ConvertTo-Json

$pred = Invoke-RestMethod -Uri "https://api.replicate.com/v1/predictions" -Headers $headers -Method Post -Body $body

# Poll for result
do {
    Start-Sleep -Seconds 2
    $result = Invoke-RestMethod -Uri "https://api.replicate.com/v1/predictions/$($pred.id)" -Headers $headers
} while ($result.status -notin @("succeeded", "failed"))

# Get output URL
$result.output
```

## Available Models

### Image Generation

| Model | Speed | Quality | Best For | Cost |
|-------|-------|---------|----------|------|
| `flux-pro` | Medium | Excellent | Production images | ~$0.04 |
| `flux-schnell` | Fast | Good | Quick iterations | ~$0.003 |
| `flux-dev` | Medium | Great | Development | ~$0.025 |
| `sdxl` | Medium | Good | Artistic styles | ~$0.002 |
| `ideogram` | Medium | Great | Text in images | ~$0.08 |
| `recraft` | Medium | Great | Design assets | ~$0.04 |

### Video Generation

| Model | Duration | Quality | Best For | Cost |
|-------|----------|---------|----------|------|
| `kling` | 5-10s | Excellent | High quality video | ~$0.10 |
| `minimax` | 5s | Good | Fast video | ~$0.05 |
| `ltx-video` | 5s | Good | Quick previews | ~$0.03 |

## Model-Specific Options

### FLUX Pro
```json
{
  "prompt": "description",
  "aspect_ratio": "1:1|16:9|9:16|4:3|3:4",
  "output_format": "webp|png|jpg",
  "output_quality": 80-100,
  "safety_tolerance": 1-5,
  "prompt_upsampling": true
}
```

### SDXL
```json
{
  "prompt": "description",
  "negative_prompt": "things to avoid",
  "width": 1024,
  "height": 1024,
  "num_inference_steps": 30,
  "guidance_scale": 7.5,
  "scheduler": "K_EULER"
}
```

### Kling Video
```json
{
  "prompt": "motion description",
  "duration": 5,
  "aspect_ratio": "16:9|9:16|1:1"
}
```

## Image Editing

### Inpainting (FLUX Fill)
```powershell
$body = @{
    version = "FLUX_FILL_VERSION"
    input = @{
        image = "https://source-image-url"
        mask = "https://mask-image-url"
        prompt = "what to generate in masked area"
    }
} | ConvertTo-Json
```

### Upscaling
```powershell
# Real-ESRGAN
$body = @{
    version = "ESRGAN_VERSION"
    input = @{
        image = "https://image-url"
        scale = 4
    }
} | ConvertTo-Json
```

### Background Removal
```powershell
$body = @{
    version = "REMOVE_BG_VERSION"
    input = @{
        image = "https://image-url"
    }
} | ConvertTo-Json
```

## Prompt Engineering Tips

### Structure
```
[Subject] + [Environment] + [Style] + [Lighting] + [Camera] + [Quality]
```

### Examples

**Photorealistic Portrait:**
```
professional headshot of a woman, soft studio lighting, 
shot on Canon 5D, shallow depth of field, 85mm lens, 
8K resolution, photorealistic, highly detailed
```

**Concept Art:**
```
epic fantasy castle on floating islands, dramatic sunset,
volumetric lighting, concept art by Craig Mullins,
matte painting, trending on ArtStation
```

**Product Shot:**
```
sleek wireless earbuds on marble surface, 
soft diffused lighting, minimal background,
commercial product photography, studio setup
```

**Anime Style:**
```
anime girl with blue hair, cherry blossom background,
Studio Ghibli style, soft pastel colors,
detailed illustration, by Makoto Shinkai
```

## CRITICAL: Always Return Links

Every generation MUST return the direct URL:

```
✅ Generated Image
Prompt: "cyberpunk city"
Model: FLUX Pro
Link: https://replicate.delivery/pbxt/xxxxx/output.webp

![Generated](https://replicate.delivery/pbxt/xxxxx/output.webp)
```

## Troubleshooting

### Common Issues

1. **401 Unauthorized**: Check REPLICATE_API_TOKEN is set
2. **Model not found**: Verify model owner/name spelling
3. **Timeout**: Video generation can take 1-5 minutes
4. **NSFW blocked**: Increase safety_tolerance (up to 5)

### Check Token
```powershell
$env:REPLICATE_API_TOKEN
# Should show your token starting with "r8_..."
```

### Test API Connection
```powershell
$headers = @{ "Authorization" = "Bearer $env:REPLICATE_API_TOKEN" }
Invoke-RestMethod -Uri "https://api.replicate.com/v1/models" -Headers $headers -Method Get
```

## Output Directory

Generated media is saved to: `$HOME/.infinibot/generated/`

Organized by model:
```
generated/
├── flux-pro_20260308_121500.webp
├── kling_20260308_122000.mp4
└── sdxl_20260308_123000.png
```
