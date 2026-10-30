import { describe, expect, it } from "vitest";

import {
  CHAT_DOCK_COLLAPSED_KEY,
  CHAT_DOCK_DEFAULT_WIDTH,
  CHAT_DOCK_MIN_WIDTH,
  CHAT_DOCK_WIDTH_KEY,
  clampDockWidth,
  loadDockState,
  maxDockWidth,
  saveDockState,
  widthFromPointer,
} from "./chat-sidebar-dock";

function memStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}

describe("chat sidebar dock", () => {
  it("clamps width between the minimum and viewport − 240 (max 900)", () => {
    expect(clampDockWidth(100, 1440)).toBe(CHAT_DOCK_MIN_WIDTH);
    expect(clampDockWidth(5000, 1440)).toBe(900);
    expect(clampDockWidth(700, 800)).toBe(560);
    expect(maxDockWidth(400)).toBe(CHAT_DOCK_MIN_WIDTH);
    expect(clampDockWidth(NaN, 1440)).toBe(CHAT_DOCK_DEFAULT_WIDTH);
  });

  it("dragging the left edge sets width = viewport − pointer x; far past the minimum collapses", () => {
    expect(widthFromPointer(1000, 1440)).toEqual({ width: 440, collapse: false });
    expect(widthFromPointer(1200, 1440)).toEqual({ width: CHAT_DOCK_MIN_WIDTH, collapse: true });
    expect(widthFromPointer(1110, 1440).collapse).toBe(false);
  });

  it("remembers width + collapsed state in localStorage", () => {
    const st = memStorage();
    expect(loadDockState(st, 1440)).toEqual({ width: CHAT_DOCK_DEFAULT_WIDTH, collapsed: false });
    saveDockState(st, { width: 512.4, collapsed: true });
    expect(st.m.get(CHAT_DOCK_WIDTH_KEY)).toBe("512");
    expect(st.m.get(CHAT_DOCK_COLLAPSED_KEY)).toBe("1");
    expect(loadDockState(st, 1440)).toEqual({ width: 512, collapsed: true });
    // A remembered width wider than a smaller window is clamped on load.
    expect(loadDockState(st, 700).width).toBe(460);
  });

  it("survives blocked storage", () => {
    const bad = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadDockState(bad, 1440)).toEqual({ width: CHAT_DOCK_DEFAULT_WIDTH, collapsed: false });
    expect(() => saveDockState(bad, { width: 400, collapsed: false })).not.toThrow();
  });
});
