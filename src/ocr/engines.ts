/**
 * Local engines for the OCR pipeline:
 *   - RapidOCR (PaddleOCR models on ONNX Runtime, CPU, offline) via a Python
 *     venv — one process per batch of images.
 *   - Poppler (pdfinfo / pdftotext / pdftoppm) for PDF text layers + page renders.
 *   - Native office extractors shared with the Documents workspace.
 *   - Ollama on loopback for the vision-language pass (Qwen VL by preference).
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { docxToMarkdown, pptxToMarkdown, xlsxToMarkdown } from "../documents/extract.js";
import { convertToMarkdown as convertWithMarkitdown } from "../reports/helpers/markitdown.js";
import { assertLocalEndpoint, offlineSubprocessEnv, type OcrRuntimeConfig } from "./local-only.js";
import type { OcrEngines, OcrImageResult } from "./types.js";
import { coerceString } from "../shared/text/coerce.js";

const execFileAsync = promisify(execFile);

/** Python side: OCR a batch of images, or convert one to PNG. Embedded so dist builds carry it. */
export const OCR_RUNNER_PY = String.raw`
import json, sys, os
def load_image(p):
    from PIL import Image
    try:
        import pillow_heif
        pillow_heif.register_heif_opener()
    except Exception:
        pass
    im = Image.open(p)
    try:
        from PIL import ImageOps
        im = ImageOps.exif_transpose(im)
    except Exception:
        pass
    if im.mode not in ("RGB", "L"):
        im = im.convert("RGB")
    return im
def main():
    cmd = sys.argv[1]
    if cmd == "probe":
        import rapidocr_onnxruntime
        print(json.dumps({"ok": True, "engine": "rapidocr-onnxruntime " + getattr(rapidocr_onnxruntime, "__version__", "")}))
        return
    if cmd == "topng":
        im = load_image(sys.argv[2])
        im.save(sys.argv[3], "PNG")
        print(json.dumps({"ok": True}))
        return
    if cmd == "ocr":
        import numpy as np
        from rapidocr_onnxruntime import RapidOCR
        eng = RapidOCR()
        out = []
        for p in sys.argv[2:]:
            im = load_image(p).convert("RGB")
            w, h = im.size
            res, _ = eng(np.array(im)[:, :, ::-1])
            lines = []
            for r in (res or []):
                box, text, conf = r[0], r[1], float(r[2])
                xs = [pt[0] for pt in box]; ys = [pt[1] for pt in box]
                lines.append({"text": text, "confidence": conf, "box": [float(min(xs)), float(min(ys)), float(max(xs)), float(max(ys))]})
            out.append({"lines": lines, "width": w, "height": h})
        sys.stdout.write(json.dumps({"ok": True, "results": out}))
        return
    raise SystemExit("unknown command")
main()
`;

function runnerPath(stateDir: string): string {
  const dir = path.join(stateDir, "ocr");
  const file = path.join(dir, "ocr_runner.py");
  try {
    if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== OCR_RUNNER_PY) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, OCR_RUNNER_PY);
    }
  } catch {
    /* fall through: execFile will surface the error */
  }
  return file;
}

