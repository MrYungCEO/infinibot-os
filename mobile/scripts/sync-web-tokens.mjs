#!/usr/bin/env node
/**
 * sync-web-tokens — pull the web UI's design tokens (CSS custom properties)
 * into the mobile theme, so the mobile chat is styled from the same source as
 * the web chat instead of a hand-copied palette.
 *
 *   node mobile/scripts/sync-web-tokens.mjs          # rewrite the generated file
 *   node mobile/scripts/sync-web-tokens.mjs --check  # exit 1 if it is stale
 *
 * Sources (repo-relative):
 *   ui/src/styles/base.css      :root            — base palette, fonts, motion
 *   ui/src/ui/theme-glass.ts    [data-theme=hud] — the black + gold glass theme
 *   ui/src/ui/views/webchat.ts  :host / .wc-*    — chat metrics (radii, sizes)
 * Output: mobile/src/theme/web-tokens.generated.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const OUT = path.join(repo, 'mobile/src/theme/web-tokens.generated.js');
const read = (p) => fs.readFileSync(path.join(repo, p), 'utf8');

function block(src, startRe) {
  const m = startRe.exec(src);
  if (!m) throw new Error(`block not found: ${startRe}`);
  let depth = 0;
  for (let i = src.indexOf('{', m.index); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(src.indexOf('{', m.index) + 1, i);
  }
  throw new Error(`unterminated block: ${startRe}`);
}

function vars(css) {
  const out = {};
  const re = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;
  let m;
  while ((m = re.exec(css))) out[m[1]] = m[2].replace(/\s+/g, ' ').trim();
  return out;
}

const base = vars(block(read('ui/src/styles/base.css'), /^:root\s*\{/m));
const hud = vars(block(read('ui/src/ui/theme-glass.ts'), /:root\[data-theme="hud"\]\s*\{/));
const webchat = read('ui/src/ui/views/webchat.ts');
const wcHost = vars(block(webchat, /:host\s*\{/));
const all = { ...base, ...hud, ...wcHost };

function hexToRgb(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
}
function parseColor(v) {
  v = v.trim();
  if (v === 'transparent') return [0, 0, 0, 0];
  if (v.startsWith('#')) return hexToRgb(v);
  const m = /^rgba?\(([^)]+)\)$/.exec(v);
  if (m) {
    const p = m[1].split(',').map((s) => parseFloat(s));
    return [p[0], p[1], p[2], p[3] ?? 1];
  }
  return null;
}
const fmt = ([r, g, b, a]) =>
  a >= 1
    ? `#${[r, g, b].map((x) => Math.round(x).toString(16).padStart(2, '0')).join('')}`
    : `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${+a.toFixed(3)})`;

/** Resolve var() chains and `color-mix(in srgb, A N%, B)` to a concrete colour. */
function resolve(value, depth = 0) {
  if (depth > 12) return value;
  let v = String(value).trim();
  v = v.replace(/var\((--[a-z0-9-]+)(?:\s*,\s*((?:[^()]|\([^()]*\))+))?\)/gi, (_m, name, fb) => {
    if (all[name] && all[name] !== `var(${name})`) return resolve(all[name], depth + 1);
    return fb ? resolve(fb, depth + 1) : _m;
  });
  const mix = /^color-mix\(in (?:srgb|oklab),\s*(.+?)\s+([\d.]+)%\s*,\s*(.+)\)$/i.exec(v);
  if (mix) {
    const a = parseColor(resolve(mix[1], depth + 1));
    const b = parseColor(resolve(mix[3], depth + 1));
    const t = parseFloat(mix[2]) / 100;
    if (a && b) {
      // Premultiplied mix, like the browser.
      const alpha = a[3] * t + b[3] * (1 - t);
      const ch = (i) => (alpha === 0 ? 0 : (a[i] * a[3] * t + b[i] * b[3] * (1 - t)) / alpha);
      return fmt([ch(0), ch(1), ch(2), alpha]);
    }
  }
  const c = parseColor(v);
  return c ? fmt(c) : v;
}

const px = (re, fallback) => {
  const m = re.exec(webchat);
  return m ? parseFloat(m[1]) : fallback;
};
const rule = (sel) => block(webchat, new RegExp(`\\n\\s*${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`));
const prop = (css, name, fallback) => {
  const m = new RegExp(`(?:^|[;\\s])${name}\\s*:\\s*([^;]+);`).exec(css);
  return m ? m[1].trim() : fallback;
};
const num = (s, fallback) => {
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : fallback;
};

const bubble = rule('.wc-bubble');
const avatar = rule('.wc-avatar');
const item = rule('.wc-item');
const itemTitle = rule('.wc-item-title');
const itemMeta = rule('.wc-item-meta');
const composer = rule('.wc-composer');
const input = rule('.wc-input');
const send = rule('.wc-send');
const tool = rule('.wc-tool');

