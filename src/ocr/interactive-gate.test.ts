import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  backgroundPaused,
  beginInteractiveTurn,
  interactiveGateStatus,
  resetInteractiveGateForTests,
} from "./interactive-gate.js";
import { resolveOcrConfig } from "./local-only.js";
import { OcrService } from "./service.js";
import type { OcrEngines } from "./types.js";

function engines(log: { vl: number; release?: Promise<void> }): OcrEngines {
  return {
    async ocrEngineName() {
      return "fake-ocr";
    },
    async ocrImages(paths) {
      return paths.map(() => ({
        width: 100,
        height: 100,
        lines: [{ text: "Rolex Submariner 16610", confidence: 0.98, box: [0, 0, 10, 10] }],
      }));
    },
    async toPng(input) {
      return input;
    },
    async pdfPageCount() {
      return 1;
    },
    async pdfPageText() {
      return "";
    },
    async pdfRenderPage(_p, _n, outDir) {
      const out = path.join(outDir, "p.png");
      fs.writeFileSync(out, "x");
      return out;
    },
    async nativeText() {
      return null;
    },
    vl: {
      async model() {
        return "qwen-vl-fake";
      },
      async ask() {
        log.vl++;
        return { text: "## Summary\nA steel wristwatch.", model: "qwen-vl-fake" };
      },
    },
  };
}

describe("interactive GPU gate", () => {
  let state: string;
  let files: string;
  beforeEach(() => {
    state = fs.mkdtempSync(path.join(os.tmpdir(), "ib-gate-state-"));
    files = fs.mkdtempSync(path.join(os.tmpdir(), "ib-gate-files-"));
  });
  afterEach(() => {
    resetInteractiveGateForTests();
    fs.rmSync(state, { recursive: true, force: true });
    fs.rmSync(files, { recursive: true, force: true });
  });

  function make(log: { vl: number }) {
    return new OcrService({
      stateDir: state,
      engines: engines(log),
      cfg: { ...resolveOcrConfig({}), retryBaseMs: 1000, maxAttempts: 3 },
      secureVault: () => null,
    });
  }

  function put(name: string) {
    const p = path.join(files, name);
    fs.writeFileSync(p, randomBytes(32));
    return p;
  }

  it("holds are counted, idempotent and auto-expire", async () => {
    const a = beginInteractiveTurn({ runId: "a" });
    const b = beginInteractiveTurn({ runId: "b" });
    expect(interactiveGateStatus().holds.map((h) => h.runId)).toEqual(["a", "b"]);
    a();
    a();
    expect(backgroundPaused()).toBe(true);
    b();
    expect(backgroundPaused()).toBe(false);
    beginInteractiveTurn({ runId: "leak" }, { maxHoldMs: 1000 });
    expect(backgroundPaused()).toBe(true);
    await new Promise((r) => setTimeout(r, 1100));
    expect(backgroundPaused()).toBe(false);
  });

  it("background OCR pauses during an interactive turn; chat attachments still run; resumes after", async () => {
    const log = { vl: 0 };
    const svc = make(log);
    const backfill = svc.enqueuePath({
      absPath: put("old.png"),
      source: { kind: "files" },
      priority: -10,
    })!;
    const release = beginInteractiveTurn({ runId: "turn" });
    expect(await svc.processNext()).toBe(false);
    expect((await svc.status()).pausedForInteractive).toBe(true);
    const chat = svc.enqueuePath({
      absPath: put("att.png"),
      source: { kind: "chat" },
      priority: 10,
    })!;
    expect(await svc.processNext()).toBe(true);
    expect(svc.find("normal", { id: chat.id })!.status).toBe("done");
    expect(svc.find("normal", { id: backfill.id })!.status).toBe("queued");
    release();
    expect((await svc.status()).pausedForInteractive).toBe(false);
    expect(await svc.processNext()).toBe(true);
    expect(svc.find("normal", { id: backfill.id })!.status).toBe("done");
  });

  it("a background job already running waits before its next vision call", async () => {
    const log = { vl: 0 };
    const svc = make(log);
    svc.enqueuePath({ absPath: put("bg.png"), source: { kind: "files" } });
    // The turn starts while the background job is between OCR and vision.
    const release = beginInteractiveTurn({ runId: "turn" });
    // processNext picks nothing while paused, so simulate "already running"
    // by releasing the selection gate only: start, then hold before vision.
    release();
    const run = svc.processNext();
    const hold = beginInteractiveTurn({ runId: "turn-2" });
    await new Promise((r) => setTimeout(r, 50));
    expect(log.vl).toBe(0); // vision is waiting for the interactive turn
    hold();
    expect(await run).toBe(true);
    expect(log.vl).toBe(1);
  });

  it("inspect answers are saved and reused; refresh looks again", async () => {
    const log = { vl: 0 };
    const svc = make(log);
    const e = svc.enqueuePath({ absPath: put("watch.png"), source: { kind: "files" } })!;
    await svc.processNext();
    const base = log.vl;
    const first = await svc.inspect("normal", { id: e.id }, "What brand is the watch?");
    expect(first.cached).toBeUndefined();
    expect(log.vl).toBe(base + 1);
    const again = await svc.inspect("normal", { id: e.id }, "  what brand is the  watch? ");
    expect(again).toMatchObject({ cached: true, answer: first.answer });
    expect(log.vl).toBe(base + 1);
    await svc.inspect("normal", { id: e.id }, "What brand is the watch?", { refresh: true });
    expect(log.vl).toBe(base + 2);
  });
});

