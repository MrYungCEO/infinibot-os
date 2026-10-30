/**
 * Cheap, deterministic message checks (plan §2.3 / §2.6): scam links and
 * phrases, banned financial claims, invite links, and the Pulse disclaimer.
 * The same claim filter guards the bot's own outbound text.
 */

import { BUILTIN_BANNED_CLAIMS, BUILTIN_SCAM_DOMAINS } from "./defaults.js";

export type Finding =
  | { kind: "scam"; rule: string; match: string }
  | { kind: "banned_claim"; rule: string; match: string }
  | { kind: "invite"; rule: string; match: string };

/** "20% per month", "30%/week", "5% daily" — specific return promises. */
const RETURN_PROMISE_RE =
  /\b\d{1,3}(?:\.\d+)?\s?%\s?(?:\/|per|a|every|each)?\s?(?:day|daily|week|weekly|month|monthly|mo)\b/i;
const SCAM_PHRASE_RE =
  /\b(free\s+(?:discord\s+)?nitro|claim\s+your\s+nitro|steam\s+gift|airdrop\s+claim|send\s+me\s+\$?\d+\s+(?:and|&)\s+(?:get|receive))\b/i;
const URL_RE = /\bhttps?:\/\/([^\s/<>]+)[^\s<>]*/gi;
const INVITE_RE = /\b(?:discord\.gg|discord(?:app)?\.com\/invite)\/[A-Za-z0-9-]+/i;

function normalize(text: string): string {
  return text.toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, " ");
}

function hostOf(raw: string): string {
  return raw.toLowerCase().replace(/^www\./, "").replace(/:\d+$/, "");
}

/** Hosts that look like discord.com / steamcommunity.com but are not. */
function isLookalike(host: string): boolean {
  if (/^(?:.+\.)?(discord\.com|discord\.gg|discordapp\.com|discord\.media|discordapp\.net)$/.test(host)) {
    return false;
  }
  return /d[il1]sc[o0]rd|steamc[o0]m+un+[il1]ty/.test(host) && !/^(?:.+\.)?steamcommunity\.com$/.test(host);
}

export function detectScam(content: string, extraDomains: string[] = []): Finding | null {
  const text = content ?? "";
  const blocked = new Set([...BUILTIN_SCAM_DOMAINS, ...extraDomains].map((d) => hostOf(d.trim())).filter(Boolean));
  for (const m of text.matchAll(URL_RE)) {
    const host = hostOf(m[1] ?? "");
    if (!host) continue;
    const listed = [...blocked].find((d) => host === d || host.endsWith(`.${d}`));
    if (listed) return { kind: "scam", rule: "scam-domain", match: host };
    if (isLookalike(host)) return { kind: "scam", rule: "lookalike-domain", match: host };
  }
  const phrase = SCAM_PHRASE_RE.exec(text);
  if (phrase) return { kind: "scam", rule: "scam-phrase", match: phrase[0] };
  return null;
}

export function detectBannedClaim(content: string, extraClaims: string[] = []): Finding | null {
  const text = normalize(content ?? "");
  for (const claim of [...BUILTIN_BANNED_CLAIMS, ...extraClaims]) {
    const c = normalize(claim.trim());
    if (c && text.includes(c)) return { kind: "banned_claim", rule: "banned-claim", match: claim.trim() };
  }
  const ret = RETURN_PROMISE_RE.exec(content ?? "");
  if (ret) return { kind: "banned_claim", rule: "return-promise", match: ret[0] };
  return null;
}

export function detectInvite(content: string): Finding | null {
  const m = INVITE_RE.exec(content ?? "");
  return m ? { kind: "invite", rule: "invite-link", match: m[0] } : null;
}

export function classifyMessage(
  content: string,
  opts: { extraClaims?: string[]; extraDomains?: string[]; blockInvites?: boolean } = {},
): Finding | null {
  return (
    detectScam(content, opts.extraDomains) ??
    detectBannedClaim(content, opts.extraClaims) ??
    (opts.blockInvites ? detectInvite(content) : null)
  );
}

/** Footer the disclaimer onto bot text posted in a trading channel. */
export function withDisclaimer(text: string, disclaimer: string): string {
  const d = disclaimer.trim();
  if (!d) return text;
  if (text.includes(d)) return text;
  const footer = `\n\n-# ${d}`;
  const room = 2000 - footer.length;
  return `${text.slice(0, Math.max(0, room))}${footer}`;
}

export class OutboundBlockedError extends Error {
  constructor(public readonly finding: Finding) {
    super(`Blocked outbound message: contains a banned claim ("${finding.match}")`);
    this.name = "OutboundBlockedError";
  }
}

/** The bot never sends a banned claim (plan §2.6 "staff and bot messages are checked too"). */
export function assertCompliantOutbound(
  text: string,
  opts: { extraClaims?: string[]; disclaimer?: string } = {},
): void {
  // The disclaimer footer itself says "not financial advice": drop it (and
  // any `-#` footer line) before checking so it can't trip its own filter.
  let body = (text ?? "").replace(/^-#[^\n]*$/gm, "");
  const d = opts.disclaimer?.trim();
  if (d) body = body.split(d).join("");
  body = body.replace(/\bnot\s+financial advice\b/gi, "");
  const finding = detectBannedClaim(body, opts.extraClaims) ?? detectScam(body);
  if (finding) throw new OutboundBlockedError(finding);
}
