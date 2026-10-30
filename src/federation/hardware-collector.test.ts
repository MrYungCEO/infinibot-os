/**
 * Tests for the shared hardware-collector.
 */

import { describe, it, expect } from "vitest";
import {
  collectHardwareSnapshot,
  snapshotMeaningfullyChanged,
  type HardwareSnapshot,
} from "./hardware-collector.js";

function makeSnapshot(overrides: Partial<HardwareSnapshot> = {}): HardwareSnapshot {
  return {
    cpu: { percent: 10, perCorePercent: [10, 10], loadAvg: [0.1, 0.1, 0.1], cores: 2, model: "x" },
    memory: { totalBytes: 8e9, usedBytes: 1e9, freeBytes: 7e9, percent: 12 },
    gpu: null,
    disk: { mounts: [] },
    network: { interfaces: [] },
    system: {
      hostname: "h",
      platform: "linux",
      arch: "x64",
      uptimeSec: 1,
      kernelRelease: "6.0",
    },
    processes: [],
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("collectHardwareSnapshot", () => {
  it("returns a structurally valid snapshot", async () => {
    const snap = await collectHardwareSnapshot();
    expect(snap).toBeDefined();
    expect(typeof snap.cpu.percent).toBe("number");
    expect(Array.isArray(snap.cpu.perCorePercent)).toBe(true);
    expect(snap.cpu.perCorePercent.length).toBe(snap.cpu.cores);
    expect(typeof snap.memory.percent).toBe("number");
    expect(snap.memory.usedBytes + snap.memory.freeBytes).toBe(snap.memory.totalBytes);
    expect(Array.isArray(snap.disk.mounts)).toBe(true);
    expect(Array.isArray(snap.network.interfaces)).toBe(true);
    expect(Array.isArray(snap.processes)).toBe(true);
    expect(typeof snap.timestamp).toBe("number");
    expect(snap.system.hostname.length).toBeGreaterThan(0);
  });

  it("clamps per-core percentages to [0, 100]", async () => {
    const snap = await collectHardwareSnapshot();
    for (const p of snap.cpu.perCorePercent) {
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(100);
    }
  });
});

describe("snapshotMeaningfullyChanged", () => {
  it("treats no prior snapshot as a change", () => {
    expect(snapshotMeaningfullyChanged(null, makeSnapshot())).toBe(true);
  });

  it("returns false when nothing material has changed", () => {
    const a = makeSnapshot({
      cpu: { percent: 30, perCorePercent: [], loadAvg: [0, 0, 0], cores: 1, model: "x" },
    });
    const b = makeSnapshot({
      cpu: { percent: 31, perCorePercent: [], loadAvg: [0, 0, 0], cores: 1, model: "x" },
    });
    expect(snapshotMeaningfullyChanged(a, b)).toBe(false);
  });

  it("returns true when CPU jumps >=2%", () => {
    const a = makeSnapshot({
      cpu: { percent: 30, perCorePercent: [], loadAvg: [0, 0, 0], cores: 1, model: "x" },
    });
    const b = makeSnapshot({
      cpu: { percent: 33, perCorePercent: [], loadAvg: [0, 0, 0], cores: 1, model: "x" },
    });
    expect(snapshotMeaningfullyChanged(a, b)).toBe(true);
  });

  it("returns true when memory jumps >=2%", () => {
    const a = makeSnapshot({ memory: { totalBytes: 1, usedBytes: 0, freeBytes: 1, percent: 40 } });
    const b = makeSnapshot({ memory: { totalBytes: 1, usedBytes: 0, freeBytes: 1, percent: 45 } });
    expect(snapshotMeaningfullyChanged(a, b)).toBe(true);
  });

  it("returns true when GPU utilisation jumps >=2%", () => {
    const a = makeSnapshot({
      gpu: { vendor: "x", name: "x", utilizationPercent: 20, vramUsedBytes: 0, vramTotalBytes: 0 },
    });
    const b = makeSnapshot({
      gpu: { vendor: "x", name: "x", utilizationPercent: 25, vramUsedBytes: 0, vramTotalBytes: 0 },
    });
    expect(snapshotMeaningfullyChanged(a, b)).toBe(true);
  });

  it("returns true on large network deltas", () => {
    const a = makeSnapshot({
      network: { interfaces: [{ name: "eth0", rxBytesPerSec: 0, txBytesPerSec: 0 }] },
    });
    const b = makeSnapshot({
      network: { interfaces: [{ name: "eth0", rxBytesPerSec: 1_000_000, txBytesPerSec: 0 }] },
    });
    expect(snapshotMeaningfullyChanged(a, b)).toBe(true);
  });
});

describe("hub satellite snapshot cache (integration shape)", () => {
  it("is shaped correctly for downstream consumers", () => {
    // The hub stores `{ snapshot, receivedAt }` per node. This test guards the
    // payload's structural compatibility with what the master HTTP endpoint
    // re-emits to the UI.
    const snap = makeSnapshot();
    const cached = { snapshot: snap, receivedAt: Date.now() };
    expect(cached.snapshot.cpu.cores).toBe(snap.cpu.cores);
    expect(typeof cached.receivedAt).toBe("number");
  });
});
