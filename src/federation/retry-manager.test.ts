/**
 * Tests for the RetryManager
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { RetryManager } from "./retry-manager.js";
import type { SessionSpawnRequest, SessionHandle, NodeManifest } from "./types.js";

describe("RetryManager", () => {
  let mockSpawnFunction: ReturnType<typeof vi.fn>;
  let mockNodeSelector: ReturnType<typeof vi.fn>;
  let retryManager: RetryManager;

  const mockRequest: SessionSpawnRequest = {
    nodeId: "node1",
    agentId: "test-agent",
    task: "test task",
    workspace: "/test",
  };

  const mockSuccessResult: SessionHandle = {
    nodeId: "node1",
    sessionKey: "session123",
    runId: "run123",
  };

  const mockNodes: NodeManifest[] = [
    {
      id: "node1",
      name: "Node 1",
      hostname: "node1.test",
      port: 47913,
      capabilities: {
        hasOllama: false,
        hasComfyUI: false,
        hasVoice: false,
        mcpServers: [],
        agents: [],
        workspaces: [],
      },
      version: "1.0.0",
      protocolVersion: 1,
    },
    {
      id: "node2",
      name: "Node 2",
      hostname: "node2.test",
      port: 47913,
      capabilities: {
        hasOllama: false,
        hasComfyUI: false,
        hasVoice: false,
        mcpServers: [],
        agents: [],
        workspaces: [],
      },
      version: "1.0.0",
      protocolVersion: 1,
    },
  ];

  beforeEach(() => {
    mockSpawnFunction = vi.fn();
    mockNodeSelector = vi.fn().mockReturnValue(mockNodes);
    retryManager = new RetryManager(mockSpawnFunction, mockNodeSelector, {
      maxRetries: 2,
      initialDelayMs: 10, // Fast for testing
      maxDelayMs: 100,
      backoffMultiplier: 2,
    });
  });

  afterEach(() => {
    retryManager.destroy();
  });

  it("should succeed on first attempt", async () => {
    mockSpawnFunction.mockResolvedValueOnce(mockSuccessResult);

    const result = await retryManager.executeWithRetry(mockRequest);

    expect(result).toEqual(mockSuccessResult);
    expect(mockSpawnFunction).toHaveBeenCalledTimes(1);
    expect(mockSpawnFunction).toHaveBeenCalledWith(mockRequest);
  });

  it("should retry on connection timeout", async () => {
    const timeoutError = new Error("Request timeout");
    mockSpawnFunction.mockRejectedValueOnce(timeoutError).mockResolvedValueOnce(mockSuccessResult);

    const result = await retryManager.executeWithRetry(mockRequest);

    expect(result).toEqual(mockSuccessResult);
    expect(mockSpawnFunction).toHaveBeenCalledTimes(2);
  });

  it("should retry with different node when node disconnected", async () => {
    const disconnectedError = new Error("Node not connected");
    mockSpawnFunction
      .mockRejectedValueOnce(disconnectedError)
      .mockResolvedValueOnce(mockSuccessResult);

    // Should exclude the original node and use a different one
    mockNodeSelector.mockReturnValue([mockNodes[1]]);

    const result = await retryManager.executeWithRetry(mockRequest);

    expect(result).toEqual(mockSuccessResult);
    expect(mockSpawnFunction).toHaveBeenCalledTimes(2);

    // Second call should use the alternate node
    expect(mockSpawnFunction).toHaveBeenNthCalledWith(2, {
      ...mockRequest,
      nodeId: "node2",
    });
  });

  it("should not retry on agent spawn errors", async () => {
    const agentError = new Error("Agent not found");
    mockSpawnFunction.mockRejectedValueOnce(agentError);

    await expect(retryManager.executeWithRetry(mockRequest)).rejects.toThrow("Agent not found");
    expect(mockSpawnFunction).toHaveBeenCalledTimes(1);
  });

  it("should fail after max retries", async () => {
    const timeoutError = new Error("Request timeout");
    mockSpawnFunction.mockRejectedValue(timeoutError);

    await expect(retryManager.executeWithRetry(mockRequest)).rejects.toThrow(
      /Failed after.*retry attempts/,
    );
    expect(mockSpawnFunction).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  }, 10000); // Allow time for retries

  it("should fail when no nodes available for retry", async () => {
    const disconnectedError = new Error("Node not connected");
    mockSpawnFunction.mockRejectedValueOnce(disconnectedError);
    mockNodeSelector.mockReturnValue([]); // No nodes available

    await expect(retryManager.executeWithRetry(mockRequest)).rejects.toThrow(
      "No available nodes for retry",
    );
  });

  it("should provide retry status information", async () => {
    const timeoutError = new Error("Request timeout");
    mockSpawnFunction.mockRejectedValue(timeoutError);

    // Start a retry operation but don't await it
    const retryPromise = retryManager.executeWithRetry(mockRequest);

    // Wait a bit for the retry to be queued
    await new Promise((resolve) => setTimeout(resolve, 50));

    const status = retryManager.getRetryStatus();
    expect(status.queueSize).toBeGreaterThan(0);
    expect(status.entries).toHaveLength(1);
    expect(status.entries[0].originalNodeId).toBe("node1");
    expect(status.entries[0].failureType).toBe("connection_timeout");

    // Clean up
    await expect(retryPromise).rejects.toThrow();
  }, 10000);
});
