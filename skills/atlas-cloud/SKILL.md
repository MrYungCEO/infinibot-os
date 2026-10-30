---
name: atlas-cloud
description: Uncensored image and video generation via Atlas Cloud API. Access Wan 2.6, Wan 2.5, Van 2.6 for image editing, text-to-video, image-to-video, and reference-to-video with no content restrictions.
homepage: https://www.atlascloud.ai/docs
metadata: {"moltbot":{"emoji":"🔥","requires":{"env":["ATLAS_CLOUD_API_KEY"]},"primaryEnv":"ATLAS_CLOUD_API_KEY"}}
---

# Atlas Cloud Media Generation

Uncensored image editing and video generation through Atlas Cloud API. Access Wan 2.6, Wan 2.5, Van models and others without content restrictions.

## API Configuration

**Base URL:** `https://api.atlascloud.ai/api/v1/model`

**Authentication:** Bearer token in Authorization header

```powershell
$headers = @{
    "Authorization" = "Bearer $env:ATLAS_CLOUD_API_KEY"
    "Content-Type" = "application/json"
}
```

**API key:** set `ATLAS_CLOUD_API_KEY` in your environment (create a key in the Atlas Cloud dashboard). Never commit it.

Store this in environment:
```powershell
[Environment]::SetEnvironmentVariable("ATLAS_CLOUD_API_KEY", "<your-atlas-cloud-api-key>", "User")
```

---

## Wan 2.6 / Wan 2.5 Image Editing (I2I)

Transform existing images with uncensored editing capabilities.

**Actual model IDs from Atlas Cloud:**
- Image Edit (I2I): `alibaba/wan-2.5/image-edit`
- Text-to-Image: `alibaba/wan-2.6/text-to-image`
- Qwen Image Edit: `alibaba/qwen-image/edit` or `alibaba/qwen-image/edit-plus`

### Upload Image First
```powershell
$imagePath = "C:\path\to\image.jpg"
$uploadResponse = Invoke-RestMethod -Uri "https://api.atlascloud.ai/api/v1/model/uploadMedia" `
    -Headers @{"Authorization" = "Bearer $env:ATLAS_CLOUD_API_KEY"} `
    -Method Post `
    -Form @{ file = Get-Item $imagePath }

$imageUrl = $uploadResponse.url
```

### Generate Edited Image
```powershell
$body = @{
    model = "alibaba/wan-2.5/image-edit"  # Exact Atlas Cloud model ID
    prompt = "your editing prompt here"
    image_url = $imageUrl
    # Check model schema for available parameters per model
} | ConvertTo-Json

$response = Invoke-RestMethod -Uri "https://api.atlascloud.ai/api/v1/model/generateImage" `
    -Headers $headers `
    -Method Post `
    -Body $body

$predictionId = $response.data.id
```

### Poll for Result
```powershell
do {
    Start-Sleep -Seconds 2
    $result = Invoke-RestMethod -Uri "https://api.atlascloud.ai/api/v1/model/prediction/$predictionId" `
        -Headers $headers
} while ($result.data.status -notin @("completed", "failed"))

if ($result.data.status -eq "completed") {
    $outputUrl = $result.data.outputs[0]
    # Download image
    Invoke-WebRequest -Uri $outputUrl -OutFile "edited_output.png"
}
```

---

## Wan 2.6 / Van Video Generation

Video generation models available through Atlas Cloud.

**Actual model IDs from Atlas Cloud:**
| Mode | Model ID | Notes |
|------|----------|-------|
| T2V | `atlascloud/van-2.6/text-to-video` | Speed-optimized |
| T2V | `alibaba/wan-2.5/text-to-video` | Full quality |
| T2V Fast | `alibaba/wan-2.5/text-to-video-fast` | Faster, lower latency |
| I2V | `atlascloud/van-2.6/image-to-video` | Speed-optimized |
| I2V | `alibaba/wan-2.5/image-to-video` | Full quality |
| I2V Fast | `alibaba/wan-2.5/image-to-video-fast` | Faster generation |
| Character Swap | `alibaba/wan-2.2/animate-mix` | Replace characters |
| Animation | `alibaba/wan-2.2/animate-move` | Image to animation |
| Video Extend | `alibaba/wan-2.2-spicy/video-extend` | Extend videos |
| R2V | `vidu/reference-to-video-2.0` | Reference video |
| R2V | `vidu/reference-to-video-q1` | Alternative |

### Text-to-Video (T2V)
Generate videos from text prompts.

```powershell
$body = @{
    model = "atlascloud/van-2.6/text-to-video"  # or "alibaba/wan-2.5/text-to-video"
    prompt = "cinematic shot of a futuristic city at sunset, flying cars, neon lights reflecting on wet streets"
    # Check model schema for available parameters (varies by model)
} | ConvertTo-Json

