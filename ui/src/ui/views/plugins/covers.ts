/**
 * Generated store covers for plugins that don't ship their own art.
 *
 * Original InfiniBot art only: gold line-work on black, one abstract motif
 * per store category, varied per plugin by a hash of its id so two channel
 * cards never look identical. Never a third-party logo or brand colour
 * (docs/licensing/BRAND-USAGE.md) — the plugin is identified by its name and
 * InfiniBot monogram, not by a mark.
 *
 * Returned as a `data:image/svg+xml` URL for an `<img>` (inert: no script).
 */

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Tiny deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const W = 640;
const H = 360;
const r1 = (n: number) => Math.round(n * 10) / 10;

function orbits(r: () => number): string {
  const cx = 420 + r() * 80;
  const cy = 170 + r() * 40;
  let out = "";
  for (let i = 0; i < 4; i++) {
    const rx = 70 + i * 52;
    const ry = rx * (0.42 + r() * 0.12);
    const rot = -18 + r() * 36;
    out += `<ellipse cx="${r1(cx)}" cy="${r1(cy)}" rx="${r1(rx)}" ry="${r1(ry)}" transform="rotate(${r1(rot)} ${r1(cx)} ${r1(cy)})" stroke="url(#g)" stroke-opacity="${r1(0.75 - i * 0.14)}" stroke-width="1.4" fill="none"/>`;
    const a = r() * Math.PI * 2;
    out += `<circle cx="${r1(cx + Math.cos(a) * rx)}" cy="${r1(cy + Math.sin(a) * ry)}" r="${r1(3 + r() * 3)}" fill="#fbbf24" fill-opacity="${r1(0.9 - i * 0.15)}"/>`;
  }
  const hex = Array.from({ length: 6 }, (_, k) => {
    const t = (Math.PI / 3) * k + Math.PI / 6;
    return `${r1(cx + Math.cos(t) * 26)},${r1(cy + Math.sin(t) * 26)}`;
  }).join(" ");
  out += `<polygon points="${hex}" fill="#fbbf24" fill-opacity="0.12" stroke="#fbbf24" stroke-width="1.6"/>`;
  return out;
}

function bubbles(r: () => number): string {
  let out = "";
  const x0 = 360 + r() * 60;
  for (let i = 0; i < 3; i++) {
    const x = x0 + i * 46 - (i % 2) * 90;
    const y = 70 + i * 74;
    const w = 150 + r() * 70;
    const h = 56;
    const op = r1(0.85 - i * 0.2);
    out += `<rect x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${h}" rx="18" stroke="url(#g)" stroke-opacity="${op}" stroke-width="1.5" fill="#fbbf24" fill-opacity="${r1(0.04 + i * 0.02)}"/>`;
    const tail = i % 2 ? `${r1(x + w - 26)},${y + h} ${r1(x + w - 8)},${y + h + 14} ${r1(x + w - 40)},${y + h}` : `${r1(x + 26)},${y + h} ${r1(x + 8)},${y + h + 14} ${r1(x + 40)},${y + h}`;
    out += `<polyline points="${tail}" stroke="url(#g)" stroke-opacity="${op}" stroke-width="1.5" fill="none"/>`;
    for (let k = 0; k < 3; k++) {
      const lw = 30 + r() * (w - 80);
      out += `<rect x="${r1(x + 18)}" y="${r1(y + 14 + k * 11)}" width="${r1(Math.min(lw, w - 36))}" height="3" rx="1.5" fill="#fbbf24" fill-opacity="${r1(0.35 - k * 0.08)}"/>`;
    }
  }
  const sx = 110 + r() * 60;
  for (let i = 1; i <= 4; i++) {
    out += `<path d="M ${r1(sx - i * 22)} ${r1(250 - i * 22)} A ${i * 30} ${i * 30} 0 0 1 ${r1(sx + i * 22)} ${r1(250 - i * 22)}" stroke="#fbbf24" stroke-opacity="${r1(0.5 - i * 0.09)}" stroke-width="1.4" fill="none"/>`;
  }
  out += `<circle cx="${r1(sx)}" cy="250" r="5" fill="#fbbf24"/>`;
  return out;
}

