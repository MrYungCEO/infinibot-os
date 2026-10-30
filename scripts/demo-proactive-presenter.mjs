#!/usr/bin/env node
/**
 * demo-proactive-presenter.mjs — end-to-end tour of the Proactive Presenter.
 *
 * Fires ONE proactive emit of every media kind through the gateway loopback
 * HTTP endpoint (`POST /api/proactive/emit`, no token required on loopback —
 * see src/gateway/server-proactive-http.ts), spaced 4s apart so you can watch
 * each surface land:
 *   • media-rich emits  → center-stage <proactive-presenter> focus card
 *   • walkthrough        → narrated <walkthrough-overlay> (3 scenes)
 *   • plain-text NOTABLE → corner toast (control case, last)
 *
 * Open the control UI (any route) first so a client is connected, then:
 *   node scripts/demo-proactive-presenter.mjs
 *   node scripts/demo-proactive-presenter.mjs --gap 6     # 6s spacing
 *   IB_GATEWAY_URL=http://127.0.0.1:18789 node scripts/demo-proactive-presenter.mjs
 *
 * The gateway requires its credential on every HTTP route: set
 * INFINIBOT_GATEWAY_TOKEN (or INFINIBOT_GATEWAY_PASSWORD).
 */

const URL_BASE = process.env.IB_GATEWAY_URL || "http://127.0.0.1:18789";
const ENDPOINT = `${URL_BASE}/api/proactive/emit`;
const SECRET = process.env.INFINIBOT_GATEWAY_TOKEN || process.env.INFINIBOT_GATEWAY_PASSWORD || "";
const gapArg = process.argv.indexOf("--gap");
const GAP_MS = (gapArg > -1 ? Number(process.argv[gapArg + 1]) : 4) * 1000;
const STAMP = Date.now();

