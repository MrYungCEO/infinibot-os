#!/usr/bin/env node
// Render the public-facing /docs static tree from the existing docs/*.md
// sources + in-app walkthroughs. Idempotent: re-run any time, it overwrites.
//
//   pnpm docs:build   ->   node scripts/render-docs-static.mjs
//
// Output: docs/docs/<topic>/index.html  (served by Netlify at
// https://infinibotos.com/docs/<topic>/). The marketing root stays landing.html.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";
import { SETUP_GUIDE_HEAD, setupGuideJsonLd, setupGuidePlayerHtml } from "./setup-guide-video.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DOCS = join(ROOT, "docs");
const OUT = join(DOCS, "docs");
const WALK_DIR = join(ROOT, "src", "learn", "walkthroughs");

// ───────────────────────────────────────── manifest

// group -> ordered list of { url, src, title }
// `src` is relative to docs/. Pages without a src render inline `md`.
const CURATED = [
  // Quickstart
  ["Quickstart", "/start/getting-started", "start/getting-started.md", "Getting started"],
  ["Quickstart", "/install", "install/index.md", "Install"],
  ["Quickstart", "/cli/quickstart", "cli/quickstart.md", "CLI quickstart"],
  // Concepts
  ["Concepts", "/concepts/agent-workspace", "concepts/agent-workspace.md", "Agent workspace"],
  ["Concepts", "/concepts/multi-agent", "concepts/multi-agent.md", "Multi-agent"],
  ["Concepts", "/concepts/memory", "concepts/memory.md", "Memory"],
  ["Concepts", "/concepts/sessions", "concepts/sessions.md", "Sessions"],
  ["Concepts", "/concepts/models", "concepts/models.md", "Models"],
  // Gateway
  ["Gateway", "/gateway/configuration", "gateway/configuration.md", "Configuration"],
  ["Gateway", "/gateway/security", "gateway/security/index.md", "Security & hardening"],
  ["Gateway", "/security", "gateway/security/index.md", "Security overview"],
  ["Gateway", "/gateway/remote", "gateway/remote.md", "Remote gateway"],
  ["Gateway", "/gateway/discovery", "gateway/discovery.md", "Discovery"],
  ["Gateway", "/gateway/health", "gateway/health.md", "Health checks"],
  ["Gateway", "/gateway/troubleshooting", "gateway/troubleshooting.md", "Gateway troubleshooting"],
  ["Gateway", "/gateway/tailscale", "gateway/tailscale.md", "Tailscale"],
  ["Gateway", "/sandbox", "gateway/sandboxing.md", "Sandboxing"],
  // Channels
  ["Channels", "/web", "web/index.md", "Web & control UI"],
  ["Channels", "/web/control-ui", "web/control-ui.md", "Control UI"],
  // Tools
  ["Tools", "/tools/web", "tools/web.md", "Web search"],
  ["Tools", "/tools/slash-commands", "tools/slash-commands.md", "Slash commands"],
  ["Tools", "/tools/skills", "tools/skills.md", "Skills"],
  ["Tools", "/skills", "tools/skills.md", "Skills (alias)"],
  ["Tools", "/tools/chrome-extension", "tools/chrome-extension.md", "Chrome extension"],
  ["Tools", "/hooks", "hooks.md", "Hooks"],
  ["Tools", "/plugin", "plugin.md", "Plugins"],
  // Troubleshooting & FAQ
  ["Troubleshooting & FAQ", "/troubleshooting", "help/troubleshooting.md", "Troubleshooting"],
  ["Troubleshooting & FAQ", "/faq", "start/faq.md", "FAQ"],
  ["Troubleshooting & FAQ", "/start/faq", "start/faq.md", "Beginner FAQ"],
  ["Troubleshooting & FAQ", "/windows", "platforms/windows.md", "Windows"],
];

// Alias urls that render the same source as another page: they get a
// canonical link to the primary url and stay out of the sitemap.
const CANONICAL = {
  "/security": "/gateway/security",
  "/skills": "/tools/skills",
  "/start/faq": "/faq",
};

