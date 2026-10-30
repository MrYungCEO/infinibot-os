/**
 * markitdown wrapper — document → markdown for cross-agent "parity context".
 *
 * Microsoft's markitdown (https://github.com/microsoft/markitdown) converts a
 * wide range of document formats (PDF, docx, pptx, xlsx, html, csv, images with
 * text, ...) into clean markdown. There is no first-class Node binding, so we
 * invoke the official Python CLI as a subprocess. This is the single place the
 * rest of the report system calls to obtain the markdown parity copy of a
 * rendered/ingested document — see helpers/parity.ts.
 *
 * Install (once, on the host running the gateway/worker):
 *   pipx install markitdown        # or: pip install 'markitdown[all]'
 *
 * Everything here is best-effort: if markitdown is not installed (or the file is
 * a format it cannot read) we return `{ ok: false, error }` and the caller keeps
 * the report — only the markdown parity copy is skipped. We never throw.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

/** Result of a markitdown conversion attempt. */
export interface MarkitdownResult {
  ok: boolean;
  /** Converted markdown (present when ok). */
  markdown?: string;
  /** How the conversion was invoked (for diagnostics). */
  via?: "markitdown-cli" | "python-module";
  /** Failure reason (present when !ok). */
  error?: string;
}

/** Lowercase extension (no dot) of a path, or "" when there is none. */
function extOf(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/**
 * Formats markitdown reliably handles. We still *attempt* unknown extensions
 * (markitdown sniffs content) but use this to label `original_format`.
 */
export const MARKITDOWN_FORMATS = new Set([
  "pdf",
  "docx",
  "doc",
  "pptx",
  "ppt",
  "xlsx",
  "xls",
  "csv",
  "tsv",
  "html",
  "htm",
  "xml",
  "json",
  "txt",
  "md",
  "epub",
  "rtf",
  "odt",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "bmp",
  "tiff",
  "wav",
  "mp3",
  "zip",
]);

/** Best-effort original-format label for a file path. */
export function originalFormatOf(filePath: string): string {
  const ext = extOf(filePath);
  return ext || "unknown";
}

function run(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: number }).code === "number"
            ? ((error as { code?: number }).code as number)
            : error
              ? 1
              : 0;
        resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });
}

let _availabilityCache: { value: boolean; via: MarkitdownResult["via"] } | null = null;

/**
 * Is markitdown invokable on this host? Cached after the first probe (a process
 * lives long enough that re-probing per save is wasteful). Tries the `markitdown`
 * binary first, then `python3 -m markitdown`.
 */
export async function markitdownAvailable(force = false): Promise<boolean> {
  if (_availabilityCache && !force) return _availabilityCache.value;
  // 1. The CLI shim.
  const cli = await run("markitdown", ["--help"], 8000);
  if (cli.code === 0 || /usage:/i.test(cli.stdout + cli.stderr)) {
    _availabilityCache = { value: true, via: "markitdown-cli" };
    return true;
  }
  // 2. The python module form (covers `pip install` without a console-script).
  for (const py of ["python3", "python"]) {
    const mod = await run(py, ["-m", "markitdown", "--help"], 8000);
    if (mod.code === 0 || /usage:/i.test(mod.stdout + mod.stderr)) {
      _availabilityCache = { value: true, via: "python-module" };
      return true;
    }
  }
  _availabilityCache = { value: false, via: undefined };
  return false;
}

/**
 * Convert a document on disk to markdown. Returns `{ ok:false }` (never throws)
 * when markitdown is missing, the file is absent, or the conversion fails.
 */
export async function convertToMarkdown(
  filePath: string,
  opts: { timeoutMs?: number } = {},
): Promise<MarkitdownResult> {
  if (!existsSync(filePath)) {
    return { ok: false, error: `file not found: ${filePath}` };
  }
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const available = await markitdownAvailable();
  if (!available) {
    return {
      ok: false,
      error:
        "markitdown not installed — run `pipx install markitdown` (or `pip install 'markitdown[all]'`) on the gateway host",
    };
  }
  const via = _availabilityCache?.via;

  // markitdown writes markdown to stdout: `markitdown <file>`.
  const attempt =
    via === "python-module"
      ? await tryPythonModule(filePath, timeoutMs)
      : await run("markitdown", [filePath], timeoutMs);

  if (attempt.code === 0 && attempt.stdout.trim()) {
    return { ok: true, markdown: attempt.stdout, via };
  }
  return {
    ok: false,
    via,
    error: (attempt.stderr || `markitdown exited ${attempt.code}`).slice(0, 400),
  };
}

async function tryPythonModule(filePath: string, timeoutMs: number) {
  for (const py of ["python3", "python"]) {
    const r = await run(py, ["-m", "markitdown", filePath], timeoutMs);
    if (r.code === 0 && r.stdout.trim()) return r;
  }
  return { code: 1, stdout: "", stderr: "python -m markitdown produced no output" };
}
