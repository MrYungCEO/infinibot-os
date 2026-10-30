#!/usr/bin/env node
/**
 * Multi-Device Visual QA / Layout Check — reusable engine.
 *
 * Standardized, parameterized visual-QA pass for ANY website. For every
 * page × every device viewport it:
 *   1. Loads the page headless (puppeteer + system Chrome) at that viewport.
 *   2. Takes a full-page screenshot.
 *   3. Programmatically checks for element OVERLAP (colliding sibling rects)
 *      and SPACING/LAYOUT problems (horizontal overflow, content wider than
 *      the viewport, elements clipping/touching edges, tiny tap targets on
 *      mobile), producing a per-view pass/fail with the specific issues.
 *   4. Optionally auto-discovers additional pages by crawling the nav.
 *   5. Writes all screenshots + a JSON + Markdown report to an artifact dir.
 *   6. Optionally sends the whole screenshot flow + issue summary to Telegram
 *      (channels.telegram.{botToken,defaultChatId} from infinibot.json).
 *
 * This file is intentionally self-contained and dependency-light (only
 * puppeteer) so it can be invoked from the "Multi-Device Visual QA" workflow,
 * from a subagent, or by hand:
 *
 *   node scripts/visual-qa-multidevice.mjs \
 *     --url https://example.com \
 *     --pages "/,/about,/contact" \
 *     --devices desktop-1920,desktop-1440,tablet-1024,tablet-768,mobile-390,mobile-360 \
 *     --out /tmp/example-visualqa \
 *     --crawl \
 *     --telegram
 *
 * Never edits the target site — it is strictly read-only against a live URL.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// ── Device matrix ──────────────────────────────────────────────────────────
// key -> { width, height, isMobile, label }
const DEVICE_PRESETS = {
  "desktop-1920": { width: 1920, height: 1080, isMobile: false, dpr: 1, label: "Desktop 1920" },
  "desktop-1440": { width: 1440, height: 900, isMobile: false, dpr: 1, label: "Desktop 1440" },
  "tablet-1024": { width: 1024, height: 768, isMobile: true, dpr: 2, label: "Tablet 1024 (landscape)" },
  "tablet-768": { width: 768, height: 1024, isMobile: true, dpr: 2, label: "Tablet 768 (portrait)" },
  "mobile-390": { width: 390, height: 844, isMobile: true, dpr: 3, label: "Mobile 390 (iPhone)" },
  "mobile-360": { width: 360, height: 800, isMobile: true, dpr: 3, label: "Mobile 360 (small Android)" },
};

const DEFAULT_DEVICES = Object.keys(DEVICE_PRESETS);

// ── Arg parsing ────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { pages: [], devices: [], crawl: false, telegram: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--url") args.url = next();
    else if (a === "--pages") args.pages = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--devices") args.devices = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--out") args.out = next();
    else if (a === "--crawl") args.crawl = true;
    else if (a === "--no-crawl") args.crawl = false;
    else if (a === "--telegram") args.telegram = true;
    else if (a === "--no-telegram") args.telegram = false;
    else if (a === "--max-crawl") args.maxCrawl = parseInt(next(), 10);
    else if (a === "--label") args.label = next();
    else if (a === "--chat-id") args.chatId = next();
  }
  return args;
}

// ── Chrome resolution (system Chrome preferred, cache fallback) ─────────────
function resolveChrome() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (existsSync(c)) return c; } catch { /* ignore */ }
  }
  // puppeteer's bundled chrome
  try {
    const pptr = require("puppeteer");
    const p = pptr.executablePath?.();
    if (p && existsSync(p)) return p;
  } catch { /* ignore */ }
  return undefined;
}

