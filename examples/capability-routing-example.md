# Capability-Based Auto-Routing Example

This example demonstrates how to use the new capability-based auto-routing feature to automatically route spawns to the best node based on required capabilities.

## Basic Usage

### Spawn with GPU Requirements

```typescript
// Spawn a task that requires GPU for image generation
await mesh({
  action: "spawn", 
  agentId: "coder",
  task: "Generate a landscape image using ComfyUI",
  // This will automatically route to a node with GPU + ComfyUI
  requiredCapabilities: ["gpu", "comfyui"],
  minGpuVRAM: 8,  // Require at least 8GB VRAM
});
```

### Spawn with Ollama Requirements

```typescript
// Spawn a task that requires Ollama for local LLM inference
await mesh({
  action: "spawn",
  agentId: "coder", 
  task: "Run code analysis using local Llama model",
  // This will automatically route to a node with Ollama
  requiredCapabilities: ["ollama"],
  // Optional preferences for better performance
  preferredCapabilities: ["gpu"],  // Prefer GPU acceleration if available
});
```

### Spawn with Multiple Requirements

```typescript
// Spawn a complex task requiring multiple capabilities
await mesh({
  action: "spawn",
  agentId: "coder",
  task: "Create a voice narrated video with custom graphics",
  // Hard requirements - task will fail if no node has these
  requiredCapabilities: ["gpu", "voice", "ffmpeg"],
  // Soft preferences - bonus points for having these
  preferredCapabilities: ["comfyui"],
  minGpuVRAM: 12,  // Need plenty of VRAM for video processing
});
```

### Spawn with MCP Server Requirements

```typescript
// Spawn a task that needs specific MCP servers
await mesh({
  action: "spawn",
  agentId: "coder", 
  task: "Automate browser testing with Playwright",
  // This will route to a node that has the Playwright MCP server
  requiredCapabilities: ["playwright"],
  preferredCapabilities: ["ffmpeg"],  // For recording test videos
});
```

## Available Capabilities

### Standard Capabilities
- `gpu` - GPU acceleration (image gen, ML inference)
- `ollama` - Ollama LLM server for local inference
- `voice` - Voice/audio processing (TTS, STT)
- `comfyui` - ComfyUI for advanced image generation
- `ffmpeg` - Video/audio processing
- `workspace` - Specific workspace access

### MCP Server Capabilities
Any MCP server name can be used as a capability:
- `playwright` - Browser automation
- `file_manager` - Advanced file operations
- `docker` - Container management
- Custom MCP servers by name

## Routing Logic

The capability router uses this scoring algorithm:

1. **Hard Requirements (Filter)**: Node MUST have all required capabilities
2. **Soft Preferences (Score)**: +10 points per preferred capability the node has
3. **Load Balancing (Penalty)**: -0 to -40 points based on current node load
4. **GPU VRAM Bonus**: +5 points per GB of VRAM above minimum requirement
5. **Node Preference**: +20 points if `preferNode` matches this node

### Example Scoring

Node with RTX 4090 (24GB), Ollama, low load (10%):
- Base score: 50
- Required ["gpu", "ollama"]: +60 
- Preferred ["voice"] (missing): +0
- Load penalty (10%): -4
- **Final: 106 points**

Node with basic CPU, high load (90%):
- Base score: 50
- Required ["gpu", "ollama"] (missing): **DISQUALIFIED**
- **Final: 0 points**

## Testing Capability Routing

To test the routing with a specific capability requirement:

```bash
# Test spawn with Ollama requirement
infinibot mesh spawn --agent coder --task "Test Ollama routing" --required-capabilities ollama

# Test spawn with GPU requirement  
infinibot mesh spawn --agent coder --task "Test GPU routing" --required-capabilities gpu --min-gpu-vram 8

# Test spawn with multiple requirements
infinibot mesh spawn --agent coder --task "Test multi-capability routing" --required-capabilities gpu,ollama,voice
```

## Migration from Pattern-Based Routing

The new capability-based routing complements the existing pattern-based routing:

- **With capabilities**: Routes based on explicit requirements (precise)
- **Without capabilities**: Falls back to pattern analysis (smart defaults)

### Before
```typescript
// Had to manually specify target node
await mesh({
  action: "spawn",
  task: "Generate an image",
  node: "gpu-workstation",  // Manual routing
});
```

### After
```typescript
// Automatically finds the best GPU node
await mesh({
  action: "spawn",
  task: "Generate an image", 
  requiredCapabilities: ["gpu"],  // Automatic routing
  minGpuVRAM: 8,
});
```

## Node Setup

To advertise capabilities, nodes should be configured with:

```yaml
federation:
  capabilities:
    hasGPU: true
    gpuVRAM: 24
    hasOllama: true
    hasVoice: true
    hasComfyUI: true
    mcpServers: ["playwright", "file_manager"]
    ffmpeg:
      available: true
      hasNvenc: true
```

The capability router will automatically detect and score these capabilities when routing spawns.