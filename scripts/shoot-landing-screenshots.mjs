// Capture real InfiniBot UI screenshots for docs/landing.html.
// Drives the live gateway at :18789, password from mcp-servers.json,
// then visits each route and saves a 1280x800 PNG.
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'http://127.0.0.1:18789';
const OUT  = `${process.cwd()}/docs/assets/landing`;

let PASSWORD = process.env.UI_PASSWORD || '';
try {
  const mcp = JSON.parse(fs.readFileSync(`${process.env.HOME}/.infinibot/mcp-servers.json`, 'utf8'));
  for (const v of Object.values(mcp.mcpServers || mcp.servers || {})) {
    const pw = v?.env?.INFINIBOT_GATEWAY_PASSWORD;
    if (pw) { PASSWORD = pw; break; }
  }
} catch (e) { console.log('no mcp-servers.json:', e.message); }
console.log('password resolved:', PASSWORD ? `${PASSWORD.slice(0,4)}…` : 'NONE');

const deep = `function deepAll(root, sel, acc=[]){ if(!root) return acc; if(root.querySelectorAll) acc.push(...root.querySelectorAll(sel)); if(root.shadowRoot) deepAll(root.shadowRoot,sel,acc); for(const k of root.children||[]) deepAll(k,sel,acc); return acc; }`;

// helpers run inside the page (string-templated)
const COLLAPSE_SIDEBAR = `(()=>{
  const sel = document.querySelector('.nav-collapse-toggle');
  if (sel && !document.querySelector('.shell--nav-collapsed')) sel.click();
})()`;
const EXPAND_SIDEBAR = `(()=>{
  const sel = document.querySelector('.nav-collapse-toggle');
  if (sel && document.querySelector('.shell--nav-collapsed')) sel.click();
})()`;

// per-route post-nav actions
const POST = {
  notes: async (page) => {
    await page.evaluate(COLLAPSE_SIDEBAR);
    await new Promise(r => setTimeout(r, 400));
    // notes view uses `.notes-item` for each row in the sidebar list
    await page.evaluate(deep + `;(()=>{
      const rows = deepAll(document, '.notes-item');
      if (rows[0]) rows[0].click();
    })()`);
    await new Promise(r => setTimeout(r, 1800));
  },
  workflows: async (page) => {
    await page.evaluate(COLLAPSE_SIDEBAR);
    await new Promise(r => setTimeout(r, 400));
    // workflows uses inline-styled clickable rows (no class). Click the first
    // clickable div under the workflows sidebar that has cursor:pointer.
    await page.evaluate(deep + `;(()=>{
      const candidates = deepAll(document, 'div')
        .filter(d => /cursor:\\s*pointer/.test(d.getAttribute('style') || '')
                   && /border-radius:\\s*6px/.test(d.getAttribute('style') || '')
                   && (d.textContent || '').trim().length > 5);
      if (candidates[0]) candidates[0].click();
    })()`);
    await new Promise(r => setTimeout(r, 1800));
  },
  mobile: async (page) => {
    // /mobilepage embeds an iframe to /mobile-web/ which may not auto-load.
    // Wait, then poke the iframe.
    await new Promise(r => setTimeout(r, 3000));
  },
  agents: async (page) => {
    // expand org tree so multiple agents appear; scale slightly down for fit.
    await page.evaluate(deep + `;(()=>{
      // expand any collapsed nodes
      const expanders = deepAll(document, '[aria-expanded="false"], .org-node--collapsed, .expand-toggle');
      for (const x of expanders.slice(0, 12)) try { x.click(); } catch {}
    })()`);
    await new Promise(r => setTimeout(r, 1200));
    // zoom out the org chart container if found, else body
    await page.evaluate(deep + `;(()=>{
      const org = document.querySelector('.org-hierarchy, .agents-hierarchy, .org-tree') ||
                  document.querySelector('.agents-view') || document.body;
      org.style.zoom = '0.62';
    })()`);
    await new Promise(r => setTimeout(r, 800));
  },
  'knowledge-graph': async (page) => {
    // wait for canvas/worker
    await new Promise(r => setTimeout(r, 4000));
  },
  voice: async (page) => {
    await new Promise(r => setTimeout(r, 1500));
  },
  mobile: async (page) => {
    await new Promise(r => setTimeout(r, 2500));
  },
  dashboard: async (page) => {
    // ensure the operational dashboard renders (not just world map)
    await new Promise(r => setTimeout(r, 1500));
  },
  mesh: async (page) => {
    // capture the dashboard's world-map band (Agent Mesh)
    await new Promise(r => setTimeout(r, 2500));
    await page.evaluate(deep + `;(()=>{
      const el = document.querySelector('agency-world-viz, .world-map-band, .agency-world');
      if (el) el.scrollIntoView({block:'center'});
    })()`);
    await new Promise(r => setTimeout(r, 1500));
  },
};