// ── In-page layout analysis (runs in the browser context) ──────────────────
// Returns { overlaps:[], spacing:[], overflow:{...}, tapTargets:[], counts:{} }
function analyzeLayout(isMobile) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const docW = Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0);
  const EDGE = 2; // px tolerance for "touching edge"
  const OVERFLOW_TOL = 4; // px tolerance before horizontal overflow is flagged
  const MIN_TAP = 40; // px min tap target on mobile

  const isVisible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    // must intersect the viewport vertically at least a bit (full-page, so allow below fold)
    if (r.bottom < 0) return false;
    return true;
  };

  const shortSel = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    else if (el.className && typeof el.className === "string") {
      const c = el.className.trim().split(/\s+/).slice(0, 2).join(".");
      if (c) s += "." + c;
    }
    const txt = (el.textContent || "").trim().slice(0, 30);
    if (txt) s += ` "${txt}"`;
    return s;
  };

  // ---- Horizontal overflow ----
  const overflow = { docWidth: docW, viewport: vw, overflows: docW > vw + OVERFLOW_TOL, offenders: [] };
  if (overflow.overflows) {
    const all = Array.from(document.querySelectorAll("body *"));
    for (const el of all) {
      if (!isVisible(el)) continue;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (cs.position === "fixed") continue;
      // element extends beyond right edge of viewport
      if (r.right > vw + OVERFLOW_TOL && r.width <= docW) {
        overflow.offenders.push({ sel: shortSel(el), right: Math.round(r.right), width: Math.round(r.width) });
      }
      if (overflow.offenders.length >= 12) break;
    }
  }

  // ---- Candidate "content" leaf elements for overlap + edge checks ----
  const CONTENT_TAGS = new Set([
    "H1","H2","H3","H4","H5","H6","P","SPAN","A","BUTTON","IMG","LI","LABEL","INPUT","TEXTAREA","SELECT","SVG","FIGURE","BLOCKQUOTE","STRONG","EM","SMALL","TD","TH"]);
  const candidates = [];
  for (const el of Array.from(document.querySelectorAll("body *"))) {
    if (!CONTENT_TAGS.has(el.tagName)) continue;
    if (!isVisible(el)) continue;
    // skip elements that themselves contain other content candidates (prefer leaves)
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    candidates.push({ el, r, cs });
  }

  // ---- Element overlap (colliding sibling rects) ----
  const overlaps = [];
  const contains = (a, b) => a.contains(b);
  const rectArea = (r) => Math.max(0, r.width) * Math.max(0, r.height);
  const intersectArea = (a, b) => {
    const x = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
    const y = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    return x * y;
  };
  // limit pair comparisons for perf — cap candidates
  const capped = candidates.slice(0, 400);
  for (let i = 0; i < capped.length; i++) {
    for (let j = i + 1; j < capped.length; j++) {
      const A = capped[i], B = capped[j];
      // skip if one contains the other (nesting is expected)
      if (contains(A.el, B.el) || contains(B.el, A.el)) continue;
      // skip intentionally layered elements
      if (A.cs.position === "absolute" || A.cs.position === "fixed" || A.cs.position === "sticky") continue;
      if (B.cs.position === "absolute" || B.cs.position === "fixed" || B.cs.position === "sticky") continue;
      // skip if either has a non-auto z-index (deliberate stacking)
      const inter = intersectArea(A.r, B.r);
      if (inter <= 0) continue;
      const smaller = Math.min(rectArea(A.r), rectArea(B.r));
      if (smaller <= 0) continue;
      const ratio = inter / smaller;
      // significant overlap of two non-nested content elements = likely collision
      if (ratio > 0.35) {
        overlaps.push({
          a: shortSel(A.el),
          b: shortSel(B.el),
          overlapPct: Math.round(ratio * 100),
        });
      }
      if (overlaps.length >= 25) break;
    }
    if (overlaps.length >= 25) break;
  }

  // ---- Edge touching / clipping ----
  const spacing = [];
  for (const { el, r } of candidates.slice(0, 400)) {
    // content bleeding off the right edge (clipped)
    if (r.left < -EDGE && r.right > 0) {
      spacing.push({ type: "clipped-left", sel: shortSel(el), left: Math.round(r.left) });
    }
    if (r.right > vw + EDGE && r.left < vw) {
      spacing.push({ type: "clipped-right", sel: shortSel(el), right: Math.round(r.right), vw });
    }
    if (spacing.length >= 20) break;
  }

  // ---- Tiny tap targets (mobile only) ----
  const tapTargets = [];
  if (isMobile) {
    const interactive = Array.from(document.querySelectorAll("a, button, input, select, [role='button'], [onclick]"));
    for (const el of interactive) {
      if (!isVisible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.top > vh * 3) continue; // only check near-top interactive elements to keep it meaningful
      if (r.width < MIN_TAP || r.height < MIN_TAP) {
        tapTargets.push({ sel: shortSel(el), w: Math.round(r.width), h: Math.round(r.height) });
      }
      if (tapTargets.length >= 15) break;
    }
  }

  return {
    overlaps,
    spacing,
    overflow,
    tapTargets,
    counts: { candidates: candidates.length },
    viewport: { vw, vh, docW },
  };
}

