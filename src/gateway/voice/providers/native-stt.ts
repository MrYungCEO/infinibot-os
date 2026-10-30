/**
 * Native STT — shells out to a whisper.cpp CLI binary. Metal on Mac / CUDA on
 * Linux are selected by the binary that was built/downloaded; CPU is only ever
 * used when the user explicitly chose native on a machine without a GPU.
 *
 * Batch provider: buffer audio, write a temp WAV, run the binary, read stdout.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import type { SttProvider, SttStartOptions, SttStream } from "../types.js";
import { wavWrap } from "../audio.js";
import { whisperBinaryPath, whisperModelPath } from "../native/paths.js";

const pExecFile = promisify(execFile);

export function createNativeStt(opts: { model?: string; binary?: string }): SttProvider {
  const binary = opts.binary || whisperBinaryPath();
  const modelPath = whisperModelPath(opts.model || "ggml-base.en");

  return {
    name: "native",
    start(start?: SttStartOptions): SttStream {
      const chunks: Buffer[] = [];
      return {
        pushAudio(chunk) {
          chunks.push(chunk);
        },
        async end() {
          if (!fs.existsSync(binary)) {
            throw new Error(
              `whisper.cpp binary not found at ${binary} — run \`infinibot voice up --native\` to install it`,
            );
          }
          if (!fs.existsSync(modelPath)) {
            throw new Error(
              `whisper model not found at ${modelPath} — run \`infinibot voice up --native\``,
            );
          }
          const raw = Buffer.concat(chunks);
          const wav =
            raw.length >= 4 && raw.toString("ascii", 0, 4) === "RIFF"
              ? raw
              : wavWrap(raw, start?.sampleRate ?? 16000);

          const tmp = path.join(os.tmpdir(), `infinibot-stt-${process.pid}-${Date.now()}.wav`);
          fs.writeFileSync(tmp, wav);
          try {
            const args = ["-m", modelPath, "-f", tmp, "-nt", "-otxt", "-of", tmp];
            if (start?.language) args.push("-l", start.language);
            await pExecFile(binary, args, { maxBuffer: 16 * 1024 * 1024 });
            // whisper.cpp -otxt writes "<-of>.txt"
            const txt = `${tmp}.txt`;
            const out = fs.existsSync(txt) ? fs.readFileSync(txt, "utf-8") : "";
            fs.rmSync(txt, { force: true });
            return out.replace(/\s+/g, " ").trim();
          } finally {
            fs.rmSync(tmp, { force: true });
          }
        },
      };
    },
  };
}
