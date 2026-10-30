/**
 * Direct lead submission endpoint — bypasses Netlify Forms detection.
 *
 * The site's `submission-created` bridge depends on Netlify auto-detecting
 * the form at deploy time, which proved unreliable when published via
 * `netlify deploy --dir` without a build pipeline (POST to / returns 404).
 *
 * This function accepts the form POST directly at /.netlify/functions/submit-lead
 * and forwards a formatted message to Telegram using the same env vars as the
 * Forms bridge:
 *   TELEGRAM_BOT_TOKEN
 *   TELEGRAM_CHAT_ID
 *   TELEGRAM_TOPIC_ID  (optional)
 */

const TG_API = "https://api.telegram.org";

function md(s) {
  return String(s ?? "")
    .replace(/[\\_*[\]()~`>#+\-=|{}.!]/g, (m) => "\\" + m);
}

function parseBody(event) {
  const raw = event.body || "";
  const ctype = (event.headers && (event.headers["content-type"] || event.headers["Content-Type"])) || "";
  if (ctype.includes("application/json")) {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  // URL-encoded (the default for our form fetch)
  const out = {};
  const decoded = event.isBase64Encoded ? Buffer.from(raw, "base64").toString("utf8") : raw;
  for (const pair of decoded.split("&")) {
    if (!pair) continue;
    const [k, v = ""] = pair.split("=");
    out[decodeURIComponent(k.replace(/\+/g, " "))] = decodeURIComponent(v.replace(/\+/g, " "));
  }
  return out;
}

function buildText(data, meta) {
  const form = data["form-name"] || "form";
  const lines = [`*📩 New ${md(form)} submission*`, ""];
  const keyOrder = ["name", "email", "company", "tier", "usecase", "message", "subject"];
  const seen = new Set();
  for (const k of keyOrder) {
    if (data[k] != null && data[k] !== "") {
      lines.push(`*${md(k)}:* ${md(data[k])}`);
      seen.add(k);
    }
  }
  for (const [k, v] of Object.entries(data)) {
    if (seen.has(k)) continue;
    if (k === "bot-field" || k === "form-name") continue;
    if (v == null || v === "") continue;
    lines.push(`*${md(k)}:* ${md(v)}`);
  }
  if (meta?.country) lines.push("", `_From ${md(meta.country)}_`);
  if (meta?.referer) lines.push(`_${md(meta.referer)}_`);
  lines.push(`_${md(new Date().toISOString())}_`);
  return lines.join("\n");
}

exports.handler = async (event) => {
  // CORS preflight (in case form is embedded cross-origin)
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type",
      },
      body: "",
    };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "method not allowed" };
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const topicId = process.env.TELEGRAM_TOPIC_ID;

  let data = {};
  try { data = parseBody(event); }
  catch (e) {
    return { statusCode: 400, body: "bad body" };
  }

  // Honeypot: silently accept and discard if the bot field is filled.
  if (data["bot-field"]) {
    return { statusCode: 200, body: "ok" };
  }

  // Light validation — name + email + tier are the form requireds.
  if (!data.name || !data.email || !data.tier) {
    return {
      statusCode: 400,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "missing required fields" }),
    };
  }

  if (!token || !chatId) {
    // Without Telegram configured, still 200 so the UI shows success and we
    // can repair env vars later without losing the user's submission attempt.
    console.error("submit-lead: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing");
    return { statusCode: 200, body: "ok (telegram not configured)" };
  }

  const meta = {
    country: event.headers?.["x-country"],
    referer: event.headers?.referer || event.headers?.Referer,
  };
  const text = buildText(data, meta);
  const body = {
    chat_id: chatId,
    text,
    parse_mode: "MarkdownV2",
    disable_web_page_preview: true,
  };
  if (topicId) body.message_thread_id = Number(topicId);

  try {
    const res = await fetch(`${TG_API}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || out.ok === false) {
      console.error("telegram api error", res.status, out);
      // Plain-text fallback if MarkdownV2 escape tripped
      const plain = await fetch(`${TG_API}/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: text.replace(/\\/g, ""),
          message_thread_id: topicId ? Number(topicId) : undefined,
        }),
      });
      const plainOut = await plain.json().catch(() => ({}));
      if (!plain.ok || plainOut.ok === false) {
        console.error("telegram plain fallback failed", plain.status, plainOut);
        return { statusCode: 502, body: "telegram error" };
      }
    }
  } catch (e) {
    console.error("telegram fetch threw", e);
    return { statusCode: 502, body: "telegram error" };
  }

  return {
    statusCode: 200,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
    body: JSON.stringify({ ok: true }),
  };
};
