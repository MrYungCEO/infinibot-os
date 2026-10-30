import puppeteer from "puppeteer";
import { fileURLToPath, pathToFileURL } from "url";
import { dirname, join } from "path";
import { writeFileSync } from "fs";

const __dir = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cinematicHtml = pathToFileURL(join(__dir, "src/ui/views/agent-ops/iso/__test.html")).href;
const minimapHtml = pathToFileURL(join(__dir, "src/ui/components/__test.html")).href;

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});

function attachLogs(page, tag) {
  page.on("console", (m) => console.log(`[${tag}:${m.type()}]`, m.text()));
  page.on("pageerror", (e) => console.log(`[${tag}:ERR]`, e.message));
}

// ── CINEMATIC ─────────────────────────────────────────────────────────────────
{
  const page = await browser.newPage();
  await page.setViewport({ width: 960, height: 600, deviceScaleFactor: 1 });
  attachLogs(page, "cine");
  await page.goto(cinematicHtml, { waitUntil: "load" });
  await page.waitForFunction(() => !!window.__cinematic && !!window.cinematicCamera);

  // 1) drone orbit — wait for auto-engage (quietMs 1500), then let orbit run.
  await page.waitForFunction(() => window.cinematicCamera.isDroneMode() === true, { timeout: 8000 });
  await sleep(1400);
  await page.screenshot({ path: "/tmp/cinematic-drone-orbit.png" });
  console.log("drone mode:", await page.evaluate(() => window.cinematicCamera.isDroneMode()));

  // 2) close shot on a single agent. (evaluate awaits the shot's promise.)
  await page.evaluate(() => window.cinematicCamera.exitDroneMode());
  await page.evaluate(() => window.cinematicCamera.cinematicShot(["a3"], { type: "close" }));
  await page.evaluate(() => window.__bumpActivity()); // keep world "live" so drone won't re-grab
  await sleep(200);
  await page.screenshot({ path: "/tmp/cinematic-close-shot.png" });

  // 3) reveal shot over the build cluster — screenshot the moment the dolly lands.
  await page.evaluate(() => window.cinematicCamera.cinematicShot(["a1", "a2"], { type: "reveal" }));
  await page.evaluate(() => window.__bumpActivity());
  await sleep(200);
  await page.screenshot({ path: "/tmp/cinematic-reveal.png" });

  // 4) recordCinematic → 2s WebM blob, pulled out as base64.
  //    Drive continuous orbit motion under the recording (void call, no dangling promise).
  await page.evaluate(() => window.cinematicCamera.enterDroneMode());
  const b64 = await page.evaluate(async () => {
    const blob = await window.cinematicCamera.recordCinematic({ durationMs: 2000, fps: 30 });
    if (!blob || blob.size === 0) return { error: "empty blob", size: blob?.size ?? 0 };
    const buf = await blob.arrayBuffer();
    let bin = "";
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return { type: blob.type, size: blob.size, b64: btoa(bin) };
  });
  if (b64.b64) {
    writeFileSync("/tmp/cinematic-test.webm", Buffer.from(b64.b64, "base64"));
    console.log(`WEBM ok: type=${b64.type} size=${b64.size} bytes -> /tmp/cinematic-test.webm`);
  } else {
    console.log("WEBM FAILED:", JSON.stringify(b64));
  }
  await page.close();
}

// ── MINIMAP ───────────────────────────────────────────────────────────────────
{
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 600, deviceScaleFactor: 2 });
  attachLogs(page, "mm");
  await page.goto(minimapHtml, { waitUntil: "load" });
  await page.waitForFunction(() => !!document.querySelector("world-minimap")?.shadowRoot?.querySelector("canvas"));
  await sleep(500);

  // compact
  await page.screenshot({ path: "/tmp/minimap-compact.png" });

  // expanded (hover)
  const box = await page.evaluate(() => {
    const el = document.querySelector("world-minimap");
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(box.x, box.y);
  await sleep(700);
  await page.screenshot({ path: "/tmp/minimap-expanded.png" });

  // with viewport moved (prove camera rect tracks) — keep hovered/expanded.
  await page.evaluate(() => window.__moveCamera(300, 800, 500, 300));
  await sleep(400);
  await page.screenshot({ path: "/tmp/minimap-with-viewport.png" });

  // click-to-navigate sanity
  await page.mouse.click(box.x + 20, box.y + 10);
  await sleep(150);
  const nav = await page.evaluate(() => window.__lastNav);
  console.log("minimap click nav ->", JSON.stringify(nav));
  await page.close();
}

await browser.close();
console.log("DONE");
