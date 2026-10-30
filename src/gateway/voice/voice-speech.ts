/**
 * Voice speech shaper — turns what an agent WRITES into what a caller should
 * HEAR, as a stream.
 *
 * One voice turn can produce several assistant messages: a line before a tool
 * call, another after it, a final payload that repeats the streamed text, tool
 * status, markdown lists, links, JSON a model printed instead of calling a
 * tool. TTS reads all of it literally. The shaper sits between the agent's
 * deltas and the voice provider and guarantees:
 *
 *   - in order, once:   a sentence already spoken in this turn is never spoken
 *                       again (final payload echo, repeated opening, the ack
 *                       echoed by the agent);
 *   - no cut words:     text is released at word boundaries only, and
 *                       separate messages are joined with a space;
 *   - speakable:        markdown, code fences, JSON / tool payload lines,
 *                       links and emoji are removed before TTS;
 *   - short:            past `maxChars` the turn stops at a sentence end and
 *                       says the rest is in the chat (the full text is kept
 *                       in `fullText` for the transcript).
 *
 * The FIRST message streams with no extra latency (released at each word
 * boundary). Later messages are released a sentence at a time, because that
 * is the unit the duplicate check needs.
 */

export const DEFAULT_MAX_SPOKEN_CHARS = 520;
export const OVERFLOW_NOTE = "The full details are in the chat.";