$response = Invoke-RestMethod -Uri "https://api.atlascloud.ai/api/v1/model/generateVideo" `
    -Headers $headers `
    -Method Post `
    -Body $body

$predictionId = $response.data.id
```

### Image-to-Video (I2V)
Animate static images into videos.

```powershell
# First upload the source image
$uploadResponse = Invoke-RestMethod -Uri "https://api.atlascloud.ai/api/v1/model/uploadMedia" `
    -Headers @{"Authorization" = "Bearer $env:ATLAS_CLOUD_API_KEY"} `
    -Method Post `
    -Form @{ file = Get-Item "source_image.jpg" }

$body = @{
    model = "atlascloud/van-2.6/image-to-video"  # or "alibaba/wan-2.5/image-to-video"
    prompt = "the person walks forward confidently, camera slowly pans to follow"
    image_url = $uploadResponse.url
    # Check model schema for available parameters
} | ConvertTo-Json

$response = Invoke-RestMethod -Uri "https://api.atlascloud.ai/api/v1/model/generateVideo" `
    -Headers $headers `
    -Method Post `
    -Body $body
```

### Reference-to-Video (R2V)
Upload a reference video to preserve character appearance, movement, and voice.

```powershell
# Upload reference video (2-30 seconds)
$uploadResponse = Invoke-RestMethod -Uri "https://api.atlascloud.ai/api/v1/model/uploadMedia" `
    -Headers @{"Authorization" = "Bearer $env:ATLAS_CLOUD_API_KEY"} `
    -Method Post `
    -Form @{ file = Get-Item "reference_video.mp4" }

$body = @{
    model = "vidu/reference-to-video-2.0"  # or "vidu/reference-to-video-q1"
    prompt = "same character walking through a cyberpunk market, maintain exact appearance"
    video_url = $uploadResponse.url
    # Check model schema for available parameters
} | ConvertTo-Json

$response = Invoke-RestMethod -Uri "https://api.atlascloud.ai/api/v1/model/generateVideo" `
    -Headers $headers `
    -Method Post `
    -Body $body
```

### Character Swap (Wan 2.2)
Replace characters in videos while preserving scene, lighting, and tone.

```powershell
# Upload character image and source video
$charUpload = Invoke-RestMethod -Uri "https://api.atlascloud.ai/api/v1/model/uploadMedia" `
    -Headers @{"Authorization" = "Bearer $env:ATLAS_CLOUD_API_KEY"} `
    -Method Post -Form @{ file = Get-Item "character.jpg" }

$videoUpload = Invoke-RestMethod -Uri "https://api.atlascloud.ai/api/v1/model/uploadMedia" `
    -Headers @{"Authorization" = "Bearer $env:ATLAS_CLOUD_API_KEY"} `
    -Method Post -Form @{ file = Get-Item "source_video.mp4" }

$body = @{
    model = "alibaba/wan-2.2/animate-mix"
    image_url = $charUpload.url
    video_url = $videoUpload.url
} | ConvertTo-Json
```

### Poll for Video Result
```powershell
$pollCount = 0
$maxPolls = 120  # 10 minutes max (5 second intervals)

do {
    Start-Sleep -Seconds 5
    $result = Invoke-RestMethod -Uri "https://api.atlascloud.ai/api/v1/model/prediction/$predictionId" `
        -Headers $headers

    $status = $result.data.status
    Write-Host "[$pollCount/$maxPolls] Status: $status"

    if ($status -eq "completed") {
        $videoUrl = $result.data.outputs[0]
        Invoke-WebRequest -Uri $videoUrl -OutFile "wan_output.mp4"
        Write-Host "✅ Video saved: wan_output.mp4"
        break
    }
    elseif ($status -eq "failed") {
        throw "Generation failed: $($result.data.error)"
    }

    $pollCount++
} while ($pollCount -lt $maxPolls)
```

---

## PowerShell Helper Script

Save as `atlas-gen.ps1`:

```powershell
param(
    [Parameter(Mandatory)]
    [string]$Prompt,
    
    [Parameter(Mandatory)]
    [ValidateSet("wan-i2i", "wan-t2v", "wan-i2v", "wan-r2v", "wan-swap")]
    [string]$Mode,
    
    [string]$InputPath,
    [string]$VideoPath,  # For character swap
    [string]$OutputPath = "atlas_output",
    [ValidateSet("16:9", "9:16", "1:1")]
    [string]$AspectRatio = "16:9"
)

$ErrorActionPreference = "Stop"
$apiKey = $env:ATLAS_CLOUD_API_KEY

