---
summary: "Where InfiniBot loads environment variables, the precedence order, and a reference of every variable it reads"
read_when:
  - You need to know which env vars are loaded, and in what order
  - You are debugging missing API keys in the Gateway
  - You are documenting provider auth or deployment environments
  - You need to know what a specific environment variable does
---
# Environment variables

InfiniBot pulls environment variables from multiple sources. The rule is **never override existing values**.

## Precedence (highest → lowest)

1) **Process environment** (what the Gateway process already has from the parent shell/daemon).
2) **`.env` in the current working directory** (dotenv default; does not override).
3) **Global `.env`** at `~/.infinibot/.env` (aka `$INFINIBOT_STATE_DIR/.env`; does not override).
4) **Config `env` block** in `~/.infinibot/infinibot.json` (applied only if missing).
5) **Optional login-shell import** (`env.shellEnv.enabled` or `INFINIBOT_LOAD_SHELL_ENV=1`), applied only for missing expected keys.

If the config file is missing entirely, step 4 is skipped; shell import still runs if enabled.

## Config `env` block

Two equivalent ways to set inline env vars (both are non-overriding):

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: {
      GROQ_API_KEY: "gsk-..."
    }
  }
}
```

## Shell env import

`env.shellEnv` runs your login shell and imports only **missing** expected keys:

```json5
{
  env: {
    shellEnv: {
      enabled: true,
      timeoutMs: 15000
    }
  }
}
```

Env var equivalents:

- `INFINIBOT_LOAD_SHELL_ENV=1`
- `INFINIBOT_SHELL_ENV_TIMEOUT_MS=15000`

## Env var substitution in config

You can reference env vars directly in config string values using `${VAR_NAME}` syntax:

```json5
{
  models: {
    providers: {
      "vercel-gateway": {
        apiKey: "${VERCEL_GATEWAY_API_KEY}"
      }
    }
  }
}
```

See [Configuration: Env var substitution](/gateway/configuration#env-var-substitution-in-config) for full details.

## Variable reference

This is every environment variable read by the gateway and CLI source code
(`src/`). Most settings are better set in `~/.infinibot/infinibot.json`; use
environment variables for secrets, deployment overrides and development
switches.

- Flags accept `1` (and usually `true`) to turn on. Unset means off.
- API keys can usually also be stored as auth profiles through
  `infinibot onboard` instead of environment variables.
- Variables in **Set internally or test only** are set by InfiniBot itself for
  child processes or by the test harness. Don't set them by hand.
- Old `MOLTBOT_*` / `CLAWDBOT_*` names are listed under **Legacy names**. Use
  the `INFINIBOT_*` name instead.

When you add a new environment variable, add it to this page (see the
[agent contributor guide](/contributing/AGENTS-GUIDE)).

### Paths and profiles

| Variable | What it does | Default |
| --- | --- | --- |
| `INFINIBOT_AGENT_DIR` | Overrides the directory holding the default coding-agent's identity files (also honors legacy `PI_CODING_AGENT_DIR`). | `<state-dir>/agents/<default-agent-id>/agent` |
| `INFINIBOT_AGENT_WORKSPACE` | Overrides the workspace directory used by the oversight/reports collector. | `~/clawd` |
| `INFINIBOT_AUTH_FILE` | Overrides the path to the local Kingly Vault CLI auth-token bundle (chmod 600). | `~/.infinibot/auth.json` |
| `INFINIBOT_BUNDLED_HOOKS_DIR` | Overrides where bundled hook definitions are loaded from (for `bun --compile` or npm installs). | resolved relative to the executable/module (sibling `hooks/bundled`) |
| `INFINIBOT_BUNDLED_PLUGINS_DIR` | Overrides where bundled plugins (`extensions/`) are loaded from. | resolved relative to the executable/module |
| `INFINIBOT_BUNDLED_SKILLS_DIR` | Overrides where bundled skills are loaded from. | resolved relative to the executable/module |
| `INFINIBOT_BUNDLED_VERSION` | Injects the version string reported by the app (used by compiled/embedded builds). | falls back to `package.json` version, then `0.0.0` |
| `INFINIBOT_CANONICAL_DIR` | Canonical state directory used by the `reconcile-split-stores` maintenance script when merging a legacy store into the current one. | `<repo>/state` |
| `INFINIBOT_CHARACTERS_DIR` | Overrides where the storyboard pipeline looks for the character-manager store. | `<INFINIBOT_STATE_DIR>/characters`, else `~/.infinibot/characters` |
| `INFINIBOT_CLAUDE_BRIDGE_CWD` | Working directory used when the Telegram/chat "claude" bridge command shells out. | current process cwd |
| `INFINIBOT_CLI_NAME` | Overrides the CLI's display/binary name (used in help text and argv parsing). | `infinibot` |
| `INFINIBOT_CLI_PATH` | Overrides the CLI binary path advertised via Bonjour/mDNS discovery. | auto-detected from `process.execPath` |
| `INFINIBOT_CONFIG_PATH` | Overrides the path to the main JSON5 config file; also isolated per named profile. | `<shared-state-dir>/infinibot.json` |
| `INFINIBOT_FILES_ROOT` | Overrides the per-user "files" root used by the file-serving gateway methods. | `<state-dir>/files` |
| `INFINIBOT_GIT_DIR` | Overrides the local git checkout directory the CLI self-update flow operates on. | unset (resolved internally) |
| `INFINIBOT_LEGACY_DIR` | Legacy state directory read (read-only) by the same reconcile script. | `~/.infinibot` |
| `INFINIBOT_MEDIA_ROOT` | Overrides the root directory for generated video compositions/renders. | `~/.infinibot/media` |
| `INFINIBOT_MOBILE_DIR` | Overrides the Expo mobile project directory (same purpose as `EXPO_PROJECT_DIR`, which is checked first). | bundled `mobile/` dir shipped with the package (in-repo checkout or `node_modules/infinibot/mobile`) |
| `INFINIBOT_MOBILE_EXPO_DIR` | Overrides the Expo project directory specifically for the dashboard's mobile-preview discovery. | falls back to the same auto-discovery as `INFINIBOT_MOBILE_DIR` |
| `INFINIBOT_NIX_MODE` | Set to `1` to indicate the gateway runs under Nix — disables auto-install flows and produces Nix-specific error messages instead. | off |
| `INFINIBOT_OAUTH_DIR` | Overrides the directory that stores shared OAuth credentials (`oauth.json`). | `<shared state dir>/credentials` |
| `INFINIBOT_PROFILE` | Names an alternate gateway profile, which changes the derived service/launch-agent names (systemd unit, launchd label, Windows task) so multiple gateway instances can coexist. | `default` (unnamed profile) |
| `INFINIBOT_REPO_ROOT` | Pins the working directory used for shell/tool execution (voice `claude_coder`/`exec` spawns) so it doesn't depend on wherever the gateway process happened to start. | auto-detected by walking up from the compiled module for a matching `package.json`, else `process.cwd()` |
| `INFINIBOT_ROOT` | Overrides the base "repo-like" root used to derive `state/` paths for the vault store, community landing pages, and knowledge-profile probes. | derived from `INFINIBOT_STATE_DIR` (strips trailing `/state`), else `process.cwd()` |
| `INFINIBOT_STATE_DIR` | Overrides the root data directory (settings, databases, credentials, logs). | `~/.infinibot` |
| `INFINIBOT_STORYBOARD_HELPER_CWD` | Overrides the working directory for spawned storyboard image-generation helper processes. | same as `INFINIBOT_STORYBOARD_OUTPUT_DIR` |
| `INFINIBOT_STORYBOARD_OUTPUT_DIR` | Overrides where generated storyboard images are written (useful for shared volumes). | `<state dir>/storyboard-generated` |
| `INFINIBOT_TTS_PREFS` | Overrides the path to the user TTS preferences JSON file. | `<CONFIG_DIR>/settings/tts.json` |

### Gateway and networking

| Variable | What it does | Default |
| --- | --- | --- |
| `INFINIBOT_ALLOW_MULTI_GATEWAY` | Set to `1` to bypass the single-gateway-instance lock, e.g. to run a second gateway; also force-sets `INFINIBOT_SKIP_CHANNELS=1` so the secondary instance doesn't hijack shared channel pollers (Telegram, etc.) unless explicitly overridden. | unset (lock enforced) |
| `INFINIBOT_DISABLE_AUTH` | Set to a truthy value to skip the Kingly Vault CLI auth check on startup. | unset (auth enforced) |
| `INFINIBOT_DISABLE_BONJOUR` | Set to `1`/truthy to disable Bonjour/mDNS gateway discovery advertising. | unset (Bonjour enabled) |
| `INFINIBOT_GATEWAY_AUTH_MODE` | Runtime override for the gateway auth mode. Valid values: `token` or `password`. | derived from config (`password` if a password is configured, else `token`) |
| `INFINIBOT_GATEWAY_BIND` | Sets the network bind mode for the gateway daemon. Valid values: `loopback`, `lan`, `tailnet`, `auto`, `custom`. | `loopback` |
| `INFINIBOT_GATEWAY_PASSWORD` | Supplies/overrides the gateway auth password (wins over the value stored in config). | unset |
| `INFINIBOT_GATEWAY_PORT` | Overrides the TCP port the gateway listens on. | `18789` (`19001` under the `dev` profile) |
| `INFINIBOT_GATEWAY_TOKEN` | Supplies/overrides the gateway auth token (wins over the value stored in config). | unset |
| `INFINIBOT_GATEWAY_UPGRADE_DEBUG` | Set to `1` to enable verbose logging of WebSocket upgrade handling to a debug log file (Windows-only diagnostic path). | unset (disabled) |
| `INFINIBOT_MCP_CONFIG` | Path to a Claude Code MCP config file passed to the `claude` CLI when generating the CEO-hourly report with MCP tools enabled. | unset (MCP wiring skipped) |
| `INFINIBOT_MCP_PORT` | Port for the standalone MCP bridge (Kanban/Projects). | `8889` |
| `INFINIBOT_NODE_EXEC_FALLBACK` | Set to `0` to disable falling back to a local exec path when the enforced Node-host app isn't available. | fallback allowed |
| `INFINIBOT_NODE_EXEC_HOST` | Set to `app` to require Node-host command execution to run inside the desktop app process (enforced exec host). | not enforced |
| `INFINIBOT_NODE_ID` | Identifies this node in the multi-node services manager / services lifecycle RPC. | `"local"` |
| `INFINIBOT_SESSION_KEY` | Session key attached to a spawned terminal/PTY's environment for activity attribution; also read as a fallback session key by the MCP stdio server. | none (unset unless a terminal is created with a session key) |
| `INFINIBOT_SOVEREIGN_MEMORY_URL` | Overrides the base URL of the sovereign-memory service used by the knowledge-profile runtime. | `http://localhost:3014/api` |
| `INFINIBOT_SSH_PORT` | Advertises a specific SSH port via Bonjour/mDNS discovery. | none advertised |
| `INFINIBOT_TAILNET_DNS` | Overrides the detected Tailscale MagicDNS hostname used for discovery/advertising instead of auto-resolving via the `tailscale` CLI. | auto-detected |
| `INFINIBOT_TOKEN` | Bearer token used to authenticate a client against the gateway/Vault instead of the stored credential. | unset |
| `INFINIBOT_VAULT_URL` | Overrides the base URL of the Kingly Vault auth service. | `https://kinglyvault.com` |

