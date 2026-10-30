# Capability-Based Auto-Routing

This feature automatically routes spawns to the best node based on required capabilities, complementing the existing pattern-based routing with precise capability matching.

## 🎯 Overview

The capability-based auto-routing system allows spawns to specify explicit capability requirements, and the system will automatically route them to the most suitable node in the federation based on:

- **Hard requirements**: Node MUST have these capabilities (filter)
- **Soft preferences**: Node SHOULD have these capabilities (score bonus)
- **Load balancing**: Prefer nodes with lower CPU/memory load  
- **GPU specifications**: Consider VRAM requirements for GPU tasks
- **Node locality**: Prefer nodes with required workspace/files

## 🏗️ Architecture

### Core Components

1. **`capability-router.ts`** - Core routing logic with scoring algorithm
2. **`types.ts`** - Extended federation types for capability requirements  
3. **`sessions-spawn-tool.ts`** - Updated spawn tool with capability parameters
4. **`hub.ts`** - Integrated capability routing into federation hub
5. **`agent-tools.ts`** - Updated remote spawn functions

### Routing Flow

```
Spawn Request 
    ↓
Parse Capabilities
    ↓
Get Available Nodes
    ↓
Score Each Node ← Capability Router
    ↓
Select Best Node
    ↓
Route Spawn
```

## 🛠️ Implementation

### New Parameters

The `sessions_spawn` tool now accepts these optional parameters:

```typescript
{
  // Existing parameters...
  task: string,
  agentId?: string,
  model?: string,
  
  // NEW: Capability-based routing
  requiredCapabilities?: string[],    // Hard requirements
  preferredCapabilities?: string[],   // Soft preferences  
  minGpuVRAM?: number,               // Minimum GPU memory
}
```

### Capability Types

**Standard capabilities:**
- `gpu` - GPU acceleration (image gen, ML inference)
- `ollama` - Ollama LLM server for local inference
- `voice` - Voice/audio processing (TTS, STT)
- `comfyui` - ComfyUI for advanced image generation
- `ffmpeg` - Video/audio processing
- `workspace` - Specific workspace access

**Custom capabilities:**
- Any MCP server name (e.g., `playwright`, `file_manager`)

### Scoring Algorithm

The router scores each node using this algorithm:

1. **Base Score**: 50 points
2. **Hard Requirements**: +30 points each (or disqualification if missing)
3. **Soft Preferences**: +10 points each if node has the capability
4. **Load Penalty**: -0 to -40 points based on current load percentage
5. **Node Preference**: +20 points if explicitly preferred
6. **GPU VRAM Bonus**: +5 points per GB above minimum requirement

**Example:**
```
Node: RTX 4090 (24GB), Ollama, 15% load
Required: ["gpu", "ollama"] 
Preferred: ["voice"]
Min VRAM: 8GB

Score = 50 (base) + 60 (requirements) + 0 (no voice) - 6 (load) + 80 (16GB extra) = 184 points
```

## 📋 Usage Examples

### Basic GPU Routing
```typescript
mesh({
  action: "spawn",
  task: "Generate a landscape image",
  requiredCapabilities: ["gpu", "comfyui"],
  minGpuVRAM: 8,
})
```

### Ollama Routing  
```typescript
mesh({
  action: "spawn", 
  task: "Analyze code with local LLM",
  requiredCapabilities: ["ollama"],
  preferredCapabilities: ["gpu"], // GPU acceleration if available
})
```

### Multi-Capability Routing
```typescript
mesh({
  action: "spawn",
  task: "Create narrated video with graphics", 
  requiredCapabilities: ["gpu", "voice", "ffmpeg"],
  preferredCapabilities: ["comfyui"],
  minGpuVRAM: 12,
})
```

### MCP Server Routing
```typescript
mesh({
  action: "spawn",
  task: "Automate browser testing",
  requiredCapabilities: ["playwright"],
  preferredCapabilities: ["ffmpeg"], // For test recordings
})
```

## 🔧 Configuration

Nodes advertise their capabilities in the federation manifest:

```yaml
federation:
  capabilities:
    hasGPU: true
    gpu: "RTX 4090" 
    gpuVRAM: 24
    hasOllama: true
    ollamaModels: ["llama3", "codellama"]
    hasVoice: true
    hasComfyUI: true
    mcpServers: ["playwright", "file_manager", "docker"]
    ffmpeg:
      available: true
      hasNvenc: true
      hasCuda: true
```

## 🧪 Testing

Run the test suite:

```bash
npm test src/federation/capability-router.test.ts
```

Test capability routing manually:

```bash
# Test GPU routing
infinibot sessions spawn --task "Test GPU" --required-capabilities gpu

# Test Ollama routing  
infinibot sessions spawn --task "Test Ollama" --required-capabilities ollama

# Test multi-capability routing
infinibot sessions spawn --task "Test Multi" --required-capabilities gpu,ollama,voice --min-gpu-vram 8
```

## 🔄 Migration & Compatibility  

The capability-based routing is **fully backward compatible**:

- **With capabilities**: Uses precise capability matching
- **Without capabilities**: Falls back to existing pattern-based routing
- **Explicit node**: Still works (`node` parameter overrides auto-routing)

### Gradual Adoption

1. **Phase 1**: Deploy capability router (no breaking changes)
2. **Phase 2**: Add `requiredCapabilities` to critical spawns
3. **Phase 3**: Configure all nodes with detailed capabilities
4. **Phase 4**: Optimize based on routing analytics

## 📊 Routing Decision Transparency

The router provides detailed decision information:

```typescript
{
  nodeId: "gpu-workstation",
  nodeName: "GPU Workstation", 
  confidence: 0.89,
  reason: "184 pts (+60 capabilities, -6 load, +80 VRAM)",
  alternativeNodes: [
    { nodeId: "cpu-server", score: 45, missingCapabilities: ["gpu"] }
  ],
  requirements: { needsGPU: true, needsOllama: true },
  scoreBreakdown: {
    baseScore: 50,
    requirementBonus: 60, 
    loadPenalty: -6,
    gpuBonus: 80,
    finalScore: 184
  }
}
```

## 🚀 Benefits

1. **Precise Routing**: Route to nodes with exactly the right capabilities
2. **Load Balancing**: Automatically avoid overloaded nodes
3. **Resource Optimization**: Match workloads to optimal hardware
4. **Fault Tolerance**: Fallback to alternative nodes when preferred unavailable
5. **Transparency**: Detailed reasoning for every routing decision
6. **Zero Migration**: Works alongside existing routing without changes

## 📁 Files Created/Modified

### New Files
- `src/federation/capability-router.ts` - Core capability routing logic
- `src/federation/capability-router.test.ts` - Test suite
- `examples/capability-routing-example.md` - Usage examples
- `src/federation/CAPABILITY_ROUTING.md` - This documentation

### Modified Files  
- `src/federation/types.ts` - Added capability types and interfaces
- `src/federation/hub.ts` - Added capability routing integration
- `src/agents/tools/sessions-spawn-tool.ts` - Added capability parameters
- `src/federation/agent-tools.ts` - Updated remote spawn functions

## 🔮 Future Enhancements

- **Dynamic Capability Discovery**: Auto-detect node capabilities
- **Capability Caching**: Cache capability evaluations for performance
- **Advanced Scoring**: ML-based scoring for complex workloads
- **Capability Monitoring**: Real-time capability health checks
- **Cost-Aware Routing**: Consider compute costs in routing decisions