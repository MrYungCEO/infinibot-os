// Screenshot Setup › Coders on a side gateway.
// node scripts/shots-coders.mjs <port> <token> <outDir>
import fs from "node:fs";
import puppeteer from "puppeteer";

const [port, token, out] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const base = `http://127.0.0.1:${port}`;
const browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined, args: ["--no-sandbox"] });

const deep = (page, fn, ...args) =>
  page.evaluate(
    (src, a) => {
      const el = document.querySelector("infinibot-app");
      const find = (root) => {
        if (!root) return null;
        const hit = root.querySelector?.("coders-settings");
        if (hit) return hit;
        for (const n of root.querySelectorAll?.("*") ?? []) {
          if (n.shadowRoot) {
            const r = find(n.shadowRoot);
            if (r) return r;
          }
        }
        return null;
      };
      const cs = find(el?.shadowRoot ?? document) ?? find(document);
      // eslint-disable-next-line no-new-func
      return new Function("cs", "args", src)(cs, a);
    },
    fn,
    args,
  );

async function open(width, height, name) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => console.log("pageerror", e.message));
  await page.goto(`${base}/setup?view=coders&coder=codex&token=${token}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  for (let i = 0; i < 60; i++) {
    const n = await deep(page, "return cs?.shadowRoot?.querySelectorAll('article.card:not(.skeleton)').length ?? 0");
    if (n > 0) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  // Let the status poll + version probes settle.
  for (let i = 0; i < 40; i++) {
    const ok = await deep(page, "return !!cs?.shadowRoot?.querySelector('.chip.ok, .chip.warn')");
    if (ok) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  await new Promise((r) => setTimeout(r, 800));
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: false });
  console.log("shot", name);
  return page;
}

async function scrollToCard(page, id) {
  await deep(page, `cs.shadowRoot.querySelector('[data-coder="' + args[0] + '"]').scrollIntoView({block:'start'})`, id);
  await new Promise((r) => setTimeout(r, 500));
}

async function clickIn(page, id, label) {
  return deep(
    page,
    `const card = cs.shadowRoot.querySelector('[data-coder="' + args[0] + '"]');
     const b = [...card.querySelectorAll('button, a.btn')].find((x) => x.textContent.trim().startsWith(args[1]));
     if (!b) return false; b.click(); return true;`,
    id,
    label,
  );
}

const mode = process.argv[5] ?? "all";

// 1. Desktop overview (Codex highlighted from the deep link).
const d = await open(1600, 1000, "coders-desktop");
await deep(d, "cs.shadowRoot.querySelector('.head').scrollIntoView({block:'start'})");
await d.screenshot({ path: `${out}/coders-desktop-top.png` });

// 2. Phone.
const m = await open(390, 844, "coders-390");
await deep(m, "cs.shadowRoot.querySelector('.head').scrollIntoView({block:'start'})");
await new Promise((r) => setTimeout(r, 400));
await m.screenshot({ path: `${out}/coders-390-top.png` });
await m.screenshot({ path: `${out}/coders-390-full.png`, fullPage: true });

if (mode === "all") {
  // 3. Installing state (real install of Gemini CLI into the temp state).
  await scrollToCard(d, "gemini");
  const started = await clickIn(d, "gemini", "Install");
  console.log("install clicked", started);
  for (let i = 0; i < 40; i++) {
    const busy = await deep(d, "return !!cs.shadowRoot.querySelector('[data-coder=\"gemini\"] .progress')");
    if (busy) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  await new Promise((r) => setTimeout(r, 2500));
  await d.screenshot({ path: `${out}/coders-installing.png` });
  // wait for finish, then shot the result
  for (let i = 0; i < 240; i++) {
    const done = await deep(d, "return !cs.shadowRoot.querySelector('[data-coder=\"gemini\"] .progress')");
    if (done) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  await new Promise((r) => setTimeout(r, 1500));
  await scrollToCard(d, "gemini");
  await d.screenshot({ path: `${out}/coders-installed-gemini.png` });
}

if (mode === "all" || mode === "modals") {
  // 4. Sign-in modal (real `codex login --device-auth`, cancelled after).
  await scrollToCard(d, "codex");
  console.log("signin clicked", await clickIn(d, "codex", "Sign in"));
  for (let i = 0; i < 40; i++) {
    const ready = await deep(d, "return !!cs.shadowRoot.querySelector('.modal .code strong')");
    if (ready) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  await new Promise((r) => setTimeout(r, 500));
  await d.screenshot({ path: `${out}/coders-signin-modal.png` });

  // Same modal on a phone.
  await scrollToCard(m, "codex");
  await clickIn(m, "codex", "Sign in");
  for (let i = 0; i < 40; i++) {
    const ready = await deep(m, "return !!cs.shadowRoot.querySelector('.modal .code strong')");
    if (ready) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  await new Promise((r) => setTimeout(r, 500));
  await m.screenshot({ path: `${out}/coders-signin-modal-390.png` });
  for (const p of [d, m]) {
    await deep(p, "[...cs.shadowRoot.querySelectorAll('.modal footer .btn')].pop()?.click()");
  }

  // 5. API-key modal (Gemini).
  await scrollToCard(d, "gemini");
  console.log("key clicked", await clickIn(d, "gemini", "Add API key"));
  await new Promise((r) => setTimeout(r, 600));
  await d.screenshot({ path: `${out}/coders-key-modal.png` });
}

await browser.close();
