// kg-embed.js — pure logic for the embedded (real web) Knowledge Graph.
//
// The phone shows the SAME <infinibot-knowledge-graph> the desktop control UI
// renders (three.js brain/galaxy, lobes, size-by-connections, consolidate, AI
// actions, lasso, link mode…), loaded from the active gateway in a WebView in
// its chromeless mobile mode: `/knowledge-graph?embed=mobile`.
//
// Bridge (mirrors ui/src/ui/components/knowledge-graph-embed.ts):
//   page → app : JSON `{ source: 'infinibot-kg', type, … }` via
//                ReactNativeWebView.postMessage (native) or a same-origin
//                parent.postMessage (the app's web export, iframe).
//                types: ready | haptic | open | back | chat | ask
//   app → page : native — injectJavaScript calling `window.__kgEmbed.*`;
//                web export — postMessage `{ source: 'infinibot-kg-host', cmd, … }`.

export const KG_BRIDGE_SOURCE = 'infinibot-kg';
export const KG_HOST_SOURCE = 'infinibot-kg-host';

/** Web group modes (knowledge-graph-ops.ts GROUP_MODES). */
export const WEB_GROUP_MODES = ['brain', 'orbit', 'project', 'status', 'type', 'cluster'];

/** Web layer kinds (knowledge-graph-model.ts KIND_ORDER). */
export const WEB_KINDS = [
  'project', 'client', 'opportunity', 'product', 'issue', 'decision', 'person', 'note', 'report', 'content',
  'agent', 'run', 'task', 'database', 'row', 'session', 'skill', 'node', 'user',
];

/** Phone-only visual kinds → the web layer that holds them (research lives in notes). */
const LAYER_ALIASES = { research: 'note', idea: 'note' };

const HAPTIC_STYLES = new Set(['selection', 'light', 'medium', 'heavy', 'success', 'warning', 'error']);

function str(v, max = 512) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

function truthy(v) {
  return v === true || v === 1 || v === '1' || v === 'true';
}

/**
 * Route params (deep links / other screens) → the page's deep-link params.
 *   { focus?: nodeId, project?: storeId, family?: bool, layer?: kind, group?: mode }
 */
export function deepLinkFromParams(params) {
  const p = params && typeof params === 'object' ? params : {};
  let focus = str(p.focus) || (str(p.project) ? `project:${str(p.project)}` : null);
  let layer = str(p.layer, 40);
  let group = str(p.group, 40);
  if (layer && LAYER_ALIASES[layer]) {
    layer = LAYER_ALIASES[layer];
    if (!group) group = 'type';
  }
  if (layer && !WEB_KINDS.includes(layer)) layer = null;
  if (group && !WEB_GROUP_MODES.includes(group)) group = null;
  return { focus, family: truthy(p.family), layer, group };
}

/** `/knowledge-graph?embed=mobile[&focus=…&family=1&layer=…&group=…]` */
export function buildKgEmbedPath(params) {
  const link = deepLinkFromParams(params);
  const q = ['embed=mobile'];
  if (link.focus) q.push(`focus=${encodeURIComponent(link.focus)}`);
  if (link.family) q.push('family=1');
  if (link.layer) q.push(`layer=${encodeURIComponent(link.layer)}`);
  if (link.group) q.push(`group=${encodeURIComponent(link.group)}`);
  return `/knowledge-graph?${q.join('&')}`;
}

/** Absolute embed URL on the gateway's HTTP origin (`http(s)://host:port`). */
export function buildKgEmbedUrl(httpBase, params) {
  const base = String(httpBase || '').replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) return null;
  return `${base}${buildKgEmbedPath(params)}`;
}

/** Signature of the params that should move the graph (dedupes re-renders). */
export function paramsSignature(params) {
  const l = deepLinkFromParams(params);
  return `${l.focus || ''}|${l.family ? 1 : 0}|${l.layer || ''}|${l.group || ''}|${(params && params._ts) || ''}`;
}

/** Validate a page → app message (a string or an already-parsed object). */
export function parseBridgeMessage(raw) {
  let d = raw;
  if (typeof d === 'string') {
    try { d = JSON.parse(d); } catch { return null; }
  }
  if (!d || typeof d !== 'object' || d.source !== KG_BRIDGE_SOURCE) return null;
  switch (d.type) {
    case 'ready':
      return { type: 'ready', nodes: Number.isFinite(d.nodes) ? d.nodes : 0, mode: str(d.mode, 8) || '3d' };
    case 'haptic':
      return HAPTIC_STYLES.has(d.style) ? { type: 'haptic', style: d.style } : null;
    case 'back':
      return { type: 'back' };
    case 'open': {
      const n = d.node && typeof d.node === 'object' ? d.node : null;
      const id = n && str(n.id);
      const kind = n && str(n.kind, 40);
      if (!id || !kind) return null;
      const meta = n.meta && typeof n.meta === 'object' && !Array.isArray(n.meta) ? n.meta : {};
      const path = str(d.path, 2048);
      return { type: 'open', node: { id, kind, label: str(n.label, 300) || id, meta }, path: path && path.startsWith('/') ? path : null };
    }
    case 'chat': {
      const sessionKey = str(d.sessionKey);
      return sessionKey ? { type: 'chat', sessionKey } : null;
    }
    case 'ask': {
      const prompt = str(d.prompt, 8000);
      const nodeIds = Array.isArray(d.nodeIds) ? d.nodeIds.map((x) => str(x)).filter(Boolean).slice(0, 200) : [];
      return prompt ? { type: 'ask', prompt, nodeIds } : null;
    }
    default:
      return null;
  }
}

/** Normalised host command: { cmd: 'focus'|'apply'|'fit'|'back', … } or null. */
export function hostCommand(cmd, arg = {}) {
  switch (cmd) {
    case 'focus': {
      const id = str(arg.id);
      return id ? { cmd: 'focus', id, family: !!arg.family } : null;
    }
    case 'apply': {
      const l = deepLinkFromParams(arg);
      return { cmd: 'apply', focus: l.focus, family: l.family, layer: l.layer, group: l.group };
    }
    case 'fit':
    case 'back':
      return { cmd };
    default:
      return null;
  }
}

/** JS for WebView.injectJavaScript (JSON-encoded args — never string-spliced). */
export function hostCommandScript(c) {
  if (!c) return 'true;';
  const call = (() => {
    switch (c.cmd) {
      case 'focus': return `k.focus(${JSON.stringify(c.id)},{family:${c.family ? 'true' : 'false'}})`;
      case 'apply': return `k.apply(${JSON.stringify({ focus: c.focus, family: c.family, layer: c.layer, group: c.group })})`;
      case 'fit': return 'k.fit()';
      case 'back': return 'k.back()';
      default: return '0';
    }
  })();
  return `(function(){try{var k=window.__kgEmbed;if(k){${call};}}catch(e){}})();true;`;
}

/** postMessage payload for the web export's iframe. */
export function hostCommandMessage(c) {
  return c ? JSON.stringify({ source: KG_HOST_SOURCE, ...c }) : null;
}

/** `http://host:port/...` → `http://host:port` (null when not http(s)). */
export function originOf(url) {
  const m = /^(https?:\/\/[^/?#]+)/i.exec(String(url || ''));
  return m ? m[1].toLowerCase() : null;
}