async function hasBinary(name: string): Promise<boolean> {
  try {
    await execFileAsync("which", [name], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Lay OCR lines out as text: group boxes into rows by vertical overlap, sort
 * rows top→bottom and boxes left→right; wide horizontal gaps become " | " so
 * table columns stay readable.
 */
export function layoutLines(result: OcrImageResult): string {
  const lines = [...result.lines].filter((l) => l.text.trim());
  if (!lines.length) return "";
  lines.sort((a, b) => a.box[1] - b.box[1]);
  const rows: (typeof lines)[] = [];
  for (const l of lines) {
    const mid = (l.box[1] + l.box[3]) / 2;
    const row = rows.find((r) => {
      const top = Math.min(...r.map((x) => x.box[1]));
      const bot = Math.max(...r.map((x) => x.box[3]));
      return mid >= top && mid <= bot;
    });
    if (row) row.push(l);
    else rows.push([l]);
  }
  const out: string[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.box[0] - b.box[0]);
    const h = Math.max(8, ...row.map((x) => x.box[3] - x.box[1]));
    let s = row[0].text;
    for (let i = 1; i < row.length; i++) {
      const gap = row[i].box[0] - row[i - 1].box[2];
      s += gap > h * 2.5 ? " | " : " ";
      s += row[i].text;
    }
    out.push(s);
  }
  return out.join("\n");
}

export function meanConfidence(result: OcrImageResult): number | null {
  const ls = result.lines.filter((l) => l.text.trim());
  if (!ls.length) return null;
  // Weight by text length: a long confident line matters more than a stray glyph.
  let w = 0;
  let s = 0;
  for (const l of ls) {
    const n = Math.max(1, l.text.length);
    w += n;
    s += l.confidence * n;
  }
  return Math.round((s / w) * 1000) / 1000;
}

interface OllamaModelInfo {
  name: string;
}

/**
 * GPU gate for vision calls (the local runtime manager). `acquire` waits until
 * Ollama owns the GPU (never forcing a swap mid-chat); `alternate` names an
 * already-running vision-capable runtime (e.g. vLLM serving a VL model) to use
 * instead of swapping back to Ollama.
 */
export type VisionGate = {
  acquire: (model: string) => Promise<{ release: () => void } | null>;
  /**
   * `verifiedLocal`: the gate checked the host is bound to this machine (e.g.
   * vLLM on docker0, 172.17.0.1). Anything else must be loopback.
   */
  alternate?: () => Promise<{ baseUrl: string; model: string; verifiedLocal?: boolean } | null>;
};

export function createVisionClient(
  cfg: OcrRuntimeConfig,
  fetchImpl: typeof fetch = fetch,
  gate?: VisionGate,
): OcrEngines["vl"] {
  if (!cfg.ollamaUrl || cfg.vlMode === "off") return null;
  const base = assertLocalEndpoint(cfg.ollamaUrl);
  let cached: { model: string | null; at: number } | null = null;

  const post = async (p: string, body: unknown, timeoutMs: number) => {
    // Re-validated per call: the URL cannot be swapped to a remote host later.
    const url = `${assertLocalEndpoint(base)}${p}`;
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok)
      throw new Error(`ollama ${p} → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as Record<string, unknown>;
  };

  const pickModel = async (): Promise<string | null> => {
    if (cfg.vlModel) return cfg.vlModel;
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.model;
    let model: string | null = null;
    try {
      const res = await fetchImpl(`${assertLocalEndpoint(base)}/api/tags`, {
        signal: AbortSignal.timeout(5000),
      });
      const tags = ((await res.json()) as { models?: OllamaModelInfo[] }).models ?? [];
      const vision: string[] = [];
      for (const m of tags) {
        try {
          const info = await post("/api/show", { model: m.name }, 8000);
          const caps = Array.isArray(info.capabilities) ? (info.capabilities as string[]) : [];
          if (caps.includes("vision")) vision.push(m.name);
        } catch {
          /* skip */
        }
      }
      const rank = (n: string) =>
        /qwen[\d.]*-?vl|qwen3-vl|qwen2\.5vl/i.test(n)
          ? 0
          : /qwen/i.test(n)
            ? 1
            : /vl|vision|llava|minicpm/i.test(n)
              ? 2
              : 3;
      vision.sort((a, b) => rank(a) - rank(b));
      model = vision[0] ?? null;
    } catch {
      model = null;
    }
    cached = { model, at: Date.now() };
    return model;
  };

  return {
    model: pickModel,
    async ask({ images, prompt, timeoutMs = 240_000, interactive = false }) {
      const b64 = images.map((p) => fs.readFileSync(p).toString("base64"));
      const alt = await gate?.alternate?.().catch(() => null);
      if (alt) {
        // OpenAI-style vision on the runtime that already holds the GPU.
        if (!alt.verifiedLocal) assertLocalEndpoint(alt.baseUrl);
        const url = `${alt.baseUrl.replace(/\/+$/, "")}/chat/completions`;
        const res = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: alt.model,
            temperature: 0.1,
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: prompt },
                  ...b64.map((d) => ({
                    type: "image_url",
                    image_url: { url: `data:image/png;base64,${d}` },
                  })),
                ],
              },
            ],
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok)
          throw new Error(
            `vision ${alt.model} → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
          );
        const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
        return { text: String(body.choices?.[0]?.message?.content ?? "").trim(), model: alt.model };
      }
      const model = await pickModel();
      if (!model) throw new Error("no local vision model installed in Ollama");
      const lease = gate && !interactive ? await gate.acquire(model) : null;
      try {
        return await askOllama(model, b64, prompt, timeoutMs);
      } finally {
        lease?.release();
      }
    },
  };

  async function askOllama(model: string, b64: string[], prompt: string, timeoutMs: number) {
    const res = await post(
      "/api/chat",
      {
        model,
        stream: false,
        think: false,
        // No num_ctx: chat (OpenAI-compatible /v1) always runs at the server's
        // default context, and any other value makes Ollama reload the whole
        // model on every switch between a chat turn and an OCR/vision call
        // (measured 41 s for the 27B Qwen VL) — the "stuck" secure chat.
        options: { temperature: 0.1 },
        messages: [{ role: "user", content: prompt, images: b64 }],
      },
      timeoutMs,
    );
    const msg = (res.message ?? {}) as { content?: string };
    return { text: String(msg.content ?? "").trim(), model };
  }
}

