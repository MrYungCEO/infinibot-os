import puppeteer from "puppeteer";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const OUT = process.env.SHOTS_OUT || "/tmp/focus-shots";
mkdirSync(OUT, { recursive: true });

const PASS = "Khalifa888$";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: (process.env.CHROME_PATH || undefined),
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--user-data-dir=/tmp/pptr-focus-shots"],
});

async function shot(path, step, tag, w, h) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h });
  await page.evaluateOnNewDocument((pass) => {
    localStorage.setItem("infinibot.control.settings.v1", JSON.stringify({
      gatewayUrl: "ws://localhost:18789",
      token: "", password: pass,
      sessionKey: "main", lastActiveSessionKey: "main",
    }));
    localStorage.setItem("infinibot.profiles.gateEnabled.v1", "0");
    // Seed a couple of focus items so the board isn't empty
    localStorage.setItem("infinibot-focus-items", JSON.stringify([
      { id: "demo-1", type: "task", title: "Launch content intelligence pipeline", status: "in_progress", priority: 1, addedAt: Date.now() },
      { id: "demo-2", type: "project", title: "Mobile voice audio routing fix", status: "done", priority: 2, addedAt: Date.now() },
      { id: "demo-3", type: "task", title: "Focus board premium UI overhaul", status: "backlog", priority: 3, addedAt: Date.now() },
    ]));
  }, PASS);
  await page.goto(`http://localhost:18789${path}`, { waitUntil: "networkidle2", timeout: 30000 });
  await sleep(2000);
  await page.screenshot({ path: join(OUT, `${step}-${tag}.png`), fullPage: false });
  console.log(`wrote ${step}-${tag}.png`);
  await page.close();
}

await shot("/focus", "03-focus-view", "desktop", 1440, 900);
await shot("/focus", "03-focus-view", "mobile", 375, 812);
await shot("/dashboard", "04-dashboard", "desktop", 1440, 900);
await shot("/dashboard", "04-dashboard", "mobile", 375, 812);

await browser.close();
