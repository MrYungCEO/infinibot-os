/**
 * Verified-completion contract — single source of truth.
 *
 * Every spawned coder / agent run (Claude Code, Codex, OpenCode, Gemini,
 * gateway sub-agents via sessions_spawn) gets {@link COMPLETION_CONTRACT_PROMPT}
 * appended to its system prompt. It requires a final machine-readable RESULT
 * block that the gateway parses on exit ({@link parseResultBlock}) and then
 * cross-checks against evidence (see ./evidence.ts and ./reviewer.ts).
 *
 * A process exiting never counts as success on its own: a run is only
 * VERIFIED when the review finds every claim backed by evidence.
 *
 * See docs/principles/VERIFIED-COMPLETION.md.
 */

export type ResultStatus = "done" | "blocked" | "needs_input";

export type EvidenceType = "command" | "test" | "screenshot" | "file" | "url";

export interface ResultClaim {
  claim: string;
  evidence_type: EvidenceType;
  /** Command text, test name, screenshot path, file path or URL. */
  evidence_ref: string;
}

export interface ResultCheck {
  command: string;
  /** Absolute directory the command ran in. The verifier replays it there. */
  cwd?: string;
  exit_code: number | null;
  output_tail?: string;
}

export interface RunResult {
  status: ResultStatus;
  summary: string;
  commits: string[];
  files_changed: string[];
  claims: ResultClaim[];
  checks_run: ResultCheck[];
  screenshots: string[];
  open_issues: string[];
  /** Kanban task ids (same project) this run completed — reconciled with the run's verdict. */
  tasks_completed?: string[];
}

export const RESULT_OPEN = "<<<RESULT";
export const RESULT_CLOSE = "RESULT>>>";

/** JSON schema of the RESULT block (documented + exposed over RPC). */
export const RESULT_JSON_SCHEMA = {
  type: "object",
  required: ["status", "summary"],
  properties: {
    status: { enum: ["done", "blocked", "needs_input"] },
    summary: { type: "string" },
    commits: { type: "array", items: { type: "string", description: "commit sha" } },
    files_changed: { type: "array", items: { type: "string" } },
    claims: {
      type: "array",
      items: {
        type: "object",
        required: ["claim", "evidence_type", "evidence_ref"],
        properties: {
          claim: { type: "string" },
          evidence_type: { enum: ["command", "test", "screenshot", "file", "url"] },
          evidence_ref: { type: "string" },
        },
      },
    },
    checks_run: {
      type: "array",
      items: {
        type: "object",
        required: ["command", "exit_code"],
        properties: {
          command: { type: "string" },
          cwd: { type: "string", description: "absolute directory the command ran in" },
          exit_code: { type: ["integer", "null"] },
          output_tail: { type: "string" },
        },
      },
    },
    screenshots: { type: "array", items: { type: "string", description: "absolute png path" } },
    open_issues: { type: "array", items: { type: "string" } },
    tasks_completed: {
      type: "array",
      items: { type: "string", description: "kanban task id on the run's project board" },
    },
  },
} as const;

/**
 * Appended to every spawned run's system prompt. Keep it short — it rides on
 * every spawn — but explicit enough that a model follows it without the docs.
 */
export const COMPLETION_CONTRACT_PROMPT = `## Verified completion (mandatory)
InfiniBot verifies your work after you exit. Exiting is not success; evidence is.

1. Never end your turn while background work you started (background shells, test runs, builds, dev servers you are waiting on) is still running. Wait for it and read its result first. Never end with "I'll wait for…" / "next I will…" — do it now.
2. Only claim what you proved. "Tests pass" needs the command + the directory it ran in (cwd) + exit code; "verified in the browser" needs a screenshot file. Claims are for the task's acceptance criteria — don't list incidental observations as claims.
3. Visual changes (UI/CSS/HTML, views, components, styles, mobile screens, docs pages) REQUIRE visual verification: call the \`visual_verify\` tool (routes + expectation) and list the screenshot paths it returns.
4. Your FINAL message must end with exactly one RESULT block — JSON between the markers, nothing after it:

${RESULT_OPEN}
{"status":"done|blocked|needs_input","summary":"1-3 sentences",
 "commits":["<sha>"],"files_changed":["path"],
 "claims":[{"claim":"build passes","evidence_type":"command|test|screenshot|file|url","evidence_ref":"pnpm build"}],
 "checks_run":[{"command":"pnpm test src/x","cwd":"/abs/dir/it/ran/in","exit_code":0,"output_tail":"last lines"}],
 "screenshots":["/abs/path.png"],"open_issues":["anything not done"]}
${RESULT_CLOSE}

Use status "blocked" or "needs_input" (with open_issues) instead of pretending to be done. If you finished other kanban tasks on the same project, list their ids in "tasks_completed".`;

/** Continuation prompt used when a run exited before finishing. */
export function buildContinuationPrompt(reasons: string[], extra?: string): string {
  const why = reasons.length
    ? `\nWhy the gateway thinks you are not finished:\n- ${reasons.join("\n- ")}`
    : "";
  return [
    "Continue: you exited before finishing. Complete the remaining work and verification, then output the RESULT block.",
    why,
    extra ? `\n${extra}` : "",
    `\nDo not end your turn while background work is still running. End with the ${RESULT_OPEN} … ${RESULT_CLOSE} block.`,
  ]
    .join("")
    .trim();
}