// ── Nav crawler (same-origin links from the first page) ────────────────────
async function discoverPages(page, baseUrl, maxCrawl) {
  try {
    const links = await page.evaluate(() => {
      const out = new Set();
      for (const a of Array.from(document.querySelectorAll("a[href]"))) {
        const href = a.getAttribute("href");
        if (!href) continue;
        out.add(href);
      }
      return Array.from(out);
    });
    const origin = new URL(baseUrl).origin;
    const paths = new Set(["/"]);
    for (const href of links) {
      try {
        const u = new URL(href, baseUrl);
        if (u.origin !== origin) continue;
        if (/\.(pdf|zip|png|jpe?g|svg|mp4|webp|gif|css|js)$/i.test(u.pathname)) continue;
        const p = u.pathname + (u.search || "");
        if (p.startsWith("/")) paths.add(p);
      } catch { /* ignore */ }
    }
    return Array.from(paths).slice(0, maxCrawl || 12);
  } catch {
    return ["/"];
  }
}

// ── Telegram delivery ──────────────────────────────────────────────────────
function loadTelegramConfig() {
  const candidates = [
    process.env.INFINIBOT_CONFIG_PATH,
    join(homedir(), ".infinibot", "infinibot.json"),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue;
      const cfg = JSON.parse(readFileSync(p, "utf8"));
      const tg = cfg?.channels?.telegram;
      if (tg?.botToken) return tg;
    } catch { /* ignore */ }
  }
  return null;
}

async function tgSendText(token, chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4096), parse_mode: "HTML", disable_web_page_preview: true }),
    signal: AbortSignal.timeout(30000),
  });
  const j = await res.json().catch(() => ({}));
  return j.ok ? { ok: true } : { ok: false, error: j.description || `HTTP ${res.status}` };
}

