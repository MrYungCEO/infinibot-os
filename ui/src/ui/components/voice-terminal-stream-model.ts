/**
 * Pure parts of <voice-terminal-stream>: ANSI stripping, the bounded line
 * buffer the panel renders from, and the "follow the tail?" decision.
 * No DOM, no gateway — unit-tested in voice-terminal-stream-model.test.ts.
 */

export const DEFAULT_MAX_LINES = 2000;
/** Distance from the bottom (px) that still counts as "at the tail". */
export const FOLLOW_THRESHOLD_PX = 24;

// CSI: ESC [ params intermediates final. Cursor-forward (ESC[nC) is how TUIs
// like Claude Code paint spaces, so it becomes n spaces instead of nothing.
// eslint-disable-next-line no-control-regex
const CSI_RE = /\x1b\[([0-?]*)([ -/]*)([@-~])/g;
// OSC (titles, hyperlinks): ESC ] … BEL | ESC \
// eslint-disable-next-line no-control-regex
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// DCS / SOS / PM / APC strings: ESC P|X|^|_ … ESC \
// eslint-disable-next-line no-control-regex
const STRING_RE = /\x1b[PX^_][^\x1b]*\x1b\\/g;
// Remaining two-byte escapes (ESC 7, ESC =, ESC ( B …).
// eslint-disable-next-line no-control-regex
const ESC2_RE = /\x1b[()*+][0-9A-Za-z]|\x1b[@-Z\\-_0-9=<>]/g;
// C0 controls other than \t \n \r (bell, backspace, …) and DEL.
// eslint-disable-next-line no-control-regex
const C0_RE = /[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g;

/** Remove ANSI / VT escape sequences and stray control bytes; keeps \n, \r and \t. */
export function stripAnsi(input: string): string {
  if (!input) return "";
  return input
    .replace(OSC_RE, "")
    .replace(STRING_RE, "")
    .replace(CSI_RE, (_m, params: string, _i: string, final: string) => {
      if (final === "C") {
        const n = Number.parseInt(params || "1", 10);
        return " ".repeat(Number.isFinite(n) && n > 0 ? Math.min(n, 200) : 1);
      }
      return "";
    })
    .replace(ESC2_RE, "")
    .replace(/\x1b/g, "")
    .replace(C0_RE, "");
}

/**
 * Split off an escape sequence cut in half at the end of a chunk, so the next
 * chunk can complete it (otherwise its tail would print as text).
 */
export function splitIncompleteEscape(chunk: string): [complete: string, carry: string] {
  const at = chunk.lastIndexOf("\x1b");
  if (at === -1) return [chunk, ""];
  const tail = chunk.slice(at);
  if (tail.length > 512) return [chunk, ""]; // not a real sequence; don't hold text forever
  // eslint-disable-next-line no-control-regex
  const complete =
    /^\x1b\[[0-?]*[ -/]*[@-~]/.test(tail) ||
    // eslint-disable-next-line no-control-regex
    /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.test(tail) ||
    // eslint-disable-next-line no-control-regex
    /^\x1b[()*+][0-9A-Za-z]/.test(tail) ||
    // eslint-disable-next-line no-control-regex
    /^\x1b[@-OQ-WYZ\\0-9=<>]/.test(tail);
  if (complete || tail === "\x1b\\") return [chunk, ""];
  // An OSC/CSI start with no terminator yet, or a bare ESC.
  // eslint-disable-next-line no-control-regex
  if (/^\x1b(?:$|\[[0-?]*[ -/]*$|\][^\x07\x1b]*$|[()*+]$|[PX^_])/.test(tail)) return [chunk.slice(0, at), tail];
  return [chunk, ""];
}

/**
 * Bounded, ANSI-free line buffer fed raw PTY chunks.
 *   - "\r\n" / "\n" end a line; a lone "\r" rewinds the current line
 *     (spinners and progress bars overwrite in place instead of piling up).
 *   - keeps at most `maxLines` complete lines (oldest dropped first).
 */
export class TerminalLineBuffer {
  private done: string[] = [];
  private partial = "";
  private carry = "";
  private pendingCr = false;
  /** Lines dropped off the top since the last clear (for "… N earlier lines"). */
  dropped = 0;
  /** Bumped on every change; cheap dirty-check for renderers. */
  version = 0;

  constructor(readonly maxLines = DEFAULT_MAX_LINES) {}

  push(raw: string): void {
    if (!raw) return;
    const [complete, carry] = splitIncompleteEscape(this.carry + raw);
    this.carry = carry;
    const text = stripAnsi(complete).replace(/\r\n/g, "\n");
    if (!text) return;
    const parts = text.split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) this.commit();
      const pieces = parts[i].split("\r");
      for (let j = 0; j < pieces.length; j++) {
        // A carriage return rewinds the line: the next text replaces it
        // (spinners / progress bars redraw in place instead of piling up).
        if (j > 0) this.pendingCr = true;
        const piece = pieces[j];
        if (!piece) continue;
        if (this.pendingCr) {
          this.partial = piece;
          this.pendingCr = false;
        } else {
          this.partial += piece;
        }
      }
    }
    this.version++;
  }

  /** Replace everything with a full snapshot (e.g. a capture-pane read). */
  reset(snapshot = ""): void {
    this.done = [];
    this.partial = "";
    this.carry = "";
    this.pendingCr = false;
    this.dropped = 0;
    this.version++;
    if (snapshot) this.push(snapshot);
  }

  private commit(): void {
    this.done.push(this.partial.replace(/\s+$/, ""));
    this.partial = "";
    this.pendingCr = false;
    const over = this.done.length - this.maxLines;
    if (over > 0) {
      this.done.splice(0, over);
      this.dropped += over;
    }
  }

  /** Every line, the in-progress one included (bounded by maxLines + 1). */
  get lines(): string[] {
    const tail = this.partial.replace(/\s+$/, "");
    return tail ? [...this.done, tail] : this.done.slice();
  }

  get size(): number {
    return this.done.length + (this.partial.trim() ? 1 : 0);
  }

  /** Last line with visible text (what the collapsed one-line status shows). */
  lastLine(): string {
    if (this.partial.trim()) return this.partial.trim();
    for (let i = this.done.length - 1; i >= 0; i--) {
      const l = this.done[i].trim();
      if (l) return l;
    }
    return "";
  }

  text(): string {
    return this.lines.join("\n");
  }
}

export type ScrollMetrics = { scrollTop: number; scrollHeight: number; clientHeight: number };

/** True when the view sits at (or within `threshold` px of) the bottom. */
export function isAtTail(m: ScrollMetrics, threshold = FOLLOW_THRESHOLD_PX): boolean {
  return m.scrollHeight - m.clientHeight - m.scrollTop <= threshold;
}

/**
 * Auto-scroll decision after a scroll event. Scrolling UP away from the tail
 * pauses following; reaching the tail again (or tapping Resume) re-arms it.
 * A programmatic jump to the tail never pauses.
 */
export function nextFollow(prev: { follow: boolean; lastTop: number }, m: ScrollMetrics, threshold = FOLLOW_THRESHOLD_PX): { follow: boolean; lastTop: number } {
  if (isAtTail(m, threshold)) return { follow: true, lastTop: m.scrollTop };
  const movedUp = m.scrollTop < prev.lastTop - 1;
  return { follow: movedUp ? false : prev.follow, lastTop: m.scrollTop };
}

/** Should new output jump the view to the bottom? */
export function shouldAutoScroll(follow: boolean, open: boolean): boolean {
  return follow && open;
}

/** "live" while output arrived within `windowMs`. */
export function isLive(lastOutputAt: number | null, now: number, windowMs = 6000): boolean {
  return lastOutputAt !== null && now - lastOutputAt <= windowMs;
}
