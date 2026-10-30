#!/usr/bin/env node
/**
 * Infinite-Canvas Walkthrough — build pipeline.
 *
 *   node build.mjs --config <path/to/canvas.json> [--slug <slug>] [--out <dir>]
 *
 * Reads a canvas.json (see SKILL.md for shape), inlines NODES/LINKS/TOUR/DIA
 * into templates/canvas.template.html, copies the images from <config-dir>/img
 * into <out>/img, writes <out>/index.html. Asserts the four bg-layer IDs are
 * present in the output (no flat-black escape).
 *
 * Default output: /tmp/<slug>-canvas-build/
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const configPath = arg("config");
if (!configPath) {
  console.error("usage: build.mjs --config <canvas.json> [--slug s] [--out dir]");
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const slug = arg("slug", config.slug || "canvas");
const outDir = arg("out", `/tmp/${slug}-canvas-build`);
const cfgDir = path.dirname(path.resolve(configPath));

fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(path.join(outDir, "img"), { recursive: true });

// ── load template + theme + diagrams ──────────────────────────────
const templateHtml = fs.readFileSync(path.join(__dirname, "templates/canvas.template.html"), "utf8");
const themeCss = fs.readFileSync(path.join(__dirname, "templates/canvas.theme.css"), "utf8");
const diagramsDir = path.join(__dirname, "templates/diagrams");
const DIA = {};
for (const f of fs.readdirSync(diagramsDir)) {
  if (!f.endsWith(".svg")) continue;
  DIA[path.basename(f, ".svg")] = fs.readFileSync(path.join(diagramsDir, f), "utf8").trim();
}

// ── color palette → CSS var ──────────────────────────────────────
const COLOR_VAR = {
  red: "var(--red)", teal: "var(--teal)", amber: "var(--amber)",
  violet: "var(--violet)", blue: "var(--blue)", orange: "var(--orange)", gold: "var(--gold)",
};

// ── markdown-lite: **bold** *em* `code` and paragraph splits ─────
function mdInline(s) {
  return String(s ?? "")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
}
function mdParas(s) {
  return String(s ?? "")
    .split(/\n{2,}/)
    .map((p) => `<p>${mdInline(p.trim())}</p>`)
    .join("");
}

// ── node-kind → HTML ─────────────────────────────────────────────
function renderNode(n) {
  switch (n.kind) {
    case "title": {
      const hints = (n.hints || []).map((h) => `<span>${mdInline(h)}</span>`).join("");
      return `<div class="pad">
  <div class="mark"><div class="ring"></div><div class="brand">${n.brand || ""}</div></div>
  <h1>${n.h1 || ""}</h1>
  <div class="sub">${mdInline(n.sub || "")}</div>
  ${n.edition ? `<div class="edition">${n.edition}</div>` : ""}
  ${hints ? `<div class="hint">${hints}</div>` : ""}
</div>`;
    }
    case "text": {
      return `<div class="pad">
  ${n.kicker ? `<div class="kicker">${n.kicker}</div>` : ""}
  ${n.h2 ? `<h2>${n.h2}</h2>` : ""}
  ${n.h3 ? `<h3>${n.h3}</h3>` : ""}
  ${mdParas(n.body || "")}
</div>`;
    }
    case "shot": {
      // InfiniBot mark — compact orbit + iso diamond + gold crystal, matches docs/assets/landing/logos/infinibot-app-icon.svg
      const mark = `<svg class="ib-mark" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><defs><linearGradient id="ibmGold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4d77a"/><stop offset="1" stop-color="#d4af37"/></linearGradient></defs><ellipse cx="256" cy="276" rx="186" ry="76" fill="none" stroke="#d4af37" stroke-opacity=".75" stroke-width="14" stroke-dasharray="40 24"/><polygon points="256,150 412,276 256,402 100,276" fill="#0b0a06" stroke="url(#ibmGold)" stroke-width="18" stroke-linejoin="round"/><polygon points="256,224 308,276 256,328 204,276" fill="url(#ibmGold)"/><circle cx="430" cy="252" r="22" fill="url(#ibmGold)"/></svg>`;
      return `<div class="shot-frame">
  <div class="shot-bar">${mark}<span>${n.label || ""}</span></div>
  <img src="img/${n.img}" alt="${(n.label || "").replace(/"/g, "&quot;")}">
</div>
${n.caption ? `<div class="shot-cap">${mdInline(n.caption)}</div>` : ""}`;
    }
    case "diagram": {
      const svg = DIA[n.diagram];
      if (!svg) throw new Error(`Unknown diagram '${n.diagram}'. Available: ${Object.keys(DIA).join(", ")}`);
      return `<div class="pad">${svg}${n.caption ? `<div class="dia-cap">${mdInline(n.caption)}</div>` : ""}</div>`;
    }
    case "stats": {
      const items = (n.stats || []).map((s) => `<div class="stat"><div class="n">${s.n}</div><div class="l">${mdInline(s.l)}</div></div>`).join("");
      return `<div class="pad"><div class="stats">${items}</div></div>`;
    }
    case "callout": {
      return `<div class="pad"><div class="callout"><span class="ico">${n.icon || "◆"}</span><p>${mdInline(n.body || "")}</p></div></div>`;
    }
    case "steps": {
      const rows = (n.steps || []).map((s) => `<div class="step"><div class="num">${s.num}</div><div class="t">${mdInline(s.t)}</div></div>`).join("");
      return `<div class="pad"><div class="steps">${rows}</div></div>`;
    }
    case "cmp": {
      const cols = (n.cols || []).map((c) => {
        const lis = (c.items || []).map((it) => `<li>${mdInline(it)}</li>`).join("");
        return `<div class="col${c.hot ? " hot" : ""}"><div class="ch">${c.ch}</div><ul>${lis}</ul></div>`;
      }).join("");
      return `<div class="pad"><div class="cmp">${cols}</div></div>`;
    }
    case "term": {
      const lines = (n.lines || []).join("\n");
      return `<div class="pad"><div class="term"><div class="term-bar"><i></i><i></i><i></i><span>${n.lang || "shell"}</span></div><pre>${mdInline(lines)}</pre></div></div>`;
    }
    default:
      throw new Error(`Unknown node kind: ${n.kind}`);
  }
}

// ── transform config nodes → engine NODES[] ──────────────────────
const engineNodes = (config.nodes || []).map((n) => {
  const cls = n.kind === "title" ? "title"
    : n.kind === "shot" ? "shot"
    : n.kind === "diagram" ? "diagram"
    : "";
  const cl = n.cl ? (COLOR_VAR[n.cl] || n.cl) : undefined;
  return {
    id: n.id,
    x: n.x, y: n.y, w: n.w,
    cls,
    ...(cl ? { cl } : {}),
    ...(n.part ? { part: n.part } : {}),
    html: renderNode(n),
  };
});

const engineLinks = config.links || [];
const engineTour = config.tour || [];

// ── copy screenshot images ───────────────────────────────────────
const srcImg = path.join(cfgDir, "img");
if (fs.existsSync(srcImg)) {
  for (const f of fs.readdirSync(srcImg)) {
    fs.copyFileSync(path.join(srcImg, f), path.join(outDir, "img", f));
  }
}

// ── world size ───────────────────────────────────────────────────
const worldW = config.world?.w || 9600;
const worldH = config.world?.h || 6400;

// ── inline theme (with world size substitutions) ─────────────────
const themeFilled = themeCss
  .replace(/__WORLD_W__/g, String(worldW))
  .replace(/__WORLD_H__/g, String(worldH));

// ── inline NODES / LINKS / TOUR / DIA into template ──────────────
const html = templateHtml
  .replace("__THEME_CSS__", themeFilled)
  .replace(/__WORLD_W__/g, String(worldW))
  .replace(/__WORLD_H__/g, String(worldH))
  .replace(/__TITLE__/g, config.title || "Infinite Canvas Walkthrough")
  .replace(/__SUBTITLE__/g, config.subtitle || "")
  .replace(/__BRAND__/g, config.brand || "InfiniBot · Holo-Canvas")
  .replace("__NODES__", JSON.stringify(engineNodes))
  .replace("__LINKS__", JSON.stringify(engineLinks))
  .replace("__TOUR__", JSON.stringify(engineTour))
  .replace("__DIA__", JSON.stringify(DIA));

// ── ASSERT the four bg-layer IDs are present (no flat-black escape) ──
const required = ["#bg-radial", "#bg-grid", "#stars", "#vignette"];
for (const id of required) {
  if (!html.includes(id.slice(1))) {
    throw new Error(`build.mjs: required bg layer id "${id}" missing — visual contract broken`);
  }
}

const outFile = path.join(outDir, "index.html");
fs.writeFileSync(outFile, html);
console.log(`built ${outFile} (${(html.length / 1024).toFixed(1)} KB, ${engineNodes.length} nodes, ${engineLinks.length} links, ${engineTour.length} tour stops)`);
