/**
 * Tests for Message Delivery Manager
 *
 * Tests the delivery guarantee system with ACKs, retries, and deduplication.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageDeliveryManager, GUARANTEED_MESSAGE_TYPES } from "./delivery-manager.js";
import type { FederationMessage } from "./types.js";

describe("MessageDeliveryManager", () => {
  let manager: MessageDeliveryManager;
  let sendMessages: FederationMessage[] = [];
  let sendErrors: string[] = [];

  const mockSendFn = vi.fn(async (message: FederationMessage) => {
    sendMessages.push(message);

    // Simulate random failures
    if (sendErrors.length > 0) {
      const error = sendErrors.shift();
      throw new Error(error || "Send failed");
    }
  });

  beforeEach(() => {
    sendMessages = [];
    sendErrors = [];
    manager = new MessageDeliveryManager({
      ackTimeout: 1000, // 1 second for faster testing
      maxRetries: 2,
      retryDelay: 100, // 100ms for faster testing
      persistPath: null,
    });
    mockSendFn.mockClear();
  });

  afterEach(() => {
    manager.shutdown();
  });

  describe("Message Type Filtering", () => {
    it("should track guaranteed message types", () => {
      const guaranteedMessage: FederationMessage = {
        type: "session.spawn",
        payload: { test: "data" },
        nodeId: "test-node",
        timestamp: Date.now(),
      };

      const messageId = manager.sendMessage(guaranteedMessage, "target-node", mockSendFn);

      expect(messageId).toBeDefined();
      expect(guaranteedMessage.messageId).toBe(messageId);
      expect(manager.getStats().pendingMessages).toBe(1);
    });

    it("should not track non-guaranteed message types", () => {
      const nonGuaranteedMessage: FederationMessage = {
        type: "node.heartbeat",
        payload: { timestamp: Date.now() },
        nodeId: "test-node",
        timestamp: Date.now(),
      };

      manager.sendMessage(nonGuaranteedMessage, "target-node", mockSendFn);

      expect(manager.getStats().pendingMessages).toBe(0);
    });
  });

  describe("ACK Handling", () => {
    it("should handle successful ACK", async () => {
      const message: FederationMessage = {
        type: "session.spawn",
        payload: { test: "data" },
        nodeId: "test-node",
        timestamp: Date.now(),
      };

      let successCalled = false;
      const messageId = manager.sendMessage(message, "target-node", mockSendFn, {
        onSuccess: () => {
          successCalled = true;
        },
      });

      expect(manager.getStats().pendingMessages).toBe(1);

      // Simulate receiving ACK
      manager.handleAck(messageId);

      expect(manager.getStats().pendingMessages).toBe(0);
      expect(successCalled).toBe(true);
    });

    it("should persist pending messages and replay them after restart", async () => {
      const persistPath = join(mkdtempSync(join(tmpdir(), "delivery-manager-")), "state.json");
      const message: FederationMessage = {
        type: "session.spawn",
        payload: { test: "data" },
        nodeId: "test-node",
        timestamp: Date.now(),
      };

      const firstManager = new MessageDeliveryManager({
        ackTimeout: 10_000,
        maxRetries: 2,
        retryDelay: 100,
        persistPath,
      });
      const messageId = firstManager.sendMessage(message, "target-node", mockSendFn);
      await Promise.resolve();
      firstManager.shutdown();

      const replaySend = vi.fn(async (_message: FederationMessage) => {});
      const restoredManager = new MessageDeliveryManager({
        ackTimeout: 10_000,
        maxRetries: 2,
        retryDelay: 100,
        persistPath,
      });

      expect(restoredManager.getStats().pendingMessages).toBe(1);
      expect(restoredManager.retryPendingForTarget("target-node", replaySend)).toBe(1);
      await Promise.resolve();
      expect(replaySend).toHaveBeenCalledTimes(1);

      restoredManager.handleAck(messageId);
      expect(restoredManager.getStats().pendingMessages).toBe(0);
      restoredManager.shutdown();
    });

    it("should handle timeout and retry", async () => {
      sendErrors.push("Network error"); // First send will fail

      const message: FederationMessage = {
        type: "session.complete",
        payload: { test: "data" },
        nodeId: "test-node",
        timestamp: Date.now(),
      };

      let failureCalled = false;
      manager.sendMessage(message, "target-node", mockSendFn, {
        onFailure: () => {
          failureCalled = true;
        },
      });

      expect(manager.getStats().pendingMessages).toBe(1);

      // Wait for timeout and retry attempts
      await new Promise((resolve) => setTimeout(resolve, 1500));

      expect(manager.getStats().pendingMessages).toBe(0);
      expect(failureCalled).toBe(true);
    });
  });

  describe("Deduplication", () => {
    it("should detect and reject duplicates", () => {
      const messageId = "test-message-123";
      const senderId = "sender-node";

      // First message should not be duplicate
      expect(manager.isDuplicate(messageId, senderId)).toBe(false);

      // Second message with same ID should be duplicate
      expect(manager.isDuplicate(messageId, senderId)).toBe(true);
    });

    it("should handle different senders separately", () => {
      const messageId = "test-message-123";
      const senderA = "sender-a";
      const senderB = "sender-b";

      expect(manager.isDuplicate(messageId, senderA)).toBe(false);
      expect(manager.isDuplicate(messageId, senderB)).toBe(false);

      // Now both should be duplicates for their respective senders
      expect(manager.isDuplicate(messageId, senderA)).toBe(true);
      expect(manager.isDuplicate(messageId, senderB)).toBe(true);
    });

    it("should clean up old deduplication entries", () => {
      const messageId = "old-message";
      const senderId = "sender-node";

      manager.isDuplicate(messageId, senderId);

      expect(manager.getStats().cacheSize).toBeGreaterThan(0);

      // Clean with very short age (everything should be removed)
      manager.cleanupDeduplication(1); // 1ms

      // Give it a moment to exceed the age
      setTimeout(() => {
        manager.cleanupDeduplication(1);
        expect(manager.getStats().cacheSize).toBe(0);
      }, 5);
    });
  });

  describe("Statistics", () => {
    it("should track pending messages by type", () => {
      const spawnMessage: FederationMessage = {
        type: "session.spawn",
        payload: {},
        nodeId: "test",
        timestamp: Date.now(),
      };

      const completeMessage: FederationMessage = {
        type: "session.complete",
        payload: {},
        nodeId: "test",
        timestamp: Date.now(),
      };

      manager.sendMessage(spawnMessage, "target", mockSendFn);
      manager.sendMessage(completeMessage, "target", mockSendFn);

      const stats = manager.getStats();
      expect(stats.pendingMessages).toBe(2);
      expect(stats.pendingByType["session.spawn"]).toBe(1);
      expect(stats.pendingByType["session.complete"]).toBe(1);
    });
  });

  describe("Guaranteed Message Types", () => {
    it("should include critical message types", () => {
      expect(GUARANTEED_MESSAGE_TYPES.has("session.spawn")).toBe(true);
      expect(GUARANTEED_MESSAGE_TYPES.has("session.complete")).toBe(true);
      expect(GUARANTEED_MESSAGE_TYPES.has("identity.sync")).toBe(true);
      expect(GUARANTEED_MESSAGE_TYPES.has("mcp.invoke")).toBe(true);
    });

    it("should exclude non-critical message types", () => {
      expect(GUARANTEED_MESSAGE_TYPES.has("node.heartbeat")).toBe(false);
      expect(GUARANTEED_MESSAGE_TYPES.has("node.register")).toBe(false);
      expect(GUARANTEED_MESSAGE_TYPES.has("state.sync")).toBe(false);
    });
  });
});

/**
 * Integration Test for Hub-Satellite Delivery
 *
 * This test simulates a complete message delivery scenario
 * with network delays and verifies end-to-end delivery.
 */
