---
name: web-contact-form-telegram
description: Drop-in lead capture form + serverless endpoint that posts submissions to a Telegram chat. Works on any static site, Next/Vite/Astro app, or arbitrary hosting (Netlify Functions, Vercel, Cloudflare Workers, Express). Bypasses Netlify Forms detection so it works on static deploys with no build pipeline.
metadata: {"infinibot":{"emoji":"📨","requires":{"env":["TELEGRAM_BOT_TOKEN","TELEGRAM_CHAT_ID"]},"tags":["contact","forms","telegram","leads","integration","netlify","vercel","cloudflare"]}}
---

# web-contact-form-telegram

A reusable, framework-agnostic lead capture pipeline that takes any HTML form
on a website and routes submissions to a Telegram chat in real time.

This is the **canonical proof-of-concept** powering the InfiniBot landing page
contact form (`docs/landing.html`, `docs/netlify/functions/submit-lead.js`).
It was extracted from production after Netlify Forms detection proved
unreliable on static-only deploys.

## What you get

1. An HTML `<form>` snippet (drop-in, frameworkless, ~40 lines)
2. A serverless function (Node `exports.handler`, ports to Vercel / Cloudflare /
   Express in 10 lines)
3. URL-encoded *and* JSON body parsing
4. Honeypot bot field
5. MarkdownV2 Telegram formatting with plain-text fallback (graceful escape)
6. Forum topic support (`TELEGRAM_TOPIC_ID`)
7. CORS preflight (works when embedded cross-origin)
8. Async AJAX submit with a **native fallback** so submissions still land if
   `fetch` is blocked (CSP, service workers, no-JS users)

## Required environment variables

| Var | Purpose | Where to set |
|-----|---------|--------------|
| `TELEGRAM_BOT_TOKEN` | Bot token from `@BotFather` | Netlify/Vercel/CF env config |
| `TELEGRAM_CHAT_ID`   | Numeric chat ID (run `/start` against the bot, then `https://api.telegram.org/bot<token>/getUpdates` to read it) | env config |
| `TELEGRAM_TOPIC_ID`  | (optional) `message_thread_id` for forum supergroups | env config |

> Never commit these — set them in the host's dashboard.

## Quick start (Netlify)

```bash
# 1. Copy the function into your repo
mkdir -p netlify/functions
curl -O https://raw.githubusercontent.com/<github-owner>/<repo>/main/docs/netlify/functions/submit-lead.js
mv submit-lead.js netlify/functions/

# 2. Set env vars
netlify env:set TELEGRAM_BOT_TOKEN  "<from @BotFather>"
netlify env:set TELEGRAM_CHAT_ID    "<chat id>"

# 3. Add the form to any page (see "Form HTML" below)
# 4. Deploy
netlify deploy --prod --dir . --functions netlify/functions
```

## Form HTML (drop-in)

```html
<form id="lead-form" method="POST" action="/.netlify/functions/submit-lead">
  <!-- honeypot — bots fill this, humans never see it -->
  <p style="position:absolute;left:-9999px" aria-hidden="true">
    <label>Leave empty: <input name="bot-field" tabindex="-1" autocomplete="off" /></label>
  </p>
  <input type="hidden" name="form-name" value="my-form-id" />

  <label>Name *  <input type="text"  name="name"    required autocomplete="name" /></label>
  <label>Email * <input type="email" name="email"   required autocomplete="email" /></label>
  <label>Topic   <input type="text"  name="subject" /></label>
  <label>Message <textarea name="message" rows="4"></textarea></label>

  <button type="submit">Send</button>
  <p class="form-status" role="status" aria-live="polite"></p>
</form>

<script>
(function () {
  var form   = document.getElementById('lead-form');
  var status = form.querySelector('.form-status');

  function encode(d) {
    return Object.keys(d).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(d[k]);
    }).join('&');
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!form.reportValidity()) return;

    var fd   = new FormData(form);
    var data = {};
    fd.forEach(function (v, k) { data[k] = v; });
    if (data['bot-field']) return; // bot tripped honeypot

    var btn = form.querySelector('button[type=submit]');
    if (btn) btn.disabled = true;
    status.textContent = 'Sending…';

    fetch(form.action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: encode(data)
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      status.textContent = 'Thanks — we received your message.';
      form.reset();
    }).catch(function () {
      // Connection hiccup — submit natively so it still lands.
      status.textContent = 'Connection hiccup — resubmitting…';
      var fb = document.createElement('form');
      fb.method = 'POST'; fb.action = form.action;
      Object.keys(data).forEach(function (k) {
        var i = document.createElement('input');
        i.type = 'hidden'; i.name = k; i.value = data[k];
        fb.appendChild(i);
      });
      document.body.appendChild(fb);
      fb.submit();
    }).finally(function () {
      if (btn) btn.disabled = false;
    });
  });
})();
</script>
```

## Function — Netlify Functions (Node)

Save as `netlify/functions/submit-lead.js`. The canonical version lives in
this repo at `docs/netlify/functions/submit-lead.js`:

```js
const TG_API = "https://api.telegram.org";

function md(s) {
  return String(s ?? "").replace(/[\\_*[\]()~`>#+\-=|{}.!]/g, (m) => "\\" + m);
}

