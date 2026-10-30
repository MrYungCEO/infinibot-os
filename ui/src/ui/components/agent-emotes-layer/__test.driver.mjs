// Headless visual-verify driver for <agent-emotes-layer>.
// Loads __test.html, fires each emote type on its demo agent, and captures a
// mid-animation screenshot into /tmp/emotes-<type>.png. Usage: node __test.driver.mjs
import puppeteer from "puppeteer";
import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

const here = dirname(fileURLToPath(import.meta.url));

// Build the component bundle in-memory (no committed artifact).
const built = await esbuild.build({
  entryPoints: [join(here, "__test.entry.ts")],
  bundle: true,
  format: "esm",
  write: false,
});
const bundleJs = built.outputFiles[0].text;

// ESM over file:// is CORS-blocked; serve the folder over http instead.
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript" };
const server = createServer(async (req, res) => {
  const name = (req.url || "/").split("?")[0].replace(/^\//, "") || "__test.html";
  if (name === "favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (name === "__test.bundle.js") {
    res.writeHead(200, { "content-type": "text/javascript" });
    res.end(bundleJs);
    return;
  }
  try {
    const buf = await readFile(join(here, name));
    res.writeHead(200, { "content-type": MIME[extname(name)] || "application/octet-stream" });
    res.end(buf);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const pageUrl = `http://127.0.0.1:${server.address().port}/__test.html`;

const TYPES = ["success", "fail", "blocked", "shipping", "spawn", "levelup", "thinking"];
const OUT = {
  success: "/tmp/emotes-success.png",
  fail: "/tmp/emotes-fail.png",
  blocked: "/tmp/emotes-blocked.png",
  shipping: "/tmp/emotes-shipping.png",
  spawn: "/tmp/emotes-spawn.png",
  levelup: "/tmp/emotes-levelup.png",
  thinking: "/tmp/emotes-thinking.png",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--force-prefers-reduced-motion=false"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 600, deviceScaleFactor: 2 });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(pageUrl, { waitUntil: "networkidle0" });
await page.waitForFunction(
  "window.__emotesReady === true && typeof window.agentEmote === 'function'",
  { timeout: 5000 },
);

// Fire each type in isolation; capture at ~45% of the animation for peak pose.
for (const t of TYPES) {
  await page.evaluate((type) => window.__fireEmote(type), t);
  await sleep(420);
  await page.screenshot({ path: OUT[t] });
  await sleep(900); // let it fully clear before the next
}

// One combined frame for a quick all-at-once sanity look.
await page.evaluate(() => window.__fireAll());
await sleep(420);
await page.screenshot({ path: "/tmp/emotes-all.png" });
await sleep(400);
const active = await page.evaluate(() => document.getElementById("layer").activeCount);

await browser.close();
server.close();
console.log("captured:", Object.values(OUT).join(", "), "+ /tmp/emotes-all.png");
console.log("activeCount after ALL:", active);
if (errors.length) {
  console.log("PAGE ERRORS:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("no page errors");
