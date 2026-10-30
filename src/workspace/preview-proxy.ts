import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";

import {
  authenticateHttpRequest,
  isSameOrigin,
  type HttpAuthContext,
} from "../gateway/http-auth.js";
import {
  getWorkspaceDevServerManager,
  type WorkspaceDevServerManager,
} from "./dev-server-manager.js";
import type { WorkspaceFrameworkKind } from "./types.js";

export const WORKSPACE_DEV_PREFIX = "/api/workspace/dev/";

export function parseWorkspaceDevPath(
  rawUrl: string | undefined,
): { directoryId: string; upstreamPath: string; prefix: string } | null {
  if (!rawUrl) return null;
  const url = new URL(rawUrl, "http://localhost");
  if (!url.pathname.startsWith(WORKSPACE_DEV_PREFIX)) return null;
  const rest = url.pathname.slice(WORKSPACE_DEV_PREFIX.length);
  const slash = rest.indexOf("/");
  const encodedId = slash === -1 ? rest : rest.slice(0, slash);
  if (!encodedId) return null;
  let directoryId: string;
  try {
    directoryId = decodeURIComponent(encodedId);
  } catch {
    return null;
  }
  const suffix = slash === -1 ? "/" : rest.slice(slash);
  return {
    directoryId,
    upstreamPath: suffix + url.search,
    prefix: `${WORKSPACE_DEV_PREFIX}${encodeURIComponent(directoryId)}/`,
  };
}

/** Vite-family servers configured with `base` must see that base upstream. */
export function workspaceUpstreamPath(
  parsed: NonNullable<ReturnType<typeof parseWorkspaceDevPath>>,
  kind: WorkspaceFrameworkKind,
): string {
  if (["vite", "sveltekit", "astro"].includes(kind)) {
    return `${parsed.prefix}${parsed.upstreamPath.replace(/^\//, "")}`;
  }
  return parsed.upstreamPath;
}

