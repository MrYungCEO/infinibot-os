import { afterEach, describe, expect, it, vi } from "vitest";

import { makeToneWav } from "../audio.js";
import { transcribeBuffer } from "../types.js";
import { createOpenAiStt } from "./openai-stt.js";
import { createOpenAiTts } from "./openai-tts.js";

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

describe("openai STT adapter", () => {
  it("posts to /v1/audio/transcriptions with gpt-4o-transcribe", async () => {
    const fetchMock = vi.fn(async (url: any, init: any) => {
      expect(String(url)).toContain("api.openai.com/v1/audio/transcriptions");
      expect(init.headers.Authorization).toBe("Bearer oa-key");
      expect((init.body as FormData).get("model")).toBe("gpt-4o-transcribe");
      return { ok: true, json: async () => ({ text: "transcribed" }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const stt = createOpenAiStt({ apiKey: "oa-key" });
    expect(await transcribeBuffer(stt, makeToneWav(1))).toBe("transcribed");
  });
});

describe("openai TTS adapter", () => {
  it("posts tts-1 JSON and streams audio", async () => {
    const fetchMock = vi.fn(async (url: any, init: any) => {
      expect(String(url)).toContain("api.openai.com/v1/audio/speech");
      const body = JSON.parse(init.body);
      expect(body.model).toBe("tts-1");
      expect(body.input).toBe("five word phrase here now");
      return { ok: true, body: webStream(new Uint8Array([1, 2])) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const tts = createOpenAiTts({ apiKey: "oa-key" });
    const out = await drain(await tts.synthesize("five word phrase here now"));
    expect(out.length).toBe(2);
    expect(tts.mimeFor("wav")).toBe("audio/wav");
  });
});
