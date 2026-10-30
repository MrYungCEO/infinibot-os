import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppViewState } from "./app-view-state";
import { UIControlBus } from "./control-bus";
import { registerGridController } from "./control-bus-grid";
import { registerWhiteboardController } from "./control-bus-whiteboard";
import type { MasonryGridState } from "./controllers/masonry-grid";

const handles: Array<{ unregister: () => void }> = [];

beforeEach(() => {
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => undefined,
  });
});

afterEach(() => {
  while (handles.length) handles.pop()?.unregister();
  vi.unstubAllGlobals();
});

function gridState(): MasonryGridState {
  return {
    canvases: [
      {
        id: "canvas-0",
        name: "Main",
        icon: "screen",
        panels: [],
        activePanel: null,
        maxZIndex: 1,
      },
    ],
    activeCanvasId: "canvas-0",
    panels: [],
    activePanel: null,
    gridMode: "free",
    snapSize: 20,
    maxZIndex: 1,
    containerWidth: 1200,
    containerHeight: 800,
  };
}

function host(): AppViewState {
  const value = {
    tab: "dashboard",
    masonryGridState: gridState(),
    setTab(next: string) {
      this.tab = next;
    },
    requestUpdate() {},
  };
  return value as unknown as AppViewState;
}

describe("whiteboard UI controller", () => {
  it("appears in list_views and opens the full-page Whiteboard", async () => {
    const app = host();
    handles.push(registerGridController(app));
    handles.push(registerWhiteboardController(app, { isAvailable: () => true }));

    const view = UIControlBus.list().find((entry) => entry.viewName === "whiteboard");
    expect(view?.actions.map((action) => action.type)).toEqual(["open", "open_in_grid"]);

    const result = await UIControlBus.dispatchTo("whiteboard", { type: "open" });
    expect(result.ok).toBe(true);
    expect(app.tab).toBe("whiteboard");
  });

  it("adds a live canvas panel through the Grid controller", async () => {
    const app = host();
    handles.push(registerGridController(app));
    handles.push(registerWhiteboardController(app, { isAvailable: () => true }));

    const result = await UIControlBus.dispatchTo("whiteboard", {
      type: "open_in_grid",
      title: "Architecture",
    });
    expect(result.ok).toBe(true);
    expect(app.tab).toBe("grid");

    const state = UIControlBus.queryState("grid") as {
      panels: Array<{ type: string; title: string }>;
    };
    expect(state.panels).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "canvas", title: "Architecture" })]),
    );
  });
});
