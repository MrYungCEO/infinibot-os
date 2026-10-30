#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import puppeteer from "puppeteer";

const port = Number(process.env.GLASS_G1_PORT || 19831);
const base = process.env.GLASS_G1_BASE_URL || `http://127.0.0.1:${port}`;
const out = process.env.GLASS_G1_SHOTS_DIR || "/tmp/glass-g1-shots";
const token = process.env.GLASS_G1_TOKEN || "glass-g1-verify";
const chrome = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"].find(existsSync);
if (!chrome) throw new Error("Chrome not found");

const allRoutes = [
  ["dashboard", "/dashboard"],
  ["projects-kanban", "/projects"],
  ["schedule", "/schedule"],
  ["notes-documents", "/notes"],
  ["docs", "/docs"],
  ["files", "/files"],
  ["discipline", "/discipline"],
  ["focus", "/focus"],
  ["issues", "/issues"],
  ["decisions", "/decisions"],
  ["risks", "/risks"],
  ["commitments", "/commitments"],
  ["people", "/people"],
  ["opportunities", "/opportunities"],
  ["workspace", "/workspace"],
  ["databases", "/databases"],
  ["prompt-templates", "/prompt-templates"],
];
const requestedRouteNames = new Set(
  (process.env.GLASS_G1_ROUTE_NAMES || "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean),
);
const routes = requestedRouteNames.size
  ? allRoutes.filter(([name]) => requestedRouteNames.has(name))
  : allRoutes;
const reportPath = process.env.GLASS_G1_REPORT_PATH || `${out}/report.json`;
const viewports = {
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1 },
  mobile390: { width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
};

await mkdir(out, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars"],
});
const results = [];
try {
  for (const theme of ["dark", "light"]) {
    for (const [viewportName, viewport] of Object.entries(viewports)) {
      const page = await browser.newPage();
      await page.setViewport(viewport);
      await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
      await page.evaluateOnNewDocument((settings) => {
        localStorage.setItem("infinibot.control.settings.v1", JSON.stringify(settings));
      }, {
        gatewayUrl: `ws://127.0.0.1:${port}`,
        token,
        password: "",
        sessionKey: "main",
        lastActiveSessionKey: "main",
        theme,
        locale: "en",
        chatFocusMode: false,
        chatShowThinking: true,
        splitRatio: 0.6,
        navCollapsed: viewportName === "mobile390",
        navGroupsCollapsed: {},
        aiIdeEnabled: false,
        aiIdeCollapsed: true,
        performanceMode: "off",
      });
      const pageErrors = [];
      page.on("pageerror", (error) => pageErrors.push(String(error.message || error)));
      for (const [name, route] of routes) {
        const url = `${base}${route}?token=${token}`;
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
        await page.waitForSelector("infinibot-app", { timeout: 20_000 });
        await page.waitForFunction(() => {
          const app = document.querySelector("infinibot-app");
          return Boolean(app?.querySelector(".shell"));
        }, { timeout: 20_000 });
        await new Promise((resolve) => setTimeout(resolve, 1800));
        // branding.get carries the profile's saved mode and can overwrite the
        // browser-local setting after connect. Force the requested mode after
        // that handshake so dark/light captures genuinely exercise both token
        // branches without mutating the throwaway gateway profile.
        await page.evaluate((requestedTheme) => {
          document.documentElement.dataset.theme = requestedTheme;
          document.documentElement.dataset.themeMode = requestedTheme;
          document.documentElement.style.colorScheme = requestedTheme;
        }, theme);
        await new Promise((resolve) => setTimeout(resolve, 100));
        const metrics = await page.evaluate(() => {
          const app = document.querySelector("infinibot-app");
          const root = app;
          const text = root?.textContent?.replace(/\s+/g, " ").trim() ?? "";
          const all = root ? Array.from(root.querySelectorAll("*")) : [];
          const offenders = all.flatMap((el) => {
            const style = getComputedStyle(el);
            if (style.display === "none" || style.visibility === "hidden") return [];
            const rect = el.getBoundingClientRect();
            if (rect.width < 2 || rect.height < 2 || style.position === "fixed") return [];
            if (rect.right <= innerWidth + 4 && rect.left >= -4) return [];
            return [{ tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 80), left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width) }];
          }).slice(0, 12);
          return {
            title: document.title,
            theme: document.documentElement.dataset.theme,
            connected: Boolean(app?.connected),
            textLength: text.length,
            textPreview: text.slice(0, 180),
            viewport: [innerWidth, innerHeight],
            documentWidth: document.documentElement.scrollWidth,
            offenders,
          };
        });
        const file = `${out}/${name}-${theme}-${viewportName}.png`;
        await page.screenshot({ path: file, fullPage: false });
        const result = { name, route, theme, viewport: viewportName, file, metrics, pageErrors: pageErrors.splice(0) };
        results.push(result);
        console.log(JSON.stringify({ shot: file, connected: metrics.connected, text: metrics.textLength, overflow: metrics.offenders.length, errors: result.pageErrors.length }));
      }
      await page.close();
    }
  }
} finally {
  await browser.close();
}
await writeFile(reportPath, JSON.stringify(results, null, 2));
const bad = results.filter((r) => !r.metrics.connected || r.metrics.textLength < 30 || r.metrics.documentWidth > r.metrics.viewport[0] + 4 || r.pageErrors.length);
console.log(`captured=${results.length} flagged=${bad.length} report=${reportPath}`);
if (bad.length) {
  console.log(JSON.stringify(bad.map((r) => ({ file: r.file, connected: r.metrics.connected, text: r.metrics.textLength, docWidth: r.metrics.documentWidth, viewport: r.metrics.viewport[0], errors: r.pageErrors })), null, 2));
}
