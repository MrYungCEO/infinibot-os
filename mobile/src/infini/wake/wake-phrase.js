/**
 * wake-phrase — "Hey Infini" matching (pure, no RN).
 *
 * Same idea as the web wake word (ui/src/ui/controllers/wake-word.ts):
 * token-boundary matching after a small alias table for the recogniser's
 * favourite mistranscriptions of "infini" (it isn't a dictionary word).
 *
 * The phone's Whisper clips are short, so the brand word is often split or
 * misspelt. Real transcripts from the gateway's /api/voice/stt of a spoken
 * "Hey Infini" (fixtures in __tests__/fixtures/wake-transcripts.json) include
 * "Hey and Finny.", "He and Finney, …", "Hey, infinity.", "Harry Infini" and,
 * from a browser recording, "Hayden Finney".
 * So on top of the exact / alias match there is a FUZZY match: the start of
 * the utterance is compared with each phrase on a rough phonetic key
 * (ey/ee/y → i, ph → f, doubled letters collapsed) by edit distance, and a
 * split brand ("and finny" → "infinny") is re-joined first. How close is
 * close enough is the sensitivity's `strictness` (0..1).
 *
 * Guards, because clips catch TV and other people:
 *   - the phrase must open the utterance (after at most one filler such as
 *     "ok" / "um", or right after a sentence break), so "…watched hey
 *     Infinity War" mid-sentence does not fire;
 *   - when the phrase was only heard approximately (an alias such as
 *     "infinity", or a fuzzy match), it must end the clip, be followed by a
 *     pause (comma / full stop), or be followed by something that starts a
 *     request ("what", "can", "add"…) — so "Hey Infinity War was great" does
 *     not fire but "Hey Infinity, what's on my board?" does.
 *
 * Custom phrases (Call options › Listening) go through the same matcher;
 * validateWakePhrase() keeps them to 2–5 words and warns about phrases made
 * of everyday words.
 */

export const DEFAULT_WAKE_PHRASES = ['hey infini', 'hey infinibot', 'okay infini'];

/** Sensitivity presets: VAD threshold (mic level 0..1) + match strictness. */
export const WAKE_SENSITIVITY = {
  low: { key: 'low', label: 'Low', threshold: 0.38, margin: 0.18, strictness: 0.86, hint: 'Fewer false wakes. Speak clearly, close to the phone.' },
  normal: { key: 'normal', label: 'Normal', threshold: 0.3, margin: 0.14, strictness: 0.75, hint: 'Balanced for a quiet room at arm’s length.' },
  high: { key: 'high', label: 'High', threshold: 0.22, margin: 0.1, strictness: 0.72, hint: 'Wakes on quieter or farther speech and looser matches. More false wakes.' },
};
export const SENSITIVITY_ORDER = ['low', 'normal', 'high'];

export function sensitivityConfig(level) {
  return WAKE_SENSITIVITY[level] || WAKE_SENSITIVITY.normal;
}

export const TOKEN_ALIAS = {
  // From the web matcher.
  infinity: 'infini',
  infinite: 'infini',
  infiniti: 'infini',
  infinitybot: 'infinibot',
  infinitybought: 'infinibot',
  infinityboard: 'infinibot',
  infiniboard: 'infinibot',
  infinibought: 'infinibot',
  hi: 'hey',
  hay: 'hey',
  // Phone extras (Whisper on short clips).
  infiny: 'infini',
  infinni: 'infini',
  infinny: 'infini',
  infinney: 'infini',
  infinie: 'infini',
  infinit: 'infini',
  infinities: 'infini',
  heyinfini: 'hey infini',
  heyinfinity: 'hey infini',
  hei: 'hey',
  heh: 'hey',
  eh: 'hey',
  ey: 'hey',
  okay: 'okay',
  ok: 'okay',
};

