import puppeteer from 'puppeteer';
import path from 'node:path';
import fs from 'node:fs';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const url = 'file://' + path.join(ROOT, 'docs/landing.html');
const execPath = (process.env.CHROME_PATH || undefined);
const browser = await puppeteer.launch({ headless: 'new', executablePath: fs.existsSync(execPath)?execPath:undefined, args: ['--no-sandbox','--allow-file-access-from-files'] });
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844 });
await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });
const offenders = await page.evaluate(() => {
  const vw = document.documentElement.clientWidth;
  const out = [];
  for (const el of document.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.right > vw + 1 || r.width > vw + 1) {
      // only report the element if no ancestor already reported wider-or-equal at same right edge (reduce noise): keep simple, filter later
      out.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className && el.className.toString) ? el.className.toString().slice(0,60) : '',
        id: el.id || '',
        right: Math.round(r.right), width: Math.round(r.width), left: Math.round(r.left),
        section: (el.closest('section')?.id) || (el.closest('[class*="section-"]')?.className?.toString().match(/section-[a-z]+/)?.[0]) || '',
      });
    }
  }
  return out;
});
// reduce: show widest per section
const bySec = {};
for (const o of offenders) { const k = o.section||'(none)'; if(!bySec[k]||o.width>bySec[k].width) bySec[k]=o; }
console.log('viewport 390. Overflowing elements grouped by section (widest each):');
for (const [k,o] of Object.entries(bySec)) console.log(` [${k}] ${o.tag}.${o.cls}#${o.id} width=${o.width} right=${o.right} left=${o.left}`);
console.log('\nTotal offending nodes:', offenders.length);
// top 15 widest overall
offenders.sort((a,b)=>b.width-a.width);
console.log('\nWidest 15:');
offenders.slice(0,15).forEach(o=>console.log(` ${o.width}px right=${o.right} <${o.tag} class="${o.cls}" id="${o.id}"> sec=${o.section}`));
await browser.close();