describe("runtime-manager signal", () => {
  afterEach(() => resetInteractiveGateForTests());

  it("pauses while the manager reports an interactive lease and resumes on idle", async () => {
    let busy = false;
    let fire: (() => void) | null = null;
    const { setExternalInteractiveSource, waitForBackgroundSlot, onBackgroundPauseChange } =
      await import("./interactive-gate.js");
    const seen: boolean[] = [];
    onBackgroundPauseChange((p) => seen.push(p));
    setExternalInteractiveSource({
      isBusy: () => busy,
      subscribe: (cb) => {
        fire = cb;
        return () => (fire = null);
      },
    });
    expect(backgroundPaused()).toBe(false);
    busy = true;
    fire!();
    expect(backgroundPaused()).toBe(true);
    let resumed = false;
    const w = waitForBackgroundSlot().then(() => (resumed = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(resumed).toBe(false);
    busy = false;
    fire!();
    await w;
    expect(resumed).toBe(true);
    expect(seen).toEqual([true, false]);
  });
});

describe("vision priority", () => {
  it("interactive asks skip the background GPU lease; background asks take it", async () => {
    const { createVisionClient } = await import("./engines.js");
    const { resolveOcrConfig } = await import("./local-only.js");
    const leases: string[] = [];
    const bodies: Array<Record<string, any>> = [];
    const fetchImpl = (async (url: string, init?: { body?: string }) => {
      if (String(url).endsWith("/api/chat") && init?.body) bodies.push(JSON.parse(init.body));
      if (String(url).endsWith("/api/tags")) {
        return new Response(JSON.stringify({ models: [{ name: "qwen-vl", model: "qwen-vl" }] }));
      }
      if (String(url).endsWith("/api/show")) {
        return new Response(JSON.stringify({ capabilities: ["vision"] }));
      }
      return new Response(JSON.stringify({ message: { content: "ok" } }));
    }) as unknown as typeof fetch;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ib-vl-"));
    const img = path.join(dir, "a.png");
    fs.writeFileSync(img, "x");
    const vl = createVisionClient(
      { ...resolveOcrConfig({}), ollamaUrl: "http://127.0.0.1:11434", vlMode: "auto" } as never,
      fetchImpl,
      {
        acquire: async () => {
          leases.push("background");
          return { release: () => {} };
        },
      },
    )!;
    await vl.ask({ images: [img], prompt: "q", interactive: true });
    expect(leases).toEqual([]);
    await vl.ask({ images: [img], prompt: "q" });
    expect(leases).toEqual(["background"]);
    // Same context as chat (server default): a forced num_ctx reloads the model on every switch.
    expect(bodies).toHaveLength(2);
    expect(bodies.every((b) => b.options?.num_ctx === undefined)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
