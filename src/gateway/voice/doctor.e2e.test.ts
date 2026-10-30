import { afterEach, describe, expect, it, vi } from "vitest";

import type { VoiceConfig } from "./config.js";
import { runDoctor } from "./doctor.js";

afterEach(() => vi.unstubAllGlobals());

function webStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
}

/**
 * E2E cloud path: doctor → Groq STT + ElevenLabs TTS, both mocked. Proves the
 * registry → adapter → roundtrip wiring end to end with no network.
 */
describe("voice doctor — cloud e2e (mocked Groq + ElevenLabs)", () => {
  it("passes both STT and TTS roundtrips", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any, init: any) => {
        const u = String(url);
        calls.push(u);
        if (u.includes("groq.com")) {
          expect(init.headers.Authorization).toBe("Bearer groq-key");
          return { ok: true, json: async () => ({ text: "" }) };
        }
        if (u.includes("elevenlabs.io")) {
          expect(init.headers["xi-api-key"]).toBe("xi-key");
          return { ok: true, body: webStream(new Uint8Array([0xff, 0xfb, 0x00, 0x00])) };
        }
        throw new Error(`unexpected fetch to ${u}`);
      }),
    );

    const cfg: VoiceConfig = {
      mode: "cloud",
      stt: { provider: "groq", model: "whisper-large-v3-turbo", apiKey: "groq-key" },
      tts: { provider: "elevenlabs", voice: "v", apiKey: "xi-key" },
    };

    const report = await runDoctor(cfg);

    expect(report.ok).toBe(true);
    expect(report.checks).toHaveLength(2);
    expect(report.checks[0]).toMatchObject({ ok: true });
    expect(report.checks[1]).toMatchObject({ ok: true });
    expect(calls.some((u) => u.includes("groq.com"))).toBe(true);
    expect(calls.some((u) => u.includes("elevenlabs.io"))).toBe(true);
  });

  it("reports FAIL when the STT provider errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any) => {
        if (String(url).includes("groq.com")) {
          return { ok: false, status: 500, text: async () => "boom" };
        }
        return { ok: true, body: webStream(new Uint8Array([1])) };
      }),
    );
    const cfg: VoiceConfig = {
      mode: "cloud",
      stt: { provider: "groq", apiKey: "k" },
      tts: { provider: "elevenlabs", apiKey: "k" },
    };
    const report = await runDoctor(cfg);
    expect(report.ok).toBe(false);
    expect(report.checks[0].ok).toBe(false);
    expect(report.checks[0].error).toMatch(/groq STT 500/);
  });
});