// Tokens that may stand for "hey" only when the brand follows ("a infini").
const SOFT_HEY = new Set(['a', 'ay', 'aye', 'ah', 'yo', 'he']);
const FILLERS = new Set(['ok', 'okay', 'um', 'uh', 'so', 'oh', 'well', 'yo', 'and', 'alright']);
const BRAND = new Set(['infini', 'infinibot']);
export const COMMAND_START = new Set([
  'what', 'whats', "what's", 'how', 'hows', 'can', 'could', 'would', 'will', 'please', 'tell', 'show', 'open', 'start', 'stop',
  'add', 'create', 'make', 'remind', 'set', 'call', 'take', 'note', 'is', 'are', 'do', 'did', 'does', 'who', 'when', 'where',
  'why', 'lets', "let's", 'i', 'im', "i'm", 'give', 'send', 'read', 'check', 'find', 'search', 'play', 'run', 'save', 'log',
  'you', 'hello', 'hi', 'hey', 'help', 'listen', 'get', 'list', 'turn', 'new',
]);
const GENERIC_NAMES = new Set(['main', 'default', 'agent', 'assistant', 'session', 'bot', 'the', 'a', 'cli', 'local']);
const GREETINGS = new Set(['hey', 'hi', 'hello', 'ok', 'okay', 'yo', 'hiya', 'oi']);

// Everyday words: a custom phrase made only of these fires on normal talk.
const COMMON_WORDS = new Set(
  (
    'the be to of and a in that have i it for not on with he as you do at this but his by from they we say her she or an will my one all would there their what so up out if about who get which go me when make can like time no just him know take people into year your good some could them see other than then now look only come its over think also back after use two how our work first well way even new want because any these give day most us is are was were been am has had did does done said going got thing things okay ok yes yeah no nope sure right please thanks thank hello hi hey there here man guys everyone everybody computer phone stop start wait listen'
  ).split(/\s+/),
);

