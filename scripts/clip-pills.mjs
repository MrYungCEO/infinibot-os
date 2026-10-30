import puppeteer from 'puppeteer';
import fs from 'node:fs';
const BASE='http://127.0.0.1:18789';
let PW; try{const m=JSON.parse(fs.readFileSync(process.env.HOME+'/.infinibot/mcp-servers.json','utf8'));for(const v of Object.values(m.mcpServers||{})){if(v?.env?.INFINIBOT_GATEWAY_PASSWORD){PW=v.env.INFINIBOT_GATEWAY_PASSWORD;break;}}}catch{}
const b=await puppeteer.launch({headless:'new',executablePath:'/opt/google/chrome/chrome',args:['--no-sandbox','--disable-gpu','--use-gl=swiftshader']});
const ctx=b.defaultBrowserContext(); await ctx.overridePermissions(BASE,['microphone']);
const p=await b.newPage(); await p.setViewport({width:1600,height:1000,deviceScaleFactor:2});
await p.goto(`${BASE}/?password=${encodeURIComponent(PW)}`,{waitUntil:'domcontentloaded'}).catch(()=>{});
await new Promise(r=>setTimeout(r,9000));
const DA=`function deepAll(root,sel,acc=[]){if(!root)return acc;if(root.querySelectorAll)acc.push(...root.querySelectorAll(sel));if(root.shadowRoot)deepAll(root.shadowRoot,sel,acc);for(const k of root.children||[])deepAll(k,sel,acc);return acc;}`;
await p.evaluate(DA+`;(()=>{const x=deepAll(document,'button').find(b=>/continue/i.test(b.textContent||''));if(x)x.click();})()`);
await new Promise(r=>setTimeout(r,2500));
await p.evaluate(()=>{history.pushState({},'','/voice?hud=1');dispatchEvent(new PopStateEvent('popstate'));});
await new Promise(r=>setTimeout(r,7000));
// clip the floating pills + cloud terminal head
const clips=await p.evaluate(DA+`;(()=>{const out={};const f=(sel)=>{const e=deepAll(document,sel)[0];if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};};out.pills=f('.vc-floating-pills');out.term=f('.vct-head');out.cloudbtns=f('.vct-btn');return out;})()`);
console.log('CLIPS',JSON.stringify(clips));
async function shot(name,c,pad=10){ if(!c||!c.w){console.log('no',name);return;} await p.screenshot({path:`/tmp/clip_${name}.png`,clip:{x:Math.max(0,(c.x-pad)*2),y:Math.max(0,(c.y-pad)*2),width:Math.min(1600*2,(c.w+pad*2)*2),height:(c.h+pad*2)*2}}); console.log('SHOT /tmp/clip_'+name+'.png'); }
await shot('pills',clips.pills,14);
await shot('term',clips.term,8);
await b.close();
