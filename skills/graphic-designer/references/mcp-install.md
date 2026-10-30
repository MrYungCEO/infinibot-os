# MCP Installation Commands

## Quick Install (NPX)

### Fal.ai MCP — Image Generation Powerhouse
```bash
# Install
npx @anthropic/mcp install @fal-ai/mcp

# Or add to infinibot.json mcpServers:
{
  "mcpServers": {
    "fal-ai": {
      "command": "npx",
      "args": ["-y", "@fal-ai/mcp"],
      "env": {
        "FAL_KEY": "${FAL_AI_API_KEY}"
      }
    }
  }
}
```

**Available models:**
- FLUX Pro 1.1 (photorealistic)
- FLUX Schnell (fast)
- FLUX Dev (balanced)
- SDXL Lightning (fast stylized)
- Kling Video
- Real-time generation

### StudioMCPHub — 32 Creative Tools
```bash
# Install
npx @anthropic/mcp install @studio-mcp/hub

# infinibot.json:
{
  "mcpServers": {
    "studio-mcp": {
      "command": "npx",
      "args": ["-y", "@studio-mcp/hub"],
      "env": {
        "STUDIO_API_KEY": "${STUDIO_MCP_KEY}"
      }
    }
  }
}
```

**Tools included:**
- Image generation (multiple models)
- Video generation
- Audio synthesis
- Style transfer
- Upscaling
- Background removal
- And more...

### Blender MCP — 3D Modeling
```bash
# Install (requires Blender)
npx @anthropic/mcp install blender-mcp

# infinibot.json:
{
  "mcpServers": {
    "blender": {
      "command": "npx",
      "args": ["-y", "blender-mcp"],
      "env": {
        "BLENDER_PATH": "C:\\Program Files\\Blender Foundation\\Blender 4.0\\blender.exe"
      }
    }
  }
}
```

**Capabilities:**
- 3D object creation
- Scene composition
- Material assignment
- Rendering
- Animation

### Agent-Media — Video Generation Suite
```bash
# Install
npx @anthropic/mcp install @agent-media/mcp

# infinibot.json:
{
  "mcpServers": {
    "agent-media": {
      "command": "npx",
      "args": ["-y", "@agent-media/mcp"],
      "env": {
        "GOOGLE_AI_KEY": "${GOOGLE_AI_API_KEY}",
        "KLING_API_KEY": "${KLING_API_KEY}"
      }
    }
  }
}
```

**Models:**
- Veo (Google)
- Kling (Kuaishou)
- Sora (OpenAI) - when available

---

## Environment Variables Needed

Add to system or `.env`:

```bash
# Google Gemini (primary)
GEMINI_API_KEY=your-key-here

# Replicate (fallback)
REPLICATE_API_TOKEN=r8_your-token

# Fal.ai (optional)
FAL_AI_API_KEY=your-fal-key

# Studio MCP (optional)
STUDIO_MCP_KEY=your-key

# Kling (optional)
KLING_API_KEY=your-key
```

---

## Verify Installation

```bash
# Check MCP status
infinibot mcp list

# Test specific MCP
infinibot mcp test fal-ai
```

---

## Full infinibot.json Example

```json
{
  "skills": {
    "nano-banana-pro": {
      "env": {
        "GEMINI_API_KEY": "${GEMINI_API_KEY}"
      }
    },
    "replicate-media": {
      "env": {
        "REPLICATE_API_TOKEN": "${REPLICATE_API_TOKEN}"
      }
    }
  },
  "mcpServers": {
    "fal-ai": {
      "command": "npx",
      "args": ["-y", "@fal-ai/mcp"],
      "env": {
        "FAL_KEY": "${FAL_AI_API_KEY}"
      }
    },
    "studio-mcp": {
      "command": "npx",
      "args": ["-y", "@studio-mcp/hub"],
      "env": {
        "STUDIO_API_KEY": "${STUDIO_MCP_KEY}"
      }
    }
  }
}
```

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| MCP not found | Run `npm cache clean --force` then reinstall |
| Auth failed | Check API key in env vars |
| Timeout | Increase timeout in infinibot.json |
| Connection refused | Check if port is in use |
