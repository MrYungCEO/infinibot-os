import type { InfinibotConfig } from "../config/config.js";
import type { CliBackendConfig } from "../config/types.js";
import { normalizeProviderId } from "./model-selection.js";
import { resolveCoderAutoApprove } from "./coder-backend/approval-policy.js";

export type ResolvedCliBackend = {
  id: string;
  config: CliBackendConfig;
};

const CLAUDE_MODEL_ALIASES: Record<string, string> = {
  opus: "opus",
  "opus-4.5": "opus",
  "opus-4": "opus",
  "claude-opus-4-5": "opus",
  "claude-opus-4": "opus",
  sonnet: "sonnet",
  "sonnet-4.5": "sonnet",
  "sonnet-4.1": "sonnet",
  "sonnet-4.0": "sonnet",
  "claude-sonnet-4-5": "sonnet",
  "claude-sonnet-4-1": "sonnet",
  "claude-sonnet-4-0": "sonnet",
  haiku: "haiku",
  "haiku-3.5": "haiku",
  "claude-haiku-3-5": "haiku",
};

// Chat turns stream (stream-json + partial messages) and read the prompt from
// stdin: the variadic --tools / --allowedTools / --mcp-config flags would
// otherwise swallow a positional prompt. Built-in tools are off; InfiniBot's
// own tools arrive through the infinibot MCP server (cli-runner/mcp.ts), so
// the gateway's tool policy still applies.
const CLAUDE_STREAM_ARGS = [
  "-p",
  "--output-format",
  "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--tools",
  "",
];

const DEFAULT_CLAUDE_BACKEND: CliBackendConfig = {
  command: "claude",
  args: CLAUDE_STREAM_ARGS,
  resumeArgs: [...CLAUDE_STREAM_ARGS, "--resume", "{sessionId}"],
  output: "jsonl",
  stream: "claude-stream-json",
  input: "stdin",
  modelArg: "--model",
  modelAliases: CLAUDE_MODEL_ALIASES,
  sessionArg: "--session-id",
  sessionMode: "always",
  sessionIdFields: ["session_id", "sessionId", "conversation_id", "conversationId"],
  systemPromptArg: "--append-system-prompt",
  systemPromptFileArg: "--append-system-prompt-file",
  systemPromptMode: "append",
  systemPromptWhen: "first",
  // Subscription login only: an API key in the env would bill the key instead.
  clearEnv: ["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY_OLD", "ANTHROPIC_AUTH_TOKEN"],
  serialize: false,
  label: "Claude Code",
  vendor: "Anthropic",
};

// Read-only sandbox: a chat turn may read files and run read-only commands but
// never edits the workspace. Coding work goes through codex_coder instead.
const DEFAULT_CODEX_BACKEND: CliBackendConfig = {
  command: "codex",
  args: ["exec", "--json", "--color", "never", "--sandbox", "read-only", "--skip-git-repo-check"],
  resumeArgs: [
    "exec",
    "resume",
    "--json",
    "--skip-git-repo-check",
    "-c",
    'sandbox_mode="read-only"',
    "{sessionId}",
  ],
  output: "jsonl",
  stream: "codex-jsonl",
  // `codex exec` reads the prompt from stdin when none is given (new + resume).
  input: "stdin",
  modelArg: "--model",
  sessionIdFields: ["thread_id"],
  sessionMode: "existing",
  imageArg: "--image",
  imageMode: "repeat",
  clearEnv: ["OPENAI_API_KEY", "CODEX_API_KEY"],
  serialize: false,
  label: "Codex CLI",
  vendor: "OpenAI",
};

// Gemini CLI headless: `gemini --output-format stream-json -p <prompt>`.
const DEFAULT_GEMINI_BACKEND: CliBackendConfig = {
  command: "gemini",
  args: ["--output-format", "stream-json"],
  resumeArgs: ["--output-format", "stream-json", "--resume", "{sessionId}"],
  output: "jsonl",
  stream: "gemini-stream-json",
  // Piped stdin runs Gemini CLI non-interactively with stdin as the prompt.
  input: "stdin",
  modelArg: "-m",
  sessionIdFields: ["session_id", "sessionId"],
  sessionMode: "existing",
  // Gemini CLI ≥0.6x refuses headless runs in an untrusted folder; the
  // workspace is InfiniBot's own, picked by InfiniBot.
  env: { GEMINI_CLI_TRUST_WORKSPACE: "true" },
  clearEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  serialize: false,
  label: "Gemini CLI",
  vendor: "Google",
};

// xAI Grok Build headless: `grok --output-format streaming-json -p <prompt>`.
const DEFAULT_GROK_BACKEND: CliBackendConfig = {
  command: "grok",
  args: ["--output-format", "streaming-json"],
  resumeArgs: ["--output-format", "streaming-json", "--resume", "{sessionId}"],
  output: "jsonl",
  stream: "grok-streaming-json",
  input: "arg",
  promptArg: "-p",
  promptFileArg: "--prompt-file",
  maxPromptArgChars: 100_000,
  modelArg: "-m",
  sessionIdFields: ["sessionId"],
  sessionMode: "existing",
  clearEnv: ["XAI_API_KEY", "GROK_CODE_XAI_API_KEY"],
  serialize: false,
  label: "Grok Build",
  vendor: "xAI",
};

