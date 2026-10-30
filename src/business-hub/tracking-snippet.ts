/**
 * Business hub — the first-party landing-page snippet (`s.js`), hand-written
 * and dependency-free (~3.6 KB raw, ~2 KB gzipped). One generic file serves every site; the
 * site key and consent mode ride on the script tag's data attributes.
 *
 * It tracks page views (incl. SPA pushState / replaceState / popstate),
 * keeps the landing UTMs for the session, auto-captures form submits
 * (skipping password / card / SSN-like / hidden-token fields), tracks clicks
 * on [data-ib-track], exposes `ib('event'|'identify'|'consent', …)` and
 * `ibConsent(bool)`, honours Do-Not-Track / Global Privacy Control, and
 * sends with navigator.sendBeacon (fetch keepalive fallback).
 */

import { HUB_HTTP_BASE } from "./email/config.js";
import type { Site } from "./tracking.js";

// Plain ES5 so it runs on every browser the landing pages target. Kept short
// on purpose: no comments inside, statements end with semicolons.
const SOURCE = String.raw`
(function(w,d){
var S=d.currentScript||d.querySelector('script[data-site]');if(!S||w.__ib)return;w.__ib=1;
var z=function(s,n){return (''+s).slice(0,n);},A=function(n){return S.getAttribute(n);},K=A('data-site'),M=A('data-mode')||'cookieless',
E=A('data-endpoint')||S.src.replace(/\/s\.js.*$/,'/c'),N=w.navigator,L=w.location,H=w.history,q=[],T,P,ss,ls,U,X,C;
try{ss=w.sessionStorage;ls=w.localStorage;}catch(e){}
function g(s,k){try{return s.getItem(k);}catch(e){}}
function p(s,k,v){try{s.setItem(k,v);}catch(e){}}
function id(s,k){var v=g(s,k);if(!v){v='';for(var i=0;i<4;i++)v+=Math.random().toString(36).slice(2,8);p(s,k,v);}return v;}
C=g(ls,'ib_consent')=='1';
function on(){return M=='consent'?C||d.documentElement.getAttribute('data-ib-consent')=='granted':!(N.doNotTrack=='1'||w.doNotTrack=='1'||N.globalPrivacyControl===true);}
try{U=JSON.parse(g(ss,'ib_u')||'null');var Q=new URLSearchParams(L.search),u={},h;
['source','medium','campaign','term','content'].forEach(function(k){var v=Q.get('utm_'+k);if(v){u[k]=z(v,200);h=1;}});
if(h){U=u;p(ss,'ib_u',JSON.stringify(u));}
X=Q.get('ib_c');if(X&&H.replaceState){Q['delete']('ib_c');Q=''+Q;H.replaceState(H.state,'',L.pathname+(Q?'?'+Q:'')+L.hash);}}catch(e){}
function cl(o){if(!o||typeof o!='object')return;var r={},c=0,k,v,t;for(k in o){v=o[k];t=typeof v;if(c>19)break;if(t=='string')v=z(v,256);else if(t!='number'&&t!='boolean')continue;r[z(k.replace(/[^\w.:-]/g,'_'),64)]=v;c++;}return r;}
function fl(){clearTimeout(T);if(!q.length)return;var b=JSON.stringify({events:q.splice(0,20)}),ok;
try{ok=N.sendBeacon(E,new Blob([b],{type:'text/plain'}));}catch(e){}
if(!ok&&w.fetch)w.fetch(E,{method:'POST',body:b,keepalive:true})['catch'](function(){});if(q.length)fl();}
function sd(e,now){if(!on())return;e.k=K;e.u=z(L.href,2048);e.a=id(M=='cookieless'?ss:ls,'ib_a');e.s=id(ss,'ib_s');e.ts=Date.now();if(U)e.utm=U;if(X){e.ct=X;X=0;}
q.push(e);if(now||q.length>19)fl();else{clearTimeout(T);T=setTimeout(fl,400);}}
function pv(){var k=L.pathname+L.search,e;if(k==P)return;e={t:'page_view',n:z(d.title||'',200)};if(!P&&d.referrer)e.r=z(d.referrer,2048);P=k;sd(e);}
var SX=/pass|pwd|secret|token|csrf|nonce|captcha|card|cc.?n|cvv|cvc|ssn|iban|routing|tax.?id/i;
d.addEventListener('submit',function(v){try{var f=v.target,o={},c=0,m,i,x,n,t,y,el=f.elements||[];if(f.hasAttribute('data-ib-ignore'))return;
for(i=0;i<el.length&&c<30;i++){x=el[i];n=x.name||x.id;t=(x.type||'').toLowerCase();
if(!n||x.disabled||/^(password|file|submit|button|reset)$/.test(t)||SX.test(n)||t=='hidden'&&/^(_|g-|h-)|id$|key$/i.test(n))continue;
y=t=='checkbox'||t=='radio'?x.checked&&(x.value&&x.value!='on'?x.value:true):x.value;if(!y)continue;
if(typeof y=='string'){y=z(y,2000);if(!m&&(t=='email'||/e-?mail/i.test(n))&&y.indexOf('@')>0)m=y;}
o[z(n.replace(/[^\w.:-]/g,'_'),64)]=y;c++;}
v={t:'form_submit',n:z(f.getAttribute('data-ib-form')||f.getAttribute('name')||f.id||f.getAttribute('action')||'form',200),f:o};if(m)v.e=z(m,254);sd(v,1);}catch(e){}},true);
d.addEventListener('click',function(v){try{var el=v.target.closest('[data-ib-track]');if(el)sd({t:'click',n:z((el.getAttribute('data-ib-track')||el.textContent||'').trim(),200),p:el.href?{href:z(el.href,256)}:void 0},1);}catch(e){}},true);
['pushState','replaceState'].forEach(function(m){var o=H[m];if(o)H[m]=function(){var r=o.apply(this,arguments);setTimeout(pv,0);return r;};});
w.addEventListener('popstate',pv);w.addEventListener('pagehide',fl);
w.ibConsent=function(v){C=!!v;p(ls,'ib_consent',C?'1':'0');if(C){P=0;pv();}else{try{ls.removeItem('ib_a');}catch(e){}q=[];}};
var Z=w.ib&&w.ib.q;
w.ib=function(c,a,b){if(c=='event')sd({t:'custom',n:z(a,200),p:cl(b)});else if(c=='identify'&&a)sd({t:'identify',e:z(a,254),p:cl(b)},1);else if(c=='consent')w.ibConsent(a);else if(c=='pageview'){P=0;pv();}};
if(Z)for(var i=0;i<Z.length;i++)w.ib.apply(w,Z[i]);
pv();
})(window,document);
`;