const ALL_SHOTS = [
  { route: 'dashboard',       file: 'dashboard',       wait: 4500 },
  { route: 'agents',          file: 'agents',          wait: 4500 },
  { route: 'projects',        file: 'kanban',          wait: 4000 },
  { route: 'notes',           file: 'notes',           wait: 3500 },
  { route: 'workflows',       file: 'workflows',       wait: 3500 },
  { route: 'activity',        file: 'activity',        wait: 4000 },
  { route: 'credits',         file: 'credits',         wait: 3500 },
  { route: 'discipline',      file: 'discipline',      wait: 3500 },
  { route: 'mcp',             file: 'mcp',             wait: 3500 },
  { route: 'knowledge-graph', file: 'knowledge-graph', wait: 5500 },
  { route: 'voice',           file: 'voice',           wait: 3500 },
];
const ONLY = process.env.SHOTS ? new Set(process.env.SHOTS.split(',')) : null;
const SHOTS = ONLY ? ALL_SHOTS.filter(s => ONLY.has(s.file) || ONLY.has(s.route)) : ALL_SHOTS;

const browser = await puppeteer.launch({
  headless: 'new',
  protocolTimeout: 180000,
  args: ['--no-sandbox','--disable-gpu','--use-gl=swiftshader','--window-size=1280,800'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
page.on('pageerror', e => console.log('PERR:', e.message.slice(0,200)));

// First nav: password unlock + dismiss profile picker if it appears.
const first = `${BASE}/?password=${encodeURIComponent(PASSWORD)}`;
await page.goto(first, { waitUntil: 'domcontentloaded', timeout: 30000 });
await new Promise(r => setTimeout(r, 6000));

// Dismiss profile picker / continue button if present.
await page.evaluate(deep + `;(()=>{
  const txts = ['continue','enter','default','use default','skip'];
  const btns = deepAll(document, 'button');
  for (const b of btns) {
    const t = (b.textContent||'').trim().toLowerCase();
    if (txts.some(x => t === x || t.startsWith(x))) { b.click(); return t; }
  }
})()`);
await new Promise(r => setTimeout(r, 2500));

for (const { route, file, wait, postKey } of SHOTS) {
  // Always re-expand sidebar before nav so each route starts from a known state.
  await page.evaluate(EXPAND_SIDEBAR).catch(()=>{});
  // Reset any prior CSS zoom.
  await page.evaluate(`(()=>{ document.body.style.zoom=''; document.querySelectorAll('[style*="zoom"]').forEach(e => { try { e.style.zoom=''; } catch {} }); })()`).catch(()=>{});
  await new Promise(r => setTimeout(r, 300));

  // SPA navigation via History API — avoids detached-frame from server redirects.
  await page.evaluate((r) => {
    const path = r === 'dashboard' ? '/' : `/${r}`;
    history.pushState({}, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, route).catch(e => console.log('NAV', route, e.message));
  await new Promise(r => setTimeout(r, wait));

  // Re-dismiss any modal that appears on a route.
  await page.evaluate(deep + `;(()=>{
    const closes = deepAll(document, '[aria-label="Close"], .modal-close, .close-button');
    for (const c of closes.slice(0,2)) try { c.click(); } catch {}
  })()`).catch(()=>{});
  await new Promise(r => setTimeout(r, 600));

  // Per-route hook.
  const key = postKey || file;
  if (POST[key]) {
    try { await POST[key](page); } catch (e) { console.log(`POST ${key} err:`, e.message); }
  } else if (POST[route]) {
    try { await POST[route](page); } catch (e) { console.log(`POST ${route} err:`, e.message); }
  }

  const outPath = path.join(OUT, `${file}.png`);
  try {
    await page.evaluate(() => {
      try { document.getAnimations?.().forEach(a => a.pause()); } catch {}
    });
    await Promise.race([
      page.screenshot({ path: outPath, type: 'png', captureBeyondViewport: false, fromSurface: true }),
      new Promise((_, rj) => setTimeout(() => rj(new Error('shot timeout 60s')), 60000)),
    ]);
    const stat = fs.statSync(outPath);
    console.log(`✓ ${route.padEnd(16)} → ${file}.png  (${(stat.size/1024).toFixed(0)} KB)`);
  } catch (e) {
    console.log(`✗ ${route.padEnd(16)} → ${file}.png  FAILED: ${e.message}`);
  }
}

// Mobile UI is served as its own bundle at /mobile-web/ — capture in a phone viewport.
try {
  const mobilePage = await browser.newPage();
  await mobilePage.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  // Seed gateway config into localStorage so the RN bundle doesn't sit on a setup screen.
  await mobilePage.goto(`${BASE}/mobile-web/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await mobilePage.evaluate((pw) => {
    try {
      localStorage.setItem('infinibot.gateway.url', 'ws://127.0.0.1:18789');
      localStorage.setItem('infinibot.gateway.password', pw);
      localStorage.setItem('infinibot.gateway.token', '');
    } catch {}
  }, PASSWORD);
  // Reload after seeding, then wait for bundle + initial paint.
  await mobilePage.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  // Wait for #root to gain children (RN root mount).
  for (let i = 0; i < 30; i++) {
    const hasContent = await mobilePage.evaluate(() => {
      const root = document.getElementById('root');
      return !!(root && root.children.length > 0 && root.innerText.trim().length > 4);
    });
    if (hasContent) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  await new Promise(r => setTimeout(r, 3000));
  const out = path.join(OUT, 'mobile.png');
  await mobilePage.screenshot({ path: out, type: 'png', captureBeyondViewport: false, fromSurface: true });
  console.log(`✓ mobile-web        → mobile.png  (${(fs.statSync(out).size/1024).toFixed(0)} KB)`);
  await mobilePage.close();
} catch (e) {
  console.log('mobile shot failed:', e.message);
}

// Mesh / agent world — captured from dashboard scrolled into the world band.
try {
  const meshPage = await browser.newPage();
  await meshPage.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  await meshPage.goto(`${BASE}/?password=${encodeURIComponent(PASSWORD)}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise(r => setTimeout(r, 6000));
  await meshPage.evaluate(deep + `;(()=>{
    // "Continue as current →" is an anchor/text node, not a button.
    const all = deepAll(document, 'button, a, [role="button"], span, div');
    for (const el of all) {
      const t = (el.textContent||'').trim().toLowerCase();
      if (/^continue( as current.*)?$/i.test(t) || t === 'enter' || t === 'use default') {
        try { el.click(); } catch {}
        return;
      }
    }
  })()`).catch(()=>{});
  await new Promise(r => setTimeout(r, 2500));
  // Hunt for the world-viz canvas and scroll it into center view.
  await meshPage.evaluate(deep + `;(()=>{
    const cands = deepAll(document, 'agency-world-viz, .agency-world, .world-map-band, canvas');
    const big = cands.filter(el => {
      const r = el.getBoundingClientRect();
      return r.width >= 600 && r.height >= 200;
    });
    if (big[0]) big[0].scrollIntoView({ block: 'center' });
  })()`);
  await new Promise(r => setTimeout(r, 4000));
  const out = path.join(OUT, 'mesh.png');
  await meshPage.screenshot({ path: out, type: 'png', captureBeyondViewport: false, fromSurface: true });
  console.log(`✓ mesh (dashboard)  → mesh.png  (${(fs.statSync(out).size/1024).toFixed(0)} KB)`);
  await meshPage.close();
} catch (e) {
  console.log('mesh shot failed:', e.message);
}

await browser.close();
console.log('DONE');
