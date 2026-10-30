/**
 * Tests for Compute Manifest
 */

import { describe, expect, it } from "vitest";

import {
  detectNvidiaGPU,
  getCPULoadPercent,
  getFreeRAMMB,
  getSystemRAMGB,
  getSystemRAMMB,
} from "./compute-manifest.js";

describe("compute-manifest", () => {
  describe("system info", () => {
    it("getSystemRAMGB returns a positive number", () => {
      const ram = getSystemRAMGB();
      expect(ram).toBeGreaterThan(0);
      expect(Number.isInteger(ram)).toBe(true);
    });

    it("getSystemRAMMB returns a positive number", () => {
      const ram = getSystemRAMMB();
      expect(ram).toBeGreaterThan(0);
      expect(Number.isInteger(ram)).toBe(true);
    });

    it("getFreeRAMMB returns a positive number", () => {
      const ram = getFreeRAMMB();
      expect(ram).toBeGreaterThan(0);
      expect(Number.isInteger(ram)).toBe(true);
    });

    it("getCPULoadPercent returns 0-100", () => {
      const load = getCPULoadPercent();
      expect(load).toBeGreaterThanOrEqual(0);
      expect(load).toBeLessThanOrEqual(100);
    });
  });

  describe("GPU detection", () => {
    it("detectNvidiaGPU returns GPUInfo or null", async () => {
      const gpu = await detectNvidiaGPU();
      if (gpu) {
        expect(gpu.name).toBeTruthy();
        expect(gpu.vramMB).toBeGreaterThan(0);
        expect(gpu.utilizationPercent).toBeGreaterThanOrEqual(0);
        expect(gpu.utilizationPercent).toBeLessThanOrEqual(100);
      }
      // null is also valid if no GPU
    });
  });
});