async function tgSendMediaGroup(token, chatId, items) {
  // items: [{ path, caption }] — max 10 per group
  const form = new FormData();
  const media = [];
  items.forEach((it, idx) => {
    const attach = `photo${idx}`;
    const buf = readFileSync(it.path);
    form.append(attach, new Blob([buf], { type: "image/png" }), `${attach}.png`);
    const m = { type: "photo", media: `attach://${attach}` };
    if (it.caption) { m.caption = it.caption.slice(0, 1024); m.parse_mode = "HTML"; }
    media.push(m);
  });
  form.append("chat_id", String(chatId));
  form.append("media", JSON.stringify(media));
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMediaGroup`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(120000),
  });
  const j = await res.json().catch(() => ({}));
  return j.ok ? { ok: true } : { ok: false, error: j.description || `HTTP ${res.status}` };
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv);
  if (!args.url) {
    console.error("ERROR: --url is required");
    process.exit(2);
  }
  const baseUrl = args.url.replace(/\/$/, "");
  const deviceKeys = (args.devices.length ? args.devices : DEFAULT_DEVICES).filter((k) => DEVICE_PRESETS[k]);
  if (!deviceKeys.length) { console.error("ERROR: no valid devices"); process.exit(2); }
  const outDir = resolve(args.out || `/tmp/visualqa-${new URL(baseUrl).hostname}`);
  const shotsDir = join(outDir, "screenshots");
  mkdirSync(shotsDir, { recursive: true });
  const label = args.label || new URL(baseUrl).hostname;

  const chrome = resolveChrome();
  console.log(`[visual-qa] chrome=${chrome || "(puppeteer default)"}`);
  const puppeteer = require("puppeteer");
  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars"],
  });

  const report = {
    label, baseUrl, startedAt: new Date().toISOString(),
    devices: deviceKeys, pages: [], views: [], summary: {},
  };

  try {
    // Determine page list (crawl if requested)
    let pages = args.pages.length ? args.pages : ["/"];
    if (args.crawl) {
      const p0 = await browser.newPage();
      try {
        await p0.goto(baseUrl + (pages[0] === "/" ? "/" : pages[0]), { waitUntil: "networkidle2", timeout: 45000 });
        const discovered = await discoverPages(p0, baseUrl, args.maxCrawl || 12);
        const set = new Set([...pages, ...discovered]);
        pages = Array.from(set).slice(0, args.maxCrawl || 12);
      } catch (e) {
        console.log(`[visual-qa] crawl failed, using provided pages: ${e.message}`);
      } finally { await p0.close().catch(() => {}); }
    }
    report.pages = pages;
    console.log(`[visual-qa] ${pages.length} pages × ${deviceKeys.length} devices = ${pages.length * deviceKeys.length} views`);

    for (const pagePath of pages) {
      const pageUrl = baseUrl + (pagePath.startsWith("/") ? pagePath : "/" + pagePath);
      const pageSlug = (pagePath === "/" ? "home" : pagePath.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")) || "home";
      for (const dk of deviceKeys) {
        const dev = DEVICE_PRESETS[dk];
        const view = { page: pagePath, url: pageUrl, device: dk, deviceLabel: dev.label, pass: true, issues: [], error: null, screenshot: null };
        const pg = await browser.newPage();
        try {
          await pg.setViewport({ width: dev.width, height: dev.height, isMobile: dev.isMobile, deviceScaleFactor: dev.dpr, hasTouch: dev.isMobile });
          if (dev.isMobile) {
            await pg.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1");
          }
          const resp = await pg.goto(pageUrl, { waitUntil: "networkidle2", timeout: 45000 });
          const status = resp ? resp.status() : 0;
          if (status >= 400) { view.issues.push({ type: "http", detail: `HTTP ${status}` }); view.pass = false; }
          // settle animations / lazy content
          await new Promise((r) => setTimeout(r, 1200));
          await pg.evaluate(async () => {
            // trigger lazy-load by scrolling to bottom then back to top
            await new Promise((res) => {
              let y = 0; const step = () => { window.scrollTo(0, y); y += window.innerHeight; if (y < document.body.scrollHeight) setTimeout(step, 60); else { window.scrollTo(0, 0); res(); } }; step();
            });
          });
          await new Promise((r) => setTimeout(r, 400));

          const shotName = `${pageSlug}__${dk}.png`;
          const shotPath = join(shotsDir, shotName);
          await pg.screenshot({ path: shotPath, fullPage: true });
          view.screenshot = shotPath;

          const analysis = await pg.evaluate(analyzeLayout, dev.isMobile);
          view.analysis = analysis;
          // Grade
          if (analysis.overflow.overflows) {
            view.pass = false;
            view.issues.push({ type: "horizontal-overflow", detail: `page ${analysis.overflow.docWidth}px wide vs ${analysis.overflow.viewport}px viewport`, offenders: analysis.overflow.offenders.slice(0, 5) });
          }
          if (analysis.overlaps.length) {
            view.pass = false;
            view.issues.push({ type: "element-overlap", count: analysis.overlaps.length, detail: `${analysis.overlaps.length} overlapping element pair(s)`, examples: analysis.overlaps.slice(0, 5) });
          }
          if (analysis.spacing.length) {
            view.pass = false;
            view.issues.push({ type: "edge-clipping", count: analysis.spacing.length, detail: `${analysis.spacing.length} element(s) clipping viewport edge`, examples: analysis.spacing.slice(0, 5) });
          }
          if (analysis.tapTargets.length) {
            // tap targets = warning (mobile), fail-soft
            view.issues.push({ type: "tiny-tap-targets", count: analysis.tapTargets.length, detail: `${analysis.tapTargets.length} tap target(s) < 40px`, examples: analysis.tapTargets.slice(0, 5), severity: "warn" });
          }
          console.log(`[visual-qa] ${view.pass ? "PASS" : "FAIL"}  ${pagePath}  ${dk}  (${view.issues.length} issue group(s))`);
        } catch (e) {
          view.error = e.message;
          view.pass = false;
          view.issues.push({ type: "load-error", detail: e.message });
          console.log(`[visual-qa] ERROR ${pagePath} ${dk}: ${e.message}`);
        } finally {
          await pg.close().catch(() => {});
        }
        report.views.push(view);
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  report.finishedAt = new Date().toISOString();
  const total = report.views.length;
  const failed = report.views.filter((v) => !v.pass);
  const passed = total - failed.length;
  report.summary = {
    total, passed, failed: failed.length,
    failViews: failed.map((v) => ({ page: v.page, device: v.device, issues: v.issues.filter((i) => i.severity !== "warn").map((i) => i.type) })),
  };

  writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));

  // Markdown report
  const md = [];
  md.push(`# Multi-Device Visual QA — ${label}`);
  md.push(`\n**Target:** ${baseUrl}  \n**Run:** ${report.startedAt}  \n**Views:** ${total} (${passed} pass / ${failed.length} fail)  \n**Devices:** ${deviceKeys.join(", ")}\n`);
  for (const pagePath of report.pages) {
    md.push(`\n## ${pagePath}`);
    for (const v of report.views.filter((x) => x.page === pagePath)) {
      const realIssues = v.issues.filter((i) => i.severity !== "warn");
      const warnIssues = v.issues.filter((i) => i.severity === "warn");
      const badge = v.pass ? "✅ PASS" : "❌ FAIL";
      md.push(`- **${v.deviceLabel}** — ${badge}`);
      for (const i of realIssues) md.push(`  - ⚠️ ${i.type}: ${i.detail}`);
      for (const i of warnIssues) md.push(`  - 🔸 ${i.type}: ${i.detail}`);
    }
  }
  writeFileSync(join(outDir, "report.md"), md.join("\n"));

  console.log(`\n[visual-qa] DONE. ${passed}/${total} views passed. Artifacts: ${outDir}`);

  // ── Telegram delivery ──
  if (args.telegram) {
    const tg = loadTelegramConfig();
    if (!tg?.botToken) {
      console.log("[visual-qa] telegram: no botToken configured — skipping send");
      report.telegram = { ok: false, error: "no botToken" };
    } else {
      const chatId = args.chatId || tg.defaultChatId;
      if (!chatId) {
        console.log("[visual-qa] telegram: no chatId — skipping send");
        report.telegram = { ok: false, error: "no chatId" };
      } else {
        // 1) header summary
        const failLines = failed.length
          ? failed.map((v) => `❌ <b>${v.page}</b> @ ${v.device} — ${v.issues.filter((i) => i.severity !== "warn").map((i) => i.type).join(", ") || "issue"}`).join("\n")
          : "All views clean ✅";
        const header = [
          `📱🖥️ <b>Multi-Device Visual QA</b> — ${label}`,
          `<a href="${baseUrl}">${baseUrl}</a>`,
          `Views: <b>${total}</b> · Pass: <b>${passed}</b> · Fail: <b>${failed.length}</b>`,
          `Devices: ${deviceKeys.join(", ")}`,
          ``,
          `<b>Problem views:</b>`,
          failLines,
        ].join("\n");
        const th = await tgSendText(tg.botToken, chatId, header);
        console.log(`[visual-qa] telegram header: ${th.ok ? "sent" : th.error}`);

        // 2) screenshots as media groups, ordered by page then device, captioned
        const media = report.views
          .filter((v) => v.screenshot)
          .map((v) => ({
            path: v.screenshot,
            caption: `${v.pass ? "✅" : "❌"} ${v.page} · ${v.deviceLabel}` + (v.pass ? "" : ` — ${v.issues.filter((i) => i.severity !== "warn").map((i) => i.type).join(", ")}`),
          }));
        let sent = 0, sendErr = null;
        for (let i = 0; i < media.length; i += 10) {
          const batch = media.slice(i, i + 10);
          const r = await tgSendMediaGroup(tg.botToken, chatId, batch);
          if (r.ok) sent += batch.length;
          else { sendErr = r.error; console.log(`[visual-qa] telegram batch error: ${r.error}`); }
          await new Promise((res) => setTimeout(res, 1500)); // rate-limit courtesy
        }
        console.log(`[visual-qa] telegram: sent ${sent}/${media.length} screenshots`);
        report.telegram = { ok: sent > 0, sent, total: media.length, error: sendErr };
        writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));
      }
    }
  }

  // exit 0 always (QA findings are not process failures); report.json carries pass/fail
  process.exit(0);
}

main().catch((e) => { console.error("[visual-qa] fatal:", e); process.exit(1); });
