import type { CliBackendConfig } from "../../config/types.js";
import { checkCommandLine, type CommandLineCheck } from "../../process/argv-budget.js";
import { buildCliArgs, resolvePromptInput } from "./helpers.js";

/** POSIX: a system prompt above this goes through the CLI's file flag. */
export const SYSTEM_PROMPT_ARG_MAX = 64 * 1024;

export type CliArgvPlan = {
  args: string[];
  /** Fed to the CLI's stdin ("" = close stdin at once). */
  stdin: string;
  /** Prompt still riding in argv, if any (for argv logging). */
  argsPrompt?: string;
  promptFile?: string;
  systemPromptFile?: string;
  check: CommandLineCheck;
};

/**
 * Lay out one CLI turn's argv so the command line fits the platform:
 * build it inline, measure it (Windows: the whole quoted command line, 30k
 * or 8k through cmd.exe; POSIX: 128 KiB per arg), and move text out until it
 * fits — the system prompt to the CLI's system-prompt file flag (always, on
 * Windows), then the prompt to its prompt-file flag, else stdin. The user's
 * message is never refused for being long.
 */
export async function planCliArgv(params: {
  backend: CliBackendConfig;
  /** Resolved binary (Windows: the .cmd/.exe path spawn will use). */
  command: string;
  baseArgs: string[];
  modelId: string;
  sessionId?: string;
  useResume: boolean;
  imagePaths?: string[];
  prompt: string;
  /** System prompt for the backend's systemPromptArg (null = none this turn). */
  systemPrompt: string | null;
  platform?: NodeJS.Platform;
  writeScratch: (name: string, body: string) => Promise<string>;
}): Promise<CliArgvPlan> {
  const { backend } = params;
  const platform = params.platform ?? process.platform;
  let { argsPrompt, stdin } = resolvePromptInput({ backend, prompt: params.prompt });
  let promptFile: string | undefined;
  let systemInline = params.systemPrompt;
  let systemPromptFile: string | undefined;

  // Over the backend's own argv cap: prompt file if the CLI has one, else stdin.
  if (
    argsPrompt === undefined &&
    stdin !== undefined &&
    backend.input !== "stdin" &&
    backend.promptFileArg
  ) {
    promptFile = await params.writeScratch("prompt.txt", stdin);
    stdin = undefined;
  }

  const moveSystemPrompt = async () => {
    if (!systemInline || !backend.systemPromptFileArg) return false;
    systemPromptFile = await params.writeScratch("system-prompt.md", systemInline);
    systemInline = null;
    return true;
  };
  const movePrompt = async () => {
    if (argsPrompt === undefined) return false;
    if (backend.promptFileArg) promptFile = await params.writeScratch("prompt.txt", argsPrompt);
    else stdin = argsPrompt;
    argsPrompt = undefined;
    return true;
  };

  // Windows: a system prompt is tens of KB against a 30k (8k) command line —
  // always use the file flag when the CLI has one.
  if (systemInline && (platform === "win32" || systemInline.length > SYSTEM_PROMPT_ARG_MAX)) {
    await moveSystemPrompt();
  }

  const build = () => {
    const args = buildCliArgs({
      backend,
      baseArgs: params.baseArgs,
      modelId: params.modelId,
      sessionId: params.sessionId,
      systemPrompt: systemInline,
      imagePaths: params.imagePaths,
      promptArg: argsPrompt,
      useResume: params.useResume,
    });
    if (systemPromptFile && backend.systemPromptFileArg) {
      args.push(backend.systemPromptFileArg, systemPromptFile);
    }
    if (promptFile && backend.promptFileArg) args.push(backend.promptFileArg, promptFile);
    return args;
  };

  let args = build();
  let check = checkCommandLine({ command: params.command, args, platform });
  for (const move of [moveSystemPrompt, movePrompt]) {
    if (check.fits) break;
    if (!(await move())) continue;
    args = build();
    check = checkCommandLine({ command: params.command, args, platform });
  }

  return {
    args,
    stdin: stdin ?? "",
    argsPrompt,
    promptFile,
    systemPromptFile,
    check,
  };
}