const SENTENCE_RE = /[^.!?…。！？]+(?:[.!?…。！？]+["')\]]*|$)/g;

export function normalizeSentence(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}' ]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function splitSentences(text: string): string[] {
  return (text.match(SENTENCE_RE) ?? []).map((s) => s.trim()).filter(Boolean);
}

/** A whole line that is machine output, not speech. */
function isPayloadLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (/^[{[]/.test(t) && /["{}[\]:]/.test(t.slice(1))) return true;
  if (/^<\/?(?:tool|function|invoke|parameter|antml)/i.test(t)) return true;
  if (/\b(?:tool_call|function_call|toolCallId|tool_use_id)\b/.test(t)) return true;
  if (/^(?:functions|tool)\.[a-z_]+\s*\(/i.test(t)) return true;
  if (/^\|.*\|$/.test(t)) return true; // markdown table row
  return false;
}

/** Inline cleanup of complete words (no line-level decisions here). */
export function cleanInline(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, "$1")
    .replace(/<?https?:\/\/[^\s>)]+>?/g, "the link")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*|__|~~|`/g, "")
    .replace(/(^|\s)\*(\S[^*]*?)\*(?=\s|[.,!?]|$)/g, "$1$2")
    .replace(/\p{Extended_Pictographic}️?/gu, "")
    .replace(/[ \t]{2,}/g, " ");
}

/** Line-start markup: headings, bullets, numbered items, quotes. */
function cleanLineStart(line: string): string {
  return line.replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*•+]\s+|\d{1,2}[.)]\s+)/, "");
}

export type SpeechShaperOptions = {
  emit: (text: string) => void;
  maxChars?: number;
  overflowNote?: string;
};

export class SpeechShaper {
  private readonly emitRaw: (text: string) => void;
  private readonly maxChars: number;
  private readonly overflowNote: string;
  /** Raw text of the current message not yet released. */
  private pending = "";
  private inFence = false;
  private messageIndex = 0;
  /** Cleaned text of the current (later) message held until a sentence ends. */
  private sentenceHold = "";
  private spoken = "";
  private full = "";
  private readonly spokenSentences = new Set<string>();
  private truncated = false;
  private overflowChars = 0;
  private ended = false;

  constructor(opts: SpeechShaperOptions) {
    this.emitRaw = opts.emit;
    this.maxChars = opts.maxChars ?? DEFAULT_MAX_SPOKEN_CHARS;
    this.overflowNote = opts.overflowNote ?? OVERFLOW_NOTE;
  }

  /** Everything speakable the agent wrote (for the transcript / chat). */
  get fullText(): string {
    return this.full.trim();
  }

  /** What was actually sent to TTS. */
  get spokenText(): string {
    return this.spoken;
  }

  get wasTruncated(): boolean {
    return this.truncated;
  }

  /** Anything spoken or about to be (used to decide whether an ack is still needed). */
  hasOutput(): boolean {
    return !!(this.spoken.trim() || this.pending.trim() || this.sentenceHold.trim());
  }

  /** Raw delta of the current assistant message. */
  push(delta: string): void {
    if (!delta || this.ended) return;
    this.pending += delta;
    this.drain(false);
  }

  /** A new assistant message starts (after a tool call, a final payload…). */
  boundary(): void {
    if (this.ended) return;
    this.drain(true);
    this.flushHold(true);
    if (this.spoken || this.full) this.messageIndex++;
  }

  /** Speak a whole message at once (an acknowledgement, a background result). */
  say(text: string): void {
    this.boundary();
    this.push(text);
    this.boundary();
  }

  /** End of the turn: release what is left, then the overflow note if text was cut. */
  end(): void {
    if (this.ended) return;
    this.drain(true);
    this.flushHold(true);
    this.ended = true;
    if (this.truncated && this.overflowChars >= 60) this.out(` ${this.overflowNote}`, true);
  }

  // ── internals ────────────────────────────────────────────────────────────────

  private drain(final: boolean): void {
    for (;;) {
      if (!this.pending) return;
      const nl = this.pending.indexOf("\n");
      if (nl >= 0) {
        const line = this.pending.slice(0, nl);
        this.pending = this.pending.slice(nl + 1);
        this.line(line, true);
        continue;
      }
      // Incomplete line. Fence markers and payload-looking lines wait for the newline.
      const head = this.pending.trimStart();
      if (this.inFence || /^(?:```|~~~|[{[<|])/.test(head)) {
        if (!final) return;
        const line = this.pending;
        this.pending = "";
        this.line(line, false);
        return;
      }
      if (final) {
        const line = this.pending;
        this.pending = "";
        this.line(line, false);
        return;
      }
      // Release up to the last whitespace so a word / link / **marker** is never split.
      const cut = Math.max(this.pending.lastIndexOf(" "), this.pending.lastIndexOf("\t"));
      if (cut <= 0) return;
      const part = this.pending.slice(0, cut + 1);
      this.pending = this.pending.slice(cut + 1);
      // Line-start markup only applies at the beginning of a line.
      this.text(this.lineStart ? cleanLineStart(part) : part, false);
      this.lineStart = false;
    }
  }

  private lineStart = true;

  private line(raw: string, newline: boolean): void {
    const fence = /^\s*(?:```|~~~)/.test(raw);
    if (fence) {
      this.inFence = !this.inFence;
      this.lineStart = true;
      return;
    }
    if (this.inFence || isPayloadLine(raw)) {
      this.lineStart = true;
      return;
    }
    let t = this.lineStart ? cleanLineStart(raw) : raw;
    if (newline && t.trim()) {
      // A line break is a pause: make it one TTS can hear.
      t = /[.!?…:;,]\s*$/.test(t) ? `${t.trimEnd()} ` : `${t.trimEnd()}. `;
    }
    this.text(t, newline);
    this.lineStart = newline;
  }

  private text(raw: string, _lineEnd: boolean): void {
    const t = cleanInline(raw);
    if (!t.trim() && !/\s$/.test(t)) return;
    this.full += t;
    if (this.messageIndex === 0) {
      this.release(t);
    } else {
      this.sentenceHold += t;
      this.flushHold(false);
    }
  }

  /** Later messages: release complete sentences that were not spoken yet. */
  private flushHold(final: boolean): void {
    if (!this.sentenceHold) return;
    const sentences = splitSentences(this.sentenceHold);
    if (!sentences.length) {
      if (final) this.sentenceHold = "";
      return;
    }
    const lastComplete = /[.!?…。！？]["')\]]*\s*$/.test(this.sentenceHold);
    const ready = final || lastComplete ? sentences : sentences.slice(0, -1);
    const rest = final || lastComplete ? "" : (sentences[sentences.length - 1] ?? "");
    for (const s of ready) {
      const key = normalizeSentence(s);
      if (!key || this.spokenSentences.has(key)) continue;
      const lead = this.spoken && !/\s$/.test(this.spoken) ? " " : "";
      this.release(`${lead}${s}`);
    }
    this.sentenceHold = rest ? `${rest} `.replace(/\s+$/, " ") : "";
  }

  private release(t: string): void {
    if (this.truncated) {
      this.overflowChars += t.trim().length;
      return;
    }
    // Separate messages arriving back to back: "…done.Next" → "…done. Next".
    let piece = t;
    if (this.spoken && !/\s$/.test(this.spoken) && /^[\p{Lu}"“]/u.test(piece)) piece = ` ${piece}`;
    // Budget: past the limit, stop at the first sentence end.
    if (this.spoken.length + piece.length >= this.maxChars) {
      const over = Math.max(0, this.maxChars - this.spoken.length);
      const re = /[.!?…。！？]["')\]]*(?=\s|$)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(piece))) {
        const endAt = m.index + m[0].length;
        if (endAt < over) continue;
        this.out(piece.slice(0, endAt), false);
        this.truncated = true;
        this.overflowChars += piece.slice(endAt).trim().length;
        return;
      }
    }
    this.out(piece, false);
  }

  private out(t: string, force: boolean): void {
    if (!t) return;
    if (!force && !this.spoken && !t.trim()) return;
    this.spoken += t;
    for (const s of splitSentences(this.spoken)) {
      if (/[.!?…。！？]["')\]]*$/.test(s)) this.spokenSentences.add(normalizeSentence(s));
    }
    this.emitRaw(t);
  }
}
