/**
 * Bounded accumulator for a background coder process's stdout/stderr.
 *
 * Background sessions used to keep `stdout += chunk` for the whole run; the
 * closures over that string lived as long as anything referenced the session,
 * so a long coder run (stream-json logs reach 30–60 MB) pinned tens of MB of
 * heap each — and finished runs were retained indefinitely by the queue/goal
 * runners. This keeps the head (session/thread ids are announced first) and a
 * large tail (the final `result` event and recent output). When nothing has
 * been dropped `toString()` is exactly the concatenated input.
 */
export const BG_OUTPUT_HEAD_CHARS = 64 * 1024;
export const BG_OUTPUT_TAIL_CHARS = 8 * 1024 * 1024;

export class CappedOutput {
  private head = "";
  private tail = "";
  private droppedChars = 0;

  constructor(
    private readonly headMax = BG_OUTPUT_HEAD_CHARS,
    private readonly tailMax = BG_OUTPUT_TAIL_CHARS,
  ) {}

  push(chunk: string): void {
    if (!chunk) return;
    let rest = chunk;
    if (this.head.length < this.headMax && this.tail.length === 0) {
      const room = this.headMax - this.head.length;
      this.head += rest.slice(0, room);
      rest = rest.slice(room);
      if (!rest) return;
    }
    this.tail += rest;
    // Trim with slack so the O(tailMax) copy happens once per ~tailMax/4 of
    // new output, not on every chunk.
    if (this.tail.length > this.tailMax + (this.tailMax >> 2)) {
      const cut = this.tail.length - this.tailMax;
      this.droppedChars += cut;
      this.tail = this.tail.slice(cut);
    }
  }

  /** Characters discarded from the middle so far. */
  get dropped(): number {
    return this.droppedChars;
  }

  get length(): number {
    return this.head.length + this.tail.length;
  }

  toString(): string {
    // A newline at the cut keeps a partial line from fusing with the head's
    // last line (line-oriented JSON parsers then just skip the fragment).
    return this.droppedChars > 0 ? `${this.head}\n${this.tail}` : this.head + this.tail;
  }
}
