/**
 * Word error rate for speech-to-text checks: the accuracy harness
 * (scripts/voice/stt-accuracy.mts), the setup self-test and the release gate
 * all score transcripts with this, so "it transcribed something" can never
 * pass as "it transcribed the right words".
 *
 * Both sides are normalised first (case, punctuation, common abbreviations,
 * small numbers) so Whisper writing "Mr. Smith has 3 cats." scores 0 against
 * a reference of "MISTER SMITH HAS THREE CATS".
 */

const ABBREVIATIONS: Record<string, string> = {
  mr: "mister",
  mrs: "missus",
  ms: "miss",
  dr: "doctor",
  st: "saint",
  vs: "versus",
  ok: "okay",
};

const ONES = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** 0..999 999 → English words ("21" → "twenty one"). Larger numbers stay digits. */
export function numberToWords(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n >= 1_000_000) return String(n);
  if (n < 20) return ONES[n]!;
  if (n < 100) return `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ""}`;
  if (n < 1000)
    return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${numberToWords(n % 100)}` : ""}`;
  return `${numberToWords(Math.floor(n / 1000))} thousand${n % 1000 ? ` ${numberToWords(n % 1000)}` : ""}`;
}

/** Lower-case words with punctuation, abbreviations and small numbers normalised. */
export function normalizeTranscript(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/(\d),(\d{3})/g, "$1$2")
    .replace(/[-–—/]/g, " ")
    .replace(/[^a-z0-9' ]+/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter(Boolean);
  const out: string[] = [];
  for (const w of words) {
    if (/^\d+$/.test(w)) out.push(...numberToWords(Number(w)).split(" "));
    else out.push(ABBREVIATIONS[w] ?? w);
  }
  return out;
}

export interface WerResult {
  /** errors / reference words (can exceed 1 when the transcript adds words). */
  wer: number;
  errors: number;
  refWords: number;
  hypWords: number;
}

/** Levenshtein distance over normalised words, divided by the reference length. */
export function wordErrorRate(reference: string, hypothesis: string): WerResult {
  const r = normalizeTranscript(reference);
  const h = normalizeTranscript(hypothesis);
  let prev = Array.from({ length: h.length + 1 }, (_, j) => j);
  for (let i = 1; i <= r.length; i++) {
    const cur = [i];
    for (let j = 1; j <= h.length; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (r[i - 1] === h[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  const errors = prev[h.length]!;
  return {
    wer: r.length ? errors / r.length : h.length ? 1 : 0,
    errors,
    refWords: r.length,
    hypWords: h.length,
  };
}

/** Corpus WER: total errors over total reference words (not a mean of clip WERs). */
export function corpusWer(results: readonly WerResult[]): number {
  const words = results.reduce((n, r) => n + r.refWords, 0);
  const errors = results.reduce((n, r) => n + r.errors, 0);
  return words ? errors / words : 0;
}
