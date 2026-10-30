import puppeteer from "puppeteer";
import { fileURLToPath } from "url";
import path from "path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const url = "file://" + path.join(dir, "__test.html");

const out = {
  dawn: "/tmp/atmosphere-dawn.png",
  day: "/tmp/atmosphere-day.png",
  dusk: "/tmp/atmosphere-dusk.png",
  night: "/tmp/atmosphere-night.png",
  "deep-night": "/tmp/atmosphere-deep.png",
};

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--force-color-profile=srgb"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1140, height: 680, deviceScaleFactor: 1 });
// reduced-motion → instant transitions for deterministic shots (also exercises that path)
await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
await page.goto(url, { waitUntil: "networkidle0" });
await new Promise((r) => setTimeout(r, 400));

for (const [phase, file] of Object.entries(out)) {
  await page.evaluate((p) => window.__setPhase(p), phase);
  await new Promise((r) => setTimeout(r, 500));
  const flags = await page.evaluate(() => ({
    isNight: window.__worldIsNight,
    lightsOn: window.__worldLightsOn,
    htmlPhase: document.documentElement.dataset.worldPhase,
    htmlLights: document.documentElement.dataset.worldLights,
    intensity: document.querySelector("world-atmosphere")?.intensity,
  }));
  await page.screenshot({ path: file });
  console.log(`${phase.padEnd(11)} → ${file}  ${JSON.stringify(flags)}`);
}

await browser.close();
console.log("done");
