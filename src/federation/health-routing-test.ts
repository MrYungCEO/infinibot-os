/**
 * Health-Based Routing Test
 *
 * Simple test to verify health tracking and routing integration.
 */

import { getHealthTracker, initHealthTracker } from "./health-tracker.js";
import { getCapabilityRouter } from "./capability-router.js";
import type { NodeManifest, CapabilityRequirements } from "./types.js";

/**
 * Test health-based routing by simulating node health changes.
 */
export async function testHealthBasedRouting(): Promise<void> {
  console.log("🏥 Testing Health-Based Routing");

  // Initialize health tracker with aggressive quarantine settings for testing
  const healthTracker = initHealthTracker({
    quarantineThreshold: 30, // Quarantine below 30% health
    unquarantineThreshold: 60, // Unquarantine above 60% health
    trackingWindowMs: 5 * 60 * 1000, // 5 minutes tracking window
    maxErrorRate: 5, // 5% error rate threshold
    maxLatencyMs: 2000, // 2 second latency threshold
    maxMissedHeartbeats: 10, // 10% missed heartbeats threshold
  });

  // Create test nodes
  const nodeA: NodeManifest = {
    id: "test-node-a",
    name: "Test Node A",
    hostname: "node-a.test",
    port: 47913,
    workspace: "/tmp/workspace-a",
    capabilities: {
      hasOllama: true,
      ollamaModels: ["llama3", "qwen2.5"],
      hasComfyUI: false,
      hasVoice: false,
      gpu: "RTX 4090",
      gpuVRAM: 24,
      systemRAM: 32,
      mcpServers: ["github", "filesystem"],
      agents: ["coder", "research"],
      workspaces: ["/tmp/workspace-a"],
      platform: "linux",
      arch: "x64",
    },
    isMaster: false,
  };

  const nodeB: NodeManifest = {
    id: "test-node-b",
    name: "Test Node B",
    hostname: "node-b.test",
    port: 47913,
    workspace: "/tmp/workspace-b",
    capabilities: {
      hasOllama: true,
      ollamaModels: ["llama3"],
      hasComfyUI: false,
      hasVoice: false,
      gpu: "RTX 3070",
      gpuVRAM: 8,
      systemRAM: 16,
      mcpServers: ["filesystem"],
      agents: ["coder"],
      workspaces: ["/tmp/workspace-b"],
      platform: "linux",
      arch: "x64",
    },
    isMaster: false,
  };

  // Add nodes to health tracker
  healthTracker.addNode(nodeA.id);
  healthTracker.addNode(nodeB.id);

  console.log("✅ Added nodes to health tracker");

  // Initial routing decision (both nodes healthy)
  const capabilityRouter = getCapabilityRouter();
  const requirements: CapabilityRequirements = {
    required: ["ollama", "gpu"],
    preferred: [],
    minGpuVRAM: 8,
  };

  console.log("\n🔀 Initial routing (both nodes healthy):");
  let decision = capabilityRouter.selectBestNode([nodeA, nodeB], requirements);
  console.log(`Selected: ${decision.nodeName} (confidence: ${decision.confidence})`);
  console.log(`Reason: ${decision.reason}`);

  // Simulate errors on Node A to degrade its health
  console.log("\n❌ Simulating errors on Node A:");
  for (let i = 0; i < 10; i++) {
    healthTracker.recordError(nodeA.id, "connection error");
  }

  // Simulate high latency on Node A
  for (let i = 0; i < 5; i++) {
    healthTracker.recordLatency(nodeA.id, 5000); // 5 second latency
  }

  // Simulate missed heartbeats
  for (let i = 0; i < 5; i++) {
    healthTracker.recordHeartbeat(nodeA.id, false);
  }

  // Check Node A health
  const nodeAHealth = healthTracker.getHealthScore(nodeA.id);
  console.log(`Node A health: ${nodeAHealth?.overall}% (${nodeAHealth?.reason})`);
  console.log(`Quarantined: ${healthTracker.isQuarantined(nodeA.id)}`);

  // Route again after health degradation
  console.log("\n🔀 Routing after Node A health degradation:");
  decision = capabilityRouter.selectBestNode([nodeA, nodeB], requirements);
  console.log(`Selected: ${decision.nodeName} (confidence: ${decision.confidence})`);
  console.log(`Reason: ${decision.reason}`);

  if (decision.scoreBreakdown) {
    console.log("Score breakdown:");
    console.log(`  Base: ${decision.scoreBreakdown.baseScore}`);
    console.log(`  GPU: ${decision.scoreBreakdown.gpuBonus}`);
    console.log(`  Load: ${decision.scoreBreakdown.loadPenalty}`);
    console.log(`  Health: ${decision.scoreBreakdown.healthBonus}`);
    console.log(`  Final: ${decision.scoreBreakdown.finalScore}`);
  }

  // Simulate Node A recovery with successful requests
  console.log("\n✅ Simulating Node A recovery:");
  for (let i = 0; i < 20; i++) {
    healthTracker.recordLatency(nodeA.id, 100); // Fast response
    healthTracker.recordHeartbeat(nodeA.id, true); // Successful heartbeat
  }

  // Check recovered health
  const nodeARecoveredHealth = healthTracker.getHealthScore(nodeA.id);
  console.log(
    `Node A recovered health: ${nodeARecoveredHealth?.overall}% (${nodeARecoveredHealth?.reason})`,
  );
  console.log(`Quarantined: ${healthTracker.isQuarantined(nodeA.id)}`);

  // Final routing decision
  console.log("\n🔀 Final routing after Node A recovery:");
  decision = capabilityRouter.selectBestNode([nodeA, nodeB], requirements);
  console.log(`Selected: ${decision.nodeName} (confidence: ${decision.confidence})`);
  console.log(`Reason: ${decision.reason}`);

  // Health summary
  console.log("\n📊 Health Summary:");
  const summary = healthTracker.getHealthSummary();
  console.log(`Total nodes: ${summary.totalNodes}`);
  console.log(`Healthy nodes: ${summary.healthyNodes}`);
  console.log(`Quarantined nodes: ${summary.quarantinedNodes}`);
  console.log(`Average health: ${Math.round(summary.averageHealth)}%`);

  for (const nodeScore of summary.nodeScores) {
    console.log(
      `  ${nodeScore.nodeId}: ${nodeScore.score}% ${nodeScore.quarantined ? "(QUARANTINED)" : ""}`,
    );
  }

  console.log("\n🎉 Health-based routing test completed!");
}