### Startup switches

| Variable | What it does | Default |
| --- | --- | --- |
| `INFINIBOT_DISABLE_CONFIG_CACHE` | Set (any non-empty value) to disable the in-memory config-file read cache. | unset (cache enabled, ~200ms TTL) |
| `INFINIBOT_DISABLE_LAZY_SUBCOMMANDS` | Set truthy to force eager registration of all CLI subcommands instead of lazy/primary-only registration. | unset (lazy registration) |
| `INFINIBOT_DISABLE_NOTION_PULL` | Set to `1` to disable the Notion bidirectional-sync pull side (push-only). | unset (pull enabled) |
| `INFINIBOT_DISABLE_PLUGIN_MANIFEST_CACHE` | Set (any non-empty value) to disable caching of plugin manifest scans. | unset (cache enabled) |
| `INFINIBOT_DISABLE_ROUTE_FIRST` | Set truthy to skip the CLI's fast "route-first" command dispatch path. | unset (route-first enabled) |
| `INFINIBOT_EAGER_CHANNEL_OPTIONS` | Set truthy to eagerly load the full plugin registry so channel plugin IDs are included in CLI channel option lists (otherwise only built-in channels are listed). | unset (lazy, built-ins only) |
| `INFINIBOT_GOALS_DISABLE` | Set to `1` to prevent the autonomy goal runner from starting. | unset (goal runner starts) |
| `INFINIBOT_HIDE_BANNER` | Set truthy to suppress the CLI startup banner. | unset (banner shown) |
| `INFINIBOT_KOKORO_AUTOSTART` | Set to `0`/`false`/`no` to prevent auto-starting the local Kokoro TTS service when the `kokoro` provider is selected. | unset (autostart enabled) |
| `INFINIBOT_NATIVE_BROWSER_TOOL` | Set to `off` to disable the built-in Playwright browser tool (e.g. when routing browser automation through an external MCP browser server instead). | `on` |
| `INFINIBOT_NO_OPEN` | Set to `1` to prevent the Control UI from auto-opening a browser tab on startup. | opens a browser tab |
| `INFINIBOT_OLLAMA_AUTOSTART` | Set to `0`, `false`, or `no` to disable auto-starting a local Ollama instance when it isn't already running. | autostart enabled |
| `INFINIBOT_SKIP_AUTO_UPDATE` | Set to disable the automatic update check/flow on gateway startup. | auto-update check runs |
| `INFINIBOT_SKIP_BROWSER_CONTROL_SERVER` | Set to skip starting the browser control server. | starts |
| `INFINIBOT_SKIP_CANVAS_HOST` | Set to skip starting the canvas host server. | starts |
| `INFINIBOT_SKIP_CHANNELS` | Set to skip starting messaging channels (Telegram, etc.) — used to prevent a secondary/multi gateway instance from hijacking the shared bot. | channels start |
| `INFINIBOT_SKIP_CLAUDE_CODE_REGISTER` | Set to skip auto-registering this gateway with Claude Code's MCP config on startup. | registers automatically |
| `INFINIBOT_SKIP_CLAUDE_CODE_WATCHER` | Set to `1` to disable the watcher for `~/.claude/` config changes. | watcher runs |
| `INFINIBOT_SKIP_CRON` | Set to `1` to disable the cron scheduler on startup. | cron enabled (if configured) |
| `INFINIBOT_SKIP_EMAIL_INBOUND` | Set to skip starting the inbound email watcher. | inbound email starts |
| `INFINIBOT_SKIP_GMAIL_WATCHER` | Set to `1` to skip starting the Gmail watcher (e.g. when another process already runs one). | Gmail watcher starts |
| `INFINIBOT_SKIP_MCP_CLIENTS` | Set to skip connecting to configured external MCP clients on startup. | MCP clients connect |
| `INFINIBOT_SKIP_MCP` | Set to skip starting the standalone MCP bridge on gateway startup. | MCP bridge starts |
| `INFINIBOT_SKIP_PROVIDERS` | Legacy alias for `INFINIBOT_SKIP_CHANNELS`; skips channel reload/start when set. | channels start |
| `INFINIBOT_SKIP_TUNNEL` | Set to skip starting the configured network tunnel even if enabled in config. | tunnel starts if configured |
| `INFINIBOT_VOICE_PREWARM` | Set to `1` to eagerly initialize the native Kokoro TTS engine at voice-mode startup instead of lazily on first use. | lazy load (no prewarm) |

### Shell environment loading

| Variable | What it does | Default |
| --- | --- | --- |
| `INFINIBOT_DEFER_SHELL_ENV_FALLBACK` | Set to a truthy value to defer the shell-env fallback lookup instead of running it eagerly at startup. | unset (disabled) |
| `INFINIBOT_LOAD_SHELL_ENV` | Set to a truthy value to enable falling back to the user's login-shell environment for missing expected env vars. | unset (disabled) |

### Model provider API keys