if (-not $apiKey) {
    throw @"
ATLAS_CLOUD_API_KEY not set!

Set it with:
  [Environment]::SetEnvironmentVariable("ATLAS_CLOUD_API_KEY", "<your-atlas-cloud-api-key>", "User")

Or for this session only:
  `$env:ATLAS_CLOUD_API_KEY = "<your-atlas-cloud-api-key>"
"@
}

$headers = @{
    "Authorization" = "Bearer $apiKey"
    "Content-Type" = "application/json"
}

# Model mapping (verified Atlas Cloud model IDs)
$modelMap = @{
    "wan-i2i"   = "alibaba/wan-2.5/image-edit"
    "wan-t2v"   = "atlascloud/van-2.6/text-to-video"  # or "alibaba/wan-2.5/text-to-video"
    "wan-i2v"   = "atlascloud/van-2.6/image-to-video" # or "alibaba/wan-2.5/image-to-video"
    "wan-r2v"   = "vidu/reference-to-video-2.0"
    "wan-swap"  = "alibaba/wan-2.2/animate-mix"
}

$model = $modelMap[$Mode]
$body = @{
    model = $model
    prompt = $Prompt
}

# Handle file uploads
if ($InputPath -and $Mode -in @("wan-i2i", "wan-i2v", "wan-r2v", "wan-swap")) {
    if (-not (Test-Path $InputPath)) {
        throw "Input file not found: $InputPath"
    }
    
    $fileInfo = Get-Item $InputPath
    Write-Host "📤 Uploading $($fileInfo.Name)..." -ForegroundColor Cyan
    
    $uploadResponse = Invoke-RestMethod -Uri "https://api.atlascloud.ai/api/v1/model/uploadMedia" `
        -Headers @{"Authorization" = "Bearer $apiKey"} `
        -Method Post `
        -Form @{ file = $fileInfo }
    
    if ($Mode -eq "wan-swap") {
        $body.image_url = $uploadResponse.url
    } elseif ($Mode -eq "wan-r2v") {
        $body.video_url = $uploadResponse.url
    } else {
        $body.image_url = $uploadResponse.url
    }
    Write-Host "✅ Uploaded: $($uploadResponse.url)" -ForegroundColor Green
}

# For character swap, also upload video
if ($Mode -eq "wan-swap" -and $VideoPath) {
    if (-not (Test-Path $VideoPath)) {
        throw "Video file not found: $VideoPath"
    }
    
    $videoInfo = Get-Item $VideoPath
    Write-Host "📤 Uploading video $($videoInfo.Name)..." -ForegroundColor Cyan
    
    $videoUpload = Invoke-RestMethod -Uri "https://api.atlascloud.ai/api/v1/model/uploadMedia" `
        -Headers @{"Authorization" = "Bearer $apiKey"} `
        -Method Post `
        -Form @{ file = $videoInfo }
    
    $body.video_url = $videoUpload.url
}

# Submit generation
$endpoint = if ($Mode -eq "wan-i2i") { "generateImage" } else { "generateVideo" }
Write-Host "`n🎬 Submitting to Atlas Cloud ($model)..." -ForegroundColor Cyan

$response = Invoke-RestMethod -Uri "https://api.atlascloud.ai/api/v1/model/$endpoint" `
    -Headers $headers `
    -Method Post `
    -Body ($body | ConvertTo-Json -Depth 10)

$predictionId = $response.data.id
Write-Host "⏳ Task: $predictionId" -ForegroundColor Yellow

# Poll for result
$isVideo = $Mode -ne "wan-i2i"
$pollInterval = if ($isVideo) { 5 } else { 2 }
$maxPolls = if ($isVideo) { 180 } else { 60 }

for ($i = 1; $i -le $maxPolls; $i++) {
    Start-Sleep -Seconds $pollInterval
    
    try {
        $result = Invoke-RestMethod -Uri "https://api.atlascloud.ai/api/v1/model/prediction/$predictionId" `
            -Headers $headers
    }
    catch {
        Write-Host "`n⚠️ Poll error: $_, retrying..." -ForegroundColor Yellow
        continue
    }
    
    $status = $result.data.status
    $progress = if ($result.data.progress) { " ($($result.data.progress)%)" } else { "" }
    
    Write-Host "`r                                                    " -NoNewline
    Write-Host "`r[$i/$maxPolls] Status: $status$progress" -NoNewline
    
    if ($status -eq "completed") {
        Write-Host "`n`n✅ Generation complete!" -ForegroundColor Green
        $outputUrl = $result.data.outputs[0]
        $ext = if ($isVideo) { ".mp4" } else { ".png" }
        $finalPath = "$OutputPath$ext"
        
        $outputDir = Split-Path -Parent (Resolve-Path $finalPath -ErrorAction SilentlyContinue)
        if (-not $outputDir) { $outputDir = "." }
        if (-not (Test-Path $outputDir)) {
            New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
        }
        
        Write-Host "⬇️  Downloading..." -ForegroundColor Cyan
        Invoke-WebRequest -Uri $outputUrl -OutFile $finalPath
        
        Write-Host "✅ Saved: $(Resolve-Path $finalPath)`n" -ForegroundColor Green
        Write-Host "Link: $outputUrl" -ForegroundColor Gray
        
        return $finalPath
    }
    elseif ($status -eq "failed") {
        throw "`nGeneration failed: $($result.data.error)"
    }
}