function nodes(r: () => number): string {
  const pts: [number, number][] = [];
  for (let i = 0; i < 9; i++) pts.push([300 + r() * 300, 50 + r() * 260]);
  let out = "";
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const [ax, ay] = pts[i]!;
      const [bx, by] = pts[j]!;
      if (Math.hypot(ax - bx, ay - by) < 150)
        out += `<line x1="${r1(ax)}" y1="${r1(ay)}" x2="${r1(bx)}" y2="${r1(by)}" stroke="#fbbf24" stroke-opacity="0.32" stroke-width="1.1"/>`;
    }
  }
  for (const [x, y] of pts) {
    const big = r() > 0.6;
    out += `<circle cx="${r1(x)}" cy="${r1(y)}" r="${big ? 11 : 5}" fill="#0b0b0d" stroke="url(#g)" stroke-width="1.5"/>`;
    if (big) out += `<circle cx="${r1(x)}" cy="${r1(y)}" r="3.5" fill="#fbbf24"/>`;
  }
  // A plug: two prongs into a socket ring.
  const px = 150 + r() * 40;
  out += `<circle cx="${r1(px)}" cy="180" r="44" stroke="url(#g)" stroke-width="1.6" fill="#fbbf24" fill-opacity="0.06"/><rect x="${r1(px - 16)}" y="160" width="8" height="24" rx="3" fill="#fbbf24" fill-opacity="0.8"/><rect x="${r1(px + 8)}" y="160" width="8" height="24" rx="3" fill="#fbbf24" fill-opacity="0.8"/><path d="M ${r1(px)} 224 V 300" stroke="#fbbf24" stroke-opacity="0.5" stroke-width="1.4"/>`;
  return out;
}

function code(r: () => number): string {
  let out = `<text x="330" y="236" font-family="JetBrains Mono, ui-monospace, monospace" font-size="180" fill="none" stroke="url(#g)" stroke-width="1.5" stroke-opacity="0.8">{ }</text>`;
  for (let i = 0; i < 7; i++) {
    const indent = (Math.floor(r() * 3) + (i % 3)) * 16;
    const w = 60 + r() * 150;
    out += `<rect x="${60 + indent}" y="${70 + i * 30}" width="${r1(w)}" height="6" rx="3" fill="#fbbf24" fill-opacity="${r1(0.18 + r() * 0.35)}"/>`;
  }
  out += `<rect x="60" y="290" width="14" height="22" fill="#fbbf24" fill-opacity="0.85"/>`;
  return out;
}

const MOTIFS: Record<string, (r: () => number) => string> = {
  apps: orbits,
  channels: bubbles,
  integrations: nodes,
  developer: code,
};

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Cover for a plugin without listing art (deterministic per id + category).
 * `monogram` (the plugin's InfiniBot monogram) is drawn large and faint so
 * cards in the same category stay tellable apart.
 */
export function generatedCover(id: string, category: string, monogram?: string): string {
  const r = rng(hash(`${id}:${category}`));
  const flip = r() > 0.5;
  const motif = (MOTIFS[category] ?? orbits)(r);
  const mono = monogram ? escapeXml(monogram.slice(0, 3)) : "";
  const monoSvg = mono
    ? `<text x="${flip ? W - 40 : 40}" y="${H - 44}" text-anchor="${flip ? "end" : "start"}" font-family="JetBrains Mono, ui-monospace, monospace" font-weight="800" font-size="${mono.length > 2 ? 132 : 168}" letter-spacing="-6" fill="#fbbf24" fill-opacity="0.07" stroke="url(#g)" stroke-opacity="0.55" stroke-width="1.6">${mono}</text>`
    : "";
  const gx = r1(20 + r() * 60);
  const gy = r1(10 + r() * 50);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#121014"/><stop offset="1" stop-color="#060607"/></linearGradient>
<radialGradient id="glow" cx="${gx}%" cy="${gy}%" r="70%"><stop offset="0" stop-color="#fbbf24" stop-opacity="0.22"/><stop offset="1" stop-color="#fbbf24" stop-opacity="0"/></radialGradient>
<linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fde68a"/><stop offset="0.5" stop-color="#fbbf24"/><stop offset="1" stop-color="#b8860b"/></linearGradient>
<pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse"><path d="M32 0H0V32" fill="none" stroke="#fbbf24" stroke-opacity="0.05" stroke-width="1"/></pattern>
</defs>
<rect width="${W}" height="${H}" fill="url(#bg)"/><rect width="${W}" height="${H}" fill="url(#grid)"/><rect width="${W}" height="${H}" fill="url(#glow)"/>
${monoSvg}
<g${flip ? ` transform="translate(${W} 0) scale(-1 1)"` : ""} opacity="${r1(0.7 + r() * 0.3)}">${motif}</g>
<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" fill="none" stroke="#fbbf24" stroke-opacity="0.12"/>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
