/**
 * Secure research query sanitizer.
 *
 * Every query that leaves the machine in Secure Mode passes through here. The
 * deterministic rules below always run; a local-model review (see
 * service.ts) can add more terms to strip but can never re-add anything the
 * rules removed. The goal is a short, generic search phrase such as
 * "1924 German External Loan bond value": what the item IS, never whose it
 * is, where it is, or which exact piece it is.
 *
 * Stripped: emails, URLs, phone numbers, IBAN / card / account numbers,
 * serial and certificate numbers (any token mixing letters and digits, any
 * run of 5+ digits, "No. 123"-style references), full dates, street
 * addresses, file names and paths, exact non-round money amounts, honorific
 * + name pairs, common first-name + surname pairs, and every owner- or
 * vault-supplied sensitive term (secure-graph people/clients, OCR entities of
 * the files in play, secureMode.research.sensitiveTerms).
 *
 * Kept: years (1000–2099), round denominations ("1000 Reichsmark",
 * "$100 bond"), percentages ("7%"), and descriptive words.
 */

export type RemovedKind =
  | "email"
  | "url"
  | "phone"
  | "iban"
  | "card"
  | "account"
  | "serial"
  | "date"
  | "address"
  | "file"
  | "amount"
  | "name"
  | "sensitive"
  | "model";

export type RemovedItem = { kind: RemovedKind; text: string };

export type SanitizeContext = {
  /** Terms that must never leave (vault entities, OCR entities, owner list). */
  sensitiveTerms?: readonly string[];
};

export type SanitizedQuery = {
  /** What the caller proposed. Stays on this machine. */
  original: string;
  /** What would be sent. Empty when nothing generic was left. */
  query: string;
  removed: RemovedItem[];
  /** False when the result is too thin to search or still looks identifying. */
  ok: boolean;
  /** Why ok is false (plain sentence). */
  reason?: string;
};

export const MAX_QUERY_CHARS = 120;
const MIN_MEANINGFUL_WORDS = 2;

// ── patterns ────────────────────────────────────────────────────────────────

const EMAIL = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g;
const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;
const IBAN = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,3})?\b/g;
const CARD = /\b(?:\d[ -]?){13,19}\b/g;
const PHONE = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{2,4}[\s.-]\d{3,4}[\s.-]?\d{2,4}\b/g;
const FULL_DATE =
  /\b(?:\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{4}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})\b/gi;
const PATH_RE = /(?:~|\.{1,2})?\/[\w.@%+-]+(?:\/[\w.@%+-]+)+\/?|\b[A-Za-z]:\\[^\s]+/g;
const FILE_RE =
  /\b[\w.@%+-]+\.(?:pdf|png|jpe?g|heic|heif|webp|gif|tiff?|bmp|docx?|xlsx?|pptx?|csv|txt|md|json|zip|mp4|mov|m4a|mp3|wav|ibsec)\b/gi;
