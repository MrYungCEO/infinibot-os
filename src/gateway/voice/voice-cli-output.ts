/**
 * Voice ↔ CLI session text — pure helpers, no I/O (tested in node).
 *
 * When the Voice page routes a call to a CLI session (voice-cli-turn.ts) the
 * caller's words are typed into a terminal and the terminal's output has to
 * come back as something a TTS engine can read. This module owns that
 * translation:
 *
 *   - `CliOutputCleaner`      raw PTY bytes → clean reply text: ANSI, TUI
 *                             chrome (boxes, spinners, footers, key hints),
 *                             tool-call noise and the echo of what we typed
 *                             are dropped. Claude Code's full-screen TUI is
 *                             read by its `●` reply bullets, line-based CLIs
 *                             line by line.
 *   - `detectApprovalPrompt`  a CLI asking for permission ("Do you want to
 *                             proceed? 1. Yes 2. No", "[y/N]") → a spoken
 *                             question plus the keys that answer it.
 *   - `classifyVoiceCommand`  "yes / approve / deny / stop" spoken by the
 *                             caller → what to send to the session.
 *   - `interruptKeysFor`      the Ctrl-C equivalent per CLI (Esc for the agent
 *                             TUIs, where Ctrl-C clears input or quits).
 */

// ── ANSI / control bytes ───────────────────────────────────────────────────────

