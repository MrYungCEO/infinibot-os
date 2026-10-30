/**
 * Capability Router Tests
 *
 * Tests for capability-based auto-routing functionality.
 */

import { describe, it, expect } from "vitest";
import {
  getCapabilityRouter,
  parseCapabilityRequirements,
  type CapabilityRequirements,
} from "./capability-router.js";
import type { NodeManifest, NodeLoadMetrics } from "./types.js";

/**
 * Create a test node manifest.
 */
function createTestNode(
  id: string,
  name: string,
  overrides: Partial<NodeManifest> = {},
): NodeManifest {
  return {
    id,
    name,
    hostname: "test-host",
    port: 47913,
    workspace: "/workspace",
    isMaster: false,
    currentLoad: 0,
    activeSessions: 0,
    capabilities: {
      hasOllama: false,
      hasComfyUI: false,
      hasVoice: false,
      mcpServers: [],
      agents: ["coder"],
      workspaces: ["/workspace"],
    },
    ...overrides,
  };
}

describe("Capability Router", () => {
  describe("parseCapabilityRequirements", () => {
    it("should parse basic capability requirements", () => {
      const result = parseCapabilityRequirements({
        requiredCapabilities: ["gpu", "ollama"],
        preferredCapabilities: ["voice"],
        minGpuVRAM: 8,
      });

      expect(result.required).toEqual(["gpu", "ollama"]);
      expect(result.preferred).toEqual(["voice"]);
      expect(result.minGpuVRAM).toBe(8);
    });

    it("should handle empty requirements", () => {
      const result = parseCapabilityRequirements({});

      expect(result.required).toEqual([]);
      expect(result.preferred).toBeUndefined();
      expect(result.minGpuVRAM).toBeUndefined();
    });
  });

  describe("selectBestNode", () => {
    const router = getCapabilityRouter();

    it("should select node with required GPU capability", () => {
      const nodes: NodeManifest[] = [
        createTestNode("cpu-node", "CPU Node", {
          capabilities: {
            hasOllama: true,
            hasComfyUI: false,
            hasVoice: false,
            mcpServers: [],
            agents: ["coder"],
            workspaces: ["/workspace"],
          },
        }),
        createTestNode("gpu-node", "GPU Node", {
          capabilities: {
            hasOllama: false,
            hasComfyUI: true,
            hasVoice: false,
            gpu: "RTX 4090",
            gpuVRAM: 24,
            mcpServers: [],
            agents: ["coder"],
            workspaces: ["/workspace"],
          },
        }),
      ];

      const requirements: CapabilityRequirements = {
        required: ["gpu"],
      };

      const decision = router.selectBestNode(nodes, requirements);

      expect(decision.nodeId).toBe("gpu-node");
      expect(decision.confidence).toBeGreaterThan(0.8);
    });

    it("should select node with required Ollama capability", () => {
      const nodes: NodeManifest[] = [
        createTestNode("gpu-node", "GPU Node", {
          capabilities: {
            hasOllama: false,
            hasComfyUI: true,
            hasVoice: false,
            gpu: "RTX 4090",
            gpuVRAM: 24,
            mcpServers: [],
            agents: ["coder"],
            workspaces: ["/workspace"],
          },
        }),
        createTestNode("ollama-node", "Ollama Node", {
          capabilities: {
            hasOllama: true,
            ollamaModels: ["llama3", "codellama"],
            hasComfyUI: false,
            hasVoice: false,
            mcpServers: [],
            agents: ["coder"],
            workspaces: ["/workspace"],
          },
        }),
      ];

      const requirements: CapabilityRequirements = {
        required: ["ollama"],
      };

      const decision = router.selectBestNode(nodes, requirements);

      expect(decision.nodeId).toBe("ollama-node");
      expect(decision.confidence).toBeGreaterThan(0.8);
    });

    it("should select node with multiple required capabilities", () => {
      const nodes: NodeManifest[] = [
        createTestNode("partial-node", "Partial Node", {
          capabilities: {
            hasOllama: true,
            hasComfyUI: false,
            hasVoice: false,
            mcpServers: [],
            agents: ["coder"],
            workspaces: ["/workspace"],
          },
        }),
        createTestNode("full-node", "Full Node", {
          capabilities: {
            hasOllama: true,
            hasComfyUI: false,
            hasVoice: true,
            gpu: "RTX 4090",
            gpuVRAM: 24,
            mcpServers: ["playwright", "file_manager"],
            agents: ["coder"],
            workspaces: ["/workspace"],
          },
        }),
      ];

      const requirements: CapabilityRequirements = {
        required: ["ollama", "voice", "playwright"],
      };

      const decision = router.selectBestNode(nodes, requirements);

      expect(decision.nodeId).toBe("full-node");
      expect(decision.confidence).toBeGreaterThan(0.8);
    });

    it("should consider load balancing in scoring", () => {
      const nodes: NodeManifest[] = [
        createTestNode("busy-node", "Busy Node", {
          currentLoad: 90,
          capabilities: {
            hasOllama: true,
            hasComfyUI: false,
            hasVoice: false,
            mcpServers: [],
            agents: ["coder"],
            workspaces: ["/workspace"],
          },
        }),
        createTestNode("idle-node", "Idle Node", {
          currentLoad: 10,
          capabilities: {
            hasOllama: true,
            hasComfyUI: false,
            hasVoice: false,
            mcpServers: [],
            agents: ["coder"],
            workspaces: ["/workspace"],
          },
        }),
      ];

      const requirements: CapabilityRequirements = {
        required: ["ollama"],
      };

      const decision = router.selectBestNode(nodes, requirements);

      expect(decision.nodeId).toBe("idle-node");
      expect(decision.scoreBreakdown?.loadPenalty).toBeLessThan(0); // Should have some penalty
    });

    it("should return fallback when no nodes meet requirements", () => {
      const nodes: NodeManifest[] = [
        createTestNode("basic-node", "Basic Node", {
          capabilities: {
            hasOllama: false,
            hasComfyUI: false,
            hasVoice: false,
            mcpServers: [],
            agents: ["coder"],
            workspaces: ["/workspace"],
          },
        }),
      ];

      const requirements: CapabilityRequirements = {
        required: ["gpu", "ollama"],
      };

      const decision = router.selectBestNode(nodes, requirements);

      expect(decision.nodeId).toBe("basic-node");
      expect(decision.confidence).toBeLessThan(0.5);
      expect(decision.reason).toContain("fallback");
    });

    it("should prefer nodes with GPU VRAM above minimum", () => {
      const nodes: NodeManifest[] = [
        createTestNode("small-gpu", "Small GPU", {
          capabilities: {
            hasOllama: false,
            hasComfyUI: false,
            hasVoice: false,
            gpu: "RTX 3060",
            gpuVRAM: 8,
            mcpServers: [],
            agents: ["coder"],
            workspaces: ["/workspace"],
          },
        }),
        createTestNode("large-gpu", "Large GPU", {
          capabilities: {
            hasOllama: false,
            hasComfyUI: false,
            hasVoice: false,
            gpu: "RTX 4090",
            gpuVRAM: 24,
            mcpServers: [],
            agents: ["coder"],
            workspaces: ["/workspace"],
          },
        }),
      ];

      const requirements: CapabilityRequirements = {
        required: ["gpu"],
        minGpuVRAM: 12,
      };

      const decision = router.selectBestNode(nodes, requirements);

      expect(decision.nodeId).toBe("large-gpu");
      expect(decision.confidence).toBeGreaterThan(0.8);
    });

    it("should use enhanced resource metrics for load-based scoring", () => {
      const router = getCapabilityRouter();

      const nodes: NodeManifest[] = [
        createTestNode("high-cpu-node", "High CPU Node", {
          currentLoad: 30, // Low reported load
          capabilities: {
            hasOllama: true,
            hasComfyUI: false,
            hasVoice: false,
            mcpServers: [],
            agents: ["coder"],
            workspaces: ["/workspace"],
          },
        }),
        createTestNode("idle-node", "Idle Node", {
          currentLoad: 40, // Higher reported load
          capabilities: {
            hasOllama: true,
            hasComfyUI: false,
            hasVoice: false,
            mcpServers: [],
            agents: ["coder"],
            workspaces: ["/workspace"],
          },
        }),
      ];

      // Simulate detailed metrics showing first node is actually heavily loaded
      const highCpuMetrics: NodeLoadMetrics = {
        nodeId: "high-cpu-node",
        timestamp: Date.now(),
        cpuPercent: 95, // Very high CPU usage
        memoryPercent: 85, // High memory usage
        activeSessions: 8, // Many sessions
        pendingTasks: 3, // Queue backlog
        loadScore: 30, // This would be misleading without detailed metrics
      };

      const idleMetrics: NodeLoadMetrics = {
        nodeId: "idle-node",
        timestamp: Date.now(),
        cpuPercent: 15, // Low CPU usage
        memoryPercent: 35, // Moderate memory usage
        activeSessions: 1, // Few sessions
        pendingTasks: 0, // No queue
        loadScore: 40,
      };

      // Update router with detailed metrics
      router.updateNodeMetrics("high-cpu-node", highCpuMetrics);
      router.updateNodeMetrics("idle-node", idleMetrics);

      const requirements: CapabilityRequirements = {
        required: ["ollama"],
      };

      const decision = router.selectBestNode(nodes, requirements);

      // Should prefer the actually idle node despite higher reported load
      expect(decision.nodeId).toBe("idle-node");
      expect(decision.confidence).toBeGreaterThan(0.7);

      // Check that resource breakdown is included
      expect(decision.scoreBreakdown).toBeDefined();
      expect(decision.scoreBreakdown?.loadPenalty).toBeLessThan(0); // Should have some penalty
    });

    it("should penalize GPU-loaded nodes for GPU tasks", () => {
      const router = getCapabilityRouter();

      const nodes: NodeManifest[] = [
        createTestNode("busy-gpu", "Busy GPU", {
          capabilities: {
            hasOllama: false,
            hasComfyUI: true,
            hasVoice: false,
            gpu: "RTX 4090",
            gpuVRAM: 24,
            mcpServers: [],
            agents: ["coder"],
            workspaces: ["/workspace"],
          },
        }),
        createTestNode("idle-gpu", "Idle GPU", {
          capabilities: {
            hasOllama: false,
            hasComfyUI: true,
            hasVoice: false,
            gpu: "RTX 4090",
            gpuVRAM: 24,
            mcpServers: [],
            agents: ["coder"],
            workspaces: ["/workspace"],
          },
        }),
      ];

      // One GPU is heavily loaded
      const busyGpuMetrics: NodeLoadMetrics = {
        nodeId: "busy-gpu",
        timestamp: Date.now(),
        cpuPercent: 40,
        memoryPercent: 50,
        gpuPercent: 95, // GPU heavily loaded
        gpuMemoryPercent: 90, // GPU memory almost full
        activeSessions: 2,
        pendingTasks: 1,
        loadScore: 50,
      };

      // Other GPU is idle
      const idleGpuMetrics: NodeLoadMetrics = {
        nodeId: "idle-gpu",
        timestamp: Date.now(),
        cpuPercent: 20,
        memoryPercent: 30,
        gpuPercent: 5, // GPU barely used
        gpuMemoryPercent: 10, // GPU memory available
        activeSessions: 0,
        pendingTasks: 0,
        loadScore: 25,
      };

      router.updateNodeMetrics("busy-gpu", busyGpuMetrics);
      router.updateNodeMetrics("idle-gpu", idleGpuMetrics);

      const requirements: CapabilityRequirements = {
        required: ["gpu"],
        minGpuVRAM: 16,
      };

      const decision = router.selectBestNode(nodes, requirements);

      // Should prefer idle GPU for GPU task
      expect(decision.nodeId).toBe("idle-gpu");
      expect(decision.confidence).toBeGreaterThan(0.8);
    });
  });
});