export function createLocalEngines(params: {
  cfg: OcrRuntimeConfig;
  stateDir: string;
  fetchImpl?: typeof fetch;
  visionGate?: VisionGate;
}): OcrEngines {
  const { cfg, stateDir } = params;
  let probe: Promise<string | null> | null = null;
  const py = async (args: string[], timeoutMs: number) => {
    const { stdout } = await execFileAsync(cfg.python, ["-I", runnerPath(stateDir), ...args], {
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      env: offlineSubprocessEnv(),
    });
    return JSON.parse(stdout) as Record<string, unknown>;
  };
  return {
    async ocrEngineName() {
      probe ??= (async () => {
        if (!fs.existsSync(cfg.python)) return null;
        try {
          const r = await py(["probe"], 60_000);
          return coerceString(r.engine, "rapidocr").trim();
        } catch {
          return null;
        }
      })();
      const name = await probe;
      if (!name) probe = null; // retry the probe next time (venv may be installed later)
      return name;
    },
    async ocrImages(paths) {
      if (!paths.length) return [];
      const r = await py(["ocr", ...paths], 120_000 + paths.length * 30_000);
      return (r.results as OcrImageResult[]) ?? [];
    },
    async toPng(input, outDir) {
      const out = path.join(outDir, `${path.basename(input).replace(/[^\w.-]+/g, "_")}.png`);
      await py(["topng", input, out], 60_000);
      return out;
    },
    async pdfPageCount(pdf) {
      const { stdout } = await execFileAsync("pdfinfo", [pdf], { timeout: 30_000 });
      const m = /^Pages:\s+(\d+)/m.exec(stdout);
      return m ? Number(m[1]) : 0;
    },
    async pdfPageText(pdf, page) {
      const { stdout } = await execFileAsync(
        "pdftotext",
        ["-layout", "-f", String(page), "-l", String(page), pdf, "-"],
        { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 },
      );
      return stdout.replace(/\f/g, "").trimEnd();
    },
    async pdfRenderPage(pdf, page, outDir, dpi = 200) {
      const prefix = path.join(outDir, `p${page}`);
      await execFileAsync(
        "pdftoppm",
        [
          "-r",
          String(dpi),
          "-png",
          "-singlefile",
          "-f",
          String(page),
          "-l",
          String(page),
          pdf,
          prefix,
        ],
        { timeout: 120_000 },
      );
      return `${prefix}.png`;
    },
    async nativeText(filePath, ext) {
      const data = fs.readFileSync(filePath);
      if (ext === ".docx") return docxToMarkdown(data);
      if (ext === ".pptx") return pptxToMarkdown(data);
      if (ext === ".xlsx") return xlsxToMarkdown(data);
      if ([".txt", ".md", ".csv", ".json", ".log"].includes(ext)) return data.toString("utf8");
      // Everything else (doc/odt/rtf/epub/html…) through the shared markitdown venv.
      const r = await convertWithMarkitdown(filePath, { timeoutMs: 90_000 });
      return r.ok ? (r.markdown ?? null) : null;
    },
    vl: createVisionClient(cfg, params.fetchImpl, params.visionGate),
  };
}

export async function popplerAvailable(): Promise<boolean> {
  return (await hasBinary("pdftoppm")) && (await hasBinary("pdftotext"));
}
