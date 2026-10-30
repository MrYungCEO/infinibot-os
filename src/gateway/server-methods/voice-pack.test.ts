import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { GatewayRequestHandlerOptions } from "./types.js";

// ── Isolated state dir per run ───────────────────────────────────────────────
let TMP: string;

beforeAll(async () => {
  TMP = await fs.mkdtemp(path.join(os.tmpdir(), "voicepack-test-"));
  process.env.INFINIBOT_STATE_DIR = TMP;
});

afterAll(async () => {
  delete process.env.INFINIBOT_STATE_DIR;
  delete process.env.INFINIBOT_VOICE_PACK_BASE;
  await fs.rm(TMP, { recursive: true, force: true });
});

afterEach(() => {
  vi.doUnmock("../../license/state.js");
  vi.doUnmock("../../license/middleware.js");
  vi.doUnmock("../../voice/voice-pack-catalog.js");
  vi.resetModules();
});

// ── Fixture HTTP server serving fake pack bytes ──────────────────────────────
const PACK_BODY = Buffer.from("fake-voice-pack-bytes-".repeat(64));
const PACK_SHA = createHash("sha256").update(PACK_BODY).digest("hex");
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url?.includes("notfound")) {
      res.writeHead(404).end("nope");
      return;
    }
    res.writeHead(200, { "content-length": String(PACK_BODY.length) });
    res.end(PACK_BODY);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}/`;
});

afterAll(() => {
  server.close();
});

// ── helpers ──────────────────────────────────────────────────────────────────
function makeOpts(params: Record<string, unknown>): {
  opts: GatewayRequestHandlerOptions;
  respond: ReturnType<typeof vi.fn>;
  events: Array<{ event: string; payload: unknown }>;
} {
  const respond = vi.fn();
  const events: Array<{ event: string; payload: unknown }> = [];
  const opts = {
    req: {} as never,
    params,
    client: null,
    isWebchatConnect: () => false,
    respond: respond as unknown as GatewayRequestHandlerOptions["respond"],
    context: {
      broadcast: (event: string, payload: unknown) => events.push({ event, payload }),
      logGateway: { warn: () => {}, info: () => {}, error: () => {} },
    } as unknown as GatewayRequestHandlerOptions["context"],
  } as GatewayRequestHandlerOptions;
  return { opts, respond, events };
}

async function freshHandlers() {
  // Re-import after mock setup so the lazy license bridge re-loads.
  vi.resetModules();
  const mod = await import("./voice-pack.js");
  return mod.voicePackHandlers;
}

describe("voicePack.list", () => {
  it("returns the catalogue and detects installed state", async () => {
    process.env.INFINIBOT_VOICE_PACK_BASE = baseUrl;
    const handlers = await freshHandlers();
    const { opts, respond } = makeOpts({});
    await handlers["voicePack.list"](opts);
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ packs: expect.any(Array) }),
    );
    const payload = respond.mock.calls[0][1] as {
      packs: unknown[];
      installed: Record<string, unknown>;
    };
    expect(payload.packs.length).toBe(3);
    // Nothing installed yet for whisper-base.
    expect(payload.installed["whisper-base"]).toBeUndefined();
  });
});

describe("voicePack.download (gated)", () => {
  it("returns gated when the feature is absent (free)", async () => {
    vi.doMock("../../license/state.js", () => ({ hasFeature: () => false }));
    vi.doMock("../../license/middleware.js", () => ({})); // no requireFeature → fallback gate
    const handlers = await freshHandlers();
    const { opts, respond } = makeOpts({ id: "whisper-base" });
    await handlers["voicePack.download"](opts);
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ ok: false, gated: true, requiredPlan: "ceo" }),
    );
  });

  it("downloads and verifies sha256 against a localhost fixture", async () => {
    process.env.INFINIBOT_VOICE_PACK_BASE = baseUrl;
    // Grant the feature so the gate passes.
    vi.doMock("../../license/state.js", () => ({ hasFeature: () => true }));
    vi.doMock("../../license/middleware.js", () => ({}));
    // Patch the catalogue entry's sha256 to the real fixture digest.
    vi.doMock("../../voice/voice-pack-catalog.js", async () => {
      const actual = await vi.importActual<typeof import("../../voice/voice-pack-catalog.js")>(
        "../../voice/voice-pack-catalog.js",
      );
      const packs = {
        ...actual.VOICE_PACKS,
        "whisper-base": { ...actual.VOICE_PACKS["whisper-base"], sha256: PACK_SHA },
      };
      return {
        ...actual,
        VOICE_PACKS: packs,
        getVoicePack: (id: string) => (packs as Record<string, unknown>)[id],
        listVoicePacks: () => Object.values(packs),
      };
    });
    const handlers = await freshHandlers();
    const { opts, respond, events } = makeOpts({ id: "whisper-base" });
    await handlers["voicePack.download"](opts);

    expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ ok: true }));
    const payload = respond.mock.calls[0][1] as { bytes: number; path: string };
    expect(payload.bytes).toBe(PACK_BODY.length);
    // File really exists on disk.
    const onDisk = await fs.readFile(payload.path);
    expect(onDisk.equals(PACK_BODY)).toBe(true);
    // Progress stream reached "installed".
    const phases = events
      .filter((e) => e.event === "voicePack:progress")
      .map((e) => (e.payload as { phase: string }).phase);
    expect(phases).toContain("downloading");
    expect(phases).toContain("installed");
  });

  it("removes the partial file and reports failed on sha256 mismatch", async () => {
    process.env.INFINIBOT_VOICE_PACK_BASE = baseUrl;
    vi.doMock("../../license/state.js", () => ({ hasFeature: () => true }));
    vi.doMock("../../license/middleware.js", () => ({}));
    vi.doMock("../../voice/voice-pack-catalog.js", async () => {
      const actual = await vi.importActual<typeof import("../../voice/voice-pack-catalog.js")>(
        "../../voice/voice-pack-catalog.js",
      );
      const bad = "0".repeat(64); // valid-looking but wrong digest
      const packs = {
        ...actual.VOICE_PACKS,
        "piper-en": { ...actual.VOICE_PACKS["piper-en"], sha256: bad },
      };
      return {
        ...actual,
        VOICE_PACKS: packs,
        getVoicePack: (id: string) => (packs as Record<string, unknown>)[id],
        listVoicePacks: () => Object.values(packs),
      };
    });
    const handlers = await freshHandlers();
    const { opts, respond, events } = makeOpts({ id: "piper-en" });
    await handlers["voicePack.download"](opts);

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "CHECKSUM_MISMATCH" }),
    );
    const failed = events.find(
      (e) =>
        e.event === "voicePack:progress" && (e.payload as { phase: string }).phase === "failed",
    );
    expect(failed).toBeTruthy();
    // Partial file was unlinked.
    const mod = await import("./voice-pack.js");
    const entry = (await import("../../voice/voice-pack-catalog.js")).getVoicePack("piper-en")!;
    await expect(fs.stat(mod.packFilePath(entry))).rejects.toThrow();
  });
});