// A tiny self-contained gold-on-black SVG so image/video cards render offline.
const SVG = (label) =>
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='640' height='360'>
       <rect width='640' height='360' fill='#0a0804'/>
       <rect x='8' y='8' width='624' height='344' fill='none' stroke='#d4af37' stroke-width='2' rx='14'/>
       <text x='320' y='190' fill='#d4af37' font-family='monospace' font-size='34'
             text-anchor='middle' font-weight='bold'>${label}</text>
     </svg>`,
  );

const attribution = { agentId: "orchestrator", agentName: "Voice Orchestrator" };

/** Each entry: { tier, kind, title, body, payload }. */
const EMITS = [
  {
    tier: "NOTABLE",
    kind: "stylized-markdown",
    title: "Stylized markdown timeline",
    body: "Reveals element-by-element with per-kind WAAPI entrances.",
    payload: {
      title: "What the mesh just shipped",
      sequential: true,
      markdown:
        "# Agent mesh — daily ship\n\nThree coders landed work overnight.\n\n- **Presenter surface** — center-stage focus card\n- **WAAPI presets** — pausable / seekable reveals\n- **Interact ops** — scene + timeline orchestration\n\n> Verifier gate stayed green across all three.\n\n```ts\nawait proactive.emit({ tier: 'NOTABLE', media });\n```",
    },
  },
  {
    tier: "NOTABLE",
    kind: "card-deck",
    title: "Swipeable card deck",
    body: "Each card swipes in (WAAPI swipeReveal).",
    payload: {
      cards: [
        { title: "Scope-locked spawns", bodyMarkdown: "No two agents touch the **same files** at once.", accent: "#d4af37" },
        { title: "Verifier gate", bodyMarkdown: "Every merge passes a fail-closed verifier.", imageUrl: SVG("VERIFY") },
        { title: "Federated swarm", bodyMarkdown: "Satellites route through the master hub." },
      ],
    },
  },
  {
    tier: "FYI",
    kind: "image",
    title: "Framed image (ken-burns)",
    body: "Static image gets a slow cinematic push-in.",
    payload: { url: SVG("RENDER"), alt: "render", caption: "flypic UGC frame · auto-surfaced" },
  },
  {
    tier: "FYI",
    kind: "video",
    title: "Framed video card",
    body: "Autoplays muted in the lightbox.",
    payload: { url: "https://example.com/clip.mp4", poster: SVG("VIDEO"), caption: "Promo cut · 0:12", durationMs: 12000 },
  },
  {
    tier: "NOTABLE",
    kind: "agent-summary",
    title: "Sub-agent finished",
    body: "Rich completion card with diff stats.",
    payload: {
      agentName: "presenter-coder",
      project: "Proactive Overlay",
      summaryMarkdown: "Built `proactive-presenter.ts`, wired WAAPI presets into 3 renderers, extended the interact channel.",
      diff: { filesChanged: 7, additions: 612, deletions: 18 },
    },
  },
  {
    tier: "FYI",
    kind: "note",
    title: "Note preview",
    body: "Pulled from notes.* and surfaced.",
    payload: { title: "Presenter design notes", bodyMarkdown: "Gold on **borders only**, never fills. 8px+ panel-edge gap. Draggable header." },
  },
  {
    tier: "NOTABLE",
    kind: "workflow",
    title: "Workflow run",
    body: "Step list with live status badges.",
    payload: {
      name: "review-changes",
      status: "running",
      steps: [
        { label: "Scaffold presenter", status: "done" },
        { label: "Wire animations", status: "done" },
        { label: "Flip routing", status: "running" },
        { label: "Demo + verify", status: "pending" },
      ],
    },
  },
  {
    tier: "FYI",
    kind: "activity",
    title: "Activity line",
    body: "Compact single-line entry.",
    payload: { icon: "✓", line: "Branch pushed", detail: "feat/proactive-presenter-overhaul" },
  },
  {
    tier: "FYI",
    kind: "custom",
    title: "Custom card",
    body: "Markdown + inline media.",
    payload: { bodyMarkdown: "A free-form card the agent assembled inline.", imageUrl: SVG("CUSTOM") },
  },
  {
    tier: "NOTABLE",
    kind: "html",
    title: "Sanitized HTML fragment",
    body: "Rendered in an isolated frame.",
    payload: {
      title: "Inline HTML",
      html: "<div style='font-family:monospace;color:#d4af37'><b>Inline HTML</b> rendered in the presenter frame.</div><ul><li>sanitized</li><li>isolated</li></ul>",
    },
  },
  {
    tier: "NOTABLE",
    kind: "pdf",
    title: "PDF artifact",
    body: "Embedded preview + open/download.",
    payload: { title: "Proactive Overlay — playbook.pdf", url: "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf", pageCount: 1 },
  },
  {
    tier: "CRITICAL",
    kind: "walkthrough",
    title: "Narrated walkthrough",
    body: "Center-stage narrated presenter — 3 scenes.",
    payload: {
      title: "Designing the agent mesh",
      voice: { engine: "kokoro", voiceId: "coral" },
      autoAdvance: true,
      scenes: [
        {
          kind: "markdown",
          content:
            "## The agent mesh\n\nA federated swarm of specialized coders, each owning a slice of the repo. **No two agents touch the same files at once.**\n\n- Scope-locked spawning\n- Verifier gate before merge\n- Center-stage walkthroughs",
          narration: "The mesh is a federated swarm of specialized coders. No two agents touch the same files at once.",
          revealMs: 600,
          holdMs: 500,
        },
        {
          kind: "code",
          content: {
            language: "ts",
            code: "await sessions.spawn({\n  task: 'add walkthrough overlay',\n  agentId: 'coder',\n  scope: ['ui/src/ui/components/walkthrough-overlay.ts']\n});",
            caption: "Scope-locked spawn keeps file ownership clean.",
          },
          narration: "Spawning is scope-locked. Each agent declares the files it owns up front.",
          revealMs: 600,
          holdMs: 400,
        },
        {
          kind: "choice",
          content: {
            prompt: "Where do you want to go from here?",
            choices: [
              { value: "ship", label: "Ship the presenter", detail: "Open the PR and move on" },
              { value: "iterate", label: "Iterate on the design", detail: "Tighten reveal animation" },
            ],
          },
          narration: "Where do you want to go from here? Pick one of the options on your screen.",
          revealMs: 500,
          holdMs: 400,
        },
      ],
    },
  },
  // Control case: plain-text NOTABLE with NO media → corner toast (not presenter).
  {
    tier: "NOTABLE",
    kind: null,
    title: "Plain toast (control)",
    body: "No media → falls back to the corner toast surface.",
    payload: null,
  },
];

async function emit(e, i) {
  const body = {
    tier: e.tier,
    title: e.title,
    body: e.body,
    attribution,
    dedupKey: `presenter-demo-${STAMP}-${i}-${e.kind ?? "plain"}`,
    ...(e.kind ? { media: { kind: e.kind, payload: e.payload } } : {}),
  };
  try {
    const resp = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(SECRET ? { Authorization: `Bearer ${SECRET}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const json = await resp.json().catch(() => ({}));
    const label = e.kind ? `${e.tier} ${e.kind}` : `${e.tier} plain-text`;
    console.log(
      `[${i + 1}/${EMITS.length}] ${resp.ok ? "✓" : "✗"} ${label} → ${json.routing?.appliedTier ?? resp.status}`,
    );
    if (!resp.ok) console.log("    ", JSON.stringify(json));
  } catch (err) {
    console.error(`[${i + 1}/${EMITS.length}] ✗ ${e.kind ?? "plain"} — ${err.message}`);
    console.error(`    Is the gateway up at ${URL_BASE}? Open the control UI first.`);
  }
}

console.log(`Proactive Presenter demo → ${ENDPOINT}  (gap ${GAP_MS / 1000}s)`);
console.log("Open the control UI in a connected browser to watch the surfaces land.\n");
for (let i = 0; i < EMITS.length; i++) {
  await emit(EMITS[i], i);
  if (i < EMITS.length - 1) await new Promise((r) => setTimeout(r, GAP_MS));
}
console.log("\nDone. Each media-rich emit lands as a center-stage focus card; the");
console.log("walkthrough narrates 3 scenes; the final plain-text pop is a corner toast.");