/** The snippet source served at `/plugins/business-agency/t/s.js` (whitespace-trimmed). */
export const SNIPPET_JS = SOURCE.split("\n")
  .map((l) => l.trim())
  .join("");

export function snippetJs(): string {
  return SNIPPET_JS;
}

/** Install tag for a site. */
export function snippetHtml(
  site: Pick<Site, "publicKey" | "consentMode">,
  baseUrl: string,
): string {
  const base = baseUrl.replace(/\/+$/, "");
  return `<script defer src="${base}${HUB_HTTP_BASE}/t/s.js" data-site="${site.publicKey}" data-mode="${site.consentMode}"></script>`;
}

/** Markdown install guide for the UI. */
export function installDoc(
  site: Pick<Site, "publicKey" | "consentMode" | "name">,
  baseUrl: string,
): string {
  const tag = snippetHtml(site, baseUrl);
  return `## Install tracking on ${site.name}

Paste this tag before \`</head>\` on every page (or in your site builder's "custom code" / header section):

\`\`\`html
${tag}
\`\`\`

**What it tracks automatically**
- Page views, including single-page-app navigation (history pushState / back-forward).
- UTM parameters from the landing URL (kept for the visit), and the referrer.
- Form submissions — every field except passwords, card / SSN-like fields and hidden tokens. A form with an email field creates or updates a **Contact** (lifecycle *lead*) and links all of that visitor's earlier page views to them. A checked consent / newsletter / opt-in box records email opt-in.
- Clicks on any element with \`data-ib-track="Name"\`.

**Optional API**
\`\`\`js
ib('event', 'Booked demo', { plan: 'pro' });   // custom event (≤20 props)
ib('identify', 'jane@example.com');            // tie this visitor to a contact
ibConsent(true);                                // consent-mode sites: start tracking
\`\`\`
Calls made before the script loads are queued if you add
\`<script>window.ib=window.ib||function(){(ib.q=ib.q||[]).push(arguments)}</script>\` first.

Add \`data-ib-ignore\` to a \`<form>\` to skip it, \`data-ib-form="Name"\` to name it.

**Privacy (consent mode: ${site.consentMode})**
- *cookieless* (default): no cookies; an anonymous id lives in the tab's sessionStorage and is hashed server-side with a salt that rotates daily, so visitors cannot be followed across days. No IP address is stored.
- *consent*: nothing is sent until \`ibConsent(true)\` is called or \`<html data-ib-consent="granted">\` is set; then a first-party localStorage id is used.
- *full*: first-party localStorage id.
Browsers sending Do-Not-Track or Global Privacy Control are not tracked (in consent mode, explicit consent wins).

Allowed origins: set them on the site so only your domains can send events.
`;
}
