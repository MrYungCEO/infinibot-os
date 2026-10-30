import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_VIEW_PREFS_KEY,
  CHAT_ZOOM_STEPS,
  applyZoomShortcut,
  chatViewStyleVars,
  loadChatViewPrefs,
  normalizeChatViewPrefs,
  saveChatViewPrefs,
  snapZoom,
  stepZoom,
  zoomShortcut,
} from "./chat-view-prefs";

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("chat view prefs", () => {
  it("steps run 85 → 160", () => {
    expect([...CHAT_ZOOM_STEPS]).toEqual([85, 100, 115, 130, 145, 160]);
    expect(stepZoom(100, 1)).toBe(115);
    expect(stepZoom(100, -1)).toBe(85);
    expect(stepZoom(85, -1)).toBe(85);
    expect(stepZoom(160, 1)).toBe(160);
    expect(snapZoom(140)).toBe(145);
    expect(snapZoom("nope")).toBe(100);
  });

  it("normalizes unknown input to Full width / 100%", () => {
    expect(normalizeChatViewPrefs(null)).toEqual({ width: "full", zoom: 100 });
    expect(normalizeChatViewPrefs({ width: "centered", zoom: 999 })).toEqual({ width: "centered", zoom: 160 });
  });

  it("persists to localStorage and falls back when storage throws", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    expect(loadChatViewPrefs()).toEqual({ width: "full", zoom: 100 });
    saveChatViewPrefs({ zoom: 145 });
    saveChatViewPrefs({ width: "centered" });
    expect(JSON.parse(localStorage.getItem(CHAT_VIEW_PREFS_KEY)!)).toEqual({ width: "centered", zoom: 145 });
    expect(applyZoomShortcut("reset").zoom).toBe(100);

    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    expect(loadChatViewPrefs()).toEqual({ width: "full", zoom: 100 });
    expect(() => saveChatViewPrefs({ zoom: 130 })).not.toThrow();
  });

  it("emits CSS vars (no column cap in Full width, zoom-scaled cap when Centered)", () => {
    expect(chatViewStyleVars({ width: "full", zoom: 145 })).toEqual({ "--chat-tz": "1.45", "--chat-col-max": "none" });
    expect(chatViewStyleVars({ width: "centered", zoom: 100 })["--chat-col-max"]).toBe("820px");
    expect(chatViewStyleVars({ width: "centered", zoom: 130 })["--chat-col-max"]).toBe("1066px");
  });

  it("maps Ctrl/Cmd +/−/0 only", () => {
    const k = (key: string, mods: Partial<KeyboardEvent> = { ctrlKey: true }) =>
      zoomShortcut({ key, code: "", ctrlKey: false, metaKey: false, altKey: false, ...mods });
    expect(k("=")).toBe("in");
    expect(k("+")).toBe("in");
    expect(k("-")).toBe("out");
    expect(k("0", { metaKey: true })).toBe("reset");
    expect(k("=", {})).toBeNull();
    expect(k("a")).toBeNull();
    expect(k("=", { ctrlKey: true, altKey: true })).toBeNull();
  });
});
