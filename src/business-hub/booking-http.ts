/** Public, self-contained booking page and ICS download for Lead Autopilot. */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  bookAppointment,
  bookingAvailability,
  bookingIcs,
  getBookingByToken,
  getOffer,
} from "./autopilot.js";
import { getHubDb, type HubDb } from "./db.js";
import { coerceString } from "../shared/text/coerce.js";

const BASE = "/plugins/business-agency";
const MAX_BODY = 64 * 1024;

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

function esc(value: unknown): string {
  return coerceString(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += b.length;
    if (total > MAX_BODY) return null;
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function send(
  res: ServerResponse,
  status: number,
  body: string,
  type = "text/html; charset=utf-8",
) {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  res.end(body);
}

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
  :root{color-scheme:dark light;--gold:#e6bd62;--gold2:#f8dda0;--ink:#f7f2e8;--muted:#b8ad9b;--base:#080706;--glass:rgba(24,20,14,.78);--line:rgba(230,189,98,.22);font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  *{box-sizing:border-box}body{margin:0;min-height:100vh;color:var(--ink);background:radial-gradient(circle at 10% 5%,rgba(230,189,98,.17),transparent 32%),radial-gradient(circle at 90% 90%,rgba(154,105,27,.12),transparent 38%),var(--base);display:grid;place-items:center;padding:24px}.wrap{width:min(920px,100%);display:grid;grid-template-columns:1fr 1.2fr;border:1px solid var(--line);border-radius:28px;overflow:hidden;background:linear-gradient(145deg,rgba(255,255,255,.06),transparent),var(--glass);box-shadow:0 30px 90px rgba(0,0,0,.45);backdrop-filter:blur(24px)}.intro{padding:42px;border-right:1px solid var(--line);display:flex;flex-direction:column}.eyebrow{font-size:11px;letter-spacing:.15em;text-transform:uppercase;color:var(--gold);font-weight:750}.intro h1{font-size:clamp(30px,5vw,52px);line-height:1.02;margin:18px 0 16px}.intro p{line-height:1.65;color:var(--muted)}.proof{margin-top:auto;padding-top:28px;font-size:13px;color:var(--gold2)}.book{padding:34px}.slots{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;max-height:330px;overflow:auto;margin:18px 0}.slot{border:1px solid var(--line);border-radius:12px;padding:11px;background:rgba(255,255,255,.035);color:var(--ink);cursor:pointer;text-align:left}.slot:hover,.slot:has(input:checked){border-color:var(--gold);background:rgba(230,189,98,.12)}.slot input{position:absolute;opacity:0}.fields{display:grid;gap:10px}.fields input,.fields textarea{width:100%;padding:12px 14px;border:1px solid var(--line);border-radius:12px;background:rgba(0,0,0,.2);color:var(--ink);font:inherit}.fields textarea{min-height:82px;resize:vertical}.cta{margin-top:12px;width:100%;border:0;border-radius:13px;padding:13px 18px;background:linear-gradient(135deg,var(--gold2),var(--gold));color:#211807;font-weight:800;cursor:pointer}.meta{display:flex;gap:8px;flex-wrap:wrap;color:var(--muted);font-size:12px}.pill{border:1px solid var(--line);border-radius:999px;padding:5px 9px}.success{text-align:center;padding:56px 32px}.success a{color:var(--gold2)}
  @media(max-width:700px){body{padding:12px}.wrap{grid-template-columns:1fr;border-radius:20px}.intro{padding:26px;border-right:0;border-bottom:1px solid var(--line)}.book{padding:22px}.proof{margin-top:10px}.slots{grid-template-columns:1fr;max-height:280px}}
  @media(prefers-reduced-transparency:reduce){.wrap{backdrop-filter:none;background:#18140e}}
  </style></head><body>${body}</body></html>`;
}

export function createBookingHttpHandlers(
  deps: { getDb?: () => HubDb } = {},
): Record<string, Handler> {
  const db = () => (deps.getDb ?? (() => getHubDb()))();
  const booking: Handler = async (req, res) => {
    const url = new URL(req.url ?? "/", "http://gateway.local");
    const offerKey = url.searchParams.get("offer") ?? "";
    const offer = getOffer(db(), offerKey);
    if (!offer || offer.status !== "active" || !offer.booking.enabled)
      return send(
        res,
        404,
        shell(
          "Booking unavailable",
          '<main class="wrap"><section class="success"><h1>Booking unavailable</h1><p>This booking page is not active.</p></section></main>',
        ),
      );
    if (req.method === "POST") {
      const raw = await readBody(req);
      if (raw === null) return send(res, 413, "payload too large", "text/plain");
      const data = new URLSearchParams(raw);
      try {
        const made = await bookAppointment(db(), {
          offerId: offer.id,
          campaignId: data.get("campaign") || null,
          name: data.get("name") ?? "",
          email: data.get("email") ?? "",
          startsAt: Number(data.get("startsAt") ?? 0),
          timezone: data.get("timezone") || offer.booking.timezone,
          notes: data.get("notes") || null,
        });
        const ics = `${BASE}/book/ics?token=${encodeURIComponent(made.publicToken)}`;
        return send(
          res,
          200,
          shell(
            "Booked",
            `<main class="wrap"><section class="success"><div class="eyebrow">Confirmed</div><h1>Your call is booked.</h1><p>${esc(new Date(made.startsAt).toLocaleString())} · ${esc(made.timezone)}</p><p><a href="${esc(ics)}">Add the ICS invite to your calendar</a></p></section></main>`,
          ),
        );
      } catch (err) {
        return send(
          res,
          400,
          shell(
            "Could not book",
            `<main class="wrap"><section class="success"><h1>That slot could not be booked.</h1><p>${esc(err instanceof Error ? err.message : String(err))}</p><p><a href="${esc(req.url ?? "")}">Choose another time</a></p></section></main>`,
          ),
        );
      }
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, POST" }).end();
      return;
    }
    const timezone = url.searchParams.get("timezone") || offer.booking.timezone;
    const campaign = url.searchParams.get("campaign") ?? "";
    const slots = bookingAvailability(db(), offer.id, { days: 14, timezone });
    const external = offer.booking.externalUrl
      ? `<p><a href="${esc(offer.booking.externalUrl)}">Use the external calendar instead</a></p>`
      : "";
    const html = shell(
      `Book ${offer.name}`,
      `<main class="wrap"><section class="intro"><div class="eyebrow">${esc(offer.name)}</div><h1>${esc(offer.valueProp || "Choose a time that works.")}</h1><p>${esc(offer.playbook.angle)}</p><div class="proof">${esc(offer.proof[0] ?? "A focused conversation, with no obligation.")}</div></section><section class="book"><div class="meta"><span class="pill">${offer.booking.durationMinutes} minutes</span><span class="pill">${esc(timezone)}</span></div><h2>Select a time</h2>${
        slots.length
          ? `<form method="post"><input type="hidden" name="campaign" value="${esc(campaign)}"><input type="hidden" name="timezone" value="${esc(timezone)}"><div class="slots">${slots
              .slice(0, 40)
              .map(
                (slot, index) =>
                  `<label class="slot"><input type="radio" name="startsAt" value="${slot.startsAt}" ${index === 0 ? "required" : ""}><span>${esc(slot.label)}</span></label>`,
              )
              .join(
                "",
              )}</div><div class="fields"><input name="name" autocomplete="name" placeholder="Your name" required><input name="email" type="email" autocomplete="email" placeholder="Email" required><textarea name="notes" placeholder="Anything we should know?"></textarea></div><button class="cta" type="submit">${esc(offer.cta.label || "Book call")}</button></form>`
          : "<p>No times are currently available. Please check back shortly.</p>"
      }${external}</section></main>`,
    );
    send(res, 200, req.method === "HEAD" ? "" : html);
  };

  const ics: Handler = async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET" }).end();
      return;
    }
    const token = new URL(req.url ?? "/", "http://gateway.local").searchParams.get("token") ?? "";
    const found = getBookingByToken(db(), token);
    if (!found) return send(res, 404, "not found", "text/plain; charset=utf-8");
    const body = bookingIcs(found.offer, found.booking);
    res.writeHead(200, {
      "content-type": "text/calendar; charset=utf-8; method=REQUEST",
      "content-disposition": `attachment; filename="${esc(found.offer.booking.slug)}.ics"`,
      "cache-control": "private, no-store",
    });
    res.end(req.method === "HEAD" ? "" : body);
  };

  return { [`${BASE}/book`]: booking, [`${BASE}/book/ics`]: ics };
}
