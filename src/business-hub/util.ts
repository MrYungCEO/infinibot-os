/**
 * Business hub — small shared helpers: ids, JSON columns and the
 * normalisers dedupe depends on (email, phone, domain, names).
 */

import { randomBytes } from "node:crypto";
import { coerceString } from "../shared/text/coerce.js";

export function hubId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("base64url")}`;
}

export function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = coerceString(v).trim();
  return s ? s : null;
}

const EMAIL_RE =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

// Scraped "emails" that are really asset names (logo@2x.png).
const FILE_EXT_TLDS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "avif",
  "css",
  "js",
  "ico",
  "bmp",
  "tiff",
  "mp4",
  "webm",
  "pdf",
]);

/** Lower-cased, trimmed email, or null when it is not a plausible address. */
export function normalizeEmail(raw: unknown): string | null {
  const s = str(raw)
    ?.replace(/^mailto:/i, "")
    .replace(/[<>"']/g, "")
    .trim()
    .toLowerCase();
  if (!s || s.length > 254 || !EMAIL_RE.test(s)) return null;
  const tld = s.slice(s.lastIndexOf(".") + 1);
  if (!/^[a-z]{2,24}$/.test(tld) || FILE_EXT_TLDS.has(tld)) return null;
  return s;
}

const COUNTRY_CODES: Record<string, string> = {
  US: "1",
  CA: "1",
  GB: "44",
  UK: "44",
  IE: "353",
  AU: "61",
  NZ: "64",
  DE: "49",
  FR: "33",
  ES: "34",
  IT: "39",
  NL: "31",
  BE: "32",
  CH: "41",
  AT: "43",
  SE: "46",
  NO: "47",
  DK: "45",
  FI: "358",
  PT: "351",
  PL: "48",
  RO: "40",
  MX: "52",
  BR: "55",
  AR: "54",
  IN: "91",
  ZA: "27",
  NG: "234",
  AE: "971",
  SG: "65",
  JP: "81",
  KR: "82",
  PH: "63",
};

/**
 * Best-effort E.164: keeps "+<digits>" as given, maps a national number with
 * a trunk "0" or a bare NANP 10-digit number onto the default country.
 * Returns null for anything that cannot be a phone number (< 7 digits).
 */
export function normalizePhone(raw: unknown, defaultCountry = "US"): string | null {
  const s = str(raw);
  if (!s) return null;
  const hasPlus = /^\s*(\+|00)/.test(s);
  let digits = s.replace(/^\s*00/, "").replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  if (hasPlus) return `+${digits}`;
  const cc = COUNTRY_CODES[defaultCountry.toUpperCase()] ?? "1";
  if (cc === "1") {
    if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
    if (digits.length === 10) return `+1${digits}`;
    return `+${digits}`;
  }
  if (digits.startsWith("0")) digits = digits.slice(1);
  if (digits.startsWith(cc) && digits.length > 9) return `+${digits}`;
  return `+${cc}${digits}`;
}

// Common multi-label public suffixes; enough for dedupe without a PSL dependency.
const TWO_LEVEL = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "ltd.uk",
  "plc.uk",
  "me.uk",
  "com.au",
  "net.au",
  "org.au",
  "co.nz",
  "org.nz",
  "co.za",
  "com.br",
  "com.mx",
  "com.ar",
  "co.jp",
  "co.kr",
  "co.in",
  "net.in",
  "org.in",
  "com.sg",
  "com.ph",
  "com.tr",
  "com.cn",
  "com.hk",
  "com.tw",
  "co.il",
  "com.my",
  "com.ng",
  "com.pk",
  "com.sa",
  "com.eg",
  "com.co",
  "com.pe",
  "com.ua",
  "co.id",
  "or.jp",
]);

const FREE_MAIL = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "ymail.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "gmx.de",
  "mail.com",
  "yandex.com",
  "yandex.ru",
  "zoho.com",
  "hey.com",
  "fastmail.com",
  "web.de",
  "qq.com",
  "163.com",
  "comcast.net",
  "att.net",
  "verizon.net",
  "sbcglobal.net",
  "yahoo.co.uk",
  "hotmail.co.uk",
  "btinternet.com",
]);

export function isFreeMailDomain(domain: string): boolean {
  return FREE_MAIL.has(domain.toLowerCase());
}

/** Registrable domain ("shop.acme.co.uk" → "acme.co.uk") from a URL, host or email. */
export function registrableDomain(raw: unknown): string | null {
  let s = str(raw)?.toLowerCase();
  if (!s) return null;
  if (s.includes("@") && !s.includes("/")) s = s.slice(s.lastIndexOf("@") + 1);
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").split(/[/?#:]/)[0] ?? "";
  s = s.replace(/^www\d?\./, "").replace(/\.$/, "");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(s) || /^\d+\.\d+\.\d+\.\d+$/.test(s)) return null;
  const parts = s.split(".");
  if (parts.length <= 2) return s;
  const last2 = parts.slice(-2).join(".");
  return TWO_LEVEL.has(last2) ? parts.slice(-3).join(".") : last2;
}

/** Normalised website URL ("acme.com/" → "https://acme.com"). */
export function normalizeWebsite(raw: unknown): string | null {
  const s = str(raw);
  if (!s) return null;
  const withProto = /^https?:\/\//i.test(s) ? s : `https://${s.replace(/^\/\//, "")}`;
  try {
    const u = new URL(withProto);
    if (!u.hostname.includes(".")) return null;
    return `${u.protocol}//${u.hostname.toLowerCase()}${u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "")}`;
  } catch {
    return null;
  }
}

/** Key for fuzzy company-name matching ("ACME, Inc." → "acme"). */
export function companyNameKey(name: unknown): string {
  return (str(name) ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’`]/g, "")
    .replace(/&/g, " and ")
    .replace(
      /\b(inc|llc|ltd|limited|corp|corporation|co|company|gmbh|sa|srl|plc|pty|bv|ag|the)\b\.?/g,
      " ",
    )
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Split "Jane Q. Doe" → { first: "Jane", last: "Doe" }. */
export function splitName(name: unknown): { first: string | null; last: string | null } {
  const s = str(name);
  if (!s) return { first: null, last: null };
  const parts = s.replace(/\s+/g, " ").split(" ");
  if (parts.length === 1) return { first: parts[0], last: null };
  return { first: parts[0], last: parts[parts.length - 1] };
}

export function titleCase(s: string): string {
  return s.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Parse a money-ish value ("$1,200.50", 1200.5, "1.200,50 €") into minor units. */
export function toCents(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.round(raw * 100);
  const s = str(raw);
  if (!s) return 0;
  let t = s.replace(/[^\d.,-]/g, "");
  if (/,\d{2}$/.test(t) && t.includes(".")) t = t.replace(/\./g, "").replace(",", ".");
  else if (/,\d{2}$/.test(t)) t = t.replace(",", ".");
  else t = t.replace(/,/g, "");
  const n = Number.parseFloat(t);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** Parse a date-ish value into epoch ms, or null. */
export function toMs(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "number") return raw < 1e12 ? raw * 1000 : raw;
  const s = coerceString(raw).trim();
  if (/^\d{10}$/.test(s)) return Number(s) * 1000;
  if (/^\d{13}$/.test(s)) return Number(s);
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}