const SITE = "https://infinibotos.com";
const OG_IMAGE = `${SITE}/assets/landing/og-2026.png`;

// Inline pages (no .md source) — keyed by url.
const INLINE = {
  "/mcp/search-infinibot": {
    group: "Tools",
    title: "Docs search (SearchInfiniBot)",
    md: `# Docs search — SearchInfiniBot

InfiniBot ships a built-in documentation search backed by an MCP tool. From the
CLI run:

\`\`\`bash
infinibot docs "how do I harden the gateway"
\`\`\`

This queries the same content you're reading here and returns ranked snippets
with deep links. The search tool is exposed over MCP as **SearchInfiniBot**, so
any MCP-aware agent (including your own InfiniBot agents) can call it directly to
retrieve documentation context on demand.

- **CLI:** \`infinibot docs <query>\`
- **MCP tool:** \`SearchInfiniBot\` — argument \`{ "query": "..." }\`
- **Output:** title, deep link, and a short snippet per result.

If search returns nothing, browse the sidebar groups on this site instead.`,
  },
};

// ───────────────────────────────────────── helpers

function firstHeading(md) {
  const m = md.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

function titleCase(slug) {
  return slug
    .split(/[-/]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// Build the full page list.
const pages = []; // { url, src, group, title, md? }
const seenUrls = new Set();

function addPage(p) {
  if (seenUrls.has(p.url)) return;
  seenUrls.add(p.url);
  pages.push(p);
}

for (const [group, url, src, title] of CURATED) {
  addPage({ url, src, group, title });
}
for (const [url, def] of Object.entries(INLINE)) {
  addPage({ url, group: def.group, title: def.title, md: def.md });
}

// Auto: every CLI reference page.
const cliDir = join(DOCS, "cli");
if (existsSync(cliDir)) {
  for (const f of readdirSync(cliDir).filter((f) => f.endsWith(".md")).sort()) {
    const name = basename(f, ".md");
    const url = name === "index" ? "/cli" : `/cli/${name}`;
    const src = `cli/${f}`;
    const raw = readFileSync(join(cliDir, f), "utf8");
    addPage({ url, src, group: "CLI Reference", title: firstHeading(raw) || titleCase(name) });
  }
}

// Auto: channels.
const chDir = join(DOCS, "channels");
if (existsSync(chDir)) {
  for (const f of readdirSync(chDir).filter((f) => f.endsWith(".md")).sort()) {
    const name = basename(f, ".md");
    if (name === "index") continue;
    const src = `channels/${f}`;
    const raw = readFileSync(join(chDir, f), "utf8");
    addPage({
      url: `/channels/${name}`,
      src,
      group: "Channels",
      title: firstHeading(raw) || titleCase(name),
    });
  }
}

// Walkthroughs (synthetic page, built separately but indexed in the sidebar).
addPage({ url: "/walkthroughs", group: "Walkthroughs", title: "In-app walkthroughs", walkthroughs: true });

// ───────────────────────────────────────── theme + layout

const GROUP_ORDER = [
  "Quickstart",
  "Concepts",
  "Gateway",
  "Channels",
  "Tools",
  "CLI Reference",
  "Walkthroughs",
  "Troubleshooting & FAQ",
];

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const CSS = `
:root{
  --bg:#050507;--bg-2:#0a0a10;--surface:rgba(255,255,255,.025);--surface-2:rgba(255,255,255,.05);
  --surface-3:rgba(255,255,255,.09);--border:rgba(255,255,255,.075);--border-2:rgba(255,255,255,.14);
  --border-gold:rgba(251,191,36,.32);--text:#fafafa;--text-2:#e4e4e7;--text-3:#a1a1aa;--text-4:#71717a;
  --gold:#fbbf24;--gold-2:#f59e0b;--gold-3:#d97706;--accent:#6ea7ff;--magenta:#c084fc;
  --grad-gold:linear-gradient(135deg,#fef3c7 0%,#fbbf24 38%,#d97706 100%);
  --grad-mesh:radial-gradient(1200px 800px at 8% -10%,rgba(251,191,36,.085) 0%,transparent 60%),
              radial-gradient(900px 700px at 110% 110%,rgba(110,167,255,.055) 0%,transparent 65%),
              radial-gradient(700px 500px at 50% 50%,rgba(192,132,252,.04) 0%,transparent 70%);
  --font-display:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
  --font-body:"Chakra Petch","Inter",ui-sans-serif,system-ui,sans-serif;
  --font-mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
  --radius-md:18px;--radius-sm:10px;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font-body);
  font-size:16px;line-height:1.7;-webkit-font-smoothing:antialiased;background-image:var(--grad-mesh);
  background-attachment:fixed;}
a{color:var(--gold);text-decoration:none}
a:hover{text-decoration:underline}
/* nav */
.nav{position:sticky;top:0;z-index:50;display:flex;align-items:center;gap:20px;
  padding:14px 24px;border-bottom:1px solid var(--border);
  background:rgba(5,5,7,.72);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);}
.nav-brand{display:flex;align-items:center;gap:10px;font-family:var(--font-display);font-weight:700;
  letter-spacing:.04em;color:var(--text);text-transform:uppercase;font-size:15px}
.nav-brand img{width:30px;height:30px;border-radius:8px}
.nav-links{display:flex;gap:18px;margin-left:auto;flex-wrap:wrap}
.nav-links a{color:var(--text-3);font-size:14px;letter-spacing:.02em}
.nav-links a:hover{color:var(--text)}
.nav-links a.active{color:var(--gold)}
.nav-signin{margin-left:18px;margin-right:10px;white-space:nowrap;flex-shrink:0;padding:7px 14px;border-radius:999px;border:1px solid var(--border-gold);color:var(--text-2);font-size:14px;font-weight:600}
.nav-signin:hover{text-decoration:none;color:var(--text)}
.nav-cta{padding:8px 16px;border-radius:999px;background:var(--grad-gold);color:#1a1206;
  font-weight:700;font-size:13px;letter-spacing:.02em}
.nav-cta:hover{text-decoration:none;filter:brightness(1.05)}
/* layout */
.shell{display:grid;grid-template-columns:264px minmax(0,1fr);gap:0;max-width:1240px;margin:0 auto}
.sidebar{position:sticky;top:60px;align-self:start;height:calc(100vh - 60px);overflow-y:auto;
  padding:28px 18px 60px;border-right:1px solid var(--border)}
.sidebar h4{font-family:var(--font-display);font-size:11px;letter-spacing:.14em;text-transform:uppercase;
  color:var(--gold);margin:22px 8px 8px}
.sidebar h4:first-child{margin-top:0}
.sidebar a{display:block;padding:6px 10px;border-radius:8px;color:var(--text-3);font-size:14px}
.sidebar a:hover{background:var(--surface-2);color:var(--text);text-decoration:none}
.side-nav>summary{display:none}
.sidebar a.current{background:var(--surface-3);color:var(--gold);border:1px solid var(--border-gold)}
.content{padding:40px 48px 120px;min-width:0}
.crumbs{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-4);margin-bottom:18px}
.crumbs a{color:var(--text-4)}
/* markdown body */
.md h1{font-family:var(--font-display);font-size:34px;line-height:1.2;margin:0 0 12px;
  background:var(--grad-gold);-webkit-background-clip:text;background-clip:text;color:transparent}
.md h2{font-family:var(--font-display);font-size:24px;margin:38px 0 12px;padding-bottom:8px;
  border-bottom:1px solid var(--border)}
.md h3{font-size:19px;margin:28px 0 8px;color:var(--text)}
.md h4{font-size:16px;margin:22px 0 6px;color:var(--text-2)}
.md p,.md li{color:var(--text-2)}
.md code{font-family:var(--font-mono);font-size:.88em;background:var(--surface-3);
  padding:2px 6px;border-radius:6px;border:1px solid var(--border)}
.md pre{background:#0b0b12;border:1px solid var(--border);border-radius:var(--radius-md);
  padding:18px 20px;overflow-x:auto;margin:18px 0}
.md pre code{background:none;border:none;padding:0;font-size:13.5px;line-height:1.6;color:#e4e4e7}
.md a{color:var(--gold)}
.md blockquote{margin:18px 0;padding:10px 18px;border-left:3px solid var(--border-gold);
  background:var(--surface);border-radius:0 var(--radius-sm) var(--radius-sm) 0;color:var(--text-3)}
.md table{border-collapse:collapse;width:100%;margin:18px 0;font-size:14px}
.md th,.md td{border:1px solid var(--border);padding:8px 12px;text-align:left}
.md th{background:var(--surface-2);font-family:var(--font-display);font-size:12px;letter-spacing:.04em;
  text-transform:uppercase;color:var(--text-3)}
.md img{display:block;max-width:min(100%,760px);height:auto;margin:14px 0;border-radius:var(--radius-md);border:1px solid var(--border)}
.md hr{border:none;border-top:1px solid var(--border);margin:32px 0}
/* docs index grid */
.hero-doc{margin-bottom:36px}
.hero-doc h1{font-family:var(--font-display);font-size:40px;background:var(--grad-gold);
  -webkit-background-clip:text;background-clip:text;color:transparent;margin:0 0 10px}
.hero-doc p{color:var(--text-3);font-size:17px;max-width:62ch}
.grp{margin:34px 0}
.grp h2{font-family:var(--font-display);font-size:15px;letter-spacing:.12em;text-transform:uppercase;
  color:var(--gold);margin:0 0 14px}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px}
.card{display:block;padding:16px 18px;border:1px solid var(--border);border-radius:var(--radius-md);
  background:var(--surface);transition:border-color .18s ease,transform .18s ease}
.card:hover{border-color:var(--border-gold);text-decoration:none;transform:translateY(-2px)}
.card .t{font-family:var(--font-display);font-size:14px;color:var(--text);letter-spacing:.02em}
.card .u{font-size:12px;color:var(--text-4);margin-top:4px;font-family:var(--font-mono)}
/* walkthrough cards */
.wk{display:grid;gap:14px;margin-top:10px}
.wk-card{border:1px solid var(--border);border-radius:var(--radius-md);background:var(--surface);
  padding:18px 20px}
.wk-card h3{margin:0 0 4px;font-size:18px}
.wk-card .meta{font-size:12px;color:var(--text-4);font-family:var(--font-mono);margin-bottom:8px}
.wk-card p{color:var(--text-3);margin:0 0 12px}
.wk-card .steps{font-size:13px;color:var(--text-4)}
.wk-card .open{display:inline-block;margin-top:12px;padding:7px 14px;border-radius:999px;
  border:1px solid var(--border-gold);color:var(--gold);font-size:13px;font-weight:700}
.wk-card .open:hover{background:var(--surface-2);text-decoration:none}
.foot{margin-top:60px;padding-top:24px;border-top:1px solid var(--border);color:var(--text-4);font-size:13px}
@media (max-width:880px){
  .shell{grid-template-columns:1fr}
  .sidebar{position:static;height:auto;border-right:none;border-bottom:1px solid var(--border)}
  .side-nav>summary{display:flex;align-items:center;justify-content:space-between;cursor:pointer;list-style:none;padding:12px 14px;border:1px solid var(--border-gold);border-radius:10px;color:var(--gold);font-weight:600;font-size:14px}
  .side-nav>summary::-webkit-details-marker{display:none}
  .side-nav>summary::after{content:"+";font-size:18px;line-height:1}
  .side-nav[open]>summary{margin-bottom:12px}
  .side-nav[open]>summary::after{content:"−"}
  .content{padding:28px 20px 80px}
  .nav-links{display:none}
  .nav-signin{margin-left:auto;margin-right:8px;padding:7px 12px}
}
@media (prefers-reduced-motion:reduce){
  *{animation:none!important;transition:none!important;scroll-behavior:auto!important}
}
`;

function navHtml(active) {
  return `<nav class="nav" aria-label="primary">
  <a class="nav-brand" href="/"><img src="/assets/landing/logos/infinibot-real.png" alt="" width="30" height="30" decoding="async">InfiniBot</a>
  <div class="nav-links">
    <a href="/docs/start/getting-started/">Getting started</a>
    <a href="/docs/" class="${active === "docs" ? "active" : ""}">Docs</a>
    <a href="/docs/faq/">FAQ</a>
    <a href="/#pricing">Pricing</a>
    <a href="https://cloud.infinibotos.com/licenses/">Licensing</a>
  </div>
  <a class="nav-signin" href="https://cloud.infinibotos.com/app/">Sign in</a>
  <a class="nav-cta" href="https://cloud.infinibotos.com/app/" data-cta="cloud">Start on Cloud</a>
</nav>`;
}

function sidebarHtml(currentUrl) {
  const byGroup = new Map();
  for (const p of pages) {
    if (!byGroup.has(p.group)) byGroup.set(p.group, []);
    byGroup.get(p.group).push(p);
  }
  const groups = [...byGroup.keys()].sort(
    (a, b) => (GROUP_ORDER.indexOf(a) + 1 || 99) - (GROUP_ORDER.indexOf(b) + 1 || 99),
  );
  let out = "";
  for (const g of groups) {
    out += `<h4>${escapeHtml(g)}</h4>`;
    for (const p of byGroup.get(g)) {
      const href = `/docs${p.url === "/" ? "/" : p.url}`;
      const cls = p.url === currentUrl ? ' class="current"' : "";
      out += `<a href="${href}"${cls}>${escapeHtml(p.title)}</a>`;
    }
  }
  return `<aside class="sidebar"><details class="side-nav" open><summary>Browse all docs</summary>${out}</details></aside>
<script>if(matchMedia("(max-width:880px)").matches){var d=document.querySelector(".side-nav");if(d)d.removeAttribute("open")}</script>`;
}

function escapeAttr(s) {
  return escapeHtml(String(s)).replace(/"/g, "&quot;");
}

function docUrl(url) {
  return url === "/" || url === "" ? `${SITE}/docs/` : `${SITE}/docs${url}/`;
}

function shell({ title, active, currentUrl, body, description, jsonLd, noindex, head = "" }) {
  const desc = escapeAttr(description || "InfiniBot documentation");
  const fullTitle = `${title} · InfiniBot Docs`;
  const canonical = docUrl(CANONICAL[currentUrl] ?? currentUrl);
  const ld = [].concat(jsonLd || []).map((j) => `\n<script type="application/ld+json">${JSON.stringify(j).replace(/</g, "\\u003c")}</script>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(fullTitle)}</title>
<meta name="description" content="${desc}">${noindex ? `\n<meta name="robots" content="noindex">` : `\n<link rel="canonical" href="${canonical}">`}
<meta property="og:type" content="article">
<meta property="og:site_name" content="InfiniBot">
<meta property="og:title" content="${escapeAttr(fullTitle)}">
<meta property="og:description" content="${desc}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${OG_IMAGE}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@infinibotos">
<meta name="twitter:title" content="${escapeAttr(fullTitle)}">
<meta name="twitter:description" content="${desc}">
<meta name="twitter:image" content="${OG_IMAGE}">${ld}
<link rel="icon" type="image/png" href="/assets/landing/logos/infinibot-navbar-logo.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=Chakra+Petch:wght@400;500;700&display=swap" rel="stylesheet">
<style>${CSS}</style>${head ? `\n${head}` : ""}
</head>
<body>
${navHtml(active)}
<div class="shell">
${sidebarHtml(currentUrl)}
<main class="content">
<!--email_off-->
${body}
<!--/email_off-->
<div class="foot">InfiniBot · <a href="/docs/">Docs home</a> · <a href="/docs/start/getting-started/">Getting started</a> · <a href="/download">Download</a> · <a href="https://cloud.infinibotos.com/licenses/">Licensing</a> · <a href="/">Back to site</a><br>© 2026 Kingly Intelligence Systems, LLC. InfiniBot is source-available under FSL-1.1-ALv2; each release becomes Apache-2.0 two years after it ships.</div>
</main>
</div>
</body>
</html>`;
}

// rewrite relative .md links to absolute /docs urls (best-effort)
function rewriteLinks(html, pageUrl) {
  return html.replace(/href="([^"]+)"/g, (full, href) => {
    if (/^(https?:|mailto:|#)/i.test(href)) return full;
    if (href.startsWith("/docs/")) return full;
    if (href.startsWith("/")) {
      const route = href.split(/[?#]/)[0].replace(/\/$/, "") || "/";
      const publicSiteRoutes = new Set([
        "/", "/download", "/downloads", "/upgrade", "/why-we-win",
      ]);
      if (publicSiteRoutes.has(route)) return full;
      if (seenUrls.has(route)) return `href="/docs${href}"`;
      // The public docs are deliberately curated. Do not emit dead links to
      // source-only pages that the landing allowlist does not publish.
      return 'href="/docs/"';
    }
    let [path, frag = ""] = href.split("#");
    if (frag) frag = "#" + frag;
    path = path.replace(/\.mdx?$/, "");
    if (!path) return `href="${frag}"`;
    // resolve relative to the page's url directory
    const baseDir = pageUrl.replace(/\/[^/]*$/, "");
    const parts = (baseDir + "/" + path).split("/");
    const stack = [];
    for (const part of parts) {
      if (part === "" || part === ".") continue;
      if (part === "..") stack.pop();
      else stack.push(part);
    }
    return `href="/docs/${stack.join("/")}${frag}"`;
  });
}

function addHeadingIds(html) {
  const counts = new Map();
  return html.replace(/<h([1-6])>([\s\S]*?)<\/h\1>/g, (_full, depth, inner) => {
    const text = inner
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
    const base = text.toLowerCase().trim().replace(/[^\w\s-]/g, "").replace(/\s/g, "-") || "section";
    const seen = counts.get(base) || 0;
    counts.set(base, seen + 1);
    const id = seen ? `${base}-${seen}` : base;
    const aliases = [];
    if (id === "hooks-gateway-webhooks") aliases.push("hooks");
    if (id === "agentsdefaultssandbox") aliases.push("agentsdefaults-sandbox");
    if (id.startsWith("channelstelegramaccounts--channelsdiscordaccounts--")) {
      aliases.push("telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts");
    }
    const aliasHtml = aliases.map((alias) => `<span id="${alias}" class="heading-alias" aria-hidden="true"></span>`).join("");
    return `${aliasHtml}<h${depth} id="${id}">${inner}</h${depth}>`;
  });
}

// A "## FAQ" section whose questions are "### ..." headings becomes FAQPage
// JSON-LD (answer = the text up to the next heading).
function mdToText(s) {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function faqJsonLd(md) {
  const m = md.match(/^## (?:FAQ|Questions and answers)\s*$([\s\S]*?)(?=^## |(?![\s\S]))/m);
  if (!m) return null;
  const items = [];
  const re = /^### (.+)$([\s\S]*?)(?=^### |(?![\s\S]))/gm;
  for (const q of m[1].matchAll(re)) {
    const answer = mdToText(q[2].replace(/^More questions:.*$/m, ""));
    if (answer) items.push({ "@type": "Question", name: mdToText(q[1]), acceptedAnswer: { "@type": "Answer", text: answer } });
  }
  return items.length ? { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: items } : null;
}

function renderMdPage(p) {
  let md;
  let summary = "";
  if (p.md) md = p.md;
  else {
    const srcPath = join(DOCS, p.src);
    if (!existsSync(srcPath)) {
      md = `# ${p.title}\n\n_Documentation for this topic is being migrated._`;
    } else {
      md = readFileSync(srcPath, "utf8");
      const fm = md.match(/^---\n([\s\S]*?)\n---\n/);
      if (fm) {
        const s = fm[1].match(/^summary:\s*(.+)$/m);
        if (s) summary = s[1].trim().replace(/^["']|["']$/g, "");
      }
      // strip mintlify frontmatter
      md = md.replace(/^---\n[\s\S]*?\n---\n/, "");
    }
  }
  let bodyHtml = addHeadingIds(marked.parse(md)).replace(/<img (?![^>]*loading=)/g, '<img loading="lazy" decoding="async" ');
  bodyHtml = rewriteLinks(bodyHtml, p.url);
  const derived = (md.replace(/^#.*$/m, "").replace(/[#>*`_\-]/g, "").trim().split("\n").find((l) => l.trim()) || "").slice(0, 150);
  const desc = summary || `${p.title}: ${derived}`.slice(0, 160);
  const body = `<div class="crumbs"><a href="/docs/">Docs</a> / ${escapeHtml(p.group)} / ${escapeHtml(p.title)}</div>
<article class="md">${bodyHtml}</article>`;
  const faq = faqJsonLd(md);
  // `<!--setup-guide:player-->` in a docs page embeds the setup-guide video
  // (config: scripts/setup-guide-video.mjs).
  const sgRe = /<!--setup-guide:player( compact)?-->/g;
  if (sgRe.test(body)) {
    const html = body.replace(sgRe, (_, c) => setupGuidePlayerHtml({ compact: Boolean(c) }));
    const jsonLd = [faq, setupGuideJsonLd(docUrl(CANONICAL[p.url] ?? p.url))].filter(Boolean);
    return shell({ title: p.title, active: "docs", currentUrl: p.url, body: html, description: desc, jsonLd, head: SETUP_GUIDE_HEAD });
  }
  return shell({ title: p.title, active: "docs", currentUrl: p.url, body, description: desc, jsonLd: faq });
}

function renderIndex() {
  const byGroup = new Map();
  for (const p of pages) {
    if (!byGroup.has(p.group)) byGroup.set(p.group, []);
    byGroup.get(p.group).push(p);
  }
  const groups = [...byGroup.keys()].sort(
    (a, b) => (GROUP_ORDER.indexOf(a) + 1 || 99) - (GROUP_ORDER.indexOf(b) + 1 || 99),
  );
  let grid = "";
  for (const g of groups) {
    grid += `<section class="grp"><h2>${escapeHtml(g)}</h2><div class="cards">`;
    for (const p of byGroup.get(g)) {
      grid += `<a class="card" href="/docs${p.url}"><div class="t">${escapeHtml(p.title)}</div><div class="u">/docs${p.url}</div></a>`;
    }
    grid += `</div></section>`;
  }
  const body = `<div class="hero-doc">
  <h1>InfiniBot Documentation</h1>
  <p>Everything you need to run InfiniBot — install, configure the gateway, harden your setup, wire channels and tools, and drive it from the CLI. Search from your terminal with <code>infinibot docs "your query"</code>.</p>
  <p><a href="/docs/start/getting-started/"><b>New here? Start with Getting started</b></a>: download, install (with help for the Windows warning), the 8-step setup and your first message. No API key or coding needed.</p>
</div>${grid}`;
  return shell({
    title: "Documentation",
    active: "docs",
    currentUrl: "/",
    body,
    description: "InfiniBot documentation: a beginner getting-started guide, install help for Windows and Linux, the gateway, security, channels, tools, CLI reference and walkthroughs.",
  });
}

function renderWalkthroughs() {
  let cards = "";
  const files = existsSync(WALK_DIR)
    ? readdirSync(WALK_DIR).filter((f) => f.endsWith(".json")).sort()
    : [];
  for (const f of files) {
    let w;
    try {
      w = JSON.parse(readFileSync(join(WALK_DIR, f), "utf8"));
    } catch {
      continue;
    }
    const steps = Array.isArray(w.steps) ? w.steps.length : 0;
    const mins = Array.isArray(w.steps)
      ? w.steps.reduce((n, s) => n + (Number(s.estMinutes) || 0), 0)
      : 0;
    cards += `<div class="wk-card">
  <h3>${escapeHtml(w.title || w.id || f)}</h3>
  <div class="meta">${escapeHtml(w.category || "Walkthrough")} · ${steps} steps${mins ? ` · ~${mins} min` : ""}${w.audience ? ` · ${escapeHtml(w.audience)}` : ""}</div>
  <p>${escapeHtml(w.description || "")}</p>
  ${steps ? `<div class="steps">${w.steps.map((s) => escapeHtml(s.title)).filter(Boolean).slice(0, 8).join(" &middot; ")}</div>` : ""}
  <a class="open" href="infinibot://walkthrough/${encodeURIComponent(w.id || basename(f, ".json"))}">Open in app &rarr;</a>
</div>`;
  }
  const body = `<div class="crumbs"><a href="/docs/">Docs</a> / Walkthroughs</div>
<div class="hero-doc"><h1>In-app walkthroughs</h1>
<p>Guided, interactive tours that run inside the InfiniBot app. Open one to launch it directly (the link is a no-op if InfiniBot isn't installed).</p></div>
<div class="wk">${cards || "<p>No walkthroughs found.</p>"}</div>`;
  return shell({ title: "Walkthroughs", active: "docs", currentUrl: "/walkthroughs", body, description: "Guided, interactive InfiniBot walkthroughs that open inside the app." });
}

function render404() {
  const body = `<div class="hero-doc"><h1>Page not found</h1>
<p>That documentation page doesn't exist (or moved). Head back to the <a href="/docs/">docs home</a> and browse the sidebar, or search from your terminal with <code>infinibot docs "your query"</code>.</p></div>`;
  return shell({ title: "Not found", active: "docs", currentUrl: "", body, description: "Documentation page not found.", noindex: true });
}

// ───────────────────────────────────────── write

function write(relUrl, html) {
  const dir = relUrl === "/" ? OUT : join(OUT, relUrl.replace(/^\//, ""));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "index.html");
  writeFileSync(file, html);
  return file;
}

mkdirSync(OUT, { recursive: true });
let count = 0;
const sizes = [];

write("/", renderIndex());
count++;

for (const p of pages) {
  let html;
  if (p.walkthroughs) html = renderWalkthroughs();
  else html = renderMdPage(p);
  const file = write(p.url, html);
  sizes.push([`/docs${p.url}`, Buffer.byteLength(html)]);
  count++;
}

// 404 (Netlify serves docs/docs/404.html via _redirects rule)
writeFileSync(join(OUT, "404.html"), render404());

// sitemap.xml: marketing pages + every primary docs page (aliases excluded).
const today = new Date().toISOString().slice(0, 10);
const siteUrls = [
  [`${SITE}/`, "1.0"],
  [`${SITE}/download`, "0.9"],
  [`${SITE}/why-we-win`, "0.6"],
  [`${SITE}/docs/`, "0.8"],
];
// Plugin showcase pages (scripts/build-plugin-pages.mjs): /plugins + /plugins/<id>.
try {
  const showcase = JSON.parse(readFileSync(join(DOCS, "plugin-showcase.json"), "utf8"));
  siteUrls.push([`${SITE}/plugins`, "0.8"]);
  for (const p of showcase.plugins) siteUrls.push([`${SITE}/plugins/${p.id}`, "0.7"]);
} catch {}
for (const p of pages) {
  if (CANONICAL[p.url]) continue;
  const pri = p.url === "/start/getting-started" ? "0.9" : ["/install", "/windows", "/faq"].includes(p.url) ? "0.8" : p.group === "CLI Reference" || p.group === "Channels" ? "0.4" : "0.5";
  siteUrls.push([docUrl(p.url), pri]);
}
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generated by scripts/render-docs-static.mjs. Do not edit by hand. -->
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${siteUrls.map(([loc, pri]) => `  <url><loc>${loc}</loc><lastmod>${today}</lastmod><priority>${pri}</priority></url>`).join("\n")}
</urlset>
`;
writeFileSync(join(DOCS, "sitemap.xml"), sitemap);

console.log(`Rendered ${count} pages into docs/docs/ (+ sitemap.xml, ${siteUrls.length} urls)`);
for (const [url, size] of sizes.sort((a, b) => a[0].localeCompare(b[0]))) {
  console.log(`  ${(size / 1024).toFixed(1).padStart(7)} KB  ${url}`);
}
