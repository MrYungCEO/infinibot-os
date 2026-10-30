import { afterEach, describe, expect, it, vi } from "vitest";

import { makeToneWav } from "../audio.js";
import { transcribeBuffer } from "../types.js";
import { createGroqStt, prepareAudio } from "./groq-stt.js";

afterEach(() => vi.unstubAllGlobals());

describe("groq STT adapter", () => {
  it("POSTs multipart audio with bearer auth and returns the transcript", async () => {
    const fetchMock = vi.fn(async (url: any, init: any) => {
      expect(String(url)).toContain("groq.com/openai/v1/audio/transcriptions");
      expect(init.method).toBe("POST");
      expect(init.headers.Authorization).toBe("Bearer test-key");
      expect(init.body).toBeInstanceOf(FormData);
      expect((init.body as FormData).get("model")).toBe("whisper-large-v3-turbo");
      return { ok: true, json: async () => ({ text: "  hello world  " }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    const stt = createGroqStt({ apiKey: "test-key" });
    const text = await transcribeBuffer(stt, makeToneWav(1), { encoding: "wav" });

    expect(text).toBe("hello world");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("throws a descriptive error on non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 401, text: async () => "bad key" })),
    );
    const stt = createGroqStt({ apiKey: "x" });
    await expect(transcribeBuffer(stt, makeToneWav(1))).rejects.toThrow(/groq STT 401/);
  });
});

describe("prepareAudio", () => {
  it("passes through an existing RIFF/WAV buffer", () => {
    const wav = makeToneWav(1);
    const out = prepareAudio(wav, { encoding: "wav" });
    expect(out.mime).toBe("audio/wav");
    expect(out.bytes.toString("ascii", 0, 4)).toBe("RIFF");
  });

  it("wraps raw PCM into a WAV container", () => {
    const pcm = Buffer.alloc(3200); // 0.1s of 16kHz silence
    const out = prepareAudio(pcm, { encoding: "pcm" });
    expect(out.bytes.toString("ascii", 0, 4)).toBe("RIFF");
    expect(out.bytes.length).toBe(pcm.length + 44);
  });

  it("keeps webm container + mime", () => {
    const out = prepareAudio(Buffer.from([1, 2, 3]), { encoding: "webm" });
    expect(out.mime).toBe("audio/webm");
    expect(out.filename).toBe("audio.webm");
  });
});
