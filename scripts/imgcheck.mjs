import puppeteer from 'puppeteer';
import path from 'node:path'; import fs from 'node:fs';
const ROOT=process.cwd();
const url='file://'+path.join(ROOT,'docs/landing.html');
const b=await puppeteer.launch({headless:'new',executablePath:(process.env.CHROME_PATH || undefined),args:['--no-sandbox','--allow-file-access-from-files']});
const p=await b.newPage();
await p.setViewport({width:1440,height:900});
await p.goto(url,{waitUntil:'load',timeout:60000});
// force eager + wait for decode
await p.evaluate(()=>{document.querySelectorAll('img').forEach(i=>{i.loading='eager';})});
await p.evaluate(async()=>{await Promise.all([...document.querySelectorAll('img')].map(i=>i.complete?0:new Promise(r=>{i.onload=i.onerror=r})))});
await new Promise(r=>setTimeout(r,1500));
const bad=await p.evaluate(()=>[...document.querySelectorAll('img')].filter(i=>!(i.complete&&i.naturalWidth>0)).map(i=>i.getAttribute('src')));
console.log('Broken after eager-load:', bad.length?bad:'NONE — all images valid');
await b.close();