/** Lowercase, strip punctuation, collapse spaces. */
export function normalizePhrase(p) {
  return String(p || '')
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[^\p{L}\p{N}'\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Re-join a brand word Whisper split in two: "and finny" / "an finney" /
 * "in fini" → "infinny" …, so "Hey and Finny." reads "hey infini".
 */
const SPLIT_BRAND = 'f+(?:i|e|ee|y)n+(?:y|ey|ie|i|ee)';
function rejoinBrand(text) {
  return (
    String(text || '')
      // "Hayden Finney" / "Hen Finny": the "hey" swallowed the "in".
      .replace(new RegExp(`\\b(h[a-z]{0,3}?)(?:den|and|an|en|in|n)\\s+(${SPLIT_BRAND})\\b`, 'gi'), (_, _h, f) => `hey in${f.toLowerCase()}`)
      // "and Finny" / "an Finney" / "in fini" → "infinny".
      .replace(new RegExp(`\\b(?:and|an|in|en|un|n)\\s+(${SPLIT_BRAND})\\b`, 'gi'), (_, f) => `in${f.toLowerCase()}`)
  );
}

/**
 * Tokenise keeping sentence breaks: [{ tok, raw, brk, alias }] where `brk` is
 * true when a comma / full stop / ? / ! follows the token and `alias` when the
 * token was rewritten by the alias table.
 */
export function wakeTokens(text) {
  const out = [];
  const parts =
    rejoinBrand(String(text || ''))
      .toLowerCase()
      .replace(/[’`]/g, "'")
      .match(/[\p{L}\p{N}']+|[.,!?;:…-]/gu) || [];
  for (const p of parts) {
    if (/^[.,!?;:…-]$/.test(p)) {
      if (out.length) out[out.length - 1].brk = true;
      continue;
    }
    const raw = p.replace(/^'+|'+$/g, '');
    if (!raw) continue;
    const mapped = TOKEN_ALIAS[raw] ?? raw;
    for (const piece of mapped.split(' ')) out.push({ tok: piece, raw, brk: false, alias: mapped !== raw });
  }
  return out.filter((t) => t.tok);
}

/** A rough phonetic key: "hey and finny" ≈ "hey infini" ≈ "hinfini". */
export function phoneticKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z]/g, '')
    .replace(/ph/g, 'f')
    .replace(/ck/g, 'k')
    .replace(/ey/g, 'i')
    .replace(/ee|ea|ie/g, 'i')
    .replace(/y/g, 'i')
    .replace(/(.)\1+/g, '$1');
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** 0..1 similarity of two phonetic keys. */
export function phoneticSimilarity(a, b) {
  const x = phoneticKey(a);
  const y = phoneticKey(b);
  if (!x || !y) return 0;
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}

/**
 * The effective phrase list.
 * @param {string} targetTitle  the selected agent's name ("hey <name>" when allowed)
 * @param {string[] | {phrases?: string[], agentName?: boolean}} [opts]
 *   an array is treated as extra phrases on top of the defaults (old signature)
 */
export function wakePhrasesFor(targetTitle, opts = {}) {
  const o = Array.isArray(opts) ? { phrases: [...DEFAULT_WAKE_PHRASES, ...opts], agentName: true } : opts || {};
  const base = Array.isArray(o.phrases) && o.phrases.length ? o.phrases : DEFAULT_WAKE_PHRASES;
  const set = new Set(base.map(normalizePhrase).filter(Boolean));
  if (o.agentName !== false) {
    const name = String(targetTitle || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
    if (name && name.split(' ').length <= 2 && name.length >= 3 && !GENERIC_NAMES.has(name)) set.add(`hey ${name}`);
  }
  return [...set];
}

/**
 * Check a phrase the owner typed.
 * @returns {{ ok: boolean, phrase: string, error?: string, warning?: string }}
 */
export function validateWakePhrase(input, existing = []) {
  const phrase = normalizePhrase(input);
  if (!phrase) return { ok: false, phrase, error: 'Type a phrase first.' };
  const words = phrase.split(' ');
  if (words.length < 2) return { ok: false, phrase, error: 'Use at least 2 words, like “hey nova”.' };
  if (words.length > 5) return { ok: false, phrase, error: 'Keep it to 5 words or fewer.' };
  if (existing.map(normalizePhrase).includes(phrase)) return { ok: false, phrase, error: 'That phrase is already in the list.' };
  if (phrase.replace(/[^\p{L}\p{N}]/gu, '').length < 6) return { ok: false, phrase, error: 'Too short to recognise reliably. Use a longer phrase.' };
  const content = words.filter((w) => !GREETINGS.has(w));
  if (!content.length) return { ok: false, phrase, error: 'Add a name after the greeting, like “hey nova”.' };
  if (content.every((w) => COMMON_WORDS.has(w)))
    return { ok: true, phrase, warning: 'Everyday words like these come up in normal conversation and could wake InfiniBot by accident. A name works better.' };
  return { ok: true, phrase };
}

function matchExact(toks, start, want) {
  let i = start;
  let aliased = false;
  for (let j = 0; j < want.length; j++, i++) {
    const t = toks[i];
    if (!t) return null;
    const soft = j === 0 && want[0] === 'hey' && SOFT_HEY.has(t.tok) && toks[i + 1] && BRAND.has(toks[i + 1].tok);
    if (t.tok !== want[j] && !soft) return null;
    if (soft || (t.alias && BRAND.has(t.tok))) aliased = true;
  }
  return { end: i, aliased };
}

/** Best fuzzy window of the transcript at `start` against one phrase. */
function matchFuzzy(toks, start, want, key) {
  let best = null;
  const n = want.length;
  for (let k = Math.max(1, n - 1); k <= n + 1; k++) {
    if (start + k > toks.length) break;
    const window = toks.slice(start, start + k);
    // A sentence break inside the window means the phrase isn't one unit.
    if (window.slice(0, -1).some((t, idx) => t.brk && !(idx === 0 && want[0] === 'hey'))) continue;
    const score = phoneticSimilarity(window.map((t) => t.tok).join(''), key);
    if (!best || score > best.score + 1e-9) best = { end: start + k, score };
  }
  return best;
}

/**
 * Match a transcript against the wake phrases and say why (for the on-screen
 * diagnostics).
 * @returns {{ match: null | {phrase, remainder, at, score, how}, reason: string, best: null | {phrase, score} }}
 */
export function explainWake(transcript, phrases = DEFAULT_WAKE_PHRASES, { strictness = WAKE_SENSITIVITY.normal.strictness } = {}) {
  const text = String(transcript || '').trim();
  if (!text) return { match: null, reason: 'Nothing was transcribed', best: null };
  if (/^(?:you|thank you\.?|thanks for watching!?|\.+|bye\.?|uh+|um+|hmm+)$/i.test(text)) return { match: null, reason: 'Whisper heard only noise', best: null };
  const toks = wakeTokens(text);
  if (!toks.length) return { match: null, reason: 'No words in the transcript', best: null };
  const list = (phrases || [])
    .map((p) => {
      const want = wakeTokens(p).map((t) => t.tok);
      return { phrase: normalizePhrase(p), want, key: phoneticKey(want.join('')) };
    })
    .filter((p) => p.want.length)
    .sort((a, b) => b.want.length - a.want.length);
  if (!list.length) return { match: null, reason: 'No wake phrases configured', best: null };

  // Allowed start positions: 0, 1 after a filler, or right after a sentence break.
  const starts = new Set([0]);
  if (toks.length > 1 && FILLERS.has(toks[0].raw)) starts.add(1);
  toks.forEach((t, i) => {
    if (t.brk && i + 1 < toks.length) starts.add(i + 1);
  });

  let best = null;
  let guarded = null;
  const remainderFrom = (i) =>
    toks
      .slice(i)
      .map((t) => t.raw)
      .join(' ')
      .trim();
  // An approximate hit must end the thought or start a request.
  const passesGuard = (end) => {
    const last = toks[end - 1];
    const next = toks[end];
    return !next || last.brk || COMMAND_START.has(next.raw);
  };

  for (const start of [...starts].sort((a, b) => a - b)) {
    // 1) exact (after aliases)
    for (const { phrase, want } of list) {
      const ex = matchExact(toks, start, want);
      if (!ex) continue;
      if (ex.aliased && !passesGuard(ex.end)) {
        guarded = guarded || { phrase, next: toks[ex.end]?.raw, start };
        continue;
      }
      return {
        match: { phrase, remainder: remainderFrom(ex.end), at: start, score: 1, how: ex.aliased ? 'alias' : 'exact' },
        reason: `Matched “${phrase}”${ex.aliased ? ' (via a known mishearing)' : ''}`,
        best: { phrase, score: 1 },
      };
    }
    // 2) fuzzy — unless the brand was clearly heard here and rejected by the guard
    if (guarded && guarded.start === start) continue;
    let cand = null;
    for (const { phrase, want, key } of list) {
      const fz = matchFuzzy(toks, start, want, key);
      if (!fz) continue;
      if (!best || fz.score > best.score) best = { phrase, score: fz.score };
      if (fz.score < strictness) continue;
      if (!passesGuard(fz.end)) {
        guarded = guarded || { phrase, next: toks[fz.end]?.raw };
        continue;
      }
      if (!cand || fz.score > cand.score) cand = { phrase, end: fz.end, score: fz.score };
    }
    if (cand) {
      return {
        match: { phrase: cand.phrase, remainder: remainderFrom(cand.end), at: start, score: cand.score, how: 'fuzzy' },
        reason: `Sounds like “${cand.phrase}” (${Math.round(cand.score * 100)}% ≥ ${Math.round(strictness * 100)}%)`,
        best: { phrase: cand.phrase, score: cand.score },
      };
    }
  }
  if (guarded) return { match: null, reason: `Sounded like “${guarded.phrase}” but “${guarded.next}” followed, so it was not a wake`, best };
  if (best) return { match: null, reason: `Closest: “${best.phrase}” ${Math.round(best.score * 100)}% < ${Math.round(strictness * 100)}% needed`, best };
  return { match: null, reason: 'No wake phrase at the start', best: null };
}

/**
 * Match a transcript against the wake phrases.
 * @returns {null | {phrase: string, remainder: string, at: number, score: number, how: string}}
 *   `remainder` is what was said after the phrase ("what's on my board?").
 */
export function matchWake(transcript, phrases = DEFAULT_WAKE_PHRASES, opts) {
  return explainWake(transcript, phrases, opts).match;
}