function inspectorBootstrap(directoryId: string, prefix: string): string {
  const config = JSON.stringify({ directoryId, prefix });
  return `<script data-infinibot-inspector>(function(){
  const cfg=${config};
  const NativeWebSocket=window.WebSocket;
  window.WebSocket=function(url,protocols){
    try{const u=new URL(url,location.href);if(u.origin===location.origin&&!u.pathname.startsWith(cfg.prefix)){u.pathname=cfg.prefix.replace(/\\/$/,'')+u.pathname;}url=u.toString();}catch{}
    return protocols===undefined?new NativeWebSocket(url):new NativeWebSocket(url,protocols);
  };window.WebSocket.prototype=NativeWebSocket.prototype;
  const style=document.createElement('style');style.textContent='.__ib_hover,.__ib_selected{outline:2px solid #f6c85f!important;outline-offset:3px!important;cursor:crosshair!important}.__ib_selected{box-shadow:0 0 0 5px rgba(246,200,95,.18),0 0 28px rgba(246,200,95,.34)!important}#__ib_label{position:fixed;z-index:2147483647;display:none;pointer-events:none;padding:5px 9px;border:1px solid rgba(246,200,95,.82);border-radius:6px;background:rgba(11,10,8,.94);color:#f9dc7c;box-shadow:0 8px 24px rgba(0,0,0,.42);font:700 11px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.02em;white-space:nowrap}#__ib_label[data-pinned="true"]{display:block;background:#f6c85f;color:#16120a;border-color:#fff3bd}';document.documentElement.appendChild(style);
  const label=document.createElement('div');label.id='__ib_label';document.documentElement.appendChild(label);
  function inspectTarget(el){if(!(el instanceof Element))return null;return el.closest('[data-component],[data-testid],[data-source],[data-file],[id],section,article,header,nav,footer')||el;}
  function componentName(el){return el.getAttribute('data-component')||el.getAttribute('data-testid')||el.getAttribute('aria-label')||el.id||el.tagName.toLowerCase();}
  function placeLabel(el,pinned){const r=el.getBoundingClientRect();label.textContent=componentName(el);label.dataset.pinned=String(!!pinned);label.style.display='block';label.style.left=Math.max(8,Math.min(innerWidth-label.offsetWidth-8,r.left))+'px';const above=r.top-label.offsetHeight-7;const below=r.bottom+7;label.style.top=Math.max(8,above>=8?above:Math.min(innerHeight-label.offsetHeight-8,below))+'px';}
  function selector(el){if(el.id)return '#'+CSS.escape(el.id);const parts=[];while(el&&el.nodeType===1&&parts.length<5){let p=el.tagName.toLowerCase();if(el.classList.length)p+='.'+[...el.classList].slice(0,2).map(CSS.escape).join('.');const parent=el.parentElement;if(parent){const same=[...parent.children].filter(x=>x.tagName===el.tagName);if(same.length>1)p+=':nth-of-type('+(same.indexOf(el)+1)+')';}parts.unshift(p);el=parent;}return parts.join(' > ');}
  function source(el){const direct=el.getAttribute('data-source')||el.getAttribute('data-component')||el.getAttribute('data-file');if(direct)return direct;for(const key of Object.keys(el)){if(key.startsWith('__reactFiber$')){let f=el[key];for(let i=0;f&&i<20;i++,f=f.return){if(f._debugSource)return [f._debugSource.fileName,f._debugSource.lineNumber,f._debugSource.columnNumber].filter(Boolean).join(':');if(typeof f.elementType==='function'&&f.elementType.name)return f.elementType.name;}}}return null;}
  async function shot(el){try{const clone=document.documentElement.cloneNode(true);clone.querySelectorAll('script').forEach(x=>x.remove());const xml=new XMLSerializer().serializeToString(clone);const svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+innerWidth+'" height="'+innerHeight+'"><foreignObject width="100%" height="100%">'+xml+'</foreignObject></svg>';const img=new Image();let loaded=false;img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);await Promise.race([new Promise((ok,bad)=>{img.onload=()=>{loaded=true;ok()};img.onerror=bad}),new Promise(ok=>setTimeout(ok,1200))]);if(!loaded)throw new Error('snapshot timeout');const c=document.createElement('canvas');c.width=innerWidth;c.height=innerHeight;c.getContext('2d').drawImage(img,0,0);return c.toDataURL('image/png',.78);}catch{try{const c=document.createElement('canvas');c.width=Math.max(1,innerWidth);c.height=Math.max(1,innerHeight);const x=c.getContext('2d');const r=el.getBoundingClientRect();x.fillStyle=getComputedStyle(document.body).backgroundColor||'#090806';x.fillRect(0,0,c.width,c.height);x.strokeStyle='#f6c85f';x.lineWidth=4;x.strokeRect(r.x,r.y,r.width,r.height);x.fillStyle='#f6c85f';x.font='600 16px system-ui';x.fillText((el.innerText||el.textContent||el.tagName).trim().slice(0,80),Math.max(8,r.x),Math.max(20,r.y-8));return c.toDataURL('image/png',.78);}catch{return null;}}}
  document.addEventListener('mouseover',e=>{if(!window.__INFINIBOT_INSPECTOR__)return;document.querySelectorAll('.__ib_hover').forEach(x=>x.classList.remove('__ib_hover'));const el=inspectTarget(e.target);if(!el||el.id==='__ib_label')return;el.classList.add('__ib_hover');placeLabel(el,false);},true);
  document.addEventListener('mouseout',e=>{if(!window.__INFINIBOT_INSPECTOR__)return;const el=e.target;if(el instanceof Element)el.classList.remove('__ib_hover');if(label.dataset.pinned!=='true')label.style.display='none';},true);
  document.addEventListener('click',async e=>{if(!window.__INFINIBOT_INSPECTOR__)return;e.preventDefault();e.stopPropagation();document.querySelectorAll('.__ib_selected,.__ib_hover').forEach(x=>x.classList.remove('__ib_selected','__ib_hover'));const el=inspectTarget(e.target);if(!el)return;el.classList.add('__ib_selected');placeLabel(el,true);parent.postMessage({type:'infinibot:element-selected',directoryId:cfg.directoryId,selector:selector(el),tag:el.tagName.toLowerCase(),text:(el.innerText||el.textContent||'').trim().slice(0,500),html:el.outerHTML.slice(0,2000),source:source(el),screenshot:await shot(el)},location.origin);},true);
  window.addEventListener('message',e=>{if(e.origin!==location.origin)return;if(e.data&&e.data.type==='infinibot:inspector'){window.__INFINIBOT_INSPECTOR__=!!e.data.enabled;if(!window.__INFINIBOT_INSPECTOR__){document.querySelectorAll('.__ib_selected,.__ib_hover').forEach(x=>x.classList.remove('__ib_selected','__ib_hover'));label.style.display='none';label.dataset.pinned='false';}}});
  parent.postMessage({type:'infinibot:preview-ready',directoryId:cfg.directoryId},location.origin);
})();</script>`;
}

