/**
 * UI ↔ CoderBackend vocabulary adapter.
 *
 * Two parallel vocabularies live in the codebase:
 *
 *   - **CoderBackend id** (`src/agents/coder-backend/types.ts`):
 *     `"claude-code" | "opencode" | "codex" | "gemini" | "grok"` — used by the spawn registry
 *     to instantiate the right backend.
 *
 *   - **UI / PTY `cli`** (terminals, `app-gateway.ts`):
 *     `"claude" | "opencode" | "codex" | "gemini" | "grok" | "shell"` — picks what
 *     binary the PTY launches, also used in stored settings + workflows.
 *
 * Voice surfaces have to talk to both. The selector emits CoderBackend ids
 * (one canonical surface vocabulary), and call sites that go through the
 * PTY use `mapBackendToUiCli` on the way out.
 *
 * `"grok"` is xAI's Grok Build CLI (`grok`).
 * `"shell"` is not an agent and never appears in the voice selector.
 */

export type CoderBackendId = "claude-code" | "opencode" | "codex" | "gemini" | "grok";

export type UiCli =
  | "claude"
  | "opencode"
  | "codex"
  | "gemini"
  | "grok"
  | "shell";

const UI_TO_BACKEND: Record<UiCli, CoderBackendId | null> = {
  claude: "claude-code",
  opencode: "opencode",
  codex: "codex",
  gemini: "gemini",
  grok: "grok",
  shell: null,
};

const BACKEND_TO_UI: Record<CoderBackendId, UiCli> = {
  "claude-code": "claude",
  opencode: "opencode",
  codex: "codex",
  gemini: "gemini",
  grok: "grok",
};

export const BACKEND_DISPLAY: Record<CoderBackendId, string> = {
  "claude-code": "Claude Code",
  opencode: "OpenCode",
  codex: "Codex CLI",
  gemini: "Gemini CLI",
  grok: "Grok Build",
};

export const ALL_BACKEND_IDS: CoderBackendId[] = [
  "claude-code",
  "opencode",
  "codex",
  "gemini",
  "grok",
];

export function mapUiCliToBackend(cli: UiCli | string | null | undefined): CoderBackendId | null {
  if (!cli) return null;
  return UI_TO_BACKEND[cli as UiCli] ?? null;
}

export function mapBackendToUiCli(id: CoderBackendId): UiCli {
  return BACKEND_TO_UI[id];
}

export function isCoderBackendId(x: unknown): x is CoderBackendId {
  return (
    x === "claude-code" || x === "opencode" || x === "codex" || x === "gemini" || x === "grok"
  );
}
