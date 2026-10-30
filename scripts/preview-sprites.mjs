#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const kinds = [
  "claude-coder",
  "codex-coder",
  "opencode-coder",
  "gemini-coder",
  "voice",
  "federation",
  "review",
  "mesh",
  "unknown",
];

const variants = [
  ["ember scarf", "#ee6b2f"],
  ["sky cap", "#23a6d5"],
  ["mint halo", "#2dd88f"],
  ["violet visor", "#9a6cff"],
];

function inlineSvg(kind, color) {
  const file = resolve(root, "ui/public/assets/sprites/agents", `${kind}.svg`);
  return readFileSync(file, "utf8")
    .replace(/<\?xml[^>]*>/g, "")
    .replace("<svg ", `<svg style="color:${color}" `);
}

const cards = kinds
  .map((kind) => {
    const rows = variants
      .map(
        ([name, color]) => `
          <div class="variant">
            <div class="variant-label">${name}</div>
            ${inlineSvg(kind, color)}
          </div>`,
      )
      .join("");
    return `<section class="card"><h2>${kind}</h2><div class="variants">${rows}</div></section>`;
  })
  .join("");

const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>InfiniBot Agent Sprite Preview</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; background: #090d16; color: #e5e7eb; }
    header { position: sticky; top: 0; z-index: 1; padding: 18px 24px; background: rgba(9,13,22,.92); border-bottom: 1px solid #1f2937; }
    h1 { margin: 0; font-size: 18px; letter-spacing: 0; }
    main { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 16px; padding: 18px; }
    .card { background: #101827; border: 1px solid #263244; border-radius: 8px; padding: 14px; }
    h2 { margin: 0 0 12px; font-size: 14px; font-weight: 700; color: #f8fafc; }
    .variants { display: grid; gap: 12px; }
    .variant { display: grid; grid-template-columns: 92px 1fr; gap: 12px; align-items: center; }
    .variant-label { color: #94a3b8; font-size: 12px; }
    svg { width: 100%; height: auto; image-rendering: pixelated; background: #0b1220; border: 1px solid #1e293b; border-radius: 6px; }
  </style>
</head>
<body>
  <header><h1>InfiniBot Agent Sprite Preview — 9 kinds × 4 run variants</h1></header>
  <main>${cards}</main>
</body>
</html>`;

writeFileSync("/tmp/sprite-preview.html", html);
console.log("/tmp/sprite-preview.html");