function parseBody(event) {
  const raw   = event.body || "";
  const ctype = (event.headers && (event.headers["content-type"] || event.headers["Content-Type"])) || "";
  if (ctype.includes("application/json")) {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  const decoded = event.isBase64Encoded ? Buffer.from(raw, "base64").toString("utf8") : raw;
  const out = {};
  for (const pair of decoded.split("&")) {
    if (!pair) continue;
    const [k, v = ""] = pair.split("=");
    out[decodeURIComponent(k.replace(/\+/g, " "))] = decodeURIComponent(v.replace(/\+/g, " "));
  }
  return out;
}

function buildText(data, meta) {
  const form  = data["form-name"] || "form";
  const lines = [`*📩 New ${md(form)} submission*`, ""];
  const order = ["name", "email", "company", "subject", "topic", "message"];
  const seen  = new Set();
  for (const k of order) if (data[k]) { lines.push(`*${md(k)}:* ${md(data[k])}`); seen.add(k); }
  for (const [k, v] of Object.entries(data)) {
    if (seen.has(k) || k === "bot-field" || k === "form-name" || !v) continue;
    lines.push(`*${md(k)}:* ${md(v)}`);
  }
  if (meta?.referer) lines.push(`_${md(meta.referer)}_`);
  lines.push(`_${md(new Date().toISOString())}_`);
  return lines.join("\n");
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "access-control-allow-origin":  "*",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type",
      },
      body: "",
    };
  }
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "method not allowed" };

  const token   = process.env.TELEGRAM_BOT_TOKEN;
  const chatId  = process.env.TELEGRAM_CHAT_ID;
  const topicId = process.env.TELEGRAM_TOPIC_ID;

  let data = {};
  try { data = parseBody(event); } catch { return { statusCode: 400, body: "bad body" }; }
  if (data["bot-field"]) return { statusCode: 200, body: "ok" }; // honeypot
  if (!data.name || !data.email) {
    return { statusCode: 400, body: JSON.stringify({ error: "missing required fields" }) };
  }
  if (!token || !chatId) return { statusCode: 200, body: "ok (telegram not configured)" };

  const text = buildText(data, { referer: event.headers?.referer });
  const body = { chat_id: chatId, text, parse_mode: "MarkdownV2", disable_web_page_preview: true };
  if (topicId) body.message_thread_id = Number(topicId);

  try {
    const res = await fetch(`${TG_API}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || out.ok === false) {
      // plain-text fallback if MarkdownV2 escape rejected something
      const plain = await fetch(`${TG_API}/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: text.replace(/\\/g, ""),
          message_thread_id: topicId ? Number(topicId) : undefined,
        }),
      });
      if (!plain.ok) return { statusCode: 502, body: "telegram error" };
    }
  } catch (e) {
    return { statusCode: 502, body: "telegram error" };
  }

  return {
    statusCode: 200,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
    body: JSON.stringify({ ok: true }),
  };
};
```

## Porting to other runtimes

### Vercel (`api/submit-lead.js`)

```js
import { handler } from "./_submit-lead.js"; // re-use parseBody/buildText
export const config = { api: { bodyParser: false } };
export default async function (req, res) {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString("utf8");
  const event = { httpMethod: req.method, headers: req.headers, body };
  const out = await handler(event);
  res.statusCode = out.statusCode;
  if (out.headers) for (const [k,v] of Object.entries(out.headers)) res.setHeader(k,v);
  res.end(out.body);
}
```

### Cloudflare Workers

```js
export default {
  async fetch(req, env) {
    const body = await req.text();
    const headers = Object.fromEntries(req.headers);
    return new Response(/* invoke handler */, { status: 200 });
  }
};
```

### Express

```js
app.post("/submit-lead", express.urlencoded({ extended: true }), async (req, res) => {
  const event = { httpMethod: "POST", headers: req.headers, body: new URLSearchParams(req.body).toString() };
  const out = await handler(event);
  res.status(out.statusCode).send(out.body);
});
```

## Customization

- **Field whitelist / order**: edit `buildText`'s `order` array.
- **Multiple forms on one site**: use the hidden `form-name` field — the Telegram message header reads `📩 New <form-name> submission`.
- **Routing different forms to different chats**: branch on `data["form-name"]` and pick `chat_id` accordingly.
- **Add SMS / Discord / Slack**: add another fetch after the Telegram call.
- **Prefill via query string or in-page CTA**: stamp a hidden field with the
  product/tier the user clicked, e.g. `<input type="hidden" name="tier" value="">` + JS that fills it on CTA click. See the `data-kv-prefill` pattern in
  `docs/landing.html` for a worked example.

## Gotchas

- **`netlify deploy --dir`** without `--functions` silently ships zero
  functions. Always pass `--functions netlify/functions` (or set it in
  `netlify.toml`).
- **Netlify Forms detection** is unreliable on static-only deploys — this
  skill **bypasses** Netlify Forms entirely by POSTing to the function URL
  directly. Don't add `data-netlify="true"` expecting both paths to work; the
  function path is sufficient.
- **MarkdownV2** escapes are strict. If a user's text breaks it, the function
  retries with plain text — don't disable this fallback.
- **Honeypot field** must be visually hidden but not `display:none` (some
  bots skip those). Use absolute off-screen positioning.

## Related

- Workflow `integrate-contact-form-telegram` — agent-runnable installer that
  wires this skill into any target website/repo end-to-end.
- Reference deployment: `docs/landing.html` + `docs/netlify/functions/submit-lead.js`.