/**
 * Test quarantine functionality.
 */
export async function testQuarantine(): Promise<void> {
  console.log("\n🚫 Testing Quarantine Functionality");

  const healthTracker = getHealthTracker();
  const testNodeId = "quarantine-test-node";

  healthTracker.addNode(testNodeId);

  // Force quarantine with many errors
  console.log("Forcing quarantine with many errors...");
  for (let i = 0; i < 50; i++) {
    healthTracker.recordError(testNodeId, "critical error");
  }

  const healthAfterErrors = healthTracker.getHealthScore(testNodeId);
  console.log(`Health after errors: ${healthAfterErrors?.overall}%`);
  console.log(`Quarantined: ${healthTracker.isQuarantined(testNodeId)}`);

  // Test manual override
  console.log("\nTesting manual override (force healthy)...");
  healthTracker.setManualOverride(testNodeId, "healthy");
  console.log(`Quarantined after override: ${healthTracker.isQuarantined(testNodeId)}`);

  // Remove override
  console.log("Removing manual override...");
  healthTracker.setManualOverride(testNodeId, null);
  console.log(`Quarantined after removing override: ${healthTracker.isQuarantined(testNodeId)}`);

  console.log("✅ Quarantine test completed!");
}

// Run tests if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  void (async () => {
    try {
      await testHealthBasedRouting();
      await testQuarantine();
      process.exit(0);
    } catch (error) {
      console.error("Test failed:", error);
      process.exit(1);
    }
  })();
}
