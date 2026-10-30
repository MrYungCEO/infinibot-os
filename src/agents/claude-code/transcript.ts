/**
 * Compatibility shim. The coder transcript writer is backend-agnostic and now
 * lives at src/agents/coder-runtime/transcript.ts (shared by the Claude Code,
 * OpenCode, and Codex backends). This file re-exports it so existing imports
 * (`../claude-code/transcript.js`) keep working.
 *
 * COORDINATION: opencode-parity
 */
export * from "../coder-runtime/transcript.js";
