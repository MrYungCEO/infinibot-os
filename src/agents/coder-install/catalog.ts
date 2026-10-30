/**
 * Coder catalog — the single source of truth for every CLI coding agent
 * InfiniBot can install, sign in and drive from Setup › Coders.
 *
 * Only packages with a reliable, non-interactive install are "installable":
 * an npm package installed into an InfiniBot-managed prefix
 * (`<stateDir>/coders/<id>`, cloud: `/data/coders/<id>`), or a Python tool via
 * `uv tool` / `pipx` when one of those is on the host. Everything else is
 * listed as "manual" with the vendor's install page, so the card can still
 * explain how to get it without us piping a remote shell script into bash.
 *
 * Package specs are curated here and never come from the caller: the RPCs
 * accept a catalog id only, so no user-supplied string ever reaches npm/uv.
 * npm verifies every tarball against the registry's sha512 `integrity`, and
 * the installed version is read back from the package's own package.json and
 * the CLI's `--version` before an install is reported as done.
 *
 * Logos: InfiniBot shows neutral gold letter monograms, never vendor logos
 * (docs/licensing/BRAND-USAGE.md). `monogram` is the letter; `logo` points at
 * an existing rasterized monogram under ui/public/providers when one exists.
 */

import type { CoderBackendId } from "../coder-backend/types.js";

export type CoderId =
  | "claude-code"
  | "codex"
  | "opencode"
  | "gemini"
  | "qwen-code"
  | "amp"
  | "crush"
  | "aider"
  | "goose"
  | "cursor-cli"
  | "grok-build";

/** One way to install a coder, tried in catalog order. */
export type CoderInstallMethod =
  | {
      kind: "npm";
      /** Registry package name (curated, never caller-supplied). */
      package: string;
      /** Dist-tag or exact version. "latest" unless a pin is required. */
      version: string;
      /**
       * Whether the package's install scripts must run. Claude Code and
       * OpenCode copy their platform-native binary in postinstall; without
       * it the launcher prints "native binary not installed".
       */
      needsScripts: boolean;
    }
  | {
      kind: "uv" | "pipx";
      /** PyPI package name. */
      package: string;
    }
  | {
      /**
       * A vendor-published prebuilt binary: `channelUrl` answers the current
       * version; `artifactUrl` ({version}, {platform}) is the binary itself.
       * `platforms` maps `${process.platform}-${process.arch}` to the vendor's
       * platform name. Downloaded straight into the coder's prefix — no
       * install script, no shell-profile edits, no admin rights.
       */
      kind: "binary";
      channelUrl: string;
      artifactUrl: string;
      /** Tried when the primary host is unreachable. */
      fallbackBaseUrls?: string[];
      platforms: Record<string, string>;
    }
  | {
      kind: "manual";
      /** Vendor install page shown on the card. */
      url: string;
      /** Why this can't be a one-click install. */
      reason: string;
    };

export interface CoderAuthMethod {
  kind: "api-key" | "oauth-login";
  label: string;
  /**
   * api-key: env vars the key may be injected as (first = default). The key
   * is stored in the auth-profile store and injected ONLY into this coder's
   * spawn env.
   */
  envVars?: string[];
  /**
   * oauth-login: argv (after the binary) that starts a browser/device-code
   * sign-in. Run inside a PTY; the URL / code are scraped and shown in the
   * sign-in modal.
   */
  loginArgs?: string[];
  /** oauth-login: extra env for the login process (e.g. Gemini's NO_BROWSER flow). */
  loginEnv?: Record<string, string>;
  /**
   * oauth-login: the CLI asks for a pasted code (Claude's "Paste code here").
   * The modal shows an input and forwards it to the PTY.
   */
  acceptsCode?: boolean;
  /**
   * oauth-login: keys to type when a prompt appears (regex source, matched
   * case-insensitively against the ANSI-stripped output), once each. For
   * CLIs whose sign-in starts with a menu (Gemini's "How would you like to
   * authenticate?" → Enter = Sign in with Google).
   */
  loginAnswers?: Array<{ when: string; send: string }>;
  /** Where the CLI stores the credential, for the status line. */
  storesCredentialIn?: string;
}

