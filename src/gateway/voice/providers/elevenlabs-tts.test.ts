import { afterEach, describe, expect, it, vi } from "vitest";

import { createElevenLabsTts } from "./elevenlabs-tts.js";

afterEach(() => vi.unstubAllGlobals());

function webStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
}

async function drain(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

describe("elevenlabs TTS adapter", () => {
  it("streams synthesized audio bytes with xi-api-key auth", async () => {
    const audio = new Uint8Array([0xff, 0xfb, 0x90, 0x00]); // mp3-ish header
    const fetchMock = vi.fn(async (url: any, init: any) => {
      expect(String(url)).toContain("/v1/text-to-speech/");
      expect(String(url)).toContain("/stream");
      expect(init.headers["xi-api-key"]).toBe("xi-test");
      const body = JSON.parse(init.body);
      expect(body.text).toBe("hello there voice");
      expect(body.model_id).toBe("eleven_turbo_v2_5");
      return { ok: true, body: webStream(audio) };
    });
    vi.stubGlobal("fetch", fetchMock);

    const tts = createElevenLabsTts({ apiKey: "xi-test" });
    const out = await drain(await tts.synthesize("hello there voice"));

    expect(out.length).toBe(4);
    expect(tts.mimeFor()).toBe("audio/mpeg");
  });

  it("uses a per-request voice override in the URL", async () => {
    const fetchMock = vi.fn(async (url: any) => {
      expect(String(url)).toContain("/v1/text-to-speech/customVoice/stream");
      return { ok: true, body: webStream(new Uint8Array([1])) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const tts = createElevenLabsTts({ apiKey: "k" });
    await drain(await tts.synthesize("hi", { voice: "customVoice" }));
  });

  it("throws on upstream error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 429, body: null, text: async () => "rate limited" })),
    );
    const tts = createElevenLabsTts({ apiKey: "k" });
    await expect(tts.synthesize("hi")).rejects.toThrow(/elevenlabs TTS 429/);
  });
});