// OpenCode: `opencode run --format json [--session <id>] <prompt>`. Point it
// at Ollama and mark it localOnly to let Secure Mode sessions use it.
const DEFAULT_OPENCODE_BACKEND: CliBackendConfig = {
  command: "opencode",
  args: ["run", "--format", "json"],
  resumeArgs: ["run", "--format", "json", "--session", "{sessionId}"],
  output: "jsonl",
  stream: "opencode-json",
  input: "arg",
  maxPromptArgChars: 100_000,
  modelArg: "--model",
  sessionIdFields: ["sessionID", "sessionId"],
  sessionMode: "existing",
  serialize: false,
  label: "OpenCode",
  vendor: "the model provider OpenCode is configured for",
};

const BUILTIN_BACKENDS: Record<string, CliBackendConfig> = {
  "claude-cli": DEFAULT_CLAUDE_BACKEND,
  "codex-cli": DEFAULT_CODEX_BACKEND,
  "gemini-cli": DEFAULT_GEMINI_BACKEND,
  "grok-cli": DEFAULT_GROK_BACKEND,
  "opencode-cli": DEFAULT_OPENCODE_BACKEND,
};

function normalizeBackendKey(key: string): string {
  return normalizeProviderId(key);
}

function pickBackendConfig(
  config: Record<string, CliBackendConfig>,
  normalizedId: string,
): CliBackendConfig | undefined {
  for (const [key, entry] of Object.entries(config)) {
    if (normalizeBackendKey(key) === normalizedId) return entry;
  }
  return undefined;
}

function mergeBackendConfig(base: CliBackendConfig, override?: CliBackendConfig): CliBackendConfig {
  if (!override) return { ...base };
  return {
    ...base,
    ...override,
    args: override.args ?? base.args,
    env: { ...base.env, ...override.env },
    modelAliases: { ...base.modelAliases, ...override.modelAliases },
    clearEnv: Array.from(new Set([...(base.clearEnv ?? []), ...(override.clearEnv ?? [])])),
    sessionIdFields: override.sessionIdFields ?? base.sessionIdFields,
    sessionArgs: override.sessionArgs ?? base.sessionArgs,
    resumeArgs: override.resumeArgs ?? base.resumeArgs,
  };
}

export function resolveCliBackendIds(cfg?: InfinibotConfig): Set<string> {
  const ids = new Set<string>(Object.keys(BUILTIN_BACKENDS));
  const configured = cfg?.agents?.defaults?.cliBackends ?? {};
  for (const key of Object.keys(configured)) {
    ids.add(normalizeBackendKey(key));
  }
  return ids;
}

/** Permission-bypass flags the default CLI backends pass (claude / codex). */
const CLI_APPROVAL_BYPASS_FLAGS = new Set([
  "--dangerously-skip-permissions",
  "--dangerously-bypass-approvals-and-sandbox",
]);

/** Remove permission-bypass flags from a CLI backend's argv templates. */
export function stripCliApprovalBypass(config: CliBackendConfig): CliBackendConfig {
  const strip = (args?: string[]) =>
    args ? args.filter((arg) => !CLI_APPROVAL_BYPASS_FLAGS.has(arg)) : args;
  return { ...config, args: strip(config.args), resumeArgs: strip(config.resumeArgs) };
}

export function resolveCliBackendConfig(
  provider: string,
  cfg?: InfinibotConfig,
  opts?: {
    /**
     * Origin trust of the turn driving this CLI backend. When false (or when
     * tools.coder.autoApprove="never") the permission-bypass flags are removed.
     * Undefined = operator surface (historical behavior).
     */
    trustedOrigin?: boolean;
  },
): ResolvedCliBackend | null {
  const resolved = resolveCliBackendConfigRaw(provider, cfg);
  if (!resolved) return null;
  const keepBypass = resolveCoderAutoApprove({
    requested: true,
    trustedOrigin: opts?.trustedOrigin,
    cfg,
  });
  return keepBypass ? resolved : { ...resolved, config: stripCliApprovalBypass(resolved.config) };
}

function resolveCliBackendConfigRaw(
  provider: string,
  cfg?: InfinibotConfig,
): ResolvedCliBackend | null {
  const normalized = normalizeBackendKey(provider);
  const configured = cfg?.agents?.defaults?.cliBackends ?? {};
  const override = pickBackendConfig(configured, normalized);

  const builtin = BUILTIN_BACKENDS[normalized];
  if (builtin) {
    const merged = mergeBackendConfig(builtin, override);
    const command = merged.command?.trim();
    if (!command) return null;
    return { id: normalized, config: { ...merged, command } };
  }

  if (!override) return null;
  const command = override.command?.trim();
  if (!command) return null;
  return { id: normalized, config: { ...override, command } };
}
