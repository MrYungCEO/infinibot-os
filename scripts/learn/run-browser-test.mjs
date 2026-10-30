#!/usr/bin/env node
/**
 * Run a UI *.browser.test.ts in headless Chrome without the vitest browser
 * provider: esbuild bundles the test (with `vitest` aliased to
 * scripts/learn/vitest-shim.mjs), then puppeteer runs it on a blank page and
 * prints per-test results.
 *
 *   node scripts/learn/run-browser-test.mjs ui/src/learn/guided/engine.browser.test.ts
 *
 * Exits 1 on any failure.
 */
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import puppeteer from "puppeteer";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(process.argv[2] ?? "ui/src/learn/guided/engine.browser.test.ts");
const shim = path.join(here, "vitest-shim.mjs");
const out = await esbuild.build({
  stdin: {
    contents: `import { __run } from ${JSON.stringify(shim)}; import ${JSON.stringify(entry)}; window.__results = __run();`,
    resolveDir: process.cwd(),
    loader: "js",
  },
  bundle: true,
  write: false,
  format: "iife",
  target: "es2022",
  tsconfig: path.resolve(here, "../../ui/tsconfig.json"),
  alias: { vitest: shim },
  // import.meta.glob is a Vite build-time feature; no surfaces in the test bundle.
  define: { "import.meta.glob": "__noGlob" },
  banner: { js: "var __noGlob = () => ({});" },
  logLevel: "error",
});
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? "/opt/google/chrome/chrome",
  headless: "new",
  args: ["--no-sandbox"],
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.message)));
await page.setViewport({ width: 1280, height: 800 });
// A real origin (about:blank has no localStorage).
const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<!doctype html><html><head></head><body></body></html>");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
await page.goto(`http://127.0.0.1:${server.address().port}/`);
await page.addScriptTag({ content: out.outputFiles[0].text });
const results = await page.evaluate(() => window.__results);
await browser.close();
server.close();
if (!Array.isArray(results)) {
  console.error("test bundle did not run:", errors.slice(0, 5));
  process.exit(1);
}
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.ok ? ` (${r.ms}ms)` : `\n    ${r.error}`}`);
}
if (errors.length) console.log("page errors:", errors.slice(0, 5));
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
