/**
 * Tests for Compute Router
 */

import { describe, expect, it, beforeEach } from "vitest";

import { ComputeRouter, inferTaskType } from "./router.js";
import type { NodeManifest, Task } from "./types.js";

describe("compute-router", () => {
  describe("inferTaskType", () => {
    it("detects image generation tasks", () => {
      expect(inferTaskType("generate an image of a cat")).toBe("image_gen");
      expect(inferTaskType("create a picture of sunset")).toBe("image_gen");
      expect(inferTaskType("use stable diffusion to render art")).toBe("image_gen");
      expect(inferTaskType("run comfyui workflow")).toBe("image_gen");
    });

    it("detects voice tasks", () => {
      expect(inferTaskType("speak this message aloud")).toBe("voice");
      expect(inferTaskType("convert to TTS")).toBe("voice");
      expect(inferTaskType("use elevenlabs to narrate")).toBe("voice");
    });

    it("detects Ollama/LLM tasks", () => {
      expect(inferTaskType("run llama3 locally")).toBe("ollama_inference");
      expect(inferTaskType("use ollama for inference")).toBe("ollama_inference");
      expect(inferTaskType("run mistral model")).toBe("ollama_inference");
    });

    it("detects code tasks", () => {
      expect(inferTaskType("implement a function")).toBe("code");
      expect(inferTaskType("fix this bug")).toBe("code");
      expect(inferTaskType("refactor the module")).toBe("code");
    });

    it("detects browser tasks", () => {
      expect(inferTaskType("browse to this URL")).toBe("browser");
      expect(inferTaskType("open the web page")).toBe("browser");
    });

    it("returns unknown for general tasks", () => {
      expect(inferTaskType("hello world")).toBe("unknown");
      expect(inferTaskType("what time is it")).toBe("unknown");
    });
  });

  describe("ComputeRouter", () => {
    let router: ComputeRouter;

    beforeEach(() => {
      router = new ComputeRouter({ masterId: "master", localNodeId: "local" });
    });

    it("registers and retrieves nodes", () => {
      const manifest: NodeManifest = {
        id: "node1",
        name: "Test Node",
        hostname: "test.local",
        port: 47913,
        workspace: "/home/test",
        capabilities: {
          hasOllama: true,
          hasComfyUI: false,
          hasVoice: false,
          gpu: "RTX 4090",
          gpuVRAM: 24,
          systemRAM: 64,
          mcpServers: [],
          agents: ["ash"],
          workspaces: ["/home/test"],
        },
        isMaster: false,
      };

      router.registerNode(manifest);
      const retrieved = router.getNode("node1");
      expect(retrieved).toBeDefined();
      expect(retrieved?.name).toBe("Test Node");
    });

    it("analyzes task requirements", () => {
      const task: Task = {
        id: "test1",
        type: "image_gen",
        description: "generate an image using stable diffusion xl",
      };

      const requirements = router.analyzeTaskRequirements(task);
      expect(requirements.needsGPU).toBe(true);
      expect(requirements.gpuVRAM).toBeGreaterThan(0);
    });

    it("selectByLoad returns a selection", () => {
      const manifest: NodeManifest = {
        id: "node1",
        name: "Test Node",
        hostname: "test.local",
        port: 47913,
        workspace: "/home/test",
        capabilities: {
          hasOllama: false,
          hasComfyUI: false,
          hasVoice: false,
          mcpServers: [],
          agents: [],
          workspaces: [],
        },
        isMaster: false,
        currentLoad: 20,
      };

      router.registerNode(manifest);
      const selection = router.selectByLoad();
      expect(selection.nodeId).toBeDefined();
      expect(selection.reason).toBeDefined();
    });

    it("selectByGPU finds GPU nodes", () => {
      const manifest: NodeManifest = {
        id: "gpu-node",
        name: "GPU Node",
        hostname: "gpu.local",
        port: 47913,
        workspace: "/home/gpu",
        capabilities: {
          hasOllama: false,
          hasComfyUI: true,
          hasVoice: false,
          gpu: "RTX 5090",
          gpuVRAM: 32,
          mcpServers: [],
          agents: [],
          workspaces: [],
        },
        isMaster: true,
      };

      router.registerNode(manifest);
      const selection = router.selectByGPU(24);
      expect(selection).not.toBeNull();
      expect(selection?.nodeId).toBe("gpu-node");
    });

    it("selectByWorkspace finds nodes with matching workspace", () => {
      const manifest: NodeManifest = {
        id: "work-node",
        name: "Work Node",
        hostname: "work.local",
        port: 47913,
        workspace: "/home/user/projects",
        capabilities: {
          hasOllama: false,
          hasComfyUI: false,
          hasVoice: false,
          mcpServers: [],
          agents: [],
          workspaces: ["/home/user/projects", "/home/user/code"],
        },
        isMaster: false,
      };

      router.registerNode(manifest);
      const selection = router.selectByWorkspace("/home/user/projects/myapp");
      expect(selection).not.toBeNull();
      expect(selection?.nodeId).toBe("work-node");
    });
  });
});
