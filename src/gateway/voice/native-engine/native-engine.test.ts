import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { downloadFile, measure, modelsPresent } from "./fetch-models.js";
import {
  chooseWhisperSize,
  localPath,
  whisperModel,
  whisperSizeFrom,
  type ModelFile,
} from "./models.js";
import { splitText } from "./server.js";
import { decodeWav, encodeWav16, resample, toWhisperInput } from "./wav.js";

describe("wav", () => {
  it("round-trips 16-bit WAV and resamples to 16 kHz", async () => {
    const tone = new Float32Array(24000).map((_, i) => Math.sin(i / 10) * 0.5);
    const wav = encodeWav16(tone, 24000);
    const { samples, sampleRate } = decodeWav(wav);
    expect(sampleRate).toBe(24000);
    expect(samples.length).toBe(24000);
    expect(Math.abs(samples[100]! - tone[100]!)).toBeLessThan(1e-3);
    expect((await toWhisperInput(wav)).length).toBe(16000);
    expect(resample(tone, 24000, 16000).length).toBe(16000);
  });

  it("decodes stereo float32 WAV (browser encoders)", () => {
    const n = 4;
    const data = Buffer.alloc(n * 2 * 4);
    for (let i = 0; i < n; i++) {
      data.writeFloatLE(0.5, i * 8);
      data.writeFloatLE(-0.5, i * 8 + 4);
    }
    const h = Buffer.alloc(44);
    h.write("RIFF", 0, "ascii");
    h.writeUInt32LE(36 + data.length, 4);
    h.write("WAVEfmt ", 8, "ascii");
    h.writeUInt32LE(16, 16);
    h.writeUInt16LE(3, 20);
    h.writeUInt16LE(2, 22);
    h.writeUInt32LE(16000, 24);
    h.writeUInt32LE(16000 * 8, 28);
    h.writeUInt16LE(8, 32);
    h.writeUInt16LE(32, 34);
    h.write("data", 36, "ascii");
    h.writeUInt32LE(data.length, 40);
    const { samples } = decodeWav(Buffer.concat([h, data]));
    expect([...samples]).toEqual([0, 0, 0, 0]);
  });
});

describe("models", () => {
  it("chooses the speech model by memory", () => {
    expect(chooseWhisperSize(8)).toBe("base");
    expect(chooseWhisperSize(32)).toBe("small");
    expect(whisperSizeFrom("Systran/faster-whisper-small", 4)).toBe("small");
    expect(whisperModel("base").repo).toBe("onnx-community/whisper-base");
  });

  it("splits long text for Kokoro on sentence ends", () => {
    const parts = splitText(`${"Hello there. ".repeat(40)}Done!`, 100);
    expect(parts.every((p) => p.length <= 100)).toBe(true);
    expect(parts.join(" ").replace(/\s+/g, " ")).toContain("Done!");
  });
});

describe("resumable model download", () => {
  const body = Buffer.alloc(200_000, 7);
  let server: http.Server;
  let dir: string;
  let ranges: string[] = [];
  let failAfter: number | null = null;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ib-vengine-"));
    server = http.createServer((req, res) => {
      if (req.method === "HEAD") {
        res.writeHead(200, { "content-length": body.length });
        return res.end();
      }
      const m = /bytes=(\d+)-/.exec(req.headers.range ?? "");
      ranges.push(req.headers.range ?? "none");
      const start = m ? Number(m[1]) : 0;
      res.writeHead(m ? 206 : 200, {
        "content-length": body.length - start,
        ...(m ? { "content-range": `bytes ${start}-${body.length - 1}/${body.length}` } : {}),
      });
      if (failAfter !== null) {
        // Flush part of the file, then drop the connection.
        res.write(body.subarray(start, start + failAfter), () =>
          setTimeout(() => res.destroy(), 30),
        );
        return;
      }
      res.end(body.subarray(start));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    process.env.INFINIBOT_VOICE_MODEL_HOST = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => {
    server.close();
    delete process.env.INFINIBOT_VOICE_MODEL_HOST;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("continues from the .part file after an interrupted download", async () => {
    const file: ModelFile = { repo: "test/repo", file: "onnx/model.onnx", approxBytes: 1 };
    const sizes = await measure([file], dir);
    expect(sizes[0]).toMatchObject({ total: body.length, have: 0, done: false });

    failAfter = 50_000;
    let first = 0;
    await expect(downloadFile(file, dir, (n) => (first += n))).rejects.toThrow();
    const part = `${localPath(dir, file)}.part`;
    const partial = fs.statSync(part).size;
    expect(partial).toBeGreaterThan(0);
    expect((await measure([file], dir))[0]!.have).toBe(partial);

    failAfter = null;
    ranges = [];
    let second = 0;
    await downloadFile(file, dir, (n) => (second += n));
    expect(ranges).toEqual([`bytes=${partial}-`]);
    expect(second).toBe(body.length); // reports bytes already on disk + new ones
    expect(fs.readFileSync(localPath(dir, file)).equals(body)).toBe(true);
    expect(modelsPresent([file], dir)).toBe(true);
    expect((await measure([file], dir))[0]!.done).toBe(true);
  });
});