throw "`nTimeout: Generation took too long"
```

---

## Usage Examples

### Image Editing
```powershell
# Edit an image
.\atlas-gen.ps1 -Prompt "make the sky purple and add dramatic lighting" `
    -Mode wan-i2i -InputPath "photo.jpg" -OutputPath "edited"
```

### Text-to-Video
```powershell
# Generate video from text
.\atlas-gen.ps1 -Prompt "cinematic drone shot of a cyberpunk city at sunset" `
    -Mode wan-t2v -OutputPath "cityscape"
```

### Image-to-Video
```powershell
# Animate a static image
.\atlas-gen.ps1 -Prompt "slow zoom in, subtle parallax movement" `
    -Mode wan-i2v -InputPath "artwork.png" -OutputPath "animated"
```

### Character Swap
```powershell
# Replace character in video
.\atlas-gen.ps1 -Prompt "replace with new character" `
    -Mode wan-swap -InputPath "character.jpg" -VideoPath "source_video.mp4" -OutputPath "swapped"
```

### Reference-to-Video
```powershell
# Clone character into new scene
.\atlas-gen.ps1 -Prompt "same character walking through neon-lit Tokyo" `
    -Mode wan-r2v -InputPath "reference_video.mp4" -OutputPath "character_tokyo"
```

---

## Other Video Models Available

Atlas Cloud has many video models - here are key ones:

| Model | Provider | Type | Notes |
|-------|----------|------|-------|
| Kling v2.1 | `kwaivgi/kling-v2.1-t2v-master` | T2V | Cinematic quality |
| Kling v2.1 | `kwaivgi/kling-v2.1-i2v-master` | I2V | Professional grade |
| Seedance v1 | `bytedance/seedance-v1-pro-t2v-1080p` | T2V | Multi-shot, 1080p |
| Seedance v1 | `bytedance/seedance-v1-pro-i2v-1080p` | I2V | Cinematic motion |
| Hailuo 02 | `minimax/hailuo-02/t2v-pro` | T2V | MiniMax latest |
| Hailuo 02 | `minimax/hailuo-02/i2v-pro` | I2V | High quality |

---

## Troubleshooting

### 401 Unauthorized
```powershell
# Verify API key is set
$env:ATLAS_CLOUD_API_KEY
# Should show: <your-atlas-cloud-api-key>
```

### Model Not Found
Check the exact model IDs at: https://www.atlascloud.ai/models/list

```powershell
# List available models via API
$headers = @{"Authorization" = "Bearer $env:ATLAS_CLOUD_API_KEY"}
Invoke-RestMethod -Uri "https://api.atlascloud.ai/api/v1/models" -Headers $headers
```

### Upload Failures
- Ensure file is under size limit (check model schema)
- Supported formats: JPG, PNG, MP4
- Maximum video duration: 30 seconds for reference videos

---

## Output Directory

Generated media is saved to: `$HOME/.infinibot/generated/`

---

## CRITICAL: Always Return Links

Every generation MUST return the direct URL:

```
✅ Generated Image
Prompt: "cyberpunk city at night"
Model: alibaba/wan-2.5/image-edit
Link: https://api.atlascloud.ai/output/xxxxx.png

![Generated](https://api.atlascloud.ai/output/xxxxx.png)
```

---

## Prompt Engineering Tips

### For Image Editing
- Be specific about changes
- Reference specific elements
- Use "change X to Y" format for clear modifications

### For Video Generation
**Structure:**
```
[Camera movement] + [Subject action] + [Environment detail] + [Lighting/Mood] +
[Technical quality tags]
```

**T2V Examples:**
```
cinematic drone shot slowly descending into a cyberpunk city,
flying cars streaking between neon-lit skyscrapers, rain falling,
reflections on wet streets, Blade Runner aesthetic, 8K quality
```

---

🜂 Uncensored creation. No filters. Just fire.