Note: for most of these, keys can also come from a stored auth profile / auth-choice flow (see `src/agents/model-auth.ts`, `src/agents/auth-profiles/env-export.ts`) rather than only the raw env var — the env var is the fallback source when no profile credential is saved.

| Variable | Provider |
| --- | --- |
| `AI_GATEWAY_API_KEY` | Vercel AI Gateway |
| `ANTHROPIC_API_KEY` | Anthropic (Claude) |
| `ANTHROPIC_AUTH_TOKEN` | Anthropic OAuth-style auth token (used by Claude Code CLI login) |
| `ANTHROPIC_OAUTH_TOKEN` | Anthropic OAuth token (Claude Code / Claude.ai login) |
| `CEREBRAS_API_KEY` | Cerebras |
| `CHUTES_API_KEY` | Chutes AI |
| `CHUTES_OAUTH_TOKEN` | Chutes AI (OAuth-issued token, preferred over CHUTES_API_KEY) |
| `COHERE_API_KEY` | Cohere |
| `COPILOT_GITHUB_TOKEN` | GitHub Copilot models (falls back to GH_TOKEN / GITHUB_TOKEN) |
| `DEEPSEEK_API_KEY` | DeepSeek |
| `FIREWORKS_API_KEY` | Fireworks AI |
| `GEMINI_API_KEY` | Google Gemini |
| `GH_TOKEN` | GitHub (alias fallback, checked before GITHUB_TOKEN) |
| `GITHUB_TOKEN` | GitHub (Copilot models fallback + integration auth) |
| `GOOGLE_API_KEY` | Google (Gemini / embeddings, interchangeable with GEMINI_API_KEY) |
| `GROQ_API_KEY` | Groq |
| `KIMICODE_API_KEY` | Kimi Code |
| `LLAMACLOUD_API_KEY` | LlamaCloud |
| `MINIMAX_API_KEY` | MiniMax |
| `MINIMAX_CODE_PLAN_KEY` | MiniMax (Code Plan variant, checked before MINIMAX_API_KEY) |
| `MISTRAL_API_KEY` | Mistral AI |
| `MOONSHOT_API_KEY` | Moonshot AI |
| `OLLAMA_API_KEY` | Ollama (local server, optional auth) |
| `OLLAMA_CLOUD_API_KEY` | Ollama Cloud (Turbo, hosted) |
| `OPENAI_API_KEY` | OpenAI |
| `OPENCODE_API_KEY` | OpenCode Zen |
| `OPENCODE_ZEN_API_KEY` | OpenCode Zen (fallback if OPENCODE_API_KEY unset) |
| `OPENROUTER_API_KEY` | OpenRouter |
| `QWEN_OAUTH_TOKEN` | Qwen Portal (OAuth token, preferred) |
| `QWEN_PORTAL_API_KEY` | Qwen Portal (fallback if no OAuth token) |
| `REPLICATE_API_TOKEN` | Replicate |
| `SYNTHETIC_API_KEY` | Synthetic |
| `TOGETHER_API_KEY` | Together AI |
| `VENICE_API_KEY` | Venice AI |
| `VITE_OPENROUTER_API_KEY` | OpenRouter (checked before OPENROUTER_API_KEY, for Vite dev-server HMR flows) |
| `XAI_API_KEY` | xAI (Grok) |
| `Z_AI_API_KEY` | Z.ai / GLM (alias, copied into ZAI_API_KEY if that's unset) |
| `ZAI_API_KEY` | Z.ai / GLM |

### Provider OAuth apps, base URLs and model overrides

| Variable | What it does | Default |
| --- | --- | --- |
| `AWS_DEFAULT_REGION` | Fallback for AWS_REGION | `us-east-1` |
| `AWS_REGION` | AWS region for Bedrock-style provider discovery | `us-east-1` |
| `CANVA_OAUTH_CLIENT_ID` | Canva integration OAuth client ID | unset (Canva sign-in disabled until set) |
| `CANVA_OAUTH_CLIENT_SECRET` | Canva integration OAuth client secret | unset |
| `CANVA_OAUTH_REDIRECT_URI` | Canva OAuth callback URL | `http://127.0.0.1:<port>/<callback-route>` (loopback, port depends on local OAuth server) |
| `CANVA_OAUTH_SCOPES` | Space-separated Canva OAuth scopes requested | built-in default scope list |
| `CHUTES_CLIENT_ID` | OAuth client ID for the Chutes login/refresh flow | unset (falls back to a built-in default if not provided; refresh fails without one) |
| `CHUTES_CLIENT_SECRET` | OAuth client secret for Chutes login/refresh | unset (optional, only required if Chutes requires it) |
| `CHUTES_OAUTH_REDIRECT_URI` | Redirect URI used during the Chutes OAuth flow | `http://127.0.0.1:1456/oauth-callback` |
| `CHUTES_OAUTH_SCOPES` | Space-separated OAuth scopes requested from Chutes | `openid profile chutes:invoke` |
| `MINIMAX_API_HOST` | Overrides the MiniMax API host | `https://api.minimax.io` |
| `OLLAMA_HOST` | Base URL for a local Ollama server | `http://127.0.0.1:11434` in most call sites; two call sites (social-media AI insights, an ollama-monitor status route) hard-code a LAN address, so set `OLLAMA_HOST` explicitly |
| `OLLAMA_URL` | Base URL for Ollama used by the vision tool / notes OCR fallback | `http://127.0.0.1:11434` |
| `OPENAI_TTS_BASE_URL` | Base URL for OpenAI-compatible TTS (lets you point at a local server, e.g. Kokoro) | `https://api.openai.com/v1` |

### Agents and coding-agent backends

| Variable | What it does | Default |
| --- | --- | --- |
| `INFINIBOT_AUTONOMY_FORCE_API` | Set to `1` to force the autonomy goal orchestrator to use the SDK/API planner path instead of preferring an installed CLI backend. | unset (CLI preferred when available) |
| `INFINIBOT_CLAUDE_CLI_LOG_OUTPUT` | Set to `1` to log raw Claude CLI subprocess output (also set automatically by the `--claude-cli-logs` CLI flag). | unset (not logged) |
| `INFINIBOT_CODER_BIN` | Windows-only: extra directory to search for coder CLI shims (claude/codex/opencode `.cmd` files). | `C:\node22` |
| `INFINIBOT_DEFAULT_MODEL` | Overrides the system default model reference (`provider/model`) used when no primary model is configured. | unset (falls back to a running local Ollama, then a built-in fallback) |
| `INFINIBOT_DEFAULT_PROVIDER` | Hints the default model provider (e.g. to skip preferring local Ollama). | unset |
| `INFINIBOT_DURABLE_SUBAGENTS` | Set to `0` to force the legacy (non-durable) subagent spawn path instead of the tmux-backed durable spawn (non-Windows only). | unset (durable spawn used where available) |
| `INFINIBOT_GOALS_TICK_MS` | Poll interval, in milliseconds, for the autonomy goal runner loop. | `5000` |
| `INFINIBOT_LIVE_ANTHROPIC_KEY` | Forces a single specific Anthropic API key for the "war-room" live-verification/orchestrator features, overriding any other key sources. | unset |
| `INFINIBOT_LIVE_ANTHROPIC_KEYS` | Supplies a list (comma/space/semicolon separated) of Anthropic API keys to rotate through for the same live-verification features. | unset |
| `ANTHROPIC_ADMIN_API_KEY` | Anthropic admin/org key used only to check whether cost-sync credentials are configured | unset ("missing-credentials" if absent) |
| `ANTHROPIC_API_KEY_OLD` | Explicitly deleted from the child-process env before launching Claude Code / verifier / skill-system, to avoid a stale key overriding OAuth login | n/a (always stripped, never read) |
| `ANTHROPIC_AUTONOMY_MODEL` | Model used by the autonomy "prefire form" agent | `claude-sonnet-4-5` |
| `ANTHROPIC_GOAL_JUDGE_MODEL` | Cheap model used to judge whether a goal run succeeded | `claude-haiku-4-5` |
| `ANTHROPIC_GOAL_ORCHESTRATOR_MODEL` | Model used when the goal orchestrator backend is Anthropic/Claude | `claude-sonnet-4-6` |
| `ANTHROPIC_SCRIPT_AGENT_MODEL` | Model for the standalone script-writing agent | falls through to ANTHROPIC_SCRIPT_MODEL, then a built-in default |
| `ANTHROPIC_SCRIPT_MODEL` | Model used for video/script generation via Anthropic | `claude-sonnet-4-6` |
| `ANTHROPIC_VISION_MODEL` | Anthropic model used for image/video asset analysis | `claude-sonnet-4-6` |
| `CLAUDE_AI_SESSION_KEY` | Session key used to fetch Claude.ai web usage/credits | unset |
| `CLAUDE_VIDEO_BIN` | Path to a `bradautomates/claude-video` checkout, used to shell out for video transcription instead of Anthropic vision | unset (falls back to Anthropic vision analysis) |
| `CLAUDE_WEB_COOKIE` | Raw cookie header used to fetch Claude.ai web usage | unset |
| `CLAUDE_WEB_SESSION_KEY` | Alias/fallback for CLAUDE_AI_SESSION_KEY | unset |
| `CODEX_GOAL_ORCHESTRATOR_MODEL` | Model used when the goal orchestrator backend is Codex | `gpt-5-codex` |
| `CODEX_HOME` | Overrides the Codex CLI config directory | `~/.codex` |
| `FALLBACK_MODEL` | Fallback model for the content-intelligence scoring pipeline when the primary fails | `meta-llama/llama-3.3-70b-instruct` |
| `GATEWAY_AGENT_GOAL_ORCHESTRATOR_MODEL` | Model used when the goal orchestrator runs as a gateway agent | `claude-sonnet-4-6` |
| `GEMINI_DIR` | Overrides the Gemini CLI config directory | `~/.gemini` |
| `GOOGLE_CLOUD_BILLING_KEY` | Google Cloud billing key, same "configured" check for cost sync | unset |
| `LOCAL_VISION_MODEL` | Local (Ollama) vision model used for image/notes analysis | `minicpm-v:8b` (notes OCR path falls back to `llava:7b`) |
| `NOTES_OCR_MODEL` | Anthropic model used for OCR on scanned notes | `claude-sonnet-4-20250514` |
| OLLAMA_CLOUD_API_KEY (credits check) | Reused to report Ollama Cloud credentials as configured in the credits sync status | unset |
| `OPENAI_ADMIN_KEY` | OpenAI admin/org key, same "configured" check for cost sync | unset |
| `OPENCODE_CONFIG_CONTENT` | JSON MCP-server config injected into OpenCode's env (no temp file needed) | unset / empty config |
| `OPENCODE_FIRST_OUTPUT_TIMEOUT_MS` | Watchdog timeout for OpenCode producing its first stdout/stderr chunk; `0` disables it | `60000` (60s) |
| `OPENCODE_GOAL_ORCHESTRATOR_MODEL` | Model used when the goal orchestrator backend is OpenCode | `claude-sonnet-4-6` |
| OPENCODE_ZEN_API_KEY (credits check) | Reused to report OpenCode Zen credentials as configured in the credits sync status | unset |
| `OPENROUTER_SCRIPT_MODEL` | Model used for script generation when routed through OpenRouter | `meta-llama/llama-3.1-70b-instruct` |
| `PRIMARY_MODEL` | Primary model for the content-intelligence scoring pipeline | `deepseek/deepseek-chat-v3-0324` |

### Messaging channels

| Variable | Provider |
| --- | --- |
| `DISCORD_BOT_TOKEN` | Discord bot (default account) |
| `INSTAGRAM_ACCESS_TOKEN` | Instagram Graph API access token |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Messaging API channel access token (default account) |
| `SLACK_APP_TOKEN` | Slack app-level token (Socket Mode, paired with SLACK_BOT_TOKEN) |
| `SLACK_BOT_TOKEN` | Slack bot token (default account) |
| `SLACK_USER_TOKEN` | Slack user token, used only to auto-detect/auto-enable the Slack plugin |
| `TELEGRAM_BOT_TOKEN` | Telegram bot (default account, used when no per-account token is configured) |
| `VAULT_DISCORD_TOKEN` | Discord bot token used by the Vault rule engine (fallback alias of DISCORD_BOT_TOKEN) |

### Voice, image and video

| Variable | What it does | Default |
| --- | --- | --- |
| `INFINIBOT_ATTACHMENT_MAX_BYTES` | Maximum accepted size, in bytes, for uploaded/converted file attachments. | `52428800` (50 MB) |
| `INFINIBOT_BROWSER_CONTROL_MODULE` | Overrides the module path used to start the embedded browser-control service (for swapping in an alternate implementation). | `../browser/control-service.js` |
| `INFINIBOT_FH12_CONDUCTOR` | Set to `1`/`true` to enable the "FH 1.2 Build Conductor" autonomous build loop (also settable via `conductor.fh12.enabled` in config). Off by default so it never reads, spawns, or messages anything. | unset (disabled) |
| `INFINIBOT_IG_SYNC_INTERVAL_MS` | Interval, in milliseconds, between background Instagram stats sync runs. | every 6 hours |
| `INFINIBOT_IMAGE_BACKEND` | Selects the image-processing backend. Valid values: `sips` or `sharp`. | `sips` on Bun+macOS, otherwise `sharp` |
| `INFINIBOT_TRENDS_ALERTS` | Set to `"0"` to disable proactive trend/news-spike pop-up alerts. | enabled (gated by per-niche cooldown) |
| `INFINIBOT_VOICE_PACK_BASE` | Overrides the CDN base URL used to download optional local voice packs (Kokoro/Whisper/Piper). | `https://cdn.infinibot.app/voice-packs/` |
| `INFINIBOT_WHISPER_WIN_ASSET` | Overrides the release asset filename fetched for the Windows whisper.cpp build. | `whisper-bin-x64.zip` |
| `INFINIBOT_WHISPER_WIN_URL` | Overrides the full download URL for the Windows whisper.cpp binary (pinning/air-gapped mirrors). | built from the GitHub releases URL using the version/asset above |
| `INFINIBOT_WHISPER_WIN_VERSION` | Overrides the whisper.cpp release tag used to fetch the prebuilt Windows binary. | `v1.7.4` |
| `CARTESIA_API_KEY` | Cartesia TTS/voice provider key | unset |
| `COMFY_URL` | Base URL of the local ComfyUI server used for image/storyboard generation | `http://127.0.0.1:8000` |
| `DEEPGRAM_API_KEY` | Deepgram STT provider key | unset |
| `ELEVENLABS_API_KEY` | ElevenLabs TTS provider key | unset |
| `KOKORO_API_URL` | Base URL of the Kokoro TTS server | `http://localhost:8882` |
| `KOKORO_URL` | Base URL of the Kokoro TTS server (voice-connection/config resolver path) | `http://localhost:8882` |
| `LIVEKIT_API_KEY` | LiveKit API key for minting room access tokens | a public development placeholder. **Always set it.** |
| `LIVEKIT_API_SECRET` | LiveKit API secret for minting room access tokens | a public development placeholder. **Always set it.** |
| `LIVEKIT_URL` | LiveKit server WebSocket URL used for voice calls | `ws://localhost:7882` |
| `LIVEKIT_URL_EXTERNAL` | Externally-reachable LiveKit URL handed to browser clients (wins over LIVEKIT_URL when set) | falls back to the resolved LIVEKIT_URL |
| `LOCAL_COMFY_URL` | Fallback for COMFY_URL (Klein/FLUX2 generator path) | `http://127.0.0.1:8000` |
| `ROBOVOICE_URL` | Base URL of the Robovoice backend the gateway proxies voice calls to | `http://localhost:3001` |
| `SHERPA_ONNX_MODEL_DIR` | Directory containing sherpa-onnx offline model files (tokens/encoder/decoder/joiner .onnx) | unset (sherpa-onnx STT backend is skipped entirely if not set) |
| `SPEACHES_MODEL` | STT model name served by the local Speaches/faster-whisper server | `deepdml/faster-whisper-large-v3-turbo-ct2` |
| `TTS_VOICE` | Default Kokoro voice id used by the gateway voice config | `bm_george` |
| `WHISPER_CPP_MODEL` | Overrides which whisper.cpp GGML model to use for media transcription | unset (auto-selects a bundled model) |
| `WHISPER_MODEL` | STT model id for the gateway voice config (same Speaches-backed default) | `deepdml/faster-whisper-large-v3-turbo-ct2` |
| `XI_API_KEY` | ElevenLabs TTS provider key (alias, checked after ELEVENLABS_API_KEY) | unset |

### Autonomy

| Variable | What it does | Default |
| --- | --- | --- |
| `INFINIBOT_MAIN_AGENT_DIR` | Directory holding the main agent's `auth-profiles.json`; autonomy self-heal copies auth profiles from it to repair a broken auth store. | unset |
| `AUTONOMY_BLOCK_BACKOFF_MS` | Backoff delay before retrying a blocked autonomy queue item. | `120000` (2 min) |
| `AUTONOMY_GOAL_MAX_PARALLEL` | Max concurrent sub-agents spawned per autonomy goal run. | `4` |
| `AUTONOMY_GOAL_MAX_TOTAL_SUBAGENTS` | Max total sub-agents a single goal run may spawn over its lifetime. | `20` |
| `AUTONOMY_GOAL_MAX_TURN_WALLCLOCK_SEC` | Max wall-clock seconds allowed for one orchestrator turn before it's cut off. | `1800` (30 min) |
| `AUTONOMY_HEARTBEAT_DISABLED` | Set to `"1"` to disable the autonomy heartbeat loop entirely. | unset (heartbeat enabled) |
| `AUTONOMY_HEARTBEAT_MS` | Interval at which the autonomy manager polls its work queue. | `20000` (20s) |
| `AUTONOMY_PHASE_HEAL_RETRIES` | Max self-heal retry attempts per orchestrator phase before giving up. | `3` |
| `AUTONOMY_SEARCH_FALLBACK` | Internal flag the self-heal engine sets to `"1"` at runtime when no Brave Search key is available, so search routes to a fallback provider instead of failing. Not meant to be hand-set. | unset |
| `BRAVE_SEARCH_KEY` | Brave Search API key, read as a fallback if `BRAVE_API_KEY` / `BRAVE_SEARCH_API_KEY` aren't set; used by the autonomy self-heal engine to restore web search after a missing-key failure. | unset |
| `GATEWAY_AGENT_GOAL_ORCHESTRATOR_PROVIDER` | LLM provider used to run the autonomy goal orchestrator. | `anthropic` |

### Federation (code sync)

| Variable | What it does | Default |
| --- | --- | --- |
| `FEDERATION_GIT_BRANCH` | Git branch used for federation code-sync push/pull. | `main` |
| `FEDERATION_GIT_REMOTE` | Git remote name used for federation code-sync push/pull. | `origin` |
| `FEDERATION_NODE_ID` | Identifier for this node recorded in federation sync metadata. | unset |
| `FEDERATION_REPO_PATH` | Filesystem path of the git repo the federation code-sync operates on. | current working directory |
| `FEDERATION_ROLE` | Set to `"satellite"` to run this node as a federation satellite instead of the master/hub. | `master` |

### Integrations

| Variable | What it does | Default |
| --- | --- | --- |
| `ANDROID_OPS_FLY_CONFIG` | Explicit path to a `fly.toml` used to detect/deploy the Android Ops dashboard to Fly.io. | unset (searches project dirs for `fly.toml`; without one, the dashboard just runs locally) |
| `ANDROID_OPS_S3_ACCESS_KEY_ID` | Access key id for the S3-compatible storage adapter. | unset |
| `ANDROID_OPS_S3_BUCKET` | Bucket name for the S3-compatible storage adapter. | unset |
| `ANDROID_OPS_S3_ENDPOINT` | S3-compatible endpoint URL used when `ANDROID_OPS_STORAGE` selects a bucket backend. | unset |
| `ANDROID_OPS_S3_PUBLIC_BASE` | Public base URL used to build renderable links to objects in the bucket. | unset |
| `ANDROID_OPS_S3_REGION` | Region for the S3-compatible storage adapter. | `us-east-1` |
| `ANDROID_OPS_S3_SECRET_ACCESS_KEY` | Secret access key for the S3-compatible storage adapter. | unset |
| `ANDROID_OPS_STORAGE` | Selects the Android Ops media storage backend: `minio`, `s3`, or `r2`. Any other/unset value falls back to local-disk storage. | unset (local filesystem storage) |
| `CALENDAR_DEADLINE_ALERT_STAGES` | Comma-separated list of "hours before" stages at which project/phase deadline alerts fire. | `72,24` |
| `CALENDAR_MEETING_ALERT_STAGES` | Comma-separated list of "minutes before" stages at which upcoming-meeting alerts fire. | `15,1` |
| `CALENDAR_OVERDUE_ALERT_HOUR` | Local hour of day (0-23) at which the once-daily overdue-items digest fires. | `9` |
| `CALENDAR_TELEGRAM_CHAT_ID` | Telegram chat id calendar alerts are sent to when an alert doesn't specify its own target. | unset (alert send fails without it or an explicit target) |
| `CALENDLY_CLIENT_ID` | Calendly OAuth2 client id (multi-user auth mode). | unset |
| `CALENDLY_CLIENT_SECRET` | Calendly OAuth2 client secret (multi-user auth mode). | unset |
| `CALENDLY_PAT` | Calendly Personal Access Token (recommended, single-user auth mode); `CALENDLY_API_KEY` is an accepted alias. | unset |
| `CALENDLY_REDIRECT_URI` | OAuth2 callback URL for the Calendly integration. | `http://localhost/calendly/callback` |
| `CLOUDSDK_PYTHON` | Path to a Python interpreter for the Google Cloud SDK, set by the Gmail OAuth setup helper only if not already present in the environment. | unset (helper auto-detects a Python) |
| `CONTENT_INTEL_ACCOUNT` | Restricts the content-intelligence importer to a single social account handle. | `` (empty — imports all accounts) |
| `DISCORD_GUILD_ID` | Discord guild (server) id used by the Vault rule engine and Vault gateway config as a fallback source of guild id. | unset |
| `DISCORD_MOD_LOG_CHANNEL_ID` | Discord channel id the Vault gateway posts moderation-log messages to. | unset |
| `EMAIL_FROM` | Generic default "from" address for outgoing email, used when `RESEND_FROM` isn't set. | `no-reply@example.com` |
| `IMAP_HOST` | IMAP server host; when set, the inbox listener uses IMAP IDLE polling for inbound mail/reply detection. | unset (inbox listener is a no-op without it) |
| `IMAP_PASS` | IMAP account password. | unset |
| `IMAP_USER` | IMAP account username. | unset |
| `INSTAGRAM_APP_ID` | Instagram/Meta app id, read as a read-only fallback for pre-existing setups (current setups store this per-account instead). | unset |
| `INSTAGRAM_APP_SECRET` | Instagram/Meta app secret, same fallback role as `INSTAGRAM_APP_ID`. | unset |
| `LINE_CHANNEL_SECRET` | LINE messaging channel secret used to verify webhook signatures. | unset |
| `NOTION_PROJECTS_DB` | Notion database id for the Projects database, used by the Notion↔kanban config/migration. | unset |
| `NOTION_TASKS_DB` | Notion database id for the Tasks database, used by the Notion↔kanban config/migration. | unset |
| `OUTREACH_BASE_URL` | Public base URL the outreach workflow uses to build links (e.g. unsubscribe links). | `http://localhost:4040` |
| `OUTREACH_FROM_EMAIL` | Default "from" email address for the outreach provider. | `outreach@example.com` |
| `OUTREACH_FROM_NAME` | Default "from" display name for the outreach provider. | `Outreach` |
| `OUTREACH_PROVIDER` | Selects the outreach email provider: `resend` or `mock`. Falls back to `mock` with a warning if `resend` is chosen but `RESEND_API_KEY` is missing, or if the value is unrecognized. | `mock` |
| `REEL_PIPELINE_DIR` | Directory of an external reel-processing pipeline the content-intelligence importer reads manifests/transcripts/output from. | `` (empty — the reel-importer paths are disabled) |
| `RESEND_FROM` | Default "from" address for email sent via Resend. | falls back to `EMAIL_FROM`, then `no-reply@example.com` |
| `RESEND_WEBHOOK_SECRET` | Secret used to verify inbound Resend webhook signatures for reply detection. | unset (webhooks accepted unverified with a warning) |
| `SUPABASE_ANON_KEY` | Supabase anon key, read as a fallback for KinglyVault's Supabase store when `VAULT_SUPABASE_KEY` isn't set. | unset |
| `SUPABASE_PAT` | Supabase personal access token; also used as the auth-profile env var name exported to the Supabase MCP server when enabled. | unset |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role key used by KinglyVault's Supabase store for privileged shop operations. | unset |
| `SUPABASE_URL` | Supabase project URL, read as a fallback for KinglyVault's Supabase store when `VAULT_SUPABASE_URL` isn't set. | unset |
| `UNSUBSCRIBE_SECRET` | HMAC secret used to sign outreach unsubscribe links. | a built-in, publicly known value. **Set your own.** |
| `WHOP_COMPANY_ID` | Whop company id used to look up income/billing data when not saved in per-account settings. | unset |

| Variable | Provider |
| --- | --- |
| `APOLLO_API_KEY` | Apollo.io (contact/company enrichment) |
| `BRAVE_API_KEY` | Brave Search |
| `BRAVE_SEARCH_API_KEY` | Brave Search (secondary fallback alias in self-heal path) |
| `CALENDLY_API_KEY` | Calendly (alias for CALENDLY_PAT, personal access token) |
| `CURRENTS_API_KEY` | Currents News API (content research) |
| `FIRECRAWL_API_KEY` | Firecrawl (web fetch/scraping tool) |
| `FLY_ACCESS_TOKEN` | Fly.io (alias fallback if FLY_API_TOKEN unset) |
| `FLY_API_TOKEN` | Fly.io (Android-ops deploy) |
| `GOOGLE_PLACES_API_KEY` | Google Places (lead sourcing) |
| `HUNTER_API_KEY` | Hunter.io (email finder) |
| `LOOPS_API_KEY` | Loops (transactional/marketing email) |
| `MEDIASTACK_API_KEY` | Mediastack News API (content research) |
| `NEWSCATCHER_API_KEY` | Newscatcher News API (content research) |
| `NOTION_API_KEY` | Notion (databases sync) |
| `PERPLEXITY_API_KEY` | Perplexity (web_search tool) |
| `RESEND_API_KEY` | Resend (transactional email) |
| `SERP_API_KEY` | SerpAPI (Google Maps lead sourcing fallback) |
| `SQUARE_API_KEY` | Square (business income tracking) |
| `STRIPE_API_KEY` | Stripe (business income tracking) |
| `WHOP_API_KEY` | Whop (business income tracking) |
| `YOUTUBE_API_KEY` | YouTube Data API (content-intel) |

### Kingly Vault, licensing and hosted mode

| Variable | What it does | Default |
| --- | --- | --- |
| `CLERK_FRONTEND_API` | Clerk Frontend API hostname; derived from `CLERK_PUBLISHABLE_KEY` if not set explicitly. | derived from the publishable key |
| `CLERK_PUBLISHABLE_KEY` | Clerk publishable (frontend) API key for the SaaS auth layer. | unset |
| `CLERK_SECRET_KEY` | Clerk secret (backend) API key for the SaaS auth layer. | unset |
| `DATABASE_URL` | Generic Postgres connection string, used as a fallback if `NEON_DATABASE_URL` isn't set. | unset |
| `INFINIBOT_ENFORCE_CHAT_CAP` | Set to `1`/`true`/`yes`/`on` to enforce the hosted-product daily chat cap (self-hosted installs leave this off). | unset (no cap) |
| `INFINIBOT_FEATURE_OVERRIDE` | Comma-separated list of feature names to force-grant regardless of the actual license; for local debugging/tests only. | unset |
| `INFINIBOT_LICENSE_JWT` | The license entitlement token; set by the Electron main process into the gateway child process. | unset (no license) |
| `KINGLY_ADMIN_ID` | Same purpose as `KINGLY_VAULT_ADMIN_ID`, read as a fallback if that isn't set. | unset |
| `KINGLY_VAULT_ADMIN_ID` | Clerk user id of the admin profile that Vault shop admin RPCs are gated on (preferred var name). | unset |
| `LOCAL_PROVIDERS_ENABLED` | Whether on-device providers (Ollama, native Kokoro/Whisper voice, wake-word) are allowed. Always overrides the mode-based default when set. | `true` in local mode, `false` in SaaS mode |
| `NEON_DATABASE_URL` | Postgres connection string for the Neon-backed SaaS control plane (preferred name). | unset |
| `NEON_URL` | Another accepted alias, used as the last fallback for the Neon connection string. | unset |
| `SAAS_DATA_ROOT` | Durable data-root directory that per-tenant state is namespaced under in SaaS mode. | unset (no-op unless `SAAS_MODE` is on) |
| `SAAS_ENV_FILE` | Explicit path to the SaaS secrets env file to load; also counts as opting in to loading `.env.saas.local`/`.env.saas`. | unset (looks for `.env.saas.local` then `.env.saas` in the cwd, but only once opted in) |
| `SAAS_MODE` | Master switch for the Clerk + Neon multi-tenant SaaS layer. Must be set in the real process environment (a value inside the `.env.saas.local` file is ignored) — presence of the file alone can never turn SaaS mode on. | off (`false`) |
| `SAAS_OWNER_EMAIL` | Email address that owns all pre-existing local data on first SaaS migration/seed. | unset |
| `SSH_CIPHER_KEY` | Symmetric key used to encrypt stored SSH device credentials. | a built-in, publicly known value. **Set your own.** |
| `VAULT_DISCORD_GUILD_ID` | Discord guild id used by the Vault rule engine, checked as a fallback to `DISCORD_GUILD_ID`. | unset |
| `VAULT_STORE_TYPE` | Selects the Vault data store backend, e.g. `sqlite` or `supabase`. | `sqlite` |
| `VAULT_SUPABASE_KEY` | Supabase anon key for the Vault Supabase store; falls back to `SUPABASE_ANON_KEY`. | unset |
| `VAULT_SUPABASE_URL` | Supabase project URL for the Vault Supabase store; falls back to `SUPABASE_URL`. | unset |

### Reports and PDF rendering

| Variable | What it does | Default |
| --- | --- | --- |
| `PDF_RENDER_URL` | Legacy alias for `REPORTS_PDF_RENDER_URL`, read if the new name isn't set. | unset |
| `REPORTS_CHROME_PATH` | Explicit path to a local Chrome/Chromium binary for rendering reports, tried before other auto-detected candidates. | unset (auto-detects a system Chrome, or falls back to the remote render service) |
| `REPORTS_PDF_RENDER_URL` | URL of the remote headless-Chrome PDF render service used to turn reports into PDFs. | `http://localhost:8091` |
| `REPORTS_POLL_INTERVAL_MS` | Poll interval for the background reports worker that picks up pending render jobs. | `4000` |

### External tool paths

| Variable | What it does | Default |
| --- | --- | --- |
| `CHROME_PATH` | Path to a Chrome/Chromium binary, used as a fallback by the Playwright lead-scraper workflow. | unset |
| `FFMPEG_BIN` | Path/name of the `ffmpeg` binary used for audio/video composition and QC. | `ffmpeg` (resolved from `PATH`) |
| `FFPROBE_BIN` | Path/name of the `ffprobe` binary used for media QC/inspection. | `ffprobe` (resolved from `PATH`) |
| `HYPERFRAMES_DIR` | Local checkout directory of the Hyperframes project, used to locate the studio's projects data folder. | a developer-specific path. Set this if you use the feature. |
| `HYPERFRAMES_STUDIO_URL` | Base URL of the local Hyperframes video-studio server used by the notes-edit-to-video composition. | `http://localhost:5190` |
| `KLEIN_SCRIPT` | Path to the external FLUX.2 "Klein" image-generation helper script. | unset (falls back to a built-in candidate path) |
| `LOCAL_IMAGE_API_URL` | URL of a local image-generation API (e.g. ComfyUI), read as a fallback if `COMFY_URL` isn't set. | unset |
| `NOTES_EDIT_WORKSPACE` | Working directory for the notes-edit-to-video composition pipeline's scratch files. | a developer-specific path. Set this if you use the feature. |
| `PLAYWRIGHT_CHROMIUM_PATH` | Preferred override for the Chromium binary used by Playwright-based workflows (checked before `CHROME_PATH`). | unset |
| `PRODUCER_HEADLESS_SHELL_PATH` | Path to a `chrome-headless-shell` binary used to render composition thumbnails. | unset (falls back to a Puppeteer-installed chrome-headless-shell) |
| `SPEACHES_URL` | Base URL of the local Speaches STT/TTS Docker service used by voice transcription and the notes-edit voice pipeline. | `http://localhost:8002` |

### Daemon and service installation

| Variable | What it does | Default |
| --- | --- | --- |
| `INFINIBOT_SERVICE_VERSION` | Version string recorded/compared for the installed daemon service definition. | current package `VERSION` |
| `INFINIBOT_SYSTEMD_UNIT` | Overrides the systemd unit name used when installing/managing the gateway (or node-host) as a systemd service. | `infinibot-gateway` (or `infinibot-node`), suffixed by profile if set |
| `INFINIBOT_TASK_SCRIPT_NAME` | Overrides the filename of the Windows task launcher script. | `gateway.cmd` (node service uses `node.cmd`) |
| `INFINIBOT_TASK_SCRIPT` | Overrides the full path to the Windows task launcher script. | `<state dir>/<task script name>` |
| `INFINIBOT_UPDATE_IN_PROGRESS` | Marks that an in-place update is currently running, so daemon/doctor checks don't treat a temporarily-stopped service as broken. | not in progress |
| `INFINIBOT_WINDOWS_TASK_NAME` | Overrides the Windows Scheduled Task name used for the gateway/node service. | `InfiniBot Gateway` (or `InfiniBot Node`), suffixed by profile if set |

### Diagnostics, development and testing

| Variable | What it does | Default |
| --- | --- | --- |
| `INFINIBOT_ANTHROPIC_PAYLOAD_LOG_FILE` | Overrides the file path for the Anthropic payload log. | `<state-dir>/logs/anthropic-payload.jsonl` |
| `INFINIBOT_ANTHROPIC_PAYLOAD_LOG` | Set to a truthy value to log full Anthropic API request/usage payloads for agent calls. | unset (disabled) |
| `INFINIBOT_CACHE_TRACE_FILE` | Overrides the file path the cache trace is written to (JSON Lines). | `<state-dir>/logs/cache-trace.jsonl` |
| `INFINIBOT_CACHE_TRACE_MESSAGES` | Set to include the message list in each cache-trace record. | included by default when tracing is on |
| `INFINIBOT_CACHE_TRACE_PROMPT` | Set to include the full prompt in each cache-trace record. | config-controlled / off unless set |
| `INFINIBOT_CACHE_TRACE_SYSTEM` | Set to include the system prompt in each cache-trace record. | config-controlled / off unless set |
| `INFINIBOT_CACHE_TRACE` | Set to enable prompt-cache tracing for agent requests. | unset (disabled), unless enabled via config |
| `INFINIBOT_CONFIG_CACHE_MS` | TTL, in milliseconds, for the in-memory config file cache; `0` disables caching. | `200` |
| `INFINIBOT_DEBUG_HEALTH` | Set to a truthy value to print extra diagnostics from the `health` command. | unset (disabled) |
| `INFINIBOT_DEBUG_MEMORY_EMBEDDINGS` | Set to a truthy value to log debug info while generating Gemini memory embeddings. | unset (disabled) |
| `INFINIBOT_DEBUG_TELEGRAM_ACCOUNTS` | Set to a truthy value to log extra detail while resolving Telegram account bindings. | unset (disabled) |
| `INFINIBOT_PLUGIN_MANIFEST_CACHE_MS` | TTL (ms) for the cached plugin manifest registry; empty string or `0` disables caching. | `200` |
| `INFINIBOT_RAW_STREAM_PATH` | Overrides the file path for the raw event stream log (also settable via `--raw-stream-path`). | `<state dir>/logs/raw-stream.jsonl` |
| `INFINIBOT_RAW_STREAM` | Enables writing the raw agent event stream to a JSONL debug log (also settable via the `--raw-stream` CLI flag). | disabled |
| `INFINIBOT_REVIEW_RETENTION_DAYS` | Number of days agent code-reviews are retained before pruning. | `30` |
| `INFINIBOT_SESSION_CACHE_TTL_MS` | TTL (ms) for the in-memory session store cache; `0` disables caching. | `45000` |
| `INFINIBOT_SESSION_MANAGER_CACHE_TTL_MS` | TTL (ms) for the embedded pi-runner's session-manager file cache; `0` disables caching. | `45000` |
| `INFINIBOT_SHELL_ENV_TIMEOUT_MS` | Timeout (ms) for spawning a login shell to sniff the user's real `PATH`. | `15000` |
| `INFINIBOT_SHOW_SECRETS` | Set to `"0"` to force secret values to be redacted in `status`/doctor output. | secrets shown |
| `INFINIBOT_SMOKE_QR` | Set to `"1"` to trigger the macOS relay's QR-pairing smoke test (equivalent to `--smoke-qr`). | not set |
| `INFINIBOT_SMOKE` | Set to `qr` to trigger the macOS relay's QR-pairing smoke test when no CLI args are present. | not set |
| `INFINIBOT_SUBAGENT_HISTORY_DAYS` | Number of days subagent run-history entries are retained before pruning. | `30` |
| `INFINIBOT_TAGLINE_INDEX` | Forces a specific CLI tagline by index instead of picking one automatically. | random/rotating tagline |
| `INFINIBOT_TEST_FAST` | Set to `"1"` to make auto-reply logic take a fast/short-circuit path intended for tests. | normal (slow) path |
| `INFINIBOT_TEST_HANDSHAKE_TIMEOUT_MS` | Overrides the WS handshake timeout constant; only honored when `VITEST` is also set. | built-in production constant |
| `INFINIBOT_VERIFIER_CMD` | Overrides the CLI command invoked to run the coder sub-agent's automated verifier. | `claude` |

### Miscellaneous

| Variable | What it does | Default |
| --- | --- | --- |
| `INFINIBOT_VERSION` | Overrides the version string the gateway reports in presence and connection info. | package version (`npm_package_version`), else `dev`/`unknown` |
| `EXPO_PROJECT_DIR` | Overrides the Expo mobile project directory used by the mobile dev-server runner; `INFINIBOT_MOBILE_DIR` is an accepted alias. | unset (falls back to `<home>/infinibot`) |
| `GATEWAY_PORT` | Gateway WebSocket port used specifically when the mobile connect-flow infers a gateway URL to hand to the app; most of the rest of the codebase uses the differently-named `INFINIBOT_GATEWAY_PORT` for this. | `18789` |
| `GIT_COMMIT` | Commit hash reported in onboarding/health diagnostics and gateway status messages. | falls back to `GIT_SHA`, then reads it from git directly |
| `GIT_SHA` | Alias for `GIT_COMMIT`, checked if that isn't set. | unset |
| `RELEASE_PUBLISHER_DRY_RUN` | Set to `1`/`true` to run the release-publisher daemon in dry-run mode (does everything except commit/push/comment). | off (`false`) |
| GEMINI_API_KEY (embeddings) | Also accepted (interchangeably with GOOGLE_API_KEY) as the embeddings provider key | unset |

### Set internally or test only

| Variable | What it does | Default |
| --- | --- | --- |
| `INFINIBOT_AGENT_ID` | Set by the gateway's PTY manager into a spawned terminal's environment to identify which agent owns that terminal. Not meant to be set by users. | unset |
| `INFINIBOT_LAUNCHD_LABEL` | Set internally when spawning the macOS launchd-managed daemon/service child process, carrying the resolved launch-agent label. | computed internally |
| `INFINIBOT_LOG_PREFIX` | Set internally on daemon/service child processes (`"gateway"` or `"node"`) to tag their log output. | `"gateway"` |
| `INFINIBOT_NO_RESPAWN` | Set to skip the internal self-respawn that suppresses Node's `ExperimentalWarning` output. | respawn happens once if needed |
| `INFINIBOT_NODE_OPTIONS_READY` | Set to `"1"` by `entry.ts` on its own self-respawn child process. | n/a (internal) |
| `INFINIBOT_NODE_OPTIONS_READY` | Set to skip the internal self-respawn logic entirely (treated as already applied). | not set |
| `INFINIBOT_PATH_BOOTSTRAPPED` | Set to `"1"` by `infra/path-env.ts` once PATH bootstrap has run in this process. | n/a (internal) |
| `INFINIBOT_PATH_BOOTSTRAPPED` | Set to skip re-running PATH bootstrap logic (prevents doing it twice in a child process). | not set |
| `INFINIBOT_SELF_IMPROVE_AGENT_ID` | Which agent id's skill/self-improve lookups are used at gateway startup. | `"default"` |
| `INFINIBOT_SELF_IMPROVE_INTERVAL_MIN` | Minutes between self-improve threshold checks; `0`/unset disables the feature. | `0` (disabled) |
| `INFINIBOT_SERVICE_VERSION` | Injected into the environment of installed daemon/service processes by `service-env.ts`. | n/a (internal) |
| `INFINIBOT_SKIP_BROWSER_CONTROL_SERVER` | Set by the gateway test harness (`test-helpers.server.ts`) to suppress the browser control server during tests. | unset in normal runs |
| `INFINIBOT_SKIP_CANVAS_HOST` | Set by the gateway test harness to suppress the canvas host server during tests. | unset in normal runs |
| `INFINIBOT_SKIP_CRON` | Also force-set to `"1"` by the test mocks module so scheduled jobs never run under test. | unset in normal runs |
| `INFINIBOT_SKIP_GMAIL_WATCHER` | Set by the gateway test harness to suppress the Gmail watcher during tests. | unset in normal runs |
| `INFINIBOT_UPDATE_IN_PROGRESS` | Set to `"1"` by the update CLI/runner around an in-place update, then cleared. | n/a (internal) |
| `INFINIBOT_USER_ID` | Overrides which user profile is active at boot (for headless/test use), bypassing the persisted "current user" registry. | current user from the profile registry |
| `PI_BASH_JOB_TTL_MS` | Overrides the TTL for background bash job sessions spawned by agents (clamped between 1 min and 3 hours). | `1800000` (30 min) |
| `PI_CODING_AGENT_DIR` | Legacy alias for `INFINIBOT_AGENT_DIR` (agent workspace root); still read as a fallback. | unset |
| `VITEST_POOL_ID` | Vitest pool id, used as a fallback for the same port-derivation logic. | unset outside test runs |
| `VITEST_WORKER_ID` | Vitest worker id, read to derive a unique test port per parallel worker. | unset outside test runs |

| Variable | What it does |
| --- | --- |
| ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY_OLD | Deleted (not read) from spawned agent environments to force a clean re-auth in the Claude Code launcher/verifier/skill-system |

### Standard host variables

- **Node/package-manager bin discovery** (used to build an enriched `PATH` when locating CLIs like the coder backend, or spawning daemons): `NVM_DIR`, `PNPM_HOME`, `BUN_INSTALL`, `VOLTA_HOME`, `FNM_DIR`, `ASDF_DATA_DIR`, `MISE_DATA_DIR`, `NPM_CONFIG_PREFIX`, `HOMEBREW_PREFIX`, `HOMEBREW_BREW_FILE`, `SCOOP`, `XDG_BIN_HOME`.
- **Home/profile & Windows path discovery**: `APPDATA`, `LOCALAPPDATA`, `USERPROFILE`, `USERNAME`, `USERDOMAIN`, `LOGNAME`, `WINDIR`, `COMSPEC`, `PATHEXT` — used to find the user's home directory, shell, and Windows executable resolution rules across platforms.
- **XDG base directories**: `XDG_CONFIG_HOME`, `XDG_RUNTIME_DIR`, `XDG_SESSION_TYPE` — used for config-file locations and Linux desktop/session detection.
- **WSL detection**: `WSL_DISTRO_NAME`, `WSL_INTEROP`, `WSLENV` — presence of any of these marks the process as running under Windows Subsystem for Linux.
- **SSH/remote session detection**: `SSH_CLIENT`, `SSH_CONNECTION`, `SSH_TTY` — used to decide whether onboarding/OAuth flows should assume a headless/remote session (e.g. skip opening a local browser).
- **Desktop/display session detection**: `DISPLAY`, `WAYLAND_DISPLAY`, `HYPRLAND_INSTANCE_SIGNATURE` — used to detect whether a graphical session (X11/Wayland/Hyprland) is available before enabling desktop-control features.
- **Terminal color/capability detection**: `TERM_PROGRAM`, `COLORTERM`, `NO_COLOR`, `FORCE_COLOR` — used to decide whether to emit ANSI color in terminal output.
- **Editor selection**: `EDITOR`, `VISUAL` — used as the external editor to launch when opening a file from the UI.
- **CI/remote-dev environment detection**: `CODESPACES`, `REMOTE_CONTAINERS`, `GITHUB_ACTIONS` — used to adjust OAuth flows and Windows-specific logging quirks for cloud/CI environments.
- **Node runtime tuning**: `NODE_OPTIONS`, `NODE_NO_WARNINGS` — read/appended to control Node's experimental-warning flags.
- **Debug/diagnostic toggles**: `DEBUG`, `DEBUG_TERMINAL`, `CHOKIDAR_USEPOLLING` — generic conventions gating a handful of verbose log lines or forcing file-watcher polling mode.
- **Git hook bypass**: `HUSKY` — set (not read) internally to `"0"` before spawning child `git`/file-diff processes so Husky hooks don't run during automated operations.

### Legacy names

| Legacy variable | Use instead | Notes |
| --- | --- | --- |
| `MOLTBOT_BROWSER_SKILLS_DIR` | No `INFINIBOT_*` equivalent | Overrides the root directory for browser-automation skill scripts. Default: `<cwd>/skills/browser`. |
| `MOLTBOT_DEBUG_TEMPLATES` | No `INFINIBOT_*` equivalent | Set to enable verbose logging when the agent-workspace template loader falls back to its inline template (diagnostic only). |
| `MOLTBOT_DEFAULT_SESSION_KEY` | No direct `INFINIBOT_*` equivalent | Session key injected into spawned coder sub-agents/MCP stdio processes for activity attribution; `cli/mcp-stdio.ts` also accepts `INFINIBOT_SESSION_KEY` as a secondary fallback for the same purpose. |
| `MOLTBOT_GATEWAY_PASSWORD` | Related to `INFINIBOT_GATEWAY_PASSWORD` (different context) | Same pattern as `MOLTBOT_GATEWAY_TOKEN`, for password-mode gateways. |
| `MOLTBOT_GATEWAY_TOKEN` | Related to `INFINIBOT_GATEWAY_TOKEN` (different context) | Read by the MCP stdio entrypoint for bearer-token auth to the gateway; `INFINIBOT_GATEWAY_TOKEN` is a separate variable used by the gateway/CLI itself for its own auth config, not a direct alias. |
| `MOLTBOT_GATEWAY_URL` | No direct `INFINIBOT_*` equivalent | Still the actual variable read by the MCP stdio entrypoint (`cli/mcp-stdio.ts`) to find the running gateway's WS URL; written into the Claude Code MCP registration by `claude-code-register.ts`. Named after the old product name but not a deprecated alias — it's the live mechanism. Default when unset: `ws://127.0.0.1:18789`. |
| `MOLTBOT_MCP_VERBOSE` | No `INFINIBOT_*` equivalent | Set to `"1"` to enable diagnostic logging to stderr in the MCP stdio server. |
| `MOLTBOT_SESSION_LABEL` | No `INFINIBOT_*` equivalent | Overrides the human-readable activity-feed label for an MCP stdio session. |
| `MOLTBOT_STATE_DIR` | `INFINIBOT_STATE_DIR` | Read as a fallback after `INFINIBOT_STATE_DIR` in several content/database stores (Instagram cache, pages store, viral-examples store, databases store) for back-compat with pre-rename installs; `INFINIBOT_STATE_DIR` always wins if both are set. |

## Related

- [Gateway configuration](/gateway/configuration)
- [FAQ: env vars and .env loading](/help/faq#env-vars-and-env-loading)
- [Models overview](/concepts/models)
