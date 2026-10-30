#!/usr/bin/env node
/**
 * Infinite-Canvas Walkthrough — puppeteer verification gate.
 *
 *   node verify.mjs --build /tmp/<slug>-canvas-build [--url <https://...>]
 *
 * Loads the artifact (file:// or live URL) at 1920x1080 in puppeteer headless,
 * and asserts:
 *   1. __canvas.cam.x changes after flyToNode(TOUR[2].id)
 *   2. every <img> has naturalWidth > 0 (no broken screenshots)
 *   3. at least one diagram <svg> has getCurrentTime() > 0 (animation alive)
 *   4. #links path count > 0 (connectors rendered)
 *   5. zero console errors
 *
 * Snapshots:
 *   <build>/shot-default.png  (initial fit)
 *   <build>/shot-pan.png      (after a tour-step fly)
 *
 * Exits non-zero on any failure. The deploy step MUST gate on this.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const buildDir = arg("build");
const url = arg("url");
if (!buildDir && !url) {
  console.error("usage: verify.mjs --build <dir> | --url <https://...>");
  process.exit(1);
}

// Find puppeteer — try the repo's node_modules, then global.
async function loadPuppeteer() {
  const candidates = [
    path.resolve(__dirname, "../../node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js"),
    path.resolve(__dirname, "../../node_modules/puppeteer"),
    "puppeteer",
  ];
  for (const c of candidates) {
    try { return (await import(c)).default; } catch {}
  }
  throw new Error("puppeteer not found — run `npm i puppeteer` at repo root");
}

const target = url || pathToFileURL(path.join(buildDir, "index.html")).toString();
const snapDir = buildDir || "/tmp";

const puppeteer = await loadPuppeteer();
const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  defaultViewport: { width: 1920, height: 1080 },
});

const errors = [];
const failures = [];
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console.error: ${m.text()}`); });

  await page.goto(target, { waitUntil: "load", timeout: 30_000 });
  // give the load handler (init) time to flyTo + buildLinks
  await new Promise((r) => setTimeout(r, 1500));

  await page.screenshot({ path: path.join(snapDir, "shot-default.png") });

  // 1) cam moves on flyToNode
  const movement = await page.evaluate(() => {
    const c = window.__canvas;
    if (!c) return { ok: false, reason: "window.__canvas missing" };
    const before = { x: c.cam.x, y: c.cam.y };
    const tour = c.NODES.map((n) => n.id);
    const target = c.NODES[Math.min(2, c.NODES.length - 1)]?.id || c.NODES[0]?.id;
    if (!target) return { ok: false, reason: "no NODES" };
    c.flyToNode(target, 0.9);
    return new Promise((resolve) => {
      setTimeout(() => {
        const after = { x: c.cam.x, y: c.cam.y };
        const moved = Math.abs(after.x - before.x) + Math.abs(after.y - before.y);
        resolve({ ok: moved > 1, before, after, moved, target });
      }, 1100);
    });
  });
  if (!movement.ok) failures.push(`camera did not move on flyToNode (moved=${movement.moved}, reason=${movement.reason || ""})`);

  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot({ path: path.join(snapDir, "shot-pan.png") });

  // 2) every <img> has naturalWidth > 0
  const imgs = await page.evaluate(() =>
    Array.from(document.images).map((i) => ({ src: i.src, nw: i.naturalWidth })),
  );
  const broken = imgs.filter((i) => i.nw === 0);
  if (broken.length) failures.push(`broken images: ${broken.map((b) => b.src).join(", ")}`);

  // 3) at least one diagram SVG is animating
  const animOk = await page.evaluate(() => {
    const svgs = Array.from(document.querySelectorAll(".diagram svg, .node.diagram svg"));
    return svgs.some((s) => {
      try { return s.getCurrentTime && s.getCurrentTime() > 0; } catch { return false; }
    });
  });
  if (!animOk && imgs.length >= 0) {
    // Only fail if there are diagrams at all
    const hasDiagrams = await page.evaluate(() => document.querySelectorAll(".node.diagram").length > 0);
    if (hasDiagrams) failures.push("no diagram SVG reports getCurrentTime() > 0 — animation gate failed");
  }

  // 4) #links has paths
  const linkCount = await page.evaluate(() => document.querySelectorAll("#links path").length);
  if (linkCount === 0) failures.push("#links has zero <path> elements — connectors didn't render");

  // 5) console errors
  if (errors.length) failures.push(`console errors:\n  ${errors.join("\n  ")}`);

  // ── report ─────────────────────────────────────────────────
  console.log(JSON.stringify({
    target,
    snapshots: [path.join(snapDir, "shot-default.png"), path.join(snapDir, "shot-pan.png")],
    imgsChecked: imgs.length,
    linkCount,
    animationOk: animOk,
    movement,
    consoleErrors: errors.length,
    failures,
  }, null, 2));
} finally {
  await browser.close();
}

if (failures.length) {
  console.error(`\nverify FAILED with ${failures.length} issue(s).`);
  process.exit(1);
}
console.log("\nverify PASSED");
