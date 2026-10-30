#!/usr/bin/env node
/**
 * OpenRouter image generation helper
 *
 * Generates images via OpenRouter using image-capable models (e.g. GPT Image 5.2,
 * gpt-image-1, openai/gpt-image-1, google/gemini-2.5-flash-image-preview).
 *
 * Usage:
 *   node scripts/openrouter-image-gen.mjs \
 *     --prompt "Infographic: the 7 types of AI, clean flat design" \
 *     --out ./out/diagram.png \
 *     --model "openai/gpt-image-1.5" \
 *     --size 1536x1024
 *
 *   node scripts/openrouter-image-gen.mjs --prompts-file prompts.json --out-dir ./out/
 *
 * prompts.json format:
 *   [ { "prompt": "...", "filename": "slide-01.png", "size": "1536x1024" }, ... ]
 *
 * Env:
 *   OPENROUTER_API_KEY (required)
 */

import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

const API_BASE = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "openai/gpt-image-1.5";
const DEFAULT_SIZE = "1536x1024";

function die(msg, code = 1) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(code);
}

async function generateOne({ apiKey, prompt, model, size, referer, title }) {
  const res = await fetch(`${API_BASE}/images/generations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": referer ?? "https://moltbot.local",
      "X-Title": title ?? "moltbot-course-image-gen",
    },
    body: JSON.stringify({
      model,
      prompt,
      size,
      n: 1,
      response_format: "b64_json",
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 500)}`);
  }
  const body = await res.json();
  const item = body?.data?.[0];
  if (!item) throw new Error(`no image in response: ${JSON.stringify(body).slice(0, 300)}`);
  if (item.b64_json) return { buffer: Buffer.from(item.b64_json, "base64"), raw: body };
  if (item.url) {
    const r = await fetch(item.url);
    if (!r.ok) throw new Error(`fetch image url failed: ${r.status}`);
    const ab = await r.arrayBuffer();
    return { buffer: Buffer.from(ab), raw: body };
  }
  throw new Error("response had neither b64_json nor url");
}

async function main() {
  const { values } = parseArgs({
    options: {
      prompt: { type: "string" },
      "prompts-file": { type: "string" },
      out: { type: "string" },
      "out-dir": { type: "string" },
      model: { type: "string", default: DEFAULT_MODEL },
      size: { type: "string", default: DEFAULT_SIZE },
      referer: { type: "string" },
      title: { type: "string" },
    },
    strict: false,
  });

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) die("OPENROUTER_API_KEY env var required");

  // Single prompt mode
  if (values.prompt) {
    if (!values.out) die("--out is required with --prompt");
    const { buffer } = await generateOne({
      apiKey,
      prompt: values.prompt,
      model: values.model,
      size: values.size,
      referer: values.referer,
      title: values.title,
    });
    await fs.mkdir(path.dirname(path.resolve(values.out)), { recursive: true });
    await fs.writeFile(values.out, buffer);
    process.stdout.write(JSON.stringify({ ok: true, file: path.resolve(values.out), model: values.model, size: values.size }) + "\n");
    return;
  }

  // Batch mode
  if (values["prompts-file"]) {
    const outDir = values["out-dir"] || "./out";
    await fs.mkdir(path.resolve(outDir), { recursive: true });
    const raw = await fs.readFile(values["prompts-file"], "utf8");
    const items = JSON.parse(raw);
    if (!Array.isArray(items)) die("prompts-file must be a JSON array");

    const results = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const prompt = item.prompt;
      const filename = item.filename || `image-${String(i + 1).padStart(3, "0")}.png`;
      const model = item.model || values.model;
      const size = item.size || values.size;
      const target = path.join(outDir, filename);
      try {
        process.stderr.write(`[${i + 1}/${items.length}] ${filename} ...\n`);
        const { buffer } = await generateOne({
          apiKey,
          prompt,
          model,
          size,
          referer: values.referer,
          title: values.title,
        });
        await fs.writeFile(target, buffer);
        results.push({ ok: true, file: path.resolve(target), prompt, model, size });
      } catch (err) {
        results.push({ ok: false, file: path.resolve(target), prompt, error: err?.message ?? String(err) });
      }
    }
    process.stdout.write(JSON.stringify({ ok: true, count: results.length, results }, null, 2) + "\n");
    return;
  }

  die("either --prompt + --out, or --prompts-file + --out-dir is required");
}

main().catch((err) => {
  process.stderr.write(`error: ${err?.message ?? err}\n`);
  process.exit(1);
});
