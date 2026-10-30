import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isOverlayType,
  normalizePosition,
  validateSpawn,
  validateUpdate,
  OverlayValidationError,
  DEFAULT_OVERLAY_POSITION,
} from "./registry.js";
import {
  closeOverlay,
  closeOverlayStore,
  focusOverlay,
  highlightText,
  listOverlays,
  popOutOverlay,
  setOverlayBroadcaster,
  spawnOverlay,
  updateOverlay,
  type OverlayBroadcast,
} from "./router.js";
import {
  handleOverlayAction,
  isOverlayAction,
  OVERLAY_ACTIONS,
} from "../agents/tools/ui-control-overlay.js";

const STATE_DIR = mkdtempSync(join(tmpdir(), "overlay-test-"));
const broadcasts: Array<{ topic: string; frame: OverlayBroadcast }> = [];

setOverlayBroadcaster((topic, payload) => {
  broadcasts.push({ topic, frame: payload as OverlayBroadcast });
});

beforeEach(() => {
  broadcasts.length = 0;
});

afterAll(() => {
  closeOverlayStore();
  rmSync(STATE_DIR, { recursive: true, force: true });
});

describe("registry validators", () => {
  it("accepts known types and rejects unknown ones", () => {
    expect(isOverlayType("note")).toBe(true);
    expect(isOverlayType("revenue")).toBe(true);
    expect(isOverlayType("highlight")).toBe(false); // effect, not a card
    expect(isOverlayType("bogus")).toBe(false);
  });

  it("normalizes a partial position against defaults", () => {
    expect(normalizePosition({ x: 10 })).toEqual({
      ...DEFAULT_OVERLAY_POSITION,
      x: 10,
    });
    expect(normalizePosition(undefined)).toEqual(DEFAULT_OVERLAY_POSITION);
    // width can't be zero/negative
    expect(normalizePosition({ w: -5 }).w).toBeGreaterThanOrEqual(1);
  });

  it("validateSpawn throws on unknown type and bad payload", () => {
    expect(() => validateSpawn({ type: "nope" })).toThrow(OverlayValidationError);
    expect(() => validateSpawn({ type: "note", payload: 42 as unknown })).toThrow(
      OverlayValidationError,
    );
    const ok = validateSpawn({ type: "note", payload: { id: "n1" }, ttlMs: 5000 });
    expect(ok.type).toBe("note");
    expect(ok.ttlMs).toBe(5000);
    expect(ok.payload).toEqual({ id: "n1" });
  });

  it("validateUpdate only returns provided fields", () => {
    expect(validateUpdate({})).toEqual({});
    const u = validateUpdate({ position: { x: 1, y: 2, w: 3, h: 4 } });
    expect(u.position).toEqual({ x: 1, y: 2, w: 3, h: 4 });
    expect(u.payload).toBeUndefined();
  });
});