export interface CoderCatalogEntry {
  id: CoderId;
  name: string;
  vendor: string;
  description: string;
  /** Monogram letter for the card badge. */
  monogram: string;
  /** Public UI path of a rasterized monogram, when one exists. */
  logo?: string;
  homepage: string;
  /** Binary the install puts on PATH. */
  bin: string;
  /** argv that prints the version (non-billable, no network). */
  versionArgs: string[];
  /** argv that reports sign-in state; exit 0 = signed in. */
  authStatusArgs?: string[];
  /**
   * For CLIs without a status command: credential files (under the home
   * directory, "~/" prefix) whose presence means signed in. An env var
   * override of the CLI's home dir is honoured via authHomeEnv.
   */
  authFiles?: string[];
  /** Env var that relocates the CLI's home dir (GROK_HOME → ~/.grok). */
  authHomeEnv?: { env: string; replaces: string };
  /** Install methods in priority order. */
  install: CoderInstallMethod[];
  auth: CoderAuthMethod[];
  /**
   * InfiniBot coder backend this CLI maps to (claude_coder / codex_coder /
   * opencode_coder / gemini / grok_coder), or null when it can only be used from a
   * terminal for now.
   */
  backend: CoderBackendId | null;
  /** Rough installed size, for the disk-quota check and the card. */
  approxSizeMb: number;
}

