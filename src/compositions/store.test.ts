/**
 * Compositions store CRUD tests.
 *
 * Uses an in-memory (tmp dir) SQLite DB so the tests don't touch the real
 * state dir and run in parallel without conflict.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCompositionsStore, type CompositionsStore } from "./store.js";

let tmpDir: string;
let store: CompositionsStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "infinibot-store-test-"));
  // Re-init with a fresh dir forces a new DB.
  store = getCompositionsStore(tmpDir);
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("Compositions store", () => {
  describe("composition CRUD", () => {
    it("creates and reads a composition", () => {
      const comp = store.create({
        name: "Test Comp",
        widthPx: 1920,
        heightPx: 1080,
        fps: 30,
        durationSec: 10,
        bgColor: "#000000",
      });
      expect(comp.id).toBeTruthy();
      expect(comp.name).toBe("Test Comp");
      expect(comp.widthPx).toBe(1920);
      expect(comp.fps).toBe(30);
      expect(comp.durationSec).toBe(10);
    });

    it("lists compositions", () => {
      store.create({
        name: "A",
        widthPx: 1920,
        heightPx: 1080,
        fps: 30,
        durationSec: 5,
        bgColor: "#fff",
      });
      store.create({
        name: "B",
        widthPx: 1080,
        heightPx: 1920,
        fps: 24,
        durationSec: 8,
        bgColor: "#000",
      });
      const list = store.list();
      expect(list.length).toBeGreaterThanOrEqual(2);
      const names = list.map((c) => c.name);
      expect(names).toContain("A");
      expect(names).toContain("B");
    });

    it("updates a composition", () => {
      const comp = store.create({
        name: "Before",
        widthPx: 1920,
        heightPx: 1080,
        fps: 30,
        durationSec: 5,
        bgColor: "#000",
      });
      const updated = store.update(comp.id, { name: "After", durationSec: 15 });
      expect(updated?.name).toBe("After");
      expect(updated?.durationSec).toBe(15);
      expect(updated?.widthPx).toBe(1920);
    });

    it("deletes a composition", () => {
      const comp = store.create({
        name: "Temp",
        widthPx: 1920,
        heightPx: 1080,
        fps: 30,
        durationSec: 5,
        bgColor: "#000",
      });
      const deleted = store.delete(comp.id);
      expect(deleted).toBe(true);
      expect(store.get(comp.id)).toBeNull();
    });

    it("resolves by slug", () => {
      const comp = store.create({
        name: "Slug Test",
        slug: "my-slug",
        widthPx: 1920,
        heightPx: 1080,
        fps: 30,
        durationSec: 5,
        bgColor: "#000",
      });
      const found = store.getBySlug("my-slug");
      expect(found?.id).toBe(comp.id);
    });

    it("returns null for a missing composition", () => {
      expect(store.get("nonexistent-id")).toBeNull();
    });
  });

  describe("track CRUD", () => {
    it("creates tracks and associates them with a composition", () => {
      const comp = store.create({
        name: "Tracks Test",
        widthPx: 1920,
        heightPx: 1080,
        fps: 30,
        durationSec: 5,
        bgColor: "#000",
      });
      const videoTrack = store.createTrack({
        compositionId: comp.id,
        kind: "video",
        name: "Video",
      });
      const audioTrack = store.createTrack({
        compositionId: comp.id,
        kind: "audio",
        name: "Audio",
      });
      expect(videoTrack.kind).toBe("video");
      expect(audioTrack.kind).toBe("audio");
      const withChildren = store.getWithChildren(comp.id);
      expect(withChildren?.tracks.length).toBeGreaterThanOrEqual(2);
    });

    it("updates a track", () => {
      const comp = store.create({
        name: "Track Update Test",
        widthPx: 1920,
        heightPx: 1080,
        fps: 30,
        durationSec: 5,
        bgColor: "#000",
      });
      const track = store.createTrack({ compositionId: comp.id, kind: "video", name: "My Track" });
      const updated = store.updateTrack(track.id, { muted: true, name: "Renamed" });
      expect(updated?.muted).toBe(true);
      expect(updated?.name).toBe("Renamed");
    });

    it("deletes a track", () => {
      const comp = store.create({
        name: "Track Delete Test",
        widthPx: 1920,
        heightPx: 1080,
        fps: 30,
        durationSec: 5,
        bgColor: "#000",
      });
      const track = store.createTrack({ compositionId: comp.id, kind: "overlay", name: "Temp" });
      const deleted = store.deleteTrack(track.id);
      expect(deleted).toBe(true);
    });
  });

  describe("clip CRUD", () => {
    it("creates a clip and reads it back", () => {
      const comp = store.create({
        name: "Clip Test",
        widthPx: 1920,
        heightPx: 1080,
        fps: 30,
        durationSec: 10,
        bgColor: "#000",
      });
      const track = store.createTrack({ compositionId: comp.id, kind: "overlay", name: "Overlay" });
      const clip = store.createClip({
        compositionId: comp.id,
        trackId: track.id,
        kind: "text",
        label: "Hello",
        startSec: 1,
        durationSec: 3,
        z: 10,
        props: { text: "Hello World", fontSize: 48, color: "#fff" },
      });
      expect(clip.id).toBeTruthy();
      expect(clip.kind).toBe("text");
      expect(clip.startSec).toBe(1);
      expect(clip.durationSec).toBe(3);
      const fetched = store.getClip(clip.id);
      expect(fetched?.id).toBe(clip.id);
      const props = fetched?.props as { text?: string; fontSize?: number };
      expect(props.text).toBe("Hello World");
      expect(props.fontSize).toBe(48);
    });

    it("updates clip startSec and durationSec", () => {
      const comp = store.create({
        name: "Clip Move Test",
        widthPx: 1920,
        heightPx: 1080,
        fps: 30,
        durationSec: 10,
        bgColor: "#000",
      });
      const track = store.createTrack({ compositionId: comp.id, kind: "overlay", name: "Overlay" });
      const clip = store.createClip({
        compositionId: comp.id,
        trackId: track.id,
        kind: "shape",
        label: "Box",
        startSec: 0,
        durationSec: 2,
        z: 0,
        props: { shape: "rect", fill: "#fff" },
      });
      const updated = store.updateClip(clip.id, { startSec: 2.5, durationSec: 4 });
      expect(updated?.startSec).toBe(2.5);
      expect(updated?.durationSec).toBe(4);
    });

    it("updates clip props (patch merging)", () => {
      const comp = store.create({
        name: "Clip Props Test",
        widthPx: 1920,
        heightPx: 1080,
        fps: 30,
        durationSec: 10,
        bgColor: "#000",
      });
      const track = store.createTrack({ compositionId: comp.id, kind: "overlay", name: "Overlay" });
      const clip = store.createClip({
        compositionId: comp.id,
        trackId: track.id,
        kind: "text",
        label: "Text",
        startSec: 0,
        durationSec: 3,
        z: 0,
        props: { text: "Original", fontSize: 32, color: "#fff" },
      });
      const updated = store.updateClip(clip.id, { props: { text: "Updated" } });
      const props = updated?.props as { text?: string; fontSize?: number; color?: string };
      expect(props.text).toBe("Updated");
    });

    it("deletes a clip", () => {
      const comp = store.create({
        name: "Clip Delete Test",
        widthPx: 1920,
        heightPx: 1080,
        fps: 30,
        durationSec: 10,
        bgColor: "#000",
      });
      const track = store.createTrack({ compositionId: comp.id, kind: "overlay", name: "Overlay" });
      const clip = store.createClip({
        compositionId: comp.id,
        trackId: track.id,
        kind: "shape",
        label: "Del",
        startSec: 0,
        durationSec: 2,
        z: 0,
        props: { shape: "rect" },
      });
      const deleted = store.deleteClip(clip.id);
      expect(deleted).toBe(true);
      expect(store.getClip(clip.id)).toBeNull();
    });

    it("getWithChildren returns sorted clips with tracks", () => {
      const comp = store.create({
        name: "Children Test",
        widthPx: 1920,
        heightPx: 1080,
        fps: 30,
        durationSec: 10,
        bgColor: "#000",
      });
      const track = store.createTrack({ compositionId: comp.id, kind: "overlay", name: "Overlay" });
      store.createClip({
        compositionId: comp.id,
        trackId: track.id,
        kind: "text",
        label: "C",
        startSec: 3,
        durationSec: 2,
        z: 0,
        props: { text: "C" },
      });
      store.createClip({
        compositionId: comp.id,
        trackId: track.id,
        kind: "text",
        label: "A",
        startSec: 0,
        durationSec: 2,
        z: 0,
        props: { text: "A" },
      });
      store.createClip({
        compositionId: comp.id,
        trackId: track.id,
        kind: "text",
        label: "B",
        startSec: 1.5,
        durationSec: 2,
        z: 0,
        props: { text: "B" },
      });
      const withChildren = store.getWithChildren(comp.id);
      expect(withChildren?.clips.length).toBe(3);
      const labels = withChildren!.clips.map((c) => c.label);
      expect(labels).toEqual(["A", "B", "C"]);
    });
  });

  describe("meta / variables persistence", () => {
    it("stores and retrieves arbitrary meta", () => {
      const comp = store.create({
        name: "Meta Test",
        widthPx: 1920,
        heightPx: 1080,
        fps: 30,
        durationSec: 5,
        bgColor: "#000",
      });
      store.update(comp.id, {
        meta: {
          variables: [{ id: "heroText", type: "string", label: "Hero", default: "Hello" }],
          variableValues: { heroText: "World" },
        },
      });
      const updated = store.get(comp.id);
      const meta = updated?.meta as {
        variables?: unknown[];
        variableValues?: Record<string, unknown>;
      };
      expect(Array.isArray(meta.variables)).toBe(true);
      expect(meta.variableValues?.heroText).toBe("World");
    });
  });
});
