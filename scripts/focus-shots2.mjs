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
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--user-data-dir=/tmp/pptr-focus-shots2"],
});

async function makePage(pass, w, h) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h });
  await page.evaluateOnNewDocument((pass) => {
    localStorage.setItem("infinibot.control.settings.v1", JSON.stringify({
      gatewayUrl: "ws://localhost:18789",
      token: "", password: pass,
      sessionKey: "main", lastActiveSessionKey: "main",
    }));
    localStorage.setItem("infinibot.profiles.gateEnabled.v1", "0");
    localStorage.setItem("infinibot-focus-items", JSON.stringify([
      { id: "demo-1", type: "task", title: "Launch content intelligence pipeline", status: "in_progress", priority: 1, addedAt: Date.now() },
      { id: "demo-2", type: "project", title: "Mobile voice audio routing fix", status: "done", priority: 2, addedAt: Date.now() },
      { id: "demo-3", type: "task", title: "Focus board premium UI overhaul", status: "backlog", priority: 3, addedAt: Date.now() },
    ]));
  }, pass);
  return page;
}

// Focus view — wait longer for kanban data
const fp = await makePage(PASS, 1440, 900);
await fp.goto("http://localhost:18789/focus", { waitUntil: "networkidle2", timeout: 30000 });
await sleep(5000);
await fp.screenshot({ path: join(OUT, "03-focus-view-desktop.png") });
console.log("focus desktop");
await fp.close();

// Focus view mobile
const fm = await makePage(PASS, 375, 812);
await fm.goto("http://localhost:18789/focus", { waitUntil: "networkidle2", timeout: 30000 });
await sleep(4000);
await fm.screenshot({ path: join(OUT, "03-focus-view-mobile.png") });
console.log("focus mobile");
await fm.close();

// Dashboard — scroll down past briefing to show focus band
const dp = await makePage(PASS, 1440, 900);
await dp.goto("http://localhost:18789/dashboard", { waitUntil: "networkidle2", timeout: 30000 });
await sleep(3000);
// Scroll down to show focus band section
await dp.evaluate(() => { window.scrollTo(0, 1200); });
await sleep(500);
await dp.screenshot({ path: join(OUT, "04-dashboard-desktop.png") });
console.log("dashboard desktop");
await dp.close();

await browser.close();