const tokens = {
  color: {
    bg: resolve(all['--g-bg']),
    bgDeep: resolve(all['--g-bg-deep']),
    bgElevated: resolve(base['--bg-elevated']),
    card: resolve(base['--card']),
    text: resolve(base['--text']),
    textStrong: resolve(base['--text-strong']),
    muted: resolve(base['--muted']),
    mutedStrong: resolve(base['--muted-strong']),
    border: resolve(base['--border']),
    borderStrong: resolve(base['--border-strong']),
    accent: resolve(all['--g-primary']),
    accentHover: resolve(base['--accent-hover']),
    accentForeground: resolve(base['--accent-foreground']),
    accent2: resolve(hud['--g-accent']),
    ok: resolve(base['--ok']),
    warn: resolve(base['--warn']),
    danger: resolve(base['--danger']),
    dangerSubtle: resolve(base['--danger-subtle']),
    info: resolve(base['--info']),
  },
  // Alpha recipes: applied to the LIVE accent on mobile (the web derives every
  // shade from --g-primary the same way, so a rebrand carries through).
  recipe: {
    surface: resolve(hud['--g-surface']),
    surfaceStrong: resolve(hud['--g-surface-strong']),
    surfaceHover: resolve(hud['--g-surface-hover']),
    accentSoftAlpha: num(/var\(--g-primary\)\s+([\d.]+)%/.exec(hud['--g-primary-muted'])?.[1], 18) / 100,
    borderAccentMix: num(/var\(--g-primary\)\s+([\d.]+)%/.exec(hud['--g-border'])?.[1], 18) / 100,
    borderBase: resolve(/,\s*(rgba\([^)]+\))\)$/.exec(hud['--g-border'])?.[1] || 'rgba(255,255,255,0.08)'),
    borderStrongAlpha: num(/var\(--g-primary\)\s+([\d.]+)%/.exec(hud['--g-border-strong'])?.[1], 40) / 100,
    activeRowFrom: 0.16,
    activeRowTo: 0.05,
    activeRowBorder: 0.26,
    rowHover: 0.06,
  },
  radius: {
    panel: num(hud['--g-radius'], 16),
    row: num(hud['--g-radius-sm'], 10),
    bubble: num(prop(bubble, 'border-radius'), 20),
    composer: num(prop(composer, 'border-radius'), 24),
    tool: num(hud['--g-radius-sm'], 10),
    code: 12,
  },
  size: {
    avatar: num(prop(avatar, 'width'), 28),
    assistantIndent: px(/\.wc-asst-body\s*\{\s*padding-left:\s*([\d.]+)px/, 36),
    bubbleMaxWidthPct: num(/min\(([\d.]+)%/.exec(prop(bubble, 'max-width', ''))?.[1], 85),
    bubblePadV: num(prop(bubble, 'padding', '10px 16px').split(' ')[0], 10),
    bubblePadH: num(prop(bubble, 'padding', '10px 16px').split(' ')[1], 16),
    turnGap: px(/\.wc-scroll \.wc-col\s*\{[^}]*gap:\s*([\d.]+)px/, 22),
    rowMinHeight: num(prop(item, 'min-height'), 48),
    sendButton: num(prop(send, 'width'), 34),
  },
  type: {
    body: num(prop(input, 'font-size'), 15),
    bodyLineHeight: 1.65,
    bubbleLineHeight: num(prop(bubble, 'line-height'), 1.55),
    rowTitle: num(prop(itemTitle, 'font-size'), 13),
    rowMeta: num(prop(itemMeta, 'font-size'), 11),
    asstName: 13,
    asstModel: 11,
    tool: num(prop(tool, 'font-size'), 12.5),
    code: 12.5,
    mono: base['--mono'].split(',')[0].replace(/"/g, '').trim(),
    display: 'Space Grotesk',
  },
  motion: {
    fast: num(base['--duration-fast'], 120),
    normal: num(base['--duration-normal'], 200),
    slow: num(base['--duration-slow'], 350),
  },
};

const body = `// GENERATED by mobile/scripts/sync-web-tokens.mjs — do not edit by hand.
// Source: ui/src/styles/base.css, ui/src/ui/theme-glass.ts (hud), ui/src/ui/views/webchat.ts
// Re-run the script after changing the web tokens; \`--check\` fails when stale.

export const WEB_TOKENS = ${JSON.stringify(tokens, null, 2)};

export default WEB_TOKENS;
`;

if (process.argv.includes('--check')) {
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (cur !== body) {
    console.error('web-tokens.generated.js is stale — run: node mobile/scripts/sync-web-tokens.mjs');
    process.exit(1);
  }
  console.log('web tokens up to date');
} else {
  fs.writeFileSync(OUT, body);
  console.log(`wrote ${path.relative(repo, OUT)}`);
}
