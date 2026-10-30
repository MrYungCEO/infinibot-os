/**
 * Animated SVG diagrams for the in-app Holo-Canvas walkthrough renderer.
 *
 * 1:1 copies of the standalone Netlify build's diagram snippets
 * (skills/infinite-canvas-walkthrough/templates/diagrams/*.svg). Each contains
 * SMIL `<animate>` / `<animateMotion>` / `<animateTransform>` so the diagrams
 * actually animate when inlined via Lit `unsafeSVG`.
 *
 * Keep these in sync with templates/diagrams/. The keys mirror the diagram file
 * names; a `diagram` node selects one by `node.diagram`.
 */

export type DiagramKey =
  | "context"
  | "fanout"
  | "mesh"
  | "federation"
  | "serial"
  | "compound"
  | "workflow";

export const CANVAS_DIAGRAMS: Record<DiagramKey, string> = {
  context: `<svg viewBox="0 0 440 210">
  <g stroke="#2a3252" stroke-width="1"><line x1="50" y1="20" x2="50" y2="170"/><line x1="50" y1="170" x2="410" y2="170"/></g>
  <text x="44" y="20" font-size="9" fill="#6b7392" text-anchor="end" font-family="Segoe UI">tokens</text>
  <text x="410" y="186" font-size="9" fill="#6b7392" text-anchor="end" font-family="Segoe UI">turns / work →</text>
  <path d="M50,168 Q200,150 410,40" fill="none" stroke="#e0564f" stroke-width="2.4" stroke-dasharray="520">
    <animate attributeName="stroke-dashoffset" from="520" to="0" dur="2.4s" repeatCount="indefinite"/></path>
  <path d="M50,168 L410,150" fill="none" stroke="#7fd4c8" stroke-width="2.4" stroke-dasharray="380">
    <animate attributeName="stroke-dashoffset" from="380" to="0" dur="2.4s" begin=".3s" repeatCount="indefinite"/></path>
  <circle r="4" fill="#e0564f"><animateMotion path="M50,168 Q200,150 410,40" dur="2.4s" repeatCount="indefinite"/></circle>
  <circle r="4" fill="#7fd4c8"><animateMotion path="M50,168 L410,150" dur="2.4s" begin=".3s" repeatCount="indefinite"/></circle>
  <g font-family="Segoe UI" font-size="11">
    <text x="250" y="70" fill="#e0564f" font-weight="700">solo · O(n²) re-read</text>
    <text x="250" y="135" fill="#7fd4c8" font-weight="700">fleet · linear in scope</text>
  </g>
</svg>`,
  fanout: `<svg viewBox="0 0 440 230">
  <g stroke="var(--gold)" stroke-width="1.6" fill="none">
    <line x1="70" y1="115" x2="190" y2="40"><animate attributeName="stroke-dasharray" values="0 200;200 0" dur="2.2s" repeatCount="indefinite"/></line>
    <line x1="70" y1="115" x2="190" y2="90"><animate attributeName="stroke-dasharray" values="0 200;200 0" dur="2.2s" begin="0.2s" repeatCount="indefinite"/></line>
    <line x1="70" y1="115" x2="190" y2="140"><animate attributeName="stroke-dasharray" values="0 200;200 0" dur="2.2s" begin="0.4s" repeatCount="indefinite"/></line>
    <line x1="70" y1="115" x2="190" y2="190"><animate attributeName="stroke-dasharray" values="0 200;200 0" dur="2.2s" begin="0.6s" repeatCount="indefinite"/></line>
  </g>
  <g font-family="Segoe UI" font-size="11" fill="#aab2cc" text-anchor="middle">
    <circle cx="48" cy="115" r="26" fill="rgba(212,175,55,.16)" stroke="var(--gold)" stroke-width="1.5"/>
    <text x="48" y="112" fill="#f4d77a" font-weight="700">VOICE</text><text x="48" y="126">you</text>
    <g>
      <circle cx="220" cy="40" r="20" fill="rgba(127,212,200,.14)" stroke="#7fd4c8"/><text x="220" y="44" fill="#cfe3d8">claude</text>
      <circle cx="220" cy="90" r="20" fill="rgba(212,175,55,.14)" stroke="#d4af37"/><text x="220" y="94" fill="#f4d77a">codex</text>
      <circle cx="220" cy="140" r="20" fill="rgba(155,140,255,.14)" stroke="#9b8cff"/><text x="220" y="144" fill="#c9bfff">gemini</text>
      <circle cx="220" cy="190" r="20" fill="rgba(95,176,255,.14)" stroke="#5fb0ff"/><text x="220" y="194" fill="#bfe0ff">opencode</text>
    </g>
    <circle cx="135" cy="115" r="17" fill="rgba(244,215,122,.2)" stroke="#f4d77a" stroke-dasharray="3 3"><animateTransform attributeName="transform" type="rotate" from="0 135 115" to="360 135 115" dur="9s" repeatCount="indefinite"/></circle>
    <text x="135" y="119" font-size="9" fill="#f4d77a">orch</text>
    <text x="330" y="60" text-anchor="start" fill="#6b7392" font-size="10">isolated context</text>
    <text x="330" y="118" text-anchor="start" fill="#6b7392" font-size="10">warm cache · own scope</text>
    <text x="330" y="176" text-anchor="start" fill="#6b7392" font-size="10">parallel, off your path</text>
  </g>
</svg>`,
  mesh: `<svg viewBox="0 0 440 220">
  <rect x="14" y="14" width="412" height="192" rx="14" fill="rgba(95,176,255,.05)" stroke="rgba(95,176,255,.25)"/>
  <text x="30" y="36" font-family="Segoe UI" font-size="10" fill="#5fb0ff" letter-spacing="2">ACTIVITY MESH</text>
  <g font-family="Segoe UI" font-size="9" fill="#aab2cc">
    <rect x="40" y="60" width="90" height="40" rx="8" fill="rgba(212,175,55,.08)" stroke="rgba(212,175,55,.3)"/><text x="85" y="84" text-anchor="middle" fill="#f4d77a">tool sector</text>
    <rect x="310" y="60" width="90" height="40" rx="8" fill="rgba(155,140,255,.08)" stroke="rgba(155,140,255,.3)"/><text x="355" y="84" text-anchor="middle" fill="#c9bfff">conduit →node</text>
    <rect x="175" y="150" width="90" height="38" rx="8" fill="rgba(127,212,200,.08)" stroke="rgba(127,212,200,.3)"/><text x="220" y="173" text-anchor="middle" fill="#7fd4c8">concourse · idle</text>
  </g>
  <circle r="5" fill="#f4d77a"><animateMotion path="M220,110 L85,80 L220,110 L355,80 L220,110 L220,169" dur="5s" repeatCount="indefinite"/></circle>
  <circle cx="220" cy="110" r="9" fill="rgba(244,215,122,.3)" stroke="#f4d77a"/>
  <line x1="355" y1="80" x2="395" y2="60" stroke="#9b8cff" stroke-dasharray="4 4"><animate attributeName="stroke-dashoffset" from="0" to="-30" dur="1.2s" repeatCount="indefinite"/></line>
</svg>`,
  federation: `<svg viewBox="0 0 440 230">
  <g>
    <circle cx="220" cy="115" r="30" fill="rgba(212,175,55,.18)" stroke="#f4d77a" stroke-width="2"/>
    <circle cx="220" cy="115" r="30" fill="none" stroke="#f4d77a"><animate attributeName="r" values="30;60;30" dur="3s" repeatCount="indefinite"/><animate attributeName="opacity" values=".7;0;.7" dur="3s" repeatCount="indefinite"/></circle>
    <text x="220" y="112" text-anchor="middle" font-size="11" fill="#f4d77a" font-family="Segoe UI" font-weight="700">MASTER</text>
    <text x="220" y="126" text-anchor="middle" font-size="9" fill="#aab2cc" font-family="Segoe UI">★ hub</text>
  </g>
  <g stroke="#9b8cff" stroke-width="1.5" fill="none" opacity=".8">
    <line x1="220" y1="115" x2="70" y2="50"/><line x1="220" y1="115" x2="70" y2="185"/>
    <line x1="220" y1="115" x2="380" y2="55"/><line x1="220" y1="115" x2="380" y2="180"/>
  </g>
  <g fill="rgba(155,140,255,.16)" stroke="#9b8cff" font-family="Segoe UI" font-size="9" text-anchor="middle">
    <circle cx="70" cy="50" r="22"/><text x="70" y="48" fill="#c9bfff">workstation</text><text x="70" y="60" fill="#6b7392">build</text>
    <circle cx="70" cy="185" r="22"/><text x="70" y="183" fill="#c9bfff">laptop</text><text x="70" y="195" fill="#6b7392">edits</text>
    <circle cx="380" cy="55" r="22"/><text x="380" y="53" fill="#c9bfff">node-3</text><text x="380" y="65" fill="#6b7392">tests</text>
    <circle cx="380" cy="180" r="22"/><text x="380" y="178" fill="#c9bfff">node-4</text><text x="380" y="190" fill="#6b7392">gpu</text>
  </g>
  <circle r="3.5" fill="#f4d77a"><animateMotion path="M220,115 L70,50" dur="1.8s" repeatCount="indefinite"/></circle>
  <circle r="3.5" fill="#f4d77a"><animateMotion path="M220,115 L380,180" dur="1.8s" begin=".5s" repeatCount="indefinite"/></circle>
  <circle r="3.5" fill="#7fd4c8"><animateMotion path="M70,185 L220,115" dur="1.8s" begin=".9s" repeatCount="indefinite"/></circle>
</svg>`,
  serial: `<svg viewBox="0 0 440 200">
  <g font-family="Segoe UI" font-size="10" fill="#aab2cc">
    <text x="14" y="40">SERIAL</text>
    <rect x="80" y="28" width="100" height="18" rx="4" fill="rgba(224,86,79,.5)" stroke="#e0564f"/>
    <rect x="184" y="28" width="100" height="18" rx="4" fill="rgba(224,86,79,.35)" stroke="#e0564f"/>
    <rect x="288" y="28" width="100" height="18" rx="4" fill="rgba(224,86,79,.22)" stroke="#e0564f"/>
    <text x="388" y="64" text-anchor="end" fill="#e0564f">≈ 18 min · sum</text>
    <text x="14" y="120">PARALLEL</text>
    <rect x="80" y="108" width="100" height="18" rx="4" fill="rgba(127,212,200,.5)" stroke="#7fd4c8"><animate attributeName="opacity" values=".4;1;.4" dur="2s" repeatCount="indefinite"/></rect>
    <rect x="80" y="130" width="100" height="18" rx="4" fill="rgba(212,175,55,.5)" stroke="#d4af37"><animate attributeName="opacity" values=".4;1;.4" dur="2s" begin=".3s" repeatCount="indefinite"/></rect>
    <rect x="80" y="152" width="100" height="18" rx="4" fill="rgba(155,140,255,.5)" stroke="#9b8cff"><animate attributeName="opacity" values=".4;1;.4" dur="2s" begin=".6s" repeatCount="indefinite"/></rect>
    <line x1="180" y1="100" x2="180" y2="178" stroke="#f4d77a" stroke-dasharray="3 3"/>
    <text x="196" y="150" fill="#7fd4c8">≈ 6 min · max</text>
  </g>
</svg>`,
  compound: `<svg viewBox="0 0 440 220">
  <g font-family="Segoe UI">
    <circle cx="90" cy="80" r="46" fill="rgba(212,175,55,.10)" stroke="#d4af37"/><text x="90" y="76" text-anchor="middle" font-size="10" fill="#f4d77a" font-weight="700">context</text><text x="90" y="90" text-anchor="middle" font-size="10" fill="#f4d77a">discipline</text>
    <circle cx="230" cy="80" r="46" fill="rgba(127,212,200,.10)" stroke="#7fd4c8"/><text x="230" y="76" text-anchor="middle" font-size="10" fill="#7fd4c8" font-weight="700">parallelism</text><text x="230" y="90" text-anchor="middle" font-size="9" fill="#7fd4c8">+ federation</text>
    <circle cx="370" cy="80" r="46" fill="rgba(95,176,255,.10)" stroke="#5fb0ff"/><text x="370" y="84" text-anchor="middle" font-size="10" fill="#5fb0ff" font-weight="700">visibility</text>
    <text x="160" y="86" text-anchor="middle" font-size="22" fill="#d4af37">×</text>
    <text x="300" y="86" text-anchor="middle" font-size="22" fill="#7fd4c8">×</text>
    <text x="220" y="180" text-anchor="middle" font-size="26" font-weight="900" fill="#f4d77a">= 10× leverage</text>
    <circle cx="90" cy="80" r="46" fill="none" stroke="#d4af37" opacity=".5"><animate attributeName="r" values="46;54;46" dur="3s" repeatCount="indefinite"/><animate attributeName="opacity" values=".5;0;.5" dur="3s" repeatCount="indefinite"/></circle>
    <circle cx="230" cy="80" r="46" fill="none" stroke="#7fd4c8" opacity=".5"><animate attributeName="r" values="46;54;46" dur="3s" begin="1s" repeatCount="indefinite"/><animate attributeName="opacity" values=".5;0;.5" dur="3s" begin="1s" repeatCount="indefinite"/></circle>
    <circle cx="370" cy="80" r="46" fill="none" stroke="#5fb0ff" opacity=".5"><animate attributeName="r" values="46;54;46" dur="3s" begin="2s" repeatCount="indefinite"/><animate attributeName="opacity" values=".5;0;.5" dur="3s" begin="2s" repeatCount="indefinite"/></circle>
  </g>
</svg>`,
  workflow: `<svg viewBox="0 0 440 210">
  <g font-family="Segoe UI" font-size="10">
    <text x="20" y="40" fill="#c9a227" font-weight="700">STATIC · one-shot</text>
    <g fill="rgba(201,162,39,.16)" stroke="#c9a227">
      <rect x="20" y="50" width="70" height="34" rx="7"/><rect x="110" y="50" width="70" height="34" rx="7"/><rect x="200" y="50" width="70" height="34" rx="7"/>
    </g>
    <g stroke="#c9a227" stroke-width="1.6" fill="none" marker-end="url(#ar)">
      <line x1="90" y1="67" x2="108" y2="67"/><line x1="180" y1="67" x2="198" y2="67"/>
    </g>
    <circle r="3.5" fill="#f4d77a"><animateMotion path="M30,67 H260" dur="2.4s" repeatCount="indefinite"/></circle>
    <text x="290" y="71" fill="#6b7392">finish ✓</text>

    <text x="20" y="135" fill="#d4af37" font-weight="700">CONTINUOUS · daemon loop</text>
    <g fill="rgba(212,175,55,.16)" stroke="#d4af37">
      <rect x="20" y="145" width="70" height="34" rx="7"/><rect x="150" y="145" width="70" height="34" rx="7"/></g>
    <path d="M90,162 H148" stroke="#d4af37" fill="none"/>
    <path d="M220,162 q60,0 60,-26 q0,-26 -130,-26 q-130,0 -130,26 q0,26 60,26" stroke="#d4af37" stroke-width="1.4" fill="none" stroke-dasharray="6 6">
      <animate attributeName="stroke-dashoffset" from="0" to="-200" dur="3s" repeatCount="indefinite"/></path>
    <circle r="3.5" fill="#f4d77a"><animateMotion path="M90,162 H220 q60,0 60,-26 q0,-26 -130,-26 q-130,0 -130,26 q0,26 60,26 H90" dur="3.4s" repeatCount="indefinite"/></circle>
    <text x="300" y="166" fill="#6b7392">until stop</text>
  </g>
  <defs><marker id="ar" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto"><path d="M0,0 L6,3.5 L0,7" fill="#c9a227"/></marker></defs>
</svg>`,
};

/** Narrow an arbitrary string to a known diagram key (or undefined). */
export function isDiagramKey(k: string | undefined): k is DiagramKey {
  return !!k && Object.prototype.hasOwnProperty.call(CANVAS_DIAGRAMS, k);
}