/* eslint-disable no-control-regex -- terminal output is control bytes by nature. */
const ANSI_PATTERNS = [
  /\x1b\[[?!>=]?[0-9;:]*[ -/]*[@-~]/g, // CSI
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, // OSC (titles, hyperlinks)
  /\x1b[P_X^][^\x1b]*\x1b\\/g, // DCS / APC / PM / SOS
  /\x1b[()][0-9A-Za-z]/g, // charset selection
  /\x1b[=>78DEHMNOZc]/g, // single-char escapes
];
/* eslint-enable no-control-regex */

/** Strip escape sequences; cursor-forward becomes a space so words stay apart. */
export function stripAnsi(raw: string): string {
  // eslint-disable-next-line no-control-regex
  let out = raw.replace(/\x1b\[(\d*)C/g, (_m, n: string) =>
    " ".repeat(Math.min(Number(n) || 1, 4)),
  );
  // Cursor positioning to a new row starts a new visual line.
  // eslint-disable-next-line no-control-regex
  out = out.replace(/\x1b\[\d+;\d+[Hf]/g, "\n");
  for (const re of ANSI_PATTERNS) out = out.replace(re, "");
  // CR-only redraws: keep what was written after the last CR on that line.
  out = out
    .split("\n")
    .map((line) => {
      const parts = line.split("\r").filter((p) => p.length > 0);
      return parts.length ? parts[parts.length - 1] : "";
    })
    .join("\n");
  // eslint-disable-next-line no-control-regex
  return out.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

// ── line classification ────────────────────────────────────────────────────────

const BOX_CHARS = "│┃┆┇┊┋╎╏║╭╮╯╰┌┐└┘├┤┬┴┼─━┄┅═╔╗╚╝╠╣╦╩╬▔▁▏▕█▌▐░▒▓";
const BOX_EDGES = new RegExp(`^[\\s${BOX_CHARS}]+|[\\s${BOX_CHARS}]+$`, "g");
const PURE_BOX = new RegExp(`^[\\s${BOX_CHARS}]+$`);
const SPINNER = /^[\s◐◓◑◒⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⏳⌛◇◆○✻✳✶✢·*✽⏺]+$/;
/** Claude Code's whimsical status verbs ("✻ Pondering… (3s · esc to interrupt)"). */
const STATUS_LINE =
  /^[✻✳✶✢✽·*⏺]?\s*[A-Z][a-z]+(?:ing|ed)?(?:…|\.\.\.)\s*(?:\(.*\))?$|\(\s*\d+\s*s\s*·|esc to interrupt|ctrl\+c to (?:interrupt|exit|quit)|^[✻✳✶✢✽·*]\s*[A-Z][a-z]+ for \d+\s*[smh]\b/i;
const TOOL_CALL = /^(?:[●⏺•]\s*)?[A-Z][A-Za-z0-9_]*\((?:[^()]|\([^()]*\))*\)\s*$/;
const TOOL_RESULT = /^(?:⎿|└|\s*⎿)/;

/** A screen line that is UI, not words: prompts, hints, footers, spinners. */
export function isChromeLine(line: string, cliType = ""): boolean {
  const t = line.trim();
  if (!t) return true;
  if (PURE_BOX.test(t) || SPINNER.test(t)) return true;
  const s = t.replace(BOX_EDGES, "").trim();
  if (!s || !/[A-Za-z0-9]/.test(s)) return true;
  const lower = s.toLowerCase();
  if (/^[❯›>$%#]\s*$/.test(s)) return true;
  if (/^(?:❯|›)\s/.test(s)) return true; // the input prompt (with or without typed text)
  if (STATUS_LINE.test(s)) return true;
  if (TOOL_CALL.test(s) || TOOL_RESULT.test(s)) return true;
  if (
    /^(?:\?\s*for shortcuts|esc\b|ctrl\+|shift\+|tab\b|enter to|press |↑|↓|⏵⏵|auto-accept|bypass permissions|plan mode)/.test(
      lower,
    )
  )
    return true;
  if (
    /\b(?:for shortcuts|to interrupt|tokens? used|context left|auto-compact|\/effort|\/model|\/help for help)\b/.test(
      lower,
    )
  )
    return true;
  if (
    /^(?:thinking|working|running|loading|connecting|searching|reading|writing)[. …]*$/.test(lower)
  )
    return true;
  if (
    /^(?:tokens?|cost|model|session|cwd|workdir|approval|sandbox|provider|reasoning)\s*[:=]/.test(
      lower,
    )
  )
    return true;
  if (/^[\w./~-]+:\d+(?::\d+)?$/.test(s)) return true; // bare file:line
  if (/^@@.+@@/.test(s)) return true;
  if (/^[-+]\S/.test(s) && s.length < 160) return true; // diff lines
  if (/^\s*\d+\s*[│|]/.test(t)) return true; // numbered source listing
  if (
    cliType === "codex" &&
    /^(?:codex|exec|apply_patch|tool|command|exit code|tokens used)\b/.test(lower)
  )
    return true;
  if (
    cliType === "opencode" &&
    /^(?:opencode|bash|read|write|edit|grep|glob|list|todo|task)\b/.test(lower) &&
    s.length < 100
  )
    return true;
  if (
    cliType === "aider" &&
    /^(?:aider v|model:|git repo:|repo-map:|tokens:|cost:|added .* to the chat|>)/.test(lower)
  )
    return true;
  return false;
}

/** The speakable core of a line ("│ hello │" → "hello"), or null. */
export function speakableLine(line: string, cliType = ""): string | null {
  if (isChromeLine(line, cliType)) return null;
  const s = line
    .replace(BOX_EDGES, "")
    .replace(/^[●⏺•]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  return s.length >= 2 ? s : null;
}

// ── tool activity (for spoken milestones) ──────────────────────────────────────

/** "● Bash(npm test)" → "Running a command"; null when the line is not a tool call. */
export function toolActivity(line: string): string | null {
  const m = /^(?:[●⏺•]\s*)?([A-Z][A-Za-z0-9_]*)\(/.exec(line.trim());
  if (!m) return null;
  const name = m[1].toLowerCase();
  if (/^(?:bash|shell|exec|run)/.test(name)) return "running a command";
  if (/^(?:read|view|cat)/.test(name)) return "reading files";
  if (/^(?:write|edit|multiedit|update|create|applypatch|apply_patch)/.test(name))
    return "editing files";
  if (/^(?:grep|glob|search|find|ls|list)/.test(name)) return "searching the code";
  if (/^(?:web|fetch|browse)/.test(name)) return "looking something up online";
  if (/^(?:task|agent)/.test(name)) return "running a sub-task";
  if (name.startsWith("todo")) return "planning the steps";
  return "working";
}

// ── the cleaner ────────────────────────────────────────────────────────────────

export type CliOutputCleanerOptions = {
  cliType?: string;
  /** Text we typed into the session this turn — its echo is never read back. */
  input?: string;
};

/**
 * Accumulates raw output of one turn and answers "what has the session said
 * so far" as clean text. Full-screen TUIs repaint, so the reply is recomputed
 * from the whole turn buffer each time (bounded) rather than appended.
 */
export class CliOutputCleaner {
  private raw = "";
  private readonly cliType: string;
  private readonly inputNorm: string;
  private static readonly MAX = 64 * 1024;

  constructor(opts: CliOutputCleanerOptions = {}) {
    this.cliType = (opts.cliType ?? "").toLowerCase();
    this.inputNorm = norm(opts.input ?? "");
  }

  push(chunk: string): void {
    if (!chunk) return;
    this.raw = (this.raw + chunk).slice(-CliOutputCleaner.MAX);
  }

  get rawLength(): number {
    return this.raw.length;
  }

  /** Plain text of the turn (ANSI stripped, chrome kept) — for the live panel. */
  plain(): string {
    return stripAnsi(this.raw);
  }

  /** Tool activities seen this turn, oldest first, de-duplicated in a row. */
  activities(): string[] {
    const out: string[] = [];
    for (const line of this.plain().split("\n")) {
      const a = toolActivity(line);
      if (a && out[out.length - 1] !== a) out.push(a);
    }
    return out;
  }

  /** Clean reply lines of the turn, in order, deduplicated. */
  lines(): string[] {
    const text = this.plain();
    const isClaude = this.cliType === "claude" || this.cliType === "claude-code";
    const seen = new Set<string>();
    const out: string[] = [];
    const add = (l: string | null) => {
      if (!l) return;
      const k = norm(l);
      if (!k || seen.has(k)) return;
      if (this.isEcho(k, l)) return;
      seen.add(k);
      out.push(l);
    };
    if (isClaude && text.includes("●")) {
      // Each ● starts an assistant message or a tool call; prose continues on
      // the following indented lines until a blank line / the next bullet.
      for (const seg of text.split(/[●⏺]/).slice(1)) {
        const segLines = seg.split("\n");
        const head = segLines[0] ?? "";
        if (TOOL_CALL.test(`●${head}`.trim()) || toolActivity(`●${head}`)) continue;
        for (const l of segLines) {
          if (/^\s*$/.test(l) && out.length) break;
          if (/^\s*[╭╰│>❯›]/.test(l)) break; // the input box: end of reply
          add(speakableLine(l, "claude"));
        }
      }
      return out;
    }
    for (const l of text.split("\n")) add(speakableLine(l, this.cliType));
    return out;
  }

  /** The reply so far as one block of text. */
  text(): string {
    return this.lines().join("\n");
  }

  private isEcho(k: string, line: string): boolean {
    if (!this.inputNorm) return false;
    return (
      k === this.inputNorm ||
      (k.length > 8 && this.inputNorm.includes(k)) ||
      // A shell often echoes input after its prompt ("user@host:~$ words").
      // Do not drop ordinary assistant prose merely because it quotes the
      // utterance at the end — real CLI answers commonly do that.
      (k.endsWith(this.inputNorm) && /[❯›>$%#]\s*/.test(line))
    );
  }
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// ── approval prompts ───────────────────────────────────────────────────────────

export type ApprovalPrompt = {
  /** What to read to the caller, e.g. "Claude Code asks: Do you want to run npm test? Say yes or no." */
  question: string;
  /** Keys that approve / deny (written to the PTY as-is). */
  approveKeys: string;
  denyKeys: string;
  /** Raw question line as seen on screen. */
  raw: string;
};

const YN_SUFFIX = /[[(]\s*(y(?:es)?\s*\/\s*n(?:o)?|Y\/n|y\/N)\s*[\])]\s*[:?]?\s*$/;
const QUESTION_HINT =
  /\b(?:do you want to|would you like to|allow|approve|proceed|continue\?|run this command|apply (?:this|these) (?:edit|change)s?|make this edit|permission|are you sure|overwrite)\b/i;

/**
 * A permission question at the END of the session's output (what the CLI is
 * waiting on now). Numbered menus ("❯ 1. Yes  2. Yes, and don't ask again
 * 3. No") and y/n suffixes are both understood.
 */
export function detectApprovalPrompt(
  plainTail: string,
  label = "The session",
): ApprovalPrompt | null {
  const lines = plainTail
    .split("\n")
    .map((l) => l.replace(BOX_EDGES, "").trim())
    .filter(Boolean)
    .slice(-14);
  if (!lines.length) return null;

  // y/n question on one of the last lines.
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 3); i--) {
    const l = lines[i];
    const yn = YN_SUFFIX.exec(l);
    if (yn) {
      const q = l
        .replace(YN_SUFFIX, "")
        .replace(/[:\s]+$/, "")
        .trim();
      return {
        question: `${label} asks: ${speakQuestion(q)} Say yes or no.`,
        approveKeys: "y\r",
        denyKeys: "n\r",
        raw: l,
      };
    }
  }

  // Numbered menu: options "1. Yes", "2. No", one of them maybe marked ❯.
  const options: Array<{ n: string; text: string; index: number }> = [];
  lines.forEach((l, index) => {
    const m = /^(?:[❯›>]\s*)?(\d)[.)]\s+(.+)$/.exec(l);
    if (m) options.push({ n: m[1], text: m[2].trim(), index });
  });
  const yes = options.find((o) => /^(?:yes|allow|approve|proceed|accept|run)\b/i.test(o.text));
  const no = options.find((o) => /^(?:no|deny|reject|cancel|decline|skip)\b/i.test(o.text));
  if (yes && no) {
    const firstOpt = Math.min(...options.map((o) => o.index));
    const qLine =
      lines
        .slice(0, firstOpt)
        .reverse()
        .find((l) => QUESTION_HINT.test(l) || l.endsWith("?")) ??
      lines[firstOpt - 1] ??
      "Do you want to proceed?";
    return {
      question: `${label} asks: ${speakQuestion(qLine)} Say yes or no.`,
      approveKeys: yes.n,
      denyKeys: no.n,
      raw: qLine,
    };
  }
  return null;
}

function speakQuestion(q: string): string {
  const s = q
    .replace(/[`*_#]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  if (!s) return "Do you want to proceed?";
  return /[?.!]$/.test(s) ? s : `${s}?`;
}

// ── startup prompts ────────────────────────────────────────────────────────────

export type StartupPrompt = {
  kind: "trust" | "bypass" | "daemon" | "update";
  /** Keys that pick the chosen option (arrows from the highlighted one, then Enter). */
  keys: string;
  raw: string;
};

/**
 * One-time questions agent CLIs ask before they take input, and the answer an
 * owner-started voice session gives. Their highlighted default is often the
 * exit / cancel option, so a voice turn typed into them (words, then Enter)
 * quits the CLI or leaves it stuck. Choosing the folder in the Voice page is
 * the owner's consent to trust it; nothing is ever updated or restarted.
 */
const STARTUP_RULES: Array<{ kind: StartupPrompt["kind"]; hint: RegExp; choose: RegExp }> = [
  // Claude Code / Codex: "Do you trust this folder?" → Yes.
  {
    kind: "trust",
    hint: /trust this (?:folder|directory)|trust the (?:files|contents) (?:in|of) this|do you trust/i,
    choose: /^yes\b/i,
  },
  // Claude Code --dangerously-skip-permissions confirmation → "Yes, I accept".
  { kind: "bypass", hint: /bypass permissions mode/i, choose: /^yes\b/i },
  // Codex: shared background server has other settings → run this session without it
  // (a restart would interrupt the owner's other Codex work).
  {
    kind: "daemon",
    hint: /background server has incompatible|run without daemon/i,
    choose: /^run without daemon/i,
  },
  // Codex: "Update available" → Skip (this time). Never run an installer by voice.
  { kind: "update", hint: /update available/i, choose: /^skip(?!\s+until)\b/i },
];

/** A startup question on screen and the keys that answer it, or null. */
export function detectStartupPrompt(screenPlain: string): StartupPrompt | null {
  const lines = screenPlain
    .split("\n")
    .map((l) => l.replace(BOX_EDGES, "").trim())
    .filter(Boolean)
    .slice(-30);
  const text = lines.join("\n");
  for (const rule of STARTUP_RULES) {
    if (!rule.hint.test(text)) continue;
    // Options: a numbered menu ("› 1. Update now"), else bare "Yes… / No…" lines.
    let options = lines
      .map((l) => /^([❯›>])?\s*\d[.)]\s+(.+)$/.exec(l))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => ({ selected: !!m[1], text: m[2].trim() }));
    if (options.length < 2)
      options = lines
        .map((l) => /^([❯›>])?\s*((?:yes|no)\b.*)$/i.exec(l))
        .filter((m): m is RegExpExecArray => !!m)
        .map((m) => ({ selected: !!m[1], text: m[2].trim() }));
    const pick = options.findIndex((o) => rule.choose.test(o.text));
    if (options.length < 2 || pick < 0) continue;
    const from = Math.max(
      0,
      options.findIndex((o) => o.selected),
    );
    const delta = pick - from;
    const arrow = delta > 0 ? "\x1b[B" : "\x1b[A";
    return {
      kind: rule.kind,
      keys: `${arrow.repeat(Math.abs(delta))}\r`,
      raw: lines.find((l) => rule.hint.test(l)) ?? rule.kind,
    };
  }
  return null;
}

/**
 * The reply of a turn read off the RENDERED screen (tmux capture), for CLIs
 * with no transcript we can read: everything after the last line that echoes
 * the utterance, cleaned of chrome. The raw PTY stream of a full-screen TUI is
 * cursor moves and spinner frames; the rendered screen is the text a person sees.
 */
export function screenReplyText(screenPlain: string, input: string, cliType = ""): string {
  const lines = screenPlain.split("\n");
  const key = norm(input).slice(0, 40);
  let start = 0;
  if (key) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (norm(lines[i]).includes(key)) {
        start = i + 1;
        break;
      }
    }
  }
  const cleaner = new CliOutputCleaner({ cliType, input });
  cleaner.push(lines.slice(start).join("\n"));
  return cleaner.text();
}

// ── spoken commands ────────────────────────────────────────────────────────────

export type VoiceCliCommand = "approve" | "deny" | "interrupt" | "fallback" | null;

/**
 * What a short utterance means to the routed session. Approve / deny only
 * count while a permission prompt is open (`promptOpen`), so "yes" in normal
 * conversation is just typed into the session.
 */
export function classifyVoiceCommand(
  utterance: string,
  opts: { promptOpen?: boolean } = {},
): VoiceCliCommand {
  const t = utterance
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return null;
  if (
    /^(?:switch|go|change) (?:back )?to (?:the )?(?:api|normal|regular|default)(?: llm| assistant| mode| model)?$|^(?:stop|exit|leave|end) (?:cli|terminal) (?:mode|routing)$/.test(
      t,
    )
  )
    return "fallback";
  if (
    /^(?:(?:ok(?:ay)? |hey )?(?:stop|cancel|abort|interrupt|halt|hold on|wait|never ?mind)(?: (?:it|that|this|now|please|right there|the (?:task|command|session)))*)$/.test(
      t,
    )
  )
    return "interrupt";
  if (!opts.promptOpen) return null;
  if (
    /^(?:no|nope|nah|deny|denied|reject|don't|do not|decline|negative|no thanks|no don't)\b/.test(t)
  )
    return "deny";
  if (
    /^(?:yes|yeah|yep|yup|sure|ok(?:ay)?|approve[d]?|allow(?:ed)?|accept|confirm(?:ed)?|go ahead|do it|proceed|affirmative|run it|please do)\b/.test(
      t,
    )
  )
    return "approve";
  return null;
}

/** Keys that interrupt the session's current work. */
export function interruptKeysFor(cliType: string | undefined): string {
  const c = (cliType ?? "").toLowerCase();
  // Agent TUIs: Esc interrupts the turn; Ctrl-C clears input / asks to quit.
  if (/^(?:claude|claude-code|codex|opencode|gemini|grok|qwen|crush|amp|cursor-agent)$/.test(c))
    return "\x1b";
  return "\x03";
}

/** Sentence-initial form ("the terminal" → "The terminal"). */
export function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** "claude" → "Claude Code" (what the caller hears). */
export function cliDisplayName(cliType: string | undefined): string {
  switch ((cliType ?? "").toLowerCase()) {
    case "claude":
    case "claude-code":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "opencode":
      return "OpenCode";
    case "gemini":
      return "Gemini";
    case "grok":
    case "grok-cli":
      return "Grok Build";
    case "aider":
      return "Aider";
    case "qwen":
      return "Qwen Code";
    case "goose":
      return "Goose";
    case "cursor-agent":
      return "Cursor Agent";
    case "amp":
      return "Amp";
    case "crush":
      return "Crush";
    case "ollama":
      return "Ollama";
    case "shell":
    case "":
      return "the terminal";
    default:
      return cliType!;
  }
}