export function rewritePreviewText(body: string, directoryId: string, contentType: string): string {
  const prefix = `${WORKSPACE_DEV_PREFIX}${encodeURIComponent(directoryId)}/`;
  let next = body
    .replace(/((?:src|href|action)=(["']))\/(?!\/|api\/workspace\/dev\/)/gi, `$1${prefix}`)
    .replace(/url\((['"]?)\/(?!\/|api\/workspace\/dev\/)/gi, `url($1${prefix}`)
    .replace(
      /(["'`])\/(?:_next|@vite|@id|@fs|node_modules|src|assets)\//g,
      (match, quote) => `${quote}${prefix}${match.slice(2)}`,
    );
  if (/text\/html/i.test(contentType)) {
    const bootstrap = inspectorBootstrap(directoryId, prefix);
    next = /<head[\s>]/i.test(next)
      ? // Use a callback: the inspector contains the React key prefix
        // `__reactFiber$`; passing it as a replacement string makes `$'` expand
        // to the unmatched HTML suffix and corrupts the injected JavaScript.
        next.replace(
          /<head([^>]*)>/i,
          (_match, attrs: string) => `<head${attrs}><base href="${prefix}">${bootstrap}`,
        )
      : `${bootstrap}${next}`;
  }
  return next;
}

function filteredHeaders(req: IncomingMessage): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {
    ...req.headers,
    host: "127.0.0.1",
    "accept-encoding": "identity",
  };
  delete headers.authorization;
  delete headers.cookie;
  delete headers["x-infinibot-token"];
  delete headers["x-infinibot-password"];
  return headers;
}

export async function handleWorkspaceDevProxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  manager: WorkspaceDevServerManager = getWorkspaceDevServerManager(),
): Promise<boolean> {
  const parsed = parseWorkspaceDevPath(req.url);
  if (!parsed) return false;
  const record = manager.get(parsed.directoryId);
  if (!record || record.status !== "ready" || !record.port) {
    res.writeHead(503, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(
      JSON.stringify({
        error: "workspace_not_ready",
        status: record?.status ?? "stopped",
        detail: record?.error ?? null,
      }),
    );
    return true;
  }
  manager.touch(parsed.directoryId);
  await new Promise<void>((resolve) => {
    const upstream = http.request(
      {
        hostname: "127.0.0.1",
        port: record.port!,
        path: workspaceUpstreamPath(parsed, record.kind),
        method: req.method,
        headers: filteredHeaders(req),
      },
      (upstreamRes) => {
        const headers = { ...upstreamRes.headers };
        delete headers["x-frame-options"];
        delete headers["content-security-policy"];
        delete headers["content-security-policy-report-only"];
        const location = headers.location;
        if (
          typeof location === "string" &&
          location.startsWith("/") &&
          !location.startsWith(parsed.prefix)
        )
          headers.location = parsed.prefix + location.replace(/^\//, "");
        const contentType = String(headers["content-type"] ?? "");
        const rewrite = /text\/(?:html|css|javascript)|application\/(?:javascript|json)/i.test(
          contentType,
        );
        if (!rewrite) {
          res.writeHead(upstreamRes.statusCode ?? 502, headers);
          upstreamRes.pipe(res);
          upstreamRes.once("end", resolve);
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        upstreamRes.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size <= 8 * 1024 * 1024) chunks.push(chunk);
        });
        upstreamRes.once("end", () => {
          if (size > 8 * 1024 * 1024) {
            res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("workspace preview response too large to rewrite");
          } else {
            const body = rewritePreviewText(
              Buffer.concat(chunks).toString("utf8"),
              parsed.directoryId,
              contentType,
            );
            delete headers["content-length"];
            delete headers.etag;
            headers["cache-control"] = "no-cache";
            res.writeHead(upstreamRes.statusCode ?? 200, headers);
            res.end(body);
          }
          resolve();
        });
      },
    );
    upstream.once("error", (error) => {
      if (!res.headersSent)
        res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "workspace_proxy_failed", detail: error.message }));
      resolve();
    });
    req.pipe(upstream);
  });
  return true;
}

function writeUpgradeRequest(req: IncomingMessage, socket: net.Socket, upstreamPath: string): void {
  const lines = [`${req.method ?? "GET"} ${upstreamPath} HTTP/${req.httpVersion}`];
  for (const [name, value] of Object.entries(filteredHeaders(req))) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) lines.push(`${name}: ${item}`);
    else lines.push(`${name}: ${value}`);
  }
  socket.write(`${lines.join("\r\n")}\r\n\r\n`);
}

export async function handleWorkspaceDevProxyUpgrade(
  req: IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
  auth: HttpAuthContext,
  manager: WorkspaceDevServerManager = getWorkspaceDevServerManager(),
): Promise<boolean> {
  const parsed = parseWorkspaceDevPath(req.url);
  if (!parsed) return false;
  const authResult = await authenticateHttpRequest(req, auth);
  if (!authResult.ok || !isSameOrigin(req)) {
    clientSocket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    clientSocket.destroy();
    return true;
  }
  const record = manager.get(parsed.directoryId);
  if (!record || record.status !== "ready" || !record.port) {
    clientSocket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
    clientSocket.destroy();
    return true;
  }
  manager.touch(parsed.directoryId);
  const upstream = net.createConnection({ host: "127.0.0.1", port: record.port }, () => {
    writeUpgradeRequest(req, upstream, workspaceUpstreamPath(parsed, record.kind));
    if (head.length) upstream.write(head);
    clientSocket.pipe(upstream).pipe(clientSocket);
  });
  upstream.once("error", () => clientSocket.destroy());
  clientSocket.once("error", () => upstream.destroy());
  return true;
}
