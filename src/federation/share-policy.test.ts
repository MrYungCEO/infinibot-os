import { describe, expect, it } from "vitest";
import {
  applyShareToCapabilities,
  isMethodShared,
  normalizeShare,
  notSharedMessage,
  shareCategoryForMethod,
} from "./share-policy.js";

describe("federation share policy", () => {
  it("maps proxied methods to categories", () => {
    expect(shareCategoryForMethod("terminal.create")).toBe("terminals");
    expect(shareCategoryForMethod("terminal.write")).toBe("terminals");
    expect(shareCategoryForMethod("terminal.spawnAgent")).toBe("coders");
    expect(shareCategoryForMethod("coder.backends.list")).toBe("coders");
    expect(shareCategoryForMethod("chat.send")).toBe("agents");
    expect(shareCategoryForMethod("sessions.list")).toBe("agents");
    expect(shareCategoryForMethod("agent")).toBe("agents");
    expect(shareCategoryForMethod("health")).toBeNull();
    expect(shareCategoryForMethod("system-presence")).toBeNull();
  });

  it("shares everything when no share block is configured (legacy configs)", () => {
    expect(isMethodShared(undefined, "terminal.create")).toBe(true);
    expect(isMethodShared({}, "terminal.spawnAgent")).toBe(true);
    expect(isMethodShared(null, "chat.send")).toBe(true);
  });

  it("denies only the categories switched off", () => {
    const share = { terminals: false, coders: true, agents: false };
    expect(isMethodShared(share, "terminal.create")).toBe(false);
    expect(isMethodShared(share, "terminal.spawnAgent")).toBe(true);
    expect(isMethodShared(share, "chat.send")).toBe(false);
    expect(isMethodShared(share, "health")).toBe(true);
    expect(notSharedMessage("terminals")).toContain("federation.share.terminals");
  });

  it("hides local models and GPU when compute isn't shared", () => {
    const caps = {
      hasOllama: true,
      ollamaModels: ["llama3"],
      hasComfyUI: true,
      gpu: "RTX",
      platform: "linux",
    };
    expect(applyShareToCapabilities({ compute: true }, caps)).toBe(caps);
    expect(applyShareToCapabilities({ compute: false }, caps)).toEqual({
      hasOllama: false,
      ollamaModels: undefined,
      hasComfyUI: false,
      gpu: undefined,
      gpuVRAM: undefined,
      platform: "linux",
    });
  });

  it("normalizes untrusted input to booleans", () => {
    expect(normalizeShare({ terminals: true, coders: "yes", agents: false, extra: true })).toEqual({
      terminals: true,
      agents: false,
    });
    expect(normalizeShare(null)).toEqual({});
  });
});