const STREET =
  /\b\d{1,5}[a-z]?\s+(?:[A-Z][\w'-]*\s+){0,3}(?:street|st\.?|avenue|ave\.?|road|rd\.?|boulevard|blvd\.?|lane|ln\.?|drive|dr\.?|court|ct\.?|way|place|pl\.?|terrace|square|sq\.?)(?=\s|,|$)/gi;
const STREET_DE =
  /\b[A-ZÄÖÜ][\wäöüß-]*(?:stra(?:ss|ß)e|str\.|weg|gasse|platz|allee|ring|damm)\s+\d{1,4}[a-z]?\b/gi;
const POSTAL_UK = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/g;
/** "No. 12345", "#A1070", "serial 99", "cert. 12", "acct 1234", "ref: X9" */
const REF_NUMBER =
  /(?:\bno\b\.?|#|\bnr\b\.?|\bnumber\b|\bserial\b(?:\s+no\b\.?)?|\bs\/n\b|\bcert(?:ificate)?\b\.?(?:\s+no\b\.?)?|\bacc(?:oun)?t\b\.?(?:\s+no\b\.?)?|\bref(?:erence)?\b\.?|\bpolicy\b|\binvoice\b|\blot\b)\s*[:#]?\s*[A-Z]{0,4}[- ]?\d[\w-]*/gi;
/** Tokens mixing letters and digits (serials, account ids, certificate ids). */
const ALNUM_MIX = /\b(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*\b/g;
/** Money with a symbol or code: $12,437.50 · €3.000 · 1,250 USD · USD 980 */
const MONEY_SYMBOL =
  /[$€£¥₹]\s?\d[\d.,]*(?:\s?(?:k|m|million|thousand))?|\b\d[\d.,]*\s?(?:usd|eur|gbp|chf|jpy|dollars?|euros?)\b|\b(?:usd|eur|gbp|chf|jpy)\s?\d[\d.,]*/gi;
const LONG_DIGITS = /\b\d[\d,.]{3,}\d\b/g;
const NAME_WORD = String.raw`\p{Lu}[\p{L}'-]+`;
const HONORIFIC_NAME = new RegExp(
  String.raw`(?<![\p{L}])(?:mr|mrs|ms|miss|dr|prof|herr|frau|sir|madam|mme|mlle)\.?\s+${NAME_WORD}(?:\s+${NAME_WORD}){0,2}`,
  "gu",
);
/** "owned by X Y", "belongs to X", "payable to X", "holder X", "my grandfather Hans" */
const OWNER_PHRASE = new RegExp(
  String.raw`(?<![\p{L}])(?:owned by|belong(?:s|ing)? to|payable to|issued to|registered to|holder|bearer|my|our|his|her|their)\s+(?:(?:late|grand\p{L}*|father|mother|uncle|aunt|wife|husband|son|daughter|brother|sister|cousin|friend|client)\s+)*${NAME_WORD}(?:\s+${NAME_WORD}){0,2}`,
  "gu",
);
/** German/US-style 5-digit postcode followed by a place name: "10115 Berlin". */
const POSTCODE_PLACE = new RegExp(String.raw`\b\d{5}\s+${NAME_WORD}`, "gu");

/** A small list of common first names: "Hans Müller" style pairs are names. */
const FIRST_NAMES = new Set(
  (
    "james john robert michael william david richard joseph thomas charles christopher daniel matthew anthony mark " +
    "donald steven paul andrew joshua kenneth kevin brian george timothy ronald edward jason jeffrey ryan jacob gary " +
    "nicholas eric jonathan stephen larry justin scott brandon benjamin samuel gregory alexander frank patrick raymond " +
    "jack dennis jerry tyler aaron jose adam nathan henry douglas zachary peter kyle walter ethan jeremy harold keith " +
    "christian roger noah gerald carl terry sean austin arthur lawrence jesse dylan bryan joe jordan billy bruce albert " +
    "willie gabriel logan alan juan wayne roy ralph randy eugene vincent russell elijah louis bobby philip johnny " +
    "mary patricia jennifer linda elizabeth barbara susan jessica sarah karen lisa nancy betty margaret sandra ashley " +
    "kimberly emily donna michelle carol amanda dorothy melissa deborah stephanie rebecca sharon laura cynthia kathleen " +
    "amy angela shirley anna brenda pamela emma nicole helen samantha katherine christine debra rachel carolyn janet " +
    "catherine maria heather diane ruth julie olivia joyce virginia victoria kelly lauren christina joan evelyn judith " +
    "megan andrea cheryl hannah jacqueline martha gloria teresa ann sara madison frances kathryn janice jean abigail " +
    "alice judy sophia grace denise amber doris marilyn danielle beverly isabella theresa diana natalie brittany " +
    "charlotte marie kayla alexis lori hans fritz klaus jurgen jürgen dieter wolfgang helmut gunter günter heinz karl " +
    "otto friedrich wilhelm ernst gerhard horst manfred werner uwe rainer ulrich ursula ingrid helga gisela renate " +
    "monika sabine petra brigitte erika hildegard pierre jean jacques michel philippe alain marco giuseppe giovanni " +
    "francesco antonio luca carlos luis miguel pedro jorge javier ahmed mohammed muhammad ali omar ivan sergei dmitri " +
    "olga natasha wei li yan chen hiroshi yuki kenji raj priya amit anil sunil"
  ).split(/\s+/),
);

/** Words that look like names after a first name but are collectible vocabulary. */
const GENERIC_WORDS = new Set(
  (
    "bond bonds banknote banknotes note notes coin coins loan loans gold silver bank reich reichsbank reichsmark mark marks " +
    "dollar dollars pound pounds franc francs lire lira rouble ruble yen certificate share shares stock scrip coupon " +
    "series issue edition value price prices market auction estimate catalog catalogue grade graded uncirculated " +
    "external internal government treasury republic empire kingdom state city railway company dawes young war " +
    "german germany french france british england american united states russian russia japanese japan chinese china " +
    "austrian austria italian italy imperial weimar"
  ).split(/\s+/),
);

/** 1, 2, 5, 10, 20, 25, 50, 100, 250, 500, 1000, 5000, 10000… */
function isRoundDenomination(digits: string): boolean {
  return /^(?:[125]0*|25|250|2500|25000)$/.test(digits);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Sensitive terms worth matching: at least 3 chars, not a pure stop/generic
 * word (a vault node called "Bond" must not strip "bond" from every query).
 */
export function normalizeSensitiveTerms(terms: readonly string[] | undefined): string[] {
  const out = new Set<string>();
  for (const raw of terms ?? []) {
    if (typeof raw !== "string") continue;
    const t = raw.replace(/\s+/g, " ").trim();
    if (t.length < 3 || t.length > 120) continue;
    const words = t.toLowerCase().split(" ");
    if (words.every((w) => GENERIC_WORDS.has(w) || /^\d{1,4}$/.test(w))) continue;
    out.add(t);
  }
  // Longest first so "Hans Müller" is removed before "Hans".
  return [...out].sort((a, b) => b.length - a.length);
}

type Rule = { kind: RemovedKind; re: RegExp; keep?: (m: string) => boolean };

function amountKeep(m: string): boolean {
  const digits = m.replace(/[^\d]/g, "");
  const hasDecimals = /\d[.,]\d{1,2}\b/.test(m) && !/\d[.,]\d{3}\b/.test(m);
  return !hasDecimals && isRoundDenomination(digits);
}

/** "my German bond" names nobody: keep it when every capitalised word is vocabulary. */
function ownerPhraseKeep(m: string): boolean {
  const caps = m.match(new RegExp(NAME_WORD, "gu")) ?? [];
  return caps.length > 0 && caps.every((w) => GENERIC_WORDS.has(w.toLowerCase()));
}

function longDigitsKeep(m: string): boolean {
  const digits = m.replace(/[^\d]/g, "");
  // "10,000 mark" is a denomination, "12,437" is not.
  return isRoundDenomination(digits);
}

const RULES: Rule[] = [
  { kind: "email", re: EMAIL },
  { kind: "url", re: URL_RE },
  { kind: "date", re: FULL_DATE },
  { kind: "file", re: PATH_RE },
  { kind: "file", re: FILE_RE },
  { kind: "iban", re: IBAN },
  { kind: "card", re: CARD, keep: (m) => m.replace(/\D/g, "").length < 13 },
  { kind: "phone", re: PHONE },
  { kind: "address", re: STREET },
  { kind: "address", re: STREET_DE },
  { kind: "address", re: POSTAL_UK },
  {
    kind: "address",
    re: POSTCODE_PLACE,
    keep: (m) => GENERIC_WORDS.has(m.split(/\s+/)[1]?.toLowerCase() ?? ""),
  },
  { kind: "serial", re: REF_NUMBER },
  { kind: "amount", re: MONEY_SYMBOL, keep: amountKeep },
  { kind: "name", re: HONORIFIC_NAME },
  { kind: "name", re: OWNER_PHRASE, keep: ownerPhraseKeep },
  {
    kind: "serial",
    re: ALNUM_MIX,
    // "7%" isn't matched; keep ordinals ("2nd"), decades ("1920s") and size-like units ("100mm").
    keep: (m) => /^\d+(?:st|nd|rd|th|s)$/i.test(m) || /^\d{1,4}(?:mm|cm|g|kg|oz|k)$/i.test(m),
  },
  { kind: "account", re: LONG_DIGITS, keep: longDigitsKeep },
];

function applyRule(text: string, rule: Rule, removed: RemovedItem[]): string {
  rule.re.lastIndex = 0;
  return text.replace(rule.re, (m) => {
    if (rule.keep?.(m)) return m;
    removed.push({ kind: rule.kind, text: m.trim() });
    return " ";
  });
}

function stripFirstNamePairs(text: string, removed: RemovedItem[]): string {
  const pair = new RegExp(String.raw`(?<![\p{L}])(${NAME_WORD})\s+(${NAME_WORD})(?![\p{L}])`, "gu");
  return text.replace(pair, (m, first: string, last: string) => {
    if (!FIRST_NAMES.has(first.toLowerCase())) return m;
    if (GENERIC_WORDS.has(last.toLowerCase())) return m;
    removed.push({ kind: "name", text: m });
    return " ";
  });
}

function stripTerms(
  text: string,
  terms: readonly string[],
  kind: RemovedKind,
  removed: RemovedItem[],
): string {
  let out = text;
  for (const term of terms) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(term)}(?![\\p{L}\\p{N}])`, "giu");
    out = out.replace(re, (m) => {
      removed.push({ kind, text: m });
      return " ";
    });
  }
  return out;
}

// Intentional: fetched web text is scrubbed of control characters before it is shown.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

function tidy(text: string): string {
  return text
    .replace(CONTROL_CHARS, " ")
    .replace(/["“”«»`]/g, " ")
    .replace(/\(\s*\)|\[\s*\]/g, " ")
    .replace(/\s+([,;:|.])/g, "$1")
    .replace(/([,;:|])(?:\s*[,;:|])+/g, "$1")
    .replace(/(^|\s)[,;:|.]+(?=\s|$)/g, " ")
    .replace(/[,;:|]+\s*$/g, "")
    .replace(/(?:[\s,]+(?:from|on|of|for|by|to|with|at|and|or|in|paid|call))+[\s,.]*$/gi, "")
    .replace(/^[\s,;:|.-]+|[\s,;:|-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP = new Set([
  "the",
  "a",
  "an",
  "of",
  "and",
  "or",
  "for",
  "in",
  "on",
  "to",
  "with",
  "my",
  "our",
  "by",
  "at",
]);

function meaningfulWords(q: string): number {
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w)).length;
}

/** Deterministic pass. Pure, synchronous, no I/O. */
export function sanitizeQuery(input: string, ctx: SanitizeContext = {}): SanitizedQuery {
  const original = typeof input === "string" ? input : "";
  const removed: RemovedItem[] = [];
  let text = original.normalize("NFKC");
  // Owner / vault terms first: they are the most specific.
  text = stripTerms(text, normalizeSensitiveTerms(ctx.sensitiveTerms), "sensitive", removed);
  for (const rule of RULES) text = applyRule(text, rule, removed);
  text = stripFirstNamePairs(text, removed);
  let query = tidy(text);
  if (query.length > MAX_QUERY_CHARS) {
    query = query
      .slice(0, MAX_QUERY_CHARS)
      .replace(/\s+\S*$/, "")
      .trim();
  }
  if (!query || meaningfulWords(query) < MIN_MEANINGFUL_WORDS) {
    return {
      original,
      query: "",
      removed,
      ok: false,
      reason: "Nothing generic is left to search for after removing personal details.",
    };
  }
  // Second pass: the cleaned query must be a fixed point of the rules.
  const recheck = findSensitive(query, ctx);
  if (recheck.length) {
    return {
      original,
      query: "",
      removed: [...removed, ...recheck],
      ok: false,
      reason: `Still looks identifying: ${recheck.map((r) => r.kind).join(", ")}.`,
    };
  }
  return { original, query, removed, ok: true };
}

/** What in `text` the rules would strip (empty = clean). */
export function findSensitive(text: string, ctx: SanitizeContext = {}): RemovedItem[] {
  const found: RemovedItem[] = [];
  let t = stripTerms(text, normalizeSensitiveTerms(ctx.sensitiveTerms), "sensitive", found);
  for (const rule of RULES) t = applyRule(t, rule, found);
  stripFirstNamePairs(t, found);
  return found;
}

/**
 * Apply terms a local model flagged (names, places, ids the rules missed).
 * The model can only remove words, never add them.
 */
export function applyModelFlags(
  s: SanitizedQuery,
  flagged: readonly string[],
  ctx: SanitizeContext = {},
): SanitizedQuery {
  const terms = normalizeSensitiveTerms(
    flagged.filter(
      (f) => typeof f === "string" && s.query.toLowerCase().includes(f.toLowerCase().trim()),
    ),
  );
  if (!terms.length || !s.ok) return s;
  const removed: RemovedItem[] = [];
  const stripped = tidy(stripTerms(s.query, terms, "model", removed));
  const again = sanitizeQuery(stripped, ctx);
  return {
    original: s.original,
    query: again.query,
    removed: [...s.removed, ...removed, ...again.removed],
    ok: again.ok,
    ...(again.ok ? {} : { reason: again.reason }),
  };
}

/** Sanitize, drop empties and duplicates (case-insensitive), cap the count. */
export function sanitizeBatch(
  queries: readonly string[],
  ctx: SanitizeContext = {},
  max = 8,
): { accepted: SanitizedQuery[]; rejected: SanitizedQuery[] } {
  const accepted: SanitizedQuery[] = [];
  const rejected: SanitizedQuery[] = [];
  const seen = new Set<string>();
  for (const q of queries) {
    const s = sanitizeQuery(q, ctx);
    if (!s.ok) {
      rejected.push(s);
      continue;
    }
    const k = s.query.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    if (accepted.length < max) accepted.push(s);
  }
  return { accepted, rejected };
}