export const CODER_CATALOG: readonly CoderCatalogEntry[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    vendor: "Anthropic",
    description: "Anthropic's agentic coding CLI. Powers claude_coder sub-agents.",
    monogram: "C",
    logo: "/providers/mono-c.png",
    homepage: "https://docs.anthropic.com/en/docs/claude-code",
    bin: "claude",
    versionArgs: ["--version"],
    authStatusArgs: ["auth", "status"],
    install: [
      { kind: "npm", package: "@anthropic-ai/claude-code", version: "latest", needsScripts: true },
    ],
    auth: [
      {
        kind: "oauth-login",
        label: "Sign in with Claude",
        loginArgs: ["auth", "login"],
        acceptsCode: true,
        storesCredentialIn: "~/.claude",
      },
      { kind: "api-key", label: "Anthropic API key", envVars: ["ANTHROPIC_API_KEY"] },
    ],
    backend: "claude-code",
    approxSizeMb: 240,
  },
  {
    id: "codex",
    name: "Codex CLI",
    vendor: "OpenAI",
    description: "OpenAI's coding agent for the terminal. Powers codex_coder sub-agents.",
    monogram: "X",
    logo: "/providers/mono-x.png",
    homepage: "https://github.com/openai/codex",
    bin: "codex",
    versionArgs: ["--version"],
    authStatusArgs: ["login", "status"],
    install: [{ kind: "npm", package: "@openai/codex", version: "latest", needsScripts: false }],
    auth: [
      {
        kind: "oauth-login",
        label: "Sign in with ChatGPT (device code)",
        loginArgs: ["login", "--device-auth"],
        storesCredentialIn: "~/.codex/auth.json",
      },
      { kind: "api-key", label: "OpenAI API key", envVars: ["OPENAI_API_KEY", "CODEX_API_KEY"] },
    ],
    backend: "codex",
    approxSizeMb: 430,
  },
  {
    id: "opencode",
    name: "OpenCode",
    vendor: "SST",
    description: "Open-source, provider-agnostic coding agent. Powers opencode_coder sub-agents.",
    monogram: "O",
    logo: "/providers/mono-o.png",
    homepage: "https://opencode.ai",
    bin: "opencode",
    versionArgs: ["--version"],
    install: [{ kind: "npm", package: "opencode-ai", version: "latest", needsScripts: true }],
    auth: [
      {
        kind: "api-key",
        label: "Provider API key",
        envVars: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY"],
      },
    ],
    authFiles: ["~/.local/share/opencode/auth.json"],
    backend: "opencode",
    approxSizeMb: 360,
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    vendor: "Google",
    description: "Google's open-source Gemini agent for the terminal.",
    monogram: "G",
    logo: "/providers/mono-g.png",
    homepage: "https://github.com/google-gemini/gemini-cli",
    bin: "gemini",
    versionArgs: ["--version"],
    install: [
      { kind: "npm", package: "@google/gemini-cli", version: "latest", needsScripts: false },
    ],
    auth: [
      {
        // No login subcommand. Gemini CLI ≥0.6x refuses manual sign-in in a
        // headless `-p` run ("Manual authorization is required but the current
        // session is non-interactive", exit 55), so this starts the
        // interactive CLI: Enter on its auth menu picks "Sign in with Google",
        // and NO_BROWSER makes it print the Google URL and ask for the code.
        // It keeps running after sign-in; login.ts finishes the session when
        // ~/.gemini/oauth_creds.json appears.
        kind: "oauth-login",
        label: "Sign in with Google",
        loginArgs: ["--skip-trust"],
        loginEnv: {
          GOOGLE_GENAI_USE_GCA: "true",
          NO_BROWSER: "true",
          GEMINI_CLI_TRUST_WORKSPACE: "true",
        },
        loginAnswers: [{ when: "How would you like to authenticate", send: "\r" }],
        acceptsCode: true,
        storesCredentialIn: "~/.gemini/oauth_creds.json",
      },
      { kind: "api-key", label: "Gemini API key", envVars: ["GEMINI_API_KEY"] },
    ],
    authFiles: ["~/.gemini/oauth_creds.json"],
    backend: "gemini",
    approxSizeMb: 120,
  },
  {
    id: "grok-build",
    name: "Grok Build",
    vendor: "xAI",
    description:
      "xAI's coding agent CLI. Powers grok_coder sub-agents and signs in with your SuperGrok or X Premium+ account, so Grok subscribers can run InfiniBot without an API key.",
    monogram: "G",
    homepage: "https://github.com/xai-org/grok-build",
    bin: "grok",
    versionArgs: ["--version"],
    install: [
      {
        kind: "binary",
        channelUrl: "https://x.ai/cli/stable",
        artifactUrl: "https://x.ai/cli/grok-{version}-{platform}",
        fallbackBaseUrls: ["https://storage.googleapis.com/grok-build-public-artifacts/cli"],
        platforms: {
          "linux-x64": "linux-x86_64",
          "linux-arm64": "linux-aarch64",
          "darwin-x64": "macos-x86_64",
          "darwin-arm64": "macos-aarch64",
          // Windows artifacts carry .exe: grok-<v>-windows-<arch>.exe (install.ps1).
          "win32-x64": "windows-x86_64.exe",
          "win32-arm64": "windows-aarch64.exe",
        },
      },
      {
        kind: "manual",
        url: "https://github.com/xai-org/grok-build",
        reason:
          "Grok Build has no one-click install for this system yet. Use the installer on its page.",
      },
    ],
    auth: [
      {
        kind: "oauth-login",
        label: "Sign in with Grok (device code)",
        loginArgs: ["login", "--device-auth"],
        storesCredentialIn: "~/.grok/auth.json",
      },
      { kind: "api-key", label: "xAI API key", envVars: ["XAI_API_KEY"] },
    ],
    authFiles: ["~/.grok/auth.json"],
    authHomeEnv: { env: "GROK_HOME", replaces: "~/.grok" },
    backend: "grok",
    approxSizeMb: 190,
  },
  {
    id: "qwen-code",
    name: "Qwen Code",
    vendor: "Alibaba Qwen",
    description: "Coding agent tuned for Qwen3-Coder; speaks any OpenAI-compatible API.",
    monogram: "Q",
    homepage: "https://github.com/QwenLM/qwen-code",
    bin: "qwen",
    versionArgs: ["--version"],
    install: [
      { kind: "npm", package: "@qwen-code/qwen-code", version: "latest", needsScripts: false },
    ],
    auth: [
      {
        kind: "api-key",
        label: "OpenAI-compatible / DashScope key",
        envVars: ["OPENAI_API_KEY", "DASHSCOPE_API_KEY"],
      },
    ],
    backend: null,
    approxSizeMb: 120,
  },
  {
    id: "amp",
    name: "Amp",
    vendor: "Sourcegraph",
    description: "Sourcegraph's agentic coding tool.",
    monogram: "A",
    homepage: "https://ampcode.com",
    bin: "amp",
    versionArgs: ["--version"],
    install: [{ kind: "npm", package: "@sourcegraph/amp", version: "latest", needsScripts: true }],
    auth: [{ kind: "api-key", label: "Amp API key", envVars: ["AMP_API_KEY"] }],
    backend: null,
    approxSizeMb: 150,
  },
  {
    id: "crush",
    name: "Crush",
    vendor: "Charm",
    description: "Charm's glamorous terminal coding agent; bring any provider key.",
    monogram: "R",
    homepage: "https://github.com/charmbracelet/crush",
    bin: "crush",
    versionArgs: ["--version"],
    install: [{ kind: "npm", package: "@charmland/crush", version: "latest", needsScripts: true }],
    auth: [
      {
        kind: "api-key",
        label: "Provider API key",
        envVars: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"],
      },
    ],
    backend: null,
    approxSizeMb: 60,
  },
  {
    id: "aider",
    name: "Aider",
    vendor: "Aider",
    description: "Git-native AI pair programmer (Python). Needs uv or pipx on the host.",
    monogram: "D",
    homepage: "https://aider.chat",
    bin: "aider",
    versionArgs: ["--version"],
    install: [
      { kind: "uv", package: "aider-chat" },
      { kind: "pipx", package: "aider-chat" },
    ],
    auth: [
      {
        kind: "api-key",
        label: "Provider API key",
        envVars: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"],
      },
    ],
    backend: null,
    approxSizeMb: 300,
  },
  {
    id: "goose",
    name: "Goose",
    vendor: "Block",
    description: "Block's open-source on-machine agent. Install from the vendor's release page.",
    monogram: "E",
    homepage: "https://block.github.io/goose",
    bin: "goose",
    versionArgs: ["--version"],
    install: [
      {
        kind: "manual",
        url: "https://block.github.io/goose/docs/getting-started/installation",
        reason: "Only ships a curl | bash installer without published checksums.",
      },
    ],
    auth: [],
    backend: null,
    approxSizeMb: 80,
  },
  {
    id: "cursor-cli",
    name: "Cursor CLI",
    vendor: "Anysphere",
    description: "Cursor's agent in the terminal. Install from the vendor's page.",
    monogram: "U",
    homepage: "https://cursor.com/cli",
    bin: "cursor-agent",
    versionArgs: ["--version"],
    install: [
      {
        kind: "manual",
        url: "https://cursor.com/cli",
        reason: "Only ships a curl | bash installer; sign-in is interactive.",
      },
    ],
    auth: [],
    backend: null,
    approxSizeMb: 100,
  },
];

const BY_ID = new Map<string, CoderCatalogEntry>(CODER_CATALOG.map((e) => [e.id, e]));

/** Look up a catalog entry. Anything not in the catalog is rejected. */
export function getCoderEntry(id: unknown): CoderCatalogEntry | undefined {
  return typeof id === "string" ? BY_ID.get(id) : undefined;
}

/** Map a coder backend id to its catalog entry (claude-code → claude-code, …). */
export function coderForBackend(backend: CoderBackendId): CoderCatalogEntry | undefined {
  return CODER_CATALOG.find((e) => e.backend === backend);
}

/** True when at least one install method can run without a human. */
export function isInstallable(entry: CoderCatalogEntry): boolean {
  return entry.install.some((m) => m.kind !== "manual");
}

/** Every env var name any coder's API-key auth may set. */
export function apiKeyEnvVars(entry: CoderCatalogEntry): string[] {
  return entry.auth.flatMap((a) => (a.kind === "api-key" ? (a.envVars ?? []) : []));
}