describe("router store + broadcast", () => {
  it("spawn → list round-trips the record and broadcasts spawn", () => {
    const rec = spawnOverlay({ type: "note", payload: { id: "demo" } }, STATE_DIR);
    expect(rec.overlayId).toBeTruthy();
    expect(rec.type).toBe("note");

    const overlays = listOverlays(STATE_DIR);
    expect(overlays.map((o) => o.overlayId)).toContain(rec.overlayId);

    const spawnFrame = broadcasts.find((b) => b.frame.kind === "spawn");
    expect(spawnFrame?.topic).toBe("overlay.events");
    expect((spawnFrame?.frame as { record: { overlayId: string } }).record.overlayId).toBe(
      rec.overlayId,
    );
  });

  it("update merges payload + broadcasts update", () => {
    const rec = spawnOverlay({ type: "markdown", payload: { md: "# hi" } }, STATE_DIR);
    const updated = updateOverlay(rec.overlayId, { payload: { md: "# bye" } }, STATE_DIR);
    expect(updated?.payload).toEqual({ md: "# bye" });
    expect(broadcasts.some((b) => b.frame.kind === "update")).toBe(true);

    expect(updateOverlay("missing-id", { payload: {} }, STATE_DIR)).toBeNull();
  });

  it("close removes the record + broadcasts close", () => {
    const rec = spawnOverlay({ type: "image", payload: { src: "x.png" } }, STATE_DIR);
    expect(closeOverlay(rec.overlayId, STATE_DIR)).toBe(true);
    expect(listOverlays(STATE_DIR).map((o) => o.overlayId)).not.toContain(rec.overlayId);
    expect(closeOverlay(rec.overlayId, STATE_DIR)).toBe(false); // already gone
    expect(broadcasts.some((b) => b.frame.kind === "close")).toBe(true);
  });

  it("expired ttl overlays are purged from list()", () => {
    const now = 1_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const rec = spawnOverlay({ type: "task", payload: {}, ttlMs: 100 }, STATE_DIR);
    expect(listOverlays(STATE_DIR).some((o) => o.overlayId === rec.overlayId)).toBe(true);
    vi.spyOn(Date, "now").mockReturnValue(now + 200);
    expect(listOverlays(STATE_DIR).some((o) => o.overlayId === rec.overlayId)).toBe(false);
    vi.restoreAllMocks();
  });

  it("focus broadcasts focus only when the overlay exists", () => {
    const rec = spawnOverlay({ type: "project", payload: {} }, STATE_DIR);
    expect(focusOverlay(rec.overlayId, STATE_DIR)).toBe(true);
    expect(focusOverlay("nope", STATE_DIR)).toBe(false);
    expect(broadcasts.filter((b) => b.frame.kind === "focus")).toHaveLength(1);
  });

  it("highlightText / clearHighlight broadcast but never persist", () => {
    const before = listOverlays(STATE_DIR).length;
    const { id } = highlightText({ query: "revenue", color: "#fff" });
    expect(id).toBeTruthy();
    expect(listOverlays(STATE_DIR).length).toBe(before);
    const hl = broadcasts.find((b) => b.frame.kind === "highlight");
    expect((hl?.frame as { query: string }).query).toBe("revenue");
  });

  it("popOut returns a null windowId stub", () => {
    expect(popOutOverlay("any").windowId).toBeNull();
  });
});

describe("MCP ui_control overlay ops", () => {
  it("exposes exactly the 8 spec ops", () => {
    expect([...OVERLAY_ACTIONS]).toEqual([
      "spawn_overlay",
      "update_overlay",
      "close_overlay",
      "list_overlays",
      "focus_overlay",
      "pop_out_overlay",
      "highlight_text",
      "clear_highlight",
    ]);
    expect(isOverlayAction("spawn_overlay")).toBe(true);
    expect(isOverlayAction("dispatch")).toBe(false);
  });

  it("spawn_overlay + list_overlays via the MCP op handler", () => {
    const spawned = handleOverlayAction("spawn_overlay", { type: "code", payload: { lang: "ts" } });
    expect(spawned.ok).toBe(true);
    const overlayId = spawned.overlayId as string;
    expect(overlayId).toBeTruthy();

    const listed = handleOverlayAction("list_overlays", {});
    expect(
      (listed.overlays as Array<{ overlayId: string }>).some((o) => o.overlayId === overlayId),
    ).toBe(true);
  });

  it("rejects bad input with a clean INVALID_PARAMS shape", () => {
    expect(handleOverlayAction("spawn_overlay", { type: "nope" })).toMatchObject({
      ok: false,
      code: "INVALID_PARAMS",
    });
    expect(handleOverlayAction("update_overlay", {})).toMatchObject({
      ok: false,
      code: "INVALID_PARAMS",
    });
    expect(handleOverlayAction("highlight_text", {})).toMatchObject({
      ok: false,
      code: "INVALID_PARAMS",
    });
  });
});