// ── Parsing ────────────────────────────────────────────────────────────────

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === "string" ? x.trim() : typeof x === "number" ? String(x) : ""))
    .filter(Boolean);
}

const EVIDENCE_TYPES: ReadonlySet<string> = new Set([
  "command",
  "test",
  "screenshot",
  "file",
  "url",
]);

/** Coerce a parsed object into a RunResult. Returns null when it is not one. */
export function coerceRunResult(raw: unknown): RunResult | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const statusRaw = typeof r.status === "string" ? r.status.trim().toLowerCase() : "";
  const status: ResultStatus | null =
    statusRaw === "done" || statusRaw === "complete" || statusRaw === "completed"
      ? "done"
      : statusRaw === "blocked"
        ? "blocked"
        : statusRaw === "needs_input" || statusRaw === "needs-input"
          ? "needs_input"
          : null;
  if (!status) return null;
  const claims: ResultClaim[] = Array.isArray(r.claims)
    ? r.claims
        .map((c): ResultClaim | null => {
          if (typeof c === "string") return { claim: c, evidence_type: "file", evidence_ref: "" };
          if (!c || typeof c !== "object") return null;
          const o = c as Record<string, unknown>;
          const claim = typeof o.claim === "string" ? o.claim.trim() : "";
          if (!claim) return null;
          const et = typeof o.evidence_type === "string" ? o.evidence_type.trim() : "";
          return {
            claim,
            evidence_type: (EVIDENCE_TYPES.has(et) ? et : "file") as EvidenceType,
            evidence_ref: typeof o.evidence_ref === "string" ? o.evidence_ref.trim() : "",
          };
        })
        .filter((c): c is ResultClaim => c !== null)
    : [];
  const checks: ResultCheck[] = Array.isArray(r.checks_run)
    ? r.checks_run
        .map((c): ResultCheck | null => {
          if (!c || typeof c !== "object") return null;
          const o = c as Record<string, unknown>;
          const command = typeof o.command === "string" ? o.command.trim() : "";
          if (!command) return null;
          const code = o.exit_code ?? o.exitCode;
          const cwd = typeof o.cwd === "string" && o.cwd.trim() ? o.cwd.trim() : undefined;
          return {
            command,
            ...(cwd ? { cwd } : {}),
            exit_code: typeof code === "number" && Number.isFinite(code) ? code : null,
            output_tail: typeof o.output_tail === "string" ? o.output_tail.slice(-2000) : undefined,
          };
        })
        .filter((c): c is ResultCheck => c !== null)
    : [];
  return {
    status,
    summary: typeof r.summary === "string" ? r.summary.trim().slice(0, 4000) : "",
    commits: asStringArray(r.commits),
    files_changed: asStringArray(r.files_changed),
    claims,
    checks_run: checks,
    screenshots: asStringArray(r.screenshots),
    open_issues: asStringArray(r.open_issues),
    ...(asStringArray(r.tasks_completed).length
      ? { tasks_completed: asStringArray(r.tasks_completed).slice(0, 20) }
      : {}),
  };
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Tolerate trailing commas + smart quotes, the two most common model slips.
    try {
      return JSON.parse(text.replace(/[“”]/g, '"').replace(/,\s*([}\]])/g, "$1"));
    } catch {
      return undefined;
    }
  }
}

/** Extract the outermost balanced {...} starting at `from`. */
function sliceBalancedObject(text: string, from: number): string | null {
  const start = text.indexOf("{", from);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Find the LAST RESULT block in free text. Tolerant, in order:
 *   1. `<<<RESULT … RESULT>>>` markers (canonical);
 *   2. a ```json fenced block whose object has a `status` + `summary`
 *      (models sometimes drop the markers);
 *   3. a bare `RESULT:` / `RESULT` heading followed by a JSON object.
 */
export function parseResultBlock(text: string): RunResult | null {
  if (!text) return null;
  // 1. canonical markers — last one wins.
  const open = text.lastIndexOf(RESULT_OPEN);
  if (open >= 0) {
    const close = text.indexOf(RESULT_CLOSE, open);
    const body =
      close > open
        ? text.slice(open + RESULT_OPEN.length, close)
        : text.slice(open + RESULT_OPEN.length);
    const fenced = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1] : sliceBalancedObject(body, 0);
    if (candidate) {
      const parsed = coerceRunResult(tryParseJson(candidate.trim()));
      if (parsed) return parsed;
    }
  }
  // 2. fenced json blocks, last first.
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].reverse();
  for (const m of fences) {
    const obj = tryParseJson(m[1].trim());
    if (
      obj &&
      typeof obj === "object" &&
      "status" in (obj as object) &&
      "summary" in (obj as object)
    ) {
      const parsed = coerceRunResult(obj);
      if (parsed) return parsed;
    }
  }
  // 3. "RESULT" heading + object.
  const heading = text.search(/(^|\n)\s*(\*\*)?RESULT(\*\*)?\s*:?\s*\n?\s*\{/i);
  if (heading >= 0) {
    const obj = sliceBalancedObject(text, heading);
    if (obj) {
      const parsed = coerceRunResult(tryParseJson(obj));
      if (parsed) return parsed;
    }
  }
  return null;
}