describe("End-to-End Delivery Test", () => {
  it("should deliver messages with simulated network conditions", async () => {
    const hubManager = new MessageDeliveryManager({ persistPath: null });
    const satelliteManager = new MessageDeliveryManager({ persistPath: null });

    let messagesReceived: FederationMessage[] = [];
    let acksReceived: string[] = [];

    // Simulate hub sending to satellite with network delay
    const simulateHubToSatellite = async (message: FederationMessage) => {
      // Simulate network delay
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Check for duplicates on satellite side
      if (satelliteManager.isDuplicate(message.messageId!, "hub")) {
        return; // Drop duplicate
      }

      messagesReceived.push(message);

      // Send ACK back to hub (with delay)
      setTimeout(() => {
        acksReceived.push(message.messageId!);
        hubManager.handleAck(message.messageId!);
      }, 25);
    };

    const message: FederationMessage = {
      type: "session.spawn",
      payload: { agentId: "test-agent", task: "test task" },
      nodeId: "hub",
      timestamp: Date.now(),
    };

    let deliverySuccess = false;
    hubManager.sendMessage(message, "satellite", simulateHubToSatellite, {
      onSuccess: () => {
        deliverySuccess = true;
      },
      onFailure: (id, error) => {
        console.error("Delivery failed:", id, error);
      },
    });

    // Wait for delivery to complete
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(messagesReceived).toHaveLength(1);
    expect(acksReceived).toHaveLength(1);
    expect(deliverySuccess).toBe(true);

    hubManager.shutdown();
    satelliteManager.shutdown();
  });
});
